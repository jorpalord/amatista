# PENDING.md — Backlog del experimento deepseek-pwa-tools

## Decisión del usuario: ¿implementar el puente de imágenes/archivos?

Investigación completa en `CONTRACT.md`. No implementado -- pedido explícito del usuario ("con esto decidimos si vale la pena antes de construir nada"). Si se decide seguir, quedan reales:

1. **Carga de imágenes real, sin probar en vivo.** El mecanismo (`DOM.setFileInputFiles` sobre el `<input type=file>` real del composer) está identificado pero nunca se ejecutó contra la cuenta real -- primer paso real de la implementación.
2. **RESUELTO (2026-09-23).** El bug real de descargas (botón "Descargar" nunca completaba) se diagnosticó (`docs/_arch/verify_deepseek_pwa_download_bug.md`) y se corrigió (`docs/_arch/CONTRACT.md` → "Fix real — el botón 'Descargar' de DeepSeek PWA..."), verificado real de punta a punta contra la cuenta real. La causa NO era el `webContents.debugger` (confirmado con y sin él, idéntico) — era la ausencia total de un manejador de `will-download`.
4. **Chat de prueba creado en la cuenta real de DeepSeek** durante esta investigación (prompt: función de suma en python) -- no se borró (mismo criterio que el experimento anterior: se puede borrar a mano desde la PWA si se quiere). El chat LOCAL correspondiente en Amatista quedó renombrado (`INVESTIGACION deepseek-pwa-tools (borrable)`) para identificarlo fácil.

## RESUELTO (2026-09-23) — Tool-calling por texto: implementado y verificado real

Medido con datos reales en `CONTRACT.md` → "Investigación: tool-calling por TEXTO..." (8/8 tareas, 15/15 llamadas exactas) e **implementado y verificado real** en `CONTRACT.md` → "Implementación real: puente de tool-calling por texto" (6/6 puntos, incluido el diálogo de aprobación real en Aprobar Y Rechazar). El fix de `\n`/`\t` del parser (ítem 1 de esta lista, antes) ya está aplicado. El diseño de UI (ítem 4, antes) ya está decidido e implementado: los `TOOL_CALL`/`TOOL_RESULT` crudos NUNCA se muestran en el chat -- se ocultan via el "gate" de streaming, y se reflejan como pasos reales (`item/toolCall/status`, mismo mecanismo que "Pensamiento profundo") en el resumen colapsable del turno, igual que las tools nativas de otros runtimes.

Queda real, para una eventual iteración futura (no pedida, no bloqueante):

1. **No se probó** qué pasa si el usuario interviene manualmente en "Ver DeepSeek" a mitad de un intercambio de tool-calling (debería quedar cubierto por el manejo de intervención humana ya existente del puente, pero sin verificar en esta pasada).
2. **`capabilities.tools` del modelo sigue en `false`** por defecto para providers `deepseek-pwa` nuevos (decisión explícita, ver "Alcance" en `CONTRACT.md`) -- cosmético, no afecta el mecanismo real, pero podría confundir a código futuro que filtre modelos por esa capability sin saber de este puente.
3. **Sin toggle de "modo tools"** (decisión de diseño documentada) -- si en el futuro se quiere un chat DeepSeek PWA genuinamente "sin acceso a nada", hoy no hay forma de desactivar el protocolo por chat (siempre viaja en el primer mensaje).
4. **~19 conversaciones reales de prueba adicionales** quedaron en la cuenta real durante esta implementación (chat `BRIDGE-VERIFY-1` + sus reintentos), sumadas a las ~13 de la medición de confiabilidad anterior -- ninguna se borró, mismo criterio de siempre. Todas identificables por sus títulos locales (`RELIAB-`/`BRIDGE-VERIFY-`).

## RESUELTO (2026-09-23) — Corrección de alcance: catálogo completo (47 tools) + gates reales de Familia A/B

Medido y verificado real en `CONTRACT.md` → "Corrección de alcance: catálogo completo de tools" (mismos 6 puntos de siempre + 2 nuevos: Familia B rechazada de verdad sin bloquear la maquina real, Familia A bloqueada en Capa 1 sin mostrar dialogo). El catalogo ofrecido a DeepSeek ahora es TODO `TOOL_DEFINITIONS` (47 tools reales), en formato compacto, con los mismos 3 filtros de visibilidad que el camino API ya usa (orquestador/web-search/plan-mode). El `ExecuteContext` del branch `deepseek-pwa` ahora wirea `hardConfirm`/`computerUseActive`/navegador embebido/etc., con los MISMOS closures reales del camino API -- ninguna logica de seguridad nueva.

Queda real, para una eventual iteración futura (no pedida, no bloqueante):

1. **`lspManager`/`terminalExec` sin infraestructura propia** para conexiones DeepSeek PWA (`session.lspManager`/`session.terminalManager` quedan `null` -- esos managers solo se crean hoy para runtimes API, `connectSessionForWindow()`) -- `get_diagnostics`/`find_definition`/`find_references`/`list_symbols`/`terminal_exec` estan en el catalogo pero degradan con su mensaje honesto de "no disponible" si DeepSeek las pide. Habilitarlas de verdad requeriria crear esos managers tambien para esta conexion, una ampliacion aparte.
2. **`mcpManager` no wireado** -- las tools MCP no son parte de `TOOL_DEFINITIONS` (son dinamicas por servidor), fuera del alcance de esta corrección.
3. **Orquestador (`send_to_window`/`list_windows`/`parallel_ask`) wireado pero sin probar en vivo** -- los closures estan armados y el filtro de catalogo los oculta fuera del chat principal (mismo criterio que el camino API), pero esta pasada no incluyo un segundo chat/panel real para ejercitar una orquestacion de punta a punta.
4. **Formato compacto (primera oracion, 160 caracteres) es una decision propia, no un numero pedido** -- si en el futuro se ve que DeepSeek necesita mas contexto de una tool en particular para usarla bien, el recorte podria ajustarse por tool en vez de un limite global fijo.
5. **~6 conversaciones reales de prueba adicionales** quedaron en la cuenta real durante esta corrección (reusando el chat `BRIDGE-VERIFY-1` ya existente), ninguna se borró, mismo criterio de siempre.
