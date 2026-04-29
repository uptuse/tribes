# Phase 5 — Integration Audit (Run 1)

**Scope:** Full cross-module end-to-end audit
**Date:** 2026-04-29
**Panel:** Carmack, Muratori, ryg, Abrash, Acton, Barrett, Ive

---

## 1. End-to-End Frame Trace

One complete frame, from browser event to pixels on screen.

### Phase A — Input + Simulation (WASM)

```
requestAnimationFrame(loop)
  │
  ├─ [1] Module._isReady() check
  │     renderer.js:5266 — guard: if WASM not ready, re-queue RAF and bail
  │
  ├─ [2] t = performance.now() * 0.001
  │     renderer.js:5270 — wall-clock seconds, used as game clock for ALL subsystems
  │
  ├─ [3] Module._tick()
  │     renderer.js:5271 — enters WASM, runs one simulation step:
  │       ├─ C++ integrates physics (gravity, skiing friction, jetting thrust)
  │       ├─ C++ resolves projectile hits, flag pickups, damage
  │       ├─ C++ writes player/projectile/particle/flag/building state to HEAPF32
  │       ├─ C++ calls ASM_CONSTS (→ window.*) during tick:
  │       │     updateHUD(14 params)      → index.html HUD overlay
  │       │     updateMatchHUD(4 params)  → index.html match timer
  │       │     updateAudio(...)          → index.html audio state
  │       │     playSoundAt(id,x,y,z)    → index.html spatial audio (0-N times)
  │       │     onDamageSource(...)       → index.html damage arc
  │       │     onHitConfirm(...)        → index.html hit marker
  │       │     sbRow(...)               → index.html scoreboard row (if _updateScoreboard called)
  │       │     sbFinish(...)            → index.html scoreboard end
  │       │     r3FrameTime(ms)          → index.html perf telemetry
  │       └─ C++ returns control to JS
  │
  └─ Module._tick() has now written all game state to shared memory
```

### Phase B — Collision Resolution (Rapier)

```
  ├─ [4] Rapier collision step
  │     renderer.js:5277-5289 — try/catch wrapped
  │     ├─ localIdx = Module._getLocalPlayerIdx()
  │     ├─ RapierPhysics.stepPlayerCollision(playerView, playerStride, localIdx, 1/60)
  │     │     renderer_rapier.js:
  │     │     ├─ Read WASM-proposed position from playerView[o+0..2]
  │     │     ├─ Compute desiredMovement = proposed - lastCorrected
  │     │     ├─ characterController.computeColliderMovement(capsule, desiredMovement)
  │     │     ├─ correctedMovement = controller.computedMovement()
  │     │     ├─ newPos = lastCorrected + correctedMovement
  │     │     ├─ Write corrected position BACK to playerView[o+0..2]  ← WRITES WASM MEMORY
  │     │     ├─ Velocity damping hack (ratio-based, per-axis)       ← PHYSICALLY WRONG (EC-3)
  │     │     └─ Return { grounded }
  │     ├─ window._rapierGrounded = rapierResult.grounded
  │     └─ Module._setRapierGrounded(grounded ? 1 : 0)  ← FEEDS BACK TO WASM
  │
  │     DATA FLOW: WASM → playerView → Rapier → playerView (mutated) → WASM (grounded flag)
  │     GLOBALS WRITTEN: window._rapierGrounded (Boolean)
```

### Phase C — Environment Updates

```
  ├─ [5] DayNight.update()
  │     renderer.js:5293 — try/catch wrapped
  │     ├─ Advances internal clock (30-min cycle)
  │     ├─ Computes dayMix (0=midnight, 1=noon)
  │     ├─ Lerps sunLight/hemiLight colors and intensities
  │     ├─ Sets fog color + density
  │     ├─ Sets renderer.toneMappingExposure
  │     ├─ Sets scene.environmentIntensity
  │     ├─ Writes window.__nightAmbient intensity
  │     ├─ Writes HUD clock via window.__tribesSetGameClock
  │     GLOBALS READ: window.__nightAmbient, window.__tribesSetGameClock
  │     GLOBALS WRITTEN: DayNight.dayMix, DayNight.sunDir (read by sky, bloom, polish)
  │
  ├─ [6] Night-adaptive bloom
  │     renderer.js:5297-5304 — adjusts bloomPass strength/threshold based on DayNight.dayMix
  │     READS: DayNight.dayMix, bloomPass
  │
  ├─ [7] updateCustomSky(t, dayMix, sunDir, camera.position)
  │     renderer_sky_custom.js — updates sky dome colors, cloud drift, star twinkle, sun/moon positions
  │     READS: DayNight.dayMix, DayNight.sunDir, camera.position
```

### Phase D — Entity Sync (WASM → Three.js)

```
  ├─ [8] syncPlayers(t)
  │     renderer.js:3744-3875 — THE BIG ONE
  │     ├─ localIdx = Module._getLocalPlayerIdx()
  │     ├─ count = Module._getPlayerStateCount()
  │     ├─ FOR each player i = 0..MAX_PLAYERS-1:
  │     │     ├─ Read alive, visible, team, armor from playerView magic offsets
  │     │     ├─ IF i !== localIdx → mesh.visible = false; CONTINUE ← ALL REMOTE PLAYERS HIDDEN
  │     │     ├─ Swap mesh if armor changed
  │     │     ├─ Update shield sphere
  │     │     ├─ Handle 1P/3P visibility
  │     │     ├─ Set position from playerView[o+0..2]
  │     │     ├─ Set rotation from playerView[o+3] (pitch), [o+4] (yaw)
  │     │     ├─ Update nameplate
  │     │     ├─ Voice spatialization via window.__voiceUpdatePeer
  │     │     ├─ Team color tint
  │     │     └─ Animate rig (breathing, pitch)
  │     GLOBALS READ: window.__voice, window.__voiceUpdatePeer, window.__teamColors
  │     MAGIC OFFSETS: o+0(x), o+1(y), o+2(z), o+3(pitch), o+4(yaw), o+6(vx),
  │                    o+8(vz), o+11(team), o+12(armor), o+13(alive), o+14(jetting),
  │                    o+15(skiing), o+18(visible), o+20(spawnProt)
  │
  ├─ [9] Characters.sync(t, playerView, playerStride, localIdx, playerMeshes)
  │     renderer_characters.js — overlays rigged GLB model on local player (3P only)
  │     GLOBALS READ: window._rapierGrounded, window._sampleTerrainH, Module._getThirdPerson
  │
  ├─ [10] syncProjectiles()
  │     renderer.js:3937-3955 — positions projectile meshes from WASM state
  │     256 individual Mesh objects (not instanced)
  │
  ├─ [11] syncFlags(t)
  │     renderer.js:3096-3121 — positions 2 flag meshes from WASM flag state
  │     HARDCODED: 2 flags, 2 teams
  │
  ├─ [12] syncParticles()
  │     renderer.js:3443-3483 — positions WASM-driven particles
  │
  ├─ [13] syncTurretBarrels(t)
  │     renderer.js — animates turret barrel rotation
```

### Phase E — Camera

```
  ├─ [14] syncCamera()
  │     renderer.js:4073-4270
  │     ├─ Read local player position/rotation from playerView
  │     ├─ 1P: camera at head position
  │     ├─ 3P: orbit behind player, lerp distance/height
  │     ├─ Spectator: orbit around death point
  │     ├─ Aim point raycasting → window._tribesAimPoint3P
  │     ├─ Feed aim to WASM: Module._setLocalAimPoint3P(x,y,z)
  │     ├─ ZoomFX: fov *= window.ZoomFX.getFovMultiplier()
  │     ├─ Shadow texel snapping
  │     └─ Sun light follow camera
  │     GLOBALS READ: window.ZoomFX, window._tribesCamDist, window._tribesCamHeight
  │     GLOBALS WRITTEN: window._tribesCamDist, window._tribesCamHeight, window._tribesAimPoint3P
```

### Phase F — Particle Systems (CPU-driven)

```
  ├─ [15] updateRain(1/60, camPos)        — renderer.js:3341-3440 (disabled, early return)
  ├─ [16] updateSkiParticles(1/60)        — renderer.js:4520-4634 (active)
  ├─ [17] updateProjectileTrails(1/60)    — renderer.js:4644-4760 (active)
  ├─ [18] updateExplosionFX(1/60)         — renderer.js:4828-4990 (active)
  ├─ [19] updateNightFairies(1/60, t)     — renderer.js:5025-5190 (active)
  ├─ [20] updateInteriorLights()          — renderer.js:4764-4820 (active)
  │
  │  NOTE: updateJetExhaust disabled (R32.141), updateGrassRing disabled,
  │        updateDustLayer has early return. Three dead update calls per frame.
```

### Phase G — Polish + HUD + Effects

```
  ├─ [21] polish.tick(dt, t)
  │     renderer_polish.js:tick() — 17+ subsystems:
  │     ├─ Lightning (random timer, bolt geometry, thunder audio)
  │     ├─ Camera shake (trauma-based Perlin offset)
  │     ├─ FOV punch (spring recovery)
  │     ├─ Shockwave animation (own RAF loop — BUG, should use game clock)
  │     ├─ Smoke stacks (per-generator Points update)
  │     ├─ Decal management (LRU pool)
  │     ├─ Wet ground toggle
  │     ├─ Damage vignette DOM overlay
  │     ├─ Flag flash DOM overlay
  │     ├─ Telemetry HUD (F3) — READS WRONG OFFSETS (W-1)
  │     ├─ Compass HUD
  │     └─ Settings panel
  │     GLOBALS READ: window.Module, window.playSoundUI, window.ST, window.__tribesApplyQuality
  │
  ├─ [22] CombatFX.update(dt)            — renderer_combat_fx.js
  │     GLOBALS: window.CombatFX (API facade)
  ├─ [23] _updateViewmodelSway(dt)       — renderer.js (weapon sway on jet/ski/idle)
  ├─ [24] CommandMap.update()             — renderer_command_map.js (HAS OWN RAF — BUG)
  │     GLOBALS: window.CommandMap
  ├─ [25] Minimap.update()               — renderer_minimap.js
  │     GLOBALS: window.Minimap
  │
  ├─ [26] Cohesion.tick()                — renderer_cohesion.js (DEAD — kill module)
  │     GLOBALS: window.Cohesion
  ├─ [27] updateGrassRing(t)             — renderer.js (disabled)
  ├─ [28] updateDustLayer(t)             — renderer.js (disabled, early return)
  ├─ [29] Terrain uTime update           — renderer.js:5367-5371
```

### Phase H — Render

```
  ├─ [30] composer.render() OR renderer.render(scene, camera)
  │     If EffectComposer active (default):
  │       RenderPass → UnrealBloomPass → ShaderPass(gradePass) → OutputPass → SMAAPass
  │     If ?nopost: direct Three.js render
  │
  ├─ [31] First-frame diagnostic (one-shot)
  │     renderer.js:5387 — logs scene graph stats
  │
  └─ [32] requestAnimationFrame(loop)
```

### Frame Trace Summary

| Step | Module | Read Globals | Write Globals | WASM Calls |
|------|--------|-------------|---------------|-----------|
| 1-3 | renderer.js/WASM | Module | — | _isReady, _tick |
| 4 | renderer_rapier.js | playerView | _rapierGrounded | _setRapierGrounded |
| 5-7 | renderer.js/sky | __nightAmbient, __tribesSetGameClock | DayNight.*, bloomPass | — |
| 8 | renderer.js | __voice, __voiceUpdatePeer, __teamColors | — | _getLocalPlayerIdx, _getPlayerStateCount |
| 9 | renderer_characters.js | _rapierGrounded, _sampleTerrainH | — | _getThirdPerson |
| 10-13 | renderer.js | — | — | _getProjectileState*, _getFlagState* |
| 14 | renderer.js | ZoomFX, _tribesCamDist/Height | _tribesCamDist/Height, _tribesAimPoint3P | _setLocalAimPoint3P, _getCameraFov |
| 15-20 | renderer.js | — | — | — |
| 21-29 | polish/fx/hud | Module, playSoundUI, ST, etc. | DOM writes | _getLocalPlayerIdx |
| 30 | Three.js | — | — | — |

**Total per-frame global reads: ~18 distinct window.* globals**
**Total per-frame global writes: ~8 distinct window.* globals**
**Total per-frame WASM calls: ~12 distinct Module._* calls**

---

## 2. Complete window.* Global Inventory

### Master Table


Compiled from grep across all .js/.html files (excluding vendor/three/node_modules/tribes.js):

| # | Global | Written By | Read By | Category | Migration |
|---|--------|-----------|---------|----------|-----------|
| 1 | `window.__tribesNet` | index.html | index.html (116 refs) | API Facade | Extract to network manager module |
| 2 | `window.playSoundUI` | index.html | index.html, ASM_CONSTS (52 refs) | WASM Bridge | Keep (WASM callback) |
| 3 | `window.__replay` | client/replay.js | index.html (35 refs) | API Facade | Convert to ES module export |
| 4 | `window.__tiers` | client/tiers.js | index.html (32 refs) | API Facade | Convert to ES module export |
| 5 | `window.__lastReplayUrl` | index.html | index.html (26 refs) | Shared Data | Module-scope variable |
| 6 | `window.playSoundAt` | index.html | ASM_CONSTS, index.html (22 refs) | WASM Bridge | Keep (WASM callback) |
| 7 | `window.DEBUG_LOGS` | index.html | renderer.js, index.html (22 refs) | Debug | Keep (debug flag) |
| 8 | `window.ST` | client/settings.js | renderer.js, polish, index.html (19 refs) | API Facade | Convert to ES module export |
| 9 | `window.__tribesPlayerRoster` | index.html | index.html (18 refs) | Shared Data | Module-scope variable |
| 10 | `window.AE` | index.html | index.html (17 refs) | API Facade | Module-scope (analytics?) |
| 11 | `window.__voiceSetPeerMutedDirect` | client/network.js | index.html (15 refs) | API Facade | Voice module ES export |
| 12 | `window.updateAudio` | index.html | ASM_CONSTS (14 refs) | WASM Bridge | Keep (WASM callback) |
| 13 | `window.onMatchEnd` | index.html | ASM_CONSTS, index.html (14 refs) | WASM Bridge | Keep (WASM callback) |
| 14 | `window.__TRIBES_SERVER_URL` | index.html | client/network.js (13 refs) | Config | ES module import/constant |
| 15 | `window.RapierPhysics` | renderer_rapier.js | renderer.js (12 refs) | API Facade | Convert to ES module export |
| 16 | `window.CombatFX` | renderer_combat_fx.js | renderer.js (12 refs) | API Facade | Convert to ES module export |
| 17 | `window.__editor` | client/mapeditor.js | index.html (11 refs) | API Facade | Convert to ES module export |
| 18 | `window.sbFinish` | index.html | ASM_CONSTS (10 refs) | WASM Bridge | Keep (WASM callback) |
| 19 | `window._skiPeakTimer` | index.html | index.html (10 refs) | Shared Data | Module-scope variable |
| 20 | `window.__tribesSetTerrainPBR` | renderer.js | index.html (10 refs) | API Facade | ES module export |
| 21 | `window.__tribesOnSkillUpdate` | index.html | client/network.js (10 refs) | API Facade | Event emitter / ES module |
| 22 | `window.Toonify` | renderer_toonify.js | renderer.js (9 refs) | API Facade | Convert to ES module export |
| 23 | `window.Cohesion` | renderer_cohesion.js | renderer.js (9 refs) | API Facade | **KILL (module flagged for deletion)** |
| 24 | `window.updateMatchHUD` | index.html | ASM_CONSTS (8 refs) | WASM Bridge | Keep (WASM callback) |
| 25 | `window.updateHUD` | index.html | ASM_CONSTS (8 refs) | WASM Bridge | Keep (WASM callback) |
| 26 | `window.sbRow` | index.html | ASM_CONSTS (8 refs) | WASM Bridge | Keep (WASM callback) |
| 27 | `window.onHitConfirm` | index.html | ASM_CONSTS (8 refs) | WASM Bridge | Keep (WASM callback) |
| 28 | `window.onDamageSource` | index.html | ASM_CONSTS (8 refs) | WASM Bridge | Keep (WASM callback) |
| 29 | `window._skiPeakSpeed` | index.html | index.html (8 refs) | Shared Data | Module-scope variable |
| 30 | `window.__lastMapVoteOptions` | index.html | index.html (8 refs) | Shared Data | Module-scope variable |
| 31 | `window.Module` | Emscripten | everywhere (8 refs explicit) | WASM Bridge | Keep (Emscripten requirement) |
| 32 | `window.r3FrameTime` | index.html | ASM_CONSTS (7 refs) | WASM Bridge | Keep (WASM callback) |
| 33 | `window._tribesCamDist` | renderer.js | renderer.js (7 refs) | Shared Data | **Module-scope let** |
| 34 | `window._tribesAimPoint3P` | renderer.js | renderer.js, WASM (7 refs) | Shared Data | Module-scope, pass to WASM |
| 35 | `window.__voice` | client/network.js | renderer.js, index.html (7 refs) | API Facade | Voice module ES export |
| 36 | `window.__tribesSyncPBRChips` | renderer.js | index.html (7 refs) | API Facade | ES module export |
| 37 | `window.__tribesPolish` | renderer.js | debug (7 refs) | Debug | Keep (debug handle) |
| 38 | `window.__tribesPlayerRatings` | client/tiers.js | renderer.js (7 refs) | Shared Data | ES module export |
| 39 | `window.__tribesApplyQuality` | renderer.js | index.html, polish (7 refs) | API Facade | ES module export |
| 40 | `window.__moderation` | client/moderation.js | index.html (7 refs) | API Facade | ES module export |
| 41 | `window.Minimap` | renderer_minimap.js | renderer.js (7 refs) | API Facade | ES module export |
| 42 | `window.updateSpawnProt` | index.html | index.html (6 refs) | Shared Data | Module-scope |
| 43 | `window.renderScoreboard` | index.html | index.html (6 refs) | Shared Data | Module-scope function |
| 44 | `window._tribesCamHeight` | renderer.js | renderer.js (6 refs) | Shared Data | **Module-scope let** |
| 45 | `window.__tribesPlayerUuids` | index.html | client/network.js (6 refs) | Shared Data | ES module export |
| 46 | `window.__lastRatingShown` | index.html | index.html (6 refs) | Shared Data | Module-scope |
| 47 | `window.__generatorPositions` | renderer.js | client/audio.js (6 refs) | Shared Data | ES module export |
| 48 | `window.CommandMap` | renderer_command_map.js | renderer.js (6 refs) | API Facade | ES module export |
| 49 | `window.__voiceSetMuteAll` | client/network.js | index.html (5 refs) | API Facade | Voice ES module |
| 50 | `window.__voiceRegisterUuid` | client/network.js | index.html (5 refs) | API Facade | Voice ES module |
| 51 | `window.__tribesLoadMap` | renderer.js | index.html (5 refs) | API Facade | ES module export |
| 52 | `window.__teamColors` | index.html (settings) | renderer.js (5 refs) | Shared Data | ES module export |
| 53 | `window.ZoomFX` | renderer_zoom.js | renderer.js (5 refs) | API Facade | ES module export |
| 54 | `window.DayNight` | renderer.js | index.html, sky (5 refs) | API Facade | ES module export |
| 55 | `window.showDamageArc` | index.html | index.html (4 refs) | Shared Data | Module-scope |
| 56 | `window.addKillMsg` | index.html | client/network.js (4 refs) | API Facade | Event emitter |
| 57 | `window._tribesDebug` | renderer.js | index.html (4 refs) | Debug | Keep (debug) |
| 58 | `window.__tribesShowReconnect` | index.html | client/network.js (4 refs) | API Facade | Event emitter |
| 59 | `window.__tribesSetGameClock` | index.html | renderer.js (4 refs) | API Facade | ES module export |
| 60 | `window.__tribesReconcile` | index.html | client/network.js (4 refs) | API Facade | ES module export |
| 61 | `window.__tribesOnMessage` | index.html | client/network.js (4 refs) | API Facade | Event emitter |
| 62 | `window.__tribesOnMatchStart` | index.html | client/network.js (4 refs) | API Facade | Event emitter |
| 63 | `window.__tribesOnMatchEnd` | index.html | client/network.js (4 refs) | API Facade | Event emitter |
| 64 | `window.__tribesHideReconnect` | index.html | client/network.js (4 refs) | API Facade | Event emitter |
| 65 | `window.__tribesActiveMapId` | index.html | index.html (4 refs) | Shared Data | Module-scope |
| 66 | `window.__nightAmbient` | renderer.js | renderer.js DayNight (4 refs) | Shared Data | **Module-scope let** |
| 67 | `window.__lastMapId` | index.html | index.html (4 refs) | Shared Data | Module-scope |
| 68 | `window._weaponMuzzleAnchor` | renderer.js | renderer_combat_fx.js (3 refs) | Shared Data | ES module export |
| 69 | `window.__voiceUpdatePeer` | client/network.js | renderer.js (3 refs) | API Facade | Voice ES module |
| 70 | `window.__voiceIsPeerMuted` | client/network.js | index.html (3 refs) | API Facade | Voice ES module |
| 71 | `window.__camX/Y/Z` | renderer.js | client/audio.js (3 refs each) | Shared Data | ES module export |
| 72 | `window.PALETTE` | renderer_palette.js | index.html (3 refs) | API Facade | ES module export |
| 73 | `window._sampleTerrainH` | renderer.js | renderer_characters.js (2 refs) | API Facade | ES module export |
| 74 | `window._rapierGrounded` | renderer.js | renderer_characters.js (2 refs) | Shared Data | Pass as param to Characters.sync |
| 75 | `window.__qualityTier` | index.html | renderer.js (2 refs) | Shared Data | ES module export |
| 76 | `window.__tribesApplyDelta` | index.html | client/network.js (2 refs) | API Facade | ES module export |
| 77 | `window.openMapEditor` | client/mapeditor.js | index.html (1 ref) | API Facade | ES module export |
| 78 | `window.registerModelCollision` | renderer.js | renderer.js (1 ref) | API Facade | **Module-scope (self-reference)** |
| 79 | `window.scene/camera/renderer` | renderer.js | debug console (1 ref each) | Debug | Keep (debug) |
| 80 | `window.PaletteUtils` | renderer_palette.js | index.html (1 ref) | API Facade | ES module export |
| 81 | `window.__tribesBloom/Composer` | renderer.js | debug (1 ref each) | Debug | Keep (debug) |
| 82 | `window._r327PrevCarry` | renderer_polish.js | renderer_polish.js (1 ref) | Shared Data | **Module-scope let** |
| 83 | `window._flagStingMuted` | renderer_polish.js | renderer_polish.js (1 ref) | Shared Data | **Module-scope let** |

### Summary by Category

| Category | Count | Migration Effort |
|----------|-------|-----------------|
| **API Facade** (module public interface) | 38 | Convert to ES module exports |
| **WASM Bridge** (Emscripten callbacks) | 12 | Keep (required by generated code) |
| **Shared Data** (mutable state on window) | 20 | Convert to module-scope or ES exports |
| **Debug** (console access, dev tools) | 8 | Keep (harmless) |
| **Config** (server URL, quality) | 3 | ES module constants |
| **Dead** (Cohesion — module flagged for kill) | 1 | Delete |
| **Self-reference** (window.registerModelCollision) | 1 | Module-scope function |
| **TOTAL** | **83 distinct window.* globals** | |

### Orphaned Globals (written but never read, or vice versa)

| Global | Issue |
|--------|-------|
| `window._r327PrevCarry` | Written and read only within renderer_polish.js — should be module-scope `let` |
| `window._flagStingMuted` | Written and read only within renderer_polish.js — should be module-scope `let` |
| `window.registerModelCollision` | renderer.js writes it and reads it from itself — pure self-reference through window |
| `window.__nightAmbient` | renderer.js writes it, renderer.js DayNight reads it — internal communication via window |
| `window._tribesCamDist/Height` | renderer.js writes and reads — camera state leaked to window for no external consumer |
| `window.Cohesion` | Written by renderer_cohesion.js, read by renderer.js — but module marked for kill (dead tick()) |

**Total orphaned/self-referencing: 8 globals that serve no cross-module purpose.**

---

## 3. Dead Code Inventory

### renderer.js (~1,050 lines dead/disabled)

| System | Lines | Status | Evidence |
|--------|-------|--------|----------|
| Rain system | 3341-3440 (~100) | Disabled | `initRain()` never called (L190 comment); `updateRain()` has `if (!_rainSystem) return` early-bail |
| Grass ring | 5510-5800 (~290) | Disabled | `?ring=off` default; L5534 "disabled via ?ring=off"; 2.8M instance allocator |
| Dust layer | 5830-6094 (~265) | Disabled | L5833 `return;` as first statement of `initDustLayer()` |
| Jet exhaust particles | 4449-4506 (~60) | Disabled | L183 comment "disabled"; loop call commented out L5317 |
| Terrain carve | 1147-1212 (~65) | Disabled | L171 comment "carve disabled — reverted per user request" |
| Ground fairies | portion of night fairies | Disabled | L5824 "ground fairies disabled" |
| Wind functions | ~30 lines | Dead | L229 "Wind functions... no longer called" |
| `createPlayerMesh()` primitive | ~200 lines | Partially dead | Creates capsule meshes but L3777 hides ALL non-local (redundant with Characters.js) |

### renderer_characters.js (~80 lines dead)

| System | Lines | Status |
|--------|-------|--------|
| `_modelScale` | 1 line | Never read |
| `_demo`/`_spawnDemo`/`_updateDemo` | ~70 lines | Never called from sync() |
| `flameL`/`flameR`/`skiBoard` null init | ~3 lines | Vestigial |

### renderer_polish.js (~90 lines dead)

| System | Lines | Status |
|--------|-------|--------|
| `_playFlagSting()` | ~34 lines | Has `return;` as first statement |
| Rain splash code | ~55 lines | Commented out of init/tick paths |
| Dead wear & tear / subdivision stubs | ~5 lines | No-op |

### renderer_cohesion.js (~138 lines — entire module)

| Status | Evidence |
|--------|----------|
| **KILL** | `tick()` contains only a mood bed (audio-related), which Phase 4 flagged should move to audio.js. The rest is dead. |

### client/prediction.js (~50 lines dead)

| System | Status |
|--------|--------|
| `inputHistory` recording | Data recorded but NEVER replayed — dead accumulation |

### **TOTAL DEAD CODE: ~1,400+ lines across the codebase**

---

## 4. Cross-Module Contradiction Check

### 4.1 Coordinate Space Contradictions

| Module | Space | Issue |
|--------|-------|-------|
| renderer.js (terrain) | World meters, Y-up, origin-centered | ✅ Consistent |
| renderer.js (MIS import) | `x = mis_x, y = mis_z, z = -mis_y` | ✅ Documented in patterns.md |
| renderer_rapier.js | World meters, Y-up | ✅ Consistent |
| renderer_characters.js | World meters, Y-up | ✅ Consistent |
| renderer_polish.js telemetry | Reads `o+4,5,6` as velocity | ❌ **WRONG** — o+4 is yaw, not vx |
| client/wire.js flag decode | Drops Z component, hardcodes to 0 | ❌ **FLAG Z LOST** — breaks CTF on 3D terrain |

### 4.2 Team Count Contradictions

| Module | Assumption | Lines |
|--------|-----------|-------|
| Game design doc | 4 tribes × 16 = 64 players | — |
| renderer.js | `TEAM_COLORS[3]`, `flagMeshes[2]`, `MAX_PLAYERS=16` | L59-63, L3096, L3009 |
| renderer_minimap.js | `TEAM_COLORS[2]`, `FLAG_COLORS[2]`, `i < 2` flag loop | All hardcoded |
| renderer_command_map.js | `teamColors[3]`, `i < 2` flag loop | All hardcoded |
| renderer_palette.js | `teamRed`/`teamBlue` only, binary switch | L21-24, L77-80 |
| renderer_polish.js | `inferno`/`storm` (2 factions) | L833-845 |
| renderer_combat_fx.js | Single tracer color for all teams | Constant 0xffd070 |
| client/mapeditor.js | `flags[2]`, `spawns[2]`, `team === 0 ? red : blue` | L96, L102 |
| client/replay.js | Binary team color, `teamScore[2]` | L112, L123 |
| client/wire.js | `teamScore[2]`, `flags[2]` in binary format | L47 |
| index.html | `team === 0 ? red : (team === 1 ? blue : neutral)` | L2162 |
| shell.html | Same ternary pattern | L1909 |
| renderer.js canonical | `['team0', 'team1'].forEach(...)` | L1358, L2720 |

**Files with 2-team hardcoding: 12 out of ~20 hand-written files (60%)**

### 4.3 Player State Stride Offset Contradictions

| Module | Offset Usage | Issue |
|--------|-------------|-------|
| renderer.js syncPlayers | o+0(x), o+1(y), o+2(z), o+3(pitch), o+4(yaw), o+6(vx), o+8(vz), o+11(team), o+12(armor), o+13(alive), o+14(jetting), o+15(skiing), o+18(visible), o+20(spawnProt) | Canonical — matches WASM |
| renderer_characters.js | o+0,1,2(pos), o+4(yaw), o+6(vx), o+8(vz), o+13(alive), o+14(jetting), o+15(skiing), o+18(visible) | ✅ Matches renderer.js |
| renderer_rapier.js | o+0,1,2(pos), o+6,7,8(vel) | ✅ Matches |
| renderer_polish.js telemetry | o+4(vx!), o+5(vy!), o+6(vz!) | ❌ **WRONG** — should be o+6, o+7, o+8 |
| client/wire.js | Defines its own layout (unrelated to WASM stride) | ⚠️ Independent — but must stay in sync with server |

**No shared constants file exists.** Every module independently hardcodes magic offsets.

### 4.4 Init/Dispose Lifecycle Contradictions

| Module | Has init() | Has dispose/destroy() | Has cleanup on disconnect |
|--------|-----------|----------------------|--------------------------|
| renderer.js | ✅ start() | ❌ | ❌ |
| renderer_rapier.js | ✅ initRapierPhysics() | ❌ | ❌ |
| renderer_buildings.js | ✅ init() | ✅ dispose() | ✅ |
| renderer_characters.js | ✅ init() | ❌ | ❌ (zombie models) |
| renderer_polish.js | ✅ installPolish() | ❌ (DOM elements, listeners leak) | ❌ |
| renderer_combat_fx.js | ✅ init() | ❌ | ❌ |
| renderer_minimap.js | ✅ init() | ❌ (canvas leaks) | ❌ |
| renderer_command_map.js | ✅ init() | ❌ (canvas + RAF loop leaks) | ❌ |
| renderer_sky_custom.js | ✅ initCustomSky() | ✅ removeOldSky() | ✅ |
| client/network.js | ✅ start() | ❌ (WebSocket + intervals leak) | ❌ |

**Only 2 of 10 major modules have proper cleanup.** `renderer_buildings.js` (the module we built and audited first) is the gold standard. Everything else leaks.

### 4.5 RAF Ownership Contradictions

| Module | RAF Usage | Issue |
|--------|----------|-------|
| renderer.js | Main `loop()` via `requestAnimationFrame` | ✅ Canonical — ONE loop |
| renderer_command_map.js | `_startSelfLoop()` — own RAF | ❌ Rogue loop, not synced with game clock |
| renderer_zoom.js | `_boot()` — own RAF | ❌ Rogue loop |
| renderer_polish.js shockwave | Per-shockwave RAF chain | ❌ Ephemeral rogue loops |

**3 modules run their own animation loops** independent of the main render loop. This causes:
- Timing desync (they use `performance.now()`, not game clock `t`)
- Tab-background behavior differs (RAF pauses, their timers don't match)
- No central frame budget accounting

---

## 5. Two-Team Hardcoding Master List

### Complete File-by-File Inventory

| File | Line(s) | Hardcoded Element | Fix Required |
|------|---------|-------------------|-------------|
| **renderer.js** | L59-63 | `TEAM_COLORS = [0xCC4444, 0x4488CC, 0xCCAA44]` (3 entries) | Expand to 4: add Phoenix gold, Starwolf green |
| **renderer.js** | L3096-3121 | `flagMeshes` creates exactly 2 flags | Dynamic based on team count |
| **renderer.js** | L3009 | `MAX_PLAYERS = 16` | Change to 64 |
| **renderer.js** | L253 | `canon.team === 0 ? 0xCC4444 : 0x4488CC` | Use TEAM_COLORS[canon.team] |
| **renderer.js** | L1358 | `['team0', 'team1'].forEach(...)` for terrain splat | Dynamic team list |
| **renderer.js** | L2308-2309 | `canon.team0?.static_shapes`, `canon.team1?.static_shapes` | Iterate all teams |
| **renderer.js** | L2720 | `['team0', 'team1'].forEach(...)` for vehicle pads | Dynamic team list |
| **renderer.js** | L3013 | `team === 0 ? '#FFCDCD' : team === 1 ? '#CDD8FF' : '#E8DCB8'` | Array lookup |
| **renderer.js** | L3847 | `team === 0 ? cbColors.red : cbColors.blue` | Array lookup |
| **renderer.js** | L4311, L4341 | `canon.team === 1 ? Math.PI : 0` (generator pulse phase) | Phase per team index |
| **renderer_minimap.js** | multiple | `TEAM_COLORS[2]`, `FLAG_COLORS[2]`, flag loop `i < 2` | Expand arrays, dynamic count |
| **renderer_command_map.js** | multiple | `teamColors[3]`, flag loop `i < 2` | Expand, dynamic count |
| **renderer_palette.js** | L21-24 | `teamRed`/`teamBlue` only | Add teamGold/teamGreen |
| **renderer_palette.js** | L77-80 | `teamIdx === 1 ? blue : red` binary | Switch on index 0-3 |
| **renderer_polish.js** | L833-845 | `inferno`/`storm` faction palettes (2) | Add 4 tribe palettes |
| **renderer_combat_fx.js** | constant | Single tracer color `0xffd070` | Per-tribe tracer color |
| **client/mapeditor.js** | L96, L102 | `f.team === 0 ? red : blue`, `s.team === 0 ? red : blue` | Array lookup |
| **client/mapeditor.js** | UI | flags[2], spawns[2] in map format | Expand to 4 |
| **client/replay.js** | L112, L123 | `f.team === 0 ? red : blue`, `p.team === 0 ? red : blue` | Array lookup |
| **client/wire.js** | L47 | `teamScore[2]` in binary format | Expand to `teamScore[4]` |
| **client/wire.js** | decode | `flags[2]` in decode | Expand to `flags[4]` |
| **index.html** | L2162 | `msg.team === 0 ? red : (team === 1 ? blue : neutral)` | Array lookup |
| **shell.html** | L1909 | Same ternary as index.html | Array lookup |

**Total: 12 files, ~28 individual hardcoded locations**

### Migration Strategy

1. **Create `TEAM_CONFIG` constant module** (`client/teams.js`):
```javascript
export const TEAMS = [
  { name: 'Blood Eagle', color: '#CC4444', colorInt: 0xCC4444, accent: '#FFCDCD' },
  { name: 'Diamond Sword', color: '#4488CC', colorInt: 0x4488CC, accent: '#CDD8FF' },
  { name: 'Phoenix', color: '#CCAA44', colorInt: 0xCCAA44, accent: '#FFE8B8' },
  { name: 'Starwolf', color: '#44AA44', colorInt: 0x44AA44, accent: '#C8FFC8' },
];
export const TEAM_COUNT = TEAMS.length;
export const MAX_PLAYERS = TEAM_COUNT * 16; // 64
```

2. **Replace all binary ternaries** with `TEAMS[teamIdx].color`
3. **Replace all hardcoded flag/score arrays** with dynamic-length arrays
4. **Add `_getTeamCount` WASM export** so C++ drives the team count
5. **Update wire format** to support 4 team scores, 4 flags

---

## 6. Expert Panel Integration Dialogue

### Carmack Opens

**Carmack:** "After reviewing all 5 phases, three issues dominate everything else. First: 83 window globals is untenable. The codebase communicates through a shared global mutable namespace with zero documentation — it's the JavaScript equivalent of a shared-memory dump with no mutex and no struct definition. Second: 12 of 20 files hardcode 2 teams. The game design says 4 tribes. That's 60% of the codebase contradicting the north star. Third: only 2 of 10 major modules have dispose/cleanup. This means map transitions, phase transitions, session restarts — anything that requires rebuilding state — will leak."

### ryg on Draw Calls

**ryg:** "The frame trace shows ~680+ draw calls per frame. The three biggest waste sources are: (1) 256 individual projectile meshes, (2) per-building unique materials preventing batching, and (3) all characters rendered regardless of frustum visibility. But the most insidious issue is the three rogue RAF loops — CommandMap, ZoomFX, and shockwave each run independent animation frames. That's not a performance problem (they're cheap), it's an architecture problem: you can't profile frame budget when 3 systems are operating outside your accounting."

### Abrash on Memory

**Abrash:** "The ~1,400 lines of dead code aren't just maintenance noise — they're 170MB of potential allocation. The grass ring alone is 213MB if someone removes the guard. The dust layer is 64K-256K vertex positions being CPU-lerped every frame — but the `return;` at line 5833 short-circuits it, so the init code never runs. The danger is that someone removes that `return` without understanding the allocation cost below it. Dead code with live allocation paths is a memory bomb with the pin half-pulled."

### Muratori on Architecture

**Muratori:** "I want to emphasize one finding that's more important than any individual bug: the codebase has no lifecycle management. Things get created and never destroyed. Colliders, DOM elements, event listeners, canvas elements, WebSocket connections, setInterval timers, animation mixers — all of these are fire-and-forget. `renderer_buildings.js` is the ONLY module that proves this project can do cleanup correctly. It should be the template for everything else."

### Acton on Data

**Acton:** "The player state stride layout is duplicated across 4 files with magic numbers. One C++ struct reorder silently breaks rendering, physics, characters, and telemetry. The telemetry is ALREADY reading the wrong offsets (yaw as velocity) and nobody noticed because it's hidden behind F3. A shared `player_layout.js` constants file is a 30-minute fix that eliminates an entire class of silent bugs."

### Barrett on the Bridge

**Barrett:** "Phase 2 revealed that index.html is ~4,500 lines of hand-written game bridge that was never audited. It defines 12+ WASM callback globals, manages the entire HUD, runs settings/loadout UI, handles chat, scoreboard, and multiplayer flow. This is arguably the most important file in the project and we haven't reviewed it. I'm marking this as a gap that must be addressed in Run 2 or in a supplementary phase."

### Ive on Design Coherence

**Ive:** "Across all modules, I see a project that serves **Scale** and **Aliveness** well (the terrain + DayNight + fairies triad is strong) but underserves **Belonging** and **Adaptation**. Belonging requires visual tribe identity — and 60% of the codebase says there are only 2 teams. Adaptation requires the phase system — and zero modules have phase hooks. The code doesn't yet support the game it wants to be."

### Panel Consensus: Top 10 Integration Issues

| # | Issue | Severity | Scope | Fix Effort |
|---|-------|----------|-------|-----------|
| 1 | **83 window.* globals** — no module boundaries, undocumented contracts | CRITICAL | System-wide | Large (ES module migration) |
| 2 | **2-team hardcoding in 12/20 files** — blocks 4-tribe game design | CRITICAL | System-wide | Medium (2-3 sessions) |
| 3 | **No shared player state stride constants** — magic numbers in 4 files | HIGH | Cross-module | Small (30 min) |
| 4 | **Only 2/10 modules have dispose()** — blocks map/phase transitions | HIGH | Per-module | Medium (1 per module) |
| 5 | **~1,400 lines dead code** — maintenance burden, hidden allocation risk | HIGH | System-wide | Small (delete pass) |
| 6 | **3 rogue RAF loops** — timing desync, unaccounted frame budget | MEDIUM | 3 modules | Small (move to main loop) |
| 7 | **Telemetry reads wrong stride offsets** — o+4,5,6 vs o+6,7,8 | MEDIUM | renderer_polish.js | Small (5 min fix) |
| 8 | **renderer_cohesion.js should be killed** — dead module | MEDIUM | 1 module | Small (delete + remove refs) |
| 9 | **index.html (~4,500 LOC) unaudited** — game bridge logic never reviewed | MEDIUM | Gap | Large (add to Run 2) |
| 10 | **Flag Z lost in wire.js decode** — CTF broken on 3D terrain | MEDIUM | client/wire.js | Small (fix decode) |

---

## 7. Completeness Verification

### lessons-learned.md Status

Current entries: 5 (R32.130 through R32.140)

**Missing entries from audit findings:**

| # | Should Be Added | Source |
|---|----------------|--------|
| 6 | Night ambient color typo (0x3040608 → 0x304060) — hex literal with wrong digit count | Phase 1, W4 |
| 7 | HDRI/DayNight exposure race — async callback overwrites DayNight values | Phase 1, W1 |
| 8 | Remote players always hidden (L3777) — test hack shipped | Phase 1, C1 |
| 9 | tribes.js is Emscripten glue, not game logic — real bridge is index.html | Phase 2a |
| 10 | Rapier dual-physics desync — WASM and Rapier fight over position | Phase 2b, C-1 |
| 11 | Telemetry reads yaw as velocity (wrong stride offsets) | Phase 3b, W-1 |
| 12 | renderer_polish.js "addBridgeRailings" references undefined `scene` | Phase 3b, S-? |
| 13 | Flag Z dropped in wire.js decode — hardcoded to 0 | Phase 3c |
| 14 | client/network.js `start()` not idempotent — double-call ghost WebSocket | Phase 3c |
| 15 | Ping calculation is clock offset, not RTT | Phase 3c |

### system-map.md Status

- ✅ Module dependency graph present
- ✅ window.* globals from renderer.js documented
- ✅ WASM interface documented
- ✅ Player state stride layout documented
- ✅ Phase 2 additions (tribes.js, rapier) documented
- ✅ Phase 3 additions (characters, polish, networking) documented
- ✅ Phase 4 additions (T3+T4 modules) documented
- ⚠️ **Missing:** index.html globals (it defines 12+ WASM callbacks + ~30 other globals)
- ⚠️ **Missing:** Full writer/reader mapping for ALL 83 globals (partial in this Phase 5 doc)

### patterns.md Status

- ✅ 17 patterns documented with line-number references
- ✅ Covers: GPU particles, terrain sampling, building classification, interior loading, DayNight lerp, crease normals, error-resilient init, projectile sync, spectator camera, shadow snapping, skeleton clone, safe-init, wire protocol, smooth correction, canvas tactical, procedural sky, legacy IIFE
- ⚠️ **Missing pattern:** Weapon viewmodel (210 lines of procedural geometry — should be documented even if slated for GLB replacement)
- ⚠️ **Missing pattern:** DOM HUD overlay (the #r327-* pattern used by polish.js)
- ⚠️ **Missing pattern:** WASM callback bridge (the ASM_CONST → window.* pattern)

---

## Deliverable Summary

This Phase 5 Integration Audit has produced:
1. **Complete end-to-end frame trace** — 32 steps across 10+ modules, every global read/write mapped
2. **Master window.* global inventory** — 83 globals categorized (38 API Facade, 12 WASM Bridge, 20 Shared Data, 8 Debug, 3 Config, 1 Dead, 1 Self-ref)
3. **Dead code inventory** — ~1,400+ lines across 6 files
4. **Cross-module contradiction report** — coordinate spaces, team counts, stride offsets, lifecycle, RAF ownership
5. **2-team hardcoding master list** — 12 files, 28 locations, with migration strategy
6. **Expert panel integration dialogue** — Top 10 systemic issues ranked
7. **Completeness gaps** — 15 missing lessons-learned entries, 3 missing patterns, index.html gap

**Cumulative Run 1 stats:**
- Phases completed: 5 of 6
- Modules reviewed: 18+ (all JS modules)
- Expert dialogue captured: ~5,000+ lines
- Findings: 70+ across all phases
- Deliverable files: system-map.md, patterns.md, 7 audit log files
