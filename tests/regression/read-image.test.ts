// Test de regresion real (F1 de docs/_arch/verify_native_multimodal_tools_design.md): tool read_image.
// Todo se prueba por ToolRegistry.execute() -- el mismo camino que usan los 4 runtimes API y el pipe de los CLIs -- con
// imagenes REALES (generadas por @napi-rs/canvas o armadas byte a byte: EXIF+GPS, TIFF, encabezados "bomba") en
// carpetas temporales. Cubre las guardas encadenadas, el recorte, la privacidad (EXIF/GPS), el confinamiento (junction
// real), la degradacion honesta por el chokepoint de F0 y la cadena completa contra los 4 protocolos de proveedor.
import path from 'node:path'
import { mkdtempSync, mkdirSync, rmSync, rmdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { createCanvas, loadImage } from '@napi-rs/canvas'
import { TOOL_DEFINITIONS, ToolRegistry } from '../../src/main/tool-registry'
import { ApiAgentRuntime, resultImageFor, type ApiAgentKind } from '../../src/main/api-agent-runtime'
import { parseImageRegion, READ_IMAGE_MAX_LONG_SIDE } from '../../src/main/image-reader'
import { startFakeModel } from './_support/fake-model'

const registry = new ToolRegistry()

function makeWorkspace(t: TestContext): { root: string; workspace: string; outside: string } {
  const root = mkdtempSync(path.join(tmpdir(), 'amatista-read-image-'))
  const workspace = path.join(root, 'workspace')
  const outside = path.join(root, 'afuera')
  mkdirSync(workspace)
  mkdirSync(outside)
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return { root, workspace, outside }
}

async function call(workspace: string, args: Record<string, unknown>, extra: { resultImageMaxBytes?: number } = {}) {
  return registry.execute('read_image', args, { workspace, sandbox: 'workspace-write', confirm: async () => false, ...extra })
}

function bufferOf(dataUrl: string): Buffer { return Buffer.from(dataUrl.replace(/^data:[^,]+,/, ''), 'base64') }
async function decoded(dataUrl: string) { return loadImage(bufferOf(dataUrl)) }
async function pixel(dataUrl: string, x: number, y: number): Promise<[number, number, number, number]> {
  const image = await decoded(dataUrl)
  const canvas = createCanvas(image.width, image.height)
  const g = canvas.getContext('2d')
  g.drawImage(image, 0, 0)
  const d = g.getImageData(x, y, 1, 1).data
  return [d[0], d[1], d[2], d[3]]
}
const isRed = (p: number[]): boolean => p[0] > 200 && p[1] < 60 && p[2] < 60
const isBlue = (p: number[]): boolean => p[2] > 200 && p[0] < 60 && p[1] < 60

/** Izquierda ROJA, derecha AZUL. */
function halvesPng(width: number, height: number): Buffer {
  const canvas = createCanvas(width, height)
  const g = canvas.getContext('2d')
  g.fillStyle = '#ff0000'; g.fillRect(0, 0, width / 2, height)
  g.fillStyle = '#0000ff'; g.fillRect(width / 2, 0, width / 2, height)
  return canvas.toBuffer('image/png')
}

// --- fabricas de bytes -----------------------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table: number[] = []
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; table.push(c >>> 0) }
  return table
})()
function crc32(buf: Buffer): number {
  let c = 0xffffffff
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
function pngChunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8); head.writeUInt32BE(data.length, 0); head.write(type, 4, 'latin1')
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, 'latin1'), data])), 0)
  return Buffer.concat([head, data, crc])
}
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
/** PNG con encabezado VALIDO que declara width x height pero SIN datos de pixeles: una "bomba" (decodificarla, si se intentara, agotaria la RAM). */
function bombPng(width: number, height: number): Buffer {
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 0
  return Buffer.concat([PNG_SIGNATURE, pngChunk('IHDR', ihdr), pngChunk('IEND', Buffer.alloc(0))])
}
/** Inserta un chunk tEXt (comentario con "secreto") justo despues de IHDR de un PNG real. */
function pngWithTextChunk(png: Buffer, keyword: string, text: string): Buffer {
  const at = 8 + 12 + 13 // firma + chunk IHDR completo
  return Buffer.concat([png.subarray(0, at), pngChunk('tEXt', Buffer.from(`${keyword}\0${text}`, 'latin1')), png.subarray(at)])
}
function bombJpeg(width: number, height: number): Buffer {
  const sof = Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 0xff, width >> 8, width & 0xff, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01])
  return Buffer.concat([Buffer.from([0xff, 0xd8]), sof, Buffer.from([0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00, 0xff, 0xd9])])
}

/** Bloque APP1 EXIF (TIFF little-endian) REAL: Make + Orientation + puntero a un GPS IFD con latitud/longitud. Insertado justo despues de SOI. */
function jpegWithExif(jpeg: Buffer, options: { orientation: number; make: string }): Buffer {
  const makeBytes = Buffer.from(`${options.make}\0`, 'latin1')
  const makePadded = makeBytes.length + (makeBytes.length % 2)
  const ifd0Size = 2 + 3 * 12 + 4
  const makeOffset = 8 + ifd0Size
  const gpsOffset = makeOffset + makePadded
  const gpsSize = 2 + 4 * 12 + 4
  const gpsData = gpsOffset + gpsSize
  const tiff = Buffer.alloc(gpsData + 48)
  tiff.write('II', 0, 'latin1'); tiff.writeUInt16LE(42, 2); tiff.writeUInt32LE(8, 4)
  const entry = (at: number, tag: number, type: number, count: number, value: number): void => {
    tiff.writeUInt16LE(tag, at); tiff.writeUInt16LE(type, at + 2); tiff.writeUInt32LE(count, at + 4)
    if (type === 3) tiff.writeUInt16LE(value, at + 8); else tiff.writeUInt32LE(value, at + 8)
  }
  tiff.writeUInt16LE(3, 8)
  entry(10, 0x010f, 2, makeBytes.length, makeOffset)
  entry(22, 0x0112, 3, 1, options.orientation)
  entry(34, 0x8825, 4, 1, gpsOffset)
  makeBytes.copy(tiff, makeOffset)
  tiff.writeUInt16LE(4, gpsOffset)
  const g = gpsOffset + 2
  entry(g, 0x0001, 2, 2, 0); tiff.write('N\0', g + 8, 'latin1')
  entry(g + 12, 0x0002, 5, 3, gpsData)
  entry(g + 24, 0x0003, 2, 2, 0); tiff.write('E\0', g + 32, 'latin1')
  entry(g + 36, 0x0004, 5, 3, gpsData + 24)
  ;[[48, 1], [51, 1], [30, 1], [2, 1], [17, 1], [40, 1]].forEach(([num, den], i) => { tiff.writeUInt32LE(num, gpsData + i * 8); tiff.writeUInt32LE(den, gpsData + i * 8 + 4) })
  const app1 = Buffer.concat([Buffer.from([0xff, 0xe1, 0, 0]), Buffer.from('Exif\0\0', 'latin1'), tiff])
  app1.writeUInt16BE(app1.length - 2, 2)
  return Buffer.concat([jpeg.subarray(0, 2), app1, jpeg.subarray(2)])
}

/** Foto "de celular": lo que se VE es 300x200 con un cuadrado ROJO arriba a la izquierda; el archivo guarda los pixeles girados + Orientation=n. */
function orientedJpeg(orientation: 3 | 6): { file: Buffer; display: { width: number; height: number } } {
  const display = createCanvas(300, 200)
  const dg = display.getContext('2d')
  dg.fillStyle = '#ffffff'; dg.fillRect(0, 0, 300, 200)
  dg.fillStyle = '#ff0000'; dg.fillRect(0, 0, 60, 60)
  const raw = orientation === 6 ? createCanvas(200, 300) : createCanvas(300, 200)
  const rg = raw.getContext('2d')
  if (orientation === 6) { rg.translate(0, 300); rg.rotate(-Math.PI / 2) } else { rg.translate(300, 200); rg.rotate(Math.PI) }
  rg.drawImage(display, 0, 0)
  return { file: jpegWithExif(raw.toBuffer('image/jpeg', 95), { orientation, make: 'CamaraPrivadaXYZ' }), display: { width: 300, height: 200 } }
}

// ────────────────────────── 1) imagen real: la imagen viaja + metadata como TEXTO ──────────────────────────

test('PNG real: llega como JPEG preparado y formato/dimensiones/peso vienen como TEXTO', async t => {
  const { workspace } = makeWorkspace(t)
  writeFileSync(path.join(workspace, 'captura.png'), halvesPng(1200, 800))
  const result = await call(workspace, { path: 'captura.png' })
  assert.equal(result.ok, true, result.output)
  assert.match(result.output, /Imagen "captura\.png": PNG, 1200x800 px \(/)
  assert.match(result.output, /Version preparada para vision: 1200x800 px, JPEG/)
  assert.ok(result.resultImageDataUrl?.startsWith('data:image/jpeg;base64,'))
  const image = await decoded(result.resultImageDataUrl!)
  assert.deepEqual([image.width, image.height], [1200, 800])
  assert.ok(isRed(await pixel(result.resultImageDataUrl!, 100, 400)) && isBlue(await pixel(result.resultImageDataUrl!, 1100, 400)), 'el contenido real de la imagen llega')
  assert.doesNotMatch(result.output, /reducida desde/, 'una imagen chica no se reduce')
})

test('una extension mentirosa no engana: un JPEG llamado .png se lee por sus bytes magicos', async t => {
  const { workspace } = makeWorkspace(t)
  writeFileSync(path.join(workspace, 'disfrazada.png'), createCanvas(200, 100).toBuffer('image/jpeg', 90))
  const result = await call(workspace, { path: 'disfrazada.png' })
  assert.equal(result.ok, true, result.output)
  assert.match(result.output, /Imagen "disfrazada\.png": JPEG, 200x100 px/)
})

// ────────────────────────── 4) lado largo > 1568 se redimensiona ──────────────────────────

test('lado largo > 1568: se reduce ANTES de mandarse (aspecto conservado, nunca se agranda)', async t => {
  const { workspace } = makeWorkspace(t)
  writeFileSync(path.join(workspace, 'ancha.png'), halvesPng(4000, 2000))
  writeFileSync(path.join(workspace, 'alta.png'), halvesPng(1000, 3000))
  writeFileSync(path.join(workspace, 'chica.png'), halvesPng(100, 80))
  const wide = await call(workspace, { path: 'ancha.png' })
  const tall = await call(workspace, { path: 'alta.png' })
  const small = await call(workspace, { path: 'chica.png' })
  const dims = async (r: { resultImageDataUrl?: string }): Promise<number[]> => { const i = await decoded(r.resultImageDataUrl!); return [i.width, i.height] }
  assert.deepEqual(await dims(wide), [READ_IMAGE_MAX_LONG_SIDE, 784])
  assert.deepEqual(await dims(tall), [523, READ_IMAGE_MAX_LONG_SIDE])
  assert.deepEqual(await dims(small), [100, 80], 'una imagen chica NO se agranda')
  assert.match(wide.output, /4000x2000 px/)
  assert.match(wide.output, /reducida desde 4000x2000 px/)
  assert.match(wide.output, /"region"/, 'al reducir, le dice al modelo como pedir mas detalle')
})

// ────────────────────────── 7) recorte por region ──────────────────────────

test('region: devuelve SOLO la parte pedida, a resolucion nativa, y valida sus argumentos', async t => {
  const { workspace } = makeWorkspace(t)
  writeFileSync(path.join(workspace, 'mitades.png'), halvesPng(4000, 2000)) // izquierda roja, derecha azul
  // mitad derecha completa -> todo azul (dimensiones 2000x2000 -> se reduce a 1568x1568 por el lado largo)
  const right = await call(workspace, { path: 'mitades.png', region: { x: 500, y: 0, width: 500, height: 1000 } })
  assert.equal(right.ok, true, right.output)
  assert.ok(isBlue(await pixel(right.resultImageDataUrl!, 10, 10)) && isBlue(await pixel(right.resultImageDataUrl!, 1500, 1500)), 'la mitad derecha es toda azul')
  // recorte que cabe SIN reducir: 1200x800 nativos, desde (2400,200)
  const native = await call(workspace, { path: 'mitades.png', region: { x: 600, y: 100, width: 300, height: 400 } })
  const nativeImage = await decoded(native.resultImageDataUrl!)
  assert.deepEqual([nativeImage.width, nativeImage.height], [1200, 800])
  assert.match(native.output, /Recorte pedido: .*= 1200x800 px desde \(2400, 200\)/)
  assert.ok(isBlue(await pixel(native.resultImageDataUrl!, 600, 400)))
  // mitad izquierda -> roja; y region como JSON en string (algunos modelos/CLIs lo mandan asi)
  const left = await call(workspace, { path: 'mitades.png', region: '{"x":0,"y":0,"width":500,"height":1000}' })
  assert.ok(isRed(await pixel(left.resultImageDataUrl!, 800, 800)))
  // un borde: region que cruza el centro -> mitad roja / mitad azul
  const across = await call(workspace, { path: 'mitades.png', region: { x: 400, y: 0, width: 200, height: 500 } })
  assert.ok(isRed(await pixel(across.resultImageDataUrl!, 50, 100)) && isBlue(await pixel(across.resultImageDataUrl!, 750, 100)))
  // argumentos invalidos: error claro, sin decodificar
  for (const bad of [{ x: -1, y: 0, width: 10, height: 10 }, { x: 900, y: 0, width: 200, height: 10 }, { x: 0, y: 0, width: 0, height: 10 }, { x: 'a', y: 0, width: 5, height: 5 }, { x: null, y: 0, width: 5, height: 5 }, { x: true, y: 0, width: 5, height: 5 }, { x: [], y: 0, width: 5, height: 5 }, { x: '', y: 0, width: 5, height: 5 }, { y: 0, width: 5, height: 5 }, 'no-json', [1, 2, 3, 4]]) {
    const r = await call(workspace, { path: 'mitades.png', region: bad })
    assert.equal(r.ok, false, JSON.stringify(bad))
    assert.match(r.output, /"region"/)
  }
  assert.deepEqual(parseImageRegion(undefined), { ok: true, region: null })
  assert.deepEqual(parseImageRegion({ x: '10', y: 20, width: '30', height: 40 }), { ok: true, region: { x: 10, y: 20, width: 30, height: 40 } })
})

// ────────────────────────── 2) EXIF / GPS ──────────────────────────

test('EXIF: la orientacion se aplica y NINGUN metadato (ni GPS) viaja en la imagen recodificada', async t => {
  const { workspace } = makeWorkspace(t)
  for (const orientation of [6, 3] as const) {
    const { file, display } = orientedJpeg(orientation)
    // el archivo de entrada SI trae el EXIF/GPS (que el test no pase en vacio)
    assert.ok(file.includes(Buffer.from('Exif')) && file.includes(Buffer.from('CamaraPrivadaXYZ')), 'el JPEG de entrada trae EXIF')
    writeFileSync(path.join(workspace, `foto${orientation}.jpg`), file)
    const result = await call(workspace, { path: `foto${orientation}.jpg` })
    assert.equal(result.ok, true, result.output)
    const out = bufferOf(result.resultImageDataUrl!)
    for (const needle of ['Exif', 'CamaraPrivadaXYZ', 'GPS', 'II*', 'MM\0*']) assert.ok(!out.includes(Buffer.from(needle, 'latin1')), `la salida NO debe contener "${needle}"`)
    const image = await decoded(result.resultImageDataUrl!)
    assert.deepEqual([image.width, image.height], [display.width, display.height], `orientacion ${orientation} aplicada`)
    assert.ok(isRed(await pixel(result.resultImageDataUrl!, 20, 20)), 'el marcador rojo queda ARRIBA A LA IZQUIERDA (imagen derecha)')
    assert.match(result.output, new RegExp(`Orientacion EXIF ${orientation} aplicada`))
    assert.match(result.output, /ubicacion GPS/)
    assert.doesNotMatch(result.output, /CamaraPrivadaXYZ|48|latitud/i, 'el texto no filtra ningun valor del EXIF')
  }
})

test('privacidad tambien en PNG: un chunk de texto con "secreto" no viaja', async t => {
  const { workspace } = makeWorkspace(t)
  const png = pngWithTextChunk(halvesPng(200, 100), 'Comment', 'SECRETO-PNG-333')
  assert.ok(png.includes(Buffer.from('SECRETO-PNG-333')))
  writeFileSync(path.join(workspace, 'con-texto.png'), png)
  const result = await call(workspace, { path: 'con-texto.png' })
  assert.equal(result.ok, true, result.output)
  assert.ok(!bufferOf(result.resultImageDataUrl!).includes(Buffer.from('SECRETO-PNG-333')))
})

// ────────────────────────── 5) formatos no soportados, sin fallar feo ──────────────────────────

test('TIFF, HEIC, SVG, PDF y desconocidos: mensaje claro de "no soportado", sin excepcion', async t => {
  const { workspace } = makeWorkspace(t)
  const heic = Buffer.alloc(24); heic.writeUInt32BE(24, 0); heic.write('ftypheic', 4, 'latin1'); heic.write('mif1heic', 16, 'latin1')
  const files: Array<[string, Buffer, RegExp]> = [
    ['plano.tif', Buffer.concat([Buffer.from('II*\0', 'latin1'), Buffer.alloc(200)]), /no soporta el formato TIFF/],
    ['plano-be.png', Buffer.concat([Buffer.from('MM\0*', 'latin1'), Buffer.alloc(200)]), /no soporta el formato TIFF/],
    ['foto.heic', heic, /no soporta el formato HEIC\/HEIF/],
    ['logo.svg', Buffer.from('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>'), /no soporta el formato SVG/],
    ['doc.png', Buffer.from('%PDF-1.4\n%%EOF'), /read_document/],
    ['nada.png', Buffer.from('no soy una imagen'), /no es una imagen reconocida/]
  ]
  for (const [name, bytes, expected] of files) {
    writeFileSync(path.join(workspace, name), bytes)
    const r = await call(workspace, { path: name })
    assert.equal(r.ok, false, name)
    assert.match(r.output, expected, name)
    assert.match(r.output, /PNG, JPEG, WebP, GIF, BMP, ICO, AVIF/, `${name} lista los formatos aceptados`)
    assert.equal(r.resultImageDataUrl, undefined)
  }
})

test('otros formatos aceptados: WebP, AVIF (codificados por el motor), BMP, ICO y GIF (armados byte a byte)', async t => {
  const { workspace } = makeWorkspace(t)
  const base = createCanvas(64, 48)
  const g = base.getContext('2d'); g.fillStyle = '#00aa00'; g.fillRect(0, 0, 64, 48)
  const bmp = Buffer.alloc(54 + 2 * 8) // BMP 24 bits 2x2: filas de 6 bytes + 2 de relleno
  bmp.write('BM', 0, 'latin1'); bmp.writeUInt32LE(bmp.length, 2); bmp.writeUInt32LE(54, 10)
  bmp.writeUInt32LE(40, 14); bmp.writeInt32LE(2, 18); bmp.writeInt32LE(2, 22); bmp.writeUInt16LE(1, 26); bmp.writeUInt16LE(24, 28)
  const icoPng = createCanvas(16, 16).toBuffer('image/png')
  const ico = Buffer.concat([Buffer.from([0, 0, 1, 0, 1, 0, 16, 16, 0, 0, 1, 0, 32, 0]), (() => { const b = Buffer.alloc(8); b.writeUInt32LE(icoPng.length, 0); b.writeUInt32LE(22, 4); return b })(), icoPng])
  const gif = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64')
  const cases: Array<[string, Buffer, string, string]> = [
    ['a.webp', base.toBuffer('image/webp'), 'WebP', '64x48'],
    ['a.avif', base.toBuffer('image/avif'), 'AVIF', '64x48'],
    ['a.bmp', bmp, 'BMP', '2x2'],
    ['a.ico', ico, 'ICO', '16x16'],
    ['a.gif', gif, 'GIF', '1x1']
  ]
  for (const [name, bytes, format, dims] of cases) {
    writeFileSync(path.join(workspace, name), bytes)
    const r = await call(workspace, { path: name })
    assert.equal(r.ok, true, `${name}: ${r.output}`)
    assert.match(r.output, new RegExp(`Imagen "${name.replace('.', '\\.')}": ${format}, ${dims} px`), name)
    assert.ok(r.resultImageDataUrl, name)
  }
})

test('transparencia REAL -> PNG; sin transparencia -> JPEG; y si el PNG no cabe en el limite del proveedor, se aplana a JPEG y lo dice', async t => {
  const { workspace } = makeWorkspace(t)
  const canvas = createCanvas(300, 300)
  const g = canvas.getContext('2d')
  g.fillStyle = '#ff0000'; g.beginPath(); g.arc(150, 150, 100, 0, Math.PI * 2); g.fill() // fuera del circulo: alfa 0
  writeFileSync(path.join(workspace, 'alfa.png'), canvas.toBuffer('image/png'))
  const withAlpha = await call(workspace, { path: 'alfa.png' })
  assert.ok(withAlpha.resultImageDataUrl?.startsWith('data:image/png;base64,'), 'con transparencia real se conserva PNG')
  assert.equal((await pixel(withAlpha.resultImageDataUrl!, 5, 5))[3], 0, 'la transparencia se conserva')
  const opaque = createCanvas(300, 300); opaque.getContext('2d').fillStyle = '#123456'; opaque.getContext('2d').fillRect(0, 0, 300, 300)
  writeFileSync(path.join(workspace, 'opaca.png'), opaque.toBuffer('image/png'))
  assert.ok((await call(workspace, { path: 'opaca.png' })).resultImageDataUrl?.startsWith('data:image/jpeg;base64,'), 'sin transparencia -> JPEG')
  // limite chico del proveedor: el PNG con alfa (~mas de 1 KB) no cabe -> JPEG aplanado + aviso
  const png = bufferOf(withAlpha.resultImageDataUrl!)
  const tiny = await call(workspace, { path: 'alfa.png' }, { resultImageMaxBytes: Math.ceil(((png.length - 200) * 4) / 3) })
  assert.equal(tiny.ok, true, tiny.output)
  assert.ok(tiny.resultImageDataUrl?.startsWith('data:image/jpeg;base64,'))
  assert.match(tiny.output, /aplano sobre fondo blanco/)
  // ni con calidad reducida cabe -> error claro (nunca una imagen que el proveedor rechazaria)
  const noisy = createCanvas(1500, 1500); const ng = noisy.getContext('2d'); const id = ng.createImageData(1500, 1500)
  for (let i = 0; i < id.data.length; i++) id.data[i] = (i * 2654435761 >>> 24) & 255
  ng.putImageData(id, 0, 0)
  writeFileSync(path.join(workspace, 'ruido.png'), noisy.toBuffer('image/png'))
  const impossible = await call(workspace, { path: 'ruido.png' }, { resultImageMaxBytes: 4000 })
  assert.equal(impossible.ok, false)
  assert.match(impossible.output, /por debajo del limite/)
})

// ────────────────────────── guardas: "bomba", peso, archivo danado ──────────────────────────

test('imagen "bomba": se rechaza por el ENCABEZADO, sin decodificar (PNG y JPEG)', async t => {
  const { workspace } = makeWorkspace(t)
  writeFileSync(path.join(workspace, 'bomba.png'), bombPng(60000, 60000)) // 3600 Mpx declarados, ~70 bytes en disco
  writeFileSync(path.join(workspace, 'bomba.jpg'), bombJpeg(30000, 30000))
  writeFileSync(path.join(workspace, 'justo-arriba.png'), bombPng(10001, 10000)) // 100,01 Mpx
  writeFileSync(path.join(workspace, 'justo-limite.png'), bombPng(10000, 10000)) // exactamente 100 Mpx: pasa la guarda
  const started = Date.now()
  for (const name of ['bomba.png', 'bomba.jpg', 'justo-arriba.png']) {
    const r = await call(workspace, { path: name })
    assert.equal(r.ok, false, name)
    assert.match(r.output, /supera el limite de 100 Mpx/, name)
    assert.match(r.output, /No se decodifico/, name)
  }
  assert.ok(Date.now() - started < 3000, 'el rechazo por encabezado es inmediato (no decodifica)')
  const boundary = await call(workspace, { path: 'justo-limite.png' })
  assert.doesNotMatch(boundary.output, /Mpx/, 'exactamente 100 Mpx NO se rechaza por la guarda (falla despues, al decodificar datos que no existen)')
  assert.equal(boundary.ok, false)
})

test('archivo de mas de 50 MB: se rechaza por peso sin leerlo', async t => {
  const { workspace } = makeWorkspace(t)
  writeFileSync(path.join(workspace, 'enorme.png'), Buffer.alloc(51 * 1024 * 1024))
  const r = await call(workspace, { path: 'enorme.png' })
  assert.equal(r.ok, false)
  assert.match(r.output, /pesa 51\.0 MB en disco y supera el limite de 50 MB/)
})

test('archivo truncado/danado: el decodificador devuelve una imagen parcial SIN avisar -> el resultado advierte al modelo', async t => {
  const { workspace } = makeWorkspace(t)
  const png = halvesPng(800, 600)
  const jpeg = createCanvas(800, 600).toBuffer('image/jpeg', 90)
  writeFileSync(path.join(workspace, 'ok.png'), png)
  writeFileSync(path.join(workspace, 'cortada.png'), png.subarray(0, Math.floor(png.length * 0.5)))
  writeFileSync(path.join(workspace, 'cortada.jpg'), jpeg.subarray(0, Math.floor(jpeg.length * 0.6)))
  assert.doesNotMatch((await call(workspace, { path: 'ok.png' })).output, /ADVERTENCIA/)
  for (const name of ['cortada.png', 'cortada.jpg']) {
    const r = await call(workspace, { path: name })
    assert.equal(r.ok, true, `${name}: ${r.output}`)
    assert.match(r.output, /ADVERTENCIA: el archivo (PNG|JPEG) parece truncado o danado/, name)
  }
})

// ────────────────────────── 3) confinamiento ──────────────────────────

test('confinamiento: fuera del workspace, ruta absoluta y junction -> rechazado con el MISMO mensaje que read_file', async t => {
  const { workspace, outside } = makeWorkspace(t)
  writeFileSync(path.join(outside, 'secreto.png'), halvesPng(50, 50))
  mkdirSync(path.join(workspace, 'sub'))
  writeFileSync(path.join(workspace, 'sub', 'interna.png'), halvesPng(50, 50))
  const junctionOut = path.join(workspace, 'enlace')
  const junctionIn = path.join(workspace, 'enlace_interno')
  symlinkSync(outside, junctionOut, 'junction')
  symlinkSync(path.join(workspace, 'sub'), junctionIn, 'junction')
  t.after(() => { for (const link of [junctionOut, junctionIn]) { try { rmdirSync(link) } catch { /* ya no existe */ } } })

  for (const attempt of ['../afuera/secreto.png', path.join(outside, 'secreto.png'), 'enlace/secreto.png']) {
    const image = await call(workspace, { path: attempt })
    const file = await registry.execute('read_file', { path: attempt }, { workspace, sandbox: 'workspace-write', confirm: async () => false })
    assert.equal(image.ok, false, attempt)
    assert.equal(image.resultImageDataUrl, undefined, `no se filtra ninguna imagen de ${attempt}`)
    assert.match(image.output, /fuera del workspace/, attempt)
    assert.equal(image.output, file.output, `mismo mensaje que read_file para ${attempt}`)
  }
  // controles: lo legitimo sigue funcionando (ruta normal y junction que apunta ADENTRO)
  assert.equal((await call(workspace, { path: 'sub/interna.png' })).ok, true)
  assert.equal((await call(workspace, { path: 'enlace_interno/interna.png' })).ok, true)
  // inexistente / carpeta
  assert.equal((await call(workspace, { path: 'no-existe.png' })).output, 'Archivo no encontrado: no-existe.png')
  assert.equal((await call(workspace, { path: 'sub' })).output, 'Archivo no encontrado: sub')
})

// ────────────────────────── 6) chokepoint de F0: modelo sin vision ──────────────────────────

test('chokepoint F0: sin vision / Gemini < 3 -> sin imagen y metadata honesta; con vision el texto original va intacto', async t => {
  const { workspace } = makeWorkspace(t)
  writeFileSync(path.join(workspace, 'captura.png'), halvesPng(1200, 800))
  const result = await call(workspace, { path: 'captura.png' })
  assert.equal(result.ok, true)
  const seen = resultImageFor('anthropic-api', result, { model: 'claude-x', visionCapable: true })
  assert.ok(seen.image, 'con vision, la imagen viaja')
  assert.equal(seen.text, result.output, 'el texto original va intacto')
  for (const [kind, model, vision] of [['anthropic-api', 'claude-x', false], ['foundry', 'gpt-x', false], ['openai-chat', 'gpt-x', false], ['gemini-api', 'gemini-2.5-pro', true], ['gemini-api', '', true]] as Array<[ApiAgentKind, string, boolean]>) {
    const degraded = resultImageFor(kind, result, { model, visionCapable: vision })
    assert.equal(degraded.image, null, `${kind}/${model}: sin imagen`)
    assert.ok(degraded.text.startsWith(result.output), 'conserva el texto de la tool (formato/dimensiones/peso)')
    assert.match(degraded.text, /NO se adjunta la imagen/)
    assert.match(degraded.text, /image\/jpeg, 1200x800 px/)
    assert.match(degraded.text, /No inventes ni supongas su contenido visual/)
  }
})

// ────────────────────────── cadena completa por los 4 protocolos ──────────────────────────

const KIND_MODEL: Record<ApiAgentKind, string> = { 'anthropic-api': 'claude-fake', foundry: 'gpt-fake', 'gemini-api': 'gemini-3-flash-preview', 'openai-chat': 'gpt-fake-chat' }

async function runReadImageTurn(kind: ApiAgentKind, workspace: string, args: Record<string, unknown>, visionCapable: boolean) {
  const fake = await startFakeModel([[{ name: 'read_image', args }]])
  try {
    const runtime = new ApiAgentRuntime()
    runtime.configure({
      kind,
      provider: { id: 'p', name: 'p', type: 'openrouter', authMode: 'api-key', endpoint: fake.endpoint, apiKey: 'k', enabled: true, models: [] },
      model: KIND_MODEL[kind],
      workspace,
      sandbox: 'workspace-write',
      toolsEnabled: true,
      visionCapable,
      // mismo cableado que ipc-agent.ts: el ToolRegistry REAL y el limite de imagen que declara el runtime
      toolExecutor: (name, toolArgs) => registry.execute(name, toolArgs, { workspace, sandbox: 'workspace-write', confirm: async () => false, resultImageMaxBytes: runtime.toolResultImageMaxBytes() })
    })
    const result = await runtime.send('mira la imagen')
    assert.equal(result.text, 'FINAL')
    return fake.requests
  } finally {
    await fake.close()
  }
}

test('cadena completa: read_image esta en el catalogo de los 4 runtimes y la imagen real llega (o se degrada) en el formato de cada API', async t => {
  const { workspace } = makeWorkspace(t)
  writeFileSync(path.join(workspace, 'captura.png'), halvesPng(1200, 800))
  const toolNames = (kind: ApiAgentKind, body: Record<string, unknown>): string[] => {
    const tools = body.tools as Array<Record<string, unknown>>
    if (kind === 'gemini-api') return (tools[0].functionDeclarations as Array<{ name: string }>).map(d => d.name)
    if (kind === 'openai-chat') return tools.map(x => (x.function as { name: string }).name)
    return tools.map(x => String(x.name))
  }
  for (const kind of Object.keys(KIND_MODEL) as ApiAgentKind[]) {
    const withVision = await runReadImageTurn(kind, workspace, { path: 'captura.png' }, true)
    assert.ok(toolNames(kind, withVision[0].body).includes('read_image'), `${kind} ofrece read_image`)
    assert.match(JSON.stringify(withVision[0].body), /"region"/, `${kind} declara el parametro region`)
    const second = JSON.stringify(withVision[1].body)
    assert.ok(second.includes('/9j/'), `${kind}: la imagen (JPEG base64) viaja en la request del resultado`)
    assert.ok(second.includes('Version preparada para vision: 1200x800 px, JPEG'), `${kind}: la metadata viaja como texto`)
    assert.ok(!second.includes('NO se adjunta la imagen'))

    const noVision = await runReadImageTurn(kind, workspace, { path: 'captura.png' }, false)
    const degraded = JSON.stringify(noVision[1].body)
    assert.ok(!degraded.includes('/9j/'), `${kind} sin vision: CERO imagen en la request`)
    assert.ok(degraded.includes('NO se adjunta la imagen'), `${kind} sin vision: aviso honesto`)
    assert.ok(degraded.includes('Version preparada para vision: 1200x800 px, JPEG'), `${kind} sin vision: conserva los metadatos`)
  }
})

test('esquema de la tool: path obligatorio y region como objeto con x/y/width/height numericos', () => {
  const def = TOOL_DEFINITIONS.find(d => d.name === 'read_image')
  assert.ok(def, 'read_image esta en TOOL_DEFINITIONS')
  assert.deepEqual(def.parameters.required, ['path'])
  const region = def.parameters.properties.region
  assert.equal(region.type, 'object')
  assert.deepEqual(region.required, ['x', 'y', 'width', 'height'])
  for (const key of ['x', 'y', 'width', 'height']) assert.equal(region.properties?.[key].type, 'number')
})
