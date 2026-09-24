import { Dices, Plus, RotateCcw, Trash2 } from 'lucide-react'
import type { OrImageModel, SdImgGenBody } from '@shared/types'
import { effectiveLocalParams, useStore } from '../store'
import { Button, Chip, Field, NumberInput, Section, Select, SliderField, TextInput, Toggle } from '../components/ui'

const randomSeed = () => Math.floor(Math.random() * 2 ** 31)

function SeedField({ value, onChange }: { value: number | undefined; onChange: (v: number | undefined) => void }) {
  const random = value === undefined || value < 0
  return (
    <Field label="Seed" hint="-1 / empty = random each run. The seed actually used is saved in history.">
      <div className="flex gap-1.5">
        <NumberInput value={random ? undefined : value} placeholder="random" onChange={(v) => onChange(v ?? -1)} />
        <Button size="sm" className="h-8" title="New random seed" onClick={() => onChange(randomSeed())}>
          <Dices size={13} />
        </Button>
        <Chip active={random} onClick={() => onChange(-1)} title="Random every time">
          rnd
        </Chip>
      </div>
    </Field>
  )
}

// ---------------------------------------------------------------------------

const OR_LABELS: Record<string, { label: string; hint?: string }> = {
  quality: { label: 'Quality' },
  background: { label: 'Background', hint: 'transparent requires png or webp output.' },
  output_format: { label: 'Output format' },
  n: { label: 'Images', hint: 'Number of images per request.' },
  output_compression: { label: 'Compression', hint: 'For jpeg/webp output.' }
}

/** Renders whatever the selected OpenRouter model declares in supported_parameters. */
export function OpenRouterParams({ model }: { model: OrImageModel | undefined }) {
  const orParams = useStore((s) => s.orParams)
  const setOrParam = useStore((s) => s.setOrParam)
  if (!model) return null
  const entries = Object.entries(model.supported_parameters).filter(
    ([k, spec]) => !['resolution', 'aspect_ratio', 'input_references'].includes(k) && !(spec.type === 'range' && spec.min === spec.max)
  )
  if (entries.length === 0) return <p className="text-xs text-ink-500">No tunable parameters for this model.</p>
  const params = orParams as Record<string, unknown>
  return (
    <>
      {entries.map(([key, spec]) => {
        if (key === 'seed') {
          return <SeedField key={key} value={orParams.seed} onChange={(v) => setOrParam('seed', v !== undefined && v >= 0 ? v : undefined)} />
        }
        const meta = OR_LABELS[key] ?? { label: key.replace(/_/g, ' ') }
        if (spec.type === 'enum') {
          return (
            <Field key={key} label={meta.label} hint={meta.hint}>
              <div className="flex flex-wrap gap-1">
                <Chip active={params[key] === undefined} onClick={() => setOrParam(key as never, undefined as never)}>
                  default
                </Chip>
                {spec.values.map((v) => (
                  <Chip key={v} active={params[key] === v} onClick={() => setOrParam(key as never, v as never)}>
                    {v}
                  </Chip>
                ))}
              </div>
            </Field>
          )
        }
        if (spec.type === 'range') {
          if (spec.min === spec.max) return null
          return (
            <SliderField
              key={key}
              label={meta.label}
              hint={meta.hint}
              min={spec.min}
              max={spec.max}
              value={params[key] as number | undefined}
              placeholder="auto"
              onChange={(v) => setOrParam(key as never, v as never)}
            />
          )
        }
        return null
      })}
    </>
  )
}

// ---------------------------------------------------------------------------

type P = SdImgGenBody

export function LocalParams({ advanced }: { advanced: boolean }) {
  const caps = useStore((s) => s.caps)
  const localParams = useStore((s) => s.localParams)
  const patch = useStore((s) => s.patchLocal)
  const reset = useStore((s) => s.resetLocalToDefaults)
  const eff = effectiveLocalParams({ caps, localParams })
  const sp = eff.sample_params ?? {}
  const g = sp.guidance ?? {}
  const setSp = (v: NonNullable<P['sample_params']>) => patch({ sample_params: v })
  const setG = (v: NonNullable<NonNullable<P['sample_params']>['guidance']>) => patch({ sample_params: { guidance: v } })
  const overridden = Object.keys(localParams).length > 0

  const samplerOptions = caps?.samplers ?? []
  const schedulerOptions = caps?.schedulers ?? []

  return (
    <>
      {!caps && (
        <p className="rounded-md border border-ink-800 bg-ink-900 p-2.5 text-[11px] leading-snug text-ink-400">
          Load the model to see its defaults, samplers and limits. Parameters left untouched use the model's own defaults from sd.cpp.
        </p>
      )}
      <div className="flex items-center justify-between">
        <span className="font-mono text-[10px] text-ink-500">{overridden ? 'custom values' : 'model defaults'}</span>
        {overridden && (
          <button onClick={reset} className="flex items-center gap-1 text-[11px] text-ink-400 hover:text-safelight">
            <RotateCcw size={11} /> Reset to model defaults
          </button>
        )}
      </div>
      <SliderField label="Steps" min={1} max={100} value={sp.sample_steps} onChange={(v) => setSp({ sample_steps: v })} />
      <SliderField
        label="CFG scale"
        hint="Classifier-free guidance. Distilled/turbo models want 1.0; Qwen-Image 2.1 on sd.cpp ~6; SDXL 5–7."
        min={0}
        max={20}
        step={0.1}
        value={g.txt_cfg}
        onChange={(v) => setG({ txt_cfg: v })}
      />
      <div className="grid grid-cols-2 gap-2">
        <Field label="Sampler">
          <Select
            value={sp.sample_method ?? ''}
            placeholder="model default"
            onChange={(v) => setSp({ sample_method: v || undefined })}
            options={samplerOptions}
          />
        </Field>
        <Field label="Scheduler">
          <Select
            value={sp.scheduler ?? ''}
            placeholder="model default"
            onChange={(v) => setSp({ scheduler: v || undefined })}
            options={schedulerOptions}
          />
        </Field>
      </div>
      <SeedField value={eff.seed} onChange={(v) => patch({ seed: v })} />
      <SliderField
        label="Batch"
        min={1}
        max={Math.max(1, Math.min(caps?.limits.max_batch_count ?? 8, 16))}
        value={eff.batch_count ?? 1}
        onChange={(v) => patch({ batch_count: v })}
      />

      {advanced && (
        <>
          <SliderField
            label="Flow shift"
            hint="For flow models (Qwen, Flux, SD3, Wan). Empty = automatic / model default."
            min={0}
            max={12}
            step={0.1}
            value={sp.flow_shift ?? undefined}
            placeholder="auto"
            onChange={(v) => setSp({ flow_shift: v ?? null })}
          />
          <div className="grid grid-cols-2 gap-2">
            <Field label="Distilled guid." hint="Flux.1-dev style embedded guidance (--guidance).">
              <NumberInput value={g.distilled_guidance} step={0.1} onChange={(v) => setG({ distilled_guidance: v })} />
            </Field>
            <Field label="Image CFG" hint="Image guidance for instruct-pix2pix style edit models. Empty = same as CFG.">
              <NumberInput value={g.img_cfg ?? undefined} step={0.1} placeholder="= cfg" onChange={(v) => setG({ img_cfg: v ?? null })} />
            </Field>
            <Field label="Eta" hint="Noise multiplier for ancestral/SDE samplers.">
              <NumberInput value={sp.eta ?? undefined} step={0.05} placeholder="auto" onChange={(v) => setSp({ eta: v ?? null })} />
            </Field>
            <Field label="Clip skip" hint="-1 = model default. SD1.x anime models often use 2.">
              <NumberInput value={eff.clip_skip} min={-1} max={12} onChange={(v) => patch({ clip_skip: v })} />
            </Field>
            <Field label="Shifted timestep" hint="NitroFusion/NitroSD-style timestep shift (0 = off).">
              <NumberInput value={sp.shifted_timestep} min={0} onChange={(v) => setSp({ shifted_timestep: v })} />
            </Field>
            <Field label="Output format">
              <Select
                value={eff.output_format ?? 'png'}
                onChange={(v) => patch({ output_format: v })}
                options={caps?.output_formats_by_mode?.img_gen ?? ['png', 'jpeg', 'webp']}
              />
            </Field>
          </div>
          <Field label="Custom sigmas" hint="Comma-separated sigma schedule; overrides steps + scheduler.">
            <TextInput
              placeholder="e.g. 1.0, 0.8, 0.5, 0.2, 0"
              defaultValue={(sp.custom_sigmas ?? []).join(', ')}
              onBlur={(e) => {
                const txt = e.target.value.trim()
                setSp({ custom_sigmas: txt ? txt.split(',').map(Number).filter(Number.isFinite) : [] })
              }}
            />
          </Field>
        </>
      )}
    </>
  )
}

export function SkipLayerGuidance() {
  const caps = useStore((s) => s.caps)
  const localParams = useStore((s) => s.localParams)
  const patch = useStore((s) => s.patchLocal)
  const slg = effectiveLocalParams({ caps, localParams }).sample_params?.guidance?.slg ?? {}
  const setSlg = (v: NonNullable<NonNullable<NonNullable<P['sample_params']>['guidance']>['slg']>) =>
    patch({ sample_params: { guidance: { slg: v } } })
  return (
    <Section title="Skip-layer guidance" defaultOpen={false}>
      <SliderField label="SLG scale" hint="0 disables. ~2.5 recommended for SD3.5 Medium." min={0} max={5} step={0.1} value={slg.scale} onChange={(v) => setSlg({ scale: v })} />
      <Field label="Layers">
        <TextInput
          defaultValue={(slg.layers ?? []).join(',')}
          placeholder="7,8,9"
          onBlur={(e) => setSlg({ layers: e.target.value.split(',').map((x) => parseInt(x)).filter((x) => !isNaN(x)) })}
        />
      </Field>
      <div className="grid grid-cols-2 gap-2">
        <Field label="Start">
          <NumberInput value={slg.layer_start} step={0.01} onChange={(v) => setSlg({ layer_start: v })} />
        </Field>
        <Field label="End">
          <NumberInput value={slg.layer_end} step={0.01} onChange={(v) => setSlg({ layer_end: v })} />
        </Field>
      </div>
    </Section>
  )
}

export function LoraSection() {
  const caps = useStore((s) => s.caps)
  const localParams = useStore((s) => s.localParams)
  const patch = useStore((s) => s.patchLocal)
  const loras = localParams.lora ?? []
  const available = caps?.loras ?? []
  const setLoras = (l: NonNullable<P['lora']>) => patch({ lora: l })
  return (
    <Section title="LoRA" defaultOpen={loras.length > 0} aside={<span className="font-mono text-[10px] text-ink-500">{loras.length || ''}</span>}>
      {available.length === 0 ? (
        <p className="text-[11px] text-ink-500">Set a LoRA directory in the model profile to use LoRAs.</p>
      ) : (
        <>
          {loras.map((l, i) => (
            <div key={i} className="flex flex-col gap-1.5 rounded-md border border-ink-800 p-2">
              <div className="flex gap-1.5">
                <Select
                  className="min-w-0 flex-1"
                  value={l.path}
                  onChange={(v) => setLoras(loras.map((x, j) => (j === i ? { ...x, path: v } : x)))}
                  options={available.map((a) => ({ value: a.path, label: a.name }))}
                />
                <button onClick={() => setLoras(loras.filter((_, j) => j !== i))} className="px-1 text-ink-500 hover:text-stop">
                  <Trash2 size={13} />
                </button>
              </div>
              <SliderField label="Weight" min={-2} max={2} step={0.05} value={l.multiplier} onChange={(v) => setLoras(loras.map((x, j) => (j === i ? { ...x, multiplier: v ?? 1 } : x)))} />
              <Toggle label="High-noise model" checked={!!l.is_high_noise} onChange={(v) => setLoras(loras.map((x, j) => (j === i ? { ...x, is_high_noise: v } : x)))} />
            </div>
          ))}
          <Button size="sm" onClick={() => setLoras([...loras, { path: available[0].path, multiplier: 1 }])}>
            <Plus size={12} /> Add LoRA
          </Button>
        </>
      )}
    </Section>
  )
}

export function HiresSection() {
  const caps = useStore((s) => s.caps)
  const localParams = useStore((s) => s.localParams)
  const patch = useStore((s) => s.patchLocal)
  const eff = effectiveLocalParams({ caps, localParams })
  const h = eff.hires ?? {}
  const setH = (v: NonNullable<P['hires']>) => patch({ hires: v })
  const upscalers = caps?.upscalers?.map((u) => u.name) ?? ['Latent', 'Lanczos', 'Nearest']
  const w = eff.width ?? 1024
  const ht = eff.height ?? 1024
  const scale = h.scale ?? 2
  const tw = h.target_width || Math.round(w * scale)
  const th = h.target_height || Math.round(ht * scale)
  return (
    <Section title="Hires fix" defaultOpen={!!h.enabled} aside={<Toggle checked={!!h.enabled} onChange={(v) => setH({ enabled: v })} />}>
      <p className="text-[11px] leading-snug text-ink-500">
        Generates at the base size, then upscales and re-samples. The usual way to reach 4K with local models without duplicated subjects.
      </p>
      <Field label="Upscaler">
        <Select value={h.upscaler ?? 'Latent'} onChange={(v) => setH({ upscaler: v })} options={upscalers} />
      </Field>
      <div className="flex flex-wrap gap-1">
        {[1.5, 2, 3, 4].map((s) => (
          <Chip key={s} active={!h.target_width && scale === s} onClick={() => setH({ scale: s, target_width: 0, target_height: 0 })}>
            ×{s}
          </Chip>
        ))}
        <Chip
          active={h.target_width === (w >= ht ? 3840 : Math.round((3840 * w) / ht))}
          onClick={() => {
            const r = w / ht
            const [tw4, th4] = r >= 1 ? [3840, Math.round(3840 / r / 16) * 16] : [Math.round((3840 * r) / 16) * 16, 3840]
            setH({ target_width: tw4, target_height: th4 })
          }}
        >
          4K long edge
        </Chip>
      </div>
      <div className="flex items-end gap-2">
        <Field label="Target W" hint="0 = use scale">
          <NumberInput value={h.target_width ?? 0} min={0} onChange={(v) => setH({ target_width: v ?? 0 })} />
        </Field>
        <Field label="Target H" hint="0 = use scale">
          <NumberInput value={h.target_height ?? 0} min={0} onChange={(v) => setH({ target_height: v ?? 0 })} />
        </Field>
      </div>
      <div className="font-mono text-[11px] text-ink-400">
        → {tw}×{th} ({((tw * th) / 1e6).toFixed(1)} MP)
      </div>
      <SliderField label="Denoise" hint="How much the second pass may change the image." min={0} max={1} step={0.01} value={h.denoising_strength} onChange={(v) => setH({ denoising_strength: v })} />
      <div className="grid grid-cols-2 gap-2">
        <Field label="Hires steps" hint="0 = same as base steps">
          <NumberInput value={h.steps ?? 0} min={0} onChange={(v) => setH({ steps: v ?? 0 })} />
        </Field>
        <Field label="Upscale tile" hint="Tile size for model-based upscalers.">
          <NumberInput value={h.upscale_tile_size} min={0} onChange={(v) => setH({ upscale_tile_size: v })} />
        </Field>
      </div>
    </Section>
  )
}

export function VaeTilingSection() {
  const caps = useStore((s) => s.caps)
  const localParams = useStore((s) => s.localParams)
  const patch = useStore((s) => s.patchLocal)
  const t = effectiveLocalParams({ caps, localParams }).vae_tiling_params ?? {}
  const setT = (v: NonNullable<P['vae_tiling_params']>) => patch({ vae_tiling_params: v })
  return (
    <Section title="VAE tiling" defaultOpen={!!t.enabled} aside={<Toggle checked={!!t.enabled} onChange={(v) => setT({ enabled: v })} />}>
      <p className="text-[11px] leading-snug text-ink-500">Decodes in tiles to cut VAE memory. Needed for most 2K+ images on ≤16 GB GPUs.</p>
      <div className="grid grid-cols-2 gap-2">
        <Field label="Tile X" hint="0 = auto">
          <NumberInput value={t.tile_size_x} min={0} onChange={(v) => setT({ tile_size_x: v })} />
        </Field>
        <Field label="Tile Y" hint="0 = auto">
          <NumberInput value={t.tile_size_y} min={0} onChange={(v) => setT({ tile_size_y: v })} />
        </Field>
        <Field label="Rel. size X" hint="Tile size relative to latent (overrides absolute when > 0).">
          <NumberInput value={t.rel_size_x} step={0.05} min={0} onChange={(v) => setT({ rel_size_x: v })} />
        </Field>
        <Field label="Rel. size Y">
          <NumberInput value={t.rel_size_y} step={0.05} min={0} onChange={(v) => setT({ rel_size_y: v })} />
        </Field>
      </div>
      <SliderField label="Overlap" min={0} max={0.9} step={0.05} value={t.target_overlap} onChange={(v) => setT({ target_overlap: v })} />
    </Section>
  )
}

const CACHE_MODES = [
  { value: 'disabled', label: 'Disabled' },
  { value: 'easycache', label: 'EasyCache (DiT)' },
  { value: 'ucache', label: 'UCache (UNet)' },
  { value: 'dbcache', label: 'DBCache (DiT)' },
  { value: 'taylorseer', label: 'TaylorSeer (DiT)' },
  { value: 'cache-dit', label: 'Cache-DiT (DiT)' },
  { value: 'spectrum', label: 'Spectrum' }
]

export function PerformanceSection() {
  const caps = useStore((s) => s.caps)
  const localParams = useStore((s) => s.localParams)
  const patch = useStore((s) => s.patchLocal)
  const eff = effectiveLocalParams({ caps, localParams })
  return (
    <Section title="Step caching & references" defaultOpen={false}>
      <Field label="Cache mode" hint="Reuses computation between similar steps. Faster, slightly lower fidelity. DiT modes for Flux/Qwen/Z-Image; UCache for SD/SDXL.">
        <Select value={eff.cache_mode ?? 'disabled'} onChange={(v) => patch({ cache_mode: v })} options={CACHE_MODES} />
      </Field>
      <Field label="Cache options" hint="key=value list, e.g. threshold=0.3 (see sd.cpp docs/caching.md).">
        <TextInput defaultValue={eff.cache_option ?? ''} placeholder="threshold=0.3" onBlur={(e) => patch({ cache_option: e.target.value })} />
      </Field>
      <Field label="Ref image args" hint='Reference encoding options, e.g. "resize_before_vae=false" to keep reference images at native size.'>
        <TextInput defaultValue={eff.ref_image_args ?? ''} placeholder="resize_before_vae=false" onBlur={(e) => patch({ ref_image_args: e.target.value })} />
      </Field>
      <Field label="Image preprocess" hint='Input geometry rules, e.g. "target=ref,mode=none". Add canny=true for edge maps.'>
        <TextInput
          defaultValue={typeof eff.image_preprocess === 'string' ? eff.image_preprocess : (eff.image_preprocess ?? []).join(' ; ')}
          placeholder="target=ref,mode=none"
          onBlur={(e) => {
            const parts = e.target.value.split(';').map((x) => x.trim()).filter(Boolean)
            patch({ image_preprocess: parts.length <= 1 ? (parts[0] ?? '') : parts })
          }}
        />
      </Field>
      <Toggle label="Increase ref index" hint="Give each reference image a distinct position index (some multi-ref models)." checked={!!eff.increase_ref_index} onChange={(v) => patch({ increase_ref_index: v })} />
    </Section>
  )
}
