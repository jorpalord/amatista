import { ChildProcessWithoutNullStreams, spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { createInterface } from 'node:readline'
import { formatContextEnvelope } from './context-envelope'
import type { ProviderProfile, RuntimeContextEnvelope, SandboxMode } from '../shared/types'

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
 * Mismo patron que `claudeCommand()` (retirado en la limpieza de
 * claude-cli) resolvia para Claude -- resolver la ruta REAL del
 * ejecutable bajo el npm global de Windows evita el problema de raiz
 * (nunca pasa por cmd.exe) en vez de intentar escapar mejor el
 * argumento. Diferencia real con Claude: el entrypoint de gemini-cli es
 * un script `.js` (bundle/gemini.js), no un `.exe` -- no se puede
 * invocar solo, necesita un runtime Node. Se resuelve leyendo
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

// Limpieza de claude-cli: esta clase manejaba Claude Y Gemini con un
// parametro `kind: 'claude' | 'gemini'` -- ahora que Claude se fue, se
// mantiene la forma general (clase + `kind`) en vez de aplanarla a algo
// tipo "GeminiCliRuntime" sin parametro. Motivo real, no especulativo:
// buildEnv()/permissionArgs() YA tenian una rama por `kind` desde antes de
// esta limpieza (no es una abstraccion nueva agregada "por las dudas") --
// sacar el parametro implicaria reescribir esas dos funciones para asumir
// Gemini a secas, y volver a agregarlo si algun dia vuelve un tercer CLI
// seria mas trabajo que dejarlo. El costo de dejarlo es minimo (un
// `kind: 'gemini'` fijo en un solo lugar, `ConfigureOptions`); el costo de
// sacarlo y tener que reintroducirlo despues es mayor.
export type CliAgentKind = 'gemini'

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

export class CliAgentRuntime extends EventEmitter {
  private config: ConfigureOptions | null = null
  private sessionId?: string
  private activeProcess: ChildProcessWithoutNullStreams | null = null

  configure(options: ConfigureOptions): void {
    this.stop()
    this.config = options
    this.sessionId = undefined
  }

  async send(text: string, context?: RuntimeContextEnvelope): Promise<CliAgentResult> {
    if (!this.config) throw new Error('Runtime CLI no configurado.')
    return this.sendGemini(text, context)
  }

  private buildEnv(): NodeJS.ProcessEnv {
    if (!this.config) throw new Error('Runtime CLI no configurado.')
    const env: NodeJS.ProcessEnv = { ...process.env }
    const provider = this.config.provider

    if (provider.authMode === 'subscription') {
      delete env.GEMINI_API_KEY
      delete env.GOOGLE_API_KEY
    } else {
      if (!provider.apiKey?.trim()) throw new Error('Gemini API requiere API key.')
      env.GEMINI_API_KEY = provider.apiKey.trim()
      if (provider.endpoint?.trim()) env.GOOGLE_GEMINI_BASE_URL = provider.endpoint.trim()
    }

    return env
  }

  private permissionArgs(): string[] {
    if (!this.config) return []
    if (this.config.sandbox === 'read-only') return ['--approval-mode', 'plan']
    if (this.config.sandbox === 'danger-full-access') return ['--approval-mode', 'yolo']
    return ['--approval-mode', 'auto_edit']
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

  stop(): void {
    if (this.activeProcess) {
      try { this.activeProcess.kill() } catch {}
    }
    this.activeProcess = null
    this.sessionId = undefined
  }
}
