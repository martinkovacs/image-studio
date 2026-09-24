import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Check, Cloud, Copy, Cpu, Download, FolderOpen, HardDrive, KeyRound, Layers, Palette, Play, RefreshCw, ScrollText, Square } from 'lucide-react'
import type { EngineInfo, EngineInstallProgress, LocalModelProfile } from '@shared/types'
import { useStore } from '../store'
import { Button, Combobox, cx, Field, NumberInput, Segmented, TextInput } from '../components/ui'
import { uid } from '../lib/util'
import { ServerDot } from '../studio/ModelPicker'
import { ProfileEditor } from './ProfileEditor'

type Tab = 'general' | 'openrouter' | 'engine' | 'profiles' | 'log'

const TABS: { id: Tab; label: string; icon: ReactNode }[] = [
  { id: 'general', label: 'General', icon: <Palette size={15} /> },
  { id: 'openrouter', label: 'OpenRouter', icon: <Cloud size={15} /> },
  { id: 'engine', label: 'Local engine', icon: <Cpu size={15} /> },
  { id: 'profiles', label: 'Local models', icon: <Layers size={15} /> },
  { id: 'log', label: 'Server log', icon: <ScrollText size={15} /> }
]

function Card({ title, children, aside }: { title: string; children: ReactNode; aside?: ReactNode }) {
  return (
    <section className="rounded-lg border border-ink-800 bg-ink-900 p-5">
      <div className="mb-4 flex items-center justify-between">
        <h3 className="font-display text-[15px] font-semibold text-ink-100">{title}</h3>
        {aside}
      </div>
      <div className="flex flex-col gap-4">{children}</div>
    </section>
  )
}

function Row({ label, desc, children }: { label: string; desc?: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-6">
      <div>
        <div className="text-[13px] text-ink-100">{label}</div>
        {desc && <div className="mt-0.5 max-w-md text-[12px] leading-snug text-ink-500">{desc}</div>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  )
}

// ---------------------------------------------------------------------------

function GeneralTab() {
  const settings = useStore((s) => s.settings)!
  const update = useStore((s) => s.updateSettings)
  return (
    <>
      <Card title="Interface">
        <Row label="Mode" desc="Studio is the full editor. Chat is a minimal conversational UI that builds on the previous image.">
          <Segmented value={settings.uiMode} onChange={(v) => void update({ uiMode: v })} options={[{ value: 'studio', label: 'Studio' }, { value: 'chat', label: 'Chat' }]} />
        </Row>
        <Row label="Studio detail" desc="Advanced adds inpainting, img2img, hires fix, upscaling, LoRA, VAE tiling, step caching and every sampler parameter.">
          <Segmented value={settings.studioDetail} onChange={(v) => void update({ studioDetail: v })} options={[{ value: 'simple', label: 'Simple' }, { value: 'advanced', label: 'Advanced' }]} />
        </Row>
        <Row label="Theme">
          <Segmented
            value={settings.theme}
            onChange={(v) => void update({ theme: v })}
            options={[{ value: 'dark', label: 'Dark' }, { value: 'light', label: 'Light' }, { value: 'system', label: 'System' }]}
          />
        </Row>
      </Card>
      <Card title="Storage">
        <Field label="Output folder" hint="Every image is saved here with a .json sidecar holding its full settings.">
          <div className="flex gap-2">
            <TextInput readOnly value={settings.outputDir} className="font-mono text-[11px]" />
            <Button
              onClick={async () => {
                const p = await window.api.settings.pickPath({ kind: 'directory', title: 'Output folder' })
                if (p) await update({ outputDir: p })
              }}
            >
              <FolderOpen size={13} /> Change…
            </Button>
          </div>
        </Field>
      </Card>
    </>
  )
}

// ---------------------------------------------------------------------------

function OpenRouterTab() {
  const settings = useStore((s) => s.settings)!
  const update = useStore((s) => s.updateSettings)
  const orModels = useStore((s) => s.orModels)
  const [key, setKey] = useState('')
  const [credits, setCredits] = useState<{ total: number; used: number } | null | undefined>(undefined)
  const showError = useStore((s) => s.showError)

  const refreshSettings = async () => useStore.setState({ settings: await window.api.settings.get() })
  const loadCredits = async () => setCredits(await window.api.openrouter.credits().catch(() => null))
  useEffect(() => {
    if (settings.openrouter.hasApiKey) void loadCredits()
  }, [settings.openrouter.hasApiKey])

  const fourK = orModels.filter((m) => {
    const r = m.supported_parameters.resolution
    return r?.type === 'enum' && r.values.includes('4K')
  })

  return (
    <>
      <Card title="API key">
        {settings.openrouter.hasApiKey ? (
          <div className="flex items-center justify-between">
            <span className="flex items-center gap-2 text-[13px] text-ink-200">
              <Check size={14} className="text-fixer" /> Key stored, encrypted with the OS keychain
            </span>
            <Button
              variant="danger"
              size="sm"
              onClick={async () => {
                await window.api.settings.setOpenRouterKey(null)
                await refreshSettings()
                setCredits(undefined)
              }}
            >
              Remove
            </Button>
          </div>
        ) : (
          <div className="flex gap-2">
            <TextInput type="password" value={key} onChange={(e) => setKey(e.target.value)} placeholder="sk-or-v1-…" className="font-mono" />
            <Button
              variant="primary"
              disabled={!key.trim()}
              onClick={async () => {
                try {
                  await window.api.settings.setOpenRouterKey(key)
                  setKey('')
                  await refreshSettings()
                } catch (err) {
                  showError((err as Error).message)
                }
              }}
            >
              <KeyRound size={13} /> Save
            </Button>
          </div>
        )}
        <p className="text-[12px] text-ink-500">
          Create a key at{' '}
          <a href="https://openrouter.ai/keys" target="_blank" className="text-safelight hover:underline">
            openrouter.ai/keys
          </a>
          . It never leaves the main process.
        </p>
        {settings.openrouter.hasApiKey && (
          <Row label="Credits remaining">
            <span className="flex items-center gap-2 font-mono text-[13px] text-ink-100">
              {credits === undefined ? '…' : credits === null ? 'unavailable' : `$${(credits.total - credits.used).toFixed(2)}`}
              <button onClick={() => void loadCredits()} className="text-ink-400 hover:text-ink-100">
                <RefreshCw size={12} />
              </button>
            </span>
          </Row>
        )}
      </Card>
      <Card title="Default model">
        <Combobox
          value={settings.openrouter.defaultModel}
          onChange={(v) => void update({ openrouter: { defaultModel: v } })}
          items={orModels.map((m) => ({ value: m.id, label: m.name, sub: m.id }))}
        />
      </Card>
      <Card title="4K output">
        <p className="text-[12px] leading-relaxed text-ink-400">
          OpenRouter's Image API normalizes size as <code className="font-mono text-ink-200">resolution</code> tiers (512 · 1K · 2K · 4K) plus{' '}
          <code className="font-mono text-ink-200">aspect_ratio</code>. Each model declares which tiers it supports; the studio only offers those. Models without
          a 4K tier top out at 1K/2K or only accept an aspect ratio. For those, use a 4K-capable model, or upscale locally.
        </p>
        <div className="flex flex-wrap gap-1.5">
          {fourK.map((m) => (
            <span key={m.id} className="rounded border border-safelight/40 bg-safelight/5 px-2 py-1 font-mono text-[11px] text-ink-200">
              {m.id}
            </span>
          ))}
          {fourK.length === 0 && <span className="text-[12px] text-ink-500">Model list not loaded.</span>}
        </div>
      </Card>
    </>
  )
}

// ---------------------------------------------------------------------------

function CodeLine({ text }: { text: string }) {
  return (
    <div className="flex items-center justify-between gap-2 rounded-md border border-ink-800 bg-ink-950 px-3 py-2 font-mono text-[12px] text-ink-200">
      <span className="select-text">{text}</span>
      <button onClick={() => void navigator.clipboard.writeText(text)} className="text-ink-400 hover:text-ink-100">
        <Copy size={12} />
      </button>
    </div>
  )
}

function EngineTab() {
  const settings = useStore((s) => s.settings)!
  const update = useStore((s) => s.updateSettings)
  const showError = useStore((s) => s.showError)
  const [info, setInfo] = useState<EngineInfo | null>(null)
  const [progress, setProgress] = useState<Record<string, EngineInstallProgress>>({})
  const [devices, setDevices] = useState<string[] | null>(null)
  const [custom, setCustom] = useState(settings.local.customServerPath)

  const load = async () => setInfo(await window.api.engine.info())
  useEffect(() => {
    void load()
    return window.api.engine.onInstallProgress((p) => {
      setProgress((cur) => ({ ...cur, [p.variantId]: p }))
      if (p.phase === 'done') void load()
    })
  }, [])

  const selected = settings.local.engineVariant
  const effectiveSelected = selected || info?.variants.find((v) => v.installed || v.bundled)?.id

  const install = async (id: string) => {
    try {
      await window.api.engine.install(id)
      if (!selected) await update({ local: { engineVariant: id } })
    } catch (err) {
      showError((err as Error).message)
      setProgress((cur) => ({ ...cur, [id]: { variantId: id, phase: 'error', error: (err as Error).message } }))
    }
  }

  return (
    <>
      <Card
        title="stable-diffusion.cpp"
        aside={<span className="font-mono text-[11px] text-ink-500">latest {info?.latestVersion ?? '…'}</span>}
      >
        <p className="text-[12px] leading-relaxed text-ink-400">
          The app runs <code className="font-mono text-ink-200">sd-server</code> from stable-diffusion.cpp locally. Pick the build for your GPU. Vulkan works on NVIDIA,
          AMD and Intel; CUDA is usually fastest on NVIDIA.
        </p>
        <div className="flex flex-col divide-y divide-ink-800 rounded-md border border-ink-800">
          {info?.variants.map((v) => {
            const p = progress[v.id]
            const busy = p && (p.phase === 'downloading' || p.phase === 'extracting')
            const pct = p?.total ? ((p.received ?? 0) / p.total) * 100 : undefined
            return (
              <div key={v.id} className="flex flex-col gap-2 px-4 py-3">
                <div className="flex items-center gap-3">
                  <input
                    type="radio"
                    name="engine"
                    checked={effectiveSelected === v.id}
                    disabled={!v.installed && !v.bundled}
                    onChange={() => void update({ local: { engineVariant: v.id } })}
                    className="accent-[var(--color-safelight)]"
                  />
                  <div className="min-w-0 flex-1">
                    <div className="text-[13px] text-ink-100">{v.label}</div>
                    <div className="font-mono text-[10px] text-ink-500">
                      {v.bundled && (v.installed ? 'bundled · ' : 'bundled')}
                      {v.installed ? `installed ${v.installedVersion ?? ''}` : v.bundled ? '' : 'not installed'}
                    </div>
                  </div>
                  {v.assetPattern ? (
                    <Button size="sm" disabled={busy} onClick={() => void install(v.id)}>
                      <Download size={12} />
                      {v.installed ? (v.installedVersion !== info.latestVersion ? 'Update' : 'Reinstall') : 'Install'}
                    </Button>
                  ) : (
                    <span className="font-mono text-[10px] text-ink-500">source build</span>
                  )}
                </div>
                {busy && (
                  <div className="flex items-center gap-3 pl-7">
                    <div className="h-[3px] flex-1 overflow-hidden rounded-full bg-ink-700">
                      <div className="h-full bg-safelight transition-[width]" style={{ width: `${pct ?? 100}%` }} />
                    </div>
                    <span className="font-mono text-[10px] text-ink-400">
                      {p.phase === 'extracting' ? 'extracting' : `${((p.received ?? 0) / 1e6).toFixed(0)}${p.total ? ` / ${(p.total / 1e6).toFixed(0)}` : ''} MB`}
                    </span>
                  </div>
                )}
                {p?.phase === 'error' && <p className="pl-7 text-[11px] text-stop">{p.error}</p>}
                {v.id === 'linux-cuda-source' && (
                  <div className="flex flex-col gap-1.5 pl-7 text-[12px] text-ink-500">
                    No official Linux CUDA build exists. Build it once (needs the CUDA toolkit, cmake and git); it installs here automatically:
                    <CodeLine text="npm run build-sdcpp-cuda" />
                  </div>
                )}
              </div>
            )
          })}
          <div className="flex flex-col gap-2 px-4 py-3">
            <div className="flex items-center gap-3">
              <input
                type="radio"
                name="engine"
                checked={selected === 'custom'}
                onChange={() => void update({ local: { engineVariant: 'custom', customServerPath: custom } })}
                className="accent-[var(--color-safelight)]"
              />
              <span className="text-[13px] text-ink-100">Custom sd-server binary</span>
            </div>
            <div className="flex gap-2 pl-7">
              <TextInput
                value={custom}
                onChange={(e) => setCustom(e.target.value)}
                onBlur={() => void update({ local: { customServerPath: custom } })}
                placeholder="/path/to/sd-server"
                className="font-mono text-[11px]"
              />
              <Button
                onClick={async () => {
                  const p = await window.api.settings.pickPath({ kind: 'file', title: 'sd-server binary' })
                  if (p) {
                    setCustom(p)
                    await update({ local: { engineVariant: 'custom', customServerPath: p } })
                  }
                }}
              >
                <FolderOpen size={13} />
              </Button>
            </div>
          </div>
        </div>
        <Row label="Resolved binary">
          <span className={cx('max-w-md truncate font-mono text-[11px]', info?.serverPath ? 'text-ink-300' : 'text-stop')}>
            {info ? (info.serverPath ?? 'none — install an engine') : '…'}
          </span>
        </Row>
      </Card>
      <Card title="Runtime">
        <Row label="Server port" desc="Local only (127.0.0.1). The next free port is used if taken.">
          <NumberInput value={settings.local.listenPort} min={1024} max={65535} onChange={(v) => v && void update({ local: { listenPort: v } })} className="w-24" />
        </Row>
        <Row label="Compute devices" desc="Names usable in a profile's Backend field, e.g. diffusion=cuda0,vae=cpu.">
          <Button size="sm" onClick={async () => setDevices(await window.api.local.listDevices())}>
            <HardDrive size={12} /> Detect
          </Button>
        </Row>
        {devices && (
          <pre className="select-text rounded-md border border-ink-800 bg-ink-950 p-3 font-mono text-[11px] text-ink-300">
            {devices.length ? devices.join('\n') : 'No devices reported (is an engine installed?)'}
          </pre>
        )}
      </Card>
    </>
  )
}

// ---------------------------------------------------------------------------

function ProfilesTab() {
  const settings = useStore((s) => s.settings)!
  const update = useStore((s) => s.updateSettings)
  const status = useStore((s) => s.serverStatus)
  const [editing, setEditing] = useState<LocalModelProfile | null>(null)
  const [restartId, setRestartId] = useState<string | null>(null)
  const profiles = settings.local.profiles

  const saveProfiles = (list: LocalModelProfile[]) => update({ local: { profiles: list } })

  if (editing) {
    return (
      <ProfileEditor
        initial={editing}
        onCancel={() => setEditing(null)}
        onSave={async (p) => {
          const exists = profiles.some((x) => x.id === p.id)
          await saveProfiles(exists ? profiles.map((x) => (x.id === p.id ? p : x)) : [...profiles, p])
          if (!settings.local.activeProfileId) await update({ local: { activeProfileId: p.id } })
          if (status.profileId === p.id && status.state !== 'stopped') setRestartId(p.id)
          setEditing(null)
        }}
      />
    )
  }

  const mainFile = (p: LocalModelProfile) => String(p.args['diffusion-model'] ?? p.args['model'] ?? '').split(/[\\/]/).pop()

  return (
    <>
      <p className="text-[13px] leading-relaxed text-ink-400">
        A profile tells sd.cpp which weight files to load and how. It works with any model family sd.cpp supports; once loaded, the model's own sampler and
        size defaults appear in the studio.
      </p>
      {restartId && (
        <div className="flex items-center justify-between rounded-md border border-safelight/40 bg-safelight/5 px-4 py-2.5 text-[13px]">
          The running model uses the old settings.
          <Button
            size="sm"
            variant="primary"
            onClick={async () => {
              await window.api.local.stop()
              await window.api.local.start(restartId).catch((e) => useStore.getState().showError((e as Error).message))
              setRestartId(null)
            }}
          >
            Restart server
          </Button>
        </div>
      )}
      <div className="grid grid-cols-2 gap-3">
        {profiles.map((p) => {
          const active = p.id === settings.local.activeProfileId
          return (
            <div key={p.id} className={cx('flex flex-col gap-3 rounded-lg border bg-ink-900 p-4', active ? 'border-safelight/50' : 'border-ink-800')}>
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="truncate font-display text-[14px] font-semibold text-ink-100">{p.name}</div>
                  <div className="truncate font-mono text-[10px] text-ink-500">{mainFile(p) || 'no model file'}</div>
                </div>
                {active && <span className="rounded bg-safelight/15 px-1.5 py-0.5 font-mono text-[10px] text-safelight">active</span>}
              </div>
              <div className="flex gap-1.5">
                <Button size="sm" onClick={() => setEditing(p)}>
                  Edit
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setEditing({ ...p, id: uid(), name: `${p.name} copy` })}>
                  Duplicate
                </Button>
                {!active && (
                  <Button size="sm" variant="ghost" onClick={() => void update({ local: { activeProfileId: p.id } })}>
                    Set active
                  </Button>
                )}
                <div className="flex-1" />
                <Button
                  size="sm"
                  variant="ghost"
                  className="text-ink-500 hover:text-stop"
                  onClick={async () => {
                    if (!confirm(`Delete profile "${p.name}"? Model files are not touched.`)) return
                    await saveProfiles(profiles.filter((x) => x.id !== p.id))
                    if (active) await update({ local: { activeProfileId: null } })
                  }}
                >
                  Delete
                </Button>
              </div>
            </div>
          )
        })}
        <button
          onClick={() => setEditing({ id: uid(), name: '', args: {}, extraArgs: '' })}
          className="flex min-h-28 items-center justify-center rounded-lg border border-dashed border-ink-700 text-[13px] text-ink-400 hover:border-safelight/60 hover:text-ink-100"
        >
          + New profile
        </button>
      </div>
    </>
  )
}

// ---------------------------------------------------------------------------

function LogTab() {
  const settings = useStore((s) => s.settings)!
  const status = useStore((s) => s.serverStatus)
  const [lines, setLines] = useState<string[]>([])
  const box = useRef<HTMLPreElement>(null)
  const stick = useRef(true)

  useEffect(() => {
    void window.api.local.logs().then(setLines)
    return window.api.local.onLog((line) => setLines((cur) => [...cur.slice(-2999), line]))
  }, [])
  useEffect(() => {
    if (stick.current && box.current) box.current.scrollTop = box.current.scrollHeight
  }, [lines])

  const profileId = settings.local.activeProfileId
  return (
    <div className="flex h-full flex-col gap-3">
      <div className="flex items-center gap-3">
        <ServerDot />
        <span className="font-mono text-[12px] text-ink-300">
          {status.state}
          {status.port ? ` · 127.0.0.1:${status.port}` : ''}
        </span>
        <div className="flex-1" />
        {status.state === 'stopped' || status.state === 'error' ? (
          <Button size="sm" disabled={!profileId} onClick={() => profileId && void window.api.local.start(profileId).catch((e) => useStore.getState().showError((e as Error).message))}>
            <Play size={12} /> Start
          </Button>
        ) : (
          <Button size="sm" onClick={() => void window.api.local.stop()}>
            <Square size={12} /> Stop
          </Button>
        )}
        <Button size="sm" variant="ghost" onClick={() => void navigator.clipboard.writeText(lines.join('\n'))}>
          <Copy size={12} /> Copy
        </Button>
      </div>
      <pre
        ref={box}
        onScroll={(e) => {
          const el = e.currentTarget
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40
        }}
        className="min-h-0 flex-1 select-text overflow-auto rounded-lg border border-ink-800 bg-ink-950 p-4 font-mono text-[11px] leading-relaxed text-ink-300"
      >
        {lines.length ? lines.join('\n') : 'No output yet.'}
      </pre>
    </div>
  )
}

// ---------------------------------------------------------------------------

export function SettingsView() {
  const [tab, setTab] = useState<Tab>('general')
  return (
    <div className="flex h-full">
      <aside className="w-56 shrink-0 border-r border-ink-800 bg-ink-900 p-3">
        <h2 className="px-2 pb-4 pt-1 font-display text-lg font-semibold text-ink-100">Settings</h2>
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={cx(
              'flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-[13px]',
              tab === t.id ? 'bg-ink-800 text-ink-100' : 'text-ink-400 hover:bg-ink-850 hover:text-ink-200'
            )}
          >
            <span className={tab === t.id ? 'text-safelight' : ''}>{t.icon}</span>
            {t.label}
          </button>
        ))}
      </aside>
      <div className="min-w-0 flex-1 overflow-y-auto">
        <div className={cx('mx-auto flex max-w-3xl flex-col gap-5 p-8', tab === 'log' && 'h-full max-w-5xl')}>
          {tab === 'general' && <GeneralTab />}
          {tab === 'openrouter' && <OpenRouterTab />}
          {tab === 'engine' && <EngineTab />}
          {tab === 'profiles' && <ProfilesTab />}
          {tab === 'log' && <LogTab />}
        </div>
      </div>
    </div>
  )
}
