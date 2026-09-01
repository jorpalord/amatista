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

/**
 * Fase Paneles-1: wrapper que devuelve las funciones relacionadas a UNA
 * sesion/panel, con `panelId` ya inyectado en cada invoke y ya usado para
 * filtrar cada evento entrante ANTES de invocar el callback del panel --
 * evita que los 58 call sites de App.tsx (Paneles-2 en adelante) tengan
 * que agregar `panelId` a mano en cada payload (estructuralmente imposible
 * olvidarlo) y de paso resuelve el dispatcher de eventos sin necesitar una
 * tabla de ruteo separada del lado renderer: cada panel se suscribe con su
 * propio listener ya pre-filtrado (N paneles x M canales = N*M
 * `ipcRenderer.on()`, costo irrelevante para 1-4 paneles).
 *
 * Mismo mecanismo que ya prueba `onAgentEvent`/etc. de mas abajo: una
 * funcion puede devolver otra funcion/objeto a traves del context bridge
 * sin problema (confirmado en produccion, no solo supuesto).
 */
function forPanel(panelId: string) {
  function filteredListener<T>(channel: string, callback: (data: T) => void) {
    const listener = (_event: IpcRendererEvent, data: T) => {
      if ((data as { panelId?: string } | null)?.panelId === panelId) callback(data)
    }
    ipcRenderer.on(channel, listener)
    return () => ipcRenderer.removeListener(channel, listener)
  }

  return {
    disconnectAgent: () =>
      ipcRenderer.invoke('agent:disconnect', { panelId }),

    connectAgent: (payload: {
      providerId: string
      modelId: string
      workspace?: string
      chatId?: string
      sandbox: SandboxMode
    }) =>
      ipcRenderer.invoke('agent:connect', { ...payload, panelId }),

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
      ipcRenderer.invoke('agent:send', { ...payload, panelId }),

    cancelAgent: (): Promise<{ success: boolean; cancelled: boolean }> =>
      ipcRenderer.invoke('agent:cancel', { panelId }),

    replyToAgent: (requestId: number | string, result: unknown) =>
      ipcRenderer.invoke('agent:reply', { panelId, requestId, result }),

    onAgentEvent: (callback: (event: unknown) => void) =>
      filteredListener('agent:event', callback),

    // Mensajeria entre ventanas, Paso 2: mensaje que llego a ESTE panel
    // desde el turno de OTRO panel (cross-window-messaging.ts, canal
    // 'chat:incomingMessage', deliberadamente separado de agent:event --
    // ver justificacion en ese archivo).
    onIncomingMessage: (callback: (message: unknown) => void) =>
      filteredListener('chat:incomingMessage', callback),

    onToolApprovalRequest: (callback: (request: ToolApprovalRequest) => void) =>
      filteredListener('agent:toolApproval', callback),

    respondToolApproval: (id: string, approved: boolean, trust?: boolean): Promise<{ success: boolean }> =>
      ipcRenderer.invoke('agent:toolApproval:respond', { panelId, id, approved, trust }),

    onToolTrustChanged: (callback: (state: { active: boolean }) => void) =>
      filteredListener('agent:toolTrust', callback),

    disableToolTrust: (): Promise<{ success: boolean }> =>
      ipcRenderer.invoke('agent:toolTrust:disable', { panelId }),

    openWorkspace: (workspacePath: string) =>
      ipcRenderer.invoke('workspace:open', { panelId, workspacePath }),

    refreshWorkspace: () =>
      ipcRenderer.invoke('workspace:refresh', { panelId }),

    readFile: (filePath: string) =>
      ipcRenderer.invoke('workspace:readFile', { panelId, filePath }),

    saveFile: (filePath: string, content: string) =>
      ipcRenderer.invoke('workspace:saveFile', { panelId, path: filePath, content }),

    getAgentsMdStatus: (): Promise<{ exists: boolean; lineCount: number; oversized: boolean }> =>
      ipcRenderer.invoke('agentsMd:status', { panelId }),

    openOrCreateAgentsMd: (): Promise<{ success: boolean; created: boolean }> =>
      ipcRenderer.invoke('agentsMd:openOrCreate', { panelId }),

    getMcpStatus: (): Promise<{ exists: boolean; serverCount: number }> =>
      ipcRenderer.invoke('mcp:status', { panelId }),

    openOrCreateMcpConfig: (): Promise<{ success: boolean; created: boolean }> =>
      ipcRenderer.invoke('mcp:openOrCreate', { panelId })
  }
}

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
    parentChatId?: string
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

  /** Fase Paneles-3: evento dirigido al SHELL (App()), no a un panel
   *  puntual -- a proposito NO vive dentro de forPanel(): pedirle a la app
   *  que ABRA un panel no tiene ningun panelId existente que filtrar
   *  (confirmado en la investigacion, ver docs/_arch/verify_panels_scope.md
   *  Paneles-3 Tarea 2). Mismo patron de listener que onFullscreenChanged
   *  de arriba -- un solo listener real, App() esta siempre montado. */
  onPanelOpenAndConnectRequest: (callback: (payload: { requestId: string; chatId: string }) => void) => {
    const listener = (_event: IpcRendererEvent, data: { requestId: string; chatId: string }) => callback(data)
    ipcRenderer.on('panel:openAndConnectRequest', listener)
    return () => ipcRenderer.removeListener('panel:openAndConnectRequest', listener)
  },

  /** Fase Paneles-3: respuesta real del handshake de 2 pasos (abrir +
   *  conectar) -- ver handlePanelOpenAndConnectRequest() en App.tsx. */
  respondPanelOpenAndConnect: (result: { requestId: string; success: boolean; panelId?: string; error?: string }): Promise<{ success: boolean }> =>
    ipcRenderer.invoke('panel:openAndConnectResponse', result),

  // Fase Paneles-1: unica forma de llegar a las funciones de sesion -- ver
  // forPanel() arriba.
  forPanel
}

contextBridge.exposeInMainWorld('universalAgent', api)
