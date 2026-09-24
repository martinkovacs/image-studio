// Quick-start profile templates: which file slots matter per model family plus
// safe launch flags. Sampling values are shown as notes only; the per-generation
// defaults come from sd.cpp itself once the model is loaded.

export interface ProfileTemplate {
  id: string
  label: string
  slots: string[]
  args: Record<string, string | number | boolean>
  note: string
}

export const PROFILE_TEMPLATES: ProfileTemplate[] = [
  {
    id: 'qwen-image-2.1',
    label: 'Qwen-Image 2.1',
    slots: ['diffusion-model', 'vae', 'llm', 'llm_vision'],
    args: { fa: true, 'offload-to-cpu': true },
    note: 'VAE: qwen_image_2.1_vae_bf16.safetensors (not interchangeable with Qwen-Image 1 VAE). Encoder: Qwen3-VL-8B-Instruct; add its mmproj as LLM vision for editing. Dimensions divisible by 32, up to 2048/side. Recommended (Unsloth, sd.cpp): cfg 6, euler, 20 steps, flow shift automatic.'
  },
  {
    id: 'qwen-image-edit-2511',
    label: 'Qwen-Image-Edit 2511',
    slots: ['diffusion-model', 'vae', 'llm', 'llm_vision'],
    args: { 'model-args': 'qwen_image_zero_cond_t=true', 'diffusion-fa': true, 'offload-to-cpu': true },
    note: 'VAE: qwen_image_vae.safetensors. Encoder: Qwen2.5-VL-7B (+ mmproj). qwen_image_zero_cond_t=true is required for 2511. Typical: cfg 2.5, flow shift 3, euler.'
  },
  {
    id: 'qwen-image',
    label: 'Qwen-Image / Edit 2509',
    slots: ['diffusion-model', 'vae', 'llm', 'llm_vision'],
    args: { 'diffusion-fa': true, 'offload-to-cpu': true },
    note: 'VAE: qwen_image_vae.safetensors. Encoder: Qwen2.5-VL-7B (+ mmproj for editing). Typical: cfg 2.5, flow shift 3, euler.'
  },
  {
    id: 'flux1',
    label: 'Flux.1 (dev / schnell / Kontext)',
    slots: ['diffusion-model', 'vae', 'clip_l', 't5xxl'],
    args: { 'diffusion-fa': true },
    note: 'VAE: ae.safetensors. cfg 1. dev: distilled guidance 3.5, ~20–28 steps. schnell: 4 steps. Kontext edits via reference images.'
  },
  {
    id: 'flux2',
    label: 'Flux.2',
    slots: ['diffusion-model', 'vae', 'llm'],
    args: { 'diffusion-fa': true, 'offload-to-cpu': true },
    note: 'Encoder: Mistral-Small 3.2 (dev) or Qwen3 (klein). Supports multi-reference editing.'
  },
  {
    id: 'z-image',
    label: 'Z-Image Turbo',
    slots: ['diffusion-model', 'vae', 'llm'],
    args: { 'diffusion-fa': true },
    note: 'VAE: ae.safetensors. Encoder: Qwen3-4B. Turbo: cfg 1, ~8 steps.'
  },
  {
    id: 'sd-checkpoint',
    label: 'SD 1.x / SDXL checkpoint',
    slots: ['model', 'vae'],
    args: {},
    note: 'All-in-one checkpoint; a separate VAE is optional (e.g. sdxl_vae fp16-fix). SDXL: 1024², cfg 5–7, 25–35 steps. Negative prompts apply.'
  }
]
