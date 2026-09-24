// Test de regresion real: herramientas compuestas para los CLI via el pipe MCP (mcp-approval-pipe.ts). Levanta el
// listener REAL en el pipe de ESTE proceso, le habla por el socket real con el MISMO protocolo NDJSON que usa
// mcp-lsp-server.ts, y responde los dialogos reales igual que el renderer (agent:toolApproval:respond: saca el
// resolver de session.pendingToolApprovals y lo llama). Nada de la logica de aprobacion esta mockeada.
//
// Protege: (1) la creacion SIEMPRE pasa por hardConfirm (sin checkbox de confianza), tambien en danger-full-access;
// (2) una corrida pide UNA aprobacion con el alcance real en Workspace, y ninguna en danger-full-access (mismo
// principio que el camino API: nunca pregunta mas que la suma de sus pasos); (3) confinamiento al workspace, mismo
// mensaje de siempre; (4) runComposedTool solo corre recetas, nunca una tool suelta; (5) sin sesion conectada, nada.
// AMATISTA_STORAGE_ROOT llega ya seteado, real y aislado, por _support/run.cjs (la clave HMAC de las recetas vive ahi).
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { connect } from 'node:net'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { startMcpApprovalPipeServer, stopMcpApprovalPipeServer } from '../../src/main/mcp-approval-pipe'
import { MCP_APPROVAL_PIPE_PATH } from '../../src/main/mcp-pipe-name'
import { getSession, sessionRegistry } from '../../src/main/runtime-state'
import type { SandboxMode } from '../../src/shared/types'

const CHAT = 'chat-cli-composed'
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'amatista-cli-composed-'))
fs.mkdirSync(path.join(workspace, 'src'))
fs.writeFileSync(path.join(workspace, 'src', 'a.py'), 'print(1)\nprint(2)\n')
fs.writeFileSync(path.join(workspace, 'src', 'b.py'), 'x = 1\n')
fs.writeFileSync(path.join(workspace, 'src', 'notas.txt'), 'no es python\n')

startMcpApprovalPipeServer()
after(() => {
  stopMcpApprovalPipeServer()
  sessionRegistry.delete(CHAT)
  fs.rmSync(workspace, { recursive: true, force: true })
})

function connectedSession(sandbox: SandboxMode) {
  const session = getSession(CHAT)
  session.activeRuntime = 'claude'
  session.activeWorkspace = workspace
  session.activeChatId = CHAT
  session.sandbox = sandbox
  session.toolTrustSession = false
  return session
}

function pipe<T>(request: Record<string, unknown>): Promise<T> {
  return new Promise((resolve, reject) => {
    const socket = connect(MCP_APPROVAL_PIPE_PATH)
    let buffer = ''
    socket.on('connect', () => socket.write(JSON.stringify(request) + '\n'))
    socket.on('data', chunk => {
      buffer += chunk.toString('utf8')
      const newline = buffer.indexOf('\n')
      if (newline === -1) return
      socket.end()
      resolve(JSON.parse(buffer.slice(0, newline)) as T)
    })
    socket.on('error', reject)
  })
}

interface ApprovalSeen { title: string; detail: string; allowTrust: boolean }

/** Contesta los dialogos reales que vayan apareciendo mientras `pending` no resuelve -- mismo camino que el renderer. */
async function answeringApprovals<T>(pending: Promise<T>, answer: boolean): Promise<{ result: T; approvals: ApprovalSeen[] }> {
  const session = getSession(CHAT)
  const approvals: ApprovalSeen[] = []
  let settled = false
  const done = pending.finally(() => { settled = true })
  while (!settled) {
    for (const [id, resolve] of [...session.pendingToolApprovals]) {
      const event = session.eventLog.find(ev => ev.channel === 'agent:toolApproval' && ev.payload.id === id)
      assert.ok(event, 'un pedido de aprobacion tiene que haberse emitido al panel (buffer de eventos)')
      approvals.push({ title: String(event.payload.title), detail: String(event.payload.detail), allowTrust: event.payload.allowTrust === true })
      session.pendingToolApprovals.delete(id)
      resolve(answer)
    }
    await new Promise(r => setTimeout(r, 10))
  }
  return { result: await done, approvals }
}

const CONTAR = {
  name: 'contar_lineas_py',
  description: 'Escribe al lado de cada .py de una carpeta cuantas lineas tiene.',
  inputs: JSON.stringify([{ name: 'carpeta', description: 'Carpeta a revisar' }]),
  discover: JSON.stringify([
    { id: 'lista', tool: 'list_dir', args: { path: '{{input.carpeta}}' } },
    { id: 'leer', foreach: { in: '{{steps.lista.items}}', as: 'f', maxIterations: 20, where: { field: '{{f.name}}', op: 'endsWith', value: '.py' } }, steps: [{ id: 'leido', tool: 'read_file', args: { path: '{{f.path}}' } }] }
  ]),
  apply: JSON.stringify([
    { id: 'escribir', foreach: { in: '{{steps.leer.items}}', as: 'r', maxIterations: 20 }, steps: [{ id: 'w', tool: 'write_file', args: { path: '{{r.item.path}}.lineas.txt', content: 'lineas: {{r.leido.lines}}' } }] }
  ])
}

interface TextResponse { ok: boolean; text?: string; error?: string }

test('pipe CLI -- sin sesion conectada no lista, no propone ni corre nada', async () => {
  const session = connectedSession('danger-full-access')
  session.activeRuntime = null
  for (const request of [
    { panelId: CHAT, action: 'listComposedTools' },
    { panelId: CHAT, action: 'proposeComposedTool', args: CONTAR },
    { panelId: CHAT, action: 'runComposedTool', name: 'contar_lineas_py', args: { carpeta: 'src' } }
  ]) {
    const response = await pipe<TextResponse>(request)
    assert.equal(response.ok, false)
    assert.match(String(response.error), /no tiene una sesion conectada/)
  }
  assert.equal(session.pendingToolApprovals.size, 0)
})

test('pipe CLI -- proponer SIEMPRE pide hardConfirm (sin checkbox de confianza), tambien en danger-full-access; rechazar no guarda nada', async () => {
  connectedSession('danger-full-access')
  const rejected = await answeringApprovals(pipe<TextResponse>({ panelId: CHAT, action: 'proposeComposedTool', args: CONTAR }), false)
  assert.equal(rejected.result.ok, false)
  assert.equal(rejected.approvals.length, 1)
  assert.equal(rejected.approvals[0].allowTrust, false, 'la creacion es hardConfirm: el dialogo no ofrece "confiar en este agente"')
  assert.equal(fs.existsSync(path.join(workspace, '.amatista', 'composed-tools', 'contar_lineas_py.json')), false)

  const approved = await answeringApprovals(pipe<TextResponse>({ panelId: CHAT, action: 'proposeComposedTool', args: CONTAR }), true)
  assert.equal(approved.result.ok, true, JSON.stringify(approved.result))
  assert.equal(approved.approvals.length, 1)
  assert.equal(approved.approvals[0].title, 'Nueva herramienta: composed__contar_lineas_py')
  assert.equal(approved.approvals[0].allowTrust, false)
  assert.match(approved.approvals[0].detail, /Cada vez que se use, primero SOLO LEE/)
  const stored = JSON.parse(fs.readFileSync(path.join(workspace, '.amatista', 'composed-tools', 'contar_lineas_py.json'), 'utf8'))
  assert.match(String(stored.signature), /^[0-9a-f]{64}$/, 'la receta queda firmada con HMAC')

  // El watchdog del renderer se pausa durante TODO el flujo (dialogo humano incluido): par start/done real.
  const statuses = getSession(CHAT).eventLog
    .filter(ev => ev.payload.method === 'item/toolCall/status')
    .map(ev => `${(ev.payload.params as { name: string }).name}:${(ev.payload.params as { phase: string }).phase}`)
  assert.deepEqual(statuses.slice(-2), ['propose_composed_tool:start', 'propose_composed_tool:done'])
})

test('pipe CLI -- el catalogo solo trae recetas con firma valida', async () => {
  connectedSession('danger-full-access')
  const list = await pipe<{ ok: boolean; tools: Array<{ name: string; parameters: { properties: Record<string, unknown> } }> }>({ panelId: CHAT, action: 'listComposedTools' })
  assert.equal(list.ok, true)
  assert.deepEqual(list.tools.map(t => t.name), ['composed__contar_lineas_py'])
  assert.deepEqual(Object.keys(list.tools[0].parameters.properties), ['carpeta'])

  // Editada a mano fuera del flujo de aprobacion -> desaparece del catalogo.
  const file = path.join(workspace, '.amatista', 'composed-tools', 'contar_lineas_py.json')
  const original = fs.readFileSync(file, 'utf8')
  fs.writeFileSync(file, original.replace('"description": "Escribe', '"description": "Borra'))
  const tampered = await pipe<{ ok: boolean; tools: unknown[] }>({ panelId: CHAT, action: 'listComposedTools' })
  assert.deepEqual(tampered.tools, [])
  fs.writeFileSync(file, original)
})

test('pipe CLI -- en Workspace una corrida pide UNA aprobacion con el alcance real resuelto, y despues ejecuta', async () => {
  connectedSession('workspace-write')
  const run = await answeringApprovals(pipe<TextResponse>({ panelId: CHAT, action: 'runComposedTool', name: 'contar_lineas_py', args: { carpeta: 'src' } }), true)
  assert.equal(run.result.ok, true, run.result.text)
  assert.equal(run.approvals.length, 1, 'una sola aprobacion para toda la corrida')
  assert.equal(run.approvals[0].allowTrust, false, 'la aprobacion de la corrida no ofrece "confiar en este agente"')
  assert.match(run.approvals[0].title, /^Correr herramienta: contar_lineas_py -- 2 accion\(es\)$/)
  assert.match(run.approvals[0].detail, /src\/a\.py\.lineas\.txt/)
  assert.match(run.approvals[0].detail, /src\/b\.py\.lineas\.txt/)
  assert.doesNotMatch(run.approvals[0].detail, /notas\.txt\.lineas/, 'el filtro where del descubrimiento ya esta resuelto en el alcance')
  assert.equal(fs.readFileSync(path.join(workspace, 'src', 'a.py.lineas.txt'), 'utf8'), 'lineas: 2')
  assert.equal(fs.readFileSync(path.join(workspace, 'src', 'b.py.lineas.txt'), 'utf8'), 'lineas: 1')
})

test('pipe CLI -- TOCTOU: si un archivo que esta sesion escribio cambia afuera, la corrida se corta ANTES de pedir aprobacion', async () => {
  fs.writeFileSync(path.join(workspace, 'src', 'a.py.lineas.txt'), 'editado a mano')
  connectedSession('workspace-write')
  const run = await answeringApprovals(pipe<TextResponse>({ panelId: CHAT, action: 'runComposedTool', name: 'contar_lineas_py', args: { carpeta: 'src' } }), true)
  assert.equal(run.result.ok, false)
  assert.equal(run.approvals.length, 0)
  assert.match(String(run.result.text), /cambio en disco despues de que esta sesion lo leyo\/escribio/)
  assert.equal(fs.readFileSync(path.join(workspace, 'src', 'a.py.lineas.txt'), 'utf8'), 'editado a mano')
})

test('pipe CLI -- en Workspace, rechazar la corrida no ejecuta ninguna accion con efectos', async () => {
  fs.mkdirSync(path.join(workspace, 'src2'))
  fs.writeFileSync(path.join(workspace, 'src2', 'c.py'), 'y = 2\n')
  connectedSession('workspace-write')
  const run = await answeringApprovals(pipe<TextResponse>({ panelId: CHAT, action: 'runComposedTool', name: 'contar_lineas_py', args: { carpeta: 'src2' } }), false)
  assert.equal(run.result.ok, false)
  assert.equal(run.approvals.length, 1)
  assert.match(String(run.result.text), /rechazo la corrida/)
  assert.equal(fs.existsSync(path.join(workspace, 'src2', 'c.py.lineas.txt')), false)
})

test('pipe CLI -- en danger-full-access la corrida no pide aprobacion (igual que el camino API) y ejecuta', async () => {
  fs.mkdirSync(path.join(workspace, 'src3'))
  fs.writeFileSync(path.join(workspace, 'src3', 'd.py'), 'a = 1\nb = 2\nc = 3\n')
  connectedSession('danger-full-access')
  const run = await answeringApprovals(pipe<TextResponse>({ panelId: CHAT, action: 'runComposedTool', name: 'contar_lineas_py', args: { carpeta: 'src3' } }), false)
  assert.equal(run.result.ok, true, run.result.text)
  assert.equal(run.approvals.length, 0)
  assert.equal(fs.readFileSync(path.join(workspace, 'src3', 'd.py.lineas.txt'), 'utf8'), 'lineas: 3')
})

test('pipe CLI -- confinamiento: una receta que escribe fuera del workspace se rechaza antes de pedir aprobacion, mismo mensaje de siempre', async () => {
  connectedSession('workspace-write')
  const proposal = {
    name: 'escribir_en',
    description: 'Escribe un archivo en la ruta indicada.',
    inputs: JSON.stringify([{ name: 'destino', description: 'Ruta del archivo' }]),
    discover: '[]',
    apply: JSON.stringify([{ id: 'w', tool: 'write_file', args: { path: '{{input.destino}}', content: 'x' } }])
  }
  const created = await answeringApprovals(pipe<TextResponse>({ panelId: CHAT, action: 'proposeComposedTool', args: proposal }), true)
  assert.equal(created.result.ok, true, created.result.text)

  const outside = path.join(path.dirname(workspace), `fuera-${path.basename(workspace)}.txt`)
  for (const destino of [`../${path.basename(outside)}`, outside]) {
    const run = await answeringApprovals(pipe<TextResponse>({ panelId: CHAT, action: 'runComposedTool', name: 'escribir_en', args: { destino } }), true)
    assert.equal(run.result.ok, false)
    assert.equal(run.approvals.length, 0, 'nunca se le pide al usuario aprobar algo fuera del workspace')
    assert.match(String(run.result.text), /Ruta fuera del workspace activo/)
    assert.equal(fs.existsSync(outside), false)
  }
})

test('pipe CLI -- runComposedTool solo corre recetas: nunca una tool suelta ni una ruta', async () => {
  connectedSession('danger-full-access')
  for (const name of ['read_file', 'write_file', '../contar_lineas_py', 'no_existe']) {
    const run = await answeringApprovals(pipe<TextResponse>({ panelId: CHAT, action: 'runComposedTool', name, args: { path: 'src/a.py', content: 'pisado' } }), true)
    assert.equal(run.result.ok, false, name)
    assert.match(String(run.result.text), /No existe la herramienta compuesta "composed__/, name)
    assert.equal(run.approvals.length, 0)
  }
  assert.equal(fs.readFileSync(path.join(workspace, 'src', 'a.py'), 'utf8'), 'print(1)\nprint(2)\n')
})

test('pipe CLI -- en solo lectura no se puede crear una receta (y no se pide aprobacion)', async () => {
  connectedSession('read-only')
  const run = await answeringApprovals(pipe<TextResponse>({ panelId: CHAT, action: 'proposeComposedTool', args: { ...CONTAR, name: 'otra_receta' } }), true)
  assert.equal(run.result.ok, false)
  assert.equal(run.approvals.length, 0)
  assert.equal(fs.existsSync(path.join(workspace, '.amatista', 'composed-tools', 'otra_receta.json')), false)
})
