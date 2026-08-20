import { exec } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'

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
      'reintentes con los mismos argumentos esperando un resultado distinto, reporta el fallo tal cual.',
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
          const approved = await ctx.confirm(
            `Escribir archivo: ${relPath}`,
            formatWriteFileDiff(existingContent, content)
          )
          if (!approved) return { ok: false, output: 'El usuario rechazo la escritura del archivo.' }
          writeFileSync(target, content, 'utf8')
          return { ok: true, output: `Archivo escrito: ${relPath}` }
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
          const approved = await ctx.confirm('Ejecutar comando', command)
          if (!approved) return { ok: false, output: 'El usuario rechazo la ejecucion del comando.' }
          return runShellCommand(command, ctx.workspace)
        }

        case 'git_status':
          return runGit(['status', '--porcelain', '-b'], ctx.workspace)

        case 'git_diff':
          return runGit(['diff'], ctx.workspace)

        default:
          return { ok: false, output: `Tool desconocida: ${name}` }
      }
    } catch (error) {
      return { ok: false, output: error instanceof Error ? error.message : String(error) }
    }
  }
}
