import { app, BrowserWindow, dialog, ipcMain, net, protocol, shell } from 'electron'
import { spawn } from 'node:child_process'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { IMG_PROTOCOL } from '@shared/types'
import type { EngineInstallProgress, GenerationProgress, GenerationRequest, UpscaleRequest } from '@shared/types'
import { IS_SLIM } from '@shared/edition'
import { getOpenRouterKey, getSettings, sanitizePatch, setOpenRouterKey, updateSettings } from './settings'
import { getCredits, listImageModels } from './openrouter'
import { HistoryStore } from './history'
import { createGenerator, localDisabled, readFileAsDataUrl } from './generate'
import { getEngineInfo, installEngine, resolveServerPath } from './sdcpp/engine'
import { listDevices, SdServer } from './sdcpp/server'

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

const generator = createGenerator({
  getSettings,
  getApiKey: getOpenRouterKey,
  server,
  resolveServerPath,
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

  ipcMain.handle('local:status', () => { requireLocal(); return server.status() })
  ipcMain.handle('local:start', async (_e, profileId) => {
    requireLocal()
    const settings = getSettings()
    const profile = settings.local.profiles.find((p) => p.id === profileId)
    if (!profile) throw new Error('Unknown model profile')
    const path = await resolveServerPath(settings)
    if (!path) throw new Error('No stable-diffusion.cpp engine installed — install one in Settings → Local engine')
    await updateSettings({ local: { activeProfileId: profile.id } })
    return server.start(profile, path, settings.local.listenPort)
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
