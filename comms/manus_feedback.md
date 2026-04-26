# Manus Feedback — R31.7 (3rd-Person Camera Polish + Aim Convergence)

**Round:** 31.7
**Date:** 2026-04-26
**Posture:** Hybrid round. Manus shipped JS-only changes directly (committed on `master` this round). Claude takes the C++ aim-convergence half.

---

## Why R31.7 exists

User playtest of R31.4–R31.6 with the new V-key 3rd-person view exposed two related problems:

1. **Tribes Ascend / T1 3P "feels easier to shoot than ours."** User intuition: "there's something about that crosshair." Diagnosis: real Tribes uses **camera-relative aim convergence** — projectiles spawn at the gun barrel but are *aimed at the world point under the dead-center crosshair*, not along the player's body-forward vector. With our R31.5 +0.7 m right-shoulder camera offset, body-forward and crosshair-forward diverge, so shots land 1–2 m off where the crosshair points (worse at range).
2. **Camera framing is too "doll-viewer."** User: "player is too far away, placement is wrong too." Reference video (Tribes Ascend, `youtu.be/9WMjcsP22EM`) shows: centered chase (no shoulder offset), camera follows aim pitch, smooth toggle lerp, no clipping into terrain when player skids backward into a slope.

Splits cleanly along Manus/Claude lines because the camera-positioning + raycast work is JS-only, but the actual projectile direction is computed in C++ `fireWeapon()`.

---

## What Manus already shipped this round (committed, no Claude action)

All in `renderer.js`, `index.html`. WASM binary unchanged → ships as soon as the branch deploys.

### M1. Removed +0.7 m right-shoulder offset
Tribes Ascend reference is centered chase. R31.5's shoulder offset was the single biggest contributor to "shots feel slightly off in 3P." Camera now sits dead-behind-and-above the player. (`renderer.js` syncCamera, ~line 1372–1402.)

### M2. Smooth 1P↔3P transition
R31.4–R31.6 snapped instantly on V-press. Replaced with a frame-rate-independent exponential lerp (~200 ms time constant) on both camera distance and height. Toggle is now filmic.

### M3. Terrain collision
When the camera-back position would clip below terrain (skiing down a steep hill backwards into a slope), camera sweeps along the back-vector at progressively shorter distances until it finds clearance ≥0.6 m. Falls back to "near head" if even d=0 is buried.

### M4. World aim point exposed via `window._tribesAimPoint3P`
Each frame in 3P, `syncCamera()` ray-marches camera-forward × 1000 m against the terrain heightfield (32 coarse steps + 4-step binary refine) and stores the hit point at `window._tribesAimPoint3P = {x, y, z}`. **This is the data Claude needs** for the C++ aim-convergence fix below.

### M5. Footer bump
`Version 0.4 / R31.6` → `Version 0.4 / R31.7`. (Mechanical.)

### M6. Weapon viewmodel fade
`weaponHand.visible` now keys off the smoothed camera distance (`< 0.5 m` ⇒ visible) instead of the raw 3P flag. Fades naturally with the camera lerp; no more pop on V-toggle.

---

## What Claude needs to ship for R31.7 to fully feel right (C++/WASM)

### C1. (P0) Aim convergence in 3rd person
**Problem:** `fireWeapon()` in `wasm_main.cpp` (~line 1014) computes projectile direction from `p.yaw, p.pitch`. In 1P this is fine (camera = player eye = aim ray). In 3P the camera is ~4 m behind and above the player, so body-forward and crosshair-forward point at different rays. Shots miss where the crosshair points.

**Fix:** When `thirdPerson` is true and JS has provided an aim point, override `fwd` to point from `firePos` to the aim point.

```cpp
// Around line 1014 in wasm_main.cpp, inside fireWeapon():
Vec3 fwd = {sinf(p.yaw)*cosf(p.pitch), sinf(p.pitch), -cosf(p.yaw)*cosf(p.pitch)};
Vec3 firePos = p.pos + Vec3(0, 2, 0) + fwd * 2;

// NEW: aim convergence in 3P (R31.7)
if (thirdPerson && pi == localPlayerIdx && hasAimPoint3P) {
    Vec3 toAim = aimPoint3P - firePos;
    float l = toAim.len();
    if (l > 1.0f) fwd = toAim * (1.0f / l);
}
// proceed: spawn projectile with `vel = fwd * muzzleVel + p.vel * inheritScale`
```

Add module-scope state:
```cpp
static Vec3 aimPoint3P = {0,0,0};
static bool hasAimPoint3P = false;
```

Add an exported setter for JS to call each frame:
```cpp
EMSCRIPTEN_KEEPALIVE
void setLocalAimPoint3P(float x, float y, float z) {
    aimPoint3P = {x, y, z};
    hasAimPoint3P = true;
}
```

Once the setter exists, Manus will (in R31.8) add a one-line JS call inside `syncCamera`:
```js
if (Module._setLocalAimPoint3P && window._tribesAimPoint3P) {
    const p = window._tribesAimPoint3P;
    Module._setLocalAimPoint3P(p.x, p.y, p.z);
}
```
**Manus has not added this JS call yet** because it would no-op (and warn) without the C++ side. Holds for R31.8 once Claude ships.

### C2. (P1) Player torso pitches with camera in 3P
Local-player mesh stays upright while the camera/crosshair pitch up and down. Tribes Ascend tilts the upper torso to match aim pitch so the player visibly "looks where they're aiming." This is JS-only (renderer.js soldier rig) — Manus can ship in R31.8. Listed here so Claude doesn't surprise-ship and create a merge.

### C3. (P2) Verify perf-log budget
R31.3's per-second perf log should still report dt within budget after Manus's per-frame ray-march (32+4 steps). Ray-march only runs in 3P; expected impact is negligible. If perf-log shows a regression, tell Manus and we'll cap to 16 steps.

---

## Acceptance criteria for R31.7

When fully shipped (Manus + Claude halves):

1. ✅ (Manus M2) Press V — camera lerps smoothly to ~4 m back, ~1.6 m up, no shoulder offset.
2. ✅ (Manus M3) In 3P, ski into a steep hill backwards — camera does not clip into terrain.
3. ⏳ (Claude C1) Fire disc in 3P at a stationary bot — projectile lands within 0.5 m of crosshair regardless of distance.
4. ⏳ (Claude C2 / Manus R31.8) Mouse-look up/down in 3P — local player's upper torso visibly pitches with the camera.
5. ✅ (Manus M4) `window._tribesAimPoint3P` populated each frame in 3P (verify in console).
6. ✅ (Manus M5) Footer reads `Version 0.4 / R31.7`.

---

## Process going forward

Per user mandate:
- Manus autonomously ships JS/HTML/comms work as `feat(R*-manus): …` commits.
- Claude continues to own all C++/WASM work.
- This brief always exists, even when Manus does most of the round, so the loop (Manus → manus_feedback.md → Claude → claude_status.md → Manus) stays intact.
- Manus does NOT wait for Claude approval on JS-only changes, and Claude does NOT need to re-do anything Manus already shipped.

---

## Reference videos analyzed (for design context)

- `DQkmXGQfNt8` *How Tribes is Played* Pt 1 — base-interior corridors, stations, mortar arc, turret damage scaling
- `NOxGRipenxA` *How Tribes is Played* Pt 2 — command map, waypoints, generator powers turrets/stations/forcefields
- `52MCQAD1seA` *How Tribes is Played* Pt 3 — vehicle pads, deployable turrets/sensors/cameras, sensor jammer pack
- `9WMjcsP22EM` Tribes Ascend 3P — centered chase camera reference (drives M1)
- `QN1eCU1aN4o` (analyzed earlier) — momentum, projectile inheritance, ski-jet rhythm

Full transcripts at `/home/ubuntu/tribes_evidence/videos/*.txt` (will be uploaded to comms/ as needed).

Several wishlist items from these videos (deployable turrets, sensor jammer pack, command-map waypoints, base interior corridors, vehicle pads, generator-disables-base) are intentionally NOT in this brief — each is a full round of work. They go in `comms/wishlist_post_R31.md` (Manus to create separately).

— Manus
