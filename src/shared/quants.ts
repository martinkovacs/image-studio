// Pure GGUF quantization helpers shared by main and renderer (no node imports).
import type { HfFile, HfQuantGroup } from './types'

export interface ParsedQuant {
  /** Canonical quant name, '' when the file name carries no known quant. */
  quant: string
  /** Approximate bits per weight, null when unknown. */
  bits: number | null
  /** Base name without quant, shard suffix and extension. */
  stem: string
  /** Set for split files like model-Q4_K_M-00001-of-00003.gguf. */
  shard: { index: number; count: number } | null
}

// Approximate bits per weight (commonly quoted llama.cpp figures).
const QUANT_BITS: Record<string, number> = {
  IQ1_S: 1.56, IQ1_M: 1.75,
  IQ2_XXS: 2.06, IQ2_XS: 2.31, IQ2_S: 2.5, IQ2_M: 2.7,
  IQ3_XXS: 3.06, IQ3_XS: 3.3, IQ3_S: 3.44, IQ3_M: 3.66,
  IQ4_XS: 4.25, IQ4_NL: 4.5,
  Q2_K: 3.4, Q2_K_S: 3.0,
  Q3_K_S: 3.5, Q3_K_M: 3.9, Q3_K_L: 4.27,
  Q4_0: 4.5, Q4_1: 5.0, Q4_K_S: 4.58, Q4_K_M: 4.8,
  Q5_0: 5.54, Q5_1: 6.0, Q5_K_S: 5.4, Q5_K_M: 5.7,
  Q6_K: 6.6, Q8_0: 8.5,
  TQ1_0: 1.69, TQ2_0: 2.06,
  MXFP4: 4.25,
  F16: 16, BF16: 16, F32: 32
}

/** Bare K-quants without a table entry resolve to their _M variant. */
const K_BASE: Record<string, string> = { Q3_K: 'Q3_K_M', Q4_K: 'Q4_K_M', Q5_K: 'Q5_K_M' }

/** Quant atoms in file-name order; matched longest-first. */
const QUANT_ATOMS = [
  ['Q2', 'K', 'S'],
  ['Q3', 'K', 'S'], ['Q3', 'K', 'M'], ['Q3', 'K', 'L'],
  ['Q4', 'K', 'S'], ['Q4', 'K', 'M'],
  ['Q5', 'K', 'S'], ['Q5', 'K', 'M'],
  ['IQ1', 'S'], ['IQ1', 'M'],
  ['IQ2', 'XXS'], ['IQ2', 'XS'], ['IQ2', 'S'], ['IQ2', 'M'],
  ['IQ3', 'XXS'], ['IQ3', 'XS'], ['IQ3', 'S'], ['IQ3', 'M'],
  ['IQ4', 'XS'], ['IQ4', 'NL'],
  ['Q2', 'K'],
  // Bare K-quants only exist so an XL suffix can attach (Q4_K_XL); they are
  // always matched after their _S/_M variants and resolve to those for bits.
  ['Q3', 'K'], ['Q4', 'K'], ['Q5', 'K'],
  ['Q4', '0'], ['Q4', '1'],
  ['Q5', '0'], ['Q5', '1'],
  ['Q6', 'K'], ['Q8', '0'],
  ['TQ1', '0'], ['TQ2', '0'],
  ['MXFP4'], ['F16'], ['BF16'], ['F32']
].sort((a, b) => b.length - a.length)

const SHARD_RE = /[._-]?(\d{5})-of-(\d{5})$/i

interface Segment {
  text: string
  /** Character offsets of the segment in the name. */
  start: number
  end: number
}

/**
 * Parses a GGUF file name (a repo path is allowed; the base name is used) into
 * its quant, approximate bits, file stem and shard info. Separators `- _ .`
 * all match, matching is case-insensitive, and the `UD-` prefix of Unsloth
 * dynamic quants is kept in the canonical name ("ud-q4_k_xl" → "UD-Q4_K_XL").
 * Returns null for anything that is not a .gguf file.
 */
export function parseQuant(filename: string): ParsedQuant | null {
  const base = filename.split(/[\\/]/).pop() ?? filename
  if (!/\.gguf$/i.test(base)) return null
  let name = base.slice(0, -5)
  let shard: ParsedQuant['shard'] = null
  const sm = name.match(SHARD_RE)
  if (sm) {
    shard = { index: parseInt(sm[1], 10), count: parseInt(sm[2], 10) }
    name = name.slice(0, sm.index)
  }
  const found = findQuant(name)
  if (found) {
    return { quant: found.quant, bits: quantBits(found.quant), stem: trimSeps(name.slice(0, found.start)), shard }
  }
  // Qwen-style repos keep the quant only in the subfolder name (Q8_0/model-…).
  const slash = filename.lastIndexOf('/')
  if (slash > 0) {
    const dirBase = filename.slice(0, slash).split('/').pop() ?? ''
    const dirQuant = findQuant(dirBase)
    if (dirQuant) return { quant: dirQuant.quant, bits: quantBits(dirQuant.quant), stem: trimSeps(name), shard }
  }
  return { quant: '', bits: null, stem: trimSeps(name), shard }
}

/** Approximate bits per weight; UD- and -XL variants resolve to their base quant. */
export function quantBits(quant: string): number | null {
  const base = quant.replace(/^UD-/, '').replace(/_XL$/, '')
  return QUANT_BITS[K_BASE[base] ?? base] ?? null
}

interface QuantMatch {
  quant: string
  /** Character offset of the first quant character in the name. */
  start: number
  end: number
}

/** Finds the rightmost quant-looking token in a name; null when none. */
function findQuant(name: string): QuantMatch | null {
  const segs = segmentsOf(name)
  let best: QuantMatch | null = null
  for (let i = 0; i < segs.length; i++) {
    const endSeg = matchQuantAt(segs, i)
    if (endSeg < 0) continue
    const end = segs[endSeg - 1].end
    // Rightmost match wins; on equal ends the UD-prefixed (earlier) one wins.
    if (!best || end > best.end || (end === best.end && segs[i].start < best.start)) best = bestAt(segs, i, endSeg)
  }
  return best
}

/** Canonical quant for segments [i, endSeg): optional UD- prefix, atoms joined with `_`. */
function bestAt(segs: Segment[], i: number, endSeg: number): QuantMatch {
  const hasUd = segs[i].text === 'UD'
  const atoms = segs.slice(hasUd ? i + 1 : i, endSeg).map((s) => s.text)
  return { quant: (hasUd ? 'UD-' : '') + atoms.join('_'), start: segs[i].start, end: segs[endSeg - 1].end }
}

/** Tries to match a quant (with optional UD- prefix and XL suffix) at segment i; returns the end segment index or -1. */
function matchQuantAt(segs: Segment[], i: number): number {
  let j = i
  if (segs[j]?.text === 'UD') j++
  for (const atoms of QUANT_ATOMS) {
    if (atoms.every((a, k) => segs[j + k]?.text === a)) {
      j += atoms.length
      if (segs[j]?.text === 'XL') j++
      return j
    }
  }
  return -1
}

function segmentsOf(name: string): Segment[] {
  const segs: Segment[] = []
  const re = /[^._-]+/g
  for (let m = re.exec(name); m; m = re.exec(name)) {
    segs.push({ text: m[0].toUpperCase(), start: m.index, end: m.index + m[0].length })
  }
  return segs
}

function trimSeps(s: string): string {
  return s.replace(/[._-]+$/, '')
}

interface CollectedFile {
  parsed: ParsedQuant
  file: HfFile
}

interface CollectedGroup {
  quant: string
  bits: number | null
  stem: string
  files: CollectedFile[]
}

/**
 * Groups .gguf files by (stem, quant), sums sizes, sorts by stem then bits
 * ascending (unknown last). Repos ship either a single complete GGUF or a
 * shard set for the same weights — never both in a group: the single file
 * wins (simpler download), and among shard sets only the smallest complete
 * one (every index 1..count) is kept.
 */
export function groupQuants(files: HfFile[]): HfQuantGroup[] {
  const collected = new Map<string, CollectedGroup>()
  for (const f of files) {
    if (!/\.gguf$/i.test(f.path)) continue
    const parsed = parseQuant(f.path)
    if (!parsed) continue
    const key = `${parsed.stem}\u0000${parsed.quant}`
    let g = collected.get(key)
    if (!g) {
      g = { quant: parsed.quant, bits: parsed.bits, stem: parsed.stem, files: [] }
      collected.set(key, g)
    }
    g.files.push({ parsed, file: f })
  }
  const groups = [...collected.values()].map((c) => {
    const singles = c.files.filter((e) => e.parsed.shard === null)
    const chosen = singles.length > 0 ? singles : (bestShardSet(c.files) ?? [])
    return {
      quant: c.quant,
      bits: c.bits,
      stem: c.stem,
      files: chosen.map((e) => ({
        path: e.file.path,
        size: e.file.size,
        ...(e.file.sha256 !== undefined ? { sha256: e.file.sha256 } : {})
      })),
      totalBytes: chosen.reduce((n, e) => n + e.file.size, 0)
    }
  })
  return groups
    .filter((g) => g.files.length > 0)
    .sort((a, b) =>
    a.stem.localeCompare(b.stem) ||
    (a.bits ?? Number.POSITIVE_INFINITY) - (b.bits ?? Number.POSITIVE_INFINITY) ||
    a.quant.localeCompare(b.quant)
  )
}

/** Complete shard set with the fewest shards; null when none is complete. */
function bestShardSet(files: CollectedFile[]): CollectedFile[] | null {
  const byCount = new Map<number, CollectedFile[]>()
  for (const e of files) {
    if (!e.parsed.shard) continue
    const list = byCount.get(e.parsed.shard.count) ?? []
    list.push(e)
    byCount.set(e.parsed.shard.count, list)
  }
  let best: { count: number; files: CollectedFile[] } | null = null
  for (const [count, list] of byCount) {
    const have = new Set(list.map((e) => e.parsed.shard!.index))
    let complete = true
    for (let i = 1; i <= count; i++) if (!have.has(i)) complete = false
    if (!complete) continue
    if (!best || count < best.count) best = { count, files: list }
  }
  return best?.files ?? null
}

/**
 * Rough VRAM fit check. 'fits' leaves 20% headroom, 'tight' means the weights
 * alone barely fit VRAM, 'offload' needs system RAM for the overflow, and
 * 'too-big' does not fit even with offload. Without a GPU (vramMiB null) 60%
 * of RAM is the usable budget and there is no offload tier.
 */
export function quantFit(totalBytes: number, vramMiB: number | null, ramMiB: number): 'fits' | 'tight' | 'offload' | 'too-big' {
  const ramBudget = ramMiB * 1024 * 1024 * 0.6
  if (vramMiB === null) {
    if (totalBytes * 1.2 <= ramBudget) return 'fits'
    if (totalBytes <= ramBudget) return 'tight'
    return 'too-big'
  }
  const vram = vramMiB * 1024 * 1024
  if (totalBytes * 1.2 <= vram) return 'fits'
  if (totalBytes <= vram) return 'tight'
  if (totalBytes * 1.1 <= vram + ramBudget) return 'offload'
  return 'too-big'
}

/** Human-readable size: "1.2 GB", "530 MB", "500 B". */
export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB']
  let v = n
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  const s = i === 0 ? String(Math.round(v)) : v >= 100 ? String(Math.round(v)) : v.toFixed(v >= 10 ? 0 : 1)
  return `${s} ${units[i]}`
}
