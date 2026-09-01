// Infraestructura de aislamiento de HOME para Antigravity CLI (`agy`) --
// pieza base, sin integrar `agy` a CliAgentKind ni a ningun runtime todavia
// (ver docs/_arch/verify_antigravity_cli.md). getAntigravityHomeDir()/
// clearAntigravityHomeDir() viven en app-paths.ts (mismo patron que
// STORAGE_ROOT/ensureStorageRootOrExit()); este archivo solo arma el `env`
// real para spawnear `agy` con ese HOME -- pensado para ser reusado por la
// integracion completa cuando se priorice, sin que nadie lo llame todavia.
import { getAntigravityHomeDir } from './app-paths'

/**
 * Env real para spawnear `agy` con su HOME redirigido a la carpeta aislada
 * de Amatista -- resto de `process.env` intacto (PATH, etc.), solo
 * USERPROFILE/HOME sobreescritos.
 *
 * Confirmado real (verificacion previa, agy 1.1.23 real, no supuesto): un
 * turno headless corrido con USERPROFILE/HOME apuntados a una carpeta de
 * prueba escribio TODO su arbol de estado ahi (conversations/*.db,
 * brain/<id>/, annotations/<id>.pbtxt, etc.) y no toco
 * ~/.gemini/antigravity-cli/ real ni una sola vez (confirmado filtrando por
 * LastWriteTime en la ventana real de la corrida, no solo un conteo
 * antes/despues).
 *
 * Matiz real, no oculto: esto aisla la ESCRITURA A DISCO, no la sesion de
 * cuenta -- `agy` se autentica via el keyring del sistema operativo
 * (Windows Credential Manager), no via un archivo relativo al HOME, asi que
 * un turno con este env sigue autenticandose como la MISMA cuenta real de
 * Google del usuario. Para una identidad separada haria falta ademas
 * GEMINI_API_KEY + modelProvider:'gemini' (ver verify_antigravity_cli.md,
 * Tarea 4) -- fuera de alcance de esta pieza base.
 *
 * Mecanismo NO documentado/soportado oficialmente por Google -- depende de
 * que `agy` siga resolviendo su home via USERPROFILE/HOME en versiones
 * futuras (confirmado que ningun flag/env var propio de `agy` cubre esto
 * hoy, revisado `agy --help` completo + la documentacion oficial de
 * Settings). Si una version futura de `agy` cambia ese mecanismo, este
 * helper deja de aislar en silencio -- sin verificacion automatica de eso
 * aca, queda para quien integre `agy` al runtime real confirmarlo de nuevo
 * contra la version instalada en ese momento.
 */
export function antigravityIsolatedEnv(): NodeJS.ProcessEnv {
  const home = getAntigravityHomeDir()
  return {
    ...process.env,
    USERPROFILE: home,
    HOME: home
  }
}
