// Orquestador fan-out/fan-in real para la tool parallel_ask
// (docs/_arch/verify_parallel_orchestrator_design.md). Reusa SOLO la capa 1
// de send_to_window -- runTurnForWindow() (ipc-agent.ts), el motor real que
// corre un turno en CUALQUIER panel desde main -- nunca las capas 2/3 de
// entrega asincrona cross-chat (deliverResultToOriginWindow()/
// INCOMING_MESSAGE_CHANNEL, cross-window-messaging.ts): el resultado de
// parallel_ask vuelve SINCRONICO como el output de la tool al turno que la
// llamo, nunca como un mensaje separado en otro chat.
//
// Nunca ejecuta codigo escrito por el modelo -- el modelo solo entrega N
// strings (subtasks) via la tool; el fan-out entero corre en este archivo
// contra runTurnForWindow(), ya auditado, con args que son texto plano.
//
// Importa runTurnForWindow ESTATICO desde ipc-agent.ts (mismo patron que
// cross-window-messaging.ts, Fase Mensajeria Paso 2) -- el import inverso
// (ipc-agent.ts -> este modulo) tiene que ser DINAMICO dentro del closure
// que arma el toolExecutor, mismo motivo exacto ya documentado para
// sendToWindowByTitle (ipc-agent.ts): evita un ciclo de evaluacion real, ya
// que runtime-state.ts importa tool-registry.ts (para el singleton
// `toolRegistry`) e ipc-agent.ts importa runtime-state.ts -- si este modulo
// fuera importado ESTATICO desde tool-registry.ts, el ciclo se cerraria
// (runtime-state -> tool-registry -> parallel-orchestrator -> ipc-agent ->
// runtime-state). Por eso tool-registry.ts importa de este archivo SOLO
// tipos (`import type`, erasado por completo, nunca genera un require en
// tiempo de ejecucion) -- confirmado como el mismo criterio que ya evito
// este ciclo para sendToWindowByTitle (ver el comentario real en
// tool-registry.ts, ExecuteContext.sendToWindowByTitle).
import { getChatTitle, panelAliasForTitle } from './chat-store'
import type { RunTurnPayload } from './ipc-agent'
import { runTurnForWindow } from './ipc-agent'
import { cancelSessionTurn, sessionRegistry, type SessionRuntimeState } from './runtime-state'

export interface ParallelSubtaskAssignment {
  subtask: string
  panelId: string
  panelLabel: string
  providerId: string
  modelId: string
  modelLabel: string
}

export type ParallelPlanResult =
  | { ok: true; assignments: ParallelSubtaskAssignment[] }
  | { ok: false; error: string }

/**
 * Tarea 2 (verify_parallel_orchestrator_design.md): generalizacion real de
 * findConnectedPanelForChat() (cross-window-messaging.ts) -- un panel
 * "disponible para repartir" cumple LAS 4 condiciones:
 *  1. activeRuntime seteado (conectado de verdad, no una entrada vacia que
 *     getSession() crea perezosamente para cualquier panelId consultado).
 *  2. activeChatId real (necesario ademas para poder etiquetarlo con su
 *     titulo real, ver labelForPanel() mas abajo).
 *  3. NUNCA el panel de origen -- Tarea 1: jamas 2 turnos concurrentes en
 *     el mismo panel (los campos de instancia de ApiAgentRuntime que se
 *     resetean en cada send() se pisarian entre el turno de origen y una
 *     sub-tarea repartida al mismo panel).
 *  4. IDLE -- currentTurnAbort null, sin turno propio en vuelo. No le pisa
 *     al usuario un turno que este corriendo a mano en otro panel.
 */
function idlePanels(originPanelId: string): Array<{ panelId: string; session: SessionRuntimeState }> {
  const result: Array<{ panelId: string; session: SessionRuntimeState }> = []
  for (const [panelId, session] of sessionRegistry) {
    if (panelId === originPanelId) continue
    if (!session.activeRuntime) continue
    if (!session.activeChatId) continue
    if (session.currentTurnAbort) continue
    if (!session.provider || !session.model) continue
    result.push({ panelId, session })
  }
  return result
}

function labelForPanel(session: SessionRuntimeState, panelId: string): string {
  const title = session.activeChatId ? getChatTitle(session.activeChatId) : null
  if (!title) return panelId
  return panelAliasForTitle(title) ?? title
}

function labelForModel(session: SessionRuntimeState): string {
  return session.model?.displayName || session.model?.model || 'modelo desconocido'
}

/**
 * Decision final confirmada por el usuario: SOLO paneles YA conectados,
 * sin auto-abrir ninguno (fuera de alcance). Round-robin real -- si hay mas
 * sub-tareas que paneles idle, un panel recibe mas de una (se ejecutan en
 * SECUENCIA dentro de ese panel, ver runParallelAsk() mas abajo, nunca
 * concurrentes entre si). Planificacion 100% sincrona -- no dispara ningun
 * turno todavia, tool-registry.ts la usa para armar el detalle completo del
 * dialogo de aprobacion ANTES de pedir confirmacion (Tarea 5).
 */
export function planParallelAsk(originPanelId: string, subtasks: string[]): ParallelPlanResult {
  const panels = idlePanels(originPanelId)
  if (panels.length === 0) {
    return {
      ok: false,
      error:
        'No hay ningun otro panel conectado e inactivo ahora mismo para repartir sub-tareas -- conecta al menos ' +
        'un panel adicional (o esperá a que el que ya tenés termine su turno actual) antes de usar parallel_ask.'
    }
  }
  const assignments = subtasks.map((subtask, index) => {
    const { panelId, session } = panels[index % panels.length]
    return {
      subtask,
      panelId,
      panelLabel: labelForPanel(session, panelId),
      providerId: session.provider!.id,
      modelId: session.model!.id,
      modelLabel: labelForModel(session)
    }
  })
  return { ok: true, assignments }
}

export interface ParallelAskOutcome {
  subtask: string
  panelLabel: string
  modelLabel: string
  ok: boolean
  text?: string
  error?: string
}

/**
 * Tarea 4: Promise.allSettled real -- una sub-tarea que falla/cancela NUNCA
 * aborta a las demas, cada resultado (exito o error) vuelve etiquetado.
 * Ejecucion agrupada por panel: dentro de UN panel, las sub-tareas
 * asignadas corren en SECUENCIA (regla no negociable de Tarea 1 -- nunca 2
 * turnos concurrentes en el mismo panel); entre paneles DISTINTOS, corren
 * en paralelo real (cada grupo es una promesa independiente, arrancan
 * todas de una via Promise.allSettled sobre el array de grupos).
 *
 * `originSignal` -- AbortSignal del turno de ORIGEN (el que llamo a
 * parallel_ask), decision del usuario: abortar TODO solo si se cancela ese
 * turno, con cascada real a los sub-turnos hijos. Mecanismo: cada panel con
 * un sub-turno ACTIVO en este instante (activePanels) recibe
 * cancelSessionTurn() -- mismo mecanismo real que ya usa el boton Detener
 * para cualquier turno (runtime-state.ts) -- en vez de dejarlos corriendo
 * huerfanos. Sub-tareas todavia no arrancadas (en cola detras de otra en el
 * mismo panel) se marcan canceladas sin siquiera intentarse.
 */
export async function runParallelAsk(assignments: ParallelSubtaskAssignment[], originSignal?: AbortSignal): Promise<ParallelAskOutcome[]> {
  const byPanel = new Map<string, ParallelSubtaskAssignment[]>()
  for (const assignment of assignments) {
    const queue = byPanel.get(assignment.panelId)
    if (queue) queue.push(assignment)
    else byPanel.set(assignment.panelId, [assignment])
  }

  const results = new Map<ParallelSubtaskAssignment, ParallelAskOutcome>()
  const activePanels = new Set<string>()
  const onOriginAbort = (): void => {
    for (const panelId of activePanels) cancelSessionTurn(panelId)
  }
  originSignal?.addEventListener('abort', onOriginAbort)

  try {
    const perPanel = Array.from(byPanel.entries()).map(async ([panelId, queue]) => {
      for (const assignment of queue) {
        if (originSignal?.aborted) {
          results.set(assignment, {
            subtask: assignment.subtask,
            panelLabel: assignment.panelLabel,
            modelLabel: assignment.modelLabel,
            ok: false,
            error: 'Cancelado -- el turno que llamo a parallel_ask se cancelo antes de que esta sub-tarea arrancara.'
          })
          continue
        }
        activePanels.add(panelId)
        try {
          const payload: RunTurnPayload = {
            text: assignment.subtask,
            providerId: assignment.providerId,
            modelId: assignment.modelId,
            // Mismo placeholder que sendToWindowByTitle() ya usa
            // (cross-window-messaging.ts): runTurnForWindow() no lee
            // payload.sandbox (confirmado con grep, campo requerido por el
            // tipo RunTurnPayload pero sin consumidor real dentro de esa
            // funcion) -- el sandbox real que aplica es session.sandbox del
            // panel DESTINO, ya vivo desde que ese panel se conecto.
            sandbox: 'workspace-write'
          }
          const result = await runTurnForWindow(panelId, payload)
          results.set(assignment, {
            subtask: assignment.subtask,
            panelLabel: assignment.panelLabel,
            modelLabel: assignment.modelLabel,
            ok: Boolean(result.success && result.text && !result.cancelled),
            text: result.text,
            error: !result.success
              ? 'El turno fallo sin mas detalle.'
              : result.cancelled
                ? `Cancelado${result.text ? ` (texto parcial: ${result.text})` : ' (sin texto parcial)'}.`
                : !result.text
                  ? 'El turno no devolvio texto (pudo haberse cancelado del lado del panel destino).'
                  : undefined
          })
        } catch (error) {
          results.set(assignment, {
            subtask: assignment.subtask,
            panelLabel: assignment.panelLabel,
            modelLabel: assignment.modelLabel,
            ok: false,
            error: error instanceof Error ? error.message : String(error)
          })
        } finally {
          activePanels.delete(panelId)
        }
      }
    })
    await Promise.allSettled(perPanel)
  } finally {
    originSignal?.removeEventListener('abort', onOriginAbort)
  }

  return assignments.map(a => results.get(a)!)
}
