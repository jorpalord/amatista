// Arbol de procesos real para los tests de corte (process-tree-*.test.ts): un padre cmd.exe que lanza un nieto node de
// larga duracion y anota su PID. cmd.exe a proposito, NO node: libuv mete a los hijos de un node en un job object con
// KILL_ON_JOB_CLOSE, asi que un padre node arrastraria al nieto al morir y el test pasaria en falso. cmd.exe no usa job
// objects -- igual que claude.exe/agy.exe (el caso real) y que el cmd.exe envoltorio de spawn(..., {shell: true}) en
// Windows (Codex app-server, servidores MCP).
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const isWindows = process.platform === 'win32'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amatista-process-tree-'))
const grandchildScript = path.join(dir, 'nieto.cjs')
fs.writeFileSync(grandchildScript, "require('node:fs').writeFileSync(process.argv[2], String(process.pid))\nsetInterval(() => {}, 1000)\n")
const grandchildren: number[] = []
let counter = 0

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

export function newPidFile(): string {
  return path.join(dir, `nieto-${++counter}.pid`)
}

/** Linea de comando (sintaxis de cmd.exe) que arranca el nieto y lo hace anotar su PID en `pidFile`. */
export function grandchildCommand(pidFile: string): string {
  return `"${process.execPath}" "${grandchildScript}" "${pidFile}"`
}

export function tempWorkspace(): string {
  const workspace = path.join(dir, `ws-${++counter}`)
  fs.mkdirSync(workspace)
  return workspace
}

export async function waitForPid(pidFile: string, timeoutMs = 10_000): Promise<number> {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (fs.existsSync(pidFile)) {
      const pid = Number(fs.readFileSync(pidFile, 'utf8'))
      if (pid > 0) {
        grandchildren.push(pid)
        return pid
      }
    }
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  throw new Error(`el nieto no anoto su PID en ${timeoutMs}ms`)
}

export async function waitUntilDead(pid: number, timeoutMs = 5000): Promise<boolean> {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (!isAlive(pid)) return true
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  return !isAlive(pid)
}

/** Padre cmd.exe con un nieto node vivo, listo para cortarlo. */
export async function spawnTreeWithGrandchild(): Promise<{ parent: ChildProcessWithoutNullStreams; grandchildPid: number }> {
  const pidFile = newPidFile()
  const parent = spawn('cmd.exe', ['/d', '/s', '/c', `"${grandchildCommand(pidFile)}"`], {
    windowsHide: true,
    windowsVerbatimArguments: true
  })
  const grandchildPid = await waitForPid(pidFile)
  return { parent, grandchildPid }
}

/** Nunca dejar huerfanos de los propios tests: mata lo que haya sobrevivido y borra la carpeta temporal. */
export function cleanupFixture(): void {
  for (const pid of grandchildren) {
    if (isAlive(pid)) {
      try { process.kill(pid) } catch { /* ya murio */ }
    }
  }
  fs.rmSync(dir, { recursive: true, force: true })
}
