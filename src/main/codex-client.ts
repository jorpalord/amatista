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
  /** Fase 13: campo real confirmado contra el schema oficial del
   *  protocolo (`codex app-server generate-json-schema`) — vive en
   *  TurnStartParams como "effort" (NO "reasoningEffort"/"reasoning_effort",
   *  y NO existe en ThreadStartParams / thread/start: es una propiedad
   *  POR TURNO, no de la conexion). undefined = omitido del payload por
   *  completo, no un null explicito — deja que Codex use su propio
   *  default (model_reasoning_effort de config.toml o el default del
   *  modelo), mismo criterio que maxOutputTokens en Fase 6. */
  effort?: string
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
    // Fase 17 Parte 2 Tarea 1: adjuntos de imagen del turno ACTUAL (nunca
    // historial -- options.context.attachments es siempre el turno actual
    // por construccion de RuntimeContextEnvelope, mismo criterio que Parte
    // 1 en api-agent-runtime.ts). Shape ImageUserInput{type:'image', url}
    // confirmado en vivo contra el transporte real (Tarea 0 extendida,
    // logoamatista.png real): acepta un data URI base64 directo sin tocar
    // filesystem -- attachment.preview YA es ese data URI completo (mismo
    // campo que usan los 4 runtimes API desde Parte 1), se manda tal cual.
    const imageAttachments = (options.context?.attachments ?? []).filter(
      attachment => attachment.kind === 'image' && Boolean(attachment.preview)
    )
    return this.request('turn/start', {
      threadId: options.threadId,
      input: [
        { type: 'text', text },
        ...imageAttachments.map(attachment => ({ type: 'image', url: attachment.preview }))
      ],
      cwd: options.workspace,
      model: options.model,
      approvalPolicy: 'on-request',
      // Fase 13: solo se incluye la clave si hay un valor -- omitida por
      // completo (no "effort: undefined", que igual JSON.stringify
      // dropea, pero explicito aca para que quede claro que es
      // intencional) cuando el usuario no eligio nivel.
      ...(options.effort ? { effort: options.effort } : {})
    })
  }

  respondToServerRequest(requestId: RpcId, result: unknown): void {
    this.write({ id: requestId, result })
  }
}
