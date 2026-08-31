import { dialog, app } from 'electron'
import { existsSync, mkdirSync } from 'node:fs'
import path from 'node:path'

/**
 * Unico punto de verdad para donde Amatista guarda TODO en disco:
 * configuracion, chats, adjuntos, workspace por defecto, y el propio
 * userData interno de Electron (cache, cookies, local storage, etc.).
 *
 * Requisito de producto: nada de esto vive en C:\ (ni AppData, ni
 * LocalAppData, ni Program Files). Todo vive bajo D:\AMATISTA\data por
 * defecto. No hay fallback silencioso a otra unidad — ver
 * ensureStorageRootOrExit().
 *
 * Aislamiento de datos para el benchmark (prerequisito de Fase 1,
 * docs/_arch/verify_swebench_promax.md): override real vía
 * AMATISTA_STORAGE_ROOT -- si esta seteada, el harness del benchmark apunta
 * cada tarea a su propia carpeta aislada (ej. D:\AMATISTA-BENCHMARK\<task_id>\data),
 * sin tocar ni compartir la instalacion real del usuario. SIN la variable
 * seteada (el caso de CUALQUIER arranque normal de la app instalada), cae
 * al valor fijo de siempre -- cero cambio de comportamiento para el uso
 * real.
 */
const STORAGE_ROOT = process.env.AMATISTA_STORAGE_ROOT?.trim() || 'D:\\AMATISTA\\data'

export function getAppDataRoot(): string {
  return STORAGE_ROOT
}

/** Devuelve (y crea si hace falta) una subcarpeta documentada dentro del storage root. */
export function getAppDataSubdir(...segments: string[]): string {
  const dir = path.join(STORAGE_ROOT, ...segments)
  mkdirSync(dir, { recursive: true })
  return dir
}

/**
 * Verifica que la unidad de STORAGE_ROOT exista. Si no existe, muestra un
 * dialogo de error bloqueante y cierra la app — NUNCA degrada a C:\ en
 * silencio. Debe llamarse antes de cualquier otro acceso a disco de la app
 * (incluido antes de app.setPath('userData', ...)).
 */
export function ensureStorageRootOrExit(): void {
  const drive = path.parse(STORAGE_ROOT).root // ej. "D:\\"

  if (!existsSync(drive)) {
    dialog.showErrorBox(
      'Amatista no puede iniciar',
      `No se encontro la unidad ${drive}\n\n` +
      `Amatista guarda toda su configuracion y datos en ${STORAGE_ROOT} y no usa C:\\ ` +
      `para nada. Conecta o crea la unidad ${drive} y vuelve a abrir la aplicacion.`
    )
    app.exit(1)
    return
  }

  try {
    mkdirSync(STORAGE_ROOT, { recursive: true })
  } catch (error) {
    dialog.showErrorBox(
      'Amatista no puede iniciar',
      `No se pudo crear ${STORAGE_ROOT}: ${error instanceof Error ? error.message : String(error)}`
    )
    app.exit(1)
  }
}
