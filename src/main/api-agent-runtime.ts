import { EventEmitter } from 'node:events'
import { normalizeHistory } from './context-envelope'
import { readOnlyBlockedMessage, resolveApproval, TOOL_DEFINITIONS, type ToolDefinition, type ToolExecutionResult } from './tool-registry'
import type { McpManager } from './mcp-client'
import type { ConversationMessage, ProviderProfile, RuntimeContextEnvelope, SandboxMode } from '../shared/types'

export type ApiAgentKind = 'foundry' | 'gemini-api' | 'anthropic-api' | 'openai-chat'

export type ToolExecutor = (name: string, args: unknown) => Promise<ToolExecutionResult>

/**
 * Fase 10: mismo literal que MCP_TOOL_PREFIX en mcp-client.ts — duplicado
 * a proposito en vez de importarlo (McpManager solo se importa `import
 * type` aca, un import de VALOR ademas crearia un ciclo real entre este
 * archivo y mcp-client.ts por algo tan chico como un prefijo de string).
 * Comentado en ambos lugares para que no diverjan en silencio.
 */
const MCP_TOOL_PREFIX = 'mcp__'

interface ConfigureOptions {
  kind: ApiAgentKind
  provider: ProviderProfile
  model: string
  /** Techo de tokens de salida configurado en Settings para ESTE modelo
   *  (`ModelProfile.maxOutputTokens`, shared/types.ts). undefined = usar el
   *  default generoso por proveedor, ver resolveMaxOutputTokens(). */
  maxOutputTokens?: number
  workspace: string
  sandbox: SandboxMode
  toolsEnabled: boolean
  toolExecutor?: ToolExecutor
  /** Fase 10 — servidores MCP ya arrancados para esta conexion (solo
   *  runtimes API), o undefined si no aplica (runtime CLI, o sin .mcp.json
   *  en el workspace). */
  mcpManager?: McpManager
  /** Catalogo de tools MCP ya descubiertas y namespaced (mcp__servidor__tool),
   *  sumado a TOOL_DEFINITIONS al armar el array que se manda al proveedor. */
  mcpToolDefinitions?: ToolDefinition[]
  /** Mismo mecanismo de aprobacion que ya usa ToolRegistry (ConfirmFn) —
   *  TODA tool call MCP pasa por aca antes de ejecutarse, sin excepcion:
   *  a diferencia de git_status/git_diff, no hay forma de saber de
   *  antemano si una tool MCP externa es de solo lectura o no. */
  mcpConfirm?: (title: string, detail: string) => Promise<boolean>
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
 * Defaults GENEROSOS de tokens de salida por proveedor, usados solo cuando
 * `ModelProfile.maxOutputTokens` no esta configurado (undefined = "usa lo
 * mas alto que el proveedor documenta", no "usa un numero chico seguro").
 * Gemini y Foundry: mejor evidencia disponible al escribir esto, NO
 * verificados contra cada deployment especifico (son endpoints arbitrarios
 * configurados por el usuario) — si un deployment puntual rechaza la
 * llamada por pedir mas de lo que soporta, la salida es configurar
 * `maxOutputTokens` mas bajo para ESE modelo en Settings, no bajar el
 * default global.
 *
 * - Gemini API: 65536 — techo documentado de `generationConfig.maxOutputTokens`
 *   para Gemini 2.5 Pro/Flash (generateContent).
 * - Foundry (Azure OpenAI Responses API, `max_output_tokens`): 128000 —
 *   techo tecnico general documentado para modelos con ventana de 128k
 *   (familia GPT-4.1/GPT-5 de Azure). Los deployments q-assistant que este
 *   codebase sugiere (FOUNDRY_Q_ASSISTANT_DEPLOYMENTS, settings-provisioning.ts)
 *   no tienen un techo real verificado por nombre puntual.
 * - OpenRouter/Chat-Completions (Fase 15, `max_tokens`): 128000 — mismo
 *   default que Foundry, a falta de un techo unico real: este runtime es
 *   generico para CUALQUIER modelo servido via OpenRouter (o cualquier
 *   backend Chat-Completions-compatible con endpoint editable), cada uno
 *   con su propio limite real de output (ej. el modelo stealth `ox-alpha`
 *   que motivo esta fase documenta 131072 — ver docs/_arch/CONTRACT.md).
 *   128000 es un piso generoso razonable sin ser el techo exacto de
 *   ningun modelo puntual; si uno rechaza la llamada, la salida es bajar
 *   `maxOutputTokens` para ESE modelo en Settings, mismo criterio que ya
 *   aplica a Foundry/Gemini.
 *
 * Anthropic NO tiene un default unico: `anthropic-api` sirve tanto a Claude
 * real como a DeepSeek (mismo endpoint /v1/messages, ver
 * anthropicMessagesUrl), y sus techos reales de salida son muy distintos —
 * ver anthropicMaxOutputTokensDefault() mas abajo.
 */
const GEMINI_MAX_OUTPUT_TOKENS_DEFAULT = 65536
const FOUNDRY_MAX_OUTPUT_TOKENS_DEFAULT = 128000
const OPENAI_API_MAX_OUTPUT_TOKENS_DEFAULT = 128000

export type OutputTokenProviderKind = 'foundry' | 'gemini' | 'anthropic' | 'openai'

/**
 * Default de Anthropic por MODELO, no por runtime — valores CONFIRMADOS por
 * el arquitecto (no estimados por este codebase), ver
 * docs/_arch/CONTRACT.md → "Contrato de memoria/contexto":
 * - DeepSeek V4 Pro / V4 Flash (via endpoint Anthropic-compatible): 384000.
 * - Claude Haiku 4.5: 64000.
 * - Claude Opus 5 / Sonnet 5 (resto de Claude no-Haiku), y cualquier modelo
 *   no reconocido por el nombre: 128000 — mejor pecar de generoso con un
 *   modelo no reconocido que capar a la mitad un Opus/Sonnet real.
 */
function anthropicMaxOutputTokensDefault(modelId: string): number {
  const value = modelId.toLowerCase()
  if (value.includes('deepseek')) return 384000
  if (value.includes('haiku')) return 64000
  return 128000
}

/**
 * `configuredOverride` (ModelProfile.maxOutputTokens) gana si esta seteado
 * y es > 0; si no, el default generoso del proveedor de arriba. `modelId`
 * solo se usa (y solo hace falta pasarlo) para `kind === 'anthropic'` — sin
 * el, cae al bucket "no reconocido" de anthropicMaxOutputTokensDefault
 * (128000), nunca al de Haiku.
 */
export function resolveMaxOutputTokens(
  configuredOverride: number | undefined,
  kind: OutputTokenProviderKind,
  modelId?: string
): number {
  if (typeof configuredOverride === 'number' && configuredOverride > 0) return configuredOverride
  if (kind === 'foundry') return FOUNDRY_MAX_OUTPUT_TOKENS_DEFAULT
  if (kind === 'gemini') return GEMINI_MAX_OUTPUT_TOKENS_DEFAULT
  if (kind === 'openai') return OPENAI_API_MAX_OUTPUT_TOKENS_DEFAULT
  return anthropicMaxOutputTokensDefault(modelId ?? '')
}

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

/**
 * Bloque de memoria (Fase 6 + Fase 7, agrupado por tema desde Fase 11):
 * AGENTS.md + memoria estructurada por tema + el resumen narrativo, todo
 * junto en un solo texto — misma composicion y mismo orden que
 * formatContextEnvelope() en context-envelope.ts (AGENTS.md primero,
 * memoria por tema despues, resumen al final), pero construido aca porque
 * sendFoundry/sendGeminiApi/sendAnthropicApi/sendOpenAiApi (Fase 15) NO
 * pasan por formatContextEnvelope — arman su propio payload directo (ver
 * comentario en foundryInputArray/geminiContents/openAiMessages mas
 * abajo). Sin esto, la extraccion
 * estructurada de Fase 6 y el AGENTS.md de Fase 7 solo llegarian al runtime
 * CLI (unico consumidor real de formatContextEnvelope) y nunca a los
 * runtimes API, que son justo donde corre la compactacion (Fase 3/6/11) y
 * donde AGENTS.md hace mas falta (los 3 son HTTP puro, ningun CLI externo
 * que lo lea solo). '' si no hay nada que inyectar.
 */
function memoryBlockText(context?: RuntimeContextEnvelope): string {
  if (!context) return ''
  const agentsMd = context.agentsMd?.trim()
  const topics = context.topics ?? {}
  const topicNames = Object.keys(topics)
  const summary = context.compactSummary?.trim()

  const parts: string[] = []
  if (agentsMd) {
    parts.push('AGENTS.md del proyecto (instrucciones del repositorio, no de esta conversacion):')
    parts.push(agentsMd)
  }
  if (topicNames.length > 0) {
    parts.push('Memoria por tema:')
    for (const topicName of topicNames) {
      const topic = topics[topicName]
      const decisions = topic.decisions.map(item => item.trim()).filter(Boolean)
      const constraints = topic.constraints.map(item => item.trim()).filter(Boolean)
      const nextSteps = topic.nextSteps.map(item => item.trim()).filter(Boolean)
      if (decisions.length === 0 && constraints.length === 0 && nextSteps.length === 0) continue
      parts.push(`## ${topicName}`)
      for (const decision of decisions) parts.push(`- [decision] ${decision}`)
      for (const constraint of constraints) parts.push(`- [restriccion] ${constraint}`)
      for (const step of nextSteps) parts.push(`- [proximo paso] ${step}`)
    }
  }
  if (summary) {
    parts.push('Resumen acumulado de AMATISTA:')
    parts.push(summary)
  }
  return parts.join('\n')
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

/**
 * Fase 15: URL de Chat Completions estilo OpenAI — mismo criterio de
 * normalizacion que anthropicMessagesUrl()/normalizeFoundryBaseUrl() de
 * mas abajo (tolera que el endpoint ya venga con /chat/completions o /v1
 * puestos, o ninguno de los dos). Default real de OpenRouter
 * (`https://openrouter.ai/api/v1`) lo pone newProvider() en App.tsx, pero
 * el endpoint queda editable — este runtime sirve a CUALQUIER backend
 * Chat-Completions-compatible, no solo OpenRouter.
 */
export function openAiChatCompletionsUrl(endpoint?: string): string {
  const clean = (endpoint ?? '').trim().replace(/\/+$/, '')
  if (!clean) throw new Error('Requiere endpoint.')
  if (clean.endsWith('/chat/completions')) return clean
  if (clean.endsWith('/v1')) return `${clean}/chat/completions`
  return `${clean}/v1/chat/completions`
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

/** Fase 15: forma real de "tools" en Chat Completions estilo OpenAI —
 *  cada tool envuelta en {type:'function', function:{...}}, a diferencia
 *  de foundryTools/geminiFunctionDeclarations que van "planas". */
export function openAiTools(defs: ToolDefinition[]): unknown[] {
  return defs.map(def => ({
    type: 'function',
    function: {
      name: def.name,
      description: def.description,
      parameters: def.parameters
    }
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
    if (this.config.kind === 'openai-chat') return this.sendOpenAiApi(text, context, turnSignal)
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

  /** Fase 10 (Tarea 3): las 10 tools built-in + las tools MCP descubiertas
   *  para esta conexion (namespaced mcp__servidor__tool, ya en forma de
   *  ToolDefinition — ver McpManager.listToolDefinitions()). Un solo punto
   *  de union, usado en los 3 send* de mas abajo en vez de repetir el
   *  spread tres veces. */
  private toolCatalog(): ToolDefinition[] {
    return [...TOOL_DEFINITIONS, ...(this.config?.mcpToolDefinitions ?? [])]
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

  /**
   * Fase 10: punto de enganche elegido para el dispatch de tools MCP —
   * ACA, no dentro de ToolRegistry.execute(). Dos razones concretas:
   * (1) ToolRegistry ya la reusa explore-tool.ts con su propio whitelist
   *     de solo-lectura (read_file/list_dir/git_status/git_diff); meter
   *     dispatch MCP en el switch de execute() significaria que ese
   *     modulo tendria que saber de la existencia de servidores MCP
   *     arbitrarios solo para NO exponerlos a explore, en vez de que el
   *     alcance de explore siga siendo, como hoy, "las tools que
   *     explore-tool.ts le pasa expresamente en su propio catalogo
   *     filtrado" — cero cambio ahi.
   * (2) runTool() es el UNICO punto por el que pasan las 3 llamadas API
   *     (foundry/gemini/anthropic) antes de invocar cualquier tool —
   *     coincide exactamente con donde ya vive toolStatus/logToolCall,
   *     asi que el dispatch MCP hereda gratis la misma UX (estado en
   *     vivo, log de la tool call) sin duplicar ese cableado.
   * ToolRegistry.execute() queda intacto: sigue siendo, exclusivamente,
   * el registro de las 10 tools propias de AMATISTA.
   */
  private async runTool(turn: number, name: string, args: unknown): Promise<ToolExecutionResult> {
    const workspace = this.config?.workspace ?? ''
    this.emit('toolStatus', { name, phase: 'start', workspace })

    // detail: motivo real del fallo, no solo "fallo" — sin esto la unica
    // pista que le llegaba al usuario era el nombre de la tool, y el
    // porque real (rechazo, ruta invalida, timeout, etc.) quedaba
    // enterrado en el tool_result que solo ve el modelo.
    const finish = (result: ToolExecutionResult): ToolExecutionResult => {
      this.emit('toolStatus', { name, phase: 'done', ok: result.ok, workspace, detail: result.ok ? undefined : result.output.slice(0, 200) })
      this.logToolCall(turn, name, args, result)
      return result
    }

    if (name.startsWith(MCP_TOOL_PREFIX)) {
      if (!this.config?.mcpManager) {
        return finish({ ok: false, output: `Tool MCP "${name}" no disponible en este contexto de ejecucion.` })
      }
      try {
        // Aprobacion SIEMPRE consultada (a diferencia de git_status/
        // git_diff, que Amatista SI sabe que son de solo lectura porque
        // los definio ella misma) — una tool MCP externa puede hacer
        // cualquier cosa del lado del servidor, no hay forma de inferir
        // de antemano si es segura. Fase 12: mismo gate de sandbox que las
        // 4 acciones sensibles de tool-registry.ts, via resolveApproval()
        // — antes este dispatch ignoraba el sandbox mode por completo (ver
        // docs/_arch/CONTRACT.md → "Sandbox mode no aplicado en runtimes
        // API (Fase 12)"), asi que 'danger-full-access' no salteaba nada
        // (bug) y 'read-only' igual mostraba el dialogo (bug, aunque el
        // usuario podia rechazarlo a mano).
        const approved = await resolveApproval(
          this.config.sandbox,
          this.config.mcpConfirm ?? (async () => false),
          `Ejecutar tool MCP: ${name}`,
          JSON.stringify(args, null, 2)
        )
        if (!approved) {
          return finish({
            ok: false,
            output: this.config.sandbox === 'read-only'
              ? readOnlyBlockedMessage('ejecutar tools MCP')
              : 'El usuario rechazo la ejecucion de esta tool MCP.'
          })
        }
        return finish(await this.config.mcpManager.callTool(name, args))
      } catch (error) {
        return finish({ ok: false, output: error instanceof Error ? error.message : String(error) })
      }
    }

    if (!this.config?.toolExecutor) {
      return finish({ ok: false, output: 'Tool runtime no disponible.' })
    }
    try {
      return finish(await this.config.toolExecutor(name, args))
    } catch (error) {
      return finish({ ok: false, output: error instanceof Error ? error.message : String(error) })
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
   * codebase todavia). Desde Fase 6, memoryBlockText() suma tambien
   * decisions/constraints/nextSteps al mismo bloque — mismo mecanismo,
   * un solo texto, no un turno adicional por cada campo.
   */
  private foundryInputArray(text: string, context?: RuntimeContextEnvelope): unknown[] {
    const currentText = textWithAttachments(text, context)
    const messages = context ? normalizeHistory(context.history) : []
    const memoryText = memoryBlockText(context)
    const summaryTurn = memoryText
      ? [{ role: 'user', content: `[system] ${memoryText}` }]
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
    const memoryText = memoryBlockText(context)
    const summaryTurn = memoryText
      ? [{ role: 'user', parts: [{ text: `[system] ${memoryText}` }] }]
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

  /**
   * Fase 15: a diferencia de foundryInputArray/geminiContents (que foldean
   * la memoria como un turno "user" con tag [system], por no tener un rol
   * nativo probado en este codebase), Chat Completions SI tiene un rol
   * "system" real y de primera clase — se usa tal cual, sin el hack de
   * tag. Mensajes de historial con role:'system' (poco frecuente, ej.
   * avisos inyectados) tambien mapean directo a role:'system'.
   */
  private openAiMessages(text: string, context?: RuntimeContextEnvelope): unknown[] {
    const messages = context ? normalizeHistory(context.history) : []
    const memoryText = memoryBlockText(context)
    const systemTurn = memoryText ? [{ role: 'system', content: memoryText }] : []
    return [
      ...systemTurn,
      ...messages.map(message => ({ role: message.role, content: message.text })),
      { role: 'user', content: textWithAttachments(text, context) }
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
          body: JSON.stringify({
            model,
            input,
            max_output_tokens: resolveMaxOutputTokens(this.config.maxOutputTokens, 'foundry'),
            ...(useTools ? { tools: foundryTools(this.toolCatalog()) } : {})
          })
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
            generationConfig: { maxOutputTokens: resolveMaxOutputTokens(this.config.maxOutputTokens, 'gemini') },
            ...(useTools ? { tools: [{ functionDeclarations: geminiFunctionDeclarations(this.toolCatalog()) }] } : {})
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
    const system = memoryBlockText(context) || undefined
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
            // Origen historico de este limite: 4096 se quedaba corto para
            // write_file de archivos largos (un .cs de 300+ lineas facil
            // pasa los 4096 tokens de salida solo en el campo "content" de
            // la tool call) — el modelo se corta a mitad del JSON de la
            // llamada, la tool call queda invalida, y el modelo (viendolo
            // como "la tool fallo") termina pegando el contenido como texto
            // plano en el chat en vez de reintentar. Con apply_patch (Fase
            // 5) ese caso especifico es menos frecuente (ediciones puntuales
            // ya no regeneran el archivo entero), pero el limite fijo de
            // 8192 seguia siendo un techo chico "por las dudas" en vez del
            // techo real del proveedor — reemplazado por
            // resolveMaxOutputTokens() (configurable por modelo, default
            // generoso si no se configura).
            max_tokens: resolveMaxOutputTokens(this.config.maxOutputTokens, 'anthropic', model),
            system,
            messages,
            ...(useTools ? { tools: anthropicTools(this.toolCatalog()) } : {})
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

  /**
   * Fase 15: Chat Completions estilo OpenAI — mismo shape de loop que los
   * otros 3 (fetchWithTimeout, resolveMaxOutputTokens, runTool via
   * this.toolCatalog(), MAX_TOOL_LOOP, TurnCancelledError), formato de
   * request/response distinto: tool_calls vienen en
   * choices[0].message.tool_calls (cada uno {id, function:{name,
   * arguments: string JSON}}), y el resultado de cada tool va como un
   * mensaje aparte {role:'tool', tool_call_id, content} en vez de un
   * bloque dentro del mismo turno "user"/"assistant" (a diferencia de
   * Anthropic) o un campo function_call_output suelto (a diferencia de
   * Foundry). extractUsageTokens() NO necesito rama nueva: el fallback
   * generico ya lee usage.total_tokens, que es exactamente el campo real
   * de Chat Completions.
   */
  private async sendOpenAiApi(text: string, context: RuntimeContextEnvelope | undefined, signal: AbortSignal): Promise<ApiAgentResult> {
    if (!this.config) throw new Error('OpenAI API runtime no configurado.')
    const provider = this.config.provider
    const providerLabel = provider.name || 'OpenAI API'
    const apiKey = provider.apiKey?.trim()
    const model = this.config.model.trim()
    if (!apiKey) throw new Error(`${providerLabel} requiere API key.`)
    if (!model) throw new Error(`${providerLabel} requiere modelo.`)

    const url = openAiChatCompletionsUrl(provider.endpoint)
    const useTools = this.toolsActive()
    let messages = this.openAiMessages(text, context)
    let partialText = ''

    for (let turn = 0; turn < MAX_TOOL_LOOP; turn++) {
      if (signal.aborted) throw new TurnCancelledError(partialText)

      let response: Response
      try {
        response = await fetchWithTimeout(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`
          },
          body: JSON.stringify({
            model,
            messages,
            max_tokens: resolveMaxOutputTokens(this.config.maxOutputTokens, 'openai'),
            ...(useTools ? { tools: openAiTools(this.toolCatalog()), tool_choice: 'auto' } : {})
          })
        }, signal)
      } catch (error) {
        if (signal.aborted) throw new TurnCancelledError(partialText)
        throw error
      }

      if (!response.ok) {
        throw new Error(`${providerLabel} /chat/completions fallo ${response.status}: ${await readErrorBody(response)}`)
      }

      const raw = await response.json() as unknown
      const record = asRecord(raw)
      this.reportUsage('openai-chat', record)
      const choices = Array.isArray(record.choices) ? record.choices as unknown[] : []
      const messageRecord = asRecord(asRecord(choices[0]).message)
      const toolCalls = useTools && Array.isArray(messageRecord.tool_calls) ? messageRecord.tool_calls as unknown[] : []
      debugToolTurn('openai-chat', turn, useTools, raw, toolCalls.length)
      partialText = asString(messageRecord.content) || partialText

      if (toolCalls.length === 0) {
        const output = asString(messageRecord.content) || collectText(raw)
        return { text: output.trim() || `${providerLabel} completo el turno sin texto final.`, raw }
      }

      messages = [...messages, { role: 'assistant', content: messageRecord.content ?? null, tool_calls: toolCalls }]
      for (const call of toolCalls) {
        if (signal.aborted) throw new TurnCancelledError(partialText)
        const callRecord = asRecord(call)
        const callId = asString(callRecord.id)
        const functionRecord = asRecord(callRecord.function)
        const toolName = asString(functionRecord.name)
        const args = safeJsonParse(asString(functionRecord.arguments))
        const result = await this.runTool(turn, toolName, args)
        if (signal.aborted) throw new TurnCancelledError(partialText)
        messages.push({ role: 'tool', tool_call_id: callId, content: result.output })
      }
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
