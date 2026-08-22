// Canales IPC de adjuntos: picker de archivos, construccion desde rutas o
// desde un data URL pegado, y preview base64 de una imagen puntual.
import { dialog, ipcMain } from 'electron'
import { buildAttachment, buildAttachmentFromDataUrl, previewImagePathToDataUrl } from './attachments'

export function registerAttachmentsIpc(): void {
  ipcMain.handle('attachments:pick', async () => {
    const result = await dialog.showOpenDialog({
      title: 'Agregar archivos',
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: 'Archivos', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'txt', 'md', 'csv', 'json', 'yaml', 'yml', 'pdf', '*'] }
      ]
    })

    if (result.canceled) return []

    return result.filePaths.map(buildAttachment)
  })

  ipcMain.handle('attachments:fromPaths', (_event, filePaths: string[]) => {
    return filePaths
      .map(filePath => {
        try { return buildAttachment(filePath) } catch { return null }
      })
      .filter(Boolean)
  })

  ipcMain.handle('attachments:fromDataUrl', (_event, payload: { name: string; dataUrl: string }) => {
    return buildAttachmentFromDataUrl(payload)
  })

  ipcMain.handle('attachments:previewImagePath', (_event, filePath: string) => {
    return previewImagePathToDataUrl(filePath)
  })
}
