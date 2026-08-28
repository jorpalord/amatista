// Canales IPC de control de ventana (fullscreen, abrir ventana nueva).
import { BrowserWindow, ipcMain, type IpcMainInvokeEvent } from 'electron'
import { createAppWindow } from './window-manager'

// Fase 22a: getFullscreen/setFullscreen usaban la mainWindow singular antes
// -- con el registro real (N ventanas posibles) eso ya no identifica nada,
// asi que ambos pasan a resolver "la ventana que llamo" via event.sender
// (BrowserWindow.fromWebContents), el mismo mecanismo que ipc-agent.ts usa
// ahora para agent:connect/agent:send/agent:cancel (ver Tarea 3). Resultado:
// cada ventana controla/consulta SU propio fullscreen, no el de "la unica
// que habia antes" -- mas correcto que el comportamiento viejo, no solo
// un reemplazo mecanico.
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

  // Tarea 2 (Fase 22a): crea una BrowserWindow real, la registra, y le
  // pasa que chat mostrar al arrancar (ver createAppWindow -- viaja como
  // query string, funciona igual en dev y produccion). Todavia NO aisla
  // la conexion de runtime por ventana (Fase 22b) -- la ventana nueva
  // arranca sin conectar, igual que arranca la primera ventana hoy.
  ipcMain.handle('window:openInNewWindow', (_event, chatId: string | null) => {
    const window = createAppWindow({ chatId })
    return { windowId: window.id }
  })
}
