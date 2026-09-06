import { DatabaseSync } from 'node:sqlite'
import path from 'node:path'
import { getAppDataSubdir } from './app-paths'
import type {
  ChatAttachment,
  ChatDatabaseSnapshot,
  ConversationRole,
  CrossWindowMeta,
  MemoryTopic,
  StoredChatMessage,
  StoredChatSession,
  TodoItem,
  TodoList
} from '../shared/types'

let database: DatabaseSync | null = null

function db(): DatabaseSync {
  if (database) return database

  const dir = getAppDataSubdir('config')
  database = new DatabaseSync(path.join(dir, 'amatista.db'))
  database.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS chat_sessions (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      workspace_path TEXT,
      workspace_name TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      provider_id TEXT,
      model_id TEXT,
      runtime TEXT
    );

    CREATE TABLE IF NOT EXISTS chat_messages (
      id TEXT PRIMARY KEY,
      chat_id TEXT NOT NULL,
      role TEXT NOT NULL,
      text TEXT NOT NULL,
      created_at TEXT NOT NULL,
      provider_id TEXT,
      model_id TEXT,
      runtime TEXT,
      FOREIGN KEY (chat_id) REFERENCES chat_sessions(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS chat_attachments (
      id TEXT PRIMARY KEY,
      message_id TEXT NOT NULL,
      name TEXT NOT NULL,
      path TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      size INTEGER NOT NULL,
      kind TEXT NOT NULL,
      preview TEXT,
      text TEXT,
      FOREIGN KEY (message_id) REFERENCES chat_messages(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_chat_messages_chat_created
      ON chat_messages(chat_id, created_at);

    CREATE INDEX IF NOT EXISTS idx_chat_attachments_message
      ON chat_attachments(message_id);
  `)

  // Migracion: chat_messages preexistentes (de antes de v0.4.9+) no tienen
  // esta columna. CREATE TABLE IF NOT EXISTS no la agrega a una tabla ya
  // creada, asi que se intenta el ALTER y se ignora el error si ya existe.
  try {
    database.exec('ALTER TABLE chat_messages ADD COLUMN tool_steps TEXT')
  } catch {
    // La columna ya existe (DB creada con este mismo esquema o migrada antes).
  }

  // Fase 3 — memoria real: resumen acumulado por chat + watermark (id de
  // chat_messages, NO posicion/indice — inmune a ediciones/borrados que
  // desplazan todo lo posterior) hasta donde ese resumen ya cubre. Mismo
  // patron de migracion ALTER + try/catch que tool_steps arriba.
  try {
    database.exec('ALTER TABLE chat_sessions ADD COLUMN summary TEXT')
  } catch {
    // La columna ya existe.
  }
  try {
    database.exec('ALTER TABLE chat_sessions ADD COLUMN summary_watermark_id TEXT')
  } catch {
    // La columna ya existe.
  }

  // Fase 6 — extraccion estructurada: decisiones/restricciones/proximos
  // pasos, acumulativos, como JSON serializado. Mismo patron de migracion
  // que las dos columnas de arriba.
  try {
    database.exec('ALTER TABLE chat_sessions ADD COLUMN structured_memory TEXT')
  } catch {
    // La columna ya existe.
  }

  // Mensajeria entre ventanas, Paso 3, Tarea 4: distincion visual de un
  // mensaje entregado via send_to_window (JSON serializado de
  // CrossWindowMeta) -- NULL para todo mensaje de un turno normal. Mismo
  // patron de migracion ALTER + try/catch que tool_steps/summary arriba.
  try {
    database.exec('ALTER TABLE chat_messages ADD COLUMN cross_window TEXT')
  } catch {
    // La columna ya existe.
  }

  // Feature "arbol de sub-chats": parent_chat_id -- id del chat de ORIGEN
  // si este chat nacio de "Agregar panel" sobre otro (NULL = raiz, nunca
  // tuvo origen real o es el primero de su grupo). Mismo patron de
  // migracion ALTER + try/catch que summary/structured_memory/cross_window
  // arriba. A proposito SIN FOREIGN KEY: borrar el padre (deleteChatSession)
  // no debe arrastrar en cascada a sus hijos -- un huerfano (parent_chat_id
  // apunta a un id que ya no existe) se trata como raiz en el render del
  // sidebar (buildChatRows(), App.tsx), no como error.
  try {
    database.exec('ALTER TABLE chat_sessions ADD COLUMN parent_chat_id TEXT')
  } catch {
    // La columna ya existe.
  }

  // Fix bug real (docs/_arch/verify_workspace_name_conflation.md): repara
  // datos YA guardados con workspace_name contaminado por el bug de
  // resolveOrCreateChatForPath() (App.tsx) -- title/workspaceName eran el
  // MISMO parametro ahi, asi que un "Agregar panel" grababa el titulo
  // COMPUESTO ("X — Panel N") como workspace_name del chat nuevo. Corre en
  // cada arranque, idempotente (una fila ya reparada deja de matchear
  // PANEL_SUFFIX_RE, no se vuelve a tocar) -- mismo espiritu que los
  // backfill de settings-store.ts (allowSubscription), aplicado aca porque
  // el dato a reparar vive en esta DB, no en settings.json.
  migrateContaminatedWorkspaceNames(database)

  // Feature "generacion de imagenes": origin -- 'generated' si este adjunto
  // salio de la tool generate_image, NULL para cualquier adjunto subido a
  // mano por el usuario (todos los preexistentes, y todo lo demas hacia
  // adelante). Mismo patron de migracion ALTER + try/catch que
  // parent_chat_id/summary/structured_memory/cross_window arriba.
  try {
    database.exec("ALTER TABLE chat_attachments ADD COLUMN origin TEXT")
  } catch {
    // La columna ya existe.
  }

  // Tool "todo_write" (docs/_arch/verify_todo_write_design.md): lista de
  // tareas del propio modelo, JSON serializado -- mismo patron de
  // migracion ALTER + try/catch y mismo criterio de reemplazo TOTAL en cada
  // llamada que ya usa structured_memory (Fase 6/11), nunca una tabla
  // separada (ningun call site real filtra/ordena por un campo interno de
  // la lista via SQL).
  try {
    database.exec('ALTER TABLE chat_sessions ADD COLUMN todos TEXT')
  } catch {
    // La columna ya existe.
  }

  return database
}

/** Ver comentario de la llamada en db() arriba. Para cada workspace_path
 *  con al menos una fila contaminada, busca un hermano del MISMO
 *  workspace_path con workspace_name limpio (la fuente de verdad real,
 *  como en el caso real encontrado: "YAYOSCHAT" limpio en un hermano,
 *  "YAYOSCHAT — Panel 2" contaminado en otro) y se lo aplica a todas las
 *  contaminadas de ese grupo. Si ningun hermano sobrevive limpio (caso
 *  borde, todo el grupo contaminado -- no reproducido, no encontrado en
 *  datos reales, pero posible), mejor esfuerzo documentado: le saca el
 *  sufijo al propio valor contaminado via PANEL_SUFFIX_RE.replace(). Nunca
 *  toca `title` ni ningun otro campo -- SOLO `workspace_name`. */
function migrateContaminatedWorkspaceNames(database: DatabaseSync): void {
  const rows = database.prepare(
    'SELECT id, workspace_path, workspace_name FROM chat_sessions'
  ).all() as Array<{ id: string; workspace_path: string | null; workspace_name: string | null }>

  const byPath = new Map<string, typeof rows>()
  for (const row of rows) {
    if (!row.workspace_path) continue
    const group = byPath.get(row.workspace_path) ?? []
    group.push(row)
    byPath.set(row.workspace_path, group)
  }

  const update = database.prepare('UPDATE chat_sessions SET workspace_name = ? WHERE id = ?')
  for (const group of byPath.values()) {
    const contaminated = group.filter(row => row.workspace_name && PANEL_SUFFIX_RE.test(row.workspace_name))
    if (contaminated.length === 0) continue
    const cleanSibling = group.find(row => row.workspace_name && !PANEL_SUFFIX_RE.test(row.workspace_name))
    for (const row of contaminated) {
      const repaired = cleanSibling ? cleanSibling.workspace_name! : row.workspace_name!.replace(PANEL_SUFFIX_RE, '')
      update.run(repaired, row.id)
    }
  }
}

function nowIso(): string {
  return new Date().toISOString()
}

function cleanOptional(value?: string): string | null {
  const clean = value?.trim()
  return clean ? clean : null
}

function parseToolSteps(value: string | null): string[] | undefined {
  if (!value) return undefined
  try {
    const parsed = JSON.parse(value) as unknown
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : undefined
  } catch {
    return undefined
  }
}

/** Mensajeria entre ventanas, Paso 3: mismo patron defensivo que
 *  parseToolSteps -- JSON invalido o con forma incorrecta se trata como
 *  "sin crossWindow" (mensaje normal), nunca lanza. */
function parseCrossWindow(value: string | null): CrossWindowMeta | undefined {
  if (!value) return undefined
  try {
    const parsed = JSON.parse(value) as unknown
    if (typeof parsed !== 'object' || parsed === null) return undefined
    const record = parsed as Record<string, unknown>
    const direction = record.direction === 'sent' || record.direction === 'received' ? record.direction : undefined
    const windowLabel = typeof record.windowLabel === 'string' ? record.windowLabel : undefined
    if (!direction || !windowLabel) return undefined
    return {
      direction,
      windowLabel,
      providerType: typeof record.providerType === 'string' ? record.providerType as CrossWindowMeta['providerType'] : undefined
    }
  } catch {
    return undefined
  }
}

/** Mensajeria entre ventanas, Paso 3, Tarea 3 (dependencia de la
 *  investigacion previa, Tarea 2/3 de esa ronda): resuelve un TITULO de
 *  chat a su chatId + ultimo provider/model reales usados en ese chat --
 *  la tool send_to_window recibe un titulo (legible para el modelo), no un
 *  id tecnico. COLLATE NOCASE = case-insensitive razonable (ASCII; SQLite
 *  sin extension ICU no pliega acentos, caveat ya documentado en la
 *  investigacion previa, sin resolver aca). `title` NO tiene constraint
 *  UNIQUE (confirmado, misma investigacion) -- con duplicados, se resuelve
 *  al MAS RECIENTE (ORDER BY updated_at DESC LIMIT 1) SIN avisar, por
 *  decision explicita del usuario: es el comportamiento natural de esta
 *  query, no logica extra agregada para desambiguar. */
export function findChatSessionByTitle(title: string): { id: string; providerId?: string; modelId?: string } | null {
  const row = db().prepare(`
    SELECT id, provider_id, model_id FROM chat_sessions
    WHERE title = ? COLLATE NOCASE
    ORDER BY updated_at DESC
    LIMIT 1
  `).get(title.trim()) as { id: string; provider_id: string | null; model_id: string | null } | undefined
  if (!row) return null
  return {
    id: row.id,
    providerId: row.provider_id ?? undefined,
    modelId: row.model_id ?? undefined
  }
}

/** Feature "Panel N" (docs/_arch/verify_panel_alias.md): sufijo ESTABLE
 *  que generateUniquePanelTitle() (App.tsx) ya graba en el titulo real al
 *  crear un chat via "Agregar panel" -- " — Panel N" (em dash, N >= 2).
 *  No es posicion visual en pantalla, es texto persistido en la columna
 *  title. Exportada para que list_windows tambien la use (mostrar el
 *  alias corto junto al titulo completo). */
const PANEL_SUFFIX_RE = /\s—\s*Panel\s+(\d+)\s*$/i

/** "Panel N" para un titulo que ya lo tiene, o null si no aplica (ni
 *  siquiera intenta decidir si ES un chat "principal" -- eso depende del
 *  resto del grupo, ver findChatSessionByPanelAlias()). */
export function panelAliasForTitle(title: string): string | null {
  const m = title.match(PANEL_SUFFIX_RE)
  return m ? `Panel ${m[1]}` : null
}

/** PIEZA 1 del orquestador (docs/_arch/verify_panel_orchestrator.md):
 *  MISMO criterio exacto que ya usa findChatSessionByPanelAlias() para
 *  resolver el alias "1"/"principal" (titulo SIN el sufijo " — Panel N"),
 *  pero consultado por `chatId` real en vez de por alias tipeado -- lo que
 *  necesita api-agent-runtime.ts al conectar: no "que chat resuelve el
 *  alias '1'", sino "es ESTE chat, el que se esta conectando ahora, el
 *  principal". Gatea send_to_window/list_windows en ApiAgentRuntime.
 *  toolCatalog() -- ver ahi. `false` si el chat no existe (id invalido o
 *  borrado): sin evidencia real de que SEA el principal, no se le da el
 *  beneficio de la duda. */
export function isPrincipalChat(chatId: string): boolean {
  const row = db().prepare('SELECT title FROM chat_sessions WHERE id = ?').get(chatId) as { title: string } | undefined
  if (!row) return false
  return panelAliasForTitle(row.title) === null
}

/** Feature "Panel N": resuelve un alias corto ("Panel 2", "panel 3", o
 *  "1"/"principal"/"panel 1") contra chats REALES del MISMO grupo que el
 *  chat de origen -- mismo criterio de agrupacion que ya usa
 *  generateUniquePanelTitle() (App.tsx) para generar el sufijo:
 *  workspacePath compartido. No toca generateUniquePanelTitle() ni el
 *  mecanismo de nombrado -- esto solo lo CONSUME, leyendo el titulo ya
 *  grabado.
 *
 *  "1"/"principal" = el chat de ESE workspace cuyo titulo NO tiene el
 *  sufijo " — Panel N" (el chat original, nunca pasado por
 *  addPanelForChat()). workspacePath no es una relacion fuerte
 *  (investigacion previa: cualquier chat sin relacion real puede
 *  compartir el mismo workspace) -- si hay mas de un candidato sin
 *  sufijo, gana el mas reciente, mismo criterio de desempate que
 *  findChatSessionByTitle().
 *
 *  Devuelve null si `alias` no matchea ninguno de los 2 patrones -- el
 *  llamador (sendToWindowByTitle) cae al camino existente de titulo
 *  exacto sin cambios. */
export function findChatSessionByPanelAlias(alias: string, workspacePath: string): { id: string; providerId?: string; modelId?: string } | null {
  const trimmed = alias.trim()
  const numberMatch = trimmed.match(/^(?:panel\s*)?(\d+)$/i)
  const isPrincipal = /^principal$/i.test(trimmed)
  if (!numberMatch && !isPrincipal) return null

  const rows = db().prepare(`
    SELECT id, title, provider_id, model_id FROM chat_sessions
    WHERE workspace_path = ?
    ORDER BY updated_at DESC
  `).all(workspacePath) as Array<{ id: string; title: string; provider_id: string | null; model_id: string | null }>

  const wantsPrincipal = isPrincipal || numberMatch![1] === '1'
  const match = wantsPrincipal
    ? rows.find(row => !PANEL_SUFFIX_RE.test(row.title))
    : rows.find(row => row.title.match(PANEL_SUFFIX_RE)?.[1] === numberMatch![1])

  if (!match) return null
  return {
    id: match.id,
    providerId: match.provider_id ?? undefined,
    modelId: match.model_id ?? undefined
  }
}

/** Fase "UI Paso 1": SELECT crudo para la tool list_windows -- sin
 *  resolucion contra settings.providers (eso vive en ipc-agent.ts, unico
 *  lugar con acceso real a `settings` sin crear un ciclo de modulos con
 *  tool-registry.ts). Mismo patron de tope que SEARCH_FILES_MAX_MATCHES
 *  (tool-registry.ts) — un usuario con muchos chats acumulados no manda
 *  todos de una, ORDER BY updated_at DESC prioriza los mas relevantes
 *  (recientes) sobre uno de hace meses. */
const WINDOW_DISCOVERY_LIMIT = 20

export interface ChatSessionForDiscovery {
  id: string
  title: string
  providerId?: string
  modelId?: string
}

export function listChatSessionsForWindowDiscovery(): ChatSessionForDiscovery[] {
  const rows = db().prepare(`
    SELECT id, title, provider_id, model_id FROM chat_sessions
    ORDER BY updated_at DESC
    LIMIT ${WINDOW_DISCOVERY_LIMIT}
  `).all() as Array<{ id: string; title: string; provider_id: string | null; model_id: string | null }>
  return rows.map(row => ({
    id: row.id,
    title: row.title,
    providerId: row.provider_id ?? undefined,
    modelId: row.model_id ?? undefined
  }))
}

export function ensureChatSession(session: {
  id: string
  title: string
  workspacePath?: string
  workspaceName?: string
  providerId?: string
  modelId?: string
  runtime?: string
  /** Feature "arbol de sub-chats": id del chat de origen, solo relevante al
   *  CREAR (addPanelForChat() lo pasa una unica vez). COALESCE en el UPDATE
   *  por consistencia con providerId/modelId/runtime -- en la practica
   *  nunca se re-pasa en una actualizacion (persistChatSessionMeta() de un
   *  chat ya existente no toca parentChatId), asi que nunca se pisa. */
  parentChatId?: string
}): StoredChatSession {
  const current = db()
  const existing = current.prepare('SELECT id FROM chat_sessions WHERE id = ?').get(session.id)
  const timestamp = nowIso()

  if (existing) {
    current.prepare(`
      UPDATE chat_sessions
      SET title = ?, workspace_path = ?, workspace_name = ?, updated_at = ?,
          provider_id = COALESCE(?, provider_id),
          model_id = COALESCE(?, model_id),
          runtime = COALESCE(?, runtime),
          parent_chat_id = COALESCE(?, parent_chat_id)
      WHERE id = ?
    `).run(
      session.title,
      cleanOptional(session.workspacePath),
      cleanOptional(session.workspaceName),
      timestamp,
      cleanOptional(session.providerId),
      cleanOptional(session.modelId),
      cleanOptional(session.runtime),
      cleanOptional(session.parentChatId),
      session.id
    )
  } else {
    current.prepare(`
      INSERT INTO chat_sessions (
        id, title, workspace_path, workspace_name, created_at, updated_at,
        provider_id, model_id, runtime, parent_chat_id
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      session.id,
      session.title,
      cleanOptional(session.workspacePath),
      cleanOptional(session.workspaceName),
      timestamp,
      timestamp,
      cleanOptional(session.providerId),
      cleanOptional(session.modelId),
      cleanOptional(session.runtime),
      cleanOptional(session.parentChatId)
    )
  }

  return {
    id: session.id,
    title: session.title,
    workspacePath: session.workspacePath,
    workspaceName: session.workspaceName,
    createdAt: timestamp,
    updatedAt: timestamp,
    providerId: session.providerId,
    modelId: session.modelId,
    runtime: session.runtime,
    parentChatId: session.parentChatId
  }
}

/**
 * Borra `fromMessageId` y TODO lo posterior en ese chat (usa el rowid
 * implicito de SQLite como orden de insercion — mas confiable que
 * created_at si dos mensajes cayeran en el mismo milisegundo). Usado por
 * editar-mensaje (borra el mensaje editado y su respuesta) y regenerar
 * (borra la respuesta del asistente, conservando el mensaje del usuario
 * que la origino, cuyo rowid es menor).
 */
export function deleteChatMessagesFrom(chatId: string, fromMessageId: string): void {
  db().prepare(`
    DELETE FROM chat_messages
    WHERE chat_id = ? AND rowid >= (
      SELECT rowid FROM chat_messages WHERE id = ? AND chat_id = ?
    )
  `).run(chatId, fromMessageId, chatId)
  invalidateSummaryIfWatermarkMissing(chatId)
}

/**
 * Si el watermark de resumen de este chat apuntaba a un mensaje que
 * deleteChatMessagesFrom() acaba de borrar (editar/regenerar borra ese
 * mensaje y TODO lo posterior), el resumen persistido queda describiendo
 * contenido que el usuario ya elimino de la conversacion — invalido, no
 * parcialmente valido. Se resetea a "nada resumido todavia" en vez de
 * dejarlo desincronizado en silencio; la proxima pasada de compactacion
 * lo reconstruye desde cero con lo que quedo.
 */
function invalidateSummaryIfWatermarkMissing(chatId: string): void {
  const current = db()
  const row = current.prepare(
    'SELECT summary_watermark_id FROM chat_sessions WHERE id = ?'
  ).get(chatId) as { summary_watermark_id: string | null } | undefined
  const watermarkId = row?.summary_watermark_id
  if (!watermarkId) return

  const stillExists = current.prepare('SELECT 1 FROM chat_messages WHERE id = ?').get(watermarkId)
  if (!stillExists) {
    // structured_memory se invalida junto con summary/watermark: las
    // decisiones/restricciones/proximos pasos que ese resumen habia
    // extraido tambien describen contenido que el usuario ya elimino.
    current.prepare(
      'UPDATE chat_sessions SET summary = NULL, summary_watermark_id = NULL, structured_memory = NULL WHERE id = ?'
    ).run(chatId)
  }
}

/**
 * Extraccion estructurada acumulativa de la compactacion (Fase 6):
 * decisiones tecnicas/de producto ya tomadas, restricciones o reglas a
 * seguir respetando, y tareas pendientes. Listas TEXTUALES, no resumidas —
 * cada pasada de compactacion las recibe como input y devuelve la version
 * fusionada (ver compaction-engine.ts).
 */
/** Memoria estructurada agrupada por tema (Fase 11) — clave = nombre del
 *  tema, valor = sus listas. Fase 6 la tenia como 3 arrays sueltos sin
 *  agrupar; ver parseStructuredMemory() para la migracion automatica del
 *  formato viejo. */
export type StructuredMemory = Record<string, MemoryTopic>

export const EMPTY_STRUCTURED_MEMORY: StructuredMemory = {}

export function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

function parseTopicValue(value: unknown): MemoryTopic {
  const record = typeof value === 'object' && value !== null ? value as Record<string, unknown> : {}
  return {
    decisions: asStringArray(record.decisions),
    constraints: asStringArray(record.constraints),
    nextSteps: asStringArray(record.nextSteps)
  }
}

/**
 * Fase 11: structured_memory paso de 3 listas planas (Fase 6) a agrupado
 * por tema. Migracion automatica y sin perdida: una fila vieja en formato
 * plano (decisions/constraints/nextSteps como arrays en la RAIZ del
 * objeto JSON, sin agrupar) se detecta aca y se trata en memoria como un
 * unico tema "General" — nunca se reescribe la fila en la base solo por
 * leerla, la proxima compactacion natural de ese chat ya persiste la
 * forma nueva (ver maybeCompactChatInBackground en compaction-engine.ts).
 */
function parseStructuredMemory(value: string | null): StructuredMemory {
  if (!value) return {}
  try {
    const parsed = JSON.parse(value) as unknown
    const record = typeof parsed === 'object' && parsed !== null ? parsed as Record<string, unknown> : {}

    const isOldFlatFormat =
      Array.isArray(record.decisions) || Array.isArray(record.constraints) || Array.isArray(record.nextSteps)
    if (isOldFlatFormat) {
      const general = parseTopicValue(record)
      const isEmpty = general.decisions.length === 0 && general.constraints.length === 0 && general.nextSteps.length === 0
      return isEmpty ? {} : { General: general }
    }

    const topics: StructuredMemory = {}
    for (const [topicName, topicValue] of Object.entries(record)) {
      const trimmedName = topicName.trim()
      if (!trimmedName) continue
      topics[trimmedName] = parseTopicValue(topicValue)
    }
    return topics
  } catch {
    return {}
  }
}

export interface ChatSummaryState {
  summary: string
  watermarkMessageId: string
  topics: StructuredMemory
}

/** Lee el resumen acumulado + watermark + memoria estructurada (agrupada
 *  por tema desde Fase 11) de un chat. null si todavia no se compacto nada
 *  (chat nuevo, o resumen invalidado por edicion/borrado). */
export function getChatSummaryState(chatId: string): ChatSummaryState | null {
  const row = db().prepare(
    'SELECT summary, summary_watermark_id, structured_memory FROM chat_sessions WHERE id = ?'
  ).get(chatId) as
    { summary: string | null; summary_watermark_id: string | null; structured_memory: string | null } | undefined
  if (!row?.summary || !row.summary_watermark_id) return null
  return {
    summary: row.summary,
    watermarkMessageId: row.summary_watermark_id,
    topics: parseStructuredMemory(row.structured_memory)
  }
}

/**
 * Reemplaza el resumen acumulado + avanza el watermark + reemplaza la
 * memoria estructurada (por tema) de un chat. Llamado unicamente desde
 * compaction-engine.ts tras una pasada exitosa.
 *
 * `structured` es un parametro REQUERIDO a proposito, no opcional-con-
 * default-vacio: si fuera opcional, un call site que lo omitiera por
 * descuido borraria en silencio los temas ya acumulados (justo el bug que
 * Fase 6 tiene que evitar en el caso de JSON invalido — ver
 * compaction-engine.ts, que ahi pasa explicitamente el estado ANTERIOR en
 * vez de omitir el argumento).
 */
export function setChatSummaryState(
  chatId: string,
  summary: string,
  watermarkMessageId: string,
  structured: StructuredMemory
): void {
  db().prepare(
    'UPDATE chat_sessions SET summary = ?, summary_watermark_id = ?, structured_memory = ? WHERE id = ?'
  ).run(summary, watermarkMessageId, JSON.stringify(structured), chatId)
}

/**
 * Tool "todo_write" (docs/_arch/verify_todo_write_design.md): mismo shape
 * de reemplazo total exacto que getChatSummaryState()/setChatSummaryState()
 * de arriba -- una columna, un JSON, sin watermark (a diferencia del
 * resumen, la lista de tareas no se "acumula" contra un punto del
 * historial, el modelo simplemente manda la version vigente completa en
 * cada llamada). JSON invalido/fila ausente = [] (mismo criterio de
 * degradacion silenciosa que parseStructuredMemory() -- nunca un throw que
 * tumbe el turno por un dato de bookkeeping corrupto).
 */
function parseTodos(value: string | null): TodoList {
  if (!value) return []
  try {
    const parsed = JSON.parse(value) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.filter((item): item is TodoItem =>
      typeof item === 'object' && item !== null &&
      typeof (item as TodoItem).content === 'string' &&
      ['pending', 'in_progress', 'completed'].includes((item as TodoItem).status)
    )
  } catch {
    return []
  }
}

/** Lee la ultima lista de tareas persistida para este chat. [] si nunca se
 *  llamo todo_write (fila NULL) o el chat no existe. */
export function getTodos(chatId: string): TodoList {
  const row = db().prepare('SELECT todos FROM chat_sessions WHERE id = ?').get(chatId) as
    { todos: string | null } | undefined
  return parseTodos(row?.todos ?? null)
}

/** Reemplaza la lista de tareas completa de este chat -- mismo criterio
 *  "reemplazo total, no parche" que el propio patron externo de la tool
 *  (ver docs/_arch/verify_todo_write_design.md). */
export function setTodos(chatId: string, todos: TodoList): void {
  db().prepare('UPDATE chat_sessions SET todos = ? WHERE id = ?').run(JSON.stringify(todos), chatId)
}

/**
 * Mensajes de un chat posteriores a `afterMessageId` (excluido), en orden
 * de insercion (rowid, igual criterio que deleteChatMessagesFrom). Con
 * `afterMessageId = null` devuelve el chat completo — caso "nunca se
 * compacto nada todavia". Usado por compaction-engine.ts para calcular el
 * backlog no resumido de un chat.
 */
export function getMessagesAfter(chatId: string, afterMessageId: string | null): StoredChatMessage[] {
  const current = db()
  const rows = (afterMessageId
    ? current.prepare(`
        SELECT id, chat_id, role, text, created_at, provider_id, model_id, runtime, tool_steps
        FROM chat_messages
        WHERE chat_id = ? AND rowid > (
          SELECT rowid FROM chat_messages WHERE id = ? AND chat_id = ?
        )
        ORDER BY rowid ASC
      `).all(chatId, afterMessageId, chatId)
    : current.prepare(`
        SELECT id, chat_id, role, text, created_at, provider_id, model_id, runtime, tool_steps
        FROM chat_messages
        WHERE chat_id = ?
        ORDER BY rowid ASC
      `).all(chatId)) as Array<Record<string, string | null>>

  return rows.map(item => ({
    id: String(item.id),
    chatId: String(item.chat_id),
    role: String(item.role) as ConversationRole,
    text: String(item.text ?? ''),
    createdAt: String(item.created_at),
    providerId: item.provider_id ? String(item.provider_id) : undefined,
    modelId: item.model_id ? String(item.model_id) : undefined,
    runtime: item.runtime ? String(item.runtime) : undefined,
    toolSteps: parseToolSteps(item.tool_steps)
  }))
}

export function renameChatSession(chatId: string, title: string): void {
  db().prepare('UPDATE chat_sessions SET title = ?, updated_at = ? WHERE id = ?')
    .run(title, nowIso(), chatId)
}

export function deleteChatSession(chatId: string): void {
  db().prepare('DELETE FROM chat_sessions WHERE id = ?').run(chatId)
}

export function saveChatMessage(message: {
  id: string
  chatId: string
  role: ConversationRole
  text: string
  attachments?: ChatAttachment[]
  providerId?: string
  modelId?: string
  runtime?: string
  toolSteps?: string[]
  /** Mensajeria entre ventanas, Paso 3: solo lo setea
   *  deliverResultToOriginWindow() (cross-window-messaging.ts) -- un
   *  mensaje de un turno normal nunca lo manda, queda NULL en la fila. */
  crossWindow?: CrossWindowMeta
}): StoredChatMessage {
  const current = db()
  const timestamp = nowIso()
  const toolStepsJson = message.toolSteps && message.toolSteps.length > 0
    ? JSON.stringify(message.toolSteps)
    : null
  const crossWindowJson = message.crossWindow ? JSON.stringify(message.crossWindow) : null

  current.prepare(`
    INSERT INTO chat_messages (
      id, chat_id, role, text, created_at, provider_id, model_id, runtime, tool_steps, cross_window
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      text = excluded.text,
      provider_id = COALESCE(excluded.provider_id, chat_messages.provider_id),
      model_id = COALESCE(excluded.model_id, chat_messages.model_id),
      runtime = COALESCE(excluded.runtime, chat_messages.runtime),
      tool_steps = COALESCE(excluded.tool_steps, chat_messages.tool_steps),
      cross_window = COALESCE(excluded.cross_window, chat_messages.cross_window)
  `).run(
    message.id,
    message.chatId,
    message.role,
    message.text,
    timestamp,
    cleanOptional(message.providerId),
    cleanOptional(message.modelId),
    cleanOptional(message.runtime),
    toolStepsJson,
    crossWindowJson
  )

  current.prepare('DELETE FROM chat_attachments WHERE message_id = ?').run(message.id)
  for (const attachment of message.attachments ?? []) {
    current.prepare(`
      INSERT INTO chat_attachments (
        id, message_id, name, path, mime_type, size, kind, preview, text, origin
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      attachment.id,
      message.id,
      attachment.name,
      attachment.path,
      attachment.mimeType,
      attachment.size,
      attachment.kind,
      attachment.preview ?? null,
      attachment.text ?? null,
      attachment.origin ?? null
    )
  }

  current.prepare('UPDATE chat_sessions SET updated_at = ? WHERE id = ?').run(timestamp, message.chatId)

  return {
    id: message.id,
    chatId: message.chatId,
    role: message.role,
    text: message.text,
    createdAt: timestamp,
    providerId: message.providerId,
    modelId: message.modelId,
    runtime: message.runtime,
    attachments: message.attachments,
    toolSteps: message.toolSteps,
    crossWindow: message.crossWindow
  }
}

export function loadChatSnapshot(): ChatDatabaseSnapshot {
  const current = db()
  const sessions = current.prepare(`
    SELECT id, title, workspace_path, workspace_name, created_at, updated_at,
           provider_id, model_id, runtime, parent_chat_id
    FROM chat_sessions
    ORDER BY updated_at DESC
  `).all() as Array<Record<string, string | null>>

  const messages = current.prepare(`
    SELECT id, chat_id, role, text, created_at, provider_id, model_id, runtime, tool_steps, cross_window
    FROM chat_messages
    ORDER BY created_at ASC
  `).all() as Array<Record<string, string | null>>

  const attachments = current.prepare(`
    SELECT id, message_id, name, path, mime_type, size, kind, preview, text, origin
    FROM chat_attachments
    ORDER BY rowid ASC
  `).all() as Array<Record<string, string | number | null>>

  const attachmentsByMessage = new Map<string, ChatAttachment[]>()
  for (const item of attachments) {
    const messageId = String(item.message_id)
    const next = attachmentsByMessage.get(messageId) ?? []
    next.push({
      id: String(item.id),
      name: String(item.name),
      path: String(item.path),
      mimeType: String(item.mime_type),
      size: Number(item.size),
      kind: String(item.kind) as ChatAttachment['kind'],
      preview: item.preview ? String(item.preview) : undefined,
      text: item.text ? String(item.text) : undefined,
      origin: item.origin === 'generated' ? 'generated' : undefined
    })
    attachmentsByMessage.set(messageId, next)
  }

  const groupedMessages: Record<string, StoredChatMessage[]> = {}
  for (const item of messages) {
    const chatId = String(item.chat_id)
    groupedMessages[chatId] = groupedMessages[chatId] ?? []
    groupedMessages[chatId].push({
      id: String(item.id),
      chatId,
      role: String(item.role) as ConversationRole,
      text: String(item.text ?? ''),
      createdAt: String(item.created_at),
      providerId: item.provider_id ? String(item.provider_id) : undefined,
      modelId: item.model_id ? String(item.model_id) : undefined,
      runtime: item.runtime ? String(item.runtime) : undefined,
      attachments: attachmentsByMessage.get(String(item.id)),
      toolSteps: parseToolSteps(item.tool_steps),
      crossWindow: parseCrossWindow(item.cross_window)
    })
  }

  return {
    sessions: sessions.map(item => ({
      id: String(item.id),
      title: String(item.title),
      workspacePath: item.workspace_path ? String(item.workspace_path) : undefined,
      workspaceName: item.workspace_name ? String(item.workspace_name) : undefined,
      createdAt: String(item.created_at),
      updatedAt: String(item.updated_at),
      providerId: item.provider_id ? String(item.provider_id) : undefined,
      modelId: item.model_id ? String(item.model_id) : undefined,
      runtime: item.runtime ? String(item.runtime) : undefined,
      parentChatId: item.parent_chat_id ? String(item.parent_chat_id) : undefined
    })),
    messages: groupedMessages
  }
}
