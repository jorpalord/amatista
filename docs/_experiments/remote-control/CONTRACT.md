# CONTRACT.md — Remote Control, Fase 0: ver y seguir los chats desde el teléfono

> Rama `experiment/remote-control`, creada desde `master` (`4996703`, v0.15.2).
> - **Diseño:** §0–§7.
> - **Parte 1 implementada y verificada (2026-09-25):** el puente de red del lado de Amatista, ver §8. Sin commit.
> - **Parte 2 implementada y verificada en emulador (2026-09-25):** la app nativa de Android (`android/remote-viewer/`), ver §9. Sin commit. **Falta la prueba con un teléfono físico** (§9.6).
> Base: `docs/_arch/verify_android_access_design.md` (ruta B, §2B y §4). Alcance de F0: **solo lectura**. Ver mensajes, ver el estado de los turnos y recibir avisos. **Nunca** mandar, cancelar, aprobar ni cambiar nada; eso es de una fase posterior.
> Toda afirmación sobre el código cita archivo y línea de `master`. Toda afirmación externa cita la documentación oficial.

## 0. Resumen de decisiones

| Tarea | Decisión propuesta |
|---|---|
| **1 — Transporte** | ~~Tailscale + `tailscale serve`~~ **Revisado en §1.4:** el usuario no acepta `serve`, porque su certificado público de Let's Encrypt publica el nombre de la PC en los registros de Certificate Transparency. **Nueva propuesta:** red privada de Tailscale **sin `serve` y sin la función de HTTPS de Tailscale**; Amatista sirve HTTPS con **su propio certificado autofirmado** en la IP de Tailscale de la PC, y el teléfono fija (pinning) **ese** certificado con el hash que recibe por el QR. **Condición: el cliente del teléfono pasa de PWA a una app nativa chica**, porque un navegador no puede hacer pinning. Hay alternativas sin Tailscale (§1.4.3). El canal sigue siendo **HTTP GET + Server-Sent Events**, sin endpoints de escritura salvo el de emparejamiento. |
| **2 — Lista blanca** | **2 de los 62 canales IPC**, y solo como lectura con datos filtrados: `chats:load` y `projects:list`. Los otros **60 no**. Del lado de eventos: los 6 canales de sesión y la actividad en segundo plano, como flujo de solo lectura. **No se reenvía el IPC genérico:** se construye una API nueva, chica y explícita, que llama a las mismas funciones internas. |
| **3 — Multi-observador** | **Un registro aparte `remoteObservers` (mapa por chat), no un segundo campo en la sesión, y `visiblePanelId` intacto.** `visiblePanelId` tiene unos 20 usos con efectos (Familia A, notificaciones, badge, orquestación, vistas) que el teléfono **no** debe activar. El reparto se engancha en un solo punto (`sendToChatWindow`), lee el `eventLog` sin consumirlo y usa números de secuencia para reanudar. |
| **4 — Emparejamiento y seguridad** | **Desactivado por defecto**, con doble consentimiento igual que Familia A. El QR lleva un código de un solo uso (128 bits, 2 minutos, en el fragmento `#` de la URL, nunca en la query). La PC pide confirmar con un código corto que se muestra en ambas pantallas. El token de dispositivo es de 256 bits y la PC guarda **solo su hash**. La revocación corta los streams en el acto. Hay un indicador visible en la PC, un registro de auditoría y un modelo de amenazas explícito (§4.1). |

## 1. Tarea 1 — Transporte

### 1.1 Cómo lo resuelve Claude Code (evidencia pública)

De la documentación oficial de Remote Control ([code.claude.com/docs/en/remote-control](https://code.claude.com/docs/en/remote-control.md)):

- *"Your local Claude Code session makes outbound HTTPS requests only and never opens inbound ports on your machine. When you start Remote Control, it registers with the Anthropic API and polls for work. When you connect from another device, the server routes messages between the web or mobile client and your local session over a streaming connection."*
- *"All traffic travels through the Anthropic API over TLS … The connection uses multiple short-lived credentials, each scoped to a single purpose and expiring independently."*
- Si se corta la red, la sesión encola mensajes y aprobaciones hasta reconectar. Además, *"Local process must keep running"*.
- El emparejamiento es por la cuenta de claude.ai, con una URL de sesión o un QR.

**Conclusión:** es un **relé operado por Anthropic**. La PC solo abre conexiones salientes y el servidor de Anthropic enruta los mensajes. No hay documentación de que terceros puedan usar ese relé. **Para Amatista, copiar ese modelo significa operar un servidor propio.**

### 1.2 Opciones evaluadas

| Opción | Cómo | Puertos entrantes en la PC/router | Quién puede ver el contenido | Instalar en el teléfono | Trabajo en Amatista | Veredicto para F0 |
|---|---|---|---|---|---|---|
| **a) Red privada en malla (Tailscale)** + `tailscale serve` | PC y teléfono en la misma red privada; `serve` hace de proxy HTTPS hacia `127.0.0.1:<puerto>` | **Ninguno** | Nadie más: cifrado WireGuard de punta a punta y TLS dentro de la red | App de Tailscale | Mínimo: servidor HTTP local + autenticación propia | **✅ Recomendada** |
| b) WireGuard "a mano" | Túnel propio | Un puerto UDP abierto en el router, o un servidor intermedio propio | Nadie más | App de WireGuard | Igual que (a) | ❌ más configuración (NAT, claves, IP pública) sin ganancia de seguridad sobre (a) |
| c) **Relé propio** (como Claude Code) | La PC abre una conexión saliente a un servidor propio en internet; el teléfono se conecta a ese servidor | Ninguno | El relé, salvo que se agregue cifrado de punta a punta propio | Nada (navegador) | **Grande:** servidor público, sus credenciales, cifrado de punta a punta, operación y costo mensual | ⏳ fase posterior, si se quiere evitar la VPN o el tercero |
| d) Túnel saliente con autenticación en el borde (p. ej. Cloudflare Tunnel + Access) | Nombre público protegido por identidad en el proveedor | Ninguno | **El proveedor** (termina TLS en su borde) | Nada | Medio | ⚠️ no investigado a fondo; expone un nombre público y el contenido pasa descifrado por un tercero |
| e) Solo red local (misma Wi-Fi) | Servidor en la IP de la red local | El servidor escucha en la red local | Cualquiera en esa Wi-Fi, si no hay TLS | Nada | Medio: TLS con certificado propio | ❌ sin HTTPS válido no hay PWA ni service worker, y el token viajaría expuesto en redes compartidas |

### 1.3 Recomendación para F0: (a), con estas reglas

1. **Amatista nunca escucha fuera de loopback.** El servidor se ata a `127.0.0.1:<puerto>`, nunca a `0.0.0.0` ni a la IP de la red privada. Lo expone `tailscale serve`, que según la documentación oficial *"lets you route traffic from other devices on your Tailscale network to a local service running on your device"*, con el ejemplo de un servidor en `http://127.0.0.1:3000` ([Tailscale Serve](https://tailscale.com/kb/1312/serve)). El contenido queda **solo dentro de la red privada**; lo público es Funnel, que **queda explícitamente fuera**: el diseño debe advertir si se detecta.
2. **HTTPS válido** en el nombre MagicDNS de la máquina (`<maquina>.<red>.ts.net`, Let's Encrypt), habilitado una vez en la consola de Tailscale ([HTTPS en Tailscale](https://tailscale.com/kb/1153/enabling-https)). Es necesario para la PWA (instalable, con service worker) y para Web Push en fases posteriores. **Advertencia de privacidad documentada:** el nombre de la máquina queda publicado en los registros públicos de certificados (*"Do not enable the HTTPS feature if any of your machine names contain sensitive information"*). Hay que usar un nombre neutro.
3. **La red privada no reemplaza la autenticación propia.** Cualquier proceso de la propia PC puede hablarle a `127.0.0.1:<puerto>`, incluidos malware u otras cuentas de usuario, y cualquier otro dispositivo de la red privada llega al servicio. **El token de dispositivo (§4) es la autenticación real.** Los encabezados de identidad que agrega `serve` (`Tailscale-User-Login`) sirven como **señal secundaria** (registrar y, si el usuario quiere, exigir que coincida con su login), nunca como autenticación: un proceso local los puede falsificar hablándole directo a loopback.
4. **Protocolo de F0 = solo lectura por construcción:**
   - `GET` para las fotos del estado (lista de chats, mensajes guardados);
   - **un stream servidor → teléfono con Server-Sent Events**, leído con `fetch` y `Authorization` en el encabezado (el `EventSource` nativo no permite encabezados), con `id:` por evento para reanudar;
   - el único método que no es `GET` es `POST /pair`, activo solo mientras está abierta la ventana de emparejamiento.

   **No hace falta WebSocket en F0:** que funcione a través de `tailscale serve` **no está documentado**, mientras que SSE es HTTP común. Queda para cuando exista control (F1), verificándolo antes.
5. **Amatista no administra Tailscale en F0.** El usuario lo instala y corre `tailscale serve` una vez, siguiendo instrucciones que muestra la propia pantalla de "Acceso remoto". Amatista solo comprueba que se llega a su puerto a través del nombre `.ts.net`.

> **§1.3 reemplazada por §1.4.** Los puntos 1, 2 y 5 dependían de `tailscale serve` y de su certificado público. Los puntos 3 (la red no reemplaza la autenticación propia) y 4 (solo lectura por construcción, SSE sin WebSocket) **siguen vigentes**.

### 1.4 Revisión: sin `tailscale serve` y sin certificados públicos

**Motivo:** el usuario no acepta que el nombre de la PC quede en los registros públicos de Certificate Transparency. La propia documentación de Tailscale lo advierte: *"Do not enable the HTTPS feature if any of your machine names contain sensitive information"* ([HTTPS en Tailscale](https://tailscale.com/kb/1153/enabling-https)).

#### 1.4.1 Tarea 1 — Hipótesis: Tailscale sin `serve` + HTTPS propio autofirmado + pinning en el teléfono

**Parte 1 — Tailscale sin `serve` ni certificados públicos: ✅ viable (documentado).**

- **Los certificados son opcionales.** Para tenerlos hay que habilitar MagicDNS y **"Enable HTTPS"** en la consola, **reconocer que los nombres se publican** y correr `tailscale cert` en cada dispositivo ([HTTPS en Tailscale](https://tailscale.com/kb/1153/enabling-https)). **Si nunca se habilita, no se pide ningún certificado público ni hay entrada en los registros de CT.**
- **La red privada funciona igual sin eso.** Cada dispositivo tiene una IP del rango `100.64.0.0/10` ([IPs 100.x](https://tailscale.com/kb/1015/100.x-addresses)) y un nombre MagicDNS `<maquina>.<red>.ts.net` ([MagicDNS](https://tailscale.com/kb/1081/magicdns)).
- **El tráfico entre dispositivos va cifrado de punta a punta con WireGuard.** *"only the two nodes that are communicating with each other are able to encrypt or decrypt packets"*, y los relés DERP *"blindly forward already-encrypted traffic"* ([How Tailscale works](https://tailscale.com/blog/how-tailscale-works)). La coordinación de Tailscale conoce **metadatos** (nombres e IPs de los dispositivos), no el contenido. Es un tercero, pero no hay nada **público**.
- **Amatista escucharía en la IP de Tailscale de la PC** (atada a esa IP concreta, nunca a `0.0.0.0`), así que no queda expuesta en la Wi-Fi ni en otras interfaces. Detalles para la implementación:
  - esa IP solo existe con Tailscale activo: hay que reintentar la escucha si no está;
  - hay que detectar si la IP cambia.
- **Qué se pierde respecto de `serve`:** el HTTPS con certificado válido. El problema pasa entero al lado del teléfono.

**Parte 2 — HTTPS autofirmado con pinning: depende de qué cliente se use en el teléfono.**

| Cliente del teléfono | ¿Pinning real del certificado de la PC? | Evidencia | Consecuencia |
|---|---|---|---|
| **PWA en Chrome** (lo planeado en §2) | ❌ **No.** La plataforma web no tiene API de pinning. Un certificado autofirmado muestra la pantalla de error. **El service worker no se registra** (*"An SSL certificate error occurred when fetching the script"*) y la PWA no se puede instalar | [w3c/ServiceWorker#1514](https://github.com/w3c/ServiceWorker/issues/1514), [test con certificados propios](https://deanhume.com/testing-service-workers-locally-with-self-signed-certificates/) | No sirve tal cual |
| PWA + instalar el certificado de la PC como CA **en el almacén de usuario de Android** | ⚠️ **Posible, pero no es pinning.** Según el FAQ de la Chrome Root Store, en TLS sobre TCP el verificador de Chrome *"considers local trust decisions for both adding and removing trust"*, así que se esperaría que funcione (**no verificado en Android**; las fuentes de segunda mano se contradicen). **Es confianza a nivel de todo el dispositivo:** lo que firme esa clave pasa a ser de confianza. Android muestra un aviso permanente de red supervisada. Si la clave de la PC se filtra, sirve para interceptar el tráfico del teléfono, salvo restricciones de nombre, cuyo cumplimiento en Chrome Android tampoco verifiqué | [FAQ Chrome Root Store](https://github.com/chromium/chromium/blob/main/net/data/ssl/chrome_root_store/faq.md), [Android: network security config](https://developer.android.com/privacy-and-security/security-config) | **No recomendado:** agranda la superficie de ataque del teléfono entero |
| **App nativa chica** (Kotlin, o Capacitor con la misma interfaz web) | ✅ **Sí.** Android permite confiar en un certificado autofirmado para un dominio (`<trust-anchors>`) y fijar el **hash SHA-256 de la clave pública**: *"Certificate pinning is done by providing a set of certificates by hash of the public key (SubjectPublicKeyInfo…)"*. Como el certificado lo genera cada PC, la app lo fija **en tiempo de ejecución**: el QR lleva el hash y la app solo acepta esa clave, con un verificador propio (o, en un WebView, con `onReceivedSslError` que continúa **solo** si el hash coincide) | [Android: network security config](https://developer.android.com/privacy-and-security/security-config) | **Cumple la hipótesis tal cual.** El cliente pasa de PWA a APK instalado a mano, sin Play Store. Las notificaciones pasan a ser nativas. Android Studio, SDK y NDK **ya están instalados** en esta PC (visto en la investigación de nodejs-mobile) |
| Navegador + **HTTP simple dentro del túnel** (sin TLS propio) | No hace falta: WireGuard ya cifra y autentica a los extremos | [How Tailscale works](https://tailscale.com/blog/how-tailscale-works) | F0 funciona en cualquier navegador, pero **sin PWA instalable, sin service worker, sin Web Push y sin WebCrypto** (`crypto.subtle` exige contexto seguro), así que se pierde la alternativa de clave no extraíble. **Riesgo:** `100.64.0.0/10` también es el rango de NAT compartido de los operadores; si Tailscale está apagado, una IP 100.x podría llegar a otro equipo de la red del operador y **el token viajaría en claro**. Mitigación: usar solo el nombre MagicDNS, que sin Tailscale no resolvería (**a verificar**). Aceptable como prototipo de F0, **no para el control de F1** |

**Veredicto de la Tarea 1:** la hipótesis **se sostiene con un cliente nativo**: Tailscale sin `serve`, HTTPS autofirmado de Amatista en la IP de Tailscale y pinning del hash de la clave recibido por QR en una app Android chica. **Con una PWA en el navegador no hay pinning posible.**

#### 1.4.2 Cómo cambia el emparejamiento con pinning (mejora la seguridad)

- **Contenido del QR:** ya no es una URL. Es un dato para la app, por ejemplo `amatista-pair:v1` con **dirección** (IP o nombre de Tailscale, o IP de la red local según la opción), **puerto**, **hash SHA-256 de la clave pública del certificado de la PC** y el **código de un solo uso**.
- **Pinning antes del código:** la app **verifica el hash del certificado antes de mandar el código**. Un intermediario ni siquiera llega a ver el código de emparejamiento.
- **Credencial más fuerte:** en una app nativa, la clave no extraíble de §4.2 puede vivir en el **Keystore de Android** (respaldado por hardware en la mayoría de los teléfonos), más fuerte que WebCrypto en un navegador.
- **El certificado de la PC:** lo genera Amatista la primera vez que se activa el acceso remoto. La clave privada se guarda en `config/`, protegida con el mismo `safeStorage` que las API keys. Si se regenera, todos los dispositivos tienen que volver a emparejarse (efecto de revocación global).

#### 1.4.3 Tarea 2 — Alternativas sin Tailscale

| Opción | Cómo | Terceros | Qué queda público | Complejidad | Límites |
|---|---|---|---|---|---|
| **Solo la misma Wi-Fi** | Amatista escucha en la IP de la red local, con HTTPS autofirmado y la **misma app nativa con pinning**. El QR lleva IP, puerto, hash y código | **Ninguno** | **Nada** | **Baja** | Solo funciona en casa. Todos los dispositivos de la Wi-Fi llegan al puerto (el token y el pinning lo cubren). **HTTP simple en la red local, no:** la Wi-Fi no protege del resto de los dispositivos de la misma red |
| **WireGuard directo** (apps oficiales, sin servidor de coordinación) | La PC hace de extremo WireGuard. La configuración del teléfono **se importa por QR** con la app oficial (*"Scan from QR code"*). Encima, lo mismo: HTTPS autofirmado y la app con pinning | **Ninguno** | **Un puerto UDP abierto en el router** y, si la IP de tu casa cambia, **un nombre de DNS dinámico** que apunta a ella. El puerto no se delata: *"the server does not even respond at all to an unauthorized client; it is silent and invisible"* | Media: reenvío de puerto, DNS dinámico, WireGuard para Windows | **No funciona si tu proveedor usa NAT compartido (CGNAT)** y no tenés IP pública; ahí haría falta un servidor intermedio. No atraviesa NAT solo, como Tailscale |
| Headscale (servidor de coordinación de Tailscale autoalojado) | Mismas apps de Tailscale, con un servidor de coordinación propio | Ninguno (lo operás vos) | El nombre del **servidor de coordinación** (que sí necesita su propio certificado público), no el de la PC | Alta: servidor en internet, dominio y mantenimiento | Conserva el atravesado de NAT de Tailscale |
| Cloudflare Tunnel + Access | Túnel saliente y nombre público protegido por identidad | **Cloudflare, que termina TLS y ve el contenido** | Un nombre público en tu dominio (con su certificado de borde) | Media | Choca con la preferencia de no publicar nombres y pone un tercero en medio del contenido. **No recomendado** |
| Relé propio | §1.2 (c) | — | — | Alta | Fase posterior |

Fuentes de esta tabla: [protocolo de WireGuard](https://www.wireguard.com/protocol/), [WireGuard](https://www.wireguard.com/) (*cryptokey routing*), [importar por QR en Android](https://www.vpnsmith.com/en/blog/wireguard-android-setup), [wireguard-android: importar QR](https://git.zx2c4.com/wireguard-android/commit/?id=0bd39309c8ba839191684d5d34c247c0af7b42aa).

#### 1.4.4 Recomendación revisada (para que decida el usuario)

**La pieza común a todas las opciones buenas es la app nativa con pinning.** Con ella, el transporte pasa a ser un detalle intercambiable:

1. **Recomendada: Tailscale sin `serve` + HTTPS autofirmado + app nativa con pinning.** No queda **nada público**, funciona fuera de casa y no se abren puertos. Costo de privacidad: Tailscale (la empresa) conoce los nombres y las IPs de tus dispositivos; no es público, pero es un tercero.
2. **Sin ningún tercero: solo la misma Wi-Fi**, con la misma app. Es el primer paso más simple y privado. Si más adelante querés acceso fuera de casa, **WireGuard directo**, si tu proveedor te da IP pública.
3. **Más simple pero más débil:** Tailscale + HTTP en el navegador, sin app. Solo como prototipo de F0, **nunca para F1** (control).

**Impacto en el tamaño de F0 (§5):**
- el cliente pasa de PWA (300–400 líneas) a **app nativa** (Capacitor con la interfaz web más pinning nativo: ≈ 450–700; o Kotlin puro: ≈ 700–1.000), más el certificado propio de la PC (≈ 80–150);
- F0 queda en **≈ 1.450–2.150 líneas de producción + 700–1.000 de verificación ≈ 4–6 jornadas**, con la opción de Capacitor.

## 2. Tarea 2 — Lista blanca de canales para F0 (solo lectura)

### 2.1 Principio: no se reenvía el IPC, se construye una API nueva y chica

Exponer los canales IPC tal cual heredaría supuestos pensados para una interfaz local y confiable. Dos ejemplos del código actual:
- **`settings:get` devuelve el objeto `settings` completo** (`ipc-settings.ts:47`) **con las API keys ya descifradas**: `settings-store.ts:194`, `apiKey: decryptSecret(provider.encryptedApiKey)`.
- **`agent:attach` no es una lectura:** fija `visiblePanelId` y **vacía el `eventLog`** (`runtime-state.ts:475-478`).

Por eso la lista blanca se define como **qué funciones internas se pueden ofrecer como lectura, con qué filtrado de datos**, a través de endpoints nuevos.

### 2.2 Los 62 canales IPC, uno por uno

| Archivo | Canal | ¿F0? | Motivo |
|---|---|---|---|
| `ipc-chats.ts` (9) | **`chats:load`** | **Sí, filtrado** | Es el objetivo de F0. Se filtra: los adjuntos van **sin `path` (ruta local) ni `text` (contenido extraído)**, solo nombre, tipo y tamaño; **sin `workspacePath`** (solo el nombre del proyecto) |
| | `chats:ensureSession`, `chats:renameSession`, `chats:deleteSession`, `chats:restoreSession`, `chats:purgeSession`, `chats:saveMessage`, `chats:deleteMessagesFrom` | No | Escriben o borran |
| | `chats:listDeleted` | No | Es lectura, pero la papelera no hace falta en F0 (minimización) |
| `ipc-projects-workspace.ts` (8) | **`projects:list`** | **Sí, filtrado** | Para agrupar chats por proyecto. Solo **nombre** del proyecto, sin ruta |
| | `projects:addRoot`, `projects:removeRoot`, `workspace:open`, `workspace:saveFile` | No | Escriben (`workspace:open` cambia `activeProjectPath`; `addRoot` abre un diálogo nativo) |
| | `workspace:readFile` | **No** | Leer archivos arbitrarios del proyecto sería **exfiltración** si el teléfono o el token se ven comprometidos |
| | `workspace:refresh`, `workspace:default` | No | Árbol de archivos y rutas de la PC: exposición innecesaria en F0 |
| `ipc-agent.ts` (17) | `agent:connect`, `agent:send`, `agent:reply`, `agent:cancel`, `agent:disconnect`, `chat:disconnect` | No | Control de sesiones y turnos (fase posterior) |
| | `agent:toolApproval:respond`, `agent:toolTrust:disable` | **No** | Aprobaciones y confianza: **nunca en F0** |
| | `agent:computerUse:set`, `agent:browserControl:set` | **No** | Familia A y navegador |
| | `agent:planMode:enable`, `agent:planMode:disable` | No | Cambian el modo |
| | `agent:attach`, `agent:detach` | **No** | Fijan o liberan `visiblePanelId` y **consumen el `eventLog`**. El teléfono usa una operación nueva y no destructiva (§3) |
| | `deepseekPwa:setView`, `browser:setBounds`, `panel:openAndConnectResponse` | No | Vistas y paneles de escritorio |
| `ipc-settings.ts` (3) | `settings:get` | **No** | **Devuelve las API keys descifradas** |
| | `settings:save`, `settings:resetLocalState` | **No** | Escriben o borran la configuración |
| `ipc-cli.ts` (10) | `cli:installClaude`, `cli:installAntigravity`, `auth:openCliLogin`, `codex:login`, `codex:logout` | **No** | Instalan, abren el navegador en la PC o cambian la sesión de una cuenta |
| | `cli:status`, `codex:accountRead` | No | Rutas y datos de cuenta; innecesarios |
| | `codex:modelList`, `models:refreshClaude`, `models:refreshAntigravity` | No | Lanzan procesos o llamadas con credenciales (costo y efectos secundarios) |
| `ipc-openai-chat-catalog.ts`, `ipc-foundry-catalog.ts`, `ipc-gemini-catalog.ts` (3) | `openaiChat:listModels`, `foundry:listModels`, `gemini:listModels` | No | Llamadas salientes con las API keys |
| `ipc-attachments.ts` (4) | `attachments:pick`, `attachments:fromPaths` | No | Diálogo nativo y lectura de rutas locales |
| | `attachments:fromDataUrl` | No | Escribe; será útil en F1 para subir desde el teléfono |
| | `attachments:previewImagePath` | **No** | Devuelve una imagen de **cualquier ruta local**: vector de exfiltración |
| `ipc-mcp.ts` (3) | `mcp:status`, `mcp:openOrCreate`, `mcp:configureMarkitdown` | No | Configuración y editor en la PC |
| `ipc-agents-md.ts` (2) | `agentsMd:status`, `agentsMd:openOrCreate` | No | Idem |
| `ipc-window.ts` (3) | `window:getFullscreen`, `window:setFullscreen`, `window:openExternal` | No | Ventana de escritorio / abre enlaces en la PC |

**Total: 2 sí (filtrados), 60 no.**

### 2.3 Eventos del proceso principal hacia la interfaz

| Canal (origen) | ¿F0? | Cómo |
|---|---|---|
| `agent:event` (`sendToChatWindow`) | **Sí** | Métodos `turn/started`, `turn/completed`, `turn/cancelled`, `item/agentMessage/delta`, `item/toolCall/status`, `item/usage/update`, `deepseek-pwa/needsHuman`, `deepseek-pwa/humanResolved`. Los resultados de tools se **recortan** a un tamaño máximo (el contenido completo queda en la PC) |
| `agent:toolApproval` | **Sí, como aviso** | "Hay una aprobación pendiente **en la PC**: <título>". **Sin el `id` de respuesta** (no existe forma de responder en F0). El detalle lo decide el usuario (§6) |
| `agent:planMode`, `agent:toolTrust`, `agent:computerUse`, `agent:browserControl` | **Sí, como estado** | Indicadores en solo lectura. Es importante poder ver desde el teléfono que **Familia A está activa en la PC** |
| `background:activity` (`sendToShell`, `runtime-state.ts:427`) | **Sí, recalculado** | El de la PC excluye los chats visibles (`runtime-state.ts:420`). Para el teléfono se calcula aparte: **todo** chat con `turnInFlight`, esté o no en un panel |
| `panel:openAndConnectRequest` (`cross-window-messaging.ts:81`), `window:fullscreenChanged` | No | Mecánica de paneles de escritorio |
| `chat:incomingMessage` (`cross-window-messaging.ts:157`, directo al panel) | No como evento | El mensaje ya lo guarda el proceso principal (`cross-window-messaging.ts:133`), así que el teléfono lo ve por la base. El aviso en vivo queda para después |

### 2.4 API de F0 propuesta (5 endpoints, 1 solo de escritura: el emparejamiento)

| Método y ruta | Devuelve | Función interna |
|---|---|---|
| `POST /api/v0/pair` | token del dispositivo (una sola vez) | nueva (§4.2); **solo con la ventana de emparejamiento abierta** |
| `GET /api/v0/me` | id y nombre del dispositivo, permisos `['read']` | nueva |
| `GET /api/v0/chats` | lista filtrada: id, título, nombre del proyecto, fecha de actualización, `turnInFlight`, `startedAt` | `loadChatSnapshot()` + `sessionRegistry` |
| `GET /api/v0/chats/:id/messages?after=<messageId>` | mensajes guardados, filtrados | `getMessagesAfter()` (`chat-store.ts:726`) |
| `GET /api/v0/stream` (SSE) | eventos de los chats observados + actividad + avisos, cada uno con `seq` | nueva (§3) |

**Hueco real encontrado: el historial "en vuelo".** Los mensajes **los guarda la interfaz**: el único `saveChatMessage` del proceso principal fuera del IPC es el de mensajes entre ventanas (`cross-window-messaging.ts:133`). Un turno que corre **sin ningún panel de la PC mirándolo** queda solo en el `eventLog` hasta que un panel de la PC se engancha, lo reproduce y lo guarda. En F0 el teléfono combina tres fuentes:
1. los mensajes guardados en la base;
2. una **copia de solo lectura** del `eventLog` (sin consumirlo; §3);
3. los eventos en vivo.

Se deduplican por id. **Mover el guardado al proceso principal** cerraría el hueco de raíz, pero toca el flujo central de F0: queda como decisión aparte (§6, `PENDING.md`).

## 3. Tarea 3 — Multi-observador por chat

### 3.1 Por qué no reusar ni ampliar `visiblePanelId`

`visiblePanelId` significa **"un panel de la PC está mostrando este chat"**, y de eso dependen efectos reales:

| Uso real | Efecto si el teléfono contara como "visible" |
|---|---|
| `sendToChatWindow` (`runtime-state.ts:439-449`): manda en vivo **o** guarda en `eventLog` | Si el teléfono fuera "el visible", los eventos no se guardarían para la PC |
| `attachPanelToChat` (`:465-490`): **vacía** el `eventLog` al enganchar | El teléfono se "comería" el replay de la PC |
| `detachPanelFromChat` (`:507-523`): **apaga Familia A**, el navegador, la confianza de sesión y la vista de DeepSeek al soltar | El teléfono podría mantener viva Familia A sin nadie frente a la PC, o apagarla al desconectarse |
| `broadcastBackgroundActivity` (`:417-428`): badge "trabajando sin nadie mirando" | El badge de la PC mentiría |
| Notificaciones de Windows si nadie mira (`ipc-agent.ts:368`, `:909`) | Se dejarían de avisar en la PC |
| Vistas del navegador y de DeepSeek PWA (`ipc-agent.ts:176-191`, `:1202-1217`, `:1631`) | Intentaría ubicar una vista nativa en un panel que no existe |
| Orquestación y mensajería entre ventanas (`parallel-orchestrator.ts:91`, `cross-window-messaging.ts:155`, `:231`) | Tomaría al teléfono como una ventana destino |

Entonces el teléfono **no puede ser un `visiblePanelId`**, ni un "segundo `visiblePanelId`" que alguno de esos 20 usos pueda confundir.

### 3.2 Opciones

| Opción | Pros | Contras |
|---|---|---|
| (a) Campo `remoteObserverId` en `SessionRuntimeState` | Mínimo | Un solo dispositivo. **Solo existe si hay sesión:** `sendToChatWindow` sale temprano sin sesión (`:446`) y un chat nunca conectado en esta corrida no tiene `SessionRuntimeState`. Además mezcla el ciclo de vida de la conexión remota con el de la sesión (que `disconnectSession` desarma) |
| **(b) Registro aparte `remoteObservers: Map<chatId, Map<observerId, RemoteObserver>>`** (módulo nuevo) | Varios dispositivos (teléfono + tablet). **Independiente de la sesión** (se puede observar cualquier chat guardado). Cero cambios en la semántica de `visiblePanelId`. Revocar por dispositivo es trivial | Un módulo nuevo (chico) |

**Recomendación: (b).**

### 3.3 Diseño (pseudocódigo, **no** implementación)

```ts
// remote-observers.ts (nuevo) -- solo lectura, nunca toca SessionRuntimeState
interface RemoteObserver { observerId: string; deviceId: string; push(ev: RemoteEvent): boolean }  // push = encola en SU stream SSE, nunca bloquea
interface RemoteEvent { seq: number; chatId: string; channel: string; payload: unknown }         // payload YA filtrado

const observers = new Map<string, Map<string, RemoteObserver>>()   // chatId -> observerId -> observador
const REMOTE_CHANNELS = new Set(['agent:event', 'agent:toolApproval', 'agent:planMode', 'agent:toolTrust', 'agent:computerUse', 'agent:browserControl'])
const ring: RemoteEvent[] = []                                       // ultimos N eventos para reanudar (Last-Event-ID)
let nextSeq = 1

export function fanOutToRemote(chatId: string, channel: string, payload: Record<string, unknown>): void {
  if (!REMOTE_CHANNELS.has(channel)) return
  const byObserver = observers.get(chatId)
  const ev = { seq: nextSeq++, chatId, channel, payload: projectForRemote(channel, payload) }  // filtra: sin id de aprobacion, salida recortada, sin rutas
  ring.push(ev); if (ring.length > RING_MAX) ring.shift()
  for (const o of byObserver?.values() ?? []) if (!o.push(ev)) unobserve(o)                  // cola llena => se corta ese observador (vuelve a pedir la foto)
}
// observe(chatId, observer) devuelve { snapshot: mensajes guardados, inFlight: COPIA de session.eventLog (sin vaciarlo), lastSeq }
// unobserveDevice(deviceId) -> corta todos los observadores de ese dispositivo (revocacion, §4.3)
```

**Único punto de enganche en el código existente** (1 línea, al principio de `sendToChatWindow`, antes de la lógica actual y sin cambiarla):

```ts
function sendToChatWindow(chatId, channel, payload) {
  try { fanOutToRemote(chatId, channel, payload) } catch { /* el remoto nunca rompe ni demora el turno */ }
  // ... lógica actual intacta: visiblePanelId -> sendToWindow, si no -> eventLog ...
}
```

### 3.4 Invariantes (lo que las pruebas de F0 tendrían que demostrar)

1. **`visiblePanelId` y `eventLog` nunca los modifica nada remoto.** El `eventLog` solo se **copia** (lectura sin consumir); la PC sigue recibiendo su replay completo.
2. **Un observador remoto no cuenta como "visible":** badge, notificaciones de Windows, apagado de Familia A, vistas nativas, orquestación y mensajería entre ventanas se comportan exactamente como sin teléfono.
3. **Aislamiento de fallas:** el reparto está envuelto en `try/catch`, `push` nunca bloquea y cada observador tiene una cola acotada (si se llena, se corta y el teléfono vuelve a pedir la foto). Un teléfono lento o caído **no demora ni rompe un turno**.
4. **Reanudar sin perder nada:** `seq` global monotónico, un anillo de los últimos N eventos y `Last-Event-ID` en SSE. Si el hueco es más viejo que el anillo, el teléfono vuelve a pedir la foto.
5. **Límites:** máximo de observadores en total (p. ej. 4) y por dispositivo.
6. **Nada remoto cambia de lugar un evento:** el teléfono recibe **una copia filtrada**; la PC recibe el original, igual que hoy.

## 4. Tarea 4 — Emparejamiento y seguridad

> **Ajustes por la revisión del transporte (§1.4):**
> - donde dice PWA, léase **app nativa**;
> - el QR pasa a llevar **datos para la app** (dirección, puerto, hash de la clave del certificado y código), no una URL con `#`;
> - la app **verifica el pinning antes de mandar el código** (§1.4.2);
> - el chequeo de `Host` pasa a aceptar solo la IP o el nombre de Tailscale (o la IP de la red local) de la PC;
> - la interceptación la cubre el **pinning**, además del túnel.
>
> Todo lo demás de esta sección sigue vigente.

### 4.1 Modelo de amenazas

| Amenaza | Mitigación |
|---|---|
| Otro dispositivo de la red privada (red compartida, dispositivo de otra persona) | Token de dispositivo obligatorio. La red no alcanza como autenticación (§1.3.3) |
| **Proceso local de la PC** que le habla a `127.0.0.1:<puerto>` (malware, otra cuenta) | Token obligatorio. Los encabezados de Tailscale no se toman como prueba porque se pueden falsificar en loopback |
| **Página web maliciosa** abierta en el teléfono o en la PC que intenta leer la API | **Sin autenticación ambiental:** el token va **solo en `Authorization`**, nunca en cookies, así que un sitio ajeno no puede "heredar" la sesión. CORS cerrado: la PWA la sirve el mismo servidor (mismo origen) y no hay `Access-Control-Allow-Origin` para terceros. Chequeo de `Host` (se rechaza todo lo que no sea el nombre `.ts.net` esperado o `127.0.0.1`) contra *DNS rebinding* |
| QR fotografiado o visto por encima del hombro | Código de **un solo uso**, **120 s** de vida, y **confirmación en la PC** con un código corto de verificación mostrado en ambas pantallas (como el emparejamiento Bluetooth) |
| Teléfono perdido o robado | Revocación desde la PC (§4.3). Vencimiento por inactividad (p. ej. 30 días). La PWA borra el token al recibir 401 |
| Token robado del almacenamiento del teléfono | La PC guarda **solo el hash (SHA-256)**. Tokens por dispositivo: revocar uno no afecta a los demás. Mejora propuesta para F1: clave no extraíble (§4.2, alternativa) |
| Fuerza bruta | Tokens de 256 bits. `POST /pair` solo con la ventana abierta, con límite de intentos y bloqueo tras 5 códigos inválidos |
| Fuga de datos por lo que devuelve la API | Filtrado de §2: sin API keys, sin settings, sin rutas locales, sin contenido de adjuntos, salidas de tools recortadas |
| Interceptación o repetición | TLS con certificado válido de la red privada, sobre WireGuard |
| Saturación (DoS) | Límite de conexiones y observadores, colas acotadas, tamaño máximo de respuesta |
| **Amatista expuesta a internet por error** | Escucha **solo en `127.0.0.1`**, nunca en `0.0.0.0`. Funnel sin soporte y advertido. Chequeo al arrancar |
| Secretos en los logs | Nunca se registra un token ni un código. La auditoría registra id de dispositivo, acción y hora |
| Contenido que "da órdenes" (inyección) | F0 no ejecuta nada que venga del teléfono: no hay endpoints de acción |

### 4.2 Flujo de emparejamiento

1. **Activar:** "Acceso remoto (experimental, solo lectura)" está **apagado por defecto**. Activarlo pide **doble consentimiento**: texto de riesgos + "Entiendo los riesgos", mismo patrón que Familia A. Recién entonces arranca el servidor en `127.0.0.1`, y aparece un indicador permanente en la PC.
2. **"Emparejar teléfono":**
   - la PC genera `pairingCode` (128 bits aleatorios, base64url; vida de 120 s; un solo uso);
   - muestra un QR con `https://<maquina>.<red>.ts.net/pair#c=<pairingCode>`.

   El código va en el **fragmento (`#`)**, que el navegador **no manda al servidor**, así que no queda en registros de proxies ni en historial de requests. Nunca va en la query.
3. **El teléfono** (con Tailscale conectado) abre la URL. La PWA toma el código del fragmento y hace `POST /api/v0/pair` con `{ code, deviceName }` en el **cuerpo**.
4. **Verificación en la PC:**
   - el servidor valida el código (comparación en tiempo constante, vigencia, un solo uso);
   - calcula un **código corto de verificación** de 6 dígitos, derivado con HMAC del código y de un nonce, y lo muestran **las dos pantallas**;
   - la PC pregunta: *"¿Emparejar 'Pixel de …'? Código 482 913"* y el usuario **confirma en la PC**.

   Sin esa confirmación, nada se empareja (humano en el circuito).
5. **Token:**
   - el servidor genera `deviceToken` de **256 bits** y lo devuelve **una sola vez**;
   - guarda `{ deviceId, nombre, tokenHash: SHA-256(token), creado, últimaVez, permisos: ['read'], loginTailscaleAlEmparejar? }`;
   - el teléfono lo guarda en IndexedDB (aislado por origen).
6. **Cada pedido** lleva `Authorization: Bearer <token>`. El servidor lo hashea, lo busca con comparación en tiempo constante y actualiza `últimaVez`. El stream SSE se autentica al abrir y se corta si el dispositivo se revoca.

**Alternativa más fuerte (decisión, §6):** una **clave de dispositivo no extraíble** (WebCrypto, ECDSA P-256 `extractable: false`) con desafío-respuesta en cada conexión. Así ni siquiera un XSS en la PWA podría llevarse la credencial. Propuesta: F0 con token hasheado (lectura), y **clave no extraíble obligatoria al llegar el control (F1)**. O desde F0, si el usuario prefiere el máximo rigor desde el principio (+~100–150 líneas).

### 4.3 Revocación

- **Pantalla en la PC:** lista de dispositivos con nombre, fecha de emparejamiento, última conexión, **conectado ahora** y botón **[Revocar]**. Además **[Revocar todos]** y el **interruptor general**, que apaga el servidor en el acto.
- **Efecto inmediato:** se borra el registro → `unobserveDevice(deviceId)` corta sus streams en ese mismo ciclo → todo pedido siguiente recibe 401 → la PWA borra su token y muestra "Este dispositivo fue revocado".
- **Vencimiento automático** por inactividad (propuesta: 30 días).
- **Almacén:** archivo aparte, `config/remote-devices.json`, con escritura atómica, mismo patrón que `deepseek-pwa-termometro.json`. **No va en `settings.json`**, para no entrar en su reserialización ni en los campos que maneja el proceso principal. Guarda **solo hashes**.

### 4.4 Auditoría y visibilidad

- **Registro** `config/remote-access.log` (solo agregar): emparejamientos pedidos, confirmados y rechazados; conexiones y desconexiones; revocaciones; fallos de autenticación. **Nunca** tokens ni códigos.
- **Indicador en la PC** mientras el acceso está activo: *"📱 1 dispositivo conectado (solo lectura)"*. Al hacer clic muestra la lista. Es el equivalente del indicador `/rc active` de Remote Control.

### 4.5 Mismo rigor que Familia A

| Familia A | Acceso remoto F0 |
|---|---|
| Doble consentimiento ("Entiendo los riesgos") | Igual para activarlo |
| Se apaga sola al soltar el panel (`detachPanelFromChat`) | Propuesta (§6): se apaga al reiniciar Amatista, o tras N horas sin uso |
| Aprobaciones duras por acción | **No aplica:** F0 no tiene ninguna acción |
| Indicador visible | Indicador permanente + lista de dispositivos |

## 5. Tamaño de F0

La estimación anterior (`verify_android_access_design.md`, B-F0) era de **800–1.100 líneas de producción + 400–550 de verificación ≈ 2,5–3,5 jornadas**. Con este diseño se afina así:

| Pieza | Producción | Nota |
|---|---|---|
| Servidor HTTP en loopback + SSE + filtrado de datos + los 5 endpoints | 350–450 | |
| `remote-observers.ts` + enganche en `sendToChatWindow` + anillo y reanudación + copia del `eventLog` | 200–300 | |
| Emparejamiento, tokens, revocación, auditoría, `remote-devices.json` | 200–300 | |
| Interfaz en la PC: interruptor con doble consentimiento, QR, confirmación, lista de dispositivos, indicador | 150–250 | **no estaba contada** en la estimación anterior |
| PWA de solo lectura: lista de chats, conversación en vivo, avisos | 300–400 | |
| **Total F0** | **≈ 1.200–1.700** (+ **600–850** de verificación) | **≈ 3,5–5 jornadas**. Más que antes porque ahora se cuentan la interfaz de la PC y el flujo de confirmación de §4 |

> **Revisado en §1.4.4:** con la app nativa con pinning (cliente Capacitor) y el certificado propio de la PC, F0 queda en **≈ 1.450–2.150 líneas de producción + 700–1.000 de verificación ≈ 4–6 jornadas**.

La verificación debería incluir, además de tests: las invariantes de §3.4 (sobre todo que Familia A, las notificaciones y el badge **no cambian** con un teléfono conectado), las amenazas de §4.1 reproducidas (token inválido, código vencido o reusado, `Host` falso, página de otro origen, revocación con un stream abierto) y una corrida real con Tailscale en un teléfono.

## 6. Decisiones abiertas (para el usuario)

1. **Transporte (revisado en §1.4.4):** (a) Tailscale sin `serve` + HTTPS autofirmado + app nativa con pinning; (b) solo la misma Wi-Fi con la misma app, sin terceros; (c) prototipo con HTTP en el navegador dentro de Tailscale. ~~`tailscale serve`~~ quedó descartado por el usuario.
2. **Cliente del teléfono:** app nativa con Capacitor (reusa la interfaz web y agrega pinning nativo) o Kotlin puro. Es necesario para el pinning (§1.4.1).
3. **Credencial:** token hasheado en F0 y clave no extraíble en F1, **o** clave no extraíble desde F0. Con app nativa, esa clave puede vivir en el Keystore de Android (§1.4.2).
4. **Aprobaciones pendientes en el teléfono:** ¿solo el título, o título + detalle (que puede incluir el comando o la ruta)?
5. **Apagado automático:** ¿al reiniciar Amatista, tras N horas sin uso, o persistente hasta que lo apagues?
6. **Adjuntos en F0:** ¿nada, o miniaturas de imágenes (con el mismo filtrado, sin rutas)?
7. **Historial "en vuelo":** ¿F0 con la copia del `eventLog` (hueco acotado, documentado en §2.4), o antes mover el guardado de mensajes al proceso principal (cambio más grande, de F0 del rediseño de sesiones)?

## 7. Lo que no se verificó

- WebSocket a través de `tailscale serve` (no documentado). F0 no lo necesita.
- SSE a través de `tailscale serve`: es HTTP común con streaming, así que se espera que funcione. Se verifica en la primera prueba real.
- Límites y precios del plan de Tailscale.
- La instalación como PWA y el service worker sobre el HTTPS de `.ts.net` en Chrome de Android: se espera que funcione con certificado válido; se verifica en la primera prueba real.
- La opción (d) de túnel con autenticación en el borde: no se investigó a fondo.
- **Revisión §1.4:**
  - que un nombre MagicDNS **no resuelva** sin Tailscale activo (la documentación no lo dice explícitamente);
  - el comportamiento real de Chrome en Android con un certificado instalado en el almacén de usuario, y si respeta restricciones de nombre;
  - pinning en tiempo de ejecución dentro de un WebView de Capacitor (el mecanismo está documentado, pero no se probó);
  - si tu proveedor de internet te da IP pública (condición para WireGuard directo).

## 8. Parte 1 — el puente de red en el proceso principal (implementado, sin commit)

### 8.1 Qué se construyó

**Transporte del primer paso (decisión del usuario):**
- HTTPS con certificado propio autofirmado en la **IP de red local** de la PC (Wi-Fi o Ethernet), elegida automáticamente entre las IPv4 privadas; en esta PC, `192.168.x.y`.
- Se ignoran los adaptadores virtuales (Hyper-V, WSL, VirtualBox, Tailscale…). **Nunca escucha en `0.0.0.0`** ni en una IP pública: `assertBindable` lo rechaza.
- Puerto `47823` por defecto. `bindAddress` y `port` se pueden fijar en `remote-access.json`, y así el transporte queda intercambiable: sirve igual para una IP de Tailscale más adelante.

**Módulos nuevos:**

| Archivo | Líneas | Qué hace |
|---|---|---|
| `src/main/remote-tls.ts` | 158 | Identidad TLS propia: clave ECDSA P-256 generada **una vez** y guardada **cifrada con `safeStorage`** (DPAPI en Windows, lo mismo que las API keys) en `config/remote-identity.json`. Sin cifrado disponible, queda solo en memoria. El certificado X.509 v3 se **re-emite en cada arranque** con la IP actual en el SAN, mediante un **codificador DER mínimo propio** (sin dependencias). Se autoverifica con `crypto.X509Certificate().verify()`. El pin es el SHA-256 de la clave pública (SPKI) en base64url, el mismo criterio que `pin-set` de Android |
| `src/main/remote-devices.ts` | 246 | Consentimiento, dispositivos, emparejamiento y auditoría, en archivos propios de `config/` y **nunca en `settings.json`**. Emparejamiento: código de 128 bits, 120 s, un solo uso, 5 fallos cierran la ventana. Código corto = HMAC-SHA256(código, secreto) → 6 dígitos. Confirmación **solo** desde la PC. Token de 256 bits entregado una sola vez; se guarda **solo** SHA-256(token). Comparaciones en tiempo constante (`timingSafeEqual`) |
| `src/main/remote-observers.ts` | 169 | Registro de observadores `Map<chatId, Map<observerId, RemoteObserver>>`, **separado** de `visiblePanelId`. Anillo de 2.000 eventos con `seq` global. Filtrado de datos. Actividad en segundo plano calculada a partir de `turn/started`/`turn/completed`/`turn/cancelled` |
| `src/main/remote-server.ts` | 325 | Servidor HTTPS + las **5 rutas** (la tabla *es* la lista blanca) + ciclo de vida + guard de consentimiento + estado para la interfaz |
| `src/main/ipc-remote-access.ts` | 54 | IPC **local** de la PC para administrarlo (8 canales `remote:*`). No es alcanzable desde la red |

**Cambios en archivos existentes (+248 líneas):**
- `runtime-state.ts`: el **único enganche**, una línea `fanOutToRemote(...)` en `try/catch` al principio de `sendToChatWindow`, más su import. Nada más del archivo cambió.
- `index.ts`: registro del IPC y apagado en `before-quit`.
- `preload/index.ts` y `index.d.ts`: 9 métodos.
- `shared/types.ts`: `RemoteAccessStatus`.
- `App.tsx` y `main.css`: la interfaz.
- `package.json`: **`uqr` ^0.1.3**, MIT, sin dependencias, 79 KB, que genera el SVG del QR. Es la única dependencia nueva.

**Las 5 rutas** (cualquier otra combinación de método y ruta → `404`):

| Ruta | Autenticación | Qué hace |
|---|---|---|
| `POST /api/v0/pair` | el código del QR | abre la solicitud; devuelve el secreto de la solicitud y los 6 dígitos |
| `GET /api/v0/pair/status` | `Pairing <secreto>` | estado de la solicitud; entrega el token **una vez**, tras la confirmación en la PC |
| `GET /api/v0/chats` | `Bearer <token>` | `chats:load` **filtrado** |
| `GET /api/v0/projects` | `Bearer <token>` | `projects:list`, **solo nombres** |
| `GET /api/v0/events` | `Bearer <token>` | SSE de los chats pedidos (`?chat=<id>`) + actividad. Reanuda con `Last-Event-ID: <bootId>-<seq>`. Otro `bootId` o un hueco más viejo que el anillo → `resync` |

**Filtrado de datos:**
- **chats:** sin `workspacePath`; de los adjuntos, solo nombre, tipo, tamaño y origen (sin `path`, `text` ni `preview`).
- **eventos:** se quitan las claves `panelId`, `workspace`, `workspacePath`, `path`, `cwd`, `apiKey`, `token`…; los `data:` se omiten; los textos de más de 4.000 caracteres se recortan.
- **aprobación pendiente:** solo el **título completo** (decisión del usuario), sin id de respuesta ni detalle.

**Defensas de cada pedido:**
- `Host` exacto → si no, 421 (contra *DNS rebinding*).
- **Cualquier `Origin` → 403**: F0 no admite navegadores; el cliente es la app nativa.
- `OPTIONS` → 404, sin encabezados CORS.
- Cuerpo de hasta 4 KB, `headersTimeout` de 10 s, `requestTimeout` de 15 s, `maxConnections` 32.
- Streams: 4 en total y 2 por dispositivo; latido cada 25 s; cola acotada por observador (si se llena, se corta ese observador).

**Interfaz en la PC:**
- **Configuración → "Acceso remoto (experimental, solo lectura)":** advertencia + "Entiendo los riesgos", y recién después el interruptor, el QR, la lista de dispositivos con "Revocar" y "Revocar todos".
- **Aviso fijo** (`position: fixed`, fuera de la grilla del sidebar): la **confirmación del emparejamiento** con los 6 dígitos grandes, visible aunque Configuración esté cerrada, y el **indicador**: "📡 Acceso remoto encendido" o "📱 N dispositivo(s) conectado(s) (solo lectura)".

**Decisiones de implementación que conviene confirmar:**
1. **El encendido no persiste:** Amatista arranca con el acceso remoto **apagado siempre**; solo se recuerda el consentimiento. Es la opción conservadora de la decisión abierta nº 5, y se verificó en la app real.
2. **El historial "en vuelo"** se cubre como se decidió: el anillo graba **siempre** mientras el acceso está encendido (haya o no teléfono conectado) y, al conectar sin id, se manda una **copia** del `eventLog` como `backlog`, sin vaciarlo.

### 8.2 Verificación real

**Arnés con los módulos reales, storage aislado, servidor en la IP real de la Wi-Fi (`192.168.x.y`) y un "teléfono" que fija el certificado con el hash del QR: 40/40 OK.**

| # | Punto pedido | Resultado |
|---|---|---|
| 1 | Solo los 2 endpoints de lectura | ✅ `GET /chats` (con el chat real, **sin** rutas ni contenido de adjuntos) y `GET /projects` (solo nombres) → 200. Sin token o con token falso → 401. `Host` ajeno → 421. `Origin` → 403. `OPTIONS` → 404 |
| 2 | Emparejamiento | ✅ QR (SVG) con código y pin **solo en el fragmento `#`**. El teléfono fija el certificado. Código inválido → 403. Código válido → la PC muestra la solicitud con los **mismos 6 dígitos** (`505393` en ambos). El mismo código no sirve dos veces. **Sin confirmar en la PC no hay token.** Tras "Confirmar": token de 256 bits, entregado **una sola vez**. `remote-devices.json` tiene solo `tokenHash`, y el token no aparece en **ningún** archivo de `config/`. 5 códigos inválidos cierran la ventana (ni el correcto sirve después) |
| 3 | Turno sin panel en la PC | ✅ La PC sigue guardando en **su** `eventLog` (el camino de siempre intacto). Reanudar con `Last-Event-ID` entrega **exactamente** lo perdido: `agent:event#1, remote:activity#2, agent:event#3, agent:event#4`, secuencia continua. En vivo llega el `#5`. Sin id: `hello` + `backlog` con la copia (4) y **el `eventLog` sigue en 4**. Id de otro arranque → `resync`. La aprobación llega **solo con el título** |
| 4 | Revocación | ✅ Con un stream abierto la PC ve "1 conectado". Revocar **corta el stream en 6 ms**, y después `GET /chats` y abrir el stream dan 401. La PC ve 0 |
| 5 | `settings:get` y `agent:attach` inalcanzables | ✅ **910 pedidos** (GET y POST) con los nombres de los **45 canales IPC reales registrados en el proceso**, incluidos `settings:get` y `agent:attach`, bajo 5 prefijos y codificados → **todos 404**. **Ningún handler IPC se invocó** (contador en cada handler: `{}`). `remote-server.ts` no importa `electron` ni ningún `ipc-*.ts` |
| 6 | Doble consentimiento | ✅ Sin aceptar: `startRemoteAccess()` se niega, **el puerto 47823 ni se abre**, y el IPC `remote:setEnabled` también se niega |
| — | Auditoría | ✅ Registra consentimiento, arranque, emparejamientos (pedido, aceptado, rechazado, confirmado, bloqueado), streams, fallos de autenticación y revocación; **nunca** el token ni el código |

**Test de regresión nuevo** (`tests/regression/remote-access.test.ts`, 10 tests, en `127.0.0.1` con puerto del sistema). Cubre lo anterior, más que el desborde del anillo pide `resync` y que canales fuera de la lista (`chat:incomingMessage`, `settings:get`) nunca salen. **Suite completa: 135/135.** `npm run typecheck` y `npm run build` limpios.

**App real de punta a punta** (`electron .`, storage aislado, manejada por CDP; el "teléfono" **lee el QR de la pantalla** con jsQR sobre la imagen renderizada): **25/25 OK.**
- Al arrancar: apagado y sin consentimiento.
- Advertencia **sin** interruptor. "Entiendo los riesgos" → "Encender" → escucha en `https://192.168.x.y:47823`.
- **Clave persistida con DPAPI real** (`identityPersistent: true`, el archivo sin la clave en claro).
- QR decodificado desde la pantalla con la URL, el código y el pin.
- La PC muestra "¿Emparejar «Telefono E2E»?" con **los mismos 6 dígitos** (`684 528`), y el QR desaparece al usarse.
- "Confirmar" → token → indicador "📱 1 dispositivo conectado (solo lectura)".
- **Cierre ordenado y reinicio:** arranca apagado, con consentimiento y dispositivo recordados; al encender, **el mismo pin**, y el teléfono se reconecta con su token.
- **"Revocar" desde la interfaz** corta el stream en 5 ms → 401 → el indicador vuelve a "ningún dispositivo".
- Al terminar, 0 procesos de Amatista.

**Hallazgo real durante el E2E (y corrección de la prueba):**
- En la primera corrida, tras reiniciar, **el pin cambió**. Causa: la prueba mataba la app con `taskkill /F` sobre un perfil **recién creado**, y Chromium nunca llegó a escribir `Local State`, donde vive la clave maestra de `safeStorage`. Al volver a arrancar hubo otra clave maestra y la clave del certificado no se pudo descifrar.
- El código **falló cerrado**: apartó el archivo como `.ilegible`, generó una identidad nueva y el teléfono dejó de confiar. No hubo fuga, pero sí hubo que volver a emparejar.
- Con un cierre ordenado (como el de un usuario), `Local State` se guarda y el pin persiste (verificado).
- La misma fragilidad **ya existe hoy para las API keys** en una instalación nueva que se cierra de golpe. Queda anotada en `PENDING.md`.

### 8.3 Lo que falta o no se verificó

- **Un teléfono real** (Parte 2): el "teléfono" de las pruebas corrió en la misma PC, conectándose a la IP de la Wi-Fi.
- **Firewall de Windows:** para que un teléfono de la Wi-Fi llegue al puerto, Windows tiene que permitir conexiones entrantes a `Amatista.exe` en redes **privadas**. La primera vez que el proceso escucha en la red local, Windows puede preguntarlo. No se configuró ninguna regla. Se verifica en la Parte 2.
- **Cambio de IP** (DHCP) con la app abierta: el certificado se re-emite al volver a encender, y el pin no cambia; el teléfono necesitará la IP nueva (la Parte 2 decide cómo la redescubre).
- **Vencimiento automático** de dispositivos por inactividad (30 días, §4.3): no implementado en la Parte 1.

> Estado de estos puntos tras la Parte 2: ver §9.6.

## 9. Parte 2 — la app nativa de Android (implementada, sin commit)

### 9.1 Decisión: nativa (Kotlin + Jetpack Compose), sin WebView

| Requisito | App nativa | WebView (o PWA) |
|---|---|---|
| **Pinning de un certificado que se conoce recién al escanear el QR** | `SSLContext` propio con un `X509TrustManager` que compara el SPKI del servidor con el pin **durante el handshake TLS**: si no coincide, la conexión se corta antes de mandar un solo byte de HTTP | `<pin-set>` de `network_security_config` se fija **al compilar**, no en tiempo de ejecución. Dentro de un WebView lo único que queda es `onReceivedSslError` → `proceed()`/`cancel()`, un atajo frágil que Google Play marca como inseguro |
| **Token en el Keystore** | Acceso directo a `AndroidKeyStore` (AES-256-GCM, StrongBox o TEE) | Hace falta un puente JS↔nativo, que es otra superficie a proteger |
| **SSE con `Authorization` y `Last-Event-ID` propio** | Se controlan los encabezados y el `Last-Event-ID` se persiste entre reinicios de la app | `EventSource` **no permite encabezados propios** (no hay `Bearer`) y solo recuerda el último id mientras vive la página |
| **Seguir en segundo plano y notificar** | Servicio en primer plano + canales de notificación | Depende del ciclo de vida del WebView |
| **Dependencias** | ZXing (el QR) + AndroidX/Compose. Sin OkHttp ni Retrofit: `HttpsURLConnection` del sistema | Capacitor/Cordova + plugins |

La interfaz es chica (2 pantallas y una lista), así que Compose no agrega complejidad: todo queda en un solo lenguaje.

### 9.2 Estructura del proyecto

`android/remote-viewer/`, un proyecto Gradle **independiente** de Amatista:
- no comparte `package.json` ni build;
- `electron-builder` usa una lista blanca en `build.files`, así que **`android/` nunca entra al instalador**;
- `app/build/`, `.gradle/` y `local.properties` quedan ignorados por su propio `.gitignore` (verificado con `git check-ignore`).

| Archivo | Líneas | Qué hace |
|---|---|---|
| `settings.gradle.kts` · `build.gradle.kts` · `gradle.properties` | 18 · 6 · 4 | Proyecto `AmatistaRemoteViewer`: AGP 8.13.2, Kotlin 2.3.20 + plugin de Compose 2.3.20 |
| `gradlew` · `gradlew.bat` · `gradle/wrapper/*` | — | Wrapper de Gradle 8.14 |
| `app/build.gradle.kts` | 52 | `com.amatista.remote`: compileSdk y targetSdk 36, **minSdk 26** (Android 8.0), `versionName "0.1.0-f0"`. Compose BOM 2026.03.00, `core-ktx`, `activity-compose`, `lifecycle-runtime-compose`, material3, `zxing-android-embedded` 4.3.0 |
| `app/src/main/AndroidManifest.xml` | 47 | Permisos: `INTERNET`, `CAMERA`, `POST_NOTIFICATIONS`, `FOREGROUND_SERVICE`, `FOREGROUND_SERVICE_SPECIAL_USE`. `allowBackup="false"` (el token cifrado no sale en copias de seguridad). La `CaptureActivity` de ZXing y `ViewerService` (`foregroundServiceType="specialUse"`) |
| `res/xml/network_security_config.xml` | 10 | `cleartextTrafficPermitted="false"`: nada viaja sin TLS. Las conexiones a la PC usan el `SSLContext` con pin, no los certificados del sistema |
| `PairingLink.kt` | 31 | Lee la URL del QR. Exige `https` y ruta `/pair`, y toma `c` (código) y `k` (pin) **del fragmento `#`**, validados como base64url de 16 a 64 caracteres. Cualquier otra cosa se rechaza |
| `PinnedTransport.kt` | 100 | Transporte HTTPS con pin: `checkServerTrusted` compara `SHA-256(SPKI)` con `MessageDigest.isEqual` (tiempo constante). Si no coincide → `PinMismatchException` y el log `PIN RECHAZADO`. El `HostnameVerifier` exige el host exacto del emparejamiento |
| `SecureStore.kt` | 113 | Clave AES-256-GCM en `AndroidKeyStore` (**StrongBox** si existe; si no, TEE). En `SharedPreferences` quedan solo el host, el puerto, el pin, el id de dispositivo, el último `Last-Event-ID` y el token **cifrado** (IV + texto cifrado). `keyProtection()` informa en pantalla dónde vive la clave. "Olvidar esta PC" borra también la clave |
| `RemoteSession.kt` | 394 | El estado de la app en `StateFlow`s: emparejamiento, conexión, chats, mensajes, proyectos, actividad, turno en vivo y aprobaciones. El bucle SSE, la reanudación y las notificaciones |
| `QrDecoder.kt` | 23 | ZXing `MultiFormatReader` (QR + `TRY_HARDER`) para leer el QR desde una imagen de la galería |
| `ViewerService.kt` | 31 | Servicio en primer plano que mantiene el stream con la app en segundo plano, con una notificación fija de "Conectado a la PC" |
| `MainActivity.kt` | 253 | Pantallas en Compose: emparejar (cámara o imagen → los 6 dígitos → "Confirmá en la PC"), lista de chats (estado de la conexión, PC, nivel del Keystore, proyectos, actividad, aprobaciones pendientes, "Olvidar esta PC") y el chat (mensajes, adjuntos **solo por nombre**, tarjeta del turno en vivo) |

**Compilación:** `gradlew.bat assembleDebug` con `JAVA_HOME` apuntando al JDK 21 de Android Studio (`C:\Program Files\Android\Android Studio\jbr`). APK de depuración de **11,3 MB**, sin advertencias de Kotlin. No hay configuración de firma de release.

**Ganchos solo de depuración:** `MainActivity` acepta los extras `qr_image` (una imagen en la carpeta de la app) y `qr_text` para automatizar el emulador. Los ignora si `BuildConfig.DEBUG` es falso, así que en un build de release no existen.

### 9.3 Cómo funciona

1. **QR:** con la cámara (`ScanContract` de ZXing) o desde una imagen. `PairingLink.parse` obtiene host, puerto, código y pin.
2. **Emparejamiento:** `POST /api/v0/pair` por el transporte con pin. **El pin se verifica en el handshake, antes de mandar el código**, así que un impostor nunca lo ve. El teléfono muestra los 6 dígitos y consulta `pair/status` cada 1,5 s durante hasta 150 s, mientras el usuario confirma en la PC.
3. **Token:** llega una sola vez, se cifra con la clave del Keystore y solo se guarda cifrado. En builds de depuración se registra en el log un prefijo de su SHA-256 (nunca el token) para cruzarlo con `remote-devices.json`.
4. **Datos:** `GET /api/v0/chats` y `GET /api/v0/projects`, y nada más.
5. **Stream:** `GET /api/v0/events` de los **50 chats más recientes**, con `Last-Event-ID` persistido tras **cada** evento:
   - backoff de 1 s a 15 s;
   - lectura con timeout de 70 s (el latido es cada 25 s, así que 70 s en silencio = conexión muerta);
   - `resync` → se descarta el id y se recarga todo;
   - `401` → estado "Revocado por la PC" y se borra lo guardado;
   - pin distinto → "Certificado distinto: conexión bloqueada", sin mandar el token, reintentando cada 10 s por si la PC verdadera vuelve.
6. **Notificaciones:** canal `turnos` ("Terminó en la PC · <título>", cuando la actividad de un chat pasa de "en curso" a terminado) y canal `conexion` (la notificación fija del servicio).

### 9.4 Verificación real

**Fases A y B: la app real de Amatista** (`electron .`, storage aislado, manejada por CDP) **y el APK real en el emulador** (AVD `amatista-remote-test`, Android 14 / API 34, x86_64). La app de Android se conecta a `https://192.168.x.y:47823`, la IP real de la Wi-Fi. **19/19 OK.**

| # | Punto pedido | Resultado |
|---|---|---|
| 1 | Emparejamiento real de punta a punta | ✅ Chat de prueba creado con el IPC real. Encender → se captura **el QR real de la pantalla** (220×220), que la app decodifica con su propio ZXing (IP, puerto y pin coinciden). **El mismo código de 6 dígitos (`466491`) en el teléfono y en la PC** → "Confirmar" en la PC → emparejado. Keystore: "software (sin hardware seguro: típico de un emulador)". El prefijo del SHA-256 del token en el teléfono (`fad51d4f0cb368e4`) **coincide** con `remote-devices.json`, y `token_ct` contiene solo IV + texto cifrado (97 caracteres). SSE `HELLO` recibido; la PC muestra "📱 1 dispositivo conectado" |
| 2 | El pinning rechaza un certificado impostor | ✅ Se apagó el puente y se levantó un **impostor en la misma IP y puerto**, con otra clave. El teléfono: "PIN RECHAZADO" y la interfaz en "Certificado distinto: conexión bloqueada". Del lado del impostor: **1 intento TLS, 1 handshake fallido y 0 pedidos HTTP** (ni el token ni nada llegó). Al volver la PC verdadera (mismo pin), el teléfono se reconectó solo |
| 4 | Interfaz con datos reales de un chat de prueba | ✅ `CHATS: 2 chats leidos (3 mensajes)`. La lista muestra los 2 chats con proyecto y fecha; al abrir el chat de prueba se ven sus 3 mensajes, y el adjunto aparece **solo por nombre** (`ventas-septiembre.xlsx`, sin ruta local) |

**Fase C: reconexión tras un corte de red.** El puente real corrió en un proceso Node **sin ventana**, en la IP de la Wi-Fi, emitiendo 40 deltas numerados + el cierre del turno, a ritmo fijo. En el emulador, modo avión durante 7 s a partir del evento 8. **8/8 OK.**

| # | Punto pedido | Resultado |
|---|---|---|
| 3 | Reconexión real con `Last-Event-ID`, sin pérdida | ✅ Emparejado (código `051010`, arranque `e256ac492cd2`). Al cortar la red: `STREAM cortado: SocketException: Software caused connection abort`. Al volver: `RECONEXION: pidiendo lo posterior a Last-Event-ID=e256ac492cd2-11`, y **el primer evento recibido es el `-12`** (sin salto). **Los 44 eventos emitidos llegaron todos, sin duplicados y en orden.** El texto en vivo quedó completo (1 … 40). Notificación "Terminó en la PC · Prueba de reconexión" visible en la cortina de notificaciones |

**Después de las pruebas:** emulador apagado (0 procesos), 0 procesos de Amatista de prueba y storages temporales borrados. `npm run typecheck` limpio; suite de regresión 135/135 tres veces seguidas.

### 9.5 Ajustes del lado de Amatista durante la Parte 2

1. **El QR quedaba tapado** (hallazgo real del E2E): en la primera corrida ZXing no encontró el QR, porque la barra inferior del panel de Configuración tapaba su cuarto de abajo. En `App.tsx`, al generar el QR, `scrollIntoView({ block: 'center' })` lo centra en pantalla (1 línea + comentario). Con eso, 19/19.
2. **`tests/regression/_support/run.cjs`** (infraestructura de tests, no el puente): una corrida de la suite dio **11 fallas, las 11 por `database is locked`**. Todos los archivos de test corrían en paralelo contra la misma base SQLite, y el test nuevo del puente sumó contención. Ahora cada archivo tiene **su propio storage aislado**, se mantiene el paralelismo y se suman los totales. Resultado: 3 × 135/135. Esto también cierra el "test intermitente" abierto en `docs/_arch/PENDING.md`.

Ningún otro archivo de Electron cambió en la Parte 2.

### 9.6 Lo que no se verificó

- **Teléfono físico** (se hizo en emulador, como permitía el pedido):
  - **escanear con la cámara:** el camino de la cámara (`ScanContract`) no se ejercitó; en el emulador el QR real se leyó desde la imagen capturada con el mismo decodificador ZXing;
  - **Keystore respaldado por hardware** (StrongBox/TEE): el emulador solo tiene la implementación por software;
  - **firewall de Windows:** el emulador sale a la red por la NAT de la propia PC, así que **no probó una conexión entrante desde otro dispositivo de la Wi-Fi**. La primera vez, Windows puede pedir permiso para `Amatista.exe` en redes privadas.
- **Origen de los eventos de la fase C:** los generó el puente real en un proceso Node, no un turno real de un modelo dentro de Electron (producir un turno real necesita un agente conectado).
- **Cambio de IP de la PC** (DHCP): la app sigue usando la IP del emparejamiento; hay que volver a escanear.
- **Solo Android 14 (API 34) en emulador:** no se probaron versiones más viejas (minSdk 26), ni el ahorro de batería o Doze en sesiones largas, ni un build de release firmado.
- **Solo se siguen los 50 chats más recientes** en el stream; los más viejos se ven en la lista, pero sin actividad en vivo.

## Fuentes

- Código: `master` @ `4996703`, citado por archivo y línea.
- [Claude Code — Remote Control](https://code.claude.com/docs/en/remote-control.md)
- [Tailscale — Serve](https://tailscale.com/kb/1312/serve)
- [Tailscale — Enabling HTTPS](https://tailscale.com/kb/1153/enabling-https)
- Revisión §1.4:
  - Tailscale: [IPs 100.x](https://tailscale.com/kb/1015/100.x-addresses), [MagicDNS](https://tailscale.com/kb/1081/magicdns), [How Tailscale works](https://tailscale.com/blog/how-tailscale-works)
  - Android: [network security config (pinning, trust-anchors)](https://developer.android.com/privacy-and-security/security-config)
  - Chrome: [FAQ Chrome Root Store](https://github.com/chromium/chromium/blob/main/net/data/ssl/chrome_root_store/faq.md), [w3c/ServiceWorker#1514](https://github.com/w3c/ServiceWorker/issues/1514)
  - WireGuard: [WireGuard](https://www.wireguard.com/), [protocolo](https://www.wireguard.com/protocol/), [importar por QR en Android](https://git.zx2c4.com/wireguard-android/commit/?id=0bd39309c8ba839191684d5d34c247c0af7b42aa)
- `docs/_arch/verify_android_access_design.md` (ruta B y la estimación original)
- Parte 2:
  - Android: [Keystore](https://developer.android.com/privacy-and-security/keystore)
  - WHATWG: [Server-sent events (`EventSource`, `Last-Event-ID`)](https://html.spec.whatwg.org/multipage/server-sent-events.html)
