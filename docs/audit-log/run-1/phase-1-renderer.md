# Phase 1 — Adversarial Convergence Review: renderer.js (Run 1)

**Target:** `renderer.js` — 6,094 lines, the main renderer monolith
**Date:** 2026-04-29
**Panel:** Carmack, ryg, Abrash, Muratori, Acton, Sweeney, Ive
**Adversarial personas:** The Saboteur, The Wiring Inspector, The Cartographer

---

## Pass 1 — Break It

*Goal: Does this code survive contact with reality?*

### The Saboteur

**Finding S1: HEAPF32 Buffer Detachment (Critical)**
Lines 55-56, 3654-3668. `playerView`, `projectileView`, `particleView`, `flagView` are `Float32Array` views into `Module.HEAPF32.buffer`. If WASM memory grows (which Emscripten does automatically when the heap fills), the underlying `ArrayBuffer` is detached. Every subsequent read from these views silently returns `undefined`. The renderer will:
- Place all players at (undefined, undefined, undefined) — invisible
- Flag meshes vanish
- Particles die
- Camera goes to NaN
- No error thrown. Just a silently broken game.

*Reproduction:* Trigger heap growth during gameplay. Any `_malloc` call that exceeds current heap can trigger this. Interior shapes loading (line 1842+) does many `_malloc` calls.

**Finding S2: initPostProcessing camera race (Medium)**
Lines 3487-3533. The code checks `if (!camera) throw new Error(...)` — good. But there's no guard against `camera` being valid at init but later garbage-collected or reassigned. If `applyQuality()` (line 4364) is called and rebuilds the composer, the new `RenderPass` captures the current `camera` reference. If anything ever reassigns the module-level `camera`, the composer continues rendering with the old one.

**Finding S3: Double-init of rain (Low)**
Line 192-193. `initRain()` is guarded by a URL parameter check, but `updateRain(dt, camPos)` (line 5326) is called unconditionally in the render loop. If `_rainSystem` is null (rain not init'd), the function bails on line 3410 (`if (!_rainSystem || !_rainPos) return;`) — safe but wastes a function call per frame, 60 times/sec, forever.

**Finding S4: Grass ring memory bomb (High)**
Lines 5551-5570. The grass ring allocates up to 2.8M instances on "ultra" tier. Each `InstancedMesh` instance carries a 4x4 matrix (64 bytes) + color (12 bytes) = 76 bytes × 2.8M = **213 MB** of GPU-side buffer. On mobile or integrated GPUs this is a guaranteed OOM. The code doesn't check `renderer.capabilities` before allocating.

**Finding S5: Terrain carve disabled but code present (Low)**
Line 176. `_carveTerrainUnderBuildings()` is commented out with `// terrain carve disabled — reverted per user request`. The function is still defined (lines 1147-1212) — 65 lines of dead code that will confuse future maintainers.

### The Wiring Inspector

**Finding W1: loadHDRISky overwrites DayNight exposure (Critical race)**
Line 554: `if (renderer) renderer.toneMappingExposure = 1.15;` runs in the HDRI load callback (async). Meanwhile, DayNight._apply() (line 490) sets `renderer.toneMappingExposure = 0.80 + 0.20 * dayMix`. Whichever runs last wins. On slow connections, the HDRI loads after DayNight has been running for frames, overwriting the exposure to a flat 1.15 and breaking the day/night cycle's exposure ramp until the next DayNight tick corrects it. On fast connections, DayNight immediately overwrites the 1.15.

Similarly, line 555: `scene.environmentIntensity = 1.45` (HDRI callback) is immediately contradicted by DayNight._apply() line 497: `scene.environmentIntensity = 0.05 + 0.40 * dayMix`. These fight each other.

**Finding W2: Stale typed-array views after WASM memory growth (Critical)**
Same root cause as S1, but different symptom. Line 248: `polish = Polish.installPolish({ ... playerView: playerView, playerStride: playerStride })`. The polish module captures a reference to `playerView`. If WASM grows memory, the polish module's copy becomes detached. Polish effects that read player position will silently fail.

**Finding W3: `buildEnvironmentFromSky()` uses possibly null `sky` (Medium)**
Line 557-569. Called on line 3722 in `initStateViews()`. But `sky` was set to null on line 549 (`sky = null`) if HDRI loaded successfully. `buildEnvironmentFromSky()` checks `if (!sky || !renderer) return;` — so it silently no-ops after HDRI loads. This means the PBR environment is built from HDRI only if HDRI loads, and from Sky only if HDRI fails. But if HDRI loads late (after initStateViews calls buildEnvironmentFromSky), neither path runs. The HDRI callback (line 548) sets `scene.environment` correctly, but `buildEnvironmentFromSky()` was already called with a null sky.

**Finding W4: Night ambient light color typo (Low)**
Line 596: `new THREE.AmbientLight(0x3040608, 0)` — the hex literal `0x3040608` has 7 hex digits, not 6. JavaScript parses this as `0x03040608` = 50,529,800, which is NOT a valid RGB hex color. The actual color rendered is garbage. Should be `0x304060`.

**Finding W5: `window._tribesCamDist` / `window._tribesCamHeight` are global state (Medium)**
Lines 4132-4147. Camera distance state is stored on `window.*` instead of in module scope. Any other script can accidentally overwrite these, breaking the 3P camera. These should be module-level `let` variables, not window globals.

### The Cartographer

**Finding C1: Missing 4-tribe support (Critical architectural gap)**
Lines 59-63. `TEAM_COLORS` and `TEAM_TINT_HEX` are hardcoded for 3 teams (indices 0, 1, 2). `_flagStateByTeam` (line 77) is a 2-element array. `flagMeshes` (line 3096-3121) creates exactly 2 flags. `MAX_PLAYERS = 16`. The entire renderer is wired for 2-team CTF with 16 players max. The game design doc specifies **4 tribes × 16 players = 64 players**. This is a foundational mismatch.

**Finding C2: No phase system hooks (Critical architectural gap)**
The game-design.md specifies rotating game phases (fog, lava, power surge, mech wave). The renderer has no phase state, no phase transition hooks, no way for an external system to say "we're now in dense fog phase" and have the renderer respond. DayNight cycle exists but is time-driven, not phase-driven.

**Finding C3: Hardcoded map data throughout (High)**
Lines 760-765: `BASE_T0`, `BASE_T1`, `BRIDGE`, `BASIN` — Raindance-specific coordinates baked into terrain splat generation. Line 597: night ambient. Lines 2630-2776: base accents reference `canonical.json` specific to Raindance. The renderer cannot render any other map without editing dozens of hardcoded values.

**Finding C4: No water or lava renderer (Medium gap)**
Game design specifies water (tier 1 flat plane shader) and lava (emissive + bloom). Neither exists in renderer.js. No placeholder, no stub, no interface contract for where they'd connect.

**Finding C5: Particle system fragmentation (Medium)**
There are **6 separate particle systems**, each with their own pool, shader, init, and update:
1. `initParticles()` (line 3459) — WASM-driven general particles
2. `initJetExhaust()` (line 4457) — jet flames (DISABLED in loop)
3. `initSkiParticles()` (line 4520) — ski sparks
4. `initProjectileTrails()` (line 4644) — projectile trails
5. `initExplosionFX()` (line 4828) — explosion fireballs + sparks
6. `initNightFairies()` (line 5025) — sky fairy particles

Each duplicates the same pattern: Float32Array pool → BufferGeometry → ShaderMaterial → Points → frustumCulled=false. This is 6 draw calls where 1-2 could suffice with a unified system. Every new particle type means copy-pasting ~80 lines.

**Finding C6: Undocumented player state stride offsets (High)**
Throughout syncPlayers (lines 3744-3875), syncCamera (lines 4073-4270), etc., the code reads `playerView[o + 18]`, `playerView[o + 13]`, `playerView[o + 14]`, `playerView[o + 15]`, `playerView[o + 20]`, etc. These magic numbers are the WASM struct field offsets, but they're never documented in renderer.js. If the C++ side changes the struct layout, every single offset here silently breaks.

---

## Pass 2 — Challenge the Architecture (Independent Expert Reviews)

### John Carmack — Engine Architecture

This is a 6,094-line monolith that handles terrain, buildings, interior shapes, players, projectiles, flags, particles (6 systems), weather, day/night cycle, post-processing, camera, spectator mode, weapon viewmodel, quality tiers, map loading, grass ring, dust layer, and a first-frame diagnostic. That's at least 15 distinct subsystems in one file.

The init sequence (lines 127-296) is a 170-line waterfall of `await` calls. If any one fails silently (and several are wrapped in try/catch that swallow errors), downstream systems get partial state. The dependencies are implicit — `initBuildings` needs `_htData` from `initTerrain`, `initInteriorLights` needs `buildingMeshes` from `initBuildings`, etc. There's no dependency graph, just ordering.

The render loop (lines 5270-5400) calls ~20 update functions per frame. None of them are profiled, none have budget caps, none can be skipped when under frame pressure. A single slow frame in `updateDustLayer` (which CPU-lerps 64K-256K positions) takes the same priority as `syncCamera`.

The WASM bridge (typed array views into HEAPF32) is the right architecture — zero-copy, fast reads. But it's fragile: HEAPF32.buffer can detach on memory growth, and the stride offsets are magic numbers.

**Carmack's verdict:** Extract terrain, buildings, interior shapes, particles, and camera into separate ES modules. The monolith is unmaintainable. Keep the render loop thin — it should call module.update(dt) for each system, nothing more.

### Fabian "ryg" Giesen — GPU Pipeline

**Draw call inventory (estimated per-frame):**
1. Terrain mesh — 1 draw
2. ~40 building groups — 40 draws (no instancing)
3. ~100 interior shapes (multi-material) — 200+ draws
4. 16 player meshes (multi-sub-mesh composites) — 160+ draws
5. 256 projectile meshes — 256 draws (individual spheres!)
6. 2 flag groups — 4 draws
7. General particles — 1 draw
8. Ski particles — 1 draw
9. Projectile trails — 1 draw
10. Explosion fireballs — 8 draws
11. Explosion sparks — 1 draw
12. Night fairies — 1 draw
13. Rain (if enabled) — 1 draw
14. Grass ring (if enabled) — 1 draw
15. Dust layer (if enabled) — 1 draw
16. Post-processing (bloom + grade + output) — 3-4 draws
17. Sky dome — 1 draw

**Total: ~680+ draw calls per frame.** For a game targeting "any computer, 60fps," this is concerning. The projectiles alone are 256 individual sphere meshes — classic instancing candidate. Buildings could be batched by material. Interior shapes share geometry via `geomCache` (good) but each instance is its own Mesh with multi-material arrays.

The terrain shader (lines 641-1140) does excellent work with texture arrays (3 sampler2DArray vs. the old 15 sampler2D), but the anti-tile function (`antiTileSample`) still does 2 `vnoise` calls + 1 `texture` call per visible layer. With 4 layers × 2 noise + 1 tex = 12 texture-level operations per fragment. On a 1080p screen with terrain filling 60% of pixels, that's ~12M shader operations per frame for terrain alone.

**ryg's verdict:** Projectiles need instancing immediately. Buildings should be batched by material. The terrain shader is acceptable but should have a quality-tier fallback that skips anti-tile noise on low-end GPUs.

### Michael Abrash — Performance & Memory

**Memory budget (estimated):**
- Terrain geometry (513×513 verts, indexed): ~6MB
- Terrain textures (3 × 1024×1024×5 layers RGBA): ~60MB
- Interior shape geometry cache: ~4MB (32 unique meshes)
- PBR textures for buildings (8 categories × 3 maps × 1024×1024): ~96MB
- Heightmap copy (_htData, 513×513 Float32): ~1MB
- Heightmap texture for fairies: ~1MB
- Fairy positions (44,800 × 4 attributes): ~2MB
- Grass ring (up to 2.8M instances × 76 bytes): **0-213MB**
- Player meshes (16 × ~20 sub-meshes): ~1MB
- Particle pools (6 systems, various): ~2MB

**Total without grass ring: ~170MB.** With grass ring on ultra: **~380MB.**

The render loop has several per-frame CPU costs that scale poorly:
- `updateDustLayer()`: CPU-lerps ALL fairy positions (64K-256K) every frame. That's 192K-768K float operations per frame.
- `updateGrassRing()`: recycles up to 12,000 grass blade instances per frame, each requiring a matrix compose + splat sample.
- `syncParticles()`: iterates all 1024 particle slots every frame even if most are dead.

The heightmap is sampled via bilinear interpolation (`sampleTerrainH`) hundreds of times per frame (building grounding, carving, ski emission, grass placement). No spatial acceleration — just direct array lookups, which is fine since it's O(1) per sample.

**Abrash's verdict:** The per-frame CPU cost of dust/grass ring updates is the bottleneck on low-end hardware. These should be fully GPU-driven (compute shader or vertex shader with time-based animation). The grass ring's 213MB allocation on ultra is reckless — needs a hard cap based on device memory.

### Casey Muratori — Simplicity & Systems Design

Six. Separate. Particle. Systems.

Every single one is the same pattern: Float32Array, BufferGeometry, ShaderMaterial, Points, frustumCulled=false, renderOrder=N. Copy-paste with slight color changes. This is exactly the kind of accidental complexity that kills projects.

The weapon viewmodel (lines 3122-3330) is **210 lines of hand-placed box, cylinder, and torus primitives** to build a single gun model. Every vertex position is a magic number. If the gun design changes, you're editing 40+ lines of procedural geometry. This should be a GLB file, loaded in 3 lines.

`syncPlayers()` (lines 3744-3875) is 130 lines that does:
1. Read state from WASM
2. Swap mesh if armor changed
3. Update shield sphere
4. Skip non-local players (wait, what? Line 3792: `if (i !== localIdx) { mesh.visible = false; ... continue; }`)
5. Handle 1P/3P visibility
6. Position and rotate
7. Update nameplate
8. Feed voice spatialization
9. Apply team color
10. Animate rig
11. Drive polish module

That's 11 concerns in one function. The early-out on line 3792 means **all remote player rendering is disabled**. Not "remote players are hidden when far away" — ALL of them, always. This is presumably for single-player testing, but it means multiplayer rendering is dead code that can't be tested.

**Muratori's verdict:** The file does too much. But worse, it does 11 things in each function. Extract particle systems into one unified system. Extract the weapon viewmodel into a GLB. Kill the dead code paths (grass, rain, dust are all disabled). And for the love of simplicity, remove the 6 lines that disable remote players — that's a test hack that's been shipped.

### Mike Acton — Data Layout

The WASM bridge is good — typed array views, no deserialization, zero-copy. But the layout is stride-based with magic offsets. `playerView[o + 18]` means "visibility flag" but you'd never know without cross-referencing the C++ struct.

The particle systems use Structure-of-Arrays (SoA) for positions, ages, velocities, alphas — separate Float32Arrays for each. This is correct for cache coherence during the update loop (iterate all positions, then all ages, etc.). Good.

But the init functions create materials inside the geometry loop — `createBuildingMesh()` creates new `MeshStandardMaterial` instances for every call. Each building gets its own material. Three.js can't batch draws across different material instances even if they have identical properties.

The `buildMaterialArray()` function (line 2094) correctly caches material arrays per filename+team, which is good. But the procedural texture generator (`_genProceduralTex`, line 1916) creates a new Canvas element and CanvasTexture per unique texture name — no pooling, no atlas.

**Acton's verdict:** Material deduplication is the biggest win. Buildings sharing identical materials should share material instances, not clones. Projectiles should be instanced. The WASM stride offsets need a shared constant file between C++ and JS.

### Tim Sweeney — Engine-Scale Architecture

This file is trying to be a game engine in a single 6K-line JavaScript file. That's not architecture — that's accumulation.

The dependency structure is:
```
renderer.js imports:
  → THREE (+ 7 addons)
  → renderer_polish.js
  → renderer_sky_custom.js
  → renderer_characters.js

renderer.js reads from window.*:
  ← RapierPhysics, Toonify, CombatFX, CommandMap, Minimap, Cohesion
  ← ZoomFX, __voice, __teamColors, __tribesPlayerRatings
  ← Module (WASM)

renderer.js writes to window.*:
  → _sampleTerrainH, DayNight, scene, camera, renderer
  → _tribesDebug, __tribesPolish, __tribesApplyQuality
  → __tribesSetTerrainPBR, registerModelCollision
  → _weaponMuzzleAnchor, __tribesBloom, __tribesComposer
  → _tribesAimPoint3P, _tribesCamDist, _tribesCamHeight
  → __nightAmbient, __generatorPositions, __camX/Y/Z
  → _rapierGrounded, __tribesLoadMap
```

That's **27 window.* writes** and **15+ window.* reads**. This is not a module boundary — it's a global soup. Every `window.*` is an undocumented API contract that any script can break.

**Sweeney's verdict:** Define explicit interfaces. Each subsystem should export a typed API and import its dependencies, not reach through `window.*`. The render loop should be an event-driven scheduler, not a hardcoded function call list.

### Jony Ive — Design Coherence

I see a codebase that has been iterated on 150+ times (R15 through R32.153). Each iteration left its comment trail — the file is 40% comments by volume. These comments are a historical diary, not documentation. Comments like `// R32.36.3-manus: counts doubled per user request "double the amount"` tell me about process but not purpose.

The visual systems are fragmented: terrain has its own shader pipeline, buildings have PBR textures from Poly Haven, interior shapes have procedural canvas textures, players are composite primitive meshes OR imported GLB characters. There's no unified material system. The game should feel like one world, but the rendering pipelines tell three different visual stories.

The weapon viewmodel is a triumph of craft — 210 lines of hand-placed geometry that creates a convincing sci-fi rifle. But it should be an asset, not code.

**Ive's verdict:** Simplify the material story. One pipeline for all surfaces. The comment archaeology needs to be replaced with a clean header that states what the file does NOW, not what it did in R32.7.

---

## Pass 3 — Debate to Consensus (The Room)

*Carmack, ryg, Abrash, Muratori, Acton, Sweeney, Ive — in dialogue.*

---

**Carmack:** Let's start with the elephant. This file needs to be broken up. I count 15 subsystems. The question is: what's the extraction order?

**Muratori:** Before we talk about extraction, can we talk about the 6 particle systems? Because that's the clearest case of "clone what works" gone wrong. Someone cloned jet exhaust for ski, cloned it again for trails, again for explosions, again for fairies. Each is 80-100 lines of identical boilerplate. One unified particle system with type-parameterized emission would be 200 lines replacing 500.

**ryg:** I agree on particles, but from a GPU perspective, the bigger problem is the per-object draw call count. 256 individual projectile spheres. 40 building groups with unique materials. At 680+ draws per frame, we're CPU-bound on the draw call submission path long before the GPU fills up.

**Acton:** The material issue is the root cause. `createBuildingMesh()` creates new `MeshStandardMaterial` instances per building. Three.js can't batch draws across different material instances even when the properties match. If buildings shared material instances by type+team, Three.js could auto-batch them. That's a 10x reduction in building draw calls.

**Carmack:** Agreed. Material sharing, projectile instancing, and particle unification. Those are the three biggest perf wins, and they're all structural — not algorithmic.

**Abrash:** The grass ring scares me more than the draw calls. 2.8 million instances at 76 bytes each is 213 MB. That's more than the rest of the renderer combined. And it's disabled! It was tried, it didn't work, and now it's 400 lines of dead code that still gets loaded.

**Muratori:** Dead code is the bigger issue. Rain: disabled. Grass ring: disabled. Dust layer: disabled (line 5834: `return;` at the top of initDustLayer). Jet exhaust: disabled. That's roughly 1,000 lines of code that runs zero times. Delete it.

**Ive:** Or archive it. These were design explorations — grass, dust, rain. They failed for specific visual reasons documented in the comments. But the learnings are valuable. Move them to a `renderer_archive.js` if you must, but get them out of the main file.

**Sweeney:** The window.* soup is my primary concern. 27 writes, 15+ reads. There's no way to refactor this safely without first documenting every global — who writes it, who reads it, what happens if it's missing. That's the system map.

**Carmack:** Right. The system map is prerequisite. Let me propose an extraction order:

1. **Particles** → `renderer_particles.js` — all 6 systems unified into one, parameterized by type
2. **Terrain** → `renderer_terrain.js` — initTerrain + sampleTerrainH + shader + carve logic
3. **Buildings** → `renderer_buildings.js` — already exists, but canonical mesh builders + init are still in renderer.js
4. **Camera** → `renderer_camera.js` — syncCamera + spectator + 3P logic + aim point
5. **DayNight** → `renderer_daynight.js` — the IIFE + light management
6. **Weapon viewmodel** → load from GLB asset, kill 210 lines of code

**Muratori:** I'd put terrain first. It's the biggest chunk (~500 lines), the most self-contained, and it has the clearest interface: takes heightmap data, returns a mesh + sampleTerrainH function. Everything else depends on terrain, nothing terrain depends on is in renderer.js.

**Carmack:** Fair. Terrain first, then particles.

**ryg:** For projectiles specifically — I'd instance them before extracting. Replace the 256 individual Mesh objects with a single InstancedMesh. That alone cuts 255 draw calls. It's a 20-minute change.

**Acton:** And while you're at it, the player state stride offsets. `playerView[o + 18]` scattered through 500 lines of code. Make a shared constants module:
```js
export const PV = {
    X: 0, Y: 1, Z: 2,
    PITCH: 3, YAW: 4,
    VX: 6, VZ: 8,
    TEAM: 11, ARMOR: 12,
    ALIVE: 13, JETTING: 14, SKIING: 15,
    VISIBLE: 18, SPAWN_PROT: 20,
};
```
Then `playerView[o + PV.VISIBLE]` is self-documenting and stays in sync with C++.

**Carmack:** That's a must. The magic numbers are the single biggest maintainability hazard in the sync functions.

**Abrash:** On the HEAPF32 detachment issue — this is critical and there's no mitigation. If Emscripten grows the heap, every typed array view silently breaks. The fix is to re-acquire views at the top of each frame:
```js
function refreshViews() {
    const buf = Module.HEAPF32.buffer;
    playerView = new Float32Array(buf, Module._getPlayerStatePtr(), MAX_PLAYERS * playerStride);
    // ... same for projectile, particle, flag views
}
```
Call it once at the top of `loop()`. Cheap (4 constructor calls), bulletproof.

**Carmack:** Add it. That's a ticking time bomb.

**Sweeney:** On the HDRI vs DayNight race (W1) — the fix is to remove the `toneMappingExposure = 1.15` and `environmentIntensity = 1.45` from the HDRI callback entirely. Let DayNight own those values. The HDRI callback should only set `scene.environment` and nothing else.

**Ive:** One more thing. The night ambient light color typo — `0x3040608` instead of `0x304060`. That's shipping with a garbage color on a light that's supposed to prevent pitch-black terrain at night. How was this not caught? There's no visual regression test for lighting.

**Carmack:** Because there are no visual tests for anything except buildings. The `buildings_test.html` harness is the only one. We need standalone test harnesses for: terrain, sky/DayNight, particles, camera/spectator, and lighting. Each one isolated, each one inspectable.

---

### Consensus Fixes

| # | Finding | Fix | Priority | Owner |
|---|---------|-----|----------|-------|
| 1 | HEAPF32 buffer detachment | Add `refreshViews()` at top of `loop()` | **Critical** | Core |
| 2 | Night ambient color typo | `0x3040608` → `0x304060` | **Critical** | Quick fix |
| 3 | HDRI/DayNight exposure race | Remove exposure/envIntensity from HDRI callback | **High** | DayNight |
| 4 | 256 individual projectile meshes | Replace with InstancedMesh | **High** | Perf |
| 5 | Magic stride offsets | Create `player_state.js` constants module | **High** | Maintenance |
| 6 | 6 duplicate particle systems | Unify into `renderer_particles.js` | **High** | Extraction |
| 7 | Dead code (rain, grass, dust, jet) | Delete or archive to `renderer_archive.js` | **Medium** | Cleanup |
| 8 | window.* globals (27 writes) | Migrate to explicit module exports | **Medium** | Architecture |
| 9 | 2-team hardcoding | Expand TEAM_COLORS, flags, etc. to 4 teams | **Medium** | 4-tribe support |
| 10 | No phase system hooks | Add phase state + transition interface | **Medium** | Game design |
| 11 | Hardcoded Raindance coords | Extract to map config JSON | **Medium** | Multi-map |
| 12 | Material instance duplication | Share materials by type+team for batching | **Medium** | Perf |
| 13 | Grass ring 213MB allocation | Hard cap based on device memory, or delete | **Low** | Memory |
| 14 | Remote players always hidden | Remove the single-player test hack | **Low** | Multiplayer |
| 15 | Weapon viewmodel as code | Convert to GLB asset | **Low** | Assets |

---

## Pass 4 — System-Level Review

### Dependency Map

```
renderer.js
├── IMPORTS (ES modules)
│   ├── three (+ 7 addons: EffectComposer, RenderPass, UnrealBloomPass, ShaderPass, OutputPass, SMAAPass, RGBELoader, GLTFLoader)
│   ├── ./renderer_polish.js (Polish.*)
│   ├── ./renderer_sky_custom.js (initCustomSky, updateCustomSky, removeOldSky)
│   └── ./renderer_characters.js?v=149 (Characters.init, Characters.sync)
│
├── READS from window.* (external modules inject these)
│   ├── window.RapierPhysics — Rapier WASM physics (initRapierPhysics, createTerrainCollider, createBuildingColliders, stepPlayerCollision, registerModelCollision)
│   ├── window.Toonify — material conversion pass
│   ├── window.CombatFX — muzzle flash, tracers, hit indicators
│   ├── window.CommandMap — tactical overlay
│   ├── window.Minimap — radar minimap
│   ├── window.Cohesion — camera breathing + mood audio
│   ├── window.ZoomFX — scope zoom
│   ├── window.__voice, window.__voiceUpdatePeer — voice chat spatialization
│   ├── window.__teamColors — color-blind mode overrides
│   ├── window.__tribesPlayerRatings — skill tier ratings
│   ├── window.__qualityTier — quality tier string for grass/dust
│   ├── window.__tribesSetGameClock — HUD clock callback
│   ├── window.ST — settings store
│   └── window.Module (WASM) — all game state access
│
├── WRITES to window.* (exposes for other modules)
│   ├── window._sampleTerrainH — terrain height query (used by renderer_characters.js)
│   ├── window.DayNight — day/night cycle state + dayMix + sunDir
│   ├── window.scene, window.camera, window.renderer — Three.js core (debug)
│   ├── window._tribesDebug — debug panel access
│   ├── window.__tribesPolish — polish module handle
│   ├── window.__tribesApplyQuality — quality change callback
│   ├── window.__tribesSetTerrainPBR — terrain PBR toggle
│   ├── window.registerModelCollision — collision registration
│   ├── window._weaponMuzzleAnchor — muzzle point for CombatFX
│   ├── window.__tribesBloom, window.__tribesComposer — post-process handles
│   ├── window._tribesAimPoint3P — aim convergence point
│   ├── window._tribesCamDist, window._tribesCamHeight — camera state
│   ├── window.__nightAmbient — night ambient light reference
│   ├── window.__generatorPositions — generator world positions (audio)
│   ├── window.__camX/Y/Z — camera position (audio proximity)
│   ├── window._rapierGrounded — Rapier grounding state
│   └── window.__tribesLoadMap — map loading entry point
│
└── READS from WASM (Module._*)
    ├── _getHeightmapPtr, _getHeightmapSize, _getHeightmapWorldScale
    ├── _getBuildingPtr, _getBuildingCount, _getBuildingStride
    ├── _getPlayerStatePtr, _getPlayerStateStride, _getPlayerStateCount
    ├── _getProjectileStatePtr, _getProjectileStateStride, _getProjectileStateCount
    ├── _getParticleStatePtr, _getParticleStateStride
    ├── _getFlagStatePtr, _getFlagStateStride
    ├── _getLocalPlayerIdx, _getThirdPerson, _getCameraFov
    ├── _isReady, _tick
    ├── _setLocalAimPoint3P, _setRapierGrounded
    ├── _appendInteriorMeshTris, _malloc, _free
    └── _setMapBuildings
```

### Interface Contract

**renderer.js promises:**
1. `start()` — async, initializes the full 3D scene and enters the render loop
2. `loadMap(doc)` — rebuilds buildings + atmosphere from a `.tribes-map` JSON document
3. `sampleTerrainH(x, z)` — returns interpolated terrain height at world coordinates
4. Render loop runs at requestAnimationFrame cadence, syncs all game state from WASM each frame

**renderer.js assumes:**
1. `Module` is a valid Emscripten module with all `_get*Ptr/Stride/Count` functions
2. `Module._isReady()` returns true before game state is valid
3. HEAPF32 buffer does NOT grow after views are created (⚠️ BROKEN ASSUMPTION)
4. `assets/maps/raindance/` contains canonical.json, raindance_meshes.bin/json, material_palette.json
5. `assets/textures/` contains terrain and building PBR textures
6. `assets/hdri/` contains the environment HDRI
7. `assets/models/wolf_sentinel.glb` exists for the sentinel model
8. `#canvas` element exists in the DOM
9. Various `window.*` modules (Toonify, CombatFX, etc.) may or may not be loaded

### Contradiction Flags

| Pattern in renderer.js | Pattern elsewhere | Conflict |
|---|---|---|
| Buildings are procedural composites (`createBuildingMesh`, `createCanonicalMesh`) | `renderer_buildings.js` exists as a separate module | Building code is duplicated — which is canonical? |
| Characters are rigged GLBs (`renderer_characters.js`) | Players are also composite primitives (`createPlayerMesh`) | Two character rendering systems coexist |
| Terrain exposes `_sampleTerrainH` via `window.*` | ES module pattern used for other dependencies | Inconsistent interface style |
| `flatShading: true` on interior materials (line 1903) | Comment says "R32.64.2: REVERTED — flatShading OFF caused black flashing" | Shading mode is fragile and may need revisiting |

### Keep/Extract/Absorb/Kill Recommendations

| Subsystem | Lines | Recommendation | Rationale |
|---|---|---|---|
| Terrain (init + shader + splat + carve) | 641-1212 (~570) | **Extract** → `renderer_terrain.js` | Self-contained, clear interface |
| DayNight cycle | 360-520 (~160) | **Extract** → `renderer_daynight.js` | Independent state machine |
| Buildings (procedural + canonical) | 1217-1632 (~415) | **Absorb** into existing `renderer_buildings.js` | Module already exists but is incomplete |
| Interior shapes | 1842-2416 (~575) | **Extract** → `renderer_interiors.js` | Complex, self-contained |
| Collision registration | 2427-2510 (~85) | **Extract** → `renderer_collision.js` | Separate concern |
| Custom models (wolf sentinel) | 2563-2616 (~55) | **Kill** or move to asset loader | Hardcoded single model |
| Base accents | 2630-2776 (~150) | **Absorb** into buildings module | Per-team visual elements |
| Players (create + init + animate) | 2780-3075 (~295) | **Extract** → `renderer_players.js` | Includes complex rig animation |
| Weapon viewmodel | 3122-3330 (~210) | **Kill** code, replace with GLB | 210 lines of magic numbers |
| Rain | 3341-3440 (~100) | **Kill** | Disabled, user requested removal |
| General particles | 3443-3483 (~40) | **Absorb** into unified particles | Small |
| Post-processing | 3487-3650 (~165) | **Extract** → `renderer_postprocess.js` | Independent pipeline |
| Camera + spectator | 4042-4270 (~230) | **Extract** → `renderer_camera.js` | Complex, testable |
| Jet exhaust | 4449-4506 (~60) | **Kill** or **absorb** into particles | Disabled |
| Ski particles | 4512-4634 (~125) | **Absorb** into unified particles | Active |
| Projectile trails | 4638-4760 (~125) | **Absorb** into unified particles | Active |
| Interior lights | 4764-4820 (~55) | **Absorb** into interiors module | Tightly coupled |
| Explosions | 4824-4990 (~170) | **Absorb** into unified particles | Active |
| Night fairies | 5025-5190 (~165) | **Absorb** into unified particles | Active |
| Grass ring | 5510-5800 (~290) | **Kill** | Disabled, 400 lines of dead code |
| Dust layer | 5830-6094 (~265) | **Kill** | Disabled (immediate `return`) |

**Post-extraction, renderer.js should be ~800 lines:** imports, init orchestration, render loop, resize handler, and quality management.

---

## Pass 5 — AI Rules Extraction

```javascript
// @ai-contract
// BEFORE_MODIFY: read docs/lessons-learned.md, read docs/patterns.md
// BEFORE_MODIFY: check ?v= cache bust on ALL import lines you touch
// BEFORE_MODIFY: run `grep window\\. renderer.js | wc -l` — do not increase the count
//
// NEVER: add a new particle system to this file — use renderer_particles.js (when extracted)
// NEVER: add new window.* globals without documenting in docs/system-map.md
// NEVER: use magic numbers for playerView stride offsets — use player_state.js constants
// NEVER: store mutable state on window.* — use module-scope variables
// NEVER: create new MeshStandardMaterial inside a loop — share material instances
//
// ALWAYS: call refreshViews() at top of loop() to guard against HEAPF32 detachment
// ALWAYS: wrap init subsystem calls in try/catch so one failure doesn't black-screen
// ALWAYS: use THREE.DynamicDrawUsage on any BufferAttribute updated per-frame
// ALWAYS: set frustumCulled = false on any mesh that might be underground or at origin
// ALWAYS: bump ?v= param on import lines when editing imported modules
// ALWAYS: test with ?nopost and ?daynight=off to isolate rendering issues
//
// DEPENDS_ON: renderer_polish.js (Polish.*), renderer_sky_custom.js (custom sky dome)
// DEPENDS_ON: renderer_characters.js (Characters.init, Characters.sync)
// DEPENDS_ON: Module (WASM) — all game state, heightmap, player/projectile/particle/flag data
// DEPENDS_ON: window.RapierPhysics (optional — falls back to WASM collision)
//
// EXPOSES: window._sampleTerrainH, window.DayNight, window.__tribesPolish
// EXPOSES: window.__tribesApplyQuality, window.__tribesSetTerrainPBR
// EXPOSES: window.registerModelCollision, window._weaponMuzzleAnchor
// EXPOSES: window.__tribesBloom, window.__tribesComposer
// EXPOSES: window._tribesAimPoint3P, window._tribesCamDist, window._tribesCamHeight
// EXPOSES: window.__nightAmbient, window.__generatorPositions, window.__camX/Y/Z
// EXPOSES: window._rapierGrounded, window.__tribesLoadMap
// EXPOSES: window.scene, window.camera, window.renderer (debug only)
// EXPOSES: window._tribesDebug (debug panel)
//
// COORDINATE_SPACE: world (meters), Y-up
// COORDINATE_CONVENTION: MIS (x, y, z-up) → world (x = mis_x, y = mis_z, z = -mis_y)
// ROTATION_CONVENTION: MIS z-axis yaw → Three.js rotation.y = -mis_rot_z
//
// INIT_ORDER: initRenderer → initScene → initLights → loadHDRISky → initCustomSky
//   → initTerrain → RapierPhysics → initBuildings → initInteriorShapes
//   → initCustomModels → initBaseAccents → initPlayers → Characters.init
//   → initProjectiles → initFlags → initParticles → initWeaponViewmodel
//   → (optional: initRain, initGrassRing, initDustLayer)
//   → initStateViews → initPostProcessing → Polish.installPolish → loop()
//
// FRAME_BUDGET: 16.6ms (60fps). Terrain shader + sync functions + particle updates
//   must fit within budget on integrated GPUs. Profile before adding per-frame work.
//
// @end-ai-contract
```

---

## Pass 6 — Design Intent (Ive's Pass)

*Map each subsystem to Core Feelings: Belonging, Adaptation, Scale, Aliveness.*

| Subsystem | Core Feeling | Assessment |
|---|---|---|
| **Terrain** (faceted, painterly, bicubic upscale) | **Scale** | ✅ The terrain IS the game's visual identity. Faceted geometry at 513×513 reads as vast. The watercolor wash and splat blending create a Frederic Edwin Church painting. This serves Scale and Aliveness (living terrain via uTime-driven shader breath). |
| **DayNight cycle** (30-min loop, sun arc, color palettes) | **Aliveness, Adaptation** | ✅ Strong. The world changes over time without player input. Dawn/dusk are visually distinct. Night fairies + bloom create a different tactical feel. This is proto-phase: the world adapts on its own. When the phase system ships, DayNight should modulate per-phase. |
| **Buildings** (procedural + canonical classification) | **Belonging** | ⚠️ Partial. Team-tinted accents (R32.71 team emblems, generator pulses) serve Belonging — "this is MY team's base." But the visual language is inconsistent: procedural primitives (turrets, stations) coexist with imported .dig meshes. A player sees two art styles in one base. |
| **Interior shapes** (.dis-extracted meshes, PBR textures) | **Scale, Belonging** | ✅ Real Tribes 1 geometry placed at canonical positions. This IS the original game's spatial memory. Players who played Tribes 1 will recognize bunker layouts. Serves Scale (massive structures) and Belonging (this is home). |
| **Players** (composite primitives + rigged GLBs) | **Belonging** | ⚠️ Two systems coexist (procedural + rigged). The procedural soldier has team-tinted armor, breathing idle animation, torso pitch — all good. The rigged GLB overlays it. The result: sometimes you see the composite, sometimes the GLB, depending on camera and state. Inconsistent silhouette breaks readability. Pick one. |
| **Weapon viewmodel** (procedural sci-fi rifle + first-person arms) | **Belonging** | ✅ Surprising craft. The 210-line rifle has holographic sight, muzzle brake, plasma cell glow, trigger guard. First-person arms with gloves and cuffs. Sway on jet/ski. This makes the player feel embodied. But it should be an asset, not code. |
| **Particles** (6 systems) | **Aliveness** | ⚠️ Each particle system individually serves Aliveness (ski sparks, projectile trails, explosions create reactive feedback). But 6 systems means 6 slightly different visual languages for "glowing points in space." Unification would create visual coherence. |
| **Night fairies** (44,800 GPU particles) | **Aliveness** | ✅ Strong. Terrain-aware, world-anchored, rainbow-colored points that drift and twinkle. They make the world feel inhabited even when no players are near. This is pure Aliveness. |
| **Spectator camera** (death orbit) | — | Neutral. It works (orbits death point with slow yaw), but it's a missed opportunity for **Scale** — the death camera could pull back to show the map's vastness, reinforcing the feeling of being one soldier in a huge world. |
| **Post-processing** (bloom, vignette, color grade) | **Aliveness** | ✅ Night-adaptive bloom (off during day, ramps at dusk) is elegant. The vignette + warm-shadow grade gives a cinematic cohesion. Film grain adds texture. |
| **Rain, grass ring, dust** (all disabled) | — | ❌ Dead weight. These were attempts at Aliveness (weather, foliage, atmospheric particles) that failed visually and were disabled. They serve no Core Feeling in their current state. Archive or delete. |

### Ive's Final Assessment

The renderer's strongest expression of the Core Feelings is in the **terrain + DayNight + night fairies** triad. Together they create a world that breathes, shifts, and feels vast. This is the foundation.

The weakest area is **visual coherence across surface types**. Buildings, terrain, interiors, and players each have different material pipelines. A unified shading approach (even if it's just "everything goes through MeshStandardMaterial with consistent roughness/metalness ranges") would unify the visual identity.

The dead code (rain, grass, dust — ~700 lines) is spiritual noise. It represents abandoned attempts that clutter the file and confuse the identity. Archive it. The game's atmosphere should come from the phase system, not from bolted-on weather effects.

**Key question for Levi:** The DayNight cycle runs independently of gameplay phases. When phases ship, should DayNight become phase-subordinate (e.g., "fog phase overrides to dawn lighting") or remain independent (24-hour cycle continues regardless of phase)? This is a design decision that affects how Aliveness and Adaptation interact.

---

## Deliverable Summary

This document contains:
- **Pass 1:** 16 findings across 3 adversarial personas (5 critical, 4 high, 5 medium, 2 low)
- **Pass 2:** 7 independent expert reviews
- **Pass 3:** Full debate dialogue with 15 consensus fixes prioritized
- **Pass 4:** Complete dependency map, interface contract, contradiction flags, extraction plan (20 subsystems evaluated)
- **Pass 5:** `@ai-contract` block for renderer.js
- **Pass 6:** Design intent mapping for all 12 active subsystems against Core Feelings
