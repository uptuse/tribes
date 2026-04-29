# Item 23 — Extract renderer_camera.js

## Finding
renderer.js contained ~234 lines of camera control code — syncCamera, spectator orbit,
FOV management, aim-point ray-march, shadow follow, zoom integration.

## Fix (R32.234)
Created `renderer_camera.js` (233 lines) with dependency-injected API:

### Exports
| Export | Purpose |
|--------|---------|
| `init(deps)` | Set camera + dependencies (Module, sunLight, DayNight, getters) |
| `update()` | Per-frame camera sync (1P/3P, spectator, FOV, shadow follow) |
| `enterSpectator(x,y,z)` | Enter death spectator orbit |
| `exitSpectator()` | Return to live camera |
| `addFovPunch(v)` | Set FOV punch from explosions |
| `dispose()` | Cleanup |

### Dependencies injected via init
- `camera` — THREE.PerspectiveCamera
- `Module` — Emscripten WASM (for _getLocalPlayerIdx, _getCameraFov, etc)
- `sunLight`, `DayNight` — for shadow follow
- `getPlayerView()` — closure returning { view, stride }
- `getWeaponHand()` — closure returning weapon viewmodel mesh
- `sampleTerrainH` — Terrain.sampleHeight function
- `getLastTickTime()` — closure for FOV decay timing
- `MAX_PLAYERS` — constant

### State moved to camera module
- `_spec` (spectator orbit state)
- `_fovPunchExtra` (FOV punch from explosions)
- `_tmpVec`, `_aimPoint3P` (reusable temporaries)

### Lines removed from renderer.js
- ~225 lines of camera code (spectator + syncCamera)
- ~10 lines of state declarations
- Total: renderer.js 3702 → 3477

### Call sites updated
1. `start()` — `Camera.init({...})` after initStateViews
2. Render loop — `Camera.update()` replaces `syncCamera()`
3. FOV punch callback — `Camera.addFovPunch(v)` replaces direct `_fovPunchExtra = v`

## Cohort Review
- **Carmack** (perf): Getter closures add negligible overhead. No extra allocations.
- **Muratori** (arch): Clean DI pattern matches Particles.init convention.
- **Blow** (correctness): Ray-march logic preserved exactly. FOV decay timing unchanged.
- **Ive** (design): Spectator cinematic preserved — orbit, letterbox, fadeIn.

## Risk: LOW
Camera logic moved verbatim. Dependencies injected cleanly via closures.
