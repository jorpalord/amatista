import type { AuthMode, ProviderType, RuntimeKind } from './types'

/**
 * Traduce (type, authMode) de una conexion al RuntimeKind real que le
 * corresponde -- unica declaracion, importada por main (settings-store.ts,
 * dentro de migrateProvider()/loadSettings(), corre en CADA arranque) y por
 * el renderer (App.tsx, newProvider()/al crear o editar una conexion).
 *
 * Fix real (docs/_arch/verify_runtime_for_openrouter_fix.md): antes de este
 * fix vivian 2 copias casi identicas -- settings-store.ts (main) y App.tsx
 * (renderer) -- que ya habian divergido una vez sin que nadie lo notara: la
 * copia del renderer tenia el caso explicito de 'openrouter' (Fase 15), la
 * de main NO, asi que una conexion OpenRouter nacia bien (runtime:'openai-
 * chat', asignado por el renderer al crearla) pero se corrompia sola al
 * primer reinicio real de la app (runtime:'gemini-api', el fallback de la
 * copia de main, reescrito a disco por el propio arranque). Confirmado real
 * con la app corriendo + reinicio real + polling del settings.json.
 *
 * Unificar en shared/ (mismo patron ya establecido por
 * shared/model-capabilities.ts -> isApiCapableModel(), tambien importada
 * por main Y renderer) elimina la CLASE de bug -- una sola declaracion no
 * puede divergir de si misma -- en vez de solo agregar el caso que faltaba
 * en una de las 2 copias.
 */
export function runtimeFor(type: ProviderType, authMode: AuthMode): RuntimeKind {
  if (type === 'openai-codex' && authMode === 'subscription') return 'codex-subscription'
  if (type === 'foundry') return 'foundry'
  // Fix real (docs/_arch/verify_compatible_migration_scope.md,
  // verify_compatible_button_fix_options.md): antes 'codex-api' (spawnea
  // codex app-server, que confirmado real NUNCA lee provider.endpoint --
  // el botón "Compatible" ignoraba en silencio cualquier endpoint custom
  // que el usuario cargara). Migrado a 'openai-chat' (HTTP directo real,
  // Fase 15) -- confirmado que codex-cli tampoco es alternativa real para
  // esto (model_providers de codex-cli solo habla Responses API, nunca
  // Chat Completions, probado en vivo). Conexiones YA EXISTENTES con
  // runtime:'codex-api' guardado se autocorrigen solas en el proximo
  // loadSettings() (migrateProvider() recalcula el runtime de cada modelo
  // en cada arranque, mismo mecanismo que ya resolvio el Hallazgo 2 de
  // OpenRouter).
  if (type === 'openai' || type === 'openai-compatible') return 'openai-chat'
  // Reintegracion de claude-cli: 'anthropic' vuelve a ramificarse por
  // authMode -- 'api-key' es HTTP directo (anthropic-api), 'subscription'
  // spawnea Claude Code CLI real (claude-cli).
  if (type === 'anthropic') return authMode === 'api-key' ? 'anthropic-api' : 'claude-cli'
  // Integracion de Antigravity CLI: siempre 'antigravity-cli' sin ramificar
  // por authMode -- suscripcion y API key spawnean el mismo binario `agy`,
  // la diferencia real vive en buildEnv() (cli-agent-runtime.ts), no en el
  // runtime elegido.
  if (type === 'antigravity') return 'antigravity-cli'
  // Fase 15: OpenRouter (o cualquier backend Chat-Completions-compatible)
  // — siempre api-key, nunca hay concepto de suscripcion/CLI para esto.
  if (type === 'openrouter') return 'openai-chat'
  // Retiro de gemini-cli (docs/_arch/verify_gemini_cli_removal_scope.md,
  // verify_gemini_cli_removal.md): 'google' es el unico ProviderType que
  // llega hasta aca -- el subproceso CLI de Gemini se retiro completo, el
  // literal se renombro a 'gemini-api' para dejar de mentir sobre "CLI" en
  // un runtime que hoy SIEMPRE es HTTP, sin ramificar por authMode aca
  // tampoco (mismo criterio que 'antigravity'/'openrouter' arriba: la
  // diferencia de authMode de Gemini vive en isApiCapableModel()/
  // ipc-agent.ts, no aca).
  return 'gemini-api'
}
