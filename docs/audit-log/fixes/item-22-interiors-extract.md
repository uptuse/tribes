# Item 22 — Extract renderer_interiors.js

## Finding
renderer.js contained ~575 lines of interior shapes code — binary mesh parser,
material classification system, procedural texture generation, canonical placement,
and collision registration. This was the second-largest subsystem in the monolith.

## Fix (R32.233)
Created `renderer_interiors.js` (~615 lines) with clean module API:

### Exports
| Export | Purpose |
|--------|---------|
| `init({ scene, registerModelCollision })` | Async init — load binary, parse, place, collide |
| `getGroup()` | Returns the interiorShapesGroup THREE.Group |
| `dispose()` | Full cleanup (traverse + dispose geometry/materials) |

### Lines removed from renderer.js
- State var: `interiorShapesGroup`
- Function: `initInteriorShapes` (~575 lines including nested helpers)
- Comment block header
- Total: ~588 lines removed (4289 → 3702)

### Call sites updated (4)
1. `start()` — `await Interiors.init({ scene, registerModelCollision })`
2. Terrain carve (commented) — `Terrain.carveUnderBuildings(Interiors.getGroup())`
3. Bridge railings — `Interiors.getGroup().traverse(...)`
4. Comments referencing initInteriorShapes left as-is (documentation only)

### Nested helpers moved (all inside init)
- `lookupPalette(texName)` — material palette lookup
- `_noise(ctx,w,h,r,g,b,a,spread)` — procedural texture noise
- `_genProceduralTex(texName, baseColor)` — texture generation
- `_classifyMaterial(texName)` — material classification (metal/glass/rock/etc)
- `buildMaterialArray(fileName, teamIdx)` — per-shape material array builder

## Cohort Review
- **Carmack** (perf): No overhead added. Binary parser is already I/O-bound.
- **Muratori** (arch): Clean DI — only needs scene + collision callback. No circular deps.
- **Sweeney** (engine): Binary format parsing co-located with mesh creation. Good cohesion.
- **Ive** (design): Authentic Tribes 1 meshes preserved with material classification.
- **Blow** (correctness): Mechanical split — no logic changes. Both files pass syntax check.

## Risk: LOW
Mechanical extraction. All mesh parsing moved verbatim.
