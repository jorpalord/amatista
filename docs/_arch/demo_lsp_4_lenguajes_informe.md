# Informe consolidado — Demo grabada de los 4 lenguajes (LSP)

> Basado en `docs/_arch/verify_lsp_demo_scope.md` (Tarea 0) + el fix de aislamiento de
> `get_diagnostics()` ya cerrado. Este documento consolida metodología, evidencia real
> y el bloqueo de infraestructura encontrado — no reemplaza `CONTRACT.md`/`HISTORY.md`
> (donde queda el registro oficial de la fase), es el detalle completo para quien
> quiera revisar cada paso.

## 0. Resumen ejecutivo

- **Trazabilidad JSON-RPC + latencia real**: implementadas, gateadas por `AMATISTA_DEBUG_TOOLS`, verificadas con 23 pares send/recv reales.
- **Bug real encontrado y corregido durante la construcción de la demo** (no anticipado): `lsp-client.ts` convertía errores de protocolo JSON-RPC en el literal `"[object Object]"` en vez del mensaje real. Corregido.
- **Aislamiento de diagnósticos**: reproducido en el escenario exacto del bug original, confirmado corregido.
- **Los 4 lenguajes**: cada uno con su prueba específica pedida, las 4 con evidencia real.
- **Ahorro de tokens**: medido con calentamiento explícito, documentado, no ocultado.
- **Video**: **NO se pudo grabar** — bloqueo real de infraestructura de la sesión de escritorio de este entorno (detalle completo en la sección 7). Sustituido por el log paralelo completo + una captura de pantalla real de Amatista 0.8.2.

## 1. Metodología

Mismo patrón real usado en toda la sesión: `ToolRegistry`/`LspManager` reales, bundleados standalone con esbuild + stub de `electron`, invocados directo — sin turno de LLM real, ejercitando el código de producción real. Workspace de demo (`demo_lsp_workspace/`, en scratchpad, no versionado) con los 4 lenguajes coexistiendo y relaciones específicas por lenguaje (ver sección 4).

Ejecución final autoritativa: `AMATISTA_DEBUG_TOOLS=1 node demo_lsp_4_lenguajes_bundle.cjs`, con:
- Log paralelo real con timestamps (`docs/_arch/demo_lsp_4_lenguajes.log`), escrito por el propio harness.
- Trazabilidad JSON-RPC completa en consola (`[lsp:send]`/`[lsp:recv]`, gateada por `AMATISTA_DEBUG_TOOLS`).
- Ritmo visible: pausas reales (`beat()`, 2.5s) entre pasos narrados.

## 2. Tarea 1-2 — Trazabilidad JSON-RPC + latencia real

**Código** (`src/main/lsp-client.ts`): `pending` extendido con `method`/`sentAt`. `request()` loguea el lado enviado; `handleChunk()` loguea el lado recibido con `latencyMs = Date.now() - sentAt` real. Ambos gateados por `process.env.AMATISTA_DEBUG_TOOLS === '1'` — sin este flag, cero cambio de comportamiento (confirmado, `npm run typecheck`/`npm run build` limpios, y el resto de la app nunca lo activa).

Ejemplo real capturado (initialize + definition, Python/pyright):
```
[lsp:send] id=1 method=initialize sentAt=1788155797021 params={...}
[lsp:recv] id=1 method=initialize latencyMs=229 payload={"result":{"capabilities":{...
[lsp:send] id=2 method=textDocument/definition sentAt=1788155797251 params={...}
[lsp:recv] id=2 method=textDocument/definition latencyMs=557 payload={"result":[{"uri":".../utils.py",...
```

**Tabla de latencia real** (tool round-trip completo, medido con `Date.now()` en el propio harness — incluye `ensureOpen()`/apertura del archivo, no solo el request LSP puro):

| Paso | Descripción | Latencia real |
|---|---|---|
| A1 | `list_symbols(error_demo.ts)`, TS en frío | 1012ms |
| A2 | `get_diagnostics()` sin path (vacío) | 1ms |
| A3 | `get_diagnostics(error_demo.ts)` con path | 1ms |
| B0a/B0b | `list_symbols(carrito.ts)`/`(factura.ts)` | 23ms / 13ms |
| B1 | `find_references(Producto)` | 26ms |
| C1 | `find_definition`, Python en frío | 797ms |
| C2 | `find_references`, Python caliente | 6ms |
| D1 | `find_definition`, Rust en frío (1er intento) | 170ms |
| D1-retry1 | Rust, todavía cargando | 1ms |
| D1-retry2 | Rust, error real `-32801 content modified` | 1599ms |
| D1-retry3 | Rust, resultado real estable | 343ms |
| E1 | `find_references`, Go, cruzando paquete | 1940ms |
| F0 | `find_definition`, proyecto real, calentamiento (descartado) | 1045ms |
| F1 | `find_definition`, proyecto real, medición estable | 14ms |

Patrón real confirmado: 0-30ms en caliente (archivo ya trackeado, index ya cargado); 150ms-2000ms en frío (primera carga real del proyecto/crate/módulo) — consistente con los tiempos ya documentados en Fases anteriores (Fase 20: 2.7-3.7s frío/442ms caliente para diagnósticos; acá el rango es más bajo porque `find_definition`/`references`/`documentSymbol` no esperan una publicación async de diagnósticos, son request/response directos).

## 3. Bug real encontrado y corregido durante la construcción de la demo

**No fue anticipado por la investigación previa** — apareció al construir el CASO D (Rust) de la demo. `find_definition` sobre `Circulo` (un crate real, recién creado, nunca antes indexado) devolvía el literal `"[object Object]"` en vez de un mensaje útil.

**Causa real, confirmada con un harness de depuración aislado**: `handleChunk()` hacía `reject(msg.error)` — `msg.error` es el objeto crudo del protocolo JSON-RPC (`{code, message, data}`), **nunca una instancia de `Error`**. El catch genérico de `ToolRegistry.execute()` (`error instanceof Error ? error.message : String(error)`) caía siempre a `String(error)`, que para un objeto plano de JS produce exactamente el literal `"[object Object]"` — perdiendo el `.message` real.

**Confirmado con evidencia real** (harness aislado, `debug_rust_def_bundle2.cjs`):
```
intento 2: typeof output=string ok=false
  raw: [object Object]
```
Después del fix:
```
intento 2: typeof output=string ok=false
  raw: content modified
intento 3: typeof output=string ok=true
  raw: formas.rs:5:12
```
`content modified` (código real `-32801`) es una señal **estándar y legítima** del protocolo LSP — no un fallo, sino "el servidor todavía está procesando, reintentá" (rust-analyzer indexando un crate nuevo por primera vez). El bug real era de PRESENTACIÓN del error, no del mecanismo de reintento en sí.

**Alcance del bug, real**: existía desde Fase 20 (afecta `initialize`/`shutdown` también, en teoría) — nunca se manifestó porque esos 2 casi nunca reciben un error de protocolo real en la práctica. `find_definition`/`find_references`/`documentSymbol`/`workspaceSymbol` sí, con más frecuencia (dependen de que el servidor haya terminado de cargar el proyecto real).

**Fix aplicado**: `handleChunk()` normaliza `msg.error` a una instancia real de `Error` con el `.message` real extraído (o `JSON.stringify(msg.error)` como fallback si no hay `.message`) — beneficia a TODOS los métodos que pasan por `request()`, no solo los nuevos de esta sesión.

## 4. Workspace de demo — relaciones específicas por lenguaje

| Lenguaje | Relación real construida |
|---|---|
| TypeScript | `interface Producto` (`ts/types.ts`) usada en `ts/carrito.ts` Y `ts/factura.ts` — 2 archivos reales |
| Python | `calcular_impuesto` (`py/utils.py`) llamada desde `py/main.py` — archivo distinto |
| Rust | `trait Forma` + `struct Circulo` (`formas.rs`) usados en `rust_main.rs` |
| Go | `func Sumar` (`calc/calc.go`, **package calc**) llamada desde `main.go` (**package main**) — módulo real multi-paquete, `go.mod` real (`module demo`) |

**Hallazgo real no anticipado, corregido en el guion (no en producción)**: `typescript-language-server` sin `tsconfig.json` (proyecto inferido) **solo conoce archivos que ya recibieron un `didOpen`** — no escanea el directorio completo buscando quién importa el archivo abierto. `find_references` sobre `Producto` sin abrir `carrito.ts`/`factura.ts` primero solo encontraba la declaración misma (confirmado real, harness de depuración `debug_ts_refs_entry.ts`). Fix del guion: `list_symbols` sobre ambos archivos ANTES del `find_references` — documentado explícito en el log, no oculto.

## 5. CASO A — Aislamiento de diagnósticos, reproducido en cámara

Escenario EXACTO que encontró el bug original (ya corregido, commit `d32b067`):

```
list_symbols({path:"ts/error_demo.ts"})  -- ensureOpen(), NUNCA write_file
  -> "Constant cociente — ts\error_demo.ts:5:7\nFunction dividir — ts\error_demo.ts:1:1"

get_diagnostics() SIN path
  -> "Ningun archivo de un lenguaje soportado ... fue tocado con write_file/apply_patch
      en esta sesion todavia — sin diagnosticos disponibles."
  CONFIRMADO: el archivo solo navegado NO aparece -- aislamiento correcto.

get_diagnostics({path:"ts/error_demo.ts"}) CON path explicito
  -> "ts\error_demo.ts:\n  error [5:38] TS2345: Argument of type 'string' is not
      assignable to parameter of type 'number'."
```

## 6. CASO B-E — Los 4 lenguajes, prueba específica

**B. TypeScript** — `find_references` sobre `Producto`:
```
"ts\types.ts:1:18\nts\carrito.ts:1:10\nts\carrito.ts:3:42\nts\factura.ts:1:10\nts\factura.ts:3:42"
```
5 ubicaciones reales en 3 archivos: declaración + import + uso en `carrito.ts` + import + uso en `factura.ts`.

**C. Python** — `find_definition`/`find_references` sobre `calcular_impuesto`, cruzando `main.py`↔`utils.py`, **capability de pyright confirmada EN VIVO** (no solo citada de la investigación previa):
```
Capability REAL de pyright para "definitionProvider": {"workDoneProgress":true}
typeof rawDefCap = "object" -- NO es booleano, es un OBJETO real.
supportsCapability('definitionProvider') = true -- tratado como SOPORTADO
```
Leído directamente del `serverCapabilities` real del cliente que acababa de responder el `find_definition` de arriba — no una afirmación teórica.

**D. Rust** — `find_definition` sobre `Circulo`, tras superar el error real `-32801` (sección 3):
```
"formas.rs:5:12"
```
Columna exacta del struct real (`pub struct Circulo` — "pub struct " = 11 caracteres, columna 12 exacta).

**E. Go** — `find_references` sobre `Sumar`, cruzando de **paquete real** (no solo archivo):
```
"calc\calc.go:3:6\nmain.go:10:16"
```
`calc.go` es `package calc`; `main.go` es `package main` — confirmado el cruce de paquetes pedido, no solo de archivos dentro del mismo paquete.

## 7. CASO F — Ahorro de tokens, con calentamiento documentado

Mismo ejemplo real ya medido (`languageServerConfigFor`, `tool-registry.ts`→`lsp-client.ts`), esta vez con el calentamiento explícito ANTES de la medición final:

```
CALENTAMIENTO (DESCARTADO a proposito): "src\main\tool-registry.ts:11:10"
  (import local -- project references reales todavia cargando)

MEDICION REAL (estable): "src\main\lsp-client.ts:318:17"
  output real: 29 caracteres (~7 tokens aprox)
  lsp-client.ts completo: 45517 caracteres reales (~11379 tokens aprox)
  razon real: 1569.6x
```

El número exacto de esta corrida (1569.6x) difiere levemente del medido en `verify_lsp_demo_scope.md` (1392x) — real y esperado, `lsp-client.ts` creció desde entonces (nuevas líneas de esta misma fase: trazabilidad + fix de error). El ORDEN DE MAGNITUD (~1000-1600x) es el dato estable, no el número exacto.

## 8. Estándares de comprobación adicionales aplicados (Tarea 6)

Dado que no se produjo un video (sección 9), los estándares de integridad se aplicaron al artefacto real que sí existe — el log paralelo:

- **Checksum SHA-256 real** del log: `230cf5964736c09efc0772f1101869403abac23a8bb7086986823669398bfbad` — permite verificar después que el archivo no fue editado a mano tras la corrida.
- **Tamaño real**: 8227 bytes, 113 líneas.
- **Verificación automatizada de monotonicidad**: los 103 timestamps `T+Ns` del log se extrajeron y verificaron programáticamente como no-decrecientes — `OK: 100% monotono, ninguna violacion en 103 timestamps`. Esto confirma que el log es la traza secuencial real de UNA sola ejecución continua (no ensamblado a mano combinando corridas distintas).
- **Confirmación de cero procesos colgados**: `tasklist` tras el cierre, sin `rust-analyzer.exe`/`gopls.exe`/`typescript-language-server`/`pyright` remanentes.

## 9. Video — bloqueo real de infraestructura, no resuelto

**Se intentó de verdad, con evidencia real de cada paso — no se abandonó sin probar.**

1. `ffmpeg`+`gdigrab` confirmado real y disponible (investigación previa, `verify_lsp_demo_scope.md`).
2. Amatista lanzada en modo dev real (`npm run dev`), ventana real confirmada en pantalla — captura real tomada, título `AMATISTA 0.8.2` visible (versión correcta, confirmando el bump de la fase anterior).
3. Intento de posicionar una segunda ventana (terminal, para correr el harness visible) vía `Start-Process`/`conhost.exe` + Win32 API (`SetWindowPos`/`MoveWindow`/`ShowWindow`) — las ventanas se crearon de verdad (confirmado con `EnumWindows`/`GetWindowRect`/`IsWindowVisible` reales, coordenadas válidas, no minimizadas) pero **nunca aparecieron en las capturas de pantalla de la herramienta de control de escritorio**.
4. Diagnóstico real: `GetForegroundWindow()` confirmó que la ventana de la propia aplicación Claude ocupa el foreground EXACTO de esa pantalla (mismas coordenadas que la pantalla completa) — `SetForegroundWindow()` sobre cualquier otra ventana es bloqueado por la prevención de robo de foco de Windows (una ventana en foreground, lanzada sin un evento de input reciente del usuario, no puede robarle el foco a otra) — un conflicto real de cómo está armada la sesión de escritorio remota/virtualizada de este entorno específico, no un error de mi enfoque ni de ffmpeg/gdigrab en sí.
5. Un intento intermedio de recomponer el layout con `Stop-Process` sobre `cmd`/`conhost` fue DEMASIADO amplio y terminó el wrapper de `npm run dev` (el proceso Electron real de Amatista sobrevivió, confirmado con `tasklist` — el impacto real fue solo perder el log del wrapper `npm`, no la app).

**No se insistió indefinidamente** una vez identificada la causa real (conflicto de foreground a nivel de sesión, no algo resoluble con más reintentos de posicionamiento) — se documentó el bloqueo con evidencia y se entregó todo lo demás.

**Sustituto real entregado**: el log paralelo completo (sección 2 y `docs/_arch/demo_lsp_4_lenguajes.log`), la trazabilidad JSON-RPC completa (consola, `AMATISTA_DEBUG_TOOLS=1`), y una captura de pantalla real confirmando Amatista 0.8.2 corriendo en modo dev (visible en la transcripción de la sesión).

## 10. Archivos

- **Código modificado**: `src/main/lsp-client.ts` (trazabilidad + fix de error de protocolo).
- **Log paralelo (deliverable)**: `docs/_arch/demo_lsp_4_lenguajes.log`.
- **Este informe**: `docs/_arch/demo_lsp_4_lenguajes_informe.md`.
- **Workspace de demo** (scratchpad, no versionado): `demo_lsp_workspace/`.
- **Video**: no generado (sección 9).

`npm run typecheck` y `npm run build`: limpios. Sin commit — pendiente de que el usuario lo pida.
