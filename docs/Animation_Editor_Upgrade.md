# Firewolf Animation Editor: Upgrade & Integration Plan

**Author:** Manus AI

I have reviewed the existing `animation_editor.html` created by the previous AI, as well as the `PIPELINE_RULES.md` and `character-pipeline.md`. Here is the current state, what the "best version" looks like, and how it integrates with the new PCUI editor.

## 1. The Current State
The previous AI built a standalone tool (`assets/models/animation_editor.html`). It is a 1,400-line HTML file that acts as a Non-Linear Editor (NLE) for animations. 
- **What it does well:** It loads GLTF models, reads Mixamo animations, provides a multi-track timeline, and allows you to drag, drop, trim, and splice clips together. It even has a bone-hierarchy viewer to create custom poses.
- **What it lacks:** It is entirely disconnected from the game. It is a standalone HTML file with its own custom-built CSS UI. It exports a JSON config, but it doesn't talk to Firewolf live.

## 2. The "Best Version" Upgrade
To make this the best version of itself, we don't throw away the animation logic—we throw away the custom UI and integrate it directly into the PCUI editor overlay inside the live game.

The industry standard for web-based animation timelines is **Theatre.js** [1]. However, since Firewolf already uses `THREE.AnimationMixer` heavily in `renderer_characters.js`, we can achieve a lighter, tighter integration by porting the existing timeline logic into a PCUI-native format.

### The Upgraded Workflow
Instead of opening a separate HTML file, you will open the PCUI editor *while playing the game*.

1. **The Animation Panel:** In the PCUI Inspector, there will be an "Animation" tab.
2. **Live Retargeting:** You click a player in-game. The PCUI panel shows their active animation state (e.g., `run_fwd` blending into `jump`).
3. **The Timeline Overlay:** A PCUI-styled timeline appears at the bottom of the screen. It shows the raw keyframes for the selected animation.
4. **Live Tweaking:** You can pause the game, drag a keyframe (e.g., raising the arm higher during the `fire_spinfusor` animation), and immediately unpause to see the result on the live player model.

## 3. How It Slots Into PCUI

The integration requires three components working together:

### A. The PCUI Inspector (Right Panel)
- **State Viewer:** Shows the current weight of all animations playing on the selected character.
- **Bone Selector:** A PCUI `TreeView` (like the one in the mockup) listing all bones in the Mixamo rig (Hips > Spine > Shoulder > Arm).
- **Transform Controls:** When a bone is selected, the PCUI panel shows its exact Rotation (X, Y, Z, W) and the Three.js `TransformControls` appear on the bone in-game so you can drag it.

### B. The Timeline (Bottom Panel)
- PCUI does not have a built-in timeline component, but we can reuse the HTML5 Canvas timeline from `animation_editor.html` and restyle it to match PCUI's dark/orange aesthetic.
- It will dock to the bottom of the screen, similar to Unity's Animation window.

### C. The Engine Bridge
- The editor hooks directly into `renderer_characters.js`.
- When you modify a keyframe in the timeline, the editor updates the `THREE.AnimationClip` in memory.
- You click "Save to GLB," and the editor exports the modified animation track so you can replace the original asset.

## 4. Execution Plan

If you want to build this, here is the exact prompt to give the coding AI:

> "Port the timeline logic from `assets/models/animation_editor.html` into a new PCUI-styled bottom panel in the main game editor. Hook it directly into `renderer_characters.js` so I can select a live player, view their active `THREE.AnimationMixer` tracks, pause the game, rotate their bones using `TransformControls`, and save the modified `AnimationClip` back to a file."

This gives you a professional, Unity-style animation workflow without leaving the browser or the game context.

## References
[1] Theatre.js. "Animation toolbox for the web." https://www.theatrejs.com/
