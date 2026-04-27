# Tribes Browser Edition — Codebase Audit

**Date:** 2025-07-15  
**Version audited:** R32.42  
**Scope:** Full JS/C++/TS codebase, read-only analysis  
**Priority lens:** Performance first, then dead code, then architecture

---

## Table of Contents

1. [Codebase Overview](#1-codebase-overview)
2. [Performance Issues](#2-performance-issues)
3. [Dead Code](#3-dead-code)
4. [Architecture Concerns](#4-architecture-concerns)
5. [What's Actually Good](#5-whats-actually-good)
6. [Recommended Actions](#6-recommended-actions)
7. [Leave It Alone](#7-leave-it-alone)

---

## 1. Codebase Overview

| File | LOC | Role |
|------|-----|------|
| `renderer.js` | 4,720 | Three.js renderer monolith — scene init, sync loops, render loop, grass, weather |
| `tribes.js` | 6,865 | Emscripten glue (generated — **do not touch**) |
| `index.html` | 4,479 | HTML + ~2,969 lines inline JS (UI/HUD/menus/module loading) |
| `program/code/wasm_main.cpp` | 2,678 | C++ simulation — physics, AI, pathfinding, match state, legacy GL renderer |
| `renderer_polish.js` | 1,146 | **Entirely dead** — ES module exports, never loaded or imported |
| `renderer_command_map.js` | 601 | Tactical map overlay (IIFE → `window.CommandMap`) |
| `renderer_combat_fx.js` | 301 | Muzzle flash, tracers, hit indicators |
| `renderer_zoom.js` | 214 | RMB hold zoom + Z stepped zoom |
| `renderer_toonify.js` | 208 | MeshStandardMaterial → MeshToonMaterial conversion |
| `renderer_cohesion.js` | 138 | Camera breathing + ambient mood audio |
| `renderer_palette.js` | 92 | Locked color palette (`window.PALETTE`) |
| `client/*.js` (11 files) | 2,224 | Network, prediction, replay, voice, audio, map editor, etc. |
| `server/sim.ts` | 887 | Authoritative server sim (TS port of C++ physics) |
| `server/lobby.ts` | 1,789 | Matchmaking, lobby management |
| `server/constants.ts` | — | Re-exports from `client/constants.js` (good pattern) |

**Total handwritten JS/TS/C++:** ~19,500 LOC (excluding tribes.js)

---

## 2. Performance Issues

### P1: Per-Frame `new THREE.Vector3` in syncCamera

**File:** `renderer.js` line ~3404  
**Impact:** GC pressure every frame  

```js
const cf = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
```

A reusable `_tmpVec` already exists at module scope (line 70). This allocation is inside the aim-point computation block of `syncCamera()`, which runs every single frame.

**Fix:** Replace with `_tmpVec.set(0, 0, -1).applyQuaternion(camera.quaternion)`.  
**Effort:** 1 line change.

---

### P2: Per-Frame Terrain Ray-March in syncCamera

**File:** `renderer.js` lines ~3410–3430  
**Impact:** ~36 `sampleTerrainH()` calls per frame (32 coarse steps + 4 binary search refinements)

The aim-point system fires a 1000m ray from the camera and marches it against the terrain heightfield every frame to find where the crosshair hits ground. This runs unconditionally — even in 1P mode where it's less critical, and even when the camera hasn't moved.

```js
// Coarse ray-march against terrain heightfield (32 steps)
for (let i = 1; i <= 32; i++) { ... sampleTerrainH(wx, wz) ... }
// Binary search refinement (4 iters)
for (let j = 0; j < 4; j++) { ... sampleTerrainH(mx, mz) ... }
```

Each `sampleTerrainH` does a bilinear interpolation from the heightmap — cheap individually, but 36× per frame adds up, especially on lower-end hardware.

**Fix options:**
- Cache result when camera quaternion hasn't changed (delta check on quaternion components)
- Only run in 3P mode (skip when `camDist < 0.3`)
- Reduce to 16 coarse steps + 2 binary steps (halves cost, still sub-meter accuracy at 1000m)
- Run every other frame and interpolate  
**Effort:** Small. Any of these is a few lines.

---

### P3: Per-Frame Object Literal Allocation

**File:** `renderer.js` line ~3431  
**Impact:** Minor GC pressure  

```js
window._tribesAimPoint3P = { x: hitX, y: hitY, z: hitZ };
```

Creates a new `{ x, y, z }` object every frame. Should mutate a persistent object instead.

**Fix:** Declare `const _aimPoint = { x: 0, y: 0, z: 0 }` at module scope, mutate fields, assign once.  
**Effort:** 3 lines.

---

### P4: Per-Frame Array Allocation in syncCanonicalAnims

**File:** `renderer.js` line ~3481  
**Impact:** Minor GC pressure  

```js
const flagStateByTeam = [0, 0]; // allocated every frame
```

`syncCanonicalAnims` (aliased as `syncTurretBarrels`) is called every frame from `loop()`. The 2-element array should be module-scoped and reset to `[0, 0]` each frame instead of allocated.

**Fix:** Hoist to module scope, reset in-place.  
**Effort:** 2 lines.

---

### P5: Duplicate `performance.now()` Calls in loop()

**File:** `renderer.js` lines 3577 and 3592  
**Impact:** Negligible individually, but sloppy  

```js
const t = performance.now() * 0.001;    // line 3577 — used for animation time
// ... 15 lines later ...
const now = performance.now() * 0.001;  // line 3592 — used for dt computation
```

Both `t` and `now` are seconds-since-epoch. They're used for slightly different purposes but could share a single call. The dt computation (`now - _lastTickTime`) would be off by nanoseconds at worst.

**Fix:** Reuse `t` instead of computing `now`.  
**Effort:** 1 line.

---

### P6: Diagnostic Dump Code Inside loop()

**File:** `renderer.js` lines ~3640–3730 (~90 lines)  
**Impact:** Code bloat in the hot function, ICU pollution  

A one-shot diagnostic dump (scene traversal, bounding box computation, light enumeration) is guarded by a boolean `_r30Diagnosed` but lives inline inside `loop()`. While it only runs once, its presence bloats the function body that the JS engine must compile and potentially de-optimize.

**Fix:** Extract to a separate `_runFirstFrameDiagnostic()` function.  
**Effort:** Move ~90 lines into a named function, call it from loop().

---

### P7: 5-Second FPS Logging in loop()

**File:** `renderer.js` lines ~3718–3740  
**Impact:** String concatenation + `console.log` every 5 seconds in the render loop  

```js
console.log('[R18] ' + fps + 'fps, ' + info.calls + ' draw calls' + callsNote + ...);
```

This builds a multi-segment string with `.toFixed()` calls and `console.log`s it every 5 seconds. In production, `console.log` may trigger DevTools overhead even when the console is closed (browser-dependent). The FPS chip in the DOM (line 36 of index.html) already handles user-visible FPS display.

**Fix:** Gate behind `window.DEBUG_LOGS` or remove entirely (the FPS chip exists).  
**Effort:** 1 line conditional wrap.

---

### P8: `?v=Date.now()` Cache-Busting on Satellite Scripts

**File:** `index.html` lines 4218–4249  
**Impact:** Every page load re-downloads 5 satellite JS files, defeating HTTP caching  

```js
__cmdScr.src = './renderer_command_map.js?v=' + Date.now();
__zoomScr.src = './renderer_zoom.js?v=' + Date.now();
__cohScr.src = './renderer_cohesion.js?v=' + Date.now();
__palScr.src = './renderer_palette.js?v=' + Date.now();
__toonScr.src = './renderer_toonify.js?v=' + Date.now();
```

Five script loads with unique query strings means the browser can never serve these from cache. Total: ~1,554 LOC of JS re-downloaded every visit. The version chip already provides a version string (`R32.42`) — use that instead of `Date.now()`.

**Fix:** Replace `Date.now()` with a build-time or release version string.  
**Effort:** 5 line edits.

---

## 3. Dead Code

### 3A. `renderer_polish.js` — Entire File Dead (1,146 LOC)

The file defines 10 exported functions as a proper ES module:
- `installPolish()`, `spawnShockwave()`, `placeDecal()`, `registerGeneratorChimney()`, `enhanceTurret()`, `enhanceSensor()`, `addBridgeRailings()`, `addTowerWindows()`, `addStationIcon()`, `getFactionPalette()`

**No file in the entire codebase imports or loads `renderer_polish.js`.** Not via `<script>`, not via `import()`, not via any reference. Grep for every function name, the module path, and every export name returns zero external hits.

**Verdict:** Safe to delete the entire file. 1,146 LOC.

---

### 3B. renderer.js Dead Functions (~600+ LOC)

| Function | Line | LOC | Why Dead |
|----------|------|-----|----------|
| `generateTerrainTextures()` | 567 | ~106 | Procedural texture generators, superseded by real textures (R32.9) |
| `_makeNoiseTexture()` | 673 | ~41 | Helper for above |
| `_makeNormalFromNoise()` | 714 | ~54 | Helper for above |
| `_generateSplatMap()` | 768 | ~80 | Helper for above |
| `initGrass()` | 3886 | ~213 | Old grass system, dropped R32.9, never re-enabled. Comment at line 158: "initGrass + initDetailProps were dropped from the start() sequence in R32.9" |
| `updateGrassWind()` | 4379 | ~73 | Call explicitly commented out at line 3617 |
| `initDetailProps()` | 4321 | ~57 | Rocks/scrub, dropped R32.9 |
| `makeSoftCircleTexture()` | ~2706 | ~30 | Zero references anywhere in codebase |
| `initScene_camera_init()` | 2902 | 1 | Empty placeholder function `{}` |

**Total dead code in renderer.js: ~655 LOC**

Additionally, renderer.js contains **1,019 comment lines (21.5% of file)**. Many are R-version changelogs documenting abandoned approaches (grass tried 4+ approaches, PBR terrain tried 3 iterations, mood/style tried 4 approaches). These are archaeology, not documentation.

---

### 3C. C++ Dead Code in wasm_main.cpp (~400+ LOC)

**Legacy GL Renderer (lines ~580–965):**
- Shader source strings: `tVS`, `tFS`, `oVS`, `oFS` (terrain + object vertex/fragment shaders)
- Batch rendering functions: `pushBox`, `pushPlayerModel`, `pushFlag`, `pushDisc`, `flushObj`
- Shader compilation utilities: `compS`, `linkP`

This is the original WebGL immediate-mode renderer, fully superseded by Three.js. The code is properly gated by `g_renderMode != 0` (line 2275) — when Three.js mode is active (always in production), the `mainLoop()` early-returns before any GL draw calls. **The legacy renderer does not cause per-frame overhead**, but the code is dead weight in the binary:
- ~386 LOC of shader strings and rendering functions compiled into WASM
- Shader strings embedded in the binary data segment

**HUD Stubs (lines ~1393–1405):**
- `hQ()` — HUD quad helper, builds vertex batches that nothing reads
- `drawHUD()` — Stub body: `glEnable(GL_DEPTH_TEST);` + comment "HUD is now fully HTML/CSS"
- `struct HV` + `static std::vector<HV> hBatch` — dead data structure
- `drawHUD()` is still called from `mainLoop()` line 2466 even in legacy mode

---

### 3D. renderer_command_map.js Double-Loading

`renderer_command_map.js` is loaded **twice:**
1. **Script tag injection** in `index.html` line 4218: `__cmdScr.src = './renderer_command_map.js?v=' + Date.now()`
2. **Dynamic import** in `renderer.js` line 2944: `import('./renderer_command_map.js').then(...)`

Because it's an IIFE that attaches to `window.CommandMap`, the second load overwrites the first. The IIFE body executes twice, re-creating all internal state. This wastes a network request + parse + execute cycle.

---

## 4. Architecture Concerns

### 4A. Mixed Module Systems

The codebase uses three different module patterns simultaneously:

| Pattern | Files | Loading |
|---------|-------|---------|
| ES Module (`export function`) | `renderer_polish.js` | **Never loaded** |
| ES Module (default) | `renderer.js`, all `client/*.js` | `import()` from index.html |
| IIFE → `window.*` global | `renderer_command_map.js`, `renderer_combat_fx.js`, `renderer_zoom.js`, `renderer_toonify.js`, `renderer_cohesion.js`, `renderer_palette.js` | `<script>` tag injection from index.html |

The IIFE modules are loaded via dynamic `<script>` tag injection (index.html lines 4215–4249), attaching to window globals (`window.CommandMap`, `window.CombatFX`, `window.ZoomFX`, `window.Toonify`, `window.Cohesion`, `window.PALETTE`). The renderer then null-checks these globals:

```js
if (window.Cohesion && window.Cohesion.tick) window.Cohesion.tick();
```

This works but makes dependencies invisible. If a satellite fails to load, the feature silently no-ops with no error.

---

### 4B. 2,969 Lines of Inline JS in index.html

Lines 1507–4476 of `index.html` contain all UI/HUD/menu logic as a single inline `<script>` block. This includes:
- Main menu system
- Settings panels
- HUD updates
- Kill feed
- Scoreboard
- Chat
- Friends list
- Module loading orchestration

Not extractable without a build step (uses direct DOM references and shares scope with the HTML), but it's a maintenance burden. Any change to UI or to module loading requires editing a 4,479-line HTML file.

---

### 4C. Constants Triple-Maintained

`client/constants.js` is the JS source of truth. `server/constants.ts` properly re-exports from it. But `wasm_main.cpp` has its own hardcoded copies:
- Armor stats (health, energy, speed, mass)
- Weapon data (damage, ROF, projectile speed, inheritance)
- Spawn protection timer
- Match warmup duration
- Gravity

When a constant changes, both `client/constants.js` AND `wasm_main.cpp` must be updated manually. There's no compile-time check for drift.

---

### 4D. 58 Module-Scope Variables in renderer.js

`renderer.js` declares 58 `let`/`const`/`var` bindings at module scope. These represent the entire renderer's shared mutable state surface: scene graph references, player mesh arrays, terrain data, flag views, weather state, camera state, quality settings, grass ring data, post-processing passes, etc.

Any function in the file can read or mutate any of them. This is a classic "god module" pattern.

---

## 5. What's Actually Good

- **C++ legacy renderer gating:** `g_renderMode != 0` early-return (line 2275) cleanly prevents the old GL renderer from running when Three.js is active. Zero per-frame overhead from the dead code path.

- **Zero-copy WASM↔JS communication:** Float32Array views directly into WASM memory (`playerView`, `flagView`, `projView`, `particleView`) with stride-based access. No copying, no marshaling. Excellent pattern.

- **Hot sync paths are clean:** `syncPlayers()`, `syncProjectiles()`, `syncFlags()`, `syncParticles()` — the most frequently-called render sync functions — contain no per-frame allocations. They iterate shared Float32Array views efficiently.

- **C++ pathfinding uses static arrays:** The A* implementation avoids per-query heap allocation by using fixed-size static arrays for `gCost`, `closed`, and `parent` maps.

- **Server constants re-export pattern:** `server/constants.ts` does `export { ... } from './constants.js'`, keeping a single source of truth for JS↔TS.

- **Quality tier system:** Well-structured with clear quality levels, appropriate feature scaling per tier, and runtime switching.

- **Satellite module graceful degradation:** All `window.X && window.X.method` checks mean missing modules don't crash the game. Good for optional features.

---

## 6. Recommended Actions

### Priority 1: Performance Quick Wins (< 1 hour total)

| # | What | Where | Effort |
|---|------|-------|--------|
| 1 | Replace `new THREE.Vector3` with `_tmpVec.set()` | renderer.js:3404 | 1 line |
| 2 | Skip aim-point ray-march when camera hasn't rotated (quaternion delta check) or when in 1P mode | renderer.js:3400–3431 | ~10 lines |
| 3 | Mutate persistent aim-point object instead of allocating | renderer.js:3431 | 3 lines |
| 4 | Hoist `flagStateByTeam` to module scope, reset in-place | renderer.js:3481 | 2 lines |
| 5 | Reuse `t` instead of second `performance.now()` call | renderer.js:3592 | 1 line |
| 6 | Gate 5-sec FPS logging behind `DEBUG_LOGS` | renderer.js:3718–3740 | 1 line |
| 7 | Replace `Date.now()` cache-busters with version string | index.html:4218–4249 | 5 lines |

### Priority 2: Dead Code Removal (1–2 hours)

| # | What | LOC Saved | Risk |
|---|------|-----------|------|
| 1 | Delete `renderer_polish.js` entirely | 1,146 | None — never loaded |
| 2 | Delete `generateTerrainTextures` + 3 helpers (lines 567–847) | ~281 | None — never called |
| 3 | Delete `initGrass` + `updateGrassWind` + `initDetailProps` (lines 3886–4452) | ~343 | None — dropped R32.9 |
| 4 | Delete `makeSoftCircleTexture` | ~30 | None — zero refs |
| 5 | Remove duplicate `renderer_command_map.js` load (either the script tag OR the import) | N/A | Pick one loading strategy |
| 6 | Strip R-version changelog comments from renderer.js | ~500+ | None — move to CHANGELOG if desired |

**Total recoverable: ~2,300+ LOC** across JS files alone.

### Priority 3: Architecture Improvements (longer term)

| # | What | Effort | Impact |
|---|------|--------|--------|
| 1 | Unify satellite module system — convert all to ES modules or all to IIFEs | Medium | Eliminates double-load risk, enables tree-shaking |
| 2 | Extract inline JS from index.html into separate files | Medium | Requires deciding on build tooling |
| 3 | Auto-generate C++ constants from `client/constants.js` at build time | Medium | Eliminates drift risk |
| 4 | Extract diagnostic dump from loop() into separate function | Small | Cleaner hot path |
| 5 | Remove C++ legacy GL renderer code (requires WASM recompile) | Medium | ~386 LOC from C++, smaller WASM binary |

---

## 7. Leave It Alone

- **`tribes.js`** — Emscripten-generated glue code. Don't read it, don't edit it, don't think about it.
- **`server/constants.ts`** re-export pattern — it's correct.
- **Quality tier system** — well-structured, leave as-is.
- **WASM memory sharing** — Float32Array zero-copy views are the right approach.
- **Hot sync functions** (`syncPlayers`, `syncProjectiles`, `syncFlags`, `syncParticles`) — already clean.
- **C++ pathfinding** — static array allocation is the right call for WASM.
- **Satellite graceful degradation** — the null-check pattern is appropriate for optional features loaded asynchronously.

---

*End of audit. No code was modified.*
