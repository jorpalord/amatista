import { spawn } from 'node:child_process'
import { RpcStdioClient, type RpcMessage } from './rpc-stdio-client'

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

export class CodexAccountBridge extends RpcStdioClient {
  protected notStartedErrorMessage(): string {
    return 'Codex account bridge no está iniciado.'
  }

  protected rpcErrorFallback(error: NonNullable<RpcMessage['error']>): string {
    return `Codex JSON-RPC error: ${JSON.stringify(error)}`
  }

  protected processExitErrorMessage(code: number | null, signal: NodeJS.Signals | null): string {
    return `Codex account app-server terminó. code=${String(code)}, signal=${String(signal)}`
  }

  async ensureStarted(): Promise<void> {
    if (this.process) return

    const child = spawn(
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

    this.attachProcess(child)

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
}
