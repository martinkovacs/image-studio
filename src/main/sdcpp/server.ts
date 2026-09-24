// Drives the sd-server process: spawn, args, readiness polling, native API
// calls and progress parsing. Deliberately electron-free so it is unit-testable.
import { EventEmitter } from 'node:events'
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'
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
  const push = () => {
    if (curIsQuoted || cur.length > 0) tokens.push(cur)
    cur = ''
    curIsQuoted = false
  }
  const chars = [...input]
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i]
    if (inSingle) {
      // Everything is literal inside single quotes; only the quote itself acts.
      if (ch === "'") inSingle = false
      else cur += ch
      continue
    }
    if (ch === '\\') {
      const next = chars[i + 1]
      if (inDouble) {
        // Inside double quotes a backslash only escapes `"` or `\`; otherwise both
        // the backslash and the next character are literal.
        if (next === '"' || next === '\\') {
          cur += next
          i++
          continue
        }
        cur += ch
        continue
      }
      // Outside quotes a backslash only escapes a quote, backslash or whitespace;
      // anything else stays literal (so `C:\models\a.gguf` survives untouched).
      const escapable = next === '"' || next === "'" || next === '\\' || next === ' ' || next === '\t' || next === '\n' || next === '\r'
      if (next !== undefined && escapable) {
        cur += next
        if (next === '"' || next === "'") curIsQuoted = true
        i++
        continue
      }
      cur += ch
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
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      push()
      continue
    }
    cur += ch
  }
  if (inSingle || inDouble) throw new Error('unterminated quote in extra args')
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
  if (profile.extraArgs?.trim()) args.push(...splitShellArgs(profile.extraArgs))
  // Last so extra args can't move the server off the loopback port we poll.
  args.push('--listen-ip', '127.0.0.1', '--listen-port', String(port))
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

/**
 * Per-stream line assembler. stdout/stderr chunks can split a `\r`-terminated
 * progress frame or a multi-byte UTF-8 sequence: `push` decodes progressively
 * (node:string_decoder) and only returns lines terminated by \r or \n, keeping
 * the trailing incomplete segment for the next chunk. Call `end()` on stream
 * close to flush what is left.
 */
export class OutputLineSplitter {
  private readonly decoder = new StringDecoder('utf8')
  private carry = ''

  /** Feeds one raw chunk; returns the complete lines it revealed. */
  push(chunk: Buffer): string[] {
    const text = this.carry + this.decoder.write(chunk)
    this.carry = ''
    let lastBreak = -1
    for (let i = text.length - 1; i >= 0; i--) {
      const c = text.charCodeAt(i)
      if (c === 10 || c === 13) {
        lastBreak = i
        break
      }
    }
    if (lastBreak === -1) {
      this.carry = text
      return []
    }
    this.carry = text.slice(lastBreak + 1)
    return splitOutputLines(text.slice(0, lastBreak + 1)).filter((l) => l !== '')
  }

  /** Flushes the trailing partial line; call once when the stream closes. */
  end(): string[] {
    const text = this.carry + this.decoder.end()
    this.carry = ''
    if (text === '') return []
    return splitOutputLines(text).filter((l) => l !== '')
  }
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

function abortError(message = 'image generation was cancelled'): Error {
  const e = new Error(message)
  e.name = 'AbortError'
  return e
}

/** AbortError carrying whether the native server actually interrupted the job. */
export interface SdAbortError extends Error {
  interrupted: boolean
}

function sdAbortError(interrupted: boolean): SdAbortError {
  const e = new Error(interrupted ? 'image generation was cancelled' : 'image generation could not be interrupted (job already generating)') as SdAbortError
  e.name = 'AbortError'
  e.interrupted = interrupted
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

/**
 * Sends SIGTERM to a child process and resolves once it actually exited
 * (SIGKILL after 5s as a fallback). Settles immediately for dead processes.
 */
function killChild(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve()
    let settled = false
    const done = () => {
      if (settled) return
      settled = true
      clearTimeout(killer)
      resolve()
    }
    const killer = setTimeout(() => {
      try {
        child.kill('SIGKILL')
      } catch {
        /* already dead */
      }
    }, 5000)
    child.once('close', done)
    child.once('error', done)
    try {
      child.kill('SIGTERM')
    } catch {
      done()
    }
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

export type SpawnImpl = (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess

/** Testability hooks for SdServer (everything else behaves exactly as shipped). */
export interface SdServerOptions {
  /** Process spawner; defaults to node:child_process.spawn. */
  spawnImpl?: SpawnImpl
  /** How long waitReady keeps polling /sdcpp/v1/capabilities. */
  readyTimeoutMs?: number
  /** Port availability probe; defaults to a TCP connect attempt against 127.0.0.1. */
  portProbeImpl?: (port: number) => Promise<boolean>
}

/**
 * Resolve/reject with `promise`, or reject with AbortError when `signal` aborts
 * first (calling `onAbort`). The listener is removed once settled, so aborting
 * the same signal later (e.g. to cancel a generation) has no effect here.
 */
function withCallerSignal<T>(promise: Promise<T>, signal: AbortSignal | undefined, onAbort: () => void): Promise<T> {
  if (!signal) return promise
  return new Promise<T>((resolve, reject) => {
    let done = false
    const abort = (): void => {
      if (done) return
      done = true
      onAbort()
      reject(abortError('start was aborted'))
    }
    signal.addEventListener('abort', abort, { once: true })
    promise.then(
      (v) => {
        if (done) return
        done = true
        signal.removeEventListener('abort', abort)
        resolve(v)
      },
      (e) => {
        if (done) return
        done = true
        signal.removeEventListener('abort', abort)
        reject(e)
      }
    )
  })
}

export class SdServer extends EventEmitter {
  private child: ChildProcess | null = null
  private statusValue: ServerStatus = { state: 'stopped', profileId: null, port: null }
  private logBuffer: string[] = []
  private capsCache: SdCapabilities | null = null
  /** Model loading can take minutes; generations shouldn't hang forever. */
  private readyTimeoutMs = 15 * 60 * 1000
  /** Monotonic generation counter; start() and stop() both bump it. */
  private epoch = 0
  /** Every start/stop runs serialized through this single chain. */
  private queueTail: Promise<unknown> = Promise.resolve()
  private inflight: { profileId: string; promise: Promise<ServerStatus> } | null = null
  private stdoutLines = new OutputLineSplitter()
  private stderrLines = new OutputLineSplitter()
  /** Epoch that last wrote the visible status; aborted starts only reset it while they own it. */
  private statusEpoch = -1
  private readonly spawnImpl: SpawnImpl
  private readonly portProbeImpl: (port: number) => Promise<boolean>

  constructor(opts: SdServerOptions = {}) {
    super()
    this.spawnImpl = opts.spawnImpl ?? spawn
    this.portProbeImpl = opts.portProbeImpl ?? isPortFree
    if (opts.readyTimeoutMs !== undefined) this.readyTimeoutMs = opts.readyTimeoutMs
  }

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
    this.statusEpoch = this.epoch
    this.emit('status', { ...this.statusValue })
    return this.statusValue
  }

  private async waitExit(child: ChildProcess): Promise<void> {
    await killChild(child)
  }

  private async doStop(): Promise<ServerStatus> {
    const child = this.child
    this.child = null
    this.capsCache = null
    if (child) await this.waitExit(child)
    this.statusValue = { state: 'stopped', profileId: null, port: null }
    this.statusEpoch = this.epoch
    this.emit('status', { ...this.statusValue })
    return this.status()
  }

  /** Bumps the epoch (invalidating any in-flight start) and queues the actual stop. */
  private requestStop(): Promise<ServerStatus> {
    this.epoch++
    // A pending stop supersedes any in-flight start: later callers must not join it.
    this.inflight = null
    return this.enqueue(() => this.doStop())
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queueTail.then(fn, fn)
    this.queueTail = run.then(
      () => undefined,
      () => undefined
    )
    return run
  }

  private handleOutput = (lines: OutputLineSplitter, buf: Buffer): void => {
    this.ingestLines(lines.push(buf))
  }

  private ingestLines(lines: string[]): void {
    for (const raw of lines) {
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
   * Concurrent callers for the same profile share one load instead of
   * restarting it. All starts (and stops) are serialized through a single
   * queue; starting a different profile aborts an in-flight one via the epoch
   * counter. Waits until GET /sdcpp/v1/capabilities answers (model loading can
   * take minutes). Aborting the signal behaves like stop(): the spawned
   * process is killed, the state ends on 'stopped' and start() rejects with
   * an 'AbortError'.
   */
  async start(
    profile: LocalModelProfile,
    serverPath: string,
    port: number,
    opts: { signal?: AbortSignal } = {}
  ): Promise<ServerStatus> {
    if (opts.signal?.aborted) throw abortError('start was aborted')
    // "Already ready" only counts while no stop/start has been requested since
    // that status was published (statusEpoch === epoch).
    const settled = this.statusEpoch === this.epoch
    if (settled && this.statusValue.state === 'ready' && this.statusValue.profileId === profile.id) return this.status()
    if (this.inflight?.profileId === profile.id) {
      // Joining someone else's load: our abort only detaches us, it must not stop theirs.
      return withCallerSignal(this.inflight.promise, opts.signal, () => {})
    }
    // Capture the epoch now: if a stop/start supersedes this call while it is
    // still queued, doStart sees the mismatch and never spawns.
    const epoch = ++this.epoch
    const promise = this.enqueue(() => this.doStart(profile, serverPath, port, epoch))
    this.inflight = { profileId: profile.id, promise }
    promise.catch(() => {}) // cleanup runs even when nobody listens
    void promise.finally(() => {
      if (this.inflight?.promise === promise) this.inflight = null
    })
    // Owner abort behaves like stop() — but only while this start is still current.
    return withCallerSignal(promise, opts.signal, () => {
      if (this.epoch === epoch) void this.requestStop()
    })
  }

  /** Stops the running instance; wins over any in-flight start. */
  async stop(): Promise<ServerStatus> {
    return this.requestStop()
  }

  private abortedStartStatus(epoch: number): ServerStatus {
    // Only reset the visible status while it still describes this (aborted) start.
    if (this.statusEpoch === epoch) {
      this.statusValue = { state: 'stopped', profileId: null, port: null }
      this.statusEpoch = epoch
      this.emit('status', { ...this.statusValue })
    }
    return this.status()
  }

  private async doStart(profile: LocalModelProfile, serverPath: string, port: number, epoch: number): Promise<ServerStatus> {
    const aborted = (): boolean => this.epoch !== epoch
    // Superseded while queued: the newer operation owns the process and status.
    if (aborted()) return this.status()

    // Tear down whatever instance is running before touching anything else.
    const existing = this.child
    if (existing) {
      this.child = null
      this.capsCache = null
      await killChild(existing)
    }
    if (aborted()) return this.abortedStartStatus(epoch)

    if (!(await fileExists(serverPath))) return this.setStatus('error', `sd-server not found at ${serverPath}`)
    if (aborted()) return this.abortedStartStatus(epoch)
    this.logBuffer.length = 0
    this.stdoutLines = new OutputLineSplitter()
    this.stderrLines = new OutputLineSplitter()

    // Pick a free port: walk upward from the requested one if busy.
    let chosen = -1
    for (let p = port; p < port + 200; p++) {
      if (await this.portProbeImpl(p)) {
        chosen = p
        break
      }
      if (aborted()) return this.abortedStartStatus(epoch)
    }
    if (chosen === -1) {
      return this.setStatus('error', `sd-server could not start: no free port found (probed ${port}–${port + 199}, all busy)`)
    }
    if (aborted()) return this.abortedStartStatus(epoch)
    if (chosen !== port) this.pushPlainLog(`port ${port} is busy, using ${chosen} instead`)
    this.statusValue = { state: 'starting', profileId: profile.id, port: chosen }
    this.statusEpoch = epoch
    this.emit('status', { ...this.statusValue })
    if (aborted()) return this.abortedStartStatus(epoch)

    const binDir = path.dirname(serverPath)
    const env: NodeJS.ProcessEnv = { ...process.env }
    const sep = process.platform === 'win32' ? ';' : ':'
    // Freshly extracted builds keep shared libs next to the binary; make sure
    // the loader finds them (linux mac vulkan / rocm, and cuda-source builds).
    env.LD_LIBRARY_PATH = [binDir, env.LD_LIBRARY_PATH].filter(Boolean).join(':')
    env.PATH = [binDir, env.PATH].filter(Boolean).join(sep)

    let child: ChildProcess
    try {
      child = this.spawnImpl(serverPath, buildServerArgs(profile, chosen), {
        cwd: binDir,
        env,
        stdio: ['ignore', 'pipe', 'pipe']
      })
    } catch (err) {
      return this.setStatus('error', `failed to spawn sd-server: ${String(err)}`)
    }
    this.child = child
    this.attachChildPipes(child, epoch)
    this.attachExitHandlers(child, epoch)

    if (aborted()) {
      // We spawned anyway (the epoch changed between checks): kill what we spawned.
      await this.waitExit(child)
      return this.abortedStartStatus(epoch)
    }

    const ready = await this.waitReady(chosen, epoch, child)
    if (!ready) return this.status()

    this.capsCache = null
    this.setStatus('ready')
    return this.status()
  }

  /** Output handlers must only act while their child is still the live one. */
  private attachChildPipes(child: ChildProcess, epoch: number): void {
    const out = this.stdoutLines
    const err = this.stderrLines
    // Output of a superseded instance must not leak into the next one's log.
    const current = (): boolean => this.epoch === epoch
    child.stdout?.on('data', (b: Buffer) => current() && this.handleOutput(out, b))
    child.stderr?.on('data', (b: Buffer) => current() && this.handleOutput(err, b))
    child.once('close', () => {
      if (!current()) return
      // Flush any trailing partial line the child left without a terminator.
      this.ingestLines(out.end())
      this.ingestLines(err.end())
    })
  }

  private attachExitHandlers(child: ChildProcess, epoch: number): void {
    const aborted = (): boolean => this.epoch !== epoch
    child.once('error', (err) => {
      if (this.child === child) this.child = null
      if (aborted()) return // intentional stop/replace: the stopping side owns the status
      const last20 = this.logBuffer.slice(-20).join('\n')
      if (this.statusValue.state === 'starting' || this.statusValue.state === 'ready') {
        this.setStatus('error', `failed to start sd-server: ${err.message}\n--- last log lines ---\n${last20}`)
      }
    })
    child.once('close', (code, signal) => {
      if (this.child === child) this.child = null
      if (aborted()) return
      const detail = `(code ${code ?? 'unknown'}${signal ? `, signal ${signal}` : ''})`
      if (this.statusValue.state === 'ready') {
        this.setStatus('error', `sd-server crashed ${detail}\n--- last log lines ---\n${this.logBuffer.slice(-20).join('\n')}`)
      } else if (this.statusValue.state === 'starting') {
        this.setStatus('error', `sd-server exited while starting ${detail}\nlast log:\n${this.logBuffer.slice(-20).join('\n')}`)
      }
    })
  }

  private pushPlainLog(line: string): void {
    this.logBuffer.push(line)
    if (this.logBuffer.length > 2000) this.logBuffer.splice(0, this.logBuffer.length - 2000)
    this.emit('log', line)
  }

  /**
   * Polls GET /sdcpp/v1/capabilities until it answers, the child dies, the
   * epoch changes (someone stopped/replaced this start) or the timeout fires.
   */
  private async waitReady(port: number, epoch: number, child: ChildProcess): Promise<boolean> {
    const startedAt = Date.now()
    const capsUrl = `http://127.0.0.1:${port}/sdcpp/v1/capabilities`
    while (Date.now() - startedAt < this.readyTimeoutMs) {
      if (this.epoch !== epoch || this.child !== child) return false
      try {
        const res = await fetch(capsUrl, { signal: AbortSignal.timeout(3000) })
        if (res.ok) return true
      } catch {
        // not ready yet (model still loading); keep polling
      }
      if (this.epoch !== epoch || this.child !== child) return false
      await new Promise((r) => setTimeout(r, 500))
    }
    if (this.epoch !== epoch || this.child !== child) return false
    this.setStatus('error', `timed out after ${Math.round(this.readyTimeoutMs / 1000)}s waiting for /sdcpp/v1/capabilities on port ${port}`)
    // Don't leak the process we timed out on.
    if (this.child === child) this.child = null
    await this.waitExit(child)
    return false
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

  /**
   * Runs one native img_gen job. On abort: POST /cancel for the job
   * ("remember it and cancel as soon as the job id is known"), then reject with
   * an SdAbortError — `interrupted: true` when the server cancelled the queued
   * job (HTTP 200), `interrupted: false` when the job is already generating and
   * the server answered 409 "cannot be interrupted yet".
   */
  async imgGen(
    body: SdImgGenBody,
    opts: { signal?: AbortSignal; onQueued?: (pos: number) => void; onState?: (state: 'queued' | 'generating') => void } = {}
  ): Promise<{ format: string; images: Buffer[] }> {
    const port = this.statusValue.port
    if (port === null) throw new Error('sd-server is not running')
    const signal = opts.signal
    let jobId: string | null = null
    let aborted = false
    let interrupted: boolean | null = null
    let rejectAbort: ((e: SdAbortError) => void) | null = null
    const abortPromise = new Promise<never>((_, reject) => {
      rejectAbort = reject as (e: SdAbortError) => void
    })
    abortPromise.catch(() => {}) // stays unhandled-safe when nobody races it
    const abortErr = (): SdAbortError => sdAbortError(interrupted ?? true)
    const cancel = async (): Promise<void> => {
      if (jobId === null || interrupted !== null) return
      interrupted = await cancelJob(port, jobId)
      rejectAborted()
    }
    const rejectAborted = (): void => {
      if (rejectAbort) rejectAbort(abortErr())
    }
    const onAbortSignal = (): void => {
      aborted = true
      void cancel()
    }
    if (signal) {
      if (signal.aborted) onAbortSignal()
      else signal.addEventListener('abort', onAbortSignal, { once: true })
    }
    const raceAbort = <T>(p: Promise<T>): Promise<T> => (signal ? Promise.race([p, abortPromise]) : p)
    try {
      // Submit. Aborts before the submit response are only flagged: the job id
      // is needed to cancel, so the submit fetch runs to completion.
      const submitPromise = (async () => {
        const res = await fetch(`http://127.0.0.1:${port}/sdcpp/v1/img_gen`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(15_000)
        })
        if (!res.ok) throw await extractErrorMessage(res)
        const submitted = (await res.json()) as { id?: string }
        const id = submitted.id
        if (!id) throw new Error('sd-server accepted the job but returned no job id')
        jobId = id
        if (aborted) void cancel()
        return id
      })()
      const id = await raceAbort(submitPromise)

      let lastState: 'queued' | 'generating' | null = null
      while (true) {
        const r = await raceAbort(fetchJsonOrNull(`http://127.0.0.1:${port}/sdcpp/v1/jobs/${id}`, 10_000))
        if (r.status === 404 || r.status === 410) throw new Error(`generation job ${id} is gone from the server (HTTP ${r.status})`)
        if (!r.ok) throw await r.errorMessage()
        const job = r.json as JobJson
        const status = job.status ?? 'unknown'
        if (typeof job.queue_position === 'number' && opts.onQueued) opts.onQueued(job.queue_position)
        if ((status === 'queued' || status === 'generating') && status !== lastState) {
          lastState = status
          opts.onState?.(status)
        }
        if (status === 'queued' || status === 'generating') {
          if (aborted && interrupted !== null) throw abortErr() // cancel already settled
          await sleep(400)
          continue
        }
        if (status === 'completed') {
          if (aborted) throw abortErr()
          const result = job.result
          if (!result) throw new Error('sd-server reported the job as completed but returned no result')
          return {
            format: result.output_format ?? 'png',
            images: (result.images ?? []).map((im) => Buffer.from(im.b64_json ?? '', 'base64'))
          }
        }
        if (status === 'cancelled') throw sdAbortError(interrupted ?? true)
        // failed / unknown
        throw new Error(job.error?.message ?? `generation job ended with status "${status}"`)
      }
    } finally {
      if (signal) signal.removeEventListener('abort', onAbortSignal)
    }
  }

  /** Runs an ESRGAN upscale (synchronous server endpoint). */
  async upscale(
    body: {
      image: string
      upscaler?: string
      repeats?: number
      tile_size?: number
      output_format?: string
    },
    opts: { signal?: AbortSignal } = {}
  ): Promise<{ image: Buffer; format: string; width: number; height: number; upscaler: string }> {
    const port = this.statusValue.port
    if (port === null) throw new Error('sd-server is not running')
    const signal = opts.signal
    let res: Response
    try {
      res = await fetch(`http://127.0.0.1:${port}/sdcpp/v1/upscale`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10 * 60 * 1000)]) : AbortSignal.timeout(10 * 60 * 1000)
      })
    } catch (err) {
      if (signal?.aborted) throw abortError('upscale was cancelled')
      throw err
    }
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

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/**
 * POST /sdcpp/v1/jobs/{id}/cancel. Returns true when the job actually left the
 * pipeline (2xx, or 404/410 — gone either way), false only for the HTTP 409
 * "job is currently generating and cannot be interrupted yet" answer of the
 * native server (see routes_sdcpp.cpp).
 */
async function cancelJob(port: number, jobId: string): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/sdcpp/v1/jobs/${jobId}/cancel`, {
      method: 'POST',
      signal: AbortSignal.timeout(5000)
    })
    if (res.ok) return true
    if (res.status === 409) {
      const raw = await res.text().catch(() => '')
      // A 409 with "job queue state changed..." means the job left the queue on its own.
      return !/cannot be interrupted/i.test(raw)
    }
    return true // 404 / 410: the job is gone, nothing keeps generating
  } catch {
    return true // best effort; the caller already abandoned the job
  }
}
