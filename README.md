# Image Studio

Electron image generation & editing studio. Two providers: **OpenRouter** (cloud) and **stable-diffusion.cpp** (local, bundled `sd-server`).

- **Studio UI** (default): generation / edit / inpaint panels with a simple and an advanced detail level.
- **Chat UI** (optional): threaded conversational interface; toggle in **Settings → General**.

Providers:

- **OpenRouter** — Unified Image API: `POST /api/v1/images` for generation, `GET /api/v1/images/models` for the model list.
- **Local** — stable-diffusion.cpp's `sd-server` via its native async API (`POST /sdcpp/v1/img_gen`), spawned from a launch profile.

## Model-agnostic design

No hand-maintained parameter table. What a model can do is read from the model itself:

- OpenRouter controls are generated from each model's `supported_parameters` (as returned by the models endpoint). A parameter UI only appears when the model declares support.
- Local sampling defaults (sampler, scheduler, steps, CFG, size, flow shift) come from the loaded model via `GET /sdcpp/v1/capabilities` (`defaults_by_mode`), not from a hard-coded table.

Profile templates only pre-fill which **weight-file slots** matter for a model family:

| Template | Slots |
| --- | --- |
| Qwen-Image 2.1 | diffusion-model, VAE, LLM (Qwen3-VL), LLM vision (mmproj) |
| Qwen-Image-Edit 2511 | diffusion-model, VAE, LLM (Qwen2.5-VL), LLM vision (mmproj) |
| Qwen-Image / Edit 2509 | diffusion-model, VAE, LLM (Qwen2.5-VL), LLM vision (mmproj) |
| Flux.1 (dev / schnell / Kontext) | diffusion-model, VAE, CLIP-L, T5-XXL |
| Flux.2 | diffusion-model, VAE, LLM (Mistral-Small 3.2 or Qwen3) |
| Z-Image Turbo | diffusion-model, VAE, LLM (Qwen3-4B) |
| SD 1.x / SDXL checkpoint | full checkpoint, VAE (optional) |

## Resolution & 4K

**OpenRouter** uses resolution tiers: 512 / 1K / 2K / 4K. The 4K tier is only offered where the model declares it; those models get an automatic 4K badge. As of Sept 2026 that is: `google/gemini-3-pro-image`, `google/gemini-3.1-flash-image`, `bytedance-seed/seedream-4.5`, `bytedance-seed/seedream-5-0-lite`, `sourceful/riverflow-v2-pro`, `riverflow-v2-fast`, `riverflow-v2.5-pro`.

**Local**: long-edge presets up to 4096 with snapping to 8/16/32/64 multiples, and a warning above ~4 MP (most machines will be slow or OOM there). The recommended path to 4K:

1. Generate near the model's native size.
2. Upscale via **Hires fix** (set target "4K long edge") or the **ESRGAN Upscale** tool — put ESRGAN models (e.g. `RealESRGAN_x4plus.pth`) in the profile's upscaler directory (`hires-upscalers-dir`).
3. Enable **VAE tiling** for large decodes to avoid VRAM blowups.

**Qwen-Image 2.1** notes: native presets up to 2048/side (e.g. 2752×1536 16:9, from Unsloth's table), dimensions divisible by 32. Recommended sd.cpp settings: **cfg 6, euler, 20 steps, flow shift automatic** — these are really read from the model's capabilities at runtime.

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
- Create a local model profile under Settings → Local (pick a template, point it at your weight files, start the server).
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

Run without a GPU: `linux-cpu` variant. Heavy models (Flux, Qwen) typically want `offload-to-cpu` and flash attention, which is what the templates set.

## Where things live

- **Outputs**: `~/Pictures/Image Studio/YYYY-MM-DD/` — PNG/WebP images plus a `.json` sidecar per image with the full request.
- **History index**: `userData/history/history.jsonl` (one record per generation / upscale; append-only).
- **Settings**: `userData/settings.json` (API key here encrypted via safeStorage, not plaintext).

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

Packaging via `electron-builder`: `resources/sdcpp` is bundled as `extraResources` next to the app (full edition only; never inside the asar). Targets: Linux `zip`, Windows `squirrel` (Squirrel.Windows, needs `electron-builder-squirrel-windows`), macOS `dmg` (not built in CI).

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
    sdcpp/       sd-server lifecycle, engine variants (variants.json), capabilities proxy
  preload/       contextBridge API (window.api)
  renderer/src/
    studio/      studio UI (simple/advanced)
    chat/        chat UI
    settings/    settings (profiles, templates.ts, API key, engine variant)
  shared/        types.ts (main/preload/renderer contract), sdcppFlags.ts (launch flags)
resources/sdcpp/ pre-fetched engine builds (bundled into packages)
```
