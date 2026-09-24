import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Brush,
  Copy,
  Eraser,
  FolderOpen,
  ImageUp,
  Layers,
  Maximize,
  PaintBucket,
  Recycle,
  Scan,
  Trash2,
  Wand2,
  X
} from 'lucide-react'
import { imgUrl, type HistoryItem, type OrImageParams, type SdImgGenBody } from '@shared/types'
import { useStore, type Job } from '../store'
import { Button, cx, Empty, IconButton, Select } from '../components/ui'
import { formatCost, formatDuration } from '../lib/util'
import { SLIM } from '../lib/edition'

// ---------------------------------------------------------------------------
// Progress

export function JobProgress({ job, compact }: { job: Job; compact?: boolean }) {
  const cancel = useStore((s) => s.cancel)
  const [, tick] = useState(0)
  useEffect(() => {
    const t = setInterval(() => tick((x) => x + 1), 500)
    return () => clearInterval(t)
  }, [])
  const p = job.progress
  const pct = p?.step && p.totalSteps ? (p.step / p.totalSteps) * 100 : undefined
  const stage = p?.stage ?? 'queued'
  const stageLabel: Record<string, string> = {
    queued: 'Queued',
    loading: 'Loading model',
    sampling: 'Sampling',
    decoding: 'Decoding',
    uploading: 'Sending',
    waiting: 'Generating remotely',
    done: 'Saving'
  }
  return (
    <div className={cx('flex flex-col gap-1.5', compact ? 'w-full' : 'w-72')}>
      <div className="flex items-center justify-between gap-2 font-mono text-[11px]">
        <span className="truncate text-ink-200">
          <span className="text-safelight">●</span> {stage === 'sampling' && p?.message ? p.message : (stageLabel[stage] ?? stage)}
          {p?.step != null && p.totalSteps ? ` ${p.step}/${p.totalSteps}` : ''}
        </span>
        <span className="text-ink-500">{formatDuration(Date.now() - job.startedAt)}</span>
      </div>
      <div className="relative h-[3px] overflow-hidden rounded-full bg-ink-700">
        {pct !== undefined ? (
          <div className="h-full bg-safelight transition-[width] duration-300" style={{ width: `${pct}%` }} />
        ) : (
          <div className="absolute inset-y-0 w-1/3 animate-[pulse_1.2s_ease-in-out_infinite] bg-safelight/70" />
        )}
      </div>
      <div className="flex items-center justify-between font-mono text-[10px] text-ink-500">
        <span className="truncate">{p?.speed ?? job.label}</span>
        <button onClick={() => void cancel(job.id)} className="text-ink-400 hover:text-stop">
          cancel
        </button>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Mask painting

function MaskPainter({ src }: { src: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [brush, setBrush] = useState(48)
  const [erase, setErase] = useState(false)
  const drawing = useRef(false)
  const last = useRef<{ x: number; y: number } | null>(null)
  const inputs = useStore((s) => s.inputs)
  const set = useStore((s) => s.set)

  useEffect(() => {
    const img = new Image()
    img.onload = () => {
      const c = canvasRef.current
      if (!c) return
      c.width = img.naturalWidth
      c.height = img.naturalHeight
      const ctx = c.getContext('2d')!
      ctx.clearRect(0, 0, c.width, c.height)
      if (inputs.maskImage) {
        // Restore existing mask: white pixels → painted overlay.
        const m = new Image()
        m.onload = () => {
          ctx.drawImage(m, 0, 0, c.width, c.height)
          const d = ctx.getImageData(0, 0, c.width, c.height)
          for (let i = 0; i < d.data.length; i += 4) d.data[i + 3] = d.data[i] > 127 ? 255 : 0
          ctx.putImageData(d, 0, 0)
        }
        m.src = inputs.maskImage
      }
    }
    img.src = src
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src])

  const exportMask = useCallback(() => {
    const c = canvasRef.current!
    const out = document.createElement('canvas')
    out.width = c.width
    out.height = c.height
    const o = out.getContext('2d')!
    o.fillStyle = '#000'
    o.fillRect(0, 0, out.width, out.height)
    // Painted pixels (any alpha) become white.
    const src = c.getContext('2d')!.getImageData(0, 0, c.width, c.height)
    const dst = o.getImageData(0, 0, out.width, out.height)
    let any = false
    for (let i = 0; i < src.data.length; i += 4) {
      if (src.data[i + 3] > 0) {
        dst.data[i] = dst.data[i + 1] = dst.data[i + 2] = 255
        any = true
      }
    }
    o.putImageData(dst, 0, 0)
    set('inputs', { ...useStore.getState().inputs, maskImage: any ? out.toDataURL('image/png') : undefined })
  }, [set])

  const pos = (e: React.PointerEvent) => {
    const c = canvasRef.current!
    const r = c.getBoundingClientRect()
    return { x: ((e.clientX - r.left) / r.width) * c.width, y: ((e.clientY - r.top) / r.height) * c.height }
  }
  const stroke = (a: { x: number; y: number }, b: { x: number; y: number }) => {
    const c = canvasRef.current!
    const ctx = c.getContext('2d')!
    const r = c.getBoundingClientRect()
    ctx.globalCompositeOperation = erase ? 'destination-out' : 'source-over'
    ctx.strokeStyle = 'rgba(255,122,47,1)'
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    ctx.lineWidth = brush * (c.width / r.width)
    ctx.beginPath()
    ctx.moveTo(a.x, a.y)
    ctx.lineTo(b.x, b.y)
    ctx.stroke()
  }

  const fill = (mode: 'clear' | 'invert') => {
    const c = canvasRef.current!
    const ctx = c.getContext('2d')!
    if (mode === 'clear') ctx.clearRect(0, 0, c.width, c.height)
    else {
      const d = ctx.getImageData(0, 0, c.width, c.height)
      for (let i = 0; i < d.data.length; i += 4) {
        const on = d.data[i + 3] > 0
        d.data[i] = 255
        d.data[i + 1] = 122
        d.data[i + 2] = 47
        d.data[i + 3] = on ? 0 : 255
      }
      ctx.putImageData(d, 0, 0)
    }
    exportMask()
  }

  return (
    <>
      <canvas
        ref={canvasRef}
        className="absolute inset-0 h-full w-full cursor-crosshair opacity-55"
        onPointerDown={(e) => {
          e.stopPropagation()
          ;(e.target as Element).setPointerCapture(e.pointerId)
          drawing.current = true
          last.current = pos(e)
          stroke(last.current, last.current)
        }}
        onPointerMove={(e) => {
          if (!drawing.current) return
          const p = pos(e)
          stroke(last.current!, p)
          last.current = p
        }}
        onPointerUp={() => {
          if (!drawing.current) return
          drawing.current = false
          exportMask()
        }}
      />
      <div
        onPointerDown={(e) => e.stopPropagation()}
        className="rise absolute left-1/2 top-3 z-10 flex -translate-x-1/2 items-center gap-1 rounded-lg border border-ink-700 bg-ink-900/95 p-1 shadow-xl"
      >
        <IconButton title="Brush" active={!erase} onClick={() => setErase(false)}>
          <Brush size={14} />
        </IconButton>
        <IconButton title="Eraser" active={erase} onClick={() => setErase(true)}>
          <Eraser size={14} />
        </IconButton>
        <input
          type="range"
          min={4}
          max={256}
          value={brush}
          style={{ ['--fill' as string]: `${((brush - 4) / 252) * 100}%` }}
          onChange={(e) => setBrush(Number(e.target.value))}
          className="mx-1 w-28"
        />
        <span className="w-8 font-mono text-[10px] text-ink-400">{brush}px</span>
        <IconButton title="Invert mask" onClick={() => fill('invert')}>
          <PaintBucket size={14} />
        </IconButton>
        <IconButton title="Clear mask" onClick={() => fill('clear')}>
          <X size={14} />
        </IconButton>
        <Button size="sm" variant="ghost" onClick={() => useStore.getState().set('inpaintMode', false)}>
          Done
        </Button>
      </div>
    </>
  )
}

// ---------------------------------------------------------------------------
// Viewer

function useZoomPan() {
  const [zoom, setZoom] = useState<number | 'fit'>('fit')
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const reset = () => {
    setZoom('fit')
    setPan({ x: 0, y: 0 })
  }
  return { zoom, setZoom, pan, setPan, reset }
}

/** Restore a history item's settings into the studio. */
export function reuseSettings(item: HistoryItem) {
  const s = useStore.getState()
  if (item.kind === 'upscale') return s.showError('Upscaled images have no generation settings; reuse the original instead')
  s.set('provider', item.provider)
  s.set('prompt', item.prompt)
  s.set('negativePrompt', item.negativePrompt ?? '')
  if (item.provider === 'openrouter') {
    // Stored as { model, params }.
    const p = item.params as { model: string; params: OrImageParams }
    s.setOrModel(p.model)
    useStore.setState({ orParams: { ...p.params } })
    localStorage.setItem('orParams', JSON.stringify(p.params))
  } else {
    // Stored as the sd.cpp body that was sent (images replaced by file paths).
    const { prompt: _p, negative_prompt: _n, ref_images: _r, init_image: _i, mask_image: _m, ...rest } = item.params as SdImgGenBody
    s.resetLocalToDefaults()
    s.patchLocal({ ...rest, seed: item.seed ?? rest.seed })
  }
  s.showInfo('Settings restored')
}

export async function applyAsInput(path: string, as: 'ref' | 'init' | 'inpaint') {
  const s = useStore.getState()
  const url = await window.api.history.readAsDataUrl(path)
  if (as === 'ref') {
    s.addRefImages([url])
    s.showInfo('Added as reference image')
  } else {
    s.set('provider', 'local')
    s.set('inputs', { ...s.inputs, initImage: url, maskImage: undefined })
    if (as === 'inpaint') {
      await s.updateSettings({ studioDetail: 'advanced' })
      s.set('inpaintMode', true)
    } else s.showInfo('Set as init image (img2img)')
  }
}

export function Canvas() {
  const history = useStore((s) => s.history)
  const selected = useStore((s) => s.selected)
  const jobMap = useStore((s) => s.jobs)
  const jobs = Object.values(jobMap)
  const inpaint = useStore((s) => s.inpaintMode)
  const initImage = useStore((s) => s.inputs.initImage)
  const provider = useStore((s) => s.provider)
  const caps = useStore((s) => s.caps)
  const upscale = useStore((s) => s.upscale)
  const { zoom, setZoom, pan, setPan, reset } = useZoomPan()
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null)
  const [upscaler, setUpscaler] = useState('')
  const box = useRef<HTMLDivElement>(null)
  const dragging = useRef<{ x: number; y: number; px: number; py: number } | null>(null)

  const item = history.find((h) => h.id === selected?.id) ?? history[0]
  const fileIndex = item && selected?.id === item.id ? selected.fileIndex : 0
  const file = item?.files[fileIndex]
  const src = inpaint && initImage ? initImage : file ? imgUrl(file) : undefined

  useEffect(() => reset(), [src])

  const scale = (() => {
    if (!natural || !box.current) return 1
    if (zoom !== 'fit') return zoom
    const r = box.current.getBoundingClientRect()
    return Math.min((r.width - 48) / natural.w, (r.height - 48) / natural.h, 1)
  })()

  const imageUpscalers = caps?.upscalers.filter((u) => u.image_upscale) ?? []

  return (
    <div className="flex h-full min-w-0 flex-1 flex-col">
      <div
        ref={box}
        className="checker relative flex-1 overflow-hidden"
        onWheel={(e) => {
          if (!natural) return
          const next = Math.min(8, Math.max(0.05, scale * (e.deltaY < 0 ? 1.15 : 1 / 1.15)))
          setZoom(next)
        }}
        onPointerDown={(e) => {
          if (inpaint) return
          dragging.current = { x: e.clientX, y: e.clientY, px: pan.x, py: pan.y }
        }}
        onPointerMove={(e) => {
          if (!dragging.current) return
          setPan({ x: dragging.current.px + e.clientX - dragging.current.x, y: dragging.current.py + e.clientY - dragging.current.y })
        }}
        onPointerUp={() => (dragging.current = null)}
        onPointerLeave={() => (dragging.current = null)}
        onDoubleClick={reset}
      >
        {src ? (
          <div
            className="absolute left-1/2 top-1/2"
            style={{
              width: natural ? natural.w * scale : undefined,
              height: natural ? natural.h * scale : undefined,
              transform: `translate(calc(-50% + ${pan.x}px), calc(-50% + ${pan.y}px))`
            }}
          >
            <img
              key={src}
              src={src}
              draggable={!inpaint}
              onDragStart={(e) => file && e.dataTransfer.setData('application/x-studio-image', file)}
              onLoad={(e) => setNatural({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
              className="develop block h-full w-full shadow-[0_30px_80px_-20px_rgba(0,0,0,0.8)]"
              style={{ imageRendering: scale > 2 ? 'pixelated' : 'auto' }}
            />
            {inpaint && initImage && <MaskPainter src={initImage} />}
          </div>
        ) : (
          <div className="flex h-full items-center justify-center">
            <Empty icon={<Scan size={48} strokeWidth={1} />} title="Nothing developed yet">
              Write a prompt and press <kbd className="rounded border border-ink-700 px-1 font-mono">Ctrl</kbd>+
              <kbd className="rounded border border-ink-700 px-1 font-mono">Enter</kbd>. Drop images on the left panel to edit them.
            </Empty>
          </div>
        )}

        {jobs.length > 0 && (
          <div className="absolute bottom-4 right-4 flex flex-col gap-2">
            {jobs.map((j) => (
              <div key={j.id} className="rise rounded-lg border border-ink-700 bg-ink-900/95 p-3 shadow-2xl backdrop-blur">
                <JobProgress job={j} />
              </div>
            ))}
          </div>
        )}

        {src && natural && (
          <div className="absolute bottom-4 left-4 flex items-center gap-1 rounded-md border border-ink-800 bg-ink-900/90 px-1 font-mono text-[10px] text-ink-400">
            <button className="px-1.5 py-1 hover:text-ink-100" onClick={reset} title="Fit">
              <Maximize size={11} />
            </button>
            <button className="px-1.5 py-1 hover:text-ink-100" onClick={() => setZoom(1)}>
              1:1
            </button>
            <span className="px-1.5">{Math.round(scale * 100)}%</span>
            <span className="border-l border-ink-700 px-1.5">
              {natural.w}×{natural.h}
            </span>
          </div>
        )}
      </div>

      {item && !inpaint && (
        <div className="flex items-center gap-3 border-t border-ink-800 bg-ink-900 px-4 py-2">
          <div className="min-w-0 flex-1">
            <p className="truncate text-[12px] text-ink-200 select-text" title={item.prompt}>
              {item.prompt}
            </p>
            <p className="truncate font-mono text-[10px] text-ink-500">
              {item.model} · {item.width}×{item.height}
              {item.seed != null && ` · seed ${item.seed}`} · {formatDuration(item.durationMs)}
              {formatCost(item.costUsd) && ` · ${formatCost(item.costUsd)}`}
              {item.kind === 'upscale' && ' · upscaled'}
            </p>
          </div>
          {item.files.length > 1 && (
            <div className="flex gap-1">
              {item.files.map((f, i) => (
                <button
                  key={f}
                  onClick={() => useStore.setState({ selected: { id: item.id, fileIndex: i } })}
                  className={cx('h-8 w-8 overflow-hidden rounded border', i === fileIndex ? 'border-safelight' : 'border-ink-700')}
                >
                  <img src={imgUrl(f)} className="h-full w-full object-cover" />
                </button>
              ))}
            </div>
          )}
          <div className="flex items-center gap-0.5">
            <IconButton title="Use as reference (edit)" onClick={() => file && void applyAsInput(file, 'ref')}>
              <Layers size={15} />
            </IconButton>
            {!SLIM && (
              <>
                <IconButton title="Use as init image (img2img, local)" onClick={() => file && void applyAsInput(file, 'init')}>
                  <ImageUp size={15} />
                </IconButton>
                <IconButton title="Inpaint (local)" onClick={() => file && void applyAsInput(file, 'inpaint')}>
                  <Brush size={15} />
                </IconButton>
              </>
            )}
            <IconButton title="Reuse settings" onClick={() => reuseSettings(item)}>
              <Recycle size={15} />
            </IconButton>
            {item.seed != null && (
              <IconButton
                title="Copy seed"
                onClick={() => {
                  void navigator.clipboard.writeText(String(item.seed))
                  useStore.getState().showInfo(`Seed ${item.seed} copied`)
                }}
              >
                <Copy size={15} />
              </IconButton>
            )}
            {provider === 'local' && caps?.upscale && (
              <div className="ml-1 flex items-center gap-1 border-l border-ink-800 pl-2">
                {imageUpscalers.length > 1 && (
                  <Select
                    className="w-32"
                    value={upscaler}
                    placeholder="auto"
                    onChange={setUpscaler}
                    options={imageUpscalers.map((u) => u.name)}
                  />
                )}
                <Button size="sm" onClick={() => void upscale(item, fileIndex, upscaler || undefined)} title="ESRGAN upscale (no re-generation)">
                  <Wand2 size={12} /> Upscale
                </Button>
              </div>
            )}
            <IconButton title="Show in folder" onClick={() => file && void window.api.history.reveal(file)}>
              <FolderOpen size={15} />
            </IconButton>
            <IconButton
              title="Delete"
              onClick={async () => {
                if (!confirm('Delete this image from disk and history?')) return
                await window.api.history.remove(item.id)
                useStore.setState({ history: useStore.getState().history.filter((h) => h.id !== item.id), selected: null })
              }}
            >
              <Trash2 size={15} />
            </IconButton>
          </div>
        </div>
      )}
    </div>
  )
}
