// Canales IPC de projectRoots (carpetas registradas) y del workspace activo
// (arbol de archivos, lectura/escritura de archivos de texto).
//
// Fase Paneles-1: workspace:open/workspace:refresh/workspace:readFile/
// workspace:saveFile leen `panelId` del payload (ya no via event.sender) y
// operan sobre getSession(panelId).activeWorkspace -- cada panel tiene su
// propio workspace activo real, independiente de los demas.
// projects:removeRoot sigue siendo una accion global (afecta la lista de
// proyectos de TODA la app) -- itera sessionRegistry directo, no una
// clasificacion nueva. Fix real (PENDING.md, 3ra revision externa): el
// chequeo de pertenencia usaba activeWorkspace.startsWith(root.path)
// (comparacion de string), que confundia "D:\Proyecto" con una carpeta
// hermana distinta "D:\ProyectoExtra" -- ahora usa isWithinFolder()
// (path.relative(), case-insensitive real en Windows), ver runtime-state.ts.
import { dialog, ipcMain } from 'electron'
import { realpathSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { saveSettings } from './settings-store'
import { scanProjectRoot } from './project-registry'
import { buildTree, MAX_TEXT_FILE_BYTES } from './workspace-tree'
import {
  assertInsideWorkspace,
  defaultChatWorkspace,
  disconnectSession,
  getSession,
  isWithinFolder,
  resolveChatIdForPanel,
  resolvedWorkspace,
  sessionRegistry,
  settings,
  setSettings,
  withSettingsLock
} from './runtime-state'

export function registerProjectsAndWorkspaceIpc(): void {
  ipcMain.handle('projects:addRoot', async () => {
    const result = await dialog.showOpenDialog({ properties: ['openDirectory'] })
    if (result.canceled || result.filePaths.length === 0) return null
    const rootPath = realpathSync(result.filePaths[0])
    const existing = settings.projectRoots.find(item => item.path === rootPath)
    if (existing) return existing

    const root = { id: randomUUID(), name: path.basename(rootPath), path: rootPath }
    setSettings({ ...settings, projectRoots: [...settings.projectRoots, root] })
    saveSettings(settings)
    return root
  })

  ipcMain.handle('projects:removeRoot', (_event, rootId: string) => {
    const root = settings.projectRoots.find(item => item.id === rootId)

    setSettings({
      ...settings,
      projectRoots: settings.projectRoots.filter(item => item.id !== rootId)
    })

    // Pertenencia real de carpeta (isWithinFolder(), no startsWith) -- una
    // carpeta removida puede afectar a mas de un panel a la vez si mas de
    // uno tenia ese root (o un subdirectorio real suyo) activo.
    let anySessionAffected = false
    if (root) {
      for (const [chatId, session] of sessionRegistry) {
        if (session.activeWorkspace && isWithinFolder(root.path, session.activeWorkspace)) {
          disconnectSession(chatId)
          session.activeWorkspace = null
          anySessionAffected = true
        }
      }
    }
    if (anySessionAffected) {
      setSettings({
        ...settings,
        activeProjectPath: undefined
      })
    }

    saveSettings(settings)
    return settings
  })

  ipcMain.handle('projects:list', () => settings.projectRoots.flatMap(root => {
    try { return scanProjectRoot(root) } catch { return [] }
  }))

  ipcMain.handle('workspace:default', () => ({
    path: defaultChatWorkspace(),
    name: 'General'
  }))

  // F0 del rediseño de sesiones en segundo plano: `chatId` viaja EXPLICITO
  // en el payload (openWorkspace() en App.tsx ya lo manda) en vez de
  // resolverse via resolveChatIdForPanel(panelId) -- este handler se llama
  // en el mismo instante en que un panel EMPIEZA a mostrar un chatId nuevo
  // (efecto de cambio de chat, App.tsx), antes de que agent:attach termine
  // de actualizar panelToChatId -- resolverlo por panelId aca correria el
  // riesgo real de operar todavia sobre el chat VIEJO.
  ipcMain.handle('workspace:open', async (_event, payload: { panelId: string; chatId: string; workspacePath: string }) => {
    const session = getSession(payload.chatId)
    const nextWorkspace = realpathSync(payload.workspacePath)
    // Solo la sesion de ESTE chat -- otro chat con un workspace distinto
    // abierto no se ve afectado por este cambio.
    if (session.activeWorkspace !== nextWorkspace) disconnectSession(payload.chatId)
    session.activeWorkspace = nextWorkspace
    // Fase Paneles-2a: activeProjectPath es el default sugerido de la app
    // (no "el" workspace activo -- eso ya es session.activeWorkspace, por
    // panel, arriba). withSettingsLock() -- ver runtime-state.ts -- misma
    // cola que connectSessionForWindow(), atomicidad explicita.
    await withSettingsLock(() => {
      setSettings({ ...settings, activeProjectPath: nextWorkspace })
      saveSettings(settings)
    })
    return { path: session.activeWorkspace, tree: buildTree(session.activeWorkspace) }
  })

  ipcMain.handle('workspace:refresh', (_event, payload: { panelId: string }) => {
    const workspace = getSession(resolveChatIdForPanel(payload.panelId)).activeWorkspace
    return buildTree(resolvedWorkspace(workspace))
  })
  ipcMain.handle('workspace:readFile', (_event, payload: { panelId: string; filePath: string }) => {
    const workspace = getSession(resolveChatIdForPanel(payload.panelId)).activeWorkspace
    const safePath = assertInsideWorkspace(workspace, payload.filePath)
    const stats = statSync(safePath)
    if (!stats.isFile()) throw new Error('La ruta no es un archivo.')
    if (stats.size > MAX_TEXT_FILE_BYTES) throw new Error('Archivo demasiado grande.')
    return readFileSync(safePath, 'utf8')
  })
  ipcMain.handle('workspace:saveFile', (_event, payload: { panelId: string; path: string; content: string }) => {
    const workspace = getSession(resolveChatIdForPanel(payload.panelId)).activeWorkspace
    const safePath = assertInsideWorkspace(workspace, payload.path)
    writeFileSync(safePath, payload.content, 'utf8')
    return { success: true }
  })
}
