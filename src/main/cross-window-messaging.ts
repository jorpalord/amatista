// Mensajeria entre ventanas, Paso 2: el motor que corre un turno real en
// OTRO panel desde el proceso main, y entrega el resultado al panel de
// origen. El mensaje se persiste como un mensaje de asistente normal, con
// el providerId/modelId/runtime reales de quien lo genero (mismos campos
// que ya usa cualquier mensaje guardado desde el flujo normal del
// renderer).
//
// Fase Paneles-1: todos los identificadores pasan de `windowId: number`
// (BrowserWindow.id) a `panelId: string` (crypto.randomUUID(), generado
// por el renderer) -- mismo cambio de tipo que ipc-agent.ts/runtime-state.ts.
import { randomUUID } from 'node:crypto'
import { findChatSessionByTitle, saveChatMessage } from './chat-store'
import { getSession, sendToWindow, sessionRegistry } from './runtime-state'
import { runTurnForWindow, type RunTurnPayload } from './ipc-agent'
import type { CrossWindowMeta, ProviderType } from '../shared/types'

/** Canal nuevo, deliberadamente NO reusa 'agent:event'. Investigado antes
 *  de elegir: handleAgentEvent() (App.tsx) esta armado enteramente
 *  alrededor de "esto es MI turno en curso" -- arranca/actualiza
 *  turnActive, acumula deltas por itemId, cierra el watchdog en
 *  turn/completed, decide agentState segun el tipo de evento, etc.
 *  Forzar un mensaje ya-completo por ese canal significaria fingir un
 *  ciclo de vida entero de turno (turn/started, deltas falsos,
 *  turn/completed) para un mensaje que en ESTE panel nunca corrio
 *  ningun turno propio -- alto riesgo de pisar el estado de un turno
 *  REAL que ese panel si tenga en vuelo. Canal separado, payload
 *  minimo: el StoredChatMessage ya persistido tal cual, el panel de
 *  origen no necesita reconstruir nada, solo mostrarlo. */
export const INCOMING_MESSAGE_CHANNEL = 'chat:incomingMessage'

export interface DeliverResultParams {
  originPanelId: string
  originChatId: string
  text: string
  providerId?: string
  modelId?: string
  runtime?: string
  /** Mensajeria entre ventanas, Paso 3, Tarea 4: presente SOLO cuando este
   *  mensaje llega via la tool send_to_window -- ver CrossWindowMeta
   *  (shared/types.ts). Un mensaje de un panel desconectando/eventos
   *  varios no persistidos por esta funcion nunca lo tiene. */
  crossWindow?: CrossWindowMeta
}

/** Mensajeria entre ventanas, Paso 2, Tarea 2: persiste el resultado de un
 *  turno cross-window como mensaje real (saveChatMessage, invocable
 *  directo desde main, confirmado en la investigacion previa -- sin pasar
 *  por el IPC chats:saveMessage) en el chat del panel de ORIGEN, y le
 *  avisa a ese panel que le llego un mensaje nuevo que no es de su
 *  propio turno. Devuelve el mensaje persistido tal cual quedo en SQLite
 *  -- mismo objeto que se manda por el canal, para que quien llame pueda
 *  confirmar sin tener que releer la base. */
export function deliverResultToOriginWindow(params: DeliverResultParams): ReturnType<typeof saveChatMessage> {
  const message = saveChatMessage({
    id: randomUUID(),
    chatId: params.originChatId,
    role: 'assistant',
    text: params.text,
    providerId: params.providerId,
    modelId: params.modelId,
    runtime: params.runtime,
    crossWindow: params.crossWindow
  })
  sendToWindow(params.originPanelId, INCOMING_MESSAGE_CHANNEL, message as unknown as Record<string, unknown>)
  return message
}

export interface SendMessageToWindowParams {
  destinationPanelId: string
  message: RunTurnPayload
  originPanelId: string
  originChatId: string
  /** Mensajeria entre ventanas, Paso 3: reenviado tal cual a
   *  deliverResultToOriginWindow() -- ver DeliverResultParams. */
  crossWindow?: CrossWindowMeta
}

/** Mensajeria entre ventanas, Paso 2, Tarea 3: el motor completo. Dispara
 *  un turno real en el panel destino (runTurnForWindow) y, cuando completa
 *  con texto real, entrega el resultado al panel de origen (Tarea 2). Si
 *  el turno no devuelve texto (cancelado sin texto parcial, por ejemplo)
 *  no entrega nada -- no tiene sentido persistir un mensaje vacio. */
export async function sendMessageToWindow(params: SendMessageToWindowParams): Promise<ReturnType<typeof saveChatMessage> | null> {
  const result = await runTurnForWindow(params.destinationPanelId, params.message)
  if (!result.success || !result.text) return null

  const destinationSession = getSession(params.destinationPanelId)
  return deliverResultToOriginWindow({
    originPanelId: params.originPanelId,
    originChatId: params.originChatId,
    text: result.text,
    providerId: destinationSession.provider?.id,
    modelId: destinationSession.model?.id,
    runtime: destinationSession.activeRuntime ?? undefined,
    crossWindow: params.crossWindow
  })
}

/** Fase Paneles-1, CASO ESPECIAL: reemplaza resolveOrOpenWindowForChat()
 *  (Paso 3, que llamaba createAppWindow() para abrir una BrowserWindow
 *  nueva cuando el destino no estaba abierto en ninguna). Bajo el modelo
 *  de paneles, main YA NO PUEDE "abrir un panel nuevo" -- un panel es un
 *  nodo del arbol de React de la UNICA pagina que ya existe, no algo que
 *  main pueda crear con un constructor. Abrir uno desde main real
 *  requeriria un handshake asincrono con el renderer (pedir, esperar a que
 *  el renderer lo monte y se registre) -- eso es Paneles-3, sin diseñar
 *  todavia (ver docs/_arch/verify_panels_scope.md, Parte C).
 *
 *  REGRESION TEMPORAL CONOCIDA, documentada, no silenciosa: por ahora, el
 *  UNICO destino alcanzable es un chat que YA tiene un panel conectado EN
 *  VIVO -- se busca escaneando `sessionRegistry` directo (el propio
 *  `activeChatId` de cada sesion), sin ningun registro aparte. El registro
 *  que existia para esto (`WindowEntry.chatId`, actualizado via
 *  `window:setActiveChatId`, el entregable de Mensajeria Paso 1) se retiro
 *  en esta misma fase por depender de `windowRegistry` (ver Tarea 5) -- no
 *  hay reemplazo funcional todavia, asi que esta busqueda puede no
 *  encontrar un panel que el usuario SI tiene abierto si cambio de chat
 *  dentro de esa sesion sin reconectar (`session.activeChatId` solo se
 *  actualiza en `agent:connect`, no en cada cambio de chat en pantalla --
 *  mismo caveat que ya existia antes de esta fase, no introducido aca).
 *
 *  El guard viejo de "provider_id/model_id NULL en la DB" (Paso 3) queda
 *  SUBSUMIDO por este: sin auto-apertura, lo unico que importa es si hay
 *  un panel EN VIVO conectado a ese chat ahora mismo -- un chat con
 *  provider/model persistidos de un turno viejo pero sin ningun panel
 *  conectado hoy es, de todas formas, inalcanzable. */
function findConnectedPanelForChat(chatId: string): string | null {
  for (const [panelId, session] of sessionRegistry) {
    if (session.activeChatId === chatId && session.activeRuntime) return panelId
  }
  return null
}

export interface SendToWindowByTitleParams {
  originPanelId: string
  destinationTitle: string
  message: string
}

export type SendToWindowByTitleResult =
  | { ok: true; text: string }
  | { ok: false; error: string }

/** Mensajeria entre ventanas, Paso 3 (ajustada para el CASO ESPECIAL de
 *  Paneles-1): orquesta todo lo que la tool send_to_window necesita
 *  DESPUES de que ya se aprobo el envio (tool-registry.ts llama a
 *  ctx.confirm() ANTES de invocar esto -- esta funcion nunca vuelve a
 *  pedir aprobacion). */
export async function sendToWindowByTitle(params: SendToWindowByTitleParams): Promise<SendToWindowByTitleResult> {
  const originSession = getSession(params.originPanelId)
  if (!originSession.activeChatId) {
    return { ok: false, error: 'La ventana de origen no tiene un chat activo para recibir la respuesta.' }
  }

  const match = findChatSessionByTitle(params.destinationTitle)
  if (!match) {
    return { ok: false, error: `No existe ningun chat con el titulo "${params.destinationTitle}".` }
  }
  // UI Paso 1: proteccion de auto-envio -- en el punto MAS TEMPRANO posible
  // (recien se conoce match.id, ningun efecto secundario disparado
  // todavia). Comparacion de chatId, no de titulo -- mismo chat puede
  // tener duplicados de titulo (findChatSessionByTitle() ya resuelve al
  // mas reciente), asi que comparar por id es la unica forma correcta de
  // detectar "es MI propio chat".
  if (match.id === originSession.activeChatId) {
    return { ok: false, error: 'No podes mandarte un mensaje a tu propio chat.' }
  }

  // CASO ESPECIAL Paneles-1 (ver findConnectedPanelForChat mas arriba):
  // sin auto-apertura de panel, el unico destino valido es uno YA
  // conectado en vivo ahora mismo.
  const targetPanelId = findConnectedPanelForChat(match.id)
  if (!targetPanelId) {
    return {
      ok: false,
      error:
        `El chat "${params.destinationTitle}" no esta abierto en ningun panel activo -- ` +
        'mensajeria a un chat sin panel abierto todavia no esta soportada con paneles. Abrilo vos primero.'
    }
  }

  const destinationSession = getSession(targetPanelId)
  const providerType: ProviderType | undefined = destinationSession.provider?.type

  try {
    const delivered = await sendMessageToWindow({
      destinationPanelId: targetPanelId,
      originPanelId: params.originPanelId,
      originChatId: originSession.activeChatId,
      message: {
        text: params.message,
        chatId: match.id,
        providerId: destinationSession.provider?.id ?? '',
        modelId: destinationSession.model?.id ?? '',
        sandbox: 'workspace-write'
      },
      crossWindow: {
        direction: 'received',
        windowLabel: params.destinationTitle,
        providerType
      }
    })
    if (!delivered) {
      return { ok: false, error: 'El turno en la ventana destino no devolvio texto (pudo haberse cancelado).' }
    }
    return { ok: true, text: delivered.text }
  } catch (error) {
    return { ok: false, error: `Fallo el turno en la ventana destino: ${error instanceof Error ? error.message : String(error)}` }
  }
}
