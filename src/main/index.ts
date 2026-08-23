import { app, BrowserWindow } from 'electron'
import path from 'node:path'
import { ensureStorageRootOrExit, getAppDataRoot } from './app-paths'
import { loadSettings, saveSettings } from './settings-store'
import { sanitizeSettings } from './settings-provisioning'
import { codexAccountBridge, disconnectAgent, settings, setMainWindow, setSettings } from './runtime-state'
import { registerWindowIpc } from './ipc-window'
import { registerSettingsIpc } from './ipc-settings'
import { registerChatsIpc } from './ipc-chats'
import { registerCliIpc } from './ipc-cli'
import { registerProjectsAndWorkspaceIpc } from './ipc-projects-workspace'
import { registerAttachmentsIpc } from './ipc-attachments'
import { registerAgentIpc } from './ipc-agent'
import { registerAgentsMdIpc } from './ipc-agents-md'
import { registerMcpIpc } from './ipc-mcp'

// Storage centralizado: TODO lo que Amatista (y Electron internamente:
// cache, cookies, local storage) escribe en disco vive bajo D:\AMATISTA\data.
// Nunca hay fallback silencioso a C:\ — si la unidad D:\ no existe, la app
// muestra un dialogo bloqueante y cierra. Ver src/main/app-paths.ts.
ensureStorageRootOrExit()
app.setPath('userData', getAppDataRoot())

function createWindow(): void {
  const mainWindow = new BrowserWindow({
    width: 1600,
    height: 980,
    minWidth: 1100,
    minHeight: 700,
    backgroundColor: '#171717',
    title: `AMATISTA ${__APP_VERSION__}`,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })
  setMainWindow(mainWindow)

  mainWindow.on('enter-full-screen', () => {
    mainWindow.webContents.send('window:fullscreenChanged', true)
  })

  mainWindow.on('leave-full-screen', () => {
    mainWindow.webContents.send('window:fullscreenChanged', false)
  })

  mainWindow.on('closed', () => {
    disconnectAgent()
    setMainWindow(null)
  })

  const rendererUrl = process.env.ELECTRON_RENDERER_URL
  if (rendererUrl) void mainWindow.loadURL(rendererUrl)
  else void mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'))
}

registerWindowIpc()
registerSettingsIpc()
registerChatsIpc()
registerCliIpc()
registerProjectsAndWorkspaceIpc()
registerAttachmentsIpc()
registerAgentIpc()
registerAgentsMdIpc()
registerMcpIpc()

app.whenReady().then(() => {
  setSettings(sanitizeSettings(loadSettings(), true))
  saveSettings(settings)
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  disconnectAgent()
  codexAccountBridge.stop()
  if (process.platform !== 'darwin') app.quit()
})
