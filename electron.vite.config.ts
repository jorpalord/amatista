import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { readFileSync } from 'node:fs'
import path from 'node:path'

const pkg = JSON.parse(readFileSync(path.join(__dirname, 'package.json'), 'utf8')) as { version: string }
const APP_VERSION = JSON.stringify(pkg.version)

// read_document (docs/_arch/verify_read_document_tool.md): pdfjs-dist trae
// datos en disco (cmaps/standard_fonts) que un bundler no puede inlinear en
// un .js, officeparser arrastra un arbol de dependencias complejo (WASM de
// tesseract.js incluido) que un bundler no maneja bien, y @napi-rs/canvas es
// un addon nativo (.node) -- ninguno de los 3 se puede empaquetar dentro de
// out/main/index.js. Mismo criterio ya aplicado a typescript-language-server/
// pyright/typescript (ver package.json build.files/asarUnpack): quedan como
// requires/import() reales contra node_modules en runtime, nunca bundleados.
const EXTERNAL_NATIVE_DEPS = /^(pdfjs-dist|officeparser|@napi-rs\/canvas)/

export default defineConfig({
  main: {
    build: { rollupOptions: { external: (id: string) => EXTERNAL_NATIVE_DEPS.test(id) } },
    define: { __APP_VERSION__: APP_VERSION }
  },
  preload: {
    define: { __APP_VERSION__: APP_VERSION }
  },
  renderer: {
    plugins: [react({})],
    define: { __APP_VERSION__: APP_VERSION }
  }
})
