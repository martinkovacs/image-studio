import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HistoryStore } from './history'
import type { HistoryItem } from '../shared/types'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'history-test-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

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

const tick = async (): Promise<void> => {
  // ensure distinct creation timestamps
  await new Promise((r) => setTimeout(r, 2))
}

describe('HistoryStore', () => {
  it('round-trips items across instances, newest first', async () => {
    await tick()
    const store = new HistoryStore(dir)
    await store.add(item('a'))
    await tick()
    await store.add(item('b'))

    const reopened = new HistoryStore(dir)
    const list = await reopened.list()
    expect(list.map((i) => i.id)).toEqual(['b', 'a'])
    expect((await reopened.get('a'))?.prompt).toBe('a cat')
  })

  it('list supports threadId, limit and before', async () => {
    await tick()
    const store = new HistoryStore(dir)
    const thread = await store.createThread('t')
    for (let i = 1; i <= 5; i++) {
      await tick()
      await store.add(item(`i${i}`, i <= 2 ? { threadId: thread.id } : {}))
    }
    expect((await store.list()).map((i) => i.id)).toEqual(['i5', 'i4', 'i3', 'i2', 'i1'])
    expect((await store.list({ threadId: thread.id })).map((i) => i.id)).toEqual(['i2', 'i1'])
    expect((await store.list({ limit: 2 })).map((i) => i.id)).toEqual(['i5', 'i4'])
    const all = await store.list()
    const page2 = await store.list({ before: all[1].createdAt })
    expect(page2.every((i) => i.createdAt < all[1].createdAt)).toBe(true)
  })

  it('remove with deleteFiles removes output files', async () => {
    const store = new HistoryStore(dir)
    await store.add(item('x', { files: [join(dir, 'out.png')] }))
    await writeFile(join(dir, 'out.png'), 'png')
    await store.remove('x', { deleteFiles: true })
    expect(await store.get('x')).toBeNull()
    await expect(readFile(join(dir, 'out.png'))).rejects.toThrow()
  })

  it('remove without deleteFiles keeps files on disk', async () => {
    const store = new HistoryStore(dir)
    await store.add(item('x', { files: [join(dir, 'out.png')] }))
    await writeFile(join(dir, 'out.png'), 'png')
    await store.remove('x', { deleteFiles: false })
    await expect(readFile(join(dir, 'out.png'))).resolves.toEqual(Buffer.from('png'))
  })

  it('thread CRUD: create, rename, touch, delete cascades items only', async () => {
    await tick()
    const store = new HistoryStore(dir)
    const thread = await store.createThread('chat')
    expect((await store.threads()).map((t) => t.title)).toEqual(['chat'])

    await store.add(item('a', { threadId: thread.id, files: [join(dir, 'keep.png')] }))
    await tick()
    await store.add(item('b'))
    await writeFile(join(dir, 'keep.png'), 'img')

    await store.renameThread(thread.id, 'renamed')
    const beforeTouch = (await store.threads()).find((t) => t.id === thread.id)!
    await store.touchThread(thread.id)
    const afterTouch = (await store.threads()).find((t) => t.id === thread.id)!
    expect(afterTouch.title).toBe('renamed')
    expect(afterTouch.updatedAt).toBeGreaterThanOrEqual(beforeTouch.updatedAt)

    await store.deleteThread(thread.id)
    expect((await store.threads()).map((t) => t.title)).toEqual([])
    expect((await store.list()).map((i) => i.id)).toEqual(['b'])
    // the removed thread item's file stays on disk
    await expect(readFile(join(dir, 'keep.png'))).resolves.toEqual(Buffer.from('img'))
  })

  it('survives concurrent adds without corruption', async () => {
    const store = new HistoryStore(dir)
    await Promise.all(
      Array.from({ length: 50 }, (_, i) => store.add(item(`c${i}`, { prompt: `p${i}` }))),
    )
    const reopened = new HistoryStore(dir)
    const list = await reopened.list({ limit: 1000 })
    expect(list).toHaveLength(50)
    expect(new Set(list.map((i) => i.id)).size).toBe(50)
  })

  it('compaction keeps threads and items across a reload', async () => {
    const store = new HistoryStore(dir)
    await store.createThread('chat')
    for (let i = 0; i < 300; i++) {
      await store.add(item(`k${i}`))
      await store.remove(`k${i}`, { deleteFiles: false })
    }
    await store.add(item('survivor'))
    const reopened = new HistoryStore(dir)
    expect((await reopened.list()).map((i) => i.id)).toEqual(['survivor'])
    expect((await reopened.threads()).map((t) => t.title)).toEqual(['chat'])
  })

  it('history dir is created lazily when nested', async () => {
    const nested = join(dir, 'a', 'b')
    const store = new HistoryStore(nested)
    await store.add(item('n'))
    await expect(readFile(join(nested, 'history.jsonl'))).resolves.toBeTruthy()
    void mkdir
  })
})
