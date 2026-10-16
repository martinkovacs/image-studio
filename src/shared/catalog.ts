// Supported local models: the open-weights models scoring >= 1000 Elo on the
// Artificial Analysis image-editing leaderboard
// (https://artificialanalysis.ai/image/leaderboard/editing?open-weights=true,
// checked 2026-10-16) that at least one local backend can run.
//
// Excluded from that list:
//   - HunyuanImage 3.0 Instruct (1064): an 80B MoE (~169 GB) loaded through
//     custom transformers code. No diffusers pipeline, no sd.cpp support.
//   - FLUX.2 [dev] Flash (1014): fal hosts it as an API only; no public weights.
//
// Each recipe lists the files to fetch from Hugging Face and the launch args
// they map to. Quantized files are chosen at install time from the repo's
// file list (see groupQuants), so new quants appear without code changes.
import type { LocalBackendId, SdImgGenBody } from './types'
import type { DiffusersPipeline } from './diffusersFlags'

export type CatalogComponent =
  /** One GGUF quant from a repo (all shards of it). `stem` picks one model in multi-model repos. */
  | {
      id: string
      kind: 'gguf'
      label: string
      /** Launch flag the downloaded file is assigned to. */
      slot: string
      repo: string
      stem?: string
      defaultQuant: string
      /**
       * When set, the quant picker offers 'original' (this label): no GGUF is
       * downloaded and the slot stays empty, so the diffusers folder's own
       * transformer/ weights are used instead.
       */
      originalLabel?: string
    }
  /** A single file. */
  | { id: string; kind: 'file'; label: string; slot: string; repo: string; path: string }
  /**
   * A diffusers-format repo (safetensors only). transformer/ is skipped when a
   * GGUF component with `originalLabel` has a quant other than 'original'.
   */
  | { id: string; kind: 'diffusers'; label: string; slot: string; repo: string }

export interface CatalogRecipe {
  components: CatalogComponent[]
  /**
   * Launch args merged into the created profile (file slots are filled from
   * components). Flash attention / direct convolutions are left to sd.cpp's
   * per-module auto selection (master-962+).
   */
  args: Record<string, string | number | boolean>
  /** Per-generation defaults applied the first time the model is loaded. */
  defaults: SdImgGenBody
  /** True when a component repo requires accepting a licence on huggingface.co (needs a token). */
  gated?: boolean
  note: string
}

export interface CatalogModel {
  id: string
  label: string
  creator: string
  /** Artificial Analysis image-editing Elo. */
  elo: number
  licence: string
  licenceUrl: string
  /** Max reference images for editing, when documented. */
  maxRefImages?: number
  description: string
  recipes: Partial<Record<LocalBackendId, CatalogRecipe>>
}

const pipeline = (p: DiffusersPipeline): string => p

const QWEN21_VAE: CatalogComponent = {
  id: 'vae', kind: 'file', label: 'VAE', slot: 'vae', repo: 'Comfy-Org/Qwen-Image-2.1', path: 'vae/qwen_image_2.1_vae_bf16.safetensors'
}
const QWEN3VL_LLM: CatalogComponent = {
  id: 'llm', kind: 'gguf', label: 'Text encoder (Qwen3-VL 8B)', slot: 'llm', repo: 'unsloth/Qwen3-VL-8B-Instruct-GGUF', stem: 'Qwen3-VL-8B-Instruct', defaultQuant: 'UD-Q4_K_XL'
}
const QWEN3VL_MMPROJ: CatalogComponent = {
  id: 'llm_vision', kind: 'file', label: 'Vision projector (editing)', slot: 'llm_vision', repo: 'unsloth/Qwen3-VL-8B-Instruct-GGUF', path: 'mmproj-F16.gguf'
}
const FLUX2_VAE: CatalogComponent = {
  id: 'vae', kind: 'file', label: 'VAE', slot: 'vae', repo: 'Comfy-Org/flux2-dev', path: 'split_files/vae/flux2-vae.safetensors'
}
const MISTRAL_LLM: CatalogComponent = {
  id: 'llm', kind: 'gguf', label: 'Text encoder (Mistral Small 3.2 24B)', slot: 'llm', repo: 'unsloth/Mistral-Small-3.2-24B-Instruct-2506-GGUF', stem: 'Mistral-Small-3.2-24B-Instruct-2506', defaultQuant: 'Q4_K_M'
}
const FLUX2_DEV_BNB: CatalogComponent = {
  id: 'model', kind: 'diffusers', label: 'FLUX.2 [dev] (diffusers, 4-bit)', slot: 'model', repo: 'diffusers/FLUX.2-dev-bnb-4bit'
}

/** fal's pre-shifted 8-step schedule for the FLUX.2 [dev] Turbo LoRA (model card). */
export const FLUX2_TURBO_SIGMAS = [1.0, 0.6509, 0.4374, 0.2932, 0.1893, 0.1108, 0.0495, 0.00031]
/** sd.cpp's `--sigmas qwen-image-2.1-turbo` preset. */
export const QWEN21_TURBO_SIGMAS = [1.0, 0.978453, 0.95418, 0.926626, 0.89508, 0.845148, 0.704534, 0.414568, 0.0]

const QWEN_LICENCE = 'Qwen Research License (non-commercial)'
const FLUX_LICENCE = 'FLUX [dev] Non-Commercial License'
const FLUX_LICENCE_URL = 'https://huggingface.co/black-forest-labs/FLUX.2-dev/blob/main/LICENSE.txt'

export const CATALOG: CatalogModel[] = [
  {
    id: 'qwen-image-2.1',
    label: 'Qwen-Image 2.1',
    creator: 'Alibaba',
    elo: 1083,
    licence: QWEN_LICENCE,
    licenceUrl: 'https://huggingface.co/Qwen/Qwen-Image-2.1',
    maxRefImages: 10,
    description: 'Highest-rated open editing model. Text-to-image and multi-reference editing (up to 10 images), strong text rendering.',
    recipes: {
      sdcpp: {
        components: [
          { id: 'diffusion', kind: 'gguf', label: 'Diffusion model', slot: 'diffusion-model', repo: 'unsloth/Qwen-Image-2.1-GGUF', stem: 'qwen-image-2.1', defaultQuant: 'Q4_K_M' },
          QWEN21_VAE,
          QWEN3VL_LLM,
          QWEN3VL_MMPROJ
        ],
        args: { 'offload-to-cpu': true },
        defaults: { sample_params: { sample_steps: 20, sample_method: 'euler', guidance: { txt_cfg: 6 } } },
        note: 'cfg 6, euler, 20 steps, flow shift automatic. Dimensions divisible by 32; the model card lists sizes up to 2752 per side.'
      },
      diffusers: {
        components: [
          { id: 'model', kind: 'diffusers', label: 'Pipeline (text encoder, VAE, processor)', slot: 'model', repo: 'Qwen/Qwen-Image-2.1' },
          { id: 'transformer', kind: 'gguf', label: 'Transformer', slot: 'transformer-gguf', repo: 'unsloth/Qwen-Image-2.1-GGUF', stem: 'qwen-image-2.1', defaultQuant: 'Q8_0', originalLabel: 'BF16 (original, 14 GB)' }
        ],
        args: { pipeline: pipeline('QwenImage21Pipeline'), offload: 'model', 'text-encoder-quant': 'none', dtype: 'bfloat16' },
        defaults: { sample_params: { sample_steps: 40, guidance: { txt_cfg: 1 } } },
        note: '40 steps, CFG 1 (set CFG > 1 together with a negative prompt to enable true CFG). The Qwen3-VL text encoder is 17.5 GB in bf16; use 8-bit text-encoder quantization on GPUs under 24 GB.'
      }
    }
  },
  {
    id: 'qwen-image-2.1-turbo',
    label: 'Qwen-Image 2.1 Turbo',
    creator: 'Alibaba',
    elo: 1063,
    licence: QWEN_LICENCE,
    licenceUrl: 'https://huggingface.co/Qwen/Qwen-Image-2.1-Turbo',
    maxRefImages: 10,
    description: 'Official 8-step distilled checkpoint of Qwen-Image 2.1. About 5× faster at similar quality.',
    recipes: {
      sdcpp: {
        components: [
          { id: 'diffusion', kind: 'gguf', label: 'Diffusion model', slot: 'diffusion-model', repo: 'unsloth/Qwen-Image-2.1-Turbo-GGUF', stem: 'qwen-image-2.1-turbo', defaultQuant: 'Q4_K_M' },
          QWEN21_VAE,
          QWEN3VL_LLM,
          QWEN3VL_MMPROJ
        ],
        args: { 'offload-to-cpu': true },
        defaults: { sample_params: { sample_steps: 8, sample_method: 'euler', custom_sigmas: QWEN21_TURBO_SIGMAS, guidance: { txt_cfg: 1 } } },
        note: '8 steps, cfg 1, euler with the qwen-image-2.1-turbo sigma schedule (pre-filled as custom sigmas).'
      },
      diffusers: {
        components: [
          { id: 'model', kind: 'diffusers', label: 'Pipeline (text encoder, VAE, processor)', slot: 'model', repo: 'Qwen/Qwen-Image-2.1-Turbo' },
          { id: 'transformer', kind: 'gguf', label: 'Transformer', slot: 'transformer-gguf', repo: 'unsloth/Qwen-Image-2.1-Turbo-GGUF', stem: 'qwen-image-2.1-turbo', defaultQuant: 'Q8_0', originalLabel: 'BF16 (original, 14 GB)' }
        ],
        args: { pipeline: pipeline('QwenImage21Pipeline'), offload: 'model', 'text-encoder-quant': 'none', dtype: 'bfloat16' },
        defaults: { sample_params: { sample_steps: 8, guidance: { txt_cfg: 1 } } },
        note: '8 steps, CFG 1. The sampling schedule ships with the checkpoint.'
      }
    }
  },
  {
    id: 'flux2-dev-turbo',
    label: 'FLUX.2 [dev] Turbo',
    creator: 'fal · Black Forest Labs',
    elo: 1017,
    licence: FLUX_LICENCE,
    licenceUrl: FLUX_LICENCE_URL,
    description: 'fal’s 8-step distillation LoRA on top of FLUX.2 [dev]. Text-to-image and multi-reference editing.',
    recipes: {
      diffusers: {
        components: [
          FLUX2_DEV_BNB,
          { id: 'lora', kind: 'file', label: 'Turbo LoRA', slot: 'lora', repo: 'fal/FLUX.2-dev-Turbo', path: 'flux.2-turbo-lora.safetensors' }
        ],
        args: { pipeline: pipeline('Flux2Pipeline'), offload: 'model', dtype: 'bfloat16' },
        defaults: { sample_params: { sample_steps: 8, custom_sigmas: FLUX2_TURBO_SIGMAS, guidance: { txt_cfg: 2.5 } } },
        note: '8 steps, guidance 2.5 with fal’s pre-shifted sigmas (pre-filled). Uses the 4-bit diffusers build of FLUX.2 [dev] (~34 GB on disk).'
      }
    }
  },
  {
    id: 'flux2-klein-9b',
    label: 'FLUX.2 [klein] 9B',
    creator: 'Black Forest Labs',
    elo: 1015,
    licence: FLUX_LICENCE,
    licenceUrl: 'https://huggingface.co/black-forest-labs/FLUX.2-klein-9B',
    description: 'Compact 4-step FLUX.2 with a Qwen3 8B text encoder. Fast text-to-image and reference editing.',
    recipes: {
      sdcpp: {
        components: [
          { id: 'diffusion', kind: 'gguf', label: 'Diffusion model', slot: 'diffusion-model', repo: 'leejet/FLUX.2-klein-9B-GGUF', defaultQuant: 'Q8_0' },
          { id: 'vae', kind: 'file', label: 'VAE', slot: 'vae', repo: 'Comfy-Org/vae-text-encorder-for-flux-klein-9b', path: 'split_files/vae/flux2-vae.safetensors' },
          { id: 'llm', kind: 'gguf', label: 'Text encoder (Qwen3 8B)', slot: 'llm', repo: 'unsloth/Qwen3-8B-GGUF', stem: 'Qwen3-8B', defaultQuant: 'Q4_K_M' }
        ],
        args: { 'offload-to-cpu': true },
        defaults: { sample_params: { sample_steps: 4, sample_method: 'euler', guidance: { txt_cfg: 1 } } },
        note: '4 steps, cfg 1, euler.'
      },
      diffusers: {
        gated: true,
        components: [
          { id: 'model', kind: 'diffusers', label: 'Pipeline (text encoder, VAE, tokenizer)', slot: 'model', repo: 'black-forest-labs/FLUX.2-klein-9B' },
          { id: 'transformer', kind: 'gguf', label: 'Transformer', slot: 'transformer-gguf', repo: 'leejet/FLUX.2-klein-9B-GGUF', defaultQuant: 'Q8_0', originalLabel: 'BF16 (original, 18 GB)' }
        ],
        args: { pipeline: pipeline('Flux2KleinPipeline'), offload: 'model', 'text-encoder-quant': 'none', dtype: 'bfloat16' },
        defaults: { sample_params: { sample_steps: 4, guidance: { txt_cfg: 1 } } },
        note: '4 steps; guidance is ignored by the distilled model. The base repo is gated: accept the licence on huggingface.co and add a token.'
      }
    }
  },
  {
    id: 'flux2-dev',
    label: 'FLUX.2 [dev]',
    creator: 'Black Forest Labs',
    elo: 1000,
    licence: FLUX_LICENCE,
    licenceUrl: FLUX_LICENCE_URL,
    description: '32B flagship FLUX.2 with a Mistral Small 3.2 text encoder. Text-to-image and multi-reference editing.',
    recipes: {
      sdcpp: {
        components: [
          { id: 'diffusion', kind: 'gguf', label: 'Diffusion model', slot: 'diffusion-model', repo: 'unsloth/FLUX.2-dev-GGUF', stem: 'flux2-dev', defaultQuant: 'Q4_K_M' },
          FLUX2_VAE,
          MISTRAL_LLM
        ],
        args: { 'offload-to-cpu': true },
        defaults: { sample_params: { sample_steps: 28, sample_method: 'euler', guidance: { txt_cfg: 1, distilled_guidance: 4 } } },
        note: '~28 steps, cfg 1, distilled guidance 4, euler.'
      },
      diffusers: {
        components: [FLUX2_DEV_BNB],
        args: { pipeline: pipeline('Flux2Pipeline'), offload: 'model', dtype: 'bfloat16' },
        defaults: { sample_params: { sample_steps: 28, guidance: { txt_cfg: 4 } } },
        note: '28 steps (50 for best quality), guidance 4. Uses the 4-bit diffusers build (~34 GB on disk).'
      }
    }
  }
]

export const CATALOG_BY_ID = new Map(CATALOG.map((m) => [m.id, m]))

/** Catalog ids are stable; the install key groups the downloads of one install. */
export const catalogInstallKey = (catalogId: string, backend: LocalBackendId): string => `${catalogId}:${backend}`
