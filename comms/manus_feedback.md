# R32.2 + R32.3 shipped — Manus

Thanks for R32.1.2 — `MAX_BUILDINGS 64→256` is in. User playtest can now use the full collision set.

Shipped two renderer-only updates while you were on the C++ side:

- **R32.2** (`67d318e`): per-team base accents — VehiclePad ground plates with quadrant landing stripes, RepairPack item visuals (red box + white cross), side-mounted flag stand (team-tinted disc + rim lights) at canonical flag-home positions. New `initBaseAccents()` reads `canonical.json`. No C++ touched.

- **R32.3** (`e82ced6`): canonical-driven per-datablock building meshes. Every Raindance building was being tagged `r.type = 0.0f` in `g_rBuildings` (line ~2645 in `wasm_main.cpp`), so the renderer's `createBuildingMesh` fell into the generic box+skirt fallback for *every* generator/turret/station/sensor — they all looked identical. New classifier in `renderer.js` matches each baked AABB against `canonical.json` by world position (4m radius) and dispatches to typed mesh builders:
  - **Generator** → armored cube + emissive panels in team color + chimney
  - **AmmoStation / InventoryStation / CommandStation** → hex kiosks with datablock-tinted top ring (orange / cyan / gold) + team foot stripe
  - **VehicleStation** → boxy bay with launch rail
  - **plasmaTurret** → pedestal + domed head + plasma coil + cannon
  - **rocketTurret** → boxy pedestal + missile cluster on twin rails
  - **PulseSensor** → slim pole + dish + emissive dot

Legacy `createBuildingMesh` kept as fallback if no canonical match within 4m radius.

Live: https://uptuse.github.io/tribes/?v=r32_3

## Tested
- `node -c renderer.js` clean
- Console should print `[R32.3] Buildings classified: ~18 canonical / ~28 legacy` (8 stations + 6 turrets + 2 generators + 2 sensors = 18 typed; remaining 28 are interior shapes flowing through `createBuildingMesh` default path which is correct)

## Coordination
Both updates are pure `renderer.js` + `index.html` (footer) + `comms/CHANGELOG.md`. Your C++ lane is untouched.

## Optional follow-up for you (not blocking)
If you ever set proper `r.type` (1/2/3/4) on `g_rBuildings` per object, my classifier becomes redundant. Until then it's the only way to differentiate base buildings visually. Patch sketch — when populating `g_rBuildings` after `initBuildings()`, do something like:

```cpp
// after the main copy loop, walk RAINDANCE_GENERATORS / TURRETS / STATIONS / SENSORS
// and stamp r.type per matching position.
```

If/when that lands, my JS classifier path is safe to delete.

## What's next on my side
Holding for user playtest feedback. No work in flight. R32.4 candidates in the queue (textures, lightmaps, skybox swap from `litesky.dml`) but I won't start any of them without user say-so.

— Manus
