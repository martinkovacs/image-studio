import { describe, expect, it } from 'vitest'
import path from 'node:path'
import type { LocalModelProfile } from '@shared/types'
import { buildFlagArgs, buildServerArgs, diffusersLaunch, sdcppLaunch } from './launch'

const base: LocalModelProfile = { id: 'p1', name: 'P', args: {}, extraArgs: '' }

describe('buildFlagArgs', () => {
  const known = new Map([
    ['model', 1],
    ['fa', 1],
    ['threads', 1]
  ])

  it('emits switch flags for true booleans only', () => {
    expect(buildFlagArgs({ fa: true, threads: false }, known)).toEqual(['--fa'])
  })

  it('passes known values verbatim and stringifies numbers', () => {
    expect(buildFlagArgs({ model: '/m/a.gguf', threads: 8 }, known)).toEqual([
      '--model', '/m/a.gguf',
      '--threads', '8'
    ])
  })

  it('omits empty-string values and skips unknown ids', () => {
    expect(buildFlagArgs({ model: '', nope: 'x', fa: false }, known)).toEqual([])
  })

  it('omits undefined values (older settings payloads)', () => {
    const args = { model: '/m/a.gguf', threads: undefined } as unknown as LocalModelProfile['args']
    expect(buildFlagArgs(args, known)).toEqual(['--model', '/m/a.gguf'])
  })
})

describe('sdcppLaunch', () => {
  const profile: LocalModelProfile = {
    ...base,
    args: { 'diffusion-model': '/m/flux.safetensors', fa: true },
    extraArgs: '--rng cpu'
  }

  it('runs the binary from its own directory with the loader paths prepended', () => {
    const spec = sdcppLaunch('/opt/sd/sd-server', profile)
    expect(spec.backend).toBe('sdcpp')
    expect(spec.command).toBe('/opt/sd/sd-server')
    expect(spec.cwd).toBe('/opt/sd')
    expect(spec.label).toBe('sd-server')
    expect(spec.requiredFiles).toEqual(['/opt/sd/sd-server'])
    // Shared libs live next to the binary; binDir must come first.
    expect(spec.env?.LD_LIBRARY_PATH?.split(':')[0]).toBe('/opt/sd')
    expect(spec.env?.PATH?.split(path.delimiter)[0]).toBe('/opt/sd')
  })

  it('argsFor ends with the forced listen flags after profile + extra args', () => {
    const args = sdcppLaunch('/opt/sd/sd-server', profile).argsFor(8123)
    expect(args.slice(0, 5)).toEqual([
      '--diffusion-model', '/m/flux.safetensors',
      '--fa',
      '--rng', 'cpu'
    ])
    expect(args.slice(-4)).toEqual(['--listen-ip', '127.0.0.1', '--listen-port', '8123'])
  })

  it('buildServerArgs keeps its original shape (moved from server.ts)', () => {
    const args = buildServerArgs({ ...base, args: { mmap: false, type: 'f16' }, extraArgs: '--fa' }, 8000)
    expect(args).toEqual(['--type', 'f16', '--fa', '--listen-ip', '127.0.0.1', '--listen-port', '8000'])
  })
})

describe('diffusersLaunch', () => {
  const profile: LocalModelProfile = {
    id: 'p2',
    name: 'Qwen',
    args: { pipeline: 'QwenImagePipeline', model: '/hf/qwen', 'vae-tiling': true, threads: 8 },
    extraArgs: '--device-map balanced'
  }
  const opts = {
    pythonPath: '/venv/bin/python',
    scriptPath: '/app/resources/diffusers/server.py',
    profile,
    hfHome: '/data/hf'
  }

  it('builds python argv: script first, listen flags last, unknown ids dropped, bools as switches', () => {
    const spec = diffusersLaunch(opts)
    expect(spec.backend).toBe('diffusers')
    expect(spec.command).toBe('/venv/bin/python')
    expect(spec.cwd).toBe('/app/resources/diffusers')
    expect(spec.label).toBe('diffusers server')
    expect(spec.requiredFiles).toEqual(['/venv/bin/python', '/app/resources/diffusers/server.py'])
    // `threads` is an sd.cpp-only id and must not leak into the python argv.
    expect(spec.argsFor(9000)).toEqual([
      '/app/resources/diffusers/server.py',
      '--pipeline', 'QwenImagePipeline',
      '--model', '/hf/qwen',
      '--vae-tiling',
      '--device-map', 'balanced',
      '--listen-ip', '127.0.0.1', '--listen-port', '9000'
    ])
  })

  it('sets the python / hugging-face environment', () => {
    expect(diffusersLaunch(opts).env).toEqual({
      PYTHONUNBUFFERED: '1',
      HF_HUB_OFFLINE: '1',
      HF_HOME: '/data/hf',
      PYTHONNOUSERSITE: '1',
      PYTORCH_CUDA_ALLOC_CONF: 'expandable_segments:True'
    })
  })

  it('empty args and extraArgs reduce to script + listen flags', () => {
    const spec = diffusersLaunch({ ...opts, profile: { ...base, args: { nope: 'x' } } })
    expect(spec.argsFor(1)).toEqual([opts.scriptPath, '--listen-ip', '127.0.0.1', '--listen-port', '1'])
  })
})
