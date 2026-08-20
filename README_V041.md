# Universal Agent Studio V0.4.1

## Corrección de V0.4.0

V0.4.0 quedó más pesada y el composer seguía tapando el panel de configuración.

V0.4.1 hace rollback del overlay pesado:

- el composer vuelve al layout normal;
- ya no usa `position: fixed`;
- `Modelos y cuentas` queda con z-index muy superior;
- el panel de eventos solo aparece al pulsar `Eventos`.

## Corrección de respuesta Codex

Según el app-server, `turn/start` responde con un turn inicial y luego transmite eventos como `item/agentMessage/delta`, `item/completed` y `turn/completed`.

V0.4.1 lee texto de:

- `item/agentMessage/delta`
- `item/completed` con `agentMessage`
- `turn/completed` buscando `turn.items[]`
- resultado directo de `sendMessage`

También agrega eventos crudos desde el main process para poder diagnosticar si Codex no emite nada.

## Prueba

```powershell
npm install
npx install-electron --no
npm run typecheck
npm run dev
```

Después:

1. selecciona workspace;
2. envía `hola`;
3. si no responde, pulsa `Eventos`;
4. copia el JSON que salga.
