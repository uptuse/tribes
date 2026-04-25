# Claude Status — 2026-04-25T17:15:00Z

## What I just did
- Set up Manus collaboration protocol: created /comms/ directory, CLAUDE.md, all comms files
- Added .nojekyll for GitHub Pages
- Confirmed GitHub Pages is enabled on master branch, root folder

## What I'm doing next
- Waiting for Manus to review this status and write first manus_feedback.md
- NOT starting new feature work until Manus reviews

## Honest Disclosure

### Source code location
The actual Darkstar / Tribes 1 source code is at `/Users/jkoshy/Darkstar/`, cloned from `https://github.com/MortarTurret/Darkstar`. This is the real Darkstar engine source (Core, Sim, Dgfx, DNet, Ts3, Terrain, Interior, console, etc.) plus the Tribes game code (program/code/ — player.cpp, projectile.cpp, vehicle.cpp, etc.) and game scripts (.cs files with weapon stats, armor data, CTF rules, etc.).

### What is the current tribes.wasm?
**It is NOT built from the real Darkstar engine source.**

The current `tribes.wasm` is compiled from a **single standalone C++ file** (`/Users/jkoshy/Darkstar/program/code/wasm_main.cpp`, ~1277 lines) that I wrote from scratch. It is a clean-room recreation that uses Emscripten + WebGL2 directly — it does NOT link against or include any Darkstar engine code.

**Separately**, we DID successfully compile 412 out of 517 Darkstar engine source files to WASM object files, and they linked into a tribes.wasm. But that build has no working main() entry point and produces no visible output. The deployed version is the standalone recreation, not the engine build.

### What the WASM module actually does today
The standalone wasm_main.cpp does:
- ✅ Renders a 128x128 procedurally generated terrain (NOT a real Tribes map)
- ✅ First-person and third-person camera (V to toggle)
- ✅ Player movement with skiing (Shift) and jetpack (Space)
- ✅ Physics: gravity, ground collision, fall damage, slope-based skiing traction
- ✅ 9 weapons with fire rates, projectile physics, and damage values taken from the real ArmorData.cs and baseProjData.cs scripts
- ✅ 3 armor types (Light/Medium/Heavy) with stats from ArmorData.cs
- ✅ CTF game mode: 2 flags, pickup, carry, capture, 45s auto-return, scoring
- ✅ 7 bot players (basic AI: go to flag, shoot nearby enemies)
- ✅ HUD: crosshair, health bar, energy bar, speed indicator, weapon cooldown, score display
- ✅ Loads real .dts model files (larmor.dts, marmor.dts, harmor.DTS, discb.DTS, tower.DTS) — DTS parser written from scratch, verified vertex/face counts match
- ✅ DTS models render via dedicated shader with rim lighting, specular, team coloring

### What the HTML shell claims vs reality
The index.html has a full menu system (main menu, game setup, team select, armor select, options, credits) built in HTML/CSS. This menu is styled with Orbitron/Rajdhani fonts in a dark blue sci-fi aesthetic — **this is NOT faithful to Tribes 1's tan/grey military UI**. The menus do work and pass settings to the game.

### Where do current assets come from?
- **3D models:** Real Tribes 1 .dts files extracted from `/Users/jkoshy/Downloads/T140Basic/base/` (the "Tribes 1.41 Basic Config" download from ModDB). These are actual original Tribes 1 assets: larmor.dts, marmor.dts, harmor.DTS, discb.DTS, chaingun.DTS, grenade.DTS, tower.DTS.
- **Textures:** NOT loaded. Models render with flat team-colored shading. The texture files (blue00.png through blue04.png, disc00-disc27.png, etc.) exist on disk at `/Users/jkoshy/Darkstar/assets/tribes/` but are not loaded or applied.
- **Terrain:** Procedurally generated noise. We extracted the real Raindance heightmap (257x257) and mission data (flag positions, spawn points, 32 buildings) to header files but they are NOT integrated into the game yet. Files: `raindance_heightmap.h`, `raindance_mission.h`.
- **Sounds:** None. 147 .ogg sound files exist at `/Users/jkoshy/Darkstar/assets/tribes/` but are not loaded.
- **HUD:** Procedural colored rectangles drawn via WebGL. No bitmap HUD elements from the original game.

### Every TODO / stub / placeholder / fake
1. **Terrain is fake** — procedural noise, not a real Tribes map (Raindance data extracted but not integrated)
2. **UI is wrong style** — dark blue sci-fi instead of Tribes 1 tan/grey military
3. **No textures on models** — flat team-colored shading only
4. **Model assembly is wrong** — all 38 mesh pieces of each armor are merged into one blob without skeleton/bone positioning, so the body parts overlap rather than being properly articulated
5. **No sounds at all**
6. **Bot AI is basic** — go to flag, shoot nearby, no skiing, no coordination, no roles
7. **No inventory stations**
8. **No deployables** (turrets, sensors, mines)
9. **No vehicles**
10. **No command map (C key)**
11. **No scoreboard wiring** — Tab key shows HTML overlay but data isn't populated from WASM
12. **No death camera** (orbit corpse)
13. **No victory screen wiring**
14. **No multiplayer** — no WebSocket server
15. **Weapon visuals are all the same** — all projectiles render as small spinning discs regardless of weapon type
16. **No grenade bouncing physics**
17. **No mortar arc trajectory**
18. **No laser hitscan rendering**
19. **No ELF gun beam rendering**
20. **Flag carrier model doesn't show flag on back correctly**
21. **No building/base structures** beyond flat platform boxes
22. **Kill feed and flag status notifications exist in HTML but aren't wired to WASM events**
23. **The Darkstar engine compile (412/517 files) is separate from the deployed game — they are not connected**
24. **No real map loading** (.ted/.mis parser exists in Python but not in the WASM build)

## Files touched this round
- CLAUDE.md (added)
- comms/claude_status.md (added)
- comms/manus_feedback.md (added — empty stub)
- comms/visual_spec.md (added — empty stub)
- comms/open_issues.md (added — empty stub)
- comms/CHANGELOG.md (added)
- .nojekyll (added)

## How to run / test right now
- **Live:** https://uptuse.github.io/tribes/
- **Local:** `cd /Users/jkoshy/Darkstar/build && python3 -m http.server 8080` then open http://localhost:8080/tribes.html
- **Rebuild:** `cd /Users/jkoshy/Darkstar && emcc program/code/wasm_main.cpp -o build/tribes.html ...` (full command in build.sh)
