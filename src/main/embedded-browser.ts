// Navegador embebido real -- docs/_arch/verify_embedded_browser_design.md,
// ya aprobado por el usuario antes de escribir este archivo.
//
// Modulo HOJA a proposito, mismo motivo real ya documentado en
// computer-use-actions.ts: sin ningun import de runtime-state.ts/tool-
// registry.ts/ipc-agent.ts/mcp-approval-pipe.ts, para evitar el mismo
// ciclo real (runtime-state -> tool-registry -> este archivo ->
// runtime-state). Las funciones de aca reciben la `BrowserWindow` real
// como PARAMETRO (nunca la resuelven ellas mismas) -- quien llama
// (runtime-state.ts para armar/destruir la vista, ipc-agent.ts/
// mcp-approval-pipe.ts para las 4 tools) ya tiene acceso real a
// getMainWindow() (runtime-state.ts) sin que este archivo necesite
// importarlo.
//
// `WebContentsView`, NO `BrowserView` -- confirmado real en la
// investigacion que `BrowserView` esta deprecated en la version exacta de
// Electron de este repo (43.2.0, 6 avisos reales en electron.d.ts). Una
// instancia por panelId, adjuntada a `win.contentView` y posicionada con
// `setBounds()` sobre el rectangulo real que el renderer reporta (mismo
// sistema de coordenadas que la ventana, sin transformacion -- confirmado
// real en la investigacion, TEST1: sendInputEvent/capturePage comparten el
// sistema de coordenadas DEL CONTENIDO de la vista, nunca de la ventana).
import { WebContentsView, type BrowserWindow } from 'electron'

const views = new Map<string, WebContentsView>()

/** Crea (o reusa) la WebContentsView de este panel -- webPreferences MINIMO
 *  real, mismo criterio de seguridad que la ventana principal
 *  (window-manager.ts): contextIsolation/sandbox activos, nodeIntegration
 *  apagado -- el contenido cargado ahi es una pagina web REAL, arbitraria,
 *  nunca debe tener acceso a Node/filesystem. */
export function ensureBrowserView(win: BrowserWindow, panelId: string): WebContentsView {
  const existing = views.get(panelId)
  if (existing && !existing.webContents.isDestroyed()) return existing

  const view = new WebContentsView({
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false }
  })
  win.contentView.addChildView(view)
  views.set(panelId, view)
  return view
}

/** Rectangulo real reportado por el panel de chat (App.tsx, ResizeObserver
 *  sobre el `<div>` contenedor) -- mismas coordenadas que la ventana,
 *  redondeadas a enteros (Rectangle de Electron no acepta floats). No-op
 *  si la vista de este panel no existe todavia (el panel puede reportar
 *  bounds antes de que browserControlActive termine de armar la vista, o
 *  despues de que se desactivo -- ninguno de los 2 casos es un error real). */
export function setBrowserViewBounds(panelId: string, bounds: { x: number; y: number; width: number; height: number }): void {
  const view = views.get(panelId)
  if (!view || view.webContents.isDestroyed()) return
  view.setBounds({
    x: Math.round(bounds.x),
    y: Math.round(bounds.y),
    width: Math.max(1, Math.round(bounds.width)),
    height: Math.max(1, Math.round(bounds.height))
  })
}

/** Desarma la vista real -- llamado cuando `browserControlActive` se apaga
 *  para este panel (Capa 1) o el panel/sesion se desconecta. `removeChildView()`
 *  desengancha la vista de la ventana; sin `.destroy()` explicito en la API
 *  real de `WebContentsView` (confirmado en `electron.d.ts`) -- sacarla del
 *  Map real y de la ventana alcanza para que quede elegible para GC real. */
export function destroyBrowserView(win: BrowserWindow, panelId: string): void {
  const view = views.get(panelId)
  if (!view) return
  views.delete(panelId)
  try {
    if (!win.isDestroyed()) win.contentView.removeChildView(view)
  } catch {
    // La ventana pudo haberse destruido ya (cierre de app) -- no bloquea la limpieza real.
  }
}

export interface BrowserNavigateResult {
  ok: boolean
  title?: string
  url?: string
  error?: string
}

/** `loadURL()` real -- confirmado real en la investigacion (TASK2) que
 *  funciona identico para contenido local y remoto, sin logica especial.
 *  Solo http/https -- mismo criterio real ya establecido en `open_url`
 *  (Familia B, tool-registry.ts) para no pasarle un esquema arbitrario
 *  (file:/javascript:/etc.) a `loadURL()` sin filtrar. */
export async function navigateBrowserView(win: BrowserWindow, panelId: string, url: string): Promise<BrowserNavigateResult> {
  if (!/^https?:\/\//i.test(url)) return { ok: false, error: 'Solo se admiten URLs http:// o https://.' }
  const view = ensureBrowserView(win, panelId)
  try {
    await view.webContents.loadURL(url)
    return { ok: true, title: view.webContents.getTitle(), url: view.webContents.getURL() }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * Resolver real por texto/DOM (docs/_arch/verify_embedded_browser_design.md,
 * Tarea 1 -- confirmado real MAS confiable que coordenadas: TEST2/TEST3
 * mostraron que las coordenadas fallan en SILENCIO tras un scroll/zoom real,
 * TEST4/TEST5 confirmaron que resolver en el mismo instante del click es
 * inmune a eso). Busca elementos interactivos REALES y visibles, matchea
 * por texto exacto primero (trim + case-insensitive), si no hay exacto cae
 * a substring. 0 matches -> not_found con la lista real de que SI hay
 * disponible (mismo espiritu que TEST6, para que el modelo pueda
 * reintentar con mejor descripcion). 2+ matches -> ambiguous, nunca
 * adivina cual. Un solo `executeJavaScript` real hace TODO (buscar +
 * accionar) -- la resolucion y el click/focus pasan en el MISMO instante,
 * sin ventana de tiempo real que pueda quedar stale.
 */
function resolverScript(description: string, action: 'click' | 'focus'): string {
  const descJson = JSON.stringify(description)
  const actionJson = JSON.stringify(action)
  return `(function() {
    var desc = (${descJson} || '').trim().toLowerCase()
    var action = ${actionJson}
    var selector = 'button, a, input, textarea, select, [role="button"], [onclick]'
    var nodes = Array.prototype.slice.call(document.querySelectorAll(selector)).filter(function(el) {
      var rect = el.getBoundingClientRect()
      var style = window.getComputedStyle(el)
      return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none' && !el.disabled
    })
    function labelFor(el) {
      var raw = el.innerText || el.value || el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('title') || ''
      return String(raw).trim()
    }
    var candidates = nodes.map(function(el) { return { el: el, label: labelFor(el) } }).filter(function(c) { return c.label })
    var exact = candidates.filter(function(c) { return c.label.toLowerCase() === desc })
    var matches = exact.length ? exact : candidates.filter(function(c) { return c.label.toLowerCase().indexOf(desc) !== -1 })
    function listCandidates(arr) {
      return arr.slice(0, 20).map(function(c) { return c.el.tagName.toLowerCase() + ': "' + c.label.slice(0, 60) + '"' })
    }
    if (matches.length === 0) return JSON.stringify({ status: 'not_found', candidates: listCandidates(candidates) })
    if (matches.length > 1) return JSON.stringify({ status: 'ambiguous', candidates: listCandidates(matches) })
    var el = matches[0].el
    var rect = el.getBoundingClientRect()
    if (action === 'click') { el.click() } else { el.focus() }
    var focused = action === 'focus' ? (document.activeElement === el) : true
    return JSON.stringify({ status: 'ok', tag: el.tagName.toLowerCase(), label: matches[0].label, focused: focused, rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height } })
  })()`
}

export interface BrowserClickResult {
  status: 'ok' | 'not_found' | 'ambiguous' | 'error'
  tag?: string
  label?: string
  candidates?: string[]
  error?: string
}

export interface BrowserClickOptions {
  description?: string
  x?: number
  y?: number
  button?: 'left' | 'right'
}

/** Coordenadas SOLO como fallback real, documentado como fragil (Tarea 1,
 *  TEST2/TEST3 confirmados: falla en silencio tras cualquier cambio de
 *  layout entre la captura y el click) -- para contenido no-semantico real
 *  (canvas/iframe cross-origin) donde no hay DOM que buscar. Sin
 *  verificacion real de que algo reacciono (a diferencia del camino DOM,
 *  que SI la tiene gratis via el resultado de `.click()`). */
export async function clickInBrowserView(win: BrowserWindow, panelId: string, opts: BrowserClickOptions): Promise<BrowserClickResult> {
  const view = ensureBrowserView(win, panelId)
  try {
    if (typeof opts.x === 'number' && typeof opts.y === 'number') {
      const button = opts.button ?? 'left'
      await view.webContents.sendInputEvent({ type: 'mouseDown', x: opts.x, y: opts.y, button, clickCount: 1 })
      await view.webContents.sendInputEvent({ type: 'mouseUp', x: opts.x, y: opts.y, button, clickCount: 1 })
      return { status: 'ok', label: `coordenadas (${opts.x}, ${opts.y})` }
    }
    const raw = await view.webContents.executeJavaScript(resolverScript(opts.description ?? '', 'click'))
    return JSON.parse(raw) as BrowserClickResult
  } catch (error) {
    return { status: 'error', error: error instanceof Error ? error.message : String(error) }
  }
}

export interface BrowserTypeResult {
  status: 'ok' | 'not_found' | 'ambiguous' | 'error'
  tag?: string
  label?: string
  candidates?: string[]
  charsTyped?: number
  error?: string
}

/** Hibrido real confirmado (TEST8): foco por DOM (mismo resolver que
 *  clickInBrowserView, con action:'focus'), tipeo en si via `sendInputEvent`
 *  real (keyDown+char+keyUp por caracter) sobre el `webContents` de la
 *  vista -- NUNCA `element.value = ...` por JS (frameworks como React
 *  pueden no disparar su `onChange` sintetico correctamente ante una
 *  mutacion directa de `.value`; eventos de teclado reales si disparan
 *  cualquier listener, nativo o de framework). */
export async function typeInBrowserView(win: BrowserWindow, panelId: string, description: string, text: string): Promise<BrowserTypeResult> {
  const view = ensureBrowserView(win, panelId)
  try {
    const raw = await view.webContents.executeJavaScript(resolverScript(description, 'focus'))
    const focusResult = JSON.parse(raw) as BrowserClickResult & { focused?: boolean }
    if (focusResult.status !== 'ok') return focusResult
    if (!focusResult.focused) return { status: 'error', error: 'El elemento se encontro pero no se pudo enfocar de verdad.' }

    let charsTyped = 0
    for (const char of text) {
      await view.webContents.sendInputEvent({ type: 'keyDown', keyCode: char })
      await view.webContents.sendInputEvent({ type: 'char', keyCode: char })
      await view.webContents.sendInputEvent({ type: 'keyUp', keyCode: char })
      charsTyped++
    }
    return { status: 'ok', tag: focusResult.tag, label: focusResult.label, charsTyped }
  } catch (error) {
    return { status: 'error', error: error instanceof Error ? error.message : String(error) }
  }
}

export interface BrowserScreenshotResult {
  ok: boolean
  dataUrl?: string
  width?: number
  height?: number
  error?: string
}

/** SIEMPRE sobre `view.webContents` (la vista embebida), NUNCA sobre
 *  `win.webContents` (la ventana principal, donde vive el React de
 *  App.tsx) -- confirmado real en la investigacion (TEST7) que capturar la
 *  ventana contenedora da `{width:0,height:0}` (no compone las
 *  WebContentsView hijas adjuntadas via `contentView.addChildView()`). */
export async function screenshotBrowserView(win: BrowserWindow, panelId: string): Promise<BrowserScreenshotResult> {
  const view = ensureBrowserView(win, panelId)
  try {
    const image = await view.webContents.capturePage()
    const size = image.getSize()
    return { ok: true, dataUrl: image.toDataURL(), width: size.width, height: size.height }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}
