// Mini-loop de la tool "explore" (Fase 4): delega busqueda/lectura
// repetitiva al modelo barato configurado en Settings (mismo
// compactionProviderId/compactionModelId de Fase 3 — un solo lugar de
// "modelo barato", no un segundo selector), con acceso SOLO a las 4 tools
// de lectura (read_file, list_dir, git_status, git_diff). Nunca write_file
// ni run_command: el whitelist se aplica aca adentro, en el unico punto
// donde se despacha una tool call del modelo barato — no alcanza con que
// ToolRegistry solo le OFREZCA 4 tools, porque un modelo puede alucinar un
// nombre de tool que no le ofrecieron.
//
// Reutiliza fetchWithTimeout/readErrorBody/asRecord/collectText y los tres
// constructores de definicion de tools de api-agent-runtime.ts — mismo
// patron que compaction-engine.ts, sin un cuarto/quinto cliente HTTP.
import {
  anthropicMessagesUrl,
  anthropicTools,
  asRecord,
  collectText,
  encodeModelPath,
  fetchWithTimeout,
  foundryTools,
  geminiFunctionDeclarations,
  normalizeFoundryBaseUrl,
  normalizeGeminiBaseUrl,
  normalizeGeminiModel,
  readErrorBody
} from './api-agent-runtime'
import type { ModelProfile, ProviderProfile } from '../shared/types'
import type { ToolDefinition, ToolExecutionResult } from './tool-registry'

// Menor que MAX_TOOL_LOOP (60, api-agent-runtime.ts) a proposito: explore
// resuelve tareas puntuales de lectura ("encontra X", "leeme Y y resumime"),
// no sesiones agenticas completas — si necesita mas de 10 vueltas de
// lectura para una tarea puntual, probablemente conviene que el modelo
// caro la haga el mismo con mas contexto de la conversacion.
const MAX_EXPLORE_LOOP = 10

export const EXPLORE_TOOL_NAMES = ['read_file', 'list_dir', 'git_status', 'git_diff'] as const
type ExploreToolName = typeof EXPLORE_TOOL_NAMES[number]

function isExploreToolName(name: string): name is ExploreToolName {
  return (EXPLORE_TOOL_NAMES as readonly string[]).includes(name)
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function safeJsonParse(value: string): unknown {
  if (!value.trim()) return {}
  try {
    return JSON.parse(value)
  } catch {
    return {}
  }
}

function explorationSystemPrompt(task: string): string {
  return (
    `Sos un explorador de codigo delegado por otro modelo. Tu tarea puntual: ${task}\n` +
    'Tenes acceso a read_file, list_dir, git_status y git_diff — SOLO lectura, nunca escribis archivos ni ' +
    'ejecutas comandos. Investiga lo que haga falta con esas tools y despues respondé UNA SOLA VEZ, en texto ' +
    'plano, con un resumen CONDENSADO: rutas relevantes, hallazgos concretos, citas breves de contenido si ' +
    'hace falta (nunca el archivo completo). El que te llamo no va a leer lo que vos leiste, solo tu ' +
    'conclusion final — no le pegues el volcado crudo de ningun archivo.'
  )
}

/**
 * Unico punto de despacho de una tool call del modelo barato. Verifica el
 * whitelist ANTES de invocar runTool — si el modelo pide "write_file" o
 * cualquier nombre fuera de EXPLORE_TOOL_NAMES, nunca llega a ejecutarse,
 * sin importar que haya en el registro real.
 */
async function runReadOnlyTool(
  name: string,
  args: unknown,
  runTool: (name: string, args: unknown) => Promise<ToolExecutionResult>
): Promise<ToolExecutionResult> {
  if (!isExploreToolName(name)) {
    return {
      ok: false,
      output: `Tool "${name}" no disponible dentro de explore (solo lectura: ${EXPLORE_TOOL_NAMES.join(', ')}).`
    }
  }
  return runTool(name, args)
}

interface LoopParams {
  provider: ProviderProfile
  model: ModelProfile
  task: string
  toolDefs: ToolDefinition[]
  runTool: (name: string, args: unknown) => Promise<ToolExecutionResult>
}

async function exploreFoundry(params: LoopParams): Promise<string> {
  const { provider, model, task, toolDefs, runTool } = params
  const apiKey = provider.apiKey?.trim()
  if (!apiKey) throw new Error('Foundry (explore) requiere API key.')
  const modelId = model.model.trim()
  if (!modelId) throw new Error('Foundry (explore) requiere deployment/modelo.')

  const baseUrl = normalizeFoundryBaseUrl(provider.endpoint)
  const tools = foundryTools(toolDefs)
  let input: unknown[] = [{ role: 'user', content: `[system] ${explorationSystemPrompt(task)}` }]
  let partialText = ''

  for (let turn = 0; turn < MAX_EXPLORE_LOOP; turn++) {
    const response = await fetchWithTimeout(`${baseUrl}/responses`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'api-key': apiKey },
      body: JSON.stringify({ model: modelId, input, tools })
    })
    if (!response.ok) throw new Error(`explore (Foundry) fallo ${response.status}: ${await readErrorBody(response)}`)

    const raw = await response.json() as unknown
    const record = asRecord(raw)
    const outputItems = Array.isArray(record.output) ? record.output as unknown[] : []
    const calls = outputItems.filter(item => asRecord(item).type === 'function_call')
    partialText = collectText(record.output) || partialText

    if (calls.length === 0) {
      return (collectText(record.output) || collectText(raw)).trim() || 'La exploracion termino sin texto final.'
    }

    input = [...input, ...outputItems]
    for (const call of calls) {
      const callRecord = asRecord(call)
      const callId = asString(callRecord.call_id) || asString(callRecord.id)
      const toolName = asString(callRecord.name)
      const args = safeJsonParse(asString(callRecord.arguments))
      const result = await runReadOnlyTool(toolName, args, runTool)
      input.push({ type: 'function_call_output', call_id: callId, output: result.output })
    }
  }

  throw new Error(
    `explore alcanzo el limite de ${MAX_EXPLORE_LOOP} iteraciones sin resumen final. ` +
    `Ultimo texto parcial: ${partialText.trim().slice(0, 300) || '(ninguno)'}`
  )
}

async function exploreGeminiApi(params: LoopParams): Promise<string> {
  const { provider, model, task, toolDefs, runTool } = params
  const apiKey = provider.apiKey?.trim()
  if (!apiKey) throw new Error('Gemini API (explore) requiere API key.')

  const modelPath = encodeModelPath(normalizeGeminiModel(model.model))
  const url = `${normalizeGeminiBaseUrl(provider.endpoint)}/models/${modelPath}:generateContent`
  const functionDeclarations = geminiFunctionDeclarations(toolDefs)
  let contents: unknown[] = [{ role: 'user', parts: [{ text: `[system] ${explorationSystemPrompt(task)}` }] }]
  let partialText = ''

  for (let turn = 0; turn < MAX_EXPLORE_LOOP; turn++) {
    const response = await fetchWithTimeout(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify({ contents, tools: [{ functionDeclarations }] })
    })
    if (!response.ok) throw new Error(`explore (Gemini API) fallo ${response.status}: ${await readErrorBody(response)}`)

    const raw = await response.json() as unknown
    const record = asRecord(raw)
    const candidates = Array.isArray(record.candidates) ? record.candidates as unknown[] : []
    const candidateContent = asRecord(asRecord(candidates[0]).content)
    const parts = Array.isArray(candidateContent.parts) ? candidateContent.parts as unknown[] : []
    const functionCalls = parts.filter(part => asRecord(part).functionCall)
    partialText = collectText(record.candidates) || partialText

    if (functionCalls.length === 0) {
      return (collectText(record.candidates) || collectText(raw)).trim() || 'La exploracion termino sin texto final.'
    }

    contents = [...contents, { role: 'model', parts }]
    const responseParts: unknown[] = []
    for (const call of functionCalls) {
      const callRecord = asRecord(asRecord(call).functionCall)
      const toolName = asString(callRecord.name)
      const result = await runReadOnlyTool(toolName, callRecord.args, runTool)
      responseParts.push({ functionResponse: { name: toolName, response: { content: result.output } } })
    }
    contents.push({ role: 'function', parts: responseParts })
  }

  throw new Error(
    `explore alcanzo el limite de ${MAX_EXPLORE_LOOP} iteraciones sin resumen final. ` +
    `Ultimo texto parcial: ${partialText.trim().slice(0, 300) || '(ninguno)'}`
  )
}

async function exploreAnthropicApi(params: LoopParams): Promise<string> {
  const { provider, model, task, toolDefs, runTool } = params
  const apiKey = provider.apiKey?.trim()
  if (!apiKey) throw new Error('Claude API (explore) requiere API key.')
  const modelId = model.model.trim()
  if (!modelId) throw new Error('Claude API (explore) requiere modelo/deployment.')

  const url = anthropicMessagesUrl(provider.endpoint)
  const tools = anthropicTools(toolDefs)
  let messages: Array<{ role: string; content: unknown }> = [{ role: 'user', content: task }]
  let partialText = ''

  for (let turn = 0; turn < MAX_EXPLORE_LOOP; turn++) {
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
        max_tokens: 4096,
        system: explorationSystemPrompt(task),
        messages,
        tools
      })
    })
    if (!response.ok) throw new Error(`explore (Claude API) fallo ${response.status}: ${await readErrorBody(response)}`)

    const raw = await response.json() as unknown
    const record = asRecord(raw)
    const contentBlocks = Array.isArray(record.content) ? record.content as unknown[] : []
    const toolUses = contentBlocks.filter(block => asRecord(block).type === 'tool_use')
    partialText = collectText(record.content) || partialText

    if (toolUses.length === 0) {
      return (collectText(record.content) || collectText(raw)).trim() || 'La exploracion termino sin texto final.'
    }

    messages = [...messages, { role: 'assistant', content: contentBlocks }]
    const resultBlocks: unknown[] = []
    for (const use of toolUses) {
      const useRecord = asRecord(use)
      const toolName = asString(useRecord.name)
      const toolUseId = asString(useRecord.id)
      const result = await runReadOnlyTool(toolName, useRecord.input, runTool)
      resultBlocks.push({ type: 'tool_result', tool_use_id: toolUseId, content: result.output })
    }
    messages.push({ role: 'user', content: resultBlocks })
  }

  throw new Error(
    `explore alcanzo el limite de ${MAX_EXPLORE_LOOP} iteraciones sin resumen final. ` +
    `Ultimo texto parcial: ${partialText.trim().slice(0, 300) || '(ninguno)'}`
  )
}

/**
 * Punto de entrada unico, llamado desde ToolRegistry.execute() (caso
 * 'explore'). Lanza en cualquier fallo (API key faltante, HTTP, limite de
 * iteraciones) — el try/catch que YA envuelve todo execute() lo convierte
 * en un ToolExecutionResult {ok:false, output: mensaje} sin codigo
 * adicional aca: la tool "explore" nunca hace fallar el turno completo del
 * modelo caro, solo le devuelve un error legible (Tarea 3).
 */
export async function runExploreLoop(params: {
  task: string
  provider: ProviderProfile
  model: ModelProfile
  toolDefinitions: ToolDefinition[]
  runTool: (name: string, args: unknown) => Promise<ToolExecutionResult>
}): Promise<string> {
  const loopParams: LoopParams = {
    provider: params.provider,
    model: params.model,
    task: params.task,
    toolDefs: params.toolDefinitions,
    runTool: params.runTool
  }

  if (params.model.runtime === 'foundry') return exploreFoundry(loopParams)
  if (params.model.runtime === 'gemini-cli') return exploreGeminiApi(loopParams)
  return exploreAnthropicApi(loopParams)
}
