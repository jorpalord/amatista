import { dialog, app } from 'electron'
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
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

/**
 * Infraestructura de aislamiento de HOME para Antigravity CLI (`agy`) --
 * pieza base, sin integrar `agy` a ningun runtime todavia (ver
 * docs/_arch/verify_antigravity_cli.md, seccion "Tarea puntual"). Confirmado
 * real: `agy` (binario Go) resuelve `~/.gemini/antigravity-cli/` via
 * USERPROFILE/HOME del proceso -- no existe NINGUN flag/env var propio de
 * `agy` para relocar ese directorio (revisado `agy --help` completo + la
 * documentacion oficial de Settings), pero sobreescribir esas 2 variables al
 * spawnear el proceso redirige TODO el arbol de estado (conversaciones
 * SQLite, transcripts, etc.) sin tocar la carpeta real del usuario --
 * probado real, ver el helper de spawn en antigravity-home.ts.
 *
 * Fix real (docs/_arch/verify_antigravity_authmode_race.md,
 * docs/_arch/verify_antigravity_home_per_connection.md): originalmente UNA
 * sola carpeta compartida por TODA la app -- confirmado real que 2 paneles
 * de Antigravity con distinto authMode corriendo turnos concurrentes podian
 * pisarse el mismo settings.json/mcp_config.json real, sin ningun error ni
 * aviso al escribir. `connectionId` (el `provider.id` real de la conexion,
 * unico y estable por conexion -- `ProviderProfile.id`) agrega un nivel mas
 * de separacion bajo la misma carpeta aislada de siempre: cada conexion
 * ahora tiene su PROPIO subarbol completo (conversaciones, settings.json,
 * mcp_config.json, todo), nunca comparte archivo con otra conexion --
 * elimina la carrera de raiz en vez de mitigarla con un orden de escritura
 * mas cuidadoso.
 */
export function getAntigravityHomeDir(connectionId: string): string {
  return getAppDataSubdir('antigravity-home', connectionId)
}

/**
 * Vacia el CONTENIDO de la carpeta `antigravity-home` (nunca la carpeta en
 * si -- evita pelear con locks de creacion si algo la tiene abierta) --
 * deja la carpeta lista y vacia para la proxima sesion de `agy`. Usado en 2
 * puntos reales, con distinta garantia:
 *   1. Al ARRANCAR (index.ts) -- mecanismo GARANTIZADO, corre siempre,
 *      no depende de que la sesion anterior haya cerrado prolijo.
 *   2. Al CERRAR (index.ts, `before-quit`) -- best-effort, nunca bloquea
 *      el cierre si falla.
 * Sin try/catch propio aca a proposito -- cada caller decide si el fallo es
 * fatal (arranque) o silencioso (cierre), mismo criterio que
 * ensureStorageRootOrExit() vs el resto de esta app.
 *
 * Fix real (HOME por conexion, ver getAntigravityHomeDir() arriba): opera
 * sobre la carpeta PADRE `antigravity-home` directamente (sin
 * `connectionId` -- no hay una conexion puntual que limpiar aca, es un
 * barrido global), no sobre una subcarpeta de una conexion. Como cada
 * conexion ahora vive en su propia subcarpeta DENTRO de `antigravity-home`,
 * el mismo `readdirSync`+`rmSync` de siempre ya borra TODAS las subcarpetas
 * por conexion de una -- ningun cambio de logica hizo falta, la separacion
 * por conexion queda un nivel mas abajo de donde este barrido opera.
 */
export function clearAntigravityHomeDir(): void {
  const dir = getAppDataSubdir('antigravity-home')
  for (const entry of readdirSync(dir)) {
    rmSync(path.join(dir, entry), { recursive: true, force: true })
  }
}
