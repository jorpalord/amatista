import { CONTEXT_TOKEN_BUDGET, estimateTokens } from '../shared/context-budget'
import type { ConversationMessage, RuntimeContextEnvelope } from '../shared/types'

const MAX_MESSAGE_CHARS = 5000

function cleanText(value: string): string {
  return value.replace(/\r\n/g, '\n').trim()
}

function clipText(value: string): string {
  const clean = cleanText(value)
  if (clean.length <= MAX_MESSAGE_CHARS) return clean
  return `${clean.slice(0, MAX_MESSAGE_CHARS)}\n[contenido recortado]`
}

/**
 * Unico punto que decide cuanto historial se manda VERBATIM en un turno —
 * antes vivia duplicado (MAX_HISTORY_MESSAGES aca + RUNTIME_HISTORY_LIMIT
 * en App.tsx, "recorte redundante" documentado en Fase 1 Tarea C). Ahora
 * App.tsx ya no recorta por su cuenta: manda el historial completo (con un
 * techo de payload IPC ajeno a este presupuesto, ver App.tsx) y ESTA
 * funcion aplica el unico techo real, basado en tamano estimado — no en
 * conteo de mensajes — via CONTEXT_TOKEN_BUDGET (src/shared/context-budget.ts).
 *
 * Toma mensajes desde el mas reciente hacia atras hasta agotar el
 * presupuesto, preservando el orden cronologico en el resultado. Mismo
 * techo duro que exige la Tarea 5 para el caso de backfill: un chat viejo
 * con watermark en null igual nunca manda mas de CONTEXT_TOKEN_BUDGET de
 * historial verbatim en un turno individual, sin importar cuanto backlog
 * sin resumir tenga — la compactacion asincrona (compaction-engine.ts) es
 * la que va cerrando ese backlog en pasadas sucesivas, no este envio.
 */
export function normalizeHistory(messages?: ConversationMessage[]): ConversationMessage[] {
  const clipped = (messages ?? [])
    .map(message => ({ role: message.role, text: clipText(message.text) }))
    .filter(message => Boolean(message.text))

  const result: ConversationMessage[] = []
  let tokens = 0

  for (let i = clipped.length - 1; i >= 0; i--) {
    const messageTokens = estimateTokens(clipped[i].text)
    // El primer mensaje (el mas reciente) siempre entra, aunque el solo ya
    // supere el presupuesto — evitar devolver historial vacio por un unico
    // mensaje gigante.
    if (result.length > 0 && tokens + messageTokens > CONTEXT_TOKEN_BUDGET) break
    result.unshift(clipped[i])
    tokens += messageTokens
  }

  return result
}

export function formatContextEnvelope(envelope: RuntimeContextEnvelope): string {
  const history = normalizeHistory(envelope.history)
  const lines = [
    'Contexto comun de AMATISTA:',
    `Workspace: ${envelope.workspace}`,
    `Proveedor activo: ${envelope.providerName}`,
    `Modelo activo: ${envelope.modelName}`
  ]

  // Fase 7: AGENTS.md va PRIMERO de todo el bloque de memoria/contexto —
  // antes de decisions/constraints (Fase 6) y del resumen. Orden deliberado:
  // AGENTS.md es la regla del PROYECTO (estatica, existe independientemente
  // de esta conversacion, "constitucion" del repo), mientras que
  // decisions/constraints/summary son memoria DERIVADA de esta conversacion
  // puntual (dinamica, crece turno a turno). Lo estable y fundacional
  // encabeza, lo derivado de la charla va despues.
  const agentsMd = envelope.agentsMd?.trim()
  if (agentsMd) {
    lines.push('', 'AGENTS.md del proyecto (instrucciones del repositorio, no de esta conversacion):', agentsMd)
  }

  // Fase 6: bloque estructurado ANTES del resumen narrativo — decisions y
  // constraints son datos duros (no se resumen, no se pierden), separados
  // a proposito del texto libre de "summary" para que el modelo los trate
  // como hechos, no como prosa a reinterpretar. nextSteps va en su propio
  // bloque, no mezclado con decisions/constraints: es forward-looking
  // ("que falta hacer"), no estado ya establecido.
  const decisions = (envelope.decisions ?? []).map(item => item.trim()).filter(Boolean)
  const constraints = (envelope.constraints ?? []).map(item => item.trim()).filter(Boolean)
  const nextSteps = (envelope.nextSteps ?? []).map(item => item.trim()).filter(Boolean)

  if (decisions.length > 0 || constraints.length > 0) {
    lines.push('', 'Decisiones y restricciones registradas:')
    for (const decision of decisions) lines.push(`- [decision] ${decision}`)
    for (const constraint of constraints) lines.push(`- [restriccion] ${constraint}`)
  }

  if (nextSteps.length > 0) {
    lines.push('', 'Proximos pasos pendientes:')
    for (const step of nextSteps) lines.push(`- ${step}`)
  }

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
