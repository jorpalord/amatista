// Estado mutable compartido del proceso main + funciones que operan sobre el
// (conexion de runtime activa, workspace activo, puente hacia el renderer).
// Se saca de index.ts porque ipc-agent.ts, ipc-workspace.ts e ipc-settings.ts
// necesitan leer/mutar las mismas variables (un unico runtime activo a la vez,
// mismo supuesto que tenia el index.ts monolitico).
import { BrowserWindow } from 'electron'
import { randomUUID } from 'node:crypto'
import { realpathSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { CodexClient } from './codex-client'
import { CodexAccountBridge } from './codex-account-bridge'
import { CliAgentRuntime } from './cli-agent-runtime'
import { ApiAgentRuntime } from './api-agent-runtime'
import { McpManager } from './mcp-client'
import { ToolRegistry } from './tool-registry'
import { getAppDataSubdir } from './app-paths'
import { normalizeHistory } from './context-envelope'
import { getChatSummaryState } from './chat-store'
import { getCachedAgentsMd } from './agents-md'
import type {
  AppSettings,
  ChatAttachment,
  ConversationMessage,
  ModelProfile,
  ProviderProfile,
  RuntimeContextEnvelope
} from '../shared/types'

export let mainWindow: BrowserWindow | null = null
export function setMainWindow(window: BrowserWindow | null): void {
  mainWindow = window
}

export let codexClient: CodexClient | null = null
export const codexAccountBridge = new CodexAccountBridge()
export let cliRuntime: CliAgentRuntime | null = null
export let apiRuntime: ApiAgentRuntime | null = null
/** Fase 10 — servidores MCP de la conexion actual (solo runtimes API).
 *  Mismo ciclo de vida que apiRuntime: se crea en agent:connect, se mata
 *  en disconnectAgent(), nunca por turno individual. */
export let mcpManager: McpManager | null = null
export function setMcpManager(manager: McpManager | null): void {
  mcpManager = manager
}
export let activeRuntime: 'codex' | 'claude' | 'gemini' | 'foundry' | 'gemini-api' | 'anthropic-api' | null = null
export let activeWorkspace: string | null = null
export let activeThreadId: string | null = null
export let activeChatId: string | null = null
export let activeContextSeeded = false
let isDisconnecting = false
export let settings: AppSettings = { providers: [], projectRoots: [] }
export function setSettings(next: AppSettings): void {
  settings = next
}

export const toolRegistry = new ToolRegistry()
export const pendingToolApprovals = new Map<string, (approved: boolean) => void>()
let toolTrustSession = false

/** Turno apiRuntime actualmente en vuelo (si hay uno). Un solo turno activo
 *  a la vez por diseno (mismo supuesto que activeRuntime/apiRuntime). */
export let currentTurnAbort: AbortController | null = null
export function setCurrentTurnAbort(abort: AbortController | null): void {
  currentTurnAbort = abort
}

/** Cancela el turno en curso (boton Detener) y limpia cualquier aprobacion
 *  de tool pendiente, igual que hace disconnectAgent(). */
export function cancelCurrentTurn(): boolean {
  if (!currentTurnAbort) return false
  currentTurnAbort.abort()
  for (const resolve of pendingToolApprovals.values()) resolve(false)
  pendingToolApprovals.clear()
  return true
}

export function setToolTrustSession(active: boolean): void {
  toolTrustSession = active
  sendToRenderer('agent:toolTrust', { active })
}

export function requestToolApproval(title: string, detail: string): Promise<boolean> {
  if (toolTrustSession) return Promise.resolve(true)

  return new Promise(resolve => {
    const id = randomUUID()
    pendingToolApprovals.set(id, resolve)
    sendToRenderer('agent:toolApproval', { id, title, detail })
  })
}

export function canUseMainWindow(): boolean {
  return Boolean(
    mainWindow &&
    !mainWindow.isDestroyed() &&
    mainWindow.webContents &&
    !mainWindow.webContents.isDestroyed()
  )
}

export function sendToRenderer(channel: string, payload: unknown): void {
  if (!canUseMainWindow()) return

  try {
    mainWindow!.webContents.send(channel, payload)
  } catch {
    // La ventana pudo destruirse entre el guard y el envio.
  }
}

export function sendAgentEvent(payload: Record<string, unknown>): void {
  sendToRenderer('agent:event', {
    workspace: activeWorkspace,
    chatId: activeChatId,
    ...payload
  })
}

export function setActiveWorkspace(workspace: string | null): void {
  activeWorkspace = workspace
}

export function setActiveChatId(chatId: string | null): void {
  activeChatId = chatId
}

export function setActiveRuntime(runtime: typeof activeRuntime): void {
  activeRuntime = runtime
}

export function setActiveThreadId(threadId: string | null): void {
  activeThreadId = threadId
}

export function setActiveContextSeeded(seeded: boolean): void {
  activeContextSeeded = seeded
}

export function setCodexClient(client: CodexClient | null): void {
  codexClient = client
}

export function setCliRuntime(runtime: CliAgentRuntime | null): void {
  cliRuntime = runtime
}

export function setApiRuntime(runtime: ApiAgentRuntime | null): void {
  apiRuntime = runtime
}

export function disconnectAgent(): void {
  if (isDisconnecting) return
  isDisconnecting = true

  try {
    currentTurnAbort?.abort()
    codexClient?.removeAllListeners()
    cliRuntime?.removeAllListeners()
    apiRuntime?.removeAllListeners()
    codexClient?.stop()
    cliRuntime?.stop()
    apiRuntime?.stop()
    mcpManager?.stopAll()
  } catch {
    // Procesos hijos pueden haber terminado ya.
  } finally {
    codexClient = null
    cliRuntime = null
    apiRuntime = null
    mcpManager = null
    activeThreadId = null
    activeChatId = null
    activeRuntime = null
    activeContextSeeded = false
    isDisconnecting = false
    currentTurnAbort = null
    for (const resolve of pendingToolApprovals.values()) resolve(false)
    pendingToolApprovals.clear()
    if (toolTrustSession) setToolTrustSession(false)
  }
}

export function resolvedWorkspace(): string {
  if (!activeWorkspace) throw new Error('No existe workspace activo.')
  return realpathSync(activeWorkspace)
}

export function defaultChatWorkspace(): string {
  const workspace = path.join(getAppDataSubdir('workspaces'), 'general-chat-workspace')
  mkdirSync(workspace, { recursive: true })
  return realpathSync(workspace)
}

export function assertInsideWorkspace(candidate: string): string {
  const workspace = resolvedWorkspace()
  const target = realpathSync(candidate)
  const relative = path.relative(workspace, target)
  const isInside = relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
  if (!isInside) throw new Error('Acceso fuera del workspace rechazado.')
  return target
}

export function wireCodex(client: CodexClient): void {
  client.on('raw', message => sendAgentEvent({ kind: 'raw', message }))
  client.on('notification', message => sendAgentEvent({ kind: 'notification', ...message }))
  client.on('serverRequest', message => sendAgentEvent({ kind: 'serverRequest', ...message }))
  client.on('log', message => sendAgentEvent({ kind: 'log', ...message }))
  client.on('exit', message => sendAgentEvent({ kind: 'exit', ...message }))
}

export function wireCli(runtime: CliAgentRuntime): void {
  runtime.on('log', message => sendAgentEvent({ kind: 'log', ...message }))
}

export function wireApi(runtime: ApiAgentRuntime): void {
  runtime.on('log', message => sendAgentEvent({ kind: 'log', ...message }))
  runtime.on('toolStatus', message => sendAgentEvent({
    kind: 'notification',
    method: 'item/toolCall/status',
    params: message
  }))
  runtime.on('usage', message => sendAgentEvent({
    kind: 'notification',
    method: 'item/usage/update',
    params: message
  }))
}

export function buildRuntimeContext(payload: {
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
}): RuntimeContextEnvelope {
  const workspace = resolvedWorkspace()
  // Una sola lectura para summary + memoria estructurada (Fase 6) — mismo
  // registro de chat_sessions, no dos queries separadas.
  const summaryState = payload.chatId ? getChatSummaryState(payload.chatId) : null
  // AGENTS.md (Fase 7): codex-subscription/codex-api comparten CodexClient,
  // que lee AGENTS.md nativo del cwd — confirmado empiricamente (Tarea 0:
  // `codex exec` con una instruccion distintiva en AGENTS.md la siguio sin
  // inyeccion manual). Inyectarselo tambien duplicaria la instruccion — el
  // resto de los runtimes (claude-cli, gemini-cli, y los 3 API) NO lo leen
  // solos, asi que a esos si les llega el contenido crudo aca.
  const needsAgentsMdInjection = payload.model.runtime !== 'codex-subscription' && payload.model.runtime !== 'codex-api'
  const agentsMd = needsAgentsMdInjection ? getCachedAgentsMd(workspace)?.content : undefined
  return {
    workspace,
    providerName: payload.provider.name,
    modelName: payload.model.displayName || payload.model.model,
    compactSummary: summaryState?.summary,
    decisions: summaryState?.decisions,
    constraints: summaryState?.constraints,
    nextSteps: summaryState?.nextSteps,
    agentsMd,
    history: normalizeHistory(payload.history),
    current: { role: 'user', text: payload.text },
    attachments: payload.attachments
  }
}
