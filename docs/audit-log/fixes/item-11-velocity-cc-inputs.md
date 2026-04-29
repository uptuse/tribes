# Item 11 Review — Velocity-based CC Inputs (R32.163)

**Change:** ~10 lines changed in `stepPlayerCollision()`.
**Panel:** Carmack, Muratori (medium physics — Pass 1 + Pass 4)

---

## Pass 1 — Break It

**Saboteur:**
- **S1 (Low):** Using `v*dt` instead of position delta means the desiredMovement doesn't include WASM's terrain clamp correction (WASM may have moved the player up from where velocity alone would put them). **Verdict:** This is correct — we WANT to ignore terrain clamp in Rapier (Item 10). Rapier should resolve building collision based on velocity intent, not terrain-clamped position.
- **S2 (Low):** Re-syncing `lastCorrectedPos` to WASM pos every frame means Rapier corrections from the PREVIOUS frame are lost — WASM doesn't know about them. But wait: `playerView[o+0/1/2]` is written back to WASM in the same function. So WASM DOES know about the correction for the next tick. **Verdict: Safe** — the write-back at the bottom of the function persists corrections to shared memory.
- **S3 (None):** `dt` is passed as `1/60` from renderer.js (line ~5303). Consistent with WASM's tick rate.

## Pass 4 — System-Level

**Before:** Movement = where_WASM_ended_up - where_Rapier_last_put_us. If WASM terrain-clamped upward but Rapier pushed sideways, the delta was diagonal when the intent was just horizontal. Over 100 frames, these phantom deltas accumulated into visible drift.

**After:** Movement = velocity × dt. Pure intent. WASM pos is used as the starting point each frame (re-sync). No accumulated error.

---

## Verdict: ✅ PASS — Cleaner physics model. No drift accumulation.
