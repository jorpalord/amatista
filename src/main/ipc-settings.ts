// Canales IPC de configuracion: import de q_config.yaml legado, reset de
// estado local, y get/save de AppSettings.
import { dialog, ipcMain } from 'electron'
import { readFileSync, unlinkSync } from 'node:fs'
import path from 'node:path'
import { parse as parseYaml } from 'yaml'
import { getAppDataSubdir } from './app-paths'
import { saveSettings } from './settings-store'
import { buildProvidersFromQConfig, mergeImportedProviders, sanitizeSettings } from './settings-provisioning'
import { disconnectAllSessions, sessionRegistry, settings, setSettings } from './runtime-state'
import type { AppSettings } from '../shared/types'

export function registerSettingsIpc(): void {
  ipcMain.handle('settings:importQConfig', async () => {
    const result = await dialog.showOpenDialog({
      title: 'Importar q_config.yaml',
      properties: ['openFile'],
      filters: [
        { name: 'YAML', extensions: ['yaml', 'yml'] },
        { name: 'Todos', extensions: ['*'] }
      ]
    })

    if (result.canceled || result.filePaths.length === 0) {
      return {
        canceled: true,
        settings,
        summary: []
      }
    }

    const filePath = result.filePaths[0]
    const raw = readFileSync(filePath, 'utf8').replace(/^﻿/, '')
    const parsed = parseYaml(raw)

    const imported = buildProvidersFromQConfig(parsed)
    setSettings(mergeImportedProviders(
      settings,
      imported.providers,
      imported.preferredProviderId,
      imported.preferredModelId
    ))

    saveSettings(settings)

    return {
      canceled: false,
      settings,
      summary: imported.summary
    }
  })

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
      turnWatchdogSeconds: sanitized.turnWatchdogSeconds
    })
    saveSettings(settings)
    return { success: true }
  })
}
