// Construccion y saneamiento de AppSettings: filtrado de proveedores/modelos
// locales no soportados (Ollama), migracion de conexiones Claude por
// suscripcion (claude-cli retirado, ver mas abajo), e importacion de
// proveedores desde un q_config.yaml legado.
import type { AppSettings, ModelProfile, ProviderProfile } from '../shared/types'

/** Limpieza de claude-cli: marcador que identifica una conexion
 *  type:'anthropic'+authMode:'subscription' ya migrada por
 *  migrateClaudeSubscriptionProviders() -- una vez que el nombre lo tiene,
 *  la migracion no la vuelve a tocar NUNCA MAS, ni siquiera si el usuario
 *  la reactiva a mano despues (enabled pasa a ser 100% decision del
 *  usuario a partir de ahi). Duplicado como string literal en App.tsx
 *  (mismo patron ya establecido para DEEPSEEK_ANTHROPIC_ENDPOINT/
 *  DEEPSEEK_ENDPOINT -- main y renderer no comparten modulos en este
 *  setup Electron+Vite) -- si se edita aca, editar tambien alla. */
export const CLAUDE_CLI_REMOVED_MARKER = ' — ya no soportado (claude-cli retirado)'

/** Reemplaza el mecanismo viejo de re-siembra incondicional
 *  (claudeSubscriptionProvider(), eliminada en esta limpieza junto con
 *  claude-cli como runtime real): ya no existe ningun runtime que sirva
 *  type:'anthropic'+authMode:'subscription'. En vez de recrear un
 *  provider builtin en cada carga, esto DESHABILITA automaticamente
 *  cualquier conexion existente que matchee ese shape (no solo la builtin
 *  vieja -- cualquiera, incluida una que el usuario haya armado a mano) --
 *  no la borra, el usuario puede reactivarla manualmente si algun dia
 *  vuelve a hacer falta (aunque sin runtime real detras, no va a
 *  funcionar). Idempotente via el marcador en el nombre. */
function migrateClaudeSubscriptionProviders(providers: ProviderProfile[]): ProviderProfile[] {
  return providers.map(provider => {
    if (provider.type !== 'anthropic' || provider.authMode !== 'subscription') return provider
    if (provider.name.includes(CLAUDE_CLI_REMOVED_MARKER)) return provider
    return { ...provider, enabled: false, name: `${provider.name}${CLAUDE_CLI_REMOVED_MARKER}` }
  })
}

export const FOUNDRY_Q_ASSISTANT_DEPLOYMENTS = [
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

function asConfigRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null
    ? value as Record<string, unknown>
    : {}
}

function cfgString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

export function withOpenAiV1(endpoint: string): string {
  const clean = endpoint.replace(/\/+$/, '')
  if (!clean) return ''
  if (clean.endsWith('/openai/v1')) return clean
  if (clean.endsWith('/v1')) return clean
  if (clean.endsWith('/openai')) return `${clean}/v1`
  return `${clean}/openai/v1`
}

export function isUnsupportedLocalProvider(provider: ProviderProfile): boolean {
  const endpoint = (provider.endpoint ?? '').toLowerCase()
  const name = provider.name.toLowerCase()
  return endpoint.includes('localhost') ||
    endpoint.includes('127.0.0.1') ||
    endpoint.includes('ollama') ||
    name.includes('ollama')
}

export function isUnsupportedLocalModel(model: ModelProfile): boolean {
  const value = `${model.displayName} ${model.model}`.toLowerCase()
  return value.includes('qwen2.5:7b') || value.includes('ollama')
}

export function sanitizeSettings(input: AppSettings): AppSettings {
  const migratedProviders = migrateClaudeSubscriptionProviders(input.providers)
  const providers = migratedProviders.map(provider => {
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

  // Fase limpieza de claude-cli: el fallback viejo "si no hay proveedor
  // activo, o el activo es Claude API-key, preferir Claude por
  // suscripcion" ya no aplica -- ese destino ya no funciona. Se elimina
  // sin reemplazo: activeProviderId/activeModelId pasan tal cual llegaron
  // (via ...input mas abajo); pickProvider()/pickModel() del lado
  // renderer (App.tsx) ya tienen su propio fallback real ("el activo si
  // esta habilitado, si no cualquiera habilitado") que cubre el caso de
  // que el proveedor que quedo activo se haya deshabilitado recien --
  // confirmado leyendo ese codigo antes de sacar este bloque, no asumido.
  return { ...input, providers }
}

export function modelProfile(
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

export function mergeFoundryQAssistantModels(providerId: string, models: ModelProfile[]): ModelProfile[] {
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

export function buildProvidersFromQConfig(parsed: unknown): {
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

  // Limpieza de claude-cli: este import ya NO siembra un provider Claude
  // Pro por suscripcion (antes incondicional, sin ningun gate) -- claude-cli
  // ya no es un runtime real. Si el q_config.yaml importado tiene datos de
  // Claude via Azure, esos SI se siguen importando mas abajo (rama
  // azureClaudeEndpoint/azureClaudeModel) porque usan runtime:'anthropic-api'
  // (HTTP directo), no claude-cli -- sin tocar.
  const geminiSubscriptionId = 'qcfg-gemini-subscription'
  const geminiSubscriptionModelId = 'qcfg-gemini-auto'

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
    summary.push('Gemini API creado como conexion pendiente: no hay API key de Google en q_config.')
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

  // Limpieza de claude-cli: ya no hay un "preferido" fijo que apuntar acá
  // (antes siempre era Claude Pro) -- sin preferredProviderId/
  // preferredModelId, mergeImportedProviders() (mas abajo en este archivo)
  // cae a `current.activeProviderId` tal cual estaba antes del import, no
  // se cambia de proveedor activo solo por importar q_config.yaml.
  return {
    providers,
    summary
  }
}

export function mergeImportedProviders(
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
