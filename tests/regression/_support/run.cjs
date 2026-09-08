// Infraestructura real de tests de regresion (docs/_arch/
// verify_regression_test_infra_design.md). Wrapper real que arranca `node
// --test` con AMATISTA_STORAGE_ROOT YA seteado en el proceso ANTES de que
// exista, para que cada archivo de test (subproceso propio, confirmado real
// que node --test aisla env vars por archivo) herede un storage root real
// aislado desde el arranque.
//
// Hallazgo real durante la propia construccion de esta infraestructura
// (no en el codigo bajo prueba): setear `process.env.AMATISTA_STORAGE_ROOT`
// DENTRO de un archivo de test, antes de su propio `import ... from
// '../../src/main/...'`, NO alcanza -- los `import` de ES modules (incluso
// transpilados a `require()` por esbuild) se evaluan en el orden real en
// que el bundler los coloca, y en la practica terminaron corriendo ANTES
// de la linea que seteaba la variable -- 2 corridas reales de prueba
// escribieron repos VCS ocultos de prueba dentro de D:\AMATISTA\data\vcs\
// (la carpeta REAL del usuario), confirmado y limpiado a mano. La unica
// forma real y confiable de garantizar el aislamiento es setear la
// variable en el PROCESO PADRE, antes de siquiera lanzar `node --test` --
// exactamente lo que hace este wrapper.
const { spawnSync } = require('node:child_process')
const { mkdtempSync, rmSync } = require('node:fs')
const path = require('node:path')
const os = require('node:os')

const storageRoot = mkdtempSync(path.join(os.tmpdir(), 'amatista-regression-storage-'))

const result = spawnSync(
  process.execPath,
  ['--test', 'tests/regression/.dist/**/*.test.js'],
  {
    stdio: 'inherit',
    // Sin shell: process.execPath se invoca directo con argv real -- el
    // glob llega intacto a --test (Node lo resuelve el mismo, confirmado
    // real), sin depender de si el shell del sistema (cmd/PowerShell/bash)
    // sabe expandir "**".
    env: { ...process.env, AMATISTA_STORAGE_ROOT: storageRoot }
  }
)

rmSync(storageRoot, { recursive: true, force: true })

process.exit(result.status ?? 1)
