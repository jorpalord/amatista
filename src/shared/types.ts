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
  /** Integracion de Antigravity CLI (docs/_arch/verify_antigravity_cli.md,
   *  verify_antigravity_integration.md): producto de Google DISTINTO de
   *  'google' (Gemini CLI/API) a proposito -- reusar 'google' hubiera
   *  significado distinguir Gemini-suscripcion de Antigravity-suscripcion
   *  por algun otro campo (mismo tipo de ambiguedad que ya causo un fix
   *  real para DeepSeek reusando 'anthropic', ver isDeepSeekProvider() en
   *  App.tsx) -- un type nuevo evita ese problema de raiz en vez de
   *  reintroducirlo. */
  | 'antigravity'

export type AuthMode = 'subscription' | 'api-key'

export type RuntimeKind =
  | 'codex-subscription'
  | 'codex-api'
  | 'foundry'
  | 'anthropic-api'
  | 'claude-cli'
  /** Gemini (Google) -- retiro de gemini-cli (docs/_arch/
   *  verify_gemini_cli_removal_scope.md, verify_gemini_cli_removal.md):
   *  gemini-cli standalone quedo discontinuado para cuentas individuales
   *  (IneligibleTierError real, confirmado, Google redirige a Antigravity),
   *  asi que este literal renombrado de 'gemini-cli' -> 'gemini-api' YA NO
   *  cubre ningun subproceso CLI -- solo el camino HTTP directo
   *  (authMode:'api-key'), coincidiendo a proposito con ApiAgentKind
   *  'gemini-api' (api-agent-runtime.ts), mismo criterio que ya seguian
   *  'foundry'/'anthropic-api'/'openai-chat' (comparten literal entre los
   *  dos tipos cuando el RuntimeKind se resuelve 100% por ApiAgentRuntime).
   *  Ver isApiCapableModel() en shared/model-capabilities.ts -- el
   *  disambiguador real es provider.authMode, no este string. */
  | 'gemini-api'
  /** Antigravity CLI (agy) -- confirmado real (verify_antigravity_cli.md,
   *  Tarea 2) que NO lee AGENTS.md nativo, mismo comportamiento que
   *  claude-cli -- ver RuntimeContextEnvelope.agentsMd mas abajo. */
  | 'antigravity-cli'
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
  /** Feature "arbol de sub-chats": id del chat de origen si este chat nacio
   *  de "Agregar panel" sobre otro. undefined = raiz (chat normal, o padre
   *  borrado -- ver comentario en chat-store.ts db()). */
  parentChatId?: string
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
  /** Feature "generacion de imagenes": presente y en 'generated' SOLO si
   *  este adjunto salio de la tool generate_image (image-generation.ts),
   *  no de un archivo/portapapeles que el usuario subio a mano. undefined
   *  = subido por el usuario (default, compatibilidad hacia atras con
   *  todo adjunto ya persistido). Puramente informativo/visual
   *  (AttachmentCard, App.tsx) -- mismo espiritu que CrossWindowMeta.direction
   *  mas abajo, ningun otro codigo depende de este valor. */
  origin?: 'generated'
}

/** Mensajeria entre ventanas, Paso 3, Tarea 4: distincion visual de un
 *  mensaje que llego via la tool send_to_window (cross-window-messaging.ts),
 *  no de un turno normal de ESTA ventana. `direction` distingue el caso
 *  concreto que esta fase produce ('received', el resultado que vuelve a
 *  la ventana de origen -- ver deliverResultToOriginWindow()) de un
 *  'sent' reservado para uso futuro (no se genera en ningun punto de esta
 *  fase; documentado, no un descuido). `windowLabel` es el TITULO del chat
 *  destino que respondio (el mismo string que el usuario/modelo paso como
 *  "destino" a la tool), para que el mensaje diga de donde vino sin tener
 *  que resolver ids. `providerType` (opcional, no el ProviderProfile
 *  completo -- ese proveedor puede ya no existir para cuando esto se
 *  renderiza) alcanza para pintar el color de marca real (PROVIDER_BRAND,
 *  App.tsx) sin persistir mas de lo necesario; caveat documentado: no
 *  distingue el caso especial DeepSeek (mismo type:'anthropic' que Claude,
 *  se distingue por endpoint, no disponible aca) -- un mensaje cross-window
 *  de una conexion DeepSeek se pinta con el color de Anthropic. */
export interface CrossWindowMeta {
  direction: 'sent' | 'received'
  windowLabel: string
  providerType?: ProviderType
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
  /** Mensajeria entre ventanas, Paso 3: presente solo si este mensaje llego
   *  via send_to_window -- ver CrossWindowMeta arriba. */
  crossWindow?: CrossWindowMeta
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
   *  empiricamente: codex-subscription/codex-api SI lo leen nativo, no se
   *  inyecta ahi para no duplicar; claude-cli/antigravity-cli NO lo leen,
   *  se les sigue inyectando explicito; el resto de los runtimes tampoco).
   *  undefined = no aplica o no existe el archivo. */
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
  /** Feature "generacion de imagenes": mismo patron exacto que
   *  compactionProviderId/compactionModelId de arriba -- logica PARALELA,
   *  no compartida (resolveConfiguredImageGenerationModel(), nuevo en
   *  image-generation.ts, nunca reusa resolveConfiguredCompactionModel()).
   *  Si cualquiera de los dos falta, o el modelo elegido ya no es valido,
   *  generate_image devuelve un error claro -- salvo que NINGUNO de los 2
   *  este seteado (el usuario nunca eligio nada explicito), en cuyo caso
   *  se sugiere un modelo implicito si alguno matchea isLikelyImageModel()
   *  (shared/model-capabilities.ts) entre los habilitados. Cualquier
   *  eleccion explicita del usuario gana siempre sobre esa sugerencia. */
  imageGenerationProviderId?: string
  imageGenerationModelId?: string
}
