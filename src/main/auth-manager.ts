import { spawn } from 'node:child_process'

function launchInteractive(command: string): void {
  if (process.platform === 'win32') {
    const child = spawn('cmd.exe', ['/c', 'start', '', 'cmd.exe', '/k', command], {
      detached: true,
      stdio: 'ignore',
      windowsHide: false
    })
    child.unref()
    return
  }

  if (process.platform === 'darwin') {
    const child = spawn('open', ['-a', 'Terminal', command], { detached: true, stdio: 'ignore' })
    child.unref()
    return
  }

  const child = spawn('x-terminal-emulator', ['-e', command], { detached: true, stdio: 'ignore' })
  child.unref()
}

export function openClaudeLogin(): void { launchInteractive('claude') }
export function openGeminiLogin(): void { launchInteractive('gemini') }
// Integracion de Antigravity CLI: primer login real (sesion de cuenta
// Google, keyring del SO) requiere una corrida interactiva -- confirmado en
// la documentacion oficial ("By default headless mode uses cached
// credentials, so sign in once from an interactive agy session on that
// machine first"). Mismo patron exacto que Claude/Gemini: abre una terminal
// real con `agy` corriendo interactivo, el usuario completa el login ahi.
export function openAntigravityLogin(): void { launchInteractive('agy') }
