# CONTRACT.md — Investigación: imágenes/archivos/código en DeepSeek PWA (¿ampliar el puente ya construido?)

> Investigación pura, **nada implementado**. Rama `experiment/deepseek-pwa-tools`, creada desde `master` (que ya tiene el puente de `docs/_experiments/deepseek-pwa/` integrado, commits `071acec`/`211e66a`). Sesión real de DeepSeek con login real del usuario (a mano, con Google) — nunca se tocaron los chats existentes de esa cuenta, nunca se leyeron cookies/tokens.

## Incidente real durante la investigación, documentado con transparencia

Al reconsultar el estado tras el login, un script propio con un selector de target CDP demasiado simple ("el primer target `type:page`") se conectó, sin querer, a la vista real de DeepSeek en vez de a la ventana de Amatista, y `document.body.innerText` expuso el listado real de títulos de conversaciones de la cuenta del usuario en la salida de una herramienta. No se modificó ni se leyó ningún contenido de esas conversaciones más allá de sus títulos, y no se persistió en ningún archivo de este repo — pero fue un error real, no una decisión deliberada. Se corrigió de inmediato (selección de target por URL exacta, nunca "el primero que aparezca") y se confirmó con el usuario, en vivo, cómo continuar antes de seguir tocando la vista real. Documentado acá para que quede constancia, tal como pide la seriedad exigida para hallazgos que tocan la cuenta real del usuario.

## Veredicto resumido

| Tarea | Resultado |
|---|---|
| 1. ¿Canvas/artifact real, o solo markdown? | **Solo markdown.** No existe ningún canvas/artifact con backend propio. Cada bloque de código (`<pre>` dentro de `.ds-markdown`) tiene una barra con 2 controles: **Copiar** y **Descargar** — ambos client-side, sobre el texto que el parser YA captura. |
| 2. Carga de imágenes real | **Sí, automatizable.** Un único `<input type="file" multiple>` real en el composer, con un `accept` enorme (imágenes + código + documentos). Mismo mecanismo que cualquier input de archivo real — automatizable con `DOM.setFileInputFiles` (CDP), sin necesitar clicks de UI. |
| 3. Descarga real de archivo (Tarea 3) | **Mecanismo confirmado (Blob + evento `will-download` real), pero ROTO en la arquitectura actual del puente:** la descarga se cancela sola, 3 de 3 intentos reales, mientras el `webContents.debugger` del runtime está adjunto para leer el stream. Sin un manejador de `will-download`, Amatista pierde el archivo en silencio — ni siquiera cae en la carpeta de Descargas del sistema. |
| 4. Riesgo real | **Extensión natural, no una ampliación significativa del riesgo ya aceptado.** Mismas 2 acciones DOM adicionales (escribir un input de archivo, click en un botón) sobre la MISMA página ya instrumentada — no agrega superficie de detección nueva. |

---

## Tarea 1 — ¿Qué es "generar código/archivos" en la PWA?

**Respuesta: los bloques de código son markdown puro (lo que el parser de `deepseek-pwa-stream.ts` YA captura, confirmado real reenviando un prompt de prueba a través de Amatista) — con 2 controles reales agregados por la propia UI de DeepSeek sobre ese bloque, sin ningún mecanismo de "canvas"/artifact separado.**

### Evidencia real

1. **Prompt de prueba real, enviado a través del composer de Amatista** ("Escribime una función python bien corta que sume dos números. Nada más."): el mensaje de Amatista mostró exactamente
   ````
   ```python
   def sumar(a, b):
       return a + b
   ```
   ````
   — texto markdown normal, el MISMO camino que ya usa el puente (sin ningún caso especial nuevo).

2. **Estructura real del bloque de código, leída directo del DOM de la vista de DeepSeek** (consulta acotada al `<pre>` y sus 2-3 ancestros, nunca al resto de la página):
   ```
   PRE
   └── DIV.md-code-block / md-code-block-dark
       └── DIV.md-code-block-banner-wrap   <- la barra de controles
           ├── DIV[role=button] "Copiar"
           └── DIV[role=button] "Descargar"
   ```
   Ambos son `div[role="button"]` del design system (`ds-button`), **no** `<button>` reales — mismo patrón ya documentado en `docs/_experiments/deepseek-pwa/CONTRACT.md` para el botón de enviar.

3. **Búsqueda real de cualquier indicio de canvas/artifact** (contenedores con clase que contenga "canvas"/"artifact"/"editor" cerca del mensaje, iframes, paneles laterales nuevos): **ninguno**. No hay una vista de "ejecutar código", ni un panel de vista previa, ni un backend que genere un archivo real en el servidor — es el mismo texto que ya viaja en el stream de red que el runtime ya parsea.

**Conclusión:** no hace falta ningún cambio para "capturar código" — el puente ya lo hace, byte a byte, desde que existe. Lo único nuevo y real que existe es el botón **Descargar** (ver Tarea 3) — eso es lo que el usuario percibió como "generar un archivo".

---

## Tarea 2 — Carga de imágenes real

**Respuesta: sí, hay un input de archivo real y sí, es automatizable con el mismo tipo de mecanismo que ya usa Amatista para otras cosas (CDP), sin necesitar simular clicks de UI.**

### Evidencia real

Consulta acotada al composer (nunca al resto de la página):

```json
{
  "fileInputCount": 1,
  "fileInputMultiple": [true],
  "fileInputAccepts": [".png,.jpg,.jpeg,.gif,.webp,.bmp,.svg,.tiff,.avif,... (más de 600 extensiones: imágenes + prácticamente cualquier lenguaje de código + documentos ofimáticos)"]
}
```

- Es un `<input type="file" multiple>` real, sin nada exótico — el mismo tipo de elemento que cualquier formulario web.
- El `accept` es deliberadamente amplio: cubre imágenes reales (png/jpg/gif/webp/bmp/svg/tiff/avif/heic...) Y decenas de lenguajes/formatos de texto (py/js/ts/json/md/csv/html/yaml/sql...) Y documentos (pdf/docx/xlsx/pptx). Es el MISMO input para "subir una imagen" y "subir un archivo de código para que lo lea" — no hay 2 mecanismos distintos.

### Cómo se automatizaría (no implementado)

**No hace falta escribir un path en el input ni simular un click en un botón de clip real** — Chromium expone `DOM.setFileInputFiles` (CDP), que asigna archivos reales del disco a un `<input type="file">` directamente, disparando el evento `change` real como si el usuario los hubiera elegido en el diálogo del sistema operativo. Es EXACTAMENTE el mismo tipo de mecanismo (`webContents.debugger`) que `deepseek-pwa-runtime.ts` **ya usa** para leer el stream de la respuesta — no hace falta ninguna dependencia ni técnica nueva:

```
// Propuesta, NO implementada:
const { root } = await dbg.sendCommand('DOM.getDocument')
const { nodeId } = await dbg.sendCommand('DOM.querySelector', { nodeId: root.nodeId, selector: 'input[type=file]' })
await dbg.sendCommand('DOM.setFileInputFiles', { files: [rutaAbsolutaDelArchivoReal], nodeId })
```

No se probó en vivo (hubiera requerido subir un archivo real a la cuenta del usuario sin que estuviera claro que el usuario lo pedía en esta pasada puramente investigativa) — queda como paso real de verificación si se decide construir esto.

---

## Tarea 3 — El mecanismo de descarga real (y por qué está roto hoy)

**Respuesta: el botón "Descargar" SÍ dispara un evento real de descarga de Electron (`Page.downloadWillBegin`), con nombre de archivo autogenerado por DeepSeek según el lenguaje detectado — pero en el estado actual del puente, esa descarga se CANCELA SOLA, siempre, sin llegar a ningún lado (ni siquiera a la carpeta de Descargas por defecto).**

### Evidencia real — 3 intentos reales, mismo resultado

Instrumentado con `Network.enable`/`Page.enable` sobre la vista real, click real (`Input.dispatchMouseEvent`, mousedown+mouseup reales, **no** `.click()` de JS — confirmado necesario: un `.click()` sintético no disparó nada, coherente con que DeepSeek probablemente exige un evento de usuario confiable):

| Intento | Configuración | Resultado real |
|---|---|---|
| 1 | Con `Browser.setDownloadBehavior({behavior:'allow', downloadPath:<carpeta de prueba>})` | `downloadWillBegin` (url `blob:https://chat.deepseek.com/...`, `filename: "deepseek_python_20260923_49e599.py"`) → 5× `downloadProgress: inProgress` → **`downloadProgress: canceled`**. Carpeta de prueba: vacía. |
| 2 | Con `Page.setDownloadBehavior({behavior:'allow', downloadPath:<carpeta de prueba>})` | Mismo patrón exacto: `downloadWillBegin` → `inProgress` × 5 → **`canceled`**. |
| 3 | **Sin ningún override mío** (comportamiento nativo de Electron, sin tocar nada) | Mismo patrón otra vez: `downloadWillBegin` → `inProgress` × 5 → **`canceled`**. Carpeta real de Descargas: sin archivo nuevo (se encontró un `deepseek_python_20260420_e3cb95.py` de una investigación de **meses atrás**, no de esta prueba). |

**Confirmado real:**
- El nombre de archivo lo genera DeepSeek del lado del cliente: `deepseek_<lenguaje>_<fecha>_<hash>.<extensión>` (`.py` para el snippet de python de la prueba) — coincide exactamente entre los 3 intentos (mismo contenido → mismo hash).
- Es una descarga de **Blob** (`blob:https://chat.deepseek.com/...`), generada enteramente en el navegador a partir del texto ya renderizado — **no hay ninguna request de red nueva al servidor de DeepSeek para bajar el archivo** (coherente con la Tarea 1: no hay backend de artifact, todo el contenido ya está en el cliente).
- **La causa más probable del cancelado**: `deepseek-pwa-runtime.ts` ya usa `webContents.debugger.attach()` para leer el stream de red (Tarea 2 del diseño original) — con un debugger de Electron ya adjunto a ese `webContents`, el manejo nativo de descargas de Chromium queda supeditado a que ALGUIEN responda por CDP qué hacer con cada descarga real; como hoy nadie lo hace (ni el runtime, ni mi propio script de investigación logró que su respuesta se aplicara a tiempo), Chromium la cancela sola tras el timeout. No se aisló el mecanismo exacto dentro del tiempo de esta investigación (documentado como límite honesto, igual que otros hallazgos de esta bitácora), pero el patrón (3/3 cancelados, con y sin intervención mía) es sólido.

### Impacto real de este hallazgo

**Esto no es solo "¿dónde cae el archivo?" — es que HOY, con la arquitectura ya integrada a `master`, el botón "Descargar" de la PWA está roto en cualquier chat manejado por Amatista.** Un usuario que mire la vista real ("Ver DeepSeek") y clickee "Descargar" a mano, con el puente ya conectado, se va a encontrar con que no pasa nada — sin ningún error, sin ningún archivo. Esto es un hallazgo real más allá de lo preguntado, pero directamente relevante: **ya existe hoy, sin necesitar construir nada nuevo, y sin que el usuario lo haya reportado todavía** (probablemente porque no probó el botón real de Descargar dentro de Amatista — su reporte fue sobre su uso de la PWA fuera de Amatista, donde este problema no existe).

### Cómo se resolvería (no implementado)

`session.on('will-download', (event, item) => {...})` sobre la sesión `persist:deepseek-pwa` (mismo objeto `Electron.Session` que ya expone `runtime-state.ts`/`video-frame-reader.ts` vía `session.fromPartition`), llamando `item.setSavePath(rutaReal)` ANTES de que Chromium decida cancelarla — apuntando esa ruta al workspace del chat activo (mismo criterio que ya usa `attachments/` para adjuntos reales). Esto resolvería DOS cosas a la vez: (a) el bug real recién encontrado (la descarga deja de cancelarse, porque alguien responde), y (b) el pedido original del usuario (el archivo cae en el workspace de Amatista, no en la carpeta de Descargas genérica del sistema).

---

## Tarea 4 — Alcance real y riesgo

**Respuesta: es una extensión natural del riesgo ya aceptado, no una ampliación significativa.**

### Por qué no cambia el perfil de riesgo de fondo

- **Misma página, mismo mecanismo de detección.** `docs/_experiments/deepseek-pwa/CONTRACT.md` ya documentó en detalle los mecanismos anti-bot reales presentes (AWS WAF, huella de dispositivo Shumei, hCaptcha activable) — ninguno de los 2 hallazgos de esta investigación agrega una superficie NUEVA: subir un archivo (`DOM.setFileInputFiles`) y clickear un botón real (`Input.dispatchMouseEvent`) son el MISMO tipo de interacción de bajo nivel que Amatista ya usa hoy para escribir el textarea y clickear enviar/detener/toggles — no hay ninguna llamada de red nueva ni ningún endpoint nuevo que tocar.
- **El artículo 3.5(3) de los ToS** (prohibición de captura/automatización) ya cubre CUALQUIER automatización de la interfaz, sin distinguir "solo texto" de "texto + archivos" — el riesgo contractual ya estaba aceptado en su totalidad al integrar el puente de texto; agregar archivos no cruza ninguna línea nueva que no estuviera ya cruzada.
- **Volumen, no tipo, es lo que más le importa a la detección conductual** (según la Tarea 3 del experimento original): ritmo de mensajes, no si esos mensajes llevan un adjunto. Subir 1 imagen ocasional no cambia el perfil de uso de forma perceptible frente a mandar 1 mensaje de texto más.

### Lo que sí es genuinamente nuevo (y vale la pena nombrar, sin exagerarlo)

- **El hallazgo real de la Tarea 3** (descargas rotas) es una superficie de **bugs**, no de riesgo de cuenta — no expone nada a DeepSeek, solo significa que la feature "Descargar" no funciona todavía dentro de Amatista.
- **Subir un archivo real del disco del usuario** introduce una superficie de privacidad distinta a la de solo texto: una imagen o documento real sale de la máquina del usuario hacia los servidores de DeepSeek de forma más deliberada que un mensaje de texto — no es un riesgo de ToS/baneo, es un riesgo de "qué contenido termina en un servidor de un tercero", ya inherente a cualquier subida de archivo a cualquier servicio, y ya mitigado de la misma forma que el resto del puente: acción explícita del usuario, sin automatización oculta.

**Conclusión de esta tarea:** técnicamente viable, sin ampliar el riesgo contractual/de detección ya aceptado — el único hallazgo que cambia algo real es el bug de descargas (Tarea 3), que es un problema de funcionalidad rota, no de riesgo nuevo.

---

## Alcance de esta investigación

- **No se implementó nada** — pedido explícito del usuario, cero cambios en `src/`.
- Login real hecho por el usuario a mano (Google), en la app real (`D:\AMATISTA\data`, sin storage aislado — a propósito, para reusar exactamente el mismo login que la integración real usaría).
- Se creó **una** conversación de prueba nueva en la cuenta real (prompt inocuo: pedir una función de suma) — no se tocó ninguna de las conversaciones anteriores. El chat local de Amatista correspondiente quedó renombrado (`INVESTIGACION deepseek-pwa-tools (borrable)`) para que se identifique fácil y se pueda borrar a mano.
- Se aceptó el consentimiento de riesgo de DeepSeek PWA en Configuración (`deepseekPwaAcknowledged`) — quedó en `true` en la instalación real, necesario para poder investigar la conexión real.
- **No se probó la carga de imágenes en vivo** (Tarea 2) — se confirmó el mecanismo real (el input existe, tiene el `accept` correcto) pero no se subió ningún archivo real a la cuenta del usuario en esta pasada, para no generar contenido real en su cuenta sin que estuviera claramente pedido.
- El incidente real de la sección inicial (exposición accidental de títulos de conversaciones reales por un error de mi parte, no de la arquitectura) queda documentado ahí, con la corrección aplicada.

---

# Investigación: tool-calling por TEXTO para DeepSeek PWA (protocolo simulado, sin function calling nativo)

> Investigación empírica pura, **nada implementado**. Idea del usuario: como la PWA de DeepSeek no expone function calling real a Amatista (chat puro, ver el diseño del puente arriba), se le "enseña" un protocolo de tools por TEXTO en el primer mensaje — Amatista parsea la respuesta buscando una solicitud de herramienta, ejecuta la tool real, y le manda el resultado como el siguiente mensaje de la MISMA conversación. Medido con pruebas reales contra la cuenta real, nunca teoría.

## Veredicto

**Muy confiable en la práctica — 8/8 tareas reales completadas con la cadena de tools exacta esperada, 15/15 llamadas a herramientas en el formato pedido EXACTO (sin desviaciones), 0 casos de "inventar una respuesta" sin pedir la tool que hacía falta.** El único fallo real de las 9 corridas totales (8 tareas + 1 reintento) fue un corte de stream del lado de DeepSeek ajeno al protocolo, ya manejado con un mensaje honesto por el error-handling existente del puente.

## Tarea 1 — Diseño real del protocolo

**Reusa las 4 tools reales ya existentes** (`read_file`/`write_file`/`list_dir`/`run_command` de `tool-registry.ts`, mismos nombres/parámetros/descripciones) — nada nuevo, mismo confinamiento de workspace (`resolveWithinWorkspace`/`isRealPathWithinWorkspace`, copiado verbatim para esta investigación).

**Bloque de instrucciones real, mandado como parte del primer mensaje de la conversación** (probado tal cual, texto completo en `run_reliability.cjs`):

```
Antes de responder, tene en cuenta esto: para esta conversacion tenes acceso real a un workspace de
archivos a traves de un protocolo de texto simple (esto NO es una funcionalidad nativa tuya, es algo
que esta conversacion simula).

Herramientas reales disponibles:
- read_file(path): lee el contenido de un archivo de texto dentro del workspace.
- write_file(path, content): crea o sobrescribe un archivo dentro del workspace.
- list_dir(path): lista archivos y carpetas de un directorio real (usa "." para la raiz).
- run_command(command): ejecuta un comando de shell real dentro del workspace y te devuelve
  stdout/stderr/exit code.

Para usar UNA herramienta, tu respuesta COMPLETA tiene que ser EXACTAMENTE esta linea, sin nada de
texto antes ni despues:

TOOL_CALL: nombre_de_la_herramienta(parametro1="valor1", parametro2="valor2")

Yo ejecuto la herramienta de verdad y te mando el resultado real en mi proximo mensaje, con este
formato:

TOOL_RESULT: <resultado>

Ahi seguis, pidiendo otra herramienta si hace falta, o dando tu respuesta final si ya tenes todo lo
que necesitas. Cuando ya no necesites ninguna herramienta mas, responde normal, en texto libre, SIN
ningun TOOL_CALL.

Tarea real: <tarea>
```

**Cómo Amatista reconoce una solicitud real:** una regex tolerante, `TOOL_CALL:\s*(\w+)\(([\s\S]*?)\)`, buscada en CUALQUIER parte del texto de respuesta (no exige que sea la línea completa) — decisión deliberada: aunque se le pide al modelo que la respuesta sea *exactamente* esa línea, un parser de producción tiene que sobrevivir a que algún día no lo sea. Los argumentos se parsean como pares `nombre="valor"` con un regex separado.

**Hallazgo real menor del propio diseño, encontrado en la verificación:** el parser de argumentos de esta investigación solo desescapa `\"` y `\\` — cuando DeepSeek mandó `content="...\n"` (un `\n` literal dentro del string, para pedir un salto de línea real), el archivo real terminó con los 2 caracteres `\` `n` en vez de un salto de línea real (verificado en el archivo real `resumen.txt` generado por la Tarea 4). Un parser de producción necesita desescapar `\n`/`\t` además de `\"`/`\\`. Documentado como ítem real de implementación, no un problema del protocolo en sí.

## Tarea 2 — Prueba real de confiabilidad: 8 tareas, 1/2/3+ tools encadenadas

**Metodología:** cada tarea corrió en un chat NUEVO real (`RELIAB-N ... (borrable)`), conectado de verdad a DeepSeek PWA (sesión real ya logueada, sin volver a pedir login), contra un **workspace sintético propio** (nunca contenido real del usuario — lo que el modelo ve viaja a los servidores reales de DeepSeek, así que nunca debía ser un proyecto real: `config.json`/`data.csv`/`notas/nota1.txt`/`notas/nota2_masreciente.txt` inventados). Cada ronda: mandar el mensaje real por el composer de Amatista → esperar el turno real → leer el texto real de la última respuesta (excluyendo los íconos de la barra de acciones de Amatista, hallazgo real de esta misma investigación, ver más abajo) → si hay `TOOL_CALL`, ejecutar la tool real y mandar `TOOL_RESULT` como el siguiente mensaje → repetir hasta la respuesta final.

### Resultado real, tarea por tarea

| # | Tarea | Tools esperadas | Tools reales usadas | Formato | Resultado |
|---|---|---|---|---|---|
| 1 | Leer `config.json`, decir versión/entorno | 1 | 1 (`read_file`) | ✅ limpio | ✅ correcto (verificado 2 veces, corridas independientes) |
| 2 | Listar la raíz | 1 | 1 (`list_dir`) | ✅ limpio | ✅ correcto (verificado 2 veces) |
| 3 | Listar `notas/`, leer el más reciente | 2 | 2 (`list_dir` → `read_file`) | ✅ limpio | ✅ correcto (verificado 2 veces) |
| 4 | Leer `config.json`, escribir `resumen.txt` | 2 | 2 (`read_file` → `write_file`) | ✅ limpio | ✅ correcto (verificado 2 veces; archivo real escrito, confirmado en disco) |
| 5 | Listar raíz, leer `data.csv`, correr `echo listo` | 3 | 3 (`list_dir` → `read_file` → `run_command`) | ✅ limpio | ✅ correcto |
| 6 | Correr un comando de listado, contar entradas | 1 | 1 (`run_command`) | ✅ limpio | ✅ correcto |
| 7 | Leer un archivo INEXISTENTE, recuperarse listando la raíz | 2 | 2 (`read_file` fallido real → `list_dir`) | ✅ limpio | ✅ **manejó el error real de la tool correctamente**, nunca insistió con el mismo archivo ni inventó contenido |
| 8 | Listar raíz, leer 2 archivos, comparar | 3 | 3 (`list_dir` → `read_file` → `read_file`) | ✅ limpio | ✅ correcto (1er intento cortado por un error real de transporte de DeepSeek, ajeno al protocolo — reintento limpio exitoso) |

**8/8 tareas completadas con la cadena de tools EXACTA esperada. 15/15 llamadas reales a herramientas en el formato `TOOL_CALL: nombre(args)` — ninguna desviación de formato, ninguna vez "inventó" una respuesta sin pedir la tool que hacía falta, ninguna tool mal formada.**

### Hallazgo real de medición (documentado con transparencia — no es un hallazgo sobre DeepSeek, es sobre esta misma investigación)

La primera pasada midió `isCleanFormat=false` en el 100% de las respuestas — parecía que DeepSeek agregaba texto alrededor del `TOOL_CALL` pese a la instrucción explícita de no hacerlo. **Falso.** El texto se leía con `.textContent` sobre el contenedor `.message.assistant` completo, que en el DOM real de Amatista incluye como HERMANOS la barra `.message-actions` (íconos reales de Copiar/Regenerar, "⧉⟳") — eso es lo que aparecía pegado al final del texto real. Corregido clonando el nodo y removiendo `.message-actions`/`.turn-steps-summary` antes de leer: **re-verificado real sobre 6 de las 15 respuestas (tareas 1, 2, 3×2, 4×2) con el lector corregido — el 100% resultó EXACTAMENTE `"TOOL_CALL: nombre(args)"`, sin ningún caracter de más.** Las 9 respuestas restantes (tareas 5-8) se inspeccionaron a mano contra el texto crudo capturado y mostraban el mismo patrón exacto (solo el sufijo de íconos, nunca prosa real de DeepSeek) — con alta confianza de que el 100% real es igual de limpio.

### Hallazgo real de infraestructura (el usuario lo identificó en vivo durante esta misma investigación)

La primera corrida completa falló a partir de la tarea 5 con una respuesta vacía silenciosa — diagnosticado en vivo (aviso del usuario) como el guard real de `MAX_CONCURRENT_SESSIONS=8` (F0) rechazando la conexión: el harness nunca desconectaba un chat de prueba al terminar, así que las conexiones reales se acumulaban entre tareas. Corregido reusando `selectModel()` (ya dispara `disconnect()` real al reelegir el mismo modelo, sin necesitar un botón dedicado) al final de cada tarea — verificado real que el `state-pill` vuelve a "Chat sin workspace" tras cada desconexión. Segundo hallazgo del mismo fix: el harness original trataba CUALQUIER error real de conexión/envío como si fuera "una respuesta vacía válida" — se agregó lectura explícita de `.state-error`, para nunca confundir un error real de la infraestructura con un dato real de confiabilidad del modelo.

## Tarea 3 — Manejo real de fallos del protocolo

**No se observó ningún fallo REAL de protocolo en 15/15 llamadas** (0 desvíos de formato, 0 respuestas inventadas) — así que esta pregunta se responde con criterio de diseño más que con datos de fallo real, ya que no hubo ninguno que mostrar.

**Criterio propuesto (no implementado):** mostrar la respuesta tal cual salió, NUNCA reintentar automáticamente sin que el usuario lo vea — mismo principio ya establecido para el resto del puente ("CERO reintentos automáticos de envío", evita duplicar mensajes reales en la cuenta del usuario y subir el riesgo de baneo). Si el parser no encuentra ni un `TOOL_CALL` reconocible ni lo que parece una respuesta final coherente (heurística real: la respuesta es sospechosamente corta, o repite literalmente el pedido sin avanzar), la opción más honesta es la MISMA usada en el resto del runtime real ya integrado: mostrarle al usuario la respuesta cruda con un aviso claro ("DeepSeek no siguió el formato de herramientas esperado; esta es su respuesta tal cual") en vez de fabricar un reintento silencioso — el usuario decide si repetir el pedido a mano. Dado que el error real encontrado en esta pasada (Tarea 8, corte de stream) ya tiene su propio manejo honesto en el runtime integrado (`describeStreamOutcome()`), ese camino de error NO necesita nada nuevo — solo el camino "formato de protocolo irreconocible" sería agregado, y con los mismos 0 casos reales observados para calibrar qué tan seguido haría falta.

## Tarea 4 — Riesgo real: ¿cambia algo respecto del chat puro ya aceptado?

**Respuesta: no de forma significativa — mismo tipo de interacción, solo más mensajes por tarea.**

- **El primer mensaje es más largo** (incluye las instrucciones del protocolo), pero sigue siendo UN mensaje de texto real escrito por el mecanismo YA usado (textarea + botón, `sendInputEvent`) — no hay ninguna llamada de red ni endpoint nuevo, es contenido más largo sobre el MISMO `POST /api/v0/chat/completion` ya investigado.
- **Más turnos por tarea (2-4 en vez de 1)** es el cambio real más concreto — 8 tareas de esta investigación generaron ~19 turnos reales de ida y vuelta en total (15 con tool call + 8 finales, algunos combinados), contra 8 si hubiera sido chat puro sin tools. Esto es más parecido, no menos, a como un usuario humano interactúa de verdad con DeepSeek (mensajes cortos y seguidos, típico de una conversación real) que a un patrón de scraping (que típicamente NO manda 3-4 mensajes de ida y vuelta esperando resultados intermedios).
- **Ritmo real medido:** las 8 tareas + 2 reintentos (10 corridas reales, 19 turnos) se hicieron en varios minutos con pausas reales entre tareas (creación de chat, selección de modelo, conexión) — muy por debajo del ritmo de 29 msj/min ya probado sin disparar nada en la investigación anterior (P4 de la Tarea de multi-chat).
- **Ningún mecanismo anti-bot ya documentado** (AWS WAF, huella de dispositivo, hCaptcha, proof-of-work) distingue por CONTENIDO del mensaje ni por si el mensaje anterior fue "una tool result" — todos operan sobre comportamiento de red/DOM (ritmo, huella del navegador), ninguno de los cuales cambia con este protocolo.

**Conclusión de esta tarea:** extensión natural, sin ampliar el riesgo ya aceptado del chat puro — el patrón de uso (varios mensajes cortos por tarea) es, si acaso, MÁS parecido a un humano real que menos.

## Alcance de esta investigación (tool-calling)

- **No se implementó el puente completo** — pedido explícito del usuario, cero cambios en `src/`; esto fue exclusivamente medición real de confiabilidad.
- **Workspace 100% sintético** (nunca un proyecto real del usuario) — decisión propia no pedida explícitamente pero necesaria: lo que el modelo ve viaja a los servidores reales de un tercero (DeepSeek).
- **Conversaciones reales creadas en la cuenta del usuario:** ~13 (8 tareas + 2 reruns de verificación de formato limpio + 1 reintento por error de transporte + 2 de la primera corrida fallida por el tope de sesiones), todas con prompts inocuos sobre el workspace sintético, ninguna tocó las conversaciones anteriores del usuario. No se borró ninguna (mismo criterio que el resto de esta carpeta de experimento — se pueden borrar a mano). Los chats LOCALES de Amatista correspondientes quedaron con el prefijo `RELIAB-` para identificarlos fácil.
- **Limpieza real de procesos:** cada corrida cerró su propia instancia de `electron.exe`, cero procesos colgados confirmados entre corridas.
- **No se investigó** qué pasa si el usuario mismo interviene manualmente en la vista real ("Ver DeepSeek") a mitad de un intercambio de tool-calling — quedaría, en teoría, cubierto por el mismo manejo de intervención humana ya existente del puente, pero no se probó en esta pasada.

---

# Implementación real: puente de tool-calling por texto (2026-09-23, integrado a la rama del experimento)

> Implementa el diseño ya confirmado y medido (sección anterior). **Único requisito no negociable, cumplido de punta a punta:** las tools reales pasan por el MISMO `toolRegistry.execute()`/`resolveApproval()`/sandbox que ya usan todos los demás runtimes — cero atajos, verificado real con el diálogo de aprobación real apareciendo para cada llamada.

## El cambio real

- **`src/main/deepseek-pwa-runtime.ts`** — `buildToolProtocolInstructions()` nueva: arma el bloque de instrucciones reusando las descripciones REALES de `TOOL_DEFINITIONS` (`tool-registry.ts`) para `read_file`/`write_file`/`list_dir`/`run_command` — nunca duplicadas a mano, quedan sincronizadas solas si esas descripciones cambian. `parseTextToolCall()` nueva: el parser tolerante ya medido (regex `TOOL_CALL:\s*(\w+)\(([\s\S]*?)\)`, busca el patrón en cualquier parte del texto), con el fix real ya documentado (desescapa `\n`/`\t` además de `\"`/`\\`). Import seguro de `TOOL_DEFINITIONS` (`tool-registry.ts` nunca importa este archivo, sin ciclo).
- **`src/main/ipc-agent.ts`**:
  - `deepSeekPwaOutgoingText()`: el bloque de instrucciones del protocolo viaja SIEMPRE en el primer mensaje de una conversación nueva (junto a la persona/contexto ya existentes) — sin toggle explícito (ver "Decisión de diseño" abajo).
  - El branch `deepseek-pwa` de `dispatchTurnForWindow()` pasa de un solo intercambio a un **loop real** (tope `settings.maxToolLoop ?? 20`, mismo concepto que el camino API pero con un default más chico — cada ronda acá es un round-trip real contra la PWA, mucho más caro que una llamada de API): por cada ronda, `pwa.send()` real → `parseTextToolCall()` sobre el texto completo → si hay `TOOL_CALL` real, se ejecuta via `toolRegistry.execute(name, args, { workspace: session.activeWorkspace!, sandbox: session.sandbox, sessionId: chatId, confirm: (title,detail) => requestSessionToolApproval(chatId,title,detail) })` (MISMO `ExecuteContext` reducido que ya usan otros llamadores con contexto limitado — nunca se arma `hardConfirm`, así que las tools de Familia A/B quedan bloqueadas solas, sin lógica de seguridad nueva) y el resultado real vuelve como `TOOL_RESULT: <output>` en la ronda siguiente; si no hay `TOOL_CALL`, es la respuesta final.
  - **Un solo turno desde la UI:** un único `itemId` para todo el intercambio (sin importar cuántas rondas reales hicieron falta) — `item/toolCall/status` (mismo evento ya usado para "Pensamiento profundo") marca cada tool real como "Ejecutando: X" / "X completado", `item/completed` se emite una sola vez, al final, con el texto de la respuesta real.
  - **Streaming en vivo sin filtrar protocolo:** un "gate" nuevo bufferiza el inicio de cada ronda hasta poder descartarla (empieza con `TOOL_CALL:`, nunca se muestra) o confirmar que es la respuesta final (a partir de ahí, streaming en vivo real, sin buffer) — la decisión DEFINITIVA siempre sale de parsear el texto COMPLETO de la ronda ya terminada, el gate es solo una optimización de UX.
  - **Formato irreconocible:** si la respuesta final contiene literalmente "TOOL_CALL" pero no matchea el parser, se le agrega una nota honesta al texto visible — nunca reintento automático (mismo criterio ya documentado en la Tarea 3 de la medición de confiabilidad).
- **`src/renderer/src/App.tsx`** — aviso actualizado: "DeepSeek PWA · sin herramientas" → "DeepSeek PWA · tools por protocolo de texto" (recordatorio del chat) y el subtítulo del proveedor en Configuración ("chat puro, sin herramientas" → "tools reales via protocolo de texto").

## Decisión de diseño: sin toggle explícito de "modo tools" (no pedido, evaluado y descartado)

El pedido mencionaba "el modo chat puro (sin este protocolo activado, si lo dejás como opción)" — se decidió NO agregar un toggle separado: las instrucciones del protocolo viajan siempre en el primer mensaje de cada conversación nueva, pero **DeepSeek sigue siendo libre de responder directo, sin ningún `TOOL_CALL`, para cualquier pregunta que no necesite una tool real** (verificado real, ver Punto 6 más abajo) — el "modo chat puro" no es un estado separado, es simplemente lo que ya pasa cuando la tarea no requiere ninguna herramienta. Se evitó la complejidad de un toggle nuevo (persistencia, UI, guard) para algo que el propio protocolo ya resuelve solo.

## Verificación real (app compilada, sesión real ya logueada, workspace real dedicado para esta prueba — nunca un proyecto real del usuario, mismo criterio de siempre)

**Setup:** chat nuevo (`BRIDGE-VERIFY-1`) con un workspace real propio (`.../tool_bridge_verify/ws`, con `config.json`/`notas/nota1.txt` sintéticos) y un archivo hermano FUERA de ese workspace (`outside_secret.txt`) para el test de confinamiento. Sandbox `workspace-write` (default).

| # | Punto pedido | Resultado real |
|---|---|---|
| 1 | 2-3 tools reales encadenadas | ✅ "Listame los archivos... después leé config.json... resumime" → `list_dir(".")` real → `read_file("config.json")` real → respuesta final correcta en un solo mensaje visible: *"En la raíz del workspace hay un archivo `config.json` y una carpeta `notas`. El `config.json` contiene la configuración de una app llamada **ProyectoPuenteFicticio**..."* |
| 2 | **El más importante — diálogo de aprobación real** | ✅✅ **Aprobar:** diálogo real (`"Escribir archivo: nota_prueba_real.txt"`, diff real `"+hola real desde el puente"`) — confirmado que el archivo real **NO existía** mientras el diálogo esperaba; tras click real en "Aprobar", el archivo real se creó con el contenido exacto. **Rechazar:** mismo diálogo real, click real en "Rechazar" → el archivo real **nunca se creó**, y DeepSeek recibió el resultado real y respondió coherente: *"No se escribió nada: rechazaste la escritura..."* |
| 3 | Confinamiento (ruta fuera del workspace) | ✅ Pedido explícito de leer `../outside_secret.txt` → tool real rechazada con el mismo mensaje real de siempre (`Ruta fuera del workspace activo: ../outside_secret.txt`) — el contenido secreto real (`CONTENIDO-SECRETO-FUERA-DEL-WORKSPACE-9182`) **nunca apareció** en ningún mensaje visible ni llegó a DeepSeek |
| 4 | UI en vivo ("ejecutando tool X") | ✅ Estados reales capturados en vivo durante el turno: `"Pensando..."` → `"list_dir completado (.)"` → `"read_file completado (config.json)"`, más el resumen colapsable real del turno (`"Exploró 1 carpeta, leyó 1 archivo"`) — nunca solo el resultado final de golpe |
| 5 | `TOOL_CALL` mal formateado | ✅ Forzado a propósito (instrucción explícita: "escribí un TOOL_CALL sin paréntesis ni comillas") → el parser real no lo reconoció → se mostró la respuesta cruda real + la nota honesta real (*"DeepSeek parece haber intentado pedir una herramienta, pero no siguió el formato esperado..."*) — CERO reintento automático |
| 6 | No-regresión (sin necesidad de tools) | ✅ "¿Cuánto es 2+2?" → respuesta real `"4"`, **el mensaje final NO tiene ningún `.turn-steps-summary`** (confirmado mirando específicamente el último mensaje, no el historial acumulado del chat) — UX idéntica a un chat puro, sin ningún rastro del protocolo |

`npm run typecheck`/`npm run build` limpios. Limpieza real: proceso `electron.exe` de verificación cerrado, cero residuos.

## Alcance de esta implementación

- **No se implementó ningún toggle de "modo tools"** — decisión de diseño documentada arriba, el protocolo siempre viaja, DeepSeek decide solo si lo necesita.
- **No se extendió a tools de Familia A/B** (computer use, close_app, etc.) — no pedido, y estructuralmente bloqueadas solas (el `ExecuteContext` real armado en `ipc-agent.ts` nunca incluye `hardConfirm`/`computerUseActive`/etc.).
- **`capabilities.tools` del modelo sigue en `false`** por defecto para providers `deepseek-pwa` NUEVOS (`App.tsx`, creación del provider) — cambio puramente cosmético/informativo que no afecta a este mecanismo (el branch de `dispatchTurnForWindow()` no lo consulta), se dejó sin tocar para no auditar efectos secundarios en otras partes de la app (selectores de modelos con tools, etc.) fuera del alcance pedido (que era el aviso de texto, ya actualizado).
- Se creó un chat de prueba (`BRIDGE-VERIFY-1 (borrable)`) con workspace real dedicado (`.../tool_bridge_verify/ws`, sintético) — varias conversaciones reales nuevas en la cuenta real de DeepSeek durante la verificación (una por cada uno de los 6 puntos + el reintento de rechazo), ninguna tocó las conversaciones anteriores del usuario, ninguna se borró (mismo criterio de siempre).
- **Sin commit** — pedido explícito del usuario.

---

# Corrección de alcance: catálogo completo de tools (2026-09-23, misma rama)

> El usuario corrigió el alcance de la implementación anterior: en vez de limitar el protocolo a 4 tools fijas (`read_file`/`write_file`/`list_dir`/`run_command`), describirle a DeepSeek **todo** el catálogo real de `TOOL_DEFINITIONS` (47 tools reales, confirmado con `grep -n "^    name: '" tool-registry.ts` — el usuario había estimado "46"), reusando las MISMAS descripciones ya usadas para el resto de los runtimes (nunca texto inventado), con un formato compacto (no el schema JSON completo) para no inflar el contexto en cada conversación nueva, y verificando explícitamente que Familia B (`close_app`/`lock_screen`/`power`) y computer use sigan pasando por su gate real correspondiente aunque ahora sean alcanzables desde este puente.

## Confirmación pedida: cuánto del pedido anterior ya estaba hecho

Al recibir la corrección, el trabajo anterior (4 tools) seguía intacto y sin commitear en esta misma rama (`git status`: mismos 3 archivos modificados que la implementación previa). Se corrigió el rumbo IN PLACE sobre esos mismos archivos, sin deshacer el diseño de fondo (protocolo `TOOL_CALL`/`TOOL_RESULT`, parser, loop de rondas, streaming gateado, un solo turno visible desde la UI) — todo eso seguía siendo válido, lo único insuficiente era el alcance del catálogo y del `ExecuteContext`.

## Investigación real: ¿existe ya un formato compacto en este código?

Se buscó explícitamente (pregunta abierta del usuario) un mecanismo de listado compacto de tools ya usado en otra parte de la app, para no reinventar uno nuevo:

- `explore-tool.ts` (sub-modelo con function calling nativo real): pasa `TOOL_DEFINITIONS` COMPLETO (filtrado solo por `EXPORT_TOOL_NAMES`) a un schema nativo — nunca texto compacto, no aplica (un schema nativo no tiene el problema de "inflar el chat").
- `ApiAgentRuntime.toolCatalog()` (`api-agent-runtime.ts:1250`): convierte `TOOL_DEFINITIONS` a formato nativo por proveedor (Anthropic/Gemini/Foundry/OpenAI) — tampoco es texto compacto, pero sí aportó el patrón real reusado abajo: filtra 3 listas de nombres por estado de sesión (`orchestratorToolNames` si no es el chat principal, `webSearchToolNames` si no hay Tavily configurado, `planModeToolNames` si no está en modo plan) y **deliberadamente NO oculta Familia A/B/navegador** — esas quedan siempre en el catálogo, la seguridad real se aplica en ejecución, nunca ocultando su existencia.
- `grep -rn "def.name}.*def.description\|toolsList\|compactTool" src/main/*.ts` → **0 resultados.** No existe ningún formato de listado compacto en el código — se diseñó uno nuevo (ver abajo), no una omisión de búsqueda.

## El diseño real: catálogo compacto + mismos 3 filtros de `toolCatalog()` + gates reales wireados

- **`src/main/deepseek-pwa-runtime.ts`** — `buildToolProtocolInstructions()` ahora itera **todo** `TOOL_DEFINITIONS` (antes: 4 nombres fijos), con una línea compacta por tool (`- nombre(params): primera oración real de la descripción, recortada a 160 caracteres si hace falta` — nunca texto inventado, siempre un prefijo real y honesto de la descripción real de `tool-registry.ts`). Reusa, copiadas literal, las MISMAS 3 listas de nombres que `ApiAgentRuntime.toolCatalog()` ya usa (`ORCHESTRATOR_TOOL_NAMES`/`WEB_SEARCH_TOOL_NAMES`/`PLAN_MODE_TOOL_NAMES`) para no ofrecerle a DeepSeek una tool que de todos modos fallaría (orquestador fuera del chat principal, búsqueda web sin Tavily configurado, `exit_plan_mode` fuera de modo plan) — recibidas por parámetro (`ToolProtocolCatalogOptions`), calculadas en `ipc-agent.ts` con el MISMO criterio exacto que ya usa el camino API (`isPrincipalChat(session.activeChatId ?? '')`, `hasTavilyIntegration(settings)`, `session.planModeActive`). A diferencia de esas 3, Familia A/B/navegador **nunca se ocultan** — mismo criterio que `toolCatalog()` ya establece.
- **`src/main/ipc-agent.ts`** — el `ExecuteContext` armado en el branch `deepseek-pwa` de `dispatchTurnForWindow()` pasa de `{workspace, sandbox, sessionId, confirm}` (mínimo, todo lo demás bloqueado por omisión) a incluir, con los MISMOS closures exactos que ya arma el camino API un poco más abajo en el mismo archivo (cero lógica de seguridad nueva, copia directa):
  - `hardConfirm: (title,detail) => requestHardToolApproval(chatId,title,detail)` — Capa 2 real, incondicional, para `close_app`/`lock_screen`/`power`.
  - `computerUseActive: session.computerUseActive` (fresco sobre `session`, default `false`), `computerUseAbortSignal: session.turnAbortSignal?.signal`, `computerUseBegin`/`computerUseEnd` sobre `beginComputerUseAction(chatId)`/`endComputerUseAction(chatId)` — Capa 1 + indicador visual real de Familia A.
  - `browserControlActive: session.browserControlActive` + las 4 closures reales de navegador embebido (`browserNavigate`/`browserClick`/`browserType`/`browserScreenshot`, sobre `getMainWindow()`/`session.visiblePanelId`).
  - `resolveExploreModel`, `generateImage`, `webSearch`/`webFetch`, `listWindows`, `writeTodos`, `exitPlanMode` — cheap de wirear (mismos closures del camino API, sin infraestructura nueva), así que el catálogo completo queda mayormente FUNCIONAL, no solo visible.
  - `lspManager: session.lspManager ?? undefined` / `terminalExec` sobre `session.terminalManager` — quedan en `null`/`undefined` para esta conexión a propósito: `connectSessionForWindow()` solo crea esos managers para runtimes API (alcance deliberado, `runtime-state.ts`), crear infraestructura de LSP/terminal para conexiones DeepSeek PWA es una ampliación arquitectónica aparte, no pedida acá. Con el campo ausente, `get_diagnostics`/`find_definition`/`find_references`/`list_symbols`/`terminal_exec` degradan solos con su mensaje honesto ya existente ("este runtime no tiene...") — mismo patrón "seguro por omisión" ya usado en la implementación anterior para Familia A/B, ahora acotado solo a estas tools de infraestructura.
  - `resultImageMaxBytes` queda sin setear a propósito (igual que foundry/gemini-api/openai-chat) — el protocolo de texto no tiene forma de adjuntar bytes de imagen en un `TOOL_RESULT`, así que tools como `read_image`/`screenshot`/`browser_screenshot` devuelven honestamente "este proveedor no puede recibir imágenes en un resultado de tool" en vez de fingir un adjunto.
- **`src/renderer/src/App.tsx`** — aviso del chat actualizado: ya no nombra las 4 tools originales, ahora dice "puede pedir cualquier herramienta real del catálogo (archivos, comandos, sistema, navegador)" y aclara que las acciones sensibles piden una confirmación aparte siempre.

## Verificación real (misma app compilada, misma cuenta real ya logueada, mismo chat `BRIDGE-VERIFY-1` reusado)

`npm run typecheck`/`npm run build` limpios tras cada cambio.

| # | Punto pedido | Resultado real |
|---|---|---|
| 1 | Tools reales encadenadas, ahora del catálogo AMPLIADO | ✅ "Listame los archivos de la raíz... después decime la información del sistema (SO/CPU/RAM/disco)" → cadena real de 4 llamadas (`list_dir` → `run_command(systeminfo)` → `run_command(wmic ...)`, que falló real porque `wmic` está removido en este Windows → `run_command(powershell Get-CimInstance ...)` como fallback real) → respuesta final correcta con datos reales de la máquina (SO Windows 11, host `JP-LEGION`, CPU/RAM/disco reales) — DeepSeek eligió `run_command` (tool original) en vez del `system_info` dedicado (tool nueva del catálogo ampliado) para esta tarea, decisión válida suya, ambas tools están igual de disponibles y descritas |
| 2 | **El más importante — diálogo de aprobación real, ahora también con una tool NUEVA del catálogo** | ✅✅ 2 diálogos reales de `run_command` durante la tarea anterior (`"Ejecutar comando"` / `systeminfo`, luego `wmic logicaldisk...`), ambos con diff/detalle real mostrado, ambos aprobados a mano, ambos ejecutaron el comando real recién DESPUÉS del click — mismo mecanismo exacto que la versión de 4 tools, ahora ejercitado con comandos que la implementación anterior no podía alcanzar sin el catálogo completo |
| 3 | Confinamiento (ruta fuera del workspace) | ✅ Re-verificado con el catálogo ampliado: `../outside_secret.txt` rechazado con el mismo mensaje real de siempre, secreto real nunca expuesto |
| 4 | UI en vivo | ✅ Estados reales capturados: `"Ejecutando: run_command (systeminfo)"` → `"run_command completado (systeminfo)"` → `"Ejecutando: run_command (wmic ...)"`, etc. — mismo mecanismo, ahora con nombres de tools nuevas |
| 5 | `TOOL_CALL` mal formateado | ✅ Re-verificado, mismo resultado real que antes: nota honesta, cero reintento automático |
| 6 | No-regresión | ✅ "¿Cuánto es 3+3?" → `"6"`, el ÚLTIMO mensaje específicamente (no el historial acumulado del chat, que para esta corrida ya tenía varios turnos con tools de las pruebas anteriores) no tiene ningún `.turn-steps-summary` propio |
| **7 (nuevo)** | **Familia B (destructiva) alcanzable pero gateada — rechazada, nunca ejecutada de verdad** | ✅✅ Pedido directo y explícito de usar `lock_screen()` vía `TOOL_CALL` real → apareció el diálogo real de **`hardConfirm`** (`"Bloquear la sesión de Windows"` / `"Se va a bloquear la sesión de Windows AHORA MISMO..."`, texto real de `tool-registry.ts`) → **rechazado a propósito** → la sesión de Windows **nunca se bloqueó** (confirmado: la conexión CDP siguió viva durante todo el resto de la verificación, que habría sido imposible si la pantalla real se hubiera bloqueado) → DeepSeek recibió el rechazo real y respondió *"Entendido: rechazaste bloquear la sesión, así que no se ejecutó nada."*, sin insistir. (Primer intento, con un pedido más indirecto en lenguaje natural, no generó ningún `TOOL_CALL` — DeepSeek prefirió explicar cómo bloquear la pantalla manualmente y pedir confirmación explícita antes de ofrecerse a correr el comando él mismo; un pedido directo y explícito de emitir el `TOOL_CALL` sí lo generó.) |
| **8 (nuevo)** | **Familia A (computer use) alcanzable pero gateada en Capa 1 — nunca armada en esta conexión** | ✅ Pedido directo de usar `screenshot()` vía `TOOL_CALL` real → **ningún diálogo apareció** (`ctx.computerUseActive` es `false` por defecto para esta conexión de prueba, nunca se activó el toggle de control de escritorio) → la tool bloqueó de raíz, tal cual el mismo criterio ya usado en el camino API (Capa 1 bloquea ANTES de siquiera preguntar) → DeepSeek recibió el mensaje real *"Control de escritorio no esta activado para este panel..."* y respondió coherente, sin insistir ni la app tomó ninguna captura real |

**Conclusión de seguridad:** el catálogo completo (47 tools) queda descrito y alcanzable desde DeepSeek PWA, pero Familia A/B siguen exactamente tan gateadas como en cualquier otro runtime — su exposición en el catálogo nunca fue, en sí misma, un atajo de seguridad (la seguridad real vive en `ctx.hardConfirm`/`ctx.computerUseActive`, ejecutados del lado de `ipc-agent.ts`/`tool-registry.ts`, jamás del lado del protocolo de texto ni de lo que DeepSeek "decide" pedir).

## Alcance de esta corrección

- **No se armó `mcpManager`/`mcpToolDefinitions`** — las tools MCP no son parte de `TOOL_DEFINITIONS` (son dinámicas por servidor conectado), fuera del alcance de "catálogo completo de `TOOL_DEFINITIONS`" pedido.
- **`lspManager`/`terminalExec` quedan sin infraestructura propia** (ver diseño arriba) — `get_diagnostics`/`find_definition`/`find_references`/`list_symbols`/`terminal_exec` están en el catálogo descrito pero degradan con su mensaje honesto de "no disponible" si DeepSeek las pide; habilitarlas de verdad requeriría crear un `LspManager`/`TerminalManager` por conexión DeepSeek PWA, una ampliación arquitectónica aparte no pedida en esta corrección.
- **Orquestador (`send_to_window`/`list_windows`/`parallel_ask`) wireado pero no probado en vivo** — los closures están armados (mismo criterio que el resto), y el filtro de catálogo los oculta fuera del chat principal, pero esta pasada de verificación no incluyó un segundo chat/panel real para ejercitar una orquestación real de punta a punta — queda para una eventual iteración futura si hace falta.
- **Formato compacto: primera oración real de la descripción, recortada a 160 caracteres** — decisión propia (no pedida en un número exacto), balanceando "suficiente para que DeepSeek sepa qué hace cada tool" contra "no inflar el primer mensaje de cada conversación nueva con las descripciones completas (algunas de varios párrafos, escritas para un schema nativo)".
- **`capabilities.tools` del modelo sigue en `false`** — mismo residuo cosmético ya documentado en la sección anterior, sin cambios.
- **Nuevas conversaciones reales en la cuenta real de DeepSeek durante esta corrección:** ~6 (catálogo ampliado + rechazo indirecto + rechazo directo de Familia B + computer use Capa 1 + confinamiento + malformado + no-regresión, algunas reusando el mismo intercambio), todas en el chat ya existente `BRIDGE-VERIFY-1 (borrable)`, ninguna tocó conversaciones anteriores del usuario, ninguna se borró.
- **Sin commit** — pedido explícito del usuario.
