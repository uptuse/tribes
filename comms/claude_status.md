# Claude Status — R32.42

## Latest Build
**R32.42** — Texture Array Architecture

### What Changed
- Converted 15 individual `sampler2D` terrain textures → 3 `sampler2DArray` (color, normal, AO)
- Each array texture has 5 layers: grass1, grass2, rock, dirt, sand
- Fragment shader texture units: **15 → 3** custom + Three.js internals ≈ **5-6 total** (was ~17-19)
- **Massive headroom** under the `MAX_TEXTURE_IMAGE_UNITS(16)` limit
- **Roughness restored** — luminance-derived roughness (bright=smoother, dark=rougher)
- Texture arrays built from 1024×1024 downsampled layers (originals are 2048²)
- Removed R32.41 diagnostic code

### Root Cause (confirmed)
The terrain shader was using 15 custom `sampler2D` uniforms (5 color + 5 normal + 5 AO) plus Three.js internals (envMap, shadowMap, normalMap fallback). On the user's macOS Apple Silicon with ANGLE-Metal, `MAX_TEXTURE_IMAGE_UNITS = 16`. The shader was right at the limit; any perturbation (even replacing `roughness` with `0.5`) changed the GLSL optimizer's dead-code elimination and pushed active samplers above 16, causing a link failure.

### Technical Details
- Uses `THREE.DataArrayTexture` (WebGL2 `sampler2DArray`)
- `stochasticSampleArray()` function samples with `texture(tex, vec3(uv, layer))`
- `initTerrain()` is now `async` — loads images via `Image()`, draws to canvas, extracts pixel data
- Dummy 1×1 normalMap kept on material to trigger `USE_NORMALMAP_TANGENTSPACE` / TBN computation
- `map` property removed from material (no longer needed — frees 1 dead sampler)

### Status
✅ Committed and pushed. Ready for testing at https://uptuse.github.io/tribes/
