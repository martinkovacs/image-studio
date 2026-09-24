import { useRef, useState } from 'react'
import { ImagePlus, X } from 'lucide-react'
import type { OrImageModel } from '@shared/types'
import { useStore } from '../store'
import { cx, Toggle } from '../components/ui'
import { fileToDataUrl, imagesFromTransfer } from '../lib/util'

function Thumb({ src, onRemove, label }: { src: string; onRemove: () => void; label?: string }) {
  return (
    <div className="group relative h-16 w-16 shrink-0 overflow-hidden rounded-md border border-ink-700">
      <img src={src} className="h-full w-full object-cover" draggable={false} />
      {label && <span className="absolute bottom-0 left-0 bg-ink-950/80 px-1 font-mono text-[9px] text-ink-300">{label}</span>}
      <button
        onClick={onRemove}
        className="absolute right-0.5 top-0.5 hidden rounded bg-ink-950/80 p-0.5 text-ink-200 hover:text-stop group-hover:block"
      >
        <X size={11} />
      </button>
    </div>
  )
}

export function DropZone({ onImages, children, className }: { onImages: (urls: string[]) => void; children: React.ReactNode; className?: string }) {
  const [over, setOver] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  return (
    <div
      onDragOver={(e) => {
        e.preventDefault()
        setOver(true)
      }}
      onDragLeave={() => setOver(false)}
      onDrop={async (e) => {
        e.preventDefault()
        setOver(false)
        const internal = e.dataTransfer.getData('application/x-studio-image')
        if (internal) return onImages([await window.api.history.readAsDataUrl(internal)])
        onImages(await imagesFromTransfer(e.dataTransfer))
      }}
      onClick={() => input.current?.click()}
      className={cx('cursor-pointer transition-colors', over && 'border-safelight! bg-safelight/5', className)}
    >
      <input
        ref={input}
        type="file"
        accept="image/*"
        multiple
        hidden
        onChange={async (e) => {
          const files = Array.from(e.target.files ?? [])
          onImages(await Promise.all(files.map(fileToDataUrl)))
          e.target.value = ''
        }}
      />
      {children}
    </div>
  )
}

/** Reference images for edit / multi-reference models. */
export function RefImages({ orModel }: { orModel?: OrImageModel }) {
  const provider = useStore((s) => s.provider)
  const refs = useStore((s) => s.inputs.refImages)
  const add = useStore((s) => s.addRefImages)
  const remove = useStore((s) => s.removeRefImage)
  const caps = useStore((s) => s.caps)

  let max = 16
  let note = ''
  if (provider === 'openrouter' && orModel) {
    const spec = orModel.supported_parameters.input_references
    max = spec?.type === 'range' ? spec.max : 0
    if (max === 0) note = 'This model does not accept input images.'
  } else if (provider === 'local' && caps && caps.features_by_mode.img_gen?.ref_images === false) {
    note = 'Loaded model has no reference-image support; use Init image (Advanced) for img2img.'
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-1.5">
        {refs.map((r, i) => (
          <Thumb key={i} src={r} label={`#${i + 1}`} onRemove={() => remove(i)} />
        ))}
        {refs.length < max && (
          <DropZone
            onImages={(urls) => add(urls.slice(0, max - refs.length))}
            className="flex h-16 w-16 items-center justify-center rounded-md border border-dashed border-ink-600 text-ink-500 hover:border-ink-400 hover:text-ink-300"
          >
            <ImagePlus size={18} />
          </DropZone>
        )}
      </div>
      <p className="text-[11px] leading-snug text-ink-500">
        {note ||
          (refs.length
            ? `Edit mode: the prompt describes the change. ${max < 16 ? `Up to ${max}.` : ''}`
            : 'Drop, paste or click to add images to edit / use as reference.')}
      </p>
    </div>
  )
}

/** Local img2img / inpaint source. */
export function InitImage() {
  const inputs = useStore((s) => s.inputs)
  const inpaint = useStore((s) => s.inpaintMode)
  const set = useStore((s) => s.set)
  const caps = useStore((s) => s.caps)
  const setInit = (url?: string) => {
    set('inputs', { ...inputs, initImage: url, maskImage: undefined })
    if (!url) set('inpaintMode', false)
  }
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-start gap-2">
        {inputs.initImage ? (
          <Thumb src={inputs.initImage} onRemove={() => setInit(undefined)} label="init" />
        ) : (
          <DropZone
            onImages={(u) => setInit(u[0])}
            className="flex h-16 w-16 items-center justify-center rounded-md border border-dashed border-ink-600 text-ink-500 hover:border-ink-400"
          >
            <ImagePlus size={18} />
          </DropZone>
        )}
        {inputs.maskImage && <Thumb src={inputs.maskImage} onRemove={() => set('inputs', { ...inputs, maskImage: undefined })} label="mask" />}
        <p className="flex-1 text-[11px] leading-snug text-ink-500">
          img2img: the output starts from this image. Strength controls how much changes.
        </p>
      </div>
      <Toggle
        label="Paint inpaint mask on canvas"
        hint="White areas get regenerated. Works best with inpainting checkpoints, but any model can inpaint."
        checked={inpaint}
        onChange={(v) => {
          if (v && !inputs.initImage) return useStore.getState().showError('Add an init image first (or use "Inpaint" on a history image)')
          if (v && caps && caps.features_by_mode.img_gen?.mask_image === false) return useStore.getState().showError('Loaded model does not support masks')
          set('inpaintMode', v)
        }}
      />
    </div>
  )
}

export function StrengthField() {
  const localParams = useStore((s) => s.localParams)
  const caps = useStore((s) => s.caps)
  const patch = useStore((s) => s.patchLocal)
  const v = localParams.strength ?? caps?.defaults_by_mode.img_gen?.strength ?? 0.75
  return (
    <label className="flex items-center gap-3">
      <span className="label-caps w-16">Strength</span>
      <input
        type="range"
        min={0}
        max={1}
        step={0.01}
        value={v}
        style={{ ['--fill' as string]: `${v * 100}%` }}
        onChange={(e) => patch({ strength: Number(e.target.value) })}
        className="flex-1"
      />
      <span className="w-9 text-right font-mono text-[11px] text-ink-300">{v.toFixed(2)}</span>
    </label>
  )
}
