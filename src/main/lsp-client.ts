// Fase 20: cliente LSP real (arranca cualquier language server bundleado
// que hable el protocolo estandar, ver LANGUAGE_SERVERS mas abajo -- Fase
// 20 original solo cubria typescript-language-server, generalizado en la
// fase de soporte Python). Investigacion previa (docs/_arch/CONTRACT.md)
// confirmo contra el proceso real: framing Content-Length (LspFramer),
// handshake initialize/initialized con capabilities minimas de
// diagnostics, servidor PUSH-only (sin pull-diagnostics: la unica senal es
// la notificacion textDocument/publishDiagnostics), shutdown+exit real
// como cierre limpio, URIs de Windows que NO matchean por string contra
// pathToFileURL() (hay que decodificar y comparar paths normalizados), y
// latencia real medida (~2.7-3.7s fria / ~442ms caliente, TypeScript).
import { type ChildProcess, execFile, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import path from 'node:path'
import { getAppDataSubdir } from './app-paths'
import { LspFramer, encodeLspMessage } from './lsp-framer'

const execFileAsync = promisify(execFile)

export interface LspDiagnostic {
  message: string
  /** 1-indexado (el servidor lo manda 0-indexado, LSP spec) -- convertido
   *  aca para que coincida con como un humano/modelo lee un numero de
   *  linea real, mismo criterio que usa el compilador de TS por CLI. */
  line: number
  column: number
  severity: number
  code?: string | number
  source?: string
}

interface FileDiagnosticsEntry {
  diagnostics: LspDiagnostic[]
  updatedAt: number
}

/**
 * Soporte Python (docs/_arch/verify_python_lsp.md): generaliza lo que
 * antes eran 3 puntos hardcodeados a TypeScript (LSP_SUPPORTED_EXTENSIONS,
 * languageIdFor(), resolveLanguageServerEntry()) a una tabla chica, misma
 * forma para las 2 entradas -- sin trato especial para ninguna en el
 * MANAGER/CLIENTE (el unico matiz real, .tsx vs .ts, es intrinseco a
 * TypeScript mismo, ver languageIdFor() mas abajo, no una excepcion del
 * mecanismo de tabla). `languageId` es tambien la clave real del servidor
 * -- un solo proceso sirve TODAS las extensiones de esa entrada (.ts Y
 * .tsx comparten el MISMO typescript-language-server, exactamente como
 * antes de esta generalizacion -- no se separan en 2 procesos).
 * `resolveEntry()` lee `bin` del propio package.json del paquete bundleado
 * (mismo criterio robusto que geminiCommand(), cli-agent-runtime.ts: la
 * estructura interna de un paquete puede cambiar entre versiones, `bin` es
 * el contrato publico estable -- NUNCA hardcodear "lib/cli.mjs" o
 * "langserver.index.js" a mano). Alcance deliberado, NO automatico:
 * typescript-language-server tambien sirve .js/.jsx (via allowJs) y
 * pyright podria (en teoria) analizar otras extensiones -- sumarlas es la
 * unica accion necesaria si se quiere despues, documentado aca para que
 * sea explicito y no una omision silenciosa.
 *
 * Soporte Rust (docs/_arch/verify_rust_lsp.md): `resolveEntry()` paso a
 * ser ASYNC -- Python/TypeScript resuelven sync (leen un package.json ya
 * en disco), pero rust-analyzer es un BINARIO EXTERNO no bundleado
 * (Tarea 1: no existe un paquete npm real que lo distribuya) y resolverlo
 * implica probar si responde por PATH (execFile real, inherentemente
 * async) antes de caer al path de fallback. Cambiar el tipo no afecta el
 * VALOR que devuelven TypeScript/Python -- solo se envuelve en una promesa
 * ya resuelta, cero cambio de comportamiento para esos dos.
 *
 * `kind` (Tarea 3, hallazgo real de la investigacion): 'node' -- el entry
 * es un archivo JS bundleado, se ejecuta CON el Node embebido de Electron
 * (process.execPath + ELECTRON_RUN_AS_NODE, igual que siempre). 'native'
 * -- el entry YA es un ejecutable real (compilado), se spawnea DIRECTO sin
 * ese envoltorio -- confirmado necesario: rust-analyzer es un binario
 * nativo, no un script para que Node interprete (spawnearlo con
 * process.execPath fallaria de entrada).
 *
 * `args` (hallazgo real de seguimiento, confirmado ejecutando el binario
 * real): NO todos los language servers aceptan el mismo flag de
 * transporte. typescript-language-server/pyright necesitan `--stdio`
 * explicito para hablar por stdin/stdout. rust-analyzer usa stdio POR
 * DEFECTO (sin ningun flag) y **rechaza** `--stdio` como argumento
 * desconocido -- confirmado real: `rust-analyzer --stdio` imprime
 * `unexpected flag: --stdio` y termina con exit code 2 en ~70ms. Pasarselo
 * igual mataba el proceso casi al instante; el cliente se quedaba
 * esperando una respuesta de `initialize` que ya nunca iba a llegar
 * (timeout largo y engañoso -- parecia lentitud real de arranque de
 * rust-analyzer, no un flag invalido matando el proceso de entrada).
 */
/**
 * Rediseño config-driven (docs/_arch/verify_lsp_config_redesign.md), motivado
 * por la investigación real de jdtls/Java (verify_jdtls_integration_scope.md)
 * y confirmado contra el CODIGO FUENTE real de OpenCode (sst/opencode):
 * `kind`/`args`/`extraPathDirs` (historial arriba) se colapsan en un solo
 * `resolveCommand(workspace)` que devuelve la forma final YA resuelta y
 * lista para spawnear -- `{command, env?}`. Mismo criterio real que confirmó
 * OpenCode: el esquema que el USUARIO edita a mano (lsp.json/.lsp.json, ver
 * mas abajo) es siempre un array estatico; la complejidad real (glob de un
 * jar versionado, detectar PATH, validar una version minima, un directorio
 * de datos por workspace -- jdtls, mas abajo) vive en código, en la funcion
 * de resolucion de CADA built-in, nunca en el esquema en si. `workspace` se
 * pasa a TODOS los resolvers por uniformidad de firma (Rust/Go/TypeScript/
 * Python/clangd lo ignoran; jdtls lo necesita para su `-data` unico por
 * proyecto). `installHint` se mantiene igual que antes.
 */
export interface LanguageServerConfig {
  languageId: string
  extensions: string[]
  resolveCommand: (workspace: string) => Promise<{ command: string[]; env?: Record<string, string> } | null>
  /** Mensaje real y accionable (get_diagnostics/LspManager.startupFailureFor())
   *  cuando resolveCommand() devuelve null -- SOLO relevante para binarios
   *  externos que el usuario puede genuinamente no tener instalado (los
   *  bundleados con la app, TypeScript/Python, nunca deberian fallar en la
   *  practica). undefined = usa el mensaje generico de abajo. */
  installHint?: string
  /**
   * Soporte YAML/ESLint/Bash (docs/_arch/verify_lsp_pull_config_implementation_design.md):
   * respuestas REALES y ESTATICAS a `workspace/configuration` -- indexadas
   * por el `section` real que cada item del request trae (`''` = toda la
   * config, confirmado real que asi la pide eslint-language-server; un
   * nombre real como `'bashIde'`/`'yaml'` para servidores que piden
   * sub-secciones). `undefined` (los 6 lenguajes ya existentes) = sin
   * cambio de comportamiento, cualquier request de este tipo que llegue de
   * todos modos (no deberia, ninguno de los 6 lo hace) responde `null`
   * generico (ver LspClient.buildConfigurationResponse()). Confirmado real
   * que un `null` generico no rompe a los servidores que SI lo piden pero
   * no necesitan valores especificos (YAML) -- solo eslint-language-server
   * necesita un objeto real (ver ESLINT_CONFIG_RESPONSE mas abajo), nunca
   * datos dependientes del workspace en la practica confirmada hoy.
   */
  configResponses?: Record<string, unknown>
}

/**
 * Resuelve el entry point real de un language server BUNDLEADO dentro del
 * propio node_modules de Amatista -- NO es un CLI global que el usuario
 * instala (a diferencia de claude/codex/gemini, ver geminiCommand() en
 * cli-agent-runtime.ts): es infraestructura bundleada de la app (ver
 * docs/_arch/CONTRACT.md). En produccion, asar empaqueta el codigo de la
 * app en app.asar, pero un binario/servidor que hay que SPAWNEAR como
 * proceso real no puede vivir dentro del asar (no es un path de filesystem
 * real) -- electron-builder.asarUnpack copia estos paquetes afuera, a
 * app.asar.unpacked/node_modules/, y este helper arma el path correcto en
 * ambos casos (dev sin asar, produccion con asar+unpack). Lee `bin` del
 * package.json REAL del paquete instalado en vez de hardcodear la ruta
 * interna -- confirmado con evidencia real (Tarea 1,
 * verify_python_lsp.md) que tanto typescript-language-server
 * (`{"typescript-language-server":"lib/cli.mjs"}`) como pyright
 * (`{"pyright-langserver":"langserver.index.js"}`) exponen esto de forma
 * directamente analoga.
 */
/**
 * Servidor MCP de LSP (docs/_arch/CONTRACT.md → "Servidor MCP de LSP para
 * los 3 CLIs"): este modulo ahora corre en 2 contextos reales, no solo
 * dentro de Electron main como hasta esta fase -- mcp-lsp-server.ts (nuevo)
 * es un proceso `node` PLANO, spawneado por claude-cli/codex/agy como su
 * propio hijo, AFUERA de Electron. `import { app } from 'electron'` estatico
 * ya no alcanza ahi: fuera del runtime real de Electron, requerir 'electron'
 * devuelve el path al binario (comportamiento real y documentado del
 * paquete npm 'electron'), no la API -- `app.getAppPath` no existe en ese
 * valor. `require()` dinamico + try/catch (mismo patron ya usado en este
 * codebase para officeparser/@napi-rs/canvas, document-reader.ts) en vez de
 * un import estatico, para no reventar la carga del modulo en el proceso
 * standalone. AMATISTA_APP_PATH (ENV, puesto por quien arma la config MCP
 * efimera en cli-agent-runtime.ts, via app.getAppPath() real del proceso
 * Electron que SI lo tiene) es el fallback real para ese caso -- dentro de
 * Electron real (el uso de siempre, los 4 runtimes API), esta funcion ni
 * llega a mirar el ENV.
 */
function resolveElectronAppPath(): string | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const electron = require('electron') as { app?: { getAppPath?: () => string } }
    if (typeof electron?.app?.getAppPath === 'function') return electron.app.getAppPath()
  } catch {
    // 'electron' no resuelve en absoluto en el proceso standalone -- cae al
    // fallback de ENV de abajo, no es un error real.
  }
  return process.env.AMATISTA_APP_PATH?.trim() || null
}

function resolveBundledServerEntry(packageName: string, binName: string): string | null {
  const appPath = resolveElectronAppPath()
  if (!appPath) return null
  const base = appPath.includes('app.asar') ? appPath.replace('app.asar', 'app.asar.unpacked') : appPath
  const pkgDir = path.join(base, 'node_modules', packageName)
  try {
    const pkgJson = JSON.parse(readFileSync(path.join(pkgDir, 'package.json'), 'utf8')) as { bin?: Record<string, string> }
    const relative = pkgJson.bin?.[binName]
    if (!relative) return null
    return path.join(pkgDir, relative)
  } catch {
    return null
  }
}

/** Prueba real: ¿este comando responde bien al argumento de verificacion
 *  que le pasen? Mismo criterio que tryVersion() (cli-status.ts), pero SIN
 *  shell:true -- un binario nativo (.exe) real, no un shim .cmd como
 *  gemini/codex; CreateProcess (via execFile/spawn) lo resuelve igual por
 *  PATH sin necesitar un shell de por medio (a diferencia de un .cmd, que
 *  si lo necesita para poder ejecutarse siquiera) -- evita de raiz el bug
 *  de arg-splitting que shell:true le causo a Gemini.
 *
 *  Soporte Go (docs/_arch/verify_go_lsp.md, Tarea 2): `versionArgs` ya NO
 *  esta hardcodeado a `['--version']` -- confirmado real que `gopls
 *  --version` FALLA (`flag provided but not defined: -version`, exit
 *  code 2) pese a que gopls esta genuinamente instalado; el comando real
 *  y correcto es el subcomando SIN guiones, `gopls version`. Cada
 *  resolveEntry() de LANGUAGE_SERVERS pasa el argumento que confirmo real
 *  para SU binario -- rust-analyzer sigue con `['--version']` (sin
 *  cambio), Go usa `['version']`. */
async function respondsToVersion(executable: string, versionArgs: string[]): Promise<boolean> {
  try {
    await execFileAsync(executable, versionArgs, { windowsHide: true, timeout: 12000, shell: false })
    return true
  } catch {
    return false
  }
}

/** Fallback conocido de instalacion (default real de `rustup` en Windows)
 *  -- MISMO patron de 2 niveles que ya usa cli-status.ts (PATH primero,
 *  ruta conocida de instalacion como respaldo), pero con un candidato
 *  propio de Rust -- NO reusa npmGlobalShimPath() (cli-agent-runtime.ts/
 *  cli-status.ts), esa es especifica de instalaciones `npm install -g`. */
function rustAnalyzerCargoBinPath(): string | null {
  if (process.platform !== 'win32') return null
  const home = process.env.USERPROFILE
  if (!home) return null
  return path.join(home, '.cargo', 'bin', 'rust-analyzer.exe')
}

/**
 * Resuelve rust-analyzer -- BINARIO EXTERNO, NO bundleado (confirmado con
 * evidencia real, docs/_arch/verify_rust_lsp.md Tarea 1: no existe un
 * paquete npm real que distribuya el binario; el unico paquete npm
 * relacionado real, coc-rust-analyzer, DESCARGA el binario nativo desde
 * GitHub Releases en tiempo de uso, no lo trae adentro). Primero intenta
 * por PATH (nombre simple, sin shell) -- si responde, ESE es el comando a
 * usar. Si no, cae al path conocido de rustup -- null si tampoco existe
 * ahi, mismo patron de "no disponible" que geminiCommand() (cli-agent-runtime.ts).
 */
async function resolveRustAnalyzerEntry(): Promise<string | null> {
  if (await respondsToVersion('rust-analyzer', ['--version'])) return 'rust-analyzer'

  const fallback = rustAnalyzerCargoBinPath()
  if (fallback && existsSync(fallback) && await respondsToVersion(fallback, ['--version'])) return fallback

  return null
}

const RUST_ANALYZER_INSTALL_HINT =
  'rust-analyzer no esta instalado -- instalalo con "rustup component add rust-analyzer" ' +
  '(o descargalo de los releases de rust-lang/rust-analyzer en GitHub) y volve a intentar.'

/** Fallback conocido de instalacion de gopls (default real de `go install`
 *  en Windows: GOBIN, o $GOPATH/bin si GOBIN no esta seteado -- confirmado
 *  real, docs/_arch/verify_go_lsp.md Tarea 2) -- mismo patron de 2 niveles
 *  que rustAnalyzerCargoBinPath(), candidato propio de Go. */
function goplsBinPath(): string | null {
  if (process.platform !== 'win32') return null
  const home = process.env.USERPROFILE
  if (!home) return null
  return path.join(home, 'go', 'bin', 'gopls.exe')
}

/**
 * Resuelve gopls -- BINARIO EXTERNO, NO bundleado (confirmado con
 * evidencia real, docs/_arch/verify_go_lsp.md Tarea 1: el paquete npm
 * "gopls" es un security holding package vacio). Mismo patron de 2
 * niveles que resolveRustAnalyzerEntry(), pero con `['version']` (SIN
 * guiones) como argumento de verificacion -- confirmado real que `gopls
 * --version` falla con exit code 2 pese a que gopls esta genuinamente
 * instalado (ver respondsToVersion() de mas arriba).
 */
async function resolveGoplsEntry(): Promise<string | null> {
  if (await respondsToVersion('gopls', ['version'])) return 'gopls'

  const fallback = goplsBinPath()
  if (fallback && existsSync(fallback) && await respondsToVersion(fallback, ['version'])) return fallback

  return null
}

/** Ruta conocida real del instalador oficial de Go en Windows (msi) --
 *  mismo criterio que rustAnalyzerCargoBinPath()/goplsBinPath(): una
 *  convencion real y estable, no derivada dinamicamente (confirmado real
 *  con `winget install GoLang.Go`, docs/_arch/verify_go_lsp.md). */
const GO_INSTALL_DIR = 'C:\\Program Files\\Go\\bin'

/**
 * Soporte Go (docs/_arch/verify_go_lsp.md, Tarea 1 -- hallazgo NO
 * anticipado): gopls arranca y hace el handshake `initialize` perfecto
 * incluso si el PATH del proceso hijo no incluye a `go` -- pero nunca
 * analiza nada, porque shellea a `go` internamente para cargar paquetes
 * reales (`go/packages.Load`). Confirmado real, aislado (sin pasar por
 * este cliente): con el PATH del proceso hijo sin el bin de Go, gopls
 * reporto por `window/showMessage` "go command required, not found;
 * exec: \"go\": executable file not found in %PATH%" y jamas publico
 * ningun diagnostico -- ni siquiera uno vacio. Con el bin de Go agregado
 * al `env` del `spawn()`, cargo el modulo real y publico el diagnostico
 * real. Este helper resuelve el directorio (no el binario) a agregar al
 * PATH del proceso hijo, mismo mecanismo de 2 niveles que
 * resolveGoplsEntry()/resolveRustAnalyzerEntry() -- NUNCA asumir que el
 * PATH heredado del proceso de Amatista ya lo incluye. Si `go` ya
 * responde por el PATH heredado, no hace falta agregar nada (el proceso
 * hijo hereda el mismo PATH que ya lo resuelve) -- solo se agrega el
 * directorio conocido si el PATH heredado no alcanza.
 */
async function resolveGoBinDirectory(): Promise<string | null> {
  if (await respondsToVersion('go', ['version'])) return null

  const goExe = path.join(GO_INSTALL_DIR, 'go.exe')
  return existsSync(goExe) && await respondsToVersion(goExe, ['version']) ? GO_INSTALL_DIR : null
}

const GOPLS_INSTALL_HINT =
  'gopls no esta instalado -- instalalo con "go install golang.org/x/tools/gopls@latest" ' +
  '(requiere tener Go instalado primero, ver https://go.dev/dl/) y volve a intentar.'

/** Ruta conocida real del instalador oficial de LLVM en Windows -- mismo
 *  criterio que GO_INSTALL_DIR/rustAnalyzerCargoBinPath(): una convencion
 *  real y estable (confirmado con la documentacion oficial de LLVM y el
 *  instalador real de llvm.org/releases -- "winget install LLVM.LLVM"
 *  instala aca), no derivada dinamicamente. */
const LLVM_INSTALL_DIR = 'C:\\Program Files\\LLVM\\bin'

/**
 * Soporte C/C++ (docs/_arch/verify_clangd_integration_scope.md): clangd es
 * BINARIO EXTERNO, NO bundleado -- confirmado real que el paquete npm
 * "clangd" (mantenido por los propios devs de LLVM/clangd) es un
 * placeholder de 391 bytes, sin `bin` ni binario -- misma categoria exacta
 * que el "security holding package" ya confirmado para gopls. Mismo patron
 * de 2 niveles que resolveRustAnalyzerEntry()/resolveGoplsEntry(): PATH
 * primero, fallback a LLVM_INSTALL_DIR. `--version` como argumento de
 * verificacion -- confirmado real con el binario 22.1.1 (a diferencia de
 * gopls, clangd SI acepta `--version` con guion sin problema).
 */
async function resolveClangdEntry(): Promise<string | null> {
  if (await respondsToVersion('clangd', ['--version'])) return 'clangd'

  const fallback = path.join(LLVM_INSTALL_DIR, 'clangd.exe')
  if (existsSync(fallback) && await respondsToVersion(fallback, ['--version'])) return fallback

  return null
}

const CLANGD_INSTALL_HINT =
  'clangd no esta instalado -- instalalo con el instalador oficial de LLVM (https://llvm.org/releases, ' +
  'o "winget install LLVM.LLVM" en Windows, "apt install clangd" en Debian/Ubuntu, "brew install llvm" en ' +
  'macOS) y volve a intentar.'

/**
 * Soporte Terraform (docs/_arch/verify_6_lsp_servers.md): terraform-ls es
 * BINARIO EXTERNO, NO bundleado -- confirmado real que no existe un
 * paquete npm real (`registry.npmjs.org` 404 para "terraform-ls"), mismo
 * patron exacto que gopls/clangd. Sin convencion de instalacion fija
 * conocida en Windows (a diferencia de LLVM/Go, sin instalador oficial con
 * ruta estandar) -- solo deteccion por PATH, sin fallback de 2do nivel.
 * `serve` es el unico subcomando real de servidor (confirmado con
 * `--help` real); sin flag `-port` corre en modo stdio (confirmado real
 * con handshake completo).
 */
async function terraformResolveCommand(): Promise<{ command: string[]; env?: Record<string, string> } | null> {
  if (!(await respondsToVersion('terraform-ls', ['--version']))) return null
  return { command: ['terraform-ls', 'serve'] }
}

const TERRAFORM_LS_INSTALL_HINT =
  'terraform-ls no esta instalado -- descargalo de https://releases.hashicorp.com/terraform-ls/ (el .zip de tu ' +
  'plataforma), extraelo y agregalo al PATH y volve a intentar.'

/**
 * Soporte Lua (docs/_arch/verify_6_lsp_servers.md): lua-language-server
 * (LuaLS) es BINARIO EXTERNO, NO bundleado -- confirmado real que no
 * existe en npm (404 real). Se distribuye solo como zip precompilado por
 * plataforma en GitHub Releases, sin convencion de instalacion fija en
 * Windows -- mismo criterio que terraform-ls, solo PATH. Confirmado real
 * (handshake completo + diagnosticos reales) que corre en stdio por
 * defecto sin ningun flag, y que el `.exe` es autocontenido (sin wrapper
 * `.bat`, sin runtime externo -- a diferencia de jdtls).
 */
async function luaResolveCommand(): Promise<{ command: string[]; env?: Record<string, string> } | null> {
  if (!(await respondsToVersion('lua-language-server', ['--version']))) return null
  return { command: ['lua-language-server'] }
}

const LUA_LANGUAGE_SERVER_INSTALL_HINT =
  'lua-language-server no esta instalado -- descargalo de https://github.com/LuaLS/lua-language-server/releases ' +
  '(el .zip de tu plataforma), extraelo y agregalo al PATH y volve a intentar.'

/**
 * Soporte YAML/ESLint/Bash (docs/_arch/verify_6_lsp_servers.md): los 3 son
 * paquetes npm reales y livianos (a diferencia de Rust/Go/C++/Java/
 * Terraform/Lua, binarios externos pesados) -- BUNDLEADOS con la app,
 * mismo patron exacto que typescript-language-server/pyright
 * (resolveBundledServerEntry(), envoltorio de Node embebido de Electron).
 * `bin` real confirmado leyendo el package.json instalado de cada uno --
 * NUNCA hardcodeado a mano (mismo criterio ya establecido).
 */
async function yamlResolveCommand(): Promise<{ command: string[]; env?: Record<string, string> } | null> {
  const entry = resolveBundledServerEntry('yaml-language-server', 'yaml-language-server')
  return entry ? { command: [process.execPath, entry, '--stdio'], env: { ELECTRON_RUN_AS_NODE: '1' } } : null
}

/**
 * `vscode-langservers-extracted` expone VARIOS bins (html/css/json/eslint) --
 * `vscode-eslint-language-server` es el real (literalmente el server de la
 * extension oficial vscode-eslint, extraido -- confirmado real, no una
 * reimplementacion de terceros). Necesita `configResponses`
 * (ESLINT_CONFIG_RESPONSE mas abajo) + pull-diagnostics para dar
 * resultados reales -- ver ambos en la entrada de LANGUAGE_SERVERS.
 * NO trae `eslint` embebido: lo resuelve via Node module resolution desde
 * el WORKSPACE DEL USUARIO (confirmado real) -- responsabilidad del
 * usuario tener `eslint` real instalado en su proyecto, Amatista no lo
 * bundlea ni lo fuerza.
 */
async function eslintResolveCommand(): Promise<{ command: string[]; env?: Record<string, string> } | null> {
  const entry = resolveBundledServerEntry('vscode-langservers-extracted', 'vscode-eslint-language-server')
  return entry ? { command: [process.execPath, entry, '--stdio'], env: { ELECTRON_RUN_AS_NODE: '1' } } : null
}

/**
 * Confirmado real: el subcomando de arranque es `start` (NO `--stdio`,
 * a diferencia de yaml/eslint). Diagnosticos reales de lint dependen 100%
 * de `shellcheck`, un binario nativo EXTERNO que el usuario provee aparte
 * (confirmado real: no es dependencia npm de bash-language-server, y no
 * hay paquete npm real que lo bundlee sin ser un wrapper de descarga) --
 * mismo espiritu que Java necesitando un JRE real instalado aparte de
 * jdtls. Sin `shellcheck` en el PATH del usuario, bash-language-server
 * igual da parsing/completado/hover/symbols/rename (tree-sitter), pero sin
 * ningun diagnostico de lint -- fallo real y confirmado limpio del lado
 * del servidor (warning + diagnosticos vacios, nunca un crash), no algo
 * que este resolveCommand() necesite manejar.
 */
async function bashResolveCommand(): Promise<{ command: string[]; env?: Record<string, string> } | null> {
  const entry = resolveBundledServerEntry('bash-language-server', 'bash-language-server')
  return entry ? { command: [process.execPath, entry, 'start'], env: { ELECTRON_RUN_AS_NODE: '1' } } : null
}

/**
 * Objeto MINIMO real confirmado (docs/_arch/verify_lsp_pull_config_implementation_design.md,
 * Tarea 1) -- cada campo arregla un crash real DISTINTO de
 * eslint-language-server al resolver settings (confirmado uno por uno,
 * nunca adivinado): sin `nodePath:null` explicito, `path.isAbsolute(undefined)`
 * revienta; sin `experimental.useFlatConfig`, TypeError leyendo esa
 * propiedad de undefined; sin `problems.shortenToSingleLine`, TypeError
 * silencioso (solo visible en window/logMessage real, la request de todos
 * modos devuelve items:[] sin ningun error de protocolo); sin
 * `rulesCustomizations`, TypeError iterando undefined. 100% ESTATICO --
 * ningun campo depende del workspace real (confirmado quitando
 * `workspaceFolder`/`packageManager`/etc. del objeto completo estilo
 * VSCode sin que se rompiera nada). `section:''` porque asi es como
 * eslint-language-server pide su config real (confirmado real, nunca una
 * sub-seccion con nombre).
 */
const ESLINT_CONFIG_RESPONSE: Record<string, unknown> = {
  '': {
    validate: 'on',
    nodePath: null,
    experimental: { useFlatConfig: false },
    problems: { shortenToSingleLine: false },
    rulesCustomizations: []
  }
}

/** Envoltorios `resolveCommand()` para los 5 lenguajes ya existentes --
 *  reusan los `resolveXEntry()` de arriba TAL CUAL (misma logica real de
 *  deteccion, sin cambios), solo arman la forma final `{command, env?}`
 *  que el esquema config-driven espera. `workspace` se ignora en los 5: la
 *  UNICA razon de que estas firmas lo reciban es la uniformidad con jdtls
 *  (mas abajo), que si lo necesita. */
async function typescriptResolveCommand(): Promise<{ command: string[]; env?: Record<string, string> } | null> {
  const entry = resolveBundledServerEntry('typescript-language-server', 'typescript-language-server')
  return entry ? { command: [process.execPath, entry, '--stdio'], env: { ELECTRON_RUN_AS_NODE: '1' } } : null
}

async function pythonResolveCommand(): Promise<{ command: string[]; env?: Record<string, string> } | null> {
  const entry = resolveBundledServerEntry('pyright', 'pyright-langserver')
  return entry ? { command: [process.execPath, entry, '--stdio'], env: { ELECTRON_RUN_AS_NODE: '1' } } : null
}

async function rustResolveCommand(): Promise<{ command: string[]; env?: Record<string, string> } | null> {
  // Confirmado real: rust-analyzer usa stdio POR DEFECTO, sin flag --
  // pasarle --stdio (como TypeScript/Python) hace que rechace el argumento
  // y termine de entrada (ver historial mas arriba).
  const entry = await resolveRustAnalyzerEntry()
  return entry ? { command: [entry] } : null
}

async function goResolveCommand(): Promise<{ command: string[]; env?: Record<string, string> } | null> {
  // Confirmado real: gopls tambien usa stdio POR DEFECTO -- mismo shape que
  // Rust. extraPathDirs (Go, verify_go_lsp.md Tarea 3) se pliega aca directo
  // en `env.PATH` -- ya no es un campo propio del esquema, el resultado es
  // el mismo (gopls shellea a `go`, y el PATH heredado de Amatista puede no
  // incluirlo).
  const entry = await resolveGoplsEntry()
  if (!entry) return null
  const extraDir = await resolveGoBinDirectory()
  const env = extraDir ? { PATH: [process.env.PATH, extraDir].filter(Boolean).join(path.delimiter) } : undefined
  return { command: [entry], env }
}

async function clangdResolveCommand(): Promise<{ command: string[]; env?: Record<string, string> } | null> {
  // Confirmado real (handshake LSP real completo contra el binario 22.1.1):
  // clangd tambien usa stdio POR DEFECTO -- mismo shape que Rust/Go.
  const entry = await resolveClangdEntry()
  return entry ? { command: [entry] } : null
}

/**
 * Soporte Java (docs/_arch/verify_jdtls_integration_scope.md +
 * verify_lsp_config_redesign.md): jdtls (Eclipse JDT Language Server) es el
 * unico de los 6 que rompe las 3 asunciones simples de los demas -- el
 * "entry" real es `java` + un jar VERSIONADO (resuelto por glob, el nombre
 * cambia entre releases), necesita un directorio `-data` UNICO por
 * workspace (no un flag fijo), y la lista de argumentos cambia segun la
 * version de Java detectada en tiempo de ejecucion. Confirmado real que
 * OpenCode resuelve exactamente esto mismo, del mismo modo -- sin ningun
 * wrapper script externo, todo en una funcion real de resolucion (aca,
 * `resolveJdtlsCommand`), igual que ya hacian resolveRustAnalyzerEntry()/
 * resolveGoplsEntry()/resolveClangdEntry() para su propia complejidad.
 */
function jdtlsHomeCandidate(): string | null {
  // Sin convencion oficial real de instalacion en Windows (a diferencia de
  // LLVM/Go, que si tienen instaladores oficiales con una ruta conocida) --
  // confirmado ayer que la UNICA distribucion real es el tarball crudo de
  // Eclipse. JDTLS_HOME (override real explicito) primero; si no esta seteada
  // o no apunta a una instalacion real (con su carpeta plugins/ adentro),
  // Amatista define su propia convencion bajo su carpeta de datos.
  const override = process.env.JDTLS_HOME?.trim()
  if (override && existsSync(path.join(override, 'plugins'))) return override
  const knownLocation = getAppDataSubdir('jdtls')
  return existsSync(path.join(knownLocation, 'plugins')) ? knownLocation : null
}

/** Mismo criterio de glob real que confirmo el propio codigo fuente de
 *  OpenCode (server.ts: `/^org\.eclipse\.equinox\.launcher_.*\.jar$/`) --
 *  el nombre del jar del launcher cambia de version en version, nunca un
 *  path fijo. */
function resolveEquinoxLauncherJar(jdtlsHome: string): string | null {
  const pluginsDir = path.join(jdtlsHome, 'plugins')
  if (!existsSync(pluginsDir)) return null
  try {
    const launcher = readdirSync(pluginsDir).find(name => /^org\.eclipse\.equinox\.launcher_.*\.jar$/.test(name))
    return launcher ? path.join(pluginsDir, launcher) : null
  } catch {
    return null
  }
}

/** `config_win`/`config_linux[_arm]`/`config_mac[_arm]` -- confirmado real
 *  en la distribucion oficial descargada ayer (sin variante `_arm` para
 *  Windows en este build real). */
function jdtlsConfigDir(jdtlsHome: string): string {
  const arm = process.arch === 'arm64' ? '_arm' : ''
  const name = process.platform === 'win32' ? 'config_win' : process.platform === 'darwin' ? `config_mac${arm}` : `config_linux${arm}`
  return path.join(jdtlsHome, name)
}

/** `-data` ESTABLE por workspace (no un temporal por invocacion como
 *  fs.mkdtemp() en OpenCode) -- mismo criterio real ya usado por
 *  workspaceId() en local-vcs.ts para el mismo problema (una carpeta propia
 *  y reproducible por workspace, bajo la carpeta de datos de Amatista):
 *  jdtls indexa el proyecto la primera vez, reusar el mismo `-data` entre
 *  turnos de la misma sesion/workspace evita repetir esa indexacion en cada
 *  reconexion. */
function jdtlsDataDir(workspace: string): string {
  const hash = createHash('sha256').update(workspace).digest('hex').slice(0, 16)
  return getAppDataSubdir('jdtls-data', hash)
}

/** Real, confirmado ejecutando el binario real ayer: `java -version`
 *  imprime la version a STDERR, formato `... version "25.0.2" ...` (o
 *  `"1.8.0_..."` en Java 8 viejo, el regex solo necesita el primer grupo de
 *  digitos). JAVA_HOME (si esta seteada y apunta a un java.exe/java real)
 *  tiene prioridad sobre el PATH -- mismo criterio real que ya usa el propio
 *  jdtls.py oficial (leido ayer completo). */
async function resolveJavaRuntime(): Promise<{ executable: string; majorVersion: number } | null> {
  const javaHome = process.env.JAVA_HOME?.trim()
  const javaHomeExe = javaHome ? path.join(javaHome, 'bin', process.platform === 'win32' ? 'java.exe' : 'java') : null
  const executable = javaHomeExe && existsSync(javaHomeExe) ? javaHomeExe : 'java'
  try {
    const { stdout, stderr } = await execFileAsync(executable, ['-version'], { windowsHide: true, timeout: 12000, shell: false })
    const match = `${stdout}${stderr}`.match(/version\s+"(\d+)/)
    if (!match) return null
    return { executable, majorVersion: Number(match[1]) }
  } catch {
    return null
  }
}

const JDTLS_INSTALL_HINT =
  'jdtls (Eclipse JDT Language Server) no esta instalado -- descargalo de ' +
  'https://download.eclipse.org/jdtls/snapshots/jdt-language-server-latest.tar.gz, extraelo TAL CUAL (con su ' +
  'carpeta plugins/ adentro) en la carpeta de datos de Amatista bajo "jdtls" (o seteá JDTLS_HOME apuntando a ' +
  'otra carpeta ya extraida), y volve a intentar. Requiere ademas Java 21 o mas nuevo instalado aparte ' +
  '(seteá JAVA_HOME si no esta en el PATH).'

async function jdtlsResolveCommand(workspace: string): Promise<{ command: string[]; env?: Record<string, string> } | null> {
  const jdtlsHome = jdtlsHomeCandidate()
  if (!jdtlsHome) return null
  const java = await resolveJavaRuntime()
  if (!java || java.majorVersion < 21) return null
  const launcherJar = resolveEquinoxLauncherJar(jdtlsHome)
  if (!launcherJar) return null

  const args = [
    '-Declipse.application=org.eclipse.jdt.ls.core.id1',
    '-Dosgi.bundles.defaultStartLevel=4',
    '-Declipse.product=org.eclipse.jdt.ls.core.product',
    '-Dosgi.checkConfiguration=true',
    `-Dosgi.sharedConfiguration.area=${jdtlsConfigDir(jdtlsHome)}`,
    '-Dosgi.sharedConfiguration.area.readOnly=true',
    '-Dosgi.configuration.cascaded=true',
    '-Xms1G',
    '--add-modules=ALL-SYSTEM',
    '--add-opens', 'java.base/java.util=ALL-UNNAMED',
    '--add-opens', 'java.base/java.lang=ALL-UNNAMED',
    // Confirmado real ayer (Java 25 Temurin real, disparo estos 2 flags):
    // el propio jdtls.py oficial solo los agrega si la version de Java
    // detectada es >= 24 -- la lista de argumentos NO es fija ni siquiera
    // para una instalacion fija de jdtls, depende de que JRE la ejecute.
    ...(java.majorVersion >= 24 ? ['-Djdk.xml.maxGeneralEntitySizeLimit=0', '-Djdk.xml.totalEntitySizeLimit=0'] : []),
    '-jar', launcherJar,
    '-data', jdtlsDataDir(workspace)
  ]
  return { command: [java.executable, ...args] }
}

const LANGUAGE_SERVERS: LanguageServerConfig[] = [
  {
    languageId: 'typescript',
    extensions: ['.ts', '.tsx'],
    resolveCommand: typescriptResolveCommand
  },
  {
    languageId: 'python',
    extensions: ['.py'],
    resolveCommand: pythonResolveCommand
  },
  {
    languageId: 'rust',
    extensions: ['.rs'],
    resolveCommand: rustResolveCommand,
    installHint: RUST_ANALYZER_INSTALL_HINT
  },
  {
    languageId: 'go',
    extensions: ['.go'],
    resolveCommand: goResolveCommand,
    installHint: GOPLS_INSTALL_HINT
  },
  {
    // languageId 'cpp' cubre TODAS las extensiones de esta entrada (C
    // incluido) a proposito -- confirmado real (docs/_arch/
    // verify_clangd_integration_scope.md, Tarea 4) que clangd decide C vs
    // C++ por la extension REAL del archivo (su propio driver de clang
    // interno construye el comando de fallback en base al path del
    // archivo), NO por el languageId que este cliente declara en
    // textDocument/didOpen -- probado real con un mismatch deliberado
    // (.c con languageId:'cpp' declarado): clangd igual lo trato como C
    // (indexo la libc de C, rechazo un #include<string> de C++ real). A
    // diferencia de TypeScript (.tsx SI necesita su propio languageId real,
    // ver languageIdFor() mas abajo), este NO es un caso especial que
    // languageIdFor() necesite manejar.
    languageId: 'cpp',
    // Alcance deliberado, NO automatico (mismo criterio que Python/Fase 20):
    // .c/.h (C) + .cpp/.cc/.cxx (implementacion C++) + .hpp/.hh/.hxx
    // (headers C++) -- las convenciones de extension mas comunes reales.
    // Quedan afuera a proposito variantes reales pero mucho menos comunes
    // (.c++/.h++, .ino de Arduino, .m/.mm de Objective-C/C++, que clangd
    // tambien puede analizar) -- sumarlas es la unica accion necesaria si
    // se quiere despues, documentado aca para que sea explicito.
    extensions: ['.c', '.h', '.cpp', '.cc', '.cxx', '.hpp', '.hh', '.hxx'],
    resolveCommand: clangdResolveCommand,
    installHint: CLANGD_INSTALL_HINT
  },
  {
    languageId: 'java',
    extensions: ['.java'],
    resolveCommand: jdtlsResolveCommand,
    installHint: JDTLS_INSTALL_HINT
  },
  {
    languageId: 'terraform',
    extensions: ['.tf', '.tfvars'],
    resolveCommand: terraformResolveCommand,
    installHint: TERRAFORM_LS_INSTALL_HINT
  },
  {
    languageId: 'lua',
    extensions: ['.lua'],
    resolveCommand: luaResolveCommand,
    installHint: LUA_LANGUAGE_SERVER_INSTALL_HINT
  },
  {
    languageId: 'yaml',
    extensions: ['.yaml', '.yml'],
    resolveCommand: yamlResolveCommand
    // Sin installHint -- bundleado con la app (mismo criterio que
    // TypeScript/Python), no deberia fallar en la practica.
  },
  {
    // Alcance deliberado (mismo criterio que Python/C++/Fase 20): SOLO
    // .js/.jsx/.mjs/.cjs, NUNCA .ts/.tsx -- esas 2 extensiones ya
    // pertenecen a la entrada 'typescript' de arriba (typescript-language-server,
    // que da chequeo de TIPOS real, distinto de lint). languageServerConfigFor()
    // resuelve UN SOLO config por extension (el primero que matchea) --
    // agregar .ts/.tsx aca las robaria de typescript-language-server sin
    // ganar nada (eslint-language-server no chequea tipos), perdiendo
    // diagnosticos reales de tipado a cambio de lint. Dar soporte real de
    // ESLint tambien sobre .ts/.tsx (2 servidores por archivo, resultados
    // fusionados) es un cambio de arquitectura mas grande, fuera de
    // alcance de esta fase -- documentado aca para que sea explicito, no
    // una omision silenciosa.
    languageId: 'javascript',
    extensions: ['.js', '.jsx', '.mjs', '.cjs'],
    resolveCommand: eslintResolveCommand,
    configResponses: ESLINT_CONFIG_RESPONSE
  },
  {
    languageId: 'shellscript',
    extensions: ['.sh', '.bash'],
    resolveCommand: bashResolveCommand
    // Sin installHint -- bundleado con la app. shellcheck (dependencia
    // real de los DIAGNOSTICOS, no del arranque del servidor en si) es
    // responsabilidad del usuario, ver comentario real de bashResolveCommand().
  }
]

/** Ruta real del archivo de config global (mismo directorio que
 *  settings.json -- getAppDataSubdir('config'), mismo criterio "carpeta de
 *  config de la app" ya establecido). */
function globalLspConfigPath(): string {
  return path.join(getAppDataSubdir('config'), 'lsp.json')
}

/** Entrada real que el usuario escribe a mano en lsp.json/.lsp.json --
 *  SIEMPRE estatica (confirmado real contra el codigo fuente de OpenCode:
 *  `command` nunca es dinamico en el esquema que edita un humano). Mismo
 *  shape final que LanguageServerConfig.resolveCommand() ya produce para
 *  los built-in, por eso una entrada custom encaja sin ningun caso especial
 *  en el resto del mecanismo (LspManager/LspClient no distinguen origen). */
interface CustomLspEntry {
  command?: string[]
  extensions?: string[]
  env?: Record<string, string>
  /** true = apaga esta clave (built-in o custom de un nivel anterior) por
   *  completo -- mismo campo real que ya usa OpenCode para lo mismo. */
  disabled?: boolean
  /** Mismo campo/shape que `LanguageServerConfig.configResponses` (ver ahi) --
   *  permite a un servidor custom del usuario (o a un override de un
   *  built-in con la MISMA clave, mismo criterio de reemplazo total por
   *  clave que ya usa este mecanismo) responder workspace/configuration
   *  con valores reales, estaticos, sin necesitar ningun cambio de codigo. */
  configResponses?: Record<string, unknown>
}

/** Cache real por archivo (path -> {mtimeMs, entries}) -- evita reparsear
 *  el mismo JSON en cada llamada de languageServerConfigFor() (que puede
 *  ser frecuente, una por tool LSP), pero SIN necesitar reiniciar la app
 *  para que una edicion real del archivo se note: se invalida sola apenas
 *  cambia el mtime real en disco. */
const customLspFileCache = new Map<string, { mtimeMs: number; entries: Record<string, CustomLspEntry> }>()

function readCustomLspEntries(filePath: string): Record<string, CustomLspEntry> {
  try {
    const stat = statSync(filePath)
    const cached = customLspFileCache.get(filePath)
    if (cached && cached.mtimeMs === stat.mtimeMs) return cached.entries
    const raw = JSON.parse(readFileSync(filePath, 'utf8')) as unknown
    const entries = typeof raw === 'object' && raw !== null ? raw as Record<string, CustomLspEntry> : {}
    customLspFileCache.set(filePath, { mtimeMs: stat.mtimeMs, entries })
    return entries
  } catch {
    // Archivo ausente o JSON invalido -- mismo criterio que .mcp.json
    // (mcp-client.ts): se ignora, nunca bloquea el resto de los lenguajes
    // ya soportados.
    return {}
  }
}

function applyCustomLspEntries(table: Map<string, LanguageServerConfig>, entries: Record<string, CustomLspEntry>): void {
  for (const [languageId, entry] of Object.entries(entries)) {
    if (entry.disabled) {
      table.delete(languageId)
      continue
    }
    if (!Array.isArray(entry.command) || entry.command.length === 0 || !Array.isArray(entry.extensions)) continue
    const command = entry.command
    const env = entry.env
    table.set(languageId, {
      languageId,
      extensions: entry.extensions,
      resolveCommand: async () => ({ command, env }),
      configResponses: entry.configResponses
    })
  }
}

/**
 * Merge real, por CLAVE (languageId), no por archivo completo -- mismo
 * principio que confirmo la documentacion real de OpenCode ("later configs
 * override earlier ones only for conflicting keys"): built-in primero,
 * lsp.json global despues (pisa built-ins con la MISMA clave), .lsp.json
 * del workspace al final (pisa a los 2 anteriores) -- solo si `workspace`
 * se pasa, ver languageServerConfigFor().
 */
function mergedLanguageServers(workspace?: string): LanguageServerConfig[] {
  const table = new Map<string, LanguageServerConfig>()
  for (const def of LANGUAGE_SERVERS) table.set(def.languageId, def)
  applyCustomLspEntries(table, readCustomLspEntries(globalLspConfigPath()))
  if (workspace) applyCustomLspEntries(table, readCustomLspEntries(path.join(workspace, '.lsp.json')))
  return Array.from(table.values())
}

/** `workspace` opcional: sin el, solo built-ins + lsp.json global (usado
 *  por languageIdFor(), que no tiene el workspace a mano -- ver esa
 *  funcion). Con el, tambien aplica el override real de .lsp.json de ESE
 *  workspace puntual (LspManager, que si lo conoce). */
export function languageServerConfigFor(filePath: string, workspace?: string): LanguageServerConfig | undefined {
  const ext = path.extname(filePath).toLowerCase()
  return mergedLanguageServers(workspace).find(config => config.extensions.includes(ext))
}

export function isLspSupportedFile(filePath: string, workspace?: string): boolean {
  return languageServerConfigFor(filePath, workspace) !== undefined
}

/** Matiz real preexistente (Fase 20, sin cambios de comportamiento): .tsx
 *  declara languageId 'typescriptreact' en didOpen pese a compartir el
 *  MISMO proceso/config que .ts ('typescript') -- intrinseco a como
 *  TypeScript separa JSX del protocolo LSP, no una excepcion del mecanismo
 *  de tabla en si (Python no tiene un caso equivalente hoy). */
function languageIdFor(filePath: string): string {
  const config = languageServerConfigFor(filePath)
  const ext = path.extname(filePath).toLowerCase()
  if (config?.languageId === 'typescript' && ext === '.tsx') {
    return 'typescriptreact'
  }
  // Mismo matiz real que .tsx -- .jsx declara su propio languageId pese a
  // compartir el mismo proceso/config que el resto de la entrada 'javascript'.
  if (config?.languageId === 'javascript' && ext === '.jsx') {
    return 'javascriptreact'
  }
  return config?.languageId ?? 'plaintext'
}

/** Fase 20: clave de correlacion path<->diagnosticos -- SIEMPRE decodificar
 *  el URI real y comparar paths normalizados (resolve + lowercase en
 *  Windows), NUNCA comparar el string del URI tal cual. Confirmado en vivo:
 *  el URI que devuelve el servidor (file:///c%3A/...) no matchea por
 *  string contra pathToFileURL() de Node (file:///C:/...) pese a ser el
 *  mismo archivo real. */
function normalizePathKey(absolutePath: string): string {
  const resolved = path.resolve(absolutePath)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

function uriToPathKey(uri: string): string | null {
  try {
    return normalizePathKey(fileURLToPath(uri))
  } catch {
    return null
  }
}

/**
 * Soporte pull-diagnostics (docs/_arch/verify_lsp_pull_config_implementation_design.md,
 * Tarea 3-4): parseo de un item de diagnostico -- EXTRAIDO de
 * onPublishDiagnostics() (antes inline, sin cambio de logica) para que
 * pullDiagnostics() (mas abajo) reuse EXACTAMENTE la misma conversion --
 * confirmado real que un item de `textDocument/diagnostic` (pull) tiene el
 * mismo shape (message/range/severity/code/source) que un item de
 * `textDocument/publishDiagnostics` (push), mismo spec LSP subyacente.
 */
function parseDiagnosticItems(list: unknown[]): LspDiagnostic[] {
  return list.map(item => {
    const d = item as {
      message?: string
      range?: { start?: { line?: number; character?: number } }
      severity?: number
      code?: string | number
      source?: string
    }
    const { line, column } = fromLspPosition(d.range?.start)
    return {
      message: typeof d.message === 'string' ? d.message : '(sin mensaje)',
      line,
      column,
      severity: typeof d.severity === 'number' ? d.severity : 1,
      code: d.code,
      source: d.source
    }
  })
}

/**
 * Indexacion por simbolos (docs/_arch/verify_lsp_symbols.md): unico par de
 * funciones que convierte posiciones en AMBAS direcciones -- LSP manda y
 * espera recibir line/character 0-indexados (ver LspDiagnostic.line mas
 * arriba, que ya hace el +1 al RECIBIR). find_definition/find_references
 * necesitan la direccion inversa, que no existia hasta ahora: el usuario
 * pasa una posicion 1-indexada como parametro de la tool, hay que restarle
 * 1 antes de mandarla al servidor. onPublishDiagnostics() se refactoriza
 * mas abajo para usar fromLspPosition() en vez de repetir el mismo +1 a
 * mano -- un solo punto de verdad para la conversion, en ambas direcciones.
 */
function toLspPosition(line: number, column: number): { line: number; character: number } {
  return { line: line - 1, character: column - 1 }
}

function fromLspPosition(position: { line?: number; character?: number } | undefined): { line: number; column: number } {
  return { line: (position?.line ?? 0) + 1, column: (position?.character ?? 0) + 1 }
}

/** Resultado normalizado de find_definition/find_references -- `path` ya
 *  decodificado del URI real que devolvio el servidor (fileURLToPath(),
 *  NUNCA comparado como string, mismo criterio que uriToPathKey()), linea/
 *  columna 1-indexadas (fromLspPosition()). El path devuelto puede ser
 *  CUALQUIER archivo del workspace (o fuera de el, ej. una lib de node_modules/
 *  stdlib) -- a diferencia de get_diagnostics, no tiene por que coincidir
 *  con el archivo consultado. */
export interface LspLocation {
  path: string
  line: number
  column: number
}

/**
 * `textDocument/definition` puede devolver 3 formas reales distintas segun
 * el spec LSP (`Location | Location[] | LocationLink[] | null`) --
 * confirmado que no hay que asumir una sola forma (docs/_arch/verify_lsp_symbols.md,
 * Tarea 4: a verificar cual usa cada servidor en la practica). `Location`
 * tiene `uri`/`range`; `LocationLink` tiene `targetUri`/`targetSelectionRange`
 * (el rango preciso del simbolo, preferido) o `targetRange` (la declaracion
 * completa, fallback) en su lugar. `textDocument/references` siempre
 * devuelve `Location[] | null` (sin la ambiguedad de LocationLink) -- misma
 * funcion sirve para los dos, un `Location[]` es simplemente el caso mas
 * simple de las 3 formas.
 */
function toLspLocations(result: unknown): LspLocation[] {
  if (!result) return []
  const items = Array.isArray(result) ? result : [result]
  const locations: LspLocation[] = []
  for (const item of items) {
    const rec = item as {
      uri?: string
      range?: { start?: { line?: number; character?: number } }
      targetUri?: string
      targetRange?: { start?: { line?: number; character?: number } }
      targetSelectionRange?: { start?: { line?: number; character?: number } }
    }
    const uri = typeof rec.uri === 'string' ? rec.uri : rec.targetUri
    if (typeof uri !== 'string') continue
    const range = rec.range ?? rec.targetSelectionRange ?? rec.targetRange
    let absolutePath: string
    try {
      absolutePath = fileURLToPath(uri)
    } catch {
      continue
    }
    const { line, column } = fromLspPosition(range?.start)
    locations.push({ path: absolutePath, line, column })
  }
  return locations
}

/** Resultado normalizado de list_symbols -- `path` solo viene poblado
 *  cuando el simbolo vino de OTRO archivo (workspace/symbol, busqueda por
 *  nombre en todo el workspace); documentSymbol() (un archivo puntual) lo
 *  deja undefined a proposito, ya lo sabe el llamador (es el archivo que
 *  pidio). `kind` es el numero real de SymbolKind del spec LSP (1=File,
 *  5=Class, 12=Function, etc.) -- se devuelve tal cual, sin traducir a
 *  texto aca (decision de la tool, no del cliente). */
export interface LspSymbol {
  name: string
  kind: number
  line: number
  column: number
  path?: string
}

/**
 * `textDocument/documentSymbol` puede devolver 2 formas reales distintas
 * segun el spec LSP: `DocumentSymbol[]` (jerarquico, con `children`
 * anidados, `selectionRange` propio) o `SymbolInformation[]` (plano, con
 * `location: {uri, range}` absoluta, sin jerarquia). `workspace/symbol`
 * devuelve `SymbolInformation[] | WorkspaceSymbol[]` (mismo shape plano con
 * `location`). Una sola funcion recursiva cubre los 3 casos -- aplana
 * `children` si vienen anidados, nunca los descarta.
 */
function flattenDocumentSymbols(items: unknown, into: LspSymbol[] = []): LspSymbol[] {
  if (!Array.isArray(items)) return into
  for (const item of items) {
    const rec = item as {
      name?: string
      kind?: number
      selectionRange?: { start?: { line?: number; character?: number } }
      range?: { start?: { line?: number; character?: number } }
      location?: { uri?: string; range?: { start?: { line?: number; character?: number } } }
      children?: unknown
    }
    const name = typeof rec.name === 'string' ? rec.name : '(sin nombre)'
    const kind = typeof rec.kind === 'number' ? rec.kind : 0
    if (rec.location) {
      // SymbolInformation / WorkspaceSymbol -- plano, con location absoluta.
      const { line, column } = fromLspPosition(rec.location.range?.start)
      let absolutePath: string | undefined
      try {
        absolutePath = typeof rec.location.uri === 'string' ? fileURLToPath(rec.location.uri) : undefined
      } catch {
        absolutePath = undefined
      }
      into.push({ name, kind, line, column, path: absolutePath })
    } else {
      // DocumentSymbol -- jerarquico, sin uri (implicito: el archivo pedido).
      const { line, column } = fromLspPosition(rec.selectionRange?.start ?? rec.range?.start)
      into.push({ name, kind, line, column })
    }
    if (Array.isArray(rec.children)) flattenDocumentSymbols(rec.children, into)
  }
  return into
}

export class LspClient {
  private child: ChildProcess | null = null
  private framer = new LspFramer()
  private nextId = 1
  /**
   * Demo grabada (docs/_arch/verify_lsp_demo_scope.md, Tarea 1-2): `method`/
   * `sentAt` agregados a lo que ya se guardaba (`resolve`/`reject`) -- MISMO
   * cambio de estructura sirve para las 2 tareas a la vez, tal cual se
   * confirmo en la investigacion (no hacia falta un mecanismo separado por
   * tarea). `sentAt` es el timestamp REAL de cuando se escribio el request
   * al stdin del proceso -- permite medir latencia real de ida y vuelta al
   * resolverse en handleChunk(), no una aproximacion.
   */
  private pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: unknown) => void; method: string; sentAt: number }>()
  private diagnostics = new Map<string, FileDiagnosticsEntry>()
  /** version por documento abierto -- clave = normalizePathKey(). Presencia
   *  en este Map = "ya se mando didOpen para este archivo en esta sesion",
   *  decide si el proximo touch manda didOpen (primera vez) o didChange
   *  (ya abierto). */
  private openVersions = new Map<string, number>()
  /** Timestamp del ultimo didOpen/didChange mandado por archivo -- get_diagnostics
   *  lo usa como "desde cuando" para decidir si el diagnostico en cache ya
   *  esta fresco o todavia corresponde a una version vieja del archivo. */
  private lastEditAt = new Map<string, number>()
  /**
   * Fix de aislamiento (docs/_arch/verify_lsp_demo_scope.md, Tarea 3):
   * subconjunto de openVersions -- SOLO los archivos abiertos por una
   * edicion REAL (notifyFileWritten(), write_file/apply_patch), nunca los
   * abiertos solo para navegar (ensureOpen(), find_definition/
   * find_references/list_symbols). Confirmado real ANTES del fix: sin esta
   * distincion, get_diagnostics() sin path mostraba el error preexistente
   * de un archivo que el modelo solo habia consultado con list_symbols,
   * jamas editado -- contaminacion real, no hipotetica. Una edicion real
   * NUNCA se degrada: una vez agregado aca, un archivo se queda editado
   * aunque despues se navegue de nuevo (ver notifyFileChanged()).
   */
  private editedPaths = new Set<string>()
  private starting: Promise<void> | null = null
  /** Soporte Go (docs/_arch/verify_go_lsp.md, Tarea 1): ultimo mensaje real
   *  de severidad Error (window/showMessage, type===1) que el servidor
   *  reporto -- distinto de "no se pudo arrancar" (eso ya lo cubre el
   *  throw de start()/LspManager.startupFailureFor()): ESTE caso es
   *  "arranco perfecto, pero no puede analizar nada" (confirmado real:
   *  gopls hace el handshake initialize bien igual sin `go` en el PATH del
   *  proceso hijo, y recien despues informa el problema por esta via, sin
   *  publicar nunca ningun diagnostico). Se limpia solo si el servidor
   *  efectivamente llega a publicar diagnosticos despues (onPublishDiagnostics) --
   *  señal real de que ya esta funcionando, un error viejo no debe seguir
   *  mostrandose para siempre. */
  private lastErrorMessage: string | undefined

  /** Ultimo mensaje real de severidad Error reportado por el servidor
   *  (window/showMessage) -- ver comentario del campo mas arriba. */
  getLastErrorMessage(): string | undefined {
    return this.lastErrorMessage
  }

  /** Indexacion por simbolos (docs/_arch/verify_lsp_symbols.md, Tarea 2):
   *  `capabilities` REAL que devolvio el servidor en su respuesta de
   *  `initialize` -- capturado en start(), consultado por
   *  supportsCapability() antes de mandar definition/references/
   *  documentSymbol/workspaceSymbol. undefined solo si start() nunca
   *  corrio (no deberia pasar, supportsCapability() solo se llama despues
   *  de un start() exitoso). */
  private serverCapabilities: Record<string, unknown> | undefined

  /** Soporte YAML/ESLint/Bash (docs/_arch/verify_lsp_pull_config_implementation_design.md):
   *  guardado en start() -- ANTES esta clase no retenia el `config` una vez
   *  arrancado el proceso (no le hacia falta). Ahora buildConfigurationResponse()
   *  lo consulta para saber que responder a un workspace/configuration real
   *  entrante, por eso hace falta conservarlo mas alla de start(). */
  private config: LanguageServerConfig | undefined

  /** true si el servidor anuncio soporte real para esta capability en su
   *  respuesta real de initialize -- CHEQUEO POR TRUTHINESS, nunca
   *  `=== true` (confirmado real, docs/_arch/verify_lsp_symbols.md Tarea 2:
   *  pyright anuncia definitionProvider/referencesProvider/etc como OBJETO,
   *  `{workDoneProgress: true}`, no como booleano -- un `=== true` estricto
   *  daria falso negativo para pyright pese a soportarlo de verdad). */
  supportsCapability(name: string): boolean {
    const value = this.serverCapabilities?.[name]
    return value !== undefined && value !== null && value !== false
  }

  /** Arranca el proceso real y hace el handshake completo (initialize +
   *  initialized). Idempotente: si ya esta arrancando o arrancado, no
   *  vuelve a spawnear nada. `config` decide QUE language server spawnear
   *  (LspManager ya resolvio cual segun la extension del archivo que
   *  disparo el arranque perezoso) -- esta clase no sabe nada de
   *  TypeScript/Python/Rust/Go/C/C++/Java en si misma, solo habla el
   *  protocolo generico.
   *
   *  Rediseño config-driven (docs/_arch/verify_lsp_config_redesign.md):
   *  `config.resolveCommand(workspace)` devuelve la forma YA resuelta y
   *  lista para spawnear (`{command, env?}`) -- toda la complejidad real de
   *  COMO invocar cada language server (envoltorio de Node embebido para
   *  TypeScript/Python, PATH extra para Go, glob de jar + version de Java
   *  para jdtls, o simplemente el binario tal cual para Rust/clangd/una
   *  entrada custom del usuario) vive DENTRO de esa funcion, nunca aca --
   *  este metodo spawnea `command` tal cual, un solo camino, sin ningun
   *  `if` por tipo de servidor. */
  start(workspace: string, config: LanguageServerConfig): Promise<void> {
    if (this.child) return Promise.resolve()
    if (this.starting) return this.starting

    this.starting = (async () => {
      this.config = config
      const resolved = await config.resolveCommand(workspace)
      if (!resolved) {
        throw new Error(config.installHint ?? `No se pudo resolver el comando del language server de "${config.languageId}".`)
      }
      const [command, ...args] = resolved.command
      const child = spawn(command, args, {
        cwd: workspace,
        env: resolved.env ? { ...process.env, ...resolved.env } : process.env,
        windowsHide: true,
        shell: false
      })
      this.child = child

      child.stdout?.on('data', chunk => this.handleChunk(chunk))
      child.stderr?.on('data', () => {
        // stderr del language server: diagnostico interno del propio
        // proceso (no de TypeScript), se ignora a proposito -- no es un
        // canal de datos del protocolo LSP, y no hay UI hoy para logs
        // separados de este subproceso especifico.
      })
      child.on('exit', () => {
        this.child = null
      })

      const workspaceUri = pathToFileURL(workspace).href
      const initResult = await this.request('initialize', {
        processId: process.pid,
        rootUri: workspaceUri,
        workspaceFolders: [{ uri: workspaceUri, name: path.basename(workspace) }],
        // Fase 20 Tarea 3: capabilities MINIMAS -- solo lo que hace falta
        // para recibir publishDiagnostics. Nada de completion/hover/etc,
        // decision explicita de esta fase (alcance: diagnosticos, no un
        // LSP client completo).
        //
        // Soporte YAML/ESLint/Bash (docs/_arch/verify_lsp_pull_config_implementation_design.md,
        // Pieza 2): ampliado con `workspace.configuration` (permite que el
        // servidor pida workspace/configuration -- confirmado real hoy que
        // YAML/ESLint lo piden apenas ven esta capability) y
        // `textDocument.diagnostic` (pull-diagnostics LSP 3.17, confirmado
        // real que ESLint lo anuncia en su respuesta y lo usa en vez de
        // publishDiagnostics). Los 6 servidores existentes (TypeScript/
        // Python/Rust/Go/clangd/jdtls) nunca piden ninguna de las 2 cosas
        // hoy -- anunciar que las soportamos no les cambia nada.
        capabilities: {
          textDocument: {
            publishDiagnostics: { relatedInformation: true },
            diagnostic: { dynamicRegistration: false, relatedInformation: true }
          },
          workspace: {
            configuration: true
          }
        }
      }) as { capabilities?: Record<string, unknown> } | undefined
      // Indexacion por simbolos: se guarda el `capabilities` REAL de la
      // respuesta -- antes se descartaba (solo importaba que initialize
      // respondiera). supportsCapability() lo consulta antes de mandar
      // definition/references/documentSymbol/workspaceSymbol.
      this.serverCapabilities = initResult?.capabilities
      this.notify('initialized', {})
    })()

    return this.starting.finally(() => {
      this.starting = null
    })
  }

  private handleChunk(chunk: Buffer): void {
    const messages = this.framer.feed(chunk)
    for (const raw of messages) {
      const msg = raw as { id?: number; method?: string; params?: unknown; result?: unknown; error?: unknown }
      // Fix real de bug de enrutamiento (docs/_arch/verify_lsp_10_remaining.md,
      // caso Clojure -- reproducido real con clojure-lsp sin `clojure` CLI en
      // PATH): un mensaje con `method` Y `id` A LA VEZ es SIEMPRE un REQUEST
      // del SERVIDOR hacia este cliente (ej. workspace/configuration,
      // window/showMessageRequest) -- JAMAS una respuesta a un request
      // nuestro, porque una respuesta JSON-RPC real nunca trae `method`. Este
      // chequeo tiene que ir ANTES que `pending.has(msg.id)` de mas abajo, no
      // despues: el orden viejo (pending.has() primero) le pegaba a esta
      // rama cada vez que el `id` NUMERICO de un request entrante del
      // servidor colisionaba por casualidad con el `id` de un request
      // nuestro TODAVIA pendiente (tipico: `window/showMessageRequest id=1`
      // del servidor llegando mientras nuestro propio `initialize` id=1
      // seguia sin respuesta) -- se lo tomaba como si fuera la respuesta
      // real de `initialize`, resolviendola con basura, y el servidor
      // quedaba esperando para siempre una respuesta a su request que
      // nunca le llegaba: handshake colgado en silencio. Reordenado: el
      // chequeo por `method` gana siempre, sin importar si el `id` coincide
      // con algo pendiente nuestro.
      if (msg.method !== undefined && msg.id !== undefined) {
        if (msg.method === 'workspace/configuration') {
          this.respond(msg.id, this.buildConfigurationResponse(msg.params))
        } else {
          this.respond(msg.id, null)
        }
        continue
      }
      if (msg.id !== undefined && this.pending.has(msg.id)) {
        const { resolve, reject, method, sentAt } = this.pending.get(msg.id)!
        this.pending.delete(msg.id)
        // Demo grabada (docs/_arch/verify_lsp_demo_scope.md, Tarea 1-2):
        // lado RECIBIDO de la misma traza -- latencyMs es la medicion REAL
        // de ida y vuelta (Date.now() - sentAt), no una aproximacion. Mismo
        // gate AMATISTA_DEBUG_TOOLS que el lado enviado en request().
        if (process.env.AMATISTA_DEBUG_TOOLS === '1') {
          const latencyMs = Date.now() - sentAt
          const payload = msg.error ? { error: msg.error } : { result: msg.result }
          console.log(`[lsp:recv] id=${msg.id} method=${method} latencyMs=${latencyMs} payload=${JSON.stringify(payload).slice(0, 500)}`)
        }
        // Hallazgo real encontrado durante la demo grabada (docs/_arch/verify_lsp_demo_scope.md):
        // msg.error es el objeto crudo del protocolo JSON-RPC (`{code,
        // message, data}`), NUNCA una instancia real de Error -- reject(msg.error)
        // tal cual hacia que el catch generico de ToolRegistry.execute()
        // (`error instanceof Error ? error.message : String(error)`) cayera
        // al `String(error)`, produciendo el literal "[object Object]" en
        // vez del mensaje real. Confirmado real contra rust-analyzer
        // indexando un crate nuevo (responde un error de protocolo real
        // mientras carga, antes de poder resolver definition/references).
        // Ya afectaba initialize/shutdown desde Fase 20, pero nunca se vio
        // porque esos 2 casi nunca reciben un error de protocolo real en la
        // practica -- definition/references lo hacen con mas frecuencia
        // (servidor todavia cargando el proyecto).
        if (msg.error) {
          const errObj = msg.error as { message?: string; code?: number } | undefined
          const message = typeof errObj?.message === 'string' ? errObj.message : JSON.stringify(msg.error)
          reject(new Error(message))
        } else {
          resolve(msg.result)
        }
        continue
      }
      if (msg.method === 'textDocument/publishDiagnostics') {
        this.onPublishDiagnostics(msg.params)
      }
      // Soporte Go (verify_go_lsp.md, Tarea 1): window/showMessage tipo
      // Error (1) es la UNICA senal real de "arranque perfecto pero no
      // puede analizar nada" -- confirmado real contra gopls sin `go` en
      // el PATH del proceso hijo. window/logMessage y showMessage de otra
      // severidad se siguen ignorando a proposito, igual que antes.
      if (msg.method === 'window/showMessage') {
        const params = msg.params as { type?: number; message?: string } | undefined
        if (params?.type === 1 && typeof params.message === 'string') {
          this.lastErrorMessage = params.message
        }
      }
    }
  }

  private onPublishDiagnostics(params: unknown): void {
    const record = (typeof params === 'object' && params !== null ? params : {}) as { uri?: string; diagnostics?: unknown[] }
    if (typeof record.uri !== 'string') return
    const key = uriToPathKey(record.uri)
    if (!key) return

    const list = Array.isArray(record.diagnostics) ? record.diagnostics : []

    // Soporte Go -- hallazgo real durante la propia verificacion: limpiar
    // lastErrorMessage con CUALQUIER publishDiagnostics es incorrecto.
    // gopls, con `go` no resoluble, publica un diagnostico REAL (source:
    // "go list", "No active builds contain ... consider opening a new
    // workspace folder") que es SINTOMA del mismo problema que ya informo
    // por window/showMessage, no una recuperacion -- limpiarlo aca hacia
    // que get_diagnostics mostrara ese warning generico en vez del motivo
    // real ("go" no resoluble). Solo se limpia si el lote de diagnosticos
    // NO contiene ese sintoma -- cualquier otro publishDiagnostics real
    // (source:"compiler" o el que sea) SI confirma que el servidor logro
    // analizar de verdad. TypeScript/Python/Rust nunca producen
    // source:"go list" -- sin cambio de comportamiento para esos 3.
    const isPackageLoadSymptom = list.some(item => (item as { source?: string })?.source === 'go list')
    if (!isPackageLoadSymptom) {
      this.lastErrorMessage = undefined
    }

    // Soporte pull-diagnostics: parseo compartido con pullDiagnostics(),
    // ver parseDiagnosticItems() -- mismo resultado exacto que antes, solo
    // extraido para no duplicar la conversion.
    this.diagnostics.set(key, { diagnostics: parseDiagnosticItems(list), updatedAt: Date.now() })
  }

  /**
   * Demo grabada (docs/_arch/verify_lsp_demo_scope.md, Tarea 1): trazabilidad
   * JSON-RPC gateada por AMATISTA_DEBUG_TOOLS -- mismo patron exacto ya
   * usado en tool-registry.ts/api-agent-runtime.ts (`process.env.AMATISTA_DEBUG_TOOLS === '1'`),
   * NUNCA activo por defecto, cero cambio de comportamiento para el resto
   * de la app. Lado ENVIADO: log de `method`/`id`/`params` con `sentAt`
   * real (Date.now(), el mismo valor que se guarda en `pending` para medir
   * latencia real al resolverse en handleChunk()).
   */
  private request(method: string, params: unknown, timeoutMs = 20000): Promise<unknown> {
    const child = this.child
    if (!child?.stdin) return Promise.reject(new Error('Language server no esta corriendo.'))
    const id = this.nextId++
    const sentAt = Date.now()
    if (process.env.AMATISTA_DEBUG_TOOLS === '1') {
      console.log(`[lsp:send] id=${id} method=${method} sentAt=${sentAt} params=${JSON.stringify(params).slice(0, 500)}`)
    }
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method, sentAt })
      child.stdin!.write(encodeLspMessage({ jsonrpc: '2.0', id, method, params }))
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id)
          reject(new Error(`Timeout esperando respuesta de ${method}.`))
        }
      }, timeoutMs)
    })
  }

  private notify(method: string, params: unknown): void {
    this.child?.stdin?.write(encodeLspMessage({ jsonrpc: '2.0', method, params }))
  }

  /** Soporte YAML/ESLint/Bash: primitivo nuevo, distinto de `request()`
   *  (arma requests PROPIOS, con `id` de NUESTRA secuencia) y de `notify()`
   *  (nunca lleva `id`) -- este responde a un request que el SERVIDOR nos
   *  mando, ecoando SU `id` tal cual, mismo framing (`encodeLspMessage()`)
   *  ya existente. */
  private respond(id: number, result: unknown): void {
    this.child?.stdin?.write(encodeLspMessage({ jsonrpc: '2.0', id, result }))
  }

  /**
   * Soporte YAML/ESLint/Bash (docs/_arch/verify_lsp_pull_config_implementation_design.md,
   * Tarea 2/4): `ConfigurationParams` real trae `items: [{section, scopeUri?}]`
   * -- confirmado real HOY con 2 servidores distintos que `items` puede
   * traer de 1 a N elementos en una sola request (YAML pidio 5 secciones
   * globales de una), y que la respuesta debe ser un array de la MISMA
   * longitud, correspondido POSICIONALMENTE (`result[i]` responde a
   * `items[i]`) -- nunca un objeto suelto. `scopeUri` se ignora a
   * proposito en esta primera version (confirmado real que ni YAML ni
   * ESLint necesitaron una respuesta distinta por documento hoy) -- misma
   * respuesta estatica de `config.configResponses` sin importar que
   * archivo la pida.
   */
  private buildConfigurationResponse(params: unknown): unknown[] {
    const items = (params as { items?: Array<{ section?: string }> } | undefined)?.items
    if (!Array.isArray(items)) return []
    return items.map(item => {
      const section = typeof item?.section === 'string' ? item.section : ''
      return this.config?.configResponses?.[section] ?? null
    })
  }

  /**
   * Notifica al language server que un archivo tiene contenido nuevo --
   * didOpen la primera vez que se toca en la sesion, didChange despues
   * (version incremental). Asume que start() ya se llamo antes (lo
   * garantiza LspManager). `reason` (fix de aislamiento, ver editedPaths
   * arriba) distingue POR QUE se abre: `'edit'` (default, notifyFileWritten()
   * -- write_file/apply_patch, cero cambio para ese call site existente) vs
   * `'navigate'` (ensureOpen() -- find_definition/find_references/
   * list_symbols). Una edicion real NUNCA se degrada: si el archivo YA
   * estaba en editedPaths, una apertura `'navigate'` posterior no lo saca
   * de ahi -- por eso `'navigate'` no hace nada especial, simplemente NO
   * agrega a editedPaths (el default `'edit'` es el unico que agrega).
   */
  notifyFileChanged(absolutePath: string, content: string, reason: 'edit' | 'navigate' = 'edit'): void {
    const key = normalizePathKey(absolutePath)
    const uri = pathToFileURL(absolutePath).href
    this.lastEditAt.set(key, Date.now())
    if (reason === 'edit') {
      this.editedPaths.add(key)
    }

    const existingVersion = this.openVersions.get(key)
    if (existingVersion === undefined) {
      this.openVersions.set(key, 1)
      this.notify('textDocument/didOpen', {
        textDocument: { uri, languageId: languageIdFor(absolutePath), version: 1, text: content }
      })
    } else {
      const version = existingVersion + 1
      this.openVersions.set(key, version)
      this.notify('textDocument/didChange', {
        textDocument: { uri, version },
        contentChanges: [{ text: content }]
      })
    }
  }

  /** true si ya se le mando al menos un didOpen a este archivo en esta
   *  sesion -- usado por get_diagnostics para saber si tiene sentido
   *  esperar un diagnostico nuevo (un archivo nunca tocado no va a
   *  producir ninguno). */
  isTracked(absolutePath: string): boolean {
    return this.openVersions.has(normalizePathKey(absolutePath))
  }

  trackedPaths(): string[] {
    return [...this.openVersions.keys()]
  }

  /** Subconjunto de trackedPaths() -- SOLO los editados de verdad (ver
   *  editedPaths arriba). get_diagnostics() SIN path (LspManager) usa ESTO
   *  en vez de trackedPaths(), para no contaminarse con archivos abiertos
   *  solo para navegar. get_diagnostics() CON path sigue usando isTracked()/
   *  el path puntual tal cual, sin cambios -- ahi no hay contaminacion
   *  posible, el modelo pidio ESE archivo a proposito. */
  editedTrackedPaths(): string[] {
    return [...this.editedPaths]
  }

  getCachedDiagnostics(absolutePath: string): FileDiagnosticsEntry | undefined {
    return this.diagnostics.get(normalizePathKey(absolutePath))
  }

  getLastEditAt(absolutePath: string): number | undefined {
    return this.lastEditAt.get(normalizePathKey(absolutePath))
  }

  /**
   * Indexacion por simbolos (docs/_arch/verify_lsp_symbols.md): los 4
   * wrappers publicos nuevos, todos sobre el `request()`/`pending` YA
   * genericos (Tarea 1 -- no hizo falta tocar el framer ni el mecanismo de
   * correlacion). `absolutePath`/`line`/`column` siempre 1-indexados de
   * cara al llamador (LspManager/tool-registry.ts) -- la conversion a
   * 0-indexado (`toLspPosition()`) vive SOLO aca, nunca a mano en otro
   * lado. El llamador es responsable de haber abierto el archivo antes
   * (`LspManager.ensureOpen()`) -- esta clase no lo hace por si sola, mismo
   * criterio que ya aplican notifyFileChanged()/isTracked() (LspClient no
   * decide POR QUE se abre un archivo, solo habla el protocolo).
   */
  async definition(absolutePath: string, line: number, column: number): Promise<LspLocation[]> {
    const uri = pathToFileURL(absolutePath).href
    const result = await this.request('textDocument/definition', {
      textDocument: { uri },
      position: toLspPosition(line, column)
    })
    return toLspLocations(result)
  }

  async references(absolutePath: string, line: number, column: number, includeDeclaration: boolean): Promise<LspLocation[]> {
    const uri = pathToFileURL(absolutePath).href
    const result = await this.request('textDocument/references', {
      textDocument: { uri },
      position: toLspPosition(line, column),
      context: { includeDeclaration }
    })
    return toLspLocations(result)
  }

  /** Simbolos de UN archivo puntual -- no necesita posicion, a diferencia
   *  de definition()/references() (ver diseño, docs/_arch/verify_lsp_symbols.md
   *  Tarea 4). */
  async documentSymbol(absolutePath: string): Promise<LspSymbol[]> {
    const uri = pathToFileURL(absolutePath).href
    const result = await this.request('textDocument/documentSymbol', { textDocument: { uri } })
    return flattenDocumentSymbols(result)
  }

  /** Busqueda por NOMBRE en todo el workspace que este cliente indexa --
   *  tampoco necesita posicion NI archivo puntual, el caso mas simple de
   *  los 4. LspManager.searchSymbols() la llama sobre TODOS los clientes ya
   *  corriendo, no solo este. */
  async workspaceSymbol(query: string): Promise<LspSymbol[]> {
    const result = await this.request('workspace/symbol', { query })
    return flattenDocumentSymbols(result)
  }

  /** Espera (poll corto) a que llegue una notificacion de diagnosticos MAS
   *  RECIENTE que `sinceMs` para este archivo, hasta `timeoutMs`. Nunca
   *  cuelga indefinido -- al timeout, el llamador decide que hacer con lo
   *  que haya en cache (get_diagnostics lo marca "stale"). */
  /**
   * Soporte pull-diagnostics (docs/_arch/verify_lsp_pull_config_implementation_design.md,
   * Tarea 3-4): `textDocument/diagnostic` real (LSP 3.17) -- SOLO tiene
   * sentido llamarlo si el servidor anuncio `capabilities.diagnosticProvider`
   * (confirmado real hoy: ESLint lo anuncia, YAML/TypeScript/Python/Rust/Go/
   * clangd/jdtls no -- el llamador, LspManager.diagnosticsFromClient(),
   * decide con supportsCapability('diagnosticProvider') antes de llamar
   * esto). Escribe en el MISMO `this.diagnostics` cache, con el MISMO
   * shape (`parseDiagnosticItems()`, compartido con onPublishDiagnostics())
   * que ya usa el camino push -- get_diagnostics()/LspManager no necesitan
   * saber si el dato vino de un push pasivo o de un pull activo. Devuelve
   * `false` solo si la request en si fallo (timeout/error de protocolo) --
   * eso es lo que el llamador usa para decidir `stale`, nunca la nocion de
   * "todavia no llego el push" que si aplica al camino pasivo.
   */
  async pullDiagnostics(absolutePath: string): Promise<boolean> {
    const uri = pathToFileURL(absolutePath).href
    try {
      const result = await this.request('textDocument/diagnostic', { textDocument: { uri } }) as { items?: unknown[] } | undefined
      const list = Array.isArray(result?.items) ? result.items : []
      this.diagnostics.set(normalizePathKey(absolutePath), { diagnostics: parseDiagnosticItems(list), updatedAt: Date.now() })
      return true
    } catch {
      return false
    }
  }

  async waitForFreshDiagnostics(absolutePath: string, sinceMs: number, timeoutMs: number): Promise<boolean> {
    const key = normalizePathKey(absolutePath)
    const start = Date.now()
    for (;;) {
      const entry = this.diagnostics.get(key)
      if (entry && entry.updatedAt >= sinceMs) return true
      if (Date.now() - start >= timeoutMs) return false
      await new Promise(resolve => setTimeout(resolve, 100))
    }
  }

  /** Cierre limpio real del protocolo LSP: shutdown (request) + exit
   *  (notification) -- confirmado en vivo (Fase 20 Tarea 4) que el
   *  proceso termina solo con exit code 0, sin necesitar kill(). Con
   *  timeout corto de respaldo: si el servidor no responde/no sale a
   *  tiempo, se mata igual -- nunca deja un proceso zombie colgado de
   *  disconnectAgent(). */
  async shutdown(): Promise<void> {
    const child = this.child
    if (!child) return
    try {
      await this.request('shutdown', null, 3000)
      this.notify('exit', null)
      await new Promise<void>(resolve => {
        const timer = setTimeout(() => resolve(), 3000)
        child.once('exit', () => {
          clearTimeout(timer)
          resolve()
        })
      })
    } catch {
      // El request de shutdown pudo fallar/timeoutear -- se cae al kill
      // de respaldo de abajo en vez de propagar el error.
    } finally {
      if (this.child === child) {
        try { child.kill() } catch { /* ya pudo haber terminado solo */ }
        this.child = null
      }
    }
  }
}
