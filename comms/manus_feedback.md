# Brief to Claude — R32.0 Raindance Heightmap Ship

**From:** Manus
**Date:** 2026-04-26
**Round:** R32.0 (Raindance Phase 1 — real terrain)
**Priority:** P0
**Supersedes:** R31.7.1 (which is fully shipped — see CHANGELOG)

## What just happened (Manus, this round)

I vendored the complete original Sierra/Dynamix Starsiege: Tribes v1.11 install from `levizoesch/tribes.game` into `assets/tribes_original/` (139 MB). Inside is `base/missions/Raindance.MIS` — the canonical mission script as plain TorqueScript text — plus `Raindance.ted` (binary terrain) and all the lush biome volumes. User explicitly directed: "these assets have been released, grab everything." Attribution at `assets/tribes_original/ATTRIBUTION.md`.

I parsed the .MIS into `assets/maps/raindance/canonical.json` (26 KB) using a new general-purpose mission parser at `tools/parse_mis.py`. Every flag, turret, sensor, generator, inv station, vehicle pad, command station, drop point, and architectural shape now has its exact canonical position, rotation, and datablock name.

I regenerated `program/code/raindance_heightmap.h` (665 KB) from the community heightmap PNG via a new `assets/maps/raindance/build_heightmap.py`. The previous `raindance_heightmap.h` was a placeholder (a 64×64 tile repeated 4× to fill 257×257) — it's now the real Raindance heightfield, 0–200 m vertical relief, 257×257 verts at 8 m spacing, 2048 m × 2048 m world.

Full plan: `comms/raindance_plan.md`. Visual reference: `comms/raindance_video_reference.md`.

## What I need from you (Claude, R32.0)

### C1 — Rebuild WASM (P0, ~2 min)

Just run `./build.sh`. The C++ already references `RAINDANCE_HEIGHTS`, `RAINDANCE_SIZE`, `RAINDANCE_HEIGHT_MIN/MAX`, and `getH()` already does bilinear lookup. The header is freshly regenerated. No code edits needed — just rebuild and commit `tribes.wasm` + `tribes.data` + `tribes.js` + `index.html`.

Sanity check after build: add a `printf` once at startup confirming `RAINDANCE_HEIGHT_MAX > 100.0f` (proves the new header loaded; the old placeholder's max was 76.9). Remove the printf after first run.

### C2 — Apply canonical lighting + fog + sky color (P0, ~10 min)

The current renderer.js uses default sun + sky. Per `Raindance.MIS`:

- **Sun:** azimuth -90°, incidence 54°, RGB intensity (0.6, 0.6, 0.6), ambient (0.4, 0.4, 0.4), cast shadows
- **Fog:** haze distance 200 m → visible distance 450 m, color `#C0C8D0` (pale overcast)
- **Sky background:** `#C0C8D0` (matches fog so the horizon blends)
- **Camera far plane:** 450 m (currently we use ~1000 m)

Drop the recipe block from `comms/raindance_plan.md` §6 directly into `renderer.js` `initLights()` and `initScene()`. This is a JS edit — could be Manus, but you have build privileges; whichever is faster.

### C3 — Add screen-space rain (P1, ~20 min)

Per the .MIS, `Snowfall "Rain1" intensity=1 wind=(-0.22, 0.15, -75)`. Three.js `Points` system: ~5000 falling streaks anchored to camera, vertical velocity ~30 m/s, slight horizontal drift from wind XY.

### C4 — Confirm renderer reads heightmap correctly (P0 verification, ~5 min)

After rebuild, take a screenshot from spawn and post in your reply. We should see real terrain undulation (not procedural rolling hills). Skiing should feel different — Raindance has long deep valleys. Two clear high points roughly NW and SE where the bases will go in R32.1.

If terrain looks flat or wrong, check that `initTerrain()` in renderer.js is sampling `Module._getHeightmapPtr()` correctly (the export was already in place from a prior round).

## Open architectural decisions (please weigh in)

1. **Should we git-large-file the 139 MB `assets/tribes_original/`?** Or move it to a separate `assets-large` branch with a `make assets` step to fetch on demand? My instinct is keep it on master for simplicity since master is private.
2. **R32.1 building types:** I'm planning `BUILDING_TOWER` and `BUILDING_GENROOM` as new C++ enum entries. You'll own the C++ side (collision boxes, datablock mapping) — let me know if you'd rather I prototype the Three.js meshes first so you can size collision to match.
3. **`.ted` parser:** Should we attempt to parse `Raindance.ted` (binary PVOL container with the canonical 256×256 8-bit heightfield inside) for true bit-perfect terrain? Estimated 2 hours against jamesu's format gist. Yes/no/defer to R32.0.1?

## Round complete checklist

- [ ] `tribes.wasm` rebuilt with new heightmap header
- [ ] Sanity printf confirms `HEIGHT_MAX ≈ 200.0f` at boot, then removed
- [ ] Lighting/fog/sky match canonical values
- [ ] Footer bumped to R32.0 in `index.html`
- [ ] Screenshot from spawn posted confirming real terrain visible
- [ ] CHANGELOG entry added
- [ ] Pushed to master

— Manus
