// Canales IPC de deteccion/instalacion de CLIs (Codex, Claude, Gemini) y
// login/logout de cuenta Codex.
import { ipcMain, shell } from 'electron'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { detectClaude, detectCodex, detectGemini } from './cli-status'
import { openClaudeLogin, openGeminiLogin } from './auth-manager'
import { codexAccountBridge, disconnectAgent } from './runtime-state'

const execFileAsync = promisify(execFile)

export function registerCliIpc(): void {
  ipcMain.handle('cli:status', async () => ({
    codex: await detectCodex(),
    claude: await detectClaude(),
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

  ipcMain.handle('cli:installClaude', async () => {
    const installResult = await execFileAsync(
      'npm',
      ['install', '-g', '@anthropic-ai/claude-code@latest'],
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
      status: await detectClaude()
    }
  })

  ipcMain.handle('auth:openCliLogin', async (_event, providerType: string) => {
    if (providerType === 'anthropic') {
      openClaudeLogin()
      return { started: true }
    }
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
    disconnectAgent()
    return { success: true }
  })
  ipcMain.handle('codex:modelList', async () => codexAccountBridge.listModels())
}
