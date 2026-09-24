import { app, BrowserWindow } from 'electron'
import { clearAntigravityHomeDir, ensureStorageRootOrExit, getAppDataRoot } from './app-paths'
import { loadSettings, saveSettings } from './settings-store'
import { sanitizeSettings } from './settings-provisioning'
import { codexAccountBridge, disconnectAllSessions, settings, setSettings } from './runtime-state'
import { createAppWindow } from './window-manager'
import { registerWindowIpc } from './ipc-window'
import { registerSettingsIpc } from './ipc-settings'
import { registerChatsIpc } from './ipc-chats'
import { registerCliIpc } from './ipc-cli'
import { registerProjectsAndWorkspaceIpc } from './ipc-projects-workspace'
import { registerAttachmentsIpc } from './ipc-attachments'
import { registerAgentIpc } from './ipc-agent'
import { registerAgentsMdIpc } from './ipc-agents-md'
import { registerMcpIpc } from './ipc-mcp'
import { registerOpenAiChatCatalogIpc } from './ipc-openai-chat-catalog'
import { registerFoundryCatalogIpc } from './ipc-foundry-catalog'
import { registerGeminiCatalogIpc } from './ipc-gemini-catalog'
import { startMcpApprovalPipeServer, stopMcpApprovalPipeServer } from './mcp-approval-pipe'
import { registerVideoFrameProtocolScheme } from './video-frame-reader'
import { registerModel3DProtocolScheme } from './model-3d-reader'
import { waitForProcessTreeKills } from './process-tree'

// Storage centralizado: TODO lo que Amatista (y Electron internamente:
// cache, cookies, local storage) escribe en disco vive bajo D:\AMATISTA\data.
// Nunca hay fallback silencioso a C:\ — si la unidad D:\ no existe, la app
// muestra un dialogo bloqueante y cierra. Ver src/main/app-paths.ts.
ensureStorageRootOrExit()
app.setPath('userData', getAppDataRoot())

// extract_video_frame (F2, docs/_arch/verify_native_multimodal_tools_design.md): el esquema privilegiado del
// protocolo que sirve el video activo a la ventana oculta DEBE registrarse antes de que la app este "ready" --
// requisito real de Electron (protocol.registerSchemesAsPrivileged()), sin importar que la tool en si arranque
// perezosa (recien en el primer uso real). Ver video-frame-reader.ts.
registerVideoFrameProtocolScheme()
// render_3d_model (F3, mismo motivo/requisito exacto que extract_video_frame arriba): el esquema del protocolo
// que sirve el shell/bundle de three.js/modelo activo a la ventana oculta debe registrarse antes de "ready".
registerModel3DProtocolScheme()

// Infraestructura de aislamiento de Antigravity CLI (docs/_arch/
// verify_antigravity_cli.md) -- mecanismo GARANTIZADO, corre en cada
// arranque sin depender de que la sesion anterior haya cerrado prolijo
// (a diferencia del cleanup de before-quit mas abajo, best-effort). Corre
// ANTES de registrar cualquier IPC -- ninguna sesion real de `agy` puede
// existir todavia en este punto (no esta integrado a ningun runtime aun),
// pero deja la carpeta limpia desde el primer momento en que alguien la use.
clearAntigravityHomeDir()

// Verificacion aislada del canal de aprobacion para el futuro servidor MCP
// propio de Amatista (docs/_arch/verify_mcp_approval.md) -- pieza sola,
// nada de esto es Fase 1 completa todavia. Arranca temprano, junto a la
// limpieza de Antigravity, antes de cualquier IPC -- el listener no
// depende de que exista ninguna ventana/sesion todavia.
startMcpApprovalPipeServer()

registerWindowIpc()
registerSettingsIpc()
registerChatsIpc()
registerCliIpc()
registerProjectsAndWorkspaceIpc()
registerAttachmentsIpc()
registerAgentIpc()
registerAgentsMdIpc()
registerMcpIpc()
registerOpenAiChatCatalogIpc()
registerFoundryCatalogIpc()
registerGeminiCatalogIpc()

app.whenReady().then(() => {
  // Reintegracion de claude-cli: preferSubscriptionFallback=true SOLO al
  // arrancar la app (mismo criterio pre-dec378c) -- si el proveedor activo
  // no existe o es Claude API-key, se prefiere Claude Pro por suscripcion
  // como fallback. settings:save (ipc-settings.ts) sigue llamando
  // sanitizeSettings() sin el flag (default false): un guardado normal
  // nunca debe forzar el cambio de proveedor activo por su cuenta.
  setSettings(sanitizeSettings(loadSettings(), true))
  saveSettings(settings)
  createAppWindow()
  // Fase Paneles-1: windowRegistry (Fase 22a) se retiro por completo -- la
  // pregunta "hay alguna ventana abierta" ahora se responde con la API
  // nativa de Electron directo, sin necesitar un registro propio.
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createAppWindow()
  })
})

// Limpieza de Antigravity CLI al cerrar -- PLUS, no garantizado (a
// diferencia del clearAntigravityHomeDir() de arriba, que corre siempre al
// arrancar): best-effort, nunca bloquea el cierre real de la app si falla.
// `before-quit` (no `window-all-closed`) a proposito -- es el hook real de
// Electron que corre una sola vez antes de que la app efectivamente cierre,
// en cualquier plataforma (incluido Cmd+Q en macOS, que NO dispara
// window-all-closed si no hay ventanas para cerrar).
app.on('before-quit', () => {
  stopMcpApprovalPipeServer()
  try {
    clearAntigravityHomeDir()
  } catch {
    // Best-effort: si falla (carpeta bloqueada, etc.) no bloquea el cierre.
    // El proximo arranque la limpia igual via el mecanismo garantizado.
  }
})

app.on('window-all-closed', () => {
  // Fase 22b: antes "la unica conexion" y "toda la app" eran lo mismo --
  // ahora hay que desconectar TODAS las sesiones reales, no una sola.
  disconnectAllSessions()
  codexAccountBridge.stop()
  // Esperar (con tope) a que taskkill termine de cortar cada arbol: si la app
  // sale antes, lo que lanzaron los CLI/servidores queda huerfano igual. Ver
  // process-tree.ts.
  if (process.platform !== 'darwin') void waitForProcessTreeKills(3000).then(() => app.quit())
})
