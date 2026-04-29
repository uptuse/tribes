# Firewolf Map Editor & WebGL Effects Library

**Author:** Manus AI

This document covers two major editor upgrades: how to handle map/level design, and how to integrate a vast library of WebGL effects for live experimentation.

## 1. Map Editing: The Current State & The Upgrade

### The Current State
Right now, Firewolf's map data is **hardcoded in C++**.
If you look at `program/code/raindance_mission.h`, you will see arrays like `RAINDANCE_GENERATORS` and `RAINDANCE_TURRETS` with exact X/Y/Z coordinates. When the game boots, `wasm_main.cpp` reads these arrays and spawns the buildings.

The previous AI built `editor/buildings.html` and `editor/index.html`. These are standalone tools that let you load a 3D model, drag it around, and export its position. But just like the animation editor, they are disconnected from the live game.

### The "Best Version" Map Editor Upgrade
To get a true Unity-style map editor, we must decouple the map data from the C++ code.

1. **Move from C++ to JSON:** Instead of hardcoding `RAINDANCE_GENERATORS` in C++, we move that data into a JSON file (e.g., `raindance_layout.json`).
2. **Live Dragging (TransformControls):** We use the PCUI editor + Three.js `TransformControls`. You click a turret in the live game, the 3D arrows appear, and you drag the turret to a new hill.
3. **Live Saving:** When you hit "Save Map" in the PCUI panel, the editor overwrites `raindance_layout.json`.
4. **WASM Hot-Reload:** The WASM engine is updated to read `raindance_layout.json` at startup.

**The Workflow:** You no longer need to recompile C++ to move a building. You drag it in the live game, save the JSON, and the next time anyone plays the map, the building is in the new spot.

## 2. WebGL Effects Library: How to Add "Vast Effects"

Firewolf currently uses the standard Three.js `EffectComposer` for post-processing. It has two effects running: **UnrealBloomPass** (for glowing jetpacks/lasers) and a custom **ShaderPass** (for vignette and color grading).

If you want a "vast effects library" to experiment with (glitch effects, depth-of-field, motion blur, chromatic aberration, advanced particles), we need to port in industry-standard open-source libraries.

### The Two Libraries to Port In

#### A. Post-Processing: `pmndrs/postprocessing`
The default Three.js `EffectComposer` is slow because it renders the screen multiple times (once for every effect). The industry standard replacement is **`pmndrs/postprocessing`** [1].
- **What it is:** A high-performance WebGL effects library. It combines all effects into a single shader pass, making it incredibly fast.
- **What you get:** Dozens of drop-in effects: Depth of Field, Chromatic Aberration, Glitch, God Rays, SSAO (Screen Space Ambient Occlusion), Pixelation, and SMAA.
- **How it integrates:** The AI swaps `EffectComposer` for `pmndrs/postprocessing` in `renderer_postprocess.js`. In the PCUI editor, we add a "Post-FX" tab. You can click a checkbox to turn on "Glitch Effect" and use a slider to tune its intensity live.

#### B. Advanced Particles: `three-nebula`
Firewolf currently uses a custom, hardcoded particle system (`renderer_particles.js`) for jet exhaust and explosions.
- **What it is:** **Nebula** [2] is a fully-featured WebGL particle system designer built specifically for Three.js.
- **What you get:** Complex, physics-driven particle behaviors (attractors, repellers, gravity wells, spring forces) without writing custom math.
- **How it integrates:** Nebula uses JSON files to define particle emitters. The AI ports the Nebula engine into Firewolf. In the PCUI editor, we add a "Particle Designer" tab that lets you load, tweak, and save Nebula JSON files live in the game.

## Summary of the Vibe-Coding Prompt

To get both of these features, here is what you tell the AI:

> "Upgrade Firewolf's map system to load entity positions from a JSON file instead of hardcoded C++ headers, and add Three.js TransformControls so I can drag buildings in-game and save the JSON via the PCUI editor. Also, replace the default `EffectComposer` with the `pmndrs/postprocessing` library, and expose toggles/sliders in the PCUI panel for Depth of Field, Chromatic Aberration, and Glitch effects so I can experiment live."

This gives you a full WYSIWYG level editor and a AAA-grade post-processing suite, all controllable through the PCUI dashboard.

## References
[1] pmndrs/postprocessing. "A post processing library for three.js." https://github.com/pmndrs/postprocessing
[2] three-nebula. "A WebGL based 3D particle engine." https://github.com/creativelifeform/three-nebula
