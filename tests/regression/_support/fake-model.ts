// Servidor "modelo" falso para los tests de regresion de tools con imagen: habla el protocolo REAL de los 4 proveedores
// (anthropic /v1/messages, foundry /responses, gemini :generateContent, openai-chat) y captura cada request tal cual la manda
// ApiAgentRuntime. Las primeras `steps.length` peticiones piden las tool calls de cada paso; despues responde 'FINAL'.
import http from 'node:http'

export interface CapturedRequest { url: string; body: Record<string, unknown> }
export interface FakeToolStep { name: string; args: Record<string, unknown> }

export async function startFakeModel(steps: FakeToolStep[][]): Promise<{ endpoint: string; requests: CapturedRequest[]; close: () => Promise<void> }> {
  const requests: CapturedRequest[] = []
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
          ? { candidates: [{ content: { role: 'model', parts: step.map((c, i) => ({ functionCall: { id: id(i), name: c.name, args: c.args }, ...(i === 0 ? { thoughtSignature: 'sig-abc' } : {}) })) } }] }
          : { candidates: [{ content: { role: 'model', parts: [{ text: 'FINAL' }] } }] })
      }
      return send(step
        ? { choices: [{ message: { role: 'assistant', content: null, tool_calls: step.map((c, i) => ({ id: id(i), type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args) } })) } }], usage: { total_tokens: 2 } }
        : { choices: [{ message: { role: 'assistant', content: 'FINAL' } }], usage: { total_tokens: 2 } })
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  return { endpoint: `http://127.0.0.1:${port}`, requests, close: () => new Promise<void>(resolve => { server.close(() => resolve()) }) }
}
