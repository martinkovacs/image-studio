import { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowUp, FolderOpen, Maximize2, MessageSquarePlus, Paperclip, Pencil, Ruler, Trash2, X } from 'lucide-react'
import { imgUrl, type ChatThread, type HistoryItem } from '@shared/types'
import { useStore } from '../store'
import { Chip, cx, IconButton } from '../components/ui'
import { fileToDataUrl, formatCost, formatDuration, imagesFromTransfer } from '../lib/util'
import { LocalModelSelect, OpenRouterModelSelect, ProviderSwitch, ServerDot } from '../studio/ModelPicker'
import { LocalResolution, OpenRouterResolution } from '../studio/ResolutionPicker'
import { JobProgress } from '../studio/Canvas'

const EXAMPLES = [
  'A lighthouse on a basalt cliff at blue hour, long exposure, 35mm film',
  'Isometric cutaway of a tiny ramen shop, warm light, highly detailed',
  'Studio product shot of a matte ceramic mug on travertine, soft shadows',
  'Botanical illustration of a fern, ink and watercolor, cream paper'
]

const ACTIVE_KEY = 'chat:activeThread'

function Lightbox({ src, onClose }: { src: string; onClose: () => void }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', k)
    return () => window.removeEventListener('keydown', k)
  }, [onClose])
  return (
    <div onClick={onClose} className="fixed inset-0 z-50 flex items-center justify-center bg-ink-950/95 p-8">
      <img src={src} className="develop max-h-full max-w-full object-contain" />
    </div>
  )
}

function SizePopover() {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const provider = useStore((s) => s.provider)
  const model = useStore((s) => s.orModels.find((m) => m.id === s.orModel))
  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false)
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open])
  return (
    <div ref={ref} className="relative">
      <IconButton title="Output size" active={open} onClick={() => setOpen(!open)}>
        <Ruler size={15} />
      </IconButton>
      {open && (
        <div className="rise absolute right-0 top-full z-40 mt-2 w-80 rounded-lg border border-ink-700 bg-ink-900 p-4 shadow-2xl">
          {provider === 'local' ? <LocalResolution /> : <OpenRouterResolution model={model} />}
        </div>
      )}
    </div>
  )
}

function ThreadList({
  threads,
  active,
  onSelect,
  onNew,
  onChanged
}: {
  threads: ChatThread[]
  active: string | null
  onSelect: (id: string) => void
  onNew: () => void
  onChanged: () => void
}) {
  const [editing, setEditing] = useState<string | null>(null)
  return (
    <aside className="flex w-60 shrink-0 flex-col border-r border-ink-800 bg-ink-900">
      <div className="p-3">
        <button
          onClick={onNew}
          className="flex h-9 w-full items-center gap-2 rounded-md border border-ink-700 px-3 text-[13px] text-ink-200 hover:border-safelight/60 hover:text-ink-100"
        >
          <MessageSquarePlus size={15} /> New chat
        </button>
      </div>
      <div className="flex-1 overflow-y-auto px-2 pb-3">
        {threads.map((t) => (
          <div
            key={t.id}
            onClick={() => onSelect(t.id)}
            onDoubleClick={() => setEditing(t.id)}
            className={cx(
              'group flex cursor-pointer items-center gap-1 rounded-md px-2.5 py-2 text-[13px]',
              t.id === active ? 'bg-ink-800 text-ink-100' : 'text-ink-300 hover:bg-ink-850'
            )}
          >
            {editing === t.id ? (
              <input
                autoFocus
                defaultValue={t.title}
                onBlur={async (e) => {
                  setEditing(null)
                  if (e.target.value.trim() && e.target.value !== t.title) {
                    await window.api.history.renameThread(t.id, e.target.value.trim())
                    onChanged()
                  }
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
                  if (e.key === 'Escape') setEditing(null)
                }}
                className="min-w-0 flex-1 rounded bg-ink-900 px-1 outline-none ring-1 ring-safelight/60"
              />
            ) : (
              <span className="min-w-0 flex-1 truncate">{t.title}</span>
            )}
            <button
              title="Delete chat"
              onClick={async (e) => {
                e.stopPropagation()
                if (!confirm(`Delete "${t.title}"? Images stay on disk.`)) return
                await window.api.history.deleteThread(t.id)
                onChanged()
              }}
              className="hidden text-ink-300 hover:text-stop group-hover:block"
            >
              <Trash2 size={12} />
            </button>
          </div>
        ))}
      </div>
    </aside>
  )
}

function Message({ item, onEdit }: { item: HistoryItem; onEdit: (path: string) => void }) {
  const [zoomed, setZoomed] = useState<string | null>(null)
  const cost = formatCost(item.costUsd)
  return (
    <div className="rise flex flex-col gap-3">
      <div className="flex flex-col items-end gap-1.5">
        {item.inputFiles.length > 0 && (
          <div className="flex gap-1.5">
            {item.inputFiles.map((f) => (
              <img key={f} src={imgUrl(f)} className="h-14 w-14 rounded-lg border border-ink-700 object-cover" />
            ))}
          </div>
        )}
        <div className="max-w-[80%] select-text whitespace-pre-wrap rounded-2xl rounded-br-md bg-ink-800 px-4 py-2.5 text-[14px] leading-relaxed text-ink-100">
          {item.prompt}
        </div>
      </div>
      <div className="flex flex-col items-start gap-2">
        <div className="flex flex-wrap gap-2">
          {item.files.map((f) => (
            <div key={f} className="group relative">
              <img
                src={imgUrl(f)}
                onClick={() => setZoomed(imgUrl(f))}
                className="develop max-h-[60vh] max-w-full cursor-zoom-in rounded-lg shadow-[0_20px_60px_-20px_rgba(0,0,0,0.7)]"
              />
              <div className="absolute right-2 top-2 hidden gap-1 rounded-md bg-ink-950/85 p-0.5 group-hover:flex">
                <IconButton title="Edit this image" onClick={() => onEdit(f)}>
                  <Pencil size={14} />
                </IconButton>
                <IconButton
                  title="Open in Studio"
                  onClick={() => {
                    useStore.setState({ selected: { id: item.id, fileIndex: item.files.indexOf(f) } })
                    void useStore.getState().updateSettings({ uiMode: 'studio' })
                  }}
                >
                  <Maximize2 size={14} />
                </IconButton>
                <IconButton title="Show in folder" onClick={() => void window.api.history.reveal(f)}>
                  <FolderOpen size={14} />
                </IconButton>
              </div>
            </div>
          ))}
        </div>
        <span className="font-mono text-[10px] text-ink-300">
          {item.model.split('/').pop()} · {item.width}×{item.height}
          {item.seed != null && ` · seed ${item.seed}`} · {formatDuration(item.durationMs)}
          {cost && ` · ${cost}`}
        </span>
      </div>
      {zoomed && <Lightbox src={zoomed} onClose={() => setZoomed(null)} />}
    </div>
  )
}

export function ChatView() {
  const provider = useStore((s) => s.provider)
  const jobs = useStore((s) => s.jobs)
  const generate = useStore((s) => s.generate)
  const [threads, setThreads] = useState<ChatThread[]>([])
  const [active, setActive] = useState<string | null>(localStorage.getItem(ACTIVE_KEY))
  const [items, setItems] = useState<HistoryItem[]>([])
  const [errors, setErrors] = useState<{ prompt: string; error: string }[]>([])
  const [text, setText] = useState('')
  const [attachments, setAttachments] = useState<string[]>([])
  const [continueEditing, setContinueEditing] = useState(true)
  // Local models without reference-image support iterate via img2img instead.
  const [asInit, setAsInit] = useState(localStorage.getItem('chat:asInit') === '1')
  const [dragOver, setDragOver] = useState(false)
  const scroller = useRef<HTMLDivElement>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const textarea = useRef<HTMLTextAreaElement>(null)

  const loadThreads = useCallback(async () => {
    const t = await window.api.history.threads()
    t.sort((a, b) => b.updatedAt - a.updatedAt)
    setThreads(t)
    return t
  }, [])

  const select = (id: string | null) => {
    setActive(id)
    setErrors([])
    if (id) localStorage.setItem(ACTIVE_KEY, id)
    else localStorage.removeItem(ACTIVE_KEY)
  }

  useEffect(() => {
    void loadThreads().then((t) => {
      if (active && !t.some((x) => x.id === active)) select(null)
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (!active) return setItems([])
    void window.api.history.list({ threadId: active, limit: 500 }).then((list) => setItems([...list].reverse()))
  }, [active])

  const pending = Object.values(jobs).filter((j) => j.request.threadId && j.request.threadId === active)

  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: 'smooth' })
  }, [items.length, pending.length, errors.length])

  // Auto-grow composer
  useEffect(() => {
    const t = textarea.current
    if (!t) return
    t.style.height = 'auto'
    t.style.height = Math.min(t.scrollHeight, 8 * 22 + 20) + 'px'
  }, [text])

  const lastOutput = [...items].reverse().find((i) => i.files.length)?.files[0]
  const autoAttach = continueEditing && attachments.length === 0 && !!lastOutput

  const sending = useRef(false)

  const send = async () => {
    const prompt = text.trim()
    // Guard the async prelude (thread creation, attachment read) against double submits.
    if (!prompt || sending.current) return
    sending.current = true
    try {
      await sendPrompt(prompt)
    } finally {
      sending.current = false
    }
  }

  const sendPrompt = async (prompt: string) => {
    let refImages = attachments
    if (autoAttach && lastOutput) refImages = [await window.api.history.readAsDataUrl(lastOutput)]
    let threadId = active
    if (!threadId) {
      const t = await window.api.history.createThread(prompt.slice(0, 48))
      threadId = t.id
      select(t.id)
    }
    setText('')
    setAttachments([])
    const useInit = provider === 'local' && asInit && refImages.length > 0
    const inputs = useInit ? { refImages: [], initImage: refImages[0] } : { refImages }
    sending.current = false
    const res = await generate({ threadId, prompt, inputs })
    // The user may have switched threads while this was generating.
    const stillActive = threadId === localStorage.getItem(ACTIVE_KEY)
    if (res?.ok && stillActive) setItems((prev) => [...prev, res.item])
    else if (res && !res.ok && !res.cancelled && stillActive) setErrors((e) => [...e, { prompt, error: res.error }])
    void loadThreads()
  }

  const addFiles = async (urls: string[]) => setAttachments((a) => [...a, ...urls])

  return (
    <div className="flex h-full">
      <ThreadList threads={threads} active={active} onSelect={select} onNew={() => select(null)} onChanged={() => void loadThreads().then((t) => !t.some((x) => x.id === active) && select(null))} />

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center gap-3 border-b border-ink-800 px-5 py-2.5">
          <span className="min-w-0 flex-1 truncate font-display text-[15px] font-semibold text-ink-200">
            {threads.find((t) => t.id === active)?.title ?? 'New chat'}
          </span>
          <ProviderSwitch size="sm" />
          <div className="w-72">{provider === 'local' ? <LocalModelSelect compact /> : <OpenRouterModelSelect />}</div>
          {provider === 'local' && <ServerDot />}
          <SizePopover />
        </header>

        <div
          ref={scroller}
          className="flex-1 overflow-y-auto"
          onDragOver={(e) => {
            e.preventDefault()
            setDragOver(true)
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={async (e) => {
            e.preventDefault()
            setDragOver(false)
            void addFiles(await imagesFromTransfer(e.dataTransfer))
          }}
        >
          <div className={cx('mx-auto flex max-w-3xl flex-col gap-8 px-6 py-8', dragOver && 'opacity-60')}>
            {items.length === 0 && pending.length === 0 && (
              <div className="flex flex-col items-center gap-6 pt-[14vh] text-center">
                <h1 className="font-display text-4xl font-semibold tracking-tight text-ink-100">
                  What should we <span className="text-safelight">develop</span>?
                </h1>
                <p className="max-w-md text-sm text-ink-300">Describe an image, or attach one and say how to change it. Each reply builds on the last image.</p>
                <div className="grid max-w-2xl grid-cols-2 gap-2">
                  {EXAMPLES.map((ex) => (
                    <button
                      key={ex}
                      onClick={() => {
                        setText(ex)
                        textarea.current?.focus()
                      }}
                      className="rounded-lg border border-ink-800 bg-ink-900 p-3 text-left text-[12px] leading-snug text-ink-300 hover:border-ink-600 hover:text-ink-100"
                    >
                      {ex}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {items.map((item) => (
              <Message
                key={item.id}
                item={item}
                onEdit={async (path) => {
                  setAttachments([await window.api.history.readAsDataUrl(path)])
                  textarea.current?.focus()
                }}
              />
            ))}
            {errors.map((e, i) => (
              <div key={i} className="flex flex-col gap-2">
                <div className="self-end rounded-2xl rounded-br-md bg-ink-800 px-4 py-2.5 text-[14px] text-ink-100">{e.prompt}</div>
                <div className="self-start rounded-lg border border-stop/40 bg-stop/5 px-4 py-2.5 text-[13px] text-ink-200">{e.error}</div>
              </div>
            ))}
            {pending.map((j) => (
              <div key={j.id} className="rise flex flex-col gap-3">
                <div className="self-end max-w-[80%] rounded-2xl rounded-br-md bg-ink-800 px-4 py-2.5 text-[14px] text-ink-100">{j.request.prompt}</div>
                <div className="checker flex h-64 w-64 items-end rounded-lg border border-ink-700 p-3">
                  <div className="w-full rounded-md bg-ink-900/95 p-2.5">
                    <JobProgress job={j} compact />
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="px-6 pb-5">
          <div className="mx-auto max-w-3xl rounded-2xl border border-ink-700 bg-ink-900 p-2 shadow-[0_-10px_40px_-20px_rgba(0,0,0,0.6)] focus-within:border-ink-500">
            {(attachments.length > 0 || autoAttach) && (
              <div className="flex gap-2 px-2 pb-2 pt-1">
                {attachments.map((a, i) => (
                  <div key={i} className="group relative">
                    <img src={a} className="h-14 w-14 rounded-lg border border-ink-700 object-cover" />
                    <button
                      onClick={() => setAttachments(attachments.filter((_, j) => j !== i))}
                      className="absolute -right-1.5 -top-1.5 hidden rounded-full bg-ink-700 p-0.5 text-ink-100 group-hover:block"
                    >
                      <X size={11} />
                    </button>
                  </div>
                ))}
                {autoAttach && lastOutput && (
                  <div className="flex items-center gap-2" title="The last image is attached automatically">
                    <img src={imgUrl(lastOutput)} className="h-14 w-14 rounded-lg border border-dashed border-safelight/60 object-cover opacity-80" />
                    <span className="font-mono text-[10px] text-ink-300">editing last image</span>
                  </div>
                )}
              </div>
            )}
            <div className="flex items-end gap-1">
              <IconButton title="Attach images" onClick={() => fileInput.current?.click()}>
                <Paperclip size={16} />
              </IconButton>
              <input
                ref={fileInput}
                type="file"
                accept="image/*"
                multiple
                hidden
                onChange={async (e) => {
                  void addFiles(await Promise.all(Array.from(e.target.files ?? []).map(fileToDataUrl)))
                  e.target.value = ''
                }}
              />
              <textarea
                ref={textarea}
                rows={1}
                value={text}
                autoFocus
                onChange={(e) => setText(e.target.value)}
                onPaste={async (e) => {
                  const urls = await imagesFromTransfer(e.clipboardData)
                  if (urls.length) void addFiles(urls)
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault()
                    void send()
                  }
                }}
                placeholder={autoAttach ? 'Describe the next change…' : 'Describe an image…'}
                className="max-h-48 min-h-9 flex-1 resize-none bg-transparent px-2 py-2 text-[14px] leading-[22px] text-ink-100 outline-none placeholder:text-ink-300"
              />
              <button
                onClick={() => void send()}
                disabled={!text.trim()}
                className="mb-0.5 flex h-8 w-8 items-center justify-center rounded-full bg-safelight text-ink-950 transition-opacity disabled:opacity-30"
              >
                <ArrowUp size={16} />
              </button>
            </div>
          </div>
          <div className="mx-auto mt-2 flex max-w-3xl items-center gap-2">
            <Chip active={continueEditing} onClick={() => setContinueEditing(!continueEditing)} title="Attach the previous result automatically">
              continue editing last image
            </Chip>
            {provider === 'local' && (
              <Chip
                active={asInit}
                onClick={() => {
                  localStorage.setItem('chat:asInit', asInit ? '0' : '1')
                  setAsInit(!asInit)
                }}
                title="Send the image as img2img init instead of a reference. Use for models without edit support (SD, SDXL, Flux.1-dev)."
              >
                img2img
              </Chip>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
