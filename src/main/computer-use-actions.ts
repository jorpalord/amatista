// Familia A (computer use), mecanica REAL de mouse/teclado/captura de
// pantalla -- docs/_arch/verify_computer_use_security_model.md +
// verify_computer_use_cli_extension.md, ambos ya aprobados por el usuario
// antes de escribir este archivo.
//
// Modulo HOJA a proposito, sin ningun import de runtime-state.ts/tool-
// registry.ts/ipc-agent.ts/mcp-approval-pipe.ts -- mismo motivo real ya
// documentado en parallel-orchestrator.ts/cross-window-messaging.ts para
// evitar ciclos: runtime-state.ts importa tool-registry.ts (para el
// singleton toolRegistry), asi que si ESTE archivo importara runtime-
// state.ts Y tool-registry.ts importara este archivo (que SI hace, para
// ejecutar las 4 tools nativas), el ciclo se cerraria (tool-registry ->
// computer-use-actions -> runtime-state -> tool-registry). Por eso las
// funciones de aca son PURAS: reciben todo lo que necesitan por parametro
// (coordenadas, texto, un AbortSignal opcional), nunca leen sessionRegistry
// ni ningun estado de sesion -- el gate (computerUseActive), la aprobacion
// (hardConfirm) y el indicador visual/arm-tracking viven en runtime-state.ts,
// quien llama a estas funciones DESPUES de resolver todo eso.
//
// mouse_move/mouse_click: PowerShell + user32 (Add-Type al vuelo), MISMO
// mecanismo ya validado real en verify_windows_control_design.md (A3) --
// deliberadamente NO nut-js para el mouse (SendKeys si fallo en silencio
// para teclado, pero PowerShell+user32 para mouse funciono limpio, sin
// motivo real para cambiarlo). keyboard_type: nut-js
// (@nut-tree-fork/nut-js), el UNICO mecanismo de tipeo validado que no
// falla en silencio (SendKeys si fallaba, confirmado real).
//
// docs/_arch/verify_flaui_helper_viability.md (ya confirmado y aprobado):
// UI Automation (helper C#/FlaUI, flaui-client.ts) pasa a ser el mecanismo
// PRIMARIO real para click/type -- resuelve un control real de Windows por
// nombre/tipo (semantico, inmune a que la ventana se haya movido/
// redimensionado entre que el modelo decide el target y la accion corre,
// mismo principio ya probado para el navegador embebido con DOM/texto).
// Coordenadas (clickAt/typeText, mas abajo) quedan como FALLBACK EXPLICITO,
// sin ningun cambio de comportamiento -- para contenido real no-semantico
// (el canvas de Paint, por ejemplo, expone un arbol UIA sin sustancia util
// para interactuar). `flaUiClient` es un modulo hoja separado (mismo motivo
// real que WebContentsView vive en embedded-browser.ts, no aca) -- importado
// aca, no reimportado en tool-registry.ts/mcp-approval-pipe.ts, para que
// este archivo siga siendo el UNICO dueno real de "como pasa fisicamente
// un click/tipeo de Familia A".
//
// Cancelacion no-cooperativa (docs/_arch/verify_computer_use_security_model.md,
// Tarea 5): cada funcion de movimiento/tipeo real es una secuencia de
// MICRO-PASOS cortos (un SetCursorPos por paso de interpolacion, un
// caracter por llamada a keyboard.type()) con un chequeo de
// `signal.aborted` ANTES de cada paso -- si ya esta abortado, corta ahi
// mismo (deja el mouse/tipeo a mitad de camino, nunca completa la
// secuencia), consistente con el pedido explicito de que la cancelacion
// interrumpa a mitad de una secuencia, no solo entre tool calls completas.
import { desktopCapturer, screen } from 'electron'
import { execFile } from 'node:child_process'
import { flaUiClient } from './flaui-client'

const POWERSHELL_TIMEOUT_MS = 15_000

/** Mismo patron real que runPowerShell() (tool-registry.ts, Familia B) --
 *  duplicado a proposito, no importado: tool-registry.ts no es un modulo
 *  hoja (arrastra VCS/generacion de imagenes/lectura de documentos), este
 *  archivo si tiene que serlo (ver comentario de cabecera). execFile con
 *  args array, SIN pasar por una shell -- mismo motivo de siempre
 *  (runGitGrep, tool-registry.ts): el script nunca se interpola dentro de
 *  un string de shell. */
function runPowerShellScript(script: string): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return new Promise(resolve => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { timeout: POWERSHELL_TIMEOUT_MS, windowsHide: true, maxBuffer: 10 * 1024 * 1024 },
      (error, stdout, stderr) => resolve({ ok: !error, stdout, stderr })
    )
  })
}

/** Add-Type real de user32 -- mismas 3 funciones que ya uso Familia B para
 *  volume() (keybd_event) mas GetCursorPos/SetCursorPos/mouse_event, todas
 *  reales, confirmadas en verify_windows_control_design.md A3. Repetido en
 *  el script de cada llamada (proceso PowerShell nuevo por micro-paso, sin
 *  estado compartido entre invocaciones) -- Add-Type es idempotente dentro
 *  de un mismo proceso, pero cada `execFile` es un proceso nuevo, asi que
 *  hace falta declararlo de nuevo cada vez. */
const USER32_TYPE_DEF =
  'Add-Type -TypeDefinition \'using System.Runtime.InteropServices; ' +
  'public struct POINT { public int X; public int Y; } ' +
  'public class User32 { ' +
  '[DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p); ' +
  '[DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y); ' +
  '[DllImport("user32.dll")] public static extern void mouse_event(uint flags, int dx, int dy, uint data, System.UIntPtr extra); ' +
  '[DllImport("user32.dll")] public static extern System.IntPtr GetForegroundWindow(); ' +
  '[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(System.IntPtr hWnd, out uint pid); ' +
  '}\';'

export interface Point { x: number; y: number }

export async function getCursorPosition(): Promise<Point> {
  const result = await runPowerShellScript(
    `${USER32_TYPE_DEF} $p = New-Object POINT; [User32]::GetCursorPos([ref]$p) | Out-Null; Write-Output "$($p.X),$($p.Y)"`
  )
  const match = /(-?\d+),(-?\d+)/.exec(result.stdout)
  if (!match) throw new Error('No se pudo leer la posicion real del cursor.')
  return { x: Number(match[1]), y: Number(match[2]) }
}

async function setCursorPosition(point: Point): Promise<void> {
  await runPowerShellScript(`${USER32_TYPE_DEF} [User32]::SetCursorPos(${Math.round(point.x)}, ${Math.round(point.y)}) | Out-Null`)
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * Tarea 7 de verify_computer_use_security_model.md -- guardia real, no solo
 * comentario: confirma el proceso REAL en foco antes de un click/tecleo, y
 * rechaza de raiz si es `consent.exe` (el proceso REAL del dialogo de UAC
 * en Windows). Windows YA bloquea la inyeccion de input sintetico contra el
 * Secure Desktop donde corre UAC (conocimiento general, no verificable
 * desde aca) -- este chequeo es la declaracion EXPLICITA del lado de
 * Amatista que el propio diseño exige (nunca confiar en silencio en el
 * bloqueo ajeno). No es infalible (una carrera real entre este chequeo y
 * el click real es tecnicamente posible, ventana angosta) -- es defensa en
 * profundidad, no la unica linea real de defensa (esa es el propio SO).
 */
export async function isUacForeground(): Promise<boolean> {
  const result = await runPowerShellScript(
    `${USER32_TYPE_DEF} $h = [User32]::GetForegroundWindow(); $pid = 0; [User32]::GetWindowThreadProcessId($h, [ref]$pid) | Out-Null; ` +
      '(Get-Process -Id $pid -ErrorAction SilentlyContinue).ProcessName'
  )
  return result.stdout.trim().toLowerCase() === 'consent'
}

export interface MicroStepResult {
  point: Point
  interrupted: boolean
}

/**
 * Interpolacion real en micro-pasos (Tarea 5 del diseño aprobado) -- entre
 * 3 y 10 pasos segun distancia real (clamp, no una constante fija: un
 * movimiento de 20px no necesita 10 pasos, uno de 2000px si se beneficia
 * de mas), ~25ms de por medio (perceptible/chequeable, sin hacer lento de
 * mas un movimiento real). Chequea `signal.aborted` ANTES de cada
 * SetCursorPos -- si ya esta abortado, corta ahi, deja el cursor donde
 * esta (nunca completa el movimiento).
 */
export async function moveMouseTo(target: Point, signal?: AbortSignal): Promise<MicroStepResult> {
  const start = await getCursorPosition()
  const distance = Math.hypot(target.x - start.x, target.y - start.y)
  const steps = Math.max(3, Math.min(10, Math.ceil(distance / 80)))
  let current = start
  for (let i = 1; i <= steps; i++) {
    if (signal?.aborted) return { point: current, interrupted: true }
    const t = i / steps
    current = { x: start.x + (target.x - start.x) * t, y: start.y + (target.y - start.y) * t }
    await setCursorPosition(current)
    if (i < steps) await sleep(25)
  }
  return { point: current, interrupted: false }
}

export type MouseButton = 'left' | 'right'

/** MOUSEEVENTF_* reales (winuser.h) -- left down/up = 0x02/0x04, right
 *  down/up = 0x08/0x10, confirmados en verify_windows_control_design.md A3. */
const MOUSE_DOWN_FLAG: Record<MouseButton, number> = { left: 0x0002, right: 0x0008 }
const MOUSE_UP_FLAG: Record<MouseButton, number> = { left: 0x0004, right: 0x0010 }

export interface ClickResult extends MicroStepResult {
  blockedByUac: boolean
}

/**
 * Mueve (micro-pasos cancelables, ver moveMouseTo) y despues hace
 * down+up real del boton pedido -- SOLO si el movimiento no fue
 * interrumpido Y el foco real no es un dialogo de UAC (Tarea 7). El
 * down/up en si NO se trocea en micro-pasos (es instantaneo por
 * naturaleza, un click real no tiene "a mitad de camino" util que
 * cancelar) -- el chequeo de cancelacion que importa de verdad es el del
 * movimiento previo.
 */
export async function clickAt(target: Point, button: MouseButton, signal?: AbortSignal): Promise<ClickResult> {
  const move = await moveMouseTo(target, signal)
  if (move.interrupted) return { ...move, blockedByUac: false }
  if (await isUacForeground()) return { ...move, blockedByUac: true }
  if (signal?.aborted) return { ...move, interrupted: true, blockedByUac: false }
  await runPowerShellScript(
    `${USER32_TYPE_DEF} [User32]::mouse_event(${MOUSE_DOWN_FLAG[button]}, 0, 0, 0, [System.UIntPtr]::Zero); ` +
      `Start-Sleep -Milliseconds 30; ` +
      `[User32]::mouse_event(${MOUSE_UP_FLAG[button]}, 0, 0, 0, [System.UIntPtr]::Zero)`
  )
  return { ...move, blockedByUac: false }
}

export interface TypeResult {
  charsTyped: number
  totalChars: number
  interrupted: boolean
  blockedByUac: boolean
}

/**
 * nut-js real (confirmado en verify_windows_control_design.md A3: unico
 * mecanismo de tipeo que NO falla en silencio, a diferencia de SendKeys) --
 * import DINAMICO adentro de la funcion, no estatico arriba del archivo:
 * cargar el binario nativo de nut-js en el arranque de main (via un import
 * estatico de este modulo, que tool-registry.ts SI importa siempre) seria
 * costo/riesgo pagado en cada arranque de Amatista aunque Familia A nunca
 * se use -- el import perezoso lo paga solo la primera vez que de verdad
 * se llama a keyboard_type.
 *
 * Caracter por caracter (no keyboard.type(textoCompleto) de una), con
 * chequeo de `signal.aborted` ANTES de cada caracter -- mismo principio de
 * micro-pasos que moveMouseTo(), aplicado a tipeo.
 */
export async function typeText(text: string, signal?: AbortSignal): Promise<TypeResult> {
  if (await isUacForeground()) return { charsTyped: 0, totalChars: text.length, interrupted: false, blockedByUac: true }
  const { keyboard } = await import('@nut-tree-fork/nut-js')
  let charsTyped = 0
  for (const char of text) {
    if (signal?.aborted) return { charsTyped, totalChars: text.length, interrupted: true, blockedByUac: false }
    await keyboard.type(char)
    charsTyped++
  }
  return { charsTyped, totalChars: text.length, interrupted: false, blockedByUac: false }
}

export interface ScreenshotResult {
  dataUrl: string
  mimeType: string
  width: number
  height: number
  displayCount: number
}

/**
 * desktopCapturer real (confirmado en verify_windows_control_design.md A1:
 * captura el escritorio completo sin dialogo de permiso de Windows) --
 * `display` 1-indexado (mismo criterio "para humanos" que list_symbols/
 * read_document ya usan para "pagina"), default = display PRIMARIO.
 * `thumbnailSize` pedido al tamaño REAL del monitor (size * scaleFactor) --
 * sin esto, desktopCapturer devuelve una miniatura chica por default,
 * inutil para que el modelo lea texto/ubique elementos con precision.
 */
export async function takeScreenshot(display?: number): Promise<ScreenshotResult> {
  const displays = screen.getAllDisplays()
  const target = typeof display === 'number' && display >= 1 && display <= displays.length
    ? displays[display - 1]
    : screen.getPrimaryDisplay()
  const scaleFactor = target.scaleFactor || 1
  const width = Math.round(target.size.width * scaleFactor)
  const height = Math.round(target.size.height * scaleFactor)

  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width, height } })
  const source = sources.find(s => s.display_id === String(target.id)) ?? sources[0]
  if (!source) throw new Error('No se pudo capturar ningun monitor real.')

  return {
    dataUrl: source.thumbnail.toDataURL(),
    mimeType: 'image/png',
    width: source.thumbnail.getSize().width,
    height: source.thumbnail.getSize().height,
    displayCount: displays.length
  }
}

export interface UiaActionResult {
  status: 'ok' | 'not_found' | 'ambiguous' | 'error'
  automationId?: string
  name?: string
  controlType?: string
  candidates?: string[]
  error?: string
}

export interface UiaTypeActionResult extends UiaActionResult {
  interrupted?: boolean
  charsTyped?: number
  totalChars?: number
}

/**
 * click(criteria) real por nombre/tipo de control real de Windows --
 * mecanismo PRIMARIO de mouse_click cuando el modelo pasa "description" en
 * vez de "x"/"y" (tool-registry.ts/mcp-approval-pipe.ts). Resolucion +
 * click en el MISMO round-trip del lado del helper (flaui-client.ts,
 * HandleClick() real en Program.cs) -- nunca expone coordenadas de este
 * lado. Si el helper no esta disponible (instalacion sin el binario, o
 * proceso que nunca pudo arrancar), la promesa de flaUiClient.click()
 * rechaza -- se traduce aca a `status:'error'` en vez de dejar una
 * excepcion sin capturar, para que el "case" de la tool pueda dar una
 * respuesta clara (reintentar con "x"/"y") sin tener que saber de este
 * detalle.
 */
export async function clickByDescription(description: string, button: MouseButton): Promise<UiaActionResult> {
  try {
    const result = await flaUiClient.click({ name: description }, button)
    return result
  } catch (error) {
    return { status: 'error', error: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * type(criteria, text) real por nombre/tipo de control real de Windows --
 * mecanismo PRIMARIO de keyboard_type cuando el modelo pasa "description".
 * `signal` opcional -- reenviado tal cual a flaUiClient.type(), que manda
 * un "cancel" real hacia el helper si se aborta a mitad de camino (mismo
 * principio de micro-pasos que typeText() de mas abajo, pero troceado del
 * lado del helper en vez de en este proceso -- ver Program.cs, HandleType()).
 */
export async function typeByDescription(description: string, text: string, signal?: AbortSignal): Promise<UiaTypeActionResult> {
  try {
    const result = await flaUiClient.type({ name: description }, text, signal)
    return result as UiaTypeActionResult
  } catch (error) {
    return { status: 'error', error: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * Diagnostico real, best-effort, para el fallback de coordenadas puras
 * (mouse_click sin "description") -- hit_test(x,y) real vía FromPoint
 * (bonus real de la investigacion, docs/_arch/verify_flaui_helper_viability.md,
 * Tarea 1: ningun paquete npm de UIA evaluado antes exponia esto). NUNCA
 * reemplaza el click real por coordenadas (clickAt(), mas arriba) -- solo
 * enriquece el mensaje que vuelve al modelo con que UIA detecto ahi (o
 * `null` si no detecto nada semantico, confirmando contenido no-semantico
 * real, o si el helper no esta disponible). Nunca lanza -- un fallo real
 * aca (helper caido, timeout) es puramente informativo, no debe romper el
 * click por coordenadas ya verificado.
 */
export async function describeCoordinateTarget(x: number, y: number): Promise<string | null> {
  try {
    const hit = await flaUiClient.hitTest(Math.round(x), Math.round(y))
    if (!hit.found) return null
    return hit.name ? `${hit.controlType ?? 'elemento'} "${hit.name}"` : (hit.controlType ?? null)
  } catch {
    return null
  }
}
