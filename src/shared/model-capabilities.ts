import type { ModelProfile, ProviderProfile } from './types'

/**
 * True si este modelo se puede invocar con una sola llamada HTTP de una
 * vuelta (request → response, sin proceso hijo): Foundry, Claude API,
 * OpenRouter/Chat-Completions (Fase 15), o Gemini API con autenticacion
 * por API key. Los runtimes CLI (claude-cli, codex-subscription) requieren
 * spawnear un binario externo y quedan fuera de esta categoria.
 *
 * Antes de Fase 3 esta misma condicion vivia repetida (no importada) en
 * ipc-agent.ts (decidir el runtime real de agent:connect) — ahora se suma
 * como candidato valido de modelo de compactacion tanto en el main
 * (compaction-engine.ts) como en el renderer (App.tsx, selector de
 * Settings). Una sola declaracion en vez de una tercera copia coincidente.
 *
 * Retiro de gemini-cli (docs/_arch/verify_gemini_cli_removal_scope.md,
 * verify_gemini_cli_removal.md): el literal de RuntimeKind se renombro de
 * 'gemini-cli' a 'gemini-api' -- YA NO existe ningun runtime CLI de Gemini,
 * asi que este chequeo de authMode==='api-key' es ahora mas una
 * confirmacion defensiva que una bifurcacion real (todo modelo con
 * runtime:'gemini-api' es HTTP por construccion) -- se deja igual, mismo
 * shape que el resto de la funcion, en vez de asumir la invariante sin
 * chequearla.
 */
export function isApiCapableModel(provider: ProviderProfile, model: ModelProfile): boolean {
  return model.runtime === 'foundry' ||
    model.runtime === 'anthropic-api' ||
    model.runtime === 'openai-chat' ||
    (model.runtime === 'gemini-api' && provider.authMode === 'api-key')
}

/**
 * Feature "generacion de imagenes" (docs/_arch/verify_image_generation.md,
 * Tarea 2): heuristica, NO una capacidad real declarada -- ModelProfile no
 * tiene (todavia) ningun campo que distinga "este deployment genera
 * imagenes" de "este deployment chatea" (confirmado en la investigacion:
 * `qcfg-foundry-gpt-image-2` y `qcfg-foundry-chat` comparten
 * `runtime: 'foundry'`, nada mas los separa). Matchea contra el nombre
 * REAL del deployment (`model.model`, ej. "gpt-image-2"), no el id interno
 * ni el displayName -- evita falsos negativos si el usuario renombra el
 * displayName. Usada SOLO para sugerir un default implicito en el
 * selector de Settings/resolveConfiguredImageGenerationModel() cuando el
 * usuario nunca eligio nada a mano -- una eleccion explicita SIEMPRE gana,
 * sin pasar por esta funcion.
 */
export function isLikelyImageModel(model: ModelProfile): boolean {
  return /image/i.test(model.model)
}
