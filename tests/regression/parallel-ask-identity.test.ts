// Test de regresion real (candidato #4, docs/_arch/verify_regression_test_infra_design.md):
// guard de identidad completa de parallel_ask (parallel-orchestrator.ts),
// Hallazgo 2 de la 4ta revision externa. El re-chequeo de ocupacion (ya
// existente) valida conexion+ocupacion, pero NUNCA comparaba que el panel
// destino siguiera siendo la MISMA identidad (chat/workspace/proveedor/
// modelo) que cuando planParallelAsk() armo la asignacion aprobada -- es
// un 2do chequeo aditivo, facil de "simplificar" fusionandolo con el
// primero sin darse cuenta de que cambia la semantica.
// AMATISTA_STORAGE_ROOT llega ya seteado, real y aislado, por
// _support/run.cjs -- ver el comentario completo alli (hallazgo real:
// setearlo aca antes de un import propio no alcanza).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { getSession, sessionRegistry } from '../../src/main/runtime-state'
import { planParallelAsk, runParallelAsk } from '../../src/main/parallel-orchestrator'
import type { ProviderProfile, ModelProfile } from '../../src/shared/types'

function fakeProvider(id: string): ProviderProfile {
  return { id, name: `Proveedor ${id}`, type: 'anthropic', authMode: 'api-key', enabled: true, models: [] }
}
function fakeModel(id: string, providerId: string): ModelProfile {
  return { id, providerId, displayName: `Modelo ${id}`, model: id, runtime: 'anthropic-api', enabled: true, capabilities: { tools: true, reasoning: true, vision: false, web: false } }
}

test('parallel_ask real -- reconexion a otra identidad en la ventana de aprobacion se RECHAZA, con mensaje distinguible', async (t) => {
  const targetPanel = 'target-panel-1'
  t.after(() => sessionRegistry.delete(targetPanel))

  const session = getSession(targetPanel)
  session.activeRuntime = 'anthropic-api'
  session.activeChatId = 'chat-original'
  session.activeWorkspace = '/workspace/original'
  session.turnInFlight = false
  session.provider = fakeProvider('prov-original')
  session.model = fakeModel('model-original', 'prov-original')

  const plan = planParallelAsk('origin-panel', ['hace algo real'])
  assert.equal(plan.ok, true, `deberia encontrar el panel idle: ${JSON.stringify(plan)}`)
  if (!plan.ok) return
  assert.equal(plan.assignments[0].approvedChatId, 'chat-original')
  assert.equal(plan.assignments[0].providerId, 'prov-original')

  // Reconexion real durante la ventana de aprobacion humana (ctx.confirm())
  // -- el panel sigue idle y conectado, pero a un chat/proveedor DISTINTO
  // del aprobado.
  session.activeChatId = 'chat-nuevo'
  session.provider = fakeProvider('prov-nuevo')
  session.model = fakeModel('model-nuevo', 'prov-nuevo')

  const outcomes = await runParallelAsk(plan.assignments)
  assert.equal(outcomes[0].ok, false, `deberia rechazar la sub-tarea contra la identidad nueva: ${JSON.stringify(outcomes[0])}`)
  assert.match(String(outcomes[0].error), /cambio de chat, carpeta, proveedor o modelo/i)
})

test('parallel_ask real -- ocupacion real (panel tomado por otro turno) da un mensaje DISTINTO al de identidad', async (t) => {
  const targetPanel = 'target-panel-2'
  t.after(() => sessionRegistry.delete(targetPanel))

  const session = getSession(targetPanel)
  session.activeRuntime = 'anthropic-api'
  session.activeChatId = 'chat-x'
  session.activeWorkspace = '/workspace/x'
  session.turnInFlight = false
  session.provider = fakeProvider('prov-x')
  session.model = fakeModel('model-x', 'prov-x')

  const plan = planParallelAsk('origin-panel', ['hace algo real'])
  assert.equal(plan.ok, true)
  if (!plan.ok) return

  // Ocupacion real (sin ningun cambio de identidad) -- el OTRO chequeo,
  // el que ya existia antes del Hallazgo 2.
  session.turnInFlight = true

  const outcomes = await runParallelAsk(plan.assignments)
  assert.equal(outcomes[0].ok, false)
  assert.match(String(outcomes[0].error), /se ocupo/i)
  // Confirma que es un diagnostico DISTINTO del de identidad -- ambos
  // chequeos son reales y separados, no deben confundirse entre si.
  assert.doesNotMatch(String(outcomes[0].error), /cambio de chat, carpeta, proveedor o modelo/i)
})
