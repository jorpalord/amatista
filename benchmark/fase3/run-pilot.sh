#!/bin/bash
# Fase 3 del benchmark (docs/_arch/verify_benchmark_fase3.md): orquesta el
# piloto completo de evaluacion real -- descarga (si hace falta) el harness
# oficial de ProMax, arma preds.json a partir de N result.json reales de
# Fase 2, corre test_run.py TAL CUAL (nunca reimplementado) contra el
# daemon Docker aislado del benchmark (DOCKER_HOST), y mergea el resultado
# real de evaluacion con la telemetria de Fase 2 en un registro final por
# tarea.
#
# Estrategia secuencial por disco (hallazgo critico de Tarea 3): --workers 1
# --cleanup hace que test_run.py YA procese una instancia a la vez (pull ->
# evaluar -> docker rmi de ESA imagen -> recien ahi la siguiente) sin
# necesitar loop propio -- confirmado real leyendo stat_pass_rate() (
# workers<=1 usa una list comprehension sincronica, y el cleanup corre en un
# finally por job antes de pasar al siguiente).
#
# Uso: ./run-pilot.sh <result1.json> [result2.json ...]
set -euo pipefail
cd "$(dirname "$0")"

if [ "$#" -eq 0 ]; then
  echo "Uso: ./run-pilot.sh <result1.json> [result2.json ...]"
  exit 1
fi

# El daemon Docker AISLADO del benchmark (disco separado, containerd propio
# -- ver docs/_arch/CONTRACT.md, seccion de Fase 3) -- test_run.py llama al
# CLI `docker` real via subprocess.run(shell=True) sin overrides de entorno
# propios, asi que DOCKER_HOST alcanza para redirigir TODAS sus operaciones
# (pull/run/exec/cp/rmi) al daemon aislado, sin tocar test_run.py.
export DOCKER_HOST="unix:///run/docker-benchmark.sock"

./fetch-promax-assets.sh

echo "[run-pilot] armando preds.json a partir de: $*"
node build-preds.js "$@" > preds.json
echo "[run-pilot] preds.json:"
cat preds.json

echo "[run-pilot] corriendo test_run.py real (--workers 1 --cleanup -- secuencial, nunca mas de una imagen pesada en disco a la vez)..."
python3 vendor/test_run.py \
  --pred preds.json \
  --golden vendor/swe-bench-promax.json \
  --eval vendor/eval.json \
  --output pass_rate.json \
  --workers 1 \
  --cleanup

echo "[run-pilot] pass_rate.json real:"
cat pass_rate.json

echo "[run-pilot] mergeando con la telemetria de Fase 2..."
node merge-results.js pass_rate.json "$@"
