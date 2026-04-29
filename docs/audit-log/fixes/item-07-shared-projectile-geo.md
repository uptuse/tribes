# Item 7 Review — Shared Projectile Geometry (R32.159)

**Change:** 3-line refactor in `initProjectiles()` — shared geometry + material.
**Panel:** Carmack, ryg (small perf change — Pass 1 + Pass 4)

---

## Pass 1 — Break It

**Saboteur:**
- **S1 (Low):** If any code mutates a projectile mesh's geometry (e.g., scaling per weapon type), all 256 meshes would change since they share the reference. **Check:** `grep -n 'projectileMeshes.*geom\|projectileMeshes.*material' renderer.js` → no hits. Projectile meshes are only positioned and toggled visible/invisible. No per-mesh geometry mutation. **Safe.**
- **S2 (None):** Three.js correctly reference-counts shared geometry/material. Disposing one mesh doesn't destroy the shared resources. All projectiles are pooled (never disposed individually).
- **S3 (Note):** If we later want per-weapon-type projectile visuals (disc=flat, plasma=sphere, etc.), we'd need multiple geometries. But that's a feature addition, not a regression. The current code treats all projectiles identically.

## Pass 4 — System-Level

**Memory budget:** SphereGeometry(0.20, 10, 8) = 10 segments × 8 rings = ~160 vertices × 32 bytes = ~5KB per geometry. 256 copies = ~1.3MB geometry alone, plus material GPU state. After: ~5KB total. Net savings: ~1.3MB geometry + material overhead.

**Draw call impact:** Three.js r167's WebGLRenderer can batch meshes sharing the same geometry+material reference, reducing draw call count proportionally. For 20 active projectiles on screen, this could be 20 draw calls → 1-2 batched calls.

---

## Verdict: ✅ PASS — Pure win. No regressions.
