// Feature "Configurar MarkItDown" (docs/_arch/verify_markitdown_config_button_design.md):
// edicion real de ~/.codex/config.toml -- archivo AJENO del usuario (de
// Codex, no de Amatista), puede tener comentarios reales, otras secciones,
// formato elegido por el usuario. Ningun parser TOML del ecosistema JS es
// format-preserving (confirmado real contra la propia documentacion de
// smol-toml: parse()/stringify() no reconstruye el archivo original) -- a
// diferencia de tomlkit (Python) o toml_edit (Rust). Por eso este modulo
// NUNCA reserializa el archivo completo: smol-toml se usa SOLO para
// leer/validar/detectar si la tabla ya existe (funciones puramente de
// lectura) -- la ESCRITURA real es edicion quirurgica de texto plano:
// localizar el header de la tabla, reemplazar solo esas lineas hasta el
// proximo header real o EOF, o hacer append si no existe. Todo lo demas
// (comentarios, otras secciones, orden) sobrevive byte a byte.
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parse as parseToml } from 'smol-toml'

export function codexConfigTomlPath(): string {
  return path.join(os.homedir(), '.codex', 'config.toml')
}

export interface CodexMcpServerSpec {
  command: string
  args: string[]
}

const MARKITDOWN_TABLE_NAME = 'mcp_servers.markitdown'

function tomlStringArray(values: string[]): string {
  return `[${values.map(v => JSON.stringify(v)).join(', ')}]`
}

function markitdownTableBlock(spec: CodexMcpServerSpec): string {
  return `[${MARKITDOWN_TABLE_NAME}]\ncommand = ${JSON.stringify(spec.command)}\nargs = ${tomlStringArray(spec.args)}\n`
}

/** Solo LECTURA -- confirma si la tabla real ya existe (para reportar
 *  "creado" vs "actualizado", mismo criterio que upsertMcpServer() en
 *  mcp-client.ts). Vacio o sin la tabla = false, nunca lanza por esto. */
function markitdownTableAlreadyExists(raw: string): boolean {
  if (raw.trim().length === 0) return false
  const parsed = parseToml(raw) as Record<string, unknown>
  const mcpServers = parsed.mcp_servers
  return typeof mcpServers === 'object' && mcpServers !== null && 'markitdown' in (mcpServers as Record<string, unknown>)
}

/**
 * Edicion quirurgica de TEXTO PLANO -- nunca structs-a-TOML-a-texto (ver
 * comentario de cabecera del archivo). Exportada aparte del resto para
 * poder testear la logica pura contra contenido real sin tocar disco.
 */
export function upsertCodexMarkitdownTableText(raw: string, spec: CodexMcpServerSpec): string {
  const header = `[${MARKITDOWN_TABLE_NAME}]`
  const block = markitdownTableBlock(spec)
  const lines = raw.split('\n')
  const startIndex = lines.findIndex(line => line.trim() === header)

  if (startIndex === -1) {
    // Tabla ausente -- APPEND al final, byte-identico el resto del archivo.
    const sep = raw.length === 0 ? '' : raw.endsWith('\n') ? '\n' : '\n\n'
    return raw + sep + block
  }

  // Tabla presente -- reemplazar SOLO sus lineas (hasta el proximo header
  // de tabla real "[..." o EOF), dejando todo lo demas exactamente como
  // estaba (comentarios, otras secciones, orden).
  let endIndex = lines.length
  for (let i = startIndex + 1; i < lines.length; i++) {
    if (lines[i].trim().startsWith('[')) { endIndex = i; break }
  }
  const before = lines.slice(0, startIndex).join('\n')
  const after = lines.slice(endIndex).join('\n')
  return `${before}${before ? '\n' : ''}${block}${after}`
}

/**
 * Escritura real -- lee ~/.codex/config.toml real (o '' si no existe
 * todavia), valida que parsee como TOML real antes de tocarlo (si esta
 * roto, aborta con un error claro en vez de arriesgarse a empeorarlo),
 * aplica la edicion quirurgica de arriba, y escribe de vuelta.
 */
export function configureCodexMarkitdown(spec: CodexMcpServerSpec): { created: boolean } {
  const target = codexConfigTomlPath()
  const raw = existsSync(target) ? readFileSync(target, 'utf8') : ''

  if (raw.trim().length > 0) {
    try {
      parseToml(raw)
    } catch (error) {
      throw new Error(`~/.codex/config.toml no parsea como TOML valido, no se toca: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const created = !markitdownTableAlreadyExists(raw)
  const updated = upsertCodexMarkitdownTableText(raw, spec)
  mkdirSync(path.dirname(target), { recursive: true })
  writeFileSync(target, updated, 'utf8')
  return { created }
}
