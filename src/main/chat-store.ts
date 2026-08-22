import { DatabaseSync } from 'node:sqlite'
import path from 'node:path'
import { getAppDataSubdir } from './app-paths'
import type {
  ChatAttachment,
  ChatDatabaseSnapshot,
  ConversationRole,
  StoredChatMessage,
  StoredChatSession
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

  return database
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

export function ensureChatSession(session: {
  id: string
  title: string
  workspacePath?: string
  workspaceName?: string
  providerId?: string
  modelId?: string
  runtime?: string
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
          runtime = COALESCE(?, runtime)
      WHERE id = ?
    `).run(
      session.title,
      cleanOptional(session.workspacePath),
      cleanOptional(session.workspaceName),
      timestamp,
      cleanOptional(session.providerId),
      cleanOptional(session.modelId),
      cleanOptional(session.runtime),
      session.id
    )
  } else {
    current.prepare(`
      INSERT INTO chat_sessions (
        id, title, workspace_path, workspace_name, created_at, updated_at,
        provider_id, model_id, runtime
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      session.id,
      session.title,
      cleanOptional(session.workspacePath),
      cleanOptional(session.workspaceName),
      timestamp,
      timestamp,
      cleanOptional(session.providerId),
      cleanOptional(session.modelId),
      cleanOptional(session.runtime)
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
    runtime: session.runtime
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
    current.prepare(
      'UPDATE chat_sessions SET summary = NULL, summary_watermark_id = NULL WHERE id = ?'
    ).run(chatId)
  }
}

export interface ChatSummaryState {
  summary: string
  watermarkMessageId: string
}

/** Lee el resumen acumulado + watermark de un chat. null si todavia no se
 *  compacto nada (chat nuevo, o resumen invalidado por edicion/borrado). */
export function getChatSummaryState(chatId: string): ChatSummaryState | null {
  const row = db().prepare(
    'SELECT summary, summary_watermark_id FROM chat_sessions WHERE id = ?'
  ).get(chatId) as { summary: string | null; summary_watermark_id: string | null } | undefined
  if (!row?.summary || !row.summary_watermark_id) return null
  return { summary: row.summary, watermarkMessageId: row.summary_watermark_id }
}

/** Reemplaza el resumen acumulado + avanza el watermark de un chat. Llamado
 *  unicamente desde compaction-engine.ts tras una pasada exitosa. */
export function setChatSummaryState(chatId: string, summary: string, watermarkMessageId: string): void {
  db().prepare(
    'UPDATE chat_sessions SET summary = ?, summary_watermark_id = ? WHERE id = ?'
  ).run(summary, watermarkMessageId, chatId)
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
}): StoredChatMessage {
  const current = db()
  const timestamp = nowIso()
  const toolStepsJson = message.toolSteps && message.toolSteps.length > 0
    ? JSON.stringify(message.toolSteps)
    : null

  current.prepare(`
    INSERT INTO chat_messages (
      id, chat_id, role, text, created_at, provider_id, model_id, runtime, tool_steps
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      text = excluded.text,
      provider_id = COALESCE(excluded.provider_id, chat_messages.provider_id),
      model_id = COALESCE(excluded.model_id, chat_messages.model_id),
      runtime = COALESCE(excluded.runtime, chat_messages.runtime),
      tool_steps = COALESCE(excluded.tool_steps, chat_messages.tool_steps)
  `).run(
    message.id,
    message.chatId,
    message.role,
    message.text,
    timestamp,
    cleanOptional(message.providerId),
    cleanOptional(message.modelId),
    cleanOptional(message.runtime),
    toolStepsJson
  )

  current.prepare('DELETE FROM chat_attachments WHERE message_id = ?').run(message.id)
  for (const attachment of message.attachments ?? []) {
    current.prepare(`
      INSERT INTO chat_attachments (
        id, message_id, name, path, mime_type, size, kind, preview, text
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      attachment.id,
      message.id,
      attachment.name,
      attachment.path,
      attachment.mimeType,
      attachment.size,
      attachment.kind,
      attachment.preview ?? null,
      attachment.text ?? null
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
    toolSteps: message.toolSteps
  }
}

export function loadChatSnapshot(): ChatDatabaseSnapshot {
  const current = db()
  const sessions = current.prepare(`
    SELECT id, title, workspace_path, workspace_name, created_at, updated_at,
           provider_id, model_id, runtime
    FROM chat_sessions
    ORDER BY updated_at DESC
  `).all() as Array<Record<string, string | null>>

  const messages = current.prepare(`
    SELECT id, chat_id, role, text, created_at, provider_id, model_id, runtime, tool_steps
    FROM chat_messages
    ORDER BY created_at ASC
  `).all() as Array<Record<string, string | null>>

  const attachments = current.prepare(`
    SELECT id, message_id, name, path, mime_type, size, kind, preview, text
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
      text: item.text ? String(item.text) : undefined
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
      toolSteps: parseToolSteps(item.tool_steps)
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
      runtime: item.runtime ? String(item.runtime) : undefined
    })),
    messages: groupedMessages
  }
}
