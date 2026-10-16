import { useMemo, useState } from 'react'
import { Copy, FolderOpen, Info, X } from 'lucide-react'
import { profileBackend, type LocalBackendId, type LocalModelProfile } from '@shared/types'
import { FLAG_GROUPS, MODEL_FILE_FILTERS, SDCPP_LAUNCH_FLAGS, type LaunchFlag } from '@shared/sdcppFlags'
import { DIFFUSERS_LAUNCH_FLAGS } from '@shared/diffusersFlags'
import { CATALOG, CATALOG_BY_ID } from '@shared/catalog'
import { Button, Field, NumberInput, Segmented, Select, TextInput, Toggle } from '../components/ui'

type Args = LocalModelProfile['args']

export const BACKEND_LABEL: Record<LocalBackendId, string> = { sdcpp: 'stable-diffusion.cpp', diffusers: 'diffusers' }

export const flagsFor = (backend: LocalBackendId): LaunchFlag[] => (backend === 'diffusers' ? DIFFUSERS_LAUNCH_FLAGS : SDCPP_LAUNCH_FLAGS)

/** The main weight file or folder of a profile, for display. */
export const mainModelPath = (p: LocalModelProfile): string =>
  String((profileBackend(p) === 'diffusers' ? (p.args['transformer-gguf'] ?? p.args['model']) : (p.args['diffusion-model'] ?? p.args['model'])) ?? '')

function quote(v: string): string {
  return /[\s"'\\]/.test(v) ? `"${v.replace(/(["\\])/g, '\\$1')}"` : v
}

export function commandPreview(p: LocalModelProfile): string {
  const backend = profileBackend(p)
  const parts = [backend === 'diffusers' ? 'python server.py' : 'sd-server']
  for (const f of flagsFor(backend)) {
    const v = p.args[f.id]
    if (v === undefined || v === '' || v === false) continue
    parts.push(v === true ? `--${f.id}` : `--${f.id} ${quote(String(v))}`)
  }
  if (p.extraArgs.trim()) parts.push(p.extraArgs.trim())
  return parts.join(' \\\n  ')
}

function FlagInput({ flag, value, onChange }: { flag: LaunchFlag; value: Args[string] | undefined; onChange: (v: Args[string] | undefined) => void }) {
  const browse = async () => {
    const p = await window.api.settings.pickPath({
      kind: flag.type === 'dir' ? 'directory' : 'file',
      title: flag.label,
      filters: flag.type !== 'path' ? undefined : flag.id === 'lora' ? [{ name: 'LoRA', extensions: ['safetensors'] }] : flag.id === 'transformer-gguf' ? [{ name: 'GGUF', extensions: ['gguf'] }] : MODEL_FILE_FILTERS
    })
    if (p) onChange(p)
  }
  switch (flag.type) {
    case 'bool':
      return <Toggle label={flag.label} hint={flag.help} checked={value === true} onChange={(v) => onChange(v || undefined)} />
    case 'path':
    case 'dir':
      return (
        <Field label={flag.label} hint={flag.help}>
          <div className="flex gap-1.5">
            <TextInput
              value={String(value ?? '')}
              onChange={(e) => onChange(e.target.value || undefined)}
              placeholder={flag.type === 'dir' ? 'directory' : 'file'}
              className="font-mono text-[11px]"
            />
            <Button size="sm" className="h-8 shrink-0" onClick={browse} title="Browse">
              <FolderOpen size={13} />
            </Button>
            {value && (
              <Button size="sm" variant="ghost" className="h-8 shrink-0" onClick={() => onChange(undefined)} title="Clear">
                <X size={13} />
              </Button>
            )}
          </div>
        </Field>
      )
    case 'number':
      return (
        <Field label={flag.label} hint={flag.help}>
          <NumberInput value={typeof value === 'number' ? value : undefined} onChange={(v) => onChange(v)} />
        </Field>
      )
    case 'enum':
      return (
        <Field label={flag.label} hint={flag.help}>
          <Select
            value={String(value ?? '')}
            onChange={(v) => onChange(v || undefined)}
            options={(flag.values ?? []).filter(Boolean)}
            placeholder="default"
          />
        </Field>
      )
    default:
      return (
        <Field label={flag.label} hint={flag.help}>
          <TextInput value={String(value ?? '')} onChange={(e) => onChange(e.target.value || undefined)} className="font-mono text-[11px]" />
        </Field>
      )
  }
}

export function ProfileEditor({
  initial,
  onSave,
  onCancel
}: {
  initial: LocalModelProfile
  onSave: (p: LocalModelProfile) => void
  onCancel: () => void
}) {
  const [p, setP] = useState(initial)
  const [showAll, setShowAll] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const backend = profileBackend(p)
  const flags = flagsFor(backend)
  const model = p.catalogId ? CATALOG_BY_ID.get(p.catalogId) : undefined
  const recipe = model?.recipes[backend]
  const slots = recipe?.components.map((c) => c.slot)

  const setArg = (id: string, v: Args[string] | undefined) => {
    const args = { ...p.args }
    if (v === undefined || v === '') delete args[id]
    else args[id] = v
    setP({ ...p, args })
  }

  // With a supported model selected, weight-file slots are limited to what that model needs.
  const visible = (f: LaunchFlag) => {
    if (showAll || p.args[f.id] !== undefined) return true
    if (slots && (f.group === 'models' || f.group === 'encoders' || f.group === 'extras') && (f.type === 'path' || f.type === 'dir')) return slots.includes(f.id)
    return !!f.common
  }

  const preview = useMemo(() => commandPreview(p), [p])

  const switchBackend = (b: LocalBackendId) => {
    if (b === backend) return
    if ((Object.keys(p.args).length > 0 || p.extraArgs.trim()) && !confirm('Switching the backend clears this profile\u2019s files, options and extra args. Continue?')) return
    setP({ ...p, backend: b, args: {}, extraArgs: '', catalogId: undefined })
  }

  const applyModel = (id: string) => {
    const m = CATALOG_BY_ID.get(id)
    const r = m?.recipes[backend]
    if (!m || !r) return setP({ ...p, catalogId: undefined })
    // Files picked for another supported model don't fit this one; hand-picked files of a
    // custom profile and non-file options (memory, devices, …) carry over.
    const fileSlot = (id: string) => flags.some((f) => f.id === id && (f.type === 'path' || f.type === 'dir'))
    setP((cur) => {
      const kept = Object.fromEntries(Object.entries(cur.args).filter(([id]) => !cur.catalogId || cur.catalogId === m.id || !fileSlot(id)))
      return { ...cur, catalogId: m.id, name: cur.name || m.label, args: { ...kept, ...r.args } }
    })
  }

  const save = () => {
    if (!p.name.trim()) return setError('Give the profile a name')
    if (backend === 'diffusers') {
      if (!p.args['pipeline']) return setError('Pick the diffusers pipeline for this model')
      if (!p.args['model']) return setError('Set the model folder (a diffusers repo with model_index.json)')
    } else if (!p.args['model'] && !p.args['diffusion-model']) {
      return setError('Set either a full checkpoint or a diffusion model')
    }
    onSave({ ...p, name: p.name.trim() })
  }

  return (
    <div className="rise flex flex-col gap-5">
      <Field label="Backend" hint="Each profile targets one backend; their files and options differ.">
        <Segmented<LocalBackendId>
          value={backend}
          onChange={switchBackend}
          options={[
            { value: 'diffusers', label: BACKEND_LABEL.diffusers },
            { value: 'sdcpp', label: BACKEND_LABEL.sdcpp }
          ]}
        />
      </Field>
      <div className="grid grid-cols-[1fr_220px] gap-3">
        <Field label="Profile name">
          <TextInput value={p.name} onChange={(e) => setP({ ...p, name: e.target.value })} placeholder="e.g. Qwen-Image 2.1 Q6" />
        </Field>
        <Field label="Model" hint="A supported model: shows only the files it needs and applies its launch options. Model browser downloads fill the files in for you.">
          <Select
            value={recipe ? (p.catalogId ?? '') : ''}
            placeholder="custom"
            onChange={applyModel}
            options={CATALOG.filter((m) => m.recipes[backend]).map((m) => ({ value: m.id, label: m.label }))}
          />
        </Field>
      </div>

      {model && recipe && (
        <div className="flex gap-2.5 rounded-md border border-safelight/30 bg-safelight/5 p-3 text-[12px] leading-relaxed text-ink-300">
          <Info size={14} className="mt-0.5 shrink-0 text-safelight" />
          <span>
            <b className="text-ink-100">{model.label}:</b> {recipe.note}
          </span>
        </div>
      )}

      <Toggle label={`Show all ${backend === 'diffusers' ? 'diffusers server' : 'sd-server'} options`} checked={showAll} onChange={setShowAll} />

      {FLAG_GROUPS.map((g) => {
        const group = flags.filter((f) => f.group === g.id && visible(f))
        if (group.length === 0) return null
        const bools = group.filter((f) => f.type === 'bool')
        const others = group.filter((f) => f.type !== 'bool')
        return (
          <div key={g.id} className="flex flex-col gap-3 rounded-lg border border-ink-800 bg-ink-900 p-4">
            <span className="font-display text-[13px] font-semibold text-ink-200">{g.label}</span>
            {others.map((f) => (
              <FlagInput key={f.id} flag={f} value={p.args[f.id]} onChange={(v) => setArg(f.id, v)} />
            ))}
            {bools.length > 0 && (
              <div className="grid grid-cols-2 gap-x-6 gap-y-2.5">
                {bools.map((f) => (
                  <FlagInput key={f.id} flag={f} value={p.args[f.id]} onChange={(v) => setArg(f.id, v)} />
                ))}
              </div>
            )}
          </div>
        )
      })}

      <Field label="Extra CLI args" hint="Appended verbatim; quotes supported. For flags not listed above.">
        <TextInput value={p.extraArgs} onChange={(e) => setP({ ...p, extraArgs: e.target.value })} className="font-mono text-[11px]" placeholder='--vae-tile-size 32x32' />
      </Field>

      <Field
        label="Command preview"
        right={
          <button onClick={() => void navigator.clipboard.writeText(preview.replace(/ \\\n {2}/g, ' '))} className="text-ink-400 hover:text-ink-100" title="Copy">
            <Copy size={12} />
          </button>
        }
      >
        <pre className="select-text overflow-x-auto rounded-md border border-ink-800 bg-ink-950 p-3 font-mono text-[11px] leading-relaxed text-ink-300">{preview}</pre>
      </Field>

      {error && <p className="text-[12px] text-stop">{error}</p>}
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button variant="primary" onClick={save}>
          Save profile
        </Button>
      </div>
    </div>
  )
}
