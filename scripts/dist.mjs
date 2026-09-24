#!/usr/bin/env node
// Cross-platform packaging runner: builds with the right edition env and then
// invokes electron-builder with the matching config.
//
// Usage: node scripts/dist.mjs <full|slim> [extra electron-builder args...]
//
// Examples:
//   node scripts/dist.mjs full --linux zip
//   node scripts/dist.mjs slim --win squirrel
//
// The full edition does NOT run fetch-sdcpp automatically — the engine must be
// fetched first (`node scripts/fetch-sdcpp.mjs <variantId>`) to be bundled via
// extraResources.
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'

const [edition, ...builderArgs] = process.argv.slice(2)
if (edition !== 'full' && edition !== 'slim') {
  console.error('Usage: node scripts/dist.mjs <full|slim> [extra electron-builder args...]')
  process.exit(1)
}

const projectRoot = path.resolve(path.dirname(createRequire(import.meta.url).resolve('../package.json')))
process.chdir(projectRoot)

// Edition env for electron-vite build (`define: { __SLIM__ }`).
if (edition === 'slim') process.env.IMAGE_STUDIO_EDITION = 'slim'
else delete process.env.IMAGE_STUDIO_EDITION
// No code signing anywhere (also set only here, not needed at test time).
process.env.CSC_IDENTITY_AUTO_DISCOVERY = 'false'

/**
 * Resolves a local tool's JS entry point via its package.json `bin` field and
 * runs it with node directly (shell: false). Spawning the .bin/.cmd shim broke
 * on Windows after Node's CVE-2024-27980 fix (EINVAL when spawning .cmd
 * without a shell), and spawning with a shell breaks arg escaping/politics.
 * Same approach as scripts/dev.mjs.
 */
function run(pkgName, binName, args) {
  const pkgPath = createRequire(path.join(projectRoot, 'package.json')).resolve(`${pkgName}/package.json`)
  const bin = JSON.parse(readFileSync(pkgPath, 'utf8')).bin?.[binName] ?? null
  if (typeof bin !== 'string') {
    console.error(`No "${binName}" bin entry found in ${pkgPath}`)
    process.exit(1)
  }
  const binJs = path.join(path.dirname(pkgPath), bin)
  if (!existsSync(binJs)) {
    console.error(`Bin entry not found: ${binJs}`)
    process.exit(1)
  }
  const res = spawnSync(process.execPath, [binJs, ...args], { stdio: 'inherit', env: cleanEnv(process.env), shell: false })
  if (res.status !== 0 || res.error) process.exit(res.status ?? 1)
}

function cleanEnv(env) {
  const out = {}
  for (const [k, v] of Object.entries(env)) {
    if (v !== undefined && !(k === 'ELECTRON_RUN_AS_NODE')) out[k] = v
  }
  return out
}

run('electron-vite', 'electron-vite', ['build'])
// electron-builder must never see ELECTRON_RUN_AS_NODE (already stripped above).
run('electron-builder', 'electron-builder', ['--config', edition === 'slim' ? 'electron-builder.slim.yml' : 'electron-builder.yml', '--publish', 'never', ...builderArgs])
