// Canales IPC de persistencia de chats (delegan directo a chat-store.ts).
import { ipcMain } from 'electron'
import {
  deleteChatMessagesFrom,
  deleteChatSession,
  ensureChatSession,
  listDeletedChatSessions,
  loadChatSnapshot,
  purgeChatSession,
  renameChatSession,
  restoreChatSession,
  saveChatMessage
} from './chat-store'
import type { ChatAttachment, ConversationRole } from '../shared/types'

export function registerChatsIpc(): void {
  ipcMain.handle('chats:load', () => loadChatSnapshot())

  ipcMain.handle('chats:ensureSession', (_event, payload: {
    id: string
    title: string
    workspacePath?: string
    workspaceName?: string
    providerId?: string
    modelId?: string
    runtime?: string
    parentChatId?: string
    personaText?: string
  }) => ensureChatSession(payload))

  ipcMain.handle('chats:renameSession', (_event, payload: { chatId: string; title: string }) => {
    renameChatSession(payload.chatId, payload.title)
    return { success: true }
  })

  ipcMain.handle('chats:deleteSession', (_event, chatId: string) => {
    deleteChatSession(chatId)
    return { success: true }
  })

  // Papelera real (soft-delete): restaurar vuelve deleted_at a NULL,
  // purgar es el DELETE real (unico punto donde dispara el FK cascade de
  // mensajes/adjuntos) -- ver comentarios de las 3 funciones en chat-store.ts.
  ipcMain.handle('chats:restoreSession', (_event, chatId: string) => {
    restoreChatSession(chatId)
    return { success: true }
  })

  ipcMain.handle('chats:purgeSession', (_event, chatId: string) => {
    purgeChatSession(chatId)
    return { success: true }
  })

  ipcMain.handle('chats:listDeleted', () => listDeletedChatSessions())

  ipcMain.handle('chats:saveMessage', (_event, payload: {
    id: string
    chatId: string
    role: ConversationRole
    text: string
    attachments?: ChatAttachment[]
    providerId?: string
    modelId?: string
    runtime?: string
    toolSteps?: string[]
  }) => saveChatMessage(payload))

  ipcMain.handle('chats:deleteMessagesFrom', (_event, payload: { chatId: string; fromMessageId: string }) => {
    deleteChatMessagesFrom(payload.chatId, payload.fromMessageId)
    return { success: true }
  })
}
