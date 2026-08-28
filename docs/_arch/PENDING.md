# PENDING.md — Backlog de Fases

> Tareas identificadas pero no ejecutadas todavía. El arquitecto las prioriza.

## Fase 22b — lo que 22a dejó a propósito sin resolver

Fase 22a (infraestructura real de multi-ventana) es deliberadamente pre-requisito, no la fase que aísla conexiones. Queda explícitamente pendiente para 22b:

- **`agent:connect` sigue matando la conexión anterior incondicionalmente** (`disconnectAgent()` sin condición, `ipc-agent.ts`) — con 2 ventanas reales ya posibles (22a), conectar desde la ventana B hoy sigue matando la conexión de la ventana A sin aviso. Esto es EL problema central de Fase 22, no tocado a propósito.
- **Las 9 variables singulares de `runtime-state.ts`** (`codexClient`/`cliRuntime`/`apiRuntime`/`mcpManager`/`lspManager`/`activeRuntime`/`activeWorkspace`/`activeThreadId`/`activeChatId`) siguen siendo una sola instancia compartida por toda la app, no indexada por sesión/ventana — ver el mapeo completo en `docs/_arch/verify_fase22_scope.md` (Fase 22, Tarea 0).
- **`activeConnectionWindowId` (nuevo en 22a) es solo informativo** — `agent:send` ya compara el `event.sender` de la llamada contra esta variable y loguea (bajo `AMATISTA_DEBUG_TOOLS=1`) si no coinciden, pero no rechaza la llamada. 22b es quien debería decidir si eso pasa a ser un `throw` real (o algo más matizado) una vez que exista más de una conexión real para comparar.
- **Los 13 sitios de `disconnect()` en `App.tsx` (Parte A.1 de `verify_fase22_scope.md`)** siguen disparando sobre el runtime global único — su clasificación (a)/(b)/(c) ya está hecha, falta decidir el fix real por categoría una vez que haya conexiones indexadas de verdad para aplicárselo.
- **Parte D de `verify_fase22_scope.md`** (staleness de `write_file`/`apply_patch` entre lectura y escritura, ventana de riesgo = tiempo de aprobación humana) sigue sin ningún mecanismo de detección — relevante recién cuando 2 sesiones puedan tocar el mismo proyecto a la vez de verdad.

## Encontrado durante Fase 21.5 — revisar el fallback de `handleAgentEvent()` antes de Fase 22

**No es un bug hoy — riesgo residual real que Fase 22 (sesiones concurrentes) puede activar.** `handleAgentEvent()` (`App.tsx`) arma su variable local (llamada `workspace`, nombre engañoso — en la práctica ya funciona como "el chat id de este evento") así:

```typescript
const workspace = asString(event.chatId) || asString(event.workspace) || activeChatIdRef.current
```

Prioriza `event.chatId` (el dato correcto, que `sendAgentEvent()` en `runtime-state.ts` siempre incluye) y funciona bien en el caso normal. El riesgo está en el 2do fallback: si `activeChatId` en el proceso main fuera `null` en el momento exacto de un evento (ej. un turno arrancado antes de que el chat quedara asociado), cae a `event.workspace` — el path real del workspace, no un chat id. **Hoy es inofensivo porque, con el fix de Fase 21.5, ya no hay ningún chat con `id === workspace path`** — antes de Fase 21.5 sí lo había (todo chat creado vía `openProject()`), así que este mismo fallback era doblemente inofensivo por partida doble. Con sesiones concurrentes reales (Fase 22), un `chatId` nulo en ese instante podría enrutar mensajes de un turno a un bucket (`chats[workspacePath]`) que ninguna UI lee, en vez de al chat real — silencioso, no un crash.

**No investigado si es alcanzable en la práctica** (bajo qué secuencia real `activeChatId` podría ser `null` durante un turno activo) — quedó fuera del alcance de Fase 21.5 a propósito. Revisar esto como parte del diseño de Fase 22, antes de asumir que el fallback nunca dispara.

## RESUELTO (Fase 3) — Pérdida real de contexto

> Confirmado con evidencia en Fase 1 Tarea C, diseño fijado en la ronda de decisiones previa a Fase 3, implementado en Fase 3. El detalle completo del bug original (tres constantes triplicadas, fórmula exacta del hueco `[0, N-26)`, alcance por runtime) queda preservado en [CONTRACT.md](./CONTRACT.md) → "Contrato de memoria/contexto — v1 (DEPRECATED, ver v2)" — no se repite acá. El diseño vigente está en la v2 de esa misma sección.
>
> Resuelto para runtimes API (`anthropic-api`, `foundry`, `gemini-api`): compactación real vía LLM, persistida en SQLite por chat (`summary` + `summary_watermark_id`, watermark por id de mensaje — inmune a ediciones/borrados), disparada asíncronamente después de cada turno sin agregar latencia. De paso se corrigió un segundo bug real encontrado durante la implementación: `foundry` y `gemini-api` nunca leían `compactSummary` en absoluto (ni siquiera el truncado viejo) — solo `anthropic-api` lo usaba.
>
> **Caveat documentado, no oculto** (ver CONTRACT.md v2): en un chat viejo retomado con backlog grande nunca compactado, puede haber un hueco transitorio entre resumen y ventana verbatim en los primeros turnos post-actualización — se cierra en pasadas sucesivas de compactación, nunca de una sola vez. Ningún dato se pierde nunca (SQLite persiste todo siempre); el hueco, cuando existe, es solo de lo que un turno puntual le manda al modelo.

## Encontrado durante Fase 15 — el botón "Compatible" (`type:'openai-compatible'`) ignora el endpoint que muestra

**Bug real, confirmado leyendo el código (no corregido — se encontró investigando dónde encajaba OpenRouter, fuera del alcance de esa fase).** `type:'openai-compatible'` resuelve a `runtime:'codex-api'` (`runtimeFor()`, `App.tsx`), que corre por `codex-client.ts` — spawnea el binario `codex` real vía JSON-RPC. Ese archivo **nunca lee `provider.endpoint`** (`grep` sobre `OPENAI_BASE_URL|baseUrl|provider.endpoint` en `codex-client.ts` → cero resultados): `start()` solo setea `env.OPENAI_API_KEY = apiKey` y arranca `codex app-server --stdio`, sin pasarle ningún endpoint custom.

**Efecto real:** el campo "Endpoint" que la UI muestra para este botón es un placebo — cualquier URL que el usuario cargue ahí (servidor local, proxy propio, cualquier backend Chat-Completions-compatible) se ignora en silencio, y la conexión sigue yendo contra la OpenAI real (o lo que `codex` CLI tenga configurado en su propio `~/.codex/config.toml`) con la API key que el usuario cargó pensando que era para su propio endpoint. Sin error, sin aviso — potencialmente confuso o costoso si esa key es real y de pago.

**Fix, cuando se priorice — dos caminos, ninguno trivial, no elegido en esta fase:**
1. Investigar si `codex-cli` soporta apuntar a un backend custom vía `config.toml` (`model_providers.<id>.base_url`) y threadear `provider.endpoint` hasta ahí (mismo camino que se descartó para OpenRouter en Fase 15, por seguir dependiendo de un proceso `codex` externo en vez de HTTP directo).
2. Migrar `type:'openai-compatible'`/`'openai'` al runtime `openai-chat` nuevo (Fase 15, Chat Completions real vía `api-agent-runtime.ts`) — más directo, pero cambia el mecanismo de conexión de esos dos botones (hoy pasan por CLI/Codex, con las tools/aprobaciones que eso implica) — decisión de diseño, no un fix mecánico.

## Sin priorizar (originado en el cierre de Fase 3)

- **¿Los runtimes CLI (`claude-cli`, `codex-subscription`) también necesitan un mecanismo de compactación propio?** Quedaron fuera de alcance de Fase 3 por decisión explícita (dependen de `--resume <sessionId>` del binario externo para memoria de turnos posteriores al primero). No se investigó qué tan bien retiene contexto ese mecanismo externo en chats muy largos — si "urge" o no queda sin evaluar.

## RESUELTO (Fase 14, seguimiento) — `compactionProviderId`/`compactionModelId` nunca se persistían

> Encontrado como hallazgo colateral al cerrar Fase 14, confirmado con evidencia real (`docs/_arch/verify_compaction_settings.md`) y corregido en un fix de seguimiento el mismo día, después de que el bug causara un error real y visible en uso activo (`"explore falló: No hay modelo de compactación configurado"`, justo tras un reinicio de la app). Detalle completo del mecanismo confirmado y el fix en `docs/_arch/CONTRACT.md` → "Timeout del watchdog de turno configurable (Fase 14)".
>
> Resumen: `AppSettings.compactionProviderId`/`compactionModelId` (Fase 3) nunca se habían agregado a `StoredSettings`/`loadSettings()`/`saveSettings()` en `settings-store.ts` — se perdían en cada reinicio de la app (dentro de la misma sesión andaban bien). Fix: agregados a `StoredSettings` y threadeados en `loadSettings()`/`saveSettings()`, mismo patrón que `turnWatchdogSeconds`, sin guard de validez (son IDs de string, `resolveConfiguredCompactionModel()` ya descarta ids inválidos). Verificado con un roundtrip real a disco (sembrado → releído → cambiado → releído tras un restart simulado).

## Sin priorizar (originado en el cierre de Fase 11)

- **Recuperación selectiva por tema.** La inyección de memoria por tema (Fase 11) sigue siendo completa — todos los temas, siempre — igual que Fase 6 lo era para las 3 listas planas. Con muchos temas acumulados en un chat muy largo, esto puede volver a acercarse al mismo tipo de presión de contexto que motivó Fase 3, ahora en la memoria estructurada en vez del historial verbatim. Filtrar/priorizar temas relevantes al turno actual (en vez de mandarlos todos) fue evaluado y descartado explícitamente como fuera de alcance de esta fase — decisión ya tomada, no un olvido — pero queda anotado para priorizar si algún chat real llega a acumular suficientes temas como para que importe.

## RESUELTO (Fase 12) — Race condition de `activeWorkspace` en `agent:connect`

> Originado como caveat sin confirmar en "Encontrado durante refactor (Fase 2)" (mismatch de tipos `activeProjectPath` en `ipc-agent.ts`) — el fix de tipos de esa fase (`activeProjectPath: payload.workspace?.trim() ? activeWorkspace ?? undefined : settings.activeProjectPath`, `ipc-agent.ts`) quedó sin confirmar si la carrera que lo motivaba era alcanzable en la práctica. Investigado y blindado en Fase 12.
>
> **Tarea 1 — Alcanzabilidad, confirmada con el código real, no asumida:** el botón "Quitar" de una carpeta raíz (`App.tsx`, sidebar "PROYECTOS") **no tiene ningún `disabled` ligado a `agentState`** — a diferencia del botón "Conectar agente" (`disabled={... || agentState === 'connecting'}`) y el botón de enviar (`disabled={agentState === 'connecting'}`), que sí lo tienen. Un click en "Quitar" mientras `connectAgent()` sigue en vuelo dispara `projects:removeRoot` sin ningún bloqueo de UI. Si el root removido matchea el workspace activo, ese handler (`ipc-projects-workspace.ts`) llama `disconnectAgent()` (para procesos, resetea `apiRuntime`/`cliRuntime`/`codexClient`/`mcpManager`/`activeRuntime` a `null`) y luego `setActiveWorkspace(null)` — mientras `agent:connect` puede seguir en cualquiera de sus 3 awaits (`client.start()`, `detectClaude()`/`detectGemini()`, `mcpManagerForConnection.startAll()`). **Confirmado alcanzable, no solo teórico.**
>
> **Hallazgo real durante la investigación, más severo que el caveat original:** el riesgo no era solo `null` vs `undefined` en `settings.json` — sin blindaje, la conexión en vuelo seguía de largo tras la carrera y terminaba **resucitando** `apiRuntime`/`mcpManager`/`activeRuntime` (via `setApiRuntime`/`setMcpManager`/`setActiveRuntime`) que el `disconnectAgent()` concurrente ya había parado, dejando al renderer creyendo "conectado" (`agentState = 'connected'`) mientras el proceso principal quedaba en un estado inconsistente (o, en el otro orden posible, con el `mcpManager`/`client` recién arrancados por la conexión en vuelo parados a mitad de arranque por el `disconnectAgent()` concurrente, sin que `agent:connect` se enterara).
>
> **Fix (Tarea 2 — blindaje mínimo, `ipc-agent.ts`):** `assertWorkspaceStillActive(connectingWorkspace, cleanup?)`, un guard que compara `activeWorkspace` contra el valor capturado **antes** de los 3 awaits de `agent:connect` — si cambió (la carrera ocurrió), para explícitamente lo que esa conexión ya había arrancado (`client.stop()` / `mcpManagerForConnection.stopAll()`, ambos idempotentes — no rompen si `disconnectAgent()` ya los paró) y aborta con un `Error` claro en vez de continuar. Se invoca justo después de cada uno de los 3 awaits relevantes (`client.start()`, `detectClaude()`/`detectGemini()`, `mcpManagerForConnection.startAll()`), antes de cualquier `setActiveThreadId`/`setActiveRuntime`/`runtime.configure()` posterior. La rama CLI no necesita `cleanup` — no arranca ningún proceso antes de su único await.
>
> El fix de tipos original de Fase 2 (`activeProjectPath: ... ?? undefined`) queda sin cambios — sigue siendo correcto y necesario, el blindaje de esta fase es una capa adicional que hace que, en el escenario de carrera, `agent:connect` ni siquiera llegue a esa línea.
>
> `npm run typecheck` y `npm run build` en verde.
