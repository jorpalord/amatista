# Universal Agent Studio V0.4.2

## Qué confirmó el log

Universal Agent sí estaba conectado a Codex:

- `thread/started`
- `mcpServer ready`
- `turn/started`
- `item/completed` con tu mensaje

El problema real fue:

```text
usageLimitExceeded
credits.balance = 0
```

Codex rechazó el turno porque no había crédito/cupo disponible.

## Correcciones

1. Ya no refleja tus propios mensajes como si fueran respuesta del asistente.
   Se filtra `item.type === "userMessage"` y `role === "user"`.

2. El error de Codex ahora aparece visible en el chat como:

```text
ERROR CODEX: You've hit your usage limit...
```

3. Si `turn/completed` viene con `status: failed`, ya no muestra el mensaje genérico de “turno completado sin texto”; muestra el error real.

## Prueba

```powershell
npm install
npx install-electron --no
npm run typecheck
npm run dev
```

Mientras Codex esté sin cupo, el resultado correcto es ver el error de límite en el chat.
Cuando vuelva el cupo, debería responder normalmente.
