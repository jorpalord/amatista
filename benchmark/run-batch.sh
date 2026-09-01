#!/bin/bash
# Orquestador de tanda -- corre Fase 2 (clone/turno real/patch) + Fase 3
# (evaluacion Docker real/cleanup) en loop, SECUENCIAL, sobre una lista de
# tareas. No reimplementa ningun mecanismo -- reusa run-instance-wrapper.cjs
# (Fase 2) y fase3/test_run.py real (Fase 3) tal cual, solo los invoca en
# loop y agrega el resultado final por instancia a un resumen de tanda.
#
# Uso: ./run-batch.sh <tasks.json> <batch_dir>
#   tasks.json: array real [{instance_id, repo, base_commit, problem_statement}, ...]
#   batch_dir: carpeta donde se acumulan logs + summary.jsonl de esta tanda
set -uo pipefail
cd "$(dirname "$0")"

TASKS_FILE="$1"
BATCH_DIR="$2"
mkdir -p "$BATCH_DIR"
SUMMARY_JSONL="$BATCH_DIR/summary.jsonl"
: > "$SUMMARY_JSONL"

# Fallo "duro" = Fase 2 no llego ni a escribir result.json (excepcion del
# harness/git/red, no un turno que simplemente no resolvio el bug). 3 duros
# seguidos es la senal real de "algo del mecanismo esta roto", no de tareas
# individuales dificiles -- ahi se para la tanda entera en vez de seguir
# quemando el resto a ciegas.
CONSECUTIVE_HARD_FAILURES=0
MAX_CONSECUTIVE_HARD_FAILURES=3

TASK_COUNT=$(node -e "console.log(JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')).length)" "$TASKS_FILE")
echo "[batch] $TASK_COUNT tareas en esta tanda."

for i in $(seq 0 $((TASK_COUNT - 1))); do
  INSTANCE_ID=$(node -e "console.log(JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'))[process.argv[2]].instance_id)" "$TASKS_FILE" "$i")
  echo "=== [$((i + 1))/$TASK_COUNT] $INSTANCE_ID ==="

  TASK_JSON="tasks/${INSTANCE_ID}.json"
  node -e "
    const fs = require('fs')
    const tasks = JSON.parse(fs.readFileSync(process.argv[1], 'utf8'))
    fs.writeFileSync(process.argv[3], JSON.stringify(tasks[Number(process.argv[2])], null, 2))
  " "$TASKS_FILE" "$i" "$TASK_JSON"

  RUN_DIR="runs/${INSTANCE_ID}"
  rm -rf "$RUN_DIR"

  # Paso 1 -- Fase 2 real. Defaults = setup original (openai-chat directo,
  # gpt-5.2, AMATISTA_MAX_TOOL_LOOP=300) -- pero respeta cualquiera de estas
  # variables si ya vienen exportadas desde afuera (mismo patron de override
  # que AMATISTA_STORAGE_ROOT/AMATISTA_MAX_TOOL_LOOP/AMATISTA_EXCLUDED_TOOLS
  # en el resto del proyecto), para poder correr esta misma tanda contra
  # otro proveedor/recurso (ej. foundry + un recurso Azure dedicado) sin
  # tocar el script.
  export BENCH_PROVIDER_KIND="${BENCH_PROVIDER_KIND:-openai-chat}"
  export BENCH_MODEL="${BENCH_MODEL:-gpt-5.2}"
  export BENCH_ENDPOINT="${BENCH_ENDPOINT:-}"
  if [ "$BENCH_PROVIDER_KIND" = 'openai-chat' ]; then
    export BENCH_OPENAI_KEY="${BENCH_OPENAI_KEY:-$(cat .bench_key_openai)}"
  else
    export BENCH_AZURE_KEY="${BENCH_AZURE_KEY:-$(cat .bench_key)}"
  fi
  export AMATISTA_MAX_TOOL_LOOP="${AMATISTA_MAX_TOOL_LOOP:-300}"
  FASE2_LOG="$BATCH_DIR/${INSTANCE_ID}_fase2.log"
  node run-instance-wrapper.cjs "$TASK_JSON" "$RUN_DIR" > "$FASE2_LOG" 2>&1

  RESULT_JSON="$RUN_DIR/result.json"
  if [ ! -f "$RESULT_JSON" ]; then
    echo "[batch] $INSTANCE_ID: Fase 2 no produjo result.json -- fallo duro (ver $FASE2_LOG)."
    CONSECUTIVE_HARD_FAILURES=$((CONSECUTIVE_HARD_FAILURES + 1))
    node -e "
      const fs = require('fs')
      fs.appendFileSync(process.argv[1], JSON.stringify({instance_id: process.argv[2], hard_failure: true, stage: 'fase2'}) + '\n')
    " "$SUMMARY_JSONL" "$INSTANCE_ID"
  else
    CONSECUTIVE_HARD_FAILURES=0

    # Paso 2 -- Fase 3 real, SOLO esta instancia (preds.json de 1 entrada),
    # --workers 1 --cleanup -- mismo mecanismo oficial ya probado, nunca
    # reimplementado. La imagen de esta instancia se limpia antes de pasar
    # a la siguiente (misma disciplina de disco de siempre).
    FASE3_LOG="$BATCH_DIR/${INSTANCE_ID}_fase3.log"
    (
      cd fase3
      node build-preds.js "../$RESULT_JSON" > preds_single.json
      DOCKER_HOST="unix:///run/docker-benchmark.sock" python3 vendor/test_run.py \
        --pred preds_single.json \
        --golden vendor/swe-bench-promax.json \
        --eval vendor/eval.json \
        --output pass_rate_single.json \
        --workers 1 \
        --cleanup
      node merge-results.js pass_rate_single.json "../$RESULT_JSON"
    ) > "$FASE3_LOG" 2>&1

    FINAL_JSON="$RUN_DIR/final_result.json"
    if [ -f "$FINAL_JSON" ]; then
      node -e "
        const fs = require('fs')
        const r = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))
        fs.appendFileSync(process.argv[1], JSON.stringify(r) + '\n')
      " "$SUMMARY_JSONL" "$FINAL_JSON"
      echo "[batch] $INSTANCE_ID: resolved=$(node -e "console.log(JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')).resolved)" "$FINAL_JSON")"
    else
      echo "[batch] $INSTANCE_ID: Fase 3 no produjo final_result.json -- fallo duro de evaluacion (ver $FASE3_LOG)."
      CONSECUTIVE_HARD_FAILURES=$((CONSECUTIVE_HARD_FAILURES + 1))
      node -e "
        const fs = require('fs')
        fs.appendFileSync(process.argv[1], JSON.stringify({instance_id: process.argv[2], hard_failure: true, stage: 'fase3'}) + '\n')
      " "$SUMMARY_JSONL" "$INSTANCE_ID"
    fi
  fi

  if [ "$CONSECUTIVE_HARD_FAILURES" -ge "$MAX_CONSECUTIVE_HARD_FAILURES" ]; then
    echo "[batch] $CONSECUTIVE_HARD_FAILURES fallos duros consecutivos -- posible problema sistemico del harness, frenando la tanda."
    exit 1
  fi
done

echo "[batch] tanda completa -- resumen en $SUMMARY_JSONL"
