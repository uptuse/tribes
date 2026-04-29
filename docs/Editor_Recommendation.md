# Firewolf Open-Source Editor Shell Recommendations

**Author:** Manus AI

To upgrade the Firewolf debug panel into a full-fledged editor shell, we need a UI framework that can handle scene hierarchies, property inspectors, and complex layouts without fighting the existing WASM + Three.js + Rapier architecture.

Because Firewolf's core logic lives in C++ (WASM) and the JS layer acts primarily as a renderer facade, the ideal editor shell should be decoupled from the engine's tick loop and focus entirely on the DOM/UI layer.

Here are the top open-source candidates that can be bolted onto Firewolf.

## 1. PCUI (PlayCanvas UI)
**License:** MIT
**Repository:** [playcanvas/pcui](https://github.com/playcanvas/pcui)

PCUI is the open-source frontend framework that powers the PlayCanvas editor. While PlayCanvas itself is a full engine, they extracted their UI layer into a standalone library specifically designed for building web-based game tools.

**Why it fits Firewolf:**
- **Built for Game Editors:** It comes out-of-the-box with components specifically needed for game dev: `TreeView` (for the scene graph), `ColorPicker`, `VectorInput` (for XYZ coordinates), and `Panel` (for docking and collapsing inspector tabs).
- **Engine Agnostic:** Despite the name, PCUI is completely decoupled from the PlayCanvas 3D engine. It is just a DOM-based UI library, meaning it will happily sit on top of Firewolf's Three.js canvas.
- **Data Binding:** It includes an `Observer` pattern for two-way data binding. This is perfect for bridging the gap between the UI sliders and the WASM `setDebugConfig()` JSON bridge we designed earlier.

**Integration Effort:** Medium. You would drop the PCUI bundle into the `client/` folder and replace the `lil-gui` instantiation with PCUI panels and observers.

## 2. Three.js Editor (Standalone Fork)
**License:** MIT
**Repository:** [mrdoob/three.js/tree/dev/editor](https://github.com/mrdoob/three.js/tree/dev/editor)

The official Three.js repository includes a fully functional, browser-based editor. 

**Why it fits Firewolf:**
- **Native Three.js Integration:** Since Firewolf already uses Three.js for rendering, the Three.js editor natively understands the scene graph, materials, and geometries.
- **Familiarity:** It looks and feels like a traditional 3D package (similar to older Unity or Blender interfaces).

**Why it might be difficult:**
- **Tightly Coupled:** The Three.js editor is designed to *own* the scene. In Firewolf, the WASM layer owns the simulation state and dictates what Three.js renders. Bolting the Three.js editor onto Firewolf would require heavily modifying the editor's source code so it acts as a passive observer rather than the master state controller.
- **Integration Effort:** High. You would need to gut the editor's core logic and wire its UI components directly to Firewolf's facades.

## 3. Theatre.js
**License:** Apache 2.0
**Repository:** [theatre-js/theatre](https://github.com/theatre-js/theatre)

Theatre.js is an animation library with a professional motion design toolset. It provides a visual interface for tweaking variables and creating cinematic sequences.

**Why it fits Firewolf:**
- **Polished UI:** It has a highly polished, modern interface that looks great and is designed to overlay on top of existing Three.js canvases.
- **Timeline/Keyframing:** If Firewolf needs to sequence events, camera fly-throughs, or particle emissions, Theatre.js excels here.

**Why it might be difficult:**
- **Focus on Animation:** It is less of a "game engine editor" (no scene hierarchy tree out of the box) and more of a "motion graphics editor". It is excellent for tweaking float values (like `lil-gui`) but lacks the structural components for building a full entity inspector.
- **Integration Effort:** Low to Medium. Similar to `lil-gui`, it overlays easily, but extending it into a full scene editor would require building custom DOM components around it.

## 4. Tweakpane (Advanced Alternative to lil-gui)
**License:** MIT
**Repository:** [cocopon/tweakpane](https://github.com/cocopon/tweakpane)

If the goal is simply a more powerful version of the debug panel rather than a full Unity-style layout, Tweakpane is the industry standard upgrade from `lil-gui`.

**Why it fits Firewolf:**
- **Monitor Bindings:** Tweakpane allows you to create read-only graphs and monitors. You could pipe Rapier's framerate, WASM memory usage, or player velocity directly into live line charts in the panel.
- **Plugins:** It has a rich plugin ecosystem (e.g., rotation widgets, camera focal length inputs).
- **Integration Effort:** Very Low. It is a direct drop-in replacement for the `lil-gui` code in the current blueprint.

## Recommendation

If you want a **true Unity/Godot-style editor interface** (with a left-hand scene tree, a bottom asset browser, and a right-hand property inspector), **PCUI** is the best choice. It gives you the exact UI components used in professional web game engines without forcing you to adopt their 3D rendering pipeline.

If you want to keep the interface as a **floating overlay** but need more power than `lil-gui` (like live graphs, vector inputs, and better layout control), use **Tweakpane**.

### Next Steps for PCUI Integration
If you choose PCUI, the architecture from the blueprint remains the same, but the `client/debug_panel.js` would be rewritten to:
1. Initialize a `pcui.TreeView` by reading the Three.js `scene.children`.
2. Initialize a `pcui.Panel` on the right side of the screen.
3. Bind `pcui.NumericInput` components to the WASM JSON bridge using PCUI's `Observer` class.
