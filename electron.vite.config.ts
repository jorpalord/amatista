import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { readFileSync } from 'node:fs'
import path from 'node:path'

const pkg = JSON.parse(readFileSync(path.join(__dirname, 'package.json'), 'utf8')) as { version: string }
const APP_VERSION = JSON.stringify(pkg.version)

export default defineConfig({
  main: {
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
