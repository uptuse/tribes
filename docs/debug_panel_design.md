# Firewolf Live Debug Tuning Panel Architecture

## 1. Overview
The debug panel allows runtime tweaking of variables across the C++ WASM layer, the JS Three.js layer, and the Rapier physics layer. It uses `lil-gui` loaded via CDN and only appears when `?debug` is in the URL.

## 2. Layer 1: WASM (`wasm_main.cpp`)
Currently, game constants (ArmorData, WeaponData, GRAVITY) are `static const` or local variables.
To make them tunable:
- Add `static float g_dbg_*` variables for each tunable constant.
- Initialize them with the original values.
- Replace hardcoded constants in the physics and combat loops with the `g_dbg_*` variables.
- Add a new exported C function: `extern "C" void setDebugConfig(const char* json)`.
- Use the existing `sGetF` helper to parse the JSON string.
- Add `extern "C" const char* getDebugConfig()` which allocates a JSON string using `malloc` (caller must `free`), or returns a static buffer to avoid allocation complexity. Since we need to return a string to JS, returning a `const char*` to a static buffer is easiest for Emscripten's `UTF8ToString`.

## 3. Layer 2: JS Rendering (Three.js)
Modules expose `window.*` facades.
- `renderer_camera.js`: Already has `window._tribesCamDist`, `window._tribesCamHeight`. Need to expose FOV and damping.
- `renderer_postprocess.js`: Exposes `getBloomPass()`. The panel can modify `bloomPass.strength`, `bloomPass.threshold`, `renderer.toneMappingExposure`.
- `renderer_daynight.js`: Exposes `freeze(hour)`. The panel can call this.
- `renderer_particles.js`: Add getters/setters for `_JET_TEAM_COLORS` or emission rates.

## 4. Layer 3: Rapier Physics
`renderer_rapier.js` exposes `window.RapierPhysics`.
- Add `setGravity(g)` which calls `world.gravity = {x:0, y:-g, z:0}`.
- Add `setCharacterControllerParams(offset, stepHeight, maxSlope)` which calls the respective methods on `characterController`.

## 5. UI (lil-gui)
- Load `lil-gui.umd.min.js`.
- Create folders: Physics, Movement, Weapons, Camera, Rendering, DayNight.
- Add `gui.save()` export functionality.
- Bind `onChange` handlers to send JSON to WASM or call JS facades.
