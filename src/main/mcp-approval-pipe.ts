// Canal de aprobacion Y orquestacion para el servidor MCP propio de Amatista
// (mcp-lsp-server.ts) -- ver docs/_arch/verify_mcp_approval.md para el diseno
// original (solo aprobacion) y docs/_arch/verify_subscription_orchestrator_design.md
// para la generalizacion de esta fase (orquestacion por suscripcion: paneles
// conectados por claude-cli/antigravity-cli pueden ahora usar send_to_window/
// parallel_ask, no solo ser destino). Un named pipe de Windows
// (\\.\pipe\amatista-mcp-approval), UN solo listener para toda la app
// (mismo principio que sendToWindow(panelId, ...): un proceso, N paneles
// distinguidos por dato en el mensaje, no por canal separado). NDJSON de
// una linea por mensaje, una conexion por request -- el cliente (el servidor
// MCP standalone, proceso nieto de main) abre, escribe una linea, lee UNA
// linea de respuesta, cierra. Este archivo corre DENTRO de Electron main
// (importado por index.ts) -- el proceso nieto (mcp-lsp-server.cjs) nunca
// importa nada de aca directo: solo habla el protocolo NDJSON por socket,
// nunca conoce sessionRegistry/chat-store/parallel-orchestrator (mismo
// motivo por el que ese archivo duplica en vez de importar utilidades
// chicas -- ver su propio comentario de cabecera).
//
// Protocolo real (un campo `action` decide el resto del shape del mensaje):
//
//   confirm         {panelId, action:'confirm', title, detail, toolName?}
//                   -> {approved: boolean, error?: string}
//     `toolName` es OPCIONAL -- ausente, este action se comporta identico
//     al pipe original (solo aprobacion, sin gate de principal ni eventos de
//     watchdog): deja la puerta abierta a un futuro consumidor generico que
//     solo necesite un dialogo si/no. Presente ('send_to_window' |
//     'parallel_ask'), dispara el gate de panel-principal (Tarea 4) y el
//     par de eventos de watchdog phase:start/done (Tarea 6) alrededor de
//     TODO el flujo (confirm + ejecucion), no solo de este mensaje.
//
//   sendToWindow    {panelId, action:'sendToWindow', destino, mensaje}
//                   -> {ok: true, text} | {ok: false, error}
//     Ejecucion real de send_to_window -- SOLO se llama despues de que el
//     cliente ya paso por un `confirm` con toolName:'send_to_window'
//     aprobado. Vuelve a re-verificar el gate igual (nunca confiar en que
//     el proceso hijo no reordeno los pasos).
//
//   planParallelAsk {panelId, action:'planParallelAsk', subtasks: string[]}
//                   -> {ok: true, assignments} | {ok: false, error}
//     Planificacion SINCRONICA real (parallel-orchestrator.ts) -- el
//     cliente arma el texto del dialogo de aprobacion con `assignments`
//     (mismo criterio que tool-registry.ts: el "case" de cada tool arma su
//     propio texto de salida, la orquestacion real solo devuelve datos).
//
//   runParallelAsk  {panelId, action:'runParallelAsk', assignments}
//                   -> {ok: true, outcomes} | {ok: false, error}
//     Ejecucion real -- SOLO despues de un `confirm` con
//     toolName:'parallel_ask' aprobado (el cliente re-manda los mismos
//     `assignments` que planParallelAsk le devolvio, esta conexion no
//     comparte estado con la anterior).
//
//   readImage       {panelId, action:'readImage', path, region?}
//                   -> {ok: true, text, dataUrl} | {ok: false, error}
//     F1 de docs/_arch/verify_native_multimodal_tools_design.md: read_image para
//     los CLIs. Solo lectura, SIN gate ni aprobacion (mismo perfil que read_file/
//     read_document). Se ejecuta con el MISMO ToolRegistry.execute() que usan los
//     runtimes API -- una sola implementacion, mismo confinamiento al workspace
//     (resuelto aca desde la sesion VIVA del panel, nunca desde lo que afirme el
//     proceso hijo) y mismos mensajes de error.
//
// Gate de panel-principal (Tarea 4, verify_subscription_orchestrator_design.md):
// CADA action que dispara orquestacion real (confirm con toolName, sendToWindow,
// planParallelAsk, runParallelAsk) resuelve `sessionRegistry.get(panelId)` y
// llama a `isPrincipalChat(session.activeChatId)` DE NUEVO aca -- el
// `panelId` viaja fijo en el `env` del proceso hijo desde el spawn
// (mismo patron que AMATISTA_MCP_WORKSPACE), pero su legitimidad para
// orquestar SOLO se confia si main la recalcula del lado seguro. El
// servidor MCP tambien decide de antemano si declara estas 2 tools
// (env AMATISTA_IS_PRINCIPAL, cli-agent-runtime.ts) -- esto es la
// PRIMERA linea de defensa (UX: la tool ni aparece), este gate es el
// backstop real que nunca se puede saltear.
//
// Watchdog (Tarea 6): un origen CLI esperando una orquestacion en curso no
// tiene forma de emitir 'item/toolCall/status' el mismo (CliAgentRuntime
// nunca emite 'toolStatus', ver PENDING.md) -- este handler lo emite DIRECTO
// via sendSessionEvent() en los puntos reales de inicio/fin de cada flujo,
// mismo evento real que ya pausa/reanuda el watchdog del renderer para
// runtimes API (wireApi() -> runtime.on('toolStatus', ...)). Cierra
// UNICAMENTE el caso puntual de "orquestacion en curso" -- el gap general
// de actividad interna del propio CLI (sus tools nativas Read/Bash/etc,
// invisibles para Amatista) sigue documentado y fuera de alcance en
// PENDING.md, sin tocar wireCli()/CliAgentRuntime en absoluto.
import { createServer, type Socket } from 'node:net'
import { isPrincipalChat } from './chat-store'
import {
  beginComputerUseAction,
  endComputerUseAction,
  getMainWindow,
  requestHardToolApproval,
  requestSessionToolApproval,
  sendSessionEvent,
  sessionRegistry,
  toolRegistry
} from './runtime-state'
import {
  clickAt,
  clickByDescription,
  describeCoordinateTarget,
  moveMouseTo,
  takeScreenshot,
  typeByDescription,
  typeText,
  type MouseButton
} from './computer-use-actions'
import { clickInBrowserView, navigateBrowserView, screenshotBrowserView, typeInBrowserView } from './embedded-browser'
import type { ParallelAskOutcome, ParallelSubtaskAssignment } from './parallel-orchestrator'

// AMATISTA_MCP_PIPE (opcional, ruta COMPLETA del pipe, p. ej. \\.\pipe\amatista-mcp-approval-dev): el pipe era UNICO por
// maquina, asi que con la app instalada abierta cualquier otra instancia (dev, aislada, de prueba) no podia abrir su
// listener (EADDRINUSE, solo se logueaba) y los CLIs de ESA instancia le hablaban al pipe de la OTRA -- confirmado en la
// verificacion de read_image (F1): un `request malformado` de la app instalada, mas vieja. Sin la variable, el nombre de
// siempre. Mismo criterio que AMATISTA_STORAGE_ROOT para aislar una instancia; main se lo pasa al proceso MCP hijo.
export const MCP_APPROVAL_PIPE_PATH =
  process.env.AMATISTA_MCP_PIPE?.trim() ||
  (process.platform === 'win32' ? '\\\\.\\pipe\\amatista-mcp-approval' : '/tmp/amatista-mcp-approval.sock')

type OrchestratorToolName = 'send_to_window' | 'parallel_ask'

interface ConfirmRequest {
  panelId: string
  action: 'confirm'
  title: string
  detail: string
  toolName?: OrchestratorToolName
}

interface SendToWindowRequest {
  panelId: string
  action: 'sendToWindow'
  destino: string
  mensaje: string
}

interface PlanParallelAskRequest {
  panelId: string
  action: 'planParallelAsk'
  subtasks: string[]
}

interface RunParallelAskRequest {
  panelId: string
  action: 'runParallelAsk'
  assignments: ParallelSubtaskAssignment[]
}

// Familia A (computer use, docs/_arch/verify_computer_use_cli_extension.md,
// Tarea 3): a diferencia de send_to_window/parallel_ask (confirm en un
// request separado, ejecucion en otro), las 4 actions de computer use son
// AUTOCONTENIDAS -- gate (Capa 1) + requestHardToolApproval (Capa 2) +
// ejecucion real, TODO en un unico request/response. No hay ningun "plan"
// que mostrar antes de confirmar (a diferencia de parallel_ask), asi que el
// 2do round-trip de send_to_window no aporta nada aca -- menos mensajes por
// el pipe, mismo principio real ya confirmado viable (overhead del pipe
// negligible frente al ritmo real de tool-calls headless, ver doc de
// Tarea 3 ahi).
type ComputerUseToolName = 'screenshot' | 'mouse_move' | 'mouse_click' | 'keyboard_type'

interface ComputerUseScreenshotRequest {
  panelId: string
  action: 'computerUseScreenshot'
  display?: number
}

interface ComputerUseMouseMoveRequest {
  panelId: string
  action: 'computerUseMouseMove'
  x: number
  y: number
}

interface ComputerUseMouseClickRequest {
  panelId: string
  action: 'computerUseMouseClick'
  description?: string
  x?: number
  y?: number
  button?: MouseButton
}

interface ComputerUseKeyboardTypeRequest {
  panelId: string
  action: 'computerUseKeyboardType'
  description?: string
  text: string
}

// Navegador embebido (docs/_arch/verify_embedded_browser_design.md) -- MISMO
// criterio autocontenido que computer use de arriba (gate + hardConfirm +
// ejecucion en un unico request/response, sin 2do round-trip).
type BrowserToolName = 'browser_navigate' | 'browser_click' | 'browser_type' | 'browser_screenshot'

interface BrowserNavigateRequest {
  panelId: string
  action: 'browserNavigate'
  url: string
}

interface BrowserClickRequest {
  panelId: string
  action: 'browserClick'
  description?: string
  x?: number
  y?: number
  button?: 'left' | 'right'
}

interface BrowserTypeRequest {
  panelId: string
  action: 'browserType'
  description: string
  text: string
}

interface BrowserScreenshotRequest {
  panelId: string
  action: 'browserScreenshot'
}

interface ReadImageRequest {
  panelId: string
  action: 'readImage'
  path: string
  /** Sin validar: read_image (image-reader.ts) valida la forma y los rangos. */
  region?: unknown
}

type PipeRequest =
  | ConfirmRequest
  | SendToWindowRequest
  | PlanParallelAskRequest
  | RunParallelAskRequest
  | ComputerUseScreenshotRequest
  | ComputerUseMouseMoveRequest
  | ComputerUseMouseClickRequest
  | ComputerUseKeyboardTypeRequest
  | BrowserNavigateRequest
  | BrowserClickRequest
  | BrowserTypeRequest
  | BrowserScreenshotRequest
  | ReadImageRequest

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

/** Sin validacion estructural profunda a proposito (mismo criterio que el
 *  pipe original) -- cada handler de abajo revalida los campos puntuales
 *  que necesita antes de usarlos, este parseo solo decide QUE action es. */
function parseRequest(raw: string): PipeRequest | null {
  try {
    const parsed = JSON.parse(raw) as Partial<PipeRequest> & { action?: unknown }
    if (!isNonEmptyString(parsed.panelId)) return null
    switch (parsed.action) {
      case 'confirm': {
        const p = parsed as Partial<ConfirmRequest>
        if (!isNonEmptyString(p.title) || typeof p.detail !== 'string') return null
        return { panelId: parsed.panelId, action: 'confirm', title: p.title, detail: p.detail, toolName: p.toolName }
      }
      case 'sendToWindow': {
        const p = parsed as Partial<SendToWindowRequest>
        if (!isNonEmptyString(p.destino) || !isNonEmptyString(p.mensaje)) return null
        return { panelId: parsed.panelId, action: 'sendToWindow', destino: p.destino, mensaje: p.mensaje }
      }
      case 'planParallelAsk': {
        const p = parsed as Partial<PlanParallelAskRequest>
        if (!Array.isArray(p.subtasks)) return null
        return { panelId: parsed.panelId, action: 'planParallelAsk', subtasks: p.subtasks.map(String) }
      }
      case 'runParallelAsk': {
        const p = parsed as Partial<RunParallelAskRequest>
        if (!Array.isArray(p.assignments)) return null
        return { panelId: parsed.panelId, action: 'runParallelAsk', assignments: p.assignments as ParallelSubtaskAssignment[] }
      }
      case 'computerUseScreenshot': {
        const p = parsed as Partial<ComputerUseScreenshotRequest>
        return { panelId: parsed.panelId, action: 'computerUseScreenshot', display: typeof p.display === 'number' ? p.display : undefined }
      }
      case 'computerUseMouseMove': {
        const p = parsed as Partial<ComputerUseMouseMoveRequest>
        if (typeof p.x !== 'number' || typeof p.y !== 'number') return null
        return { panelId: parsed.panelId, action: 'computerUseMouseMove', x: p.x, y: p.y }
      }
      case 'computerUseMouseClick': {
        const p = parsed as Partial<ComputerUseMouseClickRequest>
        const hasCoords = typeof p.x === 'number' && typeof p.y === 'number'
        if (!isNonEmptyString(p.description) && !hasCoords) return null
        return {
          panelId: parsed.panelId,
          action: 'computerUseMouseClick',
          description: p.description,
          x: typeof p.x === 'number' ? p.x : undefined,
          y: typeof p.y === 'number' ? p.y : undefined,
          button: p.button === 'right' ? 'right' : 'left'
        }
      }
      case 'computerUseKeyboardType': {
        const p = parsed as Partial<ComputerUseKeyboardTypeRequest>
        if (typeof p.text !== 'string' || !p.text) return null
        return { panelId: parsed.panelId, action: 'computerUseKeyboardType', description: p.description, text: p.text }
      }
      case 'browserNavigate': {
        const p = parsed as Partial<BrowserNavigateRequest>
        if (!isNonEmptyString(p.url)) return null
        return { panelId: parsed.panelId, action: 'browserNavigate', url: p.url }
      }
      case 'browserClick': {
        const p = parsed as Partial<BrowserClickRequest>
        const hasCoords = typeof p.x === 'number' && typeof p.y === 'number'
        if (!isNonEmptyString(p.description) && !hasCoords) return null
        return {
          panelId: parsed.panelId,
          action: 'browserClick',
          description: p.description,
          x: typeof p.x === 'number' ? p.x : undefined,
          y: typeof p.y === 'number' ? p.y : undefined,
          button: p.button === 'right' ? 'right' : 'left'
        }
      }
      case 'browserType': {
        const p = parsed as Partial<BrowserTypeRequest>
        if (!isNonEmptyString(p.description) || typeof p.text !== 'string' || !p.text) return null
        return { panelId: parsed.panelId, action: 'browserType', description: p.description, text: p.text }
      }
      case 'browserScreenshot':
        return { panelId: parsed.panelId, action: 'browserScreenshot' }
      case 'readImage': {
        const p = parsed as Partial<ReadImageRequest>
        if (!isNonEmptyString(p.path)) return null
        return { panelId: parsed.panelId, action: 'readImage', path: p.path, region: p.region }
      }
      default:
        return null
    }
  } catch {
    return null
  }
}

/** Tarea 4: unica fuente de verdad del lado de main -- re-verifica contra la
 *  sesion VIVA, nunca contra lo que el proceso hijo afirme. `false` tanto si
 *  el panel no existe (sesion nunca registrada, o ya desconectada) como si
 *  existe pero no es el principal de su grupo. */
function isPanelAllowedToOrchestrate(panelId: string): boolean {
  const session = sessionRegistry.get(panelId)
  return Boolean(session && isPrincipalChat(session.activeChatId ?? ''))
}

const NOT_PRINCIPAL_ERROR =
  'Este panel no es el chat principal de su grupo -- la orquestacion por suscripcion (send_to_window/parallel_ask) solo esta disponible ahi.'

/** Familia A (computer use), Capa 1 -- mismo criterio EXACTO que
 *  isPanelAllowedToOrchestrate() de arriba: re-verifica contra la sesion
 *  VIVA (sessionRegistry), nunca contra lo que el proceso hijo afirme (el
 *  env AMATISTA_COMPUTER_USE_ACTIVE del spawn es solo la primera linea de
 *  defensa -- decide si el servidor MCP declara las tools, ver
 *  mcp-lsp-server.ts -- esto es el backstop real). */
function isComputerUseActiveForPanel(panelId: string): boolean {
  return sessionRegistry.get(panelId)?.computerUseActive === true
}

const NOT_COMPUTER_USE_ACTIVE_ERROR =
  'Control de escritorio no esta activado para este panel -- el usuario tiene que activarlo primero (Configuracion + toggle del composer).'

/** Navegador embebido, Capa 1 -- mismo criterio exacto que
 *  isComputerUseActiveForPanel() de arriba. */
function isBrowserControlActiveForPanel(panelId: string): boolean {
  return sessionRegistry.get(panelId)?.browserControlActive === true
}

const NOT_BROWSER_CONTROL_ACTIVE_ERROR =
  'El navegador embebido no esta activado para este panel -- el usuario tiene que activarlo primero.'

function emitToolStatus(panelId: string, name: OrchestratorToolName | ComputerUseToolName | BrowserToolName, phase: 'start' | 'done'): void {
  sendSessionEvent(panelId, { kind: 'notification', method: 'item/toolCall/status', params: { name, phase } })
}

/** Mismo formato real que formatParallelPlanDetail() (tool-registry.ts) --
 *  duplicado a proposito, no importado: ese archivo arrastra un arbol de
 *  imports (VCS, generacion de imagenes, lectura de documentos) ajeno a
 *  este pipe chico, mismo criterio de duplicacion ya establecido en
 *  mcp-lsp-server.ts. */
async function handleConfirm(request: ConfirmRequest): Promise<{ approved: boolean; error?: string }> {
  if (!request.toolName) {
    // Camino original, sin cambios: confirm generico, sin gate, sin eventos
    // de watchdog -- deja la puerta abierta a un futuro consumidor no
    // orientado a orquestacion.
    const approved = await requestSessionToolApproval(request.panelId, request.title, request.detail)
    return { approved }
  }

  if (!isPanelAllowedToOrchestrate(request.panelId)) {
    return { approved: false, error: NOT_PRINCIPAL_ERROR }
  }

  emitToolStatus(request.panelId, request.toolName, 'start')
  const approved = await requestSessionToolApproval(request.panelId, request.title, request.detail)
  // Si rechazo, el flujo termina ACA -- ningun otro mensaje real (sendToWindow/
  // runParallelAsk) va a llegar para este tool call, asi que 'done' se emite
  // ya mismo. Si aprobo, el 'done' lo emite el handler de ejecucion real.
  if (!approved) emitToolStatus(request.panelId, request.toolName, 'done')
  return { approved }
}

async function handleSendToWindow(request: SendToWindowRequest): Promise<{ ok: boolean; text?: string; error?: string }> {
  if (!isPanelAllowedToOrchestrate(request.panelId)) {
    emitToolStatus(request.panelId, 'send_to_window', 'done')
    return { ok: false, error: NOT_PRINCIPAL_ERROR }
  }
  try {
    const { sendToWindowByTitle } = await import('./cross-window-messaging.js')
    const result = await sendToWindowByTitle({
      originPanelId: request.panelId,
      destinationTitle: request.destino,
      message: request.mensaje
    })
    return result.ok ? { ok: true, text: result.text } : { ok: false, error: result.error }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  } finally {
    emitToolStatus(request.panelId, 'send_to_window', 'done')
  }
}

async function handlePlanParallelAsk(
  request: PlanParallelAskRequest
): Promise<{ ok: boolean; assignments?: ParallelSubtaskAssignment[]; error?: string }> {
  if (!isPanelAllowedToOrchestrate(request.panelId)) {
    // Sin 'start' emitido todavia (nada arranco de verdad para el
    // watchdog) -- fallo instantaneo, ni siquiera intenta planificar.
    return { ok: false, error: NOT_PRINCIPAL_ERROR }
  }
  emitToolStatus(request.panelId, 'parallel_ask', 'start')
  try {
    const { planParallelAsk } = await import('./parallel-orchestrator.js')
    const plan = planParallelAsk(request.panelId, request.subtasks)
    if (!plan.ok) {
      // El flujo termina aca (no hay confirm/run despues de un plan
      // fallido) -- cerrar el par start/done ya mismo.
      emitToolStatus(request.panelId, 'parallel_ask', 'done')
      return { ok: false, error: plan.error }
    }
    return { ok: true, assignments: plan.assignments }
  } catch (error) {
    emitToolStatus(request.panelId, 'parallel_ask', 'done')
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

async function handleRunParallelAsk(
  request: RunParallelAskRequest
): Promise<{ ok: boolean; outcomes?: ParallelAskOutcome[]; error?: string }> {
  if (!isPanelAllowedToOrchestrate(request.panelId)) {
    emitToolStatus(request.panelId, 'parallel_ask', 'done')
    return { ok: false, error: NOT_PRINCIPAL_ERROR }
  }
  try {
    const { runParallelAsk } = await import('./parallel-orchestrator.js')
    // Fix real (docs/_arch/verify_computer_use_cli_extension.md, Tarea 4 --
    // PASO 0.2 del pedido de implementacion): ANTES, esta llamada no pasaba
    // ningun AbortSignal -- brecha real, ya documentada, de que un turno
    // CLI cancelado (mata el proceso `claude`/`agy`) no cascadeaba el
    // cancel a las sub-tareas ya en vuelo en otros paneles. `session.
    // turnAbortSignal` SI existe igual para sesiones CLI (creado uniforme
    // por runTurnForWindow() antes de bifurcar, ver runtime-state.ts) --
    // el unico motivo por el que no se usaba aca es que nadie lo habia
    // cableado, no que no existiera. Mismo mecanismo real que ya usa el
    // camino API nativo (ExecuteContext.runParallelAsk, ipc-agent.ts).
    const signal = sessionRegistry.get(request.panelId)?.turnAbortSignal?.signal
    const outcomes = await runParallelAsk(request.assignments, signal)
    return { ok: true, outcomes }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  } finally {
    emitToolStatus(request.panelId, 'parallel_ask', 'done')
  }
}

// Familia A (computer use) -- las 4 comparten el mismo esqueleto real:
// Capa 1 (isComputerUseActiveForPanel) bloquea de raiz SIN pedir Capa 2 si
// el usuario no activo el toggle para este panel -- Capa 2
// (requestHardToolApproval(), NUNCA requestSessionToolApproval() -- esa
// respeta toolTrustSession, la guardia monotona no puede) SIEMPRE despues,
// incondicional. beginComputerUseAction()/endComputerUseAction() (overlay
// visual) rodean SOLO la ejecucion real, nunca el hardConfirm (que puede
// tardar indefinido esperando al humano). PASO 0.2 real: cada handler lee
// `session.turnAbortSignal?.signal` y se lo pasa a computer-use-actions.ts
// para el chequeo de micro-pasos -- mismo mecanismo real, cableado desde el
// dia 1 aca (a diferencia de handleRunParallelAsk, que lo tenia que
// arreglar retroactivo arriba).

async function handleComputerUseScreenshot(
  request: ComputerUseScreenshotRequest
): Promise<{ ok: boolean; dataUrl?: string; mimeType?: string; width?: number; height?: number; error?: string }> {
  if (!isComputerUseActiveForPanel(request.panelId)) return { ok: false, error: NOT_COMPUTER_USE_ACTIVE_ERROR }
  const approved = await requestHardToolApproval(
    request.panelId,
    'Capturar pantalla',
    request.display ? `Tomar una captura real del monitor ${request.display}.` : 'Tomar una captura real del monitor primario.'
  )
  if (!approved) return { ok: false, error: 'El usuario rechazo la captura de pantalla.' }
  emitToolStatus(request.panelId, 'screenshot', 'start')
  beginComputerUseAction(request.panelId)
  try {
    const shot = await takeScreenshot(request.display)
    return { ok: true, dataUrl: shot.dataUrl, mimeType: shot.mimeType, width: shot.width, height: shot.height }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  } finally {
    endComputerUseAction(request.panelId)
    emitToolStatus(request.panelId, 'screenshot', 'done')
  }
}

async function handleComputerUseMouseMove(
  request: ComputerUseMouseMoveRequest
): Promise<{ ok: boolean; x?: number; y?: number; interrupted?: boolean; error?: string }> {
  if (!isComputerUseActiveForPanel(request.panelId)) return { ok: false, error: NOT_COMPUTER_USE_ACTIVE_ERROR }
  const approved = await requestHardToolApproval(request.panelId, 'Mover el mouse', `Mover el cursor real a (${request.x}, ${request.y}).`)
  if (!approved) return { ok: false, error: 'El usuario rechazo mover el mouse.' }
  emitToolStatus(request.panelId, 'mouse_move', 'start')
  beginComputerUseAction(request.panelId)
  try {
    const signal = sessionRegistry.get(request.panelId)?.turnAbortSignal?.signal
    const result = await moveMouseTo({ x: request.x, y: request.y }, signal)
    return { ok: !result.interrupted, x: result.point.x, y: result.point.y, interrupted: result.interrupted }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  } finally {
    endComputerUseAction(request.panelId)
    emitToolStatus(request.panelId, 'mouse_move', 'done')
  }
}

async function handleComputerUseMouseClick(request: ComputerUseMouseClickRequest): Promise<{
  ok: boolean
  status?: 'ok' | 'not_found' | 'ambiguous'
  x?: number
  y?: number
  hint?: string
  controlType?: string
  name?: string
  candidates?: string[]
  interrupted?: boolean
  blockedByUac?: boolean
  error?: string
}> {
  if (!isComputerUseActiveForPanel(request.panelId)) return { ok: false, error: NOT_COMPUTER_USE_ACTIVE_ERROR }
  const button = request.button ?? 'left'
  const detail = request.description
    ? `Click en: "${request.description}"`
    : `Click ${button === 'right' ? 'derecho' : 'izquierdo'} real en (${request.x}, ${request.y}).`
  const approved = await requestHardToolApproval(request.panelId, 'Click del mouse', detail)
  if (!approved) return { ok: false, error: 'El usuario rechazo el click del mouse.' }
  emitToolStatus(request.panelId, 'mouse_click', 'start')
  beginComputerUseAction(request.panelId)
  try {
    // Mecanismo PRIMARIO: UI Automation real por nombre/tipo de control --
    // mismo criterio real que el "case" de tool-registry.ts (camino API).
    if (request.description) {
      const result = await clickByDescription(request.description, button)
      if (result.status === 'ok') return { ok: true, status: 'ok', controlType: result.controlType, name: result.name }
      if (result.status === 'not_found') return { ok: false, status: 'not_found', candidates: result.candidates }
      if (result.status === 'ambiguous') return { ok: false, status: 'ambiguous', candidates: result.candidates }
      return { ok: false, error: `No se pudo resolver el click semantico real (${result.error ?? 'UI Automation no disponible'}) -- reintenta con "x"/"y" si el contenido no es semantico.` }
    }
    const signal = sessionRegistry.get(request.panelId)?.turnAbortSignal?.signal
    const result = await clickAt({ x: request.x as number, y: request.y as number }, button, signal)
    if (result.blockedByUac) return { ok: false, error: 'Rechazado: el destino real es un dialogo de UAC -- prohibido sin excepcion.', blockedByUac: true }
    if (result.interrupted) return { ok: false, interrupted: true }
    const hint = await describeCoordinateTarget(result.point.x, result.point.y)
    return { ok: true, x: result.point.x, y: result.point.y, hint: hint ?? undefined }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  } finally {
    endComputerUseAction(request.panelId)
    emitToolStatus(request.panelId, 'mouse_click', 'done')
  }
}

async function handleComputerUseKeyboardType(request: ComputerUseKeyboardTypeRequest): Promise<{
  ok: boolean
  status?: 'ok' | 'not_found' | 'ambiguous'
  charsTyped?: number
  totalChars?: number
  controlType?: string
  name?: string
  candidates?: string[]
  interrupted?: boolean
  blockedByUac?: boolean
  error?: string
}> {
  if (!isComputerUseActiveForPanel(request.panelId)) return { ok: false, error: NOT_COMPUTER_USE_ACTIVE_ERROR }
  const detail = request.description ? `Campo: "${request.description}"\nTexto: ${request.text}` : request.text
  const approved = await requestHardToolApproval(request.panelId, 'Escribir texto', detail)
  if (!approved) return { ok: false, error: 'El usuario rechazo escribir el texto.' }
  emitToolStatus(request.panelId, 'keyboard_type', 'start')
  beginComputerUseAction(request.panelId)
  try {
    const signal = sessionRegistry.get(request.panelId)?.turnAbortSignal?.signal
    // Mecanismo PRIMARIO: UI Automation real por nombre/tipo de control --
    // mismo criterio real que el "case" de tool-registry.ts (camino API).
    if (request.description) {
      const result = await typeByDescription(request.description, request.text, signal)
      if (result.status === 'not_found') return { ok: false, status: 'not_found', candidates: result.candidates }
      if (result.status === 'ambiguous') return { ok: false, status: 'ambiguous', candidates: result.candidates }
      if (result.status === 'error') {
        return { ok: false, error: `No se pudo resolver el campo real (${result.error ?? 'UI Automation no disponible'}) -- reintenta sin "description" si el foco ya esta en el campo correcto.` }
      }
      if (result.interrupted) return { ok: false, interrupted: true, charsTyped: result.charsTyped, totalChars: result.totalChars }
      return { ok: true, status: 'ok', charsTyped: result.charsTyped, totalChars: result.totalChars, controlType: result.controlType, name: result.name }
    }
    const result = await typeText(request.text, signal)
    if (result.blockedByUac) return { ok: false, error: 'Rechazado: el destino real es un dialogo de UAC -- prohibido sin excepcion.', blockedByUac: true }
    return { ok: !result.interrupted, charsTyped: result.charsTyped, totalChars: result.totalChars, interrupted: result.interrupted }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  } finally {
    endComputerUseAction(request.panelId)
    emitToolStatus(request.panelId, 'keyboard_type', 'done')
  }
}

// Navegador embebido -- mismo esqueleto que computer use (gate + hardConfirm
// SIEMPRE + ejecucion), pero SIN begin/end de overlay (la vista embebida en
// si ya es visible dentro del panel, no hay indicador de pantalla completa
// que mostrar/ocultar). `getMainWindow()` releido en cada handler, nunca
// cacheado.

async function handleBrowserNavigate(
  request: BrowserNavigateRequest
): Promise<{ ok: boolean; title?: string; url?: string; error?: string }> {
  if (!isBrowserControlActiveForPanel(request.panelId)) return { ok: false, error: NOT_BROWSER_CONTROL_ACTIVE_ERROR }
  const approved = await requestHardToolApproval(request.panelId, 'Navegar en el navegador embebido', request.url)
  if (!approved) return { ok: false, error: 'El usuario rechazo la navegacion.' }
  emitToolStatus(request.panelId, 'browser_navigate', 'start')
  try {
    const win = getMainWindow()
    if (!win) return { ok: false, error: 'Ventana principal no disponible.' }
    return await navigateBrowserView(win, request.panelId, request.url)
  } finally {
    emitToolStatus(request.panelId, 'browser_navigate', 'done')
  }
}

async function handleBrowserClick(
  request: BrowserClickRequest
): Promise<{ status: 'ok' | 'not_found' | 'ambiguous' | 'error'; tag?: string; label?: string; candidates?: string[]; error?: string }> {
  if (!isBrowserControlActiveForPanel(request.panelId)) return { status: 'error', error: NOT_BROWSER_CONTROL_ACTIVE_ERROR }
  const detail = request.description ? `Click en: "${request.description}"` : `Click por coordenadas (${request.x}, ${request.y})`
  const approved = await requestHardToolApproval(request.panelId, 'Click en el navegador embebido', detail)
  if (!approved) return { status: 'error', error: 'El usuario rechazo el click.' }
  emitToolStatus(request.panelId, 'browser_click', 'start')
  try {
    const win = getMainWindow()
    if (!win) return { status: 'error', error: 'Ventana principal no disponible.' }
    return await clickInBrowserView(win, request.panelId, request)
  } finally {
    emitToolStatus(request.panelId, 'browser_click', 'done')
  }
}

async function handleBrowserType(
  request: BrowserTypeRequest
): Promise<{ status: 'ok' | 'not_found' | 'ambiguous' | 'error'; tag?: string; label?: string; candidates?: string[]; charsTyped?: number; error?: string }> {
  if (!isBrowserControlActiveForPanel(request.panelId)) return { status: 'error', error: NOT_BROWSER_CONTROL_ACTIVE_ERROR }
  const approved = await requestHardToolApproval(request.panelId, 'Escribir en el navegador embebido', `Campo: "${request.description}"\nTexto: ${request.text}`)
  if (!approved) return { status: 'error', error: 'El usuario rechazo escribir el texto.' }
  emitToolStatus(request.panelId, 'browser_type', 'start')
  try {
    const win = getMainWindow()
    if (!win) return { status: 'error', error: 'Ventana principal no disponible.' }
    return await typeInBrowserView(win, request.panelId, request.description, request.text)
  } finally {
    emitToolStatus(request.panelId, 'browser_type', 'done')
  }
}

async function handleBrowserScreenshot(
  request: BrowserScreenshotRequest
): Promise<{ ok: boolean; dataUrl?: string; width?: number; height?: number; error?: string }> {
  if (!isBrowserControlActiveForPanel(request.panelId)) return { ok: false, error: NOT_BROWSER_CONTROL_ACTIVE_ERROR }
  const approved = await requestHardToolApproval(request.panelId, 'Capturar el navegador embebido', 'El agente quiere ver el contenido actual del navegador embebido.')
  if (!approved) return { ok: false, error: 'El usuario rechazo la captura.' }
  emitToolStatus(request.panelId, 'browser_screenshot', 'start')
  try {
    const win = getMainWindow()
    if (!win) return { ok: false, error: 'Ventana principal no disponible.' }
    return await screenshotBrowserView(win, request.panelId)
  } finally {
    emitToolStatus(request.panelId, 'browser_screenshot', 'done')
  }
}

/** read_image para CLIs: solo lectura, sin gate (ver el comentario del protocolo arriba). El workspace sale de la
 *  sesion VIVA del panel; el confinamiento (lexico + realpath, junctions incluidas) lo aplica ToolRegistry.execute(). */
async function handleReadImage(request: ReadImageRequest): Promise<{ ok: boolean; text?: string; dataUrl?: string; error?: string }> {
  const session = sessionRegistry.get(request.panelId)
  if (!session?.activeWorkspace) return { ok: false, error: 'No hay un workspace activo para este panel.' }
  try {
    const result = await toolRegistry.execute(
      'read_image',
      { path: request.path, region: request.region },
      {
        workspace: session.activeWorkspace,
        sandbox: session.sandbox,
        sessionId: request.panelId,
        // read_image nunca pide aprobacion; si alguna vez lo hiciera, un CLI headless no puede responderla -> se rechaza.
        confirm: () => Promise.resolve(false)
      }
    )
    if (!result.ok || !result.resultImageDataUrl) return { ok: false, error: result.output }
    return { ok: true, text: result.output, dataUrl: result.resultImageDataUrl }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

function handleConnection(socket: Socket): void {
  let buffer = ''

  socket.on('data', chunk => {
    buffer += chunk.toString('utf8')
    const newlineIndex = buffer.indexOf('\n')
    if (newlineIndex === -1) return // linea todavia incompleta, sigue esperando

    const line = buffer.slice(0, newlineIndex)
    const request = parseRequest(line)

    if (!request) {
      socket.end(JSON.stringify({ ok: false, approved: false, error: 'request malformado' }) + '\n')
      return
    }

    // El bloqueo real pasa aca para 'confirm': requestSessionToolApproval()
    // no resuelve hasta que el humano responde en el renderer -- este
    // socket se mantiene abierto todo ese tiempo, sin polling. Para el
    // resto de las actions, el bloqueo es el trabajo real (correr un turno
    // en otro panel, repartir sub-tareas) -- mismo principio.
    const handler =
      request.action === 'confirm'
        ? handleConfirm(request)
        : request.action === 'sendToWindow'
          ? handleSendToWindow(request)
          : request.action === 'planParallelAsk'
            ? handlePlanParallelAsk(request)
            : request.action === 'runParallelAsk'
              ? handleRunParallelAsk(request)
              : request.action === 'computerUseScreenshot'
                ? handleComputerUseScreenshot(request)
                : request.action === 'computerUseMouseMove'
                  ? handleComputerUseMouseMove(request)
                  : request.action === 'computerUseMouseClick'
                    ? handleComputerUseMouseClick(request)
                    : request.action === 'computerUseKeyboardType'
                      ? handleComputerUseKeyboardType(request)
                      : request.action === 'browserNavigate'
                        ? handleBrowserNavigate(request)
                        : request.action === 'browserClick'
                          ? handleBrowserClick(request)
                          : request.action === 'browserType'
                            ? handleBrowserType(request)
                            : request.action === 'readImage'
                              ? handleReadImage(request)
                              : handleBrowserScreenshot(request)

    handler
      .then(response => socket.end(JSON.stringify(response) + '\n'))
      .catch(() => socket.end(JSON.stringify({ ok: false, approved: false, error: 'fallo interno resolviendo el pedido' }) + '\n'))
  })

  socket.on('error', () => {}) // conexion cortada del otro lado (proceso hijo matado, etc.) -- no tira la app
}

/** Arranca el listener UNA sola vez por vida de la app -- llamado desde
 *  index.ts al arrancar, mismo momento que la limpieza garantizada de
 *  Antigravity. Nunca lanza: si el pipe no se pudo abrir (instancia previa
 *  no cerro bien, o el nombre ya esta en uso), loguea y sigue -- no
 *  bloquea el arranque real de Amatista por esto. */
export function startMcpApprovalPipeServer(): void {
  const server = createServer(handleConnection)
  server.on('error', error => {
    console.error('[mcp-approval-pipe] no se pudo arrancar el listener:', error)
  })
  server.listen(MCP_APPROVAL_PIPE_PATH)
}
