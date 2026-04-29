# Item 14 Review — Delete Disabled Jet Exhaust (R32.166)

**Change:** -140 lines of dead code removed from `renderer.js`.
**Panel:** Carmack (code deletion — Pass 1 only)

---

## Pass 1 — Break It

**Saboteur:**
- **S1 (None):** Zero remaining references to any jet exhaust symbol. `grep -c` returns 0 for all symbols: `_jetPoints`, `_jetPos`, `_jetAge`, `_jetVel`, `_jetAlpha`, `_jetNextSlot`, `_jetEmit`, `JET_MAX`, `JET_LIFETIME`, `JET_SPEED`, `initJetExhaust`, `updateJetExhaust`.
- **S2 (None):** Both call sites were already commented out since R32.141. No behavior change.

**Audit correction:** Report listed rain (~100), grass ring (~290), and dust layer (~265) as disabled. Verified against code: all three have LIVE init() and update() calls. Only jet exhaust was truly dead. This is why we trust the code over the report.

---

## Verdict: ✅ PASS — Dead code removed. Zero regressions possible.
