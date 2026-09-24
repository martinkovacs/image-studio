import { afterAll, describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  ENGINE_VARIANTS,
  buildEngineVariants,
  defaultVariantId,
  findServerDir,
  installEngineCore,
  matchAssetName,
  variantsForPlatform,
  type LatestRelease
} from './engine'

// Asset names from the latest released tags of leejet/stable-diffusion.cpp
// (note: the tag prefix `sd-master-<sha>-bin-…` varies with every release;
// patterns deliberately only anchor on the platform/backend suffixes).
const RELEASE_ASSETS = [
  'sd-master-88411ef-bin-Linux-Ubuntu-24.04-x86_64-vulkan.zip',
  'sd-master-88411ef-bin-Linux-Ubuntu-24.04-x86_64.zip',
  'sd-master-88411ef-bin-Linux-Ubuntu-24.04-x86_64-cuda12.zip',
  'sd-master-88411ef-bin-Darwin-macOS-26.6.2-arm64.zip',
  'sd-master-88411ef-bin-win-cuda12-x64.zip',
  'sd-master-88411ef-bin-win-vulkan-x64.zip',
  'sd-master-88411ef-bin-win-cpu-x64.zip',
  'sd-master-88411ef-bin-win-rocm-7.14.0-x64.zip',
  'cudart-sd-bin-win-cu12-x64.zip',
  'SOURCE_CODE usd.zip'
].filter((name) => name.startsWith('sd-') || name.startsWith('cudart-'))

describe('ENGINE_VARIANTS', () => {
  it('has one entry per expected id per platform', () => {
    for (const id of ['linux-vulkan', 'linux-cpu', 'linux-rocm', 'linux-cuda-source', 'win-cuda12', 'win-vulkan', 'win-cpu', 'win-rocm', 'mac-arm64']) {
      expect(ENGINE_VARIANTS.map((v) => v.id)).toContain(id)
    }
    expect(variantsForPlatform('linux').map((v) => v.id)).toEqual([
      'linux-vulkan',
      'linux-cpu',
      'linux-rocm',
      'linux-cuda-source'
    ])
    expect(variantsForPlatform('win32').every((v) => v.assetPattern)).toBe(true)
    expect(variantsForPlatform('linux').find((v) => v.id === 'linux-cuda-source')?.assetPattern).toBeNull()
  })
})

describe('matchAssetName', () => {
  it('matches linux vulkan', () => {
    expect(matchAssetName(RELEASE_ASSETS, variantsForPlatform('linux').find((v) => v.id === 'linux-vulkan')!.assetPattern!)).toBe(
      'sd-master-88411ef-bin-Linux-Ubuntu-24.04-x86_64-vulkan.zip'
    )
  })
  it('matches linux cpu (no farther vulkan asset)', () => {
    // The plain cpu asset name ends with `-x86_64.zip`, distinct from vulkan/rocm ones
    const cpuPattern = variantsForPlatform('linux').find((v) => v.id === 'linux-cpu')!.assetPattern!
    expect(matchAssetName(RELEASE_ASSETS, cpuPattern)).toBe('sd-master-88411ef-bin-Linux-Ubuntu-24.04-x86_64.zip')
    // Without the plain cpu asset, nothing matches exactly
    const noCpu = RELEASE_ASSETS.filter((n) => !n.endsWith('-x86_64.zip') || n.includes('vulkan'))
    expect(matchAssetName(noCpu, cpuPattern)).toBeNull()
  })
  it('matches linux rocm', () => {
    const rocmPattern = variantsForPlatform('linux').find((v) => v.id === 'linux-rocm')!.assetPattern!
    expect(matchAssetName(RELEASE_ASSETS, rocmPattern)).toBeNull()
    expect(matchAssetName(
      [...RELEASE_ASSETS, 'sd-master-88411ef-bin-Linux-Ubuntu-24.04-x86_64-rocm-7.14.0.zip'],
      rocmPattern
    )).toBe('sd-master-88411ef-bin-Linux-Ubuntu-24.04-x86_64-rocm-7.14.0.zip')
  })
  it('matches win cuda12 / vulkan / cpu / rocm', () => {
    const win = Object.fromEntries(variantsForPlatform('win32').map((v) => [v.id, v.assetPattern!]))
    expect(matchAssetName(RELEASE_ASSETS, win['win-cuda12'])).toBe('sd-master-88411ef-bin-win-cuda12-x64.zip')
    expect(matchAssetName(RELEASE_ASSETS, win['win-vulkan'])).toBe('sd-master-88411ef-bin-win-vulkan-x64.zip')
    expect(matchAssetName(RELEASE_ASSETS, win['win-cpu'])).toBe('sd-master-88411ef-bin-win-cpu-x64.zip')
    expect(matchAssetName(RELEASE_ASSETS, win['win-rocm'])).toBe('sd-master-88411ef-bin-win-rocm-7.14.0-x64.zip')
  })
  it('matches mac arm64', () => {
    const macPattern = variantsForPlatform('darwin').find((v) => v.id === 'mac-arm64')!.assetPattern!
    expect(matchAssetName(RELEASE_ASSETS, macPattern)).toBe('sd-master-88411ef-bin-Darwin-macOS-26.6.2-arm64.zip')
  })
  it('never matches the runtime DLL-only assets', () => {
    for (const def of variantsForPlatform('win32')) {
      expect(matchAssetName(['cudart-sd-bin-win-cu12-x64.zip'], def.assetPattern!)).toBeNull()
    }
  })
})

describe('defaultVariantId', () => {
  it('maps platform → default variant', () => {
    expect(defaultVariantId('linux')).toBe('linux-vulkan')
    expect(defaultVariantId('win32')).toBe('win-cuda12')
    expect(defaultVariantId('darwin')).toBe('mac-arm64')
  })
})

describe('buildEngineVariants', () => {
  it('marks installed and bundled states from the probes', async () => {
    const variants = await buildEngineVariants('linux', {
      isBundled: async (id) => id === 'linux-vulkan',
      installedVersion: async (id) => (id === 'linux-cpu' ? 'master-123-abc' : undefined)
    })
    const byId = Object.fromEntries(variants.map((v) => [v.id, v]))
    expect(byId['linux-vulkan'].bundled).toBe(true)
    expect(byId['linux-vulkan'].installed).toBe(false)
    expect(byId['linux-cpu'].installed).toBe(true)
    expect(byId['linux-cpu'].installedVersion).toBe('master-123-abc')
    expect(byId['linux-cuda-source'].bundled).toBe(false)
    expect(byId['linux-cuda-source'].assetPattern).toBeNull()
  })
})

describe('findServerDir', () => {
  it.skip('locates sd-server inside a nested extraction tree (covered by the network install test)', () => {})
})

// ---------------------------------------------------------------------------
// installEngineCore: atomic staging swap inside the engines root.
// extract-zip needs a real zip, so build minimal stored (uncompressed) zips.

let CRC_TABLE: number[] | null = null
function crc32(buf: Buffer): number {
  if (!CRC_TABLE) {
    CRC_TABLE = []
    for (let n = 0; n < 256; n++) {
      let c = n
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      CRC_TABLE[n] = c >>> 0
    }
  }
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff]! ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function makeZip(files: { name: string; data: string }[]): Buffer {
  const parts: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0
  for (const f of files) {
    const name = Buffer.from(f.name, 'utf8')
    const data = Buffer.from(f.data, 'utf8')
    const crc = crc32(data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0, 6) // flags
    local.writeUInt16LE(0, 8) // method: store
    local.writeUInt16LE(0, 10) // time
    local.writeUInt16LE(0x21, 12) // date
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(name.length, 26)
    local.writeUInt16LE(0, 28)
    parts.push(local, name, data)
    const cen = Buffer.alloc(46)
    cen.writeUInt32LE(0x02014b50, 0)
    cen.writeUInt16LE(20, 4)
    cen.writeUInt16LE(20, 6)
    cen.writeUInt16LE(0, 8)
    cen.writeUInt16LE(0, 10)
    cen.writeUInt16LE(0, 12)
    cen.writeUInt16LE(0x21, 14)
    cen.writeUInt32LE(crc, 16)
    cen.writeUInt32LE(data.length, 20)
    cen.writeUInt32LE(data.length, 24)
    cen.writeUInt16LE(name.length, 28)
    cen.writeUInt32LE(0, 38)
    cen.writeUInt32LE(offset, 42)
    central.push(cen, name)
    offset += 30 + name.length + data.length
  }
  const centralBuf = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(files.length, 8)
  end.writeUInt16LE(files.length, 10)
  end.writeUInt32LE(centralBuf.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...parts, centralBuf, end])
}

const release = (tag: string): LatestRelease => ({ tag, assets: [] })

async function writeAssetZip(tmpRoot: string, tag: string, content: string): Promise<string> {
  const assetPath = path.join(tmpRoot, `asset-${tag}.zip`)
  await fs.writeFile(assetPath, makeZip([{ name: `sd-master-${tag}/sd-server`, data: content }]))
  return assetPath
}

describe('installEngineCore (atomic staging swap)', () => {
  const tmpRoots: string[] = []

  afterAll(async () => {
    await Promise.all(tmpRoots.map((r) => fs.rm(r, { recursive: true, force: true })))
  })

  const newRoots = async (): Promise<{ enginesRoot: string; tmpRoot: string }> => {
    const enginesRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'engines-test-'))
    const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'tmp-test-'))
    tmpRoots.push(enginesRoot, tmpRoot)
    return { enginesRoot, tmpRoot }
  }

  const leftoverSwapDirs = async (enginesRoot: string): Promise<string[]> =>
    (await fs.readdir(enginesRoot)).filter((n) => n.startsWith('.staging-') || n.startsWith('.old-'))

  it('installs into <enginesRoot>/<variant> with version.json and leaves no scratch dirs', async () => {
    const { enginesRoot, tmpRoot } = await newRoots()
    const assetPath = await writeAssetZip(tmpRoot, 'v1', 'bin-one')
    const res = await installEngineCore({
      variantId: 'linux-vulkan',
      platform: 'linux',
      enginesRoot,
      tmpRoot,
      assetPath,
      release: release('v1')
    })
    expect(res.engineDir).toBe(path.join(enginesRoot, 'linux-vulkan'))
    expect(res.serverPath).toBe(path.join(enginesRoot, 'linux-vulkan', 'sd-server'))
    expect(res.tag).toBe('v1')
    await expect(fs.readFile(res.serverPath, 'utf8')).resolves.toContain('bin-one')
    const version = JSON.parse(await fs.readFile(path.join(res.engineDir, 'version.json'), 'utf8')) as { tag: string }
    expect(version.tag).toBe('v1')
    expect(await leftoverSwapDirs(enginesRoot)).toEqual([])
  })

  it('replaces an existing install atomically and calls beforeReplace before the swap', async () => {
    const { enginesRoot, tmpRoot } = await newRoots()
    const p1 = await writeAssetZip(tmpRoot, 'v1', 'bin-one')
    await installEngineCore({ variantId: 'linux-vulkan', platform: 'linux', enginesRoot, tmpRoot, assetPath: p1, release: release('v1') })
    const p2 = await writeAssetZip(tmpRoot, 'v2', 'bin-two')
    const events: string[] = []
    await installEngineCore({
      variantId: 'linux-vulkan',
      platform: 'linux',
      enginesRoot,
      tmpRoot,
      assetPath: p2,
      release: release('v2'),
      beforeReplace: async () => {
        events.push('beforeReplace')
        // The old version must still be in place when the callback runs.
        const version = JSON.parse(await fs.readFile(path.join(enginesRoot, 'linux-vulkan', 'version.json'), 'utf8')) as { tag: string }
        expect(version.tag).toBe('v1')
      }
    })
    expect(events).toEqual(['beforeReplace'])
    await expect(fs.readFile(path.join(enginesRoot, 'linux-vulkan', 'sd-server'), 'utf8')).resolves.toContain('bin-two')
    expect(await leftoverSwapDirs(enginesRoot)).toEqual([])
  })

  it('restores the old install when beforeReplace throws', async () => {
    const { enginesRoot, tmpRoot } = await newRoots()
    const p1 = await writeAssetZip(tmpRoot, 'v1', 'bin-one')
    await installEngineCore({ variantId: 'linux-vulkan', platform: 'linux', enginesRoot, tmpRoot, assetPath: p1, release: release('v1') })
    const p2 = await writeAssetZip(tmpRoot, 'v2', 'bin-two')
    await expect(
      installEngineCore({
        variantId: 'linux-vulkan',
        platform: 'linux',
        enginesRoot,
        tmpRoot,
        assetPath: p2,
        release: release('v2'),
        beforeReplace: async () => {
          throw new Error('server busy')
        }
      })
    ).rejects.toThrow('server busy')
    // The old install is intact.
    await expect(fs.readFile(path.join(enginesRoot, 'linux-vulkan', 'sd-server'), 'utf8')).resolves.toContain('bin-one')
    expect(await leftoverSwapDirs(enginesRoot)).toEqual([])
  })

  it('cleans up leftover .staging-*/.old-* dirs from a killed install', async () => {
    const { enginesRoot, tmpRoot } = await newRoots()
    await fs.mkdir(path.join(enginesRoot, '.staging-linux-vulkan-junk'), { recursive: true })
    await fs.mkdir(path.join(enginesRoot, '.old-linux-vulkan-junk'), { recursive: true })
    const assetPath = await writeAssetZip(tmpRoot, 'v1', 'bin-one')
    await installEngineCore({
      variantId: 'linux-vulkan',
      platform: 'linux',
      enginesRoot,
      tmpRoot,
      assetPath,
      release: release('v1')
    })
    expect(await leftoverSwapDirs(enginesRoot)).toEqual([])
  })
})
