import {
  ChildProcessWithoutNullStreams,
  spawn
} from 'node:child_process'
import { EventEmitter } from 'node:events'
import { createInterface } from 'node:readline'

type RpcId = number | string

interface RpcMessage {
  id?: RpcId
  method?: string
  params?: unknown
  result?: unknown
  error?: {
    code?: number
    message?: string
    data?: unknown
  }
}

export interface CodexCatalogModel {
  id: string
  displayName: string
  supportedReasoningEfforts: string[]
  raw: unknown
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null
    ? value as Record<string, unknown>
    : {}
}

function firstString(
  record: Record<string, unknown>,
  keys: string[]
): string | undefined {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string' && value.trim()) {
      return value
    }
  }

  return undefined
}

export class CodexAccountBridge extends EventEmitter {
  private process: ChildProcessWithoutNullStreams | null = null
  private nextId = 1

  private readonly pending = new Map<
    RpcId,
    {
      resolve: (value: unknown) => void
      reject: (reason?: unknown) => void
    }
  >()

  private write(message: RpcMessage): void {
    if (!this.process) {
      throw new Error('Codex account bridge no está iniciado.')
    }

    this.process.stdin.write(`${JSON.stringify(message)}\n`)
  }

  private request<T = unknown>(
    method: string,
    params: unknown = {}
  ): Promise<T> {
    const id = this.nextId++

    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: value => resolve(value as T),
        reject
      })

      this.write({
        id,
        method,
        params
      })
    })
  }

  private notify(
    method: string,
    params: unknown = {}
  ): void {
    this.write({
      method,
      params
    })
  }

  private handleMessage(message: RpcMessage): void {
    if (message.id !== undefined && !message.method) {
      const pending = this.pending.get(message.id)
      if (!pending) return

      this.pending.delete(message.id)

      if (message.error) {
        pending.reject(
          new Error(
            message.error.message ??
              `Codex JSON-RPC error: ${JSON.stringify(message.error)}`
          )
        )
      } else {
        pending.resolve(message.result)
      }

      return
    }

    if (message.method) {
      this.emit('notification', message)
    }
  }

  async ensureStarted(): Promise<void> {
    if (this.process) return

    this.process = spawn(
      'codex',
      ['app-server', '--stdio'],
      {
        env: {
          ...process.env
          // IMPORTANT:
          // No CODEX_HOME override here.
          // This bridge intentionally uses the user's official Codex session.
        },
        windowsHide: true,
        shell: process.platform === 'win32'
      }
    )

    const stdout = createInterface({
      input: this.process.stdout
    })

    stdout.on('line', line => {
      const trimmed = line.trim()
      if (!trimmed) return

      try {
        this.handleMessage(
          JSON.parse(trimmed) as RpcMessage
        )
      } catch {
        this.emit('log', {
          type: 'stdout',
          text: trimmed
        })
      }
    })

    const stderr = createInterface({
      input: this.process.stderr
    })

    stderr.on('line', line => {
      this.emit('log', {
        type: 'stderr',
        text: line
      })
    })

    this.process.on('exit', (code, signal) => {
      const error = new Error(
        `Codex account app-server terminó. code=${String(code)}, signal=${String(signal)}`
      )

      for (const pending of this.pending.values()) {
        pending.reject(error)
      }

      this.pending.clear()
      this.process = null
    })

    await this.request('initialize', {
      clientInfo: {
        name: 'amatista',
        title: 'AMATISTA',
        version: __APP_VERSION__
      },
      capabilities: {
        experimentalApi: true
      }
    })

    this.notify('initialized')
  }

  async readAccount(): Promise<unknown> {
    await this.ensureStarted()

    return this.request(
      'account/read',
      {
        refreshToken: false
      }
    )
  }

  async startChatGPTLogin(): Promise<{
    loginId?: string
    authUrl?: string
    type?: string
  }> {
    await this.ensureStarted()

    return this.request(
      'account/login/start',
      {
        type: 'chatgpt',
        useHostedLoginSuccessPage: true,
        appBrand: 'codex'
      }
    )
  }

  async logout(): Promise<void> {
    await this.ensureStarted()
    await this.request('account/logout', {})
  }

  async listModels(): Promise<CodexCatalogModel[]> {
    await this.ensureStarted()

    const result = await this.request<unknown>(
      'model/list',
      {
        includeHidden: false
      }
    )

    const record = asRecord(result)

    const possibleArrays = [
      record.data,
      record.models,
      result
    ]

    const data = possibleArrays.find(Array.isArray)

    if (!Array.isArray(data)) {
      return []
    }

    return data
      .map(item => {
        const model = asRecord(item)

        const id = firstString(
          model,
          [
            'id',
            'model',
            'slug',
            'name'
          ]
        )

        if (!id) {
          return null
        }

        const displayName =
          firstString(
            model,
            [
              'displayName',
              'display_name',
              'name',
              'label'
            ]
          ) ?? id

        const effortsValue =
          model.supportedReasoningEfforts ??
          model.supported_reasoning_efforts

        const supportedReasoningEfforts =
          Array.isArray(effortsValue)
            ? effortsValue
                .map(value => {
                  if (typeof value === 'string') {
                    return value
                  }

                  const effort = asRecord(value)

                  return firstString(
                    effort,
                    [
                      'reasoningEffort',
                      'reasoning_effort',
                      'effort',
                      'value',
                      'id'
                    ]
                  )
                })
                .filter(
                  (value): value is string =>
                    typeof value === 'string'
                )
            : []

        return {
          id,
          displayName,
          supportedReasoningEfforts,
          raw: item
        }
      })
      .filter(
        (item): item is CodexCatalogModel =>
          item !== null
      )
  }

  stop(): void {
    if (!this.process) return

    try {
      this.process.kill()
    } catch {
      // already stopped
    }

    this.process = null
  }
}
