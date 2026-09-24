import { useMemo } from 'react'
import { Cloud, Cpu, Loader2, Play, RefreshCw, Square } from 'lucide-react'
import type { ProviderId } from '@shared/types'
import { activeProfile, useStore } from '../store'
import { Button, Combobox, cx, Segmented, Select } from '../components/ui'

export function ProviderSwitch({ size = 'md' }: { size?: 'sm' | 'md' }) {
  const provider = useStore((s) => s.provider)
  const set = useStore((s) => s.set)
  return (
    <Segmented<ProviderId>
      size={size}
      value={provider}
      onChange={(v) => set('provider', v)}
      options={[
        { value: 'openrouter', label: <><Cloud size={12} /> OpenRouter</> },
        { value: 'local', label: <><Cpu size={12} /> Local</> }
      ]}
    />
  )
}

export function OpenRouterModelSelect() {
  const orModels = useStore((s) => s.orModels)
  const orModel = useStore((s) => s.orModel)
  const setOrModel = useStore((s) => s.setOrModel)
  const error = useStore((s) => s.orModelsError)
  const load = useStore((s) => s.loadOrModels)
  const items = useMemo(
    () =>
      orModels.map((m) => {
        const res = m.supported_parameters.resolution
        const has4k = res?.type === 'enum' && res.values.includes('4K')
        const refs = m.supported_parameters.input_references
        const edits = refs?.type === 'range' && refs.max > 0
        return {
          value: m.id,
          label: m.name.replace(/^[^:]+:\s*/, ''),
          sub: m.id + (edits ? ' · edit' : ''),
          badge: has4k ? '4K' : undefined
        }
      }),
    [orModels]
  )
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex gap-1.5">
        <div className="min-w-0 flex-1">
          <Combobox value={orModel} onChange={setOrModel} items={items} placeholder="Select a model" />
        </div>
        <button title="Refresh models" onClick={() => void load(true)} className="px-1.5 text-ink-400 hover:text-ink-100">
          <RefreshCw size={13} />
        </button>
      </div>
      {error && <p className="text-[11px] text-stop">{error}</p>}
    </div>
  )
}

export function ServerDot() {
  const state = useStore((s) => s.serverStatus.state)
  return (
    <span
      className={cx(
        'inline-block h-2 w-2 rounded-full',
        state === 'ready' && 'bg-fixer shadow-[0_0_8px_var(--color-fixer)]',
        state === 'starting' && 'animate-pulse bg-safelight',
        state === 'error' && 'bg-stop',
        state === 'stopped' && 'bg-ink-600'
      )}
    />
  )
}

export function LocalModelSelect({ compact }: { compact?: boolean }) {
  const settings = useStore((s) => s.settings)!
  const status = useStore((s) => s.serverStatus)
  const caps = useStore((s) => s.caps)
  const profile = useStore(activeProfile)
  const updateSettings = useStore((s) => s.updateSettings)
  const showError = useStore((s) => s.showError)
  const setView = useStore((s) => s.setView)
  const profiles = settings.local.profiles

  if (profiles.length === 0) {
    if (compact) {
      return (
        <Button size="sm" className="h-8 w-full" onClick={() => setView('settings')}>
          Set up local models
        </Button>
      )
    }
    return (
      <div className="rounded-md border border-dashed border-ink-700 p-3 text-xs leading-relaxed text-ink-400">
        No local model profiles yet. A profile points sd.cpp at your model files.
        <Button size="sm" className="mt-2 w-full" onClick={() => setView('settings')}>
          Set up local models
        </Button>
      </div>
    )
  }

  const running = status.profileId === profile?.id && status.state !== 'stopped'
  const start = async () => {
    if (!profile) return
    try {
      await window.api.local.start(profile.id)
    } catch (err) {
      showError((err as Error).message)
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex gap-1.5">
        <Select
          className="min-w-0 flex-1"
          value={settings.local.activeProfileId ?? ''}
          placeholder="Select profile"
          onChange={(v) => void updateSettings({ local: { activeProfileId: v || null } })}
          options={profiles.map((p) => ({ value: p.id, label: p.name }))}
        />
        {running ? (
          <Button size="sm" className="h-8" title="Unload model" onClick={() => void window.api.local.stop()}>
            <Square size={12} />
          </Button>
        ) : (
          <Button size="sm" className="h-8" title="Load model" onClick={start} disabled={!profile}>
            <Play size={12} />
          </Button>
        )}
      </div>
      <div className={cx('flex items-center gap-2 font-mono text-[11px] text-ink-400', compact && 'hidden')}>
        <ServerDot />
        {status.state === 'starting' && (
          <>
            <Loader2 size={11} className="animate-spin" /> loading weights…
          </>
        )}
        {status.state === 'ready' && <span className="truncate">{caps?.model.stem ?? 'ready'}</span>}
        {status.state === 'stopped' && <span>not loaded · loads on first generate</span>}
        {status.state === 'error' && <span className="truncate text-stop">{status.error?.split('\n')[0] ?? 'error'}</span>}
      </div>
    </div>
  )
}
