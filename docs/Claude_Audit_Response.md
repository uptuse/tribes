# Claude Audit Response — Firewolf PCUI Editor Plan

**Reviewer:** Claude (Anthropic)  
**Plan Author:** Manus AI  
**Date:** 2026-04-29

---

## What I'd Keep As-Is

**The C++ decision (Section 2).**
The reasoning is correct and matches the project's actual state. The physics fidelity argument, the server-authority argument, and the existing investment in `wasm_main.cpp` are all real. Skiing and jetting in particular depend on frame-accurate deterministic math that WASM delivers reliably. Don't rewrite in JS.

**The hybrid workflow framing (Section 5).**
"Editor changes data, AI changes logic" is a clean and correct mental model for how the Director works. Worth keeping as the guiding principle for every future feature conversation.

**TransformControls for map entity placement (Phase 2, partially).**
`TransformControls.js` is already vendored in this repo (`vendor/three/r170/addons/controls/TransformControls.js`). Low integration cost, real immediate value for dragging turrets and generators to better positions.

---

## What I'd Change

**Drop PCUI entirely.**
This is the biggest call in the plan and it's wrong for this project. PCUI is PlayCanvas's internal UI kit — it was designed to build the PlayCanvas *editor itself*, not to bolt onto an arbitrary Three.js game. It has no npm package, requires a build step, adds ~200 KB of framework code, and its component model assumes you own the full page. The repo already has a working settings panel, HUD chips, and inspector-style sliders in `index.html`. A few hundred lines of vanilla JS extending what already exists will ship faster, break less, and have zero new dependencies. Use that instead.

**The JSON bridge claim is overstated.**
Section 3 says the C++/JS divide is "invisible to you as the Director — the AI handles the bridge." The repo's actual history shows it isn't. Every new C++ tunable requires adding a field to a struct, adding a WASM export to `build.sh`'s `EXPORTED_FUNCTIONS` list, rebuilding WASM (slow even with CI), and wiring a JS setter. That's at minimum four coordinated changes across three files. The plan should acknowledge this honestly. The new CI workflow (`ede5eb0`) reduces the pain but doesn't eliminate it.

**The "Save Map" story is underspecified.**
Writing back to `layout.json` from the browser requires either (a) a local dev server with a write endpoint, or (b) a download-and-commit flow where the Director downloads the JSON and commits it manually. Neither is mentioned in the plan. This is a concrete implementation gap that will block Phase 2 from actually shipping the promised "Save Map" button.

---

## What I'd Cut

**Phase 3 — Animation Editor integration into PCUI.**
The animation editor in `assets/models/animation_editor.html` already works as a standalone tool. Docking it into a PCUI panel (which we're not using anyway) adds complexity with no gameplay value right now. Defer until character animation is actually a bottleneck reported from playtesting.

**Phase 4 — pmndrs/postprocessing and three-nebula — cut entirely.**
Replacing `EffectComposer` is a renderer regression risk. The repo has had repeated terrain-invisible bugs caused by shader pipeline changes (documented in `comms/SHADER_DIAGNOSTIC.md`, `R32.38–R32.40`). The terrain texture-unit budget problem was just fixed; destabilizing the renderer again for nice-to-have post-FX is the wrong trade. `three-nebula` is a heavy dependency for a feature that the existing `THREE.Points` system already handles adequately. Neither belongs in the same milestone as Phase 1.

---

## Biggest Gap the Plan Doesn't Address

**The plan never asks what the Director actually wants to tune first.**
It describes a full editor suite without identifying the one slider that would deliver the most immediate value. Based on the playtest logs in `comms/manus_playtest_log.md`, the highest-friction tuning moments have been jetpack energy drain, terrain roughness, and building collision radii — all of which are already exposed as uniforms or constants. A 50-line panel that touches those three things ships faster and delivers more value than a complete PCUI integration.

**No rollback strategy.**
If a Director-edited `layout.json` breaks a wall of collision geometry, how do we recover? The plan has no answer. At minimum, the save flow should write a timestamped backup before overwriting.

**No mention of the branch split.**
The plan was authored on a separate branch (`docs/pcui-editor-plan`) that diverged significantly from `master`. That branch has `assets/buildings/`, `assets/glb/`, `assets/models/`, Rapier physics, modular renderer files, and a different `index.html`. Before any of this plan is implemented, we need clarity on which branch is the target and how to reconcile the divergence.

---

## Recommended Scope for an Actual Phase 1

Drop PCUI. Build a collapsible overlay panel in vanilla JS (extending the existing settings panel pattern) with:

1. Sliders for the 3–5 most frequently tuned WASM constants (jetpack force, energy drain, gravity, ground friction).
2. A "Save defaults" button that downloads a JSON snippet the Director can paste into the relevant C++ constants or JS config.
3. TransformControls wired to the existing building/flag entity system for drag-to-place.

That's the whole Phase 1. It's two days of work, has no new dependencies, and doesn't risk breaking the renderer.

---

## Summary Table

| Plan Section | Verdict | Reason |
|---|---|---|
| Keep C++ (§2) | ✅ Keep | Correct reasoning, matches project state |
| Hybrid workflow mental model (§5) | ✅ Keep | Clean and correct |
| TransformControls for map entities (§4B) | ✅ Keep (simplified) | Already vendored, real value |
| PCUI as UI framework (§3) | ❌ Cut | Wrong tool for this project; use existing panel pattern |
| Phase 1 Inspector sliders | ⚠️ Simplify | Skip PCUI; vanilla JS, 3–5 key tunables only |
| Phase 2 Save Map button | ⚠️ Needs design | Save flow is underspecified; add rollback + download-and-commit |
| Phase 3 Animation Editor in PCUI | ❌ Defer | Standalone tool already works; no current need to dock it |
| Phase 4 pmndrs + three-nebula | ❌ Cut | Renderer regression risk; not worth it |
