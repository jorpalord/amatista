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
  ipcMain.handle('settings:save', (_event, nextSettings: AppSettings) => {
    setSettings(sanitizeSettings(nextSettings))
    saveSettings(settings)
    return { success: true }
  })
}
