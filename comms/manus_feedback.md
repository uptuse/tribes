# Manus → Claude — URGENT P0 (R32.1.2)

**User reports two playtest bugs, single root cause: `MAX_BUILDINGS` cap.**

## Symptoms (user-reported, R32.1.1 live build)

1. "Occasionally I will go through the ground, underground."
2. "I may try to fly and land on objects, but then I'll randomly teleport to the ground."

## Root cause from console

```
[R32.1] appendInteriorShapeAABBs: MAX_BUILDINGS (64) reached after 18/32
[R32.1] appendInteriorShapeAABBs: added 18 collision boxes (total buildings=64)
```

The C++ collision array is hard-capped at 64. The base-building setup (`setMapBuildings`) already populates 46. My R32.1 `appendInteriorShapeAABBs` pushed 32 more world-AABBs, but only **18 of 32** fit. The remaining 14 interior shapes — including several towers / floating pads / bridge sections — render visually but have **no collision volume**.

When the user lands on one of those un-collided shapes:
- The mesh draws at e.g. y=41 m
- Vertical resolution falls through to the next stage (terrain clamp via `getH(...)`)
- Player snaps from ~y=41 m down to ~y=20 m → "teleport to ground"

The "going through ground" report is almost certainly the same array saturating in a slightly different code path (e.g., a building footprint that's mid-overlap with terrain causes the clamp to misfire near saturated state).

## Fix (P0, Claude only — Manus can't touch C++)

**`program/code/wasm_main.cpp`** line ~395:

```cpp
static const int MAX_BUILDINGS = 64;
```

→ bump to:

```cpp
static const int MAX_BUILDINGS = 256;   // R32.1.2: was 64; R32.1 adds 32 interior-shape AABBs on top of 46 base buildings; future per-team static_shapes (R32.3) will add ~12 more, give headroom.
```

Then `./build.sh`, push, footer/changelog bump to **R32.1.2**.

Math:
- Current base: 46
- R32.1 interior shapes: 32
- R32.3 (coming) team0/team1 static_shapes: 6 + 6 = 12
- Total expected: ~90 — 256 leaves comfortable headroom

256 × `sizeof(Building)` ≈ 256 × 36 bytes ≈ **9 KB**, totally negligible at WASM scale. No need to be more conservative.

## Verify after rebuild

User flow:
1. Open `?v=r32_1_2`
2. Fly up, land on a tower roof or floating pad → should stay put, not teleport down
3. Walk around base — no falling through ground

Console line should now read:

```
[R32.1] appendInteriorShapeAABBs: added 32 collision boxes (total buildings=78)
```

(All 32 fit, no truncation message.)

## Side note — R32.1.1 visual feedback

User says "this is really great so far" — buildings are rendering correctly after the winding/group-rotation fix, no visual regressions reported. R32.1.1 visual fix confirmed working in the wild.

— Manus, R32.1.2 brief
