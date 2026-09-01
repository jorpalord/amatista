// Tool read_document (docs/_arch/verify_large_documents.md +
// docs/_arch/verify_read_document_tool.md). Lee PDF/DOCX/XLSX/HTML de a una
// "unidad" por vez (pagina real para PDF, chunk de tamano fijo para
// DOCX/XLSX/HTML via officeParser) -- NUNCA vuelca el documento completo de
// una, exactamente por lo investigado en Tarea 2: un documento de 200-400
// paginas no entra en una sola llamada sin importar el modelo.
//
// Decision de seguridad (verify_read_document_tool.md, Tarea 3): officeParser
// @7.8.0 fija internamente pdfjs-dist@6.1.200, que cae en el rango con CVE
// alta activa (GHSA-hq66-cqwq-w95j, ejecucion arbitraria de JS al abrir un
// PDF malicioso). package.json.overrides fuerza pdfjs-dist a ^6.3.289 (la
// version segura) en TODO el arbol, incluida la copia interna de
// officeParser -- confirmado real que esto la elimina del todo (0 hallazgos
// de pdfjs-dist en `npm audit` tras el override, antes 1 alto), no solo la
// esquiva. Pese a eso, PDF sigue sin pasar por officeParser aca: pdfjs-dist
// standalone es la unica de las dos formas que expone pagina-por-pagina
// (getTextContent()/getPage()) y render real a imagen (page.render()) --
// officeParser no tiene ese nivel de control, solo texto/chunks del
// documento entero. officeParser se usa para DOCX/XLSX/HTML, formatos donde
// se confirmo real que no arrastra ningun paquete vulnerable propio (Tarea 1
// del mismo doc).
//
// pdfjs-dist/officeparser/@napi-rs/canvas estan marcados external en
// electron.vite.config.ts (mismo motivo que typescript-language-server/
// pyright: bundlers no manejan bien archivos de datos (cmaps/standard_fonts)
// ni binarios nativos (.node) -- se cargan como node_modules reales en
// runtime, nunca inlineados).
import { readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

export type DocumentFormat = 'pdf' | 'docx' | 'xlsx' | 'html'

export interface DocumentUnit {
  format: DocumentFormat
  totalUnits: number
  unitIndex: number
  /** Texto real de esta pagina/chunk. Ausente SOLO cuando `scanned` es true
   *  (pagina de PDF sin texto extraible -- ver imageDataUrl en su lugar). */
  text?: string
  /** true SOLO para PDF: esta pagina no tuvo NINGUN texto extraible via
   *  getTextContent() (items.length === 0) -- se interpreta como pagina
   *  escaneada/imagen sin capa de texto. */
  scanned?: boolean
  /** PNG real de la pagina, en el MISMO formato data URL que
   *  attachments.ts ya usa (`data:image/png;base64,...`) -- poblado solo
   *  cuando scanned es true. */
  imageDataUrl?: string
  /** Metadata real de officeParser cuando aplica (docx/xlsx/html). */
  pageNumber?: number
  sheetName?: string
}

export type DocumentReadResult = { ok: true; unit: DocumentUnit } | { ok: false; error: string }

const EXTENSION_TO_FORMAT: Record<string, DocumentFormat> = {
  '.pdf': 'pdf',
  '.docx': 'docx',
  '.xlsx': 'xlsx',
  '.html': 'html',
  '.htm': 'html'
}

export function detectDocumentFormat(absPath: string): DocumentFormat | null {
  return EXTENSION_TO_FORMAT[path.extname(absPath).toLowerCase()] ?? null
}

// Tamano de chunk CHICO a proposito (verify_read_document_tool.md Tarea 2):
// con un chunkSize grande (probado con 200 contra un doc de prueba de 130
// caracteres) un chunk puede terminar cubriendo mas de una pagina/hoja, y su
// metadata.pageNumber queda pegado a la pagina donde EMPIEZA, no a todas las
// que en realidad cubre. Con chunkSize chico esa atribucion fue exacta en la
// prueba real (30 caracteres, 6 chunks, cada uno con el pageNumber
// correspondiente real). 1500/150 es el tamano de produccion elegido -- lo
// bastante chico para que en un documento real de paginas normales sea muy
// improbable que un chunk cruce un salto de pagina, sin generar una cantidad
// absurda de chunks para un documento de cientos de paginas.
const OFFICE_CHUNK_SIZE = 1500
const OFFICE_CHUNK_OVERLAP = 150

// PDF: escala 2x para el render de paginas escaneadas -- balance real entre
// legibilidad para el modelo (vision) y peso del PNG resultante (base64
// contra IMAGE_SIZE_LIMIT_BYTES en api-agent-runtime.ts, chequeado antes de
// adjuntar -- ver readPdfUnit).
const PDF_RENDER_SCALE = 2

/**
 * Cache en memoria de los chunks YA generados para un documento office
 * (docx/xlsx/html), clave = ruta absoluta + mtime. Motivo real: officeParser
 * no tiene una API de "dame solo el chunk N" -- convert(file, 'chunks', ...)
 * reprocesa el documento ENTERO cada vez (confirmado en la investigacion).
 * Sin esto, pedir un documento de 400 paginas pagina por pagina
 * reparsearia el archivo completo en cada llamada -- exactamente el
 * problema de escala que esta feature busca evitar. Esto es una cache de
 * PERFORMANCE, no el mecanismo de resumen jerarquico (fuera de alcance
 * explicito de esta fase) -- no resume ni descarta nada, solo evita
 * recalcular el mismo resultado determinístico repetidas veces dentro de la
 * vida del proceso.
 */
interface CachedChunks { mtimeMs: number; chunks: OfficeChunk[] }
const officeChunkCache = new Map<string, CachedChunks>()

interface OfficeChunk {
  text: string
  metadata?: { pageNumber?: number; sheetName?: string; slideNumber?: number }
}

async function getOfficeChunks(absPath: string): Promise<OfficeChunk[]> {
  const mtimeMs = statSync(absPath).mtimeMs
  const cached = officeChunkCache.get(absPath)
  if (cached && cached.mtimeMs === mtimeMs) return cached.chunks

  // officeParser esta marcado external (electron.vite.config.ts) -- require
  // normal contra el node_modules real, nunca bundleado.
  const officeParser = require('officeparser') as {
    convert: (file: string, dest: string, opts: unknown) => Promise<{ value: OfficeChunk[]; messages: unknown[] }>
  }
  const result = await officeParser.convert(absPath, 'chunks', {
    generatorConfig: {
      chunksConfig: { strategy: 'fixed-size', chunkSize: OFFICE_CHUNK_SIZE, chunkOverlap: OFFICE_CHUNK_OVERLAP }
    }
  })
  officeChunkCache.set(absPath, { mtimeMs, chunks: result.value })
  return result.value
}

async function readOfficeUnit(absPath: string, format: DocumentFormat, unitIndex: number | undefined): Promise<DocumentReadResult> {
  const chunks = await getOfficeChunks(absPath)
  if (chunks.length === 0) {
    return { ok: true, unit: { format, totalUnits: 0, unitIndex: 0, text: '(documento sin contenido de texto extraible)' } }
  }
  const target = Math.min(Math.max(unitIndex ?? 1, 1), chunks.length)
  const chunk = chunks[target - 1]
  return {
    ok: true,
    unit: {
      format,
      totalUnits: chunks.length,
      unitIndex: target,
      text: chunk.text,
      pageNumber: chunk.metadata?.pageNumber,
      sheetName: chunk.metadata?.sheetName
    }
  }
}

// pdfjs-dist es un modulo ESM real (legacy/build/pdf.mjs) -- import()
// dinamico funciona sin importar si el codigo que lo llama termino
// compilado a CJS o ESM (confirmado real en la investigacion, gotcha ya
// documentado en verify_large_documents.md). Cacheado en el modulo (no por
// llamada) porque el import() de un modulo ya cargado es practicamente
// gratis, y evita repetir la resolucion cada vez.
let pdfjsLibPromise: Promise<typeof import('pdfjs-dist/legacy/build/pdf.mjs')> | null = null
function loadPdfjs() {
  if (!pdfjsLibPromise) pdfjsLibPromise = import('pdfjs-dist/legacy/build/pdf.mjs')
  return pdfjsLibPromise
}

async function readPdfUnit(absPath: string, unitIndex: number | undefined): Promise<DocumentReadResult> {
  const pdfjsLib = await loadPdfjs()
  // @napi-rs/canvas tambien esta external -- require normal.
  const { createCanvas, DOMMatrix } = require('@napi-rs/canvas') as typeof import('@napi-rs/canvas')
  // pdfjs-dist en Node espera algunos globals de browser presentes (Tarea 4
  // de verify_read_document_tool.md, confirmado real en la prueba).
  if (!(globalThis as Record<string, unknown>).DOMMatrix) {
    ;(globalThis as Record<string, unknown>).DOMMatrix = DOMMatrix as unknown
  }

  const pdfjsRoot = path.dirname(require.resolve('pdfjs-dist/package.json'))
  const data = new Uint8Array(readFileSync(absPath))
  // Bug real encontrado en la verificacion (Windows): pdfjs-dist interpreta
  // standardFontDataUrl/cMapUrl como una URL real, no una ruta de SO -- una
  // ruta Windows con backslashes ("D:\...\cmaps\") revienta con "Invalid
  // factory url" en vez de resolverse. pathToFileURL() da la unica forma
  // correcta y portable (Windows y POSIX) de convertir una ruta real de
  // disco a la URL que esta API espera.
  const toFactoryUrl = (dir: string) => `${pathToFileURL(dir).href}/`
  const loadingTask = pdfjsLib.getDocument({
    data,
    // Gotcha real confirmado en la prueba (Tarea 4): sin esto, documentos
    // con fuentes embebidas/CJK extraen texto vacio o corrupto -- se
    // resuelve apuntando a las carpetas reales que el propio paquete trae.
    standardFontDataUrl: toFactoryUrl(path.join(pdfjsRoot, 'standard_fonts')),
    cMapUrl: toFactoryUrl(path.join(pdfjsRoot, 'cmaps')),
    cMapPacked: true
  })
  const doc = await loadingTask.promise
  const totalUnits = doc.numPages
  const target = Math.min(Math.max(unitIndex ?? 1, 1), totalUnits)
  const page = await doc.getPage(target)
  const textContent = await page.getTextContent()
  const rawText = textContent.items
    .map(item => ('str' in item ? item.str : ''))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()

  if (rawText.length > 0) {
    return { ok: true, unit: { format: 'pdf', totalUnits, unitIndex: target, text: rawText } }
  }

  // Sin texto extraible -- Tarea 4: renderizar la pagina real a PNG en vez
  // de devolver texto vacio, para que el modelo la reciba como imagen.
  const viewport = page.getViewport({ scale: PDF_RENDER_SCALE })
  const canvas = createCanvas(viewport.width, viewport.height)
  const ctx = canvas.getContext('2d')
  // pdfjs-dist declara sus tipos de render() contra el Canvas/Context2D del
  // DOM (lib "DOM", deliberadamente NO incluida en tsconfig.node.json -- este
  // es codigo de proceso principal, no de browser). @napi-rs/canvas es una
  // implementacion real y funcional de esa misma interfaz para Node, pero no
  // nominalmente el mismo tipo -- `as any` es el cast correcto aca, no un
  // workaround de tipado flojo (los tipos de pdfjs-dist asumen un entorno
  // que este proyecto no tiene ni necesita para el resto del codigo).
  await page.render({ canvasContext: ctx, canvas, viewport } as any).promise
  const pngBuffer = canvas.toBuffer('image/png')
  const imageDataUrl = `data:image/png;base64,${pngBuffer.toString('base64')}`
  return { ok: true, unit: { format: 'pdf', totalUnits, unitIndex: target, scanned: true, imageDataUrl } }
}

export async function readDocument(absPath: string, unitIndex: number | undefined): Promise<DocumentReadResult> {
  const format = detectDocumentFormat(absPath)
  if (!format) {
    return { ok: false, error: `Formato no soportado: ${path.extname(absPath) || '(sin extension)'}. read_document acepta .pdf/.docx/.xlsx/.html/.htm.` }
  }
  try {
    return format === 'pdf' ? await readPdfUnit(absPath, unitIndex) : await readOfficeUnit(absPath, format, unitIndex)
  } catch (error) {
    return { ok: false, error: `Fallo leyendo el documento: ${error instanceof Error ? error.message : String(error)}` }
  }
}
