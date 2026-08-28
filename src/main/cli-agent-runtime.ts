import { ChildProcessWithoutNullStreams, spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { createInterface } from 'node:readline'
import { formatContextEnvelope } from './context-envelope'
import type { ProviderProfile, RuntimeContextEnvelope, SandboxMode } from '../shared/types'

// Limpieza de claude-cli: esta clase manejaba Claude Y Gemini con un
// parametro `kind: 'claude' | 'gemini'` -- ahora que Claude se fue, se
// mantiene la forma general (clase + `kind`) en vez de aplanarla a algo
// tipo "GeminiCliRuntime" sin parametro. Motivo real, no especulativo:
// buildEnv()/permissionArgs() YA tenian una rama por `kind` desde antes de
// esta limpieza (no es una abstraccion nueva agregada "por las dudas") --
// sacar el parametro implicaria reescribir esas dos funciones para asumir
// Gemini a secas, y volver a agregarlo si algun dia vuelve un tercer CLI
// seria mas trabajo que dejarlo. El costo de dejarlo es minimo (un
// `kind: 'gemini'` fijo en un solo lugar, `ConfigureOptions`); el costo de
// sacarlo y tener que reintroducirlo despues es mayor.
export type CliAgentKind = 'gemini'

interface ConfigureOptions {
  kind: CliAgentKind
  provider: ProviderProfile
  model: string
  workspace: string
  sandbox: SandboxMode
}

export interface CliAgentResult {
  text: string
  sessionId?: string
  raw?: unknown
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : {}
}

function firstString(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string' && value.trim()) return value
  }
  return undefined
}

export class CliAgentRuntime extends EventEmitter {
  private config: ConfigureOptions | null = null
  private sessionId?: string
  private activeProcess: ChildProcessWithoutNullStreams | null = null

  configure(options: ConfigureOptions): void {
    this.stop()
    this.config = options
    this.sessionId = undefined
  }

  async send(text: string, context?: RuntimeContextEnvelope): Promise<CliAgentResult> {
    if (!this.config) throw new Error('Runtime CLI no configurado.')
    return this.sendGemini(text, context)
  }

  private buildEnv(): NodeJS.ProcessEnv {
    if (!this.config) throw new Error('Runtime CLI no configurado.')
    const env: NodeJS.ProcessEnv = { ...process.env }
    const provider = this.config.provider

    if (provider.authMode === 'subscription') {
      delete env.GEMINI_API_KEY
      delete env.GOOGLE_API_KEY
    } else {
      if (!provider.apiKey?.trim()) throw new Error('Gemini API requiere API key.')
      env.GEMINI_API_KEY = provider.apiKey.trim()
      if (provider.endpoint?.trim()) env.GOOGLE_GEMINI_BASE_URL = provider.endpoint.trim()
    }

    return env
  }

  private permissionArgs(): string[] {
    if (!this.config) return []
    if (this.config.sandbox === 'read-only') return ['--approval-mode', 'plan']
    if (this.config.sandbox === 'danger-full-access') return ['--approval-mode', 'yolo']
    return ['--approval-mode', 'auto_edit']
  }

  private sendGemini(text: string, context?: RuntimeContextEnvelope): Promise<CliAgentResult> {
    if (!this.config) return Promise.reject(new Error('Gemini runtime no configurado.'))
    const prompt = context ? formatContextEnvelope(context) : text

    const args: string[] = ['-p', prompt, '--output-format', 'stream-json', ...this.permissionArgs()]
    if (this.config.model.trim()) args.push('--model', this.config.model.trim())
    if (this.sessionId) args.push('--resume', this.sessionId)

    return new Promise<CliAgentResult>((resolve, reject) => {
      const child = spawn('gemini', args, {
        cwd: this.config!.workspace,
        env: this.buildEnv(),
        windowsHide: true,
        shell: process.platform === 'win32'
      })

      this.activeProcess = child
      const stdout = createInterface({ input: child.stdout })
      let finalText = ''
      let stderr = ''
      let lastRaw: unknown

      stdout.on('line', line => {
        const trimmed = line.trim()
        if (!trimmed) return

        try {
          const parsed = JSON.parse(trimmed)
          lastRaw = parsed
          const record = asRecord(parsed)
          const type = firstString(record, ['type'])

          if (type === 'init') {
            const sessionId = firstString(record, ['session_id', 'sessionId'])
            if (sessionId) this.sessionId = sessionId
            return
          }

          if (type === 'message' && firstString(record, ['role']) === 'assistant') {
            const content = firstString(record, ['content', 'text', 'message'])
            if (content) finalText += content
            return
          }

          if (type === 'result' && !finalText) {
            const result = firstString(record, ['response', 'result', 'text'])
            if (result) finalText = result
          }
        } catch {
          this.emit('log', { type: 'stdout', text: trimmed })
        }
      })

      child.stderr.on('data', chunk => {
        const value = chunk.toString()
        stderr += value
        this.emit('log', { type: 'stderr', text: value })
      })

      child.on('error', error => {
        this.activeProcess = null
        reject(error)
      })

      child.on('exit', code => {
        this.activeProcess = null
        if (code !== 0) {
          reject(new Error(stderr.trim() || `Gemini terminó con código ${String(code)}.`))
          return
        }
        resolve({
          text: finalText.trim() || 'Gemini completó el turno sin texto final.',
          sessionId: this.sessionId,
          raw: lastRaw
        })
      })
    })
  }

  stop(): void {
    if (this.activeProcess) {
      try { this.activeProcess.kill() } catch {}
    }
    this.activeProcess = null
    this.sessionId = undefined
  }
}
