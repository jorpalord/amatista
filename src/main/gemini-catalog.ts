// Catalogo real de modelos para conexiones Google/Gemini (type:'google') --
// mismo espiritu que foundry-catalog.ts/model-discovery.ts (descubrimiento
// real, nunca inventado), pero ARCHIVO PROPIO a proposito: auth real
// DISTINTA a los otros 2 catalogos de hoy -- header `x-goog-api-key`, ni
// `api-key` generico (Foundry) ni `Authorization: Bearer` (OpenAI-chat) --
// confirmado en la documentacion oficial real de Google
// (docs/_arch/verify_gemini_catalog_design.md).
//
// Hallazgo real confirmado en la investigacion (2 fuentes independientes:
// documentacion oficial de deprecaciones + un hilo real del foro oficial de
// desarrolladores de Gemini, "Gemini Models API Returns Deprecated/Retired
// Models -- Is There a Way to Identify Active Models?", SIN respuesta
// oficial de Google en el hilo): GET /v1beta/models devuelve modelos
// deprecados/retirados MEZCLADOS con los activos, sin ningun campo de
// estado/deprecacion en el objeto Model real (confirmado contra
// ai.google.dev/api/models -- name/displayName/description/
// supportedGenerationMethods/limites, nada de "status"/"deprecated").
// Casos reales confirmados: Gemini 2.0 Flash/2.0 Flash-Lite dados de baja
// el 1/jun/2026, Gemini 1.0/1.5 ya apagados -- devuelven 404 REAL a
// cualquier request, codigo determinista y barato de usar como señal.
//
// Por eso este archivo NO puede confiar solo en el catalogo estatico (a
// diferencia de Foundry, que si tiene un campo real "status"): filtro
// estructural barato primero (supportedGenerationMethods), despues
// verificacion real por candidato (mismo criterio que
// discoverNewClaudeModels() en model-discovery.ts) -- una llamada real
// minima de generateContent por candidato, tri-estado real por status
// (Hallazgo 5 de la 4ta revision externa, ver mas abajo): 200 = confirmed,
// 404 EXACTO = unavailable (retirado real), cualquier otro no-200
// (429/503/500/403/400/timeout/red) = inconclusive, nunca se afirma
// "retirado" sin un 404 real. Concurrencia acotada, mismo motivo que
// Claude: nunca las N llamadas juntas, evita parecer trafico abusivo
// contra la cuenta real del usuario.
import { fetchWithTimeout, readErrorBody } from './api-agent-runtime'

export interface GeminiCatalogModel {
  id: string
  displayName: string
}

/**
 * Hallazgo 5 de la 4ta revision externa (docs/_arch/
 * verify_gemini_inconclusive_states_design.md), confirmado real con codigo
 * real: verifyGeminiModel() usaba response.ok puro (solo 2xx) -- 404
 * (retirado real), 429/503 (rate-limit/no-disponible transitorio), 403/400
 * (error de request/permiso) y timeout/red quedaban TODOS indistinguibles,
 * descartados en silencio del catalogo como si fueran lo mismo que un 404
 * real. Tri-estado real: `confirmed` (200), `unavailable` (404 EXACTO, la
 * unica senal real y deterministica de retiro confirmada en la
 * investigacion original), `inconclusive` (cualquier otro resultado no-200
 * no-404 -- deliberadamente amplio, nunca se afirma "retirado" sin un 404
 * real).
 */
type GeminiVerificationOutcome = 'confirmed' | 'unavailable' | 'inconclusive'

interface GeminiVerificationResult {
  outcome: GeminiVerificationOutcome
  /** status HTTP real observado -- ausente para timeout/error de red (nunca hubo response real). */
  status?: number
}

export interface GeminiInconclusiveModel {
  id: string
  displayName: string
  status?: number
}

export interface GeminiCatalogResult {
  confirmed: GeminiCatalogModel[]
  unavailableCount: number
  inconclusive: GeminiInconclusiveModel[]
}

const GEMINI_API_ROOT = 'https://generativelanguage.googleapis.com/v1beta'
const GEMINI_VERIFY_CONCURRENCY = 5

// Clases reales que la documentacion oficial de Google marca como
// reintentables con backoff -- 403/400 (error de permiso/request) NUNCA se
// reintentan, el mismo body identico no puede dar un resultado distinto.
const RETRYABLE_STATUSES = new Set([429, 500, 503])
const MAX_RETRIES = 2                        // hasta 3 intentos totales por candidato
const RETRY_BACKOFF_MS = [800, 2000]         // backoff real, creciente, entre reintentos

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : {}
}

interface GeminiCandidate {
  /** Nombre real completo del recurso, ej. "models/gemini-2.5-pro" --
   *  necesario tal cual para la URL real de generateContent (verifyGeminiModel). */
  resourceName: string
  /** `resourceName` sin el prefijo "models/" -- lo que se guarda en
   *  model.model, mismo formato que el resto de la app ya usa para
   *  Gemini (via Antigravity). */
  id: string
  displayName: string
}

/**
 * Filtro estructural barato (sin request extra): descarta cualquier Model
 * cuyo `supportedGenerationMethods` real no incluya `generateContent` --
 * elimina modelos que estructuralmente no sirven para chat (embeddings,
 * etc.), mismo espiritu que el filtro `status==='succeeded'` de Foundry.
 * NO resuelve por si solo el hallazgo real de deprecados-pero-listados
 * (ver comentario de cabecera) -- eso lo hace verifyGeminiModel() despues.
 */
async function fetchGeminiCandidates(apiKey: string): Promise<GeminiCandidate[]> {
  const url = `${GEMINI_API_ROOT}/models?pageSize=1000`
  const response = await fetchWithTimeout(url, {
    method: 'GET',
    headers: { 'x-goog-api-key': apiKey }
  })
  if (!response.ok) {
    throw new Error(`GET ${url} falló ${response.status}: ${await readErrorBody(response)}`)
  }

  const raw = await response.json() as unknown
  const record = asRecord(raw)
  const models = record.models
  if (!Array.isArray(models)) return []

  return models
    .map(item => {
      const model = asRecord(item)
      const resourceName = typeof model.name === 'string' ? model.name : undefined
      if (!resourceName) return null
      const methods = model.supportedGenerationMethods
      if (!Array.isArray(methods) || !methods.includes('generateContent')) return null
      const id = resourceName.replace(/^models\//, '')
      const displayName = typeof model.displayName === 'string' && model.displayName.trim() ? model.displayName : id
      return { resourceName, id, displayName }
    })
    .filter((item): item is GeminiCandidate => item !== null)
}

/**
 * Un solo intento real -- POST generateContent con un prompt casi nulo y
 * `maxOutputTokens` bajo (costo real minimo, nunca gratis pero acotado a
 * proposito). Inspecciona el status real de la respuesta en vez de
 * `response.ok` puro (fix del Hallazgo 5) -- ver el tri-estado documentado
 * en la cabecera del archivo.
 */
async function verifyGeminiModelOnce(resourceName: string, apiKey: string): Promise<GeminiVerificationResult> {
  try {
    const response = await fetchWithTimeout(`${GEMINI_API_ROOT}/${resourceName}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify({
        contents: [{ parts: [{ text: 'hi' }] }],
        generationConfig: { maxOutputTokens: 1 }
      })
    })
    if (response.ok) return { outcome: 'confirmed', status: response.status }
    if (response.status === 404) return { outcome: 'unavailable', status: 404 }
    return { outcome: 'inconclusive', status: response.status }
  } catch {
    return { outcome: 'inconclusive' }
  }
}

/**
 * Envuelve verifyGeminiModelOnce() con reintento real acotado -- solo para
 * las 3 clases que Google documenta como reintentables (429/500/503) o
 * timeout/error de red (nunca hubo respuesta real que pudiera ser
 * definitiva). Un 403/400 (u otro no-retryable) nunca se reintenta, el
 * mismo body identico no puede dar un resultado distinto la 2da vez.
 */
async function verifyGeminiModel(resourceName: string, apiKey: string): Promise<GeminiVerificationResult> {
  let last: GeminiVerificationResult = { outcome: 'inconclusive' }
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    last = await verifyGeminiModelOnce(resourceName, apiKey)
    const retryable = last.outcome === 'inconclusive' && (last.status === undefined || RETRYABLE_STATUSES.has(last.status))
    if (last.outcome !== 'inconclusive' || !retryable || attempt === MAX_RETRIES) return last
    await sleep(RETRY_BACKOFF_MS[attempt])
  }
  return last
}

export async function listGeminiModels(apiKey: string): Promise<GeminiCatalogResult> {
  const key = apiKey.trim()
  if (!key) throw new Error('Gemini requiere API key para listar modelos.')

  const candidates = await fetchGeminiCandidates(key)

  const confirmed: GeminiCatalogModel[] = []
  let unavailableCount = 0
  const inconclusive: GeminiInconclusiveModel[] = []

  for (let i = 0; i < candidates.length; i += GEMINI_VERIFY_CONCURRENCY) {
    const batch = candidates.slice(i, i + GEMINI_VERIFY_CONCURRENCY)
    const results = await Promise.all(batch.map(async candidate => ({
      candidate,
      result: await verifyGeminiModel(candidate.resourceName, key)
    })))
    for (const { candidate, result } of results) {
      if (result.outcome === 'confirmed') {
        confirmed.push({ id: candidate.id, displayName: candidate.displayName })
      } else if (result.outcome === 'unavailable') {
        unavailableCount++
      } else {
        inconclusive.push({ id: candidate.id, displayName: candidate.displayName, status: result.status })
      }
    }
  }
  return { confirmed, unavailableCount, inconclusive }
}
