# Tribes Browser Edition — Project Guide

## Project Goal
Port Starsiege: Tribes (Dynamix, 1998, Darkstar engine) to run in a web browser via WebAssembly + WebGL2.

## Visual Goal (Locked)
Authentic look of Starsiege: Tribes (1999) as shipped, with optional non-silhouette-breaking modern enhancements.

- **Use original assets** wherever possible: .dts models, .bmp/.png textures, terrain heightmaps, HUD bitmaps, fonts, sounds from the user's local Tribes 1 / Darkstar source.
- **Tribes 1 UI** is tan/grey/military, bitmap fonts, utilitarian panels with tribe logos. The current dark-blue sci-fi shell is NOT Tribes and must be replaced.
- **Tribes 1 HUD:** circular compass/sensor top-center, energy/health bars bottom-left, ammo bottom-right, weapon select wheel, inventory station UI, command map (C key).
- **Gameplay feel:** skiing physics, jetpack energy, three armor classes (L/M/H), 1998-correct weapon stats, large outdoor heightmap terrain with bases and turrets.
- **Allowed modern enhancements:** higher-res textures, AA, bloom, better shadows, mipmaps — ONLY if silhouette and palette remain visually identical to 1999. If a modernization changes the silhouette, the answer is no.

## Comms Protocol
All communication between Claude and Manus happens through files in `/comms/`:

| File | Owner | Purpose |
|------|-------|---------|
| `claude_status.md` | Claude writes | Status after every meaningful change |
| `manus_feedback.md` | Manus writes | Feedback and directives — Claude reads FIRST |
| `visual_spec.md` | Manus writes | Canonical look-and-feel spec — ground truth |
| `open_issues.md` | Both edit | Shared backlog, mark [x] when done |
| `CHANGELOG.md` | Claude appends | One line per commit |

## Loop Rule
Before every new task:
1. `git pull`
2. Read `comms/manus_feedback.md` and `comms/open_issues.md`
3. Address anything marked PRIORITY before starting new work

After every meaningful change:
1. Rewrite `comms/claude_status.md`
2. Append to `comms/CHANGELOG.md`
3. Commit and push

## Manus Role
Manus is the art director and QA. Treat its feedback as **authoritative on visual fidelity** and **advisory on architecture**.

---

## Added 2026-05-01 (5-day session — architecture + editor + characters)

### Stack additions
- **Editor shell:** `client/shell.js` + 12 `client/editor_*.js` modules + `client/editor_core/` services
- **LAN server:** `server.js` (Node.js, port 3000). Launch: `start-server.command`
- **WebRTC P2P:** `client/browser_host.js`. Short codes via `/api/signal/*` endpoints on server.
- **Locomotion:** `client/locomotion.js`, `client/foot_ik.js`, `client/camera_grounding.js`
- **Gamepad:** `client/gamepad.js` → `Module._setGamepadInput(fwd, side, lookDX, lookDY, btns)`
- **Water shader:** `client/water.js` — Gerstner waves at Raindance chasm (-291.6, 8.5, -296.7)

### Architecture rules (never break)

1. **One scene graph, one WebGLRenderer.** Editor, animate mode, all palettes share them.
2. **Never overwrite `index.html` from build output.** `build.sh` + CI copy only `tribes.js/.wasm/.data`.
3. **Character wrapper Group pattern.** `inner = skeletonClone(_gltf.scene)` preserves Mixamo ±90°X bone fixup. `wrapper = new THREE.Group(); wrapper.add(inner)`. Only `wrapper` gets `position.set()` / `rotation.set()` per frame. Never touch `inner` transforms after clone.
4. **Per-instance `char.footOffset`**, not module-level. Computed per-clone after model is in scene.
5. **`subscribeRigChange(cb)`** in `renderer_characters.js` — animation editor subscribes here, no setTimeout.
6. **`Module._setPhysicsTuning()`** for physics only. `Module._setSettings(jsonStr)` for FOV/sensitivity/invertY/jetToggle. Never mix them.
7. **Never import Three.js from CDN.** Vendored at `vendor/three/r170/`.
8. **Version chip format:** `D Mon - HH:MM` (e.g. `1 May - 14:30`). Update on every push.
9. **Editor CSS tokens locked.** Amber = active state only. Warm paper light theme. No redesign without sign-off.
10. **`build.sh` never copies `tribes.html` → `index.html`.** If you see that line, remove it.

### Character pipeline
- Source models: `*_50k.glb` (HD textures, no rig)
- Rigged models: `*_rigged.glb` (Mixamo skeleton + skin + animations)
- Mixamo download setting: **Skin = With Skin** (NOT "Without Skin")
- Conversion: `/usr/bin/arch -x86_64 ~/.npm-global/.../FBX2glTF --input *.fbx --output assets/models/*_rigged --binary`
- Register: add id to `ROSTER` in `renderer_characters.js` — one line, all paths derived
- Textures transferred at runtime from `*_50k.glb` via `_transferMaterials()`
- Animation source: `crimson_sentinel_rigged.glb` — 14 clips shared to all via `animSrc`
- See `docs/CHARACTER_RIG_AUDIT.md` and `docs/character-pipeline.md`

### C++ state array offsets (player stride = 32 floats)
pos[0-2], rot[3-5], vel[6-8], health[9], energy[10], team[11], armor[12], alive[13], jetting[14], skiing[15], weaponIdx[16], numericId[17], visible[18], botRole[19]

### Known gaps as of May 1 2026
- Only `crimson_sentinel` has correct Mixamo skin weights. All others need re-export with "With Skin".
- Terrain sculpt (`_writeHeightmapPatch`) writes to in-memory `g_heights[]` — lost on refresh.
- No LOD switching (characters render at 50k poly). No asset upload endpoint.
- WebRTC blocked by AP isolation on some home routers (same issue as LAN server).

### Key docs to read at session start
1. `docs/SYSTEM_REFERENCE.md` — authoritative module map
2. `docs/HANDOFF_SUMMARY.md` — 60-second brief
3. `docs/CHARACTER_RIG_AUDIT.md` — character status
4. `comms/manus_feedback.md` — latest directives
