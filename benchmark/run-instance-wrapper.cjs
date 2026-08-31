#!/usr/bin/env node
// Fase 2 del benchmark (docs/_arch/verify_benchmark_harness.md): wrapper
// minimo que fija AMATISTA_STORAGE_ROOT en process.env ANTES de requerir el
// bundle real (benchmark/dist/run-instance.cjs) -- necesario porque
// app-paths.ts lee esa env var UNA SOLA VEZ al cargar el modulo (const de
// nivel de modulo, no una funcion que relea el env en cada llamada). Un
// `import` estatico de ApiAgentRuntime/ToolRegistry en la cabecera del
// propio bundle se resolveria ANTES de que el bundle tuviera chance de
// setear nada el mismo -- por eso este wrapper separado, plano, sin
// bundlear. Mismo patron de wrapper-plano-mas-bundle ya usado en toda esta
// sesion para las corridas reales contra proveedores (Fase 1).
//
// Uso: node run-instance-wrapper.cjs <task.json> <runDir>
// (BENCH_AZURE_KEY, BENCH_FOUNDRY_ENDPOINT, BENCH_FOUNDRY_MODEL,
// AMATISTA_MAX_TOOL_LOOP: ya en el entorno antes de invocar esto)
const path = require('node:path')
const fs = require('node:fs')

const [, , taskPath, runDirArg] = process.argv
if (!taskPath || !runDirArg) {
  console.error('Uso: node run-instance-wrapper.cjs <task.json> <runDir>')
  process.exit(1)
}

const runDir = path.resolve(runDirArg)
const storageRoot = path.join(runDir, 'amatista-data')
fs.mkdirSync(storageRoot, { recursive: true })

process.env.AMATISTA_STORAGE_ROOT = storageRoot
process.env.BENCH_TASK_PATH = path.resolve(taskPath)
process.env.BENCH_RUN_DIR = runDir

require('./dist/run-instance.cjs')
