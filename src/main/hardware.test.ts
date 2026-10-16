import { describe, expect, it } from 'vitest'
import process from 'node:process'
import { chooseBackend, diffusersSupportedOn, parseNvidiaSmi, probeHardware, probeNvidiaGpus } from './hardware'
import type { HardwareInfo } from '@shared/types'

const SMI_OUT = [
  'NVIDIA GeForce RTX 4090, 24564, 560.35.03',
  'NVIDIA GeForce RTX 3060, 12288, 560.35.03'
].join('\n')

const hw = (over: Partial<HardwareInfo> = {}): HardwareInfo => ({
  platform: 'linux',
  arch: 'x64',
  ramMiB: 32768,
  gpus: [],
  ...over
})

describe('parseNvidiaSmi', () => {
  it('parses multiple GPUs with name, memory and driver', () => {
    expect(parseNvidiaSmi(SMI_OUT)).toEqual([
      { vendor: 'nvidia', name: 'NVIDIA GeForce RTX 4090', vramMiB: 24564, driver: '560.35.03' },
      { vendor: 'nvidia', name: 'NVIDIA GeForce RTX 3060', vramMiB: 12288, driver: '560.35.03' }
    ])
  })
  it('skips junk lines and blank lines', () => {
    expect(
      parseNvidiaSmi(`\nNo devices were found\nsome garbage\n\n${SMI_OUT}\n`)
    ).toEqual(parseNvidiaSmi(SMI_OUT))
  })
  it('maps [N/A] memory to null vram and keeps the GPU', () => {
    expect(parseNvidiaSmi('NVIDIA GRID K520, [N/A], 520.55')).toEqual([
      { vendor: 'nvidia', name: 'NVIDIA GRID K520', vramMiB: null, driver: '520.55' }
    ])
  })
  it('tolerates missing driver and CRLF endings', () => {
    expect(parseNvidiaSmi('Quadro P5000, 16384, 535.10\r\n')).toEqual([
      { vendor: 'nvidia', name: 'Quadro P5000', vramMiB: 16384, driver: '535.10' }
    ])
    expect(parseNvidiaSmi('Quadro P6000, 16384')).toEqual([
      { vendor: 'nvidia', name: 'Quadro P6000', vramMiB: 16384 }
    ])
  })
  it('returns [] for empty input', () => {
    expect(parseNvidiaSmi('')).toEqual([])
  })
})

describe('diffusersSupportedOn', () => {
  it('is true for linux/win32 x64 only', () => {
    expect(diffusersSupportedOn('linux', 'x64')).toBe(true)
    expect(diffusersSupportedOn('win32', 'x64')).toBe(true)
    expect(diffusersSupportedOn('linux', 'arm64')).toBe(false)
    expect(diffusersSupportedOn('darwin', 'x64')).toBe(false)
    expect(diffusersSupportedOn('darwin', 'arm64')).toBe(false)
  })
})

describe('chooseBackend', () => {
  const policy =
    'NVIDIA GeForce RTX 4090, 24564, 560.35.03'
  it('picks diffusers for a big enough NVIDIA GPU on linux x64', () => {
    const info = chooseBackend(hw({ gpus: parseNvidiaSmi(policy) }), 'auto')
    expect(info.diffusersSupported).toBe(true)
    expect(info.autoChoice).toBe('diffusers')
    expect(info.effective).toBe('diffusers')
    expect(info.reason).toBe('NVIDIA GeForce RTX 4090 (24 GB) detected — using diffusers')
  })
  it('picks sdcpp when nothing was detected', () => {
    const info = chooseBackend(hw(), 'auto')
    expect(info.autoChoice).toBe('sdcpp')
    expect(info.reason).toBe('No NVIDIA GPU detected — using stable-diffusion.cpp')
  })
  it('picks sdcpp when the GPU has under 6 GB VRAM', () => {
    const info = chooseBackend(hw({ gpus: [{ vendor: 'nvidia', name: 'NVIDIA GeForce RTX 3050', vramMiB: 4096 }] }), 'auto')
    expect(info.autoChoice).toBe('sdcpp')
    expect(info.reason).toBe('NVIDIA GPU has under 6 GB VRAM — using stable-diffusion.cpp')
  })
  it('picks sdcpp when VRAM is unknown', () => {
    const info = chooseBackend(hw({ gpus: [{ vendor: 'nvidia', name: 'NVIDIA GRID K520', vramMiB: null }] }), 'auto')
    expect(info.autoChoice).toBe('sdcpp')
    expect(info.reason).toBe('NVIDIA GPU has under 6 GB VRAM — using stable-diffusion.cpp')
  })
  it('picks sdcpp when diffusers is unsupported (mac), even with a GPU record', () => {
    const info = chooseBackend(hw({ platform: 'darwin', arch: 'arm64', gpus: [{ vendor: 'apple', name: 'Apple Silicon', vramMiB: null }] }), 'auto')
    expect(info.diffusersSupported).toBe(false)
    expect(info.autoChoice).toBe('sdcpp')
  })
  it('hosts the override preference through to effective', () => {
    expect(chooseBackend(hw(), 'sdcpp').effective).toBe('sdcpp')
    expect(chooseBackend(hw(), 'diffusers').effective).toBe('diffusers')
  })
})

describe('probeHardware with injected run', () => {
  it('runs nvidia-smi on linux and parses the result, then caches', async () => {
    let calls = 0
    const run = async () => {
      calls++
      return { code: 0, stdout: SMI_OUT }
    }
    if (process.platform === 'linux' || process.platform === 'win32') {
      const info = await probeHardware({ run, refresh: true })
      expect(info.platform).toBe(process.platform)
      expect(info.arch).toBe(process.arch)
      expect(info.ramMiB).toBeGreaterThan(0)
      expect(info.gpus[0]?.vendor).toBe('nvidia')
      // Once per probe: the win32 fallback only runs after failure.
      expect(calls).toBe(1)
      // Cached result is returned identically.
      expect(await probeHardware({ run })).toBe(info)
      expect(calls).toBe(1)
      // refresh forces a re-probe
      expect(await probeHardware({ run, refresh: true })).not.toBe(info)
      expect(calls).toBe(2)
    }
  })
  it('falls back to the Windows system nvidia-smi path', async () => {
    const cmds: string[] = []
    const run = async (cmd: string) => {
      cmds.push(cmd)
      return cmd.includes('System32') ? { code: 0, stdout: 'NVIDIA GeForce RTX 3080, 10240, 560.76' } : { code: 1, stdout: '' }
    }
    const gpus = await probeNvidiaGpus('win32', run)
    expect(cmds[0]).toBe('nvidia-smi')
    expect(gpus).toEqual([{ vendor: 'nvidia', name: 'NVIDIA GeForce RTX 3080', vramMiB: 10240, driver: '560.76' }])
  })
  it('probes nothing on darwin', async () => {
    const run = async () => {
      throw new Error('must not be called')
    }
    expect(await probeNvidiaGpus('darwin', run)).toEqual([])
  })
  it('never throws when the probe command fails or times out', async () => {
    const failing = async () => {
      throw new Error('boom')
    }
    const hw1 = await probeHardware({ run: failing, refresh: true })
    expect(hw1.platform).toBe(process.platform)
    const timedOut = async () => ({ code: null, stdout: '' })
    expect((await probeHardware({ run: timedOut, refresh: true })).gpus).toEqual([])
  })
})
