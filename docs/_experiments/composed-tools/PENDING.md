# PENDING.md — Backlog del experimento composed-tools

## Antes de commitear (decisión del usuario)

1. ~~**Composición de la rama.**~~ **RESUELTO**: merge real de `experiment/deepseek-pwa-tools` (idéntico al índice del cherry-pick) y después el commit de herramientas compuestas encima, sin duplicar el puente.
2. **`.amatista/composed-tools/` dentro de los proyectos reales**: decidir si se sugiere agregarlo al `.gitignore` del proyecto o si las recetas se versionan. Hoy, como la clave de firma es por máquina, una receta copiada a otra máquina no corre y habría que re-aprobarla.

## Real, no bloqueante para v1

1. **Bug previo de `gemini-api`** ("El turno termino sin texto de assistant." en todo turno, aunque la respuesta se vea bien), ajeno a esta feature. Propuesto como tarea aparte.
2. **Catálogo de DeepSeek PWA**: las recetas solo viajan en el primer mensaje de una conversación nueva.
3. ~~**Parser del protocolo de texto**: un JSON de receta con `)` dentro de un string rompe `TOOL_CALL_RE` (solo en DeepSeek PWA).~~ **RESUELTO** después, en master, por el fix del parser TOOL_CALL (`docs/_arch/CONTRACT.md`).
4. **UI de gestión**: listar y borrar recetas desde la app (hoy solo existen como archivos). Sin edición: se borra y se vuelve a proponer.
5. **Progreso paso a paso** dentro de una corrida (hoy se ve "Ejecutando: composed__x" durante toda la corrida; el plan completo sí se ve antes, en el diálogo).
6. **CLI**: extender la ejecución de recetas a los runtimes CLI requiere un puente nuevo estilo `mcp-approval-pipe.ts`.
7. **Detector de patrones de Q** (Tarea 6): Fase 2.
8. **Firma verificada en la app real**: la detección de recetas editadas a mano está cubierta por el test de la lógica pura (código real, 48/48), pero no se ejercitó con una edición manual dentro de la app corriendo.
9. **Datos de prueba**: 9 chats locales `COMPOSED-VERIFY-*` "(borrable)" y 1 conversación de prueba en la cuenta real de DeepSeek. Ninguno se borró (mismo criterio de siempre).
