# Tribes Project — Lessons Learned

Read this file every time you're debugging or problem-solving. These are hard-won fixes.

---

## 1. Cache Bust Mismatch (R32.138)
**Issue:** All changes to `renderer_characters.js` were invisible — ski board, jet flames, foot offset, model rotation — none showed up.
**Root cause:** The `?v=XXX` cache bust parameter in the `import` statement in `renderer.js` was stuck at `?v=128` while the file was on version 137. Browser cached the old module.
**Fix:** Always verify the actual cache bust value in `renderer.js` before pushing. The sed replacement must match the CURRENT value, not what you think it is.
**Rule:** After editing `renderer_characters.js`, always `grep 'renderer_characters' renderer.js` to confirm the cache bust updated.

---

## 2. Model-Local vs World Scale (R32.140)
**Issue:** Ski board rendered as a 30m × 80m blue plane across the entire map. Flame cones were positioned 100 units away from the character.
**Root cause:** Meshes added as children of the GLB scene root (which is scale 1.0), but dimensions were written in centimeters (assuming the armature's 0.01 scale applied). The armature scale only affects bones/skinned meshes, not siblings added to the scene root.
**Fix:** Use world-scale meters for any mesh added to the model root: `PlaneGeometry(0.35, 0.9)` not `PlaneGeometry(30, 80)`. Positions in meters, not centimeters.
**Rule:** When adding child meshes to a GLB model, always check what coordinate space the parent is in. The armature's 0.01 scale does NOT propagate to siblings of the armature.

---

## 3. Terrain Poking Through Buildings (R32.139 → R32.140)
**Issue:** Terrain mesh visibly poked through building entrances and lower doorways. Buildings are hobbit-holed into hillsides.
**Root cause:** The heightmap terrain was never carved out under building footprints. Original Tribes sculpted terrain around buildings.
**First attempt (R32.139):** Used WASM building AABBs — too coarse, didn't match actual geometry.
**Fix (R32.140):** Use `interiorShapesGroup` — the actual placed interior meshes. Compute world-space bounding box per shape, depress terrain vertices within XZ footprint + 3m margin below shape's min Y.
**Rule:** Always use the tightest available geometry for spatial queries. Prefer actual mesh bounds over AABB approximations.

---

## 4. Particle System Architecture (R32.134 → R32.136)
**Issue:** Ski particles created in `renderer_characters.js` were never visible, despite being added to the scene.
**Root cause:** Multiple problems: `emitCount = Math.floor(speed / 5)` = 0 at low speeds (no particles emitted), different shader architecture from the proven jet exhaust system, cache bust stale (see #1).
**Fix:** Clone the working jet exhaust system in `renderer.js` — same pool pattern, same shader, same emit loop. Just change color and emission source.
**Rule:** **Clone what works.** When adding a system similar to an existing one, duplicate the working code and modify it. Don't reinvent in a different file with a different pattern.

---

## 5. Dual Physics Convention (R32.130)
**Issue:** Character model sinks through building floors in 3P view.
**Root cause:** Two physics systems write `playerView[o+1]` with different conventions:
- WASM (terrain): `playerY = terrainH + 1.8` (capsule offset baked in)
- Rapier (buildings): `playerY = floorH` (raw floor height, no offset)
The grounding code always subtracted 1.8, correct for terrain but wrong for buildings.
**Fix:** Expose `window._rapierGrounded` from the Rapier collision step. When Rapier-grounded, use `playerY` directly (no offset). When on terrain, subtract 1.8.
**Status:** Partially working — Rapier cuboid colliders don't provide interior floor collision yet. Full fix requires trimesh colliders for interior geometry.

---

## Template for new entries:
```
## N. Short Title (RXXXX)
**Issue:** What was observed
**Root cause:** Why it happened
**Fix:** What was done
**Rule:** What to always do going forward
```
