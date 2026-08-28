import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron'
import type {
  AppSettings,
  ChatAttachment,
  ChatDatabaseSnapshot,
  ConversationMessage,
  ConversationRole,
  SandboxMode,
  StoredChatMessage,
  StoredChatSession,
  ToolApprovalRequest
} from '../shared/types'

const api = {
  getSettings: (): Promise<AppSettings> =>
    ipcRenderer.invoke('settings:get'),

  saveSettings: (settings: AppSettings) =>
    ipcRenderer.invoke('settings:save', settings),

  resetLocalState: (): Promise<AppSettings> =>
    ipcRenderer.invoke('settings:resetLocalState'),

  importQConfig: () =>
    ipcRenderer.invoke('settings:importQConfig'),

  loadChats: (): Promise<ChatDatabaseSnapshot> =>
    ipcRenderer.invoke('chats:load'),

  ensureChatSession: (payload: {
    id: string
    title: string
    workspacePath?: string
    workspaceName?: string
    providerId?: string
    modelId?: string
    runtime?: string
  }): Promise<StoredChatSession> =>
    ipcRenderer.invoke('chats:ensureSession', payload),

  renameChatSession: (chatId: string, title: string): Promise<{ success: boolean }> =>
    ipcRenderer.invoke('chats:renameSession', { chatId, title }),

  deleteChatSession: (chatId: string): Promise<{ success: boolean }> =>
    ipcRenderer.invoke('chats:deleteSession', chatId),

  saveChatMessage: (payload: {
    id: string
    chatId: string
    role: ConversationRole
    text: string
    attachments?: ChatAttachment[]
    providerId?: string
    modelId?: string
    runtime?: string
    toolSteps?: string[]
  }): Promise<StoredChatMessage> =>
    ipcRenderer.invoke('chats:saveMessage', payload),

  deleteChatMessagesFrom: (chatId: string, fromMessageId: string): Promise<{ success: boolean }> =>
    ipcRenderer.invoke('chats:deleteMessagesFrom', { chatId, fromMessageId }),

  getFullscreen: (): Promise<boolean> =>
    ipcRenderer.invoke('window:getFullscreen'),

  setFullscreen: (value: boolean): Promise<boolean> =>
    ipcRenderer.invoke('window:setFullscreen', value),

  onFullscreenChanged: (callback: (value: boolean) => void) => {
    const listener = (_event: IpcRendererEvent, value: boolean) => callback(value)
    ipcRenderer.on('window:fullscreenChanged', listener)
    return () => ipcRenderer.removeListener('window:fullscreenChanged', listener)
  },

  // Fase 22a, Tarea 2: abre una BrowserWindow real nueva, mostrando el chat
  // indicado (o el default de esa ventana nueva si se omite).
  openInNewWindow: (chatId: string | null): Promise<{ windowId: number }> =>
    ipcRenderer.invoke('window:openInNewWindow', chatId),

  // Mensajeria entre ventanas, Paso 1: avisa a main cual es el chat activo
  // REAL de esta ventana cada vez que cambia -- mantiene WindowEntry.chatId
  // (Fase 22a) actualizado en vivo, dejaba de ser codigo muerto.
  setActiveChatId: (chatId: string | null): Promise<{ success: boolean }> =>
    ipcRenderer.invoke('window:setActiveChatId', chatId),

  getCliStatus: () =>
    ipcRenderer.invoke('cli:status'),

  installGeminiCli: () =>
    ipcRenderer.invoke('cli:installGemini'),

  installClaudeCli: () =>
    ipcRenderer.invoke('cli:installClaude'),

  openCliLogin: (providerType: string) =>
    ipcRenderer.invoke('auth:openCliLogin', providerType),

  readCodexAccount: () =>
    ipcRenderer.invoke('codex:accountRead'),

  loginCodexAccount: () =>
    ipcRenderer.invoke('codex:login'),

  logoutCodexAccount: () =>
    ipcRenderer.invoke('codex:logout'),

  listCodexModels: () =>
    ipcRenderer.invoke('codex:modelList'),

  listOpenAiChatModels: (endpoint: string, apiKey: string) =>
    ipcRenderer.invoke('openaiChat:listModels', { endpoint, apiKey }),

  addProjectRoot: () =>
    ipcRenderer.invoke('projects:addRoot'),

  removeProjectRoot: (rootId: string) =>
    ipcRenderer.invoke('projects:removeRoot', rootId),

  listProjects: () =>
    ipcRenderer.invoke('projects:list'),

  getDefaultWorkspace: (): Promise<{ path: string; name: string }> =>
    ipcRenderer.invoke('workspace:default'),

  openWorkspace: (workspacePath: string) =>
    ipcRenderer.invoke('workspace:open', workspacePath),

  refreshWorkspace: () =>
    ipcRenderer.invoke('workspace:refresh'),

  readFile: (filePath: string) =>
    ipcRenderer.invoke('workspace:readFile', filePath),

  saveFile: (filePath: string, content: string) =>
    ipcRenderer.invoke('workspace:saveFile', { path: filePath, content }),

  pickAttachments: (): Promise<ChatAttachment[]> =>
    ipcRenderer.invoke('attachments:pick'),

  attachmentsFromPaths: (filePaths: string[]): Promise<ChatAttachment[]> =>
    ipcRenderer.invoke('attachments:fromPaths', filePaths),

  attachmentFromDataUrl: (payload: { name: string; dataUrl: string }): Promise<ChatAttachment> =>
    ipcRenderer.invoke('attachments:fromDataUrl', payload),

  previewImagePath: (filePath: string): Promise<string> =>
    ipcRenderer.invoke('attachments:previewImagePath', filePath),

  filePathForDroppedFile: (file: File): string =>
    webUtils.getPathForFile(file),

  disconnectAgent: () =>
    ipcRenderer.invoke('agent:disconnect'),

  connectAgent: (payload: {
    providerId: string
    modelId: string
    workspace?: string
    chatId?: string
    sandbox: SandboxMode
  }) =>
    ipcRenderer.invoke('agent:connect', payload),

  getAgentsMdStatus: (): Promise<{ exists: boolean; lineCount: number; oversized: boolean }> =>
    ipcRenderer.invoke('agentsMd:status'),

  openOrCreateAgentsMd: (): Promise<{ success: boolean; created: boolean }> =>
    ipcRenderer.invoke('agentsMd:openOrCreate'),

  getMcpStatus: (): Promise<{ exists: boolean; serverCount: number }> =>
    ipcRenderer.invoke('mcp:status'),

  openOrCreateMcpConfig: (): Promise<{ success: boolean; created: boolean }> =>
    ipcRenderer.invoke('mcp:openOrCreate'),

  sendMessage: (payload: {
    text: string
    chatId?: string
    attachments?: ChatAttachment[]
    history: ConversationMessage[]
    modelId: string
    providerId: string
    sandbox: SandboxMode
    /** Fase 13: nivel de esfuerzo/razonamiento, SOLO claude-cli/codex-* —
     *  undefined = no mandar ningun flag/campo, usar el default del
     *  runtime. String libre (no un union type acotado): claude-cli usa 5
     *  niveles fijos del CLI, codex usa el catalogo real sincronizado por
     *  modelo — cada runtime ignora el campo si no le corresponde. */
    effort?: string
  }) =>
    ipcRenderer.invoke('agent:send', payload),

  cancelAgent: (): Promise<{ success: boolean; cancelled: boolean }> =>
    ipcRenderer.invoke('agent:cancel'),

  replyToAgent: (requestId: number | string, result: unknown) =>
    ipcRenderer.invoke('agent:reply', { requestId, result }),

  onAgentEvent: (callback: (event: unknown) => void) => {
    const listener = (_event: IpcRendererEvent, data: unknown) => callback(data)
    ipcRenderer.on('agent:event', listener)
    return () => ipcRenderer.removeListener('agent:event', listener)
  },

  onToolApprovalRequest: (callback: (request: ToolApprovalRequest) => void) => {
    const listener = (_event: IpcRendererEvent, data: ToolApprovalRequest) => callback(data)
    ipcRenderer.on('agent:toolApproval', listener)
    return () => ipcRenderer.removeListener('agent:toolApproval', listener)
  },

  respondToolApproval: (id: string, approved: boolean, trust?: boolean): Promise<{ success: boolean }> =>
    ipcRenderer.invoke('agent:toolApproval:respond', { id, approved, trust }),

  onToolTrustChanged: (callback: (state: { active: boolean }) => void) => {
    const listener = (_event: IpcRendererEvent, data: { active: boolean }) => callback(data)
    ipcRenderer.on('agent:toolTrust', listener)
    return () => ipcRenderer.removeListener('agent:toolTrust', listener)
  },

  disableToolTrust: (): Promise<{ success: boolean }> =>
    ipcRenderer.invoke('agent:toolTrust:disable')
}

contextBridge.exposeInMainWorld('universalAgent', api)
