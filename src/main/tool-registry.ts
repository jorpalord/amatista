import { clipboard, Notification, shell } from 'electron'
import { clickAt, clickByDescription, describeCoordinateTarget, moveMouseTo, takeScreenshot, typeByDescription, typeText } from './computer-use-actions'
import { exec, execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { detectDocumentFormat, readDocument } from './document-reader'
import { EXPLORE_TOOL_NAMES, runExploreLoop } from './explore-tool'
import { listFileHistory, readFileVersion, snapshotOriginalIfNeeded, commitVersion } from './local-vcs'
// Fase 16: mismo criterio de exclusion de directorios ruidosos que ya usa
// el explorador de archivos del sidebar — una sola lista, no una segunda
// coincidente. MAX_TEXT_FILE_BYTES tambien se reusa para no intentar leer
// como texto un archivo gigante/binario durante el fallback manual.
import { ignoredDirectories, MAX_TEXT_FILE_BYTES } from './workspace-tree'
import { languageServerConfigFor } from './lsp-client'
import type { LspManager, LspSymbolsResult } from './lsp-manager'
import type { WebFetchResult, WebSearchResult } from './web-search'
import type { TerminalCommandResult } from './terminal-manager'
import { getSkillBody } from './skill-manager'
// Orquestador paralelo (docs/_arch/verify_parallel_orchestrator_design.md):
// SOLO tipos -- `import type` se erasa por completo en la compilacion, cero
// require() real en el bundle final. Mismo criterio exacto ya documentado
// para ExecuteContext.sendToWindowByTitle mas abajo: un import de VALOR
// desde este archivo hacia parallel-orchestrator.ts (que si importa
// ipc-agent.ts) cerraria un ciclo real (runtime-state.ts -> tool-registry.ts
// -> parallel-orchestrator.ts -> ipc-agent.ts -> runtime-state.ts) -- un
// import de solo-tipos nunca genera esa arista en tiempo de ejecucion.
import type { ParallelAskOutcome, ParallelSubtaskAssignment } from './parallel-orchestrator'
import type { ChatAttachment, ModelProfile, ProviderProfile, SandboxMode, TodoItem, TodoList } from '../shared/types'

/**
 * Tool "todo_write" (docs/_arch/verify_todo_write_design.md): primera tool
 * con un parametro `array` de objetos -- confirmado con grep antes de
 * implementar que ninguna entrada anterior lo necesitaba, `{type, description}`
 * plano alcanzaba para todas. Recursivo (JSON Schema real, acotado a lo que
 * hace falta): `enum` para strings restringidos (status/priority),
 * `items`/`properties`/`required` para describir el shape de cada elemento
 * de un array de objetos -- todos opcionales, no rompe ninguna entrada
 * existente (que solo usa `type`/`description`).
 */
export interface ToolPropertySchema {
  type: string
  description?: string
  enum?: string[]
  items?: ToolPropertySchema
  properties?: Record<string, ToolPropertySchema>
  required?: string[]
}

export interface ToolDefinition {
  name: string
  description: string
  parameters: {
    type: 'object'
    properties: Record<string, ToolPropertySchema>
    required: string[]
  }
}

export interface ToolExecutionResult {
  ok: boolean
  output: string
  /** Fase 19: conteo +X/-Y del mismo computeLineDiff() ya calculado para el
   *  dialogo de aprobacion (write_file/apply_patch) -- nunca un segundo
   *  calculo. Solo poblado en el resultado exitoso de esas 2 tools; el
   *  resto la deja undefined. Consumido por ApiAgentRuntime.runTool() para
   *  el evento 'toolStatus' (log de actividad en vivo), nunca llega al
   *  modelo (eso sigue siendo solo `output`). */
  lineDiff?: { added: number; removed: number }
  /** Feature "generacion de imagenes": ChatAttachment ya completo (mismo
   *  shape que buildAttachmentFromDataUrl() devuelve, con origin:'generated'
   *  estampado), poblado SOLO por generate_image en su resultado exitoso.
   *  Mismo criterio que lineDiff -- NUNCA llega al modelo (`output` sigue
   *  siendo el unico texto real, ej. "Imagen generada."), es un canal
   *  lateral consumido por ApiAgentRuntime.runTool() para acumularlo hasta
   *  el final del turno (this.generatedAttachments) y terminar colgado del
   *  mensaje final del asistente. */
  generatedAttachment?: ChatAttachment
  /** Tool read_document: PNG real (data URL completo, mismo formato que
   *  attachments.ts) de una pagina de PDF sin texto extraible (Tarea 4 de
   *  docs/_arch/verify_read_document_tool.md). A DIFERENCIA de
   *  generatedAttachment, este campo SI llega al modelo -- ver su consumo
   *  en sendAnthropicApi() (api-agent-runtime.ts), unico runtime cuyo
   *  formato de tool_result soporta bloques de imagen (confirmado real:
   *  OpenAI Chat Completions y Foundry/Gemini no aceptan imagenes dentro de
   *  un mensaje de rol tool/function, solo Anthropic). En los otros 3
   *  runtimes este campo se ignora -- `output` ya incluye una nota de texto
   *  explicita avisando que la pagina es escaneada y no se pudo adjuntar
   *  como imagen en ese runtime, nunca se pierde la senal en silencio. */
  resultImageDataUrl?: string
}

export type ConfirmFn = (title: string, detail: string) => Promise<boolean>

interface ExecuteContext {
  workspace: string
  confirm: ConfirmFn
  /**
   * Tools de sistema Windows (docs/_arch/verify_windows_control_design.md,
   * S1-S3): SOLO para close_app/lock_screen/power -- guardia monotona real,
   * closure inyectada por ipc-agent.ts sobre requestHardToolApproval()
   * (runtime-state.ts), NUNCA sobre requestSessionToolApproval() (que es lo
   * que `confirm` de arriba usa). A diferencia de `confirm`, esta NUNCA se
   * llama via resolveApproval() -- las 3 tools que la usan llaman a
   * ctx.hardConfirm() DIRECTO e incondicional, mismo patron exacto que
   * send_to_window/generate_image/web_search ya usan con `confirm` (ctx.confirm()
   * directo, sin pasar por resolveApproval()/sandbox), pero con la garantia
   * ADICIONAL real de que ni `danger-full-access` ni `toolTrustSession` ya
   * activa (de una aprobacion previa de CUALQUIER otra tool) pueden
   * saltear el dialogo -- ver requestHardToolApproval() para el mecanismo
   * completo. Opcional, mismo criterio que el resto de esta interfaz: sin
   * este campo, las 3 tools devuelven un error claro en vez de ejecutar
   * sin confirmar (NUNCA cae a `confirm` como fallback -- degradar la
   * guardia en silencio seria peor que fallar).
   */
  hardConfirm?: ConfirmFn

  /**
   * Familia A (computer use, docs/_arch/verify_computer_use_security_model.md,
   * Tarea 1) -- Capa 1: snapshot FRESCO de `session.computerUseActive` en
   * CADA llamada (closure de ipc-agent.ts sobre `session`, mismo criterio
   * exacto que `sandbox` mas arriba -- nunca capturado una sola vez al
   * conectar). Si es `false`, las 4 tools de computer use bloquean de raiz,
   * SIN llamar a `hardConfirm` -- mismo principio que `resolveApproval()`
   * bloqueando de raiz en sandbox 'read-only' sin llamar a `confirm`.
   */
  computerUseActive?: boolean
  /**
   * Familia A, Tarea 5 (cancelacion no-cooperativa) -- `session.turnAbortSignal`
   * fresco, mismo campo real ya usado por `runParallelAsk`
   * (docs/_arch/verify_origin_signal_design.md). Las 4 tools lo pasan a
   * `computer-use-actions.ts` para que el loop interno de micro-pasos
   * (interpolacion de mouse, caracter por caracter de teclado) pueda
   * cortar a mitad de camino si el turno se cancela mientras la accion
   * esta en curso.
   */
  computerUseAbortSignal?: AbortSignal
  /**
   * Familia A, Tarea 3 (indicador visual obligatorio) -- closures sobre
   * `beginComputerUseAction(panelId)`/`endComputerUseAction(panelId)`
   * (runtime-state.ts). Llamados alrededor de la EJECUCION real (nunca
   * alrededor del `hardConfirm`, que puede tardar indefinido esperando al
   * humano -- el overlay solo debe verse mientras la accion esta
   * EJECUTANDOSE de verdad, no mientras espera aprobacion).
   */
  computerUseBegin?: () => void
  computerUseEnd?: () => void

  /**
   * Navegador embebido (docs/_arch/verify_embedded_browser_design.md,
   * Tarea 3) -- Capa 1: snapshot fresco de `session.browserControlActive`
   * en cada llamada, mismo criterio exacto que `computerUseActive` de
   * arriba. Las 4 tools de navegador bloquean de raiz si es `false`, sin
   * llamar a `hardConfirm`.
   */
  browserControlActive?: boolean
  /**
   * Navegador embebido -- las 4 acciones reales (`embedded-browser.ts`),
   * cerradas por ipc-agent.ts sobre `getMainWindow()`/`panelId` de ESTA
   * sesion. Devuelven datos crudos (nunca texto ya formateado) -- mismo
   * criterio ya establecido en este archivo: el "case" de cada tool arma
   * su propio texto de salida, la ejecucion real solo devuelve datos.
   */
  browserNavigate?: (url: string) => Promise<{ ok: boolean; title?: string; url?: string; error?: string }>
  browserClick?: (opts: { description?: string; x?: number; y?: number; button?: 'left' | 'right' }) => Promise<{
    status: 'ok' | 'not_found' | 'ambiguous' | 'error'
    tag?: string
    label?: string
    candidates?: string[]
    error?: string
  }>
  browserType?: (description: string, text: string) => Promise<{
    status: 'ok' | 'not_found' | 'ambiguous' | 'error'
    tag?: string
    label?: string
    candidates?: string[]
    charsTyped?: number
    error?: string
  }>
  browserScreenshot?: () => Promise<{ ok: boolean; dataUrl?: string; width?: number; height?: number; error?: string }>
  /**
   * Fase 12: modo activo de la conexion (agent:connect → payload.sandbox),
   * antes SOLO se conectaba hasta cli-agent-runtime.ts — read_file/list_dir/
   * git_status/git_diff/list_file_history nunca lo consultan (siempre
   * permitidas, en cualquier modo); las 4 acciones sensibles de este
   * archivo (write_file/apply_patch/run_command/revert_file) y el dispatch
   * de tools MCP en api-agent-runtime.ts SI lo consultan, via
   * resolveApproval() mas abajo. Ver docs/_arch/CONTRACT.md → "Sandbox
   * mode no aplicado en runtimes API (Fase 12)".
   */
  sandbox: SandboxMode
  /**
   * Resuelve el modelo barato configurado (Fase 3: compactionProviderId/
   * compactionModelId) FRESCO en cada llamada — null si no hay uno elegido
   * o el elegido ya no es valido. Lo provee ipc-agent.ts al armar el
   * toolExecutor de la conexion (unico lugar con acceso a `settings`);
   * opcional para no romper otros llamadores hipoteticos de execute() —
   * sin este campo, la tool "explore" devuelve un error claro en vez de
   * fallar (Tarea 3 de Fase 4).
   */
  resolveExploreModel?: () => { provider: ProviderProfile; model: ModelProfile } | null
  /**
   * Fase 20 — SOLO runtimes API (foundry/anthropic-api/gemini-api/openai-
   * chat), lo mismo que resolveExploreModel de arriba: opcional para no
   * romper otros llamadores hipoteticos de execute() (ej. explore-tool.ts,
   * que arma su propio ExecuteContext reducido y nunca necesita LSP).
   * write_file/apply_patch lo usan fire-and-forget (notifyFileWritten) para
   * mantener el language server al tanto del contenido real sin bloquear
   * la escritura; get_diagnostics lo usa para leer/esperar el resultado.
   */
  lspManager?: LspManager

  /**
   * Mensajeria entre ventanas, Paso 3: SOLO para la tool send_to_window.
   * Closure inyectada por ipc-agent.ts (agent:connect, mismo punto que
   * `confirm`/`resolveExploreModel`/`lspManager` arriba), cerrada sobre el
   * panelId de ESTA sesion (el ORIGEN del envio) -- la orquestacion real
   * (resolver titulo -> chatId -> panel conectado, correr el turno,
   * entregar el resultado) vive en
   * cross-window-messaging.ts (sendToWindowByTitle()), NO aca: tool-
   * registry.ts no importa ese modulo directo a proposito, para no crear
   * un ciclo de valores con runtime-state.ts (que ya importa la clase
   * ToolRegistry de este archivo) mas alla del que ipc-agent.ts <->
   * cross-window-messaging.ts ya acepta (ver ese archivo). Opcional, mismo
   * criterio que resolveExploreModel: sin este campo (llamador hipotetico
   * que arma su propio ExecuteContext reducido, ej. explore-tool.ts), la
   * tool devuelve un error claro en vez de fallar.
   */
  sendToWindowByTitle?: (title: string, message: string) => Promise<{ ok: true; text: string } | { ok: false; error: string }>

  /**
   * Orquestador paralelo (docs/_arch/verify_parallel_orchestrator_design.md,
   * Tarea 1/2): SOLO para la tool parallel_ask. La planificacion en SI
   * (dentro de parallel-orchestrator.ts) es sincrona -- resuelve que panel
   * idle le toca a cada sub-tarea AHORA MISMO, sin disparar ningun turno
   * todavia -- pero esta closure devuelve una Promise porque ipc-agent.ts
   * la resuelve via import() dinamico (mismo motivo de ciclo que
   * sendToWindowByTitle, ver ahi), nunca por trabajo async real propio.
   * tool-registry.ts usa el resultado para armar el detalle completo del
   * dialogo de aprobacion (Tarea 5) ANTES de llamar a ctx.confirm() -- mismo
   * orden que send_to_window (aprobar antes de ejecutar), pero acá el contenido del dialogo depende de un calculo
   * real (que panel/modelo le toca a cada sub-tarea), no solo de eco de los
   * args del modelo. Cerrada por ipc-agent.ts sobre el panelId de ESTA
   * sesion (el ORIGEN del reparto, nunca elegible como destino). Mismo
   * criterio de opcionalidad que el resto de esta interfaz.
   */
  planParallelAsk?: (subtasks: string[]) => Promise<{ ok: true; assignments: ParallelSubtaskAssignment[] } | { ok: false; error: string }>

  /**
   * Orquestador paralelo: EJECUCION real -- llamada DESPUES de que
   * tool-registry.ts ya obtuvo la aprobacion via ctx.confirm(). Cerrada por
   * ipc-agent.ts sobre el AbortSignal del turno de origen (Tarea 4/6:
   * cancelar el turno que llamo a parallel_ask cascada el cancel a los
   * sub-turnos hijos en vuelo, via cancelSessionTurn() por panel -- ver
   * parallel-orchestrator.ts). Promise.allSettled real por dentro: una
   * sub-tarea que falla nunca aborta a las demas.
   */
  runParallelAsk?: (assignments: ParallelSubtaskAssignment[]) => Promise<ParallelAskOutcome[]>

  /**
   * UI Paso 1: SOLO para la tool list_windows. Closure inyectada por
   * ipc-agent.ts (agent:connect, mismo punto que sendToWindowByTitle
   * arriba), ya resuelta contra chat-store.ts + settings.providers -- el
   * modelo recibe texto legible (`"Foundry gpt-5.4"`), nunca ids crudos.
   * Sincrona (a diferencia de sendToWindowByTitle): solo lee SQLite +
   * memoria, sin ningun await real involucrado.
   */
  listWindows?: () => Array<{ title: string; status: string; alias?: string }>

  /**
   * Feature "generacion de imagenes": SOLO para la tool generate_image.
   * Closure inyectada por ipc-agent.ts (agent:connect, mismo punto que
   * resolveExploreModel/sendToWindowByTitle arriba), cerrada sobre
   * `settings` fresco (no capturado una vez al conectar) -- si el usuario
   * cambia el modelo de generacion en Settings a mitad de la conexion, la
   * proxima llamada ya usa el nuevo, mismo criterio que resolveExploreModel.
   * Hace la llamada real a /images/generations (image-generation.ts) y
   * devuelve el ChatAttachment ya armado. Opcional, mismo criterio que el
   * resto de los campos de esta interfaz: sin este campo (llamador
   * hipotetico con un ExecuteContext reducido), la tool devuelve un error
   * claro en vez de fallar.
   */
  generateImage?: (prompt: string) => Promise<{ ok: true; attachment: ChatAttachment } | { ok: false; error: string }>

  /**
   * Feature "busqueda web" (docs/_arch/verify_web_search_design.md): SOLO
   * para web_search/web_fetch. Closures inyectadas por ipc-agent.ts (mismo
   * punto que generateImage arriba), cerradas sobre `settings` fresco --
   * mismo criterio que generateImage/resolveExploreModel: si el usuario
   * agrega/cambia la API key de Tavily en Configuracion a mitad de
   * conexion, la proxima llamada ya la ve. El GATING real (si la tool
   * aparece o no en el catalogo del modelo) vive en
   * ApiAgentRuntime.toolCatalog(), no aca -- estos campos solo ejecutan la
   * llamada real una vez que el modelo ya decidio invocarlas. Opcional,
   * mismo criterio que el resto de esta interfaz.
   */
  webSearch?: (query: string, maxResults?: number) => Promise<{ ok: true; result: WebSearchResult } | { ok: false; error: string }>
  webFetch?: (url: string) => Promise<{ ok: true; result: WebFetchResult } | { ok: false; error: string }>

  /**
   * Fix real de TOCTOU (docs/_arch/verify_toctou_fix_design.md, basado en
   * el Hallazgo 1 de verify_external_review_findings.md): identificador
   * real y estable de ESTA sesion/conexion -- el mismo `panelId` que ya se
   * usa para requestSessionToolApproval()/sendSessionEvent() en el resto
   * del codebase, closure inyectada por ipc-agent.ts. read_file lo usa
   * para registrar que hash de contenido vio el modelo en
   * ToolRegistry.sessionFileHashes (por sesion, no global); write_file/
   * apply_patch lo usan para auditar contra ESE hash en vez de contra el
   * leido fresco al entrar. Opcional, mismo criterio que el resto de esta
   * interfaz: sin este campo (llamador hipotetico con un ExecuteContext
   * reducido, ej. explore-tool.ts, que nunca escribe archivos), read_file/
   * write_file/apply_patch caen al comportamiento sin registro (ver
   * comentario de sessionFileHashes mas abajo) -- nunca fallan por su
   * ausencia.
   */
  sessionId?: string

  /**
   * Tool "todo_write" (docs/_arch/verify_todo_write_design.md): closure
   * inyectada por ipc-agent.ts, cerrada sobre `session` (el objeto mutable
   * de la conexion, no una copia) -- mismo criterio "fresco sobre session"
   * ya usado por listWindows arriba: lee `session.activeChatId` en el
   * momento en que la tool se ejecuta, no el que tenia la sesion al
   * conectar (confirmado real que puede cambiar entre turnos, ver
   * runTurnForWindow() en ipc-agent.ts). Sin chat activo (nunca deberia
   * pasar en un turno real, pero no se asume), devuelve error claro en vez
   * de escribir contra un chatId invalido. Opcional, mismo criterio que el
   * resto de esta interfaz.
   */
  writeTodos?: (todos: TodoList) => { ok: true } | { ok: false; error: string }

  /**
   * "Modo plan" (docs/_arch/verify_plan_mode_design.md): closure inyectada
   * por ipc-agent.ts, SOLO para la tool exit_plan_mode -- llama a
   * disablePlanMode() (runtime-state.ts) DESPUES de que ctx.confirm() ya
   * aprobo el plan (el case de la tool, mas abajo, es responsable de ese
   * orden). Mismo criterio "closure sobre session" que writeTodos arriba --
   * no hace falta leer nada fresco aca (a diferencia de session.activeChatId),
   * el panelId de esta sesion ya es fijo. Opcional, mismo criterio que el
   * resto de esta interfaz.
   */
  exitPlanMode?: () => void

  /**
   * Tool "terminal_exec" (docs/_arch/verify_persistent_terminal_design.md):
   * closure inyectada por ipc-agent.ts, cerrada sobre la instancia real de
   * TerminalManager de ESTA conexion (mismo criterio que lspManager arriba,
   * pero como closure porque terminal_exec no necesita ningun otro metodo
   * del manager, a diferencia de LspManager que write_file/apply_patch/
   * get_diagnostics consultan de varias formas). El proceso cmd.exe real
   * recien se spawnea en la PRIMERA llamada (arranque perezoso, dentro del
   * propio manager). Opcional, mismo criterio que el resto de esta
   * interfaz.
   */
  terminalExec?: (command: string) => Promise<TerminalCommandResult>
}

/**
 * Fase 12: unico punto que resuelve si una accion sensible se ejecuta,
 * segun el sandbox mode activo — reusado por las 4 acciones de este
 * archivo (write_file/apply_patch/run_command/revert_file) y por el
 * dispatch de tools MCP en api-agent-runtime.ts, en vez de repetir este
 * if/else de 3 ramas en cada uno. Mismo criterio que cli-agent-runtime.ts
 * ya aplica para runtimes CLI (--permission-mode/--approval-mode):
 *  - 'read-only': bloquea de raiz, SIN llamar a `confirm` — no hay nada
 *    que aprobar si la accion esta prohibida por el modo activo.
 *  - 'workspace-write': comportamiento de siempre, pide `confirm`.
 *  - 'danger-full-access': saltea `confirm` y aprueba directo, igual que
 *    --dangerously-skip-permissions/yolo ya hacen en runtimes CLI.
 */
export async function resolveApproval(
  sandbox: SandboxMode,
  confirm: ConfirmFn,
  title: string,
  detail: string
): Promise<boolean> {
  if (sandbox === 'read-only') return false
  if (sandbox === 'danger-full-access') return true
  return confirm(title, detail)
}

/** Fix real de staleness (docs/_arch/verify_concurrent_write_staleness.md):
 *  huella de contenido para write_file/apply_patch -- mismo primitivo
 *  (createHash('sha256'), node:crypto) que local-vcs.ts ya usa para otra
 *  cosa (hashear la ruta del workspace, no contenido de archivo), sin
 *  tocar ese uso existente. null se hashea aparte de '' (string vacio
 *  real) -- un archivo que no existia todavia (write_file creando uno
 *  nuevo) y un archivo vacio de verdad son 2 estados distintos, no deben
 *  colisionar al mismo hash. */
// guard/ Pieza 2 (docs/_arch/verify_guard_design.md, Tarea 4): exportada --
// antes privada de este modulo, ahora reusada por api-agent-runtime.ts para
// hashear args/resultado COMPLETOS de cada tool call (loop-hygiene). Mismo
// primitivo, cero cambio de comportamiento para los usos existentes
// (TOCTOU de read_file/write_file/apply_patch/revert_file, todos dentro de
// este archivo).
export function hashFileContent(content: string | null): string {
  return createHash('sha256').update(content === null ? '\0__AMATISTA_NULL__\0' : content).digest('hex')
}

/** Mensaje de rechazo cuando resolveApproval() bloquea por 'read-only' —
 *  distinto del mensaje de "el usuario rechazo", que sigue aplicando solo
 *  en 'workspace-write' cuando el usuario efectivamente dice que no. */
export function readOnlyBlockedMessage(action: string): string {
  return `Modo de solo lectura activo: no se puede ${action}.`
}

/**
 * Orquestador paralelo (docs/_arch/verify_parallel_orchestrator_design.md,
 * Tarea 5): texto completo para el dialogo de aprobacion -- cada sub-tarea
 * con el panel/modelo real que ctx.planParallelAsk() le asigno, para que el
 * usuario juzgue el costo real (N llamadas reales, potencialmente a
 * proveedores de costo heterogeneo) ANTES de aprobar. Formato de
 * presentacion, deliberadamente en tool-registry.ts (no en
 * parallel-orchestrator.ts) -- mismo criterio ya establecido en este
 * archivo de que el "case" de cada tool arma su propio texto de salida
 * (ver send_to_window/generate_image), la orquestacion real solo devuelve
 * datos.
 */
function formatParallelPlanDetail(assignments: ParallelSubtaskAssignment[]): string {
  return assignments
    .map((a, i) => `${i + 1}. [${a.panelLabel} -- ${a.modelLabel}] ${a.subtask}`)
    .join('\n\n')
}

/** Orquestador paralelo (Tarea 4): agrega N ParallelAskOutcome a un unico
 *  string -- un bloque por sub-tarea, encabezado con el panel/modelo real
 *  que la resolvio (o "FALLO" + el motivo si no). Siempre parcial-tolerante
 *  -- ninguna sub-tarea fallida omite las demas del texto agregado. */
function formatParallelAskOutput(outcomes: ParallelAskOutcome[]): string {
  const blocks = outcomes.map((outcome, index) => {
    const header = outcome.ok
      ? `## Sub-tarea ${index + 1} -- resuelta por ${outcome.panelLabel} (${outcome.modelLabel})`
      : `## Sub-tarea ${index + 1} -- FALLO (${outcome.panelLabel} -- ${outcome.modelLabel})`
    const body = outcome.ok ? (outcome.text ?? '') : (outcome.error ?? 'Error desconocido.')
    return `${header}\n${body}`
  })
  return `Resultados de ${outcomes.length} sub-tarea(s) en paralelo:\n\n${blocks.join('\n\n')}`
}

const RUN_COMMAND_TIMEOUT_MS = 30_000
// guard/ Pieza 1 (docs/_arch/verify_guard_design.md, Tarea 1): read_document
// era el segundo hueco confirmado sin timeout (document-reader.ts no tenia
// ningun setTimeout). 30s de default -- mismo orden de magnitud que
// run_command (30s), no los 60s de MCP: es parseo local de un archivo ya
// resuelto dentro del workspace, no un proceso externo arbitrario que
// pueda hacer trabajo legitimo mas lento. Mismo patron de override que
// MAX_TOOL_LOOP/MCP_TOOL_TIMEOUT_MS: env var opcional, sin tocar el
// default de la app instalada.
const READ_DOCUMENT_TIMEOUT_MS = Number(process.env.AMATISTA_READ_DOCUMENT_TIMEOUT_MS) || 30_000

/**
 * guard/ Pieza 1: wrapper generico para cerrar un hueco de timeout sobre
 * una promesa que hoy no lo tiene (read_document) -- Promise.race contra un
 * timer que rechaza con el mensaje dado, sin tocar la promesa original (si
 * gana la promesa, el timer se limpia con clearTimeout y no hace nada).
 * Limitacion real, ya documentada en verify_guard_design.md: si el trabajo
 * colgado fuera CPU-bound 100% sincrono (sin ningun await real adentro),
 * este wrapper no lo corta de verdad -- el timer no puede dispararse hasta
 * que el hilo unico de JS quede libre, que es justo lo que un colgado
 * sincrono nunca cede. Cierra el hueco para el caso real esperable (I/O
 * async dentro de las librerias de parseo de PDF/DOCX/XLSX/HTML), no un
 * kill duro de CPU -- mismo alcance que un `AbortController` tampoco
 * resolveria mejor para este caso concreto.
 */
function raceTimeout<T>(promise: Promise<T>, timeoutMs: number, timeoutMessage: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(timeoutMessage)), timeoutMs)
    promise.then(
      value => { clearTimeout(timer); resolve(value) },
      error => { clearTimeout(timer); reject(error) }
    )
  })
}

const MAX_TOOL_OUTPUT_CHARS = 20_000
const MAX_DIFF_PREVIEW_CHARS = 8_000
const DIFF_CONTEXT_LINES = 2
/** Fase 16: tope EXPLICITO de matches de search_files, independiente del
 *  clip por caracteres (MAX_TOOL_OUTPUT_CHARS) — un patron muy comun (ej.
 *  "import") puede tener miles de matches reales; 200 alcanza para que el
 *  modelo vea el patron de donde aparece sin inundar el contexto, y si
 *  hace falta mas puede acotar con el parametro "path". */
const SEARCH_FILES_MAX_MATCHES = 200

interface DiffLine {
  type: 'add' | 'remove' | 'context'
  text: string
}

/**
 * Diff linea por linea via LCS (programacion dinamica clasica O(n*m), no
 * hace falta Myers para esto — es solo para el dialogo de aprobacion, no
 * para aplicar el patch). Suficiente para los tamanios de archivo tipicos
 * que un agente edita; MAX_DIFF_PREVIEW_CHARS acota el peor caso.
 */
function computeLineDiff(oldText: string, newText: string): DiffLine[] {
  const oldLines = oldText.split('\n')
  const newLines = newText.split('\n')
  const n = oldLines.length
  const m = newLines.length
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = oldLines[i] === newLines[j]
        ? dp[i + 1][j + 1] + 1
        : Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  }

  const result: DiffLine[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (oldLines[i] === newLines[j]) {
      result.push({ type: 'context', text: oldLines[i] })
      i++
      j++
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      result.push({ type: 'remove', text: oldLines[i] })
      i++
    } else {
      result.push({ type: 'add', text: newLines[j] })
      j++
    }
  }
  while (i < n) { result.push({ type: 'remove', text: oldLines[i] }); i++ }
  while (j < m) { result.push({ type: 'add', text: newLines[j] }); j++ }
  return result
}

/**
 * Texto plano con prefijo +/-/" " por linea (el mismo formato que
 * consume el toggle de color en el renderer). Colapsa tramos largos sin
 * cambios a solo DIFF_CONTEXT_LINES antes/despues de cada bloque
 * modificado, con un separador "⋮" entre bloques no contiguos — un
 * archivo de 500 lineas con 3 cambiadas no se muestra completo.
 */
function buildDiffPreview(diffLines: DiffLine[]): string {
  const out: string[] = []
  let i = 0
  let lastShownEnd = -1
  while (i < diffLines.length) {
    if (diffLines[i].type === 'context') { i++; continue }
    let end = i
    while (end < diffLines.length && diffLines[end].type !== 'context') end++
    const contextStart = Math.max(0, i - DIFF_CONTEXT_LINES)
    const contextEnd = Math.min(diffLines.length, end + DIFF_CONTEXT_LINES)
    if (contextStart > lastShownEnd + 1) {
      if (lastShownEnd >= 0) out.push('  ⋮')
    }
    const from = Math.max(contextStart, lastShownEnd + 1)
    for (let k = from; k < contextEnd; k++) {
      const line = diffLines[k]
      const prefix = line.type === 'add' ? '+' : line.type === 'remove' ? '-' : ' '
      out.push(`${prefix}${line.text}`)
    }
    lastShownEnd = contextEnd - 1
    i = end
  }
  return out.join('\n')
}

/** Cuenta lineas add/remove de un DiffLine[] YA calculado (Fase 19) -- nunca
 *  recorre el contenido de nuevo, solo tabula el resultado de
 *  computeLineDiff() que formatWriteFileDiff() ya armo para el dialogo de
 *  aprobacion. */
function countLineChanges(diffLines: DiffLine[]): { added: number; removed: number } {
  let added = 0
  let removed = 0
  for (const line of diffLines) {
    if (line.type === 'add') added++
    else if (line.type === 'remove') removed++
  }
  return { added, removed }
}

/**
 * Detail del dialogo de aprobacion de write_file: diff real contra el
 * contenido en disco (null = archivo nuevo, todo en verde/"+"). Fase 19:
 * ahora tambien devuelve el conteo +X/-Y del MISMO DiffLine[] usado para el
 * preview -- write_file/apply_patch lo reusan para el evento 'toolStatus'
 * en vez de recalcular el diff una segunda vez.
 */
function formatWriteFileDiff(existingContent: string | null, newContent: string): { preview: string; added: number; removed: number } {
  const { raw, added, removed } = existingContent === null
    ? { raw: newContent.split('\n').map(line => `+${line}`).join('\n'), added: newContent.split('\n').length, removed: 0 }
    : (() => {
      const diffLines = computeLineDiff(existingContent, newContent)
      return { raw: buildDiffPreview(diffLines), ...countLineChanges(diffLines) }
    })()

  const preview = raw.length <= MAX_DIFF_PREVIEW_CHARS
    ? raw
    : `${raw.slice(0, MAX_DIFF_PREVIEW_CHARS)}\n  ⋮ [diff recortado, se omitieron ${raw.length - MAX_DIFF_PREVIEW_CHARS} caracteres...]`
  return { preview, added, removed }
}

/**
 * Indexacion por simbolos: valores reales del enum SymbolKind del spec LSP
 * -- list_symbols los devuelve tal cual (numero) desde LspClient, esta
 * tabla es SOLO de presentacion (tool-registry.ts, para que el modelo lea
 * "Function"/"Class" en vez de un numero pelado). No todos los valores del
 * spec real se usan en la practica por los 4 servidores integrados, pero se
 * lista el enum completo (1-26) para no dar `kind N` generico en casos
 * raros.
 */
const LSP_SYMBOL_KIND_LABELS: Record<number, string> = {
  1: 'File', 2: 'Module', 3: 'Namespace', 4: 'Package', 5: 'Class', 6: 'Method',
  7: 'Property', 8: 'Field', 9: 'Constructor', 10: 'Enum', 11: 'Interface',
  12: 'Function', 13: 'Variable', 14: 'Constant', 15: 'String', 16: 'Number',
  17: 'Boolean', 18: 'Array', 19: 'Object', 20: 'Key', 21: 'Null',
  22: 'EnumMember', 23: 'Struct', 24: 'Event', 25: 'Operator', 26: 'TypeParameter'
}

/**
 * Fase 1 del benchmark (docs/_arch/verify_benchmark_instrumentation.md,
 * caso (d) real encontrado en la categorizacion de referencias a Windows):
 * la shell real que exec()/execFile() invocan por default depende del
 * SO real del proceso -- cmd.exe en Windows, /bin/sh en Linux/macOS
 * (comportamiento nativo de Node, no algo que esta app configure). El
 * hint de sintaxis Windows (dir/type/del/%VAR%) SOLO es correcto y util
 * en Windows -- corriendo en Linux (ej. el harness del benchmark en
 * Praxis Liber), decirle al modelo que use esa sintaxis seria
 * activamente incorrecto (esos comandos no existen en un shell POSIX
 * real). Se evalua UNA vez al cargar el modulo (process.platform no
 * cambia durante la vida del proceso) -- '' en cualquier plataforma que
 * no sea Windows, el modelo ya usa sintaxis POSIX por defecto sin
 * necesitar un hint contrario explicito.
 */
const RUN_COMMAND_SHELL_HINT = process.platform === 'win32'
  ? ' IMPORTANTE: la shell real es Windows (cmd.exe por default), no Unix/Linux/macOS — usa equivalentes de ' +
    'Windows: "dir" en vez de "ls", "cd" sin argumentos en vez de "pwd" para ver el directorio actual, ' +
    '"type" en vez de "cat", "del"/"rmdir" en vez de "rm", "copy"/"xcopy" en vez de "cp", "%VAR%" en vez de ' +
    '"$VAR" para variables de entorno. Evita sintaxis Unix (pipes con comandos Unix-only, globs de shells ' +
    'POSIX, etc.) salvo que el proyecto tenga explicitamente Git Bash u otra shell POSIX disponible y lo ' +
    'hayas confirmado antes (por ejemplo detectando un shebang, un Makefile, o que el usuario lo haya dicho).'
  : ''

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: 'read_file',
    description: 'Lee el contenido de un archivo de texto dentro del workspace activo.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Ruta relativa al workspace del archivo a leer.' }
      },
      required: ['path']
    }
  },
  {
    name: 'read_document',
    description:
      'Lee un documento PDF/.docx/.xlsx/.html/.htm de a UNA pagina/fragmento por vez -- nunca el documento ' +
      'completo de una sola llamada, a proposito: un documento real de 200-400 paginas no entra en ninguna ' +
      'ventana de contexto sin importar el modelo (ver docs/_arch/verify_large_documents.md). El resultado ' +
      'siempre incluye totalUnits (cuantas paginas/fragmentos tiene el documento entero) y unitIndex (cual ' +
      'devolvio esta llamada) -- pedi la siguiente subiendo "page" de a uno hasta cubrir todo lo que necesites, ' +
      'nunca asumas que un solo llamado trajo todo el contenido. El significado de "page" depende del formato: ' +
      'en PDF es la pagina REAL del archivo; en .docx/.xlsx/.html es el indice de un fragmento de tamano fijo ' +
      '(officeParser no pagina estos formatos de forma nativa, los parte en fragmentos parejos) -- la metadata ' +
      'de la respuesta (pageNumber/sheetName cuando esten presentes) te dice a que parte real del documento ' +
      'original corresponde ese fragmento. Caso especial de PDF: si una pagina no tiene NADA de texto ' +
      'extraible (tipico de una pagina escaneada/una imagen sin capa de texto), esta tool NO devuelve texto ' +
      'vacio -- renderiza esa pagina real como imagen y te la entrega para que la leas con vision (solo ' +
      'disponible si el runtime activo soporta imagenes en resultados de tool; si no, el resultado te avisa ' +
      'explicitamente que esa pagina es escaneada y no se pudo mostrar).',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Ruta relativa al workspace del documento (.pdf/.docx/.xlsx/.html/.htm).' },
        page: { type: 'number', description: 'Pagina real (PDF) o indice de fragmento (docx/xlsx/html) a leer, 1-indexado. Default 1 si se omite.' }
      },
      required: ['path']
    }
  },
  {
    name: 'write_file',
    description: 'Escribe (crea o sobrescribe) un archivo dentro del workspace activo. Requiere aprobacion explicita del usuario.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Ruta relativa al workspace del archivo a escribir.' },
        content: { type: 'string', description: 'Contenido final completo del archivo.' }
      },
      required: ['path', 'content']
    }
  },
  {
    name: 'apply_patch',
    description:
      'Edita un archivo EXISTENTE reemplazando un fragmento de texto exacto por otro, sin regenerar el ' +
      'archivo completo. Usa esto en vez de write_file para ediciones puntuales (cambiar una funcion, una ' +
      'linea, un bloque) — reserva write_file para archivos nuevos o reescrituras completas legitimas. ' +
      'old_str debe copiarse EXACTO del contenido que devolvio read_file (no lo reescribas de memoria), e ' +
      'incluir suficiente contexto (lineas antes/despues del cambio) para que ese fragmento aparezca UNA ' +
      'SOLA VEZ en el archivo — si aparece 0 o 2+ veces, la tool devuelve error y NO aplica ningun cambio. ' +
      'Si el error dice "no encontrado" o "no es unico", volve a leer el archivo con read_file y ajusta ' +
      'old_str agregando mas contexto: no reintentes el mismo old_str esperando un resultado distinto. ' +
      'Requiere aprobacion explicita del usuario, igual que write_file.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Ruta relativa al workspace del archivo a editar.' },
        old_str: {
          type: 'string',
          description: 'Fragmento de texto exacto a reemplazar, copiado literal del contenido devuelto por read_file, con contexto suficiente para ser unico en el archivo.'
        },
        new_str: { type: 'string', description: 'Texto que reemplaza a old_str.' }
      },
      required: ['path', 'old_str', 'new_str']
    }
  },
  {
    name: 'get_diagnostics',
    description:
      'Devuelve errores y warnings REALES para archivos .ts/.tsx (TypeScript, chequeo de TIPOS), .py (Python, via ' +
      'pyright, chequeo de tipos), .rs (Rust, via rust-analyzer), .go (Go, via gopls), .c/.h/.cpp/.cc/.cxx/.hpp/' +
      '.hh/.hxx (C/C++, via clangd), .java (Java, via jdtls) -- todos estos son diagnosticos de COMPILADOR/' +
      'analizador de tipos, no lint -- .tf/.tfvars (Terraform, via terraform-ls), .lua (Lua, via lua-language-server), ' +
      '.yaml/.yml (YAML, via yaml-language-server) -- diagnosticos de sintaxis/schema -- .js/.jsx/.mjs/.cjs ' +
      '(JavaScript, via ESLint -- LINT real, no chequeo de tipos: .ts/.tsx siguen sirviendose por ' +
      'typescript-language-server, ESLint no cubre esas 2 extensiones en esta version) o .sh/.bash (Bash, via ' +
      'bash-language-server + ShellCheck -- LINT real, requiere `shellcheck` instalado aparte por el usuario, ver ' +
      'mas abajo) ya escritos o ' +
      'editados en esta sesion con write_file/apply_patch — usa esto para confirmar que una edicion no rompio el ' +
      'tipado/lint antes de darla por terminada, en vez de asumir que compilo bien. Cada lenguaje tiene su propio ' +
      'analizador corriendo en paralelo -- pedir diagnosticos de un archivo nunca afecta ni depende de los demas ' +
      'lenguajes tocados, y viceversa. rust-analyzer/gopls/clangd/jdtls/terraform-ls/lua-language-server son ' +
      'binarios EXTERNOS que el usuario instala aparte (a ' +
      'diferencia de TypeScript/Python/YAML/JavaScript/Bash, que vienen incluidos) -- si no estan instalados, o si ' +
      'arrancaron pero no ' +
      'pudieron analizar nada (ej. gopls sin el compilador `go` disponible, o Bash sin `shellcheck` en el PATH ' +
      '-- este ultimo no impide arrancar, pero deja los diagnosticos de lint siempre vacios), la respuesta lo dice ' +
      'explicito con el ' +
      'motivo real cuando se puede confirmar, en vez de fallar en silencio o mostrar "sin errores" cuando en realidad no se analizo nada. ' +
      'Sin "path", devuelve los diagnosticos de TODOS los archivos tocados en la sesion (de cualquier lenguaje ' +
      'soportado). Con "path", solo ese archivo. Si el archivo indicado (o ninguno todavia) fue tocado con ' +
      'write_file/apply_patch, no hay diagnosticos disponibles — esta tool NO analiza archivos que no pasaron por ' +
      'esas dos tools en esta sesion. La respuesta puede venir marcada como "no confirmado como la version mas ' +
      'reciente" si el analisis todavia esta en curso (espera acotada corta, nunca cuelga el turno) — en ese caso, ' +
      'repetir la consulta mas tarde si hace falta certeza total. Solo lectura, sin aprobacion.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Ruta relativa al workspace de un archivo puntual. Vacio = todos los archivos tocados en la sesion (cualquier lenguaje soportado).' }
      },
      required: []
    }
  },
  {
    name: 'find_definition',
    description:
      'Va a la definicion REAL (exacta, resuelta por el compilador/type-checker) de lo que hay en una posicion ' +
      'puntual de un archivo .ts/.tsx, .py, .rs, .go, .c/.h/.cpp/.cc/.cxx/.hpp/.hh/.hxx, .java, .tf/.tfvars, .lua, ' +
      '.yaml/.yml, .js/.jsx/.mjs/.cjs o .sh/.bash. Usa esto en vez de buscar el nombre del identificador con ' +
      'search_files: buscar por texto puede traerte una declaracion con el mismo nombre en OTRO archivo/clase/scope ' +
      '(dos funciones distintas llamadas igual), o no encontrar nada si el identificador llego via un import ' +
      'renombrado (import {X as Y}) -- esta tool resuelve la referencia real del lenguaje, sin ese riesgo de ' +
      'confusion ni de coincidencia perdida. Mismo language server real que get_diagnostics, via "ir a la definicion" ' +
      'del protocolo LSP estandar (lo mismo que Ctrl+Click en un ' +
      'editor). A diferencia de get_diagnostics, SI funciona sobre archivos que todavia no fueron tocados con ' +
      'write_file/apply_patch en esta sesion -- los abre bajo demanda para poder consultarlos. Necesita una ' +
      'posicion EXACTA (linea y columna 1-indexadas, igual que se muestran en get_diagnostics/en un editor) sobre ' +
      'el identificador del que se quiere la definicion -- no busca por nombre de simbolo (para eso esta ' +
      'list_symbols). Devuelve la ruta real del archivo (puede ser otro distinto al consultado) y la posicion real ' +
      'de la definicion, o "sin resultados" si el servidor no encontro ninguna (una respuesta valida, no un ' +
      'error). Solo lectura, sin aprobacion.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Ruta relativa al workspace del archivo desde donde se pregunta.' },
        line: { type: 'number', description: 'Numero de linea 1-indexado (igual que en get_diagnostics/un editor).' },
        column: { type: 'number', description: 'Numero de columna 1-indexada, sobre el identificador puntual.' }
      },
      required: ['path', 'line', 'column']
    }
  },
  {
    name: 'find_references',
    description:
      'Antes de renombrar o eliminar algo, usa esto -- no search_files -- para confirmar TODOS los lugares reales ' +
      'donde se usa. Un grep por nombre puede confundir el identificador con otro igual en un contexto distinto ' +
      '(una variable local llamada igual que un metodo de clase, dos funciones con el mismo nombre en archivos ' +
      'distintos) y traerte resultados que no son usos reales, o dejar afuera un uso real si el identificador llego ' +
      'via un import renombrado -- esta tool resuelve las referencias reales del lenguaje, sin ese riesgo. Busca ' +
      'TODOS los usos reales de lo que hay en una posicion exacta de un archivo .ts/.tsx, .py, .rs, .go, .c/.h/' +
      '.cpp/.cc/.cxx/.hpp/.hh/.hxx, .java, .tf/.tfvars, .lua, .yaml/.yml, .js/.jsx/.mjs/.cjs o .sh/.bash -- mismo ' +
      'mecanismo/servidores que find_definition ("buscar todas las referencias" del protocolo LSP estandar). ' +
      'Tambien abre archivos bajo demanda si hace falta, mismo criterio que find_definition. Solo lectura, sin ' +
      'aprobacion.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Ruta relativa al workspace del archivo desde donde se pregunta.' },
        line: { type: 'number', description: 'Numero de linea 1-indexado.' },
        column: { type: 'number', description: 'Numero de columna 1-indexada, sobre el identificador puntual.' },
        include_declaration: { type: 'boolean', description: 'Si incluir la declaracion misma junto con los usos. Default true.' }
      },
      required: ['path', 'line', 'column']
    }
  },
  {
    name: 'list_symbols',
    description:
      'Lista simbolos reales (funciones, clases, variables, etc.) via el language server real -- mas preciso que ' +
      'leer el archivo entero con read_file o gregear nombres con search_files para entender su estructura. DOS ' +
      'formas excluyentes, pasa exactamente una: con "path", los simbolos de ESE archivo puntual (funciona sobre ' +
      'archivos no tocados todavia en la sesion, los abre bajo demanda) -- usa esta forma, no "query", para la ' +
      'primera exploracion de un archivo nuevo: es la unica que siempre funciona, sin depender de que ya se haya ' +
      'tocado algo antes en ese lenguaje. Con "query", busca por NOMBRE en TODO el workspace -- el mas simple de ' +
      'usar (no necesita archivo ni posicion), pero con una limitacion real: solo encuentra simbolos de lenguajes ' +
      'cuyo language server ya arranco en esta sesion (por un find_definition/find_references/get_diagnostics/ ' +
      'list_symbols con "path" previo sobre un archivo de ese lenguaje) -- si "query" no encuentra algo que ' +
      'deberia existir, no es necesariamente que no exista: puede ser que el LSP de ese lenguaje todavia no ' +
      'arranco, no que el simbolo no este. Solo lectura, sin aprobacion.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Ruta relativa al workspace de un archivo puntual. Excluyente con "query".' },
        query: { type: 'string', description: 'Nombre (o fragmento) de simbolo a buscar en todo el workspace. Excluyente con "path".' }
      },
      required: []
    }
  },
  {
    name: 'list_dir',
    description:
      'Lista SOLO los nombres de archivos y carpetas de un directorio dentro del workspace activo. ' +
      'Uso: exclusivamente para explorar la estructura de carpetas cuando no sabes donde esta algo. ' +
      'NO ejecuta comandos ni interpreta nada — si necesitas correr un comando real (ej. "prisma migrate status", ' +
      '"npm run build", "git status"), usa run_command en vez de listar directorios repetidas veces esperando otro resultado.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Ruta relativa al workspace del directorio a listar. Vacio o "." para la raiz.' }
      },
      required: []
    }
  },
  {
    name: 'run_command',
    description:
      'Ejecuta UN comando de shell real en el workspace activo y devuelve stdout/stderr/exit code. ' +
      'Uso: para CUALQUIER comando que el usuario pida correr o que necesites correr para responder ' +
      '(prisma, npm, git, python, etc.), incluyendo "git status"/"git diff" si prefieres el comando exacto ' +
      'en vez de las tools dedicadas git_status/git_diff. Requiere aprobacion explicita del usuario, siempre. ' +
      'El resultado te dice claramente si el comando fallo (exit code != 0) o no existe en el PATH: no lo ' +
      'reintentes con los mismos argumentos esperando un resultado distinto, reporta el fallo tal cual.' +
      RUN_COMMAND_SHELL_HINT,
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Comando exacto a ejecutar en la shell del sistema.' }
      },
      required: ['command']
    }
  },
  {
    name: 'terminal_exec',
    description:
      'Ejecuta un comando en una TERMINAL PERSISTENTE por sesion -- a diferencia de run_command (proceso nuevo e ' +
      'independiente en CADA llamada, sin memoria del anterior), esta MANTIENE estado real entre llamadas: un ' +
      '"cd" persiste al siguiente comando, una variable seteada con "set" sigue disponible despues, y el ' +
      'directorio actual es el que dejaste, no el del workspace de arranque. Usa esto en vez de run_command ' +
      'cuando necesites que varios comandos compartan contexto -- por ejemplo activar un entorno virtual y ' +
      'despues correr varios comandos dentro de el, o moverte a una subcarpeta y quedarte ahi para los proximos ' +
      'comandos. Para un comando suelto e independiente que no necesita nada de esto, segui usando run_command. ' +
      'La sesion de esta terminal persiste mientras dure la conexion (se cierra sola tras 15 minutos sin uso, o ' +
      'al desconectar) -- el proximo uso arranca una nueva desde cero si eso pasa. Requiere aprobacion explicita ' +
      'del usuario, siempre (mismo criterio que run_command). El resultado incluye el exit code real del ' +
      'comando -- no lo reintentes con los mismos argumentos esperando un resultado distinto, reporta el fallo ' +
      'tal cual.' +
      RUN_COMMAND_SHELL_HINT,
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Comando exacto a ejecutar en la terminal persistente de esta sesion.' }
      },
      required: ['command']
    }
  },
  {
    name: 'git_status',
    description:
      'Atajo de solo lectura equivalente a run_command con "git status --porcelain -b", sin necesitar aprobacion. ' +
      'Usalo en vez de run_command cuando solo quieras el estado de git, para evitar el dialogo de confirmacion.',
    parameters: { type: 'object', properties: {}, required: [] }
  },
  {
    name: 'git_diff',
    description:
      'Atajo de solo lectura equivalente a run_command con "git diff", sin necesitar aprobacion. ' +
      'Usalo en vez de run_command cuando solo quieras el diff, para evitar el dialogo de confirmacion.',
    parameters: { type: 'object', properties: {}, required: [] }
  },
  {
    name: 'explore',
    description:
      'Delega una tarea de busqueda/lectura repetitiva a un modelo mas barato, que investiga por su cuenta ' +
      '(solo lectura: read_file, list_dir, git_status, git_diff — nunca escribe ni ejecuta comandos) y ' +
      'devuelve un resumen condensado de lo que encontro, no el volcado crudo. Usala en vez de encadenar vos ' +
      'mismo varias llamadas de list_dir/read_file/git_status/git_diff cuando la tarea es "explorar" mas que ' +
      '"decidir": por ejemplo "encontra donde se define X", "leeme los archivos relacionados con Y y ' +
      'resumime que hacen", "revisa el estado de git y contame que cambio". Si no hay un modelo de ' +
      'compactacion configurado en Settings (seccion MEMORIA), o la llamada falla, esta tool devuelve un ' +
      'error claro — en ese caso segui explorando vos mismo con las tools normales, no reintentes explore.',
    parameters: {
      type: 'object',
      properties: {
        task: { type: 'string', description: 'Descripcion en lenguaje natural de que explorar/buscar/leer y que necesitas saber al final.' }
      },
      required: ['task']
    }
  },
  {
    name: 'search_files',
    description:
      'Busca texto real (literal o regex simple) dentro de los archivos del workspace activo — devuelve ' +
      '"archivo:linea:contenido" por cada coincidencia. Uso: cuando necesitas ENCONTRAR donde aparece algo ' +
      '(un nombre de funcion, un texto, un import) y no sabes en que archivo esta — usa esto en vez de ' +
      'encadenar list_dir + read_file repetidas veces adivinando ubicaciones. Respeta .gitignore ' +
      'automaticamente si el workspace es un repo git (node_modules/dist/etc. quedan afuera solos, sin que ' +
      'tengas que evitarlos vos). 0 resultados es una respuesta VALIDA (ok:true, "Sin resultados."), no un ' +
      `error — significa que el patron no aparece en ningun archivo, no reintentes la misma busqueda. El ` +
      `resultado se recorta a un maximo de ${SEARCH_FILES_MAX_MATCHES} coincidencias; si necesitas menos ` +
      'ruido, acota con el parametro "path" a una subcarpeta. Solo lectura, sin aprobacion.',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Texto o regex simple (sintaxis basica de grep/regex de JavaScript) a buscar.' },
        path: { type: 'string', description: 'Subcarpeta relativa al workspace para acotar la busqueda. Vacio = todo el workspace.' },
        case_sensitive: { type: 'boolean', description: 'true (default) = distingue mayusculas/minusculas; false = busqueda case-insensitive.' }
      },
      required: ['pattern']
    }
  },
  {
    name: 'list_file_history',
    description:
      'Lista las versiones guardadas de un archivo en el versionado local de AMATISTA — un historial propio, ' +
      'independiente del git real del proyecto si lo tiene (nunca se cruzan). Solo lectura, sin aprobacion. ' +
      'Usala antes de revert_file para ver que referencias hay disponibles. Devuelve fecha, referencia y que ' +
      'tool genero cada version (original/write_file/apply_patch/revert_file), la mas reciente primero. Un ' +
      'archivo que nunca se edito via write_file/apply_patch/revert_file no tiene versiones guardadas.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Ruta relativa al workspace del archivo.' }
      },
      required: ['path']
    }
  },
  {
    name: 'revert_file',
    description:
      'Restaura un archivo a una version anterior guardada por AMATISTA — usa list_file_history primero para ' +
      'ver las referencias disponibles, nunca inventes una referencia. Requiere aprobacion explicita del ' +
      'usuario, mismo dialogo de diff que write_file/apply_patch, comparando el contenido ACTUAL del archivo ' +
      'contra la version elegida. Al aprobar: escribe el contenido restaurado Y ademas guarda esa restauracion ' +
      'como una version NUEVA en el historial — nunca borra ni reescribe versiones anteriores, un revert es un ' +
      'commit mas, no un "deshacer".',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Ruta relativa al workspace del archivo.' },
        ref: { type: 'string', description: 'Referencia de version a restaurar, tal como la devolvio list_file_history.' }
      },
      required: ['path', 'ref']
    }
  },
  {
    name: 'list_windows',
    description:
      'Lista otros chats reales de AMATISTA (titulo + con que proveedor/modelo se conecto la ultima vez, o si ' +
      'nunca se uso) -- usala ANTES de send_to_window para saber que titulos EXISTEN de verdad y cuales estan ' +
      'listos para recibir un mensaje, en vez de adivinar o pedirle el titulo exacto al usuario. Si un chat es un ' +
      'panel adicional del mismo workspace (creado con "Agregar panel"), se muestra ademas un alias corto entre ' +
      'parentesis (ej. "Panel 2") -- se puede usar ESE alias corto en send_to_window en vez de repetir el titulo ' +
      'completo, siempre que el envio se origine desde un chat del MISMO workspace. NO incluye el chat actual ' +
      '(el tuyo). Un chat marcado "no usable todavia" no va a funcionar con send_to_window hasta que alguien lo ' +
      'conecte y le mande un turno real primero. Solo lectura, sin aprobacion, sin parametros.',
    parameters: { type: 'object', properties: {}, required: [] }
  },
  {
    name: 'send_to_window',
    description:
      'Manda un mensaje a OTRO chat de AMATISTA (identificado por su titulo tal como aparece en el panel ' +
      'lateral, NO un id tecnico) y corre un turno real ahi -- si ese chat esta abierto en otra ventana lo usa, ' +
      'si no hay ninguna ventana mostrandolo se abre una nueva automaticamente. El resultado vuelve a ESTE chat ' +
      'como un mensaje del asistente marcado visualmente como recibido de otra ventana. Requiere SIEMPRE ' +
      'aprobacion explicita del usuario (sin excepcion, sin importar el modo de sandbox activo) -- el dialogo ' +
      'muestra el destino y el mensaje completo antes de mandarlo. El chat destino tiene que haber tenido YA AL ' +
      'MENOS UN turno real antes (asi se sabe con que modelo/proveedor conectarlo si hace falta auto-conectarlo) ' +
      '-- si nunca se uso, esta tool devuelve un error claro en vez de adivinar con que conectarlo: pedile al ' +
      'usuario que lo abra y lo conecte el mismo primero.',
    parameters: {
      type: 'object',
      properties: {
        destino: {
          type: 'string',
          description:
            'Titulo EXACTO del chat destino, tal como aparece en el panel lateral de AMATISTA -- O, si el ' +
            'destino es un panel del mismo workspace que tu chat actual, el alias corto que list_windows haya ' +
            'mostrado para el ("Panel 2", "2", "principal", "1").'
        },
        mensaje: { type: 'string', description: 'Texto completo del mensaje/pedido a mandarle a ese chat.' }
      },
      required: ['destino', 'mensaje']
    }
  },
  {
    name: 'parallel_ask',
    description:
      'Reparte N sub-tareas INDEPENDIENTES entre otros paneles de AMATISTA ya conectados e inactivos ahora mismo, ' +
      'las corre EN PARALELO real (Amatista decide a que panel/modelo va cada una segun disponibilidad -- vos NO ' +
      'elegis destino, a diferencia de send_to_window), y te devuelve UN UNICO resultado agregado con la respuesta ' +
      'de cada sub-tarea etiquetada por el panel/modelo real que la resolvio. Pensada para sub-tareas que NO se ' +
      'pisen entre si (ej. investigar temas distintos, no editar el mismo archivo a la vez) -- si 2 sub-tareas ' +
      'tocan el mismo archivo, la proteccion existente contra escrituras concurrentes puede hacer que una de las ' +
      'dos falle limpio con un error explicito, sin corromper nada. Si hay mas sub-tareas que paneles disponibles, ' +
      'un mismo panel toma varias en SECUENCIA (nunca 2 turnos a la vez en el mismo panel). No auto-abre paneles ' +
      'nuevos -- si no hay ningun panel conectado e inactivo, esta tool devuelve un error claro en vez de intentar ' +
      'abrir uno. Requiere SIEMPRE aprobacion explicita del usuario (gasta una llamada real por cada sub-tarea, N ' +
      'veces) -- el dialogo muestra cada sub-tarea junto con el panel/modelo real que se le va a asignar, ANTES de ' +
      'disparar nada. Una sub-tarea que falla o no responde NUNCA aborta a las demas -- el resultado agregado ' +
      'marca cual fallo y por que, las que funcionaron se devuelven igual.',
    parameters: {
      type: 'object',
      properties: {
        subtasks: {
          type: 'array',
          items: { type: 'string' },
          description: 'Lista de sub-tareas independientes entre si, una por elemento -- texto completo de cada una (no un resumen ni un titulo).'
        }
      },
      required: ['subtasks']
    }
  },
  {
    name: 'generate_image',
    description:
      'Genera una imagen real a partir de una descripcion en texto y la adjunta a tu mensaje de este turno -- ' +
      'el usuario la ve como un adjunto normal, marcada visualmente como generada (no subida a mano). Requiere ' +
      'SIEMPRE aprobacion explicita del usuario antes de gastar la llamada (sin excepcion, sin importar el modo ' +
      'de sandbox activo) -- el dialogo muestra el prompt completo. Usa el modelo de generacion de imagenes ' +
      'configurado en Configuracion, que puede ser distinto del modelo con el que estas charlando ahora mismo. ' +
      'Version simple: solo el prompt, sin control de tamano/calidad todavia. Si no hay ningun modelo de ' +
      'generacion configurado (ni uno sugerido automaticamente), devuelve un error claro en vez de inventar una ' +
      'imagen.',
    parameters: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'Descripcion completa de la imagen a generar.' }
      },
      required: ['prompt']
    }
  },
  {
    name: 'web_search',
    description:
      'Busca en la web real (via Tavily) y devuelve resultados reales -- titulo, URL y un fragmento de contenido ' +
      'de cada uno, mas una respuesta corta sintetizada si Tavily la genera. Usa esto para informacion actual o ' +
      'que no sepas con certeza (no inventes datos que podrias buscar). Requiere SIEMPRE aprobacion explicita del ' +
      'usuario antes de gastar la llamada (sin excepcion, sin importar el modo de sandbox activo) -- el dialogo ' +
      'muestra la consulta completa. Solo aparece en tu catalogo si el usuario configuro una API key real de ' +
      'Tavily en Configuracion -- si no la ves, no esta disponible en esta sesion. Para leer el contenido ' +
      'completo de una URL puntual (no solo el fragmento que trae la busqueda), usa web_fetch despues.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Consulta de busqueda real.' },
        max_results: { type: 'number', description: 'Cantidad maxima de resultados (1-20). Default real de Tavily si se omite.' }
      },
      required: ['query']
    }
  },
  {
    name: 'web_fetch',
    description:
      'Trae el contenido REAL y completo de una URL puntual (via Tavily, formato markdown) -- a diferencia de ' +
      'web_search (fragmentos cortos de varios resultados), esto es el contenido completo de UNA pagina real. ' +
      'Usalo despues de web_search cuando un resultado puntual amerite leerse entero, o directo si ya tenes la ' +
      'URL exacta. Si Tavily no pudo extraer esa URL en particular (bloqueada, timeout, formato no soportado), ' +
      'devuelve un error claro con el motivo real, nunca contenido inventado. Requiere SIEMPRE aprobacion ' +
      'explicita del usuario antes de gastar la llamada (sin excepcion, sin importar el modo de sandbox activo) ' +
      '-- el dialogo muestra la URL completa. Solo aparece en tu catalogo si el usuario configuro una API key ' +
      'real de Tavily en Configuracion.',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'URL completa y real a extraer.' }
      },
      required: ['url']
    }
  },
  {
    name: 'todo_write',
    description:
      'Mantiene tu propia lista de tareas para el turno/tarea actual -- REEMPLAZO TOTAL: cada llamada manda la ' +
      'lista COMPLETA vigente, nunca un parche sobre la anterior (si una tarea ya no aplica, simplemente no la ' +
      'incluyas en la proxima llamada). Usala para tareas complejas de 3+ pasos reales, cuando el usuario liste ' +
      'varios pedidos, o cuando el progreso beneficie de que quede visible -- no hace falta para pedidos cortos ' +
      'de un solo paso. La lista persiste en este chat y se te vuelve a mostrar en el proximo turno (mismo ' +
      'mecanismo que tu memoria/resumen acumulado), asi que no hace falta repetirla vos mismo en el texto de tu ' +
      'respuesta. Regla real: a lo sumo UNA tarea puede estar "in_progress" a la vez (cero esta bien, ej. antes de ' +
      'empezar o entre una tarea y la siguiente) -- marcar 2 o mas in_progress al mismo tiempo se rechaza con ' +
      'error, no se corrige solo; volve a llamar la tool con eso corregido. Solo lectura del lado del filesystem/ ' +
      'red -- no toca archivos ni corre nada, sin aprobacion, disponible en cualquier modo de sandbox.',
    parameters: {
      type: 'object',
      properties: {
        todos: {
          type: 'array',
          description: 'Lista COMPLETA y vigente de tareas -- reemplaza cualquier lista anterior de este chat entera.',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', description: 'Opcional -- para reconocer la MISMA tarea entre llamadas sucesivas.' },
              content: { type: 'string', description: 'Descripcion real de la tarea.' },
              status: { type: 'string', enum: ['pending', 'in_progress', 'completed'], description: 'Estado real de la tarea.' },
              priority: { type: 'string', enum: ['high', 'medium', 'low'], description: 'Opcional.' }
            },
            required: ['content', 'status']
          }
        }
      },
      required: ['todos']
    }
  },
  {
    name: 'exit_plan_mode',
    description:
      'Estas en MODO PLAN -- llama esto para presentar tu plan COMPLETO y salir del modo plan. Muestra el plan ' +
      'entero al usuario y espera su aprobacion explicita ANTES de ejecutar nada (escribir archivos, correr ' +
      'comandos) -- esta tool SOLO aparece en tu catalogo mientras el modo plan esta activo, no la llames en ' +
      'ningun otro momento. Si el usuario RECHAZA el plan, seguis en modo plan -- ajustalo segun su feedback y ' +
      'volve a llamar exit_plan_mode cuando este listo de nuevo, nunca ejecutes igual. Si lo aprueba, el modo ' +
      'plan se desactiva solo (si estaba forzado a solo lectura, tu sandbox real vuelve al que tenias antes) y ' +
      'podes proceder a ejecutar el plan aprobado.',
    parameters: {
      type: 'object',
      properties: {
        plan: { type: 'string', description: 'El plan COMPLETO, en texto claro -- que vas a hacer, en que orden, y por que.' }
      },
      required: ['plan']
    }
  },
  {
    name: 'load_skill',
    description:
      'Carga el procedimiento COMPLETO de una skill real (ver la lista real de "Skills disponibles" en tu ' +
      'contexto, si hay alguna configurada) -- el catalogo que ya tenes solo trae nombre+descripcion de cada ' +
      'una, esto te da el cuerpo entero (instrucciones detalladas, pasos, ejemplos) recien cuando decidis que ' +
      'aplica a lo que estas haciendo. Usa esto cuando la tarea actual coincida con la descripcion de una skill ' +
      'real del catalogo, en vez de improvisar un procedimiento propio. Solo lectura de un archivo de skill ' +
      'local -- no toca el filesystem del usuario ni corre nada, sin aprobacion.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Nombre EXACTO de la skill, tal como aparece en el catalogo real de "Skills disponibles".' }
      },
      required: ['name']
    }
  },
  // Tools de sistema Windows (docs/_arch/verify_windows_control_design.md,
  // Familia B) -- las 9 de abajo (notify hasta volume) piden aprobacion via
  // resolveApproval(), MISMO modelo de seguridad exacto que run_command:
  // read-only bloquea de raiz sin preguntar, workspace-write pregunta cada
  // vez (toolTrustSession la salta gratis via ctx.confirm(), igual que
  // cualquier otra tool sandbox-gated), danger-full-access aprueba sin
  // preguntar. close_app/lock_screen/power (las ultimas 3) son la
  // EXCEPCION real: guardias monotonas via ctx.hardConfirm(), ver el
  // comentario completo en su "case" (tool-registry.ts, execute()).
  {
    name: 'notify',
    description:
      'Muestra una notificacion REAL del sistema operativo (Windows), fuera de la ventana de Amatista -- util ' +
      'para avisar que algo termino mientras el usuario esta en otra app. No hace nada mas alla de mostrarla (no ' +
      'espera respuesta, no bloquea el turno). Si Windows tiene las notificaciones desactivadas para Amatista, ' +
      'esta tool no puede saberlo -- devuelve exito igual (la API de Electron no distingue "mostrada" de ' +
      '"silenciada por el usuario").',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Titulo corto de la notificacion.' },
        message: { type: 'string', description: 'Texto del cuerpo de la notificacion.' }
      },
      required: ['title', 'message']
    }
  },
  {
    name: 'clipboard_get',
    description:
      'Lee el texto que hay AHORA MISMO en el portapapeles real de Windows (lo ultimo que el usuario copio, de ' +
      'CUALQUIER app, no solo de Amatista) -- puede traer informacion sensible que el usuario copio para otra ' +
      'cosa (una contraseña, un dato personal), por eso pide aprobacion siempre que corresponda segun el sandbox ' +
      'activo. Si el portapapeles esta vacio o tiene algo que no es texto (una imagen, un archivo), devuelve ' +
      'string vacio, no un error.',
    parameters: { type: 'object', properties: {}, required: [] }
  },
  {
    name: 'clipboard_set',
    description:
      'Reemplaza el contenido del portapapeles real de Windows por el texto dado -- PISA lo que el usuario tenia ' +
      'copiado antes, sin forma de deshacerlo (el portapapeles no tiene historial nativo). Usa esto cuando el ' +
      'usuario pida explicitamente "copiame esto" o similar, no como paso intermedio de otra tarea.',
    parameters: {
      type: 'object',
      properties: { text: { type: 'string', description: 'Texto completo a copiar al portapapeles.' } },
      required: ['text']
    }
  },
  {
    name: 'open_url',
    description:
      'Abre una URL en el navegador default real de Windows (una pestaña/ventana nueva, fuera de Amatista). Solo ' +
      'http/https -- cualquier otro esquema (file:, javascript:, etc.) se rechaza de raiz antes de pedir ' +
      'aprobacion, nunca se le pasa a Windows tal cual (riesgo real de abrir un handler no intencionado).',
    parameters: {
      type: 'object',
      properties: { url: { type: 'string', description: 'URL completa (con http:// o https://) a abrir.' } },
      required: ['url']
    }
  },
  {
    name: 'open_folder',
    description:
      'Abre una carpeta real en el Explorador de Windows (fuera de Amatista) -- relativa al workspace activo, o ' +
      'una ruta absoluta real de esta maquina. NO lista el contenido para vos (eso es list_dir) -- solo la abre ' +
      'para que el USUARIO la vea. Falla limpio si la ruta no existe o no es una carpeta (usa un archivo puntual ' +
      'en vez de su carpeta contenedora por error, por ejemplo).',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Ruta a la carpeta -- relativa al workspace, o absoluta.' } },
      required: ['path']
    }
  },
  {
    name: 'open_app',
    description:
      'Abre una aplicacion real instalada en Windows -- alias comunes reconocidos (word, excel, chrome, code, ' +
      'notepad, calc, terminal, etc.), o el nombre/comando real de cualquier otra app instalada si no esta en ' +
      'la lista de alias. No confirma que la app haya terminado de abrir (Windows no da esa señal de forma ' +
      'simple) -- exito significa "el comando de apertura se emitio sin error", no "la ventana ya esta visible".',
    parameters: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Nombre de la app -- un alias comun (word, excel, powerpoint, outlook, chrome, firefox, edge, code, notepad, calc, terminal, powershell, cmd, explorer, paint, spotify, discord, vlc, taskmgr) o el comando real de otra app instalada.'
        }
      },
      required: ['name']
    }
  },
  {
    name: 'list_processes',
    description:
      'Lista los procesos REALES corriendo ahora mismo en esta maquina Windows (nombre, PID, memoria) -- util ' +
      'para confirmar si una app especifica esta abierta antes de un close_app, o para diagnosticar que esta ' +
      'consumiendo recursos. Lista completa del sistema, no solo procesos de Amatista.',
    parameters: { type: 'object', properties: {}, required: [] }
  },
  {
    name: 'system_info',
    description:
      'Informacion REAL de esta maquina Windows ahora mismo -- version de Windows, CPU, RAM total/en uso, ' +
      'espacio en disco de la unidad del sistema. Snapshot del instante en que se llama, no un monitor continuo.',
    parameters: { type: 'object', properties: {}, required: [] }
  },
  {
    name: 'volume',
    description:
      'Sube, baja o mutea/desmutea el volumen real del sistema Windows -- simula las teclas fisicas de volumen ' +
      '(mismo efecto que el usuario apretandolas), no fija un numero exacto de %. "mute" alterna mute/unmute ' +
      '(no hay forma simple de saber cual es el estado actual antes de decidir, asi que es un toggle real, no un ' +
      'set absoluto).',
    parameters: {
      type: 'object',
      properties: { action: { type: 'string', enum: ['up', 'down', 'mute'], description: 'Accion de volumen a aplicar.' } },
      required: ['action']
    }
  },
  {
    name: 'close_app',
    description:
      'CIERRA a la fuerza (mata el proceso, sin darle chance de guardar cambios) una app real por nombre -- ' +
      'busqueda PARCIAL (ej. "code" mata cualquier proceso cuyo nombre contenga "code"), asi que puede afectar ' +
      'mas procesos de los que el usuario tenia en mente si el nombre es ambiguo. IRREVERSIBLE: trabajo sin ' +
      'guardar en esa app se pierde. Pide confirmacion explicita SIEMPRE, sin excepcion (ni siquiera con acceso ' +
      'total activado, ni si el usuario ya confio en el agente antes en esta sesion) -- el dialogo real muestra ' +
      'los procesos exactos que se van a matar antes de ejecutar nada.',
    parameters: {
      type: 'object',
      properties: { name: { type: 'string', description: 'Nombre (o fragmento del nombre) del proceso/app a cerrar.' } },
      required: ['name']
    }
  },
  {
    name: 'lock_screen',
    description:
      'Bloquea la sesion de Windows AHORA MISMO -- el usuario (o quien sea que este frente a la maquina) necesita ' +
      'la contraseña/PIN real para volver a entrar. Pide confirmacion explicita SIEMPRE, sin excepcion (ni con ' +
      'acceso total activado, ni con confianza de sesion ya otorgada para otra tool) -- bloquear la sesion sin ' +
      'que el usuario lo haya pedido de verdad puede dejarlo afuera de su propia maquina.',
    parameters: { type: 'object', properties: {}, required: [] }
  },
  {
    name: 'power',
    description:
      'Apaga, reinicia o suspende esta maquina Windows REAL -- accion irreversible sobre el hardware fisico, ' +
      'corta CUALQUIER trabajo sin guardar en CUALQUIER app abierta, no solo Amatista. Pide confirmacion ' +
      'explicita SIEMPRE, sin excepcion (ni con acceso total activado, ni con confianza de sesion ya otorgada ' +
      'para otra tool) -- ninguna combinacion de configuracion puede saltear este dialogo.',
    parameters: {
      type: 'object',
      properties: { action: { type: 'string', enum: ['shutdown', 'restart', 'sleep'], description: 'Accion de energia a aplicar.' } },
      required: ['action']
    }
  },
  // Familia A (computer use: mouse/teclado/captura de pantalla,
  // docs/_arch/verify_computer_use_security_model.md). Las 4 SIEMPRE piden
  // ctx.hardConfirm() incondicional (Capa 2), ADEMAS de requerir
  // ctx.computerUseActive (Capa 1) -- guardia de 2 capas real, ver el
  // comentario completo en su "case" (execute(), mas abajo). Disponibles
  // solo para runtimes API `anthropic-api` (el unico con pipeline de
  // imagen en tool_result, confirmado en Tarea 6 del diseño) -- gateado
  // real en ipc-agent.ts, no aca (mismo criterio que hasWebSearchIntegration).
  {
    name: 'screenshot',
    description:
      'Captura una imagen REAL de la pantalla de esta maquina (un monitor especifico, o el PRIMARIO si no se ' +
      'indica) para que puedas VER lo que hay en pantalla antes de decidir donde hacer click o que escribir. ' +
      'Requiere que el usuario haya activado "Control de escritorio" para este panel (Capa 1) Y aprobado ' +
      'explicitamente ESTA llamada puntual (Capa 2, siempre, sin excepcion -- ni con acceso total activado ni con ' +
      'confianza de sesion ya otorgada para otra tool). Devuelve la imagen real -- usala para razonar sobre ' +
      'coordenadas reales antes de llamar mouse_move/mouse_click.',
    parameters: {
      type: 'object',
      properties: {
        display: { type: 'number', description: 'Numero de monitor 1-indexado (1 = primario). Sin este parametro, captura el monitor primario.' }
      },
      required: []
    }
  },
  {
    name: 'mouse_move',
    description:
      'Mueve el cursor del mouse REAL a una posicion exacta de la pantalla (coordenadas absolutas, mismo sistema ' +
      'que ve screenshot) -- NO hace click, solo mueve. Mismas 2 capas de aprobacion que screenshot (Capa 1 + ' +
      'Capa 2 SIEMPRE). El movimiento puede interrumpirse a mitad de camino si el usuario cancela el turno o usa ' +
      'la tecla de panico -- en ese caso, el cursor queda donde estaba en ese instante, no llega al destino.',
    parameters: {
      type: 'object',
      properties: {
        x: { type: 'number', description: 'Coordenada X absoluta (pixeles), mismo sistema de coordenadas que la imagen de screenshot.' },
        y: { type: 'number', description: 'Coordenada Y absoluta (pixeles).' }
      },
      required: ['x', 'y']
    }
  },
  {
    name: 'mouse_click',
    description:
      'Hace UN click real -- boton izquierdo o derecho. Preferi "description" (nombre/texto visible real del ' +
      'control de Windows a clickear, ej. "Guardar", "Aceptar", "Cerrar") -- se resuelve por UI Automation real ' +
      '(el arbol semantico de controles de Windows, NO coordenadas), inmune a que la ventana se haya movido o ' +
      'redimensionado entre que decidiste el target y que esta tool corre. Si no encuentra nada, devuelve la lista ' +
      'real de que SI hay disponible para que reintentes con mejor descripcion; si hay varios candidatos ' +
      'ambiguos, nunca adivina. Alternativa de MENOR prioridad, solo para contenido real NO semantico (un canvas ' +
      'de dibujo, un editor que pinta su propia UI sin controles reales de Windows detras): pasar "x"/"y" en vez ' +
      'de "description" -- coordenadas absolutas de pantalla, mismo sistema que ve screenshot, requiere haber ' +
      'visto un screenshot reciente porque cualquier cambio de ventana entre medio invalida el punto en silencio. ' +
      'Mismas 2 capas de aprobacion SIEMPRE (Capa 1 + Capa 2), con cualquiera de los 2 mecanismos. Si el destino ' +
      'real resulta ser un dialogo de elevacion de permisos de Windows (UAC), el click se rechaza de raiz sin ' +
      'ejecutarse -- eso NUNCA es posible, con o sin aprobacion (prohibicion absoluta, no una guardia con ' +
      'confirmacion).',
    parameters: {
      type: 'object',
      properties: {
        description: { type: 'string', description: 'Nombre/texto visible real del control de Windows a clickear. Excluyente con x/y, preferido.' },
        x: { type: 'number', description: 'Coordenada X absoluta (pixeles). Solo para contenido no-semantico real -- requiere screenshot reciente.' },
        y: { type: 'number', description: 'Coordenada Y absoluta (pixeles). Idem x.' },
        button: { type: 'string', enum: ['left', 'right'], description: 'Boton del mouse. Default "left" si no se indica.' }
      },
      required: []
    }
  },
  {
    name: 'keyboard_type',
    description:
      'Escribe texto real, caracter por caracter. Preferi "description" (nombre/etiqueta real del campo de ' +
      'Windows donde escribir, ej. "Nombre de usuario", "Buscar") -- se resuelve y enfoca por UI Automation real ' +
      'ANTES de escribir, sin depender de que hayas clickeado el campo correcto antes con mouse_click. Si no ' +
      'encuentra nada, devuelve la lista real de que SI hay disponible; si hay varios candidatos ambiguos, nunca ' +
      'adivina. Sin "description": escribe en el campo que tenga el foco real en este momento (en CUALQUIER ' +
      'ventana de la maquina, no solo Amatista) -- usa mouse_click primero para asegurarte de que el campo ' +
      'correcto tiene el foco, mismo comportamiento de siempre. Mismas 2 capas de aprobacion SIEMPRE (Capa 1 + ' +
      'Capa 2), con cualquiera de los 2 mecanismos. PROHIBIDO ESCRIBIR CONTRASEÑAS O CREDENCIALES CONOCIDAS con ' +
      'esta tool, sin excepcion -- no hay forma tecnica de confirmar que el texto llego al campo correcto de ' +
      'forma segura, asi que ni siquiera lo intentes: si la tarea real requiere ingresar una credencial, pedile ' +
      'al usuario que la escriba el mismo. Si el destino real resulta ser un dialogo de UAC, el tipeo se rechaza ' +
      'de raiz sin ejecutarse.',
    parameters: {
      type: 'object',
      properties: {
        description: { type: 'string', description: 'Nombre/etiqueta real del campo de Windows donde escribir. Sin esto, escribe en el foco actual.' },
        text: { type: 'string', description: 'Texto a escribir, tal cual (sin contraseñas/credenciales -- ver restriccion de arriba).' }
      },
      required: ['text']
    }
  },
  // Navegador embebido (docs/_arch/verify_embedded_browser_design.md) --
  // MISMA guardia de 2 capas que Familia A (Capa 1 computerUseActive-like
  // + Capa 2 hardConfirm SIEMPRE), pero un flag de sesion PROPIO e
  // independiente (browserControlActive). A diferencia de computer use,
  // browser_click/browser_type resuelven por DOM/texto como mecanismo
  // PRIMARIO (confirmado mas confiable que coordenadas, ver el "case" de
  // cada una mas abajo) -- el modelo puede operar sin necesitar visto
  // nunca una imagen, browser_screenshot es opcional.
  {
    name: 'browser_navigate',
    description:
      'Navega el navegador embebido REAL de este panel a una URL (solo http/https) -- el usuario VE la pagina ' +
      'en tiempo real dentro del panel. Requiere que el usuario haya activado el navegador embebido para este ' +
      'panel (Capa 1) Y aprobado explicitamente ESTA llamada puntual (Capa 2, siempre, sin excepcion). Devuelve ' +
      'el titulo real de la pagina cargada.',
    parameters: {
      type: 'object',
      properties: { url: { type: 'string', description: 'URL completa (con http:// o https://) a cargar.' } },
      required: ['url']
    }
  },
  {
    name: 'browser_click',
    description:
      'Hace click real en un elemento de la pagina cargada en el navegador embebido -- describilo por su texto ' +
      'visible (ej. "Aceptar", "Iniciar sesion") o etiqueta real (aria-label/placeholder), NO necesitas haber ' +
      'visto una captura de pantalla primero: la busqueda es por texto real de la pagina, no por coordenadas. Si ' +
      'no encuentra nada, devuelve la lista real de que SI hay disponible para que reintentes con mejor ' +
      'descripcion; si encuentra mas de un candidato ambiguo, nunca adivina, te devuelve los candidatos para que ' +
      'elijas. Alternativa de menor prioridad, solo para contenido NO semantico real (un canvas, un editor que ' +
      'dibuja su propia UI): pasar "x"/"y" en vez de "description" -- esto SI requiere un browser_screenshot ' +
      'inmediato antes (mismo turno), porque cualquier cambio de la pagina entre medio invalida las coordenadas ' +
      'en silencio. Requiere Capa 1 + Capa 2 (aprobacion SIEMPRE), igual que browser_navigate.',
    parameters: {
      type: 'object',
      properties: {
        description: { type: 'string', description: 'Texto visible real del elemento a clickear. Excluyente con x/y.' },
        x: { type: 'number', description: 'Coordenada X (solo para contenido no-semantico real -- requiere screenshot inmediato antes).' },
        y: { type: 'number', description: 'Coordenada Y (idem x).' },
        button: { type: 'string', enum: ['left', 'right'], description: 'Solo aplica con x/y. Default "left".' }
      },
      required: []
    }
  },
  {
    name: 'browser_type',
    description:
      'Escribe texto real en un campo de la pagina cargada en el navegador embebido -- describilo por su ' +
      'etiqueta/placeholder real (ej. "Buscar", "Correo electronico"), mismo mecanismo de busqueda por texto que ' +
      'browser_click, nunca coordenadas. El tipeo en si es real (eventos de teclado reales, no un truco de ' +
      'JavaScript), asi que dispara cualquier validacion real de la pagina. PROHIBIDO ESCRIBIR CONTRASEÑAS O ' +
      'CREDENCIALES CONOCIDAS, sin excepcion -- mismo motivo real que keyboard_type (Familia A): no hay forma ' +
      'tecnica de confirmar que el texto llego al campo correcto de forma segura. Requiere Capa 1 + Capa 2 ' +
      '(aprobacion SIEMPRE).',
    parameters: {
      type: 'object',
      properties: {
        description: { type: 'string', description: 'Etiqueta/placeholder real del campo donde escribir.' },
        text: { type: 'string', description: 'Texto a escribir (sin contraseñas/credenciales -- ver restriccion de arriba).' }
      },
      required: ['description', 'text']
    }
  },
  {
    name: 'browser_screenshot',
    description:
      'Captura una imagen REAL del contenido actual del navegador embebido de este panel -- usala si necesitas ' +
      'VER la pagina (layout visual, un elemento no semantico como un canvas/grafico) antes de decidir la ' +
      'proxima accion, o para diagnosticar por que browser_click/browser_type no encontro lo que buscabas. La ' +
      'mayoria de las interacciones NO necesitan esto -- browser_click/browser_type ya trabajan sobre texto real ' +
      'de la pagina, sin necesitar imagen. Requiere Capa 1 + Capa 2 (aprobacion SIEMPRE).',
    parameters: { type: 'object', properties: {}, required: [] }
  }
]

function clip(text: string): string {
  return text.length > MAX_TOOL_OUTPUT_CHARS
    ? `${text.slice(0, MAX_TOOL_OUTPUT_CHARS)}\n[salida recortada]`
    : text
}

/**
 * Resuelve `relativePath` contra `workspace` y garantiza que el resultado
 * siga viviendo dentro del workspace. Lanza si el path escapa (traversal,
 * simlink fuera, ruta absoluta a otro disco, etc.).
 */
function resolveWithinWorkspace(workspace: string, relativePath: string): string {
  const clean = (relativePath || '.').trim() || '.'
  const resolved = path.resolve(workspace, clean)
  const workspaceWithSep = workspace.endsWith(path.sep) ? workspace : workspace + path.sep
  if (resolved !== workspace && !resolved.startsWith(workspaceWithSep)) {
    throw new Error(`Ruta fuera del workspace activo: ${relativePath}`)
  }
  return resolved
}

/**
 * Trunca `text` a `limit` caracteres para el payload que vuelve al modelo,
 * dejando un marcador con el conteo exacto de caracteres omitidos.
 */
function truncateForModel(text: string, limit = MAX_TOOL_OUTPUT_CHARS): string {
  if (text.length <= limit) return text
  const omitted = text.length - limit
  return `${text.slice(0, limit)}\n[...output truncado, se omitieron ${omitted} caracteres...]`
}

/**
 * \r\n -> \n, usado SOLO para decidir si old_str matchea el archivo (Fase
 * 5, apply_patch) — el modelo puede copiar old_str con un estilo de salto
 * de linea distinto al del archivo en disco sin que eso cuente como "no
 * encontrado". La escritura final restaura el estilo original del archivo,
 * ver el caso 'apply_patch' en execute().
 */
function normalizeNewlines(text: string): string {
  return text.replace(/\r\n/g, '\n')
}

/**
 * Cuenta ocurrencias NO superpuestas de `needle` en `haystack`. Asume
 * `needle` no vacio — apply_patch valida eso antes de llamar (un needle
 * vacio matchea en todas partes y rompe el conteo).
 */
function countOccurrences(haystack: string, needle: string): number {
  let count = 0
  let fromIndex = 0
  while (true) {
    const foundAt = haystack.indexOf(needle, fromIndex)
    if (foundAt === -1) break
    count++
    fromIndex = foundAt + needle.length
  }
  return count
}

function runShellCommand(command: string, cwd: string): Promise<ToolExecutionResult> {
  return new Promise(resolve => {
    exec(command, { cwd, timeout: RUN_COMMAND_TIMEOUT_MS, windowsHide: true, maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
      const exitCode = error && typeof (error as NodeJS.ErrnoException & { code?: number }).code === 'number'
        ? (error as unknown as { code: number }).code
        : (error ? 1 : 0)

      // Log completo sin truncar, solo en consola de main process (debug local).
      console.log(`[run_command] "${command}" (cwd=${cwd}) exitCode=${exitCode}`)
      if (stdout) console.log(`[run_command] stdout:\n${stdout}`)
      if (stderr) console.log(`[run_command] stderr:\n${stderr}`)

      // Formato explicito en texto plano (no JSON) para que el modelo no
      // tenga que parsear nada para saber si el comando fallo: un JSON con
      // stdout/stderr vacios se veia ambiguo y algunos modelos reintentaban
      // la misma tool esperando un resultado "mejor" en vez de reportar el
      // fallo. El veredicto va primero, explicito.
      const notFound = /no se reconoce como un comando|is not recognized as an internal or external command|command not found/i
        .test(stderr) || /no se reconoce como un comando|is not recognized as an internal or external command|command not found/i.test(stdout)
      const verdict = !error
        ? 'OK'
        : notFound
          ? `FALLO: comando no encontrado (no esta instalado o no esta en PATH)`
          : `FALLO (exit code ${exitCode})`

      const body =
        `Comando: ${command}\n` +
        `Resultado: ${verdict}\n` +
        `Codigo de salida: ${exitCode}\n\n` +
        `STDOUT:\n${truncateForModel(stdout).trim() || '(vacio)'}\n\n` +
        `STDERR:\n${truncateForModel(stderr).trim() || '(vacio)'}`

      resolve({ ok: !error, output: body })
    })
  })
}

function runGit(args: string[], cwd: string): Promise<ToolExecutionResult> {
  return new Promise(resolve => {
    exec(`git ${args.join(' ')}`, { cwd, timeout: RUN_COMMAND_TIMEOUT_MS, windowsHide: true, maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        resolve({ ok: false, output: clip(stderr || String(error)) })
        return
      }
      resolve({ ok: true, output: clip(stdout) || '(sin cambios)' })
    })
  })
}

/**
 * Tools de sistema Windows (docs/_arch/verify_windows_control_design.md,
 * A3/Familia B): `execFile('powershell.exe', ['-NoProfile','-Command', script])`
 * -- SIN pasar por una shell intermedia (mismo motivo real que
 * runGitGrep() de mas abajo: el `script` nunca se interpola dentro de un
 * string de shell, viaja como UN argumento propio a powershell.exe, asi
 * que un valor con comillas/`;`/backticks no puede inyectar comandos
 * extra). `-NoProfile` evita cargar el perfil de PowerShell del usuario
 * (mas rapido, y evita que un profile.ps1 con efectos secundarios reales
 * corra en cada llamada de una tool). Mismo timeout/maxBuffer que
 * runShellCommand() -- ninguna de estas consultas deberia tardar mas que
 * un comando de shell comun.
 */
function runPowerShell(script: string, cwd?: string): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return new Promise(resolve => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { cwd, timeout: RUN_COMMAND_TIMEOUT_MS, windowsHide: true, maxBuffer: 10 * 1024 * 1024 },
      (error, stdout, stderr) => {
        resolve({ ok: !error, stdout, stderr })
      }
    )
  })
}

/**
 * Tool open_app: mapa real de alias, tomado como base del mapeo real ya
 * usado en el proyecto Q del usuario (AppTools.cs, `AppMap`) -- mismos
 * alias, mismo criterio (case-insensitive, alias -> nombre real del
 * ejecutable que Windows resuelve via PATH/App Paths). Un nombre que no
 * esta en el mapa se pasa TAL CUAL a `start` -- sigue funcionando para
 * cualquier otra app instalada que el usuario nombre por su ejecutable
 * real (ej. "obs64", "steam").
 */
const APP_ALIASES: Record<string, string> = {
  chrome: 'chrome', firefox: 'firefox', edge: 'msedge',
  calculadora: 'calc', calc: 'calc',
  explorador: 'explorer', explorer: 'explorer',
  notepad: 'notepad', 'bloc de notas': 'notepad',
  terminal: 'wt', powershell: 'powershell', cmd: 'cmd',
  word: 'winword', excel: 'excel', powerpoint: 'powerpnt', outlook: 'outlook',
  code: 'code', vscode: 'code',
  spotify: 'spotify', discord: 'discord', taskmgr: 'taskmgr', paint: 'mspaint', vlc: 'vlc'
}

/**
 * `start "" <cmd>` (via cmd.exe, execFile con args array -- sin interpolar
 * `cmd` dentro de un string de shell): el `""` es el titulo VACIO
 * obligatorio del primer argumento de `start` cuando el comando en si
 * puede llevar espacios o empezar con comillas -- sin el, `start "algo con
 * espacio"` interpretaria el primer token como titulo de ventana, no como
 * comando. Mismo mecanismo real que `Process.Start(new
 * ProcessStartInfo(cmd){UseShellExecute=true})` de Q -- deja que Windows
 * resuelva `cmd` via PATH/App Paths/asociaciones de la shell, no requiere
 * la ruta completa del .exe.
 */
function openApp(name: string): Promise<ToolExecutionResult> {
  const key = name.trim().toLowerCase()
  const resolved = APP_ALIASES[key] ?? name.trim()
  return new Promise(resolve => {
    execFile('cmd.exe', ['/c', 'start', '""', resolved], { windowsHide: true, timeout: RUN_COMMAND_TIMEOUT_MS }, error => {
      resolve(
        error
          ? { ok: false, output: `No se pudo abrir "${name}": ${error.message}` }
          : { ok: true, output: `Comando de apertura para "${name}" (${resolved}) emitido sin error.` }
      )
    })
  })
}

/**
 * Fase 16: git grep vía execFile (args como array, SIN pasar por una shell)
 * — a diferencia de run_command/git_status/git_diff, search_files no pide
 * aprobacion (es de solo lectura), asi que `pattern`/`path` le llegan del
 * modelo sin que un humano los revise antes de ejecutarse. exec() con un
 * string interpolado seria una inyeccion de shell real via `pattern`
 * (ej. un pattern con backticks o `;`); execFile no invoca ninguna shell,
 * el pattern viaja como UN argumento, nunca se interpreta como comando.
 *
 * `-n`: numero de linea. `-I`: ignora binarios. `--untracked`: incluye
 * archivos nuevos sin `git add` todavia (pero SIGUE respetando
 * .gitignore — no es lo mismo que --no-exclude-standard). `-e <pattern>`:
 * fuerza a git a tratar `pattern` como el patron aunque empiece con "-".
 *
 * Exit code real de `git grep`: 0 = hubo matches, 1 = NO hubo matches
 * (busqueda valida, no un fallo), cualquier otro (128 = no es un repo
 * git, o el binario `git` ni se encontro) = fallo real → el llamador cae
 * al fallback manual. `error.code` puede venir como string (ej. 'ENOENT'
 * si `git` no esta instalado) en vez de numero — se trata igual que
 * "fallo real", nunca como si fuera el exit code 1 de "sin resultados".
 */
function runGitGrep(
  pattern: string,
  cwd: string,
  gitPathspec: string | null,
  caseSensitive: boolean
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const args = ['grep', '-n', '-I', '--untracked']
  if (!caseSensitive) args.push('-i')
  args.push('-e', pattern)
  if (gitPathspec) args.push('--', gitPathspec)

  return new Promise(resolve => {
    execFile('git', args, { cwd, timeout: RUN_COMMAND_TIMEOUT_MS, windowsHide: true, maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
      const errWithCode = error as (NodeJS.ErrnoException & { code?: number | string }) | null
      const exitCode = !errWithCode
        ? 0
        : typeof errWithCode.code === 'number'
          ? errWithCode.code
          : -1 // codigo no numerico (ej. ENOENT) — nunca confundir con exit 1 real
      resolve({ exitCode, stdout, stderr })
    })
  })
}

/**
 * Fallback manual (workspace sin git, o `git grep` fallo por otra razon —
 * ej. `git` no instalado). Recorre el arbol de archivos excluyendo
 * ignoredDirectories (mismo set que ya usa el explorador del sidebar),
 * salta archivos mas grandes que MAX_TEXT_FILE_BYTES o con un byte nulo
 * en los primeros 8000 caracteres (deteccion liviana de binario, no una
 * libreria completa). Corta apenas se alcanza SEARCH_FILES_MAX_MATCHES —
 * no seria realista construir todos los matches de un patron comun en un
 * proyecto grande primero y despues cortar.
 */
function searchFilesManually(searchRoot: string, workspace: string, pattern: string, caseSensitive: boolean): string[] {
  const matches: string[] = []
  let regex: RegExp
  try {
    regex = new RegExp(pattern, caseSensitive ? '' : 'i')
  } catch {
    // pattern invalido como regex (ej. parentesis sin cerrar) -> se trata
    // como texto literal, mismo criterio de tolerancia que un grep real.
    const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    regex = new RegExp(escaped, caseSensitive ? '' : 'i')
  }

  function safeReaddir(dir: string) {
    try {
      return readdirSync(dir, { withFileTypes: true })
    } catch {
      return null
    }
  }

  function walk(dir: string): void {
    if (matches.length >= SEARCH_FILES_MAX_MATCHES) return
    const entries = safeReaddir(dir)
    if (!entries) return
    for (const entry of entries) {
      if (matches.length >= SEARCH_FILES_MAX_MATCHES) return
      if (entry.isDirectory()) {
        if (ignoredDirectories.has(entry.name)) continue
        walk(path.join(dir, entry.name))
        continue
      }
      if (!entry.isFile()) continue
      const fullPath = path.join(dir, entry.name)
      try {
        if (statSync(fullPath).size > MAX_TEXT_FILE_BYTES) continue
      } catch {
        continue
      }
      let content: string
      try {
        content = readFileSync(fullPath, 'utf8')
      } catch {
        continue
      }
      if (content.slice(0, 8000).includes('\0')) continue // probable binario
      const lines = content.split('\n')
      const relPath = path.relative(workspace, fullPath).split(path.sep).join('/')
      for (let i = 0; i < lines.length; i++) {
        if (matches.length >= SEARCH_FILES_MAX_MATCHES) return
        if (regex.test(lines[i])) matches.push(`${relPath}:${i + 1}:${lines[i]}`)
      }
    }
  }

  walk(searchRoot)
  return matches
}

/** Mismo criterio que normalizePathKey() en lsp-client.ts (no reusado
 *  directo -- funcion pura de 3 lineas, mismo motivo de no acoplar modulos
 *  ya documentado en cli-agent-runtime.ts:parseDataUrl()): en Windows dos
 *  rutas que difieren solo en mayusculas/minusculas son el MISMO archivo
 *  real -- sin esto, read_file("File.txt") y write_file("file.txt") en la
 *  misma sesion registrarian 2 claves distintas para el mismo archivo. */
function toctouPathKey(absolutePath: string): string {
  return process.platform === 'win32' ? absolutePath.toLowerCase() : absolutePath
}

export class ToolRegistry {
  /**
   * Fix real de TOCTOU (docs/_arch/verify_toctou_fix_design.md): por-sesion
   * (`${sessionId}::${path}` -> hash de contenido COMPLETO, pre-clip()),
   * no por-archivo -- 2 sesiones que leyeron el mismo archivo en momentos
   * distintos guardan cada una SU PROPIO hash, sin pisarse entre si (ToolRegistry
   * es un singleton de modulo, runtime-state.ts, compartido por TODAS las
   * conexiones reales). read_file lo puebla; write_file/apply_patch lo leen
   * (y lo actualizan tras escribir con exito); disconnectSession() lo limpia
   * por sessionId (ver runtime-state.ts) para no crecer sin limite a traves
   * de reconexiones en una sesion de app muy larga.
   */
  private readonly sessionFileHashes = new Map<string, string>()

  private sessionFileHashKey(sessionId: string, absolutePath: string): string {
    return `${sessionId}::${toctouPathKey(absolutePath)}`
  }

  /** Poblado por read_file (contenido completo, pre-clip) y por write_file/
   *  apply_patch tras una escritura exitosa (contenido recien escrito) --
   *  ver comentario completo de sessionFileHashes arriba. */
  private rememberSessionFileHash(sessionId: string | undefined, absolutePath: string, content: string): void {
    if (!sessionId) return
    this.sessionFileHashes.set(this.sessionFileHashKey(sessionId, absolutePath), hashFileContent(content))
  }

  /** undefined = sin registro (archivo nunca leido/escrito en esta sesion,
   *  o ctx.sessionId ausente) -- write_file/apply_patch caen al
   *  comportamiento de siempre (d3a8fe4) en ese caso, sin bloquear. */
  private lookupSessionFileHash(sessionId: string | undefined, absolutePath: string): string | undefined {
    if (!sessionId) return undefined
    return this.sessionFileHashes.get(this.sessionFileHashKey(sessionId, absolutePath))
  }

  /** Limpieza real al desconectar (runtime-state.ts:disconnectSession(),
   *  mismo punto donde ya se llama lspManager?.stopAll()/mcpManager?.stopAll())
   *  -- borra SOLO las entradas de este sessionId, el resto de sesiones
   *  activas (otros paneles reales) no se ven afectadas. */
  clearSessionFileHashes(sessionId: string): void {
    const prefix = `${sessionId}::`
    for (const key of this.sessionFileHashes.keys()) {
      if (key.startsWith(prefix)) this.sessionFileHashes.delete(key)
    }
  }

  definitions(): ToolDefinition[] {
    return TOOL_DEFINITIONS
  }

  async execute(name: string, rawArgs: unknown, ctx: ExecuteContext): Promise<ToolExecutionResult> {
    const args = typeof rawArgs === 'object' && rawArgs !== null ? rawArgs as Record<string, unknown> : {}

    if (process.env.AMATISTA_DEBUG_TOOLS === '1') {
      console.log(`[toolRegistry.execute] tool=${name} workspace="${ctx.workspace}" args=${JSON.stringify(args).slice(0, 500)}`)
    }

    try {
      switch (name) {
        case 'read_file': {
          const target = resolveWithinWorkspace(ctx.workspace, String(args.path ?? ''))
          if (!existsSync(target) || !statSync(target).isFile()) {
            return { ok: false, output: `Archivo no encontrado: ${String(args.path ?? '')}` }
          }
          const content = readFileSync(target, 'utf8')
          // Fix real de TOCTOU: registra el hash del contenido COMPLETO
          // (antes de clip() truncarlo para el modelo) -- write_file/
          // apply_patch lo usan despues para auditar contra lo que esta
          // sesion realmente vio, no contra lo que haya en disco al
          // entrar a esas tools.
          this.rememberSessionFileHash(ctx.sessionId, target, content)
          return { ok: true, output: clip(content) }
        }

        case 'read_document': {
          const relPath = String(args.path ?? '')
          const target = resolveWithinWorkspace(ctx.workspace, relPath)
          if (!existsSync(target) || !statSync(target).isFile()) {
            return { ok: false, output: `Archivo no encontrado: ${relPath}` }
          }
          if (!detectDocumentFormat(target)) {
            return { ok: false, output: `Formato no soportado: ${relPath}. read_document acepta .pdf/.docx/.xlsx/.html/.htm.` }
          }
          const pageArg = args.page === undefined ? undefined : Number(args.page)
          if (pageArg !== undefined && (!Number.isFinite(pageArg) || pageArg < 1)) {
            return { ok: false, output: '"page" debe ser un numero entero >= 1.' }
          }
          const result = await raceTimeout(
            readDocument(target, pageArg),
            READ_DOCUMENT_TIMEOUT_MS,
            `La tool read_document no respondio en ${READ_DOCUMENT_TIMEOUT_MS / 1000} segundos leyendo "${relPath}".`
          )
          if (!result.ok) return { ok: false, output: result.error }

          const unit = result.unit
          if (unit.scanned && unit.imageDataUrl) {
            const summary =
              `Pagina ${unit.unitIndex}/${unit.totalUnits} de "${relPath}" no tiene texto extraible (escaneada). ` +
              `Se adjunta como imagen (si el runtime activo lo soporta) para leerla con vision.`
            return { ok: true, output: summary, resultImageDataUrl: unit.imageDataUrl }
          }

          const location = unit.pageNumber
            ? ` (pagina real ${unit.pageNumber}${unit.sheetName ? `, hoja "${unit.sheetName}"` : ''})`
            : unit.sheetName ? ` (hoja "${unit.sheetName}")` : ''
          const header = `Fragmento ${unit.unitIndex}/${unit.totalUnits} de "${relPath}"${location}:\n\n`
          return { ok: true, output: clip(header + (unit.text ?? '')) }
        }

        case 'write_file': {
          const relPath = String(args.path ?? '')
          const content = String(args.content ?? '')
          const target = resolveWithinWorkspace(ctx.workspace, relPath)
          const existingContent = existsSync(target) && statSync(target).isFile()
            ? readFileSync(target, 'utf8')
            : null
          // Fix real de staleness (docs/_arch/verify_concurrent_write_staleness.md):
          // huella tomada en el MISMO instante que existingContent -- antes
          // de resolveApproval(), que es la ventana real confirmada (2
          // sesiones/paneles reales tocando el mismo workspace).
          const existingHash = hashFileContent(existingContent)
          // Fix real de TOCTOU (docs/_arch/verify_toctou_fix_design.md,
          // Hallazgo 1 de verify_external_review_findings.md): hash real
          // que ESTA sesion vio la ultima vez que leyo/escribio este mismo
          // archivo (posiblemente turnos antes, via read_file) -- capturado
          // ANTES de resolveApproval() a proposito, mismo criterio que
          // existingHash arriba. undefined si nunca se leyo/escribio en
          // esta sesion (archivo nuevo, o escritura "a ciegas") -- en ese
          // caso el chequeo de mas abajo no aplica, sin bloquear.
          const sessionHash = this.lookupSessionFileHash(ctx.sessionId, target)
          const writeDiff = formatWriteFileDiff(existingContent, content)
          const approved = await resolveApproval(
            ctx.sandbox,
            ctx.confirm,
            `Escribir archivo: ${relPath}`,
            writeDiff.preview
          )
          if (!approved) {
            return {
              ok: false,
              output: ctx.sandbox === 'read-only'
                ? readOnlyBlockedMessage('escribir archivos')
                : 'El usuario rechazo la escritura del archivo.'
            }
          }
          // Fix real de staleness bajo concurrencia (docs/_arch/verify_toctou_parallel_fix_design.md,
          // Opcion A2): snapshotea el 'original' (si es el primer toque de
          // este archivo) ANTES del re-chequeo final -- solo archiva lo que
          // REALMENTE esta en disco ahora mismo, nunca contenido de una
          // escritura que todavia no paso. Deliberadamente separado de
          // commitVersion() (mas abajo, DESPUES del write real): si
          // commiteara `content` aca y el re-chequeo de abajo rechazara por
          // staleness, quedaria un commit huerfano en el VCS oculto de una
          // escritura que nunca ocurrio en disco (confirmado real con el
          // orden viejo). Nunca bloquea la escritura real si falla (ver
          // local-vcs.ts) -- solo se avisa en el output.
          const originalSnapshot = await snapshotOriginalIfNeeded({
            workspace: ctx.workspace,
            relPath,
            existingContent
          })
          // Fix real de staleness bajo concurrencia: re-chequeo FINAL,
          // SINCRONICO -- sin ningun await entre esta comparacion y el
          // writeFileSync de abajo. En el event loop mono-hilo de Node, un
          // tramo sincronico no puede ser interleaveado por el turno de
          // otro panel -- esto es lo que cierra la ventana real que
          // snapshotOriginalIfNeeded() de arriba (awaited, cede el event
          // loop por los subprocesos git reales) volvia a abrir con el
          // orden viejo (reproducido real, ver el doc de arriba: sin este
          // chequeo pegado al write, esto pisaba el cambio ajeno en
          // silencio con ok:true).
          const freshContent = existsSync(target) && statSync(target).isFile()
            ? readFileSync(target, 'utf8')
            : null
          if (hashFileContent(freshContent) !== existingHash) {
            return {
              ok: false,
              output: `El archivo "${relPath}" cambio en disco despues de que lo leiste (probablemente otra sesion/panel lo edito mientras tanto) -- volve a leerlo con read_file y volve a intentar la escritura sobre el contenido actual, no reintentes con el mismo content de antes.`
            }
          }
          // Fix real de TOCTOU: chequeo ADICIONAL, mas amplio que el de
          // arriba -- ese solo audita "entrar a write_file -> aprobacion",
          // este audita "read_file real de esta sesion -> este instante",
          // que puede ser de varios turnos. Confirmado real (verify_toctou_fix_design.md)
          // que sin esto, si B escribia ANTES de que A siquiera llamara a
          // write_file, existingHash/freshContent ya coincidian entre si
          // (ambos reflejaban el cambio de B) y el chequeo de arriba no
          // detectaba nada -- A pisaba a B igual, con ok:true.
          if (sessionHash !== undefined && hashFileContent(freshContent) !== sessionHash) {
            return {
              ok: false,
              output: `El archivo "${relPath}" cambio en disco despues de que lo leiste (probablemente otra sesion/panel lo edito mientras tanto) -- volve a leerlo con read_file y volve a intentar la escritura sobre el contenido actual, no reintentes con el mismo content de antes.`
            }
          }
          writeFileSync(target, content, 'utf8')
          // Fase 8 (Opcion A2): commitea lo que REALMENTE aterrizo en
          // disco, DESPUES de la escritura real -- a diferencia del
          // snapshot de 'original' de arriba, esta linea nunca se alcanza
          // si el re-chequeo de arriba rechazo. Si falla (git no
          // instalado, permisos, contencion), NO bloquea la escritura real
          // (ver local-vcs.ts) -- el archivo ya esta escrito, solo se
          // pierde el respaldo en el historial oculto, avisado en el output.
          const versionSnapshot = await commitVersion({
            workspace: ctx.workspace,
            relPath,
            newContent: content,
            tool: 'write_file'
          })
          const vcsNote = originalSnapshot.ok && versionSnapshot.ok
            ? ''
            : ` [AVISO: no se pudo versionar completamente este cambio en el historial oculto — ${versionSnapshot.error ?? originalSnapshot.error}]`
          // Fix real de TOCTOU: la sesion acaba de escribir este contenido
          // -- lo registra como "lo que vio" para que su PROXIMA escritura
          // sobre este mismo archivo (sin un read_file de por medio) no se
          // autobloquee exigiendo releer algo que ella misma acaba de escribir.
          this.rememberSessionFileHash(ctx.sessionId, target, content)
          // Fase 20: fire-and-forget hacia el LSP -- no se espera nada aca
          // (esa espera acotada la maneja get_diagnostics), y si no es un
          // .ts/.tsx o el LSP falla, notifyFileWritten() es un no-op
          // silencioso, nunca afecta este resultado.
          ctx.lspManager?.notifyFileWritten(target, content)
          return { ok: true, output: `Archivo escrito: ${relPath}${vcsNote}`, lineDiff: { added: writeDiff.added, removed: writeDiff.removed } }
        }

        case 'apply_patch': {
          const relPath = String(args.path ?? '')
          const oldStr = String(args.old_str ?? '')
          const newStr = String(args.new_str ?? '')

          if (!oldStr) {
            return { ok: false, output: 'old_str no puede estar vacio. Para crear un archivo nuevo usa write_file.' }
          }

          const target = resolveWithinWorkspace(ctx.workspace, relPath)
          if (!existsSync(target) || !statSync(target).isFile()) {
            return { ok: false, output: `Archivo no encontrado: ${relPath}. Para crear un archivo nuevo usa write_file.` }
          }

          const existingContent = readFileSync(target, 'utf8')
          // Fix real de staleness (docs/_arch/verify_concurrent_write_staleness.md):
          // mismo mecanismo que write_file, ver ahi el comentario completo
          // -- huella tomada YA, en el mismo instante que existingContent.
          const existingHash = hashFileContent(existingContent)
          // Fix real de TOCTOU (docs/_arch/verify_toctou_fix_design.md):
          // mismo mecanismo que write_file, ver el comentario completo ahi
          // -- capturado ANTES de resolveApproval(), mismo criterio que
          // existingHash arriba.
          const sessionHash = this.lookupSessionFileHash(ctx.sessionId, target)
          // Estilo de salto de linea del archivo EN DISCO, detectado antes
          // de normalizar nada — determina como se escribe el resultado
          // final, no como se compara (eso es normalizedContent). Criterio
          // de MAYORIA, no de presencia: un archivo con 499 lineas en \n y
          // 1 en \r\n por accidente historico es un archivo \n con una
          // excepcion aislada, no un archivo \r\n — usesCRLF = false ahi,
          // para no reescribir las otras 499 lineas sin que nadie lo pida.
          const crlfCount = (existingContent.match(/\r\n/g) ?? []).length
          const lfOnlyCount = (existingContent.match(/(?<!\r)\n/g) ?? []).length
          const usesCRLF = crlfCount > lfOnlyCount
          const normalizedContent = normalizeNewlines(existingContent)
          const normalizedOldStr = normalizeNewlines(oldStr)
          const occurrences = countOccurrences(normalizedContent, normalizedOldStr)

          if (occurrences === 0) {
            return {
              ok: false,
              output: `old_str no encontrado en ${relPath}. Volve a leer el archivo con read_file y copia el fragmento exacto — no reintentes el mismo old_str.`
            }
          }
          if (occurrences > 1) {
            return {
              ok: false,
              output: `old_str aparece ${occurrences} veces en ${relPath} — no es unico, no se aplico ningun cambio. Agrega mas contexto (lineas antes/despues) para que el fragmento sea unico.`
            }
          }

          const matchIndex = normalizedContent.indexOf(normalizedOldStr)
          const normalizedNewContent =
            normalizedContent.slice(0, matchIndex) +
            normalizeNewlines(newStr) +
            normalizedContent.slice(matchIndex + normalizedOldStr.length)
          // Preserva el estilo de salto de linea original del archivo: la
          // comparacion de arriba fue normalizada, pero lo que se escribe
          // a disco no le impone \n a un archivo \r\n ni viceversa.
          const finalContent = usesCRLF ? normalizedNewContent.replace(/\n/g, '\r\n') : normalizedNewContent

          const patchDiff = formatWriteFileDiff(existingContent, finalContent)
          const approved = await resolveApproval(
            ctx.sandbox,
            ctx.confirm,
            `Editar archivo: ${relPath}`,
            patchDiff.preview
          )
          if (!approved) {
            return {
              ok: false,
              output: ctx.sandbox === 'read-only'
                ? readOnlyBlockedMessage('editar archivos')
                : 'El usuario rechazo la edicion del archivo.'
            }
          }
          // Fix real de staleness bajo concurrencia (Opcion A2, mismo
          // criterio que write_file -- ver el comentario completo ahi):
          // snapshotea el 'original' ANTES del re-chequeo final, nunca el
          // resultado de esta edicion.
          const originalSnapshot = await snapshotOriginalIfNeeded({
            workspace: ctx.workspace,
            relPath,
            existingContent
          })
          // Fix real de staleness: re-chequeo FINAL, SINCRONICO, mismo
          // punto y mismo criterio que write_file -- sin ningun await entre
          // esta comparacion y el writeFileSync de abajo. Si el archivo
          // desaparecio en el medio (otra sesion lo borro), freshContent da
          // null, que nunca matchea el hash de un existingContent real --
          // se trata igual que cualquier otro cambio externo.
          const freshContent = existsSync(target) && statSync(target).isFile()
            ? readFileSync(target, 'utf8')
            : null
          if (hashFileContent(freshContent) !== existingHash) {
            return {
              ok: false,
              output: `El archivo "${relPath}" cambio en disco despues de que lo leiste (probablemente otra sesion/panel lo edito mientras tanto) -- volve a leerlo con read_file y volve a intentar la edicion sobre el contenido actual, no reintentes el mismo old_str/new_str de antes.`
            }
          }
          // Fix real de TOCTOU: chequeo ADICIONAL, mismo criterio que
          // write_file -- ver el comentario completo ahi. Gap real
          // confirmado mas acotado en apply_patch (el matching de old_str
          // ya actua como salvaguarda incidental en el caso de conflicto
          // directo), pero igual se aplica por consistencia y para el caso
          // residual donde el cambio ajeno no invalida old_str.
          if (sessionHash !== undefined && hashFileContent(freshContent) !== sessionHash) {
            return {
              ok: false,
              output: `El archivo "${relPath}" cambio en disco despues de que lo leiste (probablemente otra sesion/panel lo edito mientras tanto) -- volve a leerlo con read_file y volve a intentar la edicion sobre el contenido actual, no reintentes el mismo old_str/new_str de antes.`
            }
          }
          writeFileSync(target, finalContent, 'utf8')
          // Fase 8 (Opcion A2, mismo criterio que write_file): commitea lo
          // que REALMENTE aterrizo, DESPUES de la escritura real.
          // apply_patch solo edita archivos que YA EXISTEN (validado
          // arriba), asi que existingContent nunca es null -- si es el
          // primer toque de este archivo, snapshotOriginalIfNeeded() de
          // arriba ya commiteo el original antes de llegar aca.
          const versionSnapshot = await commitVersion({
            workspace: ctx.workspace,
            relPath,
            newContent: finalContent,
            tool: 'apply_patch'
          })
          const vcsNote = originalSnapshot.ok && versionSnapshot.ok
            ? ''
            : ` [AVISO: no se pudo versionar completamente este cambio en el historial oculto — ${versionSnapshot.error ?? originalSnapshot.error}]`
          // Fix real de TOCTOU: mismo criterio que write_file -- ver el
          // comentario completo ahi.
          this.rememberSessionFileHash(ctx.sessionId, target, finalContent)
          // Fase 20: mismo fire-and-forget que write_file -- ver comentario ahi.
          ctx.lspManager?.notifyFileWritten(target, finalContent)
          return { ok: true, output: `Archivo editado: ${relPath}${vcsNote}`, lineDiff: { added: patchDiff.added, removed: patchDiff.removed } }
        }

        case 'get_diagnostics': {
          // Fase 20: SOLO runtimes API tienen lspManager (ver ExecuteContext
          // mas arriba) -- explore-tool.ts arma su propio ExecuteContext
          // reducido sin este campo, y los runtimes CLI ni siquiera pasan
          // por aca. Mensaje explicito en vez de "tool no disponible"
          // generico, para que el modelo no reintente sin entender por que.
          if (!ctx.lspManager) {
            return { ok: true, output: 'Diagnosticos no disponibles: este runtime no tiene un language server conectado.' }
          }
          const relPathArg = String(args.path ?? '').trim()
          const target = relPathArg ? resolveWithinWorkspace(ctx.workspace, relPathArg) : undefined
          const results = await ctx.lspManager.getDiagnostics(target)

          if (results.length === 0) {
            // Soporte Rust (docs/_arch/verify_rust_lsp.md, Tarea 4): un
            // binario EXTERNO (rust-analyzer) puede genuinamente no estar
            // instalado -- distinto de TypeScript/Python, que vienen
            // bundleados y nunca fallan en la practica. Sin este chequeo,
            // "nunca tocado" y "el language server no pudo arrancar"
            // sonaban identicos -- engañoso cuando el archivo SI se toco y
            // lo que falta es el binario, no una accion del usuario.
            const failure = target ? ctx.lspManager.startupFailureFor(target) : undefined
            if (failure) {
              return { ok: true, output: failure }
            }
            return {
              ok: true,
              output: relPathArg
                ? `${relPathArg} no fue tocado con write_file/apply_patch en esta sesion — sin diagnosticos disponibles.`
                : 'Ningun archivo de un lenguaje soportado (.ts/.tsx, .py, .rs, .go, .c/.cpp, .java, .tf, .lua, .yaml, .js, .sh) fue tocado con write_file/apply_patch en esta sesion todavia — sin diagnosticos disponibles.'
            }
          }

          const lines: string[] = []
          for (const result of results) {
            const relForDisplay = path.relative(ctx.workspace, result.path) || result.path
            const staleNote = result.stale ? ' (no confirmado como la version mas reciente — el analisis podria seguir en curso)' : ''
            // Soporte Go (docs/_arch/verify_go_lsp.md, Tarea 1): confirmado
            // real que gopls, con `go` no resoluble, SI llega a publicar un
            // diagnostico -- pero es un SINTOMA generico del mismo problema
            // ("No active builds contain ... consider opening a new
            // workspace folder", source:"go list"), no un resultado de
            // analisis real. Se filtra de la vista para no confundirlo con
            // un warning genuino del codigo -- TypeScript/Python/Rust nunca
            // producen ese source, sin cambio para esos 3.
            const realDiagnostics = result.diagnostics.filter(d => d.source !== 'go list')
            // DISTINTO de startupFailureFor() de arriba -- este archivo SI
            // fue tocado y el server SI arranco, pero no logro publicar
            // ningun diagnostico real porque no pudo analizar nada (ej.
            // gopls sin `go` resoluble). Sin este chequeo, se mostraria
            // "sin errores ni warnings" -- exactamente lo contrario de la
            // realidad.
            if (realDiagnostics.length === 0) {
              const operationalError = ctx.lspManager.operationalErrorFor(result.path)
              if (operationalError) {
                lines.push(`${relForDisplay}: no se pudo analizar -- ${operationalError}`)
                continue
              }
              lines.push(`${relForDisplay}: sin errores ni warnings${staleNote}`)
              continue
            }
            lines.push(`${relForDisplay}${staleNote}:`)
            for (const diagnostic of realDiagnostics) {
              const severityLabel =
                diagnostic.severity === 1 ? 'error'
                  : diagnostic.severity === 2 ? 'warning'
                    : diagnostic.severity === 3 ? 'info'
                      : 'hint'
              // El prefijo "TS" es la convencion real del ecosistema
              // TypeScript (TS2345, etc.) -- pero Python/Rust/Go tienen la
              // suya propia (reportArgumentType, E0308, IncompatibleAssign),
              // ninguna con "TS". Confirmado real via
              // docs/_arch/verify_ts_prefix_bug.md que el prefijo estaba
              // hardcodeado sin importar el lenguaje del archivo puntual.
              const isTypeScript = languageServerConfigFor(result.path)?.languageId === 'typescript'
              const codeLabel = diagnostic.code !== undefined ? (isTypeScript ? ` TS${diagnostic.code}` : ` ${diagnostic.code}`) : ''
              lines.push(`  ${severityLabel} [${diagnostic.line}:${diagnostic.column}]${codeLabel}: ${diagnostic.message}`)
            }
          }
          return { ok: true, output: clip(lines.join('\n')) }
        }

        case 'find_definition':
        case 'find_references': {
          // Indexacion por simbolos (docs/_arch/verify_lsp_symbols.md):
          // mismo chequeo de disponibilidad que get_diagnostics -- solo los
          // 4 runtimes API tienen lspManager.
          if (!ctx.lspManager) {
            return { ok: true, output: 'Navegacion por LSP no disponible: este runtime no tiene un language server conectado.' }
          }
          const relPathArg = String(args.path ?? '').trim()
          if (!relPathArg) {
            return { ok: false, output: '"path" es requerido.' }
          }
          const target = resolveWithinWorkspace(ctx.workspace, relPathArg)
          if (!existsSync(target) || !statSync(target).isFile()) {
            return { ok: false, output: `Archivo no encontrado: ${relPathArg}` }
          }
          const line = Number(args.line)
          const column = Number(args.column)
          if (!Number.isFinite(line) || !Number.isFinite(column) || line < 1 || column < 1) {
            return { ok: false, output: '"line" y "column" deben ser numeros enteros 1-indexados (>= 1).' }
          }

          const result = name === 'find_definition'
            ? await ctx.lspManager.findDefinition(target, line, column)
            : await ctx.lspManager.findReferences(
                target,
                line,
                column,
                !(args.include_declaration === false || args.include_declaration === 'false')
              )

          if (result.reason) {
            return { ok: true, output: result.reason }
          }
          if (result.locations.length === 0) {
            return {
              ok: true,
              output: name === 'find_definition'
                ? 'Sin resultados: el servidor no encontro ninguna definicion para esa posicion.'
                : 'Sin resultados: el servidor no encontro ninguna referencia para esa posicion.'
            }
          }
          const lines = result.locations.map(loc => {
            const relForDisplay = path.relative(ctx.workspace, loc.path) || loc.path
            return `${relForDisplay}:${loc.line}:${loc.column}`
          })
          return { ok: true, output: clip(lines.join('\n')) }
        }

        case 'list_symbols': {
          if (!ctx.lspManager) {
            return { ok: true, output: 'Navegacion por LSP no disponible: este runtime no tiene un language server conectado.' }
          }
          const relPathArg = String(args.path ?? '').trim()
          const query = String(args.query ?? '').trim()
          if (relPathArg && query) {
            return { ok: false, output: '"path" y "query" son excluyentes -- pasa uno u otro, no los dos.' }
          }
          if (!relPathArg && !query) {
            return { ok: false, output: 'Hace falta "path" (simbolos de un archivo) o "query" (busqueda por nombre en el workspace).' }
          }

          let result: LspSymbolsResult
          if (relPathArg) {
            const target = resolveWithinWorkspace(ctx.workspace, relPathArg)
            if (!existsSync(target) || !statSync(target).isFile()) {
              return { ok: false, output: `Archivo no encontrado: ${relPathArg}` }
            }
            result = await ctx.lspManager.listSymbolsInFile(target)
          } else {
            result = await ctx.lspManager.searchSymbols(query)
          }

          if (result.reason) {
            return { ok: true, output: result.reason }
          }
          if (result.symbols.length === 0) {
            const scopeNote = result.queriedLanguages
              ? (result.queriedLanguages.length
                  ? ` (lenguajes consultados: ${result.queriedLanguages.join(', ')})`
                  : ' (ningun language server esta corriendo todavia en esta sesion -- tocar un archivo primero, o usar "path" en vez de "query")')
              : ''
            return { ok: true, output: `Sin resultados${scopeNote}.` }
          }
          const lines = result.symbols.map(sym => {
            const kindLabel = LSP_SYMBOL_KIND_LABELS[sym.kind] ?? `kind ${sym.kind}`
            const location = sym.path
              ? `${path.relative(ctx.workspace, sym.path) || sym.path}:${sym.line}:${sym.column}`
              : `${sym.line}:${sym.column}`
            return `${kindLabel} ${sym.name} — ${location}`
          })
          return { ok: true, output: clip(lines.join('\n')) }
        }

        case 'list_dir': {
          const target = resolveWithinWorkspace(ctx.workspace, String(args.path ?? '.'))
          if (!existsSync(target) || !statSync(target).isDirectory()) {
            return { ok: false, output: `Directorio no encontrado: ${String(args.path ?? '.')}` }
          }
          const entries = readdirSync(target, { withFileTypes: true })
            .map(entry => `${entry.isDirectory() ? 'dir ' : 'file'}  ${entry.name}`)
          return { ok: true, output: clip(entries.join('\n') || '(directorio vacio)') }
        }

        case 'search_files': {
          const pattern = String(args.pattern ?? '').trim()
          if (!pattern) return { ok: false, output: 'Falta el parametro "pattern".' }
          const relSubPath = String(args.path ?? '').trim()
          // Defensivo: el modelo deberia mandar un boolean real (el schema
          // pide type:'boolean'), pero se tolera 'false' como string por si
          // algun proveedor lo serializa distinto — cualquier otra cosa
          // (undefined incluido) cae al default true.
          const caseSensitiveRaw = args.case_sensitive
          const caseSensitive = !(caseSensitiveRaw === false || caseSensitiveRaw === 'false')

          // Fase 12: search_files es de solo lectura (mismo criterio que
          // read_file/list_dir/git_status/git_diff) — nunca pasa por
          // resolveApproval(), no consulta ctx.sandbox.
          const searchRoot = resolveWithinWorkspace(ctx.workspace, relSubPath || '.')
          if (!existsSync(searchRoot)) {
            return { ok: false, output: `Ruta no encontrada: ${relSubPath || '.'}` }
          }
          const gitPathspec = relSubPath
            ? path.relative(ctx.workspace, searchRoot).split(path.sep).join('/')
            : null

          const formatResult = (matches: string[]): ToolExecutionResult => {
            if (matches.length === 0) return { ok: true, output: 'Sin resultados.' }
            const capped = matches.slice(0, SEARCH_FILES_MAX_MATCHES)
            const omitted = matches.length > SEARCH_FILES_MAX_MATCHES
              ? `\n[... se alcanzo el tope de ${SEARCH_FILES_MAX_MATCHES} coincidencias, puede haber mas — acota con el parametro "path" si hace falta]`
              : ''
            return { ok: true, output: clip(capped.join('\n') + omitted) }
          }

          const gitResult = await runGitGrep(pattern, ctx.workspace, gitPathspec, caseSensitive)
          if (gitResult.exitCode === 0 || gitResult.exitCode === 1) {
            // exit 0 = matches reales, exit 1 = busqueda valida sin matches
            // (NO es un fallo de git grep) — en ambos casos el resultado de
            // git grep es la respuesta final, no se cae al fallback manual.
            const lines = gitResult.stdout.split('\n').filter(Boolean)
            return formatResult(lines)
          }

          // Cualquier otro exit code (128 = no es repo git, -1 = git ni se
          // encontro/ENOENT, etc.) — fallback manual, mismo patron
          // "intentar lo rapido, caer a lo generico" que ya usa Fase 14
          // (deteccion de CLI).
          return formatResult(searchFilesManually(searchRoot, ctx.workspace, pattern, caseSensitive))
        }

        case 'run_command': {
          const command = String(args.command ?? '').trim()
          if (!command) return { ok: false, output: 'Comando vacio.' }
          const approved = await resolveApproval(ctx.sandbox, ctx.confirm, 'Ejecutar comando', command)
          if (!approved) {
            return {
              ok: false,
              output: ctx.sandbox === 'read-only'
                ? readOnlyBlockedMessage('ejecutar comandos')
                : 'El usuario rechazo la ejecucion del comando.'
            }
          }
          return runShellCommand(command, ctx.workspace)
        }

        case 'terminal_exec': {
          const command = String(args.command ?? '').trim()
          if (!command) return { ok: false, output: 'Comando vacio.' }
          // Mismo resolveApproval() EXACTO que run_command -- mismo modelo
          // de seguridad, sin categoria nueva (docs/_arch/verify_persistent_terminal_design.md,
          // Tarea 5): read-only bloquea de raiz, workspace-write pregunta
          // por CADA comando (mismo costo que run_command, relajarlo seria
          // una decision de seguridad propia y explicita, no un efecto
          // lateral de agregar esta tool), danger-full-access aprueba sin
          // preguntar. toolTrustSession ya lo cubre gratis via ctx.confirm().
          const approved = await resolveApproval(ctx.sandbox, ctx.confirm, 'Ejecutar comando (terminal persistente)', command)
          if (!approved) {
            return {
              ok: false,
              output: ctx.sandbox === 'read-only'
                ? readOnlyBlockedMessage('ejecutar comandos')
                : 'El usuario rechazo la ejecucion del comando.'
            }
          }
          if (!ctx.terminalExec) {
            return { ok: false, output: 'terminal_exec no esta disponible en este contexto de ejecucion.' }
          }
          const result = await ctx.terminalExec(command)
          const verdict = result.exitCode === 0 ? 'OK' : `FALLO (exit code ${result.exitCode ?? 'desconocido'})`
          return {
            ok: result.ok,
            output: `Comando: ${command}\nResultado: ${verdict}\nCodigo de salida: ${result.exitCode ?? 'desconocido'}\n\n${truncateForModel(result.output) || '(sin salida)'}`
          }
        }

        case 'git_status':
          return runGit(['status', '--porcelain', '-b'], ctx.workspace)

        case 'git_diff':
          return runGit(['diff'], ctx.workspace)

        // No es una rama mas del switch en el sentido de "ejecuta y
        // devuelve": dispara el mini-loop propio de explore-tool.ts contra
        // el modelo barato configurado. Si no hay uno configurado o valido,
        // devuelve el error directo aca (caso esperado); cualquier otro
        // fallo (HTTP, limite de iteraciones) lo lanza runExploreLoop y lo
        // atrapa el try/catch de este metodo, mas abajo — mismo resultado
        // {ok:false, output} sin duplicar el manejo de errores.
        case 'explore': {
          const task = String(args.task ?? '').trim()
          if (!task) {
            return { ok: false, output: 'Falta el parametro "task": describi en lenguaje natural que explorar.' }
          }
          if (!ctx.resolveExploreModel) {
            return { ok: false, output: 'explore no esta disponible en este contexto de ejecucion.' }
          }
          const target = ctx.resolveExploreModel()
          if (!target) {
            return {
              ok: false,
              output:
                'No hay modelo de compactacion configurado en Settings (seccion MEMORIA, ' +
                'compactionProviderId/compactionModelId) o el configurado ya no es valido — explore no puede ' +
                'delegar. Segui explorando vos mismo con read_file/list_dir/git_status/git_diff.'
            }
          }
          const readOnlyDefs = TOOL_DEFINITIONS.filter(def => (EXPLORE_TOOL_NAMES as readonly string[]).includes(def.name))
          const summary = await runExploreLoop({
            task,
            provider: target.provider,
            model: target.model,
            toolDefinitions: readOnlyDefs,
            runTool: (toolName, toolArgs) => this.execute(toolName, toolArgs, {
              workspace: ctx.workspace,
              // Fijo a 'read-only' A PROPOSITO — NO se hereda ctx.sandbox.
              // Si se heredara, un turno principal en danger-full-access
              // haria que resolveApproval() de este sub-contexto tome la
              // rama danger-full-access y devuelva true SIN LLAMAR A
              // confirm, anulando el "confirm: async () => false" de mas
              // abajo (Fase 4, segunda capa independiente por si el
              // whitelist de explore-tool.ts fallara). Con 'read-only'
              // fijo, resolveApproval toma la rama read-only y bloquea de
              // raiz sin siquiera intentar confirm — asi la whitelist
              // (Capa 1), este sandbox fijo (Capa 2, via resolveApproval)
              // y el confirm hardcodeado (Capa 3) quedan las tres
              // independientes entre si, cada una deny-by-default por su
              // cuenta, sin que una pueda anular a las otras.
              sandbox: 'read-only',
              confirm: async () => false
            })
          })
          return { ok: true, output: summary }
        }

        case 'list_file_history': {
          const relPath = String(args.path ?? '')
          if (!relPath) return { ok: false, output: 'Falta el parametro "path".' }
          resolveWithinWorkspace(ctx.workspace, relPath) // valida que no escape el workspace, aunque el archivo no tiene que existir hoy
          const entries = await listFileHistory(ctx.workspace, relPath)
          if (entries.length === 0) {
            return { ok: true, output: `${relPath} no tiene versiones guardadas todavia (nunca se edito via write_file/apply_patch/revert_file).` }
          }
          const lines = entries.map(entry => `${entry.date}  ${entry.ref}  ${entry.tool}`)
          return { ok: true, output: `Versiones de ${relPath} (mas reciente primero):\n${lines.join('\n')}` }
        }

        case 'revert_file': {
          const relPath = String(args.path ?? '')
          const ref = String(args.ref ?? '').trim()
          if (!relPath || !ref) {
            return { ok: false, output: 'Faltan "path" y/o "ref". Llama list_file_history primero para ver las referencias disponibles.' }
          }

          const target = resolveWithinWorkspace(ctx.workspace, relPath)
          const restoredContent = await readFileVersion(ctx.workspace, relPath, ref)
          if (restoredContent === null) {
            return {
              ok: false,
              output: `No se encontro la referencia "${ref}" para ${relPath}. Volve a llamar list_file_history para confirmar las referencias validas — no reintentes la misma ref.`
            }
          }

          const currentContent = existsSync(target) && statSync(target).isFile()
            ? readFileSync(target, 'utf8')
            : null
          // Fix real de staleness (docs/_arch/verify_run_command_revert_file_staleness.md):
          // huella tomada AHORA, en el mismo instante que currentContent — es
          // el contenido contra el que se arma el diff que el usuario esta
          // por aprobar. NO usa sessionFileHashes (confirmado sin valor real
          // en este flujo: revert_file se llama tras list_file_history, no
          // tras read_file) — mismo primitivo hashFileContent, mismo criterio
          // que el chequeo #1 (existingHash) de write_file/apply_patch.
          const existingHash = hashFileContent(currentContent)
          const approved = await resolveApproval(
            ctx.sandbox,
            ctx.confirm,
            `Restaurar version anterior: ${relPath}`,
            formatWriteFileDiff(currentContent, restoredContent).preview
          )
          if (!approved) {
            return {
              ok: false,
              output: ctx.sandbox === 'read-only'
                ? readOnlyBlockedMessage('restaurar archivos')
                : 'El usuario rechazo la restauracion del archivo.'
            }
          }

          // Fix real de staleness bajo concurrencia (Opcion A2, mismo
          // criterio que write_file/apply_patch -- ver el comentario
          // completo en local-vcs.ts): snapshotea el estado actual como
          // 'original' si hiciera falta (en la practica nunca dispara aca
          // -- history ya existe seguro, revert_file solo corre sobre un
          // archivo que list_file_history ya confirmo con historial real)
          // ANTES del re-chequeo final.
          const originalSnapshot = await snapshotOriginalIfNeeded({
            workspace: ctx.workspace,
            relPath,
            existingContent: currentContent
          })
          // Fix real de staleness: re-chequeo FINAL, SINCRONICO -- sin
          // ningun await entre esta comparacion y el writeFileSync de
          // abajo. resolveApproval() puede tardar (el usuario piensa la
          // confirmacion) y snapshotOriginalIfNeeded() cede el event loop
          // (subprocesos git reales); releer el disco real recien ahora y
          // comparar contra la huella de arriba. Sin esto, otra
          // sesion/panel que edito el mismo archivo mientras la aprobacion
          // estaba pendiente (o durante el snapshot de arriba) se pisaba en
          // silencio (mismo bug que d3a8fe4 cerro para write_file/apply_patch).
          const freshContent = existsSync(target) && statSync(target).isFile()
            ? readFileSync(target, 'utf8')
            : null
          if (hashFileContent(freshContent) !== existingHash) {
            return {
              ok: false,
              output: `El archivo "${relPath}" cambio en disco despues de que se genero la vista previa de esta restauracion (probablemente otra sesion/panel lo edito mientras tanto) -- volve a llamar list_file_history y revert_file de nuevo sobre el contenido actual.`
            }
          }

          writeFileSync(target, restoredContent, 'utf8')
          // La restauracion en si tambien es una version nueva (nunca se
          // borra historia) — mismo mecanismo que write_file/apply_patch,
          // commiteada DESPUES de la escritura real (Opcion A2) -- nunca
          // se alcanza si el re-chequeo de arriba rechazo.
          const versionSnapshot = await commitVersion({
            workspace: ctx.workspace,
            relPath,
            newContent: restoredContent,
            tool: 'revert_file'
          })
          const vcsNote = originalSnapshot.ok && versionSnapshot.ok
            ? ''
            : ` [AVISO: no se pudo registrar completamente la restauracion en el historial — ${versionSnapshot.error ?? originalSnapshot.error}]`
          return { ok: true, output: `Archivo restaurado: ${relPath} (version ${ref})${vcsNote}` }
        }

        case 'list_windows': {
          if (!ctx.listWindows) {
            return { ok: false, output: 'list_windows no esta disponible en este contexto de ejecucion.' }
          }
          const windows = ctx.listWindows()
          if (windows.length === 0) {
            return { ok: true, output: 'No hay otros chats.' }
          }
          const lines = windows.map(w => {
            const aliasSuffix = w.alias ? ` (alias corto: "${w.alias}")` : ''
            return `"${w.title}"${aliasSuffix} -- ${w.status}`
          })
          return { ok: true, output: lines.join('\n') }
        }

        case 'send_to_window': {
          const destino = String(args.destino ?? '').trim()
          const mensaje = String(args.mensaje ?? '').trim()
          if (!destino || !mensaje) {
            return { ok: false, output: 'Faltan "destino" y/o "mensaje".' }
          }
          if (!ctx.sendToWindowByTitle) {
            return { ok: false, output: 'send_to_window no esta disponible en este contexto de ejecucion.' }
          }

          // Mensajeria entre ventanas, Paso 3: aprobacion SIEMPRE, sin
          // excepcion -- a proposito NO pasa por resolveApproval() (que
          // puede auto-aprobar en danger-full-access o auto-rechazar en
          // read-only segun el sandbox activo). send_to_window dispara un
          // turno real en OTRA ventana/sesion, fuera del sandbox de ESTE
          // turno por completo -- el sandbox mode de la conexion actual no
          // tiene ninguna relacion con si mandar un mensaje a otro chat es
          // seguro o no, asi que se llama a ctx.confirm() DIRECTO e
          // incondicional, mismo mecanismo de dialogo real que usan
          // write_file/apply_patch/run_command/revert_file, pero sin la
          // rama de sandbox que ellas si tienen.
          const approved = await ctx.confirm(
            `Enviar mensaje a "${destino}"`,
            mensaje
          )
          if (!approved) {
            return { ok: false, output: 'El usuario rechazo el envio del mensaje a otra ventana.' }
          }

          const result = await ctx.sendToWindowByTitle(destino, mensaje)
          return result.ok
            ? { ok: true, output: `Mensaje entregado a "${destino}". Respuesta:\n${result.text}` }
            : { ok: false, output: result.error }
        }

        case 'parallel_ask': {
          const subtasksRaw = args.subtasks
          const subtasks = Array.isArray(subtasksRaw)
            ? subtasksRaw.map(item => String(item ?? '').trim()).filter(Boolean)
            : []
          if (subtasks.length === 0) {
            return { ok: false, output: 'Falta "subtasks" (lista de sub-tareas, al menos una).' }
          }
          if (!ctx.planParallelAsk || !ctx.runParallelAsk) {
            return { ok: false, output: 'parallel_ask no esta disponible en este contexto de ejecucion.' }
          }

          const plan = await ctx.planParallelAsk(subtasks)
          if (!plan.ok) {
            return { ok: false, output: plan.error }
          }

          // Tarea 5 (verify_parallel_orchestrator_design.md): aprobacion
          // SIEMPRE, incondicional -- mismo criterio de gasto real que
          // send_to_window/generate_image/web_search (ctx.confirm() directo,
          // sin pasar por resolveApproval()/sandbox: el sandbox local de
          // ESTE turno no tiene relacion con si gastar N llamadas reales es
          // seguro o no). Detalle COMPLETO -- cada sub-tarea + el panel/
          // modelo real que se le va a asignar, calculado por
          // ctx.planParallelAsk() arriba, mostrado ANTES de disparar nada.
          const approved = await ctx.confirm(
            `Repartir ${subtasks.length} sub-tarea(s) en paralelo entre ${new Set(plan.assignments.map(a => a.panelId)).size} panel(es)`,
            formatParallelPlanDetail(plan.assignments)
          )
          if (!approved) {
            return { ok: false, output: 'El usuario rechazo repartir las sub-tareas en paralelo.' }
          }

          const outcomes = await ctx.runParallelAsk(plan.assignments)
          return { ok: true, output: formatParallelAskOutput(outcomes) }
        }

        case 'generate_image': {
          const prompt = String(args.prompt ?? '').trim()
          if (!prompt) {
            return { ok: false, output: 'Falta "prompt".' }
          }
          if (!ctx.generateImage) {
            return { ok: false, output: 'generate_image no esta disponible en este contexto de ejecucion.' }
          }

          // Aprobacion SIEMPRE incondicional, mismo criterio exacto que
          // send_to_window de arriba -- generar una imagen real gasta
          // cuota/dinero de la conexion configurada, sin ninguna relacion
          // con el sandbox mode de ESTE turno (que puede ser read-only y
          // esto igual no es "escribir en el workspace"). ctx.confirm()
          // directo, nunca resolveApproval().
          const approved = await ctx.confirm('Generar imagen', prompt)
          if (!approved) {
            return { ok: false, output: 'El usuario rechazo la generacion de la imagen.' }
          }

          const result = await ctx.generateImage(prompt)
          return result.ok
            ? { ok: true, output: 'Imagen generada y adjuntada a tu mensaje.', generatedAttachment: result.attachment }
            : { ok: false, output: result.error }
        }

        case 'web_search': {
          const query = String(args.query ?? '').trim()
          if (!query) return { ok: false, output: 'Falta "query".' }
          if (!ctx.webSearch) {
            return { ok: false, output: 'web_search no esta disponible en este contexto de ejecucion.' }
          }
          const maxResultsArg = args.max_results === undefined ? undefined : Number(args.max_results)

          // Aprobacion SIEMPRE incondicional, mismo criterio exacto que
          // generate_image -- buscar en la web real gasta cuota/dinero de
          // Tavily, sin ninguna relacion con el sandbox mode de ESTE turno.
          // ctx.confirm() directo, nunca resolveApproval().
          const approved = await ctx.confirm('Buscar en la web', query)
          if (!approved) {
            return { ok: false, output: 'El usuario rechazo la busqueda web.' }
          }

          const result = await ctx.webSearch(query, maxResultsArg)
          if (!result.ok) return { ok: false, output: result.error }
          if (result.result.results.length === 0) {
            return { ok: true, output: `Sin resultados reales para "${query}".` }
          }
          const lines: string[] = []
          if (result.result.answer) lines.push(`Respuesta sintetizada: ${result.result.answer}`, '')
          for (const item of result.result.results) {
            lines.push(`- ${item.title}\n  ${item.url}\n  ${item.content}`)
          }
          return { ok: true, output: clip(lines.join('\n')) }
        }

        case 'web_fetch': {
          const url = String(args.url ?? '').trim()
          if (!url) return { ok: false, output: 'Falta "url".' }
          if (!ctx.webFetch) {
            return { ok: false, output: 'web_fetch no esta disponible en este contexto de ejecucion.' }
          }

          // Mismo criterio exacto que generate_image/web_search -- gasta
          // cuota/dinero real de Tavily, aprobacion incondicional.
          const approved = await ctx.confirm('Extraer contenido de una URL', url)
          if (!approved) {
            return { ok: false, output: 'El usuario rechazo la extraccion de la URL.' }
          }

          const result = await ctx.webFetch(url)
          return result.ok
            ? { ok: true, output: clip(result.result.content) }
            : { ok: false, output: result.error }
        }

        case 'todo_write': {
          const rawTodos = args.todos
          if (!Array.isArray(rawTodos)) return { ok: false, output: 'Falta "todos" (debe ser un array).' }

          const todos: TodoList = []
          for (const item of rawTodos) {
            const content = typeof (item as TodoItem)?.content === 'string' ? (item as TodoItem).content.trim() : ''
            const status = (item as TodoItem)?.status
            if (!content || !['pending', 'in_progress', 'completed'].includes(status)) {
              return { ok: false, output: 'Cada item de "todos" necesita "content" (string no vacio) y "status" (pending/in_progress/completed).' }
            }
            const priority = (item as TodoItem)?.priority
            todos.push({
              id: typeof (item as TodoItem)?.id === 'string' ? (item as TodoItem).id : undefined,
              content,
              status,
              priority: priority === 'high' || priority === 'medium' || priority === 'low' ? priority : undefined
            })
          }

          // Validacion fail-closed (docs/_arch/verify_todo_write_design.md,
          // Tarea 4): rechazar con error claro en vez de auto-corregir en
          // silencio -- mismo criterio ya aplicado hoy a TOCTOU/sandbox. El
          // costo de un rechazo aca es casi nulo (reemplazo total, sin
          // estado parcial que reconciliar) frente al riesgo de que el
          // modelo crea que 2 tareas quedaron in_progress cuando en
          // realidad Amatista degrado una en silencio.
          const inProgress = todos.filter(t => t.status === 'in_progress')
          if (inProgress.length > 1) {
            return {
              ok: false,
              output: `Solo puede haber una tarea en "in_progress" a la vez -- marcadas in_progress: ${inProgress.map(t => `"${t.content}"`).join(', ')}. Volve a llamar todo_write con una sola.`
            }
          }

          if (!ctx.writeTodos) {
            return { ok: false, output: 'todo_write no esta disponible en este contexto de ejecucion.' }
          }
          const written = ctx.writeTodos(todos)
          if (!written.ok) return { ok: false, output: written.error }
          return { ok: true, output: `Lista de tareas actualizada (${todos.length} item${todos.length === 1 ? '' : 's'}).` }
        }

        case 'exit_plan_mode': {
          const plan = String(args.plan ?? '').trim()
          if (!plan) return { ok: false, output: 'Falta "plan".' }
          if (!ctx.exitPlanMode) {
            return { ok: false, output: 'exit_plan_mode no esta disponible en este contexto de ejecucion.' }
          }

          // Mismo mecanismo exacto que send_to_window/web_search/generate_image
          // -- ctx.confirm() incondicional, esto NO es "aprobar una accion
          // puntual" (no hay resolveApproval()/sandbox de por medio), es
          // "aprobar el plan completo antes de dejar ejecutar nada".
          const approved = await ctx.confirm('Plan propuesto -- aprobar para ejecutar', plan)
          if (!approved) {
            return { ok: false, output: 'El usuario rechazo el plan -- segui en modo plan, ajustalo segun su feedback y volve a llamar exit_plan_mode cuando este listo de nuevo.' }
          }

          // Molde real de toolTrustSession (docs/_arch/verify_plan_mode_design.md,
          // Tarea 3): 1 aprobacion puntual transiciona el estado de la
          // SESION completa, no solo esta tool call -- disablePlanMode()
          // (runtime-state.ts) apaga planModeActive y, si estaba forzado,
          // revierte el sandbox real al que la sesion tenia antes.
          ctx.exitPlanMode()
          return { ok: true, output: 'Plan aprobado -- modo plan desactivado, podes proceder a ejecutarlo.' }
        }

        case 'load_skill': {
          const name = String(args.name ?? '').trim()
          if (!name) return { ok: false, output: 'Falta el parametro "name".' }
          // Sin resolveApproval()/ctx.confirm() -- solo lee un archivo de
          // skill local, mismo criterio que list_windows (solo lectura,
          // sin aprobacion, disponible en cualquier sandbox). Import
          // directo de skill-manager.ts (no una closure de ExecuteContext):
          // no necesita ningun estado de sesion, solo ctx.workspace, ya
          // existente -- mismo patron que listFileHistory/readFileVersion
          // (local-vcs.ts).
          const result = getSkillBody(ctx.workspace, name)
          return result.ok
            ? { ok: true, output: clip(result.body) }
            : { ok: false, output: result.error }
        }

        // Tools de sistema Windows (docs/_arch/verify_windows_control_design.md,
        // Familia B) -- notify hasta volume: MISMO resolveApproval() exacto
        // que run_command (read-only bloquea de raiz, workspace-write
        // pregunta, danger-full-access aprueba sin preguntar). close_app/
        // lock_screen/power (al final): ctx.hardConfirm() directo e
        // incondicional -- NUNCA resolveApproval(), ver el comentario
        // completo en ExecuteContext.hardConfirm (mas arriba en este
        // archivo) y requestHardToolApproval() (runtime-state.ts).

        case 'notify': {
          const title = String(args.title ?? '').trim()
          const message = String(args.message ?? '').trim()
          if (!title || !message) return { ok: false, output: 'Faltan "title" y/o "message".' }
          const approved = await resolveApproval(ctx.sandbox, ctx.confirm, 'Mostrar notificacion', `${title}\n${message}`)
          if (!approved) {
            return { ok: false, output: ctx.sandbox === 'read-only' ? readOnlyBlockedMessage('mostrar notificaciones') : 'El usuario rechazo mostrar la notificacion.' }
          }
          if (!Notification.isSupported()) return { ok: false, output: 'Las notificaciones no estan soportadas en este sistema.' }
          new Notification({ title, body: message }).show()
          return { ok: true, output: 'Notificacion mostrada.' }
        }

        case 'clipboard_get': {
          const approved = await resolveApproval(ctx.sandbox, ctx.confirm, 'Leer portapapeles', 'Leer el contenido actual del portapapeles del sistema.')
          if (!approved) {
            return { ok: false, output: ctx.sandbox === 'read-only' ? readOnlyBlockedMessage('leer el portapapeles') : 'El usuario rechazo leer el portapapeles.' }
          }
          const text = clipboard.readText()
          return { ok: true, output: text ? clip(text) : '(el portapapeles esta vacio, o no contiene texto)' }
        }

        case 'clipboard_set': {
          const text = String(args.text ?? '')
          if (!text) return { ok: false, output: 'Falta "text".' }
          const approved = await resolveApproval(ctx.sandbox, ctx.confirm, 'Escribir portapapeles', text)
          if (!approved) {
            return { ok: false, output: ctx.sandbox === 'read-only' ? readOnlyBlockedMessage('escribir en el portapapeles') : 'El usuario rechazo escribir en el portapapeles.' }
          }
          clipboard.writeText(text)
          return { ok: true, output: 'Portapapeles actualizado.' }
        }

        case 'open_url': {
          const url = String(args.url ?? '').trim()
          if (!/^https?:\/\//i.test(url)) return { ok: false, output: 'Solo se admiten URLs http:// o https://.' }
          const approved = await resolveApproval(ctx.sandbox, ctx.confirm, 'Abrir URL', url)
          if (!approved) {
            return { ok: false, output: ctx.sandbox === 'read-only' ? readOnlyBlockedMessage('abrir URLs') : 'El usuario rechazo abrir la URL.' }
          }
          await shell.openExternal(url)
          return { ok: true, output: `URL abierta: ${url}` }
        }

        case 'open_folder': {
          const relPath = String(args.path ?? '').trim()
          if (!relPath) return { ok: false, output: 'Falta "path".' }
          let target: string
          try {
            target = resolveWithinWorkspace(ctx.workspace, relPath)
          } catch {
            // Fuera del workspace -- a diferencia de read_file/write_file
            // (siempre confinados), open_folder acepta rutas absolutas
            // reales de la maquina a proposito (abrir "la carpeta de
            // Descargas", fuera del workspace, es un pedido legitimo real)
            // -- el path.isAbsolute() de abajo es la unica validacion
            // estructural, resolveApproval() sigue siendo el gate real.
            target = path.isAbsolute(relPath) ? relPath : path.resolve(ctx.workspace, relPath)
          }
          if (!existsSync(target) || !statSync(target).isDirectory()) {
            return { ok: false, output: `No es una carpeta existente: ${relPath}` }
          }
          const approved = await resolveApproval(ctx.sandbox, ctx.confirm, 'Abrir carpeta', target)
          if (!approved) {
            return { ok: false, output: ctx.sandbox === 'read-only' ? readOnlyBlockedMessage('abrir carpetas') : 'El usuario rechazo abrir la carpeta.' }
          }
          const error = await shell.openPath(target)
          return error ? { ok: false, output: `No se pudo abrir la carpeta: ${error}` } : { ok: true, output: `Carpeta abierta: ${target}` }
        }

        case 'open_app': {
          const appName = String(args.name ?? '').trim()
          if (!appName) return { ok: false, output: 'Falta "name".' }
          const approved = await resolveApproval(ctx.sandbox, ctx.confirm, 'Abrir aplicacion', appName)
          if (!approved) {
            return { ok: false, output: ctx.sandbox === 'read-only' ? readOnlyBlockedMessage('abrir aplicaciones') : 'El usuario rechazo abrir la aplicacion.' }
          }
          return openApp(appName)
        }

        case 'list_processes': {
          const approved = await resolveApproval(ctx.sandbox, ctx.confirm, 'Listar procesos', 'Listar los procesos reales corriendo en esta maquina.')
          if (!approved) {
            return { ok: false, output: ctx.sandbox === 'read-only' ? readOnlyBlockedMessage('listar procesos') : 'El usuario rechazo listar los procesos.' }
          }
          const result = await runPowerShell(
            "Get-Process | Sort-Object -Property WS -Descending | Select-Object -First 60 Id,ProcessName,@{N='MemMB';E={[math]::Round($_.WS/1MB,1)}} | Format-Table -AutoSize | Out-String -Width 200"
          )
          if (!result.ok) return { ok: false, output: `No se pudo listar los procesos: ${clip(result.stderr || 'error desconocido')}` }
          return { ok: true, output: clip(result.stdout.trim()) || '(sin procesos)' }
        }

        case 'system_info': {
          const approved = await resolveApproval(ctx.sandbox, ctx.confirm, 'Informacion del sistema', 'Leer version de Windows, CPU, RAM y disco de esta maquina.')
          if (!approved) {
            return { ok: false, output: ctx.sandbox === 'read-only' ? readOnlyBlockedMessage('leer informacion del sistema') : 'El usuario rechazo leer informacion del sistema.' }
          }
          const script = [
            '$os = Get-CimInstance Win32_OperatingSystem',
            '$cpu = Get-CimInstance Win32_Processor | Select-Object -First 1',
            '$disk = Get-CimInstance Win32_LogicalDisk -Filter "DeviceID=\'$($env:SystemDrive)\'"',
            '$ramTotalGB = [math]::Round($os.TotalVisibleMemorySize/1MB,1)',
            '$ramFreeGB = [math]::Round($os.FreePhysicalMemory/1MB,1)',
            '$diskFreeGB = [math]::Round($disk.FreeSpace/1GB,1)',
            '$diskTotalGB = [math]::Round($disk.Size/1GB,1)',
            '"Windows: $($os.Caption) (build $($os.BuildNumber))"',
            '"CPU: $($cpu.Name)"',
            '"RAM: $($ramTotalGB - $ramFreeGB) GB en uso de $ramTotalGB GB total"',
            '"Disco $($env:SystemDrive): $diskFreeGB GB libres de $diskTotalGB GB total"'
          ].join('; ')
          const result = await runPowerShell(script)
          if (!result.ok) return { ok: false, output: `No se pudo leer la informacion del sistema: ${clip(result.stderr || 'error desconocido')}` }
          return { ok: true, output: result.stdout.trim() || '(sin datos)' }
        }

        case 'volume': {
          const action = String(args.action ?? '').trim()
          if (!['up', 'down', 'mute'].includes(action)) return { ok: false, output: '"action" debe ser "up", "down" o "mute".' }
          const approved = await resolveApproval(ctx.sandbox, ctx.confirm, 'Cambiar volumen', `Accion: ${action}`)
          if (!approved) {
            return { ok: false, output: ctx.sandbox === 'read-only' ? readOnlyBlockedMessage('cambiar el volumen') : 'El usuario rechazo cambiar el volumen.' }
          }
          // keybd_event real via user32 -- mismas teclas fisicas de
          // multimedia (VK_VOLUME_UP=0xAF, VK_VOLUME_DOWN=0xAE,
          // VK_VOLUME_MUTE=0xAD), 0x1 = KEYEVENTF_KEYDOWN, luego 0x1|0x2 =
          // KEYEVENTF_KEYDOWN|KEYEVENTF_KEYUP para soltarla -- mismo efecto
          // real que el usuario apretando la tecla, sin fijar un % exacto
          // (Windows no expone eso de forma simple sin un modulo COM
          // aparte, fuera de alcance de esta tool).
          const vkCode = action === 'up' ? '0xAF' : action === 'down' ? '0xAE' : '0xAD'
          const script =
            'Add-Type -TypeDefinition \'using System.Runtime.InteropServices; public class VolKey { [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, System.UIntPtr dwExtraInfo); }\'; ' +
            `[VolKey]::keybd_event(${vkCode}, 0, 0, [System.UIntPtr]::Zero); [VolKey]::keybd_event(${vkCode}, 0, 2, [System.UIntPtr]::Zero)`
          const result = await runPowerShell(script)
          return result.ok
            ? { ok: true, output: `Volumen: accion "${action}" aplicada.` }
            : { ok: false, output: `No se pudo cambiar el volumen: ${clip(result.stderr || 'error desconocido')}` }
        }

        case 'close_app': {
          const appName = String(args.name ?? '').trim()
          if (!appName) return { ok: false, output: 'Falta "name".' }
          if (!ctx.hardConfirm) return { ok: false, output: 'close_app no esta disponible en este contexto de ejecucion.' }
          const approved = await ctx.hardConfirm(
            `Cerrar aplicacion: "${appName}"`,
            `Se va a buscar y CERRAR A LA FUERZA (sin guardar cambios) todo proceso cuyo nombre contenga "${appName}". Esta accion es irreversible.`
          )
          if (!approved) return { ok: false, output: 'El usuario rechazo cerrar la aplicacion.' }
          // Busqueda parcial real via tasklist + filtro por substring, taskkill
          // /PID puntual por cada match (/T mata el arbol de hijos, /F fuerza)
          // -- mismo criterio real que Q (Process.GetProcesses().Where(nombre
          // contiene substring)), sin depender de que taskkill /IM soporte
          // wildcards de forma confiable.
          const list = await runPowerShell(
            "Get-Process | Where-Object { $_.ProcessName -like '*" + appName.replace(/'/g, "''") + "*' } | Select-Object -ExpandProperty Id"
          )
          const pids = list.stdout.split(/\r?\n/).map(l => l.trim()).filter(l => /^\d+$/.test(l))
          if (pids.length === 0) return { ok: false, output: `No se encontro ningun proceso real cuyo nombre contenga "${appName}".` }
          let killed = 0
          const errors: string[] = []
          for (const pid of pids) {
            const result = await new Promise<{ ok: boolean; stderr: string }>(resolve => {
              execFile('taskkill', ['/PID', pid, '/T', '/F'], { windowsHide: true, timeout: RUN_COMMAND_TIMEOUT_MS }, (error, _stdout, stderr) => {
                resolve({ ok: !error, stderr })
              })
            })
            if (result.ok) killed++
            else errors.push(`PID ${pid}: ${result.stderr.trim() || 'fallo desconocido'}`)
          }
          return killed > 0
            ? { ok: true, output: `${killed} de ${pids.length} proceso(s) cerrado(s).${errors.length ? `\nFallos:\n${errors.join('\n')}` : ''}` }
            : { ok: false, output: `No se pudo cerrar ningun proceso.\n${errors.join('\n')}` }
        }

        case 'lock_screen': {
          if (!ctx.hardConfirm) return { ok: false, output: 'lock_screen no esta disponible en este contexto de ejecucion.' }
          const approved = await ctx.hardConfirm(
            'Bloquear la sesion de Windows',
            'Se va a bloquear la sesion de Windows AHORA MISMO. Va a hacer falta la contraseña/PIN real para volver a entrar.'
          )
          if (!approved) return { ok: false, output: 'El usuario rechazo bloquear la sesion.' }
          const result = await new Promise<{ ok: boolean; stderr: string }>(resolve => {
            execFile('rundll32.exe', ['user32.dll,LockWorkStation'], { windowsHide: true, timeout: RUN_COMMAND_TIMEOUT_MS }, (error, _stdout, stderr) => {
              resolve({ ok: !error, stderr })
            })
          })
          return result.ok ? { ok: true, output: 'Sesion bloqueada.' } : { ok: false, output: `No se pudo bloquear la sesion: ${clip(result.stderr || 'error desconocido')}` }
        }

        case 'power': {
          const action = String(args.action ?? '').trim()
          if (!['shutdown', 'restart', 'sleep'].includes(action)) return { ok: false, output: '"action" debe ser "shutdown", "restart" o "sleep".' }
          if (!ctx.hardConfirm) return { ok: false, output: 'power no esta disponible en este contexto de ejecucion.' }
          const actionLabel = action === 'shutdown' ? 'APAGAR' : action === 'restart' ? 'REINICIAR' : 'SUSPENDER'
          const approved = await ctx.hardConfirm(
            `${actionLabel} esta maquina`,
            `Se va a ${actionLabel.toLowerCase()} esta maquina Windows REAL ahora mismo. Cualquier trabajo sin guardar en cualquier aplicacion abierta se pierde. Esta accion es irreversible.`
          )
          if (!approved) return { ok: false, output: 'El usuario rechazo la accion de energia.' }
          // shutdown.exe: /s apagar, /r reiniciar, /t 0 sin demora. "sleep"
          // no tiene flag de shutdown.exe -- SetSuspendState real via
          // System.Windows.Forms (PowerShell), unica via simple sin un
          // segundo binario/modulo nativo.
          if (action === 'sleep') {
            const result = await runPowerShell(
              "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Application]::SetSuspendState('Suspend', $false, $false)"
            )
            return result.ok ? { ok: true, output: 'Maquina suspendida.' } : { ok: false, output: `No se pudo suspender: ${clip(result.stderr || 'error desconocido')}` }
          }
          const flag = action === 'shutdown' ? '/s' : '/r'
          const result = await new Promise<{ ok: boolean; stderr: string }>(resolve => {
            execFile('shutdown.exe', [flag, '/t', '0'], { windowsHide: true, timeout: RUN_COMMAND_TIMEOUT_MS }, (error, _stdout, stderr) => {
              resolve({ ok: !error, stderr })
            })
          })
          return result.ok
            ? { ok: true, output: `Maquina ${action === 'shutdown' ? 'apagandose' : 'reiniciandose'}.` }
            : { ok: false, output: `No se pudo ejecutar la accion de energia: ${clip(result.stderr || 'error desconocido')}` }
        }

        // Familia A (computer use) -- guardia de 2 capas real en las 4:
        // Capa 1 (ctx.computerUseActive) bloquea de raiz SIN llamar a
        // hardConfirm si el usuario no activo "Control de escritorio" para
        // este panel -- mismo principio que resolveApproval() bloqueando
        // 'read-only' sin llamar a confirm(). Capa 2 (ctx.hardConfirm())
        // SIEMPRE despues, incondicional -- MISMO mecanismo exacto que
        // close_app/lock_screen/power (nunca respeta toolTrustSession, nunca
        // se saltea con danger-full-access). computerUseBegin()/End()
        // alrededor SOLO de la ejecucion real (nunca del hardConfirm, que
        // puede tardar indefinido esperando al humano) -- el overlay de
        // pantalla completa se muestra solo mientras la accion corre de
        // verdad, ver runtime-state.ts.

        case 'screenshot': {
          if (!ctx.computerUseActive) {
            return { ok: false, output: 'Control de escritorio no esta activado para este panel -- el usuario tiene que activarlo primero (Configuracion + toggle del composer).' }
          }
          if (!ctx.hardConfirm) return { ok: false, output: 'screenshot no esta disponible en este contexto de ejecucion.' }
          const displayArg = args.display === undefined ? undefined : Number(args.display)
          const approved = await ctx.hardConfirm(
            'Capturar pantalla',
            displayArg ? `Tomar una captura real del monitor ${displayArg}.` : 'Tomar una captura real del monitor primario.'
          )
          if (!approved) return { ok: false, output: 'El usuario rechazo la captura de pantalla.' }
          ctx.computerUseBegin?.()
          try {
            const shot = await takeScreenshot(displayArg)
            return {
              ok: true,
              output: `Captura real de ${shot.width}x${shot.height}px (monitor ${displayArg ?? 'primario'} de ${shot.displayCount} reales).`,
              resultImageDataUrl: shot.dataUrl
            }
          } finally {
            ctx.computerUseEnd?.()
          }
        }

        case 'mouse_move': {
          if (!ctx.computerUseActive) {
            return { ok: false, output: 'Control de escritorio no esta activado para este panel -- el usuario tiene que activarlo primero (Configuracion + toggle del composer).' }
          }
          if (!ctx.hardConfirm) return { ok: false, output: 'mouse_move no esta disponible en este contexto de ejecucion.' }
          const x = Number(args.x)
          const y = Number(args.y)
          if (!Number.isFinite(x) || !Number.isFinite(y)) return { ok: false, output: '"x"/"y" deben ser numeros reales.' }
          const approved = await ctx.hardConfirm('Mover el mouse', `Mover el cursor real a (${x}, ${y}).`)
          if (!approved) return { ok: false, output: 'El usuario rechazo mover el mouse.' }
          ctx.computerUseBegin?.()
          try {
            const result = await moveMouseTo({ x, y }, ctx.computerUseAbortSignal)
            return result.interrupted
              ? { ok: false, output: `Movimiento interrumpido a mitad de camino en (${Math.round(result.point.x)}, ${Math.round(result.point.y)}) -- el turno se cancelo mientras se movia.` }
              : { ok: true, output: `Cursor movido a (${Math.round(result.point.x)}, ${Math.round(result.point.y)}).` }
          } finally {
            ctx.computerUseEnd?.()
          }
        }

        case 'mouse_click': {
          if (!ctx.computerUseActive) {
            return { ok: false, output: 'Control de escritorio no esta activado para este panel -- el usuario tiene que activarlo primero (Configuracion + toggle del composer).' }
          }
          if (!ctx.hardConfirm) return { ok: false, output: 'mouse_click no esta disponible en este contexto de ejecucion.' }
          const description = args.description !== undefined ? String(args.description).trim() : undefined
          const x = args.x === undefined ? undefined : Number(args.x)
          const y = args.y === undefined ? undefined : Number(args.y)
          if (!description && !(Number.isFinite(x) && Number.isFinite(y))) {
            return { ok: false, output: 'Falta "description" (control real de Windows a clickear por nombre), o "x"/"y" para el fallback de coordenadas.' }
          }
          const button = args.button === 'right' ? 'right' : 'left'
          const detail = description
            ? `Click en: "${description}"`
            : `Click ${button === 'right' ? 'derecho' : 'izquierdo'} real en (${x}, ${y}).`
          const approved = await ctx.hardConfirm('Click del mouse', detail)
          if (!approved) return { ok: false, output: 'El usuario rechazo el click del mouse.' }
          ctx.computerUseBegin?.()
          try {
            // Mecanismo PRIMARIO: UI Automation real por nombre/tipo de
            // control (docs/_arch/verify_flaui_helper_viability.md) --
            // resuelve + clickea en el mismo round-trip del helper, inmune
            // a que la ventana se haya movido entre que el modelo decidio
            // el target y esta tool corre.
            if (description) {
              const result = await clickByDescription(description, button)
              if (result.status === 'ok') {
                return { ok: true, output: `Click real ejecutado (UI Automation) en <${result.controlType}> "${result.name}".` }
              }
              if (result.status === 'not_found') {
                return { ok: false, output: `No se encontro ningun control real de Windows con esa descripcion. Disponibles:\n${(result.candidates ?? []).join('\n') || '(ninguno)'}` }
              }
              if (result.status === 'ambiguous') {
                return { ok: false, output: `Descripcion ambigua, varios controles reales matchean:\n${(result.candidates ?? []).join('\n')}` }
              }
              return {
                ok: false,
                output: `No se pudo resolver el click semantico real (${result.error ?? 'UI Automation no disponible'}) -- reintenta con "x"/"y" si el contenido no es semantico (ej. un canvas de dibujo).`
              }
            }
            // Fallback EXPLICITO: coordenadas puras, mecanismo original sin
            // cambios (PowerShell/user32) -- para contenido real no-semantico.
            const result = await clickAt({ x: x as number, y: y as number }, button, ctx.computerUseAbortSignal)
            if (result.blockedByUac) {
              return { ok: false, output: 'Rechazado: el destino real es un dialogo de elevacion de permisos de Windows (UAC) -- prohibido sin excepcion, no se ejecuto ningun click.' }
            }
            if (result.interrupted) {
              return { ok: false, output: `Click interrumpido a mitad de camino (el turno se cancelo mientras se movia el mouse) -- nunca llego a clickear.` }
            }
            // hit_test real, best-effort, puramente diagnostico -- NUNCA
            // reemplaza el click ya ejecutado arriba, solo enriquece el
            // mensaje con que UI Automation detecto en ese punto real (o
            // confirma que no habia nada semantico).
            const hint = await describeCoordinateTarget(result.point.x, result.point.y)
            return {
              ok: true,
              output: `Click ${button} real ejecutado en (${Math.round(result.point.x)}, ${Math.round(result.point.y)})` +
                (hint ? ` -- UI Automation detecto ahi: ${hint}.` : '.')
            }
          } finally {
            ctx.computerUseEnd?.()
          }
        }

        case 'keyboard_type': {
          if (!ctx.computerUseActive) {
            return { ok: false, output: 'Control de escritorio no esta activado para este panel -- el usuario tiene que activarlo primero (Configuracion + toggle del composer).' }
          }
          if (!ctx.hardConfirm) return { ok: false, output: 'keyboard_type no esta disponible en este contexto de ejecucion.' }
          const description = args.description !== undefined ? String(args.description).trim() : undefined
          const text = String(args.text ?? '')
          if (!text) return { ok: false, output: 'Falta "text".' }
          const approved = await ctx.hardConfirm('Escribir texto', description ? `Campo: "${description}"\nTexto: ${text}` : text)
          if (!approved) return { ok: false, output: 'El usuario rechazo escribir el texto.' }
          ctx.computerUseBegin?.()
          try {
            // Mecanismo PRIMARIO: UI Automation real por nombre/tipo de
            // control -- resuelve+enfoca antes de escribir, sin depender de
            // un mouse_click previo.
            if (description) {
              const result = await typeByDescription(description, text, ctx.computerUseAbortSignal)
              if (result.status === 'not_found') {
                return { ok: false, output: `No se encontro ningun campo real de Windows con esa descripcion. Disponibles:\n${(result.candidates ?? []).join('\n') || '(ninguno)'}` }
              }
              if (result.status === 'ambiguous') {
                return { ok: false, output: `Descripcion ambigua, varios campos reales matchean:\n${(result.candidates ?? []).join('\n')}` }
              }
              if (result.status === 'error') {
                return {
                  ok: false,
                  output: `No se pudo resolver el campo real (${result.error ?? 'UI Automation no disponible'}) -- reintenta sin "description" si el foco ya esta en el campo correcto.`
                }
              }
              if (result.interrupted) {
                return { ok: false, output: `Tipeo interrumpido a mitad de camino -- ${result.charsTyped}/${result.totalChars} caracteres reales llegaron a escribirse antes de cancelarse.` }
              }
              return { ok: true, output: `${result.charsTyped} caracter(es) reales escritos (UI Automation) en <${result.controlType}> "${result.name}".` }
            }
            // Fallback EXPLICITO: escribe en el foco actual, mecanismo
            // original sin cambios (nut-js).
            const result = await typeText(text, ctx.computerUseAbortSignal)
            if (result.blockedByUac) {
              return { ok: false, output: 'Rechazado: el destino real es un dialogo de elevacion de permisos de Windows (UAC) -- prohibido sin excepcion, no se escribio nada.' }
            }
            if (result.interrupted) {
              return { ok: false, output: `Tipeo interrumpido a mitad de camino -- ${result.charsTyped}/${result.totalChars} caracteres reales llegaron a escribirse antes de cancelarse.` }
            }
            return { ok: true, output: `${result.charsTyped} caracter(es) reales escritos.` }
          } finally {
            ctx.computerUseEnd?.()
          }
        }

        // Navegador embebido -- misma guardia de 2 capas que computer use
        // (Capa 1 ctx.browserControlActive bloquea de raiz SIN llamar a
        // hardConfirm, Capa 2 ctx.hardConfirm() SIEMPRE despues,
        // incondicional) pero SIN begin/end de overlay (no hay indicador
        // de pantalla completa que mostrar/ocultar -- la vista embebida en
        // si YA es visible dentro del panel mientras esta activa).

        case 'browser_navigate': {
          if (!ctx.browserControlActive) {
            return { ok: false, output: 'El navegador embebido no esta activado para este panel -- el usuario tiene que activarlo primero.' }
          }
          if (!ctx.hardConfirm || !ctx.browserNavigate) return { ok: false, output: 'browser_navigate no esta disponible en este contexto de ejecucion.' }
          const url = String(args.url ?? '').trim()
          if (!/^https?:\/\//i.test(url)) return { ok: false, output: 'Solo se admiten URLs http:// o https://.' }
          const approved = await ctx.hardConfirm('Navegar en el navegador embebido', url)
          if (!approved) return { ok: false, output: 'El usuario rechazo la navegacion.' }
          const result = await ctx.browserNavigate(url)
          return result.ok
            ? { ok: true, output: `Navegacion real completada. Titulo: "${result.title}". URL: ${result.url}` }
            : { ok: false, output: result.error ?? 'No se pudo navegar.' }
        }

        case 'browser_click': {
          if (!ctx.browserControlActive) {
            return { ok: false, output: 'El navegador embebido no esta activado para este panel -- el usuario tiene que activarlo primero.' }
          }
          if (!ctx.hardConfirm || !ctx.browserClick) return { ok: false, output: 'browser_click no esta disponible en este contexto de ejecucion.' }
          const description = args.description !== undefined ? String(args.description).trim() : undefined
          const x = args.x === undefined ? undefined : Number(args.x)
          const y = args.y === undefined ? undefined : Number(args.y)
          if (!description && !(Number.isFinite(x) && Number.isFinite(y))) {
            return { ok: false, output: 'Falta "description", o "x"/"y" para el fallback de coordenadas.' }
          }
          const button = args.button === 'right' ? 'right' : 'left'
          const detail = description ? `Click en: "${description}"` : `Click por coordenadas (${x}, ${y})`
          const approved = await ctx.hardConfirm('Click en el navegador embebido', detail)
          if (!approved) return { ok: false, output: 'El usuario rechazo el click.' }
          const result = await ctx.browserClick({ description, x, y, button })
          if (result.status === 'ok') return { ok: true, output: `Click real ejecutado en <${result.tag}> "${result.label}".` }
          if (result.status === 'not_found') {
            return { ok: false, output: `No se encontro ningun elemento real con esa descripcion. Disponibles:\n${(result.candidates ?? []).join('\n') || '(ninguno)'}` }
          }
          if (result.status === 'ambiguous') {
            return { ok: false, output: `Descripcion ambigua, varios candidatos reales matchean:\n${(result.candidates ?? []).join('\n')}` }
          }
          return { ok: false, output: result.error ?? 'Fallo desconocido haciendo click.' }
        }

        case 'browser_type': {
          if (!ctx.browserControlActive) {
            return { ok: false, output: 'El navegador embebido no esta activado para este panel -- el usuario tiene que activarlo primero.' }
          }
          if (!ctx.hardConfirm || !ctx.browserType) return { ok: false, output: 'browser_type no esta disponible en este contexto de ejecucion.' }
          const description = String(args.description ?? '').trim()
          const text = String(args.text ?? '')
          if (!description || !text) return { ok: false, output: 'Faltan "description" y/o "text".' }
          const approved = await ctx.hardConfirm('Escribir en el navegador embebido', `Campo: "${description}"\nTexto: ${text}`)
          if (!approved) return { ok: false, output: 'El usuario rechazo escribir el texto.' }
          const result = await ctx.browserType(description, text)
          if (result.status === 'ok') return { ok: true, output: `${result.charsTyped} caracter(es) reales escritos en <${result.tag}> "${result.label}".` }
          if (result.status === 'not_found') {
            return { ok: false, output: `No se encontro ningun campo real con esa descripcion. Disponibles:\n${(result.candidates ?? []).join('\n') || '(ninguno)'}` }
          }
          if (result.status === 'ambiguous') {
            return { ok: false, output: `Descripcion ambigua, varios candidatos reales matchean:\n${(result.candidates ?? []).join('\n')}` }
          }
          return { ok: false, output: result.error ?? 'Fallo desconocido escribiendo el texto.' }
        }

        case 'browser_screenshot': {
          if (!ctx.browserControlActive) {
            return { ok: false, output: 'El navegador embebido no esta activado para este panel -- el usuario tiene que activarlo primero.' }
          }
          if (!ctx.hardConfirm || !ctx.browserScreenshot) return { ok: false, output: 'browser_screenshot no esta disponible en este contexto de ejecucion.' }
          const approved = await ctx.hardConfirm('Capturar el navegador embebido', 'El agente quiere ver el contenido actual del navegador embebido.')
          if (!approved) return { ok: false, output: 'El usuario rechazo la captura.' }
          const result = await ctx.browserScreenshot()
          return result.ok
            ? { ok: true, output: `Captura real de ${result.width}x${result.height}px del navegador embebido.`, resultImageDataUrl: result.dataUrl }
            : { ok: false, output: result.error ?? 'No se pudo capturar el navegador embebido.' }
        }

        default:
          return { ok: false, output: `Tool desconocida: ${name}` }
      }
    } catch (error) {
      return { ok: false, output: error instanceof Error ? error.message : String(error) }
    }
  }
}
