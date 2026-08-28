// Canales IPC de deteccion/instalacion de CLIs (Codex, Gemini) y
// login/logout de cuenta Codex.
import { ipcMain, shell } from 'electron'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { detectCodex, detectGemini } from './cli-status'
import { openGeminiLogin } from './auth-manager'
import { codexAccountBridge, disconnectAllSessions } from './runtime-state'

const execFileAsync = promisify(execFile)

export function registerCliIpc(): void {
  ipcMain.handle('cli:status', async () => ({
    codex: await detectCodex(),
    gemini: await detectGemini()
  }))

  ipcMain.handle('cli:installGemini', async () => {
    const installResult = await execFileAsync(
      'npm',
      ['install', '-g', '@google/gemini-cli@latest'],
      {
        windowsHide: true,
        timeout: 180000,
        shell: process.platform === 'win32'
      }
    )

    return {
      success: true,
      stdout: installResult.stdout,
      stderr: installResult.stderr,
      status: await detectGemini()
    }
  })

  ipcMain.handle('auth:openCliLogin', async (_event, providerType: string) => {
    if (providerType === 'google') {
      openGeminiLogin()
      return { started: true }
    }
    throw new Error('Este proveedor no usa login CLI interactivo.')
  })

  ipcMain.handle('codex:accountRead', async () => codexAccountBridge.readAccount())
  ipcMain.handle('codex:login', async () => {
    const login = await codexAccountBridge.startChatGPTLogin()
    if (login.authUrl) await shell.openExternal(login.authUrl)
    return login
  })
  ipcMain.handle('codex:logout', async () => {
    await codexAccountBridge.logout()
    // Fase 22b: la cuenta ChatGPT/Codex es un login a nivel SO, compartido
    // por CUALQUIER sesion que use openai-codex (ver docs/_arch/
    // verify_fase22_scope.md, Fase 22 Tarea 0, Parte A.1 -- categoria (b)).
    // Antes solo podia existir una conexion, asi que "matarla" y "matar
    // todo lo que use esta cuenta" eran la misma accion; generalizado a
    // TODAS las sesiones reales para no dejar ninguna usando una cuenta
    // que ya cerro sesion -- misma condicion de siempre, no una
    // clasificacion nueva de a quien afecta.
    disconnectAllSessions()
    return { success: true }
  })
  ipcMain.handle('codex:modelList', async () => codexAccountBridge.listModels())
}
