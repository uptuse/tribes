# Item 30 — Cap Decal System at 48 Visible: Cohort Review

**Commit:** R32.177 (`afda7ee`)
**Scope:** renderer_polish.js — decal subsystem (47 lines added, ~10 lines changed)
**Review level:** Pass 1 (Break It) + Pass 4 (System-Level)

---

## Pass 1 — Break It (Saboteur / Wiring Inspector)

### The Saboteur

**S1: _applyDecalFade() runs on every placeDecal() AND every tick() — double update (Low)**
When `placeDecal()` adds a new decal, it calls `_applyDecalFade()`. Then on the next frame, `_tickDecals()` also calls `_applyDecalFade()`. The first call is redundant — a single frame can't produce visible age change. However, it ensures the newly-placed decal's fade is applied immediately (correct for the position-based fade). Cost is negligible (~48 opacity writes at worst). Acceptable.

**S2: `performance.now()` called 3 times per tick (per-decal age check + twice in fade) — micro-optimization opportunity (Negligible)**
Could hoist to a single `const now` at the top. Already done in `_tickDecals()` but `_applyDecalFade()` gets its own `now`. At 48 decals max, this is nanoseconds. Not worth the code churn.

**S3: Each decal still creates a new MeshBasicMaterial instance (Pre-existing)**
This was in the original code and not part of the scope of this fix. A shared material would be better for batching, but requires opacity-per-instance via vertex color alpha or uniform array, which is a bigger refactor. Noted but not a regression.

**S4: Position-fade math verified**
When count = 48 (full), DECAL_FADE_START = 32:
- Decal index 0 (oldest): `fadeRange = 16`, `fadeIdx = 16`, `posFade = 0.0` ✅ (fully faded)
- Decal index 15: `fadeRange = 16`, `fadeIdx = 1`, `posFade = 0.9375` ✅ (nearly visible)
- Decal index 16: `i >= count - DECAL_FADE_START`, position condition not met → `posFade = 1.0` ✅
- Decal index 47 (newest): `posFade = 1.0` ✅
Math checks out. Oldest decals fade first, newest stay opaque.

**S5: Age-fade math verified**
- At 0s: `ageFade = 1.0` ✅
- At 14.9s: `ageFade = 1.0` (under half lifetime) ✅
- At 15s: `ageFade = 1.0` (exactly half) ✅
- At 22.5s: `ageFade = 0.5` ✅
- At 30s: `ageFade = 0.0` ✅
- At 31s: fully expired, removed by `_tickDecals()` ✅

**S6: Dispose correctness verified**
Both `_tickDecals()` and the LRU cleanup in `placeDecal()` call `geometry.dispose()` + `material.dispose()` + `scene.remove()`. No GPU memory leak. ✅

### The Wiring Inspector

**W1: _tickDecals() guard is correct**
`if (!_decals || _decals.active.length === 0) return;` — safe on low quality (where `_decals` is null) and when no decals exist. ✅

**W2: `tick()` now calls `_tickDecals()` unconditionally**
The function has its own null guard, so this is safe. No performance cost when decals are disabled or empty. ✅

**W3: No new window.* globals introduced** ✅
**W4: No new imports added** ✅
**W5: Constants are module-scoped (not exported)** — correct, these are internal implementation details ✅

---

## Pass 4 — System-Level Review

**Dependencies unchanged.** The decal system is self-contained within renderer_polish.js. It reads from `_ctx.scene` (the Three.js scene) and `_fxLevel` (quality tier). No new dependencies introduced.

**Interface contract unchanged.** `placeDecal()` export signature is identical. `_initDecals()` internal API unchanged. No callers need modification.

**Performance impact:**
- Draw call budget reduced from 256 → 48 max (5.3x reduction at peak)
- New per-frame cost: `_tickDecals()` iterates up to 48 decals, checking age + computing fade opacity. At 48 iterations with simple arithmetic, this is sub-0.01ms. Negligible vs the 16.6ms frame budget.
- Memory: 48 × (DecalGeometry + MeshBasicMaterial + mesh) vs 256 × same. Significant reduction in peak GPU memory allocation for decal geometry.

**Quality tier behavior:**
- Low: disabled (unchanged) ✅
- Medium: 32 cap (was 128) — 4x reduction ✅
- High: 48 cap (was 256) — 5.3x reduction ✅

**"Should this exist?" test:** Decals serve Aliveness — "a fight happened here." 48 is well above perceptual relevance (the panel consensus was that past 30-40 visible, decals become texture noise). The 30s lifetime with 15s fade ensures decals feel transient and alive, not permanent and cluttering.

**Verdict:** PASS. Clean implementation. Budget dramatically reduced. No regressions. Fade math is correct. Dispose lifecycle is clean.

---

*Review complete. Both items (29 + 30) delivered.*
