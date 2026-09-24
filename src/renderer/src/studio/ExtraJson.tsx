import { Button, TextArea, cx } from '../components/ui'
import { useStore } from '../store'

const HINT =
  'Merged into the OpenRouter /api/v1/images request body. Overrides the controls above. model, prompt and input_references cannot be overridden.'

/** Editor for the per-model custom OpenRouter JSON request-body parameters. */
export function ExtraJson() {
  const value = useStore((s) => s.orExtraJson)
  const set = useStore((s) => s.setOrExtraJson)
  const text = value.trim()
  let status: { ok: boolean; message: string } | null = null
  if (text) {
    try {
      const parsed: unknown = JSON.parse(text)
      status =
        parsed && typeof parsed === 'object' && !Array.isArray(parsed)
          ? { ok: true, message: 'Valid JSON object' }
          : { ok: false, message: 'Not a JSON object — wrap the parameters in { }' }
    } catch (err) {
      status = { ok: false, message: `Invalid JSON: ${(err as Error).message}` }
    }
  }
  return (
    <div className="flex flex-col gap-2">
      <TextArea
        rows={6}
        spellCheck={false}
        className="font-mono text-[11px]"
        value={value}
        onChange={(e) => set(e.target.value)}
        placeholder={'{\n  "output_compression": 80\n}'}
      />
      {status && (
        <p className={cx('text-[11px] leading-snug', status.ok ? 'text-fixer' : 'text-stop')}>{status.message}</p>
      )}
      <p className="text-[11px] leading-snug text-ink-300">{HINT}</p>
      {value.trim() && (
        <Button size="sm" variant="ghost" className="self-start" onClick={() => set('')}>
          Clear
        </Button>
      )}
    </div>
  )
}
