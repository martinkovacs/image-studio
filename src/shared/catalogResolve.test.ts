import { describe, expect, it } from 'vitest'
import type { HfFile, HfRepoDetails } from './types'
import { CATALOG, type CatalogRecipe } from './catalog'
import { ORIGINAL, resolveInstall } from './catalogResolve'
import { groupQuants } from './quants'
import { filesForDiffusersRepo, getRepoDetails } from '../main/hf/hub'

function repo(id: string, files: HfFile[], diffusers?: { all: string[]; withoutTransformer: string[] }): HfRepoDetails {
  return {
    id,
    sha: `sha-${id}`,
    kind: diffusers ? 'diffusers' : 'gguf',
    gated: false,
    files,
    quants: groupQuants(files),
    totalBytes: files.reduce((n, f) => n + f.size, 0),
    ...(diffusers ? { pipelineFiles: diffusers } : {})
  }
}

const recipe: CatalogRecipe = {
  components: [
    { id: 'model', kind: 'diffusers', label: 'Pipeline', slot: 'model', repo: 'o/base' },
    { id: 'transformer', kind: 'gguf', label: 'Transformer', slot: 'transformer-gguf', repo: 'o/gguf', stem: 'm', defaultQuant: 'Q8_0', originalLabel: 'BF16' },
    { id: 'llm', kind: 'gguf', label: 'LLM', slot: 'llm', repo: 'o/llm', stem: 'enc', defaultQuant: 'Q4_K_M' },
    { id: 'mmproj', kind: 'file', label: 'mmproj', slot: 'llm_vision', repo: 'o/llm', path: 'mmproj-F16.gguf' }
  ],
  args: {},
  defaults: {},
  note: ''
}

const details: Record<string, HfRepoDetails> = {
  'o/base': repo(
    'o/base',
    [
      { path: 'model_index.json', size: 1 },
      { path: 'transformer/config.json', size: 1 },
      { path: 'transformer/w.safetensors', size: 100 },
      { path: 'vae/w.safetensors', size: 10 }
    ],
    { all: ['model_index.json', 'transformer/config.json', 'transformer/w.safetensors', 'vae/w.safetensors'], withoutTransformer: ['model_index.json', 'transformer/config.json', 'vae/w.safetensors'] }
  ),
  'o/gguf': repo('o/gguf', [
    { path: 'm-Q4_K_M.gguf', size: 40 },
    { path: 'm-Q8_0.gguf', size: 80 }
  ]),
  'o/llm': repo('o/llm', [
    { path: 'enc-Q4_K_M.gguf', size: 5 },
    { path: 'enc-UD-Q4_K_XL.gguf', size: 6 },
    { path: 'mmproj-F16.gguf', size: 2 }
  ])
}

describe('resolveInstall', () => {
  it('uses default quants and skips the folder transformer when a GGUF replaces it', () => {
    const r = resolveInstall(recipe, {}, (id) => details[id])
    const byId = Object.fromEntries(r.components.map((c) => [c.component.id, c]))
    expect(byId.transformer.slotPath).toBe('m-Q8_0.gguf')
    expect(byId.model.files.map((f) => f.path)).not.toContain('transformer/w.safetensors')
    expect(byId.model.slotPath).toBe('')
    expect(byId.llm.slotPath).toBe('enc-Q4_K_M.gguf')
    expect(r.totalBytes).toBe(1 + 1 + 10 + 80 + 5 + 2)
    // One download per repo, pinned to the listed commit; llm + mmproj share a repo.
    expect(r.downloads.map((d) => [d.repo, d.sha, d.files.length])).toEqual([
      ['o/base', 'sha-o/base', 3],
      ['o/gguf', 'sha-o/gguf', 1],
      ['o/llm', 'sha-o/llm', 2]
    ])
  })

  it("'original' keeps the folder transformer and leaves the GGUF slot empty", () => {
    const r = resolveInstall(recipe, { transformer: ORIGINAL }, (id) => details[id])
    const t = r.components.find((c) => c.component.id === 'transformer')!
    expect(t.slotPath).toBeNull()
    expect(r.downloads.find((d) => d.repo === 'o/gguf')).toBeUndefined()
    expect(r.components.find((c) => c.component.id === 'model')!.files.map((f) => f.path)).toContain('transformer/w.safetensors')
  })

  it('honours a chosen quant and rejects missing ones', () => {
    const r = resolveInstall(recipe, { llm: 'UD-Q4_K_XL' }, (id) => details[id])
    expect(r.components.find((c) => c.component.id === 'llm')!.slotPath).toBe('enc-UD-Q4_K_XL.gguf')
    const bad: CatalogRecipe = { ...recipe, components: [{ ...recipe.components[2], defaultQuant: 'Q2_K' } as CatalogRecipe['components'][number]] }
    expect(() => resolveInstall(bad, {}, (id) => details[id])).toThrow(/no Q2_K/)
  })

  it('reports a missing single file', () => {
    const bad: CatalogRecipe = { ...recipe, components: [{ id: 'x', kind: 'file', label: 'x', slot: 'vae', repo: 'o/llm', path: 'nope.safetensors' }] }
    expect(() => resolveInstall(bad, {}, (id) => details[id])).toThrow(/no longer contains/)
  })
})

// Live check of every catalog recipe against the real Hugging Face file lists:
//   HF_LIVE=1 npx vitest run src/shared/catalogResolve.test.ts
// Gated repos are skipped unless HF_TOKEN is set.
describe.skipIf(!process.env.HF_LIVE)('catalog against huggingface.co', () => {
  for (const model of CATALOG) {
    for (const [backend, r] of Object.entries(model.recipes)) {
      it(`${model.id} / ${backend}`, { timeout: 60_000 }, async () => {
        if (r.gated && !process.env.HF_TOKEN) return
        const cache: Record<string, HfRepoDetails> = {}
        for (const c of r.components) {
          if (cache[c.repo]) continue
          const d = await getRepoDetails(c.repo, { token: process.env.HF_TOKEN })
          cache[c.repo] =
            d.kind === 'diffusers'
              ? {
                  ...d,
                  pipelineFiles: {
                    all: filesForDiffusersRepo(d).map((f) => f.path),
                    withoutTransformer: filesForDiffusersRepo(d, { excludeTransformer: true }).map((f) => f.path)
                  }
                }
              : d
        }
        const res = resolveInstall(r, {}, (id) => cache[id])
        expect(res.totalBytes).toBeGreaterThan(0)
        console.log(`${model.id} / ${backend}: ${(res.totalBytes / 1e9).toFixed(1)} GB`, res.components.map((c) => `${c.component.id}=${c.quant ?? c.slotPath}`).join(' '))
      })
    }
  }
})
