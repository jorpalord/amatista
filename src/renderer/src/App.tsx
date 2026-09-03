import { useEffect, useMemo, useRef, useState, type ClipboardEvent, type CSSProperties, type Dispatch, type SetStateAction } from 'react'
import type {
  AppSettings,
  AuthMode,
  ChatAttachment,
  CliStatus,
  ConversationMessage,
  CrossWindowMeta,
  ModelProfile,
  ProjectEntry,
  ProviderProfile,
  ProviderType,
  RuntimeKind,
  SandboxMode,
  ToolApprovalRequest
} from '../../shared/types'
import { CONTEXT_TOKEN_BUDGET } from '../../shared/context-budget'
import { isApiCapableModel, isLikelyImageModel } from '../../shared/model-capabilities'
import amatistaLogo from './assets/logoamatista.png'

interface ChatMessage {
  id: string
  role: 'user' | 'assistant' | 'system'
  text: string
  attachments?: ChatAttachment[]
  /** Resumen de pasos de tool-calling (Pieza 1) que produjeron este mensaje.
   *  Solo asistente. Se muestra colapsado junto al mensaje una vez cerrado
   *  el turno — ver turnSteps/handleAgentEvent('turn/completed'). */
  toolSteps?: string[]
  /** Mensajeria entre ventanas, Paso 3: presente solo si este mensaje llego
   *  via send_to_window (otra ventana) -- ver CrossWindowMeta. */
  crossWindow?: CrossWindowMeta
}

interface MessageImage {
  id: string
  alt: string
  source: string
}

interface ImagePreviewState {
  src: string
  title: string
}

interface ChatSession {
  id: string
  title: string
  workspacePath?: string
  workspaceName?: string
  /** Fase 21.5: ISO timestamp, mismo valor real que persiste chat-store.ts
   *  (updated_at) — usado para elegir el chat MAS RECIENTE de un
   *  workspacePath (openProject()), no una aproximacion por orden de
   *  array. Se bumpea localmente en ensureStoredChat() (llamada en cada
   *  turno) para que quede correcto durante la sesion en vivo, no solo al
   *  reiniciar la app. */
  updatedAt?: string
  /** Fase Paneles-2a: el dato YA llega desde loadChats() (chat-store.ts
   *  persiste provider_id/model_id desde Paso 3) -- antes se descartaba al
   *  mapear a este tipo local. Es la fuente real de "que modelo usa ESTE
   *  chat", el primer nivel del fallback de pickProvider()/pickModel() de
   *  mas abajo. undefined = chat nunca conectado todavia (nuevo, o migrado
   *  de una version vieja sin este dato). */
  providerId?: string
  modelId?: string
  /** Feature "arbol de sub-chats": id del chat de ORIGEN si este chat nacio
   *  de "Agregar panel" sobre otro (addPanelForChat() lo estampa una unica
   *  vez, al crear). undefined = raiz -- chat normal, o padre borrado (el
   *  huerfano se trata como raiz, ver buildChatRows() mas abajo). */
  parentChatId?: string
}

/** Mismo patron exacto que PANEL_SUFFIX_RE en chat-store.ts (proceso main,
 *  no importable desde el renderer -- procesos separados, duplicado por
 *  necesidad, no por descuido). Fuente unica de verdad ACA para todo lo
 *  que en App.tsx necesita reconocer el sufijo " — Panel N" que
 *  generateUniquePanelTitle() graba en el titulo. */
const PANEL_SUFFIX_RE = /\s—\s*Panel\s+(\d+)\s*$/i

/** Feature "arbol de sub-chats" (docs/_arch/verify_subchat_tree.md): extrae
 *  el numero de "Panel N" del sufijo que generateUniquePanelTitle() ya
 *  graba en el titulo -- unico criterio de orden entre hermanos (PRINCIPAL
 *  nunca tiene este sufijo asi que nunca puede ser "hijo de si mismo").
 *  1 = sin sufijo (no deberia ocurrir para un hijo real, pero deja un
 *  fallback razonable si algun dia se crea uno a mano sin ese nombre). */
function panelSortNumber(title: string): number {
  const match = title.match(PANEL_SUFFIX_RE)
  return match ? Number(match[1]) : 1
}

/** Feature "arbol de sub-chats": aplana chatSessions en el orden real de
 *  render del sidebar -- cada RAIZ (sin parentChatId, o cuyo parentChatId
 *  ya no existe en la lista -- padre borrado) mantiene el orden que ya
 *  trae chatSessions (updated_at DESC real, sin tocar), seguida
 *  inmediatamente de sus hijos reales (parentChatId === chat.id),
 *  ordenados entre si por panelSortNumber(). depth=0 para las raices,
 *  depth>=1 para sus descendientes -- addPanelForChat() siempre usa el
 *  chat de ORIGEN tal cual esta hoy (nunca fuerza que sea una raiz), asi
 *  que un hijo podria en teoria tener sus propios hijos; la recursion de
 *  abajo lo soporta igual, aunque el uso real hoy es de 1 solo nivel. */
function buildChatRows(sessions: ChatSession[]): Array<{ chat: ChatSession; depth: number }> {
  const byId = new Map(sessions.map(chat => [chat.id, chat]))
  const childrenByParent = new Map<string, ChatSession[]>()
  const roots: ChatSession[] = []
  for (const chat of sessions) {
    const parent = chat.parentChatId ? byId.get(chat.parentChatId) : undefined
    if (parent) {
      const siblings = childrenByParent.get(parent.id) ?? []
      siblings.push(chat)
      childrenByParent.set(parent.id, siblings)
    } else {
      roots.push(chat)
    }
  }
  for (const siblings of childrenByParent.values()) {
    siblings.sort((a, b) => panelSortNumber(a.title) - panelSortNumber(b.title))
  }
  const rows: Array<{ chat: ChatSession; depth: number }> = []
  function pushWithChildren(chat: ChatSession, depth: number): void {
    rows.push({ chat, depth })
    for (const child of childrenByParent.get(chat.id) ?? []) {
      pushWithChildren(child, depth + 1)
    }
  }
  for (const root of roots) pushWithChildren(root, 0)
  return rows
}

function toChatMessage(message: {
  id: string
  role: 'user' | 'assistant' | 'system'
  text: string
  attachments?: ChatAttachment[]
  toolSteps?: string[]
  crossWindow?: CrossWindowMeta
}): ChatMessage {
  return {
    id: message.id,
    role: message.role,
    text: message.text,
    attachments: message.attachments,
    toolSteps: message.toolSteps,
    crossWindow: message.crossWindow
  }
}

/**
 * Fase Paneles-2b: los casos 'message'/'composer' dejaron de cargar solo
 * datos (messageId/role) -- ahora llevan las closures YA armadas por el
 * <ChatPanel> que pidio el menu (onCopy/onEdit/onRegenerate,
 * onCut/onCopy/onPaste/onSelectAll). Motivo: estas acciones (editar un
 * mensaje, cortar/pegar del composer) viven DENTRO de cada panel
 * (startEditMessage()/regenerateFrom()/cutComposerText()/etc, todas
 * dependen de estado propio del panel) pero el menu en si se renderiza UNA
 * sola vez a nivel de App() (mismo patron ya establecido para
 * imagePreview) -- pasar las funciones ya resueltas evita que App()
 * necesite volver a buscar el mensaje/chat activo de un panel que ya no
 * conoce por dentro. El caso 'chat' (disparado desde el sidebar, siempre
 * shell) sigue siendo solo datos -- App() ya tiene todo lo que necesita
 * para Renombrar/Agregar panel/Borrar.
 */
type ContextMenuState =
  | { type: 'chat'; chatId: string; x: number; y: number }
  | {
      type: 'message'
      x: number
      y: number
      text: string
      onCopy: () => void
      onEdit?: () => void
      onRegenerate?: () => void
    }
  | {
      type: 'composer'
      x: number
      y: number
      onCut: () => void
      onCopy: () => void
      onPaste: () => void
      onSelectAll: () => void
    }
  /** UI, Pieza 1 (menu "..." del header de panel, docs/_arch/
   *  verify_ui_sidebar_header.md Tarea 1/2/3): 4ta variante del mismo
   *  patron discriminado ya existente -- .mcp.json y Eventos (los 2
   *  controles de menor frecuencia de uso real, confirmado en la
   *  investigacion) se mueven detras de este menu compartido en vez de un
   *  dropdown nuevo. Modelo/Panel/× quedan como estaban, visibles siempre. */
  | {
      type: 'panelHeader'
      x: number
      y: number
      onOpenMcpConfig: () => void
      mcpDisabled: boolean
      onToggleDebug: () => void
      eventsCount: number
    }
  | null

// Fase 3: el techo real de cuanto historial se manda verbatim en un turno
// ya no vive aca (era RUNTIME_HISTORY_LIMIT/RUNTIME_SUMMARY_TRIGGER, ambos
// en 18 por coincidencia con MAX_HISTORY_MESSAGES de context-envelope.ts —
// ver docs/_arch/CONTRACT.md → "Contrato de memoria/contexto" v2). Esa
// decision es server-side (normalizeHistory en context-envelope.ts, basada
// en CONTEXT_TOKEN_BUDGET) porque depende del watermark de compactacion,
// que solo existe en el proceso main. Este techo es SOLO un limite de
// tamano de payload IPC (evitar mandar miles de mensajes de un chat viejo
// en cada tecleo), no una decision de presupuesto de contexto.
const IPC_HISTORY_PAYLOAD_CAP = 500
const GENERAL_CHAT_ID = 'general-chat'
// Fase 22a, Tarea 2: chat que esta ventana debe mostrar al arrancar, si esta
// ventana se abrio via "Abrir en ventana nueva" (window-manager.ts la crea
// pasando ?chatId=... en la URL/archivo cargado -- funciona igual en dev,
// contra el servidor de electron-vite, y en produccion via loadFile con
// {query}, sin ninguna rama por entorno). Leido UNA vez al cargar el modulo,
// no cambia durante la vida de la ventana (recargar la pagina perderia el
// query string igual que perderia cualquier otro estado en memoria).
// Fase Paneles-1: `window:openInNewWindow` (lo unico que llegaba a setear
// este query string) ya no existe -- esto queda inerte (siempre null en la
// practica), sin tocar: retirarlo del todo es codigo muerto fuera del
// alcance pedido en esta fase.
const BOOT_CHAT_ID = new URLSearchParams(window.location.search).get('chatId')
// Fase 14: default si settings.turnWatchdogSeconds no esta configurado (o
// quedo en un valor invalido) — mismo valor que ya tenia el watchdog fijo
// en codigo, cero cambio de comportamiento para quien no toque el campo.
const TURN_WATCHDOG_DEFAULT_SECONDS = 90
/**
 * Fase 13 — niveles fijos del flag --effort de Claude Code CLI (headless
 * -p), confirmados contra el binario real (docs/_arch/CONTRACT.md). No
 * vienen de ningun catalogo sincronizado (a diferencia de Codex, que usa
 * model.reasoningLevels real) — son fijos por diseño del CLI mismo, no
 * varian por modelo/cuenta.
 */
const CLAUDE_EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const
// Fase Paneles-2b: mismo tope que ya se usa en el resto de la sesion para
// "cuantos paneles/runtimes distintos" se prueban en paralelo -- no hay
// una razon tecnica dura para 4 en vez de otro numero, es un limite de
// producto (mas de 4 conversaciones visibles a la vez deja de ser usable
// en una pantalla real).
const MAX_PANELS = 4

function generalChatSession(): ChatSession {
  return { id: GENERAL_CHAT_ID, title: 'Chat general' }
}

interface Approval {
  requestId: number | string
  method: string
  params: unknown
}

/** Fase Paneles-2b: `approval`/`toolApproval` siguen siendo estado de CADA
 *  panel (una aprobacion pendiente es de la sesion que la genero) pero se
 *  RENDERIZAN como un unico overlay compartido a nivel de App() -- mismo
 *  patron ya resuelto para `imagePreview`/`contextMenu` en la investigacion
 *  de Paneles-2. La pieza que ese patron todavia no cubria: los BOTONES del
 *  overlay necesitan poder resolver la aprobacion DE VUELTA en el panel que
 *  la origino, y `answerApproval()`/`answerToolApproval()` son funciones
 *  internas de ese panel (cierran sobre su propio `api`/`approval`). En vez
 *  de inventar un mecanismo de referencias/registro por panelId, el panel
 *  reporta hacia arriba el dato YA JUNTO a una closure que lo resuelve
 *  (`onAnswer`) -- App() no necesita saber nada de la sesion, solo llamar
 *  la funcion que el panel ya le paso. */
interface ApprovalHandle {
  approval: Approval
  onAnswer: (decision: 'accept' | 'decline' | 'acceptForSession') => void
}

interface ToolApprovalHandle {
  title: string
  detail: string
  trust: boolean
  onToggleTrust: (value: boolean) => void
  onAnswer: (approved: boolean) => void
}

/** Fase Paneles-2b, Tarea 3: confirmado en la investigacion (verify_panels_
 *  scope.md, seccion Paneles-2b) que ni chat_sessions.provider_id/model_id
 *  (mide "usado alguna vez") ni sessionRegistry de main (mide "conectado en
 *  vivo") alcanzan para responder "que paneles estan abiertos ahora mismo"
 *  -- hace falta este tipo nuevo. En memoria de App(), NO persistido (ver
 *  DECISIONES CONFIRMADAS): la app siempre arranca con 1 panel mostrando el
 *  chat mas reciente, igual que el comportamiento de siempre. */
interface PanelEntry {
  panelId: string
  chatId: string
}

/** Fase Paneles-2b: lo que un <ChatPanel> reporta hacia arriba para que el
 *  sidebar/topbar (shell) puedan mostrar "el chat activo" sin necesitar
 *  leer estado interno de un componente hijo -- React no lo permite
 *  directamente, asi que cada panel empuja un snapshot cada vez que algo
 *  relevante cambia (ver useEffect de reporte en ChatPanel). El shell lee
 *  panelStatuses[focusedPanelId] en vez de un unico activeChat/agentState
 *  global como antes de esta fase. */
interface PanelStatus {
  chatId: string
  chatTitle: string
  workspacePath?: string
  workspaceName?: string
  agentState: AgentState
  agentRuntime: string
  providerId?: string
  modelId?: string
}

interface CodexAccountView {
  connected: boolean
  email?: string
  planType?: string
  detail?: string
}

interface CodexCatalogModel {
  id: string
  displayName: string
  supportedReasoningEfforts: string[]
  raw: unknown
}

interface OpenAiChatCatalogModel {
  id: string
  displayName: string
  contextLength?: number
  maxOutputTokens?: number
  supportsTools: boolean
  supportsVision: boolean
}

type AgentState = 'idle' | 'connecting' | 'connected' | 'error'

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : {}
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function asNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

/** Fase 19: "src/App.tsx", "\"tools\" en src/main" (search_files), o el
 *  comando de run_command -- el argumento especifico que antes NO viajaba
 *  en el evento item/toolCall/status (name/phase pelado, indistinguible
 *  entre 2 llamadas seguidas a la misma tool). '' si la tool no tiene
 *  argumento relevante (list_file_history, git_status, etc.). */
function toolCallTargetLabel(params: Record<string, unknown>): string {
  const command = asString(params.command)
  if (command) return command
  const pattern = asString(params.pattern)
  const path = asString(params.path)
  if (pattern && path) return `"${pattern}" en ${path}`
  if (pattern) return `"${pattern}"`
  return path
}

/** Fase 19: "+X -Y" a partir de params.lineDiff (solo presente en
 *  write_file/apply_patch exitosos) -- '' si no aplica. */
function lineDiffLabel(params: Record<string, unknown>): string {
  const lineDiff = asRecord(params.lineDiff)
  if (lineDiff.added === undefined && lineDiff.removed === undefined) return ''
  return `+${asNumber(lineDiff.added)} -${asNumber(lineDiff.removed)}`
}


const TOOL_STEP_LABELS: Record<string, { one: string; many: string }> = {
  run_command: { one: 'ejecutó 1 comando', many: 'ejecutó {n} comandos' },
  read_file: { one: 'leyó 1 archivo', many: 'leyó {n} archivos' },
  write_file: { one: 'editó 1 archivo', many: 'editó {n} archivos' },
  list_dir: { one: 'exploró 1 carpeta', many: 'exploró {n} carpetas' },
  git_status: { one: 'consultó git status', many: 'consultó git status ({n}x)' },
  git_diff: { one: 'consultó git diff', many: 'consultó git diff ({n}x)' }
}

/** "Ejecutado 1 comando, editó 2 archivos" a partir de las lineas crudas
 *  de turnSteps (ej. "write_file completado", "run_command fallo"). */
function summarizeToolSteps(steps: string[]): string {
  if (steps.length === 0) return ''
  const counts = new Map<string, number>()
  for (const step of steps) {
    const toolName = step.split(' ')[0]
    counts.set(toolName, (counts.get(toolName) ?? 0) + 1)
  }
  const parts = Array.from(counts.entries()).map(([name, count]) => {
    const label = TOOL_STEP_LABELS[name]
    if (!label) return `${name} x${count}`
    return count === 1 ? label.one : label.many.replace('{n}', String(count))
  })
  const joined = parts.join(', ')
  return joined.charAt(0).toUpperCase() + joined.slice(1)
}

/** Resumen de un item intermedio de un turno de Codex (item/completed que
 *  NO es el mensaje final) para el log de pasos (Pieza 1) — mismo rol que
 *  las lineas "write_file completado" que ya genera apiRuntime. */
function summarizeCodexItem(itemType: string, item: Record<string, unknown>, fallbackText: string): string {
  if (itemType === 'agentMessage') {
    const trimmed = fallbackText.trim()
    return trimmed ? trimmed.slice(0, 140) : 'Mensaje del agente'
  }
  const command = asString(item.command) || asString(item.cmd)
  if (command) return `Ejecutó: ${command}`.slice(0, 160)
  // Fase 19 (Tarea 0, confirmado en vivo contra el transporte real de
  // codex app-server): el item.type real de escritura/edicion de archivos
  // es "fileChange", con la ruta en item.changes[].path -- NUNCA en
  // item.path/item.file (lo que este codigo chequeaba antes de este fix,
  // sin verificar, y nunca matcheaba). kind.type solo confirmado en vivo
  // para 'add'; 'modify'/'delete' se etiquetan por el nombre que Codex les
  // da, sin inventar un verbo para un kind no verificado.
  if (itemType === 'fileChange') {
    const changes = Array.isArray(item.changes) ? item.changes : []
    const paths = changes.map(change => asString(asRecord(change).path)).filter(Boolean)
    if (paths.length > 0) {
      const firstKind = asString(asRecord(asRecord(changes[0]).kind).type)
      const verb = firstKind === 'add' ? 'Creando' : firstKind === 'delete' ? 'Borrando' : firstKind === 'modify' ? 'Editando' : 'Modificando'
      return `${verb}: ${paths.join(', ')}`
    }
  }
  const path = asString(item.path) || asString(item.file)
  if (path) return `${itemType || 'Item'}: ${path}`
  return `${itemType || 'Item'} completado`
}

function extractText(value: unknown): string {
  if (typeof value === 'string') return value

  if (Array.isArray(value)) {
    return value
      .map(extractText)
      .filter(Boolean)
      .join('')
  }

  const record = asRecord(value)

  const direct =
    asString(record.delta) ||
    asString(record.text) ||
    asString(record.content) ||
    asString(record.message) ||
    asString(record.output_text) ||
    asString(record.final_output) ||
    asString(record.response)

  if (direct) return direct

  const nestedKeys = [
    'item',
    'turn',
    'result',
    'output',
    'params',
    'content',
    'message'
  ]

  for (const key of nestedKeys) {
    const nested = record[key]
    if (nested) {
      const text = extractText(nested)
      if (text) return text
    }
  }

  return ''
}

function extractAssistantText(value: unknown): string {
  if (typeof value === 'string') return value

  if (itemIsUserMessage(value)) return ''

  if (Array.isArray(value)) {
    return value
      .map(extractAssistantText)
      .filter(Boolean)
      .join('\n')
  }

  const record = asRecord(value)
  const type = asString(record.type)
  const role = asString(record.role)

  if (
    type === 'agentMessage' ||
    role === 'assistant' ||
    type === 'assistant'
  ) {
    const text =
      asString(record.text) ||
      asString(record.delta) ||
      asString(record.content) ||
      asString(record.message) ||
      extractText(record.content)

    if (text) return text
  }

  if (record.item) {
    const text = extractAssistantText(record.item)
    if (text) return text
  }

  if (record.items) {
    const text = extractAssistantText(record.items)
    if (text) return text
  }

  if (record.turn) {
    const text = extractAssistantText(record.turn)
    if (text) return text
  }

  if (record.result) {
    const text = extractAssistantText(record.result)
    if (text) return text
  }

  if (record.output) {
    const text = extractAssistantText(record.output)
    if (text) return text
  }

  return ''
}



function eventMethod(raw: unknown): string {
  const event = asRecord(raw)
  return asString(event.method) || asString(event.type) || asString(event.kind)
}


function itemIsUserMessage(value: unknown): boolean {
  const record = asRecord(value)
  const item = asRecord(record.item ?? value)
  const type = asString(item.type)
  const role = asString(item.role)
  return type === 'userMessage' || role === 'user'
}

function extractCodexError(value: unknown): string {
  const record = asRecord(value)
  const error = asRecord(record.error)
  const turn = asRecord(record.turn)
  const turnError = asRecord(turn.error)
  const nestedError = asRecord(asRecord(record.params).error)

  return (
    asString(error.message) ||
    asString(turnError.message) ||
    asString(nestedError.message) ||
    asString(record.message)
  )
}

function runtimeFor(type: ProviderType, authMode: AuthMode): RuntimeKind {
  if (type === 'openai-codex' && authMode === 'subscription') return 'codex-subscription'
  if (type === 'foundry') return 'foundry'
  if (type === 'openai' || type === 'openai-compatible') return 'codex-api'
  // Reintegracion de claude-cli: 'anthropic' vuelve a ramificarse por
  // authMode -- 'api-key' es HTTP directo (anthropic-api), 'subscription'
  // spawnea Claude Code CLI real (claude-cli).
  if (type === 'anthropic') return authMode === 'api-key' ? 'anthropic-api' : 'claude-cli'
  // Integracion de Antigravity CLI: siempre 'antigravity-cli' sin ramificar
  // por authMode -- suscripcion y API key spawnean el mismo binario `agy`,
  // la diferencia real vive en buildEnv() (cli-agent-runtime.ts), no en el
  // runtime elegido. Mismo criterio ya aplicado en settings-store.ts.
  if (type === 'antigravity') return 'antigravity-cli'
  // Fase 15: OpenRouter (o cualquier backend Chat-Completions-compatible)
  // — siempre api-key, nunca hay concepto de suscripcion/CLI para esto.
  if (type === 'openrouter') return 'openai-chat'
  // Retiro de gemini-cli (docs/_arch/verify_gemini_cli_removal_scope.md,
  // verify_gemini_cli_removal.md): mismo renombre que runtimeFor() de
  // settings-store.ts -- 'google' ya no ramifica por authMode aca tampoco,
  // el subproceso CLI de Gemini se retiro completo.
  return 'gemini-api'
}

function providerName(type: ProviderType): string {
  switch (type) {
    case 'openai-codex': return 'Codex ChatGPT (suscripcion)'
    case 'foundry': return 'Microsoft Foundry API'
    case 'openai': return 'OpenAI API'
    case 'anthropic': return 'Claude Pro (suscripcion)'
    case 'google': return 'Gemini Advanced (suscripcion Google)'
    case 'antigravity': return 'Antigravity (suscripcion Google)'
    case 'openai-compatible': return 'API compatible'
    case 'openrouter': return 'OpenRouter'
  }
}

/**
 * Fase 21: unica fuente de verdad para el endpoint fijo de DeepSeek (Fase
 * 14) — antes era un string literal duplicado (newDeepSeekProvider() lo
 * escribia, providerDisplayName()/providerSubtitle() lo detectaban por
 * substring sobre provider.name/endpoint concatenados). Ahora se compara
 * por IGUALDAD contra este endpoint exacto, un chequeo directo, no una
 * heuristica de texto — DeepSeek es estructuralmente un provider
 * type:'anthropic' con ESTE endpoint puntual (reusa sendAnthropicApi()
 * completo, ver newDeepSeekProvider() mas abajo), nunca un provider type
 * propio.
 */
const DEEPSEEK_ANTHROPIC_ENDPOINT = 'https://api.deepseek.com/anthropic'

function isDeepSeekProvider(provider: ProviderProfile): boolean {
  return provider.type === 'anthropic' && provider.endpoint === DEEPSEEK_ANTHROPIC_ENDPOINT
}

interface ProviderIdentity {
  name: string
  initial: string
  /** Circulo de la insignia -- solido o gradiente (Google). */
  background: string
  /** SIEMPRE solido (nunca gradiente) -- para texto tintado (modelo
   *  seleccionado en el acordeon) donde un gradiente no aplica. */
  accent: string
  /** rgba al 25% de opacidad del color de marca, halo de la insignia
   *  (box-shadow) -- valores fijos del mockup aprobado, no calculados en
   *  runtime desde `background` (evita parsear un gradiente). */
  halo: string
}

/**
 * Fase 21: colores de marca reales, mismos valores exactos del mockup
 * aprobado por el usuario (mockup_seleccion_modelos.html). 'neutral' cubre
 * tipos sin marca reconocible propia (openai-compatible, o cualquier
 * ProviderType futuro no listado aca todavia — ver default de
 * providerIdentity() mas abajo).
 */
const PROVIDER_BRAND: Record<string, { background: string; accent: string; halo: string }> = {
  anthropic: { background: '#d97757', accent: '#d97757', halo: 'rgba(217,119,87,0.25)' },
  openai: { background: '#10a37f', accent: '#10a37f', halo: 'rgba(16,163,127,0.25)' },
  google: { background: 'linear-gradient(135deg,#4285F4,#34A853)', accent: '#4285F4', halo: 'rgba(66,133,244,0.25)' },
  // Integracion de Antigravity CLI: color propio, distinto del gradiente
  // azul/verde de 'google' (Gemini) a proposito -- es un producto Google
  // DISTINTO (ver comentario de ProviderType en shared/types.ts), merece
  // identidad visual propia en vez de heredar el color de Gemini.
  antigravity: { background: '#7c3aed', accent: '#7c3aed', halo: 'rgba(124,58,237,0.25)' },
  deepseek: { background: '#4d6bfe', accent: '#4d6bfe', halo: 'rgba(77,107,254,0.25)' },
  foundry: { background: '#0078d4', accent: '#0078d4', halo: 'rgba(0,120,212,0.25)' },
  openrouter: { background: '#8b5cf6', accent: '#8b5cf6', halo: 'rgba(139,92,246,0.25)' },
  neutral: { background: '#6b7280', accent: '#9ca3af', halo: 'rgba(107,114,128,0.25)' }
}

/**
 * Fase 21: reemplaza providerDisplayName() — identidad real y explicita
 * por proveedor (nombre de marca + inicial + color), en vez de una
 * heuristica por substring sobre un string concatenado. Clave PRIMARIA:
 * provider.type — el unico caso especial real es DeepSeek (mismo
 * provider.type que Claude, 'anthropic', pero un endpoint puntual
 * distinto, chequeado arriba en isDeepSeekProvider() ANTES que el resto).
 * authMode (Suscripcion vs API key) ya NO afecta el nombre/color — ese
 * dato vive aparte en la pill de metodo (ver MethodPill mas abajo), nunca
 * mas concatenado al nombre ("Claude API via Azure", "Claude Pro" como
 * nombres DISTINTOS quedan atras: ambos son "Anthropic" ahora).
 */
function providerIdentity(provider: ProviderProfile): ProviderIdentity {
  if (isDeepSeekProvider(provider)) return { name: 'DeepSeek', initial: 'D', ...PROVIDER_BRAND.deepseek }

  switch (provider.type) {
    case 'anthropic': return { name: 'Anthropic', initial: 'A', ...PROVIDER_BRAND.anthropic }
    case 'openai-codex': return { name: 'Codex ChatGPT', initial: 'C', ...PROVIDER_BRAND.openai }
    case 'openai': return { name: 'OpenAI', initial: 'O', ...PROVIDER_BRAND.openai }
    case 'google': return { name: 'Google', initial: 'G', ...PROVIDER_BRAND.google }
    case 'antigravity': return { name: 'Antigravity', initial: 'A', ...PROVIDER_BRAND.antigravity }
    case 'foundry': return { name: 'Microsoft Foundry', initial: 'F', ...PROVIDER_BRAND.foundry }
    case 'openrouter': return { name: 'OpenRouter', initial: 'O', ...PROVIDER_BRAND.openrouter }
    case 'openai-compatible':
    default: {
      const label = provider.name.trim() || 'Compatible'
      return { name: label, initial: label.charAt(0).toUpperCase() || '?', ...PROVIDER_BRAND.neutral }
    }
  }
}

/**
 * Mensajeria entre ventanas, Paso 3, Tarea 5: color de marca para un
 * mensaje cross-window, a partir de SOLO `crossWindow.providerType`
 * persistido (no el ProviderProfile completo -- ver CrossWindowMeta,
 * shared/types.ts). Reusa PROVIDER_BRAND (Fase 21) directo, mismos colores
 * exactos que ya usa el resto de la app -- ningun color nuevo inventado
 * para esta fase. Mismo caveat ya documentado en CrossWindowMeta: no
 * distingue el caso especial DeepSeek (mismo type:'anthropic' que Claude,
 * se distingue por endpoint, dato no disponible aca) -- un mensaje cross-
 * window de una conexion DeepSeek se pinta con el color de Anthropic.
 */
function crossWindowBrand(crossWindow: CrossWindowMeta): { background: string; accent: string; halo: string } {
  switch (crossWindow.providerType) {
    case 'anthropic': return PROVIDER_BRAND.anthropic
    case 'openai-codex':
    case 'openai': return PROVIDER_BRAND.openai
    case 'google': return PROVIDER_BRAND.google
    case 'foundry': return PROVIDER_BRAND.foundry
    case 'openrouter': return PROVIDER_BRAND.openrouter
    default: return PROVIDER_BRAND.neutral
  }
}

/**
 * Feature "arbol de sub-chats": color de borde por fila del sidebar, segun
 * el provider PERSISTIDO del chat (chat.providerId -- last-used, viene de
 * chat-store.ts, NO el estado de conexion en vivo de ningun panel). Reusa
 * providerIdentity()/PROVIDER_BRAND (Fase 21) tal cual -- ningun color
 * nuevo. providerId puede apuntar a un provider ya borrado (o el chat
 * nunca se conecto todavia) -- en ambos casos cae al gris neutral, igual
 * que el resto de la app para "sin identidad reconocible".
 */
function chatBorderAccent(chat: ChatSession, providers: ProviderProfile[]): string {
  const provider = chat.providerId ? providers.find(p => p.id === chat.providerId) : undefined
  return provider ? providerIdentity(provider).accent : PROVIDER_BRAND.neutral.accent
}

function providerSubtitle(provider: ProviderProfile): string {
  if (!provider.enabled) return 'Desactivado'
  if (isDeepSeekProvider(provider)) return 'API key de DeepSeek - endpoint compatible Anthropic'
  if (provider.type === 'anthropic' && provider.authMode === 'subscription') return 'Suscripcion Claude Pro - usa Claude Code CLI'
  if (provider.type === 'anthropic' && provider.authMode === 'api-key') return 'API key + endpoint - respaldo, no suscripcion'
  if (provider.type === 'openai-codex') return 'Suscripcion ChatGPT - usa Codex app-server'
  if (provider.type === 'google' && provider.authMode === 'subscription') return 'Suscripcion Google - usa Gemini CLI'
  if (provider.type === 'google' && provider.authMode === 'api-key') return 'API key de Gemini'
  if (provider.type === 'antigravity' && provider.authMode === 'subscription') return 'Suscripcion Google - usa Antigravity CLI'
  if (provider.type === 'antigravity' && provider.authMode === 'api-key') return 'API key de Gemini (via Antigravity CLI)'
  if (provider.type === 'foundry') return 'API key de Azure/Foundry - /responses directo'
  if (provider.type === 'openai-compatible') return 'API compatible - requiere validar soporte'
  if (provider.type === 'openai') return 'API key de OpenAI'
  return provider.authMode === 'subscription' ? 'Suscripcion' : 'API key'
}

/**
 * Fase 21 Tarea 3: subtitulo de la fila de conexion en Settings — con
 * modelos habilitados reales, "N modelos — nombre, nombre y M mas" (mismo
 * patron que el mockup: "6 modelos — GPT-5.x, Claude, DeepSeek"). Sin
 * modelos habilitados (conexion recien creada, o de solo-suscripcion sin
 * catalogo propio como Claude Pro/Codex ChatGPT/Gemini Advanced), cae a
 * providerSubtitle() — el mecanismo (CLI, endpoint) sigue siendo el dato
 * mas util cuando no hay lista de modelos que mostrar.
 */
function providerConnectionSubtitle(provider: ProviderProfile): string {
  if (!provider.enabled) return 'Desactivado'
  const enabledModels = provider.models.filter(model => model.enabled)
  if (enabledModels.length === 0) return providerSubtitle(provider)
  const names = enabledModels.slice(0, 2).map(model => model.displayName).join(', ')
  const rest = enabledModels.length - 2
  const suffix = rest > 0 ? ` y ${rest} mas` : ''
  return `${enabledModels.length} modelo${enabledModels.length === 1 ? '' : 's'} — ${names}${suffix}`
}

function providerModeLabel(provider: ProviderProfile): string {
  if (!provider.enabled) return 'Desactivado'
  return provider.authMode === 'subscription' ? 'Suscripcion' : 'API key'
}

function providerDisplayRank(provider: ProviderProfile): number {
  if (!provider.enabled) return 30
  if (provider.type === 'anthropic' && provider.authMode === 'subscription') return 0
  if (provider.type === 'openai-codex') return 1
  if (provider.type === 'google' && provider.authMode === 'subscription') return 2
  if (provider.type === 'antigravity' && provider.authMode === 'subscription') return 3
  if (provider.authMode === 'api-key') return 10
  return 20
}

function providersForDisplay(providers: ProviderProfile[]): ProviderProfile[] {
  return [...providers].sort((a, b) =>
    providerDisplayRank(a) - providerDisplayRank(b) ||
    providerIdentity(a).name.localeCompare(providerIdentity(b).name)
  )
}

/**
 * Fase 21 Tarea 2: insignia (circulo + inicial + halo) — UN solo
 * componente, reusado tal cual en la lista de conexiones (34px, tamano por
 * defecto) Y en el header de cada grupo del acordeon del selector de
 * modelo (24px) — nunca duplicado como dos bloques de JSX/CSS separados.
 */
/** UI, Pieza 3 (docs/_arch/verify_ui_sidebar_header.md): texto deslizante
 *  en hover para nombres truncados del sidebar (chats, proyectos) --
 *  reusable, un solo lugar para los 4 usos reales (chat-title-main,
 *  chat-title-sub, project, root-title-open). La animacion en si es 100%
 *  CSS (@keyframes + :hover, ver .marquee-inner/main.css) -- el UNICO JS
 *  de esta feature es la MEDICION real de si el texto se corta
 *  (scrollWidth > clientWidth), a proposito: CSS puro con container query
 *  units (calc(-100% + 100cqw)) puede calcular el desplazamiento exacto,
 *  pero no puede distinguir "esta cortado" de "no esta cortado" sin
 *  producir un salto espurio chico en items que YA entran completos
 *  (matematicamente da un translateX positivo chico en vez de exactamente
 *  0) -- la clase is-truncated evita ese caso por completo, en vez de
 *  confiar en que el numero de la formula de casualidad. Se remide en
 *  cada cambio de texto y en cada resize de ventana (el sidebar puede
 *  angostarse via el breakpoint responsive o colapsarse via Pieza 2). */
function MarqueeSpan({ text, className = '' }: { text: string; className?: string }) {
  const ref = useRef<HTMLSpanElement>(null)
  const [truncated, setTruncated] = useState(false)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const measure = () => setTruncated(el.scrollWidth > el.clientWidth + 1)
    measure()
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [text])

  return (
    <span ref={ref} className={`${className} marquee-outer${truncated ? ' is-truncated' : ''}`}>
      <span className="marquee-inner">{text}</span>
    </span>
  )
}

function ProviderBadge({ identity, size = 34 }: { identity: ProviderIdentity; size?: number }) {
  return (
    <span
      className="provider-badge"
      style={{
        width: size,
        height: size,
        fontSize: size <= 26 ? 11 : 14,
        background: identity.background,
        boxShadow: `0 0 0 3px ${identity.halo}`
      }}
    >
      {identity.initial}
    </span>
  )
}

/** Fase 21: metodo de conexion (Suscripcion/API key) SIEMPRE como pill
 *  separada — nunca concatenada al nombre del proveedor (asi era antes,
 *  ver providerDisplayName() vieja: "Claude API via Azure", "Claude Pro").
 *  2 variantes fijas, no por marca (mismo criterio del mockup aprobado). */
function MethodPill({ provider }: { provider: ProviderProfile }) {
  return provider.authMode === 'subscription'
    ? <span className="method-pill sub">Suscripcion</span>
    : <span className="method-pill key">API key</span>
}

function defaultModels(providerId: string, type: ProviderType, authMode: AuthMode): ModelProfile[] {
  const runtime = runtimeFor(type, authMode)

  if (type === 'openai-codex') return []

  if (type === 'anthropic') {
    return [
      {
        id: crypto.randomUUID(), providerId, displayName: 'Claude Sonnet', model: 'sonnet', runtime, enabled: true,
        capabilities: { tools: true, reasoning: true, vision: true, web: false }
      },
      {
        id: crypto.randomUUID(), providerId, displayName: 'Claude Opus', model: 'opus', runtime, enabled: true,
        capabilities: { tools: true, reasoning: true, vision: true, web: false }
      },
      {
        id: crypto.randomUUID(), providerId, displayName: 'Claude Haiku', model: 'haiku', runtime, enabled: true,
        capabilities: { tools: true, reasoning: true, vision: true, web: false }
      }
    ]
  }

  if (type === 'google') {
    return [{
      id: crypto.randomUUID(), providerId, displayName: 'Gemini Auto', model: '', runtime, enabled: true,
      capabilities: { tools: true, reasoning: true, vision: true, web: true }
    }]
  }

  // Integracion de Antigravity CLI: 3 modelos reales confirmados con
  // `agy models` (docs/_arch/verify_antigravity_integration.md), mismo
  // patron que Gemini arriba (Auto + 2 ids reales) -- ids reales, no
  // inventados.
  if (type === 'antigravity') {
    return [
      {
        id: crypto.randomUUID(), providerId, displayName: 'Antigravity Auto', model: '', runtime, enabled: true,
        capabilities: { tools: true, reasoning: true, vision: true, web: true }
      },
      {
        id: crypto.randomUUID(), providerId, displayName: 'Gemini 3.1 Pro (High)', model: 'gemini-3.1-pro-high', runtime, enabled: true,
        capabilities: { tools: true, reasoning: true, vision: true, web: true }
      },
      {
        id: crypto.randomUUID(), providerId, displayName: 'Gemini 3.7 Flash (High)', model: 'gemini-3.7-flash-high', runtime, enabled: true,
        capabilities: { tools: true, reasoning: true, vision: true, web: true }
      }
    ]
  }

  // Fase 15: modelo default = el stealth "Ox Alpha" (gratis, 1M contexto,
  // 128K output, reasoning para coding) que motivo agregar este runtime —
  // https://openrouter.ai/stealth/ox-alpha. El campo "model" queda editable
  // igual que cualquier otro, para apuntar a cualquier otro id de
  // OpenRouter (pago o gratis) sin volver a tocar codigo.
  if (type === 'openrouter') {
    return [{
      id: crypto.randomUUID(), providerId, displayName: 'Ox Alpha (stealth, gratis)', model: 'stealth/ox-alpha', runtime, enabled: true,
      capabilities: { tools: true, reasoning: true, vision: true, web: false }
    }]
  }

  return [{
    id: crypto.randomUUID(), providerId,
    displayName: type === 'foundry' ? 'Nuevo deployment' : 'Nuevo modelo',
    model: '', runtime, enabled: true,
    capabilities: { tools: true, reasoning: true, vision: true, web: false }
  }]
}

/**
 * DeepSeek expone un endpoint compatible con la Anthropic Messages API en
 * /anthropic (ver https://api-docs.deepseek.com/quick_start/agent_integrations/claude_code)
 * — mismo formato que Claude API key (x-api-key + /v1/messages), asi que se
 * modela como provider type:'anthropic' con endpoint propio: reusa
 * sendAnthropicApi() completo (tool-calling, cancelacion, etc.) sin tocar
 * el runtime, cero codigo nuevo del lado del loop de tool-calling.
 */
function newDeepSeekProvider(): ProviderProfile {
  const id = crypto.randomUUID()
  return {
    id,
    name: 'DeepSeek',
    type: 'anthropic',
    authMode: 'api-key',
    endpoint: DEEPSEEK_ANTHROPIC_ENDPOINT,
    apiKey: '',
    enabled: true,
    // Fix: DeepSeek no tiene una sesion CLI detras (no es Claude real) —
    // no puede usar authMode:'subscription' aunque comparta type:'anthropic'
    // (reusa el mismo runtime HTTP). Sin esto, el selector ofrecia
    // "Suscripcion" y elegirla disparaba el login de Claude Code sin que
    // el proveedor real fuera Claude.
    allowSubscription: false,
    models: [
      {
        id: crypto.randomUUID(),
        providerId: id,
        displayName: 'DeepSeek V4 Pro',
        model: 'deepseek-v4-pro',
        runtime: 'anthropic-api',
        enabled: true,
        capabilities: { tools: true, reasoning: true, vision: false, web: false }
      },
      {
        id: crypto.randomUUID(),
        providerId: id,
        displayName: 'DeepSeek V4 Flash',
        model: 'deepseek-v4-flash',
        runtime: 'anthropic-api',
        enabled: true,
        capabilities: { tools: true, reasoning: false, vision: false, web: false }
      }
    ]
  }
}

function newProvider(type: ProviderType, authMode: AuthMode): ProviderProfile {
  const id = crypto.randomUUID()
  return {
    id,
    name: providerName(type),
    type,
    authMode,
    endpoint: type === 'openai'
      ? 'https://api.openai.com/v1'
      // Fase 15: default real de OpenRouter, editable igual que cualquier
      // otro endpoint -- el usuario puede repuntarlo a otro backend
      // Chat-Completions-compatible (Groq, Together, etc.) sin tocar codigo.
      : type === 'openrouter'
        ? 'https://openrouter.ai/api/v1'
        : '',
    apiKey: '',
    enabled: true,
    // Fix: (type, authMode) = ('anthropic', 'api-key') identifica sin
    // ambiguedad al boton "Claude<small>API key / Azure</small>" del grid
    // de "+ Agregar conexion" -- ningun otro call site de newProvider()
    // pasa esta combinacion exacta (Claude Pro usa 'subscription', y
    // DeepSeek arma su ProviderProfile aparte en newDeepSeekProvider(),
    // nunca via esta funcion). Un endpoint custom/Azure no tiene una
    // sesion CLI oficial detras -- no puede usar 'subscription' aunque el
    // usuario la haya usado antes con Claude Pro real. OpenRouter (Fase
    // 15) tampoco: no hay concepto de suscripcion ahi en absoluto, se
    // marca sin condicionar por authMode (el unico boton que crea este
    // type ya manda 'api-key' siempre). Los demas casos no setean el
    // campo (queda undefined, comportamiento igual que antes de este fix).
    ...(type === 'openrouter' || (type === 'anthropic' && authMode === 'api-key') ? { allowSubscription: false } : {}),
    models: defaultModels(id, type, authMode)
  }
}

function parseCodexAccount(raw: unknown): CodexAccountView {
  const root = asRecord(raw)
  const account = asRecord(root.account)
  if (!root.account || Object.keys(account).length === 0) {
    return {
      connected: false,
      detail: root.requiresOpenaiAuth === false
        ? 'Codex no requiere autenticacion OpenAI.'
        : 'Sin sesion ChatGPT.'
    }
  }

  return {
    connected: true,
    email: asString(account.email) || undefined,
    planType: asString(account.planType ?? account.plan_type) || undefined
  }
}

/** Fase Paneles-2a: fallback de 3 niveles, no 2 -- (1) `preferredProviderId`
 *  (el `providerId` del chat activo de ESTE panel, si ya tuvo un turno
 *  real), (2) `settings.activeProviderId` (ya NO "la seleccion activa",
 *  repropuesto como default sugerido de la app para un chat que todavia no
 *  tiene el suyo -- ver docs/_arch/CONTRACT.md), (3) cualquier proveedor
 *  habilitado (fallback que ya existia). Los call sites que no pasan
 *  `preferredProviderId` (bootstrap(), deleteProvider(), selectProvider())
 *  siguen funcionando identico a antes -- caen directo al nivel 2/3. */
function pickProvider(settings: AppSettings, preferredProviderId?: string): ProviderProfile | undefined {
  return settings.providers.find(p => p.id === preferredProviderId && p.enabled)
    ?? settings.providers.find(p => p.id === settings.activeProviderId && p.enabled)
    ?? settings.providers.find(p => p.enabled)
}

/** Mismo criterio que pickProvider(): `preferredModelId` (el del chat
 *  activo de este panel) antes que `appDefaultModelId` (settings.activeModelId,
 *  el default de la app) antes que "cualquiera habilitado". Si
 *  `preferredModelId` pertenece a OTRO proveedor (no `provider`), el
 *  primer find() simplemente no matchea (busca dentro de `provider.models`)
 *  y cae al siguiente nivel sin corromper nada -- no hace falta validar
 *  la pertenencia a mano. */
function pickModel(provider: ProviderProfile | undefined, preferredModelId?: string, appDefaultModelId?: string): ModelProfile | undefined {
  return provider?.models.find(m => m.id === preferredModelId && m.enabled)
    ?? provider?.models.find(m => m.id === appDefaultModelId && m.enabled)
    ?? provider?.models.find(m => m.enabled)
}

function isUnsupportedLocalProvider(provider: ProviderProfile): boolean {
  const endpoint = (provider.endpoint ?? '').toLowerCase()
  const name = provider.name.toLowerCase()
  return endpoint.includes('localhost') ||
    endpoint.includes('127.0.0.1') ||
    endpoint.includes('ollama') ||
    name.includes('ollama')
}

function isUnsupportedLocalModel(model: ModelProfile): boolean {
  const value = `${model.displayName} ${model.model}`.toLowerCase()
  return value.includes('qwen2.5:7b') || value.includes('ollama')
}

/**
 * Mapea el historial completo del chat (recortado solo por
 * IPC_HISTORY_PAYLOAD_CAP, ver comentario arriba) a ConversationMessage[].
 * El techo REAL de cuanto se manda verbatim al modelo lo aplica
 * normalizeHistory() server-side (context-envelope.ts) segun
 * CONTEXT_TOKEN_BUDGET — no es responsabilidad del renderer decidirlo,
 * porque esa decision necesita el watermark de compactacion (solo existe
 * en el proceso main). El resumen persistido (Fase 3) tampoco lo calcula
 * ni lo manda el renderer: ipc-agent.ts lo lee de chat-store.ts por chatId.
 */
function toRuntimeHistory(messages: ChatMessage[]): ConversationMessage[] {
  return messages
    .filter(message => message.text.trim())
    .slice(-IPC_HISTORY_PAYLOAD_CAP)
    .map(message => ({
      role: message.role,
      text: message.text.trim()
    }))
}

function attachmentSummary(attachments: ChatAttachment[]): string {
  if (attachments.length === 0) return ''
  return attachments.map(item => {
    const content = item.text ? `\n${item.text.slice(0, 1200)}` : ''
    return `[archivo:${item.kind}] ${item.name} (${item.mimeType}) ${item.path}${content}`
  }).join('\n\n')
}

function runtimeAttachments(attachments: ChatAttachment[]): ChatAttachment[] {
  return attachments.map(attachment => ({
    id: attachment.id,
    name: attachment.name,
    path: attachment.path,
    mimeType: attachment.mimeType,
    size: attachment.size,
    kind: attachment.kind,
    // Fase 17 Tarea 1: preview (data URL base64 completo) SOLO viaja para
    // adjuntos de imagen -- es lo que permite a los 4 runtimes API armar el
    // bloque de imagen real (Tarea 2, api-agent-runtime.ts). Para
    // adjuntos que no son imagen, preview no aplica (nunca se pobla) y
    // sigue sin mandarse, sin cambio de comportamiento ahi. Segundo
    // chokepoint identico en main: attachments.ts -> runtimeAttachmentView(),
    // que hasta ahora tambien lo descartaba -- sin ese fix en paralelo,
    // este por si solo no alcanza (buildRuntimeContext reconstruye el
    // envelope desde ahi, no desde este payload directamente).
    preview: attachment.kind === 'image' ? attachment.preview : undefined,
    text: attachment.text ? attachment.text.slice(0, 1200) : undefined
  }))
}

function extractMessageImages(text: string): { cleanText: string; images: MessageImage[] } {
  const images: MessageImage[] = []
  let cleanText = text

  cleanText = cleanText.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_match, alt: string, source: string) => {
    const cleanSource = source.trim().replace(/^["']|["']$/g, '')
    images.push({ id: `${images.length}-${cleanSource}`, alt: alt || 'imagen', source: cleanSource })
    return ''
  })

  cleanText = cleanText.replace(/((?:file:\/\/\/|[A-Za-z]:[\\/]|\\\\)[^\n\r<>"]+\.(?:png|jpe?g|webp|gif|ico))/gi, match => {
    const cleanSource = match.trim().replace(/^`|`$/g, '')
    images.push({ id: `${images.length}-${cleanSource}`, alt: cleanSource.split(/[\\/]/).pop() ?? 'imagen', source: cleanSource })
    return ''
  })

  return { cleanText: cleanText.trim(), images }
}

function AttachmentCard({
  attachment,
  mode,
  onRemove,
  onOpenImage
}: {
  attachment: ChatAttachment
  mode: 'pending' | 'message'
  onRemove?: () => void
  onOpenImage?: (preview: ImagePreviewState) => void
}) {
  const isImage = Boolean(attachment.preview && attachment.kind === 'image')
  // Feature "generacion de imagenes": distincion puramente visual -- ningun
  // otro codigo depende de `origin`, ver comentario en ChatAttachment
  // (shared/types.ts).
  const isGenerated = attachment.origin === 'generated'

  return (
    <div className={`${mode}-attachment attachment-card`}>
      <button
        className={isImage ? 'attachment-preview image' : 'attachment-preview'}
        type="button"
        onClick={() => {
          if (isImage && attachment.preview) {
            onOpenImage?.({ src: attachment.preview, title: attachment.name })
          }
        }}
        disabled={!isImage}
        title={isImage ? 'Abrir imagen' : attachment.name}
      >
        {isImage ? <img src={attachment.preview} alt={attachment.name} /> : <span>{attachment.kind}</span>}
        {isGenerated && <span className="attachment-generated-badge" title="Generada por IA">✦ IA</span>}
      </button>
      <div className="attachment-meta">
        <strong>{attachment.name}</strong>
        <small>{isGenerated ? `${attachment.kind.toUpperCase()} · GENERADA` : attachment.kind.toUpperCase()}</small>
      </div>
      {onRemove && (
        <button className="attachment-remove" title="Quitar adjunto" onClick={onRemove} type="button">
          x
        </button>
      )}
    </div>
  )
}

function ChatMessageView({
  message,
  onOpenImage
}: {
  message: ChatMessage
  onOpenImage: (preview: ImagePreviewState) => void
}) {
  const parsed = useMemo(() => extractMessageImages(message.text), [message.text])
  const [resolvedImages, setResolvedImages] = useState<Record<string, string>>({})

  useEffect(() => {
    let cancelled = false
    async function resolveImages(): Promise<void> {
      const entries = await Promise.all(parsed.images.map(async image => {
        if (/^(data:|https?:|blob:)/i.test(image.source)) return [image.id, image.source] as const
        try {
          const preview = await window.universalAgent.previewImagePath(image.source)
          return [image.id, preview] as const
        } catch {
          return [image.id, ''] as const
        }
      }))
      if (!cancelled) {
        setResolvedImages(Object.fromEntries(entries.filter(([, value]) => Boolean(value))))
      }
    }
    void resolveImages()
    return () => { cancelled = true }
  }, [parsed.images])

  return (
    <>
      {message.attachments && message.attachments.length > 0 && (
        <div className="message-attachments">
          {message.attachments.map(attachment => (
            <AttachmentCard
              key={attachment.id}
              attachment={attachment}
              mode="message"
              onOpenImage={onOpenImage}
            />
          ))}
        </div>
      )}
      {parsed.images.length > 0 && (
        <div className="rendered-images">
          {parsed.images.map(image => (
            resolvedImages[image.id]
              ? (
                <button
                  key={image.id}
                  className="rendered-image-btn"
                  onClick={() => onOpenImage({ src: resolvedImages[image.id], title: image.alt })}
                  type="button"
                >
                  <img src={resolvedImages[image.id]} alt={image.alt} />
                </button>
              )
              : <div key={image.id} className="image-missing">{image.source}</div>
          ))}
        </div>
      )}
      {parsed.cleanText}
    </>
  )
}

/**
 * Fase Paneles-2b: props de <ChatPanel> — 3 grupos, mismo criterio de la
 * investigacion (verify_panels_scope.md, Paneles-2b Tarea 2): identidad
 * (panelId/chatId, controlados por el contenedor — un panel NUNCA decide
 * por si mismo que chat mostrar, ver mas abajo), datos compartidos de solo
 * lectura (settings/chatSessions/chats/defaultWorkspace, viven en App()),
 * y callbacks hacia el contenedor para mutar estado compartido o pedir un
 * overlay global.
 */
interface ChatPanelProps {
  panelId: string
  /** PIEZA 2 de la numeracion visual (docs/_arch/verify_panel_orchestrator.md):
   *  posicion 1-based de ESTE panel en `openPanels` al momento de renderizar
   *  (App() pasa `index + 1` desde el .map() que ya recorre ese array en el
   *  mismo orden que el grid visual — ver el call site). Puramente visual,
   *  eje DISTINTO de "principal" (Pieza 1, identidad de chat) — un panel
   *  puede mostrar "2" aca y aun asi ser el que tiene send_to_window
   *  habilitado, si ese es el que resulta ser el chat principal. */
  panelIndex: number
  chatId: string
  chatSessions: ChatSession[]
  setChatSessions: Dispatch<SetStateAction<ChatSession[]>>
  chats: Record<string, ChatMessage[]>
  setChats: Dispatch<SetStateAction<Record<string, ChatMessage[]>>>
  settings: AppSettings
  defaultWorkspace: { path: string; name: string } | null
  /** readiness() (mas abajo) necesita saber si hay sesion ChatGPT/Claude
   *  Code/Antigravity CLI reales -- viven en App() (Configuracion), no en
   *  el panel. */
  codexAccountConnected: boolean
  cliStatus: { codex?: CliStatus; claude?: CliStatus; antigravity?: CliStatus }
  isFocused: boolean
  canClose: boolean
  /** Fase Paneles-2b: bumpeado por App() en cada accion que hoy sigue
   *  desconectando "todo" de forma cruda (agregar/borrar proveedor,
   *  sincronizar Codex, importar q_config, etc.) — mismo comportamiento
   *  crudo-pero-seguro que ya tenia esta app con un solo panel implicito,
   *  generalizado a N: cualquier cambio de catalogo desconecta TODOS los
   *  paneles, no solo el que dispara la accion (ver CONTRACT.md). */
  catalogChangeNonce: number
  onFocus: () => void
  onClose: () => void
  onAddPanelForThisChat: () => void
  onOpenImage: (preview: ImagePreviewState) => void
  onContextMenuRequest: (menu: ContextMenuState) => void
  onWorkspaceConnected: (path: string) => void
  onStatusChange: (panelId: string, status: PanelStatus) => void
  onApprovalChange: (panelId: string, handle: ApprovalHandle | null) => void
  onToolApprovalChange: (panelId: string, handle: ToolApprovalHandle | null) => void
  /** Fase Paneles-3: no-null solo mientras este panel tiene un pedido de
   *  auto-open+connect pendiente (ver handlePanelOpenAndConnectRequest()
   *  en App()) -- confirmado en la investigacion (Tarea 1) que ningun
   *  ChatPanel se conecta solo al montarse, asi que este es el UNICO
   *  disparador real de "conectate automaticamente" que existe. Distinto
   *  cada vez (un `requestId` fresco por pedido) para que el useEffect que
   *  lo escucha dispare de nuevo si, en algun momento futuro, el mismo
   *  panel reusado recibe un segundo pedido. */
  autoConnectRequestId: string | null
  onAutoConnectResult: (success: boolean, error?: string) => void
}

/**
 * Fase Paneles-2b: "una conversacion" real, extraida del bloque de JSX que
 * ya estaba limpiamente delimitado (`<section className="chat">`, ver
 * verify_panels_scope.md Paneles-2b Tarea 1) mas todo el estado/logica que
 * la investigacion de Paneles-2 ya habia clasificado "de CADA PANEL".
 *
 * Decisiones de diseño tomadas DURANTE esta implementacion, no ancitipadas
 * en la investigacion (documentadas en CONTRACT.md, no solo aca):
 * - `chatId` es un PROP controlado por App() — el panel nunca decide por
 *   si mismo "que chat muestro ahora". Esto simplifica activeProject a un
 *   valor puramente DERIVADO (buscar en `settings`/`chatSessions` el
 *   workspace de `activeChat`), eliminando el estado `activeProject`
 *   propio que Paneles-2 habia clasificado como necesario -- ya no hace
 *   falta: no hay ninguna ventana de "todavia no coincide" entre elegir un
 *   proyecto y que activeChat lo refleje, porque el contenedor decide el
 *   chatId FINAL antes de que este componente lo vea.
 * - `chats` (cache de mensajes) pasa a ser compartido (prop), no propio de
 *   cada panel -- Paneles-2 lo habia marcado "de CADA PANEL" pero
 *   bootstrap() carga TODOS los mensajes de TODOS los chats de una sola
 *   vez (shell-level); duplicarlo por panel multiplicaria memoria sin
 *   ningun beneficio real bajo la regla de "mismo chat nunca en 2 paneles"
 *   (cada chatId solo lo consume un panel a la vez de todos modos).
 */
function ChatPanel(props: ChatPanelProps) {
  const {
    panelId,
    panelIndex,
    chatId,
    chatSessions,
    setChatSessions,
    chats,
    setChats,
    settings,
    defaultWorkspace,
    codexAccountConnected,
    cliStatus,
    isFocused,
    canClose,
    catalogChangeNonce,
    onFocus,
    onClose,
    onAddPanelForThisChat,
    onOpenImage,
    onContextMenuRequest,
    onWorkspaceConnected,
    onStatusChange,
    onApprovalChange,
    onToolApprovalChange,
    autoConnectRequestId,
    onAutoConnectResult
  } = props

  const api = useMemo(() => window.universalAgent.forPanel(panelId), [panelId])

  const [pendingAttachments, setPendingAttachments] = useState<ChatAttachment[]>([])
  const [dragActive, setDragActive] = useState(false)
  const [prompt, setPrompt] = useState('')
  const [agentState, setAgentState] = useState<AgentState>('idle')
  const [agentRuntime, setAgentRuntime] = useState('')
  const [agentError, setAgentError] = useState('')
  const [modelMenuOpen, setModelMenuOpen] = useState(false)
  const [expandedProviderId, setExpandedProviderId] = useState<string | null>(null)
  const [sandbox, setSandbox] = useState<SandboxMode>('workspace-write')
  const [effort, setEffort] = useState<string>('')
  const [agentEvents, setAgentEvents] = useState<string[]>([])
  const [debugOpen, setDebugOpen] = useState(false)
  const [approval, setApproval] = useState<Approval | null>(null)
  const [toolApproval, setToolApproval] = useState<ToolApprovalRequest | null>(null)
  const [toolApprovalTrust, setToolApprovalTrust] = useState(false)
  const [toolTrustActive, setToolTrustActive] = useState(false)
  const [toolStatus, setToolStatus] = useState('')
  const [turnActive, setTurnActive] = useState(false)
  const [turnElapsedSeconds, setTurnElapsedSeconds] = useState(0)
  const [turnTokens, setTurnTokens] = useState<number | null>(null)
  const [turnSteps, setTurnSteps] = useState<string[]>([])
  const turnStepsRef = useRef<string[]>([])
  function pushTurnStep(step: string): void {
    turnStepsRef.current = [...turnStepsRef.current, step]
    setTurnSteps(turnStepsRef.current)
  }
  function resetTurnSteps(): void {
    turnStepsRef.current = []
    setTurnSteps([])
  }
  const [expandedSteps, setExpandedSteps] = useState<Set<string>>(new Set())
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)
  const activeChatIdRef = useRef(chatId)
  const assistantOutputSeenRef = useRef(false)
  const pendingTurnTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const turnStartRef = useRef<number | null>(null)
  const lastConnectedWorkspaceRef = useRef<string | undefined>(undefined)
  const catalogChangeNonceRef = useRef(catalogChangeNonce)

  const activeChat = chatSessions.find(chat => chat.id === chatId) ?? chatSessions[0] ?? generalChatSession()
  const activeProvider = useMemo(
    () => pickProvider(settings, activeChat.providerId),
    [settings, activeChat.providerId]
  )
  const activeModel = useMemo(
    () => pickModel(activeProvider, activeChat.modelId, settings.activeModelId),
    [activeProvider, activeChat.modelId, settings.activeModelId]
  )
  const effortOptions = useMemo((): readonly string[] | null => {
    if (!activeModel) return null
    if (activeModel.runtime === 'claude-cli') return CLAUDE_EFFORT_LEVELS
    if (
      (activeModel.runtime === 'codex-subscription' || activeModel.runtime === 'codex-api') &&
      activeModel.reasoningLevels?.length
    ) {
      return activeModel.reasoningLevels
    }
    return null
  }, [activeModel])
  useEffect(() => {
    setEffort('')
  }, [activeModel?.id])

  const currentMessages = chats[activeChat.id] ?? []
  const activeWorkspacePath = activeChat.workspacePath
  const activeWorkspaceName = activeChat.workspaceName

  function setMessagesFor(workspace: string, updater: (current: ChatMessage[]) => ChatMessage[]): void {
    setChats(current => ({ ...current, [workspace]: updater(current[workspace] ?? []) }))
  }

  /** Fase Paneles-2a (fix real, encontrado por CDP en Tarea 5 Caso 2):
   *  `activeProvider`/`activeModel` son el estado CONECTADO de ESTE panel
   *  ahora mismo -- solo son la fuente correcta de providerId/modelId
   *  cuando `chat` ES de verdad el chat activo (mismo id) Y ese chat
   *  todavia no tiene su propio valor guardado. `chat.providerId ?? ...`
   *  prioriza lo que el chat YA tiene (nunca lo pisa con un valor ajeno);
   *  si no tiene nada Y es de verdad el chat activo, recien ahi usa la
   *  sesion conectada real. */
  function ensureStoredChat(chat: ChatSession = activeChat): void {
    const providerId = chat.providerId ?? (chat.id === activeChat.id ? activeProvider?.id : undefined)
    const modelId = chat.modelId ?? (chat.id === activeChat.id ? activeModel?.id : undefined)
    void window.universalAgent.ensureChatSession({
      id: chat.id,
      title: chat.title,
      workspacePath: chat.workspacePath,
      workspaceName: chat.workspaceName,
      providerId,
      modelId,
      runtime: agentRuntime
    })
    const updatedAt = new Date().toISOString()
    setChatSessions(current => current.map(item =>
      item.id === chat.id ? { ...item, updatedAt, providerId, modelId } : item
    ))
  }

  /** Fase Paneles-2a: fija provider/model para el CHAT ACTIVO de este panel
   *  -- ya no un valor unico de AppSettings compartido por toda la app. */
  function setActiveChatModel(providerId: string, modelId: string | undefined): void {
    const chat = activeChat
    setChatSessions(current => current.map(item =>
      item.id === chat.id ? { ...item, providerId, modelId } : item
    ))
    void window.universalAgent.ensureChatSession({
      id: chat.id,
      title: chat.title,
      workspacePath: chat.workspacePath,
      workspaceName: chat.workspaceName,
      providerId,
      modelId,
      runtime: agentRuntime
    })
  }

  /** Mensajeria entre ventanas, Paso 3, Tarea 5: consumidor real de
   *  'chat:incomingMessage' -- agrega el mensaje al chat correspondiente y
   *  bumpea el orden del sidebar, mismo criterio que ensureStoredChat()
   *  para el bump local. */
  function handleIncomingMessage(raw: unknown): void {
    const record = typeof raw === 'object' && raw !== null ? raw as Record<string, unknown> : null
    const incomingChatId = record && typeof record.chatId === 'string' ? record.chatId : ''
    const id = record && typeof record.id === 'string' ? record.id : ''
    if (!incomingChatId || !id) return
    const role = record?.role === 'user' || record?.role === 'assistant' || record?.role === 'system'
      ? record.role
      : 'assistant'
    const message = toChatMessage({
      id,
      role,
      text: typeof record?.text === 'string' ? record.text : '',
      crossWindow: record?.crossWindow as CrossWindowMeta | undefined
    })
    setMessagesFor(incomingChatId, current => [...current, message])
    const updatedAt = new Date().toISOString()
    setChatSessions(current => current.map(item => item.id === incomingChatId ? { ...item, updatedAt } : item))
  }

  function persistChatMessage(chatIdForMessage: string, message: ChatMessage): void {
    void window.universalAgent.saveChatMessage({
      id: message.id,
      chatId: chatIdForMessage,
      role: message.role,
      text: message.text,
      attachments: message.attachments,
      providerId: activeProvider?.id,
      modelId: activeModel?.id,
      runtime: agentRuntime,
      toolSteps: message.toolSteps
    })
  }

  function appendAssistantMessage(
    workspace: string,
    itemId: string,
    text: string,
    mode: 'append' | 'replace' = 'append',
    toolSteps?: string[],
    attachments?: ChatAttachment[]
  ): void {
    const normalizedText = text.trim()
    if (!normalizedText) return

    assistantOutputSeenRef.current = true
    clearTurnWatch()
    setMessagesFor(workspace, current => {
      const lastAssistant = [...current].reverse().find(message => message.role === 'assistant')
      if (
        mode === 'replace' &&
        lastAssistant &&
        lastAssistant.text.trim() === normalizedText &&
        lastAssistant.id !== itemId
      ) {
        return current
      }

      const index = current.findIndex(message => message.id === itemId)

      if (index < 0) {
        const created: ChatMessage = {
          id: itemId,
          role: 'assistant',
          text: normalizedText,
          toolSteps,
          attachments
        }
        persistChatMessage(workspace, created)
        return [...current, created]
      }

      const copy = [...current]
      copy[index] = {
        ...copy[index],
        text:
          mode === 'append'
            ? copy[index].text + text
            : normalizedText,
        toolSteps: toolSteps ?? copy[index].toolSteps,
        // Feature "generacion de imagenes": mismo criterio que toolSteps de
        // arriba -- si esta llamada no trae attachments (ej. el
        // turn/completed final con params vacios), conserva los que ya
        // tenia el mensaje (los de la delta anterior), nunca los pisa con
        // undefined.
        attachments: attachments ?? copy[index].attachments
      }
      persistChatMessage(workspace, copy[index])

      return copy
    })
  }

  function appendSystemMessage(
    workspace: string,
    text: string
  ): void {
    const message: ChatMessage = {
      id: crypto.randomUUID(),
      role: 'system',
      text
    }
    persistChatMessage(workspace, message)
    setMessagesFor(workspace, current => [
      ...current,
      message
    ])
  }

  function clearTurnWatch(): void {
    if (pendingTurnTimerRef.current) {
      clearTimeout(pendingTurnTimerRef.current)
      pendingTurnTimerRef.current = null
    }
    turnStartRef.current = null
    setTurnActive(false)
  }

  const configuredWatchdogSeconds = settings.turnWatchdogSeconds
  const turnWatchdogSeconds = typeof configuredWatchdogSeconds === 'number' &&
    Number.isFinite(configuredWatchdogSeconds) && configuredWatchdogSeconds > 0
    ? configuredWatchdogSeconds
    : TURN_WATCHDOG_DEFAULT_SECONDS
  const TURN_WATCHDOG_MS = turnWatchdogSeconds * 1000
  const turnWatchdogMsRef = useRef(TURN_WATCHDOG_MS)
  useEffect(() => {
    turnWatchdogMsRef.current = TURN_WATCHDOG_MS
  }, [TURN_WATCHDOG_MS])

  function startTurnWatch(workspace: string): void {
    if (pendingTurnTimerRef.current) {
      clearTimeout(pendingTurnTimerRef.current)
      pendingTurnTimerRef.current = null
    }
    if (turnStartRef.current === null) {
      turnStartRef.current = Date.now()
      setTurnElapsedSeconds(0)
      setTurnTokens(null)
      resetTurnSteps()
    }
    setTurnActive(true)
    assistantOutputSeenRef.current = false
    pendingTurnTimerRef.current = setTimeout(() => {
      if (assistantOutputSeenRef.current) return
      const message = `ERROR AGENTE: no llego respuesta del modelo ni actividad de herramientas en ${turnWatchdogMsRef.current / 1000}s. El turno se cerro; podes intentar de nuevo.`
      setAgentError(message)
      appendSystemMessage(workspace, message)
      clearTurnWatch()
      setToolStatus('')
      resetTurnSteps()
    }, turnWatchdogMsRef.current)
  }

  function handleAgentEvent(raw: unknown): void {
    const event = asRecord(raw)
    const kind = asString(event.kind)
    const method = asString(event.method)
    const params = asRecord(event.params)
    const rawMessage = event.message ?? raw
    const workspace = asString(event.chatId) || asString(event.workspace) || activeChatIdRef.current

    const codexError =
      method === 'error'
        ? extractCodexError(params)
        : method === 'turn/completed'
          ? extractCodexError(params)
          : ''

    if (codexError && workspace) {
      setAgentState('error')
      appendSystemMessage(workspace, `ERROR CODEX: ${codexError}`)
    }

    setAgentEvents(current => [
      `${new Date().toLocaleTimeString()} ${kind}/${method || eventMethod(rawMessage)} ${JSON.stringify(rawMessage).slice(0, 900)}`,
      ...current
    ].slice(0, 80))

    if (!workspace) {
      return
    }

    if (kind === 'log') {
      return
    }

    if (kind === 'exit') {
      setAgentState('idle')
      return
    }

    if (kind === 'serverRequest') {
      if (
        (
          method.includes('requestApproval') ||
          method.includes('/request') ||
          method.includes('elicitation')
        ) &&
        (
          typeof event.id === 'number' ||
          typeof event.id === 'string'
        )
      ) {
        setApproval({
          requestId: event.id,
          method: method || 'server/request',
          params: event.params ?? {}
        })
        appendSystemMessage(
          workspace,
          `El agente requiere aprobacion: ${method || 'server/request'}`
        )
      }
      return
    }

    if (
      kind !== 'notification' &&
      kind !== 'raw'
    ) {
      return
    }

    if (
      method === 'turn/started' ||
      method.includes('turn/started')
    ) {
      startTurnWatch(workspace)
      return
    }

    if (method === 'item/usage/update') {
      const tokens = params.tokens
      if (typeof tokens === 'number') setTurnTokens(tokens)
      return
    }

    if (
      method === 'error' ||
      method.endsWith('/error')
    ) {
      const errorText =
        extractText(params.error) ||
        extractText(params) ||
        'Error del agente sin detalle.'

      setAgentState('error')
      setAgentError(errorText)
      appendSystemMessage(workspace, `ERROR AGENTE: ${errorText}`)
      return
    }

    if (method === 'item/toolCall/status') {
      const toolName = asString(params.name) || 'tool'
      const phase = asString(params.phase)
      const target = toolCallTargetLabel(params)
      startTurnWatch(workspace)
      if (phase === 'start') {
        setToolStatus(
          target ? `Ejecutando: ${toolName} (${target})` : `Ejecutando: ${toolName}`
        )
      } else {
        const ok = params.ok !== false
        const errorDetail = asString(params.detail).trim()
        const diff = ok ? lineDiffLabel(params) : ''
        const suffix = [target, diff].filter(Boolean).join(', ')
        const doneText = ok
          ? (suffix ? `${toolName} completado (${suffix})` : `${toolName} completado`)
          : errorDetail ? `${toolName} fallo: ${errorDetail}` : `${toolName} fallo`
        setToolStatus(doneText)
        pushTurnStep(doneText)
      }
      return
    }

    const item = asRecord(params.item)
    const itemType = asString(item.type)
    const itemId =
      asString(params.itemId) ||
      asString(params.item_id) ||
      asString(params.id) ||
      asString(item.id) ||
      asString(event.id) ||
      'assistant-current'
    const turnKey =
      asString(params.turnId) ||
      asString(params.turn_id) ||
      asString(asRecord(params.turn).id)
    const isCodexTurn = Boolean(turnKey)
    const itemMessageKey = turnKey || itemId

    if (
      method === 'item/agentMessage/delta' ||
      method.includes('agentMessage/delta')
    ) {
      const delta =
        asString(params.delta) ||
        asString(params.text) ||
        extractText(params)
      // Feature "generacion de imagenes": presente solo si ApiAgentRuntime.
      // send() genero alguna imagen este turno (ver ApiAgentResult.attachments,
      // ipc-agent.ts) -- undefined en cualquier otro caso (turno normal,
      // turno de un runtime CLI/Codex que ni siquiera pasa por este campo).
      const deltaAttachments = Array.isArray(params.attachments)
        ? params.attachments as ChatAttachment[]
        : undefined

      if (delta) {
        if (isCodexTurn) {
          setToolStatus('Escribiendo...')
          startTurnWatch(workspace)
        } else {
          appendAssistantMessage(workspace, itemMessageKey, delta, 'append', turnStepsRef.current, deltaAttachments)
        }
      }

      return
    }

    if (
      method === 'item/completed' ||
      method.includes('item/completed')
    ) {
      if (itemIsUserMessage(params)) return

      if (isCodexTurn) {
        const preview = extractAssistantText(params)
        const summary = summarizeCodexItem(itemType, item, preview)
        pushTurnStep(summary)
        setToolStatus(summary)
        startTurnWatch(workspace)
        return
      }

      const assistantText = extractAssistantText(params)
      if (assistantText) {
        appendAssistantMessage(workspace, itemMessageKey, assistantText, 'replace', turnStepsRef.current)
      }
      return
    }

    if (method === 'turn/cancelled') {
      const stepsSoFar = turnStepsRef.current
      clearTurnWatch()
      setToolStatus('')
      resetTurnSteps()
      const partialText = asString(params.partialText).trim()
      if (partialText) {
        appendAssistantMessage(
          workspace,
          turnKey || `assistant-turn-${Date.now()}`,
          `${partialText}\n\n_[Detenido por el usuario]_`,
          'replace',
          stepsSoFar
        )
      } else {
        appendSystemMessage(workspace, 'Turno detenido por el usuario.')
      }
      setAgentState('connected')
      return
    }

    if (
      method === 'turn/completed' ||
      method.includes('turn/completed')
    ) {
      const stepsSoFar = turnStepsRef.current
      clearTurnWatch()
      setToolStatus('')
      resetTurnSteps()
      if (codexError) return

      const assistantText = extractAssistantText(params)
      if (assistantText) {
        appendAssistantMessage(
          workspace,
          turnKey || `assistant-turn-${Date.now()}`,
          assistantText,
          'replace',
          stepsSoFar
        )
      } else if (!assistantOutputSeenRef.current) {
        setAgentState('error')
        setAgentError('El turno termino sin texto de assistant.')
      }

      setAgentState('connected')
      return
    }

    const genericAssistantText =
      itemIsUserMessage(params)
        ? ''
        : extractAssistantText(params)

    if (genericAssistantText) {
      appendAssistantMessage(
        workspace,
        itemMessageKey,
        genericAssistantText,
        method.includes('delta') ? 'append' : 'replace',
        turnStepsRef.current
      )
      return
    }
  }

  /** Fase Paneles-2b: `codexAccount`/`cliStatus` (Configuracion, ya no
   *  visibles desde un panel) llegan como props (`codexAccountConnected`/
   *  `cliStatus`) en vez de leerse de una closure de App() que ya no
   *  existe aca -- resto de la logica identica a antes de esta fase. */
  function readiness(): string | null {
    if (!activeProvider) return 'Agrega o selecciona una conexion IA.'
    if (!activeProvider.enabled) return 'La conexion seleccionada esta desactivada.'
    if (!activeModel) {
      return activeProvider.type === 'openai-codex'
        ? 'La cuenta Codex esta disponible, pero no hay modelo sincronizado.'
        : 'Selecciona o agrega un modelo.'
    }
    if (isUnsupportedLocalProvider(activeProvider) || isUnsupportedLocalModel(activeModel)) {
      return 'Ollama/qwen2.5:7b esta desactivado: no hay compatibilidad real validada.'
    }
    if (
      activeProvider.type === 'openai-codex' &&
      activeProvider.authMode === 'subscription' &&
      !codexAccountConnected
    ) return 'Conecta tu cuenta ChatGPT para usar Codex.'

    if (activeProvider.authMode === 'api-key' && !activeProvider.apiKey?.trim()) {
      return 'Falta la API key.'
    }

    if (
      (activeProvider.type === 'foundry' || activeProvider.type === 'openai-compatible' ||
       (activeProvider.type === 'anthropic' && activeProvider.authMode === 'api-key')) &&
      !activeProvider.endpoint?.trim()
    ) return 'Falta el endpoint.'

    if (activeProvider.type === 'foundry' && !activeModel.model.trim()) {
      return 'Falta el deployment de Foundry.'
    }

    if (activeProvider.type === 'anthropic' && activeProvider.authMode === 'subscription' && !cliStatus.claude?.installed) {
      return 'Claude Code CLI no esta instalado.'
    }
    // Retiro de gemini-cli (docs/_arch/verify_gemini_cli_removal_scope.md,
    // verify_gemini_cli_removal.md): ya no hay ningun CLI que instalar/
    // detectar para esto -- bloqueo incondicional para conexiones viejas en
    // disco con authMode:'subscription' (el builtin que sembraba esta
    // combinacion se retiro, pero una conexion creada antes puede seguir
    // en settings.json).
    if (activeProvider.type === 'google' && activeProvider.authMode === 'subscription') {
      return 'Gemini por suscripcion (CLI) ya no esta soportado -- gemini-cli quedo discontinuado para cuentas individuales. Reconecta con una API key de Gemini, o usa Antigravity.'
    }
    if (activeProvider.type === 'antigravity' && activeProvider.authMode === 'subscription' && !cliStatus.antigravity?.installed) {
      return 'Antigravity CLI no esta instalado.'
    }
    if (
      (activeProvider.type === 'openai-codex' ||
       activeProvider.type === 'openai' || activeProvider.type === 'openai-compatible') &&
      !cliStatus.codex?.installed
    ) return 'Codex CLI no esta instalado.'

    return null
  }

  async function disconnect(): Promise<void> {
    await api.disconnectAgent()
    setAgentState('idle')
    setAgentRuntime('')
  }

  async function connectAgent(): Promise<boolean> {
    const reason = readiness()
    if (reason) {
      setAgentError(reason)
      return false
    }
    if (!activeProvider || !activeModel) return false

    setAgentState('connecting')
    setAgentError('')
    try {
      const result = await api.connectAgent({
        providerId: activeProvider.id,
        modelId: activeModel.id,
        workspace: activeWorkspacePath,
        chatId: activeChat.id,
        sandbox
      })
      setAgentState('connected')
      setAgentRuntime(result.runtime)
      if (result.workspaceIsDefault) {
        appendSystemMessage(
          activeChat.id,
          `AVISO: no hay un workspace de proyecto seleccionado. Las herramientas del agente (crear/editar archivos, comandos) van a usar una carpeta interna de la app, NO tu carpeta de proyecto. Selecciona un proyecto en el panel lateral antes de pedir acciones sobre archivos.`
        )
      }
      if (result.agentsMdWarning) {
        appendSystemMessage(activeChat.id, `AVISO: ${result.agentsMdWarning}`)
      }
      return true
    } catch (error) {
      setAgentState('error')
      setAgentError(String(error))
      return false
    }
  }


  async function runTurn(
    outboundText: string,
    lightweightAttachments: ChatAttachment[],
    historyMessages: ChatMessage[]
  ): Promise<void> {
    if (agentState !== 'connected') {
      const ok = await connectAgent()
      if (!ok) return
    }
    if (!activeProvider || !activeModel) return

    const history = toRuntimeHistory(historyMessages)
    startTurnWatch(activeChat.id)

    try {
      await api.sendMessage({
        text: outboundText,
        chatId: activeChat.id,
        attachments: lightweightAttachments,
        history,
        providerId: activeProvider.id,
        modelId: activeModel.id,
        sandbox,
        effort: effort || undefined
      })
    } catch (error) {
      clearTurnWatch()
      const message = String(error)
      setAgentState('error')
      setAgentError(message)
      setMessagesFor(activeChat.id, current => [
        ...current,
        { id: crypto.randomUUID(), role: 'system', text: `ERROR: ${message}` }
      ])
    }
  }

  async function sendPrompt(): Promise<void> {
    const text = prompt.trim()
    const attachments = pendingAttachments
    if (!text && attachments.length === 0) return

    if (agentState !== 'connected') {
      const ok = await connectAgent()
      if (!ok) return
    }
    if (!activeProvider || !activeModel) return

    const lightweightAttachments = runtimeAttachments(attachments)
    const outboundText = [text, attachmentSummary(lightweightAttachments)].filter(Boolean).join('\n\n')
    const historyBefore = currentMessages

    setPrompt('')
    setPendingAttachments([])
    const derivedTitle = (text || attachments[0]?.name || 'Archivo adjunto').slice(0, 34)
    setChatSessions(current => current.map(chat =>
      chat.id === activeChat.id && chat.title === 'Chat nuevo'
        ? { ...chat, title: derivedTitle }
        : chat
    ))
    if (activeChat.title === 'Chat nuevo') {
      void window.universalAgent.renameChatSession(activeChat.id, derivedTitle)
    }
    ensureStoredChat(activeChat)
    const userMessage: ChatMessage = { id: crypto.randomUUID(), role: 'user', text, attachments }
    persistChatMessage(activeChat.id, userMessage)
    setMessagesFor(activeChat.id, current => [...current, userMessage])

    await runTurn(outboundText, lightweightAttachments, historyBefore)
  }

  function toggleStepsExpanded(messageId: string): void {
    setExpandedSteps(current => {
      const next = new Set(current)
      if (next.has(messageId)) next.delete(messageId)
      else next.add(messageId)
      return next
    })
  }

  async function startEditMessage(message: ChatMessage): Promise<void> {
    if (message.role !== 'user') return
    if (turnActive) await cancelAgent()
    const chatIdForEdit = activeChat.id
    const index = currentMessages.findIndex(item => item.id === message.id)
    if (index < 0) return
    const truncated = currentMessages.slice(0, index)
    setMessagesFor(chatIdForEdit, () => truncated)
    void window.universalAgent.deleteChatMessagesFrom(chatIdForEdit, message.id)
    setPrompt(message.text)
    textareaRef.current?.focus()
  }

  async function regenerateFrom(message: ChatMessage): Promise<void> {
    if (message.role !== 'assistant') return
    if (turnActive) await cancelAgent()
    const chatIdForRegen = activeChat.id
    const index = currentMessages.findIndex(item => item.id === message.id)
    if (index < 0) return
    let userIndex = index - 1
    while (userIndex >= 0 && currentMessages[userIndex].role !== 'user') userIndex--
    if (userIndex < 0) return

    const userMessage = currentMessages[userIndex]
    const historyBefore = currentMessages.slice(0, userIndex)
    const keptWithUser = currentMessages.slice(0, userIndex + 1)

    setMessagesFor(chatIdForRegen, () => keptWithUser)
    void window.universalAgent.deleteChatMessagesFrom(chatIdForRegen, message.id)

    const lightweightAttachments = runtimeAttachments(userMessage.attachments ?? [])
    const outboundText = [userMessage.text, attachmentSummary(lightweightAttachments)].filter(Boolean).join('\n\n')

    await runTurn(outboundText, lightweightAttachments, historyBefore)
  }

  async function cancelAgent(): Promise<void> {
    await api.cancelAgent()
  }

  async function answerApproval(decision: 'accept' | 'decline' | 'acceptForSession'): Promise<void> {
    if (!approval) return
    await api.replyToAgent(approval.requestId, { decision })
    setApproval(null)
  }

  async function answerToolApproval(approved: boolean): Promise<void> {
    if (!toolApproval) return
    await api.respondToolApproval(toolApproval.id, approved, approved && toolApprovalTrust)
    setToolApproval(null)
    setToolApprovalTrust(false)
  }

  async function pickAttachments(): Promise<void> {
    try {
      const selected = await window.universalAgent.pickAttachments()
      if (selected.length === 0) return
      setPendingAttachments(current => [...current, ...selected])
    } catch (error) {
      setAgentError(String(error))
    }
  }

  async function attachImageFiles(files: File[]): Promise<boolean> {
    const images = files.filter(file => file.type.startsWith('image/'))
    if (images.length === 0) return false

    try {
      const selected = await Promise.all(images.map(async file => {
        const dataUrl = await fileToDataUrl(file)
        return window.universalAgent.attachmentFromDataUrl({
          name: file.name || `imagen-pegada-${Date.now()}.png`,
          dataUrl
        })
      }))
      setPendingAttachments(current => [...current, ...selected])
      return true
    } catch (error) {
      setAgentError(String(error))
      return false
    }
  }

  function fileToDataUrl(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(String(reader.result))
      reader.onerror = () => reject(reader.error ?? new Error('No se pudo leer la imagen.'))
      reader.readAsDataURL(file)
    })
  }

  async function addDroppedFiles(files: FileList): Promise<void> {
    const fileArray = Array.from(files)
    const paths = fileArray
      .map(file => window.universalAgent.filePathForDroppedFile(file))
      .filter(Boolean)

    if (paths.length === 0) {
      await attachImageFiles(fileArray)
      return
    }

    try {
      const selected = await window.universalAgent.attachmentsFromPaths(paths)
      if (selected.length === 0) return
      setPendingAttachments(current => [...current, ...selected])
    } catch (error) {
      setAgentError(String(error))
    }
  }

  async function pasteClipboardImages(): Promise<boolean> {
    if (!navigator.clipboard?.read) return false

    try {
      const items = await navigator.clipboard.read()
      const files: File[] = []
      for (const item of items) {
        const imageType = item.types.find(type => type.startsWith('image/'))
        if (!imageType) continue
        const blob = await item.getType(imageType)
        const ext = imageType.split('/')[1] || 'png'
        files.push(new File([blob], `imagen-pegada-${Date.now()}.${ext}`, { type: imageType }))
      }
      return attachImageFiles(files)
    } catch {
      return false
    }
  }

  async function handleComposerPaste(event: ClipboardEvent<HTMLTextAreaElement>): Promise<void> {
    const attached = await attachImageFiles(Array.from(event.clipboardData.files))
    if (attached) event.preventDefault()
  }

  function promptSelection(): { start: number; end: number; text: string } {
    const textarea = textareaRef.current
    const start = textarea?.selectionStart ?? 0
    const end = textarea?.selectionEnd ?? prompt.length
    return { start, end, text: prompt.slice(start, end) || prompt }
  }

  async function copyComposerText(): Promise<void> {
    const selection = promptSelection()
    if (selection.text) await navigator.clipboard.writeText(selection.text)
  }

  async function cutComposerText(): Promise<void> {
    const textarea = textareaRef.current
    const start = textarea?.selectionStart ?? 0
    const end = textarea?.selectionEnd ?? prompt.length
    const selected = prompt.slice(start, end)
    if (!selected) return
    await navigator.clipboard.writeText(selected)
    setPrompt(`${prompt.slice(0, start)}${prompt.slice(end)}`)
    requestAnimationFrame(() => textareaRef.current?.setSelectionRange(start, start))
  }

  async function pasteComposerText(): Promise<void> {
    if (await pasteClipboardImages()) return

    const text = await navigator.clipboard.readText()
    if (!text) return
    const textarea = textareaRef.current
    const start = textarea?.selectionStart ?? prompt.length
    const end = textarea?.selectionEnd ?? prompt.length
    setPrompt(`${prompt.slice(0, start)}${text}${prompt.slice(end)}`)
    requestAnimationFrame(() => {
      const position = start + text.length
      textareaRef.current?.focus()
      textareaRef.current?.setSelectionRange(position, position)
    })
  }

  /** Fix bug real (verificado con CDP real, click derecho en el composer):
   *  llamada directa (sin requestAnimationFrame) quedaba pisada por el
   *  re-render que dispara el propio menu contextual al cerrarse
   *  (setContextMenu(null), mismo handler) -- React reasigna `.value` en
   *  el <textarea> controlado al re-renderizar (aunque el string no
   *  cambie), y esa reasignacion colapsa el cursor al final, quirk ya
   *  evitado en cutComposerText()/pasteComposerText() (mismo archivo)
   *  con el mismo patron de requestAnimationFrame -- selectAllComposerText()
   *  era la unica de las 3 que no lo tenia. */
  function selectAllComposerText(): void {
    requestAnimationFrame(() => {
      const ta = textareaRef.current
      ta?.focus()
      ta?.setSelectionRange(0, ta.value.length)
    })
  }

  function selectProvider(provider: ProviderProfile): void {
    const model = pickModel(provider)
    setActiveChatModel(provider.id, model?.id)
    void disconnect()
  }

  function selectModel(provider: ProviderProfile, model: ModelProfile): void {
    setActiveChatModel(provider.id, model.id)
    setModelMenuOpen(false)
    setExpandedProviderId(null)
    void disconnect()
  }

  async function openMcpConfig(): Promise<void> {
    try {
      await api.openOrCreateMcpConfig()
    } catch (error) {
      setAgentError(String(error))
    }
  }

  // Registro de listeners de esta sesion -- una sola vez por instancia
  // (panelId estable durante toda la vida del panel).
  useEffect(() => {
    const stopAgent = api.onAgentEvent(handleAgentEvent)
    const stopIncomingMessage = api.onIncomingMessage(handleIncomingMessage)
    const stopToolApproval = api.onToolApprovalRequest(request => {
      setToolApprovalTrust(false)
      setToolApproval(request)
    })
    const stopToolTrust = api.onToolTrustChanged(state => setToolTrustActive(state.active))

    return () => {
      stopAgent()
      stopIncomingMessage()
      stopToolApproval()
      stopToolTrust()
      clearTurnWatch()
    }
  }, [panelId])

  useEffect(() => {
    activeChatIdRef.current = chatId
  }, [chatId])

  useEffect(() => {
    if (!turnActive) return
    const id = setInterval(() => {
      if (turnStartRef.current !== null) {
        setTurnElapsedSeconds(Math.floor((Date.now() - turnStartRef.current) / 1000))
      }
    }, 1000)
    return () => clearInterval(id)
  }, [turnActive])

  /** Fase Paneles-2b: reemplaza a switchToProject()/openProject() del
   *  diseño anterior -- ya no hace falta un llamado imperativo separado
   *  para "conectar el workspace de este proyecto": cuando App() decide
   *  que este panel muestra otro chatId, `activeWorkspacePath` cambia solo
   *  (se deriva de activeChat), y este efecto reacciona conectando el
   *  workspace nuevo + desconectando el agente (mismo criterio que ya
   *  tenia openProject(): un cambio de chat activo puede dejar la conexion
   *  en vuelo atada al chat viejo). No dispara en el primer render si el
   *  workspace inicial ya es el que main tiene (lastConnectedWorkspaceRef
   *  arranca undefined -- primer chatId real SIEMPRE conecta, igual que
   *  bootstrap() hacia antes con next.activeProjectPath). */
  useEffect(() => {
    if (activeWorkspacePath && activeWorkspacePath !== lastConnectedWorkspaceRef.current) {
      lastConnectedWorkspaceRef.current = activeWorkspacePath
      void api.openWorkspace(activeWorkspacePath).catch(() => {})
      onWorkspaceConnected(activeWorkspacePath)
    }
    setAgentState('idle')
    setAgentRuntime('')
    setAgentError('')
    void disconnect()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatId])

  // Desconexion generalizada (ver catalogChangeNonce en ChatPanelProps) --
  // no dispara en el montaje inicial (el ref arranca igual al valor de la
  // primera prop recibida).
  useEffect(() => {
    if (catalogChangeNonceRef.current === catalogChangeNonce) return
    catalogChangeNonceRef.current = catalogChangeNonce
    setAgentState('idle')
    setAgentRuntime('')
    setAgentError('')
    void disconnect()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [catalogChangeNonce])

  // Fix real (docs/_arch/verify_connection_editing_bug.md, Tarea 4):
  // pickProvider() (mas arriba) ya caia en silencio a otra conexion cuando
  // activeChat.providerId no matcheaba ninguna real -- sin este efecto, el
  // usuario nunca se enteraba de que este chat quedo con un proveedor
  // huerfano hasta notar el modelo equivocado en el acordeon. activeChat.
  // providerId truthy en la condicion: un chat que NUNCA tuvo proveedor
  // asignado (chat nuevo, todavia sin conectar) no es un huerfano real, no
  // corresponde avisar nada ahi. Reusa agentError/setAgentError -- ya
  // cableado y renderizado por panel, sin estado de UI nuevo.
  //
  // Bug real encontrado en la verificacion en vivo (no anticipado):
  // deleteProvider() dispara disconnectAllPanels() (bumpea
  // catalogChangeNonce), y el efecto de arriba hace setAgentError('') --
  // si este efecto corria ANTES que ese (estaba declarado mas arriba en el
  // archivo, junto a activeModel), React lo ejecutaba primero y el reset
  // de arriba pisaba el aviso en el MISMO commit. Declarado ACA, despues
  // del efecto de catalogChangeNonce, y con catalogChangeNonce en las deps
  // -- mismo commit, pero corre segundo, así que el aviso sobrevive.
  //
  // REGLA GENERAL (por que el orden de declaracion importa aca): dentro de
  // UN MISMO componente, cuando varios useEffect comparten una dependencia
  // que cambia en el mismo render, React los ejecuta en el ORDEN EN QUE
  // ESTAN DECLARADOS en el archivo -- no por prioridad, no por cual
  // "importa mas". El ultimo en correr es el que gana si los dos escriben
  // el mismo estado (agentError, en este caso). ESTE efecto depende a
  // proposito de correr DESPUES del efecto de catalogChangeNonce (linea
  // 2217) -- si algun refactor futuro reordena estos dos bloques (o mueve
  // este efecto mas arriba, junto a activeModel, como estaba originalmente
  // antes de este fix), la carrera vuelve EN SILENCIO: compila limpio,
  // typecheck limpio, y el aviso de proveedor huerfano deja de aparecer
  // sin ningun error visible -- exactamente el bug que esta verificacion
  // encontro. Si se reordena, volver a verificar en vivo contra la app
  // empaquetada (no alcanza con revision estatica de codigo -- asi paso
  // desapercibido la primera vez).
  useEffect(() => {
    if (activeChat.providerId && activeProvider?.id !== activeChat.providerId) {
      setAgentError(
        activeProvider
          ? `El proveedor configurado para este chat ya no existe — usando ${providerIdentity(activeProvider).name} temporalmente.`
          : 'El proveedor configurado para este chat ya no existe, y no hay ninguna conexion habilitada para usar en su lugar.'
      )
    }
  }, [activeChat.providerId, activeProvider?.id, catalogChangeNonce])

  // Reporte de estado hacia App() -- ver PanelStatus.
  useEffect(() => {
    onStatusChange(panelId, {
      chatId: activeChat.id,
      chatTitle: activeChat.title,
      workspacePath: activeChat.workspacePath,
      workspaceName: activeChat.workspaceName,
      agentState,
      agentRuntime,
      providerId: activeProvider?.id,
      modelId: activeModel?.id
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [panelId, activeChat.id, activeChat.title, activeChat.workspacePath, activeChat.workspaceName, agentState, agentRuntime, activeProvider?.id, activeModel?.id])

  // Reporte de aprobaciones pendientes hacia App() -- ver ApprovalHandle.
  useEffect(() => {
    onApprovalChange(panelId, approval ? { approval, onAnswer: decision => void answerApproval(decision) } : null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [panelId, approval])

  useEffect(() => {
    onToolApprovalChange(panelId, toolApproval ? {
      title: toolApproval.title,
      detail: toolApproval.detail,
      trust: toolApprovalTrust,
      onToggleTrust: setToolApprovalTrust,
      onAnswer: approved => void answerToolApproval(approved)
    } : null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [panelId, toolApproval, toolApprovalTrust])

  /** Fase Paneles-3: paso 2 del handshake de auto-open+connect -- el
   *  ChatPanel NUNCA se conecta solo al montarse (confirmado en la
   *  investigacion, Tarea 1), asi que App() le pide explicitamente a
   *  ESTE panel que se conecte via `autoConnectRequestId` (no-null solo
   *  mientras hay un pedido pendiente para su propio panelId). Mensaje de
   *  error deliberadamente generico si falla -- connectAgent() ya deja el
   *  detalle real en `agentError` (estado de React, no legible de forma
   *  sincronica recien resuelto el await sin caer en el mismo problema de
   *  closure-congelada ya resuelto para turnWatchdogMsRef/turnStepsRef en
   *  otras fases de este archivo); alcanza con saber que fallo, el error
   *  detallado ya quedo visible en este panel para quien lo mire. */
  useEffect(() => {
    if (!autoConnectRequestId) return
    let cancelled = false
    void (async () => {
      const ok = await connectAgent()
      if (cancelled) return
      onAutoConnectResult(ok, ok ? undefined : 'No se pudo conectar el agente automaticamente (revisar la configuracion del proveedor/modelo de este chat).')
    })()
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoConnectRequestId])

  const missing = readiness()
  const providerMode = activeProvider ? providerModeLabel(activeProvider) : 'Sin conexion'
  const headerIdentity = activeProvider ? providerIdentity(activeProvider) : { name: 'Sin conexion', initial: '?', ...PROVIDER_BRAND.neutral }
  // Fix real de UI (docs/_arch/verify_ui_paneles_0_9_0.md, Problema 1):
  // chatBorderAccent() ya existia (Fase arbol de sub-chats) pero SOLO se
  // aplicaba al borde izquierdo de las filas del sidebar -- nunca al
  // contenedor del panel. Reusada tal cual (mismo color que el badge del
  // header y que el arbol), como borde izquierdo del panel COMPLETO --
  // visible en los 3 paneles siempre, no solo en el enfocado (eso sigue
  // siendo el aro gris de .chat-panel.focused, senal distinta y ortogonal).
  const panelAccent = chatBorderAccent(activeChat, settings.providers)

  return (
    <div
      className={isFocused ? 'chat-panel focused' : 'chat-panel'}
      style={{ borderLeft: `3px solid ${panelAccent}` }}
      onMouseDown={onFocus}
    >
      <div className="panel-header">
        <div className="panel-header-identity">
          <ProviderBadge identity={headerIdentity} size={26} />
          {/* PIEZA 2 de la numeracion visual (docs/_arch/
              verify_panel_orchestrator.md): reemplaza el nombre del
              workspace -- ya visible en el titulo general de la app, esto
              era una redundancia real -- por la posicion del panel
              (1-based, panelIndex, prop derivada de openPanels.map() en
              App()). Eje puramente visual, sin relacion con "principal"
              (Pieza 1). */}
          <span className="panel-header-title">{panelIndex}</span>
        </div>
        <div className="panel-header-actions">
          <div className="model-anchor">
            <button
              className="model-btn"
              onClick={() => {
                const next = !modelMenuOpen
                setModelMenuOpen(next)
                setExpandedProviderId(next ? (activeProvider?.id ?? null) : null)
              }}
            >
              <span>{activeModel?.displayName ?? 'Modelo'}</span><span>⌄</span>
            </button>
            {modelMenuOpen && (
              <div className="model-menu">
                {providersForDisplay(settings.providers).filter(provider => provider.enabled).map(provider => {
                  const enabledModels = provider.models.filter(model => model.enabled)
                  if (enabledModels.length === 0) return null
                  const identity = providerIdentity(provider)
                  const isOpen = expandedProviderId === provider.id
                  return (
                    <div key={provider.id} className={isOpen ? 'provider-group open' : 'provider-group'}>
                      <button
                        className="provider-header"
                        onClick={() => setExpandedProviderId(current => current === provider.id ? null : provider.id)}
                      >
                        <ProviderBadge identity={identity} size={24} />
                        <span>{identity.name}</span>
                        <MethodPill provider={provider} />
                        <span className="chev">⌄</span>
                      </button>
                      <div className="model-sublist">
                        {enabledModels.map(model => {
                          const selected = activeModel?.id === model.id
                          return (
                            <button
                              key={model.id}
                              className={selected ? 'model-item selected' : 'model-item'}
                              style={selected ? { color: identity.accent } : undefined}
                              onClick={() => selectModel(provider, model)}
                            >
                              {model.displayName}
                            </button>
                          )
                        })}
                      </div>
                    </div>
                  )
                })}
                <div className="menu-divider" />
                <button
                  className="menu-settings"
                  onClick={() => {
                    setModelMenuOpen(false)
                    setExpandedProviderId(null)
                  }}
                >
                  Configurar modelos y cuentas... (Modelos y cuentas, arriba)
                </button>
              </div>
            )}
          </div>
          {/* UI, Pieza 1: .mcp.json + Eventos, movidos detras de este menu
              compartido -- mismos 2 controles identificados como de menor
              frecuencia real de uso (verify_ui_sidebar_header.md Tarea 1).
              Modelo/Panel/× siguen visibles, sin cambio. */}
          <button
            className="topbar-btn"
            title="Más acciones"
            onClick={event => onContextMenuRequest({
              type: 'panelHeader',
              x: event.clientX,
              y: event.clientY,
              onOpenMcpConfig: () => void openMcpConfig(),
              mcpDisabled: !activeWorkspacePath,
              onToggleDebug: () => setDebugOpen(value => !value),
              eventsCount: agentEvents.length
            })}
          >
            ⋯
          </button>
          <button className="topbar-btn" title="Agregar este chat en un panel nuevo" onClick={onAddPanelForThisChat}>
            ⧉ Panel
          </button>
          {canClose && (
            <button className="topbar-btn panel-close" title="Cerrar panel" onClick={onClose}>
              ×
            </button>
          )}
        </div>
      </div>

      <section className={dragActive ? 'chat drag-active' : 'chat'}>
        <div className="messages">
          {currentMessages.length === 0 ? (
            <div className="empty-chat">
              <img className="empty-logo" src={amatistaLogo} alt="" />
              <h1>{activeWorkspaceName ? `Trabajar en ${activeWorkspaceName}` : activeChat.title}</h1>
              <p>Puedes chatear sin workspace y cambiar de modelo sin perder contexto.</p>
            </div>
          ) : currentMessages.map(message => (
            <div
              key={message.id}
              className={message.crossWindow ? `message ${message.role} cross-window` : `message ${message.role}`}
              style={message.crossWindow ? {
                borderLeft: `3px solid ${crossWindowBrand(message.crossWindow).accent}`,
                boxShadow: `0 0 0 1px ${crossWindowBrand(message.crossWindow).halo}`
              } : undefined}
              onContextMenu={event => {
                event.preventDefault()
                onContextMenuRequest({
                  type: 'message',
                  x: event.clientX,
                  y: event.clientY,
                  text: message.text,
                  onCopy: () => void navigator.clipboard.writeText(message.text),
                  onEdit: message.role === 'user' ? () => void startEditMessage(message) : undefined,
                  onRegenerate: message.role === 'assistant' ? () => void regenerateFrom(message) : undefined
                })
              }}
            >
              {message.crossWindow && (
                <div
                  className="cross-window-badge"
                  style={{ color: crossWindowBrand(message.crossWindow).accent }}
                  title={`Recibido de la ventana "${message.crossWindow.windowLabel}"`}
                >
                  ⇄ {message.crossWindow.windowLabel}
                </div>
              )}
              <ChatMessageView message={message} onOpenImage={onOpenImage} />
              {message.role === 'assistant' && message.toolSteps && message.toolSteps.length > 0 && (
                <div className="turn-steps-summary">
                  <button
                    className="turn-steps-toggle"
                    onClick={() => toggleStepsExpanded(message.id)}
                  >
                    <span className={expandedSteps.has(message.id) ? 'turn-steps-chevron expanded' : 'turn-steps-chevron'}>
                      ›
                    </span>
                    {summarizeToolSteps(message.toolSteps)}
                  </button>
                  {expandedSteps.has(message.id) && (
                    <div className="turn-steps-detail">
                      {message.toolSteps.map((step, index) => (
                        <div key={index} className="turn-step-line">{step}</div>
                      ))}
                    </div>
                  )}
                </div>
              )}
              {message.role === 'user' && (
                <button
                  className="message-action-btn"
                  title="Editar mensaje"
                  onClick={() => void startEditMessage(message)}
                >✎</button>
              )}
              {message.role === 'assistant' && (
                <button
                  className="message-action-btn"
                  title="Regenerar respuesta"
                  onClick={() => void regenerateFrom(message)}
                >⟳</button>
              )}
            </div>
          ))}
          {turnActive && turnSteps.length > 0 && (
            <div className="turn-steps-log">
              {turnSteps.map((step, index) => (
                <div key={index} className="turn-step-line">{step}</div>
              ))}
            </div>
          )}
        </div>

        <div className="composer-zone">
          <div className="state-strip">
            {turnActive && (
              <div className="live-status-line">
                <img src={amatistaLogo} alt="" className="live-status-logo" />
                <span className="live-status-text">{toolStatus || 'Pensando...'}</span>
                <span className="live-status-meta">
                  {turnElapsedSeconds}s
                  {turnTokens !== null ? ` · ${turnTokens.toLocaleString('es-CR')} tokens` : ''}
                </span>
              </div>
            )}
            <div className="state-pills">
              <span className={activeWorkspaceName ? 'state-pill ok' : 'state-pill'}>
                {activeWorkspaceName ? `Workspace · ${activeWorkspaceName}` : 'Chat sin workspace'}
              </span>
              <span className={activeProvider ? 'state-pill ok' : 'state-pill'}>
                {activeProvider ? `${providerIdentity(activeProvider).name} · ${providerMode}` : 'Sin proveedor'}
              </span>
              <span className={activeModel ? 'state-pill ok' : 'state-pill'}>
                {activeModel?.displayName ?? 'Sin modelo'}
              </span>
              <span
                className={
                  agentState === 'connected'
                    ? 'state-pill connected'
                    : agentState === 'error'
                      ? 'state-pill error'
                      : 'state-pill'
                }
              >
                {agentState === 'connected'
                  ? `Agente · ${agentRuntime}`
                  : agentState === 'connecting'
                    ? 'Conectando...'
                    : agentState === 'error'
                      ? 'Error en el agente'
                      : 'Agente sin iniciar'}
              </span>
              {toolTrustActive && (
                <span className="state-pill trust-active">
                  Modo confianza activo
                  <button
                    className="trust-disable-btn"
                    onClick={() => void api.disableToolTrust()}
                  >
                    Desactivar
                  </button>
                </span>
              )}
            </div>
            {missing && <div className="state-warning">{missing}</div>}
            {agentError && <div className="state-error">{agentError}</div>}
          </div>

          <div
            className={dragActive ? 'composer composer-drop-active' : 'composer'}
            onContextMenu={event => {
              event.preventDefault()
              onContextMenuRequest({
                type: 'composer',
                x: event.clientX,
                y: event.clientY,
                onCut: () => void cutComposerText(),
                onCopy: () => void copyComposerText(),
                onPaste: () => void pasteComposerText(),
                onSelectAll: () => selectAllComposerText()
              })
            }}
            onDragEnter={event => {
              event.preventDefault()
              setDragActive(true)
            }}
            onDragOver={event => {
              event.preventDefault()
              setDragActive(true)
            }}
            onDragLeave={event => {
              if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
                setDragActive(false)
              }
            }}
            onDrop={event => {
              event.preventDefault()
              setDragActive(false)
              void addDroppedFiles(event.dataTransfer.files)
            }}
          >
            {pendingAttachments.length > 0 && (
              <div className="pending-attachments">
                {pendingAttachments.map(attachment => (
                  <AttachmentCard
                    key={attachment.id}
                    attachment={attachment}
                    mode="pending"
                    onOpenImage={onOpenImage}
                    onRemove={() => setPendingAttachments(current => current.filter(item => item.id !== attachment.id))}
                  />
                ))}
              </div>
            )}
            <textarea
              ref={textareaRef}
              value={prompt}
              placeholder="Pide lo que quieras"
              onContextMenu={event => {
                event.preventDefault()
                event.stopPropagation()
                onContextMenuRequest({
                  type: 'composer',
                  x: event.clientX,
                  y: event.clientY,
                  onCut: () => void cutComposerText(),
                  onCopy: () => void copyComposerText(),
                  onPaste: () => void pasteComposerText(),
                  onSelectAll: () => selectAllComposerText()
                })
              }}
              onPaste={event => void handleComposerPaste(event)}
              onChange={event => setPrompt(event.target.value)}
              onKeyDown={event => {
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault()
                  void sendPrompt()
                }
              }}
            />

            <div className="composer-row">
              <button
                className="attach-btn"
                title="Agregar archivos o imagenes"
                onClick={() => void pickAttachments()}
              >
                +
              </button>
              <select
                value={sandbox}
                onChange={event => {
                  setSandbox(event.target.value as SandboxMode)
                  void disconnect()
                }}
              >
                <option value="read-only">Solo lectura</option>
                <option value="workspace-write">Workspace</option>
                <option value="danger-full-access">Acceso completo</option>
              </select>

              {effortOptions && (
                <select
                  value={effort}
                  onChange={event => setEffort(event.target.value)}
                  title="Nivel de esfuerzo/razonamiento para el proximo turno. Sin seleccion = default del runtime, no se manda ningun valor."
                >
                  <option value="">Esfuerzo: por defecto</option>
                  {effortOptions.map(level => (
                    <option key={level} value={level}>{level}</option>
                  ))}
                </select>
              )}

              <div className="grow" />

              {agentState !== 'connected' && (
                <button
                  className="connect-btn"
                  disabled={Boolean(missing) || agentState === 'connecting'}
                  onClick={() => void connectAgent()}
                >
                  {agentState === 'connecting' ? 'Conectando...' : 'Conectar agente'}
                </button>
              )}

              {turnActive ? (
                <button
                  className="send-btn stop-btn"
                  title="Detener generacion"
                  onClick={() => void cancelAgent()}
                >■</button>
              ) : (
                <button
                  className="send-btn"
                  disabled={agentState === 'connecting'}
                  onClick={() => void sendPrompt()}
                >↑</button>
              )}
            </div>
          </div>

          {debugOpen && (
            <div className="agent-debug-panel">
              <div className="debug-header">
                <strong>Eventos del agente</strong>
                <button
                  className="debug-clear"
                  onClick={() => setAgentEvents([])}
                >
                  Limpiar
                </button>
              </div>
              <pre>
                {agentEvents.length
                  ? agentEvents.join('\n\n')
                  : 'Sin eventos todavia. Si envias un mensaje y esto queda vacio, el problema esta antes del streaming: conexion, thread/start o turn/start.'}
              </pre>
            </div>
          )}
        </div>
      </section>
    </div>
  )
}

export default function App() {
  const [settings, setSettings] = useState<AppSettings>({ providers: [], projectRoots: [] })
  const [projects, setProjects] = useState<ProjectEntry[]>([])
  const [chatSessions, setChatSessions] = useState<ChatSession[]>([generalChatSession()])
  const [chats, setChats] = useState<Record<string, ChatMessage[]>>({})
  const [imagePreview, setImagePreview] = useState<ImagePreviewState | null>(null)
  const [contextMenu, setContextMenu] = useState<ContextMenuState>(null)
  // UI, Pieza 2 (docs/_arch/verify_ui_sidebar_header.md Tarea 5): 1 estado
  // nuevo, sin persistir entre reinicios a proposito (mismo criterio que
  // modelMenuOpen/settingsOpen -- estado de UI efimero, no una preferencia
  // que amerite su propio round-trip a settings.json). El grid raiz
  // (.app, main.css) ya tenia una sola propiedad controlando el ancho del
  // sidebar (grid-template-columns) -- confirmado en la investigacion que
  // no hacia falta ninguna reestructuracion de layout para esto.
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [codexAccount, setCodexAccount] = useState<CodexAccountView>({ connected: false })
  const [cliStatus, setCliStatus] = useState<{ codex?: CliStatus; claude?: CliStatus; antigravity?: CliStatus }>({})
  const [authBusy, setAuthBusy] = useState(false)
  const [notice, setNotice] = useState('')
  const [openAiChatCatalog, setOpenAiChatCatalog] = useState<OpenAiChatCatalogModel[] | null>(null)
  const [openAiChatCatalogQuery, setOpenAiChatCatalogQuery] = useState('')
  const [openAiChatCatalogShowAll, setOpenAiChatCatalogShowAll] = useState(false)
  const [isFullscreen, setIsFullscreen] = useState(false)
  const [defaultWorkspace, setDefaultWorkspace] = useState<{ path: string; name: string } | null>(null)
  const [editingChatId, setEditingChatId] = useState<string | null>(null)
  const [editingChatTitle, setEditingChatTitle] = useState('')
  // Fix real (docs/_arch/verify_connection_editing_bug.md): desde f9a5d2d
  // (Paneles-2b) no habia forma de editar nombre/authMode/endpoint/apiKey
  // de una conexion ya creada -- confirmado que no hay ningun mecanismo
  // existente reusable para el trigger (focusedProvider/focusedPanelId solo
  // se activa clickeando DENTRO de un panel de chat, nunca desde una fila
  // de "Conexiones", ver confirmacion puntual previa). Estado dedicado,
  // independiente del bloque de catalogo (focusedProvider) que sigue sin
  // tocarse. editForm es null mientras no se esta editando nada; se llena
  // al entrar en modo edicion (valores actuales del provider) y se
  // descarta al cancelar/guardar -- edicion local hasta que el usuario
  // confirma "Guardar" (updateProvider real recien ahi, con save:true).
  const [editingProviderId, setEditingProviderId] = useState<string | null>(null)
  const [editForm, setEditForm] = useState<{ name: string; authMode: AuthMode; endpoint: string; apiKey: string } | null>(null)

  // Fase Paneles-2b: broadcast crudo-pero-seguro (ver ChatPanelProps) --
  // cualquier accion de Configuracion que hoy "cambia el catalogo" bumpea
  // esto, y CADA panel abierto reacciona desconectandose. Generaliza el
  // `void disconnect()` incondicional que ya tenian estas mismas acciones
  // antes de esta fase (una sola conexion implicita) a N paneles reales.
  const [catalogChangeNonce, setCatalogChangeNonce] = useState(0)
  function disconnectAllPanels(): void {
    setCatalogChangeNonce(current => current + 1)
  }

  // Fase Paneles-2b: openPanels/focusedPanelId (Tarea 3 de la
  // investigacion, confirmado que hacia falta un concepto nuevo) +
  // panelStatuses/panelApprovals/panelToolApprovals (lo que cada
  // <ChatPanel> reporta hacia arriba, ver PanelStatus/ApprovalHandle).
  const [openPanels, setOpenPanels] = useState<PanelEntry[]>([])
  /** Fix bug real (docs/_arch/verify_panel_race.md): mismo patron de
   *  ref-espejo ya usado en esta app (activeChatIdRef/turnStepsRef,
   *  ChatPanel) -- openChatInPanel() necesita devolver el panelId real al
   *  llamador ANTES de que termine la funcion, pero cuando se dispara
   *  desde un callback nativo de IPC (panel:openAndConnectRequest, fuera
   *  del sistema de eventos sinteticos de React) el updater de
   *  setOpenPanels() NO corre sincronicamente -- confirmado con logging
   *  real: openChatInPanel() retornaba antes de que el updater se
   *  ejecutara ni una vez, siempre devolviendo null. openPanelsRef se
   *  actualiza tanto por el useEffect (mismo patron que el resto de la
   *  app, cubre re-renders normales) COMO manualmente dentro de
   *  openChatInPanel() mismo (para que el valor ya este actualizado
   *  ANTES del return, sin esperar el proximo render). */
  const openPanelsRef = useRef(openPanels)
  useEffect(() => {
    openPanelsRef.current = openPanels
  }, [openPanels])
  const [focusedPanelId, setFocusedPanelId] = useState<string | null>(null)
  const [panelStatuses, setPanelStatuses] = useState<Record<string, PanelStatus>>({})
  const [panelApprovals, setPanelApprovals] = useState<Record<string, ApprovalHandle | null>>({})
  const [panelToolApprovals, setPanelToolApprovals] = useState<Record<string, ToolApprovalHandle | null>>({})
  /** Fase Paneles-3: panelId -> requestId de main, solo mientras ESE panel
   *  tiene un pedido de auto-open+connect pendiente (ver
   *  handlePanelOpenAndConnectRequest()/handleAutoConnectResult() mas
   *  abajo). Vive en App() (shell), no en ChatPanel -- es el propio
   *  contenedor quien decide que panelId uso openChatInPanel() y quien
   *  necesita reportarle el resultado de vuelta a main. */
  const [pendingAutoConnect, setPendingAutoConnect] = useState<Record<string, string>>({})

  const focusedStatus = focusedPanelId ? panelStatuses[focusedPanelId] : undefined
  const visibleApproval = (focusedPanelId ? panelApprovals[focusedPanelId] : undefined)
    ?? Object.values(panelApprovals).find((value): value is ApprovalHandle => Boolean(value))
    ?? null
  const visibleToolApproval = (focusedPanelId ? panelToolApprovals[focusedPanelId] : undefined)
    ?? Object.values(panelToolApprovals).find((value): value is ToolApprovalHandle => Boolean(value))
    ?? null

  const compactionCandidates = useMemo(() => {
    return providersForDisplay(settings.providers)
      .filter(provider => provider.enabled)
      .flatMap(provider => provider.models
        .filter(model => model.enabled && isApiCapableModel(provider, model))
        .map(model => ({ provider, model })))
  }, [settings.providers])

  /** Feature "generacion de imagenes": mismo calculo exacto que
   *  compactionCandidates de arriba -- lista PARALELA, no compartida (el
   *  usuario puede elegir modelos distintos para cada cosa). El selector
   *  no filtra por isLikelyImageModel() a proposito: mostrar SOLO los que
   *  matchean la heuristica escondería un modelo real de imagenes con un
   *  nombre atipico -- la sugerencia implicita (resolveConfiguredImageGenerationModel(),
   *  main) es la que usa esa heuristica, no este selector. */
  const imageGenerationCandidates = useMemo(() => {
    return providersForDisplay(settings.providers)
      .filter(provider => provider.enabled)
      .flatMap(provider => provider.models
        .filter(model => model.enabled && isApiCapableModel(provider, model))
        .map(model => ({ provider, model })))
  }, [settings.providers])

  const panelsGridStyle = useMemo((): CSSProperties => {
    const count = openPanels.length
    if (count <= 1) return { gridTemplateColumns: '1fr', gridTemplateRows: '1fr' }
    if (count === 2) return { gridTemplateColumns: 'repeat(2, 1fr)', gridTemplateRows: '1fr' }
    if (count === 3) return { gridTemplateColumns: 'repeat(3, 1fr)', gridTemplateRows: '1fr' }
    return { gridTemplateColumns: 'repeat(2, 1fr)', gridTemplateRows: 'repeat(2, 1fr)' }
  }, [openPanels.length])

  useEffect(() => {
    void bootstrap()
    void window.universalAgent.getFullscreen().then(setIsFullscreen)
    const stopFullscreen = window.universalAgent.onFullscreenChanged(setIsFullscreen)
    return () => { stopFullscreen() }
  }, [])

  // Fase Paneles-3: listener a nivel de SHELL (no dentro de ChatPanel) --
  // ver onPanelOpenAndConnectRequest() en preload/index.ts. Suscrito una
  // sola vez (deps []), mismo criterio que el resto de los listeners de
  // esta app (onAgentEvent/onIncomingMessage en ChatPanel, onFullscreenChanged
  // aca mismo) -- seguro pese a que handlePanelOpenAndConnectRequest() se
  // recrea en cada render, porque su logica interna nunca lee estado
  // directo del closure (openChatInPanel()/setPendingAutoConnect() usan
  // siempre la forma funcional de setState).
  useEffect(() => {
    const stop = window.universalAgent.onPanelOpenAndConnectRequest(({ requestId, chatId }) => {
      handlePanelOpenAndConnectRequest(requestId, chatId)
    })
    return () => stop()
  }, [])

  useEffect(() => {
    document.title = `AMATISTA ${__APP_VERSION__}`
  }, [])

  useEffect(() => {
    const closeMenuByMouse = (event: MouseEvent) => {
      if (event.button === 2) return
      setContextMenu(null)
    }
    const closeMenuByBlur = () => setContextMenu(null)
    window.addEventListener('mousedown', closeMenuByMouse)
    window.addEventListener('blur', closeMenuByBlur)
    return () => {
      window.removeEventListener('mousedown', closeMenuByMouse)
      window.removeEventListener('blur', closeMenuByBlur)
    }
  }, [])

  async function persist(next: AppSettings): Promise<void> {
    setSettings(next)
    await window.universalAgent.saveSettings(next)
  }

  function mutateSettings(updater: (current: AppSettings) => AppSettings, save = false): void {
    setSettings(current => {
      const next = updater(current)
      if (save) void window.universalAgent.saveSettings(next)
      return next
    })
  }

  /** Fase Paneles-2b: reemplaza los usos de ensureStoredChat() que NO
   *  tienen (ni necesitan) un panel real conectado detras -- crear un chat
   *  en blanco (bootstrap/migracion/"+ Nuevo chat"/proyecto nuevo) nunca
   *  debe estampar un providerId/modelId ajeno, asi que esto persiste
   *  exactamente lo que el `chat` YA trae (normalmente nada, para uno
   *  nuevo; lo restaurado, para uno migrado) -- sin la logica de "si sos
   *  el chat activo, usa la sesion conectada" que ensureStoredChat() (ahora
   *  dentro de ChatPanel) SI necesita para su propio caso de uso real
   *  (bumpear provider/model tras un turno). */
  function persistChatSessionMeta(chat: ChatSession): void {
    void window.universalAgent.ensureChatSession({
      id: chat.id,
      title: chat.title,
      workspacePath: chat.workspacePath,
      workspaceName: chat.workspaceName,
      providerId: chat.providerId,
      modelId: chat.modelId,
      runtime: undefined,
      parentChatId: chat.parentChatId
    })
  }

  /** Fase Paneles-2b: unico punto real de "abrir un chat en un panel" --
   *  aplica la restriccion confirmada (mismo chat nunca en 2 paneles a la
   *  vez): si `chatId` ya esta abierto en algun panel, listo, solo enfoca
   *  ESE (nunca crea ni mueve nada mas). Si no, y se paso `targetPanelId`
   *  (un panel ya abierto), ese panel cambia de chat. Si no se paso
   *  ninguno (ej. "Agregar panel"), crea uno nuevo -- hasta MAX_PANELS.
   *
   *  Fase Paneles-3: 2 cambios sobre la version de Paneles-2b, ambos
   *  necesarios para el auto-open real, ninguno cambia el comportamiento
   *  para los call sites existentes (sidebar, "+ Nuevo chat", "Agregar
   *  panel"):
   *  (1) `window.alert()` -- BLOQUEANTE, congelaba TODA la app (los 4
   *      paneles, no solo el intento nuevo) hasta que un humano hacia
   *      click -- se reemplaza por `setNotice()`, el mismo mecanismo no
   *      bloqueante que ya usa el resto de la app. Critico para el
   *      auto-open: un pedido disparado por send_to_window puede no tener
   *      ningun humano mirando la pantalla en ese momento.
   *  (2) Devuelve el `panelId` real que termino usando (o `null` si
   *      rechazo por tope) -- el handshake de auto-open (ver
   *      handlePanelOpenAndConnectRequest() mas abajo) necesita saber
   *      exactamente que panel disparar a conectar.
   *
   *  Fix bug real (docs/_arch/verify_panel_race.md), confirmado con
   *  logging real: la afirmacion de que "React invoca el updater de
   *  forma sincronica al llamarlo" es FALSA cuando esta funcion se
   *  dispara desde un callback nativo de IPC (panel:openAndConnectRequest,
   *  fuera del sistema de eventos sinteticos de React) -- el updater de
   *  `setOpenPanels()` corria DESPUES de que la funcion ya habia hecho su
   *  `return`, devolviendo siempre `null` (el valor inicial nunca
   *  actualizado) sin importar el resultado real. `handlePanelOpenAndConnectRequest()`
   *  reportaba entonces el error hardcodeado de MAX_PANELS aunque el
   *  panel se abriera bien unos milisegundos despues.
   *
   *  Fix: el `panelId` que se devuelve se calcula ANTES, leyendo
   *  `openPanelsRef.current` (mismo patron de ref-espejo que
   *  activeChatIdRef/turnStepsRef en ChatPanel) -- sincronico de verdad,
   *  nunca depende de si React difiere el updater o no. El ref se
   *  actualiza manualmente aca mismo con la MISMA decision (ademas del
   *  useEffect que lo mantiene al dia en cada render), para que llamadas
   *  encadenadas en el mismo tick tambien vean el estado correcto.
   *  `setOpenPanels(current => {...})` sigue siendo la unica fuente real
   *  de verdad para el estado de React -- su logica interna no cambia,
   *  solo reusa el `panelId` ya decidido en vez de generar uno nuevo. */
  function openChatInPanel(chatId: string, targetPanelId?: string): string | null {
    const snapshot = openPanelsRef.current
    const alreadyOpen = snapshot.find(entry => entry.chatId === chatId)
    const targetIsOpen = !alreadyOpen && Boolean(targetPanelId) && snapshot.some(entry => entry.panelId === targetPanelId)
    const overCap = !alreadyOpen && !targetIsOpen && snapshot.length >= MAX_PANELS
    const candidatePanelId = alreadyOpen
      ? alreadyOpen.panelId
      : targetIsOpen
        ? targetPanelId!
        : overCap
          ? null
          : crypto.randomUUID()

    if (candidatePanelId && !alreadyOpen) {
      openPanelsRef.current = targetIsOpen
        ? snapshot.map(entry => entry.panelId === targetPanelId ? { ...entry, chatId } : entry)
        : [...snapshot, { panelId: candidatePanelId, chatId }]
    }

    setOpenPanels(current => {
      const already = current.find(entry => entry.chatId === chatId)
      if (already) {
        setFocusedPanelId(already.panelId)
        return current
      }
      if (targetPanelId && current.some(entry => entry.panelId === targetPanelId)) {
        setFocusedPanelId(targetPanelId)
        return current.map(entry => entry.panelId === targetPanelId ? { ...entry, chatId } : entry)
      }
      if (current.length >= MAX_PANELS) {
        setNotice(`Ya hay ${MAX_PANELS} paneles abiertos -- el maximo. Cerra uno para agregar otro.`)
        return current
      }
      setFocusedPanelId(candidatePanelId!)
      return [...current, { panelId: candidatePanelId!, chatId }]
    })

    return candidatePanelId
  }

  /** Fix bug real (docs/_arch/verify_panel_naming.md): resolveOrCreateChatForPath()
   *  con forceNew=true SIEMPRE crea un ChatSession nuevo, pero cada
   *  "Agregar panel" desde el mismo origen le pasaba el MISMO nombre
   *  (origin.workspaceName ?? origin.title) sin desambiguar -- 2 clicks
   *  seguidos producian 2 chats DISTINTOS (ids reales distintos) con el
   *  MISMO titulo. findChatSessionByTitle() (chat-store.ts), usado por
   *  send_to_window, resuelve por titulo via `ORDER BY updated_at DESC
   *  LIMIT 1` -- con titulos duplicados, un mensaje dirigido al panel
   *  "de antes" terminaba en el panel MAS RECIENTE con ese titulo (el
   *  que tuvo actividad ultimo), nunca en el que el usuario realmente
   *  queria. Mismo criterio case-insensitive que esa funcion (COLLATE
   *  NOCASE), pero contra `chatSessions` en memoria -- no hace falta
   *  otro roundtrip a SQLite, la lista ya esta completa en el renderer. */
  function generateUniquePanelTitle(baseName: string): string {
    let suffix = 2
    while (true) {
      const candidate = `${baseName} — Panel ${suffix}`
      const taken = chatSessions.some(chat => chat.title.toLowerCase() === candidate.toLowerCase())
      if (!taken) return candidate
      suffix += 1
    }
  }

  /** Fix bug real (docs/_arch/verify_workspace_name_conflation.md):
   *  resuelve la RAIZ REAL del grupo (mismo workspacePath) antes de
   *  generar el proximo nombre -- nunca asume que `origin.workspaceName`
   *  ya esta limpio, porque puede venir de datos viejos ya contaminados
   *  (bug de resolveOrCreateChatForPath(), ver ahi mismo) o de agregar un
   *  panel desde un panel que a su vez YA es hijo (no el principal).
   *  Prioridad: (1) origin mismo, si ya esta limpio -- caso normal, sin
   *  busqueda. (2) el primer hermano del mismo workspacePath con
   *  workspaceName limpio -- la fuente de verdad real cuando sobrevive.
   *  (3) el primer hermano sin parentChatId (raiz por linaje) -- si ni
   *  siquiera queda un nombre limpio en el grupo. (4) origin mismo --
   *  ultimo fallback, `origin` siempre esta incluido en `siblings` asi
   *  que en la practica nunca hace falta llegar aca. */
  function resolveGroupRoot(origin: ChatSession): ChatSession {
    if (!PANEL_SUFFIX_RE.test(origin.workspaceName ?? origin.title)) return origin
    const siblings = chatSessions.filter(chat => chat.workspacePath === origin.workspacePath)
    return (
      siblings.find(chat => !PANEL_SUFFIX_RE.test(chat.workspaceName ?? chat.title)) ??
      siblings.find(chat => !chat.parentChatId) ??
      origin
    )
  }

  /** Fix bug real (docs/_arch/verify_panel_bugs.md, Tarea 0 del FIX 2):
   *  "Agregar panel" desde un chat con workspace debe crear un chat
   *  NUEVO en ese mismo workspace y abrirlo en un panel nuevo -- nunca
   *  reabrir/enfocar el chat de origen (ese era el bug: openChatInPanel
   *  con el chatId de origen solo enfocaba el panel existente, via la
   *  regla de no-duplicados, en vez de agregar nada). Sin workspacePath
   *  en el chat de origen (chat general) no hay nada que replicar --
   *  se avisa claro, sin abrir ningun panel.
   *
   *  Fix bug real (docs/_arch/verify_workspace_name_conflation.md): el
   *  nuevo hijo es siempre hermano de la RAIZ REAL del grupo
   *  (resolveGroupRoot()), nunca hijo directo de `origin` si `origin` a
   *  su vez ya era un hijo (contaminado o no) -- `parentChatId` apunta a
   *  `root.id`, y el nombre base para el titulo/workspaceName nuevo sale
   *  del nombre LIMPIO de esa raiz (con un ultimo strip de
   *  PANEL_SUFFIX_RE por si ni la raiz encontrada esta limpia, mejor
   *  esfuerzo documentado en la migracion real de chat-store.ts). */
  function addPanelForChat(chatId: string): void {
    const origin = chatSessions.find(chat => chat.id === chatId)
    if (!origin?.workspacePath) {
      setNotice('Este chat no tiene workspace -- no se puede agregar panel.')
      return
    }
    const root = resolveGroupRoot(origin)
    const rawRootName = root.workspaceName ?? root.title
    const baseName = PANEL_SUFFIX_RE.test(rawRootName) ? rawRootName.replace(PANEL_SUFFIX_RE, '') : rawRootName
    const uniqueTitle = generateUniquePanelTitle(baseName)
    const chat = resolveOrCreateChatForPath(origin.workspacePath, uniqueTitle, true, root.id, baseName)
    openChatInPanel(chat.id)
  }

  /** Fase Paneles-2b, Tarea 4: nunca cierra el ultimo panel (dejaria la
   *  app sin ninguna conversacion visible) -- mismo criterio conservador
   *  que datos que otras fases de esta app tratan como invariante minima
   *  (siempre hay al menos un chat/proyecto activo). Desconecta la sesion
   *  de ESE panel exactamente como ya se desconecta cualquier sesion hoy
   *  (api.disconnectAgent(), mismo call que disconnect() usa siempre). */
  /** Fix bug real (docs/_arch/verify_closepanel_race.md): openPanelsRef.current
   *  quedaba desincronizado hasta el proximo useEffect (que corre DESPUES
   *  del commit+paint -- ventana real medida ~4ms, no teorica). Si un
   *  auto-open del orquestador (send_to_window, medido real: ~17s desde
   *  la aprobacion hasta llegar al renderer -- ventana de oportunidad
   *  real, no un timing imposible) caia en esa ventana, openChatInPanel()
   *  leia el ref TODAVIA con el panel recien cerrado -- si ese panel
   *  mostraba justo el chat destino, `alreadyOpen` matcheaba la entrada
   *  stale y el codigo "resucitaba" el panel cerrado REUSANDO su mismo
   *  panelId (confirmado real 2 veces, mismo UUID en el log de
   *  closePanel() tras el "cierre" del panel resucitado), arrastrando
   *  cualquier estado viejo que hubiera quedado en sessionRegistry para
   *  ese id. Mismo patron de ref-espejo que openChatInPanel() ya usa para
   *  el caso inverso (abrir) -- el ref se actualiza ACA MISMO, sincronico,
   *  con el MISMO guard que el updater de abajo (nunca cierra el ultimo
   *  panel) para que ref y estado real de React nunca diverjan en que
   *  panel se cierra de verdad. setOpenPanels() sigue siendo la unica
   *  fuente real de verdad para el estado de React -- su logica interna
   *  no cambia. */
  function closePanel(panelId: string): void {
    if (openPanelsRef.current.length > 1 && openPanelsRef.current.some(entry => entry.panelId === panelId)) {
      openPanelsRef.current = openPanelsRef.current.filter(entry => entry.panelId !== panelId)
    }
    setOpenPanels(current => {
      if (current.length <= 1) return current
      const next = current.filter(entry => entry.panelId !== panelId)
      if (focusedPanelId === panelId) setFocusedPanelId(next[0]?.panelId ?? null)
      return next
    })
    void window.universalAgent.forPanel(panelId).disconnectAgent()
    setPanelStatuses(current => {
      const next = { ...current }
      delete next[panelId]
      return next
    })
    setPanelApprovals(current => {
      const next = { ...current }
      delete next[panelId]
      return next
    })
    setPanelToolApprovals(current => {
      const next = { ...current }
      delete next[panelId]
      return next
    })
    // Fase Paneles-3: si justo habia un pedido de auto-open+connect
    // pendiente para este panel y lo cerraron en el medio, no queda nadie
    // para reportarle el resultado a main -- se limpia el estado local
    // (para que no quede "colgado" visualmente) y el pedido en main se
    // resuelve solo, mas tarde, por el timeout real (nunca se cuelga
    // para siempre, ver PANEL_OPEN_AND_CONNECT_TIMEOUT_MS).
    setPendingAutoConnect(current => {
      if (!(panelId in current)) return current
      const next = { ...current }
      delete next[panelId]
      return next
    })
  }

  /** Fase Paneles-3: handshake completo, 2 pasos, disparado por el pedido
   *  real de main (send_to_window a un chat sin panel abierto). Paso 1:
   *  abrir/enfocar el chat -- SIEMPRE via openChatInPanel() real, nunca
   *  escribiendo setOpenPanels() directo (confirmado en la investigacion
   *  como el UNICO punto que preserva la proteccion de no-duplicados).
   *  Si el tope de MAX_PANELS lo rechaza (panelId === null), responde
   *  limpio de una -- no hay paso 2 que esperar. Paso 2: le pide a ESE
   *  panel especifico que se conecte solo (autoConnectRequestId), y la
   *  propia ChatPanel reporta el resultado real via
   *  handleAutoConnectResult() cuando termina. */
  function handlePanelOpenAndConnectRequest(requestId: string, chatId: string): void {
    const panelId = openChatInPanel(chatId)
    if (!panelId) {
      void window.universalAgent.respondPanelOpenAndConnect({
        requestId,
        success: false,
        error: `Ya hay ${MAX_PANELS} paneles abiertos -- el maximo. No se pudo auto-abrir uno mas.`
      })
      return
    }
    setPendingAutoConnect(current => ({ ...current, [panelId]: requestId }))
  }

  /** Fase Paneles-3: cierre del handshake -- llamado por el propio
   *  ChatPanel (`onAutoConnectResult`) cuando su intento de auto-conexion
   *  (disparado por el paso 2 de arriba) termina, exito o error. */
  function handleAutoConnectResult(panelId: string, success: boolean, error?: string): void {
    const requestId = pendingAutoConnect[panelId]
    if (!requestId) return
    setPendingAutoConnect(current => {
      const next = { ...current }
      delete next[panelId]
      return next
    })
    void window.universalAgent.respondPanelOpenAndConnect({
      requestId,
      success,
      panelId: success ? panelId : undefined,
      error
    })
  }

  function createBlankChat(): ChatSession {
    const inherited = focusedStatus?.workspacePath
      ? { workspacePath: focusedStatus.workspacePath, workspaceName: focusedStatus.workspaceName }
      : defaultWorkspace
        ? { workspacePath: defaultWorkspace.path, workspaceName: defaultWorkspace.name }
        : {}
    const chat: ChatSession = { id: crypto.randomUUID(), title: 'Chat nuevo', ...inherited }
    setChatSessions(current => [chat, ...current])
    persistChatSessionMeta(chat)
    return chat
  }

  function handleNewChatClick(): void {
    const chat = createBlankChat()
    openChatInPanel(chat.id, focusedPanelId ?? undefined)
    setNotice('')
  }

  /** FIX addPanelForChat (docs/_arch/verify_panel_bugs.md, Tarea 0 del
   *  FIX 2): logica real de "buscar el chat mas reciente de este path,
   *  o crear uno nuevo", extraida de resolveOrCreateProjectChat() para
   *  no depender de un ProjectEntry completo -- id/rootId son
   *  obligatorios en ese tipo (src/shared/types.ts) y no existen para
   *  un chat que nunca vino de un ProjectEntry real (ej. un chat
   *  general con workspacePath adjunto a mano). Unico punto real de
   *  creacion/reuso de un ChatSession por path, reusado por los 3 call
   *  sites (los 2 de proyecto + addPanelForChat).
   *
   *  Fix bug real (docs/_arch/verify_workspace_name_conflation.md):
   *  `title`/`workspaceName` eran el MISMO parametro (`name`) -- un
   *  "Agregar panel" grababa el titulo COMPUESTO ("X — Panel 2") como
   *  workspaceName del chat nuevo, en vez del nombre limpio del
   *  workspace. Encadenado, esto producia titulos tipo
   *  "X — Panel 2 — Panel 3" en el siguiente "Agregar panel". 5to
   *  parametro opcional `workspaceName` -- si se pasa, se usa tal cual;
   *  si no (los 2 call sites de proyecto no lo necesitan, `name` YA es
   *  el nombre limpio para esos casos), cae a `name` -- sin cambio de
   *  comportamiento para esos 2 casos. */
  function resolveOrCreateChatForPath(path: string, name: string, forceNew: boolean, parentChatId?: string, workspaceName?: string): ChatSession {
    if (!forceNew) {
      const existing = chatSessions
        .filter(chat => chat.workspacePath === path)
        .sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''))[0]
      if (existing) return existing
    }
    const chat: ChatSession = {
      id: crypto.randomUUID(),
      title: name,
      workspacePath: path,
      workspaceName: workspaceName ?? name,
      updatedAt: new Date().toISOString(),
      parentChatId
    }
    setChatSessions(current => [chat, ...current])
    persistChatSessionMeta(chat)
    return chat
  }

  function resolveOrCreateProjectChat(project: ProjectEntry, forceNew: boolean): ChatSession {
    return resolveOrCreateChatForPath(project.path, project.name, forceNew)
  }

  /** Fase 21.5, generalizado a paneles en Paneles-2b: clic normal en
   *  PROYECTOS -- vuelve al chat MAS RECIENTE con este workspacePath en el
   *  panel enfocado (o lo enfoca si ya esta abierto en otro panel, via la
   *  regla de no-duplicados de openChatInPanel). */
  function openProjectInFocusedPanel(project: ProjectEntry): void {
    const chat = resolveOrCreateProjectChat(project, false)
    openChatInPanel(chat.id, focusedPanelId ?? undefined)
  }

  /** Fase 21.5 Tarea 2, generalizado a paneles: SIEMPRE crea una sesion
   *  adicional en el panel enfocado, nunca reutiliza una existente. */
  function newProjectSessionInFocusedPanel(project: ProjectEntry): void {
    const chat = resolveOrCreateProjectChat(project, true)
    openChatInPanel(chat.id, focusedPanelId ?? undefined)
  }

  function updateProvider(
    providerId: string,
    updater: (provider: ProviderProfile) => ProviderProfile,
    save = false
  ): void {
    mutateSettings(current => ({
      ...current,
      providers: current.providers.map(provider =>
        provider.id === providerId ? updater(provider) : provider
      )
    }), save)
  }

  /** Fase Paneles-2b: equivalente shell-level de setActiveChatModel() (que
   *  ahora vive dentro de ChatPanel, para el caso del acordeon de modelo
   *  de CADA panel) -- usado solo por addProvider()/addDeepSeekProvider(),
   *  que se disparan desde Configuracion (sin ningun panel propio) pero
   *  necesitan dejar seleccionado el proveedor recien creado para ALGUN
   *  chat real: el del panel enfocado. */
  function setFocusedChatModel(providerId: string, modelId: string | undefined): void {
    const chatId = focusedPanelId ? openPanels.find(entry => entry.panelId === focusedPanelId)?.chatId : undefined
    if (!chatId) return
    const chat = chatSessions.find(item => item.id === chatId)
    setChatSessions(current => current.map(item => item.id === chatId ? { ...item, providerId, modelId } : item))
    void window.universalAgent.ensureChatSession({
      id: chatId,
      title: chat?.title ?? '',
      workspacePath: chat?.workspacePath,
      workspaceName: chat?.workspaceName,
      providerId,
      modelId,
      runtime: focusedStatus?.agentRuntime || undefined
    })
  }

  function addProvider(type: ProviderType, authMode: AuthMode): void {
    const provider = newProvider(type, authMode)
    mutateSettings(current => ({
      ...current,
      providers: [...current.providers, provider]
    }), true)
    setFocusedChatModel(provider.id, provider.models[0]?.id)
    disconnectAllPanels()
  }

  function addDeepSeekProvider(): void {
    const provider = newDeepSeekProvider()
    mutateSettings(current => ({
      ...current,
      providers: [...current.providers, provider]
    }), true)
    setFocusedChatModel(provider.id, provider.models[0]?.id)
    disconnectAllPanels()
  }

  function deleteProvider(providerId: string): void {
    const provider = settings.providers.find(item => item.id === providerId)
    if (!provider) return

    // Fix real (docs/_arch/verify_connection_editing_bug.md, Tarea 4):
    // borrar una conexion NO borra el historial de los chats que la usaban
    // (chat_sessions vive en SQLite, atado a chatId, no a providerId) pero
    // SI deja su providerId huerfano -- pickProvider() cae en silencio a
    // otra conexion en el proximo turno de esos chats, sin ningun aviso.
    // Conteo real ANTES de confirmar, no a ciegas.
    const affectedChats = chatSessions.filter(chat => chat.providerId === providerId).length
    const confirmMessage = affectedChats > 0
      ? `Eliminar la conexion "${provider.name}"? ${affectedChats} chat${affectedChats === 1 ? '' : 's'} que la usa${affectedChats === 1 ? '' : 'n'} pasara${affectedChats === 1 ? '' : 'n'} a otra conexion disponible.`
      : `Eliminar la conexion "${provider.name}"?`
    if (!window.confirm(confirmMessage)) return

    mutateSettings(current => {
      const providers = current.providers.filter(item => item.id !== providerId)
      const nextProvider = providers.find(item => item.enabled)
      const nextModel = pickModel(nextProvider)
      return {
        ...current,
        providers,
        activeProviderId: nextProvider?.id,
        activeModelId: nextModel?.id
      }
    }, true)
    disconnectAllPanels()
  }

  function toggleProvider(providerId: string): void {
    updateProvider(providerId, provider => ({ ...provider, enabled: !provider.enabled }), true)
    disconnectAllPanels()
  }

  function addManualModel(provider: ProviderProfile): void {
    const runtime = runtimeFor(provider.type, provider.authMode)
    const model: ModelProfile = {
      id: crypto.randomUUID(),
      providerId: provider.id,
      displayName: 'Nuevo modelo',
      model: '',
      runtime,
      enabled: true,
      capabilities: { tools: true, reasoning: true, vision: true, web: provider.type === 'google' }
    }
    updateProvider(provider.id, current => ({ ...current, models: [...current.models, model] }))
  }

  function deleteModel(providerId: string, modelId: string): void {
    mutateSettings(current => {
      const providers = current.providers.map(provider =>
        provider.id === providerId
          ? { ...provider, models: provider.models.filter(model => model.id !== modelId) }
          : provider
      )
      const provider = providers.find(item => item.id === providerId)
      const replacement = pickModel(provider)
      return {
        ...current,
        providers,
        activeModelId: current.activeModelId === modelId ? replacement?.id : current.activeModelId
      }
    }, true)
    disconnectAllPanels()
  }

  function toggleModel(providerId: string, modelId: string): void {
    updateProvider(providerId, provider => ({
      ...provider,
      models: provider.models.map(model =>
        model.id === modelId ? { ...model, enabled: !model.enabled } : model
      )
    }), true)
    disconnectAllPanels()
  }

  function setCompactionModel(providerId: string | undefined, modelId: string | undefined): void {
    mutateSettings(current => ({
      ...current,
      compactionProviderId: providerId,
      compactionModelId: modelId
    }), true)
  }

  /** Feature "generacion de imagenes": mismo patron exacto que
   *  setCompactionModel() de arriba -- funcion PARALELA, no compartida. */
  function setImageGenerationModel(providerId: string | undefined, modelId: string | undefined): void {
    mutateSettings(current => ({
      ...current,
      imageGenerationProviderId: providerId,
      imageGenerationModelId: modelId
    }), true)
  }

  async function toggleFullscreen(): Promise<void> {
    const next = await window.universalAgent.setFullscreen(!isFullscreen)
    setIsFullscreen(next)
  }

  async function openAgentsMd(): Promise<void> {
    const panelId = focusedPanelId
    if (!panelId) return
    try {
      const result = await window.universalAgent.forPanel(panelId).openOrCreateAgentsMd()
      setNotice(result.created
        ? 'AGENTS.md creado y abierto en el editor del sistema.'
        : 'AGENTS.md abierto en el editor del sistema.')
    } catch (error) {
      setNotice(String(error))
    }
  }

  async function syncCodexProvider(base: AppSettings, providerId: string): Promise<AppSettings> {
    const provider = base.providers.find(item => item.id === providerId)
    if (!provider) return base

    const catalog: CodexCatalogModel[] = await window.universalAgent.listCodexModels()
    const existing = new Map(provider.models.map(model => [model.model, model]))
    const oldActiveModel = provider.models.find(model => model.id === base.activeModelId)?.model

    const models: ModelProfile[] = catalog.map(item => {
      const previous = existing.get(item.id)
      const efforts = item.supportedReasoningEfforts.filter(
        effort => effort === 'low' || effort === 'medium' || effort === 'high'
      ) as Array<'low' | 'medium' | 'high'>

      return {
        id: previous?.id ?? crypto.randomUUID(),
        providerId: provider.id,
        displayName: item.displayName,
        model: item.id,
        runtime: 'codex-subscription',
        enabled: previous?.enabled ?? true,
        capabilities: { tools: true, reasoning: true, vision: true, web: false },
        reasoningLevels: efforts
      }
    })

    const replacement = models.find(m => m.model === oldActiveModel && m.enabled)
      ?? models.find(m => m.enabled)

    return {
      ...base,
      providers: base.providers.map(item => item.id === provider.id ? { ...item, models } : item),
      activeProviderId: base.activeProviderId ?? provider.id,
      activeModelId:
        base.activeProviderId === provider.id || !base.activeProviderId
          ? replacement?.id
          : base.activeModelId
    }
  }

  /** Fase Paneles-2b: `activeProvider` (panel-derivado) reemplazado por el
   *  provider del panel ENFOCADO (panelStatuses[focusedPanelId]) -- mismo
   *  hallazgo que ya anticipaba Paneles-2 Tarea 3 (Settings necesita saber
   *  desde que panel se abrio para acciones como esta). */
  async function syncCodexModels(): Promise<void> {
    const provider = settings.providers.find(p => p.id === focusedStatus?.providerId)
    if (!provider || provider.type !== 'openai-codex') return
    setAuthBusy(true)
    setNotice('Sincronizando catalogo Codex...')
    try {
      const next = await syncCodexProvider(settings, provider.id)
      await persist(next)
      setNotice('Modelos Codex actualizados.')
      disconnectAllPanels()
    } catch (error) {
      setNotice(String(error))
    } finally {
      setAuthBusy(false)
    }
  }

  async function syncOpenAiChatCatalog(): Promise<void> {
    const provider = settings.providers.find(p => p.id === focusedStatus?.providerId)
    if (!provider || provider.type !== 'openrouter') return
    setAuthBusy(true)
    setNotice('Consultando catalogo de modelos...')
    try {
      const catalog = await window.universalAgent.listOpenAiChatModels(provider.endpoint ?? '', provider.apiKey ?? '')
      setOpenAiChatCatalog(catalog)
      setOpenAiChatCatalogQuery('')
      setNotice(`Catalogo cargado: ${catalog.length} modelos.`)
    } catch (error) {
      setOpenAiChatCatalog(null)
      setNotice(String(error))
    } finally {
      setAuthBusy(false)
    }
  }

  function addCatalogModel(provider: ProviderProfile, item: OpenAiChatCatalogModel): void {
    const model: ModelProfile = {
      id: crypto.randomUUID(),
      providerId: provider.id,
      displayName: item.displayName,
      model: item.id,
      runtime: runtimeFor(provider.type, provider.authMode),
      enabled: true,
      capabilities: { tools: item.supportsTools, reasoning: true, vision: item.supportsVision, web: false },
      maxOutputTokens: item.maxOutputTokens
    }
    updateProvider(provider.id, current => ({ ...current, models: [...current.models, model] }))
    setNotice(`Agregado: ${item.displayName}.`)
  }

  async function loginCodex(): Promise<void> {
    setAuthBusy(true)
    setNotice('Abriendo login oficial de ChatGPT...')
    try {
      await window.universalAgent.loginCodexAccount()
      setNotice('Completa el login en el navegador. Detectando sesion...')

      for (let attempt = 0; attempt < 30; attempt += 1) {
        await new Promise(resolve => setTimeout(resolve, 2000))
        const parsed = parseCodexAccount(await window.universalAgent.readCodexAccount())
        setCodexAccount(parsed)
        if (!parsed.connected) continue

        let next = settings
        let provider = next.providers.find(
          p => p.type === 'openai-codex' && p.authMode === 'subscription'
        )
        if (!provider) {
          provider = newProvider('openai-codex', 'subscription')
          next = {
            ...next,
            providers: [provider, ...next.providers],
            activeProviderId: provider.id
          }
        }
        next = await syncCodexProvider(next, provider.id)
        await persist(next)
        setNotice('ChatGPT conectado y modelos Codex sincronizados.')
        break
      }
    } catch (error) {
      setNotice(String(error))
    } finally {
      setAuthBusy(false)
    }
  }

  async function checkCodexAccount(): Promise<void> {
    setAuthBusy(true)
    try {
      const parsed = parseCodexAccount(await window.universalAgent.readCodexAccount())
      setCodexAccount(parsed)
      const provider = settings.providers.find(p => p.id === focusedStatus?.providerId)
      if (parsed.connected && provider?.type === 'openai-codex') {
        await persist(await syncCodexProvider(settings, provider.id))
      }
      setNotice(parsed.connected ? 'Cuenta ChatGPT activa.' : 'No hay sesion ChatGPT activa.')
    } catch (error) {
      setNotice(String(error))
    } finally {
      setAuthBusy(false)
    }
  }

  async function logoutCodex(): Promise<void> {
    if (!window.confirm('Cerrar la sesion Codex / ChatGPT?')) return
    await window.universalAgent.logoutCodexAccount()
    setCodexAccount({ connected: false })
    setNotice('Sesion ChatGPT cerrada.')
    disconnectAllPanels()
  }

  async function refreshCliStatus(): Promise<void> {
    setCliStatus(await window.universalAgent.getCliStatus())
  }

  async function importQConfig(): Promise<void> {
    setAuthBusy(true)
    setNotice('Importando q_config.yaml...')

    try {
      const result = await window.universalAgent.importQConfig()

      if (result.canceled) {
        setNotice('Importacion cancelada.')
        return
      }

      setSettings(result.settings)
      await refreshCliStatus()
      disconnectAllPanels()

      setNotice(
        result.summary.length
          ? `q_config importado: ${result.summary.join(' ')}`
          : 'q_config importado.'
      )
    } catch (error) {
      setNotice(`ERROR importando q_config: ${String(error)}`)
    } finally {
      setAuthBusy(false)
    }
  }

  async function installClaudeCli(): Promise<void> {
    setAuthBusy(true)
    setNotice('Instalando Claude Code CLI con npm. Puede tardar varios minutos...')

    try {
      const result = await window.universalAgent.installClaudeCli()
      setCliStatus(await window.universalAgent.getCliStatus())
      setNotice(
        result.status?.installed
          ? `Claude Code CLI instalado: ${result.status.version ?? 'version detectada'}`
          : 'Instalacion ejecutada, pero Claude Code CLI todavia no fue detectado. Revisa PATH o reinicia la terminal.'
      )
    } catch (error) {
      setNotice(`ERROR instalando Claude Code CLI: ${String(error)}`)
    } finally {
      setAuthBusy(false)
    }
  }

  // Integracion de Antigravity CLI: mismo patron exacto que
  // installClaudeCli() de arriba.
  async function installAntigravityCli(): Promise<void> {
    setAuthBusy(true)
    setNotice('Instalando Antigravity CLI con el instalador oficial. Puede tardar varios minutos...')

    try {
      const result = await window.universalAgent.installAntigravityCli()
      setCliStatus(await window.universalAgent.getCliStatus())
      setNotice(
        result.status?.installed
          ? `Antigravity CLI instalado: ${result.status.version ?? 'version detectada'}`
          : 'Instalacion ejecutada, pero Antigravity CLI todavia no fue detectado. Revisa PATH o reinicia la terminal.'
      )
    } catch (error) {
      setNotice(`ERROR instalando Antigravity CLI: ${String(error)}`)
    } finally {
      setAuthBusy(false)
    }
  }

  /**
   * Reintegracion de claude-cli: generalizada de vuelta a los 2 CLIs por
   * suscripcion (antes solo Gemini, openGeminiCliLogin() de un solo tipo)
   * -- mismo IPC de siempre (auth:openCliLogin(providerType)), que ya
   * soportaba ambos del lado main (ver ipc-cli.ts) sin cambio. Integracion
   * de Antigravity CLI: generalizada de nuevo a 3 tipos, mismo IPC.
   *
   * Retiro de gemini-cli (docs/_arch/verify_gemini_cli_removal_scope.md,
   * verify_gemini_cli_removal.md): vuelve a 2 tipos -- 'google' salio del
   * parametro, ya no hay ningun CLI de Gemini que loguear.
   */
  async function openCliLogin(providerType: 'anthropic' | 'antigravity'): Promise<void> {
    const status = providerType === 'anthropic' ? cliStatus.claude : cliStatus.antigravity

    if (!status?.installed) {
      setNotice(
        providerType === 'anthropic'
          ? 'Claude Code CLI no esta instalado. Instalalo primero y despues pulsa Revisar CLI.'
          : 'Antigravity CLI no esta instalado. Instalalo primero y despues pulsa Revisar CLI.'
      )
      return
    }

    try {
      await window.universalAgent.openCliLogin(providerType)
      setNotice(
        providerType === 'anthropic'
          ? 'Se abrio Claude Code. Completa el login oficial alli.'
          : 'Se abrio Antigravity CLI. Completa el login con tu cuenta Google alli.'
      )
    } catch (error) {
      setNotice(String(error))
    }
  }

  function cliInstallHint(providerType: 'anthropic' | 'antigravity'): string {
    if (providerType === 'anthropic') return 'Instala Claude Code y verifica que el comando claude funcione en PowerShell o CMD.'
    return 'Instala Antigravity CLI con el boton Instalar Antigravity CLI; luego pulsa Revisar CLI.'
  }

  async function resetLocalState(): Promise<void> {
    const ok = window.confirm(
      'Esto borrara conexiones, modelos y carpetas raiz guardadas por Electron. No borra archivos del disco. Continuar?'
    )

    if (!ok) return

    const next = await window.universalAgent.resetLocalState()
    setSettings(next)
    setProjects([])
    setChats({})
    const firstChat = defaultWorkspace
      ? { ...generalChatSession(), workspacePath: defaultWorkspace.path, workspaceName: defaultWorkspace.name }
      : generalChatSession()
    setChatSessions([firstChat])
    persistChatSessionMeta(firstChat)
    const panelId = crypto.randomUUID()
    setOpenPanels([{ panelId, chatId: firstChat.id }])
    setFocusedPanelId(panelId)
    setPanelStatuses({})
    setPanelApprovals({})
    setPanelToolApprovals({})
    setNotice('Configuracion local reiniciada. Agrega una carpeta raiz nueva.')
    await refreshCliStatus()
  }

  async function removeProjectRoot(rootId: string): Promise<void> {
    const ok = window.confirm(
      'Quitar esta carpeta raiz de AMATISTA? No borra archivos del disco.'
    )

    if (!ok) return

    const next = await window.universalAgent.removeProjectRoot(rootId)
    setSettings(next)
    setProjects(await window.universalAgent.listProjects())
    setNotice('Carpeta raiz removida de la configuracion.')
    disconnectAllPanels()
  }

  /** Fix real de la carrera de settings:save (investigacion completa en
   *  docs/_arch/verify_settings_race.md): el invoke de arriba (Canal 1,
   *  projects:addRoot en main) YA agrego y persistio el root real a disco
   *  -- este mutateSettings() de abajo es SOLO para que React lo pinte en
   *  el sidebar sin esperar un reinicio, nunca para persistirlo de nuevo.
   *  Sin el flag de guardado (antes `true`): evita un segundo settings:save
   *  redundante que viajaba con `current` (la copia de React, nunca
   *  refrescada tras el arranque) -- era exactamente el vector que podia
   *  revertir en silencio un cambio autonomo de OTRO panel (ver
   *  ipc-settings.ts). */
  async function addProjectRoot(): Promise<void> {
    const root = await window.universalAgent.addProjectRoot()
    if (!root) return
    mutateSettings(current => ({
      ...current,
      projectRoots: [...current.projectRoots.filter(item => item.id !== root.id), root]
    }))
    setProjects(await window.universalAgent.listProjects())
  }

  function startRenameChat(chatId: string): void {
    const chat = chatSessions.find(item => item.id === chatId)
    if (!chat) return
    setEditingChatId(chatId)
    setEditingChatTitle(chat.title)
  }

  function cancelRenameChat(): void {
    setEditingChatId(null)
    setEditingChatTitle('')
  }

  function commitRenameChat(): void {
    if (!editingChatId) return
    const chatId = editingChatId
    const chat = chatSessions.find(item => item.id === chatId)
    const nextTitle = editingChatTitle.trim() || chat?.title || 'Chat nuevo'
    setEditingChatId(null)
    setEditingChatTitle('')
    if (!chat || nextTitle === chat.title) return
    setChatSessions(current => current.map(item =>
      item.id === chatId ? { ...item, title: nextTitle } : item
    ))
    void window.universalAgent.renameChatSession(chatId, nextTitle)
  }

  /** Fase Paneles-2b: generalizado a N paneles -- la restriccion de "nunca
   *  2 paneles con el mismo chat" garantiza que a lo sumo UN panel puede
   *  estar mostrando el chat que se borra, asi que alcanza con buscarlo
   *  una vez en openPanels y, si aparece, moverlo a un fallback (el
   *  siguiente chat que quede, o uno nuevo en blanco si no queda ninguno). */
  function deleteChat(chatId: string): void {
    const nextSessions = chatSessions.filter(chat => chat.id !== chatId)
    setChatSessions(nextSessions)
    setChats(current => {
      const next = { ...current }
      delete next[chatId]
      return next
    })

    // Fix real de UI (docs/_arch/verify_ui_paneles_0_9_0.md, Problema 3):
    // antes esto redirigia el panel afectado a un chat cualquiera (el
    // primero de la lista restante) sin ningun aviso -- confuso, el
    // usuario veia el panel cambiar de contenido sin entender por que.
    // Ahora el panel se CIERRA solo, via closePanel() ya existente (mismo
    // cleanup real que un cierre manual -- disconnectAgent(), panelStatuses/
    // panelApprovals/panelToolApprovals/pendingAutoConnect).
    const affectedPanel = openPanels.find(entry => entry.chatId === chatId)
    if (affectedPanel) {
      if (openPanels.length > 1) {
        closePanel(affectedPanel.panelId)
      } else {
        // closePanel() se niega a cerrar el ultimo panel abierto (guard ya
        // existente) -- dejarlo tal cual apuntaria a un chatId ya borrado.
        // Mismo criterio que el comportamiento viejo (nunca deja la UI sin
        // ningun panel), pero con un chat en blanco PROPIO en vez de cairle
        // encima al primero que hubiera quedado en la lista al azar.
        const fallback = createBlankChat()
        setOpenPanels(current => current.map(entry =>
          entry.panelId === affectedPanel.panelId ? { ...entry, chatId: fallback.id } : entry
        ))
      }
    }

    void window.universalAgent.deleteChatSession(chatId)
  }

  async function bootstrap(): Promise<void> {
    const loaded = await window.universalAgent.getSettings()
    const storedChats = await window.universalAgent.loadChats()
    const list = await window.universalAgent.listProjects()
    const cli = await window.universalAgent.getCliStatus()
    const dw = await window.universalAgent.getDefaultWorkspace()
    setProjects(list)
    setCliStatus(cli)
    setDefaultWorkspace(dw)

    let next = loaded
    let account: CodexAccountView = { connected: false }

    try {
      account = parseCodexAccount(await window.universalAgent.readCodexAccount())
      setCodexAccount(account)
    } catch {}

    if (account.connected && cli.codex?.installed) {
      let codexProvider = next.providers.find(
        p => p.type === 'openai-codex' && p.authMode === 'subscription'
      )

      if (!codexProvider) {
        codexProvider = newProvider('openai-codex', 'subscription')
        next = {
          ...next,
          providers: [codexProvider, ...next.providers],
          activeProviderId: next.activeProviderId ?? codexProvider.id
        }
      }

      try {
        next = await syncCodexProvider(next, codexProvider.id)
      } catch {}
    }

    const provider = pickProvider(next)
    const model = pickModel(provider, next.activeModelId)
    if (provider && (next.activeProviderId !== provider.id || next.activeModelId !== model?.id)) {
      next = { ...next, activeProviderId: provider.id, activeModelId: model?.id }
    }

    setSettings(next)

    let bootChatId: string
    if (storedChats.sessions.length > 0) {
      const restored = storedChats.sessions.map(chat => ({
        id: chat.id,
        title: chat.title,
        workspacePath: chat.workspacePath,
        workspaceName: chat.workspaceName,
        updatedAt: chat.updatedAt,
        providerId: chat.providerId,
        modelId: chat.modelId,
        parentChatId: chat.parentChatId
      }))
      setChatSessions(restored)
      setChats(Object.fromEntries(
        Object.entries(storedChats.messages).map(([chatId, messages]) => [
          chatId,
          messages.map(toChatMessage)
        ])
      ))
      bootChatId = BOOT_CHAT_ID && restored.some(chat => chat.id === BOOT_CHAT_ID)
        ? BOOT_CHAT_ID
        : storedChats.sessions[0].id

      // Migracion: chats creados antes de que todo chat quedara atado a un
      // workspace desde su nacimiento (modelo viejo, "chat sin workspace").
      for (const chat of restored) {
        if (chat.workspacePath) continue
        const patched = { ...chat, workspacePath: dw.path, workspaceName: dw.name }
        setChatSessions(current => current.map(item => item.id === chat.id ? patched : item))
        persistChatSessionMeta(patched)
      }
    } else {
      const firstChat = { ...generalChatSession(), workspacePath: dw.path, workspaceName: dw.name }
      setChatSessions([firstChat])
      persistChatSessionMeta(firstChat)
      bootChatId = firstChat.id
    }

    // Fase Paneles-2b: 1 panel al arranque, siempre (DECISIONES
    // CONFIRMADAS -- openPanels NO persiste entre reinicios).
    const initialPanelId = crypto.randomUUID()
    setOpenPanels([{ panelId: initialPanelId, chatId: bootChatId }])
    setFocusedPanelId(initialPanelId)

    if (JSON.stringify(next) !== JSON.stringify(loaded)) {
      await window.universalAgent.saveSettings(next)
    }

    // Fase Paneles-2b: el bloque que abria next.activeProjectPath aca se
    // elimina -- cada <ChatPanel> ya abre el workspace de SU PROPIO chat
    // automaticamente al montarse (ver el efecto sobre `chatId` dentro de
    // ChatPanel), que es el dato correcto por panel; el `activeProjectPath`
    // global es solo el default SUGERIDO (Paneles-2a), no "el" workspace a
    // abrir al arrancar.
  }

  return (
    <div className={sidebarCollapsed ? 'app sidebar-collapsed' : 'app'}>
      {/* UI, Pieza 2: SIEMPRE renderizado (fixed, fuera de .sidebar) --
          con el sidebar colapsado a 0px no hay adentro donde ubicarlo que
          siga siendo clickeable. Mismo boton sirve para expandir. */}
      <button
        className="sidebar-toggle"
        title={sidebarCollapsed ? 'Expandir sidebar' : 'Contraer sidebar'}
        onClick={() => setSidebarCollapsed(value => !value)}
      >
        ☰
      </button>

      {imagePreview && (
        <div className="image-viewer" onClick={() => setImagePreview(null)}>
          <div className="image-viewer-shell" onClick={event => event.stopPropagation()}>
            <div className="image-viewer-bar">
              <span>{imagePreview.title}</span>
              <button onClick={() => setImagePreview(null)} type="button">x</button>
            </div>
            <img src={imagePreview.src} alt={imagePreview.title} />
          </div>
        </div>
      )}

      <aside className="sidebar">
        <div className="sidebar-brand">
          <span className="brand-lockup">
            <img src={amatistaLogo} alt="" />
            <span>AMATISTA {__APP_VERSION__}</span>
          </span>
          <button className="icon-btn" onClick={() => setSettingsOpen(true)}>⚙</button>
        </div>

        <button className="new-chat" onClick={handleNewChatClick}>
          + Nuevo chat
        </button>

        <div className="sidebar-scroll">
          <div className="section-label">CHATS</div>
          {buildChatRows(chatSessions).map(({ chat, depth }) => {
            const openEntry = openPanels.find(entry => entry.chatId === chat.id)
            const isFocusedChat = Boolean(openEntry && openEntry.panelId === focusedPanelId)
            const rowClassName = [
              'chat-row',
              isFocusedChat ? 'active' : openEntry ? 'open-elsewhere' : '',
              depth > 0 ? 'chat-row-nested' : ''
            ].filter(Boolean).join(' ')
            const accent = chatBorderAccent(chat, settings.providers)
            return (
              <div
                key={chat.id}
                className={rowClassName}
                style={{
                  borderLeftColor: accent,
                  marginLeft: depth > 0 ? 8 + depth * 16 : undefined
                }}
                onContextMenu={event => {
                  event.preventDefault()
                  setContextMenu({ type: 'chat', chatId: chat.id, x: event.clientX, y: event.clientY })
                }}
              >
                {editingChatId === chat.id ? (
                  <input
                    className="chat-title-input"
                    value={editingChatTitle}
                    autoFocus
                    onChange={event => setEditingChatTitle(event.target.value)}
                    onBlur={commitRenameChat}
                    onKeyDown={event => {
                      if (event.key === 'Enter') {
                        event.preventDefault()
                        commitRenameChat()
                      } else if (event.key === 'Escape') {
                        event.preventDefault()
                        cancelRenameChat()
                      }
                    }}
                  />
                ) : (
                  <button
                    className="chat-title-btn"
                    onContextMenu={event => {
                      event.preventDefault()
                      event.stopPropagation()
                      setContextMenu({ type: 'chat', chatId: chat.id, x: event.clientX, y: event.clientY })
                    }}
                    onDoubleClick={event => {
                      event.stopPropagation()
                      startRenameChat(chat.id)
                    }}
                    onClick={() => openChatInPanel(chat.id, focusedPanelId ?? undefined)}
                  >
                    <MarqueeSpan className="chat-title-main" text={chat.title} />
                    {chat.workspaceName && (
                      <MarqueeSpan className="chat-title-sub" text={chat.workspaceName} />
                    )}
                  </button>
                )}
                <button
                  className="chat-delete-btn"
                  title="Borrar chat"
                  onClick={() => deleteChat(chat.id)}
                >
                  x
                </button>
              </div>
            )
          })}

          <div className="section-label">PROYECTOS</div>
          {settings.projectRoots.map(root => (
            <div key={root.id} className="root-block">
              <div className="root-title root-title-row">
                <button
                  className={focusedStatus?.workspacePath === root.path ? 'root-title-open active' : 'root-title-open'}
                  title="Abrir esta carpeta como workspace activo — vuelve al chat mas reciente de esta carpeta si ya tenia uno"
                  onClick={() => openProjectInFocusedPanel({ id: root.id, name: root.name, path: root.path, rootId: root.id })}
                >
                  <span className="root-title-chevron">⌄</span>
                  <MarqueeSpan text={root.name} />
                </button>
                <button
                  className="project-new-session"
                  title="Nueva sesion de chat en esta carpeta (no reutiliza ninguna existente)"
                  onClick={() => newProjectSessionInFocusedPanel({ id: root.id, name: root.name, path: root.path, rootId: root.id })}
                >
                  +
                </button>
                <button
                  className="root-remove"
                  title="Quitar carpeta raiz"
                  onClick={() => void removeProjectRoot(root.id)}
                >
                  Quitar
                </button>
              </div>
              {projects.filter(project => project.rootId === root.id).map(project => (
                <div key={project.id} className="project-row">
                  <button
                    className={focusedStatus?.workspacePath === project.path ? 'project active' : 'project'}
                    title="Abrir esta carpeta como workspace activo — vuelve al chat mas reciente de esta carpeta si ya tenia uno"
                    onClick={() => openProjectInFocusedPanel(project)}
                  >
                    <MarqueeSpan text={project.name} />
                  </button>
                  <button
                    className="project-new-session"
                    title="Nueva sesion de chat en esta carpeta (no reutiliza ninguna existente)"
                    onClick={() => newProjectSessionInFocusedPanel(project)}
                  >
                    +
                  </button>
                </div>
              ))}
            </div>
          ))}
          <button className="add-root" onClick={() => void addProjectRoot()}>+ Agregar raiz</button>
          <button className="reset-local" onClick={() => void resetLocalState()}>
            Reiniciar configuracion local
          </button>
        </div>

        <div className="sidebar-footer">
          <span className={focusedStatus?.agentState === 'connected' ? 'dot connected' : 'dot'} />
          <span className="sidebar-project">{focusedStatus ? (focusedStatus.workspaceName ?? focusedStatus.chatTitle) : 'Sin panel enfocado'}</span>
          <small>{focusedStatus?.agentState === 'connected' ? focusedStatus.agentRuntime : 'sin agente'}</small>
        </div>
      </aside>

      <main className="main">
        <header className="topbar">
          <div className="topbar-title">{focusedStatus ? (focusedStatus.workspaceName ?? focusedStatus.chatTitle) : 'AMATISTA'}</div>
          <div className="topbar-actions">
            <button
              className="topbar-btn"
              onClick={() => void toggleFullscreen()}
            >
              {isFullscreen ? 'Salir pantalla completa' : 'Pantalla completa'}
            </button>
            {/* Fix real de UI (docs/_arch/verify_ui_paneles_0_9_0.md,
                Problema 2): "Modelos y cuentas" era un segundo acceso
                identico a Configuracion (mismo setSettingsOpen(true) que el
                icono de arriba del sidebar) -- sacado, queda un solo acceso. */}
          </div>
        </header>

        {openPanels.length === 0 ? (
          <div className="panels-empty">Cargando...</div>
        ) : (
          <div className="panels-grid" style={panelsGridStyle}>
            {openPanels.map((entry, index) => (
              <ChatPanel
                key={entry.panelId}
                panelId={entry.panelId}
                panelIndex={index + 1}
                chatId={entry.chatId}
                chatSessions={chatSessions}
                setChatSessions={setChatSessions}
                chats={chats}
                setChats={setChats}
                settings={settings}
                defaultWorkspace={defaultWorkspace}
                codexAccountConnected={codexAccount.connected}
                cliStatus={cliStatus}
                isFocused={entry.panelId === focusedPanelId}
                canClose={openPanels.length > 1}
                catalogChangeNonce={catalogChangeNonce}
                onFocus={() => setFocusedPanelId(entry.panelId)}
                onClose={() => closePanel(entry.panelId)}
                onAddPanelForThisChat={() => addPanelForChat(entry.chatId)}
                onOpenImage={setImagePreview}
                onContextMenuRequest={setContextMenu}
                onWorkspaceConnected={path => mutateSettings(current => ({ ...current, activeProjectPath: path }), true)}
                onStatusChange={(panelId, status) => setPanelStatuses(current => ({ ...current, [panelId]: status }))}
                onApprovalChange={(panelId, handle) => setPanelApprovals(current => ({ ...current, [panelId]: handle }))}
                onToolApprovalChange={(panelId, handle) => setPanelToolApprovals(current => ({ ...current, [panelId]: handle }))}
                autoConnectRequestId={pendingAutoConnect[entry.panelId] ?? null}
                onAutoConnectResult={(success, error) => handleAutoConnectResult(entry.panelId, success, error)}
              />
            ))}
          </div>
        )}
      </main>

      {contextMenu && (
        <div
          className="context-menu"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onMouseDown={event => event.stopPropagation()}
          onContextMenu={event => event.preventDefault()}
        >
          {contextMenu.type === 'chat' ? (
            <>
              <button
                onClick={() => {
                  startRenameChat(contextMenu.chatId)
                  setContextMenu(null)
                }}
              >
                Renombrar chat
              </button>
              <button
                onClick={() => {
                  addPanelForChat(contextMenu.chatId)
                  setContextMenu(null)
                }}
              >
                Agregar panel
              </button>
              <button
                onClick={() => {
                  deleteChat(contextMenu.chatId)
                  setContextMenu(null)
                }}
              >
                Borrar chat
              </button>
            </>
          ) : contextMenu.type === 'message' ? (
            <>
              <button
                onClick={() => {
                  contextMenu.onCopy()
                  setContextMenu(null)
                }}
              >
                Copiar mensaje
              </button>
              {contextMenu.onEdit && (
                <button
                  onClick={() => {
                    contextMenu.onEdit?.()
                    setContextMenu(null)
                  }}
                >
                  Editar mensaje
                </button>
              )}
              {contextMenu.onRegenerate && (
                <button
                  onClick={() => {
                    contextMenu.onRegenerate?.()
                    setContextMenu(null)
                  }}
                >
                  Regenerar respuesta
                </button>
              )}
            </>
          ) : contextMenu.type === 'panelHeader' ? (
            <>
              <button
                disabled={contextMenu.mcpDisabled}
                title="Crear o abrir .mcp.json del workspace activo"
                onClick={() => {
                  contextMenu.onOpenMcpConfig()
                  setContextMenu(null)
                }}
              >
                .mcp.json
              </button>
              <button
                onClick={() => {
                  contextMenu.onToggleDebug()
                  setContextMenu(null)
                }}
              >
                Eventos ({contextMenu.eventsCount})
              </button>
            </>
          ) : (
            <>
              <button
                onClick={() => {
                  contextMenu.onCut()
                  setContextMenu(null)
                }}
              >
                Cortar
              </button>
              <button
                onClick={() => {
                  contextMenu.onCopy()
                  setContextMenu(null)
                }}
              >
                Copiar
              </button>
              <button
                onClick={() => {
                  contextMenu.onPaste()
                  setContextMenu(null)
                }}
              >
                Pegar
              </button>
              <button
                onClick={() => {
                  contextMenu.onSelectAll()
                  setContextMenu(null)
                }}
              >
                Seleccionar todo
              </button>
            </>
          )}
        </div>
      )}

      {settingsOpen && (
        <>
          <button className="scrim" onClick={() => setSettingsOpen(false)} />
          <aside className="settings-panel">
            <div className="settings-header">
              <div>
                <h2>Modelos y cuentas</h2>
                <p>Cuenta, proveedor, modelo, workspace y agente son estados distintos.</p>
              </div>
            </div>
            <div className="settings-content">
              <section className="settings-section">
                <h3>Conexiones</h3>
                {providersForDisplay(settings.providers).map(provider => {
                  const identity = providerIdentity(provider)
                  const isEditing = editingProviderId === provider.id
                  return (
                    <div key={provider.id}>
                      <div className="connection-row">
                        <ProviderBadge identity={identity} />
                        <div className="connection-main">
                          <span>{identity.name}</span>
                          <MethodPill provider={provider} />
                          <small>{providerConnectionSubtitle(provider)}</small>
                        </div>
                        <div className="connection-actions">
                          <button
                            className="connection-action"
                            onClick={() => {
                              if (isEditing) {
                                setEditingProviderId(null)
                                setEditForm(null)
                                return
                              }
                              setEditingProviderId(provider.id)
                              setEditForm({
                                name: provider.name,
                                authMode: provider.authMode,
                                endpoint: provider.endpoint ?? '',
                                apiKey: provider.apiKey ?? ''
                              })
                            }}
                          >
                            {isEditing ? 'Cerrar' : 'Editar'}
                          </button>
                          <button className="connection-action" onClick={() => toggleProvider(provider.id)}>
                            {provider.enabled ? 'Desactivar' : 'Activar'}
                          </button>
                          <button className="connection-action connection-action-danger" onClick={() => deleteProvider(provider.id)}>Eliminar</button>
                        </div>
                      </div>

                      {isEditing && editForm && (
                        <>
                          <label className="field">
                            <span>Nombre visible</span>
                            <input
                              value={editForm.name}
                              onChange={event => setEditForm(current => current && { ...current, name: event.target.value })}
                            />
                          </label>

                          {provider.allowSubscription !== false && (
                            <label className="field">
                              <span>Autenticacion</span>
                              <select
                                value={editForm.authMode}
                                onChange={event => setEditForm(current => current && { ...current, authMode: event.target.value as AuthMode })}
                              >
                                <option value="subscription">Suscripcion / sesion oficial</option>
                                <option value="api-key">API key</option>
                              </select>
                            </label>
                          )}

                          {/* Reintegracion de claude-cli: rama hermana de la
                              de api-key de abajo, mutuamente excluyente por
                              construccion (las dos cuelgan de
                              editForm.authMode). Solo status -- las acciones
                              reales (Instalar/Iniciar sesion) viven en la
                              seccion "CLI" mas abajo, mismo patron ya
                              establecido para la cuenta de Codex (su propia
                              seccion global, no embebida por conexion) --
                              evita duplicar los mismos 2 botones en 2 lugares. */}
                          {editForm.authMode === 'subscription' && provider.type === 'anthropic' && (
                            <p className="settings-hint">
                              Claude Code CLI: {cliStatus.claude?.installed
                                ? `instalado (${cliStatus.claude.version ?? 'version detectada'})`
                                : 'no instalado'} — instalar o iniciar sesion desde la seccion "CLI" mas abajo.
                            </p>
                          )}

                          {/* Integracion de Antigravity CLI: misma rama hermana
                              y mismo motivo exacto que la de Claude arriba --
                              reusa la estructura ya construida, no una nueva. */}
                          {editForm.authMode === 'subscription' && provider.type === 'antigravity' && (
                            <p className="settings-hint">
                              Antigravity CLI: {cliStatus.antigravity?.installed
                                ? `instalado (${cliStatus.antigravity.version ?? 'version detectada'})`
                                : 'no instalado'} — instalar o iniciar sesion desde la seccion "CLI" mas abajo.
                            </p>
                          )}

                          {editForm.authMode === 'api-key' && (
                            <>
                              {(provider.type === 'foundry' || provider.type === 'openai' || provider.type === 'openai-compatible' || provider.type === 'anthropic' || provider.type === 'openrouter') && (
                                <label className="field">
                                  <span>Endpoint</span>
                                  <input
                                    value={editForm.endpoint}
                                    placeholder={provider.type === 'openai'
                                      ? 'https://api.openai.com/v1'
                                      : provider.type === 'openrouter'
                                        ? 'https://openrouter.ai/api/v1'
                                        : 'https://...'}
                                    onChange={event => setEditForm(current => current && { ...current, endpoint: event.target.value })}
                                  />
                                </label>
                              )}
                              <label className="field">
                                <span>API key</span>
                                <input
                                  type="password"
                                  value={editForm.apiKey}
                                  onChange={event => setEditForm(current => current && { ...current, apiKey: event.target.value })}
                                />
                              </label>
                            </>
                          )}

                          <div className="settings-actions-row">
                            <button
                              className="primary-btn"
                              onClick={() => {
                                const runtime = runtimeFor(provider.type, editForm.authMode)
                                // Preserva el id real -- nunca crea una conexion nueva, asi
                                // los chats que ya referencian este providerId no quedan
                                // huerfanos (fix real, ver docs/_arch/verify_connection_editing_bug.md).
                                updateProvider(provider.id, current => ({
                                  ...current,
                                  name: editForm.name,
                                  authMode: editForm.authMode,
                                  endpoint: editForm.endpoint,
                                  apiKey: editForm.apiKey,
                                  models: current.models.map(model => ({ ...model, runtime }))
                                }), true)
                                disconnectAllPanels()
                                setEditingProviderId(null)
                                setEditForm(null)
                              }}
                            >
                              Guardar
                            </button>
                            <button
                              className="secondary-btn"
                              onClick={() => {
                                setEditingProviderId(null)
                                setEditForm(null)
                              }}
                            >
                              Cancelar
                            </button>
                          </div>
                        </>
                      )}
                    </div>
                  )
                })}
              </section>

              <section className="settings-section">
                <h3>Agregar conexion</h3>
                <p className="settings-hint">Elegi un proveedor y metodo de conexion.</p>
                <div className="add-connection-grid">
                  <button onClick={() => addProvider('anthropic', 'subscription')}>Claude Pro<small>Suscripcion</small></button>
                  <button onClick={() => addProvider('anthropic', 'api-key')}>Claude<small>API key / Azure</small></button>
                  <button onClick={() => addProvider('openai-codex', 'subscription')}>Codex ChatGPT<small>Suscripcion</small></button>
                  <button onClick={() => addProvider('openai', 'api-key')}>OpenAI<small>API key</small></button>
                  {/* Retiro de gemini-cli (docs/_arch/verify_gemini_cli_removal_scope.md,
                      verify_gemini_cli_removal.md): boton de suscripcion (CLI)
                      retirado -- gemini-cli standalone discontinuado para
                      cuentas individuales. El de API key (HTTP) se queda. */}
                  <button onClick={() => addProvider('google', 'api-key')}>Gemini<small>API key</small></button>
                  <button onClick={() => addProvider('antigravity', 'subscription')}>Antigravity<small>Suscripcion</small></button>
                  <button onClick={() => addProvider('antigravity', 'api-key')}>Antigravity<small>API key</small></button>
                  <button onClick={() => addProvider('foundry', 'api-key')}>Foundry<small>API key</small></button>
                  <button onClick={() => addProvider('openrouter', 'api-key')}>OpenRouter<small>API key</small></button>
                  <button onClick={() => addDeepSeekProvider()}>DeepSeek<small>API key</small></button>
                  <button onClick={() => addProvider('openai-compatible', 'api-key')}>Compatible<small>API key</small></button>
                </div>
              </section>

              <section className="settings-section">
                <h3>Cuenta ChatGPT (Codex)</h3>
                <p className="settings-hint">
                  {codexAccount.connected
                    ? `Conectada${codexAccount.email ? `: ${codexAccount.email}` : ''}${codexAccount.planType ? ` (${codexAccount.planType})` : ''}`
                    : codexAccount.detail ?? 'Sin sesion.'}
                </p>
                <div className="settings-actions-row">
                  <button disabled={authBusy} onClick={() => void loginCodex()}>Conectar ChatGPT</button>
                  <button disabled={authBusy} onClick={() => void checkCodexAccount()}>Revisar cuenta</button>
                  <button disabled={authBusy} onClick={() => void syncCodexModels()}>Sincronizar modelos</button>
                  <button disabled={authBusy} onClick={() => void logoutCodex()}>Cerrar sesion</button>
                </div>
              </section>

              <section className="settings-section">
                <h3>CLI</h3>
                {/* Retiro de gemini-cli (docs/_arch/verify_gemini_cli_removal_scope.md,
                    verify_gemini_cli_removal.md): el segmento/botones/hint de
                    Gemini salieron de esta seccion compartida -- gemini-cli
                    standalone discontinuado para cuentas individuales, Claude
                    y Antigravity siguen igual. */}
                <p className="settings-hint">
                  Codex: {cliStatus.codex?.installed ? `instalado (${cliStatus.codex.version ?? 'version detectada'})` : 'no instalado'} ·
                  {' '}Claude Code: {cliStatus.claude?.installed ? `instalado (${cliStatus.claude.version ?? 'version detectada'})` : 'no instalado'} ·
                  {' '}Antigravity: {cliStatus.antigravity?.installed ? `instalado (${cliStatus.antigravity.version ?? 'version detectada'})` : 'no instalado'}
                </p>
                <div className="settings-actions-row">
                  <button disabled={authBusy} onClick={() => void refreshCliStatus()}>Revisar CLI</button>
                  <button disabled={authBusy} onClick={() => void installClaudeCli()}>Instalar Claude Code CLI</button>
                  <button disabled={authBusy} onClick={() => void openCliLogin('anthropic')}>Iniciar sesion Claude Code</button>
                  <button disabled={authBusy} onClick={() => void installAntigravityCli()}>Instalar Antigravity CLI</button>
                  <button disabled={authBusy} onClick={() => void openCliLogin('antigravity')}>Iniciar sesion Antigravity</button>
                </div>
                {!cliStatus.claude?.installed && <p className="settings-hint">{cliInstallHint('anthropic')}</p>}
                {!cliStatus.antigravity?.installed && <p className="settings-hint">{cliInstallHint('antigravity')}</p>}
              </section>

              {(() => {
                const focusedProvider = settings.providers.find(p => p.id === focusedStatus?.providerId)
                return focusedProvider && (focusedProvider.type === 'openrouter' || focusedProvider.type === 'openai-compatible') ? (
                  <section className="settings-section">
                    <h3>Modelos de {providerIdentity(focusedProvider).name}</h3>
                    <div className="settings-actions-row">
                      <button disabled={authBusy} onClick={() => void syncOpenAiChatCatalog()}>Sincronizar catalogo</button>
                      <button onClick={() => addManualModel(focusedProvider)}>+ Agregar modelo manual</button>
                    </div>
                    {openAiChatCatalog && (
                      <>
                        <input
                          className="chat-title-input"
                          placeholder="Buscar modelo..."
                          value={openAiChatCatalogQuery}
                          onChange={event => setOpenAiChatCatalogQuery(event.target.value)}
                        />
                        <div className="model-catalog-list">
                          {openAiChatCatalog
                            .filter(item => item.displayName.toLowerCase().includes(openAiChatCatalogQuery.toLowerCase()))
                            .slice(0, openAiChatCatalogShowAll ? undefined : 20)
                            .map(item => (
                              <div key={item.id} className="model-catalog-row">
                                <span>{item.displayName}</span>
                                <button onClick={() => addCatalogModel(focusedProvider, item)}>+ Agregar</button>
                              </div>
                            ))}
                        </div>
                        {!openAiChatCatalogShowAll && openAiChatCatalog.length > 20 && (
                          <button className="settings-hint" onClick={() => setOpenAiChatCatalogShowAll(true)}>Mostrar todos ({openAiChatCatalog.length})</button>
                        )}
                      </>
                    )}
                    {focusedProvider.models.map(model => (
                      <div key={model.id} className="model-catalog-row">
                        <span>{model.displayName}{model.enabled ? '' : ' (desactivado)'}</span>
                        <div>
                          <button onClick={() => toggleModel(focusedProvider.id, model.id)}>{model.enabled ? 'Desactivar' : 'Activar'}</button>
                          <button onClick={() => deleteModel(focusedProvider.id, model.id)}>Eliminar</button>
                        </div>
                      </div>
                    ))}
                  </section>
                ) : null
              })()}

              <section className="settings-section">
                <h3>Modelo de compactacion (opcional)</h3>
                <p className="settings-hint">Si no elegis ninguno, la compactacion usa el modelo activo de cada turno.</p>
                <select
                  value={settings.compactionModelId ?? ''}
                  onChange={event => {
                    const modelId = event.target.value || undefined
                    const match = compactionCandidates.find(item => item.model.id === modelId)
                    setCompactionModel(match?.provider.id, match?.model.id)
                  }}
                >
                  <option value="">Sin modelo dedicado (usar el activo)</option>
                  {compactionCandidates.map(({ provider, model }) => (
                    <option key={model.id} value={model.id}>{providerIdentity(provider).name} · {model.displayName}</option>
                  ))}
                </select>
              </section>

              <section className="settings-section">
                <h3>Generacion de imagenes</h3>
                {(() => {
                  // Feature "generacion de imagenes": mismo calculo que
                  // resolveConfiguredImageGenerationModel() (main,
                  // image-generation.ts) para el caso "nada elegido
                  // explicito" -- puramente informativo aca, la resolucion
                  // real de verdad ocurre en main al ejecutar la tool.
                  const implicitSuggestion = !settings.imageGenerationModelId
                    ? imageGenerationCandidates.find(({ model }) => isLikelyImageModel(model))
                    : undefined
                  return (
                    <p className="settings-hint">
                      {implicitSuggestion
                        ? `Sin elegir uno a mano, se sugiere automaticamente: ${providerIdentity(implicitSuggestion.provider).name} · ${implicitSuggestion.model.displayName}.`
                        : 'Si no elegis ninguno (y ninguno parece ser un modelo de imagenes por su nombre), generate_image devuelve un error claro en vez de adivinar.'}
                    </p>
                  )
                })()}
                <select
                  value={settings.imageGenerationModelId ?? ''}
                  onChange={event => {
                    const modelId = event.target.value || undefined
                    const match = imageGenerationCandidates.find(item => item.model.id === modelId)
                    setImageGenerationModel(match?.provider.id, match?.model.id)
                  }}
                >
                  <option value="">Sin elegir (usar sugerencia automatica si hay)</option>
                  {imageGenerationCandidates.map(({ provider, model }) => (
                    <option key={model.id} value={model.id}>{providerIdentity(provider).name} · {model.displayName}</option>
                  ))}
                </select>
              </section>

              <section className="settings-section">
                <h3>Herramientas del workspace</h3>
                <div className="settings-actions-row">
                  <button onClick={() => void openAgentsMd()}>AGENTS.md</button>
                </div>
                {notice && <div className="notice">{notice}</div>}
              </section>
            </div>

            <div className="settings-footer">
              <button className="secondary-btn" onClick={() => setSettingsOpen(false)}>Cerrar</button>
              <button
                className="primary-btn"
                onClick={() => {
                  void window.universalAgent.saveSettings(settings)
                  setSettingsOpen(false)
                }}
              >
                Guardar cambios
              </button>
            </div>
          </aside>
        </>
      )}

      {visibleApproval && (
        <div className="approval-overlay">
          <div className="approval-dialog">
            <h3>Aprobacion requerida</h3>
            <small>{visibleApproval.approval.method}</small>
            <pre>{JSON.stringify(visibleApproval.approval.params, null, 2)}</pre>
            <div className="approval-actions">
              <button className="secondary-btn" onClick={() => visibleApproval.onAnswer('decline')}>Rechazar</button>
              <button className="primary-btn" onClick={() => visibleApproval.onAnswer('accept')}>Aceptar</button>
              {visibleApproval.approval.method === 'item/commandExecution/requestApproval' && (
                <button className="primary-btn" onClick={() => visibleApproval.onAnswer('acceptForSession')}>Aceptar sesion</button>
              )}
            </div>
          </div>
        </div>
      )}

      {visibleToolApproval && (
        <div className="approval-overlay">
          <div className="approval-dialog">
            <h3>Aprobacion requerida</h3>
            <small>{visibleToolApproval.title}</small>
            {visibleToolApproval.title.startsWith('Escribir archivo:') ? (
              <pre className="diff-block">
                {visibleToolApproval.detail.split('\n').map((line, index) => {
                  const isAdd = line.startsWith('+')
                  const isRemove = line.startsWith('-')
                  const isMeta = line.trimStart().startsWith('⋮')
                  const className = isMeta
                    ? 'diff-line diff-meta'
                    : isAdd
                      ? 'diff-line diff-add'
                      : isRemove
                        ? 'diff-line diff-remove'
                        : 'diff-line diff-context'
                  return (
                    <div key={index} className={className}>{line || ' '}</div>
                  )
                })}
              </pre>
            ) : (
              <pre>{visibleToolApproval.detail}</pre>
            )}
            <label className="trust-checkbox">
              <input
                type="checkbox"
                checked={visibleToolApproval.trust}
                onChange={event => visibleToolApproval.onToggleTrust(event.target.checked)}
              />
              Confiar en este agente por el resto de esta sesion (no volver a preguntar)
            </label>
            <div className="approval-actions">
              <button className="secondary-btn" onClick={() => visibleToolApproval.onAnswer(false)}>Rechazar</button>
              <button className="primary-btn" onClick={() => visibleToolApproval.onAnswer(true)}>Aprobar</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
