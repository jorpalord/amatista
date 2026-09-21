// Test de regresion real (hallazgo de docs/_arch/verify_native_multimodal_tools_design.md):
// read_document ante una pagina de PDF ESCANEADA (sin texto extraible) le
// decia al modelo "Se adjunta como imagen" en los 4 runtimes, pero solo
// anthropic-api arma de verdad el bloque de imagen -- en foundry/gemini-api/
// openai-chat el modelo creia ver una pagina que no veia (riesgo de inventar
// su contenido). Regla fijada: NUNCA afirmar un adjunto que no ocurre.
// PDF escaneado REAL (una imagen JPEG embebida, sin capa de texto) armado a
// mano y renderizado por el mismo pdfjs-dist + @napi-rs/canvas de produccion.
import path from 'node:path'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createCanvas } from '@napi-rs/canvas'
import { ToolRegistry } from '../../src/main/tool-registry'
import { ApiAgentRuntime, type ApiAgentKind } from '../../src/main/api-agent-runtime'

function pdfFrom(bodies: Buffer[]): Buffer {
  let out = Buffer.from('%PDF-1.4\n', 'binary')
  const offsets: number[] = []
  bodies.forEach((body, i) => {
    offsets.push(out.length)
    out = Buffer.concat([out, Buffer.from(`${i + 1} 0 obj\n`), body, Buffer.from('\nendobj\n')])
  })
  const xrefAt = out.length
  const xref = `xref\n0 ${bodies.length + 1}\n0000000000 65535 f \n` + offsets.map(o => String(o).padStart(10, '0') + ' 00000 n \n').join('')
  return Buffer.concat([out, Buffer.from(`${xref}trailer\n<< /Size ${bodies.length + 1} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`)])
}
const stream = (dict: string, data: Buffer): Buffer => Buffer.concat([Buffer.from(`<< ${dict} /Length ${data.length} >>\nstream\n`), data, Buffer.from('\nendstream')])

function scannedPdf(): Buffer {
  const canvas = createCanvas(600, 800)
  const g = canvas.getContext('2d')
  g.fillStyle = '#fff'; g.fillRect(0, 0, 600, 800)
  g.fillStyle = '#000'; g.font = 'bold 48px Arial'; g.fillText('CODIGO: TIGRE-7263', 40, 300)
  const jpeg = canvas.toBuffer('image/jpeg', 90)
  return pdfFrom([
    Buffer.from('<< /Type /Catalog /Pages 2 0 R >>'),
    Buffer.from('<< /Type /Pages /Kids [3 0 R] /Count 1 >>'),
    Buffer.from('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /XObject << /Im0 5 0 R >> >> >>'),
    stream('', Buffer.from('q 612 0 0 792 0 0 cm /Im0 Do Q')),
    stream('/Type /XObject /Subtype /Image /Width 600 /Height 800 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode', jpeg)
  ])
}

function textPdf(text: string): Buffer {
  return pdfFrom([
    Buffer.from('<< /Type /Catalog /Pages 2 0 R >>'),
    Buffer.from('<< /Type /Pages /Kids [3 0 R] /Count 1 >>'),
    Buffer.from('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>'),
    stream('', Buffer.from(`BT /F1 24 Tf 72 700 Td (${text}) Tj ET`)),
    Buffer.from('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>')
  ])
}

const OLD_ATTACH_TEXT =
  'Pagina 1/1 de "escaneado.pdf" no tiene texto extraible (escaneada). ' +
  'Se adjunta como imagen (si el runtime activo lo soporta) para leerla con vision.'

test('read_document con pagina escaneada: solo afirma "se adjunta" cuando el runtime realmente adjunta', async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'amatista-regression-scanned-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const workspace = realpathSync(root)
  writeFileSync(path.join(root, 'escaneado.pdf'), scannedPdf())
  writeFileSync(path.join(root, 'con_texto.pdf'), textPdf('TEXTO-REAL-EXTRAIBLE'))

  const registry = new ToolRegistry()
  const base = { workspace, confirm: async (): Promise<boolean> => true, sandbox: 'workspace-write' as const, sessionId: 'scanned-test' }
  const args = { path: 'escaneado.pdf', page: 1 }

  // (a) runtime SIN soporte de imagen en tool_result (foundry/gemini-api/openai-chat, o cualquier llamador que no lo declare)
  const noSupport = await registry.execute('read_document', args, base)
  assert.equal(noSupport.ok, true, JSON.stringify(noSupport))
  assert.match(String(noSupport.output), /NO se adjunta ninguna imagen/)
  assert.match(String(noSupport.output), /no se puede leer el contenido visual/)
  assert.doesNotMatch(String(noSupport.output), /Se adjunta como imagen/, 'NUNCA afirmar un adjunto que no ocurre')
  assert.equal(noSupport.resultImageDataUrl, undefined, 'no debe viajar una imagen que ningun runtime va a adjuntar')

  // (b) runtime CON soporte (anthropic-api) y la imagen cabe: comportamiento IDENTICO al de siempre
  const withSupport = await registry.execute('read_document', args, { ...base, resultImageMaxBytes: 10 * 1024 * 1024 })
  assert.equal(withSupport.ok, true, JSON.stringify(withSupport))
  assert.equal(withSupport.output, OLD_ATTACH_TEXT, 'el texto para anthropic-api no cambia')
  assert.ok(withSupport.resultImageDataUrl?.startsWith('data:image/png;base64,'), 'la imagen real sigue adjuntandose')
  const png = Buffer.from(String(withSupport.resultImageDataUrl).split(',')[1], 'base64')
  assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10], 'la imagen adjunta es un PNG valido')

  // (c) runtime CON soporte pero la imagen NO cabe en su limite: tampoco se afirma un adjunto
  const tooBig = await registry.execute('read_document', args, { ...base, resultImageMaxBytes: 1000 })
  assert.equal(tooBig.ok, true, JSON.stringify(tooBig))
  assert.match(String(tooBig.output), /supera el limite/)
  assert.match(String(tooBig.output), /NO se adjunta ninguna imagen/)
  assert.doesNotMatch(String(tooBig.output), /Se adjunta como imagen/)
  assert.equal(tooBig.resultImageDataUrl, undefined)

  // (d) una pagina CON texto no cambia para nadie
  for (const ctx of [base, { ...base, resultImageMaxBytes: 10 * 1024 * 1024 }]) {
    const withText = await registry.execute('read_document', { path: 'con_texto.pdf', page: 1 }, ctx)
    assert.equal(withText.ok, true, JSON.stringify(withText))
    assert.match(String(withText.output), /TEXTO-REAL-EXTRAIBLE/)
    assert.equal(withText.resultImageDataUrl, undefined)
  }
})

test('ApiAgentRuntime.toolResultImageMaxBytes(): solo anthropic-api declara soporte de imagen en tool_result', () => {
  const provider = { id: 'p', name: 'p', type: 'openrouter' as const, authMode: 'api-key' as const, enabled: true, models: [] }
  const limits = {} as Record<ApiAgentKind, number | undefined>
  for (const kind of ['anthropic-api', 'foundry', 'gemini-api', 'openai-chat'] as const) {
    const runtime = new ApiAgentRuntime()
    runtime.configure({ kind, provider, model: 'm', workspace: tmpdir(), sandbox: 'read-only', toolsEnabled: false })
    limits[kind] = runtime.toolResultImageMaxBytes()
  }
  assert.equal(limits['anthropic-api'], 10 * 1024 * 1024)
  assert.equal(limits.foundry, undefined)
  assert.equal(limits['gemini-api'], undefined)
  assert.equal(limits['openai-chat'], undefined)
  // sin configurar tampoco afirma soporte
  assert.equal(new ApiAgentRuntime().toolResultImageMaxBytes(), undefined)
})
