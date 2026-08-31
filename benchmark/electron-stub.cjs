// Fase 2 del benchmark (docs/_arch/verify_benchmark_harness.md): stub minimo
// de 'electron' para bundlear el harness fuera de Electron. Amatista importa
// `app`/`dialog` de electron en un par de puntos que este harness nunca
// ejercita en la practica:
//   - lsp-client.ts: app.getAppPath() -- solo dentro de una funcion que
//     resuelve rutas de binarios LSP empaquetados (pyright/tsserver), nunca
//     llamada porque el harness no invoca find_definition/list_symbols.
//   - app-paths.ts: dialog.showErrorBox() + app.exit() -- solo dentro de
//     ensureStorageRootOrExit(), que este harness nunca llama (el wrapper ya
//     garantiza que AMATISTA_STORAGE_ROOT apunta a una carpeta valida antes
//     de requerir el bundle).
// esbuild igual necesita resolver el import de 'electron' estaticamente al
// bundlear -- este modulo reemplaza ese import via --alias:electron=...
module.exports = {
  app: {
    getAppPath: () => process.cwd(),
    exit: () => {}
  },
  dialog: {
    showErrorBox: () => {}
  }
}
