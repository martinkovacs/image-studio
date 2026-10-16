import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { ArrowLeft, Check, Download, ExternalLink, FolderOpen, Heart, Lock, Search, Trash2, X } from 'lucide-react'
import type {
  HfDownloadProgress,
  HfLocalRepo,
  HfModelSummary,
  HfQuantGroup,
  HfRepoDetails,
  HfSearchOptions,
  LocalBackendId,
  LocalModelProfile
} from '@shared/types'
import { CATALOG, catalogInstallKey, type CatalogModel } from '@shared/catalog'
import { installFit, ORIGINAL, quantChoices, recommendedArgs, resolveInstall, type InstallFit, type ResolvedInstall } from '@shared/catalogResolve'
import { formatBytes, quantFit } from '@shared/quants'
import { useStore } from '../store'
import { Button, cx, Segmented, Select, TextInput } from '../components/ui'
import { uid } from '../lib/util'
import { BACKEND_LABEL } from './ProfileEditor'

// ---------------------------------------------------------------------------
// Data hooks

/** Repo file lists are fetched once per session; failures are retried on the next request. */
const repoCache = new Map<string, Promise<HfRepoDetails>>()
function fetchRepo(id: string): Promise<HfRepoDetails> {
  let p = repoCache.get(id)
  if (!p) {
    p = window.api.hf.repo(id)
    p.catch(() => repoCache.delete(id))
    repoCache.set(id, p)
  }
  return p
}

function useRepos(ids: string[], enabled = true) {
  const [details, setDetails] = useState<Record<string, HfRepoDetails>>({})
  const [errors, setErrors] = useState<Record<string, string>>({})
  const key = ids.join('|')
  useEffect(() => {
    if (!enabled) return
    let live = true
    for (const id of ids) {
      fetchRepo(id).then(
        (d) => live && setDetails((cur) => ({ ...cur, [id]: d })),
        (e: Error) => live && setErrors((cur) => ({ ...cur, [id]: e.message }))
      )
    }
    return () => {
      live = false
    }
  }, [key, enabled])
  return { details, errors }
}

function useDownloads(): HfDownloadProgress[] {
  const [map, setMap] = useState<Record<string, HfDownloadProgress>>({})
  useEffect(() => {
    void window.api.hf.downloads().then((list) => setMap(Object.fromEntries(list.map((d) => [d.downloadId, d]))))
    return window.api.hf.onProgress((p) => setMap((cur) => ({ ...cur, [p.downloadId]: p })))
  }, [])
  return useMemo(() => Object.values(map), [map])
}

const isActive = (d: HfDownloadProgress) => d.state === 'queued' || d.state === 'downloading' || d.state === 'verifying'

/** Largest NVIDIA/Apple GPU and system RAM, for fit badges. */
function useMemoryBudget(): { vramMiB: number | null; ramMiB: number } {
  const hw = useStore((s) => s.backendInfo?.hardware)
  const vram = hw?.gpus.reduce<number | null>((m, g) => (g.vramMiB !== null && (m === null || g.vramMiB > m) ? g.vramMiB : m), null) ?? null
  return { vramMiB: vram, ramMiB: hw?.ramMiB ?? 16384 }
}

// ---------------------------------------------------------------------------
// Small pieces

const FIT_STYLE = {
  fits: 'border-fixer/40 text-fixer',
  tight: 'border-safelight/50 text-safelight',
  offload: 'border-ink-600 text-ink-300',
  'too-big': 'border-stop/50 text-stop'
} as const
const FIT_LABEL = { fits: 'fits', tight: 'tight', offload: 'needs offload', 'too-big': 'too big' } as const
const FIT_HINT = {
  fits: 'Fits in GPU memory with headroom.',
  tight: 'Just fits in GPU memory; large sizes may run out.',
  offload: 'Larger than VRAM: runs with CPU offload, slower.',
  'too-big': 'Larger than VRAM plus most of system RAM.'
} as const

function FitBadge({ bytes }: { bytes: number }) {
  const { vramMiB, ramMiB } = useMemoryBudget()
  if (!bytes) return null
  const fit = quantFit(bytes, vramMiB, ramMiB)
  return (
    <span title={FIT_HINT[fit]} className={cx('rounded border px-1.5 py-px font-mono text-[10px] uppercase tracking-wide', FIT_STYLE[fit])}>
      {FIT_LABEL[fit]}
    </span>
  )
}

const INSTALL_FIT = {
  fits: { style: FIT_STYLE.fits, label: 'fits', hint: 'Everything fits in GPU memory.' },
  offload: { style: FIT_STYLE.offload, label: 'runs with offload', hint: 'Modules take turns on the GPU; the rest waits in system RAM. Slower, but works.' },
  'too-big': { style: FIT_STYLE['too-big'], label: 'too big', hint: 'The largest module does not fit in VRAM, or the whole model does not fit in VRAM + RAM. Pick a smaller quant.' }
} satisfies Record<InstallFit, { style: string; label: string; hint: string }>

function InstallFitBadge({ resolved, args }: { resolved: ResolvedInstall; args: Record<string, string | number | boolean> }) {
  const { vramMiB, ramMiB } = useMemoryBudget()
  const { fit, largestBytes } = installFit(resolved, args, vramMiB, ramMiB)
  const f = INSTALL_FIT[fit]
  return (
    <span title={`${f.hint} Largest module: ${formatBytes(largestBytes)}.`} className={cx('rounded border px-1.5 py-px font-mono text-[10px] uppercase tracking-wide', f.style)}>
      {f.label}
    </span>
  )
}

function Bar({ value, total }: { value: number; total: number }) {
  const pct = total > 0 ? Math.min(100, (value / total) * 100) : 0
  return (
    <div className="h-[3px] flex-1 overflow-hidden rounded-full bg-ink-700">
      <div className="h-full bg-safelight transition-[width]" style={{ width: `${pct}%` }} />
    </div>
  )
}

function DownloadLine({ d, onCancel }: { d: HfDownloadProgress; onCancel?: () => void }) {
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-3">
        <Bar value={d.bytesDone} total={d.bytesTotal} />
        <span className="shrink-0 font-mono text-[10px] text-ink-400">
          {d.state === 'queued' ? 'queued' : d.state === 'verifying' ? 'verifying' : `${formatBytes(d.bytesDone)} / ${formatBytes(d.bytesTotal)}`}
          {d.speed ? ` · ${formatBytes(d.speed)}/s` : ''}
        </span>
        {onCancel && (
          <button onClick={onCancel} title="Cancel (resumable)" className="text-ink-500 hover:text-stop">
            <X size={12} />
          </button>
        )}
      </div>
      {d.file && <span className="truncate font-mono text-[10px] text-ink-500">{d.file}</span>}
    </div>
  )
}

function HfLink({ repo }: { repo: string }) {
  return (
    <a href={`https://huggingface.co/${repo}`} target="_blank" className="inline-flex items-center gap-1 font-mono text-[11px] text-ink-400 hover:text-safelight">
      {repo} <ExternalLink size={10} />
    </a>
  )
}

function Panel({ children, className }: { children: ReactNode; className?: string }) {
  return <section className={cx('rounded-lg border border-ink-800 bg-ink-900', className)}>{children}</section>
}

// ---------------------------------------------------------------------------
// Supported models (catalog)

function CatalogCard({ model, downloads }: { model: CatalogModel; downloads: HfDownloadProgress[] }) {
  const settings = useStore((s) => s.settings)!
  const backendInfo = useStore((s) => s.backendInfo)
  const update = useStore((s) => s.updateSettings)
  const showError = useStore((s) => s.showError)
  const openSettings = useStore((s) => s.openSettings)
  const available = (['diffusers', 'sdcpp'] as LocalBackendId[]).filter((b) => model.recipes[b])
  const effective = backendInfo?.effective ?? 'sdcpp'
  const [backend, setBackend] = useState<LocalBackendId>(available.includes(effective) ? effective : available[0])
  const [open, setOpen] = useState(false)
  const [quants, setQuants] = useState<Record<string, string>>({})
  const recipe = model.recipes[backend]!
  const repos = [...new Set(recipe.components.map((c) => c.repo))]
  const { details, errors } = useRepos(repos, open)

  let resolved: ResolvedInstall | null = null
  let resolveError: string | null = null
  if (open && repos.every((r) => details[r])) {
    try {
      resolved = resolveInstall(recipe, quants, (r) => details[r])
    } catch (e) {
      resolveError = (e as Error).message
    }
  }

  const { vramMiB } = useMemoryBudget()
  const args = recommendedArgs(recipe, vramMiB)
  const autoTeQuant = args['text-encoder-quant'] !== recipe.args['text-encoder-quant']
  const key = catalogInstallKey(model.id, backend)
  const mine = downloads.filter((d) => d.catalogId === key)
  const running = mine.filter(isActive)
  const failed = mine.find((d) => d.state === 'error')
  const profile = settings.local.profiles.find((p) => p.catalogId === model.id && (p.backend ?? 'sdcpp') === backend)
  const needsToken = recipe.gated && !settings.huggingface.hasToken
  const runtimeMissing = backend === 'diffusers' && backendInfo && !backendInfo.diffusersSupported

  const install = async () => {
    try {
      await window.api.catalog.install({ catalogId: model.id, backend, quants })
    } catch (e) {
      showError((e as Error).message)
    }
  }

  return (
    <Panel className={cx('flex flex-col', profile && 'border-ink-700')}>
      <div className="flex items-start gap-4 p-4">
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2.5">
            <h4 className="font-display text-[15px] font-semibold text-ink-100">{model.label}</h4>
            <span className="text-[12px] text-ink-500">{model.creator}</span>
          </div>
          <p className="mt-1 max-w-xl text-[12px] leading-relaxed text-ink-400">{model.description}</p>
          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[10px] text-ink-500">
            <span title="Artificial Analysis image-editing arena Elo" className="rounded border border-ink-700 px-1.5 py-px text-ink-300">
              Elo {model.elo}
            </span>
            <a href={model.licenceUrl} target="_blank" className="hover:text-ink-200">
              {model.licence}
            </a>
            {available.length === 1 && <span>{BACKEND_LABEL[available[0]]} only</span>}
          </div>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-2">
          {profile ? (
            <div className="flex items-center gap-2">
              <span className="flex items-center gap-1 text-[12px] text-fixer">
                <Check size={13} /> Installed
              </span>
              {settings.local.activeProfileId !== profile.id && (
                <Button size="sm" onClick={() => void update({ local: { activeProfileId: profile.id } })}>
                  Use
                </Button>
              )}
            </div>
          ) : running.length > 0 ? (
            <span className="font-mono text-[11px] text-safelight">downloading…</span>
          ) : (
            <Button size="sm" variant={open ? 'ghost' : 'outline'} onClick={() => setOpen(!open)}>
              {open ? 'Close' : <><Download size={12} /> Get</>}
            </Button>
          )}
        </div>
      </div>

      {running.length > 0 && (
        <div className="flex flex-col gap-2 border-t border-ink-800 px-4 py-3">
          {running.map((d) => (
            <DownloadLine key={d.downloadId} d={d} onCancel={() => void window.api.hf.cancel(d.downloadId)} />
          ))}
        </div>
      )}
      {failed && running.length === 0 && !profile && <p className="border-t border-ink-800 px-4 py-2 text-[11px] text-stop">{failed.error}</p>}

      {open && !profile && running.length === 0 && (
        <div className="flex flex-col gap-3 border-t border-ink-800 p-4">
          {available.length > 1 && (
            <div className="flex items-center gap-3">
              <Segmented<LocalBackendId>
                size="sm"
                value={backend}
                onChange={setBackend}
                options={available.map((b) => ({ value: b, label: BACKEND_LABEL[b] + (b === backendInfo?.autoChoice ? ' · recommended' : '') }))}
              />
            </div>
          )}
          {runtimeMissing && <p className="text-[11px] text-stop">The diffusers backend needs an NVIDIA GPU on Linux or Windows (x64).</p>}
          {needsToken && (
            <p className="flex items-center gap-1.5 text-[11px] text-safelight">
              <Lock size={11} /> Gated repository: accept the licence on huggingface.co, then{' '}
              <button className="underline" onClick={() => openSettings('huggingface')}>
                add a token
              </button>
              .
            </p>
          )}
          <p className="text-[11px] leading-relaxed text-ink-500">{recipe.note}</p>
          {autoTeQuant && <p className="text-[11px] text-ink-400">This GPU has under 24 GB, so the profile quantizes the text encoder to 8-bit.</p>}

          <div className="flex flex-col divide-y divide-ink-800 rounded-md border border-ink-800">
            {recipe.components.map((c) => {
              const d = details[c.repo]
              const rc = resolved?.components.find((x) => x.component.id === c.id)
              const choices = c.kind === 'gguf' && d ? quantChoices(c, d) : []
              return (
                <div key={c.id} className="flex items-center gap-3 px-3 py-2">
                  <div className="min-w-0 flex-1">
                    <div className="text-[12px] text-ink-200">{c.label}</div>
                    <HfLink repo={c.repo} />
                  </div>
                  {c.kind === 'gguf' && d && (
                    <Select
                      className="w-44"
                      value={quants[c.id] ?? c.defaultQuant}
                      onChange={(v) => setQuants({ ...quants, [c.id]: v })}
                      options={[
                        ...(c.originalLabel ? [{ value: ORIGINAL, label: c.originalLabel }] : []),
                        ...choices.map((q) => ({ value: q.quant, label: `${q.quant} · ${formatBytes(q.totalBytes)}` }))
                      ]}
                    />
                  )}
                  <span className="w-16 shrink-0 text-right font-mono text-[11px] text-ink-300">
                    {errors[c.repo] ? '—' : rc ? (rc.bytes ? formatBytes(rc.bytes) : 'none') : '…'}
                  </span>
                </div>
              )
            })}
          </div>
          {Object.entries(errors).map(([repo, msg]) => (
            <p key={repo} className="text-[11px] text-stop">
              {repo}: {msg}
            </p>
          ))}
          {resolveError && <p className="text-[11px] text-stop">{resolveError}</p>}
          <div className="flex items-center gap-3">
            {resolved && (
              <>
                <span className="font-mono text-[12px] text-ink-200">{formatBytes(resolved.totalBytes)} total</span>
                <InstallFitBadge resolved={resolved} args={args} />
              </>
            )}
            <div className="flex-1" />
            <Button variant="primary" size="sm" disabled={!resolved || !!runtimeMissing} onClick={() => void install()}>
              <Download size={12} /> Download &amp; create profile
            </Button>
          </div>
        </div>
      )}
    </Panel>
  )
}

function SupportedTab({ downloads }: { downloads: HfDownloadProgress[] }) {
  return (
    <div className="flex flex-col gap-3">
      <p className="text-[12px] leading-relaxed text-ink-400">
        Open-weights models scoring 1000+ Elo on the{' '}
        <a href="https://artificialanalysis.ai/image/leaderboard/editing?open-weights=true" target="_blank" className="text-safelight hover:underline">
          Artificial Analysis image-editing leaderboard
        </a>{' '}
        that run locally. Each download fetches every file the model needs for the chosen backend and creates a ready-to-use profile. Downloads resume if
        interrupted.
      </p>
      {CATALOG.map((m) => (
        <CatalogCard key={m.id} model={m} downloads={downloads} />
      ))}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Hugging Face search

function RepoView({ id, onBack, downloads }: { id: string; onBack: () => void; downloads: HfDownloadProgress[] }) {
  const showError = useStore((s) => s.showError)
  const { details, errors } = useRepos([id])
  const d = details[id]
  const active = downloads.filter((x) => x.repo === id && isActive(x))
  const [skipTransformer, setSkipTransformer] = useState(false)

  const download = async (files: string[]) => {
    if (!d) return
    try {
      await window.api.hf.download({ repo: id, revision: d.sha, files })
    } catch (e) {
      showError((e as Error).message)
    }
  }

  const byStem = useMemo(() => {
    const m = new Map<string, HfQuantGroup[]>()
    for (const q of d?.quants ?? []) m.set(q.stem, [...(m.get(q.stem) ?? []), q])
    return [...m]
  }, [d])
  const singles = d?.kind !== 'diffusers' ? (d?.files.filter((f) => f.path.endsWith('.safetensors')) ?? []) : []
  const sizeOf = (paths: string[]) => {
    const byPath = new Map(d?.files.map((f) => [f.path, f.size]))
    return paths.reduce((n, p) => n + (byPath.get(p) ?? 0), 0)
  }
  const pipelineFiles = d?.pipelineFiles?.[skipTransformer ? 'withoutTransformer' : 'all'] ?? []

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-3">
        <Button size="sm" variant="ghost" onClick={onBack}>
          <ArrowLeft size={13} /> Results
        </Button>
        <span className="min-w-0 flex-1 truncate font-display text-[15px] font-semibold text-ink-100">{id}</span>
        <a href={`https://huggingface.co/${id}`} target="_blank" className="text-ink-400 hover:text-safelight" title="Open on huggingface.co">
          <ExternalLink size={14} />
        </a>
      </div>
      {errors[id] && <p className="text-[12px] text-stop">{errors[id]}</p>}
      {!d && !errors[id] && <p className="text-[12px] text-ink-500">Loading file list…</p>}
      {d && (
        <>
          <div className="flex flex-wrap gap-x-4 gap-y-1 font-mono text-[11px] text-ink-500">
            <span>{d.kind === 'diffusers' ? 'diffusers pipeline' : d.kind === 'gguf' ? 'GGUF quantizations' : d.kind === 'single-file' ? 'single-file weights' : 'other'}</span>
            {d.license && <span>licence: {d.license}</span>}
            {d.gated && (
              <span className="flex items-center gap-1 text-safelight">
                <Lock size={10} /> gated
              </span>
            )}
            <span>{formatBytes(d.totalBytes)} in repo</span>
          </div>
          {active.map((x) => (
            <DownloadLine key={x.downloadId} d={x} onCancel={() => void window.api.hf.cancel(x.downloadId)} />
          ))}

          {d.kind === 'diffusers' && (
            <Panel className="flex flex-col gap-3 p-4">
              <div className="flex items-center gap-3">
                <div className="flex-1">
                  <div className="text-[13px] text-ink-100">Pipeline folder</div>
                  <div className="text-[11px] text-ink-500">Configs, tokenizers and safetensors weights for the diffusers backend ({pipelineFiles.length} files).</div>
                </div>
                <span className="font-mono text-[12px] text-ink-200">{formatBytes(sizeOf(pipelineFiles))}</span>
                <FitBadge bytes={sizeOf(pipelineFiles)} />
                <Button size="sm" disabled={active.length > 0 || pipelineFiles.length === 0} onClick={() => void download(pipelineFiles)}>
                  <Download size={12} /> Download
                </Button>
              </div>
              <label className="flex items-center gap-2 text-[12px] text-ink-400">
                <input type="checkbox" checked={skipTransformer} onChange={(e) => setSkipTransformer(e.target.checked)} className="accent-[var(--color-safelight)]" />
                Skip transformer weights (pair the folder with a GGUF transformer)
              </label>
            </Panel>
          )}

          {byStem.map(([stem, groups]) => (
            <Panel key={stem} className="overflow-hidden">
              <div className="border-b border-ink-800 px-4 py-2 font-mono text-[11px] text-ink-300">{stem || 'model'}</div>
              <div className="divide-y divide-ink-800">
                {groups.map((q) => (
                  <div key={q.quant} className="flex items-center gap-3 px-4 py-2">
                    <span className="w-28 font-mono text-[12px] text-ink-100">{q.quant}</span>
                    <span className="w-16 font-mono text-[11px] text-ink-500">{q.bits ? `${q.bits} bpw` : ''}</span>
                    <span className="text-[11px] text-ink-500">{q.files.length > 1 ? `${q.files.length} parts` : ''}</span>
                    <div className="flex-1" />
                    <FitBadge bytes={q.totalBytes} />
                    <span className="w-16 text-right font-mono text-[11px] text-ink-300">{formatBytes(q.totalBytes)}</span>
                    <Button size="sm" variant="ghost" disabled={active.length > 0} onClick={() => void download(q.files.map((f) => f.path))} title="Download">
                      <Download size={12} />
                    </Button>
                  </div>
                ))}
              </div>
            </Panel>
          ))}

          {singles.length > 0 && (
            <Panel className="divide-y divide-ink-800">
              {singles.map((f) => (
                <div key={f.path} className="flex items-center gap-3 px-4 py-2">
                  <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-ink-200">{f.path}</span>
                  <span className="font-mono text-[11px] text-ink-300">{formatBytes(f.size)}</span>
                  <Button size="sm" variant="ghost" disabled={active.length > 0} onClick={() => void download([f.path])} title="Download">
                    <Download size={12} />
                  </Button>
                </div>
              ))}
            </Panel>
          )}
          {d.kind === 'other' && <p className="text-[12px] text-ink-500">No GGUF, safetensors or diffusers weights in this repository.</p>}
        </>
      )}
    </div>
  )
}

function SearchTab({ downloads }: { downloads: HfDownloadProgress[] }) {
  const [opts, setOpts] = useState<HfSearchOptions>({ query: '', format: 'gguf', task: 'text-to-image', sort: 'downloads' })
  const [results, setResults] = useState<HfModelSummary[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [repo, setRepo] = useState<string | null>(null)

  const run = async (o: HfSearchOptions) => {
    setBusy(true)
    setError(null)
    try {
      setResults(await window.api.hf.search(o))
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  useEffect(() => {
    void run(opts)
  }, [opts.format, opts.task, opts.sort])

  if (repo) return <RepoView id={repo} onBack={() => setRepo(null)} downloads={downloads} />

  return (
    <div className="flex flex-col gap-3">
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault()
          void run(opts)
        }}
      >
        <div className="relative flex-1">
          <Search size={13} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-500" />
          <TextInput value={opts.query} onChange={(e) => setOpts({ ...opts, query: e.target.value })} placeholder="Search models, e.g. qwen-image, flux.2, unsloth" className="pl-8" />
        </div>
        <Button type="submit" disabled={busy}>
          Search
        </Button>
      </form>
      <div className="flex flex-wrap items-center gap-3">
        <Segmented<HfSearchOptions['format']>
          size="sm"
          value={opts.format}
          onChange={(format) => setOpts({ ...opts, format })}
          options={[
            { value: 'gguf', label: 'GGUF' },
            { value: 'diffusers', label: 'diffusers' },
            { value: 'all', label: 'All' }
          ]}
        />
        <Select
          className="w-40"
          value={opts.task ?? ''}
          placeholder="any task"
          onChange={(v) => setOpts({ ...opts, task: v || null })}
          options={[
            { value: 'text-to-image', label: 'Text to image' },
            { value: 'image-to-image', label: 'Image to image' }
          ]}
        />
        <Select
          className="w-36"
          value={opts.sort ?? 'downloads'}
          onChange={(v) => setOpts({ ...opts, sort: v as HfSearchOptions['sort'] })}
          options={[
            { value: 'downloads', label: 'Most downloaded' },
            { value: 'trendingScore', label: 'Trending' },
            { value: 'likes', label: 'Most liked' },
            { value: 'lastModified', label: 'Recently updated' }
          ]}
        />
      </div>
      {error && <p className="text-[12px] text-stop">{error}</p>}
      <Panel className="divide-y divide-ink-800">
        {results?.map((m) => (
          <button key={m.id} onClick={() => setRepo(m.id)} className="flex w-full items-center gap-3 px-4 py-2.5 text-left hover:bg-ink-850">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5 truncate text-[13px] text-ink-100">
                {m.id}
                {m.gated && <Lock size={11} className="shrink-0 text-safelight" />}
              </div>
              <div className="truncate font-mono text-[10px] text-ink-500">
                {[...new Set([m.pipelineTag, m.libraryName, m.tags.includes('gguf') ? 'gguf' : null].filter(Boolean))].join(' · ')}
              </div>
            </div>
            <span className="flex shrink-0 items-center gap-3 font-mono text-[11px] text-ink-400">
              <span title="Downloads (30 days)">
                <Download size={10} className="mr-1 inline" />
                {m.downloads.toLocaleString()}
              </span>
              <span>
                <Heart size={10} className="mr-1 inline" />
                {m.likes.toLocaleString()}
              </span>
            </span>
          </button>
        ))}
        {results?.length === 0 && <p className="px-4 py-6 text-center text-[12px] text-ink-500">No models found.</p>}
        {!results && busy && <p className="px-4 py-6 text-center text-[12px] text-ink-500">Searching…</p>}
      </Panel>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Downloaded

/** A starting profile for a downloaded repo; the user fills in the rest in the editor. */
function profileFor(r: HfLocalRepo): LocalModelProfile {
  const name = r.repo.split('/')[1]
  if (r.kind === 'diffusers') return { id: uid(), name, backend: 'diffusers', args: { model: r.dir }, extraArgs: '' }
  const main = r.files.find((f) => f.path.endsWith('.gguf') && !/mmproj/i.test(f.path)) ?? r.files.find((f) => f.path.endsWith('.safetensors'))
  return { id: uid(), name, backend: 'sdcpp', args: main ? { 'diffusion-model': main.absPath } : {}, extraArgs: '' }
}

function DownloadedTab({ downloads }: { downloads: HfDownloadProgress[] }) {
  const settings = useStore((s) => s.settings)!
  const update = useStore((s) => s.updateSettings)
  const openSettings = useStore((s) => s.openSettings)
  const showError = useStore((s) => s.showError)
  const [local, setLocal] = useState<HfLocalRepo[] | null>(null)
  const load = () => void window.api.hf.local().then(setLocal, (e: Error) => showError(e.message))
  const doneCount = downloads.filter((d) => d.state === 'done').length
  useEffect(load, [doneCount, settings.local.modelsDir])
  const active = downloads.filter(isActive)
  const recentErrors = downloads.filter((d) => d.state === 'error').slice(-3)

  return (
    <div className="flex flex-col gap-4">
      {active.length > 0 && (
        <Panel className="flex flex-col gap-3 p-4">
          <h4 className="font-display text-[13px] font-semibold text-ink-200">Downloading</h4>
          {active.map((d) => (
            <div key={d.downloadId} className="flex flex-col gap-1">
              <span className="text-[12px] text-ink-200">
                {d.repo} <span className="font-mono text-[10px] text-ink-500">({d.filesDone}/{d.filesTotal} files)</span>
              </span>
              <DownloadLine d={d} onCancel={() => void window.api.hf.cancel(d.downloadId)} />
            </div>
          ))}
        </Panel>
      )}
      {recentErrors.map((d) => (
        <p key={d.downloadId} className="text-[12px] text-stop">
          {d.repo}: {d.error}
        </p>
      ))}
      <Panel className="divide-y divide-ink-800">
        {local?.map((r) => (
          <div key={r.repo} className="flex items-center gap-3 px-4 py-2.5">
            <div className="min-w-0 flex-1">
              <div className="truncate text-[13px] text-ink-100">{r.repo}</div>
              <div className="font-mono text-[10px] text-ink-500">
                {r.kind} · {r.files.length} files
              </div>
            </div>
            <span className="font-mono text-[11px] text-ink-300">{formatBytes(r.totalBytes)}</span>
            <Button
              size="sm"
              variant="ghost"
              title="New profile from these files"
              onClick={async () => {
                await update({ local: { profiles: [...settings.local.profiles, profileFor(r)] } })
                openSettings('profiles')
              }}
            >
              Profile
            </Button>
            <Button size="sm" variant="ghost" title="Show in folder" onClick={() => void window.api.hf.revealLocal(r.repo)}>
              <FolderOpen size={12} />
            </Button>
            <Button
              size="sm"
              variant="ghost"
              title="Delete files"
              className="text-ink-500 hover:text-stop"
              onClick={async () => {
                if (!confirm(`Delete ${r.repo} (${formatBytes(r.totalBytes)}) from disk? Profiles using it stop working.`)) return
                await window.api.hf.removeLocal(r.repo).catch((e: Error) => showError(e.message))
                load()
              }}
            >
              <Trash2 size={12} />
            </Button>
          </div>
        ))}
        {local?.length === 0 && <p className="px-4 py-6 text-center text-[12px] text-ink-500">Nothing downloaded yet.</p>}
      </Panel>
      <p className="font-mono text-[11px] text-ink-500">
        {settings.local.modelsDir}{' '}
        <button className="ml-2 text-ink-400 underline hover:text-ink-100" onClick={() => openSettings('huggingface')}>
          change
        </button>
      </p>
    </div>
  )
}

// ---------------------------------------------------------------------------

type BrowserTab = 'supported' | 'search' | 'downloaded'

export function ModelBrowser() {
  const [tab, setTab] = useState<BrowserTab>('supported')
  const downloads = useDownloads()
  const activeCount = downloads.filter(isActive).length
  return (
    <>
      <Segmented<BrowserTab>
        value={tab}
        onChange={setTab}
        options={[
          { value: 'supported', label: 'Supported models' },
          { value: 'search', label: 'Search Hugging Face' },
          { value: 'downloaded', label: activeCount ? `Downloads · ${activeCount}` : 'Downloaded' }
        ]}
      />
      {tab === 'supported' && <SupportedTab downloads={downloads} />}
      {tab === 'search' && <SearchTab downloads={downloads} />}
      {tab === 'downloaded' && <DownloadedTab downloads={downloads} />}
    </>
  )
}
