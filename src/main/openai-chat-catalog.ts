// Fase 18: catalogo real de modelos para conexiones openai-chat (Fase 15,
// OpenRouter/cualquier backend Chat-Completions-compatible) -- mismo
// espiritu que codex-account-bridge.ts:listModels(), pero HTTP plano
// (GET <endpoint>/models) en vez de JSON-RPC: openai-chat sirve a
// CUALQUIER endpoint que implemente esta convencion, no a un servicio con
// protocolo propio como Codex, asi que el parseo tiene que ser defensivo
// (mismo criterio firstString/fallback-keys que ya usa listModels()) en vez
// de asumir el shape exacto de OpenRouter en todos los casos.
import { fetchWithTimeout, readErrorBody } from './api-agent-runtime'

export interface OpenAiChatCatalogModel {
  id: string
  displayName: string
  contextLength?: number
  maxOutputTokens?: number
  supportsTools: boolean
  supportsVision: boolean
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : {}
}

function firstString(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string' && value.trim()) return value
  }
  return undefined
}

function firstNumber(record: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value
  }
  return undefined
}

/**
 * Mismo criterio de normalizacion de endpoint que openAiChatCompletionsUrl()
 * (api-agent-runtime.ts) -- no reusada de ahi a proposito, es un archivo de
 * otra responsabilidad y el acoplamiento no vale la pena por esta funcion
 * de 6 lineas. Tolera endpoint con o sin /v1, con o sin /models ya puesto.
 */
export function openAiModelsUrl(endpoint?: string): string {
  const clean = (endpoint ?? '').trim().replace(/\/+$/, '')
  if (!clean) throw new Error('Requiere endpoint.')
  if (clean.endsWith('/models')) return clean
  if (clean.endsWith('/v1')) return `${clean}/models`
  return `${clean}/v1/models`
}

/**
 * GET <endpoint>/models real. Sin key (endpoint publico, confirmado en vivo
 * contra OpenRouter: /models responde 200 sin Authorization) el header ni
 * se manda -- algunos backends Chat-Completions-compatible SI la exigen
 * incluso para listar, asi que se manda si esta presente, nunca se fuerza.
 */
export async function listOpenAiChatModels(endpoint: string, apiKey: string): Promise<OpenAiChatCatalogModel[]> {
  const url = openAiModelsUrl(endpoint)
  const key = apiKey.trim()
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (key) headers.Authorization = `Bearer ${key}`

  const response = await fetchWithTimeout(url, { method: 'GET', headers })
  if (!response.ok) {
    throw new Error(`GET ${url} falló ${response.status}: ${await readErrorBody(response)}`)
  }

  const raw = await response.json() as unknown
  const record = asRecord(raw)
  // OpenRouter real: {data:[...], total_count, links}. Defensivo para
  // backends que devuelvan {models:[...]} o directamente un array plano.
  const data = [record.data, record.models, raw].find(Array.isArray)
  if (!Array.isArray(data)) return []

  return data
    .map(item => {
      const model = asRecord(item)
      const id = firstString(model, ['id', 'model', 'slug', 'name'])
      if (!id) return null

      const displayName = firstString(model, ['name', 'display_name', 'displayName', 'label']) ?? id
      const contextLength = firstNumber(model, ['context_length', 'contextLength', 'context_window'])

      // top_provider.max_completion_tokens es el techo REAL de salida del
      // modelo en OpenRouter (confirmado en vivo: stealth/ox-alpha ->
      // 131072, coincide con lo ya documentado a mano en CONTRACT.md desde
      // Fase 15) -- se prefiere sobre cualquier campo plano equivalente.
      const topProvider = asRecord(model.top_provider)
      const maxOutputTokens =
        firstNumber(topProvider, ['max_completion_tokens', 'max_output_tokens']) ??
        firstNumber(model, ['max_completion_tokens', 'max_output_tokens'])

      // "tools" (string exacta) en supported_parameters, confirmado en vivo
      // contra el shape real de OpenRouter -- 348 de 417 modelos reales lo
      // traen. Campo equivalente en otros backends: no hay uno universal
      // confirmado, asi que si el campo esta ausente el modelo simplemente
      // no pasa el filtro por default (mostrarTodos en la UI lo destapa).
      const supportedParams =
        model.supported_parameters ?? model.supportedParameters ?? model.capabilities ?? model.features
      const supportsTools =
        Array.isArray(supportedParams) && supportedParams.some(value => typeof value === 'string' && value === 'tools')

      // architecture.input_modalities incluye "image" en modelos vision-
      // capable, confirmado en vivo (ej. stealth/ox-alpha: text+image+video).
      const architecture = asRecord(model.architecture)
      const inputModalities = architecture.input_modalities ?? architecture.modalities ?? model.input_modalities
      const supportsVision =
        Array.isArray(inputModalities) && inputModalities.some(value => typeof value === 'string' && value.toLowerCase().includes('image'))

      const parsed: OpenAiChatCatalogModel = { id, displayName, supportsTools, supportsVision }
      if (contextLength !== undefined) parsed.contextLength = contextLength
      if (maxOutputTokens !== undefined) parsed.maxOutputTokens = maxOutputTokens
      return parsed
    })
    .filter(Boolean) as OpenAiChatCatalogModel[]
}
