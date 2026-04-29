# Evaluation Report — Phase C (Visual Playground / Post-FX)

**Author:** Manus AI
**Date:** 2026-04-29
**Commit evaluated:** `aea2572` — *feat(phase-c): Visual Playground — post-FX tab in Shift+Enter editor*
**Grade:** A−

## Summary

Claude delivered Phase C as a single 309-line module, `client/post_fx.js`, plus minimal wiring in `renderer.js`, `index.html`, and `shell.html`. The module adds a Post-FX tab to the Shift+Enter editor exposing chromatic aberration, grain, god rays, depth-of-field, glitch, and bloom, and implements preset save/load/export/import against `localStorage`. The delivery follows the Phase C scope exactly, adds no new dependencies, and — critically — does not break the night-adaptive bloom logic that was flagged as a risk in the planning docs.

## Night-Adaptive Bloom: Preserved

The night-adaptive bloom routine at `renderer.js:5060–5070` continues to own the `bloomPass.enabled`, `bloomPass.strength`, and `bloomPass.threshold` fields every frame, driven by `DayNight.dayMix`. The Phase C module exposes a `setBloom()` function that writes to the same `window.__tribesBloom` reference, but it is only called from user actions in the editor UI and from `_applyState()` during `loadPreset` / `importPreset` / `resetPreset`. It is not called from `tickPostFX()`, which is the only Phase C function invoked per-frame. This means the render-loop order is:

1. `DayNight.update()` updates `dayMix`.
2. The night-adaptive block overwrites `bloomPass.strength`, `.enabled`, and `.threshold` based on `dayMix`.
3. `PostFX.tickPostFX(t)` runs but only updates the custom VFX shader pass (`uTime`, `uResolution`) — it does not touch bloom.
4. `composer.render()` draws the frame.

Because step 2 runs after any user slider change and step 3 does not touch bloom, the night adaptation is effectively authoritative during gameplay. The one edge case worth noting is that if a user has previously saved a `tribes_postfx` preset with bloom disabled and then reloads, `loadPreset()` will run at init and set `bloomPass.enabled = false` — but the very next frame's night-adaptive block will flip it back on if it is night. So the user-facing preset value for bloom is effectively ignored in practice. This is acceptable but is a UX quirk worth documenting: a "bloom off" preset will not actually disable bloom at night.

**Recommendation:** In a future pass, either gate the night-adaptive block on a "respect user bloom toggle" flag, or remove the bloom controls from the preset entirely and treat it as cycle-driven only. No action required for Phase C.

## Strengths

The module is clean vanilla-JS ES module code consistent with the house style, with no framework surface area added. The preset system is well-scoped: save/load from `localStorage`, export/import via JSON blob, reset to defaults. The UI injection into `index.html` as a third tab alongside Physics and Level keeps the Shift+Enter editor coherent. The guard pattern around `tickPostFX` (early return if `_vfxPass` is missing or disabled) keeps the render loop safe even if the post-FX composer chain fails to initialize.

## Weaknesses

The controls for godRays, DOF, and glitch bolt onto a shared custom shader pass (`_vfxPass`) that was added alongside `post_fx.js`; the shader itself is not trivial to audit from the commit summary alone and has not been visually tested at this evaluation pass. In the Director's next playtest, it is worth specifically toggling each effect on its own (one at a time) to confirm they compose correctly without clashing with the warm grading pass that `renderer.js` already owns.

The `_bloomRef` lazy-resolution pattern (`if (!_bloomRef) _bloomRef = window.__tribesBloom;`) is defensive but slightly fragile — if `window.__tribesBloom` ever gets reassigned during a hot-reload, the Phase C module will hold a stale reference. Not a Phase-C bug, but worth noting as a class of issue to watch for across the editor modules.

## Verdict

Phase C ships the feature, preserves the night-adaptive bloom, and keeps the house style. The one real concern — that user bloom presets are silently overridden at night — is a UX wart, not a regression, and is acceptable for the current iteration. **Grade: A−.** Recommend proceeding to the camera spec and the 1P/3P orbital rework without blocking on further Phase C polish.
