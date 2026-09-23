// Herramientas compuestas (docs/_experiments/composed-tools/CONTRACT.md) -- datos puros + almacenamiento.
//
// Una receta NUNCA contiene codigo: es una lista declarativa de llamadas a tools reales de TOOL_DEFINITIONS, en 2
// secciones que el modelo declara -- `discover` (solo lectura, corre ANTES de pedir aprobacion) y `apply` (efectos,
// sobre un plan congelado despues de la aprobacion unica de la corrida). La ejecucion real vive en ToolRegistry
// (tool-registry.ts), que corre cada paso con this.execute() -- mismos gates de siempre, en cada corrida.
//
// Modulo HOJA a proposito: nunca importa tool-registry.ts en runtime (solo tipos), asi que tool-registry.ts y
// api-agent-runtime.ts pueden importarlo sin sumar ningun ciclo nuevo.
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { getAppDataSubdir } from './app-paths'
import type { ToolDefinition } from './tool-registry'

export const COMPOSED_TOOL_PREFIX = 'composed__'
export const PROPOSE_COMPOSED_TOOL = 'propose_composed_tool'

/** Profundidad maxima de recetas anidadas (receta = 1, hija = 2, nieta = 3). Ver CONTRACT.md, Tarea 5. */
export const MAX_RECIPE_NESTING = 3
/** Niveles de `foreach` anidados dentro de una misma receta. */
export const MAX_FOREACH_DEPTH = 2
export const MAX_FOREACH_ITERATIONS = 50
/** Topes del PEOR caso de una corrida -- chequeados al proponer (estatico) y al armar el plan (real). */
export const MAX_EFFECT_CALLS = 50
export const MAX_DISCOVERY_CALLS = 50

/** Las unicas 4 tools que la aprobacion unica de una corrida puede cubrir: cada una llama a resolveApproval()
 *  exactamente una vez, sin ctx.confirm() directo y sin hardConfirm (verificado sobre el codigo real de cada case). */
export const RUN_GRANT_TOOLS: ReadonlySet<string> = new Set(['write_file', 'apply_patch', 'run_command', 'revert_file'])

/** Solo para ETIQUETAR el plan que ve el usuario ("te va a preguntar aparte, siempre") -- la seguridad real no
 *  depende de esta lista: el grant de la corrida nunca envuelve ctx.hardConfirm, sea cual sea la tool. */
export const HARD_CONFIRM_TOOLS: ReadonlySet<string> = new Set([
  'close_app', 'lock_screen', 'power',
  'screenshot', 'mouse_move', 'mouse_click', 'keyboard_type',
  'browser_navigate', 'browser_click', 'browser_type', 'browser_screenshot'
])

/** Nunca dentro de una receta: una receta no puede extender el catalogo, orquestar turnos en otros paneles ni
 *  salir del modo plan. */
export const RECIPE_EXCLUDED_TOOLS: ReadonlySet<string> = new Set([
  PROPOSE_COMPOSED_TOOL, 'send_to_window', 'parallel_ask', 'exit_plan_mode'
])

/** Tools de descubrimiento que producen una LISTA (via adaptador fijo) -- lo unico sobre lo que itera un foreach. */
const LIST_TOOLS: ReadonlySet<string> = new Set(['list_dir', 'search_files', 'git_status'])

export type ConditionOp = 'eq' | 'neq' | 'contains' | 'startsWith' | 'endsWith' | 'gt' | 'lt'
const CONDITION_OPS: ReadonlySet<string> = new Set(['eq', 'neq', 'contains', 'startsWith', 'endsWith', 'gt', 'lt'])

export interface RecipeCondition {
  field: string
  op: ConditionOp
  value: string
}

export interface RecipeStep {
  id: string
  tool?: string
  args?: Record<string, string>
  if?: RecipeCondition
  foreach?: { in: string; as: string; maxIterations: number; where?: RecipeCondition }
  steps?: RecipeStep[]
}

export interface RecipeInput {
  name: string
  description: string
}

export interface ComposedRecipe {
  version: 1
  name: string
  description: string
  inputs: RecipeInput[]
  discover: RecipeStep[]
  apply: RecipeStep[]
  createdAt: string
  approvedAt: string
}

interface StoredRecipe extends ComposedRecipe {
  signature: string
}

// ---------------------------------------------------------------------------------------------------------------
// Validacion estatica (al proponer Y al cargar para correr -- una receta editada a mano nunca corre sin revalidar).

export interface ToolParamsInfo {
  properties: ReadonlySet<string>
  required: readonly string[]
}

export interface RecipeValidationEnv {
  /** Parametros reales de cada tool de TOOL_DEFINITIONS, por nombre. */
  toolParams: ReadonlyMap<string, ToolParamsInfo>
  /** DISCOVERY_TOOL_NAMES (= EXPLORE_TOOL_NAMES, ver tool-registry.ts). */
  discoveryTools: ReadonlySet<string>
  /** Carga (con firma verificada) una receta YA aprobada, para recetas anidadas. */
  loadRecipe: (name: string) => ComposedRecipe | null
}

export interface RecipeValidationResult {
  ok: boolean
  errors: string[]
  depth: number
  worstCaseDiscoveryCalls: number
  worstCaseEffectCalls: number
}

const NAME_RE = /^[a-z][a-z0-9_]{1,40}$/
const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]{0,40}$/
const REF_RE = /\{\{\s*([^{}]*?)\s*\}\}/g
const SINGLE_REF_RE = /^\{\{\s*([^{}]+?)\s*\}\}$/
const RESERVED_ROOTS: ReadonlySet<string> = new Set(['input', 'steps'])

type StepKind = 'list' | 'records' | 'read' | 'text'

const FIELDS_BY_KIND: Record<StepKind, ReadonlySet<string>> = {
  list: new Set(['ok', 'output', 'items']),
  records: new Set(['ok', 'output', 'items']),
  read: new Set(['ok', 'output', 'lines', 'chars']),
  text: new Set(['ok', 'output'])
}

interface ValidationScope {
  phase: 'discover' | 'apply'
  inputs: ReadonlySet<string>
  /** Pasos de `discover` visibles (por id) y su tipo -- en `apply` NUNCA se agregan pasos de `apply`. */
  visible: Map<string, StepKind>
  asNames: ReadonlySet<string>
  foreachDepth: number
  allIds: Set<string>
  errors: string[]
  env: RecipeValidationEnv
  /** Nombres de recetas en la cadena actual de anidamiento (deteccion de ciclos). */
  chain: readonly string[]
  childDepth: { max: number }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function kindForTool(tool: string): StepKind {
  if (LIST_TOOLS.has(tool)) return 'list'
  if (tool === 'read_file') return 'read'
  return 'text'
}

function validateReference(ref: string, scope: ValidationScope, where: string): void {
  const segments = ref.split('.')
  if (segments.some(segment => !IDENT_RE.test(segment))) {
    scope.errors.push(`${where}: referencia invalida "{{${ref}}}" (solo nombres separados por punto, sin indices ni expresiones).`)
    return
  }
  const [root, ...rest] = segments
  if (root === 'input') {
    if (rest.length !== 1 || !scope.inputs.has(rest[0])) {
      scope.errors.push(`${where}: "{{${ref}}}" no es un input declarado (inputs: ${[...scope.inputs].join(', ') || 'ninguno'}).`)
    }
    return
  }
  if (root === 'steps') {
    if (rest.length !== 2) {
      scope.errors.push(`${where}: "{{${ref}}}" debe tener la forma {{steps.<id>.<campo>}}.`)
      return
    }
    const kind = scope.visible.get(rest[0])
    if (!kind) {
      scope.errors.push(
        scope.phase === 'apply'
          ? `${where}: "{{${ref}}}" no es visible -- en "apply" solo se pueden usar resultados de pasos de "discover" (nunca de otro paso de "apply": su resultado no se puede conocer antes de aprobar). Si hace falta leerlo antes, movelo a "discover".`
          : `${where}: "{{${ref}}}" no es visible -- solo se pueden usar pasos ANTERIORES de "discover".`
      )
      return
    }
    if (!FIELDS_BY_KIND[kind].has(rest[1])) {
      scope.errors.push(`${where}: el paso "${rest[0]}" no tiene el campo "${rest[1]}" (campos: ${[...FIELDS_BY_KIND[kind]].join(', ')}).`)
    }
    return
  }
  if (!scope.asNames.has(root)) {
    scope.errors.push(`${where}: "{{${ref}}}" no empieza con input, steps ni con la variable de un foreach en curso.`)
  }
}

function validateTemplate(value: unknown, scope: ValidationScope, where: string): void {
  if (typeof value !== 'string') {
    scope.errors.push(`${where}: debe ser un string.`)
    return
  }
  for (const match of value.matchAll(REF_RE)) validateReference(match[1], scope, where)
  const leftover = value.replace(REF_RE, '')
  if (leftover.includes('{{') || leftover.includes('}}')) {
    scope.errors.push(`${where}: llaves {{ }} desbalanceadas o anidadas.`)
  }
}

function validateCondition(raw: unknown, scope: ValidationScope, where: string): void {
  if (!isRecord(raw)) {
    scope.errors.push(`${where}: debe ser un objeto {field, op, value}.`)
    return
  }
  const field = raw.field
  if (typeof field !== 'string' || !SINGLE_REF_RE.test(field.trim())) {
    scope.errors.push(`${where}.field: debe ser UNA sola referencia, por ejemplo "{{f.name}}".`)
  } else {
    validateTemplate(field, scope, `${where}.field`)
  }
  if (typeof raw.op !== 'string' || !CONDITION_OPS.has(raw.op)) {
    scope.errors.push(`${where}.op: debe ser uno de ${[...CONDITION_OPS].join(', ')}.`)
  }
  if (typeof raw.value !== 'string') {
    scope.errors.push(`${where}.value: debe ser un string literal.`)
  } else if (raw.value.includes('{{')) {
    // Deliberado: comparar contra otro valor dinamico permitiria reconstruir logica arbitraria encadenando ifs.
    scope.errors.push(`${where}.value: debe ser un LITERAL, nunca una referencia {{ }}.`)
  } else if ((raw.op === 'gt' || raw.op === 'lt') && !Number.isFinite(Number(raw.value))) {
    scope.errors.push(`${where}.value: "${raw.op}" compara numeros, el valor tiene que ser numerico.`)
  }
}

/** Devuelve el peor caso de llamadas reales que produce la lista de pasos. */
function validateSteps(raw: unknown, scope: ValidationScope, where: string): number {
  if (!Array.isArray(raw)) {
    scope.errors.push(`${where}: debe ser una lista de pasos.`)
    return 0
  }
  // `visible` es propio de ESTE nivel: los hermanos de discover se ven entre si; lo de adentro de un foreach no
  // se filtra hacia afuera (solo via los registros de `items` del foreach).
  const visible = new Map(scope.visible)
  let total = 0
  raw.forEach((step, index) => {
    const at = `${where}[${index}]`
    if (!isRecord(step)) {
      scope.errors.push(`${at}: cada paso debe ser un objeto.`)
      return
    }
    const id = step.id
    if (typeof id !== 'string' || !IDENT_RE.test(id) || RESERVED_ROOTS.has(id)) {
      scope.errors.push(`${at}.id: identificador invalido.`)
      return
    }
    if (scope.allIds.has(id)) scope.errors.push(`${at}.id: "${id}" repetido (los ids son unicos en toda la receta).`)
    scope.allIds.add(id)
    const stepScope: ValidationScope = { ...scope, visible }
    const hasTool = step.tool !== undefined
    const hasForeach = step.foreach !== undefined
    if (hasTool === hasForeach) {
      scope.errors.push(`${at}: cada paso tiene exactamente uno de "tool" o "foreach".`)
      return
    }
    const known = hasTool ? ['id', 'tool', 'args', 'if'] : ['id', 'foreach', 'steps']
    for (const key of Object.keys(step)) {
      if (!known.includes(key)) scope.errors.push(`${at}: campo desconocido "${key}".`)
    }
    if (hasTool && step.if !== undefined) validateCondition(step.if, stepScope, `${at}.if`)

    if (hasTool) {
      const tool = step.tool
      if (typeof tool !== 'string' || !tool) {
        scope.errors.push(`${at}.tool: debe ser el nombre de una tool real.`)
        return
      }
      const args = step.args === undefined ? {} : step.args
      if (!isRecord(args)) {
        scope.errors.push(`${at}.args: debe ser un objeto {parametro: "valor"}.`)
        return
      }
      for (const [key, value] of Object.entries(args)) validateTemplate(value, stepScope, `${at}.args.${key}`)

      if (tool.startsWith(COMPOSED_TOOL_PREFIX)) {
        const childName = tool.slice(COMPOSED_TOOL_PREFIX.length)
        total += validateNestedRecipe(childName, args, scope, at)
        if (scope.phase === 'discover') visible.set(id, 'text')
        return
      }
      const params = scope.env.toolParams.get(tool)
      if (!params) {
        scope.errors.push(`${at}.tool: "${tool}" no existe en el catalogo real de tools.`)
        return
      }
      if (RECIPE_EXCLUDED_TOOLS.has(tool)) {
        scope.errors.push(`${at}.tool: "${tool}" no se puede usar dentro de una receta.`)
        return
      }
      if (scope.phase === 'discover' && !scope.env.discoveryTools.has(tool)) {
        scope.errors.push(`${at}.tool: "${tool}" no es de solo lectura -- en "discover" solo: ${[...scope.env.discoveryTools].join(', ')}.`)
        return
      }
      for (const key of Object.keys(args)) {
        if (!params.properties.has(key)) scope.errors.push(`${at}.args: "${tool}" no tiene el parametro "${key}".`)
      }
      for (const required of params.required) {
        if (!(required in args)) scope.errors.push(`${at}.args: falta el parametro obligatorio "${required}" de "${tool}".`)
      }
      total += 1
      if (scope.phase === 'discover') visible.set(id, kindForTool(tool))
      return
    }

    const foreach = step.foreach
    if (!isRecord(foreach)) {
      scope.errors.push(`${at}.foreach: debe ser un objeto {in, as, maxIterations, where?}.`)
      return
    }
    if (scope.foreachDepth + 1 > MAX_FOREACH_DEPTH) {
      scope.errors.push(`${at}.foreach: maximo ${MAX_FOREACH_DEPTH} niveles de foreach anidados.`)
      return
    }
    const inRef = typeof foreach.in === 'string' ? SINGLE_REF_RE.exec(foreach.in.trim()) : null
    if (!inRef || !inRef[1].endsWith('.items')) {
      scope.errors.push(`${at}.foreach.in: debe ser UNA referencia a una lista, por ejemplo "{{steps.lista.items}}".`)
    } else {
      validateTemplate(foreach.in, stepScope, `${at}.foreach.in`)
    }
    const asName = foreach.as
    if (typeof asName !== 'string' || !IDENT_RE.test(asName) || RESERVED_ROOTS.has(asName) || scope.asNames.has(asName)) {
      scope.errors.push(`${at}.foreach.as: nombre de variable invalido o ya usado.`)
      return
    }
    const max = foreach.maxIterations
    if (typeof max !== 'number' || !Number.isInteger(max) || max < 1 || max > MAX_FOREACH_ITERATIONS) {
      scope.errors.push(`${at}.foreach.maxIterations: entero entre 1 y ${MAX_FOREACH_ITERATIONS} (obligatorio -- ningun bucle es "hasta que").`)
      return
    }
    const bodyScope: ValidationScope = {
      ...scope,
      visible,
      asNames: new Set([...scope.asNames, asName]),
      foreachDepth: scope.foreachDepth + 1
    }
    if (foreach.where !== undefined) validateCondition(foreach.where, bodyScope, `${at}.foreach.where`)
    if (!Array.isArray(step.steps) || step.steps.length === 0) {
      scope.errors.push(`${at}.steps: un foreach necesita al menos un paso adentro.`)
      return
    }
    total += max * validateSteps(step.steps, bodyScope, `${at}.steps`)
    if (scope.phase === 'discover') visible.set(id, 'records')
  })
  return total
}

function validateNestedRecipe(childName: string, args: Record<string, unknown>, scope: ValidationScope, at: string): number {
  if (scope.chain.includes(childName)) {
    scope.errors.push(`${at}.tool: ciclo de recetas (${[...scope.chain, childName].join(' -> ')}).`)
    return 0
  }
  const child = scope.env.loadRecipe(childName)
  if (!child) {
    scope.errors.push(`${at}.tool: no existe una herramienta compuesta aprobada "${COMPOSED_TOOL_PREFIX}${childName}".`)
    return 0
  }
  // Sin reordenamiento oculto: una receta hija solo puede ser "pura" para la seccion donde se usa. Si una hija con
  // discover estuviera en el apply del padre, sus lecturas correrian ANTES de los efectos anteriores del padre.
  if (scope.phase === 'discover' && child.apply.length > 0) {
    scope.errors.push(`${at}.tool: "${COMPOSED_TOOL_PREFIX}${childName}" tiene efectos ("apply") -- no puede ir en "discover".`)
    return 0
  }
  if (scope.phase === 'apply' && child.discover.length > 0) {
    scope.errors.push(`${at}.tool: "${COMPOSED_TOOL_PREFIX}${childName}" tiene lecturas previas ("discover") -- dentro de "apply" solo recetas sin "discover" (sus lecturas correrian antes de los efectos anteriores de esta receta).`)
    return 0
  }
  const declared = new Set(child.inputs.map(input => input.name))
  for (const key of Object.keys(args)) {
    if (!declared.has(key)) scope.errors.push(`${at}.args: "${COMPOSED_TOOL_PREFIX}${childName}" no tiene el input "${key}".`)
  }
  for (const name of declared) {
    if (!(name in args)) scope.errors.push(`${at}.args: falta el input "${name}" de "${COMPOSED_TOOL_PREFIX}${childName}".`)
  }
  const childResult = validateRecipeInternal(child, scope.env, [...scope.chain, childName])
  if (!childResult.ok) {
    scope.errors.push(`${at}.tool: la receta anidada "${childName}" ya no es valida: ${childResult.errors[0]}`)
    return 0
  }
  scope.childDepth.max = Math.max(scope.childDepth.max, childResult.depth)
  return scope.phase === 'discover' ? childResult.worstCaseDiscoveryCalls : childResult.worstCaseEffectCalls
}

function validateRecipeInternal(raw: unknown, env: RecipeValidationEnv, chain: readonly string[]): RecipeValidationResult {
  const errors: string[] = []
  const fail = (): RecipeValidationResult => ({ ok: false, errors, depth: 0, worstCaseDiscoveryCalls: 0, worstCaseEffectCalls: 0 })
  if (!isRecord(raw)) {
    errors.push('La receta debe ser un objeto.')
    return fail()
  }
  if (typeof raw.name !== 'string' || !NAME_RE.test(raw.name)) {
    errors.push('"name": snake_case en minusculas, 2 a 41 caracteres (ej. "contar_lineas_py").')
  }
  if (typeof raw.description !== 'string' || !raw.description.trim() || raw.description.length > 500) {
    errors.push('"description": texto no vacio, maximo 500 caracteres.')
  }
  const inputNames = new Set<string>()
  if (!Array.isArray(raw.inputs) || raw.inputs.length > 10) {
    errors.push('"inputs": lista de hasta 10 objetos {name, description}.')
  } else {
    raw.inputs.forEach((input, index) => {
      if (!isRecord(input) || typeof input.name !== 'string' || !IDENT_RE.test(input.name) || typeof input.description !== 'string') {
        errors.push(`inputs[${index}]: debe ser {name: identificador, description: texto}.`)
        return
      }
      if (inputNames.has(input.name)) errors.push(`inputs[${index}]: "${input.name}" repetido.`)
      inputNames.add(input.name)
    })
  }
  if (errors.length > 0) return fail()

  const allIds = new Set<string>()
  const childDepth = { max: 0 }
  const base = { inputs: inputNames, asNames: new Set<string>(), foreachDepth: 0, allIds, errors, env, chain, childDepth }
  const discoverScope: ValidationScope = { ...base, phase: 'discover', visible: new Map() }
  const worstCaseDiscoveryCalls = validateSteps(raw.discover, discoverScope, 'discover')
  // Visibilidad para `apply`: SOLO los pasos de primer nivel de discover (reconstruida igual que validateSteps).
  const discoverVisible = new Map<string, StepKind>()
  if (Array.isArray(raw.discover)) {
    for (const step of raw.discover) {
      if (!isRecord(step) || typeof step.id !== 'string') continue
      if (step.foreach !== undefined) discoverVisible.set(step.id, 'records')
      else if (typeof step.tool === 'string') {
        discoverVisible.set(step.id, step.tool.startsWith(COMPOSED_TOOL_PREFIX) ? 'text' : kindForTool(step.tool))
      }
    }
  }
  const applyScope: ValidationScope = { ...base, phase: 'apply', visible: discoverVisible }
  const worstCaseEffectCalls = validateSteps(raw.apply, applyScope, 'apply')

  const depth = 1 + childDepth.max
  if (depth > MAX_RECIPE_NESTING) {
    errors.push(`Anidamiento de recetas: profundidad ${depth}, el maximo es ${MAX_RECIPE_NESTING} (receta -> hija -> nieta).`)
  }
  if (worstCaseDiscoveryCalls > MAX_DISCOVERY_CALLS) {
    errors.push(`Peor caso de lecturas por corrida: ${worstCaseDiscoveryCalls}, el maximo es ${MAX_DISCOVERY_CALLS} -- baja los maxIterations.`)
  }
  if (worstCaseEffectCalls > MAX_EFFECT_CALLS) {
    errors.push(`Peor caso de acciones por corrida: ${worstCaseEffectCalls}, el maximo es ${MAX_EFFECT_CALLS} -- baja los maxIterations.`)
  }
  if (errors.length > 0) return fail()
  return { ok: true, errors, depth, worstCaseDiscoveryCalls, worstCaseEffectCalls }
}

export function validateRecipe(raw: unknown, env: RecipeValidationEnv): RecipeValidationResult {
  const name = isRecord(raw) && typeof raw.name === 'string' ? raw.name : ''
  return validateRecipeInternal(raw, env, name ? [name] : [])
}

/** Texto de ayuda devuelto al modelo cuando una propuesta es invalida -- la descripcion compacta del catalogo de
 *  DeepSeek PWA solo muestra la primera oracion, asi que el formato completo viaja aca. */
export const RECIPE_FORMAT_GUIDE = `Formato de propose_composed_tool (inputs/discover/apply son JSON, como string o como lista):
- name: snake_case (ej. "contar_lineas_py"); description: texto.
- inputs: [{"name":"carpeta","description":"Carpeta a revisar"}]
- discover: pasos de SOLO LECTURA (list_dir, read_file, search_files, git_status, git_diff) -- corren antes de pedir aprobacion.
- apply: pasos con efectos -- corren despues de UNA aprobacion por corrida, con el alcance real ya resuelto. Pueden usar resultados de discover, nunca de otro paso de apply.
- Paso: {"id":"lista","tool":"list_dir","args":{"path":"{{input.carpeta}}"}} (args siempre strings).
- Iterar: {"id":"leer","foreach":{"in":"{{steps.lista.items}}","as":"f","maxIterations":20,"where":{"field":"{{f.name}}","op":"endsWith","value":".py"}},"steps":[{"id":"leido","tool":"read_file","args":{"path":"{{f.path}}"}}]}
- Referencias: {{input.X}}, {{steps.ID.output|ok|items|lines}}, {{VAR.campo}} dentro de un foreach. En apply, iterando los registros de un foreach de discover: {{r.item.path}}, {{r.leido.output}}.
- Items de list_dir: {type, name, path}; search_files: {path, line, text}; git_status: {status, path}. read_file expone lines y chars.
- Condicion (if en un paso, where en un foreach): {"field":"{{f.name}}","op":"eq|neq|contains|startsWith|endsWith|gt|lt","value":"literal"}.
- Maximo ${MAX_FOREACH_DEPTH} foreach anidados, ${MAX_FOREACH_ITERATIONS} iteraciones por foreach, ${MAX_EFFECT_CALLS} acciones y ${MAX_DISCOVERY_CALLS} lecturas por corrida, ${MAX_RECIPE_NESTING} niveles de recetas anidadas.`

/** Acepta inputs/discover/apply como JSON en string (protocolo de texto de DeepSeek PWA, o el schema nativo, que
 *  los declara como string) o ya parseados. */
export function normalizeProposal(args: Record<string, unknown>): { ok: true; recipe: Record<string, unknown> } | { ok: false; error: string } {
  const recipe: Record<string, unknown> = { name: args.name, description: args.description }
  for (const key of ['inputs', 'discover', 'apply'] as const) {
    const value = args[key]
    if (typeof value === 'string') {
      try {
        recipe[key] = value.trim() ? JSON.parse(value) : []
      } catch (error) {
        return { ok: false, error: `"${key}" no es JSON valido: ${error instanceof Error ? error.message : String(error)}` }
      }
    } else {
      recipe[key] = value === undefined ? [] : value
    }
  }
  return { ok: true, recipe }
}

// ---------------------------------------------------------------------------------------------------------------
// Plantillas y condiciones en tiempo de ejecucion -- nunca eval(): solo busqueda de campos propios de objetos.

export type RuntimeScope = Record<string, unknown>

function lookupPath(ref: string, scope: RuntimeScope): unknown {
  let current: unknown = scope
  for (const segment of ref.split('.')) {
    if (!isRecord(current) || !Object.prototype.hasOwnProperty.call(current, segment)) return undefined
    current = current[segment]
  }
  return current
}

export function resolveReference(template: string, scope: RuntimeScope): { ok: true; value: unknown } | { ok: false; error: string } {
  const match = SINGLE_REF_RE.exec(template.trim())
  if (!match) return { ok: false, error: `"${template}" no es una referencia simple.` }
  const value = lookupPath(match[1], scope)
  if (value === undefined) return { ok: false, error: `la referencia "{{${match[1]}}}" no resolvio a ningun valor.` }
  return { ok: true, value }
}

function stringifyValue(value: unknown): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return JSON.stringify(value)
}

export function renderTemplate(template: string, scope: RuntimeScope): { ok: true; value: string } | { ok: false; error: string } {
  let failure: string | null = null
  const value = template.replace(REF_RE, (_whole, ref: string) => {
    const resolved = lookupPath(ref, scope)
    if (resolved === undefined) {
      failure ??= `la referencia "{{${ref}}}" no resolvio a ningun valor.`
      return ''
    }
    return stringifyValue(resolved)
  })
  return failure ? { ok: false, error: failure } : { ok: true, value }
}

export function renderArgs(args: Record<string, string> | undefined, scope: RuntimeScope): { ok: true; args: Record<string, string> } | { ok: false; error: string } {
  const out: Record<string, string> = {}
  for (const [key, template] of Object.entries(args ?? {})) {
    const rendered = renderTemplate(template, scope)
    if (!rendered.ok) return { ok: false, error: `argumento "${key}": ${rendered.error}` }
    out[key] = rendered.value
  }
  return { ok: true, args: out }
}

export function evaluateCondition(condition: RecipeCondition, scope: RuntimeScope): { ok: true; value: boolean } | { ok: false; error: string } {
  const resolved = resolveReference(condition.field, scope)
  if (!resolved.ok) return resolved
  const actual = stringifyValue(resolved.value)
  switch (condition.op) {
    case 'eq': return { ok: true, value: actual === condition.value }
    case 'neq': return { ok: true, value: actual !== condition.value }
    case 'contains': return { ok: true, value: actual.includes(condition.value) }
    case 'startsWith': return { ok: true, value: actual.startsWith(condition.value) }
    case 'endsWith': return { ok: true, value: actual.endsWith(condition.value) }
    case 'gt':
    case 'lt': {
      const left = Number(actual)
      if (!Number.isFinite(left)) return { ok: false, error: `"${condition.field}" vale "${actual}", no es un numero.` }
      const right = Number(condition.value)
      return { ok: true, value: condition.op === 'gt' ? left > right : left < right }
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Adaptadores fijos de salida de las tools de descubrimiento: texto plano -> datos contables. Escritos y revisados
// como codigo de Amatista, nunca provistos por la receta ni por el modelo.

const CLIP_MARKER = '[salida recortada]'
/** Mismo tope real de search_files (SEARCH_FILES_MAX_MATCHES, tool-registry.ts) -- ver adaptSearchFiles(). */
export const SEARCH_FILES_CAP = 200

export type AdaptedOutput = { ok: true; fields: Record<string, unknown> } | { ok: false; error: string }

function joinPosix(base: string, name: string): string {
  const clean = base.replace(/\\/g, '/').replace(/\/+$/, '')
  return !clean || clean === '.' ? name : `${clean}/${name}`
}

function adaptListDir(args: Record<string, string>, output: string): AdaptedOutput {
  if (output.trim() === '(directorio vacio)') return { ok: true, fields: { items: [] } }
  // Formato real (tool-registry.ts, case 'list_dir'): "dir   nombre" / "file  nombre" -- ambos prefijos miden 6.
  const items = output.split('\n').filter(line => line.trim()).map(line => {
    const type = line.startsWith('dir ') ? 'dir' : 'file'
    const name = line.slice(6)
    return { type, name, path: joinPosix(args.path ?? '.', name) }
  })
  items.sort((a, b) => a.name.localeCompare(b.name))
  return { ok: true, fields: { items } }
}

function adaptSearchFiles(output: string): AdaptedOutput {
  if (output.trim() === 'Sin resultados.') return { ok: true, fields: { items: [] } }
  if (output.includes('se alcanzo el tope de')) {
    return { ok: false, error: `search_files corto la busqueda en su tope de ${SEARCH_FILES_CAP} coincidencias -- el alcance real no se puede conocer completo; acota "path" o "pattern".` }
  }
  const items: Array<{ path: string; line: number; text: string }> = []
  for (const line of output.split('\n')) {
    const match = /^(.+?):(\d+):(.*)$/.exec(line)
    if (match) items.push({ path: match[1], line: Number(match[2]), text: match[3] })
  }
  // Hallazgo real: el fallback manual (searchFilesManually) se detiene EN el tope sin agregar el aviso (el aviso
  // solo aparece con MAS de 200) -- exactamente 200 se trata como posiblemente recortado.
  if (items.length >= SEARCH_FILES_CAP) {
    return { ok: false, error: `search_files devolvio ${items.length} coincidencias (su tope) -- puede haber mas; acota "path" o "pattern".` }
  }
  return { ok: true, fields: { items } }
}

function adaptGitStatus(output: string): AdaptedOutput {
  const items: Array<{ status: string; path: string }> = []
  for (const line of output.split('\n')) {
    if (!line.trim() || line.startsWith('##') || line.trim() === '(sin cambios)') continue
    const status = line.slice(0, 2).trim()
    let file = line.slice(3)
    const arrow = file.indexOf(' -> ')
    if (arrow >= 0) file = file.slice(arrow + 4)
    if (file.startsWith('"') && file.endsWith('"')) file = file.slice(1, -1)
    items.push({ status, path: file })
  }
  return { ok: true, fields: { items } }
}

function countLines(content: string): number {
  if (!content) return 0
  const lines = content.split('\n').length
  return content.endsWith('\n') ? lines - 1 : lines
}

export function adaptDiscoveryOutput(tool: string, args: Record<string, string>, output: string): AdaptedOutput {
  if (output.includes(CLIP_MARKER)) {
    return { ok: false, error: `la salida de ${tool} vino recortada ("${CLIP_MARKER}") -- el alcance real no se puede conocer completo; acota la ruta.` }
  }
  switch (tool) {
    case 'list_dir': return adaptListDir(args, output)
    case 'search_files': return adaptSearchFiles(output)
    case 'git_status': return adaptGitStatus(output)
    case 'read_file': return { ok: true, fields: { lines: countLines(output), chars: output.length } }
    default: return { ok: true, fields: {} }
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Plan congelado + grant de UN SOLO USO por corrida.

export type CallCoverage = 'run-grant' | 'hard-confirm' | 'individual'

export interface PlannedCall {
  index: number
  tool: string
  args: Record<string, string>
  coverage: CallCoverage
  origin: string
  fingerprint: string
  /** Lo que la tool real va a pasarle a confirm() -- el grant solo responde si coincide EXACTO. */
  expectedTitle?: string
  expectedDetail?: string
  /** Ruta absoluta (ya confinada) del archivo destino + huella de su contenido al armar el plan. */
  targetPath?: string
  expectedTargetHash?: string
  stats?: { added: number; removed: number }
}

export function coverageForTool(tool: string): CallCoverage {
  if (RUN_GRANT_TOOLS.has(tool)) return 'run-grant'
  if (HARD_CONFIRM_TOOLS.has(tool)) return 'hard-confirm'
  return 'individual'
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

export function fingerprintCall(index: number, tool: string, args: Record<string, string>): string {
  return createHash('sha256').update(canonicalJson({ index, tool, args })).digest('hex')
}

export function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const key of Object.keys(value as object)) deepFreeze((value as Record<string, unknown>)[key])
  }
  return value
}

type ConfirmFn = (title: string, detail: string) => Promise<boolean>

/**
 * Aprobacion de UNA corrida puntual de una receta. Vive solo como variable local del ejecutor (nunca en la sesion,
 * nunca en disco) y se revoca en su finally. Responde a lo sumo UNA vez por llamada del plan aprobado, y solo si el
 * confirm() que recibe es exactamente el que se previo (titulo + detalle) y el archivo destino sigue con la misma
 * huella que cuando se armo el plan. Cualquier otra cosa cae al dialogo real de siempre (`fallback`).
 */
export class RecipeRunGrant {
  private armedFor: string | null = null
  private readonly consumed = new Set<string>()
  private readonly approved: ReadonlySet<string>
  private revoked = false
  readonly lostCoverage: Array<{ index: number; reason: string }> = []

  constructor(
    readonly runId: string,
    calls: readonly PlannedCall[],
    private readonly targetHashNow: (absPath: string) => string
  ) {
    this.approved = new Set(calls.filter(call => call.coverage === 'run-grant').map(call => call.fingerprint))
  }

  confirmFor(call: PlannedCall, fallback: ConfirmFn): ConfirmFn {
    if (this.revoked || this.consumed.has(call.fingerprint) || !this.approved.has(call.fingerprint)) return fallback
    this.armedFor = call.fingerprint
    return async (title, detail) => {
      // SINCRONICO hasta el return: corre en el MISMO tramo del event loop en el que la tool acaba de leer el disco
      // (write_file/apply_patch/revert_file leen el destino y llaman a resolveApproval() sin ningun await entre
      // medio), asi que la huella de abajo es la del contenido que la tool va a pisar.
      if (this.revoked || this.armedFor !== call.fingerprint) return fallback(title, detail)
      this.armedFor = null
      let reason: string | null = null
      if (title !== call.expectedTitle || detail !== call.expectedDetail) {
        reason = 'la accion que pidio aprobacion no coincide exactamente con la del plan aprobado'
      } else if (call.targetPath !== undefined && this.targetHashNow(call.targetPath) !== call.expectedTargetHash) {
        reason = 'el archivo cambio en disco despues de armar el plan'
      }
      if (reason) {
        this.lostCoverage.push({ index: call.index, reason })
        return fallback(title, detail)
      }
      this.consumed.add(call.fingerprint)
      return true
    }
  }

  disarm(): void {
    this.armedFor = null
  }

  revoke(): void {
    this.revoked = true
    this.armedFor = null
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Almacenamiento por workspace (<workspace>/.amatista/composed-tools/<name>.json), firmado con HMAC.
//
// Hueco real encontrado al implementar: la receta aprobada queda como JSON DENTRO del workspace, asi que un
// write_file comun podria modificarla despues sin pasar por la aprobacion de creacion. La firma usa una clave
// guardada en el directorio de datos de la app (fuera de cualquier workspace), que ninguna tool confinada al
// workspace puede leer -- una receta editada fuera del flujo de aprobacion no aparece en el catalogo ni corre.

const RECIPES_SUBDIR = ['.amatista', 'composed-tools']

let cachedKey: Buffer | null = null
function signingKey(): Buffer {
  if (cachedKey) return cachedKey
  const keyPath = path.join(getAppDataSubdir('config'), 'composed-tools.key')
  if (existsSync(keyPath)) {
    cachedKey = Buffer.from(readFileSync(keyPath, 'utf8').trim(), 'hex')
  } else {
    cachedKey = randomBytes(32)
    writeFileSync(keyPath, cachedKey.toString('hex'), { encoding: 'utf8', mode: 0o600 })
  }
  return cachedKey
}

function signRecipe(recipe: ComposedRecipe): string {
  return createHmac('sha256', signingKey()).update(canonicalJson(recipe)).digest('hex')
}

function recipeFromStored(stored: Record<string, unknown>): ComposedRecipe {
  return {
    version: 1,
    name: stored.name as string,
    description: stored.description as string,
    inputs: stored.inputs as RecipeInput[],
    discover: stored.discover as RecipeStep[],
    apply: stored.apply as RecipeStep[],
    createdAt: stored.createdAt as string,
    approvedAt: stored.approvedAt as string
  }
}

export function recipesDir(workspace: string): string {
  return path.join(workspace, ...RECIPES_SUBDIR)
}

function recipePath(workspace: string, name: string): string | null {
  return NAME_RE.test(name) ? path.join(recipesDir(workspace), `${name}.json`) : null
}

export function recipeExists(workspace: string, name: string): boolean {
  const file = recipePath(workspace, name)
  return file !== null && existsSync(file)
}

export function loadStoredRecipe(workspace: string, name: string): { ok: true; recipe: ComposedRecipe } | { ok: false; error: string } {
  const file = recipePath(workspace, name)
  if (!file || !existsSync(file)) return { ok: false, error: `No existe la herramienta compuesta "${COMPOSED_TOOL_PREFIX}${name}" en este workspace.` }
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return { ok: false, error: `La herramienta compuesta "${name}" esta corrupta (JSON invalido).` }
  }
  if (!isRecord(parsed) || typeof parsed.signature !== 'string' || parsed.name !== name) {
    return { ok: false, error: `La herramienta compuesta "${name}" no tiene una firma de aprobacion valida.` }
  }
  const recipe = recipeFromStored(parsed)
  const expected = Buffer.from(signRecipe(recipe), 'hex')
  const actual = Buffer.from(parsed.signature, 'hex')
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    return { ok: false, error: `La herramienta compuesta "${name}" fue modificada fuera del flujo de aprobacion -- no se ejecuta. Borrala y volve a proponerla.` }
  }
  return { ok: true, recipe }
}

export function saveRecipe(workspace: string, recipe: ComposedRecipe): string {
  const file = recipePath(workspace, recipe.name)
  if (!file) throw new Error(`Nombre de herramienta compuesta invalido: ${recipe.name}`)
  mkdirSync(path.dirname(file), { recursive: true })
  const stored: StoredRecipe = { ...recipe, signature: signRecipe(recipe) }
  const tmp = `${file}.tmp-${process.pid}`
  writeFileSync(tmp, `${JSON.stringify(stored, null, 2)}\n`, 'utf8')
  renameSync(tmp, file)
  return file
}

export function listStoredRecipes(workspace: string): ComposedRecipe[] {
  const dir = recipesDir(workspace)
  if (!workspace || !existsSync(dir)) return []
  const recipes: ComposedRecipe[] = []
  for (const entry of readdirSync(dir)) {
    if (!entry.endsWith('.json')) continue
    const loaded = loadStoredRecipe(workspace, entry.slice(0, -'.json'.length))
    if (loaded.ok) recipes.push(loaded.recipe)
  }
  return recipes.sort((a, b) => a.name.localeCompare(b.name))
}

/** Catalogo: una tool "composed__<name>" por receta aprobada (y con firma valida) del workspace. Leido fresco en
 *  cada llamada -- es un directorio + JSON.parse, barato, mismo criterio de frescura que planModeActive. */
export function listComposedToolDefinitions(workspace: string | undefined): ToolDefinition[] {
  if (!workspace) return []
  return listStoredRecipes(workspace).map(recipe => ({
    name: `${COMPOSED_TOOL_PREFIX}${recipe.name}`,
    description:
      `Herramienta compuesta (receta aprobada por el usuario): ${recipe.description} ` +
      'Primero lee (solo lectura) y despues, si hay acciones con efectos, pide UNA aprobacion con el alcance real antes de cambiar nada.',
    parameters: {
      type: 'object',
      properties: Object.fromEntries(recipe.inputs.map(input => [input.name, { type: 'string', description: input.description }])),
      required: recipe.inputs.map(input => input.name)
    }
  }))
}

// ---------------------------------------------------------------------------------------------------------------
// Texto legible (dialogo de creacion) -- nunca JSON crudo.

const STEP_LABELS: Record<string, (args: Record<string, string>) => string> = {
  list_dir: args => `Lista la carpeta ${args.path ?? '.'}`,
  read_file: args => `Lee ${args.path}`,
  search_files: args => `Busca "${args.pattern}"${args.path ? ` en ${args.path}` : ''}`,
  git_status: () => 'Consulta git status',
  git_diff: () => 'Consulta git diff',
  write_file: args => `Escribe el archivo ${args.path}`,
  apply_patch: args => `Edita ${args.path}`,
  run_command: args => `Ejecuta el comando: ${args.command}`,
  revert_file: args => `Restaura ${args.path} a la version ${args.ref}`,
  close_app: args => `Cierra la aplicacion ${args.name}`,
  lock_screen: () => 'Bloquea la sesion de Windows',
  power: args => `Energia: ${args.action}`
}

export function describeCall(tool: string, args: Record<string, string>): string {
  const label = STEP_LABELS[tool]
  if (label) return label(args)
  const summary = Object.entries(args).map(([key, value]) => `${key}=${value.length > 60 ? `${value.slice(0, 57)}...` : value}`).join(', ')
  return `${tool}(${summary})`
}

function coverageNote(tool: string): string {
  if (tool.startsWith(COMPOSED_TOOL_PREFIX)) return ''
  const coverage = coverageForTool(tool)
  if (coverage === 'run-grant') return '  [cubierta por la aprobacion de cada corrida]'
  if (coverage === 'hard-confirm') return '  [te pregunta aparte, SIEMPRE]'
  return ''
}

function describeSteps(steps: RecipeStep[], indent: string, numbering: string, lines: string[]): void {
  steps.forEach((step, index) => {
    const number = `${numbering}${index + 1}`
    if (step.foreach) {
      const filter = step.foreach.where ? ` cuyo ${step.foreach.where.field} ${step.foreach.where.op} "${step.foreach.where.value}"` : ''
      lines.push(`${indent}${number}. Para cada elemento de ${step.foreach.in}${filter} (hasta ${step.foreach.maxIterations}), como ${step.foreach.as}:`)
      describeSteps(step.steps ?? [], `${indent}   `, `${number}.`, lines)
      return
    }
    const condition = step.if ? ` (solo si ${step.if.field} ${step.if.op} "${step.if.value}")` : ''
    const tool = step.tool ?? ''
    const text = tool.startsWith(COMPOSED_TOOL_PREFIX)
      ? `Corre la herramienta compuesta ${tool}(${Object.entries(step.args ?? {}).map(([k, v]) => `${k}=${v}`).join(', ')})`
      : describeCall(tool, step.args ?? {})
    lines.push(`${indent}${number}. ${text}${condition}${coverageNote(tool)}`)
  })
}

export function describeRecipeForCreation(recipe: Pick<ComposedRecipe, 'name' | 'description' | 'inputs' | 'discover' | 'apply'>, validation: RecipeValidationResult): string {
  const lines: string[] = [
    `Herramienta nueva: ${COMPOSED_TOOL_PREFIX}${recipe.name}`,
    `Para que sirve: ${recipe.description}`,
    `Entradas: ${recipe.inputs.length ? recipe.inputs.map(input => `${input.name} (${input.description})`).join(', ') : 'ninguna'}`,
    '',
    'Cada vez que se use, primero SOLO LEE (sin preguntarte, sin cambiar nada):'
  ]
  if (recipe.discover.length) describeSteps(recipe.discover, '  ', '', lines)
  else lines.push('  (nada)')
  lines.push('', 'Despues, con UNA aprobacion tuya por corrida (mostrando el alcance real, archivo por archivo):')
  if (recipe.apply.length) describeSteps(recipe.apply, '  ', '', lines)
  else lines.push('  (nada -- esta herramienta solo lee)')
  lines.push(
    '',
    `Peor caso por corrida: hasta ${validation.worstCaseDiscoveryCalls} lecturas y ${validation.worstCaseEffectCalls} acciones con efectos.`,
    '',
    'Aprobar esto SOLO guarda la herramienta y la deja disponible. No aprueba ninguna corrida: cada vez que se use,',
    'primero se hace la parte de lectura y despues te muestro exactamente que va a tocar ESA corrida, para que la',
    'apruebes (o no) antes de que cambie nada. Lo marcado [te pregunta aparte, SIEMPRE] pregunta por su cuenta igual.'
  )
  return lines.join('\n')
}
