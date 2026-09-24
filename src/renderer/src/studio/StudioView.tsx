import { useEffect, useState } from 'react'
import { KeyRound, Sparkles, Wand2 } from 'lucide-react'
import { useStore } from '../store'
import { Button, Section, Segmented, TextArea } from '../components/ui'
import { imagesFromTransfer } from '../lib/util'
import { SLIM } from '../lib/edition'
import { LocalModelSelect, OpenRouterModelSelect, ProviderSwitch } from './ModelPicker'
import { LocalResolution, OpenRouterResolution } from './ResolutionPicker'
import { HiresSection, LocalParams, LoraSection, OpenRouterParams, PerformanceSection, SkipLayerGuidance, VaeTilingSection } from './Params'
import { InitImage, RefImages, StrengthField } from './Inputs'
import { Canvas } from './Canvas'
import { HistoryStrip } from './HistoryStrip'

const isMac = navigator.platform.toLowerCase().includes('mac')

function isTextTarget(t: EventTarget | null): boolean {
  return t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement
}

function ModelBadges() {
  const orModels = useStore((s) => s.orModels)
  const orModel = useStore((s) => s.orModel)
  const m = orModels.find((x) => x.id === orModel)
  if (!m) return null
  const sp = m.supported_parameters
  const badges = [
    sp.resolution?.type === 'enum' && `max ${sp.resolution.values[sp.resolution.values.length - 1]}`,
    sp.input_references?.type === 'range' && sp.input_references.max > 0 && `edit ≤${sp.input_references.max} refs`,
    sp.seed && 'seed',
    m.supports_streaming && 'stream'
  ].filter(Boolean) as string[]
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap gap-1">
        {badges.map((b) => (
          <span key={b} className="rounded border border-ink-700 px-1.5 py-0.5 font-mono text-[10px] text-ink-300">
            {b}
          </span>
        ))}
      </div>
      {m.description && <p className="line-clamp-3 text-[11px] leading-snug text-ink-500">{m.description}</p>}
    </div>
  )
}

export function StudioView() {
  const settings = useStore((s) => s.settings)!
  const provider = useStore((s) => s.provider)
  const prompt = useStore((s) => s.prompt)
  const negativePrompt = useStore((s) => s.negativePrompt)
  const set = useStore((s) => s.set)
  const generate = useStore((s) => s.generate)
  const updateSettings = useStore((s) => s.updateSettings)
  const orModels = useStore((s) => s.orModels)
  const orModel = useStore((s) => s.orModel)
  const refCount = useStore((s) => s.inputs.refImages.length)
  const hasInit = useStore((s) => !!s.inputs.initImage)
  const jobCount = useStore((s) => Object.keys(s.jobs).length)
  const serverState = useStore((s) => s.serverStatus.state)
  const addRefImages = useStore((s) => s.addRefImages)
  const setView = useStore((s) => s.setView)
  const [showNeg, setShowNeg] = useState(negativePrompt.length > 0)

  const advanced = settings.studioDetail === 'advanced'
  const model = orModels.find((m) => m.id === orModel)
  const local = provider === 'local'
  const needsKey = provider === 'openrouter' && !settings.openrouter.hasApiKey

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault()
        void useStore.getState().generate()
      }
    }
    const onPaste = async (e: ClipboardEvent) => {
      if (isTextTarget(e.target) && !(e.target instanceof HTMLTextAreaElement)) return
      const urls = await imagesFromTransfer(e.clipboardData)
      if (urls.length) {
        e.preventDefault()
        addRefImages(urls)
      }
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('paste', onPaste)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('paste', onPaste)
    }
  }, [addRefImages])

  return (
    <div className="flex h-full">
      <aside className="flex w-[344px] shrink-0 flex-col border-r border-ink-800 bg-ink-900">
        <div className="flex items-center justify-between gap-2 border-b border-ink-800 px-4 py-2.5">
          <ProviderSwitch size="sm" />
          {!SLIM && <Segmented
            size="sm"
            value={settings.studioDetail}
            onChange={(v) => void updateSettings({ studioDetail: v })}
            options={[
              { value: 'simple', label: 'Simple' },
              { value: 'advanced', label: 'Advanced', title: 'Inpainting, hires fix, upscaling, LoRA and every sampler parameter' }
            ]}
          />}
        </div>

        <div className="flex-1 overflow-y-auto">
          <Section title="Model">
            {local ? (
              <LocalModelSelect />
            ) : (
              <>
                <OpenRouterModelSelect />
                <ModelBadges />
              </>
            )}
          </Section>

          <Section title="Prompt">
            <TextArea
              rows={5}
              autoFocus
              value={prompt}
              onChange={(e) => set('prompt', e.target.value)}
              placeholder={refCount ? 'Describe the edit… e.g. "replace the sky with a stormy sunset"' : 'Describe the image…'}
            />
            {local &&
              (showNeg ? (
                <TextArea
                  rows={2}
                  value={negativePrompt}
                  onChange={(e) => set('negativePrompt', e.target.value)}
                  placeholder="Negative prompt (leave blank for Qwen-Image / Flux)"
                />
              ) : (
                <button onClick={() => setShowNeg(true)} className="self-start text-[11px] text-ink-300 hover:text-safelight">
                  + negative prompt
                </button>
              ))}
          </Section>

          <Section title="Images" defaultOpen={refCount > 0 || hasInit}>
            <RefImages orModel={model} />
            {local && advanced && (
              <div className="flex flex-col gap-3 border-t border-ink-800 pt-3">
                <span className="label-caps">Init image · img2img / inpaint</span>
                <InitImage />
                {hasInit && <StrengthField />}
              </div>
            )}
          </Section>

          <Section title="Size">{local ? <LocalResolution /> : <OpenRouterResolution model={model} />}</Section>

          <Section title="Parameters">{local ? <LocalParams advanced={advanced} /> : <OpenRouterParams model={model} />}</Section>

          {local && advanced && (
            <>
              <LoraSection />
              <HiresSection />
              <VaeTilingSection />
              <SkipLayerGuidance />
              <PerformanceSection />
            </>
          )}
        </div>

        <div className="border-t border-ink-800 bg-ink-900 p-3">
          {needsKey ? (
            <Button size="lg" className="w-full" onClick={() => setView('settings')}>
              <KeyRound size={15} /> Add an OpenRouter API key
            </Button>
          ) : (
            <Button
              variant="primary"
              size="lg"
              className="w-full"
              disabled={local && serverState === 'starting' && jobCount > 0}
              onClick={() => void generate()}
            >
              {refCount || hasInit ? <Wand2 size={15} /> : <Sparkles size={15} />}
              {refCount || hasInit ? 'Edit' : 'Generate'}
              <span className="ml-auto font-mono text-[10px] opacity-60">{isMac ? '⌘' : 'Ctrl'}+↵</span>
            </Button>
          )}
          {jobCount > 0 && (
            <p className="mt-2 text-center font-mono text-[10px] text-ink-300">
              {jobCount} running{local && serverState === 'starting' ? ' · loading model…' : ''}
            </p>
          )}
        </div>
      </aside>

      <Canvas />
      <HistoryStrip />
    </div>
  )
}
