// Test de regresion real (F0 de docs/_arch/verify_native_multimodal_tools_design.md):
// imagen dentro del RESULTADO de una tool en los 4 runtimes API. Hasta F0 solo
// anthropic-api la armaba; foundry/gemini-api/openai-chat mandaban solo texto.
// Cada test arma un ApiAgentRuntime REAL contra un servidor HTTP falso que habla
// el protocolo de cada proveedor y captura la request real que el runtime manda
// en la SEGUNDA vuelta (la que lleva el resultado de la tool) -- se verifica la
// forma EXACTA de cable de cada API, no solo que "haya imagen".
import http from 'node:http'
import { tmpdir } from 'node:os'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createCanvas } from '@napi-rs/canvas'
import {
  ApiAgentRuntime,
  MAX_TOOL_RESULT_IMAGES_PER_TURN,
  resultImageFor,
  toolResultImageBlocker,
  type ApiAgentKind
} from '../../src/main/api-agent-runtime'

const KINDS: ApiAgentKind[] = ['anthropic-api', 'foundry', 'gemini-api', 'openai-chat']
const OUTPUT_TEXT = 'Captura real de 64x48px.'

function tinyPng(): { base64: string; dataUrl: string } {
  const canvas = createCanvas(64, 48)
  const g = canvas.getContext('2d')
  g.fillStyle = '#c33'; g.fillRect(0, 0, 64, 48)
  g.fillStyle = '#fff'; g.fillRect(8, 8, 20, 12)
  const base64 = canvas.toBuffer('image/png').toString('base64')
  return { base64, dataUrl: `data:image/png;base64,${base64}` }
}
const PNG = tinyPng()

interface Captured { url: string; body: Record<string, unknown> }

/** Servidor "modelo" falso: las primeras `steps.length` peticiones piden las tool calls de cada paso; despues responde el texto final. */
async function startFakeModel(steps: Array<Array<{ name: string; args: Record<string, unknown> }>>): Promise<{ endpoint: string; requests: Captured[]; close: () => Promise<void> }> {
  const requests: Captured[] = []
  const server = http.createServer((req, res) => {
    let raw = ''
    req.on('data', chunk => { raw += chunk })
    req.on('end', () => {
      const body = JSON.parse(raw || '{}') as Record<string, unknown>
      const url = req.url ?? ''
      requests.push({ url, body })
      const step = steps[requests.length - 1]
      const send = (obj: unknown): void => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)) }
      const id = (i: number): string => `call_${requests.length}_${i}`
      if (url.includes('/v1/messages')) {
        return send(step
          ? { content: step.map((c, i) => ({ type: 'tool_use', id: id(i), name: c.name, input: c.args })), usage: { input_tokens: 1, output_tokens: 1 } }
          : { content: [{ type: 'text', text: 'FINAL' }], usage: { input_tokens: 1, output_tokens: 1 } })
      }
      if (url.includes('/responses')) {
        return send(step
          ? { output: step.map((c, i) => ({ type: 'function_call', call_id: id(i), name: c.name, arguments: JSON.stringify(c.args) })) }
          : { output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'FINAL' }] }] })
      }
      if (url.includes(':generateContent')) {
        return send(step
          // functionCall.id + thoughtSignature: lo que devuelve Gemini 3 (el runtime debe devolver el id y repetir el turno del modelo tal cual)
          ? { candidates: [{ content: { role: 'model', parts: step.map((c, i) => ({ functionCall: { id: id(i), name: c.name, args: c.args }, ...(i === 0 ? { thoughtSignature: 'sig-abc' } : {}) })) } }] }
          : { candidates: [{ content: { role: 'model', parts: [{ text: 'FINAL' }] } }] })
      }
      // openai-chat
      return send(step
        ? { choices: [{ message: { role: 'assistant', content: null, tool_calls: step.map((c, i) => ({ id: id(i), type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args) } })) } }], usage: { total_tokens: 2 } }
        : { choices: [{ message: { role: 'assistant', content: 'FINAL' } }], usage: { total_tokens: 2 } })
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  return { endpoint: `http://127.0.0.1:${port}`, requests, close: () => new Promise<void>(resolve => { server.close(() => resolve()) }) }
}

const MODEL_BY_KIND: Record<ApiAgentKind, string> = {
  'anthropic-api': 'claude-fake',
  foundry: 'gpt-fake',
  'gemini-api': 'gemini-3-flash-preview',
  'openai-chat': 'gpt-fake-chat'
}

async function runTurn(
  kind: ApiAgentKind,
  steps: Array<Array<{ name: string; args: Record<string, unknown> }>>,
  options: { model?: string; visionCapable?: boolean; toolResult?: (n: number) => { ok: boolean; output: string; resultImageDataUrl?: string } } = {}
): Promise<Captured[]> {
  const fake = await startFakeModel(steps)
  try {
    let calls = 0
    const runtime = new ApiAgentRuntime()
    runtime.configure({
      kind,
      provider: { id: 'p', name: 'p', type: 'openrouter', authMode: 'api-key', endpoint: fake.endpoint, apiKey: 'k', enabled: true, models: [] },
      model: options.model ?? MODEL_BY_KIND[kind],
      workspace: tmpdir(),
      sandbox: 'workspace-write',
      toolsEnabled: true,
      visionCapable: options.visionCapable,
      toolExecutor: async () => (options.toolResult ? options.toolResult(++calls) : { ok: true, output: OUTPUT_TEXT, resultImageDataUrl: PNG.dataUrl })
    })
    const result = await runtime.send('mostrame la pantalla')
    assert.equal(result.text, 'FINAL')
    return fake.requests
  } finally {
    await fake.close()
  }
}

const SCREENSHOT_STEP = [{ name: 'screenshot', args: {} }]

// ────────────────────────── 1) formato REAL de cada API cuando la imagen viaja ──────────────────────────

test('anthropic-api: tool_result.content = [text, image base64] (formato de siempre, sin cambios)', async () => {
  const requests = await runTurn('anthropic-api', [SCREENSHOT_STEP])
  const messages = requests[1].body.messages as Array<{ role: string; content: unknown }>
  const last = messages[messages.length - 1]
  assert.equal(last.role, 'user')
  const block = (last.content as Array<Record<string, unknown>>)[0]
  assert.equal(block.type, 'tool_result')
  assert.deepEqual(block.content, [
    { type: 'text', text: OUTPUT_TEXT },
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG.base64 } }
  ])
})

test('foundry (Responses API): function_call_output.output = [input_text, input_image{image_url}]', async () => {
  const requests = await runTurn('foundry', [SCREENSHOT_STEP])
  const input = requests[1].body.input as Array<Record<string, unknown>>
  const out = input.find(item => item.type === 'function_call_output')
  assert.ok(out, 'debe haber un function_call_output')
  assert.equal(out.call_id, 'call_1_0')
  assert.deepEqual(out.output, [
    { type: 'input_text', text: OUTPUT_TEXT },
    { type: 'input_image', image_url: PNG.dataUrl }
  ])
})

test('gemini-api (Gemini 3): role:"user" + functionResponse con id del functionCall + parts[inlineData]; el turno del modelo se repite tal cual (thoughtSignature)', async () => {
  const requests = await runTurn('gemini-api', [SCREENSHOT_STEP])
  const contents = requests[1].body.contents as Array<{ role: string; parts: Array<Record<string, unknown>> }>
  const last = contents[contents.length - 1]
  assert.equal(last.role, 'user', 'el enum documentado de Content.role es user|model -- ya no se manda "function"')
  assert.equal(last.parts.length, 1)
  assert.deepEqual(last.parts[0], {
    functionResponse: {
      name: 'screenshot',
      id: 'call_1_0',
      response: { content: OUTPUT_TEXT },
      parts: [{ inlineData: { mimeType: 'image/png', data: PNG.base64 } }]
    }
  })
  const modelTurn = contents[contents.length - 2]
  assert.equal(modelTurn.role, 'model')
  assert.equal(modelTurn.parts[0].thoughtSignature, 'sig-abc', 'Gemini 3 exige devolver el thoughtSignature del turno del modelo')
  assert.deepEqual((modelTurn.parts[0].functionCall as Record<string, unknown>).id, 'call_1_0')
})

test('openai-chat: los `tool` llevan solo texto y la imagen va en UN `user` con image_url DESPUES de todos los `tool`', async () => {
  const requests = await runTurn('openai-chat', [[{ name: 'screenshot', args: {} }, { name: 'browser_screenshot', args: {} }]])
  const messages = requests[1].body.messages as Array<{ role: string; content: unknown; tool_call_id?: string }>
  const roles = messages.map(m => m.role)
  const firstTool = roles.indexOf('tool')
  assert.deepEqual(roles.slice(firstTool), ['tool', 'tool', 'user'], `orden esperado assistant(tool_calls) -> tool -> tool -> user, real: ${roles.join(',')}`)
  const [t1, t2, user] = messages.slice(firstTool)
  assert.equal(typeof t1.content, 'string')
  assert.match(String(t1.content), /Captura real de 64x48px\./)
  assert.match(String(t1.content), /se adjunta en el mensaje siguiente/)
  assert.equal(t1.tool_call_id, 'call_1_0')
  assert.equal(t2.tool_call_id, 'call_1_1')
  const parts = user.content as Array<Record<string, unknown>>
  assert.equal(parts.filter(p => p.type === 'image_url').length, 2, 'una imagen por cada tool que devolvio una')
  assert.deepEqual(parts.find(p => p.type === 'image_url'), { type: 'image_url', image_url: { url: PNG.dataUrl } })
  assert.match(String(parts[0].text), /screenshot/)
  assert.match(String(parts[2].text), /browser_screenshot/)
})

// ────────────────────────── 2) modelo SIN vision: metadata honesta, nunca un adjunto falso ──────────────────────────

for (const kind of KINDS) {
  test(`${kind}: modelo con vision:false -> NINGUNA imagen en la request, metadata honesta en texto`, async () => {
    const requests = await runTurn(kind, [SCREENSHOT_STEP], { visionCapable: false })
    const wire = JSON.stringify(requests[1].body)
    assert.equal(wire.includes(PNG.base64), false, 'no debe viajar la imagen')
    assert.equal(wire.includes('input_image'), false)
    assert.equal(wire.includes('inlineData'), false)
    assert.equal(wire.includes('image_url'), false)
    assert.equal(wire.includes('"type":"image"'), false)
    assert.match(wire, /NO se adjunta la imagen/)
    assert.match(wire, /no tiene vision/)
    assert.match(wire, /image\/png, 64x48 px/, 'metadata que SI se puede dar sin ver la imagen (tipo y dimensiones)')
    assert.match(wire, /No inventes ni supongas su contenido visual/)
  })
}

test('gemini-api con un modelo anterior a la serie 3 (2.5, o modelo vacio = default): degrada, no inventa un formato no documentado', async () => {
  for (const model of ['gemini-2.5-pro', '']) {
    const requests = await runTurn('gemini-api', [SCREENSHOT_STEP], { model })
    const wire = JSON.stringify(requests[1].body)
    assert.equal(wire.includes(PNG.base64), false, `modelo "${model}": no debe viajar la imagen`)
    assert.match(wire, /solo los modelos Gemini 3 o posteriores/)
    // igual se corrige role e id aunque no haya imagen
    const contents = requests[1].body.contents as Array<{ role: string }>
    assert.equal(contents[contents.length - 1].role, 'user')
  }
})

// ────────────────────────── 3) chokepoint puro: casos que no se pueden armar barato por HTTP ──────────────────────────

test('resultImageFor(): imagen que excede el limite del proveedor, formato invalido o no soportado -> aviso honesto, sin imagen', () => {
  const capability = { model: 'm', visionCapable: true }
  // foundry admite hasta 20 MB; openai-chat solo 10 MB
  const big = `data:image/png;base64,${'A'.repeat(11 * 1024 * 1024)}`
  const overOpenAi = resultImageFor('openai-chat', { ok: true, output: 'x', resultImageDataUrl: big }, capability)
  assert.equal(overOpenAi.image, null)
  assert.match(overOpenAi.text, /supera el limite de 10MB/)
  assert.ok(resultImageFor('foundry', { ok: true, output: 'x', resultImageDataUrl: big }, capability).image, '11 MB si cabe en el limite de 20 MB de foundry')

  assert.match(resultImageFor('anthropic-api', { ok: true, output: 'x', resultImageDataUrl: 'esto-no-es-un-data-url' }, capability).text, /formato de data URL valido/)
  assert.match(resultImageFor('anthropic-api', { ok: true, output: 'x', resultImageDataUrl: 'data:image/bmp;base64,AAAA' }, capability).text, /image\/bmp no lo aceptan/)

  // sin imagen / resultado fallido: el texto pasa intacto y sin avisos
  assert.deepEqual(resultImageFor('foundry', { ok: true, output: 'solo texto' }, capability), { text: 'solo texto', image: null })
  assert.deepEqual(resultImageFor('foundry', { ok: false, output: 'fallo', resultImageDataUrl: PNG.dataUrl }, capability), { text: 'fallo', image: null })
  // con imagen valida el texto es el ORIGINAL, byte a byte
  const ok = resultImageFor('anthropic-api', { ok: true, output: OUTPUT_TEXT, resultImageDataUrl: PNG.dataUrl }, capability)
  assert.equal(ok.text, OUTPUT_TEXT)
  assert.equal(ok.image?.base64, PNG.base64)
})

test('toolResultImageBlocker() y ApiAgentRuntime.toolResultImageMaxBytes(): capacidad por runtime + modelo', () => {
  assert.equal(toolResultImageBlocker('anthropic-api', 'claude-x', true), null)
  assert.equal(toolResultImageBlocker('foundry', 'gpt-x'), null, 'sin dato de vision se asume que ve; solo el false explicito degrada')
  assert.equal(toolResultImageBlocker('openai-chat', 'gpt-x', true), null)
  assert.equal(toolResultImageBlocker('gemini-api', 'gemini-3.1-pro', true), null)
  assert.equal(toolResultImageBlocker('gemini-api', 'models/gemini-4-ultra', true), null)
  assert.match(String(toolResultImageBlocker('gemini-api', 'gemini-2.5-flash', true)), /Gemini 3/)
  assert.match(String(toolResultImageBlocker('gemini-api', '', true)), /Gemini 3/)
  for (const kind of KINDS) assert.match(String(toolResultImageBlocker(kind, MODEL_BY_KIND[kind], false)), /no tiene vision/)

  const provider = { id: 'p', name: 'p', type: 'openrouter' as const, authMode: 'api-key' as const, enabled: true, models: [] }
  const limitFor = (kind: ApiAgentKind, model: string, visionCapable?: boolean): number | undefined => {
    const runtime = new ApiAgentRuntime()
    runtime.configure({ kind, provider, model, workspace: tmpdir(), sandbox: 'read-only', toolsEnabled: false, visionCapable })
    return runtime.toolResultImageMaxBytes()
  }
  const MB = 1024 * 1024
  assert.equal(limitFor('anthropic-api', 'c', true), 10 * MB)
  assert.equal(limitFor('foundry', 'g', true), 20 * MB)
  assert.equal(limitFor('gemini-api', 'gemini-3-flash-preview', true), 20 * MB)
  assert.equal(limitFor('openai-chat', 'g', true), 10 * MB)
  assert.equal(limitFor('gemini-api', 'gemini-2.5-pro', true), undefined)
  for (const kind of KINDS) assert.equal(limitFor(kind, MODEL_BY_KIND[kind], false), undefined, `${kind} sin vision no declara soporte`)
  assert.equal(new ApiAgentRuntime().toolResultImageMaxBytes(), undefined, 'sin configurar tampoco afirma soporte')
})

// ────────────────────────── 4) ventana de imagenes vivas + catalogo ──────────────────────────

for (const kind of KINDS) {
  test(`${kind}: un turno solo conserva las ultimas ${MAX_TOOL_RESULT_IMAGES_PER_TURN} imagenes; las mas viejas pasan a un aviso de texto`, async () => {
    const rounds = MAX_TOOL_RESULT_IMAGES_PER_TURN + 3
    const steps = Array.from({ length: rounds }, () => SCREENSHOT_STEP)
    const requests = await runTurn(kind, steps)
    const finalBody = JSON.stringify(requests[requests.length - 1].body)
    const live = finalBody.split(PNG.base64).length - 1
    const evicted = finalBody.split('Imagen anterior omitida por Amatista').length - 1
    assert.equal(live, MAX_TOOL_RESULT_IMAGES_PER_TURN, `imagenes vivas en la ultima request de ${kind}`)
    assert.equal(evicted, rounds - MAX_TOOL_RESULT_IMAGES_PER_TURN, `imagenes reemplazadas por aviso en ${kind}`)
  })
}

test('las tools de captura (screenshot y browser_screenshot) ya estan en el catalogo de los 4 runtimes', async () => {
  const namesIn = (kind: ApiAgentKind, body: Record<string, unknown>): string[] => {
    const tools = body.tools as Array<Record<string, unknown>>
    if (kind === 'gemini-api') return (tools[0].functionDeclarations as Array<{ name: string }>).map(d => d.name)
    if (kind === 'openai-chat') return tools.map(t => (t.function as { name: string }).name)
    return tools.map(t => String(t.name))
  }
  for (const kind of KINDS) {
    const requests = await runTurn(kind, [], { toolResult: () => ({ ok: true, output: 'x' }) })
    const names = namesIn(kind, requests[0].body)
    for (const expected of ['screenshot', 'mouse_click', 'keyboard_type', 'browser_screenshot']) {
      assert.ok(names.includes(expected), `${kind} debe ofrecer ${expected} (antes solo anthropic-api)`)
    }
  }
})
