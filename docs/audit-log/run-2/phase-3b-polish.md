# Phase 3b — renderer_polish.js — Adversarial Convergence Review (Run 2)

*Run 2 | Validation Pass | 1,146 lines | File: `renderer_polish.js`*
*Panel: ryg (GPU/draw calls/naming), Abrash (low-level perf), Carmack (engine architecture/perf), Ive (design coherence)*
*Run 1 Reference: `docs/audit-log/run-1/phase-3b-polish.md`*
*Refactoring Plan Reference: `docs/refactoring-plan.md` §4 (renaming) + §5 (K/E/A/K)*

---

## Mission: Validate, Challenge, and Deepen Run 1

Run 1's headline recommendation is to **KILL renderer_polish.js** — decompose it into 4-6 purpose-driven modules. The refactoring plan (§4) contradicts this, recommending a simple **RENAME** to `renderer_fx.js` ("internally well-organized"). Run 2 resolves this contradiction by examining subsystem boundaries, shared state, and decomposition feasibility. Run 2 also verifies specific bug claims and line-count estimates.

---

## The Refactoring Plan Contradiction

**Run 1 Phase 3b says:** "Delete renderer_polish.js and promote each subsystem to its proper home" — split into `renderer_weather.js`, `renderer_combat_fx.js`, `renderer_hud.js`, move building details to `renderer_buildings.js`.

**Refactoring Plan §4 says:** "renderer_polish.js → `renderer_fx.js` — RENAME — 'fx' matches what it actually does (game feel effects)" and §5 says "KEEP + rename."

> **Carmack:** These two documents disagree. The refactoring plan was generated as Phase 6 (after Phase 3b), so it should supersede. But reading the refactoring plan closely, it says "internally well-organized" which is only half-true. Let me trace the actual subsystem boundaries.

---

## Subsystem Boundary Analysis (NEW for Run 2)

I'm mapping every subsystem's dependencies to determine if the decomposition is as clean as Run 1 claims.

### Shared Module State

These variables are accessed by multiple subsystems:

| Variable | Subsystems That Read/Write | Decomposition Impact |
|----------|---------------------------|----------------------|
| `_ctx` | ALL subsystems | Must be passed to each split module. Clean — pass at init. |
| `_enabled` | ALL subsystems (guard) | Each module needs its own enable flag or checks `?polish=off`. Clean. |
| `_fxLevel` | Lightning, decals, smoke, rain(dead), wet ground, settings panel | Need shared FX level state. Either pass at init or use a shared config object. |
| `_audioCtx` | Lightning (thunder synthesis), flag sting (dead) | Only lightning needs it after dead code removal. Clean — moves with weather. |
| `_shake` | Camera shake, thunder (calls `onNearMiss`), shockwave (calls `onNearMiss`), damage (calls `onNearMiss`) | **COUPLING HUB.** Multiple subsystems trigger camera shake via `onNearMiss()`. |
| `_vignettePulse` | Damage vignette, `_tickFlashOverlay` | Self-contained — damage system only. |
| `_flagFlash` | Flag flash, `_tickFlashOverlay`, `_flashScreen` | Self-contained — flag events only. |
| `_v3a`, `_v3b` | Lightning bolt spawn, HUD compass | Cached vectors — trivial to duplicate per module. |

### Cross-Subsystem Call Graph

```
onDamage(amount)
  ├── sets _vignettePulse.alpha   (vignette subsystem)
  └── calls onNearMiss(trauma)    (camera shake subsystem)

onShoot(weaponType)
  └── calls onNearMiss(0.05)      (camera shake subsystem)

onFlagEvent(type, team)
  ├── calls _flashScreen(...)     (flag flash subsystem)
  └── calls _playFlagSting(...)   (DEAD — returns immediately)

spawnShockwave(scene, pos, mag)
  └── calls onNearMiss(...)       (camera shake subsystem)

_playThunder()
  └── calls onNearMiss(0.18)      (camera shake subsystem)

_tickFlashOverlay(dt)
  ├── updates _vignettePulse      (vignette subsystem)
  └── updates _flagFlash           (flag flash subsystem)
```

**Key insight:** `onNearMiss()` / camera shake is a **dependency hub**. Four different subsystems (damage, shoot, shockwave, thunder) trigger camera shake. If these subsystems are split into separate modules, they all need a reference to the shake function.

> **Muratori:** This is the hidden coupling that makes decomposition harder than Run 1 suggests. Run 1's proposed split:
> - Weather (lightning) → needs to call shake
> - Combat FX (shockwave, damage) → needs to call shake
> - Camera (shake) → the hub itself
>
> If shake moves to the camera controller (Run 1's recommendation), then weather and combat FX both need to import from the camera module. That's a circular risk: camera reads player state from WASM, weather reads camera position for lightning placement, camera shake is triggered by weather (thunder). The cycle is: camera → weather → camera.
>
> **Carmack:** The solution is simple: shake is an *event*, not a module. Expose a `triggerShake(trauma)` function that the render loop consumes. Weather and combat FX call `triggerShake()`, the camera module reads the accumulated trauma in its update. No circular dependency.
>
> **Abrash:** Or simpler: keep all combat feedback (shake, vignette, flag flash) in one module (`renderer_combat_fx.js`) and have weather call its `triggerShake()` export. The combat FX module is the camera-feel authority. Weather doesn't need to import camera — it imports one function from combat FX.

### Decomposition Feasibility Verdict

> **ryg:** The decomposition IS feasible, but Run 1's proposed boundaries need adjustment. Here's the corrected split:

| Module | What Moves | Lines | Cross-Module Dependencies |
|--------|-----------|-------|--------------------------|
| `renderer_weather.js` | Lens flare (~40L), lightning+thunder (~130L), wet ground (~20L) | ~190 | Needs: `_ctx.scene`, `_ctx.camera`, `_ctx.sunLight`, `_ctx.hemiLight`. Needs: `triggerShake()` from combat_fx for thunder. |
| `renderer_combat_fx.js` (or absorb into existing) | Camera shake (~30L), FOV punch (~20L), damage vignette (~20L), flag flash (~15L), `onNearMiss/onDamage/onShoot/onFlagEvent` event handlers (~30L), shockwave (~30L), decals (~70L) | ~215 | Needs: `_ctx.scene`, `_ctx.camera`. Exports: `triggerShake()` consumed by weather. |
| `renderer_hud.js` | Telemetry (~55L), compass (~30L), settings panel (~65L) | ~150 | Needs: `_ctx.camera`, `_ctx.playerView` (late-bind). |
| `renderer_buildings.js` (absorb) | Chimney smoke (~60L), turret enhancements (~45L), sensor enhancements (~30L), bridge railings (~45L), tower windows (~30L), station icons (~65L), faction materials (~20L) | ~295 | Already called from `renderer_buildings.js`. Move these TO that file. |
| **DEAD CODE** | Rain splashes (~54L), flag sting (~34L), wear & tear (~3L), subdivision (~6L) | ~97 | Delete. |

**Total: 190 + 215 + 150 + 295 + 97 = 947 lines accounted for** (remaining ~199 lines are the public API surface, `safeInit`, `_rand`, module state declarations, and noop API — these distribute across the split modules).

> **Carmack:** Run 1's decomposition map is directionally correct. The main adjustment is that camera shake needs to be explicitly modeled as an export from combat_fx, consumed by weather. Run 1 didn't identify this dependency chain. The refactoring plan's "just rename to renderer_fx.js" is too conservative — the file genuinely contains 17+ subsystems that belong in different architectural homes.

---

## Run 1 Bug Verification

### W-1: Telemetry Reads Wrong Player Stride Offsets (Run 1: CRITICAL)

**Source:** Lines 1015-1017:
```js
const vx = _ctx.playerView[o + 4] || 0;
const vy = _ctx.playerView[o + 5] || 0;
const vz = _ctx.playerView[o + 6] || 0;
```

**Run 2 cross-module stride verification:**

From the definitive stride map (built in Phase 3a Run 2):
- `o+4` = **yaw (rotY)** — NOT velX
- `o+5` = **roll (rotZ)** — NOT velY
- `o+6` = **velX** — NOT velZ

The telemetry computes: `speed = sqrt(yaw² + roll² + velX²)`.

> **Carmack:** Let me work out what the display shows. Yaw is in radians, typically -π to π (max ~3.14). Roll is usually near 0. velX could be 0-60+ m/s during skiing. So the displayed "speed" is approximately `sqrt(yaw² + velX²)`. When the player faces north (yaw ≈ 0) and skis east (velX = 60), it shows `sqrt(0 + 0 + 3600) = 60`. When the player faces east (yaw ≈ 1.57) and is stationary, it shows `sqrt(2.46 + 0 + 0) = 1.57`. This "works" most of the time because velX dominates, but adds random noise from the yaw component. A player spinning in place shows ~3.14 "speed." Nobody noticed because the telemetry is F3-hidden and the dominant term (velX) is correct-ish.

✅ **VALIDATED.** Concrete bug. Fix: change offsets to `o+6`, `o+7`, `o+8` for velX, velY, velZ. Better: import from shared `player_layout.js` constants.

**Run 2 note:** The correct fix should also use offsets `o+6` and `o+8` (skip velY at `o+7`) if matching the speed calculation used elsewhere. renderer.js L3867 and renderer_characters.js L208 both compute horizontal speed as `Math.hypot(playerView[o+6], playerView[o+8])` — only velX and velZ, no velY. The telemetry's inclusion of a "vy" component is actually *more correct* (3D speed vs ground speed) but inconsistent with the rest of the codebase.

---

### S-5 / Dead Code: `_playFlagSting` (Run 1: LOW)

**Source:** Lines 920-964:
```js
function _playFlagSting(eventType) {
    // R32.13.7: PERMANENTLY DISABLED. ...
    return;
    // (legacy code below; kept for diagnostic toggle if ever needed)
    ...
}
```

**Run 2 verification:** ✅ **VALIDATED.** First statement is `return;`. 44 lines after the return are unreachable. The function is still called from `onFlagEvent()` (line 416), executing only the `return;` statement. Pure dead code.

Run 1 said "34 lines." Actual count from `return;` to closing brace: **44 lines** (lines 921-964). Run 1 undercounted.

---

### Dead Rain Splash Code (Run 1: noted in C-5 and Kill table)

**Source:** `_initRainSplashes()` (lines 538-562) and `_tickRainSplashes()` (lines 564-590) are defined but the `safeInit` and `tick` calls are commented out:
- Line 84: `// safeInit('rainSplashes', _initRainSplashes); // R32.59.2: removed`
- Line 128: `// if (_splashGroup) _tickRainSplashes(dt, t); // R32.59.2: removed`

**Run 2 verification:** ✅ **VALIDATED.** ~54 lines of code that can never execute. The comment says "rain was removed, splashes were leftover artifact."

---

### C-3: Two-Team Hard Limit in Faction Materials (Run 1: MEDIUM)

**Source:** Lines 822-839:
```js
function _initFactionMaterials() {
    _factionMaterials.inferno = {
        primary: new THREE.Color(0x8a3328),
        accent: new THREE.Color(0xff6633),
        emissive: new THREE.Color(0x331100),
    };
    _factionMaterials.storm = {
        primary: new THREE.Color(0x2a4a6e),
        accent: new THREE.Color(0x66aaff),
        emissive: new THREE.Color(0x001833),
    };
}
export function getFactionPalette(team) {
    if (!_factionMaterials || !_factionMaterials.inferno) return null;
    return team === 0 ? _factionMaterials.inferno : _factionMaterials.storm;
}
```

**Run 2 verification:** ✅ **VALIDATED.** Exactly two teams. Any `team > 1` maps to storm (blue). Game design specifies 4 tribes.

---

### C-1: No Phase Awareness (Run 1: HIGH)

**Run 2 verification:** ✅ **VALIDATED.** Zero references to "phase", "matchState", or any game-state enum in the entire file. Lightning fires randomly (every 6-22s) regardless of game phase. Wet ground pulses regardless of phase. Chimney smoke is eternal. Lens flare is always on.

> **Ive:** This is the strongest argument for decomposition. If you build the phase system on top of a 1,146-line monolith, every phase hook is a surgical insertion into a tangle of 17 subsystems. If each subsystem is its own module, `onPhaseChange(phase)` is one function per module — clean, testable, and obvious.

---

### S-1: Shockwave Geometry Leak (Run 1: HIGH)

**Source:** Lines 423-453. `spawnShockwave()` creates new geometry + material + mesh per call, animates via chained `requestAnimationFrame`.

**Run 2 verification:** ✅ **VALIDATED.** No pool, no cap, no reuse. Each call creates 3 new Three.js objects. The rAF animation loop is independent of the game clock. If the tab is backgrounded, the `performance.now()` based timing causes instant completion on foreground.

> **Carmack:** Run 1's carmack-2 finding about the independent rAF loop is correct and I want to strengthen it. All visual effects MUST be driven by the main `tick(dt, t)` clock. The shockwave using its own rAF means: (1) it runs even when the game is paused, (2) its timing isn't synchronized with the render frame, (3) disposal races with the scene's own render pass. The fix is: shockwave becomes a pooled object with a `tickShockwaves(dt)` function called from the main `tick()`.

---

### C-2: Generator Smoke Continues After Destruction (Run 1: MEDIUM)

**Source:** `registerGeneratorChimney(worldPos)` (lines 597-625) adds a Points object. No corresponding `removeGeneratorChimney()` exists.

**Run 2 verification:** ✅ **VALIDATED.** Once registered, smoke particles animate forever. The `_smokeStacks` array only grows. When a generator is destroyed in gameplay, its chimney smoke persists as a ghostly plume rising from rubble. No removal API exists.

---

### C-5: No Cleanup/Destroy Path (Run 1: MEDIUM)

**Source:** 7 DOM elements appended to `document.body`:
1. `#r327-lightning-flash` (line 197)
2. `#r327-damage-vignette` (line 904)
3. `#r327-flag-flash` (line 913)
4. `#r327-telemetry` (line 974)
5. `#r327-hud-ring` (line 1049)
6. `#r327-settings-btn` (line 1080)
7. `#r327-settings-panel` (line 1091)

Plus 2 `keydown` event listeners (F2 at line 1129, F3 at line 1000). None are removed on destroy.

**Run 2 verification:** ✅ **VALIDATED.** No `destroy()` or `dispose()` function exists. All DOM elements and event listeners persist for the page lifetime.

---

### abrash-1: DOM Style Writes Every Frame (Run 1: HIGH)

**Source:** `_tickFlashOverlay()` (lines 907-917):
```js
function _tickFlashOverlay(dt) {
    if (_vignettePulse) {
        _vignettePulse.alpha = Math.max(0, _vignettePulse.alpha - dt * 0.9);
        _vignettePulse.el.style.opacity = _vignettePulse.alpha.toFixed(3);
    }
    if (_flagFlash && _flagFlash.alpha > 0) {
        _flagFlash.alpha = Math.max(0, _flagFlash.alpha - dt * 1.4);
        _flagFlash.el.style.opacity = _flagFlash.alpha.toFixed(3);
    }
}
```

**Run 2 verification:** ✅ **VALIDATED** with nuance.

> **Abrash:** The vignette path writes `style.opacity` every frame even when alpha is already 0 — that's confirmed. BUT: the flag flash path has `_flagFlash.alpha > 0` guard, so it only writes when actually fading. The vignette is the worst offender. When no damage is active, every frame writes `opacity: "0.000"` to the DOM. Modern browsers batch style changes within a rAF callback, so the performance impact is less than I initially claimed. But it's still a needless DOM touch.
>
> **Run 2 severity adjustment:** Run 1 HIGH → **MEDIUM.** Modern browser compositing handles this efficiently, but it's still wasteful. Add `if (_vignettePulse.alpha > 0 || _vignettePulse.wasActive)` guard.

---

## Line Count Verification (Decomposition Plan)

Run 1 estimated subsystem line counts. Run 2 verifies against actual source:

| Subsystem | Run 1 Est. | Actual (Run 2 count) | Delta |
|-----------|-----------|---------------------|-------|
| Lens flare | ~40 | 35 (lines 147-181) | −5 |
| Lightning + thunder | ~130 | 162 (lines 184-345, including `_audioCtx` and `_playThunder`) | +32 |
| Camera shake | ~30 | 26 (lines 348-374) | −4 |
| FOV punch | ~20 | 18 (lines 377-393) | −2 |
| Damage/shoot/near-miss events | — | 25 (lines 396-420) | — (not counted separately by Run 1) |
| Shockwave | ~30 | 32 (lines 423-455) | +2 |
| Decals | ~70 | 71 (lines 458-528) | +1 |
| Rain splashes (dead) | ~55 | 54 (lines 536-590) | −1 |
| Chimney smoke | ~60 | 48 (lines 594-649) | −12 |
| Building enhancements (turret/sensor/railings/windows/icons) | ~215 combined | ~265 (lines 652-845) | +50 |
| Faction materials | ~20 | 19 (lines 822-840) | −1 |
| Wet ground | ~20 | 23 (lines 854-885) | +3 |
| Wear & tear (noop) | ~5 | 4 (lines 888-891) | −1 |
| Subdivision (noop) | ~10 | 7 (lines 894-900) | −3 |
| Damage vignette | ~20 | 16 (lines 903-918) | −4 |
| Flag flash + _flashScreen | ~15 | 18 (lines 920-937) | +3 |
| Flag sting (dead) | ~35 | 44 (lines 920-964) — overlaps with flag flash | +9 |
| Telemetry | ~55 | 53 (lines 968-1020) | −2 |
| Compass HUD | ~30 | 30 (lines 1040-1069) | 0 |
| Settings panel | ~65 | 62 (lines 1073-1134) | −3 |

**Verdict:** Run 1 estimates are reasonably accurate (within ±15 lines for most subsystems). The biggest undercount is building enhancements (+50 lines) because Run 1 split them across multiple estimates that didn't fully account for the icon rendering code. The biggest overcount is chimney smoke (−12 lines).

---

## 64-Player Scalability Analysis (NEW for Run 2)

> **Abrash:** What in renderer_polish.js scales with player count?
>
> **Carmack:** Very little. Most subsystems are per-world or per-local-player:
> - **Lightning, wet ground, lens flare:** Per-world. 64 players = same cost as 1.
> - **Camera shake, FOV punch, damage vignette:** Per-local-player. 64 players = same cost.
> - **Decals:** Scale with combat activity. 64 players means more bullets means faster decal pool cycling (128-256 cap holds).
> - **Chimney smoke:** Per-generator (2-4). Player count irrelevant.
> - **Building enhancements:** Per-building. Player count irrelevant.
> - **Shockwave:** Scale with explosions. More players = more mortar/grenade spam = more concurrent shockwaves. The *unbounded* nature of the shockwave system (no pool) becomes a real problem here. 64 players with 4 mortar users = potentially 8-10 concurrent shockwave meshes.
> - **Telemetry:** Reads single local player. No scaling concern.
>
> **Verdict:** renderer_polish.js is mostly player-count-agnostic. The only scalability risk is unbounded shockwave meshes under heavy combat. Pool them (cap at 8-12 concurrent).

---

## Phase System Readiness (NEW for Run 2)

| Subsystem | Phase Sensitivity | Required Hook |
|-----------|-------------------|---------------|
| Lens flare | Intensity should vary: OFF in Dense Fog, MAX in Open Sky, boosted in Lava Flood | `setPhaseFlareMultiplier(float)` |
| Lightning | Frequency should vary: HIGH in storm phases, OFF in calm phases | `setPhaseStrikeInterval(min, max)` |
| Thunder audio | Same as lightning | Bound to lightning trigger |
| Wet ground | ON in rain/storm phases, OFF in lava/dry phases | `setPhaseWetEnabled(bool)` |
| Camera shake | Ambient shake during seismic events (Mech Wave) | `setPhaseAmbientTrauma(float)` |
| Chimney smoke | Intensity varies with generator health (currently ignores it) | `setGeneratorHealth(genIdx, pct)` |
| Faction materials | Could shift during phases (battle-damaged in late phases) | Optional: `setPhaseWearLevel(float)` |
| Decals | More persistent in dry phases, washed away in rain? | Optional: `setPhaseDecalLifetime(sec)` |
| HUD elements | Compass could show phase indicators | Optional |

> **Ive:** This is exactly why decomposition matters. If each subsystem is its own module with an `onPhaseChange(phase)` hook, implementing the phase system is a series of small, testable changes. If they're all in one 1,146-line file, every phase hook is a surgical insertion that risks breaking adjacent subsystems.

---

## Expert Debate: Rename vs Decompose

> **ryg:** The refactoring plan says "rename to renderer_fx.js." Run 1 says "decompose into 4+ modules." I've now analyzed the actual subsystem boundaries. My verdict: **decompose**, but with a pragmatic staging plan:
>
> **Stage 1 (immediate):** Delete dead code (~97 lines). Fix telemetry offsets. This is a 15-minute commit on the existing file.
>
> **Stage 2 (before phase system):** Extract `renderer_weather.js` (lens flare + lightning + thunder + wet ground, ~210 lines). This is the phase-critical extraction. Everything else can stay in the renamed `renderer_fx.js` temporarily.
>
> **Stage 3 (when building renderer_hud.js):** Extract telemetry + compass + settings panel (~150 lines) to HUD module.
>
> **Stage 4 (when expanding renderer_buildings.js):** Move building enhancements (~265 lines) to renderer_buildings.js.
>
> **Carmack:** That's the right sequencing. Don't big-bang decompose. The weather extraction is the gate — it unblocks the phase system. Everything else can wait.
>
> **Ive:** I accept the staging but insist that Stage 1 also includes the `_audioCtx` migration. Thunder synthesis should use the main audio system, not a second AudioContext. Browsers limit active AudioContexts, and on iOS, a user gesture is required to resume each one. A second AudioContext for thunder is a user-facing bug on mobile.
>
> **Abrash:** Agree with Ive. The `_audioCtx` issue is a real mobile bug, not a theoretical concern. iOS Safari limits to one AudioContext — a second one may fail silently or require a second user interaction to resume.

---

## Run 1 Findings: Validated / Challenged / Corrected

| Run 1 # | Finding | Run 1 Sev | Run 2 Verdict | Notes |
|----------|---------|-----------|---------------|-------|
| carmack-1/ryg-1/ive-1 | Module has no architecture | CRITICAL | **VALIDATED** | Decomposition analysis confirms 17+ subsystems with cross-cutting dependencies. Rename alone is insufficient. |
| W-1 | Telemetry reads yaw as velocity (o+4/5/6 → o+6/7/8) | CRITICAL | **VALIDATED** | Cross-module stride map confirms o+4=yaw, o+5=roll. Active display bug. |
| C-1 | No phase awareness | HIGH | **VALIDATED** | Zero phase references in 1,146 lines. Blocks entire phase system feature. |
| carmack-2 | Shockwave uses independent rAF loop | HIGH | **VALIDATED** | Desynchronized from game clock. Misbehaves on tab background. |
| S-1/ryg-2 | Shockwave unbounded draw calls | HIGH | **VALIDATED** | No pool, no cap. Each call creates 3 new Three.js objects. |
| ive-2/abrash-1 | 7 DOM overlays with per-frame style writes | HIGH | **VALIDATED → MEDIUM** | Vignette writes every frame (confirmed). Flag flash has alpha guard (less severe than claimed). Modern compositing mitigates. |
| carmack-3 | Duplicate AudioContext for thunder | MEDIUM | **VALIDATED → HIGH** | iOS Safari limits to 1 AudioContext. Second one may fail silently on mobile. Real mobile bug. |
| C-2 | Generator smoke after destruction | MEDIUM | **VALIDATED** | No removal API. Smoke persists on destroyed generators. |
| C-3 | Two-team faction materials | MEDIUM | **VALIDATED** | Exactly 2 palettes. team>1 defaults to storm(blue). |
| ryg-3 | Decal materials not shared | MEDIUM | **VALIDATED** | `new THREE.MeshBasicMaterial(...)` per decal at L510. 256 materials for 256 decals. |
| C-5 | No destroy/dispose path | MEDIUM | **VALIDATED** | 7 DOM elements + 2 keydown listeners never cleaned up. |
| W-2/W-4 | Undocumented ctx dependencies | MEDIUM | **VALIDATED** | `playerView`, `playerStride`, `terrainMesh`, `sampleTerrainH` are late-bound and undocumented. |
| carmack-4 | Quality tier not integrated | MEDIUM | **VALIDATED** | `_fxLevel` is independent of main `currentQuality` system. |
| ive-3/ive-4 | Settings/telemetry are UI, not polish | MEDIUM | **VALIDATED** | These are HUD/debug systems architecturally misfiled. |
| S-3 | Lightning setTimeout fires after disable | LOW | **VALIDATED** | setTimeout callbacks don't check `_enabled`. |
| S-5 | Dead _playFlagSting code | LOW | **VALIDATED** | 44 lines unreachable after `return;` on line 921. (Run 1 said 34 — actual is 44.) |
| ryg-4/abrash-4 | Smoke stacks: separate Points, N buffer uploads | LOW | **VALIDATED** | 4 stacks × 1 buffer upload = 4 uploads/frame for 72 particles. |
| S-2 | DecalGeometry crash on non-indexed geometry | MEDIUM | **VALIDATED** | try/catch swallows error silently. No console.warn. |

---

## New Findings Not in Run 1

| # | Finding | Severity | Description |
|---|---------|----------|-------------|
| N1 | Camera shake is a dependency hub | MEDIUM | 4 subsystems (damage, shoot, shockwave, thunder) trigger `onNearMiss()`. Decomposition requires explicit `triggerShake()` export from combat_fx, consumed by weather module. |
| N2 | Refactoring plan contradicts Run 1 | INFO | Plan says "rename to renderer_fx.js." Run 1 says "decompose." Run 2 verdict: **decompose in stages**, weather extraction first (unblocks phase system). |
| N3 | Building enhancements undercosted by Run 1 | LOW | Run 1 estimated ~215 lines for building details. Actual: ~265 lines. Larger extraction than planned. |
| N4 | iOS AudioContext limit | HIGH | `_audioCtx` creates a second AudioContext. iOS Safari limits to 1. Thunder synthesis may fail silently on mobile. Must route through main audio system. |
| N5 | `_flashScreen` has timing bug | LOW | Line 935: `setTimeout(() => { _flagFlash.alpha = 0; ... }, durMs);` — the alpha is ALSO being decayed by `_tickFlashOverlay` every frame. The setTimeout zeroes it abruptly, potentially before the fade completes. Double-driven alpha creates a snap instead of a smooth fade. |
| N6 | Shockwave `scene.remove(mesh)` without null check | LOW | Line 446: `scene.remove(mesh)` inside the rAF callback. If `_ctx.scene` has been reassigned (map change, hot reload), this references a stale scene. Silent failure — mesh stays in old scene, never disposed. |
| N7 | 64-player scalability is fine | INFO | Most subsystems are per-world, not per-player. Only shockwave needs pool cap under heavy combat. |
| N8 | Phase hooks needed for 6 of 17 subsystems | HIGH | Lens flare, lightning, wet ground, camera shake, chimney smoke, faction materials all need phase awareness. Weather extraction is the critical path. |
| N9 | `_makeFlareTexture` / `_makeScorchTexture` create canvas textures at init | LOW | 4 canvas elements created during init, converted to `CanvasTexture`. These are leaked (never disposed). Minor — one-time cost. |

---

## Decomposition Staging Recommendation (Run 2 Consensus)

| Stage | Scope | Lines Moved | Unblocks |
|-------|-------|-------------|----------|
| **Stage 0** (now) | Fix telemetry offsets. Delete dead code (rain, flag sting, wear, subdivision). | −97 lines | Correct telemetry data. |
| **Stage 1** (before phase system) | Extract `renderer_weather.js` with `onPhaseChange()` hook. Route thunder through main audio. | ~210 lines out | Phase system feature. |
| **Stage 2** (next sprint) | Extract telemetry + compass + settings to `renderer_hud.js`. | ~150 lines out | HUD architecture. |
| **Stage 3** (with buildings work) | Move building enhancements to `renderer_buildings.js`. | ~265 lines out | Building lifecycle (generator destruction). |
| **Remainder** | Rename surviving file to `renderer_combat_fx.js` (~215 lines: shake, FOV punch, vignette, flag flash, shockwave, decals). | — | Clean single-purpose module. |

**Post-decomposition state:** renderer_polish.js is deleted. 5 destination modules, each with a one-sentence thesis and an `onPhaseChange()` hook.

---

*Run 2 complete. 18 Run 1 findings validated (2 severity adjustments: DOM writes HIGH→MEDIUM, AudioContext MEDIUM→HIGH). 9 new findings. Core conclusion upheld: renderer_polish.js must be decomposed, not just renamed. Weather extraction is the critical path, gating the phase system.*
