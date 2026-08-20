import type { ConversationMessage, RuntimeContextEnvelope } from '../shared/types'

const MAX_HISTORY_MESSAGES = 18
const MAX_MESSAGE_CHARS = 5000

function cleanText(value: string): string {
  return value.replace(/\r\n/g, '\n').trim()
}

function clipText(value: string): string {
  const clean = cleanText(value)
  if (clean.length <= MAX_MESSAGE_CHARS) return clean
  return `${clean.slice(0, MAX_MESSAGE_CHARS)}\n[contenido recortado]`
}

export function normalizeHistory(messages?: ConversationMessage[]): ConversationMessage[] {
  return (messages ?? [])
    .map(message => ({
      role: message.role,
      text: clipText(message.text)
    }))
    .filter(message => Boolean(message.text))
    .slice(-MAX_HISTORY_MESSAGES)
}

export function formatContextEnvelope(envelope: RuntimeContextEnvelope): string {
  const history = normalizeHistory(envelope.history)
  const lines = [
    'Contexto comun de AMATISTA:',
    `Workspace: ${envelope.workspace}`,
    `Proveedor activo: ${envelope.providerName}`,
    `Modelo activo: ${envelope.modelName}`
  ]

  const summary = cleanText(envelope.compactSummary ?? '')
  if (summary) {
    lines.push('', 'Resumen acumulado:', summary)
  }

  if (history.length > 0) {
    lines.push('', 'Historial reciente:')
    for (const message of history) {
      lines.push(`[${message.role}] ${message.text}`)
    }
  }

  if (envelope.attachments && envelope.attachments.length > 0) {
    lines.push('', 'Archivos adjuntos del mensaje actual:')
    for (const attachment of envelope.attachments) {
      lines.push(`- ${attachment.name} (${attachment.kind}, ${attachment.mimeType}, ${attachment.size} bytes): ${attachment.path}`)
      if (attachment.text) lines.push(clipText(attachment.text))
      if (attachment.kind === 'image' && !attachment.text) lines.push('[imagen adjunta; usar la ruta local para inspeccionarla si el runtime tiene herramientas de archivos]')
    }
  }

  lines.push('', 'Mensaje actual del usuario:', clipText(envelope.current.text))
  return lines.join('\n')
}
