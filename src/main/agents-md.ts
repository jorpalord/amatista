// Soporte de AGENTS.md por proyecto (Fase 7) — estandar real (agents.md),
// texto plano sin schema, adoptado por Codex/Claude Code/Cursor/Copilot.
// Modulo propio en vez de una funcion en workspace-tree.ts: esta ultima es
// especificamente sobre construir el arbol de archivos para el explorador
// del renderer, una responsabilidad distinta a "leer y cachear el contenido
// de un archivo puntual para inyeccion de prompt".
//
// Se lee UNA VEZ por workspace, no en cada turno (AGENTS.md es estatico:
// no cambia entre mensajes salvo que el usuario lo edite a mano, en cuyo
// caso hace falta reconectar para que se vuelva a leer — mismo patron que
// ya exige reconectar para otros cambios de configuracion en esta app).
import { existsSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'

/**
 * ~200 lineas es guia real de la industria (agents.md y varias guias de
 * Claude Code/Cursor recomiendan mantenerlo corto y accionable, no un
 * numero inventado para este proyecto). Pasado ese umbral no se trunca
 * NADA — perder instrucciones en silencio es peor que un prompt largo — se
 * avisa en la UI al conectar y se manda completo igual.
 */
export const AGENTS_MD_LINE_WARNING_THRESHOLD = 200

export interface AgentsMdInfo {
  content: string
  lineCount: number
  oversized: boolean
}

export function agentsMdPath(workspace: string): string {
  return path.join(workspace, 'AGENTS.md')
}

function readAgentsMdFile(workspace: string): AgentsMdInfo | null {
  const target = agentsMdPath(workspace)
  if (!existsSync(target) || !statSync(target).isFile()) return null
  const content = readFileSync(target, 'utf8')
  const lineCount = content.split('\n').length
  return { content, lineCount, oversized: lineCount > AGENTS_MD_LINE_WARNING_THRESHOLD }
}

let cachedWorkspace: string | null = null
let cachedInfo: AgentsMdInfo | null = null

/**
 * Lee AGENTS.md desde disco y refresca el cache — llamar en agent:connect
 * (ipc-agent.ts), una vez por conexion/cambio de workspace, nunca desde
 * agent:send. null si el archivo no existe en la raiz del workspace.
 */
export function refreshAgentsMdCache(workspace: string): AgentsMdInfo | null {
  cachedWorkspace = workspace
  cachedInfo = readAgentsMdFile(workspace)
  return cachedInfo
}

/**
 * Lee del cache sin tocar disco — usado en cada turno (buildRuntimeContext,
 * runtime-state.ts) para inyectar el contenido sin re-leer el archivo. Si
 * el workspace pedido no coincide con el ultimo refrescado (no deberia
 * pasar en uso normal: agent:connect siempre refresca antes de que
 * agent:send pueda correr), refresca on-demand en vez de devolver un
 * resultado potencialmente de OTRO workspace.
 */
export function getCachedAgentsMd(workspace: string): AgentsMdInfo | null {
  if (cachedWorkspace !== workspace) return refreshAgentsMdCache(workspace)
  return cachedInfo
}
