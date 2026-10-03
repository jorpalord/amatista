// Acceso remoto F0: IPC LOCAL de la PC (renderer <-> main) para administrar el puente. Estos canales NO son
// alcanzables desde la red -- el puente de red (remote-server.ts) tiene su propia API y no pasa por ipcMain.
import { ipcMain } from 'electron'
import { acknowledgeRemoteAccess } from './remote-devices'
import {
  cancelRemotePairing, confirmRemotePairing, getRemoteAccessStatus, revokeAllRemoteDevices, revokeRemoteDevice,
  setRemoteAccessStatusListener, startRemoteAccess, startRemotePairing, stopRemoteAccess
} from './remote-server'
import { sendToShell } from './runtime-state'

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error))

export function registerRemoteAccessIpc(): void {
  setRemoteAccessStatusListener(status => { sendToShell('remote:status', status as unknown as Record<string, unknown>) })

  ipcMain.handle('remote:getStatus', () => getRemoteAccessStatus())

  /** Unico camino al consentimiento: el boton "Entiendo los riesgos" de Configuracion. */
  ipcMain.handle('remote:acknowledge', () => {
    acknowledgeRemoteAccess()
    return getRemoteAccessStatus()
  })

  ipcMain.handle('remote:setEnabled', async (_event, payload: { enabled: boolean }) => {
    try {
      if (payload?.enabled) await startRemoteAccess()
      else await stopRemoteAccess('user')
      return { success: true, status: getRemoteAccessStatus() }
    } catch (error) {
      return { success: false, error: errorText(error), status: getRemoteAccessStatus() }
    }
  })

  ipcMain.handle('remote:startPairing', () => {
    try {
      return { success: true, ...startRemotePairing() }
    } catch (error) {
      return { success: false, error: errorText(error) }
    }
  })
  ipcMain.handle('remote:cancelPairing', () => {
    cancelRemotePairing()
    return { success: true }
  })
  ipcMain.handle('remote:confirmPairing', (_event, payload: { pairingId: string; accept: boolean }) => {
    return { success: confirmRemotePairing(String(payload?.pairingId ?? ''), payload?.accept === true).ok }
  })
  ipcMain.handle('remote:revokeDevice', (_event, payload: { deviceId: string }) => {
    return { success: revokeRemoteDevice(String(payload?.deviceId ?? '')) }
  })
  ipcMain.handle('remote:revokeAll', () => {
    return { success: true, revoked: revokeAllRemoteDevices() }
  })
}
