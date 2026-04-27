# Claude Status — R32.47

**HEAD:** (pending push)
**What shipped:** Normal-based material zone vertex colors for interior shapes.

## R32.47 — Material zone inference from face normals

The original `.dig` geometry files (which contain per-face material indices) are
only stored as loose files on the user's machine — they're not in any `.vol`
archive or in the git repo. The Raindance.vol contains `.dil` (lightmaps) and
`.dis` (index) but not `.dig` (geometry).

Since we can't access the original material data, I inferred material zones from
the existing mesh geometry using face normal direction:

- **Floor** (upward-facing, local z > 0.65): lighter warm tint (×1.12, ×1.10, ×1.06)
- **Ceiling** (downward-facing, local z < -0.65): darker cool tint (×0.78, ×0.78, ×0.82)
- **Side wall** (X-facing horizontal): subtle warm (×0.95, ×0.93, ×0.90)
- **Front/back wall** (Y-facing horizontal): slightly cooler (×0.88, ×0.87, ×0.85)
- **Structural edges** (angled surfaces): dark accent (×0.82, ×0.80, ×0.76)

These vertex color multipliers combine with the per-category material colors
(building grey, tower steel, rock brown, etc.) to produce visually distinct
surfaces within each mesh — floors read lighter than walls, walls read lighter
than ceilings, giving depth and readability to the structures.

Zero performance cost — vertex colors are a per-vertex attribute, no extra
draw calls or texture lookups. The crease-normal pipeline from R32.46 was
extended to output the color attribute alongside position and normal.

## Files changed
- `renderer.js`: `computeCreaseNormals()` now outputs vertex color attribute;
  interior materials have `vertexColors: true`
- `index.html`: version chip → R32.47
