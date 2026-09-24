// Nombre del pipe MCP por instancia (src/main/mcp-pipe-name.ts): unico por proceso y derivado solo. El nombre fijo de
// antes hacia que una 2da instancia de Amatista mandara los CLIs a la 1ra (mezcla real de aprobaciones/orquestacion).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { deriveInstancePipePath, MCP_APPROVAL_PIPE_PATH } from '../../src/main/mcp-pipe-name'

test('formato: Windows usa un named pipe con el pid y la entropia', () => {
  assert.equal(
    deriveInstancePipePath('win32', 4242, 'abcdef123456'),
    '\\\\.\\pipe\\amatista-mcp-approval-4242-abcdef123456'
  )
})

test('formato: fuera de Windows es un socket .sock en el directorio temporal', () => {
  const p = deriveInstancePipePath('linux', 4242, 'abcdef123456')
  assert.match(p, /amatista-mcp-approval-4242-abcdef123456\.sock$/)
})

test('el nombre deja de ser el fijo de siempre (la causa de la mezcla entre instancias)', () => {
  const p = deriveInstancePipePath('win32')
  assert.notEqual(p, '\\\\.\\pipe\\amatista-mcp-approval')
  assert.match(p, /^\\\\\.\\pipe\\amatista-mcp-approval-\d+-[0-9a-f]{12}$/)
  assert.ok(p.includes(`-${process.pid}-`), 'incluye el pid del proceso, para poder identificar al dueno al depurar')
})

test('dos derivaciones del MISMO proceso (mismo pid) nunca coinciden: la parte aleatoria evita cualquier colision', () => {
  const names = new Set<string>()
  for (let i = 0; i < 2000; i++) names.add(deriveInstancePipePath('win32', 1234))
  assert.equal(names.size, 2000)
})

test('el nombre efectivo de este proceso queda definido (sin variable de entorno) y es del formato derivado', () => {
  // El test corre sin AMATISTA_MCP_PIPE: el nombre se deriva solo.
  if (process.env.AMATISTA_MCP_PIPE?.trim()) return
  assert.match(MCP_APPROVAL_PIPE_PATH, /amatista-mcp-approval-\d+-[0-9a-f]{12}/)
})
