// Test de regresion real (candidato #8, docs/_arch/verify_regression_test_infra_design.md):
// sessionRegistry deja de crecer sin limite al abrir/cerrar paneles
// (ipc-agent.ts, handlers reales de agent:*/chat:*). Bug con forma de fuga
// de memoria -- nunca crashea, nunca falla un test funcional obvio, solo
// crece en silencio con el uso real. Invoca los handlers REALES registrados
// por registerAgentIpc() (capturados por el stub de electron, ver _support/
// electron-stub.cjs), sin mockear la logica de los handlers en si.
//
// MIGRADO al contrato de F0 (docs/_arch/CONTRACT.md, "F0 del rediseño de
// sesiones en segundo plano"). Los 2 tests originales asumian el modelo
// viejo (registro por panelId, panel = dueño de la sesion):
//  - "agent:disconnect{panelClosing:true} borra la entrada" -- RETIRADO A
//    PROPOSITO por F0 (decision de diseño 1): cerrar un panel ya NO destruye
//    la sesion (puede seguir un turno en segundo plano). closePanel() manda
//    agent:detach y agent:disconnect ignora panelClosing. La propiedad que
//    ese test protegia (la entrada no queda huerfana para siempre) ahora la
//    cumple el UNICO borrado real del registro: chat:disconnect, que
//    deleteChat() (App.tsx) dispara aparte tras desenganchar el panel.
//  - "agent:disconnect sin panelClosing deja la entrada viva, lista para
//    reconectar" -- sigue siendo cierto, pero agent:disconnect ahora resuelve
//    el chat via panelToChatId (attachPanelToChat) en vez de usar el panelId
//    como clave; sobre un panel nunca enganchado es un no-op.
// El registro ahora esta acotado por la cantidad de CHATS distintos (no por
// cuantas veces se abre/cierra un panel) y una entrada solo se libera al
// eliminar el chat -- costo deliberado de F0, ver PENDING.md.
//
// AMATISTA_STORAGE_ROOT llega ya seteado, real y aislado, por
// _support/run.cjs -- ver el comentario completo alli (hallazgo real:
// setearlo aca antes de un import propio no alcanza).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ipcMain } from 'electron'
import { registerAgentIpc } from '../../src/main/ipc-agent'
import { getSession, panelToChatId, sessionRegistry } from '../../src/main/runtime-state'
import type { ProviderProfile, ModelProfile } from '../../src/shared/types'

registerAgentIpc()

function ipc(channel: string): (event: unknown, payload: unknown) => unknown {
  const handlers = (ipcMain as unknown as { __handlers: Map<string, (...args: unknown[]) => unknown> }).__handlers
  const handler = handlers.get(channel)
  assert.ok(handler, `registerAgentIpc() deberia haber registrado un handler real para ${channel}`)
  return handler as (event: unknown, payload: unknown) => unknown
}

function markConnected(chatId: string) {
  const session = getSession(chatId)
  const provider: ProviderProfile = { id: 'prov-x', name: 'Proveedor x', type: 'anthropic', authMode: 'api-key', enabled: true, models: [] }
  const model: ModelProfile = { id: 'model-x', providerId: 'prov-x', displayName: 'Modelo x', model: 'model-x', runtime: 'anthropic-api', enabled: true, capabilities: { tools: true, reasoning: true, vision: false, web: false } }
  session.activeRuntime = 'anthropic-api'
  session.activeChatId = chatId
  session.provider = provider
  session.model = model
  return session
}

test('chat:disconnect real -- el borrado real del registro (sucesor del panelClosing:true): desconecta la sesion Y libera la entrada', (t) => {
  const chatId = 'chat-a-eliminar'
  const panelId = 'panel-del-chat-a-eliminar'
  t.after(() => {
    sessionRegistry.delete(chatId)
    panelToChatId.delete(panelId)
  })
  const session = markConnected(chatId)
  ipc('agent:attach')(null, { panelId, chatId })
  assert.ok(sessionRegistry.has(chatId))

  // Secuencia real de deleteChat() (App.tsx): closePanel() -> agent:detach, y
  // aparte disconnectChat() -> chat:disconnect.
  ipc('agent:detach')(null, { panelId })
  ipc('chat:disconnect')(null, chatId)

  assert.equal(sessionRegistry.has(chatId), false, 'la entrada real deberia desaparecer del Map -- este es el fix que cierra el leak')
  // Se conserva la referencia local a `session` a proposito: la entrada ya no
  // esta en el Map, pero disconnectSession() tuvo que correr ANTES del delete
  // (si no, un runtime vivo quedaria huerfano y corriendo para siempre).
  assert.equal(session.activeRuntime, null, 'chat:disconnect debe desconectar de verdad la sesion, no solo sacarla del Map')
  assert.equal(panelToChatId.has(panelId), false, 'no debe quedar ningun mapeo panel->chat colgando hacia el chat eliminado')
})

test('agent:detach real -- F0 (decision de diseño 1): cerrar/soltar un panel NO destruye la sesion, y no deja residuo por panel', (t) => {
  const chatId = 'chat-en-segundo-plano'
  const panelId = 'panel-que-se-cierra'
  t.after(() => {
    sessionRegistry.delete(chatId)
    panelToChatId.delete(panelId)
  })
  const session = markConnected(chatId)
  ipc('agent:attach')(null, { panelId, chatId })
  assert.equal(session.visiblePanelId, panelId)
  assert.equal(panelToChatId.get(panelId), chatId)

  ipc('agent:detach')(null, { panelId })

  assert.equal(sessionRegistry.get(chatId), session, 'la sesion sobrevive al cierre del panel (corre en segundo plano) -- ya no es el dueño')
  assert.equal(session.activeRuntime, 'anthropic-api', 'sigue conectada: cerrar un panel ya no la desconecta')
  assert.equal(session.visiblePanelId, null, 'sin panel mostrandola ahora mismo')
  assert.equal(panelToChatId.has(panelId), false, 'el panel cerrado no deja ninguna entrada en panelToChatId')
})

test('registro real -- abrir/cerrar paneles muchas veces NO crece el registro (acotado por chats, no por cierres) y eliminar los chats lo libera', (t) => {
  const baselineSessions = sessionRegistry.size
  const baselinePanels = panelToChatId.size
  const chatIds = ['chat-churn-0', 'chat-churn-1', 'chat-churn-2']
  t.after(() => {
    for (const chatId of chatIds) sessionRegistry.delete(chatId)
    for (let i = 0; i < 50; i++) panelToChatId.delete(`panel-churn-${i}`)
  })

  // 50 paneles distintos se abren y se cierran sobre 3 chats. En el modelo
  // viejo el leak era una entrada por panel cerrado (50); ahora es una por
  // chat (3), sin importar cuantas veces se abra/cierre un panel.
  for (let i = 0; i < 50; i++) {
    const panelId = `panel-churn-${i}`
    ipc('agent:attach')(null, { panelId, chatId: chatIds[i % chatIds.length] })
    ipc('agent:detach')(null, { panelId })
  }
  assert.equal(sessionRegistry.size - baselineSessions, chatIds.length, 'el registro crece por chat distinto, nunca por cierre de panel')
  assert.equal(panelToChatId.size, baselinePanels, 'panelToChatId no acumula ningun panel cerrado')

  for (const chatId of chatIds) ipc('chat:disconnect')(null, chatId)
  assert.equal(sessionRegistry.size, baselineSessions, 'eliminar los chats libera todas las entradas -- vuelve exactamente al punto de partida')
})

test('agent:disconnect real -- desconecta la sesion del chat que el panel muestra (los otros disparadores reales), la entrada sigue viva y el panel enganchado, listo para reconectar', (t) => {
  const chatId = 'chat-cambio-de-modelo'
  const panelId = 'panel-cambio-de-modelo'
  t.after(() => {
    sessionRegistry.delete(chatId)
    panelToChatId.delete(panelId)
  })
  const session = markConnected(chatId)
  ipc('agent:attach')(null, { panelId, chatId })

  ipc('agent:disconnect')(null, { panelId }) // mismo caso que ChatPanel.disconnect() ante cambio de proveedor/modelo/sandbox

  assert.equal(sessionRegistry.get(chatId), session, 'sin ser un cierre de panel, la entrada NO debe borrarse -- el panel sigue vivo y va a reconectar')
  // disconnectSession() si limpia los campos reales de la sesion (esto no
  // es parte del fix de este candidato, es el comportamiento de siempre).
  assert.equal(session.activeRuntime, null)
  assert.equal(session.provider, null)
  assert.equal(session.model, null)
  assert.equal(session.turnInFlight, false)
  // Distinto de agent:detach: el panel SIGUE mostrando este chat (va a
  // reconectar enseguida) -- pisarle visiblePanelId/panelToChatId lo dejaria
  // sin sesion visible hasta su proximo attach real.
  assert.equal(session.visiblePanelId, panelId)
  assert.equal(panelToChatId.get(panelId), chatId)
})

test('agent:disconnect real -- NUNCA destruye la entrada: panelClosing (retirado) es inerte y un panel sin chat enganchado es no-op sin crear entradas fantasma', (t) => {
  const chatId = 'chat-panelclosing-inerte'
  const panelId = 'panel-panelclosing-inerte'
  t.after(() => {
    sessionRegistry.delete(chatId)
    panelToChatId.delete(panelId)
  })
  markConnected(chatId)
  ipc('agent:attach')(null, { panelId, chatId })

  // Inverso deliberado del test original "panelClosing:true borra la entrada":
  // F0 retiro ese campo -- si volviera a borrar, cerrar un panel mataria de
  // nuevo el turno en segundo plano que F0 existe para preservar.
  ipc('agent:disconnect')(null, { panelId, panelClosing: true })
  assert.equal(sessionRegistry.has(chatId), true, 'panelClosing ya no borra la entrada (retirado por F0, closePanel() usa agent:detach)')

  // Un panel nunca enganchado: resolver su chat no debe inventar una entrada.
  const sizeBefore = sessionRegistry.size
  ipc('agent:disconnect')(null, { panelId: 'panel-nunca-enganchado', panelClosing: true })
  assert.equal(sessionRegistry.size, sizeBefore, 'agent:disconnect sobre un panel sin chat es un no-op -- no crea entradas fantasma en el registro')
})
