# Phase 3b — Adversarial Convergence Review: renderer_polish.js (Run 1)

**Target:** `renderer_polish.js` — 1,146 lines ("visual polish")  
**Date:** 2026-04-29  
**Panel:** ryg (GPU/draw calls/naming), Abrash (low-level perf/shaders), Carmack (engine architecture/perf), Ive (design coherence/"should this exist?")

---

## Pass 1 — Break It

### The Saboteur — Race Conditions, Null Derefs, Edge Cases

**S-1 · Shockwave Geometry Leak on Rapid Fire (HIGH)**  
`spawnShockwave()` (L424–452) creates a new `RingGeometry` + `MeshBasicMaterial` + `Mesh` per call, animates via chained `requestAnimationFrame`, and disposes on completion. But if `spawnShockwave` is called faster than 600ms (e.g., mortar spam from multiple players), N concurrent rAF chains run simultaneously. Each chain captures its own `mesh`, `geom`, `mat` via closure — so they don't leak per se — but N concurrent ring meshes are in the scene graph simultaneously. With 4 mortars firing at 1.2 rounds/sec, that's ~5 live shockwave meshes at any time. Each is a separate draw call (unique geometry + material). Not a crash, but an uncontrolled draw call source with no pool, no cap, no reuse.

**S-2 · Decal DecalGeometry Crash on Non-Indexed Geometry (MEDIUM)**  
`placeDecal()` (L486–525) wraps `new DecalGeometry()` in a try/catch with the comment "DecalGeometry can fail on non-indexed BufferGeometry." This is correct — Three.js `DecalGeometry` requires indexed geometry. But the error path silently swallows the exception, meaning: (a) the decal is never placed (player sees nothing), (b) no console warning is emitted (hard to debug), and (c) the `_decals.active` array doesn't grow, so the LRU cleanup won't fire incorrectly. The silent failure is acceptable for robustness, but the lack of a `console.warn` makes debugging impossible.

**S-3 · Lightning setTimeout Fires After Module Disabled (MEDIUM)**  
`_tickLightning()` (L230) schedules `setTimeout(() => window.playSoundUI(17), crackDelay)` and `setTimeout(() => _playThunder(), delay)`. If `?polish=off` is set mid-session (or the page is transitioning), these setTimeout callbacks still fire. `_playThunder()` creates an `AudioContext` and plays noise. `window.playSoundUI(17)` calls into the main audio system. Neither checks `_enabled` before executing. During page unload or session transitions, this produces orphaned audio nodes.

**S-4 · Camera Shake Accumulates Without Bound in Theory (LOW)**  
`onNearMiss(strength)` (L392) clamps `trauma` to 1.0 via `Math.min(1.0, trauma + strength)`. But `onDamage(amount)` (L399) calls `onNearMiss(trauma)` where trauma can be up to 0.85, AND the vignette is set to `0.18 + amt * 0.018`. These are separate effects, so there's no double-bound issue. However, rapid sequential damage calls (e.g., chaingun stream) will repeatedly set `_vignettePulse.alpha = Math.min(0.85, old + pulseAdd)` — the alpha never exceeds 0.85 but the *visual* effect is a near-permanent red screen during sustained damage. This may be intentional (you're dying) but feels like a binary state rather than a gradient.

**S-5 · _playFlagSting is Dead Code (LOW)**  
`_playFlagSting()` (L935–969) has `return;` as its first statement, with a comment explaining it's permanently disabled. 34 lines of dead code. The function is still called from `onFlagEvent()`. Dead code in a "polish" module is ironic.

### The Wiring Inspector — API Mismatches, Stale State

**W-1 · Telemetry Reads Wrong Player Stride Offsets (CRITICAL)**  
`_tickTelemetry()` (L1001–1030) reads player velocity as:
```js
const vx = _ctx.playerView[o + 4] || 0;
const vy = _ctx.playerView[o + 5] || 0;
const vz = _ctx.playerView[o + 6] || 0;
```
But per the system map's Player State Stride Layout, offset 4 is **Yaw**, not velocity X. Velocity X is at offset **6**, velocity Z is at offset **8**. The telemetry HUD is displaying `sqrt(yaw² + something² + velocityX²)` as "speed" — a completely wrong value that happens to look plausible because yaw is in radians (small numbers) and the displayed value is dominated by the one correct-ish component. This has been wrong since R32.7 and nobody noticed because the telemetry is hidden by default (F3 toggle).

**W-2 · `_ctx.playerView` and `_ctx.playerStride` Undocumented Dependencies (HIGH)**  
The telemetry tick reads `_ctx.playerView` and `_ctx.playerStride`, but `installPolish(ctx)` receives a context object documented as `{ THREE, scene, camera, renderer, composer, sunLight, hemiLight }`. There's no mention of `playerView` or `playerStride` in the API contract. The main renderer must be injecting these *after* init, and the polish module must tolerate them being absent during the first few frames. This implicit late-binding contract is undocumented.

**W-3 · `_ctx.sampleTerrainH` vs `window._sampleTerrainH` (MEDIUM)**  
`_sampleTerrainViaCtx()` (L589) reads `_ctx.sampleTerrainH` — but per the system map, the terrain height function is exposed as `window._sampleTerrainH`. The polish module checks a *different path* that may or may not be populated. If the main renderer sets `ctx.sampleTerrainH = window._sampleTerrainH`, it works. If not, rain splashes (now commented out) would spawn at y=0. Currently benign since rain is removed, but the pattern is fragile.

**W-4 · `_ctx.terrainMesh` Read in _initWetGround (MEDIUM)**  
`_initWetGround()` (L863) reads `_ctx.terrainMesh`. Like W-2, this isn't in the documented context interface. If terrain isn't ready at polish init time, `_wetGround` stays null silently. The wet ground effect may never activate depending on init ordering.

**W-5 · `_ctx.onDeathHook` Phantom API (LOW)**  
`onDeath()` (L408) calls `_ctx.onDeathHook(killerIdx)` if present. This callback isn't documented anywhere and doesn't appear in the system map. It may be a placeholder that was never wired. Dead API surface.

### The Cartographer — Data Model Gaps, Missing States

**C-1 · No Phase Awareness (HIGH)**  
The module has *zero* phase awareness. Lightning fires randomly regardless of phase. Wet ground applies regardless of phase. Smoke stacks emit regardless of generator state. The game design doc specifies that "each game state has its own atmospheric personality" and "the world TELLS you what phase it is." The polish module — which controls atmosphere-critical effects (lightning, wet ground, lens flare intensity, smoke) — doesn't know what phase it's in. This is a structural omission that blocks the entire Phase System feature.

**C-2 · No Generator State Tracking (MEDIUM)**  
`registerGeneratorChimney(worldPos)` (L608) creates smoke particles at a position and animates them forever. When a generator is destroyed, the smoke continues. There's no `removeGeneratorChimney()` or destruction callback. The visual world diverges from the game state — a destroyed generator has chimney smoke floating upward from its corpse.

**C-3 · Two-Team Hard Limit (MEDIUM)**  
`_initFactionMaterials()` (L833–844) creates exactly two faction palettes: `inferno` (red) and `storm` (blue). `getFactionPalette(team)` (L847) returns `team === 0 ? inferno : storm`. The game design doc specifies four tribes (Blood Eagle, Diamond Sword, Phoenix, Starwolf). This module can't represent Phoenix (gold) or Starwolf (green). Any team index > 1 gets the blue palette.

**C-4 · FX Level Not Respected Consistently (MEDIUM)**  
Some subsystems check `_fxLevel === 'low'` and skip init (lightning L202, decals L459, smoke L602, wet ground L858, rain splashes L536). But others don't check at all: shockwave (`spawnShockwave`, L424), bridge railings (`addBridgeRailings`, L731), tower windows (`addTowerWindows`, L776), station icons (`addStationIcon`, L808), faction materials (`_initFactionMaterials`, L833). These structural mesh additions arguably aren't "effects," but the distinction between "polish effect" and "structural detail" is never defined.

**C-5 · No Cleanup/Destroy Path (MEDIUM)**  
There's no `destroy()` or `dispose()` function. DOM elements (`#r327-lightning-flash`, `#r327-damage-vignette`, `#r327-flag-flash`, `#r327-telemetry`, `#r327-hud-ring`, `#r327-settings-btn`, `#r327-settings-panel`) are appended to `document.body` and never removed. Event listeners (`keydown` for F2, F3) are never unbound. Three.js objects (smoke point clouds, decal meshes, lens flare, station sprites, railings, windows) are never disposed. This blocks session-to-session transitions, map changes, and hot-reload.

---

## Pass 2 — Challenge Architecture (Independent Expert Reviews)

### ryg — GPU Pipeline, Draw Calls, Naming

**ryg-1 · "Polish" Is Not a Module Name (HIGH — naming)**  
What is "polish"? This file contains: a sun lens flare system, a lightning/weather system, a camera shake system, an FOV punch system, a decal pool, a chimney smoke particle system, turret geometry enhancement, sensor geometry enhancement, bridge railing geometry generation, tower window generation, holographic station icon sprites, faction material palettes, a wet ground shader tweak, a damage vignette DOM overlay, a flag flash DOM overlay, a telemetry HUD, a compass HUD, a graphics settings panel, and dead rain splash code. That's **17+ distinct systems** in one file under a name that describes none of them.

"Polish" is a development-phase label, not an architectural category. It means "stuff we added after the core worked." That's not how you organize code — you organize by *what it does*, not *when you wrote it*. This file should be split into at minimum:
- `renderer_weather.js` (lightning, wet ground, rain — phase-reactive weather)
- `renderer_fx.js` (shake, FOV punch, vignette, flag flash, shockwave, decals)
- `renderer_building_detail.js` (railings, windows, smoke stacks, turret/sensor enhancements, station icons, faction materials)
- `renderer_hud_overlay.js` (telemetry, compass, settings panel)

Each of those would be 150-300 lines, single-purpose, testable in isolation, and phase-aware by design.

**ryg-2 · Shockwave Creates a New Draw Call Per Instance (MEDIUM)**  
Each `spawnShockwave()` creates a unique `RingGeometry` + `MeshBasicMaterial`. These can't be instanced or batched by Three.js because each has unique geometry (different scale over time) and unique material state (different opacity). A pool of pre-created meshes (set visible/invisible, reuse geometry via uniform scale) would cap draw calls at pool size.

**ryg-3 · Decal Materials Are Not Shared (MEDIUM)**  
`placeDecal()` (L510) creates `new THREE.MeshBasicMaterial(...)` per decal. The texture (`_decals.tex`) is shared, but the material is not. 256 decals = 256 unique materials = 256 draw calls. All decals have identical parameters except the geometry. Share one material across all decal meshes — they'd still need separate draw calls (unique geometry from `DecalGeometry`), but material state changes would be eliminated.

**ryg-4 · Smoke Stacks Are Separate Points Objects (LOW)**  
Each generator chimney gets its own `THREE.Points` object (L610–625) with 18 particles. 4 generators = 4 draw calls for 72 total particles. These should be merged into a single `Points` object with per-particle origin tracking. One draw call for all chimney smoke.

### Abrash — Low-Level Performance

**abrash-1 · DOM Style Manipulation Every Frame (HIGH)**  
`_tickFlashOverlay()` (L909–917) runs every frame and writes:
```js
_vignettePulse.el.style.opacity = _vignettePulse.alpha.toFixed(3);
```
Even when alpha is 0. And:
```js
_flagFlash.el.style.opacity = _flagFlash.alpha.toFixed(3);
```
Even when alpha is already 0. DOM style writes trigger layout invalidation in the browser. Two style writes per frame, unconditionally, whether the overlays are active or not. Should early-return when alpha is 0 and was already 0 last frame.

**abrash-2 · Compass HUD Runs Every Frame (MEDIUM)**  
`_tickHUDRing()` (L1067–1075) computes yaw, quantizes to 8 directions, and sets `textContent` every frame. The compass direction changes at most ~15 times per second (human turning speed). This should throttle to 100ms intervals or check if the direction actually changed before writing DOM.

**abrash-3 · Telemetry innerHTML Rewrite Every 250ms (LOW)**  
`_tickTelemetry()` builds a multi-line string and sets `innerHTML` every 250ms. `innerHTML` parsing is expensive — `textContent` on pre-created sub-elements would be faster. But at 4 Hz update rate, this is negligible. Noted for completeness.

**abrash-4 · `_tickSmokeStacks` Updates All Particles Every Frame (LOW)**  
The smoke stack tick (L634–648) iterates all particles across all stacks every frame, updating positions. For 4 stacks × 18 particles = 72 iterations per frame — cheap, but the `needsUpdate = true` on the geometry attribute triggers a full buffer upload to the GPU. Four buffer uploads per frame for 72 particles. Merge into a single buffer (see ryg-4) and do one upload.

### Carmack — Engine Architecture & Performance

**carmack-1 · This Module Has No Architecture (CRITICAL)**  
I've reviewed a lot of game code. This is what happens when a developer adds "one more effect" twenty times without stepping back to design a system. There's no unifying architecture — no effect lifecycle, no subsystem registry, no update priority, no resource budget. Effects are initialized via `safeInit()` (a try/catch wrapper), ticked via direct `if (x) tick(x)` calls in the main `tick()` function, and state is tracked in 20+ module-level variables with no grouping or lifecycle management.

Contrast this with the particle system in renderer.js — a proper pool-based system with a single shader material, instanced rendering, explicit lifecycle (spawn → tick → recycle), and a clear budget (384/512 particles). *That's* how effects should work. This file is a junk drawer.

The fix isn't "refactor renderer_polish.js." The fix is to delete renderer_polish.js and promote each subsystem to its proper home:
- Camera effects (shake, FOV punch) → camera controller module
- Weather effects (lightning, wet ground) → phase/weather system
- HUD overlays (vignette, flag flash, telemetry, compass, settings) → HUD module
- Building detail (railings, windows, smoke, turret enhancements) → renderer_buildings.js
- Decals → combat FX module (alongside bullet tracers and muzzle flashes)
- Faction palettes → character/team color system

**carmack-2 · requestAnimationFrame in Shockwave Bypasses the Render Loop (HIGH)**  
`spawnShockwave()` uses its own `requestAnimationFrame` loop (L443–451) independent of the main render loop. This means: (a) shockwave animation runs at screen refresh rate regardless of game pause state, (b) the shockwave's timing isn't synchronized with the game clock (uses `performance.now()` directly instead of the `dt`/`t` passed to `tick()`), (c) if the tab is backgrounded, rAF stops but the shockwave's start time keeps ticking — when foregrounded, it instantly completes. All effects should be driven by the single render loop `tick(dt, t)`.

**carmack-3 · Audio System Duplication (MEDIUM)**  
This module creates its own `AudioContext` (L311, `_audioCtx`) for thunder synthesis and (disabled) flag stings. The main game already has an audio system (`window.playSoundUI`, `window.playSoundAt`). Now there are two AudioContext instances — browsers limit these (usually 6), and two competing contexts can cause audio glitches. Thunder synthesis should be in the audio system, not the polish module.

**carmack-4 · The ?polish=off Flag Is the Only Quality Control (MEDIUM)**  
`_fxLevel` controls *some* effects (low/mid/high), and `_detailHigh` controls subdivision (which is a no-op). But the module's quality response is ad hoc — some effects check `_fxLevel`, others don't. The main renderer has a `currentQuality` tier system (low/medium/high/ultra) that Polish doesn't participate in. When the user changes quality in settings, Polish's shockwaves, decals, and building details don't respond.

### Ive — Design Coherence / "Should This Exist?"

**ive-1 · What Sensation Does "Polish" Create? (CRITICAL)**  
I cannot articulate what player sensation this module serves, because it serves *all of them and none of them*. A lens flare serves Scale (the sun is far away, the world is vast). Lightning serves Aliveness (the world breathes and changes). Camera shake serves combat feel (hits have weight). A compass HUD serves navigation (Adaptation). Bridge railings serve visual fidelity (Aliveness). A settings panel serves… usability.

A module should have a *thesis* — one answer to "what does this make the player feel?" When the answer is "everything," the real answer is "nothing in particular." This module exists because there was no other place to put things. It's architectural homelessness.

**ive-2 · Seven DOM Overlays Competing for Z-Index (HIGH)**  
This module creates:
- `#r327-lightning-flash` (z: 9990)
- `#r327-damage-vignette` (z: 9991)
- `#r327-flag-flash` (z: 9989)
- `#r327-telemetry` (z: 9988)
- `#r327-hud-ring` (z: 9987)
- `#r327-settings-btn` (z: 9986)
- `#r327-settings-panel` (z: 9986)

Seven DOM elements with hardcoded z-indices in the 9986-9991 range. These interact with whatever z-indices the main HUD uses. If index.html has z-index 9992 for its menu, this works. If someone adds z-index 9990 elsewhere, lightning flash disappears behind it. There's no z-index registry, no HUD layer system, no documented stacking order.

**ive-3 · The Settings Panel Belongs in the Main UI (MEDIUM)**  
A floating gear button + dropdown for graphics quality and FX level is a UI element, not a render effect. It reads from `window.ST` (settings store) and writes to `window.__tribesApplyQuality`. This is application UI that got exiled to the polish module because the polish module was the active development frontier. It should live in index.html or a dedicated settings/UI module.

**ive-4 · Telemetry and Compass Are Debug/HUD, Not Polish (MEDIUM)**  
A telemetry overlay (FPS, speed, position) is a debug tool. A compass is a navigation HUD element. Neither is "polish." Both read from WASM state and display data. They're HUD systems that got misfiled.

---

## Pass 3 — Debate to Consensus

### "Should We Refactor or Delete?"

**Carmack:** I said "delete renderer_polish.js" in Pass 2, and I mean it. Not delete the *code* — delete the *concept*. There should be no "polish" module. Each system in here has a proper home. Move it there. The file is 1,146 lines of "I didn't know where else to put this."

**ryg:** I agree with Carmack's direction but want to be practical about execution. This file has 11 public exports (`installPolish`, `spawnShockwave`, `placeDecal`, `registerGeneratorChimney`, `enhanceTurret`, `enhanceSensor`, `addBridgeRailings`, `addTowerWindows`, `addStationIcon`, `getFactionPalette`, plus the return object API). Every call site in renderer.js and renderer_buildings.js needs updating. That's a multi-session refactor, not a quick fix.

**Carmack:** Agreed on timing. But the refactor plan should be concrete now. Here's my proposal:

| Current Location | New Home | Rationale |
|---|---|---|
| Lightning, wet ground, rain (dead) | `renderer_weather.js` | Phase-reactive weather system, ticks with phase state |
| Camera shake, FOV punch | Camera controller in renderer.js | Part of the camera's job, ticked by render loop |
| Damage vignette, flag flash, shockwave | `renderer_combat_fx.js` | Combat feedback effects, alongside muzzle flash and tracers |
| Decals | `renderer_combat_fx.js` | Scorch marks are combat artifacts |
| Telemetry, compass, settings panel | `renderer_hud.js` or index.html | HUD/UI systems |
| Chimney smoke, railings, windows, turret/sensor enhancements, station icons | `renderer_buildings.js` | Building visual detail |
| Faction materials | `renderer_buildings.js` or team system | Team color palette |

**Ive:** I support the split but want to push further: each new module must have a one-sentence thesis at the top. `renderer_weather.js: "Makes the world feel alive and phase-reactive through atmospheric effects."` If you can't write that sentence, the module isn't coherent.

**Abrash:** From a perf standpoint, the DOM overlay consolidation matters most. Seven floating div overlays with per-frame style writes is a browser compositing nightmare. Any new HUD module should use a single canvas overlay (or WebGL overlay) instead of N DOM elements.

**ryg:** Or at minimum, batch all DOM writes into a single rAF callback with dirty flags — don't write styles that haven't changed.

### The Telemetry Bug (W-1)

**Carmack:** The wrong-offset telemetry reading is a concrete bug that should be fixed immediately, regardless of refactor plans. Speed display is a player-facing metric (F3 debug or not). Reading yaw as velocity is wrong.

**ryg:** It's also a symptom of the stride-offset magic number problem we flagged in Phase 2b. The constants should be in a shared file. If `renderer_polish.js` had imported `PLAYER_VEL_X = 6` from a shared constants module, this bug couldn't exist.

**Carmack:** Agreed. Minimum fix: change offsets 4/5/6 to 6/7/8. Proper fix: import named constants.

### The Phase Awareness Gap (C-1)

**Ive:** This is the biggest design gap. The game design doc says "each game state has its own atmospheric personality." The polish module controls atmospheric effects. It doesn't know what phase is active. This means when the phase system is implemented, someone will have to retrofit phase awareness into every effect in this file. If the file has been split by then, each module naturally gets its own phase hooks. If it hasn't been split, the retrofit is a nightmare of `if (phase === 'fog') { ... } else if (phase === 'lava') { ... }` scattered across 17 subsystems.

**Carmack:** This is the strongest argument for splitting now rather than later. The phase system is the next major feature. Building it on top of renderer_polish.js means building on quicksand.

**Abrash:** Phase-conditional effects also have perf implications. During Dense Fog phase, lens flare should be off (sun isn't visible). During Lava Flood, wet ground should be off (ground isn't wet, it's on fire). Lightning should ramp during storm phases, disappear during clear sky. Each effect needs a phase-conditional enable/disable — which is natural if each effect is a module with an `onPhaseChange(phase)` callback, and ugly if it's all in one file.

### Consensus

| # | Issue | Sev | Consensus |
|---|-------|-----|-----------|
| carmack-1 / ryg-1 / ive-1 | Module has no architecture; "polish" isn't a category | CRITICAL | **Split into 4+ purpose-driven modules.** Each must have a one-sentence thesis. Concrete split plan in Pass 4. |
| W-1 | Telemetry reads yaw as velocity (offsets 4/5/6 should be 6/7/8) | CRITICAL | **Fix immediately.** Import named constants from shared module. |
| C-1 | No phase awareness — blocks phase system feature | HIGH | **Each split module gets `onPhaseChange(phase)` hook.** Weather module is phase-primary. |
| carmack-2 | Shockwave uses independent rAF loop | HIGH | **Move to tick()-driven animation.** All effects must use the game clock. |
| S-1 / ryg-2 | Shockwave creates unbounded draw calls | HIGH | **Pool with fixed cap (8-16 max).** Reuse mesh + material. |
| ive-2 / abrash-1 | 7 DOM overlays with per-frame style writes, no z-index system | HIGH | **Consolidate into canvas or single-overlay approach. Z-index registry.** |
| carmack-3 | Duplicate AudioContext for thunder | MEDIUM | **Route thunder synthesis through main audio system.** |
| C-2 | Generator smoke continues after destruction | MEDIUM | **Add `removeGeneratorChimney()` callback.** |
| C-3 | Two-team limit in faction materials | MEDIUM | **Extend to 4 tribes with GDD colors.** |
| ryg-3 | Decal materials not shared | MEDIUM | **Single shared material, per-decal geometry only.** |
| C-5 | No destroy/dispose path | MEDIUM | **Each split module gets `destroy()`.** |
| W-2 / W-4 | Undocumented ctx dependencies (playerView, terrainMesh) | MEDIUM | **Document full ctx contract in @ai-contract.** |
| carmack-4 | Quality tier system not integrated with main renderer | MEDIUM | **Polish subsystems must respond to `currentQuality` changes.** |
| ive-3 / ive-4 | Settings panel and telemetry are UI, not polish | MEDIUM | **Move to HUD/UI module.** |
| S-3 | Lightning setTimeout fires after disable | LOW | **Guard callbacks with `_enabled` check.** |
| S-5 | Dead _playFlagSting code | LOW | **Delete.** |
| ryg-4 / abrash-4 | Smoke stacks: separate Points objects, N buffer uploads | LOW | **Merge into single Points with one buffer upload.** |

### Dissenting Notes

**Abrash** notes that the DOM overlay issue may be overweighted — modern browsers composite fixed-position overlays efficiently. But agrees that *writing styles every frame when nothing changed* is wasteful regardless.

**ryg** cautions that splitting into 4+ modules increases import count and init ordering complexity. Proposes a `renderer_effects.js` umbrella that lazy-loads sub-modules, preserving the single import for renderer.js.

---

## Pass 4 — System-Level Review

### Dependency Map

```
renderer_polish.js
├── IMPORTS
│   ├── three (THREE namespace)
│   ├── three/addons/objects/Lensflare.js (Lensflare, LensflareElement)
│   └── three/addons/geometries/DecalGeometry.js (DecalGeometry)
│
├── EXPORTS (ES module named exports)
│   ├── installPolish(ctx)          → called by renderer.js on init
│   │   Returns: { tick, onDamage, onShoot, onNearMiss, onJetBoost,
│   │              onFlagEvent, onSpawn, onDeath, getFXLevel, setFXLevel }
│   ├── spawnShockwave(scene, pos, mag) → called by renderer.js on explosion
│   ├── placeDecal(mesh, pos, normal, scale) → called by renderer.js on impact
│   ├── registerGeneratorChimney(pos) → called by renderer.js/buildings on gen init
│   ├── enhanceTurret(group, kind, color) → called by renderer_buildings.js
│   ├── enhanceSensor(group)          → called by renderer_buildings.js
│   ├── addBridgeRailings(mesh)       → called by renderer_buildings.js
│   ├── addTowerWindows(mesh, h, sides) → called by renderer_buildings.js
│   ├── addStationIcon(group, type, color) → called by renderer_buildings.js
│   └── getFactionPalette(team)       → called by renderer_buildings.js
│
├── IMPLICIT READS (via _ctx or window)
│   ├── _ctx.scene, _ctx.camera, _ctx.renderer, _ctx.composer
│   ├── _ctx.sunLight, _ctx.hemiLight
│   ├── _ctx.playerView, _ctx.playerStride (undocumented late-bind)
│   ├── _ctx.terrainMesh (undocumented late-bind)
│   ├── _ctx.sampleTerrainH (undocumented late-bind)
│   ├── _ctx.onDeathHook (phantom callback)
│   ├── window.Module._getLocalPlayerIdx (WASM)
│   ├── window.playSoundUI (main audio)
│   ├── window.ST (settings store)
│   ├── window.__tribesApplyQuality (quality callback)
│   └── URL params: ?polish, ?fx, ?detail
│
├── IMPLICIT WRITES (DOM)
│   ├── document.body → 7 DOM elements (#r327-*)
│   └── window keydown listeners (F2, F3)
│
├── CREATES (Three.js scene objects)
│   ├── Lensflare on sunLight
│   ├── Line (lightning bolt) — ephemeral
│   ├── Points × N (chimney smoke stacks)
│   ├── Mesh (shockwave rings) — ephemeral, unbounded
│   ├── Mesh (decals) — pooled, LRU cap
│   ├── Mesh (turret coil rings, missile clusters)
│   ├── Group (sensor dish struts)
│   ├── Group (bridge railings)
│   ├── Mesh (tower window planes)
│   └── Sprite (station icons)
│
└── CONSUMERS
    ├── renderer.js (installPolish, tick, onDamage, onShoot, onNearMiss,
    │                onJetBoost, onFlagEvent, onSpawn, onDeath, spawnShockwave,
    │                placeDecal, registerGeneratorChimney)
    └── renderer_buildings.js (enhanceTurret, enhanceSensor, addBridgeRailings,
                               addTowerWindows, addStationIcon, getFactionPalette)
```

### Interface Contract

| Function | Called By | Frequency | Latency Budget |
|----------|----------|-----------|----------------|
| `installPolish(ctx)` | renderer.js | Once at init | 50ms |
| `tick(dt, t)` | renderer.js render loop | Every frame (60-144Hz) | **< 0.3ms** |
| `onDamage(amount)` | renderer.js | On hit (0-30 Hz) | Immediate |
| `onShoot(weaponType)` | renderer.js | On fire (1-10 Hz) | Immediate |
| `onNearMiss(strength)` | renderer.js | On near-miss/explosion | Immediate |
| `onJetBoost(active)` | renderer.js | On jet toggle | Immediate |
| `onFlagEvent(type, team)` | renderer.js | On flag event | Immediate |
| `spawnShockwave(scene, pos, mag)` | renderer.js | On explosion (0-5 Hz) | Immediate |
| `placeDecal(mesh, pos, n, s)` | renderer.js | On impact (0-30 Hz) | < 1ms |
| `registerGeneratorChimney(pos)` | renderer.js | Per generator (2-4) | 5ms |
| `enhanceTurret(group, kind, color)` | renderer_buildings.js | Per turret (~8) | 5ms each |
| `enhanceSensor(group)` | renderer_buildings.js | Per sensor (~4) | 5ms each |
| `addBridgeRailings(mesh)` | renderer_buildings.js | Per bridge (~2) | 5ms each |
| `addTowerWindows(mesh, h, sides)` | renderer_buildings.js | Per tower (~4) | 5ms each |
| `addStationIcon(group, type, color)` | renderer_buildings.js | Per station (~12) | 5ms each |
| `getFactionPalette(team)` | renderer_buildings.js | Per building init | Immediate |

### Contradiction Flags

1. **Module name contradicts content.** "Polish" implies optional nice-to-haves. But this file contains *structural building geometry* (railings, windows, turret enhancements) that contribute to visual identity. Removing `?polish=off` removes building detail that affects readability.

2. **"Opt-out via ?polish=off" contradicts building contracts.** If polish is off, `enhanceTurret` is a no-op. Turrets lose their missile clusters and plasma coil rings. This isn't "less polish" — it's "different game objects." The structural building enhancements should not be opt-outable.

3. **Dead rain code contradicts removal.** Rain was removed (R32.59.2 comments), but `_initRainSplashes()` and `_tickRainSplashes()` are still in the file (L536–590), just commented out of the init/tick paths. 54 lines of truly dead code.

### Keep / Extract / Absorb / Kill

| System | Lines | Verdict | Destination | Rationale |
|--------|-------|---------|-------------|-----------|
| Sun lens flare | ~40 | **EXTRACT** | `renderer_weather.js` | Phase-reactive (off in fog, intense at noon) |
| Lightning + thunder | ~130 | **EXTRACT** | `renderer_weather.js` | Phase-reactive (storm phase), needs audio system integration |
| Camera shake | ~30 | **ABSORB** | renderer.js camera controller | Core camera behavior, not optional polish |
| FOV punch | ~20 | **ABSORB** | renderer.js camera controller | Core camera behavior |
| Shockwave | ~30 | **ABSORB** | `renderer_combat_fx.js` | Combat effect, alongside explosions/tracers |
| Decal pool | ~70 | **ABSORB** | `renderer_combat_fx.js` | Combat artifacts (scorch marks) |
| Rain splashes | ~55 | **KILL** | — | Dead code (rain removed R32.59.2) |
| Chimney smoke | ~60 | **EXTRACT** | `renderer_buildings.js` | Building visual detail with lifecycle needs |
| Turret enhancements | ~45 | **EXTRACT** | `renderer_buildings.js` | Structural building geometry |
| Sensor enhancements | ~30 | **EXTRACT** | `renderer_buildings.js` | Structural building geometry |
| Bridge railings | ~45 | **EXTRACT** | `renderer_buildings.js` | Structural building geometry |
| Tower windows | ~30 | **EXTRACT** | `renderer_buildings.js` | Structural building geometry |
| Station icons | ~65 | **EXTRACT** | `renderer_buildings.js` | Building detail (holographic markers) |
| Faction materials | ~20 | **EXTRACT** | `renderer_buildings.js` or team system | Team color system |
| Wet ground | ~20 | **EXTRACT** | `renderer_weather.js` | Phase-reactive (wet in rain, dry in lava) |
| Wear & tear | ~5 | **KILL** | — | No-op placeholder |
| Subdivision | ~10 | **KILL** | — | No-op (modifier unavailable) |
| Damage vignette | ~20 | **ABSORB** | HUD/combat feedback module | Combat feedback, not optional polish |
| Flag flash | ~15 | **ABSORB** | HUD/combat feedback module | Game event feedback |
| Flag sting (dead) | ~35 | **KILL** | — | Dead code (permanently disabled) |
| Telemetry HUD | ~55 | **EXTRACT** | `renderer_hud.js` or debug module | Debug/dev tool |
| Compass HUD | ~30 | **EXTRACT** | `renderer_hud.js` | Navigation HUD element |
| Settings panel | ~65 | **EXTRACT** | `renderer_hud.js` or index.html | Application UI |
| safeInit + utils | ~30 | **ABSORB** | Shared utility | Generic patterns |
| **TOTAL** | ~1,146 | | | |

**Net result:** renderer_polish.js is deleted. ~160 lines killed (dead code). ~950 lines distributed to their proper homes. ~35 lines of glue/utility absorbed into shared patterns.

---

## Pass 5 — AI Rules Extraction

```javascript
// @ai-contract renderer_polish.js
// STATUS: DEPRECATED — scheduled for decomposition into purpose-driven modules.
// Do NOT add new effects to this file. Place them in their proper module:
//   - Weather/atmosphere effects → renderer_weather.js (to be created)
//   - Combat feedback (shake, vignette, decals, shockwave) → renderer_combat_fx.js
//   - Building detail (railings, windows, turret/sensor enhancements) → renderer_buildings.js
//   - HUD overlays (telemetry, compass, settings) → renderer_hud.js (to be created)
//
// CURRENT ROLE (transitional): Catch-all visual effects module. Opt-out via ?polish=off.
//
// CONTEXT OBJECT (installPolish receives):
//   Required at init: { THREE, scene, camera, renderer, composer, sunLight, hemiLight }
//   Late-bound by renderer.js: playerView, playerStride, terrainMesh, sampleTerrainH
//   Do NOT read _ctx properties that aren't documented above.
//
// TICK BUDGET: < 0.3ms per frame total across all subsystems.
//   Lightning bolt: geometry created/disposed per strike (0.25s lifetime) — acceptable at 1 per 6-22s.
//   Smoke stacks: N buffer uploads per frame (N = generator count). Target: merge to 1.
//   DOM writes: vignette + flag flash opacity ONLY when alpha > 0 and changed.
//
// DRAW CALL BUDGET:
//   Shockwaves: MUST be pooled. Max 8 concurrent. Reuse geometry + material.
//   Decals: Max 256 (high) / 128 (mid). Shared material. Each is 1 draw call (unique geom).
//   Smoke stacks: Should be 1 draw call total (merged Points). Currently N.
//   Building details: Additive geometry on existing groups. Not separate draw calls.
//
// AUDIO:
//   Do NOT create AudioContext in this module. Route all audio through window.playSoundUI
//   or window.playSoundAt. Thunder synthesis must move to main audio system.
//
// PHASE AWARENESS (TODO — blocks phase system):
//   Each effect must respond to phase changes:
//   - Open Sky: all effects normal
//   - Dense Fog: lens flare OFF, lightning OFF, wet ground ON, smoke intensified
//   - Lava Flood: wet ground OFF, heat shimmer ON, lens flare intensity boosted
//   - Mech Wave: camera shake amplified, faction materials battle-damaged
//
// DOM ELEMENTS (7 total, z-index 9986-9991):
//   #r327-lightning-flash, #r327-damage-vignette, #r327-flag-flash,
//   #r327-telemetry, #r327-hud-ring, #r327-settings-btn, #r327-settings-panel
//   All MUST be cleaned up in destroy(). No destroy() exists yet — ship-blocking.
//
// PLAYER STRIDE OFFSETS (BUG: telemetry uses wrong offsets):
//   Position: offsets 0, 1, 2  |  Velocity: offsets 6, 7, 8  (NOT 4, 5, 6)
//   Import from shared constants — do NOT hardcode magic numbers.
//
// FORBIDDEN:
//   - Adding new subsystems to this file (use proper module)
//   - requestAnimationFrame loops (use tick(dt, t) exclusively)
//   - Creating new AudioContext (use main audio system)
//   - Hardcoding 2-team colors (must support 4 tribes)
//   - Writing DOM styles when nothing changed
//   - Creating unbounded scene objects (pool everything)
//
// EXPOSES: installPolish, spawnShockwave, placeDecal, registerGeneratorChimney,
//          enhanceTurret, enhanceSensor, addBridgeRailings, addTowerWindows,
//          addStationIcon, getFactionPalette
// DEPENDS: three, three/addons/Lensflare, three/addons/DecalGeometry
// CONSUMERS: renderer.js, renderer_buildings.js
```

---

## Pass 6 — Design Intent (Core Feelings)

### Scale

**Lens flare:** When the sun catches the lens during a high-altitude jet across the map, the flare says "this star is real, this world is vast." It's one of the few effects that communicates *astronomical* scale — the sun isn't a skybox pixel, it's a light source that interacts with your camera. ✅ Serves Scale directly.

**Compass HUD:** Knowing your heading on a 4km map is navigation at scale. Without it, the map is directionless. ✅ Serves Scale.

**Lightning:** Visible from across the map. A bolt at 200m range says "the sky is tall, the terrain is wide, weather happens in this world." ✅ Serves Scale + Aliveness.

### Aliveness

**Generator chimney smoke:** A working generator *breathes* — smoke rises, drifts with wind. A dead generator should stop smoking. Currently it doesn't (C-2). When fixed, this is Aliveness made tactile. ⚠️ Partially serves Aliveness (broken on destruction).

**Wet ground:** A rainy map with wet-looking ground that subtly pulses in reflectivity. You feel the weather through the terrain. ✅ Serves Aliveness — but only if phase-reactive (C-1). During Lava Flood, the ground shouldn't look wet.

**Tower windows:** Warm emissive glow from tower windows at night. The base isn't dead geometry — it has *life inside*. ✅ Serves Aliveness directly.

**Station icons:** Holographic markers hovering over stations say "this place is active, powered, functional." ✅ Serves Aliveness.

### Belonging

**Faction materials:** Your base's buildings have your tribe's color tint. Diamond Sword's chrome-navy vs Blood Eagle's hot-red grunge. You look at a building and know *whose* it is. ✅ Serves Belonging — but only 2 of 4 tribes (C-3).

**Damage vignette:** When you take damage, the screen bleeds red. Your body is your tribe's asset — damage to you is damage to the team. ✅ Serves Belonging (indirectly, through combat investment).

**Flag flash:** The screen flashes on flag events — your tribe's flag was picked up, captured, dropped. You feel it even if you didn't see it. ✅ Serves Belonging.

### Adaptation

**Phase-reactive weather (MISSING):** This is the gap. Adaptation requires the world to *change* — and the player to *feel* the change. Lightning during a storm phase, calm during open sky, heat shimmer during lava. The polish module has the effects but no phase clock. When weather shifts with the game phase, the player's adaptation response fires: "it's getting stormy, I need to change my approach." Without phase awareness, these effects are static decorations rather than gameplay signals. ❌ Does not serve Adaptation until phase hooks are added.

### Noise Check (Ive's Razor)

| Effect | Sensation? | Verdict |
|--------|-----------|---------|
| Lens flare | Scale | ✅ Keep |
| Lightning | Scale + Aliveness | ✅ Keep (add phase hooks) |
| Camera shake | Combat feel | ✅ Keep (not optional "polish") |
| FOV punch | Movement feel | ✅ Keep (not optional "polish") |
| Shockwave | Combat feel | ✅ Keep (fix pooling) |
| Decal pool | Aliveness (battle scars) | ✅ Keep |
| Rain splashes | Dead | ❌ Kill |
| Chimney smoke | Aliveness | ✅ Keep (fix lifecycle) |
| Turret enhancements | Readability | ✅ Keep (not optional) |
| Sensor enhancements | Readability | ✅ Keep (not optional) |
| Bridge railings | Readability + Scale | ✅ Keep (not optional) |
| Tower windows | Aliveness | ✅ Keep |
| Station icons | Aliveness + Navigation | ✅ Keep |
| Faction materials | Belonging | ✅ Keep (extend to 4 tribes) |
| Wet ground | Aliveness | ✅ Keep (add phase hooks) |
| Wear & tear (no-op) | Nothing | ❌ Kill |
| Subdivision (no-op) | Nothing | ❌ Kill |
| Damage vignette | Combat feel | ✅ Keep (not optional) |
| Flag flash | Belonging | ✅ Keep |
| Flag sting (dead) | Nothing | ❌ Kill |
| Telemetry | Debug tool | ✅ Keep (move to debug/HUD) |
| Compass | Navigation | ✅ Keep (move to HUD) |
| Settings panel | Usability | ✅ Keep (move to UI) |

**4 items killed** (rain splashes, wear & tear, subdivision, flag sting) = ~105 lines of dead/no-op code. Everything else serves a real sensation but is in the wrong file.

---

## Deliverable Summary

### Critical Path (blocks next milestone)

1. **Fix telemetry velocity offset bug (W-1)** — Change offsets 4/5/6 → 6/7/8 in `_tickTelemetry`. Extract named constants from shared module. 15-minute fix. Wrong data is worse than no data.

2. **Plan decomposition of renderer_polish.js** — The file must be split before the phase system is built. Concrete split targets:
   - `renderer_weather.js` (~190 lines): lens flare, lightning/thunder, wet ground. Phase-reactive. `onPhaseChange(phase)` hook.
   - Move camera shake + FOV punch (~50 lines) into renderer.js camera controller.
   - Move shockwave + decals + vignette + flag flash (~135 lines) into `renderer_combat_fx.js`.
   - Move building details (~215 lines: smoke, railings, windows, turrets, sensors, icons, faction materials) into `renderer_buildings.js`.
   - Move telemetry + compass + settings (~150 lines) into `renderer_hud.js` or index.html.
   - Delete dead code (~105 lines).
   - Delete renderer_polish.js.

3. **Add phase awareness hooks** — Each split module gets `onPhaseChange(phase)` that enables/disables effects per game phase. Blocks Phase System feature.

### High Priority (next sprint)

4. **Pool shockwave meshes** — Cap at 8, reuse geometry/material, drive from `tick()` not independent rAF.
5. **Route thunder through main audio** — Delete `_audioCtx`, synthesize thunder via `window.playSoundAt` or a dedicated audio module.
6. **Add generator smoke lifecycle** — `removeGeneratorChimney(pos)` triggered on generator destruction.
7. **Extend faction palettes to 4 tribes** — Phoenix (gold #D4A030), Starwolf (green #30A050).
8. **Add destroy()/dispose()** — Clean up all DOM elements, Three.js objects, event listeners.
9. **Consolidate DOM overlays** — Z-index registry. Batch DOM writes with dirty flags.

### Medium Priority (track)

10. Share decal material across all decal meshes.
11. Merge chimney smoke into single Points object.
12. Document full `_ctx` interface contract.
13. Integrate FX level with main quality tier system.
14. Remove structural building enhancements from `?polish=off` gate (they're not optional polish).

### Low Priority

15. Guard setTimeout callbacks with `_enabled` check.
16. Delete dead rain splash code.
17. Delete dead flag sting code.
18. Delete no-op wear & tear and subdivision functions.

### Metrics to Track

- `tick()` frame time (target < 0.3ms)
- Active shockwave count (should never exceed pool cap)
- DOM style writes per frame (target: 0 when no active overlays)
- Draw calls from polish subsystems (target: decal cap + 1 smoke + constant building detail)

---

*Review conducted under the Adversarial Convergence Review protocol. Panel: ryg, Abrash, Carmack, Ive. All findings rated by severity and cross-validated through expert debate. The unanimous conclusion: renderer_polish.js is not a module — it's a development-phase artifact that should be decomposed into purpose-driven systems before the phase system is built.*
