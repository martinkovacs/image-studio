import { afterAll, describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import {
  TORCH_BACKEND,
  installRuntimeCore,
  pythonPathIn,
  removeRuntime,
  runtimeInfo,
  uvAssetName,
  uvBinaryName,
  uvEnv,
  type InstallRuntimeOptions,
  type RunFn
} from './runtime'

const sha256Hex = (data: Buffer | string): string => createHash('sha256').update(data).digest('hex')

// The fake runner never unpacks archives: the 'tar' handler plants a fake uv
// binary (in the layout the real tarball uses) into the extract dir instead.
const FAKE_UV = '#!/bin/sh\necho uv 0.9.0\n'
const VERIFIED_JSON =
  '{"torch":"2.9.0+cu128","diffusers":"0.36.0","cuda":true,"device":"NVIDIA GeForce RTX 4090"}'

interface RecordedCmd {
  cmd: string
  args: string[]
  env: Record<string, string | undefined>
}

interface FakeRunOpts {
  /** Return 3 (diffusers import failure) for the python -c verification step. */
  failVerify?: boolean
  includeVersionLine?: boolean
}

function makeFakeRun(opts: FakeRunOpts = {}): { run: RunFn, commands: RecordedCmd[] } {
  const commands: RecordedCmd[] = []
  const run: RunFn = async (cmd, args, runOpts) => {
    commands.push({ cmd, args, env: runOpts.env })
    if (cmd === 'tar') {
      const dir = args[args.indexOf('-C') + 1]
      const inner = path.join(dir, 'uv-x86_64-unknown-linux-gnu')
      await fs.mkdir(inner, { recursive: true })
      await fs.writeFile(path.join(inner, 'uv'), FAKE_UV)
      return 0
    }
    if (args.includes('venv')) {
      const venv = args[1] as string
      await fs.mkdir(path.join(venv, 'bin'), { recursive: true })
      await fs.writeFile(path.join(venv, 'bin', 'python'), 'stub python')
    }
    if (args.includes('-c')) {
      if (opts.failVerify) return 3
      runOpts.onLine?.(VERIFIED_JSON)
    }
    return 0
  }
  return { run, commands }
}

// A tiny deterministic "archive". The checksum is verified for real, the
// extraction is faked, so only the bytes need to exist.
const ARCHIVE_BYTES = Buffer.from('pretend-this-is-a-targz-of-uv')

function makeFetch(shaLine: string): typeof fetch {
  const asset = uvAssetName('linux', 'x64') as string
  const release = {
    tag_name: '0.9.0',
    assets: [
      { name: asset, browser_download_url: `https://dl.test/${asset}` },
      { name: `${asset}.sha256`, browser_download_url: `https://dl.test/${asset}.sha256` }
    ]
  }
  return async (input: string | URL | globalThis.Request) => {
    const url = String(input)
    if (url.includes('releases/latest')) return new Response(JSON.stringify(release))
    if (url.endsWith('.sha256')) return new Response(shaLine)
    return new Response(new Uint8Array(ARCHIVE_BYTES))
  }
}

function coreOpts(root: string, requirementsPath: string, over: Partial<InstallRuntimeOptions> = {}): InstallRuntimeOptions {
  return {
    root,
    requirementsPath,
    platform: 'linux',
    arch: 'x64',
    run: makeFakeRun().run,
    fetchImpl: makeFetch(`${sha256Hex(ARCHIVE_BYTES)}  ${uvAssetName('linux', 'x64')}\n`),
    ...over
  }
}

// --- pure helpers -----------------------------------------------------------

describe('uvAssetName', () => {
  it('maps supported platform/arch pairs', () => {
    expect(uvAssetName('linux', 'x64')).toBe('uv-x86_64-unknown-linux-gnu.tar.gz')
    expect(uvAssetName('win32', 'x64')).toBe('uv-x86_64-pc-windows-msvc.zip')
    expect(uvAssetName('darwin', 'arm64')).toBe('uv-aarch64-apple-darwin.tar.gz')
  })
  it('returns null for unsupported combos', () => {
    expect(uvAssetName('linux', 'arm64')).toBeNull()
    expect(uvAssetName('darwin', 'x64')).toBeNull()
    expect(uvAssetName('freebsd', 'x64')).toBeNull()
  })
})

describe('uvBinaryName + pythonPathIn', () => {
  it('uv.exe on Windows, uv elsewhere', () => {
    expect(uvBinaryName('win32')).toBe('uv.exe')
    expect(uvBinaryName('linux')).toBe('uv')
  })
  it('Scripts\\python.exe vs bin/python', () => {
    expect(pythonPathIn('/r/venv', 'win32')).toBe(path.join('/r/venv', 'Scripts', 'python.exe'))
    expect(pythonPathIn('/r/venv', 'linux')).toBe(path.join('/r/venv', 'bin', 'python'))
  })
})

describe('uvEnv', () => {
  it('sets the uv isolation vars and scrubs inherited python env', () => {
    const env = uvEnv('/r', { VIRTUAL_ENV: '/old', PYTHONHOME: '/x', PYTHONPATH: '/y', CONDA_PREFIX: '/z', PATH: '/bin' })
    expect(env.UV_PYTHON_INSTALL_DIR).toBe(path.join('/r', 'python'))
    expect(env.UV_CACHE_DIR).toBe(path.join('/r', 'cache'))
    expect(env.UV_NO_CONFIG).toBe('1')
    expect(env.UV_PYTHON_PREFERENCE).toBe('only-managed')
    expect(env.VIRTUAL_ENV).toBeUndefined()
    expect(env.PYTHONHOME).toBeUndefined()
    expect(env.PYTHONPATH).toBeUndefined()
    expect(env.CONDA_PREFIX).toBeUndefined()
  })
})

// --- install core -----------------------------------------------------------

const REQ_CONTENT = '# torch is installed separately with the CUDA backend\ndiffusers>=0.36\n'

describe('installRuntimeCore', () => {
  const roots: string[] = []

  afterAll(async () => {
    await Promise.all(roots.map((r) => fs.rm(r, { recursive: true, force: true })))
  })

  const newRoot = async (name: string): Promise<string> => {
    const root = path.join(await fs.mkdtemp(path.join(os.tmpdir(), `rt-${name}-`)), 'diffusers-runtime')
    roots.push(root)
    return root
  }

  const reqFile = async (root: string): Promise<string> => {
    const p = path.join(root, 'requirements.txt')
    await fs.mkdir(root, { recursive: true })
    await fs.writeFile(p, REQ_CONTENT)
    return p
  }

  it('downloads+verifies uv, then python/venv/torch/packages/verify, swapping the venv atomically', async () => {
    const root = await newRoot('happy')
    const requirementsPath = await reqFile(root)
    const { run, commands } = makeFakeRun()
    const progress: import('@shared/types').RuntimeInstallProgress[] = []
    const fake = makeFetch(`${sha256Hex(ARCHIVE_BYTES)}  ${uvAssetName('linux', 'x64')}\n`)

    const state = await installRuntimeCore({
      root,
      requirementsPath,
      platform: 'linux',
      arch: 'x64',
      run,
      fetchImpl: fake,
      onProgress: (p) => progress.push(p)
    })

    // Phases in order (uv repeated for per-byte download progress).
    expect([...new Set(progress.map((p) => p.phase))]).toEqual(['uv', 'python', 'venv', 'torch', 'packages', 'verify', 'done'])
    expect(progress.some((p) => p.phase === 'uv' && p.received === ARCHIVE_BYTES.length)).toBe(true)

    // Command sequence: tar extract, then uv calls, then the verifying python.
    const uvPath = path.join(root, 'uv', 'uv')
    expect(commands.map((c) => c.cmd)).toEqual(['tar', uvPath, uvPath, uvPath, uvPath, path.join(root, 'venv.staging', 'bin', 'python')])
    expect(commands[0].args.slice(0, 3)).toEqual(['-xzf', commands[0].args[1], commands[0].args[2]])
    expect(commands[0].args[1].endsWith(`${uvAssetName('linux', 'x64')}`)).toBe(true)
    expect(commands[1].args).toEqual(['python', 'install', '3.12'])
    expect(commands[2].args[0]).toBe('venv')
    expect(commands[2].args[1]).toBe(path.join(root, 'venv.staging'))
    expect(commands[2].args.slice(2, 4)).toEqual(['--python', '3.12'])
    expect(commands[2].args).toContain('--clear')
    expect(commands[3].args).toEqual([
      'pip', 'install', '--python', path.join(root, 'venv.staging', 'bin', 'python'), 'torch', 'torchvision', `--torch-backend=${TORCH_BACKEND}`
    ])
    expect(commands[4].args).toEqual(['pip', 'install', '--python', path.join(root, 'venv.staging', 'bin', 'python'), '-r', requirementsPath])
    expect(commands[5].args[0]).toBe('-c')

    // Env plumbing used by uv steps.
    for (const c of commands.slice(1, 5)) {
      expect(c.env.UV_PYTHON_INSTALL_DIR).toBe(path.join(root, 'python'))
      expect(c.env.UV_CACHE_DIR).toBe(path.join(root, 'cache'))
      expect(c.env.UV_NO_CONFIG).toBe('1')
      expect(c.env.UV_PYTHON_PREFERENCE).toBe('only-managed')
    }

    // Verified state + atomic swap artifacts.
    expect(state).toMatchObject({
      torchVersion: '2.9.0+cu128',
      diffusersVersion: '0.36.0',
      cudaAvailable: true,
      deviceName: 'NVIDIA GeForce RTX 4090'
    })
    await expect(fs.readFile(path.join(root, 'uv', 'uv'), 'utf8')).resolves.toBe(FAKE_UV)
    await expect(fs.stat(path.join(root, 'venv', 'bin', 'python'))).resolves.toBeTruthy()
    await expect(fs.stat(path.join(root, 'venv.staging'))).rejects.toMatchObject({ code: 'ENOENT' })
    const stateFile = JSON.parse(await fs.readFile(path.join(root, 'state.json'), 'utf8')) as Record<string, string>
    expect(stateFile.requirementsSha256).toBe(sha256Hex(REQ_CONTENT))
    // The download scratch dir is gone again.
    expect((await fs.readdir(root)).filter((n) => n.startsWith('uv-download-'))).toEqual([])
  })

  it('skips the uv download when uv already exists and --version succeeds', async () => {
    const root = await newRoot('reuse')
    const requirementsPath = await reqFile(root)
    await fs.mkdir(path.join(root, 'uv'), { recursive: true })
    await fs.writeFile(path.join(root, 'uv', 'uv'), FAKE_UV)
    const { run, commands } = makeFakeRun()
    const noNetworkFetch = async () => {
      throw new Error('no network expected')
    }
    await installRuntimeCore({ root, requirementsPath, platform: 'linux', arch: 'x64', run, fetchImpl: noNetworkFetch as unknown as typeof fetch })
    expect(commands.map((c) => c.cmd)).not.toContain('tar')
    expect(commands.some((c) => c.args.includes('--version'))).toBe(true)
  })

  it('aborts before extraction when the checksum does not match', async () => {
    const root = await newRoot('badsha')
    const requirementsPath = await reqFile(root)
    const { run, commands } = makeFakeRun()
    const bad = makeFetch(`${'0'.repeat(64)}  ${uvAssetName('linux', 'x64')}\n`)
    await expect(
      installRuntimeCore({ root, requirementsPath, platform: 'linux', arch: 'x64', run, fetchImpl: bad })
    ).rejects.toThrow('checksum mismatch')
    expect(commands.map((c) => c.cmd)).not.toContain('tar')
    await expect(fs.stat(path.join(root, 'uv', 'uv'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('keeps the old venv intact when verification fails', async () => {
    const root = await newRoot('failverify')
    const requirementsPath = await reqFile(root)
    // Simulate a previous install: an existing venv and no staging dir.
    await fs.mkdir(path.join(root, 'venv', 'bin'), { recursive: true })
    await fs.writeFile(path.join(root, 'venv', 'bin', 'python'), 'old python')
    const { run, commands } = makeFakeRun({ failVerify: true })
    const uvPath = path.join(root, 'uv', 'uv')
    await fs.mkdir(path.join(root, 'uv'), { recursive: true })
    await fs.writeFile(uvPath, FAKE_UV) // skip the uv download branch
    await expect(
      installRuntimeCore({ root, requirementsPath, platform: 'linux', arch: 'x64', run, fetchImpl: makeFetch('') })
    ).rejects.toThrow('diffusers cannot be imported')
    // The verify step ran, and only against the staging python.
    const verify = commands.filter((c) => c.args.includes('-c'))
    expect(verify).toHaveLength(1)
    expect(verify[0].cmd).toBe(path.join(root, 'venv.staging', 'bin', 'python'))
    // Old venv untouched, staging cleaned up, no state.json.
    await expect(fs.readFile(path.join(root, 'venv', 'bin', 'python'), 'utf8')).resolves.toBe('old python')
    await expect(fs.stat(path.join(root, 'venv.staging'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(fs.stat(path.join(root, 'state.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects a second concurrent install and releases the guard afterwards', async () => {
    const root = await newRoot('concurrent')
    const requirementsPath = await reqFile(root)
    await fs.mkdir(path.join(root, 'uv'), { recursive: true })
    await fs.writeFile(path.join(root, 'uv', 'uv'), FAKE_UV)
    let release = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const blocked: RunFn = async (cmd, args, opts) => {
      await gate
      const { run } = makeFakeRun()
      return run(cmd, args, opts)
    }
    const first = installRuntimeCore({ root, requirementsPath, platform: 'linux', arch: 'x64', run: blocked })
    await expect(
      installRuntimeCore({ root, requirementsPath, platform: 'linux', arch: 'x64', run: blocked })
    ).rejects.toThrow('An install is already running')
    release()
    await expect(first).resolves.toBeTruthy()
  })
})

// --- removeRuntime ----------------------------------------------------------

describe('removeRuntime', () => {
  const tmps: string[] = []
  afterAll(async () => {
    await Promise.all(tmps.map((r) => fs.rm(r, { recursive: true, force: true })))
  })

  it('refuses directories not named diffusers-runtime', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'not-it-'))
    tmps.push(dir)
    await fs.writeFile(path.join(dir, 'precious.txt'), 'keep me')
    await expect(removeRuntime(dir)).rejects.toThrow('not the diffusers runtime directory')
    await expect(fs.readFile(path.join(dir, 'precious.txt'), 'utf8')).resolves.toBe('keep me')
  })

  it('removes the managed runtime directory', async () => {
    const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'rt-remove-'))
    tmps.push(parent)
    const dir = path.join(parent, 'diffusers-runtime')
    await fs.mkdir(dir)
    await fs.writeFile(path.join(dir, 'state.json'), '{}')
    await removeRuntime(dir)
    await expect(fs.stat(dir)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})

// --- runtimeInfo ------------------------------------------------------------

describe('runtimeInfo', () => {
  const tmps: string[] = []
  afterAll(async () => {
    await Promise.all(tmps.map((r) => fs.rm(r, { recursive: true, force: true })))
  })

  const seededRoot = async (state: Record<string, unknown> | null): Promise<{ root: string, requirementsPath: string }> => {
    const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'rt-info-'))
    tmps.push(parent)
    const root = path.join(parent, 'diffusers-runtime')
    await fs.mkdir(path.join(root, 'venv', 'bin'), { recursive: true })
    await fs.writeFile(path.join(root, 'venv', 'bin', 'python'), 'stub')
    if (state) await fs.writeFile(path.join(root, 'state.json'), JSON.stringify(state))
    const requirementsPath = path.join(parent, 'requirements.txt')
    await fs.writeFile(requirementsPath, REQ_CONTENT)
    return { root, requirementsPath }
  }

  it('reports installed + supported with sha data', async () => {
    const { root, requirementsPath } = await seededRoot({
      requirementsSha256: sha256Hex(REQ_CONTENT),
      installedAt: '2026-01-01T00:00:00.000Z',
      torchVersion: '2.9.0+cu128',
      diffusersVersion: '0.36.0',
      cudaAvailable: false,
      deviceName: ''
    })
    const info = await runtimeInfo(root, requirementsPath, 'linux', 'x64')
    expect(info.supported).toBe(true)
    expect(info.installed).toBe(true)
    expect(info.outdated).toBe(false)
    expect(info.pythonPath).toBe(path.join(root, 'venv', 'bin', 'python'))
    expect(info.torchVersion).toBe('2.9.0+cu128')
    expect(info.diffusersVersion).toBe('0.36.0')
    expect(info.sizeBytes).toBeGreaterThan(0)
  })

  it('flags outdated when requirements change since the install', async () => {
    const { root, requirementsPath } = await seededRoot({ requirementsSha256: 'deadbeef' })
    const info = await runtimeInfo(root, requirementsPath, 'linux', 'x64')
    expect(info.installed).toBe(true)
    expect(info.outdated).toBe(true)
  })

  it('reports installed:false when python or the state file are missing', async () => {
    const { root, requirementsPath } = await seededRoot(null)
    expect((await runtimeInfo(root, requirementsPath, 'linux', 'x64')).installed).toBe(false)
    const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'rt-empty-'))
    tmps.push(parent)
    const empty = await runtimeInfo(parent, requirementsPath, 'linux', 'x64')
    expect(empty.installed).toBe(false)
    expect(empty.pythonPath).toBeNull()
    expect(empty.outdated).toBe(false)
  })

  it('marks the platform unsupported and never throws', async () => {
    const { root, requirementsPath } = await seededRoot({ requirementsSha256: sha256Hex(REQ_CONTENT) })
    const mac = await runtimeInfo(root, requirementsPath, 'darwin', 'arm64')
    expect(mac.supported).toBe(false)
    expect(mac.installed).toBe(true)
    const bogus = await runtimeInfo(root, path.join(root, 'missing-requirements.txt'), 'linux', 'x64')
    expect(bogus.outdated).toBe(true)
  })
})
