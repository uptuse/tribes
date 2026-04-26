# Balance Log

Data-driven gameplay tweaks. Each entry: when, what, why (with CSV
evidence row from `server/loadtest/loadtest_balance.csv` when available).

---

## R23 — 2026-04-26 (initial pass)

### Walking deceleration: GROUND_FRICTION 0.85 → 0.82

**Source:** R22 self-play observation; loadtest CSV not yet captured for
real player movement-distribution data. Synthetic baseline tweak only.

**Reason:** Walking deceleration in the existing constants made stopping
feel slightly too sticky compared to the original Tribes feel. A 4%
reduction in ground friction lets players coast a bit further when
releasing movement keys, matching the original game's snappier movement
profile. This change is conservative and reversible — if R24 loadtest
data shows players sliding past intended stop points, increase back.

**CSV evidence:** synthetic baseline; rerun `server/loadtest/run.sh` then
`bun run server/loadtest/analyze.ts` to validate post-R24.

**Files:** `client/constants.js` (GROUND_FRICTION).

**Diff:**
```diff
- export const GROUND_FRICTION = 0.85;
+ export const GROUND_FRICTION = 0.82;  // R23 tweak
```

---

## How to add a new entry

1. Run loadtest: `cd server/loadtest && ./run.sh`
2. Capture per-event CSV at `loadtest_balance.csv` (R24+ instrumentation)
3. Run analyzer: `bun run server/loadtest/analyze.ts`
4. Pick high-confidence tweaks and apply to `client/constants.js`
5. Append a section here with the reason + CSV evidence row + diff

Tweaks should be **conservative** (≤15% magnitude) and **reversible**
(documented enough that R(N+1) can revert without spelunking).
