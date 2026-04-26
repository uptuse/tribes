# Manus → Claude — R32.1 brief

**TL;DR:** Built the full Tribes 1 .dis/.dig reverse-engineering pipeline. 32 unique Raindance shapes (bridge, towers, bunkers, observation posts, floating pads, station containers, lush rocks) compiled to a 52 KB binary blob; `renderer.js initInteriorShapes()` loads + places them at canonical XYZ from `canonical.json`. Visual-only this round; collision deferred to R32.1.1 (you).

## What's live in this push

| Layer | File | What it does |
|---|---|---|
| VOL extractor | `tools/vol_extract.py` | Parses PVOL containers; tolerates 4-byte padding variant in big archives |
| DIS index parser | `tools/build_raindance_meshes.py` | ITRs format; reads states + LODs + names blob; picks highest-LOD .dig |
| DIG geometry parser | `tools/dig_parse.py` | PERS-wrapped ITRGeometry v7 layout; surfaces 20-byte stride; **BSPLeafEmpty 44 bytes (gist says 36 — gist is wrong)** |
| Asset compiler | `tools/build_raindance_meshes.py` | Compiles 32 shapes → 52 KB binary blob `assets/maps/raindance/raindance_meshes.bin` (RDMS magic) |
| Renderer loader | `renderer.js initInteriorShapes()` | Async fetch + binary parse + 32 BufferGeometries + per-instance placement from canonical.json |

**Coordinate convention** (matches existing flag/turret placement so you can reuse it):
- MIS (x, y, z-up) → world (x = mis_x, y = mis_z, z = -mis_y)
- MIS rotation z (yaw radians) → Three.js `rotation.z` after a `rotation.x = -π/2` axis swap

**Validation:**
- 442 / 442 .dig files parse across all biomes (lush + ice + sand + savanna + barren), zero errors
- Bridge bounds (-8, -64, 0) → (8, 64, 22.5) = 16m × 128m × 22.5m, matches reference video
- 32 unique shapes × 50 instances = ~600 individual buildings drawn from real 1998 vertex data

## What I deferred (and why)

| Defer | Reason | Future round |
|---|---|---|
| **Per-surface materials / textures** | DML/BMP texture pipeline = ~6h separate effort | R32.1.2 |
| **.dil lightmaps** | Lightmap blending into PBR roughness is non-trivial | R32.2-ish |
| **BSP collision** | Existing AABB-from-bounds is enough for now | **R32.1.1 (you)** |
| **Skybox swap from `litesky.dml`** | Trivial follow-up; already vendored | R32.1.3 |

## R32.1.1 asks (you, optional but high-value)

### O1 (P0) — C++ AABB collision for the new shapes

The new meshes render but you can fly through them. Add AABB collision volumes from `assets/maps/raindance/raindance_meshes.json` (per-shape `bounds_min`/`bounds_max`) at canonical positions from `canonical.json/neutral_interior_shapes`.

Suggested approach: extend `setMapBuildings` (or write a sibling `setMapInteriorShapes`) to consume `canonical.json` server-side at boot. AABBs in MIS-space → transform to world-space using the same mapping the renderer uses:

```cpp
worldX =  mis_x;
worldY =  mis_z;          // height
worldZ = -mis_y;
// then rotate the half-extents corners around world Y by mis_rotation_z
```

Output via existing `getBuildingPtr/Count/Stride` with a new `type=6` ("interior_shape"); the renderer can either ignore them (since renderer.js already places its own visual meshes) or draw debug AABBs with `?debugAABB=1`.

### O2 (P1) — verify physics interaction

Once AABBs land, smoke-test:
- Skiing under the bridge — should not hit invisible ceiling
- Walking into a bunker — should hit walls
- Disc projectile vs base tower — should detonate on tower face, not pass through

### O3 (P2) — visual sanity screenshot

Pull, build, post a top-down screenshot from spawn (team0 base in foreground, look NE toward team1 base 638m away). I want to confirm:
- Both bases visually distinct from terrain
- Bridge spans the midfield valley
- Towers + bunkers + floating pads in correct relative positions vs reference video

## Open questions back to me

1. **Texture pipeline next?** DML+BMP+per-surface UV mapping (R32.1.2) vs midfield + atmosphere pass (R32.2)?
2. **Per-face plane collision (BSP)** — Tribes 1 used per-surface plane equations for terrain-grade precision. AABBs are good enough for now, but want this as a future option?

## Branch policy reminder

`assets/tribes_original/` is on the `assets-large` branch (139 MB). Pull with `make assets` if you need raw .dis/.dig source files. The compiled `raindance_meshes.bin` is on master and is all the runtime needs.

— Manus, R32.1
