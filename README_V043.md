# Universal Agent Studio V0.4.3

## Objetivo

Habilitar Gemini como ruta prioritaria y cargar configuración desde `q_config.yaml`.

## Cambios

- Botón `Importar q_config.yaml`.
- Botón `Instalar Gemini CLI` cuando Gemini no está instalado.
- Gemini subscription queda como proveedor prioritario después de importar.
- Foundry se importa desde `azure.endpoint`, `azure.api_key`, `azure.model` y `azure.coder_model`.
- Gemini API se crea si existe una API key de Google en el YAML.
- Si no hay Gemini API key en el YAML, queda como conexión desactivada pendiente.
- Groq y Ollama se detectan, pero quedan desactivados porque no son rutas agent estables en esta app todavía.
- Las API keys importadas se guardan mediante `safeStorage` en el `settings.json` de Electron. No se deben hardcodear en el código fuente.

## Instalación Gemini CLI

Desde la app puedes usar el botón `Instalar Gemini CLI`.

También puedes ejecutar:

```powershell
.\scripts\install-gemini-cli.ps1
```

o manualmente:

```powershell
npm install -g @google/gemini-cli@latest
gemini --version
```

## Flujo recomendado

1. `npm install`
2. `npx install-electron --no`
3. `npm run typecheck`
4. `npm run dev`
5. `Modelos y cuentas`
6. `Importar q_config.yaml`
7. Selecciona tu archivo `q_config.yaml`
8. En Gemini subscription, pulsa `Instalar Gemini CLI` si aparece como no instalado.
9. Pulsa `Login con Google`.
10. Usa Gemini Auto o Gemini 2.5 Pro/Flash.
