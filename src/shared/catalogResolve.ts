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

/** Quant groups of a gguf component (filtered by stem when the repo hosts several models). */
export function quantChoices(c: Extract<CatalogComponent, { kind: 'gguf' }>, details: HfRepoDetails): HfQuantGroup[] {
  const stem = c.stem?.toLowerCase()
  return details.quants.filter((q) => !/^mmproj/i.test(q.stem) && (!stem || q.stem.toLowerCase() === stem))
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
    const group = choices.find((q) => q.quant === quant) ?? choices.find((q) => q.quant === c.defaultQuant)
    if (!group) throw new Error(`${c.repo} has no ${quant} file`)
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
