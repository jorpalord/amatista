import { ChildProcessWithoutNullStreams, spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { createInterface } from 'node:readline'
import { formatContextEnvelope } from './context-envelope'
import type { ProviderProfile, RuntimeContextEnvelope, SandboxMode } from '../shared/types'

export type CliAgentKind = 'claude' | 'gemini'

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

function claudeCommand(): string {
  if (process.platform !== 'win32') return 'claude'

  const appData = process.env.APPDATA
  if (appData) {
    const exe = path.join(appData, 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe')
    if (existsSync(exe)) return exe
  }

  return 'claude'
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
    return this.config.kind === 'claude' ? this.sendClaude(text, context) : this.sendGemini(text, context)
  }

  private buildEnv(): NodeJS.ProcessEnv {
    if (!this.config) throw new Error('Runtime CLI no configurado.')
    const env: NodeJS.ProcessEnv = { ...process.env }
    const provider = this.config.provider

    if (this.config.kind === 'claude') {
      if (provider.authMode === 'subscription') {
        delete env.ANTHROPIC_API_KEY
        delete env.ANTHROPIC_AUTH_TOKEN
      } else {
        if (!provider.apiKey?.trim()) throw new Error('Anthropic API requiere API key.')
        env.ANTHROPIC_API_KEY = provider.apiKey.trim()
        if (provider.endpoint?.trim()) env.ANTHROPIC_BASE_URL = provider.endpoint.trim()
      }
    }

    if (this.config.kind === 'gemini') {
      if (provider.authMode === 'subscription') {
        delete env.GEMINI_API_KEY
        delete env.GOOGLE_API_KEY
      } else {
        if (!provider.apiKey?.trim()) throw new Error('Gemini API requiere API key.')
        env.GEMINI_API_KEY = provider.apiKey.trim()
        if (provider.endpoint?.trim()) env.GOOGLE_GEMINI_BASE_URL = provider.endpoint.trim()
      }
    }

    return env
  }

  private permissionArgs(): string[] {
    if (!this.config) return []

    if (this.config.kind === 'claude') {
      if (this.config.sandbox === 'read-only') return ['--permission-mode', 'plan']
      if (this.config.sandbox === 'danger-full-access') return ['--dangerously-skip-permissions']
      return ['--permission-mode', 'acceptEdits']
    }

    if (this.config.sandbox === 'read-only') return ['--approval-mode', 'plan']
    if (this.config.sandbox === 'danger-full-access') return ['--approval-mode', 'yolo']
    return ['--approval-mode', 'auto_edit']
  }

  private sendClaude(text: string, context?: RuntimeContextEnvelope): Promise<CliAgentResult> {
    if (!this.config) return Promise.reject(new Error('Claude runtime no configurado.'))
    const prompt = context ? formatContextEnvelope(context) : text

    const args: string[] = [
      '-p', prompt,
      '--output-format', 'json',
      '--max-turns', '20',
      ...this.permissionArgs()
    ]

    if (this.config.model.trim()) args.push('--model', this.config.model.trim())
    if (this.sessionId) args.push('--resume', this.sessionId)

    return new Promise<CliAgentResult>((resolve, reject) => {
      const child = spawn(claudeCommand(), args, {
        cwd: this.config!.workspace,
        env: this.buildEnv(),
        windowsHide: true,
        shell: false
      })

      this.activeProcess = child
      let stdout = ''
      let stderr = ''

      child.stdout.on('data', chunk => { stdout += chunk.toString() })
      child.stderr.on('data', chunk => {
        const value = chunk.toString()
        stderr += value
        this.emit('log', { type: 'stderr', text: value })
      })

      child.on('error', error => {
        this.activeProcess = null
        reject(error)
      })

      child.stdin.end()

      child.on('exit', code => {
        this.activeProcess = null
        if (code !== 0) {
          reject(new Error(stderr.trim() || `Claude terminó con código ${String(code)}.`))
          return
        }

        try {
          const parsed = JSON.parse(stdout)
          const record = asRecord(parsed)
          const result = firstString(record, ['result', 'response', 'text']) ?? stdout.trim()
          const sessionId = firstString(record, ['session_id', 'sessionId'])
          if (sessionId) this.sessionId = sessionId
          resolve({ text: result, sessionId, raw: parsed })
        } catch {
          resolve({ text: stdout.trim() })
        }
      })
    })
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
