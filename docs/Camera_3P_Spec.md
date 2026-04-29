# Tribes-Style Third-Person Camera Specification

**Author:** Manus AI
**Date:** 2026-04-29
**Status:** Draft — authorizes Claude to replace the current rigid chase-cam in `renderer_camera.js` with an orbital, speed-aware, collision-safe third-person camera.

## 1. Purpose and North Star

Firewolf's current third-person view (see `firewolf_current_1_skiing.png` and `firewolf_current_3_jet_airborne.png` in `docs/camera_references/`) is a rigid chase-cam: the camera sits at a fixed offset directly behind the player, translating in world-space as the player moves. Mouse-look pans the view but does not reposition the camera around the player, and the framing centers the model in the middle of the screen with no sense of lag, speed, or situational awareness.

The north star for Firewolf's camera is Tribes 1 (1998) and Tribes 2 (2001) — specifically the third-person mode many players used during skiing, flag-carrying, and duels. That camera is characterized by four qualities that the current implementation lacks: the camera **orbits** the player (it is not a decal attached behind them), it **lags slightly** under acceleration, it **zooms out** as speed increases, and it **avoids clipping** into terrain. Reference frames for all four qualities are included in `docs/camera_references/`. Asheron's Call (`tribes_ref_6_asherons_call_dungeon.webp`) is included as a secondary reference for the same era's over-the-shoulder framing conventions.

## 2. Static Framing

When the player is stationary and the mouse is idle, the camera sits roughly **3–4 meters behind** the player's root and roughly **1.5 meters above** the ground plane the player is standing on, pitched down by ~8° so the reticle rests near the horizon. The player model should occupy the lower third of the frame, offset slightly left-of-center (roughly 35–40% from the left edge) so the reticle and a clear sight line to the right of the model are preserved. The weapon should be held at the hip or slung at the side as in `tribes_ref_3_T2_rifle_standing.png` and `tribes_ref_5_T2_flag_carry.png`, not raised into an aim pose — raised-weapon framing belongs to first-person mode only.

| Parameter | Default | Notes |
|---|---|---|
| Follow distance (idle) | 3.5 m | `window._tribesCamDist` |
| Camera height above feet | 1.5 m | `window._tribesCamHeight` |
| Horizontal offset from player center | +0.35 m to the right | Shoulder offset, not rotation |
| Resting pitch | −8° | Relative to horizon |
| Model screen anchor | ~38% from left, ~65% from top | Tunable; target "Tribes 2 look" |

## 3. Orbital Rotation — the Behavior That Cannot Be Screenshotted

This is the single most important piece of the spec and the behavior that distinguishes a Tribes camera from the current chase-cam. **Mouse input must rotate the camera around the player, not pan the player's view cone.**

Concretely, the camera's position is expressed in spherical coordinates centered on the player's chest: a yaw angle, a pitch angle, and a follow distance. Horizontal mouse motion (delta-X) adds to the yaw; vertical mouse motion (delta-Y) adds to the pitch; the follow distance is driven by speed (see §4) and collision (see §5). Every frame, the camera's world position is recomputed as `player + spherical(yaw, pitch, distance)`, and the camera's look-at target is the player's chest plus a small forward bias of roughly 2 meters in the aim direction so the reticle lands where the player is facing rather than on the back of their head.

When the player moves horizontally with the mouse, the camera physically sweeps through an arc — at the extreme, a full 180° sweep should place the camera in front of the player facing back at them, with the model filling the lower-center of the frame and the environment visible beyond. The player's **body** yaws to align with the aim direction over roughly 150 ms of smoothing, so the model is never seen facing perpendicular to the camera for more than a fraction of a second during a hard mouse turn; this is the "torso follows look" behavior visible in Tribes 2 flag-carrier footage. The feet and locomotion animation continue to orient with the velocity vector, which produces the characteristic strafe-run silhouette where the upper body is twisted relative to the legs.

Vertical mouse motion pitches the camera up and down **around** the player rather than tilting in place. Looking up lowers the camera and angles it upward so the player's silhouette is framed against the sky; looking down raises the camera and angles it downward so the player's feet and the terrain immediately below are visible. Pitch should clamp at approximately +80° and −80° to prevent the camera from crossing through the player's head or the ground plane.

## 4. Speed-Based Dynamics

Two dynamic qualities give Tribes its distinctive sense of speed and must be reproduced. The first is **spring-damped follow**: the camera does not lock rigidly to the player's position but trails on a critically-damped spring with a natural frequency of roughly 6 Hz and a damping ratio near 1.0. When the player accelerates from a standstill into a ski or fires the jetpack (compare `firewolf_current_1_skiing.png` and `tribes_ref_4_T2_skiing_snow.png`), the player model should be seen to pull ahead of the camera by up to half a meter before the camera catches up, and when the player brakes or collides with terrain, the camera should overshoot forward past the ideal distance by a comparable amount before settling. This spring also smooths the vertical component, which is essential on Raindance's rolling hills — without damping, the camera visibly pops every time the player crests a rise.

The second dynamic quality is a **speed-proportional zoom-out**. The follow distance should scale linearly with the player's horizontal speed from the 3.5 m idle baseline up to a cap near 6.0 m at top skiing speed, with a smoothing time constant of roughly 500 ms so the zoom is felt as a gradual pull-back rather than a twitchy jitter. This mirrors Tribes 2's behavior and serves a gameplay purpose: at high speed, peripheral awareness and terrain prediction matter more than a tight read on the character model.

| Quality | Parameter | Value |
|---|---|---|
| Spring frequency | ω_n | ~6 Hz |
| Damping ratio | ζ | ~1.0 (critical) |
| Zoom distance at 0 m/s | d_min | 3.5 m |
| Zoom distance at top speed | d_max | 6.0 m |
| Zoom smoothing time constant | τ | ~500 ms |
| Body yaw smoothing time | — | ~150 ms |

## 5. Collision Avoidance

The camera must never clip through terrain, buildings, or other solid geometry. On every frame, after computing the ideal camera position in spherical coordinates, cast a ray (or a short-swept sphere of radius ~0.3 m to smooth over small bumps) from the player's chest outward to the ideal camera position. If the ray hits geometry before reaching the ideal distance, place the camera at the hit point minus a small offset (roughly 0.2 m) along the ray, preserving the yaw and pitch. The visual effect is that the camera "pushes in" toward the player when the player skis under a bridge, runs along a cliff face, or backs into a base wall, and smoothly pulls back out when the occluder clears.

The collision cast should use the same Rapier static-geometry layer the player capsule uses, and it should be explicitly excluded from colliding with the player's own capsule and vehicle hull. When multiple rays fail (i.e., the camera cannot find any clear position behind the player), the fallback is to place the camera at the minimum safe distance (~1.2 m) and continue the rotation; this case is rare but happens inside small rooms and must not cause the camera to teleport or flicker.

## 6. First-Person / Third-Person Integration

The existing V-key toggle between first-person and third-person (visible in `firewolf_current_2_first_person.png` and `firewolf_current_4_first_person_editor.png`) should be preserved. The transition from 1P to 3P should interpolate the camera position from the head bone to the orbital position over ~200 ms, and the reverse should be symmetric. During the transition the crosshair, HUD, and weapon raise state should not visibly glitch — if a weapon animation is mid-firing, the 3P transition should not restart it.

Importantly, the 3P orbital logic must not leak into 1P. In first-person, mouse-look rotates the head/aim vector directly, as it does today; the orbital code path is only active when `View === ThirdPerson`.

## 7. Implementation Hooks

The relevant module is `renderer_camera.js`. The globals `window._tribesCamDist` and `window._tribesCamHeight` are already exposed for tuning and should be retained; new globals `window._tribesCamYawLag`, `window._tribesCamZoomCap`, and `window._tribesCamCollisionPad` should be added and wired into the editor tuning panel so the Director can A/B tune them live during development. Yaw and pitch state should be stored in module-scope variables and updated from the same pointer-lock delta stream that currently drives first-person aim, so that switching between 1P and 3P feels continuous.

The spring step should be integrated at the render rate using a stable semi-implicit Euler step (`v += (-ω² * (pos - target) - 2ζω * v) * dt; pos += v * dt`) rather than a naïve lerp, because the render loop runs at variable dt during WASM reloads and lerp-based smoothing visibly shudders on frame spikes.

## 8. Reference Images

All referenced images are stored under `docs/camera_references/` and committed with this spec:

| File | Era | Purpose |
|---|---|---|
| `tribes_ref_1_melee_interior.png` | Tribes 1 | Indoor 3P framing, weapon-at-side posture |
| `tribes_ref_2_ss_tribes_running.png` | Tribes 1 | Running silhouette, model lower-left of frame |
| `tribes_ref_3_T2_rifle_standing.png` | Tribes 2 | Canonical static 3P framing with rifle |
| `tribes_ref_4_T2_skiing_snow.png` | Tribes 2 | Skiing at speed, zoomed-out camera |
| `tribes_ref_5_T2_flag_carry.png` | Tribes 2 | Flag carrier with torso-follows-look twist |
| `tribes_ref_6_asherons_call_dungeon.webp` | Asheron's Call (2001) | Same-era third-person framing reference |
| `firewolf_current_1_skiing.png` | Firewolf (current) | Current 3P skiing — for comparison |
| `firewolf_current_2_first_person.png` | Firewolf (current) | Current 1P — reference for 1P→3P transition |
| `firewolf_current_3_jet_airborne.png` | Firewolf (current) | Current 3P jetting — note no zoom-out |
| `firewolf_current_4_first_person_editor.png` | Firewolf (current) | Current 1P with editor panel open |

## 9. Acceptance Criteria

The new camera is considered complete when all of the following are simultaneously true during a skiing run across Raindance with a full mouse-look pass: the camera orbits smoothly through 360° of yaw without clipping; the player model stays roughly in the lower-left third of the frame; the follow distance visibly stretches from ~3.5 m to ~6 m between standstill and peak ski speed; the camera pushes in and back out when the player passes under the crystal tower's lower arches; and the 1P↔3P toggle completes without a visible snap. The existing editor Shift+Enter tuning panel should expose distance, height, spring stiffness, zoom cap, and collision padding as live sliders so the Director can dial in the final feel without a rebuild.
