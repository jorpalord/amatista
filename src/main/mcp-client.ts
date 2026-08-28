// Cliente MCP (Model Context Protocol) para los runtimes API (Fase 10) —
// SOLO transporte stdio en esta fase; HTTP/SSE remoto queda fuera de
// alcance. gemini-cli/codex-subscription/codex-api NO usan este modulo:
// ya tienen MCP nativo via su propio mecanismo, confirmado en la
// investigacion previa a esta fase (ver docs/_arch/CONTRACT.md), fuera de
// alcance de Fase 10.
//
// Reusa RpcStdioClient (Fase 9) como base: el protocolo MCP es JSON-RPC
// 2.0 sobre stdio newline-delimited, misma familia de framing que ya
// implementaba CodexClient/CodexAccountBridge. La diferencia real de
// framing (confirmada contra la especificacion antes de escribir esto, no
// asumida): el campo obligatorio "jsonrpc":"2.0" en el envelope, que Codex
// nunca declaraba — se agrega via el hook envelopeExtras() de
// RpcStdioClient (aditivo, Codex no lo overridea, su wire format no
// cambia). El resto de las diferencias (shape de "initialize", nombre de
// la notificacion post-handshake "notifications/initialized" vs el
// "initialized" bare de Codex, metodos "tools/list"/"tools/call") no
// requieren cambios en la base: cada subclase ya construia su propio
// payload de "initialize" desde antes de Fase 9, esto no es distinto.
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { RpcStdioClient, type RpcMessage } from './rpc-stdio-client'
import type { ToolDefinition, ToolExecutionResult } from './tool-registry'

/**
 * Prefijo de namespacing para tools MCP en el catalogo que se le manda al
 * modelo — mcp__<servidor>__<tool>, evita colision con las 10 tools
 * built-in. api-agent-runtime.ts usa el mismo literal ('mcp__') en
 * runTool() para detectar el prefijo SIN importar este modulo a nivel de
 * valor (solo `import type` para McpManager) — evita un ciclo de import
 * real entre los dos archivos por algo tan chico como un prefijo de
 * string; el costo es que el literal vive en dos lugares, comentado en
 * ambos para que no diverjan en silencio.
 */
export const MCP_TOOL_PREFIX = 'mcp__'

// Version de protocolo MCP declarada en el handshake — la mas reciente que
// se pudo confirmar con confianza al escribir esto (2026-08-23). El
// cliente NO fuerza coincidencia exacta con lo que el servidor devuelva en
// la respuesta de "initialize" — no hay chequeo de version aca. Si el spec
// avanza y esta constante queda vieja, la negociacion sigue funcionando
// con la mayoria de los servidores (aceptan la version que el cliente
// declaro, o devuelven la que ellos soportan y este cliente simplemente
// no valida el mismatch) — no es una garantia de compatibilidad futura,
// es una eleccion consciente de no bloquear por esto en un MVP.
const MCP_PROTOCOL_VERSION = '2025-06-18'

export interface McpServerConfig {
  command: string
  args: string[]
  env?: Record<string, string>
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : {}
}

export function mcpConfigPath(workspace: string): string {
  return path.join(workspace, '.mcp.json')
}

/**
 * Lee .mcp.json de la raiz del workspace — MISMO formato que ya usa Claude
 * Code CLI ({"mcpServers": {"<nombre>": {"command", "args", "env"?}}}), sin
 * esquema propio: un usuario que ya tenga MCP configurado para Claude Code
 * lo hereda gratis en los runtimes API. Ausente o invalido = sin
 * servidores, NO es error — la app sigue funcionando solo con las 10 tools
 * de siempre. Un servidor individual mal formado dentro de un archivo por
 * lo demas valido se omite (no invalida los otros servidores del mismo
 * archivo).
 */
export function readMcpConfig(workspace: string): Record<string, McpServerConfig> {
  const target = mcpConfigPath(workspace)
  if (!existsSync(target)) return {}
  try {
    const raw = readFileSync(target, 'utf8')
    const parsed = JSON.parse(raw) as unknown
    const servers = asRecord(asRecord(parsed).mcpServers)
    const result: Record<string, McpServerConfig> = {}

    for (const [name, value] of Object.entries(servers)) {
      const config = asRecord(value)
      const command = typeof config.command === 'string' ? config.command.trim() : ''
      if (!command) continue // servidor mal formado individual: se omite, no invalida el archivo

      const args = Array.isArray(config.args)
        ? config.args.filter((item): item is string => typeof item === 'string')
        : []

      const envRecord = asRecord(config.env)
      const envEntries = Object.entries(envRecord).filter(
        (entry): entry is [string, string] => typeof entry[1] === 'string'
      )
      const env = envEntries.length > 0 ? Object.fromEntries(envEntries) : undefined

      result[name] = { command, args, env }
    }

    return result
  } catch (error) {
    console.error('[mcp] .mcp.json invalido, se ignora (sin servidores MCP):', error)
    return {}
  }
}

interface McpToolInfo {
  namespacedName: string
  serverName: string
  toolName: string
  description: string
  inputSchema: ToolDefinition['parameters']
}

/**
 * Conexion a UN servidor MCP — mismo framing JSON-RPC de RpcStdioClient
 * (Fase 9), con `jsonrpc: '2.0'` en cada mensaje (obligatorio para MCP,
 * que Codex nunca necesito).
 */
class McpServerConnection extends RpcStdioClient {
  protected envelopeExtras(): Partial<RpcMessage> {
    return { jsonrpc: '2.0' }
  }

  protected notStartedErrorMessage(): string {
    return 'Servidor MCP no esta iniciado.'
  }

  protected rpcErrorFallback(error: NonNullable<RpcMessage['error']>): string {
    return `Error JSON-RPC MCP: ${JSON.stringify(error)}`
  }

  protected processExitErrorMessage(code: number | null, signal: NodeJS.Signals | null): string {
    return `Servidor MCP termino. code=${String(code)}, signal=${String(signal)}`
  }

  async start(config: McpServerConfig, workspace: string): Promise<void> {
    const child = spawn(config.command, config.args, {
      cwd: workspace,
      env: { ...process.env, ...(config.env ?? {}) },
      windowsHide: true,
      shell: process.platform === 'win32'
    })

    this.attachProcess(child)
    child.on('error', error => this.emit('log', { type: 'stderr', text: error.message }))

    // Capabilities del CLIENTE vacias a proposito: Amatista no ofrece
    // roots/sampling/elicitation — solo consume tools/list + tools/call
    // del servidor, sin declarar nada extra de nuestro lado (confirmado
    // contra la especificacion: "tools" es una capability del SERVIDOR,
    // no algo que el cliente declara pedir).
    await this.request('initialize', {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'amatista', version: __APP_VERSION__ }
    })

    // Notificacion obligatoria del handshake MCP — nombre CON prefijo
    // "notifications/", distinto del "initialized" bare que usa Codex
    // (confirmado en la investigacion de Tarea 0, no asumido por
    // similitud superficial de protocolo).
    this.notify('notifications/initialized')
  }

  async listTools(): Promise<Array<{ name: string; description?: string; inputSchema?: unknown }>> {
    const result = await this.request<{ tools?: unknown }>('tools/list', {})
    const tools = Array.isArray(result?.tools) ? result.tools : []
    return tools
      .map(item => asRecord(item))
      .filter(item => typeof item.name === 'string')
      .map(item => ({
        name: item.name as string,
        description: typeof item.description === 'string' ? item.description : undefined,
        inputSchema: item.inputSchema
      }))
  }

  async callTool(toolName: string, args: unknown): Promise<unknown> {
    return this.request('tools/call', { name: toolName, arguments: args ?? {} })
  }
}

/** Texto plano de la respuesta `content: [{type:'text', text}, ...]` de
 *  tools/call — MCP tambien permite bloques 'image'/'resource', que se
 *  omiten del texto (no hay forma de mostrarle una imagen al modelo via
 *  este campo de texto; queda fuera de alcance de esta fase). */
function extractMcpResultText(content: unknown): string {
  if (!Array.isArray(content)) return ''
  return content
    .map(block => {
      const record = asRecord(block)
      return record.type === 'text' && typeof record.text === 'string' ? record.text : ''
    })
    .filter(Boolean)
    .join('\n')
}

/**
 * Orquesta TODOS los servidores MCP de un workspace para UNA conexion de
 * runtime API — un McpManager por `agent:connect`, muere en
 * `disconnectAgent()` (mismo ciclo de vida que CodexClient/ApiAgentRuntime,
 * no por turno individual).
 */
export class McpManager {
  private readonly connections = new Map<string, McpServerConnection>()
  private readonly tools: McpToolInfo[] = []

  /**
   * Arranca todos los servidores configurados en .mcp.json. Un servidor
   * que falla (comando inexistente, crash al iniciar, timeout de
   * handshake) NUNCA bloquea la conexion completa ni a los demas
   * servidores — se loguea y se omite, mismo principio que
   * compaction-engine.ts/explore-tool.ts/local-vcs.ts. Nunca lanza.
   */
  async startAll(workspace: string): Promise<void> {
    const servers = readMcpConfig(workspace)
    for (const [name, config] of Object.entries(servers)) {
      try {
        const connection = new McpServerConnection()
        await connection.start(config, workspace)
        const discovered = await connection.listTools()
        this.connections.set(name, connection)
        for (const tool of discovered) {
          this.tools.push({
            namespacedName: `${MCP_TOOL_PREFIX}${name}__${tool.name}`,
            serverName: name,
            toolName: tool.name,
            description: tool.description ?? '',
            inputSchema: (tool.inputSchema ?? { type: 'object', properties: {}, required: [] }) as ToolDefinition['parameters']
          })
        }
      } catch (error) {
        console.error(`[mcp] servidor "${name}" fallo al iniciar, se omite (los demas siguen):`, error)
      }
    }
  }

  /** Catalogo de tools MCP ya namespaced, forma directa de ToolDefinition
   *  — se suma tal cual a TOOL_DEFINITIONS en api-agent-runtime.ts, sin
   *  transformacion adicional en el punto de uso. */
  listToolDefinitions(): ToolDefinition[] {
    return this.tools.map(tool => ({
      name: tool.namespacedName,
      description: tool.description,
      parameters: tool.inputSchema
    }))
  }

  async callTool(namespacedName: string, args: unknown): Promise<ToolExecutionResult> {
    const info = this.tools.find(tool => tool.namespacedName === namespacedName)
    if (!info) return { ok: false, output: `Tool MCP desconocida: ${namespacedName}` }

    const connection = this.connections.get(info.serverName)
    if (!connection) return { ok: false, output: `Servidor MCP "${info.serverName}" no esta conectado.` }

    try {
      const result = await connection.callTool(info.toolName, args)
      const record = asRecord(result)
      const isError = record.isError === true
      const text = extractMcpResultText(record.content)
      return {
        ok: !isError,
        output: text || (isError ? 'La tool MCP devolvio un error sin detalle.' : '(sin contenido)')
      }
    } catch (error) {
      return { ok: false, output: error instanceof Error ? error.message : String(error) }
    }
  }

  /** Mata TODOS los procesos MCP de esta conexion — llamado desde
   *  disconnectAgent() (runtime-state.ts), mismo punto donde ya se
   *  detienen codexClient/cliRuntime/apiRuntime. Sincronico (kill, no
   *  await), igual que .stop() en las demas clases de runtime. */
  stopAll(): void {
    for (const connection of this.connections.values()) connection.stop()
    this.connections.clear()
    this.tools.length = 0
  }
}

const MCP_CONFIG_TEMPLATE = `{
  "mcpServers": {
    "_ejemplo_borrar_esto": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-everything"]
    }
  }
}
`

/**
 * Crea .mcp.json con una plantilla minima si no existe (Tarea 6, mismo
 * patron que agents-md.ts). No escribe nada si ya existe — nunca
 * sobrescribe una config real del usuario.
 */
export function ensureMcpConfigTemplate(workspace: string): boolean {
  const target = mcpConfigPath(workspace)
  if (existsSync(target)) return false
  writeFileSync(target, MCP_CONFIG_TEMPLATE, 'utf8')
  return true
}
