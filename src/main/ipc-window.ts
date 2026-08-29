// Canales IPC de control de ventana (fullscreen).
//
// Fase Paneles-1: retirados por completo `window:openInNewWindow`
// ("Abrir en ventana nueva" se convierte en "Agregar panel" -- accion
// 100% del renderer, sin canal IPC de creacion equivalente en esta fase)
// y `window:setActiveChatId` (el entregable completo de Mensajeria Paso 1
// -- "que chat muestra ESTA VENTANA" deja de tener sentido cuando una
// ventana muestra N paneles a la vez; cada sesion trackea su propio
// activeChatId directo en SessionRuntimeState, sin un registro aparte).
// Ver docs/_arch/verify_panels_scope.md, Tarea 5.
import { BrowserWindow, ipcMain, type IpcMainInvokeEvent } from 'electron'

// getFullscreen/setFullscreen siguen resolviendo "la ventana que llamo" via
// event.sender (BrowserWindow.fromWebContents) -- a diferencia de la
// identidad de SESION (panelId, ver ipc-agent.ts), fullscreen es una
// propiedad genuina de la UNICA ventana fisica, no de un panel. No
// necesita panelId en absoluto (confirmado en la investigacion previa).
function windowFromEvent(event: IpcMainInvokeEvent): BrowserWindow | null {
  return BrowserWindow.fromWebContents(event.sender)
}

export function registerWindowIpc(): void {
  ipcMain.handle('window:getFullscreen', event => windowFromEvent(event)?.isFullScreen() ?? false)

  ipcMain.handle('window:setFullscreen', (event, value: boolean) => {
    const window = windowFromEvent(event)
    if (!window) return false
    window.setFullScreen(value)
    return window.isFullScreen()
  })
}
