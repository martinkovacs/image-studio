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

// ---------------------------------------------------------------------------
// Renderer patches are untrusted: keep only known keys with the right types.
// outputDir and customServerPath are deliberately absent — they widen file
// access / choose an executable, so only main-process dialogs may set them.

type Check = (v: unknown) => boolean
const isStr: Check = (v) => typeof v === 'string' && v.length < 4096
const oneOf = (...xs: string[]): Check => (v) => typeof v === 'string' && xs.includes(v)
const isPort: Check = (v) => Number.isInteger(v) && (v as number) >= 1024 && (v as number) <= 65535
const isArg: Check = (v) => typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v)) || isStr(v)

function isProfile(v: unknown): boolean {
  if (!isPlainObject(v)) return false
  const { id, name, args, extraArgs } = v
  return (
    isStr(id) &&
    isStr(name) &&
    isStr(extraArgs) &&
    isPlainObject(args) &&
    Object.entries(args).every(([k, a]) => /^[a-z][a-z0-9_-]*$/.test(k) && isArg(a))
  )
}

const SCHEMA: Record<string, Check | Record<string, Check>> = {
  uiMode: oneOf('studio', 'chat'),
  studioDetail: oneOf('simple', 'advanced'),
  theme: oneOf('dark', 'light', 'system'),
  openrouter: { defaultModel: isStr },
  local: {
    engineVariant: isStr,
    activeProfileId: (v) => v === null || isStr(v),
    listenPort: isPort,
    profiles: (v) => Array.isArray(v) && v.length < 500 && v.every(isProfile)
  }
}

export function sanitizePatch(patch: unknown): DeepPartial<AppSettings> {
  const walk = (p: unknown, schema: Record<string, Check | Record<string, Check>>): Record<string, unknown> => {
    const out: Record<string, unknown> = {}
    if (!isPlainObject(p)) return out
    for (const [k, rule] of Object.entries(schema)) {
      if (!(k in p)) continue
      const v = p[k]
      if (typeof rule === 'function') {
        if (rule(v)) out[k] = v
        else throw new Error(`Invalid setting: ${k}`)
      } else {
        out[k] = walk(v, rule as Record<string, Check>)
      }
    }
    return out
  }
  return walk(patch, SCHEMA) as DeepPartial<AppSettings>
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
  // Merge synchronously against the latest cache so concurrent updates compose.
  const next = merge(getSettings(), patch)
  // Derived from the key file; never writable from the renderer.
  next.openrouter.hasApiKey = existsSync(keyPath())
  cache = next
  await persist(next)
  return getSettings()
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
