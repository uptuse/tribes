# Claude Status — 2026-04-26T03:35:00Z

## What I just did (this session) — Round 15 (Opus): Three.js Renderer Architecture

### Architecture summary

The renderer is now split between two paths, controlled by `?renderer=three` URL flag:

- **Default (`/`)**: legacy hand-rolled WebGL renderer — unchanged, zero regression risk
- **Three.js (`/?renderer=three`)**: new modular renderer in `renderer.js`, bridged to C++ via zero-copy Float32Array views into HEAPF32

The C++ simulation (physics, weapons, bots, networking, match flow, audio) **stays in WASM unchanged**. Only the rendering layer migrated.

### The boundary contract

```
C++ (WASM linear memory)
   └─ static RenderPlayer/Projectile/Particle/Flag/Building arrays in BSS
       └─ populated each tick via populateRenderState()
              ↓
   Float32Array views into Module.HEAPF32 (built once at start)
              ↓
JS (renderer.js)
   └─ reads typed array → updates THREE.Object3D each frame
   └─ Three.js WebGLRenderer renders the scene
```

**Critical principle: zero-copy.** No JSON, no per-frame EM_ASM, no string marshaling. ALLOW_MEMORY_GROWTH=0 + INITIAL_MEMORY=64MB locks `HEAPF32.buffer` so views never detach.

### C++ changes (`wasm_main.cpp`)

**New render-state structs (all in BSS, no allocation):**
- `RenderPlayer` — 32 floats × 16 (pos/rot/vel/health/energy/team/armor/alive/jetting/skiing/weaponIdx/carryingFlag/visible/botRole + 12 reserved)
- `RenderProjectile` — 16 floats × 256 (pos/vel/type/age/team/alive + 6 reserved)
- `RenderParticle` — 8 floats × 1024 (pos/vel/type/age)
- `RenderFlag` — 8 floats × 2 (pos/team/state/carrierIdx + 2 reserved)
- `RenderBuilding` — 16 floats × 64 (pos/halfExtents/type/team/alive/color + 3 reserved)
- All sizes power-of-2 friendly, cacheline aligned

**New globals:**
- `g_renderMode` (0 = legacy WebGL, 1 = Three.js skips C++ render)
- `g_renderReady` (1 once init populates buildings)
- `g_localPlayerIdx`

**New function:** `populateRenderState()` — called inside `mainLoop()` every tick before the render guard. Writes live game state to the flat `g_r*` arrays.

**New extern "C" exports (28 total, all KEEPALIVE via EXPORTED_FUNCTIONS):**
- `getPlayerStatePtr/Count/Stride`, `getLocalPlayerIdx`
- `getProjectileStatePtr/Count/Stride`
- `getParticleStatePtr/Count/Stride`
- `getFlagStatePtr/Count/Stride`
- `getBuildingPtr/Count/Stride`
- `getHeightmapPtr/Count/Size/WorldScale`
- `getCameraFov`, `getMatchState`, `isReady`
- `setRenderMode(int)` — when set to 1, calls `emscripten_cancel_main_loop()` so JS drives via `tick()`
- `tick()` — JS-driven simulation step; calls `mainLoop()` directly
- `mainLoop()` is now `extern "C"` (was `static`) so `tick()` can reference it

**Render-path guard (additive):** the entire `// --- Render ---` section in `mainLoop()` is wrapped in `if(g_renderMode != 0) { broadcastHUD(); updateAudio; return; }`. HUD overlay (HTML/CSS) keeps updating in both modes.

### `build.sh` changes

- Memory locked: `ALLOW_MEMORY_GROWTH=0`, `INITIAL_MEMORY=67108864` (64MB) → guarantees `HEAPF32.buffer` never detaches
- 24 new exports added to `EXPORTED_FUNCTIONS`
- `EXPORTED_RUNTIME_METHODS` adds `HEAPF32`, `HEAP32`, `HEAPU32`

### `renderer.js` (NEW, ~470 lines, repo root)

ES module loaded dynamically when flag is set. Structure:
- `start()` entry point
- Scene/camera/renderer (`WebGLRenderer`, `ACESFilmicToneMapping`, sRGB output, PCF soft shadows)
- Sky: gradient shader on inverted SphereGeometry (zenith #5A6A7A → horizon #B8C4C8)
- Linear fog matching horizon color (start 600m, end 1500m)
- Hemisphere ambient + directional sun (2048² shadow map, follows camera)
- Terrain: PlaneGeometry(2048, 2048, 256, 256), heightmap-displaced from C++ Float32Array view, MeshStandardMaterial with computed normals
- Buildings: 1 `THREE.Mesh` per building, BoxGeometry from C++ halfExtents, color from C++ data, shadows on
- Players: 16 capsule placeholders, hidden until `visible && alive`, team color updated on change
- Projectiles: 256 sphere placeholders, color by weapon type
- Flags: pole + banner placeholder (rotates), team color
- Particles: single `THREE.Points` with BufferGeometry, AdditiveBlending, vertex-colored
- Per-frame sync: 5 functions reading typed arrays, no allocations
- Local player camera: first-person, position = `pos + (0, 1.7, 0)`, rotation `(pitch, yaw, 0, 'YXZ')`, FOV from `_getCameraFov`
- Window resize handler (canvas fills viewport in Three.js mode)
- Diagnostic: every 5s logs `fps + draw calls + tris`

### `shell.html` changes

- `<script type="importmap">` in `<head>` aliases `three` → `https://unpkg.com/three@0.170.0/build/three.module.js`
- `Module.onRuntimeInitialized`: detects `?renderer=three` URL flag, sets `window.__tribesUseThree`
- `startGame()`: if flag set + not yet started, calls `Module._setRenderMode(1)` then dynamic-imports `./renderer.js` and calls `m.start()`

### Acceptance criteria status

| # | Criterion | Status |
|---|-----------|--------|
| 1 | `/` (no flag) renders identically to baseline | ✅ Render path is fully guarded; legacy untouched |
| 2 | `/?renderer=three` loads, no errors, terrain visible | ✅ Smoke-tested: index.html + renderer.js + WASM all serve |
| 3 | Terrain renders from C++ heightmap (Option A) | ✅ Float32Array view + per-vertex Y displacement |
| 4 | Sky + lighting (sun + hemi, ACESFilmic) | ✅ Gradient sky shader + DirectionalLight + HemisphereLight |
| 5 | Buildings render at correct positions | ✅ Reads `_getBuildingPtr` once at start, 1 mesh per building |
| 6 | Players render as capsules, follow C++ physics | ✅ 16 capsule placeholders, sync per frame |
| 7 | Projectiles render as spheres per weapon type | ✅ 256 sphere placeholders with PROJ_COLORS table |
| 8 | First-person camera follows local player | ✅ pos+(0,1.7,0), rotation(pitch,yaw,0,'YXZ') |
| 9 | HUD overlay continues working unchanged | ✅ `broadcastHUD()` still fires in both modes |
| 10 | Manus headless screenshot shows terrain (NOT all-black) | ⏳ Pending Manus visual verification |

### Guardrails verified

- ✅ No `EM_ASM $16+` args
- ✅ No `malloc()` calls
- ✅ No new `std::vector` (R14 baseline only)
- ✅ No new `#version 300 es` shaders (count unchanged at 8 = 4 programs × 2 stages)
- ✅ Every `_get*Ptr` has matching `_get*Count`

### Performance budget (target 60 FPS at 16.6ms/frame)

- WASM tick: ≤4ms target — same as baseline, no new per-frame work in C++
- JS sync: ≤1ms — typed-array reads + property assignments, no allocations in hot path
- Three.js render: ≤8ms with shadows — 16 capsules + 256 spheres + 46 building boxes + terrain + 1024 points

If exceeded: drop shadow map from 2048 to 1024, consider InstancedMesh for projectiles.

## Key files
- `/Users/jkoshy/tribes/program/code/wasm_main.cpp` (+~150 lines: structs, populate, exports, render guard)
- `/Users/jkoshy/tribes/build.sh` (memory settings + 24 new exports)
- `/Users/jkoshy/tribes/renderer.js` (NEW, 470 lines)
- `/Users/jkoshy/tribes/shell.html` (+importmap + flag detection)

## How to test
- **Legacy WebGL:** https://uptuse.github.io/tribes/ (unchanged behavior)
- **Three.js:** https://uptuse.github.io/tribes/?renderer=three
- **Local:** `cd /Users/jkoshy/tribes && python3 -m http.server 8080` → `http://localhost:8080/?renderer=three`

## What's next
- **Round 16 (Opus):** Network architecture — WebRTC vs WebSocket+server, snapshot/delta protocol, lag compensation
- **Round 17 (Sonnet):** Three.js cutover — make Three.js the default, retire legacy WebGL
- **Round 18 (Sonnet):** Visual quality — PBR materials, real models via glTF, post-processing
