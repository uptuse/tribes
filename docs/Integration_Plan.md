# Firewolf Toolchain Integration Plan

**Date:** April 29, 2026
**Target:** Main Game, Map Editor, Building Editor, Animation Editor
**Objective:** Unify the four disparate browser-based surfaces into a single, coherent toolchain where data flows seamlessly from asset creation (Animation/Building) to level design (Map Editor) to runtime (Main Game).

---

## 1. Current State Audit

Firewolf currently has four isolated web surfaces. They share no common UI shell, duplicate large amounts of Three.js boilerplate, and rely on manual file downloads to move data between them.

| Surface | URL | Input Data | Output Data | Purpose |
| :--- | :--- | :--- | :--- | :--- |
| **Main Game** | `/` | `canonical.json`, `layouts.json`, `.glb` | None | The actual playable game client. |
| **Map Editor** | `/editor/` | `canonical.json`, `heights.bin` | `raindance-assets-*.json` | Places static props and base assets on the terrain. |
| **Building Editor** | `/editor/buildings.html` | `catalog.json`, `layouts.json` | `layouts.json` | Snaps modular pieces together to form buildings. |
| **Animation NLE** | `/assets/models/animation_editor.html` | Single `.glb` file | `animation_timeline.json` | Non-linear editor for blending GLTF animation clips. |

**The Friction Points:**
1.  **Export/Import loop:** The map and building editors only export JSON files to the user's local `Downloads/` folder. The user must manually move these files into the repo (`assets/maps/raindance/` or `assets/buildings/`) and rebuild the WASM data package before the main game can see the changes.
2.  **Duplicated Loaders:** Every editor implements its own `GLTFLoader` and environment setup.
3.  **Disconnected Context:** You cannot see your custom buildings in the map editor, and you cannot see map terrain in the building editor.

---

## 2. Target Architecture: The Unified Editor Shell

Instead of four separate HTML pages, Firewolf should adopt a **Unified Editor Shell** model, similar to Unity or Godot, where the engine is always running, and the "editors" are just UI overlays that manipulate the live scene graph.

### The "Live-Link" Data Contract
The core enabler of this integration is moving away from static file downloads and instead using `localStorage` as a hot-reload bridge during development.

*   **Production (Live Site):** The game `fetch()`es `layouts.json` and `canonical.json` from the server.
*   **Development (Localhost):** The editors write directly to `localStorage` (e.g., `firewolf_layouts_draft`). The main game checks `localStorage` first; if a draft exists, it uses that instead of the server file.

This allows a user to have the Building Editor open in Tab 1, hit "Save", and switch to the Main Game in Tab 2, hit "Refresh", and instantly see the new building without moving files or recompiling.

---

## 3. Phased Execution Roadmap

This is a large architectural shift. Claude should execute it in three distinct, safe phases.

### Phase 1: Shared Data Layer (The Hot-Reload Bridge)
**Goal:** Eliminate the manual file-moving step between the editors and the main game.
1.  **Building Editor:** Update `exportLayouts()` to also write to `localStorage.setItem('firewolf_live_layouts', JSON.stringify(data))`.
2.  **Map Editor:** Update its export function to write to `localStorage.setItem('firewolf_live_map', JSON.stringify(data))`.
3.  **Main Game (`renderer.js`):** Modify the boot sequence to check `localStorage` before fetching from the network.
    *   If `firewolf_live_layouts` exists, parse it and pass it to `initBuildings()`.
    *   If `firewolf_live_map` exists, override the `canonical.json` placements.
4.  **UI Addition:** Add a small "Clear Drafts" button to the main game's Shift+Enter panel to wipe `localStorage` and revert to the committed repo state.

### Phase 2: Unified Map & Building Context
**Goal:** Allow the Map Editor to place custom buildings, and the Building Editor to see the terrain.
1.  **Map Editor Upgrades:**
    *   Currently, the Map Editor only places `canonical.json` props (turrets, generators).
    *   Update it to fetch `layouts.json` (or the live draft) and render the modular buildings as unselectable, translucent "ghosts" on the terrain so the level designer knows where the buildings are.
2.  **Building Editor Upgrades:**
    *   Currently, the Building Editor operates in an empty black void.
    *   Update it to fetch `raindance_heights.bin` and render the terrain as a wireframe grid. This ensures buildings are designed to fit the actual slopes of the map.

### Phase 3: The In-Game Unified Shell (Long Term)
**Goal:** Deprecate the standalone `/editor/` HTML pages entirely.
1.  Move the DOM UI from `editor/index.html` and `editor/buildings.html` into hidden `<div>`s inside the main game's `index.html`.
2.  Create a top-level "Mode Switcher" in the Shift+Enter panel: `[ Play | Edit Map | Edit Buildings | Edit Animations ]`.
3.  When switching to an editor mode:
    *   Pause the WASM physics tick.
    *   Detach the camera from the player viewmodel and attach it to a `THREE.MapControls` or `OrbitControls` rig.
    *   Unhide the relevant editor DOM overlay.
4.  When switching back to Play mode:
    *   Re-serialize the scene graph back to the JSON data contracts.
    *   Hot-reload the WASM state.
    *   Re-attach the first-person camera.

---

## 4. Risk & Effort Assessment

*   **Phase 1 (Hot-Reload Bridge):** Low risk, 1-2 hours effort. Purely JS `localStorage` routing. High immediate value for workflow velocity.
*   **Phase 2 (Cross-Context Rendering):** Medium risk, 3-4 hours effort. Requires sharing the `raindance_heights.bin` parsing logic and `GLTFLoader` logic between the two editor codebases.
*   **Phase 3 (In-Game Shell):** High risk, multi-day effort. Disentangling the editor UI from their standalone HTML files and injecting them into the main game loop will cause CSS collisions and input-event (mouse/keyboard) fighting with the game's pointer-lock system.

**Recommendation for Claude:** Execute Phase 1 immediately. It delivers 80% of the integration value (instant feedback loop) for 10% of the engineering cost.
