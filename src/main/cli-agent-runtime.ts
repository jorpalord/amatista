import { app } from 'electron'
import { ChildProcessWithoutNullStreams, spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { createInterface } from 'node:readline'
import { formatContextEnvelope } from './context-envelope'
import { antigravityIsolatedEnv, writeAntigravityMcpConfig, writeAntigravitySettingsForAuthMode } from './antigravity-home'
import { MCP_APPROVAL_PIPE_PATH } from './mcp-pipe-name'
import { listComposedToolDefinitions } from './composed-tools'
// Fix real (docs/_arch/verify_cli_clean_cancellation_design.md): reusa la
// MISMA clase que ya usa el runtime API para distinguir "cancelamos
// nosotros" de un crash real -- sin ciclo real (api-agent-runtime.ts no
// importa nada de este archivo, confirmado con grep antes de este cambio).
import { TurnCancelledError } from './api-agent-runtime'
import type { ChatAttachment, ProviderProfile, RuntimeContextEnvelope, SandboxMode } from '../shared/types'

// Reintegracion de Claude Code CLI (docs/_arch/verify_claude_cli_reintegration.md):
// restauracion casi literal del codigo retirado en dec378c -- 'claude' vuelve
// al union de CliAgentKind, mismo motivo por el que se dejo la forma general
// (clase + `kind`) cuando se retiro (comentado en su momento en dec378c):
// buildEnv()/permissionArgs() vuelven a bifurcar por kind, sendClaude()/
// sendClaudeWithImages() vuelven completas. Unica diferencia real respecto al
// codigo pre-dec378c: --no-session-persistence agregado a los 2 args: string[]
// de Claude (Tarea 3 de la investigacion).
//
// Integracion de Antigravity CLI (docs/_arch/verify_antigravity_cli.md,
// verify_antigravity_integration.md): 'antigravity' se suma al union --
// mismo patron spawn+stdout que Codex NO usa (JSON-RPC), sendAntigravity()
// nueva mas abajo.
//
// Retiro de gemini-cli (docs/_arch/verify_gemini_cli_removal_scope.md,
// docs/_arch/verify_gemini_cli_removal.md): 'gemini' salio del union --
// gemini-cli standalone quedo discontinuado para cuentas individuales
// (IneligibleTierError real, confirmado, Google redirige a Antigravity).
// El camino HTTP (authMode:'api-key') NO pasaba por esta clase -- sigue
// intacto en api-agent-runtime.ts (ApiAgentKind 'gemini-api'), ver
// shared/model-capabilities.ts → isApiCapableModel().
export type CliAgentKind = 'claude' | 'antigravity'

/**
 * Default de `--max-turns` de Claude Code CLI cuando `AppSettings.maxTurnsCli`
 * no esta seteado (docs/_arch/verify_claude_cli_max_turns_y_error_real.md).
 * Antes hardcodeado en 20 en sendClaude()/sendClaudeWithImages() -- confirmado
 * real que una tarea grande lo agotaba (`error_max_turns`, exit 1) y que el
 * usuario llegaba a ~40 rondas de tools en su proyecto. Mismo valor que
 * MAX_TOOL_LOOP de los runtimes API (60): mas margen sin ser ilimitado.
 */
export const DEFAULT_MAX_TURNS_CLI = 60

interface ConfigureOptions {
  kind: CliAgentKind
  provider: ProviderProfile
  model: string
  workspace: string
  sandbox: SandboxMode
  /**
   * Limite `--max-turns` de Claude Code CLI (`AppSettings.maxTurnsCli`,
   * shared/types.ts). undefined = DEFAULT_MAX_TURNS_CLI. Solo lo lee
   * sendClaude()/sendClaudeWithImages() -- Antigravity no lo usa (`agy` no
   * tiene flag equivalente, ver comentario en AppSettings.maxTurnsCli).
   * Refrescable en caliente sin reconectar: updateMaxTurns().
   */
  maxTurnsCli?: number
  /**
   * Orquestacion por suscripcion (docs/_arch/verify_subscription_orchestrator_design.md):
   * identificador real y estable de ESTA conexion, mismo `panelId` que ya
   * usa el resto del codebase para requestSessionToolApproval()/
   * sendSessionEvent() -- viaja por `env` (AMATISTA_PANEL_ID) al spawn del
   * servidor MCP propio, mismo patron que AMATISTA_MCP_WORKSPACE. Nunca
   * viaja como argumento de tool call: el modelo del CLI no lo ve ni lo
   * puede tocar.
   */
  panelId: string
  /**
   * PIEZA 1 del gate de orquestacion (Tarea 4): calculado por ipc-agent.ts
   * en agent:connect via isPrincipalChat() (chat-store.ts), mismo momento y
   * mismo valor que ya usa ApiAgentRuntime.config.isPrincipalChat para
   * gatear send_to_window/parallel_ask en su propio toolCatalog(). Decide
   * si el servidor MCP de este panel declara las 2 tools de orquestacion
   * (AMATISTA_IS_PRINCIPAL por env) -- primera linea de defensa, NUNCA la
   * unica: mcp-approval-pipe.ts recalcula esto mismo del lado de main por
   * cada mensaje, sin confiar en lo que este proceso declare.
   */
  isPrincipalChat: boolean
  /**
   * Familia A (computer use, docs/_arch/verify_computer_use_cli_extension.md,
   * Tarea 3): Capa 1 (`session.computerUseActive`) -- decide si el
   * servidor MCP de este panel declara las 4 tools de computer use
   * (env AMATISTA_COMPUTER_USE_ACTIVE, mcpLspServerSpawnSpec() mas abajo).
   * A diferencia de `isPrincipalChat` (fija toda la conexion), este campo
   * SI puede cambiar en caliente sin reconectar -- ver updateComputerUseActive()
   * mas abajo, mismo patron que updateSandbox().
   */
  computerUseActive: boolean
  /**
   * Navegador embebido (docs/_arch/verify_embedded_browser_design.md):
   * mismo criterio exacto que computerUseActive de arriba -- decide si el
   * servidor MCP de este panel declara las 4 tools de navegador (env
   * AMATISTA_BROWSER_CONTROL_ACTIVE). Campo independiente (dominio de
   * riesgo distinto ya confirmado en el diseño).
   */
  browserControlActive: boolean
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

/**
 * Motivo real de un exit != 0 de Claude Code (docs/_arch/
 * verify_claude_cli_max_turns_y_error_real.md). Confirmado real contra el
 * binario: al agotar `--max-turns` sale con codigo 1, stderr VACIO y el
 * motivo unicamente en stdout (`{"is_error":true,"subtype":"error_max_turns",
 * "result":""}`) -- los handlers 'exit' de sendClaude()/sendClaudeWithImages()
 * descartaban stdout y el usuario solo veia "Claude terminó con código 1."
 * Mismo bug y mismo fix que ya tenia sendAntigravity() (parsear stdout
 * ANTES del mensaje generico, sin importar el exit code).
 *
 * `record`: el objeto JSON de resultado ya parseado (sendClaude: JSON.parse
 * de todo stdout; sendClaudeWithImages: la linea `resultRecord` del stream),
 * o null si stdout no trajo un JSON de resultado valido.
 *  - `subtype === 'error_max_turns'` -> unico caso CONFIRMADO real: mensaje
 *    claro con el N que se le paso a `--max-turns` y donde subirlo.
 *  - cualquier otro `subtype`/`api_error_status`/`result` no vacio -> se
 *    muestran CRUDOS, sin traducir (no se inventan explicaciones de
 *    subtypes que no se hayan reproducido). Unica excepcion: el tag
 *    `subtype` se oculta cuando vale "success" (ver comentario abajo).
 *    stderr, si trae algo, se agrega al final -- nunca se pierde
 *    informacion que antes si se mostraba.
 *  - sin record, o record sin ninguno de esos campos -> stderr -> mensaje
 *    generico (comportamiento previo, sin cambios).
 */
function claudeExitErrorMessage(
  record: Record<string, unknown> | null,
  code: number | null,
  stderr: string,
  maxTurns: number
): string {
  const stderrText = stderr.trim()
  if (record) {
    if (record.subtype === 'error_max_turns') {
      return `Se alcanzó el límite de ${maxTurns} turnos configurado — podés subirlo en Configuración → Herramientas del workspace.`
    }
    const tags: string[] = []
    const subtype = firstString(record, ['subtype'])
    // Unica excepcion a "crudo": Claude Code emite `is_error:true` JUNTO con
    // `subtype:"success"` en errores de API (confirmado real: modelo
    // inexistente -> api_error_status 404) -- "subtype: success" dentro de un
    // mensaje de error confunde sin aportar nada. Cualquier otro subtype real
    // sigue mostrandose tal cual.
    if (subtype && subtype !== 'success') tags.push(`subtype: ${subtype}`)
    const apiStatus = record.api_error_status
    if (apiStatus !== undefined && apiStatus !== null && apiStatus !== '') {
      tags.push(`api_error_status: ${typeof apiStatus === 'string' ? apiStatus : JSON.stringify(apiStatus)}`)
    }
    const result = firstString(record, ['result', 'response', 'text'])
    if (tags.length > 0 || result) {
      const head = `Claude terminó con código ${String(code)}${tags.length > 0 ? ` (${tags.join(', ')})` : ''}`
      return [result ? `${head}:` : `${head}.`, result, stderrText ? `stderr: ${stderrText}` : undefined]
        .filter(Boolean)
        .join('\n')
    }
  }
  return stderrText || `Claude terminó con código ${String(code)}.`
}

interface ParsedDataUrl {
  mimeType: string
  base64: string
}

/**
 * Fase 17 Parte 2: version local minima de parseDataUrl()/
 * anthropicImageBlocks() (api-agent-runtime.ts) -- deliberadamente NO
 * reusada desde ahi. Dos razones concretas, no solo "por las dudas":
 * (1) restriccion explicita de esa fase, no tocar api-agent-runtime.ts
 *     (ya cerrado en Parte 1) -- ninguna de las dos funciones esta
 *     exportada, asi que reusarlas de verdad habria significado abrir
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
 * -- Gemini CLI queda fuera de esto, sin tocar.
 */
function currentImageAttachments(context?: RuntimeContextEnvelope): ChatAttachment[] {
  return (context?.attachments ?? []).filter(attachment => attachment.kind === 'image' && Boolean(attachment.preview))
}

// Exportada (docs/_arch/verify_model_refresh_design.md, boton "Actualizar
// modelos"): model-discovery.ts la reusa para localizar el mismo .exe real
// (extraccion de strings + turnos reales de verificacion) en vez de
// duplicar esta resolucion de ruta -- cero cambio de comportamiento para
// los llamadores existentes de este archivo.
export function claudeCommand(): string {
  if (process.platform !== 'win32') return 'claude'

  const appData = process.env.APPDATA
  if (appData) {
    const exe = path.join(appData, 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe')
    if (existsSync(exe)) return exe
  }

  return 'claude'
}

/**
 * Mismo patron/motivo real que `claudeCommand()` de arriba -- el instalador
 * oficial de Google (confirmado real, `irm https://antigravity.google/cli/
 * install.ps1 | iex`) deja el binario en una ruta fija fuera de PATH hasta
 * que se reinicia la terminal (confirmado real en la instalacion de esta
 * investigacion: "Warning: ... is not present in your active Environment
 * PATH"), riesgo real ya documentado en este codebase para el mismo tipo de
 * gap (`cli-status.ts`, comentario de `npmGlobalShimPath()`: Electron
 * lanzado desde el Explorer puede heredar un PATH de usuario
 * desactualizado). A diferencia de Claude/Gemini, `agy` NO se instala via
 * npm -- `%APPDATA%\npm\...` no aplica, la ruta real confirmada es
 * `%LOCALAPPDATA%\agy\bin\agy.exe` (`antigravity.google/docs/cli/install`).
 */
// Exportada (docs/_arch/verify_model_refresh_design.md, boton "Actualizar
// modelos"): model-discovery.ts la reusa para correr `agy models` real
// contra el mismo binario que los turnos reales, sin duplicar esta
// resolucion de ruta.
export function antigravityCommand(): string {
  if (process.platform !== 'win32') return 'agy'

  const localAppData = process.env.LOCALAPPDATA
  if (localAppData) {
    const exe = path.join(localAppData, 'agy', 'bin', 'agy.exe')
    if (existsSync(exe)) return exe
  }

  return 'agy'
}

/**
 * Servidor MCP de LSP (docs/_arch/CONTRACT.md → "Servidor MCP de LSP para
 * los 3 CLIs", alcance reducido: find_definition/find_references/
 * list_symbols/get_diagnostics, sin aprobacion). Ruta real al bundle
 * standalone (mcp-lsp-server.ts -> esbuild -> out/main/mcp-lsp-server.cjs,
 * ver package.json script "mcp:lsp:bundle") -- vive FUERA del asar
 * (asarUnpack real agregado en package.json), mismo motivo ya documentado
 * en lsp-client.ts para typescript-language-server/pyright: un proceso que
 * hay que SPAWNEAR (claude-cli/agy lo hacen, no Amatista directamente) no
 * puede vivir dentro del asar, no es un path de filesystem real ahi. `null`
 * si el archivo no existe (dev sin correr el bundle todavia, instalacion
 * rota) -- el llamador debe tratarlo como "sin MCP de LSP este turno",
 * NUNCA bloquear el turno entero por esto (mismo principio ya establecido
 * en McpManager.startAll()/notifyFileWritten(): un fallo aislado de MCP
 * nunca debe tirar abajo el resto).
 */
function mcpLspServerScriptPath(): string | null {
  const appPath = app.getAppPath()
  const base = appPath.includes('app.asar') ? appPath.replace('app.asar', 'app.asar.unpacked') : appPath
  const entry = path.join(base, 'out', 'main', 'mcp-lsp-server.cjs')
  return existsSync(entry) ? entry : null
}

/**
 * Spec de spawn comun para Claude/Antigravity (Codex, `codex app-server`
 * persistente vía JSON-RPC, queda deliberadamente fuera de este alcance --
 * ver DISEÑO, integracion pedida solo para sendClaude()/
 * sendClaudeWithImages()/sendAntigravity()). `process.execPath` +
 * `ELECTRON_RUN_AS_NODE:'1'` -- mismo patron real ya probado por
 * `lsp-client.ts` (Fase 20) para `typescript-language-server`, para no
 * depender de que el usuario tenga Node propio en PATH. `AMATISTA_MCP_
 * WORKSPACE`/`AMATISTA_APP_PATH` por ENV
 * -- mismo patron de contexto-real-por-ENV que AMATISTA_STORAGE_ROOT/
 * AMATISTA_PANEL_ID ya establecen en este codebase; `AMATISTA_APP_PATH` es
 * el fallback real que `resolveElectronAppPath()` (lsp-client.ts) necesita
 * porque el servidor MCP corre fuera de Electron (ver el comentario
 * completo ahi).
 */
/**
 * Orquestacion por suscripcion: `panelId`/`isPrincipalChat` sumados a la
 * firma -- mismo mecanismo de contexto-por-ENV que AMATISTA_MCP_WORKSPACE,
 * nada de transporte nuevo (ver ConfigureOptions.panelId/isPrincipalChat
 * arriba). AMATISTA_IS_PRINCIPAL solo se manda si es `true` (ausente =
 * falsy del lado del servidor MCP, mismo criterio que el resto del
 * codebase para flags booleanos por env -- ver antigravityIsolatedEnv()).
 */
function mcpLspServerSpawnSpec(
  workspace: string,
  panelId: string,
  isPrincipalChat: boolean,
  computerUseActive: boolean,
  browserControlActive: boolean
): { command: string; args: string[]; env: Record<string, string> } | null {
  const scriptPath = mcpLspServerScriptPath()
  if (!scriptPath) return null
  return {
    command: process.execPath,
    args: [scriptPath],
    env: {
      ELECTRON_RUN_AS_NODE: '1',
      AMATISTA_MCP_WORKSPACE: workspace,
      AMATISTA_APP_PATH: app.getAppPath(),
      AMATISTA_PANEL_ID: panelId,
      ...(isPrincipalChat ? { AMATISTA_IS_PRINCIPAL: '1' } : {}),
      // Familia A (computer use, docs/_arch/verify_computer_use_cli_extension.md):
      // mismo criterio que AMATISTA_IS_PRINCIPAL -- ausente = falsy del
      // lado del servidor MCP. Independiente de isPrincipalChat (cualquier
      // panel, principal o no, puede tener computer use activado para si
      // mismo -- son gates de dominios de riesgo distintos, ver
      // verify_computer_use_security_model.md Tarea 2).
      ...(computerUseActive ? { AMATISTA_COMPUTER_USE_ACTIVE: '1' } : {}),
      // Navegador embebido (docs/_arch/verify_embedded_browser_design.md):
      // mismo criterio exacto que AMATISTA_COMPUTER_USE_ACTIVE de arriba.
      ...(browserControlActive ? { AMATISTA_BROWSER_CONTROL_ACTIVE: '1' } : {}),
      // Pipe propio de ESTA instancia de Amatista, SIEMPRE (mcp-pipe-name.ts: unico por proceso, derivado solo): el
      // proceso MCP hijo no tiene ningun nombre por defecto al que caer -- sin esto le hablaria a otra instancia o a
      // ninguna. Para Antigravity viaja dentro de mcp_config.json, que se reescribe entero antes de cada turno.
      AMATISTA_MCP_PIPE: MCP_APPROVAL_PIPE_PATH
    }
  }
}

export class CliAgentRuntime extends EventEmitter {
  private config: ConfigureOptions | null = null
  private sessionId?: string
  private activeProcess: ChildProcessWithoutNullStreams | null = null
  /** Fix real (docs/_arch/verify_cli_clean_cancellation_design.md): seteado
   *  en cancelTurn() ANTES de matar el proceso -- los 3 handlers 'exit'
   *  reales (sendClaude/sendClaudeWithImages/sendAntigravity) lo chequean
   *  PRIMERO, antes del `code !== 0` generico, para distinguir "lo matamos
   *  nosotros" (code:null real, la firma de una señal en Node) de un crash
   *  real del binario. Reseteado a false apenas se consume -- nunca
   *  sobrevive al turno que lo seteo. */
  private cancelledByUs = false

  configure(options: ConfigureOptions): void {
    this.stop()
    this.config = options
    this.sessionId = undefined
  }

  /**
   * "Modo plan" (docs/_arch/verify_plan_mode_design.md, Tarea 2): cambio de
   * sandbox EN CALIENTE, sin reconectar -- deliberadamente NO reusa
   * configure() de arriba, que llama this.stop() y resetea this.sessionId
   * (perderia la continuidad real de sesion, ej. --resume de claude-cli).
   * Muta SOLO el campo sandbox del config ya guardado -- confirmado real
   * que argsFor()/permissionArgs() leen this.config.sandbox FRESCO en cada
   * send() (claude-cli/antigravity-cli spawnean un proceso nuevo por
   * turno), asi que el proximo turno ya usa el valor nuevo sin reconectar.
   */
  updateSandbox(sandbox: SandboxMode): void {
    if (this.config) this.config.sandbox = sandbox
  }

  /**
   * Familia A (computer use): mismo patron EXACTO que updateSandbox() de
   * arriba -- mutacion en caliente del config ya guardado, sin reconectar
   * (cada turno CLI spawnea un proceso nuevo, asi que el proximo turno ya
   * ve el valor nuevo). Llamado desde runtime-state.ts, setComputerUseActive(),
   * para que activar/desactivar el toggle del composer se refleje en el
   * PROXIMO turno CLI sin que el usuario tenga que reconectar el panel.
   */
  updateComputerUseActive(active: boolean): void {
    if (this.config) this.config.computerUseActive = active
  }

  /** Navegador embebido: mismo patron exacto que updateComputerUseActive() de arriba. */
  updateBrowserControlActive(active: boolean): void {
    if (this.config) this.config.browserControlActive = active
  }

  /**
   * `maxTurnsCli`: mismo patron exacto que updateSandbox() de arriba --
   * mutacion en caliente del config ya guardado, sin reconectar (cada turno
   * de claude-cli spawnea un proceso nuevo, asi que el proximo turno ya ve
   * el valor nuevo). Llamado desde ipc-agent.ts antes de cada send() para que
   * cambiar el limite en Configuracion no exija reconectar el panel.
   */
  updateMaxTurns(maxTurnsCli: number | undefined): void {
    if (this.config) this.config.maxTurnsCli = maxTurnsCli
  }

  /** Valor efectivo de `--max-turns` para el turno que se esta por lanzar.
   *  Guard de validez propio (entero positivo) ademas del de settings-store.ts:
   *  nunca debe llegar `--max-turns NaN`/0/negativo al binario. */
  private maxTurns(): number {
    const value = this.config?.maxTurnsCli
    return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : DEFAULT_MAX_TURNS_CLI
  }

  /**
   * `effort` (Fase 13) SOLO aplica a Claude — se ignora por completo en
   * `sendAntigravity()` (nunca se le pasa). `agy` SI expone un `--effort`
   * real (confirmado en `--help`), pero deliberadamente sin usar aca: los
   * modelos reales de `agy` (`agy models`, ej. "gemini-3.1-pro-high"/"-low")
   * ya codifican el nivel de razonamiento en el propio id del modelo --
   * threadear un `--effort` ademas seria redundante con la eleccion de
   * modelo, no investigado si conflictua.
   */
  async send(text: string, context?: RuntimeContextEnvelope, effort?: string): Promise<CliAgentResult> {
    if (!this.config) throw new Error('Runtime CLI no configurado.')
    if (this.config.kind === 'claude') return this.sendClaude(text, context, effort)
    return this.sendAntigravity(text, context)
  }

  private buildEnv(): NodeJS.ProcessEnv {
    if (!this.config) throw new Error('Runtime CLI no configurado.')
    const provider = this.config.provider

    // Integracion de Antigravity CLI, Tarea 1 (real, no supuesta): parte de
    // antigravityIsolatedEnv() en vez de process.env crudo -- USERPROFILE/
    // HOME redirigidos a la carpeta aislada de Amatista para CUALQUIER
    // conexion antigravity, no solo para pruebas (ver docs/_arch/CONTRACT.md
    // → "Infraestructura de HOME aislado para Antigravity CLI"). authMode
    // 'subscription' confirma real que el keyring del SO sigue resolviendo
    // la sesion de cuenta con el HOME redirigido (el turno de la Tarea 2 de
    // verify_antigravity_integration.md se autentico sin pedir login, mismo
    // mecanismo ya probado en la fase anterior). authMode 'api-key' SI
    // necesita el settings.json real dentro de ese HOME -- confirmado que
    // GEMINI_API_KEY sola no alcanza.
    //
    // Fix real de HOME por conexion (docs/_arch/verify_antigravity_home_per_connection.md,
    // basado en la carrera confirmada real en verify_antigravity_authmode_race.md):
    // provider.id identifica de forma unica y estable a ESTA conexion --
    // cada conexion antigravity real ahora tiene su propia subcarpeta
    // completa bajo antigravity-home (env, settings.json, mcp_config.json),
    // nunca comparte archivo con otra conexion concurrente. writeAntigravity...()
    // se sigue llamando en LAS DOS ramas (subscription y api-key), mismo
    // motivo de siempre -- ver el comentario completo en
    // writeAntigravitySettingsForAuthMode() (antigravity-home.ts).
    if (this.config.kind === 'antigravity') {
      const env = antigravityIsolatedEnv(provider.id)
      if (provider.authMode === 'subscription') {
        delete env.GEMINI_API_KEY
        writeAntigravitySettingsForAuthMode('subscription', provider.id)
      } else {
        if (!provider.apiKey?.trim()) throw new Error('Antigravity API requiere API key.')
        env.GEMINI_API_KEY = provider.apiKey.trim()
        writeAntigravitySettingsForAuthMode('api-key', provider.id)
      }

      // Servidor MCP de LSP: `agy` es el UNICO de los 3 CLIs sin flag
      // efimero real para MCP (confirmado en verify_mcp_server.md) -- la
      // unica via es escribir DENTRO del HOME ya aislado, mismo patron que
      // writeAntigravitySettingsForAuthMode() de arriba. Sin bloquear el
      // turno si el bundle no existe todavia (mcpLspServerSpawnSpec() null).
      const mcpSpec = mcpLspServerSpawnSpec(this.config.workspace, this.config.panelId, this.config.isPrincipalChat, this.config.computerUseActive, this.config.browserControlActive)
      if (mcpSpec) writeAntigravityMcpConfig(mcpSpec.command, mcpSpec.args, mcpSpec.env, provider.id)

      return env
    }

    const env: NodeJS.ProcessEnv = { ...process.env }

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

    return env
  }

  private permissionArgs(): string[] {
    if (!this.config) return []

    if (this.config.kind === 'claude') {
      if (this.config.sandbox === 'danger-full-access') return ['--dangerously-skip-permissions']

      // Fix real del gate de permisos (docs/_arch/verify_claude_permission_
      // allowlist.md): fuera de danger-full-access, Claude denegaba las 4
      // tools MCP de LSP (solo lectura, sin aprobacion por diseno de
      // mcp-lsp-server.ts) porque acceptEdits/plan no cubren tools MCP de
      // terceros. --allowedTools con los 4 nombres EXACTOS (namespacing
      // real de MCP: mcp__<servidor>__<tool>) -- NUNCA wildcard
      // (mcp__amatista-lsp__*): confirmado real, con evidencia de multiples
      // issues abiertos en anthropics/claude-code, que el wildcard tiene
      // bugs reales y falla en silencio. Verificado real (permission_denials
      // vacio, permissionDecisionMs=0) en read-only Y en el default -- no
      // amplia nada mas alla de estas 4 tools puntuales, es un allowlist
      // por nombre exacto, no puede afectar Bash/Edit/otras tools nativas.
      // Orquestacion por suscripcion: los 2 nombres nuevos se suman a la
      // MISMA allowlist, mismo motivo exacto (acceptEdits/plan no cubren
      // tools MCP de terceros) -- solo si isPrincipalChat (Tarea 4), mismo
      // criterio que el env AMATISTA_IS_PRINCIPAL de mcpLspServerSpawnSpec():
      // un panel no-principal ni siquiera los declara en su allowlist,
      // ademas de que el servidor MCP no los registra y main los rechaza de
      // nuevo si algo igual llegara a intentarlo. Nombres EXACTOS, nunca
      // wildcard -- mismo motivo ya documentado arriba.
      const mcpLspAllowedTools = [
        '--allowedTools',
        'mcp__amatista-lsp__find_definition',
        'mcp__amatista-lsp__find_references',
        'mcp__amatista-lsp__list_symbols',
        'mcp__amatista-lsp__get_diagnostics',
        // read_image (F1): solo lectura, sin gate -- mismo motivo que las 4 de LSP (acceptEdits/plan no cubren tools MCP de
        // terceros). Solo alcanza el workspace de ESTE panel: main resuelve y confina la ruta contra la sesion viva.
        'mcp__amatista-lsp__read_image',
        // extract_video_frame (F2): mismo criterio EXACTO que read_image de arriba -- solo lectura, sin gate,
        // incondicional (no depende de ningun flag de sesion como Familia A/navegador embebido de mas abajo).
        'mcp__amatista-lsp__extract_video_frame',
        // render_3d_model (F3): mismo criterio EXACTO que read_image/extract_video_frame de arriba.
        'mcp__amatista-lsp__render_3d_model',
        // Herramientas compuestas: proponer + una entrada por receta aprobada (y con firma valida) del workspace, por
        // nombre EXACTO -- nunca wildcard, mismo motivo de arriba. Se calcula en cada turno (cada turno es un proceso
        // nuevo), asi que una receta aprobada durante un turno queda permitida desde el siguiente. Esto solo decide
        // si Claude puede LLEGAR a llamarlas: las aprobaciones de creacion y de corrida viven en main.
        'mcp__amatista-lsp__propose_composed_tool',
        ...listComposedToolDefinitions(this.config.workspace).map(def => `mcp__amatista-lsp__${def.name}`),
        ...(this.config.isPrincipalChat ? ['mcp__amatista-lsp__send_to_window', 'mcp__amatista-lsp__parallel_ask'] : []),
        // Familia A (computer use): mismo criterio exacto que la
        // orquestacion de arriba -- solo si Capa 1 (computerUseActive) esta
        // activa para ESTA conexion. La Capa 2 (hardConfirm real, siempre)
        // sigue aplicando del lado de main sin importar esta lista -- esto
        // solo decide si Claude puede LLEGAR a intentar la llamada.
        ...(this.config.computerUseActive
          ? [
              'mcp__amatista-lsp__screenshot',
              'mcp__amatista-lsp__mouse_move',
              'mcp__amatista-lsp__mouse_click',
              'mcp__amatista-lsp__keyboard_type'
            ]
          : []),
        // Navegador embebido (docs/_arch/verify_embedded_browser_design.md):
        // mismo criterio exacto que computer use -- solo si Capa 1
        // (browserControlActive) esta activa para ESTA conexion.
        ...(this.config.browserControlActive
          ? [
              'mcp__amatista-lsp__browser_navigate',
              'mcp__amatista-lsp__browser_click',
              'mcp__amatista-lsp__browser_type',
              'mcp__amatista-lsp__browser_screenshot'
            ]
          : [])
      ]

      if (this.config.sandbox === 'read-only') return ['--permission-mode', 'plan', ...mcpLspAllowedTools]
      return ['--permission-mode', 'acceptEdits', ...mcpLspAllowedTools]
    }

    // Integracion de Antigravity CLI, Tarea 3 -- REVISADO tras un hallazgo
    // real critico en la propia verificacion en vivo, distinto de lo que
    // la investigacion previa habia concluido: `--add-dir <workspace>` NO
    // confina el acceso, es una lista de PERMITIDOS que se SUMA (asi lo
    // describe el propio --help: "Add a directory to the workspace"), no
    // un limite duro. Confirmado real: con `--dangerously-skip-permissions`
    // + `--add-dir <workspace>`, un pedido de leer un archivo puntual
    // FUERA del workspace (`D:\APLICACIONES\ADISLA_205\AGENTS.md`, de otro
    // proyecto real, no relacionado) tuvo EXITO real, devolvio el contenido
    // completo -- `--add-dir` no lo impidio.
    //
    // El confinamiento real SI existe, pero en otro lugar: bajo `--mode
    // plan`/`accept-edits` (SIN --dangerously-skip-permissions), el MISMO
    // pedido de leer ese archivo fuera del workspace fue auto-denegado real
    // por `agy` -- log real: "a tool required the \"read_file\" permission
    // that headless mode cannot prompt for, so it was auto-denied." Es
    // decir: `read-only`/`workspace-write` SI quedan confinados de forma
    // real (headless no puede aprobar interactivamente un permiso fuera
    // del allow-list, así que lo deniega solo) -- `danger-full-access`
    // NO tiene ninguna confinacion real posible con los flags disponibles
    // hoy, consistente con lo que su propio nombre implica (salta TODOS
    // los permisos, sin excepcion) -- mismo perfil de riesgo que
    // `--dangerously-skip-permissions` de Claude o `yolo` de Gemini, ninguno
    // de los cuales confina tampoco. `--add-dir` se mantiene en los 3 casos
    // igual (no hace dano, y es lo que hace que `accept-edits`/`plan` sepan
    // que el workspace real esta permitido) pero la SEGURIDAD real de
    // `danger-full-access` sigue siendo "el usuario eligio explicitamente
    // full access", no una promesa de confinamiento que este flag no puede
    // cumplir.
    //
    // Deliberadamente SIN --sandbox en ninguno de los 3 casos: confirmado
    // real que funciona (un comando de shell real corrio y devolvio su
    // resultado correcto), pero tardo 193s contra 2-8s de las demas
    // corridas -- levanta una infraestructura de aislamiento real y pesada,
    // desproporcionada para el uso por defecto de esta integracion. Punto
    // de diseno abierto, no una omision.
    // 'antigravity' es el unico kind que queda aca abajo (CliAgentKind =
    // 'claude' | 'antigravity', el 'claude' explicito ya retorno arriba) --
    // fallthrough honesto, no un default generico como cuando 'gemini'
    // todavia compartia este mismo fallback (ver docs/_arch/
    // verify_gemini_cli_removal_scope.md).
    if (this.config.sandbox === 'read-only') return ['--mode', 'plan', '--add-dir', this.config.workspace]
    if (this.config.sandbox === 'danger-full-access') return ['--dangerously-skip-permissions', '--add-dir', this.config.workspace]
    return ['--mode', 'accept-edits', '--add-dir', this.config.workspace]
  }

  private sendClaude(text: string, context?: RuntimeContextEnvelope, effort?: string): Promise<CliAgentResult> {
    if (!this.config) return Promise.reject(new Error('Claude runtime no configurado.'))

    // Fase 17 Parte 2 Tarea 2: bifurcacion condicional (decision tomada y
    // justificada en su momento, ver docs/_arch/CONTRACT.md -- migrar TODO
    // sendClaude() a stream-json arriesgaba una regresion silenciosa en el
    // camino mayoritario para resolver un caso opt-in). Turno SIN imagenes:
    // ver mas abajo.
    const images = currentImageAttachments(context)
    if (images.length > 0) return this.sendClaudeWithImages(text, context, images, effort)

    const prompt = context ? formatContextEnvelope(context) : text
    // Capturado UNA vez por turno: el mismo N va al flag y al mensaje de
    // error_max_turns de mas abajo (claudeExitErrorMessage), aunque el
    // setting cambie mientras el proceso corre.
    const maxTurns = this.maxTurns()

    const args: string[] = [
      '-p', prompt,
      '--output-format', 'json',
      '--max-turns', String(maxTurns),
      // Reintegracion de claude-cli (docs/_arch/verify_claude_cli_reintegration.md,
      // Tarea 3): unico cambio real respecto al codigo pre-dec378c. Confirmado
      // real con prueba A/B (claude -p ... vs claude -p ... --no-session-persistence,
      // conteo de archivos en ~/.claude/projects/ antes/despues) -- solo aplica en
      // modo --print (este camino y el de imagenes, ambos --print), no es variable
      // de entorno, va como argv.
      '--no-session-persistence',
      ...this.permissionArgs()
    ]

    // Servidor MCP de LSP: `--mcp-config` con un JSON INLINE (confirmado
    // real en verify_mcp_server.md que --mcp-config acepta "JSON files or
    // strings", no solo archivos) -- efimero por turno, sin escribir nada a
    // disco, sin --strict-mcp-config a proposito (se SUMA a cualquier MCP
    // que el usuario ya tenga configurado por su cuenta -- claude mcp add,
    // .mcp.json de su proyecto -- nunca lo reemplaza). Sin bloquear el
    // turno si el bundle no existe todavia (mcpLspServerSpawnSpec() null).
    const mcpSpec = mcpLspServerSpawnSpec(this.config.workspace, this.config.panelId, this.config.isPrincipalChat, this.config.computerUseActive, this.config.browserControlActive)
    if (mcpSpec) args.push('--mcp-config', JSON.stringify({ mcpServers: { 'amatista-lsp': mcpSpec } }))

    if (this.config.model.trim()) args.push('--model', this.config.model.trim())
    // Bug real encontrado en la verificacion en vivo (no anticipado en el
    // diseno): --resume <sessionId> falla SIEMPRE con --no-session-persistence
    // activo -- Claude Code CLI nunca escribio esa sesion a disco, asi que
    // "--resume" no encuentra nada real que resumir ("No conversation found
    // with session ID: ..."), confirmado reproduciendo un turno de 2 pasos
    // real (texto + imagen) contra el binario real. this.sessionId ya NO se
    // usa para --resume aca (nunca funcionaria) -- la continuidad de
    // conversacion para claude-cli pasa a depender por completo de que
    // ipc-agent.ts mande el contexto COMPLETO en cada turno (ver el fix
    // simetrico en seedContext, ipc-agent.ts), no de un --resume que este
    // flag rompe de raiz.
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
        // Fix real (docs/_arch/verify_cli_clean_cancellation_design.md):
        // chequeado PRIMERO, antes del `code !== 0` generico -- code:null
        // (la firma real de "lo matamos con una señal", confirmado real
        // ayer) cae en el mismo branch que un crash real si no se
        // distingue aca. partialText vacio a proposito: stdout truncado
        // por un kill a mitad de generacion no es texto de asistente
        // confiable (a diferencia del loop API, que acumula texto real
        // turno a turno).
        if (this.cancelledByUs) {
          this.cancelledByUs = false
          reject(new TurnCancelledError(''))
          return
        }
        if (code !== 0) {
          // Fix B (verify_claude_cli_max_turns_y_error_real.md): el motivo
          // real (ej. error_max_turns) viene en stdout, no en stderr --
          // parsear ANTES del mensaje generico, mismo precedente que
          // sendAntigravity() mas abajo. Sin JSON valido -> stderr/generico.
          let failure: Record<string, unknown> | null = null
          try {
            const parsedFailure: unknown = JSON.parse(stdout)
            if (typeof parsedFailure === 'object' && parsedFailure !== null && !Array.isArray(parsedFailure)) {
              failure = parsedFailure as Record<string, unknown>
            }
          } catch {
            // stdout vacio o no-JSON: cae al stderr/generico de siempre.
          }
          reject(new Error(claudeExitErrorMessage(failure, code, stderr, maxTurns)))
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
   * contra el transporte real en su momento (no asumido).
   *
   * Parseo linea por linea (mismo patron readline que ya usaba, antes del
   * retiro de gemini-cli, sendGemini() en este archivo) -- NUNCA acumular
   * todo stdout y hacer un JSON.parse
   * unico al final: stream-json emite VARIAS lineas JSON por turno
   * (system/init, rate_limit_event, assistant, system/post_turn_summary,
   * la linea final), asi que ese string acumulado no es JSON valido. La
   * regresion exacta que se identifico en su momento: el try/catch viejo
   * la habria absorbido en silencio, devolviendo las lineas crudas como si
   * fueran la respuesta.
   *
   * La linea final se identifica por tener is_error (boolean) -- ninguna
   * de las otras lineas del stream trae ese campo, confirmado con el
   * output real. No tiene "type" propio, a diferencia de
   * system/assistant/rate_limit_event.
   */
  private sendClaudeWithImages(
    text: string,
    context: RuntimeContextEnvelope | undefined,
    images: ChatAttachment[],
    effort?: string
  ): Promise<CliAgentResult> {
    if (!this.config) return Promise.reject(new Error('Claude runtime no configurado.'))
    const promptText = context ? formatContextEnvelope(context) : text
    // Mismo criterio que sendClaude() de arriba: un unico N por turno.
    const maxTurns = this.maxTurns()

    const args: string[] = [
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      // Confirmado en vivo (Tarea 3, pre-dec378c): --print + --output-format=stream-json
      // exige --verbose o claude rechaza el proceso entero antes de leer
      // stdin ("Error: When using --print, --output-format=stream-json
      // requires --verbose") -- no es opcional para este camino.
      '--verbose',
      '--max-turns', String(maxTurns),
      // Reintegracion de claude-cli: mismo flag que sendClaude() de arriba,
      // este camino tambien corre en modo --print (ver comentario ahi).
      '--no-session-persistence',
      ...this.permissionArgs()
    ]

    // Servidor MCP de LSP: mismo mecanismo que sendClaude() (sin imagenes)
    // de arriba -- ver el comentario completo ahi.
    const mcpSpec = mcpLspServerSpawnSpec(this.config.workspace, this.config.panelId, this.config.isPrincipalChat, this.config.computerUseActive, this.config.browserControlActive)
    if (mcpSpec) args.push('--mcp-config', JSON.stringify({ mcpServers: { 'amatista-lsp': mcpSpec } }))

    if (this.config.model.trim()) args.push('--model', this.config.model.trim())
    // Mismo bug real que sendClaude() de arriba -- --resume nunca funciona
    // con --no-session-persistence activo, ver comentario completo ahi.
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
        // Fix real (docs/_arch/verify_cli_clean_cancellation_design.md):
        // mismo chequeo, mismo motivo que sendClaude() de arriba.
        if (this.cancelledByUs) {
          this.cancelledByUs = false
          reject(new TurnCancelledError(''))
          return
        }
        if (code !== 0) {
          // Fix B: mismo criterio que sendClaude() de arriba, reusando el
          // `resultRecord` que el handler 'line' ya extrae del stream (la
          // linea final con `is_error`) en vez de reparsear nada.
          reject(new Error(claudeExitErrorMessage(resultRecord, code, stderr, maxTurns)))
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

  /**
   * Integracion de Antigravity CLI, Tarea 4 (real, `verify_antigravity_
   * integration.md`): --output-format json en modo -p NO es streaming --
   * un unico objeto JSON al final de stdout, mismo patron que sendClaude()
   * (camino sin imagenes): spawn, acumular todo stdout, JSON.parse() al
   * exit. Envelope real confirmado: {conversation_id, status, response,
   * error?, duration_seconds, num_turns, usage}. status==='ERROR' (no un
   * exit code distinto de 0 -- agy sale 0 igual con status:'ERROR',
   * confirmado real con la prueba de la Tarea 1 de API key invalida) ->
   * reject con el error real del envelope, no un mensaje generico.
   *
   * --conversation <id> (equivalente real de --resume aca, confirmado en
   * --help) SI se manda -- a diferencia del bug real de claude-cli con
   * --resume/--no-session-persistence (docs/_arch/CONTRACT.md →
   * "Reintegracion completa de claude-cli"), antigravity-cli NO tiene un
   * flag de no-persistencia que rompa esto: clearAntigravityHomeDir() solo
   * corre al arrancar/cerrar la app (index.ts), nunca entre turnos de una
   * misma conexion, asi que la conversacion real sigue en disco (aislada,
   * en getAntigravityHomeDir(provider.id) -- su propia subcarpeta, HOME por
   * conexion) durante toda la vida de la sesion. No
   * verificado en vivo con una prueba A/B de 2 turnos igual de rigurosa que
   * la de claude-cli -- confirmado solo el mecanismo de continuidad en la
   * verificacion real de esta fase (turno 2 de la misma conexion), no un
   * caso de reinicio de app a mitad de conversacion.
   */
  private sendAntigravity(text: string, context?: RuntimeContextEnvelope): Promise<CliAgentResult> {
    if (!this.config) return Promise.reject(new Error('Antigravity runtime no configurado.'))
    const prompt = context ? formatContextEnvelope(context) : text

    const args: string[] = [
      '-p', prompt,
      '--output-format', 'json',
      ...this.permissionArgs()
    ]
    if (this.config.model.trim()) args.push('--model', this.config.model.trim())
    if (this.sessionId) args.push('--conversation', this.sessionId)

    return new Promise<CliAgentResult>((resolve, reject) => {
      const child = spawn(antigravityCommand(), args, {
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

      // Bug real encontrado en la verificacion en vivo (no anticipado en el
      // diseno): `agy` sale con codigo 1 en el mismo caso real que ya
      // produce un envelope JSON valido con status:'ERROR' en stdout
      // (confirmado real: una API key invalida real dio
      // {"status":"ERROR","error":"Agent execution terminated due to
      // error."} en stdout, exit code 1, stderr VACIO). Chequear
      // `code !== 0` primero (como hace sendClaude()) descartaba ese JSON
      // real sin leerlo, y rechazaba con el mensaje generico
      // "terminó con código 1" en vez del error real y mas util del
      // envelope. Fix: intentar parsear stdout PRIMERO, sin importar el
      // exit code -- solo si stdout no es JSON valido se cae al chequeo de
      // exit code de abajo (proceso realmente roto, sin ningun envelope
      // real que leer).
      child.on('exit', code => {
        this.activeProcess = null
        // Fix real (docs/_arch/verify_cli_clean_cancellation_design.md):
        // chequeado ANTES incluso del intento de JSON.parse(stdout) de
        // abajo -- si lo matamos nosotros, no corresponde arriesgarse a
        // resolver como exito genuino solo porque el stdout truncado
        // resulto parsear igual.
        if (this.cancelledByUs) {
          this.cancelledByUs = false
          reject(new TurnCancelledError(''))
          return
        }

        try {
          const parsed = JSON.parse(stdout)
          const record = asRecord(parsed)
          if (record.status === 'ERROR') {
            reject(new Error(firstString(record, ['error']) || 'Antigravity devolvió un error.'))
            return
          }
          const sessionId = firstString(record, ['conversation_id'])
          if (sessionId) this.sessionId = sessionId
          resolve({ text: firstString(record, ['response']) ?? '', sessionId, raw: parsed })
          return
        } catch {
          // stdout no es JSON valido -- cae al chequeo de exit code de abajo.
        }

        if (code !== 0) {
          reject(new Error(stderr.trim() || `Antigravity terminó con código ${String(code)}.`))
          return
        }

        resolve({ text: stdout.trim() })
      })
    })
  }

  /**
   * PIEZA 5 del fix del Hallazgo 1 (docs/_arch/verify_parallel_idle_detection_design.md,
   * Tarea 3): cancela el turno en vuelo matando el proceso activo, pero SIN
   * el reset de sessionId que hace stop() -- preserva la continuidad de
   * conversacion de Antigravity (--conversation this.sessionId, ver
   * sendAntigravity()). Matar el proceso hace fira el handler 'exit' del
   * propio send() (codigo != 0 -> reject) que ya limpia activeProcess y
   * rechaza la promesa del turno; no se toca activeProcess aca para que ese
   * handler siga siendo el unico dueño de su ciclo de vida. Devuelve true si
   * habia un turno real que matar. A diferencia de stop() (teardown completo
   * de la conexion), esto es un cancel de UN turno dejando la sesion viva.
   */
  cancelTurn(): boolean {
    if (!this.activeProcess) return false
    this.cancelledByUs = true
    try { this.activeProcess.kill() } catch {}
    return true
  }

  stop(): void {
    if (this.activeProcess) {
      try { this.activeProcess.kill() } catch {}
    }
    this.activeProcess = null
    this.sessionId = undefined
  }
}
