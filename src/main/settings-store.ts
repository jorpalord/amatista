import { safeStorage } from 'electron'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { getAppDataSubdir } from './app-paths'
import { runtimeFor } from '../shared/runtime-for'
import type {
  AppSettings,
  AuthMode,
  ModelProfile,
  ProviderProfile
} from '../shared/types'

interface StoredProvider extends Omit<ProviderProfile, 'apiKey'> {
  encryptedApiKey?: string
}

/** Feature "busqueda web" (docs/_arch/verify_web_search_design.md): mismo
 *  criterio real de StoredProvider de arriba -- `apiKey` nunca se persiste
 *  en texto plano, solo su forma cifrada. */
interface StoredIntegrations {
  tavily?: {
    encryptedApiKey?: string
  }
}

interface StoredSettings {
  providers?: StoredProvider[]
  projectRoots?: AppSettings['projectRoots']
  activeProviderId?: string
  activeModelId?: string
  activeProjectPath?: string
  turnWatchdogSeconds?: number
  maxToolLoop?: number
  compactionProviderId?: string
  compactionModelId?: string
  imageGenerationProviderId?: string
  imageGenerationModelId?: string
  integrations?: StoredIntegrations
  /** Presets simples (docs/_arch/verify_external_review_2_findings.md,
   *  Hallazgo 2): serializacion PLANA directa, sin cifrado -- a diferencia
   *  de StoredProvider/StoredIntegrations, un Preset ({id, name, personaText,
   *  providerId?, modelId?}) no tiene ninguna credencial que proteger. Se
   *  persiste tal cual (mismo criterio que projectRoots). Ausencia en un
   *  settings.json viejo = array vacio al leer (ver loadSettings), sin
   *  romper. */
  presets?: AppSettings['presets']
}

/** Fase 14: descarta cualquier valor invalido (no numerico, 0, negativo,
 *  no finito) devolviendo undefined -- nunca deja que el watchdog quede
 *  configurado para disparar casi instantaneo. Se aplica tanto al leer
 *  (settings.json pudo haber sido editado a mano con un valor raro) como
 *  al guardar (ver saveSettings), doble guardia. */
function validTurnWatchdogSeconds(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined
}

/** Mismo criterio exacto que validTurnWatchdogSeconds() de arriba, aplicado
 *  a maxToolLoop -- ademas exige entero (es un conteo de iteraciones real,
 *  no una duracion). undefined/0/negativo/fraccionario/no numerico = usar
 *  el default (MAX_TOOL_LOOP, api-agent-runtime.ts). */
function validMaxToolLoop(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined
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

/** Id fijo del builtin real de sanitizeSettings()/claudeSubscriptionProvider()
 *  (settings-provisioning.ts) -- MISMO string literal, duplicado a proposito
 *  (settings-store.ts/settings-provisioning.ts no comparten un modulo de
 *  constantes hoy). */
const CLAUDE_SUBSCRIPTION_BUILTIN_ID = 'qcfg-claude-subscription'
/** MISMO string literal que el marcador viejo de la limpieza de claude-cli
 *  (retirado junto con migrateClaudeSubscriptionProviders(), ya no existe
 *  como export). Se conserva SOLO como texto a detectar/limpiar aca -- ver
 *  comentario de unmigrateClaudeSubscriptionBuiltin() abajo. */
const CLAUDE_CLI_REMOVED_MARKER = ' — ya no soportado (claude-cli retirado)'

/**
 * Reintegracion de claude-cli, hallazgo real de la propia verificacion en
 * vivo (no anticipado en el diseno): una instalacion real que ya paso por
 * el retiro (dec378c) y sus builds posteriores tiene el builtin
 * `qcfg-claude-subscription` en disco DESHABILITADO y con el marcador viejo
 * en el nombre (`migrateClaudeSubscriptionProviders()`, ya retirada, lo dejo
 * asi en cada carga durante ese periodo). sanitizeSettings() restaurado
 * (settings-provisioning.ts) reordena ese builtin al frente si ya existe,
 * pero NO le toca name/enabled -- mismo comportamiento pre-dec378c, correcto
 * para no pisar una decision real del usuario (deshabilitarlo a mano) pero
 * incorrecto aca, porque el estado en disco no es una decision del usuario:
 * lo dejo el propio mecanismo de retiro. "Un-migracion" simetrica, acotada
 * SOLO al id builtin fijo (nunca a las conexiones con id aleatorio que el
 * usuario haya creado a mano clickeando "Claude Pro" antes del retiro -- esas
 * quedan deshabilitadas+marcadas tal cual, el usuario decide reactivarlas
 * una por una desde la UI ya restaurada si las quiere de vuelta).
 */
function unmigrateClaudeSubscriptionBuiltin(provider: StoredProvider): StoredProvider {
  if (provider.id !== CLAUDE_SUBSCRIPTION_BUILTIN_ID) return provider
  if (!provider.name.includes(CLAUDE_CLI_REMOVED_MARKER)) return provider
  return {
    ...provider,
    enabled: true,
    name: provider.name.replace(CLAUDE_CLI_REMOVED_MARKER, '')
  }
}

function migrateProvider(rawProvider: StoredProvider): ProviderProfile {
  const provider = unmigrateClaudeSubscriptionBuiltin(
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
  const runtime = runtimeFor(base.type, base.authMode)
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
    maxToolLoop: validMaxToolLoop(stored.maxToolLoop),
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
    compactionModelId: stored.compactionModelId,
    // Feature "generacion de imagenes": mismos 2 campos, mismo string
    // simple sin guard de validez -- resolveConfiguredImageGenerationModel()
    // (image-generation.ts) ya descarta con find() cualquier id que no
    // matchee un provider/model real, igual que hace su equivalente de
    // compactacion. Agregados aca desde el dia 1 (a diferencia de
    // compactionProviderId/compactionModelId, que se perdian en cada
    // reinicio hasta el fix de Fase 14) -- ver ese fix en CONTRACT.md antes
    // de tocar este archivo para cualquier campo nuevo similar.
    imageGenerationProviderId: stored.imageGenerationProviderId,
    imageGenerationModelId: stored.imageGenerationModelId,
    // Feature "busqueda web" (docs/_arch/verify_web_search_design.md):
    // mismo mecanismo real de cifrado que provider.apiKey (encryptSecret/
    // decryptSecret), aplicado a una credencial que NO es de un provider de
    // modelo -- Tavily no tiene ningun LLM, no encaja en providers[].
    integrations: stored.integrations?.tavily?.encryptedApiKey
      ? { tavily: { apiKey: decryptSecret(stored.integrations.tavily.encryptedApiKey) } }
      : undefined,
    // Presets simples (docs/_arch/verify_external_review_2_findings.md,
    // Hallazgo 2): default a [] si el archivo es viejo y no tiene el campo --
    // mismo criterio de compatibilidad hacia atras que projectRoots (:180).
    // Serializacion plana, sin descifrado (un Preset no tiene secretos).
    presets: stored.presets ?? []
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
    maxToolLoop: validMaxToolLoop(settings.maxToolLoop),
    compactionProviderId: settings.compactionProviderId,
    compactionModelId: settings.compactionModelId,
    imageGenerationProviderId: settings.imageGenerationProviderId,
    imageGenerationModelId: settings.imageGenerationModelId,
    integrations: settings.integrations?.tavily?.apiKey?.trim()
      ? { tavily: { encryptedApiKey: encryptSecret(settings.integrations.tavily.apiKey) } }
      : undefined,
    // Presets simples (docs/_arch/verify_external_review_2_findings.md,
    // Hallazgo 2): serializacion plana directa -- sin cifrado (un Preset no
    // tiene credenciales), sin transformacion (mismo criterio que
    // projectRoots). Siempre se escribe un array (?? []) para que el archivo
    // quede consistente con el default de lectura.
    presets: settings.presets ?? []
  }

  writeFileSync(settingsPath(), JSON.stringify(stored, null, 2), 'utf8')
}
