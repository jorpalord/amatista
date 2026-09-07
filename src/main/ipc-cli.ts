// Canales IPC de deteccion/instalacion de CLIs (Codex, Claude, Antigravity)
// y login/logout de cuenta Codex.
//
// Retiro de gemini-cli (docs/_arch/verify_gemini_cli_removal_scope.md,
// verify_gemini_cli_removal.md): 'cli:installGemini' y la deteccion/login
// de Gemini CLI salieron enteros de aca -- gemini-cli standalone quedo
// discontinuado para cuentas individuales (IneligibleTierError real,
// confirmado). El camino HTTP (authMode:'api-key') no pasa por este
// archivo, sin cambios.
import { ipcMain, shell } from 'electron'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { detectAntigravity, detectClaude, detectCodex } from './cli-status'
import { openAntigravityLogin, openClaudeLogin } from './auth-manager'
import { discoverNewAntigravityModels, discoverNewClaudeModels } from './model-discovery'
import { codexAccountBridge, disconnectAllSessions } from './runtime-state'

const execFileAsync = promisify(execFile)

export function registerCliIpc(): void {
  ipcMain.handle('cli:status', async () => ({
    codex: await detectCodex(),
    claude: await detectClaude(),
    antigravity: await detectAntigravity()
  }))

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

  // Integracion de Antigravity CLI: instalador oficial real (NO npm --
  // confirmado real en verify_antigravity_cli.md, Tarea 5, ya usado en esta
  // sesion para instalar el binario de verificacion). powershell.exe es un
  // binario real, no un shim .cmd -- a diferencia de npm (Claude, ver
  // arriba), no hace falta shell:true.
  ipcMain.handle('cli:installAntigravity', async () => {
    const installResult = await execFileAsync(
      'powershell',
      ['-NoProfile', '-Command', 'irm https://antigravity.google/cli/install.ps1 | iex'],
      {
        windowsHide: true,
        timeout: 180000
      }
    )

    return {
      success: true,
      stdout: installResult.stdout,
      stderr: installResult.stderr,
      status: await detectAntigravity()
    }
  })

  ipcMain.handle('auth:openCliLogin', async (_event, providerType: string) => {
    if (providerType === 'anthropic') {
      openClaudeLogin()
      return { started: true }
    }
    if (providerType === 'antigravity') {
      openAntigravityLogin()
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

  // Boton "Actualizar modelos" (docs/_arch/verify_model_refresh_design.md):
  // SOLO devuelven candidatos nuevos ya confirmados reales -- el merge
  // "solo agregar" (nunca reemplaza lo existente) lo hace App.tsx. Codex no
  // tiene handler aca -- reusa 'codex:modelList' de arriba, ya existente.
  ipcMain.handle('models:refreshClaude', async (_event, existingModelValues: string[]) =>
    discoverNewClaudeModels(existingModelValues)
  )
  ipcMain.handle('models:refreshAntigravity', async (_event, existingModelValues: string[]) =>
    discoverNewAntigravityModels(existingModelValues)
  )
}
