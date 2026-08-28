// Fase 22a — creacion real de BrowserWindow, factorizada afuera de index.ts
// para que ipc-window.ts (el nuevo canal "abrir en ventana nueva") pueda
// invocarla sin crear un import circular con index.ts (el entrypoint, que
// ya importa registerWindowIpc() desde ipc-window.ts).
import { BrowserWindow } from 'electron'
import path from 'node:path'
import { disconnectSession, registerWindow } from './runtime-state'

export interface CreateAppWindowOptions {
  /** Chat a mostrar al arrancar esta ventana -- ver Tarea 2. Viaja como
   *  query string (?chatId=...) en la URL/archivo que carga la ventana,
   *  NO via additionalArguments/process.argv: funciona identico en dev
   *  (loadURL contra el servidor de electron-vite) y en produccion
   *  (loadFile), sin logica separada por entorno -- ver investigacion en
   *  docs/_arch/HISTORY.md → Fase 22a. */
  chatId?: string | null
}

export function createAppWindow(options: CreateAppWindowOptions = {}): BrowserWindow {
  const window = new BrowserWindow({
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
  registerWindow(window, options.chatId ?? null)

  window.on('enter-full-screen', () => {
    window.webContents.send('window:fullscreenChanged', true)
  })

  window.on('leave-full-screen', () => {
    window.webContents.send('window:fullscreenChanged', false)
  })

  // Fase 22b: con sesiones reales por ventana, cerrar la ventana N ya solo
  // puede afectar la conexion de la ventana N misma (antes, en 22a, todavia
  // habia una sola conexion compartida por toda la app, asi que esto se
  // limitaba a un disconnect defensivo condicionado a "era la ultima
  // ventana viva" para no matar la conexion de otra ventana que seguia
  // abierta). Ahora es simple y directo: esta ventana se cierra, su propia
  // sesion se desconecta -- sin condicion, sin afectar a ninguna otra.
  window.on('closed', () => {
    disconnectSession(window.id)
  })

  const rendererUrl = process.env.ELECTRON_RENDERER_URL
  const query = options.chatId ? `?chatId=${encodeURIComponent(options.chatId)}` : ''
  if (rendererUrl) void window.loadURL(`${rendererUrl}${query}`)
  else void window.loadFile(path.join(__dirname, '../renderer/index.html'), options.chatId ? { query: { chatId: options.chatId } } : undefined)

  return window
}
