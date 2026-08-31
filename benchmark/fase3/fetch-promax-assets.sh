#!/bin/bash
# Fase 3 del benchmark (docs/_arch/verify_benchmark_fase3.md): descarga los
# artefactos REALES del harness de evaluacion oficial de ProMax, publicados
# en el propio repo del dataset de HuggingFace -- nunca reimplementados.
# Idempotente: no vuelve a descargar si ya existen.
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p vendor

fetch() {
  local url="$1" out="$2"
  if [ -f "$out" ]; then
    echo "[fetch] $out ya existe, no se vuelve a descargar."
    return
  fi
  echo "[fetch] descargando $out ..."
  curl -sSL -m 120 "$url" -o "$out"
}

# Los 3 archivos reales viven en la RAIZ del repo del dataset (confirmado
# real via la API de HuggingFace, campo "siblings") -- el README del propio
# dataset los referencia como "data/eval.json"/"data/swe-bench-promax.json"
# porque asume que el usuario los organiza asi localmente despues de
# descargarlos, no porque esa sea la ruta real en el repo.
BASE="https://huggingface.co/datasets/swe-bench-promax/SWE-Bench-ProMax/resolve/main"
fetch "$BASE/src/evaluation/test_run.py" vendor/test_run.py
fetch "$BASE/eval.json" vendor/eval.json
fetch "$BASE/swe-bench-promax.json" vendor/swe-bench-promax.json

echo "[fetch] listo. Contenido de vendor/:"
ls -la vendor/
