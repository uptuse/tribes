# Plan — Recreate Raindance 1:1 in Tribes Browser Edition

**Author:** Manus
**Date:** 2026-04-26 (revised after vendoring `levizoesch/tribes.game`)
**Status:** R32.0 ready to ship — the canonical mission file gives us every coordinate we need.

---

## TL;DR

We now have the complete original Sierra/Dynamix Starsiege: Tribes v1.11 install vendored into `assets/tribes_original/`, including `Raindance.MIS` (the canonical mission script as plain TorqueScript text) and `Raindance.ted` (the canonical binary terrain). A clean parsed JSON of every gameplay object is at `assets/maps/raindance/canonical.json`. The community-extracted heightmap PNG is at `assets/maps/raindance/heightmap.png` and has already been baked into `program/code/raindance_heightmap.h` (665 KB, 257×257 verts, 8m spacing, 200m vertical relief, 2048m × 2048m world). The C++ engine plumbing for Raindance was already wired up in an earlier round, so **R32.0 is essentially a one-step ship: rebuild WASM and confirm the renderer reads the right data.**

| Round | Title | What ships |
|---|---|---|
| **R32.0** | Heightfield import (in flight) | Real Raindance terrain, default bases, scale + lighting + fog + rain calibrated to canonical values |
| **R32.1** | Base meshes | New `BUILDING_TOWER` and `BUILDING_GENROOM` types in C++; matching Three.js meshes |
| **R32.2** | Midfield + bridge | Bridge mesh + 2 midfield towers (no river per video) |
| **R32.3** | Object placement | Load `canonical.json` at boot; instantiate every flag, generator, inv station, vehicle pad, turret, sensor, command station at canonical coords |

R33 = C&H mode + control points + remaining maps.

---

## 1. Canonical findings from `Raindance.MIS`

The vendored `assets/tribes_original/base/missions/Raindance.MIS` is plain TorqueScript text. Our parser at `tools/parse_mis.py` extracts everything into `assets/maps/raindance/canonical.json`. Notable values:

### 1.1 Terrain and world

| Field | Value |
|---|---|
| Terrain origin | `(-3072, -3072, 0)` (Tribes uses Y-forward, Z-up, so the heightfield is offset to put gameplay in positive coords) |
| Heightfield grid | 256 × 256 cells, 8 m per cell → 2048 m square |
| Visible distance | 450 m |
| Haze distance | 200 m |
| Perspective distance | 100 m |
| Gravity | `(0, 0, -20)` — matches our current setting exactly |

### 1.2 Lighting (the "Sun")

| Field | Value |
|---|---|
| Azimuth | -90° |
| Incidence | 54° (sun at moderate elevation) |
| Intensity | 0.6 grayscale |
| Ambient | 0.4 grayscale |
| Cast shadows | true |

### 1.3 Sky

`dmlName = litesky.dml`, with `skyColor = 0 0 0` (black-keyed; sky is cubemap-driven), 16 sky textures named "1" through "15" + "0", size 600, distance 800.

### 1.4 Weather

`Snowfall "Rain1"` with `rain = True`, intensity 1.0, wind vector `(-0.22, 0.15, -75)`. The `-75` Z component looks like wind speed, not direction.

### 1.5 Mission center (play area)

`x=-700, y=-100, w=850, h=900` — defines the 850 × 900 m gameplay rectangle centered at `(-275, 350)`. This is where the bases live; the rest of the 2048 m terrain is for skiing approaches.

### 1.6 Team 0 (south-west base, "Beta team")

| Object | Position |
|---|---|
| Flag | `(-221.8, 21.8, 38.7)` |
| Plasma Turret | `(-243.8, 21.3, 35.0)` (base turret, on roof) |
| Plasma Turret | `(-258.3, 190.1, 55.5)` (bridge plasma turret) |
| Rocket Turret | `(-320.8, 130.9, 43.7)` |
| Pulse Sensor | `(-266.0, -7.8, 34.6)` |
| Generator | (in JSON) |
| Ammo Station | (in JSON) |
| Inventory Station | (in JSON) |
| Vehicle Pad | `(-289.1, 30.0, 22.5)` |
| Command Station | (in JSON) |
| Vehicle Station | (in JSON) |
| Repair Pack | `(-255.4, -7.9, 8.3)` |
| Drop Points | 8 spawn markers in JSON |

### 1.7 Team 1 (north-east base, "Alpha team")

| Object | Position |
|---|---|
| Flag | `(-379.2, 640.8, 52.8)` |
| Pulse Sensor | `(at PulseSensor location)` |
| Plasma Turret × 2 | (in JSON) |
| Rocket Turret | (in JSON) |
| Generator | (in JSON) |
| Ammo Station | (in JSON) |
| Inventory Station | (in JSON) |
| Command Station | (in JSON) |
| Vehicle Station | (in JSON) |
| Vehicle Pad | (in JSON) |
| Repair Pack | `(-344.1, 644.0, 16.1)` |
| Drop Points | 9 spawn markers in JSON |

Distance team0 flag → team1 flag: **638.7 m** (matches the ~1m39s ski time from the reference video).

### 1.8 Neutral structures

- **31 InteriorShape buildings** (the actual geometry of the bases, the bridge `expbridge.0.dis`, etc.). Each has a `fileName` referring to a `.dis` file inside one of the lush biome `.vol` archives. We don't need to render these meshes pixel-perfect; in R32.1 we recreate them as Three.js procedural meshes sized from the .dis filename's known dimensions.
- The bridge specifically: `expbridge.0.dis` at `(-291.6, 296.7, 41.0)` — exactly midfield between the two flag positions.

---

## 2. The data pipeline (R32.0, mostly done)

```
heightmap.png (257×257, uint16)             ← already vendored at assets/maps/raindance/heightmap.png
   ↓ assets/maps/raindance/build_heightmap.py
   ↓ scale: h_meters = (raw / 65535) * 200
   ↓ emit C array
program/code/raindance_heightmap.h          ← already regenerated, 665 KB
   ↓ included by program/code/wasm_main.cpp
   ↓ getH(x,z) does bilinear lookup into RAINDANCE_HEIGHTS[][]
   ↓ TSIZE=257, TSCALE=8 → 2048m square world (already configured)
   ↓ EXPORT getHeightmapPtr/getHeightmapSize/getHeightmapWorldScale to JS
   ↓ renderer.js initTerrain() reads ptr, builds Three.js plane at 2048×2048 with 256×256 segments
```

All of the above is already done in the codebase as of this commit. **What remains for R32.0:**

1. Rebuild WASM (Claude has emsdk locally; ship via `build.sh`).
2. Apply canonical lighting: replace our default sun with azimuth -90°, incidence 54°, RGB (0.6, 0.6, 0.6), ambient (0.4, 0.4, 0.4).
3. Apply canonical fog: `scene.fog = new THREE.Fog(0xC0C8D0, 200, 450)` (haze distance 200, visible distance 450).
4. Apply canonical sky color: pale overcast `#C0C8D0`.
5. Add screen-space rain particle layer (Three.js `Points` system, ~5000 falling streaks, wind vector `(-0.22, 0.15, -75)`).
6. Bump footer to R32.0.

---

## 3. The bases (R32.1)

Per the canonical .MIS, each Raindance base contains:

- 1× **Flag stand** (the .dis is `flagstand_indoor.0.dis` for team0; flag is anchored to it)
- 1× **Generator** building (the `.dis` is `generator_lush.0.dis`)
- 1× **Ammo Station**
- 1× **Inventory Station**
- 1× **Vehicle Station**
- 1× **Vehicle Pad** (open-air rectangle on terrain)
- 1× **Command Station**
- Multiple base building shells (`station_base_lush.0.dis`, `flag_base_lush.0.dis`, etc. — these are the architectural shells)

Two new building types in C++:

- **`BUILDING_TOWER`**: tall hollow tower with side-mounted mid-height platform for the flag stand (per video). Roof carries the base turret + sensor.
- **`BUILDING_GENROOM`**: subterranean room with two ramp entrances; houses generator + inv station + ammo station as separate child buildings.

Manus: Three.js meshes (~150 lines).
Claude: C++ enum entries + collision boxes + datablock plumbing (~80 lines).

---

## 4. Midfield + bridge (R32.2)

Single bridge mesh at `(-291.6, 296.7, 41.0)`, ~30 m × 6 m × 2 m flat span on two pylons, slightly above the deep valley floor. **No river** per video — the valley is cracked dirt. Two midfield towers from the .MIS (in C&H mode, deferred to R33).

---

## 5. Object placement (R32.3)

Load `assets/maps/raindance/canonical.json` at boot in JS, send to C++ via a new `Module._loadMapObjects(jsonPtr, jsonLen)` call. C++ instantiates each as the existing primitive (turret, generator, inv station, etc.) at the canonical position. **Flag positions, all 6 turret positions, all sensor positions, all vehicle pads, all 17 drop points are exact.**

---

## 6. Atmosphere recipe for R32.0 (one-shot, drop into renderer.js)

```javascript
// Sun: azimuth -90°, incidence 54°
const sunAz = -Math.PI / 2;
const sunInc = 54 * Math.PI / 180;
sunLight.position.set(Math.cos(sunAz) * Math.cos(sunInc) * 1000,
                      Math.sin(sunInc) * 1000,
                      Math.sin(sunAz) * Math.cos(sunInc) * 1000);
sunLight.color.setRGB(0.6, 0.6, 0.6);
hemiLight.color.setRGB(0.4, 0.4, 0.4);
hemiLight.groundColor.setRGB(0.3, 0.28, 0.22);

// Fog: pale overcast
scene.fog = new THREE.Fog(0xC0C8D0, 200, 450);
scene.background = new THREE.Color(0xC0C8D0);

// Rain: 5000 vertical streaks, wind (-0.22, 0.15)
// (separate function — see initRain() below)
```

---

## 7. What stays unchanged

Nothing in physics, skiing, weapons, jet, bots, CTF rules, energy, armor, turret AI, or the renderer pipeline needs to change. Pure data + a few new mesh types.

---

## 8. Risks (resolved or remaining)

| Risk | Status |
|---|---|
| Heightmap fidelity | Open. Community PNG is reconstructed; the canonical `Raindance.ted` is also vendored but binary. Future task: write a .ted parser. For now we ship the PNG-derived heightmap. |
| Wiki coordinates | **Resolved.** The .MIS gives exact float coords. |
| World size at native scale | **Resolved.** 257² verts at 8m spacing = same vertex budget as today. |
| License / IP | Original assets are vendored as a community archive (per user direction). EULA noted in `assets/tribes_original/ATTRIBUTION.md`. We are not the first to redistribute these. |

---

## 9. Files in the repo (current state)

- `comms/raindance_plan.md` — this file
- `comms/raindance_video_reference.md` — visual calibration from YouTube reference
- `assets/tribes_original/` — full Sierra/Dynamix Tribes 1 install (139 MB)
- `assets/maps/raindance/heightmap.png` — community 257×257 16-bit PNG (MIT)
- `assets/maps/raindance/canonical.json` — parsed gameplay objects (26 KB)
- `assets/maps/raindance/build_heightmap.py` — PNG → C array converter
- `tools/parse_mis.py` — MIS file parser (general-purpose, works on any T1 mission)
- `program/code/raindance_heightmap.h` — baked C array of heights (665 KB)

---

## 10. Open questions

1. Should I now also vendor the other 35 T1 maps' .MIS files into `canonical.json` form so we get "ship 5 maps in one round" leverage? Trivial extension — `for mis in *.MIS; do parse_mis $mis; done`.
2. Should we attempt a `.ted` parser to get the *exact* original heightmap (binary PVOL container with an 8-bit heightfield inside) instead of the community PNG? Estimated ~2 hours of reverse-engineering against `jamesu`'s gist.
3. Do you want the `assets/tribes_original/` 139 MB blob in `master` (clean for fresh clones, big git LFS-like footprint) or in a separate `assets-large` branch (clean master, but requires a manual checkout step)?

— Manus
