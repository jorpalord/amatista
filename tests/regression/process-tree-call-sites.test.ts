// Corte de procesos CON su arbol en los puntos reales donde el proceso cortado puede tener hijos propios:
// CliAgentRuntime (claude.exe / agy.exe), RpcStdioClient (Codex app-server y servidores MCP, que en Windows arrancan con
// shell:true -> un cmd.exe envoltorio) y TerminalManager (cmd.exe persistente + lo que sus comandos dejen corriendo).
// Bug real (2026-09-24): en Windows ChildProcess.kill() mata solo ESE pid -- 2 `tail -F | grep` lanzados por un Claude
// CLI siguieron vivos 2 dias despues de que el CLI murio. Solo Windows: en las demas plataformas no cambia nada.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { CliAgentRuntime } from '../../src/main/cli-agent-runtime'
import { RpcStdioClient, type RpcMessage } from '../../src/main/rpc-stdio-client'
import { TerminalManager } from '../../src/main/terminal-manager'
import {
  cleanupFixture,
  grandchildCommand,
  isWindows,
  newPidFile,
  spawnTreeWithGrandchild,
  tempWorkspace,
  waitForPid,
  waitUntilDead
} from './_support/orphan-fixture'

after(cleanupFixture)
const skip = isWindows ? false : 'solo Windows: ChildProcess.kill() deja huerfanos solo ahi'

function injectActiveProcess(runtime: CliAgentRuntime, child: ChildProcessWithoutNullStreams): void {
  (runtime as unknown as { activeProcess: ChildProcessWithoutNullStreams }).activeProcess = child
}

test('CliAgentRuntime.cancelTurn() (boton Detener): corta el CLI Y lo que el CLI habia lanzado', { skip }, async () => {
  const { parent, grandchildPid } = await spawnTreeWithGrandchild()
  const runtime = new CliAgentRuntime()
  injectActiveProcess(runtime, parent)
  assert.equal(runtime.cancelTurn(), true)
  assert.equal(await waitUntilDead(grandchildPid), true, `el nieto ${grandchildPid} sigue vivo: quedo huerfano`)
  assert.equal(await waitUntilDead(parent.pid!), true, 'el propio CLI sigue vivo')
})

test('CliAgentRuntime.stop() (desconectar el chat / cerrar Amatista): mata tambien al nieto', { skip }, async () => {
  const { parent, grandchildPid } = await spawnTreeWithGrandchild()
  const runtime = new CliAgentRuntime()
  injectActiveProcess(runtime, parent)
  runtime.stop()
  assert.equal(await waitUntilDead(grandchildPid), true, `el nieto ${grandchildPid} sigue vivo: quedo huerfano`)
  assert.equal(await waitUntilDead(parent.pid!), true)
})

class RpcDePrueba extends RpcStdioClient {
  protected notStartedErrorMessage(): string { return 'sin proceso' }
  protected rpcErrorFallback(_error: NonNullable<RpcMessage['error']>): string { return 'error rpc' }
  protected processExitErrorMessage(code: number | null, signal: NodeJS.Signals | null): string {
    return `salio (${String(code)}, ${String(signal)})`
  }
  conectar(child: ChildProcessWithoutNullStreams): void { this.attachProcess(child) }
}

test('RpcStdioClient.stop() (Codex / servidores MCP): mata al servidor real, no solo al cmd.exe envoltorio', { skip }, async () => {
  const { parent, grandchildPid } = await spawnTreeWithGrandchild()
  const client = new RpcDePrueba()
  client.conectar(parent)
  client.stop()
  assert.equal(await waitUntilDead(grandchildPid), true, `el servidor ${grandchildPid} sigue vivo: quedo huerfano`)
  assert.equal(await waitUntilDead(parent.pid!), true)
})

test('TerminalManager.stop(): mata tambien lo que un comando dejo corriendo en segundo plano (start /b)', { skip }, async () => {
  const terminal = new TerminalManager(tempWorkspace())
  const pidFile = newPidFile()
  const result = await terminal.runCommand(`start "" /b ${grandchildCommand(pidFile)}`)
  assert.equal(result.ok, true, result.output)
  const grandchildPid = await waitForPid(pidFile)
  terminal.stop()
  assert.equal(await waitUntilDead(grandchildPid), true, `el proceso ${grandchildPid} lanzado desde la terminal sigue vivo: quedo huerfano`)
})
