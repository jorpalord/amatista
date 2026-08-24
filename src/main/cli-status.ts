import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'
import type { CliStatus } from '../shared/types'

const execFileAsync = promisify(execFile)

/**
 * Ruta candidata de fallback en Windows: la ubicacion por defecto del shim
 * que crea "npm install -g" (%APPDATA%\npm\<comando>.cmd) — la MISMA
 * carpeta donde installClaudeCli()/installGeminiCli() (App.tsx, via
 * scripts/install-claude-cli.ps1 / install-gemini-cli.ps1) instalan estos
 * binarios, no una ubicacion inventada. null si no aplica (no-Windows, o
 * sin %APPDATA% en el entorno).
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
export function detectGemini(): Promise<CliStatus> { return versionOf('gemini') }
