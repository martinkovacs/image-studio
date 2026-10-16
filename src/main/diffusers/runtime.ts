// Managed Python runtime (<userData>/diffusers-runtime) for the diffusers
// backend: a pinned, checksum-verified uv from the astral-sh GitHub releases, a
// uv-managed Python 3.12, a staging venv with CUDA torch + diffusers swapped in
// with the old venv kept as venv.old until the swap succeeds, and a state.json
// with the install summary.
// Electron-dependent functions are kept at the bottom; the pure helpers and
// the core install routine (injected run/fetch) are exported separately so
// they are unit-testable.
import { app } from 'electron'
import path from 'node:path'
import fs from 'node:fs/promises'
import process from 'node:process'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import extractZip from 'extract-zip'
import type { DiffusersRuntimeInfo, RuntimeInstallProgress } from '@shared/types'

/** CUDA variant for the torch install; a single source of truth. */
export const TORCH_BACKEND = 'cu128'

// Pinned uv release. Checked 2026-10-16: tag from the GitHub latest release,
// checksums from the published <asset>.sha256 files (the linux asset was also
// verified by downloading it and running sha256sum). To bump: pick the new
// tag from https://github.com/astral-sh/uv/releases, refresh every checksum
// below from https://github.com/astral-sh/uv/releases/download/<tag>/<asset>.sha256.
/** Pinned uv release tag (see the bump instructions above). */
export const UV_VERSION = '0.13.1'
const uvReleaseUrl = (asset: string) => `https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/${asset}`
/** SHA-256 of each supported uv asset, embedded so no .sha256 fetch is needed. */
const UV_CHECKSUMS: Record<string, string> = {
  'uv-x86_64-unknown-linux-gnu.tar.gz': 'eadd9d27c134ab5ac1ffd4473b97a741407f3ea238288f03121fc4deddf90220',
  'uv-x86_64-pc-windows-msvc.zip': '3b2661a463a5baea7f5076ea2b25ab71d77f36a6c0d809e5350651792f80a672',
  'uv-aarch64-apple-darwin.tar.gz': 'cfe454573412ff7380d15fc7dae5997ab53ffce72fce0a78e91ddbc84001acd2'
}
const PYTHON_VERSION = '3.12'

// --- pure helpers ---------------------------------------------------------

/** uv release asset for a platform/arch, or null when unsupported. */
export function uvAssetName(platform: NodeJS.Platform, arch: string): string | null {
  if (platform === 'linux' && arch === 'x64') return 'uv-x86_64-unknown-linux-gnu.tar.gz'
  if (platform === 'win32' && arch === 'x64') return 'uv-x86_64-pc-windows-msvc.zip'
  if (platform === 'darwin' && arch === 'arm64') return 'uv-aarch64-apple-darwin.tar.gz'
  return null
}

/** uv binary name inside the archive and in <root>/uv. */
export function uvBinaryName(platform: NodeJS.Platform): string {
  return platform === 'win32' ? 'uv.exe' : 'uv'
}

/** Python executable inside a venv dir: bin/python (unix) or Scripts\python.exe (Windows). */
export function pythonPathIn(venvDir: string, platform: NodeJS.Platform): string {
  return platform === 'win32'
    ? path.join(venvDir, 'Scripts', 'python.exe')
    : path.join(venvDir, 'bin', 'python')
}

/** Env used for every uv/python call here: managed python + cache, and a scrubbed inherited env. */
export function uvEnv(root: string, base: Record<string, string | undefined> = process.env): Record<string, string | undefined> {
  const env = { ...base }
  for (const k of ['VIRTUAL_ENV', 'PYTHONHOME', 'PYTHONPATH', 'CONDA_PREFIX']) delete env[k]
  return {
    ...env,
    UV_PYTHON_INSTALL_DIR: path.join(root, 'python'),
    UV_CACHE_DIR: path.join(root, 'cache'),
    UV_NO_CONFIG: '1',
    UV_PYTHON_PREFERENCE: 'only-managed'
  }
}

// --- run / fetch plumbing ---------------------------------------------------

export interface RunOptions {
  env: Record<string, string | undefined>
  cwd?: string
  /** Every complete stdout/stderr line (uv / pip / installer output). */
  onLine?: (line: string) => void
}
/** Runs a command, streaming lines; resolves the exit code. */
export type RunFn = (cmd: string, args: string[], opts: RunOptions) => Promise<number>

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

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p)
    return true
  } catch {
    return false
  }
}

async function sha256File(p: string): Promise<string> {
  return createHash('sha256').update(await fs.readFile(p)).digest('hex')
}

/** Breadth-first search for a file of the given name inside `dir`. */
async function findFile(dir: string, fileName: string): Promise<string | null> {
  const queue: string[] = [dir]
  while (queue.length > 0) {
    const d = queue.shift() as string
    let entries: import('node:fs').Dirent[]
    try {
      entries = await fs.readdir(d, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of entries) {
      if (e.name === fileName && e.isFile()) return path.join(d, fileName)
    }
    queue.push(...entries.filter((e) => e.isDirectory()).map((e) => path.join(d, e.name)))
  }
  return null
}

// --- verify snippet ---------------------------------------------------------

const VERIFY_TORCH_EXIT = 2
const VERIFY_DIFFUSERS_EXIT = 3

/** Imports torch then diffusers, printed as one JSON line (stdout/code 0), exit 2 on a broken torch import, exit 3 on a broken diffusers import. CUDA unavailable is not a failure. */
const VERIFY_SNIPPET = [
  'import json, sys',
  'try:',
  '    import torch',
  'except Exception:',
  "    sys.stderr.write('torch cannot be imported\\n')",
  `    sys.exit(${VERIFY_TORCH_EXIT})`,
  'try:',
  '    import diffusers',
  'except Exception:',
  "    sys.stderr.write('diffusers cannot be imported\\n')",
  `    sys.exit(${VERIFY_DIFFUSERS_EXIT})`,
  'cuda = torch.cuda.is_available()',
  "device = torch.cuda.get_device_name(0) if cuda else ''",
  "print(json.dumps({'torch': torch.__version__, 'diffusers': diffusers.__version__, 'cuda': bool(cuda), 'device': device}))"
].join('\n')

interface VerifySummary {
  torch: string
  diffusers: string
  cuda: boolean
  device: string
}

/** Last parseable stdout line with the expected shape (stderr noise is tolerated). */
function readVerifyJson(lines: string[]): VerifySummary | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const obj = JSON.parse(lines[i]) as Partial<VerifySummary>
      if (obj && typeof obj === 'object' && typeof obj.diffusers === 'string') {
        return {
          torch: typeof obj.torch === 'string' ? obj.torch : '',
          diffusers: obj.diffusers,
          cuda: obj.cuda === true,
          device: typeof obj.device === 'string' ? obj.device : ''
        }
      }
    } catch {
      // Not the summary line.
    }
  }
  return null
}

// --- install core -----------------------------------------------------------

export interface RuntimeState {
  requirementsSha256: string
  installedAt: string
  torchVersion?: string
  diffusersVersion?: string
  cudaAvailable?: boolean
  deviceName?: string
}

export interface InstallRuntimeOptions {
  /** Runtime root directory (uv/, python/, cache/, venv/, state.json). */
  root: string
  requirementsPath: string
  platform: NodeJS.Platform
  arch: string
  run: RunFn
  fetchImpl?: typeof fetch
  onProgress?: (p: RuntimeInstallProgress) => void
  /** Pre-downloaded uv archive (skips the download and checksum). */
  uvArchivePath?: string
  /** Test hook overriding fs.rename in the venv swap. */
  renameImpl?: (from: string, to: string) => Promise<void>
  /** Test hook replacing the embedded pinned checksums. */
  uvChecksums?: Record<string, string>
}

/** One install or removal at a time, module-wide (they must not race). */
let operationInFlight: 'install' | 'remove' | null = null

/** True while an install or removal runs, for the UI busy state. */
export function runtimeBusy(): boolean {
  return operationInFlight !== null
}

/**
 * Installs the managed diffusers runtime into `root` (uv → python → staging
 * venv → torch → packages → verify → swap + state.json). Only one install or
 * removal may run at a time; a concurrent operation rejects.
 */
export async function installRuntimeCore(opts: InstallRuntimeOptions): Promise<RuntimeState> {
  if (operationInFlight === 'install') throw new Error('An install is already running.')
  if (operationInFlight === 'remove') throw new Error('A removal is running — wait for it to finish.')
  operationInFlight = 'install'
  try {
    return await doInstall(opts)
  } finally {
    operationInFlight = null
  }
}

async function doInstall(opts: InstallRuntimeOptions): Promise<RuntimeState> {
  const { root, requirementsPath, platform, arch, run, onProgress } = opts
  const report = (p: RuntimeInstallProgress) => onProgress?.(p)
  const uvDir = path.join(root, 'uv')
  const uvPath = path.join(uvDir, uvBinaryName(platform))
  const venvDir = path.join(root, 'venv')
  const stagingVenv = path.join(root, 'venv.staging')
  const stagingPython = pythonPathIn(stagingVenv, platform)
  const env = uvEnv(root)

  report({ phase: 'uv' })

  // 1. uv: install from GitHub unless the binary exists and reports a version.
  const haveUv = (await exists(uvPath)) && (await run(uvPath, ['--version'], { env })) === 0
  if (!haveUv) {
    await fs.mkdir(root, { recursive: true })
    const tmpDir = await fs.mkdtemp(path.join(root, 'uv-download-'))
    try {
      const assetName = opts.uvArchivePath ? '' : uvAssetName(platform, arch)
      if (!opts.uvArchivePath) {
        if (!assetName) throw new Error(`No uv release asset for ${platform}/${arch}.`)
        const checksums = opts.uvChecksums ?? UV_CHECKSUMS
        const expected = checksums[assetName]
        if (!expected) throw new Error(`No pinned uv checksum for asset "${assetName}".`)
        const archivePath = path.join(tmpDir, assetName)
        await downloadToFile(uvReleaseUrl(assetName), archivePath, opts.fetchImpl ?? fetch, (received, total) =>
          report({ phase: 'uv', received, total })
        )
        // Verify against the embedded checksum before extracting anything.
        const actual = await sha256File(archivePath)
        if (actual !== expected) {
          throw new Error(`uv archive checksum mismatch: expected ${expected}, got ${actual} — aborting before extraction.`)
        }
      }
      const archivePath = opts.uvArchivePath ?? path.join(tmpDir, assetName ?? '')
      // Extract: zip via extract-zip, tar.gz via the system tar.
      const extractDir = path.join(tmpDir, 'extract')
      await fs.mkdir(extractDir)
      if (archivePath.endsWith('.zip')) {
        await extractZip(archivePath, { dir: extractDir })
      } else if (archivePath.endsWith('.tar.gz')) {
        const code = await run('tar', ['-xzf', archivePath, '-C', extractDir], { env, cwd: tmpDir })
        if (code !== 0) throw new Error(`tar -xzf failed with exit code ${code}.`)
      } else {
        throw new Error(`Unknown uv archive format: ${path.basename(archivePath)}`)
      }
      const found = await findFile(extractDir, uvBinaryName(platform))
      if (!found) throw new Error(`Extracted uv archive does not contain ${uvBinaryName(platform)}.`)
      await fs.mkdir(uvDir, { recursive: true })
      await fs.copyFile(found, uvPath)
      if (platform !== 'win32') await fs.chmod(uvPath, 0o755)
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true })
    }
  }

  const stream = (phase: RuntimeInstallProgress['phase']) => (line: string) => report({ phase, log: line })
  const step = async (
    phase: RuntimeInstallProgress['phase'],
    cmd: string,
    args: string[],
    optsRun?: Partial<RunOptions>
  ): Promise<number> => {
    report({ phase })
    return run(cmd, args, { env, cwd: root, ...optsRun })
  }
  const fail = (what: string, code: number) => new Error(`${what} failed (exit code ${code}).`)
  let summary: VerifySummary | null = null

  // 2-6, with the staging venv cleaned up whenever the staged install fails.
  try {
    // 2. python (uv-managed, isolated from the system)
    let code = await step('python', uvPath, ['python', 'install', PYTHON_VERSION], { onLine: stream('python') })
    if (code !== 0) throw fail('uv python install', code)
    // 3. venv, staged first and renamed into place only after verification
    await fs.rm(stagingVenv, { recursive: true, force: true })
    code = await step('venv', uvPath, ['venv', stagingVenv, '--python', PYTHON_VERSION, '--clear', '--relocatable'], { onLine: stream('venv') })
    if (code !== 0) throw fail('uv venv', code)
    // 4. torch with the CUDA backend
    code = await step(
      'torch',
      uvPath,
      ['pip', 'install', '--python', stagingPython, 'torch', 'torchvision', `--torch-backend=${TORCH_BACKEND}`],
      { onLine: stream('torch') }
    )
    if (code !== 0) throw fail('uv pip install torch', code)
    // 5. everything else from requirements.txt (torch deliberately not listed)
    code = await step('packages', uvPath, ['pip', 'install', '--python', stagingPython, '-r', requirementsPath], {
      onLine: stream('packages')
    })
    if (code !== 0) throw fail('uv pip install -r requirements.txt', code)
    // 6. verify: CUDA unavailable is not a failure, a broken diffusers import is.
    const lines: string[] = []
    const verifyCode = await step('verify', stagingPython, ['-c', VERIFY_SNIPPET], {
      env: uvEnv(root),
      onLine: (line) => {
        lines.push(line)
        report({ phase: 'verify', log: line })
      }
    })
    if (verifyCode !== 0) {
      if (verifyCode === VERIFY_TORCH_EXIT) {
        throw new Error('Runtime verification failed: torch cannot be imported.')
      }
      if (verifyCode === VERIFY_DIFFUSERS_EXIT) {
        throw new Error('Runtime verification failed: diffusers cannot be imported.')
      }
      throw fail('Runtime verification', verifyCode)
    }
    summary = readVerifyJson(lines)
    if (!summary) throw new Error('Runtime verification did not print the expected JSON summary.')
  } catch (err) {
    // Keep the old venv intact on any staged failure.
    await fs.rm(stagingVenv, { recursive: true, force: true })
    throw err
  }
  if (!summary) throw new Error('Runtime verification did not print the expected JSON summary.')

  // 7. swap the verified staging venv in, keeping the old one until it succeeds:
  // venv → venv.old, staging → venv, and venv.old back if the last rename fails.
  const rename = opts.renameImpl ?? ((a: string, b: string) => fs.rename(a, b))
  const oldVenv = path.join(root, 'venv.old')
  await fs.rm(oldVenv, { recursive: true, force: true })
  const hadVenv = await exists(venvDir)
  if (hadVenv) {
    try {
      await rename(venvDir, oldVenv)
    } catch (err) {
      await fs.rm(stagingVenv, { recursive: true, force: true })
      throw err
    }
  }
  try {
    await rename(stagingVenv, venvDir)
  } catch (err) {
    if (hadVenv) await rename(oldVenv, venvDir).catch(() => undefined)
    throw err
  }
  if (hadVenv) await fs.rm(oldVenv, { recursive: true, force: true })
  const state: RuntimeState = {
    requirementsSha256: await sha256File(requirementsPath),
    installedAt: new Date().toISOString(),
    ...(summary.torch ? { torchVersion: summary.torch } : {}),
    ...(summary.diffusers ? { diffusersVersion: summary.diffusers } : {}),
    cudaAvailable: summary.cuda,
    ...(summary.device ? { deviceName: summary.device } : {})
  }
  await fs.writeFile(path.join(root, 'state.json'), JSON.stringify(state, null, 2))
  report({ phase: 'done' })
  return state
}

// --- info / removal ---------------------------------------------------------

/** Recursive size of the runtime dir, capped; best-effort. */
export async function runtimeSizeBytes(root: string): Promise<number> {
  let total = 0
  const stack: string[] = [root]
  let visits = 0
  while (stack.length > 0 && visits < 20000) {
    const dir = stack.pop() as string
    let entries: import('node:fs').Dirent[]
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of entries) {
      if (++visits >= 20000) break
      const p = path.join(dir, e.name)
      if (e.isDirectory()) stack.push(p)
      else if (e.isFile()) {
        try {
          total += (await fs.stat(p)).size
        } catch {
          // Best-effort.
        }
      }
    }
  }
  return total
}

/** Runtime status for a root; never throws. */
export async function runtimeInfo(
  root: string,
  requirementsPath: string,
  platform: NodeJS.Platform,
  arch: string
): Promise<DiffusersRuntimeInfo> {
  const supported = (platform === 'linux' || platform === 'win32') && arch === 'x64'
  const pythonPath = pythonPathIn(path.join(root, 'venv'), platform)
  try {
    if (!(await exists(pythonPath))) {
      return { supported, installed: false, outdated: false, pythonPath: null, busy: runtimeBusy() }
    }
    const state = JSON.parse(await fs.readFile(path.join(root, 'state.json'), 'utf8')) as RuntimeState
    let sha = ''
    try {
      sha = createHash('sha256').update(await fs.readFile(requirementsPath)).digest('hex')
    } catch {
      // Missing/unreadable requirements file: everything counts as outdated.
    }
    const outdated = state.requirementsSha256 !== sha
    return {
      supported,
      installed: true,
      outdated,
      busy: runtimeBusy(),
      pythonPath,
      ...(state.torchVersion ? { torchVersion: state.torchVersion } : {}),
      ...(state.diffusersVersion ? { diffusersVersion: state.diffusersVersion } : {}),
      ...(state.cudaAvailable !== undefined ? { cudaAvailable: state.cudaAvailable } : {}),
      ...(state.deviceName ? { deviceName: state.deviceName } : {}),
      sizeBytes: await runtimeSizeBytes(root)
    }
  } catch {
    return { supported, installed: false, outdated: false, pythonPath: null, busy: runtimeBusy() }
  }
}

/** Removes the managed runtime dir; refuses anything not named diffusers-runtime. */
export async function removeRuntime(
  root: string,
  removeImpl: (p: string, opts: { recursive: boolean; force: boolean }) => Promise<void> = fs.rm
): Promise<void> {
  if (!root.endsWith('diffusers-runtime')) {
    throw new Error(`Refusing to remove "${root}": not the diffusers runtime directory.`)
  }
  if (operationInFlight === 'install') throw new Error('An install is running — wait for it to finish.')
  if (operationInFlight === 'remove') throw new Error('A removal is already running.')
  operationInFlight = 'remove'
  try {
    await removeImpl(root, { recursive: true, force: true })
  } finally {
    operationInFlight = null
  }
}

// --- electron-dependent wrappers -------------------------------------------

/** node:child_process based RunFn: streams complete lines (handles \r) from both pipes. */
export function spawnRun(): RunFn {
  return (cmd, args, opts) =>
    new Promise((resolve, reject) => {
      let child: ReturnType<typeof spawn>
      try {
        child = spawn(cmd, args, { env: opts.env, cwd: opts.cwd, windowsHide: true })
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)))
        return
      }
      const lineReader = (onLine?: (line: string) => void) => {
        let carry = ''
        return (chunk: Buffer) => {
          carry += chunk.toString()
          const parts = carry.split(/\r\n|\r|\n/)
          carry = parts.pop() ?? ''
          for (const line of parts) {
            if (onLine && line !== '') onLine(line)
          }
        }
      }
      const readOut = lineReader(opts.onLine)
      const readErr = lineReader(opts.onLine)
      child.stdout?.on('data', readOut)
      child.stderr?.on('data', readErr)
      child.on('error', (err) => reject(err instanceof Error ? err : new Error(String(err))))
      child.on('close', (code) => resolve(code ?? 1))
    })
}

/** Managed runtime dir: <userData>/diffusers-runtime. */
export function runtimeRoot(): string {
  return path.join(app.getPath('userData'), 'diffusers-runtime')
}

/** Bundled diffusers resources: process.resourcesPath/diffusers (packaged) or <repo>/resources/diffusers (dev). */
function bundledDiffusersRoot(): string {
  return app.isPackaged ? path.join(process.resourcesPath, 'diffusers') : path.join(app.getAppPath(), 'resources', 'diffusers')
}

export function requirementsFile(): string {
  return path.join(bundledDiffusersRoot(), 'requirements.txt')
}

export function serverScript(): string {
  return path.join(bundledDiffusersRoot(), 'server.py')
}

/** Runtime info for this machine (never throws). */
export function getRuntimeInfo(): Promise<DiffusersRuntimeInfo> {
  return runtimeInfo(runtimeRoot(), requirementsFile(), process.platform, process.arch)
}

/** Full install, streaming RuntimeInstallProgress; only one install at a time. */
export async function installRuntime(onProgress: (p: RuntimeInstallProgress) => void): Promise<void> {
  try {
    await installRuntimeCore({
      root: runtimeRoot(),
      requirementsPath: requirementsFile(),
      platform: process.platform,
      arch: process.arch,
      run: spawnRun(),
      onProgress
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    onProgress({ phase: 'error', error: msg })
    throw err
  }
}

export function uninstallRuntime(): Promise<void> {
  return removeRuntime(runtimeRoot())
}

/** Python executable of the managed runtime, or null when not installed. */
export async function runtimePythonPath(): Promise<string | null> {
  const info = await getRuntimeInfo()
  return info.installed && info.pythonPath ? info.pythonPath : null
}
