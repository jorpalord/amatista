import { EventEmitter } from 'node:events'
import { normalizeHistory } from './context-envelope'
import { TOOL_DEFINITIONS, type ToolDefinition, type ToolExecutionResult } from './tool-registry'
import type { ConversationMessage, ProviderProfile, RuntimeContextEnvelope, SandboxMode } from '../shared/types'

export type ApiAgentKind = 'foundry' | 'gemini-api' | 'anthropic-api'

export type ToolExecutor = (name: string, args: unknown) => Promise<ToolExecutionResult>

interface ConfigureOptions {
  kind: ApiAgentKind
  provider: ProviderProfile
  model: string
  workspace: string
  sandbox: SandboxMode
  toolsEnabled: boolean
  toolExecutor?: ToolExecutor
}

export interface ApiAgentResult {
  text: string
  raw?: unknown
}

// 8 se quedaba corto para tareas legitimas de generacion de codigo con
// varios archivos (visto: 7+ write_file consecutivos, todos exitosos,
// distintos archivos — no un loop, solo una tarea grande). Cada write_file
// requiere aprobacion del usuario, asi que un limite mas alto no significa
// "sin control" — el usuario sigue aprobando cada escritura una por una.
const MAX_TOOL_LOOP = 60
const DEBUG_TOOLS = process.env.AMATISTA_DEBUG_TOOLS === '1'
const FETCH_TIMEOUT_MS = 120000

/**
 * Se lanza cuando el usuario cancela el turno (boton Detener). Distinta de
 * un error real: el handler de agent:send en index.ts la reconoce y cierra
 * el turno limpio (sin marcar agentState como error), conservando el texto
 * parcial que se haya alcanzado a recibir antes de la cancelacion.
 */
export class TurnCancelledError extends Error {
  readonly partialText: string
  constructor(partialText: string) {
    super('Turno cancelado por el usuario.')
    this.name = 'TurnCancelledError'
    this.partialText = partialText
  }
}

/**
 * fetch() sin timeout se cuelga para siempre si el proveedor se estanca en
 * red (visto con Foundry/DeepSeek). Sin esto, el turno queda vivo en el
 * proceso main indefinidamente aunque el watchdog del renderer ya haya
 * avisado al usuario que algo salio mal. `externalSignal` es el AbortSignal
 * del turno completo (boton Detener) — se combina con el timeout interno.
 */
export async function fetchWithTimeout(url: string, init: RequestInit, externalSignal?: AbortSignal): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  const signal = externalSignal ? AbortSignal.any([controller.signal, externalSignal]) : controller.signal
  try {
    return await fetch(url, { ...init, signal })
  } catch (error) {
    if (externalSignal?.aborted) throw error // el llamador decide el mensaje (TurnCancelledError)
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error(`Tiempo de espera agotado (${FETCH_TIMEOUT_MS / 1000}s) esperando al proveedor.`)
    }
    throw error
  } finally {
    clearTimeout(timer)
  }
}

function debugToolTurn(kind: ApiAgentKind, turn: number, useTools: boolean, raw: unknown, callCount: number): void {
  if (!DEBUG_TOOLS) return
  console.log(
    `[apiRuntime:${kind}] turn=${turn} tools_enviadas=${useTools} tool_calls_detectados=${callCount} ` +
    `raw_keys=${Object.keys(asRecord(raw)).join(',')}`
  )
  if (useTools && callCount === 0) {
    console.log(`[apiRuntime:${kind}] raw completo (sin tool_call detectado):`, JSON.stringify(raw).slice(0, 4000))
  }
}

export function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : {}
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function asNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

/**
 * Extrae tokens totales del "usage" que cada proveedor devuelve al final de
 * CADA request (no hay streaming en ninguno de los 3 -> no hay conteo
 * incremental real dentro de un mismo request). En un turno con varias
 * vueltas de tool-calling si se puede acumular por vuelta, que es lo mas
 * cercano a "en vivo" que da la API sin migrar a SSE.
 */
function extractUsageTokens(kind: ApiAgentKind, record: Record<string, unknown>): number | undefined {
  if (kind === 'gemini-api') {
    const usage = asRecord(record.usageMetadata)
    const total = asNumber(usage.totalTokenCount)
    if (total) return total
    const prompt = asNumber(usage.promptTokenCount)
    const candidates = asNumber(usage.candidatesTokenCount)
    return prompt || candidates ? prompt + candidates : undefined
  }

  const usage = asRecord(record.usage)
  const total = asNumber(usage.total_tokens)
  if (total) return total
  const input = asNumber(usage.input_tokens)
  const output = asNumber(usage.output_tokens)
  return input || output ? input + output : undefined
}

function safeJsonParse(value: string): unknown {
  if (!value.trim()) return {}
  try {
    return JSON.parse(value)
  } catch {
    return {}
  }
}

export function collectText(value: unknown, depth = 0): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value
  if (depth > 12) return ''
  if (Array.isArray(value)) {
    return value.map(item => collectText(item, depth + 1)).filter(Boolean).join('')
  }

  const record = asRecord(value)
  const direct =
    asString(record.text) ||
    asString(record.output_text) ||
    asString(record.response) ||
    asString(record.content)

  if (direct) return direct

  const nested = [record.parts, record.content, record.message, record.output, record.candidates]
    .filter(item => item !== undefined && item !== null)
  if (nested.length === 0) return ''

  return nested.map(item => collectText(item, depth + 1)).filter(Boolean).join('')
}

function textWithAttachments(text: string, context?: RuntimeContextEnvelope): string {
  if (!context?.attachments?.length) return text
  const attachments = context.attachments.map(attachment => [
    `Archivo: ${attachment.name}`,
    `Tipo: ${attachment.kind} / ${attachment.mimeType}`,
    `Ruta: ${attachment.path}`,
    attachment.text ? `Contenido:\n${attachment.text}` : ''
  ].filter(Boolean).join('\n')).join('\n\n')
  return `${text}\n\nArchivos adjuntos:\n${attachments}`
}

export function normalizeFoundryBaseUrl(endpoint?: string): string {
  const clean = (endpoint ?? '').trim().replace(/\/+$/, '')
  if (!clean) throw new Error('Foundry requiere endpoint.')
  if (clean.endsWith('/openai/v1')) return clean
  if (clean.endsWith('/v1')) return clean
  if (clean.endsWith('/openai')) return `${clean}/v1`
  return `${clean}/openai/v1`
}

export function normalizeGeminiBaseUrl(endpoint?: string): string {
  const clean = (endpoint ?? '').trim().replace(/\/+$/, '')
  return clean || 'https://generativelanguage.googleapis.com/v1beta'
}

export function normalizeGeminiModel(model: string): string {
  const clean = model.trim() || 'gemini-2.5-pro'
  return clean.startsWith('models/') ? clean.slice('models/'.length) : clean
}

export function encodeModelPath(model: string): string {
  return model.split('/').map(encodeURIComponent).join('/')
}

export function anthropicMessagesUrl(endpoint?: string): string {
  const clean = (endpoint ?? '').trim().replace(/\/+$/, '')
  if (!clean) throw new Error('Claude API requiere endpoint.')
  if (clean.endsWith('/messages')) return clean
  if (clean.endsWith('/v1')) return `${clean}/messages`
  return `${clean}/v1/messages`
}

export async function readErrorBody(response: Response): Promise<string> {
  try {
    const parsed = await response.clone().json() as unknown
    const record = asRecord(parsed)
    const error = asRecord(record.error)
    return asString(error.message) || JSON.stringify(parsed).slice(0, 1200)
  } catch {
    return (await response.text()).slice(0, 1200)
  }
}

// Parametrizadas por `defs` (Fase 4) en vez de cerrar siempre sobre
// TOOL_DEFINITIONS completo: explore-tool.ts las reusa con el subconjunto
// de solo-lectura en vez de reimplementar el mismo mapeo una tercera vez.
// Los tres call sites de abajo (sendFoundry/sendGeminiApi/sendAnthropicApi)
// siguen pasando TOOL_DEFINITIONS explicitamente — mismo comportamiento
// que antes, sin cambios para el runtime principal.
export function foundryTools(defs: ToolDefinition[]): unknown[] {
  return defs.map(def => ({
    type: 'function',
    name: def.name,
    description: def.description,
    parameters: def.parameters
  }))
}

export function anthropicTools(defs: ToolDefinition[]): unknown[] {
  return defs.map(def => ({
    name: def.name,
    description: def.description,
    input_schema: def.parameters
  }))
}

export function geminiFunctionDeclarations(defs: ToolDefinition[]): unknown[] {
  return defs.map(def => ({
    name: def.name,
    description: def.description,
    parameters: def.parameters
  }))
}

export class ApiAgentRuntime extends EventEmitter {
  private config: ConfigureOptions | null = null
  private turnTokens = 0
  private toolCallLog: Array<{ turn: number; name: string; argsPreview: string; resultPreview: string }> = []

  configure(options: ConfigureOptions): void {
    this.config = options
  }

  async send(text: string, context?: RuntimeContextEnvelope, signal?: AbortSignal): Promise<ApiAgentResult> {
    if (!this.config) throw new Error('Runtime API no configurado.')
    this.turnTokens = 0
    this.toolCallLog = []
    const turnSignal = signal ?? new AbortController().signal
    if (this.config.kind === 'foundry') return this.sendFoundry(text, context, turnSignal)
    if (this.config.kind === 'anthropic-api') return this.sendAnthropicApi(text, context, turnSignal)
    return this.sendGeminiApi(text, context, turnSignal)
  }

  /** Acumula el usage de esta vuelta del loop y avisa al renderer. */
  private reportUsage(kind: ApiAgentKind, record: Record<string, unknown>): void {
    const tokens = extractUsageTokens(kind, record)
    if (tokens === undefined) return
    this.turnTokens += tokens
    this.emit('usage', { tokens: this.turnTokens })
  }

  private toolsActive(): boolean {
    return Boolean(this.config?.toolsEnabled && this.config?.toolExecutor)
  }

  private logToolCall(turn: number, name: string, args: unknown, result: ToolExecutionResult): void {
    const argsPreview = JSON.stringify(args).slice(0, 300)
    const resultPreview = `${result.ok ? 'OK' : 'FALLO'}: ${result.output.slice(0, 300)}`
    this.toolCallLog.push({ turn, name, argsPreview, resultPreview })
    if (DEBUG_TOOLS) {
      console.log(`[apiRuntime] turn=${turn} tool=${name} args=${argsPreview}`)
      console.log(`[apiRuntime] turn=${turn} tool=${name} resultado -> ${resultPreview}`)
    }
  }

  /** Ultimas llamadas de tool ejecutadas en este turno, para dar contexto si el loop se corta. */
  private recentToolCallsSummary(count = 3): string {
    if (this.toolCallLog.length === 0) return 'No se ejecuto ninguna tool en este turno.'
    return this.toolCallLog
      .slice(-count)
      .map(entry => `  - [turno ${entry.turn}] ${entry.name}(${entry.argsPreview}) -> ${entry.resultPreview}`)
      .join('\n')
  }

  private async runTool(turn: number, name: string, args: unknown): Promise<ToolExecutionResult> {
    const workspace = this.config?.workspace ?? ''
    this.emit('toolStatus', { name, phase: 'start', workspace })
    if (!this.config?.toolExecutor) {
      const result = { ok: false, output: 'Tool runtime no disponible.' }
      this.emit('toolStatus', { name, phase: 'done', ok: false, workspace, detail: result.output.slice(0, 200) })
      this.logToolCall(turn, name, args, result)
      return result
    }
    try {
      const result = await this.config.toolExecutor(name, args)
      // detail: motivo real del fallo, no solo "fallo" — sin esto la unica
      // pista que le llegaba al usuario era el nombre de la tool, y el
      // porque real (rechazo, ruta invalida, timeout, etc.) quedaba
      // enterrado en el tool_result que solo ve el modelo.
      this.emit('toolStatus', { name, phase: 'done', ok: result.ok, workspace, detail: result.ok ? undefined : result.output.slice(0, 200) })
      this.logToolCall(turn, name, args, result)
      return result
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      const result = { ok: false, output: detail }
      this.emit('toolStatus', { name, phase: 'done', ok: false, workspace, detail: detail.slice(0, 200) })
      this.logToolCall(turn, name, args, result)
      return result
    }
  }

  /**
   * Foundry y Gemini (a diferencia de sendAnthropicApi) no leian
   * context.compactSummary en absoluto — el campo se calculaba pero se
   * descartaba en silencio para estos dos runtimes (hallazgo de Fase 3 al
   * conectar el resumen persistido: alcance de esta fase incluye
   * explicitamente foundry y gemini-api, asi que este era un vacio real,
   * no solo el de App.tsx documentado en Fase 1 Tarea C). Se inyecta como
   * primer turno "user" con el mismo tag [system] que ya usa el resto de
   * este archivo para foldear system-role dentro del historial (ninguno de
   * los dos runtimes usa un campo `system`/`instructions` nativo en este
   * codebase todavia).
   */
  private foundryInputArray(text: string, context?: RuntimeContextEnvelope): unknown[] {
    const currentText = textWithAttachments(text, context)
    const messages = context ? normalizeHistory(context.history) : []
    const summaryTurn = context?.compactSummary
      ? [{ role: 'user', content: `[system] Resumen acumulado de AMATISTA:\n${context.compactSummary}` }]
      : []
    return [
      ...summaryTurn,
      ...messages.map(message => ({
        role: message.role === 'assistant' ? 'assistant' : 'user',
        content: message.role === 'system' ? `[system] ${message.text}` : message.text
      })),
      { role: 'user', content: currentText }
    ]
  }

  private geminiContents(text: string, context?: RuntimeContextEnvelope): unknown[] {
    const messages = context ? normalizeHistory(context.history) : []
    const summaryTurn = context?.compactSummary
      ? [{ role: 'user', parts: [{ text: `[system] Resumen acumulado de AMATISTA:\n${context.compactSummary}` }] }]
      : []
    return [
      ...summaryTurn,
      ...messages.map(message => ({
        role: message.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: message.role === 'system' ? `[system] ${message.text}` : message.text }]
      })),
      { role: 'user', parts: [{ text: textWithAttachments(text, context) }] }
    ]
  }

  private anthropicMessages(text: string, context?: RuntimeContextEnvelope): ConversationMessage[] {
    const messages = context ? normalizeHistory(context.history) : []
    return [
      ...messages.map(message => ({
        role: message.role === 'assistant' ? 'assistant' as const : 'user' as const,
        text: message.role === 'system' ? `[system] ${message.text}` : message.text
      })),
      { role: 'user', text: textWithAttachments(text, context) }
    ]
  }

  private async sendFoundry(text: string, context: RuntimeContextEnvelope | undefined, signal: AbortSignal): Promise<ApiAgentResult> {
    if (!this.config) throw new Error('Foundry runtime no configurado.')
    const provider = this.config.provider
    const apiKey = provider.apiKey?.trim()
    const model = this.config.model.trim()
    if (!apiKey) throw new Error('Foundry requiere API key.')
    if (!model) throw new Error('Foundry requiere deployment/modelo.')

    const baseUrl = normalizeFoundryBaseUrl(provider.endpoint)
    const useTools = this.toolsActive()
    let input = this.foundryInputArray(text, context)
    let partialText = ''

    for (let turn = 0; turn < MAX_TOOL_LOOP; turn++) {
      if (signal.aborted) throw new TurnCancelledError(partialText)

      let response: Response
      try {
        response = await fetchWithTimeout(`${baseUrl}/responses`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'api-key': apiKey
          },
          body: JSON.stringify({ model, input, ...(useTools ? { tools: foundryTools(TOOL_DEFINITIONS) } : {}) })
        }, signal)
      } catch (error) {
        if (signal.aborted) throw new TurnCancelledError(partialText)
        throw error
      }

      if (!response.ok) {
        throw new Error(`Foundry /responses fallo ${response.status}: ${await readErrorBody(response)}`)
      }

      const raw = await response.json() as unknown
      const record = asRecord(raw)
      this.reportUsage('foundry', record)
      const outputItems = Array.isArray(record.output) ? record.output as unknown[] : []
      const calls = useTools ? outputItems.filter(item => asRecord(item).type === 'function_call') : []
      debugToolTurn('foundry', turn, useTools, raw, calls.length)
      partialText = collectText(record.output) || partialText

      if (calls.length === 0) {
        const output = collectText(record.output) || collectText(raw)
        return { text: output.trim() || 'Foundry completo el turno sin texto final.', raw }
      }

      input = [...input, ...outputItems]
      for (const call of calls) {
        if (signal.aborted) throw new TurnCancelledError(partialText)
        const callRecord = asRecord(call)
        const callId = asString(callRecord.call_id) || asString(callRecord.id)
        const toolName = asString(callRecord.name)
        const args = safeJsonParse(asString(callRecord.arguments))
        const result = await this.runTool(turn, toolName, args)
        if (signal.aborted) throw new TurnCancelledError(partialText)
        input.push({ type: 'function_call_output', call_id: callId, output: result.output })
      }
    }

    throw new Error(
      `Se alcanzo el limite de ${MAX_TOOL_LOOP} iteraciones de tool calling sin respuesta final.\n` +
      `Ultimas tool calls de este turno:\n${this.recentToolCallsSummary()}`
    )
  }

  private async sendGeminiApi(text: string, context: RuntimeContextEnvelope | undefined, signal: AbortSignal): Promise<ApiAgentResult> {
    if (!this.config) throw new Error('Gemini API runtime no configurado.')
    const provider = this.config.provider
    const apiKey = provider.apiKey?.trim()
    if (!apiKey) throw new Error('Gemini API requiere API key.')

    const model = encodeModelPath(normalizeGeminiModel(this.config.model))
    const url = `${normalizeGeminiBaseUrl(provider.endpoint)}/models/${model}:generateContent`
    const useTools = this.toolsActive()
    let contents = this.geminiContents(text, context)
    let partialText = ''

    for (let turn = 0; turn < MAX_TOOL_LOOP; turn++) {
      if (signal.aborted) throw new TurnCancelledError(partialText)

      let response: Response
      try {
        response = await fetchWithTimeout(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-goog-api-key': apiKey
          },
          body: JSON.stringify({
            contents,
            ...(useTools ? { tools: [{ functionDeclarations: geminiFunctionDeclarations(TOOL_DEFINITIONS) }] } : {})
          })
        }, signal)
      } catch (error) {
        if (signal.aborted) throw new TurnCancelledError(partialText)
        throw error
      }

      if (!response.ok) {
        throw new Error(`Gemini API generateContent fallo ${response.status}: ${await readErrorBody(response)}`)
      }

      const raw = await response.json() as unknown
      const record = asRecord(raw)
      this.reportUsage('gemini-api', record)
      const candidates = Array.isArray(record.candidates) ? record.candidates as unknown[] : []
      const candidateContent = asRecord(asRecord(candidates[0]).content)
      const parts = Array.isArray(candidateContent.parts) ? candidateContent.parts as unknown[] : []
      const functionCalls = useTools ? parts.filter(part => asRecord(part).functionCall) : []
      debugToolTurn('gemini-api', turn, useTools, raw, functionCalls.length)
      partialText = collectText(record.candidates) || partialText

      if (functionCalls.length === 0) {
        const output = collectText(record.candidates) || collectText(raw)
        return { text: output.trim() || 'Gemini API completo el turno sin texto final.', raw }
      }

      contents = [...contents, { role: 'model', parts }]
      const responseParts: unknown[] = []
      for (const call of functionCalls) {
        if (signal.aborted) throw new TurnCancelledError(partialText)
        const callRecord = asRecord(asRecord(call).functionCall)
        const toolName = asString(callRecord.name)
        const result = await this.runTool(turn, toolName, callRecord.args)
        if (signal.aborted) throw new TurnCancelledError(partialText)
        responseParts.push({ functionResponse: { name: toolName, response: { content: result.output } } })
      }
      contents.push({ role: 'function', parts: responseParts })
    }

    throw new Error(
      `Se alcanzo el limite de ${MAX_TOOL_LOOP} iteraciones de tool calling sin respuesta final.\n` +
      `Ultimas tool calls de este turno:\n${this.recentToolCallsSummary()}`
    )
  }

  private async sendAnthropicApi(text: string, context: RuntimeContextEnvelope | undefined, signal: AbortSignal): Promise<ApiAgentResult> {
    if (!this.config) throw new Error('Claude API runtime no configurado.')
    const provider = this.config.provider
    const apiKey = provider.apiKey?.trim()
    const model = this.config.model.trim()
    if (!apiKey) throw new Error('Claude API requiere API key.')
    if (!model) throw new Error('Claude API requiere modelo/deployment.')

    const url = anthropicMessagesUrl(provider.endpoint)
    const useTools = this.toolsActive()
    const system = context?.compactSummary
      ? `Resumen acumulado de AMATISTA:\n${context.compactSummary}`
      : undefined
    let messages: Array<{ role: string; content: unknown }> =
      this.anthropicMessages(text, context).map(message => ({ role: message.role, content: message.text }))
    let partialText = ''

    for (let turn = 0; turn < MAX_TOOL_LOOP; turn++) {
      if (signal.aborted) throw new TurnCancelledError(partialText)

      let response: Response
      try {
        response = await fetchWithTimeout(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': apiKey,
            'api-key': apiKey,
            'anthropic-version': '2023-06-01'
          },
          body: JSON.stringify({
            model,
            // 4096 se quedaba corto para write_file de archivos largos (un
            // .cs de 300+ lineas facil pasa los 4096 tokens de salida solo
            // en el campo "content" de la tool call) — el modelo se corta a
            // mitad del JSON de la llamada, la tool call queda invalida, y
            // el modelo (viendolo como "la tool fallo") termina pegando el
            // contenido como texto plano en el chat en vez de reintentar.
            max_tokens: 8192,
            system,
            messages,
            ...(useTools ? { tools: anthropicTools(TOOL_DEFINITIONS) } : {})
          })
        }, signal)
      } catch (error) {
        if (signal.aborted) throw new TurnCancelledError(partialText)
        throw error
      }

      if (!response.ok) {
        throw new Error(`Claude API /messages fallo ${response.status}: ${await readErrorBody(response)}`)
      }

      const raw = await response.json() as unknown
      const record = asRecord(raw)
      this.reportUsage('anthropic-api', record)
      const contentBlocks = Array.isArray(record.content) ? record.content as unknown[] : []
      const toolUses = useTools ? contentBlocks.filter(block => asRecord(block).type === 'tool_use') : []
      debugToolTurn('anthropic-api', turn, useTools, raw, toolUses.length)
      partialText = collectText(record.content) || partialText

      if (toolUses.length === 0) {
        const output = collectText(record.content) || collectText(raw)
        return { text: output.trim() || 'Claude API completo el turno sin texto final.', raw }
      }

      messages = [...messages, { role: 'assistant', content: contentBlocks }]
      const resultBlocks: unknown[] = []
      for (const use of toolUses) {
        if (signal.aborted) throw new TurnCancelledError(partialText)
        const useRecord = asRecord(use)
        const toolName = asString(useRecord.name)
        const toolUseId = asString(useRecord.id)
        const result = await this.runTool(turn, toolName, useRecord.input)
        if (signal.aborted) throw new TurnCancelledError(partialText)
        resultBlocks.push({ type: 'tool_result', tool_use_id: toolUseId, content: result.output })
      }
      messages.push({ role: 'user', content: resultBlocks })
    }

    throw new Error(
      `Se alcanzo el limite de ${MAX_TOOL_LOOP} iteraciones de tool calling sin respuesta final.\n` +
      `Ultimas tool calls de este turno:\n${this.recentToolCallsSummary()}`
    )
  }

  stop(): void {
    this.removeAllListeners()
  }
}
