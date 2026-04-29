# Item 12 Review — Ceiling Velocity Correction (R32.164)

**Change:** 7 lines added to `stepPlayerCollision()`.
**Panel:** Carmack (small physics — Pass 1 only)

---

## Pass 1 — Break It

**Saboteur:**
- **S1 (Low):** The 50% threshold (`corrected.y < desiredMovement.y * 0.5`) could trigger on steep slopes where Rapier only allows partial Y movement. **Check:** With terrain excluded (Item 10), the only Rapier colliders are buildings/interiors. Slopes are handled by WASM. Building interiors have flat or near-vertical surfaces, so partial Y is genuinely a ceiling hit. **Verdict: Safe.**
- **S2 (None):** `desiredMovement.y` is `vy * dt` (from Item 11). When `vy > 0`, `desiredMovement.y > 0`. If Rapier allows < 50% of that, ceiling hit is detected. Arithmetic is correct.
- **S3 (None):** Both `corrected.y` and `desiredMovement.y` are small values (velocity × 1/60). No precision issues.

---

## Verdict: ✅ PASS — Prevents ceiling sticking.
