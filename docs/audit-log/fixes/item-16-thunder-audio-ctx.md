# Item 16 — Route Thunder Through Main Audio Context

**Commit:** R32.168  
**Files changed:** `renderer_polish.js`, `index.html`  
**Lines changed:** ~15 net (removed AudioContext creation, routed through AE.ctx)  
**Review scale:** Small (Pass 1 + 4)

## What Changed

### renderer_polish.js
- `_playThunder()`: Replaced `_audioCtx = new AudioContext()` with `window.AE && window.AE.ctx`. If the main audio engine hasn't initialized yet, thunder silently no-ops (same as before when AudioContext creation failed).
- Removed `let _audioCtx = null` module variable — no longer needed.
- Updated `_initThunder()` comment to reflect new lazy behavior.
- Updated dead `_playFlagSting()` legacy code (after `return;`) to also reference `window.AE.ctx` instead of `_audioCtx`, preventing reference errors if ever re-enabled.

## Pass 1 — Structural Review (Carmack)

| Check | Status |
|-------|--------|
| No new AudioContext creation in polish module | ✅ Zero `new AudioContext` calls |
| Uses established main audio context | ✅ `window.AE.ctx` — same as all other audio in the game |
| Graceful fallback if AE not ready | ✅ `if (!ctx) return;` — thunder silently skipped |
| No behavior change for thunder sound | ✅ Same buffer, same filter chain, same gain, same destination |
| Dead _audioCtx state eliminated | ✅ Variable removed entirely |

**Verdict:** Clean one-to-one substitution. The thunder synthesis code is unchanged — only the AudioContext source is different.

## Pass 4 — Safety & Regression

| Risk | Assessment |
|------|------------|
| Thunder stops working | Low — AE.ctx is initialized on first user gesture (same trigger as gameplay start). Thunder only fires during active gameplay, so ctx will always exist. |
| iOS Safari AudioContext limit | ✅ FIXED — was the whole point. No second context created. |
| AE.ctx suspended state | Non-issue — AE already handles resume-on-gesture. Thunder fires during gameplay when context is running. |
| _playFlagSting broken | N/A — permanently disabled (returns immediately). Updated dead code as defensive measure. |
| Volume/routing change | None — both old and new path connect to `ctx.destination` with identical gain (0.45). |

**Verdict:** No regressions. iOS audio fixed. Module state simplified.

## Summary

Eliminated a second `AudioContext` in `renderer_polish.js` that violated iOS Safari's single-context limit (POL-02). Thunder now routes through `window.AE.ctx`, the game's main audio engine. Removed dead `_audioCtx` module variable.
