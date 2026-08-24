import { safeStorage } from 'electron'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { getAppDataSubdir } from './app-paths'
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
  if (provider.type === 'anthropic') return provider.authMode === 'api-key' ? 'anthropic-api' : 'claude-cli'
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

function migrateProvider(rawProvider: StoredProvider): ProviderProfile {
  const provider = backfillDeepSeekAllowSubscription(rawProvider)
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
    activeProjectPath: stored.activeProjectPath
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
    activeProjectPath: settings.activeProjectPath
  }

  writeFileSync(settingsPath(), JSON.stringify(stored, null, 2), 'utf8')
}
