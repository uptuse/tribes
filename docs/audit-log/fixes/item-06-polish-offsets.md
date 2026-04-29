# Item 6 Review — renderer_polish.js Velocity Offset Fix (R32.158)

**Change:** 3-line edit in `renderer_polish.js` — fix HEAPF32 offsets from `o+4,o+5,o+6` to `o+6,o+7,o+8`.
**Panel:** Carmack (tiny change — Pass 1 only)

---

## Pass 1 — Break It

**Saboteur:**
- **S1 (None):** Cross-referenced with every other velocity reader in the codebase:
  - `renderer.js:3856-3857`: `animatePlayer(mesh, playerView[o + 6], playerView[o + 8], ...)` ✓
  - `renderer.js:3867`: `Math.hypot(playerView[o + 6], playerView[o + 8])` ✓  
  - `renderer_characters.js:208`: `Math.hypot(playerView[o + 6], playerView[o + 8])` ✓
  - All agree: offset 6=vx, 8=vz (7=vy). Polish was the only outlier.
- **S2 (None):** The `|| 0` fallback is preserved — handles cases where the view isn't populated yet.

**Root cause confirmed:** When the RenderPlayer struct was extended (adding padding at offset 5), renderer_polish.js was not updated to match. It was reading yaw (offset 4) as vx, which produced erratic speed values (yaw ranges -π to +π ≈ 0-3.14, so "speed" showed 0-3.14 m/s instead of actual 0-70 m/s).

---

## Verdict: ✅ PASS — Verified against 4 other consumers. Correct.
