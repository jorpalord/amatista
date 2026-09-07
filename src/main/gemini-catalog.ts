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
// minima de generateContent por candidato, 200 = usable, 404 (u otro
// error) = descartado. Concurrencia acotada, mismo motivo que Claude:
// nunca las N llamadas juntas, evita parecer trafico abusivo contra la
// cuenta real del usuario.
import { fetchWithTimeout, readErrorBody } from './api-agent-runtime'

export interface GeminiCatalogModel {
  id: string
  displayName: string
}

const GEMINI_API_ROOT = 'https://generativelanguage.googleapis.com/v1beta'
const GEMINI_VERIFY_CONCURRENCY = 5

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
 * Verificacion real minima por candidato -- POST generateContent con un
 * prompt casi nulo y `maxOutputTokens` bajo (costo real minimo, nunca
 * gratis pero acotado a proposito). 200 real = el modelo esta genuinamente
 * vivo y accesible con esta key; 404 (el codigo real confirmado para un
 * modelo apagado, ver cabecera) o cualquier otro error = descartado en
 * silencio, mismo criterio que verifyClaudeModel() -- nunca se agrega un
 * candidato sin confirmar.
 */
async function verifyGeminiModel(resourceName: string, apiKey: string): Promise<boolean> {
  try {
    const response = await fetchWithTimeout(`${GEMINI_API_ROOT}/${resourceName}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify({
        contents: [{ parts: [{ text: 'hi' }] }],
        generationConfig: { maxOutputTokens: 1 }
      })
    })
    return response.ok
  } catch {
    return false
  }
}

export async function listGeminiModels(apiKey: string): Promise<GeminiCatalogModel[]> {
  const key = apiKey.trim()
  if (!key) throw new Error('Gemini requiere API key para listar modelos.')

  const candidates = await fetchGeminiCandidates(key)

  const confirmed: GeminiCatalogModel[] = []
  for (let i = 0; i < candidates.length; i += GEMINI_VERIFY_CONCURRENCY) {
    const batch = candidates.slice(i, i + GEMINI_VERIFY_CONCURRENCY)
    const results = await Promise.all(batch.map(async candidate =>
      (await verifyGeminiModel(candidate.resourceName, key)) ? candidate : null
    ))
    for (const candidate of results) {
      if (candidate) confirmed.push({ id: candidate.id, displayName: candidate.displayName })
    }
  }
  return confirmed
}
