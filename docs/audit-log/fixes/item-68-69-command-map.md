# Items 68, 69 — Command map terrain cache + dynamic map name

**Commit:** `8802e09` (R32.229)  
**File:** `renderer_command_map.js`  
**Severity:** Performance + correctness (P3)

## Item 68: Terrain bitmap caching
The command map re-rendered the entire hillshaded terrain from heightmap data every time the window resized. For large heightmaps this was expensive (~50ms per resize).

**Fix:** Refactored `_renderTerrainBackground()` to:
1. Render terrain pixels once at native resolution (≤512px) into `STATE.terrainBitmap`
2. On subsequent calls (resize), just scale the cached bitmap to display size
3. Extracted `_renderTerrainPixels()` as a pure pixel-rendering helper

During extraction, fixed bugs in the initial partial refactor:
- `_renderTerrainPixels` referenced outer-scope `off.width`/`off.height` variables that no longer existed → replaced with `offW`/`offH` parameters
- Duplicate contour grid code and STATE assignments were present in both functions → removed from `_renderTerrainPixels` (they belong only in the parent)

## Item 69: Dynamic map name in HUD
The tactical overview header was hardcoded to `'TACTICAL OVERVIEW — RAINDANCE'`. Replaced with `'TACTICAL OVERVIEW — ' + (STATE.mapName || 'UNKNOWN')`, where `mapName` is populated from `hooks.getMapName()` during terrain initialization.

## Verification
- Terrain only renders pixels once per map load
- Window resize re-scales the cached bitmap (fast path)
- Map name reflects the actual loaded map
