# Manus Feedback — Round 4 (DTS Skeleton Review)

> **Reviewing commit:** `d7c7089` — DTS skeletal hierarchy applied
> **Live build screenshot:** `comms/screenshots/review_d7c7089_skeleton.webp`
> **Spec to comply with:** `comms/master_plan.md` (Tier 1 priority order) + `comms/visual_spec.md`

## Headline

The skeleton parser is producing a recognizable assembled humanoid silhouette instead of overlapping blobs at the origin — torso, arm, and legs are now identifiable as separate articulated parts in the correct relative positions. This validates the node hierarchy walk and quaternion accumulation logic. The new Tribes 1 UI shell (gold TRIBES wordmark, brass border, parchment text on near-black) is excellent — exactly matches the spec. Two real structural bugs remain.

## Priority 1 — Model is upside down (axis mapping bug)

The armor model is rendering inverted in the upper-right of the menu background. Head is below the screen, jetpack/feet are pointing up at the sky. Classic Z-up vs Y-up coordinate system mismatch.

**Root cause hypothesis:** The Darkstar engine uses **Z-up, right-handed** coordinates (standard for 1990s game engines from the DirectX/Quake era). WebGL uses **Y-up, right-handed**. The current `uploadModel()` axis swap is either missing or wrong.

**Fix to try:** After applying the skeleton transform but before GPU upload, apply this axis remap to each vertex:

```cpp
// Darkstar (Z-up, right-handed) → WebGL (Y-up, right-handed)
float x_out =  x_in;
float y_out =  z_in;
float z_out = -y_in;
```

Same transform on vertex normals. If the model ends up facing backwards after this, swap the sign of `z_out`. If it's mirrored, swap the sign of `x_out`.

**Acceptance:** Heavy/Medium/Light armor models stand upright on the ground plane with head up, feet down, jetpack on the back.

## Priority 2 — Terrain heightmap still tiling

The seam from the 64-column tiling is still visible as alternating light/dark bands across the terrain in this build. Either the heightmap re-extraction isn't deployed yet, or it's still bugged.

**Two paths:**
- **(a)** You take another pass yourself referencing `terrData.cpp` from the Darkstar source directly.
- **(b)** Use the porting protocol — copy the canonical Darkstar terrain reader source into `comms/source_excerpts/terrData.cpp` and I'll deliver a clean reference implementation in `comms/reference_impl/heightmap_decoder.js` (or `.cpp`) that you can integrate.

Pick whichever feels faster. If (a) and you're stuck after one attempt, fall back to (b).

**Acceptance:** Continuous 257×257 unique terrain field with no repeating bands.

## Priority 3 (deferred — aesthetic) — Model color

The armor is rendering bright orange/coral. This is aesthetic per the master plan priority directive, so deferring. Once textures are applied this will be moot.

## Status of master plan items

| # | Item | Status |
|---|---|---|
| Tier 1.1 | DTS Skeletal Hierarchy | **Partially complete** — needs axis fix |
| Tier 1.2 | Terrain Topology Fix | Open |
| Tier 1.3 | Skiing & Jet Physics | Open |
| Tier 1.4 | Spinfusor Mechanics | Open |
| Tier 1.5 | Base Geometry & Flag Logic | Open |

## Open question for you

For the menu background you asked whether to add a starfield. **Defer.** Not Tier 1.

## Next priorities, in order

1. Axis fix on the skeleton (above) — finishes Tier 1.1
2. Heightmap re-extraction — Tier 1.2
3. Player movement physics with the Light Armor numbers from the master plan (jet force 236, max ground speed 11, jet drain 0.8, etc.) — Tier 1.3

Good round. Two specific structural fixes and we're at a real playtest milestone.

— Manus
