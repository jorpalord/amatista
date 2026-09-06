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

  // Presets simples (docs/_arch/verify_simple_presets_design.md): ANTES
  // incluso de AGENTS.md -- persona/instruccion es "quien sos" (identidad
  // del chat, fijada al crearlo), mas fundacional que "las reglas del
  // repo" (AGENTS.md, que sigue siendo del PROYECTO, no de este chat
  // puntual). Distinto a proposito del bloque de "Memoria por tema"/todos
  // mas abajo -- esto es identidad estatica, no estado de tareas.
  const personaText = envelope.personaText?.trim()
  if (personaText) {
    lines.push('', 'Persona/instruccion de este chat (preset elegido al crearlo):', personaText)
  }

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

  // Sistema de skills (docs/_arch/verify_skills_design.md): NIVEL 1 del
  // catalogo -- solo nombre+descripcion de cada skill real, NUNCA el
  // cuerpo completo (eso es nivel 2, solo via load_skill(name) bajo
  // demanda). Ubicado junto a AGENTS.md (guia estatica del proyecto/
  // workspace), antes de la memoria dinamica de la conversacion (topics/
  // resumen/todos mas abajo).
  if (envelope.skills && envelope.skills.length > 0) {
    lines.push('', 'Skills disponibles (usa load_skill(name) para ver el procedimiento completo de una):')
    for (const skill of envelope.skills) {
      lines.push(`- ${skill.name}: ${skill.description}`)
    }
  }

  // Fase 6/11: bloque estructurado ANTES del resumen narrativo — decisions/
  // constraints/nextSteps son datos duros (no se resumen, no se pierden),
  // separados a proposito del texto libre de "summary" para que el modelo
  // los trate como hechos, no como prosa a reinterpretar. Desde Fase 11
  // van agrupados por tema (un heading por tema) en vez de listas planas
  // unicas — el resumen narrativo (mas abajo) sigue exactamente igual,
  // sin agrupar por tema.
  const topics = envelope.topics ?? {}
  const topicNames = Object.keys(topics)
  if (topicNames.length > 0) {
    lines.push('', 'Memoria por tema:')
    for (const topicName of topicNames) {
      const topic = topics[topicName]
      const decisions = topic.decisions.map(item => item.trim()).filter(Boolean)
      const constraints = topic.constraints.map(item => item.trim()).filter(Boolean)
      const nextSteps = topic.nextSteps.map(item => item.trim()).filter(Boolean)
      if (decisions.length === 0 && constraints.length === 0 && nextSteps.length === 0) continue
      lines.push('', `## ${topicName}`)
      for (const decision of decisions) lines.push(`- [decision] ${decision}`)
      for (const constraint of constraints) lines.push(`- [restriccion] ${constraint}`)
      for (const step of nextSteps) lines.push(`- [proximo paso] ${step}`)
    }
  }

  const summary = cleanText(envelope.compactSummary ?? '')
  if (summary) {
    lines.push('', 'Resumen acumulado:', summary)
  }

  // Tool "todo_write" (docs/_arch/verify_todo_write_design.md): mismo
  // criterio que el bloque de "Memoria por tema" de arriba -- vacio/undefined
  // = no renderizar nada (un chat que nunca llamo todo_write no ve ningun
  // bloque nuevo). Ubicado despues del resumen/memoria por tema y ANTES del
  // historial: es el estado de trabajo mas reciente/volatil del turno
  // actual, lo ultimo que el modelo lee antes del historial/mensaje actual.
  if (envelope.todos && envelope.todos.length > 0) {
    lines.push('', 'Lista de tareas (todo_write):')
    for (const todo of envelope.todos) {
      const marker = todo.status === 'completed' ? '[x]' : todo.status === 'in_progress' ? '[~]' : '[ ]'
      const priority = todo.priority ? ` (prioridad: ${todo.priority})` : ''
      lines.push(`- ${marker} ${todo.content}${priority}`)
    }
  }

  // "Modo plan" (docs/_arch/verify_plan_mode_design.md): mismo criterio
  // undefined/false = nada. Redactado deliberadamente sin asumir que la
  // tool exit_plan_mode este disponible -- este mismo bloque tambien lo
  // ve el runtime CLI (unico consumidor real de formatContextEnvelope(),
  // ver comentario de memoryBlockText() en api-agent-runtime.ts), que NUNCA
  // tiene esa tool (TOOL_DEFINITIONS solo se importa en api-agent-runtime.ts,
  // confirmado con grep) -- instruir "llama a X" a un runtime sin esa tool
  // seria un bug real, no solo un texto de mas.
  if (envelope.planModeActive) {
    lines.push(
      '',
      'MODO PLAN ACTIVO -- explora y disena antes de escribir archivos o ejecutar comandos.',
      envelope.planModeEnforced
        ? 'Tu sandbox real esta forzado a solo lectura mientras dure el plan -- escribir/ejecutar va a ser rechazado.'
        : 'Tecnicamente podrias escribir/ejecutar, pero NO lo hagas todavia.',
      'Si tenes disponible la tool exit_plan_mode, usala para presentar tu plan completo y esperar aprobacion explicita antes de ejecutar nada. Si no la tenes disponible, resumi el plan completo en tu respuesta de texto y esperá una confirmacion clara del usuario antes de proceder.'
    )
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
