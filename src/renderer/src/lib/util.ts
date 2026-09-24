export const uid = (): string => Math.random().toString(36).slice(2, 10) + Date.now().toString(36)

export function fileToDataUrl(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(r.result as string)
    r.onerror = () => reject(r.error)
    r.readAsDataURL(file)
  })
}

export function imageSize(src: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight })
    img.onerror = () => reject(new Error('Could not load image'))
    img.src = src
  })
}

/** Collect image files from a drop or paste event as data URLs. */
export async function imagesFromTransfer(dt: DataTransfer | null): Promise<string[]> {
  if (!dt) return []
  const files = Array.from(dt.files).filter((f) => f.type.startsWith('image/'))
  return Promise.all(files.map(fileToDataUrl))
}

export const roundTo = (n: number, m: number): number => Math.max(m, Math.round(n / m) * m)

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  const s = ms / 1000
  if (s < 60) return `${s.toFixed(1)}s`
  return `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`
}

export function formatCost(usd?: number): string | null {
  if (usd == null) return null
  return usd < 0.01 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(3)}`
}

export function timeAgo(ts: number): string {
  const s = Math.floor((Date.now() - ts) / 1000)
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return new Date(ts).toLocaleDateString()
}

/** Parse "16:9" → 16/9. */
export function parseRatio(r: string): number | null {
  const m = /^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/.exec(r)
  return m ? Number(m[1]) / Number(m[2]) : null
}
