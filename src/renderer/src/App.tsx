import { useEffect, useMemo, useRef, useState, type ClipboardEvent } from 'react'
import type {
  AppSettings,
  AuthMode,
  ChatAttachment,
  CliStatus,
  ConversationMessage,
  ModelProfile,
  ProjectEntry,
  ProviderProfile,
  ProviderType,
  RuntimeKind,
  SandboxMode,
  ToolApprovalRequest
} from '../../shared/types'
import { CONTEXT_TOKEN_BUDGET } from '../../shared/context-budget'
import { isApiCapableModel } from '../../shared/model-capabilities'
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
}

function toChatMessage(message: {
  id: string
  role: 'user' | 'assistant' | 'system'
  text: string
  attachments?: ChatAttachment[]
  toolSteps?: string[]
}): ChatMessage {
  return {
    id: message.id,
    role: message.role,
    text: message.text,
    attachments: message.attachments,
    toolSteps: message.toolSteps
  }
}

type ContextMenuState =
  | { type: 'chat'; chatId: string; x: number; y: number }
  | { type: 'message'; messageId: string; text: string; role: 'user' | 'assistant' | 'system'; x: number; y: number }
  | { type: 'composer'; x: number; y: number }
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

function generalChatSession(): ChatSession {
  return { id: GENERAL_CHAT_ID, title: 'Chat general' }
}

interface Approval {
  requestId: number | string
  method: string
  params: unknown
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

type AgentState = 'idle' | 'connecting' | 'connected' | 'error'

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : {}
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : ''
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
  if (type === 'anthropic') return authMode === 'api-key' ? 'anthropic-api' : 'claude-cli'
  return 'gemini-cli'
}

function providerName(type: ProviderType): string {
  switch (type) {
    case 'openai-codex': return 'Codex ChatGPT (suscripcion)'
    case 'foundry': return 'Microsoft Foundry API'
    case 'openai': return 'OpenAI API'
    case 'anthropic': return 'Claude Pro (suscripcion)'
    case 'google': return 'Gemini Advanced (suscripcion Google)'
    case 'openai-compatible': return 'API compatible'
  }
}

function providerDisplayName(provider: ProviderProfile): string {
  const value = `${provider.name} ${provider.type} ${provider.authMode}`.toLowerCase()

  if (provider.type === 'anthropic' && provider.authMode === 'subscription') return 'Claude Pro'
  if (provider.type === 'anthropic' && provider.authMode === 'api-key') {
    if (value.includes('deepseek')) return 'DeepSeek API'
    return value.includes('azure') ? 'Claude API via Azure' : 'Claude API key'
  }
  if (provider.type === 'openai-codex') return 'Codex ChatGPT'
  if (provider.type === 'google' && provider.authMode === 'subscription') return 'Gemini Advanced'
  if (provider.type === 'google' && provider.authMode === 'api-key') return provider.enabled ? 'Gemini API key' : 'Gemini API key pendiente'
  if (provider.type === 'foundry') return value.includes('q_config') ? 'Foundry API desde q_config' : 'Microsoft Foundry API'
  if (value.includes('groq')) return 'Groq API'
  if (value.includes('ollama')) return 'Ollama local'
  if (provider.type === 'openai') return 'OpenAI API key'
  return provider.name
}

function providerSubtitle(provider: ProviderProfile): string {
  if (!provider.enabled) return 'Desactivado'
  if (provider.type === 'anthropic' && provider.authMode === 'subscription') return 'Suscripcion Claude Pro - usa Claude Code CLI'
  if (provider.type === 'anthropic' && provider.authMode === 'api-key') {
    const value = `${provider.name} ${provider.endpoint ?? ''}`.toLowerCase()
    if (value.includes('deepseek')) return 'API key de DeepSeek - endpoint compatible Anthropic'
    return 'API key + endpoint - respaldo, no suscripcion'
  }
  if (provider.type === 'openai-codex') return 'Suscripcion ChatGPT - usa Codex app-server'
  if (provider.type === 'google' && provider.authMode === 'subscription') return 'Suscripcion Google - usa Gemini CLI'
  if (provider.type === 'google' && provider.authMode === 'api-key') return 'API key de Gemini'
  if (provider.type === 'foundry') return 'API key de Azure/Foundry - /responses directo'
  if (provider.type === 'openai-compatible') return 'API compatible - requiere validar soporte'
  if (provider.type === 'openai') return 'API key de OpenAI'
  return provider.authMode === 'subscription' ? 'Suscripcion' : 'API key'
}

function providerModeLabel(provider: ProviderProfile): string {
  if (!provider.enabled) return 'Desactivado'
  return provider.authMode === 'subscription' ? 'Suscripcion' : 'API key'
}

function providerGroupLabel(provider: ProviderProfile): string {
  if (!provider.enabled) return 'Desactivados'
  if (provider.authMode === 'subscription') return 'Suscripciones'
  return 'API keys'
}

function providerDisplayRank(provider: ProviderProfile): number {
  if (!provider.enabled) return 30
  if (provider.type === 'anthropic' && provider.authMode === 'subscription') return 0
  if (provider.type === 'openai-codex') return 1
  if (provider.type === 'google' && provider.authMode === 'subscription') return 2
  if (provider.authMode === 'api-key') return 10
  return 20
}

function providersForDisplay(providers: ProviderProfile[]): ProviderProfile[] {
  return [...providers].sort((a, b) =>
    providerDisplayRank(a) - providerDisplayRank(b) ||
    providerDisplayName(a).localeCompare(providerDisplayName(b))
  )
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
      }
    ]
  }

  if (type === 'google') {
    return [{
      id: crypto.randomUUID(), providerId, displayName: 'Gemini Auto', model: '', runtime, enabled: true,
      capabilities: { tools: true, reasoning: true, vision: true, web: true }
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
    endpoint: 'https://api.deepseek.com/anthropic',
    apiKey: '',
    enabled: true,
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
    endpoint: type === 'openai' ? 'https://api.openai.com/v1' : '',
    apiKey: '',
    enabled: true,
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

function pickProvider(settings: AppSettings): ProviderProfile | undefined {
  return settings.providers.find(p => p.id === settings.activeProviderId && p.enabled)
    ?? settings.providers.find(p => p.enabled)
}

function pickModel(provider: ProviderProfile | undefined, modelId?: string): ModelProfile | undefined {
  return provider?.models.find(m => m.id === modelId && m.enabled)
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
      </button>
      <div className="attachment-meta">
        <strong>{attachment.name}</strong>
        <small>{attachment.kind.toUpperCase()}</small>
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

export default function App() {
  const [settings, setSettings] = useState<AppSettings>({ providers: [], projectRoots: [] })
  const [projects, setProjects] = useState<ProjectEntry[]>([])
  const [activeProject, setActiveProject] = useState<ProjectEntry | null>(null)
  const [chatSessions, setChatSessions] = useState<ChatSession[]>([generalChatSession()])
  const [activeChatId, setActiveChatId] = useState(GENERAL_CHAT_ID)
  const [chats, setChats] = useState<Record<string, ChatMessage[]>>({})
  const [pendingAttachments, setPendingAttachments] = useState<ChatAttachment[]>([])
  const [imagePreview, setImagePreview] = useState<ImagePreviewState | null>(null)
  const [dragActive, setDragActive] = useState(false)
  const [contextMenu, setContextMenu] = useState<ContextMenuState>(null)
  const [prompt, setPrompt] = useState('')
  const [agentState, setAgentState] = useState<AgentState>('idle')
  const [agentRuntime, setAgentRuntime] = useState('')
  const [agentError, setAgentError] = useState('')
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [modelMenuOpen, setModelMenuOpen] = useState(false)
  const [sandbox, setSandbox] = useState<SandboxMode>('workspace-write')
  const [codexAccount, setCodexAccount] = useState<CodexAccountView>({ connected: false })
  const [cliStatus, setCliStatus] = useState<{ codex?: CliStatus; claude?: CliStatus; gemini?: CliStatus }>({})
  const [authBusy, setAuthBusy] = useState(false)
  const [notice, setNotice] = useState('')
  const [isFullscreen, setIsFullscreen] = useState(false)
  const [agentEvents, setAgentEvents] = useState<string[]>([])
  const [debugOpen, setDebugOpen] = useState(false)
  const [approval, setApproval] = useState<Approval | null>(null)
  const [defaultWorkspace, setDefaultWorkspace] = useState<{ path: string; name: string } | null>(null)
  const [editingChatId, setEditingChatId] = useState<string | null>(null)
  const [editingChatTitle, setEditingChatTitle] = useState('')
  const [toolApproval, setToolApproval] = useState<ToolApprovalRequest | null>(null)
  const [toolApprovalTrust, setToolApprovalTrust] = useState(false)
  const [toolTrustActive, setToolTrustActive] = useState(false)
  const [toolStatus, setToolStatus] = useState('')
  const [turnActive, setTurnActive] = useState(false)
  const [turnElapsedSeconds, setTurnElapsedSeconds] = useState(0)
  const [turnTokens, setTurnTokens] = useState<number | null>(null)
  // Historial de pasos YA TERMINADOS de este turno (Pieza 1: log que crece
  // hacia abajo). Distinto de toolStatus, que es SOLO la actividad en curso
  // ahora mismo (Pieza 2, linea fija que se reemplaza in-place).
  const [turnSteps, setTurnSteps] = useState<string[]>([])
  // handleAgentEvent se registra UNA sola vez (useEffect con deps []), asi
  // que su closure queda congelada con el turnSteps del primer render —
  // leer el state directo ahi adentro siempre da el valor de montaje (casi
  // siempre []). Este ref es la fuente de verdad que SI se lee actualizada
  // dentro de ese closure; turnSteps (el state) sigue siendo lo que
  // renderiza la UI, mantenido en sync por pushTurnStep/resetTurnSteps.
  const turnStepsRef = useRef<string[]>([])
  function pushTurnStep(step: string): void {
    turnStepsRef.current = [...turnStepsRef.current, step]
    setTurnSteps(turnStepsRef.current)
  }
  function resetTurnSteps(): void {
    turnStepsRef.current = []
    setTurnSteps([])
  }
  // Mensajes cuyo resumen de pasos (Pieza 1 persistida) esta expandido.
  // Colapsado por default para todos — ver toggleStepsExpanded().
  const [expandedSteps, setExpandedSteps] = useState<Set<string>>(new Set())
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)
  const activeChatIdRef = useRef(GENERAL_CHAT_ID)
  const assistantOutputSeenRef = useRef(false)
  const pendingTurnTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const turnStartRef = useRef<number | null>(null)

  const activeProvider = useMemo(() => pickProvider(settings), [settings])
  const activeModel = useMemo(
    () => pickModel(activeProvider, settings.activeModelId),
    [activeProvider, settings.activeModelId]
  )
  // Candidatos validos para el modelo de compactacion (Fase 3, Tarea 6):
  // cualquier modelo habilitado, de cualquier proveedor habilitado, que
  // isApiCapableModel acepte — el motor de compactacion (compaction-engine.ts)
  // solo sabe llamar a estos tres tipos de runtime con una sola vuelta HTTP.
  const compactionCandidates = useMemo(() => {
    return providersForDisplay(settings.providers)
      .filter(provider => provider.enabled)
      .flatMap(provider => provider.models
        .filter(model => model.enabled && isApiCapableModel(provider, model))
        .map(model => ({ provider, model })))
  }, [settings.providers])
  const activeChat = chatSessions.find(chat => chat.id === activeChatId) ?? chatSessions[0] ?? generalChatSession()
  const currentMessages = chats[activeChat.id] ?? []
  const activeWorkspacePath = activeProject?.path ?? activeChat.workspacePath
  const activeWorkspaceName = activeProject?.name ?? activeChat.workspaceName

  useEffect(() => {
    void bootstrap()
    void window.universalAgent.getFullscreen().then(setIsFullscreen)

    const stopAgent =
      window.universalAgent.onAgentEvent(handleAgentEvent)

    const stopToolApproval =
      window.universalAgent.onToolApprovalRequest(request => {
        setToolApprovalTrust(false)
        setToolApproval(request)
      })

    const stopToolTrust =
      window.universalAgent.onToolTrustChanged(state => setToolTrustActive(state.active))

    const stopFullscreen =
      window.universalAgent.onFullscreenChanged(setIsFullscreen)

    return () => {
      stopAgent()
      stopToolApproval()
      stopToolTrust()
      stopFullscreen()
      clearTurnWatch()
    }
  }, [])

  useEffect(() => {
    activeChatIdRef.current = activeChatId
  }, [activeChatId])

  useEffect(() => {
    if (!turnActive) return
    const id = setInterval(() => {
      if (turnStartRef.current !== null) {
        setTurnElapsedSeconds(Math.floor((Date.now() - turnStartRef.current) / 1000))
      }
    }, 1000)
    return () => clearInterval(id)
  }, [turnActive])

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

  function setMessagesFor(workspace: string, updater: (current: ChatMessage[]) => ChatMessage[]): void {
    setChats(current => ({ ...current, [workspace]: updater(current[workspace] ?? []) }))
  }

  function ensureStoredChat(chat: ChatSession = activeChat): void {
    void window.universalAgent.ensureChatSession({
      id: chat.id,
      title: chat.title,
      workspacePath: chat.workspacePath,
      workspaceName: chat.workspaceName,
      providerId: activeProvider?.id,
      modelId: activeModel?.id,
      runtime: agentRuntime
    })
  }

  function persistChatMessage(chatId: string, message: ChatMessage): void {
    void window.universalAgent.saveChatMessage({
      id: message.id,
      chatId,
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
    toolSteps?: string[]
  ): void {
    const normalizedText = text.trim()
    if (!normalizedText) return

    setNotice('')
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
          toolSteps
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
        toolSteps: toolSteps ?? copy[index].toolSteps
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

  const TURN_WATCHDOG_MS = 90000

  function startTurnWatch(workspace: string): void {
    // Solo cancela el timeout de watchdog pendiente — a diferencia de
    // clearTurnWatch(), esto se llama tambien para REARMAR el watchdog en
    // medio de un turno (cada tool-call), asi que NO debe reiniciar el
    // cronometro ni el contador de tokens ya acumulados.
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
      // Este timeout ya no dispara solo por un turno lento con varias
      // vueltas de tool-calling: cada evento de tool (item/toolCall/status)
      // reinicia el watchdog via startTurnWatch(). Si llega aqui es porque
      // no hubo NINGUNA senal de progreso (ni tool, ni texto) en 90s
      // seguidos — probablemente el proveedor se colgo. La conexion sigue
      // viva (no es un fallo de agente), asi que no se pisa agentState:
      // solo se corta el turno y se deja el chat usable para reintentar.
      const message = `ERROR AGENTE: no llego respuesta del modelo ni actividad de herramientas en ${TURN_WATCHDOG_MS / 1000}s. El turno se cerro; podes intentar de nuevo.`
      setAgentError(message)
      setNotice('')
      appendSystemMessage(workspace, message)
      clearTurnWatch()
      setToolStatus('')
      resetTurnSteps()
    }, TURN_WATCHDOG_MS)
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
    if (storedChats.sessions.length > 0) {
      const restored = storedChats.sessions.map(chat => ({
        id: chat.id,
        title: chat.title,
        workspacePath: chat.workspacePath,
        workspaceName: chat.workspaceName
      }))
      setChatSessions(restored)
      setChats(Object.fromEntries(
        Object.entries(storedChats.messages).map(([chatId, messages]) => [
          chatId,
          messages.map(toChatMessage)
        ])
      ))
      setActiveChatId(storedChats.sessions[0].id)

      // Migracion: chats creados antes de que todo chat quedara atado a un
      // workspace desde su nacimiento (modelo viejo, "chat sin workspace").
      // Se rellenan con el workspace por defecto, visible, y se persiste.
      for (const chat of restored) {
        if (chat.workspacePath) continue
        const patched = { ...chat, workspacePath: dw.path, workspaceName: dw.name }
        setChatSessions(current => current.map(item => item.id === chat.id ? patched : item))
        ensureStoredChat(patched)
      }
    } else {
      const firstChat = { ...generalChatSession(), workspacePath: dw.path, workspaceName: dw.name }
      setChatSessions([firstChat])
      ensureStoredChat(firstChat)
    }
    if (JSON.stringify(next) !== JSON.stringify(loaded)) {
      await window.universalAgent.saveSettings(next)
    }

    if (next.activeProjectPath) {
      const project = list.find(item => item.path === next.activeProjectPath)
      if (project) {
        await window.universalAgent.openWorkspace(project.path)
        setActiveProject(project)
      }
    }
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
      setNotice('')
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
      const toolWorkspacePath = asString(params.workspace)
      const phase = asString(params.phase)
      // Hay progreso real del turno (una tool arranco o termino): el turno
      // sigue vivo, aunque tarde. Reiniciar el watchdog en vez de dejar que
      // cuente desde el envio original del prompt.
      startTurnWatch(workspace)
      if (phase === 'start') {
        setToolStatus(
          toolWorkspacePath ? `Ejecutando: ${toolName} (${toolWorkspacePath})` : `Ejecutando: ${toolName}`
        )
      } else {
        const ok = params.ok !== false
        const errorDetail = asString(params.detail).trim()
        const doneText = ok
          ? `${toolName} completado`
          : errorDetail ? `${toolName} fallo: ${errorDetail}` : `${toolName} fallo`
        setToolStatus(doneText)
        // Pieza 1: se agrega como paso CERRADO al historial del turno — a
        // diferencia de setToolStatus (Pieza 2), esto nunca se sobreescribe,
        // solo crece hasta que el turno termina.
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
    // Codex (a diferencia de apiRuntime) reporta VARIOS items distintos
    // dentro de UN mismo turno (narracion + ejecucion de comandos + mas
    // narracion...), cada uno con su propio item.id — usar itemId como
    // clave de mensaje ahi fragmenta un solo turno en N burbujas de chat
    // permanentes. turnId (presente solo en eventos de Codex) agrupa todo
    // eso bajo UNA sola clave; para apiRuntime, que no manda turnId, esto
    // queda vacio y el comportamiento no cambia.
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

      if (delta) {
        if (isCodexTurn) {
          // No se persiste por item: el mensaje final unico se arma una
          // sola vez en turn/completed, con el texto ya agregado por
          // Codex. Acá solo se refleja actividad en vivo (Pieza 2).
          setToolStatus('Escribiendo...')
          startTurnWatch(workspace)
        } else {
          // Para apiRuntime este es el UNICO delta del turno (llega recien
          // cuando el turno completo ya resolvio, tools incluidas) — por eso
          // turnSteps ya esta completo aca, aunque el evento se llame "delta".
          appendAssistantMessage(workspace, itemMessageKey, delta, 'append', turnStepsRef.current)
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
        // Item intermedio cerrado del turno — nunca es la respuesta final
        // por si solo (esa se arma en turn/completed): pasa al log de
        // pasos (Pieza 1), nunca crea una burbuja de chat propia.
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
      setNotice('')
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

      // Unico punto donde se persiste la respuesta final de un turno de
      // Codex: extractAssistantText ya agrega TODOS los items de texto del
      // turno completo (ver params.turn.items), asi que esto reemplaza —
      // no duplica — lo que haya quedado de item/completed intermedios.
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

  async function syncCodexModels(): Promise<void> {
    if (!activeProvider || activeProvider.type !== 'openai-codex') return
    setAuthBusy(true)
    setNotice('Sincronizando catalogo Codex...')
    try {
      const next = await syncCodexProvider(settings, activeProvider.id)
      await persist(next)
      setNotice('Modelos Codex actualizados.')
      await disconnect()
    } catch (error) {
      setNotice(String(error))
    } finally {
      setAuthBusy(false)
    }
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
      if (parsed.connected && activeProvider?.type === 'openai-codex') {
        await persist(await syncCodexProvider(settings, activeProvider.id))
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
    await disconnect()
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
      await disconnect()

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

  async function installGeminiCli(): Promise<void> {
    setAuthBusy(true)
    setNotice('Instalando Gemini CLI con npm. Puede tardar varios minutos...')

    try {
      const result = await window.universalAgent.installGeminiCli()
      setCliStatus(await window.universalAgent.getCliStatus())
      setNotice(
        result.status?.installed
          ? `Gemini CLI instalado: ${result.status.version ?? 'version detectada'}`
          : 'Instalacion ejecutada, pero Gemini CLI todavia no fue detectado. Revisa PATH o reinicia la terminal.'
      )
    } catch (error) {
      setNotice(`ERROR instalando Gemini CLI: ${String(error)}`)
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

  async function openCliLogin(provider: ProviderProfile): Promise<void> {
    const status = provider.type === 'anthropic'
      ? cliStatus.claude
      : cliStatus.gemini

    if (!status?.installed) {
      setNotice(provider.type === 'anthropic'
        ? 'Claude Code CLI no esta instalado. Instalalo primero y despues pulsa Revisar CLI.'
        : 'Gemini CLI no esta instalado. Instalalo primero y despues pulsa Revisar CLI.')
      return
    }

    try {
      await window.universalAgent.openCliLogin(provider.type)
      setNotice(provider.type === 'anthropic'
        ? 'Se abrio Claude Code. Completa el login oficial alli.'
        : 'Se abrio Gemini CLI. Selecciona Sign in with Google alli.')
    } catch (error) {
      setNotice(String(error))
    }
  }

  function cliInstallHint(providerType: ProviderType): string {
    return providerType === 'anthropic'
      ? 'Instala Claude Code y verifica que el comando claude funcione en PowerShell o CMD.'
      : 'Instala Gemini CLI desde npm o usa el boton Instalar Gemini CLI; luego pulsa Revisar CLI.'
  }

  async function resetLocalState(): Promise<void> {
    const ok = window.confirm(
      'Esto borrara conexiones, modelos y carpetas raiz guardadas por Electron. No borra archivos del disco. Continuar?'
    )

    if (!ok) return

    const next = await window.universalAgent.resetLocalState()
    setSettings(next)
    setProjects([])
    setActiveProject(null)
    setChats({})
    const firstChat = defaultWorkspace
      ? { ...generalChatSession(), workspacePath: defaultWorkspace.path, workspaceName: defaultWorkspace.name }
      : generalChatSession()
    setChatSessions([firstChat])
    setActiveChatId(GENERAL_CHAT_ID)
    ensureStoredChat(firstChat)
    setPrompt('')
    setAgentState('idle')
    setAgentRuntime('')
    setAgentError('')
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
    setActiveProject(null)
    setAgentState('idle')
    setAgentRuntime('')
    setAgentError('')
    setNotice('Carpeta raiz removida de la configuracion.')
  }

  async function addProjectRoot(): Promise<void> {
    const root = await window.universalAgent.addProjectRoot()
    if (!root) return
    mutateSettings(current => ({
      ...current,
      projectRoots: [...current.projectRoots.filter(item => item.id !== root.id), root]
    }), true)
    setProjects(await window.universalAgent.listProjects())
  }

  async function openProject(project: ProjectEntry): Promise<void> {
    await window.universalAgent.openWorkspace(project.path)
    const chat: ChatSession = {
      id: project.path,
      title: project.name,
      workspacePath: project.path,
      workspaceName: project.name
    }
    ensureStoredChat(chat)
    setActiveProject(project)
    setActiveChatId(project.path)
    setChatSessions(current => {
      if (current.some(chat => chat.id === project.path)) return current
      return [
        ...current,
        chat
      ]
    })
    mutateSettings(current => ({ ...current, activeProjectPath: project.path }), true)
    setAgentState('idle')
    setAgentRuntime('')
    setAgentError('')
  }

  async function disconnect(): Promise<void> {
    await window.universalAgent.disconnectAgent()
    setAgentState('idle')
    setAgentRuntime('')
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

  function addProvider(type: ProviderType, authMode: AuthMode): void {
    const provider = newProvider(type, authMode)
    mutateSettings(current => ({
      ...current,
      providers: [...current.providers, provider],
      activeProviderId: provider.id,
      activeModelId: provider.models[0]?.id
    }), true)
    void disconnect()
  }

  function addDeepSeekProvider(): void {
    const provider = newDeepSeekProvider()
    mutateSettings(current => ({
      ...current,
      providers: [...current.providers, provider],
      activeProviderId: provider.id,
      activeModelId: provider.models[0]?.id
    }), true)
    void disconnect()
  }

  function deleteProvider(providerId: string): void {
    const provider = settings.providers.find(item => item.id === providerId)
    if (!provider || !window.confirm(`Eliminar la conexion "${provider.name}"?`)) return

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
    void disconnect()
  }

  function toggleProvider(providerId: string): void {
    updateProvider(providerId, provider => ({ ...provider, enabled: !provider.enabled }), true)
    void disconnect()
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
    void disconnect()
  }

  function toggleModel(providerId: string, modelId: string): void {
    updateProvider(providerId, provider => ({
      ...provider,
      models: provider.models.map(model =>
        model.id === modelId ? { ...model, enabled: !model.enabled } : model
      )
    }), true)
    void disconnect()
  }

  function selectProvider(provider: ProviderProfile): void {
    const model = pickModel(provider)
    mutateSettings(current => ({
      ...current,
      activeProviderId: provider.id,
      activeModelId: model?.id
    }), true)
    void disconnect()
  }

  function selectModel(provider: ProviderProfile, model: ModelProfile): void {
    mutateSettings(current => ({
      ...current,
      activeProviderId: provider.id,
      activeModelId: model.id
    }), true)
    setModelMenuOpen(false)
    void disconnect()
  }

  /** Modelo dedicado de compactacion (Fase 3, Tarea 6). Sin providerId/modelId
   *  (undefined, undefined) borra la eleccion: la compactacion cae al modelo
   *  activo de cada turno — no requiere desconectar el agente, no es una
   *  propiedad del runtime en vuelo. */
  function setCompactionModel(providerId: string | undefined, modelId: string | undefined): void {
    mutateSettings(current => ({
      ...current,
      compactionProviderId: providerId,
      compactionModelId: modelId
    }), true)
  }

  async function toggleFullscreen(): Promise<void> {
    const next = await window.universalAgent.setFullscreen(!isFullscreen)
    setIsFullscreen(next)
  }

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
      !codexAccount.connected
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
    if (activeProvider.type === 'google' && activeProvider.authMode === 'subscription' && !cliStatus.gemini?.installed) {
      return 'Gemini CLI no esta instalado.'
    }
    if (
      (activeProvider.type === 'openai-codex' ||
       activeProvider.type === 'openai' || activeProvider.type === 'openai-compatible') &&
      !cliStatus.codex?.installed
    ) return 'Codex CLI no esta instalado.'

    return null
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
      const result = await window.universalAgent.connectAgent({
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
      return true
    } catch (error) {
      setAgentState('error')
      setAgentError(String(error))
      return false
    }
  }

  /**
   * Nucleo compartido del envio de un turno: dispara agent:send y maneja
   * error/watchdog. NO toca el mensaje de usuario en si (agregarlo o no a
   * chats/DB es responsabilidad de quien llama) — lo reusan tanto el envio
   * normal (sendPrompt) como regenerar (regenerateFrom), que difieren solo
   * en si hay que crear un mensaje de usuario nuevo o reusar uno existente.
   */
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
      setNotice('Turno enviado al agente. Esperando respuesta...')
      await window.universalAgent.sendMessage({
        text: outboundText,
        chatId: activeChat.id,
        attachments: lightweightAttachments,
        history,
        providerId: activeProvider.id,
        modelId: activeModel.id,
        sandbox
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

  /** Edita un mensaje de usuario ya enviado: borra ese mensaje y todo lo
   *  posterior (memoria + DB), y precarga el texto en el composer para que
   *  el usuario lo reenvie editado — mismo patron que Claude Code/Codex,
   *  no hay edicion inline de un turno ya cerrado. */
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
    const chatId = activeChat.id
    const index = currentMessages.findIndex(item => item.id === message.id)
    if (index < 0) return
    const truncated = currentMessages.slice(0, index)
    setMessagesFor(chatId, () => truncated)
    void window.universalAgent.deleteChatMessagesFrom(chatId, message.id)
    setPrompt(message.text)
    textareaRef.current?.focus()
  }

  /** Regenera una respuesta del asistente: borra esa respuesta y todo lo
   *  posterior (memoria + DB), y reenvia el mensaje de usuario que la
   *  origino tal cual. Reemplazo simple, sin ramas/versiones. */
  async function regenerateFrom(message: ChatMessage): Promise<void> {
    if (message.role !== 'assistant') return
    if (turnActive) await cancelAgent()
    const chatId = activeChat.id
    const index = currentMessages.findIndex(item => item.id === message.id)
    if (index < 0) return
    let userIndex = index - 1
    while (userIndex >= 0 && currentMessages[userIndex].role !== 'user') userIndex--
    if (userIndex < 0) return

    const userMessage = currentMessages[userIndex]
    const historyBefore = currentMessages.slice(0, userIndex)
    const keptWithUser = currentMessages.slice(0, userIndex + 1)

    setMessagesFor(chatId, () => keptWithUser)
    void window.universalAgent.deleteChatMessagesFrom(chatId, message.id)

    const lightweightAttachments = runtimeAttachments(userMessage.attachments ?? [])
    const outboundText = [userMessage.text, attachmentSummary(lightweightAttachments)].filter(Boolean).join('\n\n')

    await runTurn(outboundText, lightweightAttachments, historyBefore)
  }

  async function cancelAgent(): Promise<void> {
    // El cierre real (mensaje "Detenido por el usuario", timer, tokens,
    // agentState de vuelta a 'connected') llega por el evento
    // turn/cancelled que emite el proceso main una vez que el loop de
    // tool-calling efectivamente aborta — este invoke solo dispara el abort.
    await window.universalAgent.cancelAgent()
  }

  async function answerApproval(decision: 'accept' | 'decline' | 'acceptForSession'): Promise<void> {
    if (!approval) return
    await window.universalAgent.replyToAgent(approval.requestId, { decision })
    setApproval(null)
  }

  async function answerToolApproval(approved: boolean): Promise<void> {
    if (!toolApproval) return
    await window.universalAgent.respondToolApproval(toolApproval.id, approved, approved && toolApprovalTrust)
    setToolApproval(null)
    setToolApprovalTrust(false)
  }

  async function pickAttachments(): Promise<void> {
    try {
      const selected = await window.universalAgent.pickAttachments()
      if (selected.length === 0) return
      setPendingAttachments(current => [...current, ...selected])
      setNotice('')
    } catch (error) {
      setAgentError(String(error))
    }
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
      setNotice('')
    } catch (error) {
      setAgentError(String(error))
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
      setNotice('')
      return true
    } catch (error) {
      setAgentError(String(error))
      return false
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
    // Nunca guardar vacio: si el usuario borro todo, se mantiene el nombre anterior.
    const nextTitle = editingChatTitle.trim() || chat?.title || 'Chat nuevo'
    setEditingChatId(null)
    setEditingChatTitle('')
    if (!chat || nextTitle === chat.title) return
    setChatSessions(current => current.map(item =>
      item.id === chatId ? { ...item, title: nextTitle } : item
    ))
    void window.universalAgent.renameChatSession(chatId, nextTitle)
  }

  function deleteChat(chatId: string): void {
    const nextSessions = chatSessions.filter(chat => chat.id !== chatId)
    const fallback = nextSessions[0] ?? (defaultWorkspace
      ? { ...generalChatSession(), workspacePath: defaultWorkspace.path, workspaceName: defaultWorkspace.name }
      : generalChatSession())
    setChatSessions(nextSessions.length > 0 ? nextSessions : [fallback])
    if (nextSessions.length === 0) ensureStoredChat(fallback)
    setChats(current => {
      const next = { ...current }
      delete next[chatId]
      return next
    })
    if (activeChat.id === chatId) {
      setActiveChatId(fallback.id)
      const project = fallback.workspacePath
        ? projects.find(item => item.path === fallback.workspacePath) ?? null
        : null
      setActiveProject(project)
      void disconnect()
    }
    void window.universalAgent.deleteChatSession(chatId)
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

  function selectAllComposerText(): void {
    textareaRef.current?.focus()
    textareaRef.current?.setSelectionRange(0, prompt.length)
  }

  const missing = readiness()
  const providerMode = activeProvider ? providerModeLabel(activeProvider) : 'Sin conexion'

  return (
    <div className="app">
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

        <button
          className="new-chat"
          onClick={() => {
            const id = crypto.randomUUID()
            // Todo chat nace atado a un workspace, igual que una sesion de
            // Claude Code hereda el cwd desde donde se invoca: si hay un
            // proyecto activo en el sidebar, el chat nuevo lo hereda; si no,
            // cae al workspace por defecto (visible, no oculto).
            const inherited = activeProject
              ? { workspacePath: activeProject.path, workspaceName: activeProject.name }
              : defaultWorkspace
                ? { workspacePath: defaultWorkspace.path, workspaceName: defaultWorkspace.name }
                : {}
            const chat: ChatSession = { id, title: 'Chat nuevo', ...inherited }
            setActiveChatId(id)
            setChatSessions(current => [
              chat,
              ...current
            ])
            setChats(current => ({ ...current, [id]: [] }))
            ensureStoredChat(chat)
            setAgentError('')
            setNotice('')
            void disconnect()
          }}
        >
          + Nuevo chat
        </button>

        <div className="sidebar-scroll">
          <div className="section-label">CHATS</div>
          {chatSessions.map(chat => (
            <div
              key={chat.id}
              className={activeChat.id === chat.id ? 'chat-row active' : 'chat-row'}
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
                  onClick={() => {
                    setActiveChatId(chat.id)
                    const project = chat.workspacePath
                      ? projects.find(item => item.path === chat.workspacePath) ?? null
                      : null
                    setActiveProject(project)
                    setAgentState('idle')
                    setAgentRuntime('')
                    setAgentError('')
                    void disconnect()
                  }}
                >
                  <span className="chat-title-main">{chat.title}</span>
                  {chat.workspaceName && (
                    <span className="chat-title-sub">{chat.workspaceName}</span>
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
          ))}

          <div className="section-label">PROYECTOS</div>
          {settings.projectRoots.map(root => (
            <div key={root.id} className="root-block">
              <div className="root-title root-title-row">
                <button
                  className={activeProject?.id === root.id ? 'root-title-open active' : 'root-title-open'}
                  title="Abrir esta carpeta como workspace activo"
                  onClick={() => void openProject({ id: root.id, name: root.name, path: root.path, rootId: root.id })}
                >
                  ⌄ {root.name}
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
                <button
                  key={project.id}
                  className={activeProject?.id === project.id ? 'project active' : 'project'}
                  onClick={() => void openProject(project)}
                >
                  {project.name}
                </button>
              ))}
            </div>
          ))}
          <button className="add-root" onClick={() => void addProjectRoot()}>+ Agregar raiz</button>
          <button className="reset-local" onClick={() => void resetLocalState()}>
            Reiniciar configuracion local
          </button>
        </div>

        <div className="sidebar-footer">
          <span className={agentState === 'connected' ? 'dot connected' : 'dot'} />
          <span className="sidebar-project">{activeWorkspaceName ?? activeChat.title}</span>
          <small>{agentState === 'connected' ? agentRuntime : 'sin agente'}</small>
        </div>
      </aside>

      <main className="main">
        <header className="topbar">
          <div className="topbar-title">{activeWorkspaceName ?? activeChat.title}</div>
          <div className="topbar-actions">
            <button
              className="topbar-btn"
              onClick={() => void toggleFullscreen()}
            >
              {isFullscreen ? 'Salir pantalla completa' : 'Pantalla completa'}
            </button>
            <button
              className="topbar-btn"
              onClick={() => setDebugOpen(value => !value)}
            >
              Eventos ({agentEvents.length})
            </button>

            <button
              className="topbar-btn"
              onClick={() => setSettingsOpen(true)}
            >
              Modelos y cuentas
            </button>
          </div>
        </header>

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
                className={`message ${message.role}`}
                onContextMenu={event => {
                  event.preventDefault()
                  setContextMenu({
                    type: 'message',
                    messageId: message.id,
                    text: message.text,
                    role: message.role,
                    x: event.clientX,
                    y: event.clientY
                  })
                }}
              >
                <ChatMessageView message={message} onOpenImage={setImagePreview} />
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
                  {activeProvider ? `${providerDisplayName(activeProvider)} · ${providerMode}` : 'Sin proveedor'}
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
                      onClick={() => void window.universalAgent.disableToolTrust()}
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
                setContextMenu({ type: 'composer', x: event.clientX, y: event.clientY })
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
                      onOpenImage={setImagePreview}
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
                  setContextMenu({ type: 'composer', x: event.clientX, y: event.clientY })
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

                <div className="model-anchor">
                  <button className="model-btn" onClick={() => setModelMenuOpen(!modelMenuOpen)}>
                    <span>{activeModel?.displayName ?? 'Modelo'}</span><span>⌄</span>
                  </button>
                  {modelMenuOpen && (
                    <div className="model-menu">
                      {providersForDisplay(settings.providers).filter(provider => provider.enabled).map(provider => (
                        <div key={provider.id}>
                          <div className="menu-provider">
                            <span>{providerDisplayName(provider)}</span>
                            <small>{providerGroupLabel(provider)}</small>
                          </div>
                          {provider.models.filter(model => model.enabled).map(model => (
                            <button
                              key={model.id}
                              className={activeModel?.id === model.id ? 'model-option active' : 'model-option'}
                              onClick={() => selectModel(provider, model)}
                            >
                              {model.displayName}
                            </button>
                          ))}
                        </div>
                      ))}
                      <div className="menu-divider" />
                      <button
                        className="menu-settings"
                        onClick={() => {
                          setModelMenuOpen(false)
                          setSettingsOpen(true)
                        }}
                      >
                        Configurar modelos y cuentas...
                      </button>
                    </div>
                  )}
                </div>

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
                  void navigator.clipboard.writeText(contextMenu.text)
                  setContextMenu(null)
                }}
              >
                Copiar mensaje
              </button>
              {contextMenu.role === 'user' && (
                <button
                  onClick={() => {
                    const target = currentMessages.find(item => item.id === contextMenu.messageId)
                    if (target) void startEditMessage(target)
                    setContextMenu(null)
                  }}
                >
                  Editar mensaje
                </button>
              )}
              {contextMenu.role === 'assistant' && (
                <button
                  onClick={() => {
                    const target = currentMessages.find(item => item.id === contextMenu.messageId)
                    if (target) void regenerateFrom(target)
                    setContextMenu(null)
                  }}
                >
                  Regenerar respuesta
                </button>
              )}
            </>
          ) : (
            <>
              <button
                onClick={() => {
                  void cutComposerText()
                  setContextMenu(null)
                }}
              >
                Cortar
              </button>
              <button
                onClick={() => {
                  void copyComposerText()
                  setContextMenu(null)
                }}
              >
                Copiar
              </button>
              <button
                onClick={() => {
                  void pasteComposerText()
                  setContextMenu(null)
                }}
              >
                Pegar
              </button>
              <button
                onClick={() => {
                  selectAllComposerText()
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
              <button className="close-btn" onClick={() => setSettingsOpen(false)}>x</button>
            </div>

            <div className="settings-content">
              <section className="settings-section">
                <div className="section-heading-row">
                  <div className="section-label">CONEXIONES</div>
                  <div className="connection-tools">
                    <button
                      className="small-btn"
                      disabled={authBusy}
                      onClick={() => void importQConfig()}
                    >
                      Importar q_config.yaml
                    </button>
                    <button className="small-btn" onClick={() => void refreshCliStatus()}>Revisar CLI</button>
                  </div>
                </div>

                <div className="connections">
                  {providersForDisplay(settings.providers).map(provider => (
                    <div key={provider.id} className={activeProvider?.id === provider.id ? 'connection active' : 'connection'}>
                      <button className="connection-main" onClick={() => selectProvider(provider)}>
                        <span>{providerDisplayName(provider)}</span>
                        <small>{providerSubtitle(provider)}</small>
                      </button>
                      <button className="connection-toggle" onClick={() => toggleProvider(provider.id)}>
                        {provider.enabled ? 'Desactivar' : 'Activar'}
                      </button>
                      <button className="danger-link" onClick={() => deleteProvider(provider.id)}>Eliminar</button>
                    </div>
                  ))}
                </div>

                <details className="add-connection">
                  <summary>+ Agregar conexion</summary>
                  <div className="add-grid">
                    <button onClick={() => addProvider('openai-codex', 'subscription')}>Codex ChatGPT<small>Suscripcion</small></button>
                    <button onClick={() => addProvider('foundry', 'api-key')}>Foundry<small>API key</small></button>
                    <button onClick={() => addProvider('openai', 'api-key')}>OpenAI<small>API</small></button>
                    <button onClick={() => addProvider('anthropic', 'subscription')}>Claude Pro<small>Suscripcion</small></button>
                    <button onClick={() => addProvider('anthropic', 'api-key')}>Claude<small>API key / Azure</small></button>
                    <button onClick={() => addDeepSeekProvider()}>DeepSeek<small>API key</small></button>
                    <button onClick={() => addProvider('google', 'subscription')}>Gemini Advanced<small>Suscripcion Google</small></button>
                    <button onClick={() => addProvider('google', 'api-key')}>Gemini<small>API key</small></button>
                    <button onClick={() => addProvider('openai-compatible', 'api-key')}>Compatible<small>Responses API</small></button>
                  </div>
                </details>
              </section>

              <section className="settings-section">
                <div className="section-label">MEMORIA</div>
                <p className="settings-hint">
                  Cuando un chat acumula mas de ~{Math.round(CONTEXT_TOKEN_BUDGET / 1000)}k tokens estimados de
                  historial, AMATISTA lo resume en segundo plano (nunca durante el turno en curso) para no perder
                  contexto viejo en silencio. Podes dedicar un modelo aparte, mas barato, solo para esto.
                </p>
                <label className="field">
                  <span>Modelo de compactacion</span>
                  <select
                    value={settings.compactionModelId ?? ''}
                    onChange={event => {
                      const modelId = event.target.value
                      if (!modelId) {
                        setCompactionModel(undefined, undefined)
                        return
                      }
                      const match = compactionCandidates.find(item => item.model.id === modelId)
                      setCompactionModel(match?.provider.id, match?.model.id)
                    }}
                  >
                    <option value="">Usar el modelo activo (sin dedicar uno)</option>
                    {compactionCandidates.map(({ provider, model }) => (
                      <option key={model.id} value={model.id}>
                        {providerDisplayName(provider)} · {model.displayName}
                      </option>
                    ))}
                  </select>
                </label>
                {!settings.compactionModelId && (
                  <div className="notice">
                    Sugerido: elegi un modelo barato (Gemini Flash, DeepSeek Flash) solo para compactar memoria y
                    ahorrar costo — sin elegir ninguno, cada compactacion usa el mismo modelo activo de la
                    conversacion.
                  </div>
                )}
              </section>

              {activeProvider && (
                <>
                  <section className="settings-section">
                    <div className="section-label">{providerDisplayName(activeProvider).toUpperCase()}</div>

                    <label className="field">
                      <span>Nombre visible</span>
                      <input
                        value={activeProvider.name}
                        onChange={event => updateProvider(activeProvider.id, provider => ({ ...provider, name: event.target.value }))}
                      />
                    </label>

                    {activeProvider.type === 'openai-codex' && activeProvider.authMode === 'subscription' ? (
                      <div className="account-card">
                        <div className="account-status-row">
                          <span className={codexAccount.connected ? 'status-badge connected' : 'status-badge'}>
                            {codexAccount.connected ? 'ChatGPT conectado' : 'Sin sesion ChatGPT'}
                          </span>
                          {codexAccount.planType && <span className="plan-badge">{codexAccount.planType}</span>}
                        </div>
                        <div className="account-email">{codexAccount.email ?? codexAccount.detail ?? 'Cuenta ChatGPT'}</div>
                        <div className="account-actions">
                          <button className="primary-btn" disabled={authBusy} onClick={() => void loginCodex()}>
                            {codexAccount.connected ? 'Cambiar cuenta' : 'Conectar ChatGPT'}
                          </button>
                          <button className="secondary-btn" disabled={authBusy} onClick={() => void checkCodexAccount()}>Comprobar</button>
                          <button className="secondary-btn" disabled={authBusy} onClick={() => void syncCodexModels()}>Sincronizar modelos</button>
                          {codexAccount.connected && <button className="danger-btn" onClick={() => void logoutCodex()}>Cerrar sesion</button>}
                        </div>
                        <p>El login se abre en ChatGPT. Si tu cuenta usa Google, selecciona Google alli.</p>
                      </div>
                    ) : (
                      <>
                        <label className="field">
                          <span>Autenticacion</span>
                          <select
                            value={activeProvider.authMode}
                            onChange={event => {
                              const authMode = event.target.value as AuthMode
                              const runtime = runtimeFor(activeProvider.type, authMode)
                              updateProvider(activeProvider.id, provider => ({
                                ...provider,
                                authMode,
                                models: provider.models.map(model => ({ ...model, runtime }))
                              }))
                              void disconnect()
                            }}
                          >
                            <option value="subscription">Suscripcion / sesion oficial</option>
                            <option value="api-key">API key</option>
                          </select>
                        </label>

                        {activeProvider.authMode === 'subscription' && (activeProvider.type === 'anthropic' || activeProvider.type === 'google') && (
                          <div className="cli-card">
                            <div>
                              <strong>{activeProvider.type === 'anthropic' ? 'Claude Code' : 'Gemini CLI'}</strong>
                              <small>
                                {activeProvider.type === 'anthropic'
                                  ? cliStatus.claude?.installed ? cliStatus.claude.version : 'No instalado'
                                  : cliStatus.gemini?.installed ? cliStatus.gemini.version : 'No instalado'}
                              </small>
                              {(activeProvider.type === 'anthropic'
                                ? !cliStatus.claude?.installed
                                : !cliStatus.gemini?.installed) && (
                                <span className="cli-install-hint">
                                  {cliInstallHint(activeProvider.type)}
                                </span>
                              )}
                            </div>
                            <button
                              className="primary-btn"
                              disabled={activeProvider.type === 'anthropic'
                                ? !cliStatus.claude?.installed
                                : !cliStatus.gemini?.installed}
                              onClick={() => void openCliLogin(activeProvider)}
                            >
                              {activeProvider.type === 'anthropic' ? 'Abrir login Claude' : 'Login con Google'}
                            </button>
                            {activeProvider.type === 'anthropic' && !cliStatus.claude?.installed && (
                              <button
                                className="secondary-btn"
                                disabled={authBusy}
                                onClick={() => void installClaudeCli()}
                              >
                                Instalar Claude Code
                              </button>
                            )}
                            {activeProvider.type === 'google' && !cliStatus.gemini?.installed && (
                              <button
                                className="secondary-btn"
                                disabled={authBusy}
                                onClick={() => void installGeminiCli()}
                              >
                                Instalar Gemini CLI
                              </button>
                            )}
                          </div>
                        )}

                        {activeProvider.authMode === 'api-key' && (
                          <>
                            {(activeProvider.type === 'foundry' || activeProvider.type === 'openai' || activeProvider.type === 'openai-compatible' || activeProvider.type === 'anthropic') && (
                              <label className="field">
                                <span>Endpoint</span>
                                <input
                                  value={activeProvider.endpoint ?? ''}
                                  placeholder={activeProvider.type === 'openai' ? 'https://api.openai.com/v1' : 'https://...'}
                                  onChange={event => updateProvider(activeProvider.id, provider => ({ ...provider, endpoint: event.target.value }))}
                                />
                              </label>
                            )}
                            <label className="field">
                              <span>API key</span>
                              <input
                                type="password"
                                value={activeProvider.apiKey ?? ''}
                                onChange={event => updateProvider(activeProvider.id, provider => ({ ...provider, apiKey: event.target.value }))}
                              />
                            </label>
                          </>
                        )}
                      </>
                    )}

                    {notice && <div className="notice">{notice}</div>}
                  </section>

                  <section className="settings-section">
                    <div className="section-heading-row">
                      <div className="section-label">MODELOS</div>
                      {activeProvider.type !== 'openai-codex' && (
                        <button className="small-btn" onClick={() => addManualModel(activeProvider)}>ï¼‹ Agregar</button>
                      )}
                    </div>

                    {activeProvider.type === 'openai-codex' && activeProvider.models.length === 0 && (
                      <div className="empty-models">
                        Los modelos Codex se cargan automaticamente al detectar una sesion ChatGPT. Tambien puedes usar Sincronizar modelos.
                      </div>
                    )}

                    <div className="model-list">
                      {activeProvider.models.map(model => (
                        <div key={model.id} className={model.enabled ? 'model-card' : 'model-card disabled'}>
                          {activeProvider.type === 'openai-codex' ? (
                            <div className="catalog-model">
                              <strong>{model.displayName}</strong>
                              <small>{model.model}</small>
                              {model.reasoningLevels?.length ? <span>Esfuerzo: {model.reasoningLevels.join(' · ')}</span> : null}
                            </div>
                          ) : (
                            <>
                              <label className="field compact">
                                <span>Nombre</span>
                                <input
                                  value={model.displayName}
                                  onChange={event => updateProvider(activeProvider.id, provider => ({
                                    ...provider,
                                    models: provider.models.map(item => item.id === model.id ? { ...item, displayName: event.target.value } : item)
                                  }))}
                                />
                              </label>
                              <label className="field compact">
                                <span>Modelo / deployment</span>
                                <input
                                  value={model.model}
                                  placeholder={activeProvider.type === 'google' ? 'Vacio = Auto' : 'modelo'}
                                  onChange={event => updateProvider(activeProvider.id, provider => ({
                                    ...provider,
                                    models: provider.models.map(item => item.id === model.id ? { ...item, model: event.target.value } : item)
                                  }))}
                                />
                              </label>
                              <label className="field compact">
                                <span>Techo de tokens de salida</span>
                                <input
                                  type="number"
                                  min={1}
                                  value={model.maxOutputTokens ?? ''}
                                  placeholder="Vacio = techo generoso por defecto"
                                  onChange={event => {
                                    const raw = event.target.value.trim()
                                    const parsed = raw ? Number(raw) : undefined
                                    const maxOutputTokens = parsed !== undefined && Number.isFinite(parsed) && parsed > 0 ? parsed : undefined
                                    updateProvider(activeProvider.id, provider => ({
                                      ...provider,
                                      models: provider.models.map(item => item.id === model.id ? { ...item, maxOutputTokens } : item)
                                    }))
                                  }}
                                />
                              </label>
                            </>
                          )}

                          <div className="model-actions">
                            <span className="runtime-label">{model.runtime}</span>
                            <button className="secondary-btn" onClick={() => toggleModel(activeProvider.id, model.id)}>
                              {model.enabled ? 'Desactivar' : 'Activar'}
                            </button>
                            <button className="danger-link" onClick={() => deleteModel(activeProvider.id, model.id)}>Quitar</button>
                          </div>
                        </div>
                      ))}
                    </div>
                  </section>
                </>
              )}
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

      {approval && (
        <div className="approval-overlay">
          <div className="approval-dialog">
            <h3>Aprobacion requerida</h3>
            <small>{approval.method}</small>
            <pre>{JSON.stringify(approval.params, null, 2)}</pre>
            <div className="approval-actions">
              <button className="secondary-btn" onClick={() => void answerApproval('decline')}>Rechazar</button>
              <button className="primary-btn" onClick={() => void answerApproval('accept')}>Aceptar</button>
              {approval.method === 'item/commandExecution/requestApproval' && (
                <button className="primary-btn" onClick={() => void answerApproval('acceptForSession')}>Aceptar sesion</button>
              )}
            </div>
          </div>
        </div>
      )}

      {toolApproval && (
        <div className="approval-overlay">
          <div className="approval-dialog">
            <h3>Aprobacion requerida</h3>
            <small>{toolApproval.title}</small>
            {toolApproval.title.startsWith('Escribir archivo:') ? (
              <pre className="diff-block">
                {toolApproval.detail.split('\n').map((line, index) => {
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
              <pre>{toolApproval.detail}</pre>
            )}
            <label className="trust-checkbox">
              <input
                type="checkbox"
                checked={toolApprovalTrust}
                onChange={event => setToolApprovalTrust(event.target.checked)}
              />
              Confiar en este agente por el resto de esta sesion (no volver a preguntar)
            </label>
            <div className="approval-actions">
              <button className="secondary-btn" onClick={() => void answerToolApproval(false)}>Rechazar</button>
              <button className="primary-btn" onClick={() => void answerToolApproval(true)}>Aprobar</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}





