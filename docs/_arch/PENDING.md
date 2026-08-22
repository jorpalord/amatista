# PENDING.md — Backlog de Fases

> Tareas identificadas pero no ejecutadas todavía. El arquitecto las prioriza.

## RESUELTO (Fase 3) — Pérdida real de contexto

> Confirmado con evidencia en Fase 1 Tarea C, diseño fijado en la ronda de decisiones previa a Fase 3, implementado en Fase 3. El detalle completo del bug original (tres constantes triplicadas, fórmula exacta del hueco `[0, N-26)`, alcance por runtime) queda preservado en [CONTRACT.md](./CONTRACT.md) → "Contrato de memoria/contexto — v1 (DEPRECATED, ver v2)" — no se repite acá. El diseño vigente está en la v2 de esa misma sección.
>
> Resuelto para runtimes API (`anthropic-api`, `foundry`, `gemini-api`): compactación real vía LLM, persistida en SQLite por chat (`summary` + `summary_watermark_id`, watermark por id de mensaje — inmune a ediciones/borrados), disparada asíncronamente después de cada turno sin agregar latencia. De paso se corrigió un segundo bug real encontrado durante la implementación: `foundry` y `gemini-api` nunca leían `compactSummary` en absoluto (ni siquiera el truncado viejo) — solo `anthropic-api` lo usaba.
>
> **Caveat documentado, no oculto** (ver CONTRACT.md v2): en un chat viejo retomado con backlog grande nunca compactado, puede haber un hueco transitorio entre resumen y ventana verbatim en los primeros turnos post-actualización — se cierra en pasadas sucesivas de compactación, nunca de una sola vez. Ningún dato se pierde nunca (SQLite persiste todo siempre); el hueco, cuando existe, es solo de lo que un turno puntual le manda al modelo.

## Sin priorizar (originado en el cierre de Fase 3)

- **¿Los runtimes CLI (`claude-cli`, `codex-subscription`) también necesitan un mecanismo de compactación propio?** Quedaron fuera de alcance de Fase 3 por decisión explícita (dependen de `--resume <sessionId>` del binario externo para memoria de turnos posteriores al primero). No se investigó qué tan bien retiene contexto ese mecanismo externo en chats muy largos — si "urge" o no queda sin evaluar.

## Encontrado durante refactor (Fase 2)

**Mismatch de tipos `activeProjectPath` en `ipc-agent.ts`.**

- `activeWorkspace` está tipado `string | null` (`runtime-state.ts`); `AppSettings.activeProjectPath` está tipado `string | undefined` (`shared/types.ts`).
- En el `index.ts` monolítico original, la asignación `activeWorkspace = payload.workspace?.trim() ? realpathSync(...) : defaultChatWorkspace()` y la lectura de `activeProjectPath: ... ? activeWorkspace : ...` vivían en la misma función del mismo archivo. TypeScript estrecha (`narrowing`) el tipo de una variable local tras una asignación de la que puede seguir el flujo de control dentro de la misma función — por eso `tsc` nunca marcó error ahí, aunque `strict: true` ya estaba activo.
- Al mover el estado a `runtime-state.ts` (Fase 2) y reemplazar la asignación directa por `setActiveWorkspace(...)`, la lectura de `activeWorkspace` en `ipc-agent.ts` pasa a ser un *live binding* importado desde otro módulo. TS no puede probar, a través de una llamada a función en otro módulo, que el valor quedó estrechado a `string` — vuelve a su tipo declarado `string | null`. El error de tipos es un efecto secundario de la partición en módulos, no una regresión de lógica.
- **Fix aplicado:** `activeProjectPath: payload.workspace?.trim() ? activeWorkspace ?? undefined : settings.activeProjectPath` (`ipc-agent.ts:158`).
- **¿Es 100% inocuo en runtime? No estoy seguro — hay que decirlo, no asumirlo:**
  - En el camino normal (sin condiciones de carrera), `activeWorkspace` siempre es un `string` en ese punto: se asigna sin condicionales unas líneas antes en el mismo handler, y nada entre esa asignación y la lectura lo vuelve a poner en `null` (`disconnectAgent()` no toca `activeWorkspace`). Ahí el cambio es puramente cosmético para `tsc`.
  - Pero `ipcMain.handle` en Electron permite que otros canales IPC se intercalen mientras `agent:connect` está en un `await` (p. ej. `client.start()`, `detectClaude()`). Si en esa ventana llega un `projects:removeRoot` cuyo `root.path` matchea el workspace activo, dispara `disconnectAgent()` + `setActiveWorkspace(null)`, y `activeWorkspace` sí podría ser `null` al llegar a la línea 158.
  - En ese escenario (preexistente — la ventana de carrera ya existía en el monolito, solo que TS no la veía por el narrowing local): antes se guardaba literalmente `null` en `activeProjectPath` (violación de tipo silenciosa, JS no la impide en runtime); ahora se guarda `undefined`. Si `settings-store.ts` serializa con `JSON.stringify`, `null` sobrevive como campo `null` y `undefined` se omite del JSON — es una diferencia real de qué queda persistido en `settings.json` para ese caso límite.
  - Conclusión: el fix no cambia el comportamiento del camino feliz, pero **no puedo garantizar que sea 100% inocuo** en el caso de carrera descrito. No se investigó a fondo si esa carrera es alcanzable en la práctica (requeriría que el renderer dispare `projects:removeRoot` durante un `agent:connect` en vuelo) ni si vale la pena blindarla. Queda para priorizar.
