import { EventEmitter } from 'node:events'
import { normalizeHistory } from './context-envelope'
import { readOnlyBlockedMessage, resolveApproval, TOOL_DEFINITIONS, type ToolDefinition, type ToolExecutionResult } from './tool-registry'
import type { McpManager } from './mcp-client'
import type { ChatAttachment, ConversationMessage, ProviderProfile, RuntimeContextEnvelope, SandboxMode } from '../shared/types'

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
  /** PIEZA 1 del orquestador (docs/_arch/verify_panel_orchestrator.md):
   *  true si el chat de ESTA conexion es el "principal" del workspace
   *  (mismo criterio que ya usa send_to_window para resolver su propio
   *  alias "1"/"principal" — titulo SIN el sufijo " — Panel N", calculado
   *  en ipc-agent.ts con chat-store.ts → isPrincipalChat() al conectar).
   *  Gatea send_to_window/list_windows en toolCatalog() — ver ahi.
   *  undefined/false = NO principal, esas 2 tools no entran al catalogo
   *  que se manda al modelo (no solo fallan al llamarlas, no existen). */
  isPrincipalChat?: boolean
  /** Feature "busqueda web" (docs/_arch/verify_web_search_design.md):
   *  true si settings.integrations.tavily.apiKey esta configurada
   *  (calculado en ipc-agent.ts al conectar, mismo momento que
   *  isPrincipalChat de arriba). Gatea web_search/web_fetch en
   *  toolCatalog() -- mismo criterio exacto, undefined/false = esas 2
   *  tools no entran al catalogo que se manda al modelo, nunca se le
   *  ofrece una tool que de todos modos fallaria sin credencial. */
  hasWebSearchIntegration?: boolean
  /** "Modo plan" (docs/_arch/verify_plan_mode_design.md): true si la sesion
   *  esta en modo plan ahora mismo -- gatea la tool exit_plan_mode en
   *  toolCatalog() (mismo patron exacto que isPrincipalChat/hasWebSearchIntegration
   *  de arriba). Actualizado EN CALIENTE por runtime-state.ts
   *  (updatePlanModeActive(), no solo al conectar) -- a diferencia de los 2
   *  campos de arriba, este SI cambia a mitad de conexion. */
  planModeActive?: boolean
}

export interface ApiAgentResult {
  text: string
  raw?: unknown
  /** Feature "generacion de imagenes": imagenes reales generadas por
   *  generate_image durante este turno (0, 1 o mas -- MAX_TOOL_LOOP
   *  permite varias vueltas de tool-calling). undefined si ninguna tool de
   *  este turno genero imagenes -- nunca un array vacio. Poblado en send()
   *  a partir de this.generatedAttachments, acumulado durante todo el loop
   *  de tools por runTool()/finish(). */
  attachments?: ChatAttachment[]
  /** Fase 1 del benchmark (docs/_arch/verify_benchmark_instrumentation.md):
   *  desglose real de tokens del turno completo (acumulado a traves de
   *  TODAS las vueltas del loop de tool-calling, no solo la ultima
   *  respuesta) -- para que el harness del benchmark lo lea directo de
   *  aca, sin tener que reconstruirlo aparte escuchando el evento 'usage'.
   *  Aditivo: turnTokens y el evento 'usage' siguen exactamente igual que
   *  antes, sin cambios. */
  usage?: UsageBreakdown
}

// 8 se quedaba corto para tareas legitimas de generacion de codigo con
// varios archivos (visto: 7+ write_file consecutivos, todos exitosos,
// distintos archivos — no un loop, solo una tarea grande). Cada write_file
// requiere aprobacion del usuario, asi que un limite mas alto no significa
// "sin control" — el usuario sigue aprobando cada escritura una por una.
//
// Fase 2 del benchmark (docs/_arch/verify_benchmark_harness.md, Tarea 2):
// override opcional via env var, mismo patron exacto que AMATISTA_STORAGE_ROOT
// (Fase 1, app-paths.ts) — sin la variable, comportamiento identico al de
// siempre (60). El harness del benchmark exporta AMATISTA_MAX_TOOL_LOOP mas
// alto SOLO para su propio proceso, sin tocar el default de la app instalada.
const MAX_TOOL_LOOP = Number(process.env.AMATISTA_MAX_TOOL_LOOP) || 60
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
 * Fase 19: argumento relevante de cada tool para el evento 'toolStatus' —
 * antes de esta fase el evento solo llevaba name/phase, indistinguible
 * entre dos llamadas seguidas a la misma tool (ej. 3 read_file en el mismo
 * turno). NO cambia la logica de ejecucion de ninguna tool, solo que se
 * REPORTA — un switch de solo lectura sobre los args que ya recibio
 * runTool(). Nombres de parametro tomados literal de TOOL_DEFINITIONS
 * (tool-registry.ts): path (read_file/write_file/apply_patch/list_dir/
 * revert_file), command (run_command), pattern+path (search_files).
 * Tools sin argumento relevante (list_file_history, git_status, git_diff,
 * MCP) devuelven {} — mismo texto generico de siempre para esas.
 */
function toolStatusArgDetail(name: string, args: unknown): { path?: string; command?: string; pattern?: string } {
  const record = asRecord(args)
  switch (name) {
    case 'read_file':
    case 'write_file':
    case 'apply_patch':
    case 'list_dir':
    case 'revert_file': {
      const path = asString(record.path)
      return path ? { path } : {}
    }
    case 'search_files': {
      const path = asString(record.path)
      const pattern = asString(record.pattern)
      return { ...(path ? { path } : {}), ...(pattern ? { pattern } : {}) }
    }
    case 'run_command': {
      const command = asString(record.command)
      return command ? { command } : {}
    }
    default:
      return {}
  }
}

/**
 * Extrae tokens totales del "usage" que cada proveedor devuelve al final de
 * CADA request (no hay streaming en ninguno de los 3 -> no hay conteo
 * incremental real dentro de un mismo request). En un turno con varias
 * vueltas de tool-calling si se puede acumular por vuelta, que es lo mas
 * cercano a "en vivo" que da la API sin migrar a SSE.
 */
/**
 * Fase 1 del benchmark (docs/_arch/verify_benchmark_instrumentation.md,
 * Tarea 1): desglose REAL de tokens -- los 4 proveedores YA distinguen
 * input/output en su respuesta real, y los 4 tienen un campo real de
 * tokens cacheados, con nombre DISTINTO cada uno (confirmado contra el
 * SDK/documentacion oficial de cada uno, no asumido por convencion
 * generica). `total`/`input`/`output`/`cached` opcionales salvo `total` --
 * no todos los proveedores exponen los 3 desgloses siempre.
 */
export interface UsageBreakdown {
  total: number
  input?: number
  output?: number
  cached?: number
}

function extractUsageTokens(kind: ApiAgentKind, record: Record<string, unknown>): UsageBreakdown | undefined {
  if (kind === 'gemini-api') {
    // Gemini API real (ai.google.dev/api/generate-content, confirmado):
    // promptTokenCount/candidatesTokenCount/totalTokenCount/cachedContentTokenCount
    // -- unico proveedor de los 4 con nombres propios, sin superposicion
    // con ningun otro.
    const usage = asRecord(record.usageMetadata)
    const input = asNumber(usage.promptTokenCount) || undefined
    const output = asNumber(usage.candidatesTokenCount) || undefined
    const cached = asNumber(usage.cachedContentTokenCount) || undefined
    const total = asNumber(usage.totalTokenCount) || (input ?? 0) + (output ?? 0) || undefined
    if (total === undefined) return undefined
    return { total, input, output, cached }
  }

  const usage = asRecord(record.usage)

  if (kind === 'openai-chat') {
    // Fix real (verify_benchmark_instrumentation.md, Tarea 1): Chat
    // Completions real usa prompt_tokens/completion_tokens, NO
    // input_tokens/output_tokens (esos son los nombres reales de
    // Foundry/Anthropic, no de esta API) -- el fallback generico anterior
    // nunca se manifestaba como bug porque total_tokens siempre esta
    // presente y ganaba primero, pero el desglose input/output quedaba mal
    // leido si alguna vez hubiera hecho falta. cached real:
    // prompt_tokens_details.cached_tokens.
    const input = asNumber(usage.prompt_tokens) || undefined
    const output = asNumber(usage.completion_tokens) || undefined
    const promptDetails = asRecord(usage.prompt_tokens_details)
    const cached = asNumber(promptDetails.cached_tokens) || undefined
    const total = asNumber(usage.total_tokens) || (input ?? 0) + (output ?? 0) || undefined
    if (total === undefined) return undefined
    return { total, input, output, cached }
  }

  // Foundry (Responses API) y Anthropic (Messages API): ambas usan
  // input_tokens/output_tokens reales (confirmado contra el SDK oficial de
  // cada una -- openai-python/response_usage.py y
  // anthropic-sdk-typescript/messages.ts). Anthropic NUNCA manda
  // total_tokens (confirmado real, el tipo Usage real del SDK no lo tiene)
  // -- se deriva de input+output, mismo criterio que ya usaba el fallback
  // viejo. El campo de cache tiene nombre DISTINTO por proveedor:
  // input_tokens_details.cached_tokens (Foundry) vs
  // cache_read_input_tokens (Anthropic, tokens SERVIDOS desde cache -- no
  // cache_creation_input_tokens, que es tokens ESCRITOS al cache, un
  // concepto distinto).
  const input = asNumber(usage.input_tokens) || undefined
  const output = asNumber(usage.output_tokens) || undefined
  const inputDetails = asRecord(usage.input_tokens_details)
  const cached = kind === 'foundry'
    ? asNumber(inputDetails.cached_tokens) || undefined
    : asNumber(usage.cache_read_input_tokens) || undefined
  const total = asNumber(usage.total_tokens) || (input ?? 0) + (output ?? 0) || undefined
  if (total === undefined) return undefined
  return { total, input, output, cached }
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

/**
 * Fase 17 Tarea 2: adjuntos de imagen del mensaje ACTUAL (context.attachments
 * es, por construccion de RuntimeContextEnvelope en runtime-state.ts, SOLO
 * el turno actual -- nunca historial), con preview real ya presente (Fase
 * 17 Tarea 1 dejo de descartarlo en los 2 chokepoints de App.tsx/
 * attachments.ts). El historial sigue mandando solo la referencia de texto
 * que ya arma textWithAttachments()/attachmentSummary() -- imagenes viejas
 * NUNCA se re-mandan turno a turno, a proposito (evitar bloat de contexto,
 * decision explicita del usuario para esta fase).
 */
function currentImageAttachments(context?: RuntimeContextEnvelope): ChatAttachment[] {
  return (context?.attachments ?? []).filter(attachment => attachment.kind === 'image' && Boolean(attachment.preview))
}

interface ParsedDataUrl {
  mimeType: string
  base64: string
}

/**
 * Separa un data URL completo ("data:image/png;base64,XXXX") en su
 * mimeType real y el base64 puro sin prefijo -- Anthropic y Gemini
 * necesitan el base64 SIN el prefijo (Tarea 2), Foundry y openai-chat lo
 * necesitan CON el prefijo completo (mandan attachment.preview tal cual).
 * Un solo parseo compartido por los 4 builders en vez de reimplementar el
 * regex 4 veces. null si preview no matchea el formato esperado -- el
 * llamador decide ignorar ese adjunto puntual en vez de mandarle basura al
 * proveedor.
 */
function parseDataUrl(dataUrl: string): ParsedDataUrl | null {
  const match = /^data:([^;,]+)(?:;[^,]*)?,(.*)$/s.exec(dataUrl)
  if (!match || !match[2]) return null
  return { mimeType: match[1] || 'application/octet-stream', base64: match[2] }
}

function foundryImageBlocks(attachments: ChatAttachment[]): unknown[] {
  // Shape confirmado en vivo (Fase 17 Tarea 0): string plano, YA es un data
  // URL completo -- no reconstruir el prefijo.
  return attachments.map(attachment => ({ type: 'input_image', image_url: attachment.preview }))
}

function openAiImageBlocks(attachments: ChatAttachment[]): unknown[] {
  // Shape confirmado en vivo contra OpenRouter real (Fase 17 Tarea 0,
  // stealth/ox-alpha, HTTP 200): objeto anidado con .url, a diferencia de
  // Foundry pese a que ambos son "familia OpenAI".
  return attachments.map(attachment => ({ type: 'image_url', image_url: { url: attachment.preview } }))
}

function anthropicImageBlocks(attachments: ChatAttachment[]): unknown[] {
  return attachments
    .map(attachment => {
      const parsed = parseDataUrl(attachment.preview!)
      if (!parsed) return null
      return { type: 'image', source: { type: 'base64', media_type: attachment.mimeType || parsed.mimeType, data: parsed.base64 } }
    })
    .filter(Boolean)
}

function geminiImageBlocks(attachments: ChatAttachment[]): unknown[] {
  return attachments
    .map(attachment => {
      const parsed = parseDataUrl(attachment.preview!)
      if (!parsed) return null
      return { inline_data: { mime_type: attachment.mimeType || parsed.mimeType, data: parsed.base64 } }
    })
    .filter(Boolean)
}

/**
 * Fase 17 Tarea 3: limite maximo de tamano de imagen por runtime, medido
 * sobre el base64 CODIFICADO (lo que efectivamente viaja en el body, ~33%
 * mas grande que el archivo original en disco) -- asi es como cada
 * proveedor documenta su propio techo. Fuente (verificado contra
 * documentacion oficial real, no asumido, ver docs/_arch/CONTRACT.md):
 * - anthropic-api: 10 MB base64-encoded -- limite exacto documentado de la
 *   API directa de Anthropic (Bedrock/GCP es 5MB, pero ese no es el caso
 *   de este runtime).
 * - foundry: 20 MB -- "maximum input image size" documentado por Microsoft
 *   Learn para Azure OpenAI vision.
 * - gemini-api: 20 MB -- techo documentado del REQUEST completo (texto +
 *   imagen inline) para generateContent; se aplica igual por-imagen porque
 *   Amatista manda una sola imagen por turno.
 * - openai-chat: sin numero exacto documentado por OpenAI para image_url
 *   (solo un techo generico de payload total, 512MB, no especifico de
 *   imagen) -> se usa el mas conservador de los 3 SI confirmados (10MB,
 *   igual que Anthropic), por instruccion explicita del usuario ante falta
 *   de dato exacto -- no se infla la certeza.
 */
const IMAGE_SIZE_LIMIT_BYTES: Record<ApiAgentKind, number> = {
  'anthropic-api': 10 * 1024 * 1024,
  foundry: 20 * 1024 * 1024,
  'gemini-api': 20 * 1024 * 1024,
  'openai-chat': 10 * 1024 * 1024
}

/**
 * Guard ANTES de armar el payload: si algun adjunto de imagen del turno
 * actual supera el limite documentado del proveedor activo, corta con un
 * error claro para el usuario en vez de dejar que la API lo rechace con un
 * mensaje criptico (ej. un "invalid_request_error" generico sin decir por
 * que). Unico chokepoint (llamado desde send(), antes del dispatch a
 * cualquiera de los 4 sendXxx) -- mismo criterio que runTool() como unico
 * punto de dispatch de tools.
 */
function assertImageAttachmentsWithinLimit(kind: ApiAgentKind, attachments: ChatAttachment[]): void {
  const limitBytes = IMAGE_SIZE_LIMIT_BYTES[kind]
  for (const attachment of attachments) {
    const parsed = parseDataUrl(attachment.preview!)
    if (!parsed) continue
    const encodedBytes = parsed.base64.length
    if (encodedBytes > limitBytes) {
      const limitMb = (limitBytes / (1024 * 1024)).toFixed(0)
      const actualMb = (encodedBytes / (1024 * 1024)).toFixed(1)
      throw new Error(
        `La imagen "${attachment.name}" pesa ~${actualMb}MB codificada en base64, supera el limite de ${limitMb}MB de ${kind}. ` +
        `Reduci el tamano de la imagen antes de adjuntarla.`
      )
    }
  }
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
  // Presets simples (docs/_arch/verify_simple_presets_design.md): mismo
  // bloque/orden exacto que formatContextEnvelope() (context-envelope.ts,
  // antes incluso de AGENTS.md) -- duplicado aca por la MISMA razon ya
  // documentada arriba para AGENTS.md/topics/summary/todos/modo plan.
  const personaText = context.personaText?.trim()
  if (personaText) {
    parts.push('Persona/instruccion de este chat (preset elegido al crearlo):')
    parts.push(personaText)
  }
  if (agentsMd) {
    parts.push('AGENTS.md del proyecto (instrucciones del repositorio, no de esta conversacion):')
    parts.push(agentsMd)
  }
  // Sistema de skills (docs/_arch/verify_skills_design.md): mismo bloque
  // exacto (nivel 1, solo nombre+descripcion) que formatContextEnvelope() --
  // duplicado aca por la misma razon ya documentada para AGENTS.md/
  // personaText/todos/modo plan.
  if (context.skills && context.skills.length > 0) {
    parts.push('Skills disponibles (usa load_skill(name) para ver el procedimiento completo de una):')
    for (const skill of context.skills) {
      parts.push(`- ${skill.name}: ${skill.description}`)
    }
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
  // Tool "todo_write" (docs/_arch/verify_todo_write_design.md): mismo
  // bloque/criterio exacto que formatContextEnvelope() (context-envelope.ts)
  // -- duplicado aca por la MISMA razon ya documentada arriba para
  // AGENTS.md/topics/summary: los 4 runtimes API arman su propio payload,
  // nunca pasan por formatContextEnvelope(). Sin esto, un chat con una
  // lista de tareas real solo la veria el runtime CLI, nunca los 4 API --
  // exactamente el mismo gap que esta funcion ya existe para cerrar.
  if (context.todos && context.todos.length > 0) {
    parts.push('Lista de tareas (todo_write):')
    for (const todo of context.todos) {
      const marker = todo.status === 'completed' ? '[x]' : todo.status === 'in_progress' ? '[~]' : '[ ]'
      const priority = todo.priority ? ` (prioridad: ${todo.priority})` : ''
      parts.push(`- ${marker} ${todo.content}${priority}`)
    }
  }
  // "Modo plan" (docs/_arch/verify_plan_mode_design.md): mismo bloque/
  // criterio exacto que formatContextEnvelope() (context-envelope.ts) --
  // duplicado aca por la MISMA razon ya documentada arriba para AGENTS.md/
  // topics/summary/todos: los 4 runtimes API arman su propio payload,
  // nunca pasan por formatContextEnvelope(). La tool exit_plan_mode SI
  // esta disponible aca (TOOL_DEFINITIONS, gateada por
  // config.planModeActive en toolCatalog()) -- pero el texto sigue sin
  // asumirlo de forma incondicional, mismo texto exacto que el bloque de
  // context-envelope.ts, para que un chat que cambia de runtime a mitad de
  // conversacion vea la misma guia sin importar por cual de los 2 caminos
  // se armo.
  if (context.planModeActive) {
    parts.push('MODO PLAN ACTIVO -- explora y disena antes de escribir archivos o ejecutar comandos.')
    parts.push(
      context.planModeEnforced
        ? 'Tu sandbox real esta forzado a solo lectura mientras dure el plan -- escribir/ejecutar va a ser rechazado.'
        : 'Tecnicamente podrias escribir/ejecutar, pero NO lo hagas todavia.'
    )
    parts.push('Si tenes disponible la tool exit_plan_mode, usala para presentar tu plan completo y esperar aprobacion explicita antes de ejecutar nada. Si no la tenes disponible, resumi el plan completo en tu respuesta de texto y esperá una confirmacion clara del usuario antes de proceder.')
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
  /**
   * Fase 1 del benchmark: desglose real ADITIVO a turnTokens (que sigue
   * intacto, sin cambio de uso -- restriccion explicita). undefined
   * mientras nunca se reporto ese campo puntual en NINGUNA vuelta de este
   * turno (distinto de 0 real) -- ver extractUsageTokens()/reportUsage().
   */
  private turnInputTokens: number | undefined
  private turnOutputTokens: number | undefined
  private turnCachedTokens: number | undefined
  private toolCallLog: Array<{ turn: number; name: string; argsPreview: string; resultPreview: string }> = []
  /** Feature "generacion de imagenes": acumulador del turno en curso, mismo
   *  patron que toolCallLog/turnTokens de arriba -- poblado por runTool()
   *  cada vez que una tool devuelve ToolExecutionResult.generatedAttachment,
   *  reseteado al arrancar cada send() nuevo, volcado al ApiAgentResult
   *  final (attachments) al terminar el turno. Necesario porque una imagen
   *  puede generarse en CUALQUIER vuelta intermedia del loop de
   *  MAX_TOOL_LOOP -- sin este acumulador, se perderia antes de llegar al
   *  mensaje final (`{text, raw}` que ya devolvian sendFoundry/etc.). */
  private generatedAttachments: ChatAttachment[] = []

  configure(options: ConfigureOptions): void {
    this.config = options
  }

  /**
   * "Modo plan" (docs/_arch/verify_plan_mode_design.md, Tarea 2): cambio de
   * sandbox EN CALIENTE, sin reconectar -- confirmado real que configure()
   * de arriba ya es un simple reemplazo de this.config, sin ningun efecto
   * secundario real (ningun socket/proceso que reabrir, el historial nunca
   * vive en esta clase). Mutar solo el campo sandbox del config YA
   * GUARDADO es seguro. Usado por enablePlanMode()/disablePlanMode()
   * (runtime-state.ts) para forzar/revertir read-only sin desconectar.
   * No-op si el runtime nunca se configuro (no deberia pasar).
   */
  updateSandbox(sandbox: SandboxMode): void {
    if (this.config) this.config.sandbox = sandbox
  }

  /** Mismo criterio que updateSandbox() de arriba -- mutacion en caliente
   *  de un solo campo del config ya guardado, para que toolCatalog() (mas
   *  abajo) vea el cambio en el PROXIMO turno sin reconectar. */
  updatePlanModeActive(active: boolean): void {
    if (this.config) this.config.planModeActive = active
  }

  /**
   * Fix real (docs/_arch/verify_compatible_migration_scope.md, Pieza 3):
   * `effort` nuevo, opcional -- mismo campo que ya threadea
   * `payload.effort` para claude-cli/codex-subscription (ipc-agent.ts), acá
   * llega hasta `sendOpenAiApi()`. Los otros 3 kinds (`foundry`/
   * `anthropic-api`/`gemini-api`) lo ignoran por completo (nunca se los
   * pasa a sus propios `send*()`), mismo criterio que `antigravity`/
   * `gemini` ya ignoraban `effort` en `cli-agent-runtime.ts`.
   */
  async send(text: string, context?: RuntimeContextEnvelope, signal?: AbortSignal, effort?: string): Promise<ApiAgentResult> {
    if (!this.config) throw new Error('Runtime API no configurado.')
    this.turnTokens = 0
    this.turnInputTokens = undefined
    this.turnOutputTokens = undefined
    this.turnCachedTokens = undefined
    this.toolCallLog = []
    this.generatedAttachments = []
    // Fase 17 Tarea 3: guard de tamano ANTES de armar cualquier payload --
    // unico chokepoint para los 4 runtimes, corre antes del dispatch de
    // abajo.
    assertImageAttachmentsWithinLimit(this.config.kind, currentImageAttachments(context))
    const turnSignal = signal ?? new AbortController().signal
    const result = this.config.kind === 'foundry'
      ? await this.sendFoundry(text, context, turnSignal)
      : this.config.kind === 'anthropic-api'
        ? await this.sendAnthropicApi(text, context, turnSignal)
        : this.config.kind === 'openai-chat'
          ? await this.sendOpenAiApi(text, context, turnSignal, effort)
          : await this.sendGeminiApi(text, context, turnSignal)
    // Feature "generacion de imagenes": unico punto de union para los 4
    // runtimes -- evita agregar `attachments: this.generatedAttachments`
    // en cada uno de los multiples `return` de sendFoundry/sendAnthropicApi/
    // sendGeminiApi/sendOpenAiApi (exito, sin texto final, tope de
    // MAX_TOOL_LOOP, etc.). undefined (no array vacio) si nada se genero
    // este turno -- mismo criterio que el resto de los campos opcionales
    // de ApiAgentResult.
    return this.generatedAttachments.length ? { ...result, attachments: this.generatedAttachments } : result
  }

  /**
   * Acumula el usage de esta vuelta del loop y avisa al renderer.
   * turnTokens/el evento 'usage' emitido: SIN cambios (restriccion
   * explicita de Fase 1) -- el desglose nuevo (turnInputTokens/
   * turnOutputTokens/turnCachedTokens) se acumula aparte, aditivo, nunca
   * reemplaza lo que ya existia.
   */
  private reportUsage(kind: ApiAgentKind, record: Record<string, unknown>): void {
    const usage = extractUsageTokens(kind, record)
    if (usage === undefined) return
    this.turnTokens += usage.total
    if (usage.input !== undefined) this.turnInputTokens = (this.turnInputTokens ?? 0) + usage.input
    if (usage.output !== undefined) this.turnOutputTokens = (this.turnOutputTokens ?? 0) + usage.output
    if (usage.cached !== undefined) this.turnCachedTokens = (this.turnCachedTokens ?? 0) + usage.cached
    this.emit('usage', { tokens: this.turnTokens })
  }

  /** Snapshot real del desglose acumulado hasta este punto del turno --
   *  volcado a ApiAgentResult.usage en cada return exitoso de los 4
   *  sendXxx(). total siempre presente (0 si nunca se reporto nada, mismo
   *  valor por defecto que turnTokens); input/output/cached quedan
   *  undefined si esa vuelta puntual del desglose nunca llego en NINGUNA
   *  respuesta real de este turno (distinto de haber llegado en 0). */
  private currentUsage(): UsageBreakdown {
    return {
      total: this.turnTokens,
      input: this.turnInputTokens,
      output: this.turnOutputTokens,
      cached: this.turnCachedTokens
    }
  }

  private toolsActive(): boolean {
    return Boolean(this.config?.toolsEnabled && this.config?.toolExecutor)
  }

  /** Fase 10 (Tarea 3): las 10 tools built-in + las tools MCP descubiertas
   *  para esta conexion (namespaced mcp__servidor__tool, ya en forma de
   *  ToolDefinition — ver McpManager.listToolDefinitions()). Un solo punto
   *  de union, usado en los 4 send* de mas abajo en vez de repetir el
   *  spread cuatro veces.
   *
   *  Tanda de benchmark "LSP forzado" (docs/_arch/verify_lsp_forced_batch.md):
   *  AMATISTA_EXCLUDED_TOOLS (lista separada por comas) filtra nombres del
   *  catalogo NATIVO antes de mandarlo al modelo -- mismo patron que
   *  AMATISTA_STORAGE_ROOT/AMATISTA_MAX_TOOL_LOOP, sin la variable cero
   *  cambio de comportamiento (catalogo completo, como siempre). Solo
   *  filtra TOOL_DEFINITIONS -- las tools MCP quedan siempre intactas, no
   *  aplica para el caso de uso real (el benchmark no conecta servidores
   *  MCP) y mantiene el mecanismo mas simple. Confirmado real (Tarea 0)
   *  que ToolRegistry.execute() es puramente reactivo (nunca rompe si una
   *  tool desaparece del catalogo) y que explore-tool.ts arma su propio
   *  subconjunto de solo-lectura totalmente independiente de este metodo
   *  -- ningun otro consumidor real depende de que el catalogo sea
   *  siempre completo. */
  private toolCatalog(): ToolDefinition[] {
    const excluded = (process.env.AMATISTA_EXCLUDED_TOOLS ?? '')
      .split(',')
      .map(name => name.trim())
      .filter(Boolean)
    // PIEZA 1 del orquestador (docs/_arch/verify_panel_orchestrator.md):
    // send_to_window/list_windows SOLO para el chat "principal" del
    // workspace (this.config.isPrincipalChat, calculado en ipc-agent.ts al
    // conectar con el MISMO criterio que send_to_window ya usa para
    // resolver su propio alias "1"/"principal" — ver chat-store.ts,
    // isPrincipalChat()). Mismo patron de filtrado por nombre que
    // AMATISTA_EXCLUDED_TOOLS arriba, y que EXPLORE_TOOL_NAMES en
    // tool-registry.ts (explore-tool.ts) — ningun mecanismo nuevo, solo un
    // tercer filtro sumado a la misma lista.
    const orchestratorToolNames = ['send_to_window', 'list_windows']
    const hideOrchestratorTools = !this.config?.isPrincipalChat
    // Feature "busqueda web" (docs/_arch/verify_web_search_design.md,
    // Tarea 3): MISMO patron exacto de filtrado por nombre que
    // orchestratorToolNames de arriba -- sin API key real de Tavily
    // configurada, web_search/web_fetch ni siquiera aparecen en el
    // catalogo, nunca se le ofrece al modelo una tool que de todos modos
    // fallaria por falta de credencial.
    const webSearchToolNames = ['web_search', 'web_fetch']
    const hideWebSearchTools = !this.config?.hasWebSearchIntegration
    // "Modo plan" (docs/_arch/verify_plan_mode_design.md): mismo patron
    // exacto que orchestratorToolNames/webSearchToolNames -- exit_plan_mode
    // solo tiene sentido si la sesion esta en modo plan ahora mismo, nunca
    // se le ofrece al modelo una tool para "salir" de algo en lo que no
    // esta. A diferencia de isPrincipalChat/hasWebSearchIntegration (fijos
    // al conectar), este campo cambia EN CALIENTE (updatePlanModeActive()),
    // asi que toolCatalog() (llamado en cada turno) ya lo ve actualizado
    // sin reconectar.
    const planModeToolNames = ['exit_plan_mode']
    const hidePlanModeTools = !this.config?.planModeActive
    const native = TOOL_DEFINITIONS.filter(def =>
      !excluded.includes(def.name) &&
      !(hideOrchestratorTools && orchestratorToolNames.includes(def.name)) &&
      !(hideWebSearchTools && webSearchToolNames.includes(def.name)) &&
      !(hidePlanModeTools && planModeToolNames.includes(def.name))
    )
    if (DEBUG_TOOLS) {
      console.log(
        `[apiRuntime] toolCatalog isPrincipalChat=${Boolean(this.config?.isPrincipalChat)} ` +
        `send_to_window/list_windows incluidas=${!hideOrchestratorTools} ` +
        `web_search/web_fetch incluidas=${!hideWebSearchTools} ` +
        `exit_plan_mode incluida=${!hidePlanModeTools} total=${native.length}`
      )
    }
    return [...native, ...(this.config?.mcpToolDefinitions ?? [])]
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
    // Fase 19: mismo argDetail (path/command/pattern, si aplica) en los dos
    // emits de abajo — calculado UNA vez sobre los args ya recibidos, no
    // cambia que tool se ejecuta ni con que argumentos, solo lo que viaja
    // en el evento de UI.
    const argDetail = toolStatusArgDetail(name, args)
    this.emit('toolStatus', { name, phase: 'start', workspace, ...argDetail })

    // detail: motivo real del fallo, no solo "fallo" — sin esto la unica
    // pista que le llegaba al usuario era el nombre de la tool, y el
    // porque real (rechazo, ruta invalida, timeout, etc.) quedaba
    // enterrado en el tool_result que solo ve el modelo.
    const finish = (result: ToolExecutionResult): ToolExecutionResult => {
      this.emit('toolStatus', {
        name,
        phase: 'done',
        ok: result.ok,
        workspace,
        ...argDetail,
        detail: result.ok ? undefined : result.output.slice(0, 200),
        // Fase 19: mismo conteo que ya calculo tool-registry.ts a partir del
        // DiffLine[] del dialogo de aprobacion -- nunca un segundo diff.
        // Solo presente si la tool (write_file/apply_patch) lo devolvio.
        lineDiff: result.ok ? result.lineDiff : undefined
      })
      // Feature "generacion de imagenes": acumula ACA, no en cada call
      // site de mas abajo -- este closure es el unico punto por el que
      // pasa CUALQUIER ToolExecutionResult (built-in de tool-registry.ts,
      // MCP, o el error temprano de "tool no disponible"), asi que
      // generate_image no necesita ningun tratamiento especial en el
      // dispatch de mas abajo, solo devolver generatedAttachment en su
      // resultado exitoso.
      if (result.ok && result.generatedAttachment) {
        this.generatedAttachments.push(result.generatedAttachment)
      }
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
    // Fase 17 Tarea 2: si el turno actual tiene imagenes con preview, el
    // content pasa de string plano a array de bloques (input_text +
    // input_image) -- shape Responses API. Sin imagenes, content sigue
    // siendo el string plano de siempre (cero cambio de comportamiento).
    const images = currentImageAttachments(context)
    const currentContent: unknown = images.length > 0
      ? [{ type: 'input_text', text: currentText }, ...foundryImageBlocks(images)]
      : currentText
    return [
      ...summaryTurn,
      ...messages.map(message => ({
        role: message.role === 'assistant' ? 'assistant' : 'user',
        content: message.role === 'system' ? `[system] ${message.text}` : message.text
      })),
      { role: 'user', content: currentContent }
    ]
  }

  private geminiContents(text: string, context?: RuntimeContextEnvelope): unknown[] {
    const messages = context ? normalizeHistory(context.history) : []
    const memoryText = memoryBlockText(context)
    const summaryTurn = memoryText
      ? [{ role: 'user', parts: [{ text: `[system] ${memoryText}` }] }]
      : []
    // Fase 17 Tarea 2: parts ya es un array -- una imagen se suma como un
    // part {inline_data:...} mas, junto al part {text:...} de siempre.
    const images = currentImageAttachments(context)
    const currentParts = [{ text: textWithAttachments(text, context) }, ...geminiImageBlocks(images)]
    return [
      ...summaryTurn,
      ...messages.map(message => ({
        role: message.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: message.role === 'system' ? `[system] ${message.text}` : message.text }]
      })),
      { role: 'user', parts: currentParts }
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
    // Fase 17 Tarea 2: mismo criterio que foundryInputArray -- content pasa
    // a array (text + image_url) solo si hay imagenes en el turno actual.
    const currentText = textWithAttachments(text, context)
    const images = currentImageAttachments(context)
    const currentContent: unknown = images.length > 0
      ? [{ type: 'text', text: currentText }, ...openAiImageBlocks(images)]
      : currentText
    return [
      ...systemTurn,
      ...messages.map(message => ({ role: message.role, content: message.text })),
      { role: 'user', content: currentContent }
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
        return { text: output.trim() || 'Foundry completo el turno sin texto final.', raw, usage: this.currentUsage() }
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
        return { text: output.trim() || 'Gemini API completo el turno sin texto final.', raw, usage: this.currentUsage() }
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
    // Fase 17 Tarea 2: anthropicMessages() siempre agrega el turno actual
    // como el ULTIMO elemento del array (ver su implementacion arriba) --
    // por eso alcanza con detectar el ultimo indice para saber cual es el
    // turno actual, sin threadear un flag aparte. Solo ESE turno pasa a
    // content:[...] con bloques de imagen; el resto (historial) sigue como
    // content:string, igual que siempre.
    const conversationMessages = this.anthropicMessages(text, context)
    const currentImages = currentImageAttachments(context)
    let messages: Array<{ role: string; content: unknown }> = conversationMessages.map((message, index) => {
      const isCurrentTurn = index === conversationMessages.length - 1
      if (isCurrentTurn && currentImages.length > 0) {
        return { role: message.role, content: [{ type: 'text', text: message.text }, ...anthropicImageBlocks(currentImages)] }
      }
      return { role: message.role, content: message.text }
    })
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
        return { text: output.trim() || 'Claude API completo el turno sin texto final.', raw, usage: this.currentUsage() }
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
        // read_document (Tarea 4, verify_read_document_tool.md): pagina de
        // PDF sin texto extraible -- unico runtime cuyo tool_result soporta
        // bloques de imagen (confirmado real: OpenAI Chat Completions y
        // Foundry/Gemini solo aceptan texto en un mensaje de tool/function,
        // ver comentario de resultImageDataUrl en tool-registry.ts). Mismo
        // guard de tamano que ya protege las imagenes de turno actual
        // (IMAGE_SIZE_LIMIT_BYTES/parseDataUrl) -- si el PNG renderizado
        // superara el limite (pagina enorme a escala 2x), se omite el
        // bloque de imagen y solo queda el texto explicando por que.
        const imageBlock = result.ok && result.resultImageDataUrl ? parseDataUrl(result.resultImageDataUrl) : null
        const withinLimit = imageBlock && imageBlock.base64.length <= IMAGE_SIZE_LIMIT_BYTES['anthropic-api']
        const content = withinLimit
          ? [
              { type: 'text', text: result.output },
              { type: 'image', source: { type: 'base64', media_type: imageBlock!.mimeType, data: imageBlock!.base64 } }
            ]
          : result.output
        resultBlocks.push({ type: 'tool_result', tool_use_id: toolUseId, content })
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
  /**
   * Fase 2 del benchmark, retomada con OpenAI directo (sin Azure): la API
   * real de OpenAI RECHAZA max_tokens con 400 explicito para gpt-5.2
   * ("Unsupported parameter... Use 'max_completion_tokens' instead") — y
   * confirmado real que NO alcanza con mandar los dos a la vez, rechaza
   * igual con max_tokens presente sin importar que tambien venga
   * max_completion_tokens (no ignora el parametro que no reconoce, invalida
   * el pedido entero). Pero este mismo runtime (kind:'openai-chat') sirve
   * OpenRouter en produccion desde Fase 15 — muchos de sus modelos (gpt-4o,
   * gpt-3.5, modelos de terceros) siguen esperando max_tokens, asi que
   * cambiar el nombre del parametro de forma incondicional arriesgaba una
   * regresion real ahi. Deteccion por prefijo de modelo en cambio: o1/o3/o4
   * y gpt-5.x son la familia real de modelos "reasoning" de OpenAI que
   * documenta este cambio de parametro — todo lo demas (gpt-4o, gpt-3.5,
   * cualquier modelo de OpenRouter) sigue mandando max_tokens exacto como
   * antes, cero cambio de comportamiento para ellos.
   */
  /** o1/o3/o4 y gpt-5.x son la familia real "reasoning" de OpenAI -- mismo
   *  criterio real que ya distinguia openAiMaxTokensField() (max_tokens vs
   *  max_completion_tokens), reusado aca tambien para decidir si mandar
   *  reasoning_effort en absoluto (el resto de los modelos, gpt-4o/gpt-3.5/
   *  la mayoria de OpenRouter, no reconocen ese campo). */
  private isOpenAiReasoningModel(model: string): boolean {
    return /^(o[1-9]|gpt-5)/i.test(model.trim())
  }
  private openAiMaxTokensField(model: string): 'max_tokens' | 'max_completion_tokens' {
    return this.isOpenAiReasoningModel(model) ? 'max_completion_tokens' : 'max_tokens'
  }
  /**
   * Fix real (docs/_arch/verify_compatible_migration_scope.md, Pieza 3):
   * conflicto real y documentado de la Chat Completions API de OpenAI entre
   * `reasoning_effort` y `tools` -- un modelo reasoning con tools activas
   * NO puede razonar de forma extendida antes de decidir una tool call sin
   * degradar el loop agentico (cada vuelta de razonamiento intermedio se
   * pierde entre tool calls, a diferencia de la Responses API, que sí
   * preserva ese estado). Amatista SIEMPRE manda tools activas cuando el
   * modelo las soporta (`ToolRegistry`, loop agentico real) -- omitir el
   * parametro en ese caso NO es neutral: los modelos reasoning tienen un
   * default propio distinto de "apagado" si se omite (ej. gpt-5.5 default
   * real "medium"), asi que hay que forzar `'none'` EXPLICITO, no confiar
   * en el default del modelo. Sin tools activas (turno de solo texto, o un
   * modelo con `capabilities.tools:false`), viaja el nivel real que el
   * usuario haya elegido (`effort`, threadeado desde payload.effort en
   * ipc-agent.ts, mismo campo que ya usan claude-cli/codex-subscription) --
   * `undefined` si no eligio ninguno, omitido del body (mismo criterio que
   * el resto de los runtimes: sin valor explicito, se deja el default del
   * modelo intacto).
   */
  private openAiReasoningEffort(model: string, useTools: boolean, effort?: string): string | undefined {
    if (!this.isOpenAiReasoningModel(model)) return undefined
    return useTools ? 'none' : effort
  }
  private async sendOpenAiApi(
    text: string,
    context: RuntimeContextEnvelope | undefined,
    signal: AbortSignal,
    effort?: string
  ): Promise<ApiAgentResult> {
    if (!this.config) throw new Error('OpenAI API runtime no configurado.')
    const provider = this.config.provider
    const providerLabel = provider.name || 'OpenAI API'
    const apiKey = provider.apiKey?.trim()
    const model = this.config.model.trim()
    if (!apiKey) throw new Error(`${providerLabel} requiere API key.`)
    if (!model) throw new Error(`${providerLabel} requiere modelo.`)

    const url = openAiChatCompletionsUrl(provider.endpoint)
    const useTools = this.toolsActive()
    const reasoningEffort = this.openAiReasoningEffort(model, useTools, effort)
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
            [this.openAiMaxTokensField(model)]: resolveMaxOutputTokens(this.config.maxOutputTokens, 'openai'),
            ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
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
        return { text: output.trim() || `${providerLabel} completo el turno sin texto final.`, raw, usage: this.currentUsage() }
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
