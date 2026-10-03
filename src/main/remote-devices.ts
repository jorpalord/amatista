// Acceso remoto F0 (docs/_experiments/remote-control/CONTRACT.md §4): consentimiento, dispositivos emparejados,
// emparejamiento y auditoria.
//
// Todo vive en archivos PROPIOS de config/, nunca en settings.json: evita la reserializacion de settings (que
// re-cifra las API keys) y la clasificacion de campos de ipc-settings.ts. Solo el proceso principal los escribe.
//   remote-access.json   -- { acknowledged, port, bindAddress? }  (el "encendido" NO persiste: F0 arranca apagado)
//   remote-devices.json  -- dispositivos: SOLO el hash SHA-256 del token, nunca el token
//   remote-access.log    -- auditoria (una linea JSON por evento), nunca tokens ni codigos
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { appendFileSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { getAppDataSubdir } from './app-paths'

export const PAIRING_CODE_TTL_MS = 120_000
export const PAIRING_CONFIRM_TTL_MS = 120_000
export const PAIRING_MAX_FAILURES = 5
export const DEFAULT_REMOTE_PORT = 47823

export interface RemoteAccessConfig { acknowledged: boolean; port: number; bindAddress?: string }
export interface RemoteDevice { deviceId: string; name: string; tokenHash: string; createdAt: string; lastSeenAt: string; scopes: ['read'] }
export type PublicRemoteDevice = Omit<RemoteDevice, 'tokenHash'>

const configDir = (): string => getAppDataSubdir('config')
const accessFile = (): string => path.join(configDir(), 'remote-access.json')
const devicesFile = (): string => path.join(configDir(), 'remote-devices.json')
const auditFile = (): string => path.join(configDir(), 'remote-access.log')

function readJson<T>(file: string, fallback: T): T {
  if (!existsSync(file)) return fallback
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T
  } catch {
    try { renameSync(file, `${file}.ilegible-${Date.now()}`) } catch { /* sin permiso: se sigue igual */ }
    return fallback
  }
}
function writeJsonAtomic(file: string, data: unknown): void {
  const tmp = `${file}.tmp`
  writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8')
  renameSync(tmp, file)
}

// ---- auditoria ----
export function audit(event: string, details: Record<string, string | number | boolean | undefined> = {}): void {
  try {
    appendFileSync(auditFile(), `${JSON.stringify({ at: new Date().toISOString(), event, ...details })}\n`, 'utf8')
  } catch { /* la auditoria nunca rompe el flujo principal */ }
}
export function readAuditLog(): Array<Record<string, unknown>> {
  if (!existsSync(auditFile())) return []
  return readFileSync(auditFile(), 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l) as Record<string, unknown> } catch { return { raw: l } } })
}

// ---- consentimiento y configuracion ----
export function readRemoteAccessConfig(): RemoteAccessConfig {
  const raw = readJson<Partial<RemoteAccessConfig>>(accessFile(), {})
  const port = Number.isInteger(raw.port) && (raw.port as number) > 1024 && (raw.port as number) < 65536 ? raw.port as number : DEFAULT_REMOTE_PORT
  return { acknowledged: raw.acknowledged === true, port, ...(typeof raw.bindAddress === 'string' && raw.bindAddress ? { bindAddress: raw.bindAddress } : {}) }
}
/** Unico punto que marca el consentimiento: lo llama SOLO el boton "Entiendo los riesgos" (via IPC). */
export function acknowledgeRemoteAccess(): void {
  writeJsonAtomic(accessFile(), { ...readRemoteAccessConfig(), acknowledged: true })
  audit('consent-acknowledged')
}

// ---- dispositivos ----
interface DevicesFile { version: 1; devices: RemoteDevice[] }
function readDevices(): RemoteDevice[] {
  return readJson<DevicesFile>(devicesFile(), { version: 1, devices: [] }).devices ?? []
}
function writeDevices(devices: RemoteDevice[]): void {
  writeJsonAtomic(devicesFile(), { version: 1, devices })
}
export const hashToken = (token: string): string => createHash('sha256').update(token, 'utf8').digest('hex')

export function listDevices(): PublicRemoteDevice[] {
  return readDevices().map(({ tokenHash: _omit, ...rest }) => rest)
}

const lastSeenWrites = new Map<string, number>()
/** Busca el dispositivo por el HASH del token presentado, en tiempo constante por comparacion. */
export function authenticateToken(token: string | undefined): PublicRemoteDevice | null {
  if (!token || token.length > 200) return null
  const presented = Buffer.from(hashToken(token), 'hex')
  const devices = readDevices()
  let match: RemoteDevice | null = null
  for (const d of devices) {
    const stored = Buffer.from(d.tokenHash, 'hex')
    if (stored.length === presented.length && timingSafeEqual(stored, presented)) match = d
  }
  if (!match) return null
  // lastSeenAt a disco como mucho una vez por minuto por dispositivo (cada pedido no reescribe el archivo)
  const now = Date.now()
  if (now - (lastSeenWrites.get(match.deviceId) ?? 0) > 60_000) {
    lastSeenWrites.set(match.deviceId, now)
    writeDevices(devices.map(d => d.deviceId === match!.deviceId ? { ...d, lastSeenAt: new Date(now).toISOString() } : d))
  }
  const { tokenHash: _omit, ...rest } = match
  return rest
}

export function revokeDevice(deviceId: string): boolean {
  const devices = readDevices()
  const next = devices.filter(d => d.deviceId !== deviceId)
  if (next.length === devices.length) return false
  writeDevices(next)
  audit('device-revoked', { deviceId })
  return true
}
export function revokeAllDevices(): number {
  const n = readDevices().length
  writeDevices([])
  audit('devices-revoked-all', { count: n })
  return n
}

// ---- emparejamiento ----
interface PairingWindow { code: string; expiresAt: number; failures: number }
interface PendingPairing {
  pairingId: string
  pairingSecret: string
  deviceName: string
  sas: string
  expiresAt: number
  status: 'awaiting-confirmation' | 'approved' | 'rejected'
  token?: string
  deviceId?: string
}
let pairingWindow: PairingWindow | null = null
const pendingById = new Map<string, PendingPairing>()

/** Codigo corto de verificacion: 6 digitos derivados del codigo del QR y del secreto de esta solicitud. Se
 *  muestra en la PC y en el telefono -- si no coinciden, el usuario rechaza (alguien uso el QR antes). */
export function shortAuthString(code: string, pairingSecret: string): string {
  const mac = createHmac('sha256', code).update(pairingSecret).digest()
  return String(mac.readUInt32BE(0) % 1_000_000).padStart(6, '0')
}

export function startPairingWindow(): { code: string; expiresAt: number } {
  pairingWindow = { code: randomBytes(16).toString('base64url'), expiresAt: Date.now() + PAIRING_CODE_TTL_MS, failures: 0 }
  audit('pairing-window-opened', { expiresAt: new Date(pairingWindow.expiresAt).toISOString() })
  return { code: pairingWindow.code, expiresAt: pairingWindow.expiresAt }
}
export function cancelPairingWindow(): void {
  if (pairingWindow) audit('pairing-window-closed')
  pairingWindow = null
}
export function pairingWindowState(): { active: boolean; expiresAt?: number } {
  if (pairingWindow && Date.now() > pairingWindow.expiresAt) pairingWindow = null
  return pairingWindow ? { active: true, expiresAt: pairingWindow.expiresAt } : { active: false }
}

export type SubmitResult =
  | { ok: true; pairingId: string; pairingSecret: string; sas: string; deviceName: string; expiresAt: number }
  | { ok: false; reason: 'no-window' | 'expired' | 'invalid' | 'locked' }

/** El telefono presenta el codigo del QR. Un solo uso: el primer codigo valido cierra la ventana. */
export function submitPairingCode(code: unknown, deviceName: unknown, remoteAddress: string): SubmitResult {
  const window = pairingWindow
  if (!window) { audit('pairing-rejected', { reason: 'no-window', remoteAddress }); return { ok: false, reason: 'no-window' } }
  if (Date.now() > window.expiresAt) { pairingWindow = null; audit('pairing-rejected', { reason: 'expired', remoteAddress }); return { ok: false, reason: 'expired' } }
  const presented = Buffer.from(typeof code === 'string' ? code : '', 'utf8')
  const expected = Buffer.from(window.code, 'utf8')
  const valid = presented.length === expected.length && timingSafeEqual(presented, expected)
  if (!valid) {
    window.failures += 1
    audit('pairing-code-invalid', { remoteAddress, failures: window.failures })
    if (window.failures >= PAIRING_MAX_FAILURES) {
      pairingWindow = null
      audit('pairing-window-locked', { remoteAddress })
      return { ok: false, reason: 'locked' }
    }
    return { ok: false, reason: 'invalid' }
  }
  pairingWindow = null // un solo uso
  const name = (typeof deviceName === 'string' ? deviceName : '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 60) || 'Dispositivo sin nombre'
  const pairingSecret = randomBytes(16).toString('base64url')
  const pending: PendingPairing = {
    pairingId: randomUUID(),
    pairingSecret,
    deviceName: name,
    sas: shortAuthString(window.code, pairingSecret),
    expiresAt: Date.now() + PAIRING_CONFIRM_TTL_MS,
    status: 'awaiting-confirmation'
  }
  pendingById.set(pending.pairingId, pending)
  audit('pairing-code-accepted', { pairingId: pending.pairingId, deviceName: name, remoteAddress })
  return { ok: true, pairingId: pending.pairingId, pairingSecret, sas: pending.sas, deviceName: name, expiresAt: pending.expiresAt }
}

/** Decision del usuario EN LA PC (unico camino a un token): acepta o rechaza, despues de comparar los 6 digitos. */
export function confirmPairing(pairingId: string, accept: boolean): { ok: boolean; deviceId?: string } {
  const pending = pendingById.get(pairingId)
  if (!pending || pending.status !== 'awaiting-confirmation' || Date.now() > pending.expiresAt) return { ok: false }
  if (!accept) {
    pending.status = 'rejected'
    audit('pairing-rejected-by-user', { pairingId })
    return { ok: true }
  }
  const token = randomBytes(32).toString('base64url') // 256 bits
  const now = new Date().toISOString()
  const device: RemoteDevice = { deviceId: randomUUID(), name: pending.deviceName, tokenHash: hashToken(token), createdAt: now, lastSeenAt: now, scopes: ['read'] }
  writeDevices([...readDevices(), device])
  pending.status = 'approved'
  pending.token = token // se entrega UNA sola vez por pollPairing() y se borra
  pending.deviceId = device.deviceId
  pending.expiresAt = Date.now() + PAIRING_CONFIRM_TTL_MS
  audit('device-paired', { deviceId: device.deviceId, deviceName: device.name })
  return { ok: true, deviceId: device.deviceId }
}

export type PollResult =
  | { status: 'awaiting-confirmation' | 'rejected' | 'expired' | 'unknown' }
  | { status: 'approved'; token: string; deviceId: string }

/** El telefono pregunta por su solicitud con el secreto que recibio al presentar el codigo. */
export function pollPairing(pairingSecret: string | undefined): PollResult {
  if (!pairingSecret) return { status: 'unknown' }
  const presented = Buffer.from(pairingSecret, 'utf8')
  for (const pending of pendingById.values()) {
    const stored = Buffer.from(pending.pairingSecret, 'utf8')
    if (stored.length !== presented.length || !timingSafeEqual(stored, presented)) continue
    if (Date.now() > pending.expiresAt) { pendingById.delete(pending.pairingId); return { status: 'expired' } }
    if (pending.status === 'approved' && pending.token && pending.deviceId) {
      const result = { status: 'approved' as const, token: pending.token, deviceId: pending.deviceId }
      pendingById.delete(pending.pairingId) // entregado una sola vez
      return result
    }
    if (pending.status === 'rejected') { pendingById.delete(pending.pairingId); return { status: 'rejected' } }
    return { status: 'awaiting-confirmation' }
  }
  return { status: 'unknown' }
}

export function listPendingPairings(): Array<{ pairingId: string; deviceName: string; sas: string; expiresAt: number }> {
  const now = Date.now()
  return [...pendingById.values()]
    .filter(p => p.status === 'awaiting-confirmation' && p.expiresAt > now)
    .map(({ pairingId, deviceName, sas, expiresAt }) => ({ pairingId, deviceName, sas, expiresAt }))
}

/** Al apagar el acceso remoto: ninguna ventana ni solicitud a medio camino sobrevive. */
export function clearPairingState(): void {
  pairingWindow = null
  pendingById.clear()
}
