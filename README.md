# Universal Agent Studio V0.3

V0.3 añade autenticación por suscripción/sesión oficial además de API keys.

## Rutas implementadas

### OpenAI / Codex por suscripción

Operativa mediante el `codex` CLI ya autenticado con ChatGPT/Codex.

- No usa API key.
- No crea un CODEX_HOME aislado para esta ruta.
- Reutiliza la sesión oficial del usuario.
- Mantiene app-server, workspace, shell, patch, diff y approvals.

### Microsoft Foundry por API key

Operativa como en V0.2.

### OpenAI/OpenAI-compatible por API key

Arquitectura incluida para Responses-compatible endpoints.

## Rutas registradas pero todavía no plenamente operativas

### Claude por suscripción

La V0.3 detecta `claude` CLI y permite registrar el proveedor con auth `subscription`, pero NO finge que ya tenga paridad de tools.

Falta el bridge `ClaudeSubscriptionRuntime`.

### Anthropic API

Registrada; requiere `NativeAgentRuntime`.

### Google / Gemini API

Registrada; requiere `NativeAgentRuntime`.

## No se usa automatización web

No Playwright.
No scraping de chatgpt.com / claude.ai / gemini.google.com.

La estrategia es reutilizar flujos oficiales de CLI/sesión cuando existan.

## UI

En Configuración:

- proveedor
- método de autenticación
- endpoint/API key solo cuando aplica
- estado de CLI
- modelos/deployments

En el composer:

- permisos
- modelo
- proveedor implícito
- sin exponer infraestructura

## Instalación

```powershell
npm install
npx install-electron --no
npm run typecheck
npm run dev
```

## Probar Codex por suscripción

1. Verifica fuera de la app:

```powershell
codex --version
```

2. Asegúrate de haber iniciado sesión con tu cuenta ChatGPT/Codex.
3. En Universal Agent:
   - Configuración
   - `+ Codex / ChatGPT subscription`
   - Nombre visible del modelo
   - model: un modelo válido para tu sesión de Codex
4. Guardar.
5. Seleccionar proyecto.
6. Seleccionar ese modelo.
7. Enviar prompt.

## Probar Foundry

Configura:

```text
Tipo: Microsoft Foundry
Autenticación: API key
Endpoint: https://...services.ai.azure.com/openai/v1
Modelo/deployment: ...
```

## Próxima etapa V0.4

- NativeAgentRuntime.
- ClaudeSubscriptionRuntime operativo.
- Anthropic tool use.
- Gemini function calling.
- ToolRegistry universal.
- persistencia de chats.
- Git.
- MCP.
- terminal.
