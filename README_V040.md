# Universal Agent Studio V0.4.0

## Correcciones

### Panel de modelos tapado por el chat

El composer estaba en `z-index` mayor que el panel de configuración.
Ahora:

- settings panel: z-index 950
- composer: z-index 120
- approval modal: z-index 1100

### Mensajes enviados sin respuesta visible

Se agrega parser amplio para eventos del agente:

- `delta`
- `text`
- `content`
- `message`
- `output_text`
- `response`
- `result`
- `output`

También procesa el resultado directo de `sendMessage()`.

### Debug real

Se agrega panel:

```text
Eventos del agente
```

Si el agente no responde visualmente, ese panel muestra el evento crudo recibido desde el main process.
Con eso ya no hay que adivinar el protocolo.

## Prueba

```powershell
npm install
npx install-electron --no
npm run typecheck
npm run dev
```

Luego:

1. Selecciona workspace.
2. Envía `hola`.
3. Si no aparece respuesta, abre `Eventos del agente`.
4. Copia el evento que aparezca.
