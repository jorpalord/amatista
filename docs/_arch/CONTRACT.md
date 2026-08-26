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
