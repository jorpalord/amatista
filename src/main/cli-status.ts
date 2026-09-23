import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'
import type { CliStatus } from '../shared/types'

const execFileAsync = promisify(execFile)

/**
 * Ruta candidata de fallback en Windows: la ubicacion por defecto del shim
 * que crea "npm install -g" (%APPDATA%\npm\<comando>.cmd) — la MISMA
 * carpeta donde installClaudeCli() (App.tsx) instala su binario, no una
 * ubicacion inventada. null si no aplica (no-Windows, o sin %APPDATA% en
 * el entorno).
 *
 * Motivo, SIN CONFIRMAR EMPIRICAMENTE (ver docs/_arch/CONTRACT.md):
 * sospecha de que Electron lanzado desde el Explorer de Windows (app
 * instalada) puede heredar un PATH de usuario desactualizado si el PATH
 * se actualizo despues de que Windows ya estaba corriendo — gap conocido
 * de Electron/Windows, no exclusivo de esta app. `npm run dev` no sufre
 * esto porque Electron hereda el PATH de la terminal que lo lanza.
 */
function npmGlobalShimPath(command: string): string | null {
  if (process.platform !== 'win32') return null
  const appData = process.env.APPDATA
  if (!appData) return null
  return path.join(appData, 'npm', `${command}.cmd`)
}

async function tryVersion(executable: string): Promise<{ ok: true; version: string } | { ok: false; error: unknown }> {
  try {
    const result = await execFileAsync(executable, ['--version'], {
      windowsHide: true,
      timeout: 12000,
      shell: process.platform === 'win32'
    })
    return { ok: true, version: (result.stdout || result.stderr || '').trim() }
  } catch (error) {
    return { ok: false, error }
  }
}

async function versionOf(command: string): Promise<CliStatus> {
  const primary = await tryVersion(command)
  if (primary.ok) {
    // Camino normal, sin cambios respecto a antes de este fix — mismo
    // shape exacto de retorno para quien ya detecta bien por PATH.
    return { installed: true, version: primary.version, detail: `${command} disponible.` }
  }

  // Fallback: SOLO se intenta si el camino normal por PATH fallo. existsSync()
  // se chequea antes de ejecutar nada para no gastar el timeout de 12s
  // contra una ruta que no existe (caso comun: el binario simplemente no
  // esta instalado, ni por PATH ni en el shim de npm).
  const fallbackPath = npmGlobalShimPath(command)
  if (!fallbackPath || !existsSync(fallbackPath)) {
    return { installed: false, authenticated: false, detail: `${command} no encontrado: ${String(primary.error)}` }
  }

  const fallback = await tryVersion(fallbackPath)
  if (fallback.ok) {
    return {
      installed: true,
      version: fallback.version,
      detail: `${command} disponible (resuelto via ${fallbackPath} — no se encontro por PATH).`
    }
  }

  // Ambos caminos fallaron: el detail menciona los dos intentos completos
  // (no solo el error crudo del primero) para diagnosticar sin tener que
  // reproducir esta investigacion de nuevo.
  return {
    installed: false,
    authenticated: false,
    detail:
      `${command} no encontrado. Intento por PATH fallo: ${String(primary.error)} | ` +
      `Intento por fallback (${fallbackPath}) tambien fallo: ${String(fallback.error)}`
  }
}

export function detectCodex(): Promise<CliStatus> { return versionOf('codex') }
export function detectClaude(): Promise<CliStatus> { return versionOf('claude') }
/** Feature "Configurar MarkItDown" (docs/_arch/verify_markitdown_config_button_design.md):
 *  mismo patron de 1 linea que detectCodex()/detectClaude() de arriba --
 *  `docker --version` no necesita el daemon corriendo, solo confirma que
 *  el binario existe en PATH (suficiente para saber si `docker run` va a
 *  poder ejecutarse en absoluto antes de escribir una config que lo
 *  referencia). Sin fallback de shim (a diferencia de Claude/Antigravity):
 *  Docker Desktop en Windows se instala en Program Files y se agrega a
 *  PATH del sistema por su propio instalador, no via npm ni un shim
 *  propio de esta app. */
export function detectDocker(): Promise<CliStatus> { return versionOf('docker') }

/** extract_video_frame (F2, docs/_arch/verify_native_multimodal_tools_design.md): respaldo real cuando el
 *  decodificador integrado de Chromium no soporta el formato/codec del video (AVI, WMV, confirmado en la
 *  investigacion). NO reusa versionOf()/tryVersion() de arriba (que hardcodean `--version`) -- hallazgo real de la
 *  verificacion en vivo: el shim de ffmpeg que instala WinGet en esta maquina (`%LOCALAPPDATA%\Microsoft\WinGet\Links\
 *  ffmpeg.exe`) responde bien a `-version` (el flag NATIVO real de ffmpeg) pero devuelve "Unrecognized option
 *  '-version'" con `--version` cuando se invoca sin shell (`child_process.execFile`/`spawn` directo, sin
 *  `shell:true`) -- reproducido real, `ffmpeg -version` funciona siempre, `ffmpeg --version` no de forma
 *  confiable segun como se invoque. Mismo criterio simple que detectDocker() (sin fallback de shim propio: el
 *  instalador de ffmpeg agrega su carpeta a PATH del sistema por su cuenta). NUNCA se empaqueta (ver
 *  video-frame-reader.ts) -- esto solo detecta si el USUARIO ya lo tiene instalado. */
export async function detectFfmpeg(): Promise<CliStatus> {
  try {
    const result = await execFileAsync('ffmpeg', ['-version'], { windowsHide: true, timeout: 12000 })
    return { installed: true, version: (result.stdout || result.stderr || '').trim(), detail: 'ffmpeg disponible.' }
  } catch (error) {
    return { installed: false, authenticated: false, detail: `ffmpeg no encontrado: ${String(error)}` }
  }
}

/**
 * Ruta real del instalador oficial de Antigravity CLI en Windows
 * (`%LOCALAPPDATA%\agy\bin\agy.exe`, confirmado real -- mismo dato ya
 * usado en `antigravityCommand()`, cli-agent-runtime.ts) -- NO reusa
 * `npmGlobalShimPath()` de arriba, que asume una instalacion via npm
 * (`%APPDATA%\npm\<comando>.cmd`); `agy` no se instala asi. Duplicado a
 * proposito entre los 2 archivos -- mismo patron ya establecido en este
 * codebase (cada CLI resuelve su propio fallback real, sin compartir
 * modulo entre deteccion y spawn).
 */
function antigravityShimPath(): string | null {
  if (process.platform !== 'win32') return null
  const localAppData = process.env.LOCALAPPDATA
  if (!localAppData) return null
  return path.join(localAppData, 'agy', 'bin', 'agy.exe')
}

/**
 * Bug real encontrado en la propia verificacion en vivo (no anticipado en
 * el diseno original, que asumia que `versionOf('agy')` alcanzaba): la
 * app real, recien instalada y lanzada, reporto "Antigravity CLI no esta
 * instalado" pese a que el binario real esta presente en
 * `%LOCALAPPDATA%\agy\bin\agy.exe` -- mismo gap real ya documentado (PATH
 * stale en un proceso Electron lanzado sin heredar una terminal
 * actualizada) que Claude mitiga con `npmGlobalShimPath()`, pero ese
 * fallback generico NO cubre a `agy` (no se instala via npm). Fix:
 * mismo patron de 2 pasos que `versionOf()` (PATH primero, fallback real
 * despues), pero con `antigravityShimPath()` en vez del shim de npm.
 */
export async function detectAntigravity(): Promise<CliStatus> {
  const primary = await tryVersion('agy')
  if (primary.ok) {
    return { installed: true, version: primary.version, detail: 'agy disponible.' }
  }

  const fallbackPath = antigravityShimPath()
  if (!fallbackPath || !existsSync(fallbackPath)) {
    return { installed: false, authenticated: false, detail: `agy no encontrado: ${String(primary.error)}` }
  }

  const fallback = await tryVersion(fallbackPath)
  if (fallback.ok) {
    return {
      installed: true,
      version: fallback.version,
      detail: `agy disponible (resuelto via ${fallbackPath} — no se encontro por PATH).`
    }
  }

  return {
    installed: false,
    authenticated: false,
    detail:
      `agy no encontrado. Intento por PATH fallo: ${String(primary.error)} | ` +
      `Intento por fallback (${fallbackPath}) tambien fallo: ${String(fallback.error)}`
  }
}
