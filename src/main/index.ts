import { app, BrowserWindow, dialog, ipcMain, net, protocol, shell } from 'electron'
import { join, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { IMG_PROTOCOL } from '@shared/types'
import type { EngineInstallProgress, GenerationProgress, GenerationRequest, UpscaleRequest } from '@shared/types'
import { getOpenRouterKey, getSettings, sanitizePatch, setOpenRouterKey, updateSettings } from './settings'
import { getCredits, listImageModels } from './openrouter'
import { HistoryStore } from './history'
import { createGenerator, readFileAsDataUrl } from './generate'
import { getEngineInfo, installEngine, resolveServerPath } from './sdcpp/engine'
import { listDevices, SdServer } from './sdcpp/server'

protocol.registerSchemesAsPrivileged([
  { scheme: IMG_PROTOCOL, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }
])

let win: BrowserWindow | null = null
const server = new SdServer()
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

  ipcMain.handle('engine:info', () => getEngineInfo(getSettings()))
  ipcMain.handle('engine:install', (_e, variantId) =>
    installEngine(str(variantId, 'variant'), (p: EngineInstallProgress) => send('engine:progress', p))
  )

  ipcMain.handle('local:status', () => server.status())
  ipcMain.handle('local:start', async (_e, profileId) => {
    const settings = getSettings()
    const profile = settings.local.profiles.find((p) => p.id === profileId)
    if (!profile) throw new Error('Unknown model profile')
    const path = await resolveServerPath(settings)
    if (!path) throw new Error('No stable-diffusion.cpp engine installed — install one in Settings → Local engine')
    await updateSettings({ local: { activeProfileId: profile.id } })
    return server.start(profile, path, settings.local.listenPort)
  })
  ipcMain.handle('local:stop', () => server.stop())
  ipcMain.handle('local:capabilities', () => server.capabilities())
  ipcMain.handle('local:logs', () => server.logs())
  ipcMain.handle('local:listDevices', async () => {
    const path = await resolveServerPath(getSettings())
    return path ? listDevices(path) : []
  })

  ipcMain.handle('gen:run', (_e, jobId, req: GenerationRequest) => generator.run(str(jobId, 'jobId'), req))
  ipcMain.handle('gen:cancel', (_e, jobId) => generator.cancel(str(jobId, 'jobId')))
  ipcMain.handle('gen:upscale', (_e, jobId, req: UpscaleRequest) => generator.upscale(str(jobId, 'jobId'), req))

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
  registerImageProtocol()
  registerIpc()
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

let quitting = false
app.on('before-quit', (e) => {
  if (quitting || server.status().state === 'stopped') return
  e.preventDefault()
  quitting = true
  void server.stop().finally(() => app.quit())
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
