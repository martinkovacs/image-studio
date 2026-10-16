import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { DownloadManager } from './downloads'
import { HF_BASE } from './hub'

const sha256 = (buf: Buffer) => crypto.createHash('sha256').update(buf).digest('hex')

const lowerHeaders = (init: HeadersInit | undefined): Record<string, string> =>
  Object.fromEntries(Object.entries((init ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]))

interface RepoFetchOpts {
  /** Serve 200 even when a Range header is present. */
  ignoreRange?: boolean
  /** Emulate the resolve → CDN redirect inside fetch (auth dropped on the hop). */
  redirect?: boolean
  /** Serve 206 responses whose content-range start does not match the request. */
  badContentRange?: boolean
}

/** Fake fetch serving in-memory repo files with Range support. */
function repoFetch(files: Record<string, Buffer>, opts: RepoFetchOpts = {}) {
  const calls: Array<{ url: string; headers: Record<string, string>; status: number }> = []
  const serve = (url: string, key: string, headers: Record<string, string>): Response => {
    const body = files[key]
    if (body === undefined) {
      calls.push({ url, headers, status: 404 })
      return new Response('not found', { status: 404 })
    }
    const range = headers.range?.match(/^bytes=(\d+)-$/)
    if (range && !opts.ignoreRange) {
      const start = Number(range[1])
      if (start >= body.length) {
        calls.push({ url, headers, status: 416 })
        return new Response(null, { status: 416 })
      }
      const slice = body.subarray(start)
      const rangeStart = opts.badContentRange ? 0 : start
      calls.push({ url, headers, status: 206 })
      return new Response(new Uint8Array(slice), {
        status: 206,
        headers: { 'content-range': `bytes ${rangeStart}-${body.length - 1}/${body.length}`, 'content-length': String(slice.length) }
      })
    }
    calls.push({ url, headers, status: 200 })
    return new Response(new Uint8Array(body), { status: 200, headers: { 'content-length': String(body.length) } })
  }
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input)
    const headers = lowerHeaders(init?.headers)
    const m = url.match(/^https:\/\/huggingface\.co\/[^/]+\/[^/]+\/resolve\/[^/]+\/(.+)$/)
    if (!m) return new Response('not found', { status: 404 })
    const key = decodeURIComponent(m[1])
    if (opts.redirect) {
      calls.push({ url, headers, status: 302 })
      return serve(`https://cdn.example/${m[1]}`, key, {})
    }
    return serve(url, key, headers)
  }
  return { fetchImpl, calls }
}

/** Fake fetch streaming the body in two chunks around a test-controlled gate. */
function gatedFetch(body: Buffer) {
  let release!: () => void
  const gate = new Promise<void>((r) => {
    release = r
  })
  let sentFirst!: () => void
  const sent = new Promise<void>((r) => {
    sentFirst = r
  })
  let aborted = false
  const fetchImpl: typeof fetch = (input, init) => {
    let controller!: ReadableStreamDefaultController<Uint8Array>
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        controller = c
        controller.enqueue(body.subarray(0, 100))
        sentFirst()
        void gate.then(() => {
          if (!aborted) {
            controller.enqueue(body.subarray(100))
            controller.close()
          }
        })
      },
      cancel() {
        aborted = true
      }
    })
    // Real fetch rejects the body iterator when the signal aborts; do the same.
    init?.signal?.addEventListener(
      'abort',
      () => {
        aborted = true
        try {
          controller.error(new Error('The download was aborted'))
        } catch {
          // stream already closed
        }
      },
      { once: true }
    )
    return Promise.resolve(new Response(stream, { status: 200, headers: { 'content-length': String(body.length) } }))
  }
  return { fetchImpl, sent, release }
}

/** Fake fetch sending one chunk and then never producing another byte. */
function stallingFetch(body: Buffer) {
  const fetchImpl: typeof fetch = (_input, init) => {
    const signal = init?.signal
    let controller!: ReadableStreamDefaultController<Uint8Array>
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        controller = c
        controller.enqueue(body.subarray(0, 100))
      },
      cancel() {
        // stopped producing bytes
      }
    })
    // Real fetch surfaces an abort through the body iterator; do the same,
    // passing the abort reason (the stall error) through.
    signal?.addEventListener(
      'abort',
      () => {
        try {
          controller.error(signal.reason)
        } catch {
          // stream already closed
        }
      },
      { once: true }
    )
    return Promise.resolve(new Response(stream, { status: 200, headers: { 'content-length': String(body.length) } }))
  }
  return { fetchImpl }
}

function makeManager(fetchImpl: typeof fetch, modelsDir: string, token: () => string | null = () => 'hf_tok') {
  return new DownloadManager({ modelsDir: () => modelsDir, token, fetchImpl })
}

describe('DownloadManager', () => {
  let dir: string

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hf-dl-'))
  })
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })

  it('resolves metadata from the hub, verifies sha256 and reports progress', async () => {
    const body = Buffer.from('weights-bytes-'.repeat(200))
    const digest = sha256(body)
    const { fetchImpl, calls } = repoFetch({ 'model.gguf': body })
    const fetchWithHub: typeof fetch = async (input, init) => {
      const url = String(input)
      if (url === `${HF_BASE}/api/models/owner/repo`) {
        return new Response(JSON.stringify({ sha: 'abc123', gated: false, siblings: [] }), { status: 200 })
      }
      if (url.startsWith(`${HF_BASE}/api/models/owner/repo/tree/abc123`)) {
        return new Response(
          JSON.stringify([{ type: 'file', path: 'model.gguf', size: body.length, lfs: { oid: digest } }]),
          { status: 200 }
        )
      }
      return fetchImpl(input, init)
    }
    const mgr = makeManager(fetchWithHub, dir)
    const events: Array<{ state: string; downloadId: string }> = []
    mgr.on('progress', (p) => events.push({ state: p.state, downloadId: p.downloadId }))

    const id = mgr.enqueue({ repo: 'owner/repo', files: ['model.gguf'], catalogId: 'cat-1' })
    const done = await mgr.whenDone(id)
    expect(done.state, done.error).toBe('done')
    expect(done.filesDone).toBe(1)
    expect(done.filesTotal).toBe(1)
    expect(done.bytesDone).toBe(body.length)
    expect(done.bytesTotal).toBe(body.length)
    expect(done.catalogId).toBe('cat-1')
    expect(events.at(-1)).toMatchObject({ state: 'done', downloadId: id })
    expect(mgr.list().find((p) => p.downloadId === id)?.state).toBe('done')

    const final = await fs.readFile(path.join(dir, 'owner', 'repo', 'model.gguf'))
    expect(final.equals(body)).toBe(true)
    // Download pinned to the listed commit, token only on the huggingface.co request.
    const resolve = calls.find((c) => c.url.includes('/resolve/'))!
    expect(resolve.url).toContain('/resolve/abc123/model.gguf')
    expect(resolve.headers.authorization).toBe('Bearer hf_tok')
  })

  it('skips files the manifest vouches for, without a fetch', async () => {
    const a = Buffer.from('A'.repeat(10))
    const b = Buffer.from('B'.repeat(5))
    const repoDir = path.join(dir, 'owner', 'repo')
    const dest = path.join(repoDir, 'a.gguf')
    await fs.mkdir(repoDir, { recursive: true })
    await fs.writeFile(dest, Buffer.alloc(10, 7)) // same size, different content
    await fs.writeFile(path.join(repoDir, '.image-studio-files.json'), JSON.stringify({
      'a.gguf': { size: 10, sha256: sha256(a), revision: 'main' }
    }))
    const { fetchImpl, calls } = repoFetch({ 'a.gguf': a, 'b.gguf': b })
    const mgr = makeManager(fetchImpl, dir)
    const id = mgr.enqueue({
      repo: 'owner/repo',
      files: ['a.gguf', 'b.gguf'],
      expected: [
        { path: 'a.gguf', size: 10, sha256: sha256(a) },
        { path: 'b.gguf', size: 5, sha256: sha256(b) }
      ]
    })
    const done = await mgr.whenDone(id)
    expect(done.state).toBe('done')
    expect(done.filesDone).toBe(2)
    expect((await fs.readFile(dest)).equals(Buffer.alloc(10, 7))).toBe(true) // untouched
    expect(calls.filter((c) => c.url.includes('a.gguf'))).toHaveLength(0)
    expect(calls.some((c) => c.url.includes('b.gguf'))).toBe(true)
  })

  it('re-downloads same-size files the manifest does not vouch for', async () => {
    const a = Buffer.from('A'.repeat(10))
    const b = Buffer.from('B'.repeat(10))
    const repoDir = path.join(dir, 'owner', 'repo')
    await fs.mkdir(repoDir, { recursive: true })
    await fs.writeFile(path.join(repoDir, 'a.gguf'), Buffer.alloc(10, 7)) // from another revision
    await fs.writeFile(path.join(repoDir, 'b.gguf'), Buffer.alloc(10, 8)) // never verified
    await fs.writeFile(path.join(repoDir, '.image-studio-files.json'), JSON.stringify({
      'a.gguf': { size: 10, sha256: 'f'.repeat(64), revision: 'main' }
    }))
    const { fetchImpl, calls } = repoFetch({ 'a.gguf': a, 'b.gguf': b })
    const mgr = makeManager(fetchImpl, dir)
    const done = await mgr.whenDone(
      mgr.enqueue({
        repo: 'owner/repo',
        files: ['a.gguf', 'b.gguf'],
        expected: [
          { path: 'a.gguf', size: 10, sha256: sha256(a) },
          { path: 'b.gguf', size: 10, sha256: sha256(b) }
        ]
      })
    )
    expect(done.state).toBe('done')
    expect(calls.some((c) => c.url.includes('/a.gguf'))).toBe(true)
    expect(calls.some((c) => c.url.includes('/b.gguf'))).toBe(true)
    expect((await fs.readFile(path.join(repoDir, 'a.gguf'))).equals(a)).toBe(true)
    expect((await fs.readFile(path.join(repoDir, 'b.gguf'))).equals(b)).toBe(true)
    const manifest = JSON.parse(await fs.readFile(path.join(repoDir, '.image-studio-files.json'), 'utf8'))
    expect(manifest['a.gguf']).toEqual({ size: 10, sha256: sha256(a), revision: 'main' })
    expect(manifest['b.gguf']).toEqual({ size: 10, sha256: sha256(b), revision: 'main' })
  })

  it('skips small unhashed files only for the same revision', async () => {
    const body = Buffer.from('v1')
    const repoDir = path.join(dir, 'owner', 'repo')
    const dest = path.join(repoDir, 'info.json')
    await fs.mkdir(repoDir, { recursive: true })
    await fs.writeFile(dest, body)
    await fs.writeFile(path.join(repoDir, '.image-studio-files.json'), JSON.stringify({
      'info.json': { size: 2, revision: 'main' }
    }))
    const { fetchImpl, calls } = repoFetch({ 'info.json': Buffer.from('v2') })
    const mgr = makeManager(fetchImpl, dir)
    const done = await mgr.whenDone(
      mgr.enqueue({ repo: 'owner/repo', files: ['info.json'], expected: [{ path: 'info.json', size: 2 }] })
    )
    expect(done.state).toBe('done')
    expect(calls).toHaveLength(0)
    expect((await fs.readFile(dest)).equals(body)).toBe(true)

    // A different revision re-downloads and re-verifies.
    await fs.writeFile(path.join(repoDir, '.image-studio-files.json'), JSON.stringify({
      'info.json': { size: 2, revision: 'deadbeef' }
    }))
    const { fetchImpl: fetch2, calls: calls2 } = repoFetch({ 'info.json': Buffer.from('v2') })
    const mgr2 = makeManager(fetch2, dir)
    const done2 = await mgr2.whenDone(
      mgr2.enqueue({ repo: 'owner/repo', files: ['info.json'], expected: [{ path: 'info.json', size: 2 }] })
    )
    expect(done2.state).toBe('done')
    expect(calls2).toHaveLength(1)
    expect((await fs.readFile(dest)).equals(Buffer.from('v2'))).toBe(true)
  })

  it('records verified files in the manifest across parallel workers', async () => {
    const bodies = {
      'a.gguf': Buffer.from('A'.repeat(100)),
      'b.gguf': Buffer.from('B'.repeat(120)),
      'sub/c.gguf': Buffer.from('C'.repeat(80))
    }
    const expected = Object.entries(bodies).map(([p, buf]) => ({ path: p, size: buf.length, sha256: sha256(buf) }))
    const { fetchImpl } = repoFetch(bodies)
    const mgr = makeManager(fetchImpl, dir)
    const done = await mgr.whenDone(mgr.enqueue({ repo: 'owner/repo', files: Object.keys(bodies), expected }))
    expect(done.state).toBe('done')
    const repoDir = path.join(dir, 'owner', 'repo')
    const manifest = JSON.parse(await fs.readFile(path.join(repoDir, '.image-studio-files.json'), 'utf8'))
    for (const [p, buf] of Object.entries(bodies)) {
      expect(manifest[p]).toEqual({ size: buf.length, sha256: sha256(buf), revision: 'main' })
    }
    // Atomic writes leave no temp files behind.
    expect((await fs.readdir(repoDir)).filter((f) => f.endsWith('.tmp'))).toEqual([])
  })

  it('resumes from a .part file via 206 and still verifies the hash', async () => {
    const body = Buffer.from('0123456789'.repeat(100))
    const dest = path.join(dir, 'owner', 'repo', 'm.gguf')
    await fs.mkdir(path.dirname(dest), { recursive: true })
    await fs.writeFile(`${dest}.part`, body.subarray(0, 400))
    const { fetchImpl, calls } = repoFetch({ 'm.gguf': body })
    const mgr = makeManager(fetchImpl, dir)
    const done = await mgr.whenDone(
      mgr.enqueue({ repo: 'owner/repo', files: ['m.gguf'], expected: [{ path: 'm.gguf', size: body.length, sha256: sha256(body) }] })
    )
    expect(done.state).toBe('done')
    expect(calls.some((c) => c.status === 206 && c.headers.range === 'bytes=400-')).toBe(true)
    expect((await fs.readFile(dest)).equals(body)).toBe(true)
    await expect(fs.stat(`${dest}.part`)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('restarts from zero when the server answers 200 despite Range', async () => {
    const body = Buffer.from('X'.repeat(1000))
    const dest = path.join(dir, 'owner', 'repo', 'm.gguf')
    await fs.mkdir(path.dirname(dest), { recursive: true })
    await fs.writeFile(`${dest}.part`, Buffer.alloc(400, 9))
    const { fetchImpl, calls } = repoFetch({ 'm.gguf': body }, { ignoreRange: true })
    const mgr = makeManager(fetchImpl, dir)
    const done = await mgr.whenDone(
      mgr.enqueue({ repo: 'owner/repo', files: ['m.gguf'], expected: [{ path: 'm.gguf', size: body.length, sha256: sha256(body) }] })
    )
    expect(done.state).toBe('done')
    expect(calls.some((c) => c.status === 200 && c.headers.range)).toBe(true)
    expect((await fs.readFile(dest)).equals(body)).toBe(true)
  })

  it('restarts from zero on 416 when the .part is too large', async () => {
    const body = Buffer.from('Y'.repeat(1000))
    const dest = path.join(dir, 'owner', 'repo', 'm.gguf')
    await fs.mkdir(path.dirname(dest), { recursive: true })
    await fs.writeFile(`${dest}.part`, Buffer.alloc(2000, 1))
    const { fetchImpl, calls } = repoFetch({ 'm.gguf': body })
    const mgr = makeManager(fetchImpl, dir)
    const done = await mgr.whenDone(
      mgr.enqueue({ repo: 'owner/repo', files: ['m.gguf'], expected: [{ path: 'm.gguf', size: body.length, sha256: sha256(body) }] })
    )
    expect(done.state).toBe('done')
    expect(calls[0].status).toBe(416)
    expect(calls[1].status).toBe(200)
    expect(calls[1].headers.range).toBeUndefined()
    expect((await fs.readFile(dest)).equals(body)).toBe(true)
  })

  it('restarts from zero when a resumed 206 reports mismatched content-range', async () => {
    const body = Buffer.from('C'.repeat(1000))
    const dest = path.join(dir, 'owner', 'repo', 'm.gguf')
    await fs.mkdir(path.dirname(dest), { recursive: true })
    await fs.writeFile(`${dest}.part`, Buffer.alloc(400, 3))
    const { fetchImpl, calls } = repoFetch({ 'm.gguf': body }, { badContentRange: true })
    const mgr = makeManager(fetchImpl, dir)
    const done = await mgr.whenDone(
      mgr.enqueue({ repo: 'owner/repo', files: ['m.gguf'], expected: [{ path: 'm.gguf', size: body.length, sha256: sha256(body) }] })
    )
    expect(done.state).toBe('done')
    expect(calls[0].status).toBe(206)
    expect(calls[0].headers.range).toBe('bytes=400-')
    expect(calls[1].status).toBe(200)
    expect(calls[1].headers.range).toBeUndefined()
    expect((await fs.readFile(dest)).equals(body)).toBe(true)
    await expect(fs.stat(`${dest}.part`)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('fails a stalled transfer as an error, not a cancel, and keeps the .part', async () => {
    const body = Buffer.from('S'.repeat(1000))
    const { fetchImpl } = stallingFetch(body)
    const mgr = new DownloadManager({ modelsDir: () => dir, token: () => 'hf_tok', fetchImpl, stallTimeoutMs: 50 })
    const done = await mgr.whenDone(
      mgr.enqueue({ repo: 'owner/repo', files: ['m.gguf'], expected: [{ path: 'm.gguf', size: body.length, sha256: sha256(body) }] })
    )
    expect(done.state).toBe('error')
    expect(done.error).toContain('Download stalled')
    expect(done.error).toContain('resumes from where it stopped')
    expect((await fs.stat(path.join(dir, 'owner', 'repo', 'm.gguf.part'))).size).toBe(100)
    await expect(fs.stat(path.join(dir, 'owner', 'repo', 'm.gguf'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('reports done when cancelled right after the last file finished', async () => {
    const body = Buffer.from('D'.repeat(1000))
    const { fetchImpl } = repoFetch({ 'm.gguf': body })
    const mgr = makeManager(fetchImpl, dir)
    const id = mgr.enqueue({ repo: 'owner/repo', files: ['m.gguf'], expected: [{ path: 'm.gguf', size: body.length, sha256: sha256(body) }] })
    // Cancel during the final per-file progress event: the record is not yet finished.
    mgr.on('progress', (p) => {
      if (p.downloadId === id && p.filesDone === p.filesTotal) mgr.cancel(id)
    })
    const done = await mgr.whenDone(id)
    expect(done.state).toBe('done')
    expect(done.filesDone).toBe(1)
  })

  it('fails on sha mismatch, deletes the .part and writes no final file', async () => {
    const body = Buffer.from('corrupt-me'.repeat(50))
    const dest = path.join(dir, 'owner', 'repo', 'm.gguf')
    const { fetchImpl } = repoFetch({ 'm.gguf': body })
    const mgr = makeManager(fetchImpl, dir)
    const done = await mgr.whenDone(
      mgr.enqueue({ repo: 'owner/repo', files: ['m.gguf'], expected: [{ path: 'm.gguf', size: body.length, sha256: '0'.repeat(64) }] })
    )
    expect(done.state).toBe('error')
    expect(done.error).toContain('Checksum mismatch')
    await expect(fs.stat(`${dest}.part`)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(fs.stat(dest)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('fails when a requested file is missing from the metadata', async () => {
    const { fetchImpl } = repoFetch({})
    const mgr = makeManager(fetchImpl, dir)
    const done = await mgr.whenDone(mgr.enqueue({ repo: 'owner/repo', files: ['missing.gguf'], expected: [] }))
    expect(done.state).toBe('error')
    expect(done.error).toContain('File not found in repository')
  })

  it('cancels mid-download, keeps the .part, and resumes afterwards', async () => {
    const body = Buffer.from('Z'.repeat(1000))
    const dest = path.join(dir, 'owner', 'repo', 'm.gguf')
    const { fetchImpl, sent, release } = gatedFetch(body)
    const mgr = makeManager(fetchImpl, dir)
    const expected = [{ path: 'm.gguf', size: body.length, sha256: sha256(body) }]
    const id = mgr.enqueue({ repo: 'owner/repo', files: ['m.gguf'], expected })
    await sent
    await vi.waitFor(async () => {
      expect((await fs.stat(`${dest}.part`)).size).toBe(100)
    })
    mgr.cancel(id)
    const done = await mgr.whenDone(id)
    expect(done.state).toBe('cancelled')
    expect((await fs.stat(`${dest}.part`)).size).toBe(100)
    await expect(fs.stat(dest)).rejects.toMatchObject({ code: 'ENOENT' })

    release()
    const { fetchImpl: resumeFetch, calls } = repoFetch({ 'm.gguf': body })
    const mgr2 = makeManager(resumeFetch, dir)
    const done2 = await mgr2.whenDone(mgr2.enqueue({ repo: 'owner/repo', files: ['m.gguf'], expected }))
    expect(done2.state).toBe('done')
    expect(calls.some((c) => c.status === 206 && c.headers.range === 'bytes=100-')).toBe(true)
    expect((await fs.readFile(dest)).equals(body)).toBe(true)
  })

  it('queues downloads one at a time and can cancel queued ones', async () => {
    const body = Buffer.from('W'.repeat(1000))
    const { fetchImpl, sent, release } = gatedFetch(body)
    const mgr = makeManager(fetchImpl, dir)
    const expected = [{ path: 'm.gguf', size: body.length, sha256: sha256(body) }]
    const id1 = mgr.enqueue({ repo: 'owner/repo', files: ['m.gguf'], expected })
    const id2 = mgr.enqueue({ repo: 'owner/repo2', files: ['m.gguf'], expected })
    await sent
    expect(mgr.list().filter((p) => p.state === 'downloading' || p.state === 'queued')).toHaveLength(2)
    mgr.cancel(id2)
    await expect(mgr.whenDone(id2)).resolves.toMatchObject({ state: 'cancelled' })
    release()
    await expect(mgr.whenDone(id1)).resolves.toMatchObject({ state: 'done' })
  })

  it('sends the token only on the huggingface.co request (CDN redirect)', async () => {
    const body = Buffer.from('tok'.repeat(10))
    const { fetchImpl, calls } = repoFetch({ 'm.gguf': body }, { redirect: true })
    const mgr = makeManager(fetchImpl, dir)
    const done = await mgr.whenDone(
      mgr.enqueue({ repo: 'owner/repo', files: ['m.gguf'], expected: [{ path: 'm.gguf', size: body.length, sha256: sha256(body) }] })
    )
    expect(done.state).toBe('done')
    expect(calls[0].url).toContain('/resolve/')
    expect(calls[0].headers.authorization).toBe('Bearer hf_tok')
    expect(calls[1].url.startsWith('https://cdn.example/')).toBe(true)
    const { fetchImpl: noTokenFetch, calls: noTokenCalls } = repoFetch({ 'm.gguf': body })
    const mgr2 = makeManager(noTokenFetch, dir, () => null)
    const done2 = await mgr2.whenDone(
      mgr2.enqueue({ repo: 'owner/repo2', files: ['m.gguf'], expected: [{ path: 'm.gguf', size: body.length, sha256: sha256(body) }] })
    )
    expect(done2.state, done2.error).toBe('done')
    expect(noTokenCalls[0].headers.authorization).toBeUndefined()
  })

  it('rejects unsafe paths and invalid repo ids at enqueue', () => {
    const { fetchImpl } = repoFetch({})
    const mgr = makeManager(fetchImpl, dir)
    expect(() => mgr.enqueue({ repo: 'owner/repo', files: ['../evil.bin'] })).toThrow('Unsafe repository path')
    expect(() => mgr.enqueue({ repo: 'owner/repo', files: ['a\\b.gguf'] })).toThrow('Unsafe repository path')
    expect(() => mgr.enqueue({ repo: 'owner/repo', files: ['.image-studio-files.json'] })).toThrow('Reserved file name')
    expect(() => mgr.enqueue({ repo: 'owner/repo', files: ['con'] })).toThrow('Unsafe repository path')
    expect(() => mgr.enqueue({ repo: 'bad repo id', files: ['x'] })).toThrow('Invalid repository id')
    expect(mgr.localDir('owner/repo')).toBe(path.join(dir, 'owner', 'repo'))
  })

  it('scans and removes local repos', async () => {
    const repoDir = path.join(dir, 'owner', 'repo')
    await fs.mkdir(path.join(repoDir, 'sub'), { recursive: true })
    await fs.mkdir(path.join(dir, 'owner', 'other'), { recursive: true })
    await fs.mkdir(path.join(dir, 'owner', 'big'), { recursive: true })
    await fs.mkdir(path.join(dir, 'owner', 'odd'), { recursive: true })
    await fs.writeFile(path.join(repoDir, 'model.gguf'), Buffer.alloc(10))
    await fs.writeFile(path.join(repoDir, 'sub', 'model-00001-of-00002.gguf'), Buffer.alloc(5))
    await fs.writeFile(path.join(repoDir, 'model.gguf.part'), Buffer.alloc(3))
    await fs.writeFile(path.join(repoDir, '.image-studio-files.json'), '{}')
    await fs.mkdir(path.join(repoDir, '.cache'), { recursive: true })
    await fs.writeFile(path.join(repoDir, '.cache', 'junk.gguf'), Buffer.alloc(2))
    await fs.writeFile(path.join(dir, 'owner', 'other', 'model_index.json'), JSON.stringify({ _class_name: 'StableDiffusionXLPipeline' }))
    // Over 1 MB: the manifest is ignored rather than parsed.
    await fs.writeFile(
      path.join(dir, 'owner', 'big', 'model_index.json'),
      Buffer.concat([Buffer.from(JSON.stringify({ _class_name: 'TooBigPipeline' })), Buffer.alloc(1024 * 1024)])
    )
    // Non-string _class_name is ignored.
    await fs.writeFile(path.join(dir, 'owner', 'odd', 'model_index.json'), JSON.stringify({ _class_name: 42 }))
    const mgr = makeManager(repoFetch({}).fetchImpl, dir)
    const repos = await mgr.scanLocal()
    expect(repos.map((r) => r.repo).sort()).toEqual(['owner/big', 'owner/odd', 'owner/other', 'owner/repo'])
    const main = repos.find((r) => r.repo === 'owner/repo')!
    expect(main.kind).toBe('gguf')
    expect(main.pipelineClass).toBeUndefined()
    expect(main.dir).toBe(repoDir)
    expect(main.files.map((f) => f.path)).toEqual(['model.gguf', 'sub/model-00001-of-00002.gguf'])
    expect(main.totalBytes).toBe(15)
    expect(main.files[0].absPath).toBe(path.join(repoDir, 'model.gguf'))
    const other = repos.find((r) => r.repo === 'owner/other')!
    expect(other.kind).toBe('diffusers')
    expect(other.pipelineClass).toBe('StableDiffusionXLPipeline')
    expect(repos.find((r) => r.repo === 'owner/big')!.pipelineClass).toBeUndefined()
    expect(repos.find((r) => r.repo === 'owner/odd')!.pipelineClass).toBeUndefined()

    await mgr.removeLocal('owner/repo')
    await expect(fs.stat(repoDir)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(mgr.removeLocal('../escape')).rejects.toThrow('Invalid repository id')
  })

  it('refuses to remove a repo with an active download', async () => {
    const body = Buffer.from('R'.repeat(1000))
    const { fetchImpl, sent, release } = gatedFetch(body)
    const mgr = makeManager(fetchImpl, dir)
    const id = mgr.enqueue({
      repo: 'owner/repo',
      files: ['m.gguf'],
      expected: [{ path: 'm.gguf', size: body.length, sha256: sha256(body) }]
    })
    await sent
    await expect(mgr.removeLocal('owner/repo')).rejects.toThrow('cancel it first')
    mgr.cancel(id)
    await mgr.whenDone(id)
    release()
  })
})
