# PENDING.md — Experimento DeepSeek PWA

> Riesgo real de violar ToS de DeepSeek, decisión consciente del usuario — **integrado a `master` el 2026-09-23**, detrás del consentimiento doble `deepseekPwaAcknowledged`.

## Resueltos (ver `CONTRACT.md`)

- Viabilidad (T1-T4), diseño (Tareas 1-5), pendientes del diseño (P1-P5).
- **Puente implementado y verificado real (7/7).**
- **Permisos denegados en `persist:deepseek-pwa`**, verificado dentro de la vista real conectada.
- **Integración a master** (fast-forward). El push queda pendiente del ok del usuario.

## Abierto

1. **Push a origin:** pendiente del ok del usuario.
2. **Captcha/hCaptcha real:** el flujo está implementado y se ejercitó con el login real (mismo mecanismo), pero la detección por iframe de hCaptcha nunca se observó en vivo. Si aparece de verdad, capturar el DOM real y ajustar si hace falta.
3. **Formato real del aviso de límite de frecuencia:** nunca alcanzado (P4, tope deliberado). Se muestra tal cual lo que llegue (status/`{code,msg}`/estado del stream).
4. **Markdown complejo** (bloques de código, tablas): la lectura es Markdown crudo desde la red, así que el riesgo es bajo, pero no hay una prueba específica.
5. **Mantenimiento frente a deploys de DeepSeek:**
   - el test de contrato del parser (`tests/regression/deepseek-pwa-stream.test.ts`) falla primero si cambia el formato;
   - `AMATISTA_DEEPSEEK_PWA_DUMP_DIR` guarda streams crudos para renovar los fixtures.
6. **Adjuntos:** fuera de v1 (solo texto).

## Hallazgos para la app principal (no pertenecen a este experimento)

- **Navegador embebido no aislado:** `docs/_arch/verify_embedded_browser_isolation_gap.md` (ignorado por git, en master).
- **Fix de renderer que sirve a cualquier runtime con streaming:** `appendAssistantMessage(..., endsTurn)`. Si algún día se integra, va con este puente; hoy solo existe en esta rama.
- **4 tests de regresión rotos desde F0** (`parallel-ask-identity`, `session-registry-bound`): siguen esperando la semántica anterior a F0 (`panelClosing`, paneles sin el guard de visibilidad). No se tocaron desde v0.11.0 y fallan también en master.

## Fuera de alcance (por decisión explícita)

- Cualquier técnica de evasión (UA falso, anti-fingerprinting, resolución de captchas).
- Reintentos automáticos de envío.
- Provocar el límite de frecuencia por encima del tope de 8 envíos.
