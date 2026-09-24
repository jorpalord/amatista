// Termometro del limite de longitud de conversacion de DeepSeek PWA. La interfaz web no publica un tope en tokens, asi
// que se mide lo que SI se puede contar con precision: los caracteres reales de cada mensaje mandado (incluidos los
// TOOL_RESULT) y de cada respuesta recibida, acumulados por conversacion remota. Cuando DeepSeek corta por longitud, se
// guarda una OBSERVACION real. Con suficientes observaciones se deriva un umbral conservador y se avisa antes.
//
// Es una APROXIMACION que mejora con el uso, no una medicion de tokens: la relacion caracteres/tokens cambia con el
// idioma y el contenido (codigo, prosa, chino). Sin observaciones no hay umbral y no se inventa uno.
//
// Almacen: un archivo propio (config/deepseek-pwa-termometro.json), no una tabla de la base de chats -- es
// meta-informacion sobre DeepSeek (sobrevive a borrar chats), no guarda ningun contenido (solo tamaños, fechas y un
// hash del id de la conversacion remota), y se puede inspeccionar o resetear a mano borrando el archivo.
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { getAppDataSubdir } from './app-paths'

/** Observaciones reales necesarias antes de avisar nada. */
export const THERMOMETER_MIN_OBSERVATIONS = 3
/** Aviso "se esta acercando" desde este porcentaje del umbral. */
export const THERMOMETER_WARN_RATIO = 0.8
const MAX_TRACKED_CONVERSATIONS = 200
const FILE_NAME = 'deepseek-pwa-termometro.json'

export interface ThermometerObservation {
  at: string
  /** Caracteres acumulados en la conversacion ANTES del mensaje que DeepSeek ya no acepto. */
  contextChars: number
  /** Caracteres del mensaje rechazado. */
  rejectedMessageChars: number
  messages: number
}

interface TrackedConversation {
  contextChars: number
  messages: number
  /** true solo si el contador arranco con el PRIMER mensaje de la conversacion: si no, su tamaño real es desconocido
   *  y un corte en ella no puede usarse como observacion (bajaria el umbral en falso). */
  complete: boolean
  /** Nivel de aviso ya anunciado en esta conversacion (0 ninguno, 1 acercandose, 2 superado). */
  warned: number
  /** El corte de esta conversacion ya se registro: cada reintento posterior en ella vuelve a cortar y no debe duplicarlo. */
  limitRecorded?: boolean
  updatedAt: string
}

interface ThermometerFile {
  version: 1
  observations: ThermometerObservation[]
  conversations: Record<string, TrackedConversation>
}

export interface ThermometerReading {
  contextChars: number
  complete: boolean
  observations: number
  /** null mientras haya menos de THERMOMETER_MIN_OBSERVATIONS observaciones reales. */
  threshold: number | null
  level: 0 | 1 | 2
  /** Texto para la UI si se cruzo un nivel NUEVO en esta conversacion; null si no hay nada que avisar. */
  announcement: string | null
}

function filePath(): string {
  // Override opt-in (mismo patron que AMATISTA_MCP_PIPE/AMATISTA_MAIN_BACKSTOP_MS): cada archivo de test usa el suyo.
  return process.env.AMATISTA_DEEPSEEK_PWA_THERMOMETER_FILE?.trim() || path.join(getAppDataSubdir('config'), FILE_NAME)
}

function emptyFile(): ThermometerFile {
  return { version: 1, observations: [], conversations: {} }
}

function load(): ThermometerFile {
  const file = filePath()
  if (!existsSync(file)) return emptyFile()
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as ThermometerFile
    if (parsed?.version !== 1 || !Array.isArray(parsed.observations) || typeof parsed.conversations !== 'object') throw new Error('forma invalida')
    return parsed
  } catch {
    // Nunca se pisa en silencio un archivo que no se entiende: se aparta con su fecha y se arranca de cero.
    try { renameSync(file, `${file}.ilegible-${Date.now()}`) } catch { /* sin permiso: se sigue igual */ }
    return emptyFile()
  }
}

function save(data: ThermometerFile): void {
  const file = filePath()
  const tmp = `${file}.tmp-${process.pid}`
  writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8')
  renameSync(tmp, file)
}

function conversationKey(remoteSessionId: string): string {
  return createHash('sha256').update(remoteSessionId).digest('hex').slice(0, 16)
}

function thresholdOf(data: ThermometerFile): number | null {
  if (data.observations.length < THERMOMETER_MIN_OBSERVATIONS) return null
  return Math.min(...data.observations.map(o => o.contextChars))
}

function levelFor(contextChars: number, threshold: number | null): 0 | 1 | 2 {
  if (threshold === null || threshold <= 0) return 0
  const ratio = contextChars / threshold
  return ratio >= 1 ? 2 : ratio >= THERMOMETER_WARN_RATIO ? 1 : 0
}

function formatChars(n: number): string {
  return n.toLocaleString('es-AR')
}

function announcementFor(level: 1 | 2, contextChars: number, threshold: number, observations: number): string {
  const base = level === 1
    ? `Termometro de Amatista (aproximado): esta conversacion con DeepSeek ya lleva unos ${formatChars(contextChars)} caracteres y se esta acercando al corte por longitud mas bajo observado hasta ahora (${formatChars(threshold)}).`
    : `Termometro de Amatista (aproximado): esta conversacion con DeepSeek ya lleva unos ${formatChars(contextChars)} caracteres, por encima del corte por longitud mas bajo observado hasta ahora (${formatChars(threshold)}).`
  return `${base} Capaz convenga arrancar un chat nuevo pronto. Es una estimacion basada en ${observations} corte(s) reales y mejora con el uso; no es una medida exacta de tokens.`
}

function prune(data: ThermometerFile): void {
  const keys = Object.keys(data.conversations)
  if (keys.length <= MAX_TRACKED_CONVERSATIONS) return
  keys.sort((a, b) => data.conversations[a].updatedAt.localeCompare(data.conversations[b].updatedAt))
  for (const key of keys.slice(0, keys.length - MAX_TRACKED_CONVERSATIONS)) delete data.conversations[key]
}

/**
 * Suma un intercambio real (mensaje mandado + respuesta recibida) a la conversacion remota. `startsConversation`: la
 * PWA no tenia conversacion antes de este envio (este mensaje la creo), unico caso en que el contador es completo.
 */
export function recordDeepSeekExchange(remoteSessionId: string | null, sentChars: number, receivedChars: number, startsConversation: boolean): ThermometerReading | null {
  if (!remoteSessionId) return null
  const data = load()
  const key = conversationKey(remoteSessionId)
  const now = new Date().toISOString()
  const previous = startsConversation ? undefined : data.conversations[key]
  const entry: TrackedConversation = previous ?? { contextChars: 0, messages: 0, complete: startsConversation, warned: 0, updatedAt: now }
  entry.contextChars += sentChars + receivedChars
  entry.messages += 1
  entry.updatedAt = now
  data.conversations[key] = entry

  const threshold = thresholdOf(data)
  const level = levelFor(entry.contextChars, threshold)
  let announcement: string | null = null
  if (level > entry.warned && threshold !== null) {
    announcement = announcementFor(level as 1 | 2, entry.contextChars, threshold, data.observations.length)
    entry.warned = level
  }
  prune(data)
  save(data)
  return { contextChars: entry.contextChars, complete: entry.complete, observations: data.observations.length, threshold, level, announcement }
}

/**
 * DeepSeek corto la conversacion por longitud: guarda la observacion SOLO si el contador cubre la conversacion entera.
 * Devuelve un texto honesto sobre lo que se registro (o por que no).
 */
export function recordDeepSeekLengthLimit(remoteSessionId: string | null, rejectedMessageChars: number): string {
  const data = load()
  const entry = remoteSessionId ? data.conversations[conversationKey(remoteSessionId)] : undefined
  if (!entry || !entry.complete) {
    return 'Termometro de Amatista: este corte NO se registro como observacion -- la conversacion empezo antes de que Amatista la midiera, asi que su tamaño real es desconocido.'
  }
  if (entry.limitRecorded) {
    return 'Termometro de Amatista: el corte de esta conversacion ya estaba registrado (no se duplica).'
  }
  data.observations.push({ at: new Date().toISOString(), contextChars: entry.contextChars, rejectedMessageChars, messages: entry.messages })
  entry.limitRecorded = true
  save(data)
  const n = data.observations.length
  return n < THERMOMETER_MIN_OBSERVATIONS
    ? `Termometro de Amatista: corte registrado (unos ${formatChars(entry.contextChars)} caracteres). Lleva ${n} de ${THERMOMETER_MIN_OBSERVATIONS} observaciones reales necesarias antes de poder avisar con anticipacion.`
    : `Termometro de Amatista: corte registrado (unos ${formatChars(entry.contextChars)} caracteres). Con ${n} observaciones reales, el umbral de aviso actual es ${formatChars(thresholdOf(data) ?? 0)} caracteres.`
}

/** Estado actual, sin modificar nada (diagnostico y tests). */
export function readDeepSeekThermometer(): { observations: ThermometerObservation[]; threshold: number | null; trackedConversations: number } {
  const data = load()
  return { observations: data.observations, threshold: thresholdOf(data), trackedConversations: Object.keys(data.conversations).length }
}
