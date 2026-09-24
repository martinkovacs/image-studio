#!/usr/bin/env bash
# Builds stable-diffusion.cpp with CUDA from source on Linux and installs it as
# the "linux-cuda-source" engine variant (the release archive has no Linux CUDA
# prebuilt). Intended for dev machines / power users only.
#
# Usage: bash scripts/build-sdcpp-cuda.sh [-j N] [-b BRANCH]
set -euo pipefail

REPO_URL="https://github.com/leejet/stable-diffusion.cpp"
CLONE_DIR="${XDG_CACHE_HOME:-$HOME/.cache}/image-studio/sdcpp-src"
JOBS=4
BRANCH="master"
while [[ $# -gt 0 ]]; do
  case "$1" in
    -j) JOBS="$2"; shift 2 ;;
    -b) BRANCH="$2"; shift 2 ;;
    *) echo "unknown option: $1" >&2; exit 1 ;;
  esac
done

# Destination (matches Electron's userData path for productName "Image Studio")
# on Linux: engines/linux-cuda-source/
DATA_ROOT="${XDG_CONFIG_HOME:-$HOME/.config}/Image Studio"
ENGINE_DIR="$DATA_ROOT/engines/linux-cuda-source"

echo "→ source:     $CLONE_DIR"
echo "→ engine dir: $ENGINE_DIR"

# ---------------------------------------------------------------- clone/pull
if [[ ! -d "$CLONE_DIR/.git" ]]; then
  mkdir -p "$(dirname "$CLONE_DIR")"
  rm -rf "$CLONE_DIR"
  git clone --recursive -b "$BRANCH" "$REPO_URL" "$CLONE_DIR"
else
  git -C "$CLONE_DIR" fetch --all --tags
  git -C "$CLONE_DIR" checkout "$BRANCH"
  git -C "$CLONE_DIR" pull --ff-only
  git -C "$CLONE_DIR" submodule update --init --recursive
fi

# ---------------------------------------------------------------- build
# CUDA option is -DSD_CUDA=ON (see docs/build.md in the sd.cpp repository).
cmake -S "$CLONE_DIR" -B "$CLONE_DIR/build" \
  -DSD_CUDA=ON \
  -DCMAKE_BUILD_TYPE=Release
cmake --build "$CLONE_DIR/build" --config Release -j"$JOBS"

# ---------------------------------------------------------------- install
SERVER_BIN="$(find "$CLONE_DIR/build" -type f -name sd-server -perm -u+x | head -n1)"
CLI_BIN="$(find "$CLONE_DIR/build" -type f -name sd-cli -perm -u+x | head -n1)"
[[ -n "$SERVER_BIN" ]] || { echo "sd-server binary not found after build" >&2; exit 1; }
[[ -n "$CLI_BIN" ]] || { echo "sd-cli binary not found after build" >&2; exit 1; }

mkdir -p "$ENGINE_DIR"
install -m 0755 "$SERVER_BIN" "$ENGINE_DIR/sd-server"
install -m 0755 "$CLI_BIN" "$ENGINE_DIR/sd-cli"

# Ship any shared libs CMake builds alongside (so the server finds them from
# its own dir via cwd / LD_LIBRARY_PATH).
find "$CLONE_DIR/build" -type f \( -name '*.so' -o -name '*.so.*' \) | while read -r so; do
  install -m 0755 "$so" "$ENGINE_DIR/$(basename "$so")"
done

TAG="$(git -C "$CLONE_DIR" describe --tags --always 2>/dev/null || echo unknown)"
printf '{"tag": "%s", "installedAt": "%s"}\n' "$TAG" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  > "$ENGINE_DIR/version.json"

echo "✔ installed $TAG into $ENGINE_DIR"
