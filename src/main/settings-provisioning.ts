// Construccion y saneamiento de AppSettings: proveedor Claude por suscripcion
// siempre presente (reintegracion de claude-cli), filtrado de proveedores/
// modelos locales no soportados (Ollama).
//
// Retiro real del flujo de importacion de q_config.yaml (usuario, en vivo:
// "eliminá el flujo de q_config.yaml por completo") -- legado de una
// migracion puntual desde un asistente Q anterior, ya sin uso real: el
// boton que lo disparaba en la UI ya ni siquiera estaba cableado a ningun
// onClick (codigo muerto, confirmado con grep antes de tocar nada), y
// causaba un bug real (docs/_arch/CONTRACT.md): sanitizeSettings() le
// inyectaba 12 deployments de Foundry hardcodeados
// (FOUNDRY_Q_ASSISTANT_DEPLOYMENTS) a CUALQUIER conexion Foundry, no solo
// a la de q_config -- el usuario los veia como reales en su propio recurso
// de Azure y le tiraban 404 al intentar usarlos. buildProvidersFromQConfig()/
// mergeImportedProviders()/mergeFoundryQAssistantModels()/
// FOUNDRY_Q_ASSISTANT_DEPLOYMENTS/withOpenAiV1()/asConfigRecord()/
// cfgString() salieron enteros de este archivo; el handler IPC
// 'settings:importQConfig' (ipc-settings.ts) y el binding de preload
// tambien se retiraron.
import type { AppSettings, ModelProfile, ProviderProfile } from '../shared/types'

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
    // Fix real (bug reportado por el usuario en vivo, ya resuelto de raiz
    // con el retiro completo del flujo de q_config.yaml, ver el comentario
    // de cabecera de este archivo): esto llegaba a inyectar 12 deployments
    // de Foundry hardcodeados en CUALQUIER conexion type:'foundry', no
    // solo en la de q_config -- confirmado real con un 404 del usuario al
    // intentar usar uno que no existia en su propio recurso de Azure. Sin
    // ningun mecanismo de q_config que necesite ese catalogo, esto vuelve
    // a ser una identidad simple -- provider.models tal cual el usuario lo
    // configuro, sin ninguna inyeccion.
    const models = provider.models.map(model => {
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

