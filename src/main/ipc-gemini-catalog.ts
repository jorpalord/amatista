// Canal IPC dedicado al catalogo de modelos de Google/Gemini -- archivo
// propio, mismo criterio que ipc-foundry-catalog.ts/ipc-openai-chat-catalog.ts
// (un archivo por responsabilidad, auth/shape reales distintos por
// proveedor, ver gemini-catalog.ts).
import { ipcMain } from 'electron'
import { listGeminiModels } from './gemini-catalog'

export function registerGeminiCatalogIpc(): void {
  ipcMain.handle('gemini:listModels', async (_event, payload: { apiKey?: string }) =>
    listGeminiModels(payload.apiKey ?? '')
  )
}
