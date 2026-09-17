# Contribuir a Amatista

Este es un proyecto de una sola persona, recién publicado. No hay todavía un proceso formal de revisión, ni un equipo de mantenedores, ni un checklist de PR — sería inventar una estructura que no existe. Esto describe lo que sí hay: la disciplina real con la que se construyó el proyecto hasta ahora (contada en primera persona en [ORIGEN.md](ORIGEN.md)), para que cualquiera que quiera seguir esa misma línea sepa dónde mirar.

## La convención real

Cada fase, feature o fix de este proyecto quedó documentado en tres archivos, siempre bajo el mismo criterio: **verificado de verdad, nunca asumido**.

- [`docs/_arch/CONTRACT.md`](docs/_arch/CONTRACT.md) — los contratos de interfaces/tipos/invariantes vigentes, con la verificación real de cada fix/feature (qué se probó, cómo, y qué mostró la evidencia).
- [`docs/_arch/HISTORY.md`](docs/_arch/HISTORY.md) — bitácora append-only, una entrada por fase/fix, en orden.
- [`docs/_arch/PENDING.md`](docs/_arch/PENDING.md) — lo que sigue abierto, lo descartado explícitamente (con motivo real), o lo resuelto.

Si le sumás algo a Amatista, la única expectativa real es esa: documentá el cambio con el mismo cuidado, en el mismo lugar. No hace falta que sea perfecto — hace falta que sea honesto sobre qué probaste y qué no.

## Cómo proponer un cambio

No hay una plantilla de PR ni un flujo formal todavía. Lo más simple:

1. Abrí un Issue describiendo el problema o la feature antes de escribir código, si el cambio no es trivial — evita trabajo duplicado o en una dirección que no encaja.
2. Si tocás algo relacionado con Familia A (control de escritorio) o cualquier otra tool de riesgo, leé primero [`SECURITY.md`](SECURITY.md) — el modelo de seguridad existente (gate de activación, aprobación de 2 capas, panic key) no debería debilitarse sin una razón real y documentada.
3. Mandá el PR con una descripción real de qué cambiaste y cómo lo verificaste — no hace falta un formato específico, pero "funciona en mi máquina" sin más detalle no alcanza para un proyecto que controla el escritorio del usuario.

## Reportar bugs

Un Issue con pasos reales para reproducir alcanza. Si el bug tiene implicancias de seguridad, ver la sección de reporte en [`SECURITY.md`](SECURITY.md) en su lugar.
