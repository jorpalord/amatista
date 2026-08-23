import { spawn } from 'node:child_process'
import { formatContextEnvelope } from './context-envelope'
import { RpcStdioClient, type RpcId, type RpcMessage } from './rpc-stdio-client'
import type { ProviderProfile, RuntimeContextEnvelope, SandboxMode } from '../shared/types'

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

export class CodexClient extends RpcStdioClient {
  protected notStartedErrorMessage(): string {
    return 'Codex app-server no esta iniciado.'
  }

  protected rpcErrorFallback(error: NonNullable<RpcMessage['error']>): string {
    return `Error JSON-RPC: ${JSON.stringify(error)}`
  }

  protected processExitErrorMessage(code: number | null, signal: NodeJS.Signals | null): string {
    return `codex app-server termino. code=${String(code)}, signal=${String(signal)}`
  }

  protected onRawMessage(message: RpcMessage): void {
    this.emit('raw', message)
  }

  protected onServerMessage(message: RpcMessage): void {
    if (message.id !== undefined && message.method) {
      this.emit('serverRequest', message)
      return
    }
    if (message.method) this.emit('notification', message)
  }

  protected onExit(code: number | null, signal: NodeJS.Signals | null): void {
    this.emit('exit', { code, signal })
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

    const child = spawn('codex', ['app-server', '--stdio'], {
      cwd: options.workspace,
      env,
      windowsHide: true,
      shell: process.platform === 'win32'
    })

    this.attachProcess(child)
    child.on('error', error => this.emit('log', { type: 'stderr', text: error.message }))

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
}
