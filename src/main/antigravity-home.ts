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
 *
 * Fix real (HOME por conexion, docs/_arch/verify_antigravity_home_per_connection.md):
 * `connectionId` (el `provider.id` real de la conexion que dispara este
 * turno) selecciona la subcarpeta -- cada conexion Antigravity real queda
 * aislada tambien de las DEMAS conexiones Antigravity, no solo del HOME
 * real del usuario.
 */
export function antigravityIsolatedEnv(connectionId: string): NodeJS.ProcessEnv {
  const home = getAntigravityHomeDir(connectionId)
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
 * `getAntigravityHomeDir(connectionId)`, nunca el HOME real del usuario.
 *
 * Bug real encontrado en la propia verificacion en vivo (no anticipado en
 * el diseno original, que solo escribia este archivo para `authMode:
 * 'api-key'`): `getAntigravityHomeDir()` era UNA sola carpeta compartida
 * por TODA la app, no una por conexion -- si una conexion `api-key` corria
 * un turno primero (dejaba `modelProvider:'gemini'` escrito) y despues una
 * conexion `subscription` corria en la MISMA carpeta aislada (sin
 * `GEMINI_API_KEY` en el env), `agy` rechazaba el turno entero real:
 * `"modelProvider is set to \"gemini\" in settings.json, but the
 * GEMINI_API_KEY environment variable is not set"`. Fix original: esta
 * funcion escribe el `settings.json` CORRECTO para el `authMode` real de
 * CADA turno (subscription -> `{}`, sin `modelProvider`), llamada desde
 * AMBAS ramas de `buildEnv()` (cli-agent-runtime.ts), no solo la de
 * `api-key`. Reescritura idempotente en los dos casos, el costo real de
 * I/O es insignificante frente a spawnear un proceso entero.
 *
 * Fix real de la limitacion que quedaba (docs/_arch/
 * verify_antigravity_authmode_race.md, docs/_arch/
 * verify_antigravity_home_per_connection.md): confirmado real que 2
 * PANELES corriendo turnos antigravity CONCURRENTES con distinto authMode
 * SI podian pisarse el mismo settings.json (mecanismo de la carrera
 * reproducido real con ensanchamiento de ventana). `connectionId` (nuevo
 * parametro, el `provider.id` real de la conexion) hace que cada conexion
 * escriba en su PROPIO `settings.json`, dentro de su propia subcarpeta --
 * ya no hay ningun archivo compartido entre conexiones que pisar, la
 * carrera queda eliminada de raiz, no solo detectada/reintentada.
 */
export function writeAntigravitySettingsForAuthMode(authMode: 'subscription' | 'api-key', connectionId: string): void {
  const settingsDir = path.join(getAntigravityHomeDir(connectionId), '.gemini', 'antigravity-cli')
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
 * writeAntigravitySettingsForAuthMode(). Mismo fix real de HOME por
 * conexion que esa funcion (`connectionId`, ver ahi) -- ya no hay ningun
 * archivo compartido entre conexiones antigravity concurrentes.
 */
export function writeAntigravityMcpConfig(scriptCommand: string, scriptArgs: string[], env: Record<string, string>, connectionId: string): void {
  const configDir = path.join(getAntigravityHomeDir(connectionId), '.gemini', 'config')
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
