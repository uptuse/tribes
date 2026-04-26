# R31.5 Manus Brief — Tune 3P camera framing (real-Tribes match)

**Author:** new-Manus
**Date:** 2026-04-26
**Round type:** One-line tuning fix (~5 min)
**Lineage:** R31.4 wired 3P through Three.js. User played, attached real-Tribes screenshot vs ours, said: *"player model too far away. placement is wrong too."*

---

## TL;DR

R31.4 works — local player renders in 3P with bot soldier model. Camera offsets are wrong: 12 m back / 3 m up / centered = player is a tiny dot. Real Tribes is much closer, lower, and offset to the side. Tune two functions and we're done.

## The numbers

| Param          | R31.4 value     | R31.5 target | Reason |
|----------------|-----------------|--------------|--------|
| Distance back  | `fwd*12`        | `fwd*4`      | Real Tribes ~3-4 m chase |
| Height up      | `+3.0`          | `+1.6`       | Just above head, not bird's-eye |
| Lateral offset | `0`             | `+0.7 right` | Player left-of-center, right side clear for aim |
| Pitch down     | none            | none for now | Skip until user confirms; could feel weird |

Match the C++ value too so legacy WebGL stays consistent.

## Code changes

### 1 · `program/code/wasm_main.cpp` line ~2264

Find:
```cpp
if(thirdPerson)eye=me.pos+Vec3(0,3,0)-fwd*12;
```

Replace with:
```cpp
if(thirdPerson){
    // R31.5: closer chase, slight lateral offset (over-right-shoulder)
    Vec3 right=Vec3(cosf(me.yaw),0,sinf(me.yaw));    // strafe-right unit vector
    eye=me.pos+Vec3(0,1.6f,0)-fwd*4.0f+right*0.7f;
}
```

(`right` is the player's strafe-right axis, perpendicular to `fwd` on the XZ plane. The sign convention should match how strafe-right works elsewhere in the file — if you find the player's existing strafe-right computation, prefer that for consistency. If `right*0.7f` puts the camera on the wrong side, flip to `-right*0.7f`.)

### 2 · `renderer.js` `syncCamera()` (the R31.4 block)

Find the R31.4-added block (looks like):
```js
if (is3P) {
    const fwdX = Math.sin(yaw);
    const fwdZ = -Math.cos(yaw);
    camera.position.set(px - fwdX * 12, py + 3.0, pz - fwdZ * 12);
} else {
    camera.position.set(px, py + 1.7, pz);
}
```

Replace the 3P branch with:
```js
if (is3P) {
    const fwdX = Math.sin(yaw);
    const fwdZ = -Math.cos(yaw);
    // strafe-right unit on XZ: right = (cos(yaw), 0, sin(yaw))
    const rightX = Math.cos(yaw);
    const rightZ = Math.sin(yaw);
    camera.position.set(
        px - fwdX * 4.0 + rightX * 0.7,
        py + 1.6,
        pz - fwdZ * 4.0 + rightZ * 0.7
    );
} else {
    camera.position.set(px, py + 1.7, pz);
}
```

### 3 · Footer

Bump to `Version 0.4 / R31.5`.

---

## Acceptance (3/3)

1. Press V in-match → camera is ~4 m behind, ~1.6 m up. Player visibly fills ~30-40% of viewport height (not a tiny dot).
2. Player appears slightly left of screen center (so right side of view is clear).
3. Toggle V on/off cleanly, no jitter, no hide/show issues.

## Out of scope (R31.6+ if user asks)

- Camera-vs-terrain collision (chase cam clipping into hills).
- Pitch-aware framing (camera tilts down when player looks down).
- Smooth lerp between 1P↔3P transitions (currently a hard snap).
- Aim reticle parallax correction for 3P.

Cron will trigger you in ~5 min. Should ship in well under 10 min — just three numeric changes.

— new-Manus
