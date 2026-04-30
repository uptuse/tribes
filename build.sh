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
  -s USE_WEBGL2=1 -s FULL_ES3=1 \
  -s ALLOW_MEMORY_GROWTH=0 -s INITIAL_MEMORY=67108864 -s MAXIMUM_MEMORY=67108864 \
  --shell-file shell.html \
  --preload-file assets/chaingun.DTS@/assets/tribes/chaingun.DTS \
  --preload-file assets/discb.DTS@/assets/tribes/discb.DTS \
  --preload-file assets/grenade.DTS@/assets/tribes/grenade.DTS \
  --preload-file assets/harmor.DTS@/assets/tribes/harmor.DTS \
  --preload-file assets/larmor.dts@/assets/tribes/larmor.dts \
  --preload-file assets/marmor.dts@/assets/tribes/marmor.dts \
  --preload-file assets/tower.DTS@/assets/tribes/tower.DTS \
  --preload-file assets/hdri@/assets/tribes/hdri \
  --preload-file assets/maps@/assets/tribes/maps \
  -O0 -g0 -Wno-format \
  -s EXPORTED_FUNCTIONS='["_main","_applyLoadout","_setGameSettings","_updateScoreboard","_setSettings","_setLocalPlayerNetCorrection","_setMapBuildings","_malloc","_free","_getPlayerStatePtr","_getPlayerStateCount","_getPlayerStateStride","_getLocalPlayerIdx","_getProjectileStatePtr","_getProjectileStateCount","_getProjectileStateStride","_getParticleStatePtr","_getParticleStateCount","_getParticleStateStride","_getFlagStatePtr","_getFlagStateCount","_getFlagStateStride","_getBuildingPtr","_getBuildingCount","_getBuildingStride","_getHeightmapPtr","_getHeightmapCount","_getHeightmapSize","_getHeightmapWorldScale","_getCameraFov","_getMatchState","_isReady","_setRenderMode","_tick","_getPlayerSkiing","_getPlayerSpeed","_getPlayerSlopeDeg","_getThirdPerson","_setLocalAimPoint3P","_appendInteriorShapeAABBs","_appendInteriorMeshTris","_setPhysicsTuning","_getLayoutEntityCount","_isLayoutLoaded","_getLayoutEntity","_setLayoutEntityPos","_setFreelook",
"_dtsChaingunVC","_dtsChaingunIC","_dtsChaingunV","_dtsChaingunN","_dtsChaingunI",
"_dtsDiscVC","_dtsDiscIC","_dtsDiscV","_dtsDiscN","_dtsDiscI",
"_dtsGrenadeVC","_dtsGrenadeIC","_dtsGrenadeV","_dtsGrenadeN","_dtsGrenadeI",
"_pause","_teleportPlayer","_reloadBuildings","_writeHeightmapPatch","_spawnDummy"]' \
  -s EXPORTED_RUNTIME_METHODS='["ccall","cwrap","UTF8ToString","HEAPF32","HEAP32","HEAPU32"]'
# R29: _setRenderMode must stay in EXPORTED_FUNCTIONS above — required for Three.js cutover.

echo "[build] Output: build/tribes.html, build/tribes.js, build/tribes.wasm, build/tribes.data"

# Deploy to repo root for GitHub Pages
# NOTE: index.html is hand-maintained — never overwrite it from build output.
cp build/tribes.js tribes.js
cp build/tribes.wasm tribes.wasm
cp build/tribes.data tribes.data

echo "[deploy] Copied to repo root. Ready for git push."
