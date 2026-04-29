# Firewolf — Feature Gate Process

Every new feature goes through these gates in order. You cannot skip a gate. Each gate produces a deliverable. If a gate fails, go back — don't push through.

This process applies to the AI (Hatch) and the human (Levi) equally.

---

## Gate 1 — JUSTIFY *(5 min, before any code)*

Answer in writing:
1. **Which Core Feeling does this serve?** (Belonging / Adaptation / Scale / Aliveness) — if none, it doesn't get built.
2. **What exists that already does something similar?** Check `docs/patterns.md`. If similar, clone it.
3. **What breaks if this fails?** Scope the blast radius.

**Deliverable:** 3-sentence justification.
**Kill criterion:** Doesn't serve a Core Feeling, or duplicates an existing system.

---

## Gate 2 — DESIGN *(15-30 min)*

Write a brief spec:
- What does the player experience?
- Data model (inputs, state, outputs)
- What existing modules does it touch?
- Performance budget (draw calls, ms per frame, memory)
- Quality tier behavior (Low/Medium/High/Ultra — degrade or disable?)

**Deliverable:** Design spec (can be in commit description or scratch doc).
**Kill criterion:** Can't estimate performance cost = don't understand the feature yet.

---

## Gate 3 — CONTRACT *(10 min)*

Write the `@ai-contract` block BEFORE writing any code:

```javascript
// @ai-contract
// PURPOSE: [one sentence]
// SERVES: [Belonging | Adaptation | Scale | Aliveness]
// DEPENDS_ON: [modules this reads from]
// EXPOSES: [what other modules will use from this]
// PATTERN: [canonical pattern from docs/patterns.md, or "new" if novel]
// PERF_BUDGET: [draw calls, ms, memory]
// QUALITY_TIERS: [low=off | low=reduced | etc.]
// @end-ai-contract
```

If PATTERN is "new" — that's a yellow flag. You're inventing architecture. Justify why no existing pattern works.

**Deliverable:** `@ai-contract` block ready to paste into the file header.
**Kill criterion:** Can't name the pattern = probably reinventing something.

---

## Gate 4 — IMPLEMENT *(the actual work)*

Write the code following:
- The contract from Gate 3
- The canonical pattern from `docs/patterns.md`
- `@ai-contract` block at top of file
- Read relevant `docs/lessons-learned.md` entries FIRST

### AI Pre-Commit Checklist

Before every commit, verify:
```
[ ] Cache bust updated in renderer.js import? (if imported module)
[ ] Coordinate space correct? (world meters, Y-up)
[ ] No new window.* globals? (or documented in @ai-contract EXPOSES)
[ ] Performance budget met? (measured, not guessed)
[ ] Quality tier fallback tested on Low?
[ ] @ai-contract block present and accurate?
[ ] lessons-learned.md consulted?
[ ] Version chip bumped in index.html?
```

**Deliverable:** Code + passing checklist.

---

## Gate 5 — ISOLATE *(30-60 min for visual, less for logic)*

Build or update a test harness:
- **Visual systems:** Standalone HTML page following `test/buildings_test.html` template
- **Logic systems:** Console-based validation or unit test
- **Template:** Copy buildings_test.html, replace module import + test buttons. Same HUD, same FPS counter, same console capture.

Run the test. Fix what breaks. Proceed only when green.

**Deliverable:** Working test harness at `test/<feature>_test.html`.
**Kill criterion:** Feature doesn't work in isolation = not ready for integration.

---

## Gate 6 — INTEGRATE *(wire into main game)*

- Import / call from appropriate orchestration point
- Run `test/integration_full_frame.html` — verify nothing broke
- Measure frame time before and after (must stay within budget)
- Verify interaction with: phase system, quality tiers, day/night cycle

**Deliverable:** Feature running in the main game, frame time verified.
**Kill criterion:** Frame time regression beyond budget.

---

## Gate 7 — REVIEW *(adversarial pass, scaled to size)*

| Feature Size | Review Level | Time |
|---|---|---|
| **Small** (<100 lines, follows existing pattern) | Pass 1 (Saboteur) + Pass 4 (System-Level) | 10 min |
| **Medium** (100-500 lines, new module) | Pass 1 + Pass 4 + Pass 5 (AI Rules) | 30-45 min |
| **Large** (>500 lines, new system/pattern) | Full 6-pass Adversarial Convergence Review | 1-2 hrs |

Risk overrides size: a 50-line physics change is higher risk than a 300-line HUD overlay. When in doubt, review more, not less.

Experts selected from `docs/review-cohort.md` based on module domain.

**Deliverable:** Review log appended to `docs/audit-log.md`. Fixes applied.

---

## Gate 8 — EARN ITS PLACE *(the Ive test)*

Play the game with the feature ON. Play it with the feature OFF.

**If you don't miss it when it's gone, it doesn't ship.**

Building something, testing it, and removing it isn't failure — it's curation. The game should only contain things that make it meaningfully better.

**Deliverable:** Ship/No-ship decision.

---

## Quick Reference: The Gates

```
1. JUSTIFY    → Does it serve a Core Feeling? Is it novel?
2. DESIGN     → What's the spec? What's the perf budget?
3. CONTRACT   → @ai-contract block. What pattern? What dependencies?
4. IMPLEMENT  → Code it. Pre-commit checklist.
5. ISOLATE    → Test harness. Works alone?
6. INTEGRATE  → Wire in. Nothing broke? Frame time ok?
7. REVIEW     → Adversarial pass (scaled to risk).
8. EARN       → Game better with it? Miss it without it?
```

---

## When to Invoke the Full Cohort

Not every feature needs The Room. Use this escalation:

| Situation | Who Reviews |
|---|---|
| Bug fix, <50 lines | Just the AI pre-commit checklist |
| Small feature, follows pattern | Saboteur + System-Level (10 min) |
| New module, new visual system | Break It + System-Level + AI Rules (30-45 min) |
| New gameplay system, architecture change | Full 6-pass review with relevant experts from `docs/review-cohort.md` |
| Design question ("should we build X?") | Design Panel (Ive, Chen, Ueda, Wright) + Carmack + Muratori |
| "Something feels wrong" | Gate 8 — play with it on, play with it off |
