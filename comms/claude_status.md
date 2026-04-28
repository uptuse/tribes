# Claude Status — R32.68

**HEAD:** R32.68 (pending push)
**What shipped:** Per-triangle interior mesh collision — fixes building force field / teleportation, enables building entry through doorways.

## R32.68 — Per-triangle interior collision

### Problem
The old AABB-based collision used whole-building bounding boxes for interior shapes.
These oversized boxes created an "invisible force field" around every building (Manus
reported this in R32.1.3). Touching a building would eject the player instead of
allowing them to walk along walls or enter through doorways.

### Solution
Replaced whole-building AABB collision with per-triangle mesh collision:

**WASM side (`wasm_main.cpp`):**
- New `ColTri` / `ColMesh` data structures for world-space triangle storage
- `resolvePlayerInteriorCollision()`: capsule (two-sphere) vs triangle collision
  - Broadphase: player AABB vs mesh AABB (0.5m padding)
  - Narrowphase: sphere-vs-triangle closest-point test
  - Iterative solver (up to 4 passes) for multi-contact convergence
  - Velocity sliding along surfaces instead of ejection
  - Floor/ceiling detection from push direction
- `projectileHitsInterior()`: projectile-vs-triangle test for explosions
- `appendInteriorMeshTris()`: C export receiving world-space triangle data from JS
- Both local player and bot update loops call the new collision function

**JS side (`renderer.js`):**
- Replaced `appendInteriorShapeAABBs()` call with per-triangle data pipeline
- For each of 32 interior shape instances: transforms all triangles from DIS local
  space to world space (Rx(-π/2) → Ry(rotZ) → translate), computes world AABB,
  sends to WASM via heap allocation

**Build (`build.sh`):**
- Added `_appendInteriorMeshTris` to EXPORTED_FUNCTIONS

### Performance
- Broadphase AABB cull means only nearby meshes test triangles (typically 1-3 meshes per frame)
- MAX_COL_TRIS = 16384, MAX_COL_MESHES = 64 — well within budget for 32 interior shapes
- WASM binary grew ~26KB (622K → 648K)

### Phase 0 status
- [x] Fix building collision/teleportation — DONE (this commit)
- [x] Enable building entry — DONE (natural consequence of per-triangle collision)
- [ ] Lock building geometry — needs verification against canonical.json / .dis data

## Files changed
- `program/code/wasm_main.cpp`: +231 lines (collision system + export function)
- `renderer.js`: replaced AABB pipeline with triangle pipeline
- `build.sh`: added export
- `tribes.js` + `tribes.wasm`: rebuilt binary
- `index.html`: version chip → R32.68
