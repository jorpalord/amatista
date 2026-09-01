import { ChildProcessWithoutNullStreams, spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { createInterface } from 'node:readline'
import { formatContextEnvelope } from './context-envelope'
import { antigravityIsolatedEnv, writeAntigravitySettingsForAuthMode } from './antigravity-home'
import type { ChatAttachment, ProviderProfile, RuntimeContextEnvelope, SandboxMode } from '../shared/types'

/**
 * Fix real de Gemini (investigacion previa en docs/_arch/CONTRACT.md,
 * confirmada con reproduccion en vivo, no asumida): 'gemini' en Windows
 * resuelve al shim que genera `npm install -g` (`gemini.cmd`), que
 * spawn() NO puede invocar sin `shell:true` -- y `shell:true` a su vez
 * CONCATENA el array de args en una sola linea de comando en vez de
 * citarlos, asi que un prompt multilinea real (formatContextEnvelope())
 * se parte en decenas de argv sueltos para cmd.exe. Gemini CLI ve
 * entonces un `-p` con SOLO el primer fragmento, y el resto del prompt
 * reinterpretado como argumentos posicionales -- exactamente el error
 * reproducido: "Cannot use both a positional prompt and the --prompt
 * (-p) flag together".
 *
 * Mismo patron que `claudeCommand()` (mas abajo) resuelve para Claude --
 * resolver la ruta REAL del ejecutable bajo el npm global de Windows
 * evita el problema de raiz (nunca pasa por cmd.exe) en vez de intentar
 * escapar mejor el argumento. Diferencia real con Claude: el entrypoint
 * de gemini-cli es un script `.js` (bundle/gemini.js), no un `.exe` -- no
 * se puede invocar solo, necesita un runtime Node. Se resuelve leyendo
 * `package.json.bin.gemini` del paquete real, EN VEZ de hardcodear la
 * ruta relativa ("bundle/gemini.js") -- mas robusto a que una version
 * futura de @google/gemini-cli reestructure su bundle interno: el campo
 * `bin` es el contrato publico que el propio npm usa para generar su
 * shim .cmd, garantizado estable mientras el paquete siga exponiendo el
 * comando `gemini` (a diferencia de la estructura interna de `bundle/`,
 * que sí cambia de version a version -- confirmado real: los nombres de
 * chunk-XXXX.js de esta instalacion no son deterministicos).
 *
 * Spawneado con `process.execPath` + `ELECTRON_RUN_AS_NODE:'1'`,
 * `shell:false` -- MISMO patron exacto, ya probado en produccion, que
 * `lsp-client.ts` (Fase 20) usa para `typescript-language-server`: evita
 * depender de que el usuario tenga `node` en el PATH del sistema (el
 * propio Electron ya trae un runtime Node completo).
 *
 * Fallback si no se puede resolver (paquete no instalado bajo el npm
 * global esperado, APPDATA ausente, o plataforma no-Windows): `null` --
 * sendGemini() cae al mecanismo viejo (`spawn('gemini', ...)` con
 * `shell` condicionado a la plataforma), igual que el comportamiento de
 * SIEMPRE de esta app antes de este fix. En plataformas no-Windows este
 * problema no existe (no hay `.cmd`/cmd.exe de por medio -- `spawn()`
 * sin shell ya invoca directo el shebang real del binario `gemini`).
 */
function geminiCommand(): string | null {
  if (process.platform !== 'win32') return null
  const appData = process.env.APPDATA
  if (!appData) return null

  try {
    const pkgDir = path.join(appData, 'npm', 'node_modules', '@google', 'gemini-cli')
    const pkgJson = JSON.parse(readFileSync(path.join(pkgDir, 'package.json'), 'utf8')) as { bin?: Record<string, string> }
    const relative = pkgJson.bin?.gemini
    if (!relative) return null

    const entry = path.join(pkgDir, relative)
    return existsSync(entry) ? entry : null
  } catch {
    return null
  }
}

// Reintegracion de Claude Code CLI (docs/_arch/verify_claude_cli_reintegration.md):
// restauracion casi literal del codigo retirado en dec378c -- 'claude' vuelve
// al union de CliAgentKind, mismo motivo por el que se dejo la forma general
// (clase + `kind`) cuando se retiro (comentado en su momento en dec378c):
// buildEnv()/permissionArgs() vuelven a bifurcar por kind, sendClaude()/
// sendClaudeWithImages() vuelven completas. Unica diferencia real respecto al
// codigo pre-dec378c: --no-session-persistence agregado a los 2 args: string[]
// de Claude (Tarea 3 de la investigacion) -- Gemini no tiene un flag
// equivalente confirmado, sin tocar.
//
// Integracion de Antigravity CLI (docs/_arch/verify_antigravity_cli.md,
// verify_antigravity_integration.md): 'antigravity' se suma al union --
// mismo patron spawn+stdout que Gemini (confirmado real: NO es
// app-server/JSON-RPC como Codex), sendAntigravity() nueva mas abajo.
export type CliAgentKind = 'claude' | 'gemini' | 'antigravity'

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

function claudeCommand(): string {
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
function antigravityCommand(): string {
  if (process.platform !== 'win32') return 'agy'

  const localAppData = process.env.LOCALAPPDATA
  if (localAppData) {
    const exe = path.join(localAppData, 'agy', 'bin', 'agy.exe')
    if (existsSync(exe)) return exe
  }

  return 'agy'
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
   * equivalente soportado en Gemini CLI headless todavia. `agy` SI expone
   * un `--effort` real (confirmado en `--help`), pero deliberadamente sin
   * usar aca: los modelos reales de `agy` (`agy models`, ej.
   * "gemini-3.1-pro-high"/"-low") ya codifican el nivel de razonamiento en
   * el propio id del modelo -- threadear un `--effort` ademas seria
   * redundante con la eleccion de modelo, no investigado si conflictua.
   */
  async send(text: string, context?: RuntimeContextEnvelope, effort?: string): Promise<CliAgentResult> {
    if (!this.config) throw new Error('Runtime CLI no configurado.')
    if (this.config.kind === 'claude') return this.sendClaude(text, context, effort)
    if (this.config.kind === 'antigravity') return this.sendAntigravity(text, context)
    return this.sendGemini(text, context)
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
    // Bug real encontrado en la verificacion en vivo: writeAntigravity...()
    // se llama en LAS DOS ramas ahora, no solo 'api-key' -- getAntigravityHomeDir()
    // es una sola carpeta compartida por TODA la app; si una conexion
    // api-key corrio antes y dejo modelProvider:'gemini' escrito, un turno
    // subscription posterior en la MISMA carpeta fallaba real (agy
    // rechazaba el turno: "modelProvider is set... but GEMINI_API_KEY...
    // is not set"). Ver el comentario completo en
    // writeAntigravitySettingsForAuthMode() (antigravity-home.ts).
    if (this.config.kind === 'antigravity') {
      const env = antigravityIsolatedEnv()
      if (provider.authMode === 'subscription') {
        delete env.GEMINI_API_KEY
        writeAntigravitySettingsForAuthMode('subscription')
      } else {
        if (!provider.apiKey?.trim()) throw new Error('Antigravity API requiere API key.')
        env.GEMINI_API_KEY = provider.apiKey.trim()
        writeAntigravitySettingsForAuthMode('api-key')
      }
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
    if (this.config.kind === 'antigravity') {
      if (this.config.sandbox === 'read-only') return ['--mode', 'plan', '--add-dir', this.config.workspace]
      if (this.config.sandbox === 'danger-full-access') return ['--dangerously-skip-permissions', '--add-dir', this.config.workspace]
      return ['--mode', 'accept-edits', '--add-dir', this.config.workspace]
    }

    if (this.config.sandbox === 'read-only') return ['--approval-mode', 'plan']
    if (this.config.sandbox === 'danger-full-access') return ['--approval-mode', 'yolo']
    return ['--approval-mode', 'auto_edit']
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

    const args: string[] = [
      '-p', prompt,
      '--output-format', 'json',
      '--max-turns', '20',
      // Reintegracion de claude-cli (docs/_arch/verify_claude_cli_reintegration.md,
      // Tarea 3): unico cambio real respecto al codigo pre-dec378c. Confirmado
      // real con prueba A/B (claude -p ... vs claude -p ... --no-session-persistence,
      // conteo de archivos en ~/.claude/projects/ antes/despues) -- solo aplica en
      // modo --print (este camino y el de imagenes, ambos --print), no es variable
      // de entorno, va como argv.
      '--no-session-persistence',
      ...this.permissionArgs()
    ]

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
   * contra el transporte real en su momento (no asumido).
   *
   * Parseo linea por linea (mismo patron readline que ya usa sendGemini()
   * en este archivo) -- NUNCA acumular todo stdout y hacer un JSON.parse
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

    const args: string[] = [
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      // Confirmado en vivo (Tarea 3, pre-dec378c): --print + --output-format=stream-json
      // exige --verbose o claude rechaza el proceso entero antes de leer
      // stdin ("Error: When using --print, --output-format=stream-json
      // requires --verbose") -- no es opcional para este camino, a
      // diferencia de sendGemini() donde --verbose no hace falta.
      '--verbose',
      '--max-turns', '20',
      // Reintegracion de claude-cli: mismo flag que sendClaude() de arriba,
      // este camino tambien corre en modo --print (ver comentario ahi).
      '--no-session-persistence',
      ...this.permissionArgs()
    ]
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

    // Fix real del bug de arg-splitting (ver geminiCommand() arriba,
    // investigacion completa en docs/_arch/CONTRACT.md): si se puede
    // resolver la ruta real del entrypoint, se spawnea con
    // process.execPath (Node de Electron) + ELECTRON_RUN_AS_NODE,
    // shell:false -- el prompt llega intacto, un solo argv, nunca pasa
    // por cmd.exe. Si no se puede resolver (fallback), se preserva el
    // mecanismo viejo tal cual (bare 'gemini', shell condicionado a la
    // plataforma) -- mismo comportamiento de siempre, no una regresion.
    const geminiEntry = geminiCommand()
    const spawnCommand = geminiEntry ? process.execPath : 'gemini'
    const spawnArgs = geminiEntry ? [geminiEntry, ...args] : args
    const spawnEnv = geminiEntry
      ? { ...this.buildEnv(), ELECTRON_RUN_AS_NODE: '1' }
      : this.buildEnv()

    return new Promise<CliAgentResult>((resolve, reject) => {
      const child = spawn(spawnCommand, spawnArgs, {
        cwd: this.config!.workspace,
        env: spawnEnv,
        windowsHide: true,
        shell: geminiEntry ? false : process.platform === 'win32'
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
   * en getAntigravityHomeDir()) durante toda la vida de la sesion. No
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

  stop(): void {
    if (this.activeProcess) {
      try { this.activeProcess.kill() } catch {}
    }
    this.activeProcess = null
    this.sessionId = undefined
  }
}
