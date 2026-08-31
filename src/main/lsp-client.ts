// Fase 20: cliente LSP real (arranca cualquier language server bundleado
// que hable el protocolo estandar, ver LANGUAGE_SERVERS mas abajo -- Fase
// 20 original solo cubria typescript-language-server, generalizado en la
// fase de soporte Python). Investigacion previa (docs/_arch/CONTRACT.md)
// confirmo contra el proceso real: framing Content-Length (LspFramer),
// handshake initialize/initialized con capabilities minimas de
// diagnostics, servidor PUSH-only (sin pull-diagnostics: la unica senal es
// la notificacion textDocument/publishDiagnostics), shutdown+exit real
// como cierre limpio, URIs de Windows que NO matchean por string contra
// pathToFileURL() (hay que decodificar y comparar paths normalizados), y
// latencia real medida (~2.7-3.7s fria / ~442ms caliente, TypeScript).
import { app } from 'electron'
import { type ChildProcess, execFile, spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import path from 'node:path'
import { LspFramer, encodeLspMessage } from './lsp-framer'

const execFileAsync = promisify(execFile)

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
 * Soporte Python (docs/_arch/verify_python_lsp.md): generaliza lo que
 * antes eran 3 puntos hardcodeados a TypeScript (LSP_SUPPORTED_EXTENSIONS,
 * languageIdFor(), resolveLanguageServerEntry()) a una tabla chica, misma
 * forma para las 2 entradas -- sin trato especial para ninguna en el
 * MANAGER/CLIENTE (el unico matiz real, .tsx vs .ts, es intrinseco a
 * TypeScript mismo, ver languageIdFor() mas abajo, no una excepcion del
 * mecanismo de tabla). `languageId` es tambien la clave real del servidor
 * -- un solo proceso sirve TODAS las extensiones de esa entrada (.ts Y
 * .tsx comparten el MISMO typescript-language-server, exactamente como
 * antes de esta generalizacion -- no se separan en 2 procesos).
 * `resolveEntry()` lee `bin` del propio package.json del paquete bundleado
 * (mismo criterio robusto que geminiCommand(), cli-agent-runtime.ts: la
 * estructura interna de un paquete puede cambiar entre versiones, `bin` es
 * el contrato publico estable -- NUNCA hardcodear "lib/cli.mjs" o
 * "langserver.index.js" a mano). Alcance deliberado, NO automatico:
 * typescript-language-server tambien sirve .js/.jsx (via allowJs) y
 * pyright podria (en teoria) analizar otras extensiones -- sumarlas es la
 * unica accion necesaria si se quiere despues, documentado aca para que
 * sea explicito y no una omision silenciosa.
 *
 * Soporte Rust (docs/_arch/verify_rust_lsp.md): `resolveEntry()` paso a
 * ser ASYNC -- Python/TypeScript resuelven sync (leen un package.json ya
 * en disco), pero rust-analyzer es un BINARIO EXTERNO no bundleado
 * (Tarea 1: no existe un paquete npm real que lo distribuya) y resolverlo
 * implica probar si responde por PATH (execFile real, inherentemente
 * async) antes de caer al path de fallback. Cambiar el tipo no afecta el
 * VALOR que devuelven TypeScript/Python -- solo se envuelve en una promesa
 * ya resuelta, cero cambio de comportamiento para esos dos.
 *
 * `kind` (Tarea 3, hallazgo real de la investigacion): 'node' -- el entry
 * es un archivo JS bundleado, se ejecuta CON el Node embebido de Electron
 * (process.execPath + ELECTRON_RUN_AS_NODE, igual que siempre). 'native'
 * -- el entry YA es un ejecutable real (compilado), se spawnea DIRECTO sin
 * ese envoltorio -- confirmado necesario: rust-analyzer es un binario
 * nativo, no un script para que Node interprete (spawnearlo con
 * process.execPath fallaria de entrada).
 *
 * `args` (hallazgo real de seguimiento, confirmado ejecutando el binario
 * real): NO todos los language servers aceptan el mismo flag de
 * transporte. typescript-language-server/pyright necesitan `--stdio`
 * explicito para hablar por stdin/stdout. rust-analyzer usa stdio POR
 * DEFECTO (sin ningun flag) y **rechaza** `--stdio` como argumento
 * desconocido -- confirmado real: `rust-analyzer --stdio` imprime
 * `unexpected flag: --stdio` y termina con exit code 2 en ~70ms. Pasarselo
 * igual mataba el proceso casi al instante; el cliente se quedaba
 * esperando una respuesta de `initialize` que ya nunca iba a llegar
 * (timeout largo y engañoso -- parecia lentitud real de arranque de
 * rust-analyzer, no un flag invalido matando el proceso de entrada).
 */
export interface LanguageServerConfig {
  languageId: string
  extensions: string[]
  /** 'node' (TypeScript/Python, bundleados): spawnear con process.execPath
   *  + ELECTRON_RUN_AS_NODE. 'native' (Rust): spawnear el entry DIRECTO,
   *  sin envoltorio de Node -- ver LspClient.start(). */
  kind: 'node' | 'native'
  resolveEntry: () => Promise<string | null>
  /** Argumentos reales del spawn -- ver comentario de mas arriba, NO
   *  asumir que todos necesitan `--stdio` solo porque los primeros 2
   *  language servers soportados lo necesitaban. */
  args: string[]
  /** Mensaje real y accionable (get_diagnostics/LspManager.startupFailureFor())
   *  cuando resolveEntry() devuelve null -- SOLO relevante para 'native'
   *  (un binario externo que el usuario puede genuinamente no tener
   *  instalado; 'node' viene bundleado con la app, nunca deberia fallar en
   *  la practica). undefined = usa el mensaje generico de abajo. */
  installHint?: string
}

/**
 * Resuelve el entry point real de un language server BUNDLEADO dentro del
 * propio node_modules de Amatista -- NO es un CLI global que el usuario
 * instala (a diferencia de claude/codex/gemini, ver geminiCommand() en
 * cli-agent-runtime.ts): es infraestructura bundleada de la app (ver
 * docs/_arch/CONTRACT.md). En produccion, asar empaqueta el codigo de la
 * app en app.asar, pero un binario/servidor que hay que SPAWNEAR como
 * proceso real no puede vivir dentro del asar (no es un path de filesystem
 * real) -- electron-builder.asarUnpack copia estos paquetes afuera, a
 * app.asar.unpacked/node_modules/, y este helper arma el path correcto en
 * ambos casos (dev sin asar, produccion con asar+unpack). Lee `bin` del
 * package.json REAL del paquete instalado en vez de hardcodear la ruta
 * interna -- confirmado con evidencia real (Tarea 1,
 * verify_python_lsp.md) que tanto typescript-language-server
 * (`{"typescript-language-server":"lib/cli.mjs"}`) como pyright
 * (`{"pyright-langserver":"langserver.index.js"}`) exponen esto de forma
 * directamente analoga.
 */
function resolveBundledServerEntry(packageName: string, binName: string): string | null {
  const appPath = app.getAppPath()
  const base = appPath.includes('app.asar') ? appPath.replace('app.asar', 'app.asar.unpacked') : appPath
  const pkgDir = path.join(base, 'node_modules', packageName)
  try {
    const pkgJson = JSON.parse(readFileSync(path.join(pkgDir, 'package.json'), 'utf8')) as { bin?: Record<string, string> }
    const relative = pkgJson.bin?.[binName]
    if (!relative) return null
    return path.join(pkgDir, relative)
  } catch {
    return null
  }
}

/** Prueba real: ¿este comando responde a --version? Mismo criterio que
 *  tryVersion() (cli-status.ts), pero SIN shell:true -- rust-analyzer es
 *  un binario nativo (.exe) real, no un shim .cmd como gemini/codex;
 *  CreateProcess (via execFile/spawn) lo resuelve igual por PATH sin
 *  necesitar un shell de por medio (a diferencia de un .cmd, que si lo
 *  necesita para poder ejecutarse siquiera) -- evita de raiz el bug de
 *  arg-splitting que shell:true le causo a Gemini. */
async function respondsToVersion(executable: string): Promise<boolean> {
  try {
    await execFileAsync(executable, ['--version'], { windowsHide: true, timeout: 12000, shell: false })
    return true
  } catch {
    return false
  }
}

/** Fallback conocido de instalacion (default real de `rustup` en Windows)
 *  -- MISMO patron de 2 niveles que ya usa cli-status.ts (PATH primero,
 *  ruta conocida de instalacion como respaldo), pero con un candidato
 *  propio de Rust -- NO reusa npmGlobalShimPath() (cli-agent-runtime.ts/
 *  cli-status.ts), esa es especifica de instalaciones `npm install -g`. */
function rustAnalyzerCargoBinPath(): string | null {
  if (process.platform !== 'win32') return null
  const home = process.env.USERPROFILE
  if (!home) return null
  return path.join(home, '.cargo', 'bin', 'rust-analyzer.exe')
}

/**
 * Resuelve rust-analyzer -- BINARIO EXTERNO, NO bundleado (confirmado con
 * evidencia real, docs/_arch/verify_rust_lsp.md Tarea 1: no existe un
 * paquete npm real que distribuya el binario; el unico paquete npm
 * relacionado real, coc-rust-analyzer, DESCARGA el binario nativo desde
 * GitHub Releases en tiempo de uso, no lo trae adentro). Primero intenta
 * por PATH (nombre simple, sin shell) -- si responde, ESE es el comando a
 * usar. Si no, cae al path conocido de rustup -- null si tampoco existe
 * ahi, mismo patron de "no disponible" que geminiCommand() (cli-agent-runtime.ts).
 */
async function resolveRustAnalyzerEntry(): Promise<string | null> {
  if (await respondsToVersion('rust-analyzer')) return 'rust-analyzer'

  const fallback = rustAnalyzerCargoBinPath()
  if (fallback && existsSync(fallback) && await respondsToVersion(fallback)) return fallback

  return null
}

const RUST_ANALYZER_INSTALL_HINT =
  'rust-analyzer no esta instalado -- instalalo con "rustup component add rust-analyzer" ' +
  '(o descargalo de los releases de rust-lang/rust-analyzer en GitHub) y volve a intentar.'

const LANGUAGE_SERVERS: LanguageServerConfig[] = [
  {
    languageId: 'typescript',
    extensions: ['.ts', '.tsx'],
    kind: 'node',
    resolveEntry: async () => resolveBundledServerEntry('typescript-language-server', 'typescript-language-server'),
    args: ['--stdio']
  },
  {
    languageId: 'python',
    extensions: ['.py'],
    kind: 'node',
    resolveEntry: async () => resolveBundledServerEntry('pyright', 'pyright-langserver'),
    args: ['--stdio']
  },
  {
    languageId: 'rust',
    extensions: ['.rs'],
    kind: 'native',
    resolveEntry: resolveRustAnalyzerEntry,
    // Confirmado real: rust-analyzer usa stdio POR DEFECTO, sin flag --
    // pasarle --stdio (como TypeScript/Python) hace que rechace el
    // argumento y termine de entrada (ver comentario de LanguageServerConfig.args).
    args: [],
    installHint: RUST_ANALYZER_INSTALL_HINT
  }
]

export function languageServerConfigFor(filePath: string): LanguageServerConfig | undefined {
  const ext = path.extname(filePath).toLowerCase()
  return LANGUAGE_SERVERS.find(config => config.extensions.includes(ext))
}

export function isLspSupportedFile(filePath: string): boolean {
  return languageServerConfigFor(filePath) !== undefined
}

/** Matiz real preexistente (Fase 20, sin cambios de comportamiento): .tsx
 *  declara languageId 'typescriptreact' en didOpen pese a compartir el
 *  MISMO proceso/config que .ts ('typescript') -- intrinseco a como
 *  TypeScript separa JSX del protocolo LSP, no una excepcion del mecanismo
 *  de tabla en si (Python no tiene un caso equivalente hoy). */
function languageIdFor(filePath: string): string {
  const config = languageServerConfigFor(filePath)
  if (config?.languageId === 'typescript' && path.extname(filePath).toLowerCase() === '.tsx') {
    return 'typescriptreact'
  }
  return config?.languageId ?? 'plaintext'
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
   *  vuelve a spawnear nada. `config` decide QUE language server spawnear
   *  (LspManager ya resolvio cual segun la extension del archivo que
   *  disparo el arranque perezoso) -- esta clase no sabe nada de
   *  TypeScript/Python/Rust en si misma, solo habla el protocolo generico.
   *  `config.kind` decide COMO invocarlo (Tarea 3, verify_rust_lsp.md):
   *  'node' envuelve el entry con el Node embebido de Electron (JS
   *  bundleado, TypeScript/Python); 'native' lo spawnea directo (binario
   *  compilado real, Rust) -- sin este ramal, rust-analyzer.exe se
   *  intentaria cargar como si fuera un modulo de JavaScript. */
  start(workspace: string, config: LanguageServerConfig): Promise<void> {
    if (this.child) return Promise.resolve()
    if (this.starting) return this.starting

    this.starting = (async () => {
      const entry = await config.resolveEntry()
      if (!entry) {
        throw new Error(config.installHint ?? `No se pudo resolver el entry point del language server de "${config.languageId}".`)
      }
      const child = config.kind === 'native'
        ? spawn(entry, config.args, {
            cwd: workspace,
            windowsHide: true,
            shell: false
          })
        : spawn(process.execPath, [entry, ...config.args], {
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
