// Termometro del limite de longitud de DeepSeek PWA (src/main/deepseek-pwa-thermometer.ts): persistencia real en
// archivo, estado inicial honesto (0 observaciones => sin umbral ni aviso), solo conversaciones medidas enteras cuentan,
// sin duplicados, y el umbral conservador (minimo observado) con avisos una sola vez por nivel.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  readDeepSeekThermometer,
  recordDeepSeekExchange,
  recordDeepSeekLengthLimit,
  THERMOMETER_MIN_OBSERVATIONS
} from '../../src/main/deepseek-pwa-thermometer'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amatista-termometro-'))
const file = path.join(dir, 'deepseek-pwa-termometro.json')
process.env.AMATISTA_DEEPSEEK_PWA_THERMOMETER_FILE = file
after(() => fs.rmSync(dir, { recursive: true, force: true }))

const stored = (): { observations: Array<{ contextChars: number; messages: number }>; conversations: Record<string, { contextChars: number; complete: boolean }> } =>
  JSON.parse(fs.readFileSync(file, 'utf8'))

test('estado inicial: 0 observaciones => sin umbral y SIN aviso, por grande que sea la conversacion', () => {
  assert.deepEqual(readDeepSeekThermometer(), { observations: [], threshold: null, trackedConversations: 0 })
  const first = recordDeepSeekExchange('conv-grande', 500_000, 400_000, true)
  assert.equal(first?.threshold, null)
  assert.equal(first?.level, 0)
  assert.equal(first?.announcement, null)
  assert.equal(first?.contextChars, 900_000)
  assert.equal(stored().observations.length, 0)
})

test('contador: suma enviado + recibido por conversacion remota, persiste en el archivo, sin guardar contenido', () => {
  recordDeepSeekExchange('conv-a', 1200, 30, true)
  const reading = recordDeepSeekExchange('conv-a', 5000, 800, false)
  assert.equal(reading?.contextChars, 7030)
  assert.equal(reading?.complete, true)
  const raw = fs.readFileSync(file, 'utf8')
  assert.doesNotMatch(raw, /conv-a/, 'el id de la conversacion remota se guarda como hash, nunca tal cual')
  assert.equal(recordDeepSeekExchange(null, 10, 10, true), null, 'sin conversacion remota no hay nada que medir')
})

test('corte por longitud en una conversacion medida ENTERA: observacion real persistida, sin duplicar en reintentos', () => {
  const note = recordDeepSeekLengthLimit('conv-a', 900)
  assert.match(note, /corte registrado \(unos 7\.030 caracteres\)/)
  assert.match(note, new RegExp(`1 de ${THERMOMETER_MIN_OBSERVATIONS} observaciones`))
  assert.deepEqual(stored().observations.map(o => o.contextChars), [7030])
  assert.match(recordDeepSeekLengthLimit('conv-a', 900), /ya estaba registrado/)
  assert.equal(stored().observations.length, 1)
})

test('una conversacion que Amatista NO midio desde el principio nunca cuenta como observacion', () => {
  assert.equal(recordDeepSeekExchange('conv-vieja', 100, 100, false)?.complete, false)
  assert.match(recordDeepSeekLengthLimit('conv-vieja', 50), /NO se registro/)
  assert.match(recordDeepSeekLengthLimit('conv-desconocida', 50), /NO se registro/)
  assert.equal(stored().observations.length, 1)
})

test(`con ${THERMOMETER_MIN_OBSERVATIONS} observaciones: umbral = minimo observado; avisa al 80% y al superarlo, una sola vez cada uno`, () => {
  for (const [key, size] of [['conv-b', 9000], ['conv-c', 8000]] as const) {
    recordDeepSeekExchange(key, size, 0, true)
    recordDeepSeekLengthLimit(key, 100)
  }
  assert.equal(readDeepSeekThermometer().threshold, 7030, 'el mas bajo de 7030/9000/8000')

  assert.equal(recordDeepSeekExchange('conv-nueva', 5000, 0, true)?.announcement, null, '5000 < 80% de 7030')
  const near = recordDeepSeekExchange('conv-nueva', 700, 0, false)
  assert.equal(near?.level, 1)
  assert.match(String(near?.announcement), /se esta acercando al corte por longitud mas bajo observado hasta ahora \(7\.030\)/)
  assert.match(String(near?.announcement), /aproximado/)
  assert.equal(recordDeepSeekExchange('conv-nueva', 10, 0, false)?.announcement, null, 'no se repite el mismo nivel')
  const over = recordDeepSeekExchange('conv-nueva', 2000, 0, false)
  assert.equal(over?.level, 2)
  assert.match(String(over?.announcement), /por encima del corte/)
  assert.equal(recordDeepSeekExchange('conv-nueva', 10, 0, false)?.announcement, null)
})

test('un archivo ilegible nunca se pisa en silencio: se aparta y se arranca de cero', () => {
  fs.writeFileSync(file, '{ esto no es json')
  assert.deepEqual(readDeepSeekThermometer().observations, [])
  assert.ok(fs.readdirSync(dir).some(name => name.startsWith('deepseek-pwa-termometro.json.ilegible-')))
})
