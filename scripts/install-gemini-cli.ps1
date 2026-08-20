$ErrorActionPreference = "Stop"

Write-Host ""
Write-Host "=== Universal Agent Studio - Instalar Gemini CLI ==="
Write-Host ""

node --version
npm --version

Write-Host ""
Write-Host "Instalando @google/gemini-cli@latest..."
npm install -g @google/gemini-cli@latest

Write-Host ""
Write-Host "Verificando gemini..."
gemini --version

Write-Host ""
Write-Host "Listo. Abre Universal Agent Studio, pulsa Revisar CLI y luego Login con Google."
