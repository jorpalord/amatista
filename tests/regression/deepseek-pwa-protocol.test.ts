// Protocolo de texto de DeepSeek PWA (src/main/deepseek-pwa-runtime.ts): las reglas que corrigen los desvios vistos en
// uso real (narrar antes de la llamada, formato nativo DSML, valores sin comillas) y el recordatorio que viaja en cada
// mensaje posterior al primero (TOOL_RESULT y mensajes del usuario en una conversacion ya iniciada).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildToolProtocolInstructions, TOOL_PROTOCOL_REMINDER, toolResultMessage, withToolProtocolReminder } from '../../src/main/deepseek-pwa-runtime'
import { analyzeTextToolCall } from '../../src/main/deepseek-pwa-tool-call'

const instructions = buildToolProtocolInstructions({ isPrincipalChat: true, hasWebSearchIntegration: false, planModeActive: false })

test('instrucciones: incluyen las 4 reglas contra los desvios reales y el formato exacto de siempre', () => {
  assert.match(instructions, /TOOL_CALL: nombre_de_la_herramienta\(parametro1="valor1", parametro2="valor2"\)/)
  assert.match(instructions, /Encadena herramientas hasta terminar TODO/)
  assert.match(instructions, /No anuncies lo que vas a hacer/)
  assert.match(instructions, /Una sola herramienta por respuesta/)
  assert.match(instructions, /Nunca uses tu formato nativo de llamadas a funciones/)
  assert.match(instructions, /incluso numeros y booleanos/)
})

test('recordatorio: TOOL_RESULT conserva el formato y lleva el recordatorio al final', () => {
  const message = toolResultMessage('dir   docs\nfile  README.md')
  assert.ok(message.startsWith('TOOL_RESULT: dir   docs\nfile  README.md'))
  assert.ok(message.endsWith(TOOL_PROTOCOL_REMINDER))
  assert.match(TOOL_PROTOCOL_REMINDER, /SOLO la proxima linea TOOL_CALL/)
  assert.match(TOOL_PROTOCOL_REMINDER, /formato nativo/)
})

test('recordatorio: el mensaje del usuario queda intacto al principio', () => {
  const message = withToolProtocolReminder('lee docs/a.md y resumilo')
  assert.ok(message.startsWith('lee docs/a.md y resumilo\n\n'))
  assert.ok(message.endsWith(TOOL_PROTOCOL_REMINDER))
})

test('seguridad: un modelo que repite el recordatorio junto a una llamada NO dispara la llamada', () => {
  // El recordatorio menciona TOOL_CALL: si el modelo lo copiara alrededor de una llamada, el parser la sigue rechazando.
  const echoed = analyzeTextToolCall(`TOOL_CALL: list_dir(path=".")\n\n${TOOL_PROTOCOL_REMINDER}`)
  assert.equal(echoed.kind, 'rejected')
})
