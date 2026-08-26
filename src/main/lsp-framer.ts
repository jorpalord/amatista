// Fase 20: parser de framing LSP real -- "Content-Length: <n>\r\n\r\n<json>",
// NO una linea = un mensaje (a diferencia de RpcStdioClient, que es JSON-RPC
// newline-delimited). Promovido tal cual del prototipo de investigacion
// (scratchpad), probado ahi contra 3 casos sinteticos (header cortado,
// body incompleto, 2+ mensajes en un chunk) y contra el proceso real de
// typescript-language-server -- misma logica, solo tipado.
//
// Bufferizado: un chunk de stdout puede traer un mensaje parcial (header
// o body cortado a mitad) o VARIOS mensajes completos de una vez -- nunca
// asumir que un evento 'data' trae exactamente un mensaje.
export class LspFramer {
  private buffer: Buffer = Buffer.alloc(0)

  /** Devuelve los mensajes JS ya parseados que el chunk completo (puede
   *  ser [] si el chunk no completo ningun mensaje nuevo, o tener 2+ si el
   *  chunk trajo varios mensajes de una vez). */
  feed(chunk: Buffer): unknown[] {
    this.buffer = Buffer.concat([this.buffer, chunk])
    const messages: unknown[] = []

    for (;;) {
      const headerEnd = this.buffer.indexOf('\r\n\r\n')
      if (headerEnd === -1) break // header todavia incompleto

      const headerText = this.buffer.toString('utf8', 0, headerEnd)
      const match = /Content-Length:\s*(\d+)/i.exec(headerText)
      if (!match) {
        // Header malformado -- no deberia pasar contra un server que hable
        // bien el protocolo, pero no cuelga el parser: descarta hasta el
        // separador y sigue con lo que quede.
        this.buffer = this.buffer.subarray(headerEnd + 4)
        continue
      }

      const contentLength = Number(match[1])
      const bodyStart = headerEnd + 4
      const bodyEnd = bodyStart + contentLength
      if (this.buffer.length < bodyEnd) break // body todavia incompleto

      const bodyText = this.buffer.toString('utf8', bodyStart, bodyEnd)
      try {
        messages.push(JSON.parse(bodyText))
      } catch (error) {
        messages.push({ __parseError: String(error), raw: bodyText })
      }
      this.buffer = this.buffer.subarray(bodyEnd)
    }

    return messages
  }
}

export function encodeLspMessage(obj: unknown): Buffer {
  const json = JSON.stringify(obj)
  const body = Buffer.from(json, 'utf8')
  const header = Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii')
  return Buffer.concat([header, body])
}
