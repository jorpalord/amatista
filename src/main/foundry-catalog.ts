// Catalogo real de deployments para conexiones Foundry (Azure AI Foundry /
// Azure OpenAI) -- mismo espiritu que openai-chat-catalog.ts (GET real
// contra el endpoint de la conexion), pero ARCHIVO PROPIO a proposito: la
// autenticacion real de Azure es distinta (header `api-key`, NUNCA
// `Authorization: Bearer` -- ese header esta reservado para tokens de
// Microsoft Entra ID, una via de auth totalmente distinta a la API key
// plana que Amatista usa hoy para Foundry) y el endpoint real es OTRO,
// distinto al que sendFoundry() usa para /responses (ver mas abajo).
//
// Fix real (bug reportado por el usuario en vivo): el primer intento usaba
// GET /openai/v1/models (la superficie "v1" unificada, misma base que
// normalizeFoundryBaseUrl()/sendFoundry() ya usan para /responses) --
// confirmado real por el usuario que ESE endpoint devuelve el catalogo
// AMPLIO de modelos disponibles para desplegar en la plataforma, no los
// deployments que el usuario efectivamente CREO en su recurso (el usuario
// tiene 1 deployment real, la app mostraba varios). Reemplazado por el
// endpoint clasico y REALMENTE scoped al recurso: GET /openai/deployments
// ?api-version=2023-05-15 -- documentado por Microsoft, distinto dominio
// de ruta que /openai/v1 (no pasa por normalizeFoundryBaseUrl(), que arma
// la base para /responses -- aca se deriva la RAIZ del recurso propia).
//
// Fix real #2 (usuario bloqueado en vivo de nuevo, meses despues): el
// recurso clasico de ARRIBA dejo de responder ese endpoint (404 real,
// "Resource not found" -- no 401, error de RUTEO, no de credencial) para
// una conexion Foundry nueva del usuario -- resulto ser un recurso del
// shape nuevo de Azure AI Foundry ("project"), con host DISTINTO
// (`<recurso>.services.ai.azure.com/api/projects/<project>/...`, no
// `<recurso>.openai.azure.com`) y superficie de listado de deployments
// DISTINTA (`/deployments?api-version=v1` -- el string literal "v1", NO
// una fecha, confirmado en 2 fuentes independientes de documentacion real
// de Microsoft). Los 2 shapes son detectables sin ambiguedad por hostname
// (zonas DNS mutuamente excluyentes) -- ver foundryShape() mas abajo.
import { fetchWithTimeout, readErrorBody } from './api-agent-runtime'

export interface FoundryCatalogModel {
  id: string
  displayName: string
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : {}
}

function firstString(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string' && value.trim()) return value
  }
  return undefined
}

/**
 * Shape real del recurso Foundry, detectado por hostname -- las 2 zonas
 * DNS son mutuamente excluyentes, senal inequivoca (no una heuristica
 * debil, no requiere probar ambas superficies a ciegas):
 * - 'classic': `<recurso>.openai.azure.com` -- Azure OpenAI clasico,
 *   `/openai/deployments?api-version=2023-05-15` (el shape original,
 *   confirmado real contra otro recurso del usuario).
 * - 'project': `<recurso>.services.ai.azure.com` -- Azure AI Foundry
 *   project (shape nuevo), `/api/projects/<project>/deployments
 *   ?api-version=v1`.
 * Hostname invalido/no parseable cae a 'classic' (el shape mas viejo y
 * probado) -- el fallback acotado de listFoundryModels() cubre el caso de
 * que sea realmente 'project' pero el host no matcheo por algun motivo.
 */
function foundryShape(endpoint: string): 'classic' | 'project' {
  try {
    const host = new URL(endpoint).hostname.toLowerCase()
    return host.endsWith('.services.ai.azure.com') ? 'project' : 'classic'
  } catch {
    return 'classic'
  }
}

/**
 * Raiz real del recurso (`https://<recurso>.openai.azure.com`), derivada
 * del endpoint guardado por la conexion -- que puede venir ya normalizado
 * a `/openai/v1` (normalizeFoundryBaseUrl(), usado para /responses) o tal
 * cual lo pegó el usuario. `/openai/deployments` cuelga de la RAIZ del
 * recurso, nunca de `/openai/v1` -- son 2 superficies de API distintas del
 * mismo recurso Azure, confirmado real que mezclar las bases da resultados
 * incorrectos (el propio bug que esto corrige).
 */
function foundryResourceRoot(endpoint: string): string {
  const clean = (endpoint ?? '').trim().replace(/\/+$/, '')
  if (!clean) throw new Error('Foundry requiere endpoint.')
  return clean
    .replace(/\/openai\/v1$/i, '')
    .replace(/\/openai$/i, '')
    .replace(/\/v1$/i, '')
}

/**
 * Raiz real de un recurso Foundry shape 'project'
 * (`https://<recurso>.services.ai.azure.com/api/projects/<project>`),
 * cortando el endpoint guardado justo despues del segmento `<project>` --
 * tolera que el usuario haya guardado el endpoint con un sufijo `/openai`
 * de mas (confirmado real con un probe sin credenciales que ambas formas
 * responden igual en este recurso).
 */
function foundryProjectRoot(endpoint: string): string {
  const clean = (endpoint ?? '').trim().replace(/\/+$/, '')
  const match = clean.match(/^(https?:\/\/[^/]+\/api\/projects\/[^/]+)/i)
  if (!match) throw new Error('Foundry (shape project) requiere un endpoint con /api/projects/<project>.')
  return match[1]
}

function foundryDeploymentsUrl(endpoint: string, shape: 'classic' | 'project'): string {
  return shape === 'project'
    ? `${foundryProjectRoot(endpoint)}/deployments?api-version=v1`
    : `${foundryResourceRoot(endpoint)}/openai/deployments?api-version=2023-05-15`
}

async function fetchFoundryDeployments(url: string, key: string): Promise<unknown> {
  const response = await fetchWithTimeout(url, {
    method: 'GET',
    headers: { 'Content-Type': 'application/json', 'api-key': key }
  })
  if (!response.ok) {
    const error = new Error(`GET ${url} falló ${response.status}: ${await readErrorBody(response)}`) as Error & { status?: number }
    error.status = response.status
    throw error
  }
  return response.json()
}

export async function listFoundryModels(endpoint: string, apiKey: string): Promise<FoundryCatalogModel[]> {
  const key = apiKey.trim()
  if (!key) throw new Error('Foundry requiere API key para listar deployments.')

  const shape = foundryShape(endpoint)
  const url = foundryDeploymentsUrl(endpoint, shape)

  let raw: unknown
  try {
    raw = await fetchFoundryDeployments(url, key)
  } catch (error) {
    // Fallback acotado A PROPOSITO solo a 404 ("esta ruta no existe en
    // este recurso" -- senal real de shape equivocado, ya vista en vivo).
    // NUNCA a 401/403 (credencial real invalida -- reintentar contra el
    // otro shape enmascararia el error real de auth con uno mas confuso
    // de una ruta que ni siquiera se pretendia usar) ni a 400 (api-version
    // rechazado -- ya es shape correcto, el problema es otro).
    const status = (error as { status?: number }).status
    if (status !== 404) throw error
    const fallbackShape = shape === 'project' ? 'classic' : 'project'
    const fallbackUrl = foundryDeploymentsUrl(endpoint, fallbackShape)
    raw = await fetchFoundryDeployments(fallbackUrl, key)
  }
  const record = asRecord(raw)
  // "value" es el campo real del shape 'project' (`{value:[...]}`,
  // confirmado real con un GET autenticado real contra el recurso del
  // usuario -- "data"/"deployments" siguen siendo los del shape 'classic',
  // ningun campo se retira, solo se suma el nuevo al mismo find().
  const data = [record.data, record.deployments, record.value, raw].find(Array.isArray)
  if (!Array.isArray(data)) return []

  return data
    .map(item => {
      const deployment = asRecord(item)
      // "status" real de Azure para un deployment que todavia se esta
      // creando/fallo (ej. "creating"/"failed") -- no se ofrece como
      // candidato utilizable si esta presente y NO es exito. Ausente en
      // algunas respuestas reales (versiones/regiones distintas, incluido
      // el shape 'project' -- confirmado real, sus items no traen status)
      // -- nunca se exige, solo se excluye si esta presente Y es
      // explicitamente un estado de fallo/pendiente.
      const status = firstString(deployment, ['status'])?.toLowerCase()
      if (status && status !== 'succeeded') return null

      // "id" real = el NOMBRE del deployment (lo que el usuario eligio al
      // crearlo) -- el campo que hay que guardar en model.model para que
      // --model/el header real de Amatista apunte a lo correcto. "model"/
      // "modelName" (distinto campo, el modelo base detras, ej. "gpt-4o" o
      // "DeepSeek-V4-Flash") se agrega al displayName solo si difiere del
      // nombre del deployment, para que se vea igual que en el portal de
      // Azure cuando coinciden. "modelName" es el nombre real del campo en
      // el shape 'project' (confirmado real, "model" no existe ahi).
      const id = firstString(deployment, ['id', 'name'])
      if (!id) return null
      const baseModel = firstString(deployment, ['model', 'modelName'])
      const displayName = baseModel && baseModel !== id ? `${id} (${baseModel})` : id
      return { id, displayName }
    })
    .filter((item): item is FoundryCatalogModel => item !== null)
}
