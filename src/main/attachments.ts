// Construccion de ChatAttachment a partir de rutas de disco o de un data URL
// pegado desde el portapapeles (imagenes). Incluye los limites de tamano que
// deciden si se embebe preview/texto o solo metadata.
import { readFileSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { getAppDataSubdir } from './app-paths'
import type { ChatAttachment } from '../shared/types'

export const MAX_ATTACHMENT_TEXT_BYTES = 1 * 1024 * 1024
export const MAX_ATTACHMENT_PREVIEW_BYTES = 20 * 1024 * 1024

export function mimeTypeFor(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase()
  if (['.png'].includes(ext)) return 'image/png'
  if (['.jpg', '.jpeg'].includes(ext)) return 'image/jpeg'
  if (['.ico'].includes(ext)) return 'image/x-icon'
  if (['.webp'].includes(ext)) return 'image/webp'
  if (['.gif'].includes(ext)) return 'image/gif'
  if (['.txt', '.md', '.csv', '.json', '.yaml', '.yml', '.xml', '.html', '.css', '.js', '.ts', '.tsx', '.py', '.ps1'].includes(ext)) return 'text/plain'
  if (ext === '.pdf') return 'application/pdf'
  return 'application/octet-stream'
}

export function attachmentKind(mimeType: string): ChatAttachment['kind'] {
  if (mimeType.startsWith('image/')) return 'image'
  if (mimeType.startsWith('text/')) return 'text'
  return 'file'
}

export function buildAttachment(filePath: string): ChatAttachment {
  const stats = statSync(filePath)
  const isDirectory = stats.isDirectory()
  const mimeType = isDirectory ? 'inode/directory' : mimeTypeFor(filePath)
  const kind = isDirectory ? 'file' : attachmentKind(mimeType)
  const attachment: ChatAttachment = {
    id: randomUUID(),
    name: path.basename(filePath),
    path: filePath,
    mimeType,
    size: isDirectory ? 0 : stats.size,
    kind
  }

  if (!isDirectory && kind === 'image' && stats.size <= MAX_ATTACHMENT_PREVIEW_BYTES) {
    attachment.preview = `data:${mimeType};base64,${readFileSync(filePath).toString('base64')}`
  }

  if (!isDirectory && kind === 'text' && stats.size <= MAX_ATTACHMENT_TEXT_BYTES) {
    attachment.text = readFileSync(filePath, 'utf8')
  }

  return attachment
}

export function buildAttachmentFromDataUrl(payload: { name: string; dataUrl: string }): ChatAttachment {
  const match = payload.dataUrl.match(/^data:([^;,]+);base64,(.+)$/)
  if (!match) throw new Error('Imagen pegada invalida.')

  const mimeType = match[1]
  if (!mimeType.startsWith('image/')) throw new Error('El portapapeles no contiene una imagen soportada.')

  const buffer = Buffer.from(match[2], 'base64')
  if (buffer.length > MAX_ATTACHMENT_PREVIEW_BYTES) {
    throw new Error('La imagen supera 20 MB.')
  }

  const ext =
    mimeType === 'image/jpeg'
      ? '.jpg'
      : mimeType === 'image/gif'
        ? '.gif'
        : mimeType === 'image/webp'
          ? '.webp'
          : '.png'
  const name = payload.name.trim() || `imagen-pegada-${Date.now()}${ext}`
  const dir = getAppDataSubdir('attachments')
  const filePath = path.join(dir, `${Date.now()}-${randomUUID()}-${path.basename(name)}`)
  writeFileSync(filePath, buffer)
  return buildAttachment(filePath)
}

export function runtimeAttachmentView(attachments?: ChatAttachment[]): ChatAttachment[] | undefined {
  if (!attachments?.length) return undefined
  return attachments.map(attachment => ({
    id: attachment.id,
    name: attachment.name,
    path: attachment.path,
    mimeType: attachment.mimeType,
    size: attachment.size,
    kind: attachment.kind,
    text: attachment.text ? attachment.text.slice(0, 1200) : undefined
  }))
}

export function previewImagePathToDataUrl(filePath: string): string {
  const normalizedPath = filePath.startsWith('file:')
    ? fileURLToPath(filePath)
    : filePath
  const stats = statSync(normalizedPath)
  const mimeType = mimeTypeFor(normalizedPath)
  if (!stats.isFile() || !mimeType.startsWith('image/')) return ''
  if (stats.size > MAX_ATTACHMENT_PREVIEW_BYTES) return ''
  return `data:${mimeType};base64,${readFileSync(normalizedPath).toString('base64')}`
}
