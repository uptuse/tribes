# Firewolf Toolchain Integration Plan

**Date:** April 30, 2026 (revised)
**Target:** Main Game, Map Editor, Building Editor, Animation Editor, Tuning, Triggers, Materials, Audio, VFX, AI
**Objective:** Reduce authoring friction for the dev team. Enable live, in-context testing of *every* authored domain (buildings, maps, animations, tuning, triggers, materials, audio, VFX, AI) without file-download roundtrips, repo commits, or WASM rebuilds in the inner loop.

> **Revision note (Apr 30):** the original plan covered four editor surfaces. This revision expands the scope to **twelve** modes total, drawn from the sketch-fidelity prototype at `firewolf_shell_sim` (the unified-shell interaction reference) plus a twelfth **EDIT · BINDINGS** mode added to keep effect/sound/event authoring out of code. The extra modes are folded into the same architecture, not added as separate surfaces. See **Section 5** for the new invariants, **Milestone 6** for the per-domain port plan, **Section 8** for the cross-cutting editor primitives (undo/redo, save-as, layers, snap, multi-select, camera bookmarks, playtest-from-cursor), and **Section 9** for the asset-upload flow.

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

Firewolf will adopt a Unity/Godot-style architecture: there is only one `index.html`, one Three.js scene, one `GLTFLoader`, one `AnimationMixer`, and one WASM physics module. The Shift+Enter panel becomes a **Mode Switcher**:

`[ Play | Edit · Assets | Edit · Buildings | Edit · Animations | Edit · Terrain | Edit · Tuning | Edit · Triggers | Edit · Materials | Edit · Audio | Edit · VFX | Edit · AI | Edit · Bindings ]`

> **Naming note:** what was previously called *Edit Map* is renamed *Edit · Assets* throughout the codebase, the panel, and the docs. The word *map* is reserved for the level / terrain itself; *assets* is the correct word for the props (turrets, generators, flags, spawns, sensors) being placed on it.

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

---

## 5. Invariants for the Eleven-Mode Shell

These constraints apply to **every** mode added in Milestone 6 below. They are not negotiable, because violating any one of them re-introduces the multi-surface drift that this plan exists to kill.

### 5.1 One scene graph, one camera rig, one frame budget

There is exactly one `THREE.Scene`, one `WebGLRenderer`, and two cameras (a first-person `PerspectiveCamera` parented to the player, and an orbit camera at the scene root). Every mode reads from and writes to the same scene graph. No mode is allowed to instantiate a second `WebGLRenderer`, a second `Scene`, or its own offscreen canvas. If a mode needs a swatch preview or a thumbnail, render it on the *same* renderer into a `WebGLRenderTarget` and copy the result into a DOM `<canvas>` via `toDataURL()`.

### 5.2 One `three` dependency, version-pinned

The entire client must import from a single resolved `three` package (and a single matching `three/examples/jsm`). This is enforced today by `vendor/three/` and the pin documented in `docs/audit-log/fixes/item-29-pin-threejs.md` — it is now also a hard requirement for any new editor module. Concretely:

- No editor file may add a different `three` version to its dependency tree, even transitively.
- No editor file may `import * as THREE from "https://..."` from a CDN.
- The shared `THREE` namespace is the *only* way to construct geometry, materials, lights, raycasters, and animation primitives. If an editor needs a class not yet exposed (e.g. `RingGeometry`, `LineSegments2`), import it from the same pinned `three/examples/jsm/...` path the rest of the codebase uses.

**Why:** two copies of `three` produce two copies of every internal class, which means an editor's `Mesh` instance silently fails an `instanceof THREE.Mesh` check in the renderer. We have hit this before and we will not hit it again.

### 5.3 One asset loader, one cache

GLTFs, textures, and audio buffers are loaded by the shared `loaders/AssetCache.ts`. An editor that needs to preview an unsaved asset receives a `Blob` URL from the same cache and disposes of it on mode exit. No editor may construct its own `GLTFLoader`, `TextureLoader`, or `AudioContext`.

### 5.4 Pause / resume contract

Every non-`play` mode pauses the WASM physics tick on entry and resumes it on exit (`Module._pause(true|false)`). A mode that wants visual updates while paused (e.g. EDIT · ANIMATIONS scrubbing the rig) drives them from the JS side via `AnimationMixer.update(dt)` — it does not poke physics state.

### 5.5 Hot-reload is the only commit path

A mode never writes directly to the on-disk asset files. On exit it serializes its diff into a JSON string and calls a small set of WASM hot-reload entry points (extended in Milestone 6.7). The agent of record for persisting that JSON to the repo is the existing autosave watcher — not the editor module.

### 5.6 UI vocabulary — copy the prototype verbatim

The interaction prototype `firewolf_shell_sim` is the **visual + interaction spec**, not a sketch to reinterpret. Claude must copy it verbatim. Concretely, this means:

- **Palette DOM** (left rail width, header label row, action footer row, the order of sliders/lists/buttons inside each palette) is lifted as-is from `firewolf_shell_sim/client/src/components/shell/*Palette.tsx` into the production client's vanilla DOM overlays.
- **Colors** are the prototype's CSS variables (`--amber`, `--teal`, `--hairline`, `--ink-dim`, `--bg`); copy them into the production client's `index.css` unchanged. Amber is for active state only; teal is for live numerics; nothing else gets either color.
- **Typography** is the prototype's pairing: a tech-label uppercase 10px stack for headers and a monospace stack with tabular numerics for any value that changes at tick rate. Do not substitute fonts.
- **Spacing and borders** are the prototype's hairline-on-dark aesthetic. No drop shadows, no rounded corners larger than the prototype's `rounded-sm`, no glassmorphism beyond the prototype's `panel-glass` class.
- **Keybindings** match the prototype's `HelpOverlay` exactly: Shift+Enter opens/closes the panel; H toggles help; R rotates the ghost piece in EDIT · BUILDINGS; L-click is the place/select primary; R-drag orbits in edit modes; Esc releases pointer lock. Add new bindings only with explicit sign-off.
- **Mode-switcher grid** is two rows of six tiles, in the order listed in Section 2. The active tile gets an amber 2px left border; inactive tiles get hairline borders.
- **Log console** sits bottom-left, mission-console style, mono, with the same `[hh:mm:ss] EVENT_NAME | EVENT_NAME` line format the prototype uses for mode changes and placements.

If an implementation choice ever forces a tradeoff between matching the prototype and matching some other UI library's defaults, match the prototype. Claude is not allowed to redesign these surfaces.

---

## 6. Execution Brief for Claude (continued) — Milestone 6: The Six New Domains

Milestone 6 ports the six additional editor modes from the sketch-fidelity prototype into the real game client. Each sub-milestone is independent; ship them in order, but feel free to land them as separate PRs.

**Reference implementation for all six:** `firewolf_shell_sim/client/src/components/shell/` — each `*Palette.tsx` already shows the intended layout, the store contract, and the per-mode click semantics. Treat that prototype as the visual + interaction spec; the production version replaces the React-on-three abstraction with the same vanilla DOM-overlay pattern used by the other editors.

### 6.1 EDIT · TUNING

**Goal:** Live game-balance authoring. Sliders for weapon damage, respawn time, armor HP, jet force, gravity, energy drain, match length, and flag-return time, with numeric readouts and a Reset.

1. **Source of truth:** all tuning lives in `data/tuning.json`, loaded by C++ on boot. Move the loader behind a small accessor (`Tuning::getF32("weapon_dmg")`) so the JS side can patch it.
2. **DOM:** port `TuningPalette.tsx` into a hidden `#tuning-palette` `div` in `index.html`.
3. **Hot-reload:** wire `Module._patchTuning(keyPtr, value)` for cheap live edits, and `Module._reloadTuning(jsonPtr, len)` for a full Reset round-trip.
4. **Persistence:** on exit, write the diff back to `data/tuning.json` via the autosave watcher.

### 6.2 EDIT · TRIGGERS

**Goal:** Region-based event authoring. Click the terrain to drop a region; the region's kind is one of `on_flag_enter`, `on_region_enter`, `on_timer`, `on_death`.

1. **Scene:** triggers render as a flat ground ring + a thin stake (see `buildTriggerMesh` in the prototype `scene.ts`). Color-coded per kind.
2. **Storage:** triggers live in `client/maps/<map>/triggers.json` alongside `layouts.json`. Schema: `{id, kind, x, z, radius, label, target?}`.
3. **Runtime:** the C++ engine gets a new `TriggerSystem` that, every tick, tests entity positions against the loaded ring set. On entry, it dispatches a script event by name; the script binding is out of scope for this milestone (it can log only).
4. **Hot-reload:** `Module._reloadTriggers(jsonPtr, len)`.

### 6.3 EDIT · MATERIALS

**Goal:** Per-piece material assignment for placed buildings. A swatch grid (steel / plate / glow / matte / copper / ice, plus user-added) and click-to-tint the building piece under the cursor.

1. **Scene:** the materials palette mutates the `MeshStandardMaterial` on the picked piece directly (color + roughness). The diff is recorded as `pieceTintOverride: Map<pieceId, materialId>`.
2. **Storage:** the override map is appended to `layouts.json` under a new `material_overrides` field. A piece without an override falls back to its kind's default material.
3. **Hot-reload:** since materials are JS-only, no C++ change is required — the next `_reloadBuildings(...)` call just rebuilds the visual side; physics is unaffected.

### 6.4 EDIT · AUDIO

**Goal:** Sound-event authoring. A list of named events (`WPN_FIRE_DISC`, `EXPL_MORTAR`, etc.) with volume / pitch / falloff sliders and per-row preview.

1. **Audio engine:** the existing audio code (see `docs/audit-log/fixes/item-16-thunder-audio-ctx.md`) already centralizes a single `AudioContext`. Extend it with `AudioBank.preview(eventId, volume, pitch)` which plays the existing buffer with the given gain + playbackRate.
2. **DOM:** port `AudioPalette.tsx`. The slider triple (volume / pitch / falloff) writes back to `data/audio_events.json` and to the live `AudioBank` cache.
3. **Hot-reload:** because the audio bank is JS-side, mode exit just calls `AudioBank.applyDiff(...)`. No WASM involvement.
4. **Spatial preview (stretch):** in PLAY mode, scale the preview gain by the player's distance to the listener stake; the prototype's `falloff` slider drives this curve.

### 6.5 EDIT · VFX

**Goal:** Particle preset authoring. A picker for muzzle / explosion / impact / trail; click the terrain to spawn an instance using the active preset.

1. **Scene:** the production version replaces the prototype's quick ring+core with the existing GPU-particle path. The palette only chooses the preset; the spawn call is `VFX.spawn(presetId, vec3)`.
2. **Storage:** preset definitions live in `data/vfx_presets.json`. The palette edits the preset (size, color, lifetime) once we expose those sliders — the prototype only ships the picker; the slider triplet is a follow-up.
3. **Hot-reload:** preset edits go through `VFX.reloadPresets(json)`. Spawned instances always use the current preset, so a live-edit shows up the next time the user clicks.

### 6.6 EDIT · AI

**Goal:** Bot placement and behavior assignment. Drop a bot with a behavior (`patrol`, `guard`, `flag_capture`); the bot wanders on a per-behavior radius / speed.

1. **Scene:** bots are full game entities, not editor-only meshes. The palette calls `Module._spawnBot(behaviorId, x, z)` directly; the C++ side instantiates the entity and the renderer picks it up via the existing entity sync.
2. **Behavior data:** behaviors are referenced by id; the actual BT/HSM definitions live in `data/ai/<behavior>.bt.json`. The palette also surfaces a small read-only sketch of the BT (see `GRAPHS` in `AIPalette.tsx`) so the operator knows what they're dropping.
3. **Persistence:** placed bots get serialized into `client/maps/<map>/bots.json`.
4. **Hot-reload:** `Module._reloadBots(jsonPtr, len)` rebuilds the bot list. Existing bots get destroyed and re-spawned; this is acceptable because edits happen at design time.

### 6.7 EDIT · BINDINGS (the twelfth mode)

**Goal:** Author what happens when an event fires on an asset — entirely without code. This is the mode that turns the rest of the system into a designer tool instead of a programmer tool.

**The mental model the operator sees:** a left list of named **events** (e.g. `disc_launcher.on_fire`, `disc_launcher.on_impact`, `chaingun.on_fire`, `player.on_footstep_grass`, `flag.on_capture`). Click an event → a center inspector shows a stack of **reaction tiles**. Drag a VFX preset tile (from EDIT · VFX) and/or an audio event tile (from EDIT · AUDIO) into the stack and they fire when the event fires. Each tile has a `delay_ms` knob and a `loop` toggle. That's the entire surface.

**Where placement comes from — hidden from the operator:** when an asset is imported, Claude's importer scans the GLB scene graph for nodes named `muzzle*`, `eject*`, `socket_*`, `attach_*` and registers them as the asset's sockets automatically. The binding row stores a socket id; the operator never types one. If a tile's effect needs a socket the asset doesn't have, the inspector greys it out and shows a one-line hint ("this gun has no `eject` socket"). No socket-picker UI is ever shown unless the operator explicitly opens an Advanced disclosure.

**Animation-driven events come for free:** the importer also reads any `AnimationClip` events embedded in the GLB (the standard glTF `KHR_animation_pointer` / Blender notify export) and registers each one as `<asset>.<clip>.on_<eventname>`. So a `fire_disc` clip with an `on_muzzle` keyframe at frame 4 produces an authorable event the operator can bind to without touching the timeline.

1. **Storage:** all bindings live in one file, `data/bindings.json`. Schema: `[{event_id, reactions: [{kind: "vfx"|"audio", preset_id, socket?, delay_ms, loop}]}]`. One file because designers reason about "what does the disc launcher do?" not "what's in this scene?"
2. **Runtime:** a tiny JS-side `BindingsBus` subscribes to engine + animation events, looks up the matching binding row, and calls the existing `VFX.spawn(...)` / `AudioBank.play(...)` paths. No C++ changes; the C++ side just emits event names through the existing event channel.
3. **Hot-reload:** mode exit calls `BindingsBus.reload(json)`. Cheap, JS-only, no rebuild.
4. **Live preview:** the inspector has a Test button that fires the event in-scene with the current binding stack so the operator hears + sees the result without entering PLAY.

### 6.8 Hot-reload entry points (consolidated)

The full set of WASM entry points required by Milestone 6 is:

| Entry point | Used by | Notes |
|---|---|---|
| `Module._patchTuning(keyPtr, value)` | EDIT · TUNING | per-key edit, no rebuild |
| `Module._reloadTuning(jsonPtr, len)` | EDIT · TUNING | full Reset |
| `Module._reloadTriggers(jsonPtr, len)` | EDIT · TRIGGERS | replaces the trigger set |
| `Module._reloadBuildings(jsonPtr, len)` | EDIT · BUILDINGS, EDIT · MATERIALS | already planned in M5 |
| `Module._reloadBots(jsonPtr, len)` | EDIT · AI | destroys + respawns bots |
| `Module._spawnBot(behaviorId, x, z)` | EDIT · AI | one-off drop |
| `Module._teleportPlayer(x, y, z)` | Playtest-from-cursor (§8.7) | spawn the player at the cursor on PLAY |

EDIT · MATERIALS, EDIT · AUDIO, EDIT · VFX, and EDIT · BINDINGS do not need new C++ entry points beyond the table above — they live entirely on the JS side.

### 6.9 Order of operations for Milestone 6

Land 6.1 first (Tuning) because it is the cheapest end-to-end demonstration of the new hot-reload pattern. Then 6.3 (Materials) because it's JS-only and proves the pattern without WASM changes. Then 6.2 (Triggers), 6.5 (VFX), 6.4 (Audio), 6.6 (AI), and finally 6.7 (Bindings), which depends on VFX + Audio + asset socket import all being in place.

---

## 7. Definition of Done

The Milestone 6 + Section 8 + Section 9 work is done when:

1. The Shift+Enter panel surfaces all twelve modes in the order listed in Section 2.
2. Switching to any of the seven new modes pauses physics, swaps the camera, and shows the corresponding palette without a page reload.
3. Each mode's edits round-trip through the appropriate hot-reload entry point and survive a switch back to PLAY *and* a full page refresh (i.e. the autosave watcher has written them to disk).
4. There is exactly one resolved `three` package in the client bundle (verified via `pnpm why three`).
5. There is exactly one `WebGLRenderer` and one `Scene` in the running client (verified via the existing devtools probe in `docs/audit-log/fixes/item-39-system-map-index.md`).
6. The interaction prototype `firewolf_shell_sim` and the production client agree on every mode label, every palette layout, and every keybinding documented in the prototype's `HelpOverlay`.
7. **Cross-cutting primitives (Section 8) all work:** Ctrl+Z / Ctrl+Shift+Z undo and redo any edit in any mode; the File menu offers Save, Save As, and Open; the Layers panel can hide and lock any category; Snap toggles (G for grid, Shift to suppress) work in EDIT · BUILDINGS, EDIT · ASSETS, and EDIT · TRIGGERS; box-select and Ctrl-click multi-select work with group delete and group move; F1–F4 set/recall camera bookmarks; Shift+P from any edit mode teleports the player to the cursor and enters PLAY.
8. **Asset upload (Section 9) works:** dropping a `.glb`, `.png`, `.ktx2`, `.wav`, or `.ogg` onto the relevant palette uploads it to the repo via the dev server, the autosave watcher commits and pushes it, and a teammate who pulls the latest sees the new asset on next boot without any manual step.
9. **EDIT · BINDINGS works end-to-end:** importing a GLB with named sockets and clip events auto-registers them; dragging a VFX or audio tile onto an event in the inspector causes the effect to fire on next event dispatch; the Test button reproduces the result without entering PLAY.

---

## 8. Cross-cutting Editor Primitives

These are not modes — they are behaviors that every mode inherits. Implement them once in shared infrastructure, not per-palette. They land alongside Milestone 6 and are part of the Definition of Done.

### 8.1 Undo / redo (global stack)

Every state mutation in any mode goes through a single `History` service that records `{ apply: () => void, revert: () => void, label: string }` entries. `Ctrl+Z` reverts the last entry; `Ctrl+Shift+Z` re-applies it. The stack is unbounded for the session and is cleared on map switch. The terrain editor's existing per-stroke undo (see `setTerrainUndoDepth` in the prototype's store) becomes a special case of this same stack — not a parallel one.

*Why one stack, not per-mode:* operators frequently undo across modes ("I placed a wall, then in TRIGGERS I added a region, now I want to undo the region without touching the wall" — fine; "I want to undo the wall after switching modes" — also fine).

### 8.2 Save, Save As, Open (named scenes)

A small File menu in the top bar with three actions:

- **Save** (Ctrl+S): autosave is already continuous, so this is a no-op confirmation that flashes "saved" in the log.
- **Save As…** (Ctrl+Shift+S): prompts for a new map id, copies the current `client/maps/<map>/` directory tree under the new id, switches the editor to it, and tells the autosave watcher to track the new path.
- **Open…** (Ctrl+O): lists every `client/maps/<*>/` and lets the operator switch. Switching writes the current map first.

### 8.3 Hide / lock layers

A small Layers panel (collapsible, top-right) lists each entity category (Terrain, Buildings, Assets, Triggers, Bots, VFX, Audio listeners) with two toggles per row: a **visibility** eye and an **edit-lock** padlock. Hidden categories are not rendered; locked categories cannot be picked, moved, or deleted. State is per-map and persists in the map's `editor_state.json`.

### 8.4 Snap toggle (universal, defaults ON)

A single global snap state with three knobs: **grid size** (default 1m), **rotation step** (default 15°), and **mode** (`grid` | `vertex` | `surface_normal`). Holding **Shift** while placing or dragging temporarily suppresses snap for unique angles. Pressing **G** cycles snap mode. The snap state is shown in the top bar and applies to EDIT · BUILDINGS, EDIT · ASSETS, and EDIT · TRIGGERS uniformly. The prototype's per-mode snap (today only buildings snap to a grid) is replaced by this single service.

*Why this matters:* snapping is the single biggest authoring-speed win. Default it ON, make Shift the universal escape hatch, and everything else flows from there.

### 8.5 Multi-select + group operations

Left-drag on empty space draws a selection box; **Ctrl+click** adds/removes individual entities from the selection. Selected entities get an amber outline. The available group operations are:

- **Delete** (Del / Backspace): removes all selected entities, one undo step.
- **Move** (drag the selection): translates the whole group along the cursor delta, snap-aware.
- **Rotate** (R while selection is active): rotates around the group's centroid in `rotation_step` increments.
- **Duplicate** (Ctrl+D): clones the selection at a small offset.

Multi-select works within a single mode at a time — you can box-select 12 walls in EDIT · BUILDINGS or 8 triggers in EDIT · TRIGGERS, but not a mix.

### 8.6 Camera bookmarks

**Shift+F1** through **Shift+F4** save the current edit-camera position + rotation + zoom into one of four slots. **F1–F4** recalls the corresponding slot with a 250ms ease. Bookmarks persist per-map in `editor_state.json` so the operator's preferred views survive across sessions. The top bar shows four small numbered tiles indicating which slots are filled.

### 8.7 Playtest-from-cursor

From any edit mode, **Shift+P** does the following in one motion: switches to PLAY, calls `Module._teleportPlayer(cursor.x, cursor.y + 2, cursor.z)`, requests pointer lock. The result is that the operator can place a wall, hit Shift+P, and immediately ski past it from the exact spot they were inspecting. This is the single biggest authoring-loop accelerator in the entire plan.

### 8.8 Where these live in code

All seven primitives are implemented in `client/editor_core/` as services consumed by every palette: `History.ts`, `MapManager.ts`, `Layers.ts`, `Snap.ts`, `Selection.ts`, `CameraBookmarks.ts`, `Playtest.ts`. Each palette imports the services it needs; no palette implements its own undo, snap, or selection logic.

---

## 9. Asset Upload Flow (drag-drop → GitHub)

Direct upload of `.glb`, `.gltf`, `.png`, `.jpg`, `.ktx2`, `.wav`, `.ogg`, `.mp3` into the relevant palette. The operator never opens a file manager and never touches the repo by hand.

### 9.1 Operator-facing behavior

Each palette that consumes assets (EDIT · ASSETS, EDIT · AUDIO, EDIT · VFX, EDIT · BINDINGS for new asset imports) gets a drop-target footer. Drop a file on it; within ~2 seconds it appears in the palette's library and is usable in-scene. A small toast at the bottom right shows upload progress, then "committed to `assets/uploads/<filename>` as `<short hash>`". Failures (file too big, unsupported format) toast with a one-line reason and don't change repo state.

### 9.2 Server-side flow

The dev server (already running at `pnpm dev`) gets a single new endpoint: `POST /api/upload` that accepts a multipart form with the file plus a `category` field (`mesh` / `texture` / `audio`). The handler:

1. Validates extension + size (configurable cap; default 32 MB for mesh/texture, 8 MB for audio).
2. Computes a content hash (`sha1`, first 8 chars).
3. Writes the file to `assets/uploads/<category>/<original_basename>.<hash>.<ext>` in the working tree.
4. If the file already exists with the same hash, it's a no-op success.
5. Returns the new path so the palette can immediately load it via the shared `AssetCache`.

The **autosave watcher** (already running, already responsible for the JSON edit files) detects the new file and includes it in its next batched commit + push, with a commit message `chore(uploads): add <basename>`. From the operator's perspective, the file is on GitHub a few seconds after the toast.

### 9.3 Why this is enough

No S3, no signed URLs, no CDN. The repo is the source of truth, the dev server already exists, the autosave watcher already exists; the only new piece is one HTTP handler. The size cap keeps the repo from bloating; the content hash keeps duplicate uploads cheap; the per-category subfolder keeps the tree readable.

### 9.4 Pulling teammates' uploads

A teammate who runs `git pull` gets the new files. On next boot, the relevant palette enumerates `assets/uploads/<category>/` and surfaces them in its library automatically. There is no separate "refresh assets" button; the editor already re-enumerates on map open.

### 9.5 What this is *not*

This is not a full DCC pipeline. There is no automatic LOD generation, no texture compression, no audio normalization, no GLB optimization. If those become needed they're added as a server-side post-process step in the same handler; for now the file is shipped as-is and the operator is trusted to upload sensible content.



---

## 10. Visual System Hand-off (the part Claude must inherit verbatim)

The shell prototype `firewolf_shell_sim` is the canonical reference for the editor's visual and verbal style. This section locks the parts that took taste to land so they are not silently re-invented during the port.

### 10.1 Color tokens (warm paper light theme)

The editor runs in a single warm-light theme. Drop these tokens into the production CSS root unchanged. Pure black and pure white are forbidden. Amber is reserved for *active state and active intent to change* — never for decoration, never for hover.

```css
:root {
  /* Accent — only use to mark the active mode, the active tool,
     the active selection, or a value the operator is changing right now. */
  --amber:      oklch(0.72 0.16 60);            /* warm amber #e89030 */
  --amber-dim:  oklch(0.72 0.16 60 / 0.18);

  /* Warning (destructive confirmation, error toasts) */
  --brick:      oklch(0.55 0.18 28);

  /* Ink — warm near-black, never #000. Three weights. */
  --ink:        oklch(0.22 0.015 60);           /* headings */
  --ink-dim:    oklch(0.45 0.012 60);           /* body text */
  --ink-faint:  oklch(0.62 0.010 60);           /* tertiary, hints */

  /* Surfaces — warm cream paper. Floating cards are *brighter* than the world. */
  --panel:        oklch(0.96 0.008 75);         /* cream paper #f5f3ee */
  --panel-glass:  oklch(0.99 0.005 75 / 0.78);  /* floating cards */
  --hairline:     oklch(0.22 0.015 60 / 0.10);  /* real ink hairline at 10% */
}
```

Three rules govern these tokens. Floating UI is brighter than the world, so the eye reads chrome as paper and the 3D scene as the dark island. The 3D scene's fog fades to a slightly desaturated cream so the scene sinks gently into the page rather than punching a hole. Hairlines are a real `rgba(ink, 0.10)`, not a near-invisible whisper — visible, calm, intentional.

### 10.2 Typography

Body and UI use **IBM Plex Sans** (already loaded in the prototype). Numerics use the same face with `font-feature-settings: "tnum"` for tabular figures. **JetBrains Mono** is reserved for cursor coordinates and frame rate — anything that is genuinely telemetry. Slider readouts, ammo counts, HP, and timer values use the proportional sans with tabular figures, not mono. Mono is rare and earned.

### 10.3 Wordmark

The prototype ships a vector wordmark component at `client/src/components/shell/Wordmark.tsx`. Port it verbatim. It is lowercase humanist sans where the dot of the *i* is replaced by a small upward triangle in `--amber`. It accepts `height`, `ink`, and `flame` props so the same component serves the top bar (17px ink), the welcome card (22px ink), the loading screen (40px ink), and any future hero spot. **Do not generate a raster logo file.** The vector is the brand asset.

### 10.4 The exemplar lock

Five surfaces in the prototype took deliberate craft to land. Claude must port them as-is and is not permitted to redesign them as part of the initial port. Each can be evolved later, but only with a deliberate change request from the operator.

| Surface | Source file | Why locked |
|---|---|---|
| The wordmark | `Wordmark.tsx` | Brand mark, vector, single source of truth |
| The welcome / help card | `HelpOverlay.tsx` | Tone of voice and onboarding hierarchy |
| The top bar | `TopBar.tsx` | The "wordmark / mode · paused" left cluster, the icon-only right cluster |
| The 12-tile mode grid | `ShellPanel.tsx` (mode switcher) | Two-row layout, amber active border, ink-on-cream tiles |
| The slider primitive | used in `TuningPalette.tsx`, `AudioPalette.tsx`, etc. | Track, thumb, label-and-value layout |

### 10.5 Voice and labels (apply to every string in the editor)

The prototype's plain-English rewrite established rules that Claude must apply to every new label, button, toast, and log line it writes. These are not stylistic suggestions; they are the spec.

- **Mode names are one verb.** Place, Build, Sculpt, Animate, Paint, Tune, Triggers, Sound, Effects, Bots, Bindings. Never "EDIT · BUILDINGS", never "Building Editor", never "Buildings Mode."
- **No SCREAMING_CAPS in operator-facing text.** Identifiers in code can stay snake or camel; what the operator reads is sentence case.
- **No insider syntax in labels.** `MUZZLE_01` becomes "Muzzle." `WPN_FIRE_DISC` becomes "Disc launcher fired." `TRIG_FIRE on_region_enter` becomes "Triggered: enter region."
- **Past-tense plain English for log lines.** "Loaded "Running"," "Played Disc launcher fired," "Reset to defaults." Not "DISPATCH WPN_FIRE_DISC ts=4012."
- **No "stub", no "TODO", no "sketch."** If something is a placeholder, the label still says what it does for the operator. The implementation status is for code comments, not for UI.
- **Sliders show the unit.** "Size 6 m," "Pitch 1.2×," "Volume 0.85." Not "RADIUS 6.0," not "PITCH 1.20."
- **Headers are not shouted.** No tiny uppercase tracked-out tech labels above every section. The amber border + the mode tile already tell the operator where they are.
- **One sentence of help, then silence.** Each palette gets one short footer sentence explaining the click affordance ("Click the ground to drop a trigger"). No paragraphs of inline documentation.
- **Errors and warnings name the next action.** Not "Failed to load asset." Instead "Couldn't load tank.glb — check the file is under 32 MB."

### 10.6 Motion

Every UI transition is 180–240 ms with a `cubic-bezier(0.4, 0, 0.2, 1)` curve. No spring. No bounce. The amber hairline that tracks the active mode tile uses a 180 ms linear tween. Modal overlays fade + slide up 4 px on enter; they reverse on exit. The 3D scene never animates the camera as a side effect of UI changes; only Shift+P (playtest) and F1–F4 (camera bookmarks) move the camera.

---

## 11. Project / Map Management

The editor must support multiple maps. Without this, every prototype map collides with every other and the operator can't have two projects in flight at once. This is a v1 requirement.

### 11.1 Repo layout

```
maps/
  flag_canyon/
    map.json            ← terrain heights, splatmap, prop list, building list,
                          trigger list, vfx list, bot list, audio events, bindings
    editor_state.json   ← camera bookmarks, layer visibility, last cursor pos
    thumb.png           ← auto-captured 480×270 preview
  alpine_outpost/
    ...
```

Each map is a single folder under `maps/`. Everything the operator places lives in `map.json`. Editor-only state (camera bookmarks, panel layout) lives in `editor_state.json` so map data stays clean. Asset uploads continue to live under `assets/uploads/` and are referenced from `map.json` by path + content hash.

### 11.2 Operator-facing surface

A single new menu accessed from the top bar's left cluster — clicking the wordmark opens it. Four items:

- **New map** — prompts for a name, creates `maps/<slug>/`, switches to it.
- **Open map…** — modal grid of thumbnails, click to switch.
- **Save** — explicit, but rarely needed because autosave runs every 2 seconds.
- **Save as…** — duplicates the current map under a new name.

A small breadcrumb to the right of the wordmark shows the current map name (e.g. `firewolf / Build / flag_canyon`). Clicking the map name opens the same menu.

### 11.3 Autosave behavior

Autosave runs every 2 seconds when the operator has made an edit. It writes `map.json` and `editor_state.json` atomically (write to temp, fsync, rename), then the watcher commits + pushes them. The operator never thinks about saving unless they want a named branch point ("Save as…").

### 11.4 Multiplayer-safe later, not now

For v1, two operators editing the same map at the same time is undefined behavior — last write wins. This is acceptable because the realistic team size is 1–3 and they coordinate. A real CRDT layer is out of scope for v1.

---

## 12. Settings / Preferences

A small panel surfacing the things the operator will reach for in the first week. Accessed from the top bar's right cluster (a gear icon next to the help icon). Persists to `~/.firewolf/preferences.json` (per-user, not per-map, not in the repo).

### 12.1 Settings included in v1

The settings split into four small groups.

**Movement & camera.** Player walk speed (default 6 m/s), sprint multiplier (1.6×), FOV (78°), edit-camera pan speed, edit-camera zoom speed, invert mouse Y.

**Snap & grid.** Default snap on/off (default on), grid size for buildings (default 4 m), grid size for props (default 1 m), rotation step (default 15°).

**Autosave & history.** Autosave interval (default 2 s), undo stack depth (default 64), autosave-after-playtest behavior (snapshot on/off).

**Appearance.** Theme (light is default; dark is offered for long sessions but is not the canonical mode), UI scale (90 / 100 / 110 / 125%), reduce motion (disables all UI transitions), font face override (default IBM Plex Sans).

### 12.2 What's *not* in v1 settings

Keybinding remapping is deferred to v1.1 — the prototype's keys are good defaults and remap UI is a tarpit. Color picker / custom theme is deferred — there is one canonical theme and a single optional dark mode. Audio device selection is deferred — the editor uses the OS default like every other web app.

### 12.3 Implementation note

The settings panel is a single React component (`client/editor_core/SettingsPanel.tsx`) that reads / writes a typed `Preferences` object. Other systems (movement, snap, autosave) consume the typed object via a small `usePreferences()` hook. A change in the panel applies live without reload. There is no Apply / OK button; changes are committed instantly to disk with the same 250 ms debounce the autosave watcher uses.

---

*End of Integration Plan v2 — final pre-port revision. Hand to Claude as the canonical spec for the production build.*
