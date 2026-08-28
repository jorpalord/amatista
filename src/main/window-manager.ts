// Fase 22a — creacion real de BrowserWindow, factorizada afuera de index.ts
// para que ipc-window.ts (el nuevo canal "abrir en ventana nueva") pueda
// invocarla sin crear un import circular con index.ts (el entrypoint, que
// ya importa registerWindowIpc() desde ipc-window.ts).
import { BrowserWindow } from 'electron'
import path from 'node:path'
import { disconnectAgent, registerWindow, windowRegistry } from './runtime-state'

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

  // Fase 22a: antes esto llamaba disconnectAgent() incondicionalmente --
  // correcto cuando solo podia existir una ventana (cerrarla SIEMPRE
  // significaba "no queda ninguna"), pero con el registro real ya no es
  // lo mismo: cerrar una ventana secundaria mataria la conexion compartida
  // de la ventana que se queda abierta. app.on('window-all-closed') (ver
  // index.ts) ya cubre el caso real "no queda ninguna ventana" -- este
  // handler, en el mundo de una sola ventana, era estrictamente redundante
  // con ese. Aca solo queda la limpieza del registro (que registerWindow()
  // ya arma por su cuenta) mas, por las dudas, un disconnect defensivo
  // SOLO si esta era la ultima ventana viva -- mismo resultado que antes
  // en el caso de 1 ventana, sin el efecto colateral nuevo en el caso de N.
  window.on('closed', () => {
    if (windowRegistry.size === 0) disconnectAgent()
  })

  const rendererUrl = process.env.ELECTRON_RENDERER_URL
  const query = options.chatId ? `?chatId=${encodeURIComponent(options.chatId)}` : ''
  if (rendererUrl) void window.loadURL(`${rendererUrl}${query}`)
  else void window.loadFile(path.join(__dirname, '../renderer/index.html'), options.chatId ? { query: { chatId: options.chatId } } : undefined)

  return window
}
