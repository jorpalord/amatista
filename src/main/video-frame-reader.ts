// Tool extract_video_frame (F2 de docs/_arch/verify_native_multimodal_tools_design.md, §2.3 y §3): extrae UN
// fotograma de un video ya confinado al workspace (la confinacion la hace quien llama, ver tool-registry.ts) y lo
// prepara para que un modelo con vision lo VEA. Motor primario: el propio Chromium de Electron, en una
// BrowserWindow oculta singleton con un <video> real -- cero dependencias nuevas (ya probado contra un archivo real
// de 922 MB en la investigacion: 1er frame 2,6s, luego 43-237ms). Motor de respaldo: ffmpeg del PATH del sistema
// SI esta instalado -- NUNCA empaquetado (ffmpeg-static suma ~80MB y es GPL-3.0-or-later, ya descartado).
//
// Aislamiento de la ventana oculta (§3.3 del diseno):
//   - session PROPIA (partition en memoria, nunca "persist:") -- setPermissionRequestHandler/setPermissionCheckHandler
//     de ESA session (no la default: no debe afectar permisos del resto de la app) niegan TODO.
//   - sandbox:true, contextIsolation:true, sin nodeIntegration, sin preload -- nada de la pagina puede tocar Node;
//     el resultado sale via webContents.executeJavaScript() desde MAIN (que no depende de contextIsolation).
//   - sin navegacion ni ventanas nuevas (will-navigate/setWindowOpenHandler denegados).
//   - protocolo propio (amatista-video-frame://) que sirve SOLO el archivo activo de ESTE turno, identificado por
//     un token de un solo uso (activeServe) -- nunca una ruta generica tipo file?p=. Soporta Range (bytes=) real:
//     un <video> real pide rangos al buscar, y sin eso un archivo grande se cargaria entero antes de poder buscar.
//   - render-process-gone (archivo malformado matando el renderer) se trata como fallo de esta llamada, nunca de main.
//   - ventana singleton PEREZOSA (arranca en el primer uso real) que se destruye sola tras VIDEO_WINDOW_IDLE_MS de
//     inactividad -- a diferencia del overlay de Familia A (runtime-state.ts), que vive toda la vida de la app.
//
// Serializacion: mismo patron que withSettingsLock() (runtime-state.ts) -- una sola ventana real, un solo turno de
// extraccion a la vez; llamadas concurrentes (otro panel, otra sesion de fondo) se encolan, nunca se pisan.
import { BrowserWindow, session as electronSession, protocol } from 'electron'
import { execFile, spawn } from 'node:child_process'
import { closeSync, openSync, readSync, statSync } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { detectFfmpeg } from './cli-status'

export const EXTRACT_VIDEO_FRAME_MAX_LONG_SIDE = 1568
/** Tope de tamano de archivo puramente defensivo (typo/archivo equivocado) -- a diferencia del Mpx de read_image,
 *  buscar un fotograma NO escala con el peso del archivo (Range real, nunca se decodifica el video entero), asi
 *  que este numero es generoso a proposito. */
export const EXTRACT_VIDEO_FRAME_MAX_FILE_BYTES = 20 * 1024 * 1024 * 1024
const DEFAULT_MAX_ENCODED_BYTES = 5 * 1024 * 1024
const JPEG_QUALITIES = [0.85, 0.7, 0.5] as const
const VIDEO_PROTOCOL_SCHEME = 'amatista-video-frame'
const VIDEO_WORKER_PARTITION = 'video-frame-worker'
/** Ventana ociosa (sin ningun uso real) se destruye a los 60s -- misma logica de "perezosa" que su creacion:
 *  no hace falta mantener ~150-200MB de RAM/GPU reservados si la tool no se usa por un rato. Mismo patron de
 *  override opt-in que AMATISTA_MCP_PIPE/AMATISTA_MAIN_BACKSTOP_MS -- verificacion real sin esperar 60s reales. */
const VIDEO_WINDOW_IDLE_MS = Number(process.env.AMATISTA_VIDEO_FRAME_IDLE_MS) || 60_000
const CHROMIUM_EXTRACTION_TIMEOUT_MS = Number(process.env.AMATISTA_VIDEO_FRAME_CHROMIUM_TIMEOUT_MS) || 30_000
const FFMPEG_EXTRACTION_TIMEOUT_MS = Number(process.env.AMATISTA_VIDEO_FRAME_FFMPEG_TIMEOUT_MS) || 30_000

export interface ExtractVideoFrameOptions {
  /** Tal cual lo mando el modelo, sin validar (numero, o texto "MM:SS"/"HH:MM:SS"/segundos). */
  timestamp?: unknown
  /** Maximo de bytes (base64) que el runtime activo acepta por imagen (ExecuteContext.resultImageMaxBytes); undefined = 5 MB. */
  maxEncodedBytes?: number
}
export type ExtractVideoFrameOutcome = { ok: true; text: string; imageDataUrl: string } | { ok: false; error: string }

const fail = (error: string): ExtractVideoFrameOutcome => ({ ok: false, error })

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`
}

function formatTimestamp(seconds: number): string {
  const total = Math.max(0, Math.round(seconds))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const pad = (n: number): string => String(n).padStart(2, '0')
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`
}

/** Acepta numero de segundos, su texto ("12.5"), o "MM:SS"/"HH:MM:SS". */
export function parseTimestamp(raw: unknown): { ok: true; seconds: number } | { ok: false; error: string } {
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    if (raw < 0) return { ok: false, error: `"timestamp" no puede ser negativo (recibido: ${raw}).` }
    return { ok: true, seconds: raw }
  }
  if (typeof raw === 'string' && raw.trim() !== '') {
    const trimmed = raw.trim()
    if (/^\d+(\.\d+)?$/.test(trimmed)) return { ok: true, seconds: Number(trimmed) }
    const parts = trimmed.split(':')
    if (parts.length === 2 || parts.length === 3) {
      const nums = parts.map(Number)
      if (nums.every(n => Number.isFinite(n) && n >= 0)) {
        const seconds = parts.length === 3 ? nums[0] * 3600 + nums[1] * 60 + nums[2] : nums[0] * 60 + nums[1]
        return { ok: true, seconds }
      }
    }
  }
  return { ok: false, error: `"timestamp" invalido: ${JSON.stringify(raw)}. Usa segundos (ej. 12.5) o "MM:SS"/"HH:MM:SS" (ej. "01:23").` }
}

function mimeTypeForVideoExtension(absPath: string): string {
  switch (path.extname(absPath).toLowerCase()) {
    case '.mp4': case '.m4v': return 'video/mp4'
    case '.mov': return 'video/quicktime'
    case '.webm': return 'video/webm'
    case '.mkv': return 'video/x-matroska'
    case '.avi': return 'video/x-msvideo'
    case '.wmv': return 'video/x-ms-wmv'
    case '.ogv': case '.ogg': return 'video/ogg'
    case '.flv': return 'video/x-flv'
    case '.3gp': return 'video/3gpp'
    default: return 'video/mp4'
  }
}

// --- registro del esquema privilegiado (DEBE correr antes de app.ready -- ver index.ts) -------------------------

let schemeRegistered = false
export function registerVideoFrameProtocolScheme(): void {
  if (schemeRegistered) return
  schemeRegistered = true
  protocol.registerSchemesAsPrivileged([
    {
      scheme: VIDEO_PROTOCOL_SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: false, bypassCSP: false }
    }
  ])
}

// --- session/protocolo aislados de la ventana oculta -------------------------------------------------------------

interface ActiveServe { token: string; absolutePath: string; size: number; mimeType: string }
let activeServe: ActiveServe | null = null
let protocolHandlerRegistered = false

function videoWorkerSession(): Electron.Session {
  // Particion EN MEMORIA (sin "persist:") -- se recrea de cero cada vez que arranca la app, nunca guarda cookies/
  // cache/storage en disco. session.fromPartition() devuelve la MISMA instancia real para el mismo nombre.
  return electronSession.fromPartition(VIDEO_WORKER_PARTITION, { cache: false })
}

/** Lee EXACTAMENTE `length` bytes desde `start` -- Buffer directo (no un stream Node envuelto para Response): mas
 *  simple y sin ambiguedad de interop entre node:stream/web y el Response real de Electron. Un rango de video real
 *  pedido por un <video> nunca es todo el archivo de una sola vez, asi que cargarlo entero en memoria por pedido es
 *  aceptable (y mucho mas chico que decodificar el video completo, que es justamente lo que esto evita). */
function readRange(absolutePath: string, start: number, length: number): Buffer {
  const fd = openSync(absolutePath, 'r')
  try {
    const buffer = Buffer.alloc(length)
    readSync(fd, buffer, 0, length, start)
    return buffer
  } finally {
    closeSync(fd)
  }
}

/** Sirve DOS cosas bajo el MISMO origen (`amatista-video-frame://app`) a proposito -- el shell estatico
 *  (`/shell.html`) y el video activo (`/frame/<token>`) tienen que compartir origen: si el documento viene de un
 *  origen distinto al del <video> (ej. un `data:` URL para el shell + este protocolo para el video), Chromium
 *  marca el canvas como "tainted" y drawImage()/toDataURL() tiran SecurityError -- reproducido real en la
 *  verificacion (el motor primario fallaba SIEMPRE, enmascarado en silencio por el fallback a ffmpeg). Mismo host
 *  ("app") para ambos evita el problema de raiz, sin necesitar CORS.
 *  El video se sirve UNICAMENTE si la URL trae su token vigente -- nunca una ruta generica. Soporta Range real
 *  (bytes=) para que buscar en un archivo grande no lo cargue entero. */
function ensureProtocolHandler(): void {
  if (protocolHandlerRegistered) return
  protocolHandlerRegistered = true
  videoWorkerSession().protocol.handle(VIDEO_PROTOCOL_SCHEME, request => {
    try {
      const url = new URL(request.url)
      if (url.pathname === '/shell.html') {
        return new Response(SHELL_HTML, { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } })
      }
      const frameMatch = /^\/frame\/([^/]+)$/.exec(url.pathname)
      const token = frameMatch ? frameMatch[1] : ''
      if (!token || !activeServe || token !== activeServe.token) {
        return new Response('No autorizado para este token.', { status: 404 })
      }
      const { absolutePath, size, mimeType } = activeServe
      const range = request.headers.get('range')
      if (range) {
        const match = /^bytes=(\d+)-(\d*)$/.exec(range.trim())
        if (!match) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } })
        const start = Number(match[1])
        const end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1
        if (!(start <= end) || start >= size) {
          return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } })
        }
        const buffer = readRange(absolutePath, start, end - start + 1)
        return new Response(buffer, {
          status: 206,
          headers: {
            'Content-Type': mimeType,
            'Content-Range': `bytes ${start}-${end}/${size}`,
            'Content-Length': String(buffer.length),
            'Accept-Ranges': 'bytes'
          }
        })
      }
      const buffer = readRange(absolutePath, 0, size)
      return new Response(buffer, {
        status: 200,
        headers: { 'Content-Type': mimeType, 'Content-Length': String(size), 'Accept-Ranges': 'bytes' }
      })
    } catch (error) {
      return new Response(`Error sirviendo el video: ${error instanceof Error ? error.message : String(error)}`, { status: 500 })
    }
  })
}

// --- ventana oculta singleton, perezosa, con auto-destruccion por inactividad -------------------------------------

let hiddenWindow: BrowserWindow | null = null
let idleTimer: ReturnType<typeof setTimeout> | null = null

function scheduleIdleDestroy(): void {
  if (idleTimer) clearTimeout(idleTimer)
  idleTimer = setTimeout(() => {
    idleTimer = null
    if (hiddenWindow && !hiddenWindow.isDestroyed()) hiddenWindow.destroy()
    hiddenWindow = null
  }, VIDEO_WINDOW_IDLE_MS)
}

const SHELL_HTML = `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; media-src 'self'; style-src 'unsafe-inline'">
</head><body style="margin:0">
<video id="v" muted playsinline preload="metadata" style="display:none"></video>
<canvas id="c" style="display:none"></canvas>
</body></html>`

function ensureHiddenWindow(): BrowserWindow {
  if (hiddenWindow && !hiddenWindow.isDestroyed()) return hiddenWindow
  ensureProtocolHandler()
  const workerSession = videoWorkerSession()
  // Todos los permisos denegados -- en la session PROPIA de esta ventana, nunca la default (no debe afectar al
  // resto de la app real).
  workerSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false))
  workerSession.setPermissionCheckHandler(() => false)

  const win = new BrowserWindow({
    show: false,
    width: 64,
    height: 64,
    webPreferences: {
      session: workerSession,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      images: false
    }
  })
  win.webContents.on('will-navigate', event => event.preventDefault())
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('render-process-gone', () => {
    // El renderer se cayo (archivo malformado, etc.) -- nunca afecta a main. La proxima llamada crea una ventana
    // nueva desde cero; no hay nada que limpiar aca fuera de la referencia misma.
    hiddenWindow = null
  })
  win.loadURL(`${VIDEO_PROTOCOL_SCHEME}://app/shell.html`)
  hiddenWindow = win
  return win
}

/** Serializa el uso real de la ventana singleton -- mismo patron que withSettingsLock() (runtime-state.ts). */
let extractionQueue: Promise<unknown> = Promise.resolve()
function withVideoWindowLock<T>(task: () => Promise<T>): Promise<T> {
  const run = extractionQueue.then(task, task)
  extractionQueue = run.then(() => undefined, () => undefined)
  return run
}

// --- motor primario: Chromium ---------------------------------------------------------------------------------

type ChromiumFrameResult =
  | { ok: true; dataUrl: string; duration: number; width: number; height: number }
  | { ok: false; kind: 'timestamp-out-of-range'; duration: number }
  | { ok: false; kind: 'too-big' }
  | { ok: false; kind: 'decode-failed'; error: string }

function buildExtractionScript(token: string, seconds: number, capRaw: number): string {
  return `(async () => {
    const token = ${JSON.stringify(token)}
    const seconds = ${JSON.stringify(seconds)}
    const capRaw = ${JSON.stringify(capRaw)}
    const qualities = ${JSON.stringify(JPEG_QUALITIES)}
    const video = document.getElementById('v')
    const canvas = document.getElementById('c')
    video.src = ${JSON.stringify(VIDEO_PROTOCOL_SCHEME)} + '://app/frame/' + token
    try {
      await new Promise((resolve, reject) => {
        const onError = () => reject(new Error('decode-failed: ' + (video.error && video.error.message ? video.error.message : ('codigo ' + (video.error ? video.error.code : '?')))))
        video.addEventListener('error', onError, { once: true })
        video.addEventListener('loadedmetadata', () => { video.removeEventListener('error', onError); resolve(undefined) }, { once: true })
      })
    } catch (error) {
      return { ok: false, kind: 'decode-failed', error: String(error && error.message ? error.message : error) }
    }
    const duration = video.duration
    if (!isFinite(duration) || duration <= 0) {
      return { ok: false, kind: 'decode-failed', error: 'el video no reporto una duracion real (metadata invalida o codec no soportado).' }
    }
    if (seconds > duration) {
      return { ok: false, kind: 'timestamp-out-of-range', duration }
    }
    try {
      await new Promise((resolve, reject) => {
        const onError = () => reject(new Error('seek-failed'))
        video.addEventListener('error', onError, { once: true })
        video.addEventListener('seeked', () => { video.removeEventListener('error', onError); resolve(undefined) }, { once: true })
        video.currentTime = Math.min(seconds, Math.max(0, duration - 0.05))
      })
    } catch (error) {
      return { ok: false, kind: 'decode-failed', error: 'no se pudo buscar el timestamp pedido en el video.' }
    }
    const vw = video.videoWidth
    const vh = video.videoHeight
    if (!vw || !vh) return { ok: false, kind: 'decode-failed', error: 'el video no tiene dimensiones de video reales (puede ser solo audio).' }
    const scale = Math.min(1, ${EXTRACT_VIDEO_FRAME_MAX_LONG_SIDE} / Math.max(vw, vh))
    canvas.width = Math.max(1, Math.round(vw * scale))
    canvas.height = Math.max(1, Math.round(vh * scale))
    const ctx = canvas.getContext('2d')
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
    let chosen = null
    for (const q of qualities) {
      const url = canvas.toDataURL('image/jpeg', q)
      const b64Length = url.length - url.indexOf(',') - 1
      if (b64Length <= capRaw) { chosen = url; break }
    }
    if (!chosen) return { ok: false, kind: 'too-big' }
    return { ok: true, dataUrl: chosen, duration, width: vw, height: vh }
  })()`
}

async function extractFrameViaChromium(absPath: string, size: number, seconds: number, capRaw: number): Promise<ChromiumFrameResult> {
  const win = ensureHiddenWindow()
  const token = randomUUID()
  activeServe = { token, absolutePath: absPath, size, mimeType: mimeTypeForVideoExtension(absPath) }
  try {
    const script = buildExtractionScript(token, seconds, capRaw)
    const result = await raceTimeout(
      win.webContents.executeJavaScript(script, true) as Promise<ChromiumFrameResult>,
      CHROMIUM_EXTRACTION_TIMEOUT_MS,
      `El decodificador integrado no respondio en ${CHROMIUM_EXTRACTION_TIMEOUT_MS / 1000} segundos.`
    )
    return result
  } catch (error) {
    // Mismo patron que AMATISTA_DEBUG_TOOLS (tool-registry.ts) -- opt-in, silencioso por defecto. Encontro un bug
    // real durante la verificacion (canvas "tainted" por origenes distintos, ver ensureProtocolHandler()): sin
    // esto, el motor primario fallaba en silencio y el fallback a ffmpeg lo enmascaraba por completo.
    if (process.env.AMATISTA_VIDEO_FRAME_DEBUG === '1') console.error('[video-frame-reader] Chromium decode failed:', error)
    return { ok: false, kind: 'decode-failed', error: error instanceof Error ? error.message : String(error) }
  } finally {
    activeServe = null
    scheduleIdleDestroy()
  }
}

function raceTimeout<T>(promise: Promise<T>, timeoutMs: number, timeoutMessage: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(timeoutMessage)), timeoutMs)
    promise.then(
      value => { clearTimeout(timer); resolve(value) },
      error => { clearTimeout(timer); reject(error) }
    )
  })
}

// --- motor de respaldo: ffmpeg del PATH -----------------------------------------------------------------------

interface FfprobeInfo { durationSeconds: number; width: number; height: number }

function probeVideo(absPath: string): Promise<FfprobeInfo | null> {
  return new Promise(resolve => {
    execFile(
      'ffprobe',
      ['-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', absPath],
      { windowsHide: true, timeout: 15_000, maxBuffer: 10 * 1024 * 1024 },
      (error, stdout) => {
        if (error) { resolve(null); return }
        try {
          const parsed = JSON.parse(String(stdout)) as {
            format?: { duration?: string }
            streams?: Array<{ codec_type?: string; width?: number; height?: number; duration?: string }>
          }
          const videoStream = (parsed.streams ?? []).find(stream => stream.codec_type === 'video')
          const duration = Number(parsed.format?.duration ?? videoStream?.duration)
          if (!videoStream || !Number.isFinite(duration)) { resolve(null); return }
          resolve({ durationSeconds: duration, width: Number(videoStream.width) || 0, height: Number(videoStream.height) || 0 })
        } catch {
          resolve(null)
        }
      }
    )
  })
}

function ffmpegExtractFrame(absPath: string, seconds: number, outWidth: number, outHeight: number, quality: number): Promise<{ ok: true; buffer: Buffer } | { ok: false; error: string }> {
  return new Promise(resolve => {
    const args = [
      '-ss', String(seconds),
      '-i', absPath,
      '-frames:v', '1',
      '-vf', `scale=${outWidth}:${outHeight}`,
      '-q:v', String(quality),
      '-f', 'image2pipe',
      '-vcodec', 'mjpeg',
      'pipe:1'
    ]
    const child = spawn('ffmpeg', args, { windowsHide: true })
    const chunks: Buffer[] = []
    let stderr = ''
    let settled = false
    const settle = (result: { ok: true; buffer: Buffer } | { ok: false; error: string }): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(result)
    }
    const timer = setTimeout(() => {
      child.kill()
      settle({ ok: false, error: `ffmpeg no respondio en ${FFMPEG_EXTRACTION_TIMEOUT_MS / 1000} segundos.` })
    }, FFMPEG_EXTRACTION_TIMEOUT_MS)
    child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk))
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8') })
    child.on('error', error => settle({ ok: false, error: error.message }))
    child.on('close', code => {
      const buffer = Buffer.concat(chunks)
      if (code === 0 && buffer.length > 0) settle({ ok: true, buffer })
      else settle({ ok: false, error: stderr.trim() || `ffmpeg termino con codigo ${code} sin producir ningun frame.` })
    })
  })
}

async function extractFrameViaFfmpeg(absPath: string, displayPath: string, seconds: number, capRaw: number): Promise<{ ok: true; buffer: Buffer; duration: number; width: number; height: number } | { ok: false; error: string }> {
  const probe = await probeVideo(absPath)
  if (!probe) {
    return { ok: false, error: `ffprobe no pudo leer la duracion/resolucion de "${displayPath}": el archivo puede estar danado o no ser un video real.` }
  }
  if (seconds > probe.durationSeconds) {
    return { ok: false, error: `El timestamp ${formatTimestamp(seconds)} supera la duracion real del video "${displayPath}" (${formatTimestamp(probe.durationSeconds)}).` }
  }
  const longSide = Math.max(probe.width, probe.height, 1)
  const scale = Math.min(1, EXTRACT_VIDEO_FRAME_MAX_LONG_SIDE / longSide)
  // ffmpeg exige dimensiones pares para la mayoria de los pixel formats -- redondeo a par de forma defensiva.
  const outWidth = Math.max(2, Math.round((probe.width * scale) / 2) * 2)
  const outHeight = Math.max(2, Math.round((probe.height * scale) / 2) * 2)

  for (const quality of [3, 6, 12]) {
    const result = await ffmpegExtractFrame(absPath, seconds, outWidth, outHeight, quality)
    if (!result.ok) return result
    if (Math.ceil((result.buffer.length * 4) / 3) <= capRaw) {
      return { ok: true, buffer: result.buffer, duration: probe.durationSeconds, width: probe.width, height: probe.height }
    }
  }
  return { ok: false, error: `No se pudo generar el frame por debajo del limite de tamano de este proveedor, ni con calidad reducida.` }
}

// --- orquestador -----------------------------------------------------------------------------------------------

function buildResultText(displayPath: string, size: number, seconds: number, duration: number, fullWidth: number, fullHeight: number, outWidth: number, outHeight: number, encodedBytes: number, engine: 'Chromium integrado' | 'ffmpeg del sistema'): string {
  const lines: string[] = []
  lines.push(
    `Fotograma de "${displayPath}" en ${formatTimestamp(seconds)} (duracion total: ${formatTimestamp(duration)}), ${formatBytes(size)} en disco. ` +
    `Video ${fullWidth}x${fullHeight} px. Extraido con ${engine}.`
  )
  const resized = outWidth !== fullWidth || outHeight !== fullHeight
  lines.push(
    `Version preparada para vision: ${outWidth}x${outHeight} px, JPEG, ~${formatBytes(encodedBytes)}` +
    (resized ? ` (reducida: el lado largo maximo es ${EXTRACT_VIDEO_FRAME_MAX_LONG_SIDE} px)` : '') + '.'
  )
  lines.push('Es UN SOLO fotograma estatico de ese instante -- no el video completo ni el audio.')
  return lines.join('\n')
}

export async function extractVideoFrameForModel(absPath: string, displayPath: string, options: ExtractVideoFrameOptions = {}): Promise<ExtractVideoFrameOutcome> {
  const size = statSync(absPath).size
  if (size > EXTRACT_VIDEO_FRAME_MAX_FILE_BYTES) {
    return fail(`El video "${displayPath}" pesa ${formatBytes(size)} y supera el limite de ${formatBytes(EXTRACT_VIDEO_FRAME_MAX_FILE_BYTES)} de extract_video_frame.`)
  }
  const parsedTs = parseTimestamp(options.timestamp)
  if (!parsedTs.ok) return fail(parsedTs.error)
  const seconds = parsedTs.seconds

  const capRaw = Math.floor((Math.min(options.maxEncodedBytes ?? DEFAULT_MAX_ENCODED_BYTES, DEFAULT_MAX_ENCODED_BYTES) * 3) / 4)

  const chromiumResult = await withVideoWindowLock(() => extractFrameViaChromium(absPath, size, seconds, capRaw))
  if (process.env.AMATISTA_VIDEO_FRAME_DEBUG === '1') {
    console.error('[video-frame-reader] chromiumResult:', JSON.stringify(chromiumResult).slice(0, 300))
  }
  if (chromiumResult.ok) {
    const base64 = chromiumResult.dataUrl.slice(chromiumResult.dataUrl.indexOf(',') + 1)
    const scale = Math.min(1, EXTRACT_VIDEO_FRAME_MAX_LONG_SIDE / Math.max(chromiumResult.width, chromiumResult.height))
    const outWidth = Math.max(1, Math.round(chromiumResult.width * scale))
    const outHeight = Math.max(1, Math.round(chromiumResult.height * scale))
    const text = buildResultText(displayPath, size, seconds, chromiumResult.duration, chromiumResult.width, chromiumResult.height, outWidth, outHeight, Math.ceil((base64.length * 3) / 4), 'Chromium integrado')
    return { ok: true, text, imageDataUrl: chromiumResult.dataUrl }
  }
  if (chromiumResult.kind === 'timestamp-out-of-range') {
    return fail(`El timestamp ${formatTimestamp(seconds)} supera la duracion real del video "${displayPath}" (${formatTimestamp(chromiumResult.duration)}).`)
  }
  if (chromiumResult.kind === 'too-big') {
    return fail(`No se pudo recodificar el fotograma de "${displayPath}" por debajo del limite de tamano de este proveedor, ni con calidad reducida.`)
  }

  // Chromium no pudo decodificar este formato/codec -- intentar ffmpeg si esta disponible en el PATH.
  const ffmpeg = await detectFfmpeg()
  if (!ffmpeg.installed) {
    return fail(
      `El decodificador integrado no pudo abrir "${displayPath}" (${chromiumResult.error}) y ffmpeg no esta instalado en esta maquina. ` +
      'Instala ffmpeg (por ejemplo "winget install Gyan.FFmpeg" en Windows) y Amatista lo va a usar como respaldo para este formato.'
    )
  }
  const ffmpegResult = await extractFrameViaFfmpeg(absPath, displayPath, seconds, capRaw)
  if (!ffmpegResult.ok) return fail(ffmpegResult.error)
  const scale = Math.min(1, EXTRACT_VIDEO_FRAME_MAX_LONG_SIDE / Math.max(ffmpegResult.width, ffmpegResult.height, 1))
  const outWidth = Math.max(1, Math.round(ffmpegResult.width * scale))
  const outHeight = Math.max(1, Math.round(ffmpegResult.height * scale))
  const text = buildResultText(displayPath, size, seconds, ffmpegResult.duration, ffmpegResult.width, ffmpegResult.height, outWidth, outHeight, ffmpegResult.buffer.length, 'ffmpeg del sistema')
  return { ok: true, text, imageDataUrl: `data:image/jpeg;base64,${ffmpegResult.buffer.toString('base64')}` }
}
