# Manus Decisions Log

Autonomous decisions made by Manus while the user was unavailable. Each entry shows: timestamp, round, decision, rationale, reversibility (how to undo).

User should scan this file when re-engaging to override anything they disagree with.

---

## 2026-04-25 21:10 EDT — Round 9 priority pivot

**Decision:** Pivot Round 9 from "heightmap polish + Tier 2.7 cleanup" to "Tier 3.0 — Player Armor Quality Pass" with Sonnet first.

**Rationale:** User explicitly raised concern that current player armor model is not shippable visual quality (programmer geometry, no proper materials, no per-armor variants). Acknowledged this was correct critique — I had been grading on a curve. Visual fidelity is a blocker on stacking more systems.

**Why Sonnet first (not Opus):** User explicitly said "let's try Sonnet and see how it does." I'll write very specific acceptance criteria so Sonnet has clear targets. If Sonnet's first push doesn't meet them, Round 10 escalates to Opus.

**Reversibility:** Easy. If user wakes up and disagrees, revert the Round 9 commit and re-push the original heightmap-priority brief. Claude has ~5 min of heightmap work that's not lost (it'll either land in the next push or sit in `claude_status.md` notes).

**Sequencing:** Wait for Claude to finish heightmap push (in flight), then push Round 9 armor brief on top.

---

## 2026-04-25 21:10 EDT — Loop blocking rule changed

**Decision:** Manus will **never block on user**. Always make best-judgment call, log here, keep loop running. User can override async.

**Rationale:** User explicitly said: don't block on user, especially overnight. Cost of dead loop hours > cost of occasional revert.

**Reversibility:** N/A — process change, not a code change.

---

## 2026-04-25 21:18 EDT — Heightmap scope decision

**Decision:** Accept current 257×257 heightmap (2048×2048m at 8m/cell) as complete Raindance terrain. Skip LZH decompressor port. Skip 9-block stitch.

**Context:** Claude audited assets and found only `Raindance#0.dtb` exists. 1 of 9 possible blocks. Asked Manus for guidance: accept as complete, or port LZH decoder to verify larger encoding.

**Rationale:**
- Flag-to-flag distance is 640m. All buildings within ±500m of origin. Current 2048×2048m comfortably contains entire playspace.
- Missing 8 blocks would be outer fringe terrain nobody reaches.
- LZH decoder port is yak-shave — won't change player experience.
- Better to free Claude immediately for visual quality work (armor) which user explicitly raised as blocker.

**Reversibility:** Easy. If we later discover Raindance.dtb internally encodes a larger grid, we can decode it and stitch. The current 257×257 works as a fallback either way. No code thrown away.

**Conveyed to Claude in:** Round 9 feedback push (folded into the armor-pivot brief).

---

## 2026-04-25 21:25 EDT — Round 9.5 interrupt: stop armor work pending user assets

**Decision:** Push interrupt to Claude mid-flight on Tier 3.0 armor pass. Tell Claude to commit WIP and pause.

**Context:** User informed me they already own custom character models they want to use. Continuing Tier 3.0 polish on placeholder armor would be wasted work.

**Rationale:**
- Sunk-cost trap: any token spent on placeholder armor polish disappears when custom models drop
- Cascade work: every system touching the player model (weapons-in-hand, jetpack, animations, hit-box, third-person camera) will need to be tuned to whatever model is loaded — tuning twice is double cost
- User has clear vision; "recreate then enhance" no longer applies to this subsystem
- Better: get assets, integrate cleanly in Round 10

**Reversibility:** If user changes mind and wants to keep polishing placeholder, easy — re-push the original Round 9 brief. Claude's WIP will be preserved as a commit either way.

**Next step:** Wait for user to provide model files. Then Round 10 with integration brief.

---

## 2026-04-25 21:30 EDT — Round 10 model-free pivot stack

**Decision:** While user sources custom character models, run three model-free rounds in sequence: HUD/UI polish (R10) → Audio system (R11) → Match flow (R12).

**Context:** User said "I need to find models. Pivot for now. Anything else we can work that doesn't involve any models?"

**Why this stack:**
- HUD/UI polish: highest visual delight per token, all CSS/canvas, no 3D
- Audio: transformative for "feel like a game", I can source CC0 placeholder sounds
- Match flow: turns the playground into an actual playable match (timer, win conditions, scoreboard)

**Each round won't conflict with later character/material work** — HUD is overlay layer, audio is independent system, match flow is game logic.

**Reversibility:** When user drops models, can pause this stack any time and pivot back to character integration (Round X+).

---

## 2026-04-25 21:32 EDT — Drop Ascend asset pivot, accept Tier 3.0 baseline armor

**Decisions (two related):**

(1) **Drop the Ascend `.upk` asset-replacement pivot.** User uploaded `CH_TribesAscend.rar` containing `CH_TribesAscend.upk` (28 MB Unreal Engine 3 package). Two blockers: (a) `.upk` is UE3 binary format requiring umodel + Blender pipeline to convert to glTF; (b) Hi-Rez assets have IP/licensing concerns for a public WebAssembly port. User responded "skip this for now and go back to working on non model stuff."

(2) **Accept Claude's Tier 3.0 armor pass (`f3039a2`, 6/7 criteria) as the shippable baseline.** Originally I'd planned to interrupt this work (Round 9.5) but Claude's nudge timing meant the work landed first. On review the work is genuinely good — real T1 DTS files, proper specular shader fix, per-team color zones, idle breathing, jetpack thrusters. Better than what we had. Keep it.

**Rationale:**
- Tier 3.0 armor work is real value; throwing it away to wait for replacement assets that aren't coming would waste good work twice (once doing it, once redoing).
- Future asset upgrade is gated on user sourcing CC0/CC-BY sci-fi armored character glTFs (no Hi-Rez assets due to IP).
- In the meantime, model-free work (HUD, audio, match flow) keeps the loop productive.

**Reversibility:** Easy. Tier 3.0 armor stays in repo. When user provides clean glTF assets later, we do a Round X integration push that swaps the armor mesh-loading path; zone shader / specular / breathing / jetpack work all carries over.

**Active work pivot:** Round 10.5 re-confirms HUD/UI polish (Round 10 ask, restated for clarity since Round 10 manus_feedback.md is being overwritten).

---


## 2026-04-25 22:14 EDT — Three.js migration locked for Round 15-16

**Decision:** Migrate renderer to **Three.js** (not Babylon.js) at Rounds 15-16, after match flow / settings / bot AI but before any networking work.

**Context:** User raised "Three.js or Babylon.js for cheap optimization yet beautiful looks" with the explicit constraint of "browser multiplayer". Discussed trade-offs across renderer choice, cost, sequencing.

**Why Three.js (not Babylon):**
- ~150KB vs ~1.2MB bundle — better mobile and cold-cache perf
- We already have an engine (C++ WASM doing physics, AI, game state); we just need a smarter renderer. Three.js is "render library + you build engine" — fits. Babylon is "engine + you build game" — overlaps with what we have.
- Better community/examples (10× larger than Babylon)
- Raw GLSL still accessible for custom effects (jetpack flames, energy weapons)
- We already have Web Audio (Round 11), don't need Babylon's audio system

**Why now (Round 15-16, not later):**
- Every round we add hand-rolled GL increases the migration cost
- Doing it before networking means we don't have to rewrite the network/render boundary later (animations, position interpolation are exactly what Three.js handles well)
- After bot AI v2 (R14) is the right insertion point — gameplay logic doesn't touch renderer much

**Sequencing locked:**
- Round 13: Settings menu (no renderer impact)
- Round 14: Bot AI v2 (no renderer impact)
- **Round 15 (Opus 4.7 1M):** Three.js architecture round — design C++ ↔ Three.js bridge protocol, build parallel renderer that runs alongside existing one (toggleable via debug flag). Don't replace anything yet.
- **Round 16 (Opus 4.7 1M → Sonnet):** Cutover — migrate terrain, buildings, armor, projectiles to Three.js; delete old GL code.
- Round 17 (Sonnet): Visual quality cascade — PBR, shadows, particles, post-processing
- Round 18 (Opus): Network architecture design — WebRTC vs WebSocket+server, authority model, lag compensation
- Round 19+: Network multiplayer implementation

**Trade-off acknowledged:**
- 5-15% per-client perf overhead from Three.js scene-graph traversal — acceptable
- 2-3 round migration cost saves ~25 rounds of hand-rolled GL across remaining roadmap (PBR, shadows, particles, post-processing, glTF skeletal anim)

**Reversibility:** **High cost.** Once we build on Three.js, ripping it out is a rewrite. This is a real architectural commitment. User explicitly confirmed "yes lock it in."

**Override path:** User can change mind any round before R15; cost is just a small replanning round.


## 2026-04-25 22:38 EDT — Round 13.1 P0 HOTFIX (build broken)

**Decision:** Interrupt the queue (R14 bot AI v2 was next); push P0 hotfix brief to fix the broken Round 13 build before any new feature work. User-impacting bug — game is unplayable.

**Context:** Claude's Round 13 settings push (`832a150`) compiled and shipped, but the live game freezes the moment the user clicks Play. User reported "can't move the player." Console paste from user showed `Uncaught ReferenceError: $16 is not defined` thrown every frame from `broadcastHUD()`.

**Root cause:** `broadcastHUD()` in `wasm_main.cpp` lines 1086-1092 expanded to **17 args** to a single `EM_ASM` call (`$0` through `$16`). Emscripten only generates `$0`-`$15`. The thrown ReferenceError kills the main-loop iteration before physics runs, so keys[] are captured but `me.pos` never changes. ESC menu still works because that's pure browser-side JS, not on the WASM tick path.

**Secondary issue:** `WebGL: INVALID_OPERATION: useProgram: program not valid` spam, also new this round. A shader is silently failing to link. Asked Claude to add `glGetShaderInfoLog`/`glGetProgramInfoLog` print to `linkP()` so the next failure is debuggable, then identify and fix the broken program.

**Process miss:** I should have grepped for `EM_ASM.*\$1[6-9]` on the Round 13 review and caught this before approving. Adding to my standard pre-approval checklist for all future rounds.

**Reversibility:** Trivial — split the `EM_ASM` into two calls (HUD-state-A + a new HUD-state-B-match-only) and add a thin `window.updateMatchHUD()` shim in `index.html`. ~50 lines of diff. Once the hotfix lands, the settings menu code (which is otherwise solid) becomes accessible because the underlying main loop is alive again.

**Queue impact:** Round 14 (Bot AI v2) is delayed by one hotfix round. No long-term cost.
