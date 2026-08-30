// Feature "generacion de imagenes" (docs/_arch/verify_image_generation.md,
// Tarea 0). Motor real: resuelve el modelo configurado (mismo patron que
// compaction-engine.ts, logica PARALELA -- no comparte funciones ni
// campos), llama de verdad a /images/generations de Foundry (confirmado
// con evidencia real en la investigacion: endpoint SEPARADO de /responses,
// respuesta con data[0].b64_json, sin url), y arma el ChatAttachment final
// reusando buildAttachmentFromDataUrl() tal cual -- sin cambios ahi.
import { buildAttachmentFromDataUrl } from './attachments'
import { fetchWithTimeout, normalizeFoundryBaseUrl, readErrorBody } from './api-agent-runtime'
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

/**
 * Llamada real, confirmada contra Foundry en la investigacion (Tarea 1):
 * POST {baseUrl}/images/generations, mismo header `api-key` que /responses
 * pero un endpoint genuinamente distinto -- gpt-image-2 responde 400
 * "unsupported" contra /responses. Respuesta real: `data[0].b64_json`
 * (base64 inline, SIN campo url). Por ahora SOLO Foundry -- ningun otro
 * runtime de esta app fue probado contra un endpoint de imagenes real, un
 * error claro es mejor que adivinar un formato de request no verificado.
 */
export async function generateImage(
  settings: ImageGenerationSettings,
  prompt: string
): Promise<{ ok: true; attachment: ChatAttachment } | { ok: false; error: string }> {
  const target = resolveConfiguredImageGenerationModel(settings)
  if (!target) {
    return {
      ok: false,
      error: 'No hay un modelo de generacion de imagenes configurado (o el elegido ya no es valido). ' +
        'Configuralo en Configuracion -> Generacion de imagenes.'
    }
  }
  const { provider, model } = target

  if (model.runtime !== 'foundry') {
    return {
      ok: false,
      error: `Generacion de imagenes no soportada todavia para "${provider.name}" (runtime "${model.runtime}") -- ` +
        'por ahora solo modelos Foundry (ej. gpt-image-2), confirmados con una llamada real.'
    }
  }

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

  const dataUrl = `data:image/png;base64,${b64}`
  const name = `generada-${Date.now()}.png`
  const attachment = buildAttachmentFromDataUrl({ name, dataUrl })

  return { ok: true, attachment: { ...attachment, origin: 'generated' } }
}
