// Append-log based persistence for generation history and chat threads.
// No electron imports; the index directory is passed in by the caller.
import { appendFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import type { ChatThread, HistoryItem } from '../shared/types'

export interface ListOptions {
  threadId?: string
  limit?: number
  /** Only items with createdAt strictly below this value (for pagination). */
  before?: number
  after?: number
}

/**
 * Record shapes of the append-only log (`history.jsonl`). One JSON value per line:
 * item additions/removals (tombstones) and thread mutations, in chronological order.
 */
type LogRecord =
  | { t: 'item'; v: HistoryItem }
  | { t: 'item-del'; id: string }
  | { t: 'thread'; v: ChatThread }
  | { t: 'thread-del'; id: string }
  | { t: 'thread-rename'; id: string; title: string }
  | { t: 'thread-touch'; id: string; at: number }

const COMPACT_AFTER_TOMBSTONES = 256

export class HistoryStore {
  private readonly file: string
  private items = new Map<string, HistoryItem>()
  private threadById = new Map<string, ChatThread>()
  private tombstones = 0
  private loaded: Promise<void> | null = null
  // Serializes all mutating operations so log writes cannot interleave.
  private queue: Promise<unknown> = Promise.resolve()

  constructor(indexDir: string) {
    this.file = `${indexDir}/history.jsonl`
  }

  /** Loads the log once; subsequent calls return the same promise. */
  private load(): Promise<void> {
    this.loaded ??= (async () => {
      await mkdir(dirOf(this.file), { recursive: true }).catch(() => undefined)
      let text = ''
      try {
        text = await readFile(this.file, 'utf8')
      } catch {
        return // no history yet
      }
      for (const line of text.split('\n')) {
        if (!line.trim()) continue
        let rec: LogRecord
        try {
          rec = JSON.parse(line) as LogRecord
        } catch {
          continue // torn or corrupt line (e.g. crash mid-write): skip
        }
        this.apply(rec)
      }
    })()
    return this.loaded
  }

  private apply(rec: LogRecord): void {
    switch (rec.t) {
      case 'item':
        this.items.set(rec.v.id, rec.v)
        break
      case 'item-del':
        if (this.items.delete(rec.id)) this.tombstones++
        break
      case 'thread':
        this.threadById.set(rec.v.id, rec.v)
        break
      case 'thread-del':
        this.threadById.delete(rec.id)
        if (this.items.size > 0) {
          for (const item of [...this.items.values()]) {
            if (item.threadId === rec.id) {
              this.items.delete(item.id)
              this.tombstones++
            }
          }
        }
        this.tombstones++
        break
      case 'thread-rename': {
        const t = this.threadById.get(rec.id)
        if (t) this.threadById.set(rec.id, { ...t, title: rec.title })
        break
      }
      case 'thread-touch': {
        const t = this.threadById.get(rec.id)
        if (t) this.threadById.set(rec.id, { ...t, updatedAt: rec.at })
        break
      }
    }
  }

  private serialize<T>(op: () => Promise<T>): Promise<T> {
    const next = this.queue.then(op)
    this.queue = next.catch(() => undefined)
    return next
  }

  private async append(rec: LogRecord): Promise<void> {
    await this.load()
    await this.serialize(async () => {
      this.apply(rec)
      const line = `${JSON.stringify(rec)}\n`
      try {
        await appendFile(this.file, line)
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
          await mkdir(dirOf(this.file), { recursive: true })
          await appendFile(this.file, line)
        } else {
          throw e
        }
      }
      if (this.tombstones > COMPACT_AFTER_TOMBSTONES) await this.compact()
    })
  }

  /** Rewrites the log with only live records. Caller must hold the write lock. */
  private async compact(): Promise<void> {
    // Map values must be re-wrapped into log records.
    const records: LogRecord[] = [
      ...[...this.threadById.values()].map((v) => ({ t: 'thread' as const, v })),
      ...[...this.items.values()].map((v) => ({ t: 'item' as const, v })),
    ]
    const tmp = `${this.file}.tmp`
    await writeFile(tmp, records.map((r) => JSON.stringify(r)).join('\n') + '\n')
    await rename(tmp, this.file)
    this.tombstones = 0
  }

  async list(opts: ListOptions = {}): Promise<HistoryItem[]> {
    await this.load()
    const limit = opts.limit ?? 200
    const out: HistoryItem[] = []
    // Map preserves insertion order; newest-last on disk, so walk in reverse.
    const all = [...this.items.values()]
    for (let i = all.length - 1; i >= 0 && out.length < limit; i--) {
      const it = all[i]
      if (opts.threadId !== undefined && it.threadId !== opts.threadId) continue
      if (opts.before !== undefined && it.createdAt >= opts.before) continue
      if (opts.after !== undefined && it.createdAt <= opts.after) continue
      out.push(it)
    }
    return out
  }

  async add(item: HistoryItem): Promise<void> {
    await this.append({ t: 'item', v: item })
  }

  /** True when `path` is an output or input file of some history item. */
  async hasFile(path: string): Promise<boolean> {
    await this.load()
    for (const item of this.items.values()) {
      if (item.files.includes(path) || item.inputFiles.includes(path)) return true
    }
    return false
  }

  async get(id: string): Promise<HistoryItem | null> {
    await this.load()
    return this.items.get(id) ?? null
  }

  async remove(id: string, opts: { deleteFiles: boolean }): Promise<void> {
    await this.load()
    const item = this.items.get(id)
    if (opts.deleteFiles && item) {
      await Promise.all(
        [...item.files, ...item.inputFiles].map((p) => rm(p, { force: true })),
      )
    }
    await this.append({ t: 'item-del', id })
  }

  async threads(): Promise<ChatThread[]> {
    await this.load()
    return [...this.threadById.values()].sort((a, b) => b.updatedAt - a.updatedAt)
  }

  async createThread(title: string): Promise<ChatThread> {
    const now = Date.now()
    const thread: ChatThread = { id: randomUUID(), title, createdAt: now, updatedAt: now }
    await this.append({ t: 'thread', v: thread })
    return thread
  }

  async renameThread(id: string, title: string): Promise<void> {
    if (!this.threadById.get(id)) throw new Error(`Unknown thread: ${id}`)
    await this.append({ t: 'thread-rename', id, title })
  }

  async touchThread(id: string): Promise<void> {
    if (!this.threadById.get(id)) throw new Error(`Unknown thread: ${id}`)
    await this.append({ t: 'thread-touch', id, at: Date.now() })
  }

  async deleteThread(id: string): Promise<void> {
    await this.load()
    if (!this.threadById.get(id)) throw new Error(`Unknown thread: ${id}`)
    await this.append({ t: 'thread-del', id })
  }
}

function dirOf(p: string): string {
  const i = p.lastIndexOf('/')
  return i > 0 ? p.slice(0, i) : '/'
}
