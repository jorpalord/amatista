export type ProviderType =
  | 'openai-codex'
  | 'foundry'
  | 'openai'
  | 'anthropic'
  | 'google'
  | 'openai-compatible'
  /** Fase 15: agregador HTTP directo (OpenRouter, o cualquier backend
   *  Chat-Completions-compatible via endpoint editable) — NO pasa por
   *  Codex como 'openai'/'openai-compatible' (ver comentario ahi mismo en
   *  App.tsx: esos dos ignoran provider.endpoint por completo, spawnean
   *  codex-cli real). Este tiene su propio runtime HTTP, ver
   *  api-agent-runtime.ts → ApiAgentKind 'openai-chat'. */
  | 'openrouter'

export type AuthMode = 'subscription' | 'api-key'

export type RuntimeKind =
  | 'codex-subscription'
  | 'codex-api'
  | 'foundry'
  | 'anthropic-api'
  | 'claude-cli'
  | 'gemini-cli'
  /** Fase 15: runtime HTTP directo para type:'openrouter' — Chat
   *  Completions estilo OpenAI, distinto de los otros 3 runtimes HTTP
   *  (Responses API de Foundry, Messages API de Anthropic, API nativa de
   *  Gemini). 'openai-chat', no 'openai-api': ese nombre se descarto a
   *  proposito por ser demasiado parecido a 'codex-api' (runtime:'codex-api'
   *  es CLI/JSON-RPC via codex-client.ts, mecanismo totalmente distinto —
   *  riesgo real de confundirlos). Ver ApiAgentKind en api-agent-runtime.ts. */
  | 'openai-chat'

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

/** Un tema de memoria estructurada (Fase 6, agrupado por tema desde Fase
 *  11): sus propias decisiones tecnicas/de producto ya tomadas,
 *  restricciones o reglas a seguir respetando, y tareas pendientes —
 *  listas textuales, no resumidas, fusionadas por el modelo de
 *  compactacion en cada pasada. Ver chat-store.ts (StructuredMemory =
 *  Record<nombreDeTema, MemoryTopic>) y compaction-engine.ts. */
export interface MemoryTopic {
  decisions: string[]
  constraints: string[]
  nextSteps: string[]
}

export interface RuntimeContextEnvelope {
  workspace: string
  providerName: string
  modelName: string
  compactSummary?: string
  /** Extraccion estructurada acumulativa de la compactacion (Fase 6),
   *  agrupada por nombre de tema desde Fase 11 — clave = nombre del tema,
   *  valor = sus listas. undefined = todavia no se compacto nada para
   *  este chat. */
  topics?: Record<string, MemoryTopic>
  /** Contenido crudo de AGENTS.md del workspace (Fase 7, agents-md.ts) —
   *  solo poblado para runtimes que NO lo leen nativamente (confirmado
   *  empiricamente: claude-cli no lo lee; codex-subscription/codex-api SI,
   *  no se inyecta ahi para no duplicar). undefined = no aplica o no
   *  existe el archivo. */
  agentsMd?: string
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
  /** Techo de tokens de SALIDA por llamada (max_tokens / max_output_tokens /
   *  maxOutputTokens segun el proveedor). Sin setear (default, la mayoria de
   *  los modelos hoy), cada runtime API usa el techo documentado mas
   *  generoso del proveedor en vez de un numero chico "seguro" — ver
   *  resolveMaxOutputTokens() en api-agent-runtime.ts. Configurable para
   *  deployments cuyo techo real sea menor al default generoso (rechazan la
   *  llamada si se les pide mas de lo que soportan). */
  maxOutputTokens?: number
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
  /** Fix de seguridad/UX: false = este proveedor NO puede usar
   *  authMode:'subscription' (estructuralmente no tiene una sesion CLI
   *  detras — ej. DeepSeek, o Claude con endpoint custom/Azure), el
   *  selector de Autenticacion en App.tsx no debe ofrecer esa opcion.
   *  undefined = permitido (default, compatibilidad hacia atras con
   *  conexiones "Claude Pro"/"Gemini Advanced" ya guardadas en
   *  settings.json de antes de este campo). Nunca true explicito — la
   *  ausencia YA significa permitido. */
  allowSubscription?: boolean
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
  /** Modelo dedicado para compactar memoria en segundo plano (Fase 3, ver
   *  docs/_arch/CONTRACT.md → "Contrato de memoria/contexto" v2). Si
   *  cualquiera de los dos falta, o el modelo no es apto para llamada de
   *  una sola vuelta (ver isApiCapableModel en shared/model-capabilities.ts),
   *  la compactacion cae al modelo activo del turno en curso. */
  compactionProviderId?: string
  compactionModelId?: string
  /** Fase 14: segundos sin NINGUNA señal de actividad (ni texto ni
   *  tool-call) antes de que el watchdog de turno de App.tsx corte el
   *  turno solo — antes fijo en código (TURN_WATCHDOG_MS = 90000).
   *  undefined, 0, negativo o no numérico = usar el default (90s), tanto
   *  al guardar en la UI como al leer en App.tsx — nunca debe quedar en
   *  un estado que dispare casi instantáneo. */
  turnWatchdogSeconds?: number
}
