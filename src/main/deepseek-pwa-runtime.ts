// DeepSeek via PWA -- runtime EXPERIMENTAL (rama experiment/deepseek-pwa, docs/_experiments/deepseek-pwa/CONTRACT.md).
// Riesgo real de violar los ToS de DeepSeek (seccion 3.5(3)), decision consciente del usuario; solo se conecta con
// settings.deepseekPwaAcknowledged (guard en connectSessionForWindow, ipc-agent.ts).
//
// Modulo HOJA a proposito (mismo criterio que embedded-browser.ts): nunca importa runtime-state.ts/ipc-agent.ts;
// la ventana host y los avisos al panel se inyectan por parametro. Diseno confirmado con pruebas reales:
//   - La vista VIVE CON LA SESION (mismo ciclo que el navegador embebido): una WebContentsView por chat conectado,
//     creada en connect(), destruida en stop(). Oculta por defecto; el panel la muestra en su propio rectangulo con
//     "Ver DeepSeek" (y sola cuando hace falta login/captcha). Sin pool propio: el tope real es
//     MAX_CONCURRENT_SESSIONS de F0 (runtime-state.ts), comun a todos los runtimes.
//   - ESCRIBIR por DOM (textarea + boton + toggles), LEER por red (stream de /api/v0/chat/completion via
//     webContents.debugger) -- funciona igual con la vista visible u oculta (oculta, React no pinta el DOM).
//   - Toggles por POSICION (1o = razonamiento, 2o = busqueda) validados contra etiquetas conocidas: el idioma de la
//     PWA cambia solo entre sesiones (confirmado real).
//   - Login/captcha: los resuelve el USUARIO en el panel real. Nunca se intenta resolver solo. CERO reintentos
//     automaticos de envio.
// Privacidad: del debugger solo se usan url + status de la respuesta de completion y su cuerpo (contenido generado).
// Nunca se leen cookies, headers ni tokens.
import { app, BrowserWindow, session as electronSession, WebContentsView } from 'electron'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { DeepSeekStreamParser, type DeepSeekStreamEvent, type DeepSeekTurnOutcome } from './deepseek-pwa-stream'
// Tool-calling por TEXTO (docs/_experiments/deepseek-pwa-tools/CONTRACT.md, "Investigacion: tool-calling
// por TEXTO...", medido real: 8/8 tareas, 15/15 llamadas en el formato exacto pedido, 0 desvios). Import
// SEGURO -- tool-registry.ts nunca importa este archivo (grep confirmado), asi que no hay ciclo. Solo se
// importa `TOOL_DEFINITIONS` (catalogo estatico de nombre/descripcion/parametros) para construir el texto
// de instrucciones -- la EJECUCION real de las tools sigue viviendo del lado de ipc-agent.ts (mismo
// toolRegistry.execute()/resolveApproval()/sandbox que ya usan los demas runtimes, cero atajos).
import { TOOL_DEFINITIONS, type ToolDefinition } from './tool-registry'

const PARTITION = 'persist:deepseek-pwa'
const ORIGIN = 'https://chat.deepseek.com'

// Correccion de alcance (docs/_experiments/deepseek-pwa-tools/CONTRACT.md, "Correccion de alcance: catalogo
// completo"): las 3 listas de abajo son el MISMO filtro de visibilidad que ApiAgentRuntime.toolCatalog()
// (api-agent-runtime.ts) ya aplica para los runtimes API -- copiadas literal, no reinventadas -- para no
// ofrecerle a DeepSeek una tool que de todos modos fallaria (orquestador fuera del chat principal, busqueda
// web sin Tavily configurado, exit_plan_mode fuera de modo plan). A diferencia de ese filtro, este NO oculta
// Familia A (computer use)/Familia B (close_app/lock_screen/power)/navegador embebido -- mismo criterio
// exacto ya establecido ahi: esas tools quedan SIEMPRE visibles en el catalogo, la seguridad real se aplica
// en EJECUCION (ctx.hardConfirm/ctx.computerUseActive/ctx.browserControlActive, armados en ipc-agent.ts),
// nunca ocultando su existencia.
const ORCHESTRATOR_TOOL_NAMES = ['send_to_window', 'list_windows', 'parallel_ask']
const WEB_SEARCH_TOOL_NAMES = ['web_search', 'web_fetch']
const PLAN_MODE_TOOL_NAMES = ['exit_plan_mode']

/** Primera oracion de una descripcion real de TOOL_DEFINITIONS (recortada a MAX_LEN si esa oracion sola ya
 *  es larga) -- las descripciones completas estan escritas para un schema nativo que un modelo lee una sola
 *  vez por conexion, no para texto plano inyectado en CADA conversacion nueva de este puente. Nunca se
 *  inventa texto nuevo: siempre un prefijo real y honesto de la descripcion real. */
function compactDescription(description: string, maxLen = 160): string {
  const firstSentence = description.split(/(?<=[.!?])\s+/)[0] ?? description
  const base = firstSentence.length <= maxLen ? firstSentence : `${firstSentence.slice(0, maxLen - 1)}…`
  return base.trim()
}

export interface ToolProtocolCatalogOptions {
  isPrincipalChat: boolean
  hasWebSearchIntegration: boolean
  planModeActive: boolean
  /** Herramientas compuestas aprobadas del workspace ("composed__<name>", composed-tools.ts). Solo viajan en el
   *  PRIMER mensaje de una conversacion nueva -- una receta aprobada a mitad de conversacion igual se puede llamar
   *  por nombre (execute() la despacha por prefijo), pero no aparece en esta lista hasta la proxima conversacion. */
  extraDefinitions?: ToolDefinition[]
}

/**
 * Tool-calling por TEXTO: como la PWA no expone function calling nativo a Amatista, se le "ensena" un
 * protocolo por texto plano en el primer mensaje de cada conversacion nueva -- mismo formato ya medido real
 * (100% de aciertos, 0 desvios). Reusa las descripciones REALES de `TOOL_DEFINITIONS` (tool-registry.ts)
 * para TODAS las tools del catalogo -- nunca duplicadas a mano, quedan sincronizadas solas si esas
 * descripciones cambian. Formato compacto (una linea por tool, primera oracion de la descripcion real) a
 * proposito: el catalogo completo tiene ~50 tools con descripciones largas (algunas de varios parrafos,
 * pensadas para un schema nativo) -- inyectar eso entero en CADA conversacion nueva infla el contexto sin
 * necesidad real. Incluye Familia A (computer use)/Familia B (close_app/lock_screen/power)/navegador
 * embebido SIEMPRE que existan en TOOL_DEFINITIONS (mismo criterio que toolCatalog() del camino API: no se
 * ocultan por estado de sesion) -- su seguridad real se aplica en EJECUCION del lado de ipc-agent.ts
 * (ctx.hardConfirm/ctx.computerUseActive/ctx.browserControlActive), nunca ocultando su existencia aca.
 */
export function buildToolProtocolInstructions(options: ToolProtocolCatalogOptions): string {
  const hideOrchestrator = !options.isPrincipalChat
  const hideWebSearch = !options.hasWebSearchIntegration
  const hidePlanMode = !options.planModeActive

  const lines = [...TOOL_DEFINITIONS.filter(def =>
    !(hideOrchestrator && ORCHESTRATOR_TOOL_NAMES.includes(def.name)) &&
    !(hideWebSearch && WEB_SEARCH_TOOL_NAMES.includes(def.name)) &&
    !(hidePlanMode && PLAN_MODE_TOOL_NAMES.includes(def.name))
  ), ...(options.extraDefinitions ?? [])].map(def => {
    const params = Object.keys(def.parameters.properties).join(', ')
    return `- ${def.name}(${params}): ${compactDescription(def.description)}`
  })

  return `Antes de responder, tene en cuenta esto: para esta conversacion tenes acceso real a un conjunto de herramientas (archivos, comandos, sistema, navegador, etc.) a traves de un protocolo de texto simple (esto NO es una funcionalidad nativa tuya, es algo que esta conversacion simula). Las descripciones de abajo son un resumen corto de cada una -- si el nombre y el resumen no alcanzan para saber que parametros mandar, pedi la que te parezca mas razonable con los datos que tengas.

Herramientas reales disponibles:
${lines.join('\n')}

Para usar UNA herramienta, tu respuesta COMPLETA tiene que ser EXACTAMENTE esta linea, sin nada de texto antes ni despues:

TOOL_CALL: nombre_de_la_herramienta(parametro1="valor1", parametro2="valor2")

Yo ejecuto la herramienta de verdad y te mando el resultado real en mi proximo mensaje, con este formato:

TOOL_RESULT: <resultado>

Ahi seguis, pidiendo otra herramienta si hace falta, o dando tu respuesta final si ya tenes todo lo que necesitas. Cuando ya no necesites ninguna herramienta mas, responde normal, en texto libre, SIN ningun TOOL_CALL. Algunas herramientas (por ejemplo cerrar aplicaciones, bloquear la pantalla, apagar/reiniciar, o controlar el mouse/teclado/navegador) le piden confirmacion real al usuario antes de ejecutarse de verdad -- si el usuario la rechaza, te lo digo como resultado y segui sin insistir.`
}

export interface ParsedTextToolCall {
  name: string
  args: Record<string, string>
  /** true si la respuesta de DeepSeek fue EXACTAMENTE la linea TOOL_CALL, sin nada mas alrededor --
   *  medido real: 100% de los casos observados. Informativo, no cambia el comportamiento real. */
  isCleanFormat: boolean
}

const TOOL_CALL_RE = /TOOL_CALL:\s*(\w+)\(([\s\S]*?)\)/
const TOOL_CALL_ARG_RE = /(\w+)\s*=\s*"((?:[^"\\]|\\.)*)"/g

/** Desescapa `\"`, `\\`, `\n`, `\t` -- hallazgo real de la investigacion de confiabilidad: sin desescapar
 *  `\n`, un `write_file` con `content="linea1\nlinea2"` terminaba con los 2 caracteres literales `\` `n`
 *  en el archivo real en vez de un salto de linea real. */
function unescapeToolArg(value: string): string {
  return value
    .replace(/\\n/g, '\n')
    .replace(/\\t/g, '\t')
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, '\\')
}

/** Parser tolerante (busca el patron en CUALQUIER parte del texto, no exige que sea la respuesta
 *  completa) -- medido real que DeepSeek respeta el formato exacto pedido, pero un parser de produccion
 *  tiene que sobrevivir al dia en que no lo haga. null = no se reconocio ningun TOOL_CALL real (la
 *  respuesta se trata como la respuesta final del turno). */
export function parseTextToolCall(responseText: string): ParsedTextToolCall | null {
  const match = TOOL_CALL_RE.exec(responseText)
  if (!match) return null
  const name = match[1]
  const args: Record<string, string> = {}
  let argMatch: RegExpExecArray | null
  TOOL_CALL_ARG_RE.lastIndex = 0
  while ((argMatch = TOOL_CALL_ARG_RE.exec(match[2]))) args[argMatch[1]] = unescapeToolArg(argMatch[2])
  return { name, args, isCleanFormat: responseText.trim() === match[0].trim() }
}
const DEBUG = process.env.AMATISTA_DEBUG_TOOLS === '1'
/** Solo verificacion (inerte si no esta seteada): 'unrecognized-stream' reemplaza el cuerpo real del stream por
 *  uno de formato desconocido; 'http-500' reemplaza el status HTTP real. Mismo patron opt-in que
 *  AMATISTA_MAIN_BACKSTOP_MS/AMATISTA_MCP_PIPE. */
const SIMULATE = process.env.AMATISTA_DEEPSEEK_PWA_SIMULATE?.trim() || ''
/** Solo mantenimiento del parser: si esta seteada, cada stream crudo se guarda ahi (fixtures de contrato). */
const DUMP_DIR = process.env.AMATISTA_DEEPSEEK_PWA_DUMP_DIR?.trim() || ''

function envMs(name: string, fallback: number): number {
  const value = Number(process.env[name])
  return Number.isFinite(value) && value > 0 ? value : fallback
}
const INACTIVITY_MS = envMs('AMATISTA_DEEPSEEK_PWA_INACTIVITY_MS', 90_000)
const HUMAN_TIMEOUT_MS = envMs('AMATISTA_DEEPSEEK_PWA_HUMAN_TIMEOUT_MS', 5 * 60_000)
const START_TIMEOUT_MS = 15_000
const READY_TIMEOUT_MS = 30_000

const log = (...args: unknown[]): void => { if (DEBUG) console.log('[deepseek-pwa]', ...args) }
const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

// ---------------------------------------------------------------------------------------------------------------
// Helpers inyectados en la pagina (idempotente). Solo DOM de escritura/estado -- la lectura de respuestas es por red.
const PAGE_HELPERS = `(() => {
  if (window.__amatistaDs) return true
  const KNOWN = [/^(DeepThink|Pensamiento Profundo|Pensamiento profundo|深度思考|Réflexion approfondie|Tiefes Denken)$/i,
                 /^(Search|Búsqueda inteligente|Búsqueda|联网搜索|智能搜索|Recherche|Suche)$/i]
  window.__amatistaDs = {
    box() { let b = document.querySelector('textarea'); for (let i = 0; i < 5 && b && b.parentElement; i++) b = b.parentElement; return b },
    btn() { return this.box()?.querySelector('.ds-button--primary.ds-button--circle') ?? null },
    icon() { const d = this.btn()?.querySelector('svg path')?.getAttribute('d') || ''; return d.startsWith('M8.3125') ? 'send' : d.startsWith('M2 4.88') ? 'stop' : d.startsWith('M34,18') ? 'spinner' : 'other' },
    toggles() { return [...document.querySelectorAll('.ds-toggle-button')] },
    // textContent, NO innerText: innerText depende del layout renderizado y en una vista oculta desde el inicio
    // devuelve "" (bug real encontrado en la verificacion: etiquetas ["",""] tras reconectar).
    labelAt(i) { return this.toggles()[i]?.textContent.trim() ?? null },
    toggleAt(i) { const t = this.toggles()[i]; return t && KNOWN[i].test(t.textContent.trim()) ? t : null },
    isOnAt(i) { const t = this.toggleAt(i); return t ? t.classList.contains('ds-toggle-button--selected') : null },
    setToggleAt(i, on) { const t = this.toggleAt(i); if (!t) return 'missing'; if (t.classList.contains('ds-toggle-button--selected') !== on) t.click(); return 'ok' },
    type(text) { const ta = document.querySelector('textarea'); if (!ta) return false; Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(ta, text); ta.dispatchEvent(new Event('input', { bubbles: true })); return true },
    btnDisabled() { const b = this.btn(); return !b || b.classList.contains('ds-button--disabled') },
    send() { const b = this.btn(); if (!b || b.classList.contains('ds-button--disabled')) return false; b.click(); return true },
    stop() { if (this.icon() !== 'stop') return false; this.btn().click(); return true },
    state() {
      const hasTextarea = !!document.querySelector('textarea')
      const signIn = location.pathname.includes('sign_in')
      // Solo evidencia FUERTE: un iframe real de hCaptcha. Bug real encontrado en la verificacion: una heuristica
      // "script awswaf presente y sin textarea" daba falso positivo durante la carga inicial (el script de AWS WAF
      // esta en TODAS las paginas de DeepSeek, y el textarea aparece recien despues) -- se retiro.
      const captcha = !!document.querySelector('iframe[src*="hcaptcha.com"]')
      return { path: location.pathname, hasTextarea, signIn, captcha }
    }
  }
  return true
})()`

interface PageState { path: string; hasTextarea: boolean; signIn: boolean; captcha: boolean }

// ---------------------------------------------------------------------------------------------------------------
// Captura del stream de completion via CDP.
interface ActiveStream {
  requestId: string
  httpStatus: number | null
  parser: DeepSeekStreamParser
  decoder: TextDecoder
  startedAt: number
  lastDataAt: number
  chunks: number
  ended: boolean
  networkError: string | null
  raw: string
  onEvents: ((events: DeepSeekStreamEvent[]) => void) | null
  backlog: DeepSeekStreamEvent[]
  endWaiters: Array<() => void>
}

class StreamCapture {
  private current: ActiveStream | null = null
  private waiter: ((stream: ActiveStream) => void) | null = null

  constructor(private readonly view: WebContentsView) {
    const dbg = view.webContents.debugger
    dbg.attach('1.3')
    // NO se espera: sobre un webContents sin pagina cargada, Network.enable no responde nunca (bug real del
    // harness de la investigacion). Queda habilitado igual en cuanto carga.
    dbg.sendCommand('Network.enable').catch(() => {})
    dbg.on('message', (_event, method, params) => { void this.onMessage(method, params as Record<string, unknown>) })
  }

  /** Espera la PROXIMA request de completion (la que dispara el click en enviar). null si no aparece a tiempo. */
  nextStream(timeoutMs: number): Promise<ActiveStream | null> {
    return new Promise(resolve => {
      const timer = setTimeout(() => { this.waiter = null; resolve(null) }, timeoutMs)
      this.waiter = stream => { clearTimeout(timer); this.waiter = null; resolve(stream) }
    })
  }

  private async onMessage(method: string, params: Record<string, unknown>): Promise<void> {
    if (method === 'Network.responseReceived') {
      const response = params.response as { url?: string; status?: number } | undefined
      if (!response?.url) return
      let pathname = ''
      try { pathname = new URL(response.url).pathname } catch { return }
      if (pathname !== '/api/v0/chat/completion') return
      const stream: ActiveStream = {
        requestId: String(params.requestId), httpStatus: SIMULATE === 'http-500' ? 500 : (response.status ?? null),
        parser: new DeepSeekStreamParser(), decoder: new TextDecoder('utf-8'), startedAt: Date.now(), lastDataAt: Date.now(),
        chunks: 0, ended: false, networkError: null, raw: '', onEvents: null, backlog: [], endWaiters: []
      }
      this.current = stream
      log(`completion HTTP ${stream.httpStatus}`)
      this.waiter?.(stream)
      try {
        const result = await this.view.webContents.debugger.sendCommand('Network.streamResourceContent', { requestId: stream.requestId }) as { bufferedData?: string }
        if (result.bufferedData) this.feed(stream, Buffer.from(result.bufferedData, 'base64'))
      } catch (error) {
        log('streamResourceContent fallo:', error instanceof Error ? error.message : error)
      }
      return
    }
    const stream = this.current
    if (!stream || params.requestId !== stream.requestId) return
    if (method === 'Network.dataReceived' && typeof params.data === 'string' && params.data) {
      this.feed(stream, Buffer.from(params.data, 'base64'))
    } else if (method === 'Network.loadingFinished') {
      this.end(stream, null)
    } else if (method === 'Network.loadingFailed') {
      this.end(stream, `${String(params.errorText ?? 'error de red')}${params.canceled ? ' (cancelada)' : ''}`)
    }
  }

  private deliver(stream: ActiveStream, events: DeepSeekStreamEvent[]): void {
    if (events.length === 0) return
    if (stream.onEvents) stream.onEvents(events)
    else stream.backlog.push(...events)
  }

  private feed(stream: ActiveStream, bytes: Buffer): void {
    stream.chunks += 1
    stream.lastDataAt = Date.now()
    // TextDecoder con stream:true -- un chunk de red puede cortar un caracter UTF-8 multibyte (acentos, emojis).
    let text = stream.decoder.decode(bytes, { stream: true })
    if (DUMP_DIR) stream.raw += text
    if (SIMULATE === 'unrecognized-stream') text = stream.chunks === 1 ? 'data: {"formato":"desconocido","x":[1,2]}\n\n' : ''
    this.deliver(stream, stream.parser.feed(text))
  }

  private end(stream: ActiveStream, networkError: string | null): void {
    if (stream.ended) return
    const tail = stream.decoder.decode()
    if (tail && SIMULATE !== 'unrecognized-stream') this.deliver(stream, stream.parser.feed(tail + '\n'))
    stream.ended = true
    stream.networkError = networkError
    log(`stream terminado: chunks=${stream.chunks} ms=${Date.now() - stream.startedAt}${networkError ? ` error=${networkError}` : ''}`)
    if (DUMP_DIR) {
      try { mkdirSync(DUMP_DIR, { recursive: true }); writeFileSync(path.join(DUMP_DIR, `${Date.now()}-http${stream.httpStatus}.sse`), stream.raw) } catch { /* diagnostico opcional */ }
    }
    for (const resolve of stream.endWaiters.splice(0)) resolve()
  }

  detach(): void {
    try { this.view.webContents.debugger.detach() } catch { /* ya desenganchado */ }
  }
}

function waitStreamEnd(stream: ActiveStream, timeoutMs: number): Promise<boolean> {
  if (stream.ended) return Promise.resolve(true)
  return new Promise(resolve => {
    const timer = setTimeout(() => resolve(false), timeoutMs)
    stream.endWaiters.push(() => { clearTimeout(timer); resolve(true) })
  })
}

/** Serializa "fijar toggles + escribir + click en enviar" ENTRE sesiones: el estado de los toggles vive en el
 *  localStorage compartido de la particion, 2 envios simultaneos con modos distintos se pisarian. Solo cubre hasta
 *  que arranca la request de completion (~<1s), nunca la generacion. */
let sendQueue: Promise<void> = Promise.resolve()
function withSendLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = sendQueue.then(fn, fn)
  sendQueue = run.then(() => undefined, () => undefined)
  return run
}

/**
 * Fix real de descargas (docs/_arch/verify_deepseek_pwa_download_bug.md, diagnostico ya confirmado con 5
 * condiciones reales): sin ningun `will-download` que llame `item.setSavePath()`, Chromium deja la descarga
 * (el boton "Descargar" de un bloque de codigo, o cualquier otra que la pagina dispare a futuro) en
 * `"progressing"` PARA SIEMPRE -- nunca completa ni cancela, con o sin `webContents.debugger` adjunto (probado
 * real: identico con y sin el). Carpeta real de Descargas del sistema (`app.getPath('downloads')`, predecible y
 * visible, mismo lugar donde caeria si el usuario usara DeepSeek en un navegador real) -- no el workspace del
 * chat: este runtime declara explicitamente "sin acceso a tu workspace" (ver el comentario de cabecera de este
 * archivo), y no vale la pena romper esa frontera solo para esto. Registrado UNA sola vez por proceso (flag a
 * nivel de modulo, mismo patron que `video-frame-reader.ts`/`model-3d-reader.ts`) -- `connect()` puede correr
 * mas de una vez sobre la MISMA sesion compartida (`persist:deepseek-pwa`, un solo login para todos los chats
 * DeepSeek PWA), y un `session.on(...)` (a diferencia de `setPermissionRequestHandler`, que es un setter que se
 * reemplaza solo) ACUMULARIA un listener nuevo por cada `connect()`/chat si no se guardara aca.
 */
let downloadHandlerRegistered = false
function ensureDownloadHandlerRegistered(partition: Electron.Session): void {
  if (downloadHandlerRegistered) return
  downloadHandlerRegistered = true
  partition.on('will-download', (_event, item) => {
    const savePath = uniqueSavePath(app.getPath('downloads'), item.getFilename())
    item.setSavePath(savePath)
    log(`descarga real de DeepSeek: "${item.getFilename()}" -> "${savePath}"`)
  })
}

/** Mismo criterio que un navegador real: nunca pisar un archivo ya existente en Descargas -- si
 *  "nombre.ext" ya existe, prueba "nombre (1).ext", "nombre (2).ext", etc. */
function uniqueSavePath(dir: string, filename: string): string {
  const ext = path.extname(filename)
  const base = path.basename(filename, ext)
  let candidate = path.join(dir, filename)
  for (let n = 1; existsSync(candidate); n++) candidate = path.join(dir, `${base} (${n})${ext}`)
  return candidate
}

// ---------------------------------------------------------------------------------------------------------------

export type HumanReason = 'login' | 'captcha'

export interface DeepSeekPwaHooks {
  /** La PWA necesita al usuario (login/captcha): el panel debe mostrar la vista real ("Ver DeepSeek"). */
  onNeedsHuman: (reason: HumanReason, message: string) => void
  /** Resuelto: el panel puede volver a ocultar la vista. */
  onHumanResolved: () => void
}

export interface DeepSeekPwaSendOptions {
  deepThink: boolean
  onThinkStart: () => void
  onResponseStart: () => void
  onResponse: (text: string) => void
}

export interface DeepSeekPwaSendResult {
  outcome: DeepSeekTurnOutcome
  remoteSessionId: string | null
  title: string | null
  thinkingEnabledConfirmed: boolean | null
}

const REMOTE_SESSION = /^\/a\/chat\/s\/([0-9a-f-]{36})/
const HIDDEN_BOUNDS = { x: 0, y: 0, width: 1000, height: 800 }

export class DeepSeekPwaRuntime {
  private view: WebContentsView | null = null
  private capture: StreamCapture | null = null
  private host: BrowserWindow | null = null
  private remoteSessionId: string | null
  private cancelRequested = false
  private stopped = false
  /** Rectangulo del panel mientras "Ver DeepSeek" esta activo; null = oculta. */
  private placement: { x: number; y: number; width: number; height: number } | null = null

  constructor(
    private readonly chatId: string,
    remoteSessionId: string | null,
    private readonly getHost: () => BrowserWindow | null,
    private readonly hooks: DeepSeekPwaHooks
  ) {
    this.remoteSessionId = remoteSessionId
  }

  hasRemoteConversation(): boolean { return this.remoteSessionId !== null }
  getRemoteSessionId(): string | null { return this.remoteSessionId }

  private page<T>(expression: string, timeoutMs = 8_000): Promise<T> {
    const view = this.view
    if (!view || view.webContents.isDestroyed()) return Promise.reject(new Error('La vista de DeepSeek no esta disponible (el chat se desconecto).'))
    const run = async (): Promise<T> => {
      await view.webContents.executeJavaScript(PAGE_HELPERS)
      return view.webContents.executeJavaScript(expression) as Promise<T>
    }
    return Promise.race([run(), sleep(timeoutMs).then(() => { throw new Error(`La pagina de DeepSeek no respondio (${expression.slice(0, 40)}).`) })])
  }

  private state(): Promise<PageState> { return this.page<PageState>('window.__amatistaDs.state()') }

  /** Posiciona la vista real en el panel ("Ver DeepSeek") o la oculta. La llama ipc-agent.ts con el rectangulo que
   *  reporta el renderer (mismo mecanismo que el navegador embebido), y con visible:false al perder panel (F0). */
  setPlacement(bounds: { x: number; y: number; width: number; height: number } | null): void {
    this.placement = bounds
    const view = this.view
    if (!view || view.webContents.isDestroyed()) return
    if (bounds) {
      view.setBounds({ x: Math.round(bounds.x), y: Math.round(bounds.y), width: Math.max(1, Math.round(bounds.width)), height: Math.max(1, Math.round(bounds.height)) })
      view.setVisible(true)
    } else {
      view.setVisible(false)
      view.setBounds(HIDDEN_BOUNDS)
    }
  }

  async connect(): Promise<void> {
    const host = this.getHost()
    if (!host || host.isDestroyed()) throw new Error('La ventana principal de Amatista no esta disponible.')
    this.host = host
    // Permisos denegados por defecto en la particion (mismo criterio que el fix del navegador embebido, 39a5b25):
    // sin handlers, Electron concede SOLO notificaciones/geolocalizacion a la pagina. El puente no necesita
    // ninguno (escribe por DOM, lee por la red, login con redirecciones normales). Idempotente: se reasignan en
    // cada connect sobre la MISMA sesion de la particion.
    const partition = electronSession.fromPartition(PARTITION)
    partition.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false))
    partition.setPermissionCheckHandler(() => false)
    ensureDownloadHandlerRegistered(partition)
    const view = new WebContentsView({ webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, partition: PARTITION } })
    view.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    host.contentView.addChildView(view)
    this.view = view
    this.setPlacement(this.placement)
    this.capture = new StreamCapture(view)
    log(`vista creada (chat ${this.chatId})`)
    await this.loadConversation()
  }

  private targetPath(): string { return this.remoteSessionId ? `/a/chat/s/${this.remoteSessionId}` : '/' }

  /** Carga la conversacion de este chat y la deja lista para escribir (login -> intervencion del usuario). */
  private async loadConversation(): Promise<void> {
    const view = this.view!
    await view.webContents.loadURL(`${ORIGIN}${this.targetPath()}`).catch(error => {
      // Una redireccion SPA (ej. conversacion inexistente -> "/") puede abortar la carga original: no es un error real.
      if (!String(error?.message ?? error).includes('ERR_ABORTED')) throw error
    })
    let state = await this.waitState(s => (s.hasTextarea && !s.signIn) || s.signIn || s.captcha, READY_TIMEOUT_MS)
    if (!state) throw new Error('La pagina de DeepSeek no termino de cargar (sin campo de texto ni pantalla de inicio de sesion).')
    // Despues de cada intervencion se REEVALUA el estado real (ej. un desafio resuelto puede desembocar en la
    // pantalla de login): nunca se asume que "ya no hay X" significa "listo".
    let intervened = false
    for (let rounds = 0; (state.signIn || state.captcha) && rounds < 3; rounds++) {
      intervened = true
      await this.waitForHuman(state.signIn ? 'login' : 'captcha')
      const next = await this.waitState(s => (s.hasTextarea && !s.signIn) || s.signIn || s.captcha, READY_TIMEOUT_MS)
      if (!next) throw new Error('Despues de tu intervencion la pagina de DeepSeek no quedo lista.')
      state = next
    }
    if (state.signIn || state.captcha) throw new Error('DeepSeek sigue pidiendo intervencion despues de 3 intentos; el chat queda sin conectar.')
    // Tras un login la PWA vuelve a "/": se recarga UNA vez la conversacion de este chat (solo si hubo
    // intervencion -- si no, "/" significa que la conversacion remota ya no existe, ver abajo; sin recursion).
    if (intervened && this.remoteSessionId && state.path === '/') return this.loadConversation()
    if (this.remoteSessionId && !state.path.includes(this.remoteSessionId)) {
      // La conversacion remota ya no existe (DeepSeek redirigio a "/"): el proximo mensaje abre una nueva.
      log(`conversacion remota ${this.remoteSessionId} no existe mas; se abre una nueva`)
      this.remoteSessionId = null
    }
  }

  private async waitState(done: (state: PageState) => boolean, timeoutMs: number): Promise<PageState | null> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline && !this.stopped) {
      try { const state = await this.state(); if (done(state)) return state } catch { /* navegando */ }
      await sleep(200)
    }
    return null
  }

  /** El usuario resuelve login/captcha en el panel real. Nunca se resuelve solo; timeout -> error honesto. */
  private async waitForHuman(reason: HumanReason): Promise<void> {
    const message = reason === 'login'
      ? 'DeepSeek necesita que inicies sesion con tu cuenta: se abrio "Ver DeepSeek" en este panel, inicia sesion ahi.'
      : 'DeepSeek pide verificacion humana: se abrio "Ver DeepSeek" en este panel, resolvela vos ahi.'
    log(`intervencion humana: ${reason}`)
    this.hooks.onNeedsHuman(reason, message)
    const deadline = Date.now() + HUMAN_TIMEOUT_MS
    while (Date.now() < deadline) {
      if (this.stopped) throw new Error('El chat se desconecto mientras DeepSeek esperaba tu intervencion.')
      try {
        const s = await this.state()
        if (reason === 'login' ? (s.hasTextarea && !s.signIn) : !s.captcha) { this.hooks.onHumanResolved(); return }
      } catch { /* pagina navegando: se reintenta */ }
      await sleep(1_000)
    }
    throw new Error(reason === 'login'
      ? `No se completo el inicio de sesion de DeepSeek a tiempo (${Math.round(HUMAN_TIMEOUT_MS / 60_000)} min).`
      : `No se completo la verificacion humana de DeepSeek a tiempo (${Math.round(HUMAN_TIMEOUT_MS / 60_000)} min).`)
  }

  async send(text: string, options: DeepSeekPwaSendOptions): Promise<DeepSeekPwaSendResult> {
    if (!this.view || !this.capture) throw new Error('DeepSeek PWA no esta conectado.')
    this.cancelRequested = false
    // La vista siempre debe estar en la conversacion de este chat (el usuario pudo navegar con "Ver DeepSeek").
    const current = await this.state().catch(() => null)
    if (!current || current.path !== this.targetPath() || !current.hasTextarea) await this.loadConversation()
    const capture = this.capture
    const stream = await withSendLock(async () => {
      const deepThink = await this.page<string>(`window.__amatistaDs.setToggleAt(0, ${options.deepThink ? 'true' : 'false'})`)
      const search = await this.page<string>('window.__amatistaDs.setToggleAt(1, false)')
      if (deepThink === 'missing' || search === 'missing') {
        const labels = await this.page<Array<string | null>>('[window.__amatistaDs.labelAt(0), window.__amatistaDs.labelAt(1)]')
        throw new Error(`No se encontraron los controles DeepThink/Busqueda de DeepSeek (etiquetas vistas: ${JSON.stringify(labels)}). La interfaz cambio o esta en un idioma no reconocido.`)
      }
      await sleep(250)
      if (!await this.page<boolean>(`window.__amatistaDs.type(${JSON.stringify(text)})`)) throw new Error('No se encontro el campo de texto de DeepSeek.')
      await sleep(200)
      if (await this.page<boolean>('window.__amatistaDs.btnDisabled()')) throw new Error('El boton de enviar de DeepSeek quedo deshabilitado despues de escribir: la interfaz de DeepSeek pudo haber cambiado.')
      const next = capture.nextStream(START_TIMEOUT_MS)
      await this.page<boolean>('window.__amatistaDs.send()')
      log(`enviado (deepThink=${options.deepThink})`)
      return next
    })
    const active = stream ?? await this.recoverMissingStart(capture)
    return this.consume(active, options)
  }

  /** La request de completion no aparecio: login vencido o desafio -> intervencion humana. Nunca se reenvia solo. */
  private async recoverMissingStart(capture: StreamCapture): Promise<ActiveStream> {
    const state = await this.state().catch(() => null)
    if (state?.signIn) {
      await this.waitForHuman('login')
      throw new Error('La sesion de DeepSeek habia vencido y ya se volvio a iniciar. El mensaje NO se envio: volve a mandarlo (no se reenvia solo para no duplicarlo en tu cuenta).')
    }
    if (state?.captcha) {
      const next = capture.nextStream(HUMAN_TIMEOUT_MS + START_TIMEOUT_MS)
      await this.waitForHuman('captcha')
      const resumed = await Promise.race([next, sleep(START_TIMEOUT_MS).then(() => null)])
      if (resumed) return resumed
      throw new Error('La verificacion de DeepSeek se completo, pero el mensaje no llego a enviarse. Volve a mandarlo (no se reenvia solo).')
    }
    throw new Error('El mensaje no llego a enviarse a DeepSeek (no aparecio ninguna respuesta en 15 s). La interfaz de DeepSeek pudo haber cambiado.')
  }

  private async consume(stream: ActiveStream, options: DeepSeekPwaSendOptions): Promise<DeepSeekPwaSendResult> {
    let responseText = ''
    let thinkText = ''
    let status: string | null = null
    let title: string | null = null
    let thinkingEnabled: boolean | null = null
    const errors: Array<{ code: unknown; msg: string }> = []
    let sawThink = false
    let sawResponse = false
    // El status HTTP se conoce desde el primer byte: una respuesta no-2xx NUNCA se transmite a la UI (hallazgo real
    // de la verificacion con AMATISTA_DEEPSEEK_PWA_SIMULATE=http-500: sin esto, el contenido llegaba en vivo y el
    // error recien despues). El veredicto final (describeStreamOutcome) informa el status real igual.
    const httpOk = stream.httpStatus === null || (stream.httpStatus >= 200 && stream.httpStatus < 300)
    const handle = (events: DeepSeekStreamEvent[]): void => {
      for (const event of events) {
        if (event.kind === 'think') {
          if (!sawThink && httpOk) { sawThink = true; options.onThinkStart() }
          thinkText += event.text
        } else if (event.kind === 'response') {
          if (!sawResponse && httpOk) { sawResponse = true; options.onResponseStart() }
          responseText += event.text
          if (httpOk) options.onResponse(event.text)
        } else if (event.kind === 'status') status = event.status
        else if (event.kind === 'title') title = event.title
        else if (event.kind === 'error') errors.push({ code: event.code, msg: event.msg })
        else if (event.kind === 'initial') thinkingEnabled = event.thinkingEnabled
      }
    }
    handle(stream.backlog.splice(0))
    stream.onEvents = handle

    let inactivityTimeout = false
    let lastCaptchaCheck = 0
    while (!stream.ended && !this.stopped) {
      await waitStreamEnd(stream, 1_000)
      if (stream.ended) break
      const idleFor = Date.now() - stream.lastDataAt
      if (idleFor > INACTIVITY_MS) {
        inactivityTimeout = true
        log(`inactividad ${idleFor}ms: se detiene el turno`)
        await this.page<boolean>('window.__amatistaDs.stop()').catch(() => false)
        await waitStreamEnd(stream, 5_000)
        break
      }
      // Desafio a mitad de turno: solo se mira si el stream esta quieto (evita polling inutil mientras fluye).
      if (idleFor > 3_000 && Date.now() - lastCaptchaCheck > 3_000) {
        lastCaptchaCheck = Date.now()
        const state = await this.state().catch(() => null)
        if (state?.captcha) { await this.waitForHuman('captcha'); stream.lastDataAt = Date.now() }
      }
    }
    stream.onEvents = null

    const pathNow = await this.page<string>('location.pathname').catch(() => '')
    const match = REMOTE_SESSION.exec(pathNow)
    if (match) this.remoteSessionId = match[1]

    const outcome: DeepSeekTurnOutcome = {
      httpStatus: stream.httpStatus, status, responseText, thinkText, recognized: stream.parser.recognized, errors,
      networkError: stream.networkError ?? (this.stopped && !stream.ended ? 'el chat se desconecto a mitad del turno' : null),
      cancelledByUser: this.cancelRequested, inactivityTimeout, unrecognizedSamples: stream.parser.unrecognizedSamples
    }
    log(`resultado: http=${outcome.httpStatus} status=${status} respuesta=${responseText.length} razonamiento=${thinkText.length} thinking_enabled=${thinkingEnabled} cancelado=${this.cancelRequested} remoto=${this.remoteSessionId}`)
    return { outcome, remoteSessionId: this.remoteSessionId, title, thinkingEnabledConfirmed: thinkingEnabled }
  }

  /** Boton "Detener" de Amatista -> click REAL en el boton de detener de la PWA (dispara stop_stream; el stream
   *  cierra con status INCOMPLETE y DeepSeek guarda la respuesta parcial). No es una cancelacion cosmetica. */
  async cancelTurn(): Promise<void> {
    this.cancelRequested = true
    const clicked = await this.page<boolean>('window.__amatistaDs.stop()').catch(() => false)
    log(`cancelar: click en detener=${clicked}`)
  }

  /** Mismo ciclo de vida que el navegador embebido: la vista muere con la sesion (disconnectSession()). */
  stop(): void {
    this.stopped = true
    this.capture?.detach()
    this.capture = null
    const view = this.view
    this.view = null
    if (!view) return
    try { if (this.host && !this.host.isDestroyed()) this.host.contentView.removeChildView(view) } catch { /* ya removida */ }
    try { view.webContents.close() } catch { /* ya cerrado */ }
    log(`vista destruida (chat ${this.chatId})`)
  }
}

/** Agrupa los deltas de respuesta cada ~120 ms (el renderer persiste en SQLite en CADA delta) y NUNCA emite un
 *  delta que sea solo espacios en blanco: appendAssistantMessage() los descarta (if (!normalizedText) return), lo
 *  que pegaria parrafos. Los espacios pendientes viajan antepuestos al siguiente delta con contenido. */
export class DeltaCoalescer {
  private pending = ''
  private timer: NodeJS.Timeout | null = null
  constructor(private readonly emit: (text: string) => void, private readonly intervalMs = 120) {}

  push(text: string): void {
    this.pending += text
    if (!this.timer) this.timer = setTimeout(() => this.flush(), this.intervalMs)
  }

  flush(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = null }
    if (this.pending.trim().length === 0) return
    const out = this.pending
    this.pending = ''
    this.emit(out)
  }

  /** Fin del turno: emite lo que quede con contenido; espacios sueltos al final se descartan (el item/completed
   *  final reemplaza el mensaje entero con el texto exacto igual). */
  finish(): void {
    this.flush()
    if (this.timer) { clearTimeout(this.timer); this.timer = null }
    this.pending = ''
  }
}
