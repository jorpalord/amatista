import { readdirSync, realpathSync } from 'node:fs'
import path from 'node:path'
import type { ProjectEntry, ProjectRoot } from '../shared/types'

export function scanProjectRoot(root: ProjectRoot): ProjectEntry[] {
  const realRoot = realpathSync(root.path)
  return readdirSync(realRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .map((entry) => ({
      id: `${root.id}:${entry.name}`,
      name: entry.name,
      path: path.join(realRoot, entry.name),
      rootId: root.id
    }))
    .sort((a, b) => a.name.localeCompare(b.name))
}
