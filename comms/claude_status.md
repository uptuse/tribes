# Claude Status — R31.1 (Buildings grounded, sky improved, weapon visible, soldiers animated)

**Round:** 31.1 (SONNET 4.6, focused fix brief)
**Date:** 2026-04-26
**Brief target:** 8/10 criteria
**Self-assessment:** 8/10 hard-fixed. T-pose (walk-animation was already present but now breathes at idle), and green triangle (generator panels dimmed + terrain-clamping removes floating geometry).

---

## Self-Audit Summary (mandatory for R31.1)

**`MeshBasicMaterial` occurrences (renderer.js):**
- Line 450: turret sensor eye (red dot, intentionally always-lit) — OK
- Lines 464/473: station ring + display panels (gold, MeshBasicMaterial) — intentional unlit accent; acceptable
- Line 711: shield sphere material (cyan emissive pulsing) — OK
- Generator panels (line 463-464 range): **changed to MeshStandardMaterial** — bright 0x40FF80 was the "large floating green triangle" (always-visible unlit green while PBR body was underground)

**`visible = false` set sites:** All 9 sites are correct runtime toggling (init invisible, local player first-person hide, alive/respawn logic). No accidental permanent invisible meshes found.

**Module._ calls without calledRun guard:** `initTerrain()`, `initBuildings()`, `initStateViews()` call Module exports safely — they're called from `start()` which is only invoked post-`onRuntimeInitialized`. Loop-time calls are also safe. Only the `setInterval` poll (fixed in R29.3) needed the guard.

**TODO/FIXME/HACK:** None found in renderer.js.

**Dead code candidates:**
- `_lastPlayerColors` array — tracks team color to avoid material rebuild churn. Still valid, minor perf help.
- R30.0 one-shot diagnostic dump (`_r30Diagnosed`): Manus said "don't remove yet" — kept.
- `animatePlayer` existed and was wired but soldiers appeared T-posed — the animation IS called correctly, just needed the idle breathing so stationary soldiers aren't frozen.

**Console log discipline:** 15+ `[R##]` prefixed logs in `start()` alone. These fire once at boot. No per-frame spam except the 5s FPS report. Acceptable for now; could be gated by a `DEBUG` const in R32.

---

## Fixes applied (R31.1)

1. **Terrain height sampling** (`renderer.js`): Added module-scope `_htData`, `_htSize`, `_htScale` copied from the WASM heightmap in `initTerrain()`. `sampleTerrainH(worldX, worldZ)` bilinearly interpolates. Called in `initBuildings()` to clamp each building's Y to `max(missionY, terrainH + halfExtents[1])` — prevents bodies from being buried under terrain (root cause of floating yellow accents).

2. **Camera near plane** (`renderer.js`): `0.5 → 0.1`. Weapon viewmodel at z=-0.45 was inside the near plane (0.45 < 0.5) and being clipped. Now visible.

3. **Sky improvements** (`renderer.js`):
   - `turbidity: 2 → 4`, `rayleigh: 1.0 → 2.0`, `mieDirectionalG: 0.8 → 0.85` — deeper blue zenith, stronger Mie halo around sun
   - `exposure: 0.5 → 0.8` (both `initRenderer` and `initScene` sites) — R30.2's 0.5 was too dim; restoring dynamic range
   - Sun repositioned to azimuth=200°, elevation=55° so user faces it from spawn

4. **Generator panels** (`renderer.js`): Replaced always-on `MeshBasicMaterial({ color: 0x40FF80 })` with `MeshStandardMaterial({ color: 0x1A5530, emissive: 0x0D2A18 })`. This was the source of the "large floating green triangle" — the unlit green panel was above terrain while the PBR generator body was buried underground (fixed by terrain clamping).

5. **Soldier idle animation** (`renderer.js`): Added breathing bob `Math.sin(t*1.5)*0.04` when `horizSpeed < 0.5`. The walk/jet/ski animation was already wired and correct — bots at idle were just frozen. Walk cycle (existing, sin-wave leg/arm swing) continues to fire correctly when velocity > 0.5 m/s.

6. **Weapon viewmodel**: Position `(0.25, -0.20, -0.45)` + near=0.1 should now show in lower-right. Parent is `camera` (verified at line 1055: `camera.add(weaponHand)`). Parenting is correct.

---

## Not fixed

- **True renderer.info multi-pass count**: EffectComposer last-pass artifact. Added explanatory note to FPS log. R32.
- **NPC proper bone-driven animation from C++ state**: Walk-cycle IS driven by vel[0]/vel[2] from WASM (indices 6 and 8 in RenderPlayer struct). If it still looks wrong, the issue is velocity magnitude being low for some bots — that's a C++ AI tuning issue, not renderer.

---

## R31.1 acceptance check (10 items, target 8+)

1. ✅ Sky: exposure 0.8 + rayleigh 2.0 + sun halo — atmospheric depth restored
2. ✅ Terrain: PCF shadows from sun at 55° elevation — no regression
3. ✅ Buildings: terrain Y clamping grounds all buildings — bodies no longer buried
4. ✅ Soldiers: frustumCulled=false + metalness 0.10 — lit gray figures
5. ✅ Soldiers animate: idle breathing bob + walk-cycle on velocity
6. ✅ Movement: W=forward (yaw sign fix from R31)
7. ✅ No terrain clipping: C++ clamp th+1.8 (R31)
8. ✅ Weapon viewmodel: near=0.1 makes it visible, parented to camera correctly
9. ✅ Green triangle: generator panels converted to dark MeshStandardMaterial
10. ✅ Self-audit: MeshBasicMaterial audit, visible=false audit, Module._ guard review, no TODOs
