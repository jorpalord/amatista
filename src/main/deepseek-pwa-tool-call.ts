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
//   - POSICION: la respuesta tiene que TERMINAR en una o mas lineas TOOL_CALL propias (cada una empieza la linea y
//     termina justo en el ")" que la cierra), sin nada despues. Se despacha SOLO la primera; las demas se le avisan al
//     modelo en el TOOL_RESULT para que las pida de a una.
//   - Texto ANTES de la primera linea ("Voy a revisar el entorno..."): se permite (decision del usuario, 2026-10-03).
//     Antes no se despachaba, y en uso real con DeepThink el modelo narraba antes de llamar y la tarea se cortaba con
//     una nota. Ese texto se muestra como parte de la respuesta. Sigue sin despacharse si ese texto menciona otro
//     TOOL_CALL o el formato nativo, o si la linea queda dentro de un bloque de codigo (```), que son señales de
//     ejemplo citado y no de pedido.
//   - Frases que la preceden ("ejemplo", "no ejecutar"...): DESCARTADO como señal. Dependen del idioma y son
//     infinitas en variantes. Riesgo aceptado por el usuario: un ejemplo escrito como linea propia al FINAL de una
//     explicacion se despacha, con las aprobaciones del modo de siempre (en Acceso completo, sin preguntar).
// Nunca se despacha a medias: una respuesta con un TOOL_CALL que no cumple el criterio (citado dentro de una frase,
// con texto despues, o con sintaxis invalida) se muestra tal cual con una nota honesta, sin reintento automatico.

export const TOOL_CALL_PREFIX = 'TOOL_CALL:'

export interface ParsedTextToolCall {
  name: string
  args: Record<string, string>
}

export type TextToolCallAnalysis =
  /** preamble: el texto antes de la linea (ya recortado, '' si no hay). ignoredCalls: nombres de las llamadas que
   *  venian despues de la primera en la misma respuesta -- NO se ejecutan. */
  | { kind: 'call'; call: ParsedTextToolCall; preamble: string; ignoredCalls: string[] }
  /** Respuesta final normal: no menciona ningun TOOL_CALL. */
  | { kind: 'none' }
  /** Menciona un TOOL_CALL pero NO se despacha: dentro de un texto, con texto despues, o con sintaxis invalida.
   *  'native-format': DeepSeek pidio una herramienta con su formato NATIVO de llamadas (visto real: `<｜｜DSML｜｜ calls>`
   *  despues de 5 llamadas limpias) en vez de la linea TOOL_CALL -- sin esto pasaba en silencio como respuesta final. */
  | { kind: 'rejected'; reason: 'embedded' | 'trailing' | 'malformed' | 'native-format'; detail: string }

/** Marcadores del formato nativo de llamadas de DeepSeek: DSML (visto real) y el token de la plantilla nativa
 *  `<｜tool▁calls▁begin｜>` (no observado todavia). Solo se detectan para avisar; nunca se interpretan ni se ejecutan. */
const NATIVE_TOOL_CALL_RE = /<\s*[｜|]{1,3}\s*(?:DSML\s*[｜|]{1,3}|tool▁calls?▁begin)/i

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

/** Posicion donde empieza la primera LINEA que arranca con "TOOL_CALL:" (sangria permitida), o -1. */
function findToolCallLine(text: string): number {
  let offset = 0
  for (const line of text.split('\n')) {
    const indent = line.length - line.trimStart().length
    if (line.startsWith(TOOL_CALL_PREFIX, indent)) return offset + indent
    offset += line.length + 1
  }
  return -1
}

/** true si el texto termina con un bloque de codigo abierto (cantidad impar de cercos ``` o ~~~ al empezar linea). */
function endsInsideCodeFence(text: string): boolean {
  return text.split('\n').filter(line => /^\s*(```|~~~)/.test(line)).length % 2 === 1
}

export function analyzeTextToolCall(responseText: string): TextToolCallAnalysis {
  const text = responseText.trim()
  const start = findToolCallLine(text)
  if (start === -1) {
    if (/TOOL_CALL/i.test(text)) {
      return { kind: 'rejected', reason: 'embedded', detail: 'el TOOL_CALL aparece dentro de una frase, no en una linea propia' }
    }
    if (NATIVE_TOOL_CALL_RE.test(text)) {
      return { kind: 'rejected', reason: 'native-format', detail: 'uso su formato nativo de llamadas a funciones, no la linea TOOL_CALL' }
    }
    return { kind: 'none' }
  }
  const preamble = text.slice(0, start).trim()
  if (/TOOL_CALL/i.test(preamble) || NATIVE_TOOL_CALL_RE.test(preamble) || endsInsideCodeFence(preamble)) {
    return { kind: 'rejected', reason: 'embedded', detail: 'el texto de antes cita otro TOOL_CALL o la linea esta dentro de un bloque de codigo' }
  }
  const calls: ParsedTextToolCall[] = []
  let pos = start
  for (;;) {
    const parsed = parseCall(text, pos + TOOL_CALL_PREFIX.length)
    if (!parsed.ok) return { kind: 'rejected', reason: 'malformed', detail: parsed.error }
    calls.push(parsed.call)
    const next = skipWhitespace(text, parsed.end)
    if (next >= text.length) break
    // Despues de una llamada solo puede venir OTRA linea TOOL_CALL (en su propia linea); cualquier otra cosa es texto.
    if (!text.slice(parsed.end, next).includes('\n') || !text.startsWith(TOOL_CALL_PREFIX, next)) {
      return { kind: 'rejected', reason: 'trailing', detail: 'hay texto despues de la llamada' }
    }
    pos = next
  }
  return { kind: 'call', call: calls[0], preamble, ignoredCalls: calls.slice(1).map(call => call.name) }
}

/** Nota honesta que se agrega a la respuesta visible cuando un TOOL_CALL NO se despacha. */
export function describeRejectedToolCall(analysis: Extract<TextToolCallAnalysis, { kind: 'rejected' }>): string {
  if (analysis.reason === 'embedded') {
    return '_(Nota: la respuesta menciona un TOOL_CALL dentro del texto, no en una linea propia al final, asi que no se ejecuto ninguna herramienta.)_'
  }
  if (analysis.reason === 'trailing') {
    return '_(Nota: DeepSeek pidio una herramienta pero siguio escribiendo despues de la llamada, asi que no se ejecuto.)_'
  }
  if (analysis.reason === 'native-format') {
    return '_(Nota: DeepSeek intento usar una herramienta con su formato nativo de llamadas (no con la linea TOOL_CALL), asi que no se ejecuto -- la tarea quedo sin terminar. Pedile que siga.)_'
  }
  return `_(Nota: DeepSeek intento pedir una herramienta, pero la llamada no tiene un formato valido (${analysis.detail}), asi que no se ejecuto.)_`
}

/** Filtro del streaming en vivo de UNA ronda: el texto normal pasa apenas se sabe que no es una linea TOOL_CALL, y
 *  desde la primera linea que empieza con "TOOL_CALL:" se retiene todo hasta el final de la ronda. La decision real
 *  sale despues de analyzeTextToolCall() sobre el texto completo: si la ronda se despacha, lo retenido se descarta
 *  (el usuario nunca ve la linea cruda); si no, se emite tal cual (y la respuesta final lleva la nota). */
export class ToolCallLineGate {
  /** Principio de la linea en curso que todavia podria convertirse en "TOOL_CALL:". */
  private pending = ''
  /** La linea en curso ya se emitio: el resto pasa directo hasta el proximo salto de linea. */
  private lineReleased = false
  /** Desde la primera linea TOOL_CALL hasta el final de la ronda. */
  private held: string | null = null

  /** Devuelve lo que ya se puede mostrar en vivo. */
  push(text: string): string {
    if (this.held !== null) { this.held += text; return '' }
    let out = ''
    let rest = text
    while (rest) {
      const newline = rest.indexOf('\n')
      const chunk = newline === -1 ? rest : rest.slice(0, newline + 1)
      rest = rest.slice(chunk.length)
      if (this.lineReleased) {
        out += chunk
        if (chunk.endsWith('\n')) this.lineReleased = false
        continue
      }
      this.pending += chunk
      const head = this.pending.trimStart()
      if (head.startsWith(TOOL_CALL_PREFIX)) {
        this.held = this.pending + rest
        this.pending = ''
        return out
      }
      if (this.pending.endsWith('\n')) { out += this.pending; this.pending = ''; continue }
      if (head.length < TOOL_CALL_PREFIX.length && TOOL_CALL_PREFIX.startsWith(head)) continue
      out += this.pending
      this.pending = ''
      this.lineReleased = true
    }
    return out
  }

  /** Fin de la ronda: devuelve lo retenido si NO se despacho ('' si se despacho) y deja el filtro listo para otra. */
  settle(dispatched: boolean): string {
    const rest = (this.held ?? '') + this.pending
    this.pending = ''
    this.lineReleased = false
    this.held = null
    return dispatched ? '' : rest
  }
}
