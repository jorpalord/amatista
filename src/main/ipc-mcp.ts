// Canales IPC de .mcp.json (Fase 10, Tarea 6): estado (existe/cantidad de
// servidores) para el boton del renderer, y crear+abrir en el editor de
// texto del sistema (shell.openPath) — mismo patron exacto que
// ipc-agents-md.ts (Fase 7), sin editor propio para v1.
import { ipcMain, shell } from 'electron'
import { existsSync } from 'node:fs'
import { getSession, resolveChatIdForPanel } from './runtime-state'
import { ensureMcpConfigTemplate, mcpConfigPath, readMcpConfig, upsertMcpServer } from './mcp-client'
import { detectDocker } from './cli-status'
import { codexConfigTomlPath, configureCodexMarkitdown } from './codex-config-toml'

// Fase Paneles-1: mismo patron que ipc-agents-md.ts -- panelId leido del
// payload en vez de resolver la ventana llamante via event.sender. F0 del
// rediseño de sesiones en segundo plano: resuelto al chatId real que ese
// panel muestra ahora (resolveChatIdForPanel()).
function callerWorkspace(panelId: string): string | null {
  return getSession(resolveChatIdForPanel(panelId)).activeWorkspace
}

export function registerMcpIpc(): void {
  ipcMain.handle('mcp:status', (_event, payload: { panelId: string }) => {
    const workspace = callerWorkspace(payload.panelId)
    if (!workspace) return { exists: false, serverCount: 0 }
    const exists = existsSync(mcpConfigPath(workspace))
    const serverCount = exists ? Object.keys(readMcpConfig(workspace)).length : 0
    return { exists, serverCount }
  })

  ipcMain.handle('mcp:openOrCreate', async (_event, payload: { panelId: string }) => {
    const workspace = callerWorkspace(payload.panelId)
    if (!workspace) throw new Error('No hay workspace activo.')
    const target = mcpConfigPath(workspace)
    const created = ensureMcpConfigTemplate(workspace)
    const error = await shell.openPath(target)
    if (error) throw new Error(`No se pudo abrir .mcp.json: ${error}`)
    return { success: true, created }
  })

  /**
   * Feature "Configurar MarkItDown" (docs/_arch/verify_markitdown_config_button_design.md):
   * escribe la entrada oficial real de Microsoft (Docker) en LOS 2
   * archivos reales -- .mcp.json del workspace activo (Claude Code CLI) y
   * ~/.codex/config.toml (Codex, global). Docker se chequea PRIMERO -- si
   * falta, corta ahi, no escribe NINGUNO de los 2 archivos (nunca deja al
   * usuario con una referencia real pero rota). Reporta creado-vs-actualizado
   * por archivo, nunca un solo booleano generico.
   */
  ipcMain.handle('mcp:configureMarkitdown', async (_event, payload: { panelId: string }) => {
    const workspace = callerWorkspace(payload.panelId)
    if (!workspace) {
      return { success: false, message: 'No hay panel/workspace activo -- conecta un panel primero.' }
    }

    const docker = await detectDocker()
    if (!docker.installed) {
      return {
        success: false,
        message: 'Docker no esta disponible en PATH -- instalalo antes de configurar MarkItDown (docker.com/get-started). No se escribio ninguna configuracion.'
      }
    }

    const dockerArgs = ['run', '--rm', '-i', '-v', `${workspace}:/workdir`, 'markitdown-mcp:latest']

    let mcpResult: { created: boolean } | null = null
    let mcpError: string | null = null
    try {
      mcpResult = upsertMcpServer(workspace, 'markitdown', { command: 'docker', args: dockerArgs })
    } catch (error) {
      mcpError = error instanceof Error ? error.message : String(error)
    }

    let codexResult: { created: boolean } | null = null
    let codexError: string | null = null
    try {
      codexResult = configureCodexMarkitdown({ command: 'docker', args: dockerArgs })
    } catch (error) {
      codexError = error instanceof Error ? error.message : String(error)
    }

    const mcpPart = mcpResult
      ? `.mcp.json ${mcpResult.created ? 'creado' : 'actualizado'} en ${workspace}`
      : `.mcp.json FALLO (${mcpError})`
    const codexPart = codexResult
      ? `${codexConfigTomlPath()} ${codexResult.created ? 'creado' : 'actualizado'}`
      : `${codexConfigTomlPath()} FALLO (${codexError})`

    return {
      success: Boolean(mcpResult) && Boolean(codexResult),
      message: `${mcpPart} -- ${codexPart}.`
    }
  })
}
