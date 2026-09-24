// killProcessTree() (src/main/process-tree.ts): en Windows corta el proceso CON su arbol (taskkill /T /F) en vez del
// ChildProcess.kill() que dejaba huerfanos a los nietos. El control prueba que el fixture de verdad produce un huerfano
// con el mecanismo viejo -- sin eso, los tests de corte podrian pasar en falso.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { killProcessTree, waitForProcessTreeKills } from '../../src/main/process-tree'
import { cleanupFixture, isAlive, isWindows, spawnTreeWithGrandchild, waitUntilDead } from './_support/orphan-fixture'

after(cleanupFixture)
const skip = isWindows ? false : 'solo Windows: ChildProcess.kill() deja huerfanos solo ahi'

test('control (la causa real): ChildProcess.kill() mata al padre y deja al nieto vivo, huerfano', { skip }, async () => {
  const { parent, grandchildPid } = await spawnTreeWithGrandchild()
  parent.kill()
  assert.equal(await waitUntilDead(parent.pid!), true, 'el padre deberia morir con kill()')
  await new Promise(resolve => setTimeout(resolve, 500))
  assert.equal(isAlive(grandchildPid), true, 'si el nieto muere con kill(), el fixture no reproduce el bug y los demas tests no prueban nada')
})

test('killProcessTree(): mata al padre y a su nieto', { skip }, async () => {
  const { parent, grandchildPid } = await spawnTreeWithGrandchild()
  killProcessTree(parent)
  assert.equal(await waitUntilDead(grandchildPid), true, `el nieto ${grandchildPid} sigue vivo: quedo huerfano`)
  assert.equal(await waitUntilDead(parent.pid!), true, 'el padre sigue vivo')
})

// El cierre de la app (index.ts, window-all-closed) espera esto antes de app.quit(): verificado real que si el proceso
// principal sale sin esperar, el job de libuv mata al hijo directo y taskkill ya no encuentra la raiz del arbol.
test('waitForProcessTreeKills(): cuando resuelve, el arbol ya esta muerto (sin sondear)', { skip }, async () => {
  const { parent, grandchildPid } = await spawnTreeWithGrandchild()
  killProcessTree(parent)
  await waitForProcessTreeKills(5000)
  assert.equal(isAlive(grandchildPid), false, 'resolvio antes de que taskkill terminara de cortar el arbol')
})

test('waitForProcessTreeKills(): sin cortes en vuelo resuelve enseguida (no demora el cierre)', async () => {
  const started = Date.now()
  await waitForProcessTreeKills(5000)
  assert.ok(Date.now() - started < 100, `tardo ${Date.now() - started}ms sin nada que esperar`)
})

test('killProcessTree(): un proceso que ya salio no se toca (sin taskkill sobre un PID viejo, sin excepcion)', async () => {
  const child = spawn(process.execPath, ['-e', ''], { windowsHide: true })
  await new Promise(resolve => child.once('exit', resolve))
  assert.notEqual(child.exitCode, null)
  assert.doesNotThrow(() => killProcessTree(child))
})
