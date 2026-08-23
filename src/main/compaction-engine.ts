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
  readErrorBody,
  resolveMaxOutputTokens
} from './api-agent-runtime'
import {
  EMPTY_STRUCTURED_MEMORY,
  getChatSummaryState,
  getMessagesAfter,
  setChatSummaryState,
  type StructuredMemory
} from './chat-store'
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

/**
 * Fase 6: la salida pasa de texto plano a un unico objeto JSON con 4
 * claves — summary sigue siendo el mismo resumen narrativo de siempre
 * (Fase 3, sin cambios de criterio ahi); decisions/constraints/nextSteps
 * son nuevas, ACUMULATIVAS: se le pasan las listas actuales como input
 * (mismo espiritu que ya se le pasa el resumen previo) y el modelo
 * devuelve la fusion contra el bloque nuevo — nunca las trunca ni las
 * resume, solo agrega lo nuevo y deduplica.
 */
function compactionPrompt(
  existingSummary: string | undefined,
  existingStructured: StructuredMemory,
  chunk: StoredChatMessage[]
): { system: string; user: string } {
  const system =
    'Sos el compactador de memoria de AMATISTA. Tu salida es SIEMPRE un unico objeto JSON, sin markdown, sin ' +
    'bloque de codigo, sin texto antes ni despues — nada mas que el JSON, con esta forma exacta:\n' +
    '{"summary": string, "decisions": string[], "constraints": string[], "nextSteps": string[]}\n\n' +
    '"summary": el resumen narrativo, en texto plano dentro del JSON, mismo criterio de siempre — conserva ' +
    'datos concretos (nombres, rutas, numeros, IDs, comandos) y descarta saludos/relleno conversacional; si ' +
    'te doy un resumen previo, tu salida es ESE resumen actualizado integrando el bloque nuevo, no los dos ' +
    'textos pegados uno atras del otro.\n\n' +
    '"decisions", "constraints" y "nextSteps": listas ACUMULATIVAS, nunca resumidas ni truncadas. Te doy las ' +
    'listas actuales (pueden venir vacias) junto con el bloque nuevo de mensajes — tu salida es la fusion de ' +
    'ambas: cada entrada de las listas actuales se conserva TAL CUAL, textual, mas las entradas nuevas que ' +
    'encuentres en el bloque nuevo, sin duplicar una entrada que ya estaba (la misma decision/restriccion/' +
    'paso dicho con otras palabras SI cuenta como duplicado — no la repitas, no la reescribas). "decisions" ' +
    'son decisiones tecnicas o de producto ya tomadas. "constraints" son restricciones o reglas que hay que ' +
    'seguir respetando. "nextSteps" son tareas pendientes o pasos siguientes explicitos.'

  const structuredInput =
    `Decisiones actuales (JSON): ${JSON.stringify(existingStructured.decisions)}\n` +
    `Restricciones actuales (JSON): ${JSON.stringify(existingStructured.constraints)}\n` +
    `Proximos pasos actuales (JSON): ${JSON.stringify(existingStructured.nextSteps)}`

  const user = existingSummary
    ? `Resumen previo:\n${existingSummary}\n\n${structuredInput}\n\nBloque nuevo a integrar:\n${messageBlockText(chunk)}\n\nDevolve el JSON con el resumen y las listas actualizadas.`
    : `${structuredInput}\n\nBloque a resumir:\n${messageBlockText(chunk)}\n\nDevolve el JSON con el resumen y las listas.`

  return { system, user }
}

/** Resultado de intentar parsear la respuesta del modelo como el JSON de
 *  4 claves que pide compactionPrompt(). null si la respuesta no es JSON
 *  valido o le falta "summary" — señal para el llamador de que tiene que
 *  aplicar el fallback de Tarea 3 (texto plano como summary, listas
 *  estructuradas sin tocar). */
interface ParsedCompactionResult extends StructuredMemory {
  summary: string
}

function parseCompactionResponse(raw: string): ParsedCompactionResult | null {
  // Algunos modelos envuelven el JSON en un bloque de codigo pese a la
  // instruccion explicita de no hacerlo — se lo saca antes de parsear en
  // vez de tratarlo como JSON invalido por eso.
  const unfenced = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim()
  try {
    const parsed = JSON.parse(unfenced) as unknown
    if (typeof parsed !== 'object' || parsed === null) return null
    const record = parsed as Record<string, unknown>
    const summary = typeof record.summary === 'string' ? record.summary.trim() : ''
    if (!summary) return null
    return {
      summary,
      decisions: Array.isArray(record.decisions) ? record.decisions.filter((item): item is string => typeof item === 'string') : [],
      constraints: Array.isArray(record.constraints) ? record.constraints.filter((item): item is string => typeof item === 'string') : [],
      nextSteps: Array.isArray(record.nextSteps) ? record.nextSteps.filter((item): item is string => typeof item === 'string') : []
    }
  } catch {
    return null
  }
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
        max_output_tokens: resolveMaxOutputTokens(model.maxOutputTokens, 'foundry'),
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
        contents: [{ role: 'user', parts: [{ text: `[system] ${system}\n\n${user}` }] }],
        generationConfig: { maxOutputTokens: resolveMaxOutputTokens(model.maxOutputTokens, 'gemini') }
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
      // resolveMaxOutputTokens en vez de un numero fijo: el JSON de Fase 6
      // (summary + 3 listas acumulativas) puede pesar bastante mas que el
      // resumen en texto plano de Fase 3 en chats con muchas decisiones/
      // restricciones — un techo fijo chico se cortaria a mitad del JSON.
      max_tokens: resolveMaxOutputTokens(model.maxOutputTokens, 'anthropic', modelId),
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
 *     Desde Fase 6, la misma llamada devuelve ademas decisions/constraints/
 *     nextSteps fusionados (ver compactionPrompt/parseCompactionResponse)
 *     — sigue siendo UNA sola llamada LLM, no una segunda aparte.
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

    const existingStructured: StructuredMemory = state
      ? { decisions: state.decisions, constraints: state.constraints, nextSteps: state.nextSteps }
      : { ...EMPTY_STRUCTURED_MEMORY }

    const { provider, model } = resolveCompactionTarget(params.settings, params.fallbackProvider, params.fallbackModel)
    const { system, user } = compactionPrompt(state?.summary, existingStructured, chunk)
    const rawResponse = await callCompactionModel(provider, model, system, user)
    if (!rawResponse) return

    // Tarea 3: JSON invalido (o sin "summary") NO hace fallar la pasada —
    // cae a tratar toda la respuesta como summary en texto plano (mismo
    // comportamiento de Fase 3) y deja las listas estructuradas TAL COMO
    // ESTABAN, nunca las vacia por un fallo de parseo (por eso
    // setChatSummaryState exige el 4to argumento explicito mas abajo, en
    // vez de dejarlo opcional-con-default-vacio).
    const parsed = parseCompactionResponse(rawResponse)
    const updatedSummary = parsed?.summary ?? rawResponse
    const updatedStructured: StructuredMemory = parsed
      ? { decisions: parsed.decisions, constraints: parsed.constraints, nextSteps: parsed.nextSteps }
      : existingStructured

    const newWatermark = chunk[chunk.length - 1].id
    setChatSummaryState(params.chatId, updatedSummary, newWatermark, updatedStructured)

    if (DEBUG_TOOLS) {
      console.log(
        `[compaction] chat=${params.chatId} chunk=${chunk.length}msgs backlogTokens=${backlogTokens} ` +
        `restante=${backlog.length - chunk.length}msgs nuevoWatermark=${newWatermark} jsonValido=${Boolean(parsed)} ` +
        `decisions=${updatedStructured.decisions.length} constraints=${updatedStructured.constraints.length} ` +
        `nextSteps=${updatedStructured.nextSteps.length}`
      )
    }
  } catch (error) {
    // Fire-and-forget real: un fallo aca NUNCA debe tocar el turno ya
    // resuelto ni el estado persistido del chat. Peor caso: el proximo
    // turno ve el mismo backlog sin resumir y esta pasada se reintenta sola.
    console.error('[compaction] fallo compactando chat', params.chatId, error)
  }
}
