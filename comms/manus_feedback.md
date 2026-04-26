# Manus Feedback — Round 18: Visual Quality Cascade (SONNET)

**MODEL:** **SONNET 4.6** (1M context)
**Severity:** Standard
**Type:** Implementation — cash in on Three.js with real models, PBR materials, shadows, particles, post-processing
**Round 17 status:** Accepted ✓ (Three.js is the default renderer; legacy WebGL behind `?renderer=legacy` flag)

---

## 1. What this round does

R15 built the Three.js renderer scaffold. R17 made it default. **R18 turns the visual-fidelity dial up** — replaces capsule placeholder players with proper soldier models, replaces colored-box buildings with real CTF base/tower/turret/generator/station meshes, replaces flat-shaded terrain with PBR rocky/grassy material, adds dynamic sky + sun, soft shadows, particle systems, and post-processing (bloom + vignette + color grading).

This is the round where the game starts to actually **look** like Tribes 1.

---

## 2. Concrete tasks (in priority order — ship as many as time allows)

### 2.1 Player models — glTF skinned soldier (P0)

Replace the capsule placeholders with proper player models:

- **Asset source:** Use **Quaternius free CC0 character pack** (sci-fi soldier set: https://quaternius.com/packs/sciencefictionrtsfree.html) OR **Kenney's Mini Characters 1** (https://kenney.nl/assets/mini-characters-1) — both CC0, no attribution required, glTF format
- **Three armor variants:** light (slim soldier), medium (standard), heavy (bulky armored). Pick three variants from the same pack for visual consistency
- **Skinned animation:** if the pack provides walk/run/jump cycles, hook them up via `THREE.AnimationMixer`. Drive `walking` state from `vel.length() > 0.5 && grounded`, `jetting` from existing flag
- **Team color:** use vertex-color tint OR a `MeshStandardMaterial.color` swap on the body mesh — red `#cc4444` for team 0, blue `#4477cc` for team 1
- **Weapon attachment:** if the model has a hand bone, attach a placeholder weapon mesh. If not, just position a small box mesh at world-space (player.pos + look-direction × 0.5, 1.6 height)

Manus's R15 spec already exposes `g_rPlayers[i].weaponIdx, .jetting, .skiing, .botRole` — wire these to model state. `botRole` can drive a small floating role icon (OFF/DEF/MID) above bot heads in spectator mode (later round).

### 2.2 Building models (P0)

Three core building types need real meshes:

- **CTF base** — a hangar-style structure with a flag platform on top. Quaternius's "Sci-Fi Modular Buildings" pack or Kenney's "Space Kit" both have suitable assets
- **Defense turret** — automated turret with a swiveling barrel (animated to track nearest enemy if visible)
- **Inventory station** — a cylindrical kiosk with a glowing panel
- **Generator** — a rectangular power plant; emits a faint hum sound when alive (audio will hook in later round)

Buildings should still be `THREE.InstancedMesh` per type for performance (R15 architecture spec).

### 2.3 Terrain material upgrade (P1)

Replace flat-shaded terrain with PBR:

- **Material:** `MeshStandardMaterial` with three textures from `polyhaven.com` (CC0): a "rocky_terrain_02" or "ground_grass" diffuse + normal + roughness map
- **Texture tiling:** scale UVs so textures repeat ~64 times across the 2048-unit terrain. Detail-mapping a high-frequency normal map at 256× scale on top of base normal adds close-up grit without needing 8K base textures
- **Slope-aware blending:** if terrain slope > 30°, blend toward a rockier material; if slope < 10°, lean grass. Simple shader chunk (`THREE.ShaderMaterial.onBeforeCompile` injection) — borrow pattern from any Three.js terrain blending tutorial

### 2.4 Sky and lighting (P1)

- **`THREE.Sky`** with sun position driven by a slow time-of-day cycle (or fixed at "afternoon" — sun azimuth 45°, elevation 35°). Adds atmospheric scattering for free
- **Directional sun light** with `castShadow=true`, shadow map 2048×2048, frustum sized to player vicinity (200×200m around camera, not the full map — too expensive)
- **Hemisphere ambient** with sky=#9bb5d6, ground=#5a4a32 — gives ~25% upper-fill so shaded areas aren't pitch black
- **Fog** — `THREE.FogExp2(skyColor, 0.0004)` so distant terrain fades into atmosphere. Should match sky horizon color at the fade distance

### 2.5 Particles (P1)

Replace `THREE.Points` placeholders with real particle behavior:

- **Jet flame:** hot bright cyan→yellow→orange gradient at jet pack outlet, additive blending, fades fast (~0.3s lifetime)
- **Ski spray:** small dust puff sprites kicked up behind player when skiing on dry terrain; color matches terrain texture at impact point
- **Hit sparks:** instant burst of 5-10 short-lived sparks at projectile impact, color depends on weapon (yellow for chain, blue for plasma, red for disc)
- **Explosions:** for grenade/disc impact: short fireball billboard sprite (~0.5s), expanding ring shockwave, plus 20+ debris sparks

`THREE.BufferGeometry` with shader-driven particle pools. Cap total active particles at 1024 (matches R15 export size). Recycle rather than allocate.

### 2.6 Post-processing (P2)

`EffectComposer` chain (or `RenderPipeline` if upgraded to r182):

- **Bloom** — `UnrealBloomPass`, threshold 0.85, strength 0.4, radius 0.6. Makes weapon flashes, jet flames, and explosions pop
- **Vignette** — subtle dark corners, ~15% strength. Cinematic feel, tightens focus on center
- **Color grading** — slight desaturation (~10%) and warm shift (+5% red, -5% blue in shadows). Matches Tribes 1 muted military aesthetic
- **FXAA** if antialiasing-via-MSAA is too expensive

Make post-process **toggleable** via a settings flag — bloom is GPU-expensive on integrated graphics, so let users opt out.

### 2.7 Optional: weapon viewmodel (P3, if time permits)

Replace the no-viewmodel default with a placeholder weapon mesh visible at bottom-right of screen, swayed slightly with player movement. Borrow the Quaternius weapon pack or just a simple box for now.

---

## 3. Acceptance criteria (must hit 8 of 12)

1. ✅ Player models render as real soldiers (not capsules), with team color, three armor variants visible
2. ✅ Player walk/run/jet animations play correctly
3. ✅ At least 3 building types use real meshes (not boxes): base, turret, station
4. ✅ Terrain uses PBR `MeshStandardMaterial` with textured diffuse + normal
5. ✅ `THREE.Sky` with directional sun providing primary lighting
6. ✅ Soft shadows from directional sun visible on terrain and player models
7. ✅ Hemisphere ambient + fog give depth to distant terrain
8. ✅ Jet flames, ski spray, hit sparks, explosions all render with new particle system
9. ✅ Bloom post-process active and visibly enhances weapon flashes / jet flames
10. ✅ Vignette + subtle color grading active
11. ✅ Performance: ≥45 FPS on a mid-tier Mac with 8 bots, full settings (50 FPS preferred)
12. ✅ Settings menu has a "graphics quality" option (low/medium/high/ultra) that toggles shadow resolution, post-process, particle count

Bonus:
- B1. Weapon viewmodel visible
- B2. Death camera transitions smoothly (not snap-cut) on player death
- B3. Damage flash overlay improved (red vignette pulse)
- B4. Skybox sun aligned with directional light source (visual consistency)

---

## 4. Asset attribution

Add `assets/CREDITS.md` listing all CC0/CC-BY sources used. Even CC0 deserves attribution as a courtesy to the creators.

---

## 5. Compile/grep guardrails

- All asset URLs must be either local (`assets/...`) or from a stable CDN (unpkg, jsdelivr) — no hotlinking from artist sites
- `! grep -nE 'EM_ASM[^(]*\(.*\$1[6-9]'` must pass (legacy)
- File size: any new texture > 2 MB compressed should justify itself in a comment
- glTF files should be loaded via `GLTFLoader` from `three/examples/jsm/loaders/GLTFLoader.js`

---

## 6. Time budget

This is a 90-150 min Sonnet round. Asset wiring and texture loading is mechanical but voluminous. Bookmark the Quaternius and Kenney pack URLs at the top of the brief.

Suggested split:
- Asset download + integration (player + building glTF): ~30 min
- Player animation hookup: ~20 min
- Terrain PBR material + slope blending: ~20 min
- Sky + sun + shadows + fog: ~20 min
- Particles upgrade: ~30 min
- Post-process pipeline: ~15 min
- Settings menu graphics tier: ~15 min
- Performance tuning: ~10 min

---

## 7. Decision authority for ambiguities

- **If a glTF asset has loading issues:** fall back to a simpler asset from the same pack rather than the placeholder. Don't lose ground.
- **If shadows are too expensive:** drop to `BasicShadowMap` instead of `PCFSoftShadowMap` rather than disabling
- **If post-process tanks FPS:** make it gated behind "high" or "ultra" graphics tier; keep the menu option
- **If a particle system is too complex to redesign cleanly:** ship the placeholder for that one type, accept partial criterion, note in `open_issues.md`

---

## 8. Roadmap context

- **R17 (just landed, Sonnet):** Three.js cutover — default renderer flipped
- **R18 (this round, Sonnet):** Visual quality cascade
- **R18.1 (next, Sonnet):** Legacy WebGL render code deletion (mechanical cleanup, 30-min round)
- **R19 (Sonnet):** Network implementation per R16 spec — wires game state through chosen protocol
- **R20+ (Sonnet):** Polish, content, balance — additional maps, weapon tuning, audio expansion, spectator mode
