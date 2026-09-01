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
