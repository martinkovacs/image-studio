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

/** Runs a local node_modules/.bin binary; undefined env values are dropped. */
function run(cmd, args) {
  const bin = path.join(projectRoot, 'node_modules', '.bin', process.platform === 'win32' ? `${cmd}.cmd` : cmd)
  const res = spawnSync(bin, args, { stdio: 'inherit', env: cleanEnv(process.env), shell: false })
  if (res.status !== 0 || res.error) process.exit(res.status ?? 1)
}

function cleanEnv(env) {
  const out = {}
  for (const [k, v] of Object.entries(env)) {
    if (v !== undefined && !(k === 'ELECTRON_RUN_AS_NODE')) out[k] = v
  }
  return out
}

run('electron-vite', ['build'])
// electron-builder must never see ELECTRON_RUN_AS_NODE (already stripped above).
run('electron-builder', ['--config', edition === 'slim' ? 'electron-builder.slim.yml' : 'electron-builder.yml', '--publish', 'never', ...builderArgs])
