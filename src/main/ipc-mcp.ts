// Canales IPC de .mcp.json (Fase 10, Tarea 6): estado (existe/cantidad de
// servidores) para el boton del renderer, y crear+abrir en el editor de
// texto del sistema (shell.openPath) — mismo patron exacto que
// ipc-agents-md.ts (Fase 7), sin editor propio para v1.
import { ipcMain, shell } from 'electron'
import { existsSync } from 'node:fs'
import { getSession } from './runtime-state'
import { ensureMcpConfigTemplate, mcpConfigPath, readMcpConfig } from './mcp-client'

// Fase Paneles-1: mismo patron que ipc-agents-md.ts -- panelId leido del
// payload en vez de resolver la ventana llamante via event.sender.
function callerWorkspace(panelId: string): string | null {
  return getSession(panelId).activeWorkspace
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
}
