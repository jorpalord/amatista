// Fase 20: cliente LSP real para typescript-language-server (diagnosticos
// de TypeScript en vivo). Investigacion previa (docs/_arch/CONTRACT.md)
// confirmo contra el proceso real: framing Content-Length (LspFramer),
// handshake initialize/initialized con capabilities minimas de
// diagnostics, servidor PUSH-only (sin pull-diagnostics: la unica senal es
// la notificacion textDocument/publishDiagnostics), shutdown+exit real
// como cierre limpio, URIs de Windows que NO matchean por string contra
// pathToFileURL() (hay que decodificar y comparar paths normalizados), y
// latencia real medida (~2.7-3.7s fria / ~442ms caliente).
import { app } from 'electron'
import { type ChildProcess, spawn } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'
import { LspFramer, encodeLspMessage } from './lsp-framer'

export interface LspDiagnostic {
  message: string
  /** 1-indexado (el servidor lo manda 0-indexado, LSP spec) -- convertido
   *  aca para que coincida con como un humano/modelo lee un numero de
   *  linea real, mismo criterio que usa el compilador de TS por CLI. */
  line: number
  column: number
  severity: number
  code?: string | number
  source?: string
}

interface FileDiagnosticsEntry {
  diagnostics: LspDiagnostic[]
  updatedAt: number
}

/**
 * Fase 20: alcance deliberado, NO automatico -- solo .ts/.tsx. typescript-
 * language-server tambien sirve .js/.jsx (via allowJs), pero sumarlos no
 * se decidio en esta fase: extender esta lista es la unica accion
 * necesaria si se quiere despues, documentado aca para que sea explicito
 * y no una omision silenciosa.
 */
const LSP_SUPPORTED_EXTENSIONS = new Set(['.ts', '.tsx'])

export function isLspSupportedFile(filePath: string): boolean {
  return LSP_SUPPORTED_EXTENSIONS.has(path.extname(filePath).toLowerCase())
}

function languageIdFor(filePath: string): string {
  return path.extname(filePath).toLowerCase() === '.tsx' ? 'typescriptreact' : 'typescript'
}

/** Fase 20: clave de correlacion path<->diagnosticos -- SIEMPRE decodificar
 *  el URI real y comparar paths normalizados (resolve + lowercase en
 *  Windows), NUNCA comparar el string del URI tal cual. Confirmado en vivo:
 *  el URI que devuelve el servidor (file:///c%3A/...) no matchea por
 *  string contra pathToFileURL() de Node (file:///C:/...) pese a ser el
 *  mismo archivo real. */
function normalizePathKey(absolutePath: string): string {
  const resolved = path.resolve(absolutePath)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

function uriToPathKey(uri: string): string | null {
  try {
    return normalizePathKey(fileURLToPath(uri))
  } catch {
    return null
  }
}

/**
 * Resuelve el entry point real de typescript-language-server (lib/cli.mjs)
 * dentro del propio node_modules de Amatista -- NO es un CLI global que el
 * usuario instala (a diferencia de claude/codex/gemini): es infraestructura
 * bundleada de la app (ver docs/_arch/CONTRACT.md). En produccion, asar
 * empaqueta el codigo de la app en app.asar, pero un binario/servidor que
 * hay que SPAWNEAR como proceso real no puede vivir dentro del asar (no es
 * un path de filesystem real) -- electron-builder.asarUnpack copia
 * typescript-language-server/ y typescript/ afuera, a
 * app.asar.unpacked/node_modules/, y este helper arma el path correcto en
 * ambos casos (dev sin asar, produccion con asar+unpack).
 */
function resolveLanguageServerEntry(): string {
  const appPath = app.getAppPath()
  const base = appPath.includes('app.asar') ? appPath.replace('app.asar', 'app.asar.unpacked') : appPath
  return path.join(base, 'node_modules', 'typescript-language-server', 'lib', 'cli.mjs')
}

export class LspClient {
  private child: ChildProcess | null = null
  private framer = new LspFramer()
  private nextId = 1
  private pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: unknown) => void }>()
  private diagnostics = new Map<string, FileDiagnosticsEntry>()
  /** version por documento abierto -- clave = normalizePathKey(). Presencia
   *  en este Map = "ya se mando didOpen para este archivo en esta sesion",
   *  decide si el proximo touch manda didOpen (primera vez) o didChange
   *  (ya abierto). */
  private openVersions = new Map<string, number>()
  /** Timestamp del ultimo didOpen/didChange mandado por archivo -- get_diagnostics
   *  lo usa como "desde cuando" para decidir si el diagnostico en cache ya
   *  esta fresco o todavia corresponde a una version vieja del archivo. */
  private lastEditAt = new Map<string, number>()
  private starting: Promise<void> | null = null

  /** Arranca el proceso real y hace el handshake completo (initialize +
   *  initialized). Idempotente: si ya esta arrancando o arrancado, no
   *  vuelve a spawnear nada. */
  start(workspace: string): Promise<void> {
    if (this.child) return Promise.resolve()
    if (this.starting) return this.starting

    this.starting = (async () => {
      const entry = resolveLanguageServerEntry()
      const child = spawn(process.execPath, [entry, '--stdio'], {
        cwd: workspace,
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        windowsHide: true,
        shell: false
      })
      this.child = child

      child.stdout?.on('data', chunk => this.handleChunk(chunk))
      child.stderr?.on('data', () => {
        // stderr del language server: diagnostico interno del propio
        // proceso (no de TypeScript), se ignora a proposito -- no es un
        // canal de datos del protocolo LSP, y no hay UI hoy para logs
        // separados de este subproceso especifico.
      })
      child.on('exit', () => {
        this.child = null
      })

      const workspaceUri = pathToFileURL(workspace).href
      await this.request('initialize', {
        processId: process.pid,
        rootUri: workspaceUri,
        workspaceFolders: [{ uri: workspaceUri, name: path.basename(workspace) }],
        // Fase 20 Tarea 3: capabilities MINIMAS -- solo lo que hace falta
        // para recibir publishDiagnostics. Nada de completion/hover/etc,
        // decision explicita de esta fase (alcance: diagnosticos, no un
        // LSP client completo).
        capabilities: {
          textDocument: {
            publishDiagnostics: { relatedInformation: true }
          }
        }
      })
      this.notify('initialized', {})
    })()

    return this.starting.finally(() => {
      this.starting = null
    })
  }

  private handleChunk(chunk: Buffer): void {
    const messages = this.framer.feed(chunk)
    for (const raw of messages) {
      const msg = raw as { id?: number; method?: string; params?: unknown; result?: unknown; error?: unknown }
      if (msg.id !== undefined && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id)!
        this.pending.delete(msg.id)
        if (msg.error) reject(msg.error)
        else resolve(msg.result)
        continue
      }
      if (msg.method === 'textDocument/publishDiagnostics') {
        this.onPublishDiagnostics(msg.params)
      }
      // Otras notificaciones del servidor (window/logMessage, etc.) se
      // ignoran a proposito -- fuera del alcance de esta fase (solo
      // diagnosticos).
    }
  }

  private onPublishDiagnostics(params: unknown): void {
    const record = (typeof params === 'object' && params !== null ? params : {}) as { uri?: string; diagnostics?: unknown[] }
    if (typeof record.uri !== 'string') return
    const key = uriToPathKey(record.uri)
    if (!key) return

    const list = Array.isArray(record.diagnostics) ? record.diagnostics : []
    const parsed: LspDiagnostic[] = list.map(item => {
      const d = item as {
        message?: string
        range?: { start?: { line?: number; character?: number } }
        severity?: number
        code?: string | number
        source?: string
      }
      return {
        message: typeof d.message === 'string' ? d.message : '(sin mensaje)',
        line: (d.range?.start?.line ?? 0) + 1,
        column: (d.range?.start?.character ?? 0) + 1,
        severity: typeof d.severity === 'number' ? d.severity : 1,
        code: d.code,
        source: d.source
      }
    })

    this.diagnostics.set(key, { diagnostics: parsed, updatedAt: Date.now() })
  }

  private request(method: string, params: unknown, timeoutMs = 20000): Promise<unknown> {
    const child = this.child
    if (!child?.stdin) return Promise.reject(new Error('Language server no esta corriendo.'))
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      child.stdin!.write(encodeLspMessage({ jsonrpc: '2.0', id, method, params }))
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id)
          reject(new Error(`Timeout esperando respuesta de ${method}.`))
        }
      }, timeoutMs)
    })
  }

  private notify(method: string, params: unknown): void {
    this.child?.stdin?.write(encodeLspMessage({ jsonrpc: '2.0', method, params }))
  }

  /** Notifica al language server que un archivo tiene contenido nuevo --
   *  didOpen la primera vez que se toca en la sesion, didChange despues
   *  (version incremental). Asume que start() ya se llamo antes (lo
   *  garantiza LspManager). */
  notifyFileChanged(absolutePath: string, content: string): void {
    const key = normalizePathKey(absolutePath)
    const uri = pathToFileURL(absolutePath).href
    this.lastEditAt.set(key, Date.now())

    const existingVersion = this.openVersions.get(key)
    if (existingVersion === undefined) {
      this.openVersions.set(key, 1)
      this.notify('textDocument/didOpen', {
        textDocument: { uri, languageId: languageIdFor(absolutePath), version: 1, text: content }
      })
    } else {
      const version = existingVersion + 1
      this.openVersions.set(key, version)
      this.notify('textDocument/didChange', {
        textDocument: { uri, version },
        contentChanges: [{ text: content }]
      })
    }
  }

  /** true si ya se le mando al menos un didOpen a este archivo en esta
   *  sesion -- usado por get_diagnostics para saber si tiene sentido
   *  esperar un diagnostico nuevo (un archivo nunca tocado no va a
   *  producir ninguno). */
  isTracked(absolutePath: string): boolean {
    return this.openVersions.has(normalizePathKey(absolutePath))
  }

  trackedPaths(): string[] {
    return [...this.openVersions.keys()]
  }

  getCachedDiagnostics(absolutePath: string): FileDiagnosticsEntry | undefined {
    return this.diagnostics.get(normalizePathKey(absolutePath))
  }

  getLastEditAt(absolutePath: string): number | undefined {
    return this.lastEditAt.get(normalizePathKey(absolutePath))
  }

  /** Espera (poll corto) a que llegue una notificacion de diagnosticos MAS
   *  RECIENTE que `sinceMs` para este archivo, hasta `timeoutMs`. Nunca
   *  cuelga indefinido -- al timeout, el llamador decide que hacer con lo
   *  que haya en cache (get_diagnostics lo marca "stale"). */
  async waitForFreshDiagnostics(absolutePath: string, sinceMs: number, timeoutMs: number): Promise<boolean> {
    const key = normalizePathKey(absolutePath)
    const start = Date.now()
    for (;;) {
      const entry = this.diagnostics.get(key)
      if (entry && entry.updatedAt >= sinceMs) return true
      if (Date.now() - start >= timeoutMs) return false
      await new Promise(resolve => setTimeout(resolve, 100))
    }
  }

  /** Cierre limpio real del protocolo LSP: shutdown (request) + exit
   *  (notification) -- confirmado en vivo (Fase 20 Tarea 4) que el
   *  proceso termina solo con exit code 0, sin necesitar kill(). Con
   *  timeout corto de respaldo: si el servidor no responde/no sale a
   *  tiempo, se mata igual -- nunca deja un proceso zombie colgado de
   *  disconnectAgent(). */
  async shutdown(): Promise<void> {
    const child = this.child
    if (!child) return
    try {
      await this.request('shutdown', null, 3000)
      this.notify('exit', null)
      await new Promise<void>(resolve => {
        const timer = setTimeout(() => resolve(), 3000)
        child.once('exit', () => {
          clearTimeout(timer)
          resolve()
        })
      })
    } catch {
      // El request de shutdown pudo fallar/timeoutear -- se cae al kill
      // de respaldo de abajo en vez de propagar el error.
    } finally {
      if (this.child === child) {
        try { child.kill() } catch { /* ya pudo haber terminado solo */ }
        this.child = null
      }
    }
  }
}
