// Test de regresion real (candidato #2, docs/_arch/verify_regression_test_infra_design.md):
// runInRepoQueue()/atomicidad de git (local-vcs.ts), Hallazgo 4 de la 4ta
// revision externa. Antes, la cola por-repo serializaba CADA llamada
// individual a runGit() -- commitPath() hacia 2 llamadas separadas (add,
// commit) con un await real entre medio, y otro commitVersion() concurrente
// podia colar su propio add ANTES del commit del primero. Reproduccion
// EXACTA del escenario que expuso el bug: 10 escrituras concurrentes
// reales al mismo repo oculto, git real, subprocesos reales.
// AMATISTA_STORAGE_ROOT llega ya seteado, real y aislado, por
// _support/run.cjs -- ver el comentario completo alli (hallazgo real:
// setearlo aca antes de un import propio no alcanza).
import path from 'node:path'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { commitVersion, listFileHistory } from '../../src/main/local-vcs'

// El repo oculto real vive bajo <STORAGE_ROOT>/vcs/<hash-del-workspace> --
// local-vcs.ts no exporta ese hash, asi que este helper (igual que el
// harness temporal original de Hallazgo 4) identifica el repo real
// consultando un marcador real (seed.txt) en vez de adivinar cual
// subcarpeta es la correcta.
function findRealRepoDir(storageRoot: string, marker: string): string {
  const { readdirSync, existsSync } = require('node:fs') as typeof import('node:fs')
  const vcsRoot = path.join(storageRoot, 'vcs')
  const candidates = existsSync(vcsRoot)
    ? readdirSync(vcsRoot, { withFileTypes: true }).filter((e: { isDirectory(): boolean }) => e.isDirectory()).map((e: { name: string }) => e.name)
    : []
  for (const c of candidates) {
    const dir = path.join(vcsRoot, c)
    if (!existsSync(path.join(dir, '.git'))) continue
    try {
      const content = execFileSync('git', ['show', 'HEAD:seed.txt'], { cwd: dir, encoding: 'utf8' })
      if (content.trim() === marker) return dir
    } catch { /* candidato sin seed.txt en HEAD -- no es el repo buscado */ }
  }
  throw new Error(`No se encontro el repo oculto real con marker "${marker}" bajo ${vcsRoot}`)
}

test('commitVersion() real -- 10 escrituras concurrentes al mismo repo oculto, 10 commits reales, cero colapso', async (t) => {
  const workspace = mkdtempSync(path.join(tmpdir(), 'amatista-regression-git-atomic-ws-'))
  t.after(() => rmSync(workspace, { recursive: true, force: true }))

  const marker = 'regresion-git-atomic'
  await commitVersion({ workspace, relPath: 'seed.txt', newContent: `${marker}\n`, tool: 'seed' })

  const N = 10
  const files = Array.from({ length: N }, (_, i) => `file${i}.txt`)
  const results = await Promise.all(files.map((f, i) => commitVersion({
    workspace, relPath: f, newContent: `contenido real ${i}\n`, tool: `write_${i}`
  })))
  assert.ok(results.every(r => r.ok), `todas las escrituras deberian resolver ok: ${JSON.stringify(results)}`)

  const repoDir = findRealRepoDir(process.env.AMATISTA_STORAGE_ROOT!, marker)
  const commitCount = parseInt(
    execFileSync('git', ['rev-list', '--count', 'HEAD'], { cwd: repoDir, encoding: 'utf8' }).trim(), 10
  )
  // 1 commit real del seed + N commits reales de las escrituras -- si la
  // cola colapsara (bug real original), esto daria 2 (seed + 1 solo commit
  // real que arrastro las 10 escrituras juntas, el resto "nothing to commit").
  assert.equal(commitCount, N + 1, `esperaba ${N + 1} commits reales (1 seed + ${N}), sin colapso`)

  let filesWithHistory = 0
  const attributions = new Set<string>()
  for (const f of files) {
    const history = await listFileHistory(workspace, f)
    if (history.length > 0) {
      filesWithHistory++
      attributions.add(history[0].tool)
    }
  }
  assert.equal(filesWithHistory, N, 'cada archivo real deberia tener su propio historial real')
  assert.equal(attributions.size, N, 'cada archivo deberia tener su propia atribucion real de herramienta, sin colapsar')
})
