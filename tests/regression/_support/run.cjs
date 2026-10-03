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
//
// Un storage root POR ARCHIVO (2026-09-25): antes era uno solo para todos,
// y `node --test` corre los archivos en paralelo -- varios procesos escribian
// la MISMA amatista.db a la vez. Evidencia real: una corrida con 11 fallas,
// las 11 por "Error: database is locked" (SQLite), entre ellas el
// `parallel_ask real -- reconexion…` que PENDING.md tenia como intermitente
// "con hipotesis sin confirmar". Ahora cada archivo corre en su propio
// proceso con su propia carpeta (y su propia base), manteniendo el
// paralelismo; al final se suman los totales.
const { spawn } = require('node:child_process')
const { mkdtempSync, readdirSync, rmSync } = require('node:fs')
const path = require('node:path')
const os = require('node:os')

const DIST = path.join('tests', 'regression', '.dist')
const files = readdirSync(DIST).filter(f => f.endsWith('.test.js')).sort().map(f => path.join(DIST, f))
const cpus = typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length
const concurrency = Math.max(1, Math.min(files.length, cpus - 1))
const totals = { tests: 0, pass: 0, fail: 0, cancelled: 0, skipped: 0, todo: 0 }
const failedFiles = []

function runFile(file) {
  return new Promise(resolve => {
    const storageRoot = mkdtempSync(path.join(os.tmpdir(), 'amatista-regression-storage-'))
    // Sin shell: process.execPath se invoca directo con argv real.
    const child = spawn(process.execPath, ['--test', '--test-reporter=spec', file], {
      env: { ...process.env, AMATISTA_STORAGE_ROOT: storageRoot }
    })
    let output = ''
    child.stdout.on('data', chunk => { output += chunk })
    child.stderr.on('data', chunk => { output += chunk })
    child.on('close', code => {
      rmSync(storageRoot, { recursive: true, force: true })
      process.stdout.write(output) // la salida de cada archivo entera, sin mezclarse con la de otro
      for (const key of Object.keys(totals)) {
        const match = output.match(new RegExp(`ℹ ${key} (\\d+)`))
        if (match) totals[key] += Number(match[1])
      }
      if (code !== 0) failedFiles.push(path.basename(file))
      resolve()
    })
  })
}

async function main() {
  const queue = [...files]
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (queue.length > 0) await runFile(queue.shift())
  }))
  console.log(`\n==== regresion: ${files.length} archivos, cada uno con su propio storage aislado ====`)
  for (const [key, value] of Object.entries(totals)) console.log(`ℹ ${key} ${value}`)
  if (failedFiles.length > 0) console.log(`✖ archivos con fallas: ${failedFiles.join(', ')}`)
  process.exit(failedFiles.length > 0 ? 1 : 0)
}

main()
