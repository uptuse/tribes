#!/bin/bash
set -e

export PATH="/Users/jkoshy/emsdk:/Users/jkoshy/emsdk/upstream/emscripten:/Users/jkoshy/emsdk/node/22.16.0_64bit/bin:$PATH"

# Use writable cache if emsdk cache is read-only (macOS sandbox)
if [ ! -w "/Users/jkoshy/emsdk/upstream/emscripten/cache" ]; then
    if [ ! -d "/tmp/emscripten_cache/sysroot" ]; then
        cp -r /Users/jkoshy/emsdk/upstream/emscripten/cache /tmp/emscripten_cache
    fi
    export EM_CACHE=/tmp/emscripten_cache
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

mkdir -p build

emcc program/code/wasm_main.cpp -o build/tribes.html \
  -std=c++14 -I program/code \
  -s USE_WEBGL2=1 -s FULL_ES3=1 -s ALLOW_MEMORY_GROWTH=1 -s INITIAL_MEMORY=134217728 \
  --shell-file shell.html \
  --preload-file assets@/assets/tribes \
  -O0 -g0 -Wno-format \
  -s EXPORTED_FUNCTIONS='["_main","_applyLoadout","_setGameSettings","_updateScoreboard"]' -s EXPORTED_RUNTIME_METHODS='["ccall","cwrap","UTF8ToString"]'

echo "[build] Output: build/tribes.html, build/tribes.js, build/tribes.wasm, build/tribes.data"

# Deploy to repo root for GitHub Pages
cp build/tribes.html index.html
cp build/tribes.js tribes.js
cp build/tribes.wasm tribes.wasm
cp build/tribes.data tribes.data

echo "[deploy] Copied to repo root. Ready for git push."
