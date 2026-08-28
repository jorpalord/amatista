import { app } from 'electron'
import { ensureStorageRootOrExit, getAppDataRoot } from './app-paths'
import { loadSettings, saveSettings } from './settings-store'
import { sanitizeSettings } from './settings-provisioning'
import { codexAccountBridge, disconnectAllSessions, settings, setSettings, windowRegistry } from './runtime-state'
import { createAppWindow } from './window-manager'
import { registerWindowIpc } from './ipc-window'
import { registerSettingsIpc } from './ipc-settings'
import { registerChatsIpc } from './ipc-chats'
import { registerCliIpc } from './ipc-cli'
import { registerProjectsAndWorkspaceIpc } from './ipc-projects-workspace'
import { registerAttachmentsIpc } from './ipc-attachments'
import { registerAgentIpc } from './ipc-agent'
import { registerAgentsMdIpc } from './ipc-agents-md'
import { registerMcpIpc } from './ipc-mcp'
import { registerOpenAiChatCatalogIpc } from './ipc-openai-chat-catalog'

// Storage centralizado: TODO lo que Amatista (y Electron internamente:
// cache, cookies, local storage) escribe en disco vive bajo D:\AMATISTA\data.
// Nunca hay fallback silencioso a C:\ — si la unidad D:\ no existe, la app
// muestra un dialogo bloqueante y cierra. Ver src/main/app-paths.ts.
ensureStorageRootOrExit()
app.setPath('userData', getAppDataRoot())

registerWindowIpc()
registerSettingsIpc()
registerChatsIpc()
registerCliIpc()
registerProjectsAndWorkspaceIpc()
registerAttachmentsIpc()
registerAgentIpc()
registerAgentsMdIpc()
registerMcpIpc()
registerOpenAiChatCatalogIpc()

app.whenReady().then(() => {
  setSettings(sanitizeSettings(loadSettings()))
  saveSettings(settings)
  createAppWindow()
  app.on('activate', () => {
    if (windowRegistry.size === 0) createAppWindow()
  })
})

app.on('window-all-closed', () => {
  // Fase 22b: antes "la unica conexion" y "toda la app" eran lo mismo --
  // ahora hay que desconectar TODAS las sesiones reales, no una sola.
  disconnectAllSessions()
  codexAccountBridge.stop()
  if (process.platform !== 'darwin') app.quit()
})
