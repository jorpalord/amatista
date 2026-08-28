// Canales IPC de projectRoots (carpetas registradas) y del workspace activo
// (arbol de archivos, lectura/escritura de archivos de texto).
//
// Fase 22b: workspace:open/workspace:refresh/workspace:readFile/
// workspace:saveFile resuelven windowId (event.sender) y operan sobre
// getSession(windowId).activeWorkspace -- cada ventana tiene su propio
// workspace activo real, independiente de las demas. projects:removeRoot
// sigue siendo una accion global (afecta la lista de proyectos de TODA la
// app) -- ahi se generaliza el MISMO chequeo que ya existia
// (activeWorkspace.startsWith(root.path)) a todas las sesiones reales,
// iterando sessionRegistry directo, no una clasificacion nueva.
import { BrowserWindow, dialog, ipcMain, type IpcMainInvokeEvent } from 'electron'
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
  resolvedWorkspace,
  sessionRegistry,
  settings,
  setSettings
} from './runtime-state'

function originWindowId(event: IpcMainInvokeEvent): number | null {
  return BrowserWindow.fromWebContents(event.sender)?.id ?? null
}

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

    // Fase 22b: generaliza el MISMO chequeo que ya existia
    // (activeWorkspace.startsWith(root.path)) a todas las sesiones reales
    // -- una carpeta removida puede afectar a mas de una ventana a la vez
    // si mas de una tenia ese root (o un subdirectorio suyo) activo. No es
    // clasificacion nueva de "que deberia pasar" (eso es Fase 22c) -- es
    // la misma condicion de antes, aplicada por sesion en vez de una vez
    // sobre la unica global que existia.
    let anySessionAffected = false
    if (root) {
      for (const [windowId, session] of sessionRegistry) {
        if (session.activeWorkspace && session.activeWorkspace.startsWith(root.path)) {
          disconnectSession(windowId)
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

  ipcMain.handle('workspace:open', (event, workspacePath: string) => {
    const windowId = originWindowId(event)
    if (windowId === null) throw new Error('No se pudo identificar la ventana de origen.')
    const session = getSession(windowId)
    const nextWorkspace = realpathSync(workspacePath)
    // Fase 22b: antes comparaba/desconectaba la conexion global -- ahora
    // solo la sesion de ESTA ventana. Otra ventana con un workspace
    // distinto abierto no se ve afectada por este cambio.
    if (session.activeWorkspace !== nextWorkspace) disconnectSession(windowId)
    session.activeWorkspace = nextWorkspace
    setSettings({ ...settings, activeProjectPath: nextWorkspace })
    saveSettings(settings)
    return { path: session.activeWorkspace, tree: buildTree(session.activeWorkspace) }
  })

  ipcMain.handle('workspace:refresh', event => {
    const windowId = originWindowId(event)
    const workspace = windowId !== null ? getSession(windowId).activeWorkspace : null
    return buildTree(resolvedWorkspace(workspace))
  })
  ipcMain.handle('workspace:readFile', (event, filePath: string) => {
    const windowId = originWindowId(event)
    const workspace = windowId !== null ? getSession(windowId).activeWorkspace : null
    const safePath = assertInsideWorkspace(workspace, filePath)
    const stats = statSync(safePath)
    if (!stats.isFile()) throw new Error('La ruta no es un archivo.')
    if (stats.size > MAX_TEXT_FILE_BYTES) throw new Error('Archivo demasiado grande.')
    return readFileSync(safePath, 'utf8')
  })
  ipcMain.handle('workspace:saveFile', (event, payload: { path: string; content: string }) => {
    const windowId = originWindowId(event)
    const workspace = windowId !== null ? getSession(windowId).activeWorkspace : null
    const safePath = assertInsideWorkspace(workspace, payload.path)
    writeFileSync(safePath, payload.content, 'utf8')
    return { success: true }
  })
}
