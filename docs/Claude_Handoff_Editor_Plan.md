# Firewolf PCUI Editor: Comprehensive Handoff Plan

**Author:** Manus AI  
**Intended Reviewer:** Claude (Anthropic)  
**Project:** Firewolf — browser-based Tribes port (WASM + Three.js + Rapier)

---

## Review Instructions for Claude

This document is a **proposed plan**, not a specification. The Director is asking you to audit it before any code is written. Treat it adversarially.

**Your job is not to agree with Manus AI.** Your job is to stress-test this plan against the problem statement and surface every weakness before the Director spends time building it.

When you review:

1. **Challenge every assumption.** If Manus AI claims something is "easy," "already done," or "industry standard," verify it. If Manus AI recommends a library (PCUI, pmndrs/postprocessing, three-nebula, Theatre.js), ask whether a simpler or more battle-tested alternative exists for *this specific project*.

2. **Prioritize architectural risks.** Flag anything that could create long-term lock-in, break multiplayer plans, introduce performance regressions, or force a rewrite later. The C++ vs. JS decision in Section 2 is the biggest one — audit it hardest.

3. **Recommend simpler alternatives where they exist.** The Director is vibe-coding, not writing code by hand. If a 100-line custom panel would be faster than porting a whole UI framework, say so. Prefer boring solutions.

4. **Identify gaps.** What's missing from this plan? Testing strategy? Version control? How do we not break R32.272 while we build R32.280+? What happens when two editor sessions disagree about `layout.json`?

5. **Separate must-do from nice-to-have.** Of the four implementation phases (Inspector, Map, Animation, Effects), which deliver the most value per day of work? Which should be cut or deferred?

6. **Be honest about effort.** Manus AI's rough estimates (e.g., "1-2 weeks") are optimistic. Reality-check them against the actual code in `/home/ubuntu/tribes` (or the equivalent repo path on the Director's machine).

7. **Flag anything you'd do differently.** If you disagree with the plan's direction entirely, say so and propose the alternative. The Director wants the best answer, not a rubber-stamp.

**Output format:** After your audit, produce a `Claude_Audit_Response.md` file with three sections: *What I'd keep as-is*, *What I'd change*, and *What I'd cut*. Then iterate with the Director before writing any code.

---

This document outlines the problem statement, the architectural decisions (including the C++ question), the proposed PCUI editor solution, and the "hybrid workflow" for features that fall outside the editor's scope.

## 1. Problem Statement
The Director (user) is building Firewolf (a browser-based Tribes port using WASM, Three.js, and Rapier). The Director is "vibe-coding"—directing AI to write code rather than writing it manually. 

Currently, tuning the game requires asking the AI to change hardcoded values in C++ or JS, waiting for a recompile/reload, and testing. Furthermore, several excellent standalone tools have been built (an animation NLE, a map building editor), but they are disconnected from the live game.

**The Goal:** The Director needs a professional, Unity-style "Inspector" overlay in the live game. This editor must allow the Director to visually tune numbers, edit map layouts, adjust animations, and experiment with WebGL effects *in real time*. The editor must save these changes as new defaults. Finally, there must be a clear workflow for adding entirely new features (like a new enemy AI) that the editor cannot handle alone.

## 2. The Architectural Question: Do We Need C++?

The Director asked: *"Dumb question, we do need C++ right?"*

It is not a dumb question. It is the defining architectural choice of the project.

### The Short Answer
**No, you do not strictly *need* C++.** You could rewrite the entire game logic in JavaScript/TypeScript. However, **keeping C++ is highly recommended** for a game like Firewolf.

### The Long Answer: Why Firewolf Uses C++ (WASM)
Firewolf currently splits its brain:
- **Visuals & Physics** run in JavaScript (Three.js and Rapier).
- **Game Logic** (weapons, health, jetpack math, networking state) runs in C++ compiled to WebAssembly (WASM).

**Why keep C++?**
1. **Performance:** C++ is strictly typed and has no garbage collection. When you have 64 players firing 128 projectiles, C++ calculates the math significantly faster and more consistently than JavaScript.
2. **The Tribes Legacy:** The original *Starsiege: Tribes* was written in C++. Porting movement physics (skiing, jetting) and weapon ballistics from the original source code is much easier if you keep it in C++.
3. **Server Authority:** If Firewolf ever gets a dedicated multiplayer backend (Node.js or C++ server), the exact same C++ WASM module can run on the server to validate shots and prevent cheating. JavaScript logic is harder to run securely on a server without modification.

**Why drop C++? (The JS-only route)**
- If you rewrote the game logic in JavaScript, the AI would have an easier time writing new features (like enemy bots), because it wouldn't have to manage the JSON bridge between C++ and JS. Everything would be in one language.
- *The tradeoff:* You lose performance, you throw away the C++ code you already have, and you risk garbage-collection stutters (frame drops) during heavy combat.

**The Recommendation:** Keep C++. The JSON bridge we designed makes the C++/JS divide invisible to you as the Director. The AI handles the bridge; you just drag sliders.

## 3. Proposed Solution: The PCUI Editor Shell
We will not build a new 3D engine. We will bolt a custom UI dashboard onto Firewolf using **PCUI** (PlayCanvas UI), an open-source, dark-themed, MIT-licensed UI component library.

The PCUI editor will dock over the live game canvas and act as a remote control for Firewolf's three subsystems:
1. **WASM (Game Logic):** Controlled via the existing `setSettings()` JSON bridge.
2. **Three.js (Visuals):** Controlled via direct JS variable manipulation and Three.js `TransformControls` (for dragging objects in 3D space).
3. **Rapier (Physics):** Controlled via direct JS manipulation of `window.RapierPhysics`.

## 4. Implementation Plan (The Upgrades)

### A. Core Inspector & Tuning (Phase 1)
- Port PCUI into the project (UMD bundle in `client/lib/`).
- Build a Left Panel (Hierarchy Tree) listing Players, Weapons, Armors, and World.
- Build a Right Panel (Inspector) with sliders for tuning Jetpack, Armor Stats, and Weapon Stats.
- Wire these sliders through the JSON bridge to update `wasm_main.cpp` live.

### B. Map Editing & TransformControls (Phase 2)
- Move hardcoded map entity arrays (Generators, Turrets) out of `program/code/raindance_mission.h` and into a new JSON file (`assets/maps/raindance/layout.json`).
- Update `wasm_main.cpp` to read this JSON at startup.
- Add Three.js `TransformControls`. When an entity is selected in the Hierarchy, the gizmo appears in-game.
- Add a "Save Map" button to the PCUI panel that writes the new positions back to `layout.json`.

### C. Animation Editor Integration (Phase 3)
- Take the existing logic from `assets/models/animation_editor.html`.
- Restyle it as a PCUI bottom-docked panel.
- Wire it to `renderer_characters.js`. Selecting a player in the Hierarchy loads their active `AnimationMixer` tracks into the timeline for live keyframe editing and bone rotation (via TransformControls).

### D. WebGL Effects Library (Phase 4)
- Replace the default `EffectComposer` in `renderer_postprocess.js` with the much faster `pmndrs/postprocessing` library.
- Add a "Post-FX" tab to the PCUI Inspector exposing sliders for Depth of Field, Chromatic Aberration, Glitch, SSAO, etc.
- Integrate `three-nebula` for data-driven particle design, exposing a "Particles" tab in PCUI to load/edit Nebula JSON configs live.

## 5. The Hybrid Workflow: What the Editor Can't Do
The PCUI Editor is a **tuning and arrangement tool**. It is not an IDE. It changes *data* (numbers, positions, colors, keyframes). It does not write *logic*.

When the Director wants to add a fundamentally new feature—such as a new enemy type with a unique AI brain—the editor alone is insufficient. This requires the **Hybrid Workflow**.

### How to Vibe-Code New Logic (The Hybrid Workflow)
If you want to add a robot enemy that hunts the player:

1. **You prompt the AI for Logic:** "Claude, I want a new enemy type called 'HunterBot'. It needs a state machine in C++ to track the player, and it needs to spawn in the map."
2. **The AI writes the Code:** Claude writes the C++ logic for the bot's brain, adds the bot to the WASM simulation, and exposes its tuning parameters (Speed, Detection Radius) to the JSON bridge.
3. **The AI updates the Editor:** Claude adds a "HunterBot" section to the PCUI Inspector so you can tune its new variables.
4. **You use the Editor for Tuning:** You open the game. The bot spawns. You use the PCUI sliders to tweak its speed and detection radius until it feels scary but fair. You use TransformControls to drag its spawn point to a better location.
5. **You prompt the AI to Save:** "Claude, lock the HunterBot speed at 15.0 and save the new spawn point."

**The Rule of Thumb:**
- If you are changing **how something feels or where it is**, use the PCUI Editor.
- If you are changing **how something thinks or adding something entirely new**, prompt the AI to write the code, and have the AI expose the new knobs to your PCUI Editor.
