import { describe, expect, it } from 'vitest'
import { fileUrl, filesForDiffusersRepo, getRepoDetails, HF_BASE, isHfUrl, isSafeRepoPath, isValidRepoId, searchModels } from './hub'

type Handler = (url: string, headers: Record<string, string>) => Response | Promise<Response>

function fakeFetch(handler: Handler) {
  const calls: Array<{ url: string; headers: Record<string, string> }> = []
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input)
    const headers = lowerHeaders(init?.headers)
    calls.push({ url, headers })
    return handler(url, headers)
  }
  return { fetchImpl, calls }
}

const lowerHeaders = (init: HeadersInit | undefined): Record<string, string> =>
  Object.fromEntries(Object.entries((init ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]))

const json = (body: unknown, headers?: Record<string, string>) =>
  new Response(JSON.stringify(body), { status: 200, headers })

const status = (s: number) => new Response('err', { status: s })

describe('isValidRepoId', () => {
  it('accepts owner/name and rejects the rest', () => {
    expect(isValidRepoId('owner/repo')).toBe(true)
    expect(isValidRepoId('black-forest-labs/FLUX.1-dev')).toBe(true)
    expect(isValidRepoId('owner')).toBe(false)
    expect(isValidRepoId('owner/sub/repo')).toBe(false)
    expect(isValidRepoId('owner/')).toBe(false)
    expect(isValidRepoId('-owner/repo')).toBe(false)
    expect(isValidRepoId('owner/na..me')).toBe(false)
  })
})

describe('isHfUrl', () => {
  it('matches only the huggingface.co origin', () => {
    expect(isHfUrl('https://huggingface.co/api/models')).toBe(true)
    expect(isHfUrl('https://huggingface.co.evil.example/api')).toBe(false)
    expect(isHfUrl('https://cdn-lfs.huggingface.co/x')).toBe(false)
    expect(isHfUrl('http://huggingface.co/api')).toBe(false)
    expect(isHfUrl('not a url')).toBe(false)
  })
})

describe('isSafeRepoPath', () => {
  it('allows plain relative paths', () => {
    expect(isSafeRepoPath('model.gguf')).toBe(true)
    expect(isSafeRepoPath('Q4_K_M/model-00001-of-00002.gguf')).toBe(true)
  })
  it('rejects traversal and odd characters', () => {
    for (const p of ['', '/abs', 'a//b', '.', '..', 'a/./b', 'a/../b', 'a\\b', 'a:b', 'x'.repeat(512)]) {
      expect(isSafeRepoPath(p)).toBe(false)
    }
  })
})

describe('searchModels', () => {
  it('builds the api query and maps results', async () => {
    const { fetchImpl } = fakeFetch((url) => {
      expect(url.startsWith(`${HF_BASE}/api/models?`)).toBe(true)
      const q = new URL(url).searchParams
      expect(q.get('search')).toBe('qwen')
      expect(q.get('sort')).toBe('downloads')
      expect(q.get('direction')).toBe('-1')
      expect(q.get('limit')).toBe('30')
      expect(q.get('full')).toBe('false')
      expect(q.get('config')).toBe('false')
      expect(q.get('filter')).toBe('gguf')
      expect(q.get('pipeline_tag')).toBe('text-to-image')
      return json([
        { id: 'a/b', downloads: 12, likes: 3, lastModified: '2025-01-01T00:00:00Z', tags: ['gguf'], pipeline_tag: 'text-to-image', library_name: 'diffusers', gated: true },
        { id: 'c/d', gated: 'manual', likes: 1, downloads: 0, tags: [] },
        { id: 'e/f', gated: false, likes: 0, downloads: 0, tags: [] }
      ])
    })
    const rows = await searchModels({ query: 'qwen', format: 'gguf', task: 'text-to-image' }, { token: 't', fetchImpl })
    expect(rows).toEqual([
      { id: 'a/b', downloads: 12, likes: 3, lastModified: '2025-01-01T00:00:00Z', tags: ['gguf'], pipelineTag: 'text-to-image', libraryName: 'diffusers', gated: 'auto' },
      { id: 'c/d', downloads: 0, likes: 1, tags: [], gated: 'manual' },
      { id: 'e/f', downloads: 0, likes: 0, tags: [], gated: false }
    ])
  })

  it('uses library=diffusers and clamps the limit', async () => {
    const { fetchImpl } = fakeFetch((url) => {
      const q = new URL(url).searchParams
      expect(q.get('library')).toBe('diffusers')
      expect(q.get('filter')).toBeNull()
      expect(q.get('limit')).toBe('100')
      return json([])
    })
    await searchModels({ query: '', format: 'diffusers', limit: 500 }, { fetchImpl })
  })

  it('sends no Authorization header without a token', async () => {
    const { fetchImpl } = fakeFetch((_url, headers) => {
      expect(headers.authorization).toBeUndefined()
      return json([])
    })
    await searchModels({ query: 'x', format: 'all' }, { fetchImpl })
  })

  it('maps errors to friendly messages', async () => {
    const { fetchImpl: f401 } = fakeFetch(() => status(401))
    await expect(searchModels({ query: 'x', format: 'all' }, { token: 'bad', fetchImpl: f401 })).rejects.toThrow('Hugging Face rejected the token')
    const { fetchImpl: f429 } = fakeFetch(() => status(429))
    await expect(searchModels({ query: 'x', format: 'all' }, { fetchImpl: f429 })).rejects.toThrow(/rate limit/i)
  })
})

describe('getRepoDetails', () => {
  const info = { sha: 'abc123', gated: false, pipeline_tag: 'text-to-image', cardData: { license: 'cc-by-nc-4.0' }, siblings: [] }

  it('collects files across tree pages and derives kind/quants', async () => {
    const { fetchImpl, calls } = fakeFetch((url) => {
      if (url.endsWith('/api/models/o/r')) return json(info)
      if (url.includes('cursor=next1')) {
        return json([{ type: 'file', path: 'model-Q4_K_M.gguf', size: 10, lfs: { oid: 'f'.repeat(64) } }])
      }
      if (url.includes('/tree/abc123')) {
        return json(
          [
            { type: 'directory', path: 'sub' },
            { type: 'file', path: '../evil', size: 1 },
            { type: 'file', path: 'model-Q8_0.gguf', size: 20, lfs: { oid: 'e'.repeat(64) } },
            { type: 'file', path: 'sub/model-Q4_K_M-00001-of-00002.gguf', size: 10, lfs: { oid: 'f'.repeat(64) } },
            { type: 'file', path: 'README.md', size: 3 }
          ],
          { link: `<${HF_BASE}/api/models/o/r/tree/abc123?recursive=true&cursor=next1>; rel="next"` }
        )
      }
      throw new Error(`unexpected url ${url}`)
    })
    const d = await getRepoDetails('o/r', { token: 'tok', fetchImpl })
    expect(d.sha).toBe('abc123')
    expect(d.kind).toBe('gguf')
    expect(d.files.map((f) => f.path)).toEqual([
      'model-Q8_0.gguf',
      'sub/model-Q4_K_M-00001-of-00002.gguf',
      'README.md',
      'model-Q4_K_M.gguf'
    ])
    expect(d.files[0].sha256).toBe('e'.repeat(64))
    expect(d.quants.map((g) => [g.quant, g.totalBytes])).toEqual([['Q4_K_M', 10], ['Q8_0', 20]])
    expect(d.totalBytes).toBe(43)
    expect(d.license).toBe('cc-by-nc-4.0')
    expect(d.pipelineTag).toBe('text-to-image')
    expect(d.gated).toBe(false)
    expect(calls.every((c) => c.headers.authorization === 'Bearer tok')).toBe(true)
  })

  it('follows at most 20 tree pages', async () => {
    let page = 0
    const { fetchImpl, calls } = fakeFetch((url) => {
      if (url.endsWith('/api/models/o/r')) return json(info)
      page++
      const headers = { link: `<${HF_BASE}/api/models/o/r/tree/abc?recursive=true&cursor=p${page}>; rel="next"` }
      return json([{ type: 'file', path: `f${page}.bin`, size: 1 }], headers)
    })
    const d = await getRepoDetails('o/r', { fetchImpl })
    expect(d.files).toHaveLength(20)
    expect(calls.filter((c) => c.url.includes('/tree/'))).toHaveLength(20)
  })

  it('never sends the token to non-huggingface URLs', async () => {
    const { fetchImpl } = fakeFetch((url, headers) => {
      if (url.endsWith('/api/models/o/r')) return json({ sha: 'abc', gated: false })
      if (url.startsWith(HF_BASE)) {
        expect(headers.authorization).toBe('Bearer hf_tok')
        return json([{ type: 'file', path: 'a.bin', size: 1 }], { link: '<https://evil.example/next>; rel="next"' })
      }
      expect(url).toBe('https://evil.example/next')
      expect(headers.authorization).toBeUndefined()
      return json([{ type: 'file', path: 'b.bin', size: 1 }])
    })
    const d = await getRepoDetails('o/r', { token: 'hf_tok', fetchImpl })
    expect(d.files.map((f) => f.path)).toEqual(['a.bin', 'b.bin'])
  })

  it('explains gated repositories', async () => {
    const { fetchImpl } = fakeFetch((url) => {
      if (url.endsWith('/api/models/g/r')) return json({ sha: 's', gated: 'auto' })
      return status(401)
    })
    await expect(getRepoDetails('g/r', { fetchImpl })).rejects.toThrow('This repository is gated')
  })

  it('maps 404 to Repository not found', async () => {
    const { fetchImpl } = fakeFetch(() => status(404))
    await expect(getRepoDetails('g/r', { fetchImpl })).rejects.toThrow('Repository not found')
  })

  it('rejects invalid repo ids', async () => {
    const { fetchImpl } = fakeFetch(() => json({}))
    await expect(getRepoDetails('no-slash', { fetchImpl })).rejects.toThrow('Invalid repository id')
  })

  it('recognizes diffusers and single-file kinds', async () => {
    const { fetchImpl } = fakeFetch((url) => {
      if (url.endsWith('/api/models/o/r')) return json(info)
      return json([{ type: 'file', path: 'model.safetensors', size: 1 }])
    })
    expect((await getRepoDetails('o/r', { fetchImpl })).kind).toBe('single-file')
    const { fetchImpl: f2 } = fakeFetch((url) => {
      if (url.endsWith('/api/models/o/r')) return json(info)
      return json([{ type: 'file', path: 'weights.onnx', size: 1 }])
    })
    expect((await getRepoDetails('o/r', { fetchImpl: f2 })).kind).toBe('other')
  })
})

describe('fileUrl', () => {
  it('encodes revision and path segments', () => {
    expect(fileUrl('o/r', 'main', 'sub dir/Q4_K_M/model.gguf')).toBe(
      'https://huggingface.co/o/r/resolve/main/sub%20dir/Q4_K_M/model.gguf'
    )
    expect(() => fileUrl('o/r', 'main', '../x')).toThrow('Unsafe repository path')
    expect(() => fileUrl('bad', 'main', 'x')).toThrow('Invalid repository id')
  })
})

describe('filesForDiffusersRepo', () => {
  const mk = (paths: string[]) => ({ files: paths.map((path) => ({ path, size: 1 })) })
  const realistic = mk([
    '.gitattributes',
    'README.md',
    'LICENSE.txt',
    'model_index.json',
    'scheduler/scheduler_config.json',
    'text_encoder/config.json',
    'text_encoder/model.safetensors',
    'text_encoder_2/config.json',
    'text_encoder_2/model-00001-of-00002.safetensors',
    'text_encoder_2/model-00002-of-00002.safetensors',
    'text_encoder_2/model.safetensors',
    'tokenizer/tokenizer.json',
    'tokenizer/tokenizer_config.json',
    'tokenizer/special_tokens_map.json',
    'tokenizer/added_tokens.json',
    'tokenizer/spiece.model',
    'vae/config.json',
    'vae/diffusion_pytorch_model.safetensors',
    'unet/config.json',
    'unet/diffusion_pytorch_model.safetensors',
    'unet/diffusion_pytorch_model.bin',
    'transformer/config.json',
    'transformer/diffusion_pytorch_model-00001-of-00002.safetensors',
    'transformer/diffusion_pytorch_model-00002-of-00002.safetensors',
    'quant/model-Q8_0.gguf',
    'other/weights.pt'
  ])

  it('keeps manifest, configs, tokenizers and safetensors weights only', () => {
    const kept = filesForDiffusersRepo(realistic).map((f) => f.path)
    expect(kept).toEqual([
      'README.md',
      'LICENSE.txt',
      'model_index.json',
      'scheduler/scheduler_config.json',
      'text_encoder/config.json',
      'text_encoder/model.safetensors',
      'text_encoder_2/config.json',
      'text_encoder_2/model-00001-of-00002.safetensors',
      'text_encoder_2/model-00002-of-00002.safetensors',
      'tokenizer/tokenizer.json',
      'tokenizer/tokenizer_config.json',
      'tokenizer/special_tokens_map.json',
      'tokenizer/added_tokens.json',
      'tokenizer/spiece.model',
      'vae/config.json',
      'vae/diffusion_pytorch_model.safetensors',
      'unet/config.json',
      'unet/diffusion_pytorch_model.safetensors',
      'transformer/config.json',
      'transformer/diffusion_pytorch_model-00001-of-00002.safetensors',
      'transformer/diffusion_pytorch_model-00002-of-00002.safetensors'
    ])
  })

  it('drops transformer weights but keeps its config when asked', () => {
    const kept = filesForDiffusersRepo(realistic, { excludeTransformer: true }).map((f) => f.path)
    expect(kept.filter((p) => p.startsWith('transformer/')).every((p) => p.endsWith('.json'))).toBe(true)
    expect(kept.some((p) => p.startsWith('transformer/') && p.endsWith('.safetensors'))).toBe(false)
    expect(kept).toContain('transformer/config.json')
    expect(kept).toContain('vae/config.json')
  })

  it('keeps the root manifest but drops other root files', () => {
    const kept = filesForDiffusersRepo(mk(['model_index.json', 'README.md', 'LICENSE', 'weights.safetensors', 'x.json'])).map((f) => f.path)
    expect(kept).toEqual(['model_index.json', 'README.md', 'LICENSE'])
  })
})
