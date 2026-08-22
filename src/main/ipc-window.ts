// Canales IPC de control de ventana (fullscreen).
import { ipcMain } from 'electron'
import { mainWindow } from './runtime-state'

export function registerWindowIpc(): void {
  ipcMain.handle('window:getFullscreen', () => mainWindow?.isFullScreen() ?? false)

  ipcMain.handle('window:setFullscreen', (_event, value: boolean) => {
    if (!mainWindow) return false
    mainWindow.setFullScreen(value)
    return mainWindow.isFullScreen()
  })
}
