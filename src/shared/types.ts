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

/**
 * Tool "todo_write" (docs/_arch/verify_todo_write_design.md): un item de la
 * lista de tareas del propio modelo -- patron externo convergente (Claude
 * Code/Qwen Code/GitLab Duo, confirmado real): reemplazo TOTAL de la lista
 * en cada llamada, nunca un parche incremental. `id` opcional -- el modelo
 * puede mandarlo para correlacionar la MISMA tarea entre llamadas
 * sucesivas, pero no es una clave real de ningun lado (no hay ningun
 * lookup por id en el codigo, ver chat-store.ts). Ver TodoList mas abajo.
 */
export interface TodoItem {
  id?: string
  content: string
  status: 'pending' | 'in_progress' | 'completed'
  priority?: 'high' | 'medium' | 'low'
}

export type TodoList = TodoItem[]

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
  /** Tool "todo_write": ultima lista persistida para este chat (chat_sessions.todos,
   *  chat-store.ts) -- reemplazo total, mismo criterio que `topics`.
   *  undefined/[] = el modelo nunca llamo todo_write en este chat, no se
   *  renderiza nada (ver context-envelope.ts). */
  todos?: TodoList
  /** Presets simples (docs/_arch/verify_simple_presets_design.md): texto de
   *  persona/instruccion fijado UNA vez al crear el chat (chat_sessions.persona_text,
   *  nunca actualizado despues) -- distinto de compactSummary/topics/todos
   *  (estado DINAMICO, releido cada turno): esto es identidad estatica del
   *  chat, mismo criterio de "cacheado, pero igual re-renderizado cada
   *  turno" que agentsMd. undefined = chat sin preset aplicado, sin cambio
   *  de comportamiento. */
  personaText?: string
  /** Sistema de skills (docs/_arch/verify_skills_design.md): catalogo
   *  NIVEL 1 (solo nombre+descripcion, nunca el cuerpo completo -- eso es
   *  nivel 2, via la tool load_skill) -- mismo criterio de "2 puntos de
   *  render" que todos/personaText/modo plan. undefined/[] = ninguna
   *  skill real configurada (ni global ni de workspace), sin bloque nuevo. */
  skills?: SkillCatalogEntry[]
  /** "Modo plan" (docs/_arch/verify_plan_mode_design.md): true = la sesion
   *  esta en modo plan ahora mismo -- se inyecta un bloque de guia pidiendo
   *  explorar/disenar antes de ejecutar (formatContextEnvelope()/
   *  memoryBlockText(), mismo criterio de "2 puntos de render" ya
   *  confirmado con la tool todo_write). undefined/false = sin bloque,
   *  sin cambio de comportamiento. */
  planModeActive?: boolean
  /** Solo relevante si planModeActive -- true = la variante REFORZADA esta
   *  activa (sandbox real forzado a read-only mientras dura el plan), para
   *  que el texto de guia pueda ser honesto sobre si escribir archivos
   *  ahora mismo esta tecnicamente bloqueado o no. */
  planModeEnforced?: boolean
  history: ConversationMessage[]
  current: ConversationMessage
  attachments?: ChatAttachment[]
}

export interface ToolApprovalRequest {
  id: string
  title: string
  detail: string
  /**
   * Tools de sistema Windows (docs/_arch/verify_windows_control_design.md):
   * `false` SOLO para las 3 guardias monotonas (close_app/lock_screen/
   * power, via requestHardToolApproval() en runtime-state.ts) -- el
   * renderer oculta el checkbox de "confiar" cuando esto es `false`, para
   * que aprobar UNA de estas 3 nunca pueda dejar las FUTURAS saltandose el
   * dialogo (ver App.tsx, visibleToolApproval.allowTrust). `true` para
   * todo el resto de aprobaciones existentes -- cero cambio de
   * comportamiento previo.
   */
  allowTrust: boolean
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
  /** Investigacion real durante una prueba en vivo del usuario: MAX_TOOL_LOOP
   *  (api-agent-runtime.ts) era un const de modulo fijo en 60, sin ningun
   *  campo real en Settings -- solo configurable via la env var
   *  AMATISTA_MAX_TOOL_LOOP, disenada para el harness del benchmark, nunca
   *  expuesta a un usuario con la app instalada. Mismo patron exacto que
   *  turnWatchdogSeconds arriba (mismo guard de validez, mismo criterio
   *  "undefined/0/negativo/no numerico = usar el default"). El default (60,
   *  o AMATISTA_MAX_TOOL_LOOP si esta seteada) sigue intacto cuando este
   *  campo no esta seteado -- ApiAgentRuntime lee
   *  this.config.maxToolLoop ?? MAX_TOOL_LOOP en cada turno, nunca cachea
   *  el valor de settings en un const de modulo (evita el mismo bug ya
   *  corregido para TURN_WATCHDOG_MS congelado). */
  maxToolLoop?: number
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
  /** Feature "busqueda web" (web_search/web_fetch via Tavily,
   *  docs/_arch/verify_web_search_design.md): NO es un provider de modelo
   *  -- Tavily no tiene ningun LLM, no encaja en `providers[]`. Seccion
   *  nueva y separada a proposito, mismo mecanismo real de cifrado
   *  (encryptSecret/decryptSecret, settings-store.ts) que ya usa
   *  provider.apiKey, aplicado a un campo que no es de un provider.
   *  undefined/vacio = las 2 tools ni aparecen en el catalogo (gating real,
   *  ver ApiAgentRuntime.toolCatalog()) -- nunca se le ofrece al modelo una
   *  tool que de todos modos fallaria sin credencial. */
  integrations?: {
    tavily?: {
      apiKey?: string
    }
  }
  /** Presets simples (docs/_arch/verify_simple_presets_design.md): sin
   *  credenciales, sin composicion dinamica de plugins ni filtrado de
   *  tools -- solo nombre + texto de persona/instruccion + provider/modelo
   *  preferido opcional, aplicados UNA vez al crear un chat nuevo (nunca se
   *  re-aplican despues). Mismo criterio de array plano que providers[]/
   *  projectRoots[], sin ningun campo a cifrar (no toca settings-store.ts
   *  mas alla de pasar el campo tal cual). */
  presets?: Preset[]
  /**
   * Familia A (computer use, docs/_arch/verify_computer_use_security_model.md,
   * Tarea 1): true DESPUES de que el usuario confirmo explicitamente la
   * advertencia dura de Configuracion al menos una vez -- SOLO controla si
   * el toggle de Capa 1 (activacion por sesion, `computerUseActive` en
   * runtime-state.ts) aparece en el composer. NUNCA implica que el
   * control este activo ahora mismo -- eso es estado de sesion efimero,
   * nunca persistido (mismo criterio que toolTrustSession/sandbox), reseteado
   * a apagado en cada conexion nueva sin excepcion.
   */
  computerUseAcknowledged?: boolean
}

/** Un preset simple -- ver AppSettings.presets. `providerId`/`modelId`
 *  opcionales: un preset puede ser solo persona, sin preferencia de
 *  modelo (el chat nuevo cae al fallback global de siempre). */
export interface Preset {
  id: string
  name: string
  personaText: string
  providerId?: string
  modelId?: string
}

/** Sistema de skills (docs/_arch/verify_skills_design.md): entrada del
 *  catalogo NIVEL 1 -- solo lo minimo para que el modelo decida si le
 *  conviene pedir el cuerpo completo via load_skill(name). El cuerpo en si
 *  (nivel 2) vive solo en skill-manager.ts (main), nunca en este tipo
 *  compartido -- el renderer no necesita verlo. */
export interface SkillCatalogEntry {
  name: string
  description: string
}
