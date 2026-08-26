// Canal IPC dedicado al catalogo de modelos openai-chat (Fase 18) -- archivo
// propio, no sumado a ipc-cli.ts, porque no tiene nada que ver con
// deteccion/instalacion de CLIs: es un fetch HTTP plano contra el endpoint
// de la conexion, mismo criterio de "un archivo por responsabilidad" que ya
// usa el resto de ipc-*.ts.
import { ipcMain } from 'electron'
import { listOpenAiChatModels } from './openai-chat-catalog'

export function registerOpenAiChatCatalogIpc(): void {
  ipcMain.handle('openaiChat:listModels', async (_event, payload: { endpoint?: string; apiKey?: string }) =>
    listOpenAiChatModels(payload.endpoint ?? '', payload.apiKey ?? '')
  )
}
