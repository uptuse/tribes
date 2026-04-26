# R31.4 Manus Brief — Wire 3rd-Person View through Three.js renderer

**Author:** new-Manus
**Date:** 2026-04-26
**Round type:** Surgical bugfix — single feature, three callsites
**Estimated scope:** 30–60 min
**Acceptance threshold:** 4/4 (small focused round)

---

## TL;DR for Claude

R31.3 acceptance verified live. User played and asked: *"is there a character model for me, and can I view it in 3rd-person? That's how I used to play. If not, just use a bot player model — keep it simple."*

Good news: **the local player already uses the same soldier model as bots**, and **3P is already wired in C++** — V key toggles `thirdPerson` (`wasm_main.cpp:1790`), camera moves to `pos + (0,3,0) - fwd*12` (`wasm_main.cpp:2264`), local-player mesh is conditionally rendered when `thirdPerson` is on (`wasm_main.cpp:2312`, 2336).

**Bug:** the active **Three.js renderer** ignores all of that. JS `syncCamera()` always sets first-person eye position, JS `syncPlayers()` unconditionally hides the local-player mesh, and the weapon viewmodel stays glued to the camera. So pressing V flips the C++ flag but the user sees no change.

This round wires three Three.js-side hooks into C++'s existing `thirdPerson` state.

---

## 1 · Code changes

### Step 1 — Add a getter for `thirdPerson` to the C++ extern "C" block

Find the export block near `program/code/wasm_main.cpp:1708` (where `getLocalPlayerIdx` and the R31.3 `getPlayerSkiing/Speed/SlopeDeg` getters live). Add:

```cpp
extern "C" {
    int getThirdPerson() { return thirdPerson ? 1 : 0; }
}
```

Add `_getThirdPerson` to `EXPORTED_FUNCTIONS` in `build.sh` (the same place D1's three getters were added).

Re-emit WASM.

### Step 2 — Three.js camera: respect 3rd-person

In `renderer.js`, function `syncCamera()` (~line 1312), replace the camera-positioning block:

```js
// Current (line 1332):
camera.position.set(px, py + 1.7, pz);
camera.rotation.set(pitch, -yaw, 0, 'YXZ');
```

with:

```js
const is3P = (Module._getThirdPerson && Module._getThirdPerson()) ? true : false;
camera.rotation.set(pitch, -yaw, 0, 'YXZ');
if (is3P) {
    // Match C++ wasm_main.cpp:2264 — eye = pos + (0,3,0) - fwd*12
    // Three.js forward at this rotation = (sin(yaw), -sin(pitch)*cos(yaw)?, -cos(yaw)).
    // Use a simple derived offset for predictability:
    const fwdX = Math.sin(yaw);
    const fwdZ = -Math.cos(yaw);
    camera.position.set(px - fwdX * 12, py + 3.0, pz - fwdZ * 12);
} else {
    camera.position.set(px, py + 1.7, pz);
}
```

(The fwd vector here ignores pitch — matches C++'s `fwd` at line ~2261 which only uses yaw for 3P chase. If pitch-aware framing feels better in playtest, we can add it next round.)

### Step 3 — Three.js local-player mesh: show in 3P, hide in 1P

In `renderer.js` function `syncPlayers()` (~line 1145), change the local-player skip block at line 1176-1180:

```js
// Current:
if (i === localIdx) {
    mesh.visible = false;
    if (nameplateSprites[i]) nameplateSprites[i].visible = false;
    continue;
}
```

to:

```js
const is3P = (Module._getThirdPerson && Module._getThirdPerson()) ? true : false;
if (i === localIdx && !is3P) {
    mesh.visible = false;
    if (nameplateSprites[i]) nameplateSprites[i].visible = false;
    continue;
}
// In 3P, fall through and render local player like any other — but suppress nameplate
// (player doesn't need a nameplate above their own head).
if (i === localIdx && is3P) {
    if (nameplateSprites[i]) nameplateSprites[i].visible = false;
}
```

The fall-through path then runs the standard rendering: `mesh.visible = visible && alive`, position+rotation set from `playerView`, team color, rig animation. **The local player will use the exact same soldier model as bots, with the same R31.x animation rig.** No new asset, no new code path — just remove the gate.

(Recompute `is3P` once at the top of `syncPlayers()` outside the loop for perf — only one WASM call per frame, not per player. Hoist the `const is3P = …` line right after `const localIdx = …` at line 1146.)

### Step 4 — Hide weapon viewmodel in 3P

In `renderer.js`, find the per-frame draw or `syncPlayers` end (or wherever animations tick the weapon). Easiest: in `syncCamera()` (already runs once per frame), after the is3P determination:

```js
if (typeof weaponHand !== 'undefined' && weaponHand) {
    weaponHand.visible = !is3P;
}
```

The viewmodel stays attached to camera (no need to detach), just hide it when 3P is on.

---

## 2 · Acceptance criteria (4/4 to pass)

1. **In-game press V** — camera pulls back ~12 m behind the player, ~3 m up. Releasing V (pressing again) returns to first-person at eye height.
2. **In 3P, the local player's soldier model is visible** in front of the camera, animated, oriented to match yaw, colored to match team. Same model the bots use.
3. **In 3P, the rifle viewmodel that normally floats in the lower-right corner is hidden** (otherwise it'd float in front of the camera 12 m away from the player and look wrong).
4. **Toggling between 1P and 3P does not break anything else** — HUD intact, ski HUD intact, hit-confirm intact, controls still work, no Three.js scene-graph errors in console.

---

## 3 · Out of scope

- New character/armor models (user is making custom models himself; reusing bot soldier model is the explicit user request).
- Camera collision with terrain (3P chase camera may briefly clip into a hill behind the player — note this for R31.5 if user complains; for now, accept).
- Pitch-aware 3P framing (yaw-only is fine for playtest).
- 3P over-the-shoulder offset (would be nice but not requested).
- Reticle/aim adjustment for 3P parallax (R31.5+ if needed).

---

## 4 · Self-audit (please include in claude_status.md)

- WASM re-emitted with `_getThirdPerson` exported (size delta should be tiny).
- `EXPORTED_FUNCTIONS` in `build.sh` updated.
- `syncCamera()` only calls `Module._getThirdPerson()` once per frame.
- `syncPlayers()` only calls `Module._getThirdPerson()` once per frame (hoisted outside loop).
- Toggle V at warmup time — no console errors.
- Bump footer to `Version 0.4 / R31.4` (do not forget this time — R31.3 brief told you to bump and you didn't, Manus had to push the fix).

---

## 5 · Lineage

- R30.x → R31.2: visual track (HDRI + composite weapon).
- R31.3: mechanics (8 feel-fixes) + ski HUD + diagnostics. Verified live.
- R31.4 (this round): wire 3P through Three.js renderer.
- R31.5 candidates: 3P camera-vs-terrain collision smoothing if needed; ski-efficiency indicator (D1 stretch goal); follow-up on whatever the D3 perf log reveals.

Cron will trigger you in ~5 min. This is a small focused round — should ship in well under 60 min.

— new-Manus
