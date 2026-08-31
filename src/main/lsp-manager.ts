// Fase 20: manager de LSP por conexion -- analogo a McpManager (mcp-client.ts)
// pero con arranque PEREZOSO en vez de al conectar: el language server real
// NUNCA se levanta en agent:connect, solo la primera vez que write_file/
// apply_patch/get_diagnostics toca un archivo real de un lenguaje soportado
// (ver languageServerConfigFor en lsp-client.ts). Soporte Python
// (docs/_arch/verify_python_lsp.md): antes UNA instancia total por conexion
// (un solo LspClient); ahora un Map por languageId -- tocar un .py arranca
// (si no existe ya) el cliente de Python SIN afectar al de TypeScript si ya
// estaba corriendo, y viceversa. Los 2 pueden estar vivos a la vez en el
// mismo workspace. Vive mientras dure la conexion, todos se detienen juntos
// en disconnectAgent() -- mismo ciclo de vida que apiRuntime/mcpManager.
import { readFileSync } from 'node:fs'
import { LspClient, languageServerConfigFor, type LanguageServerConfig, type LspDiagnostic, type LspLocation, type LspSymbol } from './lsp-client'

export interface LspDiagnosticsResult {
  path: string
  diagnostics: LspDiagnostic[]
  /** true si no se pudo confirmar que el diagnostico devuelto corresponde
   *  a la version MAS RECIENTE del archivo (timeout de
   *  waitForFreshDiagnostics alcanzado) -- nunca se esconde esta
   *  incertidumbre, se la pasa a la tool para que se la diga al modelo. */
  stale: boolean
}

/**
 * Indexacion por simbolos (docs/_arch/verify_lsp_symbols.md): resultado de
 * find_definition/find_references. `reason` presente = la consulta NO se
 * pudo hacer en absoluto (extension no soportada, language server no
 * instalado/no pudo arrancar, o no anuncia la capability real) --
 * `locations` queda `[]` en ese caso. `reason` ausente = la consulta SI se
 * hizo contra el servidor real -- `locations` refleja el resultado real,
 * que puede ser genuinamente `[]` ("no hay definicion/referencias", una
 * respuesta valida del protocolo, no un fallo).
 */
export interface LspLocationsResult {
  locations: LspLocation[]
  reason?: string
}

/**
 * Resultado de list_symbols. `queriedLanguages` solo se puebla para
 * workspace/symbol (busqueda por `query`, sin `path`) -- transparencia real
 * sobre que lenguajes tenian un cliente YA CORRIENDO y fueron consultados
 * de verdad (ver docs/_arch/verify_lsp_symbols.md, Tarea 4: limitacion real
 * documentada, no oculta -- un lenguaje cuyo servidor no arranco todavia en
 * la sesion no aparece, sin importar si el simbolo existe en el
 * workspace). Para documentSymbol (con `path`) queda `undefined` -- ahi
 * solo hay UN lenguaje posible, ya lo sabe el llamador.
 */
export interface LspSymbolsResult {
  symbols: LspSymbol[]
  reason?: string
  queriedLanguages?: string[]
}

/**
 * Fase 20 Tarea 4: timeout de espera de get_diagnostics por archivo.
 * Numero concreto, justificado con la latencia real medida en la
 * investigacion previa (docs/_arch/CONTRACT.md): ~2.7-3.7s en frio (primer
 * archivo tocado en la sesion, carga completa del proyecto de TS) y
 * ~442ms en caliente (edicion sobre un archivo ya abierto). 5000ms da
 * margen razonable sobre el peor caso medido (frio) sin colgar el turno
 * indefinidamente si el servidor esta genuinamente trabado.
 */
const DIAGNOSTICS_WAIT_TIMEOUT_MS = 5000

export class LspManager {
  /** Soporte Python: antes un solo campo `client: LspClient | null`, ahora
   *  un mapa por `languageId` -- cada lenguaje soportado (LANGUAGE_SERVERS,
   *  lsp-client.ts) tiene su propia instancia real, independiente de las
   *  demas. */
  private clients = new Map<string, LspClient>()
  private starting = new Map<string, Promise<LspClient>>()
  /** Soporte Rust (docs/_arch/verify_rust_lsp.md, Tarea 4): motivo real
   *  (ya el mensaje armado, ver LanguageServerConfig.installHint) por el
   *  que el language server de este languageId nunca pudo arrancar --
   *  SOLO relevante en la practica para servidores 'native' (un binario
   *  externo, ej. rust-analyzer, que el usuario puede genuinamente no
   *  tener instalado; los 'node' vienen bundleados con la app, nunca
   *  deberian caer aca). Se limpia si un intento posterior arranca bien --
   *  nunca queda pegado un fallo viejo despues de instalar el binario y
   *  reintentar. */
  private failures = new Map<string, string>()

  constructor(private readonly workspace: string) {}

  private async ensureClient(config: LanguageServerConfig): Promise<LspClient> {
    const existing = this.clients.get(config.languageId)
    if (existing) return existing
    const pending = this.starting.get(config.languageId)
    if (pending) return pending

    const promise = (async () => {
      const client = new LspClient()
      await client.start(this.workspace, config)
      this.clients.set(config.languageId, client)
      return client
    })()
    this.starting.set(config.languageId, promise)

    try {
      return await promise
    } finally {
      this.starting.delete(config.languageId)
    }
  }

  /** true si el language server de `languageId` YA esta corriendo -- usado
   *  solo para verificacion/tests (confirmar arranque perezoso y
   *  coexistencia real de 2 lenguajes), no en el flujo real. Sin
   *  `languageId`, true si CUALQUIERA esta corriendo. */
  isRunning(languageId?: string): boolean {
    return languageId ? this.clients.has(languageId) : this.clients.size > 0
  }

  /**
   * Fire-and-forget: NO bloquea el resultado de write_file/apply_patch
   * (Tarea 3, decision explicita). Cualquier fallo (arranque del server,
   * handshake, etc.) se loguea y se ignora -- un language server roto
   * nunca debe impedir que la escritura del archivo se reporte como
   * exitosa al modelo, mismo principio de "un fallo aislado no bloquea el
   * resto" que ya aplica McpManager/compaction-engine/local-vcs. Rutea al
   * cliente correcto segun la extension real del archivo (languageServerConfigFor,
   * lsp-client.ts) -- arrancar el de Python nunca toca ni afecta al de
   * TypeScript si ya estaba corriendo, y viceversa (Map independiente por
   * languageId, ver ensureClient()).
   */
  notifyFileWritten(absolutePath: string, content: string): void {
    const config = languageServerConfigFor(absolutePath)
    if (!config) return
    void this.ensureClient(config)
      .then(client => {
        this.failures.delete(config.languageId)
        client.notifyFileChanged(absolutePath, content)
      })
      .catch(error => {
        const message = error instanceof Error ? error.message : String(error)
        this.failures.set(config.languageId, message)
        console.error(`[lsp] no se pudo notificar la escritura al language server de "${config.languageId}":`, error)
      })
  }

  /**
   * Indexacion por simbolos (docs/_arch/verify_lsp_symbols.md, adenda):
   * abre un archivo BAJO DEMANDA para find_definition/find_references/
   * list_symbols -- a diferencia de notifyFileWritten() (fire-and-forget,
   * dispara SOLO tras un write_file/apply_patch real, con el contenido que
   * el modelo ya tiene en memoria), este metodo se puede awaitear (el
   * request subsiguiente no puede salir antes de que el didOpen llegue) y
   * lee el contenido ACTUAL de disco (el modelo no esta mandando contenido
   * nuevo, solo pide navegar a un archivo que puede no haber tocado nunca
   * en esta sesion). SIN LIMITE de cuantos archivos se abren -- confirmado
   * con evidencia real (adenda de verify_lsp_symbols.md) que la restriccion
   * de get_diagnostics a "solo archivos tocados" fue un recorte de ALCANCE
   * de Fase 20 (la tool se penso solo para "revisar mi propia edicion"), no
   * una decision deliberada de limite de recursos -- y que
   * notifyFileWritten() YA abre archivos sin limite desde esa misma fase,
   * asi que esto no introduce una categoria de riesgo nueva. No hace nada
   * si el archivo ya esta trackeado -- evita un didChange redundante con el
   * mismo contenido que ya tiene el servidor.
   */
  async ensureOpen(absolutePath: string): Promise<LspClient | undefined> {
    const config = languageServerConfigFor(absolutePath)
    if (!config) return undefined
    let client: LspClient
    try {
      client = await this.ensureClient(config)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.failures.set(config.languageId, message)
      return undefined
    }
    this.failures.delete(config.languageId)
    if (!client.isTracked(absolutePath)) {
      const content = readFileSync(absolutePath, 'utf8')
      // Fix de aislamiento (docs/_arch/verify_lsp_demo_scope.md, Tarea 3):
      // 'navigate', NO el default 'edit' -- este archivo se abre para
      // consultarlo, no porque el modelo lo haya editado. Si ya estaba
      // editado de antes (edicion real previa), notifyFileChanged() no lo
      // degrada -- pero este branch ni siquiera se alcanza en ese caso
      // (isTracked() ya es true desde esa edicion).
      client.notifyFileChanged(absolutePath, content, 'navigate')
    }
    return client
  }

  /** `textDocument/definition` real, ruteado al cliente correcto segun la
   *  extension (mismo criterio que getDiagnostics()), abriendo el archivo
   *  bajo demanda si hace falta (ensureOpen()). */
  async findDefinition(absolutePath: string, line: number, column: number): Promise<LspLocationsResult> {
    const config = languageServerConfigFor(absolutePath)
    if (!config) return { locations: [], reason: 'Extension no soportada por ningun language server configurado.' }
    const client = await this.ensureOpen(absolutePath)
    if (!client) {
      return { locations: [], reason: this.startupFailureFor(absolutePath) ?? `No se pudo arrancar el language server de "${config.languageId}".` }
    }
    if (!client.supportsCapability('definitionProvider')) {
      return { locations: [], reason: `El language server de "${config.languageId}" no anuncia soporte para ir a la definicion.` }
    }
    return { locations: await client.definition(absolutePath, line, column) }
  }

  /** `textDocument/references` real -- mismo ruteo/apertura bajo demanda
   *  que findDefinition(). */
  async findReferences(absolutePath: string, line: number, column: number, includeDeclaration: boolean): Promise<LspLocationsResult> {
    const config = languageServerConfigFor(absolutePath)
    if (!config) return { locations: [], reason: 'Extension no soportada por ningun language server configurado.' }
    const client = await this.ensureOpen(absolutePath)
    if (!client) {
      return { locations: [], reason: this.startupFailureFor(absolutePath) ?? `No se pudo arrancar el language server de "${config.languageId}".` }
    }
    if (!client.supportsCapability('referencesProvider')) {
      return { locations: [], reason: `El language server de "${config.languageId}" no anuncia soporte para buscar referencias.` }
    }
    return { locations: await client.references(absolutePath, line, column, includeDeclaration) }
  }

  /** `textDocument/documentSymbol` real -- simbolos de UN archivo puntual,
   *  mismo ruteo/apertura bajo demanda que findDefinition(). */
  async listSymbolsInFile(absolutePath: string): Promise<LspSymbolsResult> {
    const config = languageServerConfigFor(absolutePath)
    if (!config) return { symbols: [], reason: 'Extension no soportada por ningun language server configurado.' }
    const client = await this.ensureOpen(absolutePath)
    if (!client) {
      return { symbols: [], reason: this.startupFailureFor(absolutePath) ?? `No se pudo arrancar el language server de "${config.languageId}".` }
    }
    if (!client.supportsCapability('documentSymbolProvider')) {
      return { symbols: [], reason: `El language server de "${config.languageId}" no anuncia soporte para listar simbolos.` }
    }
    return { symbols: await client.documentSymbol(absolutePath) }
  }

  /** `workspace/symbol` real -- busqueda por NOMBRE, sin archivo puntual.
   *  DELIBERADAMENTE no arranca ningun language server nuevo (a diferencia
   *  de findDefinition()/findReferences()/listSymbolsInFile(), que sI usan
   *  ensureOpen()) -- solo consulta a los clientes YA CORRIENDO, mismo
   *  patron de agregacion que getDiagnostics() sin `path`. Limitacion real
   *  documentada en la propia tool (tool-registry.ts), no oculta: un
   *  simbolo de un lenguaje cuyo servidor no arranco todavia esta sesion no
   *  va a aparecer. */
  async searchSymbols(query: string): Promise<LspSymbolsResult> {
    const symbols: LspSymbol[] = []
    const queriedLanguages: string[] = []
    for (const [languageId, client] of this.clients.entries()) {
      if (!client.supportsCapability('workspaceSymbolProvider')) continue
      queriedLanguages.push(languageId)
      symbols.push(...await client.workspaceSymbol(query))
    }
    return { symbols, queriedLanguages }
  }

  /** Soporte Rust (Tarea 4): mensaje real (ver LanguageServerConfig.installHint)
   *  si el language server correspondiente a este archivo intento arrancar
   *  y fallo -- undefined si nunca se intento, o si arranco bien.
   *  Consumido por get_diagnostics (tool-registry.ts) para reemplazar el
   *  generico "nunca tocado" por el motivo real cuando aplica (ej.
   *  rust-analyzer ausente), en vez del catch+log silencioso que era
   *  suficiente mientras los 2 unicos lenguajes soportados venian
   *  bundleados y nunca fallaban en la practica. */
  startupFailureFor(absolutePath: string): string | undefined {
    const config = languageServerConfigFor(absolutePath)
    return config ? this.failures.get(config.languageId) : undefined
  }

  /** Soporte Go (docs/_arch/verify_go_lsp.md, Tarea 1): DISTINTO de
   *  startupFailureFor() -- ese es para cuando el language server NUNCA
   *  pudo arrancar (resolveEntry() devolvio null). Este es para el caso
   *  confirmado real con gopls: el proceso arranca perfecto (`isRunning`
   *  ya es `true`, el handshake `initialize` respondio bien) pero despues
   *  informa por `window/showMessage` que no puede analizar nada (ej. `go`
   *  no resoluble en el PATH del proceso hijo) -- nunca llega a publicar
   *  ni un diagnostico, ni siquiera vacio. undefined = el cliente nunca
   *  reporto un error de este tipo, o ya se recupero (ver
   *  LspClient.onPublishDiagnostics()). */
  operationalErrorFor(absolutePath: string): string | undefined {
    const config = languageServerConfigFor(absolutePath)
    const client = config ? this.clients.get(config.languageId) : undefined
    return client?.getLastErrorMessage()
  }

  /**
   * Tarea 4: get_diagnostics real. Con `absolutePath`, rutea al UNICO
   * cliente correcto segun su extension (languageServerConfigFor) -- nunca
   * pregunta a los demas lenguajes por un archivo que no les corresponde.
   * Sin este contexto explicito, el modelo pidio ESE archivo a proposito --
   * `isTracked()`/`diagnosticsFromClient()` no distinguen editado de
   * navegado aca, no hace falta: no hay contaminacion posible cuando el
   * path es explicito.
   *
   * Sin `absolutePath`, junta los diagnosticos de TODOS los archivos
   * EDITADOS de verdad (`editedTrackedPaths()`, fix real documentado en
   * docs/_arch/verify_lsp_demo_scope.md Tarea 3 -- ANTES de este fix era
   * `trackedPaths()`, que tambien incluia archivos abiertos solo para
   * navegar via ensureOpen()/find_definition/find_references/list_symbols,
   * confirmado real que eso contaminaba el resultado con errores
   * preexistentes de archivos que el modelo nunca edito). Si el language
   * server correspondiente nunca arranco (ningun archivo de ese lenguaje
   * tocado todavia), devuelve [] sin arrancar nada -- get_diagnostics es de
   * solo lectura, no dispara el arranque perezoso por si sola (arrancar el
   * server es responsabilidad exclusiva de un write_file/apply_patch real).
   */
  async getDiagnostics(absolutePath?: string): Promise<LspDiagnosticsResult[]> {
    if (absolutePath) {
      const config = languageServerConfigFor(absolutePath)
      const client = config ? this.clients.get(config.languageId) : undefined
      if (!client) return []
      return this.diagnosticsFromClient(client, [absolutePath])
    }

    const results: LspDiagnosticsResult[] = []
    for (const client of this.clients.values()) {
      results.push(...await this.diagnosticsFromClient(client, client.editedTrackedPaths()))
    }
    return results
  }

  private async diagnosticsFromClient(client: LspClient, targets: string[]): Promise<LspDiagnosticsResult[]> {
    const deadline = Date.now() + DIAGNOSTICS_WAIT_TIMEOUT_MS
    const results: LspDiagnosticsResult[] = []
    for (const target of targets) {
      if (!client.isTracked(target)) {
        results.push({ path: target, diagnostics: [], stale: true })
        continue
      }
      const sinceMs = client.getLastEditAt(target) ?? 0
      const remaining = Math.max(0, deadline - Date.now())
      const fresh = await client.waitForFreshDiagnostics(target, sinceMs, remaining)
      const entry = client.getCachedDiagnostics(target)
      results.push({
        path: target,
        diagnostics: entry?.diagnostics ?? [],
        stale: !fresh
      })
    }
    return results
  }

  /** Cierre limpio (shutdown+exit real, ver LspClient.shutdown()) —
   *  llamado desde disconnectAgent(), mismo punto donde ya se paran
   *  apiRuntime/mcpManager/etc. Fire-and-forget desde el punto de vista del
   *  llamador (disconnectAgent() es sincronico) -- el shutdown real corre
   *  en background con su propio timeout de respaldo, nunca bloquea el
   *  resto de la desconexion. Para TODOS los clientes vivos del mapa, no
   *  solo uno -- ningun language server debe sobrevivir a la desconexion. */
  stopAll(): void {
    const clients = [...this.clients.values()]
    this.clients.clear()
    // Reset del historial de fallos junto con los clientes -- una conexion
    // nueva merece un intento fresco (ej. el usuario instalo rust-analyzer
    // entre una conexion y la siguiente, no debe seguir viendo el mensaje
    // de "no instalado" de la sesion anterior).
    this.failures.clear()
    for (const client of clients) {
      void client.shutdown().catch(() => {
        // shutdown() ya tiene su propio fallback a kill() interno -- si aun
        // asi rechaza, no hay nada mas que hacer del lado del manager.
      })
    }
  }
}
