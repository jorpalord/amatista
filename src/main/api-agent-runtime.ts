import { EventEmitter } from 'node:events'
import { normalizeHistory } from './context-envelope'
import { hashFileContent, readOnlyBlockedMessage, resolveApproval, TOOL_DEFINITIONS, type ToolDefinition, type ToolExecutionResult } from './tool-registry'
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
  /** Investigacion real durante una prueba en vivo del usuario: techo de
   *  iteraciones de tool-calling configurado en Settings
   *  (`AppSettings.maxToolLoop`, shared/types.ts) -- undefined = usar
   *  MAX_TOOL_LOOP (const de modulo, 60 o AMATISTA_MAX_TOOL_LOOP si esta
   *  seteada). Leido fresco en cada turno desde this.config, NUNCA cacheado
   *  en un const de modulo (mismo motivo exacto que evito el fix real de
   *  TURN_WATCHDOG_MS congelado -- ver CONTRACT.md). */
  maxToolLoop?: number
  workspace: string
  sandbox: SandboxMode
  toolsEnabled: boolean
  toolExecutor?: ToolExecutor
  /** `ModelProfile.capabilities.vision` del modelo conectado (ipc-agent.ts).
   *  `false` explicito = el modelo no ve: las tools que devuelven una imagen
   *  responden con metadata honesta en texto en vez de mandar el bloque de
   *  imagen (ver resultImageFor()). undefined/true = se asume que ve. */
  visionCapable?: boolean
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

// guard/ Pieza 2 (docs/_arch/verify_guard_design.md, Tarea 2-4): loop-hygiene
// por RESULTADO, no por args -- confirmado en la investigacion (3 proyectos
// independientes) que "misma tool + mismos args N veces" NO alcanza como
// senal (polling/paginacion legitimos repiten con los mismos args porque
// el resultado cambia). Solo interviene si ademas el HASH del resultado se
// repite N veces SEGUIDAS -- 3 por default, un numero chico a proposito:
// es un empujon (agrega una nota al tool_result, no corta el turno), asi
// que un falso positivo ocasional solo le recuerda al modelo algo que ya
// sabe, no le bloquea nada. Complementa a MAX_TOOL_LOOP (60, sigue intacto
// como red de seguridad final) sin reemplazarlo -- un bucle real hoy
// consumia las 60 iteraciones completas antes de cortar; con esto, el
// aviso llega mucho antes, sin impedir que el modelo siga si de verdad
// tiene una razon (el aviso no bloquea, solo informa).
const LOOP_HYGIENE_THRESHOLD = Number(process.env.AMATISTA_LOOP_HYGIENE_THRESHOLD) || 3

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
 *   (familia GPT-4.1/GPT-5 de Azure). Los deployments reales de cada
 *   recurso Foundry (ver foundry-catalog.ts, descubiertos en vivo via
 *   GET /openai/deployments) no tienen un techo real verificado por nombre
 *   puntual.
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

// ---------------------------------------------------------------------------
// Imagen dentro del RESULTADO de una tool -- F0 de
// docs/_arch/verify_native_multimodal_tools_design.md. Hasta ahora solo
// anthropic-api la armaba; foundry/gemini-api/openai-chat mandaban solo texto.
// resultImageFor() es el CHOKEPOINT unico: decide, para UN resultado de tool,
// que texto lee el modelo y si la imagen realmente viaja en la request. Cada
// sendXxx() traduce ese mismo contrato al formato de cable REAL de su API
// (documentacion oficial, ver el documento de diseno §1.3):
//  - anthropic-api: tool_result.content = [text, image{source:{base64}}]
//  - foundry (Responses): function_call_output.output = [input_text, input_image{image_url}]
//  - gemini-api (SOLO Gemini 3+): functionResponse.parts = [inlineData], role:"user", + id
//  - openai-chat: Chat Completions NO admite imagen en un mensaje `tool` (solo
//    texto) -> un mensaje `user` con image_url DESPUES de todos los `tool` del turno
// ---------------------------------------------------------------------------

/** Imagen ya validada, lista para viajar dentro de un resultado de tool. */
export interface ToolResultImage {
  mimeType: string
  base64: string
  /** `data:<mime>;base64,<...>` completo (foundry `input_image.image_url` y openai-chat `image_url.url` lo piden asi). */
  dataUrl: string
}

/** Lo que un runtime debe mandar para UN resultado de tool. */
export interface ResolvedToolResultImage {
  /** Texto que el modelo lee para este resultado: el `output` original, con un aviso HONESTO si la imagen NO se adjunta. */
  text: string
  /** Presente SOLO si la imagen realmente va a viajar en la request (nunca se afirma un adjunto que no ocurre). */
  image: ToolResultImage | null
}

/** Cuantas imagenes de resultados de tools conserva VIVAS un turno (las mas nuevas): cada vuelta del loop reenvia todo el
 *  historial del turno, y una sesion de computer use puede tomar decenas de capturas de ~0,3-3 MB. Las mas viejas se
 *  reemplazan por un aviso de texto. */
export const MAX_TOOL_RESULT_IMAGES_PER_TURN = 8
const EVICTED_IMAGE_NOTICE =
  `[Imagen anterior omitida por Amatista: un turno solo conserva las ultimas ${MAX_TOOL_RESULT_IMAGES_PER_TURN} imagenes de resultados de tools para acotar el contexto.]`

/** Formatos que los 4 proveedores documentan como aceptados para una imagen. */
const TOOL_RESULT_IMAGE_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])

/**
 * Por que este runtime/modelo NO puede recibir una imagen dentro de un
 * resultado de tool (null = si puede). Es la unica fuente de verdad de esa
 * capacidad: la usa resultImageFor() y ApiAgentRuntime.toolResultImageMaxBytes().
 *  - visionCapable === false: primer lugar donde main RESPETA
 *    ModelProfile.capabilities.vision (antes existia y nadie lo leia). Solo el
 *    `false` explicito degrada -- undefined/true se tratan como "ve".
 *  - gemini-api: la feature "Multimodal function responses" es SOLO de la serie
 *    Gemini 3 en adelante (documentacion oficial); para 2.5 y anteriores no hay
 *    ningun patron documentado -> se degrada en vez de inventar uno.
 */
export function toolResultImageBlocker(kind: ApiAgentKind, model: string, visionCapable?: boolean): string | null {
  if (visionCapable === false) {
    return 'el modelo conectado no tiene vision (capabilities.vision esta desactivada en su perfil)'
  }
  if (kind === 'gemini-api') {
    const major = /^gemini-(\d+)/i.exec(normalizeGeminiModel(model))
    if (!major || Number(major[1]) < 3) {
      return 'solo los modelos Gemini 3 o posteriores aceptan imagenes dentro del resultado de una tool, y este modelo Gemini no'
    }
  }
  return null
}

/** Ancho/alto leidos del encabezado, sin decodificar la imagen. null si no se pueden leer. */
function imageDimensions(mimeType: string, base64: string): { width: number; height: number } | null {
  const head = Buffer.from(base64.slice(0, 87384), 'base64') // ~64 KB alcanzan para el encabezado de cualquiera de los 4 formatos
  if (mimeType === 'image/png' && head.length >= 24 && head.readUInt32BE(0) === 0x89504e47) {
    return { width: head.readUInt32BE(16), height: head.readUInt32BE(20) }
  }
  if (mimeType === 'image/gif' && head.length >= 10) {
    return { width: head.readUInt16LE(6), height: head.readUInt16LE(8) }
  }
  if (mimeType === 'image/jpeg' && head.length > 4 && head[0] === 0xff && head[1] === 0xd8) {
    let offset = 2
    while (offset + 9 < head.length) {
      if (head[offset] !== 0xff) { offset++; continue }
      const marker = head[offset + 1]
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { offset += 2; continue }
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { height: head.readUInt16BE(offset + 5), width: head.readUInt16BE(offset + 7) }
      }
      offset += 2 + head.readUInt16BE(offset + 2)
    }
    return null
  }
  if (mimeType === 'image/webp' && head.length >= 30 && head.toString('ascii', 0, 4) === 'RIFF' && head.toString('ascii', 8, 12) === 'WEBP') {
    const chunk = head.toString('ascii', 12, 16)
    if (chunk === 'VP8 ') return { width: head.readUInt16LE(26) & 0x3fff, height: head.readUInt16LE(28) & 0x3fff }
    if (chunk === 'VP8L') { const bits = head.readUInt32LE(21); return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 } }
    if (chunk === 'VP8X') return { width: head.readUIntLE(24, 3) + 1, height: head.readUIntLE(27, 3) + 1 }
  }
  return null
}

/**
 * CHOKEPOINT unico (ver el bloque de arriba): para UN resultado de tool
 * decide que texto lee el modelo y si la imagen viaja. Con imagen valida y
 * soportada -> `text` es el `output` ORIGINAL (byte a byte, sin tocar) e
 * `image` viene poblada. En cualquier otro caso `image` es null y `text` suma
 * un aviso honesto con los metadatos que SI se pueden dar sin ver la imagen
 * (tipo, dimensiones, peso) -- nunca se finge un adjunto que no ocurre.
 */
export function resultImageFor(
  kind: ApiAgentKind,
  result: ToolExecutionResult,
  capability: { model: string; visionCapable?: boolean }
): ResolvedToolResultImage {
  if (!result.ok || !result.resultImageDataUrl) return { text: result.output, image: null }
  const noImage = (reason: string, meta = ''): ResolvedToolResultImage => ({
    text: `${result.output}\n[Amatista] NO se adjunta la imagen: ${reason}. ${meta}No inventes ni supongas su contenido visual.`,
    image: null
  })
  const parsed = parseDataUrl(result.resultImageDataUrl)
  if (!parsed) return noImage('la imagen que devolvio la tool no tiene un formato de data URL valido')
  const mimeType = parsed.mimeType.toLowerCase()
  const dims = imageDimensions(mimeType, parsed.base64)
  const kb = Math.round((parsed.base64.length * 0.75) / 1024)
  const meta = `Metadatos de la imagen (que NO puedes ver): ${mimeType}, ${dims ? `${dims.width}x${dims.height} px, ` : ''}~${kb} KB. `
  const blocker = toolResultImageBlocker(kind, capability.model, capability.visionCapable)
  if (blocker) return noImage(blocker, meta)
  if (!TOOL_RESULT_IMAGE_MIME_TYPES.has(mimeType)) return noImage(`el formato ${mimeType} no lo aceptan los proveedores de modelos`, meta)
  const limit = IMAGE_SIZE_LIMIT_BYTES[kind]
  if (parsed.base64.length > limit) {
    const actualMb = (parsed.base64.length / (1024 * 1024)).toFixed(1)
    const limitMb = (limit / (1024 * 1024)).toFixed(0)
    return noImage(`la imagen pesa ~${actualMb}MB (base64) y supera el limite de ${limitMb}MB de este proveedor`, meta)
  }
  return { text: result.output, image: { mimeType, base64: parsed.base64, dataUrl: `data:${mimeType};base64,${parsed.base64}` } }
}

/** Ventana de imagenes VIVAS de un turno (ver MAX_TOOL_RESULT_IMAGES_PER_TURN): cada runtime registra, por cada imagen que
 *  adjunta, un closure que la reemplaza EN SITIO por un aviso de texto; al superar el maximo se desaloja la mas vieja. */
class ToolImageWindow {
  private live: Array<() => void> = []

  add(evict: () => void): void {
    this.live.push(evict)
    while (this.live.length > MAX_TOOL_RESULT_IMAGES_PER_TURN) this.live.shift()!()
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

/**
 * Fix real (bug reportado por el usuario en vivo, reproducido y confirmado
 * con evidencia real antes de este fix): la API de Gemini rechaza con 400
 * real cualquier metacampo de nivel de JSON Schema que empiece con `$`
 * (`$schema`/`$id`/`$ref`/`$comment`/`$defs`/etc. -- convencion estandar
 * de JSON Schema, NO un error del emisor) -- "Unknown name "$schema" at
 * '...': Cannot find field." Confirmado real que NO es ninguna tool propia
 * de Amatista (las 26 nativas de tool-registry.ts nunca tienen `$schema`,
 * confirmado con grep) -- es `inputSchema` real de un servidor MCP externo
 * (`mcp-client.ts:listToolDefinitions()`, pasado tal cual por diseño, ver
 * el comentario de esa funcion) que legitimamente incluye `$schema` por
 * generarlo con herramientas estandar de JSON Schema. Anthropic/OpenAI/
 * Foundry TOLERAN el mismo campo sin problema (confirmado indirecto: el
 * error solo se reprodujo con Gemini) -- por eso el fix es SOLO aca,
 * `anthropicTools()`/`foundryTools()`/`openAiTools()` de arriba quedan sin
 * tocar a proposito.
 *
 * `stripDollarKeysForGemini()` filtra CUALQUIER clave que empiece con `$`,
 * no solo `$schema` puntual -- generico a proposito, para que un servidor
 * MCP futuro con otro metacampo (`$id`/`$ref`/etc, mismo problema real)
 * tampoco rompa. Recursivo (objetos anidados Y arrays, ej. `items` de un
 * array de sub-schemas) -- un JSON Schema real puede anidar sub-schemas en
 * cualquier profundidad, un filtro de un solo nivel no alcanzaria.
 */
function stripDollarKeysForGemini(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripDollarKeysForGemini)
  if (value && typeof value === 'object') {
    const result: Record<string, unknown> = {}
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      if (key.startsWith('$')) continue
      result[key] = stripDollarKeysForGemini(val)
    }
    return result
  }
  return value
}

/**
 * Hallazgo 3 de la 4ta revision externa (docs/_arch/verify_external_review_4_findings.md),
 * confirmado real y reproducido en vivo (docs/_arch/verify_gemini_ref_resolution_design.md):
 * stripDollarKeysForGemini() de arriba borra CUALQUIER clave que empiece con
 * `$` -- incluido `$ref`, que a diferencia de `$schema`/`$id`/`$comment` (metadatos
 * descartables) es una referencia REAL a una definicion reusable en `$defs`/
 * `definitions`. Borrarlo sin mas deja una propiedad con restricciones reales
 * (ej. un enum) convertida en `{}` -- perdida silenciosa de validacion, sin
 * ningun error. Confirmado real contra la API real de Gemini (autotest
 * temporal, key real nunca vista) que Gemini rechaza `$ref`/`$defs` igual que
 * rechazaba `$schema` originalmente -- mismo mensaje generico "Unknown
 * name... Cannot find field" -- asi que no alcanza con excluirlos del strip,
 * hace falta RESOLVERLOS (inlinear la definicion real) antes.
 *
 * `$ref` en JSON Schema es un JSON Pointer ABSOLUTO contra la raiz del
 * documento (`#/$defs/X` se resuelve igual sin importar en que profundidad
 * este el `$ref` que apunta ahi) -- por eso la tabla de definiciones se arma
 * UNA sola vez, desde la raiz, nunca por nivel de recursion. Soporta
 * `$defs` (JSON Schema 2019-09+) y `definitions` (Draft-07, legacy) -- las
 * 2 convenciones reales que un generador de schema puede emitir.
 *
 * Ciclos reales (un `$defs` puede autoreferenciarse a proposito, ej. un
 * arbol/lista enlazada: `Node.next -> $ref Node`): `inProgress` (Set de
 * nombres en resolucion en la rama actual) corta la expansion al reencontrar
 * un nombre ya en curso -- nunca cuelga ni crashea. No es una limitacion de
 * este fix: Gemini no tiene forma de representar recursion genuina en su
 * formato plano de `parameters` (no soporta `$ref` en absoluto), asi que
 * cortar ahi es lo maximo que se puede hacer -- esa ocurrencia puntual
 * degrada a `{}` (mismo camino que un `$ref` no soportado, ver abajo).
 * `maxDepth` es un backstop adicional (nunca deberia disparar si `inProgress`
 * funciona bien) -- mismo criterio de "cinturon y tirantes" ya usado en este
 * proyecto para timeouts (GIT_TIMEOUT_MS, CODEX_TURN_TIMEOUT_MS).
 *
 * `$ref` no-local (URL externa, JSON Pointer con mas de un segmento,
 * `$id`-based) -- fuera de alcance a proposito (no hay forma segura de
 * fetch remoto desde un schema de tool, ni conviene: superficie de red no
 * controlada). Degrada a `{}` igual que hoy, pero con un `console.warn` real
 * -- a diferencia del silencio total de hoy, deja rastro si un servidor MCP
 * real llega a traer un `$ref` de esta forma.
 *
 * Claves HERMANAS junto a `$ref` (JSON Schema 2019-09+ lo permite, aunque
 * ningun generador real visto hasta ahora en este proyecto lo hace) se
 * mergean sobre la definicion resuelta, ganando las hermanas -- semantica
 * mas moderna/correcta, caso raro en la practica.
 */
const JSON_SCHEMA_REF_MAX_DEPTH = 20

function localRefName(ref: string): string | undefined {
  const match = ref.match(/^#\/(?:\$defs|definitions)\/([^/]+)$/)
  return match ? match[1] : undefined
}

function resolveRefNode(
  value: unknown,
  defsTable: Map<string, unknown>,
  inProgress: Set<string>,
  depth: number
): unknown {
  if (depth > JSON_SCHEMA_REF_MAX_DEPTH) return value
  if (Array.isArray(value)) return value.map(item => resolveRefNode(item, defsTable, inProgress, depth + 1))
  if (!value || typeof value !== 'object') return value

  const node = value as Record<string, unknown>
  const ref = node.$ref
  if (typeof ref !== 'string') {
    const result: Record<string, unknown> = {}
    for (const [key, val] of Object.entries(node)) {
      result[key] = resolveRefNode(val, defsTable, inProgress, depth + 1)
    }
    return result
  }

  const siblings = Object.fromEntries(Object.entries(node).filter(([key]) => key !== '$ref'))
  const resolveSiblings = (): Record<string, unknown> =>
    Object.fromEntries(Object.entries(siblings).map(([key, val]) => [key, resolveRefNode(val, defsTable, inProgress, depth + 1)]))

  const name = localRefName(ref)
  if (!name || !defsTable.has(name)) {
    console.warn(`[gemini] $ref no resoluble (no-local o desconocido): "${ref}" -- se omite, la propiedad queda sin la restriccion real`)
    return resolveSiblings()
  }
  if (inProgress.has(name)) {
    console.warn(`[gemini] $ref ciclico detectado en "${ref}" -- se corta la expansion en esta rama`)
    return resolveSiblings()
  }

  inProgress.add(name)
  const resolved = resolveRefNode(structuredClone(defsTable.get(name)), defsTable, inProgress, depth + 1) as Record<string, unknown>
  inProgress.delete(name)

  return Object.keys(siblings).length === 0 ? resolved : { ...resolved, ...resolveSiblings() }
}

export function resolveJsonSchemaRefs(schema: unknown): unknown {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return schema
  const root = schema as Record<string, unknown>
  const defsTable = new Map<string, unknown>()
  for (const dictKey of ['$defs', 'definitions'] as const) {
    const dict = root[dictKey]
    if (dict && typeof dict === 'object' && !Array.isArray(dict)) {
      for (const [name, def] of Object.entries(dict as Record<string, unknown>)) defsTable.set(name, def)
    }
  }
  // Atajo barato -- SOLO si no hay NINGUN $ref en el schema (chequeo real
  // por substring, no solo defsTable.size): el caso comun, sin recorrer
  // nada de mas. Hallazgo real durante la verificacion: un `$defs` vacio
  // (defsTable.size===0) NO implica que no haya ningun `$ref` -- un `$ref`
  // externo/no-local puede aparecer SIN ningun `$defs` local en la raiz
  // (ej. una tool que referencia un schema remoto). Cortar solo por
  // defsTable.size dejaba ese caso sin pasar por resolveRefNode() -- el
  // $ref quedaba intacto hasta stripDollarKeysForGemini(), que lo borra
  // igual (mismo resultado final, `{}`) pero SIN el warning nuevo, porque
  // nunca pasaba por el camino que lo emite. Confirmado real en la
  // verificacion (Caso 4 sin warning la primera vez).
  if (defsTable.size === 0 && !JSON.stringify(schema).includes('"$ref"')) return schema
  // Hallazgo real durante la verificacion (docs/_arch/verify_gemini_ref_resolution_design.md):
  // sin esto, el walk generico de resolveRefNode() tambien recorre el
  // DICCIONARIO $defs/definitions crudo del nodo raiz (ya extraido a
  // defsTable arriba) -- resolviendo sus $ref internos de nuevo, de forma
  // completamente redundante (cualquier $ref real dentro de una definicion
  // ya se resuelve on-demand la primera vez que ALGO la referencia de
  // verdad, via defsTable). Confirmado real: sin este recorte, un ciclo
  // A<->B dispara 3 warnings en vez de 1 (el walk crudo de $defs.A/$defs.B
  // dispara sus propios warnings de ciclo, ademas del real). El diccionario
  // crudo nunca sobrevive de todos modos (stripDollarKeysForGemini() lo
  // descarta despues, misma clave con `$`) -- sacarlo ANTES del recorrido
  // es puro ahorro, sin cambiar el resultado final.
  const rootWithoutDefs: Record<string, unknown> = {}
  for (const [key, val] of Object.entries(root)) {
    if (key === '$defs' || key === 'definitions') continue
    rootWithoutDefs[key] = val
  }
  return resolveRefNode(rootWithoutDefs, defsTable, new Set(), 0)
}

export function geminiFunctionDeclarations(defs: ToolDefinition[]): unknown[] {
  return defs.map(def => ({
    name: def.name,
    description: def.description,
    parameters: stripDollarKeysForGemini(resolveJsonSchemaRefs(def.parameters))
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
  /** guard/ Pieza 2 (docs/_arch/verify_guard_design.md, Tarea 3): a
   *  diferencia de toolCallLog (arriba, texto RECORTADO a 300 chars para
   *  mostrar en UI/logs), esto hashea args/resultado COMPLETOS -- el
   *  truncado de toolCallLog perderia el hallazgo de diseño (2 resultados
   *  de paginacion distintos podrian compartir los primeros 300 chars y
   *  colisionar en un falso "sin progreso"). Mismo ciclo de vida que
   *  toolCallLog: vive y muere con el turno, reseteado en cada send(). */
  private toolCallSignatures: Array<{ turn: number; name: string; argsHash: string; resultHash: string }> = []
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
    this.toolCallSignatures = []
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

  /**
   * Cuantos bytes (base64) de UNA imagen puede adjuntar el runtime/modelo
   * ACTIVO dentro de un tool_result -- `undefined` si no puede adjuntar
   * ninguna. Desde F0 (verify_native_multimodal_tools_design.md) lo pueden
   * los 4 runtimes API, salvo un modelo sin vision (capabilities.vision ===
   * false) o un modelo Gemini anterior a la serie 3
   * (toolResultImageBlocker()). Misma fuente de verdad que resultImageFor():
   * ipc-agent.ts lo inyecta como ExecuteContext.resultImageMaxBytes, asi
   * read_document (tool-registry.ts, sin tocar) dice la verdad sobre si
   * adjunta la pagina escaneada.
   */
  toolResultImageMaxBytes(): number | undefined {
    if (!this.config) return undefined
    const { kind, model, visionCapable } = this.config
    return toolResultImageBlocker(kind, model, visionCapable) === null ? IMAGE_SIZE_LIMIT_BYTES[kind] : undefined
  }

  /** resultImageFor() con el modelo/vision de ESTA conexion (los 4 sendXxx lo usan por cada resultado de tool). */
  private toolResultImage(kind: ApiAgentKind, result: ToolExecutionResult): ResolvedToolResultImage {
    return resultImageFor(kind, result, { model: this.config?.model ?? '', visionCapable: this.config?.visionCapable })
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
    // Orquestador paralelo (docs/_arch/verify_parallel_orchestrator_design.md,
    // Tarea 5): parallel_ask suma a la MISMA lista/gating que send_to_window/
    // list_windows -- mismo criterio exacto (solo el chat "principal" del
    // workspace dispara turnos en otros paneles), ningun mecanismo nuevo.
    const orchestratorToolNames = ['send_to_window', 'list_windows', 'parallel_ask']
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
    // Familia A (computer use) y navegador embebido: hasta F0 (docs/_arch/
    // verify_native_multimodal_tools_design.md) `screenshot`/`mouse_*`/
    // `keyboard_type` y `browser_screenshot` se ocultaban aca para todo
    // runtime que no fuera `anthropic-api`, porque solo ese armaba la imagen
    // dentro del tool_result. Con resultImageFor() (chokepoint de imagen en
    // resultados de tools) los 4 runtimes la arman, asi que el filtro por
    // `kind` ya no tiene motivo y se quito. Un modelo SIN vision
    // (capabilities.vision === false) o un Gemini anterior a la serie 3 sigue
    // teniendo las tools disponibles: screenshot/browser_screenshot le
    // devuelven metadata honesta en texto en lugar de la imagen (nunca se
    // finge un adjunto) y las acciones semanticas (UI Automation/DOM) no
    // dependen de ver.
    const native = TOOL_DEFINITIONS.filter(def =>
      !excluded.includes(def.name) &&
      !(hideOrchestratorTools && orchestratorToolNames.includes(def.name)) &&
      !(hideWebSearchTools && webSearchToolNames.includes(def.name)) &&
      !(hidePlanModeTools && planModeToolNames.includes(def.name))
    )
    if (DEBUG_TOOLS) {
      console.log(
        `[apiRuntime] toolCatalog isPrincipalChat=${Boolean(this.config?.isPrincipalChat)} ` +
        `send_to_window/list_windows/parallel_ask incluidas=${!hideOrchestratorTools} ` +
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
   * guard/ Pieza 2 (docs/_arch/verify_guard_design.md, Tareas 3-4): hashea
   * args/resultado COMPLETOS (hashFileContent, ya en produccion para TOCTOU
   * de write_file/apply_patch, exportada de tool-registry.ts para este uso
   * nuevo) -- NO el preview recortado de logToolCall/toolCallLog. Devuelve
   * cuantas llamadas SEGUIDAS (contando la actual) comparten exactamente
   * {name, argsHash, resultHash} -- si el resultado cambia aunque sea un
   * caracter (polling/paginacion legitimos), el hash cambia y la racha se
   * corta en 1. Solo mismo args Y mismo resultado, repetido, cuenta como
   * "sin progreso".
   */
  private registerToolCallSignature(turn: number, name: string, args: unknown, result: ToolExecutionResult): number {
    const argsHash = hashFileContent(JSON.stringify(args ?? null))
    const resultHash = hashFileContent(JSON.stringify({ ok: result.ok, output: result.output }))
    this.toolCallSignatures.push({ turn, name, argsHash, resultHash })
    let streak = 0
    for (let i = this.toolCallSignatures.length - 1; i >= 0; i--) {
      const entry = this.toolCallSignatures[i]
      if (entry.name === name && entry.argsHash === argsHash && entry.resultHash === resultHash) {
        streak++
      } else {
        break
      }
    }
    return streak
  }

  /** guard/ Pieza 2: empujon, NO error -- se agrega al `output` que YA
   *  vuelve al modelo como tool_result (mismo campo que lee cada uno de los
   *  4 loops de tool-calling), nunca corta la corrida. Se repite cada vez
   *  que la racha vuelve a ser multiplo de LOOP_HYGIENE_THRESHOLD (3, 6, 9,
   *  ...) en vez de en cada llamada tras el umbral -- recuerda sin
   *  inundar el tool_result de avisos identicos si el modelo insiste. */
  private loopHygieneNotice(name: string, streak: number): string | undefined {
    if (streak < LOOP_HYGIENE_THRESHOLD || streak % LOOP_HYGIENE_THRESHOLD !== 0) return undefined
    return `\n\n[Aviso del sistema: la tool "${name}" fue llamada con los mismos argumentos y devolvio ` +
      `EXACTAMENTE el mismo resultado ${streak} veces seguidas. Esto no esta generando progreso real -- ` +
      'cambia de enfoque antes de volver a intentarlo (revisa si el resultado ya contiene la respuesta, ' +
      'o si esta tool no es la adecuada para lo que estas buscando).]'
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
      // guard/ Pieza 2 (docs/_arch/verify_guard_design.md): registrado ACA,
      // tras logToolCall, para que toolCallLog y toolCallSignatures queden
      // en el mismo orden exacto -- pero el aviso (si corresponde) se suma
      // al `output` que YA vuelve al modelo, nunca se lanza como error ni
      // corta el turno.
      const streak = this.registerToolCallSignature(turn, name, args, result)
      const notice = this.loopHygieneNotice(name, streak)
      return notice ? { ...result, output: `${result.output}${notice}` } : result
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
    const maxToolLoop = this.config.maxToolLoop ?? MAX_TOOL_LOOP
    const imageWindow = new ToolImageWindow()

    for (let turn = 0; turn < maxToolLoop; turn++) {
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
        // Responses API (OpenAI directo y Azure/Foundry v1, mismo esquema):
        // `output` acepta string O un array de input_text/input_image/
        // input_file -- resultImageFor() decide si va la imagen (F0).
        const resolved = this.toolResultImage('foundry', result)
        const output: unknown = resolved.image
          ? [{ type: 'input_text', text: resolved.text }, { type: 'input_image', image_url: resolved.image.dataUrl }]
          : resolved.text
        input.push({ type: 'function_call_output', call_id: callId, output })
        if (resolved.image) imageWindow.add(() => { (output as unknown[])[1] = { type: 'input_text', text: EVICTED_IMAGE_NOTICE } })
      }
    }

    throw new Error(
      `Se alcanzo el limite de ${maxToolLoop} iteraciones de tool calling sin respuesta final.\n` +
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
    const maxToolLoop = this.config.maxToolLoop ?? MAX_TOOL_LOOP
    const imageWindow = new ToolImageWindow()

    for (let turn = 0; turn < maxToolLoop; turn++) {
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
        // Formato documentado (Gemini 3, "Multimodal function responses"):
        //  - `id` del functionCall devuelto en functionResponse.id -- Gemini 3
        //    SIEMPRE lo manda y empareja por el (llamadas paralelas pueden
        //    volver en cualquier orden); modelos anteriores no lo traen y ahi
        //    simplemente se omite.
        //  - imagen en functionResponse.parts[].inlineData (solo Gemini 3+;
        //    resultImageFor() degrada a metadata honesta para el resto).
        const resolved = this.toolResultImage('gemini-api', result)
        const functionResponse: Record<string, unknown> = { name: toolName, response: { content: resolved.text } }
        const callId = asString(callRecord.id)
        if (callId) functionResponse.id = callId
        if (resolved.image) {
          functionResponse.parts = [{ inlineData: { mimeType: resolved.image.mimeType, data: resolved.image.base64 } }]
          imageWindow.add(() => {
            delete functionResponse.parts
            functionResponse.response = { content: `${resolved.text}\n${EVICTED_IMAGE_NOTICE}` }
          })
        }
        responseParts.push({ functionResponse })
      }
      // role:"user" (el enum documentado de Content.role es user|model; el
      // "function" que se mandaba antes NO figura) -- todos los
      // functionResponse del turno del modelo en UN solo content.
      contents.push({ role: 'user', parts: responseParts })
    }

    throw new Error(
      `Se alcanzo el limite de ${maxToolLoop} iteraciones de tool calling sin respuesta final.\n` +
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
    const maxToolLoop = this.config.maxToolLoop ?? MAX_TOOL_LOOP
    const imageWindow = new ToolImageWindow()

    for (let turn = 0; turn < maxToolLoop; turn++) {
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
        // Imagen dentro del tool_result (read_document escaneado, screenshot,
        // browser_screenshot): resultImageFor() es el chokepoint unico de los
        // 4 runtimes (mismo guard de tamano IMAGE_SIZE_LIMIT_BYTES/
        // parseDataUrl que ya usaba esta rama). Cuando la imagen viaja, el
        // bloque es EXACTAMENTE el de siempre ([text, image base64]); cuando
        // no viaja (modelo sin vision, o imagen que excede el limite -- el
        // caso que antes se omitia en silencio dejando el texto afirmando el
        // adjunto), el texto ya trae el aviso honesto.
        const resolved = this.toolResultImage('anthropic-api', result)
        const content: unknown = resolved.image
          ? [
              { type: 'text', text: resolved.text },
              { type: 'image', source: { type: 'base64', media_type: resolved.image.mimeType, data: resolved.image.base64 } }
            ]
          : resolved.text
        resultBlocks.push({ type: 'tool_result', tool_use_id: toolUseId, content })
        if (resolved.image) imageWindow.add(() => { (content as unknown[])[1] = { type: 'text', text: EVICTED_IMAGE_NOTICE } })
      }
      messages.push({ role: 'user', content: resultBlocks })
    }

    throw new Error(
      `Se alcanzo el limite de ${maxToolLoop} iteraciones de tool calling sin respuesta final.\n` +
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
    const maxToolLoop = this.config.maxToolLoop ?? MAX_TOOL_LOOP
    const imageWindow = new ToolImageWindow()

    for (let turn = 0; turn < maxToolLoop; turn++) {
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
      // Chat Completions NO admite imagen en un mensaje role:"tool" (solo
      // partes de texto, documentacion oficial): la imagen viaja en UN
      // mensaje `user` con image_url DESPUES de todos los `tool` del turno
      // (los `tool` deben seguir contiguos al `assistant` con tool_calls, uno
      // por tool_call_id). Es el unico patron que funciona en OpenAI, Azure y
      // los proveedores compatibles (OpenRouter, etc.).
      const pendingImages: Array<{ toolName: string; callId: string; image: ToolResultImage }> = []
      for (const call of toolCalls) {
        if (signal.aborted) throw new TurnCancelledError(partialText)
        const callRecord = asRecord(call)
        const callId = asString(callRecord.id)
        const functionRecord = asRecord(callRecord.function)
        const toolName = asString(functionRecord.name)
        const args = safeJsonParse(asString(functionRecord.arguments))
        const result = await this.runTool(turn, toolName, args)
        if (signal.aborted) throw new TurnCancelledError(partialText)
        const resolved = this.toolResultImage('openai-chat', result)
        messages.push({
          role: 'tool',
          tool_call_id: callId,
          content: resolved.image ? `${resolved.text}\n[La imagen de este resultado se adjunta en el mensaje siguiente.]` : resolved.text
        })
        if (resolved.image) pendingImages.push({ toolName, callId, image: resolved.image })
      }
      if (pendingImages.length > 0) {
        const parts: unknown[] = []
        for (const pending of pendingImages) {
          parts.push({ type: 'text', text: `Imagen devuelta por la tool "${pending.toolName}" (tool_call_id ${pending.callId}):` })
          const imagePartIndex = parts.push({ type: 'image_url', image_url: { url: pending.image.dataUrl } }) - 1
          imageWindow.add(() => { parts[imagePartIndex] = { type: 'text', text: EVICTED_IMAGE_NOTICE } })
        }
        messages.push({ role: 'user', content: parts })
      }
    }

    throw new Error(
      `Se alcanzo el limite de ${maxToolLoop} iteraciones de tool calling sin respuesta final.\n` +
      `Ultimas tool calls de este turno:\n${this.recentToolCallsSummary()}`
    )
  }

  stop(): void {
    this.removeAllListeners()
  }
}
