// Motor de compactacion de memoria (Fase 3). Decide si un chat tiene
// backlog suficiente sin resumir, compacta el bloque mas viejo de ese
// backlog en una sola llamada LLM (sin tools, sin loop de MAX_TOOL_LOOP)
// contra el modelo de compactacion configurado, y persiste el resultado.
// Se dispara fire-and-forget desde ipc-agent.ts DESPUES de que un turno de
// runtime API ya respondio al usuario — nunca agrega latencia al turno en
// curso, nunca lo hace fallar si algo sale mal aca adentro.
import {
  anthropicMessagesUrl,
  asRecord,
  collectText,
  encodeModelPath,
  fetchWithTimeout,
  normalizeFoundryBaseUrl,
  normalizeGeminiBaseUrl,
  normalizeGeminiModel,
  readErrorBody
} from './api-agent-runtime'
import { getChatSummaryState, getMessagesAfter, setChatSummaryState } from './chat-store'
import { CONTEXT_TOKEN_BUDGET, estimateTokens } from '../shared/context-budget'
import { isApiCapableModel } from '../shared/model-capabilities'
import type { AppSettings, ModelProfile, ProviderProfile, StoredChatMessage } from '../shared/types'

export type CompactionSettings = Pick<AppSettings, 'compactionProviderId' | 'compactionModelId' | 'providers'>

const DEBUG_TOOLS = process.env.AMATISTA_DEBUG_TOOLS === '1'

/**
 * Busca el modelo barato configurado en Settings (compactionProviderId +
 * compactionModelId) SIN fallback — null si no hay uno elegido, o si el
 * elegido ya no es apto para llamada de una vuelta (desactivado, borrado,
 * o nunca lo fue). Exportada porque explore-tool.ts (Fase 4) reusa el
 * mismo campo de configuracion, con una politica de fallback distinta a la
 * de compactacion (explore prefiere devolver un error claro — Tarea 3 de
 * Fase 4 — en vez de caer silenciosamente al modelo activo).
 */
export function resolveConfiguredCompactionModel(
  settings: CompactionSettings
): { provider: ProviderProfile; model: ModelProfile } | null {
  const provider = settings.providers.find(item => item.id === settings.compactionProviderId && item.enabled)
  const model = provider?.models.find(item => item.id === settings.compactionModelId && item.enabled)
  if (provider && model && isApiCapableModel(provider, model)) return { provider, model }
  return null
}

function resolveCompactionTarget(
  settings: CompactionSettings,
  fallbackProvider: ProviderProfile,
  fallbackModel: ModelProfile
): { provider: ProviderProfile; model: ModelProfile } {
  // Compactacion SI tiene fallback (a diferencia de explore): si no hay
  // modelo dedicado, o el configurado dejo de ser valido, usa el modelo
  // activo del turno en vez de reventar la pasada de compactacion.
  return resolveConfiguredCompactionModel(settings) ?? { provider: fallbackProvider, model: fallbackModel }
}

function messageBlockText(messages: StoredChatMessage[]): string {
  return messages.map(message => `[${message.role}] ${message.text.trim()}`).join('\n')
}

/**
 * Toma el bloque MAS VIEJO del backlog hasta agotar CONTEXT_TOKEN_BUDGET
 * (Tarea 5: nunca se manda el backlog completo de una sola vez a la
 * llamada de compactacion, sin importar que tan grande sea). Si el primer
 * mensaje solo ya excede el presupuesto se incluye igual — evita que un
 * mensaje gigante atasque la compactacion para siempre.
 */
function takeOldestChunk(messages: StoredChatMessage[]): StoredChatMessage[] {
  const chunk: StoredChatMessage[] = []
  let tokens = 0
  for (const message of messages) {
    const messageTokens = estimateTokens(message.text)
    if (chunk.length > 0 && tokens + messageTokens > CONTEXT_TOKEN_BUDGET) break
    chunk.push(message)
    tokens += messageTokens
  }
  return chunk
}

function compactionPrompt(existingSummary: string | undefined, chunk: StoredChatMessage[]): { system: string; user: string } {
  const system =
    'Sos el compactador de memoria de AMATISTA. Tu unica salida es un resumen actualizado en texto plano, ' +
    'sin markdown, sin preambulo, sin firmar. Conserva decisiones tomadas, datos concretos (nombres, rutas, ' +
    'numeros, IDs, comandos) y el estado de tareas en curso. Descarta saludos y relleno conversacional. ' +
    'Si te dan un resumen previo, tu salida debe ser ese resumen ACTUALIZADO integrando el bloque nuevo — ' +
    'no los dos textos pegados uno atras del otro.'

  const user = existingSummary
    ? `Resumen previo:\n${existingSummary}\n\nBloque nuevo a integrar:\n${messageBlockText(chunk)}\n\nDevolve el resumen actualizado.`
    : `Bloque a resumir:\n${messageBlockText(chunk)}\n\nDevolve el resumen.`

  return { system, user }
}

/**
 * Llamada de una sola vuelta (sin tools) contra el modelo de compactacion.
 * Reusa las utilidades HTTP de api-agent-runtime.ts en vez de un cuarto
 * cliente HTTP — misma construccion de URL y misma lectura de respuesta que
 * ya estan probadas ahi, solo sin el loop de tool-calling.
 */
async function callCompactionModel(
  provider: ProviderProfile,
  model: ModelProfile,
  system: string,
  user: string
): Promise<string> {
  const apiKey = provider.apiKey?.trim()
  const modelId = model.model.trim()

  if (model.runtime === 'foundry') {
    if (!apiKey) throw new Error('Foundry (compactacion) requiere API key.')
    if (!modelId) throw new Error('Foundry (compactacion) requiere deployment/modelo.')
    const baseUrl = normalizeFoundryBaseUrl(provider.endpoint)
    const response = await fetchWithTimeout(`${baseUrl}/responses`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'api-key': apiKey },
      body: JSON.stringify({
        model: modelId,
        // Mismo patron que foundryInputArray en api-agent-runtime.ts: este
        // codebase nunca uso un campo system/instructions nativo de
        // Foundry, folea el system-prompt como primer turno "user" con tag.
        input: [
          { role: 'user', content: `[system] ${system}` },
          { role: 'user', content: user }
        ]
      })
    })
    if (!response.ok) throw new Error(`Compactacion Foundry fallo ${response.status}: ${await readErrorBody(response)}`)
    const raw = await response.json() as unknown
    return collectText(asRecord(raw).output).trim()
  }

  if (model.runtime === 'gemini-cli') {
    if (!apiKey) throw new Error('Gemini API (compactacion) requiere API key.')
    const modelPath = encodeModelPath(normalizeGeminiModel(modelId))
    const url = `${normalizeGeminiBaseUrl(provider.endpoint)}/models/${modelPath}:generateContent`
    const response = await fetchWithTimeout(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: `[system] ${system}\n\n${user}` }] }]
      })
    })
    if (!response.ok) throw new Error(`Compactacion Gemini API fallo ${response.status}: ${await readErrorBody(response)}`)
    const raw = await response.json() as unknown
    return collectText(asRecord(raw).candidates).trim()
  }

  // anthropic-api (incluye DeepSeek, que reusa este runtime con endpoint propio).
  if (!apiKey) throw new Error('Claude API (compactacion) requiere API key.')
  if (!modelId) throw new Error('Claude API (compactacion) requiere modelo/deployment.')
  const url = anthropicMessagesUrl(provider.endpoint)
  const response = await fetchWithTimeout(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'api-key': apiKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: modelId,
      max_tokens: 2048,
      system,
      messages: [{ role: 'user', content: user }]
    })
  })
  if (!response.ok) throw new Error(`Compactacion Claude API fallo ${response.status}: ${await readErrorBody(response)}`)
  const raw = await response.json() as unknown
  return collectText(asRecord(raw).content).trim()
}

/**
 * Punto de entrada. Llamar SIEMPRE fire-and-forget (nunca await'eado por
 * agent:send) despues de que un turno de runtime API ya entrego su
 * respuesta. Internamente:
 *  1. Lee el watermark actual (null = nada resumido todavia) y el backlog
 *     posterior via chat-store.getMessagesAfter — sincronico (SQLite),
 *     nunca hay carrera con el resto del turno.
 *  2. Si el backlog no supera CONTEXT_TOKEN_BUDGET, no hace nada: no vale
 *     la pena compactar todavia.
 *  3. Si lo supera, compacta el bloque MAS VIEJO (Tarea 5) contra el
 *     modelo de compactacion configurado (o el activo del turno si no hay
 *     uno dedicado) y avanza el watermark al ultimo mensaje de ese bloque.
 *  4. El resto del backlog (si el bloque no alcanzo para cubrirlo todo)
 *     queda para la PROXIMA pasada — nunca se compacta todo de una vez.
 * Nota de temporizacion: el mensaje del asistente de ESTE turno recien se
 * persiste en SQLite despues, cuando el renderer procesa el evento
 * turn/completed (ver App.tsx → persistChatMessage) — a esta altura
 * todavia no esta en chat_messages. No es un bug: esa vuelta queda para la
 * siguiente pasada de compactacion, mismo mecanismo de "varias pasadas" que
 * ya cubre el caso de backfill.
 */
export async function maybeCompactChatInBackground(params: {
  chatId: string
  settings: CompactionSettings
  fallbackProvider: ProviderProfile
  fallbackModel: ModelProfile
}): Promise<void> {
  try {
    const state = getChatSummaryState(params.chatId)
    const backlog = getMessagesAfter(params.chatId, state?.watermarkMessageId ?? null)
    if (backlog.length === 0) return

    const backlogTokens = backlog.reduce((sum, message) => sum + estimateTokens(message.text), 0)
    if (backlogTokens <= CONTEXT_TOKEN_BUDGET) return

    const chunk = takeOldestChunk(backlog)
    if (chunk.length === 0) return

    const { provider, model } = resolveCompactionTarget(params.settings, params.fallbackProvider, params.fallbackModel)
    const { system, user } = compactionPrompt(state?.summary, chunk)
    const updatedSummary = await callCompactionModel(provider, model, system, user)
    if (!updatedSummary) return

    const newWatermark = chunk[chunk.length - 1].id
    setChatSummaryState(params.chatId, updatedSummary, newWatermark)

    if (DEBUG_TOOLS) {
      console.log(
        `[compaction] chat=${params.chatId} chunk=${chunk.length}msgs backlogTokens=${backlogTokens} ` +
        `restante=${backlog.length - chunk.length}msgs nuevoWatermark=${newWatermark}`
      )
    }
  } catch (error) {
    // Fire-and-forget real: un fallo aca NUNCA debe tocar el turno ya
    // resuelto ni el estado persistido del chat. Peor caso: el proximo
    // turno ve el mismo backlog sin resumir y esta pasada se reintenta sola.
    console.error('[compaction] fallo compactando chat', params.chatId, error)
  }
}
