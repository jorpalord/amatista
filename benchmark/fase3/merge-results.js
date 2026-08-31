// Fase 3 del benchmark (docs/_arch/verify_benchmark_fase3.md): combina, por
// instancia, el result.json real de Fase 2 (patch, usage, latencia,
// toolCallLog) con la entrada real correspondiente del pass_rate.json que
// escribe el harness oficial de evaluacion (src/evaluation/test_run.py) --
// un unico registro final por tarea, sin reinterpretar el veredicto de
// pass/fail (se copia tal cual "resolved"/"model"/"golden" reales).
//
// Uso: node merge-results.js <pass_rate.json> <result1.json> [result2.json ...]
// Escribe <mismo directorio de cada result.json>/final_result.json
const fs = require('fs')
const path = require('path')

function main() {
  const [passRatePath, ...resultPaths] = process.argv.slice(2)
  if (!passRatePath || resultPaths.length === 0) {
    console.error('Uso: node merge-results.js <pass_rate.json> <result1.json> [result2.json ...]')
    process.exit(1)
  }

  const passRateList = JSON.parse(fs.readFileSync(passRatePath, 'utf8'))
  const passRateByInstance = new Map(passRateList.map(r => [r.instance_id, r]))

  for (const resultPath of resultPaths) {
    const fase2 = JSON.parse(fs.readFileSync(resultPath, 'utf8'))
    const fase3 = passRateByInstance.get(fase2.instance_id)
    if (!fase3) {
      console.error(`[merge] ${fase2.instance_id}: no se encontro en ${passRatePath} -- no se corrio la evaluacion real para esta instancia, se omite.`)
      continue
    }

    const finalResult = {
      instance_id: fase2.instance_id,
      repo: fase2.repo,
      base_commit: fase2.base_commit,
      // Fase 2 -- generacion del patch
      model: fase2.model,
      fase2_call_succeeded: fase2.callSucceeded,
      fase2_error_message: fase2.errorMessage,
      latency_ms: fase2.latencyMs,
      usage: fase2.usage,
      tool_call_log: fase2.toolCallLog,
      patch: fase2.patch,
      patch_is_empty: fase2.patchIsEmpty,
      // Fase 3 -- evaluacion real oficial (test_run.py), tal cual, sin
      // reinterpretar. "resolved" es el campo real: passed=true implica que
      // TANTO el patch del modelo COMO el patch de referencia pasaron el
      // eval_script real -- ver docs/_arch/verify_benchmark_fase3.md.
      resolved: fase3.passed === true,
      fase3_language: fase3.language,
      fase3_model_result: fase3.model,
      fase3_golden_result: fase3.golden
    }

    const outPath = path.join(path.dirname(resultPath), 'final_result.json')
    fs.writeFileSync(outPath, JSON.stringify(finalResult, null, 2), 'utf8')
    console.log(`[merge] ${fase2.instance_id}: resolved=${finalResult.resolved} -> ${outPath}`)
  }
}

main()
