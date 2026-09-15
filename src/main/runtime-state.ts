// Estado mutable compartido del proceso main + funciones que operan sobre el
// (conexion de runtime activa, workspace activo, puente hacia el renderer).
// Se saca de index.ts porque ipc-agent.ts, ipc-workspace.ts e ipc-settings.ts
// necesitan leer/mutar las mismas variables.
//
// Fase 22b: el estado de conexion (antes 9+ variables `let` a nivel de
// modulo, una sola instancia compartida por TODA la app) pasa a vivir en
// `sessionRegistry`. `settings` (AppSettings) y `toolRegistry` siguen siendo
// globales A PROPOSITO -- son config/herramientas compartidas por la app
// entera, no estado de una conexion puntual (ver
// docs/_arch/verify_fase22_scope.md, Fase 22 Tarea 0, Parte B).
//
// Fase Paneles-1: `sessionRegistry` pasa de indexarse por BrowserWindow.id
// (number, provisto por Electron via event.sender) a indexarse por
// `panelId` (string, crypto.randomUUID() generado por el RENDERER) --
// cambio de tipo puro, cero logica interna tocada (confirmado en
// docs/_arch/verify_panels_scope.md, Tarea 1: ninguna funcion de este
// archivo llamaba nunca BrowserWindow.fromId() ni nada equivalente, el id
// siempre se uso solo como clave de Map). `windowRegistry` (Fase 22a,
// multiples BrowserWindow reales) se retira por completo -- bajo paneles
// dentro de UNA sola ventana ya no hace falta trackear "cual ventana".
import { BrowserWindow, globalShortcut, screen } from 'electron'
import { randomUUID } from 'node:crypto'
import { realpathSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { CodexClient } from './codex-client'
import { CodexAccountBridge } from './codex-account-bridge'
import { CliAgentRuntime } from './cli-agent-runtime'
import { ApiAgentRuntime } from './api-agent-runtime'
import { McpManager } from './mcp-client'
import { LspManager } from './lsp-manager'
import { TerminalManager } from './terminal-manager'
import { ToolRegistry } from './tool-registry'
import { getAppDataSubdir } from './app-paths'
import { normalizeHistory } from './context-envelope'
import { getChatSummaryState, getPersonaText, getTodos } from './chat-store'
import { listSkillsCatalog } from './skill-manager'
import { getCachedAgentsMd } from './agents-md'
import type {
  AppSettings,
  ChatAttachment,
  ConversationMessage,
  ModelProfile,
  ProviderProfile,
  RuntimeContextEnvelope,
  SandboxMode
} from '../shared/types'

/** Fase Paneles-1: reemplaza el registro de multiples ventanas de Fase 22a
 *  (`windowRegistry`) -- bajo el alcance simplificado (paneles DENTRO de
 *  una unica ventana, no ventanas del SO por sesion), ya no hace falta
 *  trackear "cual ventana" en absoluto: hay una sola, siempre. `mainWindow`
 *  es la unica referencia que `sendToWindow()` necesita para mandar
 *  cualquier evento -- ya no hay "a cual ventana" que resolver, solo "esta
 *  el webContents todavia vivo". Seteada una vez desde `createAppWindow()`
 *  (`window-manager.ts`), al arrancar la app. */
let mainWindow: BrowserWindow | null = null

export function setMainWindow(window: BrowserWindow): void {
  mainWindow = window
}

function isMainWindowUsable(): boolean {
  return mainWindow !== null && !mainWindow.isDestroyed() && Boolean(mainWindow.webContents) && !mainWindow.webContents.isDestroyed()
}

/** Manda `channel`/`payload` a la ventana fisica unica, embebiendo
 *  `panelId` en el payload -- UNICO punto de inyeccion real (los 4 canales
 *  que lo necesitan, agent:event/chat:incomingMessage/agent:toolApproval/
 *  agent:toolTrust, pasan TODOS por esta funcion, confirmado por lectura
 *  completa de sus callers). Ningun caller necesita agregar `panelId` a su
 *  propio payload a mano -- estructuralmente imposible olvidarlo. Devuelve
 *  false (sin lanzar) si la ventana ya no es usable. */
export function sendToWindow(panelId: string, channel: string, payload: Record<string, unknown>): boolean {
  if (!isMainWindowUsable()) return false
  try {
    mainWindow!.webContents.send(channel, { ...payload, panelId })
    return true
  } catch {
    return false
  }
}

/** Fase Paneles-3: variante de sendToWindow() para eventos dirigidos al
 *  SHELL (App(), no un panel puntual) -- "pedile a la app que ABRA un
 *  panel" no tiene ningun panelId existente que targetear todavia (esa es
 *  justo la razon del pedido, confirmado en la investigacion:
 *  requestSessionToolApproval() no sirve tal cual porque su mapa de
 *  correlacion vive DENTRO de una sesion que todavia no existe). Mismo
 *  chequeo de `mainWindow` usable que sendToWindow(), sin embeber ningun
 *  panelId -- App() esta siempre montado, no filtra por panelId (mismo
 *  patron ya usado por `window:fullscreenChanged`, window-manager.ts). */
export function sendToShell(channel: string, payload: Record<string, unknown>): boolean {
  if (!isMainWindowUsable()) return false
  try {
    mainWindow!.webContents.send(channel, payload)
    return true
  } catch {
    return false
  }
}

/** Fase 22b — estado de UNA conexion de runtime real: las variables que
 *  antes eran singulares a nivel de modulo (una sola instancia para toda
 *  la app), ahora una instancia POR ventana. Mismas 9 identificadas en
 *  Tarea 0 de Fase 22 (codexClient/cliRuntime/apiRuntime/mcpManager/
 *  lspManager/activeRuntime/activeWorkspace/activeThreadId/activeChatId)
 *  mas activeContextSeeded/currentTurnAbort/isDisconnecting/
 *  toolTrustSession -- ya estaban en la lista original del usuario --
 *  mas `pendingToolApprovals`, agregado en esta fase (no estaba en la
 *  lista original, ver justificacion en docs/_arch/CONTRACT.md → Fase 22b):
 *  los ids de aprobacion pendiente ya son randomUUID (sin colision entre
 *  sesiones aunque el Map fuera global), pero el RUTEO del evento
 *  'agent:toolApproval' hacia la ventana correcta si depende de saber a
 *  que sesion pertenece cada aprobacion pendiente -- mismo motivo por el
 *  que toolTrustSession (que si estaba en la lista) tiene que ser por
 *  sesion. */
export interface SessionRuntimeState {
  codexClient: CodexClient | null
  cliRuntime: CliAgentRuntime | null
  apiRuntime: ApiAgentRuntime | null
  /** Fase 22c — el `ProviderProfile`/`ModelProfile` COMPLETOS con los que
   *  esta sesion se conecto, resueltos una sola vez en agent:connect
   *  (donde SI hace falta validar contra `settings.providers`, porque no
   *  se puede conectar de cero a algo que ya no existe). Una vez guardados
   *  aca, agent:send los usa directo -- deja de volver a buscarlos en
   *  `settings.providers` en cada turno, que es el chokepoint real
   *  confirmado en la investigacion previa (`ipc-agent.ts`, antes de esta
   *  fase): si otra ventana borraba/deshabilitaba ese provider/model
   *  mientras esta sesion seguia conectada, el turno tiraba "Modelo/
   *  proveedor no disponible" pese a que el runtime ya conectado
   *  (apiRuntime/cliRuntime/codexClient) nunca vuelve a mirar `settings`
   *  por su cuenta -- confirmado con grep, cero referencias reales. */
  provider: ProviderProfile | null
  model: ModelProfile | null
  /** Fase 10 — servidores MCP de esta sesion (solo runtimes API). Mismo
   *  ciclo de vida que apiRuntime: se crea en agent:connect, se mata en
   *  disconnectSession(), nunca por turno individual. */
  mcpManager: McpManager | null
  /** Fase 20 — LSP (diagnosticos TypeScript en vivo) de esta sesion, SOLO
   *  runtimes API (foundry/anthropic-api/gemini-api/openai-chat). Mismo
   *  ciclo de vida que mcpManager: se crea en agent:connect, se para en
   *  disconnectSession() -- el language server real nunca se levanta aca,
   *  arranque perezoso en el primer touch de un .ts/.tsx. */
  lspManager: LspManager | null
  /** Tool "terminal_exec" (docs/_arch/verify_persistent_terminal_design.md):
   *  mismo ciclo de vida que lspManager/mcpManager -- creado (objeto vacio,
   *  sin proceso real todavia) en agent:connect, detenido en
   *  disconnectSession(). El proceso cmd.exe real recien se spawnea en la
   *  PRIMERA llamada real a terminal_exec (arranque perezoso, ver
   *  TerminalManager.ensureStarted()), no al conectar. */
  terminalManager: TerminalManager | null
  // Retiro de gemini-cli (docs/_arch/verify_gemini_cli_removal_scope.md,
  // verify_gemini_cli_removal.md): 'gemini' (CLI) salio del union -- solo
  // queda 'gemini-api' (HTTP, ya presente).
  activeRuntime: 'codex' | 'claude' | 'antigravity' | 'foundry' | 'gemini-api' | 'anthropic-api' | 'openai-chat' | null
  activeWorkspace: string | null
  activeThreadId: string | null
  activeChatId: string | null
  activeContextSeeded: boolean
  /** Handle de cancelacion de un turno API en vuelo (el AbortController que
   *  recibe apiRuntime.send()). SOLO API -- CLI/Codex no lo setean (usan
   *  cancelCurrentTurn de abajo). Desconflaciado de la señal de ocupacion en
   *  el fix del Hallazgo 1 (docs/_arch/verify_parallel_idle_detection_design.md):
   *  antes se usaba tambien como "esta ocupado", pero como CLI/Codex nunca lo
   *  setean, idlePanels() los clasificaba como idle aunque estuvieran
   *  trabajando -- ahora la ocupacion la lleva turnInFlight (abajo). */
  currentTurnAbort: AbortController | null
  /** PIEZA 1 del fix del Hallazgo 1: señal de ocupacion UNIFICADA, fiable
   *  para los 3 runtimes (API/CLI/Codex). Seteada true al inicio de
   *  runTurnForWindow() antes de bifurcar, limpiada en su finally (cubre
   *  exito/error/cancelacion). idlePanels() (parallel-orchestrator.ts) la
   *  consulta en vez de currentTurnAbort. Un runtime futuro queda cubierto
   *  sin tocar idlePanels(). */
  turnInFlight: boolean
  /** PIEZA 5 del fix del Hallazgo 1: hook de cancelacion real para CLI/Codex
   *  (API usa currentTurnAbort). Registrado por dispatchTurnForWindow() en el
   *  branch CLI/Codex, invocado por cancelSessionTurn(), limpiado a null en
   *  el finally del wrapper. CLI: mata activeProcess sin resetear sessionId.
   *  Codex: mata el proceso (destructivo, requiere reconexion) y desbloquea
   *  el waiter en el acto. null si el turno en vuelo es API o no hay turno. */
  cancelCurrentTurn: (() => void) | null
  /** Señal de cancelacion UNIFORME del turno de origen, para los 3 runtimes
   *  (docs/_arch/verify_origin_signal_design.md) -- creada SIEMPRE (a
   *  diferencia de currentTurnAbort, solo API) por runTurnForWindow() antes
   *  de bifurcar, junto a turnInFlight=true. Disparada (abort()) en 2
   *  lugares: cancelSessionTurn() (boton "Detener"/cascada de parallel_ask)
   *  y disconnectSession() (logica de cancelacion propia, no pasa por
   *  cancelSessionTurn()) -- los 2 unicos caminos reales que cancelan un
   *  turno en vuelo. Limpiada a null en el mismo finally que ya limpia
   *  turnInFlight/cancelCurrentTurn. Puramente observacional -- NUNCA el
   *  mecanismo real de abort de ningun runtime (eso sigue siendo
   *  currentTurnAbort para API, cancelCurrentTurn para CLI/Codex);
   *  consumida hoy solo por runParallelAsk() (parallel-orchestrator.ts) via
   *  el closure de ipc-agent.ts, para cascadear la cancelacion del origen a
   *  las sub-tareas hijas sin importar que runtime corria el origen. */
  turnAbortSignal: AbortController | null
  isDisconnecting: boolean
  toolTrustSession: boolean
  /**
   * Familia A (computer use), Capa 1 (docs/_arch/verify_computer_use_security_model.md,
   * Tarea 1): "sesion de control" -- MISMO patron estructural exacto que
   * toolTrustSession (campo booleano por sesion, default false, NUNCA
   * persistido, reseteado en disconnectSession()), pero deliberadamente un
   * campo SEPARADO -- son dominios de riesgo distintos (archivos/comandos
   * vs. control fisico del mouse/teclado de TODA la maquina), el usuario
   * tiene que poder activar/desactivar cada uno independiente. Activarlo
   * NO salta la Capa 2 (requestHardToolApproval(), ver mas abajo) para
   * ninguna de las 4 tools de computer use -- eso es incondicional,
   * siempre, mismo principio que close_app/lock_screen/power. Mutado por
   * setComputerUseActive() (mas abajo), nunca directo.
   */
  computerUseActive: boolean
  pendingToolApprovals: Map<string, (approved: boolean) => void>
  /**
   * "Modo plan" (docs/_arch/verify_plan_mode_design.md, Tarea 2): copia
   * MUTABLE y viva del sandbox real de esta conexion -- a diferencia de
   * antes (payload.sandbox capturado una sola vez en un closure de
   * agent:connect, nunca releido), este campo es lo que enablePlanMode()/
   * disablePlanMode() mutan para forzar/revertir read-only EN CALIENTE, sin
   * reconectar (confirmado real: ApiAgentRuntime.configure()/
   * CliAgentRuntime.configure() son un simple reemplazo de estado, sin
   * ningun efecto secundario real). connectSessionForWindow() lo
   * inicializa desde payload.sandbox en cada connect real.
   */
  sandbox: SandboxMode
  /** true = la sesion esta en modo plan ahora mismo (liviana o reforzada).
   *  Se apaga con disablePlanMode() (llamado por la tool exit_plan_mode
   *  real, o por el boton manual de salida en la UI) o al desconectar. */
  planModeActive: boolean
  /** Solo relevante si planModeActive -- true = ademas se forzo el sandbox
   *  real a 'read-only' (variante reforzada). false = variante liviana
   *  (solo prompt + tool, sandbox real sin tocar). */
  planModeEnforced: boolean
  /** Sandbox real que tenia la sesion ANTES de forzar read-only (variante
   *  reforzada) -- capturado en enablePlanMode(), restaurado en
   *  disablePlanMode(). null si nunca se forzo nada (liviana, o plan mode
   *  nunca activado). NUNCA asumir 'workspace-write' -- el usuario puede
   *  haber activado el plan reforzado desde cualquier sandbox real. */
  priorSandbox: SandboxMode | null
}

function createEmptySession(): SessionRuntimeState {
  return {
    codexClient: null,
    cliRuntime: null,
    apiRuntime: null,
    mcpManager: null,
    lspManager: null,
    terminalManager: null,
    provider: null,
    model: null,
    activeRuntime: null,
    activeWorkspace: null,
    activeThreadId: null,
    activeChatId: null,
    activeContextSeeded: false,
    currentTurnAbort: null,
    turnInFlight: false,
    cancelCurrentTurn: null,
    turnAbortSignal: null,
    isDisconnecting: false,
    toolTrustSession: false,
    computerUseActive: false,
    pendingToolApprovals: new Map(),
    // Default real: mismo valor default que el selector de sandbox en
    // App.tsx (useState<SandboxMode>('workspace-write')) -- connectSessionForWindow()
    // lo pisa con el valor real de payload.sandbox en cada connect.
    sandbox: 'workspace-write',
    planModeActive: false,
    planModeEnforced: false,
    priorSandbox: null
  }
}

/** Un `SessionRuntimeState` por `panelId` (string, generado por el
 *  renderer). No se limpia automaticamente al cerrar/desmontar un panel en
 *  esta fase -- mismo caveat ya documentado antes de Paneles-1 (PENDING.md),
 *  ahora sin ningun `windowRegistry` equivalente que sirva de referencia de
 *  "sigue existiendo" -- Paneles-2/3 define el ciclo de vida real. */
export const sessionRegistry = new Map<string, SessionRuntimeState>()

export function getSession(panelId: string): SessionRuntimeState {
  let session = sessionRegistry.get(panelId)
  if (!session) {
    session = createEmptySession()
    sessionRegistry.set(panelId, session)
  }
  return session
}

export const codexAccountBridge = new CodexAccountBridge()
export let settings: AppSettings = { providers: [], projectRoots: [] }
export function setSettings(next: AppSettings): void {
  settings = next
}

/**
 * Fase Paneles-2a: cola simple (no una libreria de mutex) para que
 * cualquier lectura-modificacion-escritura de `settings` que abarque mas
 * de una linea quede serializada frente a CUALQUIER OTRA que tambien pase
 * por aca. Investigado antes de elegir el mecanismo (docs/_arch/
 * verify_panels_scope.md, Paneles-2a): dos llamadas a
 * connectSessionForWindow()/workspace:open() en paralelo NO pierden datos
 * entre si hoy -- ambas leen el binding vivo `settings` recien en la
 * misma linea en la que escriben (sin ningun await en el medio), asi que
 * el spread `{...settings, ...}` siempre ve el valor mas fresco posible.
 * Confiar en "no hay ningun await entre la lectura y la escritura" es
 * fragil e implicito, no una garantia real -- un refactor futuro que le
 * agregue un await a mitad de esa seccion (ej. algo que necesite volver a
 * validar contra disco) reintroduciria la carrera en silencio. Esta cola
 * vuelve esa atomicidad EXPLICITA y a prueba de ese refactor futuro, en
 * vez de depender de que nadie toque el orden de las lineas.
 *
 * Hallazgo real, mas amplio que lo pedido, documentado y NO resuelto aca
 * (fuera del alcance nombrado): settings:save (ipc-settings.ts) reemplaza
 * `settings` ENTERO con lo que mande el renderer que lo llamo -- si ese
 * renderer tenia una copia de `settings` mas vieja que un cambio que
 * connectSessionForWindow()/workspace:open() ya aplico (ej. otro panel
 * conectando casi al mismo tiempo), ese settings:save puede pisar ese
 * cambio en silencio al llegar despues. Esta cola NO cierra ese caso (un
 * mutex no arregla un "reemplazo completo con una copia vieja" -- haria
 * falta que settings:save fusione en vez de reemplazar, lo cual chocaria
 * con bootstrap()/deleteProvider()/deleteModel(), restringidos de tocar en
 * esta fase). Anotado en PENDING.md para decidir aparte.
 */
let settingsWriteQueue: Promise<void> = Promise.resolve()

export function withSettingsLock<T>(task: () => T | Promise<T>): Promise<T> {
  const run = settingsWriteQueue.then(() => task())
  settingsWriteQueue = run.then(() => undefined, () => undefined)
  return run
}

export const toolRegistry = new ToolRegistry()

/** Manda un evento de agente al panel dueño de esta sesion. `panelId` es
 *  OBLIGATORIO aca -- quien llama a esto siempre sabe de que sesion es el
 *  evento (lo leyo del payload en agent:connect/agent:send, o lo tiene en
 *  el closure de wireApi/wireCli/wireCodex). */
export function sendSessionEvent(panelId: string, payload: Record<string, unknown>): void {
  const session = sessionRegistry.get(panelId)
  sendToWindow(panelId, 'agent:event', {
    workspace: session?.activeWorkspace ?? null,
    chatId: session?.activeChatId ?? null,
    ...payload
  })
}

/**
 * PIEZA 5 del fix del Hallazgo 1 (docs/_arch/verify_parallel_idle_detection_design.md):
 * antes SOLO manejaba currentTurnAbort (API) -- para CLI/Codex hacia
 * early-return sin cancelar nada (gap preexistente, no de parallel_ask: el
 * boton Detener del usuario tampoco frenaba un turno CLI/Codex). Ahora
 * cubre los 3: API via su AbortController (cancel limpio, TurnCancelledError),
 * CLI/Codex via el hook cancelCurrentTurn que dispatchTurnForWindow() registro
 * (mata el proceso -- CLI preserva sessionId, Codex es destructivo y ademas
 * desbloquea su waiter). En los 3 casos se liberan las aprobaciones pendientes.
 */
export function cancelSessionTurn(panelId: string): boolean {
  const session = sessionRegistry.get(panelId)
  if (!session) return false
  let cancelled = false
  if (session.currentTurnAbort) {
    session.currentTurnAbort.abort()
    cancelled = true
  } else if (session.cancelCurrentTurn) {
    session.cancelCurrentTurn()
    cancelled = true
  }
  if (!cancelled) return false
  // docs/_arch/verify_origin_signal_design.md: señal uniforme para los 3
  // runtimes, disparada sin importar cual de los 2 branches de arriba
  // canceló de verdad -- puramente observacional, no reemplaza a
  // currentTurnAbort/cancelCurrentTurn como mecanismo real de cancelacion.
  session.turnAbortSignal?.abort()
  for (const resolve of session.pendingToolApprovals.values()) resolve(false)
  session.pendingToolApprovals.clear()
  return true
}

/**
 * Familia A (computer use) -- overlay de pantalla completa + panic key +
 * arm-tracking. Vive ACA (no en computer-use-actions.ts, que es un modulo
 * HOJA a proposito, ver su comentario de cabecera) porque necesita
 * sessionRegistry/cancelSessionTurn -- exactamente el mismo motivo por el
 * que toolTrustSession/pendingToolApprovals viven en este archivo y no en
 * uno separado.
 *
 * 2 contadores GLOBALES (no por-sesion): `armedPanels` (paneles con
 * computerUseActive=true ahora mismo -- controla el panic key: registrado
 * mientras haya al menos 1) y `inFlightPanels` (paneles con una accion de
 * computer use EJECUTANDOSE ahora mismo -- controla el overlay visual:
 * visible mientras haya al menos 1, docs/_arch/verify_computer_use_security_model.md,
 * Tarea 3: "visible SIEMPRE que este en uso real (no solo activado)").
 * Ambos son Set<string> de panelId, no un simple contador numerico -- un
 * panel que se desconecta/cierra sin pasar por el camino feliz (ej. cierre
 * abrupto) no debe dejar el contador inflado para siempre; panicStop()
 * puede iterar el Set real para saber A QUIEN cancelar, un numero no lo
 * permitiria.
 */
const armedPanels = new Set<string>()
const inFlightPanels = new Set<string>()
let overlayWindow: BrowserWindow | null = null

/** Confirmado real en verify_computer_use_security_model.md, Tarea 4:
 *  registrable (no tomado por Windows/otra app en la maquina de prueba),
 *  compuesto 100% de teclas presentes en cualquier teclado estandar
 *  (a diferencia del candidato original Control+Alt+Shift+F13, que no
 *  existe fisicamente en la mayoria de los teclados). */
export const COMPUTER_USE_PANIC_KEY_ACCELERATOR = 'Control+Alt+Shift+Escape'
/** Mismo combo, formato legible para mostrar al usuario (advertencia de
 *  Configuracion, hint del overlay) -- separado del accelerator real de
 *  Electron (que usa "Control", no "Ctrl") para no mezclar el formato
 *  interno con el texto que ve el usuario. */
export const COMPUTER_USE_PANIC_KEY_LABEL = 'Ctrl+Alt+Shift+Esc'

/**
 * Union real de TODOS los monitores conectados -- confirmado real en
 * verify_computer_use_security_model.md, Tarea 3: una sola BrowserWindow
 * puede cubrir coordenadas negativas (monitor a la izquierda/arriba del
 * primario) y relaciones de aspecto distintas (un monitor rotado a
 * retrato) sin problema, siempre que se calculen los bounds reales de la
 * UNION, no solo el area del primario.
 */
function virtualDesktopBounds(): { x: number; y: number; width: number; height: number } {
  const displays = screen.getAllDisplays()
  const minX = Math.min(...displays.map(d => d.bounds.x))
  const minY = Math.min(...displays.map(d => d.bounds.y))
  const maxX = Math.max(...displays.map(d => d.bounds.x + d.bounds.width))
  const maxY = Math.max(...displays.map(d => d.bounds.y + d.bounds.height))
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY }
}

/** HTML real del overlay -- un borde de color + etiqueta por cada monitor
 *  real (posicionados en coordenadas ABSOLUTAS relativas al origen de la
 *  ventana, que es el minX/minY de virtualDesktopBounds()), mismo
 *  criterio ya probado real en la Tarea 3 del diseño (borde visible en
 *  CADA monitor, no solo un borde alrededor de la union completa -- un
 *  borde asi dejaria los monitores del medio sin ningun indicador visible
 *  en sus bordes internos). El hint del panic key va en la esquina
 *  superior izquierda del monitor PRIMARIO -- siempre visible sin importar
 *  en que monitor este mirando el usuario, ya que el primario es el punto
 *  de referencia mas probable. */
function overlayHtml(bounds: { x: number; y: number; width: number; height: number }): string {
  const displays = screen.getAllDisplays()
  const primary = screen.getPrimaryDisplay()
  const boxes = displays
    .map(d => {
      const left = d.bounds.x - bounds.x
      const top = d.bounds.y - bounds.y
      return `<div class="monitor-border" style="left:${left}px;top:${top}px;width:${d.bounds.width}px;height:${d.bounds.height}px;"></div>`
    })
    .join('')
  const primaryLeft = primary.bounds.x - bounds.x
  const primaryTop = primary.bounds.y - bounds.y
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    html,body{margin:0;padding:0;background:transparent;overflow:hidden;}
    .monitor-border{position:absolute;box-sizing:border-box;border:5px solid #ff2d55;pointer-events:none;}
    .panic-label{position:absolute;background:#ff2d55;color:#fff;font:600 15px system-ui,sans-serif;padding:8px 14px;border-radius:0 0 8px 0;pointer-events:none;box-shadow:0 2px 10px rgba(0,0,0,.4);}
  </style></head><body>
    ${boxes}
    <div class="panic-label" style="left:${primaryLeft}px;top:${primaryTop}px;">
      ⚠ AMATISTA tiene el control del mouse/teclado — ${COMPUTER_USE_PANIC_KEY_LABEL} para detener YA
    </div>
  </body></html>`
}

/** Crea (o reusa) la BrowserWindow del overlay -- transparente, sin frame,
 *  siempre-encima al nivel mas agresivo, click-through real
 *  (setIgnoreMouseEvents), no roba foco -- las 6 propiedades confirmadas
 *  reales en la Tarea 3 del diseño. El bug real encontrado ahi (altura
 *  clampeada al work-area del monitor PRIMARIO si el bound solicitado es
 *  mayor) se corrige con el 2do setBounds() explicito DESPUES de show(),
 *  exactamente como se confirmo que lo arregla. */
function ensureOverlayWindow(): BrowserWindow {
  if (overlayWindow && !overlayWindow.isDestroyed()) return overlayWindow
  const bounds = virtualDesktopBounds()
  const win = new BrowserWindow({
    ...bounds,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    focusable: false,
    hasShadow: false,
    show: false,
    webPreferences: { contextIsolation: true, sandbox: true }
  })
  win.setAlwaysOnTop(true, 'screen-saver')
  win.setIgnoreMouseEvents(true, { forward: true })
  win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(overlayHtml(bounds))}`)
  win.once('ready-to-show', () => {
    win.showInactive()
    // Fix real confirmado (Tarea 3 del diseño): SIN este 2do setBounds(),
    // la ventana nace clampeada a la altura del work-area del monitor
    // PRIMARIO sin importar el bound solicitado -- confirmado real con
    // capturas, deja monitores mas altos (ej. uno en retrato) sin cubrir
    // hasta ~40% de su area real.
    win.setBounds(bounds)
  })
  overlayWindow = win
  return win
}

function showOverlay(): void {
  const win = ensureOverlayWindow()
  if (win.isVisible()) return
  const bounds = virtualDesktopBounds()
  win.showInactive()
  win.setBounds(bounds) // mismo fix de 2do setBounds(), tambien al re-mostrar (los monitores pueden haber cambiado)
}

function hideOverlay(): void {
  if (overlayWindow && !overlayWindow.isDestroyed()) overlayWindow.hide()
}

function registerPanicKey(): void {
  if (globalShortcut.isRegistered(COMPUTER_USE_PANIC_KEY_ACCELERATOR)) return
  globalShortcut.register(COMPUTER_USE_PANIC_KEY_ACCELERATOR, panicStop)
}

function unregisterPanicKey(): void {
  if (globalShortcut.isRegistered(COMPUTER_USE_PANIC_KEY_ACCELERATOR)) {
    globalShortcut.unregister(COMPUTER_USE_PANIC_KEY_ACCELERATOR)
  }
}

/**
 * Familia A, Tarea 1 -- gate de sesion. `active=true` arma el panic key
 * GLOBAL (si es el primer panel armado) -- el panic key queda vivo
 * mientras CUALQUIER panel tenga control activado, no solo mientras una
 * accion esta en curso (a diferencia del overlay visual, que si es
 * "solo mientras se usa de verdad" -- ver beginComputerUseAction/
 * endComputerUseAction). `active=false` desarma este panel puntual; el
 * panic key se desregistra recien cuando NINGUN panel queda armado.
 */
export function setComputerUseActive(panelId: string, active: boolean): void {
  const session = getSession(panelId)
  session.computerUseActive = active
  // Mismo patron real que applySandboxOverride() (mas abajo en este
  // archivo) -- CliAgentRuntime.updateComputerUseActive() muta el config
  // ya guardado, sin reconectar (cada turno CLI spawnea un proceso nuevo,
  // el proximo turno ya ve el env AMATISTA_COMPUTER_USE_ACTIVE correcto).
  // ApiAgentRuntime no necesita un equivalente: el toolExecutor
  // (ipc-agent.ts) ya lee `session.computerUseActive` fresco en cada
  // llamada via ExecuteContext.computerUseActive, sin ningun config propio
  // que mutar.
  session.cliRuntime?.updateComputerUseActive(active)
  sendToWindow(panelId, 'agent:computerUse', { active })

  if (active) {
    const wasEmpty = armedPanels.size === 0
    armedPanels.add(panelId)
    if (wasEmpty) registerPanicKey()
  } else {
    armedPanels.delete(panelId)
    inFlightPanels.delete(panelId)
    if (armedPanels.size === 0) {
      unregisterPanicKey()
      if (inFlightPanels.size === 0) hideOverlay()
    }
  }
}

/** Familia A, Tarea 3 -- llamado por cada handler real (tool nativa en
 *  tool-registry.ts, o handler del pipe MCP en mcp-approval-pipe.ts) justo
 *  ANTES de ejecutar la accion real (despues de que la Capa 2 ya aprobo).
 *  Muestra el overlay si es la PRIMERA accion en curso de cualquier panel
 *  -- si ya habia otra en curso (de este panel u otro), no hace nada
 *  extra, el overlay ya esta visible. */
export function beginComputerUseAction(panelId: string): void {
  inFlightPanels.add(panelId)
  showOverlay()
}

/** Contraparte de beginComputerUseAction() -- SIEMPRE llamar en un
 *  finally, sin importar si la accion tuvo exito/fallo/fue interrumpida
 *  por el panic key. Oculta el overlay recien cuando NINGUN panel tiene
 *  una accion en curso. */
export function endComputerUseAction(panelId: string): void {
  inFlightPanels.delete(panelId)
  if (inFlightPanels.size === 0) hideOverlay()
}

/**
 * Familia A, Tarea 4 -- el handler real del panic key global. Filosofia
 * "boton de panico" real: mas vale frenar de mas que de menos -- cancela
 * el TURNO COMPLETO (no solo la accion de computer use puntual) de TODO
 * panel armado o con una accion en curso, vía cancelSessionTurn() (mismo
 * mecanismo real que ya usa el boton "Detener" -- dispara turnAbortSignal,
 * que las 4 tools de computer use chequean entre micro-pasos, ver
 * computer-use-actions.ts) y apaga computerUseActive de inmediato para
 * cada uno. `armedPanels`/`inFlightPanels` se copian a un array ANTES de
 * iterar -- cancelSessionTurn()/setComputerUseActive() mutan esos mismos
 * Sets por dentro, iterar el Set original mientras se muta es un bug real
 * conocido de JS (comportamiento indefinido de cuales entradas se visitan).
 */
export function panicStop(): void {
  const panels = new Set([...armedPanels, ...inFlightPanels])
  for (const panelId of panels) {
    cancelSessionTurn(panelId)
    setComputerUseActive(panelId, false)
  }
  // Defensivo: si algun handler no llego a su finally (crash real a mitad
  // de ejecucion), esto garantiza que el overlay no quede pegado visible
  // para siempre.
  inFlightPanels.clear()
  hideOverlay()
}

export function setSessionToolTrust(panelId: string, active: boolean): void {
  const session = getSession(panelId)
  session.toolTrustSession = active
  sendToWindow(panelId, 'agent:toolTrust', { active })
}

/**
 * "Modo plan" (docs/_arch/verify_plan_mode_design.md, Tarea 2): mutacion
 * real EN CALIENTE del sandbox de la sesion -- `session.sandbox` es la
 * fuente de verdad viva que el toolExecutor (ipc-agent.ts) y
 * ApiAgentRuntime.config/CliAgentRuntime.config (via updateSandbox(), ver
 * esos archivos) leen. Confirmado real que ninguno de los 2 runtimes tiene
 * un efecto secundario real en su propio configure()/updateSandbox() --
 * mutar esto nunca reabre ninguna conexion. Codex queda deliberadamente
 * afuera (updateSandbox() no existe ahi) -- ver enablePlanMode() mas
 * abajo, que ya rechaza reforzada para ese runtime antes de llegar aca.
 */
function applySandboxOverride(session: SessionRuntimeState, sandbox: SandboxMode): void {
  session.sandbox = sandbox
  session.apiRuntime?.updateSandbox(sandbox)
  session.cliRuntime?.updateSandbox(sandbox)
}

/**
 * Activa el modo plan para esta sesion -- requiere una conexion real ya
 * establecida (mismo criterio fail-closed de toda esta sesion: mejor
 * rechazar con un error claro que activar algo que connectSessionForWindow()
 * va a pisar en el proximo connect/reconnect real, ya que disconnectSession()
 * SIEMPRE se llama al inicio de una conexion nueva y resetea este estado --
 * ver mas abajo). `enforced` fuerza sandbox real a 'read-only' -- rechazado
 * de plano si el runtime activo es Codex (docs/_arch/verify_plan_mode_design.md,
 * Tarea 2: ahi sandbox es un parametro de thread/start, no de cada turno,
 * cambiarlo de verdad exigiria un thread nuevo -- costo real distinto,
 * fuera de alcance de esta pieza).
 */
export function enablePlanMode(panelId: string, enforced: boolean): { ok: true } | { ok: false; error: string } {
  const session = getSession(panelId)
  if (!session.activeRuntime) {
    return { ok: false, error: 'Conecta el agente antes de activar el modo plan.' }
  }
  if (enforced && session.activeRuntime === 'codex') {
    return { ok: false, error: 'El modo plan reforzado no esta disponible con Codex -- su sandbox se fija al conectar (thread/start), cambiarlo requeriria una reconexion real.' }
  }
  session.planModeActive = true
  session.planModeEnforced = enforced
  session.apiRuntime?.updatePlanModeActive(true)
  if (enforced) {
    session.priorSandbox = session.sandbox
    applySandboxOverride(session, 'read-only')
  }
  sendToWindow(panelId, 'agent:planMode', { active: true, enforced })
  return { ok: true }
}

/**
 * Desactiva el modo plan -- llamado por la tool exit_plan_mode real (tras
 * ctx.confirm() aprobado, tool-registry.ts) o por el boton manual de
 * salida en la UI (mismo espiritu que disableToolTrust() -- el humano no
 * depende de que el modelo llame la tool). Si la variante era reforzada,
 * revierte el sandbox real al que la sesion tenia ANTES (session.priorSandbox,
 * nunca asumido 'workspace-write').
 */
export function disablePlanMode(panelId: string): void {
  const session = sessionRegistry.get(panelId)
  if (!session || !session.planModeActive) return
  if (session.planModeEnforced && session.priorSandbox) {
    applySandboxOverride(session, session.priorSandbox)
  }
  session.planModeActive = false
  session.planModeEnforced = false
  session.priorSandbox = null
  session.apiRuntime?.updatePlanModeActive(false)
  sendToWindow(panelId, 'agent:planMode', { active: false, enforced: false })
}

/**
 * Tools de sistema Windows (docs/_arch/verify_windows_control_design.md,
 * Familia B): factor comun real entre requestSessionToolApproval() (abajo)
 * y requestHardToolApproval() (guardias monotonas: close_app/lock_screen/
 * power) -- mismo mapa `pendingToolApprovals`/evento `agent:toolApproval`/
 * dialogo real de la UI para las 2, la UNICA diferencia real es si
 * `toolTrustSession` puede saltear el dialogo entero. `allowTrust` viaja en
 * el payload para que la UI decida si mostrar el checkbox de "confiar" --
 * ocultarlo en el dialogo (no solo ignorar el resultado aca) es lo que
 * garantiza que una guardia monotona nunca pueda auto-aprobarse a si misma
 * en una llamada FUTURA por culpa de un checkbox tildado en la MISMA
 * llamada (ver App.tsx, visibleToolApproval.allowTrust).
 */
function requestToolApproval(panelId: string, title: string, detail: string, allowTrust: boolean): Promise<boolean> {
  const session = getSession(panelId)
  if (allowTrust && session.toolTrustSession) return Promise.resolve(true)

  return new Promise(resolve => {
    const id = randomUUID()
    session.pendingToolApprovals.set(id, resolve)
    sendToWindow(panelId, 'agent:toolApproval', { id, title, detail, allowTrust })
  })
}

export function requestSessionToolApproval(panelId: string, title: string, detail: string): Promise<boolean> {
  return requestToolApproval(panelId, title, detail, true)
}

/**
 * Guardia monotona real (docs/_arch/verify_windows_control_design.md, S3):
 * SOLO para close_app/lock_screen/power (tool-registry.ts) -- a diferencia
 * de requestSessionToolApproval(), esta variante NUNCA consulta
 * `session.toolTrustSession` (ni antes de preguntar -- `allowTrust:false`
 * arriba -- ni el dialogo real le ofrece al usuario la opcion de activarlo
 * para esta llamada), asi que ninguna combinacion de sandbox
 * (`danger-full-access` incluido, que resolveApproval() SI auto-aprobaria)
 * ni de confianza de sesion YA activa (de una aprobacion previa de
 * cualquier OTRA tool) puede saltear el dialogo real. El usuario decide
 * caso por caso, siempre -- exactamente lo que "sin importar el sandbox"
 * exige para una accion irreversible o destructiva real.
 */
export function requestHardToolApproval(panelId: string, title: string, detail: string): Promise<boolean> {
  return requestToolApproval(panelId, title, detail, false)
}

/** Reemplaza al disconnectAgent() singular de antes de Fase 22b -- hace
 *  exactamente lo mismo (abort del turno en vuelo, remover listeners,
 *  parar cada runtime/manager, resolver aprobaciones pendientes como
 *  rechazadas, apagar tool-trust) pero acotado a UNA sola entrada del
 *  registro, no a la app entera. */
export function disconnectSession(panelId: string): void {
  const session = sessionRegistry.get(panelId)
  if (!session || session.isDisconnecting) return
  session.isDisconnecting = true

  try {
    session.currentTurnAbort?.abort()
    // PIEZA 5 del fix del Hallazgo 1: desbloquear cualquier turno CLI/Codex en
    // vuelo ANTES de matar sus procesos abajo -- sin esto, un turno Codex en
    // vuelo al desconectar dejaria su waitForCompletion colgado hasta el
    // timeout de 120s (removeAllListeners() saca el listener pero no llama
    // finishTurn(); el hook si lo llama). No-op si no hay turno en vuelo.
    session.cancelCurrentTurn?.()
    // docs/_arch/verify_origin_signal_design.md: 2do (y ultimo) lugar real
    // que cancela un turno en vuelo, aparte de cancelSessionTurn() -- esta
    // logica es propia, no pasa por cancelSessionTurn(), asi que la señal
    // uniforme necesita su propio disparo aca tambien.
    session.turnAbortSignal?.abort()
    session.codexClient?.removeAllListeners()
    session.cliRuntime?.removeAllListeners()
    session.apiRuntime?.removeAllListeners()
    session.codexClient?.stop()
    session.cliRuntime?.stop()
    session.apiRuntime?.stop()
    session.mcpManager?.stopAll()
    session.lspManager?.stopAll()
    session.terminalManager?.stop()
    // Fix real de TOCTOU (docs/_arch/verify_toctou_fix_design.md): limpia
    // SOLO los hashes por-sesion de ESTE panelId (toolRegistry es un
    // singleton compartido por TODAS las conexiones reales) -- evita que
    // el mapa crezca sin limite a traves de reconexiones en una sesion de
    // app muy larga. Nunca lanza (Map.delete() no puede fallar), mismo
    // try/catch de arriba igual la cubre por si acaso.
    toolRegistry.clearSessionFileHashes(panelId)
  } catch {
    // Procesos hijos pueden haber terminado ya.
  } finally {
    session.codexClient = null
    session.cliRuntime = null
    session.apiRuntime = null
    session.mcpManager = null
    session.lspManager = null
    session.terminalManager = null
    session.provider = null
    session.model = null
    session.activeThreadId = null
    session.activeChatId = null
    session.activeRuntime = null
    session.activeContextSeeded = false
    session.isDisconnecting = false
    session.currentTurnAbort = null
    // PIEZA 1/5 del fix del Hallazgo 1: la sesion queda libre y sin hook
    // colgado tras desconectar (una reconexion arranca limpia).
    session.turnInFlight = false
    session.cancelCurrentTurn = null
    session.turnAbortSignal = null
    for (const resolve of session.pendingToolApprovals.values()) resolve(false)
    session.pendingToolApprovals.clear()
    if (session.toolTrustSession) setSessionToolTrust(panelId, false)
    // Familia A (computer use): mismo criterio exacto que toolTrustSession
    // de arriba -- nunca sobrevive una desconexion, cada conexion nueva
    // arranca con el control de mouse/teclado apagado, sin excepcion. Via
    // setComputerUseActive() (no un reset directo del campo) para que el
    // panic key global se desregistre correctamente si este era el ultimo
    // panel armado.
    if (session.computerUseActive) setComputerUseActive(panelId, false)
    // "Modo plan" (docs/_arch/verify_plan_mode_design.md): reset directo de
    // los campos (NO via disablePlanMode(), que llamaria updateSandbox()
    // sobre runtimes que esta misma funcion ya puso en null arriba) --
    // solo importa que una conexion NUEVA arranque siempre limpia, sin
    // heredar el modo plan de la conexion anterior. Emite el evento solo si
    // estaba activo, mismo criterio que toolTrustSession arriba.
    if (session.planModeActive) sendToWindow(panelId, 'agent:planMode', { active: false, enforced: false })
    session.planModeActive = false
    session.planModeEnforced = false
    session.priorSandbox = null
  }
}

/** Generaliza mecanicamente lo que antes hacia disconnectAgent() para TODA
 *  la app (habia una sola sesion, asi que "toda la app" y "la unica
 *  sesion" eran lo mismo) a los casos que siguen siendo genuinamente
 *  globales hoy: cerrar la ultima ventana (index.ts), logout de cuenta
 *  Codex (ipc-cli.ts) y reset de estado local (ipc-settings.ts). NO es
 *  clasificacion nueva de "que deberia verse afectado" -- eso es Fase 22c
 *  (ver PENDING.md) -- es la MISMA condicion de siempre ("matar todo"),
 *  generalizada de 1 sesion a N. Callers que ademas necesitan limpiar
 *  `activeWorkspace` de cada sesion (proyecto/root removido, reset total)
 *  iteran `sessionRegistry` ellos mismos -- ver ipc-projects-workspace.ts
 *  e ipc-settings.ts, mismo patron que ya usaban antes de esta fase
 *  (disconnectAgent() + setActiveWorkspace(null) como 2 pasos separados). */
export function disconnectAllSessions(): void {
  for (const panelId of sessionRegistry.keys()) disconnectSession(panelId)
}

export function resolvedWorkspace(workspace: string | null): string {
  if (!workspace) throw new Error('No existe workspace activo.')
  return realpathSync(workspace)
}

export function defaultChatWorkspace(): string {
  const workspace = path.join(getAppDataSubdir('workspaces'), 'general-chat-workspace')
  mkdirSync(workspace, { recursive: true })
  return realpathSync(workspace)
}

export function assertInsideWorkspace(workspace: string | null, candidate: string): string {
  const resolved = resolvedWorkspace(workspace)
  const target = realpathSync(candidate)
  if (!isWithinFolder(resolved, target)) throw new Error('Acceso fuera del workspace rechazado.')
  return target
}

/** Pertenencia real de carpeta -- NO comparacion de string tipo startsWith
 *  (ese chequeo hacia que "D:\Proyecto" coincidiera por error con
 *  "D:\ProyectoExtra", una carpeta hermana distinta que solo comparte el
 *  prefijo -- ver PENDING.md, entrada de la 3ra revision externa, y
 *  verificado real: startsWith tambien fallaba al reves, un falso
 *  negativo, si `candidate` llegaba con un casing distinto al de `parent`
 *  para la MISMA carpeta real). path.relative() ya resuelve el caso borde
 *  de que `parent` termine o no en separador, y en Windows (path.win32,
 *  el que corre en runtime aca) ya compara case-insensitive -- confirmado
 *  real, `path.win32.relative('C:\\Proyecto','c:\\proyecto')` da `''`, y
 *  `path.win32.relative('C:\\Proyecto','C:\\ProyectoExtra')` da
 *  `'..\\ProyectoExtra'` (afuera). No hace falta normalizar a lowercase a
 *  mano. A diferencia de assertInsideWorkspace() (arriba), esta variante
 *  NO llama realpathSync -- pensada para pares que el CALLER ya
 *  canonicaliza una sola vez al guardarlos (root.path en
 *  projects:addRoot, activeWorkspace en workspace:open); forzar un
 *  realpathSync aca ademas rompería el caso legitimo de una carpeta ya
 *  borrada del disco (el usuario borra la carpeta real y despues quiere
 *  sacar de la lista el projectRoot huerfano -- eso no deberia tirar
 *  ENOENT). */
export function isWithinFolder(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

/** wireCodex/wireCli/wireApi: capturan `panelId` en el closure de conexion
 *  (leido del payload en agent:connect, ya no resuelto via event.sender) y
 *  lo usan para dirigir cada evento a ese panel puntual. Ninguna de las 3
 *  lee ninguna global directamente (confirmado en la investigacion previa)
 *  -- el cambio de `windowId: number` a `panelId: string` es aditivo puro
 *  a nivel de tipo, no rompe nada de su logica interna. */
export function wireCodex(panelId: string, client: CodexClient): void {
  client.on('raw', message => sendSessionEvent(panelId, { kind: 'raw', message }))
  client.on('notification', message => sendSessionEvent(panelId, { kind: 'notification', ...message }))
  client.on('serverRequest', message => sendSessionEvent(panelId, { kind: 'serverRequest', ...message }))
  client.on('log', message => sendSessionEvent(panelId, { kind: 'log', ...message }))
  client.on('exit', message => sendSessionEvent(panelId, { kind: 'exit', ...message }))
}

export function wireCli(panelId: string, runtime: CliAgentRuntime): void {
  runtime.on('log', message => sendSessionEvent(panelId, { kind: 'log', ...message }))
}

export function wireApi(panelId: string, runtime: ApiAgentRuntime): void {
  runtime.on('log', message => sendSessionEvent(panelId, { kind: 'log', ...message }))
  runtime.on('toolStatus', message => sendSessionEvent(panelId, {
    kind: 'notification',
    method: 'item/toolCall/status',
    params: message
  }))
  runtime.on('usage', message => sendSessionEvent(panelId, {
    kind: 'notification',
    method: 'item/usage/update',
    params: message
  }))
}

export function buildRuntimeContext(payload: {
  workspace: string | null
  text: string
  history?: ConversationMessage[]
  attachments?: ChatAttachment[]
  /** chatId cuyo resumen persistido (Fase 3, chat-store.ts) se inyecta como
   *  compactSummary — ya no lo calcula ni lo manda el renderer (ver
   *  docs/_arch/CONTRACT.md → "Contrato de memoria/contexto" v2). Sin
   *  chatId (turno sin chat asociado) simplemente no hay resumen. */
  chatId?: string | null
  provider: ProviderProfile
  model: ModelProfile
  /** "Modo plan" (docs/_arch/verify_plan_mode_design.md): estado REAL de la
   *  sesion en el momento de este turno (runTurnForWindow() lo lee de
   *  session.planModeActive/planModeEnforced) -- no se calcula aca, solo se
   *  reenvia al envelope para que formatContextEnvelope()/memoryBlockText()
   *  decidan si inyectan el bloque de guia. */
  planModeActive?: boolean
  planModeEnforced?: boolean
}): RuntimeContextEnvelope {
  const workspace = resolvedWorkspace(payload.workspace)
  // Una sola lectura para summary + memoria estructurada (Fase 6) — mismo
  // registro de chat_sessions, no dos queries separadas.
  const summaryState = payload.chatId ? getChatSummaryState(payload.chatId) : null
  // Tool "todo_write" (docs/_arch/verify_todo_write_design.md): misma
  // condicion/criterio que summaryState de arriba -- sin chatId (turno sin
  // chat asociado) no hay lista que inyectar.
  const todos = payload.chatId ? getTodos(payload.chatId) : []
  // Presets simples (docs/_arch/verify_simple_presets_design.md): misma
  // condicion que summaryState/todos de arriba -- fijado UNA vez al crear
  // el chat, releido aca (barato, misma fila) pero NUNCA recalculado ni
  // reescrito en este flujo.
  const personaText = payload.chatId ? getPersonaText(payload.chatId) : undefined
  // Sistema de skills (docs/_arch/verify_skills_design.md): catalogo nivel
  // 1, escaneado real por workspace (skill-manager.ts ya cachea con
  // invalidacion por firma real, barato llamarlo en cada turno). NO
  // depende de chatId -- a diferencia de todos/personaText, las skills son
  // del WORKSPACE, no de la conversacion puntual.
  const skills = listSkillsCatalog(workspace)
  // AGENTS.md (Fase 7): codex-subscription/codex-api comparten CodexClient,
  // que lee AGENTS.md nativo del cwd — confirmado empiricamente (Tarea 0:
  // `codex exec` con una instruccion distintiva en AGENTS.md la siguio sin
  // inyeccion manual). Inyectarselo tambien duplicaria la instruccion — el
  // resto de los runtimes (claude-cli, antigravity-cli y los 4 HTTP-API,
  // gemini-api incluido) NO lo leen solos, asi que a esos si les llega el
  // contenido crudo aca.
  const needsAgentsMdInjection = payload.model.runtime !== 'codex-subscription' && payload.model.runtime !== 'codex-api'
  const agentsMd = needsAgentsMdInjection ? getCachedAgentsMd(workspace)?.content : undefined
  return {
    workspace,
    providerName: payload.provider.name,
    modelName: payload.model.displayName || payload.model.model,
    compactSummary: summaryState?.summary,
    topics: summaryState?.topics,
    todos: todos.length > 0 ? todos : undefined,
    personaText,
    skills: skills.length > 0 ? skills : undefined,
    planModeActive: payload.planModeActive,
    planModeEnforced: payload.planModeEnforced,
    agentsMd,
    history: normalizeHistory(payload.history),
    current: { role: 'user', text: payload.text },
    attachments: payload.attachments
  }
}
