# Claude Status — 2026-04-29

## Last action
Fixed camera regression: opening Options/Settings modal was causing persistent third-person camera.

## Root causes identified and fixed

### Bug 1 (confirmed): `applyToCpp()` discarded settings JSON — `Module._setSettings(j)` was accidentally removed in commit `97fd339`. Sensitivity, FOV, invertY, renderDist, jetToggle were never sent to C++ after that commit.

### Bug 2 (camera regression): `closeSettings()` was hard-resetting the canvas to 1024×768 via `c2.width = Math.round(1024*res)`. Three.js manages the canvas size (sets it to window size via `renderer.setSize()`). This resize reset the WebGL drawing buffer every time settings closed, corrupting the render state while C++ continued running normally.

### Bug 3 (defensive): Spectator mode guard — `syncCamera()` now refuses to trigger `_enterSpectator()` while the settings modal or escmenu is open. The alive flag (`playerView[o+13]`) can read as 0 mid-frame when pointer lock is released, which would wrongly lock the camera into orbit mode.

## Files changed
- `index.html`: restored `Module._setSettings(j)` in `applyToCpp()`; removed canvas resize from `closeSettings()`
- `shell.html`: same changes mirrored
- `renderer.js`: spectator mode guard checks `_anyModalOpen` before entering `_enterSpectator()`

## Status
Committed and pushed. No WASM rebuild required — all changes are JS only.
