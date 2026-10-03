// Acceso remoto F0 (docs/_experiments/remote-control/CONTRACT.md §3): observadores remotos de chats, SEPARADOS
// de `visiblePanelId`.
//
// `visiblePanelId` significa "un panel de ESTA PC muestra el chat" y de eso dependen efectos reales (Familia A
// se apaga al soltar el panel, notificaciones de Windows, badge de 2do plano, vistas nativas, orquestacion). Un
// telefono NUNCA cuenta como visible: este modulo no toca SessionRuntimeState en absoluto. Su unico enganche es
// fanOutToRemote(), llamado al principio de sendToChatWindow() (runtime-state.ts) con una COPIA filtrada del
// evento -- el original sigue su camino de siempre (panel de la PC o eventLog).
//
// Anillo con numero de secuencia: se graba SIEMPRE mientras el acceso remoto esta encendido, haya o no un
// telefono conectado -- asi un turno que corre sin ningun panel ni telefono mirando queda disponible para
// reanudar con Last-Event-ID (hueco "mensajes no guardados" de F0: los guarda el renderer, no el motor).
import { getChatTitle } from './chat-store'

/** Los 6 canales de sesion que salen por sendToChatWindow() -- lista BLANCA: cualquier otro no se reenvia. */
export const REMOTE_CHANNELS: ReadonlySet<string> = new Set([
  'agent:event',
  'agent:toolApproval',
  'agent:planMode',
  'agent:toolTrust',
  'agent:computerUse',
  'agent:browserControl'
])
/** Actividad en 2do plano calculada para el telefono (TODO chat con turno en vuelo, este o no en un panel). */
export const ACTIVITY_CHANNEL = 'remote:activity'
export const RING_MAX = 2000

export interface RemoteEvent { seq: number; chatId: string | null; channel: string; payload: unknown; at: number }
export interface RemoteObserver {
  observerId: string
  deviceId: string
  chatIds: ReadonlySet<string>
  /** Encola en SU stream sin bloquear. false = cola llena: el observador se corta (el telefono vuelve a pedir la foto). */
  push(event: RemoteEvent): boolean
  close(): void
}
export type ActivitySnapshot = Record<string, { chatTitle: string; startedAt: number }>

let recording = false
let nextSeq = 1
const ring: RemoteEvent[] = []
const observers = new Map<string, RemoteObserver>()
const observersByChat = new Map<string, Map<string, RemoteObserver>>()
const activity = new Map<string, { chatTitle: string; startedAt: number }>()

// ---- filtrado: el telefono recibe una COPIA reducida, nunca el objeto original ----
const DROP_KEYS = new Set(['panelId', 'workspace', 'workspacePath', 'path', 'cwd', 'apiKey', 'encryptedApiKey', 'token', 'pairingSecret'])
export const MAX_REMOTE_STRING = 4000
function sanitize(value: unknown, depth: number): unknown {
  if (depth > 8) return '[…]'
  if (typeof value === 'string') {
    if (value.startsWith('data:')) return '[contenido binario omitido]'
    return value.length > MAX_REMOTE_STRING ? `${value.slice(0, MAX_REMOTE_STRING)}… [recortado: ${value.length} caracteres en la PC]` : value
  }
  if (Array.isArray(value)) return value.slice(0, 200).map(v => sanitize(v, depth + 1))
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (DROP_KEYS.has(k)) continue
      out[k] = sanitize(v, depth + 1)
    }
    return out
  }
  return value
}
/** Aprobacion pendiente: SOLO el titulo completo (decision del usuario), sin id de respuesta ni detalle. */
export function projectForRemote(channel: string, payload: Record<string, unknown>): unknown {
  if (channel === 'agent:toolApproval') return { title: typeof payload.title === 'string' ? payload.title : '' }
  return sanitize(payload, 0)
}

// ---- grabacion y reparto ----
function record(chatId: string | null, channel: string, payload: unknown): RemoteEvent {
  const event: RemoteEvent = { seq: nextSeq++, chatId, channel, payload, at: Date.now() }
  ring.push(event)
  if (ring.length > RING_MAX) ring.shift()
  return event
}
function deliver(event: RemoteEvent): void {
  const targets = event.chatId === null ? [...observers.values()] : [...(observersByChat.get(event.chatId)?.values() ?? [])]
  for (const observer of targets) {
    let ok = false
    try { ok = observer.push(event) } catch { ok = false }
    if (!ok) { removeObserver(observer.observerId); try { observer.close() } catch { /* ya cerrado */ } }
  }
}
export function activitySnapshot(): ActivitySnapshot {
  return Object.fromEntries(activity)
}
function updateActivity(chatId: string, payload: Record<string, unknown>): void {
  if (payload.kind !== 'notification') return
  const method = payload.method
  let changed = false
  if (method === 'turn/started' && !activity.has(chatId)) {
    activity.set(chatId, { chatTitle: getChatTitle(chatId) ?? chatId, startedAt: Date.now() })
    changed = true
  } else if ((method === 'turn/completed' || method === 'turn/cancelled') && activity.has(chatId)) {
    activity.delete(chatId)
    changed = true
  }
  if (changed) deliver(record(null, ACTIVITY_CHANNEL, { chats: activitySnapshot() }))
}

/** Unico enganche en el codigo existente (primera linea de sendToChatWindow). Nunca lanza hacia afuera en la
 *  practica (el llamador igual lo envuelve en try/catch): un telefono lento o caido no demora ni rompe un turno. */
export function fanOutToRemote(chatId: string, channel: string, payload: Record<string, unknown>): void {
  if (!recording || !REMOTE_CHANNELS.has(channel)) return
  deliver(record(chatId, channel, projectForRemote(channel, payload)))
  if (channel === 'agent:event') updateActivity(chatId, payload)
}

export function startRemoteRecording(seed: Array<{ chatId: string; chatTitle: string; startedAt: number }>): void {
  recording = true
  activity.clear()
  for (const s of seed) activity.set(s.chatId, { chatTitle: s.chatTitle, startedAt: s.startedAt })
}
export function stopRemoteRecording(): void {
  recording = false
  ring.length = 0
  activity.clear()
  for (const observer of [...observers.values()]) { removeObserver(observer.observerId); try { observer.close() } catch { /* ya cerrado */ } }
}
export const isRemoteRecording = (): boolean => recording
export const currentRemoteSeq = (): number => nextSeq - 1

/** Reanudar tras un corte: eventos posteriores a `lastSeq` de los chats observados (mas la actividad). `gap` =
 *  el hueco es mas viejo que el anillo (o la secuencia no existe): el telefono tiene que volver a pedir la foto. */
export function remoteEventsSince(lastSeq: number, chatIds: ReadonlySet<string>): { events: RemoteEvent[] } | { gap: true } {
  const oldest = ring[0]?.seq ?? nextSeq
  if (!Number.isInteger(lastSeq) || lastSeq < oldest - 1 || lastSeq > nextSeq - 1) return { gap: true }
  return { events: ring.filter(e => e.seq > lastSeq && (e.chatId === null || chatIds.has(e.chatId))) }
}

// ---- registro de observadores ----
export function addObserver(observer: RemoteObserver): void {
  observers.set(observer.observerId, observer)
  for (const chatId of observer.chatIds) {
    let byObserver = observersByChat.get(chatId)
    if (!byObserver) { byObserver = new Map(); observersByChat.set(chatId, byObserver) }
    byObserver.set(observer.observerId, observer)
  }
}
export function removeObserver(observerId: string): void {
  const observer = observers.get(observerId)
  if (!observer) return
  observers.delete(observerId)
  for (const chatId of observer.chatIds) {
    const byObserver = observersByChat.get(chatId)
    byObserver?.delete(observerId)
    if (byObserver && byObserver.size === 0) observersByChat.delete(chatId)
  }
}
/** Revocacion: corta en el acto todos los streams de ese dispositivo. */
export function closeObserversForDevice(deviceId: string): number {
  let closed = 0
  for (const observer of [...observers.values()]) {
    if (observer.deviceId !== deviceId) continue
    removeObserver(observer.observerId)
    try { observer.close() } catch { /* ya cerrado */ }
    closed += 1
  }
  return closed
}
export function observerCount(deviceId?: string): number {
  return deviceId ? [...observers.values()].filter(o => o.deviceId === deviceId).length : observers.size
}
export function connectedDeviceIds(): Set<string> {
  return new Set([...observers.values()].map(o => o.deviceId))
}
