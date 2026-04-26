# Manus Feedback — Round 15: Three.js Renderer Architecture (OPUS)

**MODEL:** **OPUS 4.7** (1M context, architectural reasoning round)
**Severity:** Strategic — this round determines the renderer architecture for the rest of the project
**Type:** Architecture spec + minimal additive scaffold (no removal of existing WebGL code)
**Round 14 + 14.5 status:** Accepted ✓

---

## 1. Why Three.js, and why now

The current hand-rolled WebGL2 renderer in `wasm_main.cpp` (~4 GLSL programs, manual VAO/UBO/draw-call orchestration) has been adequate for 14 rounds, but is reaching its scaling ceiling:

1. **Silent shader linkage failures.** The R13 settings work introduced a regression where one or more programs fail to link in headless Chromium (SwiftShader). Real Chrome renders fine, but the fragility — a single uniform-name mismatch crashes the whole render path silently — is unacceptable as we scale to PBR materials, shadows, particles, and player models.
2. **Asset pipeline dead-end.** Hand-rolled WebGL has no path to glTF/FBX import. Real Tribes player models, weapon models, and animations require a proper asset pipeline. Three.js has it built in (`GLTFLoader`, `FBXLoader`, skeletal animation, morph targets).
3. **Headless-CI parity.** Three.js is rigorously tested against headless Chromium because the entire web-3D ecosystem runs CI in headless. After this migration, Manus play-testing will produce screenshots that match what users see — a 5x productivity gain for the review loop.
4. **Built-in modern features.** Shadow maps, post-processing, PBR materials, environment IBL, instanced meshes, frustum culling — all production-grade and free. Building these by hand in raw WebGL costs us 4-6 rounds of work each.
5. **Path to WebGPU.** When we want to upgrade compute (R30+ timeframe), Three.js's `WebGPURenderer` is a one-line swap. Hand-rolled WebGL would require a complete rewrite.

The C++ simulation (physics, weapons, bots, networking, match flow) **stays in WASM unchanged**. This round migrates only the *rendering* layer.

---

## 2. Architectural goal

**Move the renderer from C++ to JS, while keeping the simulation in C++.** The C++ side becomes a state-export oracle; the JS side reads simulation state each frame and renders it via Three.js.

The boundary contract:

```
┌─────────────────────────────────────────────────────────┐
│  C++ (WASM linear memory)                               │
│  • Physics, weapons, bots, networking, match state      │
│  • Player[8] array, projectile array, particle array    │
│  • Per-frame: simulate(dt) → updates Player.pos/rot/etc │
│  • Exports flat memory layouts (no new allocations)     │
└──────────────────┬──────────────────────────────────────┘
                   │
        ┌──────────▼──────────┐
        │  WASM↔JS boundary   │  Zero-copy Float32Array views into HEAPF32
        └──────────┬──────────┘  No JSON. No EM_ASM per-frame.
                   │
┌──────────────────▼──────────────────────────────────────┐
│  JS / Three.js                                          │
│  • Reads Float32Array view → updates THREE.Object3D     │
│  • Owns scene graph, materials, lights, camera          │
│  • Renders with WebGLRenderer (r182, no WebGPU)         │
│  • HUD/UI continues as DOM overlay (unchanged)          │
└─────────────────────────────────────────────────────────┘
```

**Critical principle: zero-copy state export.** Per-frame state must NOT pass through JSON, EM_ASM, or any string marshal. C++ owns a flat struct array in linear memory; JS sees it as a typed array view and reads it directly. This is essential for performance (60 FPS with 8-16 players + 200 projectiles) and reliability (no $16+ EM_ASM crashes, ever again).

---

## 3. Concrete architecture

### 3.1 Three.js setup

- **Version: r170** (NOT r182). r170 is the last release with the legacy `EffectComposer` post-process and zero WebGPU regressions. We can upgrade to r182 in R18 if RenderPipeline benefits warrant it. Lock the version in `package.json` or — since we're not using a build tool — pin to a CDN URL: `https://unpkg.com/three@0.170.0/build/three.module.js`.
- **Renderer: `WebGLRenderer`** (NOT `WebGPURenderer` — known shadow-quality regressions per threejs.org discourse).
- **Module loading via ES modules.** No bundler. Use `<script type="importmap">` to alias `three` to the CDN URL, then `import * as THREE from 'three'` in a new `renderer.js` file. Importmap is supported in all modern browsers.
- **Color space: `THREE.SRGBColorSpace`** for output, `THREE.LinearSRGBColorSpace` for textures. Three.js r155+ defaults are correct; just verify.
- **Tone mapping: `THREE.ACESFilmicToneMapping`** with exposure `1.0`. Gives a film-quality look that matches the muted Tribes 1 aesthetic.

### 3.2 WASM↔JS state export protocol

Add to `wasm_main.cpp` a flat per-entity export struct, packed for direct typed-array reading:

```cpp
// Public render-state structs — laid out so JS Float32Array views map directly.
// Sizes are deliberately power-of-2 friendly and cacheline-conscious.

struct RenderPlayer {        // 32 floats = 128 bytes
    float pos[3];            // [0..2]   world position
    float rot[3];            // [3..5]   euler XYZ (Three.js order: 'YXZ')
    float vel[3];            // [6..8]   for motion-blur / dust trails
    float health;            // [9]      0..maxHealth
    float energy;            // [10]     0..maxEnergy
    float team;              // [11]     0=red, 1=blue, 2=spectator
    float armor;             // [12]     0=light, 1=medium, 2=heavy
    float alive;             // [13]     0 or 1
    float jetting;           // [14]     0 or 1 (for jet-flame VFX)
    float skiing;            // [15]     0 or 1 (for ski-spray VFX)
    float weaponIdx;         // [16]     -1 = none, else 0..numWeapons-1
    float carryingFlag;      // [17]     -1 = none, else team idx
    float visible;           // [18]     0 or 1 (for cloak / spectator filter)
    float botRole;           // [19]     -1=human, 0=OFF, 1=DEF, 2=MID
    float reserved[12];      // [20..31] future use; keep struct 128-byte aligned
};

struct RenderProjectile {    // 16 floats = 64 bytes
    float pos[3];
    float vel[3];
    float type;              // 0=disc, 1=chain, 2=plasma, 3=grenade
    float age;               // for trail length / alpha
    float team;              // shooter's team for color
    float alive;             // 0 or 1
    float reserved[6];
};

struct RenderParticle {      // 8 floats = 32 bytes
    float pos[3];
    float vel[3];
    float type;              // 0=jet, 1=ski, 2=hit, 3=explosion, 4=spark
    float age;
};

struct RenderFlag {          // 8 floats = 32 bytes
    float pos[3];
    float team;              // 0=red, 1=blue
    float state;             // 0=at-base, 1=carried, 2=dropped
    float carrierIdx;        // -1 or player idx
    float reserved[2];
};

// Static arrays in BSS — fixed capacity, no allocation
static RenderPlayer       g_rPlayers[16];           // 16 max players
static RenderProjectile   g_rProjectiles[256];
static RenderParticle     g_rParticles[1024];
static RenderFlag         g_rFlags[2];
static int g_rPlayerCount = 0;
static int g_rProjectileCount = 0;
static int g_rParticleCount = 0;
```

After each `simulate(dt)`, populate these arrays from the live simulation state. Then export base addresses and counts:

```cpp
extern "C" EMSCRIPTEN_KEEPALIVE float* getPlayerStatePtr()      { return (float*)g_rPlayers; }
extern "C" EMSCRIPTEN_KEEPALIVE int    getPlayerStateCount()    { return g_rPlayerCount; }
extern "C" EMSCRIPTEN_KEEPALIVE int    getPlayerStateStride()   { return sizeof(RenderPlayer)/4; }

extern "C" EMSCRIPTEN_KEEPALIVE float* getProjectileStatePtr()  { return (float*)g_rProjectiles; }
extern "C" EMSCRIPTEN_KEEPALIVE int    getProjectileStateCount(){ return g_rProjectileCount; }
extern "C" EMSCRIPTEN_KEEPALIVE int    getProjectileStateStride(){ return sizeof(RenderProjectile)/4; }

// ...same pattern for particles, flags
```

JS side reads:

```js
const playersPtr = Module._getPlayerStatePtr();
const playersCount = Module._getPlayerStateCount();
const stride = Module._getPlayerStateStride();   // 32
// Build a typed-array view ONCE at startup; reuse every frame
const playerView = new Float32Array(Module.HEAPF32.buffer, playersPtr, 16 * stride);

// Per frame:
for (let i = 0; i < playersCount; i++) {
    const o = i * stride;
    playerObjects[i].position.set(playerView[o], playerView[o+1], playerView[o+2]);
    playerObjects[i].rotation.set(playerView[o+3], playerView[o+4], playerView[o+5], 'YXZ');
    playerObjects[i].visible = playerView[o+13] > 0.5 && playerView[o+18] > 0.5;
    // ... etc
}
```

**One critical caveat: `Module.HEAPF32.buffer` may detach if WASM memory grows.** Set `INITIAL_MEMORY=64MB, MAXIMUM_MEMORY=64MB, ALLOW_MEMORY_GROWTH=0` in `build.sh` to prevent growth. The simulation comfortably fits in 32MB; 64MB is generous headroom and avoids ever needing to rebuild typed-array views.

### 3.3 Three.js scene structure

```
scene (THREE.Scene)
├── ambientLight       (THREE.HemisphereLight, sky=#9bb5d6 ground=#5a4a32)
├── sunLight           (THREE.DirectionalLight, casts shadows)
│                       position=(2000, 3000, 1500), shadowMapSize=2048×2048
├── terrain            (THREE.Mesh)
│                       geometry=THREE.PlaneGeometry(2048, 2048, 256, 256) displaced by heightmap
│                       material=THREE.MeshStandardMaterial (roughness 0.95, metalness 0)
├── sky                (THREE.Mesh, inverted sphere with gradient shader OR THREE.Sky)
├── buildingsGroup     (THREE.Group containing instanced THREE.InstancedMesh per building type)
├── playersGroup       (THREE.Group containing 16 placeholder THREE.Mesh — capsule for now)
├── projectilesGroup   (THREE.InstancedMesh per type — disc, plasma, grenade as instanced spheres)
├── particlesGroup     (THREE.Points with custom shader for jet flames, ski spray, explosions)
├── flagsGroup         (THREE.Group with 2 cloth-banner meshes)
└── stationsGroup      (THREE.Group of inventory station markers)
```

For R15, **placeholders are acceptable** — capsule meshes for players, simple spheres for projectiles, billboard quads for particles. R18 will replace these with proper assets and PBR materials. The architectural goal of R15 is the *pipeline*, not the visuals.

### 3.4 Terrain handling

Currently the C++ renders the Raindance heightmap. Two options for moving it to Three.js:

**Option A (preferred):** C++ exports the 256×256 heightmap once via:
```cpp
extern "C" EMSCRIPTEN_KEEPALIVE float* getHeightmapPtr() { return g_heightmap; }
extern "C" EMSCRIPTEN_KEEPALIVE int getHeightmapSize() { return 256; }
```
JS builds a `THREE.PlaneGeometry(2048, 2048, 255, 255)`, then in a one-time pass, displaces each vertex Y by `heightView[ix*256 + iz]`. Compute vertex normals via `geometry.computeVertexNormals()`. Done. Static geometry, GPU-resident.

**Option B (fallback):** JS loads the same `raindance.bin` heightmap file directly via `fetch('raindance.bin')` — bypasses WASM entirely. Slightly cleaner separation but means the heightmap file must be a static asset. Either is fine; pick Option A for less plumbing.

### 3.5 Buildings handling

Buildings are static AABB-defined geometry. C++ currently has the building list. Same export pattern:

```cpp
struct RenderBuilding {
    float pos[3];
    float halfExtents[3];
    float type;              // 0=tower, 1=base, 2=generator, 3=turret, 4=station
    float team;              // -1=neutral, 0=red, 1=blue
    float alive;             // for destructible generators
    float reserved[5];
};
static RenderBuilding g_rBuildings[64];
extern "C" EMSCRIPTEN_KEEPALIVE float* getBuildingPtr();
extern "C" EMSCRIPTEN_KEEPALIVE int getBuildingCount();
```

JS reads once at startup → spawns one `THREE.Mesh` per building from a placeholder box geometry of the right size. For R15, all building types render as colored boxes (gray for neutral, dim red/blue for team-owned). R18 will swap in real models.

### 3.6 Camera

`THREE.PerspectiveCamera(g_fov, aspect, 0.1, 5000)`. Read FOV from the existing settings system (`Module._getDiag()` → `fov` field, OR add a dedicated `getCameraFov()` export). Position/rotation driven each frame from `g_rPlayers[localPlayerIdx].pos + (0, 1.7, 0)` and `.rot`.

For R15, **first-person only** (camera attached to local player's head). Third-person and spectator can come in R18.

### 3.7 Render loop

```js
import * as THREE from 'three';

const renderer = new THREE.WebGLRenderer({
    canvas: document.getElementById('canvas'),
    antialias: true,
    powerPreference: 'high-performance'
});
renderer.setPixelRatio(window.devicePixelRatio);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

function loop() {
    if (!Module._isReady || !Module._isReady()) {
        requestAnimationFrame(loop);
        return;
    }
    
    // 1. C++ runs simulation tick (existing main_tick / wasm_main loop)
    Module._tick();   // advances physics, weapons, bots, etc., and populates g_rPlayers etc.
    
    // 2. JS reads state and updates Three.js scene
    syncPlayersFromWASM();
    syncProjectilesFromWASM();
    syncParticlesFromWASM();
    syncFlagsFromWASM();
    syncCameraFromWASM();
    
    // 3. Render
    renderer.render(scene, camera);
    
    requestAnimationFrame(loop);
}
```

**Existing C++ main loop:** currently driven by Emscripten's `emscripten_set_main_loop`. For R15, **add an `extern "C" tick()` export and stop the C++-side main loop** when the Three.js renderer is active. This puts JS in control of timing. Add a `setRenderMode(int mode)` export: 0 = legacy WebGL (current behavior, C++ drives main loop and renders), 1 = Three.js (C++ exposes `tick()`, JS drives main loop and renders).

### 3.8 Additive rollout — `?renderer=three` query flag

**Critical: do NOT remove or modify the existing C++ render code.** The new Three.js renderer must be opt-in via:

```js
// At top of index.html / shell.html JS:
const useThree = new URLSearchParams(location.search).get('renderer') === 'three';

if (useThree) {
    Module.onRuntimeInitialized = async () => {
        Module._setRenderMode(1);  // disable C++ render loop
        await import('./renderer.js').then(m => m.start());
    };
} else {
    // Existing behavior — Module._main() runs, C++ drives everything
}
```

Test plan:
- `https://uptuse.github.io/tribes/` → existing WebGL renderer (unchanged) ✓
- `https://uptuse.github.io/tribes/?renderer=three` → new Three.js renderer ✓

This lets us A/B compare side-by-side, fall back instantly if the Three.js path has bugs, and ship to users only when ready (R17 cutover).

---

## 4. File layout

New files:
- `renderer.js` — Three.js scene setup, render loop, WASM-state sync (~400 lines)
- `renderer-helpers.js` (optional) — heightmap → geometry, building → mesh helpers (~100 lines)
- No build step — both files are vanilla ES modules loaded via `<script type="module">` and the importmap

C++ changes (`wasm_main.cpp`):
- Add `RenderPlayer/Projectile/Particle/Flag/Building` structs + global arrays
- Add `populateRenderState()` called at end of each `simulate(dt)`
- Add export functions: `getPlayerStatePtr/Count/Stride`, same for projectile/particle/flag/building, plus `getHeightmapPtr/Size`, `getCameraFov`, `tick`, `setRenderMode`, `isReady`
- Add `g_renderMode = 0` global; if `==1`, skip the C++ `glClear/glDraw*` calls in the existing render path
- **Do NOT remove existing render code** — guard it behind `if (g_renderMode == 0)` so legacy path still works

`build.sh` changes:
- Add new exports: `_getPlayerStatePtr,_getPlayerStateCount,_getPlayerStateStride,_getProjectileStatePtr,_getProjectileStateCount,_getProjectileStateStride,_getParticleStatePtr,_getParticleStateCount,_getParticleStateStride,_getFlagStatePtr,_getFlagStateCount,_getBuildingPtr,_getBuildingCount,_getHeightmapPtr,_getHeightmapSize,_getCameraFov,_tick,_setRenderMode,_isReady`
- Add `_HEAPF32` to `EXPORTED_RUNTIME_METHODS`
- Set `INITIAL_MEMORY=67108864`, `MAXIMUM_MEMORY=67108864`, `ALLOW_MEMORY_GROWTH=0`
- Keep all existing exports

`index.html` / `shell.html` changes:
- Add `<script type="importmap">{"imports":{"three":"https://unpkg.com/three@0.170.0/build/three.module.js"}}</script>` in `<head>`
- Add `?renderer=three` flag detection in main script
- Conditionally `import('./renderer.js')` if flag set

---

## 5. Acceptance criteria (must hit 8 of 10)

1. ✅ `https://uptuse.github.io/tribes/` (no flag) renders identically to `629c5c2` — zero regression
2. ✅ `https://uptuse.github.io/tribes/?renderer=three` loads, no console errors, terrain visible
3. ✅ Terrain renders from C++-exported heightmap (Option A above) with correct elevation
4. ✅ Sky and lighting present — directional sun + hemisphere ambient, ACESFilmic tone mapping active
5. ✅ All buildings (towers, bases, generators, turrets, stations) render as colored placeholder boxes at correct positions
6. ✅ Players render as capsule placeholders, follow C++ physics in real-time, team color visible
7. ✅ Projectiles render as colored sphere placeholders for disc/chain/plasma/grenade
8. ✅ First-person camera follows local player position + look direction at 60 FPS
9. ✅ HUD overlay (score, compass, ammo, HP/EN bars, crosshair, kill feed) continues working unchanged
10. ✅ Manus headless screenshot of `?renderer=three` shows terrain + sky + buildings (NOT all-black) — proving SwiftShader compatibility

Bonus (nice-to-haves, not gating):
- B1. Skybox uses `THREE.Sky` for atmosphere-style sun + horizon (one-line addition)
- B2. PCF soft shadows from sun on terrain and buildings
- B3. Window resize re-sets renderer + camera aspect

---

## 6. Compile/grep guardrails (do not regress)

- `! grep -nE 'EM_ASM[^(]*\(.*\$1[6-9]'` must pass (legacy guardrail, still applies)
- `! grep -nE 'malloc\(' wasm_main.cpp` must pass — render-state structs are static, no per-frame allocation
- `! grep -nE 'std::vector' wasm_main.cpp | grep -v g_botPath` should remain at one match — A* nav grid only
- `! grep -nE '#version 300 es' wasm_main.cpp | wc -l` should NOT increase (no new GLSL programs in legacy renderer)
- New: every `_get*Ptr` export must have a matching `_get*Count` (typed array length safety)

---

## 7. Performance budget

- Per-frame WASM tick: ≤ 4ms target, ≤ 8ms hard ceiling
- Per-frame JS sync (typed-array reads → Three.js Object3D updates): ≤ 1ms for 16 players + 256 projectiles + 1024 particles
- Three.js render: ≤ 8ms with shadows on, 1024×768 canvas
- Total frame budget: ≤ 16.6ms (60 FPS)

If exceeded, the most likely culprit is shadow map size — drop from 2048 to 1024.

---

## 8. Things explicitly NOT in this round

- Real player models (R18 — glTF / FBX import + skeletal animation)
- Real building models (R18)
- PBR materials, IBL environment maps, post-processing (R18)
- Particle visual upgrade beyond `THREE.Points` placeholders (R18)
- Removing the legacy WebGL renderer (R17 — cutover round)
- Multiplayer / networking (R16 — separate Opus brief, network architecture)

---

## 9. Time budget

This is a 2-3 hour Opus round. Most of the time is in `renderer.js` (the new Three.js code) — the C++ side changes are mostly mechanical struct definitions + populate functions + exports.

Suggested split:
- C++ struct + populate + exports + render-mode flag: ~30 min
- `build.sh` exports + memory settings: ~5 min
- `renderer.js` Three.js setup + scene graph: ~45 min
- `renderer.js` WASM-state sync + render loop: ~30 min
- `renderer.js` heightmap + buildings + camera: ~30 min
- `index.html` / `shell.html` flag wiring + importmap: ~10 min
- Testing both code paths (`?renderer=three` and default): ~15 min

---

## 10. After R15 lands

- Manus reviews via headless screenshot at `?renderer=three` URL — should see terrain + sky + buildings (the all-black bug from R14 self-resolves because Three.js doesn't use `#version 300 es` problematic configs)
- Manus accepts R15 by visual + code inspection
- Manus pushes **R16: Network architecture (OPUS, multiplayer protocol)** — designs WebRTC-DataChannel vs WebSocket-server vs hybrid (e.g., Geckos.io / Colyseus pattern); produces a ranked decision with anti-cheat, latency, hosting cost, browser compat trade-offs scored. Opus picks one and provides a minimal scaffold (lobby flow, client-server message format, snapshot/delta protocol stub)
- After R16, user switches Claude back to Sonnet 4.6 for R17 (Three.js cutover) onward

---

## 11. Decision authority for ambiguities

If Opus encounters ambiguity not covered above:

- **Performance vs visual fidelity:** prefer 60 FPS with simpler visuals (this is a placeholder round; R18 cashes in on quality)
- **Three.js feature choice:** prefer well-documented, stable APIs over bleeding-edge (e.g., `EffectComposer` not `RenderPipeline` in r170)
- **WASM↔JS boundary:** when in doubt, expose more from C++; never marshal via JSON/string in the per-frame path
- **Memory layout:** when in doubt, pad structs to 32-float (128-byte) boundaries for cacheline friendliness
- **File organization:** if `renderer.js` exceeds ~600 lines, split into `renderer-core.js`, `renderer-sync.js`, `renderer-scene.js` — but don't over-fragment

---

## 12. Roadmap context (for Opus's situational awareness)

- **R15 (this round, OPUS):** Three.js architecture + scaffold, behind `?renderer=three` flag
- **R16 (next round, OPUS):** Network architecture — multiplayer protocol decision + scaffold
- **R17 (Sonnet):** Three.js cutover — make Three.js the default, retire legacy WebGL after one round of fallback safety
- **R18 (Sonnet):** Visual quality cascade — PBR materials, real player/building models via glTF, shadows, particles, post-processing
- **R19 (Sonnet):** Network implementation per R16 spec — server, client prediction, snapshot/delta, lag compensation
- **R20+ (Sonnet):** Polish, balance, content (additional maps, weapon tuning, audio expansion)

The Three.js migration unlocks ~6 future rounds of visual + content work that would otherwise be blocked by the hand-rolled WebGL ceiling.
