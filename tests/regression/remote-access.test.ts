// Acceso remoto F0 (docs/_experiments/remote-control/CONTRACT.md): el puente de red de SOLO LECTURA.
// Servidor REAL (remote-server.ts) en 127.0.0.1 con puerto del sistema; el "telefono" es un cliente HTTPS que fija el
// certificado con el hash del QR, igual que la app nativa. Propiedades: doble consentimiento, emparejamiento de un
// solo uso con 6 digitos confirmados en la PC, token guardado solo como hash, lista blanca (2 lecturas filtradas +
// eventos; ningun canal IPC alcanzable), anillo con secuencia para reanudar, revocacion inmediata, auditoria sin secretos.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import https from 'node:https'
import tls from 'node:tls'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { X509Certificate, createHash } from 'node:crypto'
import { ipcMain } from 'electron'
import { registerSettingsIpc } from '../../src/main/ipc-settings'
import { registerAgentIpc } from '../../src/main/ipc-agent'
import { registerChatsIpc } from '../../src/main/ipc-chats'
import { registerProjectsAndWorkspaceIpc } from '../../src/main/ipc-projects-workspace'
import { ensureChatSession, saveChatMessage } from '../../src/main/chat-store'
import { getSession, sendSessionEvent, setSettings, settings } from '../../src/main/runtime-state'
import { getAppDataRoot } from '../../src/main/app-paths'
import { acknowledgeRemoteAccess } from '../../src/main/remote-devices'
import { RING_MAX, fanOutToRemote, remoteEventsSince, currentRemoteSeq } from '../../src/main/remote-observers'
import {
  confirmRemotePairing, getRemoteAccessStatus, revokeRemoteDevice, runningBootIdForTests, startRemoteAccess, startRemotePairing, stopRemoteAccess
} from '../../src/main/remote-server'

const HOST = '127.0.0.1'
let port = 0
let pin = ''
let pinnedPem = ''
let token = ''
let deviceId = ''
let qrCode = ''
const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))
const spkiOf = (raw: Buffer): string => createHash('sha256').update(new X509Certificate(raw).publicKey.export({ type: 'spki', format: 'der' })).digest('base64url')

function request(method: string, p: string, headers: Record<string, string> = {}, body?: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = https.request({ host: HOST, port, method, path: p, ca: pinnedPem, checkServerIdentity: (_h, c) => (spkiOf(c.raw) === pin ? undefined : new Error('pin')), headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers } },
      res => { let b = ''; res.on('data', c => { b += c }); res.on('end', () => resolve({ status: res.statusCode ?? 0, body: b })) })
    req.on('error', reject)
    if (body) req.write(body)
    req.end()
  })
}
function sse(p: string, lastEventId?: string): { events: Array<{ id?: string; event: string; data: string }>; closed: Promise<void>; status: Promise<number>; close: () => void } {
  const events: Array<{ id?: string; event: string; data: string }> = []
  let onClosed!: () => void
  let onStatus!: (s: number) => void
  const closed = new Promise<void>(r => { onClosed = r })
  const status = new Promise<number>(r => { onStatus = r })
  const req = https.request({ host: HOST, port, path: p, ca: pinnedPem, checkServerIdentity: (_h, c) => (spkiOf(c.raw) === pin ? undefined : new Error('pin')), headers: { Authorization: `Bearer ${token}`, ...(lastEventId ? { 'Last-Event-ID': lastEventId } : {}) } }, res => {
    onStatus(res.statusCode ?? 0)
    let buf = ''
    res.on('data', chunk => {
      buf += chunk
      let i
      while ((i = buf.indexOf('\n\n')) !== -1) {
        const block = buf.slice(0, i); buf = buf.slice(i + 2)
        if (block.startsWith(':') || block.startsWith('retry')) continue
        const ev: { id?: string; event: string; data: string } = { event: 'message', data: '' }
        for (const line of block.split('\n')) {
          if (line.startsWith('id: ')) ev.id = line.slice(4)
          else if (line.startsWith('event: ')) ev.event = line.slice(7)
          else if (line.startsWith('data: ')) ev.data += line.slice(6)
        }
        events.push(ev)
      }
    })
    res.on('close', () => onClosed())
  })
  req.on('error', () => onClosed())
  req.end()
  return { events, closed, status, close: () => req.destroy() }
}

const handlerCalls = new Map<string, number>()
before(() => {
  registerSettingsIpc(); registerAgentIpc(); registerChatsIpc(); registerProjectsAndWorkspaceIpc()
  const handlers = (ipcMain as unknown as { __handlers: Map<string, (...a: unknown[]) => unknown> }).__handlers
  for (const [channel, fn] of [...handlers.entries()]) handlers.set(channel, (...a: unknown[]) => { handlerCalls.set(channel, (handlerCalls.get(channel) ?? 0) + 1); return fn(...a) })
})
after(async () => { await stopRemoteAccess('fin de los tests') })

test('doble consentimiento: sin aceptar la advertencia el servidor no arranca ni abre ningun puerto', async () => {
  await assert.rejects(startRemoteAccess({ bindAddress: HOST, port: 0 }), /no esta confirmado/)
  assert.equal(getRemoteAccessStatus().running, false)
  acknowledgeRemoteAccess()
  const status = await startRemoteAccess({ bindAddress: HOST, port: 0 })
  assert.equal(status.running, true)
  port = status.port as number
  pin = status.pin as string
  await assert.rejects(startRemoteAccess({ bindAddress: '0.0.0.0', port: 0 }).then(() => { throw new Error('ya corre') }), /ya corre/)
})

test('nunca escucha en 0.0.0.0 ni en una IP publica', async () => {
  await stopRemoteAccess()
  await assert.rejects(startRemoteAccess({ bindAddress: '0.0.0.0', port: 0 }), /no permitida/)
  await assert.rejects(startRemoteAccess({ bindAddress: '8.8.8.8', port: 0 }), /no permitida/)
  const status = await startRemoteAccess({ bindAddress: HOST, port: 0 })
  port = status.port as number
  pin = status.pin as string
})

test('emparejamiento: QR de un solo uso con pin, 6 digitos iguales en PC y telefono, token solo tras confirmar en la PC, guardado como hash', async () => {
  const qr = startRemotePairing()
  const frag = new URLSearchParams(qr.url.split('#')[1])
  qrCode = frag.get('c') as string
  assert.equal(frag.get('k'), pin, 'el QR lleva el pin del certificado')
  assert.ok(!qr.url.split('#')[0].includes(qrCode), 'el codigo va solo en el fragmento')
  assert.ok(qr.svg.startsWith('<svg'))
  pinnedPem = await new Promise<string>((resolve, reject) => {
    const s = tls.connect({ host: HOST, port, rejectUnauthorized: false }, () => {
      const raw = s.getPeerCertificate(true).raw
      s.end()
      spkiOf(raw) === pin ? resolve(new X509Certificate(raw).toString()) : reject(new Error('el certificado no coincide con el pin del QR'))
    })
  })
  const submit = await request('POST', '/api/v0/pair', {}, JSON.stringify({ code: qrCode, deviceName: 'Telefono de prueba' }))
  assert.equal(submit.status, 200)
  const { pairingSecret, sas } = JSON.parse(submit.body) as { pairingSecret: string; sas: string }
  const pending = getRemoteAccessStatus().pendingPairings
  assert.equal(pending.length, 1)
  assert.equal(pending[0].sas, sas, 'la PC y el telefono muestran los mismos 6 digitos')
  assert.match(sas, /^\d{6}$/)
  assert.equal((await request('POST', '/api/v0/pair', {}, JSON.stringify({ code: qrCode, deviceName: 'otro' }))).status, 403, 'un solo uso')
  const waiting = JSON.parse((await request('GET', '/api/v0/pair/status', { Authorization: `Pairing ${pairingSecret}` })).body)
  assert.deepEqual(waiting, { status: 'awaiting-confirmation' })
  assert.equal(confirmRemotePairing(pending[0].pairingId, true).ok, true)
  const approved = JSON.parse((await request('GET', '/api/v0/pair/status', { Authorization: `Pairing ${pairingSecret}` })).body) as { status: string; token: string; deviceId: string }
  assert.equal(approved.status, 'approved')
  token = approved.token
  deviceId = approved.deviceId
  assert.equal(Buffer.from(token, 'base64url').length, 32, '256 bits')
  assert.equal((await request('GET', '/api/v0/pair/status', { Authorization: `Pairing ${pairingSecret}` })).status, 401, 'entregado una sola vez')
  const configDir = path.join(getAppDataRoot(), 'config')
  const stored = fs.readFileSync(path.join(configDir, 'remote-devices.json'), 'utf8')
  assert.ok(stored.includes(createHash('sha256').update(token).digest('hex')), 'guarda el hash')
  for (const f of fs.readdirSync(configDir)) assert.ok(!fs.readFileSync(path.join(configDir, f), 'latin1').includes(token), `el token no aparece en ${f}`)
})

test('emparejamiento: 5 codigos invalidos cierran la ventana (ni el correcto sirve despues)', async () => {
  const qr = startRemotePairing()
  const good = new URLSearchParams(qr.url.split('#')[1]).get('c') as string
  for (let i = 0; i < 5; i++) assert.equal((await request('POST', '/api/v0/pair', {}, JSON.stringify({ code: `malo-${i}`.padEnd(22, 'z'), deviceName: 'x' }))).status, 403)
  const late = await request('POST', '/api/v0/pair', {}, JSON.stringify({ code: good, deviceName: 'x' }))
  assert.equal(late.status, 403)
  assert.match(late.body, /no-window/)
})

test('lista blanca: solo 2 lecturas filtradas; ningun nombre de canal IPC es alcanzable ni invoca su handler', async () => {
  const projectsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'amatista-remote-projects-'))
  fs.mkdirSync(path.join(projectsRoot, 'ProyectoUno'))
  fs.mkdirSync(path.join(projectsRoot, 'ProyectoDos'))
  setSettings({ ...settings, projectRoots: [{ id: 'r1', name: 'raiz', path: projectsRoot }] })
  ensureChatSession({ id: 'chat-f', title: 'Chat filtrado', workspacePath: 'C:\\RUTA\\PRIVADA\\ws', workspaceName: 'ws' })
  saveChatMessage({ id: 'mf-1', chatId: 'chat-f', role: 'user', text: 'mensaje visible', attachments: [{ id: 'a', name: 'nota.txt', path: 'C:\\RUTA\\PRIVADA\\nota.txt', mimeType: 'text/plain', size: 9, kind: 'text', text: 'CONTENIDO-PRIVADO', preview: 'data:image/png;base64,AAAA' }] })
  const auth = { Authorization: `Bearer ${token}` }
  const chats = await request('GET', '/api/v0/chats', auth)
  assert.equal(chats.status, 200)
  assert.match(chats.body, /mensaje visible/)
  assert.match(chats.body, /nota\.txt/)
  for (const secret of ['PRIVADA', 'CONTENIDO-PRIVADO', 'workspacePath', 'data:image']) assert.ok(!chats.body.includes(secret), `chats no expone ${secret}`)
  const projects = await request('GET', '/api/v0/projects', auth)
  assert.deepEqual(JSON.parse(projects.body), { projects: ['ProyectoDos', 'ProyectoUno'] })
  assert.ok(!projects.body.includes(projectsRoot.split(path.sep)[1] ?? '###'), 'sin rutas')
  fs.rmSync(projectsRoot, { recursive: true, force: true })

  const channels = [...(ipcMain as unknown as { __handlers: Map<string, unknown> }).__handlers.keys()]
  assert.ok(channels.includes('settings:get') && channels.includes('agent:attach'))
  handlerCalls.clear()
  for (const channel of channels) {
    for (const p of [`/${channel}`, `/api/v0/${channel}`, `/api/v0/${encodeURIComponent(channel)}`, `/ipc/${channel}`]) {
      for (const method of ['GET', 'POST']) {
        const r = await request(method, p, auth, method === 'POST' ? JSON.stringify({ panelId: 'p', chatId: 'chat-f' }) : undefined)
        assert.equal(r.status, 404, `${method} ${p}`)
      }
    }
  }
  assert.deepEqual(Object.fromEntries(handlerCalls), {}, 'ningun handler IPC se invoco desde la red')
  assert.equal((await request('GET', '/api/v0/chats')).status, 401)
  assert.equal((await request('GET', '/api/v0/chats', { ...auth, Host: `evil.example:${port}` })).status, 421)
  assert.equal((await request('GET', '/api/v0/chats', { ...auth, Origin: 'https://evil.example' })).status, 403)
})

test('turno sin panel en la PC: anillo con secuencia, reanudacion exacta, eventLog y visiblePanelId intactos', async () => {
  const session = getSession('chat-f')
  assert.equal(session.visiblePanelId, null)
  const bootId = runningBootIdForTests() as string
  const before = currentRemoteSeq()
  sendSessionEvent('chat-f', { kind: 'notification', method: 'turn/started', chatId: 'chat-f' })
  sendSessionEvent('chat-f', { kind: 'notification', method: 'item/agentMessage/delta', params: { delta: 'uno' } })
  assert.equal(session.eventLog.length, 2, 'el camino de la PC (eventLog) sigue igual')
  const resumed = sse('/api/v0/events?chat=chat-f', `${bootId}-${before}`)
  await sleep(300)
  const ids = resumed.events.filter(e => e.id).map(e => `${e.event}#${Number(e.id!.split('-')[1]) - before}`)
  assert.deepEqual(ids, ['agent:event#1', 'remote:activity#2', 'agent:event#3'])
  sendSessionEvent('chat-f', { kind: 'notification', method: 'item/agentMessage/delta', params: { delta: 'dos' } })
  await sleep(150)
  assert.equal(resumed.events.at(-1)?.id, `${bootId}-${before + 4}`, 'en vivo, secuencia siguiente')
  resumed.close()
  await sleep(150)
  const fresh = sse('/api/v0/events?chat=chat-f')
  await sleep(300)
  assert.equal(fresh.events[0].event, 'hello')
  assert.equal(fresh.events.filter(e => e.event === 'backlog').length, 3, 'copia del eventLog')
  assert.equal(session.eventLog.length, 3, 'la copia no vacia el eventLog de la PC')
  assert.equal(session.visiblePanelId, null, 'el telefono no cuenta como panel visible')
  fresh.close()
  await sleep(150)
  const other = sse('/api/v0/events?chat=chat-f', 'otroarranque-3')
  await sleep(300)
  assert.ok(other.events.some(e => e.event === 'resync'))
  other.close()
  await sleep(150)
})

test('anillo desbordado: un hueco mas viejo que el anillo pide volver a cargar la foto (resync)', () => {
  const start = currentRemoteSeq()
  for (let i = 0; i <= RING_MAX; i++) fanOutToRemote('chat-desborde', 'agent:event', { kind: 'notification', method: 'item/agentMessage/delta', params: { delta: String(i) } })
  assert.deepEqual(remoteEventsSince(start, new Set(['chat-desborde'])), { gap: true })
  const recent = remoteEventsSince(currentRemoteSeq() - 1, new Set(['chat-desborde']))
  assert.ok('events' in recent && recent.events.length === 1)
})

test('aprobacion pendiente: solo el titulo completo, sin id de respuesta ni detalle; canales fuera de la lista no salen', async () => {
  const stream = sse('/api/v0/events?chat=chat-f')
  await sleep(250)
  fanOutToRemote('chat-f', 'agent:toolApproval', { id: 'ID-RESPUESTA', title: 'Ejecutar comando: npm run build en el proyecto', detail: 'DETALLE', allowTrust: true })
  fanOutToRemote('chat-f', 'chat:incomingMessage', { text: 'NO-DEBE-SALIR' })
  fanOutToRemote('chat-f', 'settings:get', { providers: 'NO-DEBE-SALIR' })
  await sleep(150)
  const approval = stream.events.find(e => e.event === 'agent:toolApproval')
  assert.ok(approval)
  assert.deepEqual(JSON.parse(approval.data).payload, { title: 'Ejecutar comando: npm run build en el proyecto' })
  assert.ok(!stream.events.some(e => e.data.includes('NO-DEBE-SALIR')))
  stream.close()
  await sleep(150)
})

test('revocacion: corta el stream abierto en el acto y todo pedido siguiente es 401', async () => {
  const stream = sse('/api/v0/events?chat=chat-f')
  await sleep(250)
  assert.equal(getRemoteAccessStatus().connectedCount, 1)
  const t0 = Date.now()
  revokeRemoteDevice(deviceId)
  await Promise.race([stream.closed, sleep(1500).then(() => { throw new Error('el stream no se corto') })])
  assert.ok(Date.now() - t0 < 1500)
  assert.equal((await request('GET', '/api/v0/chats', { Authorization: `Bearer ${token}` })).status, 401)
  assert.equal(await sse('/api/v0/events').status, 401)
  assert.equal(getRemoteAccessStatus().connectedCount, 0)
})

test('auditoria: registra los eventos de seguridad y nunca el token ni el codigo del QR', () => {
  const log = fs.readFileSync(path.join(getAppDataRoot(), 'config', 'remote-access.log'), 'utf8')
  for (const event of ['start-refused-no-consent', 'consent-acknowledged', 'server-started', 'device-paired', 'pairing-window-locked', 'auth-failed', 'stream-opened', 'device-revoked']) assert.match(log, new RegExp(`"event":"${event}"`))
  assert.ok(!log.includes(token))
  assert.ok(!log.includes(qrCode))
})
