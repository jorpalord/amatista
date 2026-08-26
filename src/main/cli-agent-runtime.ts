import { ChildProcessWithoutNullStreams, spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { createInterface } from 'node:readline'
import { formatContextEnvelope } from './context-envelope'
import type { ChatAttachment, ProviderProfile, RuntimeContextEnvelope, SandboxMode } from '../shared/types'

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

interface ParsedDataUrl {
  mimeType: string
  base64: string
}

/**
 * Fase 17 Parte 2: version local minima de parseDataUrl()/
 * anthropicImageBlocks() (api-agent-runtime.ts) -- deliberadamente NO
 * reusada desde ahi. Dos razones concretas, no solo "por las dudas":
 * (1) restriccion explicita de esta fase, no tocar api-agent-runtime.ts
 *     (ya cerrado en Parte 1) -- ninguna de las dos funciones esta
 *     exportada hoy, asi que reusarlas de verdad habria significado abrir
 *     ese archivo solo para agregar un `export`.
 * (2) aunque no hubiera restriccion, son ~10 lineas sin estado ni
 *     dependencias del resto de api-agent-runtime.ts -- duplicarlas es mas
 *     barato que crear un acoplamiento nuevo entre el runtime CLI y el
 *     runtime API (hoy independientes) por una funcion pura tan chica.
 * Mismo shape exacto (Anthropic Messages API) a proposito: claude-cli en
 * modo --input-format stream-json habla literalmente esa API por stdin.
 */
function parseDataUrl(dataUrl: string): ParsedDataUrl | null {
  const match = /^data:([^;,]+)(?:;[^,]*)?,(.*)$/s.exec(dataUrl)
  if (!match || !match[2]) return null
  return { mimeType: match[1] || 'application/octet-stream', base64: match[2] }
}

function claudeImageBlocks(attachments: ChatAttachment[]): unknown[] {
  return attachments
    .map(attachment => {
      const parsed = attachment.preview ? parseDataUrl(attachment.preview) : null
      if (!parsed) return null
      return { type: 'image', source: { type: 'base64', media_type: attachment.mimeType || parsed.mimeType, data: parsed.base64 } }
    })
    .filter(Boolean)
}

/**
 * Adjuntos de imagen del turno ACTUAL (nunca historial -- context.attachments
 * es siempre el turno actual por construccion de RuntimeContextEnvelope,
 * mismo criterio que Parte 1 en api-agent-runtime.ts). Usado tanto por
 * Claude (bifurcacion sendClaude()/sendClaudeWithImages()) como estructura
 * -- Gemini CLI queda fuera de esta fase, sin tocar.
 */
function currentImageAttachments(context?: RuntimeContextEnvelope): ChatAttachment[] {
  return (context?.attachments ?? []).filter(attachment => attachment.kind === 'image' && Boolean(attachment.preview))
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

  /**
   * `effort` (Fase 13) SOLO aplica a Claude — se ignora por completo en
   * `sendGemini()` (nunca se le pasa), no hay evidencia de un flag
   * equivalente soportado en Gemini CLI headless todavia.
   */
  async send(text: string, context?: RuntimeContextEnvelope, effort?: string): Promise<CliAgentResult> {
    if (!this.config) throw new Error('Runtime CLI no configurado.')
    return this.config.kind === 'claude' ? this.sendClaude(text, context, effort) : this.sendGemini(text, context)
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

  private sendClaude(text: string, context?: RuntimeContextEnvelope, effort?: string): Promise<CliAgentResult> {
    if (!this.config) return Promise.reject(new Error('Claude runtime no configurado.'))

    // Fase 17 Parte 2 Tarea 2: bifurcacion condicional (decision tomada y
    // justificada en la investigacion previa a esta fase, ver
    // docs/_arch/CONTRACT.md -- migrar TODO sendClaude() a stream-json
    // arriesgaba una regresion silenciosa en el camino mayoritario para
    // resolver un caso opt-in). Turno SIN imagenes: cero cambio de codigo
    // ejecutado respecto a como estaba antes de esta fase, ver mas abajo.
    const images = currentImageAttachments(context)
    if (images.length > 0) return this.sendClaudeWithImages(text, context, images, effort)

    const prompt = context ? formatContextEnvelope(context) : text

    const args: string[] = [
      '-p', prompt,
      '--output-format', 'json',
      '--max-turns', '20',
      ...this.permissionArgs()
    ]

    if (this.config.model.trim()) args.push('--model', this.config.model.trim())
    if (this.sessionId) args.push('--resume', this.sessionId)
    // Fase 13: --effort confirmado real en modo headless -p (thinking_tokens
    // medible 0 -> 417 entre low/high sobre la misma pregunta, ver
    // docs/_arch/CONTRACT.md). SOLO si el usuario eligio un nivel — cada
    // turno spawnea un proceso `claude` nuevo (ver spawn() mas abajo), asi
    // que no hace falta reconectar para cambiarlo turno a turno.
    if (effort) args.push('--effort', effort)

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

  /**
   * Fase 17 Parte 2 Tarea 2: camino SOLO para turnos con imagenes.
   * --input-format/--output-format stream-json reemplazan -p <texto>/
   * --output-format json UNICAMENTE aca -- max-turns/permissionArgs()/
   * model/resume/effort se preservan identicos a sendClaude(), confirmado
   * contra el transporte real en Tarea 3 (no asumido).
   *
   * Parseo linea por linea (mismo patron readline que ya usa sendGemini()
   * en este archivo) -- NUNCA acumular todo stdout y hacer un JSON.parse
   * unico al final: stream-json emite VARIAS lineas JSON por turno
   * (system/init, rate_limit_event, assistant, system/post_turn_summary,
   * la linea final), asi que ese string acumulado no es JSON valido. La
   * regresion exacta que la investigacion previa identifico: el try/catch
   * viejo la habria absorbido en silencio, devolviendo las lineas crudas
   * como si fueran la respuesta.
   *
   * La linea final se identifica por tener is_error (boolean) -- ninguna
   * de las otras lineas del stream trae ese campo, confirmado con el
   * output real (Tarea 0 extendida). No tiene "type" propio, a diferencia
   * de system/assistant/rate_limit_event.
   */
  private sendClaudeWithImages(
    text: string,
    context: RuntimeContextEnvelope | undefined,
    images: ChatAttachment[],
    effort?: string
  ): Promise<CliAgentResult> {
    if (!this.config) return Promise.reject(new Error('Claude runtime no configurado.'))
    const promptText = context ? formatContextEnvelope(context) : text

    const args: string[] = [
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      // Confirmado en vivo (Tarea 3): --print + --output-format=stream-json
      // exige --verbose o claude rechaza el proceso entero antes de leer
      // stdin ("Error: When using --print, --output-format=stream-json
      // requires --verbose") -- no es opcional para este camino, a
      // diferencia de sendGemini() donde --verbose no hace falta.
      '--verbose',
      '--max-turns', '20',
      ...this.permissionArgs()
    ]
    if (this.config.model.trim()) args.push('--model', this.config.model.trim())
    if (this.sessionId) args.push('--resume', this.sessionId)
    if (effort) args.push('--effort', effort)

    const userMessage = {
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'text', text: promptText }, ...claudeImageBlocks(images)]
      }
    }

    return new Promise<CliAgentResult>((resolve, reject) => {
      const child = spawn(claudeCommand(), args, {
        cwd: this.config!.workspace,
        env: this.buildEnv(),
        windowsHide: true,
        shell: false
      })

      this.activeProcess = child
      const stdout = createInterface({ input: child.stdout })
      let stderr = ''
      let resultRecord: Record<string, unknown> | null = null

      stdout.on('line', line => {
        const trimmed = line.trim()
        if (!trimmed) return
        try {
          const parsed = JSON.parse(trimmed)
          const record = asRecord(parsed)
          if (typeof record.is_error === 'boolean') resultRecord = record
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

      // Defensivo (encontrado en vivo antes del fix de --verbose de arriba):
      // si el proceso rechaza el input y cierra stdin del otro lado antes de
      // que termine el write, node emite un 'error' propio en el socket de
      // stdin que NO pasa por child.on('error', ...) -- sin este handler,
      // ese evento sin listener tira el proceso entero de Amatista abajo
      // (unhandled 'error' event). child.on('exit', ...) igual corre y
      // rechaza con el stderr real.
      child.stdin.on('error', () => {})

      child.stdin.write(JSON.stringify(userMessage) + '\n')
      child.stdin.end()

      child.on('exit', code => {
        this.activeProcess = null
        if (code !== 0) {
          reject(new Error(stderr.trim() || `Claude terminó con código ${String(code)}.`))
          return
        }

        if (!resultRecord) {
          resolve({ text: stderr.trim() || 'Claude completó el turno sin resultado final.' })
          return
        }

        if (resultRecord.is_error === true) {
          reject(new Error(firstString(resultRecord, ['result', 'response', 'text']) || 'Claude devolvió un error.'))
          return
        }

        const resultText = firstString(resultRecord, ['result', 'response', 'text']) ?? ''
        const sessionId = firstString(resultRecord, ['session_id', 'sessionId'])
        if (sessionId) this.sessionId = sessionId
        resolve({ text: resultText, sessionId, raw: resultRecord })
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
