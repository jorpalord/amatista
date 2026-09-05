// Construccion y saneamiento de AppSettings: proveedor Claude por suscripcion
// siempre presente (reintegracion de claude-cli), filtrado de proveedores/
// modelos locales no soportados (Ollama), e importacion de proveedores
// desde un q_config.yaml legado.
import type { AppSettings, ModelProfile, ProviderProfile } from '../shared/types'

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

/**
 * Reintegracion de claude-cli: unico proveedor real que NO depende de que
 * el usuario haya cargado nada -- Claude Code CLI se autentica por sesion
 * de suscripcion (`claude` en una terminal), no por API key guardada en
 * settings.json. Restaurado casi literal (pre-dec378c): mismos 2 modelos
 * fijos (sonnet/opus), mismo id builtin `qcfg-claude-subscription`.
 */
export function claudeSubscriptionProvider(): ProviderProfile {
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

/**
 * Integracion de Antigravity CLI: mismo patron exacto que
 * claudeSubscriptionProvider() de arriba -- builtin real, id fijo, se
 * autentica por sesion (keyring del SO real, no API key guardada). Decision
 * confirmada por el usuario de sembrarlo automatico igual que Claude (ver
 * docs/_arch/PENDING.md, "Tarea 6" quedo abierta y se resolvio a favor de
 * sembrar en esta misma fase). 3 modelos reales confirmados con
 * `agy models` (docs/_arch/verify_antigravity_integration.md) -- "Auto"
 * (model:'', mismo mecanismo que "Gemini Auto"/Claude sin --model: agy usa
 * su propio default) + 2 ids reales, no inventados.
 */
export function antigravitySubscriptionProvider(): ProviderProfile {
  const providerId = 'qcfg-antigravity-subscription'
  return {
    id: providerId,
    name: 'Antigravity (suscripcion Google)',
    type: 'antigravity',
    authMode: 'subscription',
    endpoint: '',
    apiKey: '',
    enabled: true,
    models: [
      modelProfile('qcfg-antigravity-auto', providerId, 'Antigravity Auto', '', 'antigravity-cli'),
      modelProfile('qcfg-antigravity-3-1-pro-high', providerId, 'Gemini 3.1 Pro (High)', 'gemini-3.1-pro-high', 'antigravity-cli'),
      modelProfile('qcfg-antigravity-3-7-flash-high', providerId, 'Gemini 3.7 Flash (High)', 'gemini-3.7-flash-high', 'antigravity-cli')
    ]
  }
}

/**
 * `preferSubscriptionFallback` (default false, restaurado pre-dec378c):
 * SOLO true al arrancar la app (index.ts) -- si el proveedor activo no
 * existe o es Claude API-key, se prefiere Claude Pro por suscripcion como
 * sugerencia de arranque. settings:save (ipc-settings.ts) llama esto sin
 * el flag: un guardado normal nunca debe forzar el cambio de proveedor
 * activo por su cuenta.
 *
 * Re-siembra INCONDICIONAL de claudeSubscriptionProvider() -- decision ya
 * confirmada con el usuario al reintegrar: si la conexion builtin no esta
 * en `input.providers` (el usuario la borro, o es una instalacion fresca),
 * se vuelve a agregar sola en cada carga/guardado. `toggleProvider()`
 * (enabled:false) sigue siendo la forma real de "apagarla" sin que
 * reaparezca -- eliminarla vuelve a traerla, a proposito, mismo
 * comportamiento exacto que tenia antes del retiro.
 */
/**
 * Re-siembra incondicional de un builtin de suscripcion (Claude, y ahora
 * Antigravity) -- si no esta en `list`, se agrega adelante de todo; si ya
 * esta, se reordena adelante preservando el resto tal cual. Factorizada de
 * la logica que ya tenia Claude para no duplicarla al sumar Antigravity con
 * la misma decision (siembra automatica confirmada por el usuario). Aplicar
 * esto 2 veces en orden (antigravity primero, claude despues) deja el orden
 * final [claude, antigravity, ...resto] -- claude siempre gana el frente,
 * mismo lugar que ya ocupaba antes de esta fase.
 */
function reseedBuiltinSubscription(list: ProviderProfile[], builtin: ProviderProfile): ProviderProfile[] {
  const existing = list.find(provider => provider.id === builtin.id)
  return existing
    ? [list.find(provider => provider.id === builtin.id)!, ...list.filter(provider => provider.id !== builtin.id)]
    : [builtin, ...list]
}

export function sanitizeSettings(input: AppSettings, preferSubscriptionFallback = false): AppSettings {
  const subscription = claudeSubscriptionProvider()
  const antigravitySubscription = antigravitySubscriptionProvider()
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

  const providers = reseedBuiltinSubscription(
    reseedBuiltinSubscription(sanitizedProviders, antigravitySubscription),
    subscription
  )

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

  // Reintegracion de claude-cli: este import vuelve a sembrar un provider
  // Claude Pro por suscripcion, incondicional, restaurado pre-dec378c --
  // mismo id/modelos que claudeSubscriptionProvider() de arriba (misma
  // funcion, no duplicada, ver mas abajo). Si el q_config.yaml importado
  // tiene datos de Claude via Azure, esos se importan APARTE mas abajo
  // (rama azureClaudeEndpoint/azureClaudeModel) porque usan
  // runtime:'anthropic-api' (HTTP directo), no claude-cli.
  const claudeSubscriptionId = 'qcfg-claude-subscription'
  const claudeSubscriptionModelId = 'qcfg-claude-subscription-sonnet'

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

  // Integracion de Antigravity CLI: sembrado incondicional, decision
  // confirmada por el usuario. No es "preferido" (preferredProviderId sigue
  // siendo Claude, sin cambios) -- solo se agrega a la lista real.
  providers.push(antigravitySubscriptionProvider())
  summary.push('Antigravity (suscripcion Google) habilitado.')

  // Retiro de gemini-cli (docs/_arch/verify_gemini_cli_removal_scope.md,
  // verify_gemini_cli_removal.md): el builtin "Gemini Advanced (suscripcion
  // Google)" que vivia aca (type:'google', authMode:'subscription',
  // runtime:'gemini-cli') se retiro entero -- gemini-cli standalone quedo
  // discontinuado para cuentas individuales (IneligibleTierError real,
  // confirmado, Google redirige a Antigravity, que ya cubre el mismo
  // terreno). El camino HTTP api-key sigue mas abajo, sin tocar.

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
        modelProfile('qcfg-gemini-api-auto', googleApiProviderId, 'Gemini API Auto', '', 'gemini-api', true),
        modelProfile('qcfg-gemini-api-25-pro', googleApiProviderId, 'Gemini API 2.5 Pro', 'gemini-2.5-pro', 'gemini-api', true),
        modelProfile('qcfg-gemini-api-25-flash', googleApiProviderId, 'Gemini API 2.5 Flash', 'gemini-2.5-flash', 'gemini-api', true)
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
        modelProfile('qcfg-gemini-api-25-pro', googleApiProviderId, 'Gemini API 2.5 Pro', 'gemini-2.5-pro', 'gemini-api', true),
        modelProfile('qcfg-gemini-api-25-flash', googleApiProviderId, 'Gemini API 2.5 Flash', 'gemini-2.5-flash', 'gemini-api', true)
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
        // Fix real (docs/_arch/verify_compatible_migration_scope.md):
        // literal actualizado de 'codex-api' a 'openai-chat', mismo runtime
        // real que ahora resuelve runtimeFor() para type:'openai-compatible'
        // -- se autocorregia igual en el proximo loadSettings() (migrateProvider()
        // recalcula esto siempre), pero es mas prolijo no sembrar un valor
        // que ya se sabe viejo.
        modelProfile(
          'qcfg-groq-stt',
          groqProviderId,
          groqSttModel ? `Groq ${groqSttModel}` : 'Groq model',
          groqSttModel || '',
          'openai-chat'
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
        // Fix real (docs/_arch/verify_compatible_migration_scope.md): mismo
        // motivo que el bloque de Groq de arriba.
        modelProfile(
          'qcfg-local-ollama-model',
          localProviderId,
          localModel || 'Ollama local',
          localModel,
          'openai-chat'
        )
      ]
    })
    summary.push('Ollama/qwen local detectado y filtrado: queda desactivado hasta validar compatibilidad real.')
  }

  // Reintegracion de claude-cli: preferredProviderId/preferredModelId
  // vuelven a apuntar a Claude Pro (restaurado pre-dec378c) --
  // mergeImportedProviders() los usa como el proveedor activo sugerido
  // tras importar q_config.yaml.
  return {
    providers,
    preferredProviderId: claudeSubscriptionId,
    preferredModelId: claudeSubscriptionModelId,
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
