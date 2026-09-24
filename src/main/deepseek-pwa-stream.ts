// Parser del stream SSE de chat.deepseek.com (POST /api/v0/chat/completion) -- experimento aislado
// docs/_experiments/deepseek-pwa/CONTRACT.md ("Pendientes del diseno -- P2", 6 reglas). Modulo PURO (sin
// Electron) a proposito: se prueba con capturas reales en tests/regression/deepseek-pwa-stream.test.ts.
//
// Formato real observado (stream de "parches" JSON):
//   data: {"v":{"response":{..."thinking_enabled":true,..."fragments":[{"id":2,"type":"THINK","content":"We"}]}}}
//   data: {"p":"response/fragments/-1/content","o":"APPEND","v":" need"}
//   data: {"v":" answer"}                                  <- continua la ULTIMA ruta explicita
//   data: {"p":"response/fragments/-1/elapsed_secs","o":"SET","v":1.9}
//   data: {"p":"response/fragments","o":"APPEND","v":[{"id":3,"type":"RESPONSE","content":"1"}]}
//   data: {"p":"response/fragments/-1/content","v":"."}   <- p sin o => APPEND implicito
//   data: {"p":"response","o":"BATCH","v":[{"p":"quasi_status","v":"FINISHED"}, ...]}
//   data: {"p":"response/status","o":"SET","v":"FINISHED"}   (INCOMPLETE si se detuvo)
//   event: title / data: {"content":"..."}

export type FragmentType = 'THINK' | 'RESPONSE' | string

export type DeepSeekStreamEvent =
  | { kind: 'think'; text: string }
  | { kind: 'response'; text: string }
  | { kind: 'fragment'; type: FragmentType }
  | { kind: 'status'; status: string }
  | { kind: 'title'; title: string }
  | { kind: 'error'; code: unknown; msg: string }
  | { kind: 'initial'; thinkingEnabled: boolean | null; searchEnabled: boolean | null }

const CONTENT_PATH = /^response\/fragments\/(-?\d+)\/content$/

export class DeepSeekStreamParser {
  private buffer = ''
  private currentPath: string | null = null
  private pendingEvent: string | null = null
  private readonly fragments: FragmentType[] = []
  /** true en cuanto aparece CUALQUIER estructura reconocida (objeto inicial, ruta conocida, status). Un stream
   *  HTTP 200 que nunca la muestra es un cambio de formato real -- el runtime lo reporta, nunca muestra basura. */
  recognized = false
  /** Lineas `data:` que no se pudieron interpretar (JSON invalido o forma desconocida) -- solo diagnostico. */
  readonly unrecognizedSamples: string[] = []

  feed(chunk: string): DeepSeekStreamEvent[] {
    const out: DeepSeekStreamEvent[] = []
    this.buffer += chunk
    let newline: number
    while ((newline = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, newline).replace(/\r$/, '')
      this.buffer = this.buffer.slice(newline + 1)
      this.handleLine(line, out)
    }
    return out
  }

  private handleLine(line: string, out: DeepSeekStreamEvent[]): void {
    if (line === '') { this.pendingEvent = null; return }
    if (line.startsWith('event:')) { this.pendingEvent = line.slice(6).trim(); return }
    if (!line.startsWith('data:')) return
    const raw = line.slice(5).trim()
    let data: unknown
    try { data = JSON.parse(raw) } catch { this.noteUnrecognized(raw); return }
    const event = this.pendingEvent
    if (event && event !== 'message') { this.handleNamedEvent(event, data, out); return }
    this.apply(data, out)
  }

  private handleNamedEvent(event: string, data: unknown, out: DeepSeekStreamEvent[]): void {
    // Regla 6: ready / update_session / title / close. Solo `title` trae algo util; un evento nombrado `error`
    // (no observado todavia) se reporta tal cual.
    if (event === 'ready' || event === 'update_session' || event === 'close') { this.recognized = true; return }
    const record = asRecord(data)
    if (event === 'title') {
      this.recognized = true
      if (typeof record.content === 'string') out.push({ kind: 'title', title: record.content })
      return
    }
    if (event === 'error') { out.push({ kind: 'error', code: record.code ?? null, msg: String(record.msg ?? record.message ?? JSON.stringify(data)).slice(0, 500) }); return }
    // Avisos del servidor (esquema confirmado en el frontend real: {type:"warning"|"error", content, finish_reason?,
    // clear_response}). Capturado real: el rate limit llega como `hint` type "error", finish_reason "rate_limit_reached".
    // Un "error" corta el turno con el texto REAL del servidor; un "warning" no es fatal.
    if (event === 'hint' || event === 'toast') {
      this.recognized = true
      if (record.type === 'error') {
        out.push({ kind: 'error', code: typeof record.finish_reason === 'string' ? record.finish_reason : null, msg: String(record.content ?? JSON.stringify(data)).slice(0, 500) })
      }
      return
    }
    this.noteUnrecognized(`event:${event} ${JSON.stringify(data).slice(0, 120)}`)
  }

  private apply(data: unknown, out: DeepSeekStreamEvent[]): void {
    const record = asRecord(data)
    // Objeto de error estilo {code, msg} (formato no confirmado en vivo -- se reporta tal cual, sin traducir).
    if ('code' in record && 'msg' in record && record.p === undefined) {
      out.push({ kind: 'error', code: record.code, msg: String(record.msg).slice(0, 500) }); return
    }
    // BATCH: se expande con el prefijo de la ruta padre.
    if (record.o === 'BATCH' && Array.isArray(record.v)) {
      for (const sub of record.v) {
        const subRecord = asRecord(sub)
        if (typeof subRecord.p !== 'string') continue
        this.apply({ p: record.p ? `${record.p}/${subRecord.p}` : subRecord.p, o: subRecord.o ?? 'SET', v: subRecord.v }, out)
      }
      return
    }
    // Objeto inicial: {"v":{"response":{...}}} (regla 1 + dato de verificacion thinking_enabled/search_enabled).
    if (record.p === undefined && record.v && typeof record.v === 'object' && !Array.isArray(record.v)) {
      const response = asRecord(asRecord(record.v).response)
      if (Object.keys(response).length > 0) {
        this.recognized = true
        out.push({ kind: 'initial', thinkingEnabled: asBool(response.thinking_enabled), searchEnabled: asBool(response.search_enabled) })
        if (Array.isArray(response.fragments)) this.addFragments(response.fragments, out)
        return
      }
    }
    // Regla 3: `p` explicito fija la ruta actual; sin `p`, continua la ultima ruta explicita.
    if (typeof record.p === 'string') this.currentPath = record.p
    const path = typeof record.p === 'string' ? record.p : this.currentPath
    if (path === null) { this.noteUnrecognized(JSON.stringify(data).slice(0, 160)); return }

    // Regla 1: crecimiento de la lista de fragmentos.
    if (path === 'response/fragments' && Array.isArray(record.v)) { this.recognized = true; this.addFragments(record.v, out); return }
    // Regla 5: status final (FINISHED / INCOMPLETE / otro -- se reporta tal cual). quasi_status se ignora.
    if (path === 'response/status' && typeof record.v === 'string') { this.recognized = true; out.push({ kind: 'status', status: record.v }); return }
    if (path.endsWith('quasi_status') || path.endsWith('accumulated_token_usage') || path.endsWith('elapsed_secs')) { this.recognized = true; return }
    // Regla 3/4: contenido del fragmento indicado (-1 = el ultimo), enrutado por su tipo.
    const match = CONTENT_PATH.exec(path)
    if (match && typeof record.v === 'string') {
      this.recognized = true
      const index = Number(match[1])
      const type = index < 0 ? this.fragments[this.fragments.length + index] : this.fragments[index]
      this.emitContent(type, record.v, out)
      return
    }
    if (typeof record.v === 'string') this.noteUnrecognized(`ruta=${path} ${JSON.stringify(record.v).slice(0, 80)}`)
  }

  private addFragments(list: unknown[], out: DeepSeekStreamEvent[]): void {
    for (const item of list) {
      const fragment = asRecord(item)
      const type: FragmentType = typeof fragment.type === 'string' ? fragment.type : 'UNKNOWN'
      this.fragments.push(type)
      out.push({ kind: 'fragment', type })
      // Regla 2: el `content` inicial del fragmento es el primer token -- cuenta.
      if (typeof fragment.content === 'string' && fragment.content.length > 0) this.emitContent(type, fragment.content, out)
    }
  }

  private emitContent(type: FragmentType | undefined, text: string, out: DeepSeekStreamEvent[]): void {
    if (type === 'THINK') out.push({ kind: 'think', text })
    else if (type === 'RESPONSE') out.push({ kind: 'response', text })
    else this.noteUnrecognized(`fragmento tipo=${String(type)} ${JSON.stringify(text).slice(0, 60)}`)
  }

  private noteUnrecognized(sample: string): void {
    if (this.unrecognizedSamples.length < 10) this.unrecognizedSamples.push(sample.slice(0, 200))
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function asBool(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null
}

/** Resultado final de un turno, ya reducido -- el runtime lo arma y describeStreamOutcome() decide exito/error. */
export interface DeepSeekTurnOutcome {
  httpStatus: number | null
  status: string | null
  responseText: string
  thinkText: string
  recognized: boolean
  errors: Array<{ code: unknown; msg: string }>
  networkError: string | null
  cancelledByUser: boolean
  inactivityTimeout: boolean
  unrecognizedSamples: string[]
}

/** Los 2 limites reales de la interfaz web de DeepSeek que Amatista reconoce por nombre. */
export type DeepSeekLimit = 'rate-limit' | 'context-length'

export type OutcomeVerdict =
  | { kind: 'success' }
  | { kind: 'cancelled' }
  | { kind: 'error'; message: string; limit?: DeepSeekLimit }

/** Rate limit: finish_reason real capturado ("rate_limit_reached") o su texto. Longitud: su finish_reason NO se
 *  conoce (nunca capturado), asi que se reconoce por el texto del servidor -- "达到对话长度上限，请开启新对话" y
 *  variantes -- o por un finish_reason que hable de longitud/contexto. */
export function classifyDeepSeekLimit(error: { code: unknown; msg: string }): DeepSeekLimit | null {
  const code = typeof error.code === 'string' ? error.code : ''
  if (code === 'rate_limit_reached' || /too frequent|频繁/i.test(error.msg)) return 'rate-limit'
  if (/长度上限|对话长度|length limit|maximum (conversation|context) length|context length|conversation is too long/i.test(error.msg) || /length|context/i.test(code)) {
    return 'context-length'
  }
  return null
}

/**
 * Tarea 5 del diseno: la verdad sale SIEMPRE del stream (HTTP 200 + status FINISHED + contenido no vacio), nunca
 * del icono del boton. Los mensajes muestran el dato real tal cual (status, HTTP, msg del servidor) -- sin
 * inventar traducciones de formatos que no se observaron en vivo.
 */
export function describeStreamOutcome(outcome: DeepSeekTurnOutcome): OutcomeVerdict {
  if (outcome.errors.length > 0) {
    const first = outcome.errors[0]
    const limit = classifyDeepSeekLimit(first)
    if (limit === 'rate-limit') {
      return {
        kind: 'error',
        limit,
        message: `DeepSeek limito la frecuencia de mensajes ("${first.msg}"): se mandaron muchos mensajes seguidos en poco tiempo. Espera unos segundos y pedile que siga.`
      }
    }
    if (limit === 'context-length') {
      return {
        kind: 'error',
        limit,
        message: `DeepSeek alcanzo el limite de longitud de esta conversacion ("${first.msg}") -- inicia un chat nuevo para seguir.`
      }
    }
    return { kind: 'error', message: `DeepSeek devolvio un error: ${first.msg}${first.code !== null && first.code !== undefined ? ` (code ${String(first.code)})` : ''}` }
  }
  if (outcome.networkError) return { kind: 'error', message: `La conexion con DeepSeek fallo: ${outcome.networkError}` }
  if (outcome.httpStatus !== null && (outcome.httpStatus < 200 || outcome.httpStatus >= 300)) {
    return { kind: 'error', message: `DeepSeek respondio HTTP ${outcome.httpStatus}.` }
  }
  if (outcome.inactivityTimeout) return { kind: 'error', message: 'DeepSeek dejo de responder (sin datos nuevos durante demasiado tiempo); se detuvo el turno.' }
  if (outcome.cancelledByUser && outcome.status === 'INCOMPLETE') return { kind: 'cancelled' }
  if (!outcome.recognized) {
    return { kind: 'error', message: 'DeepSeek cambio el formato de su respuesta y el puente no lo reconoce; necesita actualizacion. No se muestra texto a medio interpretar.' }
  }
  if (outcome.status === 'FINISHED' && outcome.responseText.trim().length > 0) return { kind: 'success' }
  if (outcome.status === 'FINISHED') return { kind: 'error', message: 'DeepSeek termino sin devolver respuesta (status FINISHED, contenido vacio).' }
  if (outcome.status === null) return { kind: 'error', message: 'El stream de DeepSeek cerro sin informar un status final.' }
  return { kind: 'error', message: `DeepSeek termino con status "${outcome.status}".` }
}
