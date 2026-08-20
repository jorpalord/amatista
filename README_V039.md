# Universal Agent Studio V0.3.9

## Corrección crítica

Corrige:

```text
TypeError: Object has been destroyed
```

Ese error ocurría cuando un proceso hijo de Codex/CLI terminaba e intentaba enviar eventos a `mainWindow.webContents` después de que la ventana principal ya estaba destruida, cerrándose o recargándose.

## Cambios

- `sendAgentEvent` ahora usa guardas:
  - `mainWindow`
  - `!mainWindow.isDestroyed()`
  - `!mainWindow.webContents.isDestroyed()`
- envíos a renderer se hacen mediante `sendToRenderer()`;
- eventos fullscreen usan el mismo envío seguro;
- `closed` limpia agente y pone `mainWindow = null`;
- `disconnectAgent()` ahora es idempotente y remueve listeners antes de parar procesos hijos.

## Nota

El warning de Electron:

```text
Passing args to a child process with shell option true...
```

no es el crash principal. Queda pendiente reducir `shell: true` después, pero no bloquea el funcionamiento.

## Uso

```powershell
npm install
npx install-electron --no
npm run typecheck
npm run dev
```
