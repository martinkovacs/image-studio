import { describe, expect, it } from 'vitest'
import {
  ENGINE_VARIANTS,
  buildEngineVariants,
  defaultVariantId,
  findServerDir,
  matchAssetName,
  variantsForPlatform
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
