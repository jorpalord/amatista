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
  disconnectAgent(): Promise<{ success: boolean }>

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
}

interface UniversalAgentApi {
  getSettings(): Promise<AppSettings>
  saveSettings(settings: AppSettings): Promise<{ success: boolean }>
  resetLocalState(): Promise<AppSettings>
  importQConfig(): Promise<{
    canceled: boolean
    settings: AppSettings
    summary: string[]
  }>

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

  installGeminiCli(): Promise<{
    success: boolean
    stdout?: string
    stderr?: string
    status?: CliStatus
  }>

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
    gemini: CliStatus
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

  listOpenAiChatModels(endpoint: string, apiKey: string): Promise<Array<{
    id: string
    displayName: string
    contextLength?: number
    maxOutputTokens?: number
    supportsTools: boolean
    supportsVision: boolean
  }>>

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
