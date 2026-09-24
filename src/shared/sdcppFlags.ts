// sd-server launch flags (model loading / runtime). Per-generation parameters are
// sent through the native API instead. Source: examples/common/common.cpp.

export type FlagType = 'path' | 'dir' | 'string' | 'number' | 'bool' | 'enum'
export type FlagGroup = 'models' | 'encoders' | 'extras' | 'memory' | 'attention' | 'advanced'

export interface LaunchFlag {
  /** Flag name without leading dashes; also the key in LocalModelProfile.args. */
  id: string
  label: string
  type: FlagType
  group: FlagGroup
  help: string
  values?: string[]
  /** Shown in the simple profile editor. */
  common?: boolean
}

export const FLAG_GROUPS: { id: FlagGroup; label: string }[] = [
  { id: 'models', label: 'Model weights' },
  { id: 'encoders', label: 'Text / vision encoders' },
  { id: 'extras', label: 'LoRA, upscalers & extras' },
  { id: 'memory', label: 'Memory & devices' },
  { id: 'attention', label: 'Attention & kernels' },
  { id: 'advanced', label: 'Advanced' }
]

const MODEL_EXT = ['safetensors', 'gguf', 'ckpt', 'sft', 'bin', 'pt', 'pth']

export const MODEL_FILE_FILTERS = [{ name: 'Model weights', extensions: MODEL_EXT }]

export const SDCPP_LAUNCH_FLAGS: LaunchFlag[] = [
  // models
  { id: 'model', label: 'Full checkpoint', type: 'path', group: 'models', common: true, help: 'All-in-one checkpoint (SD1.x/SDXL/SD3 style). Leave empty when using a standalone diffusion model.' },
  { id: 'diffusion-model', label: 'Diffusion model', type: 'path', group: 'models', common: true, help: 'Standalone diffusion model (Flux, Qwen-Image, Z-Image, Wan, ...).' },
  { id: 'high-noise-diffusion-model', label: 'High-noise diffusion model', type: 'path', group: 'models', help: 'Standalone high-noise diffusion model (Wan 2.2 MoE).' },
  { id: 'uncond-diffusion-model', label: 'Unconditional diffusion model', type: 'path', group: 'models', help: 'Used by Ideogram4 CFG.' },
  { id: 'vae', label: 'VAE', type: 'path', group: 'models', common: true, help: 'Standalone VAE model.' },
  { id: 'vae-format', label: 'VAE format', type: 'enum', group: 'models', values: ['auto', 'flux', 'sd3', 'flux2', 'wan'], help: 'VAE latent format override (default: auto).' },
  { id: 'taesd', label: 'TAESD (tiny VAE)', type: 'path', group: 'models', help: 'Tiny AutoEncoder for fast, lower quality decoding.' },
  // encoders
  { id: 'llm', label: 'LLM text encoder', type: 'path', group: 'encoders', common: true, help: 'e.g. Qwen2.5-VL for Qwen-Image, Qwen3-VL for Qwen-Image 2.1, Mistral for Flux2, Qwen3 for Z-Image.' },
  { id: 'llm_vision', label: 'LLM vision (mmproj)', type: 'path', group: 'encoders', common: true, help: 'Vision tower for the LLM encoder. Required for image editing with GGUF encoders.' },
  { id: 'clip_l', label: 'CLIP-L', type: 'path', group: 'encoders', common: true, help: 'CLIP-L text encoder (Flux.1, SD3).' },
  { id: 'clip_g', label: 'CLIP-G', type: 'path', group: 'encoders', help: 'CLIP-G text encoder (SD3).' },
  { id: 't5xxl', label: 'T5-XXL', type: 'path', group: 'encoders', common: true, help: 'T5-XXL text encoder (Flux.1, SD3, Chroma).' },
  { id: 'clip_vision', label: 'CLIP vision', type: 'path', group: 'encoders', help: 'CLIP vision encoder (IP-Adapter, Wan i2v).' },
  { id: 'tokenizer', label: 'Tokenizer', type: 'string', group: 'encoders', help: 'tokenizer.json path or main=FILE,clip-l=FILE assignments (PiD, Lens).' },
  // extras
  { id: 'lora-model-dir', label: 'LoRA directory', type: 'dir', group: 'extras', common: true, help: 'LoRAs in this directory become selectable per generation.' },
  { id: 'hires-upscalers-dir', label: 'Upscaler directory', type: 'dir', group: 'extras', common: true, help: 'ESRGAN models for hires-fix and the Upscale tool (top level only).' },
  { id: 'upscale-model', label: 'Upscale model', type: 'path', group: 'extras', help: 'ESRGAN model.' },
  { id: 'embd-dir', label: 'Embeddings directory', type: 'dir', group: 'extras', help: 'Textual inversion embeddings.' },
  { id: 'control-net', label: 'ControlNet', type: 'path', group: 'extras', help: 'ControlNet model.' },
  { id: 'ip-adapter', label: 'IP-Adapter', type: 'path', group: 'extras', help: 'IP-Adapter model (requires CLIP vision).' },
  { id: 'photo-maker', label: 'PhotoMaker', type: 'path', group: 'extras', help: 'PhotoMaker model.' },
  { id: 'pulid-weights', label: 'PuLID weights', type: 'path', group: 'extras', help: 'PuLID Flux weights.' },
  // memory
  { id: 'offload-to-cpu', label: 'Offload to CPU', type: 'bool', group: 'memory', common: true, help: 'Keep weights in RAM and move them to VRAM when needed. Saves VRAM.' },
  { id: 'auto-fit', label: 'Auto-fit', type: 'enum', group: 'memory', values: ['on', 'off'], help: 'Place weights on GPU, RAM or disk according to available memory (default: on).' },
  { id: 'max-vram', label: 'Max VRAM (GiB)', type: 'string', group: 'memory', help: 'Per-device budget, e.g. 6 or cuda0=6,vulkan0=4. 0 = live free VRAM; negative reserves.' },
  { id: 'backend', label: 'Backend assignment', type: 'string', group: 'memory', help: 'e.g. cpu or clip=cpu,vae=cuda0,diffusion=vulkan0.' },
  { id: 'params-backend', label: 'Params backend', type: 'string', group: 'memory', help: 'e.g. disk, cpu, or diffusion=disk,clip=cpu.' },
  { id: 'split-mode', label: 'Split mode', type: 'string', group: 'memory', help: 'layer or row (CUDA), or per-module e.g. diffusion=row,te=layer.' },
  { id: 'rpc-servers', label: 'RPC servers', type: 'string', group: 'memory', help: 'host:port list for RPC offloading.' },
  { id: 'threads', label: 'Threads', type: 'number', group: 'memory', help: 'CPU threads (<= 0: physical cores).' },
  { id: 'mmap', label: 'Memory-map model', type: 'bool', group: 'memory', help: 'Memory-map model files.' },
  { id: 'eager-load', label: 'Eager load', type: 'bool', group: 'memory', help: 'Load all params at startup instead of on first use.' },
  { id: 'disable-prefetch', label: 'Disable prefetch', type: 'bool', group: 'memory', help: 'Disable async next-segment weight prefetch.' },
  { id: 'disable-segmented-compute', label: 'Disable segmented compute', type: 'bool', group: 'memory', help: 'Force monolithic graph execution.' },
  { id: 'conditioning-cache-size', label: 'Conditioning cache size', type: 'number', group: 'memory', help: 'Cached conditioning results per context (0 disables).' },
  // attention
  { id: 'fa', label: 'Flash attention (all)', type: 'bool', group: 'attention', common: true, help: 'Use flash attention everywhere.' },
  { id: 'diffusion-fa', label: 'Flash attention (diffusion only)', type: 'bool', group: 'attention', help: 'Use flash attention in the diffusion model only.' },
  { id: 'sage-attn', label: 'SageAttention', type: 'bool', group: 'attention', help: 'Native CUDA SageAttention in the diffusion model.' },
  { id: 'diffusion-conv-direct', label: 'Direct conv (diffusion)', type: 'bool', group: 'attention', help: 'Use ggml_conv2d_direct in the diffusion model.' },
  { id: 'vae-conv-direct', label: 'Direct conv (VAE)', type: 'bool', group: 'attention', help: 'Use direct convolutions in the VAE.' },
  { id: 'linear-scale', label: 'Linear scale', type: 'number', group: 'attention', help: 'Linear input scale override (0 = model default). Fixes black/NaN images on some GPUs.' },
  { id: 'attn-scale', label: 'Attention scale', type: 'number', group: 'attention', help: 'Flash-attention K/V scale override (0 = model default).' },
  // advanced
  { id: 'type', label: 'Weight type', type: 'enum', group: 'advanced', values: ['', 'f32', 'f16', 'bf16', 'q8_0', 'q6_K', 'q5_K', 'q5_0', 'q5_1', 'q4_K', 'q4_0', 'q4_1', 'q3_K', 'q2_K'], help: 'Convert weights on load. Empty = file type.' },
  { id: 'tensor-type-rules', label: 'Tensor type rules', type: 'string', group: 'advanced', help: 'Per-tensor weight types, e.g. ^vae\\.=f16,model\\.=q8_0' },
  { id: 'model-args', label: 'Model args', type: 'string', group: 'advanced', common: true, help: 'key=value list, e.g. qwen_image_zero_cond_t=true (Qwen-Image-Edit 2511), qwen_image_2_1_prefix_cache_type=q8_0.' },
  { id: 'prediction', label: 'Prediction type', type: 'enum', group: 'advanced', values: ['', 'eps', 'v', 'edm_v', 'sd3_flow', 'flux_flow', 'sefi_flow'], help: 'Prediction type override.' },
  { id: 'rng', label: 'RNG', type: 'enum', group: 'advanced', values: ['', 'std_default', 'cuda', 'cpu'], help: 'cuda matches sd-webui seeds, cpu matches ComfyUI.' },
  { id: 'sampler-rng', label: 'Sampler RNG', type: 'enum', group: 'advanced', values: ['', 'std_default', 'cuda', 'cpu'], help: 'Sampler RNG (defaults to RNG).' },
  { id: 'lora-apply-mode', label: 'LoRA apply mode', type: 'enum', group: 'advanced', values: ['auto', 'immediately', 'at_runtime'], help: 'auto uses at_runtime for quantized weights.' },
  { id: 'force-sdxl-vae-conv-scale', label: 'Force SDXL VAE conv scale', type: 'bool', group: 'advanced', help: 'Force conv scale on SDXL VAE.' }
]

export const FLAG_BY_ID = new Map(SDCPP_LAUNCH_FLAGS.map((f) => [f.id, f]))
