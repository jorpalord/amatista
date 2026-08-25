import { exec } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { EXPLORE_TOOL_NAMES, runExploreLoop } from './explore-tool'
import { listFileHistory, readFileVersion, snapshotFile } from './local-vcs'
import type { ModelProfile, ProviderProfile, SandboxMode } from '../shared/types'

export interface ToolDefinition {
  name: string
  description: string
  parameters: {
    type: 'object'
    properties: Record<string, { type: string; description?: string }>
    required: string[]
  }
}

export interface ToolExecutionResult {
  ok: boolean
  output: string
}

export type ConfirmFn = (title: string, detail: string) => Promise<boolean>

interface ExecuteContext {
  workspace: string
  confirm: ConfirmFn
  /**
   * Fase 12: modo activo de la conexion (agent:connect → payload.sandbox),
   * antes SOLO se conectaba hasta cli-agent-runtime.ts — read_file/list_dir/
   * git_status/git_diff/list_file_history nunca lo consultan (siempre
   * permitidas, en cualquier modo); las 4 acciones sensibles de este
   * archivo (write_file/apply_patch/run_command/revert_file) y el dispatch
   * de tools MCP en api-agent-runtime.ts SI lo consultan, via
   * resolveApproval() mas abajo. Ver docs/_arch/CONTRACT.md → "Sandbox
   * mode no aplicado en runtimes API (Fase 12)".
   */
  sandbox: SandboxMode
  /**
   * Resuelve el modelo barato configurado (Fase 3: compactionProviderId/
   * compactionModelId) FRESCO en cada llamada — null si no hay uno elegido
   * o el elegido ya no es valido. Lo provee ipc-agent.ts al armar el
   * toolExecutor de la conexion (unico lugar con acceso a `settings`);
   * opcional para no romper otros llamadores hipoteticos de execute() —
   * sin este campo, la tool "explore" devuelve un error claro en vez de
   * fallar (Tarea 3 de Fase 4).
   */
  resolveExploreModel?: () => { provider: ProviderProfile; model: ModelProfile } | null
}

/**
 * Fase 12: unico punto que resuelve si una accion sensible se ejecuta,
 * segun el sandbox mode activo — reusado por las 4 acciones de este
 * archivo (write_file/apply_patch/run_command/revert_file) y por el
 * dispatch de tools MCP en api-agent-runtime.ts, en vez de repetir este
 * if/else de 3 ramas en cada uno. Mismo criterio que cli-agent-runtime.ts
 * ya aplica para runtimes CLI (--permission-mode/--approval-mode):
 *  - 'read-only': bloquea de raiz, SIN llamar a `confirm` — no hay nada
 *    que aprobar si la accion esta prohibida por el modo activo.
 *  - 'workspace-write': comportamiento de siempre, pide `confirm`.
 *  - 'danger-full-access': saltea `confirm` y aprueba directo, igual que
 *    --dangerously-skip-permissions/yolo ya hacen en runtimes CLI.
 */
export async function resolveApproval(
  sandbox: SandboxMode,
  confirm: ConfirmFn,
  title: string,
  detail: string
): Promise<boolean> {
  if (sandbox === 'read-only') return false
  if (sandbox === 'danger-full-access') return true
  return confirm(title, detail)
}

/** Mensaje de rechazo cuando resolveApproval() bloquea por 'read-only' —
 *  distinto del mensaje de "el usuario rechazo", que sigue aplicando solo
 *  en 'workspace-write' cuando el usuario efectivamente dice que no. */
export function readOnlyBlockedMessage(action: string): string {
  return `Modo de solo lectura activo: no se puede ${action}.`
}

const RUN_COMMAND_TIMEOUT_MS = 30_000
const MAX_TOOL_OUTPUT_CHARS = 20_000
const MAX_DIFF_PREVIEW_CHARS = 8_000
const DIFF_CONTEXT_LINES = 2

interface DiffLine {
  type: 'add' | 'remove' | 'context'
  text: string
}

/**
 * Diff linea por linea via LCS (programacion dinamica clasica O(n*m), no
 * hace falta Myers para esto — es solo para el dialogo de aprobacion, no
 * para aplicar el patch). Suficiente para los tamanios de archivo tipicos
 * que un agente edita; MAX_DIFF_PREVIEW_CHARS acota el peor caso.
 */
function computeLineDiff(oldText: string, newText: string): DiffLine[] {
  const oldLines = oldText.split('\n')
  const newLines = newText.split('\n')
  const n = oldLines.length
  const m = newLines.length
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = oldLines[i] === newLines[j]
        ? dp[i + 1][j + 1] + 1
        : Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  }

  const result: DiffLine[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (oldLines[i] === newLines[j]) {
      result.push({ type: 'context', text: oldLines[i] })
      i++
      j++
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      result.push({ type: 'remove', text: oldLines[i] })
      i++
    } else {
      result.push({ type: 'add', text: newLines[j] })
      j++
    }
  }
  while (i < n) { result.push({ type: 'remove', text: oldLines[i] }); i++ }
  while (j < m) { result.push({ type: 'add', text: newLines[j] }); j++ }
  return result
}

/**
 * Texto plano con prefijo +/-/" " por linea (el mismo formato que
 * consume el toggle de color en el renderer). Colapsa tramos largos sin
 * cambios a solo DIFF_CONTEXT_LINES antes/despues de cada bloque
 * modificado, con un separador "⋮" entre bloques no contiguos — un
 * archivo de 500 lineas con 3 cambiadas no se muestra completo.
 */
function buildDiffPreview(diffLines: DiffLine[]): string {
  const out: string[] = []
  let i = 0
  let lastShownEnd = -1
  while (i < diffLines.length) {
    if (diffLines[i].type === 'context') { i++; continue }
    let end = i
    while (end < diffLines.length && diffLines[end].type !== 'context') end++
    const contextStart = Math.max(0, i - DIFF_CONTEXT_LINES)
    const contextEnd = Math.min(diffLines.length, end + DIFF_CONTEXT_LINES)
    if (contextStart > lastShownEnd + 1) {
      if (lastShownEnd >= 0) out.push('  ⋮')
    }
    const from = Math.max(contextStart, lastShownEnd + 1)
    for (let k = from; k < contextEnd; k++) {
      const line = diffLines[k]
      const prefix = line.type === 'add' ? '+' : line.type === 'remove' ? '-' : ' '
      out.push(`${prefix}${line.text}`)
    }
    lastShownEnd = contextEnd - 1
    i = end
  }
  return out.join('\n')
}

/**
 * Detail del dialogo de aprobacion de write_file: diff real contra el
 * contenido en disco (null = archivo nuevo, todo en verde/"+").
 */
function formatWriteFileDiff(existingContent: string | null, newContent: string): string {
  const raw = existingContent === null
    ? newContent.split('\n').map(line => `+${line}`).join('\n')
    : buildDiffPreview(computeLineDiff(existingContent, newContent))

  if (raw.length <= MAX_DIFF_PREVIEW_CHARS) return raw
  const omitted = raw.length - MAX_DIFF_PREVIEW_CHARS
  return `${raw.slice(0, MAX_DIFF_PREVIEW_CHARS)}\n  ⋮ [diff recortado, se omitieron ${omitted} caracteres...]`
}

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: 'read_file',
    description: 'Lee el contenido de un archivo de texto dentro del workspace activo.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Ruta relativa al workspace del archivo a leer.' }
      },
      required: ['path']
    }
  },
  {
    name: 'write_file',
    description: 'Escribe (crea o sobrescribe) un archivo dentro del workspace activo. Requiere aprobacion explicita del usuario.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Ruta relativa al workspace del archivo a escribir.' },
        content: { type: 'string', description: 'Contenido final completo del archivo.' }
      },
      required: ['path', 'content']
    }
  },
  {
    name: 'apply_patch',
    description:
      'Edita un archivo EXISTENTE reemplazando un fragmento de texto exacto por otro, sin regenerar el ' +
      'archivo completo. Usa esto en vez de write_file para ediciones puntuales (cambiar una funcion, una ' +
      'linea, un bloque) — reserva write_file para archivos nuevos o reescrituras completas legitimas. ' +
      'old_str debe copiarse EXACTO del contenido que devolvio read_file (no lo reescribas de memoria), e ' +
      'incluir suficiente contexto (lineas antes/despues del cambio) para que ese fragmento aparezca UNA ' +
      'SOLA VEZ en el archivo — si aparece 0 o 2+ veces, la tool devuelve error y NO aplica ningun cambio. ' +
      'Si el error dice "no encontrado" o "no es unico", volve a leer el archivo con read_file y ajusta ' +
      'old_str agregando mas contexto: no reintentes el mismo old_str esperando un resultado distinto. ' +
      'Requiere aprobacion explicita del usuario, igual que write_file.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Ruta relativa al workspace del archivo a editar.' },
        old_str: {
          type: 'string',
          description: 'Fragmento de texto exacto a reemplazar, copiado literal del contenido devuelto por read_file, con contexto suficiente para ser unico en el archivo.'
        },
        new_str: { type: 'string', description: 'Texto que reemplaza a old_str.' }
      },
      required: ['path', 'old_str', 'new_str']
    }
  },
  {
    name: 'list_dir',
    description:
      'Lista SOLO los nombres de archivos y carpetas de un directorio dentro del workspace activo. ' +
      'Uso: exclusivamente para explorar la estructura de carpetas cuando no sabes donde esta algo. ' +
      'NO ejecuta comandos ni interpreta nada — si necesitas correr un comando real (ej. "prisma migrate status", ' +
      '"npm run build", "git status"), usa run_command en vez de listar directorios repetidas veces esperando otro resultado.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Ruta relativa al workspace del directorio a listar. Vacio o "." para la raiz.' }
      },
      required: []
    }
  },
  {
    name: 'run_command',
    description:
      'Ejecuta UN comando de shell real en el workspace activo y devuelve stdout/stderr/exit code. ' +
      'Uso: para CUALQUIER comando que el usuario pida correr o que necesites correr para responder ' +
      '(prisma, npm, git, python, etc.), incluyendo "git status"/"git diff" si prefieres el comando exacto ' +
      'en vez de las tools dedicadas git_status/git_diff. Requiere aprobacion explicita del usuario, siempre. ' +
      'El resultado te dice claramente si el comando fallo (exit code != 0) o no existe en el PATH: no lo ' +
      'reintentes con los mismos argumentos esperando un resultado distinto, reporta el fallo tal cual. ' +
      'IMPORTANTE: la shell real es Windows (cmd.exe por default), no Unix/Linux/macOS — usa equivalentes de ' +
      'Windows: "dir" en vez de "ls", "cd" sin argumentos en vez de "pwd" para ver el directorio actual, ' +
      '"type" en vez de "cat", "del"/"rmdir" en vez de "rm", "copy"/"xcopy" en vez de "cp", "%VAR%" en vez de ' +
      '"$VAR" para variables de entorno. Evita sintaxis Unix (pipes con comandos Unix-only, globs de shells ' +
      'POSIX, etc.) salvo que el proyecto tenga explicitamente Git Bash u otra shell POSIX disponible y lo ' +
      'hayas confirmado antes (por ejemplo detectando un shebang, un Makefile, o que el usuario lo haya dicho).',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Comando exacto a ejecutar en la shell del sistema.' }
      },
      required: ['command']
    }
  },
  {
    name: 'git_status',
    description:
      'Atajo de solo lectura equivalente a run_command con "git status --porcelain -b", sin necesitar aprobacion. ' +
      'Usalo en vez de run_command cuando solo quieras el estado de git, para evitar el dialogo de confirmacion.',
    parameters: { type: 'object', properties: {}, required: [] }
  },
  {
    name: 'git_diff',
    description:
      'Atajo de solo lectura equivalente a run_command con "git diff", sin necesitar aprobacion. ' +
      'Usalo en vez de run_command cuando solo quieras el diff, para evitar el dialogo de confirmacion.',
    parameters: { type: 'object', properties: {}, required: [] }
  },
  {
    name: 'explore',
    description:
      'Delega una tarea de busqueda/lectura repetitiva a un modelo mas barato, que investiga por su cuenta ' +
      '(solo lectura: read_file, list_dir, git_status, git_diff — nunca escribe ni ejecuta comandos) y ' +
      'devuelve un resumen condensado de lo que encontro, no el volcado crudo. Usala en vez de encadenar vos ' +
      'mismo varias llamadas de list_dir/read_file/git_status/git_diff cuando la tarea es "explorar" mas que ' +
      '"decidir": por ejemplo "encontra donde se define X", "leeme los archivos relacionados con Y y ' +
      'resumime que hacen", "revisa el estado de git y contame que cambio". Si no hay un modelo de ' +
      'compactacion configurado en Settings (seccion MEMORIA), o la llamada falla, esta tool devuelve un ' +
      'error claro — en ese caso segui explorando vos mismo con las tools normales, no reintentes explore.',
    parameters: {
      type: 'object',
      properties: {
        task: { type: 'string', description: 'Descripcion en lenguaje natural de que explorar/buscar/leer y que necesitas saber al final.' }
      },
      required: ['task']
    }
  },
  {
    name: 'list_file_history',
    description:
      'Lista las versiones guardadas de un archivo en el versionado local de AMATISTA — un historial propio, ' +
      'independiente del git real del proyecto si lo tiene (nunca se cruzan). Solo lectura, sin aprobacion. ' +
      'Usala antes de revert_file para ver que referencias hay disponibles. Devuelve fecha, referencia y que ' +
      'tool genero cada version (original/write_file/apply_patch/revert_file), la mas reciente primero. Un ' +
      'archivo que nunca se edito via write_file/apply_patch/revert_file no tiene versiones guardadas.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Ruta relativa al workspace del archivo.' }
      },
      required: ['path']
    }
  },
  {
    name: 'revert_file',
    description:
      'Restaura un archivo a una version anterior guardada por AMATISTA — usa list_file_history primero para ' +
      'ver las referencias disponibles, nunca inventes una referencia. Requiere aprobacion explicita del ' +
      'usuario, mismo dialogo de diff que write_file/apply_patch, comparando el contenido ACTUAL del archivo ' +
      'contra la version elegida. Al aprobar: escribe el contenido restaurado Y ademas guarda esa restauracion ' +
      'como una version NUEVA en el historial — nunca borra ni reescribe versiones anteriores, un revert es un ' +
      'commit mas, no un "deshacer".',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Ruta relativa al workspace del archivo.' },
        ref: { type: 'string', description: 'Referencia de version a restaurar, tal como la devolvio list_file_history.' }
      },
      required: ['path', 'ref']
    }
  }
]

function clip(text: string): string {
  return text.length > MAX_TOOL_OUTPUT_CHARS
    ? `${text.slice(0, MAX_TOOL_OUTPUT_CHARS)}\n[salida recortada]`
    : text
}

/**
 * Resuelve `relativePath` contra `workspace` y garantiza que el resultado
 * siga viviendo dentro del workspace. Lanza si el path escapa (traversal,
 * simlink fuera, ruta absoluta a otro disco, etc.).
 */
function resolveWithinWorkspace(workspace: string, relativePath: string): string {
  const clean = (relativePath || '.').trim() || '.'
  const resolved = path.resolve(workspace, clean)
  const workspaceWithSep = workspace.endsWith(path.sep) ? workspace : workspace + path.sep
  if (resolved !== workspace && !resolved.startsWith(workspaceWithSep)) {
    throw new Error(`Ruta fuera del workspace activo: ${relativePath}`)
  }
  return resolved
}

/**
 * Trunca `text` a `limit` caracteres para el payload que vuelve al modelo,
 * dejando un marcador con el conteo exacto de caracteres omitidos.
 */
function truncateForModel(text: string, limit = MAX_TOOL_OUTPUT_CHARS): string {
  if (text.length <= limit) return text
  const omitted = text.length - limit
  return `${text.slice(0, limit)}\n[...output truncado, se omitieron ${omitted} caracteres...]`
}

/**
 * \r\n -> \n, usado SOLO para decidir si old_str matchea el archivo (Fase
 * 5, apply_patch) — el modelo puede copiar old_str con un estilo de salto
 * de linea distinto al del archivo en disco sin que eso cuente como "no
 * encontrado". La escritura final restaura el estilo original del archivo,
 * ver el caso 'apply_patch' en execute().
 */
function normalizeNewlines(text: string): string {
  return text.replace(/\r\n/g, '\n')
}

/**
 * Cuenta ocurrencias NO superpuestas de `needle` en `haystack`. Asume
 * `needle` no vacio — apply_patch valida eso antes de llamar (un needle
 * vacio matchea en todas partes y rompe el conteo).
 */
function countOccurrences(haystack: string, needle: string): number {
  let count = 0
  let fromIndex = 0
  while (true) {
    const foundAt = haystack.indexOf(needle, fromIndex)
    if (foundAt === -1) break
    count++
    fromIndex = foundAt + needle.length
  }
  return count
}

function runShellCommand(command: string, cwd: string): Promise<ToolExecutionResult> {
  return new Promise(resolve => {
    exec(command, { cwd, timeout: RUN_COMMAND_TIMEOUT_MS, windowsHide: true, maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
      const exitCode = error && typeof (error as NodeJS.ErrnoException & { code?: number }).code === 'number'
        ? (error as unknown as { code: number }).code
        : (error ? 1 : 0)

      // Log completo sin truncar, solo en consola de main process (debug local).
      console.log(`[run_command] "${command}" (cwd=${cwd}) exitCode=${exitCode}`)
      if (stdout) console.log(`[run_command] stdout:\n${stdout}`)
      if (stderr) console.log(`[run_command] stderr:\n${stderr}`)

      // Formato explicito en texto plano (no JSON) para que el modelo no
      // tenga que parsear nada para saber si el comando fallo: un JSON con
      // stdout/stderr vacios se veia ambiguo y algunos modelos reintentaban
      // la misma tool esperando un resultado "mejor" en vez de reportar el
      // fallo. El veredicto va primero, explicito.
      const notFound = /no se reconoce como un comando|is not recognized as an internal or external command|command not found/i
        .test(stderr) || /no se reconoce como un comando|is not recognized as an internal or external command|command not found/i.test(stdout)
      const verdict = !error
        ? 'OK'
        : notFound
          ? `FALLO: comando no encontrado (no esta instalado o no esta en PATH)`
          : `FALLO (exit code ${exitCode})`

      const body =
        `Comando: ${command}\n` +
        `Resultado: ${verdict}\n` +
        `Codigo de salida: ${exitCode}\n\n` +
        `STDOUT:\n${truncateForModel(stdout).trim() || '(vacio)'}\n\n` +
        `STDERR:\n${truncateForModel(stderr).trim() || '(vacio)'}`

      resolve({ ok: !error, output: body })
    })
  })
}

function runGit(args: string[], cwd: string): Promise<ToolExecutionResult> {
  return new Promise(resolve => {
    exec(`git ${args.join(' ')}`, { cwd, timeout: RUN_COMMAND_TIMEOUT_MS, windowsHide: true, maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        resolve({ ok: false, output: clip(stderr || String(error)) })
        return
      }
      resolve({ ok: true, output: clip(stdout) || '(sin cambios)' })
    })
  })
}

export class ToolRegistry {
  definitions(): ToolDefinition[] {
    return TOOL_DEFINITIONS
  }

  async execute(name: string, rawArgs: unknown, ctx: ExecuteContext): Promise<ToolExecutionResult> {
    const args = typeof rawArgs === 'object' && rawArgs !== null ? rawArgs as Record<string, unknown> : {}

    if (process.env.AMATISTA_DEBUG_TOOLS === '1') {
      console.log(`[toolRegistry.execute] tool=${name} workspace="${ctx.workspace}" args=${JSON.stringify(args).slice(0, 500)}`)
    }

    try {
      switch (name) {
        case 'read_file': {
          const target = resolveWithinWorkspace(ctx.workspace, String(args.path ?? ''))
          if (!existsSync(target) || !statSync(target).isFile()) {
            return { ok: false, output: `Archivo no encontrado: ${String(args.path ?? '')}` }
          }
          return { ok: true, output: clip(readFileSync(target, 'utf8')) }
        }

        case 'write_file': {
          const relPath = String(args.path ?? '')
          const content = String(args.content ?? '')
          const target = resolveWithinWorkspace(ctx.workspace, relPath)
          const existingContent = existsSync(target) && statSync(target).isFile()
            ? readFileSync(target, 'utf8')
            : null
          const approved = await resolveApproval(
            ctx.sandbox,
            ctx.confirm,
            `Escribir archivo: ${relPath}`,
            formatWriteFileDiff(existingContent, content)
          )
          if (!approved) {
            return {
              ok: false,
              output: ctx.sandbox === 'read-only'
                ? readOnlyBlockedMessage('escribir archivos')
                : 'El usuario rechazo la escritura del archivo.'
            }
          }
          // Fase 8: snapshot en el VCS oculto ANTES de la escritura real —
          // awaited, no fire-and-forget, para que el commit de lo que habia
          // (si es la primera vez que se toca este archivo) exista antes de
          // que writeFileSync lo pise. Si falla (git no instalado, permisos),
          // NO bloquea la escritura real (ver local-vcs.ts) — solo se avisa
          // en el output, nunca se esconde del todo.
          const vcsSnapshot = await snapshotFile({
            workspace: ctx.workspace,
            relPath,
            existingContent,
            newContent: content,
            tool: 'write_file'
          })
          writeFileSync(target, content, 'utf8')
          const vcsNote = vcsSnapshot.ok ? '' : ` [AVISO: no se pudo versionar el archivo antes de escribir — ${vcsSnapshot.error}]`
          return { ok: true, output: `Archivo escrito: ${relPath}${vcsNote}` }
        }

        case 'apply_patch': {
          const relPath = String(args.path ?? '')
          const oldStr = String(args.old_str ?? '')
          const newStr = String(args.new_str ?? '')

          if (!oldStr) {
            return { ok: false, output: 'old_str no puede estar vacio. Para crear un archivo nuevo usa write_file.' }
          }

          const target = resolveWithinWorkspace(ctx.workspace, relPath)
          if (!existsSync(target) || !statSync(target).isFile()) {
            return { ok: false, output: `Archivo no encontrado: ${relPath}. Para crear un archivo nuevo usa write_file.` }
          }

          const existingContent = readFileSync(target, 'utf8')
          // Estilo de salto de linea del archivo EN DISCO, detectado antes
          // de normalizar nada — determina como se escribe el resultado
          // final, no como se compara (eso es normalizedContent). Criterio
          // de MAYORIA, no de presencia: un archivo con 499 lineas en \n y
          // 1 en \r\n por accidente historico es un archivo \n con una
          // excepcion aislada, no un archivo \r\n — usesCRLF = false ahi,
          // para no reescribir las otras 499 lineas sin que nadie lo pida.
          const crlfCount = (existingContent.match(/\r\n/g) ?? []).length
          const lfOnlyCount = (existingContent.match(/(?<!\r)\n/g) ?? []).length
          const usesCRLF = crlfCount > lfOnlyCount
          const normalizedContent = normalizeNewlines(existingContent)
          const normalizedOldStr = normalizeNewlines(oldStr)
          const occurrences = countOccurrences(normalizedContent, normalizedOldStr)

          if (occurrences === 0) {
            return {
              ok: false,
              output: `old_str no encontrado en ${relPath}. Volve a leer el archivo con read_file y copia el fragmento exacto — no reintentes el mismo old_str.`
            }
          }
          if (occurrences > 1) {
            return {
              ok: false,
              output: `old_str aparece ${occurrences} veces en ${relPath} — no es unico, no se aplico ningun cambio. Agrega mas contexto (lineas antes/despues) para que el fragmento sea unico.`
            }
          }

          const matchIndex = normalizedContent.indexOf(normalizedOldStr)
          const normalizedNewContent =
            normalizedContent.slice(0, matchIndex) +
            normalizeNewlines(newStr) +
            normalizedContent.slice(matchIndex + normalizedOldStr.length)
          // Preserva el estilo de salto de linea original del archivo: la
          // comparacion de arriba fue normalizada, pero lo que se escribe
          // a disco no le impone \n a un archivo \r\n ni viceversa.
          const finalContent = usesCRLF ? normalizedNewContent.replace(/\n/g, '\r\n') : normalizedNewContent

          const approved = await resolveApproval(
            ctx.sandbox,
            ctx.confirm,
            `Editar archivo: ${relPath}`,
            formatWriteFileDiff(existingContent, finalContent)
          )
          if (!approved) {
            return {
              ok: false,
              output: ctx.sandbox === 'read-only'
                ? readOnlyBlockedMessage('editar archivos')
                : 'El usuario rechazo la edicion del archivo.'
            }
          }
          // Fase 8: mismo enganche que write_file — snapshot awaited antes
          // de la escritura real. apply_patch solo edita archivos que YA
          // EXISTEN (validado arriba), asi que existingContent nunca es
          // null aca: si es el primer toque de este archivo, snapshotFile
          // commitea el original antes de commitear esta edicion.
          const vcsSnapshot = await snapshotFile({
            workspace: ctx.workspace,
            relPath,
            existingContent,
            newContent: finalContent,
            tool: 'apply_patch'
          })
          writeFileSync(target, finalContent, 'utf8')
          const vcsNote = vcsSnapshot.ok ? '' : ` [AVISO: no se pudo versionar el archivo antes de editar — ${vcsSnapshot.error}]`
          return { ok: true, output: `Archivo editado: ${relPath}${vcsNote}` }
        }

        case 'list_dir': {
          const target = resolveWithinWorkspace(ctx.workspace, String(args.path ?? '.'))
          if (!existsSync(target) || !statSync(target).isDirectory()) {
            return { ok: false, output: `Directorio no encontrado: ${String(args.path ?? '.')}` }
          }
          const entries = readdirSync(target, { withFileTypes: true })
            .map(entry => `${entry.isDirectory() ? 'dir ' : 'file'}  ${entry.name}`)
          return { ok: true, output: clip(entries.join('\n') || '(directorio vacio)') }
        }

        case 'run_command': {
          const command = String(args.command ?? '').trim()
          if (!command) return { ok: false, output: 'Comando vacio.' }
          const approved = await resolveApproval(ctx.sandbox, ctx.confirm, 'Ejecutar comando', command)
          if (!approved) {
            return {
              ok: false,
              output: ctx.sandbox === 'read-only'
                ? readOnlyBlockedMessage('ejecutar comandos')
                : 'El usuario rechazo la ejecucion del comando.'
            }
          }
          return runShellCommand(command, ctx.workspace)
        }

        case 'git_status':
          return runGit(['status', '--porcelain', '-b'], ctx.workspace)

        case 'git_diff':
          return runGit(['diff'], ctx.workspace)

        // No es una rama mas del switch en el sentido de "ejecuta y
        // devuelve": dispara el mini-loop propio de explore-tool.ts contra
        // el modelo barato configurado. Si no hay uno configurado o valido,
        // devuelve el error directo aca (caso esperado); cualquier otro
        // fallo (HTTP, limite de iteraciones) lo lanza runExploreLoop y lo
        // atrapa el try/catch de este metodo, mas abajo — mismo resultado
        // {ok:false, output} sin duplicar el manejo de errores.
        case 'explore': {
          const task = String(args.task ?? '').trim()
          if (!task) {
            return { ok: false, output: 'Falta el parametro "task": describi en lenguaje natural que explorar.' }
          }
          if (!ctx.resolveExploreModel) {
            return { ok: false, output: 'explore no esta disponible en este contexto de ejecucion.' }
          }
          const target = ctx.resolveExploreModel()
          if (!target) {
            return {
              ok: false,
              output:
                'No hay modelo de compactacion configurado en Settings (seccion MEMORIA, ' +
                'compactionProviderId/compactionModelId) o el configurado ya no es valido — explore no puede ' +
                'delegar. Segui explorando vos mismo con read_file/list_dir/git_status/git_diff.'
            }
          }
          const readOnlyDefs = TOOL_DEFINITIONS.filter(def => (EXPLORE_TOOL_NAMES as readonly string[]).includes(def.name))
          const summary = await runExploreLoop({
            task,
            provider: target.provider,
            model: target.model,
            toolDefinitions: readOnlyDefs,
            runTool: (toolName, toolArgs) => this.execute(toolName, toolArgs, {
              workspace: ctx.workspace,
              // Fijo a 'read-only' A PROPOSITO — NO se hereda ctx.sandbox.
              // Si se heredara, un turno principal en danger-full-access
              // haria que resolveApproval() de este sub-contexto tome la
              // rama danger-full-access y devuelva true SIN LLAMAR A
              // confirm, anulando el "confirm: async () => false" de mas
              // abajo (Fase 4, segunda capa independiente por si el
              // whitelist de explore-tool.ts fallara). Con 'read-only'
              // fijo, resolveApproval toma la rama read-only y bloquea de
              // raiz sin siquiera intentar confirm — asi la whitelist
              // (Capa 1), este sandbox fijo (Capa 2, via resolveApproval)
              // y el confirm hardcodeado (Capa 3) quedan las tres
              // independientes entre si, cada una deny-by-default por su
              // cuenta, sin que una pueda anular a las otras.
              sandbox: 'read-only',
              confirm: async () => false
            })
          })
          return { ok: true, output: summary }
        }

        case 'list_file_history': {
          const relPath = String(args.path ?? '')
          if (!relPath) return { ok: false, output: 'Falta el parametro "path".' }
          resolveWithinWorkspace(ctx.workspace, relPath) // valida que no escape el workspace, aunque el archivo no tiene que existir hoy
          const entries = await listFileHistory(ctx.workspace, relPath)
          if (entries.length === 0) {
            return { ok: true, output: `${relPath} no tiene versiones guardadas todavia (nunca se edito via write_file/apply_patch/revert_file).` }
          }
          const lines = entries.map(entry => `${entry.date}  ${entry.ref}  ${entry.tool}`)
          return { ok: true, output: `Versiones de ${relPath} (mas reciente primero):\n${lines.join('\n')}` }
        }

        case 'revert_file': {
          const relPath = String(args.path ?? '')
          const ref = String(args.ref ?? '').trim()
          if (!relPath || !ref) {
            return { ok: false, output: 'Faltan "path" y/o "ref". Llama list_file_history primero para ver las referencias disponibles.' }
          }

          const target = resolveWithinWorkspace(ctx.workspace, relPath)
          const restoredContent = await readFileVersion(ctx.workspace, relPath, ref)
          if (restoredContent === null) {
            return {
              ok: false,
              output: `No se encontro la referencia "${ref}" para ${relPath}. Volve a llamar list_file_history para confirmar las referencias validas — no reintentes la misma ref.`
            }
          }

          const currentContent = existsSync(target) && statSync(target).isFile()
            ? readFileSync(target, 'utf8')
            : null
          const approved = await resolveApproval(
            ctx.sandbox,
            ctx.confirm,
            `Restaurar version anterior: ${relPath}`,
            formatWriteFileDiff(currentContent, restoredContent)
          )
          if (!approved) {
            return {
              ok: false,
              output: ctx.sandbox === 'read-only'
                ? readOnlyBlockedMessage('restaurar archivos')
                : 'El usuario rechazo la restauracion del archivo.'
            }
          }

          // La restauracion en si tambien es una version nueva (nunca se
          // borra historia) — mismo mecanismo que write_file/apply_patch.
          // history ya existe seguro en este punto (vino de list_file_history),
          // asi que snapshotFile nunca dispara el caso especial de "original".
          const vcsSnapshot = await snapshotFile({
            workspace: ctx.workspace,
            relPath,
            existingContent: currentContent,
            newContent: restoredContent,
            tool: 'revert_file'
          })
          writeFileSync(target, restoredContent, 'utf8')
          const vcsNote = vcsSnapshot.ok ? '' : ` [AVISO: no se pudo registrar la restauracion en el historial — ${vcsSnapshot.error}]`
          return { ok: true, output: `Archivo restaurado: ${relPath} (version ${ref})${vcsNote}` }
        }

        default:
          return { ok: false, output: `Tool desconocida: ${name}` }
      }
    } catch (error) {
      return { ok: false, output: error instanceof Error ? error.message : String(error) }
    }
  }
}
