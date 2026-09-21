// Tool read_image (F1 de docs/_arch/verify_native_multimodal_tools_design.md, §2.2 y §3): lee UNA imagen ya
// confinada al workspace (la confinacion la hace quien llama, ver tool-registry.ts) y la prepara para que un
// modelo con vision la VEA. Motor: @napi-rs/canvas (ya empaquetado, external igual que en document-reader.ts).
//
// Guardas ENCADENADAS, cada una ANTES de la siguiente (la mas barata primero, la decodificacion al final):
//   1. peso del archivo en disco <= 50 MB (statSync, sin leer nada)
//   2. argumentos de `region` validos (un error de argumentos no debe costar CPU)
//   3. formato reconocido por sus BYTES MAGICOS (no por la extension) y soportado
//   4. dimensiones leidas del ENCABEZADO (sin decodificar) <= 100 Mpx: un PNG "bomba" de pocos KB puede declarar
//      cientos de megapixeles y agotar la RAM al decodificarse (medido en la investigacion: ~620 MB de RSS con
//      24000x24000 en gris; en color seria varias veces mas) -- se rechaza aca, sin decodificar
//   5. decodificacion (falla con mensaje claro si el archivo esta danado)
//   6. lado largo <= 1568 px (tier estandar de Anthropic; seguro para los 4 proveedores): se reduce ANTES de mandar
//
// Privacidad: el canvas RECODIFICA la imagen (JPEG q85, o PNG si tiene transparencia REAL), asi que el EXIF -incluida
// la ubicacion GPS-, los comentarios y cualquier otro metadato del archivo NO viajan al proveedor (verificado con un
// JPEG real con EXIF/GPS en docs/_arch/CONTRACT.md). La orientacion EXIF SI se aplica al decodificar (una foto vertical
// de celular llega derecha). Las dimensiones/formato/peso que Anthropic no recibe aparte van como TEXTO del resultado.
import { readFileSync, statSync } from 'node:fs'

export const READ_IMAGE_MAX_FILE_BYTES = 50 * 1024 * 1024
export const READ_IMAGE_MAX_PIXELS = 100_000_000
export const READ_IMAGE_MAX_LONG_SIDE = 1568
/** Escala de `region`: coordenadas normalizadas 0-1000 sobre la imagen ENTERA ya orientada (independientes de la reduccion). */
export const READ_IMAGE_REGION_SCALE = 1000
/** Tope de la imagen recodificada (base64) cuando quien llama no declara uno (p. ej. CLIs por MCP): el mas bajo documentado. */
const DEFAULT_MAX_ENCODED_BYTES = 5 * 1024 * 1024
const JPEG_QUALITIES = [85, 70, 50] as const
const SUPPORTED_FORMATS_LABEL = 'PNG, JPEG, WebP, GIF, BMP, ICO, AVIF'

export type ImageFormat = 'PNG' | 'JPEG' | 'WebP' | 'GIF' | 'BMP' | 'ICO' | 'AVIF'
export interface ImageRegion { x: number; y: number; width: number; height: number }
export interface ReadImageOptions {
  /** `region` tal cual lo mando el modelo (sin validar): objeto {x,y,width,height} en escala 0-1000, o su JSON como string. */
  region?: unknown
  /** Maximo de bytes (base64) que el runtime activo acepta por imagen (ExecuteContext.resultImageMaxBytes); undefined = 5 MB. */
  maxEncodedBytes?: number
}
export type ReadImageOutcome = { ok: true; text: string; imageDataUrl: string } | { ok: false; error: string }

type Sniffed =
  | { kind: 'image'; format: ImageFormat }
  | { kind: 'unsupported'; label: string; hint: string }
  | { kind: 'unknown' }

interface ImageHeader {
  width: number
  height: number
  /** false = el archivo parece truncado (el decodificador igual devuelve una imagen parcial SIN avisar: se lo avisamos al modelo). */
  complete: boolean
  animated: boolean
  exifOrientation: number | null
  hasGps: boolean
}

const fail = (error: string): ReadImageOutcome => ({ ok: false, error })

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/** Identifica el formato por los BYTES MAGICOS (una extension mentirosa no engana a la guarda de dimensiones). */
function sniffFormat(buf: Buffer): Sniffed {
  const ascii = (start: number, end: number): string => buf.toString('latin1', start, Math.min(end, buf.length))
  if (buf.length >= 8 && buf.readUInt32BE(0) === 0x89504e47 && buf.readUInt32BE(4) === 0x0d0a1a0a) return { kind: 'image', format: 'PNG' }
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { kind: 'image', format: 'JPEG' }
  const head6 = ascii(0, 6)
  if (head6 === 'GIF87a' || head6 === 'GIF89a') return { kind: 'image', format: 'GIF' }
  if (buf.length >= 12 && ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return { kind: 'image', format: 'WebP' }
  if (buf.length >= 6 && buf[0] === 0 && buf[1] === 0 && buf[2] === 1 && buf[3] === 0) return { kind: 'image', format: 'ICO' }
  if (buf.length >= 26 && ascii(0, 2) === 'BM' && [12, 40, 52, 56, 64, 108, 124].includes(buf.readUInt32LE(14))) return { kind: 'image', format: 'BMP' }
  if (buf.length >= 12 && ascii(4, 8) === 'ftyp') {
    const brands = ascii(8, 64)
    if (/avif|avis/.test(brands)) return { kind: 'image', format: 'AVIF' }
    if (/heic|heix|hevc|hevx|heim|heis|mif1|msf1/.test(brands)) {
      return { kind: 'unsupported', label: 'HEIC/HEIF', hint: 'Convertilo a PNG o JPEG (por ejemplo con el visor de fotos de Windows) y volve a llamar.' }
    }
  }
  const head4 = ascii(0, 4)
  if (head4 === 'II*\0' || head4 === 'MM\0*' || head4 === 'II+\0' || head4 === 'MM\0+') {
    return { kind: 'unsupported', label: 'TIFF', hint: 'Convertilo a PNG o JPEG y volve a llamar.' }
  }
  if (head4 === '%PDF') return { kind: 'unsupported', label: 'PDF', hint: 'Es un documento, no una imagen: usa read_document.' }
  const textHead = buf.toString('utf8', 0, Math.min(buf.length, 512)).replace(/^\uFEFF/, '').trimStart()
  if (textHead.startsWith('<') && /<svg[\s>]/i.test(textHead)) {
    return { kind: 'unsupported', label: 'SVG', hint: 'Es texto vectorial, no una imagen rasterizada: leelo con read_file si necesitas su contenido.' }
  }
  return { kind: 'unknown' }
}

// --- Encabezados (sin decodificar) ------------------------------------------------------------------------------

/** Lee orientacion y presencia de GPS del bloque EXIF (TIFF embebido) de un JPEG. Acotado a `end`; ante cualquier anomalia devuelve lo que tenga. */
function readExif(buf: Buffer, tiffStart: number, end: number): { orientation: number | null; hasGps: boolean } {
  const out: { orientation: number | null; hasGps: boolean } = { orientation: null, hasGps: false }
  if (tiffStart + 8 > end) return out
  const order = buf.toString('latin1', tiffStart, tiffStart + 2)
  const little = order === 'II'
  if (!little && order !== 'MM') return out
  const u16 = (offset: number): number => (little ? buf.readUInt16LE(offset) : buf.readUInt16BE(offset))
  const u32 = (offset: number): number => (little ? buf.readUInt32LE(offset) : buf.readUInt32BE(offset))
  if (u16(tiffStart + 2) !== 42) return out
  const ifd0 = tiffStart + u32(tiffStart + 4)
  if (ifd0 + 2 > end) return out
  const count = u16(ifd0)
  for (let i = 0; i < count; i++) {
    const entry = ifd0 + 2 + i * 12
    if (entry + 12 > end) break
    const tag = u16(entry)
    if (tag === 0x0112) {
      const value = u16(entry + 8) // SHORT x1: el valor ocupa los 2 primeros bytes del campo de 4
      out.orientation = value >= 1 && value <= 8 ? value : null
    } else if (tag === 0x8825) {
      const gpsIfd = tiffStart + u32(entry + 8)
      out.hasGps = gpsIfd + 2 <= end && u16(gpsIfd) > 0
    }
  }
  return out
}

/** Recorre los SEGMENTOS del JPEG (no busca bytes sueltos: un EXIF con miniatura trae su propio SOF adentro del APP1). */
function inspectJpeg(buf: Buffer): ImageHeader | null {
  let width = 0
  let height = 0
  let exif: { orientation: number | null; hasGps: boolean } = { orientation: null, hasGps: false }
  let sosAt = -1
  let offset = 2
  while (offset + 4 <= buf.length) {
    if (buf[offset] !== 0xff) { offset++; continue }
    const marker = buf[offset + 1]
    if (marker === 0xff) { offset++; continue } // relleno
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { offset += 2; continue }
    if (marker === 0xd9) break // EOI antes de SOS: no hay imagen
    const segmentLength = buf.readUInt16BE(offset + 2)
    if (segmentLength < 2) return null
    const segmentEnd = Math.min(offset + 2 + segmentLength, buf.length)
    if (marker === 0xe1 && buf.toString('latin1', offset + 4, offset + 10) === 'Exif\0\0') exif = readExif(buf, offset + 10, segmentEnd)
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc && offset + 9 <= buf.length) {
      height = buf.readUInt16BE(offset + 5)
      width = buf.readUInt16BE(offset + 7)
    }
    if (marker === 0xda) { sosAt = offset; break }
    offset += 2 + segmentLength
  }
  if (!width || !height) return null
  const complete = sosAt >= 0 && buf.indexOf(Buffer.from([0xff, 0xd9]), sosAt) !== -1
  return { width, height, complete, animated: false, exifOrientation: exif.orientation, hasGps: exif.hasGps }
}

/** Recorre los chunks del PNG hasta IEND: sin IEND el archivo esta truncado. Detecta APNG (chunk acTL). */
function inspectPng(buf: Buffer): ImageHeader | null {
  if (buf.length < 33 || buf.toString('latin1', 12, 16) !== 'IHDR') return null
  let offset = 8
  let animated = false
  let complete = false
  while (offset + 12 <= buf.length) {
    const length = buf.readUInt32BE(offset)
    const type = buf.toString('latin1', offset + 4, offset + 8)
    if (type === 'acTL') animated = true
    if (type === 'IEND') { complete = true; break }
    offset += 12 + length
  }
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), complete, animated, exifOrientation: null, hasGps: false }
}

interface IsoBox { type: string; dataStart: number; end: number }
/** Cajas ISO-BMFF (AVIF) hijas directas de [start, end). Acotado: 1024 cajas. */
function isoBoxes(buf: Buffer, start: number, end: number): IsoBox[] {
  const boxes: IsoBox[] = []
  let offset = start
  while (offset + 8 <= end && boxes.length < 1024) {
    let size = buf.readUInt32BE(offset)
    const type = buf.toString('latin1', offset + 4, offset + 8)
    let headerSize = 8
    if (size === 1) {
      if (offset + 16 > end) break
      size = Number(buf.readBigUInt64BE(offset + 8))
      headerSize = 16
    } else if (size === 0) {
      size = end - offset
    }
    if (size < headerSize || offset + size > end) break
    boxes.push({ type, dataStart: offset + headerSize, end: offset + size })
    offset += size
  }
  return boxes
}

/** AVIF: meta > iprp > ipco > ispe (ancho/alto). Si hay varias (miniaturas, tiles) se toma la de mas pixeles. */
function avifHeader(buf: Buffer): ImageHeader | null {
  const meta = isoBoxes(buf, 0, buf.length).find(box => box.type === 'meta')
  if (!meta) return null
  const iprp = isoBoxes(buf, meta.dataStart + 4, meta.end).find(box => box.type === 'iprp') // +4: version/flags de la FullBox
  const ipco = iprp ? isoBoxes(buf, iprp.dataStart, iprp.end).find(box => box.type === 'ipco') : undefined
  if (!ipco) return null
  let best: { width: number; height: number } | null = null
  for (const box of isoBoxes(buf, ipco.dataStart, ipco.end)) {
    if (box.type !== 'ispe' || box.end - box.dataStart < 12) continue
    const width = buf.readUInt32BE(box.dataStart + 4)
    const height = buf.readUInt32BE(box.dataStart + 8)
    if (!best || width * height > best.width * best.height) best = { width, height }
  }
  return best ? { ...best, complete: true, animated: buf.toString('latin1', 8, Math.min(buf.length, 64)).includes('avis'), exifOrientation: null, hasGps: false } : null
}

function readHeader(buf: Buffer, format: ImageFormat): ImageHeader | null {
  const simple = (width: number, height: number, extra: Partial<ImageHeader> = {}): ImageHeader =>
    ({ width, height, complete: true, animated: false, exifOrientation: null, hasGps: false, ...extra })
  switch (format) {
    case 'PNG': return inspectPng(buf)
    case 'JPEG': return inspectJpeg(buf)
    case 'GIF': {
      if (buf.length < 10) return null
      return simple(buf.readUInt16LE(6), buf.readUInt16LE(8), { animated: buf.toString('latin1', 0, Math.min(buf.length, 2048)).includes('NETSCAPE2.0') })
    }
    case 'WebP': {
      const complete = buf.length >= 8 && buf.readUInt32LE(4) + 8 <= buf.length
      const chunk = buf.toString('latin1', 12, 16)
      if (chunk === 'VP8 ' && buf.length >= 30) return simple(buf.readUInt16LE(26) & 0x3fff, buf.readUInt16LE(28) & 0x3fff, { complete })
      if (chunk === 'VP8L' && buf.length >= 25) {
        const bits = buf.readUInt32LE(21)
        return simple((bits & 0x3fff) + 1, ((bits >> 14) & 0x3fff) + 1, { complete })
      }
      if (chunk === 'VP8X' && buf.length >= 30) return simple(buf.readUIntLE(24, 3) + 1, buf.readUIntLE(27, 3) + 1, { complete, animated: (buf[20] & 0x02) !== 0 })
      return null
    }
    case 'BMP': {
      const dib = buf.readUInt32LE(14)
      if (dib === 12) return simple(buf.readUInt16LE(18), buf.readUInt16LE(20))
      return simple(Math.abs(buf.readInt32LE(18)), Math.abs(buf.readInt32LE(22)))
    }
    case 'ICO': {
      const count = buf.readUInt16LE(4)
      let best: { width: number; height: number } | null = null
      for (let i = 0; i < Math.min(count, 256); i++) {
        const at = 6 + i * 16
        if (at + 16 > buf.length) break
        const width = buf[at] || 256 // 0 = 256
        const height = buf[at + 1] || 256
        if (!best || width * height > best.width * best.height) best = { width, height }
      }
      return best ? simple(best.width, best.height) : null
    }
    case 'AVIF': return avifHeader(buf)
  }
}

// --- region -----------------------------------------------------------------------------------------------------

/** Valida `region` (objeto o su JSON como string). null = sin recorte. */
export function parseImageRegion(raw: unknown): { ok: true; region: ImageRegion | null } | { ok: false; error: string } {
  if (raw === undefined || raw === null || raw === '') return { ok: true, region: null }
  let value: unknown = raw
  if (typeof raw === 'string') {
    try { value = JSON.parse(raw) } catch { return { ok: false, error: '"region" debe ser un objeto {x, y, width, height} (o su JSON), no texto libre.' } }
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ok: false, error: '"region" debe ser un objeto {x, y, width, height} en escala 0-1000.' }
  }
  const record = value as Record<string, unknown>
  // Solo numeros (o su texto numerico): Number(null)/Number(true)/Number([]) dan 0/1 y NO son coordenadas.
  const toNumber = (v: unknown): number => (typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN)
  const [x, y, width, height] = ['x', 'y', 'width', 'height'].map(key => toNumber(record[key]))
  const shown = JSON.stringify({ x: record.x, y: record.y, width: record.width, height: record.height })
  if (![x, y, width, height].every(Number.isFinite)) return { ok: false, error: `"region" necesita x, y, width y height numericos. Recibido: ${shown}` }
  const scale = READ_IMAGE_REGION_SCALE
  const eps = 1e-6
  if (x < 0 || y < 0 || width <= 0 || height <= 0 || x + width > scale + eps || y + height > scale + eps) {
    return {
      ok: false,
      error: `"region" fuera de rango: x, y, width y height van en escala 0-${scale} sobre la imagen ENTERA ` +
        `(x>=0, y>=0, width>0, height>0, x+width<=${scale}, y+height<=${scale}). Recibido: ${shown}`
    }
  }
  return { ok: true, region: { x, y, width, height } }
}

// --- salida -----------------------------------------------------------------------------------------------------

type CanvasModule = typeof import('@napi-rs/canvas')
type CanvasLike = import('@napi-rs/canvas').Canvas

function hasRealTransparency(canvas: CanvasLike): boolean {
  const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data
  for (let i = 3; i < data.length; i += 4) if (data[i] < 255) return true
  return false
}

/** PNG si hay transparencia real (y cabe); si no, JPEG con calidad decreciente. null = ni asi cabe en `capRaw` bytes. */
function encodeWithinLimit(
  canvas: CanvasLike,
  transparent: boolean,
  capRaw: number,
  createCanvas: CanvasModule['createCanvas']
): { buffer: Buffer; mime: 'image/png' | 'image/jpeg'; flattened: boolean } | null {
  if (transparent) {
    const png = canvas.toBuffer('image/png')
    if (png.length <= capRaw) return { buffer: png, mime: 'image/png', flattened: false }
  }
  let source = canvas
  if (transparent) {
    // No cabe como PNG: se aplana sobre blanco y se manda como JPEG (mejor una imagen que se ve que un rechazo).
    source = createCanvas(canvas.width, canvas.height)
    const context = source.getContext('2d')
    context.fillStyle = '#ffffff'
    context.fillRect(0, 0, canvas.width, canvas.height)
    context.drawImage(canvas, 0, 0)
  }
  for (const quality of JPEG_QUALITIES) {
    const jpeg = source.toBuffer('image/jpeg', quality)
    if (jpeg.length <= capRaw) return { buffer: jpeg, mime: 'image/jpeg', flattened: transparent }
  }
  return null
}

export async function readImageForModel(absPath: string, displayPath: string, options: ReadImageOptions = {}): Promise<ReadImageOutcome> {
  // 1. peso en disco
  const size = statSync(absPath).size
  if (size > READ_IMAGE_MAX_FILE_BYTES) {
    return fail(`La imagen "${displayPath}" pesa ${formatBytes(size)} en disco y supera el limite de ${READ_IMAGE_MAX_FILE_BYTES / (1024 * 1024)} MB de read_image.`)
  }
  // 2. argumentos
  const parsedRegion = parseImageRegion(options.region)
  if (!parsedRegion.ok) return fail(parsedRegion.error)
  const region = parsedRegion.region

  const buf = readFileSync(absPath)
  // 3. formato por bytes magicos
  const sniffed = sniffFormat(buf)
  if (sniffed.kind === 'unsupported') {
    return fail(`read_image no soporta el formato ${sniffed.label} ("${displayPath}"). Formatos aceptados: ${SUPPORTED_FORMATS_LABEL}. ${sniffed.hint}`)
  }
  if (sniffed.kind === 'unknown') {
    return fail(`"${displayPath}" no es una imagen reconocida: no coincide con ninguno de los formatos aceptados (${SUPPORTED_FORMATS_LABEL}).`)
  }
  const format = sniffed.format

  // 4. dimensiones del ENCABEZADO, sin decodificar
  let header: ImageHeader | null = null
  try { header = readHeader(buf, format) } catch { header = null }
  if (!header || !(header.width > 0) || !(header.height > 0)) {
    return fail(`No se pudieron leer las dimensiones del encabezado de "${displayPath}" (${format}): por seguridad no se decodifica una imagen cuyo tamano no se puede verificar antes.`)
  }
  const declaredPixels = header.width * header.height
  if (declaredPixels > READ_IMAGE_MAX_PIXELS) {
    return fail(
      `La imagen "${displayPath}" declara ${header.width}x${header.height} px (${Math.round(declaredPixels / 1e6)} Mpx) y supera el limite de ` +
      `${READ_IMAGE_MAX_PIXELS / 1e6} Mpx de read_image (proteccion contra imagenes "bomba" que agotan la memoria al decodificarse). No se decodifico.`
    )
  }

  // 5. decodificacion
  const { createCanvas, loadImage } = require('@napi-rs/canvas') as CanvasModule
  let image: Awaited<ReturnType<CanvasModule['loadImage']>>
  try {
    image = await loadImage(buf)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    return fail(`No se pudo decodificar "${displayPath}" como ${format} (${detail}): el archivo esta danado o usa una variante que el decodificador no soporta.`)
  }
  const fullWidth = image.width
  const fullHeight = image.height

  // recorte (sobre la imagen ENTERA ya orientada), a resolucion NATIVA
  let sx = 0
  let sy = 0
  let sw = fullWidth
  let sh = fullHeight
  if (region) {
    sx = Math.min(fullWidth - 1, Math.round((region.x / READ_IMAGE_REGION_SCALE) * fullWidth))
    sy = Math.min(fullHeight - 1, Math.round((region.y / READ_IMAGE_REGION_SCALE) * fullHeight))
    sw = Math.min(fullWidth - sx, Math.max(1, Math.round((region.width / READ_IMAGE_REGION_SCALE) * fullWidth)))
    sh = Math.min(fullHeight - sy, Math.max(1, Math.round((region.height / READ_IMAGE_REGION_SCALE) * fullHeight)))
  }

  // 6. lado largo <= 1568 (nunca se agranda)
  const scale = Math.min(1, READ_IMAGE_MAX_LONG_SIDE / Math.max(sw, sh))
  const outWidth = Math.max(1, Math.round(sw * scale))
  const outHeight = Math.max(1, Math.round(sh * scale))
  const canvas = createCanvas(outWidth, outHeight)
  const context = canvas.getContext('2d')
  context.imageSmoothingEnabled = true
  context.imageSmoothingQuality = 'high'
  context.drawImage(image, sx, sy, sw, sh, 0, 0, outWidth, outHeight)

  const capRaw = Math.floor((Math.min(options.maxEncodedBytes ?? DEFAULT_MAX_ENCODED_BYTES, DEFAULT_MAX_ENCODED_BYTES) * 3) / 4)
  const encoded = encodeWithinLimit(canvas, hasRealTransparency(canvas), capRaw, createCanvas)
  if (!encoded) {
    return fail(`No se pudo recodificar "${displayPath}" por debajo del limite de ${formatBytes(capRaw)} de imagen de este proveedor, ni con calidad reducida.`)
  }

  const outputLabel = encoded.mime === 'image/png' ? 'PNG' : 'JPEG'
  const lines: string[] = []
  lines.push(
    `Imagen "${displayPath}": ${format}, ${fullWidth}x${fullHeight} px (${formatBytes(size)} en disco).` +
    (header.exifOrientation && header.exifOrientation !== 1 ? ` Orientacion EXIF ${header.exifOrientation} aplicada (el archivo la guarda como ${header.width}x${header.height}).` : '') +
    (header.animated ? ' Es animada: solo se lee el primer fotograma.' : '')
  )
  if (region) {
    lines.push(
      `Recorte pedido: x=${region.x} y=${region.y} width=${region.width} height=${region.height} (escala 0-${READ_IMAGE_REGION_SCALE}) = ` +
      `${sw}x${sh} px desde (${sx}, ${sy}) de la imagen original.`
    )
  }
  const resized = sw !== outWidth || sh !== outHeight
  lines.push(
    `Version preparada para vision: ${outWidth}x${outHeight} px, ${outputLabel}, ~${formatBytes(encoded.buffer.length)}` +
    (resized ? ` (reducida desde ${sw}x${sh} px: el lado largo maximo es ${READ_IMAGE_MAX_LONG_SIDE} px)` : '') +
    (encoded.flattened ? ' (la transparencia se aplano sobre fondo blanco para que quepa en el limite de tamano)' : '') + '.'
  )
  if (resized && !region) {
    lines.push(`Si necesitas mas detalle de una zona (texto chico, un plano), vuelve a llamar con "region" (x, y, width, height en escala 0-${READ_IMAGE_REGION_SCALE} sobre la imagen entera): recorta a resolucion original.`)
  }
  lines.push(
    header.hasGps
      ? 'Los metadatos del archivo se eliminaron (incluida la ubicacion GPS que traia): la imagen que se envia no los contiene.'
      : 'Los metadatos del archivo (EXIF, comentarios) se eliminaron: la imagen que se envia no los contiene.'
  )
  if (!header.complete) {
    lines.push(`ADVERTENCIA: el archivo ${format} parece truncado o danado (le falta el final): la imagen puede estar incompleta.`)
  }

  return { ok: true, text: lines.join('\n'), imageDataUrl: `data:${encoded.mime};base64,${encoded.buffer.toString('base64')}` }
}
