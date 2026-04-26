# Claude Status — 2026-04-25T21:15:00Z

## What I just did (this session)

### Repo restructure — source files moved into tribes repo
- Copied clean-room recreation files from `/Users/jkoshy/Darkstar/` into the tribes repo
- Source now lives at `program/code/` within the repo (matches original path structure)
- Added `build.sh` at repo root with emcc build command
- Added `BUILD.md` documenting build process and asset requirements
- Assets in `assets/` directory, `.gitignore`d (DTS/BMP/VOL binaries)
- Generated headers (`raindance_heightmap.h`, `raindance_mission.h`) are committed source
- Build verified working from new location

### Tier 1.5 — Base geometry with collision
- Added `Building` struct with AABB collision volumes
- Populated 30+ buildings from `raindance_mission.h` — interiors, generators, turrets, stations
- Building types sized per Tribes original: esmall (5x4x5), bunker (4x3x4), cube (2x2x2), floating pads (6x0.5x6), bridges, observation towers, rocks
- BETower entries skipped (rendered as DTS tower models at flag positions)
- Rocks marked `isRock=true` — visual only, no collision (natural terrain features)
- `resolvePlayerBuildingCollision()` — pushes player out of building AABBs along shortest exit axis
- Supports standing on top of buildings (y-axis push-up)
- Applied to both local player and bot movement
- `projectileHitsBuilding()` — projectiles detonate on building impact
- All buildings rendered as colored boxes in the object batch pass
- Build compiles and deploys successfully

## Current state of key files

### `/Users/jkoshy/tribes/program/code/wasm_main.cpp` (~1600 lines)
The entire deployed game. Single file. Contains:
- Vec3/Mat4 math, terrain (Raindance heightmap), armor/weapon data tables
- Player struct with physics, 9 weapon types, CTF flag logic
- DTS model loading and rendering (with skeleton transforms)
- **NEW: Building system** — AABB collision volumes from mission data
- Bot AI (basic: go-to-flag, shoot nearby)
- HUD (health, energy, speed, weapon, crosshair, score)
- WebGL shaders (terrain, objects, DTS models, HUD)

### `/Users/jkoshy/tribes/program/code/dts_loader.h` (~950 lines)
Header-only DTS parser. Reads PERS header, Shape v8 structure, CelAnimMesh v3.
Parses nodes, transforms, and objects for skeleton hierarchy.

### `/Users/jkoshy/tribes/shell.html`
Emscripten HTML shell with Tribes 1 UI. Cinzel + Barlow Condensed fonts, gold/brass palette.

### `/Users/jkoshy/tribes/program/code/raindance_heightmap.h` (647KB)
257×257 float array extracted from Raindance.dtb.

### `/Users/jkoshy/tribes/program/code/raindance_mission.h` (6.1KB)
Flag positions, drop points, 32 interior buildings, generators, turrets, sensors, stations.

### `/Users/jkoshy/tribes/build.sh`
Build script. Handles sandboxed environments via /tmp emscripten cache.

### `/Users/jkoshy/tribes/assets/` (gitignored)
DTS models: larmor.dts, marmor.dts, harmor.DTS, discb.DTS, chaingun.DTS, grenade.DTS, tower.DTS

## Read-only reference
- **Darkstar engine source**: `/Users/jkoshy/Darkstar/` — read-only, not writeable from Claude Code
- **Tribes game assets**: `/Users/jkoshy/Darkstar/assets/tribes/`
- **Original game download**: `/Users/jkoshy/Downloads/T140Basic/`

## Build command

```bash
cd /Users/jkoshy/tribes && ./build.sh
```

## Deploy command

Build script auto-deploys to repo root. Then:
```bash
cd /Users/jkoshy/tribes && git add -A && git commit -m "message" && git push origin master
```

## What's next (priority order)

1. **Manus review of building collision** — verify buildings render at correct positions, collision feels right
2. **Tier 2.6 — Full weapon arsenal** — distinct projectile visuals and behavior per weapon type
3. **Tier 2.7 — Base infrastructure** — generators (destructible), turrets (auto-aim), inventory stations
4. **Tier 3.8 — Textures** — BMP→PNG terrain textures and armor skins
5. **Tier 3.9 — UI polish** — compass, inventory column, proper health bars

## Manus comms protocol
- Before every task: `git pull`, read `comms/manus_feedback.md` and `comms/open_issues.md`
- After every change: rewrite this file, append to `comms/CHANGELOG.md`, commit, push
- Manus auto-reviews on push (5-min poll)
- Address PRIORITY items before new work

## How to run / test right now
- **Live:** https://uptuse.github.io/tribes/
- **Local:** `cd /Users/jkoshy/tribes/build && python3 -m http.server 8080` → http://localhost:8080/tribes.html
