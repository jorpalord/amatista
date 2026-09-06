// Sistema de skills (docs/_arch/verify_skills_design.md): formato real
// Agent Skills (carpeta kebab-case + SKILL.md, o un <name>.md plano) con
// divulgacion progresiva de 2 niveles -- nivel 1 (nombre+descripcion,
// inyectado siempre) y nivel 2 (cuerpo completo, solo via la tool
// load_skill). Mecanismo DISTINTO y complementario a AGENTS.md
// (agents-md.ts, sin tocar) -- ese es un unico archivo de instrucciones de
// proyecto siempre inyectado completo; esto es una BIBLIOTECA de
// procedimientos especializados, activados uno por uno bajo demanda.
//
// Escaneo real de 2 raices (mismo criterio de merge por clave que
// lsp.json, workspace pisa global -- confirmado real en la investigacion
// previa que .mcp.json es solo-workspace pero lsp.json SI tiene esta
// forma de 2 niveles, y que una skill util tipicamente se reusa ENTRE
// proyectos, mas parecido a lsp.json que a .mcp.json):
//   - Global: <storage root>/skills/*/SKILL.md (o *.md plano) --
//     getAppDataSubdir('skills'), mismo directorio raiz que config/lsp.json.
//   - Workspace: <workspace>/.skills/*/SKILL.md (o *.md plano).
//
// Cache con invalidacion real (mismo espiritu que lsp.json/agents-md.ts,
// adaptado a MULTIPLES archivos en vez de uno solo): una "firma" real
// (ruta+mtime de CADA archivo de skill encontrado, ordenada y unida) se
// recalcula en cada llamada real (barato, solo 2 readdirSync + unos pocos
// statSync) -- si coincide con la firma cacheada, se reusa el parseo ya
// hecho; si difiere (skill agregada/borrada/editada), se reparsea todo.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { parse as parseYaml } from 'yaml'
import { getAppDataSubdir } from './app-paths'
import type { SkillCatalogEntry } from '../shared/types'

interface SkillEntry {
  name: string
  description: string
  body: string
  sourcePath: string
}

interface ScannedSkillFile {
  name?: string
  description?: string
  body: string
  sourcePath: string
  mtimeMs: number
}

/**
 * Frontmatter real de Agent Skills: `---\n<yaml>\n---\n<cuerpo markdown>`.
 * Reusa `parse` de `yaml` (dependencia YA real y en uso directo, confirmado
 * en la investigacion previa -- `ipc-settings.ts:6`, `parseYaml(raw)` para
 * un YAML real de importacion de config) -- cero dependencia nueva.
 * Archivo sin frontmatter valido (no empieza con `---` real en su propia
 * linea) se ignora -- mismo criterio que `.mcp.json`/`lsp.json` invalido:
 * nunca bloquea el resto de las skills reales por una rota.
 */
function parseSkillFrontmatter(raw: string): { name?: string; description?: string; body: string } | null {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/)
  if (!match) return null
  try {
    const frontmatter = parseYaml(match[1]) as Record<string, unknown> | null
    const name = typeof frontmatter?.name === 'string' ? frontmatter.name.trim() : undefined
    const description = typeof frontmatter?.description === 'string' ? frontmatter.description.trim() : undefined
    return { name, description, body: match[2].trim() }
  } catch {
    return null
  }
}

/** Escanea UNA raiz real (global o workspace) -- acepta subcarpetas con
 *  SKILL.md adentro (formato real principal de Agent Skills) O un
 *  `<name>.md` plano directo en la raiz (variante real tambien aceptada
 *  por el estandar). Ignora candidatos invalidos/illegibles sin tumbar el
 *  escaneo entero -- mismo criterio de robustez que el resto de esta
 *  bitacora. */
function scanSkillRoot(root: string): ScannedSkillFile[] {
  if (!existsSync(root)) return []
  let entries: import('node:fs').Dirent[]
  try {
    entries = readdirSync(root, { withFileTypes: true })
  } catch {
    return []
  }

  const results: ScannedSkillFile[] = []
  for (const entry of entries) {
    let filePath: string | null = null
    let fallbackName: string | null = null

    if (entry.isDirectory()) {
      const candidate = path.join(root, entry.name, 'SKILL.md')
      if (existsSync(candidate)) {
        filePath = candidate
        fallbackName = entry.name
      }
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
      filePath = path.join(root, entry.name)
      fallbackName = entry.name.replace(/\.md$/i, '')
    }
    if (!filePath) continue

    try {
      const stat = statSync(filePath)
      const raw = readFileSync(filePath, 'utf8')
      const parsed = parseSkillFrontmatter(raw)
      if (!parsed) continue
      results.push({
        name: parsed.name || fallbackName || undefined,
        description: parsed.description,
        body: parsed.body,
        sourcePath: filePath,
        mtimeMs: stat.mtimeMs
      })
    } catch {
      // Archivo roto/illegible a mitad de lectura -- se ignora, mismo
      // criterio de robustez que el resto del escaneo.
    }
  }
  return results
}

interface CachedScan {
  signature: string
  entries: Map<string, SkillEntry>
}

/** Cache por workspace -- el root global es constante durante la vida del
 *  proceso, asi que cachear por workspace alcanza (mismo dato global se
 *  re-escanea barato para cada workspace distinto, sin necesitar una
 *  entrada de cache separada para el). */
const scanCache = new Map<string, CachedScan>()

function computeSignature(files: ScannedSkillFile[]): string {
  return files
    .map(file => `${file.sourcePath}:${file.mtimeMs}`)
    .sort()
    .join('|')
}

/** Escaneo + merge real de las 2 raices, con cache invalidado por firma
 *  real (ver comentario de arriba). Workspace pisa global por CLAVE
 *  (nombre de skill) si hay conflicto -- mismo criterio real que
 *  `mergedLanguageServers()` (lsp-client.ts) para `lsp.json`. */
function resolveSkills(workspace: string): Map<string, SkillEntry> {
  const globalRoot = getAppDataSubdir('skills')
  const workspaceRoot = path.join(workspace, '.skills')

  const globalFiles = scanSkillRoot(globalRoot)
  const workspaceFiles = scanSkillRoot(workspaceRoot)
  const signature = computeSignature([...globalFiles, ...workspaceFiles])

  const cached = scanCache.get(workspace)
  if (cached && cached.signature === signature) return cached.entries

  const merged = new Map<string, SkillEntry>()
  for (const file of [...globalFiles, ...workspaceFiles]) {
    if (!file.name) continue // sin name real en el frontmatter ni fallback de archivo -- no hay clave valida, se ignora.
    merged.set(file.name, {
      name: file.name,
      description: file.description || '(sin descripcion)',
      body: file.body,
      sourcePath: file.sourcePath
    })
  }

  scanCache.set(workspace, { signature, entries: merged })
  return merged
}

/** Nivel 1 -- catalogo liviano (SOLO nombre+descripcion, nunca el cuerpo)
 *  para inyectar en el contexto de cada turno (buildRuntimeContext(),
 *  runtime-state.ts). [] si no hay ninguna skill real configurada. */
export function listSkillsCatalog(workspace: string): SkillCatalogEntry[] {
  return [...resolveSkills(workspace).values()].map(skill => ({
    name: skill.name,
    description: skill.description
  }))
}

/** Nivel 2 -- cuerpo COMPLETO de una skill puntual, para la tool
 *  load_skill (tool-registry.ts). Error claro listando las skills reales
 *  disponibles si el nombre no matchea ninguna -- nunca un error generico
 *  tipo "no encontrado" sin contexto accionable. */
export function getSkillBody(workspace: string, name: string): { ok: true; body: string } | { ok: false; error: string } {
  const skills = resolveSkills(workspace)
  const skill = skills.get(name)
  if (skill) return { ok: true, body: skill.body }

  const available = [...skills.keys()]
  return {
    ok: false,
    error: available.length > 0
      ? `No existe una skill llamada "${name}". Skills disponibles: ${available.join(', ')}.`
      : `No existe una skill llamada "${name}" -- no hay ninguna skill configurada (ni global ni en este workspace).`
  }
}
