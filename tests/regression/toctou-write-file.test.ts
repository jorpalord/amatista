// Test de regresion real (candidato #1, docs/_arch/verify_regression_test_infra_design.md):
// TOCTOU de write_file bajo concurrencia real (Opcion A2,
// docs/_arch/verify_toctou_parallel_fix_design.md). El fix ENTERO depende
// de que el re-chequeo de hash quede pegado, SIN ningun await de por
// medio, al writeFileSync -- cualquier refactor que meta un await ahi
// reabre la ventana de clobber silencioso.
//
// Reproduccion determinista del escenario real: 2 escritores concurrentes
// reales sobre el MISMO archivo, con demoras de aprobacion ASIMETRICAS
// (mismo criterio que la verificacion original -- "necesito demoras de
// aprobacion asimetricas para reproducir la ventana real, no simetricas")
// -- B aprueba instantaneo y completa su escritura real (con commit git
// real) mientras A sigue esperando su propia aprobacion (retrasada a
// proposito). Cuando A retoma, su re-chequeo debe detectar que el disco
// cambio bajo sus pies y RECHAZAR -- nunca pisar a B en silencio.
// AMATISTA_STORAGE_ROOT llega ya seteado, real y aislado, por
// _support/run.cjs (el proceso PADRE que lanza `node --test`) -- setearlo
// aca adentro, antes de un import propio, NO alcanza (hallazgo real
// durante la construccion de esta infraestructura: los `import` de un
// archivo se evaluan antes que el resto del cuerpo del modulo, sin
// importar el orden textual -- ver el comentario completo en
// _support/run.cjs).
import path from 'node:path'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ToolRegistry } from '../../src/main/tool-registry'

test('write_file real -- 2 escritores concurrentes, el mas lento nunca pisa al mas rapido en silencio', async (t) => {
  const workspace = mkdtempSync(path.join(tmpdir(), 'amatista-regression-toctou-ws-'))
  t.after(() => rmSync(workspace, { recursive: true, force: true }))

  writeFileSync(path.join(workspace, 'shared.txt'), 'v0\n', 'utf8')

  const registry = new ToolRegistry()
  const noop = async (): Promise<boolean> => true
  const delayed = async (): Promise<boolean> => {
    // Demora real, generosamente mayor al tiempo real que tarda una
    // escritura+commit completa de B (confirmado en esta misma sesion:
    // subprocesos git reales del orden de decenas a un par de cientos de
    // ms) -- asegura que B ya termino de verdad antes de que A retome.
    await new Promise(resolve => setTimeout(resolve, 700))
    return true
  }

  const ctxA = { workspace, confirm: delayed, sandbox: 'workspace-write' as const, sessionId: 'panel-A' }
  const ctxB = { workspace, confirm: noop, sandbox: 'workspace-write' as const, sessionId: 'panel-B' }

  // A arranca primero (captura existingHash='v0' ANTES que nadie escriba),
  // B arranca inmediatamente despues -- mismo orden real que el escenario
  // que expuso el bug original.
  const pA = registry.execute('write_file', { path: 'shared.txt', content: 'desde-A\n' }, ctxA)
  const pB = registry.execute('write_file', { path: 'shared.txt', content: 'desde-B\n' }, ctxB)
  const [resultA, resultB] = await Promise.all([pA, pB])

  assert.equal(resultB.ok, true, `B deberia escribir sin problema (primero en llegar): ${JSON.stringify(resultB)}`)
  assert.equal(resultA.ok, false, `A deberia RECHAZAR por staleness real (el disco cambio mientras esperaba aprobacion): ${JSON.stringify(resultA)}`)
  assert.match(String(resultA.output), /cambio en disco/i)

  // El contenido real en disco es el de B -- nunca pisado por A en
  // silencio (el bug real original: ok:true para A, contenido de B
  // perdido sin ningun aviso).
  const finalContent = readFileSync(path.join(workspace, 'shared.txt'), 'utf8')
  assert.equal(finalContent, 'desde-B\n')
})
