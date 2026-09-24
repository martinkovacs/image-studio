import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { StudioApi } from '@shared/types'
import { IS_SLIM } from '@shared/edition'

const invoke = (channel: string, ...args: unknown[]) => ipcRenderer.invoke(channel, ...args)

function subscribe<T>(channel: string, cb: (payload: T) => void): () => void {
  const listener = (_e: IpcRendererEvent, payload: T): void => cb(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

const api: StudioApi = {
  edition: IS_SLIM ? 'slim' : 'full',
  settings: {
    get: () => invoke('settings:get'),
    update: (patch) => invoke('settings:update', patch),
    setOpenRouterKey: (key) => invoke('settings:setOpenRouterKey', key),
    chooseOutputDir: () => invoke('settings:chooseOutputDir'),
    chooseServerBinary: () => invoke('settings:chooseServerBinary'),
    pickPath: (opts) => invoke('settings:pickPath', opts)
  },
  openrouter: {
    listModels: (force) => invoke('openrouter:listModels', force),
    credits: () => invoke('openrouter:credits')
  },
  engine: {
    info: () => invoke('engine:info'),
    install: (variantId) => invoke('engine:install', variantId),
    onInstallProgress: (cb) => subscribe('engine:progress', cb)
  },
  local: {
    status: () => invoke('local:status'),
    start: (profileId) => invoke('local:start', profileId),
    stop: () => invoke('local:stop'),
    capabilities: () => invoke('local:capabilities'),
    logs: () => invoke('local:logs'),
    onStatus: (cb) => subscribe('local:status', cb),
    onLog: (cb) => subscribe('local:log', cb),
    listDevices: () => invoke('local:listDevices')
  },
  gen: {
    run: (jobId, req) => invoke('gen:run', jobId, req),
    cancel: (jobId) => invoke('gen:cancel', jobId),
    upscale: (jobId, req) => invoke('gen:upscale', jobId, req),
    onProgress: (cb) => subscribe('gen:progress', cb)
  },
  history: {
    list: (opts) => invoke('history:list', opts),
    remove: (id) => invoke('history:remove', id),
    reveal: (path) => invoke('history:reveal', path),
    readAsDataUrl: (path) => invoke('history:readAsDataUrl', path),
    threads: () => invoke('history:threads'),
    createThread: (title) => invoke('history:createThread', title),
    renameThread: (id, title) => invoke('history:renameThread', id, title),
    deleteThread: (id) => invoke('history:deleteThread', id)
  }
}

contextBridge.exposeInMainWorld('api', api)
