# Refactoring Plan — Firewolf Codebase

> **Phase 6 deliverable** from the Adversarial Convergence Review (Phases 1–5 complete).
> This is the concrete engineering roadmap. Every item is actionable, prioritized, and risk-assessed.
>
> **Codebase snapshot:** 19,952 lines across 26 JS modules. renderer.js = 6,094 lines (31%).
> **72 unique `window.*` globals** identified across all modules.

---

## 1. renderer.js Extraction Plan

**Current state:** 6,094 lines — a monolith containing ~15 distinct subsystems.
**Target state:** ~800-line thin orchestrator (scene setup, render loop, module init/update dispatch).

Extraction order is dependency-sorted: extract what others depend on first.

---

### 1.1 Terrain System → `renderer_terrain.js`

**Current location:** renderer.js L100–L1146
**Proposed module:** `renderer_terrain.js` (~1,050 lines)
**What moves:** Heightmap loading, terrain mesh generation, PBR texture pipeline, terrain carving, `sampleTerrainH()`, `__tribesSetTerrainPBR`
**What stays in renderer.js:** `initTerrain(scene, quality)` call, terrain group add to scene
**Dependencies reads:** `QUALITY_TIERS`, `currentQuality`, scene reference, `window.ST` (settings)
**Dependencies writes:** `window._sampleTerrainH` (consumed by renderer_characters.js, renderer_rapier.js)
**Risk:** Medium — highest line count extraction, many closures reference scene/camera. Requires careful scoping of shared references via init parameter object.
**Priority:** 1 (everything depends on terrain height sampling)

**Migration steps:**
1. Extract `sampleTerrainH` + heightmap loading into standalone export
2. Move PBR texture pipeline (L600–L971) — self-contained, references only TextureLoader + quality tier
3. Move terrain mesh generation (L100–L490) — depends on heightmap + PBR
4. Move terrain carving (L1050–L1146) — depends on terrain mesh reference
5. Replace `window._sampleTerrainH` with ES export; update renderer_characters.js import

---

### 1.2 Particle Systems (×6) → `renderer_particles.js`

**Current location:** Six scattered systems across renderer.js:
- WASM particles: L3459 (general purpose)
- Jet exhaust: L4457–L4506 (DISABLED)
- Ski particles: L4520–L4634 (active)
- Projectile trails: L4644–L4760 (active)
- Explosions: L4828–L4990 (active)
- Night fairies: L5025–L5190 (active)

**Proposed module:** `renderer_particles.js` (~550 lines, unified)
**What moves:** All 6 particle systems, shared geometry pools, shader materials
**What stays in renderer.js:** `particles.init(scene, quality)`, `particles.update(dt)` in render loop
**Dependencies reads:** scene, camera position (for LOD), quality tier, player positions (for ski particles), projectile positions (for trails)
**Dependencies writes:** None — purely visual, no state read by other systems
**Risk:** Low — particle systems are output-only; no downstream consumers read their state. Jet exhaust and dust layer are already disabled.
**Priority:** 2 (large line reduction, zero coupling risk)

**Migration steps:**
1. Create unified ParticleManager class with register/update pattern
2. Move ski particles first (active, well-tested) — validate visually
3. Move explosions + projectile trails together (share similar lifecycle)
4. Move night fairies (independent ambient system)
5. Stub jet exhaust + WASM particles (disabled/minimal)
6. Delete dead jet exhaust code entirely — it's been disabled since R32.x

---

### 1.3 Camera System → `renderer_camera.js`

**Current location:** renderer.js L4073–L4270
**Proposed module:** `renderer_camera.js` (~200 lines)
**What moves:** 1P/3P/spectator camera logic, aim raycasting, shadow camera snapping, FOV management
**What stays in renderer.js:** `updateCamera(dt)` call in render loop, camera object creation
**Dependencies reads:** player position/rotation from WASM view, `window._tribesCamDist`, `window._tribesCamHeight`, `window.ZoomFX`
**Dependencies writes:** `window._tribesAimPoint3P` (read by WASM C++ for aim convergence), `window._tribesCamDist`, `window._tribesCamHeight`
**Risk:** Medium — the aim point global is read by C++ via `Module._setLocalAimPoint3P`. Must keep that window global or replace with a WASM-facing bridge.
**Priority:** 2 (clean boundary, but aim point coupling needs care)

**Migration steps:**
1. Extract camera update logic into `updateCamera(camera, playerView, stride, dt)` export
2. Keep `window._tribesAimPoint3P` as WASM bridge (documented, not eliminated)
3. Convert `_tribesCamDist`/`_tribesCamHeight` to module-scope variables, exported for debug
4. Import ZoomFX as ES module (depends on ZoomFX migration, §2)

---

### 1.4 Day/Night Cycle → `renderer_daynight.js`

**Current location:** renderer.js L490–L600 (DayNight object + night ambient at L597)
**Proposed module:** `renderer_daynight.js` (~120 lines)
**What moves:** DayNight object, time-of-day computation, sun/moon positioning, game clock string, night ambient light management
**What stays in renderer.js:** `DayNight.update(dt)` call, light references passed at init
**Dependencies reads:** `sunLight`, `hemiLight`, `nightAmbient` (scene lights)
**Dependencies writes:** `window.DayNight` (referenced by renderer_sky_custom.js for dayMix), `window.__nightAmbient`, `window.__tribesSetGameClock`
**Risk:** Low — small, self-contained cycle. renderer_sky_custom.js reads `DayNight.dayMix` but can import directly once both are ES modules.
**Priority:** 3 (small win, low risk, enables sky_custom cleanup)

**Migration steps:**
1. Move DayNight class + night ambient setup into ES module
2. Export `dayMix` getter for renderer_sky_custom.js to import directly
3. Keep `window.__tribesSetGameClock` bridge for HTML HUD (or move HUD to module import)
4. Kill `window.DayNight` global after renderer_sky_custom.js is updated to import

---

### 1.5 Entity Sync (Player/Projectile/Flag) → `renderer_entities.js`

**Current location:**
- Player sync: renderer.js L3744–L3875
- Projectile sync: renderer.js L3937–L3955
- Flag sync: renderer.js L3096–L3121

**Proposed module:** `renderer_entities.js` (~200 lines)
**What moves:** WASM→Three.js player positioning, team color application, nameplate updates, projectile mesh sync (256 individual meshes), flag positioning
**What stays in renderer.js:** `syncEntities(playerView, stride)` call in render loop
**Dependencies reads:** WASM `playerView` TypedArray, `playerStride`, team colors, `window.__tribesPlayerRatings`
**Dependencies writes:** Player mesh positions (Three.js objects), `window.__teamColors`
**Risk:** Medium — projectile sync uses 256 individual meshes (not instanced). Extraction is safe but exposes the instancing tech debt. Flag sync is hardcoded 2-team.
**Priority:** 3 (moderate coupling, but clean read-only WASM→render pattern)

**Migration steps:**
1. Extract player sync first — largest chunk, well-defined WASM view contract
2. Extract projectile sync — note instancing TODO in module header
3. Extract flag sync — note 4-team TODO in module header
4. Convert `window.__teamColors` to ES export, update consumers (minimap, command map, palette)

---

### 1.6 Weapon Viewmodel → stays in renderer.js (for now)

**Current location:** renderer.js L3200–L3400
**Rationale:** Tightly coupled to camera position, animation frame, and player state. Extracting before camera extraction creates circular dependency. Extract AFTER renderer_camera.js is stable.
**Priority:** 5 (deferred — extract in second pass)

---

### 1.7 Post-Processing → stays in renderer.js (for now)

**Current location:** renderer.js L3487–L3533
**Rationale:** Only ~50 lines. Bloom, grading, SMAA setup. Tightly coupled to composer which lives in render loop. Not worth a separate module.
**Priority:** 5 (leave in orchestrator — it IS orchestration)

---

### 1.8 Map Loading → `renderer_maploader.js`

**Current location:** renderer.js L5400–L5550
**Proposed module:** `renderer_maploader.js` (~150 lines)
**What moves:** `.tribes-map` JSON parser, building placement dispatch, terrain carving dispatch, WASM `_setMapBuildings` call
**What stays in renderer.js:** `loadMap(url)` call
**Dependencies reads:** building system, terrain system, WASM Module
**Dependencies writes:** `window.__tribesLoadMap`
**Risk:** Low — clear input (JSON) → output (scene mutations) boundary.
**Priority:** 4 (clean extraction, moderate value)

---

### 1.9 Disabled Systems → DELETE

| System | Location | Status | Action |
|---|---|---|---|
| Rain | L3341–L3440 | Disabled, `update()` called every frame | **DELETE** — wasting frame budget on no-op |
| Grass ring | L5551–L5570 | Disabled, 213MB GPU alloc on ultra | **DELETE** — never shipped, dangerous alloc |
| Dust layer | scattered | Disabled | **DELETE** — dead code |
| Jet exhaust | L4457–L4506 | Disabled | **DELETE** or stub in renderer_particles.js |

**Total lines recovered from deletions:** ~250

---

### Post-Extraction renderer.js Target Structure

```
renderer.js (~800 lines):
  ├── Quality tier config (50 lines)
  ├── Scene/renderer/composer setup (100 lines)
  ├── Module imports + init orchestration (150 lines)
  ├── Render loop — calls module.update(dt) (200 lines)
  ├── Resize handler (30 lines)
  ├── Weapon viewmodel (200 lines — deferred extraction)
  ├── Post-processing setup (50 lines)
  └── Input binding (keyboard state) (50 lines)
```

---

## 2. IIFE → ES Module Migration Plan

8 modules use the IIFE → `window.*` pattern. They need migrating to ES modules with `export`/`import`.

### Migration Template

For each IIFE module:
1. Remove the outer `(function() { ... })();` wrapper
2. Replace `window.ModuleName = { ... }` with named exports: `export function init() { ... }`
3. In consumers, replace `window.ModuleName.method()` with `import { method } from './module.js'`
4. Add `@ai-contract` block if missing
5. Update `index.html` script tag: change `<script src="...">` to `<script type="module" src="...">`

---

### 2.1 KILL: renderer_cohesion.js (138 lines)

**Action:** Delete entirely. No migration needed.
**Rationale:** Dead code. Camera breathing effect was disabled. `window.Cohesion.tick()` is called but the tick is a no-op. Provides no player sensation.
**Consumers:** renderer.js L3680–L3681 (init), L5347 (tick) — remove both call sites.
**Risk:** None.
**Priority:** Do first. Immediate 138-line reduction + 1 dead global eliminated.

---

### 2.2 renderer_rapier.js (456 lines) → ES Module

**Complexity:** Complex
**Current pattern:** IIFE → `window.RapierPhysics` with 6 methods
**Consumers:** renderer.js (10 references — init, terrain collider, building colliders, step collision, grounded state)
**Coupling:** Highest of all IIFE modules. renderer.js reads `window.RapierPhysics` at L139, L141, L151, L162, L163, L2429, L2430, L5277, L5280, L5284.

**Migration plan:**
1. Convert IIFE to `export { initRapierPhysics, createTerrainCollider, createBuildingColliders, stepPlayerCollision, registerModelCollision }`
2. In renderer.js: `import * as RapierPhysics from './renderer_rapier.js'`
3. Find-replace all `window.RapierPhysics.X` → `RapierPhysics.X` in renderer.js (10 sites)
4. Kill `window.registerModelCollision` at renderer.js L2510 — move to RapierPhysics export
5. Kill `window._rapierGrounded` at L5284 — return grounded state via function return, not global

**Blockers:** None. renderer_rapier.js already has a clean facade pattern — just needs the window wrapper removed.
**Risk:** Medium — highest touch count, but all references are in renderer.js (single consumer).
**Priority:** 2 (after Cohesion kill — highest coupling payoff)

---

### 2.3 renderer_combat_fx.js (301 lines) → ES Module

**Complexity:** Trivial
**Current pattern:** IIFE → `window.CombatFX` with init/update/trigger methods
**Consumers:** renderer.js L3688–L3689 (init), L5332 (update)
**Coupling:** Low — only 4 total `window.CombatFX` references across codebase.

**Migration plan:**
1. Remove IIFE wrapper, export `{ init, update, onHit, onDamage }`
2. In renderer.js: `import * as CombatFX from './renderer_combat_fx.js'`
3. Replace 2 call sites in renderer.js

**Blockers:** None. Already close to dynamic import pattern.
**Risk:** Low.
**Priority:** 3

---

### 2.4 renderer_minimap.js (348 lines) → ES Module

**Complexity:** Moderate
**Current pattern:** IIFE → `window.Minimap` with init/update
**Consumers:** renderer.js L3725–L3726 (init), L5338 (update)
**Coupling:** 5 total `window.Minimap` references. Reads `window.__teamColors`, `window._sampleTerrainH`.

**Migration plan:**
1. Remove IIFE, export `{ init, update, setMapBounds }`
2. Import terrain height + team colors as ES imports (requires those to be extracted first or passed via init)
3. In renderer.js: `import * as Minimap from './renderer_minimap.js'`

**Blockers:** Soft dependency on terrain height export (§1.1) and team colors export (§1.5). Can pass via init params as interim.
**Risk:** Low–Medium.
**Priority:** 4 (pair with command map)

---

### 2.5 renderer_command_map.js (601 lines) → ES Module

**Complexity:** Moderate
**Current pattern:** IIFE → `window.CommandMap` with init/update/toggle
**Consumers:** renderer.js L3697–L3698 (init), L5336 (update)
**Coupling:** 4 total `window.CommandMap` references. Reads `window.__teamColors`, player positions. 19 internal `window.*` references (mostly reading shared data).

**Migration plan:**
1. Remove IIFE, export `{ init, update, toggle, isActive }`
2. Refactor internal `window.*` reads to import from their new ES module homes
3. In renderer.js: `import * as CommandMap from './renderer_command_map.js'`

**Blockers:** Highest internal `window.*` count (19). Needs team colors, player state, terrain height as imports. Best done AFTER terrain + entity extraction.
**Risk:** Medium — 19 internal global reads need updating.
**Priority:** 4 (pair with minimap — both are HUD systems, shared data dependencies)

---

### 2.6 renderer_toonify.js (210 lines) → ES Module

**Complexity:** Trivial
**Current pattern:** IIFE → `window.Toonify` with init/enabled flag
**Consumers:** renderer.js L290–L291 (init check)
**Coupling:** 7 total `window.Toonify` references (mostly self-referencing). Only 2 external consumers in renderer.js.

**Migration plan:**
1. Remove IIFE, export `{ init, enabled, apply }`
2. In renderer.js: `import * as Toonify from './renderer_toonify.js'`

**Blockers:** None.
**Risk:** Low.
**Priority:** 5 (pair with zoom)

---

### 2.7 renderer_zoom.js (206 lines) → ES Module

**Complexity:** Trivial
**Current pattern:** IIFE → `window.ZoomFX` with getFovMultiplier/isActive
**Consumers:** renderer.js L4234–L4236 (camera system reads FOV multiplier)
**Coupling:** 5 total `window.ZoomFX` references. Self-contained scope zoom.

**Migration plan:**
1. Remove IIFE, export `{ init, getFovMultiplier, isActive }`
2. In renderer.js (or renderer_camera.js after extraction): `import { getFovMultiplier, isActive } from './renderer_zoom.js'`

**Blockers:** If camera is extracted first (§1.3), the import goes in renderer_camera.js instead.
**Risk:** Low.
**Priority:** 5 (pair with toonify)

---

### 2.8 renderer_debug_panel.js (216 lines) → ES Module

**Complexity:** Trivial
**Current pattern:** IIFE → `window.DebugPanel` (but 0 external `window.DebugPanel` references found!)
**Consumers:** Self-contained. Activated by `?debugPanel` URL param + F8 key.
**Coupling:** 6 internal `window.*` reads (debug data: `__camX/Y/Z`, `__qualityTier`, etc.)

**Migration plan:**
1. Remove IIFE, export `{ init, toggle }`
2. No external consumers to update — it's self-bootstrapping
3. Convert internal `window.__cam*` reads to imports from renderer_camera.js (post-extraction)

**Blockers:** None.
**Risk:** None — dev-only tool.
**Priority:** 6 (lowest — dev-only, zero production impact)

---

### Migration Order Summary

| Pass | Module | Action | Lines Affected | Risk |
|---|---|---|---|---|
| 1 | renderer_cohesion.js | **KILL** | 138 deleted | None |
| 2 | renderer_rapier.js | IIFE→ES | 456 + 10 renderer.js sites | Medium |
| 3 | renderer_combat_fx.js | IIFE→ES | 301 + 2 renderer.js sites | Low |
| 4a | renderer_minimap.js | IIFE→ES | 348 + 2 renderer.js sites | Low–Med |
| 4b | renderer_command_map.js | IIFE→ES | 601 + 2 renderer.js sites | Medium |
| 5a | renderer_toonify.js | IIFE→ES | 210 + 2 renderer.js sites | Low |
| 5b | renderer_zoom.js | IIFE→ES | 206 + 2 renderer.js sites | Low |
| 6 | renderer_debug_panel.js | IIFE→ES | 216 + 0 renderer.js sites | None |

---

## 3. window.* Global Reduction Plan

**Current count:** 72 unique custom globals (excluding browser APIs like `window.innerWidth`).
**Target:** Reduce to ≤25 (65% reduction).

### Global Categorization

| Category | Count | Globals | Strategy |
|---|---|---|---|
| **API Facade** | 11 | `RapierPhysics`, `Cohesion`, `CombatFX`, `CommandMap`, `Minimap`, `Toonify`, `ZoomFX`, `DayNight`, `PALETTE`, `PaletteUtils`, `DebugPanel` | → ES module exports (eliminated when IIFE migrates) |
| **WASM Bridge** | 8 | `Module`, `_tribesAimPoint3P`, `_rapierGrounded`, `_sampleTerrainH`, `registerModelCollision`, `onDamageSource`, `onHitConfirm`, `onMatchEnd` | **KEEP** — Emscripten requires `window.*` callbacks for C++→JS |
| **WASM Callbacks** | 8 | `playSoundAt`, `playSoundUI`, `addKillMsg`, `updateHUD`, `updateMatchHUD`, `sbRow`, `sbFinish`, `updateAudio` | **KEEP** — called from C++ compiled code |
| **Shared Data** | 17 | `ST`, `__teamColors`, `__qualityTier`, `__tribesPlayerRatings`, `__nightAmbient`, `__generatorPositions`, `__camX/Y/Z`, `_tribesCamDist`, `_tribesCamHeight`, `_weaponMuzzleAnchor`, `_flagStingMuted`, `r3FrameTime`, `AE`, `renderer` | → Module-scope or ES exports |
| **Config/Control** | 10 | `__tribesApplyQuality`, `__tribesSetTerrainPBR`, `__tribesLoadMap`, `__tribesSetGameClock`, `__tribesOnMatchEnd`, `__tribesOnMatchStart`, `__tribesOnSkillUpdate`, `__tribesShowReconnect`, `__tribesHideReconnect`, `__tribesBloom` | → ES exports or event bus |
| **Feature Modules** | 4 | `__editor`, `__replay`, `__moderation`, `__voice*` (9 voice globals) | → ES module imports |
| **Debug** | 5 | `_tribesDebug`, `__tribesPolish`, `__tribesComposer`, `__tribesApplyDelta`, `__tribesReconcile`, `DEBUG_LOGS` | **KEEP** — console debugging, harmless |
| **Dead** | 1 | `Cohesion` | **KILL** |

*Note: voice system accounts for 9 of the 72 (`__voice`, `__voiceUpdatePeer`, `__voiceClearPeerMutes`, `__voiceGetMuteAll`, `__voiceIsPeerMuted`, `__voiceMuteUuid`, `__voiceRegisterUuid`, `__voiceSetMuteAll`, `__voiceSetPeerMuted/Direct`). All should collapse to a single `import * as Voice from './client/voice.js'`.*

### Reduction Targets

| Category | Current | Target | Reduction |
|---|---|---|---|
| API Facade | 11 | 0 | −11 |
| Shared Data | 17 | 5 (keep WASM-facing) | −12 |
| Config/Control | 10 | 3 (keep HTML HUD bridges) | −7 |
| Feature Modules | 4 (+9 voice) | 0 | −13 |
| Dead | 1 | 0 | −1 |
| Debug | 5 | 5 (keep all) | 0 |
| WASM Bridge | 8 | 8 (keep all) | 0 |
| WASM Callbacks | 8 | 8 (keep all) | 0 |
| **Total** | **72** | **~29** | **−43 (60%)** |

### Top 10 Highest-Coupling Globals — Exact Migration Path

| # | Global | Ref Count | Current Owner | Migration |
|---|---|---|---|---|
| 1 | `window.RapierPhysics` | 10 | renderer_rapier.js | `import * as RapierPhysics from './renderer_rapier.js'` in renderer.js |
| 2 | `window.__replay` | 10 | client/replay.js | `import * as Replay from './client/replay.js'` in consumers |
| 3 | `window.__voice` + voice globals | 9 | client/voice.js | `import * as Voice from './client/voice.js'` — collapse 9 globals to 1 import |
| 4 | `window._tribesAimPoint3P` | 7 | renderer.js camera | **KEEP** as WASM bridge. Document in `@ai-contract` block |
| 5 | `window.ST` | 7 | tribes.js (settings) | **KEEP** — Emscripten settings table, read everywhere. Consider re-export from `client/settings.js` |
| 6 | `window.__editor` | 6 | client/mapeditor.js | `import * as Editor from './client/mapeditor.js'` |
| 7 | `window.Toonify` | 7 | renderer_toonify.js | `import * as Toonify from './renderer_toonify.js'` |
| 8 | `window.Cohesion` | 6 | renderer_cohesion.js | **DELETE** entire module |
| 9 | `window._tribesCamDist` | 5 | renderer.js camera | Module-scope in renderer_camera.js, exported for debug |
| 10 | `window.__nightAmbient` | 4 | renderer.js daynight | Module-scope in renderer_daynight.js, exported for debug |

---

## 4. Module Naming Review

### Renames

| Current Name | Lines | Problem | Proposed Name | Action |
|---|---|---|---|---|
| `renderer_polish.js` | 1,146 | Name "polish" is a grab-bag. Contains: damage screen, near-miss, lens flare, decals, flag FX. Actually well-organized internally — name is the only issue. | `renderer_fx.js` | **RENAME** — "fx" matches what it actually does (game feel effects) |
| `renderer_cohesion.js` | 138 | Name "cohesion" is meaningless. Content is dead. | — | **KILL** |
| `renderer_toonify.js` | 210 | "Toonify" is informal but actually accurate (converts materials to toon shading). | Keep as-is | **NO CHANGE** — name is fine, recognizable |
| `client/tiers.js` | 46 | "Tiers" reads as quality tiers. Actually contains skill rating calculation. | `client/skill_rating.js` | **RENAME** |
| `client/quant.js` | 40 | "Quant" is opaque abbreviation. Contains quantization helpers. | `client/quantization.js` | **RENAME** |
| `tribes.js` | 6,868 | Misleading — suggests game logic. Actually auto-generated Emscripten glue. | Keep as-is + document | **NO CHANGE** — renaming Emscripten output is fragile. Add prominent `@ai-contract` comment: "AUTO-GENERATED — do not edit. Emscripten WASM glue." |
| `renderer_palette.js` | 92 | Name is fine. But exposes `window.PALETTE` + `window.PaletteUtils` — two globals for 92 lines. | Keep name | **MIGRATE** to ES exports |
| `client/wire.js` | 254 | "Wire" is unclear. Contains WebSocket protocol framing. | `client/websocket.js` | **RENAME** — or keep if team prefers "wire" as jargon |

### Non-Renames (confirmed good names)

`renderer_buildings.js`, `renderer_characters.js`, `renderer_combat_fx.js`, `renderer_minimap.js`, `renderer_command_map.js`, `renderer_debug_panel.js`, `renderer_rapier.js`, `renderer_sky_custom.js`, `renderer_zoom.js`, `client/audio.js`, `client/constants.js`, `client/mapeditor.js`, `client/moderation.js`, `client/network.js`, `client/prediction.js`, `client/replay.js`, `client/voice.js`

---

## 5. Keep / Extract / Absorb / Kill — All 26 Modules

### Renderer Modules (14)

| Module | Lines | Verdict | Rationale |
|---|---|---|---|
| `renderer.js` | 6,094 | **EXTRACT (decompose)** | Monolith → thin orchestrator. Extract terrain, particles, camera, daynight, entities, map loader. Target: ~800 lines. |
| `renderer_buildings.js` | 362 | **KEEP (gold standard)** | Clean ES module, single responsibility, InstancedMesh + Rapier colliders. Zero `window.*` globals. Reference implementation for all future modules. |
| `renderer_characters.js` | 294 | **KEEP + fix** | Good ES module separation. Needs: 64-player support (currently unclear cap), team color generalization for 4 teams. Only 2 `window.*` refs. |
| `renderer_cohesion.js` | 138 | **KILL** | Dead code. Camera breathing effect disabled. `tick()` is a no-op. 12 `window.*` refs in 138 lines = worst globals-per-line ratio. Delete file + 2 renderer.js call sites. |
| `renderer_combat_fx.js` | 301 | **KEEP + migrate** | Clean combat feel system (screen shake, hit flash, damage vignette). IIFE→ES migration is trivial. 5 `window.*` refs. |
| `renderer_command_map.js` | 601 | **KEEP + migrate** | Full tactical overlay. Largest IIFE module. 19 `window.*` refs need updating during migration. Pair with minimap. |
| `renderer_debug_panel.js` | 216 | **KEEP + migrate** | Dev-only debug overlay. Low priority migration. 6 `window.*` refs. |
| `renderer_minimap.js` | 348 | **KEEP + migrate** | Radar HUD. IIFE→ES. 7 `window.*` refs. Pair with command map migration. |
| `renderer_palette.js` | 92 | **KEEP + migrate** | Color palette source of truth. Currently IIFE-like with `window.PALETTE`. Convert to ES exports. 4 `window.*` refs. |
| `renderer_polish.js` | 1,146 | **KEEP + rename** | Despite the name, internally well-organized (damage screen, near-miss FX, lens flare, decals, flag events). Rename to `renderer_fx.js`. 10 `window.*` refs — convert to ES imports during migration wave. |
| `renderer_rapier.js` | 456 | **KEEP + migrate (priority)** | Physics facade. Highest coupling IIFE (10 renderer.js references). Critical path — migrate first among IIFEs. Only 1 internal `window.*` ref (self-registration). |
| `renderer_sky_custom.js` | 396 | **KEEP** | Clean ES module. Procedural sky dome + stars + clouds. Zero `window.*` globals. Reads `DayNight.dayMix` which should become an ES import after daynight extraction. |
| `renderer_toonify.js` | 210 | **KEEP + migrate** | Material toon post-process. IIFE→ES. 7 `window.*` refs (mostly self-referencing). |
| `renderer_zoom.js` | 206 | **KEEP + migrate** | Scope zoom system. IIFE→ES. 9 `window.*` refs (mostly self-referencing + reading camera state). |

### Client Modules (12)

| Module | Lines | Verdict | Rationale |
|---|---|---|---|
| `client/audio.js` | 95 | **KEEP** | Small, focused audio playback. Clean. |
| `client/constants.js` | 115 | **KEEP + expand** | Should absorb player stride offsets from renderer.js (POS_X, POS_Y, etc.) to become single source of truth. Currently only has misc constants. |
| `client/mapeditor.js` | 393 | **KEEP** | Map editor system. Self-contained. References `window.__editor` — convert to ES export. |
| `client/moderation.js` | 120 | **KEEP** | Player moderation/muting. References `window.__moderation` — convert to ES export. |
| `client/network.js` | 331 | **KEEP** | WebSocket connection management. Clean separation from wire protocol. |
| `client/prediction.js` | 140 | **KEEP** | Client-side prediction. Small, focused. |
| `client/quant.js` | 40 | **KEEP + rename** | Rename to `client/quantization.js` for clarity. |
| `client/replay.js` | 376 | **KEEP** | Replay system. 10 `window.__replay` refs across codebase — convert to ES import. |
| `client/tiers.js` | 46 | **KEEP + rename** | Rename to `client/skill_rating.js`. Current name conflicts with quality tiers concept. |
| `client/voice.js` | 314 | **KEEP + refactor** | Voice chat. Exposes 9 separate `window.__voice*` globals — worst offender by count. Collapse to single ES module export with methods. |
| `client/wire.js` | 254 | **KEEP** | WebSocket binary protocol. Consider rename to `client/websocket.js`. |
| `tribes.js` | 6,868 | **KEEP (do not touch)** | Auto-generated Emscripten WASM glue. Add `@ai-contract` documentation only. Never hand-edit. |

### New Modules (from renderer.js extraction)

| Proposed Module | Est. Lines | Source |
|---|---|---|
| `renderer_terrain.js` | ~1,050 | renderer.js L100–L1146 |
| `renderer_particles.js` | ~550 | renderer.js (6 systems scattered) |
| `renderer_camera.js` | ~200 | renderer.js L4073–L4270 |
| `renderer_daynight.js` | ~120 | renderer.js L490–L600 |
| `renderer_entities.js` | ~200 | renderer.js L3744–L3955, L3096–L3121 |
| `renderer_maploader.js` | ~150 | renderer.js L5400–L5550 |

---

## 6. Execution Schedule

### Wave 1: Dead Code Removal (no risk)
1. Kill `renderer_cohesion.js` + 2 renderer.js call sites
2. Delete disabled systems in renderer.js: rain, grass ring, dust layer, jet exhaust
3. **Lines removed:** ~390
4. **Globals removed:** 1 (`Cohesion`)

### Wave 2: IIFE→ES Migration (low–medium risk)
1. `renderer_rapier.js` → ES (highest coupling payoff)
2. `renderer_combat_fx.js` → ES
3. `renderer_toonify.js` + `renderer_zoom.js` → ES (pair)
4. `renderer_minimap.js` + `renderer_command_map.js` → ES (pair)
5. `renderer_palette.js` → ES
6. `renderer_debug_panel.js` → ES
7. **Globals removed:** ~11 (all API facade globals)

### Wave 3: renderer.js Extraction (medium risk)
1. Extract `renderer_terrain.js` (highest dependency)
2. Extract `renderer_particles.js` (largest line reduction)
3. Extract `renderer_camera.js` + `renderer_daynight.js` (pair — camera reads daynight for exposure)
4. Extract `renderer_entities.js`
5. Extract `renderer_maploader.js`
6. **Lines moved out of renderer.js:** ~2,300
7. **Globals removed:** ~12 (shared data converted to module-scope)

### Wave 4: Shared Data Cleanup (low risk)
1. `client/voice.js` — collapse 9 voice globals to ES exports
2. `client/replay.js` — convert `window.__replay` to ES export
3. `client/mapeditor.js` — convert `window.__editor` to ES export
4. Rename: `client/tiers.js` → `client/skill_rating.js`
5. Rename: `client/quant.js` → `client/quantization.js`
6. Rename: `renderer_polish.js` → `renderer_fx.js`
7. Expand `client/constants.js` with player stride offsets
8. **Globals removed:** ~13

### Wave 5: Verification
1. `window.*` audit — confirm ≤29 globals remain (all WASM bridge or debug)
2. renderer.js line count — confirm <1,000 lines
3. No IIFE patterns remain
4. All modules have `@ai-contract` blocks
5. Update `docs/system-map.md` with new module graph

---

## 7. Risk Register

| Risk | Impact | Likelihood | Mitigation |
|---|---|---|---|
| Terrain extraction breaks heightmap sampling | High — all physics + rendering depends on it | Medium | Extract `sampleTerrainH` first as standalone; unit test against known map |
| IIFE migration breaks load order | Medium — blank screen on load | Low | Migrate one at a time; test each in browser before proceeding |
| Camera extraction breaks aim convergence | High — C++ reads `_tribesAimPoint3P` | Medium | Keep that specific global; document as WASM bridge; don't eliminate |
| Particle extraction causes visual regression | Low — particles are cosmetic | Low | A/B test: old renderer.js vs extracted version side-by-side |
| Emscripten glue (tribes.js) accidentally edited | Critical — WASM breaks | Low | Add prominent `@ai-contract` comment; never include in refactoring scope |
| Module import cycles | Medium — runtime error | Medium | Map dependency graph before each extraction; renderer.js is always the root importer |

---

## 8. Success Criteria

| Metric | Before | After | Measured By |
|---|---|---|---|
| renderer.js lines | 6,094 | <1,000 | `wc -l renderer.js` |
| `window.*` custom globals | 72 | ≤29 | grep audit script |
| IIFE modules | 8 | 0 | `grep -r '(function()' renderer_*.js` |
| Dead code lines | ~390 | 0 | Rain, grass, dust, cohesion, jet exhaust deleted |
| Modules with `@ai-contract` | ~6 | 32 (all) | grep audit |
| Largest module (excl. tribes.js) | 6,094 | ~1,146 (renderer_fx.js) | `wc -l` |

---

*Generated from ACR Phase 6. Each extraction should be a single commit with a version chip bump.*
*When in doubt, clone renderer_buildings.js — it's the gold standard.*
