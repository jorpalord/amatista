// Experimento DeepSeek PWA (rama experiment/deepseek-pwa, docs/_experiments/deepseek-pwa/CONTRACT.md):
// prueba de CONTRATO del parser contra capturas REALES del stream de chat.deepseek.com (contenido de prueba
// inocuo, sin tokens -- chequeado antes de copiarlas). Si DeepSeek cambia su formato, esto falla primero.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { DeepSeekStreamParser, describeStreamOutcome, type DeepSeekStreamEvent, type DeepSeekTurnOutcome } from '../../src/main/deepseek-pwa-stream'

const fixture = (name: string): string => readFileSync(path.join('tests', 'regression', '_fixtures', 'deepseek-pwa', name), 'utf8')

/** Alimenta el stream en trozos de tamano variable (simula los chunks reales de red, que cortan lineas). */
function feedInChunks(raw: string, sizes: number[]): { events: DeepSeekStreamEvent[]; parser: DeepSeekStreamParser } {
  const parser = new DeepSeekStreamParser()
  const events: DeepSeekStreamEvent[] = []
  let i = 0; let k = 0
  while (i < raw.length) { const n = sizes[k++ % sizes.length]; events.push(...parser.feed(raw.slice(i, i + n))); i += n }
  return { events, parser }
}

function collect(events: DeepSeekStreamEvent[]): { think: string; response: string; statuses: string[]; fragments: string[]; title: string | null; initial: DeepSeekStreamEvent | undefined } {
  let think = ''; let response = ''; const statuses: string[] = []; const fragments: string[] = []; let title: string | null = null
  for (const e of events) {
    if (e.kind === 'think') think += e.text
    if (e.kind === 'response') response += e.text
    if (e.kind === 'status') statuses.push(e.status)
    if (e.kind === 'fragment') fragments.push(e.type)
    if (e.kind === 'title') title = e.title
  }
  return { think, response, statuses, fragments, title, initial: events.find(e => e.kind === 'initial') }
}

test('captura real (razonamiento + respuesta larga): THINK y RESPONSE separados, sin mezcla, status FINISHED', () => {
  const raw = fixture('think-long-response.sse')
  for (const sizes of [[raw.length], [7], [1, 13, 64, 3], [200]]) {
    const { events, parser } = feedInChunks(raw, sizes)
    const r = collect(events)
    assert.ok(parser.recognized)
    assert.deepEqual(r.fragments, ['THINK', 'RESPONSE'])
    assert.deepEqual(r.statuses, ['FINISHED'])
    assert.equal(r.think.length, 1388, `THINK con trozos ${sizes.join(',')}`)
    assert.equal(r.response.length, 754, `RESPONSE con trozos ${sizes.join(',')}`)
    assert.ok(r.response.startsWith('1.'), 'regla 2: el content inicial del fragmento RESPONSE ("1") cuenta')
    assert.ok(/puente/i.test(r.response))
    assert.equal(r.title, 'Puentes 1 al 6', 'regla 6: el evento title trae el titulo real que genera DeepSeek')
    assert.equal(parser.unrecognizedSamples.length, 0, JSON.stringify(parser.unrecognizedSamples))
    assert.deepEqual(r.initial, { kind: 'initial', thinkingEnabled: true, searchEnabled: true })
  }
})

test('captura real (razonamiento corto): la respuesta entera viene en el content inicial del fragmento', () => {
  const { events, parser } = feedInChunks(fixture('think-short.sse'), [5, 40])
  const r = collect(events)
  assert.ok(parser.recognized)
  assert.deepEqual(r.fragments, ['THINK', 'RESPONSE'])
  assert.equal(r.response, '391')
  assert.equal(r.think.length, 56)
  assert.deepEqual(r.statuses, ['FINISHED'])
})

test('stream con formato irreconocible: nunca se reconoce, y el veredicto es un error honesto (no texto basura)', () => {
  const parser = new DeepSeekStreamParser()
  const events = parser.feed('data: {"foo":"bar"}\n\ndata: {"weird":[1,2,3]}\n\nnot-sse garbage\n\ndata: no-es-json\n\n')
  assert.equal(parser.recognized, false)
  assert.equal(events.filter(e => e.kind === 'response').length, 0)
  const verdict = describeStreamOutcome(outcome({ httpStatus: 200, status: null, recognized: false }))
  assert.equal(verdict.kind, 'error')
  assert.match((verdict as { message: string }).message, /cambio el formato/)
})

test('describeStreamOutcome(): la verdad sale del stream, con el dato real tal cual', () => {
  assert.equal(describeStreamOutcome(outcome({ status: 'FINISHED', responseText: 'hola' })).kind, 'success')
  assert.equal(describeStreamOutcome(outcome({ status: 'INCOMPLETE', responseText: 'par', cancelledByUser: true })).kind, 'cancelled')
  // INCOMPLETE sin que el usuario haya cancelado NO es un exito ni una cancelacion: se reporta el status real.
  assert.match(msg(outcome({ status: 'INCOMPLETE', responseText: 'x' })), /status "INCOMPLETE"/)
  assert.match(msg(outcome({ status: 'FINISHED', responseText: '   ' })), /sin devolver respuesta/)
  assert.match(msg(outcome({ httpStatus: 429, status: null })), /HTTP 429/)
  assert.match(msg(outcome({ errors: [{ code: 40003, msg: 'mensaje real del servidor' }] })), /mensaje real del servidor \(code 40003\)/)
  assert.match(msg(outcome({ networkError: 'net::ERR_CONNECTION_RESET' })), /ERR_CONNECTION_RESET/)
  assert.match(msg(outcome({ inactivityTimeout: true })), /dejo de responder/)
  assert.match(msg(outcome({ status: null })), /sin informar un status/)
})

function outcome(partial: Partial<DeepSeekTurnOutcome>): DeepSeekTurnOutcome {
  return { httpStatus: 200, status: 'FINISHED', responseText: '', thinkText: '', recognized: true, errors: [], networkError: null, cancelledByUser: false, inactivityTimeout: false, unrecognizedSamples: [], ...partial }
}
function msg(o: DeepSeekTurnOutcome): string { const v = describeStreamOutcome(o); return v.kind === 'error' ? v.message : `(${v.kind})` }
