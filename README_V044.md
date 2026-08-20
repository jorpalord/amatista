# Universal Agent Studio V0.4.4

## Corrección de typecheck

V0.4.3 fallaba con:

```text
Cannot find name 'setNotice'
Cannot find name 'setMessagesFor'
```

Causa:
`appendAssistantMessage` y `appendSystemMessage` habían quedado fuera del componente `App()`,
pero usaban estados/herramientas de React que solo existen dentro de `App()`.

Corrección:
las dos funciones fueron movidas dentro de `App()`, justo después de `setMessagesFor()`.

## Uso

```powershell
npm install
npx install-electron --no
npm run typecheck
npm run dev
```

Mantiene los cambios de V0.4.3:

- Importar `q_config.yaml`
- Instalar Gemini CLI
- Gemini como ruta prioritaria
- Foundry importado desde q_config
- errores Codex visibles
- filtro para no reflejar `userMessage`
