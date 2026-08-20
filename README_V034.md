# Universal Agent Studio V0.3.4

## Qué corrige

La aplicación separa explícitamente cinco estados:

1. Cuenta / autenticación
2. Proveedor
3. Modelo
4. Workspace
5. Agente

Seleccionar un workspace ya no elimina la superficie de chat. Los mensajes se mantienen en memoria por workspace durante la ejecución y el último proyecto activo se persiste.

## Codex / ChatGPT

- login oficial mediante `codex app-server`;
- `account/read`, `account/login/start`, `account/logout`;
- catálogo real con `model/list`;
- sincronización automática al detectar una sesión;
- conserva el modelo anterior si sigue disponible;
- si desaparece, selecciona el primer modelo habilitado;
- tener cuenta conectada ya no equivale a tener el agente conectado al workspace.

## Microsoft Foundry

Sigue usando `codex app-server` como runtime de herramientas. Se corrigió la autenticación del proveedor para usar:

```toml
env_http_headers = { "api-key" = "UAS_PROVIDER_API_KEY" }
```

## OpenAI / API compatible

Usa `env_key` de Codex para el bearer token del proveedor, en lugar del header literal incorrecto de versiones previas.

## Claude

V0.3.4 añade un runtime funcional mediante Claude Code CLI.

### Suscripción

No se pasa `ANTHROPIC_API_KEY` ni `ANTHROPIC_AUTH_TOKEN`, evitando cambiar accidentalmente de la suscripción a facturación API.

El login se completa con Claude Code.

### API

La API key se inyecta solo al proceso Claude creado por Universal Agent.

### Permisos

- Solo lectura → `--permission-mode plan`
- Workspace → `--permission-mode acceptEdits`
- Acceso completo → `--dangerously-skip-permissions`

La sesión se conserva mediante `session_id` + `--resume`.

## Gemini

V0.3.4 añade runtime funcional mediante Gemini CLI headless.

### Suscripción Google

No se pasa `GEMINI_API_KEY` ni `GOOGLE_API_KEY`. El botón de login abre Gemini CLI para usar su autenticación oficial `Sign in with Google`.

### API

La key se inyecta como `GEMINI_API_KEY` solo al proceso Gemini.

### Permisos

- Solo lectura → `--approval-mode plan`
- Workspace → `--approval-mode auto_edit`
- Acceso completo → `--approval-mode yolo`

Se usa `stream-json` y se conserva `session_id` para continuar la conversación.

## Estado visible

Encima del composer se muestran por separado:

- Workspace
- Proveedor + autenticación
- Modelo
- Agente/runtime

Si falta algo, se indica exactamente qué falta.

## Instalación

```powershell
npm install
npx install-electron --no
npm run typecheck
npm run dev
```

## Nota de permisos

Los approvals visuales propios de Universal Agent siguen siendo completos para Codex/app-server.

Claude y Gemini usan sus políticas oficiales del CLI en modo headless. Unificar todos sus prompts de permisos dentro del mismo modal requiere una capa de permission bridge posterior.
