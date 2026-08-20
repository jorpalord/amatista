import { ChildProcessWithoutNullStreams, spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { createInterface } from 'node:readline'
import { formatContextEnvelope } from './context-envelope'
import type { ProviderProfile, RuntimeContextEnvelope, SandboxMode } from '../shared/types'

type RpcId = number | string

interface RpcMessage {
  id?: RpcId
  method?: string
  params?: unknown
  result?: unknown
  error?: { code?: number; message?: string; data?: unknown }
}

export interface StartCodexOptions {
  provider: ProviderProfile
  model: string
  workspace: string
  codexHome: string
  sandbox: SandboxMode
}

export interface SendTurnOptions {
  threadId: string
  text: string
  model: string
  workspace: string
  context?: RuntimeContextEnvelope
}

export class CodexClient extends EventEmitter {
  private process: ChildProcessWithoutNullStreams | null = null
  private nextId = 1
  private readonly pending = new Map<RpcId, {
    resolve: (value: unknown) => void
    reject: (reason?: unknown) => void
  }>()

  private write(message: RpcMessage): void {
    if (!this.process) throw new Error('Codex app-server no esta iniciado.')
    this.process.stdin.write(`${JSON.stringify(message)}\n`)
  }

  private request<T = unknown>(method: string, params: unknown = {}): Promise<T> {
    const id = this.nextId++
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: value => resolve(value as T), reject })
      this.write({ id, method, params })
    })
  }

  private notify(method: string, params: unknown = {}): void {
    this.write({ method, params })
  }

  private handleMessage(message: RpcMessage): void {
    if (message.id !== undefined && !message.method) {
      const pending = this.pending.get(message.id)
      if (!pending) return
      this.pending.delete(message.id)
      if (message.error) {
        pending.reject(new Error(message.error.message ?? `Error JSON-RPC: ${JSON.stringify(message.error)}`))
      } else {
        pending.resolve(message.result)
      }
      return
    }

    if (message.id !== undefined && message.method) {
      this.emit('serverRequest', message)
      return
    }

    if (message.method) this.emit('notification', message)
  }

  async start(options: StartCodexOptions): Promise<{ id: string; [key: string]: unknown }> {
    this.stop()
    const provider = options.provider
    const env: NodeJS.ProcessEnv = { ...process.env }

    if (provider.type === 'openai-codex' && provider.authMode === 'subscription') {
      delete env.OPENAI_API_KEY
    } else {
      const apiKey = provider.apiKey?.trim()
      if (!apiKey) throw new Error(`${provider.name} no tiene API key configurada.`)
      env.CODEX_HOME = options.codexHome
      env.OPENAI_API_KEY = apiKey
    }

    this.process = spawn('codex', ['app-server', '--stdio'], {
      cwd: options.workspace,
      env,
      windowsHide: true,
      shell: process.platform === 'win32'
    })

    const stdout = createInterface({ input: this.process.stdout })
    stdout.on('line', line => {
      const trimmed = line.trim()
      if (!trimmed) return
      try {
        const parsed = JSON.parse(trimmed) as RpcMessage
        this.emit('raw', parsed)
        this.handleMessage(parsed)
      } catch {
        this.emit('log', { type: 'stdout', text: trimmed })
      }
    })

    const stderr = createInterface({ input: this.process.stderr })
    stderr.on('line', line => this.emit('log', { type: 'stderr', text: line }))
    this.process.on('error', error => this.emit('log', { type: 'stderr', text: error.message }))
    this.process.on('exit', (code, signal) => {
      const error = new Error(`codex app-server termino. code=${String(code)}, signal=${String(signal)}`)
      for (const pending of this.pending.values()) pending.reject(error)
      this.pending.clear()
      this.process = null
      this.emit('exit', { code, signal })
    })

    await this.request('initialize', {
      clientInfo: {
        name: 'amatista',
        title: 'AMATISTA',
        version: __APP_VERSION__
      },
      capabilities: { experimentalApi: true }
    })

    this.notify('initialized')

    const result = await this.request<{ thread: { id: string; [key: string]: unknown } }>(
      'thread/start',
      {
        model: options.model,
        cwd: options.workspace,
        sandbox: options.sandbox,
        approvalPolicy: 'on-request'
      }
    )

    return result.thread
  }

  async sendTurn(options: SendTurnOptions): Promise<unknown> {
    const text = options.context ? formatContextEnvelope(options.context) : options.text
    return this.request('turn/start', {
      threadId: options.threadId,
      input: [{ type: 'text', text }],
      cwd: options.workspace,
      model: options.model,
      approvalPolicy: 'on-request'
    })
  }

  respondToServerRequest(requestId: RpcId, result: unknown): void {
    this.write({ id: requestId, result })
  }

  stop(): void {
    if (!this.process) return
    try { this.process.kill() } catch {}
    this.process = null
  }
}
