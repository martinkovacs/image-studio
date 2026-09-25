import { ArrowLeftRight, TriangleAlert } from 'lucide-react'
import type { OrImageModel } from '@shared/types'
import { Chip, Field, NumberInput, Select } from '../components/ui'
import { effectiveLocalParams, useStore } from '../store'
import { parseRatio, roundTo } from '../lib/util'

const RATIOS = ['1:1', '4:3', '3:4', '3:2', '2:3', '16:9', '9:16', '21:9', '9:21']
const LONG_EDGES = [512, 768, 1024, 1280, 1536, 2048, 2560, 3072, 3840, 4096]
const SNAP_KEY = 'resolutionSnap'

function sizeFor(ratio: number, longEdge: number, snap: number): { width: number; height: number } {
  return ratio >= 1
    ? { width: roundTo(longEdge, snap), height: roundTo(longEdge / ratio, snap) }
    : { width: roundTo(longEdge * ratio, snap), height: roundTo(longEdge, snap) }
}

function matchRatio(w: number, h: number): string | null {
  const r = w / h
  return RATIOS.find((x) => Math.abs(parseRatio(x)! - r) < 0.02) ?? null
}

export function LocalResolution() {
  const caps = useStore((s) => s.caps)
  const localParams = useStore((s) => s.localParams)
  const patchLocal = useStore((s) => s.patchLocal)
  const eff = effectiveLocalParams({ caps, localParams })
  const width = eff.width ?? 1024
  const height = eff.height ?? 1024
  const snap = Number(localStorage.getItem(SNAP_KEY) ?? 32)
  const limits = caps?.limits
  const maxEdge = Math.min(limits?.max_width ?? 8192, limits?.max_height ?? 8192)
  const ratio = matchRatio(width, height)
  const longEdge = Math.max(width, height)

  const set = (w: number, h: number) => patchLocal({ width: w, height: h })
  const setRatio = (r: string) => {
    const s = sizeFor(parseRatio(r)!, longEdge, snap)
    set(s.width, s.height)
  }
  const setLongEdge = (edge: number) => {
    const s = sizeFor(width / height, edge, snap)
    set(s.width, s.height)
  }
  const mp = (width * height) / 1e6

  return (
    <div className="flex flex-col gap-3">
      <Field label="Aspect ratio">
        <div className="flex flex-wrap gap-1">
          {RATIOS.map((r) => (
            <Chip key={r} active={ratio === r} onClick={() => setRatio(r)}>
              {r}
            </Chip>
          ))}
        </div>
      </Field>
      <Field label="Long edge" hint="Sets the longest side and keeps the aspect ratio. Most models are trained at 1–2 MP; very large sizes can produce repeated subjects. For 4K, generate near the native size and use Hires fix or Upscale (Advanced).">
        <div className="flex flex-wrap gap-1">
          {LONG_EDGES.filter((e) => e <= maxEdge).map((e) => (
            <Chip key={e} active={longEdge === e} onClick={() => setLongEdge(e)}>
              {e >= 3840 ? (e === 3840 ? '4K·UHD' : '4K') : e}
            </Chip>
          ))}
        </div>
      </Field>
      <div className="flex items-end gap-2">
        <Field label="Width">
          <NumberInput value={width} min={limits?.min_width ?? 64} max={limits?.max_width} step={snap} onChange={(v) => v && set(roundTo(v, snap), height)} />
        </Field>
        <button
          title="Swap"
          onClick={() => set(height, width)}
          className="mb-1 flex h-7 w-7 shrink-0 items-center justify-center rounded text-ink-400 hover:bg-ink-800 hover:text-ink-100"
        >
          <ArrowLeftRight size={14} />
        </button>
        <Field label="Height">
          <NumberInput value={height} min={limits?.min_height ?? 64} max={limits?.max_height} step={snap} onChange={(v) => v && set(width, roundTo(v, snap))} />
        </Field>
        <Field label="Snap" hint="Dimensions are rounded to this multiple. Qwen-Image needs 32; Flux 16; SD 8. 64 is safe for all.">
          <Select
            value={String(snap)}
            onChange={(v) => {
              localStorage.setItem(SNAP_KEY, v)
              const w = roundTo(width, Number(v))
              const h = roundTo(height, Number(v))
              set(w, h)
            }}
            options={['8', '16', '32', '64']}
            className="w-16"
          />
        </Field>
      </div>
      <div className="flex items-center justify-between font-mono text-[11px] text-ink-300">
        <span>
          {width}×{height}
        </span>
        <span>{mp.toFixed(2)} MP</span>
      </div>
      {mp > 4.3 && (
        <div className="flex gap-2 rounded-md border border-safelight/30 bg-safelight/5 p-2 text-[11px] leading-snug text-ink-300">
          <TriangleAlert size={13} className="mt-0.5 shrink-0 text-safelight" />
          Above ~4 MP most models go past their training resolution: expect high VRAM use and duplicated subjects. Enable VAE tiling, or generate smaller and use Hires fix / Upscale.
        </div>
      )}
    </div>
  )
}

export function OpenRouterResolution({ model }: { model: OrImageModel | undefined }) {
  const orParams = useStore((s) => s.orParams)
  const setOrParam = useStore((s) => s.setOrParam)
  const res = model?.supported_parameters.resolution
  const ar = model?.supported_parameters.aspect_ratio
  if (!model) return null
  if (res?.type !== 'enum' && ar?.type !== 'enum') {
    return <p className="text-xs text-ink-300">This model picks its own output size; OpenRouter exposes no size controls for it.</p>
  }
  return (
    <div className="flex flex-col gap-3">
      {res?.type === 'enum' && (
        <Field label="Resolution" hint="OpenRouter's normalized tiers. 4K is only listed for models that can natively output it (e.g. Gemini 3 Pro Image, Seedream 4.5).">
          <div className="flex flex-wrap gap-1">
            <Chip active={!orParams.resolution} onClick={() => setOrParam('resolution', undefined)}>
              default
            </Chip>
            {res.values.map((v) => (
              <Chip key={v} active={orParams.resolution === v} onClick={() => setOrParam('resolution', v)}>
                {v}
              </Chip>
            ))}
          </div>
        </Field>
      )}
      {ar?.type === 'enum' && (
        <Field label="Aspect ratio">
          <div className="flex flex-wrap gap-1">
            <Chip active={!orParams.aspect_ratio} onClick={() => setOrParam('aspect_ratio', undefined)}>
              default
            </Chip>
            {ar.values.map((v) => (
              <Chip key={v} active={orParams.aspect_ratio === v} onClick={() => setOrParam('aspect_ratio', v)}>
                {v}
              </Chip>
            ))}
          </div>
        </Field>
      )}
      {res?.type !== 'enum' && (
        <p className="text-[11px] leading-snug text-ink-300">No resolution tiers for this model; output is typically ~1 MP.</p>
      )}
    </div>
  )
}
