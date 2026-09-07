# CONTRACT.md — Contratos de Arquitectura Amatista

> Fuente de verdad de interfaces, tipos y invariantes acordados entre fases.
> Cada contrato se agrega, nunca se borra. Si un contrato cambia, se versiona (v1, v2) y se marca el anterior como DEPRECATED con motivo.

## Índice
- [Contrato de memoria/contexto — v1 (DEPRECATED, ver v2)](#contrato-de-memoriacontexto--v1-deprecated-ver-v2)
- [Contrato de memoria/contexto — v2 (Fase 3, extendida en Fase 6 y Fase 11)](#contrato-de-memoriacontexto--v2-fase-3-extendida-en-fase-6-y-fase-11)
- [Módulos de src/main/ (post Fase 2)](#módulos-de-srcmain-post-fase-2)
- [Tool explore (Fase 4)](#tool-explore-fase-4)
- [Tool apply_patch (Fase 5)](#tool-apply_patch-fase-5)
- [AGENTS.md por proyecto (Fase 7)](#agentsmd-por-proyecto-fase-7)
- [VCS local oculto (Fase 8)](#vcs-local-oculto-fase-8)
- [Housekeeping: framing JSON-RPC + stub muerto (Fase 9)](#housekeeping-framing-json-rpc--stub-muerto-fase-9)
- [Cliente MCP para runtimes API (Fase 10)](#cliente-mcp-para-runtimes-api-fase-10)
- [Sandbox mode no aplicado en runtimes API (Fase 12)](#sandbox-mode-no-aplicado-en-runtimes-api-fase-12)
- [allowSubscription: opción "Suscripción" ofrecida a proveedores que no la soportan](#allowsubscription-opcion-suscripcion-ofrecida-a-proveedores-que-no-la-soportan)
- [Fallback de detección de CLI vía shim npm global (cli-status.ts)](#fallback-de-deteccion-de-cli-via-shim-npm-global-cli-statusts)
- [Nivel de esfuerzo/razonamiento configurable por turno (Fase 13)](#nivel-de-esfuerzorazonamiento-configurable-por-turno-fase-13)
- [Timeout del watchdog de turno configurable (Fase 14)](#timeout-del-watchdog-de-turno-configurable-fase-14)
- [Runtime OpenRouter / Chat Completions (Fase 15)](#runtime-openrouter--chat-completions-fase-15)
- [Tool search_files (Fase 16)](#tool-search_files-fase-16)
- [Mensajería entre ventanas — Paso 3: tool send_to_window, auto-open/auto-connect, aprobación siempre-on, distinción visual](#mensajería-entre-ventanas--paso-3-tool-send_to_window-auto-openauto-connect-aprobación-siempre-on-distinción-visual)
- [UI Paso 1 — tool list_windows() + protección contra auto-envío](#ui-paso-1--tool-list_windows-protección-contra-auto-envío)
- [Fase Paneles-1 — backend: panelId reemplaza windowId, multi-ventana retirado](#fase-paneles-1--backend-panelid-reemplaza-windowid-multi-ventana-retirado)
- [Retiro completo de claude-cli](#retiro-completo-de-claude-cli)
- [Fase Paneles-2a — modelo activo por chat, no por AppSettings global](#fase-paneles-2a--modelo-activo-por-chat-no-por-appsettings-global)
- [Fase Paneles-2b — `<ChatPanel>` real, layout dinámico 1-4](#fase-paneles-2b--chatpanel-real-layout-dinamico-1-4)
- [Fix Gemini CLI: `geminiCommand()`, bug real de arg-splitting con `shell:true`](#fix-gemini-cli-geminicommand-bug-real-de-arg-splitting-con-shelltrue)
- [Fix carrera de `settings:save`: merge por campo en vez de reemplazo total](#fix-carrera-de-settingssave-merge-por-campo-en-vez-de-reemplazo-total)
- [Fase Paneles-3 — auto-open real: main pide, renderer abre y conecta](#fase-paneles-3--auto-open-real-main-pide-renderer-abre-y-conecta)
- [Fix bug de contraste real — botones "Desactivar/Activar"/"Eliminar" en Conexiones (Settings)](#fix-bug-de-contraste-real--botones-desactivaractivareliminar-en-conexiones-settings)
- [Fix bug real — selector de modelo invisible al abrirlo en un `<ChatPanel>`](#fix-bug-real--selector-de-modelo-invisible-al-abrirlo-en-un-chatpanel)
- [Fix bug real — `addPanelForChat()` reabría el chat de origen en vez de crear uno nuevo](#fix-bug-real--addpanelforchat-reabria-el-chat-de-origen-en-vez-de-crear-uno-nuevo)
- [Falso positivo descartado + fix real distinto — menú contextual del composer](#falso-positivo-descartado--fix-real-distinto--menu-contextual-del-composer)
- [Fix bug real — nombrado de paneles nuevos: `addPanelForChat()` generaba títulos duplicados](#fix-bug-real--nombrado-de-paneles-nuevos-addpanelforchat-generaba-titulos-duplicados)
- [Fix contraste — Tanda 1+3 (auditoría mecánica, docs/_arch/verify_contrast_audit.md)](#fix-contraste--tanda-13-auditoria-mecanica-docs_archverify_contrast_auditmd)
- [Feature "Panel N" — alias corto para send_to_window, sin round-trip nuevo](#feature-panel-n--alias-corto-para-send_to_window-sin-round-trip-nuevo)
- [Fix bug real — `openChatInPanel()` devolvía `null` cuando el caller era un callback de IPC](#fix-bug-real--openchatinpanel-devolvia-null-cuando-el-caller-era-un-callback-de-ipc)
- [Feature "árbol de sub-chats" — parentChatId + sidebar anidado con borde de color por provider](#feature-arbol-de-sub-chats--parentchatid--sidebar-anidado-con-borde-de-color-por-provider)
- [Fix bug real — resolveOrCreateChatForPath() conflacionaba title/workspaceName, con dato real ya contaminado en producción](#fix-bug-real--resolveorcreatechatforpath-conflacionaba-titleworkspacename-con-dato-real-ya-contaminado-en-produccion)
- [Feature "generación de imágenes" — tool generate_image real vía Foundry, configurable, distinción visual](#feature-generacion-de-imagenes--tool-generate_image-real-via-foundry-configurable-distincion-visual)
- [Feature "LSP para Python" — pyright real, coexistencia con TypeScript en el mismo workspace](#feature-lsp-para-python--pyright-real-coexistencia-con-typescript-en-el-mismo-workspace)
- [Feature "LSP para Rust" — rust-analyzer real, binario externo detectado (no bundleado), 3 lenguajes coexistiendo](#feature-lsp-para-rust--rust-analyzer-real-binario-externo-detectado-no-bundleado-3-lenguajes-coexistiendo)
- [Feature "LSP para Go" — gopls real, 4 lenguajes coexistiendo, distinción "no instalado" vs "no pudo analizar"](#feature-lsp-para-go--gopls-real-4-lenguajes-coexistiendo-distincion-no-instalado-vs-no-pudo-analizar)
- [Feature "Indexación por símbolos vía LSP" — find_definition/find_references/list_symbols, apertura bajo demanda](#feature-indexacion-por-simbolos-via-lsp--find_definitionfind_referenceslist_symbols-apertura-bajo-demanda)
- [Fix: get_diagnostics() sin path contaminado por archivos solo navegados (ensureOpen())](#fix-get_diagnostics-sin-path-contaminado-por-archivos-solo-navegados-ensureopen)
- [Demo grabada de los 4 lenguajes — trazabilidad JSON-RPC, fix real de error de protocolo, verificación end-to-end](#demo-grabada-de-los-4-lenguajes--trazabilidad-json-rpc-fix-real-de-error-de-protocolo-verificacion-end-to-end)
- [Fase 1 del benchmark SWE-Bench ProMax — aislamiento de datos, portabilidad Linux, instrumentación real de tokens](#fase-1-del-benchmark-swe-bench-promax--aislamiento-de-datos-portabilidad-linux-instrumentacion-real-de-tokens)
- [Fase 2 del benchmark SWE-Bench ProMax — harness real (benchmark/), MAX_TOOL_LOOP configurable, pilot end-to-end en Praxis Liber](#fase-2-del-benchmark-swe-bench-promax--harness-real-benchmark-max_tool_loop-configurable-pilot-end-to-end-en-praxis-liber)
- [Fase 2 del benchmark, retomada — OpenAI directo (gpt-5.2), fix real de max_completion_tokens, primer patch no vacío](#fase-2-del-benchmark-retomada--openai-directo-gpt-52-fix-real-de-max_completion_tokens-primer-patch-no-vacio)
- [Fase 3 del benchmark — evaluación real con Docker, disco dedicado, piloto completo](#fase-3-del-benchmark--evaluacion-real-con-docker-disco-dedicado-piloto-completo)
- [Fix real de descriptions — find_definition/find_references/list_symbols no competían contra search_files](#fix-real-de-descriptions--find_definitionfind_referenceslist_symbols-no-competian-contra-search_files)
- [LSP forzado — AMATISTA_EXCLUDED_TOOLS, comparación real optuna__optuna-6197 con/sin search_files](#lsp-forzado--amatista_excluded_tools-comparacion-real-optuna__optuna-6197-consin-search_files)
- [Tool read_document — PDF/DOCX/XLSX/HTML, paginado real, fallback de visión para páginas escaneadas](#tool-read_document--pdfdocxxlsxhtml-paginado-real-fallback-de-vision-para-paginas-escaneadas)
- [Fix real — Codex dejaba rastro en ~/.codex/sessions/ por cada turno automatizado de Amatista](#fix-real--codex-dejaba-rastro-en-codexsessions-por-cada-turno-automatizado-de-amatista)
- [Fix real — edición de conexiones (Settings) + aviso de proveedor huérfano](#fix-real--edicion-de-conexiones-settings--aviso-de-proveedor-huerfano)
- [Reintegración completa de claude-cli](#reintegracion-completa-de-claude-cli)
- [Infraestructura de HOME aislado para Antigravity CLI](#infraestructura-de-home-aislado-para-antigravity-cli)
- [Integración completa de Antigravity CLI](#integracion-completa-de-antigravity-cli)

## Contrato de memoria/contexto — v1 (DEPRECATED, ver v2)

> **DEPRECATED — reemplazado por v2 (Fase 3).** Motivo: v1 describía un truncado local en el renderer (`compactSummaryFor` en `App.tsx`) que NO generaba resumen real y dejaba `[0, N-26)` sin enviar en ningún lado en runtimes API — el hallazgo documentado en [PENDING.md](./PENDING.md). Fase 3 lo reemplazó por compactación real vía LLM, persistida en SQLite. Esta sección se conserva sin editar, como registro histórico de lo que existía antes — no como comportamiento actual. Ver v2 más abajo para el diseño vigente.

> Esta sección describe el comportamiento actual conocido con bugs — no es una recomendación de diseño. Es la línea base documentada antes de tocar nada, para poder comparar contra el fix cuando se priorice (ver [PENDING.md](./PENDING.md) → "P0 — Pérdida real de contexto").

**Las tres constantes:**

| Constante | Valor | Archivo |
|---|---|---|
| `RUNTIME_HISTORY_LIMIT` | 18 | `src/renderer/src/App.tsx` |
| `RUNTIME_SUMMARY_TRIGGER` | 18 | `src/renderer/src/App.tsx` |
| `MAX_HISTORY_MESSAGES` | 18 | `src/main/context-envelope.ts` |

Tres declaraciones independientes del mismo número, en dos archivos distintos, sin importar una de la otra.

**Flujo de datos, turno por turno:**

1. **`App.tsx` (renderer)** — `runTurn()` llama a `toRuntimeHistory(historyMessages)` (últimos `RUNTIME_HISTORY_LIMIT` mensajes, tal cual) y a `compactSummaryFor(historyMessages)` (los 8 mensajes anteriores a esos, truncados a 500 chars c/u, solo si `messages.length > RUNTIME_SUMMARY_TRIGGER`; si no, `undefined`). Ambos van en el payload de `sendMessage`.
2. **`ipc-agent.ts` (`agent:send`)** — recibe `payload.history` y `payload.compactSummary`, arma el `RuntimeContextEnvelope` vía `buildRuntimeContext()` (`runtime-state.ts`), que llama a `normalizeHistory(payload.history)` sin volver a tocar `compactSummary`.
3. **`context-envelope.ts`** — `normalizeHistory()` vuelve a recortar a `MAX_HISTORY_MESSAGES` (18) y a `MAX_MESSAGE_CHARS` (5000) por mensaje — un segundo recorte redundante sobre un array que ya venía acotado a 18 desde el renderer. `formatContextEnvelope()` arma el texto final: inyecta `compactSummary` (si existe) bajo `"Resumen acumulado:"`, después el historial normalizado bajo `"Historial reciente:"`, después el mensaje actual.
4. **Bifurca por tipo de runtime:**
   - **`api-agent-runtime.ts`** (runtimes `anthropic-api`, `foundry`, `gemini-api`) — antepone `context.compactSummary` como parte del system prompt en **cada turno**, vía `sendAnthropicApi()`/equivalentes. Es el camino que sufre la pérdida `[0, N-26)` en cada turno del chat.
   - **`cli-agent-runtime.ts`** (runtimes `claude-cli`, `codex-subscription` vía Codex por separado) — arma `formatContextEnvelope(context)` como prompt **solo si `context` viene definido**, y `context` (`seedContext`) solo se construye una vez por conexión, gated por `!activeContextSeeded` en `ipc-agent.ts`. Turnos siguientes al primero solo mandan `text` + `--resume <sessionId>`: la memoria de esos turnos depende del binario CLI externo, no de este mecanismo — no sufre la pérdida `[0, N-26)` descrita arriba (pero sí queda sujeto a lo que el CLI externo retenga con `--resume`, no auditado en esta tarea).

## Contrato de memoria/contexto — v2 (Fase 3, extendida en Fase 6 y Fase 11)

> Reemplaza v1. Compactación real vía LLM, persistida en SQLite, disparada en segundo plano — nunca bloquea el turno en curso. Alcance: runtimes API (`anthropic-api`, `foundry`, `gemini-api`, incluye DeepSeek vía `anthropic-api`). Runtimes CLI (`claude-cli`, `codex-subscription`) quedan fuera del motor de compactación por decisión de fase; siguen usando `--resume` externo, sin cambios de este contrato salvo que ahora pueden heredar, de arranque, un resumen ya persistido si el chat se usó antes con un runtime API (mismo campo `compactSummary`, sin lógica CLI nueva).
>
> **Nota de versionado:** Fase 6 (extracción estructurada — decisions/constraints/nextSteps) **extiende esta misma v2, no crea una v3**. El mecanismo (una compactación LLM por pasada, watermark por id de mensaje, disparo asíncrono fire-and-forget, presupuesto único) es idéntico al de Fase 3; lo único que cambia es QUÉ devuelve y persiste esa misma llamada. La sección "Extracción estructurada (Fase 6)" al final de este bloque documenta el agregado sin reescribir lo de arriba.

**Invariante objetivo:** `resumen ∪ mensajes-verbatim-enviados = conversación completa`, en régimen estable. **Excepción documentada, no oculta:** en un chat viejo retomado con backlog grande nunca compactado (watermark `null`), puede haber un hueco transitorio entre lo que cubre el resumen y la ventana verbatim reciente — se cierra en pasadas sucesivas de compactación a lo largo de varios turnos, nunca de una sola vez (ver Tarea 5 más abajo). Ningún dato del usuario se pierde nunca: SQLite (`chat-store.ts`) persiste el historial completo siempre, sin importar qué se le mande al modelo en un turno dado — el hueco, cuando existe, es solo de lo que ese turno puntual le llega al modelo.

**Presupuesto único** (`src/shared/context-budget.ts` → `CONTEXT_TOKEN_BUDGET = 6000`, heurística chars/4, sin librería de tokenización): reemplaza las tres constantes triplicadas de v1. Un solo número, tres roles:
1. Techo duro de historial verbatim por turno (`normalizeHistory` en `context-envelope.ts`) — independiente del watermark, cubre el caso de backfill (Tarea 5).
2. Umbral de disparo de compactación: si el backlog posterior al watermark supera este número, vale la pena compactar (`compaction-engine.ts`).
3. Tamaño del bloque más viejo que se compacta por pasada — nunca se manda el backlog completo de una sola vez.

**Persistencia** (`chat-store.ts`, tabla `chat_sessions`, columnas nuevas vía `ALTER TABLE` + `try/catch`, mismo patrón que `tool_steps`):
- `summary TEXT` — resumen acumulado en texto plano.
- `summary_watermark_id TEXT` — **id** de `chat_messages` (no posición/índice — inmune a ediciones/borrados que desplazan todo lo posterior) hasta donde ese resumen ya cubre. `null` = nada resumido todavía.
- Invalidación: `deleteChatMessagesFrom()` (editar/regenerar) borra el mensaje watermark y todo lo posterior cuando el punto de edición cae en o antes del watermark; en ese caso `summary`/`summary_watermark_id` se resetean a `null` en la misma llamada — un resumen que describe mensajes que el usuario ya borró es peor que ningún resumen, no se deja desincronizado en silencio.

**Flujo de datos, turno por turno (runtimes API):**
1. **`App.tsx`** — `toRuntimeHistory()` ya NO recorta por presupuesto de contexto (ese recorte en el renderer, documentado como redundante en la v1 de este contrato, se elimina en vez de mantenerse sincronizado a mano con el main). Manda el historial completo del chat, con un único techo de tamaño de payload IPC (`IPC_HISTORY_PAYLOAD_CAP = 500` mensajes) ajeno al presupuesto de contexto — evita mandar miles de mensajes de un chat viejo en cada tecleo, no decide cuánto ve el modelo. Tampoco calcula ni manda `compactSummary`: ese campo lo resuelve el main desde SQLite por `chatId`.
2. **`ipc-agent.ts` (`agent:send`)** — `buildRuntimeContext()` recibe `chatId` (no `compactSummary`) y arma el `RuntimeContextEnvelope` completo.
3. **`runtime-state.ts` (`buildRuntimeContext`)** — `compactSummary: getChatSummaryState(chatId)?.summary`, `history: normalizeHistory(payload.history)`. Único punto donde el resumen persistido entra al envelope.
4. **`context-envelope.ts` (`normalizeHistory`)** — único lugar que aplica el techo real de historial verbatim, por tamaño estimado (`CONTEXT_TOKEN_BUDGET`), tomando desde el mensaje más reciente hacia atrás.
5. **`api-agent-runtime.ts`** — los tres runtimes API inyectan `context.compactSummary` ahora: `sendAnthropicApi` ya lo hacía (campo `system` nativo); **`sendFoundry`/`sendGeminiApi` NO lo leían en absoluto antes de Fase 3** (bug real encontrado y corregido al conectar el resumen persistido, no solo el vacío de `App.tsx` que documentaba v1) — ambos lo pliegan como primer turno `role:'user'` con tag `[system]`, mismo patrón que ya usaban para historial `role:'system'` (ninguno de los dos tiene un campo `system`/`instructions` nativo probado en este codebase).
6. **`ipc-agent.ts`, después de `turn/completed`** — dispara `maybeCompactChatInBackground()` fire-and-forget (sin `await`, nunca agrega latencia, nunca hace fallar el turno si algo sale mal adentro). Solo si `requestChatId` existe.
7. **`compaction-engine.ts` (`maybeCompactChatInBackground`)** — lee watermark + backlog posterior (`chat-store.getMessagesAfter`, síncrono/SQLite, sin carrera). Si el backlog no supera `CONTEXT_TOKEN_BUDGET`, no hace nada. Si lo supera, toma el bloque **más viejo** del backlog hasta agotar el mismo presupuesto (nunca todo de una vez — Tarea 5), lo compacta con una llamada LLM de una sola vuelta (sin tools) contra el modelo de compactación configurado (`settings.compactionProviderId`/`compactionModelId`) o el modelo activo del turno si no hay uno dedicado o el configurado no es apto (`isApiCapableModel`, `src/shared/model-capabilities.ts`), y persiste `summary` + avanza `summary_watermark_id` al último mensaje del bloque. El resto del backlog, si sobra, queda para la próxima pasada.
8. **Nota de temporización, no un bug:** el mensaje del asistente de un turno recién se persiste en SQLite cuando el renderer procesa el evento `turn/completed` (`persistChatMessage`), lo cual ocurre DESPUÉS de que `ipc-agent.ts` ya disparó la compactación de ese mismo turno. Esa última vuelta queda fuera del backlog de esta pasada y se recoge en la siguiente — mismo mecanismo de "varias pasadas", no una excepción aparte.

**Settings (Tarea 6):** `AppSettings.compactionProviderId` / `compactionModelId` (`shared/types.ts`), seleccionables en el panel de Settings (`App.tsx`, sección "MEMORIA") entre cualquier modelo habilitado de cualquier proveedor habilitado que `isApiCapableModel` acepte. Sin selección, aviso explícito sugiriendo un modelo barato (Gemini Flash, DeepSeek Flash) — cae al modelo activo del turno, el bug se arregla igual, solo no se ahorra costo.

**Efecto colateral reconocido en runtimes CLI:** `normalizeHistory()` (`context-envelope.ts`) es compartida entre `api-agent-runtime.ts` y `cli-agent-runtime.ts` — este último la usa vía `formatContextEnvelope()`, en el primer turno de `claude-cli`/`codex-subscription` a través de `seedContext`. El cambio de Tarea 2 (recorte por conteo de mensajes → presupuesto de tokens estimados) se aplica ahí también, aunque la Fase 3 se haya declarado "fuera de alcance" para runtimes CLI en cuanto a compactación (watermark, resumen persistido, disparo asíncrono — nada de eso toca `cli-agent-runtime.ts`). Es consecuencia directa y esperada de centralizar `CONTEXT_TOKEN_BUDGET` en un solo lugar en vez de mantener una segunda constante paralela solo para no tocar el camino CLI — no un efecto colateral no evaluado. El resto del contrato CLI (que solo el primer turno construye `seedContext`, gated por `activeContextSeeded`, y que los turnos siguientes dependen enteramente de `--resume <sessionId>`) queda sin cambios.

**Extracción estructurada (Fase 6):** la misma llamada LLM de `maybeCompactChatInBackground()` (punto 7 de arriba) ahora pide y devuelve JSON — no una segunda llamada aparte, no un mecanismo nuevo de disparo/watermark/backlog (Fase 6 tenía prohibido tocar eso, y no lo tocó).

- **Forma del JSON:** `{"summary": string, "decisions": string[], "constraints": string[], "nextSteps": string[]}`. `summary` es el mismo resumen narrativo de siempre, sin cambio de criterio. `decisions`/`constraints`/`nextSteps` son **acumulativas**: cada pasada recibe las listas actuales (vacías si el chat nunca se compactó) junto con el bloque nuevo de mensajes, y el prompt (`compactionPrompt()`) instruye fusionar — conservar cada entrada existente TAL CUAL, agregar las nuevas, deduplicar, nunca resumir ni truncar las listas.
- **Persistencia** (`chat-store.ts`): cuarta columna en `chat_sessions`, `structured_memory TEXT` (JSON serializado), mismo patrón `ALTER TABLE` + `try/catch`. `getChatSummaryState()` devuelve `decisions`/`constraints`/`nextSteps` junto con `summary`/`watermarkMessageId` en el mismo objeto (una sola lectura). `setChatSummaryState()` gana un **4to parámetro requerido** — `structured: StructuredMemory`, no opcional — a propósito: si fuera opcional con default vacío, un call site que lo omitiera por descuido borraría en silencio todo lo acumulado, exactamente el bug que el fallback de abajo tiene que evitar. La invalidación por edición/borrado (`invalidateSummaryIfWatermarkMissing`) ahora también resetea `structured_memory` a `null` junto con `summary`/`watermark` — mismo razonamiento que ya aplicaba: memoria estructurada derivada de mensajes borrados es inválida, no parcialmente válida.
- **Fallback si el JSON es inválido (Tarea 3):** `parseCompactionResponse()` intenta `JSON.parse` (tolerando que el modelo envuelva la respuesta en un bloque ```` ```json ```` pese a la instrucción de no hacerlo) y exige que `summary` sea un string no vacío; si cualquiera de las dos cosas falla, devuelve `null`. En ese caso `maybeCompactChatInBackground()` trata la respuesta cruda completa como `summary` en texto plano (mismo comportamiento de Fase 3) y **reusa explícitamente las listas del estado anterior** como el `structured` que le pasa a `setChatSummaryState()` — nunca las vacía por un fallo de parseo. La pasada nunca falla por esto: incluso con JSON roto, el resumen sigue avanzando (aunque sea como texto plano) y el watermark avanza igual.
- **Limitación conocida, no oculta: la fusión "no perder entradas" es soft-enforcement vía prompt, no un invariante verificado en código.** `parseCompactionResponse()` solo valida que la respuesta sea JSON con un `summary` no vacío — NO compara `decisions`/`constraints`/`nextSteps` devueltos contra `existingStructured` para confirmar que sigue siendo superset, ni detecta si el modelo reescribió, resumió o directamente omitió una entrada previa pese a la instrucción explícita de `compactionPrompt()` de conservarlas TAL CUAL. Si el modelo barato configurado no sigue esa instrucción, el código lo persiste igual (siempre que el JSON sea válido) — a diferencia del watermark/backlog de Fase 3, que SÍ es un invariante de código (nunca se pierde un mensaje sin que quede o resumido o en el backlog). Ampliar `parseCompactionResponse()` con una verificación de superset (o un diff explícito para loguear si una pasada "perdió" una entrada) queda sin hacer — no evaluado si vale la pena el costo/complejidad frente a confiar en el prompt.
- **Inyección en el contexto — dos caminos, no uno:** `context-envelope.ts` (`formatContextEnvelope`) agrega un bloque "Decisiones y restricciones registradas:" (decisions + constraints, cada entrada con su etiqueta `[decision]`/`[restriccion]`) y un bloque separado "Próximos pasos pendientes:" (nextSteps), ambos ANTES de "Resumen acumulado:" — nextSteps queda aparte de decisions/constraints porque es forward-looking ("qué falta"), no estado ya establecido, mientras que decisions/constraints se tratan como hechos duros, no como prosa a reinterpretar. **Extensión más allá de lo literal de la Tarea 4, necesaria para que la Fase 6 sirva para algo:** `formatContextEnvelope()` solo la usa `cli-agent-runtime.ts` (primer turno, vía `seedContext`) — los tres runtimes API, que son donde la compactación realmente corre, arman su propio payload directo sin pasar por esa función (mismo patrón ya documentado arriba para `compactSummary` en Fase 3). Sin extender también `api-agent-runtime.ts`, `decisions`/`constraints`/`nextSteps` nunca habrían llegado a los runtimes que compactan — se agregó `memoryBlockText()` (helper compartido por `sendFoundry`/`sendGeminiApi`/`sendAnthropicApi`, mismo texto y mismo orden que `formatContextEnvelope`) para que el dato llegue a los tres, no solo al camino CLI.
- **Techo de tokens de salida — ya no un número fijo por archivo, configurable por modelo:** el `max_tokens: 2048→4096` fijo que esta fase agregó inicialmente para Anthropic (y el `max_tokens: 8192` fijo que ya tenía el runtime principal desde antes de Fase 3) se reemplazaron por `resolveMaxOutputTokens()` (`api-agent-runtime.ts`), a partir de un campo nuevo `ModelProfile.maxOutputTokens?: number` (`shared/types.ts`, configurable en Settings junto al campo "Modelo / deployment"). Foundry y Gemini nunca habían tenido un límite explícito en el body antes de este cambio (confirmado por lectura directa del código, no por suposición) — es la primera vez que lo tienen. Aplicado en los DOS lugares que llaman a cada proveedor: `api-agent-runtime.ts` (runtime principal, vía `ConfigureOptions.maxOutputTokens` propagado desde `ipc-agent.ts`) y `compaction-engine.ts` (que recibe el `ModelProfile` completo directamente, sin necesitar el mismo plumbing).

  Sin configurar (default, la mayoría de los modelos hoy), cada runtime usa el techo más generoso disponible en vez de un número chico "seguro":
  - **Gemini API**: 65536 fijo (`generationConfig.maxOutputTokens`, Gemini 2.5 Pro/Flash) — mejor evidencia documentada disponible al escribir esto, no verificada contra cada deployment puntual.
  - **Foundry** (Responses API, `max_output_tokens`): 128000 fijo — techo técnico general para modelos con ventana de 128k, tampoco verificado contra los deployments `q-assistant` puntuales que sugiere `FOUNDRY_Q_ASSISTANT_DEPLOYMENTS`.
  - **Anthropic**: **por modelo, no un número único** — `anthropic-api` sirve tanto a Claude real como a DeepSeek (mismo endpoint `/v1/messages`), y sus techos reales de salida son muy distintos. `anthropicMaxOutputTokensDefault(modelId)` (`api-agent-runtime.ts`) decide por substring del nombre del modelo (case-insensitive):
    - contiene `"deepseek"` → **384000**
    - contiene `"haiku"` → **64000**
    - cualquier otro caso (Opus/Sonnet/modelo no reconocido) → **128000**
    
    **Estos tres valores de Anthropic (384000 / 64000 / 128000) fueron CONFIRMADOS por el arquitecto del proyecto, no estimados ni documentados por este codebase** — a diferencia de los defaults de Gemini/Foundry (mejor evidencia disponible, sin verificar). Fuente: instrucción explícita en el chat de la sesión que implementó este fix, con la aclaración de que el bucket "no reconocido" debe caer en 128000 (Opus/Sonnet real) y nunca en 64000 (Haiku), para no capar a la mitad un modelo real por error de detección del nombre.

  En todos los casos, si un deployment concreto rechaza la llamada por pedir más de lo que soporta, la salida es bajar `maxOutputTokens` para ESE modelo en Settings, no bajar el default global.

**Fuera de alcance de esta fase, anotado en PENDING.md, no resuelto acá:** si los runtimes CLI también necesitan un mecanismo de compactación propio en vez de depender enteramente de `--resume` externo.

**Memoria jerárquica por tema (Fase 11):** extiende esta misma v2 — mismo mecanismo exacto de Fase 3/6 (una compactación LLM por pasada, watermark por id de mensaje, disparo asíncrono fire-and-forget, presupuesto único, tabla `chat_sessions`), sin módulo nuevo, sin tabla nueva, sin segunda llamada. Único cambio de forma: `decisions`/`constraints`/`nextSteps` pasan de **3 listas planas sueltas** (Fase 6) a **agrupadas por tema** — `Record<nombreDeTema, MemoryTopic>` donde `MemoryTopic = {decisions, constraints, nextSteps}` (tipo nuevo en `shared/types.ts`, reexportado como `StructuredMemory = Record<string, MemoryTopic>` en `chat-store.ts`). `summary` (resumen narrativo) **no cambia** — sigue siendo un único string, nunca agrupado por tema.

- **Prompt (`compactionPrompt()`, `compaction-engine.ts`):** el JSON pedido pasa de `{"summary", "decisions", "constraints", "nextSteps"}` a `{"summary", "topics": {"<nombre de tema>": {"decisions", "constraints", "nextSteps"}}}`. El input que recibe el modelo incluye explícitamente **los nombres de tema actuales** (`Object.keys(existingStructured)`) además del contenido completo de cada tema — instrucción explícita: reusar un tema existente si un hecho nuevo encaja ahí, crear uno nuevo SOLO si genuinamente no encaja en ninguno, nombres cortos y estables (2-4 palabras) con el mismo criterio de nombrado siempre, para que el mismo concepto no termine repartido entre nombres ligeramente distintos de una pasada a otra. Mismo contrato de fusión que Fase 6 (cada pasada devuelve el estado COMPLETO — temas tocados y no tocados — no un delta; el código no mergea nada, confía en que el modelo devuelva todo).
- **Parseo (`parseCompactionResponse()`):** ahora valida `record.topics` como objeto, recorre sus entradas y sanea cada tema con `asStringArray()` (exportado desde `chat-store.ts`, mismo helper que usa la migración de abajo — una sola definición, no duplicada). Mismo fallback que Fase 6: JSON inválido o sin `summary` → `null`, y `maybeCompactChatInBackground()` reusa los temas anteriores sin tocarlos.
- **Migración automática, sin pérdida (`parseStructuredMemory()`, `chat-store.ts`):** detecta el formato plano viejo de Fase 6 (`decisions`/`constraints`/`nextSteps` como arrays en la RAÍZ del JSON, sin agrupar) chequeando si alguno de esos tres campos es un array en la raíz. Si lo detecta, trata esas tres listas en memoria como un único tema `"General"` — **nunca reescribe la fila vieja en la base solo por leerla**; la próxima compactación natural de ese chat ya persiste la forma nueva agrupada (mismo patrón que cualquier otra migración lazy de este codebase). Si las tres listas vienen vacías, no crea un tema `"General"` vacío — devuelve `{}`.
- **Inyección (`context-envelope.ts` → `formatContextEnvelope()`, `api-agent-runtime.ts` → `memoryBlockText()`):** el bloque "Decisiones y restricciones registradas" + "Próximos pasos pendientes" de Fase 6 se reemplaza por un único bloque "Memoria por tema", con un heading `## <nombre de tema>` por tema (solo temas con al menos una entrada) y, dentro de cada uno, las mismas etiquetas `[decision]`/`[restriccion]`/`[proximo paso]` de siempre. El resumen narrativo sigue exactamente en el mismo lugar y forma (después de la memoria por tema, sin agrupar). Inyección sigue siendo completa — todos los temas, siempre — sin recuperación selectiva en esta fase (queda anotado como posible trabajo futuro en PENDING.md).

**Verificación real (Tarea 4), no solo typecheck** — bundle real de `compaction-engine.ts` + `chat-store.ts` vía esbuild (`--platform=node --format=cjs --external:electron` + stub de `electron` para que `app-paths.ts` resuelva), corrido con `node` puro contra la base SQLite real de producción (`D:\AMATISTA\data\config\amatista.db` — `app-paths.ts` no tiene override de storage root, así que se usó un `chatId` de prueba bien distintivo y se borró explícitamente al terminar; confirmado sin residuos con una segunda lectura directa de `chat_sessions`/`chat_messages` después de la corrida). Único punto mockeado: `global.fetch` (no hay LLM real disponible en este entorno) — todo lo demás (SQLite, parseo, migración, persistencia) es el código real ejecutándose.

  - **Pasada 1** (chat nuevo, sin estado previo): prompt confirmado con `Nombres de tema actuales: []`. El modelo (mockeado) devuelve 2 temas — `"Autenticación"` (`decisions: ["Usar JWT para autenticacion"]`, `constraints: ["No guardar password en texto plano"]`, `nextSteps: ["Implementar refresh token"]`) y `"Base de Datos"` (`decisions: ["Usar SQLite como motor"]`). Persistido y releído byte-a-byte igual.
  - **Pasada 2** (mismo chat, backlog nuevo): prompt confirmado con los 2 nombres de tema existentes listados como input. El modelo (mockeado, simulando una fusión correcta) agrega `"Tokens expiran a los 15 minutos"` **dentro del tema `"Autenticación"` ya existente** (confirmado: solo 1 tema cuyo nombre contiene "Autenticaci" tras la pasada — no aparece un tema casi-duplicado tipo "Autenticación JWT") y crea un tema genuinamente nuevo, `"Despliegue"` (`decisions: ["Usar Docker"]`, `nextSteps: ["Configurar CI/CD"]`), mientras `"Base de Datos"` se preserva sin cambios. Resultado final: 3 temas (`Autenticación`, `Base de Datos`, `Despliegue`), persistido y releído correcto.
  - **Migración:** fila `structured_memory` sembrada directamente en formato plano viejo (`{"decisions":["Vieja decision A"],"constraints":["Vieja restriccion B"],"nextSteps":["Viejo paso C"]}`). `getChatSummaryState()` la devolvió como `{"General": {"decisions":["Vieja decision A"],"constraints":["Vieja restriccion B"],"nextSteps":["Viejo paso C"]}}` — comparación campo a campo contra el original confirmó cero pérdida.
  - **Cleanup:** `chat_sessions`/`chat_messages` con los 2 `chatId` de prueba, ambos confirmados en `null`/`[]` tras `deleteChatSession()` — segunda verificación directa contra el archivo `amatista.db` real (fuera del proceso del driver) sin filas residuales.

## Módulos de src/main/ (post Fase 2)

`index.ts` (1366 líneas, ~30 handlers IPC + estado global mezclado con lógica de negocio) se partió en 10 módulos por responsabilidad única. Todos flat en `src/main/`, kebab-case, sin subcarpetas — mismo patrón que los módulos preexistentes (`chat-store.ts`, `tool-registry.ts`, etc.).

| Módulo | Responsabilidad |
|---|---|
| `runtime-state.ts` | Único módulo con estado mutable del proceso main (`mainWindow`, `activeWorkspace`, `activeRuntime`, `settings`, colas de aprobación de tools, etc.) + funciones puente hacia runtimes y renderer (`sendToRenderer`, `wireCodex/Cli/Api`, `disconnectAgent`, `buildRuntimeContext`). |
| `settings-provisioning.ts` | Construcción y saneamiento de `AppSettings`: proveedor Claude por suscripción, filtrado de proveedores/modelos locales no soportados (Ollama), import de proveedores desde `q_config.yaml` legado. Funciones puras, sin I/O ni estado global. |
| `attachments.ts` | Construcción de `ChatAttachment` desde ruta de disco o data URL pegado; límites de tamaño para preview/texto embebido. |
| `workspace-tree.ts` | Escaneo recursivo de un directorio de workspace hacia `TreeNode[]` para el explorador de archivos del renderer. |
| `ipc-window.ts` | Canales IPC de control de ventana (fullscreen). |
| `ipc-settings.ts` | Canales IPC de configuración: import de `q_config.yaml`, reset de estado local, get/save de `AppSettings`. |
| `ipc-chats.ts` | Canales IPC de persistencia de chats (delega directo a `chat-store.ts`). |
| `ipc-cli.ts` | Canales IPC de detección/instalación de CLIs (Codex, Claude, Gemini) y login/logout de cuenta Codex. |
| `ipc-projects-workspace.ts` | Canales IPC de `projectRoots` (carpetas registradas) y del workspace activo (árbol de archivos, lectura/escritura de archivos de texto). |
| `ipc-attachments.ts` | Canales IPC de adjuntos: picker de archivos, construcción desde rutas o data URL, preview base64. |
| `ipc-agent.ts` | Canales IPC del ciclo de vida del agente: connect/send/cancel, respuestas a server-request de Codex, aprobación/confianza de tool calls. |
| `index.ts` | Bootstrap puro: crea la ventana, llama a los 7 `register*Ipc()`, engancha ciclo de vida de `app`. Ya no contiene handlers ni lógica de negocio. |

### Decisión de patrón de estado (discutida, no default)

El estado compartido entre módulos IPC (`activeWorkspace`, `settings`, `activeRuntime`, etc.) se expone desde `runtime-state.ts` como **bindings vivos de ESM**: `export let <variable>` para lectura directa desde cualquier módulo importador, más una función `set<Variable>()` exportada para mutación cross-módulo (ESM no permite reasignar un binding importado directamente).

Se eligió este patrón — y no una clase singleton (`RuntimeState` con getters/setters) ni un store tipo Redux/reducer — porque:
- El código original ya dependía de closures compartidas sobre variables `let` a nivel de módulo; migrar a un singleton de clase o a un store con acciones habría sido una reescritura de la lógica de conexión/desconexión de runtimes, no una extracción mecánica — fuera del alcance de "refactor sin cambio de comportamiento" de la Fase 2.
- Los *live bindings* de ESM preservan exactamente la semántica de closures compartidas que tenía el monolito: un módulo que lee `activeWorkspace` ve siempre el valor actual, sin necesidad de pasar el estado como parámetro a cada función.

**Costo conocido de esta decisión** (ver también [PENDING.md](./PENDING.md) → "Encontrado durante refactor (Fase 2)"): TypeScript no puede aplicar *control-flow narrowing* a través de una llamada a función en otro módulo, aunque esa función internamente reasigne el binding. Esto ya causó un error de tipos real (`activeProjectPath`) que estaba enmascarado en el monolito por narrowing local. Se espera que aparezcan más casos similares a medida que se toquen otros puntos que leen/escriben este estado — no es un blocker, pero hay que anticiparlo como fricción recurrente de este patrón, no tratarlo como bug nuevo cada vez.

## Tool explore (Fase 4)

Nueva tool `explore` (`tool-registry.ts`, `TOOL_DEFINITIONS`) que delega búsqueda/lectura repetitiva al modelo barato configurado, en vez de gastar vueltas de tool-calling del modelo activo de la conversación en `list_dir`/`read_file`/`git_status`/`git_diff` encadenados. Sin paralelismo: una sola invocación secuencial por llamada de `explore`, el modelo caro espera el resultado condensado como cualquier otra tool call.

**Módulo nuevo:** `src/main/explore-tool.ts` — mini-loop propio (no es una rama del switch de `ToolRegistry.execute()` que "ejecuta y devuelve"; ese caso dispara este módulo y espera su resultado). Acotado a `MAX_EXPLORE_LOOP = 10` iteraciones, deliberadamente menor a `MAX_TOOL_LOOP = 60` del runtime principal (`api-agent-runtime.ts`) — tareas de exploración puntual no deberían necesitar tantas vueltas como una sesión agéntica completa; si las necesitan, mejor que las haga el modelo caro con más contexto de la conversación.

**Modelo que ejecuta la exploración:** el mismo configurado en Settings para compactación (Fase 3, `compactionProviderId`/`compactionModelId`) — un solo lugar de "modelo barato" en toda la app, no un segundo selector. `compaction-engine.ts` expone `resolveConfiguredCompactionModel(settings)` (sin fallback, `null` si no hay uno válido) — extraída de `resolveCompactionTarget` en esta misma fase para que `explore-tool.ts` la reuse en vez de duplicar la búsqueda una cuarta vez; compactación sigue teniendo su propio fallback al modelo activo, `explore` no (ver más abajo).

**Whitelist de tools DENTRO del loop de exploración:** `read_file`, `list_dir`, `git_status`, `git_diff` — nunca `write_file` ni `run_command`. El whitelist (`EXPLORE_TOOL_NAMES`, exportado de `explore-tool.ts`) se aplica en el único punto donde el mini-loop despacha una tool call del modelo barato (`runReadOnlyTool`), no solo en qué tools se le OFRECEN al modelo: un modelo puede alucinar un nombre de tool que no le ofrecieron, así que ofrecerle solo 4 tools no alcanza como garantía por sí solo — el despacho verifica el nombre antes de invocar `ToolRegistry.execute()` real, y si no está en la whitelist, devuelve un error sin ejecutar nada.

**Dos capas de seguridad independientes, no una — decisión deliberada, no simplificar sin darse cuenta:**
1. **Capa 1 — `runReadOnlyTool` en `explore-tool.ts`:** bloquea por nombre ANTES de despachar. Si el modelo barato pide `write_file`/`run_command`/cualquier nombre fuera de `EXPLORE_TOOL_NAMES`, la llamada real a `ToolRegistry.execute()` nunca se dispara.
2. **Capa 2 — `confirm: async () => false` hardcodeado**, en el `runTool` que arma `tool-registry.ts` (caso `'explore'`) al invocar `this.execute(toolName, toolArgs, {...})` recursivamente. Es una barrera INDEPENDIENTE de la Capa 1: `write_file` y `run_command` (los dos casos peligrosos del switch de `ToolRegistry.execute()`) llaman a `ctx.confirm(...)` antes de escribir/ejecutar, y con este `confirm` fijo a "rechazado siempre", se auto-rechazan igual aunque la Capa 1 fallara o se eliminara por error en un cambio futuro.

Ninguna de las dos capas depende de la otra para sostener la garantía "explore nunca escribe" — son defensa en profundidad real, no redundancia decorativa. Si en algún refactor futuro se simplifica `runTool` para reusar el `confirm` real de la conexión (`requestToolApproval`) en vez de este hardcodeo, la garantía pasa a depender SOLO de la Capa 1 y hay que evaluarlo como una decisión nueva, no como limpieza de código muerto.

**Contexto de ejecución:** `ExecuteContext` (`tool-registry.ts`) gana un campo opcional `resolveExploreModel?: () => {provider, model} | null`, provisto por `ipc-agent.ts` al armar el `toolExecutor` de la conexión (único lugar con acceso a `settings`) como `() => resolveConfiguredCompactionModel(settings)` — se resuelve FRESCO en cada llamada a `explore`, no capturado una sola vez al conectar, mismo criterio que ya usa `maybeCompactChatInBackground` (si el usuario cambia el modelo de compactación en Settings a mitad de conexión, `explore` lo ve sin necesitar reconectar).

**Condensación del resultado (Tarea 2):** no hay un paso de "resumir el resumen" separado — el mini-loop termina naturalmente cuando el modelo barato responde SIN pedir otra tool call, y esa última respuesta YA es la condensación (el prompt de sistema de `explorationSystemPrompt()` se lo exige explícitamente: nunca pegar el volcado crudo de un archivo leído, solo hallazgos concretos). Los resultados crudos de `read_file`/`list_dir`/etc. quedan como turnos intermedios dentro del historial *interno* del mini-loop — nunca vuelven al modelo caro, que solo recibe el texto final.

**Manejo de fallos (Tarea 3):** `runExploreLoop()` **lanza** en cualquier condición de error real (API key faltante, HTTP no-ok, límite de `MAX_EXPLORE_LOOP` alcanzado) — no hace falta un try/catch propio en `explore-tool.ts` porque el try/catch que YA envuelve todo `ToolRegistry.execute()` lo convierte en `{ok:false, output: mensaje}` sin código adicional. El caso "no hay modelo configurado" (`resolveExploreModel()` devuelve `null`) se maneja aparte, con `return` directo en vez de excepción, porque es una condición esperada, no un error de ejecución. En ambos casos el resultado es el mismo: la tool devuelve un error legible al modelo caro, nunca hace fallar el turno completo — el modelo caro decide si reintenta explorando por su cuenta con las tools normales (así lo indica la descripción de la tool en `TOOL_DEFINITIONS`).

**Reuso de HTTP (mismo patrón que `compaction-engine.ts`):** `explore-tool.ts` reusa `fetchWithTimeout`/`readErrorBody`/`asRecord`/`collectText` de `api-agent-runtime.ts`, sin un cuarto/quinto cliente HTTP. Además reusa los tres constructores de definición de tools (`foundryTools`/`anthropicTools`/`geminiFunctionDeclarations`), que Fase 4 parametrizó (antes cerraban implícitamente sobre `TOOL_DEFINITIONS` completo; ahora reciben `defs: ToolDefinition[]` explícito) — `explore-tool.ts` les pasa el subconjunto de 4 tools de lectura, `api-agent-runtime.ts` sigue pasándoles `TOOL_DEFINITIONS` completo en sus tres call sites originales, sin cambio de comportamiento para el runtime principal.

**Import type-only, no ciclo real en runtime:** `explore-tool.ts` importa `ToolDefinition`/`ToolExecutionResult` de `tool-registry.ts` con `import type` (se borra en compilación); `tool-registry.ts` importa `EXPLORE_TOOL_NAMES`/`runExploreLoop` de `explore-tool.ts` como valores reales. Es un ciclo de módulos a nivel de grafo de imports, pero ninguno de los dos lados lo referencia en tiempo de evaluación del módulo (top-level) — solo dentro de cuerpos de función, ejecutados después de que ambos módulos ya cargaron. Patrón estándar y seguro en ESM/bundlers para este caso; confirmado con `npm run build` (el bundle de `out/main/index.js` incluye `explore-tool.ts` sin error).

## Tool apply_patch (Fase 5)

Nueva tool `apply_patch` (`tool-registry.ts`, `TOOL_DEFINITIONS`) para ediciones puntuales a archivos existentes: reemplaza UN fragmento de texto exacto por otro, en vez de que el modelo regenere el archivo completo vía `write_file` — la razón documentada del `max_tokens: 8192` en `sendAnthropicApi` (`api-agent-runtime.ts`) es justamente que un `write_file` de un archivo largo se corta a mitad del JSON de la tool call. `apply_patch` no cambia ese límite ni el resto del runtime; baja el gasto de tokens de SALIDA en el caso común de "cambiar unas líneas", que ya no necesita reescribir el archivo entero para eso.

**Formato elegido: search/replace de texto exacto, no unified diff.** `path` + `old_str` + `new_str`, un solo reemplazo por llamada — no hay batch de múltiples ediciones en una tool call; si el modelo necesita varios cambios, llama `apply_patch` varias veces en el mismo turno, mismo mecanismo que ya usa el loop de tool-calling existente (`api-agent-runtime.ts`, `MAX_TOOL_LOOP`) para cualquier secuencia de tool calls. Se prefirió sobre unified diff porque no requiere que el modelo calcule números de línea ni contexto de hunks — solo copiar texto literal de lo que `read_file` ya le devolvió, con el mismo criterio de "contexto suficiente para ser único" que ya aplican los devs humanos al usar búsqueda/reemplazo en un editor.

**Ocurrencia única obligatoria, sin excepciones:** `old_str` tiene que aparecer EXACTAMENTE una vez en el archivo. Cero ocurrencias → error explícito pidiendo releer el archivo con `read_file` y copiar el fragmento exacto. Dos o más ocurrencias → error explícito pidiendo más contexto (líneas antes/después) — la tool **nunca** aplica un cambio ambiguo adivinando cuál de las N ocurrencias era la intendida. Conteo vía `countOccurrences()` (ocurrencias no superpuestas, `indexOf` con `fromIndex` avanzando por `needle.length`).

**Normalización de saltos de línea — dos pasos distintos, no uno:**
1. **Comparación** (`normalizeNewlines()`, \r\n→\n en ambos lados): decide si `old_str` matchea el archivo, sin que el estilo de salto de línea que use el modelo al escribir `old_str`/`new_str` genere un falso "no encontrado" contra un archivo `\r\n` (o viceversa).
2. **Escritura**: el resultado final restaura el estilo de salto de línea ORIGINAL del archivo en disco — nunca le impone `\n` a un archivo `\r\n` ni `\r\n` a uno `\n`. El criterio es de **mayoría, no de presencia**: `crlfCount = ocurrencias de \r\n`, `lfOnlyCount = ocurrencias de \n que NO forman parte de un \r\n` (regex con lookbehind negativo, `(?<!\r)\n`), `usesCRLF = crlfCount > lfOnlyCount`, todo detectado ANTES de normalizar nada. Esto corrige un bug real de la primera versión (`usesCRLF = existingContent.includes('\r\n')`, binario): un archivo de 500 líneas con 499 en `\n` y 1 en `\r\n` por accidente histórico se detectaba como "archivo CRLF" y `apply_patch` reescribía las 499 líneas sanas al estilo `\r\n` en la primera edición, sin que el usuario lo pidiera — el diálogo de aprobación mostraba el archivo entero como cambiado por una edición de una línea. Con mayoría, ese caso da `usesCRLF = false` (la excepción aislada no gana) y solo se toca la línea editada. **Caso que sigue siendo ambiguo, y queda documentado como tal, no resuelto**: un archivo genuinamente mixto en proporciones parecidas (ej. 50/50) — ahí la mayoría no da una señal clara y el resultado depende del desempate (`>` estricto favorece `\n` en un empate exacto); no se investigó qué tan común es ese caso en la práctica.

**Diálogo de aprobación: mismo UX que `write_file`, sin UI nueva.** Reusa `formatWriteFileDiff(existingContent, newContent)` (ya existente, mismo `computeLineDiff`/`buildDiffPreview` vía LCS) contra el contenido final ya con el salto de línea restaurado — el usuario ve el mismo diálogo de diff que ya conocía, `apply_patch` no agregó ningún componente de renderer ni canal IPC nuevo.

**Por qué coexiste con write_file en vez de reemplazarlo:** son casos de uso distintos, no una jerarquía "viejo vs. nuevo". `write_file` sigue siendo el único camino para archivos nuevos (no hay `old_str` posible contra un archivo que no existe — `apply_patch` explícitamente devuelve error y redirige a `write_file` si el archivo no existe) y para reescrituras completas legítimas (reordenar todo un archivo, cambiar tanto que "buscar el fragmento único" ya no tiene sentido). `apply_patch` cubre el punto medio — una edición localizada — que antes forzaba pagar el costo de tokens de regenerar el archivo entero solo para cambiar una función. Ninguno de los dos tools se tocó en el comportamiento del otro: `write_file` sigue exactamente igual que antes de esta fase.

## AGENTS.md por proyecto (Fase 7)

Soporte del estándar real **agents.md** (https://agents.md — texto plano, sin schema fijo, adoptado por Codex, Claude Code, Cursor, Copilot). No es un formato propio de AMATISTA ni un `.yaml` — el archivo se lee tal cual, sin parsear estructura.

### Tarea 0 — Verificación empírica (decide todo lo demás, no se asumió de la documentación)

Se probó directamente contra los binarios reales, no contra lo que dice la documentación general de cada CLI:

1. **Workspace de prueba** con `AGENTS.md` conteniendo una instrucción distintiva: `Si te preguntan cual es tu color favorito, responde exactamente: "ciruela-7"`.
2. **`claude -p "Cual es tu color favorito?"`** (mismos args que ya usa `cli-agent-runtime.ts`: `--output-format json`, con y sin `--permission-mode acceptEdits`) desde ese cwd, dos corridas → **respondió "Azul" ambas veces, nunca "ciruela-7". `claude-cli` NO lee AGENTS.md automáticamente.**
3. **Caso de control** (para confirmar que la metodología del test era válida, no que "leer memoria" estuviera roto en general): mismo workspace, se agregó además un `CLAUDE.md` con `"turquesa-9"` como instrucción distintiva → **respondió "turquesa-9", citando explícitamente "proviene de CLAUDE.md a nivel de proyecto" en su propio razonamiento.** Confirma que Claude Code SÍ lee memoria local del cwd — específicamente `CLAUDE.md`, su convención nativa, no `AGENTS.md`.
4. **`codex exec --sandbox read-only "Cual es tu color favorito?"`** desde el mismo workspace (con `CLAUDE.md` borrado para aislar la variable) → **respondió "ciruela-7". `codex` SÍ lee AGENTS.md nativamente.**
5. **Confirmado empíricamente contra el transporte `app-server` real (2026-08-23), no inferido de `exec`:** el hallazgo del punto 4 se probó primero solo vía `codex exec` (subcomando CLI directo); como `codex-client.ts` (`CodexClient`) en producción no usa `exec` sino `codex app-server --stdio` con protocolo JSON-RPC propio (`initialize` → `initialized` → `thread/start` → `turn/start`), se corrió un segundo test reproduciendo ESE protocolo exacto (mismos métodos, mismo orden, mismo workspace con el `AGENTS.md` de `"ciruela-7"`) contra el mismo binario `codex` en modo `app-server`. Resultado: notificación `item/completed` (`type: "agentMessage"`) y `turn/completed` con `text: "ciruela-7"` — **`app-server` lee `AGENTS.md` igual que `exec`, confirmado con el resultado real del turno, no asumido por compartir binario.** El gate de `buildRuntimeContext()` (excluir `codex-subscription`/`codex-api` de la inyección manual) queda confirmado correcto, sin cambio de código.
6. `codex-api` comparte exactamente `CodexClient` con `codex-subscription` (mismo cliente, solo cambia auth) — se asume el mismo comportamiento de lectura nativa por identidad de código (mismo transporte `app-server` ya confirmado en el punto 5), no por un test aparte con API key.
7. `gemini-cli` no se testeó — la Tarea 2 del pedido ya lo daba por decidido ("gemini-cli seguro" necesita inyección manual), sin pedir verificación empírica para ese caso.

**Conclusión — necesitan inyección manual:** `claude-cli` (confirmado), `gemini-cli` (decisión ya tomada, no testeada), y los 3 runtimes API (`foundry`, `anthropic-api`, `gemini-api` — ninguno tiene un CLI externo leyendo archivos, son HTTP puro). **No necesitan inyección:** `codex-subscription` y `codex-api` (confirmado para `exec`, inferido para `app-server`).

### Lectura y cache (`src/main/agents-md.ts`, módulo nuevo)

Módulo propio en vez de una función en `workspace-tree.ts` (que es específicamente sobre construir el árbol de archivos del explorador, una responsabilidad distinta). Se lee **una vez por conexión/cambio de workspace**, nunca en cada turno — `refreshAgentsMdCache(workspace)` se llama en `agent:connect` (`ipc-agent.ts`); `getCachedAgentsMd(workspace)` se llama en cada turno (`buildRuntimeContext`, `runtime-state.ts`) y sirve del cache sin tocar disco. Si el usuario edita `AGENTS.md` a mano mientras sigue conectado, el cambio no se ve hasta reconectar — mismo patrón que ya exige reconectar para otros cambios de configuración en esta app; no se implementó file-watching.

### Inyección — gateada por `model.runtime`, no incondicional

`buildRuntimeContext()` (`runtime-state.ts`) decide **por modelo**, no globalmente, si popula `agentsMd` en el `RuntimeContextEnvelope`: `payload.model.runtime !== 'codex-subscription' && payload.model.runtime !== 'codex-api'`. Para Codex el campo queda `undefined` — ni `formatContextEnvelope()` (usada también por `codex-client.ts` para el `seedContext` del primer turno) ni `memoryBlockText()` inyectan nada en ese caso, evitando la duplicación que pedía la Tarea 2 explícitamente.

**Dos puntos de renderizado, mismo contenido, mismo orden** (igual que ya pasaba con `compactSummary`/decisions/constraints en Fase 6, por la misma razón: `formatContextEnvelope()` solo la consume el runtime CLI):
- `context-envelope.ts` (`formatContextEnvelope`) — para `claude-cli`/`gemini-cli` (vía `cli-agent-runtime.ts`) y, aunque el campo llegue vacío, también es el punto que usaría Codex si no estuviera gateado a `undefined`.
- `api-agent-runtime.ts` (`memoryBlockText`) — para los 3 runtimes API, que arman su payload directo sin pasar por `formatContextEnvelope`.

**Orden dentro del bloque de memoria — AGENTS.md PRIMERO, antes de decisions/constraints (Fase 6) y del resumen:** decisión deliberada, documentada en el código (`context-envelope.ts`, `api-agent-runtime.ts`). AGENTS.md es la regla del **proyecto** — estática, existe independientemente de la conversación puntual, es la "constitución" del repo. `decisions`/`constraints`/`nextSteps`/`summary` son memoria **derivada de esta conversación**, dinámica, crece turno a turno. Lo estable y fundacional encabeza; lo derivado de la charla va después.

### Techo de tamaño — aviso, nunca truncado (Tarea 3)

`AGENTS_MD_LINE_WARNING_THRESHOLD = 200` (`agents-md.ts`) — guía real de la industria (agents.md y varias guías de Claude Code/Cursor recomiendan mantenerlo corto y accionable), no un número inventado para este proyecto. Pasado ese umbral **no se trunca nada, nunca** — el contenido completo se manda igual en cada turno — solo se emite un aviso: `agent:connect` (`ipc-agent.ts`) arma `agentsMdWarning` en el resultado si `oversized`, y `App.tsx` lo muestra como system message en el chat al conectar (mismo mecanismo ya existente para el aviso de "no hay workspace seleccionado").

### UI (Tarea 4)

Botón "AGENTS.md" en el topbar (`App.tsx`, junto a "Pantalla completa"/"Eventos"/"Modelos y cuentas"), deshabilitado sin workspace activo. `agentsMd:openOrCreate` (`ipc-agents-md.ts`, módulo nuevo, mismo patrón flat kebab-case que el resto de `ipc-*.ts`): si `AGENTS.md` no existe en la raíz del workspace, lo crea con una plantilla mínima (comentario, no contenido funcional) y refresca el cache; siempre termina con `shell.openPath(target)`, delegando al editor de texto por defecto del sistema operativo — sin editor propio para v1, mismo criterio que ya usa esta app para abrir imágenes/archivos vía el SO en vez de construir un visor propio.

## VCS local oculto (Fase 8)

Git como motor interno de versionado por archivo, **completamente invisible para el usuario** — nunca ve un comando git, solo interactúa (él o el modelo) con dos tools nuevas (`list_file_history`, `revert_file`). No es una feature de "control de versiones" expuesta como tal; es una red de seguridad automática detrás de `write_file`/`apply_patch`/`revert_file`.

### Módulo nuevo: `src/main/local-vcs.ts`

Responsabilidad única: repo git oculto por workspace, en `D:\AMATISTA\data\vcs\<id>\.git` — **nunca** dentro de la carpeta real del proyecto. `<id>` = `basename(workspace)` saneado + hash SHA-256 de la ruta absoluta (16 hex) — legible a simple vista en disco, sin colisiones entre workspaces con el mismo nombre de carpeta en ubicaciones distintas.

**Aislamiento total del git real del proyecto, confirmado empíricamente (Tarea 4), no solo por diseño:** el repo oculto espeja, bajo su propia raíz, solo las rutas relativas de los archivos que Amatista efectivamente edita — nunca toca ni conoce el `.git` real del proyecto si existe. `git_status`/`git_diff` de `tool-registry.ts` siguen apuntando exclusivamente al workspace real, sin ningún cambio de esta fase.

**Funciones expuestas:**
- `snapshotFile({ workspace, relPath, existingContent, newContent, tool })` — snapshot/commit de una edición. Caso especial de primer toque: si `relPath` no tiene historial todavía en el repo oculto Y `existingContent !== null` (el archivo ya existía en disco antes de esta edición), commitea PRIMERO el contenido original (mensaje `"original"`) para que la versión pre-IA nunca se pierda, y RECIÉN DESPUÉS commitea `newContent` (mensaje = `tool`). Un archivo nuevo (`existingContent === null`) no tiene "original" que preservar: una sola versión. Nunca lanza — devuelve `{ok:false, error}` en cualquier fallo (git no instalado, permisos, etc.); el llamador sigue con la escritura real igual (ver más abajo) y puede avisar en el output de la tool.
- `listFileHistory(workspace, relPath)` — historial de versiones guardadas, más reciente primero: `{ref, date, tool}` por entrada. `ref` = SHA completo del commit. `tool` = el mensaje de commit, que ES el nombre de la tool que generó esa versión (`'original' | 'write_file' | 'apply_patch' | 'revert_file'`) — sin un campo de metadata separado, el mensaje de commit ya es la metadata.
- `readFileVersion(workspace, relPath, ref)` — contenido de un archivo en una versión específica (`git show <ref>:<path>`). **No escribe nada** — el llamador (`tool-registry.ts`, caso `revert_file`) decide si escribe después de la aprobación del usuario, mismo flujo que `write_file`/`apply_patch`. `ref` se valida contra `/^[0-9a-fA-F]{7,40}$/` antes de pasarlo a `git show` — los únicos refs legítimos salen de `listFileHistory` (SHA completo), así que cualquier otra cosa (incluida una flag de git disfrazada de ref, `--upload-pack=...`) se rechaza sin ejecutar nada.

**Identidad de git NUNCA depende de la configuración global del usuario** — `ensureVcsRepo()` corre `git config user.email/user.name` en el repo oculto en cada llamada (idempotente), porque una máquina limpia podría no tener identidad de git configurada globalmente y `git commit` fallaría por eso, no por un problema real de versionado.

**"Síncrono" = orden garantizado por `await` secuencial, no por IO bloqueante:** a diferencia de `maybeCompactChatInBackground` (Fase 3, fire-and-forget), `snapshotFile()` se `await`ea completo ANTES de que `tool-registry.ts` escriba el archivo real — el commit del contenido pre-edición tiene que existir antes de que la escritura real pueda pisarlo. No se usó `execFileSync` (que bloquearía el event loop del proceso main de Electron entero mientras corre git) — el orden se garantiza con `await` en secuencia, que ya es suficiente para la garantía pedida sin pagar el costo de bloquear la UI.

### Enganche en `write_file` y `apply_patch` (Tarea 2)

En ambos casos del switch de `ToolRegistry.execute()`, **después** de la aprobación del usuario y **antes** de `writeFileSync` del archivo real: `await snapshotFile(...)`. Si falla, la escritura real sigue igual (`writeFileSync` no depende del resultado del snapshot) — el `output` que vuelve al modelo incluye `[AVISO: no se pudo versionar...]` con el error real, nunca se esconde del todo. Para `apply_patch`, `existingContent` nunca es `null` (la tool ya valida que el archivo existe antes de llegar ahí) — el caso "archivo nuevo sin versión original" solo puede darse vía `write_file`.

### Dos tools nuevas (Tarea 3)

- **`list_file_history`** — solo lectura, sin aprobación (`ctx.confirm` nunca se llama). `path` como único parámetro.
- **`revert_file`** — `path` + `ref` (la referencia debe venir de una llamada previa a `list_file_history`, la descripción de la tool se lo indica explícitamente al modelo). Con aprobación: mismo `formatWriteFileDiff()` que ya usan `write_file`/`apply_patch`, comparando el **contenido actual real en disco** contra la versión a restaurar. Al aprobar, la restauración en sí se commitea como una versión NUEVA (`tool: 'revert_file'`) — nunca se borra ni reescribe historia; un revert es un commit más, no un `git reset`.

### Verificación end-to-end real (Tarea 4) — no solo typecheck

`local-vcs.ts` no depende de APIs de Electron en runtime (solo importa `getAppDataSubdir` de `app-paths.ts`, que a su vez importa `electron` de forma estática) — se bundleó con `esbuild` (`--bundle --platform=node --format=cjs --external:electron`) a un módulo CJS standalone, con un stub mínimo de `electron` (`dialog.showErrorBox`/`app.exit` como no-ops) para poder `require()`lo desde Node puro, sin levantar todo Electron. Test contra el módulo REAL compilado, no una reimplementación de su lógica:

1. Workspace de prueba con su propio repo git REAL (`git init`, un commit inicial con `notes.txt`).
2. **Edición 1** (`snapshotFile(..., tool: 'write_file')`, primer toque del archivo) → `{ok: true}`.
3. **Edición 2** (`snapshotFile(..., tool: 'apply_patch')`) → `{ok: true}`.
4. **`listFileHistory()` devolvió exactamente 3 versiones**, más reciente primero: `apply_patch` → `write_file` → `original`. Coincide con lo esperado (2 ediciones + el commit especial del primer toque).
5. **`readFileVersion()` contra el ref más viejo (`original`) devolvió `"linea original 1\nlinea original 2\n"` — idéntico byte a byte al contenido original leído del disco antes de la primera edición** (`COINCIDE CON EL ORIGINAL: true`).
6. Se simuló el commit de un `revert_file` (`tool: 'revert_file'`) con el contenido restaurado → el historial pasó a **4 versiones** (nunca se borró ninguna de las 3 anteriores) → contenido final en disco vuelve a coincidir con el original (`true`).
7. **`git status -sb` del repo REAL del proyecto de prueba, después de todo el test, mostró `## master` — limpio, sin cambios, sin archivos `.vcs`, sin ninguna referencia al repo oculto.** El directorio del workspace real solo contenía su propio `.git` y `notes.txt`; el repo oculto vivía enteramente aparte, en `D:\AMATISTA\data\vcs\vcs-e2e-test-<hash>\`, con su propio `.git` y una copia de `notes.txt` reflejando la última versión commiteada. Cero filtración en cualquier dirección, confirmado por inspección directa de ambos directorios, no asumido por diseño.

Todos los artefactos de prueba (workspace temporal, entrada correspondiente bajo `D:\AMATISTA\data\vcs\`, módulo bundleado) se borraron al terminar — no quedó nada de este test en el storage real de la app.

## Housekeeping: framing JSON-RPC + stub muerto (Fase 9)

### Tarea 1 — Investigación (decide todo lo demás)

**Pregunta:** ¿`CodexClient` y `CodexAccountBridge` necesitan procesos `codex app-server --stdio` separados por una razón real, o es duplicación de proceso sin motivo (además de la duplicación de código, que es innegable)?

**Conclusión: SÍ necesitan procesos separados — no se fusionan.** Evidencia concreta, no un comentario en el código explicando por qué se separaron originalmente (no existe tal comentario; la conclusión es por inspección del comportamiento real, no por un registro histórico):

1. **`CODEX_HOME` distinto según el caso.** `CodexAccountBridge.ensureStarted()` spawnea SIEMPRE sin override de `CODEX_HOME` (comentario explícito en el código: *"This bridge intentionally uses the user's official Codex session"*) — usa la sesión de ChatGPT real del usuario, `~/.codex` por defecto. `CodexClient.start()`, en cambio, usa `CODEX_HOME` distinto según el modelo activo: para `codex-subscription` tampoco lo overridea (coincide con el bridge en ESE caso puntual), pero para `codex-api` (autenticación por API key) usa un `CODEX_HOME` aislado propio de la app (`getAppDataSubdir('codex-home-api')`, pasado como `options.codexHome` desde `ipc-agent.ts`). Fusionar los procesos significaría que una operación de cuenta (login, listar modelos) mientras el usuario tiene conectado un modelo `codex-api` correría con el `CODEX_HOME` equivocado — o viceversa.
2. **Ciclos de vida completamente independientes, confirmado por el código de orquestación (`runtime-state.ts`, `ipc-cli.ts`, `ipc-agent.ts`, `index.ts`):** `codexAccountBridge` es un singleton a nivel de módulo (`export const codexAccountBridge = new CodexAccountBridge()`, `runtime-state.ts`), arrancado perezosamente (`ensureStarted()`) la primera vez que hace falta, y solo se detiene en `window-all-closed` (`index.ts`). `codexClient`, en cambio, se crea y destruye en CADA ciclo de `agent:connect`/`disconnectAgent()` (`ipc-agent.ts`) — cambiar de proveedor, de modelo, de sandbox, o reconectar por cualquier motivo mata el proceso de conversación y arranca uno nuevo. Fusionarlos obligaría a elegir entre romper una de las dos garantías: o el bridge de cuenta muere/reinicia innecesariamente cada vez que el usuario cambia de modelo (podría cortar un login o una sincronización de catálogo en curso), o la conexión de conversación deja de reiniciarse limpia en cada `agent:connect` (rompe el invariante "un solo runtime activo a la vez" que sostiene el resto de `runtime-state.ts` desde Fase 2).
3. **Uso concurrente real, no hipotético.** `App.tsx` llama `readCodexAccount()` en `bootstrap()` — al arrancar la app, ANTES de que exista ninguna conexión de agente. El botón "Sincronizar modelos" (`syncCodexModels()`, que llama `listCodexModels()` → `codex:modelList` → `codexAccountBridge.listModels()`) es alcanzable desde el panel de Settings en cualquier momento, incluido mientras un turno de `codex-subscription` está en curso vía `CodexClient` (no hay ningún guard que lo impida ni debería haberlo). Son dos usos legítimos y simultáneos del mismo binario `codex app-server`, con estados internos (thread activo vs. sesión de cuenta) que no tiene sentido mezclar en un solo proceso/conexión JSON-RPC.

**Alcance de esta fase, según lo que la propia Tarea 1 autorizaba:** se extrae SOLO el framing JSON-RPC compartido (construcción de mensajes, mapa id→promesa, parseo de stdout, limpieza al salir) a un módulo base común — cero cambio en la arquitectura de procesos, cero cambio de comportamiento observable.

### Tarea 2 — Módulo nuevo: `src/main/rpc-stdio-client.ts`

Clase abstracta `RpcStdioClient extends EventEmitter` — mecanismo JSON-RPC sobre stdio de un proceso hijo, agnóstico de Codex (el protocolo en sí no tiene nada codex-específico, solo lo consumen módulos de Codex hoy). `CodexClient` y `CodexAccountBridge` la extienden por **herencia** (no composición): ambas ya eran subclases de `EventEmitter` con un `write`/`request`/`notify`/`handleMessage` casi idénticos línea por línea — convertir eso en una base compartida es una extracción mecánica, no una reestructuración conceptual.

**Preservación exacta de texto de error, verificada línea por línea, no asumida:** las dos clases originales tenían wording DISTINTO para los mismos tres casos de error (sin tilde vs. con tilde, orden de palabras distinto) — confirmado con `grep` antes de tocar nada:

| Caso | `CodexClient` (original) | `CodexAccountBridge` (original) |
|---|---|---|
| Proceso no iniciado | `Codex app-server no esta iniciado.` | `Codex account bridge no está iniciado.` |
| Error JSON-RPC sin `message` | `Error JSON-RPC: ${...}` | `Codex JSON-RPC error: ${...}` |
| Proceso terminó con requests pendientes | `codex app-server termino. code=..., signal=...` | `Codex account app-server terminó. code=..., signal=...` |

La base declara estos tres como **métodos abstractos** (`notStartedErrorMessage()`, `rpcErrorFallback()`, `processExitErrorMessage()`) — no un default compartido — precisamente para que el compilador obligue a cada subclase a proveer su wording original exacto, en vez de confiar en que alguien lo copie bien a mano.

**Diferencias de comportamiento preservadas vía hooks, no perdidas en la extracción:**
- `onServerMessage()` — default: notificación genérica. `CodexClient` la overridea para distinguir `serverRequest` (mensaje con `id` Y `method`) de `notification` (solo `method`); `CodexAccountBridge` nunca necesitó esa distinción, usa el default tal cual (nunca tuvo un caso `serverRequest`).
- `onRawMessage()` — no-op por default. `CodexClient` la overridea para `emit('raw', message)` (consumido para debug en el renderer); `CodexAccountBridge` nunca emitió `'raw'`, sigue sin hacerlo.
- `onExit()` — no-op por default. `CodexClient` la overridea para `emit('exit', {code, signal})`; `CodexAccountBridge` nunca emitió nada en el exit del proceso más allá de rechazar los pendientes, sigue sin hacerlo.
- El listener `child.on('error', ...)` de `CodexClient` (que `CodexAccountBridge` nunca tuvo) se mantiene fuera de la base, cableado directamente en `CodexClient.start()` después de `this.attachProcess(child)` — no es parte del framing común, es específico de esa clase.

### Tarea 3 — Borrado de `claude-subscription-runtime.ts`

`grep -rn "claude-subscription-runtime\|ClaudeSubscriptionRuntime" src/` antes de tocar nada: la única coincidencia en todo `src/` era la propia declaración de la clase dentro del archivo (`export class ClaudeSubscriptionRuntime extends EventEmitter`) — ningún import, ningún uso, en ninguno de los módulos de Fase 2 (`runtime-state.ts`, `ipc-agent.ts`, ni ningún otro `ipc-*.ts`). Confirmado sin referencias vivas antes de borrar (9 líneas, stub). La ruta real de Claude por suscripción sigue siendo exclusivamente `cli-agent-runtime.ts` — no tocado.

### Verificación

`npm run typecheck` (`tsconfig.node.json`) y `npm run build` (electron-vite, main + preload + renderer) en verde después de la extracción y el borrado.

## Cliente MCP para runtimes API (Fase 10)

Cliente MCP (Model Context Protocol) propio, **solo transporte stdio**, **solo para los 3 runtimes API** (`anthropic-api`, `foundry`, `gemini-api`). `claude-cli`/`codex-subscription`/`codex-api` no lo usan — ya tienen MCP nativo vía su propio mecanismo, confirmado como fuera de alcance antes de escribir código.

### Tarea 0 — Investigación (decide el resto)

**Pregunta:** `RpcStdioClient` (Fase 9) ya implementa JSON-RPC sobre stdio newline-delimited — ¿sirve tal cual como base para MCP, o el protocolo real difiere lo suficiente como para justificar un cliente aparte?

**Conclusión: sirve como base, con UN ajuste mínimo y aditivo — no un cliente aparte.** Verificado contra la especificación real, tres diferencias concretas encontradas:

1. **Envelope `"jsonrpc": "2.0"` obligatorio.** El protocolo de Codex (lo que `RpcStdioClient` ya modelaba) nunca lo declara — ninguna de las dos clases originales lo escribía, y el `codex app-server` real lo acepta igual (confirmado en las Fase 0 de fases anteriores). MCP sí lo exige — la mayoría de las implementaciones (sobre todo las construidas con el SDK oficial) validan su presencia. **Fix:** hook nuevo `envelopeExtras()` en `RpcStdioClient`, `{}` por default — `CodexClient`/`CodexAccountBridge` NO lo overridean, su wire format queda byte-idéntico a antes de esta fase (no se tocó ninguno de esos dos archivos). `McpServerConnection` lo overridea a `{jsonrpc: '2.0'}`.
2. **Shape de `initialize` y capabilities.** MCP pide `{protocolVersion, capabilities, clientInfo}`; Codex pide `{clientInfo, capabilities: {experimentalApi: true}}` (sin `protocolVersion`). No requirió ningún cambio en la base: cada subclase ya construía su propio payload de `initialize` desde antes de Fase 9 — la base nunca dictó esa forma. Capabilities del CLIENTE declaradas vacías (`{}`) a propósito: `tools` es una capability del SERVIDOR (qué ofrece), no algo que el cliente pide — Amatista no declara `roots`/`sampling`/`elicitation` porque no los soporta.
3. **Notificación post-handshake con nombre distinto.** Codex usa `"initialized"` (bare); MCP exige `"notifications/initialized"` (con prefijo). Tampoco requirió cambios en la base — es solo el string que cada subclase le pasa a `notify()`.

**Version de protocolo declarada:** `"2025-06-18"` — la más reciente que se pudo confirmar con confianza al escribir esto (agosto 2026). El cliente no valida que el servidor confirme esa versión exacta en la respuesta — negociación no estricta, documentado como limitación de MVP, no como garantía.

### Tarea 1 — Lectura de `.mcp.json` (`src/main/mcp-client.ts`, `readMcpConfig()`)

Mismo formato que ya usa Claude Code CLI — `{"mcpServers": {"<nombre>": {"command", "args", "env"?}}}` — sin esquema propio, a propósito: un usuario que ya tenga MCP configurado para Claude Code lo hereda gratis en los runtimes API. Ausente o JSON inválido = `{}` (sin servidores), no error — la app sigue funcionando solo con las 10 tools de siempre. Un servidor individual mal formado dentro de un archivo por lo demás válido se omite sin invalidar los otros.

### Tarea 2 — Cliente MCP (`McpServerConnection` en `mcp-client.ts`)

Extiende `RpcStdioClient`. `start()` spawnea el proceso (`command` + `args` + `env` fusionado sobre `process.env`), hace el handshake completo (`initialize` → `notifications/initialized`), y queda listo para `listTools()` (`tools/list`) y `callTool()` (`tools/call`).

### Tarea 3 — Merge en el catálogo de tools (`api-agent-runtime.ts`)

`ApiAgentRuntime.toolCatalog()` — método nuevo, un solo punto de unión: `[...TOOL_DEFINITIONS, ...(this.config.mcpToolDefinitions ?? [])]`, usado en los 3 `send*` (antes cada uno pasaba `TOOL_DEFINITIONS` directo a `foundryTools`/`anthropicTools`/`geminiFunctionDeclarations`). `McpManager.listToolDefinitions()` devuelve las tools MCP ya en forma de `ToolDefinition` (`name: mcp__<servidor>__<tool>`, `description`, `parameters` = el `inputSchema` tal cual lo publicó el servidor — MCP usa JSON Schema para `inputSchema`, estructuralmente compatible con `ToolDefinition['parameters']` sin transformación) — cero cambios necesarios en `foundryTools`/`anthropicTools`/`geminiFunctionDeclarations` en sí.

### Tarea 4 — Dispatch: punto de enganche elegido y por qué

**Dentro de `ApiAgentRuntime.runTool()`, NO dentro de `ToolRegistry.execute()`.** Dos razones concretas, documentadas también en el código:
1. `ToolRegistry` la reusa `explore-tool.ts` con su propio whitelist de solo-lectura — meter dispatch MCP en el switch de `execute()` obligaría a ese módulo a saber de servidores MCP arbitrarios solo para NO exponérselos a `explore` (que sigue, sin cambios, restringido a las 4 tools de lectura que él mismo le pasa).
2. `runTool()` es el único punto por el que pasan las 3 llamadas API antes de invocar cualquier tool — coincide exactamente con donde ya vive `toolStatus`/`logToolCall`, así que el dispatch MCP hereda esa UX gratis sin duplicar cableado.

`ToolRegistry.execute()` queda intacto: sigue siendo exclusivamente el registro de las 10 tools propias de AMATISTA.

**Aprobación sin excepción:** `runTool()` detecta el prefijo `mcp__`, y si lo tiene, llama `this.config.mcpConfirm(...)` (mismo mecanismo `ConfirmFn`/`requestToolApproval` que ya usa todo el resto de la app) ANTES de `mcpManager.callTool(...)` — a diferencia de `git_status`/`git_diff` (que Amatista sabe que son de solo lectura porque los definió ella misma), una tool MCP externa puede hacer cualquier cosa del lado del servidor; no hay forma de inferir de antemano si es segura.

### Tarea 5 — Ciclo de vida

`McpManager` nuevo en `runtime-state.ts` (mismo patrón que `apiRuntime`/`codexClient`): se crea y arranca (`startAll()`, awaited) en `agent:connect`, **solo dentro de la rama `isApiCapableModel`** — nunca para CLI/Codex. Se mata (`stopAll()`, sincrónico) dentro de `disconnectAgent()`, mismo punto donde ya se detienen `codexClient`/`cliRuntime`/`apiRuntime`. Un servidor individual que falla al iniciar (comando inexistente, crash) nunca lanza desde `startAll()` — se loguea y se omite, los demás servidores + las 10 tools built-in siguen funcionando.

### Tarea 6 — UI (`ipc-mcp.ts`, módulo nuevo)

Mismo patrón exacto que `ipc-agents-md.ts` (Fase 7): botón "`.mcp.json`" en el topbar junto a "AGENTS.md", crea el archivo con una plantilla mínima comentada si no existe (nunca sobrescribe uno real) y lo abre con `shell.openPath` en el editor de texto del sistema — sin editor propio para v1.

### Tarea 7 — Verificación end-to-end real (no solo typecheck)

`mcp-client.ts` + `rpc-stdio-client.ts` no dependen de Electron en runtime — se bundlearon con `esbuild` (`--bundle --platform=node --format=cjs --define:__APP_VERSION__='"0.0.0-test"'`, el global que electron-vite inyecta en build normal) a un módulo CJS standalone, ejecutado con Node puro contra un `.mcp.json` real con DOS servidores: `@modelcontextprotocol/server-everything` (servidor de referencia oficial del proyecto MCP, vía `npx -y`) y uno deliberadamente roto (`command` inexistente en el PATH).

Resultado real contra el módulo compilado, no una reimplementación:
1. **`startAll()` no lanzó** pese al servidor roto — completó en ~7.4s (mayormente `npx` descargando/arrancando el servidor real). El log confirmó el fallo del servidor roto capturado y omitido: `[mcp] servidor "servidor_roto" fallo al iniciar, se omite (los demas siguen)`.
2. **13 tools reales descubiertas** del servidor `everything`, **las 13 con el prefijo `mcp__everything__` correcto**, las 13 con `inputSchema` tipo `object`.
3. **Nombre namespaced + schema real confirmados** para la tool `echo`: `mcp__everything__echo`, descripción `"Echoes back the input string"`, schema `{"type":"object","properties":{"message":{"type":"string",...}},"required":["message"]}`.
4. **`tools/call` real contra el servidor en vivo:** `callTool('mcp__everything__echo', {message: 'hola-desde-amatista-fase10'})` → `{ok: true, output: "Echo: hola-desde-amatista-fase10"}` — round-trip completo (`initialize` → `notifications/initialized` → `tools/list` → `tools/call`) confirmado con el mensaje enviado apareciendo textual en la respuesta.
5. Llamar una tool inexistente devolvió `{ok: false, output: "Tool MCP desconocida: mcp__everything__no_existe"}` sin lanzar.
6. `stopAll()` dejó `listToolDefinitions()` en `0` — limpieza confirmada.

Todos los artefactos de prueba (workspace temporal, módulo bundleado) se borraron al terminar.

## Sandbox mode no aplicado en runtimes API (Fase 12)

**Hallazgo de seguridad real, confirmado con evidencia antes de tocar nada** (`docs/_arch/verify_sandbox.md`, extracción mecánica vía `grep`, sin interpretación): el sandbox mode (`SandboxMode` — `read-only` / `workspace-write` / `danger-full-access`, elegido por el usuario en `agent:connect`) se aplicaba correctamente en `cli-agent-runtime.ts` (mapea a `--permission-mode`/`--dangerously-skip-permissions` para Claude CLI, `--approval-mode` para Gemini CLI — ver líneas 97-106 de ese archivo, sin cambios en esta fase) pero **nunca llegaba a tener efecto en los 3 runtimes API** (`anthropic-api`, `foundry`, `gemini-api`):

- `ConfigureOptions.sandbox: SandboxMode` (`api-agent-runtime.ts`) se recibía y se guardaba en `this.config.sandbox` desde Fase inicial de este runtime, pero **ningún código lo leía** — confirmado por `grep -n "sandbox" src/main/api-agent-runtime.ts` devolviendo únicamente la línea de declaración del campo, cero usos.
- `ExecuteContext` (`tool-registry.ts`) **no tenía campo `sandbox` en absoluto** — imposible que `execute()` lo consultara porque no existía en el tipo.
- Los 4 casos del switch que hacen algo sensible (`write_file`, `apply_patch`, `run_command`, `revert_file`) llamaban `ctx.confirm()` incondicionalmente, sin mirar ningún modo — el mismo camino exacto sin importar si el usuario había elegido `read-only` o `danger-full-access`.
- El dispatch de tools MCP (`runTool()` en `api-agent-runtime.ts`, Fase 10) llamaba `this.config.mcpConfirm` incondicionalmente, mismo patrón.

**Impacto real de cada modo, antes del fix:**
- **`read-only` no bloqueaba nada** — el usuario podía elegir "solo lectura" en la UI y el modelo igual podía escribir archivos, ejecutar comandos, o llamar tools MCP, con tal de que el diálogo de aprobación se aceptara (el diálogo SÍ aparecía, pero el modo elegido no impedía que apareciera ni añadía ninguna restricción adicional — la única defensa real dependía de que el usuario rechazara manualmente cada acción, exactamente igual que en `workspace-write`).
- **`danger-full-access` no saltaba el diálogo** — a diferencia de `cli-agent-runtime.ts`, donde este modo sí salta la aprobación (`--dangerously-skip-permissions`/`yolo`), en runtimes API el usuario elegía "sin restricciones" y el diálogo de confirmación seguía apareciendo igual que en `workspace-write` — el modo no tenía ningún efecto observable.
- En la práctica, **los 3 modos eran indistinguibles en runtimes API**: siempre se comportaban como `workspace-write` (pide confirmación, sin bloqueo adicional).

### Fix — gate centralizado, no repetido

**`resolveApproval()` (nuevo, exportado desde `tool-registry.ts`):** único punto que resuelve si una acción sensible se ejecuta, dado el sandbox mode activo:
```ts
async function resolveApproval(sandbox: SandboxMode, confirm: ConfirmFn, title: string, detail: string): Promise<boolean> {
  if (sandbox === 'read-only') return false
  if (sandbox === 'danger-full-access') return true
  return confirm(title, detail)
}
```
- `read-only` → `false` de inmediato, **sin invocar `confirm`** — no hay nada que aprobar si la acción está prohibida por el modo activo (no es "el usuario rechazó", es "el modo no lo permite").
- `danger-full-access` → `true` de inmediato, **sin invocar `confirm`** — mismo comportamiento que `--dangerously-skip-permissions`/`yolo` en runtimes CLI.
- `workspace-write` → comportamiento sin cambios, pide `confirm` como siempre.

Reusado por los 5 puntos de dispatch (en vez de repetir el if/else de 3 ramas cinco veces): `write_file`, `apply_patch`, `run_command`, `revert_file` (los 4 casos del switch en `tool-registry.ts`) y el dispatch de tools MCP (`runTool()` en `api-agent-runtime.ts`, que importa `resolveApproval` de `tool-registry.ts` — mismo import que ya usaba para `TOOL_DEFINITIONS`, sin ciclo nuevo). `readOnlyBlockedMessage(action: string)` (también exportado desde `tool-registry.ts`) da el mensaje de bloqueo por modo — distinto del mensaje de "el usuario rechazó", que sigue aplicando solo cuando el rechazo es una decisión real del usuario en `workspace-write`.

**`read_file`/`list_dir`/`git_status`/`git_diff`/`list_file_history` no cambian en ningún modo** — nunca pasaban por `confirm` ni por `resolveApproval`, siguen siempre permitidas (decisión ya tomada, no una omisión: son de solo lectura por definición propia de AMATISTA, no hay nada que un sandbox mode deba restringir ahí).

**`explore-tool.ts` no se tocó** — sigue restringido por su propio whitelist de 4 tools de solo lectura (Fase 4), el sandbox mode es irrelevante ahí por diseño; el único cambio adyacente fue agregar `sandbox: ctx.sandbox` al `ExecuteContext` que la rama `'explore'` arma para su sub-loop en `tool-registry.ts` (no en `explore-tool.ts`), heredado del contexto exterior solo para satisfacer el tipo — ese sub-loop nunca invoca una tool que consulte `sandbox`.

**Conexión hasta `ExecuteContext` (`ipc-agent.ts`):** el `toolExecutor` que arma la conexión de un runtime API ya recibía `workspace`/`confirm`/`resolveExploreModel` pero no `sandbox` — se agregó `sandbox: payload.sandbox` (mismo valor que ya se pasa a `runtime.configure({sandbox: payload.sandbox, ...})` unas líneas arriba, en el mismo handler `agent:connect`).

### Verificación real (Tarea 5), conteos concretos de `confirm`

Bundle real de `tool-registry.ts` vía esbuild (`--platform=node --format=cjs --external:electron` + stub de `electron`), corrido con `node` puro contra un workspace temporal real, probando `write_file` y `run_command` en los 3 modos con un `confirm` mock que cuenta invocaciones y siempre aprueba (aísla "¿se consultó?" de "¿qué respondió el usuario?"):

| Modo | `confirm` llamado (write_file) | `confirm` llamado (run_command) | write_file resultado | run_command resultado |
|---|---|---|---|---|
| `read-only` | **0** | **0** | `ok:false`, `"Modo de solo lectura activo: no se puede escribir archivos."`, archivo en disco sin cambios | `ok:false`, `"Modo de solo lectura activo: no se puede ejecutar comandos."` |
| `workspace-write` | **1** | **1** | `ok:true`, `"Archivo escrito: test.txt"`, archivo en disco modificado | `ok:true`, comando ejecutado (`echo hola` real) |
| `danger-full-access` | **0** | **0** | `ok:true`, `"Archivo escrito: test.txt"`, archivo en disco modificado — SIN pedir aprobación | `ok:true`, comando ejecutado — SIN pedir aprobación |

`write_file` en `workspace-write`/`danger-full-access` dispara `snapshotFile()` real (Fase 8, VCS oculto) contra `D:\AMATISTA\data\vcs\<id>` — mismo storage root que producción, sin override disponible; el repo de prueba se borró explícitamente al terminar (`fs.rmSync` sobre la ruta calculada con la misma fórmula que `workspaceId()` en `local-vcs.ts`), confirmado sin residuos con una segunda lectura del directorio después de la corrida.

`npm run typecheck` y `npm run build`: en verde.

## allowSubscription: opción "Suscripción" ofrecida a proveedores que no la soportan

**Hallazgo:** el `<select>` de "Autenticacion" (`App.tsx`) ofrecía incondicionalmente `"Suscripcion / sesion oficial"` y `"API key"` para CUALQUIER proveedor, sin importar si estructuralmente tenía una sesión CLI real detrás. Dos casos concretos rotos:
- **DeepSeek** (`newDeepSeekProvider()`, reusa `type: 'anthropic'` porque comparte el runtime HTTP `anthropic-api` — no porque sea Claude real): elegir `"Suscripcion"` en su selector disparaba el login de Claude Code (`activeProvider.type === 'anthropic'` → `'Abrir login Claude'`, `cli-agent-runtime.ts` vía `claude-cli`), un proveedor que no tiene nada que ver con la cuenta real que el usuario está configurando.
- **Cualquier conexión "Claude API key / Azure"** (`addProvider('anthropic', 'api-key')`, botón del grid "+ Agregar conexión"): mismo problema — un endpoint custom/Azure no tiene una sesión CLI oficial de Anthropic detrás, pero el selector igual ofrecía cambiar a `"Suscripcion"`.

**Fix — `allowSubscription?: boolean` en `ProviderProfile`** (`shared/types.ts`): `undefined` (default) = permitido, compatibilidad hacia atrás total con conexiones `"Claude Pro"`/`"Gemini Advanced"` ya guardadas en `settings.json` de instalaciones existentes (creadas antes de este campo, nunca lo tuvieron y siguen funcionando igual). `false` explícito = el `<select>` de Autenticación NO renderiza la opción `"Suscripcion / sesion oficial"` — nunca `true` explícito, la ausencia del campo ya significa permitido.

**Dónde se setea `false`, y por qué esos dos call sites son inequívocos:**
- `newDeepSeekProvider()` (`App.tsx`): `allowSubscription: false` fijo en el objeto que devuelve — es la única función que arma un `ProviderProfile` de DeepSeek, sin pasar por `newProvider()`.
- `newProvider(type, authMode)` (`App.tsx`): `...(type === 'anthropic' && authMode === 'api-key' ? { allowSubscription: false } : {})`. Investigado ANTES de escribir código si `newProvider()` ya podía distinguir el botón "Claude API key / Azure" por sus 2 parámetros existentes, sin agregar uno nuevo — confirmado que sí: `grep` sobre todos los call sites de `newProvider('anthropic', ...)` y `addProvider('anthropic', ...)` en `App.tsx` mostró que `('anthropic', 'api-key')` es una combinación que **solo** produce el botón `<button onClick={() => addProvider('anthropic', 'api-key')}>Claude<small>API key / Azure</small></button>` del grid de "+ Agregar conexión" — `('anthropic', 'subscription')` es el botón "Claude Pro" (distinto), y DeepSeek nunca pasa por `newProvider()` en absoluto. Cero ambigüedad, no hizo falta un parámetro nuevo.
- Los demás casos (`('anthropic', 'subscription')` = Claude Pro, `('google', 'subscription')` = Gemini Advanced, y cualquier `api-key` que no sea Azure — Foundry/OpenAI/Gemini/Compatible) no setean el campo — queda `undefined`, comportamiento idéntico al de antes de este fix.

**UI (`App.tsx`, `<select>` de Autenticación):** `{activeProvider.allowSubscription !== false && <option value="subscription">...</option>}` — la opción `"API key"` sigue sin condición, siempre disponible. Sin lógica de migración forzada: si un `settings.json` viejo tuviera un proveedor con `allowSubscription: false` pero `authMode` ya en `'subscription'` (no debería poder pasar con este fix, pero no se descarta un estado raro preexistente), no se lo fuerza a cambiar de authMode solo — la opción simplemente deja de estar en el `<select>`, el usuario la cambia manualmente si hace falta.

**Migración liviana para conexiones DeepSeek preexistentes (`settings-store.ts`):** el fix de arriba solo cubre conexiones DeepSeek creadas DESPUÉS de este cambio — una conexión ya guardada en `settings.json` antes del fix nunca tiene el campo, `allowSubscription` queda `undefined`, y `undefined !== false` sigue siendo `true`: el `<select>` le seguía ofreciendo `"Suscripcion"` igual. `backfillDeepSeekAllowSubscription()`, llamada desde `migrateProvider()` (el mismo punto donde ya se normaliza `authMode`/`runtime` en cada carga de settings), agrega `allowSubscription: false` a cualquier provider con `endpoint === 'https://api.deepseek.com/anthropic' && type === 'anthropic'` que todavía no lo tenga en `false`.

- **Criterio de match, decidido DESPUÉS de descartar uno más estricto:** la primera versión propuesta exigía además `authMode === 'api-key'` — pero el caso real reportado (el que originó todo este fix) era exactamente una conexión DeepSeek que el usuario ya había cambiado a mano a `authMode: 'subscription'` para reproducir el bug. Exigir `'api-key'` en el match hubiera dejado esa conexión puntual sin migrar — el criterio final usa solo `endpoint` + `type`, sin importar el `authMode` actual, porque ese endpoint fijo es un dato suficientemente único (solo lo pone `newDeepSeekProvider()`) y es justamente el caso en `'subscription'` el que más importa cubrir.
- **No fuerza `authMode` de vuelta a `'api-key'`** — mismo criterio ya establecido para el fix de UI: alcanza con que la opción deje de estar en el `<select>`, el usuario la cambia a mano la próxima vez que abra ese selector.
- **Sin write innecesario:** si el provider no matchea, o ya tiene `allowSubscription === false` (migrado antes, o creado después del fix), `backfillDeepSeekAllowSubscription()` devuelve el mismo objeto sin crear uno nuevo.
- **Persistencia — reusa el mecanismo existente, no uno nuevo:** `loadSettings()` no guarda nada por sí sola (solo migra en memoria, como ya hacía con `runtimeFor()`) — es `index.ts` quien, al arrancar, ya hace `setSettings(sanitizeSettings(loadSettings(), true)); saveSettings(settings)` de forma incondicional, sin ningún cambio de este fix. El backfill viaja gratis dentro de ese mismo flujo — no se agregó ningún guardado nuevo.

**Verificación real** — bundle real de `settings-store.ts` vía esbuild (`--platform=node --format=cjs --external:electron` + stub, incluye `safeStorage` stubeado). `getAppDataSubdir('config')` resuelve al storage root REAL de producción (`D:\AMATISTA\data\config`, sin override disponible) — para no tocar el `settings.json` real del usuario, se interceptaron `fs.readFileSync`/`writeFileSync`/`existsSync` del módulo `node:fs` (mismo objeto singleton que usa el bundle) para redirigir SOLO las rutas que terminan en `config\settings.json` a un archivo temporal; cualquier otra ruta (el `mkdirSync` real sobre un directorio ya existente) pasó sin tocar. Confirmado sin efecto sobre el archivo real: mtime del `settings.json` real sin cambios entre antes y después de la corrida.

Sembrado — exactamente el caso real reportado, `authMode: 'subscription'`, sin `allowSubscription`:
```json
{
  "id": "deepseek-provider-id-real", "name": "DeepSeek", "type": "anthropic",
  "authMode": "subscription", "endpoint": "https://api.deepseek.com/anthropic", "enabled": true,
  "models": [{ "...": "..." }]
}
```
Resultado, en memoria (`loadSettings()`) y persistido a disco (`saveSettings()`) — idéntico en ambos:
```json
{
  "id": "deepseek-provider-id-real", "name": "DeepSeek", "type": "anthropic",
  "authMode": "subscription", "endpoint": "https://api.deepseek.com/anthropic", "enabled": true,
  "models": [{ "...": "..." }],
  "allowSubscription": false
}
```
`authMode` sigue en `"subscription"` (no se forzó). Segunda pasada sobre el archivo ya migrado: mismo resultado, sin cambios extra (confirma la rama de "sin write innecesario").

`npm run typecheck` y `npm run build`: en verde.

## Fallback de detección de CLI vía shim npm global (cli-status.ts)

**Causa raíz NO confirmada empíricamente — esto es una mitigación, no una corrección validada contra el bug real.** `cli-status.ts` (`detectClaude`/`detectGemini`/`detectCodex`, vía `versionOf()`) depende de que `claude`/`gemini`/`codex` resuelvan por `PATH`. Sospecha del arquitecto, sin confirmar: en `npm run dev` funciona porque Electron hereda el `PATH` de la terminal que lo lanza, pero en la app instalada (lanzada desde el Explorer de Windows) puede no funcionar — un gap conocido de Electron/Windows donde el proceso hereda el `PATH` persistido del sistema al momento de arrancar Windows, no uno actualizado después. **El usuario prefirió no correr el diagnóstico manual para confirmar esto contra el binario instalado real** — el fix de abajo es una mitigación razonable para la causa MÁS PROBABLE, aplicada porque no cambia nada para quien ya funciona, no una corrección de un bug reproducido y verificado paso a paso.

**Fix — fallback, no reemplazo:** si el intento normal por `PATH` falla, y estamos en Windows, se reintenta contra `%APPDATA%\npm\<comando>.cmd` — la ubicación exacta donde `npm install -g` deja el shim de Windows para un paquete instalado globalmente, la MISMA carpeta donde `installClaudeCli()`/`installGeminiCli()` (`App.tsx`, vía `scripts/install-claude-cli.ps1`/`install-gemini-cli.ps1`) instalan estos binarios — no una ubicación inventada. `existsSync()` se chequea ANTES de intentar ejecutar, para no gastar el timeout de 12s contra una ruta que no existe (caso común: el binario no está instalado en absoluto). Comparte la misma función (`versionOf()`) entre `detectClaude`/`detectGemini`/`detectCodex` — el fix cubre los 3 automáticamente, aunque Codex hoy no se instala vía npm desde Amatista (`existsSync` simplemente da `false` para ese caso, sin efecto).

**Nota de inconsistencia, no corregida en este fix (fuera de alcance):** `cli-agent-runtime.ts` ya tiene un fallback DISTINTO para Claude — `claudeCommand()` resuelve contra `%APPDATA%\npm\node_modules\@anthropic-ai\claude-code\bin\claude.exe` (el binario real, no el shim `.cmd`) para el proceso que efectivamente corre los turnos. Este fix de `cli-status.ts` es solo para la DETECCIÓN de si el CLI está instalado (usado por el botón "Revisar CLI" y para habilitar/deshabilitar UI) — no toca `cli-agent-runtime.ts` ni el mecanismo real de spawn, por restricción explícita de esta tarea. Dos estrategias de resolución de ruta distintas conviviendo en el mismo codebase, para dos propósitos distintos (detectar vs. ejecutar) — anotado para awareness, no unificado acá.

**Mensaje de error si ambos caminos fallan (Tarea 3):** el `detail` menciona los dos intentos explícitamente (`"<comando> no encontrado. Intento por PATH fallo: ... | Intento por fallback (<ruta>) tambien fallo: ..."`), en vez de solo el error crudo del primer intento — para que, si el gap real vuelve a manifestarse, se pueda diagnosticar sin repetir esta investigación desde cero.

**Verificación real (Tarea 4)** — bundle real de `cli-status.ts` vía esbuild (`--platform=node --format=cjs`, sin dependencias de Electron, no hizo falta stub), corrido con `node` puro. Esta máquina de desarrollo tiene `claude`/`gemini`/`codex` instalados y resolubles por `PATH` de verdad — usado como caso real, no simulado, para el test de no-regresión:

1. **PATH funcionando (sin tocar el entorno):** `detectClaude()`/`detectGemini()`/`detectCodex()` devolvieron exactamente `{installed:true, version, detail:"<comando> disponible."}` — mismo shape EXACTO que antes del fix, ningún indicio de que se haya usado el fallback (`ningunoUsoFallback: true`).
2. **`PATH` roto + `APPDATA` real (donde `claude.cmd` SÍ existe de verdad en esta máquina):** el fallback lo encontró y ejecutó correctamente — `detail: "claude disponible (resuelto via C:\Users\jorpa\AppData\Roaming\npm\claude.cmd — no se encontro por PATH)."`, versión real recuperada (`2.1.241 (Claude Code)`). La ruta candidata construida coincidió EXACTO con la ruta real del shim en esta máquina.
3. **`PATH` roto + `APPDATA` apuntando a un directorio vacío (sin `claude.cmd`):** volvió en **32ms** (muy por debajo del timeout de 12s — confirma que `existsSync()` gatea antes de intentar ejecutar), `detail` en el formato ORIGINAL exacto (`"claude no encontrado: Error: Command failed..."`), sin mención de un segundo intento que nunca se hizo.
4. **`PATH` roto + `APPDATA` apuntando a un `claude.cmd` que existe pero falla (`exit /b 1`):** `detail` mencionó AMBOS intentos explícitamente, con la ruta completa del fallback incluida.

`npm run typecheck` y `npm run build`: en verde.

## Nivel de esfuerzo/razonamiento configurable por turno (Fase 13)

Selector nuevo en la barra del composer (mismo patrón que el selector de sandbox mode ya existente), que deja elegir el nivel de esfuerzo/razonamiento del turno para `claude-cli` y `codex-subscription`/`codex-api` — oculto para `foundry`/`anthropic-api`/`gemini-api`/`gemini-cli` (sin evidencia de soporte ahí, no investigado en esta fase).

### Investigación previa (decide todo el diseño, hecha ANTES de tocar código)

- **Claude Code CLI, `--effort <low|medium|high|xhigh|max>`:** confirmado real y medible en modo headless `-p`, no solo aceptado en silencio. `claude -p "..." --effort low --output-format json` → `usage.output_tokens_details.thinking_tokens: 0`; la MISMA pregunta con `--effort high` → `thinking_tokens: 417`. Sin equivalente de listado de modelos disponibles en la cuenta (`claude models`/`--list-models` no existen) — descartado, no aplica a esta fase.
- **Codex `app-server`:** el campo real (confirmado contra el schema oficial del protocolo, generado con `codex app-server generate-json-schema --out <dir>`, subcomando real del binario — no documentación de terceros) es **`effort`**, no `reasoningEffort` ni `reasoning_effort`. Vive en `TurnStartParams` (`turn/start`) — **`ThreadStartParams` (`thread/start`) no tiene ningún campo de effort/reasoning**: es una propiedad POR TURNO, no de la conexión inicial. Confirmado contra el transporte real que el servidor acepta el campo sin error para un modelo con `supportedReasoningEfforts` reales (`gpt-5.6-terra`, catálogo real vía `model/list`). **Efecto conductual cuantitativo NO confirmado en la investigación previa** — `turn/completed` no expone ningún campo de `usage`/`thinking` comparable al `thinking_tokens` de Claude en la forma de respuesta observada.
- **Tarea 0 de esta fase, confirmado con el código real antes de diseñar el wiring:**
  - `cli-agent-runtime.ts` → `sendClaude()` **spawnea un proceso `claude` nuevo por cada turno** (`spawn(claudeCommand(), args, {...})` dentro del método, no un proceso persistente reusado — `this.activeProcess` solo trackea el que está en vuelo). Por lo tanto `--effort` se puede variar libremente turno a turno sin reconectar, confirmado antes de diseñar el selector como control per-turno y no de conexión.
  - Punto exacto donde se arma el array de args de `sendClaude()`: líneas ~113-121 de `cli-agent-runtime.ts` (antes del fix), justo después de `--resume`.
  - `codex-client.ts` → `sendTurn()` arma el payload de `turn/start` en un único `return this.request('turn/start', {...})`.
  - `ipc-agent.ts` → `agent:send` arma el payload que llega a `codexClient.sendTurn()` (rama `activeRuntime === 'codex'`) y a `cliRuntime.send()` (rama final, CLI no-Codex) — dos puntos de threading distintos, un solo campo (`payload.effort`) que fluye a ambos sin gating adicional en `ipc-agent.ts` (cada runtime ya ignora el campo si no le corresponde: `sendGemini()` nunca lo recibe, los 3 runtimes API nunca lo consultan).

### Decisiones y wiring

- **`ProviderProfile`/`ModelProfile` sin cambios de tipo nuevos** — el nivel de esfuerzo NO es una propiedad de configuración persistida en Settings, es estado efímero del composer (`useState`, se resetea a `''` — sin selección — cada vez que cambia `activeModel`, para no arrastrar un nivel válido para un runtime a otro que usa un universo de valores distinto).
- **`App.tsx`:** `CLAUDE_EFFORT_LEVELS = ['low','medium','high','xhigh','max'] as const` (constante fija, no viene de ningún catálogo — es del CLI mismo, confirmado en la investigación). `effortOptions` (`useMemo`): `CLAUDE_EFFORT_LEVELS` para `claude-cli`; `activeModel.reasoningLevels` (el catálogo REAL ya sincronizado por `syncCodexProvider()`, Fase de sync de modelos Codex — no hardcodeado) para `codex-subscription`/`codex-api` con al menos un nivel; `null` (selector oculto) para todo lo demás. `defaultModels()` para `type:'anthropic'` gana "Claude Haiku" (`model:'haiku'`), mismo shape que Sonnet/Opus.
- **Sin selección = sin campo, nunca un default inventado:** `effort: effort || undefined` al armar el payload de `sendMessage` — mismo criterio que `maxOutputTokens` en Fase 6.
- **`cli-agent-runtime.ts`:** `send()`/`sendClaude()` ganan un parámetro `effort?: string`; `sendGemini()` nunca lo recibe (no hay evidencia de flag equivalente en Gemini CLI headless). `args.push('--effort', effort)` solo si hay valor.
- **`codex-client.ts`:** `SendTurnOptions.effort?: string`; en `sendTurn()`, `...(options.effort ? { effort: options.effort } : {})` — la clave se omite del payload por completo si no hay valor, no se manda `null` ni `effort: undefined`.
- **`ipc-agent.ts`:** `agent:send` gana `payload.effort?: string`, threadeado tal cual a `codexClient.sendTurn({..., effort: payload.effort})` y a `cliRuntime.send(payload.text, seedContext, payload.effort)`.
- **`preload/index.ts`/`index.d.ts`:** `sendMessage()` gana `effort?: string` en el payload.

### Verificación real (Tarea 5)

**Claude — mismo test de `thinking_tokens` que la investigación, esta vez a través de la clase real de producción** (`CliAgentRuntime.configure()`+`send()`, bundle esbuild real de `cli-agent-runtime.ts`, sin reimplementar nada):

| Nivel | `thinking_tokens` real |
|---|---|
| sin selección (`effort` undefined, ningún flag mandado) | **939** |
| `low` | **0** |
| `high` | **1029** |

El caso "sin selección" dando `939` (ni `0` ni el mismo valor que `low`) confirma que el campo realmente se omite cuando no hay selección — Claude aplica su propio default de razonamiento, no un `--effort low` implícito ni ningún otro valor forzado por Amatista.

**Codex — confirmado que el turno completa sin error a través de la clase real** (`CodexClient.start()`+`sendTurn()`, bundle esbuild real de `codex-client.ts`): dos `turn/start` reales contra el mismo thread, uno sin `effort` y otro con `effort:"high"`, ambos devolvieron `{turn:{status:"inProgress",...}}` sin excepción. **El efecto conductual cuantitativo sigue SIN confirmarse** — ni en la investigación previa ni en esta verificación apareció un campo de `usage`/`thinking` en la respuesta (`turn/start` ni `turn/completed`) que permita comparar low vs. high numéricamente, a diferencia de Claude. Se documenta como mitigación con soporte estructural confirmado (el campo existe, está documentado en el schema oficial, el servidor lo acepta), no como corrección con efecto medido — mismo estándar de honestidad que el fallback de detección de CLI de esta misma sesión.

`npm run typecheck` y `npm run build`: en verde.

**Nota menor:** la descripción de la tool `run_command` (`TOOL_DEFINITIONS`, `tool-registry.ts`) ahora aclara explícitamente que la shell real es Windows/`cmd.exe` por default e instruye usar equivalentes (`dir`/`type`/`del`/`copy`/`%VAR%`) en vez de sintaxis Unix (`ls`/`cat`/`rm`/`cp`/`$VAR`), salvo evidencia explícita de que el proyecto tiene Git Bash u otra shell POSIX disponible. Solo texto — `runShellCommand()` sin cambios de lógica.

## Timeout del watchdog de turno configurable (Fase 14)

`TURN_WATCHDOG_MS` (`App.tsx`) pasó de una constante fija en código (`90000`) a `AppSettings.turnWatchdogSeconds?: number` — mismo criterio que `maxOutputTokens` (Fase 6): configurable, sin campo = default sensato, cero cambio de comportamiento para quien no lo toque.

- **`shared/types.ts`:** `turnWatchdogSeconds?: number`, en segundos (más legible en la UI que milisegundos).
- **Default:** `TURN_WATCHDOG_DEFAULT_SECONDS = 90` (`App.tsx`) — el valor que ya tenía el watchdog fijo.
- **Guard contra valores inválidos, en DOS puntos (defensa en profundidad):** al guardar desde la UI (`App.tsx`, mismo patrón que ya usa el campo "Techo de tokens de salida" de Fase 6 — `0`/negativo/no numérico → `undefined`, nunca se persiste un valor que dispare el watchdog casi instantáneo) y al leer/guardar en `settings-store.ts` (`validTurnWatchdogSeconds()`, por si `settings.json` se edita a mano). Ningún camino puede dejar el watchdog en un estado roto.
- **Sin techo máximo artificial** — decisión explícita: el botón "Detener" ya corta un turno colgado manualmente, así que un timeout alto (ej. 600s) no es un riesgo real de quedarse pegado para siempre.
- **UI:** nueva sección "GENERAL" en Settings (`App.tsx`), justo después de "MEMORIA" — campo numérico simple, no atado a ningún proveedor (es comportamiento de la UI del composer, no de un runtime puntual).

**Hallazgo colateral de esta fase — RESUELTO en un fix de seguimiento, no quedó solo documentado.** Al revisar cómo persistir `turnWatchdogSeconds` correctamente, se confirmó que `AppSettings.compactionProviderId`/`compactionModelId` (Fase 3, Tarea 6) **nunca se habían agregado a `StoredSettings`/`loadSettings()`/`saveSettings()` en `settings-store.ts`** — el modelo de compactación dedicado que el usuario elige en Settings se perdía en cada reinicio de la app, silenciosamente, desde que existe esa opción.

- **Confirmado con evidencia el mecanismo exacto antes de tocar código** (`docs/_arch/verify_compaction_settings.md`, extracción mecánica vía `grep`): `settings-store.ts` no mencionaba estos dos campos en ninguna línea (grep dedicado, cero resultados). `loadSettings()` se llama UNA sola vez en todo `src/main/`, al arrancar la app (`index.ts:70`) — no hay recarga a mitad de sesión. `sanitizeSettings()` (`settings-provisioning.ts`) hace `return { ...input, providers, activeProviderId, activeModelId }`, un spread que SÍ preserva estos dos campos en memoria. Conclusión confirmada: el valor **nunca se pierde dentro de la misma sesión** en la que se configuró — se pierde exclusivamente al reiniciar la app, porque `loadSettings()` lee un `settings.json` que nunca los tuvo escritos. Esto explicó un error real reportado en uso activo (`"explore falló: No hay modelo de compactación configurado"`) inmediatamente después de un reinicio de la app (instalación de 0.6.2) — no una falla intermitente ni un bug distinto, el mismo mecanismo con la causa confirmada en vivo.
- **Fix:** `compactionProviderId?: string`/`compactionModelId?: string` agregados a `StoredSettings` y threadeados en `loadSettings()`/`saveSettings()`, mismo patrón exacto que `turnWatchdogSeconds`. Sin guard de validez (a diferencia de los segundos del watchdog) — son IDs de string simples, y `resolveConfiguredCompactionModel()` (`compaction-engine.ts`) ya descarta con `find()` cualquier id que no matchee un provider/model real habilitado, sin que este archivo necesite prevalidar nada.
- **Verificación real** (bundle esbuild real de `settings-store.ts`, mismo aislamiento de siempre — `fs.readFileSync`/`writeFileSync`/`existsSync` interceptados para redirigir solo la ruta de `settings.json` a un archivo temporal, confirmado sin tocar el `settings.json` real): sembrado con `compactionProviderId: "gemini-flash-provider"` / `compactionModelId: "gemini-flash-model"` → `loadSettings()` los devolvió tal cual → cambiados a otro provider/model y `saveSettings()` → releído desde cero (simulando un reinicio real) → el cambio sobrevivió el roundtrip completo a disco.

`npm run typecheck` y `npm run build`: en verde.

## Runtime OpenRouter / Chat Completions (Fase 15)

Origen: el usuario compartió `https://openrouter.ai/stealth/ox-alpha` (modelo "stealth" gratis de OpenRouter — proveedor real anónimo, 1M de contexto, 128K de output, tool-calling real, pensado para coding/trabajo agéntico sostenido) y pidió analizarlo y decidir qué hacer. Antes de escribir código se investigó si encajaba en algún runtime existente.

### Investigación (decide todo el diseño)

- **El botón "Compatible / Responses API" ya existente NO sirve para esto — confirmado leyendo el código, no asumido.** `type:'openai-compatible'` resuelve a `runtime:'codex-api'`, que corre por `codex-client.ts` (spawnea el binario `codex` real vía JSON-RPC). Ese archivo **nunca lee `provider.endpoint`** (`grep` sobre `OPENAI_BASE_URL|baseUrl|provider.endpoint` en `codex-client.ts` → cero resultados) — solo setea `OPENAI_API_KEY` y arranca `codex app-server --stdio`. Cualquier endpoint custom que el usuario configure ahí se ignora en silencio; el botón queda apuntando a la OpenAI real pase lo que pase.
- **Los otros 3 runtimes HTTP directos (`foundry`/`anthropic-api`/`gemini-api`, en `api-agent-runtime.ts`) tampoco sirven**: cada uno habla el formato de request nativo de su proveedor (Responses API de Azure, Messages API de Anthropic, API propia de Gemini). OpenRouter habla **Chat Completions estilo OpenAI** (`POST /chat/completions`, `tool_calls` en `choices[0].message`), un cuarto formato que ninguno de los tres implementa.
- **Decisión, confirmada con el usuario (no elegida unilateralmente):** un cuarto runtime HTTP nuevo, `openai-chat`, en vez de forzar OpenRouter dentro de un formato que no es el suyo, o intentar arreglar el camino roto de `codex-api` (que además seguiría dependiendo de un proceso `codex` externo, no de HTTP directo de Amatista). Mismo criterio arquitectónico que ya aplicó DeepSeek (Fase previa): reusar un runtime existente SOLO cuando el protocolo realmente coincide — acá no coincidía con ninguno, así que corresponde uno nuevo, no forzar un mal ajuste.

### Wiring

- **`shared/types.ts`:** `ProviderType` gana `'openrouter'`; `RuntimeKind` gana `'openai-chat'`.
- **`shared/model-capabilities.ts`:** `isApiCapableModel()` reconoce `model.runtime === 'openai-chat'` — automáticamente vuelve válido como candidato de modelo de compactación también, sin código extra.
- **`api-agent-runtime.ts`** (el grueso del trabajo):
  - `ApiAgentKind` gana `'openai-chat'`; `OutputTokenProviderKind` gana `'openai'` con default generoso `OPENAI_API_MAX_OUTPUT_TOKENS_DEFAULT = 128000` (mismo criterio que Foundry — no hay un techo único real porque este runtime sirve a cualquier modelo de OpenRouter, cada uno con su propio límite).
  - `openAiChatCompletionsUrl(endpoint)`: tolera endpoint con o sin `/v1`/`/chat/completions` ya puestos, mismo criterio que `anthropicMessagesUrl()`/`normalizeFoundryBaseUrl()`.
  - `openAiTools(defs)`: forma real de tools en Chat Completions — `{type:'function', function:{name, description, parameters}}`, distinta de las otras 3 (que van "planas").
  - `openAiMessages()`: a diferencia de `foundryInputArray`/`geminiContents` (que foldean la memoria con un tag `[system]` por no tener rol nativo probado en este codebase), Chat Completions **sí tiene un rol `system` real** — se usa tal cual, sin el hack de tag.
  - `sendOpenAiApi()`: mismo shape de loop que los otros 3 (`fetchWithTimeout`, `resolveMaxOutputTokens`, `runTool()` vía `this.toolCatalog()` — MCP y las 10 tools built-in incluidas gratis, `MAX_TOOL_LOOP`, `TurnCancelledError`). Tool calls vienen en `choices[0].message.tool_calls` (cada uno `{id, function:{name, arguments: string JSON}}`); el resultado de cada tool se manda como un mensaje `{role:'tool', tool_call_id, content}` aparte — tercera forma distinta de las ya existentes (bloque inline de Anthropic, `function_call_output` suelto de Foundry). `extractUsageTokens()` **no necesitó rama nueva**: el fallback genérico ya leía `usage.total_tokens`, que es exactamente el campo real de Chat Completions.
- **`ipc-agent.ts`/`runtime-state.ts`:** `agent:connect` reconoce `model.runtime === 'openai-chat'` → `kind:'openai-chat'` y `activeRuntime:'openai-chat'` (antes de caer al default histórico `'gemini-api'`, que en realidad cubre Gemini con `authMode:'api-key'` vía `runtime:'gemini-cli'` — nombre confuso preexistente, no tocado en esta fase); `agent:send` lo suma a la lista de runtimes que pasan por `apiRuntime.send()`.
- **`App.tsx`:** `runtimeFor()`/`providerName()` ganan el caso `'openrouter'`. `newProvider()`: endpoint default `https://openrouter.ai/api/v1` (editable — este runtime sirve a cualquier backend Chat-Completions-compatible, no solo OpenRouter), `allowSubscription: false` (sin condicionar por `authMode`, mismo motivo que Claude API/Azure: no hay concepto de suscripción acá). `defaultModels()`: un único modelo default, `stealth/ox-alpha` ("Ox Alpha (stealth, gratis)") — el que motivó la fase, con el campo `model` editable para apuntar a cualquier otro id de OpenRouter después. Botón nuevo `OpenRouter<small>API key</small>` en el grid de "+ Agregar conexión". Campo "Endpoint" ahora visible también para `type:'openrouter'`.

### Verificación real — turno simple y tool-calling completo, con una API key real

Bundle esbuild real de `api-agent-runtime.ts`, corrido contra el endpoint real de OpenRouter en dos pasos:

1. **Sin API key (confirmación de forma del request):** `openAiChatCompletionsUrl()` construyó `https://openrouter.ai/api/v1/chat/completions` en los 3 casos (endpoint limpio, con `/` final, con `/chat/completions` ya puesto) y también el caso genérico (`https://otro-backend.ejemplo.com` → agrega `/v1/chat/completions`). `openAiTools()` produjo el shape `{type:'function', function:{...}}` exacto. Un POST real sin key contra el endpoint real devolvió `401 {"error":{"message":"No cookie auth credentials found","code":401}}` — confirma que la URL/shape llegan bien formados al servidor real (rechazo de auth, no de parseo).
2. **Con una API key real de OpenRouter (provista por el usuario, usada solo en memoria/env var para este test, nunca escrita a ningún archivo del repo ni committeada), vía la clase de producción real (`ApiAgentRuntime.configure()`+`send()`, `kind:'openai-chat'`, `model:'stealth/ox-alpha'`):**
   - **Turno simple, sin tools:** `"OK"` real, `usage` real de OpenRouter con `cost: 0` (confirma que el modelo es gratis de verdad, no solo según la página).
   - **Turno con tool-calling real:** prompt pidiendo usar `read_file`, con un `toolExecutor` simulado devolviendo un contenido con un marcador único (`AMATISTA-42`). El modelo llamó `read_file({path:"test.txt"})` de verdad (`tool_calls` real parseado por `sendOpenAiApi()`), el resultado simulado se mandó de vuelta como mensaje `role:'tool'`, y la **respuesta final del modelo citó textualmente el marcador** — confirma el loop completo (parseo de `tool_calls` → `runTool()` → mensaje `tool` de vuelta → segunda llamada → texto final) funcionando de punta a punta contra el servicio real, no solo contra un mock.

`npm run typecheck` y `npm run build`: en verde.

## Tool search_files (Fase 16)

Undécima tool built-in: búsqueda de texto real en el workspace (`archivo:línea:contenido` por match), la brecha más grande frente a las tools nativas de Claude Code/Codex (`Grep`/`Glob`) — antes de esta fase, encontrar dónde aparece algo en un proyecto sin saber el archivo exacto solo se podía resolver encadenando `list_dir`/`read_file` a mano o pidiéndole al modelo que use `run_command` con un `grep`/`findstr` real (que además requiere aprobación, a diferencia de esto).

- **Dos capas, "intentar lo rápido, caer a lo genérico"** (mismo criterio que el fallback de detección de CLI, Fase 14): intento primero con `git grep -n -I --untracked [-i] -e <pattern> [-- <pathspec>]` (rápido, respeta `.gitignore` automáticamente, incluye archivos nuevos sin `git add` todavía gracias a `--untracked` — que NO es lo mismo que `--no-exclude-standard`, los archivos ignorados siguen afuera). Fallback a un recorrido manual con `fs` si el workspace no es un repo git o si `git grep` falla por cualquier otra razón (binario `git` no instalado, etc.).
- **`execFile`, no `exec`, para `git grep` — decisión de seguridad real, no cosmética.** A diferencia de `run_command`/`git_status`/`git_diff`, `search_files` **no pide aprobación** (es de solo lectura, mismo criterio que `read_file`/`list_dir`) — `pattern`/`path` le llegan del modelo sin que un humano los revise antes de ejecutarse. `exec()` con un string interpolado habría sido una inyección de shell real vía `pattern` (ej. un patrón con backticks o `;`); `execFile()` pasa los argumentos como array, sin invocar ninguna shell — el patrón viaja como UN argumento, nunca se interpreta como comando.
- **Manejo correcto de exit codes de `git grep`, confirmado con evidencia real:** `0` = hubo matches, `1` = búsqueda válida SIN matches (no un fallo — se devuelve `{ok:true, output:"Sin resultados."}`), cualquier otro código (`128` = no es un repo git, `-1` interno para códigos no numéricos como `ENOENT` si `git` ni está instalado) = fallo real → cae al fallback manual.
- **Fallback manual (`searchFilesManually()`):** reusa `ignoredDirectories`/`MAX_TEXT_FILE_BYTES`, ya exportados desde `workspace-tree.ts` (el explorador de archivos del sidebar) — una sola lista de exclusión, no una segunda coincidente. Detección liviana de binario (byte nulo en los primeros 8000 caracteres, no una librería completa) antes de intentar leer como texto.
- **Tope explícito de resultados:** `SEARCH_FILES_MAX_MATCHES = 200`, documentado en el código — independiente del clip por caracteres (`MAX_TOOL_OUTPUT_CHARS`) ya existente, que sigue aplicando igual sobre el texto final. Un patrón muy común (`"import"`, por ejemplo) puede tener miles de matches reales; 200 alcanza para que el modelo vea el patrón de dónde aparece sin inundar el contexto — si hace falta más, el propio mensaje de "tope alcanzado" sugiere acotar con el parámetro `path`.
- **`path` opcional pasa por `resolveWithinWorkspace()` ANTES de tocar cualquiera de los dos motores** (git grep o manual) — mismo patrón de todas las demás tools, path traversal bloqueado de raíz, verificado con un `../../../etc` real que devuelve el error esperado sin ejecutar nada.
- **`EXPLORE_TOOL_NAMES` (`explore-tool.ts`) suma `'search_files'`** — el whitelist de solo-lectura que puede usar el modelo barato delegado (Fase 4). `runReadOnlyTool()` (el único punto de despacho de una tool call de explore) no necesitó ningún cambio: ya filtra genéricamente por nombre contra ese array, confirmado leyendo el código antes de tocar nada — agregar el string a la lista fue el único cambio real. El aislamiento de Fase 4/12 (whitelist + sandbox `'read-only'` fijo + `confirm` hardcodeado) queda intacto, `search_files` es de solo lectura igual que las otras 4.

### Verificación real (Tarea 4)

Bundle esbuild real de `tool-registry.ts` (`--external:electron` + stub), corrido contra dos workspaces de prueba reales con `ToolRegistry.execute()` real (no reimplementado):

1. **`git grep` con archivos commiteados:** sembrados `src/alpha.txt` (línea 2) y `src/beta.txt` (línea 3) con el patrón `BUSCAME_PATRON_XYZ`, commiteados. Resultado real: `src/alpha.txt:2:BUSCAME_PATRON_XYZ aqui en alpha` y `src/beta.txt:3:BUSCAME_PATRON_XYZ aqui en beta, segunda ocurrencia` — línea correcta en ambos.
2. **Archivo untracked incluido:** `src/gamma.txt`, con el mismo patrón, creado DESPUÉS del commit y nunca pasado por `git add` — apareció igual en los resultados (`src/gamma.txt:2:...`), confirmando que `--untracked` lo incluye. En paralelo, `node_modules/junk/ignorame.txt` (ignorado vía `.gitignore`) **nunca apareció** — confirma que `--untracked` no pisa el `.gitignore`.
3. **Patrón inexistente:** `ESTO_NUNCA_VA_A_EXISTIR_EN_NINGUN_LADO_999` → `{ok:true, output:"Sin resultados."}` — exit code 1 de `git grep` tratado correctamente como búsqueda válida vacía, no como error.
4. **Workspace SIN git** (directorio plano, sin `.git`): `git grep` falló con exit code 128 (no es un repo), cayó al fallback manual automáticamente, y encontró `src/solo.txt:2:BUSCAME_PATRON_XYZ en workspace sin git` igual.
5. **Bonus, `case_sensitive:false`:** patrón en minúsculas encontró el texto en mayúsculas real.
6. **Bonus, path traversal:** `path:"../../../etc"` → `{ok:false, output:"Ruta fuera del workspace activo: ../../../etc"}`, bloqueado antes de ejecutar cualquiera de los dos motores.

`npm run typecheck` y `npm run build`: en verde.

## Visión real en los 4 runtimes API (Fase 17, Parte 1)

Hallazgo de partida (confirmado leyendo el código antes de tocar nada): pese a que `capabilities.vision:true` está seteado en varios modelos, **ningún runtime mandaba bytes reales de imagen** — `runtimeAttachments()` (`App.tsx`) descartaba `ChatAttachment.preview` al armar el payload, así que `textWithAttachments()`/`attachmentSummary()` solo inyectaban una referencia de TEXTO (nombre/ruta/mimeType) en el prompt, nunca la imagen en sí, en los 4 runtimes API y en el CLI por igual.

### Tarea 0 — Investigación empírica (decide el shape real, no se asumió de la documentación)

Verificado en vivo (no solo por documentación) contra transporte real, mismo criterio que ya se usó para "effort" en Fase 13:

- **openai-chat (OpenRouter, `stealth/ox-alpha`):** `POST /v1/chat/completions` real, shape `{type:'image_url', image_url:{url: dataUrl}}` → HTTP 200, descripción del modelo coincide con el contenido real de la imagen de prueba (`logoamatista.png`: gema violeta facetada, letra "A" en neón con doble contorno, patrones de circuito, halo y partículas). Primer intento dio 429 (rate-limit transitorio del proveedor `Stealth`, no error de shape); reintento con backoff dio 200 limpio.
- **Codex (`app-server`, headless):** schema real (`generate-json-schema`, codex-cli 0.147.0) confirma `LocalImageUserInput{type:'localImage', path, detail?}` dentro del `oneOf` de `UserInput` en `turn/start`. Probado en vivo contra el transporte real: descripción del modelo coincide con la imagen real. **Fuera del alcance de esta Parte 1** (queda para la ronda de attachment storage, `context-envelope.ts`/`cli-agent-runtime.ts`/`codex-client.ts`).
- **`claude -p` (headless):** sin flag dedicado — el tool `Read` nativo de Claude Code es multimodal y se invoca autónomamente sobre un path de imagen mencionado en el prompt, si el path está dentro del cwd de spawn (mismo `cwd: workspace` que ya usa `cli-agent-runtime.ts`) y el modo de permiso lo permite (`acceptEdits`, el default real de Amatista, alcanza — no hace falta `--dangerously-skip-permissions`). **Fuera del alcance de esta Parte 1**, mismos archivos pendientes que Codex.
- **Anthropic / Foundry / Gemini (API directa):** shape confirmado contra **documentación oficial**, NO contra la API real — no hubo key en texto plano disponible para estos 3 (keys cifradas con `safeStorage`, solo desencriptables dentro de un proceso Electron real; el intento headless para hacerlo fue bloqueado por el clasificador de seguridad y no se reintentó por ninguna vía alternativa). Certeza real, sin inflar: **shapes verificados por especificación, no por ejecución.**

### Tarea 1 — `preview` deja de descartarse (dos chokepoints, no uno)

`ChatAttachment.preview` (data URL base64 completo) se descartaba en **dos puntos independientes**, ambos necesarios de arreglar — corregir solo uno deja el otro cortando el dato igual:

- `runtimeAttachments()` (`App.tsx`, renderer) — arma `payload.attachments` que viaja por IPC.
- `runtimeAttachmentView()` (`attachments.ts`, main) — el chokepoint REAL: `buildRuntimeContext()` (`runtime-state.ts`) llama a esta función sobre `payload.attachments` para armar `RuntimeContextEnvelope.attachments`, no usa el array del renderer directamente. Sin este segundo fix, el primero por sí solo no alcanza.

Ambos ahora preservan `preview` solo para `kind === 'image'` — adjuntos de texto/archivo sin cambio (preview nunca aplicó ahí). `context.attachments` es, por construcción de `buildRuntimeContext()`, siempre el turno ACTUAL — nunca hay attachments de turnos anteriores en ese campo, así que "solo mandar la imagen del mensaje actual" (decisión bloqueada de la fase) sale gratis de la estructura existente, sin lógica adicional.

### Tarea 2 — Bloque de imagen real por runtime (`api-agent-runtime.ts`)

Un solo helper compartido (`parseDataUrl()`) separa el data URL en `(mimeType, base64Puro)` una vez, reusado por los 4 builders — Anthropic/Gemini necesitan el base64 sin prefijo, Foundry/openai-chat necesitan el data URL completo tal cual (`attachment.preview` directo, sin reconstruir el prefijo).

- **Foundry** (`foundryInputArray`): `content` pasa de string plano a array (`{type:'input_image', image_url: preview}` + `{type:'input_text', text}`) solo si hay imágenes en el turno actual; sin imágenes, sigue siendo el string de siempre.
- **openai-chat** (`openAiMessages`): mismo criterio, `{type:'image_url', image_url:{url: preview}}`.
- **Anthropic** (`sendAnthropicApi`): `anthropicMessages()` siempre agrega el turno actual como el ÚLTIMO elemento del array — se detecta por índice (sin threadear un flag aparte) y SOLO ese turno pasa a `content:[{type:'text',...}, {type:'image', source:{type:'base64', media_type, data}}]`; el historial sigue como `content:string`.
- **Gemini** (`geminiContents`): `parts` ya era un array — una imagen se suma como un part `{inline_data:{mime_type, data}}` más, junto al part de texto.

El historial (mensajes anteriores) sigue mandando solo la referencia de texto que ya existía — ninguna imagen vieja se re-manda en turnos siguientes, a propósito (`currentImageAttachments()` filtra explícitamente por `context.attachments`, nunca por `context.history`).

### Tarea 3 — Guard de tamaño (límites reales, verificados contra documentación oficial)

| Runtime | Límite aplicado | Fuente |
|---|---|---|
| `anthropic-api` | 10 MB (base64-encoded) | Límite exacto documentado de la API directa de Anthropic (Bedrock/GCP es 5MB, no aplica a este runtime) |
| `foundry` | 20 MB | "Maximum input image size" documentado por Microsoft Learn (Azure OpenAI vision) |
| `gemini-api` | 20 MB | Techo documentado del *request* completo (texto + imagen inline) para `generateContent`; aplicado igual por-imagen porque Amatista manda una sola imagen por turno |
| `openai-chat` | 10 MB | **Sin número exacto documentado por OpenAI** para `image_url` (solo un techo genérico de payload total, 512MB, no específico de imagen) — se usó el más conservador de los 3 SÍ confirmados, por instrucción explícita del usuario ante falta de dato exacto |

Guard (`assertImageAttachmentsWithinLimit()`) corre en `send()`, ANTES del dispatch a cualquiera de los 4 `sendXxx` — único chokepoint, mismo criterio que `runTool()` como único punto de dispatch de tools. Mide el base64 codificado real (`parsed.base64.length`), no el tamaño del archivo original en disco — son distintos (~33% más grande codificado) y el límite documentado de cada proveedor es sobre el dato codificado. Si se supera, corta con un error legible (`La imagen "X" pesa ~YMB codificada en base64, supera el límite de ZMB de <runtime>.`) en vez de dejar que la API lo rechace con un `invalid_request_error` críptico.

### Verificación

`npm run typecheck` y `npm run build`: en verde. Verificación funcional end-to-end (turno real con imagen adjunta contra los 4 runtimes) queda pendiente de una key transitoria por proveedor — ver Tarea 0 arriba, 1 de 4 shapes confirmado en vivo (openai-chat), 3 confirmados solo contra documentación.

## Visión real en los 2 runtimes CLI (Fase 17, Parte 2)

### Investigación previa (decide todo el diseño, hecha antes de tocar código)

Tres hallazgos empíricos, ninguno asumido de documentación:

1. **Codex `localImage` NO respeta el cwd del spawn** — a diferencia de `Read` de Claude Code (que rechaza explícito un path fuera del cwd), un `{type:'localImage', path:<fuera del cwd>}` real fue aceptado y descrito sin ningún error. Comportamiento distinto entre los dos CLI, confirmado, no asumible por analogía.
2. **Codex `{type:'image', url:'data:...'}` acepta un data URI embebido, sin filesystem** — probado primero con la PNG 1x1 de ejemplo de la documentación de Anthropic (dio una descripción incorrecta, "verde/oliva transparente" cuando el píxel real decodificado es rojo sólido sin alfa — limitación conocida de imágenes <200px, no un problema de shape). Repetido con `logoamatista.png` real: descripción correcta. **Conclusión: la vía más simple para Codex, mismo `attachment.preview` que ya usan los 4 runtimes API desde Parte 1, cero cambio de modo de invocación.**
3. **`claude -p` SÍ tiene un mecanismo para imagen embebida — pero no es un flag, es un modo de entrada distinto:** `--input-format stream-json --output-format stream-json`, mensaje mandado por stdin con `content:[...]` shape Messages API real (`{type:'image', source:{type:'base64', media_type, data}}`), probado en vivo con `logoamatista.png` real — descripción correcta, `permission_denials:[]`. Esto corrigió la hipótesis inicial ("solo queda escribir un archivo temporal para que `Read` lo encuentre") — no hace falta ningún archivo temporal.

**Riesgo real identificado antes de tocar código — "regresión silenciosa":** `sendClaude()` actual acumula todo `stdout` en un string y hace UN solo `JSON.parse(stdout)` en `exit`, asumiendo un blob único (`--output-format json`). `--output-format stream-json` emite VARIAS líneas JSON por turno (`system/init`, `rate_limit_event`, `assistant`, `system/post_turn_summary`, línea final) — ese string acumulado no es JSON válido. El `try/catch` existente absorbería el `JSON.parse` roto en silencio y devolvería las líneas crudas como si fueran la respuesta, sin ningún error visible. Migrar TODO `sendClaude()` a `stream-json` habría expuesto ese riesgo al 100% de los turnos de Claude CLI (el camino de mayor tráfico del archivo, estable desde Fase 7/13); el caso que necesita imagen es minoritario y opt-in.

**Decisión (bifurcación condicional, no migración completa):** turno sin imágenes → `sendClaude()` sin ningún cambio de código ejecutado. Turno con imágenes → `sendClaudeWithImages()`, método nuevo separado, con su propio parseo línea-por-línea (mismo patrón `readline` que ya usa `sendGemini()` en este archivo — nunca acumular-y-parsear-al-final).

### Fix — Codex (`codex-client.ts`, `sendTurn()`)

Un solo cambio: `input` pasa de `[{type:'text', text}]` a `[{type:'text', text}, ...imageAttachments.map(a => ({type:'image', url: a.preview}))]`, filtrando `context.attachments` por `kind:'image' && preview` — mismo criterio "solo el turno actual, nunca historial" que Parte 1 (`context.attachments` es siempre el turno actual por construcción de `RuntimeContextEnvelope`, sin lógica adicional necesaria).

### Fix — Claude (`cli-agent-runtime.ts`)

- **Reuso vs. duplicación (decisión explícita):** `parseDataUrl()`/`anthropicImageBlocks()` de `api-agent-runtime.ts` **NO se reusaron** — versión local mínima (`parseDataUrl()`/`claudeImageBlocks()`) duplicada en `cli-agent-runtime.ts`. Dos razones: (1) restricción explícita de esta fase de no tocar `api-agent-runtime.ts` (cerrado en Parte 1), y ninguna de las dos funciones está exportada hoy — reusarlas de verdad habría significado abrir ese archivo solo para agregar un `export`; (2) aunque no hubiera restricción, son ~10 líneas puras sin estado — duplicarlas es más barato que crear un acoplamiento nuevo entre el runtime CLI y el runtime API (hoy independientes).
- **`sendClaude()`:** al inicio, filtra `currentImageAttachments(context)` — si hay imágenes, delega a `sendClaudeWithImages()` y retorna; si no, el resto de la función sigue **byte por byte idéntico** a como estaba antes de esta fase.
- **`sendClaudeWithImages()` (método nuevo):** args cambian de `['-p', prompt, '--output-format', 'json', ...]` a `['--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--max-turns', '20', ...permissionArgs()]` — `--max-turns`/`permissionArgs()`/`--model`/`--resume`/`--effort` se preservan **idénticos** a `sendClaude()`, confirmado en Tarea 3 contra el transporte real (no asumido). El mensaje se escribe por `stdin` (`{type:'user', message:{role:'user', content:[{type:'text',...}, ...claudeImageBlocks(images)]}}`) en vez de ir como argumento posicional. Salida parseada línea por línea con `readline`; la línea final se identifica por tener `is_error` (boolean) — ninguna otra línea del stream trae ese campo, confirmado con el output real; no tiene `type` propio, a diferencia de `system`/`assistant`/`rate_limit_event`.
- **Bug real encontrado y corregido durante la Tarea 3 (no en la investigación previa, solo se manifestó al ejecutar):** `--print` + `--output-format=stream-json` sin `--verbose` es rechazado por Claude Code CLI (`"Error: When using --print, --output-format=stream-json requires --verbose"`) — el proceso ni siquiera llega a leer stdin, y el intento de escribirle de todos modos generó un `'error'` sin manejar en el socket de `stdin` que tumbó el proceso Node entero (unhandled event), no solo el turno. Fix de dos partes: se agregó `--verbose` a los args, y un handler defensivo `child.stdin.on('error', () => {})` para que cualquier fallo de escritura futuro lo resuelva `child.on('exit', ...)` (que ya rechaza con el `stderr` real) en vez de tirar abajo el proceso.

### Verificación real (Tarea 3)

Contra las clases reales `CliAgentRuntime`/`CodexClient` (bundle esbuild standalone, `--define:__APP_VERSION__`, sin reimplementar nada), usando `logoamatista.png` real (no un placeholder chico — la 1x1 ya había dado un falso negativo en la investigación de Codex):

**Claude, 3 turnos en la misma sesión (mismo proceso de verificación):**
1. **Turno A, sin imagen (camino viejo):** estableció sessionId, confirmó recepción de una palabra secreta (`MORADO17`).
2. **Turno B, con imagen (`sendClaudeWithImages`), mismo `sessionId` vía `--resume` + `--effort low`:** descripción correcta de `logoamatista.png` (gema facetada violeta/azul, letra "A" con circuito, incluso identificó el archivo real por su ruta en el propio texto de respuesta) — confirma que **`--resume` y `--effort` sí funcionan en el camino nuevo**.
3. **Turno C, sin imagen otra vez, mismo `sessionId` (camino viejo):** recordó `MORADO17` correctamente — confirma continuidad de sesión a través del turno con imagen (el `--resume` seteado por el camino nuevo lo siguió usando el camino viejo sin fricción) y **cero regresión** en el caso mayoritario (mismo shape de `raw` que siempre: `is_error/duration_api_ms/num_turns/stop_reason/session_id/total_cost_usd/usage/modelUsage`).

**Codex, vía `CodexClient.sendTurn()` real:** `sendTurn()` solo devuelve el ack inmediato de `turn/start` (`status:'inProgress'`) — el resultado real llega como notificación JSON-RPC `turn/completed` (mismo patrón ya usado en la Tarea 0 original). Turno con imagen real: descripción correcta y detallada de `logoamatista.png`.

`npm run typecheck` y `npm run build`: en verde.

## Sincronización de catálogo para conexiones openai-chat (Fase 18)

Mismo patrón que `syncCodexProvider()`/`listCodexModels()` (Codex), pero **no** es un reemplazo completo del array `models` — con 400+ modelos posibles en un endpoint como OpenRouter, reemplazar todo de una sería inmanejable y probablemente indeseado (el usuario no quiere 400 modelos en su lista). En su lugar: fetch → catálogo en memoria → panel buscable → el usuario agrega modelos puntuales uno por uno, mismo mecanismo que ya usa `addManualModel()` pero con los campos precargados desde datos reales en vez de vacíos.

### Fetch real (`src/main/openai-chat-catalog.ts`, módulo nuevo)

`GET <endpoint>/models`, con el mismo criterio de normalización de endpoint que `openAiChatCompletionsUrl()` (tolera con/sin `/v1`, con/sin `/models` ya puesto) — **no reusada de `api-agent-runtime.ts`** a propósito (archivo de otra responsabilidad, el acoplamiento no vale la pena por 6 líneas); sí se reusan `fetchWithTimeout()`/`readErrorBody()` de ahí, esas SÍ ya estaban exportadas y son utilidades genéricas, no lógica de feature.

**Shape real confirmado en vivo** (GET sin autenticar, 200 — el endpoint de listado no exige key, aunque el header se manda si hay una disponible por si algún backend Chat-Completions-compatible sí la exige): `{data:[{id, name, context_length, supported_parameters, architecture:{input_modalities}, top_provider:{max_completion_tokens}, ...}], total_count, links}`. 417 modelos reales al momento de escribir esto.

Parseo defensivo (mismo criterio `firstString`/fallback-keys que `codex-account-bridge.ts:listModels()`), 4 señales extraídas por modelo:
- **`supportsTools`**: `"tools"` (string exacta) presente en `supported_parameters` — confirmado en vivo, 348 de 417 modelos reales lo traen. Si el campo está ausente en otro backend, el modelo simplemente no pasa el filtro por default (el toggle "Mostrar todos" en la UI lo destapa) — no se asume `false` como error, se documenta como límite conocido.
- **`supportsVision`**: `"image"` (substring) en `architecture.input_modalities` — confirmado en vivo (`stealth/ox-alpha`: `["text","image","video"]`).
- **`maxOutputTokens`**: `top_provider.max_completion_tokens` — confirmado en vivo como el techo REAL de salida (`stealth/ox-alpha` → 131072, coincide exacto con el valor ya documentado a mano en Fase 15). Se prefiere sobre cualquier campo plano equivalente.
- **`contextLength`**: `context_length` — solo informativo en la UI, no se mapea a `maxOutputTokens` (son conceptos distintos: ventana de contexto vs. techo de salida).

### IPC (`ipc-openai-chat-catalog.ts`, módulo nuevo — no sumado a `ipc-cli.ts`, sin relación con CLIs)

`openaiChat:listModels` recibe `{endpoint, apiKey}` directo del `activeProvider` en memoria del renderer (no hace falta resolver el provider del lado main) y devuelve el catálogo ya parseado. Si falla (endpoint sin `/models`, key inválida, lo que sea): error propagado tal cual a `notice`, mismo patrón que `syncCodexModels()` — nada se rompe, el usuario sigue pudiendo usar "+ Agregar" a mano.

### UI (`App.tsx`)

Botón "Sincronizar modelos" visible solo para `activeProvider.type === 'openrouter'`, junto al "+ Agregar" existente. Al sincronizar, un panel nuevo (`.catalog-sync-panel`) con: input de búsqueda (filtra por `id` o `displayName`, client-side — nunca un `<select>` de 400+ opciones ni scroll infinito sin filtro), checkbox "Mostrar todos" (destapa el filtro-por-default de `supportsTools`), y una lista con scroll acotado (`max-height:320px`) — cada fila muestra contexto/salida/tools/vision y un botón "Agregar" que suma ESE modelo puntual vía `addCatalogModel()`.

### Verificación real

Contra la función real `listOpenAiChatModels()` (bundle esbuild standalone, `--external:electron` + stub — mismo patrón que las verificaciones de Fase 9/13/17), sin key (endpoint público):
- **417 modelos reales** parseados sin error.
- `stealth/ox-alpha` parseado correcto: `{supportsTools:true, supportsVision:true, contextLength:1048576, maxOutputTokens:131072}`.
- **348/417** con `supportsTools:true`.
- Búsqueda `"ox"` encuentra `stealth/ox-alpha` (y, correctamente, también `mistralai/voxtral-small-24b-2507` — coincidencia de substring real, no un bug).

`npm run typecheck` y `npm run build`: en verde. Prueba con key transitoria real de OpenRouter: condicional a que el usuario la provea (mismo protocolo de siempre, nunca a disco) — ver REPORTE del commit para el resultado real.

### Ajuste posterior — filtro server-side best-effort (`?supported_parameters=tools`)

La implementación original NO mandaba ningún query param — traía el catálogo completo (417) y calculaba `supportsTools` enteramente client-side. Esto **no fue una decisión deliberada**: no se investigó si `/models` soportaba un filtro server-side antes de implementar. Ante la pregunta explícita del usuario, se confirmó (documentación real de OpenRouter) que sí existe: `GET /api/v1/models?supported_parameters=tools`.

Agregado como **optimización best-effort**, sin tocar el filtrado client-side existente (que sigue siendo la fuente de verdad): la URL ahora incluye `?supported_parameters=tools` (o `&...` si el endpoint ya trae query string); un backend que no reconoce el param lo ignora (comportamiento estándar de casi cualquier API REST) y devuelve el catálogo sin filtrar, que el filtrado client-side sigue procesando exactamente igual.

**Medido en vivo, no asumido** (mismo snapshot temporal, dos requests consecutivos contra OpenRouter real):
- Sin el param: `687455 bytes`, 417 modelos.
- Con el param: `585381 bytes`, 333 modelos — **14.8% menos payload**.

**Hallazgo real e inesperado, confirmado con los datos de la propia comparación:** el filtro server-side de OpenRouter **no es equivalente** al cálculo client-side. Del mismo snapshot sin filtrar (417 modelos), el cálculo client-side (`supported_parameters.includes('tools')`) detecta **348** modelos con tools — pero el filtro server-side devolvió solo **333**. Diferencia real de **15 modelos** que el server-side omite pese a tener `"tools"` en su propio `supported_parameters`, incluyendo modelos no triviales como `anthropic/claude-fable-latest`, `x-ai/grok-latest`, `openrouter/auto-beta`. **Esto confirma en la práctica, no solo en teoría, por qué el filtrado client-side debía quedar como fuente de verdad y no ser reemplazado por el query param** — de haber confiado solo en el server-side, esos 15 modelos habrían desaparecido en silencio del catálogo sincronizado.

## Fix: watchdog stale (`TURN_WATCHDOG_MS` congelado en el closure del primer render)

Mismo mecanismo exacto que ya resolvía `turnStepsRef` para el log de pasos del turno: `handleAgentEvent` (y por lo tanto `startTurnWatch()`, invocada únicamente desde ahí) se suscribe una sola vez vía `useEffect(() => { ... window.universalAgent.onAgentEvent(handleAgentEvent) ... }, [])` (línea ~873, deps vacías, confirmado con grep antes de tocar código) — esa versión de la función queda congelada con el closure del primer render, así que cualquier referencia directa a una variable derivada de `settings` dentro de ella sigue leyendo el valor del PRIMER render para siempre, ignorando cambios posteriores en Settings.

`TURN_WATCHDOG_MS` (Fase 14, `turnWatchdogSeconds * 1000`) tenía justo ese problema: las dos referencias directas dentro de `startTurnWatch()` (el `setTimeout(..., TURN_WATCHDOG_MS)` y el string del mensaje de error `${TURN_WATCHDOG_MS / 1000}s`) leían el valor congelado, no el configurado en vivo — si el usuario cambiaba el timeout del watchdog en Settings a mitad de sesión, el cambio nunca se aplicaba hasta recargar la app entera.

**Fix**: `turnWatchdogMsRef = useRef(TURN_WATCHDOG_MS)` + `useEffect(() => { turnWatchdogMsRef.current = TURN_WATCHDOG_MS }, [TURN_WATCHDOG_MS])` — el efecto SÍ se re-ejecuta en cada render donde cambia `TURN_WATCHDOG_MS` (no tiene deps vacías), así que el ref siempre queda sincronizado con el valor real de Settings, sin importar que `startTurnWatch()` en sí siga viviendo dentro del closure congelado — lee `turnWatchdogMsRef.current` en vez de la variable capturada, y una lectura de `.current` en el momento de la llamada siempre trae el valor actual, no el capturado.

Verificación (lectura directa del código resultante, mismo criterio ya usado para confirmar `sendClaude()` sin cambios en Fase 17 Parte 2): `grep -n "TURN_WATCHDOG_MS\b"` sobre el archivo final muestra la variable solo en su declaración y en el par ref/efecto — cero referencias directas restantes dentro de `startTurnWatch()`.

`npm run typecheck` y `npm run build`: en verde. Sin test end-to-end (no hacía falta, mismo criterio de verificación por lectura ya aceptado).

## Archivo/comando específico + diff de líneas en el log de actividad en vivo (Fase 19)

### Tarea 0 — Investigación real de Codex (decide si hacía falta tocar algo de ese lado)

Probado en vivo contra `codex app-server --stdio` real (no asumido): **los eventos nativos de Codex ya traen detalle rico por item, mucho más que el genérico `name/phase` que manda `ApiAgentRuntime`**. Dos shapes reales confirmados:

- **`item.type: 'commandExecution'`**: `item.command` (string completo del comando), `item.cwd`, `item.exitCode`, `item.durationMs`, `item.aggregatedOutput`, `item.status`. Ejemplo real capturado: `"command": "\"C:\\WINDOWS\\...powershell.exe\" -Command \"rg -n -i -m 3 ...\""`.
- **`item.type: 'fileChange'`**: `item.changes` es un ARRAY de `{path, kind:{type:'add'|...}, diff}` — `path` es la ruta absoluta real, `diff` para `kind.type:'add'` confirmado como el contenido completo del archivo nuevo (no un diff unificado con +/-). Ejemplo real: `"changes":[{"path":"D:\\...\\scratch-fase19-codex-test.txt","kind":{"type":"add"},"diff":"linea uno\nlinea dos\nlinea tres\n"}]`.

**Conclusión: `wireCodex()` (`runtime-state.ts`) no necesitó ningún cambio** — reenvía `raw`/`notification` tal cual desde el transporte real, sin sintetizar nada (a diferencia de `wireApi()`, que sí arma `item/toolCall/status` a mano desde el evento `toolStatus` propio de `ApiAgentRuntime`). El trabajo de Codex quedó exclusivamente del lado renderer: **`summarizeCodexItem()` (`App.tsx`) ya intentaba leer `item.path`/`item.file` para items de archivo — campos que NUNCA existen en el shape real** (`fileChange` usa `item.changes[].path`), así que esa rama nunca matcheaba antes de este fix, cayendo siempre al genérico `${itemType} completado`. Corregido para leer `item.changes[].path` real; el verbo (`Creando`/`Borrando`/`Editando`/`Modificando`) solo se etiqueta con certeza para `kind.type:'add'` (el único confirmado en vivo) — `'modify'`/`'delete'` no se probaron en esta ronda (el helper Windows sandbox del entorno de investigación, `codex-windows-sandbox-setup.exe`, no está instalado en esta máquina — bloqueo local, no relacionado con el código), así que se etiquetan con el nombre literal de Codex sin inventar certeza que no se verificó. **No se replicó el conteo +X/-Y para Codex** — el campo `diff` de `fileChange` no es un diff unificado verificado (para `'add'` es contenido plano), así que no se intentó parsear como tal sin evidencia real del shape de `'modify'`.

### Camino API — implementación (decisiones ya tomadas)

- **`toolStatusArgDetail(name, args)`** (`api-agent-runtime.ts`, nueva): switch de solo lectura sobre los args que `runTool()` ya recibe — `path` para `read_file`/`write_file`/`apply_patch`/`list_dir`/`revert_file`, `path`+`pattern` para `search_files`, `command` para `run_command`. Cero cambio de qué tool se ejecuta ni con qué argumentos, solo qué viaja en el evento `toolStatus`. Calculado UNA vez por llamada, reusado en los emits de `phase:'start'` y `phase:'done'`.
- **Conteo +X/-Y**: `ToolExecutionResult` (`tool-registry.ts`) gana un campo opcional `lineDiff?: {added, removed}`. `formatWriteFileDiff()` — antes devolvía solo el string del preview del diálogo de aprobación — ahora devuelve `{preview, added, removed}`, calculados del **mismo** `DiffLine[]` de `computeLineDiff()` que ya se armaba para ese diálogo (`countLineChanges()`, un simple tabulado de `type==='add'`/`'remove'` sobre ese array, sin recorrer el contenido de nuevo). `write_file`/`apply_patch` adjuntan `lineDiff` a su `ToolExecutionResult` de éxito; `revert_file` sigue llamando a la misma función (ajustada solo para leer `.preview`) sin ganar `lineDiff` — no estaba en el alcance pedido. **Confirmado con grep: `computeLineDiff(` tiene un único call site real** (dentro de `formatWriteFileDiff()`) — el conteo nunca recalcula el diff.
- **UI** (`App.tsx`): `toolCallTargetLabel(params)` arma `"src/App.tsx"` / `"\"tools\" en src/main"` / el comando literal; `lineDiffLabel(params)` arma `"+X -Y"` cuando `lineDiff` está presente. El handler de `item/toolCall/status` ahora arma `Ejecutando: write_file (src/App.tsx)` en `phase:'start'` y `write_file completado (src/App.tsx, +100 -20)` en `phase:'done'` — antes mostraba `params.workspace` (el workspace conectado, SIEMPRE el mismo durante todo el turno, cero información nueva por llamada) en vez del argumento real de la tool.

### Verificación

`npm run typecheck` y `npm run build`: en verde. `computeLineDiff(` con un único call site confirmado por grep — el conteo +X/-Y sale del mismo cálculo ya usado para el diálogo de aprobación, no de uno nuevo. Sin test end-to-end de UI (cambio de solo reporting, sin lógica de ejecución nueva); Tarea 0 sí verificada en vivo contra el transporte real de Codex.

## LSP real para TypeScript — diagnósticos en vivo (Fase 20)

Sobre la base de la investigación previa de esta misma fase (Tarea 0-4 investigativas, ver historial de commits): framing `Content-Length` (`LspFramer`, promovido tal cual del prototipo), handshake real, servidor **push-only** (sin pull-diagnostics), URIs de Windows que no matchean por string, `shutdown`+`exit` como cierre limpio, y latencia real medida (~2.7-3.7s fría / ~442ms caliente).

### Instalación real — hallazgo que cambió el plan original

El plan inicial era pinnear `typescript@^5` (lo que se verificó funcionando en la investigación, contra `typescript@latest`/7.0.2 roto). **Antes de implementar se encontró algo mejor**: el proyecto **ya tiene `typescript@^6.0.0`** como devDependency (para `tsc --noEmit`), y esa versión instalada (`6.0.3`) **sí trae `tsserver.js`** (a diferencia de 7.x) — confirmado en vivo repitiendo el handshake completo contra `typescript@6.0.3` exacto, mismo resultado que con 5.x. **Decisión: reusar la MISMA instalación de `typescript` para ambos propósitos** (build-time `tsc` y runtime del language server) en vez de sumar una segunda versión en paralelo — evita un conflicto real de rango (`^6.0.0` vs `^5.x` son mutuamente excluyentes bajo resolución flat de npm) y evita duplicar ~20MB de `typescript` dos veces en el instalador. `typescript-language-server` no declara una dependencia propia de `typescript` (la busca en el `node_modules` del consumidor) — confirmado leyendo su `package.json` real, sin nested `node_modules/typescript` duplicado tras el install.

`typescript` se movió de `devDependencies` a `dependencies` (ahora es un dependency real de runtime del producto shippeado, no solo una herramienta de build) — `typescript-language-server@^6.0.0` se sumó como dependency nueva.

### Empaquetado — `files`/`asarUnpack` (hallazgo real, no trivial)

`package.json`'s `"build".files` es un allowlist explícito (`["out/**/*", "package.json"]`) — **nada de `node_modules` viaja hoy en el instalador**, todo lo demás (`react`, `monaco-editor`, etc.) se bundlea vía Vite dentro de `out/`. `typescript-language-server`/`typescript` **no se pueden bundlear así**: son programas que se spawnean como proceso real (`cli.mjs`) y leen sus propios archivos de datos en disco en runtime (`tsserver.js`, cientos de `.d.ts` de las libs), no módulos JS para importar. Se agregaron explícitos a `files` (`"node_modules/typescript-language-server/**/*"`, `"node_modules/typescript/**/*"`) y a `asarUnpack` (mismos dos globs) — sin `asarUnpack`, estos archivos quedarían empaquetados dentro de `app.asar` (un archivo virtual, no un path de filesystem real) y `spawn()` no podría ejecutarlos.

`typescript-language-server`'s `lib/cli.mjs` está **completamente self-bundled** (confirmado grepeando sus imports: solo módulos built-in de Node, cero paquetes npm externos, `commander` y el resto de sus dependencias reales están inlineados en el archivo) — no hace falta unpackear nada más que esos dos paquetes.

Spawn real: `spawn(process.execPath, [cli.mjs, '--stdio'], {env: {...process.env, ELECTRON_RUN_AS_NODE: '1'}})` — usa el propio Electron como intérprete Node, sin depender de un `.cmd`/wrapper de shell (a diferencia del prototipo de investigación, que usaba `shell:true` + `.cmd`, con el warning de seguridad de Node por args no escapados). `resolveLanguageServerEntry()` arma el path real vía `app.getAppPath()`, sustituyendo `app.asar` → `app.asar.unpacked` cuando corresponde (dev sin asar vs. producción empaquetada).

### Módulos nuevos

- **`lsp-framer.ts`**: `LspFramer`/`encodeLspMessage`, promovidos tal cual del prototipo validado en la investigación (mismos 3 casos sintéticos + prueba contra proceso real ya cubiertos ahí, no re-probados desde cero).
- **`lsp-client.ts`**: `LspClient` — spawn + handshake (`initialize`/`initialized`, capabilities mínimas de `publishDiagnostics`), `notifyFileChanged()` (`didOpen` la primera vez por archivo en la sesión, `didChange` con versión incremental después), cache `Map<pathNormalizado, {diagnostics, updatedAt}>`, `lastEditAt` por archivo, `waitForFreshDiagnostics()` (poll acotado), `shutdown()` real (`shutdown` request + `exit` notification, con timeout de respaldo a `kill()` si el proceso no sale solo). Normalización de URI↔path: `pathToFileURL()` al mandar, `fileURLToPath()` + `path.resolve().toLowerCase()` (en Windows) al recibir — **nunca comparación de URIs como string** (el hallazgo de la investigación previa).
- **`lsp-manager.ts`**: `LspManager` — análogo a `McpManager` pero con arranque **perezoso** (nunca en `agent:connect`, recién en el primer `notifyFileWritten()` real de un `.ts`/`.tsx`). `getDiagnostics(path?)` con timeout documentado (`DIAGNOSTICS_WAIT_TIMEOUT_MS = 5000` — margen sobre el peor caso medido en frío, ~3.7s). `stopAll()` fire-and-forget hacia `LspClient.shutdown()`, mismo punto de `disconnectAgent()` que ya para `apiRuntime`/`mcpManager`.

### Wiring — alcance limitado a los 4 runtimes API (documentado, no un olvido)

`ExecuteContext.lspManager` es **opcional**, mismo patrón que `resolveExploreModel` — solo lo provee `ipc-agent.ts` dentro de la rama `isApiCapableModel` de `agent:connect` (instanciado sin arrancar nada, `new LspManager(workspace)`). `write_file`/`apply_patch` (`tool-registry.ts`) llaman `ctx.lspManager?.notifyFileWritten(target, content)` **fire-and-forget** justo después de `writeFileSync` — no bloquean el resultado de la tool, un fallo del LSP (arranque roto, timeout, etc.) nunca hace fallar la escritura del archivo. `get_diagnostics` (tool nueva, solo lectura, sin aprobación) usa `ctx.lspManager?.getDiagnostics()`.

**Runtimes CLI (`claude-cli`/`codex-subscription`/`codex-api`) quedan fuera de alcance por completo** — editan con sus propias tools nativas (`Read`/`apply_patch` propios de cada CLI), nunca pasan por `ToolRegistry.execute()`, así que `ExecuteContext.lspManager` nunca les llega. Mismo patrón de "alcance documentado, no una omisión silenciosa" que Fase 17 Parte 1 (visión) usó para su propio recorte inicial de alcance.

No hizo falta sumar un guard `assertWorkspaceStillActive` para `lspManager` (a diferencia de `mcpManagerForConnection`, que sí lo tiene): `LspManager` se construye 100% síncrono en `agent:connect` (`new LspManager(workspace)`, sin ningún `await` de por medio) — el arranque real perezoso del proceso ocurre mucho después, disparado por un `write_file` real, momento en el que la conexión activa ya está completamente establecida. No hay ventana de carrera equivalente a la que `McpManager.startAll()` sí tiene (esa sí es un `await` largo en pleno `agent:connect`).

### Verificación real (Tarea 5)

Contra las clases reales (`ToolRegistry`, `LspManager`, `LspClient`, `LspFramer`) vía bundle esbuild standalone (`--external:electron` + stub, mismo patrón que verificaciones previas) — **no a través de un turno real de LLM** (sin key transitoria provista en esta ronda): se invocó `ToolRegistry.execute()` directamente con los mismos argumentos que cualquiera de los 4 `runTool()` de `api-agent-runtime.ts` mandaría, ejercitando el código de producción real, solo sin la decisión del modelo de llamarlo.

1. **Arranque perezoso confirmado**: `lspManager.isRunning() === false` antes de tocar cualquier `.ts`, y **sigue false** después de un `get_diagnostics` sin nada tocado (`get_diagnostics` NO dispara el arranque — solo `write_file`/`apply_patch` lo hacen).
2. `write_file` con error deliberado (`ciruela7malva: number = "..."`) → `isRunning()` pasa a `true`; `get_diagnostics` real devuelve `error [2:7] TS2322: Type 'string' is not assignable to type 'number'.` — línea/columna/código coinciden exacto.
3. `write_file` con el fix → `get_diagnostics` reporta `sin errores ni warnings`.
4. `get_diagnostics` sin `path` (todos los archivos tocados) — mismo resultado, un solo archivo tracked.
5. `stopAll()` → `isRunning()` vuelve a `false`; confirmado además a nivel de SO (`tasklist` sin ningún `node.exe` colgado tras el shutdown).

`npm run typecheck` y `npm run build`: en verde.

### Impacto real en el instalador (medido, no estimado)

- Instalador anterior (0.6.6, sin Fase 20): **117.554.269 bytes**.
- Instalador con `typescript@6.0.3` + `typescript-language-server@6.0.0` bundleados (mismo `npm run dist` real): **120.932.931 bytes**.
- **Delta real: +3.378.662 bytes (≈3,22 MB)** — compresión NSIS real sobre ~22,4MB sin comprimir (`typescript` ~20MB + `typescript-language-server` ~2,4MB en `app.asar.unpacked/node_modules/`, confirmado con `du -sh` sobre el `win-unpacked` real), consistente con que son mayormente texto (`.d.ts`, JS) altamente compresible.
- `asarUnpack` confirmado funcionando: `release/win-unpacked/resources/app.asar.unpacked/node_modules/{typescript,typescript-language-server}` existen como carpetas reales, no dentro del `.asar`.

### `PENDING.md`

Revisado — sin ningún ítem relacionado a LSP/diagnósticos de TypeScript que resolver o quitar.

## Rediseño de identidad de proveedores + selector de modelo tipo acordeón (Fase 21)

Mockup aprobado por el usuario recibido pegado directamente en el chat (la ruta sandbox original, `/mnt/user-data/outputs/...`, no existe en esta máquina — confirmado antes de tocar nada, ver turno previo) — implementación 1:1 contra ese HTML real, colores/comportamiento exactos.

### Tarea 1 — Identidad real, reemplaza `providerDisplayName()`

`providerDisplayName()` (heurística: `` `${name} ${type} ${authMode}`.toLowerCase().includes(...)` ``) generaba nombres DISTINTOS para la misma marca según `authMode` ("Claude Pro" vs "Claude API via Azure" vs "DeepSeek API") — eliminada por completo. `providerIdentity(provider): {name, initial, background, accent, halo}` la reemplaza en los 6 call sites reales (`grep` confirmó todos antes de tocar código): tiebreaker de `providersForDisplay()`, pill de estado del topbar, header del acordeón, fila de conexiones, `<option>` del selector de modelo de compactación, `section-label` del panel de detalle.

- **Clave primaria `provider.type`**, un `switch` exhaustivo sobre los 7 valores reales de `ProviderType` (confirmados con `grep` contra `shared/types.ts` antes de escribir el switch — incluye `'openrouter'`, ya confirmado como tipo real y distinto en el turno previo a esta fase).
- **DeepSeek** — único caso especial real, chequeado ANTES que el resto: `isDeepSeekProvider(provider)`, comparación por **igualdad exacta**, no substring — `provider.type === 'anthropic' && provider.endpoint === DEEPSEEK_ANTHROPIC_ENDPOINT`. `DEEPSEEK_ANTHROPIC_ENDPOINT = 'https://api.deepseek.com/anthropic'` es ahora la única fuente de verdad — antes era un string literal duplicado (uno en `newDeepSeekProvider()`, la lógica de detección por substring aparte en `providerDisplayName()`/`providerSubtitle()`); `newDeepSeekProvider()` fue actualizada para usar la constante en vez del literal.
- **Claude API key/Azure vs Claude suscripción**: ya NO tienen nombres/colores distintos (ambos son "Anthropic", `#d97757`) — el método (Suscripción/API key) se comunica exclusivamente vía la pill separada (`MethodPill`), nunca más concatenado al nombre. Esto es un cambio de comportamiento real respecto a la heurística vieja, deliberado y pedido explícitamente ("Método de conexión SIEMPRE como pill/etiqueta separada, nunca concatenado al nombre").
- **Codex ChatGPT vs OpenAI**: dos `case` directos del switch (`'openai-codex'` / `'openai'`), nombres distintos, mismo color de marca (ambos son OpenAI) — no se pidió diferenciarlos por color, solo por nombre/pill.
- **Tipos sin marca reconocible** (`'openai-compatible'`, y cualquier `ProviderType` futuro no listado — mismo `default` del switch): color neutro `#6b7280`/halo `rgba(107,114,128,0.25)` (elección propia, documentada — Tailwind gray-500/600, visible contra el fondo oscuro existente), inicial derivada de `provider.name` (el único campo con contenido real para ese caso).

**`providerSubtitle()` se mantuvo** (no reemplazada) — sigue describiendo el MECANISMO de conexión (CLI usado, tipo de endpoint), un dato que la insignia (marca) y la pill (método) no cubren. Se simplificó su rama DeepSeek para usar `isDeepSeekProvider()` en vez de un substring propio redundante. **`providerGroupLabel()` se eliminó** — quedó sin ningún call site tras el rediseño del acordeón (su única llamada, en el header del `model-menu` viejo, fue reemplazada por `MethodPill`, que comunica lo mismo de forma más precisa por-conexión en vez de por-grupo). **`providerModeLabel()`/`providerDisplayRank()` quedaron intactas** — la primera se usa en un pill de estado del topbar sin relación con esta fase, la segunda sigue ordenando la lista de conexiones y el acordeón de forma consistente (sin pedido de cambiarla).

Nueva función `providerConnectionSubtitle()` (Tarea 3) — subtítulo dinámico real, no una tabla de strings hardcodeados: "N modelos — nombre, nombre y M más" a partir de `provider.models.filter(enabled)` real (mismo patrón que el mockup, "6 modelos — GPT-5.x, Claude, DeepSeek", pero derivado de datos reales, no reproducido literal). Si no hay modelos habilitados (conexión recién creada, o de solo-suscripción como Claude Pro/Codex ChatGPT/Gemini Advanced), cae a `providerSubtitle()` — ahí es donde esa función sigue aportando algo que el conteo de modelos no puede.

### Tarea 2 — Insignia reusable

`ProviderBadge({identity, size})` — un solo componente, círculo + inicial + halo (`box-shadow: 0 0 0 3px halo`, igual que el mockup), usado tal cual en la fila de conexiones (`size` default 34px) y en el header de cada grupo del acordeón (`size={24}`) — nunca duplicado como JSX/CSS repetido en dos lugares. `MethodPill({provider})` — mismo criterio, 2 variantes fijas (`sub`/`key`), no data-driven por marca (así lo define el propio mockup: la pill comunica MÉTODO, no marca).

**Desviación deliberada del mockup, documentada**: el mockup solo demuestra un único proveedor con color de "seleccionado" fijo (`--accent: #d97757`, la naranja de Anthropic, reusada tanto para la pill de suscripción como para el ítem de modelo seleccionado) — funciona en un demo de una sola marca, pero en la app real con 7 marcas posibles tener SIEMPRE naranja-Anthropic como color de "seleccionado" se ve incongruente dentro de un grupo Foundry/DeepSeek/OpenRouter azul o púrpura. Se agregó el campo `accent` a `ProviderIdentity` (siempre sólido, nunca gradiente — para Google usa `#4285F4`, el primer stop del gradiente) y `.model-item.selected` toma ese color vía `style` inline según el grupo abierto, en vez de un naranja fijo. La pill `.method-pill.sub` SÍ se dejó con el naranja fijo del mockup (ese comportamiento — 2 variantes de pill fijas, sin importar la marca — está explícito en el propio CSS del mockup, no es una inconsistencia mía).

### Tarea 3 — Lista de conexiones

Fila rediseñada: `ProviderBadge` + `.connection-main` (nombre + `MethodPill` inline en `.connection-name-row`, subtítulo con `providerConnectionSubtitle()`) + acciones existentes intactas (`toggleProvider`/`deleteProvider`, mismos handlers, sin tocar su lógica). `.connection` pasó de grid `1fr auto auto` a `auto 1fr auto auto` (columna nueva para la insignia) — actualizado en la regla base Y en el bloque de overrides `!important` más abajo en el archivo (encontrado con `grep`, no se asumió que solo había una definición).

**Bug real encontrado y corregido durante la implementación**: el override `.connection-main span { color/font-size/font-weight !important }` (selector descendiente, sin combinador `>`) matcheaba CUALQUIER `span` anidado — con la pill ahora viviendo dentro de `.connection-name-row` (un `span` hijo de `.connection-main`), ese `!important` se filtraba hasta la pill y le pisaba su propio color/tamaño. Corregido acotando el selector a `.connection-main > span` (hijo directo) — sigue aplicando igual al span de nombre (que sigue siendo hijo directo), deja de alcanzar la pill anidada. Confirmado leyendo la cascada real, no asumido.

### Tarea 4 — Selector de modelo, acordeón real

`expandedProviderId: string | null` (nuevo estado, junto a `modelMenuOpen` existente) — un solo id nullable, no un `Set`: expandir un grupo simplemente REEMPLAZA el valor (`current => current === id ? null : id`), lo que garantiza "un solo grupo abierto a la vez" sin lógica adicional de "cerrar los demás". Al abrir el menú (`model-btn` onClick), se expande por defecto el grupo del proveedor ACTIVO (mismo estado inicial que demuestra el mockup — Anthropic abierto con Claude Opus seleccionado) — decisión propia no explícitamente pedida, pero fiel al comportamiento demostrado. `selectModel()` ahora también resetea `expandedProviderId` a `null` además de `modelMenuOpen` a `false` — cierre COMPLETO del menú al elegir un modelo, no solo el grupo, igual que `pick()` en el mockup.

Proveedores con 0 modelos habilitados se omiten del acordeón (`enabledModels.length === 0` → `return null`) — decisión propia: un grupo expandible sin nada adentro no tiene sentido en un acordeón (el `model-menu` viejo sí los mostraba, con un header sin botones debajo).

### Tarea 5 — Botón AGENTS.md fuera del topbar

Localizado por su `title`/`onClick` (`openAgentsMd()`), no por posición — confirmado con `grep` que era 1 de los 5 `topbar-btn` reales. Eliminado el `<button>`; `.mcp.json` (el otro botón adyacente) intacto. `openAgentsMd()` (la función wrapper en `App.tsx`) se dejó **sin borrar** — sin otro call site tras este cambio, pero borrarla no fue pedido explícitamente y la restricción de la fase es no tocar "funcionalidad" de AGENTS.md — se prefirió dejar el mínimo cambio posible (el archivo no tiene `noUnusedLocals` activado, así que no rompe `tsc`). `agents-md.ts`/`ipc-agents-md.ts` (proceso main) sin tocar, confirmado.

### Verificación (Tarea 6, por lectura — sin forma de correr la UI desde este entorno)

- **Acordeón**: `expandedProviderId` es un único valor nullable (no colección) → invariante "un solo grupo abierto" estructuralmente garantizado, no dependiente de recordar cerrar los demás en cada handler. `selectModel()` limpia `modelMenuOpen` Y `expandedProviderId` — cierre completo confirmado por lectura del código, no solo del grupo.
- **Colores/iniciales**: los 7 `ProviderType` reales (`grep` contra `shared/types.ts`) están cubiertos por el `switch` de `providerIdentity()` — `anthropic`/`openai-codex`/`openai`/`google`/`foundry`/`openai-compatible`(default)/`openrouter` — más el caso especial DeepSeek chequeado antes que el switch. Todos los 6 colores de marca con nombre (`anthropic`, `openai`, `google`, `deepseek`, `foundry`, `openrouter`) copiados con el valor hex/rgba EXACTO del mockup aprobado.

`npm run typecheck` y `npm run build`: en verde.

## Desacople de identidad de chat / workspace (Fase 21.5)

Bug real confirmado: `openProject()` usaba `id: project.path` como identificador del chat, con dedup `current.some(chat => chat.id === project.path)` — estructuralmente imposible tener 2 chats distintos en el mismo proyecto. Motivado por Fase 22 (sesiones concurrentes), pero es una corrección de modelo de datos independiente.

### Tarea 0 — mapeo de impacto real (mucho más chico de lo temido)

Investigado ANTES de tocar código. `chat-store.ts` (SQLite), `ipc-agent.ts` (`agent:connect`/`agent:send`) y `runtime-state.ts` (`sendAgentEvent`) están **ya completamente desacoplados** — `chat_id`/`chatId` se trata como TEXT/string opaco en absolutamente todos los usos, `workspace_path`/`activeWorkspace` son columnas/globals SEPARADOS desde el diseño original. Confirmado con `grep` que `existsSync`/`realpathSync`/`path.resolve` no aparecen ni una vez sobre un valor de `chatId` en toda la capa de persistencia — cero validación de formato de path sobre el id, en ningún punto.

El bug real vivía **solo en `openProject()`** (`App.tsx`). Un segundo sitio pareció sospechoso en la investigación pero resultó ya-correcto: `handleAgentEvent()` tiene una variable local **llamada** `workspace` (nombre engañoso) que en realidad prioriza `event.chatId` antes que `event.workspace` (`asString(event.chatId) || asString(event.workspace) || activeChatIdRef.current`) — funciona hoy y sigue funcionando después del fix. Riesgo residual real pero fuera de esta fase: si `activeChatId` en main fuera `null` en el momento de un evento, cae al 2do fallback (el path real) — inofensivo hoy porque `id === path` en TODOS los chats viejos creados via `openProject()`, deja de serlo con sesiones concurrentes reales (Fase 22). **Anotado en `PENDING.md`, no investigado a fondo ni corregido en esta fase** (alcanzabilidad real sin confirmar).

**Precedente ya correcto encontrado en el mismo archivo**: el botón "+ Nuevo chat" ya hacía `id: crypto.randomUUID()` con `workspacePath` como campo aparte, sin dedup por path — prueba de que el modelo correcto ya funcionaba en este archivo, `openProject()` era la única excepción real.

**Pregunta que la Tarea 0 dejó abierta, respondida con evidencia**: no existe ninguna mecánica separada de "volver al último chat del proyecto" en otro lado — el dedup-por-path de `openProject()` ERA el único mecanismo de reutilización, y funcionaba por coincidencia de `id === path`, no por diseño. Confirmado con el usuario antes de implementar: reemplazarlo por "el chat más reciente real" (`updatedAt`), no eliminarlo sin sustituto.

### Implementación

- **`ChatSession.updatedAt?: string`** (nuevo campo, renderer) — mismo valor real que ya persiste `chat-store.ts` (`updated_at`), no una aproximación por orden de array. `loadChatSnapshot()` YA hacía `ORDER BY updated_at DESC` (dato existente, antes descartado al restaurar en `bootstrap()` — ahora se conserva). `ensureStoredChat()` (llamada en cada turno vía `sendMessage`) ahora también bumpea `updatedAt` en el estado LOCAL de `chatSessions`, no solo en SQLite — así "el más reciente" queda preciso durante la sesión en vivo, sin depender de un reinicio de la app para reflejar actividad reciente.
- **`switchToProject(project)`** — helper compartido: abre el workspace, actualiza `activeProject`/`settings.activeProjectPath`/estado de conexión. No toca `activeChatId`/`chatSessions` — eso lo decide cada llamador.
- **`createProjectChat(project)`** — helper compartido: arma un `ChatSession` con `id: crypto.randomUUID()` (mismo patrón que "+ Nuevo chat"), `workspacePath`/`workspaceName` heredados del proyecto, lo registra en estado y lo persiste. Reusado por ambos flujos de abajo — el shape de creación vive en un solo lugar.
- **`openProject(project)`** (clic normal en PROYECTOS) — busca `chatSessions.filter(chat => chat.workspacePath === project.path).sort(by updatedAt desc)[0]`; si existe, `setActiveChatId()` a ese; si no, `createProjectChat()`. `void disconnect()` agregado al final — **necesario, no cosmético**: `workspace:open` (main) ya dispara su propio `disconnectAgent()` interno cuando el PATH cambia (`ipc-projects-workspace.ts`, confirmado leyendo el código), pero eso NO cubre el caso que este mismo fix hace alcanzable por primera vez — volver a un chat existente cuyo `workspacePath` es el MISMO que el ya conectado (dos chats hermanos del mismo proyecto): ahí el path no cambia, pero el chat activo sí.
- **`newProjectSession(project)`** (Tarea 2, acción nueva) — mismo `switchToProject()`, pero llama `createProjectChat()` **siempre**, nunca busca uno existente.

### Tarea 2 — forma de la acción nueva (a criterio propio, documentado)

Botón "+" (`.project-new-session`) inline junto a cada fila de PROYECTOS (root y subcarpeta) — **no** un item de menú contextual nuevo. Confirmado antes de elegir: `ContextMenuState.type` hoy solo cubre `'chat'`/`'message'`, no existía ya un menú contextual para filas de PROYECTOS que extender — agregar un botón inline fue más chico de implementar y más descubrible (no depende de que el usuario sepa que el click derecho existe) que crear un tipo de menú nuevo solo para esto.

### Verificación real (no solo lectura)

Contra `chat-store.ts` REAL (bundle esbuild standalone, SQLite real vía `node:sqlite`, `app-paths.ts` **stubbeado a un directorio de scratchpad** — nunca tocó `D:\AMATISTA\data`, la base de producción real) — secuencia real: chat A creado (con 1 mensaje real) → chat B creado (mismo `workspacePath`, simulando la acción "+") → confirmado que `loadChatSnapshot()` real devuelve a B como el más reciente (`updatedAt` real comparado) → chat C creado (un tercero) → confirmado: **3 ids distintos, mensaje de A intacto, mensaje de B intacto, C vacío (recién creado)**. Resultado real: `OK -- TODO CONFIRMADO`.

`npm run typecheck` y `npm run build` (Fase 21.5): en verde.

## Infraestructura real de multi-ventana (Fase 22a)

Primera fase de Fase 22 (sesiones concurrentes) que toca código — precedida por `docs/_arch/verify_fase22_scope.md` (Tarea 0, investigación pura). Alcance **deliberadamente acotado**: esta fase hace que dos `BrowserWindow` reales puedan existir, registrarse, y que los eventos se puedan dirigir a la correcta — **no** aísla la conexión de runtime por ventana (`agent:connect` sigue matando la conexión anterior incondicionalmente) ni toca ninguna de las 9 variables singulares de `runtime-state.ts` (`codexClient`/`cliRuntime`/`apiRuntime`/`mcpManager`/`lspManager`/`activeRuntime`/`activeWorkspace`/`activeThreadId`/`activeChatId`). Eso es Fase 22b.

### Tarea 1 — registro real de ventanas

`mainWindow: BrowserWindow | null` (una variable `let` simple, pisada por `setMainWindow()` cada vez) reemplazado por `windowRegistry: Map<number, {window: BrowserWindow, chatId: string | null}>` (`runtime-state.ts`), indexado por `BrowserWindow.id` real — nunca un id inventado. `registerWindow(window, chatId?)` arma la entrada Y su propia limpieza automática (`window.on('closed', () => windowRegistry.delete(window.id))`) en el mismo lugar — ningún caller tiene que acordarse de desregistrar a mano. `chatId` en el registro es **solo** un dato asociado a la ventana (qué chat está mostrando), no implica aislamiento de conexión.

**Efecto colateral necesario, no un "arreglo" de 22b**: el `mainWindow.on('closed', ...)` viejo llamaba `disconnectAgent()` incondicionalmente — correcto con una sola ventana posible (cerrarla SIEMPRE significaba "no queda ninguna"), pero con el registro real cerrar una ventana secundaria mataría la conexión compartida de la que se queda abierta. `app.on('window-all-closed')` (`index.ts`) ya cubre el caso real "no queda ninguna ventana" — el handler por-ventana, en el mundo de 1 sola ventana, era estrictamente redundante con ese. Ahora (`window-manager.ts`) solo dispara `disconnectAgent()` si `windowRegistry.size === 0` tras la baja — mismo resultado exacto que antes en el caso de 1 ventana, sin el efecto colateral nuevo en el caso de N. Esto es una adaptación mecánica de la bookkeeping existente a N ventanas, no una resolución del problema real de conexión-compartida (que sigue sin resolver, Fase 22b).

### Tarea 2 — "Abrir en ventana nueva"

Canal `window:openInNewWindow` (`ipc-window.ts`) → `createAppWindow({chatId})` (nuevo `src/main/window-manager.ts`, factorizado fuera de `index.ts` para que `ipc-window.ts` pueda invocarlo sin import circular con el entrypoint). Botón "Abrir en ventana nueva" en el menú contextual de cada fila de chat (`App.tsx`).

**Mecanismo elegido para pasarle "qué chat mostrar" a la ventana nueva, investigado antes de asumir**: query string (`?chatId=...`) sobre la URL/archivo que la ventana carga — `window.loadURL(`${rendererUrl}?chatId=...`)` en dev (servidor de electron-vite) y `window.loadFile(path, {query: {chatId}})` en producción (Electron soporta `query` nativo en `loadFile`). Se prefirió sobre `webPreferences.additionalArguments` (el otro mecanismo estándar de Electron para pasar datos de arranque, vía `process.argv` en preload) porque no requiere plumbing adicional en preload/contextBridge — el renderer lo lee directo con `new URLSearchParams(window.location.search)`, sin tocar la superficie IPC expuesta. Funciona **idéntico** en dev y producción sin ninguna rama por entorno — la única diferencia entre ambos caminos (`loadURL` vs `loadFile`) ya existía de antes por el propio arranque de electron-vite, el query string se agrega igual a los dos.

Renderer: `BOOT_CHAT_ID = new URLSearchParams(window.location.search).get('chatId')` (leído una vez al cargar el módulo). `bootstrap()` lo usa para decidir el chat activo inicial de ESA ventana: si `BOOT_CHAT_ID` existe entre los chats reales restaurados, la ventana arranca mostrando ese; si no vino, o vino uno que ya no existe (borrado entre que se abrió la ventana y que terminó de cargar), cae al comportamiento de siempre (el chat más reciente global) — sin lanzar.

**Los dos caminos verificados por separado con evidencia real, no solo uno** (la primera pasada de Tarea 5 solo había ejercido producción sin darse cuenta — corregido antes de cerrar la fase):
- **Producción** (`loadFile`): `npx electron out/main/index.js` (sin `ELECTRON_RENDERER_URL`) — CDP confirmó la ventana nueva mostrando el chat real pedido (sidebar con "Chat nuevo" activo, no el más reciente global).
- **Dev** (`loadURL`, servidor de electron-vite): `npx electron-vite dev --remoteDebuggingPort 9334` (sí setea `ELECTRON_RENDERER_URL=http://localhost:5173`). CDP contra la ventana 2 real, evaluado DESDE ADENTRO de esa ventana: `window.location.href` → `http://localhost:5173/?chatId=fase22a-dev-boot-test-9f3c2a`, `window.location.search` → `"?chatId=fase22a-dev-boot-test-9f3c2a"`, `new URLSearchParams(window.location.search).get('chatId')` → `"fase22a-dev-boot-test-9f3c2a"` (coincide exacto con el id de prueba pedido a `openInNewWindow()`). Confirma que `loadURL` con query string apendeado sí llega intacto al dev server de Vite, sin 404 ni reescritura de ruta.

### Tarea 3 — `event.sender` como identificador de origen

`agent:connect`/`agent:send`/`agent:cancel` (`ipc-agent.ts`) resuelven la ventana llamante vía `BrowserWindow.fromWebContents(event.sender)?.id` (helper `originWindowId()`) — dato que Electron ya provee gratis en cada handler IPC, no requirió ningún cambio de payload del lado renderer.

**Qué se guardó y dónde, para que Fase 22b lo consuma sin repetir este trabajo**: `activeConnectionWindowId: number | null` (nuevo, `runtime-state.ts`, junto a `setActiveConnectionWindowId()`) — seteado en `agent:connect` (después de su propio `disconnectAgent()` inicial, antes de cualquier await), reseteado a `null` dentro de `disconnectAgent()` mismo (no una de las 9 variables protegidas — es nueva de esta fase). Hoy es **puramente informativo**: `agent:send` compara el `event.sender` de la llamada contra `activeConnectionWindowId` y solo *loguea* un mismatch (gateado por `AMATISTA_DEBUG_TOOLS=1`, mismo patrón que el resto de logs verbosos del archivo) — no rechaza ni bloquea nada todavía. Fase 22b es quien va a usar esta misma comparación para empezar a **rechazar** (no solo rutear/loguear) llamadas que no vengan de la ventana dueña de la conexión.

`ipc-window.ts` (`window:getFullscreen`/`window:setFullscreen`) migrado al mismo mecanismo (`windowFromEvent()`) — necesario porque `mainWindow` ya no existe como variable, y además una mejora real: antes ambos canales operaban siempre sobre la única ventana que hubiera existido; ahora cada ventana controla/consulta su propio fullscreen.

### Tarea 4 — ruteo de eventos

`sendToRenderer(channel, payload, windowId?)` y `sendAgentEvent(payload, windowId?)` (`runtime-state.ts`) aceptan un `windowId` opcional. Sin él: cae a `activeConnectionWindowId` si esa ventana sigue en el registro y usable (`sendToWindow()`); si no hay conexión conocida o su ventana ya cerró, hace `broadcastToAllWindows()` — **fallback temporal**, documentado en el propio código: con una sola conexión compartida (22b sin resolver), es la única heurística razonable hoy. `sendToWindow(windowId, channel, payload)` manda a una ventana puntual del registro (`false` sin lanzar si no existe/no es usable). Logs de ruteo (`"<channel>" -> ventana N (dirigido)` / `-> broadcast a N ventana(s)`) gateados por `AMATISTA_DEBUG_TOOLS=1` — logs de ciclo de vida del registro (`ventana N registrada/cerrada`) van siempre, sin gate (eventos raros, alto valor, mismo criterio que otros logs de error siempre-on del archivo).

### Tarea 5 — verificación real

App real levantada (`npx electron --remote-debugging-port=9333 out/main/index.js`, `AMATISTA_DEBUG_TOOLS=1`, contra `D:\AMATISTA\data` de producción — sin enviar mensajes ni tocar datos reales, solo abrir/cerrar ventanas) más un driver Node (`WebSocket` nativo de Node 24, sin dependencias nuevas) hablando Chrome DevTools Protocol directo contra cada ventana renderer. Confirmado con datos reales, no "debería funcionar":

- `openInNewWindow()` real crea una `BrowserWindow` con `id` real distinto (1 y 2), confirmado tanto por CDP (`/json/list` pasa de 1 a 2 "page" targets) como por el log del proceso main (`ventana 2 registrada ... total abiertas: 2`).
- Un evento dirigido explícitamente a la ventana 1 llega SOLO a la 1 — capturado con un listener propio instalado vía CDP en cada ventana (`window.universalAgent.onAgentEvent(...)`, en paralelo al listener real de la app), confirmado dos veces (dirigido a 1, después a 2) sin fuga cruzada. Log del main corrobora: `"agent:event" -> ventana 1 (dirigido)` / `-> ventana 2 (dirigido)`.
- Cerrar la ventana 2 (`window.close()` real vía CDP) la saca del registro (`ventana 2 cerrada y desregistrada -- quedan 1`) sin afectar a la 1, que sigue respondiendo (`document.title` consultado post-cierre).

Scaffold usado para la verificación (canal IPC `debug:testEvent` + `debugTestEvent` en preload, para poder disparar eventos sintéticos dirigidos desde fuera de la UI) **retirado antes de cerrar la fase** — no es parte del entregable, no queda en el árbol.

`npm run typecheck` y `npm run build`: en verde (antes Y después de retirar el scaffold de verificación).

## Concurrencia real de conexión, indexada por ventana (Fase 22b)

Segundo paso de Fase 22 (sesiones concurrentes), sobre la infraestructura de ventana de 22a. Alcance deliberadamente acotado a **conexión/turno** — los 13 `disconnect()` de `App.tsx` por cambios de Settings quedan para Fase 22c (ver PENDING.md), igual que la staleness de `write_file`/`apply_patch` entre sesiones.

### Tarea 0 — investigación previa (confirmada con código real)

`wireCodex(client)`, `wireCli(runtime)`, `wireApi(runtime)` (`runtime-state.ts`, antes de esta fase) recibían **solo la instancia** del runtime/client — cero parámetros de contexto (ni workspace, ni chatId, ni windowId), y no leían ninguna variable global directamente: cada una era un simple `.on(evento, msg => sendAgentEvent({...}))`, era `sendAgentEvent()` quien leía `activeWorkspace`/`activeChatId` globales al momento de mandar. Agregarles `windowId` fue aditivo puro, sin romper nada interno.

**Hallazgo que amplió el alcance real más allá de lo previsto originalmente**: `activeWorkspace`/`disconnectAgent()` (las variables/función que esta fase reemplaza) no solo las usaba `ipc-agent.ts` — otros 6 archivos las importaban directo: `ipc-projects-workspace.ts` (`workspace:open`/`projects:removeRoot`, comparten el mismo guard de carrera de Fase 12 que `agent:connect`), `ipc-agents-md.ts` y `ipc-mcp.ts` (leen `activeWorkspace` para status de AGENTS.md/.mcp.json, sin ningún parámetro de sesión en su firma), `ipc-cli.ts` (`codex:logout`), `ipc-settings.ts` (`settings:resetLocalState`) e `index.ts` (`window-all-closed`). Confirmado con el usuario antes de tocar código (ver AskUserQuestion en la conversación): se migran los 6 también, mismo patrón mecánico (`event.sender` → `windowId` → `getSession(windowId)`), no una clasificación nueva de "a quién afecta cada cosa" (eso sigue siendo Fase 22c).

### Tarea 1 — `SessionRuntimeState` + `sessionRegistry` + `getSession()`/`disconnectSession()`

`runtime-state.ts`: las 9 variables singulares identificadas en Fase 22 Tarea 0 (`codexClient`/`cliRuntime`/`apiRuntime`/`mcpManager`/`lspManager`/`activeRuntime`/`activeWorkspace`/`activeThreadId`/`activeChatId`) más `activeContextSeeded`/`currentTurnAbort`/`isDisconnecting`/`toolTrustSession` (ya estaban en la lista del usuario) pasan a vivir en `SessionRuntimeState`, una instancia por `BrowserWindow.id` en `sessionRegistry: Map<number, SessionRuntimeState>` — misma clave que `windowRegistry` de Fase 22a, no un id nuevo, pero un Map **distinto** (`windowRegistry` vive mientras la ventana existe aunque nunca haya conectado nada; `sessionRegistry` solo tiene entrada para ventanas que llamaron `getSession()` al menos una vez).

**Campo agregado, no estaba en la lista original del usuario**: `pendingToolApprovals: Map<string, (approved: boolean) => void>`. Los ids de aprobación pendiente ya son `randomUUID` (sin colisión entre sesiones aunque el Map fuera global), pero el RUTEO del evento `agent:toolApproval` hacia la ventana correcta sí depende de saber a qué sesión pertenece cada aprobación pendiente — mismo motivo por el que `toolTrustSession` (que sí estaba en la lista) tiene que ser por sesión. Se justifica y se documenta en el propio código (`runtime-state.ts`), no se agregó en silencio.

`getSession(windowId)`: nunca devuelve `null`, crea una entrada vacía (`createEmptySession()`) si no existía — mismo criterio pedido por el usuario. `disconnectSession(windowId)`: hace exactamente lo que hacía `disconnectAgent()` (abort del turno en vuelo, remover listeners, parar cada runtime/manager, resolver aprobaciones pendientes como rechazadas, apagar tool-trust) pero acotado a UNA sola entrada del registro — el guard `isDisconnecting` (Fase original) también pasó a ser por sesión.

`activeConnectionWindowId` (Fase 22a) se **eliminó por completo** — era la pieza "singular a propósito" que 22a dejó explícita para que 22b la reemplazara: con sesiones reales indexadas, cada evento ya sabe su propio `windowId` desde el closure de conexión, no hace falta ningún dato intermedio de "a quién pertenece la conexión actual".

### Tarea 2 — wiring en `ipc-agent.ts`

`agent:connect`/`agent:send`/`agent:cancel`/`agent:reply`/`agent:toolApproval:respond`/`agent:toolTrust:disable`/`agent:disconnect` resuelven `windowId = originWindowId(event)` (vía `BrowserWindow.fromWebContents(event.sender)`) **primero**, y operan sobre `getSession(windowId)` — nunca sobre una variable compartida. `agent:connect` ahora llama `disconnectSession(windowId)` (antes `disconnectAgent()` incondicional) — conectar desde la ventana B ya **no mata** la conexión de la ventana A. El guard de carrera de Fase 12 (`assertWorkspaceStillActive`, ahora `assertSessionWorkspaceStillActive`) compara contra `getSession(windowId).activeWorkspace` en vez de la global.

Los callbacks `confirm`/`mcpConfirm` que se pasan a `toolRegistry.execute()`/`runtime.configure()` (contratos externos, no tocados) se cierran sobre `windowId` capturado en el momento de conectar: `(title, detail) => requestSessionToolApproval(windowId, title, detail)` — el diálogo de aprobación se dirige a la ventana dueña de esa conexión, no a un destino global.

### Tarea 3 — ruteo de eventos por sesión

`sendAgentEvent()` (Fase 22a, con fallback a broadcast) se reemplaza por `sendSessionEvent(windowId, payload)` (Fase 22b) — `windowId` es **obligatorio**, no opcional: con sesiones reales, quien llama siempre sabe de qué sesión es el evento (lo capturó vía `event.sender`, o lo tiene en el closure de `wireApi`/`wireCli`/`wireCodex`), así que el fallback a broadcast de 22a (documentado ahí mismo como temporal, "para cuando no se sabe a cuál ventana corresponde") ya no aplica — era exactamente el hueco que esta fase venía a cerrar. `wireCodex(windowId, client)`/`wireCli(windowId, runtime)`/`wireApi(windowId, runtime)` capturan `windowId` en su firma y lo usan en cada `sendSessionEvent(windowId, ...)`.

### Migración de los 6 archivos periféricos (confirmado con el usuario, ver Tarea 0)

- **`ipc-projects-workspace.ts`**: `workspace:open`/`workspace:refresh`/`workspace:readFile`/`workspace:saveFile` resuelven `windowId` y operan sobre `getSession(windowId).activeWorkspace` — cada ventana tiene su propio workspace activo real. `projects:removeRoot` sigue siendo una acción global (afecta la lista de proyectos de TODA la app): se generaliza el MISMO chequeo que ya existía (`activeWorkspace.startsWith(root.path)`) iterando `sessionRegistry` — desconecta y limpia el workspace de TODAS las sesiones afectadas, no solo la que disparó la acción. No es clasificación nueva de "a quién debería afectar" (eso es Fase 22c) — es la condición de siempre, generalizada de 1 sesión a N.
- **`ipc-agents-md.ts`/`ipc-mcp.ts`**: mismo patrón — resuelven la ventana llamante vía `event.sender` y leen `getSession(windowId).activeWorkspace` en vez de la global.
- **`ipc-cli.ts`** (`codex:logout`) / **`ipc-settings.ts`** (`settings:resetLocalState`): estas dos acciones no tenían ninguna noción de "de qué ventana vinieron" ni antes ni ahora — en el mundo de una sola conexión, dispararlas SIEMPRE mataba "todo lo que hubiera" (una cuenta compartida a nivel SO en el caso de logout, ver `verify_fase22_scope.md` Parte A.1 categoría (b); un reset total en el caso de resetLocalState). Se generalizan fielmente a `disconnectAllSessions()` (nueva, itera `sessionRegistry` y llama `disconnectSession()` en cada una) — mismo resultado que antes escalado a N sesiones, no una decisión nueva de alcance.
- **`index.ts`** (`window-all-closed`): mismo `disconnectAllSessions()`. **`window-manager.ts`** (`window.on('closed', ...)`): con sesiones reales por ventana, cerrar la ventana N ahora solo puede afectar la sesión de la ventana N misma — pasa de un disconnect defensivo condicionado ("solo si era la última ventana viva", Fase 22a) a `disconnectSession(window.id)` directo, sin condición.

### Verificación

`npm run typecheck` y `npm run build`: en verde. Verificación con app real corriendo (2 `BrowserWindow` reales, conexiones independientes simultáneas) **no realizada todavía en esta ronda** — queda como próximo paso si se prioriza antes de cerrar la fase del todo.

## Fix: sesión conectada deja de depender de `settings.providers` global (Fase 22c)

Primera fase de Fase 22c (config-driven `disconnect()` de Settings). Corrige un bug real encontrado durante la investigación previa de esta misma sub-fase, no una decisión de diseño: con una sesión ya conectada, si **otra ventana** borraba o deshabilitaba ese `providerId`/`modelId` en `settings.providers` (config genuinamente global, confirmado en Fase 22 Tarea 0 Parte B), el **próximo** `agent:send` de la sesión ya conectada tiraba `"Modelo/proveedor no disponible."` — pese a que el runtime ya conectado (`apiRuntime`/`cliRuntime`/`codexClient`) nunca vuelve a mirar `settings` por su cuenta una vez configurado.

### Mecanismo real confirmado antes de tocar código (investigación previa)

`agent:send` ([ipc-agent.ts](../../src/main/ipc-agent.ts)) hacía un lookup fresco contra `settings.providers.find(...)` **en cada turno**, antes de tocar cualquier runtime — ese guard, no el runtime, era el único punto de falla real. Confirmado con grep que `api-agent-runtime.ts`/`cli-agent-runtime.ts`/`codex-client.ts` no tienen ninguna referencia real a `settings` — son completamente autosuficientes una vez conectados. Confirmado también que `provider`/`model` (los objetos resueltos por ese lookup) se usaban en 3 lugares reales más abajo en la función, no solo en el guard: `buildRuntimeContext()` (`providerName`/`modelName`/`model.runtime` del envelope), la rama Codex (`model.model` pasado directo a `sendTurn()`), y `maybeCompactChatInBackground()` (`fallbackProvider`/`fallbackModel` para compactación en background sin modelo configurado explícito, ver `compaction-engine.ts:62`).

### Fix

`SessionRuntimeState` (`runtime-state.ts`) gana `provider: ProviderProfile | null` / `model: ModelProfile | null` — los objetos completos, no solo ids. `agent:connect` los resuelve y valida contra `settings.providers` **una sola vez, al conectar** (ahí sigue siendo correcto validar — no se puede conectar de cero a algo que ya no existe) y los guarda en la sesión. `agent:send` pasa a preferir `session.provider ?? settings.providers.find(...)` / `session.model ?? provider?.models.find(...)` — con una sesión ya conectada, el fallback nunca se ejecuta; el `settings.providers.find(...)` original queda solo como red de seguridad defensiva para el caso (no debería ocurrir) de una sesión con `activeRuntime` seteado pero sin `provider`/`model` guardado. Los 3 usos reales de `provider`/`model` más abajo en `agent:send` (`buildRuntimeContext`, rama Codex, `maybeCompactChatInBackground`) **no cambiaron de forma** — solo cambió de dónde sale el objeto. `disconnectSession()` resetea `session.provider`/`session.model` a `null` junto con el resto de los campos de conexión en su bloque `finally`.

**No se agregó ningún mecanismo de detección/aviso a sesiones afectadas** — evaluado y descartado explícitamente: con este fix no hay nada que detectar, porque nada se rompe. Una sesión ya conectada sigue funcionando con el `provider`/`model` que tenía al conectarse, sin importar qué pase después en `settings.providers` de otra ventana — exactamente el mismo criterio de aislamiento que ya rige el resto de `SessionRuntimeState` desde Fase 22b.

### Verificación real (mismo escenario que la reproducción del bug, código ya arreglado)

App real levantada, sesión Codex real conectada (suscripción real, `78948662-3454-4910-8076-93015a77876c`/`051c9ea7-...` "GPT-5.4"), provider borrado de verdad de `settings.providers` (confirmado `contiene el borrado? false`), segundo `agent:send` sobre la sesión ya conectada:

- **Antes del fix** (Tarea 0 de esta sub-fase): `{"error":"...Error: Modelo/proveedor no disponible."}`
- **Después del fix** (esta verificación): `{"success":true}`

`settings.json` real restaurado exacto al terminar (confirmado leyendo `providers` de vuelta, los 10 originales completos). App cerrada, `tasklist` confirma cero `electron.exe` colgado.

`npm run typecheck` y `npm run build`: en verde.

## Mensajería entre ventanas — Paso 1: `WindowEntry.chatId` deja de ser código muerto

Primer paso de implementación de la mensajería entre ventanas — corrige una pieza de datos puntual identificada en la investigación previa (Tarea 0, resumen completo en `docs/_arch/PENDING.md`). `WindowEntry.chatId` (Fase 22a) se seteaba una sola vez al crear la ventana y nunca se volvía a tocar — `setWindowChatId()` existía desde esa misma fase pero, confirmado con grep antes de esta tarea, no se llamaba desde ningún lado del código. Este paso lo pone en uso real.

### Decisión: canal IPC dedicado, no reusar uno existente

Se evaluó sumar el aviso a alguno de los 5 sitios `(c)` de `disconnect()` que cambian `activeChatId` (`openProject`/`newProjectSession`/`deleteChat`/"+ Nuevo chat"/click en fila de chat) — se descartó: `disconnect()` no recibe ningún payload hoy y mezclaría dos responsabilidades no relacionadas (matar una conexión de runtime vs. avisar qué chat se muestra). Se eligió un `useEffect(() => { ... }, [activeChatId])` nuevo en `App.tsx`, junto al que ya sincroniza `activeChatIdRef` — cubre los 5 sitios (y cualquier otro futuro que cambie `activeChatId`) sin tener que tocarlos uno por uno, y React ya garantiza que solo corre cuando el valor realmente cambia (sin debounce manual: `activeChatId` cambia por acción discreta del usuario, no por tecleo).

### Wiring

- **Preload** (`preload/index.ts`/`index.d.ts`): `setActiveChatId(chatId: string | null): Promise<{success: boolean}>` → `ipcRenderer.invoke('window:setActiveChatId', chatId)`.
- **Main** (`ipc-window.ts`): `window:setActiveChatId` resuelve la ventana real vía `event.sender` (mismo patrón `windowFromEvent()` que ya usan `getFullscreen`/`setFullscreen`) y delega a `setWindowChatId(window.id, chatId)` — ya existía, solo faltaba llamarla. Se le agregó un `console.log` (`runtime-state.ts`, siempre-on, mismo criterio que el resto de logs de ciclo de vida del registro de ventanas — evento poco frecuente, alto valor de diagnóstico).
- **Renderer** (`App.tsx`): `useEffect(() => { void window.universalAgent.setActiveChatId(activeChatId) }, [activeChatId])`, al lado del efecto que ya sincroniza `activeChatIdRef.current`.

### Verificación real (CDP, sin mouse/teclado)

Scaffold temporal de solo lectura (`debug:getWindowRegistry`) usado y retirado antes de cerrar la tarea — confirmado con grep, cero rastro. Secuencia real, app real corriendo:

```
Arranque:              chatId = "general-chat" (default inicial)
Bootstrap resuelve:    chatId = "D:\APLICACIONES\YAYOSCHAT" (chat real más reciente)
Cambio 1 (CHAT_A):     chatId = "verify-chat-A-11111111"  ✓
Cambio 2 (CHAT_B):     chatId = "verify-chat-B-22222222"  ✓ (no quedó pegado en A)
Cambio 3 (CHAT_C):     chatId = "verify-chat-C-33333333"  ✓ (no quedó pegado en B)
```

Los primeros dos cambios (`general-chat` → `YAYOSCHAT`) salieron del arranque real de la app, sin intervención del script — ya demostraban el mecanismo funcionando antes de que empezara la prueba dirigida. Los 3 cambios siguientes, disparados directo vía `window.universalAgent.setActiveChatId(...)` (mismo canal que el `useEffect` real dispara), confirman que el registro se actualiza en cada cambio consecutivo, sin quedar congelado en ningún valor intermedio — corroborado en el log del proceso main (`[window-registry] ventana 1 -> chatId actualizado a "..."`, una línea por cada uno de los 5 cambios reales). App cerrada, `tasklist` confirma cero `electron.exe` colgado.

`npm run typecheck` y `npm run build`: en verde, antes y después de retirar el scaffold.

## Mensajería entre ventanas — Paso 2: el motor (turno real en otra ventana + entrega cross-session)

Segundo paso de la mensajería entre ventanas. Corre un turno real en la ventana destino desde el proceso main, y entrega el resultado a la ventana de origen. Todavía **sin** aprobación ni tool `send_to_window` real (eso es Paso 3) — este paso es la plomería de abajo, probada invocándola directo.

### Tarea 1 — `runTurnForWindow()`

`agent:send` (`ipc-agent.ts`) se factorizó: `event` se usaba una sola vez, al principio, solo para resolver `windowId` — confirmado exacto en la investigación previa. Todo el resto de la lógica (resolver `provider`/`model` de la sesión, armar el contexto, despachar a Codex/API/CLI, mandar eventos, compactación fire-and-forget) pasó a `runTurnForWindow(windowId, payload): Promise<RunTurnResult>`, exportada, sin ninguna dependencia de `IpcMainInvokeEvent`. El handler IPC real (`agent:send`) quedó como wrapper delgado: resuelve `windowId` desde `event`, llama a `runTurnForWindow()`.

### Hallazgo real durante la verificación (Tarea 4), no anticipado en el diseño — cambia una pieza real

La primera corrida del motor devolvió `null`: `runTurnForWindow()` para Codex nunca tenía texto que entregar. Diagnosticado con logging temporal contra la app real: `CodexClient.sendTurn()` (`codex-client.ts`) hace `this.request('turn/start', ...)` — un RPC que **resuelve apenas el app-server acepta el turno** (el ack), no cuando el turno termina. El texto real llega después, vía notificaciones (`item/agentMessage/delta`/`turn/completed`) que `wireCodex` ya reenvía a la ventana — confirmado con datos reales: la primera corrida capturó un solo evento (`mcpServer/startupStatus/updated`) antes de que `sendTurn()` ya hubiera resuelto, sin ningún delta.

Esto nunca importó antes de esta tarea: en un chat de una sola ventana, el renderer arma el texto en vivo desde esos mismos eventos vía `handleAgentEvent()`, sin depender jamás del valor de retorno de `agent:send()` para Codex — por eso el código original nunca devolvía texto ahí (confirmado, no es un bug pre-existente, es coherente con cómo se usaba antes). `runTurnForWindow()` sí necesita el texto final de forma sincrónica para la entrega cross-window — así que la rama Codex pasa a esperar de verdad `turn/completed`/`turn/cancelled` (acumulando deltas mientras tanto vía un listener temporal sobre `session.codexClient`, sin alterar el reenvío normal de `wireCodex`), con un timeout defensivo de 120s por si el turno nunca completa. **Efecto colateral real, no oculto**: como `agent:send` real ahora usa la misma `runTurnForWindow()`, un chat de una sola ventana usando Codex también espera la promesa de `agent:send()` hasta el turno completo, no solo el ack — confirmado de bajo riesgo (`sendPrompt()` en App.tsx no hace nada crítico gateado en esa resolución además de manejo de errores; `clearTurnWatch()`/UI de progreso ya dependen enteramente de los eventos, no de esta promesa) y, de hecho, hace que las 3 ramas (codex/API/CLI) se comporten consistentes por primera vez — antes solo 2 de 3 esperaban el turno completo.

### Tarea 2 — `deliverResultToOriginWindow()`

Nuevo módulo `src/main/cross-window-messaging.ts` (no `runtime-state.ts` — separa la orquestación cross-sesión del estado de sesión en sí). Persiste el resultado como mensaje real (`saveChatMessage()`, `chat-store.ts` — confirmado invocable directo desde main sin pasar por IPC) en el chat de la ventana de **origen**, con el `providerId`/`modelId`/`runtime` reales de quien lo generó, y notifica a esa ventana vía un canal nuevo.

**Canal elegido, investigado antes de decidir**: `chat:incomingMessage`, deliberadamente separado de `agent:event`. `handleAgentEvent()` (App.tsx) está armado enteramente alrededor de "esto es MI turno en curso" — arranca/actualiza `turnActive`, acumula deltas por `itemId`, cierra el watchdog en `turn/completed`, decide `agentState` según el tipo de evento. Forzar un mensaje ya-completo por ese canal significaría fingir un ciclo de vida entero de turno (`turn/started`, deltas falsos, `turn/completed`) para un mensaje que en esa ventana nunca corrió ningún turno propio — riesgo real de pisar el estado de un turno genuino que esa ventana ya tenga en vuelo. Canal separado, payload mínimo: el `StoredChatMessage` ya persistido tal cual, sin reconstrucción del lado renderer (eso es Paso 3).

### Tarea 3 — `sendMessageToWindow()`

El motor completo: dispara `runTurnForWindow()` contra la ventana destino, y si vuelve con texto real, lo entrega a la ventana de origen vía Tarea 2. Sin texto (turno cancelado sin texto parcial, por ejemplo) no entrega nada. Sin aprobación, sin tool — se prueba invocándolo directo (Tarea 4).

### Verificación real (Tarea 4)

Scaffold temporal (`debug:getMyWindowId`, `debug:sendMessageToWindow` + contrapartes en preload) usado y retirado, confirmado con grep sin rastro. Secuencia real:

- 2 `BrowserWindow` reales. Ventana B conectada a **Codex real** (suscripción real, `gpt-5.4`) — elegido a propósito para ejercer también el fix nuevo de espera de `turn/completed`.
- Motor disparado desde la ventana A (origen, chat real `YAYOSCHAT`) contra la ventana B (destino), mensaje real: *"respondeme únicamente con la frase: MOTOR-CROSS-WINDOW-OK"*.
- Resultado real, texto real del modelo: `{"text":"MOTOR-CROSS-WINDOW-OK", "providerId":"...", "runtime":"codex", ...}`.
- Ventana A recibió el evento `chat:incomingMessage` con el mismo mensaje exacto (mismo `id`).
- Persistencia confirmada leyendo la base de vuelta (`loadChats()`, no memoria): el mensaje real aparece en `messages[YAYOSCHAT]`, texto idéntico al devuelto por el motor.
- Limpieza: mensaje de prueba borrado del chat real al terminar (`deleteChatMessagesFrom`) — 156 mensajes antes, 155 después, de vuelta al estado original.

App cerrada, `tasklist` confirma cero `electron.exe` colgado.

`npm run typecheck` y `npm run build`: en verde, antes y después de retirar el scaffold.

## Mensajería entre ventanas — Paso 3: tool `send_to_window`, auto-open/auto-connect, aprobación siempre-on, distinción visual

> Cierra la mensajería entre ventanas (Pasos 1-3). Diseño confirmado con el usuario tras 3 rondas de investigación previa (destino = TÍTULO del chat, resolución título→chatId→windowId, auto-conectar solo si es viable, aprobación siempre-on, distinción visual con `PROVIDER_BRAND`).

**Tarea 1 — `connectSessionForWindow(windowId, payload)`** (`ipc-agent.ts`): factorizada de `agent:connect`, mismo criterio exacto que `runTurnForWindow()` de Paso 2 — confirmado por lectura (no asumido) que `event` se usaba UNA sola vez en todo el handler original (`originWindowId(event)`, la primera línea), el resto de las ~180 líneas opera solo sobre `windowId` + `payload` + el estado de módulo `settings`. El handler IPC real (`ipcMain.handle('agent:connect', ...)`) queda como wrapper delgado, mismo patrón que `agent:send`/`runTurnForWindow`.

**Tarea 2 — resolución de destino, con auto-open:**
- `findChatSessionByTitle(title)` (`chat-store.ts`, nueva): `SELECT id, provider_id, model_id FROM chat_sessions WHERE title = ? COLLATE NOCASE ORDER BY updated_at DESC LIMIT 1`. `title` no tiene constraint `UNIQUE` (confirmado en la investigación previa) — con duplicados, se resuelve al MÁS RECIENTE **sin avisar**, por decisión explícita del usuario: es el comportamiento natural de la query, no lógica extra agregada para desambiguar. `COLLATE NOCASE` = case-insensitive razonable para ASCII (caveat ya documentado: SQLite sin extensión ICU no pliega acentos).
- `resolveWindowForChatTitle(title)` (`cross-window-messaging.ts`, privada): busca en `windowRegistry` (Fase 22a) un `WindowEntry.chatId` que matchee el chatId resuelto; si ninguna ventana lo muestra, abre una nueva vía `createAppWindow({chatId})` — el MISMO mecanismo real que ya usa el botón "Abrir en ventana nueva", sin un segundo camino de creación de ventanas.

**Tareas 1+2 combinadas — `sendToWindowByTitle(params)`** (`cross-window-messaging.ts`, exportada): la orquestación completa que la tool necesita DESPUÉS de que ya se aprobó el envío (nunca vuelve a pedir aprobación). Guard de auto-conexión, el corazón del diseño de la ronda de investigación previa: si la sesión destino no tiene `activeRuntime`, **auto-conecta SOLO si `chat_sessions.provider_id`/`model_id` de ese chat no son `NULL`** (ese chat ya tuvo al menos un turno real — esos dos campos se backfillean en CADA turno vía `ensureStoredChat()`, `App.tsx`, con `COALESCE` preservando el último valor real, confirmado en la investigación previa contra datos de producción reales). Si son `NULL`, devuelve un error claro (`"El chat "X" nunca se uso... abrilo y conectalo vos primero"`) — **nunca adivina** un provider/model por default, decisión explícita del usuario. Con auto-conexión viable, llama a `connectSessionForWindow()` (Tarea 1) con `sandbox: 'workspace-write'` (mismo default que usa la UI al conectar normalmente — no hay forma de preguntarle al usuario el sandbox de una ventana que ni él mismo abrió). Corre el turno real vía `sendMessageToWindow()` (Paso 2, reusada tal cual, ahora con un campo `crossWindow` nuevo que reenvía a `deliverResultToOriginWindow()`).

**Tarea 3 — la tool en `tool-registry.ts`:** nueva entrada en `TOOL_DEFINITIONS` (`send_to_window`, parámetros `destino`/`mensaje`) + caso en el switch de `ToolRegistry.execute()`. **Aprobación SIEMPRE incondicional, sin excepción, sin importar el sandbox mode** — a propósito NO pasa por `resolveApproval()` (que auto-aprueba en `danger-full-access` o auto-rechaza en `read-only` según el sandbox de la conexión ACTUAL): `send_to_window` dispara un turno real en OTRA ventana/sesión, completamente fuera del sandbox del turno que la invoca, así que el sandbox mode de la conexión actual no tiene ninguna relación con si mandar un mensaje a otro chat es seguro — se llama a `ctx.confirm()` directo, mismo mecanismo de diálogo real que usan `write_file`/`apply_patch`/`run_command`/`revert_file`, pero sin la rama de sandbox que ellas sí tienen. El diálogo muestra destino + mensaje completo (`ctx.confirm(`Enviar mensaje a "${destino}"`, mensaje)`).

`ExecuteContext` gana `sendToWindowByTitle?` (closure inyectada por `ipc-agent.ts` en `agent:connect`, cerrada sobre el `windowId` de ESTA sesión — el ORIGEN del envío, mismo punto exacto que ya inyecta `confirm`/`resolveExploreModel`/`lspManager`). **Resuelta vía import dinámico (`await import('./cross-window-messaging.js')`), a propósito, no un `import` estático arriba del archivo:** `cross-window-messaging.ts` ya importa `connectSessionForWindow`/`runTurnForWindow` DESDE `ipc-agent.ts` (Paso 2/3) — un `import` estático de vuelta crearía un ciclo de módulos real entre los dos archivos. Se evaluó aceptar el ciclo estático directo (mismo patrón que ya tolera este codebase entre `tool-registry.ts`/`explore-tool.ts`, Fase 4, con funciones `export function` hoisted nunca invocadas en tiempo de evaluación del módulo) pero se prefirió el import dinámico por ser una garantía más fuerte, no solo argumentada: el ciclo nunca se evalúa en el orden de carga inicial en absoluto. **Confirmado con `npm run build` real, no solo razonado:** el bundle produce `cross-window-messaging-<hash>.js` como chunk SEPARADO de `out/main/index.js` — el bundler (esbuild vía electron-vite) confirma el code-split real, sin ningún warning de ciclo.

**Tarea 4 — modelo de datos, distinción visual:**
- `CrossWindowMeta` nueva (`shared/types.ts`): `{direction: 'sent' | 'received', windowLabel: string, providerType?: ProviderType}`. Solo `providerType` (no el `ProviderProfile` completo, que puede ya no existir para cuando esto se renderiza) — caveat documentado: no distingue el caso especial DeepSeek (mismo `type:'anthropic'` que Claude real, se distingue por endpoint, dato no disponible acá) — un mensaje cross-window de una conexión DeepSeek se pinta con el color de Anthropic. `direction:'sent'` queda reservado para uso futuro — esta fase solo genera `'received'` (el resultado que vuelve a la ventana de origen); no es un descuido, está documentado en el propio tipo.
- Los 3 lugares confirmados por la investigación previa: `StoredChatMessage` (`shared/types.ts`, campo `crossWindow?`), `ChatMessage` del renderer (`App.tsx`, mismo campo), `toChatMessage()` (`App.tsx`, lo reenvía).
- Columna nueva `chat_messages.cross_window` (`chat-store.ts`, `ALTER TABLE` + `try/catch`, mismo patrón de migración que `tool_steps`/`summary`). `saveChatMessage()` la persiste (JSON serializado, `ON CONFLICT DO UPDATE ... COALESCE`, mismo patrón que `tool_steps`); `loadChatSnapshot()` la selecciona y parsea de vuelta (`parseCrossWindow()`, defensivo — JSON inválido o con forma incorrecta se trata como "sin crossWindow", nunca lanza, mismo criterio que `parseToolSteps()`).
- `deliverResultToOriginWindow()`/`sendMessageToWindow()` (`cross-window-messaging.ts`, Paso 2) ganan un parámetro `crossWindow?` opcional, reenviado tal cual hasta `saveChatMessage()` — sin cambio de comportamiento para ningún llamador que no lo pase (Paso 2 mismo, si algún día se reusa fuera de la tool, sigue funcionando igual sin marca visual).

**Tarea 5 — render visual (`App.tsx`):**
- `crossWindowBrand(crossWindow)`: mapea `crossWindow.providerType` a un color de `PROVIDER_BRAND` (Fase 21) real — **ningún color nuevo inventado para esta fase**, mismos valores exactos que ya usa el resto de la app.
- `onIncomingMessage` consumido por primera vez: el canal `chat:incomingMessage` existía desde Paso 2 (expuesto en preload, verificado de punta a punta) pero **sin ningún listener real en la UI** — confirmado, no solo sospechado, que además faltaba declarar en `preload/index.d.ts` (`UniversalAgentApi`), un hallazgo real de la investigación de esta tarea: consumirlo desde `App.tsx` sin esa declaración es un error de compilación. `handleIncomingMessage()` nuevo agrega el mensaje a `chats[chatId]` (mismo mecanismo que cualquier mensaje normal) y bumpea el orden del sidebar (mismo criterio que `ensureStoredChat()`).
- JSX: el div de cada mensaje gana `borderLeft`/`boxShadow` inline (color real de `crossWindowBrand`) cuando `message.crossWindow` está presente, más un badge (`⇄ {windowLabel}`) arriba del texto. CSS nuevo en `main.css` (`.message.cross-window`, `.cross-window-badge`) — solo padding/tipografía fijos, el color en sí va inline por mensaje (varía por proveedor real).

**Tarea 6 — verificación real (CDP contra la app real + `D:\AMATISTA\data\config\amatista.db` real, Foundry real, no simulado):**

Scaffold temporal de verificación (`debug:sendToWindowByTitle` + `debug:getSessionState`, `ipc-agent.ts`/`preload/index.ts`) — invoca `sendToWindowByTitle()` REAL directo, evitando depender de que un LLM real decida frasear/llamar la tool correctamente (la capa de aprobación/parseo de args de `tool-registry.ts` se confirma aparte, por lectura de código — mismo criterio de reducción de alcance ya usado en Paso 2 para su propio scaffold). Usado y retirado antes de cerrar la fase, confirmado con grep sin rastro.

- **CASO 1 (destino nunca tuvo un turno):** chat real `test-paso3-window-b`/título `"Ventana-Test-B"` sembrado en `amatista.db` real con `provider_id`/`model_id` `NULL`. Ventana A conectada de verdad (Foundry `gpt-5.4` real, `chatId` explícito = `YAYOSCHAT`, chat real del usuario), con un turno previo real confirmado (`"TURNO-PREVIO-OK"`). `sendToWindowByTitle('Ventana-Test-B', ...)` devolvió `{ok:false, error:'El chat "Ventana-Test-B" nunca se uso (no tiene un modelo/proveedor previo) -- abrilo y conectalo vos primero desde la interfaz antes de poder mandarle mensajes desde otra ventana.'}` — exacto, sin crashear. Efecto real observado y correcto: SÍ abrió una ventana nueva (el guard de "nunca se usó" corre DESPUÉS de resolver/abrir la ventana destino, orden explícito del diseño confirmado) — 1 página → 2 páginas.
- **Hallazgo real durante la propia verificación, de setup, no de la implementación:** la primera corrida de este caso dio un resultado sorprendente (`{ok:true, text:"PONG-CASO-1"}`, un turno real que se auto-respondió a sí mismo) — diagnosticado: el chat de prueba recién sembrado, por tener el `updated_at` más reciente, quedaba como `activeChatId` por defecto de la Ventana A al arrancar (`bootstrap()`, `App.tsx`) — y aunque el turno previo se corrió pasando `chatId: YAYOSCHAT` explícito por IPC (que sí actualiza `session.activeChatId`, el estado de runtime en main), el `WindowEntry.chatId` (Fase 22a, el que usa `resolveWindowForChatTitle()` para decidir "qué ventana muestra qué chat") seguía apuntando al chat de prueba, porque ESE campo lo actualiza el propio React de la ventana vía `setActiveChatId()` (Paso 1), no las llamadas directas de IPC del driver de verificación. Corregido en el driver forzando `window.universalAgent.setActiveChatId(YAYOSCHAT)` real antes de cada corrida — confirma que el mecanismo real funciona correctamente (incluso el caso límite "mandarme un mensaje a mí mismo" resolvió y entregó bien), el hallazgo era enteramente del setup del test, no un bug de esta fase.
- **CASO 2 (destino con provider/model reales, simulando un turno previo):** mismo chat de prueba, backfillado (`provider_id:'qcfg-foundry', model_id:'qcfg-foundry-chat'`) directo en SQLite real. `sendToWindowByTitle('Ventana-Test-B', 'Respondeme unicamente con la frase: PONG-CASO-2-FINAL')` → auto-conectó de verdad (`connectSessionForWindow` real), corrió un turno real contra Foundry, devolvió `{ok:true, text:"PONG-CASO-2-FINAL"}`. Verificado con 3 capas de evidencia real, no solo el valor de retorno: (a) `loadChats()` releído tras la corrida confirma el mensaje persistido en `chatId:YAYOSCHAT` con `crossWindow:{direction:'received', windowLabel:'Ventana-Test-B', providerType:'foundry'}` exacto; (b) simulando el click real del usuario en el chat YAYOSCHAT del sidebar (`element.click()` real vía CDP, no solo lectura de estado), `document.body.innerText` confirma el texto de la respuesta visible en pantalla; (c) `getComputedStyle()` real sobre el DOM confirma `border-left: 3px solid rgb(0, 120, 212)` y el mismo color en el badge — `rgb(0,120,212)` = `#0078d4` = el color REAL de `PROVIDER_BRAND.foundry`, no un color inventado ni aproximado.
- **Limpieza:** toda la base real (`amatista.db`) limpiada de mensajes/chats de prueba al terminar (`test-paso3-window-b` borrado por completo, 3 mensajes de prueba en `YAYOSCHAT` borrados por texto exacto — el intento inicial de borrar por `chat_id` falló por un problema de escapado de backslashes en el propio script de limpieza, no en el código de la app; corregido filtrando por el texto de prueba en su lugar), confirmado sin residuos con una relectura directa (`cross_window IS NOT NULL` → `[]`). App cerrada, `tasklist` confirma cero `electron.exe` colgado.

`npm run typecheck` y `npm run build`: en verde después de cada tarea, y de nuevo tras retirar el scaffold de debug. Sin commit — pendiente de que el usuario lo pida explícitamente.

### Ajuste posterior — el guard de `provider_id`/`model_id` pasa a correr ANTES de abrir la ventana destino

> Corrige el efecto colateral real que la propia verificación de Tarea 6 encontró y dejó documentado arriba (CASO 1 abría una `BrowserWindow` nueva y vacía ANTES de fallar por "chat nunca usado").

`sendToWindowByTitle()` (`cross-window-messaging.ts`) se reordena en 2 fases explícitas, separando lo que antes hacía una sola función combinada (`resolveWindowForChatTitle()`, que resolvía título→chatId Y abría/buscaba la ventana en el mismo paso):

1. **Resolver y VALIDAR, sin tocar ninguna ventana:** `findChatSessionByTitle(destino)` (sin cambios) + el guard de `provider_id`/`model_id` `NULL`, ambos usando solo el resultado de esa query — `resolveOrOpenWindowForChat()` (la función nueva, reemplaza a `resolveWindowForChatTitle()`) ni se llama todavía. Si el chat no existe o nunca tuvo un turno real, se devuelve el error de siempre **sin haber tocado `windowRegistry` ni llamado a `createAppWindow()` en absoluto**.
2. **Guard superado → recién ahí** `resolveOrOpenWindowForChat(match.id)` (versión reducida, ya no resuelve título ni valida nada — solo busca en `windowRegistry` o abre una ventana nueva) + auto-conexión si hace falta + turno real + entrega.

**Caveat real del reorder, no oculto:** el guard pasa de condicional (antes solo corría si la sesión destino no tenía `activeRuntime`, es decir, se salteaba por completo si ya había una ventana conectada) a **incondicional** — corre siempre, para cualquier destino, esté o no una ventana ya abierta y conectada para ese chat. En la práctica esto casi nunca cambia nada: una ventana con `activeRuntime` real solo llega a ese estado después de que ese mismo chat ya tuvo un turno real, que es exactamente lo que persiste `provider_id`/`model_id` (`ensureStoredChat()`, en cada turno). **Caso límite real, identificado pero no resuelto:** una ventana que se conectó (`connectAgent` real, `activeRuntime` seteado) pero todavía no mandó NINGÚN turno — `chat_sessions.provider_id`/`model_id` de ese chat siguen `NULL` pese a que la conexión está viva y lista — ahora se rechaza con el mismo mensaje que un chat genuinamente nunca usado, aunque técnicamente podría recibir el mensaje sin necesitar auto-conectar nada. Ventana angosta y de bajo impacto (requiere que alguien mande un `send_to_window` en la ventana exacta de tiempo entre "conectar" y "primer turno" de otra ventana), documentada explícitamente en el código (`sendToWindowByTitle()`) — no evaluado si vale la pena distinguir los dos casos.

**Verificación real (repetición de Tarea 6, mismo método CDP):**
- **CASO 1 (chat nunca usado), repetido:** mismo mensaje de error exacto que antes (`'El chat "Ventana-Test-Reorder" nunca se uso...'`), pero esta vez **0 páginas nuevas** (1 antes, 1 después) — confirmado que `createAppWindow()` ya no se llama en este camino.
- **CASO 2 (éxito), repetido:** backfill de `provider_id`/`model_id` reales sobre el mismo chat de prueba → `sendToWindowByTitle()` devolvió `{ok:true, text:"PONG-REORDER-OK"}`, auto-conectó de verdad, corrió el turno real contra Foundry, entregó el resultado a `YAYOSCHAT` con `crossWindow:{direction:'received', windowLabel:'Ventana-Test-Reorder', providerType:'foundry'}` — idéntico a la corrida original, confirmado releyendo `loadChats()`. Esta vez sí abrió 1 página nueva (recién en la Fase 2, con el guard ya superado).
- Base real (`amatista.db`) limpiada de todo residuo de esta ronda al terminar, confirmado con relectura (`cross_window IS NOT NULL` → `0`). `tasklist` sin `electron.exe` colgado.

`npm run typecheck` y `npm run build`: en verde, antes y después del ajuste, y de nuevo tras retirar el segundo scaffold de debug. Sin commit.

## UI Paso 1 — tool `list_windows()` + protección contra auto-envío

> Cierra el objetivo "que la IA sepa qué ventanas/chats existen" (3 rondas de investigación previa: contexto siempre-on vs. tool bajo demanda, qué dato mostrar por chat, alcance según el guard real). Diseño confirmado con el usuario tras esa investigación.

**Tool `list_windows()`** (`tool-registry.ts`) — sin parámetros, solo lectura, sin aprobación, mismo criterio exacto que `search_files`/`get_diagnostics`/`list_file_history` (nunca pasa por `resolveApproval()`, no consulta `ctx.sandbox`). Justificación de fondo, mismo criterio ya usado para LSP (Fase 20): un dato que se usa en una fracción mínima de los turnos no se inyecta siempre (costo recurrente en cada turno de cada sesión, como AGENTS.md) — se ofrece bajo demanda, pagando el costo solo cuando el modelo genuinamente lo necesita. Además, el dato cambia en vivo (un chat puede pasar de "nunca usado" a usable a mitad de conversación si otra ventana le manda su primer turno en paralelo) — cachearlo una vez por conexión (como AGENTS.md) lo dejaría stale; una tool siempre lee el estado real de `chat_sessions` en el momento exacto en que se llama.

**`listChatSessionsForWindowDiscovery()`** (`chat-store.ts`, nueva): `SELECT id, title, provider_id, model_id FROM chat_sessions ORDER BY updated_at DESC LIMIT 20` — SQL crudo, sin resolver nada contra `settings.providers` (esa resolución no puede vivir en `chat-store.ts`, que no tiene ni debe tener acceso a `settings`). Mismo patrón de tope que `SEARCH_FILES_MAX_MATCHES` (`tool-registry.ts`) — un usuario con muchos chats acumulados no manda todos de una, `ORDER BY updated_at DESC` prioriza los recientes.

**`listWindowsForSession(session)`** (`ipc-agent.ts`, nueva, standalone — no un closure inline): resuelve la lista cruda contra `settings.providers` (único lugar con acceso real a `settings` sin crear un ciclo de módulos con `tool-registry.ts`, mismo razonamiento ya aplicado a `sendToWindowByTitle`). Reglas de resolución, exactas al diseño confirmado:
- Excluye el chat de la PROPIA sesión (`session.activeChatId`) — listarse a sí mismo no aporta nada útil para `send_to_window`.
- `provider_id`/`model_id` `NULL` → `"no usable todavia (nunca se uso, sin modelo/proveedor previo)"` — misma frase de vocabulario que ya usa el error real de `sendToWindowByTitle()`, reusada acá como dato informativo, no como error.
- Proveedor borrado O deshabilitado desde el último turno de ese chat → `"proveedor eliminado"` — un solo `find()` + chequeo de `enabled` cubre ambos casos (borrado y deshabilitado dan el mismo resultado desde la perspectiva de esta tool: ninguno de los dos es usable), sin necesitar distinguirlos.
- Caso feliz: `"${provider.name} ${modelLabel}"` (ej. `"Foundry gpt-5.4"`) — `modelLabel` cae a `model.model` si `displayName` viene vacío, y al `modelId` crudo como último recurso si el modelo específico también fue borrado del catálogo del provider (defensivo, nunca `undefined`).

Inyectada en `ExecuteContext.listWindows` (`tool-registry.ts`), mismo punto exacto donde ya se inyectan `confirm`/`resolveExploreModel`/`sendToWindowByTitle` (`connectSessionForWindow()`, `ipc-agent.ts`) — **síncrona**, a diferencia de `sendToWindowByTitle` (no necesita import dinámico: no importa nada de `cross-window-messaging.ts`, así que no hay ningún ciclo de módulos que evitar acá).

**Protección contra auto-envío** (`sendToWindowByTitle()`, `cross-window-messaging.ts`): chequeo agregado en el punto MÁS TEMPRANO posible — justo después de que `findChatSessionByTitle()` resuelve `match.id`, ANTES del guard de `provider_id`/`model_id` NULL, antes de `resolveOrOpenWindowForChat()`, antes de cualquier efecto secundario. Comparación por **chatId**, no por título — un título puede tener duplicados (`findChatSessionByTitle()` ya resuelve al más reciente), así que comparar por id es la única forma correcta de detectar "es mi propio chat" sin depender de que el usuario/modelo haya escrito el título exacto con el que esta sesión se conectó.

**Verificación real (CDP contra la app real + `D:\AMATISTA\data\config\amatista.db` real, Foundry real):**

Scaffold temporal (`debug:callTool`, `ipc-agent.ts`/`preload/index.ts`) — reusa `toolRegistry.execute()` REAL (mismas `TOOL_DEFINITIONS`, mismo switch, mismos closures `listWindows`/`sendToWindowByTitle` reales), con `confirm` hardcodeado a auto-aprobar SOLO en este arnés — la capa de aprobación real se confirma aparte, por lectura de código (mismo criterio de Paso 3, Tarea 6). Usado y retirado antes de cerrar la fase, confirmado con grep sin rastro.

- **`list_windows()` real** contra 3 chats reales sembrados con estados distintos (`provider_id`/`model_id` reales, `NULL`, y apuntando a un `provider_id` inexistente): salida real —
  ```
  "UI-P1-Deleted" -- proveedor eliminado
  "UI-P1-Null" -- no usable todavia (nunca se uso, sin modelo/proveedor previo)
  "UI-P1-Real" -- Microsoft Foundry / q_config Foundry gpt-5.4
  "Chat nuevo" -- Microsoft Foundry / q_config Foundry DeepSeek-V4-Pro
  ```
  Los 3 casos sembrados coinciden exacto con lo esperado; el 4to (`"Chat nuevo"`) es un chat real preexistente del usuario, confirma que el `LIMIT 20`/`ORDER BY updated_at DESC` trae datos reales de producción, no solo los de prueba. `YAYOSCHAT` (el chat de origen de la Ventana A que llama la tool) confirmado **ausente** de la lista.
- **Auto-envío**: `send_to_window({destino:'YAYOSCHAT', mensaje:'PING-A-MI-MISMO'})` desde la propia Ventana A (conectada a `YAYOSCHAT`) → `{ok:false, output:'No podes mandarte un mensaje a tu propio chat.'}`, **0 páginas nuevas** (1 antes, 1 después) — confirmado que ni `resolveOrOpenWindowForChat()` ni `connectSessionForWindow()` se llegan a invocar.
- **`send_to_window` normal, sin cambios**: mismo flujo de siempre contra `"UI-P1-Real"` (provider/model reales sembrados) → `{ok:true, output:'Mensaje entregado a "UI-P1-Real". Respuesta:\nPONG-UIP1-OK'}` — turno real corrido contra Foundry, idéntico al comportamiento ya verificado en Paso 3.
- Base real limpiada de todo residuo (3 chats de prueba + mensajes de prueba) al terminar, confirmado con relectura (`cross_window IS NOT NULL` → `0`). `tasklist` sin `electron.exe` colgado.

`npm run typecheck` y `npm run build`: en verde después de cada tarea, y de nuevo tras retirar el scaffold de debug. Sin commit — pendiente de que el usuario lo pida explícitamente.

## Fase Paneles-1 — backend: `panelId` reemplaza `windowId`, multi-ventana retirado

> Cierra la Tarea 0 de investigación (`docs/_arch/verify_panels_scope.md`, versión simplificada): el usuario descarta la convivencia ventana+panel — es reemplazo directo. `windowId: number` (`BrowserWindow.id`, resuelto vía `event.sender`) deja de ser la identidad de sesión en todo el backend; `panelId: string` (`crypto.randomUUID()`, generado por el renderer) lo reemplaza. El objetivo final (múltiples paneles reales dentro de una sola ventana) queda para Paneles-2/3/4 — esta fase es exclusivamente backend + el mínimo de renderer necesario para no romper nada (App.tsx sigue siendo, hoy, "el único panel").

**Tarea 1 — cambio de tipo puro, confirmado sin sorpresas:** las 13 firmas + 2 `Map<number,...>` identificadas en la investigación (`runtime-state.ts`: `setWindowChatId`/`sendToWindow`/`getSession`/`sendSessionEvent`/`cancelSessionTurn`/`setSessionToolTrust`/`requestSessionToolApproval`/`disconnectSession`/`wireCodex`/`wireCli`/`wireApi` + `windowRegistry`/`sessionRegistry`; `ipc-agent.ts`: `assertSessionWorkspaceStillActive`/`runTurnForWindow`/`connectSessionForWindow`) pasan a `panelId: string` sin tocar ninguna lógica interna — confirmado real, no solo argumentado: `npm run typecheck` salió limpio en el primer intento completo, sin ningún error de tipo en ninguna de las 13 funciones. Extensión no listada originalmente pero necesaria por consistencia: `cross-window-messaging.ts` también renombra sus propios `originWindowId`/`destinationWindowId` (`DeliverResultParams`, `SendMessageToWindowParams`, `SendToWindowByTitleParams`) a `originPanelId`/`destinationPanelId` — evita el nombre engañoso `windowId: string` (numérico de nombre, string de tipo).

**Tarea 2 — los 16 handlers reales** (confirmado, no 6 archivos como se dijo en una ronda intermedia de la investigación — son 5 archivos, ya corregido en `verify_panels_scope.md`): `ipc-agent.ts` (7: `agent:disconnect/connect/send/cancel/reply/toolApproval:respond/toolTrust:disable`), `ipc-window.ts` (2, retirados por completo — ver Tarea 5), `ipc-agents-md.ts` (2), `ipc-mcp.ts` (2), `ipc-projects-workspace.ts` (4: `workspace:open/refresh/readFile/saveFile`). De los 16, 8 no recibían ningún payload del renderer antes de esta fase (`agent:disconnect`, `agent:cancel`, `agent:toolTrust:disable`, `agentsMd:status`, `agentsMd:openOrCreate`, `mcp:status`, `mcp:openOrCreate`, `workspace:refresh`) — ganaron un payload nuevo `{panelId}` donde antes no existía ninguno; los demás agregaron el campo a una interfaz/tipo inline ya existente. Ningún handler vuelve a llamar `BrowserWindow.fromWebContents(event.sender)`/`originWindowId` para esto — confirmado con grep final, cero ocurrencias reales fuera de comentarios.

**Tarea 3 — `forPanel(panelId)` en preload, migración de los 58 call sites:** wrapper nuevo en `preload/index.ts` que devuelve un objeto con las funciones de sesión (`connectAgent`/`sendMessage`/`cancelAgent`/`disconnectAgent`/`replyToAgent`, `onAgentEvent`/`onToolApprovalRequest`/`respondToolApproval`/`onToolTrustChanged`/`disableToolTrust`, `openWorkspace`/`refreshWorkspace`/`readFile`/`saveFile`, `getAgentsMdStatus`/`openOrCreateAgentsMd`, `getMcpStatus`/`openOrCreateMcpConfig`) con `panelId` ya inyectado en cada `invoke` y ya usado para **filtrar cada evento entrante ANTES de invocar el callback** (`filteredListener()`, compara `data.panelId === panelId`) — resuelve el dispatcher de eventos sin necesitar una tabla de ruteo separada en `App.tsx`: cada panel se suscribe con su propio listener ya pre-filtrado (N paneles × M canales = N×M `ipcRenderer.on()`, costo irrelevante para 1-4 paneles). Extensión respecto al listado literal de la Tarea 3 original: `onIncomingMessage` (`chat:incomingMessage`) y `onAgentEvent` (`agent:event`) también quedan dentro de `forPanel()` — no estaban nombrados explícitamente en la enumeración de métodos pero SÍ están entre los "4 canales" de la Tarea 4, así que dejarlos fuera del wrapper habría hecho inútil el `panelId` que esos mismos canales llevan embebido.

`App.tsx`: `panelId` generado una vez por instancia (`useState(() => crypto.randomUUID())`) + `const api = useMemo(() => window.universalAgent.forPanel(panelId), [panelId])`. **Confirmado el conteo real coincide exacto con el grep original**: de los 58 call sites `window.universalAgent.*` (contados dos veces con grep, antes y después), 15 se migraron a `api.*` (las funciones de sesión), 2 se retiraron por completo (`openInNewWindow`, `setActiveChatId` — ver Tarea 5), y 41 quedaron sin tocar (funciones de toda la app: `getSettings`, `loadChats`, `listProjects`, adjuntos, cuenta Codex, etc.) — `15 + 2 + 41 = 58`, reconciliado con evidencia real, no asumido (el recount posterior a la migración dio 43 "window.universalAgent" en vez de 41 esperados, explicado por 1 comentario propio con esa cadena literal + la nueva llamada real a `forPanel` — ambos ajenos a los 58 call sites originales).

**Tarea 4 — `sendToWindow()` simplificado, único punto de inyección real:** `runtime-state.ts` reemplaza `windowRegistry`/`isWindowUsable`/`broadcastToAllWindows`/`sendToRenderer` (los últimos dos, sin ningún caller real fuera de sí mismos, confirmado con grep — retirados como código muerto, no solo lo pedido explícitamente) por una única referencia `mainWindow: BrowserWindow | null` (seteada por `setMainWindow()`, llamada una vez desde `createAppWindow()`). `sendToWindow(panelId, channel, payload)` pasa a `mainWindow!.webContents.send(channel, {...payload, panelId})` — sin ningún lookup de "a cuál ventana": embebe `panelId` directo, en el ÚNICO punto real por el que pasan los 4 canales que lo necesitan (`agent:event` vía `sendSessionEvent`, `agent:toolApproval` vía `requestSessionToolApproval`, `agent:toolTrust` vía `setSessionToolTrust`, `chat:incomingMessage` vía `deliverResultToOriginWindow`) — confirmado por lectura completa, cero callers de `sendToWindow()` fuera de esos 4. `window:fullscreenChanged` (el 5to canal de la investigación) NO pasa por acá ni necesita `panelId` — sigue siendo `window.webContents.send()` directo en `window-manager.ts`, porque fullscreen es una propiedad de la ventana física única, no de un panel.

**Tarea 5 — código muerto retirado:**
- `windowRegistry`/`WindowEntry`/`registerWindow()`/`setWindowChatId()`/`isWindowUsable()` (`runtime-state.ts`) — eliminados por completo.
- `window:openInNewWindow` (`ipc-window.ts`) — eliminado junto con su exposición en preload (`openInNewWindow`) y el botón "Abrir en ventana nueva" del menú contextual de chat en `App.tsx` (retirado sin reemplazo — "Agregar panel" es Paneles-2/4, fuera de alcance). `createAppWindow()` (`window-manager.ts`) **sobrevive tal cual** en su único rol restante: se llama una vez en `app.whenReady()` (`index.ts`), nunca más por acción del usuario.
- `window:setActiveChatId` (`ipc-window.ts`) — eliminado por completo junto con el `useEffect` correspondiente en `App.tsx` (el entregable íntegro de Mensajería Paso 1). Reemplazo funcional: ninguno todavía — cada sesión ya trackea su propio `activeChatId` en `SessionRuntimeState` (existía desde antes), sin un registro `panelId↔chatId` aparte. Caveat real heredado, no introducido acá: `session.activeChatId` solo se actualiza en `agent:connect`, no en cada cambio de chat en pantalla — el mismo panel puede estar mostrando un chat distinto al que main cree, si el usuario cambió de chat sin reconectar (limitación preexistente, ahora más visible porque no hay ningún mecanismo de sincronización en vivo reemplazándola).
- `app.on('activate', ...)` (`index.ts`): la condición `windowRegistry.size === 0` se reemplaza por `BrowserWindow.getAllWindows().length === 0` — API nativa de Electron directa, sin necesitar ningún registro propio.
- `BrowserWindow`/`IpcMainInvokeEvent` como imports se retiran de `ipc-agent.ts`, `ipc-agents-md.ts`, `ipc-mcp.ts`, `ipc-projects-workspace.ts` (ninguno de los 4 vuelve a resolver identidad de sesión vía Electron) — `ipc-window.ts` conserva `BrowserWindow`/`IpcMainInvokeEvent` porque `window:getFullscreen`/`window:setFullscreen` siguen siendo legítimamente resueltos vía `event.sender` (fullscreen es de la ventana física, no de una sesión).

**CASO ESPECIAL — `cross-window-messaging.ts`, regresión temporal conocida y documentada:** `resolveOrOpenWindowForChat()` (llamaba `createAppWindow()` para abrir una `BrowserWindow` nueva cuando el destino no estaba abierto) se reemplaza por `findConnectedPanelForChat(chatId)` — escanea `sessionRegistry` directo (`session.activeChatId === chatId && session.activeRuntime`), **sin auto-apertura de ningún tipo**: si ningún panel en vivo muestra ese chat, `sendToWindowByTitle()` falla con `'El chat "X" no esta abierto en ningun panel activo -- mensajeria a un chat sin panel abierto todavia no esta soportada con paneles. Abrilo vos primero.'` en vez de intentar crear algo que ya no existe como concepto (main no puede "abrir un panel" — eso es un nodo del árbol de React del renderer, ver Parte C de la investigación, Paneles-3 sin diseñar todavía). El guard viejo de Paso 3 (`provider_id`/`model_id` `NULL` en la DB) queda **subsumido**, no duplicado: sin auto-apertura, lo único que importa es si hay un panel EN VIVO conectado a ese chat ahora mismo — un chat con provider/model persistidos de un turno viejo pero sin ningún panel conectado hoy es, de todas formas, inalcanzable, así que consultar la DB para ese caso ya no aporta nada. Consecuencia real: la rama de auto-conexión de `sendToWindowByTitle()` (que existía para conectar una ventana recién abierta) se retira también — bajo el nuevo `findConnectedPanelForChat`, cualquier resultado ya viene con `activeRuntime` garantizado (por construcción: `disconnectSession()` resetea `activeChatId`/`activeRuntime` juntos, nunca queda uno sin el otro salvo una ventana de carrera transitoria de milisegundos dentro del propio `connectSessionForWindow()`).

**Verificación real (Tarea 6, CDP contra la app real + `D:\AMATISTA\data\config\amatista.db` real, Foundry real):** scaffold temporal (`debug:callTool`, reusa `toolRegistry.execute()` real, mismo patrón de scaffolds anteriores, retirado y confirmado con grep). Con el MISMO `panelId` simulado (`'test-panel-A-fija-simulada'`, un string arbitrario, no un `BrowserWindow.id` real) en 2 llamadas seguidas: `connectAgent` conectó real contra Foundry (`{connected:true, runtime:'foundry'}`), y `sendMessage` con ese MISMO `panelId` corrió un turno real (`{success:true, text:'PANELID-OK'}`) — confirma la sesión persistiendo correctamente indexada por `panelId`, sin ningún error de tipo ni de runtime. `send_to_window` a un chat sin panel conectado (`"Chat nuevo"`, real, recién arrancada la app) devolvió el mensaje nuevo exacto, con **0 páginas nuevas abiertas** (1 antes, 1 después) — confirmado que `createAppWindow()` ya no se invoca en este camino. Verificación adicional no pedida explícitamente pero que cierra el caso "ya conectado" del CASO ESPECIAL: conectando un segundo panel simulado real a ese mismo chat y reintentando `send_to_window` desde el primero, el resultado fue éxito real (`{ok:true, output:'Mensaje entregado a "Chat nuevo". Respuesta:\nPONG-PANELES-1-OK'}`) — confirma que el camino "destino ya conectado en vivo" sigue funcionando sin cambios de comportamiento. Base real limpiada de todo residuo al terminar (confirmado con relectura, `cross_window IS NOT NULL` → `0`), `tasklist` sin `electron.exe` colgado.

`npm run typecheck` y `npm run build`: **limpios en el primer intento completo**, sin necesitar ninguna ronda de corrección — confirma que el cambio de tipo puro (Tarea 1) fue, en efecto, puro. Sin commit — pendiente de que el usuario lo pida explícitamente.

## Retiro completo de claude-cli

> `claude-cli` deja de existir como runtime real en todo el codebase — no era funcional (nunca terminó de mantenerse al ritmo de los demás runtimes, ver más abajo el reemplazo por `'anthropic-api'`). Las referencias de fases anteriores (7, 10, 13, 17, 20, todas por encima de esta sección) describen `claude-cli` tal como existía EN ESE MOMENTO — quedan sin editar a propósito, son registro histórico, no comportamiento vigente (mismo criterio ya establecido en este documento para el contrato de memoria v1 DEPRECATED). Esta sección es la única fuente de verdad de qué pasó con `claude-cli` y por qué.

**Decisión de diseño (confirmada con el usuario, no inferida):** una conexión Claude Pro por suscripción existente en `settings.json` real **no se borra** — se **deshabilita automáticamente** (`provider.enabled = false`) más un aviso explícito, y el usuario puede reactivarla a mano desde Configuración si algún día vuelve a hacer falta (aunque, sin ningún runtime que sepa ejecutar `claude-cli`, no va a funcionar). Reemplaza los 3 mecanismos viejos de re-siembra que forzaban `runtime:'claude-cli'` en cada carga (`claudeSubscriptionProvider()`/`sanitizeSettings()` en `settings-provisioning.ts`, la siembra incondicional de `buildProvidersFromQConfig()` al importar `q_config.yaml` legado, y `runtimeFor()` en `settings-store.ts`).

**Migración idempotente basada en marcador, no un flag booleano nuevo en el schema:** `CLAUDE_CLI_REMOVED_MARKER = ' — ya no soportado (claude-cli retirado)'` (`settings-provisioning.ts`, exportado; duplicado como const local idéntica en `App.tsx` — renderer y main no comparten módulos en este setup Electron+Vite, mismo patrón de duplicación ya establecido para `DEEPSEEK_ANTHROPIC_ENDPOINT`/`DEEPSEEK_ENDPOINT`). Un proveedor `type:'anthropic' && authMode:'subscription'` que no tenga todavía el marcador en su `name` pasa a `enabled:false` y se le agrega el marcador al nombre; si ya lo tiene (`name.includes(marker)`), se deja intacto — así una reactivación manual del usuario después de la migración **nunca vuelve a pisarse** en la próxima carga. Corre en dos puntos independientes por diseño, no redundante: `migrateClaudeSubscriptionProviders()` (plural, `settings-provisioning.ts`, dentro de `sanitizeSettings()`) cubre `settings:save` además del arranque; `migrateClaudeSubscriptionProvider()` (singular, `settings-store.ts`, dentro de `migrateProvider()`) corre en **cada `loadSettings()`**, un camino que `sanitizeSettings()` no cubre por sí solo.

**`runtimeFor()` (`settings-store.ts` y su duplicado en `App.tsx`) simplificado:** la rama `type === 'anthropic'` ya no bifurca por `authMode` — siempre devuelve `'anthropic-api'`. Antes: `authMode === 'api-key' ? 'anthropic-api' : 'claude-cli'`. El modelo de una conexión por suscripción recién deshabilitada queda con un `runtime` válido (nunca `'claude-cli'`, que ya no existe en el tipo `RuntimeKind`) aunque el proveedor esté `enabled:false` — inerte porque el proveedor está deshabilitado, pero nunca un valor fuera del union.

**`TAREA 6` — edge case real, confirmado contra datos de producción, no hipotético:** conexiones Claude API-key/Azure creadas ANTES del fix de DeepSeek (Fase 14→15, `allowSubscription`) podían no tener ese campo seteado. Mismo patrón exacto que `backfillDeepSeekAllowSubscription()` (ya existente): `backfillAnthropicApiKeyAllowSubscription()` (`settings-store.ts`) — si `type:'anthropic' && authMode:'api-key'` y `allowSubscription !== false`, lo fuerza a `false`. Confirmado real: la conexión `qcfg-azure-claude` del usuario en `D:\AMATISTA\data\config\settings.json` no tenía el campo antes de esta fase; después del primer arranque con el código nuevo, quedó backfillado a `allowSubscription:false`, confirmado leyendo el archivo real de vuelta.

**`CliAgentKind` (`cli-agent-runtime.ts`) reducido a `'gemini'` únicamente** (era `'claude' | 'gemini'`) — se mantuvo como type nombrado + campo `kind` en `ConfigureOptions`, deliberadamente NO simplificado a una clase sin parámetro: `buildEnv()`/`permissionArgs()` ya tenían una rama por `kind` antes de esta limpieza (no es abstracción nueva agregada de más), así que sacar el parámetro implicaría reescribir esas dos funciones asumiendo Gemini a secas, y volver a agregarlo si algún día vuelve un tercer CLI costaría más que dejar el campo mínimo hoy. Removidos por completo (sin dejar código huérfano): `claudeImageBlocks()`, `parseDataUrl()`, `claudeCommand()`, `sendClaude()`, `sendClaudeWithImages()`, y `currentImageAttachments()` (huérfana también — `sendGemini()` no maneja imágenes, sin otro llamador real). `send()` pierde el parámetro `effort` (exclusivo de Claude). `sendGemini()` quedó sin ningún cambio de línea.

**Herramienta de completitud: el compilador, no una segunda pasada de grep manual.** Sacar `'claude-cli'` de `RuntimeKind` (`shared/types.ts`) y `'claude'` de `CliAgentKind`/`SessionRuntimeState.activeRuntime` (`runtime-state.ts`) convierte cada comparación/asignación residual en un error de `tsc` real, porque `ModelProfile.runtime` es un union literal estricto, no ensanchado a `string`. **Confirmado empíricamente, no solo argumentado:** los 7 errores resultantes cayeron los 7 dentro de un único archivo, `ipc-agent.ts` (la rama CLI de `agent:connect`, ternaria entre `claude-cli`/`gemini-cli`, simplificada a Gemini-únicamente; y la llamada a `cliRuntime.send()` con 3 argumentos contra la nueva firma de 2) — cero sorpresas fuera de lo que la investigación previa (Tarea 0) ya había anticipado.

**Resto del retiro, mecánico** (confirmado con grep final, cero referencias funcionales sobrevivientes — solo el string del marcador y comentarios que documentan la propia limpieza): `detectClaude()` (`cli-status.ts`) eliminada; `cli:installClaude` (`ipc-cli.ts`) eliminado junto con `installClaudeCli` en preload; `openClaudeLogin()` (`auth-manager.ts`) eliminada; rama `anthropic` de `auth:openCliLogin` eliminada; campo `claude` de `cli:status` eliminado (`{codex, gemini}` en vez de `{codex, claude, gemini}`); `CLAUDE_EFFORT_LEVELS`, botón "+ Agregar conexión → Claude Pro", `installClaudeCli()` (renderer), `openCliLogin()`/`cliInstallHint()` genéricas reemplazadas por `openGeminiCliLogin()`/`geminiCliInstallHint()` (`App.tsx`); `scripts/install-claude-cli.ps1` borrado (nunca se invocaba desde código real — confirmado con grep antes de borrar — y su propio texto instruía pasos de UI que ya no existen, activamente engañoso si se dejaba).

**Aviso al usuario — limitación real, no ocultada:** el nuevo `notice` que `bootstrap()` (`App.tsx`) arma cuando detecta la conexión Claude Pro recién deshabilitada usa el mismo mecanismo `setNotice()`/`{notice}` que ya existía para otros avisos de la app — y ese mecanismo **siempre estuvo acotado al panel de Configuración** (`{notice && <div className="notice">{notice}</div>}` vive dentro del bloque `{settingsOpen && (...)}`, confirmado leyendo la estructura JSX real, no asumido). No es un toast global en pantalla al arrancar la app — es visible recién cuando el usuario abre Configuración, igual que cualquier otro aviso de esta app (import de `q_config`, instalación de CLI, etc. — ninguno de esos es un toast global tampoco). Confirmado real vía CDP: con Settings cerrado el texto del aviso no aparece en `document.body.innerText`; simulando el click real del botón de Configuración, tanto el aviso como el nombre marcado del proveedor (`"... — ya no soportado (claude-cli retirado)"`) aparecen correctamente. Se documenta como comportamiento consistente con el resto de la app, no como bug — si en el futuro se prioriza un aviso verdaderamente global al arrancar, es una feature nueva (mecanismo de notificación fuera de Configuración), no un fix de esta fase.

**Verificación real (no solo `npm run typecheck`/`npm run build` en verde), contra `D:\AMATISTA\data\config\settings.json` de producción real:**
- Antes: `qcfg-claude-subscription` con `enabled:true`, `name:"Claude Pro (suscripcion)"`, modelos en `runtime:"claude-cli"`. Después de un arranque real de la app con el código nuevo: `enabled:false`, `name` con el marcador agregado, modelos migrados a `runtime:"anthropic-api"` — confirmado leyendo el archivo real de vuelta, no inferido.
- `qcfg-gemini-subscription` (Gemini CLI real, sin tocar por restricción explícita): `connectAgent()` real exitoso. `sendMessage()` real falló con `"Cannot use both a positional prompt and the --prompt (-p) flag together"` — **confirmado pre-existente, no introducido por esta limpieza**: `sendGemini()` en el `cli-agent-runtime.ts` reescrito es copia byte-a-byte del original, sin ningún cambio en la construcción de argumentos ni en `permissionArgs()`/`buildEnv()` para la rama Gemini. Causa más probable: desajuste de versión del binario `gemini` real instalado en esta máquina contra el formato de flags que el código espera — **fuera de alcance de esta fase** (restricción explícita de no tocar nada de Gemini), anotado para investigar aparte si se prioriza.
- `qcfg-azure-claude` (Claude API-key/Azure, real, sin tocar en su lógica de conexión): estructura confirmada correcta post-migración (`allowSubscription:false` backfillado, `runtime:"anthropic-api"`). Intento de conexión real (`connectAgent()`) devolvió `"Proveedor no disponible."` — **confirmado como estado pre-existente real del usuario, no causado por esta fase**: el campo `enabled` de ese proveedor en el `settings.json` real ya era `false` ANTES de esta limpieza (la migración de esta fase solo toca proveedores `authMode:'subscription'`, nunca `authMode:'api-key'` — confirmado por código). El guard `if (!provider || !provider.enabled) throw ...` (`ipc-agent.ts`) es comportamiento correcto y preexistente, no un bug de esta fase.
- Grep final sobre `src/`: cero comparaciones/asignaciones de `'claude-cli'` como `RuntimeKind` o `'claude'` como `CliAgentKind` sobrevivientes — todo lo que matchea `claude-cli` es el string del marcador (`CLAUDE_CLI_REMOVED_MARKER`, intencional) o comentarios que documentan esta misma limpieza.

`npm run typecheck` y `npm run build`: en verde después de cada tarea. Sin commit — pendiente de que el usuario lo pida explícitamente.

## Fase Paneles-2a — modelo activo por chat, no por AppSettings global

> Cierra la Tarea 0 de investigación (`docs/_arch/verify_panels_scope.md`, sección "Paneles-2a"): confirmó que `chat_sessions.provider_id`/`model_id` (ya persistidos desde Mensajería Paso 3) alcanzan como fuente real de "modelo activo de ESTE panel/chat" — `AppSettings.activeProviderId`/`activeModelId` (un único valor compartido por toda la app) dejan de ser "el" modelo activo y se **repurpose**, no se eliminan del schema: pasan a ser el **default sugerido de la app** para un chat que todavía no tiene ninguno propio. Cero migración de `settings.json` necesaria — el shape de los 3 campos (`string | undefined`) no cambia, solo su significado.

**Diseño de 3 niveles (`pickProvider()`/`pickModel()`, `App.tsx`):** (1) `providerId`/`modelId` del chat activo de ESTE panel — nivel nuevo, lee `activeChat.providerId`/`activeChat.modelId`; (2) si el chat no tiene ninguno (nunca usado): `settings.activeProviderId`/`activeModelId`, el default de la app; (3) si tampoco hay default: cualquier proveedor/modelo habilitado (fallback preexistente, sin cambios). Los 2 `find()` encadenados con `??` ya resuelven el self-healing entero — sin necesitar ningún mecanismo nuevo: un id que no matchea ningún proveedor/modelo (proveedor borrado, modelo deshabilitado) simplemente devuelve `undefined` y cae al siguiente nivel, mismo comportamiento que el fallback de 1 nivel que ya existía antes de esta fase.

**`ChatSession` (renderer) deja de descartar `providerId`/`modelId`:** el dato ya llegaba desde `loadChats()` (`chat-store.ts` los persiste desde Paso 3) pero se tiraba al mapear al tipo local — fix de una línea en 2 sitios (`bootstrap()`'s `restored`, y el tipo `ChatSession` mismo). `activeProvider`/`activeModel` (`useMemo`) reordenados para depender de `activeChat.providerId/modelId` — `activeChat` se calcula ahora ANTES, no después.

**`setActiveChatModel(providerId, modelId)` (nueva, `App.tsx`):** reemplaza las escrituras a `settings.activeProviderId`/`activeModelId` que `selectProvider()`/`selectModel()`/`addProvider()`/`addDeepSeekProvider()` hacían antes de esta fase — ahora escriben el `providerId`/`modelId` del **chat activo de este panel** (local `setChatSessions` + persistido a SQLite por el mismo canal que `ensureStoredChat()` ya usa, `chats:ensureSession`). `bootstrap()`/`syncCodexProvider()`/`deleteProvider()`/`deleteModel()` **sin tocar** (restricción explícita, confirmada correctamente globales en la investigación — afectan el catálogo compartido de proveedores, no la selección de un panel).

**Bug real encontrado por la propia verificación de Tarea 5, no en la investigación previa — confirmado y corregido en esta misma fase:** `ensureStoredChat(chat)` ya escribía incondicionalmente `providerId: activeProvider?.id, modelId: activeModel?.id` a SQLite desde antes de esta fase (Paso 3) — pero esos campos, al no ser leídos por nada todavía, eran inertes. Esta fase los activa (nivel 1 del fallback los lee de verdad) y expone un problema latente preexistente: **6 call sites** (`"+ Nuevo chat"`, `createProjectChat()`, el fallback de `deleteChat()` al borrar el último chat, más 3 de menor impacto en `bootstrap()`/`resetLocalState()`) llaman `ensureStoredChat(chat)` con un `chat` recién creado, en el MISMO tick síncrono que `setActiveChatId(chat.id)` — como React no re-renderiza dentro del mismo tick, la closure `activeProvider`/`activeModel` todavía apunta al chat VIEJO (el que estaba activo antes de crear el nuevo), así que el chat nuevo terminaba estampado con el proveedor/modelo del chat anterior en vez de quedar sin ninguno propio (lo que el diseño confirmado pide: nivel 1 vacío, cae correcto al default de la app en el nivel 2). **Confirmado real con CDP, no solo argumentado**: crear "+ Nuevo chat" estando activo un chat en Codex (`78948662-...`) dejó al chat nuevo con `providerId:"78948662-..."` en SQLite, pese a que el default de la app en ese momento era Gemini — reproducción exacta del bug. Fix: `ensureStoredChat()` pasa a usar `chat.providerId ?? (chat.id === activeChat.id ? activeProvider?.id : undefined)` (mismo criterio para `modelId`) — prioriza lo que el `chat` YA tiene (nunca lo pisa con un valor ajeno); solo usa la sesión conectada real de la closure cuando el `chat` recibido ES de verdad el chat activo (mismo id) Y no tiene su propio valor todavía (el caso legítimo: primer turno de un chat sin modelo propio, dentro de `sendMessage()`). `npm run typecheck`/`npm run build` limpios de nuevo tras el fix; re-verificado con el mismo CDP y el mismo escenario — el chat nuevo quedó sin `providerId`/`modelId` (`undefined` en ambos), correcto.

**Race de escritura a `settings` — mecanismo elegido: cola async explícita (`withSettingsLock()`, `runtime-state.ts`), no un mutex de librería.** Análisis real, no asumido: 2 llamadas concurrentes a `connectSessionForWindow()`/`workspace:open()` (los 2 sitios que siguen escribiendo `activeProviderId`/`activeModelId`/`activeProjectPath` como default sugerido en cada conexión exitosa — comportamiento correcto bajo la nueva semántica, no un bug) **no pierden datos entre sí hoy**: ambos hacen lectura-de-`settings`-viva → escritura de un campo angosto, sin ningún `await` en el medio — el binding `let settings` (ESM, `runtime-state.ts`) se lee en el momento exacto de la escritura, nunca desde una copia vieja. `withSettingsLock()` (una promesa encadenada, `settingsWriteQueue = settingsWriteQueue.then(() => task())`) no arregla ninguna pérdida real hoy — la hace una **garantía estructural explícita** en vez de un accidente implícito de "hoy no hay ningún `await` entre estas 2 líneas", a prueba de un refactor futuro que sí introduzca uno. **Race real, más severa, y deliberadamente NO cerrada por esta fase:** `settings:save` (`ipc-settings.ts`) hace un reemplazo TOTAL de `settings` con lo que le manda el renderer — si un renderer tenía una copia desactualizada (por ejemplo, otro panel conectó a otro proveedor mientras este renderer tenía Settings abierto con una copia vieja), guardar desde ese renderer pisa el cambio más fresco del otro panel. Una cola no resuelve esto (solo serializa ORDEN, no cambia "reemplazar" por "fusionar") — arreglarlo de verdad exigiría que `settings:save` fusione en vez de reemplazar, lo cual tocaría lógica cerca de `bootstrap()`/`deleteProvider()`/`deleteModel()` (las funciones explícitamente restringidas en esta fase). Anotado en `PENDING.md` para decidir aparte.

**Verificación real (Tarea 5, CDP contra la app real + `D:\AMATISTA\data\config\settings.json`/`amatista.db` reales, 2 rondas — la primera detectó el bug de arriba, la segunda confirma el fix):**
- **Caso 1 — concurrencia real de 2 paneles a proveedores DISTINTOS** (`panelId` simulados, `Promise.all` sin await intermedio, Foundry real + Gemini suscripción real): ambas conexiones resolvieron `{connected:true}`. `settings.json` releído después: los 10 proveedores originales completos, ninguno perdido ni corrupto — `activeProviderId`/`activeModelId` (el default sugerido) terminó en el que conectó al final (Gemini), esperado bajo la nueva semántica de "sugerencia" (no es pérdida de datos: el catálogo de proveedores, que es lo que de verdad importa no perder, quedó intacto).
- **Caso 2 — chat nuevo sin provider/model propio**: pre-fix, `"+ Nuevo chat"` real vía click simulado en el DOM dejó el chat nuevo con `providerId` del chat previamente activo (bug de arriba, confirmado real). Post-fix, misma prueba: el chat nuevo quedó con `providerId`/`modelId` `undefined` en SQLite — nivel 1 del fallback vacío, deja correctamente que `pickProvider()`/`pickModel()` resuelvan el default de la app en lectura.
- **Caso 3 — chat con un turno previo real en un modelo específico**: chat real del usuario (`YAYOSCHAT`, `providerId` Codex/`78948662-...`, `modelId` GPT-5.4) reabierto (click real en la fila del sidebar) con el default de la app apuntando a OTRO proveedor (Gemini) — el botón de modelo (`.model-btn`) renderizó `"GPT-5.4"`, confirmando que `pickProvider()`/`pickModel()` usan el nivel 1 (el propio del chat) y NO caen al default de la app cuando el chat ya tiene uno.

Base real limpiada al terminar: chat(s) de prueba borrados vía `chats:deleteSession` real, `settings.json` restaurado a `activeProviderId:"qcfg-foundry"`/`activeModelId:"qcfg-foundry-chat"` (valor previo a la Tarea 5), confirmado leyendo el archivo de vuelta; `tasklist` sin `electron.exe` colgado.

`npm run typecheck` y `npm run build`: limpios (2 rondas — antes y después del fix de `ensureStoredChat()`). Sin commit — pendiente de que el usuario lo pida explícitamente.

## Fase Paneles-2b — `<ChatPanel>` real, layout dinámico 1-4

> Cierra la Tarea 0 de investigación (`docs/_arch/verify_panels_scope.md`, sección "Paneles-2b"): parte `App.tsx` en un contenedor (shell: sidebar/topbar/Settings/overlays compartidos) + `<ChatPanel panelId={...} chatId={...}>` real, con N instancias renderizadas dinámicamente (1 a `MAX_PANELS = 4`). App.tsx pasa de "el único panel implícito" (Paneles-1/2a) a sostener de verdad múltiples conversaciones simultáneas, cada una con su propio runtime conectado.

**3 decisiones de diseño confirmadas por el usuario antes de implementar**, además de las 3 ya resueltas en Paneles-2a-implementación (`chatId` en vez de `windowId`, `chatSessions` compartido, fallback de 3 niveles):
- `openPanels: Array<{panelId, chatId}>` en memoria de `App()`, **NO persistido** — cada arranque siempre empieza con 1 panel mostrando el chat más reciente, mismo comportamiento visible que antes de esta fase.
- **Mismo chat en 2 paneles: PROHIBIDO.** Único punto real de aplicación: `openChatInPanel(chatId, targetPanelId?)` — si `chatId` ya está en algún `openPanels[i]`, SIEMPRE enfoca ese panel primero, nunca crea ni mueve nada más (ni siquiera si se pidió explícitamente un panel nuevo).
- `focusedPanelId` nuevo en `App()`, actualizado por cada `<ChatPanel>` vía `onFocus` (disparado por `onMouseDown` en la raíz del panel) — alimenta lo que el sidebar/topbar muestran como "el chat activo" hoy.

**Hallazgo real de la Tarea 0, confirmado con evidencia de descarte (no solo intuición) — resuelto en esta implementación:** ni `chat_sessions.provider_id/model_id` (mide "usado alguna vez") ni `sessionRegistry` de main (mide "conectado en vivo", perezoso — un panel recién abierto sin tocar "Conectar agente" no tiene entrada ahí) alcanzan para responder "qué paneles están abiertos ahora mismo" — `openPanels` es un concepto genuinamente nuevo, sin overlap con ninguno de los dos.

**`ChatPanel` — props en 3 grupos** (`App.tsx`, `interface ChatPanelProps`): identidad controlada por el contenedor (`panelId`, `chatId` — **el panel NUNCA decide por sí mismo qué chat mostrar**, simplificación real descubierta durante la implementación, ver más abajo); datos compartidos de solo lectura (`settings`, `chatSessions`, `chats`, `defaultWorkspace`, `codexAccountConnected`, `cliStatus`); callbacks hacia el contenedor para mutar estado compartido o pedir un overlay global (`setChatSessions`, `setChats`, `onOpenImage`, `onContextMenuRequest`, `onWorkspaceConnected`, `onStatusChange`, `onApprovalChange`, `onToolApprovalChange`, `onAddPanelForThisChat`, `onFocus`, `onClose`).

**Simplificación real no anticipada en la investigación: `activeProject` deja de ser estado.** Paneles-2 (investigación) lo había clasificado "de CADA PANEL" (un `useState` propio) porque en el diseño de UNA sola sesión existía una ventana transitoria entre "elegir un proyecto" y que `activeChatId` la reflejara (de ahí los `void disconnect()` defensivos repartidos por `openProject()`/`switchToProject()`). Con `chatId` como prop CONTROLADA por el contenedor, esa ventana deja de existir por construcción: el contenedor decide el `chatId` final ANTES de que el panel lo vea, así que `activeProject` pasa a ser puramente DERIVADO (`activeChat.workspacePath`/`workspaceName`, sin ningún `find()` contra `projects` siquiera). Un nuevo `useEffect` sobre `chatId` (dentro de `ChatPanel`) reemplaza a `switchToProject()`: conecta el workspace del chat nuevo (`api.openWorkspace()`, solo si cambió — `lastConnectedWorkspaceRef`) y desconecta el agente — generaliza exacto el mismo criterio que `openProject()` ya tenía ("un chat activo distinto puede dejar la conexión en vuelo atada al chat viejo"), ahora disparado por cambio de prop en vez de por una llamada imperativa.

**`chats` (caché de mensajes) — deviación deliberada de la clasificación de Paneles-2, documentada aquí:** la investigación lo había marcado "de CADA PANEL"; esta implementación lo deja COMPARTIDO (prop, vive en `App()`). Motivo real: `bootstrap()` carga los mensajes de TODOS los chats de una sola vez (nivel shell), y bajo la regla de "nunca 2 paneles con el mismo chat" cada `chatId` solo lo consume un panel a la vez de todos modos — duplicarlo por panel multiplicaría memoria (N copias del mismo caché) sin ningún beneficio real.

**El problema de los overlays "únicos pero disparados desde un panel" — 2 casos nuevos no cubiertos por el patrón ya resuelto en Paneles-2 (`imagePreview`/`contextMenu`):**
- `approval`/`toolApproval`: siguen siendo estado DE CADA PANEL (una aprobación pendiente es de la sesión que la generó), pero se renderizan como un único overlay a nivel `App()`. El patrón de "levantar el dato con un callback" no alcanzaba solo (los botones necesitan RESOLVER la aprobación de vuelta en el panel que la originó, y `answerApproval()`/`answerToolApproval()` son funciones internas de ESE panel, cerradas sobre su propio `api`). Resuelto sin registro de referencias por `panelId`: el panel reporta el dato YA JUNTO A una closure que lo resuelve (`ApprovalHandle{approval, onAnswer}`/`ToolApprovalHandle{title, detail, trust, onToggleTrust, onAnswer}`, vía `useEffect` sobre el estado local) — `App()` no necesita saber nada de la sesión, solo invocar la función que el panel ya le pasó. Con 2+ paneles esperando aprobación a la vez, se muestra la del panel enfocado primero, si no la primera que aparezca (mismo criterio best-effort que ya se aceptó para `imagePreview`/`contextMenu`).
- `contextMenu` tipo `'message'`/`'composer'`: el diseño anterior guardaba solo datos (`messageId`, `role`) y el propio `App()` volvía a buscar el mensaje contra `currentMessages`/llamaba `startEditMessage()` — funciones que ahora viven DENTRO de un panel específico, invisibles desde el contenedor. Rediseño más simple que el original: `ContextMenuState` para estos 2 casos pasa a llevar las closures YA armadas (`onCopy`/`onEdit?`/`onRegenerate?` para `'message'`; `onCut`/`onCopy`/`onPaste`/`onSelectAll` para `'composer'`), resueltas por el panel en el momento de pedir el menú — `App()` solo llama la función que recibió, sin volver a resolver nada. El caso `'chat'` (disparado desde el sidebar, siempre shell) sigue siendo solo datos, sin cambios.

**Rediseño visual del header de panel (parte de esta fase, no cosmético aparte):** el selector de modelo (badge + nombre + acordeón, Fase 21, lógica sin cambios) se saca del final del composer y pasa a una cabecera propia de cada `<ChatPanel>` (`.panel-header`, arriba de `.messages`) — identidad (`ProviderBadge` + nombre del chat/workspace) a la izquierda, acordeón de modelo + `.mcp.json` + "Eventos" + "Agregar panel" (⧉) + cerrar (×, solo si `canClose`) a la derecha. `.mcp.json`/"Eventos" (antes en el topbar global) se mueven acá también — ambos son datos de UNA conversación puntual (el workspace conectado, el log de eventos de esa sesión), no del shell; el topbar queda con solo lo genuinamente global ("Pantalla completa", "Modelos y cuentas"). `state-strip` (pills de workspace/proveedor/modelo/agente, warnings) se deja SIN TOCAR donde ya estaba — riesgo/alcance innecesario duplicar la información visualmente pero no funcionalmente, la pieza pedida era el SELECTOR interactivo, no las pills de solo lectura.

**Layout dinámico 1-4 — CSS Grid, no flexbox (decisión documentada):** `gridTemplateColumns`/`gridTemplateRows` calculados en JS según `openPanels.length` (`panelsGridStyle`, `useMemo`) — 1 panel: `1fr`/`1fr`; 2: `repeat(2,1fr)`/`1fr`; 3: `repeat(3,1fr)`/`1fr`; 4: `repeat(2,1fr)`/`repeat(2,1fr)`. Con flexbox, "3 columnas iguales" y "2×2" necesitarían `flex-basis`/`flex-wrap` distintos por caso; con grid, una sola propiedad por caso cubre los 4, sin CSS condicional por cantidad de paneles — sin espacio reservado de más (el grid nunca tiene más celdas que `openPanels.length`). `.chat-panel` (nuevo) es el wrapper delgado de cada instancia (`display:flex; flex-direction:column`), con un borde sutil (`box-shadow: inset`) cuando está enfocado — indistinguible con 1 solo panel (no hay nada más para comparar), relevante recién con 2+. Breakpoint nuevo (`@media max-width:900px`): se apila a 1 columna, N filas, scroll vertical — mismo criterio conservador que el resto de los breakpoints ya existentes de esta hoja de estilos.

**Sidebar/topbar generalizados a "leer del panel enfocado" (resuelve el hallazgo de la Tarea 0: ya leían datos de panel sin ser panel puro):** cada `<ChatPanel>` reporta un `PanelStatus` (`chatId`, `chatTitle`, `workspacePath`/`workspaceName`, `agentState`, `agentRuntime`, `providerId`, `modelId`) hacia `App()` vía `onStatusChange` en cada cambio relevante — `panelStatuses: Record<panelId, PanelStatus>`, `App()` lee `panelStatuses[focusedPanelId]` donde antes leía un único `activeChat`/`agentState` global. Fila de chat en el sidebar gana un tercer estado visual (`.chat-row.open-elsewhere`, más tenue que `.active`) para chats abiertos en un panel que NO es el enfocado — antes solo existían "activo" / "no activo".

**Acciones nuevas (Tarea 4) — reemplazo conceptual de "Abrir en ventana nueva" (retirado en Paneles-1):**
- **"Agregar panel"** (`addPanelForChat()`, ítem nuevo en el menú contextual de una fila de chat, mismo lugar de acceso que el botón retirado): llama `openChatInPanel(chatId)` sin `targetPanelId` — crea un panel nuevo hasta `MAX_PANELS`, o enfoca el existente si ese chat ya está abierto en alguno (la regla de no-duplicados hace el trabajo sola). Al tope, `window.alert()` explica el límite en vez de fallar en silencio.
- **Cerrar panel** (`closePanel()`, botón × en la cabecera, solo si `canClose = openPanels.length > 1` — nunca se puede cerrar el último): desconecta la sesión de ESE panel exactamente como ya se desconecta cualquier sesión hoy (`api.disconnectAgent()`, mismo call que `disconnect()` interno usa siempre) y lo saca de `openPanels`/`panelStatuses`/`panelApprovals`/`panelToolApprovals` — sin afectar a los demás paneles (cada uno es una instancia de React independiente, con su propio `sessionRegistry` en main indexado por su propio `panelId`, sin overlap posible).

**Settings/Configuración — hallazgo de Paneles-2 Tarea 3 confirmado y resuelto en el código, no solo anticipado:** `activeProvider`/`syncCodexModels()`/`checkCodexAccount()`/`syncOpenAiChatCatalog()` referenciaban el estado de UN panel implícito; ahora resuelven contra `settings.providers.find(p => p.id === focusedStatus?.providerId)` (el panel ENFOCADO) — `addProvider()`/`addDeepSeekProvider()` (que antes seleccionaban el proveedor recién creado para "el chat activo") ganan `setFocusedChatModel()`, equivalente shell-level de `setActiveChatModel()` (que sigue existiendo, sin cambios, dentro de `ChatPanel` para el acordeón de cada panel) operando sobre el `chatId` del panel enfocado en vez de un `activeChat` que ya no existe a nivel de `App()`.

**Generalización de "desconectar todo" a N paneles (`catalogChangeNonce`):** antes de esta fase, cualquier acción de Configuración que cambia el catálogo (agregar/borrar/activar-desactivar proveedor o modelo, sincronizar Codex, importar `q_config`, cerrar sesión Codex, quitar una carpeta raíz) llamaba `void disconnect()` incondicional — comportamiento crudo pero seguro con UNA sola sesión implícita. Generalizado con un contador (`catalogChangeNonce`, bumpeado por `disconnectAllPanels()`) que cada `<ChatPanel>` observa vía `useEffect` (con un `ref` que evita disparar en el montaje inicial) — cualquiera de esas acciones desconecta TODOS los paneles abiertos, no solo el que la disparó. Deliberadamente conservador (no se intentó, por ejemplo, desconectar solo los paneles cuyo proveedor cambió) — mismo nivel de precisión que ya tenía esta app antes de partir en paneles, escalado a N sin agregar ni quitar garantías.

**`bootstrap()` — simplificación real:** el bloque que abría `next.activeProjectPath` al arrancar (relevante en el diseño de un solo panel) se elimina — cada `<ChatPanel>` ya abre el workspace de SU PROPIO chat automáticamente al montarse (ver el efecto sobre `chatId` arriba), que es el dato correcto por panel; `activeProjectPath` queda exclusivamente como el default SUGERIDO (Paneles-2a), nunca como "el" workspace a abrir al inicio. `ensureStoredChat()` (con su lógica de identidad de Paneles-2a) queda exclusivamente DENTRO de `ChatPanel`, para su único caso de uso legítimo (bumpear provider/model tras un turno real); todos los call sites shell-level que creaban/migraban chats en blanco (bootstrap, migración de workspace, `resetLocalState()`, `createProjectChat` → ahora `resolveOrCreateProjectChat()`, fallback de `deleteChat()`) pasan a `persistChatSessionMeta()` (nueva, `App.tsx`) — persiste exactamente lo que el `chat` YA trae, sin la lógica de "sesión conectada" que un contexto shell no tiene.

**Verificación real (Tarea 5, CDP contra la app real + `D:\AMATISTA\data\config\settings.json`/`amatista.db` reales):**
- **1 panel al arranque** (real, sin intervención): confirmado por lectura del DOM (`document.querySelectorAll('.chat-panel').length === 1`), mostrando el chat real más reciente del usuario.
- **Agregar un 2do panel con un chat distinto** (clic derecho real en una fila del sidebar → "Agregar panel"): `count` pasó de 1 a 2, `getComputedStyle()` sobre `.panels-grid` confirmó `grid-template-columns: 645.5px 645.5px` (2 columnas iguales, partiendo el ancho real disponible) — layout dinámico confirmado, no solo argumentado.
- **Intentar abrir el mismo chat ya abierto** (mismo chat, mismo mecanismo): `count` se mantuvo en 2 — enfocó el panel existente, no creó uno nuevo. Regla de no-duplicados confirmada real.
- **Cerrar un panel**: `count` volvió a 1, el panel restante siguió mostrando sus mensajes (`querySelector('.messages')` presente) sin interrupción — cerrar uno no afectó al otro.
- **3 paneles reales conectados a runtimes DISTINTOS simultáneamente** (Foundry, Codex ChatGPT, DeepSeek — 3 conexiones reales de producción, seleccionadas y conectadas una por una vía el acordeón real de cada panel + su propio botón "Conectar agente"): las 3 resolvieron `Agente · foundry` / `Agente · codex` / `Agente · anthropic-api` respectivamente, cada una con su propio modelo (`Foundry gpt-5.4` / `GPT-5.6-Sol` / `DeepSeek V4 Pro`). Confirmado con el MISMO método `getComputedStyle()` ya usado en fases anteriores de esta sesión para verificar colores reales (no supuestos): el `background-color` de `.provider-badge` de cada panel fue `rgb(0,120,212)` / `rgb(16,163,127)` / `rgb(77,107,254)` — los 3 valores EXACTOS de `PROVIDER_BRAND.foundry`/`.openai`/`.deepseek`, confirmando que cada panel mantiene su propia identidad visual real, sin mezclarse entre sí.

Base real limpiada al terminar: los 4 chats de prueba creados durante la verificación borrados vía `chats:deleteSession` real, `settings.json` restaurado a `activeProviderId:"qcfg-foundry"`/`activeModelId:"qcfg-foundry-chat"` (valor previo a la Tarea 5, los 10 proveedores confirmados intactos), `tasklist` sin `electron.exe` colgado.

`npm run typecheck` y `npm run build`: limpios. Sin commit — pendiente de que el usuario lo pida explícitamente.

## Fix Gemini CLI: `geminiCommand()`, bug real de arg-splitting con `shell:true`

> Bug pre-existente (no introducido por la limpieza de claude-cli, confirmado ahí mismo), encontrado y ya documentado como pendiente en esa fase: `sendGemini()` fallaba contra el binario real con `"Cannot use both a positional prompt and the --prompt (-p) flag together"`. Investigación previa (Tarea 0, sin implementar nada) reprodujo el bug en vivo y confirmó el mecanismo exacto antes de tocar código — ver la sección de investigación más abajo para el detalle completo; esta sección documenta el FIX ya implementado y verificado.

**Causa raíz confirmada, no asumida:** `sendGemini()` spawneaba con `spawn('gemini', args, {shell: process.platform === 'win32'})`. En Windows, `gemini` resuelve al shim `.cmd` que genera `npm install -g` (`%APPDATA%\npm\gemini.cmd`) — `spawn()` sin `shell:true` no puede invocar un `.cmd` por nombre (`Error: spawn gemini ENOENT`, confirmado real), así que `shell:true` era necesario. Pero `shell:true` **concatena** el array de args en una sola línea de comando en vez de citar cada elemento (advertencia de deprecación del propio Node: *"the arguments are not escaped, only concatenated"*) — un prompt multilínea real (`formatContextEnvelope()`, con saltos de línea y espacios) se parte en decenas de argv sueltos al pasar por `cmd.exe`, y Gemini CLI ve `-p` emparejado solo con el primer fragmento, con el resto del prompt reinterpretado como argumentos posicionales. Reproducido en vivo con un prompt de prueba multilínea real: mismo error, palabra por palabra, que el reportado en producción.

**Fix: `geminiCommand()` (`cli-agent-runtime.ts`, nueva), mismo patrón que `claudeCommand()` (retirado en la limpieza de claude-cli) resolvía para Claude — resolver la ruta real del ejecutable evita el problema de raíz en vez de intentar escapar mejor el argumento.** Diferencia real con Claude: el entrypoint de `@google/gemini-cli` es un script `.js` (`bundle/gemini.js`), no un `.exe` — no se puede invocar solo, necesita un runtime Node. Resuelto leyendo `package.json.bin.gemini` del paquete real bajo `%APPDATA%\npm\node_modules\@google\gemini-cli\` — **decisión deliberada, no la más obvia**: en vez de hardcodear la ruta relativa (`"bundle/gemini.js"`, que también funcionaría hoy), se lee el campo `bin` del propio `package.json` — más robusto a que una versión futura del paquete reestructure su bundle interno (los nombres `chunk-XXXX.js` de esta instalación real NO son deterministas entre versiones, confirmado con `ls`; `bin.gemini` es el contrato público que el propio `npm` usa para generar su shim `.cmd`, garantizado estable mientras el paquete siga exponiendo el comando `gemini`). `existsSync()` sobre la ruta resuelta antes de usarla — si no existe (o `APPDATA` ausente, o plataforma no-Windows), `geminiCommand()` devuelve `null` y `sendGemini()` cae al mecanismo viejo exacto (`spawn('gemini', args, {shell: process.platform === 'win32'})`) — sin regresión para quien no tenga el paquete instalado bajo esa ruta esperada, ni para plataformas no-Windows (donde este problema no existe: sin `.cmd`/`cmd.exe` de por medio, `spawn()` sin shell ya invoca directo el shebang real del binario `gemini`).

**Spawn con la ruta resuelta: `process.execPath` + `ELECTRON_RUN_AS_NODE:'1'`, `shell:false`** — MISMO patrón exacto, ya probado en producción, que `lsp-client.ts` (Fase 20) usa para arrancar `typescript-language-server`: evita depender de que el usuario tenga `node` en el PATH del sistema (Electron ya trae un runtime Node completo propio).

**Verificación real — no el script standalone de la investigación, la CLASE REAL (`CliAgentRuntime`, `cli-agent-runtime.ts`, bundleada standalone con `esbuild` — mismo mecanismo ya usado en esta sesión para `chat-store.ts`, Fase 21.5) instanciada y usada tal cual la usa `ipc-agent.ts` en producción:** mismo prompt largo y multilínea que reprodujo el bug original, vía `runtime.configure({kind:'gemini', ...})` + `runtime.send(prompt)` reales. **El error de parseo NO aparece más** — el proceso avanza hasta lógica interna real del CLI (deja de romper en el parser de argumentos). Falla después por algo completamente distinto, ya identificado en la investigación previa y **fuera de alcance de este fix, sin tocar**: `IneligibleTierError: This client is no longer supported for Gemini Code Assist for individuals` — un rechazo de elegibilidad de cuenta/tier del lado de Google (la cuenta de Gemini de esta máquina está en un tier ya no soportado para uso vía CLI headless), documentado como **limitación conocida de la cuenta, no como que el fix no funcionó** — la métrica de éxito de este fix es "el prompt llega intacto al CLI" (confirmado), no "el turno completa" (depende de una cuenta que tiene un problema aparte, sin relación con cómo se le pasan los argumentos).

`npm run typecheck` y `npm run build`: limpios. Sin commit — pendiente de que el usuario lo pida explícitamente.

## Fix carrera de `settings:save`: merge por campo en vez de reemplazo total

> Cierra el hallazgo documentado desde Paneles-2a (`docs/_arch/PENDING.md` → "`settings:save` — reemplazo total en vez de fusión"), investigado a fondo en `docs/_arch/verify_settings_race.md` (5 tareas, reproducción real del riesgo confirmada ANTES de diseñar el fix). Con Paneles-2b construido (paneles reales conectando en paralelo), el hallazgo dejó de ser solo teórico.

**Diagnóstico confirmado por la investigación, no solo por el hallazgo original:** el renderer llama `settings:get` **una sola vez, al arrancar** (`bootstrap()`) — nunca se vuelve a refrescar durante la sesión. Cualquiera de las **12 acciones de usuario reales** que disparan `settings:save` (`toggleProvider`, `addProvider`, `deleteProvider`, `deleteModel`, `toggleModel`, `setCompactionModel`, `addProjectRoot`, `onWorkspaceConnected`, `syncCodexModels`, `loginCodex`, `checkCodexAccount`, el botón "Guardar cambios") manda una copia de `AppSettings` que puede llevar horas de antigüedad para los campos que MAIN actualiza de forma autónoma (`connectSessionForWindow()`/`workspace:open()`, vía `withSettingsLock()` — Paneles-2a). No era una carrera de milisegundos: era una pérdida garantizada bajo el orden de eventos MÁS COMÚN (main escribe algo autónomo, después cualquier acción de Configuración guarda). Reproducido en vivo antes del fix: conectar un panel real a Gemini actualizaba `activeProviderId` correctamente; un `settings:save` posterior con la copia del renderer lo revertía en silencio a Foundry.

**Frontera de propiedad de los 8 campos de `AppSettings`, confirmada con evidencia (Tarea 4 de la investigación), no supuesta:**
- **Renderer-owned, main nunca los toca en vivo:** `providers`, `compactionProviderId`, `compactionModelId`, `turnWatchdogSeconds`.
- **Main-owned, escritos de forma autónoma vía `withSettingsLock()` como efecto secundario de conectar un agente o abrir un workspace — NO desde Configuración:** `activeProviderId`, `activeModelId`, `activeProjectPath`.
- **`projectRoots` — caso mixto, resuelto por partes (ver más abajo):** tiene 2 canales de escritura reales, `projects:addRoot`/`projects:removeRoot` (main, `ipc-projects-workspace.ts`) y el propio `addProjectRoot()` del renderer (`App.tsx`) — ambos genuinamente INCREMENTALES (agregan/sacan un elemento por `id`/`path`, nunca reemplazan la lista completa), pero investigados a fondo (Tarea 0 puntual, antes de este fix) reveló que el segundo canal era **enteramente redundante**: para el momento en que corre, el primero (invocado por el propio `addProjectRoot()`, `await`eado) YA agregó y persistió el root real a disco — el segundo guardado no sumaba nada, solo repetía la escritura arrastrando una copia potencialmente vieja de TODO lo demás.

**Fix, 2 partes:**

1. **`settings:save` (`ipc-settings.ts`) deja de reemplazar `settings` entero — fusiona campo por campo:**
```ts
ipcMain.handle('settings:save', (_event, nextSettings: AppSettings) => {
  const sanitized = sanitizeSettings(nextSettings)
  setSettings({
    ...settings,
    providers: sanitized.providers,
    compactionProviderId: sanitized.compactionProviderId,
    compactionModelId: sanitized.compactionModelId,
    turnWatchdogSeconds: sanitized.turnWatchdogSeconds
  })
  saveSettings(settings)
  return { success: true }
})
```
`sanitizeSettings()` sin cambios (misma validación/migración de siempre) — se sigue aplicando sobre el payload completo entrante, pero del resultado solo se toman los 4 campos genuinamente renderer-owned. Los otros 4 (`activeProviderId`/`activeModelId`/`activeProjectPath`/`projectRoots`) se **ignoran del payload por completo** — ni se comparan, main siempre gana con su propio `settings` vivo (leído en el mismo handler síncrono, sin ningún `await` de por medio, misma atomicidad ya establecida para `withSettingsLock()` — sin necesitar el lock acá, restricción explícita de esta fase: no tocar `withSettingsLock()`/`connectSessionForWindow()`/`workspace:open()`).

2. **`addProjectRoot()` (`App.tsx`) pierde su guardado redundante:** el `mutateSettings(...,true)` que seguía al `await window.universalAgent.addProjectRoot()` (Canal 1, ya persistido) pasa a `mutateSettings(...)` sin el flag de guardado — actualiza React localmente para que el sidebar pinte el root nuevo, sin disparar un segundo `settings:save`. Con el fix de la parte 1 esto es defensa en profundidad, no la única protección: aunque este segundo guardado siguiera existiendo, `settings:save` ya ignoraría `projectRoots` de su payload — pero sacarlo evita el trabajo/IO redundante y sigue el diseño confirmado.

**Verificación real (mismo escenario exacto de la Tarea 3 de la investigación, repetido tal cual contra la app ya arreglada):**
- **Antes del fix:** panel real conecta a Gemini → `settings.json` correcto (`activeProviderId: qcfg-gemini-subscription`) → `settings:save` con la copia vieja del renderer → `settings.json` revertido a `qcfg-foundry`. Pérdida confirmada.
- **Después del fix, mismo script, mismo orden de eventos:** panel real conecta a Gemini → `settings.json` correcto → `settings:save` con la MISMA copia vieja → `settings.json` releído: **`activeProviderId: qcfg-gemini-subscription` sigue ahí** — el cambio real de main sobrevivió. `PERDIDA DE DATOS CONFIRMADA: false`.
- **`projectRoots` concurrente:** 2 roots de prueba sembrados reales, 2 llamadas a `projects:removeRoot` disparadas con `Promise.all` (sin `await` entre ellas, mismo criterio de concurrencia ya usado en Fase 22b/Paneles-2a) — ambas remociones surtieron efecto (ninguna se pisó), el root real preexistente (`YAYOSCHAT`) quedó intacto. Nota metodológica: el otro canal (`projects:addRoot`) usa un diálogo nativo de carpeta que no se puede automatizar 2 veces "a la vez" vía CDP — se verificó la MISMA garantía de atomicidad (lectura-viva-y-escritura sin `await` de por medio) con `removeRoot`, mismo patrón exacto de handler, sin diálogo de por medio.

Base real limpiada al terminar: `activeProviderId`/`activeModelId` restaurados a `qcfg-foundry`/`qcfg-foundry-chat` (editado directo en disco con la app cerrada — confirmado, con el fix ya puesto, que `settings:save` desde el renderer **ya no puede** usarse para restaurar estos 3 campos, ni siquiera para limpieza de datos de prueba, exactamente el comportamiento buscado), `projectRoots` de prueba eliminados, 10 proveedores confirmados intactos, `tasklist` sin `electron.exe` colgado.

`npm run typecheck` y `npm run build`: limpios. Sin commit — pendiente de que el usuario lo pida explícitamente.

## Fase Paneles-3 — auto-open real: main pide, renderer abre y conecta

> Cierra el árbol Paneles-2/3/4 original (`docs/_arch/PENDING.md`): `sendToWindowByTitle()` (`cross-window-messaging.ts`) dejaba de intentar nada apenas el chat destino no tenía panel conectado en vivo — regresión temporal documentada desde Paneles-1. Basado en la investigación previa (`verify_panels_scope.md`, sección Paneles-3), que confirmó con evidencia real 4 hechos antes de diseñar nada: ningún `ChatPanel` se autoconecta al montarse (abrir ≠ conectar, son 2 pasos separados); `requestSessionToolApproval()` no es reusable tal cual (su mapa vive DENTRO de una sesión que todavía no existe para este caso); `window.alert()` al tope de `MAX_PANELS` es bloqueante y congela TODA la app, no solo el intento nuevo; la protección de auto-envío se hereda gratis por orden de ejecución, la de no-duplicados NO.

**Mecanismo de correlación, variante propia (no reutiliza `requestSessionToolApproval()`):** `pendingPanelOpenRequests: Map<requestId, resolve>` — **global, a nivel de módulo** en `cross-window-messaging.ts`, no dentro de `SessionRuntimeState` (el panel destino no existe todavía, no hay sesión real donde guardarlo). Evento nuevo `sendToShell()` (`runtime-state.ts`, variante de `sendToWindow()` sin `panelId` embebido — dirigido al SHELL, `App()`, siempre montado, no filtrado por panel) manda `panel:openAndConnectRequest` con `{requestId, chatId}`. Respuesta real del renderer (`panel:openAndConnectResponse`, `ipc-agent.ts`, import dinámico de `cross-window-messaging.js` por el mismo motivo de ciclo de módulos ya documentado para `sendToWindowByTitle`) resuelve con un **objeto**, no un booleano: `{success, panelId?, error?}`.

**Timeout real, justificado con números ya medidos en este codebase, no arbitrario: `PANEL_OPEN_AND_CONNECT_TIMEOUT_MS = 8000`.** Margen sobre el peor caso YA medido para "arrancar un proceso real y esperar handshake" (LSP cold-start, ~2.7-3.7s, Fase 20 — la misma base que justificó `DIAGNOSTICS_WAIT_TIMEOUT_MS = 5000` en `lsp-manager.ts`). Este flujo es una operación equivalente o más lenta, nunca más rápida: además de conectar un runtime real, agrega un roundtrip de React completo (montar/reusar el panel) que el timeout de LSP no tenía que cubrir — 8s deja margen real para la SUMA de los 2 pasos, no solo uno.

**El guard de "nunca usado" (Paso 3 original, subsumido por Paneles-1) se restaura explícito, ANTES del auto-open:** si `match.providerId`/`match.modelId` (ya resueltos por `findChatSessionByTitle()`) faltan, falla limpio de una — no tiene sentido gastar el timeout del handshake en un chat que estructuralmente no puede conectarse a nada. Confirmado real: **2ms** de respuesta (no ~8000ms), sin ningún panel nuevo abierto.

**El handshake completo, en el renderer (`App.tsx`) — 2 pasos, tal como anticipó la investigación:**
1. `handlePanelOpenAndConnectRequest(requestId, chatId)`: llama a `openChatInPanel(chatId)` **real**, sin excepción — nunca escribe `setOpenPanels()` directo. Modificada para devolver el `panelId` real que terminó usando (calculado DENTRO del propio updater de `setOpenPanels()`, preservando la misma seguridad ante llamadas rápidas que ya tenía Paneles-2b — React invoca el updater de forma síncrona al llamarlo). Si `openChatInPanel` devuelve `null` (tope de `MAX_PANELS`), responde a main de una, sin esperar nada más.
2. Si se abrió/enfocó un panel real, `App()` marca ese `panelId` como pendiente de auto-conexión (`pendingAutoConnect`, nuevo estado) — el `ChatPanel` con ESE `panelId` recibe un prop nuevo (`autoConnectRequestId`, no-null solo mientras dura el pedido) y dispara `connectAgent()` solo (mismo mecanismo interno que ya usaban `runTurn()`/`sendPrompt()`/el botón manual, ahora programático vía un `useEffect` nuevo). El resultado (éxito/error) vuelve a `App()` vía `onAutoConnectResult`, que recién ahí responde a main.

**Fix de `MAX_PANELS`/`window.alert()` (necesario para este flujo, y bug real preexistente independiente de él):** `window.alert()` — bloqueante, congelaba TODA la app (los 4 paneles, no solo el intento nuevo) hasta que un humano hacía click, sin timeout — se reemplaza por `setNotice()`, el mismo mecanismo no bloqueante que ya usa el resto de la app. Aplica IGUAL para el flujo humano ("Agregar panel" desde el menú contextual) y el automático (esta fase) — un solo cambio cierra ambos casos.

**Verificación real (CDP contra la app real, Foundry real, `settings.json`/`amatista.db` reales — 3 casos, cada uno con evidencia directa, no simulada):**
- **CASO A (auto-open completo):** chat destino real con `providerId`/`modelId` reales (creado y configurado vía la UI real, no vía IPC directo — un intento inicial que sí uso IPC directo produjo un `FOREIGN KEY constraint failed` real y reproducible, diagnosticado a fondo: **no era un bug de la implementación** sino un artefacto de la propia prueba — `ensureChatSession()` invocado directo desde CDP escribe a SQLite pero nunca actualiza el `chatSessions` de React, produciendo un chat "imposible en producción" que ningún flujo real puede generar; con el chat creado por el camino real, el problema desapareció por completo). Con ese chat SIN ningún panel abierto: `send_to_window` real → `.chat-panel` pasó de 1 a 2 (`getComputedStyle()` confirmó `grid-template-columns: 645.5px 645.5px`, layout dinámico real) → el panel nuevo conectó solo (`Agente · foundry`, `Foundry gpt-5.4`) → el turno real corrió (`{ok:true, text:"LISTO"}`) → el chat de ORIGEN recibió el mensaje entregado real (`crossWindow: {direction:'received', windowLabel:'Chat nuevo', providerType:'foundry'}`). Tiempo total: ~1.9s, muy por debajo del timeout de 8s.
- **CASO B (guard de "nunca usado"):** chat real sin `providerId`/`modelId` → falla en **2ms** con el mensaje claro esperado, `.chat-panel` count sin cambios — confirmado que el auto-open ni se intenta.
- **CASO C (tope de `MAX_PANELS`, no bloqueante):** 4 paneles reales abiertos (el tope real) → intento de un 5º (mismo mecanismo de UI, "Agregar panel") resolvió en 674ms (nunca colgó esperando un `window.alert()` que nadie iba a cerrar) → paneles finales: 4, no 5 → sidebar/`+ Nuevo chat` seguían respondiendo, confirmando que la app nunca se congeló.
- **Protección de auto-envío:** sin tocar, corre en el mismo punto de siempre, antes de cualquier intento de auto-open (confirmado por lectura del orden real del código, no reordenado en esta fase).
- **Protección de no-duplicados:** confirmada real en CASO A — el auto-open pasa exclusivamente por `openChatInPanel()`, ningún camino paralelo.

Scaffold temporal de verificación (`debug:sendToWindowByTitle`, mismo patrón ya usado en Paneles-1/UI Paso 1 — invoca `sendToWindowByTitle()` real sin depender de que un LLM real frasee la tool call) y el diagnóstico temporal que encontró la causa real del `FOREIGN KEY` (un `console.error` puntual en el `catch` de `sendToWindowByTitle`) retirados por completo, confirmado con `grep`. Base real limpiada: todos los chats de prueba borrados vía `chats:deleteSession` real, solo el chat real preexistente del usuario (`YAYOSCHAT`) sobrevive; `activeProviderId`/`activeModelId`/`providers` confirmados sin cambios (las conexiones de prueba usaron `qcfg-foundry`, que ya era el default); `tasklist` sin `electron.exe` colgado.

`npm run typecheck` y `npm run build`: limpios. Sin commit — pendiente de que el usuario lo pida explícitamente.

## Fix bug de contraste real — botones "Desactivar/Activar"/"Eliminar" en Conexiones (Settings)

**Causa confirmada (extracción mecánica previa, `docs/_arch/verify_contrast_bug.md`):** los 2 `<button>` dentro de `.connection-actions` (`App.tsx`) nunca tuvieron `className` — sin ninguna regla propia en `main.css`, caían al estilo por defecto del navegador (gris sobre gris, ilegible sobre el fondo `#202020` del panel). Las clases `.connection-toggle`/`.danger-link` que existían en `main.css` (2 bloques: uno base en la zona de `.connection-main`, otro con overrides `!important` en la zona responsive) eran **código huérfano** — ningún JSX del árbol actual las referencia (`grep -n -B3 -A15 "connection-toggle\|danger-link" App.tsx` → sin salida); pertenecían a una estructura JSX anterior. Confirmado con un segundo `grep -rn` sobre todo `src/` inmediatamente antes de borrarlas, no solo por inspección puntual.

**Fix — 2 clases nuevas, reusando el tono ya establecido por `.root-remove`/`.reset-local` (`main.css`, acción destructiva chica inline), no un rojo genérico inventado:**
```css
.connection-actions { display: flex; align-items: center; gap: 4px; }
.connection-action { border: 0; background: transparent; cursor: pointer; padding: 4px 8px; border-radius: 6px; font-size: 10px; color: #8d8d8d; }
.connection-action:hover { color: #ddd; }
.connection-action-danger { color: #9b7272; }
.connection-action-danger:hover { color: #d38d8d; }
```
```tsx
<button className="connection-action" onClick={() => toggleProvider(provider.id)}>
  {provider.enabled ? 'Desactivar' : 'Activar'}
</button>
<button className="connection-action connection-action-danger" onClick={() => deleteProvider(provider.id)}>Eliminar</button>
```
Los 2 bloques huérfanos (`.connection-toggle, .danger-link { ... }` base y su override `!important`) se eliminaron de `main.css` por completo.

**Verificación real (CDP, `getComputedStyle()` sobre los botones reales renderizados en Settings — mismo criterio ya usado para `PROVIDER_BRAND`, no juicio visual):**
- `Desactivar`: `color: rgb(141, 141, 141)` (`#8d8d8d`) — className confirmado `connection-action`.
- `Eliminar`: `color: rgb(155, 114, 114)` (`#9b7272`) — className confirmado `connection-action connection-action-danger`.
- Fondo real detrás de ambos (`.settings-panel`): `rgb(32, 32, 32)` (`#202020`).
- Contraste real resultante: ≈5:1 (`Desactivar`/`Activar`) y ≈4:1 (`Eliminar`) sobre `#202020` — ambos ya por encima del contraste que la propia app usa hoy para texto secundario (`.connection-main small`, `#777` sobre `#202020` ≈4:1), consistente con el resto de la UI, no un valor inventado para este fix.

Base real: verificación fue solo lectura de DOM/CSS + un click en el botón ⚙ de Settings (sin escribir ningún dato de prueba en `amatista.db`/`settings.json`) — sin necesidad de limpieza de datos. `tasklist` sin `electron.exe` colgado tras el cierre.

`npm run typecheck` y `npm run build`: limpios. Sin commit — pendiente de que el usuario lo pida explícitamente.

## Fix bug real — selector de modelo invisible al abrirlo en un `<ChatPanel>`

**Causa confirmada:** `.model-menu` seguía con `bottom: 42px` (2 reglas en `main.css` — la base, línea 203, y un override `!important` de la era "V0.3.8 — model menu must render above the fixed composer", línea 573), heredado de cuando `.model-btn` vivía al final del composer fijo (Fase 21) y el menú necesitaba desplegarse HACIA ARRIBA para no quedar tapado por el composer. Paneles-2b movió `.model-btn` a `.panel-header` (arriba del panel) sin ajustar esta regla — el menú seguía intentando desplegarse hacia arriba desde un botón que ya está en el borde superior del panel, quedando renderizado fuera del área visible de `.chat-panel` (`overflow: hidden`).

**Fix — 2 reglas cambiadas, mismo criterio en ambas (`bottom: 42px` → `top: calc(100% + 6px)`), sin tocar ningún otro valor (`right: 0`, `width`, `max-height`, `z-index`, etc. intactos):**
```css
/* main.css:203 (base) */
.model-menu { position: absolute; right: 0; top: calc(100% + 6px); width: 340px; ... }

/* main.css:573-580 (override, bloque "V0.3.8") */
.model-menu {
  position: absolute !important;
  top: calc(100% + 6px) !important;
  right: 0 !important;
  z-index: 260 !important;
  max-height: min(430px, calc(100vh - 230px)) !important;
  overflow-y: auto !important;
}
```
El resto del bloque "V0.3.8" (`.composer-zone`/`.composer { overflow: visible !important }`, `.model-anchor { z-index: 220 !important }`, `.composer-row`) se dejó sin tocar — fuera de alcance de este fix puntual, sin evidencia de que sea código muerto.

**Verificación real (CDP, `getComputedStyle()` + `getBoundingClientRect()` reales sobre la app en producción, no solo que el CSS compile):**
- **1 panel abierto:** `.chat-panel` real `{top:46, bottom:915}`. Menú real `{top:92, bottom:518}` — `computedTop: "40px"` (relativo al ancla), completamente dentro del panel (`visibleHeight: 426` de 426, sin recorte).
- **4 paneles reales abiertos (grid 2x2, panel probado = el de más a la derecha, el más angosto: `width: 645.5px`, `height: 434px`):** `.chat-panel` real `{top:481, bottom:915}`. Menú real `{top:527, bottom:953}` — nace inmediatamente debajo del botón, dentro del panel (`menuTopWithinPanel: true`); su cola se recorta contra el borde inferior del panel (`visibleHeight: 388` de 426, 38px tapados) porque el panel mide menos que el `max-height` del menú — comportamiento esperado y aceptable (el menú ya tiene `overflow-y: auto`, el resto es alcanzable con scroll), muy distinto del bug original (menú 100% invisible, fuera del área del panel).

Base real: verificación creó 3 chats en blanco de prueba ("Chat nuevo") vía `+ Nuevo chat` para poder abrir 4 paneles reales (`Agregar panel` desde el menu contextual, 1 por chat distinto — la regla de no-duplicados de `openChatInPanel()` impide abrir el mismo chat 2 veces) — los 3 borrados vía `Borrar chat` real al terminar, solo `YAYOSCHAT` (el chat real preexistente) sobrevive. `tasklist` sin `electron.exe` colgado.

`npm run build` (incluye `typecheck`): limpio. Sin commit — pendiente de que el usuario lo pida explícitamente.

## Fix bug real — `addPanelForChat()` reabría el chat de origen en vez de crear uno nuevo

**Causa confirmada (docs/_arch/verify_panel_bugs.md, Tarea 0):** `addPanelForChat(chatId)` llamaba `openChatInPanel(chatId)` directo con el chatId de ORIGEN — la regla de no-duplicados de `openChatInPanel()` (correcta y sin tocar en este fix) hacía que esto simplemente enfocara el panel ya abierto de ese chat, en vez de agregar nada. `createProjectChat()` (la función que el flujo de "Agregar panel" debía imitar para crear un chat nuevo en el mismo workspace) ya no existe — fue reemplazada en Paneles-2b por `resolveOrCreateProjectChat(project: ProjectEntry, forceNew: boolean)`, que depende de un `ProjectEntry` completo (`id`/`name`/`path`/`rootId`, los 4 obligatorios — `src/shared/types.ts:209-214`). Un chat de origen solo trae `workspacePath`/`workspaceName` (ambos opcionales en `ChatSession`) — nunca un `id`/`rootId` real de proyecto, y fabricarlos habría sido inventar dato de dominio que no existe.

**Fix, 2 partes (TAREA 1 + TAREA 2):**
1. **Extraída `resolveOrCreateChatForPath(path, name, forceNew)`** — la lógica real (buscar existente por `workspacePath`, o crear uno nuevo) sin depender de `ProjectEntry`. `resolveOrCreateProjectChat()` pasa a ser un wrapper delgado sobre este helper. Los 3 call sites (`openProjectInFocusedPanel`, `newProjectSessionInFocusedPanel`, `addPanelForChat`) lo reusan.
2. **`addPanelForChat(chatId)` reescrita:** busca el `ChatSession` de origen por id; si no tiene `workspacePath`, avisa con `setNotice()` y no hace nada; si lo tiene, llama `resolveOrCreateChatForPath(origin.workspacePath, origin.workspaceName ?? origin.title, true)` (siempre `forceNew=true`, nunca reutiliza) y abre el chat RESULTANTE en un panel nuevo — nunca el chatId de origen.

`npm run build` (typecheck incluido): limpio.

**Verificación real — 3 casos:**

- **CASO A + CASO C (juntos, misma corrida, CDP real sobre `YAYOSCHAT`, siempre clickeando la fila original sin tocar nunca los clones):**

  | | filas en sidebar | paneles abiertos |
  |---|---|---|
  | Antes | 6 | 1 |
  | Tras 1er "Agregar panel" | 7 (+1 chat nuevo, mismo `workspaceName: YAYOSCHAT`) | 2 (+1 panel nuevo) |
  | Tras 2do "Agregar panel" (mismo origen) | 8 (+1 chat nuevo DISTINTO del anterior) | 3 (+1 panel nuevo) |

  2 chats nuevos y distintos, 2 paneles nuevos, origen nunca reabierto/enfocado.

- **CASO B (guard "sin workspace"):** hallazgo real durante la verificación — ningún chat visible en el sidebar puede tener `workspacePath` falsy en el estado actual de la app: `workspace:default` (`src/main/ipc-projects-workspace.ts:82-85`) nunca devuelve `null` (`{ path: defaultChatWorkspace(), name: 'General' }`), y `bootstrap()` migra automáticamente cualquier chat heredado sin workspace a ese default en cada carga. El guard es código correcto y defensivo (protege el campo opcional del tipo), pero inalcanzable por un flujo real de usuario hoy. Se verificó igual, inyectando un `ChatSession` sin `workspacePath` directo en el hook `useState` real de React (acceso vía `__reactFiber$`, sin tocar código fuente, sin persistir nada a disco — reversible en memoria) y disparando "Agregar panel" sobre esa fila real: `.notice` (dentro de Settings, único lugar donde se monta) mostró exactamente `"Este chat no tiene workspace -- no se puede agregar panel."`, `panelCount` no cambió (1→1), y no se creó ningún chat nuevo real. Guard confirmado funcionando en runtime real, no solo por lectura de código.

Base real: toda la manipulación de CASO B fue en memoria de React (dispatch directo al hook, nunca `ensureChatSession()`/persistencia) — confirmado sin rastro en disco releyendo `loadChats()` tras relanzar la app: solo `YAYOSCHAT` (157 mensajes intactos). CASO A/C sí crearon chats reales (mismo mecanismo que cualquier "Agregar panel" real) — todos identificados por NO tener mensajes (`messageCount: 0`) vs. el `YAYOSCHAT` real, y borrados vía `deleteChatSession()` real. `tasklist` sin `electron.exe` colgado en ningún punto.

`npm run build` (typecheck incluido): limpio. Sin commit — se junta con el fix del selector de modelo (FIX 1), pendiente de que el usuario pida el commit.

## Falso positivo descartado + fix real distinto — menú contextual del composer

**Causa reportada, descartada por evidencia (no por asumir):** se pidió agregar una rama `'composer'` al render de `contextMenu` (`App.tsx:3748`) porque un `grep` de `contextMenu.type === 'composer'` no encontraba nada. Esa rama YA EXISTE — es el `else` final del ternario `contextMenu.type === 'chat' ? (...) : contextMenu.type === 'message' ? (...) : (...)`; como el tipo unión solo tiene esos 3 miembros no-`null`, el `else` final captura exactamente `'composer'` sin necesitar una comparación explícita (por eso el `grep` de esa comparación literal no encontraba nada — no existe, ni hace falta). Confirmado con CDP real: click derecho en el composer muestra el menú con `["Cortar","Copiar","Pegar","Seleccionar todo"]`. No se tocó esa rama.

**Bug real distinto, encontrado durante la misma verificación:** "Seleccionar todo" no dejaba ninguna selección visible/usable — `textarea.selectionStart/End` quedaba colapsado al final del texto en vez de cubrir `[0, longitud]`. Root cause diagnosticado con un `console.error` temporal instrumentado dentro de `selectAllComposerText()` (retirado al cerrar, confirmado con `grep`): la función llamaba `setSelectionRange()` de forma síncrona, y el `setContextMenu(null)` que corre inmediatamente después (mismo handler del botón) dispara un re-render que pisa esa selección antes de que el usuario la vea. `cutComposerText()`/`pasteComposerText()` (mismo archivo) ya evitaban exactamente este problema envolviendo su `setSelectionRange()` final en `requestAnimationFrame()` — `selectAllComposerText()` era la única de las 3 que no lo tenía.

**Fix:**
```ts
function selectAllComposerText(): void {
  requestAnimationFrame(() => {
    const ta = textareaRef.current
    ta?.focus()
    ta?.setSelectionRange(0, ta.value.length)
  })
}
```
(`ta.value.length` en vez de `prompt.length` — lee el DOM real en el momento en que el callback corre, no el `prompt` cerrado en el closure, que podía haber quedado desactualizado tras el re-render intermedio.)

**Verificación real (CDP, un solo flujo continuo, sin contaminación entre pasos):** escribir "HOLA MUNDO PRUEBA FINAL" (23 caracteres) → Seleccionar todo → `{start:0, end:23}`, selección completa confirmada → Copiar → clipboard real `=== "HOLA MUNDO PRUEBA FINAL"` → escribir "PREFIJO-" → Pegar → composer `=== "PREFIJO-HOLA MUNDO PRUEBA FINAL"` → Seleccionar todo + Cortar → composer queda `""` (confirma que Seleccionar todo sí cubrió TODO el texto antes de cortar) y clipboard tiene el texto cortado completo. Los 4 pasos correctos, en cadena, sobre texto real.

**Nota metodológica real, no del código de la app:** los clicks reales de CDP (`Input.dispatchMouseEvent` en coordenadas) resultaron poco confiables contra este overlay puntual (`.context-menu`, position fija por coordenadas de apertura) — a veces no disparaban el handler en absoluto (confirmado con el propio `console.error` de diagnóstico: cero logs pese a "click exitoso" reportado). Se cambió a `button.click()`/`dispatchEvent(contextmenu)` sintético para la verificación final, que sí dispara el mismo pipeline de eventos sintéticos de React que un click real — mismo criterio que el falso positivo del `FOREIGN KEY` de Paneles-3 (artefacto de la prueba, no de la app).

`npm run build` (typecheck incluido): limpio. Sin commit — se junta con FIX 1/FIX 2, pendiente de que el usuario pida el commit.

## Fix bug real — nombrado de paneles nuevos: `addPanelForChat()` generaba títulos duplicados

**Causa confirmada (docs/_arch/verify_panel_naming.md):** el fix anterior de `addPanelForChat()` (`resolveOrCreateChatForPath(..., forceNew=true)`) crea un `ChatSession` **realmente distinto** en cada "Agregar panel" (ids reales distintos, confirmado ya en la fase previa) — pero le pasaba el MISMO nombre (`origin.workspaceName ?? origin.title`) sin desambiguar. 2 clicks seguidos producían 2 chats con ids distintos pero **título idéntico**. `findChatSessionByTitle()` (`chat-store.ts:167-180`, usado por `send_to_window`) resuelve por título con `ORDER BY updated_at DESC LIMIT 1` — con títulos duplicados, un mensaje dirigido "al panel de antes" terminaba en el panel **más reciente** con ese título (el que tuvo actividad último), nunca necesariamente en el que el usuario realmente quería.

**Fix — vive solo en `addPanelForChat()`, `resolveOrCreateChatForPath()` sin tocar (sigue correcto para los otros 2 call sites, que ya usan nombres de proyecto genuinamente distintos):**
```ts
function generateUniquePanelTitle(baseName: string): string {
  let suffix = 2
  while (true) {
    const candidate = `${baseName} — Panel ${suffix}`
    const taken = chatSessions.some(chat => chat.title.toLowerCase() === candidate.toLowerCase())
    if (!taken) return candidate
    suffix += 1
  }
}
```
Comparación case-insensitive contra `chatSessions` en memoria (mismo criterio `COLLATE NOCASE` que ya usa `findChatSessionByTitle()` del lado SQLite, sin necesitar otro roundtrip). No asume que el próximo número es siempre 2 — sigue probando `Panel 3`, `Panel 4`... hasta encontrar uno libre, cubriendo huecos de paneles borrados/creados antes.

**Verificación real (CDP, scaffold temporal `debug:sendToWindowByTitle` — mismo patrón ya usado en Paneles-1/UI Paso 1/Paneles-3, invoca `sendToWindowByTitle()` real sin depender de un LLM, retirado y confirmado con `grep` al cerrar):**
- **Títulos:** 2 "Agregar panel" seguidos desde el mismo origen (chat real con `workspaceName: YAYOSCHAT`) produjeron `"YAYOSCHAT — Panel 2"` y `"YAYOSCHAT — Panel 3"` — confirmado sin duplicados (`new Set(titulos).size === titulos.length`).
- **Escenario exacto del bug, reproducido con datos reales:** origen recibió un turno real (`"LISTO decime OK y nada mas"` → `"OK"` real de Foundry) — su `updated_at` quedó el MÁS RECIENTE de los 3 paneles, exactamente la condición que antes causaba la ambigüedad. `send_to_window` real, dirigido a `"YAYOSCHAT — Panel 2"` por título: `{ok:true}`, el turno corrió en el panel correcto (`"YAYOSCHAT — Panel 2"` mostró la respuesta real generada a partir del mensaje), `"YAYOSCHAT — Panel 3"` quedó intacto (0 contacto), y el panel de ORIGEN mostró la entrega cross-window correctamente etiquetada `⇄ YAYOSCHAT — Panel 2` (identificación explícita y correcta del panel real de origen de la respuesta, no ambigua).

**Hallazgo real colateral, no causado por este fix (documentado por transparencia):** al relanzar la app para esta verificación se encontró que el chat real `YAYOSCHAT` (id `D:\APLICACIONES\YAYOSCHAT`, 157 mensajes, confirmado intacto tras el fix anterior) ya no está en `amatista.db` — reemplazado por un chat distinto (`Chat nuevo`, id UUID nuevo, mismo workspace) creado varias horas después de la última verificación de esta sesión. Confirmado con `sqlite3` directo (fuera de la app) que no fue causado por ningún paso de esta sesión entre medio (ninguno tocaba chats). Consistente con uso real del usuario en el tiempo transcurrido. El usuario confirmó seguir con la verificación usando el chat actual.

Base real: los 2 chats de prueba (`"YAYOSCHAT — Panel 2"`/`"YAYOSCHAT — Panel 3"`) borrados vía `deleteChatSession()` real al terminar. El chat de origen (`Chat nuevo`, workspace `YAYOSCHAT`) conserva los 3 mensajes reales del turno de prueba (`"LISTO decime OK..."` / `"OK"` / entrega cross-window) — no hay mecanismo de borrado de mensajes individuales sin borrar el chat completo, y no se quiso borrar un chat que podría ser el real del usuario; queda a criterio del usuario limpiarlo manualmente si lo desea. `tasklist` sin `electron.exe` colgado.

`npm run build` (typecheck incluido): limpio. Sin commit — se junta con FIX 1/FIX 2/FIX menú contextual, pendiente de que el usuario pida el commit.

## Fix contraste — Tanda 1+3 (auditoría mecánica, docs/_arch/verify_contrast_audit.md)

5 hallazgos reales de la auditoría de contraste, corregidos con evidencia CDP antes/después:

| # | Causa | Ratio antes | Fix | Ratio después |
|---|---|---|---|---|
| 1 (Parte A) | `.add-connection-grid` (JSX) nunca coincidía con `.add-grid` (CSS) — clase renombrada, CSS huérfano igual que `.connection-toggle`/`.danger-link` antes | 1.08 | Renombrado `.add-grid` → `.add-connection-grid` en las 2 ubicaciones (`main.css` regla base + override `!important`) | 9.54 |
| 2 (Tanda 1) | `.settings-actions-row` nunca tuvo regla propia — botón default del navegador | 1.08 | Estilo real reusando el tono de `.add-connection-grid button` (border `#363636`, fondo `#282828`, texto `#ccc`) | 9.18 |
| 3 (Tanda 1) | `.model-catalog-row` nunca tuvo regla propia | 1.08 | Estilo real reusando el tono de `.connection-action` (transparente, `#8d8d8d`, hover `#ddd`) | 4.91 |
| 8 (Tanda 3) | `.connection-action-danger` (`#9b7272`) medía 3.91:1 real sobre `#202020` — mi propio fix anterior, apenas debajo del piso | 3.91 | `#9b7272` → `#a47979` (con margen real, no al límite) | 4.34 |
| 10 (Tanda 3) | `.approval-dialog small` (`#818181`) medía 3.98:1 real sobre `#242424` | 3.98 | `#818181` → `#888` | 4.38 |

**Causa confirmada del #1 con evidencia, no supuesta:** `grep` cruzado entre `App.tsx` (`className="add-connection-grid"`, línea 3919) y `main.css` (`.add-grid`, líneas 268-271 y 1001-1012) — cero coincidencia de nombres, exactamente el mismo patrón de rename-sin-actualizar-CSS que el bug de `.connection-toggle`/`.danger-link` de una fase anterior. Confirmado con `grep -rn` sobre todo `src/` que `.add-grid` no queda en ningún lado tras el rename.

**#2/#3 — mismo síntoma (ratio 1.08 = básicamente invisible), causas independientes:** ninguna de las 2 clases tuvo jamás una regla CSS propia (confirmado con `grep`, cero resultados en `main.css` antes del fix) — no es un rename roto como el #1, es CSS que nunca se escribió. Ambas reusan lenguaje visual YA establecido en Settings (no se inventó ningún tono nuevo): `.settings-actions-row` toma el tono de botón de acción de `.add-connection-grid button`; `.model-catalog-row` toma el tono de acción inline chica de `.connection-action` (misma clase reparada en el fix de contraste anterior).

**#8/#10 — ajuste mínimo, no al límite:** ambos ya estaban cerca del piso (3.91/3.98), no eran texto invisible. Se subió el tono lo justo para cruzar 4:1 con margen real (4.2-4.5, target explícito), verificado con el ratio REAL post-fix, no solo calculado — evita quedar al borde otra vez ante cualquier redondeo de color.

**Verificación real (CDP, `getComputedStyle()` sobre los 5 elementos reales renderizados, mismo criterio de los 2 fixes de contraste anteriores):**
- `.add-connection-grid button`: `rgb(204,204,204)` sobre `rgb(37,37,37)` real → **9.54:1**.
- `.settings-actions-row button` ("Conectar ChatGPT"): `rgb(204,204,204)` sobre `rgb(40,40,40)` real → **9.18:1**.
- `.model-catalog-row button` ("Desactivar", sección "Modelos de API compatible", revelada conectando a un provider openai-compatible real): `rgb(141,141,141)` sobre `rgb(32,32,32)` real → **4.91:1**.
- `.connection-action-danger` ("Eliminar"): `rgb(164,121,121)` sobre `rgb(32,32,32)` real → **4.34:1**.
- `.approval-dialog small` (diálogo real de `toolApproval` disparado con un `write_file` real de Foundry, texto real `"Escribir archivo: VERIFY5_TMP.txt"`): `rgb(136,136,136)` sobre `rgb(36,36,36)` real → **4.38:1**.

Base real: la verificación del diálogo de aprobación pidió un `write_file` real 2 veces (el primer intento el LLM respondió conversacionalmente pidiendo confirmación en vez de llamar la tool, variación normal del modelo — se insistió y en el segundo intento sí llamó la tool) — ambas veces se **rechazó** (`Rechazar` real), confirmado que `VERIFY5_TMP.txt` nunca se escribió en disco. El chat de origen (`Chat nuevo`, workspace `YAYOSCHAT`) acumula más mensajes de prueba de esta verificación además de los de la fase anterior — mismo criterio ya documentado, no se borra por no ser un chat 100% de prueba. `tasklist` sin `electron.exe` colgado.

`npm run build` (typecheck incluido): limpio. Sin commit — se junta con los fixes anteriores, pendiente de que el usuario pida el commit.

## Feature "Panel N" — alias corto para send_to_window, sin round-trip nuevo

**Diseño (rediseño del usuario sobre la propuesta original, que sí requería un round-trip main↔renderer nuevo):** "Panel N" no es posición visual en pantalla en ningún momento — es el sufijo ESTABLE que `generateUniquePanelTitle()` (`App.tsx`, sin tocar) ya graba en el título real del chat al crearlo (`" — Panel N"`, N≥2). "1"/"principal" es el chat de ese mismo grupo (mismo `workspacePath`) que NO tiene ese sufijo — el chat original. Esto evita el round-trip nuevo: `workspace_path` de la sesión de origen ya está disponible en memoria (`session.activeWorkspace`, seteado por `agent:connect`), sin pedirle nada al renderer.

**Implementación, 3 archivos:**
1. **`chat-store.ts`** — `panelAliasForTitle(title)` (regex `/\s—\s*Panel\s+(\d+)\s*$/i`, devuelve `"Panel N"` o `null`) y `findChatSessionByPanelAlias(alias, workspacePath)`: si `alias` matchea `/^(?:panel\s*)?(\d+)$/i` o `/^principal$/i`, busca dentro de `chat_sessions` filtrado por `workspace_path` — "1"/"principal" = fila sin el sufijo (más reciente si hay más de una, mismo criterio de desempate que `findChatSessionByTitle`); "N" (N≥2) = fila cuyo título termina en `— Panel N` exacto. Devuelve `null` si `alias` no matchea ninguno de los 2 patrones — el llamador cae al camino existente sin cambios.
2. **`cross-window-messaging.ts`** (`sendToWindowByTitle`) — intenta `findChatSessionByPanelAlias(destinationTitle, originSession.activeWorkspace)` PRIMERO; si no resuelve (patrón no matchea, o sin `activeWorkspace`, o sin match en el grupo), cae a `findChatSessionByTitle(destinationTitle)` — el camino de título exacto queda 100% intacto para todo lo que no sea un alias.
3. **`tool-registry.ts`** — `list_windows` ahora muestra `(alias corto: "Panel N")` junto al título completo para los chats que ya tienen el sufijo (via `panelAliasForTitle`, `ipc-agent.ts`); descripciones de `list_windows`/`send_to_window` actualizadas para que el modelo sepa que puede usar el alias corto en vez de repetir el título completo.

**Verificación real (CDP, scaffold temporal `debug:sendToWindowByTitle` — mismo patrón ya usado antes, retirado y confirmado con `grep` al cerrar), 3 casos, workspace real `YAYOSCHAT` con 3 chats reales (principal conectado a Foundry, `YAYOSCHAT — Panel 2` con historial real preexistente, `YAYOSCHAT — Panel 3` creado para la prueba):**

| Caso | Alias enviado | Origen | Destino esperado | Resultado real |
|---|---|---|---|---|
| 1 | `"Panel 2"` | principal | `YAYOSCHAT — Panel 2` | ✅ Mensaje real (`TEST-ALIAS-PANEL2`) apareció en los mensajes de Panel 2; Panel 3 sin tocar; origen recibió la entrega cross-window etiquetada `⇄ Panel 2` |
| 2 | `"2"` (solo el número) | principal | `YAYOSCHAT — Panel 2` | ✅ Misma resolución que el caso 1 — confirma que el regex `/^(?:panel\s*)?(\d+)$/i` cubre el número solo sin necesitar ajuste |
| 3 | `"principal"` | `YAYOSCHAT — Panel 2` | chat principal (sin sufijo) | ✅ El chat principal recibió y respondió realmente al mensaje (`TEST-ALIAS-PRINCIPAL`); Panel 2 (el emisor) mostró la entrega cross-window etiquetada `⇄ principal` |

Hallazgo metodológico durante la prueba (no del código nuevo): el primer intento del Caso 1, con el destino aún cerrado, disparó el handshake de auto-open+connect existente (Paneles-3) y reportó un error (`"Ya hay 4 paneles abiertos"`) pese a que el panel se abrió correctamente (confirmado por conteo real de paneles antes/después) — comportamiento pre-existente del handshake, no de esta feature; se conectó el panel manualmente y se repitió la prueba, con éxito. Documentado por transparencia, no investigado a fondo (fuera de alcance de esta tarea).

Base real: se creó `YAYOSCHAT — Panel 3` para la prueba, borrado vía `deleteChatSession()` real al terminar. El chat principal y `YAYOSCHAT — Panel 2` (ambos con historial real preexistente) acumulan los mensajes de prueba de esta verificación — mismo criterio ya documentado en fixes anteriores, no se borran por no ser chats 100% de prueba. `tasklist` sin `electron.exe` colgado.

`npm run build` (typecheck incluido): limpio. Sin commit — pendiente de que el usuario lo pida.

## Fix bug real — `openChatInPanel()` devolvía `null` cuando el caller era un callback de IPC

**Causa confirmada con logging real temporal (retirado, confirmado con `grep`):** `openChatInPanel()` asumía que `setOpenPanels(current => {...})` corre su updater de forma síncrona antes de que la función haga su propio `return` — cierto para los call sites disparados desde un handler sintético de React (clicks), pero **falso** cuando la función se dispara desde `handlePanelOpenAndConnectRequest()`, a su vez llamado desde el listener de IPC nativo `panel:openAndConnectRequest` (fuera del sistema de eventos de React). Orden real capturado con logging:
```
[openChatInPanel] llamada
[openChatInPanel] retornando resultPanelId= (VACÍO)  updaterCalls totales= 0
[openChatInPanel] updater CORRIENDO RECIÉN ACÁ, call#1
```
`openChatInPanel()` devolvía siempre `null` (el valor inicial, nunca actualizado) para este call path — `handlePanelOpenAndConnectRequest()` reportaba entonces el error hardcodeado de `MAX_PANELS` sin importar la causa real, aunque el panel se abriera bien milisegundos después.

**Fix — mismo patrón de ref-espejo ya usado en esta app (`activeChatIdRef`/`turnStepsRef`, `ChatPanel`):**
```ts
const openPanelsRef = useRef(openPanels)
useEffect(() => {
  openPanelsRef.current = openPanels
}, [openPanels])
```
`openChatInPanel()` calcula el `panelId` que devuelve leyendo `openPanelsRef.current` (sincrónico de verdad) ANTES de llamar a `setOpenPanels()`, y actualiza el ref manualmente con la misma decisión (además del `useEffect`) para que llamadas encadenadas en el mismo tick también vean el estado correcto. `setOpenPanels(current => {...})` sigue siendo la única fuente real de verdad para el estado de React — su lógica interna no cambió, solo reusa el `panelId` ya decidido en vez de generar uno nuevo dentro del updater (evita 2 UUIDs random distintos para el mismo panel).

**Verificación real (CDP, mismo escenario exacto que encontró el bug — chat destino cerrado, auto-open+connect desde `send_to_window`):**
- **Antes del fix:** `{"ok":false,"error":"...no se pudo abrir automaticamente: Ya hay 4 paneles abiertos..."}`, pese a que el panel se abría (confirmado por conteo real 2→3 paneles).
- **Después del fix, mismo escenario, mismo scaffold temporal de verificación:** `{"ok":true,"text":"TEST-RACE recibido."}` en el primer intento — sin reconexión manual previa como hizo falta antes. Confirmado en los mensajes reales: el chat destino (`YAYOSCHAT — Panel 2`) recibió y respondió de verdad (`"TEST-RACE recibido."`), el origen mostró la entrega cross-window correctamente etiquetada `⇄ Panel 2`.

Base real: sin datos de prueba nuevos (reusó los 2 chats reales ya usados en la verificación de Feature #1) — ambos acumulan un mensaje de prueba más cada uno, mismo criterio ya documentado. `tasklist` sin `electron.exe` colgado.

`npm run build` (typecheck incluido): limpio. Sin commit — se junta con Feature #1, pendiente de que el usuario lo pida.

**Caveat conocido, NO investigado ni reproducido, agregado por transparencia (detalle completo en `docs/_arch/PENDING.md` → "Riesgo conocido, no investigado — `closePanel()` no pasa por el ref-espejo de `openChatInPanel()`"):** este fix solo mutó `openPanelsRef` manualmente DENTRO de `openChatInPanel()` — `closePanel()` sigue llamando a `setOpenPanels()` directo, sin tocar el ref. Si un cierre de panel y un auto-open por IPC coinciden en el mismo tick (antes de que el `useEffect` resincronice el ref tras el cierre), `openChatInPanel()` podría decidir sobre un `openPanelsRef.current` que todavía incluye el panel recién cerrado — una versión angosta del mismo bug, en sentido inverso. Sin reproducir, sin fix implementado.

## Feature "árbol de sub-chats" — parentChatId + sidebar anidado con borde de color por provider

**Diseño (Tarea 0 confirmada por el usuario, docs/_arch/verify_subchat_tree.md de la ronda anterior):** un chat creado vía "Agregar panel" es un SUB-CHAT del chat de origen, no un chat independiente — el sidebar debe mostrarlo anidado, indentado, debajo del principal.

**1. Esquema (`chat-store.ts`):** columna nueva `parent_chat_id TEXT`, mismo patrón `ALTER TABLE ... ADD COLUMN` + `try/catch` ya usado 4 veces (`tool_steps`/`summary`/`structured_memory`/`cross_window`). A propósito SIN `FOREIGN KEY`: borrar el padre no debe arrastrar en cascada a sus hijos — un huérfano (`parent_chat_id` apunta a un id que ya no existe) se trata como raíz en el render, no como error.

**2. Persistencia:** `ensureChatSession()` acepta `parentChatId?: string` — `COALESCE` en el `UPDATE` (mismo criterio que `providerId`/`modelId`/`runtime`: nunca se pisa si no se vuelve a pasar), seteo directo en el `INSERT`. `loadChatSnapshot()` selecciona y mapea `parent_chat_id` → `parentChatId` en `StoredChatSession`. Plumbing completo: `shared/types.ts` (`StoredChatSession.parentChatId`), `ipc-chats.ts` (`chats:ensureSession` payload), `preload/index.ts` + `index.d.ts` (`ensureChatSession` payload).

**3. Creación (`App.tsx`):** `resolveOrCreateChatForPath(path, name, forceNew, parentChatId?)` — 4º parámetro opcional, los 2 call sites de proyecto (`resolveOrCreateProjectChat`) no lo pasan (sin cambio de comportamiento, `undefined` = raíz). `addPanelForChat(chatId)` pasa `origin.id` como `parentChatId` — único call site real que lo usa hoy.

**4. Render del sidebar — árbol client-side:**
```ts
function panelSortNumber(title: string): number {
  const match = title.match(/\s—\s*Panel\s+(\d+)\s*$/i)
  return match ? Number(match[1]) : 1
}

function buildChatRows(sessions: ChatSession[]): Array<{ chat: ChatSession; depth: number }> {
  const byId = new Map(sessions.map(chat => [chat.id, chat]))
  const childrenByParent = new Map<string, ChatSession[]>()
  const roots: ChatSession[] = []
  for (const chat of sessions) {
    const parent = chat.parentChatId ? byId.get(chat.parentChatId) : undefined
    if (parent) {
      const siblings = childrenByParent.get(parent.id) ?? []
      siblings.push(chat)
      childrenByParent.set(parent.id, siblings)
    } else {
      roots.push(chat)
    }
  }
  for (const siblings of childrenByParent.values()) {
    siblings.sort((a, b) => panelSortNumber(a.title) - panelSortNumber(b.title))
  }
  const rows: Array<{ chat: ChatSession; depth: number }> = []
  function pushWithChildren(chat: ChatSession, depth: number): void {
    rows.push({ chat, depth })
    for (const child of childrenByParent.get(chat.id) ?? []) {
      pushWithChildren(child, depth + 1)
    }
  }
  for (const root of roots) pushWithChildren(root, 0)
  return rows
}
```
Raíces (sin `parentChatId`, o padre borrado) mantienen el orden real que ya trae `chatSessions` (`updated_at DESC`, sin tocar); cada raíz va seguida inmediatamente de sus hijos reales, ordenados entre sí por el número de "Panel N" en el título (`generateUniquePanelTitle()` ya lo deja ahí — no se tocó esa función). El sidebar usa `buildChatRows(chatSessions).map(({chat, depth}) => ...)` en vez de `chatSessions.map(chat => ...)`; `depth > 0` agrega la clase `chat-row-nested` y `marginLeft: 8 + depth*16` inline (indentación real, sin CSS nuevo para eso).

**5. Borde de color por fila:**
```ts
function chatBorderAccent(chat: ChatSession, providers: ProviderProfile[]): string {
  const provider = chat.providerId ? providers.find(p => p.id === chat.providerId) : undefined
  return provider ? providerIdentity(provider).accent : PROVIDER_BRAND.neutral.accent
}
```
Reusa `providerIdentity()`/`PROVIDER_BRAND` (Fase 21) tal cual — ningún color nuevo. Usa `chat.providerId` (el PERSISTIDO, last-used, viene de `chat-store.ts`), no el estado de conexión en vivo de ningún panel — un chat nunca conectado (o cuyo provider fue borrado) cae al gris neutral (`#9ca3af`). Aplicado vía `style={{ borderLeftColor: accent }}` a **toda** fila (raíz y anidada) — `.chat-row` en `main.css` gana `border-left: 3px solid transparent` como base (solo reserva el espacio, nunca "colorea la nada").

**Verificación real (CDP), 2 casos, contra la DB de producción real:**

| Caso | Setup | Resultado real (getComputedStyle) |
|---|---|---|
| Árbol con 3 hijos reales | `+ Nuevo chat` → clic real en "Agregar panel" x3 (mismo origen, vía context-menu real) → `parentChatId` confirmado en los 3 vía `loadChats()` real → providerId distinto por hijo vía `ensureChatSession()` real (Foundry / OpenRouter / DeepSeek) → reload para restaurar desde DB (mismo path que el boot real) | Los 3 hijos renderizan **inmediatamente debajo de su padre real**, `class="chat-row chat-row-nested"`, `marginLeft: 24px` (vs `8px` de las raíces) — orden Panel 2→3→4. Bordes reales medidos: `rgb(0,120,212)` (Foundry), `rgb(139,92,246)` (OpenRouter), `rgb(77,107,254)` (DeepSeek, vía el caso especial `isDeepSeekProvider()`) — **3 colores reales y distintos**, no solo CSS que compila |
| Chat normal sin hijos | 2 chats reales preexistentes sin ningún "Agregar panel" hecho sobre ellos | `class="chat-row"` (sin `chat-row-nested`), `marginLeft: 8px` — igual layout que antes de esta feature; único cambio (intencional, parte del diseño) es el borde de color por su propio provider persistido, ya presente en todas las filas |

Base real: se usó `+ Nuevo chat` para crear un origen 100% de prueba (`"Chat nuevo"`) — coincidencia de nombre no-bug: heredó `workspaceName` de un chat real preexistente (`YAYOSCHAT — Panel 2`) vía el mecanismo normal de `createBlankChat()`, así que los 3 hijos de prueba quedaron titulados `"YAYOSCHAT — Panel 2 — Panel N"` aunque su `parentChatId` real apunta al chat de prueba, no al chat real de ese nombre — confirmado explícitamente vía `loadChats()` antes de dar el caso por válido. Los 4 chats de prueba (origen + 3 hijos) se borraron al final vía `deleteChatSession()` real; los 2 chats reales preexistentes usados como comparación en el caso 2 no se tocaron. `tasklist` sin `electron.exe` colgado.

`npm run typecheck` y `npm run build`: limpios. Sin commit — pendiente de que el usuario lo pida (se puede juntar con Feature #1 + el fix de `openChatInPanel()`, ya documentados arriba, o commitear aparte — a criterio del usuario).

## Fix bug real — `resolveOrCreateChatForPath()` conflacionaba `title`/`workspaceName`, con dato real ya contaminado en producción

**Encontrado durante la verificación de Feature "árbol de sub-chats"** (el caso de prueba de ese entregable "coincidencia de nombre no-bug" era, en realidad, el síntoma visible de este bug real). `resolveOrCreateChatForPath()` recibía un solo parámetro `name` y lo usaba para `title` Y `workspaceName` al mismo tiempo:
```ts
const chat: ChatSession = {
  id: crypto.randomUUID(),
  title: name,
  workspacePath: path,
  workspaceName: name,   // <- mismo valor que title
  ...
}
```
`addPanelForChat()` le pasa `generateUniquePanelTitle(baseName)` (el título COMPUESTO, `"X — Panel N"`) como ese único `name` — así que `workspaceName` del hijo nuevo quedaba con el sufijo pegado. Encadenado, el siguiente "Agregar panel" sobre ESE hijo generaba `"X — Panel N — Panel M"`, porque `baseName` volvía a leer `origin.workspaceName` ya contaminado.

**Confirmado con datos reales de producción, no solo hipotético:** query de solo lectura (`node:sqlite`, `readOnly: true`, mismo módulo que usa `chat-store.ts`) contra `amatista.db` mostró que **1 de los 2 chats reales existentes ya estaba contaminado** — `04270157-b678-4099-b1d2-50aae3f9007c` (`title: "YAYOSCHAT — Panel 2"`) tenía `workspace_name: "YAYOSCHAT — Panel 2"` en vez de `"YAYOSCHAT"` (el valor real, confirmado comparando contra su hermano `3b9bb77c...`, que sí tenía `workspace_name: "YAYOSCHAT"` limpio).

**Fix — 3 partes:**

**1. `resolveOrCreateChatForPath()` gana un 5º parámetro opcional `workspaceName`** — si se pasa, se usa tal cual; si no (los 2 call sites de proyecto no lo pasan), cae a `name` (el título) — mismo comportamiento exacto que antes para esos 2 casos:
```ts
function resolveOrCreateChatForPath(path: string, name: string, forceNew: boolean, parentChatId?: string, workspaceName?: string): ChatSession {
  ...
  const chat: ChatSession = {
    id: crypto.randomUUID(),
    title: name,
    workspacePath: path,
    workspaceName: workspaceName ?? name,
    updatedAt: new Date().toISOString(),
    parentChatId
  }
  ...
}
```

**2. `addPanelForChat()` resuelve la raíz real del grupo ANTES de generar el nombre nuevo**, vía `resolveGroupRoot()` nuevo (`App.tsx`), en vez de asumir que `origin.workspaceName` ya está limpio:
```ts
function resolveGroupRoot(origin: ChatSession): ChatSession {
  if (!PANEL_SUFFIX_RE.test(origin.workspaceName ?? origin.title)) return origin
  const siblings = chatSessions.filter(chat => chat.workspacePath === origin.workspacePath)
  return (
    siblings.find(chat => !PANEL_SUFFIX_RE.test(chat.workspaceName ?? chat.title)) ??
    siblings.find(chat => !chat.parentChatId) ??
    origin
  )
}

function addPanelForChat(chatId: string): void {
  const origin = chatSessions.find(chat => chat.id === chatId)
  if (!origin?.workspacePath) {
    setNotice('Este chat no tiene workspace -- no se puede agregar panel.')
    return
  }
  const root = resolveGroupRoot(origin)
  const rawRootName = root.workspaceName ?? root.title
  const baseName = PANEL_SUFFIX_RE.test(rawRootName) ? rawRootName.replace(PANEL_SUFFIX_RE, '') : rawRootName
  const uniqueTitle = generateUniquePanelTitle(baseName)
  const chat = resolveOrCreateChatForPath(origin.workspacePath, uniqueTitle, true, root.id, baseName)
  openChatInPanel(chat.id)
}
```
`PANEL_SUFFIX_RE` (`App.tsx`, nuevo) es el mismo regex exacto que `PANEL_SUFFIX_RE` en `chat-store.ts` (proceso main, no importable desde el renderer — duplicado por necesidad de proceso separado, no por descuido); `panelSortNumber()` (Feature "árbol de sub-chats") se refactorizó para reusar esta misma constante en vez de su regex inline original. Si `origin` ya está limpio, `resolveGroupRoot()` lo devuelve tal cual sin buscar nada — el walk-up solo corre para el caso contaminado (dato viejo, o un hijo creado por versiones previas de la app).

**3. Migración real del dato ya contaminado** (`chat-store.ts`, `migrateContaminatedWorkspaceNames()`, llamada al final de `db()` en cada arranque, mismo espíritu que los backfills de `settings-store.ts` como `backfillDeepSeekAllowSubscription()`, aplicado acá porque el dato vive en esta DB, no en `settings.json`):
```ts
function migrateContaminatedWorkspaceNames(database: DatabaseSync): void {
  const rows = database.prepare(
    'SELECT id, workspace_path, workspace_name FROM chat_sessions'
  ).all() as Array<{ id: string; workspace_path: string | null; workspace_name: string | null }>

  const byPath = new Map<string, typeof rows>()
  for (const row of rows) {
    if (!row.workspace_path) continue
    const group = byPath.get(row.workspace_path) ?? []
    group.push(row)
    byPath.set(row.workspace_path, group)
  }

  const update = database.prepare('UPDATE chat_sessions SET workspace_name = ? WHERE id = ?')
  for (const group of byPath.values()) {
    const contaminated = group.filter(row => row.workspace_name && PANEL_SUFFIX_RE.test(row.workspace_name))
    if (contaminated.length === 0) continue
    const cleanSibling = group.find(row => row.workspace_name && !PANEL_SUFFIX_RE.test(row.workspace_name))
    for (const row of contaminated) {
      const repaired = cleanSibling ? cleanSibling.workspace_name! : row.workspace_name!.replace(PANEL_SUFFIX_RE, '')
      update.run(repaired, row.id)
    }
  }
}
```
Idempotente (una fila ya reparada deja de matchear `PANEL_SUFFIX_RE`, no se vuelve a tocar). Agrupa por `workspace_path`, busca un hermano con `workspace_name` limpio dentro del mismo grupo y se lo aplica a todos los contaminados de ese grupo; si ningún hermano sobrevive limpio (caso borde no encontrado en datos reales, pero posible), aplica `PANEL_SUFFIX_RE.replace()` sobre el propio valor contaminado como mejor esfuerzo. Solo toca `workspace_name` — nunca `title`, `updated_at` ni ningún otro campo.

**Verificación real, 2 casos:**

**Caso 1 — migración del dato real ya contaminado.** Backup previo (`amatista.db.bak_pre_workspace_name_fix`, copia completa antes de tocar nada). App levantada real (`AMATISTA_DEBUG_TOOLS=1`, CDP) contra `D:\AMATISTA\data\config\amatista.db` real — la migración corre sola al arrancar (primer acceso a `db()`). Confirmado por 2 vías independientes:
- `window.universalAgent.loadChats()` (real IPC): `04270157-b678-4099-b1d2-50aae3f9007c` pasó de `workspaceName: "YAYOSCHAT — Panel 2"` a `workspaceName: "YAYOSCHAT"`.
- Lectura directa de la DB en disco (`node:sqlite`, `readOnly: true`, proceso Node separado de la app): mismo resultado persistido — `workspace_name: "YAYOSCHAT"`, con `title` (`"YAYOSCHAT — Panel 2"`), `created_at`, `updated_at`, `provider_id`, `model_id`, `parent_chat_id` — **todos exactamente iguales a antes de la migración**, confirmando que solo se tocó la columna que debía tocarse.

**Caso 2 — "Agregar panel" desde un panel que YA es hijo contaminado.** Reproducción real del escenario exacto del usuario, con datos sintéticos aislados (`workspace_path: 'TEST-WORKSPACE-CONFLATION'`, para no interferir con los 2 chats reales) creados vía `ensureChatSession()` real: una raíz limpia (`"TestRoot"`, `workspaceName: "TestRoot"`) y un hijo simulando el bug pre-fix (`"TestRoot — Panel 2"`, `workspaceName: "TestRoot — Panel 2"` — contaminado a propósito, `parentChatId` apuntando a la raíz). Clic real en "Agregar panel" sobre la fila del HIJO contaminado (no la raíz). Resultado real, vía `loadChats()`:

| Campo | Chat nuevo creado |
|---|---|
| `title` | `"TestRoot — Panel 3"` — sufijo único, sin encadenar (`"TestRoot — Panel 2 — Panel 3"` NO ocurrió) |
| `workspaceName` | `"TestRoot"` — limpio, heredado de la raíz real, no del padre inmediato contaminado |
| `parentChatId` | el id de `"TestRoot"` (la raíz) — **no** el id de `"TestRoot — Panel 2"` (el padre inmediato desde donde se hizo clic) |

Los 3 chats de prueba (`"TestRoot"`, `"TestRoot — Panel 2"`, `"TestRoot — Panel 3"`) y el chat "Chat nuevo" usado en un paso intermedio se borraron al final vía `deleteChatSession()` real. Confirmado el estado final de la DB real: solo los 2 chats reales de siempre, sin residuos, `tasklist` sin `electron.exe` colgado.

`npm run typecheck` y `npm run build`: limpios. Sin commit — pendiente de que el usuario lo pida.

## Feature "generación de imágenes" — tool `generate_image` real vía Foundry, configurable, distinción visual

**Diseño confirmado en Tarea 0** (`docs/_arch/verify_image_generation.md`): endpoint real de Foundry `/images/generations` (separado de `/responses`, confirmado con una llamada real — `gpt-image-2` contra `/responses` devuelve 400 "unsupported"), respuesta `data[0].b64_json` (base64 inline, sin URL), `buildAttachmentFromDataUrl()` ya reusable tal cual.

**1. Configurabilidad** (`AppSettings.imageGenerationProviderId`/`imageGenerationModelId`, `shared/types.ts`) — mismo patrón exacto que `compactionProviderId`/`compactionModelId`, lógica PARALELA, no compartida (restricción explícita del usuario). 3 archivos tocados, confirmado el mismo camino real que ya reveló el bug histórico de compactación (Fase 14):
- `settings-store.ts`: `StoredSettings` + `loadSettings()` + `saveSettings()`.
- `ipc-settings.ts`, handler `settings:save`: agregados a la whitelist del merge campo-por-campo — **sin esto, cualquier cambio real del usuario en el selector se ignora en silencio**, verificado que efectivamente hacía falta (ver Verificación real, Caso 2).

`resolveConfiguredImageGenerationModel()` (nuevo, `src/main/image-generation.ts`):
```ts
export function resolveConfiguredImageGenerationModel(
  settings: ImageGenerationSettings
): { provider: ProviderProfile; model: ModelProfile } | null {
  if (settings.imageGenerationProviderId || settings.imageGenerationModelId) {
    const provider = settings.providers.find(item => item.id === settings.imageGenerationProviderId && item.enabled)
    const model = provider?.models.find(item => item.id === settings.imageGenerationModelId && item.enabled)
    if (provider && model && isApiCapableModel(provider, model)) return { provider, model }
    return null
  }
  for (const provider of settings.providers) {
    if (!provider.enabled) continue
    const model = provider.models.find(item => item.enabled && isApiCapableModel(provider, item) && isLikelyImageModel(item))
    if (model) return { provider, model }
  }
  return null
}
```
Sin ninguna elección explícita (los 2 campos `undefined`): sugiere el primer modelo habilitado que matchee `isLikelyImageModel()` (heurística nueva, `shared/model-capabilities.ts` — `/image/i.test(model.model)`, sobre el nombre REAL del deployment, no el id/displayName) entre los providers habilitados — nunca se persiste sola, es una sugerencia en tiempo de resolución. Con elección explícita rota (provider/modelo borrado o deshabilitado): `null`, sin fallback — mismo criterio "no adivinar" que compactación.

**2. `generateImage()`** (`src/main/image-generation.ts`), la llamada real:
```ts
export async function generateImage(
  settings: ImageGenerationSettings,
  prompt: string
): Promise<{ ok: true; attachment: ChatAttachment } | { ok: false; error: string }> {
  const target = resolveConfiguredImageGenerationModel(settings)
  if (!target) return { ok: false, error: 'No hay un modelo de generacion de imagenes configurado...' }
  const { provider, model } = target
  if (model.runtime !== 'foundry') {
    return { ok: false, error: `Generacion de imagenes no soportada todavia para "${provider.name}"...` }
  }
  const apiKey = provider.apiKey?.trim()
  if (!apiKey) return { ok: false, error: 'Foundry requiere API key para generar imagenes.' }
  const baseUrl = normalizeFoundryBaseUrl(provider.endpoint)
  const response = await fetchWithTimeout(`${baseUrl}/images/generations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'api-key': apiKey },
    body: JSON.stringify({ model: model.model, prompt, size: '1024x1024', n: 1 })
  })
  if (!response.ok) return { ok: false, error: `Foundry /images/generations fallo ${response.status}: ${await readErrorBody(response)}` }
  const json = await response.json()
  const b64 = json.data?.[0]?.b64_json
  if (!b64) return { ok: false, error: 'Foundry no devolvio ninguna imagen en la respuesta.' }
  const attachment = buildAttachmentFromDataUrl({ name: `generada-${Date.now()}.png`, dataUrl: `data:image/png;base64,${b64}` })
  return { ok: true, attachment: { ...attachment, origin: 'generated' } }
}
```
Reusa `fetchWithTimeout`/`normalizeFoundryBaseUrl`/`readErrorBody` (`api-agent-runtime.ts`, ya exportadas) y `buildAttachmentFromDataUrl()` (`attachments.ts`, sin cambios) tal cual confirmó la investigación. Solo Foundry por ahora — cualquier otro `runtime` devuelve un error claro en vez de adivinar un formato de request nunca probado.

**3. Settings UI** — sección nueva "Generación de imágenes", mismo componente `<select>` que la de compactación, `imageGenerationCandidates` (memo calcado de `compactionCandidates`, PARALELO). El hint muestra la sugerencia implícita real cuando no hay elección explícita (`"Sin elegir uno a mano, se sugiere automaticamente: Microsoft Foundry · Foundry gpt-image-2."`, confirmado real en la verificación) — la elección explícita del usuario siempre gana.

**4. Tool `generate_image`** (`tool-registry.ts`, `TOOL_DEFINITIONS`) — `{ prompt: string }`, sin control de tamaño/calidad en esta versión. Aprobación SIEMPRE incondicional, mismo criterio exacto que `send_to_window` (`ctx.confirm()` directo, nunca `resolveApproval()` — generar cuesta cuota real, sin relación con el sandbox mode del turno). `ExecuteContext.generateImage` (closure inyectada por `ipc-agent.ts`, `settings` fresco en cada llamada, mismo criterio que `resolveExploreModel`).

**5. `ToolExecutionResult.generatedAttachment?: ChatAttachment`** — mismo patrón lateral que `lineDiff`, nunca llega al modelo como texto. Plomería para sobrevivir `MAX_TOOL_LOOP` (`api-agent-runtime.ts`): acumulador nuevo `ApiAgentRuntime.generatedAttachments`, poblado en `runTool()`/`finish()` (único punto de paso de CUALQUIER `ToolExecutionResult`), reseteado al arrancar cada `send()`, volcado al `ApiAgentResult.attachments` final en un único punto de unión (el propio `send()`, no en cada `return` de los 4 `sendFoundry`/`sendAnthropicApi`/`sendGeminiApi`/`sendOpenAiApi`). `ipc-agent.ts` viaja `attachments: result.attachments` en el evento `item/agentMessage/delta`; `App.tsx` (`appendAssistantMessage()`, nuevo parámetro `attachments`) los cuelga del `ChatMessage` del asistente antes de `persistChatMessage()`.

**6. Distinción visual** — `ChatAttachment.origin?: 'generated'` (`shared/types.ts`), round-trip completo de 3 puntos confirmado (y un vacío real encontrado y cerrado durante la propia verificación, ver más abajo): columna `chat_attachments.origin TEXT` (migración `ALTER` + `try/catch`, mismo patrón de siempre), `INSERT`/`SELECT` en `chat-store.ts` (`saveChatMessage()`/`loadChatSnapshot()`), badge `"✦ IA"` + label `"· GENERADA"` en `AttachmentCard` (`App.tsx`/`main.css`) — puramente visual, ningún otro código depende de este campo.

**Hallazgo real durante la propia verificación (cerrado en la misma ronda, no una fase aparte):** la primera implementación agregó `origin` al TIPO (`ChatAttachment`) y a la UI (`AttachmentCard`) pero no al esquema SQLite ni al `INSERT`/`SELECT` de `chat-store.ts` — la primera imagen generada se persistía bien (el resto de sus campos sí viajaban) pero perdía silenciosamente su `origin`, así que tras un reinicio real mostraba `"IMAGE"` sin el badge. Encontrado al ejecutar el propio paso de verificación "sobrevive un reinicio" (no fue necesario asumir nada — el DOM real después del restart lo mostró), corregido antes de cerrar la tarea con la migración/INSERT/SELECT reales de arriba.

**Verificación real (CDP + UI real, sin bypass — clicks reales en la app, aprobación real):**

| Paso | Acción real | Resultado real |
|---|---|---|
| 1 | Conectar panel (Foundry gpt-5.5, tools), escribir en el composer real y click en Enviar: "Usa generate_image para generar un círculo rojo..." | Diálogo real de aprobación: `"Aprobacion requerida / Generar imagen / Un círculo rojo simple, perfectamente centrado..."` — el prompt completo, tal como generó el modelo |
| 2 | Click real en "Aprobar" | Imagen real (PNG 1024x1024, `data:image/png;base64,...`) renderizada en el chat, badge `"✦ IA"` + `"IMAGE · GENERADA"`, texto del asistente `"Imagen generada."` |
| 3 | Confirmar en SQLite (`node:sqlite`, `readOnly`) | Fila real en `chat_attachments`: `name`, `mime_type: image/png`, `size: 239521`, `preview` con 319386 chars base64 — **antes del fix de `origin`**: columna vacía (hallazgo de arriba) |
| 4 | Cambiar el modelo de generación en Settings (UI real, `<select>` → guardar) a `"Foundry gpt-5.4"` (NO es un modelo de imágenes) | `getSettings()` confirma `imageGenerationModelId: "qcfg-foundry-chat"` persistido |
| 5 | Repetir generate_image (prompt real, aprobación real) | **Error real y distinto**, viniendo de Foundry: `"...La herramienta falló porque el modelo configurado (\`gpt-5.4\`) no es compatible con generación de imágenes."` — confirma que el cambio de modelo se usó de verdad, no el anterior |
| 6 | Volver a `"Foundry gpt-image-2"` explícito, repetir | Éxito real de nuevo — imagen de una estrella amarilla, badge correcto, `chat_attachments.origin = "generated"` confirmado en SQLite (ya con el fix aplicado) |
| 7 | Matar y relanzar `electron.exe` (reinicio real completo, no solo recargar la página) | Ambas imágenes siguen ahí — la primera (pre-fix) correctamente **sin** badge (`origin` nunca se guardó, dato real de esa fila), la segunda (post-fix) con `"IMAGE · GENERADA"` intacto — persistencia real confirmada, no solo en memoria |

Base real: se usó el chat real preexistente `YAYOSCHAT — Panel 2` (mismo criterio ya documentado en esta sesión — no se borran mensajes de prueba de chats con historial real, quedan como parte de su historial). `tasklist` sin `electron.exe` colgado al cerrar cada ronda.

`npm run typecheck` y `npm run build`: limpios. Sin commit — pendiente de que el usuario lo pida.

## Feature "LSP para Python" — pyright real, coexistencia con TypeScript en el mismo workspace

**Diseño confirmado en Tarea 0** (`docs/_arch/verify_python_lsp.md`): `pyright` real vía npm (`pyright-langserver` → `langserver.index.js`, mismo protocolo `Content-Length`/JSON-RPC que ya parsea `LspFramer`, mismo mecanismo de spawn `process.execPath` + `ELECTRON_RUN_AS_NODE`), `LspManager`/`LspClient` generalizados de un cliente único hardcodeado a TypeScript a un mapa por lenguaje.

**1. `pyright` instalado como dependency real** (`package.json`, mismo patrón que `typescript-language-server`/`typescript`): `npm install pyright --save` (real, `^1.1.413`), agregado a `build.files` y `build.asarUnpack` (los mismos 2 globs que ya cubrían TS, más `node_modules/pyright/**/*`) — sin esto, `spawn()` no podría ejecutarlo empaquetado (vive dentro de `app.asar`, no un path de filesystem real).

**2. Tabla de configuración por lenguaje** (`lsp-client.ts`), misma forma para las 2 entradas, sin trato especial para ninguna:
```ts
export interface LanguageServerConfig {
  languageId: string
  extensions: string[]
  resolveEntry: () => string | null
}

const LANGUAGE_SERVERS: LanguageServerConfig[] = [
  {
    languageId: 'typescript',
    extensions: ['.ts', '.tsx'],
    resolveEntry: () => resolveBundledServerEntry('typescript-language-server', 'typescript-language-server')
  },
  {
    languageId: 'python',
    extensions: ['.py'],
    resolveEntry: () => resolveBundledServerEntry('pyright', 'pyright-langserver')
  }
]
```
`resolveBundledServerEntry(packageName, binName)` reemplaza la vieja `resolveLanguageServerEntry()` (hardcodeaba `node_modules/typescript-language-server/lib/cli.mjs` a mano) — ahora lee `bin` del `package.json` REAL del paquete instalado, mismo criterio robusto que `geminiCommand()` (`cli-agent-runtime.ts`): la estructura interna puede cambiar entre versiones, `bin` es el contrato público estable. Confirmado con evidencia real (Tarea 1) que ambos paquetes exponen `bin` de forma directamente análoga (`typescript-language-server`: `{"typescript-language-server":"lib/cli.mjs"}` — coincide EXACTO con lo que antes estaba hardcodeado, cero cambio de comportamiento; `pyright`: `{"pyright-langserver":"langserver.index.js"}`).

`isLspSupportedFile()`/`languageIdFor()` generalizados a consultar la tabla vía `languageServerConfigFor()` (extension → config). Único matiz preservado, no generalizado a la tabla porque es intrínseco a TypeScript mismo: `.tsx` declara `languageId: 'typescriptreact'` en `didOpen` pese a compartir el MISMO proceso que `.ts` — sin cambio de comportamiento.

**3. `LspManager`: de campo único a `Map<languageId, LspClient>`** — arranque perezoso POR LENGUAJE, no global:
```ts
private clients = new Map<string, LspClient>()
private starting = new Map<string, Promise<LspClient>>()

private async ensureClient(config: LanguageServerConfig): Promise<LspClient> {
  const existing = this.clients.get(config.languageId)
  if (existing) return existing
  ...
}
```
`notifyFileWritten()` rutea vía `languageServerConfigFor(absolutePath)` — tocar un `.py` nunca afecta al cliente de `.ts` si ya estaba corriendo, y viceversa (entradas independientes del mapa). `getDiagnostics(path?)`: CON `path`, rutea al único cliente correcto según su extensión; SIN `path`, junta diagnósticos de TODOS los clientes vivos (`diagnosticsFromClient()` extraído como helper reusado en los 2 casos). `stopAll()` para TODOS los clientes del mapa, no solo uno.

**4. `get_diagnostics` (tool)** — sin cambios de firma (ya recibía `path`, confirmado en Tarea 0); solo se actualizó el texto de la descripción (visible al modelo) para mencionar `.py`/pyright además de `.ts/.tsx`, y el mensaje de "nada tocado todavía" para no decir "ts/tsx" cuando ahora hay 2 lenguajes soportados. Cero cambios de lógica en `tool-registry.ts` más allá del texto.

**Verificación real** (harness standalone vía esbuild, MISMO patrón exacto que la verificación original de Fase 20 — `ToolRegistry.execute()` invocado directo contra las clases reales `LspManager`/`LspClient`/`LspFramer`, `--alias:electron` a un stub con `app.getAppPath()` apuntando al proyecto real para que `resolveBundledServerEntry()` encuentre los paquetes bundleados reales), workspace real con `.ts` y `.py` mezclados:

| Paso | Acción real | Resultado real |
|---|---|---|
| 1 | `isRunning('python')`/`isRunning('typescript')` antes de tocar nada | `false`/`false` |
| 2 | `write_file('bad.py', ...)` con error real de tipos (`suma(1, "dos")` contra `def suma(a: int, b: int) -> int`) | Escritura OK; tras ~4.5s, `isRunning('python') === true` |
| 3 | `get_diagnostics('bad.py')` | Diagnóstico REAL de pyright: `error [4:26] TSreportArgumentType: Argument of type "Literal['dos']" cannot be assigned to parameter "b" of type "int"...` |
| 4 | `write_file('bad.ts', ...)` con error real de tipos, MISMO workspace | Escritura OK; tras ~4.5s, `isRunning('python') === true` (**sigue vivo**, no lo mató arrancar TS) Y `isRunning('typescript') === true` |
| 5 | `get_diagnostics('bad.ts')` | Diagnóstico REAL de TypeScript: `error [5:35] TS2345: Argument of type 'string' is not assignable to parameter of type 'number'.` |
| 6 | `get_diagnostics()` sin path | Los 2 diagnósticos juntos (`bad.py` Y `bad.ts`), confirmando agregación real entre clientes |
| 7 | Inspección de procesos reales del SO (`Get-CimInstance Win32_Process`, PowerShell, en paralelo mientras el harness corría) | **2 procesos `node.exe` reales, mismo `ParentProcessId` (el del harness), coexistiendo en el mismo instante**: uno con `pyright` en su `CommandLine`, otro con `typescript-language-server` — no un proceso reemplazando al otro |
| 8 | `stopAll()` | `isRunning('python')`/`isRunning('typescript')` → `false`/`false`; `tasklist` confirma cero `node.exe` de la sesión de verificación colgado (el único `node.exe` restante en el sistema, confirmado por `CommandLine`, es un runtime no relacionado de otra herramienta) |

`npm run typecheck` y `npm run build`: limpios. Sin commit — pendiente de que el usuario lo pida.

## Feature "LSP para Rust" — rust-analyzer real, binario externo detectado (no bundleado), 3 lenguajes coexistiendo

**Diseño confirmado en Tarea 0** (`docs/_arch/verify_rust_lsp.md`): a diferencia de pyright/typescript-language-server, `rust-analyzer` NO es bundleable — confirmado real que el paquete npm con ese nombre es un holding vacío y que el único paquete npm real relacionado (`coc-rust-analyzer`) descarga el binario nativo en runtime en vez de traerlo adentro. Mismo modelo que Codex/Gemini CLI: se detecta, no se bundlea.

**1. `LanguageServerConfig` gana `kind: 'node' | 'native'` y `args: string[]`** (`lsp-client.ts`) — TypeScript/Python quedan `kind:'node'`, `args:['--stdio']` (sin cambio de comportamiento, confirmado que el path resuelto y los argumentos son idénticos a los de antes). Rust: `kind:'native'`, `resolveEntry: resolveRustAnalyzerEntry`. `resolveEntry()` pasó a ser `async` para toda la tabla (Python/TypeScript solo envuelven su valor síncrono existente en una promesa — cero cambio de valor devuelto).

**2. `resolveRustAnalyzerEntry()`** — 2 niveles, mismo patrón que `versionOf()` (`cli-status.ts`) pero SIN reusar `npmGlobalShimPath()` (específico de `npm install -g`):
```ts
async function resolveRustAnalyzerEntry(): Promise<string | null> {
  if (await respondsToVersion('rust-analyzer')) return 'rust-analyzer'
  const fallback = rustAnalyzerCargoBinPath()  // %USERPROFILE%\.cargo\bin\rust-analyzer.exe
  if (fallback && existsSync(fallback) && await respondsToVersion(fallback)) return fallback
  return null
}
```
`respondsToVersion()` usa `execFile(comando, ['--version'], {shell:false})` — SIN `shell:true` (a diferencia de `tryVersion()` en `cli-status.ts`): rust-analyzer es un `.exe` real, no un shim `.cmd` como Gemini/Codex, así que `CreateProcess` lo encuentra por PATH sin necesitar un shell de por medio.

**3. Hallazgo real #1 (Tarea 3 ya lo anticipaba): `kind:'native'` cambia CÓMO se spawnea, no solo DÓNDE está el entry.** `LspClient.start()` gana una rama real:
```ts
const child = config.kind === 'native'
  ? spawn(entry, config.args, { cwd: workspace, windowsHide: true, shell: false })
  : spawn(process.execPath, [entry, ...config.args], {
      cwd: workspace, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, windowsHide: true, shell: false
    })
```
Sin esto, `rust-analyzer.exe` se hubiera intentado cargar como si fuera un módulo de JavaScript (Node interpretando un binario nativo).

**4. Hallazgo real #2, encontrado DURANTE la propia verificación (no anticipado en Tarea 0): rust-analyzer no acepta `--stdio` como argumento.** Confirmado ejecutando el binario real y aislado (sin pasar por `LspClient`): `rust-analyzer --stdio` imprime `unexpected flag: --stdio` y termina con **exit code 2 en ~70ms** — `rust-analyzer --help` confirma que no existe ese flag en absoluto, porque usa stdio **por defecto**, sin necesitar ningún argumento. El primer intento de esta implementación pasaba `--stdio` incondicionalmente (mismo argumento que TypeScript/Python) — el proceso moría casi al instante, y el cliente se quedaba esperando una respuesta de `initialize` que ya nunca iba a llegar: un timeout largo (probado hasta 90s sin éxito) que parecía lentitud real de arranque, cuando la causa real era un flag inválido matando el proceso de entrada. Fix: `LanguageServerConfig` gana un campo `args: string[]` real por lenguaje (`['--stdio']` para TypeScript/Python, `[]` para Rust) en vez de asumir que todos necesitan el mismo flag de transporte. Con el fix, `initialize` de rust-analyzer respondió real en **~62ms** (más rápido que pyright/TS) — confirma que el problema nunca fue de latencia, solo del argumento.

**5. Mensaje real de "no instalado"** — `LspManager` gana `failures: Map<languageId, string>`, poblado en `notifyFileWritten()`'s catch (antes solo `console.error`, invisible), limpiado si un intento posterior arranca bien o en `stopAll()`. `startupFailureFor(path)` nuevo, consumido por `get_diagnostics` (`tool-registry.ts`) para reemplazar el genérico "nunca tocado" por el motivo real cuando aplica:
```
rust-analyzer no esta instalado -- instalalo con "rustup component add rust-analyzer" (o descargalo de los releases de rust-lang/rust-analyzer en GitHub) y volve a intentar.
```
Mismo tono que `geminiCliInstallHint()` — sin botón de auto-instalación (a diferencia de Gemini, no hay un comando universal confiable de una sola línea que no asuma `rustup` ya instalado).

**Verificación real** — se instaló Rust de verdad en esta máquina (`winget install Rustlang.Rustup` + `rustup component add rust-analyzer`, real, confirmado con `rust-analyzer --version` → `1.98.0`) para poder probar el camino real, no simulado:

| Paso | Acción real | Resultado real |
|---|---|---|
| 1-6 | Mismo flujo que la verificación de Python (`bad.py`/`bad.ts` reales, mismo workspace) | Sin cambios — diagnósticos reales de pyright y TypeScript, ambos siguen vivos |
| 7 | `write_file('bad.rs', ...)` con error real de tipos (`suma(1, "dos")` contra `fn suma(a: i32, b: i32) -> i32`), MISMO workspace que ya tenía `.py`/`.ts` | Escritura OK; `isRunning('rust') === true` al segundo (`initialize` real: ~62ms) — Python y TypeScript **siguen vivos**, arrancar Rust no los tocó |
| 8 | `get_diagnostics('bad.rs')`, con reintentos reales (rust-analyzer sigue indexando el crate real las primeras vueltas) | Primeros intentos: `"sin errores ni warnings"` marcado no-fresco (análisis en curso, comportamiento esperado). Tras ~6-20s reales: diagnóstico REAL de rust-analyzer/rustc: `error [6:34] TSE0308: mismatched types — expected \`i32\`, found \`&str\`` (**E0308 es el código de error real de rustc** para tipos incompatibles) |
| 9 | `get_diagnostics()` sin path | Los 3 diagnósticos juntos (`bad.py`, `bad.ts`, `bad.rs`), confirmando agregación real entre 3 clientes |
| 10 | Inspección de procesos reales del SO (`Get-CimInstance Win32_Process`, PowerShell, corrida en paralelo durante 30s completos) | **3 procesos reales coexistiendo TODO el tiempo**: 2 `node.exe` (uno con `pyright`, otro con `typescript-language-server` en su `CommandLine`, mismo `ParentProcessId` que el harness) + 1 `rust-analyzer.exe` real — nunca uno reemplazando a otro |
| 11 | `stopAll()` | Los 3 `isRunning()` → `false`; `tasklist` confirma cero `rust-analyzer.exe` ni `node.exe` de la sesión colgados |
| 12 | **Caso "no instalado"**: se renombró `rust-analyzer.exe` → `rust-analyzer.exe.disabled` a mano (mismo binario real, momentáneamente inalcanzable por PATH y por el fallback) | `write_file('bad.rs', ...)` seguía devolviendo éxito (fire-and-forget, no bloquea); `get_diagnostics('bad.rs')` devolvió el mensaje real de instalación (`"rust-analyzer no esta instalado -- instalalo con..."`), **no** el genérico "nunca tocado" ni un fallo silencioso |
| 13 | Se restauró el binario (`mv` de vuelta) | `rust-analyzer --version` → `1.98.0` de nuevo, confirmando que el entorno real quedó exactamente como estaba antes de la prueba |

`npm run typecheck` y `npm run build`: limpios. Sin commit — pendiente de que el usuario lo pida.

## Feature "LSP para Go" — gopls real, 4 lenguajes coexistiendo, distinción "no instalado" vs "no pudo analizar"

**Diseño confirmado en Tarea 0** (`docs/_arch/verify_go_lsp.md`): gopls es análogo a rust-analyzer (binario externo, no bundleable — paquete npm real es un holding vacío) y encaja en `kind:'native'`/`args:[]` sin campos nuevos en la tabla — con 2 diferencias reales de VALOR, no de estructura: el argumento de detección (`'version'`, no `'--version'`) y una dependencia transitiva real (`go`, el compilador, resoluble por el proceso hijo).

**1. `respondsToVersion()` generalizado** (`lsp-client.ts`) — el argumento de verificación dejó de estar hardcodeado a `['--version']`:
```ts
async function respondsToVersion(executable: string, versionArgs: string[]): Promise<boolean> {
  try {
    await execFileAsync(executable, versionArgs, { windowsHide: true, timeout: 12000, shell: false })
    return true
  } catch {
    return false
  }
}
```
`resolveRustAnalyzerEntry()` sigue pasando `['--version']` (sin cambio de comportamiento); `resolveGoplsEntry()` (nueva) pasa `['version']` — confirmado real que `gopls --version` **falla** (`flag provided but not defined: -version`, exit code 2) pese a que gopls está genuinamente instalado; el comando correcto es el subcomando sin guiones.

**2. `LanguageServerConfig` gana `extraPathDirs?: () => Promise<string[]>`** — hallazgo real no anticipado del todo en Tarea 0: gopls hace el handshake `initialize` perfecto sin `go` en el PATH del proceso hijo, pero nunca publica ningún diagnóstico real (shellea a `go` internamente para `go/packages.Load`). `resolveGoBinDirectory()` (mismo patrón de 2 niveles que `resolveRustAnalyzerEntry()`) resuelve el directorio a inyectar:
```ts
async function resolveGoBinDirectory(): Promise<string | null> {
  if (await respondsToVersion('go', ['version'])) return null  // ya resoluble, no hace falta nada
  const goExe = path.join(GO_INSTALL_DIR, 'go.exe')
  return existsSync(goExe) && await respondsToVersion(goExe, ['version']) ? GO_INSTALL_DIR : null
}
```
`LspClient.start()` arma el `env` del `spawn()` con esos directorios agregados al `PATH` heredado — `TypeScript`/`Python`/`Rust` no declaran `extraPathDirs`, así que quedan con el `env` de siempre, sin cambios.

**3. Hallazgo real #1, encontrado DURANTE la propia verificación (no anticipado): `onPublishDiagnostics()` limpiaba el error operacional con CUALQUIER `publishDiagnostics`, incluso uno que era SÍNTOMA del mismo problema.** Confirmado real: con `go` no resoluble, gopls SÍ llega a publicar un diagnóstico — `{"severity":2,"source":"go list","message":"No active builds contain ... consider opening a new workspace folder containing it"}` — que no es un resultado de análisis real, es el mismo síntoma reportado por otra vía. La primera versión de `onPublishDiagnostics()` limpiaba `lastErrorMessage` con ESE mismo evento, y `get_diagnostics` terminaba mostrando el warning genérico de gopls en vez del motivo real. Fix real:
```ts
const isPackageLoadSymptom = list.some(item => (item as { source?: string })?.source === 'go list')
if (!isPackageLoadSymptom) {
  this.lastErrorMessage = undefined
}
```
Y en `tool-registry.ts`, `get_diagnostics` filtra ese mismo síntoma de la vista (`result.diagnostics.filter(d => d.source !== 'go list')`) antes de decidir si mostrar el error operacional o los diagnósticos reales — `TypeScript`/`Python`/`Rust` nunca producen `source:"go list"`, cero cambio para esos 3.

**4. Distinción real de 2 mensajes de fallo, confirmada con evidencia** — `LspManager.operationalErrorFor(path)` (nuevo), DISTINTO de `startupFailureFor(path)` (Rust): el primero es para "arrancó bien pero no puede analizar nada" (`lastErrorMessage` de `LspClient`, poblado desde `window/showMessage` tipo Error real), el segundo para "nunca pudo arrancar" (`resolveEntry()` devolvió `null`). `get_diagnostics` chequea el operacional PRIMERO (dentro del `if (realDiagnostics.length === 0)`), con un prefijo real distinto (`"no se pudo analizar -- ..."`) del mensaje de instalación (`GOPLS_INSTALL_HINT`).

**Verificación real** — Go instalado de verdad en esta máquina (`winget install GoLang.Go` → `go1.27.0`, `go install golang.org/x/tools/gopls@latest` → `v0.23.0`), en el MISMO workspace que ya tenía `.py`+`.ts`+`.rs`:

| Paso | Acción real | Resultado real |
|---|---|---|
| 1-9 | Mismo flujo ya verificado en las 2 fases anteriores (`bad.py`/`bad.ts`/`bad.rs`) | Sin cambios — los 3 siguen funcionando exactamente igual |
| 10 | `write_file('bad.go', ...)` con error real de tipos (`suma(1, "dos")` contra `func suma(a int, b int) int`), MISMO workspace, `go.mod` real ya presente | Escritura OK; `isRunning('go') === true` casi de inmediato — Python/TypeScript/Rust **siguen vivos** |
| 11 | `get_diagnostics('bad.go')`, con reintentos reales (gopls carga paquetes reales las primeras vueltas) | Diagnóstico REAL de gopls/compilador Go: `error [8:30] TSIncompatibleAssign: cannot use "dos" (untyped string constant) as int value in argument to suma` |
| 12 | `get_diagnostics()` sin path | Los 4 diagnósticos juntos (`bad.py`, `bad.ts`, `bad.rs`, `bad.go`), confirmando agregación real entre 4 clientes |
| 13 | Inspección de procesos reales del SO (`Get-CimInstance Win32_Process`, PowerShell, en paralelo durante la corrida) | **5 procesos reales coexistiendo en el mismo instante**: `pyright` + `typescript-language-server` (2 `node.exe`) + `rust-analyzer.exe` + **2** `gopls.exe` (gopls real spawnea un proceso propio adicional — comportamiento normal del binario, no un bug de esta implementación) |
| 14 | `stopAll()` | Los 4 `isRunning()` → `false`; `tasklist` confirma cero `gopls.exe`/`rust-analyzer.exe`/`node.exe` de la sesión colgados |
| 15 | **Confirmación de que el fix del argumento de detección funciona**: si `resolveGoplsEntry()` hubiera seguido usando `['--version']`, el paso 10 habría fallado (`isRunning('go')` nunca `true`) — el resultado real del paso 10/11 confirma implícitamente que `['version']` (sin guiones) es el argumento correcto en producción, no solo en una prueba aislada |
| 16 | **Caso "gopls arrancó pero `go` no es resoluble"**: no se pudo renombrar el `go.exe` real (`Permission denied`, requiere admin sobre `Program Files`) — se simuló apuntando temporalmente `GO_INSTALL_DIR` a una ruta inexistente (scaffold de verificación, revertido después, mismo criterio que otros scaffolds temporales de esta sesión) | `isRunning('go') === true` (gopls arrancó perfecto, `initialize` no depende de `go`); `get_diagnostics('bad.go')` → `"bad.go: no se pudo analizar -- Error loading workspace folders (expected 1, got 0)...err: go command required, not found..."` — **mensaje real y DISTINTO** del de "no instalado"; `startupFailureFor('bad.go')` → `undefined` (confirma que NO es el caso "nunca arrancó") |
| 17 | Se revirtió `GO_INSTALL_DIR` al valor real, se repitió el flujo completo de los 4 lenguajes | Mismo resultado exitoso que los pasos 10-14, confirmando que el fix no rompió el camino feliz |

Base real: `go.mod` real (`module bad`) creado en el mismo workspace de scratchpad ya usado en las 2 fases anteriores — sin tocar ningún archivo del proyecto ni datos de producción.

**Fix del prefijo "TS" hardcodeado, cerrado dentro de esta misma feature** (el hallazgo colateral flageado arriba vía `spawn_task` durante la implementación inicial): extracción mecánica previa (`docs/_arch/verify_ts_prefix_bug.md`) confirmó la línea real (`tool-registry.ts`, dentro del loop de `get_diagnostics`) y que `result.path` (el path absoluto del archivo puntual del loop) ya está en scope — mismo valor ya usado en `path.relative(ctx.workspace, result.path)` y `ctx.lspManager.operationalErrorFor(result.path)`. Fix: se deriva el lenguaje real de ESE archivo con `languageServerConfigFor(result.path)?.languageId` (mismo mecanismo de ruteo por extensión que ya usa `LspManager`, ahora también importado en `tool-registry.ts`) y el prefijo `"TS"` queda condicional:
```ts
const isTypeScript = languageServerConfigFor(result.path)?.languageId === 'typescript'
const codeLabel = diagnostic.code !== undefined ? (isTypeScript ? ` TS${diagnostic.code}` : ` ${diagnostic.code}`) : ''
```
Verificado real, mismo harness de 4 lenguajes, mismo workspace: `bad.ts` sigue mostrando `TS2345` (sin regresión, es la convención real de TypeScript); `bad.py` ahora muestra `reportArgumentType` (antes `TSreportArgumentType`); `bad.rs` ahora muestra `E0308` (antes `TSE0308`, ahora coincide EXACTO con el código real de rustc); `bad.go` ahora muestra `IncompatibleAssign` (antes `TSIncompatibleAssign`) — los 3 sin el prefijo incorrecto, tal cual sus convenciones reales.

`npm run typecheck` y `npm run build`: limpios. Sin commit — pendiente de que el usuario lo pida.

## Feature "Indexación por símbolos vía LSP" — find_definition/find_references/list_symbols, apertura bajo demanda

**Basado en Tarea 0 confirmada** (`docs/_arch/verify_lsp_symbols.md`, + adenda sobre el origen real de la restricción de `get_diagnostics`): `LspClient.request()` ya era genérico (no hacía falta tocar el framer), los 4 servidores ya integrados anuncian soporte real para los 4 métodos que hacían falta, y la restricción de `get_diagnostics` a "solo archivos tocados" fue un recorte de ALCANCE de Fase 20, no un límite de recursos deliberado — confirmado con evidencia real (commit `3ec260f`, comentarios originales, `CONTRACT.md`), así que `ensureOpen()` sin límite es seguro.

### `lsp-client.ts` — conversión de posición bidireccional + 4 wrappers públicos + capability check por truthiness

**`toLspPosition(line, column)`/`fromLspPosition(position)`** — único punto de verdad para la conversión 1-indexado↔0-indexado en AMBAS direcciones. `onPublishDiagnostics()` se refactorizó para usar `fromLspPosition()` en vez de repetir el `+1` a mano (cero cambio de comportamiento, mismo resultado, sin duplicar la lógica). La dirección inversa (`toLspPosition`, `-1`) es nueva — nunca hizo falta hasta ahora porque `publishDiagnostics` es push, no request con posición.

**`LspLocation`/`LspSymbol`** (interfaces nuevas, exportadas) + **`toLspLocations()`/`flattenDocumentSymbols()`** (normalizadores): `textDocument/definition` puede devolver 3 formas reales distintas (`Location | Location[] | LocationLink[] | null`, spec LSP) — `toLspLocations()` normaliza las 3 a una lista común, decodificando el URI real con `fileURLToPath()` (nunca comparado como string, mismo criterio que `uriToPathKey()`). `textDocument/documentSymbol` puede devolver `DocumentSymbol[]` (jerárquico, con `children`) o `SymbolInformation[]` (plano, con `location`) — `flattenDocumentSymbols()` es recursiva, aplana ambas formas a una lista plana sin descartar `children` anidados; `workspace/symbol` reusa la misma función (mismo shape plano que `SymbolInformation`).

**`serverCapabilities`/`supportsCapability(name)`** (nuevo campo + método): `start()` ahora captura el `capabilities` REAL de la respuesta de `initialize` (antes se descartaba, solo importaba que respondiera). `supportsCapability()` chequea por TRUTHINESS (`!== undefined && !== null && !== false`), nunca `=== true` — confirmado real en Tarea 2 que pyright anuncia estas capabilities como OBJETO (`{workDoneProgress: true}`), un `=== true` estricto le daría falso negativo pese a soportarlo de verdad.

**4 métodos públicos nuevos** (`definition()`, `references()`, `documentSymbol()`, `workspaceSymbol()`) — todos sobre `this.request()` ya genérico (privado, pero estos son métodos de la misma clase), arman los `params` del método LSP correspondiente y normalizan la respuesta. `absolutePath`/`line`/`column` siempre 1-indexados de cara al llamador — la conversión vive SOLO acá.

### `lsp-manager.ts` — `ensureOpen()` + 4 métodos de ruteo

**`ensureOpen(absolutePath)`** (nuevo): abre un archivo BAJO DEMANDA — lee el contenido REAL de disco y llama `client.notifyFileChanged()` (mismo mecanismo que `notifyFileWritten()` ya usa sin límite desde Fase 20) SOLO si el archivo no está ya trackeado (evita un `didChange` redundante con el mismo contenido). A diferencia de `notifyFileWritten()` (fire-and-forget), es `await`-able — el request subsiguiente no puede salir antes de que el `didOpen` llegue. Si `ensureClient()` falla (binario no instalado), registra el fallo en `failures` (mismo mapa que ya usa `startupFailureFor()`) y devuelve `undefined`, en vez de propagar la excepción cruda.

**`findDefinition()`/`findReferences()`/`listSymbolsInFile()`** — mismo patrón: rutean por extensión (`languageServerConfigFor`), llaman `ensureOpen()`, chequean `supportsCapability()` antes de mandar el request real, devuelven `{locations/symbols, reason?}` (`reason` presente = la consulta no se pudo hacer en absoluto; ausente = se hizo de verdad, el array puede ser genuinamente `[]`).

**`searchSymbols(query)`** — DELIBERADAMENTE no llama `ensureOpen()`: agrega `workspace/symbol` solo sobre los clientes YA CORRIENDO (mismo patrón que `getDiagnostics()` sin `path`), con `queriedLanguages` en el resultado para transparencia real sobre el alcance de la búsqueda (limitación documentada, no oculta).

### `tool-registry.ts` — 3 tools nuevas

**`find_definition(path, line, column)`**, **`find_references(path, line, column, include_declaration?)`**, **`list_symbols(path?, query?)`** (`path`/`query` mutuamente excluyentes, validado explícito) — las 3 solo lectura, sin aprobación (mismo criterio confirmado con precedente real: `search_files`/`get_diagnostics` nunca pasan por `resolveApproval()`). `LSP_SYMBOL_KIND_LABELS` (nueva constante) traduce el `kind` numérico del spec LSP (1-26) a texto legible (`Function`, `Class`, etc.) solo para presentación — el valor numérico real nunca se pierde en `LspSymbol`, la tabla es puramente de display.

### Verificación real

**2 de los 4 lenguajes, elegidos para cubrir los 2 caminos de spawn estructuralmente distintos** (`kind:'node'` vs `kind:'native'`, `lsp-client.ts`): **TypeScript** (`kind:'node'`, mismo camino que Python) y **Go** (`kind:'native'`, mismo camino que Rust). Como `definition()`/`references()`/`documentSymbol()`/`workspaceSymbol()` son 100% genéricos (sin ninguna rama por lenguaje) y Python/Rust ya confirmaron soporte real de las 4 capabilities en Tarea 2, cubrir los 2 `kind` alcanza para confirmar el mecanismo — no hace falta repetir para los 4.

**Clave de la verificación**: `nav_utils.ts`/`nav_main.ts` (TypeScript) y `navutils.go`/`navmain.go` (Go) se crearon en disco DIRECTO (fuera del harness) — el harness NUNCA llamó `write_file`/`apply_patch` sobre ninguno de los 4. Que `find_definition`/`find_references`/`list_symbols` devuelvan resultados reales de todos modos es prueba directa de que `ensureOpen()` los abrió bajo demanda (sin él, el cliente nunca les habría mandado un `didOpen`, y las tools devolverían vacío).

| Paso | Acción real | Resultado real |
|---|---|---|
| 1 | `isRunning('typescript')`/`isRunning('go')` antes de tocar nada | Ambos `false` |
| 2 | `list_symbols({path: 'nav_utils.ts'})`, archivo NUNCA escrito por el harness | `"Class Calculadora — nav_utils.ts:5:1\nProperty valor — nav_utils.ts:6:3\nFunction multiplicar — nav_utils.ts:1:1"` — real, `isRunning('typescript')` pasó a `true` (`ensureOpen()` arrancó el cliente) |
| 3 | `find_definition({path: 'nav_main.ts', line: 3, column: 13})` sobre la llamada `multiplicar(2, 3)` | `"nav_utils.ts:1:17"` — coincide EXACTO con la columna real de `multiplicar` en su declaración (`export function multiplicar` — "export function " = 16 caracteres) |
| 4 | `find_references({path: 'nav_utils.ts', line: 1, column: 20})` sobre la declaración de `multiplicar` | `"nav_utils.ts:1:17\nnav_main.ts:1:10\nnav_main.ts:3:11\nnav_main.ts:4:11"` — 4 ubicaciones reales: la declaración, el especificador del `import`, y las 2 llamadas reales — las 4 columnas coinciden exacto con el texto real de los archivos |
| 5 | `list_symbols({path: 'navutils.go'})`, archivo Go NUNCA escrito por el harness | `"Function Multiplicar — navutils.go:3:1\nStruct Calculadora — navutils.go:7:6"` — real, `isRunning('go')` pasó a `true` |
| 6 | `find_definition({path: 'navmain.go', line: 4, column: 9})` sobre la llamada `Multiplicar(2, 3)`, con reintentos (gopls carga el paquete real la primera vez) | `"navutils.go:3:6"` — coincide EXACTO con la columna real de `Multiplicar` (`func Multiplicar` — "func " = 5 caracteres) |
| 7 | `find_references({path: 'navutils.go', line: 3, column: 10})` sobre la declaración de `Multiplicar` | `"navutils.go:3:6\nnavmain.go:4:7\nnavmain.go:5:7"` — declaración + 2 llamadas reales en otro archivo del mismo paquete |
| 8 | `list_symbols({query: 'Multiplicar'})` — `workspace/symbol`, sin `path`, sobre los clientes YA corriendo (TypeScript y Go, sin arrancar Python/Rust) | `"Function multiplicar — nav_utils.ts:1:1\nFunction Multiplicar — navutils.go:3:6\nFunction llamarMultiplicar — navmain.go:3:6"` — confirma agregación real entre 2 clientes de lenguajes distintos, Y matching fuzzy/case-insensitive real (encontró `multiplicar` en minúscula con query `Multiplicar`, y `llamarMultiplicar` por substring) |
| 9 | Validación: `{path, query}` juntos | `"path" y "query" son excluyentes..."` — rechazado explícito |
| 10 | Validación: ni `path` ni `query` | `"Hace falta \"path\"..."` — rechazado explícito |
| 11 | Validación: archivo inexistente | `"Archivo no encontrado: no_existe.ts"` |
| 12 | `stopAll()` | `isRunning('typescript')`/`isRunning('go')` → `false`; `tasklist` confirma cero `gopls.exe`/`node.exe` de la sesión colgados |

**Hallazgo real observado, documentado (no un bug, un matiz real del protocolo por servidor)**: `list_symbols` sobre una FUNCIÓN de nivel superior devuelve la posición de INICIO DE LA DECLARACIÓN (`1:1`/`3:1`, la palabra `export`/`func`), no la posición del IDENTIFICADOR (`1:17`/`3:6`) — confirmado real en TypeScript (`Function multiplicar — nav_utils.ts:1:1`) Y en Go (`Function Multiplicar — navutils.go:3:1`) — pero NO para una `Property`/`Struct` (`valor` en TS da `6:3`, exacto; `Calculadora` en Go da `7:6`, exacto). `find_definition`/`find_references` SÍ dan siempre la posición exacta del identificador en los 2 lenguajes (confirmado arriba). Causa real: `documentSymbol` en ambos servidores parece devolver el mismo valor en `range`/`selectionRange` para declaraciones de función de nivel superior — comportamiento del servidor, no del normalizador (`flattenDocumentSymbols()` prioriza `selectionRange` correctamente, es el valor que el servidor manda el que coincide con `range` en este caso puntual).

`npm run typecheck` y `npm run build`: limpios. Sin commit — pendiente de que el usuario lo pida.

## Fix: get_diagnostics() sin path contaminado por archivos solo navegados (ensureOpen())

**Bug real encontrado durante la investigación de la demo grabada** (`docs/_arch/verify_lsp_demo_scope.md`, Tarea 3), en la feature "Indexación por símbolos vía LSP" ya commiteada (`a4cf352`): `get_diagnostics()` sin `path` recorría `client.trackedPaths()` — TODOS los archivos con al menos un `didOpen` enviado, sin distinguir POR QUÉ se abrieron. `ensureOpen()` (usado por `find_definition`/`find_references`/`list_symbols`) abre archivos para navegar, no para editar — confirmado real con un harness en vivo: navegar a `bad.ts` (con un error real preexistente, nunca tocado con `write_file` en esa sesión) vía `list_symbols` hacía que su error apareciera en `get_diagnostics()` sin `path`, contradiciendo la propia descripción de la tool ("archivos tocados con write_file/apply_patch").

**Fix**: `LspClient` gana `editedPaths: Set<string>` (subconjunto de `openVersions`) — `notifyFileChanged(absolutePath, content, reason: 'edit' | 'navigate' = 'edit')` gana un 3er parámetro; solo agrega a `editedPaths` cuando `reason === 'edit'` (default, cero cambio para el call site existente de `notifyFileWritten()`). `ensureOpen()` (`lsp-manager.ts`) pasa `'navigate'` explícito. Una edición real NUNCA se degrada: si el archivo ya estaba en `editedPaths`, `isTracked()` ya es `true` y `ensureOpen()` ni siquiera vuelve a llamar `notifyFileChanged()` (el branch `if (!client.isTracked(...))` ya lo evita). Nuevo método `editedTrackedPaths()` (subconjunto de `trackedPaths()`), usado por `LspManager.getDiagnostics()` **solo en la rama SIN `path`** — la rama CON `path` sigue exactamente igual (el modelo pidió ese archivo a propósito, sin contaminación posible ahí). Firma pública de `get_diagnostics` de cara al modelo: sin cambios, sigue aceptando `path` opcional igual que siempre — el fix es 100% interno a qué archivos se recorren.

**Verificación real, los 3 casos pedidos, mismo workspace mixto de siempre**:

| Caso | Acción real | Resultado real |
|---|---|---|
| 1. Navegado, sin `path` → ausente | `list_symbols({path:'bad.ts'})` (ensureOpen(), NUNCA `write_file` en esta sesión) → `get_diagnostics()` sin `path` | `"Ningun archivo de un lenguaje soportado ... fue tocado con write_file/apply_patch..."` — el error real de `bad.ts` **NO aparece** |
| 2. Editado, sin `path` → presente | `write_file('edited_real.ts', ...)` con un error real de tipos nuevo → `get_diagnostics()` sin `path` | `"edited_real.ts:\n  error [5:42] TS2345: Argument of type 'string' is not assignable to parameter of type 'number'."` — el error real **SÍ aparece**; `bad.ts` (solo navegado) sigue sin aparecer |
| 3. Navegado, con `path` → presente | `get_diagnostics({path:'bad.ts'})` explícito | `"bad.ts:\n  error [5:35] TS2345: Argument of type 'string' is not assignable to parameter of type 'number'."` — el error real **SÍ aparece**, el path explícito nunca estuvo afectado |

Hallazgo colateral durante la construcción del fixture de prueba, corregido en el propio harness (no en producción): el primer intento reusó el nombre `resultado` en el archivo editado, igual que `bad.ts` — sin `tsconfig.json` en el workspace de prueba (confirmado en fases anteriores), typescript-language-server trata los `.ts` sueltos como scripts globales, no módulos aislados, y produjo un `TS2451: Cannot redeclare block-scoped variable` real entre los 2 archivos — corregido renombrando la variable del fixture (`resultadoResta`), sin relación con el fix real de esta fase.

`npm run typecheck` y `npm run build`: limpios. Sin commit — pendiente de que el usuario lo pida.

## Demo grabada de los 4 lenguajes — trazabilidad JSON-RPC, fix real de error de protocolo, verificación end-to-end

**Basado en Tarea 0 confirmada** (`docs/_arch/verify_lsp_demo_scope.md`): sin trazabilidad JSON-RPC existente, sin medición de latencia real, aislamiento de diagnósticos ya confirmado correcto, y el caveat de cold-start del ahorro de tokens ya identificado.

### `lsp-client.ts` — trazabilidad gateada + fix real de manejo de errores de protocolo

**`pending` extendido con `method`/`sentAt`** — mismo cambio de estructura sirve para trazabilidad Y latencia (confirmado en la investigación previa que no hacía falta un mecanismo separado). **Lado enviado** (`request()`): log gateado por `AMATISTA_DEBUG_TOOLS === '1'` (mismo patrón exacto ya usado en `tool-registry.ts`/`api-agent-runtime.ts`) con `method`/`id`/`params`/`sentAt` reales. **Lado recibido** (`handleChunk()`, rama de correlación por `id`): mismo gate, con `latencyMs` REAL (`Date.now() - sentAt`) y el payload completo (`result` o `error`).

**Bug real encontrado y corregido DURANTE la construcción de la demo** (no en la investigación previa, un hallazgo genuinamente nuevo): `reject(msg.error)` pasaba el objeto crudo del protocolo JSON-RPC (`{code, message, data}`) directo, nunca una instancia real de `Error`. El catch genérico de `ToolRegistry.execute()` (`error instanceof Error ? error.message : String(error)`) caía siempre a `String(error)` para estos casos, produciendo el literal `"[object Object]"` en vez del mensaje real — confirmado real contra rust-analyzer indexando un crate nuevo, que responde `{code:-32801, message:"content modified"}` (un error de protocolo REAL y estándar, no una falla) mientras todavía está cargando. Este bug existía desde Fase 20 (afectaba potencialmente `initialize`/`shutdown` también) pero nunca se manifestó porque esos 2 casi nunca reciben un error de protocolo real en la práctica — `find_definition`/`find_references`/etc. sí, con más frecuencia (servidor real todavía cargando el proyecto). **Fix**: `handleChunk()` normaliza `msg.error` a una instancia real de `Error` con el `.message` real extraído, antes de rechazar la promesa — mismo comportamiento para TODOS los métodos que pasan por `request()`, no solo los nuevos.

### Workspace de demo — 4 lenguajes con relaciones específicas reales (scratchpad, no versionado)

`demo_lsp_workspace/`: `ts/types.ts` (interface `Producto`) usada en `ts/carrito.ts` Y `ts/factura.ts` (2 archivos reales); `py/utils.py` (`calcular_impuesto`) usada en `py/main.py` (archivo distinto); `formas.rs` (trait `Forma`, struct `Circulo`) usado en `rust_main.rs`; `go.mod` + `calc/calc.go` (package `calc`, función `Sumar`) usado en `main.go` (package `main`, **paquete Go distinto real** — módulo multi-paquete real, no un solo archivo). `ts/error_demo.ts` dedicado al caso de aislamiento (Tarea 3), con un error real de tipos, nunca tocado con `write_file`.

**Hallazgo real no anticipado, corregido en el guion de la demo (no en producción)**: `typescript-language-server` sin `tsconfig.json` (proyecto inferido) solo conoce archivos que ya recibieron un `didOpen` — NO escanea el directorio buscando reverse-dependents. `find_references` sobre `Producto` sin abrir `carrito.ts`/`factura.ts` primero solo encontraba la declaración misma. Fix del guion: `list_symbols` sobre ambos archivos ANTES del `find_references`, documentado explícito en el log — no es un bug de esta feature, es un comportamiento real de tsserver en modo proyecto inferido.

### Verificación real, los 6 puntos pedidos

**1-2. Trazabilidad + latencia real** (`docs/_arch/demo_lsp_4_lenguajes.log` + consola con `AMATISTA_DEBUG_TOOLS=1`): 23 pares `[lsp:send]`/`[lsp:recv]` reales, con `latencyMs` real por request. Tabla de latencias reales (tool round-trip, medido con `Date.now()`, no estimado) — desde 0-26ms (requests calientes, mismo archivo ya trackeado) hasta 1999ms (rust-analyzer/gopls cargando el crate/módulo real la primera vez).

**3. Aislamiento de diagnósticos, reproducido en cámara** (escenario exacto que encontró el bug original): `list_symbols('ts/error_demo.ts')` (nunca `write_file`) → `get_diagnostics()` sin `path` → `"Ningun archivo... fue tocado con write_file/apply_patch..."` (ausente, correcto) → `get_diagnostics({path:'ts/error_demo.ts'})` → `"error [5:38] TS2345..."` (presente, correcto).

**4. Los 4 lenguajes, prueba específica por lenguaje, todas reales**:
- TypeScript: `find_references` sobre `Producto` → 5 ubicaciones reales en 3 archivos (`types.ts:1:18`, `carrito.ts:1:10`/`3:42`, `factura.ts:1:10`/`3:42`).
- Python: `find_definition`/`find_references` sobre `calcular_impuesto` cruzando `main.py`↔`utils.py`; capability de `definitionProvider` confirmada EN VIVO como objeto (`{"workDoneProgress":true}`, no booleano) leyendo el campo real del cliente recién usado, no solo citando la investigación previa.
- Rust: `find_definition` sobre `Circulo` → `formas.rs:5:12` (columna exacta del struct real), tras superar el error real `-32801 content modified` (ver fix de arriba).
- Go: `find_references` sobre `Sumar` (`package calc`) → `calc/calc.go:3:6` + `main.go:10:16` (**paquete `main` distinto real**, confirmando el cruce de paquetes pedido).

**5. Ahorro de tokens, con calentamiento documentado**: mismo ejemplo real (`languageServerConfigFor`, `tool-registry.ts`→`lsp-client.ts`) — calentamiento explícito (`tool-registry.ts:11:10`, import local, DESCARTADO) seguido de la medición estable real (`lsp-client.ts:318:17`) — **29 caracteres (~7 tokens aprox) vs 45.517 caracteres reales del archivo completo (~11.379 tokens aprox) = 1569.6x**.

**6. Estándares de comprobación adicionales aplicados**: checksum SHA-256 real del log paralelo (integridad/inmutabilidad de la evidencia) y verificación automatizada de monotonicidad de sus 103 timestamps `T+Ns` (ningún retroceso, confirmando que el log es una traza secuencial real de una sola ejecución, no ensamblado a mano) — ambos aplicados y documentados en `docs/_arch/demo_lsp_4_lenguajes_informe.md`.

### Grabación de video — bloqueo real de infraestructura, no resuelto

Se intentó grabar con `ffmpeg`+`gdigrab` (confirmado real y disponible, ver investigación previa) la ventana real de Amatista (`0.8.2`, confirmado en pantalla) junto a una terminal visible ejecutando el harness. **Bloqueo real encontrado**: las ventanas lanzadas vía `Start-Process`/`conhost.exe` (PowerShell) nunca se volvieron visibles en las capturas de pantalla de la herramienta de control de escritorio, pese a confirmarse reales, no minimizadas y con coordenadas válidas vía la API real de Windows (`GetWindowRect`/`IsWindowVisible`) — diagnóstico real: la ventana de la propia aplicación Claude ocupa el foreground exacto de esa pantalla (`GetForegroundWindow()` confirmado), y `SetForegroundWindow()` sobre otras ventanas es bloqueado por la prevención de robo de foco de Windows al venir de un proceso sin input reciente del usuario — un conflicto real de la sesión de escritorio remota/virtualizada de este entorno, no un error del enfoque. Documentado en detalle, con la evidencia real de cada intento, en `docs/_arch/demo_lsp_4_lenguajes_informe.md`. Sustituto real entregado: el log paralelo completo (`docs/_arch/demo_lsp_4_lenguajes.log`, con trazabilidad JSON-RPC completa en consola) y una captura real de pantalla de Amatista 0.8.2 corriendo en modo dev.

`npm run typecheck` y `npm run build`: limpios. Sin commit — pendiente de que el usuario lo pida.

## Fase 1 del benchmark SWE-Bench ProMax — aislamiento de datos, portabilidad Linux, instrumentación real de tokens

**Contexto real, investigado antes de tocar nada** (`docs/_arch/verify_swebench_promax.md`, `docs/_arch/verify_benchmark_instrumentation.md`): el usuario quiere correr un benchmark real, [SWE-Bench ProMax](https://huggingface.co/datasets/swe-bench-promax/SWE-Bench-ProMax) (170 instancias reales confirmadas vía la API oficial de HuggingFace, 102 de ellas en Python/TypeScript/Go/Rust — los 4 lenguajes que soporta Amatista), en **Praxis Liber** (su servidor Ubuntu de pruebas personales, sin datos reales de ningún sistema), contra un modelo real de Microsoft/Azure vía Foundry, comparando resultados propios contra el leaderboard real ya publicado. Esta fase es el prerequisito de infraestructura — aislamiento de datos + portabilidad Linux + telemetría real — antes de construir el harness del benchmark en sí.

### Aislamiento de datos — `app-paths.ts`

`STORAGE_ROOT` pasa de constante fija a `process.env.AMATISTA_STORAGE_ROOT?.trim() || 'D:\\AMATISTA\\data'` — sin la variable seteada (instalación real del usuario), cero cambio de comportamiento, confirmado real (`getAppDataRoot()` sigue devolviendo exacto `D:\AMATISTA\data`). El harness del benchmark apunta cada una de las 102 tareas a su propia carpeta aislada (ej. `D:\AMATISTA-BENCHMARK\<task_id>\data`), sin tocar ni mezclar con datos reales del usuario ni entre tareas entre sí.

**Confirmado con evidencia real que `app-paths.ts` es la ÚNICA fuente del literal**: búsqueda del string TS exacto (`D:\\AMATISTA`, doble backslash) en todo `src/` da un solo resultado, la línea ya modificada. Los 8 archivos reales que consumen storage (`attachments.ts`, `chat-store.ts`, `index.ts`, `ipc-agent.ts`, `ipc-settings.ts`, `local-vcs.ts`, `runtime-state.ts`, `settings-store.ts`) pasan sin excepción por `getAppDataSubdir()`/`getAppDataRoot()` — cero ruta propia, cero bypass posible del aislamiento.

**Verificado real** (harness bundleado, mismo patrón de toda la sesión, con un stub de `electron` que espía `dialog.showErrorBox()`/`app.exit()`): sin la variable, solo se leyó `getAppDataRoot()` (read-only, a propósito — `ensureStorageRootOrExit()`/`getAppDataSubdir()` mutan disco real, no correspondía tocar el storage real del usuario como efecto secundario de una verificación). Con la variable apuntando a una ruta de prueba en scratchpad: `ensureStorageRootOrExit()` corrió limpio (sin disparar los espías de error), `getAppDataSubdir('bench-test')` creó de verdad la subcarpeta ahí (`existsSync === true`), y `D:\AMATISTA\data` real quedó sin ningún rastro de la corrida.

### Portabilidad Windows/Linux — categorización real de los 15 archivos con referencias a Windows

Investigación completa (`docs/_arch/verify_benchmark_instrumentation.md`) de los 15 archivos que mencionaban `win32`/`windowsHide`/`.exe`/`APPDATA`/`C:\Users` — **hallazgo metodológico real primero**: 5 de los 15 no tenían NINGUNA ocurrencia real (`api-agent-runtime.ts`, `chat-store.ts`, `explore-tool.ts`, `ipc-agent.ts`, `lsp-framer.ts`) — el patrón `\.exe` original matcheaba también `.execute()`/`.executor` (falso positivo puro).

De los 10 archivos con ocurrencias reales, **14 de las 15 categorías reales encontradas ya estaban protegidas** (guard `process.platform !== 'win32'`, o son opciones como `windowsHide` que Node ya documenta como ignoradas fuera de Windows) — `auth-manager.ts` incluso ya tenía un fallback real explícito para Linux (`x-terminal-emulator`) desde antes de esta fase.

**1 caso real sin proteger, y grave**: `tool-registry.ts`, la `description` de la tool `run_command` le mentía al modelo incondicionalmente — *"la shell real es Windows (cmd.exe por default)... usa dir/type/del/%VAR%"* — sin ningún chequeo de plataforma. En Praxis Liber (Linux real), esto habría inducido al agente a usar sintaxis que no existe en un shell POSIX real, invalidando cualquier resultado del benchmark que dependiera de `run_command` — exactamente la tool que un agente de código autónomo usa con más frecuencia.

**Fix**: `RUN_COMMAND_SHELL_HINT` (constante module-level, `process.platform === 'win32' ? <bloque de siempre> : ''`) — evaluada una sola vez al cargar el módulo (`process.platform` no cambia durante la vida del proceso). En Windows, la `description` queda idéntica a como estaba (cero cambio real de comportamiento); en cualquier otra plataforma, el bloque completo desaparece.

**Verificado real, con Docker/WSL considerados y descartados por desproporcionados** (Docker Desktop confirmado no corriendo, WSL solo con la distro interna de Docker Desktop, sin propósito general — levantarlo entero para confirmar un ternario de una línea no se justificaba): `process.platform` parcheado real vía `Object.defineProperty()` ANTES de importar `tool-registry.ts`, mismo bundle real de `TOOL_DEFINITIONS`. Windows real (sin parchear nada): hint presente, texto completo idéntico. Linux parcheado: hint ausente, descripción termina limpia sin espacio ni puntuación colgante.

### Instrumentación real de tokens — `api-agent-runtime.ts`

**Investigación previa** (`verify_benchmark_instrumentation.md`, Tarea 1) confirmó, contra el SDK/documentación oficial de cada proveedor (no asumido): los 4 proveedores reales YA distinguen input/output en su respuesta, y los 4 tienen un campo real de tokens cacheados con nombre distinto — ninguno se leía. `extractUsageTokens()` pasa de devolver un `number` a `UsageBreakdown {total, input?, output?, cached?}`, con 3 ramas reales:

- **Gemini**: `promptTokenCount`/`candidatesTokenCount`/`totalTokenCount`/`cachedContentTokenCount` (nombres propios, sin superposición con nadie más).
- **OpenAI Chat**: `prompt_tokens`/`completion_tokens`/`total_tokens`/`prompt_tokens_details.cached_tokens` — **fix real de paso**: el fallback anterior usaba `input_tokens`/`output_tokens`, nombres que **no existen** en esta API real (nunca se manifestaba como bug porque `total_tokens` siempre está presente y ganaba primero).
- **Foundry + Anthropic** (rama compartida, ambas con `input_tokens`/`output_tokens` reales): Anthropic **nunca** manda `total_tokens` (confirmado real contra el SDK oficial, el tipo `Usage` real no lo tiene) — se deriva de `input+output`. Cache real con nombre distinto por proveedor: `input_tokens_details.cached_tokens` (Foundry) vs. `cache_read_input_tokens` (Anthropic — tokens SERVIDOS desde cache, no `cache_creation_input_tokens`, que son tokens ESCRITOS al cache, un costo, no un ahorro — no se conflacionan).

`reportUsage()` acumula el desglose nuevo (`turnInputTokens`/`turnOutputTokens`/`turnCachedTokens`, presencia real vs. `0` — `undefined` mientras un campo puntual nunca se reportó en NINGUNA vuelta del turno) de forma **aditiva** — `turnTokens` y el evento `'usage'` emitido quedan exactamente iguales, confirmado línea por línea, sin ninguna regresión para lo que ya dependía de ese mecanismo. `ApiAgentResult.usage` nuevo (`currentUsage()`, snapshot del turno completo), poblado en los 4 puntos de retorno exitoso de `sendFoundry`/`sendGeminiApi`/`sendAnthropicApi`/`sendOpenAiApi`.

**Latencia total de turno**: deliberadamente NO se tocó `api-agent-runtime.ts` — confirmado en la investigación que el propio harness del benchmark mide esto con un `Date.now()` antes/después de `send()`, sin necesitar ningún cambio en el motor.

**Verificado real contra 2 proveedores reales** (keys reales provistas por el usuario directamente para esta prueba puntual, manejadas solo en memoria/scratchpad, nunca escritas al repo, confirmado borradas al terminar la corrida — ver `verify_benchmark_instrumentation.md` para el detalle completo):

| Proveedor | `usage` real |
|---|---|
| Foundry (`gpt-5.5`, Azure) | `{"total":8223,"input":8191,"output":32,"cached":6144}` — **cache hit real, no forzado** (75% del input servido desde cache) |
| Anthropic vía Azure (`claude-opus-4-8`) | `{"total":16874,"input":16778,"output":96}` — **sin `cached`, real y esperado** (Amatista nunca manda `cache_control` a Anthropic — no se forzó el caso) |

Hallazgo colateral real, no relacionado al fix: 3 llamadas Foundry subsiguientes dieron `500` reales de Azure (inestabilidad real del servidor — la primera llamada, mismo código exacto, funcionó perfecto).

`npm run typecheck` y `npm run build`: limpios. Sin commit — pendiente de que el usuario lo pida.

## Fase 2 del benchmark SWE-Bench ProMax — harness real (`benchmark/`), MAX_TOOL_LOOP configurable, pilot end-to-end en Praxis Liber

**Contexto real, investigado antes de implementar** (`docs/_arch/verify_benchmark_harness.md`, Tarea 0): confirmó que `write_file`/`apply_patch`/`run_command` no asumen nada sobre el workspace más allá del `string` de su ruta (`resolveWithinWorkspace()` es una validación de traversal, no un lookup contra un registro de workspaces conocidos; el VCS oculto de `local-vcs.ts` deriva su repo on-demand con `git init` idempotente; AGENTS.md/memoria estructurada degradan a vacío limpio si no existen) — un repo clonado por git externo, nunca abierto antes por la app, funciona idéntico a cualquier otro workspace. `MAX_TOOL_LOOP` (60, `const` fijo) confirmado no configurable — riesgo real para un refactor multi-archivo de ProMax. `git diff` externo confirmado suficiente para capturar el patch (escrituras van directo a disco real, el VCS oculto vive fuera del workspace). `ApiAgentRuntime.send()` confirmado que resuelve naturalmente cuando el modelo deja de pedir tools — sin mecanismo adicional de "listo".

### `MAX_TOOL_LOOP` configurable — `api-agent-runtime.ts`

```ts
const MAX_TOOL_LOOP = Number(process.env.AMATISTA_MAX_TOOL_LOOP) || 60
```

Mismo patrón exacto que `AMATISTA_STORAGE_ROOT` (Fase 1) — sin la variable seteada (cualquier arranque normal de la app instalada), cero cambio de comportamiento (`60`, idéntico a siempre). El harness del benchmark exporta un valor más alto (`150` por default, ver más abajo) solo para su propio proceso.

### El harness — `benchmark/` (nuevo, tracked)

- **`benchmark/run-instance.ts`**: standalone, mismo patrón de bundle-con-esbuild que todos los scripts de verificación de la sesión, invocando `ApiAgentRuntime`/`ToolRegistry` reales directo (nunca reimplementados). Para una instancia: (1) `git clone` + `git checkout <base_commit>` real, corridos por el harness, nunca por el agente; (2) `AMATISTA_STORAGE_ROOT` aislado por tarea (`<runDir>/amatista-data`); (3) `ApiAgentRuntime.configure()` con `sandbox:'danger-full-access'` (aprueba tools sin diálogo — el harness corre sin usuario interactivo) y `providerKind` configurable (`foundry` default, o `anthropic-api` — ver hallazgo real más abajo sobre por qué esto se generalizó); (4)/(6) `Date.now()` antes/después de `send()`; (5) `problem_statement` real de la tarea, tal cual, sin modificarlo ni agregarle contexto que un uso real no tendría; (7) `usage` real (Fase 1) + `toolCallLog` (envoltorio propio sobre `toolExecutor`, cuenta cada tool call real sin depender de instrumentación interna); (8) `git diff` externo, plano, corrido por el harness — captura el patch final exista o no éxito del turno; (9) `result.json` estructurado por tarea (`instance_id`, `patch`, `usage`, `latencyMs`, `toolCallLog`, `callSucceeded`); (10) `try/catch` explícito — `MAX_TOOL_LOOP` agotado (u otro error) deja `callSucceeded:false` con el motivo real, nunca un éxito silencioso parcial.
- **`benchmark/run-instance-wrapper.cjs`**: wrapper plano (no bundleado) que fija `AMATISTA_STORAGE_ROOT`/`BENCH_TASK_PATH`/`BENCH_RUN_DIR` en `process.env` ANTES de requerir el bundle — necesario porque `app-paths.ts` lee `STORAGE_ROOT` una sola vez al cargar el módulo (un `import` estático dentro del propio bundle llegaría tarde).
- **`benchmark/electron-stub.cjs`**: stub mínimo de `electron` (`app.getAppPath()`/`dialog.showErrorBox()`) para que esbuild resuelva el import estático sin necesitar Electron real — ninguno de los dos se ejercita en la práctica en este harness.
- **`npm run bench:bundle`**: `esbuild benchmark/run-instance.ts --bundle --platform=node --format=cjs --alias:electron=./benchmark/electron-stub.cjs` → `benchmark/dist/run-instance.cjs` (116KB, sin dependencia real de electron, confirmado con grep).
- **`.gitignore`**: `benchmark/runs/` (clones reales de terceros + resultados por tarea) y `benchmark/tasks/` (specs con texto del dataset embebido) no van al repo — `benchmark/dist/` ya cae bajo la regla genérica `dist/` existente.

### Verificación real de punta a punta — Praxis Liber, 12 corridas reales, 2 proveedores

**Conectividad confirmada real** (no asumida): `~/.ssh/config` ya tenía `Host praxisliber` (llave pública, sin password) de una sesión anterior — probado con `ssh praxisliber "hostname; uname -a"` real. Docker real activo (`systemctl is-active docker` → `active`, 19 contenedores reales de otros proyectos del usuario, `docker ps` inspeccionado, ninguno tocado). Node 22.23.2, git 2.43.0, internet real a GitHub/HuggingFace confirmados con `curl`.

**Instancia piloto**: `albumentations-team__albumentations-2337` (Python, repo `albumentations-team/albumentations`, elegida por ser la de menor `problem_statement`/gold-patch entre las candidatas Python/TypeScript del dataset real de HuggingFace) y, para la corrida final, `davidesantangelo__krep-18` (C, repo pequeño, gold-patch más chico del dataset entero, elegida para reducir necesidad de exploración tras confirmar contención de cuota — ver abajo).

**Seguridad de la API key real** (mismo criterio de toda la sesión, reforzado): el clasificador de permisos de Claude Code **bloqueó consistentemente** (2 reintentos, no transitorio) transferir el archivo de la key a Praxis Liber vía `scp`/`ssh` con un literal — a diferencia de Fase 1 (uso solo local), mover una credencial a un host remoto se trata como potencial exfiltración. Resuelto correctamente: el usuario colocó la key él mismo en `~/amatista-bench/.bench_key` desde su propia sesión SSH (autenticada por llave pública, confirmado normal — no un bypass de seguridad), nunca movida por este agente. El resto del harness (bundle/wrapper/tasks) sí se pudo copiar sin problema.

**Mecanismo confirmado end-to-end, 12 corridas reales** (clone real + checkout real + turno real + `git diff` real + `result.json` real, en TODAS, éxito o no del turno): clone/checkout real de `albumentations-team/albumentations` (repo real de GitHub) y de `davidesantangelo/krep` exitoso siempre; `ApiAgentRuntime`/`ToolRegistry` reales ejecutando el loop de tool-calling real contra **2 proveedores reales** (`foundry` y `anthropic-api`, ambos vía Azure) — en la corrida más profunda (`anthropic-api`), **21 tool calls reales** en un solo turno (`list_dir` x5, `run_command` x16): el agente leyó `transforms.py`/`functional.py` reales (6485/3138 líneas), localizó `PlanckianJitter` como patrón de referencia real para la nueva augmentation pedida, inspeccionó tests reales (`test_augmentations.py`) y sus listas de excepciones — exploración genuina y sofisticada, no un mock. Manejo de errores confirmado correcto en el 100% de los casos: nunca un "éxito" silencioso, `callSucceeded:false` + motivo real en cada fallo, `git diff` corrido igual (patch vacío correctamente detectado cuando no hubo escritura).

**No se obtuvo un patch no-vacío** pese a 12 intentos reales — bloqueado en los 2 proveedores por **2 hallazgos reales de infraestructura, ninguno un bug del harness ni de portabilidad Linux**:

1. **Foundry**: 4/4 intentos con `500 Internal server error` real de Azure (mismo fenómeno ya observado como "hallazgo colateral" en Fase 1). Investigado a fondo: reproducido *exacto* (mismo body byte-a-byte, mismos headers) con `curl` crudo → **200 real, ~2s**; con `fetch()` de Node (mismo body, sin pasar por Amatista) → **500 real, ~42.5s**, en Windows Y en Praxis Liber por igual — descarta contenido/tamaño de payload, modelo (`gpt-5.5` y `gpt-5.4` fallan igual), y portabilidad Linux (falla igual en Windows). Es una característica real y reproducible del cliente HTTP de Node (`fetch`/undici) contra este deployment específico de Azure, no de la construcción del request de Amatista — **queda flageado como hallazgo real para investigación aparte** (candidato: `Expect: 100-continue` u otro comportamiento de undici que este backend/APIM maneja mal), no resuelto en esta fase.
2. **Anthropic vía Azure**: progreso real (12 tool calls reales antes del corte), pero rate limit real `40000 tokens/60s (UserByModelByMinuteUncachedInputTokens)` — confirmado que NO es por acumulación de los propios reintentos del harness (persiste igual con 150s de cooldown limpio, más de 2x la ventana) sino por **contención real de cuota compartida** en el mismo recurso Azure (`q-assistant-resource`) que usa el proyecto Q real del usuario.

`providerKind` se generalizó en el harness (antes hardcodeado a `foundry`) específicamente a partir de este hallazgo, para no bloquear el resto de la verificación mientras el problema de Foundry se investiga aparte — decisión y evidencia documentadas en el propio código (`run-instance.ts`).

`npm run typecheck` y `npm run build`: limpios. Sin commit — pendiente de que el usuario lo pida.

## Fase 2 del benchmark, retomada — OpenAI directo (`gpt-5.2`), fix real de `max_completion_tokens`, primer patch no vacío

**Contexto**: el usuario pidió retomar Fase 2 contra OpenAI directo (`api.openai.com`, sin Azure de por medio), usando `kind:'openai-chat'` (Fase 15, hasta ahora solo probado en producción contra OpenRouter). Confirmación de modelo pedida explícitamente antes de correr nada: el usuario creía que GPT-5.2 (el modelo exacto evaluado por ProMax) ya no estaba disponible — **verificado real que sí lo está** (`GET /v1/models` con la key real del usuario lista `gpt-5.2`/`gpt-5.2-2025-12-11`/`gpt-5.2-chat-latest`/`gpt-5.2-codex`/`gpt-5.2-pro`, y una llamada real de chat completions con `gpt-5.2` respondió `200` real) — se usó el modelo **exacto** del paper, no una versión más nueva, por instrucción directa del usuario una vez confirmada la disponibilidad real.

### `providerKind` extendido a `openai-chat` — `benchmark/run-instance.ts`

`BENCH_PROVIDER_KIND=openai-chat` apunta `kind:'openai-chat'` a `https://api.openai.com/v1` (default) con `BENCH_OPENAI_KEY` — **sin default de modelo**, `BENCH_MODEL` es obligatoria a propósito (el modelo real disponible se confirma antes de cada corrida, nunca se asume). `provider.type` se etiqueta `'openrouter'` (el único `ProviderType` real asociado a `kind:'openai-chat'`, ver `shared/types.ts`) — confirmado que `sendOpenAiApi()` nunca lee `provider.type`, solo `endpoint`/`apiKey`/`model`, así que la etiqueta no afecta comportamiento real aunque esta corrida sea OpenAI directo, no OpenRouter.

### Fix real de producción — `max_tokens` → `max_completion_tokens` (`api-agent-runtime.ts`, `sendOpenAiApi()`)

**Bug real encontrado en la primera corrida real** (no en investigación previa): la API real de OpenAI rechazó el request con `400` explícito — *"Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead"* — para `gpt-5.2`. **Verificado real que mandar los dos parámetros a la vez NO alcanza**: la API rechaza igual con `400` si `max_tokens` está presente, sin importar que `max_completion_tokens` también venga (no ignora el parámetro no reconocido, invalida el pedido entero) — descartada la primera opción que el usuario había elegido, confirmado con evidencia antes de implementar cualquier cosa.

`kind:'openai-chat'` sirve **también** OpenRouter en producción desde Fase 15 — muchos de sus modelos (GPT-4o, GPT-3.5, modelos de terceros) siguen esperando `max_tokens`, así que cambiar el nombre del parámetro de forma incondicional arriesgaba una regresión real ahí. Fix: `openAiMaxTokensField(model)`, detección por prefijo real (`/^(o[1-9]|gpt-5)/i` — la familia real de modelos "reasoning" de OpenAI que documentan este cambio de parámetro) — todo lo demás (`gpt-4o`, `gpt-3.5-turbo`, cualquier modelo de OpenRouter) sigue mandando `max_tokens` exacto como antes, verificado con 7 casos reales (`gpt-5.2`/`gpt-5.5`/`o1`/`o3-mini` → `max_completion_tokens`; `gpt-4o`/`gpt-3.5-turbo`/`stealth/ox-alpha` → `max_tokens`, cero cambio).

### Verificación real — 4 corridas reales contra OpenAI directo, 3 de 4 con patch no vacío

Corridas contra Praxis Liber (mismo mecanismo de Fase 2 original), instancia `davidesantangelo__krep-18` (C, repo `davidesantangelo/krep`). Incidente operativo real durante la transferencia de la key: el primer intento del usuario de colocar la key en Praxis Liber resultó en un archivo de 476 bytes en vez de 164 — **la interfaz de chat enmascaró visualmente la key al copiarla de un mensaje previo** (cada carácter después de `sk-proj-` se sustituyó por `•`, U+2022) — diagnosticado con `od -c` sin exponer la key completa, resuelto pidiéndole al usuario que la pegara desde su fuente original, no desde el chat.

**Corrida 1** (antes del fix): `400` inmediato por `max_tokens`, `patchIsEmpty:true`, `toolCallLog:{}` — confirmó el bug antes de tocar nada más.

**Corridas 2-4** (con el fix, las 3 con `AMATISTA_MAX_TOOL_LOOP=300`): las 3 produjeron un **patch real, no vacío, correctamente dirigido** — 11, 13 y 11 `apply_patch` reales respectivamente (más `list_dir`/`read_file`/`search_files` reales de exploración), todas cortadas por el **mismo límite real de organización**: `Rate limit reached ... on tokens per min (TPM): Limit 500000, Used ~475000-500000` — confirmado que es contención real y sostenida (3/3 veces, con cooldowns de 15-20s entre intentos), no un fallo puntual — mismo patrón de contención de cuota compartida ya visto con Azure/Anthropic en la corrida anterior de Fase 2, ahora confirmado en un tercer proveedor distinto.

**El mejor patch obtenido** (corrida 3, 13 `apply_patch`, 3 archivos) implementa correctamente múltiples requisitos específicos y verificables del `problem_statement` real:
- `test/test_compat.h`: switch real de macros por archivo (`#if defined(TEST_MULTIPLE_PATTERNS_FILE)` expone los wrappers legacy; `#else` deja los nombres canónicos apuntando al API real basado en struct) — exactamente lo que pedía el enunciado. Agregó `count_matches_mode: true` consistente en los 7 wrappers (implica que leyó el `search_params_t` real), corrigió un `case_sensitive = false` incorrecto en el wrapper de regex a `true`, y deduplicó lógica repetida en un helper `krep__effective_len()`.
- `test/test_krep.c`: los 8 renombres `_new` pedidos exactos (`test_basic_search_new`, `test_edge_cases_new`, etc.) + el fix del assert SIMD real: `TEST_ASSERT(matches1_sse42 == 1, "...finds 'dolor' once")` → `== 2, "...finds 'dolor' twice (including prefix in 'dolore')"`, con comentario explicando el motivo — coincide exacto con lo que pedía el enunciado.
- `test/test_multiple_patterns.c`: agregó `#define TEST_MULTIPLE_PATTERNS_FILE` en el lugar correcto, activando el branch legacy de `test_compat.h` para ese archivo específicamente.

Parcial (no llegó a `main()`/`aho_corasick.h`, cortado por el rate limit), pero real, correcto en lo que alcanzó, y verificable línea por línea contra el `problem_statement` — muy por encima del criterio mínimo pedido ("no vacío, no basura").

**Mecanismo confirmado end-to-end con un tercer proveedor real** (Foundry, Anthropic-vía-Azure, y ahora OpenAI directo): clone/checkout real, loop de tool-calling real (39 tool calls reales acumulados entre las 3 corridas con patch), `git diff` real, `result.json` real, manejo de errores 100% correcto en las 4 corridas.

`npm run typecheck` y `npm run build`: limpios. Sin commit — pendiente de que el usuario lo pida.

## Fase 3 del benchmark — evaluación real con Docker, disco dedicado, piloto completo

**Contexto**: Fase 1/2 producen, por instancia, un patch real (`git diff`) más `usage`/`latencia`/`toolCallLog` — pero nunca confirmaron si ese patch REALMENTE resuelve el bug. Fase 3 corre la evaluación OFICIAL del propio dataset (Docker, `test_patch` aplicado, tests reales corridos) para determinarlo objetivamente, sin que el agente se autoevalúe.

### Investigación previa (Tarea 0, `docs/_arch/verify_benchmark_fase3.md`) — no hacía falta construir nada

Confirmado real que **el propio repo del dataset de HuggingFace** (no solo la vista de filas de `datasets-server`, usada hasta Fase 2 — hay que mirar sus ARCHIVOS) publica su propio harness de evaluación oficial: `eval.json` (170 instancias, `eval_script` real por instancia) + `swe-bench-promax.json` (dataset completo) + `src/evaluation/test_run.py` (544 líneas, autocontenido, solo stdlib de Python). `SWE-Factory` (la herramienta genérica que el paper cita para CONSTRUIR el dataset) sí tiene evaluación propia (`evaluation/run_evaluation.py`), pero su `test_spec.py` exige un campo `eval_script`/`version` por instancia que el parquet público **no expone** — gap real, resuelto por ProMax publicando `eval.json` aparte, no reimplementado por nosotros.

Mecanismo real confirmado leyendo `test_run.py` completo: por instancia, corre TANTO el patch del modelo COMO el patch de referencia (golden) contra el mismo `image_name`, aplica el `test_patch` (embebido en el propio `eval_script`) + corre el comando de test real del proyecto, y determina `resolved` por un **exit code único** (`OMNIGRIL_EXIT_CODE=`, no comparación de listas `FAIL_TO_PASS`/`PASS_TO_PASS` — ProMax no tiene esos campos). `passed = true` solo si TANTO el modelo COMO el golden pasan (el golden actúa de control de validez de la instancia).

### Hallazgo crítico de disco (Tarea 3, confirmado empírico, no calculado) — 102 imágenes ≈ 875GB reales

Pulleando 2 imágenes reales y midiendo con `docker system df -v`: **cero reuso de capas entre instancias** (`SHARED SIZE: 0B` entre 2 imágenes de repos distintos) — cada imagen es completamente independiente. Total real comprimido de las 102 imágenes (Python/TypeScript/Go/Rust, vía API real de Docker Hub para las 102): **208.36 GB** — TypeScript concentra casi la mitad (instancias reales de `angular/angular`, 4.4–4.6GB comprimido cada una). Con el ratio real de compresión medido (~4.2x, consistente en 2 muestras): **~875GB sin comprimir — casi todo el espacio libre real de Praxis Liber (834GB)**.

### Disco físico nuevo — `/mnt/benchmark-storage` (2.6TB reales)

Investigación real (`lsblk`/`blkid`) encontró un segundo disco físico de 2.7TB (`/dev/sdb1`) sin montar, NTFS, label `SERVIDOR_DATOS` — señal real de datos previos, imposible de inspeccionar sin acceso root (bloqueado por permisos, `controlq` no está en el grupo `disk`). El usuario confirmó explícitamente, dos veces, formatearlo — acción irreversible, ejecutada solo tras esa confirmación explícita:

- `mkfs.ext4 /dev/sdb1` → filesystem real, UUID `6ebb0aad-592f-4568-a29c-837acba78dde`.
- Montado en `/mnt/benchmark-storage`, agregado a `/etc/fstab`, persistencia verificada real con `mount -a` (sin reiniciar el servidor) — `exit code 0`, sigue montado.
- `df -h`: **2.7T total, 2.6T disponibles** — confirmado con evidencia real, no asumido.
- Único hallazgo inesperado durante la verificación: `blkid /dev/sdb1` (sin bypass de cache) devolvió metadata NTFS vieja tras el formateo — diagnosticado real como cache stale de `blkid` (no un problema del disco), confirmado correcto con `lsblk -f`/`df -T`, que sí leen directo del kernel.

Acceso configurado con reglas `sudo NOPASSWD` **acotadas a los comandos exactos** (`mkfs.ext4 /dev/sdb1`, `mkdir -p /mnt/benchmark-storage`, `mount /dev/sdb1 /mnt/benchmark-storage`, `mount -a`) — nunca `NOPASSWD: ALL`, y la edición de `/etc/fstab`/la configuración de systemd las corrió el usuario directamente en su propia sesión, no vía sudoers (evita dejar abierta la capacidad de modificar el gestor de servicios del sistema completo).

### Docker hacia el disco nuevo — daemon dedicado, no mover el `data-root` principal

Investigado antes de asumir el mecanismo (pedido explícito): mover el `data-root` del daemon PRINCIPAL de Docker habría afectado TODO lo que ya corre en Praxis Liber (Coolify, yayoschat, RN1, IASIS — 20 contenedores reales confirmados activos antes de tocar nada). Opción elegida: **un segundo daemon Docker completamente independiente**, dedicado al benchmark, con su propio socket (`/run/docker-benchmark.sock`, confirmado real via `dockerd --help`: `--data-root`/`-H`/`-G` son flags reales soportados).

**Hallazgo real durante la primera verificación, no anticipado**: el primer intento (`docker-benchmark.service` sin `--containerd` explícito) mostraba TODAS las imágenes del daemon principal (coolify, yayoschat, rn1, postgres...) en el daemon nuevo — `dockerd` sin `--containerd` se conecta automáticamente al `containerd` YA corriendo del sistema (`/run/containerd/containerd.sock`) en vez de levantar uno propio, compartiendo el content store real (namespace `moby` compartido). Confirmado con `ps aux` (un solo proceso `containerd` real corriendo) y verificado que borrar la imagen del daemon nuevo la hacía desaparecer de AMBOS lados (prueba de que compartían namespace) — sin daño real (la imagen nunca perteneció al daemon principal, el borrado solo revirtió la contaminación de vista, los 20 contenedores preexistentes siguieron intactos durante todo el diagnóstico).

**Fix real**: `containerd-benchmark.service` dedicado (`root = "/mnt/benchmark-storage/containerd"`, socket propio `/run/containerd-benchmark/containerd.sock`), y `docker-benchmark.service` apuntado explícitamente a ese containerd (`--containerd=... --containerd-namespace=benchmark`). Verificado real tras el fix: lista de imágenes del daemon nuevo genuinamente vacía al arrancar; pull de prueba (`krep`, 901MB reales) hizo crecer `/mnt/benchmark-storage` de `336K` a `860M` mientras el disco raíz (`/`) se mantuvo EXACTO en `33G` antes y después; el daemon principal no ve la imagen del benchmark (`0` matches); los 20 contenedores preexistentes, sin interrupción, confirmados antes/durante/después con el mismo comando (`docker ps | wc -l` → 20 en las 3 mediciones).

### El harness (`benchmark/fase3/`, nuevo, tracked)

- **`fetch-promax-assets.sh`**: descarga (idempotente) los 3 artefactos reales del harness oficial de ProMax a `vendor/` (gitignored — son de terceros, no código de Amatista). Corrigió una URL real equivocada durante la implementación: el README del dataset referencia `data/eval.json` como convención de organización local sugerida, pero la ruta REAL en el repo (confirmada vía la API de HuggingFace, campo `siblings`) es `eval.json`, en la raíz.
- **`build-preds.js`**: transforma N `result.json` de Fase 2 al `preds.json` real que `test_run.py` espera (`[{instance_id, model_patch}]`) — transformación de formato pura, ninguna lógica de evaluación propia.
- **`merge-results.js`**: combina, por instancia, el `result.json` de Fase 2 (patch/usage/latencia/toolCallLog) con la entrada real correspondiente de `pass_rate.json` (resolved/model/golden, tal cual, sin reinterpretar) en un único `final_result.json` por tarea.
- **`run-pilot.sh`**: orquesta todo — `DOCKER_HOST=unix:///run/docker-benchmark.sock` (confirmado real que `test_run.py` llama al CLI `docker` real vía `subprocess.run(shell=True)` sin overrides de entorno propios, así que esta variable alcanza para redirigir TODAS sus operaciones al daemon aislado, sin tocar `test_run.py`) → `fetch-promax-assets.sh` → `build-preds.js` → `python3 vendor/test_run.py --workers 1 --cleanup` (real, nunca reimplementado) → `merge-results.js`.

**Estrategia secuencial por disco, mantenida pese al espacio nuevo**: `--workers 1 --cleanup` hace que `test_run.py` YA procese una instancia a la vez de forma nativa (confirmado real leyendo `stat_pass_rate()`: `workers<=1` usa una list comprehension síncrona, `cleanup` corre en un `finally` por job antes de pasar al siguiente) — no hizo falta escribir un loop propio. Disciplina de recursos deliberada, no un parche temporal por falta de espacio.

### Piloto real — 2 instancias, ambas `resolved:false`, con evidencia de que el harness es válido

Reevaluados los 2 patches reales ya obtenidos en Fase 2 (`davidesantangelo__krep-18`, la versión de 13 `apply_patch`/3 archivos; `albumentations-team__albumentations-2337`, `callSucceeded:true`, 15 `apply_patch`). **Ambos golden patches (referencia) pasaron 2/2 (100%)** contra la misma infraestructura — confirma que el harness detecta éxito correctamente cuando corresponde, el fallo de los 2 patches del agente es real, no un artefacto del mecanismo de evaluación.

| | `krep` | `albumentations` |
|---|---|---|
| `resolved` | **false** | **false** |
| Etapa del fallo | Compilación (`gcc`, `OMNIGRIL_EXIT_CODE=2`) | Tests reales (`pytest -rA`, `42 failed, 2939 passed, 38 skipped`) |
| Causa real | Patch incompleto — cortado por el rate limit de Fase 2 antes de tocar `main()`/`aho_corasick.h`, nunca llegó a compilar | Un solo bug real, no 42 distintos — mismo traceback raíz en las 42 fallas |
| Evidencia | `stdout` del build real: `gcc ... test/test_krep.c -o test/test_krep.o` seguido de `OMNIGRIL_EXIT_CODE=2` | `apply_he_stain_augmentation()` (`functional.py:249`): `c = od_flat @ pinv` → `ValueError: matmul: ... size 2 is different from 3` |
| Diagnóstico | Esperado — Fase 2 ya documentó que el patch quedó parcial | La pseudo-inversa de `stain_matrix` quedó orientada `(2,3)` en vez de `(3,2)` antes de la multiplicación — cualquier llamada real a `HEStain` crashea de inmediato. Confirmado que TODAS las 42 fallas (`test_image_only_augmentations`, `test_augmentations_wont_change_input`, `test_images_as_target`, más los 3 tests que el propio agente escribió para `HEStain`) comparten exactamente este mismo traceback — un solo punto de fallo, no una implementación difusamente rota |

No se tocó ningún archivo `.ts`/`.tsx` en esta fase (orquestación de Docker/Python/bash puramente) — `npm run typecheck`/`npm run build` no aplican, confirmado que el único cambio dentro del árbol de Amatista es `.gitignore`. Sin commit hasta que el usuario lo pida.

## Fix real de descriptions — `find_definition`/`find_references`/`list_symbols` no competían contra `search_files`

**Hallazgo real, encontrado revisando el `toolCallLog` del piloto exitoso de Fase 2** (`albumentations-team__albumentations-2337`, `callSucceeded:true`, 15 `apply_patch` reales): el agente resolvió toda la tarea con `list_dir` (4) + `read_file` (9) + `search_files` (7) + `apply_patch` (15) + `get_diagnostics` (1) — **cero** llamadas a `find_definition`/`find_references`/`list_symbols`, pese a que la tarea real (agregar `HEStain`, integrarlo en varios archivos de test) es exactamente el tipo de trabajo donde navegación por símbolos real aporta sobre grep.

**Causa real, no conjetura**: se pegaron las 3 `description` reales de `TOOL_DEFINITIONS` (`tool-registry.ts`) y se compararon contra la de `search_files` (la que sí usó, 7 veces). Las 3 explicaban bien el MECANISMO (protocolo LSP real, apertura de archivos bajo demanda, solo-lectura) pero ninguna competía activamente por la decisión del modelo frente a la alternativa de grep — a diferencia de `search_files`, cuya description vende agresivamente su caso de uso ("en vez de encadenar list_dir + read_file repetidas veces adivinando ubicaciones"). El único intento de contraste real (`find_references`, "en vez de asumir por grep de texto (que puede confundir un nombre con otro identificador igual en un contexto distinto)") estaba colgado al final de la description, sin peso, y `find_definition` no mencionaba grep/`search_files` en absoluto. La limitación real de `list_symbols` con `query` (solo encuentra símbolos de lenguajes cuyo LSP ya arrancó en la sesión) estaba enterrada en medio de la explicación del parámetro, no destacada como motivo de decisión.

**Fix**: reescritas las 3 `description` (solo texto — cero cambio de comportamiento real de las tools, parámetros/lógica intactos) siguiendo el mismo patrón que ya funciona en `search_files` — llevar el contraste concreto al frente, no como nota al pie:

- **`find_definition`**: ahora abre explicando el riesgo real de grep — puede traer una declaración con el mismo nombre en otro archivo/clase/scope (dos funciones distintas llamadas igual), o no encontrar nada si el identificador llegó vía un import renombrado (`import {X as Y}`) — antes de explicar el mecanismo LSP.
- **`find_references`**: el caso de uso ("antes de renombrar o eliminar algo") pasa al frente de la description, con el riesgo real de grep explicado con dos ejemplos concretos (variable local vs. método de clase con el mismo nombre; un uso real perdido por un import renombrado) en vez de una frase colgada al final.
- **`list_symbols`**: la limitación real de `query` (depende de que el LSP del lenguaje ya haya arrancado en la sesión) se explica ahora como motivo explícito para preferir `path` en la primera exploración de un archivo nuevo — "si `query` no encuentra algo que debería existir, no es necesariamente que no exista: puede ser que el LSP de ese lenguaje todavía no arrancó, no que el símbolo no esté" — en vez de quedar enterrada en la descripción del parámetro.

`npm run typecheck` y `npm run build`: limpios. Verificación pedida (no hacía falta correr el benchmark de nuevo): confirmar que las descriptions nuevas compilan y están bien formadas — hecho. Sin commit hasta que el usuario lo pida.

## LSP forzado — `AMATISTA_EXCLUDED_TOOLS`, comparación real `optuna__optuna-6197` con/sin `search_files`

**Contexto** (investigación previa: `docs/_arch/verify_lsp_forced_batch.md`): la mejora de descriptions no bastó por sí sola — en la tanda real de 14 instancias, 0 usos de `find_definition`/`find_references`/`list_symbols`. Para separar "el modelo prefiere grep aunque tenga LSP disponible" de "el modelo usaría LSP si grep no estuviera", se implementó un mecanismo real de exclusión de tools del catálogo.

### `AMATISTA_EXCLUDED_TOOLS` — `ApiAgentRuntime.toolCatalog()`

Confirmado en la investigación previa que `toolCatalog()` (`api-agent-runtime.ts:752`) es el único choke point real usado por los 4 proveedores API, y que nada más (`ToolRegistry.execute()`, `explore-tool.ts`) depende de que el catálogo sea siempre completo. Fix, mismo patrón que `AMATISTA_STORAGE_ROOT`/`AMATISTA_MAX_TOOL_LOOP`:

```ts
private toolCatalog(): ToolDefinition[] {
  const excluded = (process.env.AMATISTA_EXCLUDED_TOOLS ?? '')
    .split(',')
    .map(name => name.trim())
    .filter(Boolean)
  const native = excluded.length === 0
    ? TOOL_DEFINITIONS
    : TOOL_DEFINITIONS.filter(def => !excluded.includes(def.name))
  return [...native, ...(this.config?.mcpToolDefinitions ?? [])]
}
```

Filtra solo `TOOL_DEFINITIONS` (nativas) — las tools MCP quedan siempre intactas, por decisión explícita (no aplica al caso de uso real del benchmark, que no conecta servidores MCP). Sin la variable, `excluded.length === 0`, devuelve `TOOL_DEFINITIONS` sin tocar — cero cambio de comportamiento real para cualquier uso normal de la app.

**Verificado real, no solo por lectura de código**: interceptado el `fetch()` real (proxy transparente, deja pasar la llamada real igual) en un turno real contra la API real de OpenAI con `AMATISTA_EXCLUDED_TOOLS=search_files` seteado — el request que efectivamente viajó tenía **17 tools** (18 menos `search_files`), confirmado `search_files: false`, `read_file: true` en el payload real.

### Comparación real, misma tarea exacta (`optuna__optuna-6197`, mismo modelo `gpt-5.2`, mismo `AMATISTA_MAX_TOOL_LOOP=300`)

| | Corrida natural (Fase 2, tanda de 14) | Corrida con `search_files` excluida |
|---|---|---|
| `resolved` | **true** | **true** |
| `callSucceeded` | true (turno completo) | false (cortado por el mismo rate limit real de organización de siempre, 537ms antes de poder reintentar) |
| Tokens reales | 1,208,680 | no capturado — ver nota |
| Latencia real | 145s | 114s |
| `toolCallLog` | `list_dir`, `read_file`, `write_file`/`apply_patch`, `run_command`, `get_diagnostics` — **0 tools LSP** | `list_dir`(2), `read_file`(11), **`list_symbols`(1)**, `write_file`(1), `apply_patch`(23), `get_diagnostics`(1), `git_diff`(2), `explore`(1), `run_command`(7) |

**Sí usó LSP esta vez** — una llamada real a `list_symbols` — confirmando que el catálogo restringido cambia el comportamiento real del modelo, no solo en teoría. Efecto colateral real, no anticipado: sin `search_files`, el modelo recurrió repetidamente a `run_command` con scripts Python inline (`python3 - <<'PY' ... os.walk ... re.compile ...`) como sustituto de grep — un patrón de exploración más costoso/indirecto que ni `search_files` ni `list_symbols` puro, visible en el log real del turno. `list_symbols` se usó UNA sola vez pese a la exploración extensa — el reemplazo dominante fue `run_command`-como-grep, no LSP.

**Nota real sobre el `0` de tokens**: `usage: undefined` en esta corrida — hallazgo real, no oculto: el harness de Fase 2 solo captura `usage` en el path de retorno EXITOSO de `send()` (`sendResult.usage`); cuando `send()` termina en `throw` (este caso, cortado por el 429 final), la excepción se captura pero `ApiAgentResult` nunca se construyó, así que no hay `usage` que copiar — aunque los 30+ tool calls reales previos al corte sí consumieron tokens reales de verdad (acumulados internamente en `ApiAgentRuntime` vía el evento `'usage'`, que el harness no escucha). Limitación real del harness de benchmark (no de `api-agent-runtime.ts`, que sí acumula correctamente) — queda pendiente de mejora si se prioriza, no corregida en esta ronda.

**Praxis Liber confirmado sano después**: disco raíz sin cambio (35G), daemon del benchmark limpio (0 imágenes tras el `--cleanup`), 20 contenedores preexistentes sin interrupción.

`npm run typecheck` y `npm run build`: limpios. Sin commit hasta que el usuario lo pida.

### Tercera corrida real — `search_files` excluida + instrucción explícita prohibiendo `run_command` como sustituto de grep

**Contexto**: la 2da corrida mostró que, sin `search_files`, el modelo compensó con `run_command` + scripts Python inline (grep manual) en vez de usar `list_symbols`/`find_definition`/`find_references` de forma consistente. Para aislar si eso era una preferencia genuina o solo la ausencia de una instrucción explícita, se agregó al `problem_statement` de ESTA corrida puntual (no un cambio permanente de Amatista, solo el texto de la tarea que recibe el modelo) una instrucción al frente:

> *"INSTRUCCION OBLIGATORIA: no uses run_command para buscar texto, listar coincidencias, o simular grep de ninguna forma — esta prohibido. Para encontrar donde esta definido algo o donde se usa, usa EXCLUSIVAMENTE find_definition/find_references/list_symbols."*

Mismo modelo (`gpt-5.2`), mismo `AMATISTA_MAX_TOOL_LOOP=300`, mismo `AMATISTA_EXCLUDED_TOOLS=search_files`.

### Comparación real, las 3 corridas de `optuna__optuna-6197`

| | 1. Natural | 2. `search_files` excluida | 3. Excluida + instrucción explícita |
|---|---|---|---|
| `resolved` | **true** | **true** | **true** |
| `callSucceeded` | true | false (rate limit, 537ms de reintentar) | **true** |
| Tokens reales | 1,208,680 | `undefined` (gap del harness, ver nota anterior) | **772,062** (input 764,449, output 7,613, cached 730,624 — 94.6% cache hit) |
| Latencia real | 145s | 114s | 105.8s |
| `run_command` usado como grep | — (no aplica, `search_files` disponible) | **Sí** — scripts Python inline (`os.walk`+`re.compile`) como sustituto de grep | **No — cero llamadas a `run_command`** |
| `toolCallLog` LSP | 0 | `list_symbols`(1) | `list_symbols`(1) |
| `toolCallLog` completo | `list_dir`/`read_file`/`write_file`+`apply_patch`/`run_command`/`get_diagnostics` | `list_dir`(2), `read_file`(11), `list_symbols`(1), `write_file`(1), `apply_patch`(23), `get_diagnostics`(1), `git_diff`(2), `explore`(1), `run_command`(7) | `list_dir`(6), `read_file`(12), `list_symbols`(1), `apply_patch`(20), `get_diagnostics`(1) |

**Confirmado real: la instrucción explícita SÍ se respetó** — cero uso de `run_command` para búsqueda de texto en la 3ra corrida, ni ningún otro mecanismo de evasión detectado en el `toolCallLog` real (no recurrió a `read_file` de forma anormalmente masiva tampoco — 12 llamadas, similar a la corrida 2). El modelo mismo lo reconoce en su texto final real: *"Nota pendiente (importante): ... para cumplir 100% con tu instrucción"* — evidencia textual de que la instrucción fue leída y seguida como restricción real, no ignorada.

**Gap de `usage:undefined` NO reapareció** — al completar el turno sin rate limit (`callSucceeded:true`), `usage` se capturó correctamente, confirmando que el gap documentado en la 2da corrida es específicamente del path de excepción de `send()`, no un problema general de captura.

**`list_symbols` se mantuvo en exactamente 1 uso en las corridas 2 y 3** — la instrucción cambió CÓMO evitó grep (de `run_command`-como-sustituto a ningún sustituto en absoluto), pero no aumentó el uso real de las 3 tools LSP más allá de esa única llamada — el modelo se apoyó mayormente en `read_file` directo para el resto de la navegación en ambas corridas restringidas.

**Praxis Liber confirmado sano tras esta 3ra corrida también**: disco raíz sin cambio (35G), daemon del benchmark limpio, 20 contenedores preexistentes sin interrupción.

### 4 instancias adicionales bajo LSP forzado — las 4 que nunca tuvieron intento real en la tanda original

Mismas 2 restricciones ya verificadas en `optuna` (`AMATISTA_EXCLUDED_TOOLS=search_files` + instrucción explícita anti-`run_command`), corridas sobre las 4 instancias de la tanda de 14 que habían sido rechazadas por rate limit ANTES de cualquier procesamiento real (`icloud-photos-downloader`, `ant-design-52470`, `qdrant-c_51b3a62`, `qdrant-c_83bb3a3`) — mismo `gpt-5.2`, mismo `AMATISTA_MAX_TOOL_LOOP=300`, secuencial vía `run-batch.sh` reusado tal cual.

| Instancia | Lenguaje | `resolved` | `callSucceeded` | Tokens (cache hit) | Latencia | `toolCallLog` |
|---|---|---|---|---|---|---|
| `icloud-photos-downloader__icloud_photos_downloader-c_f52826c` | python | **true** | true | 786,633 (95.60%) | 103s | `list_dir`(5), **`list_symbols`(2)**, `explore`(1), `read_file`(11), `apply_patch`(24) |
| `ant-design__ant-design-52470` | typescript | **true** | true | 767,245 (95.91%) | 115s | `list_dir`(2), `read_file`(13), `apply_patch`(24), `get_diagnostics`(1) — **0 LSP** |
| `qdrant__qdrant-c_51b3a62` | rust | false | true | 815,202 (92.80%) | 77s | `list_dir`(10), `read_file`(17), **`list_symbols`(1)**, `write_file`(3), `apply_patch`(1) |
| `qdrant__qdrant-c_83bb3a3` | rust | **true** | true | 773,020 (92.35%) | 75s | `explore`(1), `list_dir`(6), **`list_symbols`(1)**, `read_file`(14), `apply_patch`(5) |

**Las 4 completaron el turno sin rate limit** (`callSucceeded:true` en las 4 — a diferencia de la tanda natural original, donde estas mismas 4 nunca habían llegado a procesarse). **Cero `run_command` en las 4** — instrucción respetada al 100%, sin ninguna forma de evasión detectada.

### Resumen agregado — 5 instancias totales bajo LSP forzado completo (`optuna` corrida 3 + estas 4)

| Instancia | Lenguaje | `resolved` | LSP usado |
|---|---|---|---|
| `optuna__optuna-6197` | python | true | `list_symbols`(1) |
| `icloud-photos-downloader__...-c_f52826c` | python | true | `list_symbols`(2) |
| `ant-design__ant-design-52470` | typescript | true | ninguna |
| `qdrant__qdrant-c_51b3a62` | rust | false | `list_symbols`(1) |
| `qdrant__qdrant-c_83bb3a3` | rust | true | `list_symbols`(1) |

- **Resolved: 4/5 (80%)**.
- **LSP genuinamente usado en 4/5 (80%)** — todas menos `ant-design-52470`, que resolvió la tarea completa con `read_file` directo (13 llamadas) sin necesitar navegación por símbolos ni ningún sustituto — evidencia de que a veces la tarea real simplemente no la requiere, no de evasión.
- **Evasión (`run_command`-como-grep u otro mecanismo): 0/5** — instrucción respetada en el 100% de los casos reales, en las 2 tandas.
- **`find_definition`/`find_references`: 0/5** — de las 3 tools LSP, solo `list_symbols` se usó en esta muestra; las otras 2 nunca, ni siquiera bajo exclusión + instrucción explícita.
- **Tendencia real de tokens**: rango estrecho, 767K–815K por instancia (nada correlacionado obviamente con `resolved` — la única que falló, `qdrant-51b3a62`, no es ni la de mayor ni menor consumo).
- **Cache hit rate real**: 92.3%–95.9%, consistente con las 3 corridas de `optuna` — sin degradación real por el catálogo restringido.

**Hallazgo operativo, no crítico**: tras esta tanda, `/mnt/benchmark-storage` mostró 12GB reales en uso pese a que `docker system df` del daemon aislado reporta 0 en imágenes/contenedores/volúmenes/build cache — contenido residual de `containerd` (garbage collection propio, no disparado automáticamente por `docker rmi`), no confirmable en detalle sin acceso root (mismo límite de permisos ya documentado en Fase 3). Insignificante frente a los 2.6TB libres, sin impacto real — anotado por transparencia, no una alarma.

**Praxis Liber confirmado sano tras esta tanda de 4**: disco raíz sin cambio (35G), daemon del benchmark en 0 activo, 20 contenedores preexistentes sin interrupción.

### Las mismas 4 en condición NATURAL — comparación controlada final (5 tareas × 2 condiciones)

Mismas 4 instancias, catálogo completo (`AMATISTA_EXCLUDED_TOOLS` sin setear, `search_files` disponible), sin la instrucción explícita — confirmado real ANTES de correr, no asumido: `echo $AMATISTA_EXCLUDED_TOOLS` en una sesión SSH nueva dio vacío (`[]`), y `run-batch.sh` en sí mismo nunca toca esa variable (confirmado con `grep`).

**Hallazgo real durante la corrida — la cuenta real de OpenAI se quedó sin crédito** (`"You have no credits remaining"`, distinto del rate limit TPM de siempre): de las 4, solo 2 (`icloud-photos-downloader` parcial, `ant-design-52470` completa) tuvieron intento real contra OpenAI antes de que la cuenta se agotara — `qdrant-c_51b3a62`/`qdrant-c_83bb3a3` fallaron en <1.5s, 0 tool calls, sin ningún intento real. El usuario confirmó un problema real de pago (tarjeta rechazada) y pidió usar Foundry para esas 2 — **confirmado real que `gpt-5.2` no existe como deployment en el recurso de Foundry** (`404 DeploymentNotFound`, probado directo antes de asumir), así que esas 2 corrieron con `gpt-5.5` (el mismo modelo ya usado y confirmado en Fase 1/2) — única desviación real del diseño "mismo modelo" para 2 de las 10 celdas, documentada explícita, no oculta.

### Tabla FINAL — 5 tareas × 2 condiciones (10 filas)

| Tarea | Condición | `resolved` | `callSucceeded` | Tokens (cache hit) | Latencia | LSP usado | Modelo |
|---|---|---|---|---|---|---|---|
| `optuna__optuna-6197` | Natural | true | true | 1,208,680 (95.01%) | 145s | 0 | gpt-5.2 |
| `optuna__optuna-6197` | Forzado | true | true | 772,062 (94.63%) | 106s | `list_symbols`(1) | gpt-5.2 |
| `icloud-photos-downloader` | Natural | false | false (rate limit TPM) | — | 45s | 0 | gpt-5.2 |
| `icloud-photos-downloader` | Forzado | true | true | 786,633 (95.60%) | 103s | `list_symbols`(2) | gpt-5.2 |
| `ant-design-52470` | Natural | false | true | 624,475 (95.54%) | 119s | 0 | gpt-5.2 |
| `ant-design-52470` | Forzado | true | true | 767,245 (95.91%) | 115s | 0 | gpt-5.2 |
| `qdrant-c_51b3a62` | Natural | false | false (rate limit Foundry) | — | 277s | `list_symbols`(1) | **gpt-5.5 (Foundry)** |
| `qdrant-c_51b3a62` | Forzado | false | true | 815,202 (92.80%) | 77s | `list_symbols`(1) | gpt-5.2 |
| `qdrant-c_83bb3a3` | Natural | true | true | 1,145,310 (93.87%) | 248s | `list_symbols`(1) | **gpt-5.5 (Foundry)** |
| `qdrant-c_83bb3a3` | Forzado | true | true | 773,020 (92.35%) | 75s | `list_symbols`(1) | gpt-5.2 |

**Resolved agregado: Natural 2/5 (40%) vs. Forzado 4/5 (80%).** Diferencia real y marcada — pero con caveats reales que impiden una conclusión estadística fuerte con `n=5`: 2 de las 5 celdas naturales tuvieron un intento genuinamente incompleto o con modelo distinto (`icloud-photos-downloader` cortado por rate limit antes de escribir nada; `qdrant-c_51b3a62`/`qdrant-c_83bb3a3` en `gpt-5.5` en vez de `gpt-5.2`) — de las 3 celdas naturales verdaderamente comparables (mismo modelo, intento completo real: `optuna`, `ant-design-52470`, y parcialmente `icloud-photos-downloader` que sí tuvo 27 tool calls reales antes del corte), 1 de 3 resolvió. La tendencia es real y consistente con la hipótesis (forzar LSP + prohibir el sustituto de grep correlaciona con más éxito en esta muestra), pero el tamaño de muestra y las interrupciones de infraestructura reales (2 proveedores distintos con cuota agotada durante el experimento) hacen que esto sea evidencia direccional, no una medición controlada limpia.

`npm run typecheck` y `npm run build`: limpios (sin cambios de código en esta ronda, solo corridas de datos). Sin commit hasta que el usuario lo pida.

### Comparación limpia final real — DeepSeek directo (`deepseek-v4-flash`), mismo modelo en las 10 corridas

**Contexto**: la comparación con GPT-5.2 quedó comprometida por 2 problemas reales de infraestructura (la cuenta de OpenAI se quedó sin crédito real a mitad de tanda; 2 de las 10 celdas terminaron en `gpt-5.5` vía Foundry). Investigado un recurso Foundry dedicado nuevo (`amatistabenchmark-resource`, sin compartir cuota con el proyecto Q) — confirmado viable (HTTP 200 real, tool-calling real con `DeepSeek-V4-Flash`), pero **las 10 corridas de un intento posterior fallaron 10/10** por un rate limit real y muy bajo del deployment (`"exceeded rate limit"`/`"high demand... exceeds maximum usage size"`, cortadas en 10-32s con 2-4 tool calls de exploración, sin ningún intento real completo) — no fue una medición de capacidad del modelo, fue un techo de capacidad del deployment. Se investigó y confirmó viable **DeepSeek directo** (`api.deepseek.com`, sin Azure): mismo mecanismo real ya usado para Claude-vía-Azure (`kind:'anthropic-api'`, endpoint custom `https://api.deepseek.com/anthropic`), tool-calling real confirmado con el catálogo de 18 tools de Amatista, y — a diferencia de Azure — la [documentación oficial](https://api-docs.deepseek.com/quick_start/rate_limit) publica límites de **concurrencia** (2500 conexiones simultáneas para `deepseek-v4-flash`), no RPM/TPM — irrelevante para un harness secuencial de 1 a la vez.

**Resultado real: las 10 corridas completaron sin ningún error de infraestructura** — cero rate limits, cero cuenta sin crédito, cero fallos duros. Comparación finalmente limpia.

| Tarea | Condición | `resolved` | Tokens (input/output/cached) | Latencia | `toolCallLog` |
|---|---|---|---|---|---|
| `optuna__optuna-6197` | Natural | **true** | 114,807 (71,081 / 43,726 / 2,845,440) | 297s | `search_files`(35), `run_command`(4), `apply_patch`(13) — 0 LSP |
| `optuna__optuna-6197` | Forzado | **true** | 119,888 (69,757 / 50,131 / 4,335,232) | 489s | `list_symbols`(2), **`find_references`(1)**, `run_command`(21) |
| `icloud-photos-downloader` | Natural | **true** | 113,048 (70,380 / 42,668 / 6,328,320) | 504s | `list_symbols`(1), `run_command`(51) |
| `icloud-photos-downloader` | Forzado | **true** | 137,755 (92,058 / 45,697 / 5,676,800) | 423s | `list_symbols`(4), **`find_references`(4)**, `run_command`(28) |
| `ant-design-52470` | Natural | **true** | 219,383 (138,917 / 80,466 / 15,468,800) | 740s | `run_command`(45) — 0 LSP |
| `ant-design-52470` | Forzado | **true** | 195,874 (90,865 / 105,009 / 8,980,352) | 849s | `list_symbols`(1), `run_command`(21) |
| `qdrant-c_51b3a62` | Natural | false | 232,083 (116,524 / 115,559 / 22,990,208) | 1044s | `run_command`(115) — 0 LSP |
| `qdrant-c_51b3a62` | Forzado | false | 317,481 (186,659 / 130,822 / 25,094,528) | 1203s | `list_symbols`(3), `run_command`(63) |
| `qdrant-c_83bb3a3` | Natural | **true** | 106,719 (65,529 / 41,190 / 4,911,744) | 353s | `list_symbols`(1), `run_command`(17) |
| `qdrant-c_83bb3a3` | Forzado | **true** | 86,977 (52,759 / 34,218 / 2,966,016) | 299s | `list_symbols`(1), **`find_definition`(1)**, **`find_references`(1)** |

**Resolved: Natural 4/5 (80%) vs. Forzado 4/5 (80%) — sin diferencia real en esta comparación limpia.** `qdrant-c_51b3a62` falló en ambas condiciones por el mismo motivo real (verificado en el log real de evaluación, no supuesto): error de **compilación** de Rust (`error[E0583]: file not found for module 'retrieve'` — el agente declaró `pub mod retrieve;` sin crear el archivo correspondiente), nunca llegó a ejecutar tests — confirmado que no es un falso negativo de infraestructura (qdrant abre puertos reales en sus tests, se descartó explícitamente esa hipótesis revisando el log real).

**Hallazgo real sobre `find_definition`/`find_references`**: por primera vez en todo el experimento de LSP forzado, se usaron — `find_references` en 3 de las 5 celdas forzadas (`optuna`, `icloud-photos-downloader` x4, `qdrant-83bb3a3`), y `find_definition` una vez (`qdrant-83bb3a3`). Con GPT-5.2 estas 2 tools nunca se habían usado ni una sola vez en ninguna corrida anterior — con `deepseek-v4-flash` sí, en 3/5 tareas forzadas.

**Hallazgo real, no oculto, sobre el "cache hit rate"**: la fórmula `cached/total` usada en corridas anteriores da valores sin sentido acá (2478%–9906%) — no es un error de cálculo. `cached` (`cache_read_input_tokens`) se acumula ADITIVAMENTE por cada vuelta real del loop de tool-calling (`reportUsage()`), y en cada vuelta refleja el contexto completo ya cacheado hasta ese punto (que crece); `total` acumula solo los deltas incrementales de input+output de cada vuelta. Con turnos de 20 a 115 tool calls reales (mucho más que las corridas de GPT-5.2, que rara vez pasaban de 25), el cache acumulado supera ampliamente el total acumulado — matemáticamente real, no un bug, pero la métrica de "%" deja de ser interpretable con muchas vueltas. Se reportan los valores crudos (input/output/cached) en vez de forzar un porcentaje engañoso.

**Uso masivo real de `run_command`**: en las 10 corridas, `run_command` fue la tool más usada por lejos (4 a 115 veces por corrida) — mucho más que con GPT-5.2. No se investigó en detalle el contenido real de esas llamadas en esta ronda (podría ser legítimo, ej. correr `cargo build`/`pytest` reales para autoverificarse, no necesariamente grep-como-sustituto) — queda como observación real, no interpretada.

**Praxis Liber confirmado sano tras las 10 corridas**: disco raíz `35G → 47G` (crecimiento esperado, múltiples `git clone` reales de repos grandes como `qdrant`/`ant-design`, nada relacionado a Docker), daemon del benchmark en 0 activo, 20 contenedores preexistentes sin interrupción en ninguna de las 10 corridas.

### Confirmación cruzada real — panel de facturación de DeepSeek

El usuario compartió el panel de facturación real de DeepSeek para el período de esta comparación: **$1.36 USD, 973 API requests, 101,246,761 tokens totales** (cubre las 10 corridas de la tabla de arriba, más las llamadas de verificación de Tarea 0/1/2 hechas antes de lanzar la tanda).

**Suma real de las 10 filas ya documentadas arriba** (`input` + `output` + `cached`, no solo `cached` — el panel de un proveedor factura el total de tokens procesados, y `cached`/`input`/`output` son 3 categorías del mismo total, no magnitudes independientes a sumar por separado contra el total facturado):

```
suma input  (10 filas):    954,529
suma output (10 filas):    689,486
suma cached (10 filas): 99,597,440
                        ────────────
suma total  (10 filas): 101,241,455
```

**Contra el panel real: 101,246,761 − 101,241,455 = 5,306 tokens de diferencia (0.005%).** Coincide de forma casi exacta — y esa diferencia mínima tiene una explicación real y verificable, no es ruido: es exactamente el tamaño de la llamada de prueba de Tarea 2 (verificación de tool-calling contra `deepseek-v4-flash`, hecha ANTES de lanzar la tanda de 10, documentada en su momento como `usage real: {"input_tokens":5246,...,"output_tokens":60,...}` → `5246 + 60 = 5306`). **Confirmación cruzada real, contra la fuente de verdad del proveedor**: el `cached` que veíamos con porcentajes sin sentido (2478%–9906% sobre `total` acumulado del turno) es un valor genuino y correctamente facturado — no un artefacto de la instrumentación de Fase 1, solo una métrica de "%" mal definida para turnos largos (ya corregido arriba, reportando valores crudos).

**Costo real de contexto, sin comparar directo contra el leaderboard de ProMax** (proveedores/métricas de costo no son equivalentes — el paper mide contra los proveedores que evaluó en su momento, con su propia estructura de precios, no contra `deepseek-v4-flash` vía API directa): **$1.36 USD cubrió las 10 sesiones completas de esta comparación** (clone + turno agéntico completo + evaluación Docker de cada una) más las llamadas de verificación previas — un costo real y bajo para el volumen de trabajo real hecho (10 turnos completos, varios de más de 100 tool calls cada uno).

## Tool read_document — PDF/DOCX/XLSX/HTML, paginado real, fallback de visión para páginas escaneadas

Basado en 2 rondas de Tarea 0 (`docs/_arch/verify_large_documents.md` + `docs/_arch/verify_read_document_tool.md`). Nuevo módulo `src/main/document-reader.ts`, tool `read_document` en `src/main/tool-registry.ts`.

**Decisión de librerías, con el fix de seguridad como requisito, no preferencia**: PDF usa `pdfjs-dist@latest` (6.3.289) STANDALONE — nunca la copia interna que trae `officeParser` (6.1.200), que cae en el rango con CVE alta activa (`GHSA-hq66-cqwq-w95j`, ejecución arbitraria de JS al abrir un PDF malicioso). DOCX/XLSX/HTML usan `officeParser@7.8.0` (confirmado real en la investigación: no arrastra el paquete `xlsx`/SheetJS vulnerable, implementación propia). El diseño original era "nunca invocar officeParser para `.pdf`, dejando su copia vulnerable presente pero inerte" — durante la verificación de empaquetado (ver más abajo) se encontró que esa coexistencia de 2 versiones rompía el instalador real (`electron-builder` empaquetaba solo la copia vulnerable, omitiendo la nuestra), así que se reforzó con `package.json` → `"overrides": {"pdfjs-dist": "^6.3.289"}`, que UNIFICA todo el árbol a la versión segura — mejor resultado que el diseño original: la copia vulnerable ya no existe en ningún lado, en vez de solo evitarse en el código.

**Paginado real, nunca el documento completo de una**: `read_document(path, page?)` devuelve SIEMPRE `totalUnits` + `unitIndex` — para PDF, `page` es la página real del archivo (vía `pdfjs-dist`, `getTextContent()` por página); para DOCX/XLSX/HTML, `page` es el índice de un fragmento de tamaño fijo generado por `officeParser.convert(file, 'chunks', {chunkSize:1500, chunkOverlap:150})` (chunk CHICO a propósito — confirmado real en la investigación que con un `chunkSize` grande un chunk puede cruzar una página/hoja y su `metadata.pageNumber` queda pegado a la primera, no a todas las que cubre). Cache en memoria (`Map` clave ruta+mtime) de los chunks de officeParser por documento — sin esto, pedir un documento de 400 páginas página por página reparsearía el archivo ENTERO en cada llamada (confirmado real: `convert()` no tiene API de "solo el chunk N"). Es una cache de performance, no el mecanismo de resumen jerárquico (explícitamente fuera de alcance de esta fase).

**Fallback de visión para páginas escaneadas (PDF)**: página con `getTextContent().items.length === 0` se renderiza real a PNG vía `pdfjs-dist` `page.render()` + `@napi-rs/canvas` como implementación de canvas en Node, entregado como `data:image/png;base64,...` (mismo formato que `attachments.ts`). Hallazgo real de arquitectura durante la implementación: el mecanismo de visión existente (Fase 17) inyecta imágenes SOLO al turno actual del usuario (`context.attachments`), nunca dentro de un resultado de tool — no había ningún camino para que una tool le "muestre" una imagen al modelo dentro del mismo turno. Se agregó `ToolExecutionResult.resultImageDataUrl` (nuevo, distinto de `generatedAttachment` que explícitamente nunca llega al modelo) y se conectó en `sendAnthropicApi()` (`api-agent-runtime.ts`) armando `tool_result.content` como array `[{type:'text',...},{type:'image',...}]` en vez de string plano, reusando `parseDataUrl()`/`IMAGE_SIZE_LIMIT_BYTES['anthropic-api']` ya existentes de Fase 17 Tarea 3 (mismo guard de tamaño, mismo umbral de 10MB). **Alcance real, no silencioso**: confirmado por investigación (búsqueda real, no supuesto) que OpenAI Chat Completions no acepta contenido de imagen en un mensaje de rol `tool` (solo texto) — Foundry/Gemini comparten esa misma limitación de formato de tool-result. El fallback de imagen real funciona SOLO en `anthropic-api` (Claude directo y DeepSeek, que reusa este runtime); en los otros 3, `resultImageDataUrl` se ignora y el texto de la tool ya avisa explícitamente que la página es escaneada y no se pudo adjuntar en ese runtime — nunca se pierde la señal en silencio, pero tampoco se inventa un soporte que no existe.

**Empaquetado**: `pdfjs-dist` trae datos en disco reales (`cmaps/`, `standard_fonts/`) que ningún bundler puede inlinear en un `.js`; `officeParser` arrastra un árbol de dependencias complejo (incluye `tesseract.js`, motor de OCR completo en WASM, como dependencia DURA aunque `ocr:false` es el default explícito — confirmado real en el JSON de config devuelto por `parseOffice()`, nunca se activa OCR desde `read_document`, evitando redundancia real con el fallback de visión propio); `@napi-rs/canvas` es un addon nativo (`.node`, confirmado real: solo se resuelve/instala en Windows porque existe build prebuilt para esa plataforma, pese a figurar como dependencia "opcional" de `pdfjs-dist`). Los 3 quedan marcados `external` en `electron.vite.config.ts` (mismo criterio que `typescript-language-server`/`pyright`: requires/`import()` reales contra `node_modules` en runtime, nunca bundleados) — confirmado real inspeccionando `out/main/index.js` tras el build: aparecen literalmente `require("officeparser")`, `require("@napi-rs/canvas")` e `import("pdfjs-dist/legacy/build/pdf.mjs")`, no código inlineado. `package.json` → `build.files` extendido con los 3 paquetes + todo su árbol transitivo real (`@xmldom/xmldom`, `fflate`, `file-type`, `tesseract.js` y sus propias 9 dependencias, `@napi-rs/*`); `build.asarUnpack` extendido solo con `node_modules/@napi-rs/**/*` (el único binario nativo real de los tres — `pdfjs-dist`/`officeParser` son JS/datos leídos vía `fs`, transparente dentro de asar, sin necesitar desempaquetado).

**Bug real encontrado y corregido durante la verificación (Windows, factory URLs)**: `pdfjs-dist` interpreta `standardFontDataUrl`/`cMapUrl` como una URL real, no una ruta de SO — una ruta Windows con backslashes revienta con `Invalid factory url: "...cmaps\" must include trailing slash`. Corregido con `pathToFileURL()` (`node:url`), la única forma portable correcta.

**Bug real, más serio, encontrado en el PRIMER `npm run dist` real** (no en `npm run build` — este no invoca `electron-builder`, no ejercita empaquetado): el instalador generado contenía SOLO la copia vulnerable de `pdfjs-dist` (`node_modules/officeparser/node_modules/pdfjs-dist`, 6.1.200) y omitía por completo la nuestra (`node_modules/pdfjs-dist`, 6.3.289) — confirmado listando el `app.asar` real generado (`node_modules/.bin/asar list`), cero coincidencias del path de nivel superior. La causa real: `electron-builder`, al encontrar 2 versiones distintas del mismo paquete en el árbol (nuestra dependencia directa vs. la fijada por `officeParser`), no las trató como 2 copias a incluir — resolvió/incluyó solo una, sin avisarlo siquiera en su propio log de "duplicate dependency references" (que sí listaba otros duplicados reales del proyecto, como `monaco-editor`/`react-dom`). En la app empaquetada real esto habría sido un `Cannot find module 'pdfjs-dist/legacy/build/pdf.mjs'` — la tool entera rota para PDF en producción pese a compilar y typechequear limpio. **Fix real: `"overrides": {"pdfjs-dist": "^6.3.289"}` en `package.json`**, que fuerza TODO el árbol (incluida la dependencia interna de `officeParser`) a la versión segura — confirmado con `npm install` real que colapsa a una ÚNICA carpeta `node_modules/pdfjs-dist` (antes 2), y que `npm audit` pasa de 1 hallazgo alto (`pdfjs-dist`) a 0 relacionados con ese paquete. Esto es estrictamente mejor que el diseño original ("nunca invocar la copia vulnerable de officeParser"): ahora esa copia vulnerable no existe en ningún lado del árbol, en vez de solo evitarse. Re-verificado con un segundo `npm run dist` real: `app.asar` listado de nuevo confirma UNA sola ruta `node_modules/pdfjs-dist` (con `package.json`, `legacy/build/pdf.mjs`, `cmaps/`, `standard_fonts/` reales adentro), `node_modules/officeparser` presente (54 entradas reales), y el único `.node` real del árbol (`@napi-rs/canvas-win32-x64-msvc/skia.win32-x64-msvc.node`) correctamente en `app.asar.unpacked/`, no dentro del archivo — instalador final firmado, `Amatista-V0.8.3-Setup.exe`, 158,588,929 bytes.

### Verificación real — los 4 formatos + casos límite

Documentos reales generados en scratchpad (`pdf-lib`/`docx`/`exceljs`, nunca dependencias de Amatista) y leídos con el código YA implementado (compilado standalone a CJS real para poder invocarlo fuera de Electron, contra el `node_modules` real del proyecto vía `NODE_PATH`):

- **PDF** (`informe.pdf`, 3 páginas: 1 y 3 con texto real, 2 una imagen rasterizada real sin ninguna capa de texto — un "documento escaneado" genuino, no un simulacro vectorial): página 1 y 3 devolvieron su texto real y DISTINTO correctamente (confirma atribución de página, no fusión); página 2 fue detectada `scanned:true` y devuelta como PNG real (`120,594` caracteres base64) — el PNG se decodificó y se confirmó visualmente legible (texto "DOCUMENTO ESCANEADO DE PRUEBA", el sello real, ambos nítidos — enviado al usuario como evidencia).
- **DOCX** (`contrato.docx`, generado con `docx`): texto real de las 3 cláusulas extraído correctamente en un fragmento.
- **XLSX** (`presupuesto.xlsx`, generado con `exceljs`): filas/montos reales extraídos correctamente, con `sheetName:"Presupuesto"` real en la metadata.
- **HTML** (`acta.html`, escrito a mano): los 3 puntos del acta extraídos correctamente.
- **Página fuera de rango** (`page:99` en un PDF de 3 páginas): clampeado a la página 3 (la última real), sin excepción.
- **Formato no soportado** (`.txt`): error claro (`"Formato no soportado: .txt..."`), sin intentar procesarlo.

**Versión de `pdfjs-dist` realmente usada, confirmada con evidencia, no supuesta**: `require.resolve('pdfjs-dist/package.json')` resuelto en runtime durante la prueba apuntó a `node_modules/pdfjs-dist` (la copia de nivel superior del proyecto) — `node -e "console.log(require('./node_modules/pdfjs-dist/package.json').version)"` → `6.3.289`, fuera del rango vulnerable (`>=5.6.83 <6.2.108`). La copia vulnerable (`node_modules/officeparser/node_modules/pdfjs-dist`, `6.1.200`) nunca se tocó en ninguna de las pruebas de PDF.

`npm run typecheck` y `npm run build` en verde tras 2 fixes reales de tipos (`RenderParameters` de `pdfjs-dist@6.3.289` pide `canvas` además de `canvasContext`, y las libs de esta app no incluyen `DOM` a propósito — resuelto con `as any` documentado, no un tipado flojo accidental).

## Fix real — Codex dejaba rastro en ~/.codex/sessions/ por cada turno automatizado de Amatista

Basado en Tarea 1 de `docs/_arch/verify_claude_cli_reintegration.md`. `CodexClient.start()` (`src/main/codex-client.ts`) arma el payload de `thread/start` (protocolo JSON-RPC real de `codex app-server --stdio`) sin ningún campo de persistencia — confirmado real en la investigación previa que esto deja un archivo real nuevo en `~/.codex/sessions/` por cada turno, visible para el usuario vía `codex resume`, el mismo tipo de ruido no deseado que motivó el retiro completo de `claude-cli`.

**Fix de una sola línea**: `ephemeral: true` agregado al objeto de parámetros de `thread/start`, junto a `model`/`cwd`/`sandbox`/`approvalPolicy` ya existentes — sin tocar `initialize`, `initialized`, `turn/start`, ni ningún otro punto del ciclo de vida del protocolo. Campo confirmado real contra el schema oficial (`codex app-server generate-json-schema`) en la investigación previa.

### Verificación real

Ejecutada contra la clase `CodexClient` REAL (compilada del propio `codex-client.ts` ya editado, no una reimplementación a mano del protocolo — mismo código que corre en producción), con Codex real (`codex-subscription`, `gpt-5.5`, workspace real):

```
Archivos reales en ~/.codex/sessions/ ANTES: 101
Thread real iniciado: {"id":"01a05b16-...", ..., "ephemeral":true, "historyMode":"legacy", ...}
Turno real completo -- respuesta real del modelo: "VERIFICACION REAL OK"
turn/completed real: {"turn":{"status":"completed","durationMs":4854, "items":[{"type":"agentMessage","text":"VERIFICACION REAL OK",...}]}}
Archivos reales en ~/.codex/sessions/ DESPUES: 101
RESULTADO: SIN CAMBIO (fix funciona)
```

Confirmado: el turno funciona exactamente igual que antes (thread iniciado, mensaje de usuario, respuesta real del modelo, evento `turn/completed` con duración real) — la única diferencia observable es `"ephemeral":true` en el objeto del thread devuelto, y que `~/.codex/sessions/` no ganó ningún archivo nuevo (101 antes, 101 después), a diferencia del comportamiento sin el fix (confirmado en la investigación previa: 100→101 con el mismo mecanismo, mismo tipo de turno, sin `ephemeral`).

`npm run typecheck` y `npm run build` en verde, sin ningún error nuevo — el cambio es aditivo (un campo más en un objeto de parámetros ya tipado como `unknown` en la llamada JSON-RPC, sin impacto en tipos).

`codex-account-bridge.ts` (el otro cliente que también spawnea `codex app-server --stdio`, para el flujo de vinculación de cuenta) no llama `thread/start` en ningún punto — confirmado con grep, cero coincidencias — queda fuera de alcance de este fix porque el método simplemente no existe ahí, no por una decisión de recorte.

## Fix real — edición de conexiones (Settings) + aviso de proveedor huérfano

Basado en `docs/_arch/verify_connection_editing_bug.md` + 2 confirmaciones puntuales previas (origen real de `focusedProvider`, mecanismo de aviso real de `ChatPanel`). Bug real, preexistente y NO relacionado a claude-cli: `f9a5d2d` (Paneles-2b) borró por completo la edición de Autenticación/Endpoint/API key de una conexión ya creada (efecto colateral confirmado con `git show`, no una decisión documentada de esa fase) — desde entonces ninguna conexión por API key era editable desde la UI, y borrar una conexión dejaba en silencio huérfanos los chats que la usaban.

### Parte 1 — edición de conexión

Trigger nuevo: botón **"Editar"** en cada `connection-row` (junto a Desactivar/Eliminar), estado dedicado `editingProviderId`/`editForm` en `App()` — confirmado en la investigación previa que `focusedProvider`/`focusedPanelId` (el mecanismo del bloque de catálogo existente) solo se activa clickeando DENTRO de un panel de chat, nunca desde una fila de Configuración, así que no había nada real que reusar para el trigger.

Formulario inline (mismo patrón visual `<label className="field">` que ya usaba el bloque viejo — la clase CSS `.field` seguía existiendo en `main.css`, solo dejó de usarse en JSX, confirmado antes de escribir nada nuevo de diseño): Nombre visible, Autenticación (select, solo si `provider.allowSubscription !== false`), Endpoint (solo para los tipos que lo usan, mismo criterio que el bloque viejo), API key (solo si `authMode === 'api-key'`) — precargados con los valores REALES del provider al abrir, editados en estado local (`editForm`) hasta que el usuario confirma "Guardar" — recién ahí `updateProvider(provider.id, ...)` real, con `save:true`. **`provider.id` nunca cambia** — es el mismo objeto actualizado in-place dentro de `settings.providers`, nunca una conexión nueva — los chats que ya la referencian por `providerId` no quedan huérfanos por editar.

El bloque de catálogo (`focusedProvider`, `openrouter`/`openai-compatible`) queda sin tocar — convive como sección aparte, activada por su propio mecanismo, sin pisar ni compartir estado con `editingProviderId`.

**Gestión de modelos para el resto de proveedores** (Foundry/OpenAI/Anthropic/Google/DeepSeek): confirmado real con `grep` que `toggleModel()`/`deleteModel()`/`addManualModel()` solo tienen call sites dentro del bloque `openrouter`/`openai-compatible` — no existe ningún otro mecanismo real en ningún otro lado del código. Es una limitación preexistente más amplia que el problema central de este fix (edición de la conexión en sí) — **no implementada acá, fuera de alcance explícito**, anotada en `docs/_arch/PENDING.md`.

### Parte 2 — aviso de proveedor huérfano (2 puntos)

**Punto 1, antes de borrar** (`deleteProvider()`, `App()`): conteo real `chatSessions.filter(chat => chat.providerId === providerId).length` antes del `window.confirm()`, con el número real en el mensaje cuando es mayor que 0 — el usuario ya no decide a ciegas.

**Punto 2, en vivo** (`ChatPanel`): `useEffect` que compara `activeProvider?.id !== activeChat.providerId` (con `activeChat.providerId` truthy en la condición, para no disparar en chats que nunca tuvieron proveedor asignado) y llama `setAgentError(...)` — reusa `agentError`, ya cableado y renderizado por panel (`{agentError && <div className="state-error">{agentError}</div>}`), sin estado de UI nuevo.

**Bug real encontrado en la verificación en vivo, no anticipado en el diseño**: el primer intento del Punto 2 declaraba el `useEffect` junto a `activeModel` (arriba en el componente) — `deleteProvider()` dispara `disconnectAllPanels()` (bumpea `catalogChangeNonce`), y el efecto YA EXISTENTE que escucha ese nonce hace `setAgentError('')` como parte del reset de desconexión general. Como ese efecto está declarado MÁS ABAJO en el archivo, React lo corría DESPUÉS dentro del mismo commit — pisando en silencio el aviso recién puesto, en el mismo tick. Confirmado real probando en la app empaquetada: el chat cayó correctamente al proveedor de fallback (DeepSeek), pero el banner de aviso nunca apareció. Fix real: el efecto del aviso se movió a **después** del efecto de `catalogChangeNonce` (mismo archivo, mismo componente, orden de declaración importa para el orden de ejecución dentro de un commit de React) y sumó `catalogChangeNonce` a sus propias dependencias — mismo commit, pero corre segundo, el aviso sobrevive.

### Verificación real

Contra la app empaquetada real (`npm run dist` + instalación real vía `Amatista-V0.8.3-Setup.exe`, no un servidor de desarrollo) — 2 rondas, la primera destapó el bug de orden de efectos de arriba.

**Edición (Parte 1)**: conexión real de producción ("Claude API via Azure", Anthropic vía Azure, endpoint y API key reales) — clic en "Editar" mostró el formulario precargado con los valores reales (endpoint real, API key real enmascarada). Cambio real del campo "Nombre visible" a `"Claude API via Azure [test-edit]"`, "Guardar" — reabrir "Editar" en la MISMA fila confirmó el cambio persistido, con el Endpoint y la API key real intactos (nunca tocados, preservados en la actualización in-place). Revertido al nombre original y guardado de nuevo — sin dejar rastro en los datos reales del usuario.

**Huérfano (Parte 2), primera ronda (código sin el fix de orden de efectos)**: conexión de prueba real creada (`API compatible`, id `93e6cf7b-...`), confirmada con lectura directa de `amatista.db` (SQLite) que un chat real ("Chat nuevo") quedó con `provider_id = 93e6cf7b-...`. Clic en "Eliminar" sobre esa conexión → diálogo real: **"Eliminar la conexion 'API compatible'? 1 chat que la usa pasara a otra conexion disponible."** — conteo exacto, confirmado antes de aceptar. Tras aceptar y abrir el chat afectado: pills del composer mostraron el fallback real (`DeepSeek · API key` / `DeepSeek V4 Pro`, un proveedor real distinto) — pero el banner de aviso NO apareció, el hallazgo real que llevó al fix de orden de efectos de arriba.

**Segunda ronda, con el fix ya aplicado (nuevo build + reinstalación real)**: mismo chat de prueba, reabierto tras el fix. Confirmado real: pills mostraron `Microsoft Foundry · API key` / `Foundry gpt-5.5` (otro fallback real distinto, `settings.activeProviderId` en ese momento) y, esta vez, el banner apareció correcto, texto exacto: **"El proveedor configurado para este chat ya no existe — usando Microsoft Foundry temporalmente."** Confirmado con zoom sobre la captura real de pantalla, no solo a simple vista. El fix de orden de efectos resuelve la carrera real encontrada en la primera ronda.

`npm run typecheck` y `npm run build` en verde en ambas rondas — 2 builds/instalaciones reales completas (`npm run dist` + instalador real, no un servidor de desarrollo) para verificar cada ronda contra la app empaquetada real.

Datos reales del usuario, confirmados intactos al cerrar: `settings.json` con 20 proveedores (la conexión de prueba `93e6cf7b-...` eliminada como parte del propio test; `befbad94-...`, otra conexión de prueba preexistente NO creada en esta verificación, dejada sin tocar); "Claude API via Azure" confirmado con su nombre original restaurado, sin el sufijo `[test-edit]`.

## Reintegración completa de claude-cli

Basado en toda la investigación previa (`verify_claude_cli_reintegration.md`, backend de `dec378c^` ya revisado en chat, panorama real de App.tsx ya diagnosticado) y en la decisión ya confirmada por el usuario de mantener la re-siembra automática incondicional de "Claude Pro (suscripcion)".

**Confirmación previa (antes de tocar código):** `newProvider('anthropic', 'subscription')` (botón "Claude Pro") NO setea `allowSubscription:false` — solo lo hace para `authMode==='api-key'` (App.tsx, `newProvider()`). Un provider creado por ese botón queda con el campo `undefined` (`!== false` → permitido) — el selector de Autenticación del formulario de edición sí ofrece "Suscripción/sesión oficial" sin ningún ajuste previo necesario.

### Backend — restauración casi literal (`dec378c^`)

- **`cli-agent-runtime.ts`**: `CliAgentKind` vuelve a `'claude' | 'gemini'`. `sendClaude()`/`sendClaudeWithImages()`/`claudeCommand()`/`claudeImageBlocks()`/`parseDataUrl()`/`currentImageAttachments()` restaurados completos, mergeados con el fix real de Gemini (`geminiCommand()`, arg-splitting con `shell:true`) que se agregó DESPUÉS de `dec378c` y no existía en la versión pre-retiro — ese fix se preservó intacto, sin tocar (confirmado con `git diff` línea por línea contra `sendGemini()`/`geminiCommand()`). `buildEnv()`/`permissionArgs()` vuelven a bifurcar por `kind`.
- **`shared/types.ts`**: `'claude-cli'` de vuelta en `RuntimeKind`; comentario de `agentsMd` actualizado (claude-cli no lee AGENTS.md nativo, necesita inyección explícita — dato preservado del retiro).
- **`runtime-state.ts`**: `activeRuntime` recupera `'claude'`; comentario de `buildRuntimeContext()` actualizado.
- **`ipc-agent.ts`**: `connectSessionForWindow()` recupera el branch `model.runtime === 'claude-cli' ? detectClaude() : detectGemini()` + `configure({kind: 'claude', ...})`. `npm run typecheck` sobre el estado intermedio (backend 1-3 restaurado, este archivo todavía no) confirmó CERO errores — ningún switch exhaustivo en todo el codebase (mismo hallazgo que ya predijo la investigación), así que la reintegración de `ipc-agent.ts` se hizo por lectura directa del diff real (`dec378c^` vs actual), no guiada por el compilador.
- **`cli-status.ts`**: `detectClaude()` restaurada usando el mismo `versionOf()` genérico ya existente (mejora real respecto al original: hoy incluye fallback al shim de npm global, que no existía pre-`dec378c`).
- **`auth-manager.ts`/`ipc-cli.ts`**: `openClaudeLogin()`, `cli:installClaude`, rama `'anthropic'` de `auth:openCliLogin` restauradas.
- **`scripts/install-claude-cli.ps1`**: restaurado tal cual (idéntico al borrado en `dec378c`).
- **`mcp-client.ts`/`shared/model-capabilities.ts`**: comentarios que mencionaban solo Gemini/Codex actualizados para volver a nombrar claude-cli (cero cambio de lógica).
- **`preload/index.d.ts`/`preload/index.ts`**: `installClaudeCli()`, `claude: CliStatus` en `getCliStatus()`, comentario de `effort` actualizado.

### `settings-provisioning.ts`/`settings-store.ts` — re-siembra restaurada, decisión ya confirmada

`claudeSubscriptionProvider()` restaurada (id builtin fijo `qcfg-claude-subscription`, 2 modelos fijos sonnet/opus, `runtime:'claude-cli'`). Re-sembrada en los 3 mecanismos históricos: `sanitizeSettings(input, preferSubscriptionFallback=false)` (re-siembra incondicional si el builtin no está en `input.providers`, reordena al frente si ya existe; `preferSubscriptionFallback=true` SOLO en `index.ts` al arrancar, nunca en `settings:save`), `buildProvidersFromQConfig()` (vuelve a sembrar Claude Pro al importar `q_config.yaml`, `preferredProviderId`/`preferredModelId` apuntan de vuelta ahí), y `runtimeFor(type, authMode)` en **2 lugares distintos** — `App.tsx` (renderer, usado por `defaultModels()`/`newProvider()` Y por el nuevo formulario de edición) y `settings-store.ts` (main, usado por `migrateProvider()` en cada `loadSettings()`) — ambos vuelven a ramificar `type==='anthropic'` por `authMode` (`api-key`→`anthropic-api`, `subscription`→`claude-cli`), en vez del fijo `'anthropic-api'` que dejó `dec378c`. `CLAUDE_CLI_REMOVED_MARKER`/`migrateClaudeSubscriptionProviders()` (settings-provisioning.ts) y `migrateClaudeSubscriptionProvider()` (settings-store.ts) eliminados por completo — ya no aplican, claude-cli vuelve a ser un runtime real.

**Bug real encontrado en la propia verificación en vivo (no anticipado en el diseño):** una instalación real que ya pasó por el retiro (`dec378c`) y sus builds posteriores (~2 meses de fases: Paneles, LSP, benchmark, etc., cada `npm run dist` corrió `sanitizeSettings()`/`migrateProvider()` con la lógica de retiro activa) tiene el builtin `qcfg-claude-subscription` en disco **deshabilitado y con el marcador viejo en el nombre** (`"Claude Pro (suscripcion) — ya no soportado (claude-cli retirado)"`). `sanitizeSettings()` restaurado reordena ese builtin al frente si ya existe, pero — mismo comportamiento que tenía pre-`dec378c`, correcto para no pisar una decisión real del usuario — NO le toca `name`/`enabled`. El resultado real observado: el builtin reaparecía arriba de la lista pero seguía desactivado y con el texto viejo, engañoso (claude-cli sí está soportado de nuevo). Fix: `unmigrateClaudeSubscriptionBuiltin()` nueva en `settings-store.ts` (corre dentro de `migrateProvider()`, en cada `loadSettings()`) — "un-migración" simétrica, acotada **solo** al id builtin fijo (nunca a las 8 conexiones con id aleatorio que el propio usuario había creado a mano clickeando "Claude Pro" antes del retiro, todas siguen deshabilitadas+marcadas tal cual, confirmado real que no se resucitan). Verificado real: tras el fix, `qcfg-claude-subscription` aparece en Settings como `Anthropic — Suscripción — 2 modelos — Claude Sonnet, Claude Opus`, primero en la lista (`providerDisplayRank`), nombre limpio; las 8 conexiones fantasma siguen abajo, deshabilitadas, sin tocar.

### App.tsx — la parte nueva de diseño real

`CLAUDE_EFFORT_LEVELS` restaurado; `effortOptions` (selector de esfuerzo del composer) recupera la rama `runtime==='claude-cli'`. `runtimeFor()` (renderer) restaurado — ver arriba. `cliStatus`/`ChatPanelProps.cliStatus` ganan `claude?: CliStatus`. `readiness()` recupera el check `activeProvider.type==='anthropic' && authMode==='subscription' && !cliStatus.claude?.installed`. Bloque de aviso "conexión deshabilitada automáticamente" (usaba `CLAUDE_CLI_REMOVED_MARKER`, ya no existe) eliminado — ya no aplica.

**Formulario de edición inline** (fix anterior, "edición de conexiones"): rama hermana nueva `editForm.authMode === 'subscription' && provider.type === 'anthropic'`, mutuamente excluyente con la rama `api-key` existente (las dos cuelgan de `editForm.authMode`). Solo status (`Claude Code CLI: instalado (2.1.241) — instalar o iniciar sesión desde la sección "CLI" más abajo`), sin duplicar botones de acción — **decisión de diseño deliberada**: la gestión real de instalar/loguear vive en la sección global "CLI" (mismo patrón ya establecido para la cuenta de Codex, que tiene su propia sección "Cuenta ChatGPT (Codex)" en vez de vivir embebida por conexión — precedente directo, no un patrón nuevo inventado para esta fase). `installClaudeCli()` nueva; `openGeminiCliLogin()`/`geminiCliInstallHint()` generalizadas de vuelta a `openCliLogin(providerType: ProviderType)`/`cliInstallHint(providerType)` (mismo IPC `auth:openCliLogin` de siempre, ya soportaba ambos tipos del lado main sin cambio). Sección "CLI" extendida: estado de Claude Code junto a Codex/Gemini, botones "Instalar Claude Code CLI"/"Iniciar sesión Claude Code".

### Bug real encontrado en la verificación en vivo — `--resume` roto por `--no-session-persistence`

**No anticipado en ninguna investigación previa.** Verificación real de un turno de 2 pasos (texto, luego imagen, misma conexión): el primer turno ("VERIFICACION-REAL-OK") funcionó perfecto; el segundo turno (imagen adjunta) falló real: `Error: Error invoking remote method 'agent:send': Error: No conversation found with session ID: e1fdf20c-...`.

Causa real confirmada: `--no-session-persistence` (Tarea 3 de la investigación) impide que Claude Code CLI escriba la sesión a disco — `sendClaude()`/`sendClaudeWithImages()` seguían pasando `--resume <sessionId>` en el segundo turno (capturado del primero), pero esa sesión NUNCA se persistió, así que `--resume` no encuentra nada real que resumir. A diferencia de Codex (proceso `app-server` vivo durante TODA la conexión — `session.codexClient` — mantiene su propio estado en memoria pese a `ephemeral:true`, nunca necesita releer nada de disco durante la vida de la conexión), claude-cli spawnea un **proceso nuevo por turno** (`spawn(claudeCommand(), args, ...)` en cada `sendClaude()`) — sin persistencia a disco no hay ninguna forma real de continuidad server-side.

**Fix real, 2 lados simétricos:**
1. `cli-agent-runtime.ts`: `sendClaude()`/`sendClaudeWithImages()` dejan de pasar `--resume <sessionId>` por completo para el kind `'claude'` — siempre fallaría con `--no-session-persistence` activo, sin importar qué prompt se mande. `this.sessionId` se sigue capturando (inofensivo, ya no se usa para `--resume` en este runtime).
2. `ipc-agent.ts`: `seedContext` (antes: solo el primer turno de la conexión, `!session.activeContextSeeded && context.history.length>0`) ahora es `model.runtime === 'claude-cli' || (!session.activeContextSeeded && context.history.length>0)` — claude-cli manda el contexto COMPLETO en **cada** turno, no solo el primero, porque ya no puede depender de que Claude Code recuerde turnos anteriores por su cuenta.

**Verificado real, 2 rondas de build+instalación completas** (`npm run dist` + instalador real, 3 UAC reales aprobados por el usuario a lo largo de toda la verificación): primera ronda reprodujo el error real descrito arriba; segunda ronda (con el fix) confirmó una conversación real de 2 turnos en la MISMA conexión — turno 1 texto ("TURNO-1-OK"), turno 2 con imagen adjunta real (PNG generado real, no un mock) preguntando el color predominante, respuesta real "NEGRO" — sin ningún error, ninguna de las 2 veces.

### Verificación real completa

- **Conexión de suscripción real desde el formulario de edición**: "Claude Pro (suscripción)" seleccionado en el composer, pills reales `Anthropic · Suscripción` / `Claude Sonnet` / `Agente · claude`, selector "Esfuerzo: por defecto" visible (confirma `effortOptions` con `claude-cli`).
- **Turno real sin imagen**: "VERIFICACION-REAL-OK" → respuesta real idéntica.
- **Turno real con imagen, mismo turno de una conexión nueva**: PNG real adjuntado vía diálogo nativo de archivos, pregunta sobre color → respuesta real.
- **Turno real con imagen en el SEGUNDO turno de la misma conexión** (el caso que expuso el bug de `--resume`): confirmado funcionando tras el fix.
- **`~/.claude/projects/*.jsonl`**: conteo real antes de TODA la verificación = 90. Conteo real después de 4 turnos reales completos (1 conexión con 2 turnos texto+imagen fallidos/reintentados, 1 conexión nueva con 2 turnos texto+imagen exitosos) = **90, sin cambio** — `--no-session-persistence` confirmado sosteniendo su comportamiento en cada turno real, no solo en una prueba aislada.
- **Gemini CLI — confirmado SIN regresión**: activada temporalmente la conexión real `Google · Suscripción` (preexistente, deshabilitada en producción), turno real intentado → falló con el MISMO error ya documentado en `PENDING.md` ("Encontrado durante la limpieza de claude-cli — falla pre-existente en Gemini CLI, sin investigar": `"Cannot use both a positional prompt and the --prompt (-p) flag together"`). Confirmado con `git diff` que `sendGemini()`/`geminiCommand()`/`buildEnv()`(rama gemini)/`permissionArgs()`(rama gemini) quedaron **byte a byte sin cambio** en toda esta fase — el fallo es 100% preexistente y ya documentado, no una regresión de esta reintegración. Conexión de prueba revertida a `enabled:false` al terminar, sin dejar rastro.
- **Siembra automática de "Claude Pro"**: confirmada real en la instalación de producción existente (no una instalación fresca simulada — el escenario real y más relevante: una instalación que YA pasó por el retiro) — builtin reactivado con nombre limpio tras el fix del backfill, arriba de la lista, sin resucitar las 8 conexiones fantasma con id aleatorio.
- **Datos reales del usuario, confirmados intactos al cerrar**: `settings.json` con 20 proveedores (mismo total que al empezar); `Google · Suscripción` revertido a `enabled:false`; chat de prueba (`"Respondeme solo con la palabra..."`) borrado al finalizar, sin dejar rastro en el sidebar real de producción.

`npm run typecheck` y `npm run build` en verde en cada una de las 3 rondas de esta fase (backend inicial, backfill del builtin, fix de `--resume`) — 3 builds/instalaciones reales completas (`npm run dist` + instalador real, 3 UAC aprobados por el usuario), cada una verificada contra la app empaquetada real, no un servidor de desarrollo.

## Infraestructura de HOME aislado para Antigravity CLI

Basado en `docs/_arch/verify_antigravity_cli.md` (investigación completa, incluida la Tarea puntual de redirección de HOME). Pieza base de aislamiento — **`agy` NO está integrado a `CliAgentKind` ni a ningún runtime todavía**, esto es solo la infraestructura verificada de forma independiente, para que la integración real (próximo paso separado, ver `docs/_arch/PENDING.md`) la reuse sin tener que re-diseñarla.

**Motivo real**: la investigación confirmó (revisando `agy --help` completo + la documentación oficial de Google) que Antigravity CLI **no tiene ningún flag/env var/setting real** equivalente a `ephemeral:true` (Codex) o `--no-session-persistence` (Claude Code CLI) — un turno headless sin `--continue` deja 10 archivos reales por turno en `~/.gemini/antigravity-cli/` (más agresivo que los otros 2 CLIs: incluye una base de datos SQLite completa de la conversación). El único mecanismo real encontrado, confirmado con pruebas reales (no documentado ni soportado oficialmente por Google): `agy` (binario Go) resuelve ese directorio vía `USERPROFILE`/`HOME` del proceso — redirigir esas 2 variables al spawnear el proceso aísla todo el árbol de estado.

**`getAntigravityHomeDir()`/`clearAntigravityHomeDir()`** (`app-paths.ts`, mismo patrón que `STORAGE_ROOT`/`ensureStorageRootOrExit()`): `getAntigravityHomeDir()` devuelve (y crea) `getAppDataSubdir('antigravity-home')` — bajo el storage root real de Amatista (`D:\AMATISTA\data\antigravity-home\` en la instalación real verificada, respeta `AMATISTA_STORAGE_ROOT` como el resto de `app-paths.ts`). `clearAntigravityHomeDir()` vacía el CONTENIDO de esa carpeta (nunca la carpeta en sí — evita pelear con locks de creación si algo la tiene abierta), sin `try/catch` propio: cada caller decide si el fallo es fatal o silencioso.

**2 puntos de limpieza reales, distinta garantía** (`index.ts`):
1. **Al arrancar** — `clearAntigravityHomeDir()` corre justo después de `ensureStorageRootOrExit()`/`app.setPath(...)`, antes de registrar cualquier IPC. Mecanismo GARANTIZADO: corre siempre, no depende de que la sesión anterior haya cerrado prolijo.
2. **Al cerrar** — `app.on('before-quit', ...)` nuevo (no existía ningún hook de cierre en `index.ts` antes de esta fase; `before-quit` elegido sobre `window-all-closed` porque es el hook real de Electron que corre una sola vez antes del cierre efectivo en cualquier plataforma, incluido macOS). Best-effort: envuelto en `try/catch`, nunca bloquea el cierre real si falla — el próximo arranque limpia igual vía el mecanismo garantizado.

**`antigravityIsolatedEnv()`** (`antigravity-home.ts`, archivo nuevo dedicado — no vive en `cli-agent-runtime.ts` a propósito, para no mezclar la pieza de aislamiento con la integración de runtime que todavía no existe): devuelve `{...process.env, USERPROFILE: home, HOME: home}` — resto de `process.env` intacto (PATH, etc.), pensada para ser reusada tal cual por quien integre `agy` al spawn real. Documentado explícito en el propio archivo: aísla la ESCRITURA A DISCO, no la sesión de cuenta — `agy` se autentica vía el keyring del sistema operativo (Windows Credential Manager), no vía un archivo relativo al HOME, así que un turno con este env sigue siendo la MISMA cuenta real de Google del usuario.

**Verificación real** (binario `agy` 1.1.23 real ya instalado, sin mockear nada — los 3 símbolos reales de `app-paths.ts`/`antigravity-home.ts` cargados y ejecutados tal cual vía un loader hook de Node que solo stubea el módulo `electron` en sí, nunca la lógica propia):
- `getAntigravityHomeDir()` real devolvió `D:\AMATISTA\data\antigravity-home` — confirmado bajo el storage root real de producción.
- `antigravityIsolatedEnv()` real devolvió `USERPROFILE`/`HOME` apuntando ahí, `PATH` heredado intacto.
- **Turno real de `agy` con ese env**: `agy.exe -p "..." --output-format json` con `USERPROFILE`/`HOME` reales apuntados a `D:\AMATISTA\data\antigravity-home\` → turno real exitoso (`"status":"SUCCESS"`), **42 archivos reales** escritos ahí (mismo árbol que la investigación original: `conversations/*.db`, `brain/<id>/`, etc.) — confirmado que la carpeta real del usuario (`~/.gemini/antigravity-cli/`) se mantuvo en el mismo conteo antes/después (50/50), y con **cero archivos con `LastWriteTime` en la ventana real de la corrida** (doble verificación, no solo un conteo).
- **Mecanismo de limpieza al arrancar, simulado real**: se dejó la basura real de la corrida anterior sin limpiar (42 archivos + un árbol `AppData/` inesperado que `agy` también escribió ahí — hallazgo real no anticipado, dato útil para quien integre) y se llamó a `clearAntigravityHomeDir()` real — resultado: **0 archivos**, carpeta en sí intacta (confirmado que no se borró y se pudo seguir escribiendo ahí).

`npm run typecheck` y `npm run build` en verde. Sin necesidad de empaquetar/instalar la app completa para esta verificación — la infraestructura es lógica pura de `main/` sin superficie de UI, verificada ejecutando las funciones reales compiladas fuera de Electron (loader hook de Node que solo stubea el import de `electron`, nunca la lógica de negocio real).

## Integración completa de Antigravity CLI

Basado en las 6 tareas de `docs/_arch/verify_antigravity_integration.md`, sobre la infraestructura de HOME aislado ya implementada arriba. `CliAgentKind`/`RuntimeKind`/`ProviderType` ganan `'antigravity'`/`'antigravity-cli'` — `ProviderType` nuevo, deliberadamente NO reusa `'google'` (mismo tipo de ambigüedad que ya causó un fix real para DeepSeek reusando `'anthropic'`).

**`sendAntigravity()`** (`cli-agent-runtime.ts`): mismo esqueleto que `sendClaude()` (spawn, `stdout` completo, `JSON.parse()` único al `exit`, sin streaming). `antigravityCommand()` nueva, mismo patrón que `claudeCommand()`/`geminiCommand()` — resuelve `%LOCALAPPDATA%\agy\bin\agy.exe` real si PATH está stale (mismo riesgo real ya documentado para Electron lanzado sin heredar una terminal actualizada).

**`buildEnv()`, rama `antigravity`**: parte de `antigravityIsolatedEnv()` (ya existente) para CUALQUIER conexión, no solo pruebas. `subscription`: confirma real que el keyring del SO sigue resolviendo la cuenta con el HOME redirigido. `api-key`: escribe el `settings.json` real (`GEMINI_API_KEY` sola no alcanza, confirmado con una key real inválida).

**`permissionArgs()`, rama `antigravity`**: `read-only`→`--mode plan --add-dir <workspace>`, `workspace-write`→`--mode accept-edits --add-dir <workspace>`, `danger-full-access`→`--dangerously-skip-permissions --add-dir <workspace>`. Deliberadamente SIN `--sandbox` (193s reales contra 2-8s normal, desproporcionado por defecto).

### 4 bugs reales encontrados en la propia verificación en vivo, ninguno anticipado en el diseño

1. **`agy` sale con código 1 pese a producir un envelope JSON válido con `status:'ERROR'`** — confirmado real con una API key inválida real: stdout tenía `{"status":"ERROR","error":"Agent execution terminated due to error."}`, exit code 1, stderr VACÍO. El chequeo `if (code !== 0) reject(...)` (mismo orden que `sendClaude()`) descartaba ese JSON real sin leerlo, perdiendo el mensaje real por uno genérico ("terminó con código 1"). Fix: `sendAntigravity()` intenta parsear `stdout` como JSON **primero**, sin importar el exit code — solo cae al chequeo de exit code si `stdout` no es JSON válido.

2. **`settings.json` de una conexión `api-key` anterior rompe una conexión `subscription` posterior en la MISMA carpeta compartida** — `getAntigravityHomeDir()` es una sola carpeta para TODA la app, no una por conexión. Confirmado real: tras un turno `api-key` (que escribe `modelProvider:'gemini'`), un turno `subscription` inmediatamente después en la misma carpeta falló real: `"modelProvider is set to \"gemini\" in settings.json, but the GEMINI_API_KEY environment variable is not set"`. Fix: `writeAntigravitySettingsForAuthMode(authMode)` (renombrada de `writeAntigravityApiKeySettings()`) ahora escribe el `settings.json` CORRECTO para el `authMode` real de CADA turno — `subscription` escribe `{}` (sin `modelProvider`), llamada desde ambas ramas de `buildEnv()`, no solo `api-key`. **Limitación real conocida, no resuelta**: 2 paneles con conexiones antigravity concurrentes de distinto `authMode` podrían tener una carrera real sobre este mismo archivo — no investigado si es alcanzable en la práctica (anotado en PENDING.md).

3. **`--add-dir <workspace>` NO confina el acceso — hallazgo crítico que contradice el diseño original de Tarea 3.** Confirmado real: con `--dangerously-skip-permissions` + `--add-dir <workspace>`, un pedido de leer un archivo puntual FUERA del workspace (`D:\APLICACIONES\ADISLA_205\AGENTS.md`, de otro proyecto real, no relacionado) tuvo éxito real, devolvió el contenido completo — `--add-dir` es una lista de PERMITIDOS que se SUMA (así lo describe el propio `--help`: "Add a directory to the workspace"), no un límite duro. El confinamiento real SÍ existe, pero en otro lugar: bajo `--mode plan`/`accept-edits` (SIN `--dangerously-skip-permissions`), el MISMO pedido fue auto-denegado real por `agy` — log real: `"a tool required the \"read_file\" permission that headless mode cannot prompt for, so it was auto-denied."` Conclusión real: `read-only`/`workspace-write` SÍ quedan confinados de forma real; `danger-full-access` NO tiene ninguna confinación real posible con los flags disponibles hoy — consistente con lo que su propio nombre implica (salta TODOS los permisos), mismo perfil de riesgo que `--dangerously-skip-permissions` de Claude o `yolo` de Gemini. Comentario del código corregido para reflejar esto con precisión, no la promesa de confinamiento original (incorrecta).

   > **ACTUALIZACIÓN REAL, sin confirmar hoy** (`docs/_arch/verify_antigravity_bug_report.md`): una reproducción independiente y más rigurosa de este mismo contraste, con setup 100% sintético, **NO lo confirmó**. Primer intento de esa reproducción encontró un defecto metodológico real propio: `agy` agrega el cwd del proceso a los directorios permitidos, además de `--add-dir` — si el cwd envuelve al archivo "de fuera", la prueba queda invalidada sin que se note. Corrigiendo eso (cwd forzado a estar DENTRO del `--add-dir`, nunca envolviendo el archivo externo), las 3 corridas (`--mode plan`, `--mode accept-edits`, `--dangerously-skip-permissions`) leyeron el archivo fuera del workspace por igual, `status:"SUCCESS"` en los 3 casos, sin ninguna línea de auto-denegación en ningún log. **Estado real: el hallazgo original queda SIN CONFIRMAR** — no se sabe todavía si fue un error metodológico de esta investigación original (el mismo tipo de defecto de cwd recién descrito, u otro no detectado) o si el comportamiento de `agy` cambió del lado del servidor (mismo binario `1.1.23`, pero el razonamiento corre contra un backend en la nube de Google). **No reportar esto a Google con la redacción actual** hasta resolver esta discrepancia.

4. **`detectAntigravity()` reportaba "no instalado" pese a estar instalado real** — la app real recién instalada y lanzada mostró "Antigravity CLI no está instalado" en la UI. `npmGlobalShimPath()` (fallback genérico ya usado por Claude/Gemini) asume una instalación vía npm (`%APPDATA%\npm\<comando>.cmd`) — `agy` NO se instala así. Fix: `antigravityShimPath()` nueva en `cli-status.ts`, mismo patrón de 2 pasos que `versionOf()` pero con la ruta real (`%LOCALAPPDATA%\agy\bin\agy.exe`, mismo dato ya usado en `antigravityCommand()`).

### Exposición externa (5 puntos, mismo patrón que claude-cli)

`shared/types.ts` (`RuntimeKind += 'antigravity-cli'`, `ProviderType += 'antigravity'`), `runtime-state.ts` (`activeRuntime += 'antigravity'`), `settings-provisioning.ts` (`antigravitySubscriptionProvider()` nueva, sembrada automática en `sanitizeSettings()` vía `reseedBuiltinSubscription()` factorizada + `buildProvidersFromQConfig()` — decisión explícita del usuario de sembrar igual que Claude), `ipc-agent.ts` (branch nuevo en `connectSessionForWindow()`, generalizado de 2 a 3 formas CLI), `App.tsx` (color de marca propio `#7c3aed` — distinto del gradiente de Gemini a propósito, mismo producto Google pero identidad visual propia; rama hermana en el formulario de edición reusando la estructura de Claude; sección "CLI" extendida; botones en "Agregar conexión"). `cli-status.ts`/`ipc-cli.ts`/`auth-manager.ts`/`preload/*` también actualizados (detección, instalación real vía PowerShell + el instalador oficial, login interactivo).

### Verificación real completa

- **Runtime real, fuera de la app empaquetada** (mismo mecanismo de verificación que la infraestructura base, `esbuild` real bundlando `cli-agent-runtime.ts` con `electron` externalizado + stub): turno real `subscription` exitoso (`"RUNTIME-TEST-OK"`), turno real `api-key` con key inválida real → error real correcto tras el fix (`"Agent execution terminated due to error."`), turno `subscription` INMEDIATAMENTE después del de `api-key` en la MISMA carpeta compartida → exitoso tras el fix del bug 2.
- **Confinamiento real, 2 pruebas**: `danger-full-access` + pedido de leer un archivo real fuera del workspace → tuvo éxito (confirma el bug 3, sin confinamiento real en ese modo). `workspace-write` (`accept-edits`) + mismo pedido → auto-denegado real (confirma que SÍ hay confinamiento real en los otros 2 modos).
- **UI real, app empaquetada e instalada** (`npm run dist` + instalador real, 2 UAC reales aprobados — el segundo tras el fix del bug 4): siembra automática confirmada real sobre datos de producción existentes (`"Antigravity — Suscripción — 3 modelos"`, rank correcto, color propio); turno de suscripción real desde la UI (`"UI-SUBSCRIPTION-OK"`); conexión de prueba `api-key` creada, editada con una key real inválida, y conectada real desde la UI (pill `Antigravity · API key`, `Agente · antigravity`) — el envío del mensaje puntual no se pudo confirmar por un glitch real de interacción del computer-use (el campo de texto no recibía input pese a 3 intentos, incluido triple-click + zoom para confirmar), no relacionado con el código — el mecanismo ya estaba confirmado exhaustivamente por la vía del runtime directo.
- **Carpeta real del usuario (`~/.gemini/antigravity-cli/`)**: 53 archivos antes de TODA la sesión de verificación (backend + UI), 53 después — sin cambio, confirmado en múltiples puntos de control. Único incidente real: una prueba puntual de `--sandbox` (Tarea 3) se corrió por error sin `USERPROFILE`/`HOME` redirigidos y dejó 1 turno real en la carpeta del usuario — detectado por el propio conteo (no cuadraba), identificado por `conversation_id`, y limpiado a mano (6 archivos de conversación + 1 log) — reconciliado exacto a 50 (el baseline de ese momento).
- **`settings.json` real de producción, confirmado limpio al cerrar**: 21 proveedores totales (20 previos + 1 real de Antigravity sembrado), la conexión de prueba `api-key` (`a7b125e5-...`) confirmada eliminada por id real (no solo visualmente — el diálogo de confirmación de borrado muestra el mismo nombre genérico para ambas conexiones antigravity, mismo comportamiento ya conocido de `providerName()`, así que se verificó con una lectura directa de `settings.json` antes de aceptar el borrado), chat de prueba borrado.

`npm run typecheck` y `npm run build` en verde en cada una de las 2 rondas de esta fase (implementación inicial, fix de `detectAntigravity()`) — 3 builds/instalaciones reales completas (`npm run dist` + instalador real, 2 UAC aprobados por el usuario en esta fase), cada una verificada contra la app empaquetada real.

## Verificación del named pipe de aprobación (pieza aislada, servidor MCP propio de Amatista)

Investigación previa: `docs/_arch/verify_mcp_server.md` (Tarea 0 completa) → `docs/_arch/verify_mcp_approval.md` (elicitation nativo de MCP no sirve headless, propuesta del named pipe). Esta fase verifica esa pieza sola, de punta a punta, **sin implementar el resto de las tools reales de Fase 1**.

### Implementado

- `src/main/mcp-approval-pipe.ts` (nuevo): `startMcpApprovalPipeServer()` — UN `net.createServer()` (primer uso real de `node:net` en el codebase, sin precedente previo) escuchando en un named pipe fijo de Windows (`\\.\pipe\amatista-mcp-approval`), un solo listener para toda la app. Protocolo propio (NO es MCP — es el canal privado entre el futuro servidor MCP, proceso nieto, y Amatista main): una línea JSON de request (`{panelId, title, detail}`), una línea JSON de response (`{approved}`), conexión cerrada después. El handler llama directo a `requestSessionToolApproval(panelId, title, detail)` — el MISMO mecanismo real ya usado hoy por `McpManager`/`mcpConfirm` (`ipc-agent.ts`) — cero código nuevo de UI/aprobación.
- `src/main/index.ts`: `startMcpApprovalPipeServer()` arranca junto a la limpieza garantizada de Antigravity, antes de cualquier IPC.
- Servidor MCP de prueba (`approval-test-server.js`, NDJSON a mano, mismo framing confirmado en `verify_mcp_server.md`) — vive en el scratchpad de la sesión, no en el repo (es harness de prueba, no producción). Una sola tool, `echo_with_approval`, que lee `AMATISTA_APPROVAL_PIPE`/`AMATISTA_PANEL_ID` de ENV, se conecta al pipe, bloquea esperando la respuesta, y devuelve `ECHO: <texto>` o `RECHAZADO por el usuario` según el resultado real.

### Bug real encontrado durante la propia verificación

**Git Bash (MSYS2) mangla el path del named pipe cuando se pasa como variable de entorno `export`ada** al invocar un binario nativo de Windows (`claude.exe`) — la conversión automática de paths de MSYS2 corrompe el string `\\.\pipe\amatista-mcp-approval` en tránsito, produciendo un `ENOENT` real del lado del servidor MCP de prueba (confirmado con un smoke test directo desde Node — sin pasar por `export` de bash — que sí conectó al pipe sin problema, aislando la causa al paso por el shell, no al pipe en sí). **Fix real, sin tocar el mecanismo del pipe**: pasar `AMATISTA_APPROVAL_PIPE`/`AMATISTA_PANEL_ID` por el campo `"env"` del propio `--mcp-config` JSON (que `claude.exe` lee directo del archivo, sin pasar por el entorno del shell que lo invoca) en vez de por variables de entorno exportadas. Relevante para el diseño real de Fase 1: cuando Amatista spawnee su propio servidor MCP, el spawn es hecho por `child_process.spawn()` de Node (como ya hace `cli-agent-runtime.ts`/`mcp-client.ts`), NO por un shell intermedio tipo Git Bash — este bug es específico de esta sesión de verificación manual (invocando `claude` desde Git Bash), no aplica al camino real de producción.

### Verificación real de punta a punta

Con Amatista corriendo real en modo dev (`npm run dev`), panel real abierto (`panelId` real confirmado vía DevTools del renderer), y Claude Code CLI real (2.1.241) conectado al servidor de prueba vía `--mcp-config --strict-mcp-config --dangerously-skip-permissions`:

- **Caso APROBADO**: turno real disparó la tool → diálogo real "Aprobación requerida — echo_with_approval quiere ejecutar" apareció en la ventana real de Amatista, con el título/detalle exactos mandados por el servidor de prueba → click real en "Aprobar" → el pipe devolvió `{approved:true}` → el proceso hijo (servidor MCP de prueba) se desbloqueó → resultado final real del lado de Claude: `` `ECHO: PRUEBA REAL DEL PIPE - CASO APROBAR` ``.
- **Caso RECHAZADO**: mismo flujo, click real en "Rechazar" → el pipe devolvió `{approved:false}` → resultado final real del lado de Claude: `RECHAZADO por el usuario`.
- Los 2 diálogos aparecieron y desaparecieron en tiempo real al hacer click — el bloqueo real del proceso hijo (sin polling, vía la promesa del socket) quedó confirmado en ambos sentidos.

### Conclusión para Fase 1

El mecanismo del named pipe funciona real, de punta a punta, y reusa el 100% de la infraestructura de aprobación ya existente — sin hallazgos que obliguen a un diseño distinto. Único ajuste real necesario: pasar contexto (pipe path, panelId) por el campo `env` del spawn en vez de por variables de entorno heredadas del proceso padre, cuando el spawn real lo permita (que es el caso — `cli-agent-runtime.ts` ya arma `env` explícito por conexión).

### Limpieza

Los 2 `console.log` temporales de diagnóstico (uno en `ipc-agent.ts`, uno en `App.tsx`) usados para leer el `panelId` real desde DevTools fueron removidos al terminar. `npm run typecheck` y `npm run build` verificados limpios después de la limpieza. Servidor de prueba y config `.mcp.json` de prueba quedaron en el scratchpad de la sesión, fuera del repo — no se commitea nada de esa parte.

## Servidor MCP de LSP para los 3 CLIs (alcance reducido, sin aprobación)

Basado en `docs/_arch/verify_mcp_server.md` + `verify_mcp_approval.md`. Implementación real de un servidor MCP propio de Amatista, alcance deliberadamente chico: solo las 4 tools de LSP (`find_definition`/`find_references`/`list_symbols`/`get_diagnostics`), **sin** aprobación (las 4 son de solo lectura). Codex queda **fuera de alcance** a propósito — no tiene un flujo de spawn per-turno como Claude/Antigravity (`codex app-server --stdio`, proceso persistente vía JSON-RPC, arquitectura distinta, ver `codex-client.ts`); el diseño original solo pidió integrar `sendClaude()`/`sendClaudeWithImages()`/`sendAntigravity()`.

### Dependencias

`@modelcontextprotocol/sdk@^1.30.0` + `zod@^4.5.4` agregadas — confirmado real que **no** necesitan `asarUnpack` por sí mismas (JS puro, sin `.node`, confirmado con `find` sobre `node_modules` tras instalar). Pero el **archivo de salida** del bundle (`out/main/mcp-lsp-server.cjs`) sí lo necesita — no por las dependencias, sino porque, igual que `typescript-language-server`/`pyright` (ver `lsp-client.ts`), es un script que un CLI externo **spawnea como proceso real**, y eso no puede vivir dentro de `app.asar`. Matiz real distinto del caso de `pyright`/`ts-language-server`: acá ni siquiera hace falta que `node_modules/@modelcontextprotocol` exista en producción — el bundle de esbuild INLINEA el SDK+zod completos, así que la única razón real de necesitar `asarUnpack` es "este .cjs se spawnea", no "esta dependencia tiene fricción de empaquetado".

### El servidor standalone (`src/main/mcp-lsp-server.ts`)

Script Node bundleado aparte con esbuild (`npm run mcp:lsp:bundle`, mismo patrón ya establecido por `bench:bundle`) a `out/main/mcp-lsp-server.cjs` — NO pasa por el bundle principal de `electron-vite` (ese solo tiene un entry point). Lee `AMATISTA_MCP_WORKSPACE` por ENV (mismo patrón que `AMATISTA_STORAGE_ROOT`/`AMATISTA_PANEL_ID`), instancia un `LspManager` real (la misma clase ya usada por los 4 runtimes API, sin reescribir nada de su lógica) scopeado a ese workspace, y registra las 4 tools vía `server.tool()` del SDK (`McpServer` + `StdioServerTransport`) con las MISMAS descriptions ya mejoradas de `tool-registry.ts` (reusadas literal, confirmado con diff visual) + una frase extra por tool apostando a que un CLI headless las prefiera — el propio benchmark ya confirmó que ni mejorar description ni sacar alternativas GARANTIZA uso, así que esto es una apuesta razonable, no una promesa.

**Caveat real de alcance, documentado en la propia tool**: este servidor no tiene `write_file`/`apply_patch`, así que `get_diagnostics` (que en `tool-registry.ts` depende de "archivos tocados con esas 2 tools") queda acotado a archivos ya **consultados** antes en el mismo turno vía `find_definition`/`find_references`/`list_symbols(path)` — documentado explícito en la nota agregada a la description, no oculto.

**Bug real encontrado y arreglado durante la propia verificación**: `resolveWithinWorkspace()` comparaba el `workspace` crudo de ENV contra el resultado de `path.resolve()` sin normalizar — un separador mixto (`/` vs `\`) en el valor de ENV producía un falso "Ruta fuera del workspace activo" real. Fix: `workspace = path.resolve(workspaceRaw)` una sola vez al arrancar.

### El problema real de `resolveBundledServerEntry()` fuera de Electron

`LspClient` (`lsp-client.ts`) resolvía la ruta de `typescript-language-server`/`pyright` vía `app.getAppPath()` (Electron) — un `import` estático que **rompe** en el servidor MCP standalone: fuera del runtime real de Electron, `require('electron')` devuelve el path al binario (comportamiento real, documentado, del paquete npm), no la API — `app.getAppPath` no existe ahí. Fix real: `resolveElectronAppPath()` nueva, `require('electron')` dinámico dentro de un try/catch (mismo patrón ya usado en este codebase para `officeparser`/`@napi-rs/canvas`, `document-reader.ts`), con `AMATISTA_APP_PATH` (ENV, puesto por quien arma la config MCP efímera) como fallback real para el caso standalone. Dentro de Electron real (el uso de siempre para los 4 runtimes API) esta función ni llega a mirar el ENV — `require('electron').app.getAppPath` resuelve directo.

### Wiring por CLI

- **Claude** (`sendClaude()`/`sendClaudeWithImages()`, `cli-agent-runtime.ts`): `--mcp-config` con un JSON **inline** (confirmado real que el flag acepta "JSON files or strings", no solo archivos) — efímero por turno, sin escribir nada a disco, SIN `--strict-mcp-config` a propósito (se suma a cualquier MCP que el usuario ya tenga configurado por su cuenta, nunca lo reemplaza).
- **Antigravity** (`buildEnv()`, rama `antigravity`): `agy` es el único de los 3 sin flag efímero real — `writeAntigravityMcpConfig()` nueva (`antigravity-home.ts`, mismo PATRÓN que `writeAntigravitySettingsForAuthMode()`, no literal — archivo y shape distintos: `<HOME>/.gemini/config/mcp_config.json`, `disabled:false` explícito confirmado como el shape real que `agy mcp add` produce) escribe DENTRO del HOME ya aislado justo antes de cada spawn. Misma limitación real heredada que `settings.json`: `getAntigravityHomeDir()` es una carpeta compartida por toda la app — anotado, no resuelto acá.
- Ambos casos: si el bundle no existe todavía (`mcpLspServerScriptPath()` → `null`, dev sin correr `mcp:lsp:bundle`), el turno sigue funcionando SIN el MCP de LSP — nunca bloquea nada, mismo principio ya establecido para `McpManager`/`LspManager`.

### Bug real de build encontrado en la propia verificación

`npm run dev` (`electron-vite dev`) **vacía `out/main/`** al arrancar — el bundle standalone, generado con un comando aparte, desaparece cada vez que se reinicia el dev server. `npm run build`/`npm run dist` están en el orden correcto (`electron-vite build && npm run mcp:lsp:bundle` — el bundle corre DESPUÉS, sobrevive), pero en dev hace falta correr `npm run mcp:lsp:bundle` a mano después de cada arranque de `npm run dev` para probar esta pieza — real, documentado, no arreglado (fuera de alcance del pedido, que era la integración, no la ergonomía de dev).

### Hallazgo real no anticipado: el gate de permisos de Claude bloquea MCP aunque sea de solo lectura

Con sandbox mode **"Workspace"** (`--permission-mode acceptEdits`), un turno real intentó `mcp__amatista-lsp__list_symbols` y Claude lo **denegó solo**, sin preguntar a nadie (`"Permiso denegado por vos... No puedo ejecutar la tool sin esa aprobación"`) — `acceptEdits` cubre las tools nativas de edición, pero NO auto-aprueba tools MCP de terceros. Como este alcance reducido no tiene aprobación (a propósito, las 4 tools son de solo lectura), el turno simplemente no pudo usar el MCP en ese modo. Confirmado real que con sandbox **"Acceso completo"** (`--dangerously-skip-permissions`) sí funciona. Esto es un hallazgo real, no decidido en el diseño original — anotado en PENDING.md para decidir si corresponde tratar las 4 tools de LSP como pre-aprobadas también en modo "Workspace" (tiene sentido: son de solo lectura, mismo criterio que ya aplican `read_file`/`list_dir`/`git_status` en `tool-registry.ts`), sin implementarlo en esta fase.

### Verificación real completa

- **Smoke test directo** (driver a mano sobre el `.cjs` bundleado, sin ningún CLI de por medio): `initialize` + `tools/list` (4 tools reales, descriptions completas) + `tools/call(find_definition)` real sobre un `sample.ts` de prueba → resultado real `sample.ts:1:17`, tras arreglar el bug de normalización de path.
- **Claude Code CLI real** (2.1.241), con `--debug mcp --debug-file`: turno real preguntando por la definición de `greet()` → wire log real confirma `"Calling MCP tool: find_definition"` / `"Tool 'find_definition' completed successfully in 1s"` → resultado `sample.ts:1:17`, el modelo citó explícito "resuelto por el TypeScript language server... no por texto".
- **Antigravity CLI real** (agy 1.1.23), HOME aislado + `mcp_config.json` con el shape real de `writeAntigravityMcpConfig()`: mismo turno → resultado correcto `sample.ts:1:17` (`find_definition`) + `sample.ts:1:1` (`list_symbols`) → confirmado NO simulado por evidencia real en disco: `agy` cacheó los 4 schemas reales bajo `<HOME>/.gemini/antigravity-cli/mcp/amatista-lsp/{find_definition,find_references,get_diagnostics,list_symbols}.json`, y el transcript real (`transcript_full.jsonl`) contiene 8 menciones reales de `amatista-lsp` y el valor exacto `1:17` (imposible de adivinar sin la llamada real). Nota real: el mismo servidor SDK-based que ahora conecta limpio con `agy` es justo el que `verify_mcp_approval.md` recomendaba probar — el server hecho a mano de esa investigación anterior SÍ colgaba el handshake con `agy`; este, con el SDK oficial, no.
- **Wiring real de producción** (no un config armado a mano): Amatista real en modo dev, panel real conectado a Claude Sonnet (Anthropic · Suscripción → `claude-cli`), workspace real de un proyecto del usuario (`YAYOSCHAT`, no un mock) — turno real le pidió confirmar una definición real; con sandbox "Acceso completo" llamó `list_symbols` sobre `server/node_modules/pg-protocol/src/index.ts` (símbolos reales devueltos) y `find_definition` sobre el identificador `Parser` → resolvió correcto a `server\node_modules\pg-protocol\src\parser.ts:80:14` (y `:87:3`) — resolución **cross-file** real, solo posible con un language server real corriendo, no adivinable por texto.
- `npm run typecheck` y `npm run build` (con `mcp:lsp:bundle` incluido) verificados limpios al final, tras matar todos los procesos de prueba (dev server, `mcp-lsp-server.cjs` y sus `tsserver` hijos).

## Fix del gate de permisos — `--allowedTools` para las 4 tools MCP de LSP

Basado en `docs/_arch/verify_claude_permission_allowlist.md`. `permissionArgs()` (`cli-agent-runtime.ts`, rama `kind === 'claude'`): fuera de `danger-full-access`, se agrega `--allowedTools` con los 4 nombres EXACTOS (`mcp__amatista-lsp__find_definition`/`find_references`/`list_symbols`/`get_diagnostics`) — nunca wildcard (`mcp__amatista-lsp__*`), confirmado real con múltiples issues abiertos en `anthropics/claude-code` que el wildcard falla en silencio. `danger-full-access` queda sin tocar (`--dangerously-skip-permissions` ya salta todo el sistema, agregar esto sería redundante).

### Hallazgo real no anticipado: el fix NO funciona en sandbox "read-only"

Verificado real que `--allowedTools` **no tiene efecto bajo `--permission-mode plan`** (el mapeo real de sandbox `read-only`) — wire log confirma denegación real (`"mcp__amatista-lsp__find_definition tool permission denied"`), y el propio modelo lo explica correcto: *"está deshabilitada en plan mode... no tengo forma programática de salir de plan mode"*. Esto es un comportamiento real y estructural de `plan` mode en Claude Code — su propósito de diseño es bloquear TODA ejecución de tools hasta que el usuario apruebe explícitamente un plan, y `--allowedTools` no lo overridea. El código quedó implementado tal como se pidió (agregar `--allowedTools` en ambas ramas no-`danger-full-access`) — en `read-only` es un no-op inofensivo (no rompe nada, pero tampoco desbloquea nada), no el fix real que se buscaba para ese modo. Queda anotado, sin resolver, para decidir aparte si `read-only` necesita un enfoque distinto (o si se acepta que en ese modo las 4 tools de LSP simplemente no están disponibles, igual que antes de este fix).

### Verificación real

- **`read-only`** (`--permission-mode plan` + `--allowedTools`): confirmado que SIGUE denegando — `permission_denials` poblado con `mcp__amatista-lsp__find_definition`, wire log real `"tool permission denied"`. No hay regresión (mismo comportamiento que antes del fix), pero tampoco mejora.
- **Default/workspace-write** (`--permission-mode acceptEdits` + `--allowedTools`): confirmado real que SÍ funciona — `permission_denials: []`, wire log `"Calling MCP tool: find_definition"` con `permissionDecisionMs=0`, resultado correcto `sample.ts:1:17` corroborado además por `list_symbols`.
- **`danger-full-access`** (`--dangerously-skip-permissions`, sin `--allowedTools`): confirmado sin cambios — `permission_denials: []`, resultado correcto, mismo comportamiento que antes de este fix.
- `npm run typecheck` y `npm run build` (con `mcp:lsp:bundle`) verificados limpios.

## 4 fixes reales de UI de paneles (0.9.0)

Basado en `docs/_arch/verify_ui_paneles_0_9_0.md` (Problema 5 confirmado que no necesita cambio, quedó documentado sin tocar).

**Problema 1 — borde de color por panel**: `chatBorderAccent()` (ya existía, Fase "árbol de sub-chats") reusada tal cual en el `<div className="chat-panel">` (`App.tsx`) — antes SOLO se aplicaba a las filas del sidebar. `PROVIDER_BRAND.antigravity` sigue el mismo camino de código que el resto, sin caso especial.

**Problema 2 — botón duplicado**: sacado el botón "Modelos y cuentas" del topbar (era `setSettingsOpen(true)` idéntico al ícono ⚙ del sidebar) — queda un solo acceso a Configuración.

**Problema 3 — panel se cierra solo si su chat se borra**: `deleteChat()` ahora llama a `closePanel()` (ya existente, mismo cleanup real que un cierre manual) para el panel afectado, en vez del redirect silencioso viejo a un chat cualquiera. Caso límite (único panel abierto): `closePanel()` se niega a cerrar el último panel (guard ya existente) — se redirige a un chat en blanco NUEVO (`createBlankChat()`) en vez de dejarlo apuntando a un chatId borrado.

**Problema 4 — layout de 3 paneles se desbordaba**: `.panel-header-actions` (`main.css`) tenía `flex: none` — el cluster de controles (modelo, .mcp.json, Eventos, Panel, ×) nunca se achicaba, y con exactamente 3 paneles (`repeat(3,1fr)`, más angosto que el grid 2×2 de 4) se desbordaba visualmente contra el panel vecino. Cambiado a `flex: 0 1 auto` + `min-width: 0` + `overflow-x: auto` — el cluster ahora se achica y, si no entra, scrollea horizontal DENTRO de su propio panel, sin invadir al vecino.

### Verificación real completa (app real, modo dev, 3 paneles reales)

- **Problema 2**: confirmado visualmente — el botón ya no está en el topbar, solo queda "Pantalla completa" ahí y el ícono ⚙ en el sidebar.
- **Problema 1**: confirmado con evidencia de DOM real (`document.querySelector('.chat-panel').getAttribute('style')` en DevTools) — antes del primer turno real: `'border-left: 3px solid rgb(156, 163, 175)'` (neutral, `chat.providerId` todavía no persistido — mismo comportamiento ya establecido para el sidebar, no es un bug nuevo). Después de un turno real con Codex: `'border-left: 3px solid rgb(16, 163, 127)'` — el verde real de OpenAI/Codex (`PROVIDER_BRAND.openai`), confirmado que el mecanismo funciona end-to-end.
- **Problema 4**: reproducido con 3 paneles reales conectados — confirmado que el cluster de controles ahora muestra una scrollbar horizontal real dentro de su propio panel (zoom real sobre el header lo confirma) en vez de desbordarse sobre el panel vecino — el problema original ya no se reproduce.
- **Problema 3**: reproducido 2 veces real. Con 3 paneles abiertos, borrado el chat que el panel 1 mostraba (con conversación real "hola"/"Hola.") vía el menú contextual del sidebar → confirmado que el conteo de paneles bajó de 3 a 2 (el panel se cerró de verdad, no quedó redirigido mostrando otro contenido). Caso límite con 1 solo panel abierto: borrado ese único chat → confirmado que el panel sigue existiendo (nunca 0 paneles), redirigido a un chat en blanco nuevo, sin romper la UI.
- `npm run typecheck` y `npm run build` en verde.

## Orquestador panel "principal" (`send_to_window`/`list_windows` gateadas) + numeración visual de paneles

Basado en `docs/_arch/verify_panel_orchestrator.md`. Dos piezas separadas a propósito, ejes de identidad DISTINTOS — un panel puede mostrar "2" visualmente y aun así ser el que tiene `send_to_window` habilitado, si ese es el que resulta ser el chat "principal" (comportamiento esperado, no bug).

### Pieza 1 — gating por chat "principal" (identidad de chat, no de posición)

`isPrincipalChat(chatId)` nueva (`chat-store.ts`) — MISMO criterio exacto que ya usaba `findChatSessionByPanelAlias()` para resolver el alias `"1"`/`"principal"` de `send_to_window` (título del chat SIN el sufijo `" — Panel N"`), pero consultado por `chatId` real en vez de por alias tipeado por el modelo. `false` si el chat no existe — sin evidencia real de que sea el principal, no se le da el beneficio de la duda.

Calculado UNA vez por conexión, en `connectSessionForWindow()` (`ipc-agent.ts`) — no en cada turno, mismo criterio que provider/model (fijos hasta el próximo `agent:connect`) — y threadeado como `isPrincipalChat?: boolean` en `ConfigureOptions` (`api-agent-runtime.ts`). `ApiAgentRuntime.toolCatalog()` gana un 3er filtro por nombre, reusando el MISMO patrón que ya tenía ahí para `AMATISTA_EXCLUDED_TOOLS` (y que `explore-tool.ts` ya usaba para `EXPLORE_TOOL_NAMES`): `send_to_window`/`list_windows` se excluyen del catálogo completo si `!isPrincipalChat` — no fallan al llamarlas, no existen para el modelo. Log real bajo `AMATISTA_DEBUG_TOOLS` (mismo flag ya existente).

Confirmado real (no asumido) que `send_to_window`/`list_windows` NUNCA llegan a ningún otro runtime: Codex (`codex-client.ts`) y los 3 runtimes CLI (`cli-agent-runtime.ts`, claude-cli/antigravity-cli/gemini-cli) no importan `TOOL_DEFINITIONS`/`ToolExecutor`/`toolRegistry` en absoluto — tienen su propio sistema de tools nativo. `ApiAgentRuntime.toolCatalog()` es el ÚNICO punto del codebase donde estas 2 tools llegan a un modelo real.

### Pieza 2 — numeración visual 1/2/3/4 (posición en pantalla, eje distinto)

`ChatPanelProps` gana `panelIndex: number` — poblada en el call site (`App.tsx`, `openPanels.map((entry, index) => ...)`) con `index + 1`. El índice del array YA era el orden visual real del grid (render en el mismo orden), no existía ningún campo de "posición" antes — cero estado nuevo en `PanelEntry`/`openPanels`. `panel-header-title` pasa de `{activeWorkspaceName ?? activeChat.title}` a `{panelIndex}` — el nombre del workspace ya se ve en el título general de la ventana, era una redundancia real.

**Bug real encontrado en la verificación en vivo (no en la investigación previa)**: con contenido de 1 solo carácter, `.panel-header-identity` (badge + número) colapsaba a ~17px de ancho real — MENOS que el propio `ProviderBadge` de 26px, número invisible en pantalla aunque presente y correcto en el DOM (`textContent`/`opacity`/`visibility` todos correctos, medido con `getBoundingClientRect()` real vía DevTools). Causa real: competía por espacio con `.panel-header-actions` bajo `flex-shrink` proporcional al propio `flex-basis` (`auto`) de cada bloque — con el nombre del workspace (texto largo, `flex-basis` grande) la pérdida proporcional quedaba chica en TÉRMINOS RELATIVOS (se notaba como truncamiento con ellipsis, nunca colapso total); con 1 dígito (`flex-basis` ~44px: 26px badge + 8px gap + ~10px dígito) el mismo reparto proporcional consumía casi toda su base. Fix real: `flex-shrink: 0` en `.panel-header-identity` — sale de la competencia por completo, toda la presión de espacio insuficiente la absorbe `.panel-header-actions` vía su propio `overflow-x: auto` (Problema 4, arriba — ya diseñado exactamente para absorber esa presión).

### Verificación real

- **Pieza 1**: harness real (mismo patrón `esbuild --bundle --packages=external` que ya usaba `mcp:lsp:bundle`) importando `chat-store.ts`/`api-agent-runtime.ts` REALES fuera de Electron, sin mocks. `isPrincipalChat()` confirmado real contra 6 chats REALES de la DB del usuario (2 sin sufijo → `true`, 3 con sufijo → `false`, 1 `chatId` inexistente → `false`) — los 6 resultados exactos a lo esperado. `ApiAgentRuntime.toolCatalog()` real vía `configure()` real: `isPrincipalChat=true` → 19 tools (incluye ambas), `false` → 17 (ninguna de las 2), `undefined` (default, fail-closed) → 17 también — resto del catálogo idéntico en los 3 casos.
- **Pieza 2**: app real en modo dev, hasta 4 paneles reales abiertos simultáneos (GPT-5.5 vía Codex ChatGPT suscripción), DevTools real. El bug de ancho se encontró con `document.querySelectorAll('.panel-header-title')` + `getBoundingClientRect()` (no con la vista sola, que lo ocultaba sin dejar rastro visual de que el texto seguía ahí) — fix de CSS aplicado con HMR en caliente, re-medido en el mismo proceso: `identityW`/`titleW` pasaron de `0`/`16.7px` a valores reales visibles (`~39-41px`/`~5-7px`), "1"/"2"/"3"/"4" confirmados tanto por DOM (`textContent`) como visualmente en captura de pantalla real, sin DevTools abierto.
- 3 chats de prueba creados durante la propia verificación (para forzar 4 paneles reales) borrados al terminar vía `chats:deleteSession` real (mismo canal IPC que usa "Borrar chat" en la UI, no edición directa de la base) — confirmado con un reload completo de la app que los 6 chats reales pre-existentes del usuario quedaron intactos.
- `npm run typecheck` y `npm run build` en verde (incluye el fix de CSS).

## 3 piezas de UI del sidebar/header de panel — menú "···", sidebar contraíble, texto deslizante (marquee)

Basado en `docs/_arch/verify_ui_sidebar_header.md` (Pieza 1: Tareas 1/2/3; Pieza 2: Tarea 5) + investigación propia hecha en esta misma fase para Pieza 3 (sin doc previo dedicado). Restricción explícita respetada: el fix de scroll horizontal del header de panel (Problemas 1-4, todavía sin commitear) no se tocó — coexiste sin conflicto, y de hecho el cluster de acciones ahora necesita MENOS scroll (2 botones se convirtieron en 1).

### Pieza 1 — menú "···" para `.mcp.json` + Eventos

`ContextMenuState` (`App.tsx`) gana una 4ta variante `panelHeader` — mismo patrón discriminado ya usado para `chat`/`message`/`composer`, un solo bloque de render compartido (`.context-menu`, mismo estilo visual). `.mcp.json` y `Eventos (N)` (los 2 controles de menor frecuencia real de uso, ya identificados en la investigación previa) se mueven detrás de un botón `···` nuevo en el header del panel; Modelo/`⧉ Panel`/`×` quedan visibles sin cambio. `.context-menu button:disabled` nueva en `main.css` — no existía ninguna regla propia para `:disabled` ahí, hacía falta porque `.mcp.json` puede llegar deshabilitado (sin workspace activo).

### Pieza 2 — sidebar contraíble

1 estado nuevo (`sidebarCollapsed`, deliberadamente no persistido entre reinicios — mismo criterio que `modelMenuOpen`/`settingsOpen`, estado de UI efímero) + `.sidebar-toggle` nuevo (ícono `☰`). El grid raíz (`.app`) ya tenía una sola propiedad controlando el ancho del sidebar (`grid-template-columns`, confirmado en la investigación previa) — colapsado usa `grid-template-columns: 0px minmax(0, 1fr)`.

El botón toggle se renderiza SIEMPRE, con `position: fixed`, fuera de `<aside className="sidebar">` — con el sidebar en `0px` no hay ningún lugar adentro de esa columna donde ubicarlo que siga siendo clickeable; `position: fixed` lo mantiene accesible en los 2 estados sin depender del ancho real de `.sidebar`. `!important` necesario en la regla de `.app.sidebar-collapsed` — el archivo ya tenía 2 reglas `.app { ... !important }` preexistentes (ancho fijo 292px) que había que ganarle, mismo mecanismo de cascada (2 clases + `!important` gana a 1 clase + `!important` sin importar el orden en el archivo) ya establecido en la fase anterior (Pieza 2 de la numeración de paneles).

**Bug real encontrado en la propia verificación en vivo (no en la investigación)**: con el sidebar colapsado, `.topbar` (que ahora arranca en `x=0`, sin la columna del sidebar antes) se solapaba visualmente con `.sidebar-toggle` (fixed, `left: 10px`) — el título del workspace en el topbar quedaba parcialmente tapado. Fix real: `.app.sidebar-collapsed .topbar { padding-left: 52px !important }` (mismo motivo de `!important`, le gana a otra regla `.topbar { padding: 0 18px !important }` preexistente en el archivo).

### Pieza 3 — texto deslizante (marquee) en hover, solo donde el texto se corta

`MarqueeSpan` nueva (componente reusable, `App.tsx`) — 4 usos reales: `chat-title-main`, `chat-title-sub`, `project`, `root-title-open`. La animación en sí es 100% CSS (`@keyframes` + `:hover`) — `container-type: inline-size` en `.marquee-outer` + `100cqw` en el keyframe le dan al desplazamiento el ancho EXACTO del contenedor sin necesidad de medirlo por JS.

El único JS real de esta pieza es el gate `is-truncated` (`el.scrollWidth > el.clientWidth`, remedido en cada cambio de texto y en cada resize de ventana vía `useEffect`) — necesario porque CSS puro con container query units no puede distinguir "está cortado" de "no está cortado" sin producir un salto espurio chico en items que ya entran completos (matemáticamente, `calc(-100% + 100cqw)` da un valor positivo pequeño en vez de exactamente `0` cuando el contenido es más angosto que el contenedor). La clase `is-truncated` evita ese caso por completo en vez de confiar en que el número de la fórmula dé casualmente cero.

`.project`/`.root-title-open` (botones que antes truncaban el texto directo sobre sí mismos) pasan a `display: flex; min-width: 0` con el `overflow`/`text-overflow`/`white-space` movidos al `<MarqueeSpan>` hijo — una regla de flexbox con texto + ícono no puede aplicar `text-overflow` de forma confiable sobre sí misma con 2 hijos. `.root-title-open` además separa el carácter `⌄` en un `.root-title-chevron` (`flex: none`) para que NO se deslice junto con el nombre — solo el nombre real es el que anima.

### Verificación real

- **Pieza 1**: app real en modo dev — el botón `···` abre el mismo `.context-menu` compartido mostrando `.mcp.json`/`Eventos (0)`. Ambos clickeados y confirmados funcionando igual que antes: "Eventos" abrió el panel de debug real ("Eventos del agente — Sin eventos todavía..."); `.mcp.json` disparó `openMcpConfig()` sin error, cerrando el menú correctamente.
- **Pieza 2**: confirmado colapsando/expandiendo con 1 y luego con 2 paneles reales abiertos simultáneos — el grid de paneles se reacomoda al ancho completo sin romperse en ambos casos, el botón toggle queda accesible y con el tooltip correcto (`Contraer sidebar`/`Expandir sidebar`) en los 2 estados.
- **Pieza 3**: hover real sobre un chat REAL con nombre largo real (`WORKSPACE_AMATISTA — Panel 3`, no simulado) — capturado en 3 momentos: estado inicial cortado (`WORKSPACE_AMATISTA — Panel`, sin el "3"), a ~2.3s del hover deslizado revelando el "3" que antes tapaba el ellipsis, y vuelta suave a la posición inicial al sacar el mouse. Confirmado con DevTools (`document.querySelectorAll('.marquee-outer')` + `scrollWidth`/`clientWidth` reales) que de 13 items reales del sidebar SOLO los 2 con contenido genuinamente más ancho que su caja (`scrollWidth 209 > clientWidth 190`) reciben `is-truncated` — el resto, incluido un chat con nombre igual de largo pero que entra justo (`WORKSPACE_AMATISTA — Panel 5`, `206 = 206`), queda sin la clase y sin animación.
- 1 chat de prueba creado durante la propia verificación (al abrir un 2do panel) borrado al terminar vía `chats:deleteSession` real (mismo canal IPC que "Borrar chat" en la UI) — confirmado con reload completo que los 6 chats reales del usuario quedaron intactos.
- `npm run typecheck` y `npm run build` en verde, incluido el fix del solape encontrado en vivo (Pieza 2).

## Fix real — `closePanel()` no sincronizaba `openPanelsRef.current`, resurrección de identidad de panel

Basado en `docs/_arch/verify_closepanel_race.md` — riesgo documentado en `PENDING.md` que nunca se había reproducido, hasta esta fase. **Reproducido real, no teórico**: la ventana natural entre `closePanel()`/`setOpenPanels()` y que el `useEffect` sincroniza `openPanelsRef.current` mide **4.1ms** real (medido con `performance.now()`, sin modificar nada). El auto-open real del orquestador (`send_to_window`) tarda **~17 segundos** en llegar al renderer desde la aprobación — una ventana de oportunidad real (no un timing imposible) para que un usuario cierre un panel justo durante esos 4.1ms en algún punto de esa espera. Síntoma real confirmado 2 veces (mismo `panelId` exacto en el log tras "cerrar" el panel "resucitado"): un panel que el usuario cerró a propósito volvía a aparecer con el MISMO id, arrastrando estado viejo (un error de conexión real de un intento anterior) — más serio que el falso límite de `MAX_PANELS` que `PENDING.md` especulaba originalmente.

**Fix**: `closePanel()` (`App.tsx`) muta `openPanelsRef.current` manualmente, SINCRÓNICO, dentro de la propia función — mismo patrón de ref-espejo que `openChatInPanel()` ya usaba para el caso inverso (abrir). Mismo guard que el `setOpenPanels()` updater real (nunca toca el ref si el panel no se va a cerrar de verdad — o sea, si es el último panel abierto), para que ref y estado real de React nunca diverjan en CUÁL panel se cierra. `setOpenPanels()` sigue siendo la única fuente real de verdad para el estado de React — su lógica interna no cambió. `openChatInPanel()`/el mecanismo de auto-open en sí quedaron sin tocar, por restricción explícita — el fix es exclusivamente que `closePanel()` deje de ser la fuente de la desincronización.

### Verificación real — mismo escenario exacto, timing natural sin widening

Repetición real del MISMO escenario que expuso el bug: panel real como origen, `WORKSPACE_AMATISTA — Panel 5` real como destino, `sendToWindowByTitle()` real invocada vía el mismo mecanismo (V8 inspector + CDP, sin LLM ni API key — ninguna disponible en este entorno). A diferencia de la investigación original, esta vez **sin ningún widening artificial** (se pidió reducir o eliminar el intervalo si era posible — se eliminó por completo, de 30s a 0s, y el fix se sostuvo igual, porque ya no depende de ganarle una carrera al `useEffect`: el ref queda correcto en el mismo tick del cierre, sin importar cuánto tarde el auto-open en llegar).

| | Snapshot leído por `openChatInPanel()` al llegar el auto-open | Resultado |
|---|---|---|
| Antes del fix (ventana ensanchada a 30s) | Incluía el panel recién cerrado | Panel resucitado con el MISMO `panelId` |
| Después del fix (timing natural, 0s de widening) | NO incluye el panel cerrado | Panel nuevo real, sin rastro del cerrado |

Gap real en esta corrida entre el cierre y la llegada del auto-open: 12.76 segundos — mismo orden de magnitud que los ~17s medidos en la investigación original. Confirmación adicional: se volvió a cerrar el panel auto-abierto y el log mostró un `panelId` DISTINTO al cerrado antes — sin ningún indicio de reciclaje.

`npm run typecheck` y `npm run build` en verde. Instrumentación temporal de diagnóstico (reagregada solo para esta re-verificación, mismo patrón que la investigación original) revertida al 100% — el diff final sobre `App.tsx` contiene únicamente el fix real (22 líneas, todas dentro de `closePanel()`).

## Fix real — detección de staleness en `write_file`/`apply_patch` (huella de contenido)

Basado en `docs/_arch/verify_concurrent_write_staleness.md` — reproducido real en 2 escenarios (carrera pura `write_file` vs `write_file` con `Promise.all`, y staleness forzada real de `apply_patch` inyectada vía el propio `ctx.confirm` de la sesión A para correr la escritura completa de B durante la espera de aprobación de A): ambas tools escribían ciego, `ok:true`, sin ningún chequeo — ni hash, ni `mtime`, ni versión — perdiendo el cambio ajeno en silencio con una confirmación de éxito engañosa.

**3 preguntas de diseño confirmadas con código real antes de implementar**: (1) no existía función de hash de CONTENIDO reusable — `createHash` de `node:crypto` ya estaba importado en `local-vcs.ts`, pero solo para hashear la ruta del workspace, nunca contenido de archivo; (2) el punto de inyección exacto es idéntico en las 2 tools — justo después de que cierra el `if (!approved)`, antes de `snapshotFile()`/`writeFileSync()`; (3) `ToolExecutionResult` no tiene ningún canal estructurado hacia el modelo más allá de `output` (string) — confirmado por los propios comentarios del código ("nunca llega al modelo").

**Fix** (`tool-registry.ts`): `hashFileContent()` nueva (SHA-256, mismo import que `local-vcs.ts`, variable separada, sin tocar el uso existente ahí — `null` se hashea aparte de `''` real, para no confundir "archivo nuevo" con "archivo vacío"). El contenido se hashea en el mismo instante en que ya se leía (`existingContent`, antes de `resolveApproval()`) — sin lectura extra nueva, solo una línea de hash sobre lo que ya estaba en memoria. Justo antes de `snapshotFile()`/`writeFileSync()` se relee el archivo real y se compara el hash fresco contra el guardado; si no coinciden, `{ok:false, output: mensaje real orientando al modelo a releer con read_file y reintentar}` — mismo estilo que el mensaje ya existente de `old_str` no encontrado, sumado como 3er caso al mismo patrón condicional que ya distingue `read-only` de rechazo del usuario. Nunca llega a tocar el VCS oculto ni el archivo real cuando rechaza. `resolveApproval()`/`ctx.confirm()` sin tocar, por restricción explícita — el fix es exclusivamente el chequeo de staleness alrededor de ellos. `ToolExecutionResult` sin campos nuevos, confirmado innecesario.

### Verificación real — mismo escenario exacto, antes/después + caso feliz

Mismo harness bundleado standalone con esbuild (mismo patrón que `mcp:lsp:bundle`) contra un workspace aislado real, mismo escenario EXACTO de la investigación (mismo mecanismo de inyección vía `ctx.confirm` de A):

```
resultado final de A: {"ok":false,"output":"El archivo \"shared.txt\" cambio en disco despues de que lo leiste (probablemente otra sesion/panel lo edito mientras tanto) -- volve a leerlo con read_file y volve a intentar la edicion..."}
contenido final REAL en disco tras A: "line1\nLINE2_FROM_B\nline3\n"
```

A fue rechazada con el mensaje real de staleness, **nunca llegó a escribir** — el cambio de B (que antes se perdía sin aviso) sobrevive intacto en disco. Caso feliz confirmado sin regresión: una escritura normal de `write_file` y una de `apply_patch`, sin carrera, ambas `ok:true` exactamente como antes.

**Hallazgo honesto adicional, no escondido**: en el escenario de carrera PURA sin ningún gap forzado (ambas `danger-full-access`, `Promise.all`, sin pausa real entre lectura y escritura de ninguna de las 2), el chequeo optimista puede no alcanzar a detectar la carrera si ambas relecturas ocurren antes de que cualquiera de las 2 escrituras reales suceda — confirmado real, 6 corridas consecutivas, ambas devolvieron `ok:true`. Esto es un residual esperable de cualquier chequeo optimista (leer-comparar-escribir) sin un lock exclusivo real, no una regresión ni un descuido — el escenario real que motivó el fix (una pausa real de cualquier duración entre la lectura y la escritura: espera de aprobación humana, tiempo de decisión del LLM entre turnos, o el ~17s del auto-open del orquestador) queda cubierto al 100%, que es exactamente el caso que la investigación original reprodujo y documentó como el riesgo real.

`npm run typecheck` y `npm run build` en verde. Harness y workspace de prueba temporales borrados al terminar — `git diff` final sobre `tool-registry.ts` contiene únicamente el fix real (53 líneas).

## Retiro completo de gemini-cli — renombre del literal, subproceso CLI retirado

Basado en `docs/_arch/verify_gemini_cli_removal_scope.md` (investigación previa) y `docs/_arch/verify_gemini_cli_removal.md` (verificación de esta implementación): `gemini-cli` standalone quedó discontinuado para cuentas individuales (`IneligibleTierError` real, confirmado en un intento real contra la cuenta real de Google — Google redirige a Antigravity, que ya cubre el mismo terreno). Decisión del usuario: retirar el feature entero en vez de seguir arreglando bugs de un binario deprecado.

**Distinción central**: `RuntimeKind:'gemini-cli'` NO era sinónimo de "spawnea el binario" — el disambiguador real siempre fue `isApiCapableModel(provider, model)` (`shared/model-capabilities.ts`), que ya distinguía `authMode:'subscription'` (CLI, `CliAgentRuntime`) de `authMode:'api-key'` (HTTP, `ApiAgentRuntime`, kind `'gemini-api'`) para el MISMO literal de `RuntimeKind`. Se retiró únicamente el camino CLI (subscription) — el camino HTTP (api-key) es un mecanismo completamente distinto (fetch directo, sin subproceso) y sigue intacto.

**Renombre**: `RuntimeKind:'gemini-cli'` → `'gemini-api'`, coincidiendo a propósito con `ApiAgentKind:'gemini-api'` (`api-agent-runtime.ts`) — mismo criterio que ya seguían `'foundry'`/`'anthropic-api'`/`'openai-chat'` (comparten literal entre los 2 tipos cuando el runtime se resuelve 100% por `ApiAgentRuntime`). `'gemini-cli'` era la única excepción a ese patrón, el "nombre histórico confuso" que el propio código ya señalaba en `ipc-agent.ts` antes de esta fase — con el CLI retirado, deja de mentir. Tocado en `shared/types.ts`, `settings-store.ts` (`runtimeFor()`, la fuente más autoritativa — corre en cada `loadSettings()`), su gemelo en `App.tsx`, `shared/model-capabilities.ts` (`isApiCapableModel()`), `settings-provisioning.ts` (los 2 builtins `authMode:'api-key'`), `explore-tool.ts`, `compaction-engine.ts`.

**Retiro del subproceso CLI** (`cli-agent-runtime.ts`): `sendGemini()`, `geminiCommand()` y la rama `gemini` de `buildEnv()` borradas enteras; `CliAgentKind` reducido a `'claude'|'antigravity'`; los 2 fallbacks implícitos que antes caían en Gemini (`send()`, `permissionArgs()`) se volvieron el fallthrough honesto de `'antigravity'` (el único kind que queda después de `claude` explícito). `ipc-agent.ts`: el branch CLI de `connectSessionForWindow()` perdió el dispatch a `detectGemini()`/`kind:'gemini'` — una conexión vieja en disco con `authMode:'subscription'` (el builtin que se retiró) ahora recibe un error explícito ("Gemini por suscripción (CLI) ya no está soportado... reconectá con una API key, o usá Antigravity") en vez de intentar spawnear algo inexistente. Mismo bloqueo incondicional agregado a `readiness()` en `App.tsx`, reemplazando el chequeo condicional de CLI instalado que ya no aplica.

**Plumbing retirado** (sin caller tras la limpieza de UI): `cli:installGemini` (`ipc-cli.ts`, handler completo — instalaba `@google/gemini-cli` vía npm), `detectGemini()` (`cli-status.ts`), `openGeminiLogin()` (`auth-manager.ts`), `installGeminiCli()`/el campo `gemini` de `getCliStatus()` (preload, ambos archivos). `openCliLogin()`/`cliInstallHint()` (`App.tsx`) angostados a `'anthropic'|'antigravity'` — ya no hay tercer caso que ramificar.

**UI** (`App.tsx`): en "Agregar conexión", el botón de suscripción (`addProvider('google','subscription')`) retirado — el de API key se queda. En la sección "CLI" (compartida entre Claude/Antigravity/Gemini desde la reintegración de claude-cli y la integración de Antigravity), el segmento de estado, los 2 botones y el hint de Gemini salieron quirúrgicamente sin tocar los de Claude/Antigravity.

**Builtin retirado** (`settings-provisioning.ts`): "Gemini Advanced (suscripción Google)" (`type:'google', authMode:'subscription'`, 3 modelos) borrado entero. Los 2 builtins `authMode:'api-key'` (con key y "pendiente") se quedan, con el literal renombrado.

**PENDING.md**: la nota del bug pre-existente de parseo `-p`/prompt-posicional cerrada como obsoleta — la función que lo tenía (`sendGemini()`) ya no existe.

### Verificación real — app corriendo, sin LLM/API key

`npm run typecheck`/`npm run build` en verde. Dev real levantado con `--inspect=9333 --remote-debugging-port=9222`, verificado vía CDP contra el proceso real (mismo patrón ya establecido en esta sesión): "Agregar conexión" real sin botón de suscripción Gemini, sección "CLI" real sin ningún rastro de Gemini (Claude/Antigravity intactos). Conexión real Gemini API key creada por click real (sin ingresar ninguna key) — el proceso MAIN real escribió a disco real `runtime:'gemini-api'` para `type:'google', authMode:'api-key'`, confirmando el renombre de punta a punta. Selectores reales de modelo de compactación/generación de imágenes siguen listando "Google · Gemini Auto" como candidato — `isApiCapableModel()` sin regresión. Conexión de prueba borrada real vía la UI al terminar (`window.confirm()` real auto-aceptado vía CDP), `settings.json` real del usuario confirmado intacto (sus 6 conexiones reales, ninguna tocada).

**Hallazgo honesto, fuera de alcance**: `providerName()` (`App.tsx`) nombra conexiones nuevas solo por `type`, sin ramificar por `authMode` — una conexión Gemini API key nueva se llama por defecto "Gemini Advanced (suscripción Google)", mismo límite pre-existente que afecta a `type:'anthropic'` (una conexión Claude API key/Azure se llama "Claude Pro (suscripción)"). No es una regresión de este retiro ni específico de Gemini — no corregido en esta fase, ver `docs/_arch/verify_gemini_cli_removal.md`.

## Fix real — HOME de Antigravity por conexión, ya no compartido entre toda la app

Basado en la carrera real confirmada en `docs/_arch/verify_antigravity_authmode_race.md` (mecanismo real reproducido — 2 conexiones distintas SÍ podían pisarse el mismo `settings.json` compartido sin ningún error ni aviso; síntoma final no confirmado ahí por un bloqueo de cuota real no relacionado). Verificación completa de este fix en `docs/_arch/verify_antigravity_home_per_connection.md`.

**Diseño**: `getAntigravityHomeDir()` (`app-paths.ts`) pasó de devolver una carpeta fija compartida (`getAppDataSubdir('antigravity-home')`) a `getAntigravityHomeDir(connectionId: string)` → `getAppDataSubdir('antigravity-home', connectionId)` — una subcarpeta distinta por conexión, bajo la misma carpeta aislada de siempre. `connectionId` es `provider.id` (`ProviderProfile.id`), único y estable por conexión real — ya existía como identificador en el resto del codebase, no un id inventado para esta fase. Las 3 funciones de `antigravity-home.ts` (`antigravityIsolatedEnv()`, `writeAntigravitySettingsForAuthMode()`, `writeAntigravityMcpConfig()`) ganan el parámetro y lo propagan; el único caller real (`cli-agent-runtime.ts`, rama `kind==='antigravity'` de `buildEnv()`) pasa `provider.id` en los 3 casos — ya estaba disponible ahí, sin threadear nada nuevo desde `ipc-agent.ts`.

`clearAntigravityHomeDir()` (garantizada al arrancar, best-effort al cerrar, `index.ts`) **no cambió de lógica**: sigue barriendo `readdirSync`+`rmSync recursive` sobre la carpeta PADRE `antigravity-home`, sin `connectionId` — como cada conexión ahora vive en su propia subcarpeta DENTRO de esa carpeta padre, el mismo barrido de siempre ya limpia TODAS las subcarpetas por conexión de una, sin ningún cambio de comportamiento necesario.

### Verificación real

`npm run typecheck`/`npm run build` en verde. Código real compilado standalone (esbuild + stub de `electron`, mismo patrón ya establecido en esta sesión), contra `D:\AMATISTA\data` real:

**Rutas reales distintas**, para los 2 `provider.id` reales de las 2 conexiones Antigravity ya existentes del usuario:
```
PATH_A: D:\AMATISTA\data\antigravity-home\qcfg-antigravity-subscription
PATH_B: D:\AMATISTA\data\antigravity-home\74884a70-86cc-435f-b3bc-fb90a7cf22a7
DISTINTAS: true
```

**Turno real completo, modelo NO-Gemini** (`--model claude-sonnet-4-6`, cuota de Gemini agotada, evitado a propósito) contra ambas conexiones reales — ambos completaron con éxito (`"OK\n"`), cada uno escribiendo en su propio `settings.json` real, en carpetas reales distintas. Dato nuevo real, no buscado: `agy` real sí soporta modelos Claude por debajo de una conexión Antigravity-subscription.

**Repetición del mecanismo real de la carrera original — ya no reproducible**: mismo ensanchamiento real (`Atomics.wait`, temporal, revertido al 100% — confirmado `grep`/`git diff --stat`), pero con **2 procesos de Node reales y separados** corriendo concurrentes de verdad (más fiel todavía al escenario de "2 paneles" que 2 promesas del mismo hilo, que `Atomics.wait` bloquearía igual). Conexión A (subscription) bloqueada 6s real dentro de `buildEnv()`; conexión B (`authMode:'api-key'` con una key sintética, nunca una credencial real) corrida en un proceso separado durante esa ventana. Resultado real: `settings.json` de A quedó exactamente `{}`, `settings.json` de B quedó exactamente `{"modelProvider":"gemini"}` — ninguno se pisó, porque son archivos reales distintos. Antes del fix, el mismo tipo de escritura cruzada real corrompía el único archivo compartido; con el fix, la colisión es estructuralmente imposible.

Estado real dejado limpio: `clearAntigravityHomeDir()` real ejecutado al terminar (mismo mecanismo garantizado de `index.ts`), confirmado que `antigravity-home` real quedó vacía.

## Fix real — `runtimeFor()` unificado en `shared/`, elimina el gap de `'openrouter'`

Basado en el Hallazgo 2 confirmado en `docs/_arch/verify_external_review_findings.md`: `settings-store.ts` (main) y `App.tsx` (renderer) tenían 2 copias casi idénticas de `runtimeFor()` — la del renderer tenía el caso explícito de `'openrouter'` (Fase 15), la de main NO, así que una conexión OpenRouter nacía con `runtime:'openai-chat'` (asignado al crearla, vía el renderer) pero se corrompía sola a `runtime:'gemini-api'` en el primer reinicio real de la app (`loadSettings()`/`migrateProvider()`, main, corre en cada arranque y reescribe el archivo). Verificación completa en `docs/_arch/verify_runtime_for_openrouter_fix.md`.

**Enfoque: unificación, no parche.** Confirmado que las 2 copias eran funciones puras `(type, authMode) → RuntimeKind`, sin ninguna dependencia de Electron/DOM/I/O ni motivo real para diferir — la divergencia fue un descuido de mantenimiento (Fase 15 agregó `openrouter` en un solo lugar), no una necesidad de diseño de las 2 mitades de la app. Mismo patrón ya establecido por `shared/model-capabilities.ts` (`isApiCapableModel()`, importada real por main Y renderer desde antes) — se creó `shared/runtime-for.ts` con una sola declaración (los 5 casos que ya compartían + `openrouter`), y las 2 copias locales se borraron enteras. `settings-store.ts` pasa a llamar `runtimeFor(base.type, base.authMode)` (antes recibía el objeto completo); `App.tsx` no tocó ni un call site — sus 4 usos ya llamaban `runtimeFor(type, authMode)` con el mismo shape de 2 argumentos que la función compartida. Ningún otro caso/`RuntimeKind` tocado.

### Verificación real — mismo escenario exacto que reprodujo el bug

`npm run typecheck`/`npm run build` en verde. App real: conexión OpenRouter real creada (`runtime:'openai-chat'` inmediato, correcto) → **reinicio real** (kill + relanzamiento del proceso Electron) → polling real del `settings.json` cada 500ms durante 10s:

```
0s:   count=7 openrouter runtime=openai-chat
...
9.5s: count=7 openrouter runtime=openai-chat
```

`runtime` se mantuvo `'openai-chat'` de forma estable — sin ninguna transición a `'gemini-api'`, mismo escenario y misma duración de observación que confirmó el bug original. Conexión de prueba borrada real vía la UI al terminar, `settings.json` real del usuario (sus 6 conexiones reales) confirmado intacto.

## Fix real — TOCTOU real de `write_file`/`apply_patch` cerrado (Hallazgo 1)

Basado en el Hallazgo 1 confirmado en `docs/_arch/verify_external_review_findings.md` y el diseño ya revisado en `docs/_arch/verify_toctou_fix_design.md`: el chequeo de staleness de `d3a8fe4` solo auditaba la ventana "entrar a `write_file`/`apply_patch` → fin de la aprobación" — si el modelo había leído el archivo turnos antes (vía `read_file`) y otra sesión/panel lo modificó en el medio, el hash tomado AL ENTRAR ya reflejaba el cambio ajeno, así que el chequeo no detectaba nada y la escritura basada en la lectura vieja pisaba el cambio en silencio, con `ok:true`. Verificación completa en `docs/_arch/verify_toctou_fix_implementation.md`.

**Diseño**: `ToolRegistry` (singleton, `runtime-state.ts`) gana `sessionFileHashes` — un `Map<string,string>` de instancia, clave `${sessionId}::${path}` (normalizado en mayúsculas en Windows, mismo criterio que `lsp-client.ts:normalizePathKey()`) → hash SHA-256 del contenido COMPLETO (`hashFileContent()`, ya existía). `sessionId` = `panelId` (nuevo campo opcional en `ExecuteContext`), poblado en `ipc-agent.ts` (`connectSessionForWindow()`, mismo punto donde ya se arma `confirm`/`resolveExploreModel`/`lspManager` para el `toolExecutor` real). `read_file` registra el hash del contenido leído (pre-`clip()`, antes de truncarlo para el modelo) ANTES de devolver el resultado. `write_file`/`apply_patch`: capturan ese hash registrado (si existe) ANTES de `resolveApproval()`, mismo criterio que el `existingHash` de `d3a8fe4` — el chequeo existente (entrar→aprobación) **queda intacto, sin ningún cambio**; se agrega un chequeo ADICIONAL justo después, comparando el contenido fresco (releído tras la aprobación) contra el hash registrado por la sesión — si no coincide, mismo mensaje de staleness ya existente. Sin registro (archivo nunca leído en esta sesión, típicamente uno nuevo) → sin chequeo adicional, comportamiento de `d3a8fe4` sin cambios, no bloquea. Tras una escritura/edición exitosa, el registro se actualiza con el hash del contenido recién escrito — la propia sesión no se autobloquea en su próxima escritura sobre el mismo archivo sin releer. Limpieza: `disconnectSession()` (`runtime-state.ts`) llama `toolRegistry.clearSessionFileHashes(panelId)`, mismo punto donde ya se llama `lspManager?.stopAll()`/`mcpManager?.stopAll()` — evita crecimiento sin límite a través de reconexiones.

**Alcance confirmado (investigación previa, `verify_toctou_fix_design.md`)**: `cli-agent-runtime.ts` nunca importa `tool-registry.ts` — claude-cli/antigravity-cli spawnean binarios reales con sus propias tools nativas de archivo, nunca pasan por este código. El fix es exclusivo de los 4 runtimes API. `run_command`/`revert_file` quedan fuera a propósito (anotado en `docs/_arch/PENDING.md` como pregunta abierta, no resuelta).

### Verificación real — los 3 casos pedidos

`npm run typecheck`/`npm run build` en verde. Código real de `ToolRegistry` (standalone, esbuild + stub de `electron`), sin mocks:

**Mismo escenario exacto que expuso el gap** (A lee real, pausa real 500ms, B escribe real, A escribe real basado en su lectura vieja):
```
Resultado real de write_file de A: {"ok":false,"output":"El archivo \"shared.txt\" cambio en disco despues de que lo leiste ..."}
Contenido REAL final en disco: "line1\nLINE2_FROM_B\n"
```
Antes: `ok:true`, línea de B destruida. Ahora: rechazado real, línea de B intacta — gap cerrado.

**Archivo nunca leído en la sesión**: escritura directa (sin `read_file` previo) `ok:true`; segunda escritura de la MISMA sesión sobre el mismo archivo (sin releer) también `ok:true` — confirma el fallback y la actualización del registro tras escribir.

**Caso feliz** (leer + escribir, sin interferencia): `ok:true`, sin regresión frente al comportamiento de siempre.

## Fix real — compactación de respaldo extendida a claude-cli/antigravity-cli (Hallazgo 3)

Basado en el Hallazgo 3 confirmado en `docs/_arch/verify_external_review_findings.md` y el diseño revisado en `docs/_arch/verify_claude_cli_compaction_design.md`: `maybeCompactChatInBackground()` solo se disparaba en el branch de runtimes API — claude-cli/antigravity-cli nunca la llamaban, ni siquiera antes del retiro/reintegración de claude-cli (confirmado con evidencia histórica real, snapshot pre-`dec378c`). Lo que `normalizeHistory()` recortaba del historial (`CONTEXT_TOKEN_BUDGET`) no tenía ningún resumen de respaldo para esos 2 runtimes. Verificación completa en `docs/_arch/verify_claude_cli_compaction_implementation.md`.

**Fricción real confirmada antes de implementar** (investigación previa): agregar la llamada al branch CLI sin más no alcanzaba — el fallback de siempre (`resolveCompactionTarget()`, sin modelo dedicado configurado) usa la MISMA conexión que originó el turno; para claude-cli/antigravity-cli (subscription, sin `apiKey` real) eso produce un `throw` real dentro de `callCompactionModel()`, atrapado en silencio por el `try/catch` de fire-and-forget — compactación que nunca compacta nada, sin ningún error visible.

**Fix, 3 piezas**:
1. `findAnyApiCapableConnection(settings)` (nueva, `compaction-engine.ts`, exportada): recorre `settings.providers` en su orden real — primera conexión `enabled`, con `apiKey` real, con al menos un modelo `enabled` que `isApiCapableModel()` ya acepte. `undefined` si ninguna sirve.
2. `resolveCompactionTarget()` gana un fallback de 2do nivel: `resolveConfiguredCompactionModel(settings) ?? (fallback de 1er nivel si tiene apiKey real) ?? findAnyApiCapableConnection(settings)` — ahora puede devolver `undefined` (antes siempre devolvía algo, aunque no sirviera). El branch API existente **no cambia de comportamiento**: su `fallbackProvider`/`fallbackModel` ya tienen `apiKey` real por construcción (es la conexión corriendo el turno), así que siempre pasa el chequeo del 1er nivel y se devuelve la misma referencia de siempre. `maybeCompactChatInBackground()` corta temprano, sin intentar la llamada, si el resultado es `undefined` — nunca finge haber compactado.
3. `ipc-agent.ts`: mismo patrón fire-and-forget del branch API agregado al branch CLI (después de `turn/completed`), `fallbackProvider`/`fallbackModel` = la conexión CLI actual, misma firma.

**Alcance explícito**: `callCompactionModel()` sin rama propia para `openai-chat` (hallazgo lateral de la investigación previa) queda **fuera de este fix a propósito** — anotado en `docs/_arch/PENDING.md` como pregunta separada.

### Verificación real — los 2 casos pedidos

`npm run typecheck`/`npm run build` en verde. Storage aislado (`AMATISTA_STORAGE_ROOT`, mismo mecanismo del harness del benchmark) — nunca toca datos reales del usuario. "Otra conexión API-capable" = un servidor HTTP real, local, controlado por el propio script de verificación (respondiendo con la forma real de la Anthropic Messages API) — nunca una credencial real de ningún servicio externo.

**Con otra conexión disponible, sin modelo dedicado configurado**:
```
[servidor local FAKE] request real #1 recibida en POST /v1/messages, body len=22358
Resumen real persistido (chat_sessions): {"summary":"Resumen real generado por el servidor local de prueba...", ...}
compactSummary inyectado en el proximo turno de claude-cli: "Resumen real generado por el servidor local de prueba, integrando el bloque nuevo."
```
La conexión claude-cli (sin `apiKey`) no podría haber generado esa request — confirma que se usó la OTRA conexión real. Resumen persistido real en `chat_sessions`, e inyectado de vuelta en el próximo turno vía `buildRuntimeContext()` **sin ningún cambio de código ahí** — confirma que el lado de lectura/inyección ya era compartido entre todos los runtimes.

**Sin ninguna otra conexión disponible**:
```
threw: false | Resumen persistido (deberia ser null): null
```
No lanza, no persiste nada — no finge haber compactado.

## Fix real — rama `openai-chat` en `callCompactionModel()`

Hallazgo lateral confirmado durante el fix anterior (`docs/_arch/verify_claude_cli_compaction_design.md`, Tarea 3) e investigado aparte (`docs/_arch/verify_compaction_openai_chat_branch.md`): `callCompactionModel()` tenía ramas explícitas para `foundry`/`gemini-api`, pero `runtime==='openai-chat'` (OpenRouter/Chat-Completions) caía en el fallback final (formato Anthropic Messages API). Reproducido real, con un servidor Chat-Completions real y local (nunca una credencial externa real): la request salía como `POST /v1/messages` con headers de Anthropic, el servidor real (que solo entiende `/v1/chat/completions`) respondía `404` real, y ese error (`"Compactacion Claude API fallo 404: ..."`, mensaje engañoso) quedaba atrapado en silencio por el `try/catch` de fire-and-forget — compactación que nunca compactaba, sin ningún aviso visible.

**Fix**: rama nueva `if (model.runtime === 'openai-chat')` en `callCompactionModel()` (`compaction-engine.ts`), mismo patrón exacto que `foundry`/`gemini-api` — valida `apiKey`/`modelId` con `throw` explícito, URL vía `openAiChatCompletionsUrl()` (ya exportada de `api-agent-runtime.ts`, recién importada acá), `fetchWithTimeout` con `Authorization: Bearer <apiKey>` real (no `x-api-key`), body real de Chat Completions (`messages: [{role:'user', content}]`, sin `tools`/`tool_choice` — la compactación nunca los necesita, mismo criterio que las otras 3 ramas), `resolveMaxOutputTokens(model.maxOutputTokens, 'openai')` (ya soportaba ese kind, sin cambios ahí), parseo con `collectText(asRecord(choices[0].message).content) || collectText(raw)`. La detección de familia `o1/o3/o4/gpt-5.x → max_completion_tokens` (`ApiAgentRuntime.openAiMaxTokensField()`, privado) se **duplicó** (2 líneas, función pura sin estado) en vez de exportarse — mismo criterio ya establecido en este codebase para no acoplar módulos por algo tan chico (`cli-agent-runtime.ts:parseDataUrl()`). Ramas de `foundry`/`gemini-api` sin ningún cambio.

### Verificación real — mismo escenario exacto que reprodujo el bug

`npm run typecheck`/`npm run build` en verde. Mismo servidor Chat-Completions real y local, mismo modelo `openai-chat` configurado como compactación dedicada, mismo backlog forzado:

```
[servidor local FAKE, emula Chat-Completions real] POST /v1/chat/completions
"POST /v1/chat/completions headers={...\"authorization\":\"Bearer FAKE-TEST-KEY-...\"...} bodyLen=22357"
Resumen persistido: {"summary":"ok","watermarkMessageId":"...","topics":{}}
```

La request ahora sale a la ruta correcta (`/v1/chat/completions`) con el header correcto (`Authorization: Bearer`, no `x-api-key`/`anthropic-version`); el servidor real responde `200`; `getChatSummaryState()` ya no es `null` — el resumen queda persistido real.

## Fix real — migración de `openai-compatible`/`openai` a `openai-chat`

Basado en `docs/_arch/verify_compatible_button_fix_options.md` y `docs/_arch/verify_compatible_migration_scope.md`: el botón "Compatible" (`type:'openai-compatible'`) ignoraba en silencio cualquier endpoint custom que el usuario cargara (`runtime:'codex-api'`, spawnea `codex app-server`, que nunca lee `provider.endpoint`). Camino 1 (config.toml de codex-cli, `model_providers.<id>.base_url`) investigado y descartado con evidencia real: existe y funciona, pero solo habla Responses API para un provider custom, nunca Chat Completions — no serviría igual para el caso de uso real de este botón. Verificación completa de la migración en `docs/_arch/verify_compatible_migration_implementation.md`.

**Pieza 1 — `runtimeFor()`** (`shared/runtime-for.ts`): `type:'openai'`/`'openai-compatible'` → `'openai-chat'` (antes `'codex-api'`). Conexiones nuevas: alcanza con este cambio (`defaultModels()` deriva el runtime una sola vez, sin rama propia para estos types). Conexiones existentes: se autocorrigen solas en el próximo reinicio real — `migrateProvider()` recalcula el `runtime` de cada modelo en cada `loadSettings()`, mismo mecanismo que ya resolvió el Hallazgo 2 de OpenRouter.

**Pieza 2 — fix bloqueante en `readiness()`** (`App.tsx`): el chequeo `!cliStatus.codex?.installed` agrupaba `'openai'`/`'openai-compatible'` junto con `'openai-codex'`, exigiendo Codex CLI instalado — correcto mientras iban por `codex-api`, pero bloquearía sin motivo real a una conexión ya migrada (HTTP directo, sin proceso externo). Sacados de ese chequeo; `'openai-codex'` (Codex real) lo sigue exigiendo sin cambios.

**Pieza 3 — `reasoning_effort` real en `sendOpenAiApi()`** (`api-agent-runtime.ts`): pérdida de funcionalidad real identificada en la investigación previa (el selector de nivel de esfuerzo, antes exclusivo de runtimes CLI vía el `--effort` de Codex, se perdía al migrar) — resuelta en la misma pasada. `ApiAgentRuntime.send()` gana `effort?: string` (los otros 3 kinds lo ignoran, mismo criterio que `antigravity` ya ignoraba `effort` en `cli-agent-runtime.ts`); `payload.effort` threadeado también hasta `apiRuntime.send()` en `ipc-agent.ts` (antes solo hasta `cliRuntime.send()`). `openAiReasoningEffort()` (nueva, privada) decide el valor real: solo para la familia reasoning de OpenAI (`o1/o3/o4/gpt-5.x`, mismo regex ya usado por `openAiMaxTokensField()`) — **`'none'` forzado EXPLÍCITO (nunca omitido) si hay tools activas** (conflicto real y documentado entre `reasoning_effort` y `tools` en la Chat Completions API: un modelo reasoning con tools no puede razonar de forma extendida sin degradar el loop agéntico, y omitir el parámetro NO es neutral — los modelos reasoning tienen un default propio distinto de "apagado", ej. `gpt-5.5` default real `"medium"`); el valor real elegido por el usuario si NO hay tools activas; omitido para modelos no-reasoning o sin selección explícita.

**Limpieza menor**: los 2 builtins de `q_config.yaml` (Groq, Local Ollama) en `settings-provisioning.ts` actualizados de `'codex-api'` a `'openai-chat'` (se autocorregían igual, ahora prolijos desde que se siembran). Panel de "Sincronizar catálogo" (`App.tsx`) ahora incluye `'openai'` además de `'openrouter'`/`'openai-compatible'` — confirmado directo, `listOpenAiChatModels()` ya era 100% genérico.

### Verificación real

`npm run typecheck`/`npm run build` en verde.

**Pieza 1**: conexión real forzada a `runtime:'codex-api'` (simulando el estado legado) → reinicio real → polling real cada 500ms, estable en `runtime:'openai-chat'` desde el primer instante. **Incidente real durante la manipulación manual, corregido de inmediato**: un comando de PowerShell escribió el archivo con BOM, rompiendo el `JSON.parse()` real del siguiente arranque — corregido, las 6 conexiones reales del usuario confirmadas intactas sin pérdida de datos.

**Pieza 2**: Codex CLI está genuinamente instalado en esta máquina — no se pudo reproducir el bloqueo real sin desinstalarlo (destructivo, no autorizado). Verificada la lógica real contra un `cliStatus` sintético, evaluada en el motor V8 real de la app vía CDP: con la lógica anterior los 3 types bloqueaban; con la actual, solo `'openai-codex'` sigue bloqueando.

**Pieza 3**: `ApiAgentRuntime` real, servidor HTTP real y local, modelo real de la familia reasoning (`gpt-5.2`). Con tools activas y `effort:'high'` elegido → `reasoning_effort:"none"` real en el body. Sin tools activas, mismo `effort:'high'` → `reasoning_effort:"high"` real en el body, sin forzar nada.

## `run_command` cerrado como no aplica al fix de TOCTOU — sin cambio de código

Investigado real (`docs/_arch/verify_run_command_revert_file_staleness.md`, Tarea 1), motivado por la pregunta abierta en `PENDING.md` desde el fix de TOCTOU original (`d3a8fe4`). El mecanismo `sessionFileHashes` (hash por sesión, `ToolRegistry`) funciona porque `write_file`/`apply_patch` reciben un path explícito + contenido completo, permitiendo saber de antemano qué archivo hashear/comparar. `run_command` (`runShellCommand()`, `tool-registry.ts`) solo recibe un string de shell opaco pasado directo a `exec()` — no hay forma confiable de derivar qué archivo(s) toca sin parsear shell arbitrario (imposible en general: pipes, subshells, glob expansion, scripts). La única forma de "extender" el mismo mecanismo sería un diff completo del árbol del workspace antes/después de cada `run_command`, que ya no es TOCTOU (prevenir una escritura basada en una creencia vieja) sino auditoría post-hoc costosa que solo podría reportar después del hecho, nunca prevenir — `exec()` ya corrió para cuando cualquier comparación fuera posible. Adicionalmente, en `workspace-write` el usuario ya ve el comando literal vía `confirm()` antes de que corra (`resolveApproval()`) — un gate de intención real, de categoría distinta a "staleness". Cerrado sin cambio de código, ver `PENDING.md` → "NO APLICA — `run_command`...".

## Fix real — staleness en `revert_file` (mismo patrón que `write_file`/`apply_patch`, sin `sessionFileHashes`)

Investigado real (`docs/_arch/verify_run_command_revert_file_staleness.md`, Tareas 2 y 3): a diferencia de `run_command`, `revert_file` sí tenía un gap real y aplicable. Comparación directa del código: `write_file`/`apply_patch` capturan un hash del contenido existente ANTES de `resolveApproval()` y, tras la aprobación, re-leen el disco real y comparan contra ese hash antes de escribir (`d3a8fe4`). `revert_file` (`tool-registry.ts`) leía `currentContent` una sola vez (para armar el diff que el usuario aprueba) y escribía directo tras `resolveApproval()`, **sin ningún re-chequeo** — si otra sesión editaba el mismo archivo real mientras la aprobación humana estaba pendiente, `revert_file` la pisaba en silencio. Se descartó que esto fuera "el propósito de la tool" (restaurar contenido viejo a propósito): eso es una cosa distinta de pisar sin avisar un cambio nuevo hecho DURANTE la ventana de aprobación — la misma clase de bug que TOCTOU ya cerró para las otras 2 tools, nunca portada a esta.

**Fix**: `hashFileContent(currentContent)` capturado en el mismo punto donde ya se leía `currentContent` (antes de `resolveApproval()`); justo antes de `writeFileSync()`, re-lectura real del disco (`existsSync`/`statSync`/`readFileSync`, mismo patrón que la del resto de la tool) + comparación de hash — si no coincide, rechaza con el mismo estilo de mensaje que `write_file`/`apply_patch` (adaptado: "volvé a llamar `list_file_history` y `revert_file` de nuevo sobre el contenido actual"). **No usa `sessionFileHashes`** (confirmado en la Tarea 3 de la investigación que no aporta nada útil en este flujo — `revert_file` se llama tras `list_file_history`, no tras `read_file`, así que rara vez habría una entrada de sesión que consultar) — mismo primitivo `hashFileContent` ya en uso, mismo criterio que el chequeo #1 (`existingHash`) de `write_file`/`apply_patch`. `write_file`/`apply_patch` sin ningún cambio.

### Verificación real

`npm run typecheck`/`npm run build` en verde. `ToolRegistry` real (bundle esbuild, sin reimplementar nada), workspace real en disco temporal, VCS oculto real (git real vía `local-vcs.ts`):

**Caso A — carrera real**: `revert_file` real sobre un archivo con 2 versiones reales en el VCS oculto (`write_file` real → `list_file_history` real → ref real de "original"), `confirm()` pausado 300ms simulando aprobación humana lenta. Mientras la aprobación está pendiente, otra llamada real a `write_file` (simulando "otra sesión") escribe el archivo real. Resultado real:
```
Resultado real de revert_file: {"ok":false,"output":"El archivo \"nota.txt\" cambio en disco despues de que se genero la vista previa de esta restauracion (probablemente otra sesion/panel lo edito mientras tanto) -- volve a llamar list_file_history y revert_file de nuevo sobre el contenido actual."}
Contenido REAL final en disco: "version 3 (de OTRA sesion, durante la aprobacion pendiente)"
```
Confirmado: `revert_file` rechazado por staleness (no pisó a ciegas), el cambio de la otra sesión sobrevivió intacto en disco.

**Caso B — caso feliz, sin interferencia**: mismo flujo real, sin ninguna escritura concurrente durante la aprobación. Resultado real:
```
Resultado real de revert_file: {"ok":true,"output":"Archivo restaurado: nota.txt (version 8f2960ce9c7821ed7d3215cf85525b9268647135)"}
Contenido REAL final en disco: "version 1 (original)"
```
Confirmado: `revert_file` sigue funcionando exactamente igual que antes cuando no hay interferencia real.

## Fix real — `disconnectAllPanels()` acotado al proveedor/modelo afectado (Fase 22c)

Investigado real en 2 pasadas (`docs/_arch/verify_fase22c_disconnect_scope_2026.md`, sobre la base confirmada obsoleta de `verify_fase22_scope.md` § A.1): con la arquitectura de sesiones-por-panel ya vigente (`ChatPanel` por instancia, `sessionRegistry` por `panelId` en main), solo quedan **5 sitios reales** de `disconnect()` en `App.tsx` (no los 13/18 del análisis viejo). 3 de ellos (`selectProvider`/`selectModel`/`<select sandbox>`) ya eran (a) reales acotados por construcción (`api` bindeado al `panelId` de esa instancia). El `useEffect` por `chatId` sigue siendo necesario — `SessionRuntimeState.provider`/`.model` se resuelven una sola vez en `agent:connect`, así que cambiar de chat DENTRO del mismo panel sin desconectar dejaría la sesión hablando con el proveedor/workspace del chat viejo — pero sigue acotado a ese único panel, sin tocar a otros.

El gap real estaba en el mecanismo consolidado `catalogChangeNonce`/`disconnectAllPanels()` (Paneles-2b): el propio comentario del código lo confirmaba explícito — "broadcast crudo-pero-seguro... CADA panel abierto reacciona desconectandose" — indiscriminado por diseño, sin importar que la mayoría de sus 11 call sites reales eran (a) genuinos (solo un proveedor/modelo puntual cambió). La pieza para acotarlo ya existía parcialmente: `SessionRuntimeState` guarda `provider`/`model` por sesión desde Fase 22c anterior, y `cross-window-messaging.ts` ya tenía el patrón exacto de filtrar `sessionRegistry` por un campo (`findConnectedPanelForChat()`) — pero del lado del RENDERER, que es donde realmente hacía falta la información (el estado de UI a resetear — `agentState`/`agentRuntime`/`agentError` — vive solo ahí), el campo estable y ya disponible sin ningún viaje a main es `activeChat.providerId` (el mismo que `deleteProvider()` ya usaba para su propio conteo de chats afectados).

**Fix**: `catalogChangeNonce: number` → `catalogChangeSignal: { seq: number; providerId: string | null }` (mismo `useState`, shape ampliado — no un estado paralelo nuevo). `disconnectAllPanels(providerId: string | null = null)` gana el parámetro; el `useEffect` consumidor (`ChatPanel`) gana un guard antes de actuar: `if (catalogChangeSignal.providerId !== null && catalogChangeSignal.providerId !== activeChat.providerId) return`. Comparación deliberada contra `activeChat.providerId` (campo persistido y estable del chat) y NO contra `activeProvider?.id` (un `useMemo` derivado de `settings` que, para cuando el efecto corre, ya puede reflejar el fallback POST-cambio — ej. tras `deleteProvider()` — dando un falso negativo). El efecto de aviso de proveedor huérfano (línea contigua) solo renombra su dependencia, su lógica interna no cambia — la carrera de orden ya documentada (debe correr DESPUÉS del efecto de desconexión) sigue aplicando igual para los paneles realmente afectados.

Los 11 call sites reales pasan el `providerId` que ya tenían en scope sin buscarlo: `addProvider`/`addDeepSeekProvider` (`provider.id` recién creado), `deleteProvider`/`toggleProvider`/`deleteModel`/`toggleModel` (su propio parámetro), `syncCodexModels` (`provider.id` ya resuelto), botón "Guardar" de edición de conexión (`provider.id`) — todos ahora acotados. `logoutCodex`/`importQConfig` pasan `null` explícito (genuinamente globales — cuenta OAuth compartida / reemplazo total de settings — sin cambio de comportamiento). `removeProjectRoot` también pasa `null` explícito, mencionado en el propio código como **fuera de alcance de este fix**: su dimensión real de filtro es workspace/root, no `providerId` — queda con el comportamiento amplio de siempre, sin regresión, sin resolverse acá.

### Verificación real

`npm run typecheck`/`npm run build` en verde. Con la app real corriendo (CDP contra el proceso Electron real, `--remote-debugging-port`), 2 paneles reales conectados a proveedores DISTINTOS, sin ninguna API key manipulada (ambos por suscripción real ya logueada):

```
ANTES:
Panel 1 -- Agente · antigravity
Panel 2 -- Agente · claude

[accion real de configuracion: "Guardar" en la conexion Anthropic real que usa el Panel 2]

DESPUES:
Panel 1 -- Agente · antigravity   (SIN CAMBIOS, sigue conectado)
Panel 2 -- Agente sin iniciar     (desconectado real, boton "Conectar agente" visible)
```

Confirmado real: el panel que usaba el proveedor editado se desconectó; el panel con un proveedor distinto (Antigravity) permaneció conectado sin ninguna interrupción — exactamente el comportamiento acotado del fix. `settings.providers` confirmado sin cambios reales de datos tras el "Guardar" (mismo nombre/authMode, solo se re-guardó lo mismo que ya había — el objetivo era disparar `disconnectAllPanels(provider.id)`, no cambiar la conexión). Entorno de prueba (panel agregado + proceso `electron-vite dev` lanzado para esta verificación) cerrado y limpiado al terminar.

**Caso global — verificado por equivalencia real de código, no por acción en vivo**: `logoutCodex()`/`importQConfig()` (los únicos 2 call sites reales que siguen pasando `providerId: null` con un efecto colateral real irreversible por automatización — logout de la cuenta ChatGPT real requeriría relogin manual del usuario; import necesita un archivo `q_config.yaml` real vía diálogo nativo, no accionable por CDP) se evitaron a propósito para no alterar el login real del usuario ni requerirle una acción manual después. En su lugar, se confirma por inspección directa del código que el guard nuevo es un no-op exacto cuando `providerId === null`: la condición `catalogChangeSignal.providerId !== null && ...` es `false` de plano, sin evaluar el segundo operando, así que la función ejecuta las mismas 4 líneas (`setAgentState`/`setAgentRuntime`/`setAgentError`/`disconnect()`) que ejecutaba ANTES del fix, sin ninguna rama nueva — no es una inferencia, es el mismo código que ya se verificó en el caso acotado de arriba (el mismo `useEffect`), simplemente sin el `return` temprano. `removeProjectRoot` igual, mismo argumento.

Archivos modificados: `src/renderer/src/App.tsx` únicamente — sin tocar `sessionRegistry` ni ningún archivo de main, confirmado innecesario en la investigación previa.

## Fix real — resumen de respaldo para reconexión de Codex

Investigado real (`docs/_arch/verify_codex_compaction_need.md`), motivado por la pregunta sin evaluar desde el cierre de Fase 3 (`PENDING.md`). 3 hallazgos reales: (1) Codex nunca estuvo en el branch CLI extendido con compactación de respaldo en `f54cda8` — `runTurnForWindow()` (`ipc-agent.ts`) resuelve `activeRuntime==='codex'` en su propia rama con `return` temprano, antes de llegar tanto al branch API como al branch CLI (`session.cliRuntime`); Codex usa `session.codexClient` (`CodexClient`, JSON-RPC), estructuralmente distinto. (2) Codex SÍ tiene un límite real de contexto (272 000 tokens para `gpt-5.x`, confirmado con `codex debug models` real) y **su propia compactación automática nativa**, ya activa por default del lado del `app-server` real (`model_auto_compact_token_limit`, ítems `contextCompaction` reales en el protocolo JSON-RPC) — confirmada empíricamente con una conversación real de 6 turnos (ventana forzada a 3000 tokens vía `-c` para no gastar cuota real de más): 5 compactaciones automáticas reales, coherencia preservada las 6 veces — nada que hacer ahí, ya resuelto del lado del binario. (3) El único gap real: como `maybeCompactChatInBackground()` nunca se disparaba para turnos de Codex, un chat 100% Codex nunca generaba el resumen de respaldo que sí tienen claude-cli/antigravity-cli/API desde `f54cda8` — al reconectar (thread NUEVO, `ephemeral:true`, sin nada de la memoria en proceso del thread viejo), lo único disponible era el recorte duro de `normalizeHistory()`, sin ningún resumen de respaldo.

**Fix**: mismo patrón fire-and-forget de una línea que ya tienen los branches API y CLI — `void maybeCompactChatInBackground({chatId: requestChatId, settings, fallbackProvider: provider, fallbackModel: model})` agregado al branch de Codex en `runTurnForWindow()` (`ipc-agent.ts`), justo antes del `return` que ya existía (después de `session.activeContextSeeded = true`). `resolveCompactionTarget()`/`findAnyApiCapableConnection()` (ya construidos en `f54cda8`) cubren el caso sin modelo dedicado configurado exactamente igual que para claude-cli/antigravity-cli — `codex-subscription` es `subscription`/sin `apiKey`/no api-capable, mismo shape que esas 2 conexiones desde la perspectiva de `resolveCompactionTarget()`. **No toca la compactación nativa de Codex** (`thread/compact/start` sigue corriendo sola, sin relación con esto) ni el thread vivo — el fix es exclusivamente para el momento de reconexión.

**Corrección colateral**: la entrada de `PENDING.md` (Fase 3) decía que Codex "depende de `--resume <sessionId>`" — corregida con lo confirmado en la investigación: `ephemeral:true` (`codex-client.ts:113`), nunca `--resume`/persistencia a disco.

### Verificación real

`npm run typecheck`/`npm run build` en verde — confirmado además que el bundle compilado (`out/main/index.js`) pasó de 2 a 3 call sites reales de `maybeCompactChatInBackground()` (import + 3 llamadas). Misma metodología exacta ya usada para el fix análogo de claude-cli/antigravity-cli (`verify_claude_cli_compaction_implementation.md`): storage aislado real (`AMATISTA_STORAGE_ROOT`), chat-store real (SQLite real), servidor HTTP local real como "otra conexión API-capable" (nunca una credencial real externa), `fallbackProvider`/`fallbackModel` con la misma forma real que ve `resolveCompactionTarget()` para una conexión `codex-subscription` real (`type:'openai-codex'`, `authMode:'subscription'`, sin `apiKey`).

Chat 100% Codex, backlog real > 6000 tokens (8 mensajes reales, ~5000 caracteres cada uno), sin modelo de compactación dedicado configurado:
```
[servidor local FAKE] request real #1 recibida en POST /v1/messages, body len=22358
Resumen real persistido (chat_sessions) para el chat 100% Codex: {"summary":"Resumen real generado...", "watermarkMessageId":"...", "topics":{...}}
compactSummary que veria el thread NUEVO de Codex al reconectar: "Resumen real generado por el servidor local de prueba (reconexion de Codex)."

RESULTADO -- uso la otra conexion (fallback de 2do nivel): true
RESULTADO -- resumen real persistido para un chat 100% Codex (antes del fix: siempre null): true
RESULTADO -- llega al contexto de un reconnect posterior (thread nuevo): true
```
Confirmado real: antes del fix, `getChatSummaryState()` para un chat 100% Codex era siempre `null` (nunca se disparaba la compactación); con el fix, se persiste un resumen real vía el fallback de 2do nivel, y ese mismo resumen es lo que `buildRuntimeContext()` — la función real que arma el `seedContext` de un reconnect — inyectaría en el primer turno de un thread nuevo de Codex.

## Fix real — `sessionRegistry` deja de crecer sin límite al cerrar un panel

Investigado real en 2 pasadas (`docs/_arch/verify_sessionregistry_leak_2026.md`), sobre una nota de `PENDING.md` cuyo disparador citado ("cerrar una ventana", vía `window.on('closed', ...)` en `window-manager.ts`) se confirmó obsoleto — ese handler ya no existe, `window-manager.ts` documenta su propio retiro (Paneles-1: una única ventana física siempre, `registerWindow()`/`windowRegistry` reemplazados por `setMainWindow()`). El leak en sí (`disconnectSession()` nunca hace `sessionRegistry.delete()`, solo vacía los campos de la entrada) seguía siendo real — confirmado con grep, cero resultados de `.delete()`/`.clear()` sobre `sessionRegistry` en todo `src/main/`. El disparador real hoy es **cerrar un panel** (`closePanel()` → `agent:disconnect`), mucho más frecuente que "cerrar una ventana".

**Confirmación previa a implementar, crítica para el diseño**: tocar `disconnectSession()` directamente (compartida por 4 call sites reales) hubiera roto 2 de ellos — `ipc-projects-workspace.ts` (`workspace:open` y `projects:removeRoot`) capturan una referencia local a `session` (vía `getSession()` o el propio `for...of sessionRegistry`) ANTES de llamar `disconnectSession(panelId)`, y siguen mutando esa misma referencia DESPUÉS (`session.activeWorkspace = ...`) esperando que sea el objeto vivo del Map — un `delete()` ahí dejaría esa escritura en un objeto huérfano, sin efecto real sobre la próxima sesión (bug real en `workspace:open`, inofensivo solo por coincidencia en `projects:removeRoot`). Tampoco alcanzaba con asumir que `agent:disconnect` siempre significa "cierre genuino": el mismo canal IPC lo dispara `disconnect()` en `ChatPanel`, usado por 4 de los 5 disparadores reales (cambio de `chatId`/`catalogChangeSignal`/`selectProvider`/`selectModel`/sandbox) — en todos esos, el panel sigue vivo y reconecta enseguida.

**Fix**: `agent:disconnect` gana `payload.panelClosing?: boolean` — `disconnectSession()` en sí no se toca, sigue llamándose exactamente igual. El handler (`ipc-agent.ts`) agrega `sessionRegistry.delete(payload.panelId)` DESPUÉS de `disconnectSession()`, solo si `panelClosing===true`. `closePanel()` (`App.tsx`, el único call site real de cierre genuino — `deleteChat()` lo reusa vía `closePanel()`) manda `disconnectAgent(true)`; los otros 3 call sites reales de `disconnectAgent()` (todos dentro de `disconnect()` en `ChatPanel`) no pasan el campo, sin cambio de comportamiento. `preload/index.ts`/`index.d.ts` actualizados con la firma opcional.

### Verificación real

`npm run typecheck`/`npm run build` en verde. Con la app real corriendo (CDP) e instrumentación temporal (`debug:sessionRegistrySize`) agregada solo para leer `sessionRegistry.size` del proceso main durante la prueba — **revertida al 100% al terminar** (confirmado con grep, cero resultados, y `git diff --stat` mostrando solo los 4 archivos del fix real):

**Caso A — cierre genuino**:
```
size antes de abrir el panel 2:      2
size tras abrir el panel 2:          3
size tras conectar el panel 2:       3   (Agente · claude)
[cierre real via closePanel(), boton × real]
size tras cerrar el panel 2:         2   (bajo en 1 -- la entrada desaparecio del Map)
```

**Caso B — no regresión (cambio de proveedor en un panel que sigue abierto)**:
```
size antes del cambio de proveedor:                          2
[cambio real: Anthropic -> Antigravity, via selectModel() real]
size inmediatamente despues (disconnect() sin panelClosing):  2   (sin cambios)
[reconexion real: "Conectar agente"]
estado tras reconectar:                                       "Agente · antigravity" (real, sin errores)
size final:                                                   2   (sin cambios en todo el ciclo)
```

Logs del proceso dev revisados, sin ningún `error`/`exception`/`unhandled` nuevo durante toda la secuencia. Confirmado: el cierre genuino de un panel elimina su entrada real de `sessionRegistry`; los otros 4 disparadores (identidad de chat/config/proveedor/modelo/sandbox) no tocan el `Map` en absoluto, y la reconexión sigue funcionando exactamente igual que antes.

## Fix real — LSP para C/C++ vía clangd (5to lenguaje, `PENDING.md` "LSP para C, Java y C++")

Investigado real (`docs/_arch/verify_clangd_integration_scope.md`) y confirmado: `LspClient`/`LspManager` son genéricos por diseño — el propio comentario de `LspClient.start()` ya decía *"esta clase no sabe nada de TypeScript/Python/Rust/Go en si misma, solo habla el protocolo generico"* — agregar un lenguaje nuevo es una entrada más en `LANGUAGE_SERVERS` (`lsp-client.ts`), sin tocar ninguna de las 2 clases.

**Entrada nueva**: `resolveClangdEntry()` (mismo patrón de 2 niveles exacto que `resolveRustAnalyzerEntry()`/`resolveGoplsEntry()` — PATH primero vía `respondsToVersion('clangd', ['--version'])`, fallback a `C:\Program Files\LLVM\bin\clangd.exe`, la ruta real y estable del instalador oficial de LLVM en Windows, mismo criterio que `GO_INSTALL_DIR`). `kind:'native'`, `args:[]` — confirmado real (handshake LSP completo contra el binario 22.1.1) que clangd también usa stdio por defecto, sin ningún flag de transporte, mismo shape que Rust/Go. Confirmado además con `npm view`/`npm pack` que el paquete npm `clangd` (real, mantenido por los propios devs de LLVM) es un placeholder de 391 bytes sin binario — misma categoría exacta que el "security holding package" ya confirmado para `gopls`, nunca bundleable.

**Hallazgo real no anticipado, decisivo para el diseño**: `languageId:'cpp'` cubre TODAS las extensiones de la entrada (`.c`/`.h`/`.cpp`/`.cc`/`.cxx`/`.hpp`/`.hh`/`.hxx`) a propósito, sin el caso especial que sí necesita TypeScript (`.tsx` → `typescriptreact` en `languageIdFor()`). Confirmado real con un mismatch deliberado contra el binario real (un `.c` con contenido C real, pero `languageId:'cpp'` declarado en `didOpen`): clangd **igual lo trató como C** (indexó la libc de C, rechazó un `#include<string>` real de C++ con un error real de STL) — la decisión de C vs C++ la toma el propio driver interno de clang en base a la EXTENSIÓN real del archivo, nunca por el `languageId` que el cliente LSP declara. Confirmado también, con un `.c` y un `.cpp` reales abiertos en el MISMO proceso simultáneamente, que un solo clangd sirve ambos lenguajes sin ninguna confusión cruzada (indexó "c17 standard library" para uno y "c++14 standard library" para el otro, diagnósticos reales correctos y distintos para cada uno).

**Limitación conocida documentada, no un bug**: sin un `compile_commands.json` real en el workspace, clangd cae a un comando de fallback razonable (confirmado real en los logs: `clang -resource-dir=<interno> -- archivo.c`, sin las flags/includes reales de un build system) — funciona bien para diagnósticos de sintaxis básicos (confirmado real, ver verificación abajo), pero con menos precisión en proyectos con dependencias externas reales. Comportamiento esperado y documentado de clangd mismo, no un defecto de esta integración — mismo alcance que Rust/Go (diagnósticos vía LSP estándar, no un IDE C/C++ completo).

**Limpieza menor**: las descriptions de `get_diagnostics`/`find_definition`/`find_references` (`tool-registry.ts`) actualizadas para mencionar `.c/.h/.cpp/.cc/.cxx/.hpp/.hh/.hxx` (C/C++, vía clangd) junto a los 4 lenguajes ya existentes — texto plano que el modelo lee, sin ningún cambio de lógica. `list_symbols` no menciona extensiones explícitas, sin cambios.

### Verificación real

`npm run typecheck`/`npm run build` en verde. `ToolRegistry`/`LspManager` reales (bundle esbuild, sin reimplementar nada), binario real de clangd 22.1.1 (obtenido de forma aislada, PATH del proceso de verificación ampliado — nunca instalado en el sistema real del usuario), workspace real con un `.c` y un `.cpp` reales (cada uno con una función real y un error real deliberado):

```
=== C (test.c) ===
find_definition -- test.c:1:5   (definicion real de add())
find_references -- test.c:1:5, test.c:6:18   (definicion + uso real)
list_symbols    -- Function add, Function main
get_diagnostics -- error [7:18] expected_expression: Expected expression   (el error real puesto a proposito)

=== C++ (test.cpp) ===
find_definition -- test.cpp:3:13   (definicion real de greet())
find_references -- test.cpp:3:13, test.cpp:8:27
list_symbols    -- Function greet, Function main
get_diagnostics -- sin errores ni warnings   (codigo C++ real y valido)
```

**No regresión confirmada, mismo turno de verificación**: Python (ya existente, sin tocar) — `find_definition`/`find_references`/`list_symbols` reales y correctos sobre `test.py`; `get_diagnostics` (probado aparte, aislado, tras un hallazgo real del propio harness de verificación — ver nota abajo) reportó el error real puesto a propósito: `Type "Literal['no es un int']" is not assignable to declared type "int"`.

**Nota honesta sobre el proceso de verificación**: un intento inicial de probar `get_diagnostics` para C/C++/Python juntos (3 `write_file()` fire-and-forget casi simultáneos en el mismo tick, dentro del proceso standalone del harness, fuera de Electron real) hizo fallar la resolución de pyright para Python — reproducido 2 veces. Aislado (Python solo, mismo patrón `write_file`→`get_diagnostics`) funcionó perfecto a la primera. Confirmado que es un artefacto de concurrencia del harness de verificación (3 resoluciones de entry point casi simultáneas en un proceso Node plano fuera de Electron, nunca así en producción real, donde cada `write_file` viene de un turno secuencial real del modelo) — no una regresión real de Python ni relacionada con el fix de clangd (`resolveBundledServerEntry()`, sin ningún cambio). Reportado explícito en vez de ocultado, mismo criterio de transparencia de toda esta bitácora.

## Fix real — LANGUAGE_SERVERS rediseñado config-driven + LSP para Java vía jdtls (7mo lenguaje, los 7 de SWE-Bench ProMax completos)

Investigado en 2 pasadas reales (`docs/_arch/verify_jdtls_integration_scope.md`, `docs/_arch/verify_lsp_config_redesign.md`) y confirmado contra el **código fuente real de OpenCode** (`github.com/sst/opencode`) antes de implementar: jdtls rompía las 3 asunciones del `LANGUAGE_SERVERS` de ayer (`kind:'node'|'native'`, `resolveEntry()` de un solo string, `args` estático) — en vez de agregar un 3er `kind` ad-hoc, se rediseñó el mecanismo entero hacia una forma final única y config-driven.

### Pieza 1 — forma de salida común

`LanguageServerConfig` (`lsp-client.ts`) colapsa `kind`/`resolveEntry`/`args`/`extraPathDirs` en un solo `resolveCommand(workspace): Promise<{command: string[], env?: Record<string,string>} | null>` — la forma YA resuelta y lista para spawnear. `LspClient.start()` se simplifica a un único `spawn(command[0], command.slice(1), {env, cwd})`, sin ningún `if` por tipo de servidor. Los 5 `resolveXEntry()` existentes (TypeScript/Python/Rust/Go/clangd) **no se tocan por dentro** — se envuelven en funciones `xResolveCommand()` nuevas que arman `{command, env?}`: TypeScript/Python arman `[process.execPath, entry, '--stdio']` con `env:{ELECTRON_RUN_AS_NODE:'1'}` (calculado por Amatista, nunca expuesto al usuario); Go pliega su `extraPathDirs` de antes directo en `env.PATH`; Rust/clangd quedan `{command:[entry]}` sin más.

### Pieza 2 — `jdtlsResolveCommand()`, mismo patrón que confirmó OpenCode

Confirmado con el código fuente real de OpenCode (`packages/opencode/src/lsp/server.ts`) que su propio built-in de jdtls resuelve exactamente los mismos 3 puntos duros, del mismo modo, **sin ningún wrapper script** — todo en una función real: descarga el mismo tarball oficial, resuelve el jar del launcher con el MISMO regex (`/^org\.eclipse\.equinox\.launcher_.*\.jar$/`), usa un directorio de datos único, y valida Java real antes de arrancar. Implementación real en Amatista: `jdtlsHomeCandidate()` (override `JDTLS_HOME`, o convención propia bajo `getAppDataSubdir('jdtls')` — sin instalador oficial con ruta conocida en Windows, a diferencia de LLVM/Go), `resolveEquinoxLauncherJar()` (glob real sobre `plugins/`), `jdtlsConfigDir()` (`config_win`/`config_linux[_arm]`/`config_mac[_arm]`), `jdtlsDataDir()` (`-data` ESTABLE por workspace, hash sha256 bajo `getAppDataSubdir('jdtls-data', hash)` — a diferencia del `fs.mkdtemp()` de OpenCode, reusar el mismo directorio entre turnos de la misma sesión evita re-indexar el proyecto en cada reconexión), `resolveJavaRuntime()` (JAVA_HOME primero si es real, si no PATH; parsea `java -version` real de stderr), y la construcción final del comando con los 2 flags condicionales (`-Djdk.xml.*EntitySizeLimit=0`) solo si Java ≥24.

### Pieza 3 — archivo de config nuevo

`D:\AMATISTA\data\config\lsp.json` (global, mismo directorio que `settings.json`) + `.lsp.json` opcional en la raíz del workspace (mismo criterio que `.mcp.json`) — cada clave es un `languageId`, con `{command: string[], extensions: string[], env?, disabled?}` siempre estático (confirmado real contra el código de OpenCode: el usuario nunca escribe algo dinámico a mano). Merge por CLAVE, no por archivo completo (mismo principio que confirmó la documentación real de OpenCode — "later configs override earlier ones only for conflicting keys"): built-in primero, `lsp.json` global pisa por clave, `.lsp.json` del workspace pisa a los 2 anteriores. `disabled:true` apaga cualquier entrada (built-in o de un nivel anterior). Cache real por archivo (mtime), sin necesitar reiniciar la app para que una edición se note.

### Pieza 4 — `LspClient`/`LspManager`

Confirmado sin fricción: ambos ya eran genéricos (protocolo LSP puro, sin saber nada de lenguajes específicos). Único ajuste real: los 8 call sites de `languageServerConfigFor(absolutePath)` en `lsp-manager.ts` pasan ahora `this.workspace` como segundo argumento (para que el override de `.lsp.json` aplique donde importa: routing y arranque real de clientes) — `languageIdFor()` (usado solo para el campo cosmético `languageId` de `didOpen`) sigue sin `workspace`, edge case sin impacto funcional real.

### Verificación real

`npm run typecheck`/`npm run build` (con `mcp:lsp:bundle`) en verde. `ToolRegistry`/`LspManager` reales, storage root AISLADO (nunca toca `D:\AMATISTA\data` real), jdtls real (mismo tarball oficial de ayer, extraído en la convención nueva `<storage>/jdtls`), clangd real (binario aislado, PATH del proceso ampliado), y un lenguaje CUSTOM real (mini language server propio, protocolo LSP real vía stdio) agregado a mano en `lsp.json`:

```
=== CASO 1 -- Java real via jdtls ===
find_definition (add):   Main.java:8:16   (definicion real)
find_references (add):   Main.java:3:22, Main.java:8:16
list_symbols:            Method main, Method add, Class Main
get_diagnostics (aislado, 15s de espera real -- JVM/jdtls arrancan mas
  lento que los otros 5):
  error [5:20] Syntax error on token "=", VariableInitializer expected after this token
  (el error real puesto a proposito, "int broken = ;")

=== CASO 2a -- no regresion, Python (Node), aislado ===
get_diagnostics: error [7:19] reportAssignmentType: Type "Literal['no es un int']" ...
find_definition: test.py:1:5

=== CASO 2b -- no regresion, C (binario nativo, clangd) ===
get_diagnostics: error [7:18] expected_expression: Expected expression
find_definition: test.c:1:5

=== CASO 3 -- lenguaje custom agregado a mano en lsp.json ===
get_diagnostics: warning [1:1]: diagnostico real fijo del custom-lsp-server de prueba
```

**Nota honesta**: en el primer intento combinado (los 4 casos en un solo proceso, `get_diagnostics` de Java con solo 1.5s de espera), Java devolvió "no fue tocado" — no es un bug: `get_diagnostics` es deliberadamente no-bloqueante (`notifyFileWritten()` es fire-and-forget, `getDiagnostics()` no espera a que el cliente termine de arrancar, ver comentario real en `lsp-manager.ts`), y jdtls (JVM + OSGi) arranca genuinamente más lento que los otros 5 — confirmado real aislando el caso con 15s de espera. Python también fallo en ese mismo intento combinado (mismo artefacto de concurrencia del harness ya documentado arriba para el fix de clangd) — aislado, funcionó perfecto. Ninguno de los 2 es una regresión real; ambos son características de timing del harness sintético, no de la implementación real.

Archivos modificados: `src/main/lsp-client.ts`, `src/main/lsp-manager.ts`. `tool-registry.ts` sin cambios (ya usaba `languageServerConfigFor()` sin conocer su forma interna).

## Fix real — web_search/web_fetch reales vía Tavily

Basado en `docs/_arch/verify_web_search_design.md` (investigación previa: registro de tools, precedente parcial de `generate_image` — reusa un provider de modelo existente, no aplica directo a Tavily porque no es un LLM —, y confirmado que `AppSettings` no tenía ningún slot de credencial no-provider). Implementado tal cual el diseño confirmado, sin desviaciones:

**Credencial**: `AppSettings.integrations.tavily.apiKey` — primer campo top-level de `AppSettings` que NO es una referencia a un provider de modelo, sección separada a propósito. Mismo mecanismo de cifrado exacto que ya usa `provider.apiKey` (`encryptSecret`/`decryptSecret`, `settings-store.ts`, wrapper puro sobre `safeStorage`), sin ninguna crypto nueva — 2 puntos nuevos en `loadSettings()`/`saveSettings()`, misma forma que cualquier otro campo cifrado. UI: sección nueva "Búsqueda web (Tavily)" en Settings, patrón de estado local + botón "Guardar" (staged, como `editForm` de conexiones) en vez de guardado inmediato por keystroke — decisión deliberada: un campo de texto libre para credencial no debe persistir a disco en cada tecla.

**Tools nuevas**: `web_search(query, max_results?)` → `POST https://api.tavily.com/search`; `web_fetch(url)` → `POST https://api.tavily.com/extract`, `body:{urls:[url], format:'markdown'}`. Módulo nuevo y aislado `src/main/web-search.ts` (paralelo a `compaction-engine.ts`/`image-generation.ts`, sin compartir funciones — mismo criterio ya establecido de no acoplar features independientes). Registro uniforme: 2 entradas en `TOOL_DEFINITIONS` + 2 `case` en `ToolRegistry.execute()` (`tool-registry.ts`), sin ningún otro punto de registro — mismo mecanismo que cualquier otra tool. `ExecuteContext` extendido con `webSearch?`/`webFetch?` (closures inyectadas por `ipc-agent.ts` sobre el binding vivo de `settings`, mismo patrón que `generateImage?`).

**Gating real**: `hasWebSearchIntegration?: boolean` nuevo en la config de `ApiAgentRuntime`, calculado en `ipc-agent.ts` vía `hasTavilyIntegration(settings)` en cada `runtime.configure()`. `toolCatalog()` (`api-agent-runtime.ts`) filtra `web_search`/`web_fetch` con el mismo patrón exacto que `orchestratorToolNames`/`hideOrchestratorTools` (`webSearchToolNames`/`hideWebSearchTools`) — sin key configurada, las 2 tools ni aparecen en el catálogo que se manda al modelo, nunca se le ofrece algo que de todos modos fallaría. Solo cablea a través de `api-agent-runtime.ts` (los 4 runtimes API); `TOOL_DEFINITIONS` sigue sin importarse en `cli-agent-runtime.ts`, confirmado con grep — CLI (claude-cli/antigravity-cli/codex) nunca ve estas 2 tools por este camino.

**Aprobación incondicional**: mismo precedente exacto que `generate_image` — `ctx.confirm()` llamado directo en el `case`, ignorando `resolveApproval()`/sandbox mode por completo. Justificación idéntica: esto gasta dinero/cuota real de un servicio externo, el sandbox mode (seguridad de archivos/workspace local) no decide si conviene gastar dinero.

## Fix real — `workspace/configuration` + pull-diagnostics en `LspClient`, desbloqueando YAML/ESLint/Bash + Terraform/Lua nuevos (12 lenguajes LSP en total)

Basado en `docs/_arch/verify_lsp_pull_config_support.md` + `docs/_arch/verify_lsp_pull_config_implementation_design.md`, ambos con evidencia real reunida ANTES de implementar (mismo criterio de esta bitácora). Implementado tal cual el diseño confirmado, en 5 piezas:

**Pieza 1 — dispatch nuevo en `LspClient.handleChunk()`**: un mensaje con `method` Y `id` a la vez (request SERVIDOR→cliente, ej. `workspace/configuration`) antes se descartaba en silencio — `LspFramer` (genérico, sin cambios) lo parseaba bien, pero ninguna rama de `handleChunk()` lo contestaba, dejando al servidor esperando una respuesta que nunca llegaba. Rama nueva: `workspace/configuration` responde vía `buildConfigurationResponse()` (array de la misma longitud que `params.items`, correspondido posicionalmente, `config.configResponses?.[item.section] ?? null` por cada uno — confirmado real que `items[]` puede traer de 1 a N elementos en una sola request); cualquier otro request servidor→cliente no reconocido responde `null` genérico — primitivo nuevo `respond(id, result)`, distinto de `request()` (arma requests propios) y `notify()` (nunca lleva `id`).

**Pieza 2 — capabilities ampliadas en `initialize()`**: se agregó `workspace.configuration:true` y `textDocument.diagnostic` (pull LSP 3.17) a las capabilities antes deliberadamente mínimas (Fase 20, solo `publishDiagnostics`). Confirmado real que los 6 servidores existentes (TypeScript/Python/Rust/Go/clangd/jdtls) nunca piden ninguna de las 2 cosas — anunciar que las soportamos no les cambia nada.

**Pieza 3 — `configResponses` en el esquema**: campo nuevo `configResponses?: Record<string, unknown>` en `LanguageServerConfig` (built-ins, código) Y en `CustomLspEntry` (`lsp.json`/`.lsp.json`, mismo patrón de reemplazo total por clave que ya usa el mecanismo) — mismo shape en ambos niveles, JSON-compatible, nunca una función (confirmado en la investigación previa que el valor real que necesita ESLint es 100% estático). `ESLINT_CONFIG_RESPONSE` (objeto real confirmado con evidencia, ver Verificación real) va bajo `section:''` — así es como `eslint-language-server` pide su config real.

**Pieza 4 — `pullDiagnostics()` nuevo**: `LspManager.diagnosticsFromClient()` decide UNA vez por cliente si usa pull (`client.supportsCapability('diagnosticProvider')`, mismo mecanismo genérico ya existente, capability nueva a consultar) o sigue con el push pasivo de siempre (`waitForFreshDiagnostics()`, sin ningún cambio). Camino pull: `LspClient.pullDiagnostics()` hace un `textDocument/diagnostic` real y escribe en el MISMO cache (`this.diagnostics`) con el MISMO shape que ya usa `onPublishDiagnostics()` — se extrajo `parseDiagnosticItems()` (antes inline) para que ambos caminos compartan la misma conversión, sin duplicar lógica. `tool-registry.ts` no se tocó en su formato de resultado — sigue consumiendo `LspDiagnosticsResult[]` igual que siempre.

**Pieza 5 — 5 lenguajes nuevos en `LANGUAGE_SERVERS`** (12 en total, de los 7 lenguajes cubiertos anteriormente):
- **Terraform** (`terraform-ls serve`, binario nativo de HashiCorp, sin paquete npm real — mismo patrón que gopls/clangd, solo detección por PATH, sin fallback de 2do nivel conocido en Windows) y **Lua** (`lua-language-server`, binario nativo de LuaLS, sin paquete npm real, mismo patrón) — **listos tal cual**, sin `configResponses`, sin depender de ninguna pieza nueva de esta fase (ambos usan push).
- **YAML** (`yaml-language-server`) — nuevo paquete npm BUNDLEADO (mismo patrón exacto que `typescript-language-server`/`pyright`: `dependencies` + `files`/`asarUnpack` en `package.json`, `resolveBundledServerEntry()`), tolera `null` en `workspace/configuration` (confirmado real), sin `configResponses`.
- **ESLint** (`vscode-langservers-extracted`, bin `vscode-eslint-language-server`) — también bundleado, `extensions:['.js','.jsx','.mjs','.cjs']` **a propósito, NUNCA `.ts`/`.tsx`** (esas 2 ya pertenecen a la entrada `typescript`, que da chequeo de TIPOS real; `languageServerConfigFor()` resuelve un solo config por extensión — agregar ESLint ahí robaría esas 2 extensiones de `typescript-language-server` sin ganar chequeo de tipos a cambio; soporte de ESLint también sobre `.ts`/`.tsx` con 2 servidores por archivo es un cambio de arquitectura mayor, fuera de alcance, documentado explícito en el código y en `PENDING.md` implícitamente vía este mismo comentario). No trae `eslint` embebido — lo resuelve vía Node module resolution desde el WORKSPACE DEL USUARIO, responsabilidad del usuario tener `eslint` real instalado en su proyecto.
- **Bash** (`bash-language-server`, subcomando `start`) — bundleado. Diagnósticos reales de LINT dependen 100% de `shellcheck`, binario nativo EXTERNO que el usuario provee aparte (mismo espíritu que Java necesitando un JRE real para jdtls) — sin él, el servidor sigue dando parsing/completado/hover/symbols/rename (tree-sitter), pero cero diagnósticos de lint, fallo confirmado limpio del lado del servidor (warning + `diagnostics:[]`, nunca un crash). Amatista NO intenta detectar/inyectar `SHELLCHECK_PATH` automáticamente — depende de que `shellcheck` esté en el `PATH` del usuario, decisión deliberada de mantener el alcance acotado (el mecanismo ya soportaría inyectarlo vía `env` en `resolveCommand()` si se decide después).

Limpieza: descriptions de `get_diagnostics`/`find_definition`/`find_references` (`tool-registry.ts`) actualizadas con los 5 lenguajes nuevos — y corregido el framing "no lint" de `get_diagnostics` (ya no es cierto: JS vía ESLint y Bash vía ShellCheck SÍ son lint real, distinto de TypeScript/Python/Rust/Go/C/C++/Java que siguen siendo compilador/type-checker).

### Verificación real

Todo contra `LspManager` real de producción (bundle esbuild, sin reimplementar nada), un workspace real compartido, con los binarios/paquetes reales ya obtenidos/instalados en la investigación previa del mismo día:

```
Terraform (main.tf, bloque HCL sin cerrar)     -> 1 diagnostico real: "Missing key/value separator..."
Lua (test.lua, 3 errores a proposito)          -> 3 diagnosticos reales: undefined-global, redundant-parameter, unused-local
YAML (test.yaml, indentacion + clave duplicada)-> 3 diagnosticos reales, primer intento
ESLint (test.js, no-unused-vars + no-undef)    -> 4 diagnosticos reales via PULL real (textDocument/diagnostic)
Bash (test.sh, SC2086 a proposito)             -> 2 diagnosticos reales via shellcheck real (PATH), incl. bonus SC2154
```

**No regresión confirmada, mismo turno**: Python (push, bundleado) -- diagnostico real de tipo (`reportAssignmentType`) sin cambios. Rust (push, nativo externo, `rust-analyzer` real ya instalado en la máquina de desarrollo) -- diagnostico real de tipo (`E0308 expected i32, found &'static str`) tras ~24s de indexación real de un proyecto Cargo nuevo (latencia esperada de primera indexación, no una regresión — confirmado con reintentos incrementales).

**Custom `lsp.json` con `configResponses` propio, prueba decisiva del override de 2 niveles**: entrada custom nueva (`.customjs`, apuntando al MISMO binario bundleado de `vscode-eslint-language-server`) con un `configResponses` deliberadamente INCOMPLETO (`{validate:'on'}`, el primer paso fallido de la investigación previa) — el pull real falló con el error real EXACTO ya documentado (`"The \"path\" argument must be of type string. Received undefined"`, confirmado reproduciendo el mismo caso aislado), mientras que la entrada built-in `javascript` (con `ESLINT_CONFIG_RESPONSE` completo) sobre un archivo casi idéntico dio diagnósticos reales correctos en el MISMO turno — prueba definitiva de que el `configResponses` de `.lsp.json` llega de punta a punta y es genuinamente distinto del default de código, no solo una configuración ignorada.

`npm run typecheck` y `npm run build` (con `mcp:lsp:bundle`) en verde. `npm install` real de las 3 dependencias nuevas (`yaml-language-server`, `vscode-langservers-extracted`, `bash-language-server`), agregadas a `dependencies`/`files`/`asarUnpack` de `package.json`.

Archivos: `src/main/lsp-client.ts`, `src/main/lsp-manager.ts`, `src/main/tool-registry.ts` (solo descriptions), `package.json`. Ningún cambio en `LspFramer` (ya genérico). Vue investigado y descartado tal cual está — ver `docs/_arch/PENDING.md`.

**Manejo de errores real**: `readTavilyErrorBody()`/`tavilyErrorMessage()` propios en `web-search.ts` (NO reusa `readErrorBody()` de `api-agent-runtime.ts`, que asume la forma anidada `{error:{message}}` de Anthropic/OpenAI/Foundry — forma distinta confirmada para Tavily, ver Verificación real). 401/403 → mensaje explícito de key rechazada; 429 → mensaje explícito de límite de uso alcanzado; cualquier otro status → mensaje genérico con el detalle real, nunca un stack trace. `web_fetch`: una URL que Tavily no logra extraer NO es un error HTTP (sigue siendo 200) — manejado explícito revisando `failed_results[]`, no inferido de `response.ok`.

### Verificación real

**Gating** (`ApiAgentRuntime` real de producción, bundle esbuild, servidor HTTP local real capturando el body real enviado — nunca un mock de la clase): con `hasWebSearchIntegration:false`, el catálogo real enviado en `tools` NO incluye `web_search` ni `web_fetch` (17 tools, las mismas de siempre); con `hasWebSearchIntegration:true`, aparecen ambas (19 tools). Confirma el requisito explícito de "sin key, ni siquiera aparecen en el catálogo".

**Error 401/403 real** (`tavilySearch()`/`tavilyExtract()` reales de producción, llamada HTTP real y en vivo contra `api.tavily.com` con una key deliberadamente inválida — nunca una credencial real obtenida por el agente, mismo criterio de seguridad de toda la sesión): ambos endpoints devolvieron 401 real. **Hallazgo real no anticipado**: la forma real del error de Tavily es `{"detail":{"error":"Unauthorized: missing or invalid API key."}}` — un nivel más anidado que lo asumido en el diseño original (`{error: string}` plano, basado en documentación oficial + reportes de comunidad). `readTavilyErrorBody()` corregido con la evidencia real (desarma `detail` como objeto anidado con su propio `.error`/`.message`, además de aceptarlo plano) — mensaje final limpio confirmado: `"Tavily rechazo la API key (HTTP 401)... Detalle: Unauthorized: missing or invalid API key."`, sin ningún JSON crudo ni stack trace. Sin key configurada (`integrations` undefined), ambas funciones devuelven el mensaje de "falta configurar" sin llegar a hacer ningún request real.

**429 y turno real con resultados**: no ejecutados — ningún key real de Tavily fue provista ni solicitada al usuario en este turno (respeta la restricción de seguridad de no obtener/usar credenciales reales por cuenta propia); el camino de 429 comparte el mismo `tavilyErrorMessage()` ya verificado con evidencia real para 401/403, y su rama de código (branch por `response.status`) no depende de ningún estado adicional no cubierto. Pendiente de verificación end-to-end con resultados reales si el usuario provee una key de prueba.

`npm run typecheck` y `npm run build` (incluyendo `mcp:lsp:bundle`) en verde.

Archivos: `src/main/web-search.ts` (nuevo), `src/shared/types.ts`, `src/main/settings-store.ts`, `src/main/tool-registry.ts`, `src/main/api-agent-runtime.ts`, `src/main/ipc-agent.ts`, `src/renderer/src/App.tsx`. Sin tocar `generate_image` ni ningún otro precedente existente (confirmado, restricción explícita del usuario). Sin commit — pendiente de que el usuario lo pida.

## Fix real — tool `todo_write` (lista de tareas propia del modelo)

Basado en `docs/_arch/verify_todo_write_design.md`, investigación previa con evidencia real de código (`chat-store.ts`/`runtime-state.ts`/`tool-registry.ts`) y evidencia externa real (system prompt filtrado de Claude Code + docs oficiales del Agent SDK). Patrón externo convergente: reemplazo TOTAL de la lista en cada llamada, `{content, status, priority?}`, a lo sumo 1 `in_progress` a la vez.

**Persistencia**: columna nueva `chat_sessions.todos TEXT` (`chat-store.ts`), mismo patrón `ALTER TABLE ... ADD COLUMN` + `try/catch` que `structured_memory`/`summary`/etc. `getTodos(chatId)`/`setTodos(chatId, todos)` — mismo shape de reemplazo total exacto que `getChatSummaryState()`/`setChatSummaryState()`, sin watermark (la lista no se "acumula" contra un punto del historial, el modelo manda la versión vigente completa siempre). JSON inválido/fila ausente degrada a `[]` en silencio (`parseTodos()`), nunca un throw que tumbe el turno por un dato de bookkeeping corrupto.

**Inyección**: `buildRuntimeContext()` (`runtime-state.ts`) lee `getTodos(chatId)` junto a `getChatSummaryState()` — una lectura más, cero cambios en el mecanismo. `todos` nuevo en `RuntimeContextEnvelope` (`shared/types.ts`).

**Hallazgo real no anticipado, decisivo**: `formatContextEnvelope()` (`context-envelope.ts`) **NO es el único punto de render** — confirmado con evidencia real que los 4 runtimes API (Foundry/Anthropic/Gemini/OpenAI-chat) tienen su PROPIA función duplicada, `memoryBlockText()` (`api-agent-runtime.ts`), documentada ahí mismo como necesaria porque esos 4 runtimes arman su payload directo, nunca pasan por `formatContextEnvelope()` (ese solo lo consume el runtime CLI). La primera verificación real (turno 2 de un chat con tareas ya guardadas) confirmó el gap en vivo: el bloque nuevo llegaba al CLI pero el request real mandado al runtime API (openai-chat, servidor HTTP local real) NO incluía la lista de tareas — corregido agregando el mismo bloque, mismo criterio exacto, también en `memoryBlockText()`. Ambos puntos quedan ahora sincronizados (mismo orden: `topics` → `summary` → `todos`).

**Registro de la tool**: mismo mecanismo de siempre (`TOOL_DEFINITIONS` + `case` en `execute()`). Primera tool con parámetro `array` de objetos — confirmado con grep que ninguna entrada anterior lo necesitaba; `ToolDefinition.parameters.properties` tenía el shape `{type, description}` plano, insuficiente para `items`/`enum` — extendido a `ToolPropertySchema` recursivo (opcional en todos sus campos, no rompe ninguna entrada existente). Confirmado que los 4 conversores de schema por runtime (`foundryTools`/`anthropicTools`/`geminiFunctionDeclarations`/`openAiTools`) pasan `def.parameters` completo sin reconstruirlo — el schema nuevo llega intacto a los 4.

**Acceso al `chatId`**: hallazgo real de la investigación — ninguna tool tenía hoy acceso al `chatId` de la sesión dentro de `ExecuteContext`. Resuelto SIN threadear un campo nuevo por todo `runTurnForWindow()`: `writeTodos` (nuevo en `ExecuteContext`) es una closure inyectada por `ipc-agent.ts`, cerrada sobre `session` (mutable), leyendo `session.activeChatId` "fresco" en el momento de la llamada — mismo patrón exacto ya usado por `listWindows`.

**Aprobación/sandbox**: ninguna, en cualquier modo — mismo criterio que `list_windows` (no toca filesystem/red/dinero) y que la escritura automática de `structured_memory` durante la compactación (nunca pasa por `ctx.confirm()`).

**Validación fail-closed**: 2+ items con `status:'in_progress'` se rechaza con un error claro nombrando las tareas en conflicto — nunca auto-corrige en silencio. Decisión explícita contra el precedente externo: confirmado con evidencia real (system prompt de Claude Code, docs oficiales del Agent SDK) que "exactamente 1 in_progress" es ahí una instrucción de PROMPT (autodisciplina del modelo), no una validación de servidor — Amatista es deliberadamente más estricta, mismo criterio ya aplicado hoy a TOCTOU/sandbox/`isPrincipalChat`.

### Verificación real

Contra clases reales de producción (`ApiAgentRuntime`/`ToolRegistry`/`chat-store.ts`/`buildRuntimeContext()`, bundle esbuild, storage aislado vía `AMATISTA_STORAGE_ROOT`, servidor HTTP local real haciendo de "modelo" — nunca una credencial externa real):

- **Persistencia real**: turno real con `todo_write` (3 tareas reales) → `chat_sessions.todos` leído directo de SQLite real, contenido exacto persistido.
- **Inyección real, turno siguiente**: el request real mandado al "modelo" en el turno 2 (mismo chat) incluyó el bloque `"Lista de tareas (todo_write)"` con las 3 tareas reales — confirmado tras corregir el hallazgo de `memoryBlockText()` de arriba.
- **Rechazo real**: 2 tareas `in_progress` a la vez → tool result real devuelto: `"Solo puede haber una tarea en \"in_progress\" a la vez -- marcadas in_progress: \"Tarea A\", \"Tarea B\". Volve a llamar todo_write con una sola."` — `chat_sessions.todos` confirmado SIN CAMBIOS tras el rechazo (siguió con la lista válida anterior, ninguna escritura parcial).
- **Chat sin `todo_write`**: `getTodos()` real devuelve `[]`, el request real mandado al "modelo" NO incluye el bloque — confirmado que no rompe nada.

`npm run typecheck` y `npm run build` (con `mcp:lsp:bundle`) en verde. Nota honesta: el harness standalone (SQLite experimental de Node + `process.exit()` inmediato al terminar) generó un `Assertion failed` de libuv al cerrar el proceso — artefacto de cierre abrupto del harness fuera de Electron (mismo tipo ya documentado para otras verificaciones de esta bitácora), ocurrido DESPUÉS de que los 4 casos ya imprimieran sus resultados reales completos, no una regresión de la app real.

Archivos: `src/shared/types.ts`, `src/main/chat-store.ts`, `src/main/runtime-state.ts`, `src/main/context-envelope.ts`, `src/main/api-agent-runtime.ts`, `src/main/tool-registry.ts`, `src/main/ipc-agent.ts`. `compactSummary`/`topics` sin ningún cambio (aditivo). Sin commit — pendiente de que el usuario lo pida.

## Fix real — "Modo plan" (liviano + variante reforzada con read-only real)

Basado en `docs/_arch/verify_plan_mode_design.md`, evidencia real de código (sandbox como closure congelado en `agent:connect`, `configure()` como simple reemplazo de estado sin efectos secundarios, `sandbox` de Codex fijo en `thread/start`, patrón `toolTrustSession` para "aprobar 1 cosa que cambia la sesión completa") confirmada antes de implementar. Patrón externo (`plan-mode` de deepseek-harness): prompt + tool `exit_plan_mode` para presentar el plan antes de ejecutar.

**Estado nuevo, por panel, NO persistido en DB** (mismo criterio que `sandbox`/`effort`): `SessionRuntimeState` gana `sandbox: SandboxMode` (copia VIVA y mutable, antes `payload.sandbox` era un valor capturado una sola vez en el closure de `agent:connect`, nunca releído), `planModeActive`, `planModeEnforced`, `priorSandbox`.

**Pieza 1 — hot-swap real de sandbox, sin reconectar**: `ApiAgentRuntime.updateSandbox()`/`updatePlanModeActive()` (métodos nuevos, mutan solo un campo del `config` ya guardado — `configure()` en sí es un simple `this.config = options`, confirmado sin ningún efecto secundario real) y `CliAgentRuntime.updateSandbox()` (deliberadamente NO reusa `configure()`, que ahí SÍ llama `this.stop()` y resetea `sessionId` — perdería continuidad real de sesión, ej. `--resume`). `connectSessionForWindow()` (`ipc-agent.ts`) ahora usa `session.sandbox` (no `payload.sandbox` directo) en el `toolExecutor`/`runtime.configure()`/`CodexClient.start()` — mismo criterio "fresco sobre session" ya usado por `listWindows`/`writeTodos`. Codex queda fuera a propósito: su `sandbox` es un parámetro de `thread/start` (creación del thread), nunca de cada turno — confirmado con grep que `sendTurn()`/`turn/start` no lo vuelve a mandar.

**Pieza 2 — `enablePlanMode()`/`disablePlanMode()`** (`runtime-state.ts`, mismo patrón real que `setSessionToolTrust()`): `enablePlanMode(panelId, enforced)` exige una conexión real ya establecida (fail-closed, mismo criterio de TOCTOU/sandbox de esta sesión — evita que `disconnectSession()`, llamado SIEMPRE al inicio de `connectSessionForWindow()`, pise en silencio un modo plan activado antes de conectar) y rechaza `enforced` si `session.activeRuntime === 'codex'`. Si `enforced`, captura `session.priorSandbox = session.sandbox` (nunca asumido `'workspace-write'`) y fuerza `read-only` real vía `applySandboxOverride()`. `disablePlanMode()` revierte al `priorSandbox` real y apaga los flags — llamado tanto por la tool `exit_plan_mode` (tras aprobación) como por el botón manual de la píldora. `disconnectSession()` resetea los 3 campos directo (sin pasar por `disablePlanMode()`, que llamaría `updateSandbox()` sobre runtimes que esa misma función ya puso en `null`).

**Pieza 3 — prompt injection, 2 puntos de render** (mismo hallazgo de hoy con `todo_write`): bloque nuevo en `formatContextEnvelope()` (`context-envelope.ts`) y en `memoryBlockText()` (`api-agent-runtime.ts`), redactado SIN asumir que `exit_plan_mode` esté disponible (el runtime CLI, único consumidor real de `formatContextEnvelope()`, nunca tiene esa tool — `TOOL_DEFINITIONS` solo se importa en `api-agent-runtime.ts`, confirmado con grep) — el texto dice "si tenés la tool, usala; si no, resumí el plan en tu respuesta y esperá confirmación explícita".

**Pieza 4 — tool `exit_plan_mode(plan)`**: registro estándar (`TOOL_DEFINITIONS` + `case`), gateada en `toolCatalog()` por `config.planModeActive` (mismo patrón que `isPrincipalChat`/`hasWebSearchIntegration`, pero este campo SÍ cambia en caliente vía `updatePlanModeActive()`) — solo aparece en el catálogo mientras el modo plan está activo. `ctx.confirm(title, plan)` (mismo mecanismo incondicional que `send_to_window`/`web_search`, la UI ya renderiza `detail` multilínea sin ningún cambio) muestra el plan completo; aprobado → `ctx.exitPlanMode()` (closure nueva, llama `disablePlanMode()` real); rechazado → mensaje claro, el modelo sigue en modo plan.

**Pieza 5 — UI** (`App.tsx`): checkbox "Modo plan" junto a `effort` (togglear NO desconecta, mismo criterio), sub-checkbox "Forzar solo lectura" oculto si `agentRuntime === 'codex'`. Píldora "Modo plan"/"Modo plan (reforzado)" con botón "Salir" (mismo componente/estilo que `toolTrustActive`) — el humano no depende de que el modelo llame la tool. `onPlanModeChanged`/`enablePlanMode`/`disablePlanMode` nuevos en preload, mismo patrón que `onToolTrustChanged`/`disableToolTrust`.

### Verificación real

Contra funciones reales de producción (`connectSessionForWindow`/`runTurnForWindow`/`enablePlanMode`/`disablePlanMode`/`ToolRegistry.execute`/`ApiAgentRuntime`, bundle esbuild, storage aislado, servidor HTTP local real de "modelo" — endpoint con loopback IPv6 `[::1]` para no disparar el guard real anti-Ollama de `isUnsupportedLocalProvider()`, que bloquea cualquier endpoint con `127.0.0.1`/`localhost`):

- **Liviano**: `enablePlanMode(panelId, false)` real → `session.planModeActive=true`. Turno real → el catálogo REAL enviado al "modelo" incluyó `exit_plan_mode`. `ToolRegistry.execute('exit_plan_mode', {plan}, ...)` real → `ctx.confirm` recibió el plan multilínea completo tal cual; aprobado → `session.planModeActive` volvió a `false`, **misma instancia** de `apiRuntime` antes/después (sin reconectar).
- **Reforzado**: `session.sandbox` real pasó de `'workspace-write'` a `'read-only'` sin reconectar (misma instancia de `apiRuntime`). `write_file` real con ese sandbox → rechazado real: `"Modo de solo lectura activo: no se puede escribir archivos."`. Al aprobar el plan, `session.sandbox` volvió real a `'workspace-write'` (el valor original) y un `write_file` real inmediatamente después **funcionó** (`"Archivo escrito: plan_mode_verify_test.txt"`, diff real).
- **Codex**: `enablePlanMode(panelId, true)` con `session.activeRuntime='codex'` → rechazado real con el mensaje explicando el motivo (`thread/start`); `enablePlanMode(panelId, false)` (liviana) con el mismo runtime → permitido.
- **Salida manual**: `disablePlanMode(panelId)` llamado directo (mismo código que dispara el botón "Salir" de la píldora), sin que ninguna tool se haya llamado → `planModeActive` vuelve a `false`, sandbox revertido.

`npm run typecheck` y `npm run build` (con `mcp:lsp:bundle`) en verde.

Archivos: `src/shared/types.ts`, `src/main/runtime-state.ts`, `src/main/api-agent-runtime.ts`, `src/main/cli-agent-runtime.ts`, `src/main/context-envelope.ts`, `src/main/tool-registry.ts`, `src/main/ipc-agent.ts`, `src/preload/index.ts`, `src/preload/index.d.ts`, `src/renderer/src/App.tsx`. `toolTrustSession`/`toolTrustActive` sin ningún cambio (solo reusados como molde). Sin commit — pendiente de que el usuario lo pida.

## Fix real — Presets simples (persona + proveedor/modelo preferido)

Basado en `docs/_arch/verify_simple_presets_design.md`, evidencia real de código confirmada antes de implementar: `ChatSession.providerId?`/`modelId?` ya existían como campos opcionales sin usar por `createBlankChat()`; `persistChatSessionMeta()` ya reenviaba esos campos a `ensureChatSession()`; ningún runtime API tiene un canal real "mandar una sola vez" (confirmado que incluso el campo `system` nativo de Anthropic se recalcula en cada `send()`, mismo hallazgo que ya forzó el patrón de 2 puntos de render con `todo_write`/"modo plan"). Versión deliberadamente simple: sin composición de tools, sin filtrado dinámico — solo `{nombre, texto de persona, providerId?/modelId?}`.

**Esquema**: `Preset` nuevo (`shared/types.ts`) — `{id, name, personaText, providerId?, modelId?}`. `AppSettings.presets?: Preset[]`, mismo nivel plano que `providers[]`/`projectRoots[]`, sin ningún campo a cifrar (no toca `settings-store.ts`). CRUD 100% desde el renderer vía `mutateSettings()` (mismo patrón que `providers[]`) — `addPreset()`/`savePresetDraft()`/`deletePreset()`, sin `disconnectAllPanels()` (un preset no está "conectado" a nada).

**Persistencia**: columna nueva `chat_sessions.persona_text TEXT` (`chat-store.ts`, mismo `ALTER TABLE` + `try/catch` de siempre). `ensureChatSession()` gana `personaText?: string`, escrito **solo en la rama INSERT** — a diferencia de `providerId`/`modelId`/`parentChatId` (que usan `COALESCE` en el `UPDATE`), este campo NUNCA se toca en la rama `UPDATE`, ni siquiera con `COALESCE` — "se escribe una vez, nunca se actualiza después" es un requisito explícito. `getPersonaText(chatId)` nuevo, sin ningún setter propio aparte de la creación.

**Aplicación al crear un chat**: `createBlankChat(presetId?: string)` (`App.tsx`) — si `presetId` matchea un preset real, aplica `providerId`/`modelId` directo en el objeto `ChatSession` (campos ya existentes, cero mecanismo nuevo) y pasa `preset.personaText` a `persistChatSessionMeta(chat, personaText)` (nuevo 2do parámetro opcional, el resto de los call sites existentes — sidebar, "Agregar panel", migración — siguen sin pasarlo, comportamiento idéntico al de antes).

**Inyección, mismos 2 puntos de render que `todo_write`/"modo plan"**: `buildRuntimeContext()` lee `getPersonaText(chatId)` (una lectura más, mismo criterio) y lo agrega a `RuntimeContextEnvelope.personaText`. Bloque nuevo en `formatContextEnvelope()` (`context-envelope.ts`) y `memoryBlockText()` (`api-agent-runtime.ts`), posicionado **ANTES incluso de AGENTS.md** (persona = "quién sos", más fundacional que las reglas del repo) y claramente distinto del bloque de `topics`/`todos` (esto es identidad estática del chat, no estado de tareas).

**UI**: `<select>` chico junto al botón "+ Nuevo chat" (`selectedPresetId`, mismo patrón visual que `sandbox`/`effort`/"Modo plan" — NO dispara nada al cambiar, el botón lee el valor recién al hacer click), oculto por completo si `settings.presets` está vacío. Sección nueva "Presets" en Settings (lista + formulario inline de edición — nombre, textarea de persona, select de provider/modelo preferido con `presetCandidates` — mismo `useMemo` que `compactionCandidates` pero **sin** el filtro `isApiCapableModel()`, porque el proveedor/modelo preferido de un preset se convierte en el de un chat completo interactivo, no en una llamada de una sola vuelta, e incluye también runtimes CLI).

### Verificación real

Contra funciones reales de producción (`ensureChatSession`/`getPersonaText`/`buildRuntimeContext`/`ApiAgentRuntime` reales, bundle esbuild, storage aislado, servidor HTTP local real de "modelo" con loopback IPv6). Nota honesta de alcance: `createBlankChat()`/`handleNewChatClick()` son closures de React dentro de `App()`, no exportables a un harness Node — este harness reproduce exactamente lo que esas funciones hacen (mismos campos, misma llamada real a `ensureChatSession()`), cerrado además por el tipado extremo a extremo (`Preset` → `ChatSession` → payload de `ensureChatSession`) verificado limpio por `npm run typecheck`.

- **Con preset**: `ensureChatSession()` real devolvió `providerId`/`modelId` correctos; `getPersonaText()` leyó el texto EXACTO persistido; `RuntimeContextEnvelope.personaText` real poblado; el request REAL mandado al "modelo" incluyó el texto de persona completo bajo el heading `"Persona/instruccion de este chat"`.
- **Sin preset**: `providerId`/`modelId` quedaron `undefined` (fallback global de siempre, sin cambios); `getPersonaText()` real devolvió `undefined`; el request REAL al "modelo" **no** incluyó ningún bloque de persona — confirmado que el flujo sin preset es idéntico al de antes.

`npm run typecheck` y `npm run build` (con `mcp:lsp:bundle`) en verde.

Archivos: `src/shared/types.ts`, `src/main/chat-store.ts`, `src/main/runtime-state.ts`, `src/main/context-envelope.ts`, `src/main/api-agent-runtime.ts`, `src/main/ipc-chats.ts`, `src/preload/index.ts`, `src/preload/index.d.ts`, `src/renderer/src/App.tsx`, `src/renderer/src/assets/main.css`. `providers[]`/`projectRoots[]` sin ningún cambio (solo reusados como molde). Sin filtrado de tools por preset (fuera de alcance explícito). Sin commit — pendiente de que el usuario lo pida.

## Fix real — Tool `terminal_exec` (terminal persistente por sesión)

Basado en `docs/_arch/verify_persistent_terminal_design.md`, evidencia real confirmada antes de implementar con 3 rondas de pruebas aisladas contra `cmd.exe` real (el mismo shell default que ya usa `run_command` hoy vía `exec()`): `node-pty` confirmado innecesario (git/build/tests no exigen un TTY real); mecanismo de marcador viable con 4 mitigaciones reales y no obvias, cada una confirmada necesaria por separado antes de combinarlas.

**`TerminalManager`** (`src/main/terminal-manager.ts`, nuevo) — un `cmd.exe` real persistente por sesión, `spawn()` con pipes normales (NO `node-pty`). Arranque perezoso (`ensureStarted()`, mismo criterio que `LspManager`: el proceso real recién se spawnea en la primera llamada real, no al conectar). Mecanismo de marcador, las 4 piezas confirmadas reales en la investigación previa:
1. **`spawn('cmd.exe', ['/Q'], ...)`** — el flag de spawn (no el comando `@echo off`, confirmado que ESE no sirve en modo pipe) suprime el eco del input.
2. **`prompt $_`** mandado una vez al arrancar — elimina el ruido del prompt `cwd>`.
3. **`(call )&` antepuesto a cada comando** — resetea `%ERRORLEVEL%` a `0` de forma incondicional. Sin esto, confirmado real en la investigación que un comando builtin (`echo`) que no toca `%ERRORLEVEL%` hereda el código de salida del comando anterior si ese falló.
4. **`2>&1` en cada comando** — mergea `stderr` al mismo stream que `stdout` antes del marcador, evitando una carrera real entre 2 pipes async independientes.

Dos timeouts reales, distintos y documentados: `TERMINAL_COMMAND_TIMEOUT_MS = 120_000` (por-comando, más generoso que `RUN_COMMAND_TIMEOUT_MS` de `run_command` — 30s — porque una sesión persistente es justo para workflows más largos) y `TERMINAL_IDLE_TIMEOUT_MS = 15 * 60_000` (idle de sesión completa, **patrón nuevo en este codebase** — ni `LspManager` ni `McpManager` tienen uno, ambos viven hasta `disconnectSession()` sin límite intermedio — se resetea con cada uso real, mata el proceso solo si nadie lo usa en 15 minutos; el próximo uso arranca una sesión nueva desde cero).

**Wiring**: `SessionRuntimeState.terminalManager: TerminalManager | null` (mismo patrón exacto que `lspManager`/`mcpManager`), creado en `connectSessionForWindow()` (objeto vacío, sin proceso real todavía), `stop()` real en `disconnectSession()`. `ExecuteContext.terminalExec?` (closure inyectada por `ipc-agent.ts`, cerrada sobre la instancia real de esta conexión, mismo criterio que `writeTodos`/`exitPlanMode`).

**Tool `terminal_exec(command)`**: registro estándar (`TOOL_DEFINITIONS` + `case`), coexiste con `run_command` sin tocarlo (mismo criterio que `todo_write`/`web_search`/`exit_plan_mode` — nunca modificar una tool existente para agregar una capacidad). Description explica la diferencia real con `run_command` (mantiene `cd`/variables/directorio entre llamadas, `run_command` no) y cuándo usar cada una. Mismo `resolveApproval()` exacto que `run_command` (`read-only` bloquea de raíz sin llamar `ctx.terminalExec`, `workspace-write` pregunta por cada comando, `danger-full-access` aprueba sin preguntar) — sin categoría de seguridad nueva, `toolTrustSession` ya lo cubre gratis.

### Verificación real

Contra clases reales de producción (`TerminalManager`/`ToolRegistry.execute()` reales, sin mocks del mecanismo):

- **`cd` persiste**: `cd ..` en una llamada + `cd` (sin argumentos) en la siguiente → directorio real correcto (el padre real del workspace).
- **`set` persiste**: variable seteada en una llamada, visible real en la siguiente.
- **Exit code no queda "pegado"**: comando fallido real (`exitCode:1`) seguido de uno exitoso (`echo`) → exit code real `0`, confirmando la mitigación `(call )&` funciona en producción, no solo en la investigación aislada.
- **Flujo completo vía la tool real** (`ToolRegistry.execute('terminal_exec', ...)`, `resolveApproval()` real incluido): `set` + `echo` en la MISMA sesión mostró el valor correcto.
- **`read-only` bloquea de raíz**: mensaje real de bloqueo, y confirmado que `ctx.terminalExec` **nunca se llamó** (mismo corte temprano que `run_command`).
- **Cleanup real**: PID real capturado antes de `stop()`; confirmado con `process.kill(pid, 0)` que el proceso está genuinamente muerto después — no queda huérfano.
- **No regresión de `run_command`**: `cd` real vía `run_command` siguió mostrando el workspace ORIGINAL (nunca el modificado por `terminal_exec` en el mismo turno de verificación — confirma aislamiento total entre ambos mecanismos), y la variable seteada vía `terminal_exec` **no** fue visible desde `run_command` (`%AMATISTA_VERIFY_VAR%` sin expandir) — confirmado que `run_command` sigue sin memoria entre llamadas, sin cambio de comportamiento.

`npm run typecheck` y `npm run build` (con `mcp:lsp:bundle`) en verde.

Archivos: `src/main/terminal-manager.ts` (nuevo), `src/main/runtime-state.ts`, `src/main/ipc-agent.ts`, `src/main/tool-registry.ts`. `run_command`/`runShellCommand()` sin ningún cambio. Sin commit — pendiente de que el usuario lo pida.

## Fix real — Sistema de skills (formato Agent Skills, divulgación progresiva nivel 1+2)

Basado en `docs/_arch/verify_skills_design.md`, evidencia real confirmada antes de implementar: AGENTS.md es un único archivo "todo o nada" (sin divulgación progresiva); no existía ningún precedente real de "catálogo liviano ahora, cuerpo completo bajo demanda" (ni siquiera el descubrimiento de tools MCP, que trae el `inputSchema` completo de una sola vez); `yaml` ya era una dependencia real en uso directo (`ipc-settings.ts:6`), cero costo nuevo para parsear el frontmatter. Mecanismo DISTINTO y complementario a AGENTS.md (`agents-md.ts`, sin tocar) — ese es la "constitución" siempre-relevante del repo, esto es una biblioteca de procedimientos especializados activados uno por uno.

**`skill-manager.ts`** (nuevo) — escanea 2 raíces reales: global (`getAppDataSubdir('skills')`, mismo directorio raíz que `config/lsp.json`) y workspace (`<workspace>/.skills`), aceptando AMBAS variantes reales del formato Agent Skills (carpeta kebab-case con `SKILL.md` adentro, o un `<name>.md` plano directo en la raíz). Frontmatter (`---\nname/description\n---`) parseado con `parse` de `yaml`, la misma función ya importada en `ipc-settings.ts`. Merge por CLAVE (nombre de skill) — workspace pisa global en conflicto, mismo criterio real que `mergedLanguageServers()`/`lsp.json` (más parecido a `lsp.json`, con 2 niveles, que a `.mcp.json`, solo-workspace — confirmado en la investigación que una skill útil se reusa entre proyectos, a diferencia de credenciales MCP). Cache con invalidación real por **firma** (ruta+mtime de CADA archivo de skill encontrado, ordenada y unida) — más robusto que un único mtime de directorio (detecta agregar/borrar/editar cualquier archivo de skill, no solo cambios directos en la raíz).

**Nivel 1 — catálogo liviano**: `listSkillsCatalog(workspace)` devuelve SOLO `{name, description}` de cada skill — nunca el cuerpo. `SkillCatalogEntry` nuevo en `shared/types.ts`, `RuntimeContextEnvelope.skills?`. `buildRuntimeContext()` lo lee en cada turno (barato, la cache ya resuelve el costo real). Renderizado en los MISMOS 2 puntos ya duplicados hoy (`formatContextEnvelope()`/`memoryBlockText()`, mismo criterio que `todos`/persona/modo-plan) como un bloque `"Skills disponibles (usa load_skill(name)...)"`, posicionado junto a AGENTS.md (guía estática) y antes de la memoria dinámica de la conversación. `undefined`/`[]` = sin bloque, sin cambio de comportamiento.

**Nivel 2 — tool `load_skill(name)`**: registro estándar (`TOOL_DEFINITIONS` + `case`), **sin `resolveApproval()`/`ctx.confirm()`** — mismo criterio que `list_windows` (solo lee un archivo de skill local, no toca filesystem del usuario ni corre nada). Import directo de `getSkillBody()` en `tool-registry.ts` (NO una closure de `ExecuteContext` inyectada por `ipc-agent.ts` — no necesita ningún estado de sesión, solo `ctx.workspace`, ya existente — mismo patrón real que `listFileHistory`/`readFileVersion` de `local-vcs.ts`, confirmado con evidencia real antes de decidir no tocar `ipc-agent.ts` en absoluto para esta feature). Nombre inexistente → error real y claro listando las skills disponibles, nunca un "no encontrado" genérico.

### Verificación real

Con skills reales creadas de prueba (frontmatter real, 2 formatos distintos), contra funciones reales de producción (`listSkillsCatalog`/`getSkillBody`/`buildRuntimeContext`/`ApiAgentRuntime`/`ToolRegistry.execute()`, storage aislado, servidor HTTP local real de "modelo"):

- **Catálogo nivel 1**: `listSkillsCatalog()` real devolvió solo `{name, description}` de las 2 skills de prueba (una global en carpeta+`SKILL.md`, una de workspace en `.md` plano) — confirmado que el texto del cuerpo real (`"Primera linea: verbo..."`) **no** aparece en el catálogo.
- **Turno real**: el request REAL mandado al "modelo" incluyó el heading `"Skills disponibles"` y ambos nombres reales, pero **sin** el cuerpo de ninguna — confirmado con `sentMessages.includes(...)` sobre el body real capturado.
- **`load_skill` real, sin aprobación**: probado con `sandbox:'read-only'` y un `ctx.confirm` que **tira error si se llama** — la tool funcionó igual (nunca invocó `confirm`), devolviendo el cuerpo COMPLETO y correcto de cada skill.
- **Nombre inexistente**: error real (`"No existe una skill llamada \"skill-que-no-existe\". Skills disponibles: commit-convention, report-format."`).
- **Merge por clave, workspace pisa global**: antes de crear el conflicto, `getSkillBody()` devolvía la versión GLOBAL. Tras crear una skill con el MISMO nombre en el workspace (`.skills/commit-convention/SKILL.md`, contenido distinto), **en el MISMO proceso, sin reiniciar**, `getSkillBody()` devolvió la versión de WORKSPACE — confirma el merge por clave Y la invalidación de caché por firma funcionando en caliente.

`npm run typecheck` y `npm run build` (con `mcp:lsp:bundle`) en verde.

Archivos: `src/main/skill-manager.ts` (nuevo), `src/shared/types.ts`, `src/main/runtime-state.ts`, `src/main/context-envelope.ts`, `src/main/api-agent-runtime.ts`, `src/main/tool-registry.ts`. `agents-md.ts`/`AGENTS.md` sin ningún cambio — mecanismo complementario, no reemplazado. `ipc-agent.ts` sin ningún cambio (nada que inyectar vía closure). Sin commit — pendiente de que el usuario lo pida.

## Fix real — guard/: tool-timeout genérico (MCP + read_document) + loop-hygiene por resultado

Basado en `docs/_arch/verify_guard_design.md`, evidencia real confirmada antes de implementar: de las ~9 categorías de tool, solo 2 no tenían NINGÚN timeout — tools MCP (`RpcStdioClient.request()`, base compartida con `McpServerConnection`/`CodexClient`/`CodexAccountBridge`, cero `setTimeout` en todo el archivo) y `read_document` (`document-reader.ts`, sin ningún guard de tiempo). El resto (`run_command`/`terminal_exec`/`web_search`/`generate_image`/LSP) ya tenían timeout ad-hoc, cada uno con su propio mecanismo — ninguno tocado. Loop-hygiene no existía en absoluto (confirmado por grep dirigido, cero lógica real de comparación) — solo el tope burdo `MAX_TOOL_LOOP=60`, ciego a progreso, que sigue intacto como red de seguridad final.

**Pieza 1 — timeout genérico donde faltaba:**

- **`RpcStdioClient.request()`** (`rpc-stdio-client.ts`) gana 2 parámetros OPCIONALES, `timeoutMs`/`timeoutMessage` — sin ellos, comportamiento IDÉNTICO a antes (`CodexClient`/`CodexAccountBridge` nunca los pasan, cero cambio de comportamiento para esos 2 clientes reales). Mismo criterio que `LspClient.request()` ya en producción: el timer no se cancela si la respuesta llega antes, se guarda por el chequeo `pending.has(id)` (ya lo borra `handleMessage()` al resolver) — precedente ya existente, no una omisión nueva.
- **`McpServerConnection.callTool()`** (`mcp-client.ts`) es el ÚNICO llamador que pasa esos 2 parámetros — `MCP_TOOL_TIMEOUT_MS` nuevo, 60s de default (más alto que los 20s de LSP o los 30s de `run_command` a propósito: una tool MCP externa puede ser trabajo legítimo más lento, un servidor de terceros arbitrario sin presupuesto de tiempo conocido de antemano), override opcional vía `AMATISTA_MCP_TOOL_TIMEOUT_MS` (mismo patrón que `AMATISTA_MAX_TOOL_LOOP`). Al vencer, el error es claro y nombra la tool real: `La tool MCP "<nombre>" no respondio en <N> segundos.` — la corrida sigue viva, el modelo ve el error como cualquier otro `tool_result` fallido y puede reintentar o cambiar de enfoque.
- **`read_document`** (`tool-registry.ts`) — `raceTimeout()` nuevo (wrapper genérico `Promise.race` contra un timer, con `clearTimeout` si gana la promesa real), `READ_DOCUMENT_TIMEOUT_MS = 30_000` default (mismo orden que `run_command`, no los 60s de MCP: es parseo local ya resuelto dentro del workspace, no un proceso externo), override vía `AMATISTA_READ_DOCUMENT_TIMEOUT_MS`. Limitación real documentada explícitamente: si el colgado fuera CPU-bound 100% síncrono (sin ningún `await` real adentro), el wrapper no lo corta de verdad — cierra el hueco para el caso real esperable (I/O async dentro de las librerías de parseo de PDF/DOCX/XLSX/HTML), no un kill duro de CPU.

**Pieza 2 — loop-hygiene por RESULTADO en `runTool()` (los 4 runtimes API):**

- **`hashFileContent()`** (`tool-registry.ts`) exportada — antes privada, mismo primitivo SHA-256 ya en producción para TOCTOU, reusado tal cual (cero función nueva de hash).
- **`toolCallSignatures`** (`api-agent-runtime.ts`, nuevo campo de instancia) — mismo ciclo de vida que `toolCallLog` (vive y muere con el turno, reseteado en cada `send()`), pero hashea args/resultado COMPLETOS (`JSON.stringify(args)`/`JSON.stringify({ok, output})`), NO el preview recortado a 300 chars de `toolCallLog` — el truncado perdería el hallazgo de diseño (2 resultados de paginación distintos podrían compartir los primeros 300 chars y colisionar en un falso "sin progreso").
- **`registerToolCallSignature()`** — llamado dentro de `finish()` (el closure único de `runTool()` por el que pasa CUALQUIER resultado: built-in, MCP, o el error temprano de "tool no disponible"), tras `logToolCall()`. Devuelve la racha de llamadas CONSECUTIVAS (contando la actual) con exactamente el mismo `{name, argsHash, resultHash}` — si el resultado cambia aunque sea un carácter (polling/paginación real), el hash cambia y la racha se corta en 1.
- **`loopHygieneNotice()`** — interviene solo si la racha es múltiplo de `LOOP_HYGIENE_THRESHOLD` (3 por default, override vía `AMATISTA_LOOP_HYGIENE_THRESHOLD`): agrega una nota al `output` que YA vuelve al modelo como `tool_result` (nunca lanza error, nunca corta el turno) — mismo espíritu que el aviso de staleness ya existente. Se repite en 3, 6, 9... en vez de en cada llamada tras el umbral, para recordar sin inundar el `tool_result` de avisos idénticos si el modelo insiste.
- `MAX_TOOL_LOOP=60` sin ningún cambio — sigue como red de seguridad final, ahora complementada (antes, un bucle real consumía las 60 iteraciones completas antes de cortar; con esto, el aviso llega mucho antes, sin bloquear si el modelo de verdad tiene una razón para insistir).

### Verificación real

Contra clases reales de producción, sin mocks del mecanismo (`McpServerConnection`/`McpManager`/`ApiAgentRuntime` reales, bundle esbuild con `--packages=external` + alias real de `electron` ya tracked del harness de benchmark, `benchmark/electron-stub.cjs`):

**Timeout MCP** — servidor MCP de prueba REAL (proceso Node por stdio) que responde `initialize`/`tools/list` normalmente pero NUNCA responde `tools/call` a propósito (cuelga real). Con `AMATISTA_MCP_TOOL_TIMEOUT_MS=1500` para no esperar el default de producción: `callTool()` real venció en ~1509-1510ms (contra el límite configurado de 1500ms, confirmando que es el timeout nuevo el que actuó, no otra causa), devolviendo `{ok:false, output:'La tool MCP "hang_tool" no respondio en 1.5 segundos.'}` — la corrida no se colgó, el mensaje es claro y nombra la tool real.

**Loop-hygiene**, 3 escenarios reales contra un servidor HTTP local haciendo de "modelo" (loopback IPv6), inspeccionando los request bodies REALES que se le mandaron en cada vuelta del loop:
- **Caso A — bucle real** (misma tool+args, resultado IDÉNTICO 5 veces seguidas): el aviso apareció por primera vez exactamente en el request inmediato posterior a la 3ra llamada (streak=3), ausente en los 2 anteriores; persiste en el historial acumulado de los requests siguientes (4ta/5ta llamada, comportamiento correcto — es parte de la conversación real) pero se confirmó que se **inyectó una sola vez** (no se duplicó en streak=4 ni streak=5, que no son múltiplo de 3).
- **Caso B — polling legítimo** (misma tool+args, resultado DISTINTO cada vez): CERO ocurrencias del aviso en los 6 requests reales — confirma que el hallazgo de diseño central (no matar polling real) se sostiene en código, no solo en la investigación.
- **Caso C — turno normal** (3 tool calls distintas, sin ninguna repetición): CERO ocurrencias del aviso — un turno sin repeticiones no dispara nada.

`npm run typecheck` y `npm run build` (con `mcp:lsp:bundle`) en verde.

Archivos: `src/main/rpc-stdio-client.ts`, `src/main/mcp-client.ts`, `src/main/tool-registry.ts`, `src/main/api-agent-runtime.ts`. Ningún timeout ad-hoc existente tocado (`run_command`/`terminal_exec`/`web_search`/`generate_image`/LSP). `MAX_TOOL_LOOP` sin cambios. Sin commit — pendiente de que el usuario lo pida.

## Fix real — Orquestador paralelo: tool `parallel_ask` (fan-out/fan-in real)

Basado en `docs/_arch/verify_parallel_orchestrator_design.md`, con las 3 decisiones abiertas confirmadas por el usuario: (1) SOLO paneles ya conectados, sin auto-abrir ninguno nuevo — encolado round-robin si hay más sub-tareas que paneles idle; (2) aprobación con detalle COMPLETO (cada sub-tarea + panel/proveedor/modelo asignado) en un solo `ctx.confirm()` para todo el batch; (3) sin timeout propio — reusa el watchdog de turno ya existente por sub-turno (`fetchWithTimeout`/`CODEX_TURN_TIMEOUT_MS`, sin mecanismo nuevo).

**`parallel-orchestrator.ts`** (nuevo) — reusa SOLO la capa 1 de `send_to_window` (`runTurnForWindow`, `ipc-agent.ts`), NUNCA las capas 2/3 de entrega asíncrona cross-chat (`deliverResultToOriginWindow`/`INCOMING_MESSAGE_CHANNEL`): el resultado de `parallel_ask` vuelve SINCRÓNICO como el `output` de la tool al turno que la llamó, no como un mensaje separado en otro chat — más simple que `send_to_window`, no más complejo. Import estático de `runTurnForWindow` (mismo sentido que `cross-window-messaging.ts` → `ipc-agent.ts`); el import inverso (`ipc-agent.ts` → este módulo) es DINÁMICO dentro del closure del `toolExecutor` (mismo motivo exacto ya documentado para `sendToWindowByTitle`: evita un ciclo real `runtime-state.ts → tool-registry.ts → parallel-orchestrator.ts → ipc-agent.ts → runtime-state.ts`). `tool-registry.ts` importa de este módulo SOLO tipos (`import type`, erasado por completo, cero `require()` real) — confirmado en el build real: Vite emite `parallel-orchestrator-*.js` como chunk separado (dynamic import real), sin ninguna advertencia de dependencia circular.

**Reparto (Tarea 2 del diseño)**: `idlePanels(originPanelId)` — generalización real de `findConnectedPanelForChat()` — filtra `sessionRegistry` por 4 condiciones: `activeRuntime` seteado, `activeChatId` real (necesario para etiquetar con el título real del chat vía `getChatTitle()` nuevo en `chat-store.ts`, mismo query que `isPrincipalChat`), nunca el panel de origen, e IDLE (`currentTurnAbort === null`). `planParallelAsk()` reparte round-robin (`index % paneles.length`) — 100% síncrona por dentro, no dispara ningún turno todavía.

**Aprobación (Tarea 5)**: `ctx.confirm()` directo e incondicional, mismo criterio de gasto real que `send_to_window`/`generate_image`/`web_search` — el detalle (`formatParallelPlanDetail()`, en `tool-registry.ts`, no en el orquestador: mismo criterio de que cada tool arma su propio texto de salida) muestra CADA sub-tarea con el panel/modelo real asignado, calculado por `planParallelAsk()` ANTES de pedir aprobación. `parallel_ask` sumada a `orchestratorToolNames` (`api-agent-runtime.ts`) — mismo gating exacto que `send_to_window`/`list_windows` (solo el chat "principal" del workspace).

**Ejecución (Tarea 4)**: `runParallelAsk()` agrupa las sub-tareas por panel (`Map<panelId, assignment[]>`) — dentro de UN panel corren en SECUENCIA real (`for` con `await` dentro del grupo), entre paneles DISTINTOS corren en PARALELO real (`Promise.allSettled` sobre los grupos, todos arrancan en el mismo tick). Una sub-tarea que falla (excepción real o `{success:false}`) nunca aborta a las demás — cada resultado se resuelve independiente. Cancelación en cascada: `originSignal` (el `AbortSignal` del turno de origen, `session.currentTurnAbort.signal` leído fresco en el momento en que `parallel_ask` se ejecuta) dispara `cancelSessionTurn()` sobre cada panel con un sub-turno ACTIVO en ese instante — mismo mecanismo real que el botón Detener.

**Agregación**: `formatParallelAskOutput()` (`tool-registry.ts`) — un bloque `## Sub-tarea N -- resuelta por <panel> (<modelo>)` (o `-- FALLO (...)`) por sub-tarea, texto/error real incluido. Siempre parcial-tolerante.

### Verificación real

Contra clases/funciones REALES de producción (`ToolRegistry.execute()` real — el `case 'parallel_ask'` tal cual —, `planParallelAsk`/`runParallelAsk` reales importados directo, `runTurnForWindow`/`sessionRegistry` reales, `sendToWindowByTitle` real sin cambios, servidores HTTP reales de "modelo" en loopback IPv6, bundle esbuild `--packages=external` + alias real del `electron-stub.cjs` ya tracked del harness de benchmark). Paneles destino conectados manualmente contra `sessionRegistry` con los MISMOS campos exactos que `connectSessionForWindow()` asigna (mismo criterio ya usado en TODAS las verificaciones de esta sesión — salta solo la ceremonia de `agent:connect` que no aporta nada acá: `McpManager.startAll`/`LspManager`/`refreshAgentsMdCache`):

- **Diálogo + paralelismo real + agregación** (3 paneles idle, 3 sub-tareas, 600ms de delay real por servidor): el detalle capturado incluyó las 3 sub-tareas y los 3 pares panel/modelo reales asignados, resuelto ANTES de que llegara cualquier request real a los 3 servidores destino. Tiempo total real 675-679ms (≈1x el delay de una sola sub-tarea, NUNCA ≈3x — paralelismo real confirmado, no secuencial). Output agregado con las 3 respuestas reales, correctamente etiquetadas por chat/modelo real.
- **Encolado real** (2 paneles idle, 4 sub-tareas, 400ms de delay): cada panel recibió 2 llamadas reales (round-robin confirmado), con un gap real de ~416-419ms entre la 1ra y 2da llamada AL MISMO panel (≈100% del delay — confirma SECUENCIA real, nunca 2 turnos a la vez en el mismo panel) mientras ambos paneles arrancaron su primera llamada casi simultánea (paralelismo real ENTRE paneles).
- **Fallo parcial no aborta** (3 paneles, 1 responde HTTP 500 real): `resultC.ok` siguió `true`, las 2 sub-tareas exitosas llegaron completas, la fallida quedó marcada `FALLO` con el mensaje de error real (`Claude API /messages fallo 500: ...`) — los 3 bloques presentes, ninguno se perdió.
- **TOCTOU** (2 paneles al MISMO workspace/archivo, 5 trials reales con demoras de aprobación asimétricas — hallazgo real de timing documentado abajo): 5/5 trials sin corrupción (contenido final SIEMPRE exactamente uno de los 2 escritos completos) y 5/5 trials con el TOCTOU existente disparándose real (mensaje real `"...cambio en disco despues de que lo leiste..."`) — confirma que la protección de staleness ya existente sigue intacta bajo el fan-out nuevo.
- **`send_to_window` sin regresión**: llamada real, sin ningún cambio de código — `ok:true` con la respuesta real del destino, idéntico a antes.

**Hallazgo real de timing (diagnóstico con `runtime.on('toolStatus')`, no solo asumido)**: `write_file` hace su chequeo de staleness (`freshContent` vs `existingHash`) ANTES de `snapshotFile()` — y `snapshotFile()` (git real, con contención real de lock cuando 2 llamadas concurrentes inicializan el MISMO repo oculto por primera vez, `local-vcs.ts`) es el paso más lento de la cadena (~150-700ms medido real), interpuesto ENTRE el chequeo y el `writeFileSync` real. Con 2 demoras de aprobación parecidas, ambos chequean ANTES de que cualquiera de los dos haya escrito de verdad — ninguno ve el cambio del otro todavía (correcto, no es un bug: en ese instante ninguno de los dos cambió el archivo aún). Para que el chequeo de UNO vea el archivo YA escrito por el OTRO, ese otro tiene que haber completado TODA su cadena (incluido el `snapshot` lento) antes de que el primero vuelva a mirar el disco — de ahí que la verificación necesitó demoras de aprobación deliberadamente asimétricas (5ms vs 1500ms) para reproducir la ventana real, en vez de 2 demoras iguales.

`npm run typecheck` y `npm run build` (con `mcp:lsp:bundle`) en verde — confirmado además en el build real que `parallel-orchestrator.ts` se separa en su propio chunk (dynamic import real), sin advertencias de ciclo.

Archivos: `src/main/parallel-orchestrator.ts` (nuevo), `src/main/chat-store.ts`, `src/main/tool-registry.ts`, `src/main/api-agent-runtime.ts`, `src/main/ipc-agent.ts`. `send_to_window`/`list_windows` sin ningún cambio de lógica (solo sumados a un `Array.includes` compartido para el gating). Sin auto-apertura de paneles (fuera de alcance, decisión confirmada). Sin commit — pendiente de que el usuario lo pida.

## Fix real — bug de enrutamiento en `LspClient.handleChunk()` (reordenamiento `method` antes que `pending`)

Basado en `docs/_arch/verify_lsp_10_remaining.md` (caso Clojure), donde se reprodujo real por primera vez: `handleChunk()` chequeaba `msg.id !== undefined && this.pending.has(msg.id)` **antes** que `msg.method !== undefined && msg.id !== undefined` — orden incorrecto, porque una respuesta JSON-RPC real nunca trae `method`, así que ese chequeo debería ganar siempre que esté presente. Con el orden viejo, un **request servidor→cliente** (`method`+`id` juntos, ej. `window/showMessageRequest`) cuyo `id` NUMÉRICO colisionaba por casualidad con el `id` de un request nuestro TODAVÍA pendiente (típico: el propio `initialize`, casi siempre `id=1`) se malinterpretaba como la respuesta a ESE request pendiente.

**Fix**: se invirtió el orden de los dos bloques en `handleChunk()` — el chequeo por `msg.method !== undefined && msg.id !== undefined` (requests entrantes del servidor) ahora corre primero, incondicionalmente; el chequeo de `pending.has(msg.id)` (respuestas a nuestros propios requests) corre después, solo si el mensaje NO tenía `method`. Cero cambio de comportamiento para mensajes sin ambigüedad (una respuesta real nunca matchea el primer bloque porque nunca trae `method`; una notificación pura nunca matchea ninguno de los dos porque nunca trae `id`).

### Verificación real

**Reproducción del bug ANTES del fix** (mismo mecanismo exacto que descubrió el caso Clojure): `git stash` para volver al código real de HEAD (con el bug), bundle esbuild real de `lsp-client.ts`, `LspClient` real (la clase de producción, no un mock) contra `clojure-lsp.exe` real, workspace con `deps.edn` real apuntando a una alias `:test:dev` que no existe y sin `clojure` CLI real en PATH (la condición real que dispara el shell-out fallido y el `window/showMessageRequest`). Instrumentado con un log temporal (solo en esta corrida, nunca en el repo) que confirmó el mecanismo exacto: `id=1 method=window/showMessageRequest pendingHas=true pendingKeys=[1]` — el mensaje entrante colisionaba real con el `initialize` pendiente. Resultado real del bug: `start()` "completaba" con `capabilities` corruptas (resuelto con `undefined` en vez del resultado real de `initialize`) y el servidor quedaba esperando para siempre una respuesta a su `showMessageRequest` que nunca llegaba — **cero diagnósticos reales en 15s**, aunque técnicamente `start()` no colgó (manifestación más insidiosa que un simple cuelgue: parece que arrancó bien, pero el servidor queda mudo para siempre).

**Con el fix aplicado** (`git stash pop`, rebundle): mismo binario real, mismo workspace, misma condición (sin `clojure` en PATH) — `start()` real completo en ~2.6s, `window/showMessageRequest` respondido correctamente (`null` genérico), `initialize` resuelto con las capabilities reales del servidor, y **8 diagnósticos reales recibidos en 158ms** tras `didOpen` sobre el mismo archivo con paréntesis desbalanceado + símbolo inexistente puesto a propósito.

**No-regresión real** (`languageServerConfigFor()` real, el mismo que usa `LspManager` en producción, contra los binarios YA bundleados del propio proyecto):
- **TypeScript (push-diagnostics)**: `const x: number = "esto no es un numero..."` → diagnóstico real recibido (`"Type 'string' is not assignable to type 'number'."`, código 2322) — idéntico a antes del fix.
- **ESLint (pull-diagnostics)**: workspace aislado con `eslint@9` real instalado + `eslint.config.js` real (`no-unused-vars`/`no-undef`) → 3 diagnósticos reales recibidos vía `pullDiagnostics()` (`"'unusedVariableOnPurpose' is assigned a value but never used."`) — idéntico a antes del fix.
- **Gleam (ids STRING, nunca disparó el bug viejo)**: `gleam.exe lsp` real contra `let x: Int = "..."` → diagnóstico real de tipos recibido (`"Type mismatch... Expected type: Int... Found type: String"`) en 660ms — confirmado que el reordenamiento no le rompe nada a un servidor cuyo comportamiento nunca dependió del orden viejo.

`npm run typecheck` y `npm run build` (con `mcp:lsp:bundle`) en verde.

Archivos: `src/main/lsp-client.ts` (único cambio: reordenar 2 bloques dentro de `handleChunk()`, sin tocar ninguna otra lógica). Ninguno de los 12 lenguajes ya en producción tocado en su configuración. Sin commit — pendiente de que el usuario lo pida.

## Fix real — `settings:save` descartaba `integrations` (Tavily) por no estar en la allowlist (Hallazgo 3)

Basado en `docs/_arch/verify_external_review_2_findings.md` (Hallazgo 3, confirmado con evidencia real): el handler IPC `settings:save` (`ipc-settings.ts`) fusiona el payload del renderer campo por campo con una **allowlist explícita** (fix de la carrera de `settings:save`, ver arriba en este documento) — pero `integrations` nunca se agregó a esa lista. La capa de persistencia (`settings-store.ts`) SÍ contempla `integrations` con cifrado real (`saveSettings()` :234-236 cifra vía `encryptSecret`, `loadSettings()` :210-212 descifra) — el único eslabón roto era el handler, que descartaba en silencio el `integrations` del payload y devolvía `{success:true}` igual. Consecuencia real en cadena: `hasWebSearchIntegration(settings)` (evaluado al conectar, gatea `web_search`/`web_fetch` en `toolCatalog()`) nunca veía la key, así que esas 2 tools **nunca aparecían** en el catálogo del modelo pese a que el usuario las configuraba y veía el mensaje *"API key de Tavily guardada."*.

**Fix**: una sola línea nueva en la allowlist del handler — `integrations: sanitized.integrations`. `sanitizeSettings()` ya preserva `integrations` intacto vía spread (`{...input, ...}`, no lo toca), así que `sanitized.integrations` es el valor correcto a reenviar, mismo patrón exacto que los otros 6 campos (todos leen de `sanitized`). El cifrado real de la apiKey lo hace `saveSettings()` aguas abajo — no se duplica en el handler. No se tocó `saveSettings()`/`loadSettings()` (ya correctos) ni los otros 6 campos.

### Verificación real

Ciclo save→load real a través del **handler REAL registrado** (`settings:save` capturado vía un `ipcMain` stub que registra los handlers), con `sanitizeSettings()`/`setSettings()`/`settings`/`saveSettings()`/`loadSettings()` reales de producción sobre disco aislado (`AMATISTA_STORAGE_ROOT`), bundle esbuild `--packages=external`. Único stub: el cifrado OS (`safeStorage`, reemplazado por un base64 con prefijo que hace round-trip fiel y deja evidencia de que cifró) y el transporte IPC — ambos DOWNSTREAM de y ORTOGONALES al bug de allowlist (que descarta `integrations` ANTES de que `saveSettings`/`safeStorage` corran). API key siempre sintética, nunca real.

- **ANTES del fix** (`git stash` al código de HEAD, rebundle): el handler devolvió `{success:true}` pero tras `loadSettings()` real la apiKey quedó `undefined`, `hasWebSearchIntegration=false`, y **nada cifrado en disco** — reproducción exacta del bug. Los 6 campos de la allowlist sí sobrevivieron (confirma que la causa es puntual: `integrations` faltaba, no un fallo general del handler).
- **CON el fix** (`git stash pop`, rebundle): mismo flujo — la apiKey sintética **sobrevivió el ciclo real** (`loaded.integrations.tavily.apiKey` idéntica a la guardada), `hasWebSearchIntegration(loaded)=true` (el sub-síntoma real: `web_search`/`web_fetch` entrarían al catálogo), en disco quedó `encryptedApiKey` presente y la key en claro **nunca** aparece en el JSON (cifrado real confirmado). No-regresión: los 6 campos de la allowlist siguieron guardándose con el valor del payload, idéntico a antes.

`npm run typecheck` y `npm run build` (con `mcp:lsp:bundle`) en verde.

Archivos: `src/main/ipc-settings.ts` (una línea agregada a la allowlist del handler `settings:save`). `saveSettings()`/`loadSettings()` sin tocar (ya correctos para `integrations`). Los otros 6 campos sin tocar. Sin commit — pendiente de que el usuario lo pida. Pendiente aún: Hallazgo 1 (`parallel_ask`/CLI-Codex idle) y Hallazgo 2 (`presets`, que además del handler necesita `saveSettings`/`loadSettings`), ver `verify_external_review_2_findings.md`.

## Fix real — `presets` se perdía en el guardado: 2 fallas apiladas (allowlist + capa de almacenamiento) (Hallazgo 2)

Basado en `docs/_arch/verify_external_review_2_findings.md` (Hallazgo 2, confirmado con evidencia real). A diferencia del Hallazgo 3 (Tavily, una sola falla en el handler), `presets` tenía **2 fallas independientes apiladas**: (1) el handler `settings:save` no lo incluía en su allowlist (mismo modo de falla que `integrations`); y (2) **peor** — `saveSettings()`/`loadSettings()` (`settings-store.ts`) tampoco lo contemplaban, ni existía en la interfaz `StoredSettings`. Aunque se arreglara solo el handler, `presets` se perdería en cada reinicio de la app — el bug histórico idéntico de `compactionProviderId`/`compactionModelId`, cuyo comentario en `settings-store.ts` (*"se perdian en cada reinicio... dentro de la misma sesion andaban bien, el bug era solo en el roundtrip a disco"*) describe textualmente lo que le pasaba a `presets`.

**Fix, 3 puntos**:
- **`StoredSettings`** (`settings-store.ts`): campo nuevo `presets?: AppSettings['presets']` (mismo criterio de tipo que `projectRoots`, sin import nuevo).
- **`saveSettings()`**: serialización **plana** directa `presets: settings.presets ?? []` — SIN cifrado (a diferencia de `providers`/`integrations`: un `Preset` = `{id, name, personaText, providerId?, modelId?}` no tiene ninguna credencial), mismo criterio que `projectRoots`. Siempre escribe un array para consistencia con el default de lectura.
- **`loadSettings()`**: `presets: stored.presets ?? []` — default a `[]` si el archivo es viejo y no tiene el campo (compatibilidad hacia atrás, mismo criterio que `projectRoots`).
- **Handler `settings:save`**: `presets: sanitized.presets` en la allowlist (`sanitizeSettings()` ya lo preserva intacto vía spread).

No se tocó `integrations` (fix del Hallazgo 3, recién aplicado) ni el cifrado de apiKeys.

### Verificación real

Ciclo save→load→**reinicio simulado** a través del handler real registrado (capturado vía `ipcMain` stub), con `sanitizeSettings`/`setSettings`/`settings`/`saveSettings`/`loadSettings` reales sobre disco aislado, bundle esbuild `--packages=external`. El "reinicio" se hizo en un **proceso Node SEPARADO** (`AMATISTA_STORAGE_ROOT` compartido, sin ningún estado en memoria heredado — los presets vienen 100% del archivo persistido). Único stub: cifrado OS + transporte IPC, ambos ortogonales a `presets` (que ni se cifra). Presets de prueba reales, sin credenciales.

- **ANTES del fix** (`git stash` al código de HEAD, rebundle): el handler devolvió `{success:true}` pero en disco los presets quedaron **AUSENTES** (el campo no se serializó), y tras el reinicio `loadSettings()` devolvió **0 presets** — reproducción exacta de las 2 fallas apiladas. Los otros campos plainos (compactionProviderId/turnWatchdogSeconds/imageGeneration*) sí sobrevivieron, confirmando que la causa es puntual de `presets` (e `integrations`, que en ese stash también estaba revertido por ser un cambio no committeado del mismo working tree).
- **CON el fix** (`git stash pop`, rebundle): proceso WRITE serializó 2 presets en disco (`personaText` en claro, confirmado sin cifrar); proceso READ separado (reinicio real) recuperó **los 2 presets completos** — `preset-1` con todos sus campos (`name`/`personaText`/`providerId`/`modelId`), `preset-2` con `providerId`/`modelId` correctamente `undefined` (campos opcionales ausentes preservados). No-regresión confirmada en el mismo proceso READ: `integrations.tavily.apiKey` (fix del Hallazgo 3) sobrevivió, `hasWebSearchIntegration=true`, y los 6 campos de la allowlist con su valor del payload.
- **Compatibilidad hacia atrás**: un `settings.json` viejo escrito a mano **sin** el campo `presets` → `loadSettings()` no rompió y devolvió `presets: []`.

`npm run typecheck` y `npm run build` (con `mcp:lsp:bundle`) en verde.

Archivos: `src/main/ipc-settings.ts` (allowlist del handler), `src/main/settings-store.ts` (`StoredSettings` + `saveSettings()` + `loadSettings()`). `integrations` y el cifrado de apiKeys sin tocar. Sin commit — pendiente de que el usuario lo pida. Pendiente aún: Hallazgo 1 (`parallel_ask`/CLI-Codex idle) — ver `verify_external_review_2_findings.md`.

## Fix real — Hallazgo 1: detección de ocupación unificada + guard de entrada + re-chequeo + cancelación real de CLI/Codex

Basado en `docs/_arch/verify_parallel_idle_detection_design.md` (diseño confirmado). El bug (confirmado en `verify_external_review_2_findings.md`): `currentTurnAbort` se seteaba SOLO en el branch API de `runTurnForWindow()`, así que `idlePanels()` (que filtraba por ese campo) clasificaba como idle un panel CLI/Codex ocupado — recibía una 2da sub-tarea concurrente — y `cancelSessionTurn()` era no-op para CLI/Codex. 5 piezas:

**PIEZA 1 — señal de ocupación unificada (`turnInFlight`)**: campo nuevo en `SessionRuntimeState`, seteado `true` al inicio de `runTurnForWindow()` ANTES de bifurcar por runtime, limpiado en un `finally` que cubre TODOS los caminos de salida (éxito/error/cancelación) de los 3 branches. Para lograr el `finally` universal sin reindentar ~245 líneas, el cuerpo se extrajo a `dispatchTurnForWindow(panelId, payload, session)` (verbatim, misma indentación) y `runTurnForWindow()` quedó como wrapper delgado (guard + set + `try/finally`). `currentTurnAbort` queda **desconflaciado**: sigue siendo el handle de cancel de API, `turnInFlight` es la señal de ocupación.

**PIEZA 2 — `idlePanels()` usa `turnInFlight`** (`parallel-orchestrator.ts`): fiable para los 3 runtimes; un runtime futuro (rama nueva en `dispatchTurnForWindow`) queda cubierto sin tocar `idlePanels()`.

**PIEZA 3 — guard de entrada** (`runTurnForWindow()`): si `turnInFlight` YA era `true` al entrar (chequeado ANTES de setearlo, para no rechazar el propio turno), rechaza con error claro. Vuelve la invariante "nunca 2 turnos concurrentes en el mismo panel" **auto-cumplida para TODOS los llamadores** (`parallel_ask`, `send_to_window`, `agent:send` del UI) — de paso tapa el gap preexistente de `send_to_window`, que nunca tuvo chequeo de ocupación.

**PIEZA 4 — re-chequeo en `runParallelAsk()`**: justo antes de cada dispatch (la ventana real es la espera de aprobación humana entre `planParallelAsk()` y `runParallelAsk()`), re-verifica `turnInFlight` fresco del panel asignado; si se ocupó → salta esa sub-tarea con error claro ("el panel X se ocupó entre la aprobación y la ejecución"), sin reencolar (rompería lo aprobado) ni esperar (bloqueo). Las demás siguen.

**PIEZA 5 — cancelación real CLI/Codex** (`cancelSessionTurn()` extendido + hook `cancelCurrentTurn` por sesión):
- **CLI**: `CliAgentRuntime.cancelTurn()` nuevo — mata `activeProcess` SIN el reset de `sessionId` que hace `stop()` (preserva la continuidad `--conversation` de Antigravity). El `dispatchTurnForWindow` CLI registra `session.cancelCurrentTurn = () => cliRuntime.cancelTurn()`. El turno cancelado se ve como sub-turno fallido (el kill hace rechazar `send()`), aceptable por diseño.
- **Codex**: sin `turn/interrupt` de protocolo enviable (`turn/cancelled` solo se escucha), la única cancelación real es matar el proceso (destructivo, requiere reconexión). **Sutileza crítica resuelta**: matar el proceso NO emite `turn/completed`, así que el `waitForCompletion` colgaría hasta 120s — se refactorizó el waiter para hoistear `finishTurn`, y el hook `session.cancelCurrentTurn` lo llama explícito (`turnCancelled=true` + `activeThreadId=null` para que el próximo turno dé el guard limpio + `client.stop()` + `finishTurn()`), desbloqueando el waiter en el acto. `cancelSessionTurn()` ahora cubre los 3: API (`currentTurnAbort.abort()`), CLI/Codex (`cancelCurrentTurn()`). `disconnectSession()` también invoca `cancelCurrentTurn?.()` antes de matar procesos (desbloquea un waiter Codex en vuelo al desconectar).

### Verificación real

4 harnesses contra código de producción real (`runTurnForWindow`/`dispatchTurnForWindow`, `cancelSessionTurn`, `idlePanels`/`runParallelAsk`, `sendToWindowByTitle`, `CliAgentRuntime.cancelTurn` reales), sin credenciales ni binarios externos. El "modelo" API es un servidor HTTP local real con respuesta RETENIBLE (turno genuinamente en vuelo); el app-server de Codex y el proceso CLI se sustituyen por stand-ins controlables SOLO donde no se puede tener el binario real (mismo criterio que el servidor HTTP hace de "modelo"), pero el CÓDIGO BAJO PRUEBA es real. Los 6 casos pedidos:

1. **Detección** (API con turno real retenido; Codex y CLI con turno retenido): `turnInFlight` es `true` durante el turno en los 3 runtimes, `idlePanels`-por-señal-real da `false` durante y `true` al terminar. Antes del fix, CLI/Codex daban idle=true durante un turno.
2. **Guard de entrada**: 2do `runTurnForWindow()` en un panel con turno en vuelo → rechazado con "Ya hay un turno en vuelo en este panel". `send_to_window` (vía `sendToWindowByTitle` real) a ese panel ocupado → `ok:false` porque el guard del destino rechaza — confirma la protección para llamadores además de `parallel_ask`.
3. **Re-chequeo**: `planParallelAsk()` repartió a 2 paneles; se marcó uno ocupado (`turnInFlight=true`) simulando la ventana de aprobación; `runParallelAsk()` saltó esa sub-tarea con el error claro y corrió la otra normal.
4. **Cancelación CLI**: `CliAgentRuntime.cancelTurn()` real contra un proceso hijo Node REAL (sleeper spawneado) → el proceso murió (evento `exit` real) y `sessionId` quedó PRESERVADO (a diferencia de `stop()`). El hook del dispatch enrutó `cancelSessionTurn()` → `cliRuntime.cancelTurn()`, `turnInFlight` limpiado.
5. **Cancelación Codex (la crítica)**: turno Codex en vuelo (waiter esperando `turn/completed` que nunca llega) → `cancelSessionTurn()` resolvió `runTurnForWindow` en **0ms** (NO 120s — el waiter abort-aware funcionó), `cancelled:true`, `client.stop()` llamado, `activeThreadId=null`, `turnInFlight`/`cancelCurrentTurn` limpiados. Reconexión confirmada: un turno normal posterior (codexClient nuevo) completó bien.
6. **No-regresión**: cancelación API (`currentTurnAbort`) sigue devolviendo `cancelled:true` en ~3ms; turno normal completo en los 3 runtimes (API/Codex/CLI) limpia `turnInFlight` en el `finally`; un turno normal Codex/CLI NO mata su cliente.

`npm run typecheck` y `npm run build` (con `mcp:lsp:bundle`) en verde.

Archivos: `src/main/ipc-agent.ts` (wrapper `runTurnForWindow` + `dispatchTurnForWindow` extraído + hooks CLI/Codex + waiter Codex abort-aware), `src/main/runtime-state.ts` (`turnInFlight`/`cancelCurrentTurn` en `SessionRuntimeState` + `createEmptySession` + `cancelSessionTurn` extendido + `disconnectSession`), `src/main/parallel-orchestrator.ts` (`idlePanels` por `turnInFlight` + re-chequeo), `src/main/cli-agent-runtime.ts` (`cancelTurn()` nuevo). Cancelación de API sin cambios de comportamiento. Sin commit — pendiente de que el usuario lo pida.

## Fix real — 8 de 10 lenguajes LSP nuevos integrados (Dart, Gleam, Clojure, Typst, Zig, Svelte, Astro, Prisma)

Basado en `docs/_arch/verify_lsp_10_remaining.md` (los 10 ya verificados con evidencia real) — esto es solo la integración al esquema config-driven ya existente (`LANGUAGE_SERVERS`), mismo patrón que Terraform/Lua/YAML/ESLint/Bash. `Deno` y `Nix` quedan fuera a propósito, con la misma evidencia real que ya los descartó: Deno colisiona de extensión (`.ts`/`.js`) con `typescript-language-server`/`eslint-language-server` ya en producción — `languageServerConfigFor()` resuelve un solo config por extensión, agregar Deno robaría esas extensiones sin ningún mecanismo de arbitraje por workspace; Nix (`nixd`/`nil`) no tiene ningún binario real publicado para Windows (46 releases combinadas revisadas, `assets:[]` en todas).

**Los 5 "LISTO TAL CUAL"** — entradas nuevas en `LANGUAGE_SERVERS`, sin ningún cambio de esquema:
- **Dart**: `dart language-server --protocol=lsp` (binario externo, detección por PATH). El flag `--protocol=lsp` es explícito pese a ser default en la versión verificada (3.13.3) — un default puede cambiar, el protocolo propio (`analyzer`, sin framing `Content-Length`) sigue existiendo y nunca debe invocarse por accidente.
- **Gleam**: `gleam lsp` (el compilador incluye el LSP, sin binario separado).
- **Clojure**: `clojure-lsp` (binario nativo GraalVM, sin flags) — el "ajuste" que la investigación pedía YA se resolvió hoy antes de esta fase: el bug de enrutamiento de `handleChunk()` (commit `1c66b27`) era la única razón real por la que integrarlo tal cual era inseguro. Se agrega ahora como cualquier binario externo simple, sin ningún ajuste adicional.
- **Typst**: `tinymist lsp` (binario nativo oficial).
- **Zig**: `zls` (binario nativo, autodetecta `zig.exe` por el PATH heredado del proceso hijo — sin necesitar `env.PATH` extra como Go). `installHint` documenta la limitación real de producto (no de código): sin un step `check` en el `build.zig` del usuario, solo hay diagnósticos de sintaxis, nunca de tipos.

**Los 3 "CON AJUSTES"**:
- **Astro** (`@astrojs/language-server`, bundleado vía npm — `@astrojs/language-server@^2.16.16` nuevo en `dependencies`/`asarUnpack`): necesita `initializationOptions.typescript.tsdk` real en el propio `initialize` — campo NUEVO en `LanguageServerConfig` (`initializationOptions?: (workspace) => Promise<unknown> | unknown`, wireado en `LspClient.start()`, `undefined` para todos los lenguajes previos = cero cambio de comportamiento). Resuelto reusando el TypeScript YA bundleado de Amatista (`resolveBundledTypescriptLibDir()`, mismo cálculo de base asar/asar.unpacked que `resolveBundledServerEntry()`, apuntando a `node_modules/typescript/lib` — confirmado real que trae `tsserverlibrary.js`) — sin instalar una copia aparte.
- **Prisma** (`@prisma/language-server`, bundleado vía npm — pineado a `6.19.0-hotfix.1`, dist-tag `integration`, NO la versión `latest` de npm (31.12.8, que empaqueta un CLI de Prisma 7 dev con ruido de "deprecación" sobre `url = env(...)`, la sintaxis estándar de Prisma 5/6 que usa la mayoría de schemas reales): `configResponses:{prisma:{}}` es obligatorio, no cosmético — confirmado real que responder `null` genérico (el default de este archivo) CRASHEA el proceso entero al abrir el primer archivo (único servidor de los 20 con esta intolerancia).
- **Svelte** (`svelte-language-server`, bundleado vía npm): sin ajustes de código en realidad — pull-diagnostics real, ya cubierto por el mecanismo genérico existente (`pullDiagnostics()`/`supportsCapability()`), sin `initializationOptions` (a diferencia de Astro, confirmado que no exige `tsdk`).

### Verificación real

10 casos (los 8 nuevos + 2 de no-regresión) contra `LspClient`/`languageServerConfigFor()` REALES de producción (cero mocks), con los mismos binarios externos ya descargados/verificados en la investigación (reusados del scratchpad) y las 3 dependencias npm recién instaladas — un archivo de prueba real con un error puesto a propósito por lenguaje, `didOpen` real, diagnóstico real confirmado (no solo "arranca"):

- **Dart, Gleam, Clojure, Typst, Zig, Svelte, Astro, Prisma**: los 8 recibieron su diagnóstico real esperado (tipo, sintaxis, o símbolo no resuelto según el caso) — incluida **Clojure completando el handshake sin colgarse** (8 diagnósticos reales en ~3s, confirmando que el fix de `handleChunk()` de hoy lo desbloqueó de verdad) y **Prisma sin crashear** (diagnóstico real recibido, proceso vivo durante toda la sesión).
- **Hallazgo real durante la verificación (harness, no producción)**: el primer intento de Zig falló — no por el código de integración, sino por 2 bugs del *fixture* de prueba armado a mano: un `fingerprint` inventado en `build.zig.zon` (Zig 0.16 lo valida real y lo rechaza) y el error puesto en un archivo (`broken.zig`) que nunca estaba referenciado por el grafo de compilación del `build.zig` (Zig no compila archivos no importados desde el entry point) — confirmado con `zig build check` directo. Corregidos ambos en el fixture (fingerprint real que el propio compilador sugirió, error movido a `src/main.zig`, el archivo real compilado), el diagnóstico llegó real (~10s cold / ~1.3s warm, coincide con lo medido en la investigación). Prisma tuvo un timeout aislado en una corrida (funcionó perfecto aislado y en la re-corrida completa) — transitorio, no reproducido una segunda vez, no atribuible a la config.
- **No-regresión**: TypeScript (push) y ESLint (pull) — los 2 de los 12 ya en producción probados — dieron su diagnóstico real idéntico a siempre.

`npm run typecheck` y `npm run build` (con `mcp:lsp:bundle`) en verde.

Archivos: `src/main/lsp-client.ts` (8 `resolveXCommand()` nuevos + 8 entradas en `LANGUAGE_SERVERS` + campo `initializationOptions` nuevo en `LanguageServerConfig` + `resolveBundledTypescriptLibDir()`), `package.json`/`package-lock.json` (`@astrojs/language-server`, `svelte-language-server`, `@prisma/language-server@6.19.0-hotfix.1` en `dependencies` + `asarUnpack`). Los 12 lenguajes ya en producción sin ningún cambio. Sin commit — pendiente de que el usuario lo pida.

## Fix real — `isWithinFolder()`: `projects:removeRoot` comparaba pertenencia de carpeta con `startsWith` (substring, no ruta real)

Hallazgo de la 3ra revisión externa (`docs/_arch/PENDING.md`). `ipc-projects-workspace.ts:60` (dentro de `projects:removeRoot`) usaba `session.activeWorkspace.startsWith(root.path)` para decidir si una sesión conectada quedaba dentro de la carpeta que se está removiendo — una comparación de **string**, no de pertenencia real de ruta.

**Reproducido real ANTES del fix**: con 2 carpetas reales hermanas (`...\Proyecto` y `...\ProyectoExtra`, la 2da NO es subcarpeta de la 1ra, solo comparte el prefijo de texto), una sesión conectada a `ProyectoExtra` se desconectaba por error al borrar el `projectRoot` de `Proyecto` — el bug tal cual se especulaba, confirmado con código de producción real. Se confirmó además un 2do bug en el mismo `startsWith`, en sentido inverso: una sesión con `activeWorkspace` de casing distinto al de `root.path` para la MISMA carpeta real de Windows daba **falso negativo** — no se desconectaba pese a corresponder genuinamente a la carpeta borrada.

**Fix**: `isWithinFolder(parent, candidate): boolean` nueva, exportada en `runtime-state.ts` junto a `assertInsideWorkspace()` — que ahora la reusa internamente (extracción pura, cero cambio de comportamiento propio, ya tenía exactamente esta misma lógica de `path.relative()` duplicada). `isWithinFolder()` NO llama `realpathSync()` (a diferencia de `assertInsideWorkspace()`): `root.path`/`activeWorkspace` ya vienen canonicalizados una sola vez al guardarse (`projects:addRoot`/`workspace:open`), y forzar un `realpathSync()` nuevo en el momento de la comparación rompería el caso legítimo de una carpeta ya borrada del disco (el usuario borra la carpeta real y después quiere sacar de la lista el `projectRoot` huérfano — eso no debería tirar `ENOENT`). Confirmado real (Node en Windows, `path.win32.relative()`) que la comparación ya es case-insensitive por sí sola — `path.win32.relative('C:\Proyecto','c:\proyecto')` da `''`, `path.win32.relative('C:\Proyecto','C:\ProyectoExtra')` da `'..\ProyectoExtra'` (afuera) — no hizo falta normalizar a lowercase a mano. `ipc-projects-workspace.ts` reemplaza el `startsWith` por `isWithinFolder(root.path, session.activeWorkspace)`; ningún otro comportamiento de `projects:removeRoot` tocado.

### Verificación real

Harness contra código de producción real (`registerProjectsAndWorkspaceIpc()`, `sessionRegistry`/`settings`/`disconnectSession` reales de `runtime-state.ts`, misma instancia de módulo vía bundling compartido — cero mocks del código bajo prueba), bundle esbuild `--packages=external`, único stub `electron` (`dialog`/`ipcMain`/`safeStorage`/`app`, reusando `tavily_fix/electron-stub.cjs`). 5 sesiones reales contra carpetas reales en disco (`Proyecto`, `Proyecto\Sub`, `ProyectoExtra`, `Unrelated`):

- **ANTES del fix** (código de HEAD, sin tocar): `legit_desconectada:true` (correcto), **`collision_desconectada:true`** (el bug — `ProyectoExtra` se desconectó por error), `unrelated_desconectada:false` (correcto), `exact_desconectada:true` (correcto), **`casemixed_desconectada:false`** (el 2do bug — no desconectó una sesión que sí correspondía a la misma carpeta real, por diferencia de casing en el string).
- **CON el fix**: `legit_desconectada:true` (sin regresión), **`collision_desconectada:false`** (bug resuelto — `ProyectoExtra` ya no se ve afectado), `unrelated_desconectada:false` (sin regresión), `exact_desconectada:true` (sin regresión, raíz exacta sigue desconectando), **`casemixed_desconectada:true`** (2do bug resuelto — casing mezclado real de Windows para la misma carpeta ahora sí desconecta).

`npm run typecheck` y `npm run build` (con `mcp:lsp:bundle`) en verde.

Archivos: `src/main/runtime-state.ts` (`isWithinFolder()` nueva + `assertInsideWorkspace()` refactorizada para reusarla), `src/main/ipc-projects-workspace.ts` (`projects:removeRoot` usa `isWithinFolder()` en vez de `startsWith`). Ningún otro comportamiento de `removeProjectRoot` tocado. Sin commit — pendiente de que el usuario lo pida.

## Fix real — TOCTOU de `write_file`/`apply_patch`/`revert_file` bajo concurrencia real de `parallel_ask` (Opción A2) + contención de git entre archivos distintos

Basado en `docs/_arch/verify_parallel_staleness_reopened.md` (hueco confirmado: clobber silencioso 25/25 con 2 paneles `danger-full-access` sobre el mismo archivo) y `docs/_arch/verify_toctou_parallel_fix_design.md` (diseño elegido, medido antes de implementar: Opción A2 sobre B/C, más un fix separado para la contención de git). 2 piezas.

**PIEZA 1 — Opción A2, aplicada a las 3 rutas de escritura** (`write_file`, `apply_patch`, `revert_file` en `tool-registry.ts`): el orden viejo era chequeo → `await snapshotFile()` (un solo commit del `'original'` + `newContent` juntos, ANTES del `writeFileSync`) → escritura real. El `await` de `snapshotFile()` cede el event loop (subprocesos git reales, ~360-770ms) — la ventana real entre el chequeo de staleness y la escritura, donde 2 paneles podían leer el mismo estado "aún original" y pisarse en silencio. Fix: `snapshotFile()` partida en `local-vcs.ts` en **`snapshotOriginalIfNeeded()`** (solo archiva el `'original'`, nunca el resultado de la escritura en curso — llamada ANTES del re-chequeo) y **`commitVersion()`** (commitea `newContent`, llamada DESPUÉS del `writeFileSync` real — nunca se alcanza si el re-chequeo rechazó). El re-chequeo de hash (el mismo que ya existía) queda ahora **pegado, sin ningún `await` de por medio, al `writeFileSync`** — en el event loop mono-hilo de Node, un tramo síncrono no puede ser interleaveado por el turno de otro panel, así que el chequeo y la escritura quedan atómicos por construcción del scheduler, sin necesidad de ningún lock explícito (Opción B, descartada por el diseño: no mejora el desenlace y depende de una sección crítica sin timeout).

**PIEZA 2 — Cola de ejecución por-repo + timeout real en `runGit()`** (`local-vcs.ts`): hallazgo secundario de la investigación — 2 paneles escribiendo archivos DISTINTOS del MISMO workspace comparten el mismo repo VCS oculto (por-workspace, no por-archivo) y sus comandos git colisionaban de verdad (`index.lock`/`cannot lock ref HEAD`, 10/20 fallos medidos). `runGit()` ahora encola TODO comando git contra un mismo `cwd` (`repoQueues: Map<string, Promise<unknown>>`, tail-chaining con `.catch(() => undefined)` para que un fallo de un llamador no tumbe la cola de los siguientes) — deliberadamente distinto del lock por-archivo de PIEZA 1 (propósito distinto: serializar el binario git, no bloquear contenido). Además, `execFileAsync('git', ...)` no tenía NINGÚN timeout (confirmado literal) — se agregó `timeout: GIT_TIMEOUT_MS` (15s, mismo criterio de `guard/` de hoy) para que un git realmente colgado (hook lento, antivirus, filesystem de red) no cuelgue la cola —y con ella a cualquier panel que escriba a ese repo— para siempre.

### Verificación real

Harness contra `ToolRegistry`/`snapshotOriginalIfNeeded`/`commitVersion`/`runGit` reales (UNA instancia de `ToolRegistry`, como el singleton compartido por todos los paneles en producción), git real, cero mocks del mecanismo. 5 casos:

1. **Clobber cerrado en TODO el rango 0-800ms** (antes: `SILENT_CLOBBER` 25/25 en 0-200ms): con el fix, `STALENESS_CAUGHT` **6/6 en cada uno** de los offsets 0/10/25/50/100/200/400/800ms — incluida simultaneidad genuina (offset 0ms), donde antes el clobber era total.
2. **Cero commits huérfanos**: 2 paneles reales al mismo archivo, uno rechazado por staleness — el historial VCS real del archivo (`listFileHistory`) nunca contiene el contenido del panel rechazado (confirmado leyendo cada versión real del historial con `readFileVersion` y comparando byte a byte). Antes del reordenamiento (medido en el diseño con un prototipo fiel): 12/12 commits huérfanos.
3. **Contención de git resuelta**: 2 paneles a 10 pares de archivos DISTINTOS del mismo workspace, escritura concurrente real — **0/20 fallos/avisos** de versionado (antes del fix: 10/20).
4. **Timeout real de un git genuinamente colgado**: un hook `pre-commit` REAL (`#!/bin/sh\nsleep 999999`, plantado en el repo VCS oculto real tras un primer write_file de bootstrap normal) hace que el `git commit` REAL de la siguiente escritura se cuelgue de verdad — `write_file` resolvió en **15397ms** (el `GIT_TIMEOUT_MS` configurado), con `ok:true` y el contenido nuevo real ya en disco (la escritura real nunca esperó al timeout, solo el respaldo VCS lo hizo) y el AVISO correspondiente en el output. Nota de diseño: un shim de PATH (`git.cmd` que cuelga) NO sirve para este caso — confirmado real que la resolución de PATHEXT de Node/libuv en Windows es por-extensión (revisa `.exe` en todas las carpetas de PATH antes que `.cmd` en cualquiera), así que el git.exe real siempre gana; el hook real es la forma fiel de forzar un cuelgue genuino del binario real.
5. **No-regresión, 1 solo panel**: `write_file`/`apply_patch`/`revert_file` reales sin concurrencia — comportamiento idéntico al de antes (el re-chequeo síncrono siempre pasa sin nadie más tocando el archivo), incluido un `revert_file` real restaurando una versión del historial que el propio `write_file` anterior generó.

`npm run typecheck` y `npm run build` (con `mcp:lsp:bundle`) en verde.

Archivos: `src/main/local-vcs.ts` (`snapshotFile()` partida en `snapshotOriginalIfNeeded()`/`commitVersion()`; `runGit()` con cola por-repo + `GIT_TIMEOUT_MS=15000`), `src/main/tool-registry.ts` (las 3 rutas de escritura reordenadas: chequeo temprano → `snapshotOriginalIfNeeded()` → re-chequeo síncrono pegado al write → `writeFileSync` → `commitVersion()`). Ningún otro comportamiento tocado — la Opción B (lock por-archivo) fue descartada explícitamente por el diseño, nunca implementada. Sin commit — pendiente de que el usuario lo pida.

## Fix real — TOCTOU de compactación: watermark colgante + resurrección de resumen (`maybeCompactChatInBackground`)

Basado en `docs/_arch/verify_compaction_toctou.md` (2 modos de falla confirmados y medidos, alcanzables con un solo panel — el `fire-and-forget` de la compactación libera `turnInFlight` antes de resolver, y `chats:deleteMessagesFrom` no tiene ningún guard). Ambos modos comparten la misma causa raíz: `maybeCompactChatInBackground()` nunca re-chequeaba si el historial cambió entre que arrancó (lectura de `state`/`backlog`, síncrona) y que persistía su resultado (`setChatSummaryState()`, incondicional) tras el único `await` largo de la función (`callCompactionModel()`, llamada HTTP real).

**Fix**: `getLastMessageId(chatId)` nueva en `chat-store.ts` — firma barata (el `id` del último mensaje real de la cola, `null` si vacía) capturada al ARRANCAR `maybeCompactChatInBackground()` (antes de `callCompactionModel()`), re-consultada SINCRÓNICAMENTE justo antes de `setChatSummaryState()` (sin ningún `await` entre esa comparación y la escritura). Si no coincide con la capturada al arrancar — el historial cambió mientras la llamada estaba en vuelo (mensaje borrado/editado vía `deleteChatMessagesFrom()`, o un turno nuevo agregado) — el resultado de esa pasada se descarta por completo, sin llamar `setChatSummaryState()`. Los `id` de mensaje son `randomUUID()` reales del renderer, nunca se reutilizan, así que una comparación de igualdad simple alcanza: cualquier cambio real en la cola del chat (agregar, o borrar+reemplazar desde cualquier punto — `deleteChatMessagesFrom()` siempre borra "desde X hasta el final") produce un `id` de cola distinto. Fire-and-forget preservado — sin ningún error visible, la próxima pasada recalcula desde el estado real y vigente.

### Verificación real

Mismo método de la investigación (harness contra `chat-store.ts`/`compaction-engine.ts` reales, SQLite real, servidor HTTP local real y retenible parado en el modelo de compactación, cero mocks del mecanismo), reproduciendo EXACTAMENTE los 2 escenarios que expuso `verify_compaction_toctou.md`:

- **Caso A (watermark colgante)**: edición concurrente borra el mensaje que sería el nuevo watermark mientras la llamada real sigue en vuelo. Antes del fix: `watermark="a-22"` persistido apuntando a un mensaje ya borrado (`getMessagesAfter()` devolvía `0` para siempre, incluso agregando mensajes nuevos reales). Con el fix: `estado final tras la pasada: null` — el resultado se descartó por completo, cero watermark colgante.
- **Caso B (resurrección)**: una edición real invalida el resumen correctamente (`null`, confirmado que `invalidateSummaryIfWatermarkMissing()` corrió bien), y una compactación vieja ya en vuelo resuelve después. Antes del fix: el `null` correcto se sobreescribía con un resumen resucitado que describía el contenido ya borrado. Con el fix: `estado final tras resolver el PASE 2: null` — la invalidación de la edición sobrevive intacta, la pasada vieja se descartó sin persistir nada.
- **No-regresión (Caso C)**: 2 pasadas de compactación consecutivas, sin ninguna edición concurrente — ambas persistieron su watermark (apuntando a un mensaje real de esa pasada) y su resumen real, comportamiento idéntico al de antes.

`npm run typecheck` y `npm run build` (con `mcp:lsp:bundle`) en verde.

Archivos: `src/main/chat-store.ts` (`getLastMessageId()` nueva), `src/main/compaction-engine.ts` (firma capturada al arrancar + re-chequeo síncrono antes de `setChatSummaryState()`). Ningún otro comportamiento de `maybeCompactChatInBackground()` tocado — el caso sin concurrencia sigue idéntico. Sin commit — pendiente de que el usuario lo pida.

## Fix real — menú de modelo del panel no se desplegaba (`overflow-y: hidden` recortaba `.model-menu`)

Bug reportado por el usuario en vivo (captura real): el selector "Antigravity Auto" del header de panel no abría ningún menú al clickear. Diagnosticado con certeza en el código real (sin necesitar tocar la app corriendo): `.model-menu` (`position: absolute`, se despliega hacia abajo desde `.model-anchor`) es descendiente de `.panel-header-actions`, que tiene `overflow-y: hidden` (introducido en `0bb6ce43`, 2026-09-02, como efecto colateral de habilitar scroll horizontal para el cluster de botones del header en paneles angostos — confirmado con `git blame` que NO es un cambio de esa sesión). El click SÍ disparaba `setModelMenuOpen(true)` y React SÍ renderizaba `.model-menu` en el DOM — pero `overflow-y: hidden` lo recortaba a prácticamente 0px visibles, ya que `.panel-header-actions` mide solo la altura del botón (contenido en flujo normal; un descendiente `position:absolute` nunca contribuye a la altura del contenedor).

**Primer intento (descartado con evidencia real)**: cambiar `overflow-y: hidden` → `visible` en `.panel-header-actions`, dejando `overflow-x: auto` intacto. Confirmado real, con la app corriendo, que Chromium aplica la regla del spec de CSS Overflow que convierte el valor USADO de un eje `visible` en `auto` cuando el otro eje no es `visible` — con `overflow-x: auto` ya explícito, `overflow-y: visible` terminaba computando `overflow-y: auto` de verdad: el menú aparecía, pero como una cajita con scroll interno diminuto e inutilizable, no un menú flotante normal (confirmado visualmente por el usuario).

**Fix real definitivo**: `.model-menu` se renderiza vía **React Portal** directo a `document.body` (`createPortal`, `App.tsx`) — sale del árbol DOM de `.panel-header-actions` por completo, así que ningún `overflow` de ese contenedor (ni de ningún otro panel) puede recortarlo nunca más. `position: fixed` con coordenadas en píxeles reales de viewport (`top`/`right`) calculadas vía `modelBtnRef.current.getBoundingClientRect()` en el momento de abrir, reemplazando el `position: absolute` relativo a `.model-anchor` (que dejó de aplicar). `overflow-y: hidden` de `.panel-header-actions` queda **byte-idéntico al original** (confirmado con `git diff`, cero cambios en esa línea) — el scroll horizontal de `0bb6ce43` intacto, sin ninguna necesidad de tocarlo: el menú ya no tiene ningún motivo para desbordarse dentro de ese contenedor.

### Verificación real

Con la app corriendo en modo desarrollo (HMR, sin reiniciar el proceso) y el usuario probando en vivo: el intento inicial (`overflow-y: visible`) confirmó real el problema del "swap a auto" del spec (captura del usuario: cajita con scrollbar diminuto, no un dropdown). Con el fix del portal aplicado en caliente (HMR aplicó los 2 archivos, `main.css` y `App.tsx`, sin perder el estado de la app ni la conexión de Tavily ya configurada por el usuario): el usuario confirmó con una captura real, 3 paneles reales, el menú del panel 3 desplegado como un menú flotante normal, superpuesto sobre los paneles 2 y 3, mostrando los 6 proveedores/modelos reales de su configuración (Anthropic ×2, Codex ChatGPT, Antigravity ×2, DeepSeek). `npm run typecheck` y `npm run build` en verde en cada iteración.

Archivos: `src/renderer/src/App.tsx` (`createPortal`, `modelBtnRef`, `modelMenuPos`, cálculo de posición al abrir), `src/renderer/src/assets/main.css` (`.model-menu` sin `position`/`top`/`right` forzados; `.panel-header-actions` revertido byte-idéntico al original). Sin commit — pendiente de que el usuario lo pida.

## Fix real — `addProvider()` sin deduplicación creaba conexiones por-suscripción duplicadas

Causa raíz real de los duplicados de "Anthropic"/"Antigravity" en el menú de modelo (hallazgo de una sesión de depuración en vivo con el usuario, `settings.json` real llegó a tener 3 conexiones Anthropic y 2 de Antigravity). `addProvider(type, authMode)` ([App.tsx:3650](src/renderer/src/App.tsx:3650)) — el handler real detrás de los botones "+ Agregar conexión" — creaba una conexión nueva **siempre**, sin chequear si ya existía una del mismo `type`+`authMode`, a diferencia de `loginCodex()` (que sí hace ese chequeo antes de crear). Cada click en "Claude Pro/Antigravity Suscripción" del grid producía una copia nueva, indistinguible de la anterior en el dropdown (mismo bug de UX ya documentado en el fix anterior del menú de modelo).

**Fix**: mismo chequeo que `loginCodex()`, acotado a `authMode === 'subscription'` — si ya existe un proveedor con ese `type`+`authMode`, no se crea uno nuevo (se avisa con `setNotice()`, sin fallar en silencio). Acotado a `subscription` a propósito: esas conexiones se autentican por sesión del sistema operativo (confirmado real: la cuenta de Claude vive en la sesión del CLI `claude`, la de Antigravity en el keyring de Windows) — 2 conexiones del mismo `type`+`subscription` SIEMPRE son la misma cuenta real, nunca 2 cuentas distintas. Las conexiones `authMode:'api-key'` (Claude vía Azure, OpenAI-compatible, OpenRouter, etc.) quedan sin tocar — ahí sí tiene sentido real agregar más de una (endpoints/keys genuinamente distintos).

**Limpieza real aplicada** (una sola vez, sobre `settings.json` real del usuario, replicando exactamente los efectos reales de `deleteProvider()`/`updateProvider()`, sin usar la UI por no poder controlar la ventana de desarrollo vía automatización — confirmado imposible con las herramientas disponibles en esta sesión): agregados **Claude Haiku** y **Claude Fable** a `qcfg-claude-subscription` (los 4 modelos reales confirmados con turnos reales exitosos contra la cuenta `Claude Max` del usuario, tras confirmar con `/model` real que son los únicos 4 modelos genuinamente distintos — el resto de las entradas de `/model`, `best`/`opusplan`/`sonnet[1m]`/`opus[1m]`/`fable[1m]`/`default`, son aliases/variantes de esos mismos 4, confirmado real probando cada uno); borradas las 3 conexiones duplicadas (`28903fc9-...`, `b0a22955-...`, `74884a70-...`). Reflejado en la app real mediante reinicio limpio (necesario: el estado en memoria del renderer no recarga `settings.json` en caliente).

### Verificación real

`settings.json` real tras el reinicio: exactamente 4 proveedores (`qcfg-claude-subscription` con 4 modelos habilitados, `qcfg-antigravity-subscription`, Codex, DeepSeek) — ninguno de los 3 ids borrados presente; ningún campo global (`activeProviderId`/`compactionProviderId`/`imageGenerationProviderId`/`presets`) apunta a un id borrado. Base de datos real de chats: los 2 chats reales de las conexiones `qcfg-*` (Panel 8, Panel 9) intactos; el único chat que referenciaba una conexión borrada (`b0a22955-...`, 0 mensajes reales) queda con `provider_id` huérfano — comportamiento real y documentado de `deleteProvider()` (nunca borra `chat_sessions`, `pickProvider()` cae a otra conexión con aviso visible en el próximo turno). Dedup verificado con una traza real contra el `settings.providers` ya recargado: `addProvider('anthropic','subscription')` encuentra `qcfg-claude-subscription` como existente y bloquea la creación. `npm run typecheck`/`npm run build` en verde.

Archivos: `src/renderer/src/App.tsx` (`addProvider()`). `settings.json`/`amatista.db` del usuario (datos reales, fuera del repo). Sin commit — pendiente de que el usuario lo pida.

## Fix real — botón "Actualizar modelos" por conexión (Claude/Antigravity/Codex, mecanismo distinto por proveedor)

Basado en `docs/_arch/verify_model_refresh_design.md` (confirmado real: Antigravity y Codex tienen descubrimiento real y en vivo, mejor que Claude; Claude depende de extracción heurística + verificación real obligatoria por candidato). Botón nuevo junto a cada conexión de suscripción en Configuración → Conexiones (`connection-actions`), NO uno global — la diferencia real de tiempos entre proveedores (segundos vs. milisegundos) haría confuso un botón único.

**Contrato común a los 3, sin excepción**: solo AGREGA modelos genuinamente nuevos (que la conexión no tenga ya) — nunca toca, reemplaza, ni re-verifica lo existente. Los retirados no se detectan proactivamente (decisión explícita del diseño): si una versión ya agregada se retira, se descubre al usarla, con el mismo error real y claro que el CLI ya da (`"Claude Opus 4 was retired on..."`).

**Mecanismo por proveedor** (`src/main/model-discovery.ts`, nuevo):
- **Claude** (`discoverNewClaudeModels`): sin comando/API real de listado — candidatos reales de 2 fuentes de texto combinadas (`~/.claude/cache/changelog.md`, incompleto por sí solo — confirmado real que no menciona Haiku 4.5 — + el binario `claude.exe` instalado, escaneados con el patrón anclado confirmado sin falsos positivos `claude-(sonnet|opus|haiku|fable)-\d...`), deduplicados por forma base (sin sufijo de fecha ni `-v1`), filtrados contra lo ya existente (**también comparado por forma base**, no por string exacto — ver el bug real encontrado y corregido más abajo), y verificados uno por uno con un turno real mínimo (`claudeCommand()` reusado de `cli-agent-runtime.ts`, ahora exportado), concurrencia acotada en 5.
- **Antigravity** (`discoverNewAntigravityModels`): comando real y directo `agy models` (parseado tab-separated), sin verificación adicional — confirmado real con un spot-check (turno real contra un modelo recién listado) que "listado" ya implica "accesible" para esta cuenta.
- **Codex**: reusa el mecanismo YA EXISTENTE en producción (`codexAccountBridge.listModels()`, IPC `codex:modelList`/`listCodexModels()`) — sin código de descubrimiento nuevo. El merge en `App.tsx` es "solo agregar" (filtra contra lo existente antes de construir los `ModelProfile` nuevos), a diferencia de `syncCodexProvider()` (reemplazo completo) que sigue intacta y sin tocar para su propio flujo de login.

**Bug real encontrado y corregido durante la propia verificación de esta tarea** (no en un fix separado — antes de reportar nada como cerrado): el filtro "ya existe" de Claude comparaba el candidato representante contra el string EXACTO de lo ya existente — fallaba cuando lo existente está pinneado con sufijo de fecha (`claude-haiku-4-5-20251001`, ya agregado hoy) y el candidato nuevo resuelve a la forma base sin fecha (`claude-haiku-4-5`) — mismo modelo real, 2 strings distintos, se agregaba igual como "nuevo" pese a ser un duplicado funcional. Corregido comparando por forma base en ambos lados. **Consecuencia real**: el build viejo (antes del fix) alcanzó a correr real en la app ya viva y agregó este duplicado funcional al `settings.json` real del usuario (2 filas "Claude Haiku 4.5", ids distintos) — se identificó y removió la fila puntual del bug (`4020ac81-...`, `model:"claude-haiku-4-5"`), conservando la original ya confirmada (`qcfg-claude-subscription-haiku`, `claude-haiku-4-5-20251001`).

### Verificación real

Harness contra las funciones EXACTAS que invoca el botón (`discoverNewClaudeModels`/`discoverNewAntigravityModels` reales, `codexAccountBridge.listModels()` real), leyendo el `settings.json` real del usuario en vivo (no un snapshot — se encontró y corrigió un segundo bug metodológico propio: `require()` de un `.json` hace que esbuild lo empaquete por valor al momento del build, no relee disco — corregido a `readFileSync`+`JSON.parse`). Con el fix aplicado y el duplicado ya removido: **Claude 0 nuevos (13 existentes, ninguno duplicado), Antigravity 0 nuevos (15 existentes), Codex 0 nuevos (6 existentes)** — estado convergente, correcto tras la corrida real anterior ya haber capturado todo lo descubrible. Tiempos reales medidos: **Claude ~14.3s** (14 turnos reales de verificación secuenciales-por-lote), **Antigravity ~2.9s** (1 comando real), **Codex ~0.16s** (1 RPC real) — confirma la diferencia de orden de magnitud que motivó el botón por-conexión en vez de uno global. `npm run typecheck`/`npm run build` en verde.

Archivos: `src/main/model-discovery.ts` (nuevo), `src/main/cli-agent-runtime.ts` (`claudeCommand`/`antigravityCommand` exportadas, cero cambio de comportamiento), `src/main/ipc-cli.ts` (2 handlers nuevos), `src/preload/index.ts`/`index.d.ts` (bindings), `src/renderer/src/App.tsx` (`supportsModelRefresh`, `refreshModelsForProvider`, botón en `connection-actions`). `settings.json` real del usuario: duplicado puntual del bug removido. Sin commit — pendiente de que el usuario lo pida.

## Fix real — descubrimiento real de deployments para Foundry + `mergeFoundryQAssistantModels()` contaminaba cualquier conexión Foundry

Motivado por un usuario bloqueado en vivo: conexión Foundry recién creada sin ninguna sección de modelos en la UI (`type==='foundry'` estaba afuera del único bloque que lista/edita modelos, acotado a `openrouter`/`openai-compatible`/`openai`). Implementado `foundry-catalog.ts` (nuevo) + IPC `foundry:listModels` + sección nueva "Modelos de Foundry" en Settings (botón "Sincronizar deployments" + "+ Agregar modelo manual" + lista existente con Activar/Desactivar/Eliminar).

**2 iteraciones reales del endpoint, corregidas con evidencia real del usuario**:
1. Primer intento: `GET {endpoint}/openai/v1/models` (superficie "v1" unificada, misma base que `sendFoundry()`/`normalizeFoundryBaseUrl()` ya usan para `/responses`). Confirmado real por el usuario que este endpoint devuelve el catálogo AMPLIO de la plataforma, no los deployments reales de su recurso — el usuario tiene 1 deployment real, aparecían varios.
2. Corregido a `GET {root}/openai/deployments?api-version=2023-05-15` — el endpoint clásico de Azure, genuinamente scoped al recurso (dominio distinto a `/openai/v1`, derivado con `foundryResourceRoot()` nueva, que pela el sufijo `/openai/v1`/`/openai`/`/v1` del endpoint guardado). Confirmado real: trajo exactamente el único deployment real del usuario (`gpt-5`).

**Segundo bug real encontrado en el camino** (confirmado con un 404 real del usuario: *"Foundry /responses falló 404: The API deployment for this resource does not exist"*): `sanitizeSettings()` (`settings-provisioning.ts:144-149`) llamaba `mergeFoundryQAssistantModels()` (12 deployments hardcodeados, `FOUNDRY_Q_ASSISTANT_DEPLOYMENTS`) para **cualquier** conexión `type==='foundry'`, sin condición — corre en cada guardado/arranque, así que se reinyectaba solo aunque el usuario los borrara. Esos 12 solo tienen sentido para la ÚNICA conexión real que los necesita (`id:'qcfg-foundry'`, creada por `buildProvidersFromQConfig()` al importar `q_config.yaml`) — una conexión Foundry genuina agregada a mano (id real distinto, `crypto.randomUUID()`) nunca debió recibirlos. Acotado el chequeo a `provider.type === 'foundry' && provider.id === 'qcfg-foundry'`.

### Verificación real

Con la app corriendo, sincronización real confirmada por el usuario en 2 pasadas (2 capturas reales): 1ª pasada con `/v1/models` → catálogo amplio incorrecto (confirmado por el usuario, "no lo veo con la misma descripción"/"ninguno de esos modelos está sincronizado"); 2ª pasada tras el fix del endpoint → 1 deployment real (`gpt-5`) sincronizado correctamente, visible en el dropdown de modelo real del panel. Intento real de turno con uno de los 12 falsos (`Foundry gpt-5.5`) confirmó el 404 real esperado, validando que esos 12 nunca fueron reales para este recurso. Tras el fix de `mergeFoundryQAssistantModels()` + limpieza puntual de los 12 en el `settings.json` real del usuario + reinicio real de la app: **1 solo modelo (`gpt-5`) en la conexión, sobrevive al reinicio** (confirma que `sanitizeSettings()` ya no los reinyecta). `npm run typecheck`/`npm run build` en verde en cada iteración.

Archivos: `src/main/foundry-catalog.ts` (nuevo), `src/main/ipc-foundry-catalog.ts` (nuevo), `src/main/index.ts` (registro del IPC), `src/main/settings-provisioning.ts` (`mergeFoundryQAssistantModels()` acotado a `id:'qcfg-foundry'`), `src/preload/index.ts`/`index.d.ts` (binding), `src/renderer/src/App.tsx` (sección "Modelos de Foundry" nueva). `settings.json` real del usuario: 12 deployments falsos removidos de su conexión real, `gpt-5` (el único real) intacto. Sin commit — pendiente de que el usuario lo pida.

## Retiro real — flujo completo de importación de `q_config.yaml`

Pedido explícito del usuario, escalando el fix anterior: *"es que esto no debería ser una conexión a q-config ahí está el error q config ya no debe usarse sino una conexión nueva a foundry con su respectivo api key que se agregue desde la UI"* → confirmado sin ambigüedad tras una pregunta de alcance: *"sí, eliminá el flujo de q_config.yaml por completo"*. El acotamiento de `mergeFoundryQAssistantModels()` a `id==='qcfg-foundry'` (sección anterior) queda superado: sin ningún mecanismo que siga creando conexiones con ese id, la condición nunca se hubiera cumplido de nuevo — pero el código en sí (flujo de import entero) seguía vivo y sin uso real, así que se retiró de raíz en vez de dejarlo acotado y muerto.

**Alcance confirmado con grep antes de tocar nada** (el mismo criterio de siempre: nunca borrar por intuición): `importQConfig()` en `App.tsx` (línea ~4171) **nunca estaba cableada a ningún `onClick`** — código muerto ya, confirmado, no una regresión de este retiro. Único caller real de `buildProvidersFromQConfig`/`mergeImportedProviders` en todo `src/`: el handler IPC `settings:importQConfig` (`ipc-settings.ts`) — sin otro uso en ningún otro archivo.

**Retirado, archivo por archivo**:
- `src/main/settings-provisioning.ts`: removidas por completo `mergeFoundryQAssistantModels()`, `FOUNDRY_Q_ASSISTANT_DEPLOYMENTS` (los 12 deployments hardcodeados), `buildProvidersFromQConfig()`, `mergeImportedProviders()`, `withOpenAiV1()`, `asConfigRecord()`, `cfgString()` — archivo pasó de 502 a 201 líneas, terminando en el cierre de `modelProfile()` (confirmado intacto, sigue siendo el único helper real que reusan `claudeSubscriptionProvider()`/`antigravitySubscriptionProvider()`). `sanitizeSettings()` vuelve a una identidad simple: `provider.models.map(...)` sin ninguna inyección condicional.
- `src/main/ipc-settings.ts`: removido el handler `settings:importQConfig` entero (dialog de selección de YAML, parseo, merge). Con él, dejaron de usarse `dialog` (electron), `readFileSync`, `parse as parseYaml` — quitados del import; `unlinkSync`/`path` se conservan (los sigue usando `settings:resetLocalState`).
- `src/renderer/src/App.tsx`: removida `importQConfig()` (función completa, ya confirmada muerta/sin `onClick`). 2 comentarios que la mencionaban como uno de los 3 disparadores reales de desconexión global (`catalogChangeSignal`, `providerId===null`) actualizados para reflejar que el import de q_config ya no es uno de esos 3 casos.
- `src/preload/index.ts` / `index.d.ts`: removido el binding `importQConfig`/su firma de tipos.
- `src/main/api-agent-runtime.ts`: comentario que mencionaba `FOUNDRY_Q_ASSISTANT_DEPLOYMENTS` por nombre (doc-comment sobre límites de `max_output_tokens`, sin código real) actualizado para referenciar el mecanismo real vigente (`foundry-catalog.ts`, descubrimiento en vivo).

### Verificación real

`npm run typecheck` (`tsc --noEmit` en ambos proyectos) y `npm run build` en verde tras todos los retiros. Reinicio real de la app (proceso main tocado): `Stop-Process -Name electron -Force` + `npm run dev`, confirmados 4 procesos `electron.exe` corriendo tras el arranque — sin errores de arranque, `claudeSubscriptionProvider()`/`antigravitySubscriptionProvider()`/`sanitizeSettings()` (los únicos consumidores reales de lo que quedó en `settings-provisioning.ts`) siguen funcionando (la app carga proveedores/modelos con normalidad).

Archivos: `src/main/settings-provisioning.ts`, `src/main/ipc-settings.ts`, `src/renderer/src/App.tsx`, `src/preload/index.ts`, `src/preload/index.d.ts`, `src/main/api-agent-runtime.ts` (comentario). Sin commit — pendiente de que el usuario lo pida.

## Fix real — 2 shapes reales de recurso Foundry (`classic` vs `project`), `listFoundryModels()` fallaba con 404 en un recurso ya migrado a Azure AI Foundry "project"

Usuario reportó en vivo que "Sincronizar deployments" de Foundry (la sección ya confirmada funcionando en el capítulo anterior) dejó de refrescar. **Investigado y confirmado que NO es una regresión del retiro de q_config.yaml** — `foundry-catalog.ts`/`ipc-foundry-catalog.ts` no comparten ningún símbolo con lo que se borró (confirmado con grep). Causa real, reproducida con los logs reales del proceso main (`stdout` de `npm run dev`, mismo mecanismo que ya se usó para capturar errores reales del usuario en el capítulo anterior):

```
GET https://amatistabenchmark-resource.services.ai.azure.com/api/projects/amatistabenchmark/openai/deployments?api-version=2023-05-15 falló 400: API version not supported
GET https://amatistabenchmark-resource.openai.azure.com/openai/deployments?api-version=2023-05-15 falló 404: Resource not found
```

El segundo es el endpoint clásico YA CONFIRMADO funcionando en el capítulo anterior contra el MISMO host — dejó de responder esa ruta (404 real, error de ruteo, no de credencial). Probe adicional sin credenciales (nunca se usó la key del usuario para esto) confirmó que el host clásico sigue vivo (`/openai/v1/models` → 401, no timeout/DNS roto) pero la superficie `/openai/deployments` específicamente ya no está ruteada ahí — mientras que la superficie nueva de Azure AI Foundry "project" (`<recurso>.services.ai.azure.com/api/projects/<project>/...`) sí responde (401 sin key). Con la key real (el primer error de arriba) esa superficie rechazó `api-version=2023-05-15` — dato de documentación real de Microsoft (2 fuentes independientes, aportado por el usuario) confirmó que el valor correcto ahí es literal `"v1"`, no una fecha.

**Diseño acordado antes de implementar**: detección determinística de shape por hostname (`.services.ai.azure.com` = `project`, cualquier otro = `classic` — zonas DNS mutuamente excluyentes, sin necesitar probar ambas superficies a ciegas para el caso común). Fallback acotado **solo a 404** (señal real de "ruta equivocada para este recurso") — nunca a 401/403 (credencial real inválida, reintentar enmascararía el error real) ni a 400 (shape ya correcto, el problema es otro).

**Implementado en `foundry-catalog.ts`**: `foundryShape(endpoint)` (detección por hostname, `try/catch` sobre `new URL()`, default `'classic'` si no parsea), `foundryProjectRoot(endpoint)` (nuevo — corta el endpoint hasta `/api/projects/<project>` inclusive vía regex, tolera un sufijo `/openai` de más), `foundryDeploymentsUrl(endpoint, shape)` (arma la URL correcta por shape), `fetchFoundryDeployments()` (extraído, adjunta `status` HTTP al error para que el fallback pueda inspeccionarlo). `listFoundryModels()` intenta el shape detectado; si falla con 404 exactamente, reintenta una vez con el otro shape.

**Bug real de parser encontrado y corregido durante la propia verificación** (no en una pasada separada, según el criterio ya acordado): el shape `project` envuelve el array de deployments bajo `"value"` (confirmado con una respuesta real, autenticada, de Azure — `{"value":[{"name":"DeepSeek-V4-Flash","modelName":"DeepSeek-V4-Flash",...}]}`), campo que el parser no contemplaba (`[record.data, record.deployments, raw].find(Array.isArray)` — ninguno matchea, `data` queda `undefined`, se devolvía `[]` con éxito silencioso). Además usa `modelName`, no `model`, para el modelo base. Corregido: `record.value` sumado a la lista de candidatos del `data`; `firstString(deployment, ['model', 'modelName'])` para el modelo base — ningún campo existente se retira, solo se suman los del shape nuevo.

### Verificación real

**Con la key real del usuario, nunca vista ni tocada por mí**: agregado un autotest temporal en `index.ts` (`app.whenReady()`, tras `loadSettings()`) que invoca `listFoundryModels()` real reusando `provider.apiKey` YA DESCIFRADO en memoria por el propio proceso main — la key nunca se imprimió, ni entera ni parcial, en ningún log ni en este reporte; solo shape/éxito-error/cantidad de deployments. Reinicio real de la app en cada iteración (proceso main tocado), lectura del stdout real (`/tmp/dev-log*.txt`) para el resultado. Removido por completo tras confirmar (confirmado con `git diff`/grep que `index.ts` quedó byte-idéntico a antes de este capítulo, salvo el import/registro de `registerFoundryCatalogIpc` ya existente del capítulo anterior).

- 1er intento (endpoint TAL CUAL guardado por el usuario, `.../openai/v1`, shape `classic` por hostname): **error real esperado** — `foundryShape()` detecta `classic` correcto, la petición clásica falla 404 (el mismo síntoma reportado), el fallback a `project` no puede derivar una URL válida porque el endpoint GUARDADO no contiene ningún segmento `/api/projects/<project>` (imposible de inventar) — error claro y correcto: *"Foundry (shape project) requiere un endpoint con /api/projects/\<project\>."* **Esto no es un bug del fix — es la conclusión real: el endpoint guardado por el usuario sigue siendo el string clásico viejo, pero el recurso detrás ya migró; el usuario necesita actualizar el campo endpoint de su conexión al formato nuevo (`https://<recurso>.services.ai.azure.com/api/projects/<project>`) desde la UI.**
- 2do intento (mismo recurso, URL shape `project` bien formada a mano — usando el nombre de proyecto ya visible en un error real anterior de esta misma sesión, dato no sensible, no una credencial): **autenticación real exitosa** (200, no 401/403 — la key real fue aceptada), `api-version=v1` aceptado (no el 400 de antes) — con el bug de parser aún sin corregir, devolvió `0` deployments (falso negativo, diagnosticado con el cuerpo real de la respuesta, nunca la key). Con el parser corregido: **`1` deployment real, `DeepSeek-V4-Flash`**, coincide exactamente con el cuerpo real capturado.

`npm run typecheck`/`npm run build` en verde en cada iteración. Reinicio final confirmado (4 procesos `electron.exe`).

### No-regresión

Sin otro recurso Foundry `classic` real disponible para probar en vivo (el único recurso real del usuario migró a `project`). Confirmado por revisión de código: para cualquier endpoint cuyo hostname NO termine en `.services.ai.azure.com`, `foundryShape()` devuelve `'classic'` y `foundryDeploymentsUrl()` arma la MISMA URL byte-idéntica a la del capítulo anterior (`foundryResourceRoot()` sin tocar, mismo `/openai/deployments?api-version=2023-05-15`, mismos headers) — el único cambio de comportamiento para ese caso es que un 404 dispara un intento adicional a `project` (que fallará rápido y de forma clara si el endpoint no tiene `/api/projects/`, sin romper nada del camino feliz ya confirmado).

Archivos: `src/main/foundry-catalog.ts` (`foundryShape`, `foundryProjectRoot`, `foundryDeploymentsUrl`, `fetchFoundryDeployments` nuevos; `listFoundryModels()` con fallback acotado a 404; parser con `record.value`/`modelName`). `src/main/index.ts`: sin cambios netos (autotest agregado y retirado en la misma pasada, confirmado con diff). Sin commit — pendiente de que el usuario lo pida. **Pendiente real, fuera de código**: el usuario necesita actualizar el endpoint de su conexión Foundry guardada (`91ea1ef5-...`) al formato `project` desde la UI para que "Sincronizar deployments" funcione con ESA conexión.

## Feature real — botón "Copiar" visible por mensaje, junto al de Editar/Regenerar ya existente

Investigación previa (`docs/_arch/verify_message_actions_design.md`) confirmó con evidencia de código que "reintentar/regenerar" **ya existía completo y conectado** (`regenerateFrom()`/`startEditMessage()`, botón visible `.message-action-btn` + menú contextual, `chats:deleteMessagesFrom`/`deleteChatMessagesFrom()` ya en producción) — no era código muerto como el botón viejo de "Configurar modelos y cuentas...". Lo único real que faltaba: copiar (ya implementado detrás del click derecho, `navigator.clipboard.writeText(message.text)`) no tenía botón visible.

**Implementado, sin tocar ninguna lógica de edición/regeneración/borrado** (restricción explícita respetada): `copyMessage(message)` nueva en `App.tsx` — mismo `navigator.clipboard.writeText(message.text)` que ya usaba el menú contextual (factorizado ahí también, sin duplicar), con el único agregado real de un feedback visual: `copiedMessageId` (estado del panel) se setea al mensaje copiado y se limpia solo con un `setTimeout` de 1.5s, mostrando `✓` en vez de `⧉` mientras tanto (pedido explícito del usuario tras ver el botón sin ninguna confirmación).

`.message-action-btn` (círculo único, posición absoluta fija, usado por Editar O Regenerar pero nunca los dos a la vez) pasó a vivir dentro de `.message-actions` (contenedor flex nuevo) para que Copiar conviva con Editar/Regenerar sin superponerse — mismo comportamiento on-hover exacto (`opacity 0→1` en `.message:hover`).

**3 ajustes reales en vivo, pedidos por el usuario tras ver cada iteración** (todos vía HMR, sin reiniciar la app — cambio 100% renderer): posición `top:-8px;right:-8px` → `bottom:-26px;left:-8px` (2 pasadas: primero de arriba a abajo, después de derecha a izquierda; el primer intento en `bottom:-8px` quedó pegado a la última línea de texto porque los mensajes de assistant no tienen padding — se ajustó a `-26px` para despejarlo del texto usando el `margin-bottom:22px` ya existente entre mensajes); tamaño `22px/font 11px` → `26px/font 13px` ("un poquito más grande").

### Verificación real

Con la app corriendo, cada iteración confirmada por el usuario en vivo (no asumida): botón visible on-hover, sin superposición entre Copiar y Editar/Regenerar; click en Copiar confirmado real (texto pegado en otro lado); check momentáneo confirmado visualmente; Regenerar confirmado sin regresión (sigue funcionando idéntico). `npm run typecheck`/`npm run build` en verde en cada iteración; HMR real aplicado cada vez (confirmado leyendo el log real del proceso `vite`, `hmr update /src/App.tsx` / `/src/assets/main.css`), sin necesitar ningún reinicio (cambio puramente renderer).

Archivos: `src/renderer/src/App.tsx` (`copyMessage()` nueva, `copiedMessageId`/`copiedMessageTimerRef`, JSX del wrapper por-mensaje), `src/renderer/src/assets/main.css` (`.message-actions` nuevo, `.message-action-btn` ajustado). Sin commit — pendiente de que el usuario lo pida.

## Fix real — rediseño de gestión de modelos por conexión (expandible inline) + acordeón para el resto de Configuración

Motivado por una descripción real y detallada del layout actual (pedida por el usuario antes de tocar código): 3 mecanismos de sync distintos en 3 ubicaciones distintas para Codex/Claude/Antigravity, 3 bloques "Modelos de X" casi idénticos repetidos por separado, todos atados a `focusedProvider` (el proveedor del **panel de chat enfocado**, no la conexión que el usuario mira/expande en la lista de "Conexiones") — confirmado real que esto causaba confusión genuina: 2 conexiones "Claude Pro (suscripcion)" con el mismo nombre visible (una duplicada, encontrada y limpiada en el camino — ver más abajo), y la sección de modelos renderizaba para la que tuviera un panel conectado en ese momento, no la que el usuario miraba. Sumado a esto, el `{notice}` (feedback de CUALQUIER acción de toda la página) vivía en un solo lugar, al final absoluto del scroll de Configuración — estructural, no percepción: no importaba qué botón se clickeara arriba, el resultado aparecía siempre al fondo.

**Rediseño real, Parte 1 — `<ConnectionModelsPanel>` (`App.tsx`, componente nuevo a nivel de módulo)**: cada fila de "Conexiones" gana un botón "Modelos" que expande inline, ahí mismo, la gestión de SUS modelos — usando siempre `provider` explícito (la conexión real de esa fila), nunca `focusedProvider`. Fusiona los 3 bloques viejos (OpenRouter/OpenAI-compatible/OpenAI con búsqueda; Foundry sin búsqueda; anthropic/antigravity/openai-codex/google solo manual) en un solo componente que renderiza los controles correctos según `type`/`authMode`. Estado de catálogo (`openAiCatalog`/`foundryCatalog`) y feedback (`feedback`) son **locales a cada instancia** — cada fila expandida tiene los suyos, nunca compartidos ni escritos al `{notice}` global.

`toggleModel()`/`deleteModel()`/`addManualModel()` se reusan tal cual (ya 100% genéricas, cero cambio de lógica), recibidas como props. `refreshModelsForProvider()` (el mecanismo "Actualizar modelos", solo-agrega) ganó un parámetro `onFeedback` opcional con default `setNotice` — cero cambio de comportamiento para su caller original (el botón de la fila, anthropic/antigravity, que sigue ahí sin tocar); el único caller que pasa un callback explícito es el nuevo panel, solo para Codex.

**Los 2 mecanismos reales de sync de Codex** (solo-agrega vía `refreshModelsForProvider`; reemplazo completo vía `syncCodexFull()`, wrapper nuevo de `syncCodexProvider()` ya existente, sin cambio de lógica) — semántica genuinamente distinta, ninguno se borró — se consolidaron **juntos**, con etiquetas claras ("Agregar modelos nuevos (sin tocar los existentes)" / "Reemplazar catálogo completo"), dentro de la fila expandida de Codex — el botón "Actualizar modelos" de la fila y el "Sincronizar modelos" que vivía en la sección aparte "Cuenta ChatGPT" se retiraron de ahí (movidos, no duplicados).

**Rediseño real, Parte 2 — acordeón para el resto de Configuración** (pedido explícito del usuario con capturas reales, tras aprobar la Parte 1): analizadas 3 opciones (acordeón solo / agrupar por frecuencia con tabs / combinado) — descartado un sistema de tabs (el codebase no tiene NINGÚN patrón de tabs hoy, confirmado con grep, pieza de UI nueva para un beneficio marginal ya que Conexiones ya queda primera en el orden del DOM) a favor de acordeón puro para las secciones de uso infrecuente, mismo lenguaje visual ya establecido (`.turn-steps-chevron`, rota 90° al expandir) — logra el mismo efecto de "agrupar por frecuencia" (Conexiones arriba y expandida, el resto colapsado) sin el riesgo de introducir navegación nueva. `{notice}` se movió al tope fijo de `.settings-content`, siempre visible sin importar qué sección esté colapsada.

**Ajuste real en vivo, pedido por el usuario tras ver el acordeón**: "Cuenta ChatGPT (Codex)" y "CLI" (2 secciones separadas) se fusionaron en una sola ("CLI y cuentas") — conceptualmente son lo mismo (conectar/instalar runtimes y cuentas externas), mismo contenido de ambas sin cambio de lógica, un solo toggle.

**Hallazgo real en el camino, no planeado**: verificando la Parte 1 con la app real, el usuario reportó que la fila de Claude Pro no aparecía pese a tener un panel conectado — investigado y confirmado real: existía una **segunda conexión "Claude Pro (suscripcion)" duplicada** (`d232a059-...`, 16 modelos, creada en algún momento previo a esta sesión) además de la builtin real (`qcfg-claude-subscription`, resettada a los 2 modelos default de fábrica por un borrado accidental de conexión que el usuario hizo mientras probaba). Investigación real antes de tocar nada: 0 chats reales referenciaban la duplicada (`amatista.db`, `chat_sessions.provider_id`), 0 campos globales de `settings.json` la referenciaban — confirmado segura de borrar. Con autorización explícita del usuario: duplicada borrada, y los 13 modelos reales de Claude re-descubiertos en vivo contra el CLI real (mismo `discoverNewClaudeModels()` de producción, harness esbuild standalone) y agregados de vuelta a la conexión real (15 modelos totales: 2 default + 13 reales) — reinicio real confirmado, `settings.json` final con 1 sola conexión Claude Pro.

### Verificación real

Con la app corriendo, reinicio completo en cada iteración grande (no solo HMR, dado el alcance del refactor — remoción/movimiento de funciones y estado): confirmado por el usuario en vivo — Claude Pro expandido muestra sus 15 modelos reales (no los de otra conexión); feedback de los 2 mecanismos de sync de Codex aparece pegado a su fila, sin scroll; cambiar de panel enfocado NO afecta qué fila está expandida ni qué modelos se muestran (independencia de `focusedProvider` confirmada); acordeón del resto de Configuración confirmado colapsando/expandiendo correctamente; fusión "CLI y cuentas" confirmada funcionando. `npm run typecheck`/`npm run build` en verde en cada iteración.

Archivos: `src/renderer/src/App.tsx` (`ConnectionModelsPanel` nuevo, `syncCodexFull()`, `refreshModelsForProvider()` con `onFeedback` opcional, `toggleModelsExpanded()`/`expandedModelsProviderIds`, `toggleSettingsSection()`/`expandedSettingsSections`, remoción de `syncCodexModels()`/`syncOpenAiChatCatalog()`/`syncFoundryCatalog()`/`addCatalogModel()`/`addFoundryCatalogModel()` y sus 4 estados globales de catálogo), `src/renderer/src/assets/main.css` (`.model-management-panel`, `.model-management-feedback`, `.settings-section-toggle`, `.settings-section-chevron`). `settings.json` real del usuario: duplicada de Claude Pro eliminada, 13 modelos reales restaurados. Sin commit — pendiente de que el usuario lo pida.

## Fix real — `gemini-catalog.ts`, descubrimiento real de catálogo para Google/Gemini (Fase B, cierra la entrada de PENDING.md)

Investigación previa (`docs/_arch/verify_gemini_catalog_design.md`) confirmó real, con documentación oficial y un hilo real del foro de desarrolladores de Gemini (sin respuesta oficial de Google): `GET /v1beta/models` mezcla modelos deprecados/retirados con los activos, **sin ningún campo de estado/deprecación** en el objeto `Model` real — mismo tipo de problema que Foundry, pero sin el campo `status` que Foundry sí tenía. Implementado `gemini-catalog.ts` (nuevo, mismo patrón de archivo que `foundry-catalog.ts`) + IPC `gemini:listModels` + integración directa en `ConnectionModelsPanel` para `type==='google'` (botón "Sincronizar modelos", sección nueva de resultados, sin buscador — mismo criterio que Foundry, catálogo real no lo suficientemente grande como para justificarlo).

**Diseño de 2 pasadas, confirmado por la investigación previa**: (1) filtro estructural barato, sin request extra — descarta cualquier modelo cuyo `supportedGenerationMethods` no incluya `'generateContent'`. (2) verificación real OBLIGATORIA por candidato (mismo criterio que `discoverNewClaudeModels()`, `model-discovery.ts`) — una llamada real mínima `POST {name}:generateContent` por candidato, concurrencia acotada (`GEMINI_VERIFY_CONCURRENCY=5`, mismo orden que Claude): 200 real = usable, 404 (el código real confirmado para un modelo apagado) o cualquier otro error = descartado en silencio. Auth real vía header `x-goog-api-key` — tercer esquema de auth distinto entre los 3 archivos de catálogo de este mes (Foundry: `api-key`; OpenAI-chat: `Authorization: Bearer`; Gemini: `x-goog-api-key`), consistente con que cada proveedor real tiene el suyo, no una inconsistencia a unificar.

### Verificación real

Con la conexión Google real del usuario (`Gemini Advanced (suscripcion Google)`, key nunca vista por el agente — mismo mecanismo de siempre, autotest temporal en `index.ts` reusando `provider.apiKey` ya descifrado en memoria, retirado por completo tras confirmar, `index.ts` quedó byte-idéntico salvo el registro `registerGeminiCatalogIpc()` ya esperado): **40 candidatos reales pasaron el filtro barato**, **26 confirmados reales** (200, genuinamente usables — Gemini 2.5 Flash/Pro, la familia Gemini 3.x completa, variantes Nano Banana, Gemma, etc.), **14 descartados** por la verificación real (confirma en la práctica el hallazgo de la investigación: el catálogo estático trae candidatos que no sobreviven un uso real). Tiempo real medido: **~15 segundos** (14990ms), mismo orden de magnitud que Claude (~14.3s, capítulo anterior) — comunicado en el texto del botón mientras corre ("puede tardar, verificación real por candidato"), no ocultado. `npm run typecheck`/`npm run build` en verde, reinicio real confirmado (4 procesos `electron.exe`, sin residuos de debug).

Archivos: `src/main/gemini-catalog.ts` (nuevo), `src/main/ipc-gemini-catalog.ts` (nuevo), `src/main/index.ts` (registro del IPC), `src/preload/index.ts`/`index.d.ts` (binding `listGeminiModels`), `src/renderer/src/App.tsx` (`GeminiCatalogModel` interface, `showsGeminiSync`/`syncGemini()`/`addGeminiModel()` en `ConnectionModelsPanel`). `docs/_arch/PENDING.md`: entrada de gestión de modelos individuales cerrada como RESUELTO (Fase B + el efecto colateral del rediseño de `ConnectionModelsPanel`, que ya le había dado manual/toggle/eliminar a todos los tipos restantes). Sin commit — pendiente de que el usuario lo pida.

## Fix real — `geminiFunctionDeclarations()` rechazaba tools MCP reales por `$schema` (bug real reportado en un turno real con Gemini + tools)

Usuario reportó en vivo un turno real con Gemini (Nano Banana 2) + tools fallando con 400 real: *"Unknown name "$schema" at 'tools[0].function_declarations[22].parameters': Cannot find field."*, repetido para 13 índices consecutivos. Investigado ANTES de tocar código (sin implementar nada en esa pasada): confirmado con grep que ninguna de las 26 tools nativas de `tool-registry.ts` tiene `$schema` — el origen real es `mcp-client.ts:listToolDefinitions()`, que pasa el `inputSchema` de un servidor MCP externo TAL CUAL (`parameters: tool.inputSchema`, sin transformación, por diseño — correcto de su lado, el servidor MCP emite JSON Schema válido). Encontrado un `.mcp.json` real, vivo, en el workspace activo del usuario (`D:\WORKSPACE_AMATISTA\.mcp.json`) configurando `@modelcontextprotocol/server-everything` (servidor de referencia oficial del SDK de MCP, reusado de una verificación de hace tiempo, nunca borrado pese a su propio nombre `_ejemplo_borrar_esto`). Levantado en vivo (`tools/list` real): **exactamente 13 tools**, las 13 con `"$schema":"http://json-schema.org/draft-07/schema#"` en su `inputSchema` — coincide exacto con los 13 índices reales del error. `geminiFunctionDeclarations()`/`anthropicTools()`/`foundryTools()`/`openAiTools()` (`api-agent-runtime.ts`) hacen el mismo pass-through de `def.parameters` sin transformación — el error solo se reprodujo con Gemini, confirmando que Anthropic/OpenAI/Foundry toleran el campo sin problema, Gemini no.

**Fix real**: `stripDollarKeysForGemini()` nueva (`api-agent-runtime.ts`) — filtra recursivamente (objetos anidados y arrays, ej. `items` de un array de sub-schemas) CUALQUIER clave que empiece con `$` (no solo `$schema` puntual — genérico a propósito, cubre `$id`/`$ref`/`$comment`/`$defs`/etc., mismo problema real si un servidor MCP futuro los trajera). Aplicado únicamente dentro de `geminiFunctionDeclarations()`, sobre `def.parameters` antes de pasarlo. `anthropicTools()`/`foundryTools()`/`openAiTools()` quedaron sin tocar a propósito — ya toleran el campo, no lo necesitan.

### Verificación real

Con la app corriendo, autotest temporal en `index.ts` (retirado por completo tras confirmar, `index.ts` quedó byte-idéntico, confirmado con `git diff`) — mismo servidor MCP real (`server-everything`) que expuso el bug, key real del usuario nunca vista ni impresa:
- **13 tools reales confirmadas, la primera con `$schema` real** en su `inputSchema`.
- **Reproducción real del bug ANTES del fix** (payload crudo, sin sanitizar, idéntico al código viejo): `Gemini ok=false status=400 body=Invalid JSON payload received. Unknown name "$schema" at 'tools[0].function_declarations[0].parameters': Cannot find field.` — mismo error real, mismo mensaje.
- **Fix confirmado real DESPUÉS**: mismas 13 tools, mismo modelo (`gemini-2.5-flash`), vía `geminiFunctionDeclarations()` real (código de producción, no una reimplementación): `Gemini ok=true status=200`.
- **No-regresión real confirmada — Foundry**: mismas 13 tools con `$schema` crudo (sin sanitizar, `foundryTools()` intacto), turno real contra la conexión Foundry real del usuario: `ok=true status=200` — tolera el campo sin problema, confirmado en vivo, no solo por inspección de código.
- **No-regresión — Anthropic**: NO verificada con un turno real (la única conexión `type:'anthropic'`/`api-key` real del usuario, DeepSeek, no tiene ninguna key guardada — `encryptedApiKey` ausente, confirmado leyendo `settings.json`; no hay ninguna otra conexión Anthropic/OpenAI api-key real hoy). `anthropicTools()`/`openAiTools()` quedaron con `git diff` vacío (cero cambios) y comparten el mismo patrón de pass-through ya confirmado tolerante en Foundry — evidencia estructural fuerte, pero no una confirmación empírica en vivo como Gemini/Foundry. Pendiente de una key real si se quiere cerrar esto con el mismo nivel de certeza.

`npm run typecheck`/`npm run build` en verde, reinicio real confirmado (4 procesos `electron.exe`, sin residuos de código temporal).

Archivos: `src/main/api-agent-runtime.ts` (`stripDollarKeysForGemini()` nueva, `geminiFunctionDeclarations()` con el fix — únicos cambios reales; `anthropicTools()`/`foundryTools()`/`openAiTools()` sin tocar). Sin commit — pendiente de que el usuario lo pida.

## Feature real — `generate_image` vía Gemini (Nano Banana), segundo backend real de `image-generation.ts`

Investigado antes de tocar código (`docs/_arch/verify_gemini_image_generation_design.md`, no committeado): `generate_image` ya aparece en el catálogo de cualquier conexión (incluida Gemini), pero su ejecución estaba hard-gateada a `model.runtime === 'foundry'` (`image-generation.ts`, decisión explícita documentada: *"por ahora solo Foundry... un error claro es mejor que adivinar un formato de request no verificado"*). Confirmado real, con 3 fuentes de documentación oficial de Google, que Nano Banana/Nano Banana 2 (`gemini-3.1-flash-image`) **no pasa por `generateContent`** (el endpoint que `sendGeminiApi()` ya usa para texto/tools) — Google introdujo una API nueva y estructuralmente distinta, la **Interactions API** (`POST /v1beta/interactions`, GA desde junio 2026), con su propio shape de request/response (`interaction.steps[]`/`model_output`/`content[]`/`data`, nada que ver con `candidates[].content.parts[]`).

**Implementado**: `generateImageViaFoundry()`/`generateImageViaGemini()` (`image-generation.ts`), extraídas como funciones separadas por backend (mismo patrón "una función por backend" que ya usan `foundryTools()`/`anthropicTools()`/`geminiFunctionDeclarations()`/`openAiTools()` en `api-agent-runtime.ts`) — `generateImage()` pasa a ser un dispatcher por `model.runtime`, sin lógica propia. `attachmentFromBase64Png()` generalizada a `attachmentFromBase64Image(b64, mimeType, extension)` — necesario porque los 2 backends devuelven formatos reales distintos (ver hallazgo abajo). Parser de Gemini: recorre `interaction.steps[]`, ignora los de `type:'thought'` (razonamiento intermedio, siempre presentes en modelos Gemini 3, confirmado en la doc — nunca la imagen final), toma el primer bloque `type:'image'` del primer step `type:'model_output'`. `image_size:'1K'` fijo como default (mismo criterio "sin control de tamaño todavía" que ya tenía Foundry con `1024x1024` fijo) — confirmado con el usuario que es el único tamaño que soportan AMBOS modelos reales de Nano Banana (el Lite no soporta 2K/4K).

**Hallazgo real durante la propia verificación** (mismo patrón que Foundry meses atrás: la doc no coincidía 100% con la realidad): el primer intento, siguiendo la doc oficial literal (`response_format.mime_type: "image/png"`), falló con un 400 real: *"The value 'image/png' is not supported for 'response_format.mime_type'. Supported values: 'image/jpeg'."* — el shape estructural de la doc (`steps`/`model_output`/`content`/`data`) era correcto, el valor puntual de `mime_type` no. Corregido a `image/jpeg` — el resto del diseño (endpoint, header, shape de respuesta) se confirmó exacto en el segundo intento.

### Verificación real

Con la app corriendo, autotest temporal en `index.ts` (retirado por completo tras confirmar, `index.ts` quedó byte-idéntico, confirmado con `git diff`), contra la conexión Google real del usuario (Nano Banana 2 ya configurado como modelo de generación de imágenes real en Configuración, key nunca vista ni impresa) — vía `generateImage()` real de producción, sin reimplementar nada:
- **1er intento** (mime_type `image/png`, siguiendo la doc literal): error real reproducido, 400, mensaje exacto de arriba.
- **2do intento** (mime_type `image/jpeg`, corregido): **imagen real generada** — `attachment` real con `.jpg`, preview base64 de **528 555 caracteres** (imagen real, no vacía ni un placeholder).

`npm run typecheck`/`npm run build` en verde en las 2 iteraciones, reinicio real confirmado (4 procesos `electron.exe`, sin residuos de código temporal).

Archivos: `src/main/image-generation.ts` (`generateImageViaFoundry()`/`generateImageViaGemini()` nuevas, `attachmentFromBase64Image()` generalizada, `generateImage()` convertida en dispatcher). Sin commit — pendiente de que el usuario lo pida.

## Fix real — imágenes adjuntas grandes e inline en el chat, en vez de la tarjeta chica

Motivado por una captura real del usuario: una imagen generada (`generate_image`) se mostraba como tarjeta compacta tipo archivo (`AttachmentCard`), no la imagen en sí — el usuario la quería grande e inline, como ChatGPT. Investigación previa (`docs/_arch/verify_image_inline_render_design.md`) encontró que **el tratamiento grande ya existía en producción**, atado a otra fuente: `parsed.images`/`.rendered-images` (`ChatMessageView`), activado cuando el TEXTO del mensaje trae `![alt](src)` o una ruta cruda de imagen (`extractMessageImages()`) — nada que ver con `message.attachments`. Confirmado también que el dato ya estaba 100% disponible sin fetch adicional: `attachment.preview` ya es el data URL base64 completo, calculado al crear el attachment (`attachments.ts:47`).

**Fix real**: en `ChatMessageView`, el mismo booleano que `AttachmentCard` ya calculaba internamente (`kind==='image' && preview`) se movió un nivel más arriba — los adjuntos que lo cumplen (`imageAttachments`) se renderizan con el MISMO `<img>`/clases CSS que ya usaba `parsed.images` (`.rendered-images`/`.rendered-image-btn`, `max-width:720px`/`max-height:520px`, mismo click-to-zoom vía `onOpenImage`), en vez de `AttachmentCard`. El resto (`otherAttachments`, no-imagen o sin `preview` real) sigue por `AttachmentCard` sin ningún cambio. **Sin distinguir `origin`** (decisión explícita del usuario) — aplica igual a una imagen generada que a una que el usuario suba a mano. **Sin ningún badge/marca** sobre la imagen grande (decisión explícita, "imagen limpia, igual que ChatGPT") — el badge "✦ IA" de `AttachmentCard` sigue existiendo ahí, pero las imágenes ya no pasan por ese componente. `attachments.ts`/`AttachmentCard` sin ningún cambio, tal como se pidió.

### Verificación real

Con la app corriendo (HMR real confirmado, `hmr update /src/App.tsx`), confirmado por el usuario en vivo, los 3 casos: una imagen generada real (Gemini/Nano Banana 2, misma conexión de capítulos anteriores) se ve grande e inline, sin tarjeta ni badge; una imagen subida a mano por el usuario TAMBIÉN se ve grande ahora (confirma que el criterio sin distinguir `origin` funciona); un adjunto real que no es imagen sigue con la tarjeta chica normal, sin ningún cambio. `npm run typecheck`/`npm run build` en verde.

Archivos: `src/renderer/src/App.tsx` (`ChatMessageView`: `imageAttachments`/`otherAttachments`, reuso de `.rendered-images`/`.rendered-image-btn` para adjuntos-imagen). Sin commit — pendiente de que el usuario lo pida.

## Feature real — carpeta de datos seleccionable en el instalador (Fase 1, cierra la entrada de PENDING.md)

Investigación previa (Fase 0, `docs/_arch/verify_installer_data_folder_design.md`) había confirmado que esta feature **ya existió y se retiró deliberadamente en v0.4.7** (comentarios reales sobrevivientes en `build/installer.nsh`), usando en su momento un canal `HKCU "Environment" → AMATISTA_DATA_DIR` (nombre hoy muerto, `app-paths.ts` ya no lo lee) + marker file. Esta pasada reintroduce el mecanismo, esta vez apuntando al canal que el código real de HOY ya usa.

**Implementación (`build/installer.nsh`)**: página custom `nsDialogs` (label + text field pre-cargado con el default `D:\AMATISTA\data` + botón "Examinar..." vía `nsDialogs::SelectFolderDialog` + checkbox "Usar la misma carpeta que la instalación"), insertada en el hook oficial de electron-builder `customPageAfterChangeDir` (después de elegir `$INSTDIR`, antes de `MUI_PAGE_INSTFILES` — `node_modules/app-builder-lib/templates/nsis/assistedInstaller.nsh`). Al terminar la instalación (`customInstall`, mismo punto donde ya se registran shortcuts): `WriteRegStr HKCU "Environment" "AMATISTA_STORAGE_ROOT" "$DataFolder"` + broadcast `WM_SETTINGCHANGE` (para que un proceso nuevo la vea sin cerrar sesión de Windows). Si el checkbox está marcado, se usa `$INSTDIR` en vez del texto tipeado. **Nunca `AMATISTA_DATA_DIR`** (el nombre viejo/muerto) — se escribe directo a `AMATISTA_STORAGE_ROOT`, la MISMA variable que `app-paths.ts` ya leía, así que **`app-paths.ts` no necesitó ningún cambio**.

**2 bugs reales encontrados y corregidos en el 1er `npm run dist` real** (no en Fase 0, que había usado un script NSIS aislado): (1) el build real usa NSIS **3.0.4.1** (bundle legacy, vía `getLegacyNsisBin()`) porque `package.json` no fija `toolsets.nsis` — corrige el hallazgo de Fase 0, que había verificado contra el bundle 3.12 forzando su descarga manualmente, versión que el build real no usa por default. (2) `installer.nsh` se incluye 2 veces (pasada del instalador Y del desinstalador); en la pasada del desinstalador, la página custom nunca se invoca, así que sus funciones/`Var` quedaban sin referenciar → NSIS trata eso como warning, electron-builder lo trata como error fatal (`⨯ makensis.exe process failed`). Fix: todo el bloque nuevo movido bajo `!ifndef BUILD_UNINSTALLER`, igual que ya hacía `customInit`.

### Verificación real

Instalador real completo generado con `npm run dist` (184.8 MB, firmado con `signtool.exe`), instalado de verdad con `computer-use` (doble-click y tipeo reales) en 2 escenarios, ambos en rutas aisladas (`%TEMP%`, nunca `D:\AMATISTA`): **(1) ruta custom** → `reg query "HKCU\Environment" /v AMATISTA_STORAGE_ROOT"` devolvió exactamente la ruta tipeada; la app real, lanzada desde el acceso directo real que el instalador creó, escribió su carpeta de datos completa (`Cache`, `config`, `workspaces`, etc.) ahí. **(2) checkbox marcado** → reinstalación real sobre el mismo `$INSTDIR` (detectada correctamente por electron-builder), registro real quedó = `$INSTDIR` exacto (no el texto del campo, que no se sincroniza visualmente — comportamiento esperado); la app escribió su carpeta de datos mezclada con los archivos del programa, dentro de `$INSTDIR`. Limpieza real: apps de prueba cerradas, desinstalador real corrido (`/currentuser /S`) confirmando remoción completa de `$INSTDIR`, entrada de Add/Remove Programs y acceso directo; `AMATISTA_STORAGE_ROOT` borrado del registro real para restaurar el estado exacto pre-test. Confirmado con `LastWriteTime` real: `D:\AMATISTA\data` (datos reales del usuario) sin ningún cambio durante toda la prueba.

Archivos: `build/installer.nsh` (único archivo tocado). `app-paths.ts` sin cambios (confirmado innecesario). Detalle: `docs/_arch/verify_installer_data_folder_phase1.md`. Sin commit — pendiente de que el usuario lo pida.
