# CONTRACT.md — Herramientas compuestas (diseño puro, sin implementar)

> Rama `experiment/composed-tools`, creada desde `master` (`da76980`). **Cero código nuevo** — este documento es la única entrega de esta pasada, tal como pidió el usuario ("el usuario y yo necesitamos ver el diseño completo antes de aprobar la construcción").

## Contexto y corrección de diseño sobre Q

Investigación previa (sesión anterior, D:\QV2, ver [../deepseek-pwa-tools/CONTRACT.md](../deepseek-pwa-tools/CONTRACT.md) para el detalle completo de esa investigación) encontró que el mecanismo de auto-programación de Q tenía dos fallas estructurales:

1. **Código Python libre**, validado por un *guardrail* denylist (AST + regex) con huecos reales (`requests`/`httpx` sin restricción de destino, rutas protegidas solo para unos pocos casos hardcodeados, ninguna protección de comportamiento real).
2. El sandbox (Docker) **solo corría una vez, durante el diseño** — una vez instalada, la herramienta ejecutaba para siempre en el proceso host, sin sandbox, sin re-validación, sin aprobación por uso.

La corrección de diseño central de este documento: una "herramienta compuesta" en Amatista **nunca contiene código** — es una **receta declarativa** que solo invoca, por nombre, tools reales ya existentes de `TOOL_DEFINITIONS` (49 confirmadas, ver Tarea 2). No hay superficie de "código arbitrario" que proteger con un guardrail, porque no hay código. Y cada paso de la receta pasa por el gate de aprobación/confinamiento REAL de esa tool **en cada ejecución**, no solo al crearla — reusando `ToolRegistry.execute()` de forma recursiva (Tarea 4).

> **Actualización (segunda pasada de diseño, decisión del usuario):** el mecanismo de aprobación en ejecución quedó resuelto como **UNA aprobación por corrida completa**, sobre el alcance REAL ya resuelto (no una por paso), válida solo para esa corrida puntual y nunca persistida. El diseño completo está en la sección final **"Resolución: aprobación única por corrida"**, que reemplaza a la Tarea 4 original donde se contradicen. Esa pasada también corrigió 3 supuestos de la primera (el formato de receta pasa a tener 2 secciones explícitas, las salidas de tools son texto y no listas, y el `ExecuteContext` no se puede reusar tal cual durante toda una corrida) — cada uno marcado en su lugar.

---

## Tarea 1 — Formato real de una "receta"

### Estructura de datos

```ts
interface ComposedToolStep {
  id: string                                    // único dentro de la receta, referenciable por otros pasos
  tool?: string                                  // nombre real de TOOL_DEFINITIONS, o "composed__<nombre>" (Tarea 5)
  args?: Record<string, string>                  // SIEMPRE strings -- igual que el protocolo de texto de DeepSeek,
                                                  // pueden contener referencias {{...}} (ver abajo)
  if?: { field: string; op: 'eq' | 'neq' | 'contains' | 'gt' | 'lt'; value: string }
  foreach?: { in: string; as: string; maxIterations: number }   // in: referencia a un campo que resuelve a un array
  steps?: ComposedToolStep[]                     // presente SOLO junto con `foreach` (el cuerpo de la iteración)
}

interface ComposedToolDefinition {
  id: string
  name: string                                   // snake_case, se expone como tool "composed__<name>"
  description: string
  inputs: Array<{ name: string; description: string }>   // declarados, sin tipos -- todo llega como string
  discover: ComposedToolStep[]                   // SOLO tools de solo lectura (DISCOVERY_TOOL_NAMES) -- corre ANTES de pedir aprobacion
  apply: ComposedToolStep[]                      // cualquier tool -- corre DESPUES de la aprobacion unica, sobre el plan congelado
  createdAt: string
  createdByRuntime: string                       // 'anthropic-api' | 'deepseek-pwa' | etc. -- trazabilidad, no gating
  approvedAt: string                             // nunca se guarda sin esto poblado (Tarea 3)
}
```

> **Corregido en la segunda pasada:** la primera versión tenía un único `steps: ComposedToolStep[]`. Pasa a 2 secciones explícitas (`discover`/`apply`) — el motivo (por qué el sistema NO puede separar solo las lecturas de las escrituras reordenando pasos) está en "Resolución: aprobación única por corrida" → "Por qué 2 secciones explícitas y no un reordenamiento automático".

### Paso de datos entre pasos: `{{...}}`, sin lenguaje de expresiones

Sintaxis mustache-like, resuelta contra un **scope fijo y acotado**, nunca evaluada como código:

- `{{input.<nombre>}}` — un input declarado, provisto al invocar la receta.
- `{{steps.<id>.output}}` / `{{steps.<id>.ok}}` — el `ToolExecutionResult` (`tool-registry.ts:63-91`) de un paso anterior, accedido por *field-path* simple (`.` para navegar objetos, sin índices calculados ni funciones).
- `{{steps.<id>.items}}` — **(agregado en la segunda pasada)** la lista estructurada de un paso de `discover`, producida por un adaptador fijo de Amatista (ver abajo). Es lo único sobre lo que puede iterar un `foreach`.
- `{{item}}` / `{{item.<campo>}}` — solo dentro del cuerpo de un `foreach`, referencia al elemento actual.

> **Corregido en la segunda pasada — las salidas de tools son texto, no listas.** `ToolExecutionResult.output` es siempre un `string` (`tool-registry.ts:63-91`), recortado a 20.000 caracteres con el sufijo literal `\n[salida recortada]` (`MAX_TOOL_OUTPUT_CHARS`, `tool-registry.ts:502`; `clip()`, `:1592-1596`). `list_dir`, por ejemplo, devuelve líneas `"file  nombre"`/`"dir   nombre"` (`tool-registry.ts:2555`), no un array — la primera pasada asumía un `output.items` que no existe. Para que un `foreach` pueda iterar (y para poder mostrar "va a escribir en 12 archivos"), cada tool de `discover` tiene un **adaptador de salida fijo, escrito y revisado como código de Amatista** (nunca provisto por la receta ni por el modelo): `list_dir` → `[{type, name}]`, `search_files` → `[{path, line, text}]` (formato `git grep`), `git_status` → `[{status, path}]`. `read_file`/`git_diff` no producen lista (su `output` se usa como texto). Si la salida de un paso de `discover` termina en `[salida recortada]`, **la corrida se aborta antes de pedir aprobación** con un error honesto ("el descubrimiento devolvió una lista incompleta — el alcance real no se puede conocer; acotá la ruta") — nunca se arma un plan sobre una lista que se sabe cortada.

Reglas de validación, aplicadas en `propose_composed_tool` (Tarea 2), **antes de guardar nada**:

- Una referencia `{{steps.X...}}` solo es válida si `X` es un paso que aparece **antes** en la secuencia (nunca hacia adelante) — decidible estáticamente, sin ambigüedad, sin necesidad de ejecutar nada para validarlo.
- Si un campo no resuelve en tiempo de ejecución (p. ej. `steps.s1.output` no tiene la forma esperada), el paso falla con un mensaje honesto — mismo criterio "seguro por defecto" que ya usa todo `tool-registry.ts` (nunca se sustituye un valor inventado).
- Nunca se permite concatenación, aritmética, ni anidar una referencia dentro de otra (`{{steps.{{x}}.output}}` es syntácticamente inválido, rechazado en la validación).

### Dónde se traza la línea del control de flujo, y por qué

Se evaluaron 3 niveles de expresividad. La línea se traza en el más bajo que sigue siendo útil:

| Nivel | Qué permite | Decisión |
|---|---|---|
| Solo secuencia lineal (sin `foreach`/`if`) | Encadenar tools 1→2→3 | **Insuficiente** — el propio pedido del usuario da como ejemplo "para cada uno, leé el contenido", que requiere iterar sobre una lista |
| Secuencia + `foreach` de un solo nivel + `if` de una sola condición plana | Iterar sobre el resultado de un paso anterior, saltar un paso condicionalmente | **✅ Elegido para v1** |
| `foreach` anidados + `if` con `and`/`or`/`not` combinables + variables reasignables | Cualquier programa con forma de árbol de sintaxis | **Rechazado** — en este punto es un lenguaje de programación con otra sintaxis, exactamente el problema de Q pero con JSON en vez de Python. Nada en este nivel es decidible/auditable con una lectura humana simple del recibo aprobado. |

Justificación concreta de por qué el nivel elegido **no** es "código arbitrario con otro nombre":

- `foreach` tiene un `maxIterations` **obligatorio y numérico**, nunca "hasta que se cumpla una condición" — no hay forma de escribir un bucle que no termine, ni siquiera por error.
- `if` compara un *field-path* contra un **literal**, nunca contra otro *field-path* — esto es deliberado: si se permitiera comparar dos valores dinámicos entre sí, encadenando varios `if` se podría reconstruir lógica booleana arbitraria sobre datos en tiempo de ejecución. Comparar solo contra literales conocidos en el momento de aprobar la receta mantiene cada condición auditable de un vistazo ("si el tipo es 'file'", nunca "si A relacionado con B de una forma que dependa de la ejecución").
- No hay asignación de variables, ni mutación de estado entre iteraciones de un `foreach` — cada iteración es independiente, no hay acumulador que un paso pueda ir corrompiendo.
- `foreach` anidado dentro de otro `foreach` (dos niveles) se permite estructuralmente (el tipo lo permite recursivamente) pero se **capea a profundidad 2** en la validación — un tercer nivel se rechaza al proponer. Con `maxIterations` acotado en cada nivel, el peor caso (`maxIterations₁ × maxIterations₂`) sigue siendo una cota dura y calculable en el momento de aprobar, mostrada al usuario en la Tarea 3 ("esto puede ejecutar hasta N tools reales").

---

## Tarea 2 — Cómo un modelo propone una receta, por runtime (hallazgo real: NO es uniforme)

Investigación real de código (branch `experiment/composed-tools`, evidencia citada por archivo:línea) — **la premisa de "un solo diseño que sirva para los 3 caminos" no se sostiene tal cual existe hoy el código**, y el diseño de abajo lo asume explícitamente en vez de fingir uniformidad que no existe.

### Runtimes API (foundry / anthropic-api / gemini-api / openai-chat) — camino completo, reuso directo

`ApiAgentRuntime.toolCatalog()` (`api-agent-runtime.ts:1250-1315`) arma el catálogo visible al modelo como `[...native, ...mcpToolDefinitions]` (`:1314`), donde `native` es `TOOL_DEFINITIONS` filtrado por 3 listas de nombres según estado de sesión (orquestador/web-search/plan-mode). **`propose_composed_tool` y cada `composed__<nombre>` ya aprobado se agregan a esta misma lista** (`[...native, ...composedToolDefinitions, ...mcpToolDefinitions]`), leídos del disco en cada llamada a `toolCatalog()` (mismo patrón de frescura que `session.planModeActive` ya usa — barato, es solo un directorio + JSON.parse, sin comparar con `McpManager.startAll()` que sí levanta procesos externos y por eso se calcula una sola vez al conectar).

`ApiAgentRuntime.runTool()` (`api-agent-runtime.ts:1396-1487`) ya tiene un branch explícito por prefijo de nombre: `if (name.startsWith(MCP_TOOL_PREFIX))` (`:1443`, `MCP_TOOL_PREFIX = 'mcp__'`, `mcp-client.ts:37`) → `McpManager.callTool()`; si no, → `this.config.toolExecutor(name, args)` (`:1483`), es decir `ToolRegistry.execute()`. El diseño reusa **exactamente este patrón, agregando un tercer branch**: `if (name.startsWith('composed__'))` → un nuevo ejecutor de recetas (Tarea 4) — cero cambio al branch existente de MCP, mismo criterio de precedencia por prefijo ya validado en producción.

> **Refinado en la segunda pasada:** el chequeo del prefijo `composed__` va **dentro de `ToolRegistry.execute()`** (antes del `switch`), no en `runTool()`. Motivo: el ejecutor necesita piezas privadas de `tool-registry.ts` (`this.execute` recursivo, `formatWriteFileDiff()` `:611`, `hashFileContent()` `:410`, `lookupSessionFileHash()`), y como el `else` de `runTool()` (`:1483`) ya manda cualquier nombre que no sea `mcp__` a `toolExecutor` → `toolRegistry.execute()`, ponerlo ahí adentro lo hace funcionar **idéntico** para el camino API y para DeepSeek PWA (que llama a `toolRegistry.execute()` directo) sin tocar `runTool()`.

`propose_composed_tool` en sí es una tool más de `TOOL_DEFINITIONS`, con `parameters.properties.steps` como un array-of-objects anidado — **esto ya es una capacidad real y ejercitada del esquema**, no teórica: `read_image`'s `region` (`tool-registry.ts:719-733`) ya usa `properties`/`required` anidados dentro de `ToolPropertySchema` (`tool-registry.ts:44-51`).

### DeepSeek PWA, protocolo de texto (`experiment/deepseek-pwa-tools`, no presente en esta rama) — camino completo, sin cambios de protocolo

El protocolo `TOOL_CALL: nombre(args)` (implementado y verificado real en la rama hermana, commit `bcc3a2a`) ya inyecta la descripción de **todo** `TOOL_DEFINITIONS` en el primer mensaje (`buildToolProtocolInstructions()`), y el bucle de `ipc-agent.ts` ya llama `toolRegistry.execute(call.name, call.args, ctx)` con el `ExecuteContext` **completo** (`hardConfirm`/`computerUseActive`/etc., wireado en esa misma rama). `propose_composed_tool` y los `composed__<nombre>` aprobados se agregan a esa MISMA lista de `TOOL_DEFINITIONS` que ya se describe — cero cambio de protocolo, el modelo simplemente ve una tool más y la invoca con la sintaxis que ya sigue al 100% (15/15 medido). El argumento `steps` (un array/objeto) viaja como **string JSON dentro de las comillas** del protocolo (`TOOL_CALL: propose_composed_tool(name="...", steps="[{\"tool\":\"list_dir\",...}]")`) — el parser ya desescapa `\"` (`unescapeToolArg()`, ver rama hermana), así que esto funciona con el parser TAL CUAL existe, sin tocarlo.

**Límite real, documentado con honestidad:** `buildToolProtocolInstructions()` solo se inyecta en el **primer** mensaje de una conversación nueva (`!pwa.hasRemoteConversation()`). Si se aprueba una receta a mitad de una conversación DeepSeek ya iniciada, esa conversación **no la ve** hasta la próxima conversación nueva — a diferencia del camino API, donde `toolCatalog()` se recalcula en cada turno. No se propone resolver esto en v1 (inyectar un "aviso de catálogo actualizado" a mitad de conversación agregaría complejidad/contexto por cada aprobación, y el caso de uso — usar la receta recién creada en la MISMA charla — se resuelve simplemente iniciando una charla nueva).

### Runtimes CLI (claude-cli / antigravity-cli / codex-subscription / codex-api) — **sin camino real hoy, alcance explícito: fuera de v1**

Hallazgo real más importante de esta investigación: **`ToolRegistry.execute()` casi no es alcanzable desde los runtimes CLI**. Estos runtimes usan sus propias tools nativas (Read/Write/Bash de Claude Code, etc.) para archivos/git/shell — nunca pasan por `tool-registry.ts` para eso. Lo único que Amatista expone a un subproceso CLI es un servidor MCP standalone propio (`src/main/mcp-lsp-server.ts`, corre como proceso Node plano bajo `ELECTRON_RUN_AS_NODE`, **no puede importar `tool-registry.ts`** porque arrastraría `electron` real — comentario explícito en el propio archivo, `mcp-lsp-server.ts:337-343`) con 17 tools reimplementadas aparte (LSP, orquestador, computer-use, navegador). De esas 17, solo 3 (`read_image`/`extract_video_frame`/`render_3d_model`) efectivamente llaman a `ToolRegistry.execute()` real, vía un puente de named pipe (`mcp-approval-pipe.ts`) con un `ExecuteContext` mínimo armado a mano por cada una — el resto de las ~46 tools restantes del catálogo (`write_file`, `run_command`, `close_app`, etc.) **no tienen ningún camino de ejecución para un runtime CLI hoy**, ni bueno ni malo, simplemente no existe.

Consecuencia honesta para el diseño: una receta que combina, por ejemplo, `list_dir` + `read_file` **no tiene forma de ejecutarse** si se invocara desde un runtime CLI, porque esos nombres de tool no significan nada ahí (el CLI usa su propio Read/Bash nativos, con otro nombre y otro mecanismo de aprobación). **Decisión de alcance para v1: `propose_composed_tool` y los `composed__*` resultantes se ocultan del catálogo para runtimes CLI** — mismo mecanismo de ocultamiento ya usado para `send_to_window`/`web_search`/`exit_plan_mode` (listas de nombres filtradas antes de construir el catálogo), aplicado acá porque ofrecer una capacidad sin forma de ejecutarla sería una promesa rota, no porque haya un riesgo de seguridad distinto. Extender esto a runtimes CLI en el futuro requeriría un 4to puente estilo `mcp-approval-pipe.ts` (una nueva tool MCP `run_composed_tool` con su propio caso hardcodeado ahí) — viable, pero trabajo real aparte, no incluido en la "Estimación honesta de tamaño".

---

## Tarea 3 — Aprobación real, obligatoria, legible

### Flujo

1. El modelo llama `propose_composed_tool(name, description, inputs, steps)`.
2. **Validación estática** (antes de mostrar nada al usuario): cada `step.tool` existe en `TOOL_DEFINITIONS` o es `composed__<algo>` ya aprobado (nunca un nombre inventado); cada referencia `{{steps.X...}}` apunta a un paso anterior real; profundidad de `foreach` anidado ≤ 2; sin ciclos si hay composición anidada (Tarea 5). Si algo falla, se devuelve un error real y honesto al modelo (mismo patrón que el guardrail de Q, pero **sintáctico sobre datos, nunca semántico sobre código** — la diferencia de fondo es que acá no hay nada que "colarse" porque no hay ejecución posible fuera de la lista cerrada de tools reales).
3. **Render legible** — un renderer determinístico convierte la receta validada en una lista numerada en español, reusando y extendiendo el patrón YA existente en `App.tsx` (`TOOL_STEP_LABELS`, `App.tsx:463-470`, y `toolCallTargetLabel()`, `App.tsx:444-452`) que hoy da etiquetas humanas tipo *"leyó 1 archivo"* a partir del nombre+args de una tool — se agregan plantillas equivalentes por tool (`"Lista los archivos de {path}"`, `"Lee el archivo {path}"`, etc.), con un *fallback genérico* (`"Ejecuta {tool} con {args resumidos}"`) para tools sin plantilla dedicada — **el propio `TOOL_STEP_LABELS` de hoy ya cubre solo 6 de 49 tools**, así que un fallback genérico conviviendo con cobertura parcial es el patrón YA aceptado en este código, no una improvisación nueva.
4. **Diálogo real, reusado sin cambios de UI**: `requestSessionToolApproval(chatId, title, detail)` (la MISMA función que ya usa cada tool sensible) con `title = "Nueva herramienta: {name}"` y `detail` = la lista numerada completa, por ejemplo:
   ```
   Esta herramienta nueva, si la aprobás, va a poder hacer esto cada vez que se use:

   Primero, solo lectura (sin cambiar nada):
   1. Lista los archivos de {{input.carpeta}}
   2. Para cada archivo del paso 1 (hasta 20): lo lee
   Después, con tu aprobación de esa corrida:
   3. Para cada archivo leído: escribe una copia con el encabezado "{{input.encabezado}}"

   Esto solo aprueba que la herramienta quede guardada y disponible. CADA VEZ que se use,
   primero se hace la parte de lectura y después te muestro exactamente qué archivos va a
   tocar ESA corrida, para que la apruebes (o no) antes de que cambie nada.
   ```
   Confirmado con el código real de la UI (`App.tsx:7208-7233`): `visibleToolApproval.detail` se parte por `\n` y se renderiza línea por línea dentro de un `<pre>` — el bloque especial de diff (`diff-add`/`diff-remove`) solo se activa si `title.startsWith('Escribir archivo:')` (`App.tsx:7213`), así que un título distinto (`"Nueva herramienta: ..."`) cae directo en el `else` (`App.tsx:7232`, `<pre>{visibleToolApproval.detail}</pre>`) — **el multi-línea ya funciona hoy, sin ningún cambio de componente**. El último párrafo del ejemplo de arriba (aclarando que cada corrida vuelve a pedir su propia aprobación) es intencional y se agrega siempre — es la respuesta directa a la confusión de fondo que este documento busca evitar: que aprobar la receta se sienta como aprobar sus futuras ejecuciones.
5. Solo con aprobación explícita (`onAnswer('accept')`, mismo flujo que cualquier otra tool) se persiste el JSON (Tarea 5) y se hace visible en el catálogo desde el turno siguiente.

---

## Tarea 4 — Ejecución: cada paso, cada vez, por el gate real (la corrección central del error de Q)

> **Parcialmente reemplazada en la segunda pasada.** Lo que SIGUE vigente de esta tarea: cada paso se ejecuta con una llamada recursiva a `this.execute()`, así que siempre corre el mismo `case` del switch que cualquier llamada directa (mismo confinamiento, misma `resolveApproval()`, mismo `hardConfirm()`) — nunca una "función cargada" al estilo Q. Lo que CAMBIÓ: (1) por decisión del usuario, las aprobaciones de las 4 tools sensibles canónicas se agrupan en **una sola aprobación por corrida** sobre el alcance real ya resuelto, en vez de un diálogo por paso; (2) la afirmación "el MISMO `ExecuteContext`, sin copiar ni recortar" era **incorrecta** — el contexto es una foto tomada al inicio de la llamada y tiene que refrescarse por paso. Ambas cosas están resueltas en **"Resolución: aprobación única por corrida"**, al final. El pseudocódigo de abajo queda como referencia de la primera pasada.

### El mecanismo, con forma de código real (pseudocódigo fiel a las firmas reales — primera pasada)

```ts
// Nuevo, dentro de tool-registry.ts (mismo archivo, mismo acceso a `this.execute`)
private async runComposedStep(
  step: ComposedToolStep,
  scope: Record<string, unknown>,
  ctx: ExecuteContext,        // <-- EL MISMO objeto recibido por la llamada externa a "composed__X", sin copiar ni recortar
  depth: number
): Promise<ToolExecutionResult> {
  if (step.foreach) {
    const list = resolveRef(step.foreach.in, scope)
    if (!Array.isArray(list)) return { ok: false, output: `"${step.foreach.in}" no resolvio a una lista.` }
    for (const item of list.slice(0, step.foreach.maxIterations)) {
      for (const sub of step.steps!) {
        const r = await this.runComposedStep(sub, { ...scope, [step.foreach.as]: item }, ctx, depth)
        if (!r.ok) return { ok: false, output: `Paso "${sub.id}" fallo: ${r.output}` }  // fail-fast, nunca éxito parcial silencioso
      }
    }
    return { ok: true, output: '...' }
  }
  if (step.if && !evalCondition(step.if, scope)) return { ok: true, output: '(paso omitido: condicion no cumplida)' }
  const resolvedArgs = resolveArgs(step.args ?? {}, scope)   // solo substitucion de {{...}}, nunca eval()
  return this.execute(step.tool!, resolvedArgs, ctx)          // <-- ACA vive toda la garantia de esta tarea
}
```

La línea `return this.execute(step.tool!, resolvedArgs, ctx)` es la respuesta completa a la Tarea 4: es una llamada **recursiva al mismo `ToolRegistry.execute()`** (`tool-registry.ts:1982`) que ya usa cualquier runtime, con el **mismo `ExecuteContext` recibido, sin modificar un solo campo**. Si el paso es `write_file`, adentro de `execute()` se ejecuta exactamente el mismo `case 'write_file'` que ya llama a `resolveApproval(ctx.sandbox, ctx.confirm, ...)` — el diálogo real de "Escribir archivo: X" aparece **cada vez que la receta corre**, nunca solo la primera. Si el paso es `lock_screen`, se ejecuta el mismo `case 'lock_screen'` que llama a `ctx.hardConfirm()` incondicional. **No se escribe ningún código de seguridad nuevo** — la garantía es estructural: no existe una forma de que un paso de receta invoque una tool sin pasar por el mismo `case` del switch que cualquier llamada directa.

Esto es, con evidencia concreta, la corrección exacta del error de Q: ahí, `tool_loader.run()` (`D:\QV2\core\tool_loader.py:65-72`) llamaba `fn(**args)` directo sobre una función Python cargada una vez — nada volvía a pasar por `guardrail.analyze()` ni por el sandbox Docker en cada uso real. Acá, no hay una "función cargada" en absoluto — cada paso siempre resuelve al mismo case del switch de siempre, con el mismo gate de siempre, en cada invocación.

### "Confianza heredada" — dónde explícitamente NO existe (vigente, con el ajuste de la segunda pasada)

- **Aprobar la receta (Tarea 3) nunca aprueba ninguna corrida.** No hay ningún flag "esta receta ya se aprobó" que llegue al ejecutor. Cada corrida arranca sin ninguna aprobación y pide la suya.
- **La aprobación de una corrida nunca sobrevive a esa corrida** — ni a la siguiente corrida de la misma receta en el mismo turno. Mecanismo exacto: `RecipeRunGrant`, en la sección final.
- `ctx.hardConfirm` (Familia A/B) **nunca** queda cubierto por la aprobación de corrida: sigue preguntando por llamada, igual que hoy, y sigue sin consultar `toolTrustSession`.
- ~~Cada `foreach` vuelve a pasar por `resolveApproval()` en CADA iteración (N diálogos)~~ — **reemplazado** por la aprobación única de la corrida, que muestra las N acciones concretas juntas antes de ejecutar ninguna.

---

## Tarea 5 — Dónde viven, alcance, anidamiento

### Alcance: por workspace

Guardadas en `<workspace>/.amatista/composed-tools/<name>.json` — mismo patrón de configuración-por-workspace ya establecido para MCP (`.mcp.json` en la raíz del workspace, `readMcpConfig()`/`mcpConfigPath()`, `mcp-client.ts:72-118`). Justificación: una receta suele asumir implícitamente la forma de UN proyecto (nombres de carpetas, convenciones de archivos) — visibilidad global cruzaría ese contexto a workspaces sin relación. El confinamiento de cada paso individual (`resolveWithinWorkspace()`) ya impide cualquier daño cruzado aunque una receta se compartiera mal — esto es una decisión de **relevancia/orden**, no de seguridad.

### Anidamiento: permitido, con límite real justificado

Un `step.tool` puede nombrar otra receta ya aprobada (`composed__otra`). Dos defensas, no una sola:

1. **Detección de ciclos en el momento de aprobar** (no en tiempo de ejecución) — la lista de pasos de una receta es dato estático conocido por completo al momento de guardar, así que construir el grafo de referencias ("A llama a B") y rechazar cualquier ciclo (A→B→A, o A→A directo) es decidible con certeza, sin ambigüedad — no es un problema de parada, porque no hay ninguna decisión dinámica involucrada.
2. **Tope duro de profundidad de anidamiento = 3**, como defensa en profundidad (por si la detección de ciclos tuviera un bug, o para el caso legítimo pero indeseable de una cadena A→B→C→D→E sin ciclo pero absurdamente larga). Justificación del número: 3 cubre el patrón real más razonable ("receta grande" = compuesta de 2-3 "sub-recetas" con sentido propio) sin habilitar una explosión combinatoria de pasos totales cuando se combina con `foreach` anidado (2 niveles, Tarea 1) en cada nivel de la cadena — con profundidad 3 y 2 niveles de `foreach` por receta, el peor caso sigue siendo una cota **calculable y mostrable al usuario en el diálogo de aprobación** ("esta receta puede ejecutar hasta N tools reales en una corrida"), en vez de un número que solo se descubre corriendo.

Además: un **tope global de pasos totales ya expandidos** (recomendado: 50, mismo orden de magnitud que `settings.maxToolLoop ?? 20` para DeepSeek PWA y el `MAX_TOOL_LOOP` del camino API) — si al expandir `foreach`×anidamiento la cuenta total de invocaciones reales supera ese número, la ejecución se corta con un error honesto, nunca se ejecuta parcialmente sin avisar.

---

## Tarea 6 — Detector de patrones de Q, como complemento

La idea de Q (`D:\QV2\services\router_agent.py:90-102`: contar repeticiones normalizadas en una ventana de 7 días, sugerir automatizar al llegar a 3) es simple, honesta, y **complementaria, no parte del núcleo**: es una forma de decidir *cuándo sugerir* crear una receta, totalmente independiente de cómo la receta se valida/aprueba/ejecuta (Tareas 1-4).

**Recomendación: Fase 2, no v1.** Razones concretas, no solo prudencia genérica:

- El núcleo (formato + proposal + aprobación legible + ejecutor con gates reales + storage + anidamiento) ya es una superficie grande (ver "Estimación honesta de tamaño") que toca `tool-registry.ts` — el archivo compartido por TODOS los runtimes. Sumar detección de patrones en la misma pasada mezcla una feature de UX opcional con un cambio de core de alto riesgo.
- El detector de Q opera sobre texto de mensajes de chat — en Amatista eso viviría en una capa distinta (¿por sesión? ¿por workspace? ¿cruzando chats?) que no está definida y merece su propia decisión de diseño, no un port directo.
- El valor de "sugerir proactivamente" solo tiene sentido **una vez que crear una receta ya es fácil y segura** — construir el detector antes que el núcleo sería optimizar un flujo que todavía no existe.

Si se retoma en el futuro: la lógica de conteo (`_normalize()` + `Counter` + umbral + ventana de tiempo, `router_agent.py:70-102`) es trivialmente portable tal cual está — no hay nada técnicamente difícil ahí, es una decisión de prioridad, no de factibilidad.

---

## Estimación honesta de tamaño

Comparación de referencia: el trabajo ya hecho esta sesión de "protocolo de texto + catálogo completo para DeepSeek PWA" (2 tareas de implementación real, con verificación real de 8 puntos) tocó 3 archivos y fue evaluado como sustancial pero acotado. Esta feature es mayor, por tocar el **core compartido** (`tool-registry.ts`) en vez de un solo runtime:

| Pieza | Tamaño relativo | Por qué |
|---|---|---|
| Tipos + validación estática (ciclos, referencias hacia adelante, límites de anidamiento/iteración) | Medio | Lógica nueva pero acotada y pura (sin I/O, testeable sin la app) |
| Ejecutor de recetas (`runComposedStep`, dentro de `tool-registry.ts`) | Medio-Grande | Toca el archivo más compartido y sensible del proyecto — cualquier bug afecta a las 49 tools existentes, exige revisión cuidadosa |
| Renderer legible (extensión de `TOOL_STEP_LABELS`) | Chico-Medio | Patrón ya existente, solo se extiende |
| Wiring de catálogo (2 puntos: `toolCatalog()` API + `buildToolProtocolInstructions()` DeepSeek) | Chico | Ya son arrays que se concatenan, precedente directo con `mcpToolDefinitions` |
| Storage (`.amatista/composed-tools/*.json`, CRUD) | Chico | Precedente directo con `.mcp.json` |
| Nueva tool `propose_composed_tool` + dispatch `composed__*` dentro de `ToolRegistry.execute()` | Chico-Medio | Precedente directo con el branch `mcp__` ya existente (ver refinamiento en Tarea 2) |
| **(2da pasada)** Resolución de plan: fase de descubrimiento + adaptadores de salida (`list_dir`/`search_files`/`git_status`) + expansión a plan congelado | Medio | Puro salvo las lecturas de descubrimiento, que reusan el patrón exacto de `case 'explore'` |
| **(2da pasada)** `RecipeRunGrant` + `requestRecipeRunApproval()` + builder del detalle legible (con diffs via `formatWriteFileDiff()`) | Medio | Superficie de seguridad nueva y chica — exige la revisión más cuidadosa de toda la feature, por ser lo único que responde un `confirm` sin mostrar un diálogo por llamada |
| **(2da pasada)** `ctx.refresh` en `ipc-agent.ts` (extraer el literal del `ExecuteContext` a una función) | Chico | Refactor mecánico del literal de `ipc-agent.ts:968-1029` — hay que replicarlo en la rama de DeepSeek PWA cuando se integre |
| UI de aprobación | Ninguno nuevo | El componente ya soporta `detail` multi-línea sin cambios (confirmado, `App.tsx:7208-7233`), y ya oculta el checkbox de confianza cuando `allowTrust` es `false` (`App.tsx:7234`) |
| Verificación real (mismo estándar que el resto de esta sesión: casos reales, no solo unit tests) | Grande | Necesita cubrir: receta simple, `foreach`, `if`, ciclo rechazado, profundidad excedida rechazada, **y los puntos críticos de la 2da pasada**: una sola aprobación mostrando el alcance real; rechazarla no ejecuta nada; la aprobación no sirve para una 2da corrida; `hardConfirm` sigue preguntando dentro de una corrida aprobada; archivo editado mientras el diálogo estaba abierto → esa escritura no se aprueba sola; plan mode activado a mitad de corrida → corta; no-regresión de las 49 tools |

**Estimación honesta: la feature de mayor alcance de este proyecto hasta ahora** (el propio pedido del usuario ya lo anticipa) — del orden de 3-5 veces el tamaño de la implementación del puente DeepSeek PWA de esta sesión, **ahora hacia el extremo alto de ese rango** por la segunda pasada (fase de descubrimiento + plan congelado + grant de corrida), principalmente por tocar `tool-registry.ts` compartido (exige más cuidado, no solo más líneas) y por la superficie de verificación real necesaria.

## Riesgos abiertos / lo que este diseño explícitamente NO resuelve todavía

- ~~**Fatiga de aprobación en `foreach`**~~ — **RESUELTO en la segunda pasada** (decisión del usuario: una aprobación por corrida). La tensión "seguro vs. cómodo" que esta sección dejaba abierta se resolvió sin ceder en lo que la hacía segura: la aprobación única cubre SOLO las llamadas concretas que se le mostraron al usuario, se descarta al terminar la corrida, no puede responder `hardConfirm` ni superar el sandbox. Ver la sección final.
- **Recetas condicionadas a un efecto** (ej. "corré los tests y, si fallan, escribí un reporte"): **fuera de v1 por diseño**, no por olvido — el `if` del reporte depende de la salida de un paso de `apply`, que solo se conoce después de aprobar, así que el alcance no se puede mostrar antes. Una extensión futura posible sería "varios puntos de aprobación por corrida" (una aprobación por tramo que sí se puede previsualizar), no diseñada acá.
- **Legibilidad con planes grandes:** con el tope de 50 acciones, el detalle del diálogo puede ser largo. Se muestran estadísticas `+X −Y` para todos los archivos y el diff completo solo de los primeros 3; el resto se aprueba sobre la base de la ruta + estadísticas. Es la contracara honesta de agrupar: el usuario revisa menos granularmente que con 12 diálogos de diff separados — es el trade-off que el usuario eligió, y queda explícito en el propio diálogo.
- **CLI (Tarea 2):** sin camino de ejecución hoy — explícitamente fuera de v1, no una omisión.
- **Edición de una receta ya aprobada:** este diseño no cubre "modificar" una receta existente — cualquier cambio sería, en este v1, borrar y volver a proponer (y volver a aprobar) desde cero. Es la opción más simple y más segura (nunca hay una receta "parcialmente aprobada"), pero puede ser incómoda si el usuario solo quiere ajustar un paso.
- **Quién puede borrar/listar recetas desde la UI** (no solo desde el modelo) — no diseñado en esta pasada, asumido como trabajo de UI normal una vez aprobado el núcleo.
- **Progreso en vivo dentro de una corrida:** hoy `runTool()` emite `item/toolCall/status` solo para la llamada externa (`composed__x`), no para cada paso interno — el usuario ve "Ejecutando: composed__x" durante toda la corrida. El diálogo de aprobación ya muestra el plan completo antes de empezar; mostrar el avance paso a paso requeriría un hook opcional nuevo en `ExecuteContext` (tipo `onStep`). Mejora de UX, no de seguridad — fuera de v1.

---

# Resolución: aprobación única por corrida (segunda pasada de diseño)

> Pedido del usuario: *"UNA aprobación por corrida completa de la receta (el usuario ve todo lo que va a pasar, aprueba una vez, se aplica solo a esa corrida puntual, nunca persiste)"*. El problema concreto: en "por cada archivo que encuentre `list_dir`, escribí algo", el número real de escrituras no se conoce hasta ejecutar el paso de descubrimiento. Esta sección cierra el diseño de ejecución; donde contradice a la Tarea 4 original, manda esta.

## Respuesta corta

**Sí: primero se corre la parte de solo lectura, después se muestra UNA aprobación con el alcance real ya resuelto, y recién ahí se ejecuta cualquier cosa con efectos.** Es viable con el ejecutor recursivo (`this.execute()`), y el propio código ya tiene un precedente en producción de exactamente esa pieza (`case 'explore'`). Pero la investigación encontró 3 cosas que el diseño de la primera pasada tenía mal o incompletas, y las 3 son condiciones para que esto funcione:

1. **Las lecturas no se pueden "separar solas"** reordenando los pasos de una receta — hace falta que la receta declare explícitamente qué es descubrimiento y qué es efecto (`discover`/`apply`).
2. **Las salidas de las tools son texto, no listas** — hace falta un adaptador fijo por tool de descubrimiento para poder contar "12 archivos" y para que un `foreach` pueda iterar (ya documentado en la Tarea 1).
3. **El `ExecuteContext` es una foto tomada al inicio de la llamada**, no un objeto vivo — en una corrida que dura minutos (con un diálogo esperando a un humano en el medio) hay que refrescarlo por paso, o un modo plan activado a mitad de corrida no se respetaría.

## Por qué 2 secciones explícitas y no un reordenamiento automático

La idea natural sería: el sistema mira la receta, detecta qué pasos son de solo lectura y los corre primero. **No es seguro hacerlo automáticamente**, porque un paso de lectura puede depender de uno de escritura **a través del disco**, sin ninguna referencia `{{...}}` visible entre ellos:

```
1. write_file(path="salida.txt", content="...")
2. read_file(path="salida.txt")          <-- sin {{}}, pero lee lo que escribio el paso 1
3. foreach linea en {{steps.2...}}: run_command(...)
```

Si el sistema "subiera" el paso 2 a la fase de descubrimiento, leería el contenido **viejo** (o un archivo inexistente) y armaría un plan distinto del que la receta describe — un cambio de semántica silencioso, justo el tipo de sorpresa que la aprobación busca eliminar. Ninguna validación estática puede detectar esa dependencia, porque las rutas pueden venir de datos (`{{item.name}}`).

Por eso la receta tiene 2 secciones que el autor (el modelo) declara, y la validación en `propose_composed_tool` (antes de guardar) exige:

- **`discover`** solo puede contener tools de `DISCOVERY_TOOL_NAMES` (abajo). Nunca efectos.
- **`apply`**: todo argumento, condición `if` y `foreach.in` de un paso de `apply` solo puede referenciar `input.*`, salidas de pasos de `discover`, o `item` de un `foreach` que itera sobre una salida de `discover`. **Nunca la salida de otro paso de `apply`** — eso es lo que garantiza que el plan completo de efectos se pueda resolver ANTES de aprobar. Si el modelo propone una receta que lo viola, recibe un error accionable: *"el paso X (write_file) usa el resultado de Y, que corre después de la aprobación — movelo a discover"*.
- El orden es siempre el escrito: todo `discover`, después todo `apply`. Sin reordenar nada.

Lo que esto excluye, dicho explícito: recetas donde un efecto depende del resultado de otro efecto ("corré los tests y, si fallan, escribí un reporte") — ver "Riesgos abiertos".

## Viabilidad con el ejecutor recursivo — ya existe en producción

`case 'explore'` (`tool-registry.ts:2664-2708`) ya hace una llamada recursiva `this.execute()` dentro de `execute()`, con un contexto derivado de solo lectura y **tres capas deny-by-default independientes** (`:2688-2705`, comentario del propio código):

1. **Allowlist** de tools (`EXPLORE_TOOL_NAMES`, `explore-tool.ts:40`: `read_file`, `list_dir`, `git_status`, `git_diff`, `search_files`).
2. **`sandbox: 'read-only'` fijo, deliberadamente NO heredado de `ctx.sandbox`** — el comentario (`:2690-2702`) explica por qué: si se heredara y el turno estuviera en `danger-full-access`, `resolveApproval()` auto-aprobaría sin llamar a `confirm`, anulando la capa 3.
3. **`confirm: async () => false`** hardcodeado.

La fase de descubrimiento de una receta copia ese patrón **literal**, con una sola diferencia deliberada: pasa `sessionId: ctx.sessionId` (explore no lo pasa porque nunca escribe). Con `sessionId`, cada `read_file` del descubrimiento queda registrado por `rememberSessionFileHash()` (`tool-registry.ts:2002`), y eso activa gratis la protección TOCTOU ya existente de `write_file` en la fase de efectos (ver "Casos de borde"). `hardConfirm`, `computerUseActive`, etc. quedan ausentes en ese contexto → cualquier tool que no debería estar ahí devuelve "no disponible en este contexto" (defensa en profundidad detrás del allowlist).

**`DISCOVERY_TOOL_NAMES` = `EXPLORE_TOOL_NAMES`, reusado literal** (import, una sola fuente de verdad ya revisada). Por qué una lista explícita y no "toda tool que no pide aprobación": clasifiqué las tools por el gate que llama su `case` y **`todo_write` (`tool-registry.ts:2975`) no llama a ningún gate y sin embargo muta estado de la sesión** — "no pide aprobación" no es lo mismo que "solo lectura". Sumar `read_document`/`list_file_history` (verificadas: leen, sin gate, `:2006`, `:2710-2720`) queda como extensión explícita posterior, no automática.

## Corrección: el `ExecuteContext` es una foto, hay que refrescarlo por paso

`ipc-agent.ts:968-969` construye el `ExecuteContext` como un **literal nuevo en cada llamada** a `toolExecutor`, y los campos vivos se leen en ese momento: `sandbox: session.sandbox` (`:992`), `computerUseActive: session.computerUseActive` (`:1017`), `computerUseAbortSignal: session.turnAbortSignal?.signal` (`:1018`), `browserControlActive: session.browserControlActive` (`:1029`). Para una tool normal eso es correcto (la llamada dura segundos). Para una corrida de receta, **el mismo objeto duraría toda la corrida** — incluida la espera del diálogo de aprobación, que puede ser de minutos.

Escenario real que rompería: el usuario activa el modo plan reforzado a mitad de corrida → `enablePlanMode()` → `applySandboxOverride(session, 'read-only')` (`runtime-state.ts:917-934`, `:899-903`) → `session.sandbox` pasa a `'read-only'`, pero la foto del contexto sigue diciendo `'workspace-write'` y las escrituras siguientes pasarían.

**Solución:** campo opcional nuevo `refresh?: () => ExecuteContext` en `ExecuteContext`. En `ipc-agent.ts` el literal se extrae a una función local (`const buildCtx = () => ({ ...mismo literal de hoy..., refresh: () => buildCtx() })`) y `toolExecutor` pasa a ser `(name, args) => toolRegistry.execute(name, args, buildCtx())` — comportamiento idéntico para toda tool suelta. El ejecutor de recetas llama `ctx.refresh?.() ?? ctx` **antes de cada paso**, así cada paso ve el sandbox, la Capa 1 de Familia A/navegador y la señal de cancelación vigentes en ESE momento, igual que si se hubiera llamado suelto. (Sin `refresh`, cae a la foto — solo pasaría en contextos reducidos como `mcp-approval-pipe.ts`, que de todos modos no pueden alcanzar recetas, Tarea 2.) Lo mismo hay que replicarlo en el loop de DeepSeek PWA cuando esa rama se integre.

## La corrida, fase por fase

```ts
// Dentro de ToolRegistry.execute(), antes del switch:
//   if (name.startsWith(COMPOSED_TOOL_PREFIX)) return this.runComposedTool(name, args, ctx)

private async runComposedTool(name: string, rawArgs: Record<string, unknown>, ctx: ExecuteContext): Promise<ToolExecutionResult> {
  const def = loadComposedTool(ctx.workspace, name)              // <workspace>/.amatista/composed-tools/<name>.json
  if (!def) return { ok: false, output: `Herramienta compuesta no encontrada: ${name}` }
  const inputs = pickDeclaredInputs(def, rawArgs)

  // FASE 1 -- descubrimiento, sin aprobacion (como hoy): mismas 3 capas que case 'explore' + sessionId
  const discovery = await this.runDiscovery(def, inputs, {
    workspace: ctx.workspace,
    sessionId: ctx.sessionId,
    sandbox: 'read-only',                 // NUNCA ctx.sandbox (ver :2690-2702)
    confirm: async () => false
  })
  if (!discovery.ok) return discovery.failure     // paso fallido o salida recortada -> abortar, cero efectos

  // FASE 2 -- plan congelado (puro): expande foreach/if/{{}} y recetas anidadas; topes; diffs de preview
  const plan = buildFrozenPlan(def, inputs, discovery)
  if (!plan.ok) return plan.failure
  if (plan.calls.length === 0) return summarize(discovery, [])   // receta solo-lectura: nunca pregunta nada

  // FASE 3 -- ¿hace falta dialogo? + FASE 4 -- la aprobacion unica
  const fresh0 = ctx.refresh?.() ?? ctx
  if (plan.calls.some(c => c.coverage === 'run-grant')) {
    if (fresh0.sandbox === 'read-only') return readOnlyPlanFailure(plan)          // no se aprueba algo que igual se bloquearia
    if (fresh0.sandbox === 'workspace-write') {
      if (!fresh0.confirmRecipeRun) return { ok: false, output: 'Herramientas compuestas no disponibles en este contexto de ejecucion.' }
      const approved = await fresh0.confirmRecipeRun(runTitle(def, plan), renderRunDetail(def, discovery, plan))
      if (!approved) return declinedResult(def, discovery, plan)
    }
    // 'danger-full-access': resolveApproval() ya aprobaria cada llamada cubierta sin preguntar -> sin dialogo
  }

  // FASE 5 -- ejecucion del plan CONGELADO
  const grant = new RecipeRunGrant(plan)
  try {
    const done: ExecutedCall[] = []
    for (const call of plan.calls) {
      const fresh = ctx.refresh?.() ?? ctx                           // estado VIGENTE, no la foto del inicio
      if (fresh.turnAbortSignal?.aborted) return cancelledResult(plan, done)
      const stepCtx = call.coverage === 'run-grant' && targetUnchangedSincePlan(call)   // sincronico, ver "Casos de borde"
        ? { ...fresh, confirm: grant.confirmFor(call, fresh.confirm) }
        : fresh                                                       // sin cobertura: el gate propio de la tool, intacto
      const result = await this.execute(call.tool, call.args, stepCtx)   // args CONGELADOS -- nunca se re-resuelven {{}}
      grant.disarm()
      done.push({ call, result })
      if (!result.ok) return failedResult(plan, done)               // fail-fast
    }
    return successResult(plan, done)
  } finally {
    grant.revoke()                                                   // exito, error, excepcion o cancelacion
  }
}
```

(`turnAbortSignal` es un alias nuevo, con el mismo valor que hoy ya viaja como `computerUseAbortSignal` — `session.turnAbortSignal?.signal`, `ipc-agent.ts:1018` — para no leer una señal de turno con nombre de computer use.)

**Fase 2 en detalle — el plan congelado.** Cada `PlannedCall` = `{ index, tool, args (strings ya resueltos), coverage, fingerprint, preview, expectedTargetHash? }`, congelado en profundidad (`Object.freeze` recursivo). `fingerprint = sha256(JSON canónico de {index, tool, args})` — mismo primitivo `createHash('sha256')` que `hashFileContent()` (`tool-registry.ts:410-412`); el `index` va adentro para que 2 llamadas idénticas en posiciones distintas (ej. `run_command "npm test"` dos veces) sean 2 entradas distintas, cada una consumible una sola vez. Para `write_file`/`apply_patch`/`revert_file`, el builder lee el contenido actual del destino (lectura pura, dentro de `resolveWithinWorkspace()`), calcula el diff con **`formatWriteFileDiff()` (`tool-registry.ts:611`, la MISMA función que hoy arma el diff del diálogo de `write_file`)** y guarda `expectedTargetHash = hashFileContent(contenidoActual)`. Topes que se chequean acá, antes de mostrar nada: **50 llamadas de efecto** en el plan aplanado (Tarea 5) y **50 llamadas de descubrimiento** (acota la I/O que corre antes de preguntar). Si un `foreach` encuentra más elementos que su `maxIterations`, el plan toma los primeros N en orden determinístico (orden alfabético del adaptador) **y el diálogo lo dice explícito** ("se encontraron 37, la receta procesa como máximo 20: estos 20").

## `RecipeRunGrant` — "aplica solo a esta corrida, nunca persiste"

```ts
class RecipeRunGrant {
  readonly runId = randomUUID()                  // mismo primitivo que requestToolApproval() (runtime-state.ts:975)
  private armedFor: string | null = null         // fingerprint de la UNICA llamada que puede responder ahora mismo
  private readonly consumed = new Set<string>()
  private revoked = false
  constructor(private readonly plan: FrozenPlan) {}

  confirmFor(call: PlannedCall, fallback: ConfirmFn): ConfirmFn {
    if (this.revoked || this.consumed.has(call.fingerprint) || !this.plan.approvedFingerprints.has(call.fingerprint)) return fallback
    this.armedFor = call.fingerprint
    return async (title, detail) => {
      if (!this.revoked && this.armedFor === call.fingerprint) {
        this.armedFor = null
        this.consumed.add(call.fingerprint)
        return true                                // UNA respuesta, para ESTA llamada del plan que el usuario vio
      }
      return fallback(title, detail)               // cualquier confirm extra, tardio o ajeno -> el dialogo real de siempre
    }
  }
  disarm(): void { this.armedFor = null }
  revoke(): void { this.revoked = true; this.armedFor = null }
}
```

Cómo se garantiza cada propiedad pedida, estructuralmente (no por disciplina):

- **"Aplica solo a esta corrida":** el objeto es una variable local de `runComposedTool()`. **Nunca** se guarda en `session`, en un `Map` de módulo ni en disco. Cuando la función retorna (por cualquier camino), no queda ninguna referencia viva; y el `finally` lo revoca igual, así que aunque algún closure hubiera quedado retenido por error, cualquier `confirm` posterior cae al `fallback` (el diálogo real).
- **"Nunca persiste" ni entre corridas:** una segunda corrida de la misma receta (incluso en el mismo turno) crea su propio `RecipeRunGrant` vacío, con otro `runId`, y vuelve a pasar por descubrimiento + aprobación.
- **Solo lo que el usuario vio:** el grant solo se arma para `PlannedCall`s cuyo `fingerprint` está en el set aprobado, y el ejecutor les pasa los args **congelados**, nunca re-resueltos. El chequeo de fingerprint es defensa en profundidad contra un bug futuro del propio ejecutor (ej. un refactor que vuelva a resolver `{{}}` en tiempo de ejecución).
- **Una respuesta por llamada:** one-shot. Si una tool cubierta pidiera un segundo `confirm` dentro de la misma llamada, ese segundo cae al diálogo real (pregunta de más, nunca de menos).
- **Nunca responde `hardConfirm`:** `stepCtx` solo reemplaza `confirm`; `hardConfirm` se copia intacto de `fresh`.
- **Nunca supera el sandbox:** `resolveApproval()` decide `read-only` (→ `false`) y `danger-full-access` (→ `true`) **antes** de llamar a `confirm` (`tool-registry.ts:391-393`) — el grant solo es alcanzable en `workspace-write`, que es justamente el único modo donde la tool habría preguntado.

### Comparación directa con `toolTrustSession`

| | `toolTrustSession` (existente) | `RecipeRunGrant` (nuevo) |
|---|---|---|
| Dónde vive | Campo de `SessionRuntimeState` (`runtime-state.ts:220`) | Variable local de `runComposedTool()` |
| Qué cubre | Cualquier `confirm` de cualquier tool con `allowTrust` (`runtime-state.ts:972`) | Solo las llamadas del plan mostrado, una vez cada una, por fingerprint |
| Cuánto dura | Hasta apagarla a mano, desconectar o que el chat pierda su panel (`runtime-state.ts:517`, `:1067`) | Hasta que termina esa corrida (`finally` → `revoke()`) |
| ¿Cubre `hardConfirm`? | No (`allowTrust:false`) | No (nunca envuelve `hardConfirm`) |
| ¿Supera el sandbox? | No | No |
| ¿Se activa sin querer? | Sí: basta tildar el checkbox de cualquier diálogo normal (`ipc-agent.ts:1369`) | No: nace y muere dentro de una sola llamada, y su diálogo no tiene checkbox (abajo) |

### El diálogo de la corrida: `requestRecipeRunApproval()`

```ts
// runtime-state.ts, junto a requestSessionToolApproval()/requestHardToolApproval()
export function requestRecipeRunApproval(chatId: string, title: string, detail: string): Promise<boolean> {
  const session = getSession(chatId)
  if (session.toolTrustSession) return Promise.resolve(true)   // mismo resultado que tendrian las N llamadas sueltas
  return requestToolApproval(chatId, title, detail, false)     // allowTrust:false -> el dialogo NO muestra "confiar"
}
```

Wireado en `ipc-agent.ts` como campo opcional nuevo `confirmRecipeRun: (t, d) => requestRecipeRunApproval(chatId, t, d)`. Las dos decisiones de esas 2 líneas:

- **Sin checkbox de "confiar en este agente"** (`allowTrust:false` → la UI no lo renderiza, `App.tsx:7234`). Crítico: ese checkbox, tildado en cualquier diálogo, se convierte en `setSessionToolTrust(chatId, true)` (`ipc-agent.ts:1369`) — confianza **de sesión entera**, que sobrevive a la corrida. Es exactamente la persistencia que el usuario excluyó; si el diálogo de la corrida lo ofreciera, "aprobar esta corrida" se podría convertir sin querer en "aprobar todo lo que venga".
- **Sí respeta una confianza de sesión que el usuario YA activó antes, por su cuenta.** Principio de todo este diseño: *la corrida nunca pregunta más ni concede más que la suma de sus pasos bajo el mismo modo; solo agrupa las preguntas que esos pasos ya iban a hacer*. Si `toolTrustSession` está activo, las N llamadas sueltas se habrían auto-aprobado (`runtime-state.ts:972`) — agruparlas no cambia eso.

Por la misma regla: en `danger-full-access` no hay diálogo (ninguna de las llamadas cubiertas habría preguntado); en `read-only` la corrida se corta **antes** del diálogo con un error honesto ("este chat está en solo lectura: la corrida incluye N escrituras/comandos que se bloquearían") — nunca se le pide al usuario aprobar algo que igual se va a bloquear. El diálogo reusa el componente de siempre sin cambios (`<pre>{detail}</pre>`, `App.tsx:7232`); el título empieza con `"Correr herramienta:"`, nunca con `"Escribir archivo:"` (que activaría el renderer de diff línea por línea, `App.tsx:7213`).

Contenido del diálogo, ejemplo real de forma:

```
Correr herramienta: agregar_encabezado — 13 acciones

Ya hecho (solo lectura, no cambió nada):
  • Listó docs/ → 14 entradas (12 archivos, 2 carpetas)
  • Leyó 12 archivos

Con esta aprobación va a:
  Escribir 12 archivos:
    docs/arquitectura.md      +2 −0
    docs/instalacion.md       +2 −0
    ... (10 más — lista completa al final)
  Ejecutar 1 comando:
    npm run lint:md

Te va a preguntar aparte, como siempre (NO cubierto por esta aprobación):
  (ninguna acción en esta corrida)

Diff completo de los primeros 3 archivos:
  --- docs/arquitectura.md
  +# Proyecto X
  +
  ...

Esta aprobación vale SOLO para esta corrida (id 7f3a…) y se descarta cuando termina,
salga bien o mal. Si alguno de estos archivos cambia en disco antes de que le toque,
esa escritura NO queda aprobada: te la voy a preguntar aparte, con el diff real.
```

## Qué cubre y qué NO cubre la aprobación de corrida

| Clase | Tools | ¿Cubierta? | En la corrida |
|---|---|---|---|
| Descubrimiento | `read_file`, `list_dir`, `git_status`, `git_diff`, `search_files` | N/A | Fase 1, antes de preguntar — nunca preguntan, igual que hoy |
| Sensibles canónicas | `write_file`, `apply_patch`, `run_command`, `revert_file` | **Sí** | Un solo diálogo para todas |
| Con gate propio (`confirm`) | `notify`, `open_url`, `open_folder`, `open_app`, `clipboard_*`, `volume`, `system_info`, `list_processes`, `generate_image`, `web_search`, `web_fetch`, `terminal_exec`, ... | No | Su diálogo individual de siempre, marcadas en el detalle como "te va a preguntar aparte" |
| `hardConfirm` (Familia A/B, navegador) | `close_app`, `lock_screen`, `power`, `screenshot`, `mouse_*`, `keyboard_type`, `browser_*` | **Nunca** | Su diálogo incondicional de siempre, con Capa 1 releída fresca por paso (`refresh`) |
| Sin gate, con efecto | `todo_write` | N/A | Se ejecuta igual que suelta hoy — listada en el detalle para que se vea |

**Por qué exactamente esas 4 y no más:** son las 4 que el propio comentario de `resolveApproval()` nombra como sus usuarias (`tool-registry.ts:373-376`), y verifiqué sobre el código real (líneas no-comentario de cada `case`) que **cada una llama a `resolveApproval()` exactamente una vez, sin `ctx.confirm()` directo y sin `hardConfirm`** (`write_file` `:2122-2235`, `apply_patch` `:2237-2371`, `run_command` `:2606-2619`, `revert_file` `:2722-2810`). Esa propiedad ("un `confirm`, y es la aprobación de la acción que el diálogo describe") es lo que hace que un grant one-shot sea correcto. **Regla escrita para el futuro:** sumar una tool a la cobertura exige verificar esa misma propiedad para ella; no se deduce de "parece sensible".

## Casos de borde resueltos

- **Un archivo cambia entre el descubrimiento y su escritura** (el usuario lo edita mientras el diálogo está abierto, u otro panel lo toca). Dos capas, ninguna nueva salvo la primera:
  1. *Antes de armar el grant* para esa llamada, `targetUnchangedSincePlan(call)` relee el destino y compara con `expectedTargetHash`. Si cambió, **el grant no se arma**: la tool corre con su `confirm` normal y muestra **su propio diálogo con el diff real actual**. La corrida degrada a aprobación por paso, nunca a aprobación silenciosa. Ese chequeo y la captura de `existingContent` dentro de `write_file` (`tool-registry.ts:2126-2128`) quedan en el mismo tramo sincrónico (sin `await` entre medio), la misma técnica que el código ya usa para cerrar ventanas de concurrencia (`tool-registry.ts:2174-2183`). *(A verificar en implementación: que `apply_patch`/`revert_file` también capturen el contenido antes de su primer `await`.)*
  2. Si ese archivo se había leído en `discover`, además aplica la protección TOCTOU existente de `write_file` (`sessionHash` vs. contenido fresco, `tool-registry.ts:2142`, `:2201-2206`): la escritura falla con el mensaje honesto de siempre ("cambió en disco después de que lo leíste"). Gratis, por haber pasado `sessionId` al descubrimiento.
- **Cambia el modo a mitad de corrida** (modo plan reforzado → `read-only`): la siguiente llamada con efecto la bloquea `resolveApproval()` antes de llegar al grant (gracias a `refresh`) → fail-fast.
- **Familia A desarmada a mitad de corrida:** Capa 1 releída por paso (`refresh`) → la tool de computer use bloquea de raíz, como siempre.
- **Turno cancelado** (Detener, backstop): chequeo de `turnAbortSignal` antes de cada paso → corta; el `finally` revoca el grant. Si se cancela con el diálogo abierto, al volver la aprobación se chequea la señal antes de ejecutar nada.
- **Falla un paso a mitad de corrida:** fail-fast, sin rollback automático en v1 — pero cada escritura ya queda versionada en el historial oculto por `commitVersion()` (`tool-registry.ts:2215-2220`), así que el resultado le indica al modelo/usuario que `list_file_history`/`revert_file` pueden deshacer lo que sí se escribió.
- **El usuario rechaza:** no se ejecuta ninguna acción con efecto. El modelo recibe: *"El usuario rechazó la corrida 7f3a…: no se ejecutó ninguna acción con efectos (descubrimiento hecho: listó 1 carpeta, leyó 12 archivos). No reintentes automáticamente."* — mismo criterio de "cero reintentos automáticos" del resto del proyecto. No se le devuelve el contenido completo de lo leído (no hace falta y ahorra contexto; de todos modos esas lecturas son las que el modelo ya podía hacer sin aprobación).
- **Recetas anidadas:** una receta hija dentro de `apply` del padre se **aplana** en el plan del padre: su `discover` corre en la fase de descubrimiento del padre (sus inputs tienen que resolverse desde inputs/descubrimiento del padre, misma regla), su `apply` se expande dentro del plan congelado → **una sola aprobación para todo el árbol**. Una receta con `apply` no vacío no puede aparecer dentro de `discover` (rechazado al proponer). Profundidad ≤ 3, ciclos rechazados al proponer y tope de 50 sobre el plan aplanado (Tarea 5), sin cambios.
- **Receta sin `apply`** (solo lectura): nunca pregunta nada — igual que llamar esas tools sueltas.
- **`apply` sin llamadas cubiertas** (solo tools con gate propio o `hardConfirm`): sin diálogo de corrida (no concedería nada); cada una pregunta lo suyo.

## Qué recibe el modelo

- Éxito: `"Corrida 7f3a… de agregar_encabezado: 13/13 acciones ejecutadas"` + salida de cada llamada (recortada con el mismo `clip()`).
- Falla/cancelación: cuántas se ejecutaron, cuál falló y por qué (motivo real), cuáles no llegaron a correr, y la nota de versionado.
- Rechazo / `read-only` / plan inválido (salida recortada, tope excedido): mensaje honesto, cero efectos.

## Decisiones cerradas en esta pasada

| Decisión | Cerrada como | Por qué |
|---|---|---|
| ¿Leer primero para conocer el alcance real? | Sí — fase `discover` explícita, antes de preguntar | El alcance real ("12 archivos") solo existe después de leer |
| ¿Reordenar automáticamente lecturas antes que escrituras? | **No** — secciones `discover`/`apply` declaradas y validadas | Una lectura puede depender de una escritura por el disco sin `{{}}` visible |
| ¿Qué cubre la aprobación única? | Las 4 sensibles canónicas, por fingerprint, una vez cada una | Única clase verificada con "un solo `confirm` por llamada" |
| ¿Cubre `hardConfirm`? | **Nunca** | Invariante de guardia monótona existente, no se debilita |
| ¿Cómo se garantiza que no persista? | `RecipeRunGrant` local + `revoke()` en `finally`, diálogo sin checkbox de confianza | Estructural, no por disciplina |
| ¿Contexto por corrida o por paso? | Por paso (`ctx.refresh`) | El literal de `ipc-agent.ts` es una foto; una corrida dura minutos |
| `danger-full-access` / `toolTrustSession` ya activa | Sin diálogo | La corrida no pregunta más que la suma de sus pasos. **Único punto marcado para revisión del usuario:** si prefiere ver el diálogo siempre (aunque no conceda nada), es un cambio de una condición |
| Archivo cambiado mientras el diálogo esperaba | Esa escritura no queda aprobada → diálogo individual con el diff real | Degradar a más aprobación, nunca a menos |
| Recetas con efectos que dependen de otros efectos | Fuera de v1 | No se pueden previsualizar antes de aprobar |

Con esto el diseño queda cerrado para pasar a implementación.

---

# Implementación real v1 (2026-09-23, rama `experiment/composed-tools`, sin commit)

> Implementa el diseño cerrado arriba. Alcance v1 confirmado por el usuario: runtimes API (nativo) + DeepSeek PWA (protocolo de texto); CLI fuera de alcance. Prioridad pedida: corrección sobre velocidad, verificación por partes. `npm run typecheck`/`npm run build` limpios después de cada pieza mayor.

## Composición de la rama (decisión tomada al arrancar)

El protocolo de texto de DeepSeek PWA vive en `experiment/deepseek-pwa-tools` (commit `bcc3a2a`), que **no** es ancestro de esta rama (esta salió de `master`, que tiene `da76980` y no tiene `bcc3a2a`). Como el alcance v1 incluye DeepSeek PWA y la restricción era "sin commits", se aplicó con `git cherry-pick -n bcc3a2a`: aplica el puente al árbol de trabajo **sin commitear**, reversible y sin tocar la historia. Aplicó limpio (auto-merge de `deepseek-pwa-runtime.ts`), y quedó en el **índice (staged)**, mientras todo el trabajo de herramientas compuestas quedó como diff **no-staged** — `git diff --cached` = puente, `git diff` = herramientas compuestas, separables a la hora de commitear (por ejemplo, un merge real de `experiment/deepseek-pwa-tools` primero y las herramientas compuestas después).

**Resuelto al commitear (decisión del usuario):** la parte DeepSeek PWA de esta feature (`buildPwaToolContext()`, `extraDefinitions`) modifica código que solo existe gracias al puente, así que no se podía commitear sin él. Se hizo un **merge real** de `experiment/deepseek-pwa-tools` (verificado idéntico al índice del cherry-pick: `git diff` vacío) y después el commit de herramientas compuestas encima. La historia de la rama hermana queda preservada y el puente no se duplica.

## Archivos

| Archivo | Cambio |
|---|---|
| `src/main/composed-tools.ts` (**nuevo**, 921 líneas) | Módulo hoja (nunca importa `tool-registry.ts` en runtime): tipos, validación estática, plantillas `{{…}}` y condiciones (sin `eval`, solo propiedades propias), adaptadores fijos de salida, `RecipeRunGrant`, huella de llamadas, almacenamiento firmado, texto legible de creación |
| `src/main/tool-registry.ts` | `propose_composed_tool` en `TOOL_DEFINITIONS`; `ExecuteContext` exportada + `refresh`/`confirmRecipeRun`/`turnAbortSignal`; despacho por prefijo `composed__` dentro de `execute()`; `runComposedTool()` (descubrimiento → plan congelado → aprobación única → ejecución); `computePatchedContent()` extraído del `case 'apply_patch'` (mismo código, mismos mensajes) para que la vista previa y la escritura salgan del mismo cálculo |
| `src/main/runtime-state.ts` | `requestRecipeRunApproval()`: sin checkbox de confianza, respeta una confianza de sesión ya activa |
| `src/main/ipc-agent.ts` | Literal del `ExecuteContext` del camino API movido a `buildApiToolContext()` (refactor mecánico por script anclado en texto, 180 líneas, CRLF preservado) + `refresh`/`confirmRecipeRun`/`turnAbortSignal`; mismo tratamiento en el loop de DeepSeek PWA (`buildPwaToolContext()`); recetas del workspace en el catálogo de texto de DeepSeek |
| `src/main/api-agent-runtime.ts` | `toolCatalog()` suma las recetas aprobadas del workspace, leídas frescas en cada request |
| `src/main/deepseek-pwa-runtime.ts` | `ToolProtocolCatalogOptions.extraDefinitions` |

## Diferencias con el diseño (todas deliberadas, con su motivo)

1. **El grant se verifica en el momento del `confirm()`, no antes de llamar a la tool.** Hallazgo al implementar: `revert_file` hace `await readFileVersion()` (git) **antes** de leer el contenido actual (`tool-registry.ts`, `case 'revert_file'`), así que un chequeo de huella previo a la llamada dejaba una ventana abierta. Dentro del callback de `confirm`, las 3 tools de archivo acaban de leer el disco en el **mismo tramo sincrónico** (leen y llaman a `resolveApproval()` sin `await` entre medio), así que la huella que compara el grant es la del contenido que la tool va a pisar. Además, el grant exige que **título y detalle** del `confirm()` coincidan exactamente con los que el plan precalculó con las mismas funciones (`formatWriteFileDiff()`, `computePatchedContent()`, `readFileVersion()`). Cualquier diferencia cae al diálogo real.
2. **Crear una receta usa `hardConfirm`** (diálogo incondicional, sin checkbox, que no respeta `danger-full-access` ni la confianza de sesión), no `requestSessionToolApproval()`. Motivo: "aprobación obligatoria" — una receta extiende el catálogo para siempre y no puede crearse sola porque el chat esté en acceso completo. En `read-only` (modo plan reforzado incluido) crearla se bloquea de raíz, porque escribe un archivo.
3. **Recetas firmadas con HMAC.** Hueco real encontrado al implementar: la receta aprobada queda como JSON **dentro del workspace**, así que un `write_file` común podría modificarla después sin pasar por la aprobación de creación. La clave vive en `D:\AMATISTA\data\config\composed-tools.key` (fuera de cualquier workspace, inalcanzable para tools confinadas). Una receta editada fuera del flujo no aparece en el catálogo y no corre.
4. **Pre-chequeo TOCTOU al congelar el plan** (hallazgo durante la verificación, ver punto 3 abajo): si la sesión ya vio otro contenido de un archivo destino, `write_file`/`apply_patch` lo van a rechazar después de aprobar. Ahora se corta **antes** de pedir aprobación (mismo principio que `read-only`: nunca pedir aprobar algo que va a fallar).
5. **Lenguaje de receta**: se agregó `where` al `foreach` (filtrar antes de iterar, ej. solo `.py`) y los operadores `startsWith`/`endsWith`. Sigue siendo comparación contra un literal.
6. **Recetas anidadas "puras"**: una hija en `discover` no puede tener `apply`; una hija en `apply` no puede tener `discover`. Si no, sus lecturas correrían antes de los efectos anteriores del padre (el mismo reordenamiento oculto que motivó las 2 secciones).
7. **`inputs`/`discover`/`apply` se declaran como strings con JSON** en el schema (también se aceptan ya parseados): un solo formato para los 4 proveedores API y el protocolo de texto, sin depender de cómo cada proveedor tolere objetos libres en su dialecto de schema.
8. **El despacho de `composed__*` vive dentro de `execute()`**, no en `runTool()`: funciona igual para API y DeepSeek PWA, y el ejecutor accede a los helpers privados de `tool-registry.ts`.
9. **Hallazgo real en un adaptador**: el fallback manual de `search_files` corta en exactamente 200 coincidencias **sin** el aviso de recorte (el aviso solo sale con más de 200), así que el adaptador trata "exactamente 200" como posiblemente recortado y aborta.

**Límite de anidamiento: 3** (receta → hija → nieta), ya fijado en el diseño (Tarea 5), implementado en validación (al proponer y al cargar) y en ejecución (defensa en profundidad).

## Verificación

### Por partes: lógica pura (48/48)

Bundle aislado de `composed-tools.ts` (esbuild) con storage root temporal (la clave y las recetas de prueba nunca tocan `D:\AMATISTA\data` ni un proyecto real): validación (14 casos de rechazo, entre ellos `apply` usando la salida de otro `apply`, efectos en `discover`, `foreach` sin tope, condición contra otra referencia, tools inexistentes/excluidas, 3 niveles de `foreach`, peor caso > 50, llaves anidadas), anidamiento (profundidad 3 aceptada, 4 rechazada, ciclo detectado, hija mixta en `apply` rechazada), plantillas (sin acceso a `constructor`), adaptadores (salida recortada, tope silencioso de `search_files`, `git status` con renombres y comillas), el grant (coincidencia exacta, un solo uso, título distinto, archivo cambiado, revocado, llamada fuera del plan, `hard-confirm` nunca cubierta) y la firma (receta editada a mano → rechazada y fuera del catálogo).

### Real, de punta a punta (app compilada, modelos reales, workspace sintético)

Workspace sintético: `src/a.py` (10 líneas), `src/b.py` (5), `src/c.py` (3), `src/notas.txt`, `src/sub/`. Receta del punto 1 (`lineas_py`): `discover` lista la carpeta y lee cada `.py`; `apply` escribe un `<archivo>.lineas.txt` al lado de cada uno. Modelo: **Gemini Auto** (`gemini-api`). La primera opción, DeepSeek por API, devolvió un error real `402: Insufficient Balance` (cuenta sin saldo, ajeno al código). Cada punto corrió en un chat nuevo: en un chat con historial, Gemini llegó a repetir el resultado de un turno anterior sin llamar la tool.

| # | Punto | Resultado real |
|---|---|---|
| 1 | Receta de punta a punta | ✅ El modelo llamó `propose_composed_tool` → diálogo de creación en texto legible (sin JSON crudo, **sin** checkbox de confianza), receta no guardada hasta aprobar → aprobada → llamó `composed__lineas_py` → **diálogo único con el alcance real resuelto**: "Escribir 3 archivos: src/a.py.lineas.txt / b / c (archivo nuevo)", más "Ya hecho: Lista la carpeta src → 5 elementos; Lee src/a.py → 10 líneas; b → 5; c → 3" y los diffs → ningún archivo existía mientras esperaba → aprobada → los 3 escritos (`10 lineas`/`5 lineas`/`3 lineas`), y el modelo respondió "3 archivos .py con un total de 18 líneas (10 + 5 + 3)" |
| 2 | **El más importante: nada se toca hasta aprobar; rechazar cancela todo** | ✅✅ Con `a.py.lineas.txt` preexistente y `b`/`c` sin crear: el diálogo mostró la sobrescritura real de `a` (`+1 -2`) y los 2 nuevos. **3 lecturas de disco en 4,5 s mientras esperaba: sin ningún cambio.** Rechazado → los 3 archivos idénticos a antes y el `mtime` de `a` intacto; el modelo recibió el rechazo |
| 3 | **Archivo destino cambiado entre el plan y la ejecución** | ✅✅ `b.py.lineas.txt` = "VIEJO B" al armar el plan → modificado en disco **mientras el diálogo único esperaba** → aprobado → `a` escrito por la aprobación única → `b` **perdió la cobertura** y mostró **su propio diálogo individual** ("Escribir archivo: src/b.py.lineas.txt") con el **diff real contra el contenido nuevo** (`-CAMBIADO A MITAD DE CAMINO POR OTRO` / `+5 lineas`); `c` todavía no existía mientras ese diálogo esperaba → aprobado → `b` y `c` escritos |
| 4 | Familia A/B dentro de una receta | ✅ Receta `marca_y_cierra` (`write_file` + `close_app` sobre un proceso inexistente, doble seguro). El diálogo de creación y el diálogo único marcaron `close_app` como "NO cubierto… [te pregunta aparte, SIEMPRE]". Aprobada la corrida → `marca.txt` escrito → apareció **aparte** el diálogo real de `hardConfirm` ("Cerrar aplicacion…", **sin** checkbox) → rechazado → `close_app` no corrió |
| 5 | Sandbox real | ✅ **Solo lectura:** ningún diálogo, ningún archivo escrito; el modelo recibió el motivo ("modo de solo lectura", con las 18 líneas del descubrimiento). **Workspace:** diálogo único (puntos 1-3). **Acceso completo:** ningún diálogo, los 3 archivos escritos |
| 6 | CLI | ✅ Se levantó el mismo servidor MCP que reciben los CLI (`out/main/mcp-lsp-server.cjs`, con el mismo ejecutable y entorno que `mcpLspServerSpawnSpec()` y todas las banderas que amplían el catálogo encendidas) y se le pidió `tools/list` por stdio: **17 tools, sin `propose_composed_tool` ni `composed__*`**, aunque el workspace tenía recetas aprobadas. Los CLI nunca reciben `TOOL_DEFINITIONS`, así que la ausencia es estructural y no hace falta ningún filtro nuevo |
| 7 | Anidamiento | ✅ `nivel_c` ← `nivel_b` ← `nivel_a` (profundidad 3) creadas con su diálogo. `nivel_z` → `nivel_a` (profundidad 4) **rechazada sin diálogo** con "Anidamiento de recetas: profundidad 4, el maximo es 3 (receta -> hija -> nieta)" y no guardada. `composed__nivel_a` corrió con **una sola** aprobación (el `write_file` de `nivel_c` aplanado) y escribió `anidado.txt` |
| + | **DeepSeek PWA (protocolo de texto)** | ✅ `composed__lineas_py` apareció en el catálogo del primer mensaje y DeepSeek la corrió por `TOOL_CALL` → mismo diálogo único con alcance real, sin checkbox → nada escrito mientras esperaba → aprobado → escrito; DeepSeek reportó "Total: 18 líneas". Creación por `TOOL_CALL` con args JSON en string → diálogo de creación → guardada |

### Incidentes y hallazgos reales durante la verificación (documentados con transparencia)

- **Bug previo de `gemini-api`, ajeno a esta feature**: todo turno de Gemini termina mostrando "El turno termino sin texto de assistant." aunque la respuesta se ve bien. Confirmado con un turno "hola" **sin tools y sin ninguna receta en el catálogo** (carpeta de recetas movida afuera temporalmente). No aparece con DeepSeek PWA. Quedó propuesto como tarea aparte (chip "Fix false 'turno sin texto' error on Gemini API turns"); el harness lo registra como aviso sin tapar ningún otro error.
- **La protección TOCTOU existente sigue aplicando dentro de las recetas**: en un intento del punto 3, `write_file` rechazó `a.py.lineas.txt` porque esta misma sesión lo había escrito en el punto 1 y el harness lo borró por afuera. Correcto: la corrida se cortó ahí (fail-fast). Esto motivó el pre-chequeo del punto 4 de "Diferencias", para cortar **antes** de pedir aprobación.
- **Error transitorio del proveedor**: Gemini devolvió `503 high demand` a mitad del punto 7. Las 3 recetas válidas ya estaban creadas, y los pasos restantes se retomaron en un chat nuevo.

### Datos reales tocados

- **Cuenta real de DeepSeek (PWA)**: 1 conversación nueva de prueba (chat local `COMPOSED-VERIFY-PWA (borrable)`, 2 turnos) sobre el workspace sintético. Ninguna conversación existente tocada ni borrada.
- **Chats locales de prueba**: `COMPOSED-VERIFY-API`, `-GEMINI`, `-P3`, `-P4`, `-P5-RO`, `-P5-DA`, `-P7`, `-P7B`, `-PWA`, todos marcados "(borrable)".
- **Archivo nuevo en los datos reales de la app**: `D:\AMATISTA\data\config\composed-tools.key` (la clave de firma; es su ubicación real de producción).
- Recetas, archivos escritos y `.amatista/` solo dentro del workspace sintético del scratchpad. Ningún proyecto real del usuario.

## Alcance y límites de v1

- **CLI**: sin camino de ejecución (ver Tarea 2); ausente de su catálogo por estructura.
- **Catálogo de DeepSeek PWA**: las recetas solo viajan en el primer mensaje de una conversación nueva. Una receta aprobada a mitad de conversación igual se puede llamar por nombre (el despacho es por prefijo), pero no aparece listada hasta la conversación siguiente.
- **Parser del protocolo de texto**: `TOOL_CALL_RE` corta en el primer `)`, así que un JSON de receta que contenga paréntesis dentro de un string no se parsea por DeepSeek PWA. Por el camino API no aplica.
- **Sin rollback automático**: si una corrida falla a mitad de camino, lo ya escrito queda versionado en el historial oculto (`list_file_history`/`revert_file`) y el resultado lo dice.
- Sin UI para listar/borrar recetas, sin edición de recetas aprobadas (borrar y volver a proponer), sin progreso paso a paso dentro de una corrida (el usuario ve el plan completo en el diálogo antes de empezar).
- **Sin commit**, pedido explícito del usuario.
