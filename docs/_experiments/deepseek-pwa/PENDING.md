# PENDING.md — Experimento DeepSeek PWA

> Experimento aislado, riesgo real de violar ToS de DeepSeek, decisión consciente del usuario — NO integrado a la app principal.

## Abierto

1. ~~Señal de fin con respuesta larga~~ y ~~bloque de razonamiento~~: **resueltos** (prueba 2, ver `CONTRACT.md`). Queda abierto:
   - **Markdown complejo:** falta probar que el append-only se mantiene con bloques de código o tablas, que podrían re-renderizar lo ya escrito.
   - **Botones de acción como señal secundaria:** no se midió si los 6 botones del mensaje aparecen solo al terminar.
2. **Robustez de selectores:** DeepSeek despliega seguido y los hashes de clase cambian. Si se construye la integración, ninguna lógica debe depender de clases hasheadas ni del `path d` completo de los íconos.
3. **Decisión del usuario:** seguir o no hacia una integración real, con el riesgo de ToS (§3.5(3)/§8.2) y el anti-bot real ya documentados.

## Fuera de alcance (por decisión explícita)

- Integración a `tool-registry.ts`: no se toca hasta que el usuario valide la viabilidad completa.
- Cualquier técnica de evasión (UA falso, anti-fingerprinting, resolución de captchas): no se investiga ni se implementa.

## Hallazgo lateral para la app principal (no pertenece a este experimento)

`ensureBrowserView()` (`src/main/embedded-browser.ts:36`) no define `partition`, así que el navegador embebido usa la sesión **default** (persistente en disco, compartida con la ventana principal), no una aislada/efímera como se suponía. Hay que decidirlo en los docs principales, no acá.
