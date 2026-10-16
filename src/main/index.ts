import { app, BrowserWindow, dialog, ipcMain, net, protocol, shell } from 'electron'
import { spawn } from 'node:child_process'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { IMG_PROTOCOL } from '@shared/types'
import type {
  AppSettings,
  CatalogInstallRequest,
  EngineInstallProgress,
  GenerationProgress,
  GenerationRequest,
  HfDownloadRequest,
  HfRepoDetails,
  HfSearchOptions,
  LocalModelProfile,
  RuntimeInstallProgress,
  UpscaleRequest
} from '@shared/types'
import { profileBackend } from '@shared/types'
import { IS_SLIM } from '@shared/edition'
import { getHfToken, getOpenRouterKey, getSettings, sanitizePatch, setHfToken, setOpenRouterKey, updateSettings } from './settings'
import { getCredits, listImageModels } from './openrouter'
import { HistoryStore } from './history'
import { createGenerator, localDisabled, readFileAsDataUrl } from './generate'
import { getEngineInfo, installEngine, resolveServerPath } from './sdcpp/engine'
import { listDevices, SdServer } from './sdcpp/server'
import { diffusersLaunch, sdcppLaunch, type LaunchSpec } from './backends/launch'
import { chooseBackend, probeHardware } from './hardware'
import { getRuntimeInfo, installRuntime, runtimeBusy, runtimePythonPath, runtimeRoot, serverScript, uninstallRuntime } from './diffusers/runtime'
import { filesForDiffusersRepo, getRepoDetails, searchModels } from './hf/hub'
import { DownloadManager } from './hf/downloads'
import { installCatalogModel, reposInUse } from './catalog'

/**
 * Squirrel.Windows runs the app with --squirrel-* flags during install/update/
 * uninstall; create or remove shortcuts via Update.exe and exit immediately.
 */
function handleSquirrelEvent(): boolean {
  if (process.platform !== 'win32') return false
  const cmd = process.argv[1]
  if (!cmd?.startsWith('--squirrel-')) return false
  const updateExe = resolve(dirname(process.execPath), '..', 'Update.exe')
  const exe = basename(process.execPath)
  const runUpdate = (args: string[]): void => {
    spawn(updateExe, args, { detached: true })
      .on('close', () => app.quit())
      .on('error', () => app.quit())
  }
  if (cmd === '--squirrel-install' || cmd === '--squirrel-updated') runUpdate(['--createShortcut', exe])
  else if (cmd === '--squirrel-uninstall') runUpdate(['--removeShortcut', exe])
  else if (cmd === '--squirrel-obsolete') app.quit()
  // --squirrel-firstrun (and anything unknown) is a normal launch.
  else return false
  return true
}
const squirrelEvent = handleSquirrelEvent()

// The slim and full editions must not share userData. In packaged builds the
// userData path already derives from productName, but in dev both editions run
// with the same app name — rename before anything reads userData.
if (IS_SLIM) app.setName('Image Studio Lite')

/** A server stand-in used when the real SdServer is never constructed (slim). */
const absentServer = {
  status: () => ({ state: 'stopped', profileId: null, port: null }),
  start: async () => { throw localDisabled() },
  imgGen: async () => { throw localDisabled() },
  upscale: async () => { throw localDisabled() },
  on: () => undefined,
  off: () => undefined
}

protocol.registerSchemesAsPrivileged([
  { scheme: IMG_PROTOCOL, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }
])

let win: BrowserWindow | null = null
// Guard: rejects every local-only code path in the slim edition.
function requireLocal(): void {
  if (IS_SLIM) throw localDisabled()
}
// The sd-server process is only ever constructed (and later spawned) in the
// full edition; the stub above reports "stopped" if something ever touches it.
const server: SdServer = IS_SLIM ? (absentServer as unknown as SdServer) : new SdServer()
const history = new HistoryStore(join(app.getPath('userData'), 'history'))

const send = (channel: string, payload: unknown): void => {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload)
}

/** Launch spec for a profile on its own backend; throws a user-facing error when that backend is not installed. */
async function resolveLaunch(settings: AppSettings, profile: LocalModelProfile): Promise<LaunchSpec> {
  if (profileBackend(profile) === 'diffusers') {
    // The installer swaps the venv in place; a server started from it mid-install breaks both.
    if (runtimeBusy()) throw new Error('The diffusers runtime is being installed or removed — wait for it to finish')
    const pythonPath = await runtimePythonPath()
    if (!pythonPath) throw new Error('The diffusers runtime is not installed — install it in Settings → Local engine')
    return diffusersLaunch({
      pythonPath,
      scriptPath: serverScript(),
      profile,
      hfHome: join(runtimeRoot(), 'hf-home'),
      // Re-checked right before spawn: an install/removal may have taken the lock since.
      preflight: () => {
        if (runtimeBusy()) throw new Error('The diffusers runtime is being installed or removed — wait for it to finish')
      }
    })
  }
  const serverPath = await resolveServerPath(settings)
  if (!serverPath) throw new Error('No stable-diffusion.cpp engine installed — install one in Settings → Local engine')
  return sdcppLaunch(serverPath, profile)
}

const downloads = new DownloadManager({ modelsDir: () => getSettings().local.modelsDir, token: getHfToken })
downloads.on('progress', (p) => send('hf:progress', p))

const maxVram = (gpus: { vramMiB: number | null }[]): number | null =>
  gpus.reduce<number | null>((m, g) => (g.vramMiB !== null && (m === null || g.vramMiB > m) ? g.vramMiB : m), null)

/** Repo file list (+ the diffusers pipeline subset), read with the stored token. */
async function repoDetails(id: string): Promise<HfRepoDetails> {
  const details = await getRepoDetails(id, { token: getHfToken() })
  if (details.kind !== 'diffusers') return details
  const paths = (excludeTransformer: boolean) => filesForDiffusersRepo(details, { excludeTransformer }).map((f) => f.path)
  return { ...details, pipelineFiles: { all: paths(false), withoutTransformer: paths(true) } }
}

const generator = createGenerator({
  getSettings,
  getApiKey: getOpenRouterKey,
  server,
  resolveLaunch,
  history,
  emitProgress: (p: GenerationProgress) => send('gen:progress', p)
})

server.on('status', (s) => send('local:status', s))
server.on('log', (line) => send('local:log', line))

/**
 * The renderer may only read files inside the current output directory or files
 * recorded in history (which may live in a previous output directory).
 */
const IMAGE_EXT = /\.(png|jpe?g|webp|gif|bmp|svg)$/i

async function assertReadable(p: string): Promise<string> {
  const abs = resolve(p)
  if (!IMAGE_EXT.test(abs)) throw new Error('Access denied: not an image file')
  const root = resolve(getSettings().outputDir) + sep
  if (abs.startsWith(root) || (await history.hasFile(abs))) return abs
  throw new Error('Access denied: path is not a studio image')
}

function registerImageProtocol(): void {
  protocol.handle(IMG_PROTOCOL, async (request) => {
    try {
      const url = new URL(request.url)
      const abs = await assertReadable(decodeURIComponent(url.pathname.slice(1)))
      return await net.fetch(pathToFileURL(abs).toString())
    } catch {
      return new Response('Forbidden', { status: 403 })
    }
  })
}

function str(v: unknown, name: string): string {
  if (typeof v !== 'string') throw new Error(`Invalid ${name}`)
  return v
}

function registerIpc(): void {
  ipcMain.handle('settings:get', () => getSettings())
  ipcMain.handle('settings:update', (_e, patch) => updateSettings(sanitizePatch(patch)))
  ipcMain.handle('settings:chooseOutputDir', async () => {
    const res = await dialog.showOpenDialog(win!, { title: 'Output folder', properties: ['openDirectory', 'createDirectory'] })
    const dir = res.canceled ? undefined : res.filePaths[0]
    return dir ? updateSettings({ outputDir: dir }) : null
  })
  ipcMain.handle('settings:chooseServerBinary', async () => {
    const res = await dialog.showOpenDialog(win!, { title: 'sd-server binary', properties: ['openFile'] })
    const file = res.canceled ? undefined : res.filePaths[0]
    return file ? updateSettings({ local: { engineVariant: 'custom', customServerPath: file } }) : null
  })
  ipcMain.handle('settings:setOpenRouterKey', (_e, key) => setOpenRouterKey(key === null ? null : str(key, 'key')))
  ipcMain.handle('settings:pickPath', async (_e, opts: { kind: 'file' | 'directory'; title?: string; filters?: Electron.FileFilter[] }) => {
    const res = await dialog.showOpenDialog(win!, {
      title: opts?.title,
      properties: [opts?.kind === 'directory' ? 'openDirectory' : 'openFile'],
      filters: opts?.filters
    })
    return res.canceled ? null : (res.filePaths[0] ?? null)
  })

  ipcMain.handle('openrouter:listModels', (_e, force) => listImageModels(!!force))
  ipcMain.handle('openrouter:credits', () => {
    const key = getOpenRouterKey()
    return key ? getCredits(key) : null
  })

  ipcMain.handle('engine:info', () => {
    requireLocal()
    return getEngineInfo(getSettings())
  })
  ipcMain.handle('engine:install', (_e, variantId) => {
    requireLocal()
    const id = str(variantId, 'variant')
    return installEngine(
      id,
      (p: EngineInstallProgress) => send('engine:progress', p),
      // Replacing the binaries of a running engine fails on Windows and is unsafe elsewhere.
      async () => {
        if (server.status().state !== 'stopped') await server.stop()
      }
    )
  })

  ipcMain.handle('backend:info', async (_e, refresh) => {
    requireLocal()
    return chooseBackend(await probeHardware({ refresh: refresh === true }), getSettings().local.backend)
  })

  ipcMain.handle('diffusers:info', () => {
    requireLocal()
    return getRuntimeInfo()
  })
  ipcMain.handle('diffusers:install', async () => {
    requireLocal()
    // The venv is replaced in place; a running diffusers server holds files open in it.
    // Stop only once the lock is held: stop() wins over an in-flight start, and
    // later starts fail the launch preflight.
    return installRuntime((p: RuntimeInstallProgress) => send('diffusers:progress', p), () => server.stop().then(() => undefined))
  })
  ipcMain.handle('diffusers:remove', async () => {
    requireLocal()
    return uninstallRuntime(() => server.stop().then(() => undefined))
  })

  ipcMain.handle('hf:setToken', (_e, token) => {
    requireLocal()
    return setHfToken(token === null ? null : str(token, 'token'))
  })
  ipcMain.handle('hf:search', (_e, opts: HfSearchOptions) => {
    requireLocal()
    const format = opts?.format === 'diffusers' || opts?.format === 'all' ? opts.format : 'gguf'
    const sort = ['downloads', 'likes', 'lastModified', 'trendingScore'].includes(opts?.sort as string) ? opts.sort : 'downloads'
    const task = opts?.task === 'text-to-image' || opts?.task === 'image-to-image' ? opts.task : null
    const limit = Number.isInteger(opts?.limit) ? opts.limit : 30
    return searchModels({ query: str(opts?.query ?? '', 'query').slice(0, 200), format, sort, task, limit }, { token: getHfToken() })
  })
  ipcMain.handle('hf:repo', (_e, id) => {
    requireLocal()
    return repoDetails(str(id, 'repository id'))
  })
  ipcMain.handle('hf:download', (_e, req: HfDownloadRequest) => {
    requireLocal()
    const revision = req?.revision === undefined ? undefined : str(req.revision, 'revision')
    if (revision !== undefined && !/^[A-Za-z0-9._-]{1,100}$/.test(revision)) throw new Error('Invalid revision')
    if (!Array.isArray(req?.files) || req.files.length === 0 || req.files.length > 2000) throw new Error('Invalid file list')
    // enqueue validates the repo id and every path (no traversal outside the repo folder).
    return downloads.enqueue({ repo: str(req.repo, 'repository id'), revision, files: req.files.map((f) => str(f, 'file')) })
  })
  ipcMain.handle('hf:cancel', (_e, id) => {
    requireLocal()
    downloads.cancel(str(id, 'download id'))
  })
  ipcMain.handle('hf:downloads', () => {
    requireLocal()
    return downloads.list()
  })
  ipcMain.handle('hf:local', () => {
    requireLocal()
    return downloads.scanLocal()
  })
  ipcMain.handle('hf:removeLocal', (_e, repo) => {
    requireLocal()
    const id = str(repo, 'repository id')
    if (reposInUse().has(id)) throw new Error(`${id} is part of a model install that is still running`)
    return downloads.removeLocal(id)
  })
  ipcMain.handle('hf:revealLocal', async (_e, repo) => {
    requireLocal()
    const err = await shell.openPath(downloads.localDir(str(repo, 'repository id')))
    if (err) throw new Error(err)
  })
  ipcMain.handle('hf:chooseModelsDir', async () => {
    requireLocal()
    // Queued files and catalog profiles resolve paths against the folder, so it must not move mid-download.
    const assertIdle = (): void => {
      if (downloads.list().some((d) => d.state === 'queued' || d.state === 'downloading' || d.state === 'verifying') || reposInUse().size > 0) {
        throw new Error('Wait for the running downloads to finish (or cancel them) before changing the models folder')
      }
    }
    assertIdle()
    const res = await dialog.showOpenDialog(win!, { title: 'Models folder', properties: ['openDirectory', 'createDirectory'] })
    const dir = res.canceled ? undefined : res.filePaths[0]
    if (!dir) return null
    assertIdle() // a download may have started while the dialog was open
    return updateSettings({ local: { modelsDir: dir } })
  })

  ipcMain.handle('catalog:install', (_e, req: CatalogInstallRequest) => {
    requireLocal()
    const backend = req?.backend === 'diffusers' ? 'diffusers' : 'sdcpp'
    const quants = req?.quants && typeof req.quants === 'object' && !Array.isArray(req.quants) ? req.quants : {}
    return installCatalogModel(
      { catalogId: str(req?.catalogId, 'model'), backend, quants },
      {
        downloads,
        repoDetails,
        getSettings,
        updateSettings,
        onProfileCreated: (s) => send('settings:changed', s),
        onError: (catalogId, error) => send('catalog:error', { catalogId, error }),
        vramMiB: async () => maxVram((await probeHardware()).gpus)
      }
    )
  })

  ipcMain.handle('local:status', () => { requireLocal(); return server.status() })
  ipcMain.handle('local:start', async (_e, profileId) => {
    requireLocal()
    const settings = getSettings()
    const profile = settings.local.profiles.find((p) => p.id === profileId)
    if (!profile) throw new Error('Unknown model profile')
    const launch = await resolveLaunch(settings, profile)
    await updateSettings({ local: { activeProfileId: profile.id } })
    return server.start(profile, launch, settings.local.listenPort)
  })
  ipcMain.handle('local:stop', () => { requireLocal(); return server.stop() })
  ipcMain.handle('local:capabilities', () => { requireLocal(); return server.capabilities() })
  ipcMain.handle('local:logs', () => { requireLocal(); return server.logs() })
  ipcMain.handle('local:listDevices', async () => {
    requireLocal()
    const path = await resolveServerPath(getSettings())
    return path ? listDevices(path) : []
  })

  ipcMain.handle('gen:run', (_e, jobId, req: GenerationRequest) => generator.run(str(jobId, 'jobId'), req))
  ipcMain.handle('gen:cancel', (_e, jobId) => generator.cancel(str(jobId, 'jobId')))
  ipcMain.handle('gen:upscale', (_e, jobId, req: UpscaleRequest) => {
    requireLocal()
    return generator.upscale(str(jobId, 'jobId'), req)
  })

  ipcMain.handle('history:list', (_e, opts) => history.list(opts ?? {}))
  ipcMain.handle('history:remove', (_e, id) => history.remove(str(id, 'id'), { deleteFiles: true }))
  ipcMain.handle('history:reveal', async (_e, p) => shell.showItemInFolder(await assertReadable(str(p, 'path'))))
  ipcMain.handle('history:readAsDataUrl', async (_e, p) => readFileAsDataUrl(await assertReadable(str(p, 'path'))))
  ipcMain.handle('history:threads', () => history.threads())
  ipcMain.handle('history:createThread', (_e, title) => history.createThread(str(title, 'title')))
  ipcMain.handle('history:renameThread', (_e, id, title) => history.renameThread(str(id, 'id'), str(title, 'title')))
  ipcMain.handle('history:deleteThread', (_e, id) => history.deleteThread(str(id, 'id')))
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 1480,
    height: 920,
    minWidth: 960,
    minHeight: 600,
    backgroundColor: '#0e0e10',
    title: 'Image Studio',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true
    }
  })

  // Never open new Electron windows; send https links to the system browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (e, url) => {
    const devUrl = process.env['ELECTRON_RENDERER_URL']
    if (!(devUrl && url.startsWith(devUrl))) e.preventDefault()
  })

  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (!app.isPackaged && devUrl) void win.loadURL(devUrl)
  else void win.loadFile(join(__dirname, '../renderer/index.html'))
}

app.whenReady().then(() => {
  if (squirrelEvent) return
  registerImageProtocol()
  registerIpc()
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

let quitting = false
app.on('before-quit', (e) => {
  if (squirrelEvent || server.status().state === 'stopped') return
  // Keep the app alive until sd-server has really exited, even on repeated quits.
  e.preventDefault()
  if (quitting) return
  quitting = true
  void server.stop().finally(() => app.exit(0))
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
