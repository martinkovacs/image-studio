// sd.cpp engine discovery, download and install. Electron-dependent functions
// are kept at the bottom; the pure helpers (variant list, asset matching,
// core install routine) are exported separately so they are unit-testable.
import { app } from 'electron'
import path from 'node:path'
import fs from 'node:fs/promises'
import process from 'node:process'
import extractZip from 'extract-zip'
import type { AppSettings, EngineInfo, EngineInstallProgress, EngineVariant } from '@shared/types'
import variantsJson from './variants.json'

export interface EngineVariantDef {
  id: string
  label: string
  platform: NodeJS.Platform
  /** Regex source matched against release asset names. null = not downloadable. */
  assetPattern: string | null
}

// Single source of truth shared with scripts/fetch-sdcpp.mjs and build-sdcpp-cuda.sh.
export const ENGINE_VARIANTS = variantsJson as EngineVariantDef[]

export function serverBinaryName(platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? 'sd-server.exe' : 'sd-server'
}

export function cliBinaryName(platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? 'sd-cli.exe' : 'sd-cli'
}

// --- pure helpers ---------------------------------------------------------

/** Default bundled variant per platform. */
export function defaultVariantId(platform: NodeJS.Platform = process.platform): string {
  if (platform === 'win32') return 'win-cuda12'
  if (platform === 'darwin') return 'mac-arm64'
  return 'linux-vulkan'
}

/** First release asset name whose regex exists; null when no match. */
export function matchAssetName(assetNames: string[], patternSource: string): string | null {
  const re = new RegExp(patternSource, 'i')
  return assetNames.find((n) => re.test(n)) ?? null
}

/** Variants defined for a given platform, in a stable order. */
export function variantsForPlatform(platform: NodeJS.Platform): EngineVariantDef[] {
  return ENGINE_VARIANTS.filter((v) => v.platform === platform)
}

/** Handles used to probe whether a variant directory contains a usable sd-server. */
export interface InstalledVariantInfo {
  id: string
  installed: boolean
  installedVersion?: string
}

/** Builds the UI-facing EngineVariant list for a platform from existence probes. */
export async function buildEngineVariants(
  platform: NodeJS.Platform,
  probes: {
    /** True when the variant is shipped inside the app bundle. */
    isBundled: (id: string) => Promise<boolean>
    /** Installed version tag, or undefined when not installed. */
    installedVersion: (id: string) => Promise<string | undefined>
  }
): Promise<EngineVariant[]> {
  const result = await Promise.all(
    variantsForPlatform(platform).map(async (def) => {
      const installedVersion = await probes.installedVersion(def.id)
      return {
        id: def.id,
        label: def.label,
        platform: def.platform,
        assetPattern: def.assetPattern,
        installed: installedVersion !== undefined,
        ...(installedVersion !== undefined ? { installedVersion } : {}),
        bundled: await probes.isBundled(def.id)
      }
    })
  )
  return result
}

export interface ServerDirResult {
  dir: string
  serverPath: string
  cliPath: string | null
}

/**
 * Breadth-first search for a directory containing the sd-server binary
 * (zips may nest everything one or two levels deep). Non-recursive into
 * "engines/..." install layouts; searches only inside `root`.
 */
export async function findServerDir(root: string, platform: NodeJS.Platform = process.platform): Promise<ServerDirResult | null> {
  const serverName = serverBinaryName(platform)
  const cliName = cliBinaryName(platform)
  const queue: string[] = [root]
  while (queue.length > 0) {
    const dir = queue.shift() as string
    let entries: import('node:fs').Dirent[]
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of entries) {
      if (e.name === serverName && e.isFile()) {
        const cliPath = path.join(dir, cliName)
        return { dir, serverPath: path.join(dir, serverName), cliPath: await exists(cliPath) ? cliPath : null }
      }
    }
    // Deeper: resolve symlinks too (isDirectory() covers dir symlinks).
    queue.push(...entries.filter((e) => e.isDirectory()).map((e) => path.join(dir, e.name)))
  }
  return null
}

// --- release fetching -----------------------------------------------------

const RELEASE_URL = 'https://api.github.com/repos/leejet/stable-diffusion.cpp/releases/latest'
const RELEASE_CACHE_MS = 10 * 60 * 1000

export interface LatestRelease {
  tag: string
  assets: { name: string; url: string }[]
}

let releaseCache: { release: LatestRelease; at: number } | null = null

/** Best-effort fetch of the latest release metadata; throws on non-2xx. */
export async function fetchLatestRelease(fetchImpl: typeof fetch = fetch): Promise<LatestRelease> {
  if (releaseCache && Date.now() - releaseCache.at < RELEASE_CACHE_MS) return releaseCache.release
  const res = await fetchImpl(RELEASE_URL, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'image-studio' } })
  if (res.status === 403 || res.status === 429) {
    throw new Error(`GitHub API rate limit exceeded (${res.status}). Try again later.`)
  }
  if (!res.ok) throw new Error(`GitHub API returned ${res.status} while fetching the latest stable-diffusion.cpp release.`)
  const json = (await res.json()) as { tag_name?: string; assets?: { name?: string; browser_download_url?: string }[] }
  const assets = (json.assets ?? [])
    .filter((a): a is { name: string; browser_download_url: string } => typeof a.name === 'string' && typeof a.browser_download_url === 'string')
    .map((a) => ({ name: a.name, url: a.browser_download_url }))
  const release = { tag: json.tag_name ?? '', assets }
  releaseCache = { release, at: Date.now() }
  return release
}

// --- download / install core (electron-free) ------------------------------

async function downloadToFile(
  url: string,
  dest: string,
  fetchImpl: typeof fetch,
  onProgress?: (received: number, total: number) => void
): Promise<void> {
  const res = await fetchImpl(url, { headers: { 'User-Agent': 'image-studio' } })
  if (res.status === 403 || res.status === 429) {
    throw new Error(`Download failed: GitHub rate limit exceeded (${res.status}). Try again later.`)
  }
  if (!res.ok) throw new Error(`Download failed: HTTP ${res.status} for ${url}`)
  if (!res.body) throw new Error('Download failed: empty response body')
  const total = Number(res.headers.get('content-length') ?? 0) || 0
  const out = await fs.open(dest, 'w')
  try {
    let received = 0
    for await (const chunk of res.body) {
      const buf = chunk as Buffer
      await out.write(buf)
      received += buf.length
      onProgress?.(received, total)
    }
  } finally {
    await out.close()
  }
}

/** Recursively chmod +x everything (files and dirs) so binaries and libs stay executable. */
async function chmodTree(dir: string): Promise<void> {
  await fs.chmod(dir, 0o755)
  const entries = await fs.readdir(dir, { withFileTypes: true })
  await Promise.all(
    entries.map(async (e) => {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) await chmodTree(p)
      else await fs.chmod(p, 0o755)
    })
  )
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p)
    return true
  } catch {
    return false
  }
}

async function copyStaleLibs(source: string, serverDir: string): Promise<void> {
  const entries = await fs.readdir(source, { withFileTypes: true, recursive: true })
  await Promise.all(
    entries
      .filter((e) => e.isFile() && /\.(so|so\.[0-9.]+|dylib|dll)$/.test(e.name) && e.parentPath !== undefined && path.dirname(path.join(e.parentPath, e.name)) !== serverDir)
      .map(async (e) => {
        if (!e.parentPath) return
        const src = path.join(e.parentPath, e.name)
        await fs.copyFile(src, path.join(serverDir, path.basename(src)))
      })
  )
}

export interface InstallCoreOptions {
  variantId: string
  platform: NodeJS.Platform
  /** Destination: <enginesRoot>/<variantId> will be created here. */
  enginesRoot: string
  /** Scratch space for zip + extraction (removed afterwards). */
  tmpRoot: string
  /** Already-downloaded zip (used by the fetch CLI and tests). */
  assetPath?: string
  /** Release to install; when omitted the latest release is fetched. */
  release?: LatestRelease
  fetchImpl?: typeof fetch
  onProgress?: (p: EngineInstallProgress) => void
}

export interface InstallCoreResult {
  engineDir: string
  serverPath: string
  cliPath: string | null
  tag: string
}

/**
 * Downloads (unless assetPath is given) the release asset for a variant,
 * extracts it, and atomically moves the directory containing sd-server into
 * <enginesRoot>/<variantId>, writing version.json alongside.
 */
export async function installEngineCore(opts: InstallCoreOptions): Promise<InstallCoreResult> {
  const { variantId, platform, enginesRoot, tmpRoot, onProgress } = opts
  const def = ENGINE_VARIANTS.find((v) => v.id === variantId)
  if (!def) throw new Error(`Unknown engine variant "${variantId}".`)
  if (!def.assetPattern) throw new Error(`Variant "${variantId}" is not downloadable (build it from source).`)
  if (def.platform !== platform) throw new Error(`Variant "${variantId}" is for ${def.platform}, not this platform.`)

  onProgress?.({ variantId, phase: 'downloading' })
  const assetPath = opts.assetPath ?? path.join(await fs.mkdtemp(path.join(tmpRoot, 'dl-')), 'asset.zip')
  if (!opts.assetPath) {
    const release = opts.release ?? (await fetchLatestRelease(opts.fetchImpl))
    const asset = matchAssetName(release.assets.map((a) => a.name), def.assetPattern)
    if (!asset) throw new Error(`No release asset matches variant "${variantId}" in the latest release.`)
    const url = release.assets.find((a) => a.name === asset)?.url
    if (!url) throw new Error(`Release asset "${asset}" has no download URL.`)
    await downloadToFile(url, assetPath, opts.fetchImpl ?? fetch, (received, total) => onProgress?.({ variantId, phase: 'downloading', received, total }))
  }

  onProgress?.({ variantId, phase: 'extracting' })
  const extractDir = await fs.mkdtemp(path.join(tmpRoot, 'ex-'))
  await extractZip(assetPath, { dir: extractDir })
  const found = await findServerDir(extractDir, platform)
  if (!found) throw new Error(`Extracted asset for "${variantId}" does not contain ${serverBinaryName(platform)}.`)
  // Shared libraries sometimes live next to the binary dir; make them visible
  // via cwd/LD_LIBRARY_PATH by pulling .so/.dylib/.dll files up (no-ops when
  // everything is already colocated).
  await copyStaleLibs(extractDir, found.dir)
  if (platform !== 'win32') await chmodTree(found.dir)
  await fs.writeFile(
    path.join(found.dir, 'version.json'),
    JSON.stringify({ tag: opts.release?.tag ?? '', installedAt: new Date().toISOString() }, null, 2)
  )

  const engineDir = path.join(enginesRoot, variantId)
  await fs.rm(engineDir, { recursive: true, force: true })
  await fs.mkdir(path.dirname(engineDir), { recursive: true })
  await fs.rename(found.dir, engineDir)
  await fs.rm(extractDir, { recursive: true, force: true })
  if (!opts.assetPath) await fs.rm(path.dirname(assetPath), { recursive: true, force: true })
  onProgress?.({ variantId, phase: 'done' })
  return { engineDir, serverPath: path.join(engineDir, serverBinaryName(platform)), cliPath: (await exists(path.join(engineDir, cliBinaryName(platform)))) ? path.join(engineDir, cliBinaryName(platform)) : null, tag: opts.release?.tag ?? ''}
}

// --- electron-dependent wrappers -----------------------------------------

/** Bundled engines: process.resourcesPath/sdcpp (packaged) or <repo>/resources/sdcpp (dev). */
export function bundledEnginesRoot(): string {
  return app.isPackaged ? path.join(process.resourcesPath, 'sdcpp') : path.join(app.getAppPath(), 'resources', 'sdcpp')
}

export function enginesRoot(): string {
  return path.join(app.getPath('userData'), 'engines')
}

export function installedEngineDir(variantId: string): string {
  return path.join(enginesRoot(), variantId)
}

/** Path to sd-server inside an engine dir, or null when absent. */
export async function engineServerPath(dir: string): Promise<string | null> {
  const p = path.join(dir, serverBinaryName())
  return (await exists(p)) ? p : null
}

export async function readInstalledVersion(variantId: string): Promise<string | undefined> {
  try {
    const raw = await fs.readFile(path.join(installedEngineDir(variantId), 'version.json'), 'utf8')
    const version = (JSON.parse(raw) as { tag?: string }).tag
    return version || undefined
  } catch {
    return undefined
  }
}

/**
 * Resolves which sd-server binary will be launched: custom path → installed
 * variant → bundled variant → first installed/bundled variant available.
 */
export async function resolveServerPath(settings: AppSettings): Promise<string | null> {
  if (settings.local.engineVariant === 'custom') {
    const custom = settings.local.customServerPath
    if (custom && (await exists(custom))) return custom
  }

  // Selected variant: installed copy wins over the bundled one.
  const selected = settings.local.engineVariant
  const known = selected && selected !== 'custom' && variantsForPlatform(process.platform).some((v) => v.id === selected)
  if (known) {
    const installed = await engineServerPath(installedEngineDir(selected))
    if (installed) return installed
    const bundled = await engineServerPath(path.join(bundledEnginesRoot(), selected))
    if (bundled) return bundled
  }

  // Fall back to the first installed, then bundled, variant for this platform.
  for (const def of variantsForPlatform(process.platform)) {
    const installed = await engineServerPath(installedEngineDir(def.id))
    if (installed) return installed
    const bundled = await engineServerPath(path.join(bundledEnginesRoot(), def.id))
    if (bundled) return bundled
  }
  return null
}

/** UI listing of the variants for this platform + resolved server path. Never throws on network errors. */
export async function getEngineInfo(settings: AppSettings): Promise<EngineInfo> {
  let latestVersion: string | undefined
  try {
    latestVersion = (await fetchLatestRelease()).tag
  } catch {
    // Offline / rate limited: latestVersion stays undefined (best effort).
  }
  const variants = await buildEngineVariants(process.platform, {
    isBundled: async (id) => (await engineServerPath(path.join(bundledEnginesRoot(), id))) !== null,
    installedVersion: (id) => readInstalledVersion(id)
  })
  return { variants, ...(latestVersion ? { latestVersion } : {}), serverPath: await resolveServerPath(settings) }
}

/** Downloads + installs an engine variant, reporting progress through onProgress. */
export async function installEngine(variantId: string, onProgress: (p: EngineInstallProgress) => void): Promise<void> {
  const def = ENGINE_VARIANTS.find((v) => v.id === variantId)
  if (!def || def.platform !== process.platform) {
    const msg = `Engine variant "${variantId}" is not available on this platform.`
    onProgress({ variantId, phase: 'error', error: msg })
    throw new Error(msg)
  }
  if (!def.assetPattern) {
    const msg = `Engine variant "${variantId}" must be built from source (scripts/build-sdcpp-cuda.sh).`
    onProgress({ variantId, phase: 'error', error: msg })
    throw new Error(msg)
  }
  try {
    await installEngineCore({
      variantId,
      platform: process.platform,
      enginesRoot: enginesRoot(),
      tmpRoot: path.join(app.getPath('temp'), 'image-studio-engine-tmp'),
      onProgress
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    onProgress({ variantId, phase: 'error', error: msg })
    throw err
  }
}

/** True when an installed (userData) variant dir contains a usable sd-server. */
export async function installedVariantIsUsable(variantId: string): Promise<boolean> {
  return (await findServerDir(installedEngineDir(variantId))) !== null
}
