# Universal Agent Studio V0.3.3

## Corrección principal

Codex / ChatGPT subscription deja de comportarse como una API manual.

Universal Agent usa directamente el protocolo oficial de `codex app-server`:

- `account/read`
- `account/login/start`
- `account/logout`
- `model/list`

## Login

`Conectar ChatGPT` solicita al app-server el `authUrl` oficial y Universal Agent
lo abre en el navegador.

Universal Agent:
- no pide tu correo;
- no pide tu contraseña;
- no lee cookies;
- no extrae tokens del navegador.

Si tu cuenta ChatGPT usa Google, eliges Google dentro del login oficial.

## Modelos Codex

No se hardcodean.

El botón:

```text
Sincronizar modelos
```

consulta `model/list` y rellena el selector con el catálogo que tu versión actual
de Codex y tu cuenta realmente anuncian.

Esto evita mantener listas manuales como 5.5, 5.6 Sol, Terra, Luna, etc.

## ChatGPT vs Codex

Una suscripción ChatGPT puede autenticar Codex, pero Universal Agent V0.3.3
consume los modelos que `codex app-server` expone para el runtime Codex.

No se finge que todos los modelos visibles en la aplicación ChatGPT de escritorio
sean automáticamente modelos Codex programáticos.

## Borrado

Cada conexión muestra siempre:

```text
Eliminar
```

a su derecha.

Cada modelo muestra:

```text
Desactivar
Quitar
```

## Foundry

Foundry conserva configuración manual:

- endpoint;
- API key;
- deployment/model.

## Ejecución

```powershell
npm install
npx install-electron --no
npm run typecheck
npm run dev
```
