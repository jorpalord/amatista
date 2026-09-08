# Amatista

*(nombre de carpeta histórico: `universal-agent-studio`; el producto real, el `productName` de Electron y el nombre usado en todo `docs/_arch/`, es **Amatista**)*

**v0.11.0** — estudio de agentes de escritorio (Windows, Electron + React + TypeScript) con múltiples proveedores de modelo intercambiables, paneles de chat en paralelo, un conjunto de herramientas real (filesystem, LSP, git local, terminal, orquestación multi-panel, documentos, imágenes, web) y persistencia local — sin automatización web ni scraping de ningún proveedor.

> Este README describe el estado actual. El historial completo de cada fase/fix, con verificación real y evidencia, vive en `docs/_arch/HISTORY.md`. Los contratos de interfaces/tipos/invariantes vigentes viven en `docs/_arch/CONTRACT.md`. Lo que sigue abierto o descartado explícitamente vive en `docs/_arch/PENDING.md`.

## Proveedores y autenticación

8 tipos de conexión reales (`ProviderType`), más DeepSeek (soportado como caso especial de una conexión `anthropic` con endpoint compatible):

| Proveedor | Auth | Runtime |
|---|---|---|
| OpenAI / Codex (ChatGPT) | suscripción (`codex` CLI ya autenticado) | `codex-subscription` |
| OpenAI (API directa) / OpenAI-compatible | API key, endpoint editable | `openai-chat` (Chat Completions) |
| Anthropic (Claude) | suscripción (`claude` CLI) o API key | `claude-cli` / `anthropic-api` |
| Google (Gemini) | API key | `gemini-api` (HTTP directo — `gemini-cli` standalone fue retirado, Google lo discontinuó para cuentas individuales) |
| Antigravity (Google) | suscripción o API key (mismo binario `agy`) | `antigravity-cli` |
| Microsoft Foundry | API key | `foundry` (Azure OpenAI Responses API) |
| OpenRouter | API key, endpoint editable | `openai-chat` (Chat Completions) |
| DeepSeek | API key, vía conexión `anthropic` con endpoint compatible Messages API | `anthropic-api` |

No hay automatización web ni scraping de `chatgpt.com`/`claude.ai`/`gemini.google.com` — la estrategia es siempre reusar flujos oficiales de CLI/sesión o API cuando existen.

## Interfaz — hasta 4 paneles en paralelo

- Hasta 4 `<ChatPanel>` simultáneos, cada uno con su propio chat/workspace/proveedor/modelo, independientes entre sí.
- Árbol de sub-chats (`parentChatId`) con sidebar anidado.
- Presets simples (persona + proveedor/modelo preferido).
- "Modo plan" (liviano y variante reforzada con sandbox read-only real).
- Sandbox por conexión: `read-only` / `workspace-write` / `danger-full-access`.
- Nivel de esfuerzo/razonamiento configurable por turno.

## Orquestación multi-panel

- `list_windows` / `send_to_window`: un panel puede enviarle un turno completo a otro panel y esperar el resultado.
- `parallel_ask`: fan-out/fan-in real — reparte sub-tareas entre paneles idle ya conectados (nunca abre paneles nuevos), corre en paralelo real entre paneles distintos, en secuencia dentro de un mismo panel; guard de identidad completa (chat/workspace/proveedor/modelo) revalidado justo antes de despachar cada sub-tarea, para que una reconexión durante la aprobación humana no la despache contra un destino distinto del aprobado.

## Herramientas del agente

26 tools reales, agrupadas por función:

- **Archivos**: `read_file`, `write_file`, `apply_patch`, `list_dir`, `search_files`, `explore` — con protección TOCTOU real (staleness por hash) contra escrituras concurrentes, incluida la concurrencia genuina que introduce `parallel_ask`.
- **Documentos**: `read_document` — PDF/DOCX/XLSX/HTML, paginado real, con fallback de visión para páginas escaneadas.
- **Código (LSP)**: `get_diagnostics`, `find_definition`, `find_references`, `list_symbols`.
- **Terminal**: `run_command`, `terminal_exec` (terminal persistente por sesión), `git_status`/`git_diff` (atajos de solo lectura equivalentes a `run_command` sobre el `git` real del proyecto, sin diálogo de aprobación).
- **VCS local oculto** (por workspace, un repo `git` propio y separado del `.git` real del proyecto del usuario): `list_file_history`, `revert_file` — cada `write_file`/`apply_patch` queda respaldado automáticamente; cola de ejecución por-repo (una operación lógica completa como unidad atómica, no cada comando `git` suelto) + timeout real.
- **Orquestación**: `list_windows`, `send_to_window`, `parallel_ask`.
- **Multimedia**: `generate_image` (Microsoft Foundry o Gemini/Nano Banana, según la conexión).
- **Web**: `web_search`, `web_fetch` (vía Tavily).
- **Productividad**: `todo_write`, `exit_plan_mode`, `load_skill` (formato Agent Skills, divulgación progresiva).

Todas las llamadas a herramientas MCP y `read_document` tienen timeout real (`guard/`), con higiene de loop por resultado repetido.

## LSP real — 20 lenguajes

Diagnósticos en vivo + navegación por símbolos (`find_definition`/`find_references`/`list_symbols`) sobre servidores LSP reales (no simulados), config-driven (`LANGUAGE_SERVERS`):

TypeScript, JavaScript, Python, Rust, Go, C, C++, Java, YAML, Bash, Terraform, Lua, Dart, Gleam, Clojure, Typst, Zig, Svelte, Astro, Prisma, y Deno (con detección condicional real por `deno.json`, para no colisionar con TypeScript/JavaScript en el mismo workspace).

Vue quedó descartado tal cual está (`@vue/language-server` sin camino real hoy) y Nix quedó descartado sin camino real — ambos documentados en `PENDING.md`, no pendientes de este README.

## MCP

- Cliente MCP real para los runtimes API (lee `.mcp.json`, mergea el catálogo de tools del servidor con el propio).
- Servidor MCP propio de Amatista para exponer LSP a los 3 runtimes CLI (`claude-cli`/`antigravity-cli`/`codex-subscription`), con pre-aprobación de sus 4 tools.

## Persistencia

- Chats persistidos localmente (SQLite), independientes del workspace activo.
- VCS local oculto por workspace — cada escritura real (`write_file`/`apply_patch`) queda respaldada con historial y `revert_file`, sin usar el `.git` real del proyecto del usuario.
- Todo el almacenamiento (datos, cache, cookies) vive centralizado bajo una carpeta de datos propia, configurable en el instalador (con validación de origen: la carpeta de datos no puede ser `$INSTDIR` ni una subcarpeta suya).

## Visión e imágenes

- Visión real en los 4 runtimes API y en los 2 runtimes CLI.
- Generación de imágenes real (`generate_image`) vía Foundry o Gemini/Nano Banana, según la conexión activa.

## Documentación viva

- [`docs/_arch/CONTRACT.md`](docs/_arch/CONTRACT.md) — contratos de interfaces/tipos/invariantes vigentes, con la verificación real de cada fix/feature.
- [`docs/_arch/HISTORY.md`](docs/_arch/HISTORY.md) — bitácora append-only, una entrada por fase/fix.
- [`docs/_arch/PENDING.md`](docs/_arch/PENDING.md) — lo que sigue abierto, descartado explícitamente, o resuelto (con motivo).

## Desarrollo

```powershell
npm install
npm run typecheck
npm run dev
```

## Build / instalador

```powershell
npm run build   # typecheck + electron-vite build + bundle del servidor MCP de LSP
npm run dist    # build + instalador NSIS real (Windows)
```
