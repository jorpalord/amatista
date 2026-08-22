// Canales IPC de projectRoots (carpetas registradas) y del workspace activo
// (arbol de archivos, lectura/escritura de archivos de texto).
import { dialog, ipcMain } from 'electron'
import { realpathSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { saveSettings } from './settings-store'
import { scanProjectRoot } from './project-registry'
import { buildTree, MAX_TEXT_FILE_BYTES } from './workspace-tree'
import {
  activeWorkspace,
  assertInsideWorkspace,
  defaultChatWorkspace,
  disconnectAgent,
  resolvedWorkspace,
  setActiveWorkspace,
  settings,
  setSettings
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

    if (root && activeWorkspace && activeWorkspace.startsWith(root.path)) {
      disconnectAgent()
      setActiveWorkspace(null)
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

  ipcMain.handle('workspace:open', (_event, workspacePath: string) => {
    const nextWorkspace = realpathSync(workspacePath)
    if (activeWorkspace !== nextWorkspace) disconnectAgent()
    setActiveWorkspace(nextWorkspace)
    setSettings({ ...settings, activeProjectPath: nextWorkspace })
    saveSettings(settings)
    return { path: activeWorkspace, tree: buildTree(activeWorkspace!) }
  })

  ipcMain.handle('workspace:refresh', () => buildTree(resolvedWorkspace()))
  ipcMain.handle('workspace:readFile', (_event, filePath: string) => {
    const safePath = assertInsideWorkspace(filePath)
    const stats = statSync(safePath)
    if (!stats.isFile()) throw new Error('La ruta no es un archivo.')
    if (stats.size > MAX_TEXT_FILE_BYTES) throw new Error('Archivo demasiado grande.')
    return readFileSync(safePath, 'utf8')
  })
  ipcMain.handle('workspace:saveFile', (_event, payload: { path: string; content: string }) => {
    const safePath = assertInsideWorkspace(payload.path)
    writeFileSync(safePath, payload.content, 'utf8')
    return { success: true }
  })
}
