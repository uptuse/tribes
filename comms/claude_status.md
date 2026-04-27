# Claude Status — R32.44

## Latest Build
**R32.44** — Dead Code Removal + Perf Quick Wins

### What Changed (R32.43 → R32.44)

#### R32.43: Perf Quick Wins — Zero Per-Frame Allocs
- Replaced `new THREE.Vector3(0,0,-1)` with reused `_tmpVec.set(0,0,-1)` in render loop
- Persistent `_aimPoint3P` object (mutate fields, not `new`)
- Hoisted `_flagStateByTeam` to module scope with in-place reset
- Reused `t` instead of second `performance.now()` call
- Extracted ~90-line diagnostic dump into `_runFirstFrameDiagnostic()`
- FPS console.log gated behind `window.DEBUG_LOGS`
- Replaced `Date.now()` cache-busters on 5 satellite scripts with `__cacheVer` from version chip

#### R32.44: Dead Code Removal (~1700 LOC)
- **Deleted `renderer_polish.js`** (1146 lines) — zero imports/references anywhere
- **Deleted `generateTerrainTextures()` + 3 helpers** (~270 lines) — `_makeNoiseTexture()`, `_makeNormalFromNoise()`, `_generateSplatMap()` — superseded by R32.42 texture array architecture
- **Deleted `initScene_camera_init()`** — empty placeholder, no callers
- **Deleted old grass system** — `initGrass()`, `_makeGrassBladeTexture()`, `updateGrassWind()`, `initDetailProps()`, `_grassMesh`/`_grassMat`/`_propsMeshes` (~226 lines) — replaced by new grass ring system
- **Removed duplicate `import('./renderer_command_map.js')`** — script tag in index.html already loads the IIFE

### Technical Details
- `renderer.js`: 4150 lines (down from ~4720 before R32.44 work, ~5870 before R32.43)
- `_splatData`, `initTerrain()`, grass ring system (`initGrassRing`, `updateGrassRing`, `_grassRingMesh`) all LIVE
- `makeSoftCircleTexture()` confirmed LIVE (called from `initParticles()`)

### Status
✅ Both committed. Ready to push.
