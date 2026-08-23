// Canales IPC de .mcp.json (Fase 10, Tarea 6): estado (existe/cantidad de
// servidores) para el boton del renderer, y crear+abrir en el editor de
// texto del sistema (shell.openPath) — mismo patron exacto que
// ipc-agents-md.ts (Fase 7), sin editor propio para v1.
import { ipcMain, shell } from 'electron'
import { existsSync } from 'node:fs'
import { activeWorkspace } from './runtime-state'
import { ensureMcpConfigTemplate, mcpConfigPath, readMcpConfig } from './mcp-client'

export function registerMcpIpc(): void {
  ipcMain.handle('mcp:status', () => {
    if (!activeWorkspace) return { exists: false, serverCount: 0 }
    const exists = existsSync(mcpConfigPath(activeWorkspace))
    const serverCount = exists ? Object.keys(readMcpConfig(activeWorkspace)).length : 0
    return { exists, serverCount }
  })

  ipcMain.handle('mcp:openOrCreate', async () => {
    if (!activeWorkspace) throw new Error('No hay workspace activo.')
    const target = mcpConfigPath(activeWorkspace)
    const created = ensureMcpConfigTemplate(activeWorkspace)
    const error = await shell.openPath(target)
    if (error) throw new Error(`No se pudo abrir .mcp.json: ${error}`)
    return { success: true, created }
  })
}
