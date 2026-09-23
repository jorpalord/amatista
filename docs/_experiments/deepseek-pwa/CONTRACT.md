# CONTRACT.md — Experimento: automatización de la PWA de DeepSeek con sesión real

> **Riesgo real de violar ToS de DeepSeek (art. 3.5(3)), decisión consciente del usuario. Nació como experimento aislado; integrado a la app principal el 2026-09-23 tras la validación completa, detrás del consentimiento doble `deepseekPwaAcknowledged`.**
>
> **Estado actual (2026-09-23): INTEGRADO a `master`** (fast-forward desde la rama `experiment/deepseek-pwa`, commit de integración). El código vive en `src/`, detrás del consentimiento doble `deepseekPwaAcknowledged` (UI + main). Ver "Implementación del puente" al final. La documentación del experimento sigue acá, separada de `docs/_arch/`. `tool-registry.ts` sin cambios: es un runtime de chat puro, no una tool.

## Veredicto de viabilidad (2026-09-23)

| Tarea | Resultado |
|---|---|
| 1. Sesión persistente | **Viable, confirmado con login real.** El login se hace una vez y sobrevive reinicios (`userToken` en `localStorage` de `persist:deepseek-exp`). |
| 2. DOM | **Mapeable, confirmado con streaming largo.** Selectores reales; señal de fin real (ícono del botón: detener → enviar); `MutationObserver` `childList` avisa cada fragmento (append-only); el bloque de razonamiento es un hijo aparte del mensaje y se excluye leyendo solo `.ds-assistant-message-main-content`. |
| 3. Detección | **Riesgo real, conductual.** AWS WAF + huella de dispositivo + hCaptcha activable presentes en la página; baneos documentados solo contra clientes HTTP crudos. Con un mensaje no se disparó nada. |
| 4. ToS | **Prohibido explícitamente** (§3.5(3), sanciones en §8.2: suspensión o cierre de cuenta). |

**Técnicamente viable; contractualmente prohibido; riesgo práctico de cuenta proporcional al volumen y al ritmo de uso.** La decisión de seguir es del usuario.

## Idea técnica bajo investigación

Una `WebContentsView` (mismo mecanismo ya usado por el navegador embebido de Amatista — DOM/selectores como mecanismo primario) cargando la PWA real de DeepSeek (`chat.deepseek.com`) con una **sesión persistente** propia: el usuario inicia sesión a mano una sola vez con su cuenta real, y esa sesión sobrevive a reinicios de la app.

## Tarea 1 — Sesión persistente real

**Respuesta: SÍ, viable — con una salvedad real que condiciona todo lo demás (cookies de sesión).**

`session.fromPartition('persist:<nombre>')` da una sesión en disco **propia de esa vista** (`<userData>/Partitions/<nombre>`), separada del resto de la app. Se asigna a una `WebContentsView` concreta vía `webPreferences.partition`, sin afectar a ninguna otra vista.

### Verificación real (harness `t1_persist/persist_test.cjs`, Electron 43.2.0 del repo, `userData` en carpeta temporal, 2 procesos separados = reinicio real)

Se escribió lo mismo en 3 particiones (servidor HTTP local, puerto fijo — `localStorage` es por origen), se cerró la app, y un proceso **nuevo** leyó:

| Qué | `persist:deepseek-exp` | partición en memoria (`deepseek-mem`) | sesión default |
|---|---|---|---|
| Cookie persistente (`Max-Age=86400`) | **sobrevive** | se pierde | sobrevive |
| Cookie de sesión (sin `Expires`/`Max-Age`) | **se pierde** | se pierde | se pierde |
| `localStorage` | **sobrevive** | se pierde | sobrevive |
| IndexedDB | **sobrevive** | se pierde | sobrevive |
| `session.isPersistent()` | `true` | `false` | `true` |

**Aislamiento confirmado:** la sesión default nunca ve las cookies de `persist:deepseek-exp` (`defaultSeesPersistExpCookie: false`).

**Salvedad crítica:** las cookies de sesión **no** sobreviven al reinicio ni siquiera en una partición `persist:` (comportamiento estándar de Chromium, no un bug de Electron). Si DeepSeek guardara el login solo en una cookie de sesión, el usuario tendría que volver a loguearse en cada arranque.

### Verificación con el login REAL de DeepSeek (2026-09-23) — salvedad resuelta

El usuario inició sesión a mano (con Google) en una `WebContentsView` con `persist:deepseek-exp`, harness `t2_dom/deepseek_window.cjs`. Después:

1. La ventana se cerró de forma limpia (CDP `Browser.close`, exit 0, cero procesos `electron.exe` restantes).
2. Se relanzó con el mismo `userData`.

Resultado tras el reinicio real:

- **Sin redirección a `/sign_in`.** La app queda en `/` con el `textarea` de chat disponible.
- **`userToken` presente** en `localStorage`.
- **El sidebar carga el historial real desde el servidor:** 39 chats, incluido el chat de prueba creado *antes* del reinicio. Es autenticación real, no una UI en caché.

**Dónde vive el login de DeepSeek** (solo se leyeron nombres de claves y cookies, nunca valores):

- **`userToken`** en `localStorage`: sobrevive, y es lo que mantiene la sesión.
- **`ds_session_id`:** cookie **de sesión** httpOnly. No hace falta que sobreviva; tras el reinicio vuelve a existir (el servidor la re-emite al cargar).

**Conclusión:** login una vez → sesión persistente real entre reinicios. **Confirmado.**

### Hallazgo lateral (app principal, fuera de este experimento)

El navegador embebido de Amatista **no** es aislado/efímero como se asumía: `ensureBrowserView()` (`src/main/embedded-browser.ts:36`) no pasa `partition`, así que usa la **sesión default**, que la tabla de arriba confirma persistente en disco y compartida con la ventana principal. Cualquier sitio que el agente visite con el navegador embebido deja cookies/`localStorage` que sobreviven reinicios. No se tocó (fuera de alcance).

## Tarea 2 — Estructura real del DOM de la PWA

**Respuesta: mapeable, con una señal de "terminó" real y observable.** Mapeado por CDP (puerto 9860) sobre la vista autenticada el 2026-09-23. Se envió **un solo prompt de prueba inocuo** (`Respondé solo: OK`), anunciado al usuario antes de enviarlo.

### Selectores reales

| Pieza | Selector recomendado | Notas |
|---|---|---|
| Campo de entrada | `textarea` (es el único de la página) | `placeholder="Mensaje a DeepSeek"` **depende del idioma** (UI en español) — no usarlo como selector. Las clases propias (`_27c9245`, `d96f2d2a`) son hashes de build, **inestables**. Se escribe con el setter nativo de `HTMLTextAreaElement.value` + evento `input` burbujeante (patrón React) — confirmado real: el botón pasa de deshabilitado a habilitado. |
| Botón enviar | `.ds-button--primary.ds-button--circle` dentro del contenedor del `textarea` (subiendo ~5 niveles) | Es un `div[role="button"]`, **sin `aria-label`**. `ds-button--*` son clases del design system (legibles, más estables que los hashes). Tiene la clase `ds-button--disabled` mientras el campo está vacío. `.click()` en el DOM lo dispara (confirmado real). |
| Respuesta | `.ds-markdown.ds-assistant-message-main-content` (la última) | Dentro de `.ds-message`, dentro de una **lista virtual** (`.ds-virtual-list`, ítems con `data-virtual-list-item-key`). Los mensajes fuera de pantalla se **desmontan del DOM**: leer siempre el último con la vista scrolleada al fondo. |
| Botones de acción del mensaje | 6 × `.ds-button--iconLabelTertiary` bajo el mensaje | Copiar, regenerar, votos, "Leer en voz alta" (el único con `aria-label`), compartir. |
| Chat nuevo | la URL pasa de `/` a `/a/chat/s/<uuid>` al enviar el primer mensaje | Sirve para identificar la conversación. |

### Señal real de "terminó de generar" (lo crítico)

El ícono SVG del **mismo botón de enviar** recorre estados distintos. Línea de tiempo real, muestreo cada 150 ms (primer `d` del `<path>` del ícono):

| t (ms) | Ícono (`path d`) | Deshabilitado | Estado |
|---|---|---|---|
| 0 | `M8.3125 0.980206…` | no | flecha "enviar" (campo con texto) |
| 157 | `M34,18 C34,9.163444…` | sí | spinner (conectando) |
| 1395 | `M2 4.88C2 3.68009…` | **no** | **cuadrado "detener"** (generando) |
| 2031 | `M8.3125 0.980206…` | sí | flecha "enviar" otra vez — **terminado**; `.ds-markdown` = `"OK"` |

**Regla de detección propuesta:** la generación terminó cuando el botón vuelve al ícono de flecha (`M8.3125…`) después de haber pasado por el cuadrado de detener (`M2 4.88…`). La estabilidad del texto de la última `.ds-markdown` sirve como confirmación secundaria.

- **Qué NO usar como señal:** comparar el `path d` completo, porque es un detalle de implementación que puede cambiar con cualquier deploy. Clasificar por prefijo, o mejor por "¿cambió respecto del ícono de reposo?".
- La primera prueba (`"OK"`) no alcanzaba para ver el streaming; se resolvió con la prueba 2 de abajo.

### Prueba 2 — streaming largo + bloque de razonamiento (2026-09-23, permiso explícito del usuario)

- **Prompt real:** `Enumerá del 1 al 40 con una frase cada uno`.
- **Modo:** "Pensamiento Profundo" (`.ds-toggle-button` con el texto "Pensamiento Profundo") estaba **apagado**. Se encendió **solo para esta prueba** y se **restauró a apagado** al final (verificado: `thinkRestored: true`). "Búsqueda inteligente" (encendida) no se tocó. El estado de un toggle se lee con la clase `ds-toggle-button--selected`.
- **Instrumentación:**
  - un `MutationObserver` real sobre todo el `body`, con cada mutación clasificada por región: respuesta / resto del `.ds-message` / otras;
  - un muestreo del estado cada 150 ms;
  - una verificación de que el texto solo se agrega al final ("append-only").

**Línea de tiempo real (resumida):**

| t (ms) | Ícono del botón | Razonamiento (chars) | Respuesta (chars) | Fase |
|---|---|---|---|---|
| 168 | spinner | 0 | 0 | conectando |
| 636 | **detener** | 0 | 0 | arranca la generación |
| 1260 → 5307 | detener | 193 → 2769 | **0** | **razonamiento en streaming** |
| 5424 | detener | 2838 | — | aparece el contenedor `.ds-assistant-message-main-content` |
| 5614 → 6716 | detener | 2838 (fijo) | 171 → 1278 | **respuesta en streaming** |
| **6871** | **enviar** | 2838 | **1389** (final, 40 líneas) | **terminado** |

**Conclusiones reales:**

1. **El texto crece en tiempo real, y hay un evento real que lo avisa.**
   - Las 81 mutaciones de la respuesta fueron todas de tipo **`childList`**, con **0 de tipo `characterData`**: DeepSeek **agrega nodos nuevos** (párrafos `ds-markdown-paragraph` / nodos de texto) en vez de editar el texto de nodos existentes.
   - Por eso un `MutationObserver` con `{ childList: true, subtree: true }` sobre el contenedor de la respuesta dispara con cada fragmento nuevo, y no hace falta hacer polling del DOM completo.
   - Detalle clave: **`characterData: true` sola no alcanzaría** — con esa opción sola el observer no vería nada de la respuesta.
2. **Append-only confirmado: 0 violaciones.** Cada lectura empezó siempre con el texto de la anterior, así que el fragmento nuevo es `texto.slice(largoAnterior)`.
   - Salvedad: esta respuesta era de párrafos simples. Markdown complejo (bloques de código, tablas) podría re-renderizar lo ya escrito y no está probado.
3. **El bloque de razonamiento SÍ aparece con el modo activo**, como un hijo **aparte** del `.ds-message`:
   - Va **antes** de la respuesta y tiene una clase **hasheada** (`_74c0879`), por lo que es inestable.
   - Su encabezado está en el idioma de la UI ("Pensó durante 5 segundos") y el razonamiento mismo vino en inglés.
   - Sus mutaciones incluyen `characterData` (25): el encabezado cambia de texto mientras piensa.
   - **Leer siempre `.ds-assistant-message-main-content` (clase semántica estable) lo excluye solo.** Nunca usar `.ds-markdown` suelto: dentro del razonamiento también hay `ds-markdown-paragraph`.
4. **La señal de fin por ícono queda confirmada con respuesta larga, y además es la única robusta.**
   - Durante ~4,8 s de razonamiento la respuesta está **vacía** (el contenedor ni siquiera existe) mientras el ícono muestra "detener".
   - Un detector por "texto estable" habría dado un **falso "terminó"** en esa fase.
   - El ícono volvió a "enviar" exactamente cuando la respuesta alcanzó su largo final (1389).

**Receta de lectura resultante** (solo investigación, **no implementada**):

1. Esperar a que el ícono pase a "detener".
2. Observar con `MutationObserver({ childList: true, subtree: true })` el `.ds-message` nuevo y emitir los deltas de `.ds-assistant-message-main-content` (append-only).
3. Declarar el fin cuando el ícono vuelva a "enviar".
4. El razonamiento, si se quiere, es el resto del `.ds-message`.

## Tarea 3 — Riesgo real de detección/bloqueo

**Respuesta: riesgo real pero asimétrico.** Hay evidencia sólida de detección y baneo contra clientes que llaman al backend web de DeepSeek por **HTTP crudo**. No se encontró evidencia documentada de baneos contra un **navegador real** que ejecuta el JavaScript propio de DeepSeek (el enfoque de este experimento). Esto es ausencia de evidencia, no prueba de seguridad.

### Evidencia propia (observación real, 2026-09-23)

Con el User-Agent de Electron **sin modificar** (`...Chrome/150.0.7871.129 Electron/43.2.0 Safari/537.36`), `chat.deepseek.com` cargó en la `WebContentsView` experimental **sin ningún desafío** y redirigió sola a `/sign_in`. Después, el **login con Google funcionó** dentro de Electron: pasó por la verificación en dos pasos de Google, sin el bloqueo de "navegador no seguro". El envío de un mensaje y el reinicio tampoco dispararon ningún desafío visible.

**Mecanismos anti-bot presentes de verdad en la página autenticada.** Se leyeron solo los nombres de las claves y cookies:

- **AWS WAF (Bot Control / challenge):**
  - cookie `aws-waf-token` (dominio `.deepseek.com`, vence en ~4 días);
  - `localStorage`: `aws_waf_token_challenge_attempts`, `awswaf_token_refresh_timestamp`, `aws_waf_referrer`.
  - La capa anti-bot activa hoy es la de AWS, no Cloudflare como sugerían los reportes de 2025.
- **`smidV2`** (cookie + `localStorage`): nombre consistente con el SDK de huella de dispositivo de Shumei (数美), una solución antifraude china. Confianza media: se infiere del nombre, no se verificó el script.
- **`__appKit_@deepseek/chat_fg_enableHcaptcha`:** un feature flag de hCaptcha. Puede activarse del lado del servidor.
- **`closeUnsafeEnvWarn`:** sugiere que la app puede advertir sobre un "entorno inseguro".
- **Telemetría:** `APMPLUS…` (APM), `__tea_cache_…` / `__tea_session_id_…` (analítica).

Estos mecanismos son la infraestructura real con la que DeepSeek *podría* distinguir automatización. Que no se hayan disparado con un solo mensaje no dice nada sobre un uso sostenido.

### Evidencia externa

| Mecanismo | Afecta a este enfoque (navegador real) | Confianza | Fuente |
|---|---|---|---|
| **Cloudflare** delante de `chat.deepseek.com`, con bucles infinitos de verificación en webviews embebidos (BetterTouchTool: DeepSeek + Claude.ai + Grok; se arregló cambiando el UA) | **Sí, directo** — riesgo típico de Electron | Varios reportes; hilo verificado | [folivora #42493](https://community.folivora.ai/t/floating-webview-gets-stuck-on-cloudflare-captcha-infinite-loop/42493), [Opera forum](https://forums.opera.com/topic/76340/cloudflare-captcha-at-chat-deepseek-com-not-working) |
| **Turnstile/Cloudflare falla en navegadores embebidos de Electron** por una identidad de navegador inconsistente (sept 2026) | **Sí** | PRs de primera mano | [orca #18749](https://github.com/stablyai/orca/pull/18749), [t3code #7110](https://github.com/pingdotgg/t3code/pull/7110), [sim #8192](https://github.com/simstudioai/sim/pull/8192) |
| **Google bloquea su login** dentro de navegadores embebidos | **No se reprodujo**: el login con Google del usuario funcionó en esta vista (2026-09-23). Google puede endurecer la política en cualquier momento. | Muchos issues externos vs. 1 observación propia en contra | [firebase-js-sdk #2478](https://github.com/firebase/firebase-js-sdk/issues/2478) |
| **Proof-of-work** (`create_pow_challenge` / `x-ds-pow-response`), calculado por el WebAssembly propio de la página | **No directo** — un Chromium real lo resuelve solo; apunta a clientes no-navegador | Varias implementaciones open source independientes | [deepseek4free](https://github.com/xtekky/deepseek4free) |
| **Límite de frecuencia** ("mensajes demasiado frecuentes"), sin número publicado | **Sí** — conductual, aplica a cualquier cliente | Muchos reportes de usuarios | [merlio](https://merlio.app/blog/fix-deepseek-messages-too-frequently) |
| **Ola de baneos tras DeepSeek v4.1** (nuevo sistema anti-abuso, issue abierto el 2026-09-11) | **Indirecto** — reportado solo para clientes HTTP crudos, pero el sistema es nuevo y sus señales se desconocen | Varios reportes; issue verificado | [deepseek4free #21](https://github.com/xtekky/deepseek4free/issues/21), [ds2api #1](https://github.com/maxff77/ds2api/issues/1) |
| Captcha/slider en dispositivos o IPs nuevas; números virtuales rechazados | Posible, solo en el login (que es manual) | Solo guías SEO, sin fuente primaria | [deepseekai.guide](https://deepseekai.guide/guides/deepseek-login/) |

**Otros servicios:** ChatGPT detecta con Cloudflare la automatización estilo Playwright incluso en un Chrome real. Hay reportes de desafíos repetidos, pero no de baneo de cuenta.

### Conclusión de la Tarea 3

- **Técnicamente posible:** sí.
- **Riesgos prácticos:** conductuales, no de fingerprint de DOM:
  - ritmo y volumen de mensajes (límite de frecuencia y el nuevo anti-abuso de v4.1, con señales desconocidas);
  - la capa anti-bot real (AWS WAF + huella de dispositivo + hCaptcha activable) puede empezar a desafiar al UA de Electron en cualquier momento;
  - el login con Google funcionó hoy, pero depende de una política de Google que puede cambiar.
- **Fuera de alcance deliberadamente:** no se investigó ni se implementará ninguna técnica de evasión (UA falso, anti-fingerprinting, resolución de captchas).

## Tarea 4 — Términos de servicio reales

**Respuesta: SÍ, lo prohíben de forma explícita.**

- **Fuente oficial:** [DeepSeek Terms of Use](https://cdn.deepseek.com/policies/en-US/deepseek-terms-of-use.html), vigente desde el **27 de marzo de 2026**.
- **Alcance:** cubre explícitamente sitios web y aplicaciones (incluida la PWA de chat), no solo la API.
- **Descartados:** varios resultados de búsqueda eran sitios imitadores no oficiales (deepseek-chat-app.com, deepseek-usa.ai, deepseek.net, etc.) y se descartaron.

Cláusulas relevantes (parafraseadas; la estructura de secciones se verificó en dos lecturas independientes):

- **§3.5 (prohibiciones de seguridad), ítem (3):** prohíbe la ingeniería inversa y capturar o copiar contenido del servicio con medios automatizados — textualmente, *"using any robots, spiders, or other automatic setups"*. Es la cláusula que alcanza de forma directa a este experimento.
- **§3.3:** DeepSeek se reserva el derecho de revisar técnicamente la conducta de los usuarios, incluidos sistemas de filtrado de riesgo.
- **§2.3:** la cuenta es intransferible: no se puede prestar, alquilar ni ceder.
- **§8.2:** sanciones escalonadas ante violaciones: advertencia, restricción de funciones, suspensión, cierre de cuenta y prohibición de volver a registrarse.
- **§3.6 (uso indebido):** no menciona la automatización de forma explícita. Se centra en usos ilegales, dañinos, de propiedad intelectual y de replicación no autorizada del servicio.

**Lectura honesta:** automatizar la PWA con la propia cuenta cae dentro de §3.5(3). El riesgo contractual real es §8.2: la sanción típica es sobre la cuenta (suspensión o cierre), sin cláusulas de penalidad económica. Para el texto exacto, leer §3.5 y §8.2 directamente en la fuente oficial.

---

# Diseño del puente — opción A: "DeepSeek PWA" como tipo de conexión real (2026-09-23)

> Fase de **diseño**, con pruebas puntuales reales donde hacían falta. **Nada implementado**: cero cambios en `src/`. Rama: `experiment/deepseek-pwa`.

**Opción elegida: A** (un chat propio con DeepSeek, que el usuario usa como cualquier otro). La opción B (una tool `ask_deepseek_pwa` que otro modelo invoca) queda descartada por pedido explícito del usuario. Casi toda la maquinaria de A (driver de la vista, streaming, errores) serviría igual para B si algún día se quisiera.

### Resumen del diseño

| Pregunta | Decisión |
|---|---|
| 1. Integración | `RuntimeKind`/`ProviderType` nuevos `'deepseek-pwa'`, módulo `deepseek-pwa-runtime.ts` y un branch propio en `dispatchTurnForWindow()`. **Sin `wire*`**: callback `onDelta` por turno. F0/F1/backstop/cancelación se reusan tal cual. Chat puro, sin tools. |
| 2. Streaming | **Escribir por DOM, leer por red:** el stream de `completion` de la propia página vía `webContents.debugger`. Se traduce a `item/agentMessage/delta` (append) → `item/completed` (reemplazo final) → `turn/completed`, **sin ningún caso especial en el renderer**. |
| 3. Toggles | "Pensamiento Profundo" expuesto, mapeado al selector de esfuerzo que ya existe. "Búsqueda inteligente" fija en apagado en v1. El estado se fija justo antes de cada envío, con mutex entre vistas. |
| 4. Multi-chat | **Una vista oculta por chat activo**, en un pool con tope e inactividad. DeepSeek acepta generaciones simultáneas en la misma cuenta. |
| 5. Errores | La verdad sale del stream (HTTP 200 + `FINISHED` + contenido), no de la UI. Login/captcha → se muestra esa vista para que el usuario intervenga, nunca se resuelve solo. Sin reintentos automáticos. |

## Tarea 1 — Integración a `runTurnForWindow()`

**Respuesta: necesita su propio branch de runtime en `dispatchTurnForWindow()`, igual que codex/API/CLI, pero NO una función `wire*` nueva.** Todo lo que rodea al branch (ciclo de vida del turno, F0, F1, backstop) se reusa tal cual.

### Qué ya existe y se reusa sin tocar

| Pieza existente | Qué le da gratis al puente |
|---|---|
| `runTurnForWindow()` (ipc-agent.ts) | `turnInFlight`, guard de "ya hay un turno en vuelo", `turnStartedAt`, backstop de main, `finally` que limpia todo |
| `sendSessionEvent()` → `sendToChatWindow()` (F0) | Si no hay panel mirando, los eventos se bufferizan y se reproducen al volver (catch-up) |
| `broadcastBackgroundActivity()` + notificación del SO (F1) | Badge, vista agregada y aviso al terminar en segundo plano |
| `session.cancelCurrentTurn` | Hook del botón "Detener" (acá: click real en el botón de detener de la PWA) |
| Tope `MAX_CONCURRENT_SESSIONS` (F0) | Una sesión DeepSeek PWA cuenta como cualquier otra |

### Piezas nuevas (propuesta concreta)

1. **Tipos:** `ProviderType` `'deepseek-pwa'` y `RuntimeKind` `'deepseek-pwa'`, con `authMode: 'subscription'`. Un tipo propio, a propósito: ya hubo un bug real por reusar `'anthropic'` para DeepSeek (`isDeepSeekProvider()` en App.tsx).
2. **Módulo nuevo `deepseek-pwa-runtime.ts`** (clase `DeepSeekPwaRuntime`), con la misma forma que `ApiAgentRuntime`/`CliAgentRuntime`:
   - `connect({ chatId, remoteSessionId })`: toma una `WebContentsView` **propia de ese chat** de un pool (Tarea 4), con la partición `persist:deepseek-pwa` compartida (el login es uno solo). La vista está **oculta**; probado real que funciona así. Además le engancha `webContents.debugger` para leer el stream (Tarea 2), verifica el login y hace el self-check de selectores (Tarea 5).
   - `send(text, { onDelta, onThinking, signal }) → { text, remoteSessionId }`: **escribe por DOM** (textarea + botón + toggles) y **lee por red** (stream de `completion` vía CDP). El fin lo marca el `response/status = FINISHED` del propio stream.
   - `cancelTurn()`: click real en "detener". **Probado con la vista oculta (P3):** dispara `POST /api/v0/chat/stop_stream`, el stream cierra con `INCOMPLETE` en <1 s y el servidor guarda la respuesta parcial.
   - `stop()`: devuelve la vista al pool o la destruye.
3. **Branch en `dispatchTurnForWindow()`:** `if (runtime === 'deepseek-pwa') { ... }`, con la misma estructura que el branch API:
   - registra `session.cancelCurrentTurn`;
   - hace `await runtime.send(...)` emitiendo los deltas a medida que llegan (Tarea 2);
   - al terminar emite `item/completed` + `turn/completed`; si se canceló, `turn/cancelled` con `partialText`.
   - **Por qué no hace falta un `wire*`:** `wireApi`/`wireCli`/`wireCodex` enganchan emisores de eventos de runtimes de larga vida. Acá los deltas son por turno, así que alcanza un callback `onDelta` del mismo `send()` (el mismo patrón que el `waitForCompletion` del branch Codex).
4. **Branch en `connectSessionForWindow()`:** sin binario ni API key que chequear. En su lugar:
   - "¿la vista está logueada?" (sin redirección a `/sign_in`, con `userToken` presente, solo el nombre);
   - si no lo está: abre la vista **visible** para que el usuario inicie sesión a mano, y la conexión queda pendiente hasta que lo haga (patrón *human-in-the-loop* ya validado en este experimento).
5. **Mapeo de conversación, un chat de Amatista ↔ una conversación de DeepSeek:**
   - Se persiste el `remoteSessionId` (el `<uuid>` de `/a/chat/s/<uuid>`) junto al chat, por ejemplo como columna nueva en `chat_sessions`.
   - Al reconectar o reiniciar, la vista navega a esa conversación. **Probado real (Tarea 4):** `loadURL` tarda ~1,6–1,8 s y el click SPA en el sidebar 0,45 s, en ambos casos con el contenido correcto.

### Limitaciones reales de este runtime (a comunicar en la UI, no esconderlas)

- **Sin tools.** La PWA no expone function calling a Amatista: DeepSeek-vía-PWA es un chat **puro**, sin `read_file`/`write_file`/terminal/etc., y sin acceso al workspace. Su modelo va con `capabilities.tools: false`.
- **Contexto de Amatista:**
  - El historial vive del lado de DeepSeek (su propia conversación), no en el `ContextEnvelope`.
  - Persona/AGENTS.md/TODOs solo pueden viajar como **texto en el mensaje**, no como system prompt. Propuesta: mandarlos una única vez, en el primer mensaje de una conversación nueva, con el mismo criterio que `activeContextSeeded` ya usa para los CLI.
  - Si un chat de Amatista con historial previo se cambia a DeepSeek PWA, se abre una conversación nueva sembrada con un resumen del historial.
- **Adjuntos:** fuera de v1 (solo texto). La PWA tiene carga de archivos, pero eso es otro selector y otro flujo.

## Tarea 2 — Streaming real hacia la UI (sin casos especiales en el renderer)

**Respuesta: se traduce 1 a 1 a eventos que `handleAgentEvent()` ya maneja hoy.** Confirmado leyendo el código real de App.tsx, no supuesto.

### Lo que ya soporta el renderer

- **`item/agentMessage/delta { itemId, delta }` en runtimes no-Codex (sin `turnKey`):** llama a `appendAssistantMessage(workspace, itemId, delta, 'append')`, así que **varios deltas con el mismo `itemId` se concatenan en vivo**. El streaming ya funciona así, sin tocar la UI; los runtimes API/CLI actuales lo usan con un único delta al final.
- **`item/completed { itemId, item: { type: 'agentMessage', text } }`:** `extractAssistantText()` recorre `params.item` y llama `appendAssistantMessage(..., 'replace')` sobre el **mismo `itemId`**, o sea que **reemplaza** el texto transmitido por uno final.
- **`turn/completed {}`:** cierra el turno. No hay error de "sin texto", porque `assistantOutputSeenRef` ya quedó en `true` con los deltas.

### Fuente de lectura: el stream de red de la propia página, NO el DOM (decisión cambiada por evidencia de la Tarea 4)

Un primer borrador proponía leer por DOM (el `MutationObserver` de la prueba 2). **La Tarea 4 lo descartó con evidencia real:** en una vista **oculta**, el servidor genera la respuesta completa pero **React no pinta nada** (`.ds-assistant-message-main-content` no aparece nunca). Todo chat en segundo plano (F0) o sin panel visible quedaría ciego. En cambio:

- **Prueba 4e:** vista **nunca visible**, lectura en vivo con `webContents.debugger` → `Network.streamResourceContent` + `Network.dataReceived` sobre la request `POST /api/v0/chat/completion` que hace el propio JavaScript de DeepSeek.
  - Llegaron **123 fragmentos** entre 0,54 s y 3,5 s.
  - El contenido creció **progresivamente** de 168 a 1.396 caracteres (muestras cada ~150 ms).
  - `response/status = FINISHED` al final.
  - En ese mismo momento el DOM tenía **0** caracteres.

| | Leer por DOM (`MutationObserver`) | **Leer por red (stream vía CDP) — elegido** |
|---|---|---|
| Vista oculta / chat en segundo plano | ❌ no pinta nada | ✅ funciona igual |
| Formato | `innerText`: pierde Markdown (código, listas, tablas) | ✅ **Markdown crudo**, sin pérdida |
| Señal de fin | Ícono del botón (indirecta, y engaña: ver Tarea 5) | ✅ `response/status = FINISHED`, explícita |
| Canal página → main | Hace falta *pull* con `executeJavaScript` | ✅ Ninguno: el debugger lo lee desde main, sin tocar el JavaScript de la página |
| Fragilidad | Clases hasheadas, lista virtual | Formato privado del stream (cambia sin aviso) |

**Costo honesto de esta elección:** el puente queda atado al **formato privado** del stream de DeepSeek. Es un stream de "parches" JSON:
- `data: {"p":"response/fragments/-1/content","o":"APPEND","v":"..."}`;
- después, `data: {"v":"..."}` sin `p`, que se aplica a la última ruta;
- al final, `{"p":"response/status","v":"FINISHED"}`.

DeepSeek puede cambiarlo sin aviso. Mitigación: un parser aislado en un solo archivo, con una prueba de contrato contra una captura real guardada. Si el parser no reconoce nada, el turno falla con un mensaje claro (Tarea 5); nunca devuelve basura. Parsear su protocolo queda más cerca de la ingeniería inversa que §3.5(3) prohíbe, pero la automatización en sí ya cae en esa cláusula de todos modos.

**El DOM se sigue usando, pero solo para escribir:** textarea, botón de enviar, toggles y botón de detener. Probado real que funciona con la vista oculta.

### Secuencia de eventos propuesta

| Momento | Evento emitido por main |
|---|---|
| Llegan fragmentos de **razonamiento** (ruta de un fragmento de tipo razonamiento) | `item/toolCall/status` "Pensamiento profundo…": muestra el estado **y** refresca el watchdog de turno del renderer. Un razonamiento largo no produce deltas de respuesta por minutos. |
| Llegan fragmentos de **contenido** | `item/agentMessage/delta { itemId: 'deepseek-pwa-<ts>', delta }`, con deltas **agrupados cada ~120 ms**. `appendAssistantMessage` persiste en SQLite en **cada** delta: agrupar baja 123 fragmentos a ~25 escrituras. |
| `response/status = FINISHED` | `item/completed { itemId, item: { type: 'agentMessage', text: markdownCompleto } }` (reemplazo idempotente con el texto entero reconstruido) y después `turn/completed {}` |
| Cancelado | `turn/cancelled { partialText }` |

### Trampa real del renderer, resuelta en main

`appendAssistantMessage` **descarta los deltas que son solo espacios en blanco** (`if (!normalizedText) return`) y **recorta el primero**. En un stream de tokens, un fragmento `"\n\n"` suelto es común. Emitido solo, se perdería y pegaría los párrafos. Regla: nunca emitir un delta que sea solo espacios; se guarda y se antepone al siguiente delta con contenido. Además, el `item/completed` final reemplaza todo con el texto exacto, así que aunque un delta se deformara, el mensaje persistido queda fiel.

## Tarea 3 — "Pensamiento Profundo" y "Búsqueda inteligente"

**Criterio:** exponer **Pensamiento Profundo** como control real por chat, y dejar **Búsqueda inteligente fija en APAGADO** en v1.

| | Exponerlo en el composer | Dejarlo fijo |
|---|---|---|
| **Pensamiento Profundo** | ✅ **Recomendado.** Cambia de verdad la calidad y la latencia (en la prueba 2 sumó ~4,8 s de razonamiento). Se mapea sobre el selector de esfuerzo/razonamiento que el composer ya tiene (`effort`), así que **no hace falta un control nuevo** ni un caso especial nuevo. | Obliga al usuario a ir a la PWA para cambiarlo. |
| **Búsqueda inteligente** | Suma un selector más que puede romperse y latencia variable. Amatista ya tiene su propia búsqueda web, aunque este runtime no puede usarla (no tiene tools). | ✅ **Recomendado para v1:** fija en **apagado**, así los resultados son deterministas y hay menos acoplamiento al DOM. Se agrega como toggle en v2 si hace falta. |

**Detalles de implementación que salieron de las pruebas:**

- **El estado de los toggles es global a la partición**, no por conversación: vive en `localStorage` (`thinkingEnabled`, `searchEnabled`), que comparten todas las vistas. Por eso:
  - se **fija el estado deseado justo antes de cada envío**: se lee `ds-toggle-button--selected` y se hace click **solo si no coincide**, nunca un toggle a ciegas;
  - "fijar toggles + click en enviar" va dentro de una **sección crítica corta con mutex entre vistas** (~500 ms), porque 2 chats enviando a la vez con configuraciones distintas se pisarían el `localStorage`.
- **Los textos de los toggles dependen del idioma, y el idioma cambia entre sesiones de la misma partición.** Está **confirmado real** en P2: primero "Pensamiento Profundo", después "DeepThink". Regla **obligatoria**: elegirlos por **posición** (1º `.ds-toggle-button` = razonamiento, 2º = búsqueda), validando el texto contra una lista de etiquetas conocidas en varios idiomas; si no coincide, no se hace click y se falla con un mensaje claro.
- **Verificación desde el stream:** `v.response.thinking_enabled` / `search_enabled` del objeto inicial confirman que el envío salió con el modo pedido. Sin leer `localStorage`.
- **Funcionan con la vista oculta** (P2: la clase se actualiza tras el click).

## Tarea 4 — Multi-chat real: ¿2+ chats de DeepSeek simultáneos?

**Respuesta: sí, con una vista por chat activo. Todas pueden estar ocultas, siempre que la respuesta se lea por red.** Una sola vista que cambia de conversación también funciona, pero solo en serie.

Probado de verdad con 5 harnesses (`t2_dom/t4*.cjs`), todos sobre la partición logueada real, con prompts mínimos e inocuos.

### Las pruebas y lo que dieron

| Prueba | Setup | Resultado real |
|---|---|---|
| **4.1 Cambio de conversación en UNA vista** | `loadURL('/a/chat/s/<uuid>')` y click SPA en el link del sidebar, sobre 2 chats de prueba ya existentes (solo lectura) | ✅ `loadURL`: 1.630 ms y 1.844 ms. Click SPA: **447 ms**. Contenido correcto en los 3 casos. |
| **4.2 Concurrencia (1er intento)** | Vista A visible + vista B **oculta**, 2 chats nuevos, enviados a la vez | ❌ A: 60 s en "detener" y luego vacío. B: "enviar" a los 1,1 s, vacío. Ninguna conversación quedó guardada (sus URLs redirigen a `/`). |
| **4.3 Control** | A visible sola / después B **oculta** sola | A ✅ (548 chars). B ❌ DOM vacío, **con `completion` HTTP 200**. La causa es la **visibilidad**, no la concurrencia. |
| **4.4 Aislar la causa** | (a) oculta + `backgroundThrottling:false`; (b) "visible" pero fuera de la ventana; (c) **2 vistas visibles a la vez** | (a) ❌ y (b) ❌: fuera de la ventana cuenta como `visibilityState: hidden`, así que no es el throttling de timers. **(c) ✅✅: 2 generaciones simultáneas en la misma cuenta** (595 y 457 chars, ~2 s, 2 conversaciones distintas). |
| **4.5 ¿El servidor generó en la vista oculta?** | Oculta, stream capturado vía CDP, y después se hizo visible y se recargó la conversación | ✅ **El servidor generó todo** (546 chars de contenido, `FINISHED`, título generado). La conversación **quedó guardada con la respuesta** (536 chars al recargar). Lo único que no pasa oculta es el **pintado del DOM**. |
| **4.6 Stream en vivo, vista nunca visible** | Oculta desde antes de cargar; `Network.streamResourceContent` | ✅ La página carga, se escribe, se envía. **123 fragmentos en vivo**, de 168 a 1.396 chars en ~2 s, con `FINISHED`. DOM = 0. |

### Diseño resultante

- **Una `WebContentsView` por chat de DeepSeek activo**, en un **pool** dentro de `DeepSeekPwaRuntime`, todas en la misma partición `persist:deepseek-pwa` (un solo login). **Siempre ocultas:** nunca se muestran en la UI de Amatista, que ve la conversación en su propio chat.
  - **Excepción:** se muestra la vista de un chat cuando hace falta intervención humana (login, captcha; Tarea 5).
- **Tope + destrucción por inactividad:** cada vista es un proceso renderer (~100–200 MB). Propuesta:
  - tope de **3** vistas vivas;
  - destrucción tras N minutos sin uso, el mismo patrón que `video-frame-reader.ts`;
  - un chat sin vista la recrea bajo demanda y navega a su `remoteSessionId` (probado: ~1,6 s por `loadURL`).
- **Si el tope está lleno:** se reusa la vista del chat inactivo más viejo y se navega a la conversación nueva. El click SPA (0,45 s) sirve si el link está en el sidebar; si no, `loadURL`.
- **Concurrencia:** DeepSeek acepta 2 generaciones simultáneas en la misma cuenta (4.4c). El mutex de la Tarea 3 cubre **solo** la sección "fijar toggles + click en enviar" (~500 ms), no la generación.
- **Todos los paneles de Amatista pueden tener su chat DeepSeek** sin que ninguno "robe" la vista de otro, porque cada chat tiene la suya.

### Límites honestos

- ~~No se probó "2 ocultas a la vez leyendo por red"~~ → **confirmado ✅** en la ronda de pendientes (P1, más abajo).
- El fallo de A en 4.2 (60 s colgado, luego vacío, chat sin guardar) **no quedó explicado** y **no se reprodujo** en ~20 generaciones posteriores (P5, más abajo). El timeout de inactividad de la Tarea 5 lo cubre sin importar la causa.
- **Chats creados en tu cuenta por estas pruebas** (todos con prompts inocuos):
  - tareas anteriores: "OK" y "1 al 40";
  - esta tarea: MAR, MONTAÑA, LLUVIA, VIENTO, FUEGO, NIEVE, NUBES y RÍOS, "1 al 5/12".
  - No se borró ninguno; se pueden borrar a mano desde la PWA.

## Tarea 5 — Errores reales: mensajes honestos, nunca fallar en silencio

**Hallazgo real que define este punto (Tarea 4):** la señal de la UI **miente en los dos sentidos**:
- con la vista oculta, el ícono vuelve a "enviar" y el DOM queda vacío **aunque el servidor generó y guardó la respuesta** (4.5);
- en 4.2 hubo un caso real colgado 60 s que terminó vacío y **sin** guardar.

Por eso la **fuente de verdad es el stream de red**, no el DOM.

**Criterio de éxito de un turno:**
1. la request `POST /api/v0/chat/completion` respondió HTTP 200;
2. su stream terminó con `response/status = FINISHED`;
3. se reconstruyó contenido no vacío.

Cualquier otra combinación es un error, con un mensaje específico:

| Situación | Cómo se detecta | Qué ve el usuario |
|---|---|---|
| Sesión de DeepSeek vencida | Redirección a `/sign_in` | "Tu sesión de DeepSeek expiró. Iniciá sesión en la ventana de DeepSeek." Se muestra la vista **visible** para el login manual; el turno queda pendiente o falla limpio al vencer el timeout. |
| **hCaptcha / desafío AWS WAF** | Cualquiera de estas cuatro:<br>• `iframe[src*="hcaptcha.com"]`;<br>• contenedor/script de desafío de AWS WAF en la página;<br>• redirección a una página de desafío;<br>• **por red**: las llamadas a `/api/v0/*` (por ejemplo `create_pow_challenge`, `completion`) devuelven un status que no es 2xx, o `completion` no se emite nunca. Ya hay registro de status por ruta, probado en 4.3 con `webRequest.onCompleted`, solo ruta y status. | "DeepSeek pide verificación humana. Resolvela vos en la ventana de DeepSeek." Se muestra **esa** vista (es la única excepción al "siempre ocultas"). **Nunca se intenta resolver automáticamente** (fuera de alcance por decisión explícita). Al resolverla, el turno sigue; si vence el timeout, falla con ese mismo texto. |
| Límite de frecuencia / servidor ocupado | Texto de aviso en la página (palabras "frecuente", "ocupado", "busy", "límite") dentro de los contenedores de toast | Se muestra **el texto real del aviso de DeepSeek**, tal cual. **Sin reintento automático**: reintentar podría duplicar mensajes en la cuenta y subir el riesgo de baneo. Los selectores de toast todavía no se observaron en vivo: pendiente. |
| El envío no arrancó | Después de escribir, el botón sigue deshabilitado, o **no aparece ninguna request `completion`** en ~5 s | "No se pudo enviar el mensaje; la interfaz de DeepSeek pudo haber cambiado." |
| **Terminó sin contenido** | El stream cierra (`event: close`) sin `FINISHED`, o con `FINISHED` pero 0 caracteres de contenido | "DeepSeek terminó sin devolver respuesta." Con el último estado del stream como detalle. |
| Generación colgada | La request `completion` sigue abierta sin fragmentos nuevos durante N s (observado real en 4.2: 60 s colgado y luego vacío) | Timeout de inactividad propio del puente, además del backstop de F0: click en "detener" y error "DeepSeek dejó de responder". |
| El formato del stream cambió | El parser no reconoce ninguna ruta/estado conocido en un stream HTTP 200 | "DeepSeek cambió su formato de respuesta; el puente necesita actualización." Nunca se muestra texto a medio parsear. |
| La interfaz de DeepSeek cambió | **Self-check al conectar:** existe el `textarea`; existe el botón con el ícono de reposo conocido; existen los 2 `.ds-toggle-button` | Error de conexión explícito ("la interfaz de DeepSeek cambió; el puente necesita actualización"), en vez de fallar raro a mitad del turno. |

Todos los errores salen por el camino de error de turno que ya existe (el renderer los muestra como `agentError`). Ninguno se traga en silencio.

---

# Pendientes del diseño — resultados reales (2026-09-23)

Harnesses en `t5_pending/` (biblioteca común `lib_ds.cjs`):
- vistas **ocultas desde el inicio**;
- stream leído en vivo por CDP;
- registro de ruta + status HTTP;
- detector de cuelgue (más de 20 s sin fragmentos);
- watchdog por proceso;
- `withTimeout` en cada llamada.

Cero procesos `electron.exe` quedaron colgados después de ninguna corrida. Se usaron solo prompts nuevos e inocuos; los 39 chats originales no se tocaron. No se leyeron cookies, headers ni tokens.

| # | Pendiente | Resultado |
|---|---|---|
| 1 | 2 vistas ocultas simultáneas leyendo por red | ✅ **Funciona** |
| 2 | Razonamiento vs. respuesta en el stream | ✅ **Distinción explícita por tipo de fragmento** (`THINK` / `RESPONSE`) |
| 3 | "Detener" con vista oculta | ✅ **Funciona**, con estado final propio (`INCOMPLETE`) |
| 4 | Aviso de límite de frecuencia | ⚠️ **No se alcanzó** con 8 envíos seguidos (tope deliberado) |
| 5 | Cuelgue de 60 s | ⚠️ **No reproducido** (0 en 12 generaciones de esta ronda, ~20 en total) |

## P1 — 2 vistas ocultas a la vez, leyendo por red ✅

- **Setup:** 2 `WebContentsView` ocultas desde antes de cargar (`visibilityState: hidden` en ambas), 2 chats nuevos, envío simultáneo.
- **Vista A:** 86 fragmentos en vivo, 1.055 caracteres de `RESPONSE`, `FINISHED` a los 1,9 s.
- **Vista B:** 60 fragmentos, 911 caracteres, `FINISHED` a los 1,95 s.
- **Sin contaminación cruzada:** el stream de A habla solo de lagos, el de B solo de volcanes. Cada una en su propia conversación.
- **Red:** todos los `create_pow_challenge` / `chat_session/create` / `completion` devolvieron 200. El proof-of-work lo resuelve el propio JavaScript de DeepSeek también con la vista oculta.

**La combinación exacta del diseño final (Tarea 4) queda confirmada.**

## P2 — Razonamiento vs. respuesta en el stream ✅

**El stream los distingue de forma explícita.** No llegan mezclados.

Formato real, observado dos veces (prompt corto y prompt largo):

```
data: {"v":{"response":{... "thinking_enabled":true, ... "fragments":[{"id":2,"type":"THINK","content":"We", ...}]}}}
data: {"p":"response/fragments/-1/content","o":"APPEND","v":" need"}
data: {"v":" answer"}                                         <- continuación: misma ruta
...
data: {"p":"response/fragments/-1/elapsed_secs","o":"SET","v":1.919}   <- cierre del razonamiento
data: {"p":"response/fragments","o":"APPEND","v":[{"id":3,"type":"RESPONSE","content":"1", ...}]}
data: {"p":"response/fragments/-1/content","v":"."}           <- ruta explícita otra vez, SIN "o" (APPEND implícito)
data: {"v":" Un"}
...
data: {"p":"response/status","o":"SET","v":"FINISHED"}
```

| Prueba | `thinking_enabled` | THINK | RESPONSE | Caracteres fuera de un fragmento |
|---|---|---|---|---|
| Corto (`17 × 23`) | `true` | 56 chars | 3 chars (`391`) | 0 |
| Largo (1 al 6, puentes) | `true` | 1.388 chars | 754 chars | 0 |

**Reglas del parser que salen de esto (especificación para la implementación):**

1. Mantener una lista de fragmentos con su `type`. Se inicializa con `v.response.fragments` y crece con cada `{"p":"response/fragments","o":"APPEND","v":[...]}`.
2. **El `content` inicial de cada fragmento cuenta.** Ahí viene el primer token: `"We"` / `"1"` / `"391"`.
3. `response/fragments/-1/content` apunta al **último** fragmento. `{"v":"..."}` sin `p` continúa la **última ruta explícita**. Un `p` sin `o` implica APPEND.
4. Tipo del último fragmento: `THINK` → `item/toolCall/status` ("Pensamiento profundo…", keep-alive del watchdog); `RESPONSE` → `item/agentMessage/delta`.
5. `response/status`: `FINISHED` = éxito; `INCOMPLETE` = detenido (P3). `quasi_status` llega justo antes, con el mismo valor, y se ignora. `accumulated_token_usage` y `elapsed_secs` son metadatos.
6. Eventos `ready` / `update_session` / `title` / `close`. `title` trae el título que genera DeepSeek, útil para nombrar el chat de Amatista.

**Verificación en el objeto inicial:** `thinking_enabled` y `search_enabled` vienen dentro de `v.response`. El runtime puede **confirmar desde el propio stream** que el toggle quedó como se pidió, sin leer `localStorage`.

**Toggle con la vista oculta:** funciona. La clase pasó de `false` a `true` después del click estando oculta, y el stream lo confirmó. En las dos pruebas se **restauró a apagado**, verificado con la vista visible. "Búsqueda" no se tocó.

### Hallazgo real que confirma una advertencia del diseño: el idioma de la UI cambia entre sesiones

- **Primer intento de P2:** falló porque el toggle **no se encontró por su texto**. En este proceso la PWA estaba en **inglés** ("DeepThink" / "Search"), cuando en sesiones anteriores, con la **misma partición**, estaba en español ("Pensamiento Profundo" / "Búsqueda inteligente"). El prompt salió sin razonamiento (el stream lo confirmó con `thinking_enabled: false`) y no cambió nada.
- **Arreglo en el harness:** elegir el toggle **por posición** (1º `.ds-toggle-button` = razonamiento, 2º = búsqueda), validando el texto contra etiquetas conocidas (`DeepThink|Pensamiento Profundo|深度思考`, `Search|Búsqueda inteligente|…`). Si el texto no coincide con ninguna, no se hace click.
- **Esto pasa a ser regla obligatoria de la implementación**, no una sugerencia: la Tarea 3 ya lo advertía y ahora hay evidencia de que pasa de verdad.

## P3 — "Detener" con la vista oculta ✅

- **Setup:** vista oculta, respuesta larga. Con 346 caracteres ya recibidos (ícono en `stop`), click en el mismo botón.
- **Red:** `POST /api/v0/chat/stop_stream` → **200**. El botón de la PWA dispara una llamada real de cancelación, no solo un cambio en la UI.
- **Stream:** cierra limpio (`loadingFinished`, sin `loadingFailed`) **767 ms** después del click, con **`response/status = "INCOMPLETE"`** (distinto de `FINISHED`). Llegaron 774 caracteres en total: los tokens que ya venían en camino siguen llegando hasta el cierre.
- **Servidor:** guarda la respuesta **parcial** (761 caracteres al recargar la conversación).

**Para la implementación:**
- `cancelTurn()` = click en el botón en estado "detener" (funciona oculto);
- esperar el cierre del stream con `INCOMPLETE`;
- emitir `turn/cancelled { partialText }` con el `RESPONSE` acumulado.

El botón "Detener" de Amatista tiene un efecto real en este runtime.

## P4 — Límite de frecuencia ⚠️ no alcanzado

- **Setup:** 1 chat nuevo, **8 envíos seguidos** ("Respondé solo: OK N"), cada uno apenas terminó el anterior. En total 16,8 s, uno cada ~2,1 s (~29 mensajes/min).
- **Resultado:** los 8 salieron bien (HTTP 200, `FINISHED`, 4 caracteres de respuesta, 270–734 ms cada uno). **No hubo ninguna respuesta de red que no fuera 200.** Ningún aviso, ningún error en el stream, ningún iframe de hCaptcha.
- **Se cortó en 8 a propósito.** Es la cuenta real del usuario y el sistema anti-abuso de DeepSeek v4.1 es nuevo, con señales desconocidas (Tarea 3). Seguir escalando para provocar el límite podría disparar una sanción real sobre la cuenta, justo lo que la Tarea 5 quiere evitar.
- **Lo que queda sin conocer:** el formato exacto del aviso real de límite. El diseño lo cubre sin depender de ese formato. Cualquiera de estas condiciones es un error visible:
  - HTTP distinto de 2xx;
  - `response/status` distinto de `FINISHED`/`INCOMPLETE`;
  - un objeto `{code, msg}` en el stream (el parser ya lo captura);
  - que no aparezca la request `completion`.
  - Si aparece `msg`, se muestra tal cual al usuario.
- **Uso normal del puente** (una persona chateando): queda muy por debajo del ritmo probado.

## P5 — Cuelgue de 60 s ⚠️ no reproducido

- **Esta ronda:** 12 generaciones (P1 ×2, P2, P2b, P3, P4 ×8) con el detector armado. **0 cuelgues.** El stream más largo tardó 2,7 s. Cero salidas por watchdog.
- **En total, desde el único caso:** ~20 generaciones sin que se repita.
- **Lo que se sabe del único caso (4.2):**
  - fue la **primera** corrida concurrente;
  - vista A **visible** + vista B **oculta**;
  - harness **sin** CDP (lectura por DOM);
  - A quedó ~60,7 s en "detener", volvió a "enviar" vacía y la conversación **no** se guardó.
  - Una hipótesis compatible, **no verificada**: un timeout de ~60 s del lado del servidor sobre una generación trabada.
- **Queda documentado como no reproducido.** La implementación lo cubre con el timeout de inactividad (stream abierto sin fragmentos nuevos → click en detener → error honesto), sin importar la causa.

---

# Implementación del puente — opción A con vista-con-sesión (2026-09-23, integrada a master)

Implementa el plan de corrección confirmado por el usuario. La vista vive con la sesión (sin pool) y el panel usa la opción (b): la UI de chat de Amatista es la principal, con el botón "Ver DeepSeek" para mostrar la PWA real.

- **Rama:** `experiment/deepseek-pwa`.
- **Compilación:** `npm run typecheck` y `npm run build` limpios.
- **Tests de regresión:** los 4 nuevos pasan. 4 fallas preexistentes de F0, ajenas a este trabajo (ver `PENDING.md`).

## Arquitectura implementada

| Pieza | Dónde | Qué hace |
|---|---|---|
| Parser del stream | `src/main/deepseek-pwa-stream.ts` (**reusado tal cual** de la fase anterior) | Las 6 reglas THINK/RESPONSE. `describeStreamOutcome()` decide éxito/cancelado/error **solo desde el stream**. |
| Runtime | `src/main/deepseek-pwa-runtime.ts` (reescrito, sin pool) | **Una `WebContentsView` por sesión** (partición `persist:deepseek-pwa`), creada en `connect()` y destruida en `stop()`, mismo ciclo que el navegador embebido. Escribe por DOM (toggles por posición con `textContent`, textarea, enviar/detener) y lee por red (`webContents.debugger` + `Network.streamResourceContent`, `TextDecoder` en modo stream). Lock de envío entre sesiones. `DeltaCoalescer` (120 ms, nunca emite deltas que sean solo espacios). Timeout de inactividad (90 s). Login/captcha: `onNeedsHuman`/`onHumanResolved`, lo resuelve el usuario en el panel. Cero reintentos automáticos. |
| Tipos | `shared/types.ts`, `shared/runtime-for.ts`, `shared/model-capabilities.ts` | `ProviderType`/`RuntimeKind` `'deepseek-pwa'`. `deepseekPwaAcknowledged`. `DEEPSEEK_PWA_DEEPTHINK_EFFORT = 'deepthink'` compartido entre main y renderer. |
| Sesión (F0) | `runtime-state.ts` | `SessionRuntimeState.pwaRuntime`. `disconnectSession()` destruye la vista. `detachPanelFromChat()` la oculta. Tope = `MAX_CONCURRENT_SESSIONS` (8), común a todos los runtimes. |
| Turno | `ipc-agent.ts` → `dispatchTurnForWindow()` | Camino propio, callback por turno (sin `wire*`). `item/agentMessage/delta` en vivo, `item/toolCall/status` "Pensamiento profundo (DeepThink)" (pausa el watchdog mientras razona), `item/completed` como reemplazo final, `turn/completed`. Al cancelar: `item/completed` con el parcial + marca, y `turn/cancelled` sin `partialText`, para no duplicar el mensaje. Guarda `remote_session_id`. Primer mensaje de una conversación nueva: persona + resumen acotado del historial, como texto (sin el system prompt de Amatista, que describe tools que este runtime no tiene). |
| Conexión | `ipc-agent.ts` → `connectSessionForWindow()` | **Guard de main:** rechaza sin `deepseekPwaAcknowledged`, antes de cualquier efecto. `pwaRuntime` se asigna **antes** de `connect()`, para que "Ver DeepSeek" funcione durante el login. Avisos al panel (`deepseek-pwa/needsHuman`/`humanResolved`) y notificación del SO si el chat no está a la vista. IPC `deepseekPwa:setView` (solo el panel que muestra el chat). |
| Persistencia | `chat-store.ts` | Columna `remote_session_id` + `getChatRemoteSessionId`/`setChatRemoteSessionId`. |
| Settings | `settings-store.ts`, `ipc-settings.ts` | Flag persistido (plano), clasificado como `'renderer'`. Main no confía solo en eso: vuelve a chequear al conectar. |
| UI | `App.tsx`, `main.css`, preload | **La advertencia completa vive solo en Configuración** (sección "DeepSeek via PWA", mismo patrón que `computerUseAcknowledged`): ToS 3.5(3), posible suspensión, chat sin herramientas, aceptación explícita una vez. Botón "DeepSeek PWA" **solo** con el flag en `true`. Chequeo en `readiness()`. Selector de esfuerzo "DeepThink: apagado / Pensamiento profundo (DeepThink)". En el chat, **solo un recordatorio mínimo** de una línea ("DeepSeek PWA · sin herramientas") con el botón **Ver/Ocultar DeepSeek** (ajuste de UI del 2026-09-23: sin texto de advertencia en el chat). Contenedor con `ResizeObserver` (mismo mecanismo que el navegador embebido). |

## Verificación real (build real de Amatista, `AMATISTA_STORAGE_ROOT` temporal, CDP del renderer + `--inspect` de main)

El login lo hizo el usuario **a mano** en el panel ("Ver DeepSeek" se abrió solo). Después hubo 5 reinicios reales de la app sin volver a pedir login. Solo prompts inocuos nuevos, sin tocar los chats originales. La carpeta temporal (incluida la sesión de prueba) se borró al terminar; cero procesos colgados.

| # | Punto | Resultado real |
|---|---|---|
| 1 | Turno de punta a punta con streaming en vivo | ✅ El mensaje crece **en vivo en el chat de Amatista** con el turno activo: 125 → 261 → 357 → … → 1.369 caracteres en ~1,3 s. Final: 1.801, correcto (lista 1-15 sobre océanos), un único mensaje. Medido de dos formas (muestreo CDP y `MutationObserver` dentro de la página), que coinciden. |
| 2 | Cancelar real | ✅ Detener de Amatista: el turno cierra en **574 ms** en la UI. Main: `click en detener=true`, `status=INCOMPLETE`, `cancelado=true`. Parcial conservado con "[Detenido por el usuario]", **sin mensaje duplicado**. |
| 3 | 2 chats simultáneos en 2 paneles | ✅ Segundo panel con el botón real "⧉ Panel" (hereda la conexión). **2 vistas reales vivas** (una por sesión), los 2 turnos activos **al mismo tiempo**, conversaciones remotas distintas. Ríos vs. desiertos, sin mezcla. |
| 4 | "Pensamiento Profundo" desde la UI | ✅ Selector en DeepThink: el panel muestra "Pensamiento profundo (DeepThink)" mientras razona. Respuesta final **solo "1081"** (el razonamiento no se filtra al mensaje). El paso queda registrado aparte. Main: `thinking_enabled=true` (confirmado por el propio stream), 58 caracteres de razonamiento, 4 de respuesta. |
| 5 | La sesión sobrevive un reinicio real | ✅ Tras reiniciar: conecta **sin pedir login**. La conversación remota `77fbe85a…` es la misma antes y después, y DeepSeek responde "Océanos" (el tema de la primera lista, pedida antes de los reinicios). |
| 6 | Error real → mensaje honesto | ✅ `AMATISTA_DEEPSEEK_PWA_SIMULATE=unrecognized-stream` → "DeepSeek cambió el formato de su respuesta y el puente no lo reconoce… No se muestra texto a medio interpretar", sin mensaje de asistente agregado. `=http-500` → "DeepSeek respondió HTTP 500.", sin mensaje agregado. |
| 7 | Guard doble de `deepseekPwaAcknowledged` | ✅ **UI:** sin aceptar, la grilla de "Agregar conexión" (11 botones) no tiene "DeepSeek PWA"; tras aceptar con click real, aparece. **Main:** conexión inyectada a mano + `connectAgent` por IPC directo (UI esquivada) → **rechazado** con el texto de la advertencia, y **ninguna vista de DeepSeek creada**. La advertencia real cita el art. 3.5(3) y la posible suspensión; el flag queda persistido. Nota: en un primer arranque el flag es `undefined` (falsy, bloquea igual), mismo comportamiento que `computerUseAcknowledged`/`browserControlAcknowledged`. |

## Permisos denegados en la partición (cierre de hueco antes de integrar, 2026-09-23)

Al traer `39a5b25` (el fix del navegador embebido) apareció el mismo hueco en `persist:deepseek-pwa`: sin handlers de permisos, Electron concede **solos** notificaciones y geolocalización. Se agregaron los mismos handlers que deniegan todo (`setPermissionRequestHandler`/`setPermissionCheckHandler`) en `DeepSeekPwaRuntime.connect()`.

**Verificación real:**

| Prueba | Resultado |
|---|---|
| Control genérico (página local, sin red): partición `persist:` **sin** handlers vs **con** los del fix | Sin handlers: `granted` ×3 (consulta y pedido de notificaciones, geolocalización). Con los handlers: `denied` ×3. |
| App real, carpeta temporal nueva, **login real del usuario** con los permisos ya denegados | El login (con Google) funcionó y el chat quedó conectado. |
| **Dentro de la vista real de DeepSeek conectada** (target CDP; solo el estado de los permisos, nada de la página) | `notifications` query `denied`, `Notification.requestPermission()` `denied`, `Notification.permission` `denied`, `geolocation` query `denied`, sin preguntar. |
| Turno real por la UI con los permisos denegados | Streaming en vivo intacto (121 → 742 caracteres con el turno activo), `FINISHED`. |

## Bugs reales encontrados y corregidos durante la verificación

1. **Falso positivo de captcha** (runtime). La heurística "script `awswaf` presente y sin `textarea`" se disparó en la carga inicial: el script de AWS WAF está en **todas** las páginas de DeepSeek. Así, un login se tomaba por captcha, y "ya no hay captcha" se tomaba por resuelto. Arreglo: captcha solo con evidencia fuerte (iframe de hCaptcha), y reevaluación del estado real después de cada intervención (máximo 3 rondas).
2. **Posible recursión infinita** en `loadConversation()` (encontrada en revisión, antes de ejecutarse). Recargar al caer en `/` después de un login habría entrado en bucle si la conversación remota ya no existe. Arreglo: la recarga ocurre solo si hubo intervención humana.
3. **Etiquetas de los toggles vacías en una vista oculta desde el inicio** (runtime). `innerText` depende del layout renderizado: tras reconectar daba `["",""]` y el envío fallaba (con un mensaje honesto, pero fallaba). Arreglo: `textContent`.
4. **El botón "Detener" desaparecía con el primer delta** (renderer, **código compartido de la app**). `appendAssistantMessage()` llamaba siempre a `clearTurnWatch()`: para la UI, cualquier texto del asistente cerraba el turno. Los runtimes API/CLI no lo notaban porque mandan un único delta seguido de `turn/completed`. Arreglo mínimo: parámetro `endsTurn` (default `true`, sin cambios para todos los demás llamadores); los deltas de streaming pasan `false` y refrescan el watchdog (igual que ya hacía el branch Codex). **Verificado que todos los emisores de deltas** (API, CLI, DeepSeek) **cierran el turno después** con `turn/completed`/`turn/cancelled`. Diagnosticado con evidencia: main enviaba los deltas en vivo (cada ~125 ms, `webContents.send` interceptado vía `--inspect`) y el renderer los recibía en 1–2 ms; lo que se cortaba era el estado del turno.
5. **Contenido de respuestas no-2xx transmitido en vivo** (runtime). Con la simulación HTTP 500, el texto llegaba antes que el error. Arreglo: el status HTTP se conoce desde el primer byte, y una respuesta no-2xx nunca se reenvía a la UI.

## Límites honestos

- **Captcha/hCaptcha real:** no se pudo provocar sin arriesgar la cuenta. El flujo (aviso + vista en el panel + espera + reevaluación) está implementado y se ejercitó con el login real, que usa el mismo mecanismo. La detección de captcha por iframe de hCaptcha no se observó en vivo.
- **Límite de frecuencia real:** mismo caso que en P4. Cualquier status no-2xx, `{code,msg}` o status raro del stream se muestra tal cual (probado con la simulación HTTP 500).
- **La simulación de error** (`AMATISTA_DEEPSEEK_PWA_SIMULATE`) es un hook opt-in, inerte sin la variable, con el mismo patrón que `AMATISTA_MAIN_BACKSTOP_MS`. En esas corridas el mensaje real igual llegó a DeepSeek (prompt inocuo); lo simulado fue la respuesta.
