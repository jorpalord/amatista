// Cliente real del helper de UI Automation (C#/FlaUI) -- Familia A
// (computer use), mecanismo PRIMARIO para mouse_click/keyboard_type en
// reemplazo de coordenadas. docs/_arch/verify_flaui_helper_viability.md ya
// confirmo, con evidencia real, que un .exe self-contained (NO AOT --
// descartado con una excepcion real reproducida) corre sin depender de
// ningun runtime .NET instalado aparte en la maquina del usuario final.
//
// Modulo HOJA a proposito, mismo motivo real ya documentado en
// computer-use-actions.ts/embedded-browser.ts: sin ningun import de
// runtime-state.ts/tool-registry.ts/ipc-agent.ts/mcp-approval-pipe.ts, para
// evitar el mismo ciclo real (runtime-state -> tool-registry ->
// computer-use-actions -> este archivo -> runtime-state). `import {app}
// from 'electron'` esta permitido aca (mismo criterio que embedded-browser.ts
// importando `WebContentsView`/`BrowserWindow`) -- lo prohibido es importar
// los 4 modulos de arriba, no 'electron' en si.
//
// Proceso PERSISTENTE, UN SOLO spawn reusado para toda la vida de la app
// (mismo principio real, medido en la investigacion, que codex-client.ts:
// el costo real de arrancar el .exe la primera vez que Windows lo ve puede
// ser de varios segundos -- Windows Defender escaneandolo, no el runtime de
// .NET -- pagarlo una sola vez por sesion de Amatista, no por cada
// find_element/click/type). Arranque PEREZOSO: nunca se spawnea hasta el
// primer uso real (mismo criterio que el import dinamico de nut-js en
// computer-use-actions.ts) -- si el usuario nunca activa "Control de
// escritorio", este proceso nunca corre.
//
// Protocolo real, NDJSON flat (confirmado en vivo contra el codigo de
// produccion real, no solo el harness de la investigacion) -- deliberadamente
// NO reusa RpcStdioClient (codex-client.ts/mcp-client.ts): ese framing
// asume forma JSON-RPC real (`{id,method,params}` / `{id,result}` /
// `{id,error}`), y este protocolo es mas simple a proposito
// (`{id,cmd,...campos}` / `{id,ok,...campos}`), sin necesitar ese envoltorio
// -- duplicar el mecanismo chico de id/pending/parseo de lineas aca (en vez
// de forzar el shape) es el mismo criterio de "modulo hoja se duplica en vez
// de importar" ya establecido en mcp-lsp-server.ts/mcp-approval-pipe.ts.
//
// 2 bugs reales ya encontrados y corregidos del lado del HELPER (Program.cs,
// ver su propio comentario de cabecera) durante la investigacion -- este
// cliente escribe UTF-8 sin BOM a proposito (`Buffer.from(json + '\n',
// 'utf8')`, nunca vía un stream que pueda anteponer uno) para no
// reintroducir el primero de esos 2 bugs del lado de Node.
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface } from 'node:readline'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { app } from 'electron'

/** Mismo criterio real que mcpLspServerScriptPath() (cli-agent-runtime.ts)
 *  para binarios que viven FUERA del asar -- pero este NO nace de
 *  asarUnpack (no viene de node_modules/ ni del propio build de Amatista):
 *  es un artefacto de un build de .NET aparte, empaquetado real via
 *  `extraResources` (package.json), que copia
 *  `resources/flaui-helper/publish/` completo (el .exe MAS los 4 DLLs
 *  nativos reales de WPF que trae consigo -- D3DCompiler_47_cor3.dll/
 *  PenImc_cor3.dll/PresentationNative_cor3.dll/wpfgfx_cor3.dll, necesarios
 *  para que el .exe self-contained cargue el ensamblado Accessibility, ver
 *  el comentario de FlaUIHelper.csproj) a `<resourcesPath>/flaui-helper/`.
 *  En dev (sin empaquetar), `process.resourcesPath` apunta a los recursos
 *  PROPIOS de Electron, no al repo -- el path real en dev es
 *  `app.getAppPath()/resources/flaui-helper/publish/FlaUIHelper.exe` (donde
 *  `dotnet publish` de verdad lo dejo). `null` si no existe (dev sin correr
 *  el publish todavia, o un instalador armado sin el paso de empaquetado) --
 *  el llamador trata esto como "UIA no disponible", nunca bloquea el resto
 *  de Familia A (mismo principio que mcpLspServerScriptPath()).
 */
function resolveHelperExePath(): string | null {
  const candidate = app.isPackaged
    ? path.join(process.resourcesPath, 'flaui-helper', 'FlaUIHelper.exe')
    : path.join(app.getAppPath(), 'resources', 'flaui-helper', 'publish', 'FlaUIHelper.exe')
  return existsSync(candidate) ? candidate : null
}

export interface UiaCriteria {
  automationId?: string
  name?: string
  controlType?: string
  className?: string
}

export interface UiaElementInfo {
  automationId: string
  name: string
  controlType: string
  className?: string
  x: number
  y: number
  width: number
  height: number
}

export type UiaFindResult =
  | ({ status: 'ok' } & UiaElementInfo)
  | { status: 'not_found' | 'ambiguous'; candidates: string[] }
  | { status: 'error'; error: string }

export type UiaClickResult =
  | { status: 'ok'; automationId: string; name: string; controlType: string }
  | { status: 'not_found' | 'ambiguous'; candidates: string[] }
  | { status: 'error'; error: string }

export interface UiaTypeResult {
  status: 'ok' | 'not_found' | 'ambiguous' | 'error'
  interrupted?: boolean
  charsTyped?: number
  totalChars?: number
  automationId?: string
  name?: string
  controlType?: string
  candidates?: string[]
  error?: string
}

export interface UiaHitTestResult {
  found: boolean
  automationId?: string
  name?: string
  controlType?: string
  className?: string
  x?: number
  y?: number
  width?: number
  height?: number
}

interface PendingEntry {
  resolve: (value: Record<string, unknown>) => void
  reject: (reason: Error) => void
}

/** UNICA instancia real para toda la vida de la app -- mismo criterio que
 *  cualquier otro singleton de proceso hijo persistente de este codebase
 *  (McpManager, TerminalManager). No esta indexado por panelId a proposito:
 *  UI Automation opera sobre el escritorio REAL de Windows, no sobre un
 *  recurso propio de un panel (a diferencia de WebContentsView en
 *  embedded-browser.ts, que SI es 1:1 con un panel) -- un solo proceso
 *  helper sirve a cualquier panel con computerUseActive, sin importar
 *  cual.
 */
class FlaUiClient {
  private process: ChildProcessWithoutNullStreams | null = null
  private starting: Promise<void> | null = null
  private nextId = 1
  private readonly pending = new Map<number, PendingEntry>()

  private async ensureStarted(): Promise<void> {
    if (this.process) return
    if (this.starting) return this.starting
    this.starting = this.spawnReal()
    try {
      await this.starting
    } finally {
      this.starting = null
    }
  }

  private async spawnReal(): Promise<void> {
    const exePath = resolveHelperExePath()
    if (!exePath) {
      throw new Error(
        'El helper de UI Automation (FlaUIHelper.exe) no esta disponible en esta instalacion -- ' +
          'mouse_click/keyboard_type van a usar coordenadas directo.'
      )
    }

    const child = spawn(exePath, ['--stdio'], { windowsHide: true })
    this.process = child

    const stdout = createInterface({ input: child.stdout })
    stdout.on('line', line => {
      const trimmed = line.trim()
      if (!trimmed) return
      let parsed: Record<string, unknown>
      try {
        parsed = JSON.parse(trimmed) as Record<string, unknown>
      } catch {
        return
      }
      const id = typeof parsed.id === 'number' ? parsed.id : undefined
      if (id === undefined) return
      const entry = this.pending.get(id)
      if (!entry) return
      this.pending.delete(id)
      entry.resolve(parsed)
    })

    const stderr = createInterface({ input: child.stderr })
    stderr.on('line', () => {
      // Sin logging propio real todavia -- el helper solo escribe a stderr
      // si nunca llego a arrancar el modo --stdio (uso incorrecto), caso ya
      // cubierto por el chequeo `args[0] !== '--stdio'` del propio Program.cs.
    })

    child.on('exit', () => {
      const error = new Error('FlaUIHelper.exe termino inesperadamente.')
      for (const entry of this.pending.values()) entry.reject(error)
      this.pending.clear()
      this.process = null
    })
    child.on('error', () => {
      this.process = null
    })

    await new Promise<void>((resolve, reject) => {
      child.once('spawn', () => resolve())
      child.once('error', err => reject(err))
    })
  }

  private send(cmd: string, fields: Record<string, unknown>, timeoutMs = 15_000): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      this.ensureStarted()
        .then(() => {
          if (!this.process) {
            reject(new Error('El helper de UI Automation no esta disponible.'))
            return
          }
          const id = this.nextId++
          this.pending.set(id, { resolve, reject })
          const line = JSON.stringify({ id, cmd, ...fields })
          // UTF-8 SIN BOM explicito, nunca vía un writer que pueda anteponer
          // uno -- mismo motivo real documentado en el bug 1 ya corregido
          // del lado del helper (ver Program.cs).
          this.process.stdin.write(Buffer.from(`${line}\n`, 'utf8'))
          if (timeoutMs > 0) {
            setTimeout(() => {
              if (this.pending.has(id)) {
                this.pending.delete(id)
                reject(new Error(`Timeout esperando respuesta real del helper de UI Automation ("${cmd}").`))
              }
            }, timeoutMs)
          }
        })
        .catch(reject)
    })
  }

  /** Cancelacion real de un `type` en curso -- manda un comando `cancel`
   *  aparte (nueva linea NDJSON, id propio) que el helper procesa en un
   *  Task.Run CONCURRENTE al del `type` original (Program.cs, HandleLine())
   *  -- funciona solo porque el helper despacha cada linea entrante en su
   *  propio hilo, nunca secuencial. Best-effort: si el helper ya no esta
   *  vivo, no hay nada que cancelar, no es un error real. */
  private cancel(targetId: number): void {
    if (!this.process) return
    const id = this.nextId++
    const line = JSON.stringify({ id, cmd: 'cancel', targetId })
    try {
      this.process.stdin.write(Buffer.from(`${line}\n`, 'utf8'))
    } catch {
      // proceso ya cerrado a mitad de camino -- best-effort, sin romper nada.
    }
  }

  /** find_element(criteria) real -- busqueda semantica pura, sin accionar
   *  nada (usado para diagnostico/inventario, no consumido hoy por ningun
   *  tool-facing case pero disponible real en el protocolo, mismo criterio
   *  que get_tree()/hit_test()). */
  async findElement(criteria: UiaCriteria): Promise<UiaFindResult> {
    const res = await this.send('find_element', criteria as Record<string, unknown>)
    return this.toFindResult(res)
  }

  /** get_tree(criteria?) real -- children del elemento real que matchea
   *  `criteria`, o de la ventana REAL en primer plano si se omite. */
  async getTree(criteria?: UiaCriteria): Promise<
    | { status: 'ok'; root: UiaElementInfo; children: UiaElementInfo[] }
    | { status: 'not_found' | 'ambiguous'; candidates: string[] }
    | { status: 'error'; error: string }
  > {
    const res = await this.send('get_tree', (criteria ?? {}) as Record<string, unknown>)
    if (res.ok === false) return { status: 'error', error: String(res.error ?? 'Fallo desconocido.') }
    if (res.status === 'not_found' || res.status === 'ambiguous') {
      return { status: res.status, candidates: (res.candidates as string[] | undefined) ?? [] }
    }
    return { status: 'ok', root: res.root as UiaElementInfo, children: (res.children as UiaElementInfo[] | undefined) ?? [] }
  }

  /** click(criteria) real, atomico -- resolucion + click en el MISMO
   *  round-trip (Program.cs, HandleClick()), inmune a que la ventana real se
   *  haya movido/redimensionado entre que el modelo decidio el target
   *  semantico y este comando corre -- confirmado real en la investigacion y
   *  reverificado contra el codigo de produccion real. */
  async click(criteria: UiaCriteria, button: 'left' | 'right' = 'left'): Promise<UiaClickResult> {
    const res = await this.send('click', { ...criteria, button } as Record<string, unknown>)
    if (res.ok === false) return { status: 'error', error: String(res.error ?? 'Fallo desconocido.') }
    if (res.status === 'not_found' || res.status === 'ambiguous') {
      return { status: res.status, candidates: (res.candidates as string[] | undefined) ?? [] }
    }
    if (res.status === 'error') return { status: 'error', error: String(res.error ?? 'Fallo desconocido haciendo click.') }
    return {
      status: 'ok',
      automationId: String(res.automationId ?? ''),
      name: String(res.name ?? ''),
      controlType: String(res.controlType ?? '')
    }
  }

  /** type(criteria, text) real -- resuelve+enfoca UNA vez y despues escribe
   *  caracter por caracter (Program.cs, HandleType()), chequeando
   *  cancelacion ENTRE cada uno -- mismo principio real de micro-pasos que
   *  typeText() (computer-use-actions.ts) ya usa con nut-js. `signal`
   *  opcional: si se aborta a mitad de camino, este cliente manda un
   *  `cancel` real hacia el helper (ver cancel() arriba) -- el helper
   *  interrumpe el loop en el proximo caracter, nunca a mitad de uno ya en
   *  curso (un caracter no tiene "a mitad de camino" util que cancelar). */
  async type(criteria: UiaCriteria, text: string, signal?: AbortSignal): Promise<UiaTypeResult> {
    await this.ensureStarted()
    const id = this.nextId++
    const responsePromise = new Promise<Record<string, unknown>>((resolve, reject) => {
      if (!this.process) {
        reject(new Error('El helper de UI Automation no esta disponible.'))
        return
      }
      this.pending.set(id, { resolve, reject })
      const line = JSON.stringify({ id, cmd: 'type', ...criteria, text })
      this.process.stdin.write(Buffer.from(`${line}\n`, 'utf8'))
    })

    const onAbort = (): void => this.cancel(id)
    signal?.addEventListener('abort', onAbort)
    try {
      const res = await responsePromise
      if (res.ok === false) return { status: 'error', error: String(res.error ?? 'Fallo desconocido.') }
      return {
        status: (res.status as UiaTypeResult['status']) ?? 'ok',
        interrupted: Boolean(res.interrupted),
        charsTyped: typeof res.charsTyped === 'number' ? res.charsTyped : undefined,
        totalChars: typeof res.totalChars === 'number' ? res.totalChars : undefined,
        automationId: res.automationId !== undefined ? String(res.automationId) : undefined,
        name: res.name !== undefined ? String(res.name) : undefined,
        controlType: res.controlType !== undefined ? String(res.controlType) : undefined,
        candidates: (res.candidates as string[] | undefined) ?? undefined,
        error: res.error !== undefined ? String(res.error) : undefined
      }
    } finally {
      signal?.removeEventListener('abort', onAbort)
    }
  }

  /** hit_test(x,y) real via FromPoint -- bonus real de la investigacion,
   *  disponible como diagnostico real para el fallback de coordenadas
   *  (contenido no-semantico real) -- ver el comentario completo en
   *  computer-use-actions.ts, describeHitTestForCoordinateClick(). */
  async hitTest(x: number, y: number): Promise<UiaHitTestResult> {
    const res = await this.send('hit_test', { x, y })
    if (res.ok === false || !res.found) return { found: false }
    return {
      found: true,
      automationId: res.automationId !== undefined ? String(res.automationId) : undefined,
      name: res.name !== undefined ? String(res.name) : undefined,
      controlType: res.controlType !== undefined ? String(res.controlType) : undefined,
      className: res.className !== undefined ? String(res.className) : undefined,
      x: typeof res.x === 'number' ? res.x : undefined,
      y: typeof res.y === 'number' ? res.y : undefined,
      width: typeof res.width === 'number' ? res.width : undefined,
      height: typeof res.height === 'number' ? res.height : undefined
    }
  }

  private toFindResult(res: Record<string, unknown>): UiaFindResult {
    if (res.ok === false) return { status: 'error', error: String(res.error ?? 'Fallo desconocido.') }
    if (res.status === 'not_found' || res.status === 'ambiguous') {
      return { status: res.status, candidates: (res.candidates as string[] | undefined) ?? [] }
    }
    return {
      status: 'ok',
      automationId: String(res.automationId ?? ''),
      name: String(res.name ?? ''),
      controlType: String(res.controlType ?? ''),
      className: String(res.className ?? ''),
      x: Number(res.x ?? 0),
      y: Number(res.y ?? 0),
      width: Number(res.width ?? 0),
      height: Number(res.height ?? 0)
    }
  }

  /** Solo para limpieza de tests/verificacion real -- produccion nunca lo
   *  llama (el proceso vive toda la sesion de Amatista, mismo criterio que
   *  McpManager/TerminalManager). */
  stop(): void {
    if (!this.process) return
    try {
      this.process.kill()
    } catch {
      // ya muerto -- no es un error real.
    }
    this.process = null
  }
}

/** Singleton real, perezoso (la CLASE arranca su proceso hijo recien en el
 *  primer send() real, nunca al importar este modulo). */
export const flaUiClient = new FlaUiClient()
