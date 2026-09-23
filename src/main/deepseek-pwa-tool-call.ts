// Parser del protocolo de texto TOOL_CALL de DeepSeek PWA (docs/_experiments/deepseek-pwa-tools/CONTRACT.md).
// Modulo PURO (sin Electron ni imports) a proposito, mismo criterio que deepseek-pwa-stream.ts: se prueba aislado en
// tests/regression/deepseek-pwa-tool-call-parser.test.ts.
//
// Reemplaza al parser por regex anterior, que tenia 3 bugs reales (auditoria externa + uno encontrado al reescribirlo):
//   1. Cortaba la llamada en el PRIMER ")" del texto, aunque estuviera dentro de un valor entre comillas: con
//      content="print((1+2)*(3))" el argumento content DESAPARECIA entero y write_file se despachaba sin el.
//   2. Buscaba el patron en CUALQUIER parte de la respuesta: un TOOL_CALL citado como ejemplo dentro de un texto
//      explicativo (o de un bloque de codigo) se despachaba como una orden real.
//   3. Desescapaba con reemplazos sucesivos, \n antes que \\: una ruta "C:\\new" terminaba con un salto de linea real.
//
// Criterio de despacho (evaluado contra las señales reales disponibles):
//   - FORMATO EXACTO + POSICION: el propio protocolo le exige al modelo que su respuesta COMPLETA sea exactamente
//     una linea TOOL_CALL, y lo cumplio en 15/15 llamadas medidas real. Por eso solo se despacha una respuesta que,
//     sin espacios alrededor, empieza con "TOOL_CALL:" y termina justo en el ")" que cierra esa llamada.
//   - Frases que la preceden ("ejemplo", "no ejecutar"...): DESCARTADO como señal. Dependen del idioma, son
//     infinitas en variantes y el criterio de arriba ya las cubre todas: cualquier texto antes o despues impide el
//     despacho, sea cual sea.
// Nunca se despacha a medias: una respuesta con un TOOL_CALL que no cumple el criterio se muestra tal cual con una
// nota honesta, sin reintento automatico (mismo principio de siempre del puente).

export const TOOL_CALL_PREFIX = 'TOOL_CALL:'

export interface ParsedTextToolCall {
  name: string
  args: Record<string, string>
}

export type TextToolCallAnalysis =
  | { kind: 'call'; call: ParsedTextToolCall }
  /** Respuesta final normal: no menciona ningun TOOL_CALL. */
  | { kind: 'none' }
  /** Menciona un TOOL_CALL pero NO se despacha: dentro de un texto, con texto despues, o con sintaxis invalida. */
  | { kind: 'rejected'; reason: 'embedded' | 'trailing' | 'malformed'; detail: string }

const IDENT_RE = /[A-Za-z_][A-Za-z0-9_]*/y

function skipWhitespace(text: string, pos: number): number {
  while (pos < text.length && /\s/.test(text[pos])) pos++
  return pos
}

function readIdentifier(text: string, pos: number): { value: string; end: number } | null {
  IDENT_RE.lastIndex = pos
  const match = IDENT_RE.exec(text)
  return match ? { value: match[0], end: pos + match[0].length } : null
}

/** Lee un string entre comillas dobles empezando en `pos` (que apunta a la comilla de apertura). Los escapes se
 *  decodifican en UNA sola pasada, de izquierda a derecha: \" \\ \n \t \r; cualquier otro \x se conserva literal
 *  (por ejemplo "\d" de una expresion regular dentro de codigo). Los parentesis adentro del string son texto. */
function readQuoted(text: string, pos: number): { value: string; end: number } | { error: string } {
  let value = ''
  let i = pos + 1
  while (i < text.length) {
    const ch = text[i]
    if (ch === '\\') {
      const next = text[i + 1]
      if (next === undefined) break
      value += next === 'n' ? '\n' : next === 't' ? '\t' : next === 'r' ? '\r' : next === '"' || next === '\\' ? next : `\\${next}`
      i += 2
      continue
    }
    if (ch === '"') return { value, end: i + 1 }
    value += ch
    i++
  }
  return { error: 'hay comillas sin cerrar' }
}

/** Parsea `nombre(param="valor", ...)` desde `pos`. El ")" de cierre es el primero FUERA de cualquier string, asi
 *  que parentesis y comillas escapadas dentro de un valor nunca cortan la llamada. */
function parseCall(text: string, start: number): { ok: true; call: ParsedTextToolCall; end: number } | { ok: false; error: string } {
  let pos = skipWhitespace(text, start)
  const name = readIdentifier(text, pos)
  if (!name) return { ok: false, error: 'falta el nombre de la herramienta' }
  pos = skipWhitespace(text, name.end)
  if (text[pos] !== '(') return { ok: false, error: `falta "(" despues de "${name.value}"` }
  pos++
  const args: Record<string, string> = {}
  for (;;) {
    pos = skipWhitespace(text, pos)
    if (text[pos] === ')') return { ok: true, call: { name: name.value, args }, end: pos + 1 }
    if (pos >= text.length) return { ok: false, error: 'falta el ")" que cierra la llamada' }
    const key = readIdentifier(text, pos)
    if (!key) return { ok: false, error: 'se esperaba el nombre de un parametro' }
    pos = skipWhitespace(text, key.end)
    if (text[pos] !== '=') return { ok: false, error: `falta "=" despues de "${key.value}"` }
    pos = skipWhitespace(text, pos + 1)
    if (text[pos] !== '"') return { ok: false, error: `el valor de "${key.value}" tiene que ir entre comillas dobles` }
    const quoted = readQuoted(text, pos)
    if ('error' in quoted) return { ok: false, error: `el valor de "${key.value}": ${quoted.error}` }
    if (Object.prototype.hasOwnProperty.call(args, key.value)) return { ok: false, error: `el parametro "${key.value}" esta repetido` }
    args[key.value] = quoted.value
    pos = skipWhitespace(text, quoted.end)
    if (text[pos] === ',') {
      pos++
      continue
    }
    if (text[pos] === ')') return { ok: true, call: { name: name.value, args }, end: pos + 1 }
    return { ok: false, error: `se esperaba "," o ")" despues del valor de "${key.value}"` }
  }
}

export function analyzeTextToolCall(responseText: string): TextToolCallAnalysis {
  const text = responseText.trim()
  if (!text.startsWith(TOOL_CALL_PREFIX)) {
    return /TOOL_CALL/i.test(responseText)
      ? { kind: 'rejected', reason: 'embedded', detail: 'el TOOL_CALL aparece dentro de un texto, no como la respuesta completa' }
      : { kind: 'none' }
  }
  const parsed = parseCall(text, TOOL_CALL_PREFIX.length)
  if (!parsed.ok) return { kind: 'rejected', reason: 'malformed', detail: parsed.error }
  if (text.slice(parsed.end).trim()) {
    return { kind: 'rejected', reason: 'trailing', detail: 'hay texto despues de la llamada' }
  }
  return { kind: 'call', call: parsed.call }
}

/** Nota honesta que se agrega a la respuesta visible cuando un TOOL_CALL NO se despacha. */
export function describeRejectedToolCall(analysis: Extract<TextToolCallAnalysis, { kind: 'rejected' }>): string {
  if (analysis.reason === 'embedded') {
    return '_(Nota: la respuesta menciona un TOOL_CALL dentro de un texto, pero no se ejecuto: una herramienta solo se ejecuta cuando la respuesta completa es exactamente esa unica linea. Sin reintento automatico.)_'
  }
  if (analysis.reason === 'trailing') {
    return '_(Nota: DeepSeek pidio una herramienta pero agrego texto despues de la llamada, asi que no se ejecuto -- solo se ejecuta cuando la respuesta completa es exactamente la linea TOOL_CALL. Sin reintento automatico.)_'
  }
  return `_(Nota: DeepSeek intento pedir una herramienta, pero la llamada no tiene un formato valido (${analysis.detail}) -- se muestra su respuesta tal cual, sin reintento automatico.)_`
}
