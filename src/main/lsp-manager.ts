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
import { LspClient, languageServerConfigFor, type LanguageServerConfig, type LspDiagnostic } from './lsp-client'

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

  /**
   * Tarea 4: get_diagnostics real. Con `absolutePath`, rutea al UNICO
   * cliente correcto segun su extension (languageServerConfigFor) -- nunca
   * pregunta a los demas lenguajes por un archivo que no les corresponde.
   * Sin `absolutePath`, junta los diagnosticos de TODOS los archivos
   * tocados en la sesion, de TODOS los clientes que ya esten vivos. Si el
   * language server correspondiente nunca arranco (ningun archivo de ese
   * lenguaje tocado todavia), devuelve [] sin arrancar nada -- get_diagnostics
   * es de solo lectura, no dispara el arranque perezoso por si sola
   * (arrancar el server es responsabilidad exclusiva de un write_file/
   * apply_patch real).
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
      results.push(...await this.diagnosticsFromClient(client, client.trackedPaths()))
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
