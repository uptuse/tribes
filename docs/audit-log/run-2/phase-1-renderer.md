# Phase 1 — Adversarial Convergence Review: renderer.js (Run 2)

**Target:** `renderer.js` — 6,094 lines, the main renderer monolith
**Date:** 2026-04-29
**Panel:** Carmack, ryg, Abrash, Muratori, Acton, Barrett, Ive
**Run 2 mandate:** VALIDATE, CHALLENGE, and DEEPEN Run 1 findings against actual source code.
**Prior art:** `run-1/phase-1-renderer.md`, `refactoring-plan.md`, `patterns.md`

---

## Section 1: Run 1 Finding Validation Against Source Code

### 1.1 S1 HEAPF32 Buffer Detachment — RECLASSIFIED from Critical to Non-Issue

**Run 1 claim:** `playerView`, `projectileView`, `particleView`, `flagView` are Float32Array views into `Module.HEAPF32.buffer`. If WASM memory grows, the underlying ArrayBuffer is detached. All reads silently return `undefined`.

**Run 2 Phase 2 downgrade rationale:** `_emscripten_resize_heap` aborts rather than growing.

**Run 2 Phase 1 verification:**

Examined `tribes.js` lines 4354-4361:
```javascript
var abortOnCannotGrowMemory = (requestedSize) => {
    abort(`Cannot enlarge memory arrays to size ${requestedSize} bytes (OOM)...`);
};
var _emscripten_resize_heap = (requestedSize) => {
    abortOnCannotGrowMemory(requestedSize);
};
```

This is definitive. The WASM module was compiled **without** `-sALLOW_MEMORY_GROWTH`. Any `_emscripten_resize_heap` call aborts the entire runtime. The buffer **cannot** be detached during normal execution.

**Carmack:** Run 2 Phase 2's reclassification is correct. The buffer is immutable after initialization. The views created at line 3655-3663 (`initStateViews`) and line 645/150 (terrain init) are safe for the lifetime of the program. If Emscripten ever recompiles with memory growth enabled, this becomes a real critical again — so the `refreshViews()` recommendation from Run 1 remains good *defensive* practice, but it's not a bug fix. It's insurance.

**ryg:** Agreed. But I want to flag that line 150 and 645 both create *local* Float32Array views during init for heightmap reading. These are used once and discarded. Even if memory could grow, these would be consumed before any growth event. The persistent views at 3655-3663 are the ones that matter, and they're safe.

**Verdict: Run 2 Phase 2 downgrade is CORRECT. S1 is a non-issue under current compilation flags.**

---

### 1.2 W4 Night Ambient Light Color Typo — CONFIRMED but SEVERITY REDUCED

**Run 1 claim:** Line 595: `new THREE.AmbientLight(0x3040608, 0)` — 7 hex digits, garbage color. Should be `0x304060`.

**Run 2 verification:**

Line 595 confirmed:
```javascript
const nightAmbient = new THREE.AmbientLight(0x3040608, 0);
```

`0x3040608` is indeed 7 hex digits. JavaScript parses it as `0x03040608` = 50,529,800. As a Three.js color:
- R = `(50529800 >> 16) & 0xFF` = `0x04` = 4/255 ≈ 0.016
- G = `(50529800 >> 8) & 0xFF` = `0x06` = 6/255 ≈ 0.024
- B = `50529800 & 0xFF` = `0x08` = 8/255 ≈ 0.031

This is extremely dark — almost black. Not "garbage" in the sense of a bright wrong color, but not the intended `0x304060` (R=48, G=64, B=96 — a visible blue-grey).

**HOWEVER** — critical context Run 1 missed:

1. The initial intensity is `0` (second argument). The light starts invisible.
2. Line 468-471 in the DayNight `_apply` function:
```javascript
if (window.__nightAmbient) {
    const nightFactor = 1.0 - dayMix;
    window.__nightAmbient.intensity = nightFactor * 0.6;
    window.__nightAmbient.color.setHex(0x304060);  // ← CORRECT value
}
```

The DayNight cycle **overwrites** the color to `0x304060` every frame. By the time the light has any non-zero intensity, its color has already been corrected.

**Muratori:** So Run 1 was right about the typo but wrong about the impact. The bug is entirely cosmetic-theoretical — it's corrected before it's ever visible. Still fix it because the next person reading `initLights()` will think the night ambient is supposed to be near-black.

**Verdict: Typo CONFIRMED. Severity reduced from Critical to Low (cosmetic code hygiene). No visual bug in practice.**

---

### 1.3 C1 2-Team Hardcoding — CONFIRMED and DEEPER THAN RUN 1 STATED

**Run 1 claim:** `MAX_PLAYERS=16` at line 61, `TEAM_COLORS` has 3 entries at line 62, `_flagStateByTeam` is 2-element at line 77.

**Run 2 verification — full extent of hardcoding:**

| Location | Code | Issue |
|---|---|---|
| Line 61 | `const MAX_PLAYERS = 16` | Should be 64 (4×16) |
| Line 62 | `TEAM_COLORS = [0xC8302C, 0x2C5AC8, 0x808080]` | 3 entries (R, B, neutral). Need Phoenix gold + Starwolf green |
| Line 63 | `TEAM_TINT_HEX = [0xCC4444, 0x4477CC, 0x808080]` | Same — 3 entries |
| Line 77 | `_flagStateByTeam = [0, 0]` | 2 teams only |
| Line 3096-3097 | `for (let i = 0; i < 2; i++)` in `initFlags()` | Creates exactly 2 flags |
| Line 3110 | `color: TEAM_COLORS[i]` | Only indexed 0 and 1 |
| Line 3657 | `MAX_PLAYERS * playerStride` | View capped at 16 players |
| Line 3663 | `2 * flagStride` in `flagView` | View for exactly 2 flags |
| Line 3957 | `for (let i = 0; i < 2; i++)` in `syncFlags()` | Syncs only 2 flags |
| Line 4286-4288 | `for (let i = 0; i < 2; i++)` in `syncCanonicalAnims()` | Flag state for 2 teams |
| Line 3853 | `team === 0 ? cbColors.red : (team === 1 ? cbColors.blue : ...)` | Binary team check |
| Line 1396 | `_teamAccent(teamIdx)` | Only handles 0 and 1; returns grey for others |

**Carmack:** Run 1 counted 11+ files. In renderer.js alone I count 12 separate 2-team assumptions. The `_teamAccent` function is particularly insidious — it has a default fallback to grey, which means adding teams 2 and 3 won't crash, they'll just look wrong silently. That's the worst kind of bug: it doesn't fail, it misleads.

**Barrett:** The MAX_PLAYERS=16 issue has a cascading effect. The playerMeshes array is initialized with 16 slots (line 2948-2965), the shieldSpheres array is 16 entries, the nameplate sprites are 16 entries. Going to 64 means 4× GPU resources for player meshes — which is fine given they're tiny, but the nameplate canvas textures (512×64 each) would go from 2MB to 8MB of texture memory for nameplates alone.

**Verdict: CONFIRMED and DEEPENED. More hardcoding than Run 1 documented. The team accent fallback-to-grey is a new sub-finding.**

---

### 1.4 C5 Particle System Fragmentation — CONFIRMED: 6 Systems, 5 Active

**Run 1 claim:** 6 separate particle systems, each duplicating the same pool+geometry+shader+points pattern.

**Run 2 verification with actual line ranges:**

| # | System | Function | Lines | Active? | Pool Size |
|---|---|---|---|---|---|
| 1 | General (WASM-driven) | `initParticles()` | 3459-3486 | Yes | 1024 |
| 2 | Jet exhaust | `initJetExhaust()` | 4457-4506 | **No** (commented out L184) | 128 |
| 3 | Ski sparks | `initSkiParticles()` | 4520-4634 | Yes | 256 |
| 4 | Projectile trails | `initProjectileTrails()` | 4644-4832 | Yes | 512 |
| 5 | Explosion fireballs+sparks | `initExplosionFX()` | 4833-5019 | Yes | 8 fireballs + 512 sparks |
| 6 | Night fairies | `initNightFairies()` | 5022-5265 | Yes | 44,800 |

**Run 1 line estimates vs actuals:**
- Run 1 said `initParticles()` at line 3459, `initJetExhaust()` at 4457, `initSkiParticles()` at 4520, `initProjectileTrails()` at 4644, `initExplosionFX()` at 4828, `initNightFairies()` at 5025.
- Actual: 3459, 4457, 4520, 4644, 4833, 5022. Run 1 was within 5 lines on all — good estimates.

**Muratori:** I want to add nuance here. Systems 2-4 (jet, ski, trails) are genuinely identical — clone the SoA Float32Array pool, clone the ShaderMaterial with color change, clone the emit/update loop. That's the fragmentation that should be unified.

But system 5 (explosions) is structurally different — it uses 8 pooled SphereGeometry fireballs with a custom heat-distortion shader, PLUS a spark system. And system 6 (fairies) is radically different — it's a GPU-driven vertex shader animation with 44,800 particles using a heightmap texture for terrain-following. You can't just "parameterize" fairies into the same system as ski sparks.

The real unification target is systems 1-4 (general + jet + ski + trails = ~400 lines → ~150 unified). Explosions and fairies should stay separate because their architectures genuinely differ.

**Carmack:** Agreed. Run 1's "6 systems → 1" is over-aggressive. "6 systems → 3" (unified emit-pool for small particles, explosion pool, fairy field) is realistic.

**Verdict: Count CONFIRMED. Unification target CORRECTED from "all 6" to "systems 1-4 merge, 5 and 6 stay separate."**

---

### 1.5 Dead Code — CONFIRMED with Corrections

**Run 1 claim:** ~1,000 lines of dead code: rain, grass ring, dust layer, jet exhaust are disabled.

**Run 2 verification:**

| Subsystem | Lines | Status | Evidence |
|---|---|---|---|
| Rain | 3373-3457 (~85 lines) | **Opt-in only** (`?rain=on`) | L194: URL param guard |
| Rain update | 3410-3440 (~30) | Runs unconditionally but early-bails | L5318: `updateRain(1/60, camera.position)` called; L3410: `if (!_rainSystem || !_rainPos) return;` |
| Jet exhaust | 4457-4519 (~63 lines) | **Dead** | L184: commented out call |
| Grass ring | 5532-5822 (~290 lines) | **Opt-in only** (`?ring=on`) | L207: URL param guard |
| Dust layer | 5823-6094 (~272 lines) | **Dead** (immediate return) | L5824: `return;` as first statement |
| Terrain carve | 1147-1212 (~65 lines) | **Dead** (commented out call) | L176: call commented out |
| Grass init/update (old) | Various | **Dead** (calls removed) | L226+: comments say "no longer called" |

**Actual dead line count:**
- Hard dead (never executes): jet exhaust (63) + dust layer (272) + terrain carve (65) = **400 lines**
- Opt-in only (executes only with URL params that no player knows about): rain (115) + grass ring (290) = **405 lines**
- Total disabled or effectively dead: **~805 lines**

**Acton:** Run 1 said "~1,000 lines." The real number depends on what you count. If you count opt-in-only code as dead (no player will type `?rain=on`), it's ~805. Run 1 may have been counting comments and spacing too, which would push it past 1,000. Either way, the order of magnitude is right.

**Barrett:** One thing Run 1 missed: the dust layer's `return;` at line 5824 is particularly wasteful because `initDustLayer()` is still called from `start()` at line 210, wrapped in try/catch. The function enters, hits `return`, and exits — but the try/catch wrapper still runs. More importantly, `updateDustLayer(t)` is called every frame at line 5359, and while the guard `if (!_dustPoints) return;` bails, that's still a function call + branch per frame forever.

**Verdict: CONFIRMED. Actual count is ~805 lines of disabled code. Run 1's "~1,000" was slightly high but directionally correct.**

---

### 1.6 Remote Players Hidden — CONFIRMED

**Run 1 claim:** Line ~3792 hides all non-local players.

**Run 2 verification:**

Line 3778-3782:
```javascript
// R32.63.4: hide ALL non-local players (bots disabled)
if (i !== localIdx) {
    mesh.visible = false;
    if (nameplateSprites[i]) nameplateSprites[i].visible = false;
    if (shield) shield.visible = false;
    continue;
}
```

**CONFIRMED.** Every non-local player is invisible. The comment says "bots disabled" — this was a deliberate disable when bot rendering was removed, not a test hack as Run 1 characterized it.

**Muratori:** Run 1 called this a "test hack that's been shipped." The comment says otherwise — it's an intentional disable because bots were turned off. The intent is clear: when multiplayer networking is active, this `continue` would need to be removed. But right now there are no remote players to render. So calling it "dead code" is more accurate than "bug."

**Barrett:** The practical issue is: when multiplayer IS enabled, someone needs to remember to remove these 5 lines. And the `Characters.sync()` call at line 5310 ALSO skips non-local players in its own way. There are TWO gatekeepers that would need updating.

**Verdict: CONFIRMED at line 3778. Reclassified from "test hack" to "intentional single-player disable." Risk is forgetting to re-enable for multiplayer.**

---

## Section 2: Bugs Run 1 Missed

### N1: loadMap() GPU Memory Leak (Medium-High)

**Lines 5437-5500.** When `loadMap(doc)` is called:

```javascript
for (const entry of buildingMeshes) scene.remove(entry.mesh);
buildingMeshes.length = 0;
```

This removes building meshes from the scene but **never calls `.dispose()`** on their geometries, materials, or textures. Each `createBuildingMesh()` call creates new `MeshStandardMaterial` instances (line 1217-1290: `baseMat`, `accentMat`, plus panel materials, ring materials, etc.). Each has GPU-side uniform buffers and texture uploads.

For a single map reload: ~40 buildings × ~3 materials each × ~200 bytes GPU overhead = negligible. But `loadMap()` could be called repeatedly (map rotation, editor previews), and the leak is unbounded.

**Carmack:** This is a real leak, but bounded by usage pattern. In production (match-based rotation), you'd load maybe 3-4 maps per session. The geometry leak is the bigger concern — each building group has 3-6 child meshes with unique geometries. That's 120-240 unreleased GPU buffers per map change.

**Fix:** Add a `disposeBuildings()` helper that traverses each mesh group, calling `.geometry.dispose()` and `.material.dispose()` on every child, before clearing the array.

---

### N2: applyQuality() Leaks EffectComposer Render Targets (Medium)

**Lines 4364-4381.** When quality is changed:

```javascript
function applyQuality(newQuality) {
    ...
    initPostProcessing();  // Creates new EffectComposer
    ...
}
```

`initPostProcessing()` (line 3487-3557) creates a new `EffectComposer`, `UnrealBloomPass`, and potentially `ShaderPass`. The old composer's WebGL render targets (fullscreen FBOs) are never disposed. Each quality change leaks:
- 2 fullscreen render targets from EffectComposer (~32MB at 1080p RGBA16F)
- 2 bloom ping-pong targets (~8MB at half-res)

**ryg:** This is the kind of leak that's invisible in testing (who changes quality more than once?) but would bite in an editor workflow or automated test harness. The fix is trivial: dispose the old composer before creating a new one.

---

### N3: initProjectiles() Creates 256 Unique Geometries (High — Performance)

**Lines 3079-3094:**
```javascript
for (let i = 0; i < MAX_PROJECTILES; i++) {
    const geom = new THREE.SphereGeometry(0.20, 10, 8);
    const mat = new THREE.MeshStandardMaterial({...});
    const mesh = new THREE.Mesh(geom, mat);
    ...
    projectileMeshes.push(mesh);
}
```

Each of 256 projectiles gets:
- Its own `SphereGeometry` instance (identical parameters every time)
- Its own `MeshStandardMaterial` instance

This means 256 unique geometry buffers on the GPU for identical spheres, and 256 material instances that prevent Three.js from batching draw calls.

**Acton:** Run 1's ryg identified 256 individual draw calls from projectiles but attributed it to "no instancing." The root cause is deeper — even without InstancedMesh, sharing one geometry and one material would let Three.js auto-batch these. Right now they can't batch because every material instance is unique (even though properties are identical).

**Quick fix (before full instancing):** Share one geometry and one material across all projectiles. Color changes go through `mesh.material.color.setHex()` — which already happens in `syncProjectiles()`.

Wait — `syncProjectiles()` sets color per-projectile based on type. If they share one material, changing color on one changes all. So you need per-type materials (9 types from PROJ_COLORS), not per-projectile. That's 9 materials instead of 256.

**Carmack:** The real fix is InstancedMesh with per-instance color attributes. But the interim fix of shared geometry + 9 per-type materials would cut draw calls from 256 to ~20 (batched per type) immediately.

---

### N4: DayNight freeze/unfreeze API is Broken (Low)

The DayNight IIFE return object (around line 502) exposes:
```javascript
return { update, _apply, freeze: function(h) { this._frozen = h; },
         unfreeze: function() { this._frozen = null; },
         _frozen: null, dayMix: 1.0, sunDir: new THREE.Vector3(0, 1, 0) };
```

But inside `update()`, the frozen check uses `_frozen01` (a closure variable, line 413):
```javascript
if (_frozen01 === null) {
    _frozen01 = 0.5; // noon
    _apply(_frozen01);
}
```

The external `freeze(h)` sets `this._frozen` on the return object, but `update()` reads `_frozen01` from the closure — a completely different variable. Calling `DayNight.freeze(12)` does nothing. The only working freeze mechanism is the `?daynight=off` URL parameter, which sets `cycleSeconds = Infinity`.

**Muratori:** This is a classic IIFE scoping bug. Two variables that should be one. Low severity because nobody seems to be calling `DayNight.freeze()` from external code, but it's a trap for the phase system integration.

---

### N5: Binary Blob Parsing Has No Bounds Checking (Medium)

**Lines 1842-2416.** The `initInteriorShapes()` function parses `raindance_meshes.bin` using a DataView with a manual `off` pointer:

```javascript
const dv = new DataView(blob);
let off = 0;
...
const nameLen = dv.getUint8(off); off += 1;
const nameBytes = new Uint8Array(blob, off, nameLen); off += nameLen;
const nVerts = dv.getUint32(off, true); off += 4;
```

There is **no check** that `off` is within `blob.byteLength` before any read. A truncated or corrupted binary file would throw a `RangeError: Offset is outside the bounds of the DataView` with no indication of which field failed or at what offset.

**Barrett:** This function is wrapped in a try/catch at the top level, so corruption won't crash the game. But the error message will be useless for debugging. Add a single bounds check: `if (off + 4 > blob.byteLength) throw new Error('blob truncated at offset ' + off);` before each major read.

---

### N6: initScene() Exposes Uninitialized camera to window (Low)

**Line 340:**
```javascript
try { window.scene = scene; window.camera = camera; window.renderer = renderer; } catch(e) {}
```

At this point in `start()`, `camera` is still `undefined` — it's created later in `initStateViews()` (line 3672). So `window.camera = undefined` is exposed to the global scope. Any debug script reading `window.camera` between `initScene()` and `initStateViews()` gets `undefined`.

The `_tribesDebug` object (line 342) has the same issue — it captures `camera: camera` which is `undefined`, and the reference is never updated.

**Carmack:** Trivial. But it's the kind of thing that wastes 30 minutes when someone writes a debug overlay and gets "Cannot read property 'position' of undefined."

---

### N7: Terrain onBeforeCompile Shader Injection Fragility (Medium)

**Lines 920-1130.** The terrain material uses `mat.onBeforeCompile` to inject custom GLSL by string-replacing Three.js's internal shader chunks:

```javascript
shader.vertexShader = shader.vertexShader
    .replace('#include <common>', `#include <common>\n...`)
    .replace('#include <beginnormal_vertex>', `vec3 objectNormal = ...`)
    .replace('#include <begin_vertex>', `#include <begin_vertex>\n...`);
```

This is coupled to Three.js's internal shader chunk names. If Three.js renames or restructures these chunks (which has happened between major versions — e.g., `normal_fragment_begin` → `normal_fragment_maps`), the `.replace()` calls silently do nothing (no match = no replacement), and the terrain renders with default Three.js behavior. No error, just wrong output.

**ryg:** The current Three.js import is from `'three'` without a version pin in the import map. If the CDN updates, the shader injection could silently break. This is a documented pattern in Three.js — `onBeforeCompile` is an escape hatch, not an API contract. The chunks it depends on:
- `#include <common>`
- `#include <beginnormal_vertex>`
- `#include <begin_vertex>`
- `#include <map_fragment>`
- `#include <normal_fragment_maps>`
- `#include <roughnessmap_fragment>`

All six must exist and match verbatim. That's 6 fragile coupling points to Three.js internals.

**Mitigation:** Pin Three.js version in the import map. Add a startup assertion that each `.replace()` actually changed the string (compare before/after length).

---

### N8: No dispose() on Module-Level Resources (Medium — Lifecycle)

The entire renderer has no cleanup path. There are exactly 8 `.dispose()` calls in the file:
- Lines 537-538: HDR texture + PMREM generator (local to callback)
- Line 549, 567: PMREM generators in error paths
- Lines 3010-3011: Nameplate sprite material+map on rebuild
- Line 3030: Old player mesh traversal on armor swap
- Line 4374: Shadow map on quality change

Missing dispose calls:
- Terrain geometry, material, and 3 array textures (~60MB GPU)
- All building geometries and materials
- All interior shape geometries and materials
- 256 projectile geometries and materials
- All particle system geometries and materials
- All 6+ CanvasTextures from procedural generation
- The EffectComposer and its render targets
- The HDRI environment map

**Abrash:** This doesn't matter for a single-page game that never unloads. But it's a hard blocker for: map rotation (loadMap partially handles it), scene editor (hot reload), and any testing framework. The refactoring plan should make `dispose()` mandatory on every extracted module.

---

## Section 3: Challenge the Extraction Plan

### The Room — Expert Debate on Refactoring Plan

---

**Carmack:** I've read the extraction plan. 15 modules from renderer.js, plus the polish decomposition. Let me state my main concern upfront: the plan is well-structured but the extraction ORDER has one critical mistake. It puts terrain first. Terrain should be THIRD, not first.

**Muratori:** Wait. The plan says terrain first because "everything depends on terrain height." That's true — `sampleTerrainH` is called by characters, camera, particles, buildings. Why not extract it first?

**Carmack:** Because terrain is the MOST COMPLEX extraction. The terrain shader has 200+ lines of custom GLSL injected via `onBeforeCompile`. The material holds references to 3 DataArrayTextures, the heightmap data, the splat data, and a shader reference stored in `userData`. The `sampleTerrainH` function reads from `_htData` which is populated during init. The terrain carve function mutates the geometry AND the heightmap copy.

Compare that to the shared constants module (player_state.js) and team config — those are 50-line files with zero behavior. Extract the trivial things first. Build confidence. THEN tackle terrain.

**Barrett:** I agree. The plan actually DOES put constants first (player_state.js and team_config.js as steps 1-2). Terrain is step 3. So the extraction order IS:
1. player_state.js (constants)
2. team_config.js (constants)
3. renderer_terrain.js (complex)
4. renderer_particles.js (medium)
5. renderer_camera.js (medium)
6. renderer_daynight.js (easy — already an IIFE)
7. renderer_interiors.js (complex)
8. renderer_postprocess.js (easy)
9. renderer_players.js (medium)

**Carmack:** Right. My concern is step 3. I'd push terrain to step 5 or 6, after DayNight and particles have been extracted successfully. Here's why: if terrain extraction breaks the game, you have a black screen. If particles or DayNight break, you have a playable game with cosmetic issues. Start with the extractions where failure is survivable.

My recommended order:
1. player_state.js (constants — zero risk)
2. team_config.js (constants — zero risk)
3. renderer_daynight.js (self-contained IIFE — low risk)
4. renderer_postprocess.js (clean EffectComposer boundary — low risk)
5. renderer_particles.js (unified, replaces fragmented — medium risk)
6. renderer_terrain.js (shader injection, many consumers — HIGHEST risk)
7. renderer_camera.js (touches input, spectator, aim — medium risk)
8. renderer_interiors.js (binary parsing, collision — medium-high risk)
9. renderer_players.js (depends on everything above — medium risk)

**Muratori:** I'll push back on one thing. The plan says 15 modules — that's too many for a 6K-line file. After extraction, the plan claims renderer.js becomes ~800 lines. That means the average module is ~350 lines. Some (like player_state.js at 50 lines) are tiny. Others (like terrain at 570 lines) are substantial. The granularity is uneven.

I count the REAL modules needed:
1. **player_state.js** — shared constants (50 lines)
2. **team_config.js** — shared constants (30 lines)
3. **renderer_terrain.js** — terrain init + heightmap + shader (~570 lines)
4. **renderer_particles.js** — unified particles for systems 1-4 (~200 lines)
5. **renderer_camera.js** — camera + spectator + aim (~230 lines)
6. **renderer_daynight.js** — cycle + light management (~160 lines)
7. **renderer_interiors.js** — .dis mesh loading + placement (~575 lines)
8. **renderer_postprocess.js** — composer pipeline (~165 lines)

That's 8, not 15. The plan also proposes extracting buildings, players, collision, weapon viewmodel, and base accents as separate modules. But buildings (lines 1217-1640) are ALREADY partially in `renderer_buildings.js`. Players (2789-3075) share material references with the weapon viewmodel. Collision (2420-2510) is 85 lines — too small for its own module.

**Acton:** Muratori's right. The 15-module plan has too many small files. A 50-line module for collision registration? That's a function, not a module. The threshold should be: if it's under 100 lines and has no independent state, it belongs in an adjacent module.

My proposed merge:
- Collision (85 lines) → stays in renderer.js (it's a utility function)
- Base accents (150 lines) → absorb into buildings
- Weapon viewmodel (210 lines) → stays in renderer.js until converted to GLB
- Custom models (55 lines) → stays in renderer.js (single model load)
- Players (295 lines) → extract only when multiplayer requires it

**Carmack:** Agreed on reducing the count. But I want to flag the three MOST DANGEROUS extractions:

**Danger #1: Terrain.** The `onBeforeCompile` shader injection means the material and the geometry are deeply coupled. The shader references uniforms set during init, the material holds `userData.shader` for live PBR toggling (line 1131-1140), and `sampleTerrainH` depends on closure variables (`_htData`, `_htSize`, `_htScale`) that must be exported. Any mistake in moving the shader code will silently produce a default-lit grey terrain — no error, just wrong output.

**Danger #2: Camera.** `syncCamera()` touches pointer lock (via mouse input), spectator mode (death orbit), 3P chase camera (terrain collision), aim point calculation (fed back to WASM via `Module._setLocalAimPoint3P`), and camera state exposed as `window._tribesCamDist`/`window._tribesCamHeight`. There are 6 code paths (1P alive, 3P alive, mid-toggle blend, spectator, invalid index, unspawned). Testing all 6 is critical.

**Danger #3: Interiors.** The binary blob parser is bespoke, position-dependent, and has no bounds checking (new finding N5). The geometry enhancement pipeline (crease normals, midpoint subdivision) is 300+ lines of non-trivial mesh processing. Moving it to a separate file means moving 8 nested helper functions and their closures.

**ryg:** One thing the plan doesn't address: the render loop coupling. After extraction, the render loop in renderer.js will call `updateTerrain(dt)`, `updateParticles(dt)`, `updateCamera(dt)`, etc. But the ORDER of these calls matters — camera must run after players (to read position), particles must run after camera (to know emission points), DayNight must run before everything (to set light state).

The plan needs an explicit frame update order contract. Something like:
```
1. DayNight.update(dt)
2. syncPlayers(t)
3. Characters.sync(...)
4. syncProjectiles()
5. syncFlags(t)
6. syncParticles()
7. syncCamera()        ← needs player position from step 2
8. particles.update()  ← needs camera position from step 7
9. composer.render()
```

If anyone reorders these imports or update calls, subtle bugs appear. The order should be documented in the module header as an `@ai-contract` INIT_ORDER/UPDATE_ORDER.

**Ive:** The visual coherence concern. After 8 extractions, who owns the LOOK of the game? Right now, renderer.js is the single authority — every visual decision is in one file, which means contradictions are visible by scrolling. With 8 modules, a team color mismatch between particles and buildings might not be caught because the code is in different files.

The `team_config.js` module addresses colors. But roughness/metalness ranges, emissive intensity conventions, shadow bias values — those are scattered across every material creation site. The extraction plan should include a `renderer_constants.js` that defines visual conventions (base roughness range, emissive intensity caps, shadow bias) alongside the team/player constants.

---

### Extraction Plan Verdict

**Panel consensus:** The plan is structurally sound but needs three corrections:

1. **Reduce from 15 modules to 8-10.** Merge collision, base accents, custom models, and weapon viewmodel into adjacent modules.

2. **Reorder extractions by risk.** Start with DayNight and post-processing (low risk, clean boundaries), not terrain (highest risk). Constants first, then easy modules, then complex ones.

3. **Add an explicit frame update order contract** and a visual constants module to maintain coherence across extracted files.

---

## Section 4: Validate the Extraction Targets

### 4.1 Shared Constants → `player_state.js`

**Proposed:** ~50 lines, stride offset constants.
**Actual boundary:** Clean. The offsets are used at: lines 3768 (visible), 3769 (alive), 3770 (team), 3771 (armor), 3767 (spawnProt), 3806 (pitch), 3814 (velX, velZ, jetting, skiing), camera offsets at 4084-4087. All are literal numbers.
**Hidden deps:** None. Pure constants.
**Risk:** Minimal. Find-and-replace magic numbers → named constants.
**Verdict:** ✅ Clean extraction target.

### 4.2 Team Config → `team_config.js`

**Proposed:** ~30 lines, 4-tribe definitions.
**Actual boundary:** TEAM_COLORS (L62), TEAM_TINT_HEX (L63), `_teamAccent` (L1390-1393), `_TEAM_EMBLEM_COLORS` (defined somewhere in interiors). Multiple consumers.
**Hidden deps:** `_teamAccent()` is a function, not just data. It returns `{tint, emissive}` tuples. This should be in team_config.js too.
**Risk:** Low for the file. Medium for the ripple — 11+ files to update.
**Verdict:** ✅ Clean target, but track the full consumer list.

### 4.3 Terrain → `renderer_terrain.js`

**Proposed:** ~570 lines.
**Actual line range:** 641-1140 (terrain init + shader) + 87-100 (sampleTerrainH + globals) + 1147-1212 (carve, dead) = ~625 lines.
**Hidden deps:**
- `_htData`, `_htSize`, `_htScale` are closure variables read by sampleTerrainH, which is called by buildings, camera, particles, characters.
- `terrainMesh` is referenced in the render loop for `uTime` uniform update (L5367-5370).
- `_splatData` is read by grass ring init.
- `sampleTerrainH` is exposed as `window._sampleTerrainH`.
- The terrain material's `userData.shader` is read by `__tribesSetTerrainPBR` (L1131-1140).
**Risk:** HIGH. The shader injection, multiple consumers, and live-toggle API make this the hardest extraction.
**Verdict:** ⚠️ Extractable but needs careful interface design. Export: `{initTerrain, sampleTerrainH, getTerrainMesh, setTerrainPBR, disposeTerrain}`.

### 4.4 Unified Particles → `renderer_particles.js`

**Proposed:** ~200 lines unified, replaces ~500.
**Actual ranges to merge:** Jet (4457-4519, 63 lines), Ski (4520-4634, 115 lines), Trails (4644-4832, 189 lines), General (3459-3486, 28 lines) = ~395 lines to replace.
**Hidden deps:**
- Ski particles read player jetting/skiing state from `playerView` in the render loop.
- Trail particles read projectile positions from `projectileView`.
- General particles read from `particleView` (WASM-driven).
- All need `scene.add()` for the Points mesh.
**Risk:** Medium. The visual matching requirement (each unified type must look identical to its predecessor) is the main risk.
**Verdict:** ✅ Good target. Parametric unification of systems 1-4. Systems 5-6 stay separate.

### 4.5 Camera → `renderer_camera.js`

**Proposed:** ~230 lines.
**Actual range:** 4073-4270 (syncCamera, ~200 lines) + spectator enter/exit (~40 lines around 4042-4070) + aim point calculation = ~250 lines.
**Hidden deps:**
- Reads `playerView`, `Module._getLocalPlayerIdx()`, `Module._getThirdPerson()`, `Module._getCameraFov()`.
- Writes to `window._tribesCamDist`, `window._tribesCamHeight`, `window._tribesAimPoint3P`.
- Calls `Module._setLocalAimPoint3P()`.
- References `camera` (module-level), `sunLight` (for shadow texel snapping), `sampleTerrainH`.
- Spectator mode has CSS side effects (letterbox bars via `classList`).
**Risk:** Medium-high. 6 camera modes, WASM bidirectional communication, CSS side effects.
**Verdict:** ⚠️ Extractable but requires careful testing of all 6 modes.

### 4.6 DayNight → `renderer_daynight.js`

**Proposed:** ~160 lines.
**Actual range:** Lines 362-503 (IIFE body) = ~142 lines.
**Hidden deps:**
- Reads `sunLight`, `moonLight`, `hemiLight`, `scene`, `renderer`, `terrainMesh` — all module-level.
- Writes `DayNight.dayMix`, `DayNight.sunDir` (read by custom sky).
- Writes `window.__nightAmbient.intensity`/`.color`.
- Writes `renderer.toneMappingExposure`, `scene.environmentIntensity`, `scene.fog.density`/`.color`.
**Risk:** Low. Already an IIFE with clean boundary. Just needs explicit params instead of closure reads.
**Verdict:** ✅ Cleanest extraction target. Pass light refs as params.

### 4.7 Interiors → `renderer_interiors.js`

**Proposed:** ~575 lines.
**Actual range:** 1840-2416 (initInteriorShapes, ~577 lines) + 1644-1780 (computeCreaseNormals, ~137 lines) + geometry enhancement helpers = ~750+ lines.
**Hidden deps:**
- `interiorShapesGroup` is referenced by terrain carve (dead), bridge railing polish, and collision registration.
- `geomCache`, `matArrayCache`, `_texCache` are local to the init function closure.
- `_genProceduralTex` (L1946-2024) is 78 lines of Canvas 2D procedural texture generation.
- `buildMaterialArray` (L2096-2170) creates cached MeshStandardMaterials.
- `computeCreaseNormals` (L1644-1780) is a standalone geometry utility.
**Risk:** Medium-high. The binary parser, texture generation, and material caching are deeply nested. But they're already encapsulated in the async function's closure, which actually makes extraction easier — the closure becomes a module scope.
**Verdict:** ✅ Good target. The function closure IS the module boundary already.

### 4.8 Post-processing → `renderer_postprocess.js`

**Proposed:** ~165 lines.
**Actual range:** 3487-3557 (initPostProcessing, ~71 lines) + 3559-3636 (_buildCinematicLUT, ~78 lines) + makeVignetteAndGradeShader (~80 lines) = ~229 lines.
**Hidden deps:**
- `composer`, `bloomPass`, `gradePass` are module-level and read/written from `loop()`, `applyQuality()`, and `onResize()`.
- Bloom is dynamically enabled/disabled per-frame based on DayNight.dayMix (L5302-5308).
**Risk:** Low. The EffectComposer is already a self-contained pipeline.
**Verdict:** ✅ Clean target. Export `{initPostProcessing, getComposer, updateBloom, dispose}`.

---

## Section 5: Run 1 Findings — Validated / Challenged / Corrected

| Run 1 Finding | Run 2 Verdict | Notes |
|---|---|---|
| **S1** HEAPF32 detachment (Critical) | **CORRECTED → Non-Issue** | WASM compiled without ALLOW_MEMORY_GROWTH; buffer cannot detach |
| **S2** initPostProcessing camera race | **Validated (Medium)** | Confirmed: camera ref captured once; stale on rebuild |
| **S3** Double-init of rain | **Validated (Low)** | updateRain bails early — wasted function call only |
| **S4** Grass ring memory bomb | **Validated (High)** | Code exists at L5532; opt-in only but still allocates 213MB if enabled |
| **S5** Terrain carve dead code | **Validated (Low)** | Confirmed commented out at L176 |
| **W1** HDRI vs DayNight exposure race | **Validated (Critical race)** | L543 sets 1.15 exposure, L489 sets 0.80+0.20*dayMix — whoever runs last wins |
| **W2** Stale typed-array views after growth | **CORRECTED → Non-Issue** | Same root cause as S1; memory can't grow |
| **W3** buildEnvironmentFromSky null sky | **Validated (Medium)** | L557: sky nulled on HDRI success; buildEnv called from initStateViews |
| **W4** Night ambient color typo | **CORRECTED → Low** | Typo confirmed at L595 but DayNight corrects color at L471 before it's visible |
| **W5** window._tribesCamDist globals | **Validated (Medium)** | Confirmed at L4143-4147 |
| **C1** 2-team hardcoding | **Validated + DEEPENED** | 12+ hardcoded sites in renderer.js; `_teamAccent` silent grey fallback found |
| **C2** No phase system hooks | **Validated (Critical gap)** | No change from Run 1 |
| **C3** Hardcoded Raindance coords | **Validated (High)** | BASE_T0/T1/BRIDGE/BASIN at L760-765 confirmed |
| **C4** No water or lava renderer | **Validated (Medium gap)** | No change from Run 1 |
| **C5** Particle fragmentation (6 systems) | **CORRECTED** | 6 systems confirmed, but only 4 should be unified; explosions and fairies are architecturally distinct |
| **C6** Undocumented player stride offsets | **Validated (High)** | Confirmed throughout syncPlayers/syncCamera |
| Dead code ~1,000 lines | **CORRECTED → ~805 lines** | Actual count: 400 hard dead + 405 opt-in. Run 1 overcounted. |
| Remote players hidden ~L3792 | **CORRECTED → L3778** | Confirmed. Reclassified from "test hack" to "intentional single-player disable" |
| Draw call count ~680+ | **Validated** | No new evidence to challenge; projectile instancing is top priority |
| Material instance duplication | **Validated** | `createBuildingMesh` creates unique materials per building (L1218-1219) |

---

## New Findings Not in Run 1

| ID | Finding | Severity | Description |
|---|---|---|---|
| **N1** | loadMap() GPU memory leak | Medium-High | Building meshes removed from scene but never disposed; geometry and materials leak |
| **N2** | applyQuality() leaks EffectComposer render targets | Medium | Old composer not disposed before creating new one; ~40MB per quality change |
| **N3** | initProjectiles() 256 unique geometries | High (Perf) | Identical SphereGeometry created 256 times; could share one instance |
| **N4** | DayNight freeze/unfreeze API broken | Low | External API sets `this._frozen` but update reads closure `_frozen01` |
| **N5** | Binary blob parsing has no bounds checking | Medium | initInteriorShapes DataView reads with no offset validation |
| **N6** | initScene() exposes undefined camera to window | Low | `window.camera = camera` when camera is still undefined |
| **N7** | Terrain onBeforeCompile shader injection fragility | Medium | 6 string-replace hooks coupled to Three.js internal chunk names; silent failure on version change |
| **N8** | No dispose() on module-level resources | Medium (Lifecycle) | No cleanup path for terrain, buildings, interiors, particles — blocks map rotation and testing |

---

## Extraction Plan Verdict

**Status: NEEDS CHANGES**

The extraction plan is fundamentally sound but requires three corrections before execution:

### Correction 1: Reduce Module Count
From 15 proposed modules to 8-10. Merge collision (85 lines), base accents (150 lines), custom models (55 lines), and weapon viewmodel (210 lines) into adjacent modules or keep in renderer.js.

### Correction 2: Reorder by Risk
```
Phase A: Constants (zero risk)
  1. player_state.js
  2. team_config.js

Phase B1: Low-risk extractions (failure is cosmetic)
  3. renderer_daynight.js (already an IIFE)
  4. renderer_postprocess.js (clean EffectComposer boundary)

Phase B2: Medium-risk extractions (failure breaks visuals but game runs)
  5. renderer_particles.js (unified systems 1-4)
  6. renderer_players.js (when multiplayer requires it)

Phase B3: High-risk extractions (failure = black screen or wrong terrain)
  7. renderer_terrain.js (shader injection, many consumers)
  8. renderer_interiors.js (binary parser, collision registration)
  9. renderer_camera.js (6 modes, WASM bidirectional, CSS side effects)
```

### Correction 3: Add Supporting Infrastructure
- **Frame update order contract** as `@ai-contract UPDATE_ORDER` in renderer.js
- **Visual constants module** (roughness ranges, emissive caps, shadow bias) shared across all rendering modules
- **Mandatory dispose()** on every extracted module's public API
- **Three.js version pin** in import map to protect `onBeforeCompile` hooks
