# Universal Agent Studio V0.3.7

## Corrección real del problema reportado

Aunque borres la carpeta del proyecto, Electron conserva datos en:

```text
%APPDATA%/Universal Agent Studio
```

Por eso volvían a aparecer workspaces/conexiones anteriores.

V0.3.7 agrega:

- `Reiniciar configuración local`;
- remover carpeta raíz desde la UI con `Quitar`;
- reset de `settings.json` en `userData`;
- limpieza de proyecto activo/modelo/agente;
- composer fijo contra el viewport;
- scroll real en proyectos;
- `Nuevo chat` ahora deja una marca visible.

## Uso

```powershell
npm install
npx install-electron --no
npm run typecheck
npm run dev
```

Si ves datos viejos:

1. pulsa `Reiniciar configuración local`;
2. confirma;
3. agrega de nuevo `D:\APLICACIONES` u otra raíz;
4. selecciona workspace;
5. verifica que el composer queda visible abajo.

`Reiniciar configuración local` no borra archivos del disco.
