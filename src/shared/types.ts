// Shared contract between main, preload and renderer.

export type ProviderId = 'openrouter' | 'local'
export type UiMode = 'studio' | 'chat'

// ---------------------------------------------------------------------------
// Settings

export interface AppSettings {
  uiMode: UiMode
  /** Studio panel detail level: simple hides inpaint/hires/upscale/advanced sampling. */
  studioDetail: 'simple' | 'advanced'
  theme: 'dark' | 'light' | 'system'
  /** Directory where generated images + metadata are written. */
  outputDir: string
  openrouter: {
    /** True when an API key is stored (the key itself never leaves the main process). */
    hasApiKey: boolean
    defaultModel: string
  }
  huggingface: {
    /** True when a Hugging Face token is stored (the token itself never leaves the main process). */
    hasToken: boolean
  }
  local: {
    /**
     * Inference backend preference. 'auto' picks diffusers on NVIDIA GPUs
     * (Linux/Windows) and stable-diffusion.cpp everywhere else.
     */
    backend: BackendPreference
    /** Where Hugging Face downloads are stored (main-process dialog only). */
    modelsDir: string
    /** Selected engine variant id (see EngineVariant) or 'custom'. */
    engineVariant: string
    /** Used when engineVariant === 'custom': absolute path to an sd-server binary. */
    customServerPath: string
    activeProfileId: string | null
    listenPort: number
    profiles: LocalModelProfile[]
  }
}

// ---------------------------------------------------------------------------
// Local backends

/** stable-diffusion.cpp `sd-server`, or the bundled Python HF diffusers server. */
export type LocalBackendId = 'sdcpp' | 'diffusers'
export type BackendPreference = 'auto' | LocalBackendId

/**
 * A launch profile for a local backend. `args` maps a flag id to its value:
 * SDCPP_LAUNCH_FLAGS for 'sdcpp', DIFFUSERS_LAUNCH_FLAGS for 'diffusers'.
 * Booleans are switches.
 */
export interface LocalModelProfile {
  id: string
  name: string
  /** Backend this profile launches; absent means 'sdcpp' (profiles predating diffusers). */
  backend?: LocalBackendId
  /** Supported-model catalog entry this profile was created from, if any. */
  catalogId?: string
  args: Record<string, string | number | boolean>
  /** Raw extra CLI args appended verbatim (shell-like split, quotes supported). */
  extraArgs: string
}

export const profileBackend = (p: Pick<LocalModelProfile, 'backend'>): LocalBackendId => p.backend ?? 'sdcpp'

export interface GpuInfo {
  vendor: 'nvidia' | 'amd' | 'intel' | 'apple' | 'other'
  name: string
  /** Dedicated VRAM in MiB, null when unknown. */
  vramMiB: number | null
  driver?: string
}

export interface HardwareInfo {
  platform: string
  arch: string
  /** Total system RAM in MiB. */
  ramMiB: number
  gpus: GpuInfo[]
}

export interface BackendInfo {
  preference: BackendPreference
  /** What 'auto' resolves to on this machine. */
  autoChoice: LocalBackendId
  /** The backend in use: the override, or autoChoice. */
  effective: LocalBackendId
  /** Human-readable reason for autoChoice. */
  reason: string
  hardware: HardwareInfo
  /** False when the diffusers runtime cannot run on this platform at all (e.g. no CUDA wheels). */
  diffusersSupported: boolean
}

/** Managed Python environment (uv + venv + torch + diffusers) for the diffusers backend. */
export interface DiffusersRuntimeInfo {
  supported: boolean
  installed: boolean
  /** True when installed but resources/diffusers/requirements.txt changed since. */
  outdated: boolean
  pythonPath: string | null
  torchVersion?: string
  diffusersVersion?: string
  cudaAvailable?: boolean
  deviceName?: string
  /** Approximate disk use of the runtime, bytes. */
  sizeBytes?: number
}

export interface RuntimeInstallProgress {
  phase: 'uv' | 'python' | 'venv' | 'torch' | 'packages' | 'verify' | 'done' | 'error'
  message?: string
  /** One line of installer output (uv / pip). */
  log?: string
  received?: number
  total?: number
  error?: string
}

export type ServerState = 'stopped' | 'starting' | 'ready' | 'error'

export interface ServerStatus {
  state: ServerState
  profileId: string | null
  port: number | null
  error?: string
}

// ---------------------------------------------------------------------------
// stable-diffusion.cpp engine

export interface EngineVariant {
  id: string // e.g. "linux-vulkan", "win-cuda12", "custom-build"
  label: string
  platform: string
  /** Release asset name pattern, null for source builds. */
  assetPattern: string | null
  installed: boolean
  installedVersion?: string
  bundled: boolean
}

export interface EngineInfo {
  variants: EngineVariant[]
  latestVersion?: string
  /** Resolved sd-server path that will be launched, or null if none available. */
  serverPath: string | null
}

export interface EngineInstallProgress {
  variantId: string
  phase: 'downloading' | 'extracting' | 'done' | 'error'
  received?: number
  total?: number
  error?: string
}

/**
 * Subset of GET /sdcpp/v1/capabilities we rely on (unknown fields kept). The
 * diffusers server answers the same endpoint with `backend: 'diffusers'`.
 */
export interface SdCapabilities {
  /** Absent for sd-server (implies 'sdcpp'). */
  backend?: LocalBackendId
  /** diffusers only: loaded pipeline class and per-request knobs it honours. */
  diffusers?: {
    pipeline: string
    /** Request fields the pipeline honours, e.g. "negative_prompt", "txt_cfg", "distilled_guidance", "ref_images". */
    supports: string[]
    device: string
    dtype: string
  }
  model: { name: string; stem: string; path: string }
  supported_modes: string[]
  defaults_by_mode: { img_gen?: SdImgGenBody; [mode: string]: unknown }
  output_formats_by_mode: Record<string, string[]>
  features_by_mode: { img_gen?: Record<string, boolean>; [mode: string]: unknown }
  samplers: string[]
  schedulers: string[]
  loras: { name: string; path: string }[]
  upscalers: { name: string; model: boolean; image_upscale: boolean }[]
  upscale: boolean
  limits: {
    min_width: number
    max_width: number
    min_height: number
    max_height: number
    max_batch_count: number
    max_queue_size: number
    max_upscale_width: number
    max_upscale_height: number
  }
  [k: string]: unknown
}

/** Native sd-server img_gen request body (POST /sdcpp/v1/img_gen). All optional; server defaults apply. */
export interface SdImgGenBody {
  prompt?: string
  negative_prompt?: string
  clip_skip?: number
  width?: number
  height?: number
  strength?: number
  seed?: number
  batch_count?: number
  ref_image_args?: string
  image_preprocess?: string | string[]
  increase_ref_index?: boolean
  control_strength?: number
  ip_adapter_strength?: number
  embed_image_metadata?: boolean
  init_image?: string | null
  ref_images?: string[]
  mask_image?: string | null
  control_image?: string | null
  ip_adapter_image?: string | null
  sample_params?: {
    scheduler?: string
    sample_method?: string
    sample_steps?: number
    eta?: number | null
    shifted_timestep?: number
    custom_sigmas?: number[]
    flow_shift?: number | null
    guidance?: {
      txt_cfg?: number
      img_cfg?: number | null
      distilled_guidance?: number
      slg?: { layers?: number[]; layer_start?: number; layer_end?: number; scale?: number }
    }
  }
  lora?: { path: string; multiplier: number; is_high_noise?: boolean }[]
  hires?: {
    enabled?: boolean
    upscaler?: string
    scale?: number
    target_width?: number
    target_height?: number
    steps?: number
    denoising_strength?: number
    custom_sigmas?: number[]
    upscale_tile_size?: number
  }
  vae_tiling_params?: {
    enabled?: boolean
    temporal_tiling?: boolean
    tile_size_x?: number
    tile_size_y?: number
    target_overlap?: number
    rel_size_x?: number
    rel_size_y?: number
    extra_tiling_args?: string
  }
  cache_mode?: string
  cache_option?: string
  scm_mask?: string
  scm_policy_dynamic?: boolean
  output_format?: string
  output_compression?: number
}

// ---------------------------------------------------------------------------
// Hugging Face

export type HfGated = false | 'auto' | 'manual'

export interface HfModelSummary {
  id: string
  author?: string
  downloads: number
  likes: number
  lastModified?: string
  tags: string[]
  pipelineTag?: string
  libraryName?: string
  gated: HfGated
}

export interface HfSearchOptions {
  query: string
  /** 'gguf' → repos tagged gguf; 'diffusers' → diffusers-format repos; 'all' → no format filter. */
  format: 'gguf' | 'diffusers' | 'all'
  /** 'text-to-image' | 'image-to-image' | null for any. */
  task?: string | null
  sort?: 'downloads' | 'likes' | 'lastModified' | 'trendingScore'
  limit?: number
}

export interface HfFile {
  /** Path inside the repo, '/'-separated. */
  path: string
  size: number
  /** LFS sha256, when the file is stored in LFS/Xet. */
  sha256?: string
}

export type HfRepoKind = 'diffusers' | 'gguf' | 'single-file' | 'other'

/** GGUF files of one quantization level (split files are grouped together). */
export interface HfQuantGroup {
  /** e.g. "Q4_K_M", "UD-Q4_K_XL", "Q8_0", "BF16". */
  quant: string
  /** Approximate bits per weight, null when unknown. */
  bits: number | null
  files: HfFile[]
  totalBytes: number
  /** Common file stem without the quant suffix, distinguishes several models in one repo (e.g. mmproj). */
  stem: string
}

export interface HfRepoDetails {
  id: string
  /** Commit sha the file list was read at; downloads pin to it. */
  sha: string
  kind: HfRepoKind
  gated: HfGated
  files: HfFile[]
  quants: HfQuantGroup[]
  totalBytes: number
  cardExcerpt?: string
  pipelineTag?: string
  license?: string
  /** diffusers repos: the files needed to load the pipeline locally (safetensors weights only). */
  pipelineFiles?: { all: string[]; withoutTransformer: string[] }
}

export interface HfDownloadRequest {
  repo: string
  /** Commit sha or branch; default 'main'. */
  revision?: string
  /** Repo paths to fetch. */
  files: string[]
}

export type HfDownloadState = 'queued' | 'downloading' | 'verifying' | 'done' | 'error' | 'cancelled'

export interface HfDownloadProgress {
  downloadId: string
  repo: string
  state: HfDownloadState
  /** File currently transferring. */
  file?: string
  filesDone: number
  filesTotal: number
  bytesDone: number
  bytesTotal: number
  /** Bytes per second, smoothed. */
  speed?: number
  error?: string
  /** Set when the download belongs to a catalog install. */
  catalogId?: string
}

export interface HfLocalFile {
  path: string
  size: number
  /** Absolute path on disk. */
  absPath: string
}

export interface HfLocalRepo {
  repo: string
  /** Absolute repo directory. */
  dir: string
  files: HfLocalFile[]
  totalBytes: number
  kind: HfRepoKind
}

/** Install one supported model for one backend: downloads every component, then creates a profile. */
export interface CatalogInstallRequest {
  catalogId: string
  backend: LocalBackendId
  /** Chosen quant per component id (components with quant choices only). */
  quants: Record<string, string>
}

// ---------------------------------------------------------------------------
// OpenRouter

export type OrParamSpec =
  | { type: 'enum'; values: string[] }
  | { type: 'range'; min: number; max: number }
  | { type: 'boolean' }

export interface OrImageModel {
  id: string
  name: string
  description?: string
  created?: number
  architecture?: { input_modalities: string[]; output_modalities: string[] }
  /** Keys such as resolution, aspect_ratio, quality, background, n, input_references, seed, output_format, output_compression. */
  supported_parameters: Record<string, OrParamSpec>
  supports_streaming?: boolean
}

/** Body for POST https://openrouter.ai/api/v1/images (minus model/prompt/input_references, which come from the request). */
export interface OrImageParams {
  n?: number
  resolution?: string
  aspect_ratio?: string
  size?: string
  quality?: string
  output_format?: string
  background?: string
  output_compression?: number
  seed?: number
}

// ---------------------------------------------------------------------------
// Generation

export interface GenerationInputs {
  /** Reference images for edit/multi-ref models (data URLs). Used by both providers. */
  refImages: string[]
  /** Local img2img / inpaint init image (data URL). */
  initImage?: string
  /** Local inpaint mask (data URL, white = repaint). */
  maskImage?: string
}

export interface GenerationRequest {
  provider: ProviderId
  prompt: string
  negativePrompt?: string
  inputs: GenerationInputs
  /** For provider 'openrouter'. */
  openrouter?: {
    model: string
    params: OrImageParams
    /** Extra request-body keys merged after params; model/prompt/input_references cannot be overridden. */
    extra?: Record<string, unknown>
  }
  /** For provider 'local'. prompt/negative/images are filled from the top-level fields. */
  local?: SdImgGenBody
  /** Optional chat thread this generation belongs to. */
  threadId?: string
}

export interface GenerationProgress {
  jobId: string
  stage: 'queued' | 'loading' | 'sampling' | 'decoding' | 'uploading' | 'waiting' | 'done'
  step?: number
  totalSteps?: number
  /** Seconds per iteration or similar, human readable. */
  speed?: string
  message?: string
}

export interface HistoryItem {
  id: string
  createdAt: number
  provider: ProviderId
  /** OpenRouter model id or local profile name + model stem. */
  model: string
  prompt: string
  negativePrompt?: string
  /** Full request params as sent (images stripped to file names). */
  params: Record<string, unknown>
  /** Absolute file paths of outputs. */
  files: string[]
  /** Absolute file paths of input images saved alongside. */
  inputFiles: string[]
  width?: number
  height?: number
  seed?: number
  costUsd?: number
  durationMs: number
  threadId?: string
  kind: 'generate' | 'upscale'
  parentId?: string
}

export type GenerationResult =
  | { ok: true; jobId: string; item: HistoryItem }
  | { ok: false; jobId: string; error: string; cancelled?: boolean }

export interface UpscaleRequest {
  historyId: string
  fileIndex: number
  upscaler?: string
  repeats?: number
  tileSize?: number
}

export interface ChatThread {
  id: string
  title: string
  createdAt: number
  updatedAt: number
}

// ---------------------------------------------------------------------------
// Preload API exposed as window.api

export interface StudioApi {
  /** Build-time edition: 'slim' has no local sd.cpp engine, 'full' has both providers. */
  readonly edition: 'full' | 'slim'
  settings: {
    get(): Promise<AppSettings>
    update(patch: DeepPartial<AppSettings>): Promise<AppSettings>
    setOpenRouterKey(key: string | null): Promise<void>
    /** Main-process dialogs; these paths cannot be set via update(). Resolve null when cancelled. */
    chooseOutputDir(): Promise<AppSettings | null>
    chooseServerBinary(): Promise<AppSettings | null>
    pickPath(opts: { kind: 'file' | 'directory'; title?: string; filters?: { name: string; extensions: string[] }[] }): Promise<string | null>
    /** Settings changed by the main process itself (e.g. a catalog install added a profile). */
    onChanged(cb: (s: AppSettings) => void): () => void
  }
  openrouter: {
    listModels(force?: boolean): Promise<OrImageModel[]>
    /** Account credits, null when unavailable. */
    credits(): Promise<{ total: number; used: number } | null>
  }
  engine: {
    info(): Promise<EngineInfo>
    install(variantId: string): Promise<void>
    onInstallProgress(cb: (p: EngineInstallProgress) => void): () => void
  }
  backend: {
    /** Hardware probe + auto choice. `refresh` re-runs the GPU probe. */
    info(refresh?: boolean): Promise<BackendInfo>
  }
  diffusers: {
    info(): Promise<DiffusersRuntimeInfo>
    install(): Promise<void>
    remove(): Promise<void>
    onInstallProgress(cb: (p: RuntimeInstallProgress) => void): () => void
  }
  hf: {
    setToken(token: string | null): Promise<void>
    search(opts: HfSearchOptions): Promise<HfModelSummary[]>
    repo(id: string): Promise<HfRepoDetails>
    /** Queues a download; resolves with its id immediately. */
    download(req: HfDownloadRequest): Promise<string>
    cancel(downloadId: string): Promise<void>
    downloads(): Promise<HfDownloadProgress[]>
    onProgress(cb: (p: HfDownloadProgress) => void): () => void
    local(): Promise<HfLocalRepo[]>
    removeLocal(repo: string): Promise<void>
    revealLocal(repo: string): Promise<void>
    chooseModelsDir(): Promise<AppSettings | null>
  }
  catalog: {
    /**
     * Starts downloading a supported model; a profile is created when every
     * file is present. Resolves with the install key that tags its downloads
     * (HfDownloadProgress.catalogId).
     */
    install(req: CatalogInstallRequest): Promise<string>
  }
  local: {
    status(): Promise<ServerStatus>
    start(profileId: string): Promise<ServerStatus>
    stop(): Promise<ServerStatus>
    capabilities(): Promise<SdCapabilities | null>
    logs(): Promise<string[]>
    onStatus(cb: (s: ServerStatus) => void): () => void
    onLog(cb: (line: string) => void): () => void
    listDevices(): Promise<string[]>
  }
  gen: {
    /** Starts a generation; resolves when finished. jobId is chosen by the caller. */
    run(jobId: string, req: GenerationRequest): Promise<GenerationResult>
    cancel(jobId: string): Promise<void>
    upscale(jobId: string, req: UpscaleRequest): Promise<GenerationResult>
    onProgress(cb: (p: GenerationProgress) => void): () => void
  }
  history: {
    list(opts?: { threadId?: string; limit?: number; before?: number }): Promise<HistoryItem[]>
    remove(id: string): Promise<void>
    reveal(path: string): Promise<void>
    /** Read an image file from history as a data URL (for re-use as input). */
    readAsDataUrl(path: string): Promise<string>
    threads(): Promise<ChatThread[]>
    createThread(title: string): Promise<ChatThread>
    renameThread(id: string, title: string): Promise<void>
    deleteThread(id: string): Promise<void>
  }
}

export type DeepPartial<T> = T extends (infer U)[]
  ? U[]
  : T extends object
    ? { [K in keyof T]?: DeepPartial<T[K]> }
    : T

/** Images on disk are shown via this protocol: studio-img://local/<encodeURIComponent(absPath)> */
export const IMG_PROTOCOL = 'studio-img'
export const imgUrl = (absPath: string): string => `${IMG_PROTOCOL}://local/${encodeURIComponent(absPath)}`
