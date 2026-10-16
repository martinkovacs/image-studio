# Image Studio

Electron image generation & editing studio. Two providers: **OpenRouter** (cloud) and **local** — with two local backends, like Unsloth Studio: Hugging Face **diffusers** on NVIDIA GPUs and **stable-diffusion.cpp** everywhere else.

- **Studio UI** (default): generation / edit / inpaint panels with a simple and an advanced detail level.
- **Chat UI** (optional): threaded conversational interface; toggle in **Settings → General**.

Providers:

- **OpenRouter** — Unified Image API: `POST /api/v1/images` for generation, `GET /api/v1/images/models` for the model list.
- **Local** — a local server spawned from a launch profile and driven through stable-diffusion.cpp's native async API (`POST /sdcpp/v1/img_gen`). The backend is either sd.cpp's own `sd-server` or the bundled diffusers server (`resources/diffusers/server.py`), which speaks the same API.

## Local backends

| | diffusers | stable-diffusion.cpp |
| --- | --- | --- |
| Runs on | NVIDIA GPUs, Linux/Windows x64 | Vulkan, CUDA, ROCm, Metal, CPU |
| Runtime | managed Python env in `userData/diffusers-runtime` (uv, Python 3.12, PyTorch cu128, `requirements.txt`), installed from Settings → Local engine | `sd-server` binary (bundled or downloaded) |
| Weights | diffusers repos (safetensors only), optional GGUF transformer, bitsandbytes text-encoder quantization, LoRA | GGUF / safetensors files |

**Settings → Local engine → Backend** picks *Auto* (diffusers when `nvidia-smi` reports an NVIDIA GPU with ≥ 6 GB, sd.cpp otherwise) or forces either backend. Each profile belongs to one backend; the studio lists the profiles of the backend in use.

The diffusers server never loads pickled weights (`use_safetensors=True`), never runs repo code (`trust_remote_code` off, `model_index.json` components must come from `diffusers`/`transformers`), runs with `HF_HUB_OFFLINE=1` and only listens on 127.0.0.1. Its tests run without torch: `cd resources/diffusers && python3 -I -m unittest discover -s . -v`.

## Model browser

**Settings → Model browser**:

- **Supported models** — one-click installs: every file a model needs for the chosen backend (quant picker per GGUF component, size and VRAM-fit badges), then a ready profile with the recommended sampling settings.
- **Search Hugging Face** — search GGUF / diffusers repos; GGUF files are grouped by quant (split files and Unsloth `UD-` quants included), diffusers repos download as a pipeline folder (optionally without the transformer, to pair with a GGUF).
- **Downloaded** — local repos (`<models folder>/<owner>/<repo>`), resumable downloads with sha256 verification, delete / reveal / new profile.

A Hugging Face token (Settings → Hugging Face, encrypted with `safeStorage`, only sent to `huggingface.co`) is needed for gated repos such as FLUX.2 [klein] 9B.

## Model-agnostic design

No hand-maintained parameter table. What a model can do is read from the model itself:

- OpenRouter controls are generated from each model's `supported_parameters` (as returned by the models endpoint). A parameter UI only appears when the model declares support.
- Local sampling defaults (sampler, scheduler, steps, CFG, size, flow shift) come from the loaded model via `GET /sdcpp/v1/capabilities` (`defaults_by_mode`), not from a hard-coded table.

The only model-specific code is the **supported-model catalog** (`src/shared/catalog.ts`): the open-weights models scoring ≥ 1000 Elo on the [Artificial Analysis image-editing leaderboard](https://artificialanalysis.ai/image/leaderboard/editing?open-weights=true) that a local backend can run. Each entry lists, per backend, the Hugging Face files to fetch, the profile slots they fill, launch args and first-load sampling defaults.

| Model | Elo | diffusers | sd.cpp |
| --- | --- | --- | --- |
| Qwen-Image 2.1 / Turbo | 1083 / 1063 | `QwenImage21Pipeline` + optional GGUF transformer | GGUF + Qwen3-VL GGUF + mmproj |
| FLUX.2 [dev] Turbo (fal LoRA) | 1017 | `Flux2Pipeline` (4-bit) + Turbo LoRA | — |
| FLUX.2 [klein] 9B | 1015 | `Flux2KleinPipeline` (gated) + optional GGUF transformer | GGUF + Qwen3 8B GGUF |
| FLUX.2 [dev] | 1000 | `Flux2Pipeline` (4-bit) | GGUF + Mistral Small 3.2 GGUF |

Not included: HunyuanImage 3.0 Instruct (1064; neither diffusers nor sd.cpp support it, ~169 GB) and FLUX.2 [dev] Flash (1014; API-only, no public weights). Any other model still works through a hand-made profile. `HF_LIVE=1 npx vitest run src/main/catalog.test.ts` checks every recipe against the live Hub.

## Resolution & 4K

**OpenRouter** uses resolution tiers: 512 / 1K / 2K / 4K. The 4K tier is only offered where the model declares it; those models get an automatic 4K badge. As of Sept 2026 that is: `google/gemini-3-pro-image`, `google/gemini-3.1-flash-image`, `bytedance-seed/seedream-4.5`, `bytedance-seed/seedream-5-0-lite`, `sourceful/riverflow-v2-pro`, `riverflow-v2-fast`, `riverflow-v2.5-pro`.

**Local**: long-edge presets up to 4096 with snapping to 8/16/32/64 multiples, and a warning above ~4 MP (most machines will be slow or OOM there). The recommended path to 4K:

1. Generate near the model's native size.
2. Upscale via **Hires fix** (set target "4K long edge") or the **ESRGAN Upscale** tool — put ESRGAN models (e.g. `RealESRGAN_x4plus.pth`) in the profile's upscaler directory (`hires-upscalers-dir`).
3. Enable **VAE tiling** for large decodes to avoid VRAM blowups.

**Qwen-Image 2.1** notes: native presets up to 2752 per side (e.g. 2752×1536 for 16:9, from the model card; the diffusers server caps sizes at 2048), dimensions divisible by 32. Recommended settings differ per backend (Unsloth): sd.cpp **cfg 6, euler, 20 steps, flow shift automatic**; diffusers **40 steps, CFG 1**. Catalog installs apply them on first load; otherwise defaults come from the model's capabilities at runtime.

## Editions

Builds come in two editions, selected at build time via `IMAGE_STUDIO_EDITION=slim` (the `__SLIM__` constant is baked in by `electron-vite`):

| Edition | Product name | Local sd.cpp engine | Cloud (OpenRouter) |
| --- | --- | --- | --- |
| **Full** (default) | Image Studio | bundled (`extraResources`) | yes |
| **Slim** | Image Studio Lite | not bundled — in-app download only | yes |

The slim edition ships a smaller package (~125 MB vs ~250+ MB) with the local-generation UI disabled; users there download engine variants from within the app instead.

## Getting started

```bash
npm install
npm run fetch-sdcpp   # downloads the sd.cpp engine for this platform into resources/sdcpp
npm run dev
```

- Add your OpenRouter key in Settings. It is stored encrypted via Electron `safeStorage` and never sent to the renderer (only a `hasApiKey` flag is exposed).
- Get a local model under Settings → Model browser (or create a profile by hand under Settings → Local models). For diffusers, install its runtime under Settings → Local engine first.
- If `ELECTRON_RUN_AS_NODE` is set in your shell, `unset ELECTRON_RUN_AS_NODE` first — it breaks Electron startup.

## Engines

`resources/sdcpp/<variantId>/` holds pre-fetched sd.cpp builds. Variants per platform (from `src/main/sdcpp/variants.json`):

| Platform | Variants |
| --- | --- |
| Linux | Vulkan, CPU, ROCm, CUDA (source build) |
| Windows | CUDA 12, Vulkan, CPU, ROCm |
| macOS | Apple Silicon |

- Linux has **no official CUDA prebuilt**. Use `npm run build-sdcpp-cuda` (needs CUDA toolkit, cmake, git). It clones stable-diffusion.cpp, builds with `-DSD_CUDA=ON`, and installs to `~/.config/Image Studio/engines/linux-cuda-source`.
- Vulkan works on NVIDIA, AMD and Intel GPUs.
- A **custom binary path** is supported (`engineVariant: "custom"` → `customServerPath`).

Run without a GPU: `linux-cpu` variant. Heavy models (FLUX.2, Qwen-Image) typically want `offload-to-cpu`, which the catalog recipes set. Flash attention and direct convolutions are left to sd.cpp's per-module `auto` selection (`--flash-attn` / `--conv-direct`, master-962 and newer); the old `--fa` / `--diffusion-fa` / `--*-conv-direct` switches remain in the profile editor as legacy options for older builds.

## Where things live

- **Outputs**: `~/Pictures/Image Studio/YYYY-MM-DD/` — PNG/WebP images plus a `.json` sidecar per image with the full request.
- **History index**: `userData/history/history.jsonl` (one record per generation / upscale; append-only).
- **Settings**: `userData/settings.json`; OpenRouter key and HF token are separate safeStorage-encrypted files.
- **Downloaded models**: `userData/models/<owner>/<repo>/` by default (Settings → Hugging Face → Models folder).
- **diffusers runtime**: `userData/diffusers-runtime/` (uv, Python, venv, caches).

## Scripts

| Script | What it does |
| --- | --- |
| `npm run dev` | electron-vite dev server + Electron app (drops `ELECTRON_RUN_AS_NODE` from the env) |
| `npm run dev:slim` | dev server in slim/Lite mode (`IMAGE_STUDIO_EDITION=slim`) |
| `npm run build` | electron-vite production build (`out/`) |
| `npm run typecheck` | `tsc` for node and web tsconfig |
| `npm test` | vitest |
| `npm run fetch-sdcpp` | fetch sd.cpp release asset for a variant into `resources/sdcpp/` (staged download, atomic swap; pass `GITHUB_TOKEN`/`GH_TOKEN` for authenticated GitHub API access) |
| `npm run build-sdcpp-cuda` | build sd.cpp CUDA from source, install as engine variant (Linux) |
| `npm run dist:full` | build + package the full edition (`electron-builder.yml`) |
| `npm run dist:slim` | build + package the slim/Lite edition (`electron-builder.slim.yml`) |

`dist:*` scripts are cross-platform wrappers (`scripts/dist.mjs`); pass extra electron-builder args straight through, e.g. `npm run dist:full -- --linux zip` or `node scripts/dist.mjs slim --win squirrel`. The full edition does **not** fetch the engine automatically — run `node scripts/fetch-sdcpp.mjs <variantId>` (e.g. `linux-vulkan`, `win-vulkan`) first. Outputs land in `release/` (gitignored).

Packaging via `electron-builder`: `resources/sdcpp` and `resources/diffusers` (server script + requirements) are bundled as `extraResources` next to the app (full edition only; never inside the asar). Targets: Linux `zip`, Windows `squirrel` (Squirrel.Windows, needs `electron-builder-squirrel-windows`), macOS `dmg` (not built in CI).

Windows icon: `scripts/make-icon.mjs` generates both `build/icon.png` (512×512, other platform icons) and `build/icon.ico` (256×256, single PNG-compressed entry). The `.ico` is used for the Windows exe (`win.icon`) and as the Squirrel installer icon (`squirrelWindows.iconUrl`).

## CI / releases

`.github/workflows/build.yml` runs on pushes/PRs to `main`, tags `v*`, and manual dispatch:

1. **check** — typecheck + tests on ubuntu-latest (Node 24).
2. **package** — matrix `OS × edition` (ubuntu→`--linux zip`, windows→`--win squirrel`); fetches the engine for the full edition and uploads `image-studio-<edition>-<os>` artifacts. Code signing is disabled (`CSC_IDENTITY_AUTO_DISCOVERY: false`).
3. **release** — on tags `v*`: creates a GitHub release with all packaged artifacts (`gh release create --generate-notes`).

npm's install-script approval (`allowScripts` in `package.json`) covers the postinstalls needed in CI (esbuild, electron-winstaller).

## Project layout

```
src/
  main/          Electron main process (windows, IPC, history, settings)
    sdcpp/       local server lifecycle (both backends), sd.cpp engine variants (variants.json)
    backends/    launch specs: profile → sd-server / python server.py command line
    diffusers/   managed Python runtime installer
    hf/          Hugging Face Hub client + resumable download manager
    hardware.ts  GPU probe + auto backend choice
    catalog.ts   supported-model installs → profiles
  preload/       contextBridge API (window.api)
  renderer/src/
    studio/      studio UI (simple/advanced)
    chat/        chat UI
    settings/    settings (model browser, profiles, API key / HF token, engines)
  shared/        types.ts (contract), sdcppFlags.ts / diffusersFlags.ts (launch flags),
                 catalog.ts + catalogResolve.ts (supported models), quants.ts (GGUF quant parsing)
resources/sdcpp/     pre-fetched engine builds (bundled into packages)
resources/diffusers/ diffusers server (server.py, requirements.txt)
```
