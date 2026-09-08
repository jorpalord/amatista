// Test de regresion real (candidato #5, docs/_arch/verify_regression_test_infra_design.md):
// isWithinFolder() (runtime-state.ts) -- fix real de la 3ra revision
// externa (`projects:removeRoot` comparaba pertenencia de carpeta con
// startsWith(), substring, no ruta real). Depende de que path.relative()
// resuelva case-insensitivity en Windows SIN normalizar a mano -- exactamente
// el tipo de detalle que un "arreglo" con .toLowerCase() al lado podria
// romper sin querer.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isWithinFolder } from '../../src/main/runtime-state'

test('isWithinFolder() real -- misma carpeta, subcarpeta real, y el falso positivo de substring que motivo el fix', () => {
  // Misma carpeta exacta -> dentro.
  assert.equal(isWithinFolder('D:\\Proyecto', 'D:\\Proyecto'), true)

  // Subcarpeta real -> dentro.
  assert.equal(isWithinFolder('D:\\Proyecto', 'D:\\Proyecto\\src\\main'), true)

  // Carpeta HERMANA con el mismo prefijo de substring -- el bug real
  // original: "D:\Proyecto" NUNCA debe matchear como prefijo de
  // "D:\ProyectoExtra" (startsWith() ingenuo decia que si).
  assert.equal(isWithinFolder('D:\\Proyecto', 'D:\\ProyectoExtra'), false)

  // Carpeta padre -- afuera (la relacion es unidireccional).
  assert.equal(isWithinFolder('D:\\Proyecto\\src', 'D:\\Proyecto'), false)

  // Carpeta sin relacion -- afuera.
  assert.equal(isWithinFolder('D:\\Proyecto', 'D:\\Otro'), false)
})

test('isWithinFolder() real -- case-insensitive en Windows, sin normalizar a mano', () => {
  // path.win32.relative() ya resuelve mayusculas/minusculas -- confirmado
  // real en la investigacion original. Si alguien agregara un
  // .toLowerCase() a mano al lado, romperia esto de forma sutil (ej.
  // comparando against algo que YA se normalizo distinto en otro punto).
  assert.equal(isWithinFolder('D:\\Proyecto', 'd:\\PROYECTO'), true)
  assert.equal(isWithinFolder('D:\\Proyecto', 'd:\\proyecto\\SRC'), true)
  assert.equal(isWithinFolder('D:\\AMATISTA\\APP', 'D:\\amatista\\appextra'), false)
})
