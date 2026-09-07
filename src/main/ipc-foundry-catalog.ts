// Canal IPC dedicado al catalogo de deployments de Foundry -- archivo
// propio, mismo criterio que ipc-openai-chat-catalog.ts (un archivo por
// responsabilidad): esto no tiene nada que ver con deteccion/instalacion
// de CLIs (ipc-cli.ts) ni con el catalogo generico Chat-Completions
// (ipc-openai-chat-catalog.ts, auth/shape reales distintos, ver
// foundry-catalog.ts).
import { ipcMain } from 'electron'
import { listFoundryModels } from './foundry-catalog'

export function registerFoundryCatalogIpc(): void {
  ipcMain.handle('foundry:listModels', async (_event, payload: { endpoint?: string; apiKey?: string }) =>
    listFoundryModels(payload.endpoint ?? '', payload.apiKey ?? '')
  )
}
