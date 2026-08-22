# CONTRACT.md — Contratos de Arquitectura Amatista

> Fuente de verdad de interfaces, tipos y invariantes acordados entre fases.
> Cada contrato se agrega, nunca se borra. Si un contrato cambia, se versiona (v1, v2) y se marca el anterior como DEPRECATED con motivo.

## Índice
- [Contrato de memoria/contexto — v1 (DEPRECATED, ver v2)](#contrato-de-memoriacontexto--v1-deprecated-ver-v2)
- [Contrato de memoria/contexto — v2 (Fase 3)](#contrato-de-memoriacontexto--v2-fase-3)
- [Módulos de src/main/ (post Fase 2)](#módulos-de-srcmain-post-fase-2)
- [Tool explore (Fase 4)](#tool-explore-fase-4)
- [Tool apply_patch (Fase 5)](#tool-apply_patch-fase-5)

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

## Contrato de memoria/contexto — v2 (Fase 3)

> Reemplaza v1. Compactación real vía LLM, persistida en SQLite, disparada en segundo plano — nunca bloquea el turno en curso. Alcance: runtimes API (`anthropic-api`, `foundry`, `gemini-api`, incluye DeepSeek vía `anthropic-api`). Runtimes CLI (`claude-cli`, `codex-subscription`) quedan fuera del motor de compactación por decisión de fase; siguen usando `--resume` externo, sin cambios de este contrato salvo que ahora pueden heredar, de arranque, un resumen ya persistido si el chat se usó antes con un runtime API (mismo campo `compactSummary`, sin lógica CLI nueva).

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

**Fuera de alcance de esta fase, anotado en PENDING.md, no resuelto acá:** si los runtimes CLI también necesitan un mecanismo de compactación propio en vez de depender enteramente de `--resume` externo.

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
