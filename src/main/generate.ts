// Generation orchestration: OpenRouter cloud provider + local sd-server provider,
// output persistence and history recording. SdServerLike is a minimal local
// interface — the real SdServer (implemented elsewhere) satisfies it structurally.
import { mkdir, readFile, writeFile, stat } from 'node:fs/promises'
import { createHash, randomBytes, randomInt } from 'node:crypto'
import { join } from 'node:path'
import type {
  AppSettings,
  GenerationProgress,
  GenerationRequest,
  GenerationResult,
  HistoryItem,
  LocalModelProfile,
  SdImgGenBody,
  ServerStatus,
  UpscaleRequest,
} from '../shared/types'
import type { HistoryStore } from './history'
import { generateImages, CancelledError, sanitizeExtraParams } from './openrouter'
import { IS_SLIM } from '../shared/edition'

/** Message used for every disabled local feature in the slim edition. */
export const LOCAL_DISABLED_MSG = 'Local generation is not available in the slim edition'
export const localDisabled = (): Error => new Error(LOCAL_DISABLED_MSG)

export interface SdServerLike {
  status(): ServerStatus
  start(
    profile: LocalModelProfile,
    serverPath: string,
    port: number,
    opts?: { signal?: AbortSignal },
  ): Promise<ServerStatus>
  imgGen(
    body: SdImgGenBody,
    opts: {
      signal?: AbortSignal
      onQueued?: (pos: number) => void
      onState?: (state: 'queued' | 'generating') => void
    },
  ): Promise<{ format: string; images: Buffer[] }>
  upscale(
    body: {
      image: string
      upscaler?: string
      repeats?: number
      tile_size?: number
      output_format?: string
    },
    opts?: { signal?: AbortSignal },
  ): Promise<{ image: Buffer; format: string; width: number; height: number; upscaler: string }>
  on(event: 'progress', cb: (p: { step: number; total: number; speed?: string }) => void): void
  on(event: 'stage', cb: (stage: 'decoding' | 'hires' | 'sampling') => void): void
  off(event: 'progress', cb: (p: { step: number; total: number; speed?: string }) => void): void
  off(event: 'stage', cb: (stage: 'decoding' | 'hires' | 'sampling') => void): void
}

export interface GeneratorDeps {
  getSettings: () => AppSettings
  getApiKey: () => string | null
  server: SdServerLike
  resolveServerPath: (s: AppSettings) => Promise<string | null>
  history: HistoryStore
  emitProgress: (p: GenerationProgress) => void
}

export interface Generator {
  run(jobId: string, req: GenerationRequest): Promise<GenerationResult>
  cancel(jobId: string): void
  upscale(jobId: string, req: UpscaleRequest): Promise<GenerationResult>
}

const NO_KEY_MSG = 'OpenRouter API key not set — add it in Settings'

/** Error carrying the flag set by sd-server when it could not interrupt an already-running job. */
export const NON_INTERRUPTIBLE_CANCELLED_MSG =
  'Cancelled — sd-server cannot interrupt a running generation, so it finishes in the background and the result is discarded.'

/**
 * The id of the job sd-server is currently generating. 'progress'/'stage' events
 * are process-wide (not per job), so listeners use this to attribute them.
 */
let generatingJobId: string | null = null
const NO_ENGINE_MSG =
  'No stable-diffusion.cpp engine installed — install one in Settings → Local engine'
const NO_PROFILE_MSG = 'No active local model profile selected — pick one in Settings'

export function createGenerator(deps: GeneratorDeps): Generator {
  const activeJobs = new Map<string, AbortController>()

  const emit = (jobId: string, p: Omit<GenerationProgress, 'jobId'>): void => {
    deps.emitProgress({ ...p, jobId })
  }

  /** Resolves the active profile and ensures the server is ready with it loaded. */
  async function ensureServerRunning(
    jobId: string,
    signal?: AbortSignal,
  ): Promise<{ profile: LocalModelProfile }> {
    const settings = deps.getSettings()
    const profile = settings.local.profiles.find((p) => p.id === settings.local.activeProfileId)
    if (!profile) throw new Error(NO_PROFILE_MSG)
    const serverPath = await deps.resolveServerPath(settings)
    if (!serverPath) throw new Error(NO_ENGINE_MSG)
    const status = deps.server.status()
    if (status.state !== 'ready' || status.profileId !== profile.id) {
      emit(jobId, { stage: 'loading', message: `Starting ${profile.name}` })
      const started = await deps.server.start(profile, serverPath, settings.local.listenPort, { signal })
      if (started.state !== 'ready') {
        throw new Error(started.error ?? 'Local engine failed to start')
      }
    }
    return { profile }
  }

  /** Runs a job with its own AbortController; converts failures into results. */
  async function withJob(
    jobId: string,
    op: (ac: AbortController) => Promise<GenerationResult>,
  ): Promise<GenerationResult> {
    if (activeJobs.has(jobId)) {
      // Do not touch the running job; report the collision to the new caller only.
      return { ok: false, jobId, error: 'Duplicate job id' }
    }
    const ac = new AbortController()
    activeJobs.set(jobId, ac)
    try {
      return await op(ac)
    } catch (e) {
      const err = e as { name?: string; message?: string; interrupted?: boolean }
      if (ac.signal.aborted || e instanceof CancelledError || err?.name === 'AbortError') {
        // sd-server sets interrupted:false when a job that was already generating
        // could not be interrupted; it keeps running and the result is discarded.
        if (err?.name === 'AbortError' && err.interrupted === false) {
          return { ok: false, jobId, cancelled: true, error: NON_INTERRUPTIBLE_CANCELLED_MSG }
        }
        return { ok: false, jobId, cancelled: true, error: 'Cancelled' }
      }
      return { ok: false, jobId, error: e instanceof Error ? e.message : String(e) }
    } finally {
      // Only remove our own entry; a newer controller may have replaced it.
      if (activeJobs.get(jobId) === ac) activeJobs.delete(jobId)
    }
  }

  /** Shared tail: save outputs + inputs, build the HistoryItem, record + emit done. */
  async function finalize(jobId: string, args: FinalizeArgs): Promise<GenerationResult> {
    const files = await saveOutputs(args.settings.outputDir, args.outputs)
    // Aligned 1:1 with dataUrls; null entries failed to parse and are skipped.
    const savedInputs = await saveInputs(args.settings.outputDir, args.dataUrls)
    const inputFiles = savedInputs.filter((p): p is string => p !== null)
    const urlMap = new Map<string, string>()
    for (let i = 0; i < args.dataUrls.length; i++) {
      const saved = savedInputs[i]
      if (saved) urlMap.set(args.dataUrls[i], saved)
    }
    const dims = args.outputs[0] ? readImageDimensions(args.outputs[0].data) : null

    const item: HistoryItem = {
      id: randomBytes(8).toString('hex'),
      createdAt: Date.now(),
      provider: args.provider,
      model: args.model,
      prompt: args.prompt,
      negativePrompt: args.negativePrompt,
      params: replaceDataUrls(args.params, urlMap) as Record<string, unknown>,
      files,
      inputFiles,
      width: dims?.width,
      height: dims?.height,
      seed: args.seed,
      costUsd: args.costUsd,
      durationMs: Date.now() - args.startedAt,
      threadId: args.threadId,
      kind: 'generate',
    }
    // Sidecar metadata next to each output image.
    await Promise.all(files.map((file) => writeSidecar(file, item)))
    await deps.history.add(item)
    emit(jobId, { stage: 'done' })
    return { ok: true, jobId, item }
  }

  interface FinalizeArgs {
    provider: 'openrouter' | 'local'
    model: string
    params: unknown
    prompt: string
    negativePrompt?: string
    /** Input images sent with the request, as data URLs, in order. */
    dataUrls: string[]
    outputs: { data: Buffer; mediaType: string }[]
    costUsd?: number
    startedAt: number
    threadId?: string
    settings: AppSettings
    seed?: number
  }

  async function runOpenRouter(
    jobId: string,
    req: GenerationRequest,
    ac: AbortController,
    startedAt: number,
  ): Promise<GenerationResult> {
    if (!deps.getApiKey()) throw new Error(NO_KEY_MSG)
    const or = req.openrouter
    if (!or) throw new Error('OpenRouter request is missing a model')
    // Renderer input is never trusted: validate the custom JSON here too.
    const extra = sanitizeExtraParams(or.extra)

    emit(jobId, { stage: 'uploading' })
    if (req.threadId) await deps.history.touchThread(req.threadId).catch(() => undefined)
    emit(jobId, { stage: 'waiting' })
    const res = await generateImages({
      apiKey: deps.getApiKey() ?? '',
      model: or.model,
      prompt: req.prompt,
      params: or.params,
      extra,
      refImages: req.inputs.refImages,
      signal: ac.signal,
    })

    return finalize(jobId, {
      provider: 'openrouter',
      model: or.model,
      params: Object.keys(extra).length > 0 ? { model: or.model, params: or.params, extra } : { model: or.model, params: or.params },
      prompt: req.prompt,
      negativePrompt: req.negativePrompt,
      dataUrls: req.inputs.refImages,
      outputs: res.images,
      costUsd: res.costUsd,
      startedAt,
      threadId: req.threadId,
      settings: deps.getSettings(),
    })
  }

  async function runLocal(
    jobId: string,
    req: GenerationRequest,
    ac: AbortController,
    startedAt: number,
  ): Promise<GenerationResult> {
    // The slim edition has no local backend at all: report it as a failed job
    // instead of touching the (absent) server.
    if (IS_SLIM) return { ok: false, jobId, error: LOCAL_DISABLED_MSG }
    emit(jobId, { stage: 'loading', message: 'Ensuring local engine is ready' })
    const { profile } = await ensureServerRunning(jobId, ac.signal)

    const local = req.local ?? {}
    // Pick our own seed for -1/undefined so the exact value can be recorded.
    const seed =
      local.seed !== undefined && local.seed !== -1 ? local.seed : randomInt(0, 2 ** 31)
    const body: SdImgGenBody = {
      ...local,
      seed,
      prompt: req.prompt,
      negative_prompt: req.negativePrompt,
      ref_images: req.inputs.refImages.length > 0 ? req.inputs.refImages : undefined,
      init_image: req.inputs.initImage,
      mask_image: req.inputs.maskImage,
      output_format: local.output_format ?? 'png',
    }

    const dataUrls = [
      ...req.inputs.refImages,
      ...(req.inputs.initImage ? [req.inputs.initImage] : []),
      ...(req.inputs.maskImage ? [req.inputs.maskImage] : []),
    ]
    let phase: string | undefined
    // 'progress'/'stage' are process-wide events: ignore them unless this job is
    // the one sd-server is currently generating.
    const onProgress = (p: { step: number; total: number; speed?: string }): void => {
      if (generatingJobId !== jobId) return
      // A restarting step count (e.g. hires second pass) is fine; phase labels it.
      emit(jobId, { stage: 'sampling', step: p.step, totalSteps: p.total, speed: p.speed, message: phase })
    }
    const onStage = (stage: 'decoding' | 'hires' | 'sampling'): void => {
      if (generatingJobId !== jobId) return
      if (stage === 'hires') phase = 'hires pass'
      emit(jobId, stage === 'decoding' ? { stage: 'decoding' } : { stage: 'sampling', message: phase })
    }
    deps.server.on('progress', onProgress)
    deps.server.on('stage', onStage)
    let result: { format: string; images: Buffer[] }
    try {
      emit(jobId, { stage: 'waiting' })
      result = await deps.server.imgGen(body, {
        signal: ac.signal,
        onQueued: (pos) => {
          emit(jobId, { stage: 'queued', message: `Waiting in sd-server queue (position ${pos})` })
        },
        onState: (state) => {
          if (state === 'generating') generatingJobId = jobId
        },
      })
    } finally {
      deps.server.off('progress', onProgress)
      deps.server.off('stage', onStage)
      if (generatingJobId === jobId) generatingJobId = null
    }

    const mediaType = mimeFromFormat(result.format)
    return finalize(jobId, {
      provider: 'local',
      model: profile.name,
      params: body,
      prompt: req.prompt,
      negativePrompt: req.negativePrompt,
      dataUrls,
      outputs: result.images.map((data) => ({ data, mediaType })),
      startedAt,
      threadId: req.threadId,
      settings: deps.getSettings(),
      seed,
    })
  }

  return {
    cancel(jobId) {
      activeJobs.get(jobId)?.abort()
    },

    run(jobId, req) {
      const startedAt = Date.now()
      return withJob(jobId, (ac) =>
        req.provider === 'openrouter'
          ? runOpenRouter(jobId, req, ac, startedAt)
          : runLocal(jobId, req, ac, startedAt),
      )
    },

    async upscale(jobId, req): Promise<GenerationResult> {
      const startedAt = Date.now()
      return withJob(jobId, async (ac) => {
        if (IS_SLIM) return { ok: false, jobId, error: LOCAL_DISABLED_MSG }
        const item = await deps.history.get(req.historyId)
        if (!item) throw new Error(`History item not found: ${req.historyId}`)
        const file = item.files[req.fileIndex]
        if (!file) throw new Error(`History item has no file at index ${req.fileIndex}`)
        emit(jobId, { stage: 'loading' })
        await ensureServerRunning(jobId, ac.signal)
        const bytes = await readFile(file)
        emit(jobId, { stage: 'uploading' })
        const result = await deps.server.upscale(
          {
            image: toDataUrl(bytes, file),
            upscaler: req.upscaler,
            repeats: req.repeats,
            tile_size: req.tileSize,
          },
          { signal: ac.signal },
        )
        const filesOut = await saveOutputs(deps.getSettings().outputDir, [
          { data: result.image, mediaType: mimeFromFormat(result.format) },
        ])
        const upItem: HistoryItem = {
          id: randomBytes(8).toString('hex'),
          createdAt: Date.now(),
          provider: 'local',
          model: item.model,
          prompt: item.prompt,
          negativePrompt: item.negativePrompt,
          params: { upscaler: result.upscaler, repeats: req.repeats },
          files: filesOut,
          inputFiles: [],
          width: result.width,
          height: result.height,
          durationMs: Date.now() - startedAt,
          threadId: item.threadId,
          kind: 'upscale',
          parentId: item.id,
        }
        await Promise.all(filesOut.map((f) => writeSidecar(f, upItem)))
        await deps.history.add(upItem)
        emit(jobId, { stage: 'done' })
        return { ok: true, jobId, item: upItem }
      })
    },
  }
}

// ---------------------------------------------------------------------------
// Output persistence helpers

/** Saves output buffers as `${outputDir}/${YYYY-MM-DD}/${timestamp}-${shortid}-${i}.${ext}`. */
async function saveOutputs(
  outputDir: string,
  outputs: { data: Buffer; mediaType: string }[],
): Promise<string[]> {
  const dir = join(outputDir, new Date().toISOString().slice(0, 10))
  await mkdir(dir, { recursive: true })
  const files: string[] = []
  for (let i = 0; i < outputs.length; i++) {
    const base = `${Date.now()}-${randomBytes(3).toString('hex')}-${i}`
    const file = join(dir, `${base}.${extFromMediaType(outputs[i].mediaType, outputs[i].data)}`)
    await writeFile(file, outputs[i].data)
    files.push(file)
  }
  return files
}

/**
 * Saves data-URL inputs deduplicated by content sha1, into `<date>/inputs/`.
 * Returns one entry per input, aligned 1:1 with `dataUrls` — null when the
 * data URL could not be parsed.
 */
async function saveInputs(
  outputDir: string,
  dataUrls: string[],
): Promise<(string | null)[]> {
  const out: (string | null)[] = []
  if (dataUrls.length === 0) return out
  const dir = join(outputDir, new Date().toISOString().slice(0, 10), 'inputs')
  for (const dataUrl of dataUrls) {
    // Mime type, optional extra parameters (e.g. ;charset=utf-8) and the
    // base64 payload (standard or base64url alphabet).
    const m = /^data:([^;,]+);(?:[^;,]+;)*base64,([A-Za-z0-9+/=_-]+)$/.exec(dataUrl)
    if (!m) {
      out.push(null)
      continue
    }
    const bytes = Buffer.from(m[2].replace(/-/g, '+').replace(/_/g, '/'), 'base64')
    const hash = createHash('sha1').update(bytes).digest('hex')
    const file = join(dir, `${hash}.${extFromMediaType(m[1], bytes)}`)
    const exists = await stat(file).then(
      () => true,
      () => false,
    )
    if (!exists) {
      await mkdir(dir, { recursive: true })
      await writeFile(file, bytes)
    }
    out.push(file)
  }
  return out
}

/** Replaces data URLs in a params object by their saved file paths. */
function replaceDataUrls(val: unknown, map: Map<string, string>): unknown {
  if (typeof val === 'string') return map.get(val) ?? val
  if (Array.isArray(val)) return val.map((v) => replaceDataUrls(v, map))
  if (val && typeof val === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(val as Record<string, unknown>)) {
      out[k] = replaceDataUrls(v, map)
    }
    return out
  }
  return val
}

async function writeSidecar(file: string, item: HistoryItem): Promise<void> {
  await writeFile(`${file}.json`, JSON.stringify(item, null, 2))
}

// ---------------------------------------------------------------------------
// Image dimension parsing (PNG / JPEG / WebP, header-only, no dependencies)

export interface ImageDimensions {
  width: number
  height: number
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/** Reads width/height from PNG, JPEG or WebP bytes; null when it can't be parsed. */
export function readImageDimensions(buf: Buffer): ImageDimensions | null {
  if (buf.length >= 24 && buf.subarray(0, 8).equals(PNG_SIGNATURE)) {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
  }
  if (buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xd8) return readJpegDimensions(buf)
  if (
    buf.length >= 30 &&
    buf.subarray(0, 4).toString('latin1') === 'RIFF' &&
    buf.subarray(8, 12).toString('latin1') === 'WEBP'
  ) {
    return readWebpDimensions(buf)
  }
  return null
}

function readJpegDimensions(buf: Buffer): ImageDimensions | null {
  let i = 2
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) {
      i++
      continue
    }
    const marker = buf[i + 1]
    // RST markers, SOI, EOI and fill bytes carry no length prefix.
    if (marker === 0xff || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
      i += 2
      continue
    }
    // SOF0-SOF15 except DHT (0xc4), JPG (0xc8) and DAC (0xcc) hold the dimensions.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) }
    }
    i += 2 + buf.readUInt16BE(i + 2)
  }
  return null
}

function readWebpDimensions(buf: Buffer): ImageDimensions | null {
  const fourcc = buf.subarray(12, 16).toString('latin1')
  if (fourcc === 'VP8 ') {
    // Lossy: after the 3-byte frame tag, little-endian 14-bit dims at payload +6/+8.
    return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff }
  }
  if (fourcc === 'VP8L') {
    // Lossless: signature 0x2f, then width-1/height-1 packed in one LE u32.
    if (buf[20] !== 0x2f) return null
    const v = buf.readUInt32LE(21)
    return { width: (v & 0x3fff) + 1, height: ((v >>> 14) & 0x3fff) + 1 }
  }
  // Extended: 24-bit width-1/height-1 at payload offsets 4 and 7.
  if (fourcc === 'VP8X') {
    return { width: buf.readUIntLE(24, 3) + 1, height: buf.readUIntLE(27, 3) + 1 }
  }
  return null
}

// ---------------------------------------------------------------------------
// Misc

export function extFromMediaType(mediaType: string, data?: Buffer): string {
  switch (mediaType.toLowerCase()) {
    case 'image/png':
      return 'png'
    case 'image/jpeg':
      return 'jpg'
    case 'image/webp':
      return 'webp'
    case 'image/gif':
      return 'gif'
    case 'image/svg+xml':
      return 'svg'
    default:
      // Unknown media type: fall back to sniffing the magic bytes.
      return data ? sniffImageFormat(data) : 'bin'
  }
}

/** Guesses the image format from magic bytes; 'bin' when nothing matches. */
export function sniffImageFormat(buf: Buffer): string {
  if (buf.length >= 8 && buf.subarray(0, 8).equals(PNG_SIGNATURE)) return 'png'
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xd8) return 'jpg'
  if (
    buf.length >= 12 &&
    buf.subarray(0, 4).toString('latin1') === 'RIFF' &&
    buf.subarray(8, 12).toString('latin1') === 'WEBP'
  ) {
    return 'webp'
  }
  if (buf.length >= 4 && buf.subarray(0, 4).toString('latin1').startsWith('GIF')) return 'gif'
  // SVG: optional BOM/whitespace, then an XML declaration or the <svg> root.
  const head = buf.subarray(0, 256).toString('utf8').replace(/^\uFEFF?\s+/, '')
  if (head.startsWith('<?xml') || head.startsWith('<svg')) return 'svg'
  return 'bin'
}

function mimeFromFormat(format: string): string {
  switch (format.toLowerCase()) {
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg'
    case 'webp':
      return 'image/webp'
    case 'gif':
      return 'image/gif'
    case 'svg':
      return 'image/svg+xml'
    case 'bmp':
      return 'image/bmp'
    default:
      return 'image/png'
  }
}

function toDataUrl(bytes: Buffer, file: string): string {
  const ext = /\.([a-z0-9]+)$/i.exec(file)?.[1] ?? 'png'
  return `data:${mimeFromFormat(ext)};base64,${bytes.toString('base64')}`
}

/** Reads a file as a data URL, with the mime type guessed from the extension. */
export async function readFileAsDataUrl(path: string): Promise<string> {
  const ext = /\.([a-z0-9]+)$/i.exec(path)?.[1] ?? 'png'
  const bytes = await readFile(path)
  return `data:${mimeFromFormat(ext)};base64,${bytes.toString('base64')}`
}
