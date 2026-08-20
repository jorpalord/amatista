import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { CliStatus } from '../shared/types'

const execFileAsync = promisify(execFile)

async function versionOf(command: string): Promise<CliStatus> {
  try {
    const result = await execFileAsync(command, ['--version'], {
      windowsHide: true,
      timeout: 12000,
      shell: process.platform === 'win32'
    })
    const version = (result.stdout || result.stderr || '').trim()
    return { installed: true, version, detail: `${command} disponible.` }
  } catch (error) {
    return { installed: false, authenticated: false, detail: `${command} no encontrado: ${String(error)}` }
  }
}

export function detectCodex(): Promise<CliStatus> { return versionOf('codex') }
export function detectClaude(): Promise<CliStatus> { return versionOf('claude') }
export function detectGemini(): Promise<CliStatus> { return versionOf('gemini') }
