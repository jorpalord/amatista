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
import { LspManager } from './lsp-manager'
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

/** Fase 22a — registro real de ventanas, reemplaza el mainWindow singular
 *  que existia antes (una sola BrowserWindow, pisada por setMainWindow()
 *  cada vez que se llamaba). Indexado por BrowserWindow.id (el id numerico
 *  que Electron ya asigna solo, nunca inventado aca). `chatId` es SOLO un
 *  dato asociado a la ventana (que chat esta mostrando al arrancar/ultimo
 *  que se le pidio mostrar) -- todavia NO implica que la conexion de
 *  runtime este aislada por ventana, eso es Fase 22b. Limpieza automatica
 *  via window.on('closed', ...), armada en registerWindow() mismo -- ningun
 *  caller necesita acordarse de desregistrar a mano. */
export interface WindowEntry {
  window: BrowserWindow
  chatId: string | null
}
export const windowRegistry = new Map<number, WindowEntry>()
const WINDOW_ROUTING_DEBUG = process.env.AMATISTA_DEBUG_TOOLS === '1'

export function registerWindow(window: BrowserWindow, chatId: string | null = null): void {
  windowRegistry.set(window.id, { window, chatId })
  console.log(`[window-registry] ventana ${window.id} registrada (chatId inicial: ${chatId ?? 'ninguno'}) -- total abiertas: ${windowRegistry.size}`)
  window.on('closed', () => {
    windowRegistry.delete(window.id)
    console.log(`[window-registry] ventana ${window.id} cerrada y desregistrada -- quedan ${windowRegistry.size}`)
  })
}

export function setWindowChatId(windowId: number, chatId: string | null): void {
  const entry = windowRegistry.get(windowId)
  if (entry) entry.chatId = chatId
}

function isWindowUsable(window: BrowserWindow): boolean {
  return !window.isDestroyed() && Boolean(window.webContents) && !window.webContents.isDestroyed()
}

/** Fase 22a — id de la BrowserWindow que origino la conexion de runtime
 *  ACTUAL (capturada via event.sender en agent:connect, ver ipc-agent.ts).
 *  Con una sola conexion compartida por toda la app (eso sigue sin
 *  resolverse -- Fase 22b), este es hoy el unico dato de "a quien le
 *  pertenece" que existe: sendToRenderer()/sendAgentEvent() lo usan como
 *  destino por default para no volver a mandar todo a todas las ventanas
 *  como antes. 22b es quien lo va a usar para empezar a RECHAZAR (no solo
 *  rutear) agent:send/agent:cancel que no vengan de esta ventana -- aca
 *  todavia no se rechaza nada, es solo el dato guardado. */
export let activeConnectionWindowId: number | null = null
export function setActiveConnectionWindowId(id: number | null): void {
  activeConnectionWindowId = id
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
/** Fase 20 — LSP (diagnosticos TypeScript en vivo) de la conexion actual,
 *  SOLO runtimes API (foundry/anthropic-api/gemini-api/openai-chat): son
 *  los unicos que pasan por ToolRegistry.execute()/write_file/apply_patch.
 *  claude-cli/codex-subscription/codex-api editan con sus propias tools
 *  nativas, nunca tocan este manager -- limitacion de alcance conocida,
 *  mismo patron que Fase 17 Parte 1 (vision) documento para su propio
 *  alcance inicial. Mismo ciclo de vida que mcpManager: se crea en
 *  agent:connect, se para en disconnectAgent() -- pero a diferencia de
 *  mcpManager (que arranca sus servidores de una), el language server real
 *  NUNCA se levanta aca: arranque perezoso, recien en el primer touch real
 *  de un .ts/.tsx (ver LspManager.notifyFileWritten()). */
export let lspManager: LspManager | null = null
export function setLspManager(manager: LspManager | null): void {
  lspManager = manager
}
export let activeRuntime: 'codex' | 'claude' | 'gemini' | 'foundry' | 'gemini-api' | 'anthropic-api' | 'openai-chat' | null = null
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

/** Manda `channel`/`payload` a UNA ventana puntual del registro. Devuelve
 *  false (sin lanzar) si esa ventana no existe o ya no es usable -- el
 *  caller decide que hacer con eso (ver sendToRenderer, que cae a broadcast). */
export function sendToWindow(windowId: number, channel: string, payload: unknown): boolean {
  const entry = windowRegistry.get(windowId)
  if (!entry || !isWindowUsable(entry.window)) return false
  try {
    entry.window.webContents.send(channel, payload)
    return true
  } catch {
    return false
  }
}

/** Manda `channel`/`payload` a TODAS las ventanas usables del registro.
 *  Fallback de esta fase para cuando no se sabe a cual ventana puntual
 *  corresponde un evento -- documentado como temporal en runtime-state.ts
 *  (ver activeConnectionWindowId): 22b es quien va a poder acotar esto a
 *  "la ventana dueña de esta conexion" con certeza, no con un default. */
export function broadcastToAllWindows(channel: string, payload: unknown): void {
  for (const entry of windowRegistry.values()) {
    if (!isWindowUsable(entry.window)) continue
    try {
      entry.window.webContents.send(channel, payload)
    } catch {
      // La ventana pudo destruirse entre el filtro de arriba y el envio.
    }
  }
}

/** Fase 22a: antes mandaba siempre a la mainWindow singular. Ahora, sin
 *  windowId explicito, cae a activeConnectionWindowId (la ventana que
 *  origino agent:connect, ver ipc-agent.ts) si esa ventana sigue abierta
 *  -- y si no hay ninguna conexion conocida (o su ventana ya cerro), cae a
 *  mandarle a TODAS las ventanas abiertas, mismo criterio "mejor de mas
 *  que de menos" que tenia el comportamiento viejo de facto (con una sola
 *  ventana, "todas" y "la unica" eran lo mismo). */
export function sendToRenderer(channel: string, payload: unknown, windowId?: number): void {
  const targetId = windowId ?? activeConnectionWindowId
  if (targetId !== null && sendToWindow(targetId, channel, payload)) {
    if (WINDOW_ROUTING_DEBUG) console.log(`[window-registry] "${channel}" -> ventana ${targetId} (dirigido)`)
    return
  }
  if (WINDOW_ROUTING_DEBUG) console.log(`[window-registry] "${channel}" -> broadcast a ${windowRegistry.size} ventana(s) (sin destino conocido/valido)`)
  broadcastToAllWindows(channel, payload)
}

export function sendAgentEvent(payload: Record<string, unknown>, windowId?: number): void {
  sendToRenderer('agent:event', {
    workspace: activeWorkspace,
    chatId: activeChatId,
    ...payload
  }, windowId)
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
    lspManager?.stopAll()
  } catch {
    // Procesos hijos pueden haber terminado ya.
  } finally {
    codexClient = null
    cliRuntime = null
    apiRuntime = null
    mcpManager = null
    lspManager = null
    activeThreadId = null
    activeChatId = null
    activeRuntime = null
    activeContextSeeded = false
    isDisconnecting = false
    currentTurnAbort = null
    // Fase 22a: la conexion que se acaba de matar ya no tiene dueño --
    // agent:connect vuelve a settear esto DESPUES de este disconnectAgent()
    // inicial suyo (ver ipc-agent.ts), asi que una reconexion normal no se
    // ve afectada por este reset.
    activeConnectionWindowId = null
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
    topics: summaryState?.topics,
    agentsMd,
    history: normalizeHistory(payload.history),
    current: { role: 'user', text: payload.text },
    attachments: payload.attachments
  }
}
