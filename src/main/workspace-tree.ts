// Escaneo recursivo de un directorio de workspace hacia un TreeNode[] para
// el explorador de archivos del renderer. Filtra directorios ruidosos y
// limita la profundidad para evitar recorridos gigantes.
import { readdirSync } from 'node:fs'
import path from 'node:path'

export interface TreeNode {
  name: string
  path: string
  type: 'file' | 'directory'
  children?: TreeNode[]
}

export const ignoredDirectories = new Set([
  '.git', 'node_modules', 'dist', 'out', 'build', '.next', '.venv', 'venv', '__pycache__'
])

export const MAX_TEXT_FILE_BYTES = 2 * 1024 * 1024

export function buildTree(directory: string, depth = 0, maxDepth = 8): TreeNode[] {
  if (depth > maxDepth) return []
  return readdirSync(directory, { withFileTypes: true })
    .filter(entry => !entry.isDirectory() || !ignoredDirectories.has(entry.name))
    .sort((a, b) => {
      if (a.isDirectory() && !b.isDirectory()) return -1
      if (!a.isDirectory() && b.isDirectory()) return 1
      return a.name.localeCompare(b.name)
    })
    .map(entry => {
      const fullPath = path.join(directory, entry.name)
      return entry.isDirectory()
        ? { name: entry.name, path: fullPath, type: 'directory' as const, children: buildTree(fullPath, depth + 1, maxDepth) }
        : { name: entry.name, path: fullPath, type: 'file' as const }
    })
}
