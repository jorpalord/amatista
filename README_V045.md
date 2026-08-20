# Universal Agent Studio V0.4.5

## Correccion de routing

- Codex subscription/API usa `codex app-server`.
- Gemini subscription usa Gemini CLI headless.
- Gemini API key usa llamada directa a Gemini `models.generateContent`.
- Claude subscription queda primero y usa Claude Code CLI.
- Azure Claude API queda como fallback y usa endpoint Anthropic-compatible directo.
- Microsoft Foundry usa llamada directa a `/openai/v1/responses` con header `api-key`.
- Foundry, Gemini y Ollama ya no pasan por `uas_provider` de Codex.
- Ollama/qwen2.5:7b queda desactivado si no hay compatibilidad real validada.
- `clientInfo.version` y package pasan a `0.4.5`.
- La UI muestra error visible si un turno queda sin texto de assistant.

## Verificacion

```powershell
npm install
npm run typecheck
npm run dev
```
