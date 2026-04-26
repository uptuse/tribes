# R31.7.1 — 3P regression hot-fix (Manus shipped, small Claude alignment ask)

**Round:** 31.7.1 (hot-fix)
**Date:** 2026-04-27
**Posture:** Manus-led. R31.7 was visibly broken in user playtest video; Manus hot-fixed JS-side same round. Claude already shipped the R31.7 C1 C++ aim-convergence half (commit `32b4b41`) — that work is **kept**, only one missing JS hookup is added in R31.7.1.

---

## Why R31.7.1 exists

User shipped a screen recording right after R31.7 deployed. Three regressions visible:

1. **At ~0:16 the camera snaps to the back of the player's head and stays clipped.** From there, the head and shoulders obstruct the crosshair for the rest of the clip.
2. **Projectile emerges bottom-right at ~0:13**, off-axis from both the crosshair and the weapon model — i.e. Claude's C1 aim-convergence (which is correctly implemented C++-side) was never *triggered*, because the JS side was missing the per-frame call to `Module._setLocalAimPoint3P()`.
3. **Weapon viewmodel disappears at the toggle moment** instead of fading naturally with distance.

Plus one cosmetic: footer still read `Version 0.4 / R31.6` because Claude bumped the C++ in `32b4b41` but didn't touch `index.html`.

---

## What Manus shipped this round (renderer.js + index.html, no WASM rebuild needed)

### M1. Hard min camera distance 3.0 m, lift instead of pull-in
R31.7's terrain-collision loop swept the back-distance progressively shorter until clearance was found, which on most slopes collapsed `camDist` to ~0 m and slammed the camera into the player's head. Replaced with a **lift-y** strategy: keep the back-distance fixed at the lerp target (4 m), and only raise camera Y to clear the slope. Net effect: camera always sits a clean 4 m behind, never inside the player.

### M2. Wired the missing C1 hookup
Each frame in 3P, `syncCamera()` now calls:
```js
if (is3P && Module._setLocalAimPoint3P && window._tribesAimPoint3P) {
    const p = window._tribesAimPoint3P;
    Module._setLocalAimPoint3P(p.x, p.y, p.z);
}
```
This feeds the world aim-point (computed by the existing 32+4-step terrain ray-march) into Claude's `setLocalAimPoint3P` C++ setter, so `fireWeapon`'s `if(thirdPerson && pi==localPlayer && hasAimPoint3P)` branch finally fires and overrides `fwd` to point at the crosshair.

### M3. Viewmodel fade threshold 0.5 → 0.3
0.5 m was hiding the weapon abruptly during the lerp. 0.3 m matches the perceived "I'm still basically in 1P" zone.

### M4. Lerp settle + clean blend zone
- Snap to target when `|delta| < 0.05 m` to kill long-tail drift.
- Mid-toggle blend [0.05–2.0 m] uses a linear ease between 1P head and 3P chase position so the player mesh isn't clipped during the transition.

### M5. Footer R31.6 → R31.7.1
`index.html` line 862.

---

## What I'd like Claude to do (one verification + one P1 feature)

### C1-verify (P0, takes 10 seconds)
Confirm `RenderPlayer.pitch` is populated for the local player even when `thirdPerson==true`. Renderer.js reads `playerView[o + 3]` in `syncCamera` and uses it for the camera, but I need to know whether you ALSO export the local player's pitch into the soldier-render struct that drives the bot/local mesh in 3P. If yes, R31.8 torso pitch is purely a renderer.js bone-rotation task and Manus owns it. If no, please add the export.

### C2 (P1, can wait one round)
**Player torso pitch in 3P.** Local player's upper-body bone should rotate with `pitch` so the firing animation visibly tracks where the player is aiming. Current behavior: body stays horizontal regardless of look angle, looks weird in mid-air disc duels viewed from behind. If C1-verify above shows pitch is exported, Manus picks this up in R31.8 (renderer.js bone rotation, ~10 lines). If not, add the export and I'll do the rotation.

### C3 (P2)
**Perf budget verify.** R31.7.1 adds (a) one terrain ray-march per frame in JS (was already there in R31.7) and (b) one `_setLocalAimPoint3P` WASM boundary call per frame in 3P. Confirm the 32 ms physics tick + frame budget isn't blown — your perf log already prints this; just confirm no regression after the merge.

---

## Acceptance criteria for R31.7.1

1. ✅ V toggle: camera lerps to 4 m back, no head-clip, footer reads R31.7.1.
2. ✅ Terrain pull-in: when behind position would clip a slope, camera **lifts** y instead of collapsing distance.
3. ✅ Aim convergence: spinfusor disc in 3P lands within 1 m of the crosshair point at 50 m range (now that the JS hookup is wired).
4. ✅ Weapon viewmodel: visible only in true 1P (camDist < 0.3 m); cleanly hidden in 3P.
5. ⏳ (Claude C1-verify) Confirm whether `RenderPlayer.pitch` exports for local player in 3P.
6. ⏳ (Claude C2 or Manus R31.8) Player torso bone pitches with camera in 3P.
7. ⏳ (Claude C3) Perf budget unchanged within ±5%.

---

## Process

- Manus continues to ship JS/HTML/comms hot-fixes without pre-approval.
- Claude continues to own C++/WASM. C1 was a clean ship (32b4b41) — only the JS-side hookup was missing, which is now in.
- Brief always exists even on Manus-led rounds.

---

## Reference

- User playtest video (Untitledvideo(4).mp4) — analyzed via `manus-analyze-video`. Key findings: head-clip from 0:16 onward, projectile bottom-right at 0:13, weapon disappears at toggle, no smooth lerp visible.
- Tribes Ascend 3P reference (`youtu.be/9WMjcsP22EM`) — centered chase, dead-center crosshair, no shoulder offset.

— Manus
