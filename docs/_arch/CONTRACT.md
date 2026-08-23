# CONTRACT.md — Contratos de Arquitectura Amatista

> Fuente de verdad de interfaces, tipos y invariantes acordados entre fases.
> Cada contrato se agrega, nunca se borra. Si un contrato cambia, se versiona (v1, v2) y se marca el anterior como DEPRECATED con motivo.

## Índice
- [Contrato de memoria/contexto — v1 (DEPRECATED, ver v2)](#contrato-de-memoriacontexto--v1-deprecated-ver-v2)
- [Contrato de memoria/contexto — v2 (Fase 3, extendida en Fase 6)](#contrato-de-memoriacontexto--v2-fase-3-extendida-en-fase-6)
- [Módulos de src/main/ (post Fase 2)](#módulos-de-srcmain-post-fase-2)
- [Tool explore (Fase 4)](#tool-explore-fase-4)
- [Tool apply_patch (Fase 5)](#tool-apply_patch-fase-5)
- [AGENTS.md por proyecto (Fase 7)](#agentsmd-por-proyecto-fase-7)
- [VCS local oculto (Fase 8)](#vcs-local-oculto-fase-8)
- [Housekeeping: framing JSON-RPC + stub muerto (Fase 9)](#housekeeping-framing-json-rpc--stub-muerto-fase-9)
- [Cliente MCP para runtimes API (Fase 10)](#cliente-mcp-para-runtimes-api-fase-10)

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

## Contrato de memoria/contexto — v2 (Fase 3, extendida en Fase 6)

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
