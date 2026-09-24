// OpenRouter Unified Image API client. No electron imports; API key is passed in by the caller.
import type { OrImageModel, OrImageParams } from '../shared/types'

const BASE = 'https://openrouter.ai/api/v1'
const REQUEST_TIMEOUT_MS = 5 * 60 * 1000

export interface GenerateImagesArgs {
  apiKey: string
  model: string
  prompt: string
  params: OrImageParams
  /** Reference images as data URLs. */
  refImages: string[]
  inputReferenceUrls?: string[]
  signal?: AbortSignal
}

export interface GeneratedImage {
  data: Buffer
  mediaType: string
}

export interface GenerateImagesResult {
  images: GeneratedImage[]
  costUsd?: number
  raw: unknown
}

// ---------------------------------------------------------------------------
// Model listing (public endpoint, cached for 1h)

let modelCache: { at: number; models: OrImageModel[] } | null = null
const MODEL_CACHE_TTL_MS = 60 * 60 * 1000

export async function listImageModels(force = false): Promise<OrImageModel[]> {
  if (!force && modelCache && Date.now() - modelCache.at < MODEL_CACHE_TTL_MS) {
    return modelCache.models
  }
  const res = await fetch(`${BASE}/images/models`)
  if (!res.ok) throw new Error(`OpenRouter model listing failed (HTTP ${res.status})`)
  const json = (await res.json()) as { data?: OrImageModel[] }
  const models = [...(json.data ?? [])].sort(
    (a, b) => (b.created ?? 0) - (a.created ?? 0),
  )
  modelCache = { at: Date.now(), models }
  return models
}

// ---------------------------------------------------------------------------
// Image generation

interface OrImageResponseData {
  b64_json?: string
  url?: string
  media_type?: string
}

interface OrImageResponse {
  data?: OrImageResponseData[]
  usage?: { cost?: number; [k: string]: unknown }
  error?: { message?: string; code?: number | string; [k: string]: unknown }
}

async function parseErrorMessage(res: Response, fallback: string): Promise<string> {
  try {
    const json = (await res.json()) as OrImageResponse
    const err = json.error
    if (err?.message) return `OpenRouter error ${err.code ?? res.status}: ${err.message}`
  } catch {
    /* response was not JSON */
  }
  return fallback
}

function dropEmpty(params: OrImageParams): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue
    if (typeof v === 'string' && v.trim() === '') continue
    out[k] = v
  }
  return out
}

/** 5-minute timeout combined with the caller's signal (when present). */
function combineSignal(signal?: AbortSignal): AbortSignal {
  return signal
    ? AbortSignal.any([AbortSignal.timeout(REQUEST_TIMEOUT_MS), signal])
    : AbortSignal.timeout(REQUEST_TIMEOUT_MS)
}

const MAX_IMAGE_BYTES = 200 * 1024 * 1024

/** Downloads a provider-hosted result. The URL is remote-controlled: https only, size-capped. */
async function fetchImageFromUrl(url: string, signal?: AbortSignal): Promise<GeneratedImage> {
  if (new URL(url).protocol !== 'https:') throw new Error('Refusing to download generated image over a non-https URL')
  const res = await fetch(url, { signal: combineSignal(signal), redirect: 'error' })
  if (!res.ok || !res.body) throw new Error(`Failed to download generated image (HTTP ${res.status})`)
  if (Number(res.headers.get('content-length') ?? 0) > MAX_IMAGE_BYTES) throw new Error('Generated image is too large')
  const chunks: Uint8Array[] = []
  let size = 0
  for await (const chunk of res.body) {
    size += chunk.byteLength
    if (size > MAX_IMAGE_BYTES) throw new Error('Generated image is too large')
    chunks.push(chunk)
  }
  const mediaType = res.headers.get('content-type')?.split(';')[0] ?? 'image/png'
  return { data: Buffer.concat(chunks), mediaType }
}

export async function generateImages(
  args: GenerateImagesArgs,
): Promise<GenerateImagesResult> {
  const body: Record<string, unknown> = {
    model: args.model,
    prompt: args.prompt,
    ...dropEmpty(args.params),
    input_references:
      (args.refImages.length > 0 || args.inputReferenceUrls?.length)
        ? [
            ...args.refImages.map((url) => ({ type: 'image_url', image_url: { url } })),
          ]
        : undefined,
  }

  let res: Response
  try {
    res = await fetch(`${BASE}/images`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${args.apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://github.com/image-studio',
        'X-Title': 'Image Studio',
      },
      body: JSON.stringify(body),
      signal: combineSignal(args.signal),
    })
  } catch (e) {
    if (args.signal?.aborted) throw new CancelledError()
    throw e
  }

  if (!res.ok) {
    throw new Error(await parseErrorMessage(res, `OpenRouter image generation failed (HTTP ${res.status})`))
  }

  const json = (await res.json()) as OrImageResponse
  const entries = json.data ?? []
  const images: GeneratedImage[] = []
  for (const entry of entries) {
    if (entry.b64_json) {
      images.push({
        data: Buffer.from(entry.b64_json, 'base64'),
        mediaType: entry.media_type ?? 'image/png',
      })
    } else if (entry.url) {
      images.push(await fetchImageFromUrl(entry.url, args.signal))
    }
  }

  return { images, costUsd: json.usage?.cost, raw: json }
}

/** Sentinel used to convert an aborted request into a cancelled generation. */
export class CancelledError extends Error {
  name = 'CancelledError'
  constructor() {
    super('Cancelled')
  }
}

// ---------------------------------------------------------------------------
// Credits

export async function getCredits(
  apiKey: string,
): Promise<{ total: number; used: number } | null> {
  try {
    const res = await fetch(`${BASE}/credits`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) return null
    const json = (await res.json()) as {
      data?: { total_credits?: number; total_usage?: number }
    }
    if (typeof json.data?.total_credits !== 'number') return null
    return { total: json.data.total_credits, used: json.data.total_usage ?? 0 }
  } catch {
    return null
  }
}
