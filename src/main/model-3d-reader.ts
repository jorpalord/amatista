// Tool render_3d_model (F3 de docs/_arch/verify_native_multimodal_tools_design.md, §2.4 y §3): renderiza un
// modelo 3D ya confinado al workspace (la confinacion la hace quien llama, ver tool-registry.ts) y lo prepara para
// que un modelo con vision lo VEA. Motor UNICO (a diferencia de F2, aca no hay respaldo -- three.js es el unico
// camino real, sin dependencia externa que pueda faltar): three.js real en una BrowserWindow oculta singleton,
// bundle standalone via esbuild (ver package.json, script "model3d:bundle", y model-3d-viewer-bundle.js) -- 623KB/
// 162KB gzip medidos en la investigacion, probado con GPU/sin GPU/SwiftShader sin flags especiales.
//
// Mismo aislamiento de la ventana oculta que F2 (video-frame-reader.ts) -- session propia en memoria, sandbox+
// contextIsolation sin preload, sin navegacion/ventanas nuevas, render-process-gone tratado como fallo de esta
// llamada. UNICA diferencia real de arquitectura respecto a F2: shell/bundle.js/modelo se sirven los 3 bajo el
// MISMO origen (`amatista-3d-model://app/...`) DESDE EL DISEÑO INICIAL -- leccion real de F2 (canvas "tainted" por
// origenes distintos entre el shell y el archivo servido) aplicada de entrada, no descubierta tarde: aunque el
// riesgo concreto de three.js es mas acotado que el de un <video> (las texturas EMBEBIDAS de un GLB salen del
// mismo buffer ya fetcheado, nunca de una request aparte), same-origin para los 3 recursos elimina cualquier duda
// sin depender de ese razonamiento caso por caso.
//
// Formato por EXTENSION (no por bytes magicos como read_image): OBJ es texto arbitrario, STL puede ser ASCII o
// binario, glTF es JSON -- no hay un sniff barato y universal como con imagenes. v1: OBJ/STL/GLB/glTF
// AUTOCONTENIDO (sin recursos externos, decision ya tomada en la investigacion) -- un glTF con URIs externas
// simplemente falla al cargar esas URIs contra ESTE MISMO protocolo (que solo sirve el UNICO archivo activo, nunca
// una ruta generica), fallo honesto, jamas un escape real: no hace falta un chequeo aparte para excluirlo.
import { BrowserWindow, session as electronSession, protocol, app } from 'electron'
import { closeSync, existsSync, openSync, readSync, statSync } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

export const MODEL_3D_MAX_FILE_BYTES = 200 * 1024 * 1024
const DEFAULT_MAX_ENCODED_BYTES = 5 * 1024 * 1024
const MODEL_3D_PROTOCOL_SCHEME = 'amatista-3d-model'
const MODEL_3D_WORKER_PARTITION = 'model-3d-worker'
const MODEL_3D_WINDOW_IDLE_MS = Number(process.env.AMATISTA_MODEL_3D_IDLE_MS) || 60_000
const RENDER_TIMEOUT_MS = Number(process.env.AMATISTA_MODEL_3D_RENDER_TIMEOUT_MS) || 30_000

export type Model3DFormat = 'obj' | 'stl' | 'gltf' | 'glb'

export interface RenderModel3DOptions {
  maxEncodedBytes?: number
}
export type RenderModel3DOutcome = { ok: true; text: string; imageDataUrl: string } | { ok: false; error: string }

const fail = (error: string): RenderModel3DOutcome => ({ ok: false, error })

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function formatDetectedFormat(absPath: string): Model3DFormat | null {
  switch (path.extname(absPath).toLowerCase()) {
    case '.obj': return 'obj'
    case '.stl': return 'stl'
    case '.gltf': return 'gltf'
    case '.glb': return 'glb'
    default: return null
  }
}

function mimeTypeForModelExtension(format: Model3DFormat): string {
  switch (format) {
    case 'obj': return 'text/plain'
    case 'stl': return 'application/sla'
    case 'gltf': return 'model/gltf+json'
    case 'glb': return 'model/gltf-binary'
  }
}

// --- registro del esquema privilegiado (DEBE correr antes de app.ready -- ver index.ts) -------------------------

let schemeRegistered = false
export function registerModel3DProtocolScheme(): void {
  if (schemeRegistered) return
  schemeRegistered = true
  protocol.registerSchemesAsPrivileged([
    {
      scheme: MODEL_3D_PROTOCOL_SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: false, bypassCSP: false }
    }
  ])
}

// --- session/protocolo aislados de la ventana oculta -------------------------------------------------------------

interface ActiveServe { token: string; absolutePath: string; size: number; mimeType: string }
let activeServe: ActiveServe | null = null
let protocolHandlerRegistered = false
/** Bundle de three.js leido UNA vez y cacheado en memoria -- no cambia entre llamadas, releerlo del disco en cada
 *  render seria trabajo repetido sin ningun beneficio real. */
let cachedBundleJs: Buffer | null = null

function model3DWorkerSession(): Electron.Session {
  // Particion EN MEMORIA (sin "persist:") -- mismo criterio que video-frame-reader.ts: se recrea de cero cada vez
  // que arranca la app, nunca guarda cookies/cache/storage en disco.
  return electronSession.fromPartition(MODEL_3D_WORKER_PARTITION, { cache: false })
}

function readWholeFile(absolutePath: string, size: number): Buffer {
  const fd = openSync(absolutePath, 'r')
  try {
    const buffer = Buffer.alloc(size)
    readSync(fd, buffer, 0, size, 0)
    return buffer
  } finally {
    closeSync(fd)
  }
}

/** Ruta real del bundle de three.js -- mismo patron exacto que mcpLspServerScriptPath() (cli-agent-runtime.ts):
 *  `out/main/model-3d-viewer-bundle.js`, generado por esbuild (package.json, script "model3d:bundle"), leido con
 *  fs (nunca spawneado, asi que a diferencia de mcp-lsp-server.cjs NO necesita asarUnpack -- Electron ya resuelve
 *  fs.readFileSync() de forma transparente dentro del asar). `null` si el archivo no existe (dev sin correr el
 *  bundle todavia) -- el llamador lo trata como "render_3d_model no disponible este turno", nunca un crash. */
function model3DBundlePath(): string | null {
  const entry = path.join(app.getAppPath(), 'out', 'main', 'model-3d-viewer-bundle.js')
  return existsSync(entry) ? entry : null
}

/** Sirve 3 cosas bajo el MISMO origen (`amatista-3d-model://app`) a proposito, desde el diseño inicial (leccion
 *  real de F2, ver el comentario de cabecera): el shell estatico (`/shell.html`), el bundle de three.js
 *  (`/bundle.js`) y el modelo activo (`/model/<token>`). El modelo se sirve UNICAMENTE si la URL trae su token
 *  vigente -- nunca una ruta generica. Sin soporte de Range (a diferencia de F2): los loaders de three.js hacen UN
 *  solo fetch completo del archivo, nunca busquedas parciales -- los modelos 3D tampoco son tan grandes como un
 *  video real (tope de 200MB, ver MODEL_3D_MAX_FILE_BYTES). */
function ensureProtocolHandler(): void {
  if (protocolHandlerRegistered) return
  protocolHandlerRegistered = true
  model3DWorkerSession().protocol.handle(MODEL_3D_PROTOCOL_SCHEME, request => {
    try {
      const url = new URL(request.url)
      if (url.pathname === '/shell.html') {
        return new Response(SHELL_HTML, { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } })
      }
      if (url.pathname === '/bundle.js') {
        if (!cachedBundleJs) {
          const bundlePath = model3DBundlePath()
          if (!bundlePath) return new Response('render_3d_model no esta disponible (bundle no generado).', { status: 404 })
          cachedBundleJs = readWholeFile(bundlePath, statSync(bundlePath).size)
        }
        return new Response(cachedBundleJs, { status: 200, headers: { 'Content-Type': 'application/javascript; charset=utf-8' } })
      }
      const modelMatch = /^\/model\/([^/]+)$/.exec(url.pathname)
      const token = modelMatch ? modelMatch[1] : ''
      if (!token || !activeServe || token !== activeServe.token) {
        return new Response('No autorizado para este token.', { status: 404 })
      }
      const { absolutePath, size, mimeType } = activeServe
      const buffer = readWholeFile(absolutePath, size)
      return new Response(buffer, { status: 200, headers: { 'Content-Type': mimeType, 'Content-Length': String(size) } })
    } catch (error) {
      return new Response(`Error sirviendo el recurso: ${error instanceof Error ? error.message : String(error)}`, { status: 500 })
    }
  })
}

// --- ventana oculta singleton, perezosa, con auto-destruccion por inactividad -------------------------------------

let hiddenWindow: BrowserWindow | null = null
let idleTimer: ReturnType<typeof setTimeout> | null = null

function destroyHiddenWindow(): void {
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = null }
  if (hiddenWindow && !hiddenWindow.isDestroyed()) hiddenWindow.destroy()
  hiddenWindow = null
}

function scheduleIdleDestroy(): void {
  if (idleTimer) clearTimeout(idleTimer)
  idleTimer = setTimeout(destroyHiddenWindow, MODEL_3D_WINDOW_IDLE_MS)
}

const SHELL_HTML = `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self'; connect-src 'self'; img-src 'self' data:">
</head><body style="margin:0"><script src="${MODEL_3D_PROTOCOL_SCHEME}://app/bundle.js"></script></body></html>`

function ensureHiddenWindow(): BrowserWindow {
  if (hiddenWindow && !hiddenWindow.isDestroyed()) return hiddenWindow
  ensureProtocolHandler()
  const workerSession = model3DWorkerSession()
  // Todos los permisos denegados -- en la session PROPIA de esta ventana, nunca la default.
  workerSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false))
  workerSession.setPermissionCheckHandler(() => false)

  const win = new BrowserWindow({
    show: false,
    width: 900,
    height: 675,
    webPreferences: {
      session: workerSession,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true
    }
  })
  win.webContents.on('will-navigate', event => event.preventDefault())
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('render-process-gone', () => {
    // El renderer se cayo (modelo malformado, WebGL context lost, etc.) -- nunca afecta a main. La proxima
    // llamada crea una ventana nueva desde cero.
    hiddenWindow = null
  })
  win.loadURL(`${MODEL_3D_PROTOCOL_SCHEME}://app/shell.html`)
  hiddenWindow = win
  return win
}

/** Serializa el uso real de la ventana singleton -- mismo patron que withSettingsLock()/withVideoWindowLock(). */
let renderQueue: Promise<unknown> = Promise.resolve()
function withModel3DWindowLock<T>(task: () => Promise<T>): Promise<T> {
  const run = renderQueue.then(task, task)
  renderQueue = run.then(() => undefined, () => undefined)
  return run
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

type RenderScriptResult =
  | { ok: true; dataUrl: string; triangles: number; dimensions: { x: number; y: number; z: number }; outWidth: number; outHeight: number }
  | { ok: false; kind: 'unsupported-format' | 'load-failed' | 'too-complex' | 'too-big'; error: string }

async function renderViaThreeJs(absPath: string, size: number, format: Model3DFormat, mimeType: string, capRaw: number): Promise<RenderScriptResult> {
  const win = ensureHiddenWindow()
  const token = randomUUID()
  activeServe = { token, absolutePath: absPath, size, mimeType }
  try {
    const script = `window.__amatistaRenderModel(${JSON.stringify(`${MODEL_3D_PROTOCOL_SCHEME}://app/model/${token}`)}, ${JSON.stringify(format)}, { capRaw: ${JSON.stringify(capRaw)} })`
    return await raceTimeout(
      win.webContents.executeJavaScript(script, true) as Promise<RenderScriptResult>,
      RENDER_TIMEOUT_MS,
      `El renderizador 3D no respondio en ${RENDER_TIMEOUT_MS / 1000} segundos.`
    )
  } catch (error) {
    // Timeout REAL con destruccion de la ventana (docs/_arch/verify_native_multimodal_tools_design.md S2.4:
    // "timeout 30s con destruccion de la ventana") -- a diferencia de F2, un script de render que se cuelga de
    // verdad (bucle infinito parseando un archivo malformado) nunca termina solo: si solo dejamos de ESPERARLO,
    // la ventana sigue viva y ocupada para siempre, y la proxima llamada real se encola detras de un renderer
    // que nunca va a liberarse. Destruirla fuerza una ventana nueva y limpia en el proximo uso.
    destroyHiddenWindow()
    return { ok: false, kind: 'load-failed', error: error instanceof Error ? error.message : String(error) }
  } finally {
    activeServe = null
    scheduleIdleDestroy()
  }
}

function buildResultText(displayPath: string, size: number, format: Model3DFormat, triangles: number, dimensions: { x: number; y: number; z: number }, outWidth: number, outHeight: number, encodedBytes: number): string {
  const dim = (n: number): string => (Number.isFinite(n) ? n.toFixed(2) : '?')
  return [
    `Render de "${displayPath}" (${format.toUpperCase()}, ${formatBytes(size)} en disco): ${triangles.toLocaleString('es')} triangulos, ` +
      `caja envolvente ${dim(dimensions.x)} x ${dim(dimensions.y)} x ${dim(dimensions.z)} unidades del modelo (sin unidad real conocida -- depende del archivo).`,
    `Version preparada para vision: ${outWidth}x${outHeight} px, JPEG, ~${formatBytes(encodedBytes)}. Una sola vista (angulo 3/4, encuadrada automaticamente segun la caja envolvente real).`,
    'Es una IMAGEN RENDERIZADA del modelo 3D, no el modelo original -- si necesitas los datos exactos (vertices, materiales), lee el archivo con read_file.'
  ].join('\n')
}

export async function renderModel3DForModel(absPath: string, displayPath: string, options: RenderModel3DOptions = {}): Promise<RenderModel3DOutcome> {
  const format = formatDetectedFormat(absPath)
  if (!format) {
    return fail(`render_3d_model no soporta la extension de "${displayPath}". Formatos aceptados: OBJ, STL, GLB, GLTF (autocontenido, sin recursos externos).`)
  }
  const size = statSync(absPath).size
  if (size > MODEL_3D_MAX_FILE_BYTES) {
    return fail(`El modelo "${displayPath}" pesa ${formatBytes(size)} y supera el limite de ${formatBytes(MODEL_3D_MAX_FILE_BYTES)} de render_3d_model.`)
  }
  if (!model3DBundlePath()) {
    return fail('render_3d_model no esta disponible todavia: el bundle de three.js no se genero (falta correr "npm run model3d:bundle" / "npm run build").')
  }

  const capRaw = Math.floor((Math.min(options.maxEncodedBytes ?? DEFAULT_MAX_ENCODED_BYTES, DEFAULT_MAX_ENCODED_BYTES) * 3) / 4)
  const result = await withModel3DWindowLock(() => renderViaThreeJs(absPath, size, format, mimeTypeForModelExtension(format), capRaw))

  if (!result.ok) {
    if (result.kind === 'unsupported-format') return fail(result.error)
    if (result.kind === 'too-complex') return fail(result.error)
    if (result.kind === 'too-big') return fail(result.error)
    return fail(`No se pudo renderizar "${displayPath}": ${result.error}`)
  }

  const text = buildResultText(displayPath, size, format, result.triangles, result.dimensions, result.outWidth, result.outHeight, Math.ceil((result.dataUrl.length - result.dataUrl.indexOf(',') - 1) * 3 / 4))
  return { ok: true, text, imageDataUrl: result.dataUrl }
}
