# Firewolf's Three Systems: How the Editor Integrates

**Author:** Manus AI

Firewolf's architecture relies on three distinct layers working together. When we bolt on the PCUI editor and Three.js TransformControls, we have to integrate with each of these systems differently. 

Here is exactly how the editor interacts with the WASM simulation, the WebGL renderer, and the Rapier physics engine.

## System 1: WASM / C++ (The Game Logic)
This is the brain of Firewolf. It handles weapon stats, armor classes, player health, game rules, and the core simulation loop.

**How the Editor Integrates:**
- **The Tool:** PCUI Panels (Sliders, Number Inputs, Dropdowns).
- **The Bridge:** The `setSettings()` JSON bridge we designed in the blueprint.
- **How it works:** When you move a slider for "Spinfusor Damage" in the PCUI panel, the editor creates a JSON string `{"spinfusor_damage": 55}` and passes it into the WASM module. The C++ code parses the JSON and updates its internal variables instantly.
- **Coverage:** Excellent. The JSON bridge is infinitely extensible. Any variable you want to tune in C++ just needs to be added to the JSON parser.

## System 2: Three.js / WebGL2 (The Visuals)
This is the eyes of Firewolf. It handles the 3D models, the terrain, the skybox, the jetpack exhaust particles, and the post-processing (bloom, color grading).

**How the Editor Integrates:**
- **The Tools:** PCUI Panels (Color Pickers, Checkboxes) + **Three.js TransformControls** (the 3D dragging arrows).
- **The Bridge:** Direct JavaScript reference.
- **How it works:** Because both the PCUI editor and the renderer live in JavaScript, they can talk directly. If you want to change the jet exhaust color, the PCUI color picker directly updates the Three.js material color `material.color.setHex()`. If you want to move an asset, you click it, the TransformControls appear, and you drag it around the Three.js scene graph.
- **Coverage:** Perfect. Because the editor and the renderer share the same language and environment, this is the easiest system to build tools for.

## System 3: Rapier (The Physics)
This is the bones of Firewolf. It handles gravity, collision detection, and the "Character Controller" (how the player slides on the terrain and bounces off walls).

**How the Editor Integrates:**
- **The Tool:** PCUI Panels (Sliders).
- **The Bridge:** Direct JavaScript reference (Rapier runs in JS/WASM alongside Three.js).
- **How it works:** Firewolf's Rapier implementation exposes a global `window.RapierPhysics` object. The PCUI editor can hook directly into this. If you want to tune "Ski Friction" or "Gravity," you add a slider that directly updates the Rapier world properties: `RapierPhysics.world.gravity = {x: 0, y: -9.81, z: 0}`.
- **Coverage:** Good, but requires care. Physics engines are sensitive. Changing gravity mid-jump can cause weird behavior. The editor can easily update the numbers, but the game logic might need to reset the player's momentum to prevent physics explosions when tuning live.

## Summary Table

| System | Editor Tool Used | Integration Method | What You Can Do |
| :--- | :--- | :--- | :--- |
| **1. WASM (Logic)** | PCUI Sliders | JSON Bridge (`setSettings`) | Tune weapon damage, armor health, jetpack energy drain. |
| **2. Three.js (Visuals)** | PCUI Color Pickers + TransformControls | Direct JS Access | Change particle colors, adjust bloom intensity, drag assets around the map. |
| **3. Rapier (Physics)** | PCUI Sliders | Direct JS Access | Tune gravity, friction, character jump height. |

### The "Missing" Piece: The 2D Command Map
Firewolf also has a 2D command map (the tactical view). The PCUI editor and TransformControls do not natively edit 2D canvases. If you want to visually draw or edit the 2D map, that would require a separate, custom 2D canvas editor tool built into PCUI. For now, the 3D editor handles the actual game world, and the 2D map generates itself based on the 3D terrain.
