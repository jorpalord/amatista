import type {
  AppSettings,
  ChatAttachment,
  ChatDatabaseSnapshot,
  CliStatus,
  ConversationMessage,
  ConversationRole,
  ProjectEntry,
  ProjectRoot,
  SandboxMode,
  StoredChatMessage,
  StoredChatSession,
  ToolApprovalRequest
} from '../shared/types'

export {}

/**
 * Fase Paneles-1: funciones relacionadas a UNA sesion/panel -- panelId
 * (crypto.randomUUID(), generado por el renderer al crear el panel) ya
 * viaja inyectado en cada invoke/embebido en cada evento filtrado, nunca
 * expuesto en la firma de estos metodos (lo agrega forPanel() del lado
 * preload). Antes de esta fase, esta identidad se resolvia gratis via
 * event.sender (BrowserWindow.fromWebContents) -- dejo de servir porque
 * todos los paneles de una ventana comparten el mismo webContents/canal
 * IPC (ver docs/_arch/verify_panels_scope.md).
 */
interface PanelApi {
  /** panelClosing:true SOLO desde closePanel() (App.tsx) -- señal real de
   *  que este panel nunca va a volver a usar su sesion, para que main pueda
   *  limpiar sessionRegistry (docs/_arch/verify_sessionregistry_leak_2026.md).
   *  Sin el campo (los otros 4 disparadores reales de disconnect()), main
   *  se comporta exactamente igual que hoy. */
  disconnectAgent(panelClosing?: boolean): Promise<{ success: boolean }>

  connectAgent(payload: {
    providerId: string
    modelId: string
    workspace?: string
    chatId?: string
    sandbox: SandboxMode
  }): Promise<{
    connected: boolean
    runtime: string
    workspace: string
    workspaceIsDefault: boolean
    /** Aviso (Fase 7, Tarea 3) si AGENTS.md del workspace supera el umbral
     *  de lineas recomendado — nunca implica que se truncó, solo sugiere
     *  acortarlo. undefined = no existe AGENTS.md o esta dentro del umbral. */
    agentsMdWarning?: string
  }>

  sendMessage(payload: {
    text: string
    chatId?: string
    attachments?: ChatAttachment[]
    history: ConversationMessage[]
    modelId: string
    providerId: string
    sandbox: SandboxMode
    effort?: string
  }): Promise<unknown>

  cancelAgent(): Promise<{ success: boolean; cancelled: boolean }>

  replyToAgent(
    requestId: number | string,
    result: unknown
  ): Promise<{ success: boolean }>

  onAgentEvent(callback: (event: unknown) => void): () => void

  /** Mensajeria entre ventanas, Paso 2: mensaje que llego a ESTE panel desde
   *  el turno de OTRO panel (chat:incomingMessage). Filtrado por panelId
   *  del lado preload -- el callback solo se invoca para eventos de ESTE
   *  panel. */
  onIncomingMessage(callback: (message: unknown) => void): () => void

  onToolApprovalRequest(callback: (request: ToolApprovalRequest) => void): () => void
  respondToolApproval(id: string, approved: boolean, trust?: boolean): Promise<{ success: boolean }>
  onToolTrustChanged(callback: (state: { active: boolean }) => void): () => void
  disableToolTrust(): Promise<{ success: boolean }>

  /** "Modo plan" (docs/_arch/verify_plan_mode_design.md) -- mismo patron
   *  exacto que onToolTrustChanged/disableToolTrust de arriba. */
  enablePlanMode(enforced: boolean): Promise<{ success: boolean; error?: string }>
  disablePlanMode(): Promise<{ success: boolean }>
  onPlanModeChanged(callback: (state: { active: boolean; enforced: boolean }) => void): () => void
  setComputerUseActive(active: boolean): Promise<{ success: boolean }>
  onComputerUseChanged(callback: (state: { active: boolean }) => void): () => void

  openWorkspace(workspacePath: string): Promise<{
    path: string
    tree: unknown[]
  }>
  refreshWorkspace(): Promise<unknown[]>
  readFile(filePath: string): Promise<string>
  saveFile(filePath: string, content: string): Promise<{ success: boolean }>

  getAgentsMdStatus(): Promise<{ exists: boolean; lineCount: number; oversized: boolean }>
  openOrCreateAgentsMd(): Promise<{ success: boolean; created: boolean }>

  getMcpStatus(): Promise<{ exists: boolean; serverCount: number }>
  openOrCreateMcpConfig(): Promise<{ success: boolean; created: boolean }>

  /** Feature "Configurar MarkItDown" (docs/_arch/verify_markitdown_config_button_design.md):
   *  escribe la entrada real de MarkItDown (Docker) en .mcp.json del
   *  workspace activo (Claude Code CLI) y ~/.codex/config.toml (Codex,
   *  global) -- fusion real, preserva cualquier config existente en
   *  ambos. Corta sin escribir nada si Docker no esta en PATH. */
  configureMarkitdown(): Promise<{ success: boolean; message: string }>
}

interface UniversalAgentApi {
  getSettings(): Promise<AppSettings>
  saveSettings(settings: AppSettings): Promise<{ success: boolean }>
  resetLocalState(): Promise<AppSettings>

  loadChats(): Promise<ChatDatabaseSnapshot>
  ensureChatSession(payload: {
    id: string
    title: string
    workspacePath?: string
    workspaceName?: string
    providerId?: string
    modelId?: string
    runtime?: string
    parentChatId?: string
    personaText?: string
  }): Promise<StoredChatSession>
  renameChatSession(chatId: string, title: string): Promise<{ success: boolean }>
  deleteChatSession(chatId: string): Promise<{ success: boolean }>
  saveChatMessage(payload: {
    id: string
    chatId: string
    role: ConversationRole
    text: string
    attachments?: ChatAttachment[]
    providerId?: string
    modelId?: string
    runtime?: string
    toolSteps?: string[]
  }): Promise<StoredChatMessage>

  deleteChatMessagesFrom(chatId: string, fromMessageId: string): Promise<{ success: boolean }>

  getFullscreen(): Promise<boolean>
  setFullscreen(value: boolean): Promise<boolean>
  onFullscreenChanged(callback: (value: boolean) => void): () => void

  installClaudeCli(): Promise<{
    success: boolean
    stdout?: string
    stderr?: string
    status?: CliStatus
  }>

  installAntigravityCli(): Promise<{
    success: boolean
    stdout?: string
    stderr?: string
    status?: CliStatus
  }>

  getCliStatus(): Promise<{
    codex: CliStatus
    claude: CliStatus
    antigravity: CliStatus
  }>

  openCliLogin(providerType: string): Promise<{ started: boolean }>

  readCodexAccount(): Promise<unknown>

  loginCodexAccount(): Promise<{
    loginId?: string
    authUrl?: string
    type?: string
  }>

  logoutCodexAccount(): Promise<{ success: boolean }>

  listCodexModels(): Promise<Array<{
    id: string
    displayName: string
    supportedReasoningEfforts: string[]
    raw: unknown
  }>>

  /** Boton "Actualizar modelos" (docs/_arch/verify_model_refresh_design.md)
   *  -- `existingModelValues` son los `model.model` (no id) que la conexion
   *  YA tiene, para que el proceso main no gaste turnos reales verificando
   *  algo que el usuario ya tiene agregado. Devuelve SOLO candidatos nuevos
   *  ya confirmados reales -- el merge "solo agregar" lo hace el renderer. */
  refreshClaudeModels(existingModelValues: string[]): Promise<Array<{ displayName: string; model: string }>>
  refreshAntigravityModels(existingModelValues: string[]): Promise<Array<{ displayName: string; model: string }>>

  listOpenAiChatModels(endpoint: string, apiKey: string): Promise<Array<{
    id: string
    displayName: string
    contextLength?: number
    maxOutputTokens?: number
    supportsTools: boolean
    supportsVision: boolean
  }>>

  /** Catalogo real de deployments de Foundry -- GET <endpoint>/models real
   *  (api-key header, no Bearer) contra la superficie v1 de Azure OpenAI/
   *  AI Foundry. Ver foundry-catalog.ts. */
  listFoundryModels(endpoint: string, apiKey: string): Promise<Array<{ id: string; displayName: string }>>

  /** Catalogo real de modelos de Google/Gemini -- GET /v1beta/models real
   *  (header x-goog-api-key, ni api-key generico ni Bearer), filtrado por
   *  supportedGenerationMethods + verificacion real por candidato
   *  (generateContent minimo, tri-estado real por status -- 200=confirmed,
   *  404 exacto=unavailable/retirado, cualquier otro no-200
   *  (429/503/500/403/400/timeout/red)=inconclusive con reintento acotado,
   *  Hallazgo 5 de la 4ta revision externa). Ver gemini-catalog.ts. */
  listGeminiModels(apiKey: string): Promise<{
    confirmed: Array<{ id: string; displayName: string }>
    unavailableCount: number
    inconclusive: Array<{ id: string; displayName: string; status?: number }>
  }>

  addProjectRoot(): Promise<ProjectRoot | null>
  removeProjectRoot(rootId: string): Promise<AppSettings>
  listProjects(): Promise<ProjectEntry[]>

  getDefaultWorkspace(): Promise<{ path: string; name: string }>

  pickAttachments(): Promise<ChatAttachment[]>
  attachmentsFromPaths(filePaths: string[]): Promise<ChatAttachment[]>
  attachmentFromDataUrl(payload: { name: string; dataUrl: string }): Promise<ChatAttachment>
  previewImagePath(filePath: string): Promise<string>
  filePathForDroppedFile(file: File): string

  /** Fase Paneles-3: evento dirigido al SHELL (App()), no a un panel
   *  puntual -- ver el mismo comentario en preload/index.ts. */
  onPanelOpenAndConnectRequest(callback: (payload: { requestId: string; chatId: string }) => void): () => void
  respondPanelOpenAndConnect(result: { requestId: string; success: boolean; panelId?: string; error?: string }): Promise<{ success: boolean }>

  /** Fase Paneles-1: unica forma de llegar a las funciones de sesion --
   *  panelId lo genera el renderer (crypto.randomUUID()) al crear cada
   *  panel, una vez, y se reusa para todas sus llamadas. */
  forPanel(panelId: string): PanelApi
}

declare global {
  interface Window {
    universalAgent: UniversalAgentApi
  }
}
