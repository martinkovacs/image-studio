// Turns a catalog recipe + quant choices + the component repos' file lists into
// concrete downloads and profile file slots. Pure: used by the renderer (sizes,
// fit badges) and the main process (the actual install).
import type { CatalogComponent, CatalogRecipe } from './catalog'
import type { HfFile, HfQuantGroup, HfRepoDetails } from './types'

export interface ResolvedComponent {
  component: CatalogComponent
  repo: string
  files: HfFile[]
  bytes: number
  /** Repo path assigned to the slot (a file, or '' for the repo folder itself); null when the slot stays empty. */
  slotPath: string | null
  /** The chosen quant (gguf components). */
  quant?: string
  /** Quant groups offered for this component (gguf components). */
  choices?: HfQuantGroup[]
}

export interface ResolvedInstall {
  components: ResolvedComponent[]
  totalBytes: number
  /** Downloads grouped per repo, pinned to the commit the file list was read at. */
  downloads: { repo: string; sha: string; files: HfFile[] }[]
}

export const ORIGINAL = 'original'

/**
 * Quant groups of a gguf component (filtered by stem when the repo hosts
 * several models). Split (multi-file) quants are left out: the profile slot
 * takes one file, and neither diffusers' from_single_file nor sd.cpp follows
 * llama.cpp's split naming.
 */
export function quantChoices(c: Extract<CatalogComponent, { kind: 'gguf' }>, details: HfRepoDetails): HfQuantGroup[] {
  const stem = c.stem?.toLowerCase()
  return details.quants.filter((q) => q.files.length === 1 && !/^mmproj/i.test(q.stem) && (!stem || q.stem.toLowerCase() === stem))
}

/** Throws a readable error when a repo lacks what the recipe expects. */
export function resolveInstall(
  recipe: CatalogRecipe,
  quants: Record<string, string>,
  details: (repo: string) => HfRepoDetails | undefined
): ResolvedInstall {
  const need = (repo: string): HfRepoDetails => {
    const d = details(repo)
    if (!d) throw new Error(`File list of ${repo} is not loaded`)
    return d
  }
  // A GGUF transformer replaces the diffusers folder's own transformer/ weights.
  const ggufTransformer = recipe.components.some((c) => c.kind === 'gguf' && c.originalLabel && (quants[c.id] ?? c.defaultQuant) !== ORIGINAL)

  const components: ResolvedComponent[] = recipe.components.map((c) => {
    const d = need(c.repo)
    if (c.kind === 'file') {
      const f = d.files.find((x) => x.path === c.path)
      if (!f) throw new Error(`${c.repo} no longer contains ${c.path}`)
      return { component: c, repo: c.repo, files: [f], bytes: f.size, slotPath: f.path }
    }
    if (c.kind === 'diffusers') {
      const list = d.pipelineFiles?.[ggufTransformer ? 'withoutTransformer' : 'all']
      if (!list?.length) throw new Error(`${c.repo} is not a diffusers repository`)
      const byPath = new Map(d.files.map((f) => [f.path, f]))
      const files = list.map((p) => byPath.get(p)).filter((f): f is HfFile => !!f)
      return { component: c, repo: c.repo, files, bytes: files.reduce((n, f) => n + f.size, 0), slotPath: '' }
    }
    const choices = quantChoices(c, d)
    const quant = quants[c.id] ?? c.defaultQuant
    if (quant === ORIGINAL && c.originalLabel) return { component: c, repo: c.repo, files: [], bytes: 0, slotPath: null, quant, choices }
    // No silent fallback: the user reviewed sizes for this exact choice.
    const group = choices.find((q) => q.quant === quant)
    if (!group) throw new Error(`${c.repo} has no ${quant} file any more — pick another quant`)
    const first = [...group.files].sort((a, b) => a.path.localeCompare(b.path))[0]
    return { component: c, repo: c.repo, files: group.files, bytes: group.totalBytes, slotPath: first.path, quant: group.quant, choices }
  })

  const byRepo = new Map<string, Map<string, HfFile>>()
  for (const rc of components) {
    const m = byRepo.get(rc.repo) ?? new Map<string, HfFile>()
    for (const f of rc.files) m.set(f.path, f)
    byRepo.set(rc.repo, m)
  }
  const downloads = [...byRepo].filter(([, m]) => m.size > 0).map(([repo, m]) => ({ repo, sha: need(repo).sha, files: [...m.values()] }))
  const totalBytes = downloads.reduce((n, d) => n + d.files.reduce((k, f) => k + f.size, 0), 0)
  return { components, totalBytes, downloads }
}

/** GPUs below this get 8-bit text-encoder quantization on diffusers recipes that support it. */
const TE_QUANT_BELOW_MIB = 23 * 1024

/** Recipe launch args adjusted to the machine (e.g. text-encoder quantization on smaller GPUs). */
export function recommendedArgs(recipe: CatalogRecipe, vramMiB: number | null): CatalogRecipe['args'] {
  const args = { ...recipe.args }
  if (args['text-encoder-quant'] === 'none' && vramMiB !== null && vramMiB < TE_QUANT_BELOW_MIB) args['text-encoder-quant'] = '8bit'
  return args
}

export type InstallFit = 'fits' | 'offload' | 'too-big'

/**
 * Whether an install can run here. Both backends offload to system RAM
 * (diffusers: model CPU offload, sd.cpp: --offload-to-cpu), so only the
 * largest single module must fit VRAM; everything together must fit VRAM + RAM.
 * A diffusers pipeline counts per subfolder (text_encoder/, vae/, …), and
 * 8-bit text-encoder quantization roughly halves text_encoder/.
 */
export function installFit(
  resolved: ResolvedInstall,
  args: CatalogRecipe['args'],
  vramMiB: number | null,
  ramMiB: number
): { fit: InstallFit; largestBytes: number } {
  const teFactor = args['text-encoder-quant'] === '8bit' ? 0.55 : args['text-encoder-quant'] === '4bit' ? 0.3 : 1
  const modules: number[] = []
  for (const rc of resolved.components) {
    if (rc.component.kind !== 'diffusers') {
      if (rc.bytes) modules.push(rc.bytes)
      continue
    }
    const byFolder = new Map<string, number>()
    for (const f of rc.files) {
      const top = f.path.includes('/') ? f.path.slice(0, f.path.indexOf('/')) : ''
      byFolder.set(top, (byFolder.get(top) ?? 0) + f.size * (top === 'text_encoder' ? teFactor : 1))
    }
    modules.push(...byFolder.values())
  }
  const total = modules.reduce((n, b) => n + b, 0)
  const largestBytes = Math.max(0, ...modules)
  const MiB = 1024 * 1024
  const ram = ramMiB * MiB * 0.7
  if (vramMiB === null) return { fit: total * 1.2 <= ram ? 'fits' : 'too-big', largestBytes }
  const vram = vramMiB * MiB
  if (total * 1.2 <= vram) return { fit: 'fits', largestBytes }
  if (largestBytes * 1.15 <= vram && total <= vram + ram) return { fit: 'offload', largestBytes }
  return { fit: 'too-big', largestBytes }
}
