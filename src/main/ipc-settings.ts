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
   * Sentinel real (docs/_arch/verify_settings_allowlist_safety_design.md):
   * reemplaza el objeto literal anterior (10 de las 14 claves reales de
   * AppSettings, copiadas a mano una por una en cada `setSettings({...})`)
   * -- ese patron ya fallo 4 veces en silencio (maxToolLoop/Tavily(`integrations`)/
   * presets/computerUseAcknowledged, ver docs/_arch/HISTORY.md): agregar un
   * campo nuevo a `AppSettings` sin acordarse de sumarlo tambien aca no
   * rompia nada visible -- el handler seguia devolviendo `success:true`,
   * el campo simplemente nunca sobrevivia el guardado real.
   *
   * `Record<keyof AppSettings, ...>` obliga a TypeScript a exigir las 14
   * claves reales de la interfaz -- agregar un campo nuevo a `AppSettings`
   * (shared/types.ts) SIN clasificarlo aca es, desde este cambio, un ERROR
   * DE COMPILACION real (`tsc`/`npm run build`/`npm run dist` fallan), no
   * un bug silencioso que recien se nota cuando alguien reporta que su
   * configuracion "no se guarda". Verificado real agregando un campo
   * ficticio de prueba a AppSettings sin clasificarlo aca -- confirmado que
   * `tsc` lo rechaza con un error claro, revertido despues (ver
   * verify_settings_allowlist_safety_design.md).
   *
   * `'renderer'`: el usuario lo edita genuinamente desde Configuracion,
   * main nunca lo toca de forma autonoma en vivo -- toma el valor del
   * payload (via sanitizeSettings(), misma validacion/migracion de
   * siempre). `'main'`: escrito de forma autonoma por MAIN (via
   * withSettingsLock() en connectSessionForWindow()/workspace:open(), o
   * por projects:addRoot()/removeRoot() de este mismo archivo) como efecto
   * secundario de acciones del usuario que NO pasan por Configuracion -- el
   * renderer nunca vuelve a pedir `settings:get` despues del arranque
   * (confirmado real, docs/_arch/verify_settings_race.md), asi que
   * CUALQUIER copia que mande en su payload para estos 4 campos puede
   * estar arbitrariamente vieja. Se IGNORAN por completo del payload
   * entrante -- ni se comparan, main siempre gana con su propio valor VIVO.
   *
   * Confirmado con reproduccion real (docs/_arch/verify_settings_race.md)
   * que sin esta distincion, cualquiera de los sitios de App.tsx que
   * disparan settings:save podia revertir en silencio una conexion real de
   * OTRO panel -- no una carrera de milisegundos, una perdida garantizada
   * bajo el orden de eventos mas comun (main escribe, despues el renderer
   * guarda con su copia nunca refrescada). Invertir el criterio a blacklist
   * (aceptar todo salvo estos 4) reabriria esa misma carrera, mas grave
   * todavia -- un campo `'main'` nuevo olvidado se ACEPTARIA del payload
   * stale en vez de perderse, corrompiendo estado en vivo real, no solo un
   * setting que no persiste.
   */
  const SETTINGS_FIELD_OWNER: Record<keyof AppSettings, 'renderer' | 'main'> = {
    providers: 'renderer',
    projectRoots: 'main',
    activeProviderId: 'main',
    activeModelId: 'main',
    activeProjectPath: 'main',
    compactionProviderId: 'renderer',
    compactionModelId: 'renderer',
    turnWatchdogSeconds: 'renderer',
    maxToolLoop: 'renderer',
    imageGenerationProviderId: 'renderer',
    imageGenerationModelId: 'renderer',
    integrations: 'renderer',
    presets: 'renderer',
    computerUseAcknowledged: 'renderer',
    // Navegador embebido: mismo criterio exacto que computerUseAcknowledged.
    browserControlAcknowledged: 'renderer'
  }

  /** Asignacion generica campo por campo -- una funcion aparte (en vez de
   *  `merged[key] = sanitized[key]` inline dentro del loop de abajo) porque
   *  TypeScript no infiere correctamente que ambos lados de la asignacion
   *  comparten el mismo `K` cuando `key` viene de iterar `Object.keys()` de
   *  un `Record` con `keyof AppSettings` como tipo de clave -- con `K`
   *  ligado explicito en la firma de esta funcion, si compila limpio. */
  function copyOwnedField<K extends keyof AppSettings>(target: AppSettings, source: AppSettings, key: K): void {
    target[key] = source[key]
  }

  ipcMain.handle('settings:save', (_event, nextSettings: AppSettings) => {
    const sanitized = sanitizeSettings(nextSettings)
    const merged: AppSettings = { ...settings }
    for (const key of Object.keys(SETTINGS_FIELD_OWNER) as Array<keyof AppSettings>) {
      if (SETTINGS_FIELD_OWNER[key] === 'renderer') copyOwnedField(merged, sanitized, key)
    }
    setSettings(merged)
    saveSettings(settings)
    return { success: true }
  })
}
