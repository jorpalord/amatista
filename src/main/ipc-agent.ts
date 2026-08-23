// Canales IPC del ciclo de vida del agente: connect/send/cancel, respuestas
// a server-request de Codex, y aprobacion/confianza de tool calls.
import { ipcMain } from 'electron'
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
import {
  activeChatId,
  activeContextSeeded,
  activeRuntime,
  activeThreadId,
  activeWorkspace,
  apiRuntime,
  buildRuntimeContext,
  cancelCurrentTurn,
  cliRuntime,
  codexClient,
  currentTurnAbort,
  defaultChatWorkspace,
  disconnectAgent,
  pendingToolApprovals,
  requestToolApproval,
  resolvedWorkspace,
  sendAgentEvent,
  setActiveChatId,
  setActiveContextSeeded,
  setActiveRuntime,
  setActiveThreadId,
  setActiveWorkspace,
  setApiRuntime,
  setCliRuntime,
  setCodexClient,
  setCurrentTurnAbort,
  setToolTrustSession,
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

export function registerAgentIpc(): void {
  ipcMain.handle('agent:disconnect', () => {
    disconnectAgent()
    return { success: true }
  })

  ipcMain.handle('agent:connect', async (_event, payload: {
    providerId: string
    modelId: string
    workspace?: string
    chatId?: string
    sandbox: SandboxMode
  }) => {
    const provider = settings.providers.find(item => item.id === payload.providerId)
    if (!provider || !provider.enabled) throw new Error('Proveedor no disponible.')
    const model = provider.models.find(item => item.id === payload.modelId && item.enabled)
    if (!model) throw new Error('Modelo no disponible.')
    if (isUnsupportedLocalProvider(provider) || isUnsupportedLocalModel(model)) {
      throw new Error('Ollama/qwen2.5:7b esta desactivado: no hay compatibilidad real validada con este runtime.')
    }

    disconnectAgent()
    setActiveWorkspace(payload.workspace?.trim()
      ? realpathSync(payload.workspace)
      : defaultChatWorkspace())
    setActiveChatId(payload.chatId?.trim() || null)

    // Fase 7: se refresca UNA vez por conexion, no en cada turno — el
    // resto de agentsMd (agents-md.ts) se sirve del cache hasta el proximo
    // connect/cambio de workspace.
    const agentsMdInfo = refreshAgentsMdCache(activeWorkspace!)

    if (DEBUG_TOOLS) {
      console.log(
        `[agent:connect] deployment="${model.model}" runtime=${model.runtime} ` +
        `capabilities.tools=${model.capabilities.tools} payload.workspace="${payload.workspace ?? ''}" ` +
        `activeWorkspace(resuelto)="${activeWorkspace}"`
      )
    }

    if (model.runtime === 'codex-subscription' || model.runtime === 'codex-api') {
      const client = new CodexClient()
      setCodexClient(client)
      wireCodex(client)
      const codexHome = getAppDataSubdir('codex-home-api')
      const thread = await client.start({
        provider,
        model: model.model,
        workspace: activeWorkspace!,
        codexHome,
        sandbox: payload.sandbox
      })
      setActiveThreadId(thread.id)
      setActiveRuntime('codex')
    } else if (isApiCapableModel(provider, model)) {
      const runtime = new ApiAgentRuntime()
      setApiRuntime(runtime)
      wireApi(runtime)
      const toolWorkspace = activeWorkspace
      runtime.configure({
        kind:
          model.runtime === 'foundry'
            ? 'foundry'
            : model.runtime === 'anthropic-api'
              ? 'anthropic-api'
              : 'gemini-api',
        provider,
        model: model.model,
        maxOutputTokens: model.maxOutputTokens,
        workspace: activeWorkspace!,
        sandbox: payload.sandbox,
        toolsEnabled: model.capabilities.tools,
        toolExecutor: model.capabilities.tools
          ? (name, args) => toolRegistry.execute(name, args, {
              workspace: toolWorkspace!,
              confirm: requestToolApproval,
              // Fresco en cada llamada (no capturado una vez aca): si el
              // usuario cambia el modelo de compactacion en Settings a
              // mitad de la conexion, explore lo ve sin necesitar
              // reconectar — mismo criterio que maybeCompactChatInBackground,
              // que tambien lee `settings` en el momento, no al conectar.
              resolveExploreModel: () => resolveConfiguredCompactionModel(settings)
            })
          : undefined
      })
      setActiveRuntime(
        model.runtime === 'foundry'
          ? 'foundry'
          : model.runtime === 'anthropic-api'
            ? 'anthropic-api'
            : 'gemini-api'
      )
    } else {
      const cli = model.runtime === 'claude-cli' ? await detectClaude() : await detectGemini()
      if (!cli.installed) {
        throw new Error(model.runtime === 'claude-cli'
          ? 'Claude Code CLI no esta instalado.'
          : 'Gemini CLI no esta instalado.')
      }

      const runtime = new CliAgentRuntime()
      setCliRuntime(runtime)
      wireCli(runtime)
      runtime.configure({
        kind: model.runtime === 'claude-cli' ? 'claude' : 'gemini',
        provider,
        model: model.model,
        workspace: activeWorkspace!,
        sandbox: payload.sandbox
      })
      setActiveRuntime(model.runtime === 'claude-cli' ? 'claude' : 'gemini')
    }

    setSettings({
      ...settings,
      activeProviderId: provider.id,
      activeModelId: model.id,
      activeProjectPath: payload.workspace?.trim() ? activeWorkspace ?? undefined : settings.activeProjectPath
    })
    saveSettings(settings)
    return {
      connected: true,
      runtime: activeRuntime,
      workspace: activeWorkspace,
      workspaceIsDefault: !payload.workspace?.trim(),
      // Tarea 3 de Fase 7: nunca se trunca AGENTS.md — se manda completo
      // siempre, esto es solo un aviso para que el usuario decida acortarlo.
      agentsMdWarning: agentsMdInfo?.oversized
        ? `AGENTS.md tiene ${agentsMdInfo.lineCount} lineas (guia de la industria: ~${AGENTS_MD_LINE_WARNING_THRESHOLD} o menos). Se manda completo en cada turno igual, pero conviene acortarlo — instrucciones muy largas compiten por espacio con el resto del contexto del turno.`
        : undefined
    }
  })

  ipcMain.handle('agent:send', async (_event, payload: {
    text: string
    chatId?: string
    attachments?: ChatAttachment[]
    history?: ConversationMessage[]
    modelId: string
    providerId: string
    sandbox: SandboxMode
  }) => {
    if (!activeRuntime) throw new Error('Agente no conectado.')
    // Se captura AHORA, antes de cualquier await: si el usuario cambia de chat
    // (o de workspace) mientras esta llamada sigue en vuelo, activeChatId /
    // activeWorkspace (variables globales del proceso main) pueden apuntar a
    // otro chat para cuando la respuesta llegue. Sin esto, sendAgentEvent()
    // etiquetaria la respuesta de ESTE turno con el chat que quedo activo
    // despues, mezclando historial entre chats.
    const requestChatId = payload.chatId?.trim() || activeChatId
    const requestWorkspace = activeWorkspace
    const provider = settings.providers.find(item => item.id === payload.providerId)
    const model = provider?.models.find(item => item.id === payload.modelId)
    if (!provider || !model) throw new Error('Modelo/proveedor no disponible.')
    const context = buildRuntimeContext({
      text: payload.text,
      history: payload.history,
      attachments: runtimeAttachmentView(payload.attachments),
      chatId: requestChatId,
      provider,
      model
    })
    const seedContext = !activeContextSeeded && context.history.length > 0 ? context : undefined

    if (activeRuntime === 'codex') {
      if (!codexClient || !activeThreadId) throw new Error('Codex no esta conectado.')
      await codexClient.sendTurn({
        threadId: activeThreadId,
        text: payload.text,
        model: model.model,
        workspace: resolvedWorkspace(),
        context: seedContext
      })
      setActiveContextSeeded(true)
      return { success: true }
    }

    const runtime = activeRuntime
    if (runtime === 'foundry' || runtime === 'gemini-api' || runtime === 'anthropic-api') {
      if (!apiRuntime) throw new Error('Runtime API no disponible.')
      const abort = new AbortController()
      setCurrentTurnAbort(abort)
      try {
        const result = await apiRuntime.send(payload.text, context, abort.signal)
        setActiveContextSeeded(true)
        const itemId = `${activeRuntime}-${Date.now()}`
        sendAgentEvent({
          chatId: requestChatId,
          workspace: requestWorkspace,
          kind: 'notification',
          method: 'item/agentMessage/delta',
          params: { itemId, delta: result.text }
        })
        sendAgentEvent({
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
          setActiveContextSeeded(true)
          sendAgentEvent({
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
        if (currentTurnAbort === abort) setCurrentTurnAbort(null)
      }
    }

    if (!cliRuntime) throw new Error('Runtime CLI no disponible.')
    const result = await cliRuntime.send(payload.text, seedContext)
    setActiveContextSeeded(true)
    const itemId = `${activeRuntime}-${Date.now()}`
    sendAgentEvent({
      chatId: requestChatId,
      workspace: requestWorkspace,
      kind: 'notification',
      method: 'item/agentMessage/delta',
      params: { itemId, delta: result.text }
    })
    sendAgentEvent({
      chatId: requestChatId,
      workspace: requestWorkspace,
      kind: 'notification',
      method: 'turn/completed',
      params: {}
    })
    return { success: true, text: result.text }
  })

  ipcMain.handle('agent:cancel', () => ({ success: true, cancelled: cancelCurrentTurn() }))

  ipcMain.handle('agent:reply', (_event, payload: { requestId: number | string; result: unknown }) => {
    if (!codexClient) throw new Error('Codex no esta conectado.')
    codexClient.respondToServerRequest(payload.requestId, payload.result)
    return { success: true }
  })

  ipcMain.handle('agent:toolApproval:respond', (_event, payload: { id: string; approved: boolean; trust?: boolean }) => {
    const resolve = pendingToolApprovals.get(payload.id)
    if (!resolve) return { success: false }
    pendingToolApprovals.delete(payload.id)
    if (payload.approved && payload.trust) setToolTrustSession(true)
    resolve(payload.approved)
    return { success: true }
  })

  ipcMain.handle('agent:toolTrust:disable', () => {
    setToolTrustSession(false)
    return { success: true }
  })
}
