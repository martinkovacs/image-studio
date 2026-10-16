import { describe, expect, it } from 'vitest'
import { formatBytes, groupQuants, parseQuant, quantFit } from './quants'

const GiB = 1024 * 1024 * 1024

describe('parseQuant', () => {
  it('parses canonical quants, stems and separators', () => {
    expect(parseQuant('Qwen-Image-2.1-Q4_K_M.gguf')).toEqual({
      quant: 'Q4_K_M',
      bits: 4.8,
      stem: 'Qwen-Image-2.1',
      shard: null
    })
    expect(parseQuant('mmproj-F16.gguf')).toEqual({ quant: 'F16', bits: 16, stem: 'mmproj', shard: null })
    expect(parseQuant('model.Q8_0.gguf')).toEqual({ quant: 'Q8_0', bits: 8.5, stem: 'model', shard: null })
    expect(parseQuant('llama3_8b_q4_k_m.gguf')).toEqual({ quant: 'Q4_K_M', bits: 4.8, stem: 'llama3_8b', shard: null })
    expect(parseQuant('BF16.gguf')!.quant).toBe('BF16')
    expect(parseQuant('mxfp4-model.gguf')!.quant).toBe('MXFP4')
  })

  it('is null for non-gguf files', () => {
    expect(parseQuant('model.safetensors')).toBeNull()
    expect(parseQuant('config.json')).toBeNull()
    expect(parseQuant('model.gguf.part')).toBeNull()
  })

  it('detects shards', () => {
    expect(parseQuant('model-Q4_K_M-00001-of-00003.gguf')).toEqual({
      quant: 'Q4_K_M',
      bits: 4.8,
      stem: 'model',
      shard: { index: 1, count: 3 }
    })
    expect(parseQuant('model-00002-of-00002.gguf')).toEqual({
      quant: '',
      bits: null,
      stem: 'model',
      shard: { index: 2, count: 2 }
    })
  })

  it('uses the basename for stems in subfolders', () => {
    expect(parseQuant('Q4_K_M/model-Q4_K_M-00001-of-00002.gguf')).toEqual({
      quant: 'Q4_K_M',
      bits: 4.8,
      stem: 'model',
      shard: { index: 1, count: 2 }
    })
    expect(parseQuant('sub/dir/mmproj-F16.gguf')!.stem).toBe('mmproj')
  })

  it('falls back to the parent folder quant (Qwen-style repos)', () => {
    const parsed = parseQuant('Q8_0/model-00001-of-00002.gguf')
    expect(parsed!.quant).toBe('Q8_0')
    expect(parsed!.bits).toBe(8.5)
    expect(parsed!.stem).toBe('model')
    expect(parsed!.shard).toEqual({ index: 1, count: 2 })
  })

  it('understands UD- dynamic quants and the XL suffix', () => {
    expect(parseQuant('model-ud-q4_k_xl.gguf')).toEqual({
      quant: 'UD-Q4_K_XL',
      bits: 4.8,
      stem: 'model',
      shard: null
    })
    expect(parseQuant('Qwen3-235B-UD-IQ2_XXS.gguf')!.quant).toBe('UD-IQ2_XXS')
    expect(parseQuant('model-Q4_K_XL.gguf')).toEqual({ quant: 'Q4_K_XL', bits: 4.8, stem: 'model', shard: null })
    expect(parseQuant('model-Q6_K-XL.gguf')!.quant).toBe('Q6_K_XL')
    expect(parseQuant('ud-q2_k_xl.gguf')!.bits).toBe(3.4)
  })

  it('prefers the rightmost quant-looking token', () => {
    expect(parseQuant('Qwen2.5-7B-Instruct.Q4_K_M.gguf')!.stem).toBe('Qwen2.5-7B-Instruct')
    expect(parseQuant('Llama-3.1-8B-F16.gguf')!.stem).toBe('Llama-3.1-8B')
    expect(parseQuant('F16-Q8_0.gguf')!.quant).toBe('Q8_0')
  })

  it('returns an empty quant for unrecognized names', () => {
    expect(parseQuant('model.gguf')).toEqual({ quant: '', bits: null, stem: 'model', shard: null })
    expect(parseQuant('model-IQ9_ZZ.gguf')).toEqual({ quant: '', bits: null, stem: 'model-IQ9_ZZ', shard: null })
  })
})

describe('groupQuants', () => {
  it('groups by stem+quant, sums sizes and sorts by stem then bits (unknown last)', () => {
    const files = [
      { path: 'mmproj-F16.gguf', size: 100 },
      { path: 'model-Q8_0.gguf', size: 800 },
      { path: 'model-Q4_K_M.gguf', size: 480, sha256: 'b'.repeat(64) },
      { path: 'model-Q4_K_M-00001-of-00002.gguf', size: 300, sha256: 'a'.repeat(64) },
      { path: 'model-Q4_K_M-00002-of-00002.gguf', size: 180 },
      { path: 'config.json', size: 5 },
      { path: 'model.gguf', size: 999 }
    ]
    const groups = groupQuants(files)
    expect(groups.map((g) => [g.stem, g.quant, g.totalBytes])).toEqual([
      ['mmproj', 'F16', 100],
      ['model', 'Q4_K_M', 480],
      ['model', 'Q8_0', 800],
      ['model', '', 999]
    ])
    // The single complete file wins over the shard set of the same weights.
    expect(groups[1].files).toEqual([{ path: 'model-Q4_K_M.gguf', size: 480, sha256: 'b'.repeat(64) }])
    expect(groups[0].bits).toBe(16)
    expect(groups[3].bits).toBeNull()
  })

  it('keeps the fewest-shard complete shard set when there is no single file', () => {
    const files = [
      { path: 'model-Q4_K_M-00001-of-00003.gguf', size: 220 },
      { path: 'model-Q4_K_M-00002-of-00003.gguf', size: 220 },
      { path: 'model-Q4_K_M-00003-of-00003.gguf', size: 60 },
      { path: 'model-Q4_K_M-00001-of-00002.gguf', size: 300 },
      { path: 'model-Q4_K_M-00002-of-00002.gguf', size: 200 }
    ]
    const groups = groupQuants(files)
    expect(groups).toHaveLength(1)
    expect(groups[0].files.map((f) => f.path)).toEqual([
      'model-Q4_K_M-00001-of-00002.gguf',
      'model-Q4_K_M-00002-of-00002.gguf'
    ])
    expect(groups[0].totalBytes).toBe(500)
  })

  it('drops incomplete shard sets', () => {
    const files = [
      { path: 'model-Q4_K_M-00001-of-00003.gguf', size: 220 }, // missing shards 2 and 3
      { path: 'model-Q6_K-00002-of-00002.gguf', size: 100 }, // missing shard 1
      { path: 'model-Q6_K-00003-of-00003.gguf', size: 90 } // incomplete set of 3
    ]
    const groups = groupQuants(files)
    expect(groups).toEqual([])
  })
})

describe('quantFit', () => {
  it('classifies against vram + ram', () => {
    expect(quantFit(6 * GiB, 8 * 1024, 32 * 1024)).toBe('fits') // 7.2 GiB <= 8 GiB
    expect(quantFit(7.5 * GiB, 8 * 1024, 32 * 1024)).toBe('tight') // 9 GiB > 8 GiB, 7.5 <= 8
    expect(quantFit(8.5 * GiB, 8 * 1024, 32 * 1024)).toBe('offload') // 9.35 <= 8 + 19.2
    expect(quantFit(40 * GiB, 8 * 1024, 32 * 1024)).toBe('too-big')
  })

  it('is ram-only without a gpu (no offload tier)', () => {
    expect(quantFit(10 * GiB, null, 32 * 1024)).toBe('fits') // 12 <= 19.2
    expect(quantFit(19 * GiB, null, 32 * 1024)).toBe('tight')
    expect(quantFit(25 * GiB, null, 32 * 1024)).toBe('too-big')
  })
})

describe('formatBytes', () => {
  it('formats sizes', () => {
    expect(formatBytes(500)).toBe('500 B')
    expect(formatBytes(1024 * 1024)).toBe('1.0 MB')
    expect(formatBytes(12 * 1024 * 1024)).toBe('12 MB')
    expect(formatBytes(530 * 1024 * 1024)).toBe('530 MB')
    expect(formatBytes(1.2 * GiB)).toBe('1.2 GB')
  })
})
