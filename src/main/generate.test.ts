import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import { createGenerator, readImageDimensions, type SdServerLike } from './generate'
import { HistoryStore } from './history'
import type { AppSettings, GenerationProgress, SdImgGenBody, ServerStatus } from '../shared/types'

// ---------------------------------------------------------------------------
// Minimal valid image headers built in-test

/** PNG signature + IHDR with big-endian dimensions. */
function pngBytes(width: number, height: number): Buffer {
  const b = Buffer.alloc(24)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0)
  b.writeUInt32BE(13, 8) // IHDR length
  b.write('IHDR', 12, 'latin1')
  b.writeUInt32BE(width, 16)
  b.writeUInt32BE(height, 20)
  return b
}

/** JPEG: SOI + APP0 (irrelevant) + SOF0 segment with dimensions. */
function jpegBytes(width: number, height: number): Buffer {
  const app0 = Buffer.alloc(18)
  app0[0] = 0xff
  app0[1] = 0xe0 // APP0
  app0.writeUInt16BE(16, 2)
  const sof = Buffer.alloc(11)
  sof[0] = 0xff
  sof[1] = 0xc0 // SOF0
  sof.writeUInt16BE(8, 2) // segment length
  sof[4] = 8 // precision
  sof.writeUInt16BE(height, 5)
  sof.writeUInt16BE(width, 7)
  sof[9] = 1 // component count
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof])
}

function webpLossyBytes(width: number, height: number): Buffer {
  const b = Buffer.alloc(30)
  b.write('RIFF', 0, 'latin1')
  b.writeUInt32LE(30, 4)
  b.write('WEBP', 8, 'latin1')
  b.write('VP8 ', 12, 'latin1')
  b.writeUInt32LE(10, 16)
  b.writeUInt16LE(width, 26)
  b.writeUInt16LE(height, 28)
  return b
}

// ---------------------------------------------------------------------------
// Fakes

class FakeServer extends EventEmitter implements SdServerLike {
  statusValue: ServerStatus = { state: 'stopped', profileId: null, port: null }
  startedWith: { profile: unknown; serverPath: string; port: number }[] = []
  startedCount = 0
  imgGenBodies: SdImgGenBody[] = []
  /** The image returned as-is (PNG), or a callback controlling the call. */
  imgGenImpl: (
    body: SdImgGenBody,
    opts: { signal?: AbortSignal },
  ) => Promise<{ format: string; images: Buffer[] }> = async (body) => ({
    format: 'png',
    images: [pngBytes(64, 48)],
  })
  upscaleResult = { image: pngBytes(128, 96), format: 'png', width: 128, height: 96, upscaler: 'realesrgan' }

  status(): ServerStatus {
    return this.statusValue
  }
  async start(profile: any, serverPath: string, port: number): Promise<ServerStatus> {
    this.startedCount++
    this.startedWith.push({ profile, serverPath, port })
    this.statusValue = { state: 'ready', profileId: (profile as { id: string }).id, port }
    return this.statusValue
  }
  imgGen(
    body: SdImgGenBody,
    opts: { signal?: AbortSignal; onQueued?: (pos: number) => void },
  ): Promise<{ format: string; images: Buffer[] }> {
    this.imgGenBodies.push(body)
    return this.imgGenImpl(body, opts)
  }
  progressEmit(p: { step: number; total: number; speed?: string }): void {
    this.emit('progress', p)
  }
  async upscale(): Promise<{ image: Buffer; format: string; width: number; height: number; upscaler: string }> {
    return this.upscaleResult
  }
}

const okResponse = (payload: unknown): Response =>
  new Response(JSON.stringify(payload), { status: 200 })

function settingsWith(outputDir: string): AppSettings {
  return {
    uiMode: 'studio',
    studioDetail: 'advanced',
    theme: 'dark',
    outputDir,
    openrouter: { hasApiKey: true, defaultModel: 'google/gemini-2.5-flash-image' },
    local: {
      engineVariant: 'linux-cpu',
      customServerPath: '',
      activeProfileId: 'p1',
      listenPort: 7860,
      profiles: [{ id: 'p1', name: 'SD 1.5 CPU', args: {}, extraArgs: '' }],
    },
  }
}

// ---------------------------------------------------------------------------
// Tests

describe('generate (openrouter)', () => {
  let dir: string
  let history: HistoryStore
  let progress: GenerationProgress[]

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'gen-test-'))
    history = new HistoryStore(dir)
    progress = []
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
    vi.unstubAllGlobals()
  })

  it('success path saves files + history item with cost, strips data URLs from params', async () => {
    const png = pngBytes(64, 48)
    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      if (String(url).endsWith('/images') && init?.method === 'POST') {
        return okResponse({
          data: [{ b64_json: png.toString('base64'), media_type: 'image/png' }],
          usage: { cost: 0.0123 },
        })
      }
      throw new Error(`unexpected fetch: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    const { createGenerator } = await import('./generate')
    const refImg = `data:image/png;base64,${png.toString('base64')}`
    const g = createGenerator({
      getSettings: () => settingsWith(dir),
      getApiKey: () => 'sk-test',
      server: new FakeServer(),
      resolveServerPath: async () => null,
      history,
      emitProgress: (p) => progress.push(p),
    })
    const result = await g.run('job1', {
      provider: 'openrouter',
      prompt: 'a cat in space',
      inputs: { refImages: [refImg] },
      openrouter: { model: 'google/gemini-2.5-flash-image', params: { n: 1, quality: 'high' } },
      threadId: undefined,
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.item.costUsd).toBe(0.0123)
    expect(result.item.model).toBe('google/gemini-2.5-flash-image')
    expect(result.item.width).toBe(64)
    expect(result.item.height).toBe(48)
    expect(result.item.files).toHaveLength(1)
    await expect(readFile(result.item.files[0])).resolves.toEqual(png)
    // input image saved to inputs/ and referenced by path in params
    const params = result.item.params as { model: string; params: { n: number; quality: string } }
    expect(params.model).toBe('google/gemini-2.5-flash-image')
    expect(params.params.quality).toBe('high')
    // no raw data URLs left in params
    expect(JSON.stringify(result.item.params)).not.toContain('data:image')
    await expect(readFile(result.item.inputFiles[0])).resolves.toEqual(png)
    // sidecar written next to output
    await expect(readFile(`${result.item.files[0]}.json`, 'utf8')).resolves.toContain('costUsd')
    // stages forwarded
    expect(progress.map((p) => p.stage)).toEqual(['uploading', 'waiting', 'done'])
  })

  it('errors without an API key', async () => {
    const { createGenerator } = await import('./generate')
    const g = createGenerator({
      getSettings: () => settingsWith(dir),
      getApiKey: () => null,
      server: new FakeServer(),
      resolveServerPath: async () => null,
      history,
      emitProgress: () => undefined,
    })
    const result = await g.run('j', {
      provider: 'openrouter',
      prompt: 'x',
      inputs: { refImages: [] },
      openrouter: { model: 'm', params: {} },
    })
    expect(result).toEqual({
      ok: false,
      jobId: 'j',
      error: 'OpenRouter API key not set — add it in Settings',
    })
  })
})

describe('generate (local)', () => {
  let dir: string
  let history: HistoryStore
  let progress: GenerationProgress[]

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'gen-test-'))
    history = new HistoryStore(dir)
    progress = []
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
    vi.unstubAllGlobals()
  })

  function makeDeps(server: FakeServer) {
    return {
      getSettings: () => settingsWith(dir),
      getApiKey: () => 'sk-test',
      server,
      resolveServerPath: async () => '/fake/sd-server',
      history,
      emitProgress: (p: GenerationProgress) => progress.push(p),
    }
  }

  it('starts server when not ready, forwards progress, records seed', async () => {
    const { createGenerator } = await import('./generate')
    const server = new FakeServer()
    server.imgGenImpl = async (body, { signal }) => {
      server.progressEmit({ step: 1, total: 20, speed: '1.5s/it' })
      server.progressEmit({ step: 2, total: 20 })
      return { format: 'png', images: [pngBytes(32, 32)] }
    }
    const g = createGenerator(makeDeps(server))
    const result = await g.run('jobL', {
      provider: 'local',
      prompt: 'p',
      negativePrompt: 'n',
      inputs: { refImages: [] },
      local: { width: 512, height: 512 },
    })

    expect(result.ok ? '' : result.error).toBe('')
    if (!result.ok) return
    expect(server.startedWith).toEqual([
      {
        profile: { id: 'p1', name: 'SD 1.5 CPU', args: {}, extraArgs: '' },
        serverPath: '/fake/sd-server',
        port: 7860,
      },
    ])
    expect(server.imgGenBodies[0]!.output_format).toBe('png')
    expect(server.imgGenBodies[0]!.seed).toBeGreaterThanOrEqual(0)
    expect(server.imgGenBodies[0]!.seed).toBeLessThan(2 ** 31)
    const stages = progress.filter((p) => p.jobId === 'jobL').map((p) => p.stage)
    expect(stages).toContain('loading')
    expect(stages).toContain('waiting')
    const sampling = progress.filter((p) => p.stage === 'sampling')
    expect(sampling.map((p) => p.step)).toEqual([1, 2])
    expect(sampling[0]!.totalSteps).toBe(20)
    expect(sampling[0]!.speed).toBe('1.5s/it')
    const item = result.item
    expect(item.model).toBe('SD 1.5 CPU')
    expect(item.seed).toBe(server.imgGenBodies[0]!.seed)
    await expect(readFile(item.files[0])).resolves.toEqual(pngBytes(32, 32))
  })

  it('does not restart server when already ready with the right profile', async () => {
    const { createGenerator } = await import('./generate')
    const server = new FakeServer()
    server.statusValue = { state: 'ready', profileId: 'p1', port: 7860 }
    const g = createGenerator(makeDeps(server))
    await g.run('jobR', { provider: 'local', prompt: 'p', inputs: { refImages: [] } })
    expect(server.startedCount).toBe(0)
  })

  it('cancel produces a cancelled result', async () => {
    const { createGenerator } = await import('./generate')
    const server = new FakeServer()
    server.imgGenImpl = (_body, { signal }) =>
      new Promise((_resolve, reject) => {
        const abort = (): void => {
          const err = new Error('aborted')
          err.name = 'AbortError'
          reject(err)
        }
        if (signal!.aborted) abort()
        else signal!.addEventListener('abort', abort)
      })
    const g = createGenerator(makeDeps(server))
    const resultP = g.run('jobC', { provider: 'local', prompt: 'p', inputs: { refImages: [] } })
    g.cancel('jobC')
    const result = await resultP
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.cancelled).toBe(true)
    expect(result.error).toBe('Cancelled')
  })

  it('fails with a clear error when no profile is active', async () => {
    const { createGenerator } = await import('./generate')
    const g = createGenerator({
      ...makeDeps(new FakeServer()),
      getSettings: () => ({ ...settingsWith(dir), local: { ...settingsWith(dir).local, activeProfileId: null } }),
    })
    const result = await g.run('jobN', { provider: 'local', prompt: 'p', inputs: { refImages: [] } })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('profile')
  })
})

describe('readImageDimensions', () => {
  it('parses built-in test formats', () => {
    expect(readImageDimensions(pngBytes(1024, 768))).toEqual({ width: 1024, height: 768 })
    expect(readImageDimensions(jpegBytes(640, 480))).toEqual({ width: 640, height: 480 })
    expect(readImageDimensions(webpLossyBytes(320, 240))).toEqual({ width: 320, height: 240 })
    const l = Buffer.alloc(30)
    l.write('RIFF', 0, 'latin1')
    l.write('WEBP', 8, 'latin1')
    l.write('VP8L', 12, 'latin1')
    l[20] = 0x2f // signature
    l.writeUInt32LE((319 & 0x3fff) | ((239 & 0x3fff) << 14), 21)
    expect(readImageDimensions(l)).toEqual({ width: 320, height: 240 })
    const x = Buffer.alloc(30)
    x.write('RIFF', 0, 'latin1')
    x.write('WEBP', 8, 'latin1')
    x.write('VP8X', 12, 'latin1')
    x.writeUIntLE(319, 24, 3)
    x.writeUIntLE(239, 27, 3)
    expect(readImageDimensions(x)).toEqual({ width: 320, height: 240 })
    expect(readImageDimensions(Buffer.from('not an image'))).toBeNull()
  })
})

// sidecar/history item construction path is exercised in the openrouter/local tests above.
