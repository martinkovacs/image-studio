import { useMemo, useState } from 'react'
import { History } from 'lucide-react'
import { imgUrl, type HistoryItem } from '@shared/types'
import { useStore } from '../store'
import { Button, cx, Empty, Segmented } from '../components/ui'
import { timeAgo } from '../lib/util'

type Filter = 'all' | 'openrouter' | 'local'

function dayLabel(ts: number): string {
  const d = new Date(ts)
  const today = new Date()
  const yesterday = new Date(Date.now() - 86400000)
  if (d.toDateString() === today.toDateString()) return 'Today'
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday'
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: d.getFullYear() === today.getFullYear() ? undefined : 'numeric' })
}

function Tile({ item, selected }: { item: HistoryItem; selected: boolean }) {
  const file = item.files[0]
  return (
    <button
      draggable
      onDragStart={(e) => e.dataTransfer.setData('application/x-studio-image', file)}
      onClick={() => useStore.setState({ selected: { id: item.id, fileIndex: 0 } })}
      className={cx(
        'group relative aspect-square overflow-hidden rounded-md border bg-ink-850 transition-all',
        selected ? 'border-safelight ring-1 ring-safelight/60' : 'border-ink-800 hover:border-ink-600'
      )}
    >
      {file && <img src={imgUrl(file)} loading="lazy" draggable={false} className="h-full w-full object-cover" />}
      {(item.files.length > 1 || item.kind === 'upscale') && (
        <span className="absolute right-1 top-1 rounded bg-ink-950/85 px-1 font-mono text-[9px] text-ink-200">
          {item.kind === 'upscale' ? 'UP' : item.files.length}
        </span>
      )}
      <span className="absolute inset-x-0 bottom-0 hidden bg-gradient-to-t from-ink-950/95 to-transparent px-1.5 pb-1 pt-4 text-left group-hover:block">
        <span className="block truncate font-mono text-[9px] text-ink-200">{item.model.split('/').pop()}</span>
        <span className="block font-mono text-[9px] text-ink-400">{timeAgo(item.createdAt)}</span>
      </span>
    </button>
  )
}

export function HistoryStrip() {
  const history = useStore((s) => s.history)
  const selected = useStore((s) => s.selected)
  const jobs = useStore((s) => s.jobs)
  const [filter, setFilter] = useState<Filter>('all')
  const [loadingMore, setLoadingMore] = useState(false)
  const [exhausted, setExhausted] = useState(false)

  const groups = useMemo(() => {
    const out: { label: string; items: HistoryItem[] }[] = []
    for (const item of history) {
      if (filter !== 'all' && item.provider !== filter) continue
      const label = dayLabel(item.createdAt)
      const last = out[out.length - 1]
      if (last?.label === label) last.items.push(item)
      else out.push({ label, items: [item] })
    }
    return out
  }, [history, filter])

  const selectedId = selected?.id ?? history[0]?.id
  const running = Object.values(jobs)

  const loadMore = async () => {
    const oldest = history[history.length - 1]
    if (!oldest) return
    setLoadingMore(true)
    try {
      const more = await window.api.history.list({ before: oldest.createdAt, limit: 200 })
      if (more.length === 0) setExhausted(true)
      const ids = new Set(history.map((h) => h.id))
      useStore.setState({ history: [...useStore.getState().history, ...more.filter((m) => !ids.has(m.id))] })
    } finally {
      setLoadingMore(false)
    }
  }

  return (
    <aside className="flex w-[212px] shrink-0 flex-col border-l border-ink-800 bg-ink-900">
      <div className="flex flex-col gap-2 border-b border-ink-800 px-3 py-2.5">
        <div className="flex items-baseline justify-between">
          <span className="font-display text-[13px] font-semibold text-ink-200">History</span>
          <span className="font-mono text-[10px] text-ink-500">{history.length}</span>
        </div>
        <Segmented<Filter>
          size="sm"
          value={filter}
          onChange={setFilter}
          options={[
            { value: 'all', label: 'All' },
            { value: 'openrouter', label: 'Cloud' },
            { value: 'local', label: 'Local' }
          ]}
        />
      </div>
      <div className="flex-1 overflow-y-auto px-2.5 py-2">
        {running.length > 0 && (
          <div className="mb-3 grid grid-cols-2 gap-1.5">
            {running.map((j) => (
              <div key={j.id} className="checker relative flex aspect-square items-end overflow-hidden rounded-md border border-safelight/40">
                <div className="absolute inset-0 animate-pulse bg-safelight/5" />
                <div className="absolute inset-x-0 top-0 h-1/2 bg-gradient-to-b from-safelight/15 to-transparent [animation:scan_2.4s_linear_infinite]" />
                <span className="relative w-full bg-ink-950/80 px-1.5 py-0.5 font-mono text-[9px] text-safelight">
                  {j.progress?.step != null && j.progress.totalSteps ? `${j.progress.step}/${j.progress.totalSteps}` : (j.progress?.stage ?? 'queued')}
                </span>
              </div>
            ))}
          </div>
        )}
        {groups.length === 0 && running.length === 0 && (
          <Empty icon={<History size={32} strokeWidth={1.2} />} title="No images">
            Everything you generate is saved to disk with its settings.
          </Empty>
        )}
        {groups.map((g) => (
          <div key={g.label} className="mb-3">
            <div className="label-caps mb-1.5 px-0.5">{g.label}</div>
            <div className="grid grid-cols-2 gap-1.5">
              {g.items.map((item) => (
                <Tile key={item.id} item={item} selected={item.id === selectedId} />
              ))}
            </div>
          </div>
        ))}
        {history.length >= 200 && !exhausted && (
          <Button size="sm" variant="ghost" className="w-full" disabled={loadingMore} onClick={() => void loadMore()}>
            {loadingMore ? 'Loading…' : 'Load more'}
          </Button>
        )}
      </div>
    </aside>
  )
}
