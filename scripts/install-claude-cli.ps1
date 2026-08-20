Write-Host "=== Universal Agent Studio - Instalar Claude Code CLI ==="
Write-Host ""
Write-Host "Node:"
node --version
Write-Host "npm:"
npm --version
Write-Host ""
Write-Host "Instalando @anthropic-ai/claude-code@latest..."
npm install -g @anthropic-ai/claude-code@latest
Write-Host ""
Write-Host "Claude:"
claude --version
Write-Host ""
Write-Host "Listo. Abre Universal Agent Studio, pulsa Revisar CLI y luego Abrir login Claude."
