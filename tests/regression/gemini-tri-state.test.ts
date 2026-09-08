// Test de regresion real (candidato #7, docs/_arch/verify_regression_test_infra_design.md):
// tri-estado confirmed/unavailable/inconclusive (gemini-catalog.ts),
// Hallazgo 5 (el ultimo) de la 4ta revision externa -- verifyGeminiModel()
// usaba response.ok puro, 404/429/503/403/400/timeout caian todos en el
// mismo false, descartados en silencio.
//
// Sin tocar gemini-catalog.ts (GEMINI_API_ROOT sigue hardcodeado al real,
// a proposito -- ningun seam de testeabilidad permanente): intercepta
// globalThis.fetch ANTES de importar el modulo, real y real produccion
// (fetchWithTimeout llama al fetch global en tiempo de invocacion, no en
// tiempo de import) -- cero mocks de la logica bajo prueba, solo se
// reemplaza la capa de red por una real y controlable dentro del mismo
// proceso, sin ningun servidor HTTP real necesario para este candidato.
import { test } from 'node:test'
import assert from 'node:assert/strict'

const GEMINI_ROOT = 'https://generativelanguage.googleapis.com/v1beta'

interface RouteSpec {
  statuses: number[]
}
const routes = new Map<string, RouteSpec>()
const calls = new Map<string, number>()

const realFetch = globalThis.fetch
globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
  const url = String(input)
  if (url === `${GEMINI_ROOT}/models?pageSize=1000`) {
    const models = Array.from(routes.keys()).map(id => ({
      name: `models/${id}`,
      displayName: id,
      supportedGenerationMethods: ['generateContent']
    }))
    return new Response(JSON.stringify({ models }), { status: 200 })
  }
  const match = /\/models\/([^:]+):generateContent$/.exec(url)
  if (match && init?.method === 'POST') {
    const id = match[1]
    const spec = routes.get(id)
    const n = calls.get(id) ?? 0
    calls.set(id, n + 1)
    const status = spec ? spec.statuses[Math.min(n, spec.statuses.length - 1)] : 500
    return new Response(JSON.stringify({ error: { message: `simulado real status ${status}` } }), { status })
  }
  return realFetch(input as never, init)
}) as typeof fetch

import { listGeminiModels } from '../../src/main/gemini-catalog'

test('listGeminiModels() real -- tri-estado real por status: 200/404/429-rescatado/503-persistente/403-sin-reintento', async () => {
  routes.clear()
  calls.clear()
  routes.set('modelo-confirmado', { statuses: [200] })
  routes.set('modelo-retirado', { statuses: [404] })
  routes.set('modelo-rescatado', { statuses: [429, 200] })
  routes.set('modelo-persistente-503', { statuses: [503, 503, 503] })
  routes.set('modelo-403-sin-reintento', { statuses: [403] })

  const result = await listGeminiModels('key-de-prueba-nunca-real')

  assert.ok(result.confirmed.some(m => m.id === 'modelo-confirmado'), '200 real -> confirmed')
  assert.equal(result.unavailableCount, 1, '404 exacto real -> unavailable, conteo=1')

  assert.ok(result.confirmed.some(m => m.id === 'modelo-rescatado'), '429 con 2do intento 200 -> rescatado por el reintento real, termina confirmed')
  assert.equal(calls.get('modelo-rescatado'), 2, 'exactamente 2 requests reales -- el reintento se disparo una sola vez')

  const persistente = result.inconclusive.find(m => m.id === 'modelo-persistente-503')
  assert.ok(persistente, '503 persistente deberia quedar inconclusive tras agotar los reintentos reales')
  assert.equal(persistente!.status, 503)
  assert.equal(calls.get('modelo-persistente-503'), 3, 'MAX_RETRIES=2 -> 3 intentos totales reales, nunca mas')

  const noRetry = result.inconclusive.find(m => m.id === 'modelo-403-sin-reintento')
  assert.ok(noRetry, '403 real -> inconclusive')
  assert.equal(noRetry!.status, 403)
  assert.equal(calls.get('modelo-403-sin-reintento'), 1, '403 nunca se reintenta -- exactamente 1 request real')
})
