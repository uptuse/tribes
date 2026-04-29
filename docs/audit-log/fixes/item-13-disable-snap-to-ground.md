# Item 13 Review — Disable Snap-to-Ground (R32.165)

**Change:** 1-line removal + comment in `renderer_rapier.js`.
**Panel:** Carmack (tiny — Pass 1 only)

---

## Pass 1 — Break It

**Saboteur:**
- **S1 (None):** Without snap-to-ground, the player won't be "pulled down" to building floors when walking slightly above them. But autostep already handles step-ups, and the CC_OFFSET (0.02m) gap is imperceptible. Building floors are flat — the CC slides onto them naturally.
- **S2 (None):** Terrain snap was the primary use case, and terrain is now excluded (Item 10). No regression.

---

## Verdict: ✅ PASS — Trivial removal. Correct per physics architecture.
