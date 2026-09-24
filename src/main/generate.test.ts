import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import {
  createGenerator,
  extFromMediaType,
  readImageDimensions,
  sniffImageFormat,
  type SdServerLike,
} from './generate'
import { generateImages } from './openrouter'
import { HistoryStore } from './history'
import type {
  AppSettings,
  GenerationProgress,
  HistoryItem,
  SdImgGenBody,
  ServerStatus,
} from '../shared/types'

const item = (id: string, overrides: Partial<HistoryItem> = {}): HistoryItem => ({
  id,
  createdAt: Date.parse('2026-01-01T00:00:00Z'),
  provider: 'openrouter',
  model: 'google/gemini-2.5-flash-image',
  prompt: 'a cat',
  params: {},
  files: [],
  inputFiles: [],
  durationMs: 100,
  kind: 'generate',
  ...overrides,
})

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
  startedWith: { profile: unknown; serverPath: string; port: number; signal?: AbortSignal }[] = []
  startedCount = 0
  imgGenBodies: SdImgGenBody[] = []
  upscaleCalls: { body: { image: string }; signal?: AbortSignal }[] = []
  /** The image returned as-is (PNG), or a callback controlling the call. */
  imgGenImpl: (
    body: SdImgGenBody,
    opts: {
      signal?: AbortSignal
      onQueued?: (pos: number) => void
      onState?: (state: 'queued' | 'generating') => void
    },
  ) => Promise<{ format: string; images: Buffer[] }> = async (body) => ({
    format: 'png',
    images: [pngBytes(64, 48)],
  })
  upscaleImpl: (
    body: { image: string; upscaler?: string; repeats?: number; tile_size?: number },
    opts: { signal?: AbortSignal } | undefined,
  ) => Promise<{ image: Buffer; format: string; width: number; height: number; upscaler: string }> = async () =>
    this.upscaleResult
  upscaleResult = { image: pngBytes(128, 96), format: 'png', width: 128, height: 96, upscaler: 'realesrgan' }

  status(): ServerStatus {
    return this.statusValue
  }
  async start(
    profile: any,
    serverPath: string,
    port: number,
    opts?: { signal?: AbortSignal },
  ): Promise<ServerStatus> {
    this.startedCount++
    this.startedWith.push({ profile, serverPath, port, signal: opts?.signal })
    this.statusValue = { state: 'ready', profileId: (profile as { id: string }).id, port }
    return this.statusValue
  }
  imgGen(
    body: SdImgGenBody,
    opts: {
      signal?: AbortSignal
      onQueued?: (pos: number) => void
      onState?: (state: 'queued' | 'generating') => void
    },
  ): Promise<{ format: string; images: Buffer[] }> {
    this.imgGenBodies.push(body)
    return this.imgGenImpl(body, opts)
  }
  progressEmit(p: { step: number; total: number; speed?: string }): void {
    this.emit('progress', p)
  }
  stageEmit(stage: 'decoding' | 'hires' | 'sampling'): void {
    this.emit('stage', stage)
  }
  async upscale(
    body: { image: string; upscaler?: string; repeats?: number; tile_size?: number },
    opts?: { signal?: AbortSignal },
  ): Promise<{ image: Buffer; format: string; width: number; height: number; upscaler: string }> {
    this.upscaleCalls.push({ body, signal: opts?.signal })
    return this.upscaleImpl(body, opts)
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
    server.imgGenImpl = async (body, { signal, onState }) => {
      onState?.('generating')
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
        signal: expect.any(AbortSignal),
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

  it('emits a queued-position event from onQueued', async () => {
    const { createGenerator } = await import('./generate')
    const server = new FakeServer()
    server.statusValue = { state: 'ready', profileId: 'p1', port: 7860 }
    server.imgGenImpl = async (_body, { onQueued, onState }) => {
      onQueued?.(3)
      onState?.('generating')
      return { format: 'png', images: [pngBytes(8, 8)] }
    }
    const g = createGenerator(makeDeps(server))
    const result = await g.run('jobQ', { provider: 'local', prompt: 'p', inputs: { refImages: [] } })
    expect(result.ok).toBe(true)
    const queued = progress.filter((p) => p.jobId === 'jobQ' && p.stage === 'queued')
    expect(queued).toHaveLength(1)
    expect(queued[0]!.message).toBe('Waiting in sd-server queue (position 3)')
  })

  it('passing signal into server.start (ensureServerRunning)', async () => {
    const { createGenerator } = await import('./generate')
    const server = new FakeServer()
    server.start = async (profile, serverPath, port, opts) => {
      void server.startedCount++
      server.startedWith.push({ profile, serverPath, port, signal: opts?.signal })
      server.statusValue = { state: 'ready', profileId: (profile as { id: string }).id, port }
      return server.statusValue
    }
    const g = createGenerator(makeDeps(server))
    await g.run('jobS', { provider: 'local', prompt: 'p', inputs: { refImages: [] } })
    expect(server.startedWith[0]!.signal).toBeInstanceOf(AbortSignal)
  })

  it('reports a non-interruptible cancellation when the server could not abort', async () => {
    const { createGenerator } = await import('./generate')
    const server = new FakeServer()
    server.imgGenImpl = (_body, { signal }) =>
      new Promise((_resolve, reject) => {
        const abort = (): void => {
          const err = new Error('cancel requested but not interrupted')
          err.name = 'AbortError'
          ;(err as { interrupted?: boolean }).interrupted = false
          reject(err)
        }
        if (signal!.aborted) abort()
        else signal!.addEventListener('abort', abort)
      })
    const g = createGenerator(makeDeps(server))
    const resultP = g.run('jobI', { provider: 'local', prompt: 'p', inputs: { refImages: [] } })
    g.cancel('jobI')
    const result = await resultP
    expect(result).toEqual({
      ok: false,
      jobId: 'jobI',
      cancelled: true,
      error:
        'Cancelled — sd-server cannot interrupt a running generation, so it finishes in the background and the result is discarded.',
    })
  })

  it('attributes process-wide progress/stage events to the currently generating job', async () => {
    const { createGenerator } = await import('./generate')
    const server = new FakeServer()
    server.statusValue = { state: 'ready', profileId: 'p1', port: 7860 }
    const releases: Array<(r: { format: string; images: Buffer[] }) => void> = []
    const calls: { opts: Parameters<SdServerLike['imgGen']>[1] }[] = []
    server.imgGenImpl = (_body, opts) =>
      new Promise((resolve) => {
        calls.push({ opts })
        releases.push(resolve)
      })
    const g = createGenerator(makeDeps(server))
    const req = { provider: 'local' as const, prompt: 'p', inputs: { refImages: [] } }
    const pA = g.run('jobA', req)
    await new Promise((r) => setTimeout(r, 5))
    const pB = g.run('jobB', req)
    await new Promise((r) => setTimeout(r, 5))
    expect(server.imgGenBodies).toHaveLength(2)

    // B starts generating first; its events are attributed to B.
    calls[1]!.opts.onState?.('generating')
    server.progressEmit({ step: 1, total: 10 })
    server.stageEmit('hires')
    server.progressEmit({ step: 2, total: 10 })
    // A starts generating; B's events no longer reach A (phase label never leaked).
    calls[0]!.opts.onState?.('generating')
    server.stageEmit('decoding')
    server.stageEmit('hires')
    server.progressEmit({ step: 3, total: 10 })
    const png = pngBytes(8, 8)
    releases[1]({ format: 'png', images: [png] })
    releases[0]({ format: 'png', images: [png] })
    const [ra, rb] = await Promise.all([pA, pB])
    expect(ra.ok).toBe(true)
    expect(rb.ok).toBe(true)

    const a = progress.filter((p) => p.jobId === 'jobA')
    const b = progress.filter((p) => p.jobId === 'jobB')
    // jobB saw steps 1 and 2, with a stage-emitted sampling in between
    expect(b.filter((p) => p.stage === 'sampling').map((p) => [p.step, p.message])).toEqual([
      [1, undefined],
      [undefined, 'hires pass'],
      [2, 'hires pass'],
    ])
    // jobA saw only its own events: decoding, then a fresh hires pass (label reset per job)
    expect(a.filter((p) => p.stage === 'decoding')).toHaveLength(1)
    expect(a.filter((p) => p.stage === 'sampling').map((p) => [p.step, p.message])).toEqual([
      [undefined, 'hires pass'],
      [3, 'hires pass'],
    ])
  })

  it('rejects a duplicate job id without touching the running job', async () => {
    const { createGenerator } = await import('./generate')
    const server = new FakeServer()
    server.statusValue = { state: 'ready', profileId: 'p1', port: 7860 }
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
    const req = { provider: 'local' as const, prompt: 'p', inputs: { refImages: [] } }
    const first = g.run('jobD', req)
    await new Promise((r) => setTimeout(r, 5))
    await expect(g.run('jobD', req)).resolves.toEqual({
      ok: false,
      jobId: 'jobD',
      error: 'Duplicate job id',
    })
    // an upscale with the same id is likewise rejected
    await expect(g.upscale('jobD', { historyId: 'x', fileIndex: 0 })).resolves.toEqual({
      ok: false,
      jobId: 'jobD',
      error: 'Duplicate job id',
    })
    expect(server.imgGenBodies).toHaveLength(1)
    g.cancel('jobD')
    expect(await first).toMatchObject({ ok: false, cancelled: true })

    // the id is free again and actually runs this time
    const second = g.run('jobD', req)
    await new Promise((r) => setTimeout(r, 5))
    expect(server.imgGenBodies).toHaveLength(2)
    g.cancel('jobD')
    expect(await second).toMatchObject({ ok: false, cancelled: true })
  })

  it('upscale passes an abort signal to the server and cancels', async () => {
    const { createGenerator } = await import('./generate')
    const server = new FakeServer()
    server.statusValue = { state: 'ready', profileId: 'p1', port: 7860 }
    server.upscaleImpl = (_body, opts) =>
      new Promise((_resolve, reject) => {
        const abort = (): void => {
          const err = new Error('aborted')
          err.name = 'AbortError'
          reject(err)
        }
        const signal = opts?.signal
        if (signal?.aborted) abort()
        else signal?.addEventListener('abort', abort)
      })
    await history.add(item('u1', { files: [join(dir, 'src.png')] }))
    await writeFile(join(dir, 'src.png'), pngBytes(4, 4))
    const g = createGenerator(makeDeps(server))
    const resultP = g.upscale('jobU', { historyId: 'u1', fileIndex: 0 })
    await new Promise((r) => setTimeout(r, 5))
    g.cancel('jobU')
    const result = await resultP
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.cancelled).toBe(true)
      expect(result.error).toBe('Cancelled')
    }
    expect(server.upscaleCalls[0]!.signal).toBeInstanceOf(AbortSignal)
  })

  it('upscales a history file and records an upscale item', async () => {
    const { createGenerator } = await import('./generate')
    const server = new FakeServer()
    server.statusValue = { state: 'ready', profileId: 'p1', port: 7860 }
    await history.add(
      item('u2', {
        files: [join(dir, 'src2.png')],
        prompt: 'source prompt',
        model: 'local model',
        threadId: 'th1',
      }),
    )
    await writeFile(join(dir, 'src2.png'), pngBytes(4, 4))
    const g = createGenerator(makeDeps(server))
    const result = await g.upscale('jobU2', { historyId: 'u2', fileIndex: 0 })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.item.kind).toBe('upscale')
    expect(result.item.parentId).toBe('u2')
    expect(result.item.width).toBe(128)
    await expect(readFile(result.item.files[0])).resolves.toEqual(pngBytes(128, 96))
    expect(server.upscaleCalls[0]!.body.image).toMatch(/^data:image\/png;base64,/)
    expect(server.upscaleCalls[0]!.signal).toBeInstanceOf(AbortSignal)
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

// ---------------------------------------------------------------------------
// extFromMediaType / sniffImageFormat

describe('extFromMediaType', () => {
  it('maps known media types to extensions', () => {
    expect(extFromMediaType('image/png')).toBe('png')
    expect(extFromMediaType('image/jpeg')).toBe('jpg')
    expect(extFromMediaType('image/webp')).toBe('webp')
    expect(extFromMediaType('image/gif')).toBe('gif')
    expect(extFromMediaType('image/svg+xml')).toBe('svg')
  })

  it('falls back to magic-byte sniffing for unknown types', () => {
    expect(extFromMediaType('application/octet-stream', pngBytes(1, 1))).toBe('png')
    expect(extFromMediaType('image/x-unknown', Buffer.from([0xff, 0xd8, 0x00]))).toBe('jpg')
    expect(extFromMediaType('image/x-unknown', webpLossyBytes(2, 2))).toBe('webp')
    expect(extFromMediaType('image/x-unknown', Buffer.from('GIF89a-data'))).toBe('gif')
    expect(extFromMediaType('image/x-unknown', Buffer.from('<?xml version="1.0"?><svg xmlns="…"/>'))).toBe('svg')
    expect(extFromMediaType('image/x-unknown', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBe('svg')
    expect(extFromMediaType('image/x-unknown', Buffer.from('total garbage'))).toBe('bin')
    expect(extFromMediaType('image/x-unknown')).toBe('bin')
  })

  it('sniffImageFormat detects svg and png', () => {
    expect(sniffImageFormat(Buffer.from('  \n<svg viewBox="0 0 1 1">'))).toBe('svg')
    expect(sniffImageFormat(pngBytes(1, 1))).toBe('png')
  })

  it('readImageDimensions returns null for SVG', () => {
    expect(readImageDimensions(Buffer.from('<?xml version="1.0"?><svg/>'))).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// OpenRouter: HTTP 200 bodies that carry an error or no images

describe('generateImages: 200-with-error and empty 200', () => {
  afterEach(() => vi.unstubAllGlobals())

  const args = { apiKey: 'sk-test', model: 'm', prompt: 'p', params: {}, refImages: [] }

  it('throws the in-body error message on a 200 response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => okResponse({ error: { message: 'model is overloaded', code: 1337 } })),
    )
    await expect(generateImages(args)).rejects.toThrow('model is overloaded')
  })

  it('throws when a 200 response contains no images and a text reason', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => okResponse({ data: [], text: 'content policy violation' })),
    )
    await expect(generateImages(args)).rejects.toThrow(
      'OpenRouter returned no images: content policy violation',
    )
  })

  it('throws when a 200 response contains no images at all', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => okResponse({ data: [] })))
    await expect(generateImages(args)).rejects.toThrow('OpenRouter returned no images')
  })
})
