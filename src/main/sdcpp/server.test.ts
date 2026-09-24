import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import net from 'node:net'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { SdImgGenBody } from '@shared/types'
import {
  OutputLineSplitter,
  SdServer,
  buildServerArgs,
  parseProgressLine,
  splitOutputLines,
  splitShellArgs,
  type SpawnImpl
} from './server'
import type { LocalModelProfile, ServerStatus } from '@shared/types'

describe('splitShellArgs', () => {
  it('splits on whitespace', () => {
    expect(splitShellArgs('--fa  --rng cpu')).toEqual(['--fa', '--rng', 'cpu'])
  })
  it('keeps double-quoted tokens together', () => {
    expect(splitShellArgs('--tokenizer "a b"')).toEqual(['--tokenizer', 'a b'])
  })
  it('keeps single-quoted tokens together', () => {
    expect(splitShellArgs("--tokenizer 'Qwen 3'")).toEqual(['--tokenizer', 'Qwen 3'])
  })
  it('supports backslash escapes', () => {
    expect(splitShellArgs('c\\ d e')).toEqual(['c d', 'e'])
  })
  it('treats backslashes inside single quotes literally', () => {
    expect(splitShellArgs("a'\\d'b")).toEqual(['a\\db'])
  })
  it('produces an empty token for explicit empty quotes', () => {
    expect(splitShellArgs('--rng "" --type ""')).toEqual(['--rng', '', '--type', ''])
  })
})

describe('splitShellArgs — backslash rules (Windows paths must survive)', () => {
  it('keeps unquoted Windows paths intact: backslash only escapes quote/backslash/whitespace', () => {
    expect(splitShellArgs('--model C:\\models\\a.gguf')).toEqual(['--model', 'C:\\models\\a.gguf'])
  })
  it('keeps quoted Windows paths intact', () => {
    expect(splitShellArgs('--model "C:\\models\\a b.gguf"')).toEqual(['--model', 'C:\\models\\a b.gguf'])
  })
  it('a trailing backslash survives when it is escaped as \\\\', () => {
    expect(splitShellArgs('"C:\\models\\\\"')).toEqual(['C:\\models\\'])
  })
  it('escapes a quote outside quotes into a literal', () => {
    expect(splitShellArgs('a\\"b c')).toEqual(['a"b', 'c'])
  })
  it('outside quotes, \\\\ collapses to a single backslash', () => {
    expect(splitShellArgs('C:\\\\models')).toEqual(['C:\\models'])
  })
  it('inside double quotes, a backslash before a letter stays literal', () => {
    expect(splitShellArgs('"C:\\f\\g"')).toEqual(['C:\\f\\g'])
  })
  it('inside double quotes, \\\\ still escapes backslash and quote only', () => {
    expect(splitShellArgs('"a\\\\" b')).toEqual(['a\\', 'b'])
    expect(splitShellArgs('"a\\""')).toEqual(['a"'])
  })
  it('backslash-space keeps tokens going (escape does not end a token)', () => {
    expect(splitShellArgs('a\\ b\\ c')).toEqual(['a b c'])
  })
  it('a trailing backslash is literal', () => {
    expect(splitShellArgs('abc\\')).toEqual(['abc\\'])
  })
})

describe('buildServerArgs', () => {
  const base = { id: 'p1', name: 'P', extraArgs: '' }

  it('emits switch flags for true booleans only', () => {
    const args = buildServerArgs(
      { ...base, args: { 'offload-to-cpu': true, mmap: false, 'eager-load': false } },
      8000
    )
    expect(args.filter((a) => a.startsWith('--offload') || a.includes('eager') || a.includes('mmap'))).toEqual(['--offload-to-cpu'])
  })

  it('passes known values verbatim, unknown keys ignored', () => {
    const args = buildServerArgs(
      {
        ...base,
        args: {
          'diffusion-model': '/models/flux.safetensors',
          'llm_vision': '/models/mmproj.gguf',
          'clip_l': '/models/clip.gguf',
          'threads': 8,
          not_a_flag: 'x'
        }
      },
      8000
    )
    expect(args.slice(0, 8)).toEqual([
      '--diffusion-model', '/models/flux.safetensors',
      '--llm_vision', '/models/mmproj.gguf',
      '--clip_l', '/models/clip.gguf',
      '--threads', '8'
    ])
    expect(args).not.toContain('--not_a_flag')
  })

  it('appends split extraArgs, then the forced listen-ip and listen-port', () => {
    const args = buildServerArgs({ ...base, args: {}, extraArgs: '' }, 8000)
    expect(args).toEqual(['--listen-ip', '127.0.0.1', '--listen-port', '8000'])
    const withExtra = buildServerArgs({ ...base, args: {}, extraArgs: '--fa --rng cpu --tokenizer "a b"' }, 8000)
    expect(withExtra).toEqual([
      '--fa', '--rng', 'cpu', '--tokenizer', 'a b',
      '--listen-ip', '127.0.0.1', '--listen-port', '8000'
    ])
    const override = buildServerArgs({ ...base, args: {}, extraArgs: '--listen-port 9999' }, 8000)
    expect(override.slice(-2)).toEqual(['--listen-port', '8000'])
  })

  it('omits flags whose value is false or empty string', () => {
    const joined = buildServerArgs({ ...base, args: { mmap: false, type: 'f16', 'tensor-type-rules': '' } }, 1234).join(' ')
    expect(joined).toContain('--type f16')
    expect(joined).not.toContain('--mmap')
    expect(joined).not.toContain('--tensor-type-rules')
  })
})

describe('parseProgressLine', () => {
  it('parses a middling sampling frame', () => {
    expect(parseProgressLine('  |=====>    | 5/20 - 1.23s/it')).toEqual({ step: 5, total: 20, speed: '1.23s/it' })
  })
  it('parses it/s units', () => {
    expect(parseProgressLine('  |==       | 2/8 - 3.41it/s')).toEqual({ step: 2, total: 8, speed: '3.41it/s' })
  })
  it('parses the # progress bar used by tiling / byte progress', () => {
    expect(parseProgressLine('  |##  | 12/40 - 1.05MB/s')).toEqual({ step: 12, total: 40, speed: '1.05MB/s' })
  })
  it('parses GB/s', () => {
    expect(parseProgressLine('  |#####  | 3/9 - 1.32GB/s')).toEqual({ step: 3, total: 9, speed: '1.32GB/s' })
  })
  it('handles the \r-prefixed raw frame including cursor-erase escape', () => {
    expect(parseProgressLine('\r  |=======>  | 7/30 - 0.89s/it\u001b[K')).toEqual({ step: 7, total: 30, speed: '0.89s/it' })
  })
  it('parses the final frame (new-terminated OK too)', () => {
    expect(parseProgressLine('  |==========| 20/20 - 1.00s/it')).toEqual({ step: 20, total: 20, speed: '1.00s/it' })
  })
  it('returns null for other lines (LOG_INFO, banner)', () => {
    expect(parseProgressLine('listening on: http://127.0.0.1:1234')).toBeNull()
    expect(parseProgressLine('')).toBeNull()
    expect(parseProgressLine('  model: flux1-schnell.safetensors')).toBeNull()
  })
})

describe('splitOutputLines (string-level helper, unchanged semantics)', () => {
  it('splits on \r as well as \n and strips the cursor-erase escape', () => {
    expect(splitOutputLines('\r  |=====> | 5/20 - 1.23s/it\u001b[K\r  |======> | 6/20 - 1.10s/it\u001b[K\n')).toEqual([
      '',
      '  |=====> | 5/20 - 1.23s/it',
      '  |======> | 6/20 - 1.10s/it',
      ''
    ])
  })
  it('does not split quoted log lines that contain no \r or \n', () => {
    expect(splitOutputLines('listening on: http://127.0.0.1:1234\n')).toEqual(['listening on: http://127.0.0.1:1234', ''])
  })
})

describe('OutputLineSplitter (per-stream carry-over)', () => {
  const FRAME = '\r  |=====> | 5/20 - 1.23s/it\u001b[K\r  |======> | 6/20 - 1.10s/it\u001b[K'

  it('reassembles a progress frame split across two chunks at every offset', () => {
    const buf = Buffer.from(FRAME, 'utf8')
    for (let split = 1; split < buf.length; split++) {
      const s = new OutputLineSplitter()
      const lines = [...s.push(buf.subarray(0, split)), ...s.push(buf.subarray(split)), ...s.end()]
      expect(lines, `split at byte ${split}`).toEqual([
        '  |=====> | 5/20 - 1.23s/it',
        '  |======> | 6/20 - 1.10s/it'
      ])
    }
  })

  it('reassembles multi-byte UTF-8 split across chunks at every offset', () => {
    const payload = 'banner: частичная строка\n\r  |=====> | 9/20 - 1.11s/it\u001b[K'
    const buf = Buffer.from(payload, 'utf8')
    for (let split = 1; split < buf.length; split++) {
      const s = new OutputLineSplitter()
      const lines = [...s.push(buf.subarray(0, split)), ...s.push(buf.subarray(split)), ...s.end()]
      expect(lines, `split at byte ${split}`).toEqual(['banner: частичная строка', '  |=====> | 9/20 - 1.11s/it'])
    }
  })

  it('holds back unterminated segments until the next chunk and flushes on end()', () => {
    const s = new OutputLineSplitter()
    expect(s.push(Buffer.from('partial'))).toEqual([])
    expect(s.push(Buffer.from(' line\n'))).toEqual(['partial line'])
    expect(s.end()).toEqual([])
    expect(s.push(Buffer.from('tail'))).toEqual([])
    expect(s.end()).toEqual(['tail'])
  })
})

// ---------------------------------------------------------------------------
// Lifecycle tests with a fake sd-server: a plain node script that listens on
// the given --listen-port (after a configurable delay) or exits immediately.

const FAKE_SD_SERVER_SCRIPT = `
const args = process.argv.slice(2)
const portIdx = args.indexOf('--listen-port')
const port = portIdx >= 0 ? Number(args[portIdx + 1]) : 0
if (process.env.FAKE_SD_EXIT) {
  process.stderr.write(process.env.FAKE_SD_EXIT_MESSAGE ?? 'fatal: model file not found\\n')
  process.exit(Number(process.env.FAKE_SD_EXIT_CODE ?? '3'))
}
const http = await import('node:http')
const delay = Number(process.env.FAKE_SD_READY_DELAY_MS ?? '0')
const server = http.createServer((req, res) => {
  if (!req.url?.startsWith('/sdcpp/v1/capabilities')) { res.writeHead(404); res.end(); return }
  const respond = () => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{}') }
  if (delay > 0) setTimeout(respond, delay)
  else respond()
})
server.listen(port, '127.0.0.1', () => {
  process.stdout.write('listening on: http://127.0.0.1:' + port + '\\n')
})
`

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer()
    s.once('error', reject)
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as net.AddressInfo
      s.close(() => resolve(port))
    })
  })
}

function isGone(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null
}

function waitForGone(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (isGone(child)) return resolve()
    child.once('close', () => resolve())
  })
}

function profile(id: string): LocalModelProfile {
  return { id, name: id, args: {}, extraArgs: '' }
}

function setStatus(server: SdServer, status: ServerStatus): void {
  ;(server as unknown as { statusValue: ServerStatus }).statusValue = status
}

function onceState(server: SdServer, state: ServerStatus['state']): Promise<void> {
  return new Promise((resolve) => {
    const cb = (s: ServerStatus): void => {
      if (s.state === state) {
        server.off('status', cb)
        resolve()
      }
    }
    server.on('status', cb)
  })
}

describe('SdServer lifecycle (fake sd-server process)', () => {
  let fakeScript: string
  let tmpDir: string
  const spawned: ChildProcess[] = []
  const servers: SdServer[] = []
  const savedEnv: Record<string, string | undefined> = {}

  const fakeSpawnImpl = (): SpawnImpl => (cmd, args, opts) => {
    const child = spawn(process.execPath, [fakeScript, ...args], opts)
    spawned.push(child)
    return child
  }

  beforeEach(async () => {
    if (!fakeScript) {
      tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sdserver-test-'))
      fakeScript = path.join(tmpDir, 'fake-sd-server.mjs')
      await fs.writeFile(fakeScript, FAKE_SD_SERVER_SCRIPT)
    }
    spawned.length = 0
  })

  afterEach(async () => {
    for (const key of ['FAKE_SD_EXIT', 'FAKE_SD_EXIT_MESSAGE', 'FAKE_SD_EXIT_CODE', 'FAKE_SD_READY_DELAY_MS']) {
      if (key in savedEnv) {
        if (savedEnv[key] === undefined) delete process.env[key]
        else process.env[key] = savedEnv[key]
        delete savedEnv[key]
      } else {
        delete process.env[key]
      }
    }
    // Make sure no sd-server-ish child leaks into the next test.
    await Promise.allSettled([...servers].map((s) => s.stop()))
    await Promise.all(spawned.map((c) => waitForGone(c)))
    spawned.length = 0
    servers.length = 0
  })

  const saveEnv = (key: string, value: string): void => {
    if (!(key in savedEnv)) savedEnv[key] = process.env[key]
    process.env[key] = value
  }

  const newServer = (opts: { readyTimeoutMs: number }): SdServer => {
    const server = new SdServer({ spawnImpl: fakeSpawnImpl(), readyTimeoutMs: opts.readyTimeoutMs })
    servers.push(server)
    return server
  }

  it('reaches ready and emits starting → ready status transitions', async () => {
    const server = newServer({ readyTimeoutMs: 15_000 })
    const events: ServerStatus[] = []
    server.on('status', (s) => events.push(s))
    const status = await server.start(profile('p1'), fakeScript, await freePort())
    expect(status.state).toBe('ready')
    expect(status.profileId).toBe('p1')
    expect(events.map((e) => e.state)).toEqual(['starting', 'ready'])
  }, 10_000)

  it('already ready with the same profile: start() returns immediately, no new process', async () => {
    const server = newServer({ readyTimeoutMs: 15_000 })
    await server.start(profile('p1'), fakeScript, await freePort())
    expect((await server.start(profile('p1'), fakeScript, await freePort())).state).toBe('ready')
    expect(spawned).toHaveLength(1)
  }, 10_000)

  it('concurrent start() calls for the same profile share one promise → one process', async () => {
    saveEnv('FAKE_SD_READY_DELAY_MS', '400')
    const server = newServer({ readyTimeoutMs: 15_000 })
    const [a, b] = await Promise.all([
      server.start(profile('p1'), fakeScript, await freePort()),
      server.start(profile('p1'), fakeScript, await freePort())
    ])
    expect(a.state).toBe('ready')
    expect(b).toEqual(a)
    expect(spawned).toHaveLength(1)
  }, 10_000)

  it('crash while starting resolves quickly with error status containing the last log lines', async () => {
    saveEnv('FAKE_SD_EXIT', '1')
    saveEnv('FAKE_SD_EXIT_MESSAGE', 'fatal: cannot load model\nfatal: aborting\n')
    const server = newServer({ readyTimeoutMs: 60_000 })
    const started = Date.now()
    const status = await server.start(profile('p1'), fakeScript, await freePort())
    expect(status.state).toBe('error')
    expect(status.error).toContain('exited while starting')
    expect(status.error).toContain('fatal: cannot load model')
    expect(Date.now() - started).toBeLessThan(10_000)
  }, 10_000)

  it('stop() during an in-flight start wins: state stopped, resolves after the child exited', async () => {
    saveEnv('FAKE_SD_READY_DELAY_MS', '15000')
    const server = newServer({ readyTimeoutMs: 60_000 })
    const startPromise = server.start(profile('p1'), fakeScript, await freePort())
    await onceState(server, 'starting')
    const stopStatus = await server.stop()
    expect(stopStatus.state).toBe('stopped')
    expect(server.status().state).toBe('stopped')
    expect(isGone(spawned[0])).toBe(true)
  }, 15_000)

  it('abort signal during start behaves like stop(): kill, state stopped, AbortError rejection', async () => {
    saveEnv('FAKE_SD_READY_DELAY_MS', '15000')
    const server = newServer({ readyTimeoutMs: 60_000 })
    const controller = new AbortController()
    const startPromise = server.start(profile('p1'), fakeScript, await freePort(), { signal: controller.signal })
    await onceState(server, 'starting')
    controller.abort()
    await expect(startPromise).rejects.toMatchObject({ name: 'AbortError' })
    await vi.waitFor(() => expect(server.status().state).toBe('stopped'))
    expect(isGone(spawned[0])).toBe(true)
  }, 15_000)

  it('aborting the signal after start() resolved does not stop the loaded server', async () => {
    const server = newServer({ readyTimeoutMs: 15_000 })
    const controller = new AbortController()
    const status = await server.start(profile('p1'), fakeScript, await freePort(), { signal: controller.signal })
    expect(status.state).toBe('ready')
    // generate.ts reuses the job's signal for imgGen; cancelling that job must not unload the model.
    controller.abort()
    await new Promise((r) => setTimeout(r, 200))
    expect(server.status().state).toBe('ready')
    expect(isGone(spawned[0])).toBe(false)
  }, 10_000)

  it('start immediately followed by stop never spawns (superseded while queued)', async () => {
    saveEnv('FAKE_SD_READY_DELAY_MS', '15000')
    const server = newServer({ readyTimeoutMs: 60_000 })
    const startPromise = server.start(profile('p1'), fakeScript, await freePort())
    const began = Date.now()
    const stopStatus = await server.stop()
    await startPromise
    expect(stopStatus.state).toBe('stopped')
    expect(Date.now() - began).toBeLessThan(3_000)
    expect(spawned).toHaveLength(0)
  }, 10_000)

  it('a same-profile start after a pending stop restarts instead of reporting the dying instance', async () => {
    const server = newServer({ readyTimeoutMs: 15_000 })
    await server.start(profile('p1'), fakeScript, await freePort())
    const stopping = server.stop()
    const restarted = await server.start(profile('p1'), fakeScript, await freePort())
    await stopping
    expect(restarted.state).toBe('ready')
    expect(server.status().state).toBe('ready')
    expect(spawned).toHaveLength(2)
    expect(isGone(spawned[0])).toBe(true)
  }, 15_000)

  it('a caller joining an in-flight start can abort without stopping the shared load', async () => {
    saveEnv('FAKE_SD_READY_DELAY_MS', '400')
    const server = newServer({ readyTimeoutMs: 15_000 })
    const owner = server.start(profile('p1'), fakeScript, await freePort())
    await onceState(server, 'starting')
    const controller = new AbortController()
    const joiner = server.start(profile('p1'), fakeScript, await freePort(), { signal: controller.signal })
    controller.abort()
    await expect(joiner).rejects.toMatchObject({ name: 'AbortError' })
    expect((await owner).state).toBe('ready')
    expect(spawned).toHaveLength(1)
  }, 10_000)

  it('start() with an already-aborted signal rejects immediately without spawning', async () => {
    const controller = new AbortController()
    controller.abort()
    const server = newServer({ readyTimeoutMs: 5000 })
    await expect(server.start(profile('p1'), fakeScript, await freePort(), { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' })
    expect(spawned).toHaveLength(0)
  })

  it('a start for a different profile serializes: the first start aborts, the second wins', async () => {
    saveEnv('FAKE_SD_READY_DELAY_MS', '15000')
    const server = newServer({ readyTimeoutMs: 60_000 })
    const first = server.start(profile('a'), fakeScript, await freePort())
    await onceState(server, 'starting')
    // Only the first (long-loading) instance is slowed down; read per-request.
    saveEnv('FAKE_SD_READY_DELAY_MS', '100')
    const second = server.start(profile('b'), fakeScript, await freePort())
    const stB = await second
    expect(stB.state).toBe('ready')
    expect(stB.profileId).toBe('b')
    // The first start resolved without spawning a second live server.
    const stA = await first
    expect(stA.profileId).toBe('a')
    expect(isGone(spawned[0])).toBe(true) // first child was cleaned up
    expect(isGone(spawned[1])).toBe(false) // second child is the live one
  }, 20_000)

  it('reports a clear error when all 200 probed ports are busy', async () => {
    const server = new SdServer({ portProbeImpl: async () => false, readyTimeoutMs: 5000 })
    const st = await server.start(profile('p1'), fakeScript, 40000)
    expect(st.state).toBe('error')
    expect(st.error).toMatch(/no free port/)
    expect(spawned).toHaveLength(0) // never spawns
  })

  it('wait-ready timeout kills the child and lands on error (no leaked process)', async () => {
    saveEnv('FAKE_SD_READY_DELAY_MS', '30000')
    const server = newServer({ readyTimeoutMs: 1200 })
    const st = await server.start(profile('p1'), fakeScript, await freePort())
    expect(st.state).toBe('error')
    expect(st.error).toContain('timed out')
    expect(isGone(spawned[0])).toBe(true)
  }, 15_000)
})

// ---------------------------------------------------------------------------
// imgGen / upscale against a mocked fetch.

describe('SdServer imgGen / upscale (mock fetch)', () => {
  let server: SdServer

  const jsonResponse = (status: number, body: unknown): Response =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

  beforeEach(() => {
    server = new SdServer()
    setStatus(server, { state: 'ready', profileId: 'p', port: 4599 })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('reports onQueued/onState transitions and decodes the completed image', async () => {
    let polls = 0
    const sequences = [
      { status: 'queued', queue_position: 2 },
      { status: 'generating' },
      { status: 'completed', result: { output_format: 'png', images: [{ b64_json: Buffer.from('hello').toString('base64') }] } }
    ]
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
        const url = String(input)
        if (url.endsWith('/img_gen')) return jsonResponse(200, { id: 'j1' })
        if (url.includes('/jobs/j1')) return jsonResponse(200, sequences[Math.min(polls++, sequences.length - 1)])
        throw new Error(`unexpected fetch ${url}`)
      })
    )
    const states: string[] = []
    let queued = -1
    const res = await server.imgGen({ prompt: 'x' } as SdImgGenBody, {
      onQueued: (p) => (queued = p),
      onState: (s) => states.push(s)
    })
    expect(res.format).toBe('png')
    expect(res.images[0].toString()).toBe('hello')
    expect(queued).toBe(2)
    expect(states).toEqual(['queued', 'generating'])
  })

  it('cancel answered 409 (already generating) → AbortError with interrupted: false', async () => {
    const controller = new AbortController()
    let cancelCalls = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
        const url = String(input)
        if (url.endsWith('/img_gen')) return jsonResponse(200, { id: 'j2' })
        if (url.includes('/jobs/j2/cancel')) {
          cancelCalls++
          return jsonResponse(409, { error: 'job is currently generating and cannot be interrupted yet' })
        }
        if (url.includes('/jobs/j2')) return jsonResponse(200, { status: 'generating' })
        throw new Error(`unexpected fetch ${url}`)
      })
    )
    const promise = server.imgGen({ prompt: 'x' } as SdImgGenBody, {
      signal: controller.signal,
      onState: () => {
        if (!controller.signal.aborted) controller.abort()
      }
    })
    await expect(promise).rejects.toMatchObject({ name: 'AbortError', interrupted: false })
    expect(cancelCalls).toBe(1)
  })

  it('cancel succeeded for a queued job → AbortError with interrupted: true', async () => {
    const controller = new AbortController()
    let cancelCalls = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
        const url = String(input)
        if (url.endsWith('/img_gen')) return jsonResponse(200, { id: 'j3' })
        if (url.includes('/jobs/j3/cancel')) {
          cancelCalls++
          return jsonResponse(200, { status: 'cancelled' })
        }
        if (url.includes('/jobs/j3')) return jsonResponse(200, { status: 'queued', queue_position: 1 })
        throw new Error(`unexpected fetch ${url}`)
      })
    )
    const promise = server.imgGen({ prompt: 'x' } as SdImgGenBody, {
      signal: controller.signal,
      onQueued: () => {
        if (!controller.signal.aborted) controller.abort()
      }
    })
    await expect(promise).rejects.toMatchObject({ name: 'AbortError', interrupted: true })
    expect(cancelCalls).toBe(1)
  })

  it('abort before the submit response: remembered, then cancelled as soon as the job id is known', async () => {
    const controller = new AbortController()
    let resolveSubmit: (r: Response) => void = () => {}
    const cancelUrls: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
        const url = String(input)
        if (url.endsWith('/img_gen')) {
          return new Promise<Response>((resolve) => {
            resolveSubmit = resolve
          })
        }        if (url.includes('/cancel')) {
          cancelUrls.push(url)
          return jsonResponse(200, { status: 'cancelled' })
        }
        if (url.includes('/jobs/j4')) return jsonResponse(200, { status: 'queued' })
        throw new Error(`unexpected fetch ${url}`)
      })
    )
    const promise = server.imgGen({ prompt: 'x' } as SdImgGenBody, { signal: controller.signal })
    controller.abort()
    await new Promise((r) => setTimeout(r, 20))
    resolveSubmit(jsonResponse(200, { id: 'j4' }))
    await expect(promise).rejects.toMatchObject({ name: 'AbortError', interrupted: true })
    expect(cancelUrls).toEqual(['http://127.0.0.1:4599/sdcpp/v1/jobs/j4/cancel'])
  })

  it('upscale honors the abort signal and rejects with AbortError', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((_input: RequestInfo | URL, init?: RequestInit): Promise<Response> =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('The operation was aborted')))
        })
      )
    )
    const controller = new AbortController()
    const promise = server.upscale({ image: 'x' }, { signal: controller.signal })
    controller.abort()
    await expect(promise).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('upscale without a signal keeps working', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (): Promise<Response> =>
        jsonResponse(200, { images: [{ b64_json: Buffer.from('img').toString('base64') }], upscaler: 'esrgan', width: 2, height: 2, output_format: 'png' })
      )
    )
    const res = await server.upscale({ image: 'x' })
    expect(res.image.toString()).toBe('img')
    expect(res.upscaler).toBe('esrgan')
  })
})
