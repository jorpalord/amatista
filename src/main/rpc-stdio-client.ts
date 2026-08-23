// Framing JSON-RPC compartido sobre stdio de un proceso hijo — antes
// duplicado, campo por campo, entre CodexClient (codex-client.ts) y
// CodexAccountBridge (codex-account-bridge.ts): mismo protocolo de mensajes
// newline-delimited, mismo mapa de request-id -> promesa pendiente, mismo
// parseo de stdout linea por linea, misma limpieza al salir el proceso.
//
// Fase 9: los DOS procesos NO se fusionan — investigacion previa (ver
// docs/_arch/CONTRACT.md) encontro evidencia real de que necesitan seguir
// siendo independientes (ciclos de vida distintos, CODEX_HOME distinto
// segun el caso, uso concurrente real desde la UI). Esto es SOLO la
// extraccion del mecanismo, no una fusion de procesos.
//
// El texto exacto de los mensajes de error difiere entre las dos clases
// originales (wording distinto, con/sin tilde) — se preserva byte a byte
// via los metodos abstractos de mas abajo, no se estandariza un texto
// nuevo: esta fase es cero-cambio-de-comportamiento-observable salvo lo
// que la investigacion de la Tarea 1 decidio explicitamente (nada del
// texto de errores entra en esa decision).
import { ChildProcessWithoutNullStreams } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { createInterface } from 'node:readline'

export type RpcId = number | string

export interface RpcMessage {
  id?: RpcId
  method?: string
  params?: unknown
  result?: unknown
  error?: { code?: number; message?: string; data?: unknown }
}

interface PendingEntry {
  resolve: (value: unknown) => void
  reject: (reason?: unknown) => void
}

export abstract class RpcStdioClient extends EventEmitter {
  protected process: ChildProcessWithoutNullStreams | null = null
  private nextId = 1
  private readonly pending = new Map<RpcId, PendingEntry>()

  /** Texto exacto del error al intentar escribir sin proceso vivo — cada
   *  subclase preserva su wording original. */
  protected abstract notStartedErrorMessage(): string

  /** Texto exacto de fallback cuando un error JSON-RPC no trae `message`. */
  protected abstract rpcErrorFallback(error: NonNullable<RpcMessage['error']>): string

  protected write(message: RpcMessage): void {
    if (!this.process) throw new Error(this.notStartedErrorMessage())
    this.process.stdin.write(`${JSON.stringify(message)}\n`)
  }

  protected request<T = unknown>(method: string, params: unknown = {}): Promise<T> {
    const id = this.nextId++
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: value => resolve(value as T), reject })
      this.write({ id, method, params })
    })
  }

  protected notify(method: string, params: unknown = {}): void {
    this.write({ method, params })
  }

  /**
   * Dispatch comun: un mensaje con `id` sin `method` es la respuesta a un
   * request pendiente, resuelve/rechaza esa promesa. Cualquier mensaje con
   * `method` (con o sin `id`) va a onServerMessage() — por default lo
   * trata como notificacion generica; CodexClient la overridea para
   * distinguir serverRequest (id + method) de notification (solo method).
   */
  protected handleMessage(message: RpcMessage): void {
    if (message.id !== undefined && !message.method) {
      const pending = this.pending.get(message.id)
      if (!pending) return
      this.pending.delete(message.id)
      if (message.error) {
        pending.reject(new Error(message.error.message ?? this.rpcErrorFallback(message.error)))
      } else {
        pending.resolve(message.result)
      }
      return
    }

    if (message.method) this.onServerMessage(message)
  }

  protected onServerMessage(message: RpcMessage): void {
    this.emit('notification', message)
  }

  /** Hook opcional, llamado con CADA mensaje ya parseado antes de
   *  handleMessage — no-op por default. CodexClient lo overridea para
   *  emitir 'raw' (consumido para debug del lado del renderer). */
  protected onRawMessage(_message: RpcMessage): void {}

  /** Texto exacto del error cuando el proceso termina con requests
   *  pendientes — cada subclase preserva su wording original. */
  protected abstract processExitErrorMessage(code: number | null, signal: NodeJS.Signals | null): string

  /** Hook opcional llamado despues de la limpieza de `exit` — no-op por
   *  default. CodexClient lo overridea para emit('exit', {code, signal});
   *  CodexAccountBridge no emitia nada ahi, se mantiene igual. */
  protected onExit(_code: number | null, _signal: NodeJS.Signals | null): void {}

  /**
   * Engancha stdout/stderr/exit de un proceso hijo ya spawneado al framing
   * comun. El llamador sigue siendo responsable de spawnear el proceso
   * (env/cwd/args difieren entre CodexClient y CodexAccountBridge) y de
   * cablear cualquier listener adicional que le sea propio (ej. `error`
   * en CodexClient, que CodexAccountBridge nunca tuvo).
   */
  protected attachProcess(child: ChildProcessWithoutNullStreams): void {
    this.process = child

    const stdout = createInterface({ input: child.stdout })
    stdout.on('line', line => {
      const trimmed = line.trim()
      if (!trimmed) return
      try {
        const parsed = JSON.parse(trimmed) as RpcMessage
        this.onRawMessage(parsed)
        this.handleMessage(parsed)
      } catch {
        this.emit('log', { type: 'stdout', text: trimmed })
      }
    })

    const stderr = createInterface({ input: child.stderr })
    stderr.on('line', line => this.emit('log', { type: 'stderr', text: line }))

    child.on('exit', (code, signal) => {
      const error = new Error(this.processExitErrorMessage(code, signal))
      for (const entry of this.pending.values()) entry.reject(error)
      this.pending.clear()
      this.process = null
      this.onExit(code, signal)
    })
  }

  stop(): void {
    if (!this.process) return
    try { this.process.kill() } catch {}
    this.process = null
  }
}
