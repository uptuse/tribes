# Firewolf Toolchain Integration Plan

**Date:** April 29, 2026
**Target:** Main Game, Map Editor, Building Editor, Animation Editor
**Objective:** Reduce authoring friction for the dev team. Enable live, in-context testing of assets (buildings, maps, animations) without file-download roundtrips, repo commits, or WASM rebuilds in the inner loop.

---

## 1. The Core Problem

Right now, authoring in Firewolf requires context-switching between four isolated web surfaces:
- `index.html` (Main Game)
- `editor/index.html` (Map Editor)
- `editor/buildings.html` (Building Editor)
- `assets/models/animation_editor.html` (Animation NLE)

Because they are isolated, **you cannot see what you are building in the context of the game.** You design a building in a black void. You place props on a map without seeing the buildings. You tune an animation without seeing the weapon or the terrain. To test an asset, you must download a JSON file, move it to the repo, commit, wait for CI to rebuild the WASM data package, and refresh the game.

This is too slow. The objective is **live preview**.

---

## 2. Target Architecture: The Unified In-Game Shell

The solution is to deprecate the standalone `/editor/` HTML pages and move their functionality **inside the main game client**.

Firewolf will adopt a Unity/Godot-style architecture: there is only one `index.html`, one Three.js scene, and one `GLTFLoader`. The Shift+Enter panel becomes a **Mode Switcher**:

`[ Play | Edit Map | Edit Buildings | Edit Animations ]`

### How it works:
1. **Play Mode:** The default. WASM physics ticks, camera is locked to the first-person viewmodel, mouse is captured.
2. **Switch to Edit Mode:**
   - WASM physics tick is paused (`Module._pause(true)`).
   - The first-person camera detaches and becomes a free-flying `OrbitControls` or `MapControls` camera.
   - The relevant editor UI (DOM overlay) unhides.
   - You edit the *live scene graph*. If you add a wall piece, it appears immediately on the terrain.
3. **Switch to Play Mode:**
   - The editor UI hides.
   - The scene graph changes are serialized to JSON and hot-loaded into the WASM state.
   - Camera snaps back to first-person, physics resumes. You immediately ski through the building you just placed.

---

## 3. Execution Brief for Claude

This is a major architectural shift. We will execute it incrementally. **Do not attempt to merge all three editors at once.**

### Milestone 1: The Mode Switcher & Camera Detach
**Goal:** Prove we can pause the game, detach the camera, and fly around the frozen scene, then resume.

1. **Add the UI:** In `index.html`, add a mode-toggle radio group to the top of the Shift+Enter panel: `Play / Edit`.
2. **Pause the Engine:** When switching to `Edit`, set a JS flag `window.isEditing = true`. In `renderer.js`'s `render()` loop, skip the `Module._tick()` call if `isEditing` is true.
3. **Detach Camera:**
   - Import `OrbitControls` from `three/addons/controls/OrbitControls.js`.
   - On switch to `Edit`: unlock the pointer (`document.exitPointerLock()`), instantiate `OrbitControls` on the main `camera`, and set its target to the player's current position.
   - On switch to `Play`: dispose `OrbitControls`, request pointer lock, and snap the camera back to the player viewmodel.

### Milestone 2: Port the Building Editor
**Goal:** Bring the `buildings.html` UI and logic into the main game.

1. **Move DOM:** Copy the `#left-panel` (palette) and `#right-panel` (properties) from `buildings.html` into hidden `div`s in the main `index.html`.
2. **Move Logic:** Create a new `client/editor_buildings.js`. Port the piece-placement logic (raycasting against a grid, snapping, rotation) from the old editor.
3. **Live Context:** The building editor no longer needs to fetch `catalog.json` or `layouts.json` itself — the main game already loaded them during `initBuildings()`. When the user places a piece, append it directly to the live `THREE.Group` that holds the buildings.

### Milestone 3: Port the Map Editor
**Goal:** Bring the `editor/index.html` prop-placement logic into the main game.

1. **Move DOM:** Copy the toolbar and asset list into hidden `div`s in `index.html`.
2. **Move Logic:** Create `client/editor_map.js`. Port the terrain raycasting and prop instantiation.
3. **Live Context:** The map editor no longer needs to load the `raindance_heights.bin` or `canonical.json` — it just raycasts against the live `terrainMesh` the game already built.

### Milestone 4: Port the Animation Editor
**Goal:** Bring `assets/models/animation_editor.html` into the main game shell. Selecting a clip in the library loads its keyframes into the live player rig; edits apply immediately and playback previews on-character.

**Non-negotiable:** the existing animation editor must land in the final product — it is not optional, and it is not to be re-implemented from scratch. Absorb what is there.

1. **Open and profile the file first.** Before writing any code, read `assets/models/animation_editor.html` end to end and document: rendering stack (vanilla Three.js vs. something else), clip data format (JSON shape, bone naming convention, keyframe representation), how it loads the skeleton (GLTF, DTS, custom), and whether it uses `THREE.AnimationMixer` or a hand-rolled interpolator. Note the result in a comment at the top of the new `client/editor_animations.js`.
2. **Decide integration path based on step 1:**
   - *If the editor is vanilla Three.js and uses `AnimationMixer`:* port the DOM (timeline, clip library, keyframe scrubber) into hidden `div`s in `index.html`, and port the logic into `client/editor_animations.js` the same way the map and building editors were ported. The editor will drive the live player rig directly — no separate scene.
   - *If the editor uses a different rendering stack or a bespoke skeleton loader:* build a thin adapter layer. The adapter must translate clip data from the editor's internal format into `THREE.AnimationClip` objects that the main game's `AnimationMixer` can play, and round-trip edits back. Do not replace the editor's UI; only bridge its data.
   - *If the editor is incompatible enough that neither path is tractable in reasonable time:* stop and flag this explicitly before continuing — do not silently reimplement.
3. **Live context:** the animation editor no longer needs its own skeleton file or scene — it drives the main game's live player rig. The game pauses physics on mode entry (same as other editors) but keeps the character rendered so edits are visible against the actual terrain and lighting.
4. **Clip library maps action to animation:** the clip list is the action vocabulary (IDLE, RUN, SKI, JET, FIRE_DISC, DEATH, etc.). Selecting a clip loads its keyframes into the scrubber; editing commits back to the clip's JSON on save. This is the editor's source of truth for what the game plays when it asks the character to do an action.
5. **Hot-reload:** on switch back to Play, the modified clip map is handed to the main `AnimationMixer` so the next invocation of that action plays the edited motion immediately, without a rebuild.

### Milestone 5: Hot-Reloading WASM State
**Goal:** When switching from Edit back to Play, the C++ engine needs to know about the new walls/props so collision works.

1. **Serialize:** On switch to Play, `editor_buildings.js` generates a new `layouts.json` string from the live scene graph.
2. **Hot-Load:** We need a new C++ function `Module._reloadBuildings(jsonPtr, jsonLen)`. The JS side allocates memory, writes the JSON string, and calls the C++ function. C++ clears its Rapier colliders and rebuilds them from the new JSON.

---

## 4. Why this is better than the Phase 1 "localStorage" bridge

My previous plan proposed using `localStorage` to pass JSON strings between the separate HTML pages. That was a band-aid. It still required you to have multiple tabs open, and you still couldn't see the terrain while editing a building.

By moving the editors *into the game client*, you get true WYSIWYG (What You See Is What You Get). You design the building sitting exactly on the hill where it will live, under the exact lighting conditions of the map.
