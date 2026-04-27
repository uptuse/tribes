# Claude Status — R32.46

## Latest Build
**R32.46** — Geometry Enhancement: Crease-Aware Smooth Normals + Rock Subdivision

### What Changed (R32.45 → R32.46)

#### 1. Crease-Aware Smooth Normals for Interior Shapes
- Replaced simple `computeVertexNormals()` + `flatShading: true` with a custom `computeCreaseNormals()` algorithm
- For each vertex, averages normals from adjacent faces ONLY when dihedral angle < crease threshold
- Architectural meshes use 40° crease angle — flat wall panels stay hard-edged while curved transitions smooth
- Rocks use 55° crease angle — more aggressive smoothing for natural surfaces
- All interior shape materials switched to `flatShading: false` to use the custom normals
- Geometry is de-indexed (non-indexed) to allow per-vertex-per-face normals at crease boundaries
- **Visual effect**: Buildings look like machined industrial structures instead of faceted wireframe extracts. Panel seams and edges remain crisp while surface transitions are smooth.

#### 2. Midpoint Subdivision for Rock Meshes
- Rock meshes (lrock1-6) get one pass of midpoint subdivision before crease normal computation
- Each triangle splits into 4 sub-triangles at edge midpoints (no position smoothing — keeps original silhouette)
- Quadruples triangle count on rocks: e.g. lrock3 goes from 24→96 tris, lrock6 from 50→200 tris
- The extra geometry gives the crease normal algorithm more vertices to smooth, making rocks rounder
- **Visual effect**: Rocks look like weathered natural formations instead of angular crystal shapes

#### 3. Implementation Details
- `computeCreaseNormals(geometry, creaseAngleDeg)` — takes indexed BufferGeometry, returns non-indexed with custom normals
- `midpointSubdivide(positions, indices)` — pure geometry operation, returns new position/index arrays
- Both functions operate at load time only (inside `initInteriorShapes`), zero per-frame cost
- AABB collision code untouched — still reads from `info.meshes` bounds, not geometry
- Performance: processing all 32 unique meshes takes ~few ms at startup

### Previous (R32.45)
- Anisotropic filtering on terrain textures
- Soft PCF shadow penumbra (shadow.radius = 3)
- Interior shape material differentiation (6 categories)
- Building envMapIntensity tuning
- FOV punch on nearby explosions
- FogExp2 atmospheric haze

## Status
- ✅ R32.46 pushed
- Awaiting user feedback on visual quality of enhanced geometry
