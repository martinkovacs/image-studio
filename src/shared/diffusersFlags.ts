// Launch flags of the bundled diffusers server (resources/diffusers/server.py).
// Same LaunchFlag shape as the sd-server table so the profile editor renders
// both. The Python side re-validates every value (pipeline allow-list, paths).
import type { LaunchFlag } from './sdcppFlags'

/**
 * Pipeline classes the diffusers server is allowed to instantiate. Keep in sync
 * with PIPELINES in resources/diffusers/server.py.
 */
export const DIFFUSERS_PIPELINES = ['QwenImagePipeline', 'QwenImageEditPlusPipeline', 'Flux2Pipeline', 'Flux2KleinPipeline'] as const
export type DiffusersPipeline = (typeof DIFFUSERS_PIPELINES)[number]

export const DIFFUSERS_LAUNCH_FLAGS: LaunchFlag[] = [
  // models
  { id: 'pipeline', label: 'Pipeline', type: 'enum', group: 'models', common: true, values: [...DIFFUSERS_PIPELINES], help: 'diffusers pipeline class for this model family.' },
  { id: 'model', label: 'Model folder', type: 'dir', group: 'models', common: true, help: 'Local diffusers-format repo (contains model_index.json).' },
  { id: 'transformer-gguf', label: 'Transformer GGUF', type: 'path', group: 'models', common: true, help: 'Optional quantized transformer (GGUF) that replaces the folder’s transformer/ weights.' },
  // extras
  { id: 'lora', label: 'LoRA', type: 'path', group: 'extras', common: true, help: 'LoRA (.safetensors) fused at load, e.g. a Turbo/Flash distillation LoRA.' },
  { id: 'lora-scale', label: 'LoRA scale', type: 'number', group: 'extras', help: 'LoRA strength (default 1).' },
  // memory
  { id: 'offload', label: 'CPU offload', type: 'enum', group: 'memory', common: true, values: ['none', 'model', 'sequential'], help: 'model: move whole components to the GPU on use (moderate VRAM). sequential: stream layers (lowest VRAM, slowest).' },
  { id: 'text-encoder-quant', label: 'Text encoder quantization', type: 'enum', group: 'memory', common: true, values: ['none', '8bit', '4bit'], help: 'Quantize the text encoder on load with bitsandbytes. Saves several GB of VRAM.' },
  { id: 'vae-tiling', label: 'VAE tiling', type: 'bool', group: 'memory', help: 'Decode in tiles; needed for very large images on small GPUs.' },
  { id: 'device', label: 'Device', type: 'string', group: 'memory', help: 'Torch device, e.g. cuda or cuda:1 (default cuda).' },
  // advanced
  { id: 'dtype', label: 'Compute dtype', type: 'enum', group: 'advanced', values: ['bfloat16', 'float16'], help: 'bfloat16 needs an RTX 30xx or newer.' }
]

export const DIFFUSERS_FLAG_BY_ID = new Map(DIFFUSERS_LAUNCH_FLAGS.map((f) => [f.id, f]))
