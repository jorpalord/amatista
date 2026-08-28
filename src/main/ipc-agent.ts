// Canales IPC del ciclo de vida del agente: connect/send/cancel, respuestas
// a server-request de Codex, y aprobacion/confianza de tool calls.
//
// Fase 22b: todos los handlers resuelven `windowId` PRIMERO (via
// event.sender, Electron ya lo provee gratis) y operan sobre
// getSession(windowId) -- nunca sobre una variable global compartida. Cada
// ventana tiene su propia conexion de runtime real, independiente de las
// demas (antes de esta fase, agent:connect mataba la conexion de CUALQUIER
// otra ventana sin aviso -- ver docs/_arch/verify_fase22_scope.md).
import { BrowserWindow, ipcMain, type IpcMainInvokeEvent } from 'electron'
import { realpathSync } from 'node:fs'
import { CodexClient } from './codex-client'
import { ApiAgentRuntime, TurnCancelledError } from './api-agent-runtime'
import { CliAgentRuntime } from './cli-agent-runtime'
import { detectClaude, detectGemini } from './cli-status'
import { getAppDataSubdir } from './app-paths'
import { isUnsupportedLocalModel, isUnsupportedLocalProvider } from './settings-provisioning'
import { maybeCompactChatInBackground, resolveConfiguredCompactionModel } from './compaction-engine'
import { isApiCapableModel } from '../shared/model-capabilities'
import { AGENTS_MD_LINE_WARNING_THRESHOLD, refreshAgentsMdCache } from './agents-md'
import { McpManager } from './mcp-client'
import { LspManager } from './lsp-manager'
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
  wireCodex
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
 * (client.start/detectClaude/detectGemini/mcpManagerForConnection.startAll).
 * Si el root removido matchea el workspace activo, ese handler llama
 * disconnectSession() (para/anula lo que esta conexion ya arranco) y pone
 * el workspace de esa sesion en null — sin este guard, la conexion en vuelo
 * seguia de largo con session.activeWorkspace! (non-null assertion) sobre
 * un valor que ya es null, y terminaba resucitando apiRuntime/mcpManager/
 * activeRuntime que el disconnect concurrente ya habia parado.
 *
 * Fase 22b: comparaba contra la global `activeWorkspace` -- ahora compara
 * contra `getSession(windowId).activeWorkspace`, misma logica, acotada a
 * la sesion de la ventana que esta conectando.
 */
function assertSessionWorkspaceStillActive(windowId: number, connectingWorkspace: string | null, cleanup?: () => void): void {
  if (getSession(windowId).activeWorkspace === connectingWorkspace) return
  cleanup?.()
  throw new Error(
    'La conexion se cancelo: el workspace activo cambio mientras se estaba conectando ' +
    '(se removio la carpeta raiz activa, o se disparo otra conexion en paralelo). Intenta conectar de nuevo.'
  )
}

/** Identifica de que BrowserWindow vino esta llamada IPC via event.sender
 *  (Electron ya lo provee gratis en cada handler, no hace falta ningun
 *  dato nuevo del renderer). */
function originWindowId(event: IpcMainInvokeEvent): number | null {
  return BrowserWindow.fromWebContents(event.sender)?.id ?? null
}

export function registerAgentIpc(): void {
  ipcMain.handle('agent:disconnect', event => {
    const windowId = originWindowId(event)
    if (windowId !== null) disconnectSession(windowId)
    return { success: true }
  })

  ipcMain.handle('agent:connect', async (event, payload: {
    providerId: string
    modelId: string
    workspace?: string
    chatId?: string
    sandbox: SandboxMode
  }) => {
    const windowId = originWindowId(event)
    if (windowId === null) throw new Error('No se pudo identificar la ventana de origen de esta conexion.')

    const provider = settings.providers.find(item => item.id === payload.providerId)
    if (!provider || !provider.enabled) throw new Error('Proveedor no disponible.')
    const model = provider.models.find(item => item.id === payload.modelId && item.enabled)
    if (!model) throw new Error('Modelo no disponible.')
    if (isUnsupportedLocalProvider(provider) || isUnsupportedLocalModel(model)) {
      throw new Error('Ollama/qwen2.5:7b esta desactivado: no hay compatibilidad real validada con este runtime.')
    }

    // Fase 22b: antes mataba LA conexion global (cualquier otra ventana
    // conectando o conectada). Ahora solo la sesion de ESTA ventana --
    // otras ventanas con su propia conexion activa no se ven afectadas.
    disconnectSession(windowId)
    const session = getSession(windowId)
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
        `[agent:connect] ventana=${windowId} deployment="${model.model}" runtime=${model.runtime} ` +
        `capabilities.tools=${model.capabilities.tools} payload.workspace="${payload.workspace ?? ''}" ` +
        `activeWorkspace(resuelto)="${session.activeWorkspace}"`
      )
    }

    if (model.runtime === 'codex-subscription' || model.runtime === 'codex-api') {
      const client = new CodexClient()
      session.codexClient = client
      wireCodex(windowId, client)
      const codexHome = getAppDataSubdir('codex-home-api')
      const thread = await client.start({
        provider,
        model: model.model,
        workspace: session.activeWorkspace!,
        codexHome,
        sandbox: payload.sandbox
      })
      assertSessionWorkspaceStillActive(windowId, connectingWorkspace, () => client.stop())
      session.activeThreadId = thread.id
      session.activeRuntime = 'codex'
    } else if (isApiCapableModel(provider, model)) {
      const runtime = new ApiAgentRuntime()
      session.apiRuntime = runtime
      wireApi(windowId, runtime)
      const toolWorkspace = session.activeWorkspace

      // Fase 10: servidores MCP SOLO para runtimes API — claude-cli/
      // codex-subscription/codex-api ya tienen MCP nativo, no pasan por
      // aca. Un servidor individual que falla nunca bloquea la conexion
      // (ver McpManager.startAll, nunca lanza) — startAll() awaited antes
      // de configure() para que el catalogo de tools este completo desde
      // el primer turno, no se descubre a mitad de conversacion.
      const mcpManagerForConnection = new McpManager()
      session.mcpManager = mcpManagerForConnection
      await mcpManagerForConnection.startAll(session.activeWorkspace!)
      assertSessionWorkspaceStillActive(windowId, connectingWorkspace, () => mcpManagerForConnection.stopAll())

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
              // Fase 22b: cerrado sobre `windowId` de ESTA conexion -- el
              // dialogo de aprobacion (y su respuesta via
              // agent:toolApproval:respond) se dirige a esta ventana
              // puntual, no a un destino global/broadcast.
              confirm: (title, detail) => requestSessionToolApproval(windowId, title, detail),
              // Fresco en cada llamada (no capturado una vez aca): si el
              // usuario cambia el modelo de compactacion en Settings a
              // mitad de la conexion, explore lo ve sin necesitar
              // reconectar — mismo criterio que maybeCompactChatInBackground,
              // que tambien lee `settings` en el momento, no al conectar.
              resolveExploreModel: () => resolveConfiguredCompactionModel(settings),
              lspManager: lspManagerForConnection
            })
          : undefined,
        mcpManager: mcpManagerForConnection,
        mcpToolDefinitions: mcpManagerForConnection.listToolDefinitions(),
        mcpConfirm: (title, detail) => requestSessionToolApproval(windowId, title, detail)
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
      const cli = model.runtime === 'claude-cli' ? await detectClaude() : await detectGemini()
      assertSessionWorkspaceStillActive(windowId, connectingWorkspace)
      if (!cli.installed) {
        throw new Error(model.runtime === 'claude-cli'
          ? 'Claude Code CLI no esta instalado.'
          : 'Gemini CLI no esta instalado.')
      }

      const runtime = new CliAgentRuntime()
      session.cliRuntime = runtime
      wireCli(windowId, runtime)
      runtime.configure({
        kind: model.runtime === 'claude-cli' ? 'claude' : 'gemini',
        provider,
        model: model.model,
        workspace: session.activeWorkspace!,
        sandbox: payload.sandbox
      })
      session.activeRuntime = model.runtime === 'claude-cli' ? 'claude' : 'gemini'
    }

    setSettings({
      ...settings,
      activeProviderId: provider.id,
      activeModelId: model.id,
      activeProjectPath: payload.workspace?.trim() ? session.activeWorkspace ?? undefined : settings.activeProjectPath
    })
    saveSettings(settings)
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
  })

  ipcMain.handle('agent:send', async (event, payload: {
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
  }) => {
    const windowId = originWindowId(event)
    if (windowId === null) throw new Error('No se pudo identificar la ventana de origen de este turno.')
    const session = getSession(windowId)
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
    // compartida, y otra ventana puede borrar/deshabilitar este mismo
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
      await session.codexClient.sendTurn({
        threadId: session.activeThreadId,
        text: payload.text,
        model: model.model,
        workspace: resolvedWorkspace(session.activeWorkspace),
        context: seedContext,
        effort: payload.effort
      })
      session.activeContextSeeded = true
      return { success: true }
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
        sendSessionEvent(windowId, {
          chatId: requestChatId,
          workspace: requestWorkspace,
          kind: 'notification',
          method: 'item/agentMessage/delta',
          params: { itemId, delta: result.text }
        })
        sendSessionEvent(windowId, {
          chatId: requestChatId,
          workspace: requestWorkspace,
          kind: 'notification',
          method: 'turn/completed',
          params: {}
        })
        // Fire-and-forget (Tarea 4): dispara DESPUES de que la respuesta ya
        // se emitio al renderer, sin await — nunca agrega latencia a este
        // turno. maybeCompactChatInBackground nunca lanza (atrapa todo
        // adentro); el resultado, si lo hay, queda para el PROXIMO turno.
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
          sendSessionEvent(windowId, {
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
    const result = await session.cliRuntime.send(payload.text, seedContext, payload.effort)
    session.activeContextSeeded = true
    const itemId = `${session.activeRuntime}-${Date.now()}`
    sendSessionEvent(windowId, {
      chatId: requestChatId,
      workspace: requestWorkspace,
      kind: 'notification',
      method: 'item/agentMessage/delta',
      params: { itemId, delta: result.text }
    })
    sendSessionEvent(windowId, {
      chatId: requestChatId,
      workspace: requestWorkspace,
      kind: 'notification',
      method: 'turn/completed',
      params: {}
    })
    return { success: true, text: result.text }
  })

  ipcMain.handle('agent:cancel', event => {
    const windowId = originWindowId(event)
    if (windowId === null) return { success: false, cancelled: false }
    return { success: true, cancelled: cancelSessionTurn(windowId) }
  })

  ipcMain.handle('agent:reply', (event, payload: { requestId: number | string; result: unknown }) => {
    const windowId = originWindowId(event)
    const session = windowId !== null ? getSession(windowId) : null
    if (!session?.codexClient) throw new Error('Codex no esta conectado.')
    session.codexClient.respondToServerRequest(payload.requestId, payload.result)
    return { success: true }
  })

  ipcMain.handle('agent:toolApproval:respond', (event, payload: { id: string; approved: boolean; trust?: boolean }) => {
    const windowId = originWindowId(event)
    if (windowId === null) return { success: false }
    const session = getSession(windowId)
    const resolve = session.pendingToolApprovals.get(payload.id)
    if (!resolve) return { success: false }
    session.pendingToolApprovals.delete(payload.id)
    if (payload.approved && payload.trust) setSessionToolTrust(windowId, true)
    resolve(payload.approved)
    return { success: true }
  })

  ipcMain.handle('agent:toolTrust:disable', event => {
    const windowId = originWindowId(event)
    if (windowId !== null) setSessionToolTrust(windowId, false)
    return { success: true }
  })
}
