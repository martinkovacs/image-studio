// Drives the sd-server process: spawn, args, readiness polling, native API
// calls and progress parsing. Deliberately electron-free so it is unit-testable.
import { EventEmitter } from 'node:events'
import { spawn, type ChildProcess } from 'node:child_process'
import net from 'node:net'
import path from 'node:path'
import fs from 'node:fs/promises'
import process from 'node:process'
import type { LocalModelProfile, ServerStatus, SdCapabilities, SdImgGenBody } from '@shared/types'
import { FLAG_BY_ID } from '@shared/sdcppFlags'

// ---------------------------------------------------------------------------
// Flag building

/** Shell-like splitter: single/double quotes and backslash escapes. */
export function splitShellArgs(input: string): string[] {
  const tokens: string[] = []
  let cur = ''
  let curIsQuoted = false
  let inSingle = false
  let inDouble = false
  let escaped = false
  const push = () => {
    if (curIsQuoted || cur.length > 0) tokens.push(cur)
    cur = ''
    curIsQuoted = false
  }
  for (const ch of input) {
    if (escaped) {
      cur += ch
      escaped = false
      continue
    }
    if (ch === '\\' && !inSingle) {
      escaped = true
      continue
    }
    if (inSingle) {
      if (ch === "'") inSingle = false
      else cur += ch
      continue
    }
    if (inDouble) {
      if (ch === '"') inDouble = false
      else cur += ch
      continue
    }
    if (ch === "'") {
      inSingle = true
      curIsQuoted = true
      continue
    }
    if (ch === '"') {
      inDouble = true
      curIsQuoted = true
      continue
    }
    if (ch === ' ' || ch === '\t' || ch === '\n') {
      if (!inSingle && !inDouble) {
        push()
        continue
      }
    }
    cur += ch
  }
  if (inSingle || inDouble || escaped) throw new Error('unterminated quote or trailing backslash in extra args')
  push()
  return tokens
}

/**
 * Builds the sd-server argument vector for a launch profile + listen port.
 * Only known flag ids (see FLAG_BY_ID) are honored: bool true → `--<id>`;
 * bool false / '' / undefined → omitted; other values → `--<id> <value>`.
 */
export function buildServerArgs(profile: LocalModelProfile, port: number): string[] {
  const args: string[] = []
  for (const [id, value] of Object.entries(profile.args)) {
    if (!FLAG_BY_ID.has(id)) continue // unknown keys are silently ignored
    if (typeof value === 'boolean') {
      if (value) args.push(`--${id}`)
      continue
    }
    if (value === undefined || value === '') continue
    args.push(`--${id}`, String(value))
  }
  args.push('--listen-ip', '127.0.0.1', '--listen-port', String(port))
  if (profile.extraArgs?.trim()) args.push(...splitShellArgs(profile.extraArgs))
  return args
}

// ---------------------------------------------------------------------------
// Progress parsing
//
// sd.cpp prints progress on stdout with '\r' (no newline per frame):
//   "\r  |=====>    | 5/20 - 1.23s/it\033[K"
// Speed unit is "s/it|it/s" for sampling, "MB/s|GB/s" for byte progress
// (denoise/decode). See src/core/util.cpp, print_progress_line().

const PROGRESS_RE = /[|=>#\s]*(\d+)\/(\d+)\s+-\s+([0-9.]+\s?(?:s\/it|it\/s|[kmgt]?b\/s))[^0-9]*$/i

/** `\r  |=====>    | 5/20 - 1.23s/it` → {step:5, total:20, speed:'1.23s/it'} */
export function parseProgressLine(line: string): { step: number; total: number; speed?: string } | null {
  const m = PROGRESS_RE.exec(line)
  if (!m) return null
  return { step: Number(m[1]), total: Number(m[2]), ...(m[3] ? { speed: m[3] } : {}) }
}

/** Splits raw output into lines on \n and \r (progress bars use bare \r), stripping ANSI. */
export function splitOutputLines(chunk: string): string[] {
  return chunk
    .replace(/\x1b\[[0-9;]*K/g, '') // ANSI erase-to-end-of-line
    .split(/\r\n|\n|\r/)
}

// ---------------------------------------------------------------------------
// Server error surfaces

/** Reads a server error message verbatim from an error response body. */
async function extractErrorMessage(res: Response): Promise<Error> {
  const raw = await res.text().catch(() => '')
  let msg = raw
  try {
    const json = JSON.parse(raw) as {
      error?: { message?: string } | string
      message?: string
      detail?: { message?: string } | string
    }
    if (typeof json.error === 'object' && json.error?.message) msg = json.error.message
    else if (typeof json.error === 'string') msg = json.error
    else if (typeof json.detail === 'object') msg = json.detail.message ?? JSON.stringify(json.detail)
    else if (typeof json.detail === 'string') msg = json.detail
    else if (json.message) msg = json.message
  } catch {
    // not JSON: keep the raw body
  }
  const err = new Error(msg || `request failed with HTTP ${res.status}`)
  err.name = 'SdServerError'
  Object.assign(err, { status: res.status, body: raw })
  return err
}

interface JobJson {
  id?: string
  status?: string
  queue_position?: number
  result?: { output_format?: string; images?: { b64_json?: string }[] } | null
  error?: { message?: string } | null
}

function abortError(): Error {
  const e = new Error('image generation was cancelled')
  e.name = 'AbortError'
  return e
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.stat(p)
    return true
  } catch {
    return false
  }
}

function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: '127.0.0.1', port })
    const done = (free: boolean) => {
      socket.destroy()
      resolve(free)
    }
    socket.once('connect', () => done(false))
    socket.once('error', () => done(true))
  })
}

// ---------------------------------------------------------------------------
// SdServer

/** `--list-devices` via sd-cli (preferred) or sd-server. Never throws; [] on any failure. */
export function listDevices(serverPath: string): Promise<string[]> {
  return SdServer.listDevices(serverPath)
}

/** Maps sd.cpp log lines to coarse pipeline stages shown in the UI. */
export function parseStageLine(line: string): 'decoding' | 'hires' | 'sampling' | null {
  if (/decoding \d+ latents|tiled vae|vae_tiling/i.test(line)) return 'decoding'
  if (/hires fix: upscaling/i.test(line)) return 'hires'
  if (/generating image: \d+\/\d+/i.test(line)) return 'sampling'
  return null
}

export class SdServer extends EventEmitter {
  private child: ChildProcess | null = null
  private statusValue: ServerStatus = { state: 'stopped', profileId: null, port: null }
  private logBuffer: string[] = []
  private capsCache: SdCapabilities | null = null
  /** Model loading can take minutes; generations shouldn't hang forever. */
  private readyTimeoutMs = 15 * 60 * 1000

  status(): ServerStatus {
    return { ...this.statusValue }
  }

  /** Ring buffer of the last 2000 lines; consecutive progress lines collapse to the latest one. */
  logs(): string[] {
    return [...this.logBuffer]
  }

  private setStatus(state: ServerStatus['state'], error?: string): ServerStatus {
    this.statusValue = { ...this.statusValue, state, ...(error !== undefined ? { error } : {}) }
    if (state === 'stopped') this.statusValue = { state, profileId: null, port: null, ...(error !== undefined ? { error } : {}) }
    this.emit('status', { ...this.statusValue })
    return this.statusValue
  }

  private handleExit(message: string): void {
    const child = this.child
    this.child = null
    this.capsCache = null
    const last20 = this.logBuffer.slice(-20).join('\n')
    const error = `${message}\n--- last log lines ---\n${last20}`
    // Distinguish "crashed after we were ready" from "exited while starting".
    if (child !== null && this.statusValue.state === 'ready') {
      this.setStatus('error', error)
    } else if (this.statusValue.state === 'starting') {
      this.setStatus('error', error)
    }
  }

  private handleOutput = (buf: Buffer): void => {
    for (const raw of splitOutputLines(buf.toString('utf8'))) {
      const line = raw.trimEnd()
      if (!line) continue
      if (this.isProgressLine(line)) {
        // Collapse: a fresh progress line replaces the previous one.
        const last = this.logBuffer[this.logBuffer.length - 1]
        if (last !== undefined && this.isProgressLine(last)) this.logBuffer[this.logBuffer.length - 1] = line
        else this.logBuffer.push(line)
      } else {
        this.logBuffer.push(line)
      }
      if (this.logBuffer.length > 2000) this.logBuffer.splice(0, this.logBuffer.length - 2000)
      const prog = parseProgressLine(line)
      if (prog) this.emit('progress', prog)
      else {
        const stage = parseStageLine(line)
        if (stage) this.emit('stage', stage)
      }
      this.emit('log', line)
    }
  }

  private isProgressLine(line: string): boolean {
    return parseProgressLine(line) !== null
  }

  /**
   * Starts sd-server. Early return if already ready with the same profile.
   * Kills any running instance otherwise. Waits until GET
   * /sdcpp/v1/capabilities answers (model loading can take minutes).
   */
  async start(profile: LocalModelProfile, serverPath: string, port: number): Promise<ServerStatus> {
    if (this.statusValue.state === 'ready' && this.statusValue.profileId === profile.id) return this.status()
    // Concurrent callers for the same profile share one load instead of restarting it.
    if (this.inflight?.profileId === profile.id) return this.inflight.promise
    const promise = this.doStart(profile, serverPath, port).finally(() => {
      if (this.inflight?.promise === promise) this.inflight = null
    })
    this.inflight = { profileId: profile.id, promise }
    return promise
  }

  private inflight: { profileId: string; promise: Promise<ServerStatus> } | null = null

  private async doStart(profile: LocalModelProfile, serverPath: string, port: number): Promise<ServerStatus> {
    if (this.statusValue.state !== 'stopped') await this.stop()

    if (!(await fileExists(serverPath))) return this.setStatus('error', `sd-server not found at ${serverPath}`)
    this.logBuffer.length = 0

    // Pick a free port: walk upward from the requested one if busy.
    let chosen = port
    for (let i = 0; i < 200; i++) {
      if (await isPortFree(chosen)) break
      chosen++
    }
    if (chosen !== port) this.pushPlainLog(`port ${port} is busy, using ${chosen} instead`)
    this.statusValue = { state: 'starting', profileId: profile.id, port: chosen }
    this.emit('status', { ...this.statusValue })

    const binDir = path.dirname(serverPath)
    const env: NodeJS.ProcessEnv = { ...process.env }
    const sep = process.platform === 'win32' ? ';' : ':'
    // Freshly extracted builds keep shared libs next to the binary; make sure
    // the loader finds them (linux mac vulkan / rocm, and cuda-source builds).
    env.LD_LIBRARY_PATH = [binDir, env.LD_LIBRARY_PATH].filter(Boolean).join(':')
    env.PATH = [binDir, env.PATH].filter(Boolean).join(sep)

    let child: ChildProcess
    try {
      child = spawn(serverPath, buildServerArgs(profile, chosen), {
        cwd: binDir,
        env,
        stdio: ['ignore', 'pipe', 'pipe']
      })
    } catch (err) {
      return this.setStatus('error', `failed to spawn sd-server: ${String(err)}`)
    }
    this.child = child
    child.stdout?.on('data', this.handleOutput)
    child.stderr?.on('data', this.handleOutput)
    child.once('error', (err) => this.handleExit(`failed to start sd-server: ${err.message}`))
    child.once('close', (code, signal) => {
      if (this.statusValue.state === 'ready') {
        this.handleExit(`sd-server crashed (exit code ${code ?? 'unknown'}${signal ? `, signal ${signal}` : ''})`)
      } else if (this.statusValue.state === 'starting') {
        const last20 = this.logBuffer.slice(-20).join('\n')
        this.setStatus('error', `sd-server exited while starting (code ${code ?? 'unknown'}${signal ? `, signal ${signal}` : ''})\nlast log:\n${last20}`)
      }
    })

    const ready = await this.waitReady(chosen)
    if (!ready) return this.status()
    this.capsCache = null
    this.setStatus('ready')
    return this.status()
  }

  private pushPlainLog(line: string): void {
    this.logBuffer.push(line)
    if (this.logBuffer.length > 2000) this.logBuffer.splice(0, this.logBuffer.length - 2000)
    this.emit('log', line)
  }

  private async waitReady(port: number): Promise<boolean> {
    const startedAt = Date.now()
    const capsUrl = `http://127.0.0.1:${port}/sdcpp/v1/capabilities`
    while (Date.now() - startedAt < this.readyTimeoutMs) {
      if (this.child === null) return false // already dead
      try {
        const res = await fetch(capsUrl, { signal: AbortSignal.timeout(3000) })
        if (res.ok) return true
      } catch {
        // not ready yet (model still loading); keep polling
      }
      await new Promise((r) => setTimeout(r, 500))
    }
    this.handleExit(`timed out after ${Math.round(this.readyTimeoutMs / 1000)}s waiting for /sdcpp/v1/capabilities on port ${port}`)
    return false
  }

  /** SIGTERM, then SIGKILL after 5s. */
  async stop(): Promise<ServerStatus> {
    const child = this.child
    this.child = null
    this.capsCache = null
    if (child) {
      await new Promise<void>((resolve) => {
        const killer = setTimeout(() => {
          try {
            child.kill('SIGKILL')
          } catch {
            /* already dead */
          }
        }, 5000)
        child.once('close', () => {
          clearTimeout(killer)
          resolve()
        })
        try {
          child.kill('SIGTERM')
        } catch {
          clearTimeout(killer)
          resolve()
        }
      })
    }
    this.statusValue = { state: 'stopped', profileId: null, port: null }
    this.emit('status', { ...this.statusValue })
    return this.status()
  }

  /** Server capabilities, cached for the lifetime of the started process. */
  async capabilities(): Promise<SdCapabilities | null> {
    if (this.statusValue.port === null) return null
    if (this.capsCache) return this.capsCache
    try {
      const res = await fetch(`http://127.0.0.1:${this.statusValue.port}/sdcpp/v1/capabilities`, { signal: AbortSignal.timeout(5000) })
      if (!res.ok) return null
      const body = (await res.json()) as SdCapabilities
      this.capsCache = body
      return body
    } catch {
      return null
    }
  }

  /** Runs one native img_gen job. Aborts are translated to `AbortError`. */
  async imgGen(
    body: SdImgGenBody,
    opts: { signal?: AbortSignal; onQueued?: (pos: number) => void } = {}
  ): Promise<{ format: string; images: Buffer[] }> {
    const port = this.statusValue.port
    if (port === null) throw new Error('sd-server is not running')
    const signal = opts.signal
    const jobIdRef: { current: string | null } = { current: null }
    const aborts = signal ? new AbortRace(signal, () => {
      if (jobIdRef.current) void cancelJob(port, jobIdRef.current)
    }) : { promise: null as Promise<never> | null, dispose: () => {} }
    try {
      const res = await raceWithAbort(
        fetch(`http://127.0.0.1:${port}/sdcpp/v1/img_gen`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(15_000)
        }),
        aborts
      )
      if (!res.ok) throw await extractErrorMessage(res)
      const submitted = (await res.json()) as { id?: string }
      const jobId = submitted.id
      if (!jobId) throw new Error('sd-server accepted the job but returned no job id')
      jobIdRef.current = jobId

      while (true) {
        const r = await raceWithAbort(
          fetchJsonOrNull(`http://127.0.0.1:${port}/sdcpp/v1/jobs/${jobId}`, 10_000),
          aborts
        )
        if (r.status === 404 || r.status === 410) throw new Error(`generation job ${jobId} is gone from the server (HTTP ${r.status})`)
        if (!r.ok) throw await r.errorMessage()
        const job = r.json as JobJson
        const status = job.status ?? 'unknown'
        if (typeof job.queue_position === 'number' && opts.onQueued) opts.onQueued(job.queue_position)
        if (status === 'queued' || status === 'generating') {
          await sleep(400)
          continue
        }
        if (status === 'completed') {
          const result = job.result
          if (!result) throw new Error('sd-server reported the job as completed but returned no result')
          return {
            format: result.output_format ?? 'png',
            images: (result.images ?? []).map((im) => Buffer.from(im.b64_json ?? '', 'base64'))
          }
        }
        if (status === 'cancelled') throw abortError()
        // failed / unknown
        throw new Error(job.error?.message ?? `generation job ended with status "${status}"`)
      }
    } finally {
      aborts.dispose()
    }
  }

  /** Runs an ESRGAN upscale (synchronous server endpoint). */
  async upscale(body: {
    image: string
    upscaler?: string
    repeats?: number
    tile_size?: number
    output_format?: string
  }): Promise<{ image: Buffer; format: string; width: number; height: number; upscaler: string }> {
    const port = this.statusValue.port
    if (port === null) throw new Error('sd-server is not running')
    const res = await fetch(`http://127.0.0.1:${port}/sdcpp/v1/upscale`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10 * 60 * 1000)
    })
    if (!res.ok) throw await extractErrorMessage(res)
    const json = (await res.json()) as {
      images?: { b64_json?: string }[]
      upscaler?: string
      width?: number
      height?: number
      output_format?: string
    }
    const first = json.images?.[0]
    if (!first) throw new Error('upscaler returned no image')
    return {
      image: Buffer.from(first.b64_json ?? '', 'base64'),
      format: json.output_format ?? 'png',
      width: json.width ?? 0,
      height: json.height ?? 0,
      upscaler: json.upscaler ?? ''
    }
  }

  /** `--list-devices` via sd-cli (preferred) or sd-server. Never throws; [] on any failure. */
  static async listDevices(serverPath: string): Promise<string[]> {
    const dir = path.dirname(serverPath)
    const base = path.basename(serverPath)
    const cli = base.startsWith('sd-server') ? path.join(dir, process.platform === 'win32' ? 'sd-cli.exe' : 'sd-cli') : serverPath
    for (const bin of [cli, serverPath]) {
      if (!bin || !(await fileExists(bin))) continue
      const lines = await SdServer.runListDevices(bin, dir)
      if (lines.length > 0) return lines
    }
    return []
  }

  private static runListDevices(bin: string, cwd: string): Promise<string[]> {
    return new Promise((resolve) => {
      try {
        const child = spawn(bin, ['--list-devices'], { cwd })
        let out = ''
        const killer = setTimeout(() => child.kill('SIGKILL'), 15_000)
        child.stdout?.on('data', (b: Buffer) => (out += b.toString('utf8')))
        child.stderr?.on('data', (b: Buffer) => (out += b.toString('utf8')))
        child.once('close', (code) => {
          clearTimeout(killer)
          if (code !== 0 && code !== null) return resolve([])
          resolve(
            out
              .split(/\r\n|\n|\r/)
              .map((l) => l.trim())
              .filter(Boolean)
          )
        })
        child.once('error', () => {
          clearTimeout(killer)
          resolve([])
        })
      } catch {
        resolve([])
      }
    })
  }
}

// ---------------------------------------------------------------------------
// small fetch helpers

interface PollResult {
  status: number
  json: unknown
  ok: boolean
  // Reads the (error) body text without clobbering the JSON one already parsed.
  errorMessage: () => Promise<Error>
}

/** GET that records the status; the response body is captured even on failure. */
async function fetchJsonOrNull(requestUrl: string, timeoutMs: number): Promise<PollResult> {
  let res: Response
  try {
    res = await fetch(requestUrl, { signal: AbortSignal.timeout(timeoutMs) })
  } catch (err) {
    const err2 = new Error(`failed to reach sd-server: ${err instanceof Error ? err.message : String(err)}`)
    err2.name = 'NetworkError'
    Object.assign(err2, { status: 0 })
    throw err2
  }
  const text = await res.text().catch(() => '')
  let json: unknown = null
  let parsed = false
  try {
    json = text ? JSON.parse(text) : null
    parsed = true
  } catch {
    // non-JSON body; fall back to the raw text
  }
  const status = res.status
  const ok = res.ok
  return {
    status,
    json: parsed ? json : null,
    ok,
    errorMessage: async () =>
      extractErrorMessage(
        new Response(text, { status, statusText: res.statusText, headers: res.headers })
      )
  }
}

function raceWithAbort<T>(p: Promise<T>, abort: { promise: Promise<never> | null }): Promise<T> {
  if (!abort.promise) return p
  return Promise.race([p, abort.promise])
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/**
 * Wraps an AbortSignal into a pending never-resolving promise so callers can
 * `Promise.race` any computation against cancellation.
 */
class AbortRace {
  private rejectFn: ((reason: Error) => void) | null = null
  private readonly signal: AbortSignal
  readonly promise: Promise<never> | null
  listener?: () => void

  constructor(signal: AbortSignal, onAbort?: () => void) {
    this.signal = signal
    this.promise = new Promise<never>((_, reject) => {
      this.rejectFn = (reason: Error) => reject(reason)
      this.listener = () => {
        try {
          onAbort?.()
        } catch {
          /* best effort */
        }
        this.rejectFn?.(abortError())
      }
      if (signal.aborted) this.listener()
      else signal.addEventListener('abort', this.listener, { once: true })
    })
  }

  dispose(): void {
    if (this.listener) this.signal.removeEventListener('abort', this.listener)
  }
}

/** Runs POST /sdcpp/v1/jobs/{id}/cancel; resolves regardless of errors. */
async function cancelJob(port: number, jobId: string): Promise<void> {
  try {
    await fetch(`http://127.0.0.1:${port}/sdcpp/v1/jobs/${jobId}/cancel`, { method: 'POST', signal: AbortSignal.timeout(5000) })
  } catch {
    // best effort; the caller already abandoned the job
  }
}
