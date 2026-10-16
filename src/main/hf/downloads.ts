// Hugging Face download manager. Downloads are queued one at a time; within a
// download, files are fetched in parallel and streamed to
// modelsDir/<owner>/<repo>/… as `.part` files that support resume, with
// sha256 verified while streaming. Progress events are throttled to ~4/s per
// download plus a final event per file / terminal state.
import { EventEmitter } from 'node:events'
import { createReadStream } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import type { Dirent } from 'node:fs'
import type { HfDownloadProgress, HfDownloadRequest, HfDownloadState, HfFile, HfLocalFile, HfLocalRepo } from '@shared/types'
import { fileUrl, isHfUrl, getRepoDetails, isSafeRepoPath, isValidRepoId, MANIFEST_NAME, repoKindFromPaths } from './hub'

export interface DownloadManagerOptions {
  /** Returns the root directory holding <owner>/<repo> model folders. */
  modelsDir: () => string
  /** Returns the Hugging Face token to use, or null. */
  token: () => string | null
  fetchImpl?: typeof fetch
  /** Repo files fetched in parallel within one download (default 2). */
  concurrency?: number
  /** Abort a transfer that receives no bytes for this long (default 60 s). */
  stallTimeoutMs?: number
}

interface DownloadRecord {
  id: string
  repo: string
  revision: string
  catalogId?: string
  paths: string[]
  expected?: HfFile[]
  state: HfDownloadState
  file?: string
  filesDone: number
  filesTotal: number
  /** Bytes of files already completed or skipped. */
  bytesBase: number
  /** Bytes of the files currently transferring, by repo path (resumed parts included). */
  inflight: Map<string, number>
  bytesTotal: number
  speed?: number
  error?: string
  /** First hard failure; aborts the whole download. */
  failed?: string
  controller: AbortController
  waiters: Array<(p: HfDownloadProgress) => void>
  finished: boolean
  lastEmitAt?: number
  lastSampleAt?: number
  lastSampleBytes: number
}

const PROGRESS_MIN_MS = 250

/**
 * Per-repo manifest of files verified on disk, e.g.
 * `<localDir>/.image-studio-files.json` = `{ [repoPath]: { size, sha256?, revision } }`.
 * Files all revisions share one folder, so a size match alone is not enough to
 * skip a download: the manifest vouches for which exact bytes are in place.
 * The name is exported from hub.ts (MANIFEST_NAME) so repo listings can
 * exclude it and enqueue/destPath can refuse to write a file with that name.
 */

interface ManifestEntry {
  /** Size of the verified file in bytes. */
  size: number
  /** sha256 of the content, when known. */
  sha256?: string
  /** Repo revision (commit) the file was fetched from. */
  revision: string
}

type FilesManifest = Record<string, ManifestEntry>

// Manifest writes are serialized per repo so parallel workers never clobber entries.
const manifestLocks = new Map<string, Promise<void>>()

function manifestPath(repoDir: string): string {
  return path.join(repoDir, MANIFEST_NAME)
}

/** Reads a repo's manifest; {} when missing or unreadable. */
async function readManifest(repoDir: string): Promise<FilesManifest> {
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(manifestPath(repoDir), 'utf8'))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as FilesManifest) : {}
  } catch {
    return {}
  }
}

/** Atomically merges one verified file entry into the repo's manifest (tmp + rename). */
async function recordVerified(repoDir: string, repoPath: string, entry: ManifestEntry): Promise<void> {
  const file = manifestPath(path.resolve(repoDir))
  const prev = manifestLocks.get(file) ?? Promise.resolve()
  const run = prev.catch(() => undefined).then(async () => {
    const manifest = await readManifest(repoDir)
    manifest[repoPath] = entry
    const tmp = `${file}.${randomUUID()}.tmp`
    await fs.writeFile(tmp, JSON.stringify(manifest))
    await fs.rename(tmp, file)
  })
  manifestLocks.set(file, run.then(() => undefined, () => undefined))
  await run
}

/** `_class_name` from a small `<repoDir>/model_index.json`, for diffusers pipelines. */
async function readPipelineClass(dir: string): Promise<{ pipelineClass?: string }> {
  try {
    const file = path.join(dir, 'model_index.json')
    if ((await fs.stat(file)).size >= 1_000_000) return {}
    const parsed: unknown = JSON.parse(await fs.readFile(file, 'utf8'))
    const cls = (parsed as { _class_name?: unknown } | null)?._class_name
    return typeof cls === 'string' && cls ? { pipelineClass: cls } : {}
  } catch {
    return {}
  }
}

export class DownloadManager extends EventEmitter {
  private readonly modelsDir: () => string
  private readonly token: () => string | null
  private readonly fetchImpl: typeof fetch
  private readonly concurrency: number
  private readonly stallTimeoutMs: number
  private readonly records = new Map<string, DownloadRecord>()
  private readonly queue: string[] = []
  private readonly finishedList: HfDownloadProgress[] = []
  private pumping = false

  constructor(opts: DownloadManagerOptions) {
    super()
    this.modelsDir = opts.modelsDir
    this.token = opts.token
    this.fetchImpl = opts.fetchImpl ?? fetch.bind(globalThis)
    this.concurrency = Math.max(1, opts.concurrency ?? 2)
    this.stallTimeoutMs = Math.max(1, opts.stallTimeoutMs ?? 60000)
  }

  /** Queues a download and returns its id immediately. */
  enqueue(req: HfDownloadRequest & { catalogId?: string; expected?: HfFile[] }): string {
    if (!isValidRepoId(req.repo)) throw new Error('Invalid repository id')
    for (const p of req.files) {
      if (p === MANIFEST_NAME) throw new Error('Reserved file name')
      if (!isSafeRepoPath(p)) throw new Error(`Unsafe repository path: ${p}`)
    }
    const id = randomUUID()
    const rec: DownloadRecord = {
      id,
      repo: req.repo,
      revision: req.revision ?? 'main',
      ...(req.catalogId !== undefined ? { catalogId: req.catalogId } : {}),
      paths: [...req.files],
      ...(req.expected ? { expected: req.expected } : {}),
      state: 'queued',
      filesDone: 0,
      filesTotal: req.files.length,
      bytesBase: 0,
      inflight: new Map(),
      bytesTotal: (req.expected ?? []).reduce((n, f) => n + (f.size || 0), 0),
      controller: new AbortController(),
      waiters: [],
      finished: false,
      lastSampleBytes: 0
    }
    this.records.set(id, rec)
    this.queue.push(id)
    this.emitProgress(rec)
    void this.pump()
    return id
  }

  /** Aborts a queued or running download; .part files are kept for resume. */
  cancel(downloadId: string): void {
    const rec = this.records.get(downloadId)
    if (!rec || rec.finished) return
    if (rec.state === 'queued') {
      const i = this.queue.indexOf(downloadId)
      if (i !== -1) this.queue.splice(i, 1)
      rec.state = 'cancelled'
      this.finish(rec)
      return
    }
    rec.controller.abort()
  }

  /** Active downloads plus the last 50 finished ones. */
  list(): HfDownloadProgress[] {
    return [...[...this.records.values()].map((r) => this.snapshot(r)), ...this.finishedList]
  }

  /** Resolves with the final progress once the download is done/errored/cancelled. */
  whenDone(downloadId: string): Promise<HfDownloadProgress> {
    const done = this.finishedList.find((p) => p.downloadId === downloadId)
    if (done) return Promise.resolve(done)
    const rec = this.records.get(downloadId)
    if (!rec) return Promise.reject(new Error(`Unknown download: ${downloadId}`))
    return new Promise((resolve) => {
      rec.waiters.push(resolve)
    })
  }

  /** Absolute destination directory for a repo: modelsDir/<owner>/<repo>. */
  localDir(repo: string): string {
    if (!isValidRepoId(repo)) throw new Error('Invalid repository id')
    return path.join(this.modelsDir(), ...repo.split('/'))
  }

  /** Lists locally present models by walking modelsDir two levels (owner/repo). */
  async scanLocal(): Promise<HfLocalRepo[]> {
    const root = path.resolve(this.modelsDir())
    let owners: Dirent[]
    try {
      owners = await fs.readdir(root, { withFileTypes: true })
    } catch {
      return []
    }
    const repos: HfLocalRepo[] = []
    for (const owner of owners) {
      if (!owner.isDirectory() || owner.name.startsWith('.')) continue
      let entries: Dirent[]
      try {
        entries = await fs.readdir(path.join(root, owner.name), { withFileTypes: true })
      } catch {
        continue
      }
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.name.startsWith('.')) continue
        const dir = path.join(root, owner.name, entry.name)
        const files = await this.walkRepoDir(dir, '')
        repos.push({
          repo: `${owner.name}/${entry.name}`,
          dir,
          files,
          totalBytes: files.reduce((n, f) => n + f.size, 0),
          kind: repoKindFromPaths(files.map((f) => f.path)),
          ...(await readPipelineClass(dir))
        })
      }
    }
    return repos
  }

  /** Deletes modelsDir/<owner>/<repo>; refuses while a download for it is active. */
  async removeLocal(repo: string): Promise<void> {
    if (!isValidRepoId(repo)) throw new Error('Invalid repository id')
    for (const rec of this.records.values()) {
      if (rec.repo === repo && !rec.finished) throw new Error(`A download for ${repo} is still active — cancel it first`)
    }
    const root = path.resolve(this.modelsDir())
    const dir = path.resolve(this.localDir(repo))
    if (!dir.startsWith(root + path.sep)) throw new Error('Refusing to remove a directory outside the models directory')
    await fs.rm(dir, { recursive: true, force: true })
  }

  // --- internals -----------------------------------------------------------

  private async pump(): Promise<void> {
    if (this.pumping) return
    this.pumping = true
    try {
      while (this.queue.length > 0) {
        const rec = this.records.get(this.queue.shift()!)
        if (!rec || rec.finished || rec.state !== 'queued') continue
        await this.runDownload(rec)
      }
    } finally {
      this.pumping = false
    }
  }

  private async runDownload(rec: DownloadRecord): Promise<void> {
    try {
      rec.state = 'downloading'
      this.emitProgress(rec)
      const files = await this.resolveMeta(rec)
      if (rec.controller.signal.aborted) throw new Error('Download cancelled')
      rec.filesTotal = files.length
      rec.bytesTotal = files.reduce((n, f) => n + (f.size || 0), 0)
      this.emitProgress(rec)
      let cursor = 0
      const worker = async (): Promise<void> => {
        while (true) {
          if (rec.failed || rec.controller.signal.aborted) return
          const index = cursor++
          if (index >= files.length) return
          try {
            await this.fetchOne(rec, files[index])
          } catch (err) {
            if (!rec.controller.signal.aborted) rec.failed ??= errorMessage(err)
            return
          }
        }
      }
      await Promise.all(Array.from({ length: Math.min(this.concurrency, files.length) }, worker))
      if (rec.failed) {
        rec.state = 'error'
        rec.error = rec.failed
      } else if (rec.filesDone >= rec.filesTotal) {
        rec.state = 'done' // every file finished — an abort at the very end still counts as done
      } else if (rec.controller.signal.aborted) {
        rec.state = 'cancelled'
      } else {
        rec.state = 'done'
      }
    } catch (err) {
      if (rec.controller.signal.aborted) {
        rec.state = 'cancelled'
      } else {
        rec.state = 'error'
        rec.error = errorMessage(err)
      }
    }
    this.finish(rec)
  }

  /** File metadata for the requested paths, from `expected` or the hub. */
  private async resolveMeta(rec: DownloadRecord): Promise<HfFile[]> {
    const pick = (files: HfFile[]) => {
      const byPath = new Map(files.map((f) => [f.path, f]))
      return rec.paths.map((p) => {
        const f = byPath.get(p)
        if (!f) throw new Error(`File not found in repository: ${p}`)
        return f
      })
    }
    if (rec.expected) return pick(rec.expected)
    const details = await getRepoDetails(rec.repo, { token: this.token(), fetchImpl: this.fetchImpl, revision: rec.revision })
    rec.revision = details.sha // pin to the commit the file list was read at
    return pick(details.files)
  }

  private async fetchOne(rec: DownloadRecord, meta: HfFile): Promise<void> {
    const dest = this.destPath(rec.repo, meta.path)
    rec.state = 'downloading'
    rec.file = meta.path
    this.emitProgress(rec)

    // Skip only files the manifest vouches for: same sha256 (or same revision
    // when no reference hash is known) and size — never re-hash multi-GB files.
    const repoDir = this.localDir(rec.repo)
    const entry = (await readManifest(repoDir))[meta.path]
    if (meta.size > 0 && (await fileSize(dest)) === meta.size) {
      const verified = meta.sha256
        ? entry?.sha256?.toLowerCase() === meta.sha256.toLowerCase()
        : entry?.revision === rec.revision
      if (verified) {
        rec.filesDone++
        rec.bytesBase += meta.size
        this.emitProgress(rec)
        return
      }
    }

    await fs.mkdir(path.dirname(dest), { recursive: true })
    const partPath = `${dest}.part`
    let partSize = await fileSize(partPath)
    // Only hashed (LFS) files may resume: the final sha256 proves the part and the
    // new bytes belong together. A small unhashed file could otherwise splice an
    // old revision's prefix onto a new one, so it always restarts.
    if (partSize > 0 && !meta.sha256) {
      await fs.rm(partPath, { force: true })
      partSize = 0
    }

    // Stall watchdog: aborts the transfer when no bytes arrive for stallTimeoutMs.
    // Linked to the download's controller so a user cancel still aborts the fetch.
    const stall = new AbortController()
    const onOuterAbort = () => stall.abort(rec.controller.signal.reason)
    rec.controller.signal.addEventListener('abort', onOuterAbort, { once: true })
    let stallTimer: ReturnType<typeof setTimeout> | undefined
    const pauseStall = () => {
      if (stallTimer !== undefined) clearTimeout(stallTimer)
      stallTimer = undefined
    }
    const resetStall = () => {
      pauseStall()
      const seconds = Math.max(1, Math.round(this.stallTimeoutMs / 1000))
      stallTimer = setTimeout(
        () => stall.abort(new Error(`Download stalled — no data for ${seconds} s; it resumes from where it stopped when you retry`)),
        this.stallTimeoutMs
      )
    }
    const clearStall = () => {
      pauseStall()
      rec.controller.signal.removeEventListener('abort', onOuterAbort)
    }
    const hash = createHash('sha256')
    let fileBytes = 0

    try {
      // Ask for the remaining bytes; 416 (part larger than the file) or a 206
      // whose content-range does not line up with the part restarts from zero.
      let res: Response | null = null
      for (let attempt = 0; attempt < 2; attempt++) {
        resetStall()
        const url = fileUrl(rec.repo, rec.revision, meta.path)
        const headers: Record<string, string> = {}
        const token = this.token()
        if (token && isHfUrl(url)) headers.Authorization = `Bearer ${token}`
        if (partSize > 0) headers.Range = `bytes=${partSize}-`
        // redirect:'follow' drops Authorization on the cross-origin CDN hop — intended.
        res = await this.fetchImpl(url, { headers, redirect: 'follow', signal: stall.signal })
        const rangeOk = res.status !== 206 || (res.headers.get('content-range') ?? '').startsWith(`bytes ${partSize}-`)
        if (partSize > 0 && (res.status === 416 || !rangeOk)) {
          await fs.rm(partPath, { force: true })
          partSize = 0
          continue
        }
        break
      }
      if (!res || (!res.ok && res.status !== 206)) {
        throw new Error(`Download failed for ${meta.path} (HTTP ${res?.status ?? 0})`)
      }

      const resuming = res.status === 206 && partSize > 0
      fileBytes = resuming ? partSize : 0
      rec.inflight.set(meta.path, fileBytes)
      if (resuming) {
        // The hash covers the whole file, so feed it the bytes already on disk.
        // Local work — pause the watchdog until streaming resumes.
        pauseStall()
        for await (const chunk of createReadStream(partPath)) hash.update(chunk)
      } else {
        await fs.rm(partPath, { force: true })
      }

      if (!res.body) throw new Error(`Download failed for ${meta.path}: empty response body`)
      resetStall() // re-armed after the local re-hash, before waiting for the first chunk
      const out = await fs.open(partPath, resuming ? 'a' : 'w')
      try {
        for await (const chunk of res.body) {
          resetStall()
          if (rec.controller.signal.aborted) throw new Error('Download cancelled')
          const buf = chunk as Buffer
          hash.update(buf)
          await out.write(buf)
          fileBytes += buf.byteLength
          rec.inflight.set(meta.path, fileBytes)
          this.maybeEmitProgress(rec)
        }
      } finally {
        await out.close()
        rec.inflight.delete(meta.path)
      }
    } catch (err) {
      // A stall surfaces as its own error — never as a user cancel.
      if (stall.signal.aborted && !rec.controller.signal.aborted) throw stall.signal.reason ?? err
      throw err
    } finally {
      clearStall()
    }

    rec.state = 'verifying'
    const digest = hash.digest('hex')
    if (meta.sha256 && digest !== meta.sha256.toLowerCase()) {
      await fs.rm(partPath, { force: true })
      throw new Error(`Checksum mismatch for ${meta.path} — the file was corrupted in transit, delete and retry`)
    }
    await fs.rename(partPath, dest)
    await recordVerified(repoDir, meta.path, { size: fileBytes, sha256: digest, revision: rec.revision })
    rec.filesDone++
    rec.bytesBase += fileBytes
    this.emitProgress(rec)
  }

  private destPath(repo: string, relPath: string): string {
    if (relPath === MANIFEST_NAME) throw new Error('Reserved file name')
    if (!isSafeRepoPath(relPath)) throw new Error(`Unsafe repository path: ${relPath}`)
    const root = path.resolve(this.localDir(repo))
    const dest = path.resolve(root, ...relPath.split('/'))
    if (dest !== root && !dest.startsWith(root + path.sep)) throw new Error(`Unsafe repository path: ${relPath}`)
    return dest
  }

  private async walkRepoDir(dir: string, prefix: string): Promise<HfLocalFile[]> {
    let entries: Dirent[]
    try {
      entries = await fs.readdir(path.join(dir, prefix), { withFileTypes: true })
    } catch {
      return []
    }
    const out: HfLocalFile[] = []
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      // Hidden entries include the verified-files manifest and its tmp files.
      if (entry.name.startsWith('.')) continue
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        out.push(...(await this.walkRepoDir(dir, rel)))
      } else if (entry.isFile() && !entry.name.endsWith('.part')) {
        const absPath = path.join(dir, ...rel.split('/'))
        out.push({ path: rel, size: await fileSize(absPath), absPath })
      }
    }
    return out
  }

  private maybeEmitProgress(rec: DownloadRecord): void {
    const now = Date.now()
    if (rec.lastEmitAt !== undefined && now - rec.lastEmitAt < PROGRESS_MIN_MS) return
    rec.lastEmitAt = now
    this.sampleSpeed(rec, now)
    this.emit('progress', this.snapshot(rec))
  }

  private emitProgress(rec: DownloadRecord): void {
    rec.lastEmitAt = Date.now()
    this.sampleSpeed(rec, rec.lastEmitAt)
    this.emit('progress', this.snapshot(rec))
  }

  /** Smoothed bytes/s across the whole download. */
  private sampleSpeed(rec: DownloadRecord, now: number): void {
    const bytes = bytesDone(rec)
    if (rec.lastSampleAt === undefined) {
      rec.lastSampleAt = now
      rec.lastSampleBytes = bytes
      return
    }
    const dt = (now - rec.lastSampleAt) / 1000
    if (dt <= 0) return
    const instant = (bytes - rec.lastSampleBytes) / dt
    rec.speed = rec.speed === undefined ? instant : rec.speed * 0.7 + instant * 0.3
    rec.lastSampleAt = now
    rec.lastSampleBytes = bytes
  }

  private snapshot(rec: DownloadRecord): HfDownloadProgress {
    return {
      downloadId: rec.id,
      repo: rec.repo,
      state: rec.state,
      ...(rec.file !== undefined ? { file: rec.file } : {}),
      filesDone: rec.filesDone,
      filesTotal: rec.filesTotal,
      bytesDone: bytesDone(rec),
      bytesTotal: rec.bytesTotal,
      ...(rec.speed !== undefined ? { speed: rec.speed } : {}),
      ...(rec.error !== undefined ? { error: rec.error } : {}),
      ...(rec.catalogId !== undefined ? { catalogId: rec.catalogId } : {})
    }
  }

  private finish(rec: DownloadRecord): void {
    if (rec.finished) return
    rec.finished = true
    const snap = this.snapshot(rec)
    this.finishedList.push(snap)
    if (this.finishedList.length > 50) this.finishedList.splice(0, this.finishedList.length - 50)
    this.records.delete(rec.id)
    for (const resolve of rec.waiters) resolve(snap)
    this.emit('progress', snap)
  }
}

function bytesDone(rec: DownloadRecord): number {
  let n = rec.bytesBase
  for (const b of rec.inflight.values()) n += b
  return n
}

async function fileSize(p: string): Promise<number> {
  try {
    return (await fs.stat(p)).size
  } catch {
    return 0
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
