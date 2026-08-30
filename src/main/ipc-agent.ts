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
import { detectGemini } from './cli-status'
import { getAppDataSubdir } from './app-paths'
import { isUnsupportedLocalModel, isUnsupportedLocalProvider } from './settings-provisioning'
import { maybeCompactChatInBackground, resolveConfiguredCompactionModel } from './compaction-engine'
import { generateImage } from './image-generation'
import { isApiCapableModel } from '../shared/model-capabilities'
import { AGENTS_MD_LINE_WARNING_THRESHOLD, refreshAgentsMdCache } from './agents-md'
import { McpManager } from './mcp-client'
import { LspManager } from './lsp-manager'
import { listChatSessionsForWindowDiscovery, panelAliasForTitle } from './chat-store'
import {
  buildRuntimeContext,
  cancelSessionTurn,
  defaultChatWorkspace,
  disconnectSession,
  getSession,
  requestSessionToolApproval,
  resolvedWorkspace,
  sendSessionEvent,
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
import type { ChatAttachment, ConversationMessage, SandboxMode } from '../shared/types'

const DEBUG_TOOLS = process.env.AMATISTA_DEBUG_TOOLS === '1'

/**
 * Fase 12 (blindaje de carrera, investigado a partir del hallazgo de
 * PENDING.md → "Encontrado durante refactor (Fase 2)"): confirmado leyendo
 * App.tsx que el boton "Quitar" de una carpeta raiz NO tiene ningun
 * disabled ligado a agentState === 'connecting' (solo los botones
 * "Conectar agente" y el de enviar mensaje lo tienen) — projects:removeRoot
 * SI puede llegar mientras agent:connect sigue en alguno de sus await
 * (client.start/detectGemini/mcpManagerForConnection.startAll).
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
   *  cual hasta codexClient.sendTurn()/cliRuntime.send() — ninguno de
   *  los dos lo aplica si viene undefined, y ninguno de los otros 4
   *  runtimes (foundry/anthropic-api/gemini-api/gemini) lo consulta en
   *  absoluto, asi que no hace falta gatear por runtime aca tampoco. */
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
    model
  })
  const seedContext = !session.activeContextSeeded && context.history.length > 0 ? context : undefined

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
    const CODEX_TURN_TIMEOUT_MS = 120_000
    const waitForCompletion = new Promise<void>(resolve => {
      let settled = false
      const finish = (): void => {
        if (settled) return
        settled = true
        client.off('notification', onNotification)
        resolve()
      }
      const onNotification = (message: { method?: string; params?: unknown }): void => {
        if (message.method === 'item/agentMessage/delta') {
          accumulatedText += extractCodexDeltaText(message.params)
        } else if (message.method === 'turn/completed' || message.method === 'turn/cancelled') {
          finish()
        }
      }
      client.on('notification', onNotification)
      setTimeout(finish, CODEX_TURN_TIMEOUT_MS)
    })
    await client.sendTurn({
      threadId: session.activeThreadId,
      text: payload.text,
      model: model.model,
      workspace: resolvedWorkspace(session.activeWorkspace),
      context: seedContext,
      effort: payload.effort
    })
    await waitForCompletion
    session.activeContextSeeded = true
    return { success: true, text: accumulatedText || undefined }
  }

  const runtime = session.activeRuntime
  if (runtime === 'foundry' || runtime === 'gemini-api' || runtime === 'anthropic-api' || runtime === 'openai-chat') {
    if (!session.apiRuntime) throw new Error('Runtime API no disponible.')
    const abort = new AbortController()
    session.currentTurnAbort = abort
    try {
      const result = await session.apiRuntime.send(payload.text, context, abort.signal)
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
  // Limpieza de claude-cli: send() ya no acepta `effort` -- era exclusivo
  // de Claude (sendGemini() nunca lo tomaba). payload.effort sigue
  // llegando en el payload (Codex/API si lo usan, mas arriba en esta
  // funcion) pero ya no se lo pasamos al runtime CLI.
  const result = await session.cliRuntime.send(payload.text, seedContext)
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
  return { success: true, text: result.text }
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
    disconnectSession(panelId)
    const session = getSession(panelId)
    // Fase 22c: se guarda el objeto COMPLETO ya validado arriba contra
    // settings.providers -- agent:send va a usar esto directo de aca en
    // adelante, sin volver a buscarlo en settings.providers en cada turno
    // (ver justificacion completa en runtime-state.ts, SessionRuntimeState).
    session.provider = provider
    session.model = model
    session.activeWorkspace = payload.workspace?.trim()
      ? realpathSync(payload.workspace)
      : defaultChatWorkspace()
    session.activeChatId = payload.chatId?.trim() || null
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
        sandbox: payload.sandbox
      })
      assertSessionWorkspaceStillActive(panelId, connectingWorkspace, () => client.stop())
      session.activeThreadId = thread.id
      session.activeRuntime = 'codex'
    } else if (isApiCapableModel(provider, model)) {
      const runtime = new ApiAgentRuntime()
      session.apiRuntime = runtime
      wireApi(panelId, runtime)
      const toolWorkspace = session.activeWorkspace

      // Fase 10: servidores MCP SOLO para runtimes API — gemini-cli/
      // codex-subscription/codex-api ya tienen MCP nativo, no pasan por
      // aca. Un servidor individual que falla nunca bloquea la conexion
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

      runtime.configure({
        kind:
          model.runtime === 'foundry'
            ? 'foundry'
            : model.runtime === 'anthropic-api'
              ? 'anthropic-api'
              // Fase 15: OpenRouter/Chat-Completions, antes de caer al
              // default 'gemini-api' (que en realidad cubre Gemini con
              // authMode:'api-key' via el runtime 'gemini-cli', ver
              // isApiCapableModel — nombre historico un poco confuso,
              // no tocado en esta fase).
              : model.runtime === 'openai-chat'
                ? 'openai-chat'
                : 'gemini-api',
        provider,
        model: model.model,
        maxOutputTokens: model.maxOutputTokens,
        workspace: session.activeWorkspace!,
        sandbox: payload.sandbox,
        toolsEnabled: model.capabilities.tools,
        toolExecutor: model.capabilities.tools
          ? (name, args) => toolRegistry.execute(name, args, {
              workspace: toolWorkspace!,
              // Fase 12: antes NO se pasaba — el sandbox mode elegido en
              // agent:connect nunca llegaba hasta ExecuteContext para los
              // runtimes API, asi que write_file/apply_patch/run_command/
              // revert_file (y las tools MCP, en api-agent-runtime.ts)
              // ignoraban por completo read-only/danger-full-access. Ver
              // docs/_arch/CONTRACT.md → "Sandbox mode no aplicado en
              // runtimes API (Fase 12)".
              sandbox: payload.sandbox,
              // Fase 22b: cerrado sobre `panelId` de ESTA conexion -- el
              // dialogo de aprobacion (y su respuesta via
              // agent:toolApproval:respond) se dirige a este panel
              // puntual, no a un destino global/broadcast.
              confirm: (title, detail) => requestSessionToolApproval(panelId, title, detail),
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
              lspManager: lspManagerForConnection,
              // UI Paso 1: sincrona, sin import dinamico (a diferencia de
              // sendToWindowByTitle abajo) -- listWindowsForSession() no
              // importa nada de cross-window-messaging.ts, asi que no hay
              // ningun ciclo de modulos que evitar aca.
              listWindows: () => listWindowsForSession(session),
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
              }
            })
          : undefined,
        mcpManager: mcpManagerForConnection,
        mcpToolDefinitions: mcpManagerForConnection.listToolDefinitions(),
        mcpConfirm: (title, detail) => requestSessionToolApproval(panelId, title, detail)
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
      // Limpieza de claude-cli: esta rama solo se alcanza para
      // model.runtime === 'gemini-cli' -- es la UNICA forma CLI que le
      // queda a RuntimeKind despues de sacar 'claude-cli' del union,
      // confirmado por typecheck (las ramas claude-cli/'claude' de este
      // bloque tiraban error de comparacion sin overlap antes de este fix).
      const cli = await detectGemini()
      assertSessionWorkspaceStillActive(panelId, connectingWorkspace)
      if (!cli.installed) {
        throw new Error('Gemini CLI no esta instalado.')
      }

      const runtime = new CliAgentRuntime()
      session.cliRuntime = runtime
      wireCli(panelId, runtime)
      runtime.configure({
        kind: 'gemini',
        provider,
        model: model.model,
        workspace: session.activeWorkspace!,
        sandbox: payload.sandbox
      })
      session.activeRuntime = 'gemini'
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
  ipcMain.handle('agent:disconnect', (_event, payload: { panelId: string }) => {
    disconnectSession(payload.panelId)
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
