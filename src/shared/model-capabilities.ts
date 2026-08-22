import type { ModelProfile, ProviderProfile } from './types'

/**
 * True si este modelo se puede invocar con una sola llamada HTTP de una
 * vuelta (request → response, sin proceso hijo): Foundry, Claude API, o
 * Gemini API con autenticacion por API key. Los runtimes CLI (claude-cli,
 * codex-subscription, gemini-cli por suscripcion) requieren spawnear un
 * binario externo y quedan fuera de esta categoria.
 *
 * Antes de Fase 3 esta misma condicion vivia repetida (no importada) en
 * ipc-agent.ts (decidir el runtime real de agent:connect) — ahora se suma
 * como candidato valido de modelo de compactacion tanto en el main
 * (compaction-engine.ts) como en el renderer (App.tsx, selector de
 * Settings). Una sola declaracion en vez de una tercera copia coincidente.
 */
export function isApiCapableModel(provider: ProviderProfile, model: ModelProfile): boolean {
  return model.runtime === 'foundry' ||
    model.runtime === 'anthropic-api' ||
    (model.runtime === 'gemini-cli' && provider.authMode === 'api-key')
}
