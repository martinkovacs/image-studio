// Hugging Face Hub REST client. Every request goes through an injectable
// fetch; the token is only ever attached as `Authorization: Bearer` to
// huggingface.co URLs — never to CDN redirects or foreign Link headers.
import type { HfFile, HfGated, HfModelSummary, HfRepoDetails, HfRepoKind, HfSearchOptions } from '@shared/types'
import { groupQuants } from '@shared/quants'

export const HF_BASE = 'https://huggingface.co'

/** Options shared by every hub call. */
export interface HfRequestOpts {
  token?: string | null
  fetchImpl?: typeof fetch
}

export interface HfRepoOpts extends HfRequestOpts {
  /** Branch or commit to read; default 'main'. */
  revision?: string
}

const GATED_MESSAGE = 'This repository is gated — accept its licence on huggingface.co and add a token in Settings → Hugging Face'
const REPO_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}\/[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/
const MAX_TREE_PAGES = 20

export function isValidRepoId(id: string): boolean {
  return REPO_ID_RE.test(id) && !id.includes('..')
}

/** Repo-internal path that is safe to join onto a local directory. */
export function isSafeRepoPath(p: string): boolean {
  if (!p || p.length >= 512) return false
  if (p.startsWith('/') || p.includes('\\') || p.includes(':')) return false
  return p.split('/').every((seg) => seg.length > 0 && seg !== '.' && seg !== '..')
}

function assertRepoId(id: string): void {
  if (!isValidRepoId(id)) throw new Error('Invalid repository id')
}

function friendlyHttpError(status: number): string {
  if (status === 401) return 'Hugging Face rejected the token'
  if (status === 403) return 'Hugging Face denied access to this repository'
  if (status === 404) return 'Repository not found'
  if (status === 429) return 'Hugging Face is rate limiting requests — try again in a moment'
  return `Hugging Face request failed (HTTP ${status})`
}

/** True only for https://huggingface.co itself (a prefix check would also match huggingface.co.evil.example). */
export function isHfUrl(url: string): boolean {
  try {
    return new URL(url).origin === HF_BASE
  } catch {
    return false
  }
}

async function hfFetch(url: string, opts: HfRequestOpts & { headers?: Record<string, string> }): Promise<Response> {
  const headers: Record<string, string> = { 'User-Agent': 'image-studio', ...(opts.headers ?? {}) }
  if (opts.token && isHfUrl(url)) headers.Authorization = `Bearer ${opts.token}`
  return (opts.fetchImpl ?? fetch)(url, { headers, redirect: 'follow' })
}

function normalizeGated(g: unknown): HfGated {
  if (g === 'auto' || g === 'manual') return g
  if (g === true) return 'auto' // legacy boolean form
  return false
}

interface RawModelRow {
  id?: string
  modelId?: string
  author?: string
  downloads?: number
  likes?: number
  lastModified?: string
  tags?: string[]
  pipeline_tag?: string
  library_name?: string
  gated?: unknown
}

/** GET /api/models — search summaries. */
export async function searchModels(opts: HfSearchOptions, { token, fetchImpl }: HfRequestOpts = {}): Promise<HfModelSummary[]> {
  const limit = Math.min(Math.max(opts.limit ?? 30, 1), 100)
  const params = new URLSearchParams({
    search: opts.query,
    sort: opts.sort ?? 'downloads',
    direction: '-1',
    limit: String(limit),
    full: 'false',
    config: 'false'
  })
  if (opts.format === 'gguf') params.set('filter', 'gguf')
  if (opts.format === 'diffusers') params.set('library', 'diffusers')
  if (opts.task) params.set('pipeline_tag', opts.task)
  const res = await hfFetch(`${HF_BASE}/api/models?${params}`, { token, fetchImpl })
  if (!res.ok) throw new Error(friendlyHttpError(res.status))
  const rows = (await res.json()) as RawModelRow[]
  return rows.map((r) => ({
    id: r.id ?? r.modelId ?? '',
    ...(r.author ? { author: r.author } : {}),
    downloads: r.downloads ?? 0,
    likes: r.likes ?? 0,
    ...(r.lastModified ? { lastModified: r.lastModified } : {}),
    tags: r.tags ?? [],
    ...(r.pipeline_tag ? { pipelineTag: r.pipeline_tag } : {}),
    ...(r.library_name ? { libraryName: r.library_name } : {}),
    gated: normalizeGated(r.gated)
  }))
}

interface RawTreeEntry {
  type?: string
  path?: string
  size?: number
  lfs?: { oid?: string }
}

/**
 * Repo metadata + full file list. Reads /api/models/{id} (at `revision` when a
 * non-main branch is given) and then the tree at the returned commit sha,
 * following `Link: rel="next"` pagination up to 20 pages.
 */
export async function getRepoDetails(id: string, { token, fetchImpl, revision }: HfRepoOpts = {}): Promise<HfRepoDetails> {
  assertRepoId(id)
  const infoUrl = revision && revision !== 'main' ? `${HF_BASE}/api/models/${id}/revision/${encodeURIComponent(revision)}` : `${HF_BASE}/api/models/${id}`
  const res = await hfFetch(infoUrl, { token, fetchImpl })
  if (!res.ok) {
    if (res.status === 401 || res.status === 403) throw new Error(GATED_MESSAGE)
    throw new Error(friendlyHttpError(res.status))
  }
  const info = (await res.json()) as { sha?: string; gated?: unknown; pipeline_tag?: string; cardData?: { license?: string } }
  const sha = info.sha
  if (!sha) throw new Error('Hugging Face did not return a commit sha for this repository')

  const files: HfFile[] = []
  let url: string | null = `${HF_BASE}/api/models/${id}/tree/${sha}?recursive=true`
  for (let page = 0; url && page < MAX_TREE_PAGES; page++) {
    const tres = await hfFetch(url, { token, fetchImpl })
    if (!tres.ok) {
      if ((tres.status === 401 || tres.status === 403) && normalizeGated(info.gated) !== false) throw new Error(GATED_MESSAGE)
      throw new Error(friendlyHttpError(tres.status))
    }
    for (const e of (await tres.json()) as RawTreeEntry[]) {
      if (e.type === 'directory' || !e.path || !isSafeRepoPath(e.path)) continue
      // lfs.oid is the file's sha256 (also for Xet-backed files); xetHash is a
      // different (merkle) hash and must not be compared against sha256.
      const sha256 = e.lfs?.oid
      files.push({ path: e.path, size: typeof e.size === 'number' ? e.size : 0, ...(sha256 ? { sha256 } : {}) })
    }
    url = nextLinkUrl(tres.headers)
  }
  return {
    id,
    sha,
    kind: repoKindFromPaths(files.map((f) => f.path)),
    gated: normalizeGated(info.gated),
    files,
    quants: groupQuants(files),
    totalBytes: files.reduce((n, f) => n + f.size, 0),
    ...(info.pipeline_tag ? { pipelineTag: info.pipeline_tag } : {}),
    ...(info.cardData?.license ? { license: info.cardData.license } : {})
  }
}

function nextLinkUrl(headers: Headers): string | null {
  const link = headers.get('link')
  if (!link) return null
  for (const part of link.split(',')) {
    const m = part.match(/<([^>]+)>\s*;\s*rel="?next"?/)
    if (m) return m[1]
  }
  return null
}

/** Repo kind derived from its file paths. */
export function repoKindFromPaths(paths: string[]): HfRepoKind {
  if (paths.includes('model_index.json')) return 'diffusers'
  const endsWith = (suffix: string) => paths.some((p) => p.toLowerCase().endsWith(suffix))
  if (endsWith('.gguf')) return 'gguf'
  if (endsWith('.safetensors')) return 'single-file'
  return 'other'
}

/** Resolve URL for one repo file; the CDN redirect is followed by fetch itself. */
export function fileUrl(repo: string, revision: string, path: string): string {
  assertRepoId(repo)
  if (!isSafeRepoPath(path)) throw new Error(`Unsafe repository path: ${path}`)
  return `${HF_BASE}/${repo}/resolve/${encodeURIComponent(revision)}/${path.split('/').map(encodeURIComponent).join('/')}`
}

const SHARDED_RE = /-\d{5}-of-\d{5}\.safetensors$/i
/** Weight formats other than safetensors: pickles can execute code on load, the rest is unused. */
const NON_SAFETENSORS_WEIGHTS = /\.(bin|ckpt|pt|pth|pkl|onnx|onnx_data|msgpack|h5|gguf)$/i

/**
 * Files needed to run a diffusers repo from a local folder: the pipeline
 * manifest, per-subfolder configs/tokenizers/schedulers, and weights only as
 * .safetensors (never .bin/.ckpt/…). When a subfolder has both a shard set and
 * a monolithic file only the shards (plus index json) are kept.
 * `excludeTransformer` drops the transformer weights but keeps its config
 * json, which diffusers needs to load a GGUF transformer in their place.
 */
export function filesForDiffusersRepo(details: Pick<HfRepoDetails, 'files'>, opts?: { excludeTransformer?: boolean }): HfFile[] {
  const excludeTransformer = opts?.excludeTransformer ?? false
  const keep = new Set<string>()
  const shardsByTop = new Map<string, string[]>()
  const singlesByTop = new Map<string, string[]>()
  for (const f of details.files) {
    const p = f.path
    if (NON_SAFETENSORS_WEIGHTS.test(p)) continue
    const slash = p.indexOf('/')
    if (slash === -1) {
      if (p === 'model_index.json' || /^(readme\.md|license)/i.test(p)) keep.add(p)
      continue
    }
    const top = p.slice(0, slash)
    const rest = p.slice(slash + 1)
    if (excludeTransformer && top === 'transformer' && !/\.json$/i.test(rest)) continue
    if (rest === 'config.json' || top === 'scheduler' || top.startsWith('tokenizer') || top === 'processor' || /\.(json|txt|model)$/i.test(rest)) {
      keep.add(p)
    }
    if (/\.safetensors$/i.test(rest)) {
      keep.add(p)
      const bucket = SHARDED_RE.test(rest) ? shardsByTop : singlesByTop
      const list = bucket.get(top) ?? []
      list.push(p)
      bucket.set(top, list)
    }
  }
  for (const [top, singles] of singlesByTop) {
    if (shardsByTop.has(top)) for (const p of singles) keep.delete(p)
  }
  return details.files.filter((f) => keep.has(f.path))
}
