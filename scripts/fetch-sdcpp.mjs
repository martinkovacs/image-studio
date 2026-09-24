#!/usr/bin/env node
// Downloads the latest stable-diffusion.cpp release asset for an engine variant
// into resources/sdcpp/<variantId>/ (consumed by electron-builder's
// extraResources). Usage:  node scripts/fetch-sdcpp.mjs [variantId]
import { createWriteStream, lstatSync, readdirSync } from 'node:fs'
import fsP from 'node:fs/promises'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import process from 'node:process'
import extractZip from 'extract-zip'
import variantsJson from '../src/main/sdcpp/variants.json' with { type: 'json' }

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const OUT_ROOT = path.join(REPO_ROOT, 'resources', 'sdcpp')
const RELEASE_URL = 'https://api.github.com/repos/leejet/stable-diffusion.cpp/releases/latest'

function defaultVariant(platform) {
  return platform === 'win32' ? 'win-cuda12' : platform === 'darwin' ? 'mac-arm64' : 'linux-vulkan'
}

function serverBinaryName(platform) {
  return platform === 'win32' ? 'sd-server.exe' : 'sd-server'
}

async function main() {
  const platform = process.platform
  const variantId = process.argv[2] ?? defaultVariant(platform)
  const defs = variantsJson.filter((v) => v.platform === platform)
  const def = defs.find((v) => v.id === variantId)
  if (!def) {
    console.error(`Unknown variant "${variantId}" for platform "${platform}". Available: ${defs.map((v) => v.id).join(', ')}`)
    process.exit(1)
  }
  if (!def.assetPattern) {
    console.error(`Variant "${variantId}" is not downloadable; build it with scripts/build-sdcpp-cuda.sh.`)
    process.exit(1)
  }
  const assetRe = new RegExp(def.assetPattern, 'i')

  const res = await fetch(RELEASE_URL, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'image-studio' } })
  if (res.status === 403 || res.status === 429) {
    console.error('GitHub API rate limit exceeded. Try again later.')
    process.exit(1)
  }
  if (!res.ok) {
    console.error(`GitHub API returned HTTP ${res.status}.`)
    process.exit(1)
  }
  const json = await res.json()
  const asset = (json.assets ?? []).find((a) => assetRe.test(a.name))
  if (!asset) {
    console.error(`No asset matching /${def.assetPattern}/ in latest release ${json.tag_name}.`)
    process.exit(1)
  }

  const outDir = path.join(OUT_ROOT, variantId)
  await fsP.rm(outDir, { recursive: true, force: true })
  await fsP.mkdir(outDir, { recursive: true })

  console.log(`Downloading ${asset.name} (${((asset.size ?? 0) / 1024 / 1024).toFixed(1)} MB)…`)
  const dl = await fetch(asset.browser_download_url, { headers: { 'User-Agent': 'image-studio' } })
  if (!dl.ok) {
    console.error(`Download failed: HTTP ${dl.status}`)
    process.exit(1)
  }
  const zipPath = path.join(outDir, asset.name)
  await pipeline(Readable.fromWeb(dl.body), createWriteStream(zipPath))

  const extractDir = path.join(outDir, '.extract')
  await fsP.mkdir(extractDir, { recursive: true })
  await extractZip(zipPath, { dir: extractDir })
  // The zip itself must not ship inside the engine dir.
  await fsP.rm(zipPath, { force: true })

  // Flatten: find the directory containing sd-server and hoist its contents.
  const walk = (dir, depth = 0) => {
    if (depth > 4) return null
    for (const name of readdirSync(dir)) {
      if (name === serverBinaryName(platform)) return dir
      const sub = path.join(dir, name)
      if (lstatSync(sub).isDirectory()) {
        const found = walk(sub, depth + 1)
        if (found) return found
      }
    }
    return null
  }
  const serverDir = walk(extractDir)
  if (!serverDir) {
    console.error(`No ${serverBinaryName(platform)} found inside ${asset.name}.`)
    process.exit(1)
  }
  if (serverDir !== outDir) {
    for (const name of readdirSync(serverDir)) {
      await fsP.rename(path.join(serverDir, name), path.join(outDir, name))
    }
  }
  await fsP.rm(extractDir, { recursive: true, force: true })
  if (platform !== 'win32') {
    for (const name of readdirSync(outDir)) {
      await fsP.chmod(path.join(outDir, name), 0o755).catch(() => {})
    }
  }
  await fsP.writeFile(
    path.join(outDir, 'version.json'),
    JSON.stringify({ tag: json.tag_name, installedAt: new Date().toISOString() }, null, 2)
  )
  console.log(`Engine "${variantId}" (${json.tag_name}) fetched into ${outDir}`)
}

main().catch((err) => {
  console.error(err?.stack ?? String(err))
  process.exit(1)
})
