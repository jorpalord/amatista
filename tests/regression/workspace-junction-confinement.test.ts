// Test de regresion real (hallazgo de seguridad de docs/_arch/verify_native_multimodal_tools_design.md):
// resolveWithinWorkspace() (tool-registry.ts) comparaba TEXTO (startsWith) --
// una junction/symlink DENTRO del workspace apuntando afuera lo pasaba, y
// read_file/read_document/list_dir/write_file/... operaban fuera de el.
// Reproduccion real (junction real en carpetas temporales), invocando las
// tools por ToolRegistry.execute() -- mismo camino que usa cada runtime.
// Ademas de los ataques (deben rechazarse) se fijan los CONTROLES que tienen
// que seguir funcionando: rutas normales, junction que apunta ADENTRO,
// archivos nuevos y rutas inexistentes -- el fix no puede romper lo legitimo.
import path from 'node:path'
import { mkdtempSync, mkdirSync, realpathSync, rmSync, rmdirSync, symlinkSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ToolRegistry } from '../../src/main/tool-registry'

function buildTextPdf(text: string): Buffer {
  const stream = (dict: string, data: Buffer): Buffer => Buffer.concat([Buffer.from(`<< ${dict} /Length ${data.length} >>\nstream\n`), data, Buffer.from('\nendstream')])
  const bodies = [
    Buffer.from('<< /Type /Catalog /Pages 2 0 R >>'),
    Buffer.from('<< /Type /Pages /Kids [3 0 R] /Count 1 >>'),
    Buffer.from('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>'),
    stream('', Buffer.from(`BT /F1 24 Tf 72 700 Td (${text}) Tj ET`)),
    Buffer.from('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>')
  ]
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

test('junction dentro del workspace que apunta AFUERA: ninguna tool de lectura/escritura puede atravesarla', async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'amatista-regression-junction-'))
  const workspaceRaw = path.join(root, 'workspace')
  const outside = path.join(root, 'afuera')
  mkdirSync(workspaceRaw)
  mkdirSync(outside)
  mkdirSync(path.join(workspaceRaw, 'subdir'))
  writeFileSync(path.join(workspaceRaw, 'normal.txt'), 'CONTENIDO-NORMAL', 'utf8')
  writeFileSync(path.join(workspaceRaw, 'subdir', 'interno.txt'), 'CONTENIDO-INTERNO', 'utf8')
  writeFileSync(path.join(outside, 'secreto.txt'), 'SECRETO-FUERA-DEL-WORKSPACE', 'utf8')
  writeFileSync(path.join(outside, 'fuera.pdf'), buildTextPdf('PDF-SECRETO-FUERA'))

  const junctionOut = path.join(workspaceRaw, 'enlace')
  const junctionIn = path.join(workspaceRaw, 'enlace_interno')
  const junctionBroken = path.join(workspaceRaw, 'roto')
  symlinkSync(outside, junctionOut, 'junction')
  symlinkSync(path.join(workspaceRaw, 'subdir'), junctionIn, 'junction')
  let brokenCreated = true
  try { symlinkSync(path.join(root, 'no_existe'), junctionBroken, 'junction') } catch { brokenCreated = false }

  t.after(() => {
    // primero SOLO los enlaces (rmdirSync sobre una junction borra el enlace, nunca el destino)
    for (const link of [junctionOut, junctionIn, junctionBroken]) { try { rmdirSync(link) } catch { /* ya no existe */ } }
    rmSync(root, { recursive: true, force: true })
  })

  // main hace realpathSync(workspace) al conectar (ipc-agent.ts) -- mismo criterio aca
  const workspace = realpathSync(workspaceRaw)
  const registry = new ToolRegistry()
  const ctx = { workspace, confirm: async (): Promise<boolean> => true, sandbox: 'workspace-write' as const, sessionId: 'junction-test' }
  const run = (name: string, args: Record<string, unknown>) => registry.execute(name, args, ctx)

  // ── CONTROLES: lo legitimo sigue funcionando ──
  const normal = await run('read_file', { path: 'normal.txt' })
  assert.equal(normal.ok, true, JSON.stringify(normal))
  assert.equal(normal.output, 'CONTENIDO-NORMAL')

  const viaInternal = await run('read_file', { path: 'enlace_interno/interno.txt' })
  assert.equal(viaInternal.ok, true, `una junction que apunta ADENTRO del workspace debe seguir funcionando: ${JSON.stringify(viaInternal)}`)
  assert.equal(viaInternal.output, 'CONTENIDO-INTERNO')

  const missing = await run('read_file', { path: 'no_existe.txt' })
  assert.equal(missing.ok, false)
  assert.match(String(missing.output), /no encontrado/i, 'un archivo inexistente DENTRO del workspace no es un error de confinacion')

  const created = await run('write_file', { path: 'nuevo.txt', content: 'hola\n' })
  assert.equal(created.ok, true, `crear un archivo NUEVO dentro del workspace debe seguir funcionando: ${JSON.stringify(created)}`)
  assert.equal(readFileSync(path.join(workspaceRaw, 'nuevo.txt'), 'utf8'), 'hola\n')

  // ── ATAQUES: ninguno puede tocar lo que hay afuera ──
  const lexical = await run('read_file', { path: '../afuera/secreto.txt' })
  assert.equal(lexical.ok, false, 'el chequeo lexico original (..) tiene que seguir rechazando')

  const readFile = await run('read_file', { path: 'enlace/secreto.txt' })
  assert.equal(readFile.ok, false, `read_file via junction hacia afuera debe rechazarse: ${JSON.stringify(readFile)}`)
  assert.match(String(readFile.output), /fuera del workspace/i)
  assert.doesNotMatch(String(readFile.output), /SECRETO-FUERA/, 'el contenido de afuera NO puede filtrarse en el mensaje')

  const readDoc = await run('read_document', { path: 'enlace/fuera.pdf' })
  assert.equal(readDoc.ok, false, `read_document via junction hacia afuera debe rechazarse: ${JSON.stringify(readDoc)}`)
  assert.match(String(readDoc.output), /fuera del workspace/i)
  assert.doesNotMatch(String(readDoc.output), /PDF-SECRETO/)

  const listDir = await run('list_dir', { path: 'enlace' })
  assert.equal(listDir.ok, false, `list_dir via junction hacia afuera debe rechazarse: ${JSON.stringify(listDir)}`)
  assert.doesNotMatch(String(listDir.output), /secreto\.txt/)

  const searchInto = await run('search_files', { pattern: 'SECRETO', path: 'enlace' })
  assert.equal(searchInto.ok, false, `search_files con raiz dentro de la junction debe rechazarse: ${JSON.stringify(searchInto)}`)

  const searchWalk = await run('search_files', { pattern: 'SECRETO-FUERA', path: '.' })
  assert.doesNotMatch(String(searchWalk.output), /SECRETO-FUERA/, 'el recorrido recursivo desde la raiz no debe seguir la junction hacia afuera')

  const writeThrough = await run('write_file', { path: 'enlace/nuevo_afuera.txt', content: 'no deberia existir\n' })
  assert.equal(writeThrough.ok, false, `write_file de un archivo NUEVO via junction hacia afuera debe rechazarse: ${JSON.stringify(writeThrough)}`)
  assert.equal(existsSync(path.join(outside, 'nuevo_afuera.txt')), false, 'NO debe haberse creado nada en la carpeta de afuera')

  // ── enlace ROTO (destino inexistente): no se puede afirmar que este adentro -> se rechaza y no se crea nada ──
  if (brokenCreated) {
    const viaBroken = await run('write_file', { path: 'roto/x.txt', content: 'x\n' })
    assert.equal(viaBroken.ok, false, `un enlace roto no verificable debe rechazarse: ${JSON.stringify(viaBroken)}`)
    assert.equal(existsSync(path.join(root, 'no_existe')), false, 'no debe haberse creado el destino del enlace roto')
  } else {
    t.diagnostic('no se pudo crear una junction rota en esta plataforma: se omite ese caso')
  }
})
