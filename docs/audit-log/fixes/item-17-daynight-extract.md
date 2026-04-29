# Item 17 — Extract renderer_daynight.js — Cohort Review

**Commit:** `refactor(R32.179): extract renderer_daynight.js from renderer.js`
**Scope:** Medium extraction (~260 lines new module, ~160 lines removed from renderer.js)
**Review:** Pass 1 (Break It) + Pass 4 (System-Level)

---

## Pass 1 — Break It

### The Saboteur

**What if update() is called before init()?**

The module has `_cycleSeconds` computed at module load from URL params — that's fine, it doesn't need scene refs. But `_apply()` writes to `_sunLight`, `_hemiLight`, etc. which are all null before `init()`. Every write is guarded with `if (_sunLight)`, `if (_moonLight)`, etc. so calling `update()` before `init()` is safe — it just computes colors and updates `dayMix`/`sunDir` without touching the scene. ✅ No crash.

**What if init() is called twice?**

Each call overwrites refs. No double-attach, no listener leak. Safe. ✅

**What if terrainMesh is null when setRef is called?**

`setRef('terrainMesh', null)` → `_terrainMesh = null`. Then `_apply()` checks `if (_terrainMesh && _terrainMesh.material)` — guards against null. ✅

**What if freeze(hour) is called with hour > 24 or < 0?**

`Math.max(0, Math.min(1, hour / 24.0))` — clamped to [0, 1]. Even negative hours or 999 are safe. ✅

**Race condition: lerpColors returns _tmpA which is module-scoped. If called from two call sites in the same frame?**

`lerpColors` mutates and returns `_tmpA`. If the caller reads `.copy(lerpColors(...))` then calls `lerpColors(...)` again before using the first result, the first result is corrupted. Looking at usage: `_apply()` calls `lerpColors` 4 times but each result is immediately `.copy()`'d into a light object before the next call. ✅ No aliasing issue within _apply.

**But what about external callers?** `lerpColors` is exported. If someone calls `const a = lerpColors(...)` and then `const b = lerpColors(...)`, `a === b === _tmpA` — both point to the same object. This is a documented Three.js pattern (Color.lerp etc.) but could surprise a naive caller.

**Verdict:** Add a JSDoc note that lerpColors returns a shared temp. Not a blocker — matches existing Three.js conventions.

**_tmpB is allocated but never used.** Leftover from the original IIFE. Dead code.

**Verdict:** Remove `_tmpB`. Minor cleanup.

### The Wiring Inspector

**Tracing the data flow:**

1. renderer.js creates lights in `initLights()` → stores in module-scope `sunLight`, `hemiLight`, `moonLight`, `nightAmbient`
2. renderer.js calls `DayNight.init({ sunLight, hemiLight, ... })` → daynight stores references
3. `await initTerrain()` creates `terrainMesh` → renderer.js calls `DayNight.setRef('terrainMesh', terrainMesh)`
4. Each frame: `DayNight.update()` → writes light properties, updates `dayMix`/`sunDir`
5. renderer.js reads `DayNight.sunDir` for sunLight positioning, `DayNight.dayMix` for bloom + interior glow
6. `updateCustomSky(t, DayNight.dayMix, DayNight.sunDir, camera.position)` passes values to sky dome

**Potential issue: ES module `export let dayMix` — can consumers read it?**

`import * as DayNight from './renderer_daynight.js'` creates a namespace object. `DayNight.dayMix` reads the live binding of the `export let`. This is correct per ES module spec — namespace properties are live bindings to the exported variable. When `_apply()` writes `dayMix = dm`, all consumers see the updated value immediately. ✅

**The `window.DayNight` bridge object uses getters:**
```js
get dayMix() { return dayMix; }
```
This correctly reads the module-scoped `dayMix` variable each time. ✅

**renderer_debug_panel.js calls `window.DayNight.freeze(12)` and `.unfreeze()`:**
These now call the module's exported `freeze()`/`unfreeze()` which correctly set `_frozen01`. Unlike the old IIFE where `this._frozen` and `_frozen01` were separate, the new module has a single `_frozen01` variable used by both freeze and update. **Bug REN-02 is fixed.** ✅

**HDRI callback still writes `scene.environmentIntensity = 1.45`:**
```js
scene.environmentIntensity = 1.45; // fixed — never dimmed by DayNight
```
Wait — this is in `loadHDRISky()` at renderer.js L364. The HDRI callback fires once, sets 1.45. Then DayNight.update() overwrites it every frame with `0.05 + 0.40 * dm`. The comment says "fixed — never dimmed by DayNight" but that's wrong. DayNight DOES overwrite it. This was flagged in lesson-learned #7 (HDRI/DayNight exposure race). The comment is stale but the behavior is correct — DayNight SHOULD own environmentIntensity.

**Verdict:** Remove or update the stale comment in renderer.js loadHDRISky. Not a functional issue.

### The Cartographer

**State ownership is clean:** DayNight owns all time-of-day light mutation. renderer.js owns light creation and sunLight positioning (offset from camera). No overlap.

**Missing state: `dawnDuskMix` was computed in the old IIFE but never used.** It's been correctly dropped from the new module. ✅

**Missing from dispose:** `_sunPos`, `_frozen01`, `_lastHour` are not reset. Not critical (they're primitives/vectors that don't hold GPU resources) but `dispose()` could be more thorough.

**Verdict:** Consider resetting `_frozen01 = null` in dispose for correctness. Minor.

---

## Pass 4 — System-Level Review

### Carmack

Clean extraction. The old IIFE-with-closure was a mess — `this._frozen` vs `_frozen01` was a real bug, and the implicit reliance on `sunLight`, `hemiLight`, `scene` etc. being in the outer scope of renderer.js was fragile. Passing refs via `init()` makes the dependency graph explicit.

The `setRef` pattern for deferred references (terrainMesh) is pragmatic. Better than making init() async or requiring a specific call order.

One concern: `_sunPos` is internal but `sunDir` is the exported copy. The copy happens in `_apply()` via `sunDir.copy(_sunPos)`. This means sunDir is always one frame behind when renderer.js reads it for sunLight positioning. In practice, the sun moves slowly enough that one frame of lag is invisible. No issue.

Performance: Pure math + 4 Color.lerps + 8 property writes per frame. Sub-microsecond. No concern.

### ryg (Renderer)

The cache bust `?v=179` on the import is correct. The `_tmpB` dead code should go — it's noise. The `lerpColors` name is fine but the shared-temp-return pattern should be documented.

Module load runs `performance.now()` and `URLSearchParams` at import time. This is fine for a browser-only module. If SSR ever becomes relevant, the `try/catch` on window.location handles it.

### Ive (Should This Exist?)

Yes. DayNight is a clear, self-contained system with a well-defined responsibility: drive scene lighting from a time-of-day curve. Extracting it reduces renderer.js complexity and makes the lighting authority explicit. The API surface is minimal: init, update, dispose, freeze/unfreeze, two read-only state exports.

The window.DayNight bridge is a reasonable compromise. It should be removed when debug panel migrates to ES modules, but for now it's correctly scoped.

### Muratori

The `setRef` switch-case is slightly over-engineered for two keys. I'd accept it because it prevents init() from needing to be async or re-called, but don't add more keys without rethinking the pattern.

The exported `dayMix` as a mutable `let` is a little unusual — most modules export getters or objects. But ES module live bindings handle it correctly, and it's the simplest possible approach. Don't complicate it.

---

## Issues Found

| # | Severity | Description | Fix |
|---|---|---|---|
| 1 | Minor | `_tmpB` allocated but never used — dead code | Remove line |
| 2 | Minor | `lerpColors` returns shared temp — undocumented for external callers | Add JSDoc note |
| 3 | Cosmetic | Stale comment in renderer.js loadHDRISky about environmentIntensity "never dimmed by DayNight" | Update comment |
| 4 | Cosmetic | `dispose()` doesn't reset `_frozen01` | Add `_frozen01 = null` to dispose |

**No blockers. No functional issues. Bug REN-02 (freeze/unfreeze) confirmed fixed.**

---

## Fix Application

All 4 issues are minor/cosmetic. Fixing now:
