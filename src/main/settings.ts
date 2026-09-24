import { app, safeStorage } from 'electron'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { AppSettings, DeepPartial } from '@shared/types'

const settingsPath = (): string => join(app.getPath('userData'), 'settings.json')
const keyPath = (): string => join(app.getPath('userData'), 'openrouter.key')

function defaults(): AppSettings {
  return {
    uiMode: 'studio',
    studioDetail: 'simple',
    theme: 'dark',
    outputDir: join(app.getPath('pictures'), 'Image Studio'),
    openrouter: { hasApiKey: false, defaultModel: 'google/gemini-3-pro-image' },
    local: {
      engineVariant: '',
      customServerPath: '',
      activeProfileId: null,
      listenPort: 17860,
      profiles: []
    }
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** Deep merge where arrays and scalars in `patch` replace values in `base`. */
function merge<T>(base: T, patch: unknown): T {
  if (!isPlainObject(base) || !isPlainObject(patch)) return (patch === undefined ? base : patch) as T
  const out: Record<string, unknown> = { ...base }
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined || k === '__proto__' || k === 'constructor') continue
    out[k] = k in base ? merge((base as Record<string, unknown>)[k], v) : v
  }
  return out as T
}

let cache: AppSettings | null = null
let writeQueue: Promise<void> = Promise.resolve()

export function getSettings(): AppSettings {
  if (!cache) {
    let stored: unknown = {}
    try {
      if (existsSync(settingsPath())) stored = JSON.parse(readFileSync(settingsPath(), 'utf8'))
    } catch (err) {
      console.error('Failed to read settings, using defaults:', err)
    }
    cache = merge(defaults(), stored)
    cache.openrouter.hasApiKey = existsSync(keyPath())
  }
  return cache
}

function persist(settings: AppSettings): Promise<void> {
  const data = JSON.stringify(settings, null, 2)
  writeQueue = writeQueue.then(async () => {
    await mkdir(app.getPath('userData'), { recursive: true })
    const tmp = settingsPath() + '.tmp'
    await writeFile(tmp, data)
    await rename(tmp, settingsPath())
  })
  return writeQueue
}

export async function updateSettings(patch: DeepPartial<AppSettings>): Promise<AppSettings> {
  const next = merge(getSettings(), patch)
  // Derived from the key file; never writable from the renderer.
  next.openrouter.hasApiKey = existsSync(keyPath())
  cache = next
  await persist(next)
  return next
}

// The OpenRouter key is encrypted with the OS keychain (safeStorage) and never
// sent to the renderer.
export async function setOpenRouterKey(key: string | null): Promise<void> {
  const trimmed = key?.trim()
  if (!trimmed) {
    await rm(keyPath(), { force: true })
  } else {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('OS secure storage is unavailable; cannot store the API key safely.')
    }
    await mkdir(app.getPath('userData'), { recursive: true })
    await writeFile(keyPath(), safeStorage.encryptString(trimmed), { mode: 0o600 })
  }
  getSettings().openrouter.hasApiKey = !!trimmed
}

export function getOpenRouterKey(): string | null {
  try {
    if (!existsSync(keyPath())) return null
    return safeStorage.decryptString(readFileSync(keyPath()))
  } catch (err) {
    console.error('Failed to decrypt OpenRouter key:', err)
    return null
  }
}
