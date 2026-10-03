// Acceso remoto F0 (docs/_experiments/remote-control/CONTRACT.md): puente de red de SOLO LECTURA.
//
// HTTPS con certificado propio (remote-tls.ts) en la IP de red local de la PC -- nunca en 0.0.0.0. La API es
// NUEVA y chica, no un reenvio del IPC: de los 62 canales IPC solo 2 funciones de lectura se ofrecen, filtradas
// (chats:load -> GET /api/v0/chats, projects:list -> GET /api/v0/projects), mas el stream de eventos (SSE) y el
// emparejamiento. Cualquier otra ruta -- incluidas settings:get (API keys) y agent:attach (vacia el eventLog de la
// PC) -- responde 404: no existe ningun camino desde la red hacia el ipcMain.
import { randomBytes, randomUUID } from 'node:crypto'
import https from 'node:https'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { isIP, type AddressInfo } from 'node:net'
import os from 'node:os'
import { renderSVG } from 'uqr'
import { getChatTitle, loadChatSnapshot } from './chat-store'
import { scanProjectRoot } from './project-registry'
import {
  audit, authenticateToken, cancelPairingWindow, clearPairingState, confirmPairing, listDevices, listPendingPairings,
  pairingWindowState, pollPairing, readRemoteAccessConfig, revokeAllDevices, revokeDevice, startPairingWindow, submitPairingCode,
  type PublicRemoteDevice
} from './remote-devices'
import {
  activitySnapshot, addObserver, closeObserversForDevice, connectedDeviceIds, currentRemoteSeq, observerCount, projectForRemote,
  remoteEventsSince, removeObserver, startRemoteRecording, stopRemoteRecording, type RemoteEvent
} from './remote-observers'
import { issueSelfSignedCertificate, loadOrCreateRemoteIdentity } from './remote-tls'
import { sessionRegistry, settings } from './runtime-state'
import type { ChatDatabaseSnapshot, RemoteAccessStatus } from '../shared/types'

export const MAX_OBSERVERS_TOTAL = 4
export const MAX_OBSERVERS_PER_DEVICE = 2
const MAX_BODY_BYTES = 4096
const HEARTBEAT_MS = 25_000

interface Running { server: https.Server; bindAddress: string; port: number; bootId: string; pin: string; identityPersistent: boolean }
let running: Running | null = null
let statusListener: ((status: RemoteAccessStatus) => void) | null = null
let lastError: string | undefined

export function setRemoteAccessStatusListener(listener: ((status: RemoteAccessStatus) => void) | null): void {
  statusListener = listener
}
function emitStatus(): void {
  try { statusListener?.(getRemoteAccessStatus()) } catch { /* la UI nunca rompe el puente */ }
}

// ---- direccion de escucha: IP privada de red local, nunca 0.0.0.0 ----
const VIRTUAL_ADAPTER = /vEthernet|VirtualBox|VMware|Hyper-V|WSL|Loopback|Tailscale|ZeroTier|docker|vboxnet|Bluetooth/i
export function isPrivateIPv4(ip: string): boolean {
  if (isIP(ip) !== 4) return false
  const [a, b] = ip.split('.').map(Number)
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
}
export function pickLanAddress(): string | null {
  const candidates: string[] = []
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    if (VIRTUAL_ADAPTER.test(name)) continue
    for (const a of addrs ?? []) if (a.family === 'IPv4' && !a.internal && isPrivateIPv4(a.address)) candidates.push(a.address)
  }
  const rank = (ip: string): number => ip.startsWith('192.168.') ? 0 : ip.startsWith('10.') ? 1 : 2
  return candidates.sort((x, y) => rank(x) - rank(y))[0] ?? null
}
function assertBindable(address: string): void {
  if (address === '127.0.0.1' || isPrivateIPv4(address)) return
  throw new Error(`Direccion de escucha no permitida: ${address} (solo IPv4 privada de red local, o 127.0.0.1 para pruebas).`)
}

// ---- estado ----
export function getRemoteAccessStatus(): RemoteAccessStatus {
  const connected = connectedDeviceIds()
  const devices = listDevices().map((d: PublicRemoteDevice) => ({ deviceId: d.deviceId, name: d.name, createdAt: d.createdAt, lastSeenAt: d.lastSeenAt, connected: connected.has(d.deviceId) }))
  return {
    acknowledged: readRemoteAccessConfig().acknowledged,
    running: running !== null,
    ...(running ? { bindAddress: running.bindAddress, port: running.port, pin: running.pin, identityPersistent: running.identityPersistent } : {}),
    devices,
    connectedCount: devices.filter(d => d.connected).length,
    pairing: running ? pairingWindowState() : { active: false },
    pendingPairings: running ? listPendingPairings() : [],
    ...(lastError ? { error: lastError } : {})
  }
}

// ---- ciclo de vida ----
export class RemoteAccessNotAcknowledgedError extends Error {}

/** Doble guard: aunque la UI solo muestre el interruptor despues del consentimiento, el servidor se niega a
 *  arrancar si remote-access.json no tiene acknowledged:true. Sin consentimiento, el puerto ni se abre. */
export async function startRemoteAccess(options: { bindAddress?: string; port?: number } = {}): Promise<RemoteAccessStatus> {
  const config = readRemoteAccessConfig()
  if (!config.acknowledged) {
    audit('start-refused-no-consent')
    throw new RemoteAccessNotAcknowledgedError('El acceso remoto no esta confirmado: primero hay que aceptar la advertencia ("Entiendo los riesgos").')
  }
  if (running) return getRemoteAccessStatus()
  const bindAddress = options.bindAddress ?? config.bindAddress ?? pickLanAddress()
  if (!bindAddress) throw new Error('No se encontro una IP de red local (Wi-Fi o Ethernet) en esta PC.')
  assertBindable(bindAddress)
  const identity = loadOrCreateRemoteIdentity()
  const cert = issueSelfSignedCertificate(identity.privateKey, [bindAddress])
  const bootId = randomBytes(6).toString('hex')
  const server = https.createServer({ key: identity.keyPem, cert, minVersion: 'TLSv1.2' })
  server.headersTimeout = 10_000
  server.requestTimeout = 15_000
  server.maxConnections = 32
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(options.port ?? config.port, bindAddress, () => { server.off('error', reject); resolve() })
  })
  // Puerto REAL (options.port 0 = el que asigne el sistema, usado por los tests): entra en el Host esperado y en el QR.
  const port = (server.address() as AddressInfo).port
  const state: Running = { server, bindAddress, port, bootId, pin: identity.pin, identityPersistent: identity.persistent }
  server.on('request', (req, res) => {
    handleRequest(state, req, res).catch(() => { if (!res.headersSent) sendJson(res, 500, { error: 'internal' }); else res.end() })
  })
  running = state
  lastError = undefined
  const seed = [...sessionRegistry.entries()]
    .filter(([, s]) => s.turnInFlight && s.turnStartedAt !== null)
    .map(([chatId, s]) => ({ chatId, chatTitle: getChatTitle(chatId) ?? chatId, startedAt: s.turnStartedAt as number }))
  startRemoteRecording(seed)
  audit('server-started', { bindAddress, port })
  emitStatus()
  return getRemoteAccessStatus()
}

export async function stopRemoteAccess(reason = 'user'): Promise<void> {
  const state = running
  if (!state) return
  running = null
  stopRemoteRecording() // cierra todos los streams
  clearPairingState()
  await new Promise<void>(resolve => {
    state.server.close(() => resolve())
    state.server.closeAllConnections()
  })
  audit('server-stopped', { reason })
  emitStatus()
}

// ---- emparejamiento (lado PC) ----
export function startRemotePairing(): { url: string; svg: string; expiresAt: number } {
  if (!running) throw new Error('El acceso remoto no esta encendido.')
  const { code, expiresAt } = startPairingWindow()
  // El codigo y el pin viajan en el FRAGMENTO (#): nunca llegan a ningun servidor ni a un registro de pedidos.
  const url = `https://${running.bindAddress}:${running.port}/pair#c=${code}&k=${running.pin}`
  emitStatus()
  return { url, svg: renderSVG(url), expiresAt }
}
export function cancelRemotePairing(): void {
  cancelPairingWindow()
  emitStatus()
}
export function confirmRemotePairing(pairingId: string, accept: boolean): { ok: boolean } {
  const result = confirmPairing(pairingId, accept)
  emitStatus()
  return { ok: result.ok }
}
export function revokeRemoteDevice(deviceId: string): boolean {
  const removed = revokeDevice(deviceId)
  closeObserversForDevice(deviceId) // corta sus streams en este mismo ciclo
  emitStatus()
  return removed
}
export function revokeAllRemoteDevices(): number {
  const n = revokeAllDevices()
  for (const deviceId of connectedDeviceIds()) closeObserversForDevice(deviceId)
  emitStatus()
  return n
}

// ---- HTTP ----
function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' })
  res.end(JSON.stringify(body))
}
function readBody(req: IncomingMessage): Promise<string | null> {
  return new Promise(resolve => {
    let size = 0
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) { resolve(null); req.destroy(); return }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', () => resolve(null))
  })
}
function bearer(req: IncomingMessage, scheme: 'Bearer' | 'Pairing'): string | undefined {
  const header = req.headers.authorization
  if (typeof header !== 'string' || !header.startsWith(`${scheme} `)) return undefined
  return header.slice(scheme.length + 1).trim()
}

let authFailuresThisMinute = 0
let authFailureWindowStart = Date.now()
function auditAuthFailure(remoteAddress: string | undefined, route: string): void {
  const now = Date.now()
  if (now - authFailureWindowStart > 60_000) { authFailureWindowStart = now; authFailuresThisMinute = 0 }
  authFailuresThisMinute += 1
  if (authFailuresThisMinute <= 20) audit('auth-failed', { remoteAddress, route })
}

/** Rutas: esta tabla ES la lista blanca. Cualquier otra combinacion de metodo y ruta devuelve 404. */
export const REMOTE_ROUTES = ['POST /api/v0/pair', 'GET /api/v0/pair/status', 'GET /api/v0/chats', 'GET /api/v0/projects', 'GET /api/v0/events'] as const

async function handleRequest(state: Running, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const expectedHost = `${state.bindAddress}:${state.port}`
  // Host exacto: corta DNS rebinding y pedidos dirigidos a otro nombre.
  if (req.headers.host !== expectedHost) return sendJson(res, 421, { error: 'misdirected' })
  // F0 no admite navegadores: el cliente es la app nativa (sin Origin). Una pagina web ajena siempre manda Origin.
  if (req.headers.origin !== undefined) return sendJson(res, 403, { error: 'forbidden' })
  const url = new URL(req.url ?? '/', `https://${expectedHost}`)
  const route = `${req.method ?? ''} ${url.pathname}`
  const remoteAddress = req.socket.remoteAddress
  switch (route) {
    case 'POST /api/v0/pair': {
      const raw = await readBody(req)
      if (raw === null) return sendJson(res, 413, { error: 'too_large' })
      let body: { code?: unknown; deviceName?: unknown } = {}
      try { body = JSON.parse(raw) as typeof body } catch { return sendJson(res, 400, { error: 'bad_json' }) }
      const result = submitPairingCode(body.code, body.deviceName, remoteAddress ?? '')
      emitStatus()
      if (!result.ok) return sendJson(res, 403, { error: result.reason })
      return sendJson(res, 200, { pairingSecret: result.pairingSecret, sas: result.sas, expiresAt: result.expiresAt })
    }
    case 'GET /api/v0/pair/status': {
      const poll = pollPairing(bearer(req, 'Pairing'))
      if (poll.status === 'unknown') return sendJson(res, 401, { error: 'unauthorized' })
      if (poll.status === 'approved') emitStatus()
      return sendJson(res, 200, poll)
    }
    case 'GET /api/v0/chats':
    case 'GET /api/v0/projects':
    case 'GET /api/v0/events': {
      const device = authenticateToken(bearer(req, 'Bearer'))
      if (!device) { auditAuthFailure(remoteAddress, route); return sendJson(res, 401, { error: 'unauthorized' }) }
      if (route === 'GET /api/v0/chats') return sendJson(res, 200, projectChats(loadChatSnapshot()))
      if (route === 'GET /api/v0/projects') return sendJson(res, 200, { projects: projectNames() })
      return openEventStream(state, req, res, device, url)
    }
    default:
      return sendJson(res, 404, { error: 'not_found' })
  }
}

// ---- lectura 1/2: chats:load, filtrado (sin rutas locales ni contenido de adjuntos) ----
export function projectChats(snapshot: ChatDatabaseSnapshot): unknown {
  return {
    sessions: snapshot.sessions.map(s => ({
      id: s.id, title: s.title, workspaceName: s.workspaceName, createdAt: s.createdAt, updatedAt: s.updatedAt,
      providerId: s.providerId, modelId: s.modelId, runtime: s.runtime, parentChatId: s.parentChatId
    })),
    messages: Object.fromEntries(Object.entries(snapshot.messages).map(([chatId, list]) => [chatId, list.map(m => ({
      id: m.id, chatId: m.chatId, role: m.role, text: m.text, createdAt: m.createdAt, providerId: m.providerId, modelId: m.modelId,
      runtime: m.runtime, toolSteps: m.toolSteps,
      crossWindow: m.crossWindow ? { direction: m.crossWindow.direction, windowLabel: m.crossWindow.windowLabel } : undefined,
      attachments: m.attachments?.map(a => ({ id: a.id, name: a.name, mimeType: a.mimeType, size: a.size, kind: a.kind, origin: a.origin }))
    }))]))
  }
}
// ---- lectura 2/2: projects:list, solo nombres ----
function projectNames(): string[] {
  const names = settings.projectRoots.flatMap(root => { try { return scanProjectRoot(root).map(p => p.name) } catch { return [] } })
  return [...new Set(names)]
}

// ---- eventos (SSE): solo del servidor al telefono ----
function formatEvent(bootId: string, event: RemoteEvent): string {
  return `id: ${bootId}-${event.seq}\nevent: ${event.channel}\ndata: ${JSON.stringify({ chatId: event.chatId, payload: event.payload, at: event.at })}\n\n`
}
const CHAT_ID = /^[A-Za-z0-9._:-]{1,80}$/

function openEventStream(state: Running, req: IncomingMessage, res: ServerResponse, device: PublicRemoteDevice, url: URL): void {
  if (observerCount() >= MAX_OBSERVERS_TOTAL || observerCount(device.deviceId) >= MAX_OBSERVERS_PER_DEVICE) return sendJson(res, 429, { error: 'too_many_streams' })
  const chatIds = new Set(url.searchParams.getAll('chat').filter(id => CHAT_ID.test(id)).slice(0, 50))
  res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Content-Type-Options': 'nosniff' })
  res.write('retry: 3000\n\n')

  // Reanudar: Last-Event-ID = "<bootId>-<seq>". Otro bootId (Amatista se reinicio) o un hueco mas viejo que el
  // anillo => "resync": el telefono vuelve a pedir GET /api/v0/chats y abre el stream sin id.
  const lastEventId = (req.headers['last-event-id'] as string | undefined) ?? url.searchParams.get('since') ?? undefined
  let resumed = false
  if (lastEventId) {
    const [bootId, seqText] = lastEventId.split('-')
    const since = bootId === state.bootId ? remoteEventsSince(Number(seqText), chatIds) : { gap: true as const }
    if ('gap' in since) res.write(`event: resync\ndata: {}\n\n`)
    else { for (const e of since.events) res.write(formatEvent(state.bootId, e)); resumed = true }
  }
  if (!resumed) {
    res.write(`event: hello\ndata: ${JSON.stringify({ bootId: state.bootId, seq: currentRemoteSeq(), activity: activitySnapshot() })}\n\n`)
    // Eventos de un turno que corrio sin panel en la PC y todavia no se guardaron: COPIA del eventLog, sin vaciarlo
    // (lo sigue necesitando el panel de la PC para su propio replay).
    for (const chatId of chatIds) {
      for (const entry of sessionRegistry.get(chatId)?.eventLog ?? []) {
        res.write(`event: backlog\ndata: ${JSON.stringify({ chatId, channel: entry.channel, payload: projectForRemote(entry.channel, entry.payload) })}\n\n`)
      }
    }
  }

  const observerId = randomUUID()
  const heartbeat = setInterval(() => { res.write(': ping\n\n') }, HEARTBEAT_MS)
  addObserver({
    observerId,
    deviceId: device.deviceId,
    chatIds,
    push: event => {
      if (res.writableEnded || res.writableLength > 1_000_000) return false
      res.write(formatEvent(state.bootId, event))
      return true
    },
    close: () => { clearInterval(heartbeat); res.end() }
  })
  audit('stream-opened', { deviceId: device.deviceId, chats: chatIds.size })
  emitStatus()
  req.on('close', () => {
    clearInterval(heartbeat)
    removeObserver(observerId)
    audit('stream-closed', { deviceId: device.deviceId })
    emitStatus()
  })
}

/** Solo para verificacion: el bootId del servidor en marcha (forma parte de los ids de los eventos). */
export const runningBootIdForTests = (): string | null => running?.bootId ?? null
