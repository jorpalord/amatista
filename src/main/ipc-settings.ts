// Canales IPC de configuracion: reset de estado local y get/save de
// AppSettings.
//
// Retiro real del flujo de importacion de q_config.yaml (usuario, en vivo:
// "eliminá el flujo de q_config.yaml por completo") -- ver el comentario de
// cabecera de settings-provisioning.ts para el detalle completo. Este
// archivo perdio el handler 'settings:importQConfig' entero (dialog de
// seleccion de archivo YAML, parseo, merge de proveedores importados) y con
// el la unica razon real para importar `dialog`/`readFileSync`/`parseYaml`
// aca -- ninguno de los 3 tiene otro uso en este archivo.
import { ipcMain } from 'electron'
import { unlinkSync } from 'node:fs'
import path from 'node:path'
import { getAppDataSubdir } from './app-paths'
import { saveSettings } from './settings-store'
import { sanitizeSettings } from './settings-provisioning'
import { disconnectAllSessions, sessionRegistry, settings, setSettings } from './runtime-state'
import type { AppSettings } from '../shared/types'

export function registerSettingsIpc(): void {
  ipcMain.handle('settings:resetLocalState', () => {
    // Fase 22b: reset total de estado local -- generaliza el mismo par de
    // pasos que ya hacia (desconectar + limpiar workspace activo) de 1
    // sesion global a TODAS las sesiones reales, misma condicion de
    // siempre ("borrar todo"), no una clasificacion nueva.
    disconnectAllSessions()
    for (const session of sessionRegistry.values()) session.activeWorkspace = null

    setSettings({
      providers: [],
      projectRoots: [],
      activeProviderId: undefined,
      activeModelId: undefined,
      activeProjectPath: undefined
    })

    try {
      unlinkSync(path.join(getAppDataSubdir('config'), 'settings.json'))
    } catch {
      // settings.json puede no existir
    }

    saveSettings(settings)
    return settings
  })

  ipcMain.handle('settings:get', () => settings)
  /**
   * Fix real de la carrera de settings:save (investigacion completa en
   * docs/_arch/verify_settings_race.md, resumen en CONTRACT.md): este
   * handler dejo de reemplazar `settings` entero con lo que mande el
   * renderer -- ahora fusiona campo por campo, segun quien es dueño real
   * de cada uno (confirmado en la Tarea 4 de esa investigacion, no
   * supuesto):
   *
   * - `providers`/`compactionProviderId`/`compactionModelId`/
   *   `turnWatchdogSeconds`: genuinamente editados por el usuario desde
   *   Configuracion, main nunca los toca de forma autonoma en vivo --
   *   toman el valor del payload (via sanitizeSettings(), misma
   *   validacion/migracion de siempre, sin cambios).
   * - `activeProviderId`/`activeModelId`/`activeProjectPath`/
   *   `projectRoots`: escritos de forma autonoma por MAIN (via
   *   withSettingsLock() en connectSessionForWindow()/workspace:open(),
   *   o por projects:addRoot()/removeRoot() de este mismo archivo) como
   *   efecto secundario de acciones del usuario que NO pasan por
   *   Configuracion -- el renderer nunca vuelve a pedir `settings:get`
   *   despues del arranque (confirmado real, Tarea 2 de la
   *   investigacion), asi que CUALQUIER copia que mande en su payload
   *   para estos 4 campos puede estar arbitrariamente vieja. Se IGNORAN
   *   por completo del payload entrante -- ni se comparan, main siempre
   *   gana con su propio valor VIVO (`settings`, leido en el momento
   *   exacto de este handler, sin ningun `await` de por medio -- mismo
   *   criterio de atomicidad ya establecido para withSettingsLock()).
   *
   * Confirmado con reproduccion real (Tarea 3 de la investigacion) que
   * sin este fix, cualquiera de los 12 sitios de App.tsx que disparan
   * settings:save podia revertir en silencio una conexion real de OTRO
   * panel -- no una carrera de milisegundos, una perdida garantizada bajo
   * el orden de eventos mas comun (main escribe, despues el renderer
   * guarda con su copia nunca refrescada).
   */
  ipcMain.handle('settings:save', (_event, nextSettings: AppSettings) => {
    const sanitized = sanitizeSettings(nextSettings)
    setSettings({
      ...settings,
      providers: sanitized.providers,
      compactionProviderId: sanitized.compactionProviderId,
      compactionModelId: sanitized.compactionModelId,
      turnWatchdogSeconds: sanitized.turnWatchdogSeconds,
      // Feature "generacion de imagenes": mismo criterio que
      // compactionProviderId/compactionModelId de arriba -- editados
      // genuinamente por el usuario desde Configuracion, main nunca los
      // toca de forma autonoma en vivo. CRITICO agregarlos aca: sin esto,
      // cualquier cambio real del usuario en el selector de Settings se
      // ignora en silencio -- exactamente el bug que motivo este merge
      // campo-por-campo (ver CONTRACT.md, fix de la carrera de
      // settings:save) para los otros 4 campos.
      imageGenerationProviderId: sanitized.imageGenerationProviderId,
      imageGenerationModelId: sanitized.imageGenerationModelId,
      // Feature "busqueda web" (docs/_arch/verify_external_review_2_findings.md,
      // Hallazgo 3): mismo criterio que los campos de arriba -- editado
      // genuinamente por el usuario desde Configuracion (saveTavilyApiKey(),
      // App.tsx), main nunca lo toca de forma autonoma en vivo. CRITICO
      // agregarlo aca: sin esto, la API key de Tavily que el usuario carga y
      // guarda se descartaba en silencio (el handler devolvia success:true
      // igual) y web_search/web_fetch nunca aparecian en el catalogo pese a
      // configurarlas -- exactamente el mismo modo de falla de allowlist que
      // ya advertia el comentario de imageGeneration* de arriba. sanitized
      // lo trae intacto (sanitizeSettings() lo preserva via spread, no toca
      // integrations); el CIFRADO real de la apiKey lo hace saveSettings()
      // aguas abajo (settings-store.ts), no se duplica aca.
      integrations: sanitized.integrations,
      // Presets simples (docs/_arch/verify_external_review_2_findings.md,
      // Hallazgo 2): mismo criterio que integrations/imageGeneration* de
      // arriba -- editados genuinamente por el usuario desde Configuracion
      // (addPreset/savePresetDraft/deletePreset, App.tsx), main nunca los
      // toca de forma autonoma. Sin esto, cualquier preset creado/editado se
      // descartaba en silencio (el handler devolvia success:true igual) --
      // ademas de la 2da falla apilada, ya arreglada, de que saveSettings()/
      // loadSettings() tampoco los contemplaban (se perdian en cada
      // reinicio). sanitized los trae intactos (sanitizeSettings() preserva
      // presets via spread, no los toca).
      presets: sanitized.presets
    })
    saveSettings(settings)
    return { success: true }
  })
}
