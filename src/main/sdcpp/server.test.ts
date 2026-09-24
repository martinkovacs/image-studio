import { describe, expect, it } from 'vitest'
import { buildServerArgs, parseProgressLine, splitOutputLines, splitShellArgs } from './server'

describe('splitShellArgs', () => {
  it('splits on whitespace', () => {
    expect(splitShellArgs('--fa  --rng cpu')).toEqual(['--fa', '--rng', 'cpu'])
  })
  it('keeps double-quoted tokens together', () => {
    expect(splitShellArgs('--tokenizer "a b"')).toEqual(['--tokenizer', 'a b'])
  })
  it('keeps single-quoted tokens together', () => {
    expect(splitShellArgs("--tokenizer 'Qwen 3'")).toEqual(['--tokenizer', 'Qwen 3'])
  })
  it('supports backslash escapes', () => {
    expect(splitShellArgs('c\\ d e')).toEqual(['c d', 'e'])
  })
  it('treats backslashes inside single quotes literally', () => {
    expect(splitShellArgs("a'\\d'b")).toEqual(['a\\db'])
  })
  it('produces an empty token for explicit empty quotes', () => {
    expect(splitShellArgs('--rng "" --type ""')).toEqual(['--rng', '', '--type', ''])
  })
})

describe('buildServerArgs', () => {
  const base = { id: 'p1', name: 'P', extraArgs: '' }

  it('emits switch flags for true booleans only', () => {
    const args = buildServerArgs(
      { ...base, args: { 'offload-to-cpu': true, mmap: false, 'eager-load': false } },
      8000
    )
    expect(args.filter((a) => a.startsWith('--offload') || a.includes('eager') || a.includes('mmap'))).toEqual(['--offload-to-cpu'])
  })

  it('passes known values verbatim, unknown keys ignored', () => {
    const args = buildServerArgs(
      {
        ...base,
        args: {
          'diffusion-model': '/models/flux.safetensors',
          'llm_vision': '/models/mmproj.gguf',
          'clip_l': '/models/clip.gguf',
          'threads': 8,
          not_a_flag: 'x'
        }
      },
      8000
    )
    expect(args.slice(0, 8)).toEqual([
      '--diffusion-model', '/models/flux.safetensors',
      '--llm_vision', '/models/mmproj.gguf',
      '--clip_l', '/models/clip.gguf',
      '--threads', '8'
    ])
    expect(args).not.toContain('--not_a_flag')
  })

  it('appends listen-ip and listen-port, then split extraArgs', () => {
    const args = buildServerArgs({ ...base, args: {}, extraArgs: '' }, 8000)
    expect(args).toEqual(['--listen-ip', '127.0.0.1', '--listen-port', '8000'])
    const withExtra = buildServerArgs({ ...base, args: {}, extraArgs: '--fa --rng cpu --tokenizer "a b"' }, 8000)
    expect(withExtra).toEqual([
      '--listen-ip', '127.0.0.1', '--listen-port', '8000',
      '--fa', '--rng', 'cpu', '--tokenizer', 'a b'
    ])
  })

  it('omits flags whose value is false or empty string', () => {
    const joined = buildServerArgs({ ...base, args: { mmap: false, type: 'f16', 'tensor-type-rules': '' } }, 1234).join(' ')
    expect(joined).toContain('--type f16')
    expect(joined).not.toContain('--mmap')
    expect(joined).not.toContain('--tensor-type-rules')
  })
})

describe('parseProgressLine', () => {
  it('parses a middling sampling frame', () => {
    expect(parseProgressLine('  |=====>    | 5/20 - 1.23s/it')).toEqual({ step: 5, total: 20, speed: '1.23s/it' })
  })
  it('parses it/s units', () => {
    expect(parseProgressLine('  |==       | 2/8 - 3.41it/s')).toEqual({ step: 2, total: 8, speed: '3.41it/s' })
  })
  it('parses the # progress bar used by tiling / byte progress', () => {
    expect(parseProgressLine('  |##  | 12/40 - 1.05MB/s')).toEqual({ step: 12, total: 40, speed: '1.05MB/s' })
  })
  it('parses GB/s', () => {
    expect(parseProgressLine('  |#####  | 3/9 - 1.32GB/s')).toEqual({ step: 3, total: 9, speed: '1.32GB/s' })
  })
  it('handles the \r-prefixed raw frame including cursor-erase escape', () => {
    expect(parseProgressLine('\r  |=======>  | 7/30 - 0.89s/it\u001b[K')).toEqual({ step: 7, total: 30, speed: '0.89s/it' })
  })
  it('parses the final frame (new-terminated OK too)', () => {
    expect(parseProgressLine('  |==========| 20/20 - 1.00s/it')).toEqual({ step: 20, total: 20, speed: '1.00s/it' })
  })
  it('returns null for other lines (LOG_INFO, banner)', () => {
    expect(parseProgressLine('listening on: http://127.0.0.1:1234')).toBeNull()
    expect(parseProgressLine('')).toBeNull()
    expect(parseProgressLine('  model: flux1-schnell.safetensors')).toBeNull()
  })
})

describe('splitOutputLines', () => {
  it('splits on \r as well as \n and strips the cursor-erase escape', () => {
    expect(splitOutputLines('\r  |=====> | 5/20 - 1.23s/it\u001b[K\r  |======> | 6/20 - 1.10s/it\u001b[K\n')).toEqual([
      '',
      '  |=====> | 5/20 - 1.23s/it',
      '  |======> | 6/20 - 1.10s/it',
      ''
    ])
  })
  it('does not split quoted log lines that contain no \r or \n', () => {
    expect(splitOutputLines('listening on: http://127.0.0.1:1234\n')).toEqual(['listening on: http://127.0.0.1:1234', ''])
  })
})
