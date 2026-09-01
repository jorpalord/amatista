// Infraestructura de aislamiento de HOME para Antigravity CLI (`agy`) --
// getAntigravityHomeDir()/clearAntigravityHomeDir() viven en app-paths.ts
// (mismo patron que STORAGE_ROOT/ensureStorageRootOrExit()); este archivo
// arma el `env` real para spawnear `agy` con ese HOME, y (integracion
// completa, docs/_arch/verify_antigravity_integration.md) el settings.json
// real que authMode:'api-key' necesita para que GEMINI_API_KEY tenga
// efecto.
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
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

/**
 * Integracion completa (Tarea 1 de verify_antigravity_integration.md, real
 * -- no supuesta): `GEMINI_API_KEY` SOLA no tiene ningun efecto en `agy` --
 * confirmado con una key real invalida y el log real de `agy`
 * (`auth.go:148 ChainedAuth: authenticated via gemini_api_key`) que solo
 * aparecio DESPUES de escribir este archivo con `modelProvider:'gemini'`.
 * Ese archivo vive relativo al HOME que `agy` resuelva -- con
 * `antigravityIsolatedEnv()` ya aplicado, eso es SIEMPRE
 * `getAntigravityHomeDir()`, nunca el HOME real del usuario.
 *
 * Bug real encontrado en la propia verificacion en vivo (no anticipado en
 * el diseno original, que solo escribia este archivo para `authMode:
 * 'api-key'`): `getAntigravityHomeDir()` es UNA sola carpeta compartida por
 * TODA la app, no una por conexion -- si una conexion `api-key` corre un
 * turno primero (deja `modelProvider:'gemini'` escrito) y despues una
 * conexion `subscription` corre en la MISMA carpeta aislada (sin
 * `GEMINI_API_KEY` en el env), `agy` rechaza el turno entero real:
 * `"modelProvider is set to \"gemini\" in settings.json, but the
 * GEMINI_API_KEY environment variable is not set"`. Fix: esta funcion
 * ahora escribe el `settings.json` CORRECTO para el `authMode` real de
 * CADA turno (subscription -> `{}`, sin `modelProvider`), llamada desde
 * AMBAS ramas de `buildEnv()` (cli-agent-runtime.ts), no solo la de
 * `api-key` -- deja de depender de que forma tuvo el turno anterior en la
 * misma carpeta compartida. Reescritura idempotente en los dos casos, el
 * costo real de I/O es insignificante frente a spawnear un proceso entero.
 *
 * Limitacion real conocida, NO resuelta aca (anotada en
 * docs/_arch/PENDING.md): si 2 PANELES reales corren turnos antigravity
 * CONCURRENTES con distinto authMode (uno subscription, otro api-key),
 * ambos comparten la MISMA carpeta/mismo archivo -- una carrera real podria
 * hacer que el turno de uno lea el settings.json que el otro acaba de
 * escribir para si mismo. No investigado si es alcanzable en la practica
 * (2 conexiones antigravity reales simultaneas con authMode distinto) ni
 * mitigado en esta fase.
 */
export function writeAntigravitySettingsForAuthMode(authMode: 'subscription' | 'api-key'): void {
  const settingsDir = path.join(getAntigravityHomeDir(), '.gemini', 'antigravity-cli')
  mkdirSync(settingsDir, { recursive: true })
  const content = authMode === 'api-key' ? { modelProvider: 'gemini' } : {}
  writeFileSync(
    path.join(settingsDir, 'settings.json'),
    JSON.stringify(content, null, 2),
    'utf8'
  )
}

/**
 * Servidor MCP de LSP (docs/_arch/CONTRACT.md → "Servidor MCP de LSP para
 * los 3 CLIs", verify_mcp_server.md Tarea 2): `agy` es el UNICO de los 3
 * CLIs sin flag efimero real para MCP (`--mcp-config` de Claude, `-c
 * mcp_servers.X...` de Codex) -- la unica via confirmada es `agy mcp add`,
 * que escribe en `<HOME>/.gemini/config/mcp_config.json` (ruta real
 * confirmada, DISTINTA de `.gemini/antigravity-cli/settings.json` que usa
 * writeAntigravitySettingsForAuthMode()). Mismo patron que esa funcion --
 * NO literal, esta escribe un archivo distinto con un shape distinto
 * (`mcpServers` en vez de `modelProvider`) -- pero el mismo principio real:
 * como el HOME ya esta redirigido por antigravityIsolatedEnv() para
 * CUALQUIER conexion, escribir este archivo ahi ANTES de cada spawn logra
 * el mismo efecto efimero-por-turno que Claude/Codex logran con un flag,
 * sin que `agy` tenga uno. Reescritura completa cada vez (no un merge con
 * lo que hubiera antes) -- mismo criterio de idempotencia que
 * writeAntigravitySettingsForAuthMode(), y misma limitacion real heredada:
 * getAntigravityHomeDir() es UNA carpeta compartida por toda la app, asi
 * que 2 paneles antigravity concurrentes comparten este mismo archivo
 * (mismo caveat ya anotado en PENDING.md para settings.json).
 */
export function writeAntigravityMcpConfig(scriptCommand: string, scriptArgs: string[], env: Record<string, string>): void {
  const configDir = path.join(getAntigravityHomeDir(), '.gemini', 'config')
  mkdirSync(configDir, { recursive: true })
  const content = {
    mcpServers: {
      // disabled:false explicito -- mismo shape real que `agy mcp add`
      // produce (confirmado real en verify_mcp_server.md), no un supuesto.
      'amatista-lsp': { command: scriptCommand, args: scriptArgs, env, disabled: false }
    }
  }
  writeFileSync(
    path.join(configDir, 'mcp_config.json'),
    JSON.stringify(content, null, 2),
    'utf8'
  )
}
