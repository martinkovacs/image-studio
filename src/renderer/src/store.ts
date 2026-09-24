import { create } from 'zustand'
import type {
  AppSettings,
  DeepPartial,
  GenerationProgress,
  GenerationRequest,
  GenerationResult,
  HistoryItem,
  OrImageModel,
  OrImageParams,
  ProviderId,
  SdCapabilities,
  SdImgGenBody,
  ServerStatus
} from '@shared/types'
import { uid } from './lib/util'
import { SLIM } from './lib/edition'

export interface Job {
  id: string
  request: GenerationRequest
  startedAt: number
  progress?: GenerationProgress
  label: string
}

export interface Inputs {
  refImages: string[]
  initImage?: string
  maskImage?: string
}

type View = 'main' | 'settings'

interface State {
  settings: AppSettings | null
  view: View
  provider: ProviderId
  prompt: string
  negativePrompt: string

  orModels: OrImageModel[]
  orModelsError: string | null
  orModel: string
  orParams: OrImageParams
  /** Custom OpenRouter request-body JSON for the selected model, as typed by the user. */
  orExtraJson: string

  serverStatus: ServerStatus
  caps: SdCapabilities | null
  /** User overrides on top of the loaded model's defaults. */
  localParams: SdImgGenBody

  inputs: Inputs
  inpaintMode: boolean

  jobs: Record<string, Job>
  history: HistoryItem[]
  selected: { id: string; fileIndex: number } | null
  toast: { kind: 'error' | 'info'; text: string } | null
}

interface Actions {
  init(): Promise<void>
  updateSettings(patch: DeepPartial<AppSettings>): Promise<void>
  setView(v: View): void
  set<K extends keyof State>(key: K, value: State[K]): void
  setOrParam<K extends keyof OrImageParams>(key: K, value: OrImageParams[K]): void
  setOrModel(id: string): void
  setOrExtraJson(text: string): void
  patchLocal(patch: SdImgGenBody): void
  resetLocalToDefaults(): void
  loadOrModels(force?: boolean): Promise<void>
  refreshCaps(): Promise<void>
  refreshHistory(): Promise<void>
  generate(opts?: { threadId?: string; prompt?: string; inputs?: Inputs }): Promise<GenerationResult | null>
  cancel(jobId: string): Promise<void>
  upscale(item: HistoryItem, fileIndex: number, upscaler?: string, repeats?: number): Promise<void>
  addRefImages(urls: string[]): void
  removeRefImage(i: number): void
  showError(text: string): void
  showInfo(text: string): void
}

export type Store = State & Actions

const localKey = (stem: string) => `localParams:${stem}`

/** Custom OpenRouter JSON params are stored per model id: { [modelId]: jsonText }. */
const orExtraKey = 'orExtraJson'

const loadOrExtraMap = (): Record<string, string> => readJson<Record<string, string>>(orExtraKey)

/** Parse a localStorage JSON object; a corrupted value must never white-screen the app. */
function readJson<T extends object>(key: string): T {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(key) ?? '{}')
    return (v && typeof v === 'object' && !Array.isArray(v) ? v : {}) as T
  } catch {
    return {} as T
  }
}

function loadLocalOverrides(stem: string): SdImgGenBody {
  return readJson<SdImgGenBody>(localKey(stem))
}

/** Deep merge for the nested sd.cpp body objects. */
export function mergeBody<T extends object>(base: T, patch: Partial<T>): T {
  const out = { ...base } as Record<string, unknown>
  for (const [k, v] of Object.entries(patch)) {
    const cur = out[k]
    if (v && typeof v === 'object' && !Array.isArray(v) && cur && typeof cur === 'object' && !Array.isArray(cur)) {
      out[k] = mergeBody(cur as object, v as object)
    } else {
      out[k] = v
    }
  }
  return out as T
}

/** Params that actually get sent: model defaults + user overrides. */
export function effectiveLocalParams(s: Pick<State, 'caps' | 'localParams'>): SdImgGenBody {
  const defaults = (s.caps?.defaults_by_mode?.img_gen ?? {}) as SdImgGenBody
  return mergeBody(defaults, s.localParams)
}

let toastTimer: ReturnType<typeof setTimeout> | undefined
let initialized = false

export const useStore = create<Store>((set, get) => ({
  settings: null,
  view: 'main',
  provider: SLIM ? 'openrouter' : (localStorage.getItem('provider') as ProviderId) || 'openrouter',
  prompt: '',
  negativePrompt: '',
  orModels: [],
  orModelsError: null,
  orModel: '',
  orParams: readJson<OrImageParams>('orParams'),
  orExtraJson: '',
  serverStatus: { state: 'stopped', profileId: null, port: null },
  caps: null,
  localParams: {},
  inputs: { refImages: [] },
  inpaintMode: false,
  jobs: {},
  history: [],
  selected: null,
  toast: null,

  async init() {
    // StrictMode mounts effects twice; IPC subscriptions must exist exactly once.
    if (initialized) return
    initialized = true
    const settings = await window.api.settings.get()
    const orModel = localStorage.getItem('orModel') || settings.openrouter.defaultModel
    set({ settings, orModel, orExtraJson: loadOrExtraMap()[orModel] ?? '' })
    window.api.gen.onProgress((p) => {
      const job = get().jobs[p.jobId]
      if (job) set({ jobs: { ...get().jobs, [p.jobId]: { ...job, progress: p } } })
    })
    window.api.local.onStatus((s) => {
      set({ serverStatus: s })
      if (s.state === 'ready') void get().refreshCaps()
      if (s.state === 'stopped' || s.state === 'error') set({ caps: null })
      if (s.state === 'error' && s.error) get().showError(s.error.split('\n')[0])
    })
    void get().loadOrModels()
    void get().refreshHistory()
    if (SLIM) return
    const status = await window.api.local.status()
    set({ serverStatus: status })
    if (status.state === 'ready') void get().refreshCaps()
  },

  async updateSettings(patch) {
    const settings = await window.api.settings.update(patch)
    set({ settings })
  },

  setView: (view) => set({ view }),
  set: (key, value) => {
    if (key === 'provider') {
      localStorage.setItem('provider', value as string)
      if (value !== 'local') set({ inpaintMode: false })
    }
    set({ [key]: value } as Partial<State>)
  },

  setOrParam(key, value) {
    const orParams = { ...get().orParams, [key]: value }
    if (value === undefined || value === '') delete orParams[key]
    localStorage.setItem('orParams', JSON.stringify(orParams))
    set({ orParams })
  },

  setOrModel(id) {
    localStorage.setItem('orModel', id)
    // Drop params the new model does not declare so we never send unsupported values.
    const model = get().orModels.find((m) => m.id === id)
    const orParams = { ...get().orParams }
    if (model) {
      for (const k of Object.keys(orParams) as (keyof OrImageParams)[]) {
        const spec = model.supported_parameters[k]
        const v = orParams[k]
        if (!spec || (spec.type === 'enum' && !spec.values.includes(String(v)))) delete orParams[k]
      }
    }
    localStorage.setItem('orParams', JSON.stringify(orParams))
    set({ orModel: id, orParams, orExtraJson: loadOrExtraMap()[id] ?? '' })
  },

  setOrExtraJson(text) {
    // One entry per model id, so switching models restores that model's JSON.
    const map = loadOrExtraMap()
    const id = get().orModel
    if (text.trim()) map[id] = text
    else delete map[id]
    localStorage.setItem(orExtraKey, JSON.stringify(map))
    set({ orExtraJson: text })
  },

  patchLocal(patch) {
    const localParams = mergeBody(get().localParams, patch)
    const stem = get().caps?.model.stem
    if (stem) localStorage.setItem(localKey(stem), JSON.stringify(localParams))
    set({ localParams })
  },

  resetLocalToDefaults() {
    const stem = get().caps?.model.stem
    if (stem) localStorage.removeItem(localKey(stem))
    set({ localParams: {} })
  },

  async loadOrModels(force) {
    try {
      const orModels = await window.api.openrouter.listModels(force)
      set({ orModels, orModelsError: null })
      if (!orModels.some((m) => m.id === get().orModel) && orModels[0]) get().setOrModel(orModels[0].id)
    } catch (err) {
      set({ orModelsError: (err as Error).message })
    }
  },

  async refreshCaps() {
    const caps = await window.api.local.capabilities()
    set({ caps, localParams: caps ? loadLocalOverrides(caps.model.stem) : {} })
  },

  async refreshHistory() {
    const history = await window.api.history.list({ limit: 500 })
    set({ history })
  },

  async generate(opts) {
    const s = get()
    const prompt = (opts?.prompt ?? s.prompt).trim()
    if (!prompt) {
      s.showError('Write a prompt first')
      return null
    }
    const inputs = opts?.inputs ?? s.inputs
    const req: GenerationRequest = {
      provider: s.provider,
      prompt,
      negativePrompt: s.provider === 'local' ? s.negativePrompt || undefined : undefined,
      inputs: {
        refImages: inputs.refImages,
        initImage: s.provider === 'local' ? inputs.initImage : undefined,
        maskImage: s.provider === 'local' && inputs.initImage ? inputs.maskImage : undefined
      },
      threadId: opts?.threadId
    }
    if (s.provider === 'openrouter') {
      if (!s.orModel) {
        s.showError('Pick an OpenRouter model')
        return null
      }
      const model = s.orModels.find((m) => m.id === s.orModel)
      const refSpec = model?.supported_parameters.input_references
      const maxRefs = refSpec?.type === 'range' ? refSpec.max : 0
      if (model && req.inputs.refImages.length > maxRefs) {
        if (maxRefs === 0 && !opts?.threadId) {
          s.showError('This model does not accept input images — remove them or pick an edit-capable model')
          return null
        }
        // Chat auto-attaches the previous result; silently trim to what the model accepts.
        req.inputs.refImages = req.inputs.refImages.slice(0, maxRefs)
      }
      // Custom JSON is re-validated in main; this parse only gives an early, local error.
      let extra: Record<string, unknown> | undefined
      const extraText = s.orExtraJson.trim()
      if (extraText) {
        let parsed: unknown
        try {
          parsed = JSON.parse(extraText)
        } catch {
          s.showError('Custom parameters must be a JSON object')
          return null
        }
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          s.showError('Custom parameters must be a JSON object')
          return null
        }
        extra = parsed as Record<string, unknown>
      }
      req.openrouter = extra
        ? { model: s.orModel, params: s.orParams, extra }
        : { model: s.orModel, params: s.orParams }
    } else {
      const profile = s.settings?.local.profiles.find((p) => p.id === s.settings?.local.activeProfileId)
      if (!profile) {
        s.showError('Create and select a local model profile in Settings → Local models')
        return null
      }
      // Send only user overrides; server-side defaults fill the rest for whichever model is loaded.
      req.local = s.localParams
    }

    const jobId = uid()
    const label = s.provider === 'openrouter' ? s.orModel.split('/').pop()! : (s.caps?.model.stem ?? 'local')
    set({ jobs: { ...get().jobs, [jobId]: { id: jobId, request: req, startedAt: Date.now(), label } } })
    try {
      const res = await window.api.gen.run(jobId, req)
      if (res.ok) {
        set({ history: [res.item, ...get().history], selected: { id: res.item.id, fileIndex: 0 } })
      } else if (!res.cancelled) {
        get().showError(res.error)
      }
      return res
    } catch (err) {
      get().showError((err as Error).message)
      return null
    } finally {
      const { [jobId]: _done, ...rest } = get().jobs
      set({ jobs: rest })
    }
  },

  async cancel(jobId) {
    await window.api.gen.cancel(jobId)
  },

  async upscale(item, fileIndex, upscaler, repeats) {
    const jobId = uid()
    const req: GenerationRequest = { provider: 'local', prompt: item.prompt, inputs: { refImages: [] } }
    set({ jobs: { ...get().jobs, [jobId]: { id: jobId, request: req, startedAt: Date.now(), label: 'Upscale' } } })
    try {
      const res = await window.api.gen.upscale(jobId, { historyId: item.id, fileIndex, upscaler, repeats })
      if (res.ok) set({ history: [res.item, ...get().history], selected: { id: res.item.id, fileIndex: 0 } })
      else if (!res.cancelled) get().showError(res.error)
    } catch (err) {
      get().showError((err as Error).message)
    } finally {
      const { [jobId]: _done, ...rest } = get().jobs
      set({ jobs: rest })
    }
  },

  addRefImages(urls) {
    set({ inputs: { ...get().inputs, refImages: [...get().inputs.refImages, ...urls] } })
  },
  removeRefImage(i) {
    set({ inputs: { ...get().inputs, refImages: get().inputs.refImages.filter((_, j) => j !== i) } })
  },

  showError(text) {
    clearTimeout(toastTimer)
    set({ toast: { kind: 'error', text } })
    toastTimer = setTimeout(() => set({ toast: null }), 7000)
  },
  showInfo(text) {
    clearTimeout(toastTimer)
    set({ toast: { kind: 'info', text } })
    toastTimer = setTimeout(() => set({ toast: null }), 3500)
  }
}))

export const activeProfile = (s: State) =>
  s.settings?.local.profiles.find((p) => p.id === s.settings?.local.activeProfileId) ?? null
