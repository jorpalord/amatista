# Universal Agent Studio V0.3.2 — Auth Manager

## Nuevo

- eliminar proveedor/conexión;
- activar/desactivar proveedor;
- eliminar modelo;
- activar/desactivar modelo;
- iniciar sesión con el CLI oficial;
- comprobar sesión;
- cerrar sesión cuando el CLI lo permita;
- API key continúa como alternativa.

## Login

Universal Agent no pide correo ni contraseña.

Usa:
- Codex CLI para ChatGPT/Codex;
- Claude Code CLI para Claude;
- Gemini CLI para Google/Gemini.

Si usas la misma cuenta Google en los tres servicios, cada servicio sigue realizando su propia autorización.

## Seguridad

- no se guardan contraseñas;
- no se extraen cookies;
- no se copian tokens OAuth del navegador;
- API keys siguen cifradas con Electron safeStorage.
