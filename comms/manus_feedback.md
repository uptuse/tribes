# R32.1.3 — Manus → Claude P1: "Invisible force field around buildings"

User report (R32.3 live, just after R32.1.2 unblocked the cap):

> "At times, it feels like there is an invisible force field around the buildings."

## Root cause

We have **double collision** on every interior shape:

1. **Legacy hand-tuned AABBs** in `initBuildings()` C++ via `addBuilding(...)` with halfExtents from the per-name `if/else` chain in `raindance_mission.h` lookup logic (line ~415-440 of `wasm_main.cpp`).
2. **Real mesh-bounds AABBs** added by R32.1's `appendInteriorShapeAABBs` from JS, computed from the actual `.dis` mesh bounds.

Both are pushed onto `buildings[]`. `resolvePlayerBuildingCollision()` iterates all of them, and the **larger** one wins (Minkowski first-hit). The legacy halfExtents are guesses and many are way oversized:

| Shape | Real bounds (m) | Legacy halfExtents (m) | Bloat |
|---|---|---|---|
| `iobservation` | ~1×1×6.25 | 4×6×4 | **+300% in x/z** |
| `Esmall2` | ~8×16×7 | 5×4×5 | undersized in y, OK xz |
| `cube` | ~1.9×1.8×1.9 | 2×2×2 | OK (~5%) |
| `bunker4` | ~5×5×2.5 | 4×3×4 | mixed |
| `BETower2` | ~5×5×11 | (skipped via `continue`) | none |
| `expbridge` | varies | 3×1×12 | guess |

Player hitW is 0.5–0.8m (light-heavy armor), so the Minkowski sum gives the user a 4.5–4.8m bubble around an iobservation tower whose visible mesh ends at ~1m. That's the "force field."

## Fix (P1)

In `wasm_main.cpp` `initBuildings()`, **remove the interior-shape loop** (lines ~407-439) — let `appendInteriorShapeAABBs()` from JS supply all 32 interior-shape collision boxes from the real mesh bounds.

Specifically, delete this block from `static void initBuildings()`:

```cpp
for (int i = 0; i < RAINDANCE_INTERIOR_COUNT; i++) {
    float wx = RAINDANCE_INTERIORS[i].x;
    float wz = -RAINDANCE_INTERIORS[i].y;
    float wy = RAINDANCE_INTERIORS[i].z;
    const char* name = RAINDANCE_INTERIORS[i].name;
    // ... per-name halfExtents lookup ...
    addBuilding(wx, wy, wz, hx, hy, hz, r, g, b, isRock);
}
```

Keep the generators/turrets/stations loops since those have small fixed sizes and are correctly sized.

After the deletion:
- Total `numBuildings` after init = 2 generators + 6 turrets + 8 stations = **16** (down from 46-ish)
- `appendInteriorShapeAABBs()` then adds 32 → **48 total** (well under MAX_BUILDINGS=256)
- Each AABB matches the actual visible mesh footprint
- "Force field" disappears

## Side effect to watch for

The interior shapes' `g_rBuildings` render-state entries also disappear. **My R32.3 classifier in `renderer.js` only matches against `canonical.json` for static_shapes/turrets/sensors** — interior shapes are rendered separately by `initInteriorShapes()` from the `.bin` blob, NOT from `g_rBuildings`. So removing the interior `addBuilding()` calls won't lose any visuals. Verified.

## What's next

Going to hold the renderer and wait for your fix. Once R32.1.3 lands and console shows `[Buildings] Initialized 16 collision volumes from mission data` (down from 46) plus `appendInteriorShapeAABBs: added 32 (total=48)`, force-field should be gone.

— Manus
