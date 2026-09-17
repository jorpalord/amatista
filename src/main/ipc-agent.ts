// Canales IPC del ciclo de vida del agente: connect/send/cancel, respuestas
// a server-request de Codex, y aprobacion/confianza de tool calls.
//
// Fase Paneles-1: todos los handlers leen `panelId` (string, crypto.randomUUID()
// generado por el RENDERER) del PAYLOAD que mando el renderer, y operan sobre
// getSession(panelId) -- nunca sobre una variable global compartida. Antes
// (Fase 22b/22c) se resolvia via event.sender (BrowserWindow.fromWebContents),
// confiable porque Electron lo garantizaba -- eso dejo de servir bajo el
// modelo de paneles (todos los paneles de una ventana comparten el mismo
// webContents/canal IPC). Ahora main confia en el dato que el renderer manda,
// sin validarlo contra nada de Electron (ver docs/_arch/verify_panels_scope.md,
// Tarea 1/2). Cada panel tiene su propia conexion de runtime real,
// independiente de los demas.
import { ipcMain } from 'electron'
import { realpathSync } from 'node:fs'
import { CodexClient } from './codex-client'
import { ApiAgentRuntime, TurnCancelledError } from './api-agent-runtime'
import { CliAgentRuntime } from './cli-agent-runtime'
import { clickInBrowserView, navigateBrowserView, screenshotBrowserView, setBrowserViewBounds, typeInBrowserView } from './embedded-browser'
import { detectAntigravity, detectClaude } from './cli-status'
import { getAppDataSubdir } from './app-paths'
import { isUnsupportedLocalModel, isUnsupportedLocalProvider } from './settings-provisioning'
import { maybeCompactChatInBackground, resolveConfiguredCompactionModel } from './compaction-engine'
import { generateImage } from './image-generation'
import { hasTavilyIntegration, tavilyExtract, tavilySearch } from './web-search'
import { isApiCapableModel } from '../shared/model-capabilities'
import { AGENTS_MD_LINE_WARNING_THRESHOLD, refreshAgentsMdCache } from './agents-md'
import { McpManager } from './mcp-client'
import { LspManager } from './lsp-manager'
import { TerminalManager } from './terminal-manager'
import { isPrincipalChat, listChatSessionsForWindowDiscovery, panelAliasForTitle, setTodos } from './chat-store'
import {
  beginComputerUseAction,
  buildRuntimeContext,
  cancelSessionTurn,
  defaultChatWorkspace,
  disablePlanMode,
  disconnectSession,
  enablePlanMode,
  endComputerUseAction,
  getMainWindow,
  getSession,
  requestHardToolApproval,
  requestSessionToolApproval,
  resolvedWorkspace,
  sendSessionEvent,
  sessionRegistry,
  setBrowserControlActive,
  setComputerUseActive,
  setSessionToolTrust,
  settings,
  setSettings,
  toolRegistry,
  wireApi,
  wireCli,
  wireCodex,
  withSettingsLock,
  type SessionRuntimeState
} from './runtime-state'
import { saveSettings } from './settings-store'
import { runtimeAttachmentView } from './attachments'
// Orquestador paralelo: SOLO tipo -- el import de VALOR real
// (planParallelAsk/runParallelAsk) es dinamico, dentro de los closures mas
// abajo (mismo motivo que sendToWindowByTitle, ver el comentario ahi).
import type { ParallelSubtaskAssignment } from './parallel-orchestrator'
import type { ChatAttachment, ConversationMessage, SandboxMode, TodoList } from '../shared/types'

const DEBUG_TOOLS = process.env.AMATISTA_DEBUG_TOOLS === '1'

/**
 * Fase 12 (blindaje de carrera, investigado a partir del hallazgo de
 * PENDING.md → "Encontrado durante refactor (Fase 2)"): confirmado leyendo
 * App.tsx que el boton "Quitar" de una carpeta raiz NO tiene ningun
 * disabled ligado a agentState === 'connecting' (solo los botones
 * "Conectar agente" y el de enviar mensaje lo tienen) — projects:removeRoot
 * SI puede llegar mientras agent:connect sigue en alguno de sus await
 * (client.start/detectClaude/mcpManagerForConnection.startAll).
 * Si el root removido matchea el workspace activo, ese handler llama
 * disconnectSession() (para/anula lo que esta conexion ya arranco) y pone
 * el workspace de esa sesion en null — sin este guard, la conexion en vuelo
 * seguia de largo con session.activeWorkspace! (non-null assertion) sobre
 * un valor que ya es null, y terminaba resucitando apiRuntime/mcpManager/
 * activeRuntime que el disconnect concurrente ya habia parado.
 *
 * Fase Paneles-1: comparaba contra `getSession(windowId).activeWorkspace`
 * -- misma logica, ahora indexada por `panelId` (string).
 */
function assertSessionWorkspaceStillActive(panelId: string, connectingWorkspace: string | null, cleanup?: () => void): void {
  if (getSession(panelId).activeWorkspace === connectingWorkspace) return
  cleanup?.()
  throw new Error(
    'La conexion se cancelo: el workspace activo cambio mientras se estaba conectando ' +
    '(se removio la carpeta raiz activa, o se disparo otra conexion en paralelo). Intenta conectar de nuevo.'
  )
}

/**
 * UI Paso 1: nucleo real de la tool list_windows -- factorizada como
 * funcion standalone (en vez de un closure inline dentro del bloque de
 * agent:connect) para que la ejecute TANTO el toolExecutor real (via
 * ExecuteContext.listWindows) COMO el scaffold de verificacion, sin
 * duplicar la logica de resolucion. Sincrona: solo lee SQLite
 * (listChatSessionsForWindowDiscovery, chat-store.ts) + `settings.providers`
 * (memoria, ya en scope en este archivo) -- ningun await real.
 *
 * Excluye el chat de la PROPIA sesion (session.activeChatId) -- listarse a
 * si mismo no aporta nada util para send_to_window. Provider borrado O
 * deshabilitado desde el ultimo turno de ese chat -> "proveedor eliminado"
 * (mismo texto exacto pedido, cubre ambos casos con un solo find()+enabled
 * check, sin distinguir "borrado" de "deshabilitado" -- desde la
 * perspectiva de esta tool da igual, ninguno de los dos es usable).
 */
function listWindowsForSession(session: SessionRuntimeState): Array<{ title: string; status: string; alias?: string }> {
  return listChatSessionsForWindowDiscovery()
    .filter(row => row.id !== session.activeChatId)
    .map(row => {
      // Feature "Panel N": alias corto ya grabado en el titulo (sufijo
      // " — Panel N" de generateUniquePanelTitle(), App.tsx) -- se muestra
      // junto al titulo completo para que el modelo sepa que send_to_window
      // acepta la forma corta en vez de repetir el titulo entero.
      const alias = panelAliasForTitle(row.title) ?? undefined
      if (!row.providerId || !row.modelId) {
        return { title: row.title, status: 'no usable todavia (nunca se uso, sin modelo/proveedor previo)', alias }
      }
      const provider = settings.providers.find(item => item.id === row.providerId)
      if (!provider || !provider.enabled) {
        return { title: row.title, status: 'proveedor eliminado', alias }
      }
      const model = provider.models.find(item => item.id === row.modelId)
      const modelLabel = model?.displayName || model?.model || row.modelId
      return { title: row.title, status: `${provider.name} ${modelLabel}`, alias }
    })
}

/** Mensajeria entre ventanas, Paso 2, Tarea 1. Payload/resultado de un
 *  turno, EXACTAMENTE lo que ya recibia/devolvia el handler agent:send --
 *  se factoriza aca para que tanto el handler IPC real como el motor de
 *  entrega cross-window (cross-window-messaging.ts) puedan correr un
 *  turno sin depender de un IpcMainInvokeEvent real (imposible de
 *  construir para un panel que no origino la llamada). */
export interface RunTurnPayload {
  text: string
  chatId?: string
  attachments?: ChatAttachment[]
  history?: ConversationMessage[]
  modelId: string
  providerId: string
  sandbox: SandboxMode
  /** Fase 13: nivel de esfuerzo/razonamiento, opcional. Threadeado tal
   *  cual hasta codexClient.sendTurn()/cliRuntime.send()/apiRuntime.send()
   *  — ninguno lo aplica si viene undefined. Fix real (docs/_arch/
   *  verify_compatible_migration_scope.md, Pieza 3): apiRuntime.send() lo
   *  reenvia a ApiAgentRuntime, que solo lo usa de verdad para
   *  kind:'openai-chat' (reasoning_effort real) -- foundry/anthropic-api/
   *  gemini-api lo ignoran, mismo criterio que antigravity ya ignoraba
   *  effort en cli-agent-runtime.ts. No hace falta gatear por runtime aca
   *  tampoco. */
  effort?: string
}

export interface RunTurnResult {
  success: boolean
  text?: string
  cancelled?: boolean
}

/** Extrae el texto de un delta de Codex con el mismo criterio defensivo
 *  que ya usa el renderer (App.tsx, handleAgentEvent → extractText()) para
 *  el mismo tipo de evento -- Codex habla su propio protocolo JSON-RPC
 *  real, no un shape inventado por esta app, asi que no hay una unica
 *  clave garantizada. Solo el subset de campos de nivel superior que
 *  extractText() tambien prueba primero -- no replica su recursion
 *  completa (esa vive en el renderer, sobre `unknown` mas general; aca
 *  alcanza con lo que Codex realmente manda en la practica, confirmado
 *  con evidencia real en la verificacion de esta tarea). */
function extractCodexDeltaText(params: unknown): string {
  if (typeof params !== 'object' || params === null) return ''
  const record = params as Record<string, unknown>
  const candidate = record.delta ?? record.text ?? record.content ?? record.message
  return typeof candidate === 'string' ? candidate : ''
}

/** Mensajeria entre ventanas, Paso 2, Tarea 1: nucleo de agent:send,
 *  factorizado para poder correr un turno real en CUALQUIER panel desde
 *  main, sin pasar por un IpcMainInvokeEvent -- panelId llega como
 *  parametro directo. El handler IPC real (mas abajo) pasa a ser un
 *  wrapper delgado: lee panelId del payload, llama a esta funcion.
 *
 *  Unico cambio de comportamiento real respecto al agent:send original: la
 *  rama Codex. sendTurn() de CodexClient NUNCA devolvio texto en su valor
 *  de resolucion (confirmado leyendo codex-client.ts) -- el texto viaja
 *  SOLO por los eventos que wireCodex ya reenvia (mismo protocolo real de
 *  Codex, notification con method 'item/agentMessage/delta'). Sin esto,
 *  runTurnForWindow() no tendria ningun texto que entregar cuando el panel
 *  DESTINO usa Codex -- la entrega cross-window (cross-window-messaging.ts)
 *  necesita el texto final, no solo saber que el turno completo. Se acumula
 *  ADEMAS del reenvio normal de wireCodex (que sigue mandando los mismos
 *  eventos al panel que corrio el turno, sin cambios) -- un listener
 *  temporal, vive solo durante este call, no altera nada del wiring
 *  existente. */
export async function runTurnForWindow(panelId: string, payload: RunTurnPayload): Promise<RunTurnResult> {
  const session = getSession(panelId)
  if (!session.activeRuntime) throw new Error('Agente no conectado.')

  // PIEZA 3 del fix del Hallazgo 1 (docs/_arch/verify_parallel_idle_detection_design.md,
  // Tarea 4): guard de entrada -- se chequea el valor PREVIO de turnInFlight
  // ANTES de setearlo (nunca rechazar el propio turno recien marcado). Vuelve
  // la invariante "nunca 2 turnos concurrentes en el mismo panel" AUTO-CUMPLIDA
  // para TODOS los llamadores (parallel_ask, send_to_window, agent:send del
  // UI), no solo parallel_ask -- de paso tapa el gap preexistente de
  // send_to_window, que nunca tuvo ningun chequeo de ocupacion.
  if (session.turnInFlight) {
    throw new Error('Ya hay un turno en vuelo en este panel -- espera a que termine antes de mandar otro.')
  }
  // PIEZA 1: senal de ocupacion UNIFICADA (Opcion A del diseno) -- seteada
  // aca, ANTES de bifurcar por runtime, y limpiada en el finally de abajo que
  // cubre TODOS los caminos de salida (exito, error, cancelacion) de los 3
  // branches. A diferencia de currentTurnAbort (solo API), esto es fiable
  // para los 3 runtimes: un runtime futuro agregado como una rama nueva en
  // dispatchTurnForWindow() queda cubierto sin tocar idlePanels(). currentTurnAbort
  // queda intacto como handle de cancel de API (desconflaciado: turnInFlight
  // es la SEÑAL de ocupacion, currentTurnAbort el HANDLE de cancel de API).
  session.turnInFlight = true
  // docs/_arch/verify_origin_signal_design.md: señal de cancelacion
  // UNIFORME para los 3 runtimes -- creada aca, mismo punto e igual criterio
  // que turnInFlight arriba (antes de bifurcar), a diferencia de
  // currentTurnAbort (solo se crea dentro del branch API). Disparada por
  // cancelSessionTurn()/disconnectSession(), consumida hoy solo por
  // runParallelAsk() para cascadear la cancelacion del origen a las
  // sub-tareas hijas sin importar que runtime corria el origen.
  session.turnAbortSignal = new AbortController()
  try {
    return await dispatchTurnForWindow(panelId, payload, session)
  } finally {
    // Limpieza SIEMPRE (incluida la cancelacion, PIEZA 5) -- ningun panel
    // queda marcado ocupado para siempre tras cancelar/fallar.
    session.turnInFlight = false
    session.cancelCurrentTurn = null
    session.turnAbortSignal = null
  }
}

/** PIEZA 1: cuerpo real del turno, extraido para que runTurnForWindow() sea
 *  el unico dueño del ciclo de vida de turnInFlight (set + guard + finally).
 *  `session` llega como parametro (ya resuelto y validado por el wrapper) --
 *  el cuerpo es identico al de antes, no se reindenta. */
async function dispatchTurnForWindow(panelId: string, payload: RunTurnPayload, session: SessionRuntimeState): Promise<RunTurnResult> {
  // Se captura AHORA, antes de cualquier await: si el usuario cambia de chat
  // (o de workspace) mientras esta llamada sigue en vuelo, session.activeChatId /
  // session.activeWorkspace pueden apuntar a otro chat para cuando la
  // respuesta llegue. Sin esto, sendSessionEvent() etiquetaria la
  // respuesta de ESTE turno con el chat que quedo activo despues,
  // mezclando historial entre chats.
  const requestChatId = payload.chatId?.trim() || session.activeChatId
  const requestWorkspace = session.activeWorkspace
  // Fase 22c: si esta sesion ya se conecto, provider/model ya estan
  // guardados en la sesion (agent:connect) -- se usan directo, SIN volver
  // a buscarlos en settings.providers. Es el chokepoint real confirmado
  // en la investigacion previa: settings.providers es config global
  // compartida, y otro panel puede borrar/deshabilitar este mismo
  // provider/modelo mientras esta sesion sigue conectada y funcionando
  // (el runtime ya conectado -- apiRuntime/cliRuntime/codexClient -- nunca
  // vuelve a mirar settings por su cuenta, confirmado con grep). El
  // fallback a settings.providers.find(...) queda solo para el caso
  // defensivo de una sesion sin provider/model guardado (no deberia
  // pasar para una sesion con activeRuntime seteado, pero no asume).
  const provider = session.provider ?? settings.providers.find(item => item.id === payload.providerId)
  const model = session.model ?? provider?.models.find(item => item.id === payload.modelId)
  if (!provider || !model) throw new Error('Modelo/proveedor no disponible.')
  const context = buildRuntimeContext({
    workspace: session.activeWorkspace,
    text: payload.text,
    history: payload.history,
    attachments: runtimeAttachmentView(payload.attachments),
    chatId: requestChatId,
    provider,
    model,
    // "Modo plan" (docs/_arch/verify_plan_mode_design.md): estado REAL de
    // la sesion en este momento -- session.planModeActive puede haber
    // cambiado desde el ultimo turno (enablePlanMode()/disablePlanMode()),
    // se lee fresco aca, no se cachea.
    planModeActive: session.planModeActive,
    planModeEnforced: session.planModeEnforced
  })
  // Bug real encontrado en la verificacion en vivo de la reintegracion de
  // claude-cli (no anticipado en el diseno): --no-session-persistence
  // (cli-agent-runtime.ts) impide que Claude Code CLI persista el session
  // id a disco -- --resume <id> en el turno siguiente falla real ("No
  // conversation found with session ID: ..."), confirmado reproduciendo un
  // turno de 2 pasos real (texto + imagen) contra el binario real. A
  // diferencia de Codex (proceso app-server vivo durante toda la conexion,
  // mantiene su propio estado en memoria pese a ephemeral:true) claude-cli
  // spawnea un proceso NUEVO por turno -- sin persistencia a disco no hay
  // forma real de continuidad server-side. Fix: model.runtime==='claude-cli'
  // manda SIEMPRE el contexto completo (nunca solo el texto crudo del turno
  // actual), no solo en el primer turno -- ya no depende de --resume, que
  // cli-agent-runtime.ts dejo de intentar para este runtime (ver comentario
  // ahi). El resto de los runtimes CLI/Codex no cambian este criterio.
  const seedContext =
    model.runtime === 'claude-cli' ||
    (!session.activeContextSeeded && context.history.length > 0)
      ? context
      : undefined

  if (session.activeRuntime === 'codex') {
    if (!session.codexClient || !session.activeThreadId) throw new Error('Codex no esta conectado.')
    const client = session.codexClient
    // Hallazgo real durante la verificacion de esta tarea, no supuesto:
    // sendTurn() (codex-client.ts) hace this.request('turn/start', ...) --
    // un RPC que resuelve apenas el app-server ACEPTA el turno (el ack de
    // 'turn/start'), NO cuando el turno termina. Confirmado con datos
    // reales: en la primera corrida, sendTurn() ya habia resuelto con un
    // SOLO evento de notificacion capturado (mcpServer/startupStatus),
    // antes de que llegara ningun delta -- el texto real llega DESPUES,
    // via 'item/agentMessage/delta' + 'turn/completed' (mismos eventos que
    // wireCodex ya reenvia al panel, sin cambios ahi). Timeout defensivo
    // si el turno nunca completa, no cuelga para siempre.
    let accumulatedText = ''
    let turnCancelled = false
    const CODEX_TURN_TIMEOUT_MS = 120_000
    // PIEZA 5 del fix del Hallazgo 1 (docs/_arch/verify_parallel_idle_detection_design.md,
    // Tarea 3): `finishTurn` se HOISTEA fuera del executor para poder
    // desbloquear el waiter desde la cancelacion. Sutileza critica confirmada
    // en la investigacion: Codex NO tiene turn/interrupt de protocolo enviable
    // (turn/cancelled solo se ESCUCHA, nunca se envia), asi que la unica
    // cancelacion real es matar el proceso app-server -- pero matarlo NO emite
    // turn/completed/turn/cancelled, asi que sin desbloquear el waiter a mano
    // este colgaria hasta CODEX_TURN_TIMEOUT_MS (120s). El hook de cancelacion
    // llama finishTurn() explicito.
    let finishTurn: (() => void) | null = null
    const waitForCompletion = new Promise<void>(resolve => {
      let settled = false
      const timer = setTimeout(() => finishTurn?.(), CODEX_TURN_TIMEOUT_MS)
      const onNotification = (message: { method?: string; params?: unknown }): void => {
        if (message.method === 'item/agentMessage/delta') {
          accumulatedText += extractCodexDeltaText(message.params)
        } else if (message.method === 'turn/completed' || message.method === 'turn/cancelled') {
          finishTurn?.()
        }
      }
      finishTurn = (): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        client.off('notification', onNotification)
        resolve()
      }
      client.on('notification', onNotification)
    })
    // PIEZA 5: hook de cancelacion real para Codex -- cancelSessionTurn()
    // (runtime-state.ts) lo invoca. Mata el proceso (destructivo: el thread
    // muere con el, requiere reconexion) Y desbloquea el waiter en el acto.
    // activeThreadId=null a proposito: el thread ya no existe, asi el proximo
    // turno cae en el guard limpio "Codex no esta conectado" de arriba en vez
    // de un error confuso de escritura sobre un proceso muerto.
    session.cancelCurrentTurn = (): void => {
      turnCancelled = true
      session.activeThreadId = null
      try { client.stop() } catch {}
      finishTurn?.()
    }
    try {
      await client.sendTurn({
        threadId: session.activeThreadId,
        text: payload.text,
        model: model.model,
        workspace: resolvedWorkspace(session.activeWorkspace),
        context: seedContext,
        effort: payload.effort
      })
    } catch (error) {
      // Si ya se cancelo, el proceso muerto hace rechazar turn/start -- es
      // esperado, no un fallo real. Cualquier otro error si se propaga.
      if (!turnCancelled) throw error
    }
    await waitForCompletion
    session.activeContextSeeded = true
    // Fix real (docs/_arch/verify_stop_button_codex_design.md): a diferencia
    // de los branches API/CLI de arriba, este branch nunca emitia ningun
    // sendSessionEvent() al cancelar -- el proceso app-server SI moria
    // (cancelCurrentTurn de arriba ya mata el proceso real), pero el
    // renderer nunca se enteraba: turnActive solo se limpia via el handler
    // de la notificacion 'turn/cancelled' (handleAgentEvent(), App.tsx), asi
    // que el boton "Detener" no tenia ningun efecto visible hasta que el
    // watchdog de turno expiraba solo. Mismo patron EXACTO que los otros 2
    // branches -- unica notificacion nueva, sin tocar el protocolo JSON-RPC
    // de Codex (confirmado que no expone un metodo real de cancelacion
    // enviable; matar el proceso sigue siendo la unica cancelacion real).
    if (turnCancelled) {
      sendSessionEvent(panelId, {
        chatId: requestChatId,
        workspace: requestWorkspace,
        kind: 'notification',
        method: 'turn/cancelled',
        params: { partialText: accumulatedText || undefined }
      })
    }
    // Fix real (docs/_arch/verify_codex_compaction_need.md): mismo patron
    // fire-and-forget que los branches API (mas abajo) y CLI (f54cda8) --
    // Codex NO necesita esto para su thread vivo (compactacion nativa real
    // del propio app-server, confirmada empiricamente con una conversacion
    // real forzando el limite, ver el doc de investigacion) -- esto es
    // exclusivamente para que el PROXIMO reconnect (thread nuevo,
    // ephemeral:true, sin nada de la memoria en proceso del thread viejo)
    // tenga un resumen de respaldo real en buildRuntimeContext(), igual que
    // ya pasa para claude-cli/antigravity-cli/API. Antes de este fix,
    // maybeCompactChatInBackground() nunca se disparaba para turnos de
    // Codex (el return temprano de este branch quedaba fuera de los otros
    // 2 puntos donde ya se llama) -- un chat 100% Codex nunca generaba ese
    // resumen, asi que un reconnect solo tenia el recorte duro de
    // normalizeHistory(), sin ningun resumen de respaldo.
    // PIEZA 5: no compactar tras cancelar -- el cliente esta muerto (proceso
    // matado). El resto (turno normal) mantiene el fire-and-forget de siempre.
    if (requestChatId && !turnCancelled) {
      void maybeCompactChatInBackground({
        chatId: requestChatId,
        settings,
        fallbackProvider: provider,
        fallbackModel: model
      })
    }
    return { success: true, cancelled: turnCancelled, text: accumulatedText || undefined }
  }

  const runtime = session.activeRuntime
  if (runtime === 'foundry' || runtime === 'gemini-api' || runtime === 'anthropic-api' || runtime === 'openai-chat') {
    if (!session.apiRuntime) throw new Error('Runtime API no disponible.')
    const abort = new AbortController()
    session.currentTurnAbort = abort
    try {
      // Fix real (docs/_arch/verify_compatible_migration_scope.md, Pieza 3):
      // payload.effort ya se threadeaba hasta cliRuntime.send() para
      // claude-cli/codex-subscription (mas abajo) -- ahora tambien hasta
      // apiRuntime.send(), que solo lo usa de verdad para kind:'openai-chat'
      // (ver ApiAgentRuntime.send()); foundry/anthropic-api/gemini-api lo
      // ignoran, mismo criterio que antigravity/gemini ya ignoraban effort.
      const result = await session.apiRuntime.send(payload.text, context, abort.signal, payload.effort)
      session.activeContextSeeded = true
      const itemId = `${session.activeRuntime}-${Date.now()}`
      sendSessionEvent(panelId, {
        chatId: requestChatId,
        workspace: requestWorkspace,
        kind: 'notification',
        method: 'item/agentMessage/delta',
        // Feature "generacion de imagenes": `attachments` viaja SOLO si
        // ApiAgentRuntime.send() genero alguna esta vuelta (undefined, no
        // array vacio, ver ApiAgentResult) -- el renderer (App.tsx,
        // handleAgentEvent -> appendAssistantMessage) los cuelga del
        // ChatMessage del asistente antes de persistirlo.
        params: { itemId, delta: result.text, attachments: result.attachments }
      })
      sendSessionEvent(panelId, {
        chatId: requestChatId,
        workspace: requestWorkspace,
        kind: 'notification',
        method: 'turn/completed',
        params: {}
      })
      // Fire-and-forget (Tarea 4 de Fase 6): dispara DESPUES de que la
      // respuesta ya se emitio al renderer, sin await — nunca agrega
      // latencia a este turno. maybeCompactChatInBackground nunca lanza
      // (atrapa todo adentro); el resultado, si lo hay, queda para el
      // PROXIMO turno.
      if (requestChatId) {
        void maybeCompactChatInBackground({
          chatId: requestChatId,
          settings,
          fallbackProvider: provider,
          fallbackModel: model
        })
      }
      return { success: true, text: result.text }
    } catch (error) {
      if (error instanceof TurnCancelledError) {
        session.activeContextSeeded = true
        sendSessionEvent(panelId, {
          chatId: requestChatId,
          workspace: requestWorkspace,
          kind: 'notification',
          method: 'turn/cancelled',
          params: { partialText: error.partialText }
        })
        // No se relanza: cancelar es un cierre limpio, no un error del
        // agente — el renderer no debe caer en agentState='error' por esto.
        return { success: true, cancelled: true, text: error.partialText }
      }
      const detail = error instanceof Error ? error.message : String(error)
      console.error(
        '[agent:send] apiRuntime.send() fallo:',
        error instanceof Error ? (error.stack ?? detail) : detail
      )
      throw new Error(`Error al procesar la respuesta del modelo: ${detail}`)
    } finally {
      if (session.currentTurnAbort === abort) session.currentTurnAbort = null
    }
  }

  if (!session.cliRuntime) throw new Error('Runtime CLI no disponible.')
  const cliRuntime = session.cliRuntime
  // PIEZA 5 del fix del Hallazgo 1 (docs/_arch/verify_parallel_idle_detection_design.md,
  // Tarea 3): hook de cancelacion real para CLI -- cancelSessionTurn()
  // (runtime-state.ts) lo invoca. cancelTurn() mata activeProcess SIN el
  // reset de sessionId de stop() (preserva la continuidad --conversation de
  // Antigravity).
  session.cancelCurrentTurn = (): void => { cliRuntime.cancelTurn() }
  try {
    // Reintegracion de claude-cli: effort vuelve a threadearse hasta
    // cliRuntime.send() -- CliAgentRuntime.send() lo ignora por completo si
    // el kind configurado es 'antigravity' (sendAntigravity() no lo recibe,
    // ver cli-agent-runtime.ts), asi que no hace falta gatear por runtime
    // aca tampoco.
    const result = await cliRuntime.send(payload.text, seedContext, payload.effort)
    session.activeContextSeeded = true
    const itemId = `${session.activeRuntime}-${Date.now()}`
    sendSessionEvent(panelId, {
      chatId: requestChatId,
      workspace: requestWorkspace,
      kind: 'notification',
      method: 'item/agentMessage/delta',
      params: { itemId, delta: result.text }
    })
    sendSessionEvent(panelId, {
      chatId: requestChatId,
      workspace: requestWorkspace,
      kind: 'notification',
      method: 'turn/completed',
      params: {}
    })
    // Fix real (docs/_arch/verify_claude_cli_compaction_design.md, Hallazgo 3
    // de verify_external_review_findings.md): mismo patron fire-and-forget
    // que el branch API de arriba -- antes, claude-cli/antigravity-cli nunca
    // disparaban esto, asi que lo que normalizeHistory() recortaba del
    // historial (CONTEXT_TOKEN_BUDGET) no tenia ningun resumen de respaldo.
    // fallbackProvider/fallbackModel siguen siendo la conexion CLI actual
    // (misma firma que el branch API) -- resolveCompactionTarget() ya sabe
    // que hacer si esa conexion no sirve por si misma (subscription, sin
    // apiKey real): cae a un modelo dedicado si hay uno configurado, o a
    // cualquier otra conexion API-capable real del usuario, o no hace nada
    // si no hay ninguna -- nunca finge haber compactado.
    if (requestChatId) {
      void maybeCompactChatInBackground({
        chatId: requestChatId,
        settings,
        fallbackProvider: provider,
        fallbackModel: model
      })
    }
    return { success: true, text: result.text }
  } catch (error) {
    // Fix real (docs/_arch/verify_cli_clean_cancellation_design.md):
    // mismo patron EXACTO que el branch API de arriba -- antes, matar
    // activeProcess hacia rechazar cliRuntime.send() con un error crudo
    // ("Claude terminó con código null.") que se veia identico a un crash
    // real, tanto para el watchdog (Fix 1, ayer) como para el boton
    // "Detener" manual. Con CliAgentRuntime.cancelTurn() marcando
    // cancelledByUs ANTES del kill, el handler 'exit' real ahora lanza
    // TurnCancelledError en vez del mensaje generico -- este catch la
    // reconoce igual que el branch API, cierra el turno limpio (nunca
    // agentState='error'), y NUNCA relanza para este caso puntual.
    // Cualquier OTRO error (crash genuino del binario, code!==0 real) sigue
    // propagandose identico a como lo hacia antes de este fix.
    if (error instanceof TurnCancelledError) {
      session.activeContextSeeded = true
      sendSessionEvent(panelId, {
        chatId: requestChatId,
        workspace: requestWorkspace,
        kind: 'notification',
        method: 'turn/cancelled',
        params: { partialText: error.partialText }
      })
      return { success: true, cancelled: true, text: error.partialText }
    }
    throw error
  }
}

export interface ConnectSessionPayload {
  providerId: string
  modelId: string
  workspace?: string
  chatId?: string
  sandbox: SandboxMode
}

export interface ConnectSessionResult {
  connected: boolean
  runtime: string | null
  workspace: string | null
  workspaceIsDefault: boolean
  agentsMdWarning?: string
}

/** Mensajeria entre ventanas, Paso 3, Tarea 1: nucleo de agent:connect,
 *  factorizado con el MISMO criterio ya aplicado a runTurnForWindow() en
 *  Paso 2. panelId llega como parametro directo, sin depender de un
 *  IpcMainInvokeEvent real -- imposible de construir para un panel que no
 *  origino la llamada (el caso real que esto habilita: sendToWindowByTitle(),
 *  cross-window-messaging.ts, auto-conectando el panel DESTINO de
 *  send_to_window antes de correrle un turno). El handler IPC real (mas
 *  abajo) pasa a ser un wrapper delgado. */
export async function connectSessionForWindow(panelId: string, payload: ConnectSessionPayload): Promise<ConnectSessionResult> {
    const provider = settings.providers.find(item => item.id === payload.providerId)
    if (!provider || !provider.enabled) throw new Error('Proveedor no disponible.')
    const model = provider.models.find(item => item.id === payload.modelId && item.enabled)
    if (!model) throw new Error('Modelo no disponible.')
    if (isUnsupportedLocalProvider(provider) || isUnsupportedLocalModel(model)) {
      throw new Error('Ollama/qwen2.5:7b esta desactivado: no hay compatibilidad real validada con este runtime.')
    }

    // Fase 22b: antes mataba LA conexion global (cualquier otro panel
    // conectando o conectado). Ahora solo la sesion de ESTE panel --
    // otros paneles con su propia conexion activa no se ven afectados.
    //
    // Fix estructural (docs/_arch/verify_session_flags_survive_disconnect_design.md,
    // ya aprobado): antes de este fix, disconnectSession() apagaba
    // browserControlActive/computerUseActive de forma incondicional, y este
    // punto (una reconexion real disparada por el primer mensaje de un
    // panel nunca conectado) necesitaba un parche propio de
    // capturar-antes/re-armar-despues para no romper el flujo mas comun
    // (activar el toggle y mandar el primer mensaje en el mismo instante).
    // Ya no hace falta -- disconnectSession() dejo de tocar estos 2 campos
    // en absoluto (viven ahora como decision explicita del usuario, no como
    // estado que se resetea "por las dudas" en cada disconnect), asi que no
    // hay nada que capturar ni restaurar aca.
    disconnectSession(panelId)
    const session = getSession(panelId)
    // Fase 22c: se guarda el objeto COMPLETO ya validado arriba contra
    // settings.providers -- agent:send va a usar esto directo de aca en
    // adelante, sin volver a buscarlo en settings.providers en cada turno
    // (ver justificacion completa en runtime-state.ts, SessionRuntimeState).
    session.provider = provider
    session.model = model
    // "Modo plan" (docs/_arch/verify_plan_mode_design.md, Tarea 2): copia
    // viva y mutable del sandbox real de ESTA conexion -- disconnectSession()
    // (arriba) ya reseteo planModeActive/planModeEnforced/priorSandbox, asi
    // que siempre se toma el valor fresco de payload.sandbox aca, nunca un
    // valor forzado de una conexion anterior. El resto de esta funcion usa
    // session.sandbox (no payload.sandbox directo) para que
    // enablePlanMode()/disablePlanMode() puedan mutarlo despues sin
    // reconectar.
    session.sandbox = payload.sandbox
    session.activeWorkspace = payload.workspace?.trim()
      ? realpathSync(payload.workspace)
      : defaultChatWorkspace()
    session.activeChatId = payload.chatId?.trim() || null
    // PIEZA 1 del orquestador (docs/_arch/verify_panel_orchestrator.md):
    // calculado UNA vez por conexion, aca (no dentro de toolCatalog(), que
    // corre en cada turno) -- el titulo de un chat no cambia a mitad de
    // conexion salvo un rename real, y ese caso ya es equivalente a "hay
    // que reconectar" para el resto de esta funcion (provider/model
    // tambien quedan fijos hasta el proximo agent:connect). Sin chatId
    // (edge case, panel sin chat real todavia) no hay evidencia de que sea
    // el principal -- isPrincipalChat('') resuelve false de una via el
    // guard `if (!row) return false`.
    const isPrincipalPanel = isPrincipalChat(session.activeChatId ?? '')
    // Capturado ANTES de cualquier await de esta conexion — ver
    // assertSessionWorkspaceStillActive() mas arriba.
    const connectingWorkspace = session.activeWorkspace

    // Fase 7: se refresca UNA vez por conexion, no en cada turno — el
    // resto de agentsMd (agents-md.ts) se sirve del cache hasta el proximo
    // connect/cambio de workspace.
    const agentsMdInfo = refreshAgentsMdCache(session.activeWorkspace!)

    if (DEBUG_TOOLS) {
      console.log(
        `[agent:connect] panel=${panelId} deployment="${model.model}" runtime=${model.runtime} ` +
        `capabilities.tools=${model.capabilities.tools} payload.workspace="${payload.workspace ?? ''}" ` +
        `activeWorkspace(resuelto)="${session.activeWorkspace}"`
      )
    }

    if (model.runtime === 'codex-subscription' || model.runtime === 'codex-api') {
      const client = new CodexClient()
      session.codexClient = client
      wireCodex(panelId, client)
      const codexHome = getAppDataSubdir('codex-home-api')
      const thread = await client.start({
        provider,
        model: model.model,
        workspace: session.activeWorkspace!,
        codexHome,
        // Codex: sandbox se fija UNA sola vez, en thread/start (confirmado
        // real, docs/_arch/verify_plan_mode_design.md, Tarea 2) -- nunca
        // mutable en caliente, por eso enablePlanMode() rechaza reforzada
        // para este runtime antes de que este valor pudiera importar.
        sandbox: session.sandbox
      })
      assertSessionWorkspaceStillActive(panelId, connectingWorkspace, () => client.stop())
      session.activeThreadId = thread.id
      session.activeRuntime = 'codex'
    } else if (isApiCapableModel(provider, model)) {
      const runtime = new ApiAgentRuntime()
      session.apiRuntime = runtime
      wireApi(panelId, runtime)
      const toolWorkspace = session.activeWorkspace

      // Fase 10: servidores MCP SOLO para runtimes API — claude-cli/
      // antigravity-cli/codex-subscription/codex-api ya tienen MCP nativo,
      // no pasan por aca (Gemini SIEMPRE es HTTP-API desde el retiro de
      // gemini-cli, nunca llega a la otra rama). Un servidor individual que
      // falla nunca bloquea la conexion
      // (ver McpManager.startAll, nunca lanza) — startAll() awaited antes
      // de configure() para que el catalogo de tools este completo desde
      // el primer turno, no se descubre a mitad de conversacion.
      const mcpManagerForConnection = new McpManager()
      session.mcpManager = mcpManagerForConnection
      await mcpManagerForConnection.startAll(session.activeWorkspace!)
      assertSessionWorkspaceStillActive(panelId, connectingWorkspace, () => mcpManagerForConnection.stopAll())

      // Fase 20: instanciado aca (SOLO en la rama de runtimes API, alcance
      // deliberado — ver runtime-state.ts) pero sin arrancar NADA todavia —
      // a diferencia de McpManager de arriba (que si arranca sus
      // servidores de una, awaited), el language server real recien se
      // levanta en el primer touch de un .ts/.tsx real (arranque
      // perezoso, LspManager.notifyFileWritten()).
      const lspManagerForConnection = new LspManager(session.activeWorkspace!)
      session.lspManager = lspManagerForConnection
      // Tool "terminal_exec" (docs/_arch/verify_persistent_terminal_design.md):
      // mismo criterio exacto que lspManagerForConnection de arriba -- el
      // objeto se crea aca (barato, sin proceso real todavia), el cmd.exe
      // real recien se spawnea en la PRIMERA llamada real a terminal_exec
      // (TerminalManager.ensureStarted(), arranque perezoso).
      const terminalManagerForConnection = new TerminalManager(session.activeWorkspace!)
      session.terminalManager = terminalManagerForConnection

      runtime.configure({
        kind:
          model.runtime === 'foundry'
            ? 'foundry'
            : model.runtime === 'anthropic-api'
              ? 'anthropic-api'
              // Fase 15: OpenRouter/Chat-Completions, antes de caer al
              // default 'gemini-api' -- desde el retiro de gemini-cli
              // (docs/_arch/verify_gemini_cli_removal_scope.md,
              // verify_gemini_cli_removal.md) el RuntimeKind 'gemini-api'
              // coincide literal con este ApiAgentKind, ya no hay nombre
              // historico confuso que anotar aca.
              : model.runtime === 'openai-chat'
                ? 'openai-chat'
                : 'gemini-api',
        provider,
        model: model.model,
        maxOutputTokens: model.maxOutputTokens,
        // Investigacion real durante una prueba en vivo del usuario: mismo
        // criterio que turnWatchdogSeconds -- ajuste GLOBAL de la app
        // (settings.maxToolLoop), no por-modelo como maxOutputTokens de
        // arriba. undefined = ApiAgentRuntime usa su propio default
        // (MAX_TOOL_LOOP, api-agent-runtime.ts).
        maxToolLoop: settings.maxToolLoop,
        workspace: session.activeWorkspace!,
        // "Modo plan" (docs/_arch/verify_plan_mode_design.md, Tarea 2):
        // session.sandbox (no payload.sandbox directo) -- este valor inicial
        // es identico a payload.sandbox en la conexion (recien asignado
        // arriba), pero enablePlanMode()/disablePlanMode() lo mutan despues
        // via updateSandbox() -- no reconfiguran el runtime desde cero.
        sandbox: session.sandbox,
        // Gatea la tool exit_plan_mode en toolCatalog() -- siempre false
        // justo despues de connectSessionForWindow() (disconnectSession()
        // ya reseteo planModeActive arriba), actualizado en caliente por
        // enablePlanMode()/disablePlanMode() via updatePlanModeActive().
        planModeActive: session.planModeActive,
        toolsEnabled: model.capabilities.tools,
        toolExecutor: model.capabilities.tools
          ? (name, args) => toolRegistry.execute(name, args, {
              workspace: toolWorkspace!,
              // Fix real de TOCTOU (docs/_arch/verify_toctou_fix_design.md):
              // mismo panelId ya usado abajo para requestSessionToolApproval()
              // -- identificador real y estable de ESTA sesion, para que
              // read_file/write_file/apply_patch (tool-registry.ts) puedan
              // registrar/auditar por sesion que hash de contenido vio el
              // modelo, sin pisarse con el de otro panel/conexion real.
              sessionId: panelId,
              // Fase 12: antes NO se pasaba — el sandbox mode elegido en
              // agent:connect nunca llegaba hasta ExecuteContext para los
              // runtimes API, asi que write_file/apply_patch/run_command/
              // revert_file (y las tools MCP, en api-agent-runtime.ts)
              // ignoraban por completo read-only/danger-full-access. Ver
              // docs/_arch/CONTRACT.md → "Sandbox mode no aplicado en
              // runtimes API (Fase 12)". "Modo plan" (docs/_arch/
              // verify_plan_mode_design.md, Tarea 2): session.sandbox
              // (fresco, closure sobre `session`, mismo criterio que
              // listWindows/writeTodos) en vez de payload.sandbox
              // congelado -- write_file/apply_patch/run_command/revert_file
              // ven el sandbox REAL de la sesion en cada llamada, incluido
              // el forzado a read-only por el modo plan reforzado sin
              // necesitar reconectar.
              sandbox: session.sandbox,
              // Fase 22b: cerrado sobre `panelId` de ESTA conexion -- el
              // dialogo de aprobacion (y su respuesta via
              // agent:toolApproval:respond) se dirige a este panel
              // puntual, no a un destino global/broadcast.
              confirm: (title, detail) => requestSessionToolApproval(panelId, title, detail),
              // Tools de sistema Windows (docs/_arch/verify_windows_control_design.md):
              // guardia monotona real para close_app/lock_screen/power --
              // requestHardToolApproval() (runtime-state.ts), NUNCA
              // requestSessionToolApproval() de arriba (esa SI respeta
              // toolTrustSession). Mismo panelId, closure cerrada igual.
              hardConfirm: (title, detail) => requestHardToolApproval(panelId, title, detail),
              // Familia A (computer use, docs/_arch/verify_computer_use_security_model.md):
              // mismo criterio "fresco sobre session" que sandbox arriba --
              // computerUseActive es Capa 1 (toggle de sesion, mutable en
              // caliente via agent:computerUse:set, ver mas abajo), releido
              // en cada llamada, nunca capturado una vez al conectar.
              computerUseActive: session.computerUseActive,
              computerUseAbortSignal: session.turnAbortSignal?.signal,
              computerUseBegin: () => beginComputerUseAction(panelId),
              computerUseEnd: () => endComputerUseAction(panelId),
              // Navegador embebido (docs/_arch/verify_embedded_browser_design.md):
              // mismo criterio "fresco sobre session" que computerUseActive
              // arriba. Los 4 closures cierran sobre getMainWindow() (releido
              // en cada llamada, nunca cacheado) + panelId de esta conexion.
              browserControlActive: session.browserControlActive,
              browserNavigate: url => {
                const win = getMainWindow()
                return win ? navigateBrowserView(win, panelId, url) : Promise.resolve({ ok: false, error: 'Ventana principal no disponible.' })
              },
              browserClick: opts => {
                const win = getMainWindow()
                return win ? clickInBrowserView(win, panelId, opts) : Promise.resolve({ status: 'error' as const, error: 'Ventana principal no disponible.' })
              },
              browserType: (description, text) => {
                const win = getMainWindow()
                return win ? typeInBrowserView(win, panelId, description, text) : Promise.resolve({ status: 'error' as const, error: 'Ventana principal no disponible.' })
              },
              browserScreenshot: () => {
                const win = getMainWindow()
                return win ? screenshotBrowserView(win, panelId) : Promise.resolve({ ok: false, error: 'Ventana principal no disponible.' })
              },
              // Fresco en cada llamada (no capturado una vez aca): si el
              // usuario cambia el modelo de compactacion en Settings a
              // mitad de la conexion, explore lo ve sin necesitar
              // reconectar — mismo criterio que maybeCompactChatInBackground,
              // que tambien lee `settings` en el momento, no al conectar.
              resolveExploreModel: () => resolveConfiguredCompactionModel(settings),
              // Feature "generacion de imagenes": fresco en cada llamada
              // (settings, no una copia capturada al conectar) -- mismo
              // criterio que resolveExploreModel arriba, si el usuario
              // cambia el modelo de generacion en Settings a mitad de la
              // conexion, la proxima llamada a generate_image ya lo ve.
              generateImage: (prompt: string) => generateImage(settings, prompt),
              // Feature "busqueda web": mismo criterio exacto que
              // generateImage arriba -- fresco en cada llamada, settings
              // no capturado al conectar.
              webSearch: (query: string, maxResults?: number) => tavilySearch(settings, query, maxResults),
              webFetch: (url: string) => tavilyExtract(settings, url),
              lspManager: lspManagerForConnection,
              // Tool "terminal_exec" (docs/_arch/verify_persistent_terminal_design.md):
              // mismo criterio exacto que lspManager de arriba -- la
              // instancia real de ESTA conexion, cerrada sobre el closure
              // (arranque perezoso del proceso real dentro del manager
              // mismo, ver TerminalManager.ensureStarted()).
              terminalExec: (command: string) => terminalManagerForConnection.runCommand(command),
              // UI Paso 1: sincrona, sin import dinamico (a diferencia de
              // sendToWindowByTitle abajo) -- listWindowsForSession() no
              // importa nada de cross-window-messaging.ts, asi que no hay
              // ningun ciclo de modulos que evitar aca.
              listWindows: () => listWindowsForSession(session),
              // Tool "todo_write" (docs/_arch/verify_todo_write_design.md):
              // mismo criterio "fresco sobre session" exacto que listWindows
              // arriba -- lee session.activeChatId en el momento en que la
              // tool se ejecuta (puede cambiar entre turnos, confirmado real
              // en runTurnForWindow()), nunca un chatId capturado una vez al
              // conectar.
              writeTodos: (todos: TodoList) => {
                const chatId = session.activeChatId
                if (!chatId) return { ok: false, error: 'No hay chat activo en esta sesion para guardar la lista de tareas.' }
                setTodos(chatId, todos)
                return { ok: true }
              },
              // "Modo plan" (docs/_arch/verify_plan_mode_design.md, Tarea 3):
              // llamada DESPUES de que el case de la tool (tool-registry.ts)
              // ya obtuvo la aprobacion real via ctx.confirm() -- disablePlanMode()
              // (runtime-state.ts) apaga planModeActive y, si era la
              // variante reforzada, revierte el sandbox real al que la
              // sesion tenia antes (nunca asumido 'workspace-write').
              exitPlanMode: () => disablePlanMode(panelId),
              // Mensajeria entre ventanas, Paso 3: closure cerrada sobre
              // `panelId` de ESTA conexion (el ORIGEN de un eventual
              // send_to_window) -- import dinamico A PROPOSITO, no un
              // `import` estatico arriba del archivo: cross-window-
              // messaging.ts ya importa connectSessionForWindow/
              // runTurnForWindow DESDE este mismo archivo (Paso 2), asi que
              // un import estatico de vuelta crearia un ciclo de modulos
              // real entre los dos. Con import() dinamico (resuelto recien
              // cuando la tool efectivamente se llama, no al cargar el
              // modulo) el ciclo nunca se evalua en el orden de carga
              // inicial -- mismo resultado practico que aceptar el ciclo
              // estatico (ya validado en este codebase para tool-registry.ts
              // <-> explore-tool.ts, Fase 4), pero sin depender de que el
              // bundler/orden de evaluacion lo tolere.
              sendToWindowByTitle: async (title, message) => {
                const { sendToWindowByTitle } = await import('./cross-window-messaging.js')
                return sendToWindowByTitle({ originPanelId: panelId, destinationTitle: title, message })
              },
              // Orquestador paralelo (docs/_arch/verify_parallel_orchestrator_design.md):
              // import dinamico por el MISMO motivo exacto que
              // sendToWindowByTitle arriba -- parallel-orchestrator.ts
              // importa runTurnForWindow/RunTurnPayload ESTATICO desde este
              // mismo archivo, asi que un import estatico de vuelta desde
              // aca cerraria el mismo tipo de ciclo. planParallelAsk() en SI
              // (dentro de parallel-orchestrator.ts) es sincrona (Tarea 2:
              // solo lee sessionRegistry + chat-store, sin ningun await
              // real) -- pero el import() dinamico que la resuelve es
              // siempre async, asi que ExecuteContext.planParallelAsk
              // devuelve una Promise (a diferencia de listWindows, que sigue
              // sincrona porque nunca necesito este import). Cerrada sobre
              // `panelId` de ESTA conexion, el ORIGEN del reparto, nunca
              // elegible el mismo como destino (idlePanels() lo excluye
              // explicitamente).
              planParallelAsk: async (subtasks: string[]) => {
                const { planParallelAsk } = await import('./parallel-orchestrator.js')
                return planParallelAsk(panelId, subtasks)
              },
              // EJECUCION real -- cerrada sobre `session` (no una copia): el
              // AbortSignal del turno de origen se lee FRESCO en el momento
              // en que la tool efectivamente se ejecuta. docs/_arch/
              // verify_origin_signal_design.md: session.turnAbortSignal (no
              // session.currentTurnAbort, solo API) -- creado SIEMPRE por
              // runTurnForWindow() antes de bifurcar por runtime, disparado
              // por cancelSessionTurn()/disconnectSession() para los 3
              // runtimes. Hoy el origen de parallel_ask solo puede ser API
              // (parallel_ask no esta wireado para CLI/Codex, confirmado en
              // el doc de diseno) asi que el comportamiento real no cambia
              // -- deja la base lista para cuando lo este.
              runParallelAsk: async (assignments: ParallelSubtaskAssignment[]) => {
                const { runParallelAsk } = await import('./parallel-orchestrator.js')
                return runParallelAsk(assignments, session.turnAbortSignal?.signal)
              }
            })
          : undefined,
        mcpManager: mcpManagerForConnection,
        mcpToolDefinitions: mcpManagerForConnection.listToolDefinitions(),
        mcpConfirm: (title, detail) => requestSessionToolApproval(panelId, title, detail),
        // PIEZA 1 del orquestador: ver isPrincipalPanel mas arriba.
        isPrincipalChat: isPrincipalPanel,
        // Feature "busqueda web" (docs/_arch/verify_web_search_design.md):
        // gating real de web_search/web_fetch en toolCatalog() -- calculado
        // una vez aca (mismo momento que isPrincipalChat de arriba), no
        // fresco por llamada: cambiar la API key de Tavily a mitad de
        // conexion requiere reconectar el panel para que el catalogo lo
        // refleje, mismo criterio ya aceptado para un cambio de
        // proveedor/modelo (ver Fase 22c, disconnectAllPanels()).
        hasWebSearchIntegration: hasTavilyIntegration(settings)
      })
      session.activeRuntime =
        model.runtime === 'foundry'
          ? 'foundry'
          : model.runtime === 'anthropic-api'
            ? 'anthropic-api'
            : model.runtime === 'openai-chat'
              ? 'openai-chat'
              : 'gemini-api'
    } else {
      // Reintegracion de claude-cli / integracion de Antigravity CLI: esta
      // rama cubre las 2 formas CLI que le quedan a RuntimeKind
      // (claude-cli/antigravity-cli) -- mismo branching por model.runtime.
      // Retiro de gemini-cli (docs/_arch/verify_gemini_cli_removal_scope.md,
      // verify_gemini_cli_removal.md): 'gemini-api' YA NO llega aca en uso
      // normal (isApiCapableModel() lo manda siempre por la otra rama,
      // HTTP) -- el unico caso real que puede caer aca con runtime:
      // 'gemini-api' es una conexion vieja en disco con authMode:
      // 'subscription' (el builtin que se retiro), sin ninguna forma CLI
      // que la sirva mas -- error explicito en vez de spawnear algo
      // inexistente.
      if (model.runtime !== 'claude-cli' && model.runtime !== 'antigravity-cli') {
        throw new Error(
          'Gemini por suscripcion (CLI) ya no esta soportado -- gemini-cli quedo discontinuado ' +
          'para cuentas individuales. Reconecta esta conexion con una API key de Gemini, o usa Antigravity.'
        )
      }

      const cli = model.runtime === 'claude-cli' ? await detectClaude() : await detectAntigravity()
      assertSessionWorkspaceStillActive(panelId, connectingWorkspace)
      if (!cli.installed) {
        throw new Error(
          model.runtime === 'claude-cli' ? 'Claude Code CLI no esta instalado.' : 'Antigravity CLI no esta instalado.'
        )
      }

      const kind = model.runtime === 'claude-cli' ? 'claude' : 'antigravity'
      const runtime = new CliAgentRuntime()
      session.cliRuntime = runtime
      wireCli(panelId, runtime)
      runtime.configure({
        kind,
        provider,
        model: model.model,
        workspace: session.activeWorkspace!,
        // "Modo plan" (docs/_arch/verify_plan_mode_design.md, Tarea 2):
        // session.sandbox -- updateSandbox() (CliAgentRuntime) lo muta en
        // caliente despues, sin volver a llamar configure() (que resetearia
        // sessionId/mataria el proceso via this.stop()).
        sandbox: session.sandbox,
        // Orquestacion por suscripcion (docs/_arch/verify_subscription_orchestrator_design.md,
        // Tarea 4): mismo `panelId`/`isPrincipalPanel` ya calculados arriba
        // para la rama API (isPrincipalChat: isPrincipalPanel, mas abajo en
        // este mismo archivo) -- ningun calculo nuevo, solo enchufado
        // tambien aca.
        panelId,
        isPrincipalChat: isPrincipalPanel,
        // Familia A (computer use): valor real de ESTA sesion al conectar
        // -- updateComputerUseActive() (CliAgentRuntime) lo muta despues en
        // caliente si el usuario togglea el composer sin reconectar, mismo
        // patron que sandbox/updateSandbox().
        computerUseActive: session.computerUseActive,
        // Navegador embebido: mismo criterio que computerUseActive de
        // arriba -- updateBrowserControlActive() (CliAgentRuntime) lo muta
        // despues en caliente si el usuario togglea sin reconectar.
        browserControlActive: session.browserControlActive
      })
      session.activeRuntime = kind
    }

    // Fase Paneles-2a: activeProviderId/activeModelId/activeProjectPath ya
    // no son "la seleccion activa" (eso ahora vive en chat_sessions.provider_id/
    // model_id, por panel) -- son el DEFAULT sugerido de la app para un
    // chat que todavia no tiene el suyo propio. Mantenerlos al dia en cada
    // conexion real sigue siendo correcto bajo esa semantica ("la ultima
    // conexion real de cualquier panel es un buen candidato a sugerencia").
    // withSettingsLock() -- ver runtime-state.ts -- vuelve explicita la
    // atomicidad de esta lectura-modificacion-escritura frente a cualquier
    // otra que pase por la misma cola (hoy: workspace:open()).
    await withSettingsLock(() => {
      setSettings({
        ...settings,
        activeProviderId: provider.id,
        activeModelId: model.id,
        activeProjectPath: payload.workspace?.trim() ? session.activeWorkspace ?? undefined : settings.activeProjectPath
      })
      saveSettings(settings)
    })
    return {
      connected: true,
      runtime: session.activeRuntime,
      workspace: session.activeWorkspace,
      workspaceIsDefault: !payload.workspace?.trim(),
      // Tarea 3 de Fase 7: nunca se trunca AGENTS.md — se manda completo
      // siempre, esto es solo un aviso para que el usuario decida acortarlo.
      agentsMdWarning: agentsMdInfo?.oversized
        ? `AGENTS.md tiene ${agentsMdInfo.lineCount} lineas (guia de la industria: ~${AGENTS_MD_LINE_WARNING_THRESHOLD} o menos). Se manda completo en cada turno igual, pero conviene acortarlo — instrucciones muy largas compiten por espacio con el resto del contexto del turno.`
        : undefined
    }
}

export function registerAgentIpc(): void {
  ipcMain.handle('agent:disconnect', (_event, payload: { panelId: string; panelClosing?: boolean }) => {
    // Fix estructural (docs/_arch/verify_session_flags_survive_disconnect_design.md,
    // ya aprobado): disconnectSession() ya NO apaga computerUseActive/
    // browserControlActive (deben sobrevivir a un disconnect incidental) --
    // pero un cierre de panel GENUINO (panelClosing:true, unico caller real
    // con esa señal: closePanel()/deleteChat() en App.tsx) SI es un punto
    // deliberado real: el panel nunca va a volver, asi que hace falta
    // apagarlos EXPLICITO aca, antes de borrar la entrada, para que sus
    // efectos colaterales reales se disparen -- setBrowserControlActive(false)
    // destruye la WebContentsView real (unico call site real de
    // destroyBrowserView(), embedded-browser.ts); setComputerUseActive(false)
    // saca este panelId de armedPanels/inFlightPanels (si no, quedaria una
    // entrada huerfana ahi para siempre, el panic key global nunca se
    // desregistraria aunque este fuera el ultimo panel armado). Leido ANTES
    // de disconnectSession() -- da lo mismo el orden real (estos 2 campos ya
    // no se tocan ahi), pero mantiene el valor real sin depender de en que
    // momento se borra la sesion.
    if (payload.panelClosing) {
      const session = sessionRegistry.get(payload.panelId)
      if (session?.computerUseActive) setComputerUseActive(payload.panelId, false)
      if (session?.browserControlActive) setBrowserControlActive(payload.panelId, false)
    }
    disconnectSession(payload.panelId)
    // Fix real (docs/_arch/verify_sessionregistry_leak_2026.md): confirmado
    // que NO es seguro agregar este delete() DENTRO de disconnectSession()
    // (compartida por otros 2 call sites reales que mutan una referencia
    // local a `session` justo despues de llamarla, esperando que siga
    // siendo el objeto vivo del Map -- ver ipc-projects-workspace.ts) ni
    // hacerlo incondicional aca (los otros 4 disparadores reales de
    // disconnect() en App.tsx mandan panelClosing ausente/false, el panel
    // sigue vivo y reconecta enseguida via connectSessionForWindow(), que
    // ya es delete-safe por su cuenta llamando getSession() de nuevo).
    // panelClosing===true viene SOLO de closePanel() -- señal real de que
    // este panelId nunca va a volver, recien ahi se borra la entrada.
    if (payload.panelClosing) sessionRegistry.delete(payload.panelId)
    return { success: true }
  })

  // Mensajeria entre ventanas, Paso 3, Tarea 1: wrapper delgado -- toda la
  // logica real vive en connectSessionForWindow() (exportada mas arriba),
  // mismo patron que agent:send/runTurnForWindow (Paso 2). Este handler
  // solo lee panelId del payload real y delega.
  ipcMain.handle('agent:connect', async (_event, payload: ConnectSessionPayload & { panelId: string }) => {
    return connectSessionForWindow(payload.panelId, payload)
  })

  // Mensajeria entre ventanas, Paso 2, Tarea 1: wrapper delgado -- toda la
  // logica real vive en runTurnForWindow() (exportada mas arriba), que no
  // depende de IpcMainInvokeEvent. Este handler solo lee panelId del
  // payload real y delega.
  ipcMain.handle('agent:send', async (_event, payload: RunTurnPayload & { panelId: string }) => {
    return runTurnForWindow(payload.panelId, payload)
  })

  ipcMain.handle('agent:cancel', (_event, payload: { panelId: string }) => {
    return { success: true, cancelled: cancelSessionTurn(payload.panelId) }
  })

  ipcMain.handle('agent:reply', (_event, payload: { panelId: string; requestId: number | string; result: unknown }) => {
    const session = getSession(payload.panelId)
    if (!session.codexClient) throw new Error('Codex no esta conectado.')
    session.codexClient.respondToServerRequest(payload.requestId, payload.result)
    return { success: true }
  })

  ipcMain.handle('agent:toolApproval:respond', (_event, payload: { panelId: string; id: string; approved: boolean; trust?: boolean }) => {
    const session = getSession(payload.panelId)
    const resolve = session.pendingToolApprovals.get(payload.id)
    if (!resolve) return { success: false }
    session.pendingToolApprovals.delete(payload.id)
    if (payload.approved && payload.trust) setSessionToolTrust(payload.panelId, true)
    resolve(payload.approved)
    return { success: true }
  })

  ipcMain.handle('agent:toolTrust:disable', (_event, payload: { panelId: string }) => {
    setSessionToolTrust(payload.panelId, false)
    return { success: true }
  })

  // Familia A (computer use, docs/_arch/verify_computer_use_security_model.md,
  // Tarea 1/2): toggle real de Capa 1 desde el checkbox del composer (App.tsx)
  // -- solo se renderiza ahi si settings.computerUseAcknowledged ya es true
  // (advertencia dura ya mostrada al menos una vez, ver ipc-settings.ts).
  // Sin gate de conexion (a diferencia de agent:planMode:enable) -- activar/
  // desactivar el toggle no depende de tener un turno en curso, es estado
  // de sesion puro. setComputerUseActive() ya maneja el arm/disarm real del
  // panic key global (runtime-state.ts).
  ipcMain.handle('agent:computerUse:set', (_event, payload: { panelId: string; active: boolean }) => {
    setComputerUseActive(payload.panelId, payload.active)
    return { success: true }
  })

  // Navegador embebido (docs/_arch/verify_embedded_browser_design.md,
  // Tarea 3): mismo patron exacto que agent:computerUse:set de arriba.
  ipcMain.handle('agent:browserControl:set', (_event, payload: { panelId: string; active: boolean }) => {
    setBrowserControlActive(payload.panelId, payload.active)
    return { success: true }
  })

  // Navegador embebido, Tarea 4: el panel de chat reporta su rectangulo
  // real (ResizeObserver sobre el <div> contenedor, App.tsx) cada vez que
  // cambia -- geometria pura, sin gate de seguridad (posicionar una vista
  // que YA existe -- o no existe, no-op -- nunca ejecuta ninguna accion
  // real dentro de la pagina). No-op si la vista de ese panel no existe
  // (browserControlActive todavia false, o ya se desactivo).
  ipcMain.handle('browser:setBounds', (_event, payload: { panelId: string; x: number; y: number; width: number; height: number }) => {
    setBrowserViewBounds(payload.panelId, payload)
    return { success: true }
  })

  // "Modo plan" (docs/_arch/verify_plan_mode_design.md, Tarea 1/4): activado
  // desde el checkbox del composer (App.tsx) -- requiere conexion real ya
  // establecida (enablePlanMode() rechaza si no, mismo criterio fail-closed
  // de esta sesion). `enforced` decide la variante reforzada real.
  ipcMain.handle('agent:planMode:enable', (_event, payload: { panelId: string; enforced: boolean }) => {
    const result = enablePlanMode(payload.panelId, payload.enforced)
    return result.ok ? { success: true } : { success: false, error: result.error }
  })

  // Salida MANUAL desde la pildora de la UI (docs/_arch/verify_plan_mode_design.md,
  // Tarea 4) -- mismo espiritu que agent:toolTrust:disable: el humano no
  // depende de que el modelo llame exit_plan_mode. Misma funcion real que
  // usa el case de la tool (tool-registry.ts, via el closure exitPlanMode
  // de connectSessionForWindow) -- una sola fuente de verdad para la
  // transicion.
  ipcMain.handle('agent:planMode:disable', (_event, payload: { panelId: string }) => {
    disablePlanMode(payload.panelId)
    return { success: true }
  })

  // Fase Paneles-3: el renderer llama esto al terminar el handshake de 2
  // pasos (abrir via openChatInPanel() real + conectar) que le pidio
  // panel:openAndConnectRequest -- resuelve la promesa pendiente real en
  // cross-window-messaging.ts. Import dinamico, MISMO motivo exacto que
  // sendToWindowByTitle() mas abajo en este archivo: cross-window-messaging.ts
  // ya importa runTurnForWindow() DESDE este archivo, asi que un import
  // estatico de vuelta crearia un ciclo de modulos real.
  ipcMain.handle('panel:openAndConnectResponse', async (_event, payload: { requestId: string; success: boolean; panelId?: string; error?: string }) => {
    const { resolvePanelOpenAndConnectRequest } = await import('./cross-window-messaging.js')
    resolvePanelOpenAndConnectRequest(payload.requestId, {
      success: payload.success,
      panelId: payload.panelId,
      error: payload.error
    })
    return { success: true }
  })
}
