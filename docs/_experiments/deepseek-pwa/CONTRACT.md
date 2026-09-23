# CONTRACT.md — Experimento: automatización de la PWA de DeepSeek con sesión real

> **Experimento aislado, riesgo real de violar ToS de DeepSeek, decisión consciente del usuario — NO integrado a la app principal hasta validación completa.**
>
> Nada de este experimento vive en `docs/_arch/` ni en `src/`. Estado actual: **investigación de viabilidad únicamente** — cero cambios en `tool-registry.ts` ni en ninguna otra parte de la app.

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
