import { useEffect, useId, useRef, useState, type ReactNode, type ButtonHTMLAttributes } from 'react'
import { ChevronDown, Info } from 'lucide-react'

export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ')
}

type Variant = 'primary' | 'ghost' | 'outline' | 'danger'

export function Button({
  variant = 'outline',
  size = 'md',
  className,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: 'sm' | 'md' | 'lg' }) {
  return (
    <button
      {...rest}
      className={cx(
        'inline-flex items-center justify-center gap-1.5 rounded-md font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40',
        size === 'sm' && 'h-7 px-2.5 text-xs',
        size === 'md' && 'h-8 px-3 text-[13px]',
        size === 'lg' && 'h-11 px-5 text-sm',
        variant === 'primary' &&
          'bg-safelight text-ink-950 hover:brightness-110 active:brightness-95 shadow-[0_0_24px_-6px_var(--color-safelight)]',
        variant === 'outline' && 'border border-ink-700 bg-ink-850 text-ink-200 hover:border-ink-500 hover:text-ink-100',
        variant === 'ghost' && 'text-ink-300 hover:bg-ink-800 hover:text-ink-100',
        variant === 'danger' && 'border border-stop/40 text-stop hover:bg-stop/10',
        className
      )}
    />
  )
}

export function IconButton({
  title,
  active,
  className,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { title: string; active?: boolean }) {
  return (
    <button
      {...rest}
      title={title}
      aria-label={title}
      className={cx(
        'inline-flex h-8 w-8 items-center justify-center rounded-md transition-colors disabled:opacity-40',
        active ? 'bg-ink-700 text-safelight' : 'text-ink-300 hover:bg-ink-800 hover:text-ink-100',
        className
      )}
    />
  )
}

export function Hint({ text }: { text: string }) {
  return (
    <span className="group relative inline-flex">
      <Info size={12} className="text-ink-400 group-hover:text-ink-300" />
      <span className="pointer-events-none absolute bottom-full left-1/2 z-50 mb-2 hidden w-60 -translate-x-1/2 rounded-md border border-ink-700 bg-ink-900 p-2 text-[11px] leading-snug normal-case tracking-normal text-ink-200 shadow-xl group-hover:block">
        {text}
      </span>
    </span>
  )
}

export function Field({ label, hint, children, right }: { label: string; hint?: string; children: ReactNode; right?: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between gap-2">
        <span className="label-caps flex items-center gap-1.5">
          {label}
          {hint && <Hint text={hint} />}
        </span>
        {right}
      </div>
      {children}
    </div>
  )
}

export function Section({
  title,
  children,
  defaultOpen = true,
  aside
}: {
  title: string
  children: ReactNode
  defaultOpen?: boolean
  aside?: ReactNode
}) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <section className="border-b border-ink-800">
      <div className="flex items-center gap-2 px-4 py-2.5">
        <button onClick={() => setOpen(!open)} className="flex flex-1 items-center gap-2 text-left">
          <ChevronDown size={13} className={cx('text-ink-400 transition-transform', !open && '-rotate-90')} />
          <span className="font-display text-[13px] font-semibold tracking-tight text-ink-200">{title}</span>
        </button>
        {aside}
      </div>
      {open && <div className="flex flex-col gap-4 px-4 pb-4">{children}</div>}
    </section>
  )
}

const inputBase =
  'h-8 w-full rounded-md border border-ink-700 bg-ink-900 px-2.5 text-[13px] text-ink-100 outline-none placeholder:text-ink-300 focus:border-safelight/70'

export function TextInput(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={cx(inputBase, props.className)} />
}

export function TextArea(props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      {...props}
      className={cx(
        'w-full resize-none rounded-md border border-ink-700 bg-ink-900 px-2.5 py-2 text-[13px] leading-relaxed text-ink-100 outline-none placeholder:text-ink-300 focus:border-safelight/70',
        props.className
      )}
    />
  )
}

export function Select({
  value,
  onChange,
  options,
  className,
  placeholder
}: {
  value: string
  onChange: (v: string) => void
  options: (string | { value: string; label: string })[]
  className?: string
  placeholder?: string
}) {
  return (
    <div className={cx('relative', className)}>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={cx(inputBase, 'appearance-none pr-7')}
      >
        {placeholder !== undefined && <option value="">{placeholder}</option>}
        {options.map((o) => {
          const opt = typeof o === 'string' ? { value: o, label: o } : o
          return (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          )
        })}
      </select>
      <ChevronDown size={13} className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-ink-400" />
    </div>
  )
}

/** Number input that tolerates partial typing and commits on blur/Enter. */
export function NumberInput({
  value,
  onChange,
  min,
  max,
  step = 1,
  className,
  placeholder
}: {
  value: number | undefined | null
  onChange: (v: number | undefined) => void
  min?: number
  max?: number
  step?: number
  className?: string
  placeholder?: string
}) {
  const [draft, setDraft] = useState(value == null ? '' : String(value))
  useEffect(() => setDraft(value == null ? '' : String(value)), [value])
  const commit = () => {
    if (draft.trim() === '') return onChange(undefined)
    let n = Number(draft)
    if (!Number.isFinite(n)) return setDraft(value == null ? '' : String(value))
    if (min !== undefined) n = Math.max(min, n)
    if (max !== undefined) n = Math.min(max, n)
    onChange(n)
    setDraft(String(n))
  }
  return (
    <input
      inputMode="decimal"
      value={draft}
      placeholder={placeholder}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') commit()
        if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
          e.preventDefault()
          const n = (value ?? 0) + (e.key === 'ArrowUp' ? step : -step)
          const clamped = Math.min(max ?? Infinity, Math.max(min ?? -Infinity, +n.toFixed(4)))
          onChange(clamped)
        }
      }}
      className={cx(inputBase, 'font-mono tabular-nums', className)}
    />
  )
}

export function SliderField({
  label,
  hint,
  value,
  onChange,
  min,
  max,
  step = 1,
  placeholder
}: {
  label: string
  hint?: string
  value: number | undefined | null
  onChange: (v: number | undefined) => void
  min: number
  max: number
  step?: number
  placeholder?: string
}) {
  const v = value ?? min
  const fill = `${((Math.min(max, Math.max(min, v)) - min) / (max - min)) * 100}%`
  return (
    <Field label={label} hint={hint}>
      <div className="flex items-center gap-3">
        <input
          type="range"
          min={min}
          max={max}
          step={step}
          value={v}
          style={{ ['--fill' as string]: fill }}
          onChange={(e) => onChange(Number(e.target.value))}
          className="flex-1"
        />
        <NumberInput
          value={value}
          onChange={onChange}
          step={step}
          placeholder={placeholder}
          className="h-7 !w-16 px-1.5 text-right text-xs"
        />
      </div>
    </Field>
  )
}

export function Toggle({ checked, onChange, label, hint }: { checked: boolean; onChange: (v: boolean) => void; label?: string; hint?: string }) {
  const id = useId()
  return (
    <label htmlFor={id} className="flex cursor-pointer items-center justify-between gap-3">
      {label && (
        <span className="flex items-center gap-1.5 text-[13px] text-ink-200">
          {label}
          {hint && <Hint text={hint} />}
        </span>
      )}
      <button
        id={id}
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={cx(
          'relative h-[18px] w-8 shrink-0 rounded-full transition-colors',
          checked ? 'bg-safelight' : 'bg-ink-600'
        )}
      >
        <span
          className={cx(
            'absolute top-[3px] h-3 w-3 rounded-full bg-ink-100 transition-all',
            checked ? 'left-[17px] bg-ink-950' : 'left-[3px]'
          )}
        />
      </button>
    </label>
  )
}

export function Segmented<T extends string>({
  value,
  onChange,
  options,
  size = 'md'
}: {
  value: T
  onChange: (v: T) => void
  options: { value: T; label: ReactNode; title?: string }[]
  size?: 'sm' | 'md'
}) {
  return (
    <div className="inline-flex rounded-md border border-ink-700 bg-ink-900 p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          title={o.title}
          onClick={() => onChange(o.value)}
          className={cx(
            'flex items-center gap-1.5 rounded-[5px] font-medium transition-colors',
            size === 'sm' ? 'h-6 px-2 text-[11px]' : 'h-7 px-3 text-xs',
            value === o.value ? 'bg-ink-700 text-ink-100' : 'text-ink-300 hover:text-ink-200'
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

export function Chip({ active, children, onClick, title }: { active?: boolean; children: ReactNode; onClick?: () => void; title?: string }) {
  return (
    <button
      title={title}
      aria-pressed={!!active}
      onClick={onClick}
      className={cx(
        'h-7 rounded-md border px-2 font-mono text-[11px] transition-colors',
        active
          ? 'border-safelight/70 bg-safelight/10 text-safelight'
          : 'border-ink-700 bg-ink-900 text-ink-300 hover:border-ink-500 hover:text-ink-100'
      )}
    >
      {children}
    </button>
  )
}

/** Searchable dropdown for long lists (e.g. OpenRouter models). */
export function Combobox({
  value,
  onChange,
  items,
  placeholder
}: {
  value: string
  onChange: (v: string) => void
  items: { value: string; label: string; sub?: string; badge?: string }[]
  placeholder?: string
}) {
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const [hi, setHi] = useState(0)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open])
  const current = items.find((i) => i.value === value)
  const filtered = items.filter((i) => (i.label + ' ' + i.value).toLowerCase().includes(q.toLowerCase()))
  const pick = (v: string) => {
    onChange(v)
    setOpen(false)
    setQ('')
  }
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') setOpen(false)
    else if (e.key === 'ArrowDown') setHi((h) => Math.min(filtered.length - 1, h + 1))
    else if (e.key === 'ArrowUp') setHi((h) => Math.max(0, h - 1))
    else if (e.key === 'Enter' && filtered[hi]) pick(filtered[hi].value)
    else return
    e.preventDefault()
  }
  return (
    <div ref={ref} className="relative">
      <button
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => {
          setHi(0)
          setOpen(!open)
        }}
        className={cx(inputBase, 'flex items-center justify-between text-left')}
      >
        <span className={cx('truncate', !current && 'text-ink-300')}>{current?.label ?? (value || placeholder)}</span>
        <ChevronDown size={13} className="shrink-0 text-ink-400" />
      </button>
      {open && (
        <div className="rise absolute left-0 right-0 top-full z-40 mt-1 overflow-hidden rounded-md border border-ink-700 bg-ink-900 shadow-2xl">
          <input
            autoFocus
            value={q}
            onChange={(e) => {
              setQ(e.target.value)
              setHi(0)
            }}
            onKeyDown={onKey}
            placeholder="Search…"
            className="h-8 w-full border-b border-ink-700 bg-transparent px-2.5 text-[13px] outline-none"
          />
          <div role="listbox" className="max-h-80 overflow-y-auto py-1">
            {filtered.map((i, idx) => (
              <button
                key={i.value}
                role="option"
                aria-selected={i.value === value}
                ref={idx === hi ? (el) => el?.scrollIntoView({ block: 'nearest' }) : undefined}
                onMouseEnter={() => setHi(idx)}
                onClick={() => pick(i.value)}
                className={cx(
                  'flex w-full items-start justify-between gap-2 px-2.5 py-1.5 text-left hover:bg-ink-800',
                  (i.value === value || idx === hi) && 'bg-ink-800'
                )}
              >
                <span className="min-w-0">
                  <span className="block truncate text-[13px] text-ink-100">{i.label}</span>
                  {i.sub && <span className="block truncate font-mono text-[10px] text-ink-300">{i.sub}</span>}
                </span>
                {i.badge && (
                  <span className="shrink-0 rounded bg-safelight/15 px-1.5 py-0.5 font-mono text-[10px] text-safelight">
                    {i.badge}
                  </span>
                )}
              </button>
            ))}
            {filtered.length === 0 && <div className="px-2.5 py-3 text-xs text-ink-300">No matches</div>}
          </div>
        </div>
      )}
    </div>
  )
}

export function Empty({ icon, title, children }: { icon: ReactNode; title: string; children?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 p-8 text-center">
      <div className="text-ink-400">{icon}</div>
      <div className="font-display text-base font-semibold text-ink-300">{title}</div>
      {children && <div className="max-w-sm text-xs leading-relaxed text-ink-300">{children}</div>}
    </div>
  )
}
