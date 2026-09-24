// Nombre del canal (named pipe / socket) por el que el servidor MCP propio de Amatista (mcp-lsp-server.ts, proceso
// hijo de cada CLI) le habla al proceso main (mcp-approval-pipe.ts).
//
// Modulo HOJA a proposito (solo node:*): lo importan mcp-approval-pipe.ts (que lo abre) y cli-agent-runtime.ts (que se
// lo pasa al hijo por ENV) sin arrastrar el arbol de imports de runtime-state.ts -- importar mcp-approval-pipe.ts desde
// cli-agent-runtime.ts habria cerrado un ciclo.
//
// El nombre era FIJO por maquina (`\\.\pipe\amatista-mcp-approval`): cualquier segunda instancia (la misma app abierta
// dos veces, dev + instalada, dos sesiones de trabajo en paralelo) no podia abrir su listener (EADDRINUSE, solo se
// logueaba) y los CLIs de ESA instancia le hablaban al pipe de la PRIMERA: mismo chatId/panelId, otro workspace y otra
// sesion -- aprobaciones y orquestacion mezcladas entre apps distintas (docs/_arch/CONTRACT.md).
//
// Ahora se deriva por PROCESO: `<pid>-<48 bits aleatorios>`, sin ninguna variable de entorno manual. Por proceso y no
// por storage root: dos instancias sobre el MISMO storage (el caso real) tienen que convivir igual. El pid solo
// identifica al dueno al depurar; lo que evita colisiones y hace el nombre impredecible es la parte aleatoria (un
// proceso ajeno no puede "adelantarse" a abrir el nombre antes que Amatista). El nombre solo viaja por ENV a los
// procesos hijo de ESTA instancia.
import { randomBytes } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'

export function deriveInstancePipePath(
  platform: NodeJS.Platform = process.platform,
  pid: number = process.pid,
  entropy: string = randomBytes(6).toString('hex')
): string {
  const id = `${pid}-${entropy}`
  return platform === 'win32'
    ? `\\\\.\\pipe\\amatista-mcp-approval-${id}`
    : path.join(os.tmpdir(), `amatista-mcp-approval-${id}.sock`)
}

/** AMATISTA_MCP_PIPE (opcional, ruta COMPLETA): override explicito para verificacion/harnesses que necesitan un nombre
 *  conocido de antemano. Sin la variable (uso normal), el nombre se deriva solo. */
export const MCP_APPROVAL_PIPE_PATH: string = process.env.AMATISTA_MCP_PIPE?.trim() || deriveInstancePipePath()
