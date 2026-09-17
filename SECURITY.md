# Seguridad

Amatista es un proyecto personal, hecho por una sola persona. No hay una organización ni un equipo de seguridad detrás — este documento es honesto sobre eso.

## Qué hace Amatista que amerita cuidado real

Amatista le da a un modelo de IA la capacidad de tomar acciones reales en tu máquina, no solo generar texto:

- **Control de escritorio (Familia A)**: `mouse_click`, `mouse_move`, `keyboard_type`, `screenshot` — control real del mouse/teclado y captura de pantalla de la máquina donde corre Amatista. Es la feature de mayor riesgo del proyecto.
- **Herramientas de sistema Windows (Familia B)**: 12 tools, incluidas 3 destructivas — `close_app`, `lock_screen`, `power` (apagar/reiniciar/suspender).
- **Terminal (`run_command`)**: ejecuta comandos reales del sistema.
- **Navegador embebido**: navega e interactúa con páginas web reales.

### Mitigaciones reales ya implementadas

Ninguna de estas garantiza que algo no pueda salir mal — son capas reales pensadas para reducir el riesgo, no para eliminarlo:

- **Apagado por default**: el control de escritorio y el navegador embebido no existen para el modelo hasta que el usuario los activa explícitamente, panel por panel, tras reconocer una advertencia dura en Configuración.
- **Aprobación de 2 capas**: cada llamada individual a una tool de riesgo pide aprobación humana incondicional — nunca se salta, ni con el sandbox "Acceso completo" activo ni con una confianza de sesión ya otorgada para otra tool.
- **Overlay visual** de pantalla completa mientras una acción de control de escritorio está en curso.
- **Panic key global** (`Ctrl+Alt+Shift+Esc`): cancela el turno completo y desactiva el control de inmediato, sin importar qué panel lo disparó.
- **Cancelación no-cooperativa**: las acciones de mouse/teclado se ejecutan en micro-pasos, chequeados contra cancelación entre cada uno.
- **Guardia monótona en las 3 tools destructivas de Familia B**: piden aprobación explícita siempre, sin excepción, sin importar sandbox o confianza previa.

El detalle técnico completo, con verificación real de cada punto, vive en `docs/_arch/CONTRACT.md`.

## Cómo reportar una vulnerabilidad

No existe un email ni un proceso formal de seguridad — sería inventar algo que no hay. Las dos formas reales de reportar algo acá:

1. **Preferido**: si el repositorio tiene habilitadas las [GitHub Security Advisories](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing/privately-reporting-a-security-vulnerability) (pestaña "Security" → "Report a vulnerability"), usá esa vía — permite reportar en privado antes de que se haga público.
2. **Alternativa**: abrí un [Issue](../../issues) marcado con el label `security`. Si el hallazgo es sensible (ej. permitiría ejecutar código arbitrario sin aprobación), preferí la vía 1 si está disponible.

No hay SLA ni compromiso de tiempo de respuesta — es un proyecto de una sola persona, se atiende cuando se puede.

## Nota honesta

Este es un proyecto personal, sin garantías (ver `LICENSE`, MIT, "AS IS"). Antes de correr algo que puede controlar tu mouse/teclado, ejecutar comandos, o apagar tu máquina — revisá el código. No asumas que porque algo tiene una capa de aprobación es infalible; las capas reducen el riesgo de un error o de un uso malicioso, no lo eliminan.
