# Auditoría V0.3.4

## Bugs corregidos

- El workspace ya no borra el chat.
- Cuenta ChatGPT conectada ya no se confunde con modelo/agente conectado.
- Modelo activo se reconcilia y persiste.
- Proyecto activo se persiste.
- Codex sincroniza modelos automáticamente.
- Foundry conserva API-key header correcto.
- OpenAI/API-compatible usan `env_key` correctamente.
- Eliminar/desactivar conexiones y modelos persiste inmediatamente.
- El composer explica qué estado falta.
- Existe un botón explícito `Conectar agente`.

## Revisión de modos

### Codex subscription
Operativo con app-server y OAuth ChatGPT.

### Foundry API
Operativo mediante custom provider Codex Responses.

### OpenAI API / Responses-compatible
Operativo mediante custom provider Codex.

### Claude subscription
Runtime headless Claude Code agregado.

### Claude API
Mismo runtime CLI, con `ANTHROPIC_API_KEY` aislada al proceso.

### Gemini Google subscription
Runtime headless Gemini CLI agregado.

### Gemini API
Mismo runtime CLI, con `GEMINI_API_KEY` aislada al proceso.

## Verificación hecha en el entorno de construcción

- 14 archivos TS/TSX pasaron parse/transpile de TypeScript sin errores de sintaxis.
- `App.tsx` pasó un typecheck aislado con stubs de React y las declaraciones reales de `window.universalAgent`.
- No fue posible ejecutar `npm install` en el entorno de construcción porque su registry interno no contiene `@monaco-editor/react@4.7.0`; esto no es un error del proyecto ni cambia las versiones que ya instalaron correctamente en Windows.
