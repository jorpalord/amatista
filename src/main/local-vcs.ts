// VCS local oculto (Fase 8): git como motor interno, invisible para el
// usuario. Repo privado por workspace en D:\AMATISTA\data\vcs\<id>\.git —
// NUNCA dentro de la carpeta real del proyecto, completamente ajeno a un
// git real que el proyecto ya tenga (git_status/git_diff en tool-registry.ts
// siguen apuntando al repo real, sin ningun cambio ni cruce con este).
//
// Modelo: el repo oculto espeja, bajo su propia raiz, solo las rutas
// relativas de los archivos que Amatista efectivamente edito — no todo el
// proyecto. Cada write_file/apply_patch/revert_file exitoso es un commit
// nuevo de ESE archivo puntual; nunca se borra ni reescribe historia
// (revert_file agrega un commit con el contenido restaurado, no un
// `git reset`).
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'
import { getAppDataSubdir } from './app-paths'

const execFileAsync = promisify(execFile)

// Separador que casi con certeza no aparece en un mensaje de commit de una
// sola palabra (nombre de tool) — usado para parsear `git log` sin
// ambiguedad si el mensaje alguna vez tuviera un caracter "raro".
const FIELD_SEP = '\x1f'

export interface FileHistoryEntry {
  /** SHA completo del commit — lo que revert_file espera como `ref`. */
  ref: string
  /** Fecha ISO del commit (autor). */
  date: string
  /** Mensaje de commit = nombre de la tool que genero esa version
   *  ('original' | 'write_file' | 'apply_patch' | 'revert_file'). */
  tool: string
}

export interface SnapshotResult {
  ok: boolean
  error?: string
}

/**
 * Deriva un directorio estable y sin colisiones para el repo oculto de un
 * workspace, a partir de su ruta absoluta — hash (para unicidad) + el
 * nombre de carpeta del workspace (solo para que sea reconocible a simple
 * vista en D:\AMATISTA\data\vcs\, no forma parte de la identidad real).
 */
function workspaceId(workspace: string): string {
  const hash = createHash('sha256').update(workspace).digest('hex').slice(0, 16)
  const base = path.basename(workspace).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 40) || 'workspace'
  return `${base}-${hash}`
}

function vcsRepoDir(workspace: string): string {
  // getAppDataSubdir ya crea el directorio (mkdir -p) si no existe.
  return getAppDataSubdir('vcs', workspaceId(workspace))
}

/** \\ -> / para pathspecs de git — Windows acepta ambos en el filesystem
 *  pero `git log -- <path>` matchea de forma mas predecible con "/". */
function toGitPath(relPath: string): string {
  return relPath.split(path.sep).join('/').split('\\').join('/')
}

/**
 * Analoga a resolveWithinWorkspace (tool-registry.ts), pero para el repo
 * oculto — NO alcanza con que tool-registry.ts ya haya validado `relPath`
 * contra el workspace REAL antes de llamar aca. Esa validacion garantiza
 * que el neto de `relPath` se queda dentro del workspace real, pero
 * `repoDir` es una raiz DISTINTA y con frecuencia mucho menos profunda
 * (`D:\AMATISTA\data\vcs\<id>`) — los mismos ".." que un workspace
 * profundo absorbe sin salirse pueden escapar de un repoDir mas
 * superficial. `path.join`/`path.resolve` normalizan ".." sin frenar el
 * resultado por si solos; hay que chequear el path final explicitamente,
 * mismo patron exacto que ya usa resolveWithinWorkspace.
 *
 * Es la UNICA funcion de este modulo que construye una ruta de filesystem
 * real a partir de `relPath` (snapshotFile, via `target`). readFileVersion
 * no la necesita: pasa `relPath` como pathspec de texto a `git show
 * <ref>:<path>`, resuelto contra el arbol de objetos del commit, no contra
 * el filesystem — un ".." ahi no tiene forma de escapar del repo (git no
 * hace traversal de filesystem para esa sintaxis, en el peor caso
 * simplemente no encuentra nada en el arbol).
 */
function resolveWithinRepo(repoDir: string, gitRelPath: string): string {
  const resolved = path.resolve(repoDir, gitRelPath)
  const repoDirWithSep = repoDir.endsWith(path.sep) ? repoDir : repoDir + path.sep
  if (resolved !== repoDir && !resolved.startsWith(repoDirWithSep)) {
    throw new Error(`Ruta fuera del repo oculto: ${gitRelPath}`)
  }
  return resolved
}

// Fix real de contencion (docs/_arch/verify_toctou_parallel_fix_design.md,
// Tarea 3/Pieza 2): 2 paneles reales escribiendo archivos DISTINTOS del
// MISMO workspace comparten este MISMO repo oculto (por-workspace, no
// por-archivo) -- confirmado real que sus comandos git concurrentes
// colisionan de verdad (`index.lock`/`cannot lock ref HEAD`, 10/20
// snapshots fallados medidos). Un lock por-ARCHIVO (el mecanismo de
// staleness de tool-registry.ts) NO resuelve esto -- son archivos
// distintos, locks distintos, pero el MISMO `.git`. Cola de ejecucion
// por repoDir (cwd): toda OPERACION git logica contra un repo dado corre
// en el orden en que se pidio, nunca 2 a la vez -- sin distinguir que
// subcomando es (mas simple y mas seguro que intentar razonar cuales de
// init/config/log/show/add/commit son "seguros" de correr concurrentes
// entre si). Deliberadamente DISTINTO del lock por-archivo de
// tool-registry.ts (proposito distinto: serializar acceso al binario git,
// no bloquear escrituras de contenido -- ver el doc de arriba).
//
// Hallazgo 4 de la 4ta revision externa (docs/_arch/
// verify_git_atomic_operation_design.md): la granularidad de "una entrada
// de cola = una operacion logica completa" (no una llamada individual a
// runGit()) es real desde este fix -- ver runInRepoQueue() mas abajo.
const repoQueues = new Map<string, Promise<unknown>>()

// Timeout real (docs/_arch/verify_guard_design.md, mismo criterio que
// MCP/read_document de guard/): execFileAsync('git', ...) no tenia NINGUN
// timeout -- un git realmente colgado (filesystem de red, antivirus de
// Windows escaneando el .git, un handle no liberado) colgaria la cola de
// arriba para SIEMPRE, y con ella cualquier panel que escriba a ese
// mismo repo. 15s es generoso frente a lo medido real (~360-770ms por
// operacion tipica) pero acota el peor caso -- nunca "para siempre".
const GIT_TIMEOUT_MS = 15_000

/**
 * Hallazgo 4 de la 4ta revision externa (docs/_arch/
 * verify_git_atomic_operation_design.md), confirmado real con git real (10
 * escrituras concurrentes reales colapsaron en 1 solo commit real, mal
 * atribuido): antes, runGit() encolaba CADA llamada individual -- el `add`
 * y el `commit` de UNA operacion de commitPath() eran 2 entradas
 * INDEPENDIENTES en la cola, asi que el `add` de otro llamador concurrente
 * podia intercalarse real entre medio (mismo `await` que cede el event
 * loop mientras el subproceso real de `add` corre). Este primitivo nuevo
 * mueve la sincronizacion a nivel de OPERACION LOGICA COMPLETA -- el
 * llamador decide el alcance real de la atomicidad (una sola llamada a
 * runGit(), o una secuencia de varias, ej. add+commit) pasando la funcion
 * entera como `task`. Mismo mecanismo de encadenamiento de promesas que ya
 * existia (mismo Map, mismo `.catch(() => undefined)` para que un rechazo
 * de OTRO llamador no tumbe la cola para los que siguen) -- solo cambia
 * QUIEN decide donde empieza y termina cada unidad indivisible.
 */
async function runInRepoQueue<T>(cwd: string, task: () => Promise<T>): Promise<T> {
  const previous = repoQueues.get(cwd) ?? Promise.resolve()
  const run = previous.catch(() => undefined).then(task)
  repoQueues.set(cwd, run.catch(() => undefined))
  return run
}

// Primitivo de ejecucion PURO -- ya NO toca repoQueues (ver
// runInRepoQueue() arriba, el unico punto real de sincronizacion ahora).
// Cada llamador real decide, via runInRepoQueue(), si esta llamada es su
// propia unidad de cola o parte de una secuencia mas larga.
async function runGit(cwd: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync('git', args, { cwd, windowsHide: true, timeout: GIT_TIMEOUT_MS })
}

/**
 * git init (si hace falta) + identidad local del repo oculto — NUNCA
 * depende de la config global de git del usuario (podria no existir en una
 * maquina limpia, o el usuario podria no tener git configurado en absoluto
 * mas alla del binario). Idempotente: seguro de llamar en cada operacion.
 */
async function ensureVcsRepo(workspace: string): Promise<string> {
  const repoDir = vcsRepoDir(workspace)
  await runInRepoQueue(repoDir, async () => {
    if (!existsSync(path.join(repoDir, '.git'))) {
      await runGit(repoDir, ['init'])
    }
    await runGit(repoDir, ['config', 'user.email', 'amatista@local'])
    await runGit(repoDir, ['config', 'user.name', 'AMATISTA'])
  })
  return repoDir
}

async function listHistoryInRepo(repoDir: string, gitRelPath: string): Promise<FileHistoryEntry[]> {
  try {
    const { stdout } = await runInRepoQueue(repoDir, () => runGit(repoDir, [
      'log', '--follow', `--format=%H${FIELD_SEP}%aI${FIELD_SEP}%s`, '--', gitRelPath
    ]))
    return stdout
      .split('\n')
      .filter(line => line.trim())
      .map(line => {
        const [ref, date, tool] = line.split(FIELD_SEP)
        return { ref, date, tool }
      })
  } catch {
    // Repo recien creado sin commits todavia, o el path nunca se toco —
    // no es un error, es "sin historial".
    return []
  }
}

// Hallazgo 4 (4ta revision externa): add+commit envueltos ENTEROS en
// runInRepoQueue() -- una sola unidad indivisible en la cola por-repo. Sin
// esto, el `add` de otro llamador concurrente podia intercalarse real
// entre el `add` y el `commit` de ESTA operacion (el `await` de la linea
// de abajo cede el event loop mientras el subproceso real corre) -- el
// primer `commit` real terminaba incorporando el `add` ajeno tambien
// (el index de git es global al repo, no por-llamada), y el commit del
// otro llamador caia en "nothing to commit" (silencioso, atrapado mas
// abajo), perdiendo su propia entrada de historial real.
async function commitPath(repoDir: string, gitRelPath: string, message: string): Promise<void> {
  await runInRepoQueue(repoDir, async () => {
    await runGit(repoDir, ['add', '--', gitRelPath])
    try {
      await runGit(repoDir, ['commit', '-m', message])
    } catch (error) {
      const record = error as { stdout?: string; stderr?: string }
      const text = `${record.stdout ?? ''}${record.stderr ?? ''}`
      // Contenido identico al ultimo commit (ej. write_file reescribiendo lo
      // mismo que ya habia) — no es un fallo, no hay version nueva que crear.
      if (/nothing to commit|nada que confirmar|working tree clean/i.test(text)) return
      throw error
    }
  })
}

/**
 * Fix real de staleness bajo concurrencia (docs/_arch/verify_toctou_parallel_fix_design.md,
 * Opcion A2): ANTES esta pieza y `commitVersion()` de abajo eran una sola
 * funcion (`snapshotFile()`) que commiteaba el 'original' Y `newContent`
 * juntos, ANTES de la escritura real -- eso dejaba una ventana real (el
 * `await` de esta funcion cede el event loop, subprocesos git reales) entre
 * el re-chequeo de staleness de tool-registry.ts y el `writeFileSync`, dentro
 * de la cual 2 paneles podian pisarse en silencio (confirmado real, 25/25
 * clobbers). Separada en 2 funciones para que el llamador pueda intercalar
 * un re-chequeo SINCRONICO entre medio: esta pieza SOLO archiva lo que
 * REALMENTE esta en disco ahora (nunca el resultado de una escritura que
 * todavia no paso), `commitVersion()` corre DESPUES del `writeFileSync` real.
 *
 * Caso especial (primer toque de un archivo YA EXISTENTE, `existingContent
 * !== null`, sin historial previo en el repo oculto): commitea el contenido
 * ORIGINAL (mensaje "original"), asi la version pre-IA nunca se pierde. Un
 * archivo nuevo (`existingContent === null`) o uno que ya tiene historial no
 * hace nada aca -- no-op barato (1 `git log` de por medio).
 *
 * Nunca lanza — devuelve {ok:false, error} en cualquier fallo (git no
 * instalado, permisos, etc.), el llamador sigue con la escritura real igual
 * (el versionado es una red de seguridad adicional, no un requisito) y avisa
 * en el output de la tool.
 */
export async function snapshotOriginalIfNeeded(params: {
  workspace: string
  relPath: string
  existingContent: string | null
}): Promise<SnapshotResult> {
  try {
    const repoDir = await ensureVcsRepo(params.workspace)
    const gitRelPath = toGitPath(params.relPath)
    // Lanza si el neto de gitRelPath escapa de repoDir — atrapado por el
    // catch de aca abajo, nunca sale de esta funcion como excepcion.
    const target = resolveWithinRepo(repoDir, gitRelPath)
    mkdirSync(path.dirname(target), { recursive: true })

    const history = await listHistoryInRepo(repoDir, gitRelPath)
    if (history.length === 0 && params.existingContent !== null) {
      writeFileSync(target, params.existingContent, 'utf8')
      await commitPath(repoDir, gitRelPath, 'original')
    }

    return { ok: true }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    console.error(`[local-vcs] snapshot (original) fallo para "${params.relPath}":`, detail)
    return { ok: false, error: detail }
  }
}

/**
 * Fix real de staleness bajo concurrencia (Opcion A2, ver el comentario
 * completo de `snapshotOriginalIfNeeded()` arriba): commitea `newContent`
 * como version nueva -- SIEMPRE llamada DESPUES del `writeFileSync` real del
 * llamador (tool-registry.ts), nunca antes. A diferencia de la funcion vieja
 * `snapshotFile()`, esto significa que si el re-chequeo de staleness
 * rechaza la escritura, esta funcion JAMAS se llega a invocar -- cero
 * commits huerfanos en el VCS oculto de una escritura que nunca ocurrio en
 * disco (confirmado real: 12/12 commits huerfanos con el orden viejo,
 * 0/12 con este).
 *
 * Nunca lanza — mismo criterio de {ok:false, error} que el resto de este
 * modulo.
 */
export async function commitVersion(params: {
  workspace: string
  relPath: string
  newContent: string
  tool: string
}): Promise<SnapshotResult> {
  try {
    const repoDir = await ensureVcsRepo(params.workspace)
    const gitRelPath = toGitPath(params.relPath)
    const target = resolveWithinRepo(repoDir, gitRelPath)
    mkdirSync(path.dirname(target), { recursive: true })

    writeFileSync(target, params.newContent, 'utf8')
    await commitPath(repoDir, gitRelPath, params.tool)

    return { ok: true }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    console.error(`[local-vcs] snapshot (version) fallo para "${params.relPath}":`, detail)
    return { ok: false, error: detail }
  }
}

/** Historial de versiones guardadas de un archivo, mas reciente primero.
 *  [] si nunca se edito via write_file/apply_patch/revert_file (o si el
 *  repo oculto fallo al leer — no distingue los dos casos, ambos son
 *  "no hay nada que mostrar" desde la perspectiva del llamador). */
export async function listFileHistory(workspace: string, relPath: string): Promise<FileHistoryEntry[]> {
  try {
    const repoDir = await ensureVcsRepo(workspace)
    return await listHistoryInRepo(repoDir, toGitPath(relPath))
  } catch (error) {
    console.error(`[local-vcs] listFileHistory fallo para "${relPath}":`, error)
    return []
  }
}

// Los refs que importan a este modulo SIEMPRE salen de listFileHistory
// (SHA completo de 40 hex) — un `ref` con esta forma no puede interpretarse
// como una flag de git (`--algo`) al pasarlo a `git show <ref>:<path>`.
const VALID_REF = /^[0-9a-fA-F]{7,40}$/

/**
 * Contenido de un archivo en una version especifica del repo oculto — NO
 * escribe nada, el llamador (tool-registry.ts, caso revert_file) decide si
 * escribe el resultado despues de la aprobacion del usuario, mismo flujo
 * que write_file/apply_patch. null si el ref no es valido o no existe.
 */
export async function readFileVersion(workspace: string, relPath: string, ref: string): Promise<string | null> {
  if (!VALID_REF.test(ref)) return null
  try {
    const repoDir = await ensureVcsRepo(workspace)
    const gitRelPath = toGitPath(relPath)
    const { stdout } = await runInRepoQueue(repoDir, () => runGit(repoDir, ['show', `${ref}:${gitRelPath}`]))
    return stdout
  } catch {
    return null
  }
}
