# V0.3.2 Typecheck Fix

Corregido:
- las funciones del Auth Manager habían quedado insertadas accidentalmente dentro de `asRecord()`;
- `authMessage` no estaba declarado dentro de `App()`;
- se eliminó la duplicación estructural responsable de los 45 errores TypeScript.

Ejecutar:

```powershell
npm run typecheck
```

y después:

```powershell
npm run dev
```
