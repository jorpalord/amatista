// Feature "generacion de imagenes" (docs/_arch/verify_image_generation.md,
// Tarea 0; docs/_arch/verify_gemini_image_generation_design.md para el
// backend de Gemini). Motor real: resuelve el modelo configurado (mismo
// patron que compaction-engine.ts, logica PARALELA -- no comparte
// funciones ni campos), y arma el ChatAttachment final reusando
// buildAttachmentFromDataUrl() tal cual -- sin cambios ahi. 2 backends
// reales, cada uno con su propio endpoint/shape (nunca comparten codigo de
// request/response, solo el armado final del attachment):
// - Foundry: POST {baseUrl}/images/generations (confirmado con evidencia
//   real: endpoint SEPARADO de /responses, respuesta con data[0].b64_json,
//   sin url).
// - Gemini: POST /v1beta/interactions (Interactions API, GA desde jun 2026
//   -- confirmado real que Nano Banana/Nano Banana 2 NO pasan por
//   generateContent, que sendGeminiApi() ya usa para texto/tools; shape de
//   respuesta completamente distinto, interaction.steps[]/model_output/
//   content[]/data).
import { buildAttachmentFromDataUrl } from './attachments'
import { asRecord, fetchWithTimeout, normalizeFoundryBaseUrl, readErrorBody } from './api-agent-runtime'
import { isApiCapableModel, isLikelyImageModel } from '../shared/model-capabilities'
import type { AppSettings, ChatAttachment, ModelProfile, ProviderProfile } from '../shared/types'

export type ImageGenerationSettings = Pick<AppSettings, 'imageGenerationProviderId' | 'imageGenerationModelId' | 'providers'>

/**
 * Mismo shape de retorno que resolveConfiguredCompactionModel()
 * (compaction-engine.ts), pero SIN compartir codigo con ella -- logica
 * paralela a proposito (restriccion explicita del usuario), aunque la
 * forma sea identica.
 *
 * Con eleccion explicita del usuario (imageGenerationProviderId +
 * imageGenerationModelId ambos seteados): SIN fallback -- si el provider ya
 * no existe/esta deshabilitado, o el modelo idem, o dejo de ser
 * `isApiCapableModel()`, devuelve null. Mismo criterio "no adivinar" que ya
 * usa compactacion para una eleccion explicita rota.
 *
 * SIN ninguna eleccion explicita (los 2 campos undefined -- el usuario
 * nunca toco el selector): sugiere un default implicito, el primer modelo
 * habilitado de un provider habilitado que matchee isLikelyImageModel()
 * (heuristica sobre el nombre real del deployment, ver shared/
 * model-capabilities.ts) -- NUNCA se persiste solo, es una sugerencia en
 * tiempo de resolucion, no una escritura en settings.json.
 */
export function resolveConfiguredImageGenerationModel(
  settings: ImageGenerationSettings
): { provider: ProviderProfile; model: ModelProfile } | null {
  if (settings.imageGenerationProviderId || settings.imageGenerationModelId) {
    const provider = settings.providers.find(item => item.id === settings.imageGenerationProviderId && item.enabled)
    const model = provider?.models.find(item => item.id === settings.imageGenerationModelId && item.enabled)
    if (provider && model && isApiCapableModel(provider, model)) return { provider, model }
    return null
  }

  for (const provider of settings.providers) {
    if (!provider.enabled) continue
    const model = provider.models.find(item => item.enabled && isApiCapableModel(provider, item) && isLikelyImageModel(item))
    if (model) return { provider, model }
  }
  return null
}

type GenerateImageResult = { ok: true; attachment: ChatAttachment } | { ok: false; error: string }

/**
 * Generico por `mimeType`/extension real -- Foundry devuelve PNG real
 * (`gpt-image-2`), Gemini devuelve JPEG real (ver comentario de
 * generateImageViaGemini() mas abajo, hallazgo real: la doc de Google decia
 * "image/png" en `response_format.mime_type`, la API real solo acepta
 * "image/jpeg" para ese campo -- confirmado con un 400 real). Un solo
 * helper para los 2 backends, en vez de asumir PNG siempre.
 */
function attachmentFromBase64Image(b64: string, mimeType: string, extension: string): ChatAttachment {
  const dataUrl = `data:${mimeType};base64,${b64}`
  const name = `generada-${Date.now()}.${extension}`
  return { ...buildAttachmentFromDataUrl({ name, dataUrl }), origin: 'generated' }
}

/**
 * Llamada real, confirmada contra Foundry en la investigacion (Tarea 1):
 * POST {baseUrl}/images/generations, mismo header `api-key` que /responses
 * pero un endpoint genuinamente distinto -- gpt-image-2 responde 400
 * "unsupported" contra /responses. Respuesta real: `data[0].b64_json`
 * (base64 inline, SIN campo url).
 */
async function generateImageViaFoundry(provider: ProviderProfile, model: ModelProfile, prompt: string): Promise<GenerateImageResult> {
  const apiKey = provider.apiKey?.trim()
  if (!apiKey) return { ok: false, error: 'Foundry requiere API key para generar imagenes.' }

  const baseUrl = normalizeFoundryBaseUrl(provider.endpoint)

  let response: Response
  try {
    response = await fetchWithTimeout(`${baseUrl}/images/generations`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'api-key': apiKey
      },
      body: JSON.stringify({
        model: model.model,
        prompt,
        size: '1024x1024',
        n: 1
      })
    })
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }

  if (!response.ok) {
    return { ok: false, error: `Foundry /images/generations fallo ${response.status}: ${await readErrorBody(response)}` }
  }

  const json = await response.json() as { data?: Array<{ b64_json?: string }> }
  const b64 = json.data?.[0]?.b64_json
  if (!b64) return { ok: false, error: 'Foundry no devolvio ninguna imagen en la respuesta.' }

  return { ok: true, attachment: attachmentFromBase64Image(b64, 'image/png', 'png') }
}

/**
 * Llamada real a la Interactions API de Gemini (docs/_arch/
 * verify_gemini_image_generation_design.md) -- endpoint NUEVO y
 * ESTRUCTURALMENTE DISTINTO al `generateContent` que sendGeminiApi() ya usa
 * para texto/tools (api-agent-runtime.ts) -- Nano Banana/Nano Banana 2
 * (gemini-3.1-flash-image, etc.) NO pasan por generateContent, confirmado
 * real contra 3 fuentes de documentacion oficial de Google
 * (ai.google.dev/gemini-api/docs/interactions-overview,
 * .../docs/image-generation, .../api/interactions-api). Mismo header
 * `x-goog-api-key` que ya usa gemini-catalog.ts/sendGeminiApi(), no Bearer.
 *
 * Respuesta real (confirmada contra la doc oficial, con ejemplos REST/
 * Python/JS literales): `interaction.steps[]` -- cada step tiene `.type`,
 * puede ser `"thought"` (razonamiento intermedio, SIEMPRE presente en
 * modelos Gemini 3, se descarta) o `"model_output"` (el resultado real).
 * Dentro de un step `"model_output"`, `.content[]` es un array de bloques
 * con su propio `.type` (`"text"`/`"image"`) -- el bloque `"image"` trae el
 * base64 real en `.data`. Se toma el PRIMER bloque de imagen del PRIMER
 * step `model_output` que tenga uno -- nunca se asume que el primer step
 * sea el bueno.
 */
async function generateImageViaGemini(provider: ProviderProfile, model: ModelProfile, prompt: string): Promise<GenerateImageResult> {
  const apiKey = provider.apiKey?.trim()
  if (!apiKey) return { ok: false, error: 'Gemini requiere API key para generar imagenes.' }

  let response: Response
  try {
    response = await fetchWithTimeout('https://generativelanguage.googleapis.com/v1beta/interactions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey
      },
      body: JSON.stringify({
        model: model.model,
        input: [{ type: 'text', text: prompt }],
        // Default razonable (generate_image no pide tamano/aspecto hoy,
        // mismo criterio que Foundry arriba con 1024x1024 fijo) -- 1K
        // cuadrado, el mas chico/rapido, y el UNICO tamano real que soportan
        // AMBOS modelos reales de Nano Banana (Lite no soporta 2K/4K,
        // confirmado por el usuario contra la doc real de cada modelo) --
        // sin distinguir cual esta configurado, 1K sirve para los 2. `mime_type`
        // real: la doc de Google decia "image/png" -- FALSO real, confirmado
        // con un 400 real ("The value 'image/png' is not supported... Supported
        // values: 'image/jpeg'.") -- unico valor real soportado hoy es JPEG.
        response_format: { type: 'image', mime_type: 'image/jpeg', aspect_ratio: '1:1', image_size: '1K' }
      })
    })
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }

  if (!response.ok) {
    return { ok: false, error: `Gemini /interactions fallo ${response.status}: ${await readErrorBody(response)}` }
  }

  const raw = await response.json() as unknown
  const interaction = asRecord(raw).interaction ?? raw
  const steps = Array.isArray(asRecord(interaction).steps) ? asRecord(interaction).steps as unknown[] : []

  for (const step of steps) {
    const stepRecord = asRecord(step)
    if (stepRecord.type !== 'model_output') continue
    const content = Array.isArray(stepRecord.content) ? stepRecord.content as unknown[] : []
    for (const block of content) {
      const blockRecord = asRecord(block)
      if (blockRecord.type === 'image' && typeof blockRecord.data === 'string' && blockRecord.data) {
        return { ok: true, attachment: attachmentFromBase64Image(blockRecord.data, 'image/jpeg', 'jpg') }
      }
    }
  }

  return { ok: false, error: 'Gemini no devolvio ninguna imagen en la respuesta (interaction.steps sin ningun bloque type:"image").' }
}

export async function generateImage(
  settings: ImageGenerationSettings,
  prompt: string
): Promise<GenerateImageResult> {
  const target = resolveConfiguredImageGenerationModel(settings)
  if (!target) {
    return {
      ok: false,
      error: 'No hay un modelo de generacion de imagenes configurado (o el elegido ya no es valido). ' +
        'Configuralo en Configuracion -> Generacion de imagenes.'
    }
  }
  const { provider, model } = target

  if (model.runtime === 'foundry') return generateImageViaFoundry(provider, model, prompt)
  if (model.runtime === 'gemini-api') return generateImageViaGemini(provider, model, prompt)

  return {
    ok: false,
    error: `Generacion de imagenes no soportada todavia para "${provider.name}" (runtime "${model.runtime}") -- ` +
      'por ahora solo Foundry (ej. gpt-image-2) y Gemini (ej. Nano Banana), confirmados con una llamada real.'
  }
}
