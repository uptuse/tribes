# Item 15 — Integrate ZoomFX RAF

**Commit:** R32.167  
**Files changed:** `renderer_zoom.js`, `renderer.js`, `.gitignore`, `index.html`  
**Lines changed:** ~10 net (RAF removal + tick insertion)  
**Review scale:** Small (Pass 1 + 4)

## What Changed

### renderer_zoom.js
- Removed self-driven `requestAnimationFrame` loop from `_boot()`. The function now only calls `_buildOverlay()` and `_bindInput()`.
- The `tick()` function remains unchanged — it was already designed as a callable update.

### renderer.js
- Added `window.ZoomFX.tick()` call inside the existing `if (window.ZoomFX)` guard block, immediately before reading `getFovMultiplier()` and `isActive()`.
- This ensures zoom state is fresh when FOV is computed each frame.

### .gitignore
- Added large model source files (`assets/models/source/*.zip`, `iron_wolf_juggernaut/`, `wolf_sentinel_full/`) to prevent GitHub 100MB limit rejections.

## Pass 1 — Structural Review (Carmack)

| Check | Status |
|-------|--------|
| Single RAF drives all animation | ✅ No `requestAnimationFrame` in zoom module |
| tick() called before FOV read | ✅ Placed inside existing guard, before `getFovMultiplier()` |
| No timing regression | ✅ `tick()` uses `performance.now()` internally — frame-rate independent |
| Guard present for missing module | ✅ Existing `if (window.ZoomFX)` wraps both tick and reads |
| No duplicate tick calls | ✅ Single call site in renderer.js |

**Verdict:** Clean. The zoom module was already designed with `tick()` as a callable entry point. Moving it from self-RAF to renderer's loop is the correct architectural pattern — one RAF, one frame budget.

## Pass 4 — Safety & Regression

| Risk | Assessment |
|------|------------|
| Zoom stops working | None — `tick()` is called every frame from the same loop that reads FOV |
| Double-tick if old code runs | None — RAF loop was deleted, not disabled |
| First-frame dt spike | None — `tick()` already handles null `lastT` with 16ms fallback |
| Module load order | Safe — `window.ZoomFX` guard means no crash if script loads late |
| Performance impact | Negligible — one function call + 3 multiplies per frame |

**Verdict:** No regressions. The change is purely architectural — same code runs in the same order, just driven from the right place.

## Summary

Eliminated a redundant `requestAnimationFrame` loop from `renderer_zoom.js`. All zoom animation is now driven from `renderer.js`'s single main loop, matching the established pattern used by rain, particles, polish, and all other per-frame systems.
