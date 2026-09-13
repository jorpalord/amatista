// Canal de aprobacion Y orquestacion para el servidor MCP propio de Amatista
// (mcp-lsp-server.ts) -- ver docs/_arch/verify_mcp_approval.md para el diseno
// original (solo aprobacion) y docs/_arch/verify_subscription_orchestrator_design.md
// para la generalizacion de esta fase (orquestacion por suscripcion: paneles
// conectados por claude-cli/antigravity-cli pueden ahora usar send_to_window/
// parallel_ask, no solo ser destino). Un named pipe de Windows
// (\\.\pipe\amatista-mcp-approval), UN solo listener para toda la app
// (mismo principio que sendToWindow(panelId, ...): un proceso, N paneles
// distinguidos por dato en el mensaje, no por canal separado). NDJSON de
// una linea por mensaje, una conexion por request -- el cliente (el servidor
// MCP standalone, proceso nieto de main) abre, escribe una linea, lee UNA
// linea de respuesta, cierra. Este archivo corre DENTRO de Electron main
// (importado por index.ts) -- el proceso nieto (mcp-lsp-server.cjs) nunca
// importa nada de aca directo: solo habla el protocolo NDJSON por socket,
// nunca conoce sessionRegistry/chat-store/parallel-orchestrator (mismo
// motivo por el que ese archivo duplica en vez de importar utilidades
// chicas -- ver su propio comentario de cabecera).
//
// Protocolo real (un campo `action` decide el resto del shape del mensaje):
//
//   confirm         {panelId, action:'confirm', title, detail, toolName?}
//                   -> {approved: boolean, error?: string}
//     `toolName` es OPCIONAL -- ausente, este action se comporta identico
//     al pipe original (solo aprobacion, sin gate de principal ni eventos de
//     watchdog): deja la puerta abierta a un futuro consumidor generico que
//     solo necesite un dialogo si/no. Presente ('send_to_window' |
//     'parallel_ask'), dispara el gate de panel-principal (Tarea 4) y el
//     par de eventos de watchdog phase:start/done (Tarea 6) alrededor de
//     TODO el flujo (confirm + ejecucion), no solo de este mensaje.
//
//   sendToWindow    {panelId, action:'sendToWindow', destino, mensaje}
//                   -> {ok: true, text} | {ok: false, error}
//     Ejecucion real de send_to_window -- SOLO se llama despues de que el
//     cliente ya paso por un `confirm` con toolName:'send_to_window'
//     aprobado. Vuelve a re-verificar el gate igual (nunca confiar en que
//     el proceso hijo no reordeno los pasos).
//
//   planParallelAsk {panelId, action:'planParallelAsk', subtasks: string[]}
//                   -> {ok: true, assignments} | {ok: false, error}
//     Planificacion SINCRONICA real (parallel-orchestrator.ts) -- el
//     cliente arma el texto del dialogo de aprobacion con `assignments`
//     (mismo criterio que tool-registry.ts: el "case" de cada tool arma su
//     propio texto de salida, la orquestacion real solo devuelve datos).
//
//   runParallelAsk  {panelId, action:'runParallelAsk', assignments}
//                   -> {ok: true, outcomes} | {ok: false, error}
//     Ejecucion real -- SOLO despues de un `confirm` con
//     toolName:'parallel_ask' aprobado (el cliente re-manda los mismos
//     `assignments` que planParallelAsk le devolvio, esta conexion no
//     comparte estado con la anterior).
//
// Gate de panel-principal (Tarea 4, verify_subscription_orchestrator_design.md):
// CADA action que dispara orquestacion real (confirm con toolName, sendToWindow,
// planParallelAsk, runParallelAsk) resuelve `sessionRegistry.get(panelId)` y
// llama a `isPrincipalChat(session.activeChatId)` DE NUEVO aca -- el
// `panelId` viaja fijo en el `env` del proceso hijo desde el spawn
// (mismo patron que AMATISTA_MCP_WORKSPACE), pero su legitimidad para
// orquestar SOLO se confia si main la recalcula del lado seguro. El
// servidor MCP tambien decide de antemano si declara estas 2 tools
// (env AMATISTA_IS_PRINCIPAL, cli-agent-runtime.ts) -- esto es la
// PRIMERA linea de defensa (UX: la tool ni aparece), este gate es el
// backstop real que nunca se puede saltear.
//
// Watchdog (Tarea 6): un origen CLI esperando una orquestacion en curso no
// tiene forma de emitir 'item/toolCall/status' el mismo (CliAgentRuntime
// nunca emite 'toolStatus', ver PENDING.md) -- este handler lo emite DIRECTO
// via sendSessionEvent() en los puntos reales de inicio/fin de cada flujo,
// mismo evento real que ya pausa/reanuda el watchdog del renderer para
// runtimes API (wireApi() -> runtime.on('toolStatus', ...)). Cierra
// UNICAMENTE el caso puntual de "orquestacion en curso" -- el gap general
// de actividad interna del propio CLI (sus tools nativas Read/Bash/etc,
// invisibles para Amatista) sigue documentado y fuera de alcance en
// PENDING.md, sin tocar wireCli()/CliAgentRuntime en absoluto.
import { createServer, type Socket } from 'node:net'
import { isPrincipalChat } from './chat-store'
import { requestSessionToolApproval, sendSessionEvent, sessionRegistry } from './runtime-state'
import type { ParallelAskOutcome, ParallelSubtaskAssignment } from './parallel-orchestrator'

export const MCP_APPROVAL_PIPE_PATH =
  process.platform === 'win32' ? '\\\\.\\pipe\\amatista-mcp-approval' : '/tmp/amatista-mcp-approval.sock'

type OrchestratorToolName = 'send_to_window' | 'parallel_ask'

interface ConfirmRequest {
  panelId: string
  action: 'confirm'
  title: string
  detail: string
  toolName?: OrchestratorToolName
}

interface SendToWindowRequest {
  panelId: string
  action: 'sendToWindow'
  destino: string
  mensaje: string
}

interface PlanParallelAskRequest {
  panelId: string
  action: 'planParallelAsk'
  subtasks: string[]
}

interface RunParallelAskRequest {
  panelId: string
  action: 'runParallelAsk'
  assignments: ParallelSubtaskAssignment[]
}

type PipeRequest = ConfirmRequest | SendToWindowRequest | PlanParallelAskRequest | RunParallelAskRequest

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

/** Sin validacion estructural profunda a proposito (mismo criterio que el
 *  pipe original) -- cada handler de abajo revalida los campos puntuales
 *  que necesita antes de usarlos, este parseo solo decide QUE action es. */
function parseRequest(raw: string): PipeRequest | null {
  try {
    const parsed = JSON.parse(raw) as Partial<PipeRequest> & { action?: unknown }
    if (!isNonEmptyString(parsed.panelId)) return null
    switch (parsed.action) {
      case 'confirm': {
        const p = parsed as Partial<ConfirmRequest>
        if (!isNonEmptyString(p.title) || typeof p.detail !== 'string') return null
        return { panelId: parsed.panelId, action: 'confirm', title: p.title, detail: p.detail, toolName: p.toolName }
      }
      case 'sendToWindow': {
        const p = parsed as Partial<SendToWindowRequest>
        if (!isNonEmptyString(p.destino) || !isNonEmptyString(p.mensaje)) return null
        return { panelId: parsed.panelId, action: 'sendToWindow', destino: p.destino, mensaje: p.mensaje }
      }
      case 'planParallelAsk': {
        const p = parsed as Partial<PlanParallelAskRequest>
        if (!Array.isArray(p.subtasks)) return null
        return { panelId: parsed.panelId, action: 'planParallelAsk', subtasks: p.subtasks.map(String) }
      }
      case 'runParallelAsk': {
        const p = parsed as Partial<RunParallelAskRequest>
        if (!Array.isArray(p.assignments)) return null
        return { panelId: parsed.panelId, action: 'runParallelAsk', assignments: p.assignments as ParallelSubtaskAssignment[] }
      }
      default:
        return null
    }
  } catch {
    return null
  }
}

/** Tarea 4: unica fuente de verdad del lado de main -- re-verifica contra la
 *  sesion VIVA, nunca contra lo que el proceso hijo afirme. `false` tanto si
 *  el panel no existe (sesion nunca registrada, o ya desconectada) como si
 *  existe pero no es el principal de su grupo. */
function isPanelAllowedToOrchestrate(panelId: string): boolean {
  const session = sessionRegistry.get(panelId)
  return Boolean(session && isPrincipalChat(session.activeChatId ?? ''))
}

const NOT_PRINCIPAL_ERROR =
  'Este panel no es el chat principal de su grupo -- la orquestacion por suscripcion (send_to_window/parallel_ask) solo esta disponible ahi.'

function emitToolStatus(panelId: string, name: OrchestratorToolName, phase: 'start' | 'done'): void {
  sendSessionEvent(panelId, { kind: 'notification', method: 'item/toolCall/status', params: { name, phase } })
}

/** Mismo formato real que formatParallelPlanDetail() (tool-registry.ts) --
 *  duplicado a proposito, no importado: ese archivo arrastra un arbol de
 *  imports (VCS, generacion de imagenes, lectura de documentos) ajeno a
 *  este pipe chico, mismo criterio de duplicacion ya establecido en
 *  mcp-lsp-server.ts. */
async function handleConfirm(request: ConfirmRequest): Promise<{ approved: boolean; error?: string }> {
  if (!request.toolName) {
    // Camino original, sin cambios: confirm generico, sin gate, sin eventos
    // de watchdog -- deja la puerta abierta a un futuro consumidor no
    // orientado a orquestacion.
    const approved = await requestSessionToolApproval(request.panelId, request.title, request.detail)
    return { approved }
  }

  if (!isPanelAllowedToOrchestrate(request.panelId)) {
    return { approved: false, error: NOT_PRINCIPAL_ERROR }
  }

  emitToolStatus(request.panelId, request.toolName, 'start')
  const approved = await requestSessionToolApproval(request.panelId, request.title, request.detail)
  // Si rechazo, el flujo termina ACA -- ningun otro mensaje real (sendToWindow/
  // runParallelAsk) va a llegar para este tool call, asi que 'done' se emite
  // ya mismo. Si aprobo, el 'done' lo emite el handler de ejecucion real.
  if (!approved) emitToolStatus(request.panelId, request.toolName, 'done')
  return { approved }
}

async function handleSendToWindow(request: SendToWindowRequest): Promise<{ ok: boolean; text?: string; error?: string }> {
  if (!isPanelAllowedToOrchestrate(request.panelId)) {
    emitToolStatus(request.panelId, 'send_to_window', 'done')
    return { ok: false, error: NOT_PRINCIPAL_ERROR }
  }
  try {
    const { sendToWindowByTitle } = await import('./cross-window-messaging.js')
    const result = await sendToWindowByTitle({
      originPanelId: request.panelId,
      destinationTitle: request.destino,
      message: request.mensaje
    })
    return result.ok ? { ok: true, text: result.text } : { ok: false, error: result.error }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  } finally {
    emitToolStatus(request.panelId, 'send_to_window', 'done')
  }
}

async function handlePlanParallelAsk(
  request: PlanParallelAskRequest
): Promise<{ ok: boolean; assignments?: ParallelSubtaskAssignment[]; error?: string }> {
  if (!isPanelAllowedToOrchestrate(request.panelId)) {
    // Sin 'start' emitido todavia (nada arranco de verdad para el
    // watchdog) -- fallo instantaneo, ni siquiera intenta planificar.
    return { ok: false, error: NOT_PRINCIPAL_ERROR }
  }
  emitToolStatus(request.panelId, 'parallel_ask', 'start')
  try {
    const { planParallelAsk } = await import('./parallel-orchestrator.js')
    const plan = planParallelAsk(request.panelId, request.subtasks)
    if (!plan.ok) {
      // El flujo termina aca (no hay confirm/run despues de un plan
      // fallido) -- cerrar el par start/done ya mismo.
      emitToolStatus(request.panelId, 'parallel_ask', 'done')
      return { ok: false, error: plan.error }
    }
    return { ok: true, assignments: plan.assignments }
  } catch (error) {
    emitToolStatus(request.panelId, 'parallel_ask', 'done')
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

async function handleRunParallelAsk(
  request: RunParallelAskRequest
): Promise<{ ok: boolean; outcomes?: ParallelAskOutcome[]; error?: string }> {
  if (!isPanelAllowedToOrchestrate(request.panelId)) {
    emitToolStatus(request.panelId, 'parallel_ask', 'done')
    return { ok: false, error: NOT_PRINCIPAL_ERROR }
  }
  try {
    const { runParallelAsk } = await import('./parallel-orchestrator.js')
    // Sin AbortSignal de origen: a diferencia del camino API (donde el
    // turno tiene un AbortSignal real ya vivo, ver ipc-agent.ts), un turno
    // CLI cancelado mata el proceso `claude`/`agy` entero -- no hay ninguna
    // señal viva que este handler pueda escuchar para cascadear el cancel a
    // los sub-turnos ya en vuelo en otros paneles. Brecha real conocida, no
    // silenciosa: si el usuario cancela un turno CLI a mitad de un
    // parallel_ask, las sub-tareas ya despachadas en otros paneles siguen
    // corriendo hasta terminar solas (mismo riesgo que ya existiria sin
    // este bridge, no introducido por el).
    const outcomes = await runParallelAsk(request.assignments)
    return { ok: true, outcomes }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  } finally {
    emitToolStatus(request.panelId, 'parallel_ask', 'done')
  }
}

function handleConnection(socket: Socket): void {
  let buffer = ''

  socket.on('data', chunk => {
    buffer += chunk.toString('utf8')
    const newlineIndex = buffer.indexOf('\n')
    if (newlineIndex === -1) return // linea todavia incompleta, sigue esperando

    const line = buffer.slice(0, newlineIndex)
    const request = parseRequest(line)

    if (!request) {
      socket.end(JSON.stringify({ ok: false, approved: false, error: 'request malformado' }) + '\n')
      return
    }

    // El bloqueo real pasa aca para 'confirm': requestSessionToolApproval()
    // no resuelve hasta que el humano responde en el renderer -- este
    // socket se mantiene abierto todo ese tiempo, sin polling. Para el
    // resto de las actions, el bloqueo es el trabajo real (correr un turno
    // en otro panel, repartir sub-tareas) -- mismo principio.
    const handler =
      request.action === 'confirm'
        ? handleConfirm(request)
        : request.action === 'sendToWindow'
          ? handleSendToWindow(request)
          : request.action === 'planParallelAsk'
            ? handlePlanParallelAsk(request)
            : handleRunParallelAsk(request)

    handler
      .then(response => socket.end(JSON.stringify(response) + '\n'))
      .catch(() => socket.end(JSON.stringify({ ok: false, approved: false, error: 'fallo interno resolviendo el pedido' }) + '\n'))
  })

  socket.on('error', () => {}) // conexion cortada del otro lado (proceso hijo matado, etc.) -- no tira la app
}

/** Arranca el listener UNA sola vez por vida de la app -- llamado desde
 *  index.ts al arrancar, mismo momento que la limpieza garantizada de
 *  Antigravity. Nunca lanza: si el pipe no se pudo abrir (instancia previa
 *  no cerro bien, o el nombre ya esta en uso), loguea y sigue -- no
 *  bloquea el arranque real de Amatista por esto. */
export function startMcpApprovalPipeServer(): void {
  const server = createServer(handleConnection)
  server.on('error', error => {
    console.error('[mcp-approval-pipe] no se pudo arrancar el listener:', error)
  })
  server.listen(MCP_APPROVAL_PIPE_PATH)
}
