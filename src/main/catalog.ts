// Installs a supported model (src/shared/catalog.ts) for one backend: reads the
// component repos' file lists, queues one pinned download per repo and, once
// every file is on disk, adds a ready-to-use profile.
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type { AppSettings, CatalogInstallRequest, DeepPartial, HfRepoDetails, LocalModelProfile } from '@shared/types'
import { CATALOG_BY_ID, catalogInstallKey } from '@shared/catalog'
import { recommendedArgs, resolveInstall, type ResolvedInstall } from '@shared/catalogResolve'
import type { DownloadManager } from './hf/downloads'

export interface CatalogDeps {
  downloads: DownloadManager
  repoDetails: (repo: string) => Promise<HfRepoDetails>
  getSettings: () => AppSettings
  updateSettings: (patch: DeepPartial<AppSettings>) => Promise<AppSettings>
  /** Called after the profile was added (the renderer refreshes its settings). */
  onProfileCreated: (settings: AppSettings) => void
  /** Largest GPU's VRAM, for machine-specific launch args. */
  vramMiB: () => Promise<number | null>
  /** Reports a failure after the downloads finished (e.g. settings could not be written). */
  onError: (installKey: string, message: string) => void
}

/** Profile for a finished install: recipe args plus every file slot pointing at the downloaded files. */
export function profileFromInstall(
  req: CatalogInstallRequest,
  resolved: ResolvedInstall,
  localDir: (repo: string) => string,
  vramMiB: number | null
): LocalModelProfile {
  const model = CATALOG_BY_ID.get(req.catalogId)!
  const recipe = model.recipes[req.backend]!
  const args: LocalModelProfile['args'] = recommendedArgs(recipe, vramMiB)
  for (const rc of resolved.components) {
    if (rc.slotPath === null) continue
    const dir = localDir(rc.repo)
    args[rc.component.slot] = rc.slotPath === '' ? dir : join(dir, ...rc.slotPath.split('/'))
  }
  const quant = resolved.components.find((rc) => rc.quant && rc.component.slot !== 'llm')?.quant
  const suffix = quant && quant !== 'original' ? ` ${quant}` : ''
  return { id: randomUUID(), name: `${model.label}${suffix}`, backend: req.backend, catalogId: model.id, args, extraArgs: '' }
}

const running = new Set<string>()

/** Starts an install and resolves with its key once the downloads are queued; the profile is added when they finish. */
export async function installCatalogModel(req: CatalogInstallRequest, deps: CatalogDeps): Promise<string> {
  const model = CATALOG_BY_ID.get(req.catalogId)
  const recipe = model?.recipes[req.backend]
  if (!model || !recipe) throw new Error('Unknown model or backend')
  const quants: Record<string, string> = {}
  for (const c of recipe.components) {
    const q = req.quants?.[c.id]
    if (typeof q === 'string' && /^[A-Za-z0-9_-]{1,32}$/.test(q)) quants[c.id] = q
  }
  const key = catalogInstallKey(model.id, req.backend)
  if (running.has(key)) throw new Error(`${model.label} is already downloading`)
  running.add(key)
  try {
    const repos = [...new Set(recipe.components.map((c) => c.repo))]
    const details = new Map<string, HfRepoDetails>()
    for (const repo of repos) details.set(repo, await deps.repoDetails(repo))
    const resolved = resolveInstall(recipe, quants, (r) => details.get(r))
    const ids = resolved.downloads.map((d) =>
      deps.downloads.enqueue({ repo: d.repo, revision: d.sha, files: d.files.map((f) => f.path), expected: d.files, catalogId: key })
    )
    void (async () => {
      try {
        const results = await Promise.all(ids.map((id) => deps.downloads.whenDone(id)))
        if (results.some((r) => r.state !== 'done')) return
        const profile = profileFromInstall({ ...req, quants }, resolved, (r) => deps.downloads.localDir(r), await deps.vramMiB())
        const settings = deps.getSettings()
        // Re-installing (e.g. another quant) replaces nothing: each install adds its own profile.
        const next = await deps.updateSettings({
          local: {
            profiles: [...settings.local.profiles, profile],
            ...(settings.local.activeProfileId ? {} : { activeProfileId: profile.id })
          }
        })
        deps.onProfileCreated(next)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        console.error(`Catalog install ${key} failed after downloading:`, err)
        deps.onError(key, `${model.label} downloaded, but its profile could not be created: ${message}`)
      } finally {
        running.delete(key)
      }
    })()
    return key
  } catch (err) {
    running.delete(key)
    throw err
  }
}
