// Test de regresion real (candidato #4, docs/_arch/verify_regression_test_infra_design.md):
// guard de identidad completa de parallel_ask (parallel-orchestrator.ts),
// Hallazgo 2 de la 4ta revision externa. El re-chequeo de ocupacion (ya
// existente) valida conexion+ocupacion, pero NUNCA comparaba que el destino
// siguiera siendo la MISMA identidad (chat/workspace/proveedor/modelo) que
// cuando planParallelAsk() armo la asignacion aprobada -- es un 2do chequeo
// aditivo, facil de "simplificar" fusionandolo con el primero sin darse
// cuenta de que cambia la semantica.
//
// MIGRADO al contrato de F0 (docs/_arch/CONTRACT.md, "F0 del rediseño de
// sesiones en segundo plano"): sessionRegistry ahora se indexa por CHATID
// (antes por panelId) y un panel es una ventana que MUESTRA un chat, no su
// dueño. Consecuencias para este test:
//  - La clave del registro (y `assignment.panelId`, nombre heredado) ES el
//    chatId; el "origen" que recibe planParallelAsk() tambien (ipc-agent.ts
//    le pasa `chatId`).
//  - idlePanels() exige ademas `visiblePanelId` (un panel real mostrando la
//    sesion) -- el setup ahora engancha un panel con attachPanelToChat(), la
//    misma funcion que corre agent:attach en la app real.
//  - Las propiedades que protege son LAS MISMAS (identidad completa
//    aprobada + mensaje de ocupacion distinguible del de identidad). Lo unico
//    que cambia es que "reconexion a otro chat" ya no es un camino real
//    (una sesion por chat: activeChatId no puede divergir de su clave via el
//    flujo de connect), asi que el guard se prueba campo por campo -- con
//    proveedor/modelo/carpeta como los caminos reales de F0 (mismo chat
//    reconectado con otra config tras un disconnectSession()) y activeChatId
//    conservado como defensa en profundidad.
//
// AMATISTA_STORAGE_ROOT llega ya seteado, real y aislado, por
// _support/run.cjs -- ver el comentario completo alli (hallazgo real:
// setearlo aca antes de un import propio no alcanza).
import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import {
  attachPanelToChat,
  detachPanelFromChat,
  getSession,
  panelToChatId,
  sessionRegistry
} from '../../src/main/runtime-state'
import { planParallelAsk, runParallelAsk } from '../../src/main/parallel-orchestrator'
import type { ProviderProfile, ModelProfile } from '../../src/shared/types'

const ORIGIN_CHAT = 'chat-origen'
const IDENTITY_MESSAGE = /cambio de chat, carpeta, proveedor o modelo/i

function fakeProvider(id: string): ProviderProfile {
  return { id, name: `Proveedor ${id}`, type: 'anthropic', authMode: 'api-key', enabled: true, models: [] }
}
function fakeModel(id: string, providerId: string): ModelProfile {
  return { id, providerId, displayName: `Modelo ${id}`, model: id, runtime: 'anthropic-api', enabled: true, capabilities: { tools: true, reasoning: true, vision: false, web: false } }
}

/** Sesion conectada, idle y MOSTRADA por un panel -- el estado que F0 exige para que
 *  planParallelAsk() la considere destino. Se limpia sola (registro + mapa panel->chat). */
function visibleConnectedSession(t: TestContext, chatId: string, panelId: string, workspace: string, providerId: string, modelId: string) {
  t.after(() => {
    sessionRegistry.delete(chatId)
    panelToChatId.delete(panelId)
  })
  const session = getSession(chatId)
  session.activeRuntime = 'anthropic-api'
  session.activeChatId = chatId
  session.activeWorkspace = workspace
  session.turnInFlight = false
  session.provider = fakeProvider(providerId)
  session.model = fakeModel(modelId, providerId)
  attachPanelToChat(panelId, chatId)
  return session
}

test('parallel_ask real -- reconexion a otra identidad en la ventana de aprobacion se RECHAZA, con mensaje distinguible', async (t) => {
  const chatId = 'chat-original'
  const session = visibleConnectedSession(t, chatId, 'panel-1', '/workspace/original', 'prov-original', 'model-original')

  const plan = planParallelAsk(ORIGIN_CHAT, ['hace algo real'])
  assert.equal(plan.ok, true, `deberia encontrar la sesion idle y visible: ${JSON.stringify(plan)}`)
  if (!plan.ok) return
  assert.equal(plan.assignments[0].panelId, chatId, 'F0: la clave de la asignacion es el chatId, no el panelId')
  assert.equal(plan.assignments[0].approvedChatId, 'chat-original')
  assert.equal(plan.assignments[0].providerId, 'prov-original')

  // Reconexion real durante la ventana de aprobacion humana (ctx.confirm())
  // -- la sesion sigue idle y conectada (y visible), pero con otro chat/
  // carpeta/proveedor/modelo que los aprobados.
  session.activeChatId = 'chat-nuevo'
  session.activeWorkspace = '/workspace/nuevo'
  session.provider = fakeProvider('prov-nuevo')
  session.model = fakeModel('model-nuevo', 'prov-nuevo')

  const outcomes = await runParallelAsk(plan.assignments)
  assert.equal(outcomes[0].ok, false, `deberia rechazar la sub-tarea contra la identidad nueva: ${JSON.stringify(outcomes[0])}`)
  assert.match(String(outcomes[0].error), IDENTITY_MESSAGE)
})

// El test original mutaba varios campos A LA VEZ: un guard degradado a
// comparar un solo campo lo seguia pasando. Con F0 los caminos reales de
// cambio son proveedor/modelo/carpeta (mismo chat reconectado con otra
// config) -- cada uno se prueba AISLADO, sin tocar los otros 3 campos.
const SINGLE_FIELD_MUTATIONS: Array<{ campo: string; mutate: (s: ReturnType<typeof getSession>) => void }> = [
  { campo: 'proveedor', mutate: s => { s.provider = fakeProvider('prov-nuevo') } },
  { campo: 'modelo', mutate: s => { s.model = fakeModel('model-nuevo', 'prov-original') } },
  { campo: 'carpeta (workspace)', mutate: s => { s.activeWorkspace = '/workspace/nuevo' } },
  { campo: 'activeChatId (defensa en profundidad -- no alcanzable por el connect real de F0)', mutate: s => { s.activeChatId = 'chat-nuevo' } }
]
for (const { campo, mutate } of SINGLE_FIELD_MUTATIONS) {
  test(`parallel_ask real -- cambio de SOLO ${campo} en la ventana de aprobacion se RECHAZA con el mensaje de identidad`, async (t) => {
    const session = visibleConnectedSession(t, 'chat-original', 'panel-1', '/workspace/original', 'prov-original', 'model-original')

    const plan = planParallelAsk(ORIGIN_CHAT, ['hace algo real'])
    assert.equal(plan.ok, true, `deberia encontrar la sesion idle y visible: ${JSON.stringify(plan)}`)
    if (!plan.ok) return

    mutate(session)

    const outcomes = await runParallelAsk(plan.assignments)
    assert.equal(outcomes[0].ok, false, `deberia rechazar la sub-tarea al cambiar solo ${campo}: ${JSON.stringify(outcomes[0])}`)
    assert.match(String(outcomes[0].error), IDENTITY_MESSAGE)
  })
}

test('parallel_ask real -- ocupacion real (sesion tomada por otro turno) da un mensaje DISTINTO al de identidad', async (t) => {
  const session = visibleConnectedSession(t, 'chat-x', 'panel-2', '/workspace/x', 'prov-x', 'model-x')

  const plan = planParallelAsk(ORIGIN_CHAT, ['hace algo real'])
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
  assert.doesNotMatch(String(outcomes[0].error), IDENTITY_MESSAGE)
})

// Invariante NUEVA de F0 que faltaba cubrir (y cuya ausencia en el setup
// viejo fue justamente lo que rompio los 2 tests de arriba): parallel_ask
// solo reparte a sesiones con un panel VISIBLE mostrandolas. Una sesion
// conectada e idle en segundo plano NO es destino (orquestacion cross-chat
// hacia background es F2, fuera de alcance de F0).
test('planParallelAsk real -- F0: una sesion en segundo plano (sin panel visible) NO es destino; con panel visible si; al desengancharlo vuelve a excluirse', (t) => {
  const chatId = 'chat-bg'
  const panelId = 'panel-bg'
  t.after(() => {
    sessionRegistry.delete(chatId)
    panelToChatId.delete(panelId)
  })
  const session = getSession(chatId)
  session.activeRuntime = 'anthropic-api'
  session.activeChatId = chatId
  session.activeWorkspace = '/workspace/bg'
  session.turnInFlight = false
  session.provider = fakeProvider('prov-bg')
  session.model = fakeModel('model-bg', 'prov-bg')
  assert.equal(session.visiblePanelId, null, 'precondicion: sesion conectada e idle, sin ningun panel mostrandola')

  const background = planParallelAsk(ORIGIN_CHAT, ['hace algo real'])
  assert.equal(background.ok, false, `una sesion sin panel visible no debe ser destino: ${JSON.stringify(background)}`)

  attachPanelToChat(panelId, chatId)
  const visible = planParallelAsk(ORIGIN_CHAT, ['hace algo real'])
  assert.equal(visible.ok, true, `con un panel mostrandola debe ser destino: ${JSON.stringify(visible)}`)
  if (visible.ok) assert.equal(visible.assignments[0].panelId, chatId)

  detachPanelFromChat(panelId)
  assert.equal(session.visiblePanelId, null)
  const detached = planParallelAsk(ORIGIN_CHAT, ['hace algo real'])
  assert.equal(detached.ok, false, `tras desenganchar el panel vuelve a ser segundo plano y se excluye: ${JSON.stringify(detached)}`)
})
