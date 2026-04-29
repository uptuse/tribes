# Item 10 Review — Terrain Collision Groups (R32.162)

**Change:** Collision group system added to `renderer_rapier.js`. ~20 lines.
**Panel:** Carmack, Muratori (medium physics change — Pass 1 + Pass 4)

---

## Pass 1 — Break It

**Saboteur:**
- **S1 (Medium):** `computedGrounded()` after excluding terrain may always return false when standing on terrain (not near buildings). This breaks the `grounded && vy < 0 → zero velocity` logic. **Mitigation:** WASM already handles terrain-based grounding. The Rapier `grounded` flag should only reflect building/interior floor contact. `window._rapierGrounded` is used for interior grounding only. **Verdict: Acceptable — terrain grounding is WASM's job.**
- **S2 (Low):** Player filter `0xFFFC` excludes groups 0 and 1. Group 0 is the player's own group. This means player capsule doesn't collide with itself — fine (there's only one player in Rapier). But if more player capsules were added, they wouldn't collide with each other. **Verdict: Non-issue for current single-player CC architecture.**
- **S3 (None):** The collision group format `(filter << 16) | membership` is correct per Rapier docs.

## Pass 4 — System-Level

**Before:** Every frame: WASM clamps Y to terrain → Rapier CC pushes Y up by CC_OFFSET (0.02m) → next frame WASM clamps back down → oscillation. Visible as micro-jitter, especially on slopes.

**After:** Rapier CC ignores terrain entirely. Movement resolution only considers buildings and interiors. WASM's terrain clamp is the sole authority on terrain Y. Zero oscillation.

**Note:** The terrain heightfield still exists in Rapier's world (for potential future raycasting/queries). It just doesn't affect character movement.

---

## Verdict: ✅ PASS — Eliminates double-clamp jitter. Clean separation of concerns.
