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
