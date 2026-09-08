// Test de regresion real (candidato #8, docs/_arch/verify_regression_test_infra_design.md):
// sessionRegistry deja de crecer sin limite al cerrar un panel
// (ipc-agent.ts, handler real 'agent:disconnect'). Bug con forma de fuga
// de memoria -- nunca crashea, nunca falla un test funcional obvio, solo
// crece en silencio con el uso real. Invoca el handler REAL registrado por
// registerAgentIpc() (capturado por el stub de electron, ver _support/
// electron-stub.cjs), sin mockear la logica del handler en si.
// AMATISTA_STORAGE_ROOT llega ya seteado, real y aislado, por
// _support/run.cjs -- ver el comentario completo alli (hallazgo real:
// setearlo aca antes de un import propio no alcanza).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ipcMain } from 'electron'
import { registerAgentIpc } from '../../src/main/ipc-agent'
import { getSession, sessionRegistry } from '../../src/main/runtime-state'

registerAgentIpc()

function disconnectHandler(): (event: unknown, payload: { panelId: string; panelClosing?: boolean }) => unknown {
  const handlers = (ipcMain as unknown as { __handlers: Map<string, (...args: unknown[]) => unknown> }).__handlers
  const handler = handlers.get('agent:disconnect')
  assert.ok(handler, 'registerAgentIpc() deberia haber registrado un handler real para agent:disconnect')
  return handler as (event: unknown, payload: { panelId: string; panelClosing?: boolean }) => unknown
}

test('agent:disconnect real -- panelClosing:true borra la entrada real de sessionRegistry', () => {
  const panelId = 'panel-cierre-genuino'
  getSession(panelId) // crea una entrada real en el Map, como agent:connect haria
  assert.ok(sessionRegistry.has(panelId))

  const handler = disconnectHandler()
  handler(null, { panelId, panelClosing: true })

  assert.equal(sessionRegistry.has(panelId), false, 'la entrada real deberia desaparecer del Map -- este es el fix que cierra el leak')
})

test('agent:disconnect real -- SIN panelClosing (los otros 4 disparadores reales) la entrada sigue viva, lista para reconectar', () => {
  const panelId = 'panel-cambio-de-modelo'
  const session = getSession(panelId)
  session.activeRuntime = 'anthropic-api'
  assert.ok(sessionRegistry.has(panelId))

  const handler = disconnectHandler()
  handler(null, { panelId }) // panelClosing ausente -- mismo caso que ChatPanel.disconnect() sin cierre genuino

  assert.equal(sessionRegistry.has(panelId), true, 'sin panelClosing, la entrada NO debe borrarse -- el panel sigue vivo y va a reconectar')
  // disconnectSession() si limpia los campos reales de la sesion (esto no
  // es parte del fix de este candidato, es el comportamiento de siempre).
  assert.equal(sessionRegistry.get(panelId)!.activeRuntime, null)
})
