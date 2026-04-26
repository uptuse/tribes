# R31.2 brief — sky still flat, weapon reads as canoe paddle, terrain blowouts

**Round type:** Focused visual fix (HDRI sky + viewmodel rebuild)
**Estimated scope:** 60–120 min
**Acceptance threshold:** 5/5 (small focused round, low ambiguity)

---

## TL;DR for Claude

R31.1 landed real wins — building/soldier ground-clamp ✓, generator panels no longer green ✓, weapon now visible at all (near=0.1) ✓, soldiers no longer T-pose ✓. Thank you.

But on a fresh real-Chrome verification of the deployed R31.1, the user's loudest complaint (sky) is still failing, and two new visual issues stand out:

- The sky in-match is a pale washed-out white-blue with **no visible sun disk anywhere**, even when looking up toward the configured sun (azimuth=200°, elevation=55°). Three rounds of `THREE.Sky` re-tuning have not produced "atmospheric depth." Time to stop tuning.
- The terrain has **bright white blow-out blobs** in mid-distance — looks like the Sky-derived PMREM env reflecting too hot on roughness=0.95 surface, or directional+hemi+ACES@0.8 just over-lighting it.
- The weapon viewmodel is visible but **reads as a horizontal canoe paddle**, not a rifle. Geometry `BoxGeometry(0.06, 0.05, 0.30)` at `(0.25, -0.20, -0.45)` is a 30 cm long stick that's only 5–6 cm in the other dimensions; foreshortened toward the camera it fills the lower-right quadrant as a single uniform rectangle. No silhouette of stock/grip/sight.

Final R31.1 scorecard against the 10 acceptance criteria:

| # | Criterion | Result | Notes |
|---|---|---|---|
| 1 | Sky | **FAIL** | Pale white-blue wash; no sun disk |
| 2 | Terrain lit + shadows | **PARTIAL** | Lit, but specular blow-outs |
| 3 | Buildings grounded, not yellow | **PASS** | sampleTerrainH() works |
| 4 | Soldiers visible/colored/grounded | **PASS** | Red NPC, feet on terrain |
| 5 | Soldier limb animation | **PASS** | Not T-pose; arms at sides |
| 6 | Natural WASD/mouse | **UNTESTED** | Pointer-lock didn't engage in test harness |
| 7 | No terrain clipping | **PASS** | Camera above ground |
| 8 | Weapon viewmodel visible | **PARTIAL** | Visible but reads as a paddle |
| 9 | No green triangle | **PASS** | None observed |
| 10 | Self-audit | **PASS** | claude_status.md is substantive |

5/10 PASS, 3/10 PARTIAL, 1/10 FAIL, 1/10 untested. Below the 8/10 bar, so R31.2.

---

## Goal of R31.2: vendor a real HDRI and ship a proper FPS viewmodel

This is the round we **stop tuning procedural sky** and put a real HDRI on disk.

### Task 1 (REQUIRED): vendor a 1K HDRI sky and use it for both background and PBR environment

1. Download `kloofendal_48d_partly_cloudy_puresky_1k.hdr` from PolyHaven (CC0).
   Direct URL: `https://dl.polyhaven.org/file/ph-assets/HDRIs/hdr/1k/kloofendal_48d_partly_cloudy_puresky_1k.hdr`
   Place at `assets/hdri/kloofendal_48d_partly_cloudy_puresky_1k.hdr`. ~2-3 MB. CC0 — no attribution required, but mention in the CREDITS modal.

2. Vendor `RGBELoader` from Three.js r170 addons under `vendor/three-addons/loaders/RGBELoader.js` — same pattern you used for R29's vendoring round.

3. In `renderer.js`:
   - Import `RGBELoader`.
   - Add a `loadHDRISky()` function called from `initScene()` BEFORE `initSky()` (or replace `initSky()` entirely on success). It should:
     - `new RGBELoader().load(hdrPath, hdrTex => { ... })`
     - `hdrTex.mapping = THREE.EquirectangularReflectionMapping`
     - Build a PMREM env from it: `pmrem.fromEquirectangular(hdrTex)`
     - Set `scene.environment = envRT.texture` AND `scene.background = envRT.texture` (or use `hdrTex` directly as `scene.background`).
     - On success, **delete or hide** the existing `THREE.Sky` and the PMREM-from-Sky path. Leave `THREE.Sky` as fallback if the HDRI fetch fails (`error` arm of the loader).
   - Drop `toneMappingExposure` from 0.8 to **0.6**. HDRI's are bright; ACES at 0.8 will still blow out terrain.
   - Set `terrainMat.envMapIntensity = 0.5` (currently default 1.0). Even with the right HDRI, a 0.95-roughness surface shouldn't be slamming reflected sky-light.
   - Soldier and building materials can keep `envMapIntensity = 1.0` (they're metalness=0.10–0.40 and benefit from the env light).

**Acceptance:** when the user reloads, they see a real cloudy sky with a sun and ground-shadows, and the terrain no longer has bright white blow-out blobs.

### Task 2 (REQUIRED): rebuild the weapon viewmodel as a composite mesh

Replace the single `BoxGeometry(0.06, 0.05, 0.30)` in `initWeaponViewmodel()` with a small Group containing:

```
weaponGroup
├── stock      — BoxGeometry(0.04, 0.06, 0.10) at (0, -0.02, 0.06)   // back-end butt
├── body       — BoxGeometry(0.05, 0.08, 0.18) at (0, 0.00, -0.05)   // receiver, taller than wide
├── grip       — BoxGeometry(0.03, 0.05, 0.04) at (0, -0.06, -0.02)  // pistol grip below body
├── barrel     — CylinderGeometry(0.012, 0.012, 0.20, 8) rot.x=π/2, at (0, 0.02, -0.20)
└── sight      — BoxGeometry(0.015, 0.025, 0.025) at (0, 0.07, -0.08) // rear sight bump for silhouette
```

Mount the group at `weaponGroup.position.set(0.18, -0.16, -0.32)` (closer + tighter than the current canoe), tilt slightly: `weaponGroup.rotation.set(-0.05, 0.08, 0.0)` (barrel angled subtly up-and-forward). Use the same `MeshStandardMaterial({ color: 0x6a6a72, roughness: 0.45, metalness: 0.55 })` for all parts (single material, multiple meshes is fine — perf cost is negligible).

Update `camera.add(weaponGroup)` to use the new group instead of the old `weaponHand`.

**Acceptance:** lower-right silhouette reads unambiguously as a firearm — visible stock, body, barrel, and a sight bump on top. Not a paddle, not a stick.

### Task 3 (NICE-TO-HAVE): bump terrain spec response down

If after Task 1 the terrain still has bright spots, also do:

```js
terrainMat.envMapIntensity = 0.35;
terrainMat.normalScale.set(0.8, 0.8); // currently 1.2,1.2 — slight reduction prevents harsh micro-spec
```

### Task 4 (REQUIRED): credits update

In `index.html` CREDITS modal section, add a single line: `Sky HDRI: PolyHaven (CC0).` Right after the existing Dynamix/Sierra disclaimer line.

---

## Already pushed mechanically (don't re-do)

- **Footer bumped** `Version 0.4 / R29 hotfix` → `Version 0.4 / R31.1`. The R31.1 brief said "don't bump until R31.1 ships" — it has shipped. Manus pushed this as part of writing this brief.

## Things to NOT do this round

- Don't touch C++/WASM. All R31.2 work is JS + asset vendoring.
- Don't add gameplay or maps. Pure visual fix round.
- Don't delete the legacy WebGL renderer yet (still queued for R32).
- Don't swap soldier models for Quaternius / DTS yet — soldiers are acceptable; sky+weapon are the eyesores.
- Don't regress R31.1 wins (building/soldier ground-clamp, generator panel color, weapon-visibility-via-near-0.1, soldier idle breathing).

## Acceptance criteria for R31.2 (target 5/5)

1. Real HDRI sky visible (clouds + sun + atmospheric depth) — no more flat blue-white wash.
2. Terrain no longer has bright white blow-out blobs.
3. Weapon viewmodel reads as a rifle (composite of stock + body + grip + barrel + sight), not a single box.
4. No regressions of R31.1 wins.
5. CREDITS modal mentions "Sky HDRI: PolyHaven (CC0)".

---

Cron will trigger you in ~5 min. The HDRI integration is where the user's pain is — focus there. If anything is ambiguous, default to "make the sky look impressive" — the user's own words are the source of truth.

— Manus
