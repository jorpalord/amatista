import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync, unlinkSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse as parseYaml } from 'yaml'
import { randomUUID } from 'node:crypto'
import { CodexClient } from './codex-client'
import { CodexAccountBridge } from './codex-account-bridge'
import { CliAgentRuntime } from './cli-agent-runtime'
import { ApiAgentRuntime, TurnCancelledError } from './api-agent-runtime'
import { ToolRegistry } from './tool-registry'
import { ensureStorageRootOrExit, getAppDataRoot, getAppDataSubdir } from './app-paths'
import { normalizeHistory } from './context-envelope'
import { loadSettings, saveSettings } from './settings-store'
import { scanProjectRoot } from './project-registry'
import { detectClaude, detectCodex, detectGemini } from './cli-status'
import { openClaudeLogin, openGeminiLogin } from './auth-manager'
import {
  deleteChatMessagesFrom,
  deleteChatSession,
  ensureChatSession,
  loadChatSnapshot,
  renameChatSession,
  saveChatMessage
} from './chat-store'
import type {
  AppSettings,
  ChatAttachment,
  ConversationRole,
  ConversationMessage,
  ModelProfile,
  ProviderProfile,
  RuntimeContextEnvelope,
  SandboxMode
} from '../shared/types'

interface TreeNode {
  name: string
  path: string
  type: 'file' | 'directory'
  children?: TreeNode[]
}

const ignoredDirectories = new Set([
  '.git', 'node_modules', 'dist', 'out', 'build', '.next', '.venv', 'venv', '__pycache__'
])
const MAX_TEXT_FILE_BYTES = 2 * 1024 * 1024
const MAX_ATTACHMENT_TEXT_BYTES = 1 * 1024 * 1024
const MAX_ATTACHMENT_PREVIEW_BYTES = 20 * 1024 * 1024
const execFileAsync = promisify(execFile)
const DEBUG_TOOLS = process.env.AMATISTA_DEBUG_TOOLS === '1'
const FOUNDRY_Q_ASSISTANT_DEPLOYMENTS = [
  'gpt-5.5',
  'gpt-5.3-codex',
  'gpt-chat-latest',
  'gpt-5.4',
  'sora-2',
  'gpt-image-2',
  'model-router',
  'DeepSeek-V4-Pro',
  'gpt-4o-mini-tts',
  'gpt-4o-transcribe',
  'claude-opus-4-6',
  'claude-opus-4-8'
]

let mainWindow: BrowserWindow | null = null
let codexClient: CodexClient | null = null
const codexAccountBridge = new CodexAccountBridge()
let cliRuntime: CliAgentRuntime | null = null
let apiRuntime: ApiAgentRuntime | null = null
let activeRuntime: 'codex' | 'claude' | 'gemini' | 'foundry' | 'gemini-api' | 'anthropic-api' | null = null
let activeWorkspace: string | null = null
let activeThreadId: string | null = null
let activeChatId: string | null = null
let activeContextSeeded = false
let isDisconnecting = false
let settings: AppSettings = { providers: [], projectRoots: [] }
const toolRegistry = new ToolRegistry()
const pendingToolApprovals = new Map<string, (approved: boolean) => void>()
let toolTrustSession = false
/** Turno apiRuntime actualmente en vuelo (si hay uno). Un solo turno activo
 *  a la vez por diseño (mismo supuesto que activeRuntime/apiRuntime). */
let currentTurnAbort: AbortController | null = null

/** Cancela el turno en curso (boton Detener) y limpia cualquier aprobacion
 *  de tool pendiente, igual que hace disconnectAgent(). */
function cancelCurrentTurn(): boolean {
  if (!currentTurnAbort) return false
  currentTurnAbort.abort()
  for (const resolve of pendingToolApprovals.values()) resolve(false)
  pendingToolApprovals.clear()
  return true
}

function setToolTrustSession(active: boolean): void {
  toolTrustSession = active
  sendToRenderer('agent:toolTrust', { active })
}

function requestToolApproval(title: string, detail: string): Promise<boolean> {
  if (toolTrustSession) return Promise.resolve(true)

  return new Promise(resolve => {
    const id = randomUUID()
    pendingToolApprovals.set(id, resolve)
    sendToRenderer('agent:toolApproval', { id, title, detail })
  })
}

// Storage centralizado: TODO lo que Amatista (y Electron internamente:
// cache, cookies, local storage) escribe en disco vive bajo D:\AMATISTA\data.
// Nunca hay fallback silencioso a C:\ — si la unidad D:\ no existe, la app
// muestra un dialogo bloqueante y cierra. Ver src/main/app-paths.ts.
ensureStorageRootOrExit()
app.setPath('userData', getAppDataRoot())

function canUseMainWindow(): boolean {
  return Boolean(
    mainWindow &&
    !mainWindow.isDestroyed() &&
    mainWindow.webContents &&
    !mainWindow.webContents.isDestroyed()
  )
}

function sendToRenderer(channel: string, payload: unknown): void {
  if (!canUseMainWindow()) return

  try {
    mainWindow!.webContents.send(channel, payload)
  } catch {
    // La ventana pudo destruirse entre el guard y el envÃ­o.
  }
}

function sendAgentEvent(payload: Record<string, unknown>): void {
  sendToRenderer('agent:event', {
    workspace: activeWorkspace,
    chatId: activeChatId,
    ...payload
  })
}

function disconnectAgent(): void {
  if (isDisconnecting) return
  isDisconnecting = true

  try {
    currentTurnAbort?.abort()
    codexClient?.removeAllListeners()
    cliRuntime?.removeAllListeners()
    apiRuntime?.removeAllListeners()
    codexClient?.stop()
    cliRuntime?.stop()
    apiRuntime?.stop()
  } catch {
    // Procesos hijos pueden haber terminado ya.
  } finally {
    codexClient = null
    cliRuntime = null
    apiRuntime = null
    activeThreadId = null
    activeChatId = null
    activeRuntime = null
    activeContextSeeded = false
    isDisconnecting = false
    currentTurnAbort = null
    for (const resolve of pendingToolApprovals.values()) resolve(false)
    pendingToolApprovals.clear()
    if (toolTrustSession) setToolTrustSession(false)
  }
}

function resolvedWorkspace(): string {
  if (!activeWorkspace) throw new Error('No existe workspace activo.')
  return realpathSync(activeWorkspace)
}

function defaultChatWorkspace(): string {
  const workspace = path.join(getAppDataSubdir('workspaces'), 'general-chat-workspace')
  mkdirSync(workspace, { recursive: true })
  return realpathSync(workspace)
}

function assertInsideWorkspace(candidate: string): string {
  const workspace = resolvedWorkspace()
  const target = realpathSync(candidate)
  const relative = path.relative(workspace, target)
  const isInside = relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
  if (!isInside) throw new Error('Acceso fuera del workspace rechazado.')
  return target
}


function asConfigRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null
    ? value as Record<string, unknown>
    : {}
}

function cfgString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function mimeTypeFor(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase()
  if (['.png'].includes(ext)) return 'image/png'
  if (['.jpg', '.jpeg'].includes(ext)) return 'image/jpeg'
  if (['.ico'].includes(ext)) return 'image/x-icon'
  if (['.webp'].includes(ext)) return 'image/webp'
  if (['.gif'].includes(ext)) return 'image/gif'
  if (['.txt', '.md', '.csv', '.json', '.yaml', '.yml', '.xml', '.html', '.css', '.js', '.ts', '.tsx', '.py', '.ps1'].includes(ext)) return 'text/plain'
  if (ext === '.pdf') return 'application/pdf'
  return 'application/octet-stream'
}

function attachmentKind(mimeType: string): ChatAttachment['kind'] {
  if (mimeType.startsWith('image/')) return 'image'
  if (mimeType.startsWith('text/')) return 'text'
  return 'file'
}

function buildAttachment(filePath: string): ChatAttachment {
  const stats = statSync(filePath)
  const isDirectory = stats.isDirectory()
  const mimeType = isDirectory ? 'inode/directory' : mimeTypeFor(filePath)
  const kind = isDirectory ? 'file' : attachmentKind(mimeType)
  const attachment: ChatAttachment = {
    id: randomUUID(),
    name: path.basename(filePath),
    path: filePath,
    mimeType,
    size: isDirectory ? 0 : stats.size,
    kind
  }

  if (!isDirectory && kind === 'image' && stats.size <= MAX_ATTACHMENT_PREVIEW_BYTES) {
    attachment.preview = `data:${mimeType};base64,${readFileSync(filePath).toString('base64')}`
  }

  if (!isDirectory && kind === 'text' && stats.size <= MAX_ATTACHMENT_TEXT_BYTES) {
    attachment.text = readFileSync(filePath, 'utf8')
  }

  return attachment
}

function buildAttachmentFromDataUrl(payload: { name: string; dataUrl: string }): ChatAttachment {
  const match = payload.dataUrl.match(/^data:([^;,]+);base64,(.+)$/)
  if (!match) throw new Error('Imagen pegada invalida.')

  const mimeType = match[1]
  if (!mimeType.startsWith('image/')) throw new Error('El portapapeles no contiene una imagen soportada.')

  const buffer = Buffer.from(match[2], 'base64')
  if (buffer.length > MAX_ATTACHMENT_PREVIEW_BYTES) {
    throw new Error('La imagen supera 20 MB.')
  }

  const ext =
    mimeType === 'image/jpeg'
      ? '.jpg'
      : mimeType === 'image/gif'
        ? '.gif'
        : mimeType === 'image/webp'
          ? '.webp'
          : '.png'
  const name = payload.name.trim() || `imagen-pegada-${Date.now()}${ext}`
  const dir = getAppDataSubdir('attachments')
  const filePath = path.join(dir, `${Date.now()}-${randomUUID()}-${path.basename(name)}`)
  writeFileSync(filePath, buffer)
  return buildAttachment(filePath)
}

function runtimeAttachmentView(attachments?: ChatAttachment[]): ChatAttachment[] | undefined {
  if (!attachments?.length) return undefined
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

function withOpenAiV1(endpoint: string): string {
  const clean = endpoint.replace(/\/+$/, '')
  if (!clean) return ''
  if (clean.endsWith('/openai/v1')) return clean
  if (clean.endsWith('/v1')) return clean
  if (clean.endsWith('/openai')) return `${clean}/v1`
  return `${clean}/openai/v1`
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

function claudeSubscriptionProvider(): ProviderProfile {
  const providerId = 'qcfg-claude-subscription'
  return {
    id: providerId,
    name: 'Claude Pro (suscripcion)',
    type: 'anthropic',
    authMode: 'subscription',
    endpoint: '',
    apiKey: '',
    enabled: true,
    models: [
      modelProfile('qcfg-claude-subscription-sonnet', providerId, 'Claude Sonnet', 'sonnet', 'claude-cli'),
      modelProfile('qcfg-claude-subscription-opus', providerId, 'Claude Opus', 'opus', 'claude-cli')
    ]
  }
}

function sanitizeSettings(input: AppSettings, preferSubscriptionFallback = false): AppSettings {
  const subscription = claudeSubscriptionProvider()
  const existingSubscription = input.providers.find(provider => provider.id === subscription.id)
  const sanitizedProviders = input.providers.map(provider => {
    const unsupportedProvider = isUnsupportedLocalProvider(provider)
    const providerModels =
      provider.type === 'foundry'
        ? mergeFoundryQAssistantModels(provider.id, provider.models)
        : provider.models
    const models = providerModels.map(model => {
      const unsupportedModel = unsupportedProvider || isUnsupportedLocalModel(model)
      return unsupportedModel
        ? {
            ...model,
            enabled: false,
            capabilities: { tools: false, reasoning: false, vision: false, web: false }
          }
        : model
    })

    return unsupportedProvider
      ? { ...provider, enabled: false, models }
      : { ...provider, models }
  })

  const providers = existingSubscription
    ? [
        sanitizedProviders.find(provider => provider.id === subscription.id)!,
        ...sanitizedProviders.filter(provider => provider.id !== subscription.id)
      ]
    : [subscription, ...sanitizedProviders]

  const activeProvider = providers.find(provider => provider.id === input.activeProviderId)
  const preferClaudeSubscription =
    preferSubscriptionFallback && (
    !activeProvider ||
    (activeProvider.type === 'anthropic' && activeProvider.authMode === 'api-key')
    )

  const activeProviderId = preferClaudeSubscription ? subscription.id : input.activeProviderId
  const activeModelId = preferClaudeSubscription
    ? (providers.find(provider => provider.id === subscription.id)?.models.find(model => model.enabled)?.id)
    : input.activeModelId

  return {
    ...input,
    providers,
    activeProviderId,
    activeModelId
  }
}

function modelProfile(
  id: string,
  providerId: string,
  displayName: string,
  model: string,
  runtime: ModelProfile['runtime'],
  web = false
): ModelProfile {
  return {
    id,
    providerId,
    displayName,
    model,
    runtime,
    enabled: true,
    capabilities: {
      tools: true,
      reasoning: true,
      vision: true,
      web
    },
    reasoningLevels: ['low', 'medium', 'high']
  }
}

function mergeFoundryQAssistantModels(providerId: string, models: ModelProfile[]): ModelProfile[] {
  const byDeployment = new Map(models.map(model => [model.model.toLowerCase(), model]))

  for (const deployment of FOUNDRY_Q_ASSISTANT_DEPLOYMENTS) {
    const key = deployment.toLowerCase()
    if (byDeployment.has(key)) continue
    byDeployment.set(key, modelProfile(
      `qcfg-foundry-${deployment.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
      providerId,
      `Foundry ${deployment}`,
      deployment,
      'foundry'
    ))
  }

  return Array.from(byDeployment.values())
}

function buildProvidersFromQConfig(parsed: unknown): {
  providers: ProviderProfile[]
  preferredProviderId?: string
  preferredModelId?: string
  summary: string[]
} {
  const root = asConfigRecord(parsed)
  const azure = asConfigRecord(root.azure)
  const llm = asConfigRecord(root.llm)
  const groq = asConfigRecord(root.groq)
  const google = asConfigRecord(root.google ?? root.gemini)

  const providers: ProviderProfile[] = []
  const summary: string[] = []

  const claudeSubscriptionId = 'qcfg-claude-subscription'
  const claudeSubscriptionModelId = 'qcfg-claude-subscription-sonnet'
  const geminiSubscriptionId = 'qcfg-gemini-subscription'
  const geminiSubscriptionModelId = 'qcfg-gemini-auto'

  providers.push({
    id: claudeSubscriptionId,
    name: 'Claude Pro (suscripcion)',
    type: 'anthropic',
    authMode: 'subscription',
    endpoint: '',
    apiKey: '',
    enabled: true,
    models: [
      modelProfile(
        claudeSubscriptionModelId,
        claudeSubscriptionId,
        'Claude Sonnet',
        'sonnet',
        'claude-cli'
      ),
      modelProfile(
        'qcfg-claude-subscription-opus',
        claudeSubscriptionId,
        'Claude Opus',
        'opus',
        'claude-cli'
      )
    ]
  })
    summary.push('Claude Pro por suscripcion habilitado como proveedor prioritario.')

  providers.push({
    id: geminiSubscriptionId,
      name: 'Gemini Advanced (suscripcion Google)',
    type: 'google',
    authMode: 'subscription',
    endpoint: '',
    apiKey: '',
    enabled: true,
    models: [
      modelProfile(
        geminiSubscriptionModelId,
        geminiSubscriptionId,
        'Gemini Auto',
        '',
        'gemini-cli',
        true
      ),
      modelProfile(
        'qcfg-gemini-25-pro',
        geminiSubscriptionId,
        'Gemini 2.5 Pro',
        'gemini-2.5-pro',
        'gemini-cli',
        true
      ),
      modelProfile(
        'qcfg-gemini-25-flash',
        geminiSubscriptionId,
        'Gemini 2.5 Flash',
        'gemini-2.5-flash',
        'gemini-cli',
        true
      )
    ]
  })
  summary.push('Gemini Advanced por suscripcion Google habilitado como respaldo.')

  const googleApiKey = cfgString(google.api_key ?? google.apiKey)
  if (googleApiKey) {
    const googleApiProviderId = 'qcfg-gemini-api'
    providers.push({
      id: googleApiProviderId,
      name: 'Gemini API key',
      type: 'google',
      authMode: 'api-key',
      endpoint: cfgString(google.endpoint),
      apiKey: googleApiKey,
      enabled: true,
      models: [
        modelProfile('qcfg-gemini-api-auto', googleApiProviderId, 'Gemini API Auto', '', 'gemini-cli', true),
        modelProfile('qcfg-gemini-api-25-pro', googleApiProviderId, 'Gemini API 2.5 Pro', 'gemini-2.5-pro', 'gemini-cli', true),
        modelProfile('qcfg-gemini-api-25-flash', googleApiProviderId, 'Gemini API 2.5 Flash', 'gemini-2.5-flash', 'gemini-cli', true)
      ]
    })
    summary.push('Gemini API importado desde q_config.')
  } else {
    const googleApiProviderId = 'qcfg-gemini-api'
    providers.push({
      id: googleApiProviderId,
      name: 'Gemini API key (pendiente)',
      type: 'google',
      authMode: 'api-key',
      endpoint: '',
      apiKey: '',
      enabled: false,
      models: [
        modelProfile('qcfg-gemini-api-25-pro', googleApiProviderId, 'Gemini API 2.5 Pro', 'gemini-2.5-pro', 'gemini-cli', true),
        modelProfile('qcfg-gemini-api-25-flash', googleApiProviderId, 'Gemini API 2.5 Flash', 'gemini-2.5-flash', 'gemini-cli', true)
      ]
    })
    summary.push('Gemini API creado como conexiÃ³n pendiente: no hay API key de Google en q_config.')
  }

  const azureEndpoint = cfgString(azure.endpoint)
  const azureApiKey = cfgString(azure.api_key ?? azure.apiKey)
  if (azureEndpoint && azureApiKey) {
    const foundryProviderId = 'qcfg-foundry'
    const foundryModels: ModelProfile[] = []

    const azureModel = cfgString(azure.model)
    const coderModel = cfgString(azure.coder_model)
    const imageModel = cfgString(azure.image_model)
    const sttModel = cfgString(azure.stt_model)
    const ttsModel = cfgString(azure.tts_model)

    if (azureModel) {
      foundryModels.push(
        modelProfile(
          'qcfg-foundry-chat',
          foundryProviderId,
          `Foundry ${azureModel}`,
          azureModel,
          'foundry'
        )
      )
    }

    if (coderModel && coderModel !== azureModel) {
      foundryModels.push(
        modelProfile(
          'qcfg-foundry-coder',
          foundryProviderId,
          `Foundry ${coderModel}`,
          coderModel,
          'foundry'
        )
      )
    }

    if (foundryModels.length === 0) {
      foundryModels.push(
        modelProfile(
          'qcfg-foundry-model',
          foundryProviderId,
          'Foundry deployment',
          '',
          'foundry'
        )
      )
    }

    providers.push({
      id: foundryProviderId,
      name: 'Microsoft Foundry / q_config',
      type: 'foundry',
      authMode: 'api-key',
      endpoint: withOpenAiV1(azureEndpoint),
      apiKey: azureApiKey,
      enabled: true,
      models: mergeFoundryQAssistantModels(foundryProviderId, foundryModels)
    })

    const extra = [imageModel, sttModel, ttsModel].filter(Boolean)
    summary.push(
      extra.length
        ? `Foundry importado y ampliado con catalogo q-assistant; referencias no-agent: ${extra.join(', ')}.`
        : 'Foundry importado y ampliado con catalogo q-assistant.'
    )
  }

  const azureClaudeEndpoint = cfgString(azure.claude_endpoint)
  const azureClaudeModel = cfgString(azure.claude_model)
  if (azureClaudeEndpoint && azureApiKey && azureClaudeModel) {
    const claudeProviderId = 'qcfg-azure-claude'
    providers.push({
      id: claudeProviderId,
      name: 'Claude API via Azure',
      type: 'anthropic',
      authMode: 'api-key',
      endpoint: azureClaudeEndpoint,
      apiKey: azureApiKey,
      enabled: false,
      models: [
        modelProfile(
          'qcfg-azure-claude-model',
          claudeProviderId,
          `Azure Claude ${azureClaudeModel}`,
          azureClaudeModel,
          'anthropic-api'
        )
      ]
    })
    summary.push('Azure Claude API detectado: se enruta directo por endpoint Anthropic-compatible.')
  }

  const groqApiKey = cfgString(groq.api_key ?? groq.apiKey)
  const groqSttModel = cfgString(groq.stt_model)
  if (groqApiKey) {
    const groqProviderId = 'qcfg-groq'
    providers.push({
      id: groqProviderId,
      name: 'Groq / q_config',
      type: 'openai-compatible',
      authMode: 'api-key',
      endpoint: 'https://api.groq.com/openai/v1',
      apiKey: groqApiKey,
      enabled: false,
      models: [
        modelProfile(
          'qcfg-groq-stt',
          groqProviderId,
          groqSttModel ? `Groq ${groqSttModel}` : 'Groq model',
          groqSttModel || '',
          'codex-api'
        )
      ]
    })
    summary.push('Groq detectado y guardado desactivado: en q_config aparece principalmente como STT.')
  }

  const localBaseUrl = cfgString(llm.base_url)
  const localModel = cfgString(llm.model)
  if (localBaseUrl || localModel) {
    const localProviderId = 'qcfg-local-ollama'
    providers.push({
      id: localProviderId,
      name: 'Local Ollama / q_config',
      type: 'openai-compatible',
      authMode: 'api-key',
      endpoint: localBaseUrl ? withOpenAiV1(localBaseUrl) : '',
      apiKey: 'ollama',
      enabled: false,
      models: [
        modelProfile(
          'qcfg-local-ollama-model',
          localProviderId,
          localModel || 'Ollama local',
          localModel,
          'codex-api'
        )
      ]
    })
    summary.push('Ollama/qwen local detectado y filtrado: queda desactivado hasta validar compatibilidad real.')
  }

  return {
    providers,
    preferredProviderId: claudeSubscriptionId,
    preferredModelId: claudeSubscriptionModelId,
    summary
  }
}

function mergeImportedProviders(
  current: AppSettings,
  imported: ProviderProfile[],
  preferredProviderId?: string,
  preferredModelId?: string
): AppSettings {
  const importedIds = new Set(imported.map(provider => provider.id))
  const providers = [
    ...current.providers.filter(provider => !importedIds.has(provider.id)),
    ...imported
  ]

  return sanitizeSettings({
    ...current,
    providers,
    activeProviderId: preferredProviderId ?? current.activeProviderId,
    activeModelId: preferredModelId ?? current.activeModelId
  })
}

function buildTree(directory: string, depth = 0, maxDepth = 8): TreeNode[] {
  if (depth > maxDepth) return []
  return readdirSync(directory, { withFileTypes: true })
    .filter(entry => !entry.isDirectory() || !ignoredDirectories.has(entry.name))
    .sort((a, b) => {
      if (a.isDirectory() && !b.isDirectory()) return -1
      if (!a.isDirectory() && b.isDirectory()) return 1
      return a.name.localeCompare(b.name)
    })
    .map(entry => {
      const fullPath = path.join(directory, entry.name)
      return entry.isDirectory()
        ? { name: entry.name, path: fullPath, type: 'directory', children: buildTree(fullPath, depth + 1, maxDepth) }
        : { name: entry.name, path: fullPath, type: 'file' }
    })
}

function wireCodex(client: CodexClient): void {
  client.on('raw', message => sendAgentEvent({ kind: 'raw', message }))
  client.on('notification', message => sendAgentEvent({ kind: 'notification', ...message }))
  client.on('serverRequest', message => sendAgentEvent({ kind: 'serverRequest', ...message }))
  client.on('log', message => sendAgentEvent({ kind: 'log', ...message }))
  client.on('exit', message => sendAgentEvent({ kind: 'exit', ...message }))
}

function wireCli(runtime: CliAgentRuntime): void {
  runtime.on('log', message => sendAgentEvent({ kind: 'log', ...message }))
}

function wireApi(runtime: ApiAgentRuntime): void {
  runtime.on('log', message => sendAgentEvent({ kind: 'log', ...message }))
  runtime.on('toolStatus', message => sendAgentEvent({
    kind: 'notification',
    method: 'item/toolCall/status',
    params: message
  }))
  runtime.on('usage', message => sendAgentEvent({
    kind: 'notification',
    method: 'item/usage/update',
    params: message
  }))
}

function buildRuntimeContext(payload: {
  text: string
  history?: ConversationMessage[]
  attachments?: ChatAttachment[]
  compactSummary?: string
  provider: ProviderProfile
  model: ModelProfile
}): RuntimeContextEnvelope {
  return {
    workspace: resolvedWorkspace(),
    providerName: payload.provider.name,
    modelName: payload.model.displayName || payload.model.model,
    compactSummary: payload.compactSummary,
    history: normalizeHistory(payload.history),
    current: { role: 'user', text: payload.text },
    attachments: payload.attachments
  }
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1600,
    height: 980,
    minWidth: 1100,
    minHeight: 700,
    backgroundColor: '#171717',
    title: `AMATISTA ${__APP_VERSION__}`,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  mainWindow.on('enter-full-screen', () => {
    sendToRenderer('window:fullscreenChanged', true)
  })

  mainWindow.on('leave-full-screen', () => {
    sendToRenderer('window:fullscreenChanged', false)
  })

  mainWindow.on('closed', () => {
    disconnectAgent()
    mainWindow = null
  })

  const rendererUrl = process.env.ELECTRON_RENDERER_URL
  if (rendererUrl) void mainWindow.loadURL(rendererUrl)
  else void mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'))
}

ipcMain.handle('window:getFullscreen', () => mainWindow?.isFullScreen() ?? false)

ipcMain.handle('window:setFullscreen', (_event, value: boolean) => {
  if (!mainWindow) return false
  mainWindow.setFullScreen(value)
  return mainWindow.isFullScreen()
})



ipcMain.handle('settings:importQConfig', async () => {
  const result = await dialog.showOpenDialog({
    title: 'Importar q_config.yaml',
    properties: ['openFile'],
    filters: [
      { name: 'YAML', extensions: ['yaml', 'yml'] },
      { name: 'Todos', extensions: ['*'] }
    ]
  })

  if (result.canceled || result.filePaths.length === 0) {
    return {
      canceled: true,
      settings,
      summary: []
    }
  }

  const filePath = result.filePaths[0]
  const raw = readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '')
  const parsed = parseYaml(raw)

  const imported = buildProvidersFromQConfig(parsed)
  settings = mergeImportedProviders(
    settings,
    imported.providers,
    imported.preferredProviderId,
    imported.preferredModelId
  )

  saveSettings(settings)

  return {
    canceled: false,
    settings,
    summary: imported.summary
  }
})

ipcMain.handle('settings:resetLocalState', () => {
  disconnectAgent()
  activeWorkspace = null

  settings = {
    providers: [],
    projectRoots: [],
    activeProviderId: undefined,
    activeModelId: undefined,
    activeProjectPath: undefined
  }

  try {
    unlinkSync(path.join(getAppDataSubdir('config'), 'settings.json'))
  } catch {
    // settings.json puede no existir
  }

  saveSettings(settings)
  return settings
})

ipcMain.handle('settings:get', () => settings)
ipcMain.handle('settings:save', (_event, nextSettings: AppSettings) => {
  settings = sanitizeSettings(nextSettings)
  saveSettings(settings)
  return { success: true }
})

ipcMain.handle('chats:load', () => loadChatSnapshot())

ipcMain.handle('chats:ensureSession', (_event, payload: {
  id: string
  title: string
  workspacePath?: string
  workspaceName?: string
  providerId?: string
  modelId?: string
  runtime?: string
}) => ensureChatSession(payload))

ipcMain.handle('chats:renameSession', (_event, payload: { chatId: string; title: string }) => {
  renameChatSession(payload.chatId, payload.title)
  return { success: true }
})

ipcMain.handle('chats:deleteSession', (_event, chatId: string) => {
  deleteChatSession(chatId)
  return { success: true }
})

ipcMain.handle('chats:saveMessage', (_event, payload: {
  id: string
  chatId: string
  role: ConversationRole
  text: string
  attachments?: ChatAttachment[]
  providerId?: string
  modelId?: string
  runtime?: string
  toolSteps?: string[]
}) => saveChatMessage(payload))

ipcMain.handle('chats:deleteMessagesFrom', (_event, payload: { chatId: string; fromMessageId: string }) => {
  deleteChatMessagesFrom(payload.chatId, payload.fromMessageId)
  return { success: true }
})

ipcMain.handle('cli:status', async () => ({
  codex: await detectCodex(),
  claude: await detectClaude(),
  gemini: await detectGemini()
}))


ipcMain.handle('cli:installGemini', async () => {
  const installResult = await execFileAsync(
    'npm',
    ['install', '-g', '@google/gemini-cli@latest'],
    {
      windowsHide: true,
      timeout: 180000,
      shell: process.platform === 'win32'
    }
  )

  return {
    success: true,
    stdout: installResult.stdout,
    stderr: installResult.stderr,
    status: await detectGemini()
  }
})

ipcMain.handle('cli:installClaude', async () => {
  const installResult = await execFileAsync(
    'npm',
    ['install', '-g', '@anthropic-ai/claude-code@latest'],
    {
      windowsHide: true,
      timeout: 180000,
      shell: process.platform === 'win32'
    }
  )

  return {
    success: true,
    stdout: installResult.stdout,
    stderr: installResult.stderr,
    status: await detectClaude()
  }
})

ipcMain.handle('auth:openCliLogin', async (_event, providerType: string) => {
  if (providerType === 'anthropic') {
    openClaudeLogin()
    return { started: true }
  }
  if (providerType === 'google') {
    openGeminiLogin()
    return { started: true }
  }
  throw new Error('Este proveedor no usa login CLI interactivo.')
})

ipcMain.handle('codex:accountRead', async () => codexAccountBridge.readAccount())
ipcMain.handle('codex:login', async () => {
  const login = await codexAccountBridge.startChatGPTLogin()
  if (login.authUrl) await shell.openExternal(login.authUrl)
  return login
})
ipcMain.handle('codex:logout', async () => {
  await codexAccountBridge.logout()
  disconnectAgent()
  return { success: true }
})
ipcMain.handle('codex:modelList', async () => codexAccountBridge.listModels())

ipcMain.handle('projects:addRoot', async () => {
  const result = await dialog.showOpenDialog({ properties: ['openDirectory'] })
  if (result.canceled || result.filePaths.length === 0) return null
  const rootPath = realpathSync(result.filePaths[0])
  const existing = settings.projectRoots.find(item => item.path === rootPath)
  if (existing) return existing

  const root = { id: randomUUID(), name: path.basename(rootPath), path: rootPath }
  settings = { ...settings, projectRoots: [...settings.projectRoots, root] }
  saveSettings(settings)
  return root
})


ipcMain.handle('projects:removeRoot', (_event, rootId: string) => {
  const root = settings.projectRoots.find(item => item.id === rootId)

  settings = {
    ...settings,
    projectRoots: settings.projectRoots.filter(item => item.id !== rootId)
  }

  if (root && activeWorkspace && activeWorkspace.startsWith(root.path)) {
    disconnectAgent()
    activeWorkspace = null
    settings = {
      ...settings,
      activeProjectPath: undefined
    }
  }

  saveSettings(settings)
  return settings
})

ipcMain.handle('projects:list', () => settings.projectRoots.flatMap(root => {
  try { return scanProjectRoot(root) } catch { return [] }
}))

ipcMain.handle('workspace:default', () => ({
  path: defaultChatWorkspace(),
  name: 'General'
}))

ipcMain.handle('workspace:open', (_event, workspacePath: string) => {
  const nextWorkspace = realpathSync(workspacePath)
  if (activeWorkspace !== nextWorkspace) disconnectAgent()
  activeWorkspace = nextWorkspace
  settings = { ...settings, activeProjectPath: nextWorkspace }
  saveSettings(settings)
  return { path: activeWorkspace, tree: buildTree(activeWorkspace) }
})

ipcMain.handle('workspace:refresh', () => buildTree(resolvedWorkspace()))
ipcMain.handle('workspace:readFile', (_event, filePath: string) => {
  const safePath = assertInsideWorkspace(filePath)
  const stats = statSync(safePath)
  if (!stats.isFile()) throw new Error('La ruta no es un archivo.')
  if (stats.size > MAX_TEXT_FILE_BYTES) throw new Error('Archivo demasiado grande.')
  return readFileSync(safePath, 'utf8')
})
ipcMain.handle('workspace:saveFile', (_event, payload: { path: string; content: string }) => {
  const safePath = assertInsideWorkspace(payload.path)
  writeFileSync(safePath, payload.content, 'utf8')
  return { success: true }
})

ipcMain.handle('attachments:pick', async () => {
  const result = await dialog.showOpenDialog({
    title: 'Agregar archivos',
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: 'Archivos', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'txt', 'md', 'csv', 'json', 'yaml', 'yml', 'pdf', '*'] }
    ]
  })

  if (result.canceled) return []

  return result.filePaths.map(buildAttachment)
})

ipcMain.handle('attachments:fromPaths', (_event, filePaths: string[]) => {
  return filePaths
    .map(filePath => {
      try { return buildAttachment(filePath) } catch { return null }
    })
    .filter(Boolean)
})

ipcMain.handle('attachments:fromDataUrl', (_event, payload: { name: string; dataUrl: string }) => {
  return buildAttachmentFromDataUrl(payload)
})

ipcMain.handle('attachments:previewImagePath', (_event, filePath: string) => {
  const normalizedPath = filePath.startsWith('file:')
    ? fileURLToPath(filePath)
    : filePath
  const stats = statSync(normalizedPath)
  const mimeType = mimeTypeFor(normalizedPath)
  if (!stats.isFile() || !mimeType.startsWith('image/')) return ''
  if (stats.size > MAX_ATTACHMENT_PREVIEW_BYTES) return ''
  return `data:${mimeType};base64,${readFileSync(normalizedPath).toString('base64')}`
})

ipcMain.handle('agent:disconnect', () => {
  disconnectAgent()
  return { success: true }
})

ipcMain.handle('agent:connect', async (_event, payload: {
  providerId: string
  modelId: string
  workspace?: string
  chatId?: string
  sandbox: SandboxMode
}) => {
  const provider = settings.providers.find(item => item.id === payload.providerId)
  if (!provider || !provider.enabled) throw new Error('Proveedor no disponible.')
  const model = provider.models.find(item => item.id === payload.modelId && item.enabled)
  if (!model) throw new Error('Modelo no disponible.')
  if (isUnsupportedLocalProvider(provider) || isUnsupportedLocalModel(model)) {
    throw new Error('Ollama/qwen2.5:7b esta desactivado: no hay compatibilidad real validada con este runtime.')
  }

  disconnectAgent()
  activeWorkspace = payload.workspace?.trim()
    ? realpathSync(payload.workspace)
    : defaultChatWorkspace()
  activeChatId = payload.chatId?.trim() || null

  if (DEBUG_TOOLS) {
    console.log(
      `[agent:connect] deployment="${model.model}" runtime=${model.runtime} ` +
      `capabilities.tools=${model.capabilities.tools} payload.workspace="${payload.workspace ?? ''}" ` +
      `activeWorkspace(resuelto)="${activeWorkspace}"`
    )
  }

  if (model.runtime === 'codex-subscription' || model.runtime === 'codex-api') {
    codexClient = new CodexClient()
    wireCodex(codexClient)
    const codexHome = getAppDataSubdir('codex-home-api')
    const thread = await codexClient.start({
      provider,
      model: model.model,
      workspace: activeWorkspace,
      codexHome,
      sandbox: payload.sandbox
    })
    activeThreadId = thread.id
    activeRuntime = 'codex'
  } else if (
    model.runtime === 'foundry' ||
    model.runtime === 'anthropic-api' ||
    (model.runtime === 'gemini-cli' && provider.authMode === 'api-key')
  ) {
    apiRuntime = new ApiAgentRuntime()
    wireApi(apiRuntime)
    const toolWorkspace = activeWorkspace
    apiRuntime.configure({
      kind:
        model.runtime === 'foundry'
          ? 'foundry'
          : model.runtime === 'anthropic-api'
            ? 'anthropic-api'
            : 'gemini-api',
      provider,
      model: model.model,
      workspace: activeWorkspace,
      sandbox: payload.sandbox,
      toolsEnabled: model.capabilities.tools,
      toolExecutor: model.capabilities.tools
        ? (name, args) => toolRegistry.execute(name, args, { workspace: toolWorkspace!, confirm: requestToolApproval })
        : undefined
    })
    activeRuntime =
      model.runtime === 'foundry'
        ? 'foundry'
        : model.runtime === 'anthropic-api'
          ? 'anthropic-api'
          : 'gemini-api'
  } else {
    const cli = model.runtime === 'claude-cli' ? await detectClaude() : await detectGemini()
    if (!cli.installed) {
      throw new Error(model.runtime === 'claude-cli'
        ? 'Claude Code CLI no estÃ¡ instalado.'
        : 'Gemini CLI no estÃ¡ instalado.')
    }

    cliRuntime = new CliAgentRuntime()
    wireCli(cliRuntime)
    cliRuntime.configure({
      kind: model.runtime === 'claude-cli' ? 'claude' : 'gemini',
      provider,
      model: model.model,
      workspace: activeWorkspace,
      sandbox: payload.sandbox
    })
    activeRuntime = model.runtime === 'claude-cli' ? 'claude' : 'gemini'
  }

  settings = {
    ...settings,
    activeProviderId: provider.id,
    activeModelId: model.id,
    activeProjectPath: payload.workspace?.trim() ? activeWorkspace : settings.activeProjectPath
  }
  saveSettings(settings)
  return {
    connected: true,
    runtime: activeRuntime,
    workspace: activeWorkspace,
    workspaceIsDefault: !payload.workspace?.trim()
  }
})

ipcMain.handle('agent:send', async (_event, payload: {
  text: string
  chatId?: string
  attachments?: ChatAttachment[]
  history?: ConversationMessage[]
  compactSummary?: string
  modelId: string
  providerId: string
  sandbox: SandboxMode
}) => {
  if (!activeRuntime) throw new Error('Agente no conectado.')
  // Se captura AHORA, antes de cualquier await: si el usuario cambia de chat
  // (o de workspace) mientras esta llamada sigue en vuelo, activeChatId /
  // activeWorkspace (variables globales del proceso main) pueden apuntar a
  // otro chat para cuando la respuesta llegue. Sin esto, sendAgentEvent()
  // etiquetaria la respuesta de ESTE turno con el chat que quedo activo
  // despues, mezclando historial entre chats.
  const requestChatId = payload.chatId?.trim() || activeChatId
  const requestWorkspace = activeWorkspace
  const provider = settings.providers.find(item => item.id === payload.providerId)
  const model = provider?.models.find(item => item.id === payload.modelId)
  if (!provider || !model) throw new Error('Modelo/proveedor no disponible.')
  const context = buildRuntimeContext({
    text: payload.text,
    history: payload.history,
    attachments: runtimeAttachmentView(payload.attachments),
    compactSummary: payload.compactSummary,
    provider,
    model
  })
  const seedContext = !activeContextSeeded && context.history.length > 0 ? context : undefined

  if (activeRuntime === 'codex') {
    if (!codexClient || !activeThreadId) throw new Error('Codex no estÃ¡ conectado.')
    await codexClient.sendTurn({
      threadId: activeThreadId,
      text: payload.text,
      model: model.model,
      workspace: resolvedWorkspace(),
      context: seedContext
    })
    activeContextSeeded = true
    return { success: true }
  }

  const runtime = activeRuntime
  if (runtime === 'foundry' || runtime === 'gemini-api' || runtime === 'anthropic-api') {
    if (!apiRuntime) throw new Error('Runtime API no disponible.')
    const abort = new AbortController()
    currentTurnAbort = abort
    try {
      const result = await apiRuntime.send(payload.text, context, abort.signal)
      activeContextSeeded = true
      const itemId = `${activeRuntime}-${Date.now()}`
      sendAgentEvent({
        chatId: requestChatId,
        workspace: requestWorkspace,
        kind: 'notification',
        method: 'item/agentMessage/delta',
        params: { itemId, delta: result.text }
      })
      sendAgentEvent({
        chatId: requestChatId,
        workspace: requestWorkspace,
        kind: 'notification',
        method: 'turn/completed',
        params: {}
      })
      return { success: true, text: result.text }
    } catch (error) {
      if (error instanceof TurnCancelledError) {
        activeContextSeeded = true
        sendAgentEvent({
          chatId: requestChatId,
          workspace: requestWorkspace,
          kind: 'notification',
          method: 'turn/cancelled',
          params: { partialText: error.partialText }
        })
        // No se relanza: cancelar es un cierre limpio, no un error del
        // agente — el renderer no debe caer en agentState='error' por esto.
        return { success: true, cancelled: true, text: error.partialText }
      }
      const detail = error instanceof Error ? error.message : String(error)
      console.error(
        '[agent:send] apiRuntime.send() fallo:',
        error instanceof Error ? (error.stack ?? detail) : detail
      )
      throw new Error(`Error al procesar la respuesta del modelo: ${detail}`)
    } finally {
      if (currentTurnAbort === abort) currentTurnAbort = null
    }
  }

  if (!cliRuntime) throw new Error('Runtime CLI no disponible.')
  const result = await cliRuntime.send(payload.text, seedContext)
  activeContextSeeded = true
  const itemId = `${activeRuntime}-${Date.now()}`
  sendAgentEvent({
    chatId: requestChatId,
    workspace: requestWorkspace,
    kind: 'notification',
    method: 'item/agentMessage/delta',
    params: { itemId, delta: result.text }
  })
  sendAgentEvent({
    chatId: requestChatId,
    workspace: requestWorkspace,
    kind: 'notification',
    method: 'turn/completed',
    params: {}
  })
  return { success: true, text: result.text }
})

ipcMain.handle('agent:cancel', () => ({ success: true, cancelled: cancelCurrentTurn() }))

ipcMain.handle('agent:reply', (_event, payload: { requestId: number | string; result: unknown }) => {
  if (!codexClient) throw new Error('Codex no estÃ¡ conectado.')
  codexClient.respondToServerRequest(payload.requestId, payload.result)
  return { success: true }
})

ipcMain.handle('agent:toolApproval:respond', (_event, payload: { id: string; approved: boolean; trust?: boolean }) => {
  const resolve = pendingToolApprovals.get(payload.id)
  if (!resolve) return { success: false }
  pendingToolApprovals.delete(payload.id)
  if (payload.approved && payload.trust) setToolTrustSession(true)
  resolve(payload.approved)
  return { success: true }
})

ipcMain.handle('agent:toolTrust:disable', () => {
  setToolTrustSession(false)
  return { success: true }
})

app.whenReady().then(() => {
  settings = sanitizeSettings(loadSettings(), true)
  saveSettings(settings)
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  disconnectAgent()
  codexAccountBridge.stop()
  if (process.platform !== 'darwin') app.quit()
})
