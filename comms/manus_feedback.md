# R31.1 — Visual misses + IMPRESSIVE skybox + end-to-end self-audit

**Model:** Sonnet 4.6
**Round type:** Polish + self-audit (NOT an emergency)
**Estimated scope:** 90–180 min; multiple small fixes + skybox quality bump + comprehensive code audit
**Acceptance threshold:** 8/10 hard criteria (raised from R31's 6/9 because the bar is "user can actually playtest and enjoy it")

---

## TL;DR for Claude

Great work on R31 — soldiers ARE visible, ground clamp held, yaw fixed. But the user just played and the verdict is mixed. Buildings still float as yellow blocks, soldiers still T-pose AND float above ground, weapon viewmodel still invisible, and **the user explicitly called the skybox "really disappointing."**

Three asks for R31.1:

1. **Fix the remaining visual misses** (5 items, listed below)
2. **Make the skybox actually impressive** — not just a blue gradient, a real atmospheric sky worthy of a 2026-era browser game
3. **End-to-end self-audit your own R18-R31 renderer code** — find dead code, inconsistencies, silently-failing branches, accidental MeshBasicMaterials, etc.

User quote: "The skybox is still really disappointing."

---

## Direct evidence — user's R31 playtest video (analyzed)

> 1. Sky: pale, hazy blue/off-white, lacking detail like clouds
> 2. Terrain: rolling hills, repetitive low-resolution grass/dirt texture, lighting flat and uniform without distinct shadows
> 3. Buildings: NO complex buildings — just simple, large, yellow rectangular block structures, floating slightly above the ground
> 4. Soldiers: red and blue characters visible, blocky humanoid figures, completely static T-pose, floating above the ground, no animation
> 5. Weapon/hand: NOT visible anywhere on screen
> 6. Movement: appears disconnected — camera looks around but character slides independently of camera orientation
> 7. HUD: complete and good (crosshair, health/energy bars, ammo counter, scoreboard, event log)
> 8. Glitches: numerous yellow cubes and rectangular blocks floating in the air; a large flat green triangle floating near beginning
> 9. No falling through ground (R31 ground clamp held — good)

So R31 wins (per acceptance criteria): **player ground-clamp ✓, soldiers visible ✓, movement direction better ✓ (3/9 fully)**.
R31 misses or partial: **buildings, NPC animation, weapon, skybox, sky exposure, entity ground-clamp (6/9 still bad)**.

---

## Bug list for R31.1 (ranked)

### 1. Buildings still floating yellow blocks (CRITICAL)

R31 added `frustumCulled=false` traverse to building groups. Body meshes still don't render — only the unlit yellow accents.

Likely root cause: building body MeshStandardMaterial cylinders/cubes are constructed with bbox=(0,0,0) (per R30.0 diagnostic), and even with `frustumCulled=false`, Three.js may skip them in shadow or transparency passes. OR — more likely — they have `visible=false` set somewhere, OR they're being added to a scene-detached Group that itself has visible=false.

**Diagnostic-first approach:**
- Add a one-shot per-building dump on first frame: `for (b of buildingMeshes) console.log('[R31.1] bldg', i, 'pos', b.position, 'visible', b.visible, 'children:', b.children.map(c => ({type: c.type, mat: c.material?.type, visible: c.visible, opacity: c.material?.opacity})))`
- Confirm whether body meshes have `visible=true` AND `opacity=1` AND a non-null `material.color` — if any of these is wrong, that's the bug.
- If diagnosis confirms body meshes look correct on the JS side, the issue is rendering: try `mesh.material.transparent = false; mesh.material.depthWrite = true; mesh.material.depthTest = true; mesh.material.needsUpdate = true;`

### 2. Buildings & soldiers float above terrain (HIGH — C++)

C++ `setMapBuildings()` and `_getPlayerStatePtr()` are returning Y values that don't account for the heightmap. R31 fixed the local player ground-clamp but not the spawn positions for entities.

Fix in C++ `loadMission()` (or wherever buildings are placed): for each building, sample `terrainHeightAt(b.x, b.z)` from the heightmap and set `b.y = max(b.y, terrainHeight + 0.5)`. Same for player/bot spawn points: clamp to `terrainHeight + 1.7` at spawn, not just every-frame.

### 3. The "really disappointing" skybox (HIGH)

User explicitly called this out. Current state per video: pale, hazy blue/off-white, no clouds, no sun visible, no atmospheric depth.

What we have now: THREE.Sky with rebalanced uniforms (turbidity 2, rayleigh 1.0, mieG 0.8) + ACESFilmic tone mapping at exposure 0.5. The 0.5 exposure is *too low* — it kills the dynamic range of the sky shader and makes everything washed out.

**Real upgrade options (pick one or layer them):**

a) **Tune Sky uniforms back up + raise exposure.** Try turbidity=4, rayleigh=2, mieCoefficient=0.005, mieDirectionalG=0.85, exposure=0.8. This gives Mie scattering halo around the sun, deeper blue at zenith, warm tint near horizon. Position sun at high-noon-but-slightly-west so users see it.

b) **Add procedural cloud layer.** A simple 2D plane at high altitude with a Worley/Perlin-noise-based shader, scrolling slowly. Doesn't need to be 3D — even a flat layered cloud texture rendered at z=skybox_radius * 0.7 with `depthWrite=false` looks great. Lots of Three.js examples (search "three.js procedural clouds shader").

c) **Use a real HDRI.** Vendor a single 2K equirectangular HDR sky into `assets/sky/`. CC0 sources: PolyHaven (sweeping mountain skies, perfect for Tribes vibes). Load via `RGBELoader` and assign to both `scene.background` and `scene.environment`. This is the highest-quality option and would also replace our current PMREM-from-Sky pipeline (the HDRI directly drives PBR ambient lighting).

**Recommend (a) + (b)** — keep the Sky shader for atmospheric scattering, layer clouds on top. Don't add an HDRI dependency until R32.

Whatever you do, **raise exposure to at least 0.8**. The current 0.5 makes everything look like a 2003 game with a flat ambient pass.

### 4. Weapon viewmodel still invisible (MEDIUM)

R31 repositioned to (0.25, -0.20, -0.45) but it's still not on screen. Three things to check:

a) Is the weaponHand actually parented to the camera? `console.log(weaponHand.parent === camera)` — if false, it's in scene root and won't move with the view.
b) Does the weapon material have `color`/`map` and `opacity=1`?
c) Is the camera's near-plane causing it to clip? Currently near=0.5 — try near=0.01 + the (0.25, -0.20, -0.45) position.

If the answer is "all good and still invisible", then the weapon has `visible=false` set somewhere OR the geometry is degenerate. Add a one-shot dump on first frame to print weapon's bounding box, scale, and material.

### 5. Mysterious floating green triangle (LOW)

Video shows a "large flat green triangle" near the beginning. Probably a debug helper/axis or a half-constructed mesh from the spawn-shield system or HUD overlay. Find and either delete or hide.

### 6. Soldiers stuck in T-pose (HIGH — C++ animation)

This was deferred from R31. It's the biggest remaining gameplay-feel bug. Two paths:
- Easy: add at least a basic walk-cycle when the player has horizontal velocity. Even a simple sin-wave-driven leg/arm swing would be huge improvement over T-pose.
- Proper: bridge C++ animation state (per-bone transforms) to JS skeleton, drive the SkinnedMesh per frame.

If you can do the easy version in this round, do it. The proper version can be R32.

---

## End-to-end self-audit (mandatory)

After patching, **read your own R18-R31 renderer code** with fresh eyes. Specifically grep through `renderer.js` for:

1. **`MeshBasicMaterial`** — every occurrence. For each, ask: is this intentionally unlit? Or did I forget to use MeshStandardMaterial? Many of our visible bugs are MeshBasic accents that should be MeshStandard or that should be deleted entirely.

2. **`visible = false`** — every set site. Are any of these accidentally permanent? Should anything be `visible = true` that isn't?

3. **`frustumCulled = false`** — recent additions. Any meshes that DON'T need this and could be reverted for perf?

4. **`bbox` / `boundingSphere`** computation — for every SkinnedMesh / Group, is the bounding box correct? Should we explicitly call `geometry.computeBoundingSphere()` after construction?

5. **Dead code** — any module-level variables, functions, or branches that are never reached? Any leftover R15/R17 legacy renderer code that could be deleted now that Three.js is the default?

6. **Console log discipline** — too many `[R##]` logs accumulating; consolidate or gate behind a `DEBUG` flag.

7. **`Module._*` calls with no calledRun guard** — any new ones added in R31 that would crash in ASSERTIONS mode?

8. **TODO/FIXME/HACK** comments — collect them, list them, decide which need fixing now.

Write a short audit summary at the top of `claude_status.md` with your findings. Even if you don't fix everything, the inventory itself is valuable for future rounds.

---

## Acceptance criteria (10 items, target 8+)

After R31.1 deploys and user reloads with cache buster, they should see:

1. ✅ **Sky**: visible sun + clear blue gradient + at least subtle atmospheric depth (no longer "really disappointing")
2. ✅ **Terrain**: lit with visible shadows from sun
3. ✅ **Buildings**: gray PBR turrets/stations on the ground, NOT floating yellow blocks
4. ✅ **Soldiers**: visible, correctly colored (red/blue team), on the ground, NOT floating
5. ✅ **Soldiers**: at least basic limb animation when moving (no full T-pose)
6. ✅ **Movement**: W goes forward, A/D strafes, mouse looks — feels natural
7. ✅ **No terrain clipping** (already fixed in R31, must not regress)
8. ✅ **Weapon viewmodel**: clearly visible in lower-right
9. ✅ **No mystery floating green triangle**
10. ✅ **Self-audit summary** in `claude_status.md` listing dead code / suspicious patterns / TODOs found

Land at least 8/10. NPC proper-rig-from-WASM animation can be R32.

---

## Things to NOT change

- Don't revert R29-R31 fixes
- Don't touch the comms format
- Don't add new features (no new gear, no new maps, no new chat, etc.) — pure fix + audit round
- Don't bump version footer past `0.4 / R29 hotfix` until R31.1 actually ships

---

## Open question

Should we delete the legacy WebGL renderer in this round (your R30-deferred plan), or wait until after the user does a satisfying playtest? My take: defer to R32. Right now the user just wants to play, not see a clean codebase.

---

Cron will trigger you in ~5 min. Take whatever time you need; aim for a comprehensive landing rather than another partial fix. Thanks.
