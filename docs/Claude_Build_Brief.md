# Firewolf Live Editor: Build Brief for Claude

**Author:** The Director
**Target Branch:** `master`

Claude, your audit of the PCUI Editor Plan (`docs/Claude_Audit_Response.md`) was spot on. You correctly identified that porting a 200KB UI framework was overkill, that `TransformControls` is already vendored, and that a vanilla JS extension of the existing settings panel is the right path.

I agree with your "Recommended Scope for an Actual Phase 1." 

**You are now authorized to build it.**

## The Build Scope (Phase 1)

Do not use PCUI. Do not touch the post-processing stack or the animation editor yet. Focus entirely on the core tuning and map-editing loop.

### 1. The Vanilla JS Tuning Panel
Extend the existing `index.html` settings panel (or build a new, clean, collapsible overlay in vanilla HTML/CSS/JS) to expose the 5 most important WASM physics constants.
- **Target Variables:** Jetpack force, energy drain, gravity, ground friction, and player speed.
- **The Bridge:** Wire these sliders through the existing `setSettings()` JSON bridge so they update the C++ simulation live.

### 2. The "Save Defaults" Flow
Since the browser cannot write directly to `wasm_main.cpp`, build a "Save Tuning" button.
- **Action:** Clicking it generates a formatted JSON snippet (or C++ struct snippet) containing the current slider values.
- **Output:** Download it as a `.txt` or `.json` file (or copy to clipboard) so I can paste the finalized values back into the source code to lock them in.

### 3. Live Map Editing (TransformControls)
Wire the already-vendored `TransformControls.js` into the live game.
- **Action:** I need to be able to click on a building (generator, turret, station) in the live game, see the 3D gizmo, and drag it to a new location.
- **The Save Flow:** Add a "Save Map" button. Clicking it downloads a JSON file containing the updated X/Y/Z coordinates of all modified entities. (We will tackle the C++ WASM hot-reloading of this JSON in Phase 2; for now, just give me the tool to drag them and export the coordinates).

## Execution Rules

1. **Target `master`:** Do not build this on the `docs/pcui-editor-plan` branch. Build it directly on `master` (or a new feature branch off `master`).
2. **Keep it Boring:** Vanilla JS, zero new dependencies. 
3. **No Regressions:** Ensure the existing `settings-modal` (FOV, sensitivity, audio) continues to work.

Please confirm you understand the scope, and then begin writing the code for Phase 1.
