// Loop REAL de tool-calling de DeepSeek PWA (ipc-agent.ts, runTurnForWindow -> rama 'deepseek-pwa') con una PWA falsa
// en el borde: la falsa solo reemplaza la pagina web de DeepSeek (devuelve respuestas guionadas y registra lo que
// Amatista le manda). Todo lo demas es codigo de produccion: el parser, el ExecuteContext, toolRegistry.execute(), el
// armado de TOOL_RESULT/recordatorio y los eventos que ve el panel.
//
// Protege: (1) el formato nativo DSML ya no pasa en silencio -- el panel recibe el texto + la nota honesta, sin ejecutar
// nada; (2) cada TOOL_RESULT y cada mensaje de una conversacion ya iniciada llevan el recordatorio del protocolo;
// (3) una llamada limpia se sigue ejecutando igual; (4) texto alrededor de una llamada sigue sin ejecutarse.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { runTurnForWindow } from '../../src/main/ipc-agent'
import { getSession, sessionRegistry } from '../../src/main/runtime-state'
import { TOOL_PROTOCOL_REMINDER } from '../../src/main/deepseek-pwa-runtime'
import { DeepSeekStreamParser, type DeepSeekTurnOutcome } from '../../src/main/deepseek-pwa-stream'
import { readDeepSeekThermometer, recordDeepSeekExchange, recordDeepSeekLengthLimit } from '../../src/main/deepseek-pwa-thermometer'
import type { ModelProfile, ProviderProfile } from '../../src/shared/types'

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'amatista-pwa-loop-'))
fs.writeFileSync(path.join(workspace, 'nota.txt'), 'contenido real de la nota\n')
const thermometerFile = path.join(workspace, 'termometro-del-test.json')
process.env.AMATISTA_DEEPSEEK_PWA_THERMOMETER_FILE = thermometerFile
after(() => fs.rmSync(workspace, { recursive: true, force: true }))

const DSML_REAL = '<｜｜DSML｜｜ calls>\n<｜｜DSML｜｜ invoke name="read_file">\n<｜｜DSML｜｜ parameter name="path" string="true">nota.txt</｜｜DSML｜｜ parameter>\n</｜｜DSML｜｜ invoke>\n</｜｜DSML｜｜ calls>'

function outcome(responseText: string): DeepSeekTurnOutcome {
  return { httpStatus: 200, status: 'FINISHED', responseText, thinkText: '', recognized: true, errors: [], networkError: null, cancelledByUser: false, inactivityTimeout: false, unrecognizedSamples: [] }
}

/** Reemplaza SOLO la pagina de DeepSeek: responde el guion y guarda cada mensaje que Amatista le manda. Un paso del
 *  guion es el texto de la respuesta, o un resultado ya armado (por ejemplo, el de un stream real de error). */
function fakePwa(script: Array<string | DeepSeekTurnOutcome>, alreadyStarted: boolean, remoteId = '11111111-2222-3333-4444-555555555555') {
  const sent: string[] = []
  let remote: string | null = alreadyStarted ? remoteId : null
  return {
    sent,
    runtime: {
      hasRemoteConversation: () => remote !== null,
      async send(text: string, options: { onResponse: (t: string) => void }) {
        sent.push(text)
        const step = script.shift()
        if (step === undefined) throw new Error('el guion de la PWA falsa se quedo sin respuestas')
        const result = typeof step === 'string' ? outcome(step) : step
        if (result.responseText) options.onResponse(result.responseText)
        remote = remote ?? remoteId
        return { outcome: result, remoteSessionId: remote, title: null, thinkingEnabledConfirmed: null }
      },
      async cancelTurn() {},
      stop() {},
      setPlacement() {}
    }
  }
}

function connectPwa(chatId: string, pwa: ReturnType<typeof fakePwa>['runtime']) {
  const provider: ProviderProfile = { id: 'pwa', name: 'DeepSeek PWA (prueba)', type: 'deepseek-pwa', authMode: 'subscription', enabled: true, models: [] }
  const model: ModelProfile = { id: 'pwa-m', providerId: 'pwa', displayName: 'DeepSeek (sesion web)', model: 'deepseek-web', runtime: 'deepseek-pwa', enabled: true, capabilities: { tools: true, reasoning: false, vision: false, web: false } }
  const session = getSession(chatId)
  session.activeRuntime = 'deepseek-pwa'
  session.activeChatId = chatId
  session.activeWorkspace = workspace
  session.sandbox = 'danger-full-access'
  session.provider = provider
  session.model = model
  session.pwaRuntime = pwa as unknown as typeof session.pwaRuntime
  session.eventLog = []
  return session
}

function finalText(chatId: string): string {
  const events = getSession(chatId).eventLog.filter(ev => ev.payload.method === 'item/completed')
  const item = (events[events.length - 1]?.payload.params as { item?: { text?: string } } | undefined)?.item
  return item?.text ?? ''
}

function toolSteps(chatId: string): string[] {
  return getSession(chatId).eventLog
    .filter(ev => ev.payload.method === 'item/toolCall/status' && (ev.payload.params as { phase: string }).phase === 'done')
    .map(ev => (ev.payload.params as { name: string }).name)
}

test('loop real: llamada limpia -> se ejecuta, y el TOOL_RESULT vuelve con el recordatorio del protocolo', async (t) => {
  const chatId = 'chat-pwa-loop-limpia'
  t.after(() => sessionRegistry.delete(chatId))
  const pwa = fakePwa(['TOOL_CALL: read_file(path="nota.txt")', 'La nota dice: contenido real de la nota.'], false)
  connectPwa(chatId, pwa.runtime)
  const result = await runTurnForWindow(chatId, { text: 'lee nota.txt', providerId: 'pwa', modelId: 'pwa-m', sandbox: 'danger-full-access' })
  assert.equal(result.success, true)
  assert.deepEqual(toolSteps(chatId), ['read_file'])
  assert.equal(pwa.sent.length, 2)
  assert.match(pwa.sent[0], /Reglas del protocolo/, 'el primer mensaje de una conversacion nueva lleva las instrucciones completas')
  assert.ok(pwa.sent[1].startsWith('TOOL_RESULT: contenido real de la nota'))
  assert.ok(pwa.sent[1].endsWith(TOOL_PROTOCOL_REMINDER), 'el TOOL_RESULT termina con el recordatorio')
  assert.equal(finalText(chatId), 'La nota dice: contenido real de la nota.')
})

test('loop real: en una conversacion ya iniciada, el mensaje del usuario viaja con el recordatorio (sin repetir las instrucciones completas)', async (t) => {
  const chatId = 'chat-pwa-loop-seguida'
  t.after(() => sessionRegistry.delete(chatId))
  const pwa = fakePwa(['Listo.'], true)
  connectPwa(chatId, pwa.runtime)
  await runTurnForWindow(chatId, { text: 'segui con lo que falta', providerId: 'pwa', modelId: 'pwa-m', sandbox: 'danger-full-access' })
  assert.equal(pwa.sent[0], `segui con lo que falta\n\n${TOOL_PROTOCOL_REMINDER}`)
  assert.doesNotMatch(pwa.sent[0], /Reglas del protocolo/)
})

test('loop real: el formato nativo DSML (visto en uso real, tras llamadas limpias) ya no pasa en silencio -- texto + nota, nada ejecutado', async (t) => {
  const chatId = 'chat-pwa-loop-dsml'
  t.after(() => sessionRegistry.delete(chatId))
  const pwa = fakePwa(['TOOL_CALL: list_dir(path=".")', DSML_REAL], false)
  connectPwa(chatId, pwa.runtime)
  const result = await runTurnForWindow(chatId, { text: 'lista y lee la nota', providerId: 'pwa', modelId: 'pwa-m', sandbox: 'danger-full-access' })
  assert.equal(result.success, true)
  assert.deepEqual(toolSteps(chatId), ['list_dir'], 'solo se ejecuto la llamada limpia; el DSML no se interpreta ni se ejecuta')
  const text = finalText(chatId)
  assert.ok(text.startsWith(DSML_REAL), 'el usuario ve la respuesta tal cual...')
  assert.match(text, /formato nativo de llamadas/, '...con la nota honesta, nunca en silencio')
  assert.equal(getSession(chatId).eventLog.filter(ev => ev.payload.method === 'turn/completed').length, 1)
})

/** Resultado de un stream guardado, pasado por el parser REAL del stream (mismo camino que el runtime). */
function outcomeFromStream(fixtureName: string): DeepSeekTurnOutcome {
  const parser = new DeepSeekStreamParser()
  const errors: Array<{ code: unknown; msg: string }> = []
  for (const ev of parser.feed(fs.readFileSync(path.join('tests', 'regression', '_fixtures', 'deepseek-pwa', fixtureName), 'utf8'))) {
    if (ev.kind === 'error') errors.push({ code: ev.code, msg: ev.msg })
  }
  return { ...outcome(''), status: null, recognized: parser.recognized, errors }
}

const contextNotices = (chatId: string): string[] => getSession(chatId).eventLog
  .filter(ev => ev.payload.method === 'deepseek-pwa/contextNotice')
  .map(ev => String((ev.payload.params as { message: string }).message))

test('loop real: rate limit REAL (captura del stream) -> error honesto de frecuencia, no "cerro sin status"', async (t) => {
  const chatId = 'chat-pwa-loop-ratelimit'
  t.after(() => sessionRegistry.delete(chatId))
  const pwa = fakePwa(['TOOL_CALL: list_dir(path=".")', outcomeFromStream('rate-limit-real.sse')], false, 'aaaaaaaa-0000-0000-0000-000000000001')
  connectPwa(chatId, pwa.runtime)
  await assert.rejects(
    runTurnForWindow(chatId, { text: 'lista y segui', providerId: 'pwa', modelId: 'pwa-m', sandbox: 'danger-full-access' }),
    /DeepSeek limito la frecuencia de mensajes \("Messages too frequent\. Try again later\."\).*Espera unos segundos y pedile que siga/
  )
  assert.equal(readDeepSeekThermometer().observations.length, 0, 'un rate limit no es un corte por longitud')
})

test('loop real: con 0 observaciones no hay ningun aviso del termometro', async (t) => {
  const chatId = 'chat-pwa-loop-sin-aviso'
  t.after(() => sessionRegistry.delete(chatId))
  const pwa = fakePwa(['TOOL_CALL: read_file(path="nota.txt")', 'Listo.'], false, 'aaaaaaaa-0000-0000-0000-000000000002')
  connectPwa(chatId, pwa.runtime)
  await runTurnForWindow(chatId, { text: 'lee nota.txt', providerId: 'pwa', modelId: 'pwa-m', sandbox: 'danger-full-access' })
  assert.equal(readDeepSeekThermometer().threshold, null)
  assert.deepEqual(contextNotices(chatId), [])
})

test('loop real: corte por longitud en una conversacion medida entera -> mensaje honesto + observacion REAL persistida', async (t) => {
  const chatId = 'chat-pwa-loop-longitud'
  t.after(() => sessionRegistry.delete(chatId))
  const firstReply = 'TOOL_CALL: list_dir(path=".")'
  const pwa = fakePwa([firstReply, outcomeFromStream('context-length-SINTETICO.sse')], false, 'aaaaaaaa-0000-0000-0000-000000000003')
  connectPwa(chatId, pwa.runtime)
  await assert.rejects(
    runTurnForWindow(chatId, { text: 'lista la carpeta', providerId: 'pwa', modelId: 'pwa-m', sandbox: 'danger-full-access' }),
    /alcanzo el limite de longitud de esta conversacion.*inicia un chat nuevo[\s\S]*corte registrado/
  )
  const expected = pwa.sent[0].length + firstReply.length
  const persisted = JSON.parse(fs.readFileSync(thermometerFile, 'utf8')) as { observations: Array<{ contextChars: number; rejectedMessageChars: number }> }
  assert.equal(persisted.observations.length, 1)
  assert.equal(persisted.observations[0].contextChars, expected, 'caracteres reales acumulados antes del mensaje rechazado')
  assert.equal(persisted.observations[0].rejectedMessageChars, pwa.sent[1].length)
})

test('loop real: con umbral real (>= 3 observaciones), cruzar el 80% emite UN aviso de sistema aproximado', async (t) => {
  const chatId = 'chat-pwa-loop-aviso'
  t.after(() => sessionRegistry.delete(chatId))
  // Dos cortes mas (tambien medidos enteros) completan las 3 observaciones minimas; umbral = el menor.
  for (const [id, size] of [['obs-2', 5000], ['obs-3', 6000]] as const) {
    recordDeepSeekExchange(id, size, 0, true)
    recordDeepSeekLengthLimit(id, 10)
  }
  const threshold = readDeepSeekThermometer().threshold!
  assert.ok(threshold > 0)
  // Conversacion ya iniciada (el primer mensaje de una nueva lleva ~8800 caracteres de instrucciones y por si solo ya
  // superaria este umbral de prueba): el mensaje del usuario + la respuesta quedan entre el 80% y el 100%.
  const big = 'x'.repeat(Math.ceil(threshold * 0.85))
  const pwa = fakePwa([`Listo: ${big}`], true, 'aaaaaaaa-0000-0000-0000-000000000004')
  connectPwa(chatId, pwa.runtime)
  await runTurnForWindow(chatId, { text: 'responde largo', providerId: 'pwa', modelId: 'pwa-m', sandbox: 'danger-full-access' })
  const notices = contextNotices(chatId)
  assert.equal(notices.length, 1)
  assert.match(notices[0], /Termometro de Amatista \(aproximado\).*se esta acercando/)
  assert.match(notices[0], /no es una medida exacta de tokens/)
})

test('loop real: texto alrededor de una llamada valida sigue sin ejecutarse (sin cambios de seguridad)', async (t) => {
  const chatId = 'chat-pwa-loop-narra'
  t.after(() => sessionRegistry.delete(chatId))
  fs.writeFileSync(path.join(workspace, 'no_borrar.txt'), 'intacto')
  const pwa = fakePwa(['Los leo y despues borro:\n\nTOOL_CALL: write_file(path="no_borrar.txt", content="pisado")'], false)
  connectPwa(chatId, pwa.runtime)
  await runTurnForWindow(chatId, { text: 'hace algo', providerId: 'pwa', modelId: 'pwa-m', sandbox: 'danger-full-access' })
  assert.deepEqual(toolSteps(chatId), [])
  assert.equal(fs.readFileSync(path.join(workspace, 'no_borrar.txt'), 'utf8'), 'intacto')
  assert.match(finalText(chatId), /menciona un TOOL_CALL dentro de un texto, pero no se ejecuto/)
})
