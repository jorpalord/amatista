// Feature "busqueda web" (docs/_arch/verify_web_search_design.md): motor
// real de web_search/web_fetch via Tavily (docs.tavily.com) -- confirmado
// real contra la documentacion oficial de la API antes de implementar
// (endpoints, campos de request/response y forma real de los errores).
// Logica PARALELA a compaction-engine.ts/image-generation.ts, no comparte
// funciones con ellos -- mismo criterio ya establecido en este codebase
// para no acoplar features independientes por conveniencia.
import { fetchWithTimeout } from './api-agent-runtime'
import type { AppSettings } from '../shared/types'

const TAVILY_SEARCH_URL = 'https://api.tavily.com/search'
const TAVILY_EXTRACT_URL = 'https://api.tavily.com/extract'

export type TavilySettings = Pick<AppSettings, 'integrations'>

/** undefined = sin credencial configurada -- ver hasTavilyIntegration() para
 *  el chequeo booleano que consume el gating real (ApiAgentRuntime.toolCatalog()). */
export function resolveTavilyApiKey(settings: TavilySettings): string | undefined {
  return settings.integrations?.tavily?.apiKey?.trim() || undefined
}

/** Gating real (docs/_arch/verify_web_search_design.md, Tarea 3): mismo
 *  criterio que orchestratorToolNames/isPrincipalChat en toolCatalog() --
 *  sin credencial, web_search/web_fetch ni siquiera aparecen en el catalogo
 *  que se manda al modelo, nunca se le ofrece una tool que de todos modos
 *  fallaria. */
export function hasTavilyIntegration(settings: TavilySettings): boolean {
  return Boolean(resolveTavilyApiKey(settings))
}

/**
 * Forma real de los errores de Tavily -- confirmado con una llamada REAL
 * a api.tavily.com/search con una key invalida (docs/_arch/verify_
 * web_search_design.md, verificacion, no solo documentacion oficial):
 * el 401 real devuelve `{"detail":{"error":"Unauthorized: ..."}}` --
 * un nivel MAS anidado de lo asumido originalmente (`{error: string}`
 * plano). `record.error` sigue soportado como fallback plano por si otro
 * endpoint de Tavily difiere; `record.detail` ahora se desarma si es un
 * objeto con su propio `.error`/`.message` string, ademas de aceptarlo
 * directo si ya es string. De todos modos distinto del `{error:{message}}`
 * que usan Anthropic/OpenAI/Foundry (readErrorBody() de
 * api-agent-runtime.ts), por eso esta funcion sigue siendo propia.
 */
async function readTavilyErrorBody(response: Response): Promise<string> {
  try {
    const parsed = await response.clone().json() as unknown
    if (parsed && typeof parsed === 'object') {
      const record = parsed as Record<string, unknown>
      const direct = record.error ?? record.detail ?? record.message
      if (typeof direct === 'string' && direct.trim()) return direct.trim()
      if (direct && typeof direct === 'object') {
        const nested = direct as Record<string, unknown>
        const nestedCandidate = nested.error ?? nested.message
        if (typeof nestedCandidate === 'string' && nestedCandidate.trim()) return nestedCandidate.trim()
      }
    }
    return JSON.stringify(parsed).slice(0, 500)
  } catch {
    return (await response.text()).slice(0, 500)
  }
}

/** Mensaje real y accionable segun el status HTTP real de Tavily --
 *  confirmado real (401/403 = key invalida/faltante, 429 = limite de
 *  cuota/rate limit alcanzado) -- ninguno de los 2 debe verse como un
 *  crash generico ("fetch failed"/stack trace), mismo criterio ya
 *  establecido para get_diagnostics/find_definition (mensajes claros en
 *  vez de fallar en silencio). */
async function tavilyErrorMessage(response: Response, action: string): Promise<string> {
  const body = await readTavilyErrorBody(response)
  if (response.status === 401 || response.status === 403) {
    return `Tavily rechazo la API key (HTTP ${response.status}) al intentar ${action} -- confirma que la key configurada en Configuracion es real y esta activa. Detalle: ${body}`
  }
  if (response.status === 429) {
    return `Tavily alcanzo el limite de uso (HTTP 429) al intentar ${action} -- esperá un momento o revisá tu plan/cuota en Tavily. Detalle: ${body}`
  }
  return `Tavily fallo (HTTP ${response.status}) al intentar ${action}: ${body}`
}

export interface WebSearchResultItem {
  title: string
  url: string
  content: string
}

export interface WebSearchResult {
  answer?: string
  results: WebSearchResultItem[]
}

/**
 * POST /search real -- confirmado contra la documentacion oficial de
 * Tavily: Authorization: Bearer <key>, body {query, max_results}. Respuesta
 * real: `results[]` (title/url/content/score), `answer` SOLO si se pide
 * `include_answer` (se pide siempre aca, string corto real generado por
 * Tavily ademas de los resultados crudos -- mas util para el modelo que
 * solo la lista).
 */
export async function tavilySearch(
  settings: TavilySettings,
  query: string,
  maxResults?: number
): Promise<{ ok: true; result: WebSearchResult } | { ok: false; error: string }> {
  const apiKey = resolveTavilyApiKey(settings)
  if (!apiKey) return { ok: false, error: 'Tavily no tiene una API key configurada -- agregala en Configuracion antes de usar web_search.' }

  let response: Response
  try {
    response = await fetchWithTimeout(TAVILY_SEARCH_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        query,
        max_results: maxResults && maxResults > 0 ? Math.min(Math.floor(maxResults), 20) : undefined,
        include_answer: true
      })
    })
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }

  if (!response.ok) return { ok: false, error: await tavilyErrorMessage(response, `buscar "${query}"`) }

  const json = await response.json() as { answer?: string; results?: Array<{ title?: string; url?: string; content?: string }> }
  const results = (json.results ?? []).map(item => ({
    title: item.title ?? '(sin titulo)',
    url: item.url ?? '',
    content: item.content ?? ''
  }))
  return { ok: true, result: { answer: json.answer, results } }
}

export interface WebFetchResult {
  url: string
  content: string
}

/**
 * POST /extract real -- confirmado contra la documentacion oficial:
 * body {urls: [url], format: 'markdown'}. Respuesta real: `results[]`
 * (url/raw_content) para las que sI se pudieron extraer, `failed_results[]`
 * (url/error) para las que no -- una URL real que Tavily no pudo procesar
 * (bloqueada, timeout, formato no soportado) NO es un error HTTP (la
 * respuesta sigue siendo 200), asi que hay que revisar failed_results[]
 * explicitamente, no solo response.ok.
 */
export async function tavilyExtract(
  settings: TavilySettings,
  url: string
): Promise<{ ok: true; result: WebFetchResult } | { ok: false; error: string }> {
  const apiKey = resolveTavilyApiKey(settings)
  if (!apiKey) return { ok: false, error: 'Tavily no tiene una API key configurada -- agregala en Configuracion antes de usar web_fetch.' }

  let response: Response
  try {
    response = await fetchWithTimeout(TAVILY_EXTRACT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ urls: [url], format: 'markdown' })
    })
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }

  if (!response.ok) return { ok: false, error: await tavilyErrorMessage(response, `extraer "${url}"`) }

  const json = await response.json() as {
    results?: Array<{ url?: string; raw_content?: string }>
    failed_results?: Array<{ url?: string; error?: string }>
  }
  const success = json.results?.[0]
  if (success?.raw_content !== undefined) {
    return { ok: true, result: { url: success.url ?? url, content: success.raw_content } }
  }
  const failure = json.failed_results?.[0]
  return {
    ok: false,
    error: failure?.error
      ? `Tavily no pudo extraer "${url}": ${failure.error}`
      : `Tavily no devolvio contenido para "${url}" (ni exito ni error explicito en la respuesta).`
  }
}
