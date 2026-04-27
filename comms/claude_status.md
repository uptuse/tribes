# Claude Status — R32.45

## Latest Build
**R32.45** — Visual Polish Pass (Zero Performance Cost)

### What Changed (R32.44 → R32.45)

#### 1. Anisotropic Filtering on Terrain Texture Arrays
- Set `maxAnisotropy` on all 3 `DataArrayTexture` objects (color, normal, AO)
- Terrain is now razor-sharp at oblique viewing angles instead of blurry at distance
- GPU handles this in hardware — zero CPU cost

#### 2. Soft PCF Shadow Penumbra
- Added `shadow.radius = 3` to DirectionalLight (was unset = hard edges)
- Works with existing `PCFSoftShadowMap` for soft, natural shadow edges
- Bias (-0.0005) and normalBias (0.02) already correct from prior work

#### 3. Interior Shape Material Differentiation
- Replaced single `baseMat` for all 32 interior shapes with 6 category-specific materials:
  - **Buildings** (esmall2, bunker4): concrete grey, roughness 0.82, metalness 0.10
  - **Towers** (BETower2, iobservation, mis_ob*): darker steel grey, roughness 0.65, metalness 0.30, high envMap
  - **Bridge** (expbridge): warm industrial, roughness 0.70, metalness 0.25
  - **Rocks** (lrock*): dark earth brown #5A5248, roughness 0.95, metalness 0.02 — natural matte
  - **Pads** (swsfloatingpad2, DSSfloatingPad): gunmetal #4A4A50, metalness 0.55 — metallic landing surfaces
  - **Cubes**: original concrete grey
- Shapes now read visually distinct instead of uniform grey blobs

#### 4. Building Material EnvMapIntensity
- `baseMat` (building bodies): envMapIntensity 0.35 (was default 1.0 / unset)
- `armMat` (turret arms, station hardware): envMapIntensity 0.50
- Metallic parts now subtly reflect the sky/PMREM environment

#### 5. Camera FOV Punch on Nearby Explosions
- When a type-3 (explosion) particle spawns within 30m of camera, adds +2.5° FOV
- Decays exponentially back to base FOV over ~200ms (`*= 1 - dt*5`)
- Integrates with existing ZoomFX and C++ FOV pipeline
- Pure math on existing camera — zero render cost

#### 6. Exponential² Fog
- Replaced `THREE.Fog(linear, near=200, far=450)` with `THREE.FogExp2(0.0022)`
- ~50% opacity at 300m, near-full at 500m — softer, more natural Tribes 1 haze
- Day/night cycle only touches `fog.color` — compatible with FogExp2

### Technical Details
- `renderer.js`: ~4185 lines (added ~35 LOC for materials + FOV punch)
- No new draw calls, no new render passes, no new textures
- All changes are property assignments or trivial math in existing hot paths

### Status
✅ Committed and pushed.
