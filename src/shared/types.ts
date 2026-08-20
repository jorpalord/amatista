export type ProviderType =
  | 'openai-codex'
  | 'foundry'
  | 'openai'
  | 'anthropic'
  | 'google'
  | 'openai-compatible'

export type AuthMode = 'subscription' | 'api-key'

export type RuntimeKind =
  | 'codex-subscription'
  | 'codex-api'
  | 'foundry'
  | 'anthropic-api'
  | 'claude-cli'
  | 'gemini-cli'

export type SandboxMode =
  | 'read-only'
  | 'workspace-write'
  | 'danger-full-access'

export type ConversationRole = 'user' | 'assistant' | 'system'

export interface ConversationMessage {
  role: ConversationRole
  text: string
}

export interface StoredChatSession {
  id: string
  title: string
  workspacePath?: string
  workspaceName?: string
  createdAt: string
  updatedAt: string
  providerId?: string
  modelId?: string
  runtime?: string
}

export interface ChatAttachment {
  id: string
  name: string
  path: string
  mimeType: string
  size: number
  kind: 'image' | 'text' | 'file'
  preview?: string
  text?: string
}

export interface StoredChatMessage {
  id: string
  chatId: string
  role: ConversationRole
  text: string
  createdAt: string
  providerId?: string
  modelId?: string
  runtime?: string
  attachments?: ChatAttachment[]
  /** Resumen de pasos de tool-calling que produjeron este mensaje (solo
   *  asistente). Se muestra colapsado junto al mensaje una vez persistido. */
  toolSteps?: string[]
}

export interface ChatDatabaseSnapshot {
  sessions: StoredChatSession[]
  messages: Record<string, StoredChatMessage[]>
}

export interface RuntimeContextEnvelope {
  workspace: string
  providerName: string
  modelName: string
  compactSummary?: string
  history: ConversationMessage[]
  current: ConversationMessage
  attachments?: ChatAttachment[]
}

export interface ToolApprovalRequest {
  id: string
  title: string
  detail: string
}

export interface CliStatus {
  installed: boolean
  version?: string
  authenticated?: boolean
  detail?: string
}

export interface ModelProfile {
  id: string
  providerId: string
  displayName: string
  model: string
  runtime: RuntimeKind
  enabled: boolean
  capabilities: {
    tools: boolean
    reasoning: boolean
    vision: boolean
    web: boolean
  }
  reasoningLevels?: Array<'low' | 'medium' | 'high'>
}

export interface ProviderProfile {
  id: string
  name: string
  type: ProviderType
  authMode: AuthMode
  endpoint?: string
  apiKey?: string
  enabled: boolean
  models: ModelProfile[]
}

export interface ProjectRoot {
  id: string
  name: string
  path: string
}

export interface ProjectEntry {
  id: string
  name: string
  path: string
  rootId: string
}

export interface AppSettings {
  providers: ProviderProfile[]
  projectRoots: ProjectRoot[]
  activeProviderId?: string
  activeModelId?: string
  activeProjectPath?: string
}
