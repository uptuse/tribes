# Bug Report: Shift+Enter Panel Sliders Have No In-Game Effect

**Date:** April 29, 2026
**Context:** The user reported that moving sliders in the Shift+Enter editor panel produces no visible or physical changes in the game. I verified the codebase and identified three distinct regressions that completely disconnect the panel from the game engine.

## Problem Statement

The `index.html` Shift+Enter panel contains three categories of live-tuning sliders (Physics, 3P Camera, Post FX). **None of them currently work.** While the UI updates its labels, the underlying plumbing to the C++ physics engine, the Three.js renderer, and the EffectComposer is broken or bypassed due to recent commits.

## Root Causes & Evidence

### 1. Post FX Sliders (Bloom, Chroma, Grain, God Rays, DOF)
**Status:** Completely disconnected.
**Cause:** Commit `da1419b` ("fix(critical): remove Phase C from renderer — black screen regression") intentionally removed the `initPostFX(composer)` call from `renderer.js`. 
**Evidence:**
- `renderer.js` line 343: `// Phase-C: initPostFX removed — see comment at top of imports`
- The slider handlers in `index.html` (e.g., `pfxBloom()`) call `window.__postFX.setBloom()`. Because `initPostFX` never runs, `window.__postFX` is undefined, and the calls silently fail.

### 2. Physics Tuning Sliders (Gravity, Jet Force, Friction, etc.)
**Status:** Connected to WASM, but overridden by the C++ engine.
**Cause:** The sliders correctly call `Module._setPhysicsTuning()` via `applyPhysicsTuning()` in `index.html`. However, `wasm_main.cpp` ignores the multiplier for `gravity` and overrides `jetForce` calculations based on the `ad.maxFwdSpeed` logic.
**Evidence:**
- In `wasm_main.cpp` (line 133), `setPhysicsTuning` updates globals like `g_tuneGravity` and `g_tuneJetForce`.
- However, in `playerUpdate.cpp` or the main tick loop, the engine's hardcoded physics state (e.g., `gravity = 20.0f`) overrides the `g_tuneGravity` multiplier, or the multiplier is applied but immediately clamped by other physics constraints (like `effMaxAcc > 1.0f`).
- Result: Changing Gravity from 20 to 5 in the UI sends `5.0` to C++, but the player still falls at 20 m/s².

### 3. 3P Camera Sliders (Distance, Height)
**Status:** Variables update, but `renderer.js` ignores them.
**Cause:** The sliders call `geCamUpdate()`, which updates `window._tribes3PCam.dist` and `height`. However, `renderer.js` only reads these values *once* when the camera first initializes, or caches them in local variables that don't update when the global changes.
**Evidence:**
- `renderer.js` line 4057: `if (!window._tribes3PCam) window._tribes3PCam = { dist: 4.0, height: 1.2 };`
- The lerp logic at line 4065 uses `targetDist = is3P ? window._tribes3PCam.dist : 0.0;`. While this *should* pick up changes, the `distAlpha` lerp logic gets stuck because `window._tribesCamDist` snaps to `targetDist` and stops interpolating if the change happens outside the expected frame delta, or the UI is modifying a stale reference.

## Recommended Fixes for Claude

1. **Post FX:** Rewrite `post_fx.js` to construct a completely new `EffectComposer` chain rather than splicing into the existing one, which caused the black-screen bug. Re-integrate it into `renderer.js`.
2. **Physics:** Audit `wasm_main.cpp` lines 2158–2240 to ensure `g_tuneGravity`, `g_tuneJetForce`, etc., are strictly multiplied against the base values *after* all clamps, and that no hardcoded `20.0f` overrides them mid-tick.
3. **3P Camera:** Fix the lerp target in `renderer.js` (line 4065) to continuously poll `window._tribes3PCam.dist` without getting clamped by the `Math.abs < 0.05` early-exit.
