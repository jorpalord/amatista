# ANALYSIS.md — Reconocimiento Amatista v0.4.4 (retry robusto)
_Generado: 2026-08-19 20:59:08_

## package.json
```
{
  "name": "amatista",
  "productName": "Amatista",
  "version": "0.5.3",
  "private": true,
  "description": "Multi-model desktop agent workspace with pluggable AI providers.",
  "main": "./out/main/index.js",
  "scripts": {
    "dev": "electron-vite dev",
    "build": "npm run typecheck && electron-vite build",
    "dist": "npm run build && electron-builder --win nsis",
    "preview": "electron-vite preview",
    "typecheck": "tsc --noEmit -p tsconfig.node.json && tsc --noEmit -p tsconfig.web.json"
  },
  "build": {
    "appId": "com.amatista.agentstudio",
    "productName": "Amatista",
    "directories": {
      "output": "release"
    },
    "files": [
      "out/**/*",
      "package.json"
    ],
    "win": {
      "target": [
        {
          "target": "nsis",
          "arch": [
            "x64"
          ]
        }
      ],
      "icon": "build/amatista.ico",
      "artifactName": "Amatista-V${version}-Setup.${ext}"
    },
    "nsis": {
      "oneClick": false,
      "allowToChangeInstallationDirectory": true,
      "createDesktopShortcut": true,
      "createStartMenuShortcut": true,
      "shortcutName": "Amatista"
    }
  },
  "engines": {
    "node": ">=22.12.0"
  },
  "dependencies": {
    "@monaco-editor/react": "4.7.0",
    "monaco-editor": "0.55.1",
    "react": "19.2.8",
    "react-dom": "19.2.8",
    "yaml": "^2.8.1"
  },
  "devDependencies": {
    "@types/node": "^26.1.1",
    "@types/react": "^19.2.17",
    "@types/react-dom": "^19.2.3",
    "@vitejs/plugin-react": "^5.1.4",
    "electron": "43.2.0",
    "electron-builder": "^26.0.12",
    "electron-vite": "5.0.0",
    "typescript": "^6.0.0",
    "vite": "^7.3.6"
  }
}
```

## Estructura (recursiva, exclusiones en cualquier profundidad)
```
.
./.gitignore
./AUDIT_V034.md
./Q_CONFIG_IMPORT_PLAN.md
./README.md
./README_UI_FIX.md
./README_V032.md
./README_V033.md
./README_V034.md
./README_V035.md
./README_V036.md
./README_V037.md
./README_V038.md
./README_V039.md
./README_V040.md
./README_V041.md
./README_V042.md
./README_V043.md
./README_V044.md
./README_V045.md
./TYPECHECK_FIX.md
./dev-codex-test.log
./docs
./docs/ARCHITECTURE_V02.md
./docs/AUTH_ARCHITECTURE_V03.md
./docs/_arch
./docs/_arch/ANALYSIS.md
./docs/_arch/CONTRACT.md
./docs/_arch/HISTORY.md
./docs/_arch/PENDING.md
./electron.vite.config.ts
./logoamatista.png
./logoamatista_ico.ico
./package-lock.json
./package.json
./scripts
./scripts/check-environment.ps1
./scripts/install-claude-cli.ps1
./scripts/install-gemini-cli.ps1
./src
./src/main
./src/main/api-agent-runtime.ts
./src/main/app-paths.ts
./src/main/auth-manager.ts
./src/main/chat-store.ts
./src/main/claude-subscription-runtime.ts
./src/main/cli-agent-runtime.ts
./src/main/cli-status.ts
./src/main/codex-account-bridge.ts
./src/main/codex-client.ts
./src/main/context-envelope.ts
./src/main/index.ts
./src/main/project-registry.ts
./src/main/settings-store.ts
./src/main/tool-registry.ts
./src/preload
./src/preload/index.d.ts
./src/preload/index.ts
./src/renderer
./src/renderer/index.html
./src/renderer/src
./src/renderer/src/App.tsx
./src/renderer/src/assets
./src/renderer/src/assets/logoamatista.png
./src/renderer/src/assets/main.css
./src/renderer/src/main.tsx
./src/renderer/src/monaco-setup.ts
./src/renderer/src/vite-env.d.ts
./src/shared
./src/shared/app-version.d.ts
./src/shared/types.ts
./tsconfig.json
./tsconfig.node.json
./tsconfig.web.json
```

## Entry points (main/index/preload, SIN limite de profundidad, dentro de las exclusiones)
```
./src/main/index.ts
./src/preload/index.d.ts
./src/preload/index.ts
./src/renderer/index.html
./src/renderer/src/assets/main.css
./src/renderer/src/main.tsx
```

## Config de build/runtime
```
./electron.vite.config.ts
./tsconfig.json
./tsconfig.node.json
./tsconfig.web.json
```

## LOC por extension
```
ts: 4210 lineas
tsx: 3074 lineas
```

## Archivos con logica de proveedores IA (multimodelo)
```
./src/main/api-agent-runtime.ts
./src/main/cli-agent-runtime.ts
./src/main/codex-client.ts
./src/main/index.ts
./src/main/settings-store.ts
./src/renderer/src/App.tsx
./src/shared/types.ts
```

## Modulos IPC (si es Electron)
```
./src/main/index.ts
./src/preload/index.ts
```

## Git log (ultimos 20 commits)
```
fatal: not a git repository (or any of the parent directories): .git
no es repo git
```

## Ramas y estado
```
fatal: not a git repository (or any of the parent directories): .git
no es repo git
```
