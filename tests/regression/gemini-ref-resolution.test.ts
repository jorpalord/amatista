// Test de regresion real (candidato #3, docs/_arch/verify_regression_test_infra_design.md):
// resolveJsonSchemaRefs()/geminiFunctionDeclarations() (api-agent-runtime.ts),
// Hallazgo 3 de la 4ta revision externa -- stripDollarKeysForGemini()
// borraba CUALQUIER clave que empezara con "$", incluido $ref, dejando una
// propiedad con restricciones reales (ej. un enum) convertida en {} vacio,
// en silencio. Funcion pura -- sin red, sin key real, sin bundle necesario
// mas alla de electron (api-agent-runtime.ts no importa electron directo,
// pero arrastra tool-registry.ts transitivo via ToolDefinition -- type-only,
// erasado, en la practica este archivo no necesita el stub, pero el bundle
// conjunto de la suite si lo aplica igual, sin costo real).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { geminiFunctionDeclarations } from '../../src/main/api-agent-runtime'
import type { ToolDefinition } from '../../src/main/tool-registry'

// Misma forma real que expuso el Hallazgo 3 original: una propiedad
// "status" con un $ref local a una definicion reusable en $defs, que trae
// consigo un enum real -- exactamente el tipo de restriccion que se
// perdia en silencio antes del fix.
function toolWithRef(): ToolDefinition {
  return {
    name: 'update_status',
    description: 'Actualiza el estado real de una tarea.',
    parameters: {
      type: 'object',
      properties: {
        status: { $ref: '#/$defs/Status' },
        note: { type: 'string' }
      } as unknown as ToolDefinition['parameters']['properties'],
      required: ['status'],
      $defs: {
        Status: { type: 'string', enum: ['in_progress', 'blocked', 'done'] }
      }
    } as unknown as ToolDefinition['parameters']
  }
}

test('geminiFunctionDeclarations() real -- $ref/$defs se RESUELVEN, no se borran (Hallazgo 3)', () => {
  const [decl] = geminiFunctionDeclarations([toolWithRef()]) as Array<{ parameters: { properties: Record<string, unknown> } }>
  const status = decl.parameters.properties.status as Record<string, unknown>

  // El bug real: antes de resolveJsonSchemaRefs(), "status" quedaba en {}
  // vacio -- la restriccion real (el enum) desaparecia en silencio.
  assert.notDeepEqual(status, {})
  assert.equal(status.type, 'string')
  assert.deepEqual(status.enum, ['in_progress', 'blocked', 'done'])

  // $defs de la raiz nunca sobrevive al resultado final (stripDollarKeysForGemini
  // lo descarta, mismo criterio de siempre) -- ninguna clave con "$" queda
  // en el resultado.
  assert.equal('$defs' in decl.parameters, false)
  assert.equal(JSON.stringify(decl.parameters).includes('"$ref"'), false)
})

test('geminiFunctionDeclarations() real -- ciclo real A<->B no cuelga, corta la expansion', () => {
  const cyclic: ToolDefinition = {
    name: 'link_nodes',
    description: 'Tool sintetica con un ciclo real de $ref.',
    parameters: {
      type: 'object',
      properties: {
        a: { $ref: '#/$defs/A' }
      } as unknown as ToolDefinition['parameters']['properties'],
      required: [],
      $defs: {
        A: { type: 'object', properties: { b: { $ref: '#/$defs/B' } } },
        B: { type: 'object', properties: { a: { $ref: '#/$defs/A' } } }
      }
    } as unknown as ToolDefinition['parameters']
  }
  // No debe colgar ni lanzar -- si esto no resuelve, el test se corta por
  // timeout de node:test, evidencia real de una regresion de ciclo.
  const [decl] = geminiFunctionDeclarations([cyclic]) as Array<{ parameters: unknown }>
  assert.ok(decl.parameters)
})
