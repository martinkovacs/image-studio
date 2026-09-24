#!/usr/bin/env node
// Cross-platform dev launcher. Removes ELECTRON_RUN_AS_NODE from the
// environment (it breaks Electron startup) and spawns the local electron-vite.
//
// Usage: node scripts/dev.mjs [--slim] [extra electron-vite args...]
//   --slim  runs the slim (OpenRouter-only) edition by setting
//           IMAGE_STUDIO_EDITION=slim (no cross-env dependency needed).
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import path from 'node:path'
import process from 'node:process'

const require = createRequire(import.meta.url)

const argv = process.argv.slice(2)
const slim = argv.includes('--slim')
const passThrough = argv.filter((a) => a !== '--slim')

if (slim) process.env.IMAGE_STUDIO_EDITION = 'slim'
delete process.env.ELECTRON_RUN_AS_NODE

// Resolve the local electron-vite entry point (npm puts node_modules/.bin on
// PATH only for `npm run` scripts, so resolve the package bin explicitly).
const pkgPath = createRequire(path.join(process.cwd(), 'package.json')).resolve('electron-vite/package.json')
const binJs = path.join(path.dirname(pkgPath), require(pkgPath).bin['electron-vite'])

// Run the bin script through node directly — works on every platform, with or
// without a shell, and @electron/run-as-node is not in effect here.
const child = spawn(process.execPath, [binJs, ...passThrough], { stdio: 'inherit' })
child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal)
  process.exit(code ?? 0)
})
