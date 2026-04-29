# Item 21 — Extract renderer_terrain.js

## Finding
renderer.js contained ~580 lines of terrain code (heightmap upscale, splat generation,
texture array shader with 6 onBeforeCompile hooks, carve-under-buildings). This was
the single largest subsystem still in the monolith.

## Fix (R32.232)
Created `renderer_terrain.js` (647 lines) with clean module API:

### Exports
| Export | Purpose |
|--------|---------|
| `init({ renderer, scene, Module })` | Async init — heightmap upscale, splat weights, geometry, shader |
| `sampleHeight(x, z)` | Bilinear height sampling on upscaled grid |
| `getMesh()` | Returns the terrain THREE.Mesh |
| `getHeightmap()` | Returns `{ data, size, scale }` |
| `getSplatData()` | Returns `{ splatAttr, size }` |
| `carveUnderBuildings(shapesGroup)` | Carves terrain under base buildings |
| `tick(t)` | Updates terrain shader uTime uniform |
| `dispose()` | Full cleanup (geometry, material, textures) |

### Legacy bridges preserved
- `window._sampleTerrainH` — used by renderer_characters.js (IIFE)
- `window.__tribesSetTerrainPBR` — used by index.html settings checkboxes

### Lines removed from renderer.js
- State vars: `terrainMesh`, `_htSize`, `_htScale`, `_htData`, `_splatData`
- Functions: `sampleTerrainH`, `initTerrain` (~500 lines), `_carveTerrainUnderBuildings` (~70 lines)
- Total: ~598 lines removed (4887 → 4289)

### Call sites updated (14 total)
1. `start()` — `await Terrain.init(...)` + `Terrain.getMesh()`
2. `DayNight.setRef('terrainMesh', Terrain.getMesh())`
3. `Particles.init(...)` — `sampleTerrainH: Terrain.sampleHeight`, heightmap from getter
4. `Polish.installPolish(...)` — `terrainMesh: Terrain.getMesh()`, `sampleTerrainH: Terrain.sampleHeight`
5. `CommandMap.init(...)` — `getHeightmap: () => Terrain.getHeightmap()`
6. Render loop — `Terrain.tick(t)` replaces inline uniform update
7. `initGrassRing()` — `Terrain.getSplatData()`, `Terrain.getHeightmap()`
8. `updateGrassRing()` — `Terrain.getHeightmap()`, `Terrain.getSplatData()`
9. `initDustLayer()` — `Terrain.getHeightmap().size`
10-14. All `sampleTerrainH` calls → `Terrain.sampleHeight`

## Cohort Review
- **Carmack** (perf): No extra overhead — getters return direct references, not copies.
  Texture array architecture (3 sampler2DArray) preserved exactly.
- **Muratori** (arch): Clean dependency injection via `{ renderer, scene, Module }`.
  No circular deps. Module is self-contained with dispose().
- **Sweeney** (engine): Heightmap data flow is clean — WASM → bicubic upscale → module state.
  The 6 shader hooks are co-located with their data, improving maintainability.
- **Ive** (design): Terrain visual identity preserved — faceted geometry, watercolor wash,
  living-terrain breath all in one cohesive module.
- **Acevedo** (UX): No user-facing change. `window._sampleTerrainH` bridge maintained.
- **Blow** (correctness): Mechanical split — code moved verbatim. No logic changes.
  Both files pass `node --check --input-type=module` syntax validation.

## Risk: LOW
Mechanical extraction. All shader code moved verbatim. Legacy bridges preserved.
