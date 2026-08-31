// Fase 3 del benchmark (docs/_arch/verify_benchmark_fase3.md): transforma
// N result.json reales de Fase 2 ({instance_id, patch, ...}) al preds.json
// que espera el harness OFICIAL de evaluacion de ProMax
// (src/evaluation/test_run.py, confirmado real via el README del dataset:
// un array [{instance_id, model_patch}]) -- transformacion de formato pura,
// nada de logica de evaluacion propia.
//
// Uso: node build-preds.js <result1.json> [result2.json ...] > preds.json
const fs = require('fs')

function main() {
  const resultPaths = process.argv.slice(2)
  if (resultPaths.length === 0) {
    console.error('Uso: node build-preds.js <result1.json> [result2.json ...]')
    process.exit(1)
  }

  const preds = []
  for (const p of resultPaths) {
    const result = JSON.parse(fs.readFileSync(p, 'utf8'))
    if (!result.instance_id) {
      console.error(`[build-preds] ${p}: falta instance_id, se omite.`)
      continue
    }
    if (!result.patch || result.patch.trim().length === 0) {
      console.error(`[build-preds] ${p}: patch vacio (instance_id=${result.instance_id}) -- se incluye igual con model_patch vacio, test_run.py lo marca APPLY_FAILED/no resuelto, no se omite silenciosamente.`)
    }
    preds.push({
      instance_id: result.instance_id,
      model_patch: result.patch || ''
    })
  }

  process.stdout.write(JSON.stringify(preds, null, 2))
}

main()
