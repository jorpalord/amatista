// Infraestructura real de tests de regresion (docs/_arch/
// verify_regression_test_infra_design.md). Stub minimo real de 'electron'
// para bundlear codigo de PRODUCCION real fuera de un proceso Electron --
// mismo patron usado por cada harness temporal de esta sesion (Hallazgo 3/
// 4/5), ahora versionado en vez de recreado desde cero cada vez.
//
// `ipcMain.handle()`/`ipcMain.on()` capturan los handlers/listeners reales
// que `registerAgentIpc()` (y modulos hermanos) registran, expuestos via
// `ipcMain.__handlers`/`ipcMain.__listeners` -- permite que un test invoque
// DIRECTAMENTE un handler IPC real (ej. el de 'agent:disconnect') sin
// necesitar un `IpcMainInvokeEvent` real ni una ventana real, ejercitando
// la MISMA logica de produccion que corre en la app real.
const registeredHandlers = new Map()
const registeredListeners = new Map()

class BrowserWindow {
  static getAllWindows() { return [] }
  static fromWebContents() { return null }
  webContents = { send: () => {}, isDestroyed: () => false }
  isDestroyed() { return false }
}

module.exports = {
  app: {
    getPath: () => require('node:os').tmpdir(),
    getAppPath: () => process.cwd(),
    whenReady: () => Promise.resolve(),
    on: () => {},
    quit: () => {},
    exit: () => {},
    setPath: () => {}
  },
  BrowserWindow,
  ipcMain: {
    handle: (channel, fn) => { registeredHandlers.set(channel, fn) },
    on: (channel, fn) => { registeredListeners.set(channel, fn) },
    removeHandler: (channel) => { registeredHandlers.delete(channel) },
    __handlers: registeredHandlers,
    __listeners: registeredListeners
  },
  dialog: {
    showErrorBox: () => {},
    showMessageBox: () => Promise.resolve({ response: 0 })
  },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (s) => Buffer.from(String(s)),
    decryptString: (b) => b.toString()
  }
}
