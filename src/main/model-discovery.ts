// Descubrimiento real de modelos NUEVOS para conexiones de suscripcion
// (boton "Actualizar modelos", docs/_arch/verify_model_refresh_design.md).
// Mecanismo DISTINTO por proveedor, confirmado real en la investigacion --
// ver el comentario de cada funcion. Contrato comun para las 2 funciones de
// este archivo: NUNCA escriben nada en settings -- solo devuelven
// candidatos nuevos ya confirmados reales; el llamador (App.tsx) hace el
// merge "solo agregar" contra los modelos que esa conexion ya tiene. Codex
// no tiene funcion aca -- reusa el mecanismo YA EXISTENTE en produccion
// (CodexAccountBridge.listModels(), IPC codex:modelList/listCodexModels()),
// confirmado real y funcionando en esta misma sesion -- el merge "solo
// agregar" para Codex se hace directo en App.tsx contra ese resultado, sin
// duplicar logica de descubrimiento aca.
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { antigravityCommand, claudeCommand } from './cli-agent-runtime'

const execFileAsync = promisify(execFile)

export interface DiscoveredModel {
  displayName: string
  model: string
}

const CLAUDE_MODEL_TIMEOUT_MS = 30_000
const CLAUDE_VERIFY_CONCURRENCY = 5

/** Nombre legible real a partir del id tecnico -- "claude-opus-4-8" ->
 *  "Claude Opus 4.8", mismo criterio de nombrado ya usado a mano hoy para
 *  las 10 entradas reales de qcfg-claude-subscription (Tier + version con
 *  puntos en vez de guiones, sin fecha ni sufijos internos). */
function displayNameForClaudeId(id: string): string {
  const match = /^claude-(sonnet|opus|haiku|fable)-(.+)$/i.exec(id)
  if (!match) return id
  const tier = match[1].charAt(0).toUpperCase() + match[1].slice(1)
  const version = match[2].replace(/-/g, '.')
  return `Claude ${tier} ${version}`
}

/**
 * Claude: SIN comando ni API real de listado (confirmado real,
 * verify_model_refresh_design.md Tarea 1/2 -- `claude --help` no tiene
 * ningun subcomando de modelos, `/model` solo expone los 4 alias de tier
 * de la sesion actual, no el catalogo historico completo). Candidatos
 * reales generados de 2 fuentes de texto, combinadas a proposito:
 *  - `~/.claude/cache/changelog.md`: changelog real cacheado por el propio
 *    CLI -- confirmado que menciona algunos ids entre backticks, pero es
 *    INCOMPLETO por si solo (confirmado real: no menciona Haiku 4.5 en
 *    absoluto, pese a ser un modelo real y accesible).
 *  - el binario `claude.exe` instalado: confirmado real que un patron
 *    ANCLADO a un tier conocido seguido de un digito
 *    (`claude-(sonnet|opus|haiku|fable)-\d...`) da 35 matches reales SIN
 *    ningun falso positivo (vs. 225 con un patron generico "claude-*") --
 *    fuente mas completa, usada ademas del changelog, nunca en su lugar.
 * Deduplicado por "forma base" (sin sufijo de fecha -YYYYMMDD ni -v1 final)
 * antes de verificar -- evita probar 3 veces el mismo modelo real bajo
 * distintos alias de fecha/version interna.
 * Verificacion real OBLIGATORIA de cada candidato nuevo: la extraccion de
 * texto nunca confirma acceso real de la cuenta, solo genera candidatos --
 * cada uno se prueba con un turno real minimo (mismo mecanismo ya usado en
 * esta sesion para confirmar los 10 modelos ya agregados), concurrencia
 * acotada (nunca las N juntas, evita parecer trafico abusivo contra la
 * cuenta real del usuario). Esto NO es parallel_ask/terminal_exec --
 * confirmado en el diseno que esas son tools de turno de chat que el
 * MODELO invoca, sin relacion con esta accion de UI de Settings sin ningun
 * turno de por medio.
 */
export async function discoverNewClaudeModels(existingModelValues: string[]): Promise<DiscoveredModel[]> {
  const TIER_PATTERN = /claude-(sonnet|opus|haiku|fable)-\d[a-z0-9-]*/gi

  const sources: string[] = []

  const changelogPath = path.join(os.homedir(), '.claude', 'cache', 'changelog.md')
  if (existsSync(changelogPath)) {
    try {
      sources.push(await readFile(changelogPath, 'utf8'))
    } catch {
      // Archivo real pero ilegible (permisos, etc.) -- se sigue solo con
      // el binario, nunca falla la funcion entera por esto.
    }
  }

  const claudeExe = claudeCommand()
  if (path.isAbsolute(claudeExe) && existsSync(claudeExe)) {
    try {
      sources.push(await readFile(claudeExe, 'latin1'))
    } catch {
      // Binario real pero ilegible -- se sigue solo con el changelog.
    }
  }

  const rawMatches = new Set<string>()
  for (const text of sources) {
    for (const match of text.matchAll(TIER_PATTERN)) rawMatches.add(match[0].toLowerCase())
  }

  // Deduplica por forma base (sin fecha ni -v1) -- se queda con la
  // variante MAS CORTA de cada grupo (la forma "limpia", ej.
  // claude-opus-4-5 en vez de claude-opus-4-5-20251101-v1).
  const baseOf = (id: string): string => id.replace(/-v1$/, '').replace(/-\d{8}$/, '')
  const byBase = new Map<string, string>()
  for (const id of rawMatches) {
    const base = baseOf(id)
    const current = byBase.get(base)
    if (!current || id.length < current.length) byBase.set(base, id)
  }

  // Fix real (encontrado en la verificacion de esta misma tarea): comparar
  // el candidato representante contra el STRING EXACTO de lo ya existente
  // fallaba cuando lo existente esta pinneado con sufijo de fecha (ej.
  // claude-haiku-4-5-20251001, ya agregado) y el candidato nuevo resuelve
  // a la forma base sin fecha (claude-haiku-4-5) -- MISMO modelo real, 2
  // strings distintos, se hubiera agregado como "nuevo" pese a ser un
  // duplicado funcional real. Comparacion por FORMA BASE en ambos lados
  // (lo existente tambien pasa por baseOf()) cierra el gap.
  const existingBases = new Set(existingModelValues.map(v => baseOf(v.trim().toLowerCase())))
  const toVerify = Array.from(byBase.entries())
    .filter(([base]) => !existingBases.has(base))
    .map(([, id]) => id)

  const confirmed: DiscoveredModel[] = []
  for (let i = 0; i < toVerify.length; i += CLAUDE_VERIFY_CONCURRENCY) {
    const batch = toVerify.slice(i, i + CLAUDE_VERIFY_CONCURRENCY)
    const results = await Promise.all(batch.map(async id => (await verifyClaudeModel(id)) ? id : null))
    for (const id of results) {
      if (id) confirmed.push({ displayName: displayNameForClaudeId(id), model: id })
    }
  }
  return confirmed
}

async function verifyClaudeModel(modelId: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync(
      claudeCommand(),
      ['-p', 'Reply with exactly one word: OK', '--model', modelId],
      { timeout: CLAUDE_MODEL_TIMEOUT_MS, windowsHide: true }
    )
    return /\bOK\b/.test(stdout)
  } catch {
    // Retirado, remapeado, no reconocido, o cualquier otro error real --
    // se descarta en silencio, nunca se agrega un candidato sin confirmar.
    return false
  }
}

/**
 * Antigravity: comando real y directo `agy models` (confirmado real,
 * Tarea 2 del diseno) -- "Fetching available models..." + N lineas reales
 * `<id>\t<displayName>`. Confirmado con un spot-check real (turno minimo
 * contra un modelo recien listado, nunca antes usado en la cuenta) que
 * "listado por este comando" ya implica "accesible" -- a diferencia de
 * Claude, NO hace falta ningun turno de verificacion adicional por
 * candidato, el propio comando ya es la confirmacion real y en vivo.
 */
export async function discoverNewAntigravityModels(existingModelValues: string[]): Promise<DiscoveredModel[]> {
  let stdout: string
  try {
    const result = await execFileAsync(antigravityCommand(), ['models'], { timeout: 30_000, windowsHide: true })
    stdout = result.stdout
  } catch {
    return []
  }

  const existing = new Set(existingModelValues.map(v => v.trim().toLowerCase()))
  const discovered: DiscoveredModel[] = []
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const tabIndex = trimmed.indexOf('\t')
    // Sin tab real -> no es una fila de modelo (ej. "Fetching available
    // models..."), se descarta sin fallar la corrida entera.
    if (tabIndex === -1) continue
    const id = trimmed.slice(0, tabIndex).trim()
    const displayName = trimmed.slice(tabIndex + 1).trim()
    if (!id || !displayName) continue
    if (existing.has(id.toLowerCase())) continue
    discovered.push({ displayName, model: id })
  }
  return discovered
}
