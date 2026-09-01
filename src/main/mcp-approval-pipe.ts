// Verificacion aislada del canal de aprobacion para el futuro servidor MCP
// propio de Amatista (ver docs/_arch/verify_mcp_approval.md) -- pieza SOLA,
// sin las tools reales de Fase 1 todavia. Un named pipe de Windows
// (\\.\pipe\amatista-mcp-approval), UN solo listener para toda la app
// (mismo principio que sendToWindow(panelId, ...): un proceso, N paneles
// distinguidos por dato en el mensaje, no por canal separado). NDJSON de
// una linea por mensaje -- mismo framing ya confirmado real para MCP en
// verify_mcp_server.md, reusado aca aunque este NO es el protocolo MCP en
// si: es el canal PRIVADO entre el futuro servidor MCP (proceso nieto,
// spawneado por claude-cli/codex/agy) y Amatista main, para llegar a
// requestSessionToolApproval() -- el MISMO mecanismo real que ya usa
// McpManager hoy (mcpConfirm, ipc-agent.ts) para el cliente MCP existente.
//
// Protocolo real de este pipe (una linea en cada direccion, la conexion se
// cierra despues -- sin mantener el socket abierto mas de lo necesario):
//   cliente (servidor MCP) -> main: {"panelId","title","detail"}\n
//   main -> cliente: {"approved": boolean}\n
import { createServer, type Socket } from 'node:net'
import { requestSessionToolApproval } from './runtime-state'

/** Sin precedente hoy en el codebase (confirmado con grep antes de escribir
 *  esto, ver verify_mcp_approval.md) -- primer uso de `node:net` en
 *  Amatista. Ruta fija de named pipe en Windows (unica plataforma real
 *  soportada hoy, ver app-paths.ts) -- el fallback de socket Unix de abajo
 *  NUNCA se probo, queda solo como gesto de portabilidad si el dia de
 *  manana Amatista corre en otro SO. */
export const MCP_APPROVAL_PIPE_PATH =
  process.platform === 'win32' ? '\\\\.\\pipe\\amatista-mcp-approval' : '/tmp/amatista-mcp-approval.sock'

interface ApprovalRequest {
  panelId: string
  title: string
  detail: string
}

function parseRequest(raw: string): ApprovalRequest | null {
  try {
    const parsed = JSON.parse(raw) as Partial<ApprovalRequest>
    if (typeof parsed.panelId !== 'string' || typeof parsed.title !== 'string' || typeof parsed.detail !== 'string') {
      return null
    }
    return { panelId: parsed.panelId, title: parsed.title, detail: parsed.detail }
  } catch {
    return null
  }
}

function handleConnection(socket: Socket): void {
  let buffer = ''

  socket.on('data', chunk => {
    buffer += chunk.toString('utf8')
    const newlineIndex = buffer.indexOf('\n')
    if (newlineIndex === -1) return // linea todavia incompleta, sigue esperando

    const line = buffer.slice(0, newlineIndex)
    const request = parseRequest(line)

    if (!request) {
      socket.end(JSON.stringify({ approved: false, error: 'request malformado' }) + '\n')
      return
    }

    // El bloqueo real pasa aca: requestSessionToolApproval() ya existente
    // (runtime-state.ts) no resuelve hasta que el humano responde en el
    // renderer -- este socket se mantiene abierto todo ese tiempo, sin
    // polling, la propia promesa hace de mecanismo de espera.
    requestSessionToolApproval(request.panelId, request.title, request.detail)
      .then(approved => socket.end(JSON.stringify({ approved }) + '\n'))
      .catch(() => socket.end(JSON.stringify({ approved: false, error: 'fallo interno resolviendo la aprobacion' }) + '\n'))
  })

  socket.on('error', () => {}) // conexion cortada del otro lado (proceso hijo matado, etc.) -- no tira la app
}

/** Arranca el listener UNA sola vez por vida de la app -- llamado desde
 *  index.ts al arrancar, mismo momento que la limpieza garantizada de
 *  Antigravity. Nunca lanza: si el pipe no se pudo abrir (instancia previa
 *  no cerro bien, o el nombre ya esta en uso), loguea y sigue -- no
 *  bloquea el arranque real de Amatista por esto. */
export function startMcpApprovalPipeServer(): void {
  const server = createServer(handleConnection)
  server.on('error', error => {
    console.error('[mcp-approval-pipe] no se pudo arrancar el listener:', error)
  })
  server.listen(MCP_APPROVAL_PIPE_PATH)
}
