// Tool "terminal_exec" (docs/_arch/verify_persistent_terminal_design.md):
// terminal persistente por sesion, mismo criterio confirmado real de la
// investigacion previa -- NO node-pty (confirmado innecesario para el caso
// de uso real: git/build/tests no exigen un TTY real), un solo cmd.exe
// real persistente por sesion, alimentado por pipes normales de
// child_process.spawn(). Arranque perezoso, mismo patron que LspManager
// (el proceso real recien se levanta en la PRIMERA llamada real a
// terminal_exec, nunca al conectar).
//
// Mecanismo de deteccion de fin de comando (marcador), las 4 piezas
// confirmadas real y necesarias en la investigacion previa, verificadas de
// nuevo juntas antes de escribir esto:
//  1. spawn('cmd.exe', ['/Q'], ...) -- el FLAG de spawn (no el comando
//     "@echo off") es lo que realmente suprime el eco del input cuando
//     cmd.exe se alimenta por pipes (confirmado real: @echo off NO lo hace
//     en este modo).
//  2. `prompt $_` mandado una vez al arrancar -- elimina el ruido real del
//     prompt "cwd>" que cmd.exe imprime igual pese a no ser un TTY real.
//  3. `(call )&` antepuesto a CADA comando -- resetea %ERRORLEVEL% a 0 de
//     forma incondicional antes de correr el comando real. Confirmado real
//     que SIN esto, un comando builtin (ej. echo) que no toca %ERRORLEVEL%
//     hereda el codigo de salida del comando anterior si ese fallo --
//     mismo bug real reproducido y corregido en la investigacion previa.
//  4. `2>&1` en cada comando -- mergea stderr al mismo stream que stdout
//     ANTES del marcador, evitando una carrera real entre 2 pipes async
//     independientes (sin garantia de que stderr ya llego cuando el
//     marcador aparece en stdout).
import { type ChildProcess, spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'

/** Timeout POR COMANDO (distinto del idle de sesion mas abajo) -- mismo
 *  espiritu que RUN_COMMAND_TIMEOUT_MS de run_command (tool-registry.ts,
 *  30s), pero mas generoso: una sesion persistente es justamente para
 *  workflows mas largos (activar un entorno + correr un build real), y
 *  cortar a los 30s ahi seria mas agresivo que el propio run_command para
 *  el mismo tipo de comando. Defiende contra un comando que nunca termina
 *  (ej. uno que espera un input interactivo real que nunca llega, ver
 *  docs/_arch/verify_persistent_terminal_design.md Tarea 1 -- limitacion
 *  real aceptada, no evitable sin un TTY real).
 */
export const TERMINAL_COMMAND_TIMEOUT_MS = 120_000

/** Timeout de INACTIVIDAD de la sesion completa -- patron NUEVO en este
 *  codebase (ni LspManager ni McpManager tienen uno, ambos viven hasta
 *  disconnectSession() sin limite intermedio, confirmado en la
 *  investigacion previa). Un panel conectado horas sin volver a llamar
 *  terminal_exec no deberia dejar un cmd.exe real vivo indefinidamente.
 *  15 minutos: generoso para un uso real intermitente (revisar un build,
 *  volver mas tarde a correr otro comando en el MISMO entorno activado),
 *  sin dejar procesos huerfanos por horas. Se resetea con CADA comando
 *  real (ensureStarted()/runCommand()) -- el proximo uso tras vencer este
 *  timeout simplemente spawnea una sesion nueva (mismo arranque perezoso).
 */
export const TERMINAL_IDLE_TIMEOUT_MS = 15 * 60_000

export interface TerminalCommandResult {
  ok: boolean
  exitCode: number | null
  output: string
}

export class TerminalManager {
  private child: ChildProcess | null = null
  private buf = ''
  private starting: Promise<void> | null = null
  private idleTimer: NodeJS.Timeout | null = null

  constructor(private readonly workspace: string) {}

  /** Reseteado en cada uso real (ensureStarted()/runCommand()) -- si nadie
   *  vuelve a usar la terminal en TERMINAL_IDLE_TIMEOUT_MS, se mata el
   *  proceso real y se limpia la referencia (mismo criterio de "arranque
   *  perezoso" que el spawn inicial: el proximo uso real crea una sesion
   *  nueva desde cero, sin arrastrar nada del cmd.exe viejo). */
  private resetIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = setTimeout(() => {
      this.stop()
    }, TERMINAL_IDLE_TIMEOUT_MS)
  }

  /** Arranca el proceso real si todavia no existe -- idempotente, mismo
   *  criterio que LspClient.start() (si ya esta arrancando o arrancado, no
   *  vuelve a spawnear nada). */
  private ensureStarted(): Promise<void> {
    if (this.child) {
      this.resetIdleTimer()
      return Promise.resolve()
    }
    if (this.starting) return this.starting

    this.starting = (async () => {
      const child = spawn('cmd.exe', ['/Q'], {
        cwd: this.workspace,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true
      })
      this.child = child
      this.buf = ''
      child.stdout?.on('data', chunk => { this.buf += chunk.toString('utf8') })
      child.stderr?.on('data', chunk => { this.buf += chunk.toString('utf8') })
      child.on('exit', () => {
        this.child = null
        if (this.idleTimer) {
          clearTimeout(this.idleTimer)
          this.idleTimer = null
        }
      })

      // `prompt $_` real -- confirmado que elimina el ruido del prompt
      // "cwd>" del buffer real capturado. Se manda ANTES de limpiar el
      // buffer (descarta ademas el banner inicial real de cmd.exe -- version
      // de Windows/copyright -- que no le sirve al modelo).
      child.stdin?.write('prompt $_\r\n')
      await new Promise(resolve => setTimeout(resolve, 200))
      this.buf = ''
      this.resetIdleTimer()
    })()

    return this.starting.finally(() => {
      this.starting = null
    })
  }

  /**
   * Corre un comando real en la sesion persistente -- mecanismo de
   * marcador confirmado real (docs/_arch/verify_persistent_terminal_design.md,
   * Tarea 2). `timeoutMs` opcional para casos que necesiten mas margen que
   * el default (TERMINAL_COMMAND_TIMEOUT_MS).
   */
  async runCommand(command: string, timeoutMs = TERMINAL_COMMAND_TIMEOUT_MS): Promise<TerminalCommandResult> {
    await this.ensureStarted()
    const child = this.child
    if (!child?.stdin) {
      return { ok: false, exitCode: null, output: 'No se pudo iniciar la terminal persistente.' }
    }

    const marker = `__AMATISTA_TERM_${randomBytes(8).toString('hex')}__`
    const startLen = this.buf.length
    const startedAt = Date.now()

    child.stdin.write(`(call )&${command} 2>&1\r\necho ${marker} %ERRORLEVEL%\r\n`)

    return new Promise(resolve => {
      const poll = setInterval(() => {
        const idx = this.buf.indexOf(marker, startLen)
        if (idx !== -1) {
          clearInterval(poll)
          this.resetIdleTimer()
          const tail = this.buf.slice(idx + marker.length)
          const match = tail.match(/\s+(-?\d+)/)
          const exitCode = match ? Number(match[1]) : null
          const output = this.buf.slice(startLen, idx).trim()
          resolve({ ok: exitCode === 0, exitCode, output })
          return
        }
        if (Date.now() - startedAt > timeoutMs) {
          clearInterval(poll)
          resolve({
            ok: false,
            exitCode: null,
            output: `Timeout esperando que termine el comando (${timeoutMs}ms) -- probablemente el comando quedo esperando ` +
              'input interactivo real (esta terminal no tiene un TTY real, ver docs/_arch/verify_persistent_terminal_design.md ' +
              'Tarea 1) o simplemente tarda mas de lo esperado. La sesion sigue viva, podes seguir usandola.'
          })
        }
      }, 30)
    })
  }

  /** Mata el proceso real (si existe) y limpia todo el estado -- llamado
   *  desde disconnectSession() (cleanup real de la conexion) y desde el
   *  propio timeout de inactividad de arriba. Idempotente. */
  stop(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer)
      this.idleTimer = null
    }
    if (this.child) {
      try { this.child.kill() } catch { /* ya pudo haber terminado solo */ }
      this.child = null
    }
    this.buf = ''
  }
}
