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
  openInNewWindow(chatId: string | null): Promise<{ windowId: number }>
  setActiveChatId(chatId: string | null): Promise<{ success: boolean }>
  onIncomingMessage(callback: (message: unknown) => void): () => void

  installGeminiCli(): Promise<{
    success: boolean
    stdout?: string
    stderr?: string
    status?: CliStatus
  }>

  getCliStatus(): Promise<{
    codex: CliStatus
    gemini: CliStatus
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

  openWorkspace(workspacePath: string): Promise<{
    path: string
    tree: unknown[]
  }>

  refreshWorkspace(): Promise<unknown[]>
  readFile(filePath: string): Promise<string>
  saveFile(filePath: string, content: string): Promise<{ success: boolean }>
  pickAttachments(): Promise<ChatAttachment[]>
  attachmentsFromPaths(filePaths: string[]): Promise<ChatAttachment[]>
  attachmentFromDataUrl(payload: { name: string; dataUrl: string }): Promise<ChatAttachment>
  previewImagePath(filePath: string): Promise<string>
  filePathForDroppedFile(file: File): string

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

  getAgentsMdStatus(): Promise<{ exists: boolean; lineCount: number; oversized: boolean }>
  openOrCreateAgentsMd(): Promise<{ success: boolean; created: boolean }>

  getMcpStatus(): Promise<{ exists: boolean; serverCount: number }>
  openOrCreateMcpConfig(): Promise<{ success: boolean; created: boolean }>

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

  onToolApprovalRequest(callback: (request: ToolApprovalRequest) => void): () => void
  respondToolApproval(id: string, approved: boolean, trust?: boolean): Promise<{ success: boolean }>
  onToolTrustChanged(callback: (state: { active: boolean }) => void): () => void
  disableToolTrust(): Promise<{ success: boolean }>
}

declare global {
  interface Window {
    universalAgent: UniversalAgentApi
  }
}
