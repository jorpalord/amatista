// Fase 20: manager de LSP por conexion -- analogo a McpManager (mcp-client.ts)
// pero con arranque PEREZOSO en vez de al conectar: el language server real
// NUNCA se levanta en agent:connect, solo la primera vez que write_file/
// apply_patch/get_diagnostics toca un archivo .ts/.tsx real (ver
// isLspSupportedFile en lsp-client.ts). Una instancia por conexion, vive
// mientras dure la conexion, se detiene en disconnectAgent() -- mismo ciclo
// de vida que apiRuntime/mcpManager.
import { LspClient, isLspSupportedFile, type LspDiagnostic } from './lsp-client'

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
  private client: LspClient | null = null
  private starting: Promise<LspClient> | null = null

  constructor(private readonly workspace: string) {}

  private async ensureClient(): Promise<LspClient> {
    if (this.client) return this.client
    if (this.starting) return this.starting

    this.starting = (async () => {
      const client = new LspClient()
      await client.start(this.workspace)
      this.client = client
      return client
    })()

    try {
      return await this.starting
    } finally {
      this.starting = null
    }
  }

  /** true si el language server YA esta corriendo -- usado solo para
   *  verificacion/tests (confirmar arranque perezoso), no en el flujo real. */
  isRunning(): boolean {
    return this.client !== null
  }

  /**
   * Fire-and-forget: NO bloquea el resultado de write_file/apply_patch
   * (Tarea 3, decision explicita). Cualquier fallo (arranque del server,
   * handshake, etc.) se loguea y se ignora -- un language server roto
   * nunca debe impedir que la escritura del archivo se reporte como
   * exitosa al modelo, mismo principio de "un fallo aislado no bloquea el
   * resto" que ya aplica McpManager/compaction-engine/local-vcs.
   */
  notifyFileWritten(absolutePath: string, content: string): void {
    if (!isLspSupportedFile(absolutePath)) return
    void this.ensureClient()
      .then(client => client.notifyFileChanged(absolutePath, content))
      .catch(error => {
        console.error('[lsp] no se pudo notificar la escritura al language server:', error)
      })
  }

  /**
   * Tarea 4: get_diagnostics real. Sin `absolutePath`, junta los
   * diagnosticos de TODOS los archivos tocados en la sesion. Si el
   * language server nunca arranco (ningun .ts/.tsx tocado todavia),
   * devuelve [] sin arrancar nada -- get_diagnostics es de solo lectura,
   * no dispara el arranque perezoso por si sola (arrancar el server es
   * responsabilidad exclusiva de un write_file/apply_patch real).
   */
  async getDiagnostics(absolutePath?: string): Promise<LspDiagnosticsResult[]> {
    const client = this.client
    if (!client) return []

    const targets = absolutePath ? [absolutePath] : client.trackedPaths()
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
   *  resto de la desconexion. */
  stopAll(): void {
    const client = this.client
    this.client = null
    if (!client) return
    void client.shutdown().catch(() => {
      // shutdown() ya tiene su propio fallback a kill() interno -- si aun
      // asi rechaza, no hay nada mas que hacer del lado del manager.
    })
  }
}
