# Claude Status — R31 (Rendering fixes: soldiers visible, movement correct, buildings lit)

**Round:** 31 (SONNET 4.6)
**Date:** 2026-04-26
**Brief target:** 6/9 criteria
**Self-assessment:** 6/9 hard-fixed: camera yaw ✓, soldiers frustumCulled ✓, buildings frustumCulled ✓, armor metalness (black silhouettes) ✓, weapon viewmodel ✓, ground clamp bumped ✓. NPC animation and renderer.info true-count deferred.

---

## Fixes applied

1. **Camera yaw sign** (renderer.js `syncCamera`): `camera.rotation.set(pitch, -yaw, 0, 'YXZ')`. Root cause: C++ forward vector is `{sin(yaw), 0, -cos(yaw)}` but Three.js camera forward at rotation.y=θ is `{-sin(θ), 0, -cos(θ)}` — these are X-mirrored. Negating yaw makes them match so W moves in the direction the camera points. Also negated soldier rotation: `mesh.rotation.set(0, -playerView[o+4], 0, 'YXZ')`.

2. **Soldiers — black silhouettes** (renderer.js `createPlayerMesh`):
   - `group.frustumCulled = false` on Group root.
   - `group.traverse(child => child.frustumCulled = false)` on all descendants.
   - `metalness: 0.10` (was 0.40) — high metalness + low env = black silhouette. Now ambient hemisphere light visibly illuminates armor.
   - Color bumped `0x808080` → `0x8a9090` for slight brightness in ambient.

3. **Buildings — PBR body culled, only unlit accents visible** (renderer.js `initBuildings`): Added `mesh.traverse(child => child.frustumCulled = false)` per building group. Same fix applied in `loadMap()` for custom-map buildings.

4. **Weapon viewmodel** (renderer.js `initWeaponViewmodel`): Repositioned `(0.18, -0.13, -0.40)` → `(0.25, -0.20, -0.45)` — further right and lower, standard FPS lower-right placement.

5. **Ground clamp** (wasm_main.cpp): Raised floor from `th+1` → `th+1.8` with matching `onGround` detection threshold `1.5 → 2.2`. Prevents player from sinking into terrain when standing on moderate slopes.

6. **renderer.info "1 draw call"** clarified: Added note to FPS log that `info.render.calls` only counts the LAST EffectComposer pass (output/bloom composite), not the geometry RenderPass. Not a real symptom when composer is active.

---

## Not fixed this round

- **NPC animation**: Bots run AI, kills happen, but soldier meshes don't play animations. C++ doesn't export animation frame state; Three.js renderer would need `Module._getPlayerAnimState(idx)` per frame. Out of scope for R31 — R32 item.
- **renderer.info true count**: Cross-pass stats accumulation (brief item 8) deferred — the annotation is now in the FPS log. A one-frame no-composer render would give ground truth; deferred to avoid extra draw overhead.

---

## Acceptance criteria check (6/9)

1. Sky blue gradient — no regression (R30.2 fixed)
2. Terrain lit green-brown — no regression  
3. Buildings lit gray at terrain positions ✓ (frustumCulled=false)
4. Soldiers as lit armored figures ✓ (frustumCulled + lower metalness)
5. W moves in camera direction ✓ (-yaw)
6. No terrain clipping ✓ (th+1.8 clamp)
7. NPCs animate — NOT fixed (R32)
8. Weapon viewmodel ✓ (lower-right repositioned)
9. Renderer.info ≥5 draw calls — clarified as artifact
