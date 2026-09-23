// Canales IPC de AGENTS.md (Fase 7): estado (existe/lineas/oversized) para
// el boton del renderer, y crear+abrir en el editor de texto del sistema
// (shell.openPath) — sin editor propio para v1, alcanza con delegarselo al
// SO como ya hace attachments:previewImagePath con imagenes.
import { ipcMain, shell } from 'electron'
import { existsSync, writeFileSync } from 'node:fs'
import { getSession, resolveChatIdForPanel } from './runtime-state'
import { agentsMdPath, getCachedAgentsMd, refreshAgentsMdCache } from './agents-md'

// Fase Paneles-1: antes resolvia la ventana llamante via event.sender --
// ya no sirve (todos los paneles comparten el mismo webContents). Ahora
// lee panelId directo del payload que mando el renderer, lo resuelve al
// chatId real (F0 del rediseño de sesiones en segundo plano, ver
// resolveChatIdForPanel()) y usa el workspace de ESA sesion -- cada panel
// ve el estado de AGENTS.md del chat que muestra ahora, no la de otro
// panel/chat que haya conectado despues.
function callerWorkspace(panelId: string): string | null {
  return getSession(resolveChatIdForPanel(panelId)).activeWorkspace
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
  ipcMain.handle('agentsMd:status', (_event, payload: { panelId: string }) => {
    const workspace = callerWorkspace(payload.panelId)
    if (!workspace) return { exists: false, lineCount: 0, oversized: false }
    const info = getCachedAgentsMd(workspace)
    return { exists: Boolean(info), lineCount: info?.lineCount ?? 0, oversized: info?.oversized ?? false }
  })

  ipcMain.handle('agentsMd:openOrCreate', async (_event, payload: { panelId: string }) => {
    const workspace = callerWorkspace(payload.panelId)
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
