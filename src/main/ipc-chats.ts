// Canales IPC de persistencia de chats (delegan directo a chat-store.ts).
import { ipcMain } from 'electron'
import {
  deleteChatMessagesFrom,
  deleteChatSession,
  ensureChatSession,
  loadChatSnapshot,
  renameChatSession,
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
  }) => ensureChatSession(payload))

  ipcMain.handle('chats:renameSession', (_event, payload: { chatId: string; title: string }) => {
    renameChatSession(payload.chatId, payload.title)
    return { success: true }
  })

  ipcMain.handle('chats:deleteSession', (_event, chatId: string) => {
    deleteChatSession(chatId)
    return { success: true }
  })

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
