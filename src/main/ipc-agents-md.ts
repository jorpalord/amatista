// Canales IPC de AGENTS.md (Fase 7): estado (existe/lineas/oversized) para
// el boton del renderer, y crear+abrir en el editor de texto del sistema
// (shell.openPath) — sin editor propio para v1, alcanza con delegarselo al
// SO como ya hace attachments:previewImagePath con imagenes.
import { BrowserWindow, ipcMain, shell, type IpcMainInvokeEvent } from 'electron'
import { existsSync, writeFileSync } from 'node:fs'
import { getSession } from './runtime-state'
import { agentsMdPath, getCachedAgentsMd, refreshAgentsMdCache } from './agents-md'

// Fase 22b: antes leia la global `activeWorkspace`. Ahora resuelve la
// ventana llamante via event.sender y usa el workspace de SU sesion --
// cada ventana ve el estado de AGENTS.md de su propia conexion, no la de
// otra ventana que haya conectado despues.
function callerWorkspace(event: IpcMainInvokeEvent): string | null {
  const windowId = BrowserWindow.fromWebContents(event.sender)?.id
  return windowId !== undefined ? getSession(windowId).activeWorkspace : null
}

const AGENTS_MD_TEMPLATE = `# AGENTS.md

Instrucciones para agentes de IA que trabajan en este repositorio.
Estandar agents.md (https://agents.md) — texto plano, sin schema fijo,
compatible con Codex, Claude Code, Cursor, Copilot y AMATISTA.

## Ejemplos de secciones habituales

- Comandos de build/test/lint
- Convenciones de estilo de codigo
- Estructura del proyecto
- Que evitar / decisiones ya tomadas
`

export function registerAgentsMdIpc(): void {
  ipcMain.handle('agentsMd:status', event => {
    const workspace = callerWorkspace(event)
    if (!workspace) return { exists: false, lineCount: 0, oversized: false }
    const info = getCachedAgentsMd(workspace)
    return { exists: Boolean(info), lineCount: info?.lineCount ?? 0, oversized: info?.oversized ?? false }
  })

  ipcMain.handle('agentsMd:openOrCreate', async event => {
    const workspace = callerWorkspace(event)
    if (!workspace) throw new Error('No hay workspace activo.')
    const target = agentsMdPath(workspace)
    const created = !existsSync(target)
    if (created) {
      writeFileSync(target, AGENTS_MD_TEMPLATE, 'utf8')
      refreshAgentsMdCache(workspace)
    }
    const error = await shell.openPath(target)
    if (error) throw new Error(`No se pudo abrir AGENTS.md: ${error}`)
    return { success: true, created }
  })
}
