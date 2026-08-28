// Estado mutable compartido del proceso main + funciones que operan sobre el
// (conexion de runtime activa, workspace activo, puente hacia el renderer).
// Se saca de index.ts porque ipc-agent.ts, ipc-workspace.ts e ipc-settings.ts
// necesitan leer/mutar las mismas variables.
//
// Fase 22b: el estado de conexion (antes 9+ variables `let` a nivel de
// modulo, una sola instancia compartida por TODA la app) pasa a vivir en
// `sessionRegistry`, un Map indexado por BrowserWindow.id -- la misma clave
// que ya usa `windowRegistry` de Fase 22a, no un id nuevo inventado. Cada
// ventana tiene su propia conexion de runtime real, independiente de las
// demas. `settings` (AppSettings) y `toolRegistry` siguen siendo globales
// A PROPOSITO -- son config/herramientas compartidas por la app entera, no
// estado de una conexion puntual (ver docs/_arch/verify_fase22_scope.md,
// Fase 22 Tarea 0, Parte B).
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
 *  que se le pidio mostrar) -- no es lo mismo que `sessionRegistry` de abajo
 *  (esa es la conexion de runtime real; esta es solo la ventana en si).
 *  Limpieza automatica via window.on('closed', ...), armada en
 *  registerWindow() mismo -- ningun caller necesita acordarse de
 *  desregistrar a mano. */
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
  if (!entry) return
  entry.chatId = chatId
  console.log(`[window-registry] ventana ${windowId} -> chatId actualizado a "${chatId ?? 'ninguno'}"`)
}

function isWindowUsable(window: BrowserWindow): boolean {
  return !window.isDestroyed() && Boolean(window.webContents) && !window.webContents.isDestroyed()
}

/** Manda `channel`/`payload` a UNA ventana puntual del registro. Devuelve
 *  false (sin lanzar) si esa ventana no existe o ya no es usable. */
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
 *  Usado solo para eventos que genuinamente no pertenecen a una sesion
 *  puntual (hoy: ninguno de los conexion/turno -- ver sendSessionEvent()
 *  mas abajo, que ya sabe siempre a que ventana dirigirse). */
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

export function sendToRenderer(channel: string, payload: unknown, windowId?: number): void {
  if (windowId !== undefined && sendToWindow(windowId, channel, payload)) {
    if (WINDOW_ROUTING_DEBUG) console.log(`[window-registry] "${channel}" -> ventana ${windowId} (dirigido)`)
    return
  }
  if (WINDOW_ROUTING_DEBUG) console.log(`[window-registry] "${channel}" -> broadcast a ${windowRegistry.size} ventana(s)`)
  broadcastToAllWindows(channel, payload)
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
  activeRuntime: 'codex' | 'gemini' | 'foundry' | 'gemini-api' | 'anthropic-api' | 'openai-chat' | null
  activeWorkspace: string | null
  activeThreadId: string | null
  activeChatId: string | null
  activeContextSeeded: boolean
  /** Turno actualmente en vuelo en ESTA sesion (si hay uno). */
  currentTurnAbort: AbortController | null
  isDisconnecting: boolean
  toolTrustSession: boolean
  pendingToolApprovals: Map<string, (approved: boolean) => void>
}

function createEmptySession(): SessionRuntimeState {
  return {
    codexClient: null,
    cliRuntime: null,
    apiRuntime: null,
    mcpManager: null,
    lspManager: null,
    provider: null,
    model: null,
    activeRuntime: null,
    activeWorkspace: null,
    activeThreadId: null,
    activeChatId: null,
    activeContextSeeded: false,
    currentTurnAbort: null,
    isDisconnecting: false,
    toolTrustSession: false,
    pendingToolApprovals: new Map()
  }
}

/** Un `SessionRuntimeState` por BrowserWindow.id -- misma clave que
 *  `windowRegistry`, pero un Map DISTINTO a proposito: `windowRegistry`
 *  vive mientras la ventana existe (aunque nunca haya conectado ningun
 *  agente); `sessionRegistry` solo tiene entrada para ventanas que
 *  llamaron getSession() al menos una vez (tipicamente al conectar). No
 *  se limpia automaticamente al cerrar la ventana en esta fase -- ver
 *  PENDING.md, anotado para no perder el caveat: hoy no es un leak
 *  practico (una ventana cerrada no vuelve a llamar getSession()), pero
 *  falta el `window.on('closed', ...)` explicito que si tiene
 *  windowRegistry. */
export const sessionRegistry = new Map<number, SessionRuntimeState>()

export function getSession(windowId: number): SessionRuntimeState {
  let session = sessionRegistry.get(windowId)
  if (!session) {
    session = createEmptySession()
    sessionRegistry.set(windowId, session)
  }
  return session
}

export const codexAccountBridge = new CodexAccountBridge()
export let settings: AppSettings = { providers: [], projectRoots: [] }
export function setSettings(next: AppSettings): void {
  settings = next
}

export const toolRegistry = new ToolRegistry()

/** Manda un evento de agente a la ventana dueña de esta sesion. A
 *  diferencia de sendToRenderer() (Fase 22a), windowId es OBLIGATORIO
 *  aca -- con sesiones reales por ventana, quien llama a esto siempre
 *  sabe de que sesion es el evento (lo capturo via event.sender en
 *  agent:connect/agent:send, o lo tiene en el closure de wireApi/wireCli/
 *  wireCodex), asi que el fallback a broadcast de 22a (para cuando "no se
 *  sabia a cual ventana corresponde") ya no aplica -- era exactamente el
 *  hueco que esta fase venia a cerrar. */
export function sendSessionEvent(windowId: number, payload: Record<string, unknown>): void {
  const session = sessionRegistry.get(windowId)
  sendToWindow(windowId, 'agent:event', {
    workspace: session?.activeWorkspace ?? null,
    chatId: session?.activeChatId ?? null,
    ...payload
  })
}

export function cancelSessionTurn(windowId: number): boolean {
  const session = sessionRegistry.get(windowId)
  if (!session?.currentTurnAbort) return false
  session.currentTurnAbort.abort()
  for (const resolve of session.pendingToolApprovals.values()) resolve(false)
  session.pendingToolApprovals.clear()
  return true
}

export function setSessionToolTrust(windowId: number, active: boolean): void {
  const session = getSession(windowId)
  session.toolTrustSession = active
  sendToWindow(windowId, 'agent:toolTrust', { active })
}

export function requestSessionToolApproval(windowId: number, title: string, detail: string): Promise<boolean> {
  const session = getSession(windowId)
  if (session.toolTrustSession) return Promise.resolve(true)

  return new Promise(resolve => {
    const id = randomUUID()
    session.pendingToolApprovals.set(id, resolve)
    sendToWindow(windowId, 'agent:toolApproval', { id, title, detail })
  })
}

/** Reemplaza al disconnectAgent() singular de antes de Fase 22b -- hace
 *  exactamente lo mismo (abort del turno en vuelo, remover listeners,
 *  parar cada runtime/manager, resolver aprobaciones pendientes como
 *  rechazadas, apagar tool-trust) pero acotado a UNA sola entrada del
 *  registro, no a la app entera. */
export function disconnectSession(windowId: number): void {
  const session = sessionRegistry.get(windowId)
  if (!session || session.isDisconnecting) return
  session.isDisconnecting = true

  try {
    session.currentTurnAbort?.abort()
    session.codexClient?.removeAllListeners()
    session.cliRuntime?.removeAllListeners()
    session.apiRuntime?.removeAllListeners()
    session.codexClient?.stop()
    session.cliRuntime?.stop()
    session.apiRuntime?.stop()
    session.mcpManager?.stopAll()
    session.lspManager?.stopAll()
  } catch {
    // Procesos hijos pueden haber terminado ya.
  } finally {
    session.codexClient = null
    session.cliRuntime = null
    session.apiRuntime = null
    session.mcpManager = null
    session.lspManager = null
    session.provider = null
    session.model = null
    session.activeThreadId = null
    session.activeChatId = null
    session.activeRuntime = null
    session.activeContextSeeded = false
    session.isDisconnecting = false
    session.currentTurnAbort = null
    for (const resolve of session.pendingToolApprovals.values()) resolve(false)
    session.pendingToolApprovals.clear()
    if (session.toolTrustSession) setSessionToolTrust(windowId, false)
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
  for (const windowId of sessionRegistry.keys()) disconnectSession(windowId)
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
  const relative = path.relative(resolved, target)
  const isInside = relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
  if (!isInside) throw new Error('Acceso fuera del workspace rechazado.')
  return target
}

/** wireCodex/wireCli/wireApi (Fase 22b): capturan `windowId` en el
 *  closure de conexion (pasado por agent:connect, resuelto via
 *  event.sender) y lo usan para dirigir cada evento a esa ventana
 *  puntual -- antes mandaban a traves de sendAgentEvent()/
 *  activeConnectionWindowId (Fase 22a, singular a proposito). Ninguna de
 *  las 3 leia ninguna global directamente antes de este cambio (confirmado
 *  en la investigacion previa a esta fase) -- agregarles windowId es
 *  aditivo puro, no rompe nada de su logica interna. */
export function wireCodex(windowId: number, client: CodexClient): void {
  client.on('raw', message => sendSessionEvent(windowId, { kind: 'raw', message }))
  client.on('notification', message => sendSessionEvent(windowId, { kind: 'notification', ...message }))
  client.on('serverRequest', message => sendSessionEvent(windowId, { kind: 'serverRequest', ...message }))
  client.on('log', message => sendSessionEvent(windowId, { kind: 'log', ...message }))
  client.on('exit', message => sendSessionEvent(windowId, { kind: 'exit', ...message }))
}

export function wireCli(windowId: number, runtime: CliAgentRuntime): void {
  runtime.on('log', message => sendSessionEvent(windowId, { kind: 'log', ...message }))
}

export function wireApi(windowId: number, runtime: ApiAgentRuntime): void {
  runtime.on('log', message => sendSessionEvent(windowId, { kind: 'log', ...message }))
  runtime.on('toolStatus', message => sendSessionEvent(windowId, {
    kind: 'notification',
    method: 'item/toolCall/status',
    params: message
  }))
  runtime.on('usage', message => sendSessionEvent(windowId, {
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
}): RuntimeContextEnvelope {
  const workspace = resolvedWorkspace(payload.workspace)
  // Una sola lectura para summary + memoria estructurada (Fase 6) — mismo
  // registro de chat_sessions, no dos queries separadas.
  const summaryState = payload.chatId ? getChatSummaryState(payload.chatId) : null
  // AGENTS.md (Fase 7): codex-subscription/codex-api comparten CodexClient,
  // que lee AGENTS.md nativo del cwd — confirmado empiricamente (Tarea 0:
  // `codex exec` con una instruccion distintiva en AGENTS.md la siguio sin
  // inyeccion manual). Inyectarselo tambien duplicaria la instruccion — el
  // resto de los runtimes (gemini-cli y los 3 API) NO lo leen solos, asi
  // que a esos si les llega el contenido crudo aca.
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
