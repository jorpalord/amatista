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
  openAiChatCompletionsUrl,
  readErrorBody,
  resolveMaxOutputTokens
} from './api-agent-runtime'
import {
  asStringArray,
  EMPTY_STRUCTURED_MEMORY,
  getChatSummaryState,
  getLastMessageId,
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

/**
 * Fix real (docs/_arch/verify_claude_cli_compaction_design.md, Hallazgo 3
 * de verify_external_review_findings.md): fallback de 2do nivel para
 * cuando NI el modelo dedicado NI la conexion que origino el turno sirven
 * de respaldo -- caso real de claude-cli/antigravity-cli (subscription,
 * sin apiKey real, isApiCapableModel() ni siquiera los evalua). Recorre
 * settings.providers en su orden real (sin ranking propio -- la PRIMERA
 * que matchee, no "la mejor" segun ningun criterio) buscando una conexion
 * real, habilitada, con apiKey real, con al menos un modelo habilitado que
 * isApiCapableModel() ya acepte. undefined si ninguna conexion del usuario
 * sirve -- el caller (resolveCompactionTarget()) debe entonces devolver
 * undefined el tambien, nunca inventar un candidato.
 */
export function findAnyApiCapableConnection(
  settings: CompactionSettings
): { provider: ProviderProfile; model: ModelProfile } | undefined {
  for (const provider of settings.providers) {
    if (!provider.enabled || !provider.apiKey?.trim()) continue
    const model = provider.models.find(item => item.enabled && isApiCapableModel(provider, item))
    if (model) return { provider, model }
  }
  return undefined
}

/**
 * Fix real: `undefined` reemplaza el `{fallbackProvider, fallbackModel}`
 * incondicional de antes -- señal explicita de "no hay NADA usable" para
 * que maybeCompactChatInBackground() no intente la llamada en absoluto
 * (ni el throw silencioso de antes, ni fingir que compacto sin compactar).
 * Comportamiento sin cambio para el branch API existente: ahi
 * fallbackProvider/fallbackModel YA son API-capable con key real por
 * construccion (es la conexion que esta corriendo el turno actual), asi
 * que el chequeo de abajo siempre pasa y se devuelve la MISMA referencia
 * de siempre -- 0 cambio de comportamiento observable para ese branch.
 */
function resolveCompactionTarget(
  settings: CompactionSettings,
  fallbackProvider: ProviderProfile,
  fallbackModel: ModelProfile
): { provider: ProviderProfile; model: ModelProfile } | undefined {
  const configured = resolveConfiguredCompactionModel(settings)
  if (configured) return configured
  // Fallback de 1er nivel, sin cambios de criterio: la conexion que
  // origino el turno, SI de verdad sirve para una llamada HTTP real.
  if (fallbackProvider.apiKey?.trim() && isApiCapableModel(fallbackProvider, fallbackModel)) {
    return { provider: fallbackProvider, model: fallbackModel }
  }
  // Fallback de 2do nivel (nuevo): cualquier otra conexion real del
  // usuario que sirva. undefined si no hay ninguna.
  return findAnyApiCapableConnection(settings)
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
 * Fase 6/11: la salida es un unico objeto JSON — summary sigue siendo el
 * mismo resumen narrativo de siempre (Fase 3, sin cambios de criterio
 * ahi), sin agrupar por tema. "topics" (Fase 11) reemplaza las 3 listas
 * planas sueltas de Fase 6: ahora decisions/constraints/nextSteps viven
 * agrupadas por tema, mismo criterio ACUMULATIVO de siempre (fusion contra
 * el bloque nuevo, nunca trunca ni resume) pero por tema en vez de
 * globalmente. Los nombres de tema actuales se pasan como input explicito
 * para que el modelo reuse un tema existente en vez de fragmentar
 * conceptos parecidos bajo nombres ligeramente distintos.
 */
function compactionPrompt(
  existingSummary: string | undefined,
  existingStructured: StructuredMemory,
  chunk: StoredChatMessage[]
): { system: string; user: string } {
  const system =
    'Sos el compactador de memoria de AMATISTA. Tu salida es SIEMPRE un unico objeto JSON, sin markdown, sin ' +
    'bloque de codigo, sin texto antes ni despues — nada mas que el JSON, con esta forma exacta:\n' +
    '{"summary": string, "topics": {"<nombre de tema>": {"decisions": string[], "constraints": string[], ' +
    '"nextSteps": string[]}}}\n\n' +
    '"summary": el resumen narrativo, en texto plano dentro del JSON, mismo criterio de siempre — conserva ' +
    'datos concretos (nombres, rutas, numeros, IDs, comandos) y descarta saludos/relleno conversacional; si ' +
    'te doy un resumen previo, tu salida es ESE resumen actualizado integrando el bloque nuevo, no los dos ' +
    'textos pegados uno atras del otro. El resumen NUNCA se agrupa por tema, es siempre un unico texto.\n\n' +
    '"topics": un objeto donde cada clave es el NOMBRE de un tema y el valor son las listas ACUMULATIVAS de ' +
    'ese tema, nunca resumidas ni truncadas. Te doy los temas actuales con su contenido (puede venir vacio) ' +
    'junto con el bloque nuevo de mensajes — tu salida es la fusion: cada entrada de cada tema actual se ' +
    'conserva TAL CUAL, textual, mas las entradas nuevas que encuentres en el bloque nuevo, sin duplicar una ' +
    'entrada que ya estaba (la misma decision/restriccion/paso dicho con otras palabras SI cuenta como ' +
    'duplicado — no la repitas, no la reescribas). REGLA DE TEMAS, critica: si un hecho nuevo encaja en un ' +
    'tema que ya existe (te doy la lista de nombres actuales), agregalo AHI — nunca crees un tema nuevo con ' +
    'un nombre parecido a uno que ya existe. Crea un tema nuevo SOLO si el hecho genuinamente no encaja en ' +
    'ninguno de los existentes. Nombres de tema cortos y estables (2 a 4 palabras), siempre con el mismo ' +
    'criterio de nombrado — el mismo concepto nunca debe terminar repartido entre nombres ligeramente ' +
    'distintos de una pasada a otra. Dentro de cada tema: "decisions" son decisiones tecnicas o de producto ' +
    'ya tomadas, "constraints" son restricciones o reglas que hay que seguir respetando, "nextSteps" son ' +
    'tareas pendientes o pasos siguientes explicitos.'

  const topicNames = Object.keys(existingStructured)
  const structuredInput =
    `Nombres de tema actuales (JSON, reusar si un hecho nuevo encaja en alguno): ${JSON.stringify(topicNames)}\n` +
    `Temas actuales con su contenido (JSON): ${JSON.stringify(existingStructured)}`

  const user = existingSummary
    ? `Resumen previo:\n${existingSummary}\n\n${structuredInput}\n\nBloque nuevo a integrar:\n${messageBlockText(chunk)}\n\nDevolve el JSON con el resumen y los temas actualizados.`
    : `${structuredInput}\n\nBloque a resumir:\n${messageBlockText(chunk)}\n\nDevolve el JSON con el resumen y los temas.`

  return { system, user }
}

/** Resultado de intentar parsear la respuesta del modelo como el JSON
 *  agrupado por tema que pide compactionPrompt(). null si la respuesta no
 *  es JSON valido o le falta "summary" — señal para el llamador de que
 *  tiene que aplicar el fallback de Tarea 3/Fase 6 (texto plano como
 *  summary, temas estructurados sin tocar). */
interface ParsedCompactionResult {
  summary: string
  topics: StructuredMemory
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

    const topicsRaw = typeof record.topics === 'object' && record.topics !== null
      ? record.topics as Record<string, unknown>
      : {}
    const topics: StructuredMemory = {}
    for (const [topicName, topicValue] of Object.entries(topicsRaw)) {
      const trimmedName = topicName.trim()
      if (!trimmedName) continue
      const topicRecord = typeof topicValue === 'object' && topicValue !== null
        ? topicValue as Record<string, unknown>
        : {}
      topics[trimmedName] = {
        decisions: asStringArray(topicRecord.decisions),
        constraints: asStringArray(topicRecord.constraints),
        nextSteps: asStringArray(topicRecord.nextSteps)
      }
    }

    return { summary, topics }
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

  if (model.runtime === 'gemini-api') {
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

  // Fix real (docs/_arch/verify_compaction_openai_chat_branch.md): antes de
  // este fix, openai-chat (OpenRouter/Chat-Completions) caia en el fallback
  // de mas abajo (formato Anthropic) -- confirmado real que eso produce un
  // 404 real contra un backend Chat-Completions real, atrapado en silencio
  // por el try/catch de maybeCompactChatInBackground() (compactacion que
  // nunca compacta nada, sin ningun aviso visible). Mismo patron exacto que
  // foundry/gemini-api arriba, formato real de Chat Completions.
  if (model.runtime === 'openai-chat') {
    if (!apiKey) throw new Error('OpenRouter/Chat-Completions (compactacion) requiere API key.')
    if (!modelId) throw new Error('OpenRouter/Chat-Completions (compactacion) requiere modelo.')
    const url = openAiChatCompletionsUrl(provider.endpoint)
    // Duplicado a proposito, no exportado desde api-agent-runtime.ts
    // (ApiAgentRuntime.openAiMaxTokensField() es privado) -- funcion pura
    // de una linea, mismo criterio ya establecido en este codebase para no
    // acoplar modulos por algo tan chico (ver cli-agent-runtime.ts:parseDataUrl()).
    // o1/o3/o4/gpt-5.x son la familia real "reasoning" de OpenAI que
    // rechaza max_tokens con 400 explicito y exige max_completion_tokens;
    // todo lo demas (gpt-4o, gpt-3.5, modelos de OpenRouter) sigue
    // esperando max_tokens exacto.
    const maxTokensField = /^(o[1-9]|gpt-5)/i.test(modelId) ? 'max_completion_tokens' : 'max_tokens'
    const response = await fetchWithTimeout(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: modelId,
        messages: [{ role: 'user', content: `[system] ${system}\n\n${user}` }],
        [maxTokensField]: resolveMaxOutputTokens(model.maxOutputTokens, 'openai')
      })
    })
    if (!response.ok) throw new Error(`Compactacion OpenRouter/Chat-Completions fallo ${response.status}: ${await readErrorBody(response)}`)
    const raw = await response.json() as unknown
    const choices = Array.isArray(asRecord(raw).choices) ? asRecord(raw).choices as unknown[] : []
    const messageRecord = asRecord(asRecord(choices[0]).message)
    return (collectText(messageRecord.content) || collectText(raw)).trim()
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
 *     Desde Fase 6 (agrupado por tema desde Fase 11), la misma llamada
 *     devuelve ademas decisions/constraints/nextSteps fusionados por tema
 *     (ver compactionPrompt/parseCompactionResponse) — sigue siendo UNA
 *     sola llamada LLM, no una segunda aparte.
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
    // Fix real de TOCTOU (docs/_arch/verify_compaction_toctou.md): firma
    // real del chat capturada AL ARRANCAR, antes de la unica llamada
    // async larga de esta funcion (callCompactionModel(), mas abajo) --
    // re-comparada justo antes de persistir. Ver getLastMessageId().
    const signatureBeforeCall = getLastMessageId(params.chatId)

    const state = getChatSummaryState(params.chatId)
    const backlog = getMessagesAfter(params.chatId, state?.watermarkMessageId ?? null)
    if (backlog.length === 0) return

    const backlogTokens = backlog.reduce((sum, message) => sum + estimateTokens(message.text), 0)
    if (backlogTokens <= CONTEXT_TOKEN_BUDGET) return

    const chunk = takeOldestChunk(backlog)
    if (chunk.length === 0) return

    const existingStructured: StructuredMemory = state ? state.topics : { ...EMPTY_STRUCTURED_MEMORY }

    // Fix real (docs/_arch/verify_claude_cli_compaction_design.md): sin
    // ningun candidato usable (ni dedicado, ni la conexion del turno, ni
    // ninguna otra real del usuario) -- no intenta la llamada, no finge
    // haber compactado. Mismo backlog/watermark quedan intactos para la
    // proxima pasada, igual que cualquier otro early-return de arriba.
    const target = resolveCompactionTarget(params.settings, params.fallbackProvider, params.fallbackModel)
    if (!target) {
      if (DEBUG_TOOLS) {
        console.log(`[compaction] chat=${params.chatId} sin ninguna conexion API-capable usable -- pasada saltada, backlog sin tocar`)
      }
      return
    }
    const { provider, model } = target
    const { system, user } = compactionPrompt(state?.summary, existingStructured, chunk)
    const rawResponse = await callCompactionModel(provider, model, system, user)
    if (!rawResponse) return

    // Tarea 3/Fase 6: JSON invalido (o sin "summary") NO hace fallar la
    // pasada — cae a tratar toda la respuesta como summary en texto plano
    // (mismo comportamiento de Fase 3) y deja los temas estructurados TAL
    // COMO ESTABAN, nunca los vacia por un fallo de parseo (por eso
    // setChatSummaryState exige el 4to argumento explicito mas abajo, en
    // vez de dejarlo opcional-con-default-vacio).
    const parsed = parseCompactionResponse(rawResponse)
    const updatedSummary = parsed?.summary ?? rawResponse
    const updatedStructured: StructuredMemory = parsed ? parsed.topics : existingStructured

    // Fix real de TOCTOU: re-chequeo SINCRONICO, sin ningun await entre
    // esta comparacion y el setChatSummaryState() de abajo -- si el chat
    // cambio mientras callCompactionModel() estaba en vuelo (mensaje
    // borrado/editado via deleteChatMessagesFrom(), o un turno nuevo
    // agregado), el resultado calculado sobre el estado VIEJO se DESCARTA
    // por completo, sin persistir nada. Cierra los 2 casos reales
    // confirmados (verify_compaction_toctou.md): watermark colgante (nunca
    // se guarda un watermark que la edicion concurrente ya borro) y
    // resurreccion (la pasada vieja nunca sobreescribe el NULL que una
    // edicion mas reciente ya seteo correctamente via
    // invalidateSummaryIfWatermarkMissing()). Fire-and-forget -- nadie
    // espera este resultado, no hace falta ningun error visible; la
    // proxima pasada recalcula desde el estado real y vigente.
    if (getLastMessageId(params.chatId) !== signatureBeforeCall) {
      if (DEBUG_TOOLS) {
        console.log(`[compaction] chat=${params.chatId} descartado -- el historial cambio mientras la compactacion estaba en vuelo`)
      }
      return
    }

    const newWatermark = chunk[chunk.length - 1].id
    setChatSummaryState(params.chatId, updatedSummary, newWatermark, updatedStructured)

    if (DEBUG_TOOLS) {
      const topicNames = Object.keys(updatedStructured)
      const itemCount = Object.values(updatedStructured)
        .reduce((sum, topic) => sum + topic.decisions.length + topic.constraints.length + topic.nextSteps.length, 0)
      console.log(
        `[compaction] chat=${params.chatId} chunk=${chunk.length}msgs backlogTokens=${backlogTokens} ` +
        `restante=${backlog.length - chunk.length}msgs nuevoWatermark=${newWatermark} jsonValido=${Boolean(parsed)} ` +
        `temas=${topicNames.length}[${topicNames.join(', ')}] items=${itemCount}`
      )
    }
  } catch (error) {
    // Fire-and-forget real: un fallo aca NUNCA debe tocar el turno ya
    // resuelto ni el estado persistido del chat. Peor caso: el proximo
    // turno ve el mismo backlog sin resumir y esta pasada se reintenta sola.
    console.error('[compaction] fallo compactando chat', params.chatId, error)
  }
}
