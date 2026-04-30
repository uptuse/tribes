# Firewolf — Claude Hand-off Prompt

Copy everything below the line into Claude Code (or Claude Desktop / web) to start the production port.

---

You are taking over the **Firewolf** game's authoring tool port. The objective is to merge four legacy editor surfaces (`index.html`, `editor/index.html`, `editor/buildings.html`, `assets/models/animation_editor.html`) into a single in-game **unified shell** with twelve modes, and to extend that shell with eight new authoring modes that today either don't exist or are buried in the C++ code. The end state is a Unity/Godot-style editor that runs *inside* the same `index.html` as the game itself, sharing one `THREE.Scene`, one `WebGLRenderer`, one `GLTFLoader`, and one WASM physics module.

Do not start coding until you have read both of the following documents end-to-end and acknowledged them back to me with a one-paragraph summary of how they fit together.

## Sources of truth

1. **Integration Plan v2 (the spec).** This is the canonical, non-negotiable design document. It defines the twelve modes, the architectural invariants, the cross-cutting editor primitives (undo/redo, snap, layers, multi-select, camera bookmarks, playtest-from-cursor), the asset-upload flow, the visual system (color tokens, typography, voice rules, exemplar lock), the project/map management model, and the settings panel.
   - GitHub: https://github.com/uptuse/tribes/blob/master/docs/Integration_Plan.md
   - Read **all twelve sections**. Do not skip Sections 5, 8, 9, 10, 11, 12 — those are the parts that the original plan didn't cover and that took the most effort to land.

2. **Interaction prototype `firewolf_shell_sim` (the visual + UX reference).** This is a sketch-fidelity React prototype of the unified shell. It is not the production code — it is the *visual specification*. The look, the layout, the color palette, the typography, the wordmark, the welcome card, the top bar, the 12-tile mode grid, the slider primitive, the plain-English label voice — all of these are locked and must be ported as-is. Section 10.4 of the Integration Plan lists the five surfaces that are explicitly forbidden from being redesigned during the initial port.
   - The prototype is currently in Manus-internal storage; see the working sandbox URL below for the live preview, and ask the operator for a GitHub mirror if you need source access.

## Your priorities, in order

1. **Read the spec first.** Do not write any code until you have read the Integration Plan and inspected the prototype's visual surface. Acknowledge with a one-paragraph summary of how the twelve modes relate to the legacy four editors, plus a list of the five exemplar-locked surfaces.
2. **Honor the invariants in Section 5 absolutely.** One scene graph, one `three` dependency (version-pinned), one asset cache, one pause/resume contract, hot-reload as the only commit path, prototype-verbatim UI vocabulary. Two copies of `three` will silently break `instanceof` checks across the renderer; we have hit this before and we will not hit it again.
3. **Execute Milestones 1 → 6 in order.** Do not parallelize. Each milestone has a clear "done" condition and produces a commit you can roll back to.
4. **For every new label, button, toast, and log line you write, apply the voice rules in Section 10.5.** One verb per mode, no SCREAMING_CAPS, sliders show units, errors name the next action. This is not a stylistic preference; it is the spec.
5. **For every new UI surface, copy the prototype's visual vocabulary** (color tokens in Section 10.1, typography in 10.2, motion in 10.6). Do not reinvent the palette, the slider, the panel chrome, or the wordmark.
6. **The Animation Editor port (Milestone 4) is non-negotiable.** It must land in the final product. Do not rewrite it from scratch — read the existing `animation_editor.html` end to end first, then choose the integration path described in Milestone 4 step 2.

## What to ask the operator before you start

- The GitHub URL of the `firewolf_shell_sim` prototype (or the source code zipped, or shared sandbox access). You need it to copy `Wordmark.tsx`, `TopBar.tsx`, `HelpOverlay.tsx`, `ShellPanel.tsx`, and the slider primitive verbatim.
- Access to the existing Firewolf C++ source so you can extend the WASM hot-reload entry-point table in Section 6 (the `Module._reload*` functions).
- Confirmation of which branch to commit to (`master` is the default) and whether to open milestones as PRs or commit directly.

## Working agreement

- Commit at the end of each milestone with a message like `feat(shell): milestone 1 — mode switcher and camera detach`.
- Open a discussion (not a code change) before deviating from the plan in any way. The plan is the contract.
- If you find a contradiction in the plan, flag it before resolving it. Do not silently choose.
- The operator is non-technical. Surface progress in plain English, not in commit-hash chatter.

## Relevant links

| What | Where |
|---|---|
| Integration Plan v2 (spec) | https://github.com/uptuse/tribes/blob/master/docs/Integration_Plan.md |
| Tribes repo (game source + docs) | https://github.com/uptuse/tribes |
| Live prototype preview (sandbox) | https://3000-i1isb2gd8vflaquxkqm2e-14af83fe.us1.manus.computer |
| Prototype source location (Manus-internal) | `/home/ubuntu/firewolf_shell_sim/` — request a GitHub export from the operator |

Acknowledge receipt with the one-paragraph summary described above, then list any blockers (missing repo access, missing prototype source, missing C++ access) before you write a single line of code.
