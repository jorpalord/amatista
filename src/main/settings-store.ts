import { safeStorage } from 'electron'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { getAppDataSubdir } from './app-paths'
import { CLAUDE_CLI_REMOVED_MARKER } from './settings-provisioning'
import type {
  AppSettings,
  AuthMode,
  ModelProfile,
  ProviderProfile,
  RuntimeKind
} from '../shared/types'

interface StoredProvider extends Omit<ProviderProfile, 'apiKey'> {
  encryptedApiKey?: string
}

interface StoredSettings {
  providers?: StoredProvider[]
  projectRoots?: AppSettings['projectRoots']
  activeProviderId?: string
  activeModelId?: string
  activeProjectPath?: string
  turnWatchdogSeconds?: number
  compactionProviderId?: string
  compactionModelId?: string
}

/** Fase 14: descarta cualquier valor invalido (no numerico, 0, negativo,
 *  no finito) devolviendo undefined -- nunca deja que el watchdog quede
 *  configurado para disparar casi instantaneo. Se aplica tanto al leer
 *  (settings.json pudo haber sido editado a mano con un valor raro) como
 *  al guardar (ver saveSettings), doble guardia. */
function validTurnWatchdogSeconds(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined
}

function settingsPath(): string {
  return path.join(getAppDataSubdir('config'), 'settings.json')
}

function encryptSecret(value?: string): string | undefined {
  if (!value) return undefined
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('El cifrado local de Electron no está disponible.')
  }
  return safeStorage.encryptString(value).toString('base64')
}

function decryptSecret(value?: string): string | undefined {
  if (!value || !safeStorage.isEncryptionAvailable()) return undefined
  try {
    return safeStorage.decryptString(Buffer.from(value, 'base64'))
  } catch {
    return undefined
  }
}

function runtimeFor(provider: Pick<ProviderProfile, 'type' | 'authMode'>): RuntimeKind {
  if (provider.type === 'openai-codex' && provider.authMode === 'subscription') {
    return 'codex-subscription'
  }
  if (provider.type === 'foundry') return 'foundry'
  if (provider.type === 'openai' || provider.type === 'openai-compatible') return 'codex-api'
  // Limpieza de claude-cli: 'anthropic' ya no se ramifica por authMode --
  // 'anthropic-api' es el UNICO runtime real que le queda al type
  // 'anthropic' (subscription se deshabilita en migrateProvider() antes de
  // llegar aca, ver mas abajo; el runtime que le quede asignado a esos
  // modelos deshabilitados es irrelevante en la practica, pero tiene que
  // ser un RuntimeKind valido igual).
  if (provider.type === 'anthropic') return 'anthropic-api'
  return 'gemini-cli'
}

/** Endpoint fijo que pone newDeepSeekProvider() (App.tsx) — unico dato
 *  estable para identificar una conexion DeepSeek preexistente, ver
 *  backfillDeepSeekAllowSubscription() mas abajo. */
const DEEPSEEK_ENDPOINT = 'https://api.deepseek.com/anthropic'

/**
 * Migracion liviana (backfill): una conexion DeepSeek creada ANTES de que
 * newDeepSeekProvider() empezara a setear allowSubscription: false queda
 * sin el campo en settings.json — el selector de Autenticacion la seguia
 * ofreciendo "Suscripcion" (el bug real que origino este fix). Se
 * identifica SOLO por endpoint + type, sin importar authMode actual: el
 * caso real reportado es justo una conexion que el usuario ya habia
 * cambiado a authMode:'subscription' para reproducir el bug — exigir
 * authMode==='api-key' en el match (criterio descartado antes de
 * implementar) hubiera dejado ese caso especifico sin migrar.
 *
 * Sin write innecesario: si no matchea, o ya tiene allowSubscription
 * === false (ya migrada antes, o creada despues de este fix), devuelve
 * el mismo objeto tal cual, no crea uno nuevo.
 */
function backfillDeepSeekAllowSubscription(provider: StoredProvider): StoredProvider {
  const isDeepSeekConnection = provider.type === 'anthropic' && provider.endpoint === DEEPSEEK_ENDPOINT
  if (!isDeepSeekConnection || provider.allowSubscription === false) return provider
  return { ...provider, allowSubscription: false }
}

/**
 * Limpieza de claude-cli, Tarea 6: mismo patron exacto que
 * backfillDeepSeekAllowSubscription() de arriba, aplicado al edge case
 * real que la investigacion previa encontro (no inventado): una conexion
 * Claude API key/Azure creada ANTES de que newProvider() (Fase 21,
 * App.tsx) empezara a setear allowSubscription:false para
 * type:'anthropic'+authMode:'api-key' puede no tener el campo en
 * settings.json — el selector de Autenticacion la seguiria ofreciendo
 * "Suscripcion", justo el runtime que ya no existe. Sin write innecesario
 * si ya esta seteado.
 */
function backfillAnthropicApiKeyAllowSubscription(provider: StoredProvider): StoredProvider {
  const isAnthropicApiKey = provider.type === 'anthropic' && provider.authMode === 'api-key'
  if (!isAnthropicApiKey || provider.allowSubscription === false) return provider
  return { ...provider, allowSubscription: false }
}

/**
 * Limpieza de claude-cli: reemplaza la asignacion vieja de
 * runtime:'claude-cli' -- cualquier conexion type:'anthropic'+
 * authMode:'subscription' que llegue de disco se deshabilita automatica
 * (no se borra, el usuario puede reactivarla a mano despues) y se le
 * agrega el marcador al nombre, MISMA logica e idempotencia exactas que
 * migrateClaudeSubscriptionProviders() (settings-provisioning.ts).
 * Doble capa a proposito, no redundancia por descuido: esta corre en
 * CADA carga desde disco (loadSettings()); sanitizeSettings() corre
 * ademas en settings:save, un camino que loadSettings() no cubre. El
 * marcador es el mismo en los dos lados, asi que aplicar los dos nunca
 * duplica el sufijo ni reactiva algo que el usuario ya reactivo a mano.
 */
function migrateClaudeSubscriptionProvider(provider: StoredProvider): StoredProvider {
  if (provider.type !== 'anthropic' || provider.authMode !== 'subscription') return provider
  if (provider.name.includes(CLAUDE_CLI_REMOVED_MARKER)) return provider
  return { ...provider, enabled: false, name: `${provider.name}${CLAUDE_CLI_REMOVED_MARKER}` }
}

function migrateProvider(rawProvider: StoredProvider): ProviderProfile {
  const provider = migrateClaudeSubscriptionProvider(
    backfillAnthropicApiKeyAllowSubscription(
      backfillDeepSeekAllowSubscription(rawProvider)
    )
  )
  const authMode: AuthMode = provider.authMode === 'subscription' ? 'subscription' : 'api-key'
  const base = {
    ...provider,
    authMode,
    apiKey: decryptSecret(provider.encryptedApiKey)
  }
  const runtime = runtimeFor(base)
  return {
    ...base,
    models: (provider.models ?? []).map((model): ModelProfile => ({
      ...model,
      runtime
    }))
  }
}

export function loadSettings(): AppSettings {
  const file = settingsPath()
  if (!existsSync(file)) return { providers: [], projectRoots: [] }

  const stored = JSON.parse(readFileSync(file, 'utf8')) as StoredSettings
  return {
    providers: (stored.providers ?? []).map(migrateProvider),
    projectRoots: stored.projectRoots ?? [],
    activeProviderId: stored.activeProviderId,
    activeModelId: stored.activeModelId,
    activeProjectPath: stored.activeProjectPath,
    turnWatchdogSeconds: validTurnWatchdogSeconds(stored.turnWatchdogSeconds),
    // Bug real confirmado (docs/_arch/verify_compaction_settings.md): estos
    // dos campos existian en AppSettings desde Fase 3 pero nunca se habian
    // agregado aca — se perdian en cada reinicio de la app (dentro de la
    // misma sesion andaban bien: sanitizeSettings() los preserva via
    // spread, el bug era solo en el roundtrip a disco). Strings simples,
    // sin guard de validez equivalente al de turnWatchdogSeconds —
    // resolveConfiguredCompactionModel() (compaction-engine.ts) ya
    // descarta con find() cualquier id que no matchee un provider/model
    // real, sin necesitar que este archivo prevalide nada.
    compactionProviderId: stored.compactionProviderId,
    compactionModelId: stored.compactionModelId
  }
}

export function saveSettings(settings: AppSettings): void {
  const stored: StoredSettings = {
    providers: settings.providers.map(provider => {
      const { apiKey, ...rest } = provider
      return {
        ...rest,
        encryptedApiKey: encryptSecret(apiKey)
      }
    }),
    projectRoots: settings.projectRoots,
    activeProviderId: settings.activeProviderId,
    activeModelId: settings.activeModelId,
    activeProjectPath: settings.activeProjectPath,
    turnWatchdogSeconds: validTurnWatchdogSeconds(settings.turnWatchdogSeconds),
    compactionProviderId: settings.compactionProviderId,
    compactionModelId: settings.compactionModelId
  }

  writeFileSync(settingsPath(), JSON.stringify(stored, null, 2), 'utf8')
}
