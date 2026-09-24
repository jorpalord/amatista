// Cortar un proceso hijo CON todo su arbol (hijos, nietos...).
//
// Bug real (2026-09-24): en Windows, ChildProcess.kill() es TerminateProcess
// sobre ESE pid solamente -- lo que ese proceso lanzo sigue vivo como
// huerfano. Encontrado en uso real: 2 `tail -F | grep` que un Claude CLI
// (runtime "claude" de un chat) habia lanzado siguieron corriendo 2 dias
// despues de que el CLI murio. Mismo efecto con spawn(..., {shell: true}) en
// Windows (Codex app-server, servidores MCP): kill() mata solo el cmd.exe
// envoltorio y el servidor real queda vivo. libuv no lo cubre: mete a los
// hijos directos en un job con KILL_ON_JOB_CLOSE pero con
// SILENT_BREAKAWAY_OK, asi que los nietos quedan fuera del job.
//
// Fix: en Windows `taskkill /PID <pid> /T /F` (mata el arbol completo, mismo
// patron que ya usa close_app en tool-registry.ts). En las demas
// plataformas, el kill() de siempre -- sin cambio de comportamiento.
//
// Al CERRAR la app hay que esperar a taskkill (waitForProcessTreeKills()):
// verificado real que si el proceso principal sale enseguida, el job de
// libuv mata al hijo directo en el acto y taskkill ya no encuentra la raiz
// del arbol para recorrerlo -- los nietos quedaban huerfanos igual.
import { spawn, type ChildProcess } from 'node:child_process'
import path from 'node:path'

const pendingKills = new Set<Promise<void>>()

function taskkillPath(): string {
  return path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe')
}

export function killProcessTree(child: ChildProcess): void {
  // Ya termino (o nunca arranco): nada que matar. Tambien es la guarda
  // contra el reuso de PID: mientras Node no reporto la salida mantiene
  // abierto el handle del proceso, y Windows no reasigna un PID con handles
  // abiertos -- taskkill nunca apunta a un proceso ajeno.
  if (child.exitCode !== null || child.signalCode !== null) return
  const directKill = (): void => {
    try { child.kill() } catch { /* ya pudo haber terminado solo */ }
  }
  const pid = child.pid
  if (process.platform !== 'win32' || pid === undefined) {
    directKill()
    return
  }
  try {
    // detached: fuera del job de libuv, un taskkill que ya arranco termina
    // su recorrido aunque el proceso principal salga a mitad de camino.
    const killer = spawn(taskkillPath(), ['/PID', String(pid), '/T', '/F'], {
      windowsHide: true,
      detached: true,
      stdio: 'ignore'
    })
    killer.unref()
    const done = new Promise<void>(resolve => {
      // Si taskkill no pudo (no arranco, acceso denegado...), al menos el
      // kill() directo de antes: nunca peor que el comportamiento previo.
      killer.once('error', () => { directKill(); resolve() })
      killer.once('exit', code => { if (code !== 0) directKill(); resolve() })
    })
    pendingKills.add(done)
    void done.finally(() => pendingKills.delete(done))
  } catch {
    directKill()
  }
}

/** Espera, con tope, a que terminen los cortes de arbol en vuelo. Para el
 *  cierre de la app: llamarlo antes de app.quit(), ver el comentario de
 *  arriba. Resuelve enseguida si no hay ninguno. */
export async function waitForProcessTreeKills(timeoutMs: number): Promise<void> {
  if (pendingKills.size === 0) return
  let timer: NodeJS.Timeout | undefined
  await Promise.race([
    Promise.allSettled([...pendingKills]),
    new Promise<void>(resolve => { timer = setTimeout(resolve, timeoutMs) })
  ])
  if (timer) clearTimeout(timer)
}
