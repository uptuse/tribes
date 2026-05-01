# Handoff Summary — Firewolf Session (Apr 29 – May 1 2026)

## Original goal
Port Starsiege: Tribes (1998) to browser via WebAssembly + Three.js. Deliver a Unity/Godot-style in-game editor (12 modes), physics-grounded characters, LAN + WebRTC multiplayer, and HD Mixamo character pipeline.

## What shipped (working)

- **12-mode unified editor shell** — Shift+Enter panel, draggable, all modes functional
- **Crimson Sentinel character** — rigged, animated, grounded, textured (HD via 50k GLB transfer)
- **Locomotion system** — speed-matched stride, pelvis bob, foot IK, camera bob, ski transitions
- **Chasm water** — Gerstner wave shader at Raindance bridge
- **LAN server** — `server.js` + `start-server.command` (WebSocket relay, port 3000)
- **WebRTC P2P** — `client/browser_host.js`, short codes via local server signalling
- **Gamepad support** — `client/gamepad.js`, standard controller mapping
- **Training dummies** — 10 stationary enemy targets at red flag base, HP bar per target
- **Weapon overhaul** — disc=torus, chaingun=tracer, per-weapon frame colour, recoil spring
- **Sculpt mode** — live heightmap edit via `_writeHeightmapPatch` C++, Three.js vertex refresh
- **System reference** — `docs/SYSTEM_REFERENCE.md` (authoritative module map)

## Immediately open (next session priority)

- **Character models** — 5 Mixamo FBX in `tools/obj_export/` downloaded WITHOUT skin. Must re-download each from mixamo.com with **Skin = With Skin**. Then run fbx2gltf → add id to `ROSTER` in `renderer_characters.js`. See `docs/CHARACTER_RIG_AUDIT.md`.
- **Terrain sculpt persistence** — `_writeHeightmapPatch` writes to in-memory `g_heights[]`; lost on refresh. Needs export button or localStorage serialisation.
- **WebRTC AP-isolation** — some routers block device-to-device traffic (same root cause as LAN server failure). Router setting: disable "AP isolation" / "client isolation".

## Known bugs

- `auric_phoenix_rigged.glb` and `crimson_titan_rigged.glb` have **0 meshes** — downloaded as animation-only from Mixamo. Invisible at runtime. Removed from ROSTER.
- `emerald_sentinel`, `midnight_sentinel`, `obsidian_vanguard` have mesh but skin weights were added via proximity script (`tools/add_skin_weights.py`) — quality approximate, not Mixamo-quality. Re-export properly when possible.
- Animation editor standalone (`assets/models/animation_editor.html`) requires either local server (COOP/COEP headers) or the meta tags added in last commit to load on GitHub Pages.

## Key architectural decisions (with rationale)

- **Wrapper Group for characters** — `inner = skeletonClone()` preserves Mixamo's ±90°X bone fixup. `wrapper` receives position/rotation from WASM each frame. Never call `rotation.set()` on `inner`.
- **Per-instance `char.footOffset`** — computed per-clone from actual geometry, not module-level. Eliminates cross-model contamination.
- **`subscribeRigChange(cb)`** — replaces 800ms setTimeout guess for rig wiring.
- **ROSTER array** — single list of ids in `renderer_characters.js`; all paths (`_rigged.glb`, `_50k.glb`, `animSrc`) derived by factory. One line to add a character.
- **50k texture source** — textures transferred at load time from `*_50k.glb` onto rigged GLB via `_transferMaterials()`. Rigged GLB stays lightweight; textures come from HD source.
- **`applyToCpp()` restored** — `Module._setSettings(j)` was accidentally removed in an earlier commit. Settings (FOV, sensitivity, invertY) now reach C++ again.
- **`closeSettings()` canvas resize removed** — was destroying WebGL context on every settings close.

## Files to know (paths only)

| Path | Purpose |
|---|---|
| `renderer_characters.js` | Character GLB loader, wrapper Group, animation, grounding |
| `client/shell.js` | 12-mode editor shell, keyboard, draggable panel |
| `client/editor_animations.js` | Animate mode — timeline, clip library, character picker |
| `client/locomotion.js` | Speed-matched stride, pelvis bob, ski transitions |
| `client/foot_ik.js` | Heightmap-based foot planting (O(1) lookup) |
| `client/camera_grounding.js` | Footstrike bob, landing kick |
| `client/water.js` | Gerstner wave shader, Raindance chasm |
| `client/gamepad.js` | Standard controller → `Module._setGamepadInput()` |
| `client/browser_host.js` | WebRTC P2P (no server needed) |
| `client/network.js` | WebSocket/WebRTC binary relay |
| `server.js` | LAN relay + WebRTC signalling server (port 3000) |
| `start-server.command` | Double-click launcher, kills old instance first |
| `tools/glb_to_obj.py` | GLB → OBJ ZIP for Mixamo upload |
| `tools/add_skin_weights.py` | Proximity auto-skinning for mesh-no-skin GLBs |
| `docs/SYSTEM_REFERENCE.md` | Authoritative module map, read first in any new session |
| `docs/CHARACTER_RIG_AUDIT.md` | Every character's current rig status + re-export backlog |
| `docs/character-pipeline.md` | Asset pipeline rules (LODs, rigging, textures) |
