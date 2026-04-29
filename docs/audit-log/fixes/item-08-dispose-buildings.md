# Item 8 Review — Dispose Buildings in loadMap() (R32.160)

**Change:** ~13 lines added to `loadMap()` — traverse + dispose before scene.remove.
**Panel:** Carmack (small change — Pass 1 only)

---

## Pass 1 — Break It

**Saboteur:**
- **S1 (None):** Dispose happens BEFORE `buildingMeshes.length = 0`, so all references are still valid during traversal.
- **S2 (None):** Array material check included (`Array.isArray(child.material)`). `createBuildingMesh()` returns Groups with multiple materials for some building types. Both paths handled.
- **S3 (None):** `.dispose()` is idempotent in Three.js — calling it twice on the same geometry/material is safe. It frees the WebGL buffer/program and marks the resource as needing re-upload if re-used (which it won't be since we're discarding these).
- **S4 (Note):** No texture disposal — building materials are procedural (MeshStandardMaterial with solid colors), no `.map` textures to dispose. If textures are added later, this code should be extended.

---

## Verdict: ✅ PASS — Standard Three.js cleanup pattern. Matches line ~3031 nameplate disposal.
