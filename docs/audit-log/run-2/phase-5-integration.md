# Phase 5 — Integration Audit (Run 2: Definitive Pass)

**Scope:** Full cross-module end-to-end audit — DEFINITIVE version incorporating all Run 2 corrections
**Date:** 2026-04-30
**Panel:** Carmack, Muratori, ryg, Abrash, Acton, Barrett, Ive
**Prior art:** `run-1/phase-5-integration.md`, all Run 2 phases (1 through 4)

---

## Preamble: What Changed Between Run 1 and Run 2

Run 1 Phase 5 produced the first integration picture: 83 window.* globals, ~1,400 dead code lines, 12 files with 2-team hardcoding, and 5 cross-module contradictions. Run 2 Phases 1–4 corrected several findings. This document is the **DEFINITIVE** integration report, superseding Run 1 Phase 5 on all counts.

### Key Run 2 Corrections Applied Here

| Correction | Source | Impact |
|---|---|---|
| HEAPF32 detachment is a NON-ISSUE | Phase 1, Phase 2a | Removed from hazard list. WASM compiled without memory growth. |
| Night ambient typo severity REDUCED | Phase 1 | DayNight._apply() corrects color to 0x304060 every frame before visible. Low, not Critical. |
| Particle unification is 4 systems, not 6 | Phase 1 | Explosions and fairies are architecturally distinct. Target: merge systems 1–4 only. |
| ASM_CONST callbacks ALL have null guards | Phase 2a | Run 1's boot-race crash claim was WRONG. All 19 entries use `if(window.X)`. |
| `_tick()` takes 0 params, not dt | Phase 2a | WASM owns timing internally. JS cannot supply or clamp dt. |
| index.html is ~3,200 LOC JS, not ~4,500 | Phase 2a | Still a massive unaudited surface, but 30% smaller than Run 1 stated. |
| Rapier dual-physics is INTENTIONAL migration | Phase 2b | Not accidental bolting. Old WASM collision explicitly no-oped. Fix is smaller. |
| `_chars[16]` is MEDIUM not CRITICAL | Phase 3a | JS sparse arrays prevent infinite clone loop. First frame creates; subsequent frames find it. |
| **prediction.reconcile() IS called** | Phase 3c | Wired through `window.__tribesReconcile` in index.html. Full pipeline is LIVE. |
| prediction.js is NOT dead code | Phase 3c | reconcile() measures divergence; applyPendingCorrection() writes to WASM. Only inputHistory is vestigial. |
| 2-team hardcoding is 6/12 small modules, not 7 | Phase 4 | combat_fx is team-agnostic (missing feature), not team-hardcoded (broken feature). |
| Team color 0=blue vs 0=red inconsistency | Phase 4 | minimap/command_map: team 0=blue. mapeditor/replay/palette: team 0=red. LATENT BUG. |
| Palette hex values match NO consumer | Phase 4 | Everyone hardcodes own colors. Palette is irrelevant to actual rendered output. |
| Zoom's RAF is unconditional (worst offender) | Phase 4 | Runs every frame from page load. command_map at least self-terminates when closed. |
| Only one rename needed: sky_custom → sky | Phase 4 | All other module names are accurate and should be kept. |

---

## 1. Corrected End-to-End Frame Trace

One complete frame, from browser event to pixels on screen. All corrections from Run 2 incorporated.

### Phase A — Input + Simulation (WASM)

```
requestAnimationFrame(loop)
  │
  ├─ [1] Module._isReady() check
  │     renderer.js:5266 — guard: if WASM not ready, re-queue RAF and bail
  │
  ├─ [2] t = performance.now() * 0.001
  │     renderer.js:5270 — wall-clock seconds (used by JS subsystems, NOT passed to WASM)
  │
  ├─ [3] Module._tick()                       ◄── CORRECTED: takes ZERO parameters
  │     renderer.js:5272 — enters WASM with NO arguments
  │       ├─ C++ reads emscripten_get_now() or similar internal timer (WASM OWNS TIMING)
  │       ├─ C++ integrates physics (gravity, skiing friction, jetting thrust)
  │       ├─ C++ resolves projectile hits, flag pickups, damage
  │       ├─ C++ writes player/projectile/particle/flag/building state to HEAPF32
  │       │     ◄── CORRECTED: HEAPF32 views are SAFE (no memory growth possible)
  │       │     Memory compiled without -sALLOW_MEMORY_GROWTH; buffer cannot detach
  │       ├─ C++ calls ASM_CONSTS (→ window.*) during tick:
  │       │     ALL 19 ASM_CONST entries have null guards: if(window.X)window.X(...)
  │       │     ◄── CORRECTED: Run 1 claimed no guards. Guards exist on every entry.
  │       │     updateHUD(14 params)      → index.html HUD overlay
  │       │     updateMatchHUD(4 params)  → index.html match timer
  │       │     updateAudio(5 or 4 params)→ index.html audio (4-param variant drops skiing)
  │       │     playSoundAt(id,x,y,z)    → index.html spatial audio (2 entries hard-code IDs)
  │       │     onDamageSource(srcX,srcZ) → index.html damage arc
  │       │     onHitConfirm(amount)      → index.html hit marker
  │       │     sbRow/sbFinish            → index.html scoreboard
  │       │     r3FrameTime(ms)           → index.html perf telemetry (via ||0 fallback)
  │       └─ C++ returns control to JS
  │
  └─ Module._tick() has now written all game state to shared memory
```

### Phase B — Collision Resolution (Rapier)

```
  ├─ [4] Rapier collision step              ◄── CORRECTED: intentional migration architecture
  │     renderer.js:5277-5289 — try/catch wrapped
  │     ├─ localIdx = Module._getLocalPlayerIdx()
  │     ├─ RapierPhysics.stepPlayerCollision(playerView, playerStride, localIdx, 1/60)
  │     │     renderer_rapier.js (456 lines, IIFE → window.RapierPhysics):
  │     │     ├─ Read WASM-proposed position from playerView[o+0..2]
  │     │     ├─ Compute desiredMovement = proposed - lastCorrected (PROBLEM: position-delta
  │     │     │     instead of velocity-based — Run 2 identified as root cause of wall-slide bugs)
  │     │     ├─ world.step() — runs FULL solver with zero dynamic bodies (WASTE)
  │     │     ├─ characterController.computeColliderMovement(capsule, desiredMovement)
  │     │     ├─ correctedMovement = controller.computedMovement()
  │     │     ├─ newPos = lastCorrected + correctedMovement
  │     │     ├─ Write corrected position BACK to playerView[o+0..2]  ← WRITES WASM MEMORY
  │     │     ├─ Velocity ratio-based damping (WRONG for diagonal walls, OK for axis-aligned)
  │     │     ├─ Y-axis velocity NOT corrected for ceiling hits (oscillation bug)
  │     │     └─ Return { grounded }
  │     ├─ window._rapierGrounded = rapierResult.grounded
  │     └─ Module._setRapierGrounded(grounded ? 1 : 0)  ← FEEDS BACK TO WASM
  │
  │     DATA FLOW: WASM → playerView → Rapier → playerView (mutated) → WASM (grounded flag)
  │     KNOWN ISSUES: Double terrain clamping (Rapier heightfield + WASM both clamp).
  │                   Fix: Rapier collision groups to exclude terrain.
```

### Phase C — Prediction + Network Reconciliation

```
  │     ◄── NEW SECTION: Run 1 missed this entirely
  │
  ├─ [4b] prediction.applyPendingCorrection()
  │     index.html:4364-4377 — runs in its OWN requestAnimationFrame loop
  │     ├─ Reads elapsed time since last correction
  │     ├─ Computes eased interpolation factor
  │     └─ Calls Module._setLocalPlayerNetCorrection(x, y, z, yaw, pitch)
  │         Nudges WASM player position toward server-authoritative state over 200ms
  │
  │     WIRING: network.js snapshot → window.__tribesReconcile (index.html)
  │             → prediction.reconcile(snap, getLocalPlayerWasm)
  │             → sets smoothCorrection
  │             → applyPendingCorrection() applies it each frame
  │
  │     NOTE: inputHistory is populated 60x/sec but never replayed by reconcile().
  │           Reconciliation is "measure and blend," not "measure, replay, and correct."
```

### Phase D — Environment Updates

```
  ├─ [5] DayNight.update()
  │     renderer.js:5293 — try/catch wrapped
  │     ├─ Advances internal clock (30-min cycle)
  │     ├─ Computes dayMix (0=midnight, 1=noon)
  │     ├─ Lerps sunLight/hemiLight colors and intensities
  │     ├─ Sets fog color + density
  │     ├─ Sets renderer.toneMappingExposure (RACES with HDRI callback — W1)
  │     ├─ Sets scene.environmentIntensity
  │     ├─ Corrects window.__nightAmbient color to 0x304060 ◄── fixes typo from init
  │     ├─ Writes HUD clock via window.__tribesSetGameClock
  │     NOTE: freeze/unfreeze API is BROKEN (N4) — external freeze(h) sets this._frozen
  │           but update() reads closure _frozen01. Two different variables.
  │
  ├─ [6] Night-adaptive bloom
  │     renderer.js:5297-5304 — adjusts bloomPass strength/threshold based on DayNight.dayMix
  │
  ├─ [7] updateCustomSky(t, dayMix, sunDir, camera.position)
  │     renderer_sky_custom.js — updates sky dome colors, cloud drift, star twinkle, sun/moon
  │     Frame-rate dependent star fade: += (target - current) * 0.05 (no dt)
```

### Phase E — Entity Sync (WASM → Three.js)

```
  ├─ [8] syncPlayers(t)
  │     renderer.js:3744-3875
  │     ├─ FOR each player i = 0..MAX_PLAYERS-1:      (MAX_PLAYERS = 16, should be 64)
  │     │     ├─ IF i !== localIdx → mesh.visible = false; CONTINUE
  │     │     │     ◄── ALL remote players hidden (intentional single-player disable, not test hack)
  │     │     ├─ Read pos/rot/vel/team/armor/alive from playerView magic offsets
  │     │     ├─ Swap mesh if armor changed, voice spatialization, team color tint
  │     │     └─ Animate rig
  │     MAGIC OFFSETS (definitive from Phase 3a Run 2 — 21-field layout):
  │       o+0(posX), o+1(posY), o+2(posZ), o+3(pitch), o+4(yaw), o+5(roll),
  │       o+6(velX), o+7(velY), o+8(velZ), o+9..10(reserved),
  │       o+11(team), o+12(armor), o+13(alive), o+14(jetting), o+15(skiing),
  │       o+16..17(reserved), o+18(visible), o+19(reserved), o+20(spawnProt)
  │
  ├─ [9] Characters.sync(t, playerView, playerStride, localIdx, playerMeshes)
  │     renderer_characters.js — overlays rigged GLB model on local player (3P only)
  │     _chars Array(16) is MEDIUM risk (sparse arrays work), not CRITICAL
  │     Math.PI yaw offset is model-specific hardcode
  │
  ├─ [10] syncProjectiles()
  │     renderer.js:3937-3955 — 256 individual Mesh objects
  │     NEW: 256 IDENTICAL SphereGeometry instances (should share 1 + 9 per-type materials)
  │
  ├─ [11] syncFlags(t)
  │     renderer.js:3096-3121 — hardcoded 2 flags, 2 teams
  │
  ├─ [12] syncParticles()       ├─ [13] syncTurretBarrels(t)
```

### Phase F — Camera

```
  ├─ [14] syncCamera()
  │     renderer.js:4073-4270 — 6 code paths (1P alive, 3P alive, mid-toggle, spectator,
  │     invalid index, unspawned)
  │     ├─ ZoomFX: fov *= window.ZoomFX.getFovMultiplier()
  │     │     ZoomFX runs its OWN unconditional RAF loop (worst self-RAF offender)
  │     ├─ Shadow texel snapping, sun light follow camera
  │     └─ Feed aim to WASM: Module._setLocalAimPoint3P(x,y,z)
```

### Phase G — Particle Systems (CPU-driven)

```
  ├─ [15] updateRain(1/60, camPos)        — opt-in only (?rain=on), early-bails if not init'd
  ├─ [16] updateSkiParticles(1/60)        — active
  ├─ [17] updateProjectileTrails(1/60)    — active
  ├─ [18] updateExplosionFX(1/60)         — active (architecturally distinct from 16-17)
  ├─ [19] updateNightFairies(1/60, t)     — active (GPU-driven vertex shader, distinct)
  ├─ [20] updateInteriorLights()          — active
  │  
  │  Unification target: systems 15-17 + jet exhaust (dead) → 1 parametric pool
  │  Explosions (18) and fairies (19) stay separate — architecturally distinct
```

### Phase H — Polish + HUD + Effects

```
  ├─ [21] polish.tick(dt, t)
  │     renderer_polish.js — 17+ subsystems in 1,146 lines
  │     Camera shake is a dependency hub (4 subsystems trigger it)
  │     Telemetry reads WRONG offsets: o+4/5/6 (yaw/roll/velX) instead of o+6/7/8 (vel)
  │     2 faction palettes only (inferno/storm). Game design needs 4.
  │     Shockwave uses independent RAF (desynchronized from game clock)
  │     No phase awareness anywhere in the file
  │
  ├─ [22] CombatFX.update(dt)            — singleton (can't render other players' FX)
  ├─ [23] _updateViewmodelSway(dt)
  ├─ [24] CommandMap.update()             — self-RAF when open (conditional)
  ├─ [25] Minimap.update()
  ├─ [26] Cohesion.tick()                — DEAD (return; as first statement). KILL module.
  ├─ [27-29] updateGrassRing/updateDustLayer/Terrain uTime
```

### Phase I — Render

```
  ├─ [30] composer.render() OR renderer.render(scene, camera)
  │     RenderPass → UnrealBloomPass → ShaderPass(gradePass) → OutputPass → SMAAPass
  │     applyQuality() leaks old composer render targets (~40MB per quality change)
  │     No dispose() on any module-level GPU resources
  │
  └─ [31] requestAnimationFrame(loop)
```

### Corrected Frame Trace Summary

| Step | Module | Correction from Run 1 |
|------|--------|-----------------------|
| 3 | _tick() | Takes 0 params, not dt. WASM owns timing. |
| 4 | Rapier | Intentional migration, not accidental. Velocity correction exists but inadequate. |
| 4b | Prediction | **NEW STEP** — prediction IS wired via index.html. Applies smooth corrections each frame. |
| 5 | DayNight | Night ambient typo is Low, not Critical (corrected before visible). |
| 8 | syncPlayers | Remote players hidden is "intentional disable," not "test hack." |
| All | HEAPF32 | All typed array views are SAFE. No memory growth possible. |
| All | ASM_CONSTS | All 19 entries have null guards. No boot-race crash risk. |

**Total per-frame global reads: ~18 distinct window.* globals** (unchanged)
**Total per-frame global writes: ~8 distinct window.* globals** (unchanged)
**Total per-frame WASM calls: ~12 distinct Module._* calls** (unchanged)
**Self-RAF loops running alongside main loop: 2** (ZoomFX unconditional, CommandMap conditional)

---

## 2. Corrected Global Inventory

### Run 1 counted 83 window.* globals. Run 2 corrections:

**Removed (dead module):**
- `window.Cohesion` — module flagged for KILL. Tick is dead code. Mood bed → audio.js. **(-1)**

**Reclassified:**
- `window.__nightAmbient` — Run 1 called it "orphaned self-reference." Run 2 confirms DayNight._apply() reads it every frame to correct the color. It IS cross-subsystem (DayNight IIFE → initLights result). Still should be module-scope, but not orphaned.
- `window._tribesCamDist` / `window._tribesCamHeight` — confirmed as true self-references (renderer.js only writer and reader). Should be module-scope lets.
- `window._r327PrevCarry` / `window._flagStingMuted` — confirmed as single-file self-references in renderer_polish.js.

**Added from Run 2 discoveries:**
- `window.__tribesReconcile` — defined in index.html, called by network.js. The prediction bridge. **(already counted in Run 1 as #60)**
- `window.__tribesApplyDelta` — defined in index.html, called by network.js. **(already counted in Run 1 as #76)**
- `window.AE` — audio engine context, used by cohesion mood bed and shell.html. **(already counted as #10)**

No NEW globals were discovered that Run 1 missed. Run 1's grep was comprehensive.

### Corrected Count

| Change | Delta |
|--------|-------|
| Run 1 total | 83 |
| Remove Cohesion (dead module) | -1 |
| **Run 2 DEFINITIVE total** | **82 distinct window.* globals** |

### Corrected Category Summary

| Category | Count | Change from Run 1 |
|----------|-------|--------------------|
| API Facade | 37 | -1 (Cohesion removed) |
| WASM Bridge | 12 | unchanged |
| Shared Data | 20 | unchanged |
| Debug | 8 | unchanged |
| Config | 3 | unchanged |
| Self-reference (should be module-scope) | 2 | reclassified from Run 1's "Dead" + "Orphaned" |
| **TOTAL** | **82** | |

### Orphaned Globals (corrected)

| Global | Issue | Run 2 Status |
|--------|-------|-------------|
| `window._r327PrevCarry` | renderer_polish.js self-reference | Still orphaned — module-scope let |
| `window._flagStingMuted` | renderer_polish.js self-reference | Still orphaned — module-scope let |
| `window.registerModelCollision` | renderer.js self-reference | Still orphaned — module-scope function |
| `window.__nightAmbient` | ~~orphaned~~ → DayNight reads it | **RECLASSIFIED: not orphaned** |
| `window._tribesCamDist/Height` | renderer.js camera self-reference | Still orphaned — module-scope lets |
| ~~`window.Cohesion`~~ | ~~dead module~~ | **REMOVED: module killed** |

**Run 2 orphaned count: 5 globals** (down from 8 in Run 1 — removed Cohesion, reclassified nightAmbient, removed duplicate counting)

---

## 3. Corrected Dead Code Count

### Run 1 claimed ~1,400 lines. Run 2 corrections:

**prediction.js reclassification:**
- Run 1 said prediction.js was ~140 lines of dead code (reconcile never called)
- Run 2 Phase 3c proved: reconcile() IS called via index.html. applyPendingCorrection() IS called every frame. recordInput() IS called 60x/sec.
- Only `inputHistory` population (~10 lines) is vestigial (populated but never replayed)
- **Reclassification: -130 lines** (from ~140 dead → ~10 vestigial)

**renderer_characters.js dead code verified:**
- ~77 lines confirmed dead (demo system + vestigial nulls + _modelScale)

**renderer.js dead code corrected (Phase 1 Run 2):**
- Hard dead: jet exhaust (63) + dust layer (272) + terrain carve (65) + wind functions (30) = **430 lines**
- Opt-in only: rain (115) + grass ring (290) = **405 lines**
- Run 1 said "~1,050 lines." Run 2 measured **~835 lines** (430 hard dead + 405 opt-in)

**renderer_polish.js dead code verified:**
- _playFlagSting: 44 lines (Run 1 said 34)
- Rain splashes: 54 lines
- Wear & tear + subdivision stubs: 11 lines
- Total: **~109 lines** (Run 1 said ~90)

**renderer_cohesion.js — entire module:**
- 124 lines total. 42 lines of mood bed should move to audio.js. 82 lines dead.
- **82 lines dead** (Run 1 said 138 — the 42 mood bed lines are live, not dead)

**index.html dead code (new from Run 2):**
- First `window.sbFinish` definition: ~68 lines overwritten by second definition
- `Module._restartGame` call: 1 line (phantom export)
- **~69 lines** (not counted in Run 1)

### Corrected Dead Code Summary

| Source | Run 1 Estimate | Run 2 Verified |
|--------|---------------|----------------|
| renderer.js (hard dead) | ~1,050 | **~430** (excluding opt-in) |
| renderer.js (opt-in, effectively dead) | (included above) | **~405** |
| renderer_characters.js | ~80 | **~77** |
| renderer_polish.js | ~90 | **~109** |
| renderer_cohesion.js | 138 (entire module) | **~82** (42 lines are live mood bed) |
| prediction.js | 140 (entire module) | **~10** (only inputHistory vestigial) |
| index.html | (not counted) | **~69** |
| **TOTAL (hard dead)** | **~1,400+** | **~677 hard dead** |
| **TOTAL (including opt-in)** | — | **~1,082 dead or effectively dead** |

**Run 1 overcounted by ~320 lines** primarily because:
1. prediction.js was incorrectly classified as entirely dead (-130 lines)
2. renderer.js opt-in code was conflated with hard dead code
3. renderer_cohesion mood bed is live code (-56 lines)
4. index.html dead code was not counted at all (+69 lines)

---

## 4. Corrected 2-Team Hardcoding List

### Run 1 said 12 files, 28 locations. Run 2 corrections:

**Removed from list:**
- `renderer_combat_fx.js` — team-AGNOSTIC, not team-HARDCODED. Uses single brass color `0xffd070` for ALL teams. This is a missing feature (no team differentiation), not a broken feature (wrong team assumption). **(-1 file, ~1 location)**

**Corrected counts within files:**
- `client/mapeditor.js` — Run 1 counted 5 sites. Run 2 found 6 (missed the find/filter logic). **(+1 location)**
- `renderer_polish.js` — Run 1 counted correctly (2 faction palettes)
- `renderer_minimap.js` — Player dots have `|| '#888'` grey fallback. Still 2-team hardcoded but degrades gracefully, not invisibly.

**NEW finding: Team color index inconsistency**
This is WORSE than simple hardcoding. Modules disagree on which team gets which color:

| Module | Team 0 Color | Team 1 Color | Convention |
|--------|-------------|-------------|------------|
| renderer_palette.js | `#E84A4A` (red) | `#4A8AE8` (blue) | team 0 = red |
| renderer.js | `0xC8302C` (red) | `0x2C5AC8` (blue) | team 0 = red |
| client/mapeditor.js | `#C8302C` (red) | `#2C5AC8` (blue) | team 0 = red |
| client/replay.js | `#FF6464` / `#C8302C` (red) | `#6498FF` / `#2C5AC8` (blue) | team 0 = red |
| index.html | red | blue | team 0 = red |
| **renderer_minimap.js** | **`#3FA8FF` (BLUE)** | **`#FF6A4A` (RED)** | **team 0 = BLUE** ← INVERTED |
| **renderer_command_map.js** | **`#3FA8FF` (BLUE)** | **`#FF6A4A` (RED)** | **team 0 = BLUE** ← INVERTED |

**The minimap and command map have team colors INVERTED** relative to every other module. This is a LATENT VISUAL BUG — team 0 appears red everywhere except on the minimap/command map where it appears blue.

### Corrected Master List

| # | File | Location Count | Key Hardcoded Elements |
|---|------|---------------|----------------------|
| 1 | renderer.js | 12 | MAX_PLAYERS=16, TEAM_COLORS[3], TEAM_TINT_HEX[3], flagMeshes[2], flagView for 2 flags, _teamAccent silent grey fallback, binary ternaries |
| 2 | renderer_minimap.js | 4 | TEAM_COLORS[2], FLAG_COLORS[2], flag loop `i < 2`, **team 0=BLUE (INVERTED)** |
| 3 | renderer_command_map.js | 4 | teamColors[3], flag loop `i < 2`, **team 0=BLUE (INVERTED)** |
| 4 | renderer_palette.js | 2 | teamColor() binary switch, only teamRed/teamBlue defined |
| 5 | renderer_polish.js | 1 | 2 faction palettes ("inferno"/"storm") |
| 6 | client/mapeditor.js | 6 | flags[2], spawns[2], binary ternaries, point type dropdown, find/filter |
| 7 | client/replay.js | 5 | Player/flag colors binary, teamScore[2], carrier ring binary |
| 8 | client/wire.js | 2 | teamScore[2], flags[2] in binary format |
| 9 | index.html | 1 | `team === 0 ? red : (team === 1 ? blue : neutral)` |
| 10 | shell.html | 1 | Same ternary pattern |
| **Total** | **10 files** | **~38 locations** | |

**Plus 1 team-agnostic module needing differentiation:**
| 11 | renderer_combat_fx.js | 1 | Single tracer color for all teams (missing feature) |

### Comparison with Run 1

| Metric | Run 1 | Run 2 |
|--------|-------|-------|
| Files with 2-team hardcoding | 12 | **10** (removed combat_fx as "agnostic not hardcoded," corrected count) |
| Total hardcoded locations | ~28 | **~38** (deeper search found more sites) |
| Files with team-agnostic gap | 0 | **1** (combat_fx) |
| Files with team color INDEX bug | 0 | **2** (minimap + command_map: team 0=blue vs team 0=red) |

---

## 5. Cross-Module Contradiction Check (Updated)

### 5.1 Player State Stride Offsets — DEFINITIVE Map

Run 2 Phase 3a produced the authoritative 21-field layout. Run 1's map had 14 documented fields. Run 2 fills the gaps:

| Offset | Field | Verified By | Used In | Contradiction? |
|--------|-------|-------------|---------|----------------|
| o+0 | posX | renderer.js, characters.js, rapier.js, index.html | All 4 files | ✅ Consistent |
| o+1 | posY | renderer.js, characters.js, rapier.js, index.html | All 4 files | ✅ Consistent |
| o+2 | posZ | renderer.js, characters.js, rapier.js, index.html | All 4 files | ✅ Consistent |
| o+3 | pitch (rotX) | renderer.js L3808, index.html L4360 | 2 files | ✅ Consistent |
| o+4 | yaw (rotY) | renderer.js L3803, characters.js L206 | 2 files | ❌ **polish.js reads as velX** |
| o+5 | roll (rotZ) | index.html L4360 | 1 file | ❌ **polish.js reads as velY** |
| o+6 | velX | renderer.js L3856, characters.js L208, rapier.js | 3 files | ❌ **polish.js reads as velZ** |
| o+7 | velY | rapier.js (o+7) | 1 file | ✅ (not widely read) |
| o+8 | velZ | renderer.js L3856, characters.js L208, rapier.js | 3 files | ✅ Consistent |
| o+9..10 | reserved | — | — | — |
| o+11 | team | renderer.js L3754 | 1 file | ✅ |
| o+12 | armor | renderer.js L3755 | 1 file | ✅ |
| o+13 | alive (>0.5) | renderer.js L3753, characters.js L188 | 2 files | ✅ Consistent |
| o+14 | jetting (>0.5) | renderer.js L3855, characters.js L209 | 2 files | ✅ Consistent |
| o+15 | skiing (>0.5) | renderer.js L3857, characters.js L210 | 2 files | ✅ Consistent |
| o+16..17 | reserved | — | — | — |
| o+18 | visible (>0.5) | renderer.js L3752, characters.js L189 | 2 files | ✅ Consistent |
| o+19 | reserved | — | — | — |
| o+20 | spawnProt | renderer.js L3765 | 1 file | ✅ |

**Active contradiction:** renderer_polish.js telemetry reads o+4/5/6 as velocity. Should read o+6/7/8. Displays yaw+roll+velX as "speed." Dominant term (velX at o+6) is correct-ish by coincidence but noise from yaw makes the reading unreliable. **CONFIRMED BUG.**

**No shared constants file exists.** 4 files independently hardcode magic offsets. A C++ struct reorder breaks 4 files silently.

### 5.2 Team Color Index Contradiction — NEW

| Convention | Modules | Team 0 | Team 1 |
|-----------|---------|--------|--------|
| **team 0 = RED** | renderer.js, palette.js, mapeditor.js, replay.js, index.html, shell.html, polish.js | Red variant | Blue variant |
| **team 0 = BLUE** | minimap.js, command_map.js | Blue `#3FA8FF` | Red `#FF6A4A` |

**8 modules say team 0 is red. 2 modules say team 0 is blue.** The minimap and command map render the wrong color for each team. This is currently hidden because there's only one local player and team assignment is arbitrary in single-player testing. The moment 2+ teams are visible simultaneously, the minimap shows the wrong colors.

### 5.3 Team Color HEX Value Contradiction — NEW

Even among modules that agree on team index, the hex values diverge:

| Team 0 (Red) Hex Values | Used By |
|--------------------------|---------|
| `0xC8302C` / `#C8302C` | renderer.js, mapeditor.js |
| `0xCC4444` | renderer.js (TEAM_TINT_HEX) |
| `#E84A4A` | palette.js |
| `#FF6464` | replay.js (dots) |
| `#FF6A4A` | minimap.js, command_map.js (but as team 1!) |

**At least 5 different "red" hex values** for the same team. The palette was supposed to unify these. Nobody uses it.

### 5.4 Coordinate Space Contradictions (Updated)

| Module | Space | Contradiction? |
|--------|-------|----------------|
| renderer.js (terrain) | World meters, Y-up, origin-centered | ✅ |
| renderer_rapier.js | World meters, Y-up | ✅ |
| renderer_characters.js | World meters, Y-up | ✅ |
| renderer_polish.js telemetry | Reads o+4,5,6 as velocity | ❌ **WRONG** (yaw/roll, not vel) |
| client/wire.js flag decode | Drops Z component, hardcodes to 0 | ❌ **FLAG Z LOST** |

### 5.5 Init/Dispose Lifecycle Contradictions (Updated)

| Module | Has init() | Has dispose() | Has cleanup on disconnect |
|--------|-----------|---------------|--------------------------|
| renderer.js | ✅ start() | ❌ | ❌ (N8: no dispose() anywhere) |
| renderer_rapier.js | ✅ initRapierPhysics() | ❌ | ❌ (no removeCollider/destroy) |
| renderer_buildings.js | ✅ init() | ✅ dispose() | ✅ |
| renderer_characters.js | ✅ init() | ❌ | ❌ (zombie models) |
| renderer_polish.js | ✅ installPolish() | ❌ (7 DOM + 2 listeners leak) | ❌ |
| renderer_combat_fx.js | ✅ init() | ❌ | ❌ |
| renderer_minimap.js | ✅ init() | ❌ (canvas leaks) | ❌ |
| renderer_command_map.js | ✅ init() | ❌ (canvas + RAF leak) | ❌ |
| renderer_sky_custom.js | ✅ initCustomSky() | ✅ removeOldSky() | ✅ |
| client/network.js | ✅ start() | ❌ (WebSocket + intervals leak) | ❌ |

**Only 2 of 10 major modules have proper cleanup.** This is unchanged from Run 1.
`renderer_buildings.js` and `renderer_sky_custom.js` are the only modules with lifecycle management.

### 5.6 RAF Ownership (Updated)

| Module | RAF Usage | Justified? | Run 2 Severity |
|--------|----------|-----------|----------------|
| renderer.js | Main `loop()` | ✅ Canonical | — |
| renderer_zoom.js | `_boot()` — UNCONDITIONAL | ❌ Worst offender. Runs every frame, even at zoom=1.0 | HIGH |
| renderer_command_map.js | `_startSelfLoop()` — conditional on open | ❌ Should use main loop | MEDIUM |
| renderer_polish.js shockwave | Per-shockwave RAF chain | ❌ Desynchronized from game clock | MEDIUM |
| index.html prediction | `predictionFrame()` — always running | ⚠️ Should sync with main loop | LOW |
| client/replay.js | Full-screen modal RAF | ✅ Correct — replaces game renderer | — |

**4 rogue RAF loops** (3 from Run 1 + prediction loop newly identified). Replay's is correctly justified.

### 5.7 Prediction Pipeline (Corrected from Run 1)

Run 1 listed "prediction.reconcile() never called" as a cross-module contradiction. **This is WRONG.** The pipeline is:

```
network.js receives snapshot
  → window.__tribesReconcile(snap)          [index.html defines this]
    → prediction.reconcile(snap, getWasm)   [measures divergence]
      → sets smoothCorrection
        → predictionFrame() RAF loop
          → prediction.applyPendingCorrection(Module._setLocalPlayerNetCorrection, getWasm)
            → writes corrected position to WASM
```

**This is NOT a contradiction. The prediction pipeline works.** The only vestigial part is `inputHistory` (~10 lines populated but never replayed).

---

## 6. Integration Risk Assessment — TRUE Top 10 Systemic Issues (Reranked)

Given all Run 2 corrections, here are the definitive top 10 systemic issues.

### Run 2 Definitive Ranking

| # | Issue | Severity | Scope | Why It Changed from Run 1 |
|---|-------|----------|-------|---------------------------|
| 1 | **82 window.* globals — no module boundaries** | CRITICAL | System-wide | Run 1 said 83. Cohesion removed. Still the #1 systemic issue. Every module communicates through undocumented global mutable state. |
| 2 | **2-team hardcoding in 10 files + team color INDEX bug** | CRITICAL | System-wide | Run 1 said 12 files. Run 2 says 10 hardcoded + 1 agnostic + 2 with INVERTED team index. The index bug is NEW and worse than simple hardcoding. |
| 3 | **No shared player state stride constants** | CRITICAL | Cross-module | **UPGRADED from HIGH.** Active bug proven: polish.js reads yaw as velocity. 4 files with independent magic numbers. A C++ struct change breaks 4 files silently. |
| 4 | **Only 2/10 modules have dispose()** | HIGH | Per-module | Unchanged. Blocks map transitions, phase transitions, and testing. |
| 5 | **No entity interpolation for remote players** | HIGH | Networking | **NEW entry.** Remote players teleport 10-30 times/sec. No interpolation in JS networking stack. The biggest gameplay quality gap. |
| 6 | **loadMap() + applyQuality() GPU memory leaks** | HIGH | renderer.js | **NEW from Run 2 Phase 1.** Building meshes not disposed on map change. Composer targets not disposed on quality change (~40MB per change). |
| 7 | **Rapier velocity correction bugs** | HIGH | renderer_rapier.js | Run 1 identified dual-physics desync. Run 2 pinpointed: position-delta inputs (should be velocity), ceiling oscillation, snap-to-ground jitter, double terrain clamping. Fix path is clear (velocity-based CC + collision groups). |
| 8 | **4 rogue RAF loops** | MEDIUM | 4 modules | Run 1 said 3. Run 2 adds prediction loop. ZoomFX is worst (unconditional). Causes timing desync and unaccounted frame budget. |
| 9 | **~1,082 lines dead/disabled code** | MEDIUM | System-wide | Run 1 said ~1,400. Run 2 corrects to ~1,082 (677 hard dead + 405 opt-in). Prediction is NOT dead (-130). Still a maintenance burden with hidden allocation risk (grass ring = 213MB if enabled). |
| 10 | **index.html (~3,200 LOC) partially audited** | MEDIUM | Gap | Run 1 said 4,500 LOC, fully unaudited. Run 2 corrected to 3,200 LOC and partially audited (prediction pipeline, WASM bridge, sbFinish duplication, phantom _restartGame). Still the largest remaining audit gap. |

### Issues Removed from Run 1's Top 10

| Run 1 # | Issue | Why Removed |
|---------|-------|-------------|
| 7 | Telemetry reads wrong stride offsets | **Absorbed into #3** (shared constants issue). The telemetry bug is a symptom, not a root cause. |
| 8 | renderer_cohesion.js should be killed | **Resolved** — Kill verdict is unanimous. Not a "systemic issue" — it's a 15-minute delete. |
| 10 | Flag Z lost in wire.js decode | **Downgraded** — still a real bug but not top-10 systemic. It's a 2-line fix in one file. |

### Issues Added to Top 10

| # | Issue | Why Added |
|---|-------|-----------|
| 5 | No entity interpolation | Run 1 had this buried in Phase 3c. It's the biggest gameplay impact after team hardcoding. |
| 6 | GPU memory leaks | Run 2 Phase 1 discovered loadMap and applyQuality leaks. Blocks map rotation. |
| 7 | Rapier velocity bugs | Run 2 Phase 2b deepened understanding. Ceiling oscillation and snap-to-ground jitter are concrete gameplay bugs. |

---

## 7. Expert Panel Integration Dialogue (Run 2)

### Carmack Opens

**Carmack:** "Run 2 has corrected Run 1's three biggest errors: prediction IS wired, HEAPF32 IS safe, and ASM_CONST callbacks DO have guards. With those corrections, the codebase is in better shape than Run 1's doom-and-gloom picture suggested. But the remaining issues are real and systemic.

The 82 globals remain the fundamental architectural debt. The team color INDEX bug — minimap showing blue where everyone else shows red — is a new finding that's actually worse than simple 2-team hardcoding because it's a logic error, not just a missing feature. And the stride offset problem has been proven to cause real bugs (telemetry). These three are the integration issues that matter most."

### Muratori on Prediction

**Muratori:** "I want to take responsibility for Run 1's prediction error. We searched ES module imports and missed the index.html bridge. The lesson is clear: in a codebase with mixed module systems (ES modules + script tags + window.* bridges), you can't grep only one layer. The prediction pipeline is clever — it uses window.* globals as a bridge between the ES module world and the script-tag world. That's the REASON 82 globals exist: they're the duct tape holding two module systems together."

### ryg on Performance

**ryg:** "The performance picture from Run 2 is more nuanced than Run 1 suggested. The big wins are:
1. **256 identical SphereGeometry → 1 shared + 9 per-type materials** — cuts projectile draw calls from 256 to ~20 (Phase 1 N3)
2. **Rapier terrain collision group exclusion** — eliminates double-clamping with one line change (Phase 2b consensus)
3. **ZoomFX RAF → main loop integration** — removes the worst unconditional rogue loop (Phase 4)

These three changes are each 15-30 minutes of work and collectively improve both correctness and performance."

### Barrett on index.html

**Barrett:** "Run 2 validated index.html as the audit gap but also partially filled it. We now know: prediction is wired there, sbFinish is duplicated there, _restartGame is phantom there, Float32Array views are allocated per-frame there, and 45 globals are defined there. The remaining unaudited surface is the HUD rendering, audio engine, settings/loadout UI, chat, and multiplayer lobby — roughly 2,000 lines. I'd estimate one more focused phase would complete the index.html audit."

### Ive on Design Coherence

**Ive:** "Run 2 revealed that the design coherence problem is deeper than Run 1 described. It's not just '2 teams instead of 4.' It's that the codebase can't agree on which team is which COLOR even for the 2 teams it has. The palette module exists to solve this — and nobody uses it. The team_config.js constant module from the refactoring plan isn't a nice-to-have; it's a correctness requirement. Without it, adding teams 2 and 3 will produce visual chaos."

### Acton on Data

**Acton:** "The definitive stride map from Phase 3a Run 2 is the most valuable concrete output of the entire audit. It's 21 fields verified across 4 files. player_layout.js should be the FIRST thing written — before any extraction, before any new feature. It prevents the entire class of 'read yaw as velocity' bugs and makes every future C++ struct change visible to JS consumers."

### Panel Consensus

**Carmack:** "Final consensus. The codebase is more functional than Run 1 suggested — prediction works, HEAPF32 is safe, ASM_CONST guards exist. But the architectural debt is real: 82 globals, no shared constants, no lifecycle management, and the team system is both incomplete AND inconsistent. The refactoring plan from Phase 6 Run 1 is sound with the corrections from Phase 1 Run 2: reduce to 8-10 modules, reorder by risk, add frame update order contract. The single highest-value immediate action is creating `player_layout.js` — it's a 30-minute fix that eliminates a proven class of bugs."

---

## 8. Completeness Verification

### Run 2 Documentation Gaps Remaining

| Gap | Status | Priority |
|-----|--------|----------|
| index.html full audit | ~60% complete (prediction, WASM bridge, sbFinish, phantom export done; HUD/audio/settings/lobby remain) | HIGH |
| lessons-learned.md updates | 15 entries proposed by Run 1 Phase 5, plus Run 2 discoveries. Not yet written. | MEDIUM |
| patterns.md missing patterns | Weapon viewmodel, DOM HUD overlay, WASM callback bridge | LOW |
| system-map.md index.html section | Partial — 45 globals documented but writer/reader mapping incomplete | MEDIUM |

### Run 2 Cumulative Stats

| Metric | Run 1 | Run 2 | Delta |
|--------|-------|-------|-------|
| Phases completed | 6 (all) | 5 of 6 (Phase 6 remaining) | — |
| Findings validated | — | ~85 (across all phases) | — |
| Findings CORRECTED | — | 11 (3 WRONG, 8 severity changes) | — |
| New findings discovered | 70+ | 50+ new in Run 2 | — |
| window.* globals | 83 | 82 (Cohesion removed) | -1 |
| Dead code lines | ~1,400 | ~1,082 (677 hard + 405 opt-in) | -318 |
| 2-team hardcoded files | 12 | 10 (+1 agnostic, +2 index-inverted) | corrected |
| Cross-module contradictions | 5 categories | 7 categories (added team index, hex values) | +2 |
| Rogue RAF loops | 3 | 4 (added prediction) | +1 |

---

## Deliverable Summary

This Phase 5 Integration Audit (Run 2) has produced:

1. **Corrected end-to-end frame trace** — 32 steps with prediction pipeline added, HEAPF32 safety confirmed, _tick() 0-param correction, ASM_CONST guard correction
2. **Corrected window.* global inventory** — 82 globals (down from 83: Cohesion removed). 5 orphaned (down from 8).
3. **Corrected dead code count** — ~1,082 lines (down from ~1,400: prediction.js reclassified as live, renderer_cohesion mood bed is live)
4. **Corrected 2-team hardcoding list** — 10 files, ~38 locations (corrected from 12 files, 28 locations). NEW: team color INDEX bug in minimap/command_map.
5. **Definitive player state stride map** — 21 fields verified across 4 files. Active bug confirmed (polish telemetry).
6. **Updated cross-module contradictions** — 7 categories (added team color index, hex value divergence). Prediction contradiction REMOVED (it works).
7. **Reranked Top 10 systemic issues** — entity interpolation, GPU leaks, and Rapier bugs added. Telemetry offset, Cohesion kill, and flag Z removed as top-10 (absorbed or downgraded).

**Key narrative correction:** Run 1 painted the codebase as more broken than it is. Prediction works. HEAPF32 is safe. ASM_CONST has guards. The dual-physics architecture is intentional. The real issues are: global state management (82 globals), team system inconsistency (index bug + color divergence), missing shared constants (proven bug), and lifecycle debt (8/10 modules leak). These are all fixable without rearchitecting.
