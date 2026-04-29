# Firewolf Editor: The Phased Delivery Roadmap

**Author:** Manus AI  
**Date:** 2026-04-29

This document locks in the strategic sequencing for the Firewolf Editor platform. The Director has authorized a phased approach to manage risk and prevent scope creep.

## The Strategy
We are building a full content-creation platform (tuning, level design, and visual playground). However, we are explicitly **not** handing the entire scope to the AI at once.

We will ship Phase A first to establish the baseline UI and prove the JSON bridge. Only after Phase A is merged and verified will we authorize Phase B, and then Phase C.

---

## Phase A: The Core Tuning Panel (Authorized)
**Status:** ✅ Complete (R32.273 — `client/editor_panel.js`)  
**Target Branch:** `master`

**Scope:**
1. Vanilla JS overlay extending the existing `settings-modal`.
2. Five sliders wired to `wasm_main.cpp` via `setSettings()`: Jetpack force, energy drain, gravity, ground friction, player speed.
3. "Save Tuning" button that downloads a JSON snippet.
4. `TransformControls` wired to buildings for live drag-to-move.
5. "Save Map" button that downloads a JSON of new coordinates.

**Exit Criteria:** The Director can tune physics live, drag a turret, and download the new values.

---

## Phase B: The Level Designer (Pending)
**Status:** Locked / Awaiting Phase A Completion  
**Target Branch:** `feature/level-editor` (Must branch from `master` *after* Phase A)

**Scope:**
1. **C++ JSON Loader:** Add `nlohmann/json` to WASM. Rewrite `initBuildings()` in `wasm_main.cpp` to read `raindance_layout.json` at startup instead of using hardcoded C++ arrays.
2. **Asset Palette:** Add a left-hand UI panel with thumbnails of placeable entities (turrets, generators, walls).
3. **Raycaster Placement:** Clicking a palette item and clicking the terrain drops the entity, using Three.js raycasting to snap it to the heightmap.
4. **Export:** The "Save Map" button from Phase A is upgraded to export the full, compliant `raindance_layout.json`.

**Exit Criteria:** The Director can build a completely new map layout from scratch using the UI, save it, and load it on game boot without recompiling C++.

---

## Phase C: The Visual Playground (Pending)
**Status:** Locked / Awaiting Phase B Completion  
**Target Branch:** `feature/post-fx`

**Scope:**
1. **Library Swap:** Replace Three.js `EffectComposer` with `pmndrs/postprocessing`.
2. **Preserve Bloom:** Re-implement the custom night-adaptive bloom on the new library.
3. **Effect Sliders:** Add a "Post-FX" tab to the editor with toggles and sliders for Chromatic Aberration, Glitch, SSAO, God Rays, and Depth of Field.
4. **Preset Saving:** Add export/import for visual profiles.

**Exit Criteria:** The Director can hot-swap rendering styles and save them as visual presets without breaking the core terrain shaders.
