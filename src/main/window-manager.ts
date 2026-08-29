// Factoriza la creacion real de la (unica) BrowserWindow fisica, afuera de
// index.ts para evitar un import circular con ipc-window.ts.
//
// Fase Paneles-1: createAppWindow() sobrevive tal cual en su rol de
// arranque -- se sigue llamando UNA vez al iniciar la app (index.ts), ya
// no por accion del usuario ("Abrir en ventana nueva" se retiro, ver
// ipc-window.ts). registerWindow()/windowRegistry (Fase 22a, multiples
// ventanas reales) se reemplaza por setMainWindow() -- una sola referencia,
// no un Map: bajo el modelo de paneles hay una unica ventana fisica siempre.
import { BrowserWindow } from 'electron'
import path from 'node:path'
import { setMainWindow } from './runtime-state'

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
  setMainWindow(window)

  window.on('enter-full-screen', () => {
    window.webContents.send('window:fullscreenChanged', true)
  })

  window.on('leave-full-screen', () => {
    window.webContents.send('window:fullscreenChanged', false)
  })

  // Fase Paneles-1: ya no hay un disconnectSession(window.id) puntual aca
  // -- window.id (number) dejo de ser una clave de sesion valida (las
  // sesiones se indexan por panelId, string, generado por el renderer).
  // Con una unica ventana fisica, "esta ventana se cerro" y "todas las
  // ventanas se cerraron" son el mismo evento -- ya cubierto por
  // disconnectAllSessions() en app.on('window-all-closed', ...) (index.ts),
  // sin necesitar un handler de sesion por-ventana aca tambien.

  const rendererUrl = process.env.ELECTRON_RENDERER_URL
  const query = options.chatId ? `?chatId=${encodeURIComponent(options.chatId)}` : ''
  if (rendererUrl) void window.loadURL(`${rendererUrl}${query}`)
  else void window.loadFile(path.join(__dirname, '../renderer/index.html'), options.chatId ? { query: { chatId: options.chatId } } : undefined)

  return window
}
