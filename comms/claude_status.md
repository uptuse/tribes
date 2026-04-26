# Claude Status — 2026-04-25T20:45:00Z

## What I just did (this session, in order)

### Phase 1 — Engine port (completed earlier today)
- Ported the Darkstar engine (1708 C/C++ source files) from Win32/x86 to Emscripten/WASM
- Created `platform.h` (~1700 lines) replacing `<windows.h>` with portable types and stubs
- Rewrote 38 x86 assembly files as portable C++
- Created stub headers: dsound_stub.h, dinput_stub.h, winsock_stub.h, commdlg.h, COMMCTRL.H
- 412/517 files compile, links to tribes.wasm (but this engine build is NOT the deployed game)
- **The deployed game is a standalone clean-room C++ recreation** (`program/code/wasm_main.cpp`, ~1400 lines) compiled directly with emcc

### Priority 1 — Real Raindance terrain
- Replaced procedural noise with real Raindance heightmap (257x257 from `raindance_heightmap.h`)
- Set world scale to 8m/cell, ~2km map
- Applied Tribes 1 terrain palette: olive-green grass → tan-brown dirt, grey rock on slopes
- Fog: linear 600-1500m, color #B8C4C8
- Sky: grey-blue horizon #B8C4C8 → zenith #5A6A7A (pitch-reactive)
- Flag positions from real Raindance mission data
- **Fixed red artifact**: neutralized base boxes and tower tint to grey

### Priority 2 — Tribes 1 UI shell
- Removed Orbitron/Rajdhani fonts, added Cinzel + Barlow Condensed
- Rebuilt main menu matching ref_main_menu_v130.png: gold beveled TRIBES wordmark, 2x2 text grid
- All panels: brass border #7A6A4A, near-black fill, parchment text #E8DCB8
- No blue anywhere except Diamond Sword team color
- All existing JS hooks preserved

### Priority 3 — DTS skeletal hierarchy
- Extended `dts_loader.h` to parse nodes (parent chain), transforms (Quat16 quaternion + Point3F), objects (mesh-to-node link)
- Added `getNodeWorldTransform()` — walks skeleton from mesh node to root accumulating quaternion rotations
- `uploadModel()` applies skeleton transform + object offset to vertices before GPU upload
- **Fixed axis mapping**: changed `gz = -dy` to `gz = dy` (model was upside down)
- Manus confirmed in Round 4: "torso, arm, and legs are now identifiable as separate articulated parts"

### Tier 1.3 — Core movement physics
- Rewrote player movement to match original `playerUpdate.cpp` (lines 584-731)
- Jet force splits between lateral and vertical based on input direction and current velocity vs maxJetForwardVelocity
- Jump impulse along surface normal with directional component
- Skiing: near-zero traction, slope gravity projection, minimal friction (0.998)
- Ground movement: acceleration-based with groundForce/mass/traction formula
- Jump contact counter (8 ticks / 256ms re-jump prevention)
- Gravity tuned to ~25 m/s²

### Tier 1.4 — Spinfusor mechanics
- Added disc acceleration from 65 → 80 m/s terminal velocity
- Splash impulse scales by mass and distance, with extra upward kick for disc jumping
- Inherited velocity (50% of player speed) was already working

## What I tried that didn't work

### Heightmap tiling (Issue 2.2 — UNRESOLVED)
- The extracted Raindance heightmap repeats every 64 columns at boundary rows
- **Root cause investigation**: The `.ted` file contains a single GridBlock (GBLK version 5) with LZH-compressed float data. My Python LZH decompressor produces 264,196 bytes = 66,049 floats = 257×257, which is the correct count. But the data shows only 43-88 unique values per row, and rows 0/64/128/192 are identical.
- **Manus diagnosis** (in `comms/reference_impl/heightmap_decoder.md`): Full Raindance is 3×3 TerrainBlocks (769×769 total), not a single block. But our `.ted` file only contains ONE block (`Raindance#0.dtb`). The single block's low resolution may be genuine — it's one ninth of the full map.
- **Manus recommendation**: Extract raw UInt16 heightmap from the full Terrain2 system, or port the LZH decompressor properly.
- **Status**: Parked. The terrain is playable with the tiling — it has real Raindance heights (6-77m) and creates recognizable topology. The full 769×769 extraction would require either running the original Darkstar binary or finding the remaining 8 terrain blocks.
- **Where the other blocks might be**: Check if the Raindance.mis file references a `.ter` file or additional `.dtb` blocks. Also check `/Users/jkoshy/Downloads/T140Basic/base/missions/Raindance.zip` for additional terrain data.

### Background agents introducing regressions
- Multiple agents modified `console.h`, `ml.h`, `m_mat2.h`, `m_mat3.h` simultaneously, causing compile count to drop from 385 to 57 at one point
- **Lesson**: Never let agents modify core headers in parallel. Do those edits myself.
- Agent-modified `console.h` was reverted 3 times via `git checkout HEAD --`

### Model rendering — models loaded but appeared as boxes
- DTS models loaded and uploaded to GPU successfully (confirmed via console logs)
- But models appeared tiny/invisible because DTS packed vertices produce ~0.5-1.0 unit tall models
- Fixed by boosting scale to 3.0x base, then normalized across armor types
- Models now render but Manus reports they may still need axis/orientation tuning

## Current state of key files

### `/Users/jkoshy/Darkstar/program/code/wasm_main.cpp` (~1450 lines)
The entire deployed game. Single file. Contains:
- Vec3/Mat4 math, terrain (Raindance heightmap), armor/weapon data tables
- Player struct with physics, 9 weapon types, CTF flag logic
- DTS model loading and rendering (with skeleton transforms)
- Bot AI (basic: go-to-flag, shoot nearby)
- HUD (health, energy, speed, weapon, crosshair, score)
- WebGL shaders (terrain, objects, DTS models, HUD)

### `/Users/jkoshy/Darkstar/program/code/dts_loader.h` (~950 lines)
Header-only DTS parser. Reads PERS header, Shape v8 structure, CelAnimMesh v3.
Now also parses nodes, transforms, and objects for skeleton hierarchy.
Outputs: LoadedModel with meshes (vertices, normals, indices, nodeIndex, offset), nodes (parent chain), transforms (quaternion + translate).

### `/Users/jkoshy/Darkstar/shell.html`
Emscripten HTML shell with Tribes 1 UI. Cinzel + Barlow Condensed fonts, gold/brass palette.
Menu flow: Main Menu → Game Setup → Team Select → Armor Select → DEPLOY.
In-game: Tab=scoreboard, Esc=menu, kill feed, flag status notifications.

### `/Users/jkoshy/Darkstar/program/code/raindance_heightmap.h` (647KB)
257×257 float array extracted from Raindance.dtb via Python LZH decompressor.
Has tiling artifact at 64-column boundaries. Heights 6.6 to 76.9 meters.

### `/Users/jkoshy/Darkstar/program/code/raindance_mission.h` (6.1KB)
Flag positions (2), team0 drop points (24), team1 drop points (34), 32 interior buildings, generators, turrets, sensors, stations with world coordinates.

### `/Users/jkoshy/tribes/` (git repo → github.com/uptuse/tribes)
Deployment directory. Contains built index.html, tribes.js, tribes.wasm, tribes.data (DTS models), comms/ protocol files, reference images.

## Asset locations on disk

- **Darkstar engine source**: `/Users/jkoshy/Darkstar/` (cloned from github.com/MortarTurret/Darkstar)
- **Tribes game assets**: `/Users/jkoshy/Darkstar/assets/tribes/` (extracted from `/Users/jkoshy/Downloads/T140Basic/`)
- **DTS models for build**: `/Users/jkoshy/Darkstar/assets_min/tribes/` (7 key models only, 1.1MB)
- **Original game download**: `/Users/jkoshy/Downloads/T140Basic/` (Tribes 1.41 Basic Config from ModDB)
- **Emscripten SDK**: `/Users/jkoshy/emsdk/`

## Build command

```bash
export PATH="/Users/jkoshy/emsdk:/Users/jkoshy/emsdk/upstream/emscripten:/Users/jkoshy/emsdk/node/22.16.0_64bit/bin:$PATH"
cd /Users/jkoshy/Darkstar
emcc program/code/wasm_main.cpp -o build/tribes.html \
  -std=c++14 -I program/code \
  -s USE_WEBGL2=1 -s FULL_ES3=1 -s ALLOW_MEMORY_GROWTH=1 -s INITIAL_MEMORY=134217728 \
  --shell-file /Users/jkoshy/Darkstar/shell.html \
  --preload-file assets_min/tribes@/assets/tribes \
  -O0 -g0 -Wno-format \
  -s EXPORTED_FUNCTIONS='["_main"]' -s EXPORTED_RUNTIME_METHODS='["ccall","cwrap"]'
```

## Deploy command

```bash
cp build/tribes.html /Users/jkoshy/tribes/index.html
cp build/tribes.{js,wasm,data} /Users/jkoshy/tribes/
cd /Users/jkoshy/tribes
git add -A && git commit -m "message" && git push origin master
```

## What's next (priority order per Manus master plan)

1. **Verify skeleton silhouettes** — Manus will review the axis fix visually. If still wrong, try negating x_out or swapping axis order.
2. **Tier 1.5 — Base geometry & flag logic** — Load tower.DTS at flag positions with collision. Currently bases are flat grey boxes.
3. **Tier 2.6 — Full weapon arsenal** — Chaingun (fast projectile), grenade (bouncing), plasma (slower), mortar (arc), laser (hitscan). Currently all weapons fire as projectiles but visuals are identical.
4. **Tier 2.7 — Base infrastructure** — Generators, turrets, inventory stations.
5. **Tier 3.8 — Textures** — Load BMP→PNG terrain textures and armor skins.
6. **Tier 3.9 — UI polish** — Authentic HUD (compass, inventory column, proper health bars).

## Manus comms protocol
- Before every task: `git pull`, read `comms/manus_feedback.md` and `comms/open_issues.md`
- After every change: rewrite this file, append to `comms/CHANGELOG.md`, commit, push
- Manus auto-reviews on push (5-min poll)
- Address PRIORITY items before new work
- One priority per commit

## How to run / test right now
- **Live:** https://uptuse.github.io/tribes/
- **Local:** `cd /Users/jkoshy/Darkstar/build && python3 -m http.server 8080` → http://localhost:8080/tribes.html
