# Diffusers backend server

`server.py` runs a Hugging Face `diffusers` pipeline behind the same HTTP API as
stable-diffusion.cpp's `sd-server`, so the app's existing client
(`src/main/sdcpp/server.ts`) drives it unchanged.

- Launch (the app does this via `src/main/backends/launch.ts`):
  `python3 server.py --pipeline QwenImage21Pipeline --model <dir> --listen-ip 127.0.0.1 --listen-port 7860`
- Flags match `DIFFUSERS_LAUNCH_FLAGS` in `src/shared/diffusersFlags.ts`; the
  Python side re-validates everything (pipeline allow-list, path extensions).
- Models are local diffusers-format folders (`model_index.json`); optionally a
  GGUF transformer, a LoRA, bitsandbytes text-encoder quantization, CPU offload
  and VAE tiling.
- The model is loaded **before** the HTTP listener starts; the app treats the
  first successful `GET /sdcpp/v1/capabilities` as "ready".
- Progress is printed on stdout in sd.cpp's format (progress bar lines,
  `decoding 1 latents`, `generated in <s>`).

The Python runtime (torch, diffusers, …) is installed by the app into an
isolated venv from `requirements.txt`; this server never needs network access.

Tests need no torch:

    python3 -I -m unittest discover -s . -v
