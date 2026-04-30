# Milestone 7 — Locomotion Grounding Plan

**Author:** Manus AI
**Date:** 2026-04-30
**Repository:** `github.com/uptuse/tribes`
**Depends on:** R32.275 (editor shell close-out) being merged first.
**Estimated effort:** ~4 focused engineering days.

---

## Why this milestone exists

The character currently looks like it is sliding across the terrain. The feet swing through their cycle at a fixed playback rate while the body translates at whatever speed the controller dictates, so the two are visually decoupled. The eye reads this as "the character is on an invisible conveyor belt," not as a body locomoting under its own weight. This is the single most common complaint with first-pass character motion in any 3D action game, and every shipped title solves it with the same handful of techniques layered together.

None of these techniques require redoing the rig, replacing the animation system, or re-authoring clips. They are all add-ons that run on top of the existing animations and the existing physics controller. The work is split across one new client module, two small additions to existing files, a small set of new C++ event hooks, and a handful of EDIT · BINDINGS rows authored at runtime by the operator.

This milestone is also where the bindings architecture you've been designing starts paying off. Every grounding cue (footstep audio, dust puff on footplant, camera kick on landing, ski compression sound) is fired through the `EventBus`, which means once the hooks are in place, *adding more grounding cues is authoring data, not writing code*. That is the intended separation.

---

## The problem in technical terms

The player's *world position* is driven by physics: `position += velocity × dt`. The *animation* plays at a constant rate set by `mixer.timeScale = 1.0`, regardless of velocity. There is no coupling between the two. The fix is to **couple them** at three places: the animation playback rate, the foot contact points, and the camera frame. Then add small lies (camera bob, pelvis sway, dust, audio) that sell weight at the contact points the eye is already inspecting.

After this milestone the animation will be a function of velocity, the feet will follow the terrain, the camera will breathe with footstrike, and skiing will read as an athletic intentional slide rather than an accidental skate.

---

## Layered fixes, in order of effort vs. payoff

### Layer 1 — Speed-matched stride with walk/run blend

This is the single biggest win and lands first. Today `mixer.timeScale = 1.0` runs every clip at its authored rate. Replace this with a velocity-driven schedule.

For each locomotion clip (`walk_fwd`, `run_fwd`, `walk_strafe_l`, `walk_strafe_r`, `walk_back`, `run_back`, plus their strafing pairs), measure the *natural ground speed* of the clip — the horizontal distance the root bone advances over one full cycle, divided by the cycle's duration. Store this as `clip.userData.naturalSpeed` (meters per second). The values will typically land in the range 1.8–2.4 m/s for walks and 5.5–7.0 m/s for runs.

At runtime, in a new `client/locomotion.js` module, take the player's horizontal velocity, decompose it into forward/backward and strafing components in the player's local frame, and choose the matching clip pair (e.g. forward walk + forward run). Crossfade between them based on speed: pure walk below ~3.0 m/s, pure run above ~5.5 m/s, linear blend in between. Within each clip, set `action.timeScale = currentSpeed / clip.userData.naturalSpeed`, clamped to `[0.4, 1.6]` so extreme values never look silly.

For pure strafing or backward motion, do the same with the appropriate clip pair. For diagonal motion, blend the forward and strafe clips additively (each at half weight), which is approximate but reads correctly on screen.

The acceptance test for this layer is straightforward: walk slowly forward and watch the legs swing slowly; sprint forward and watch them fly; the boots should appear to plant on the ground roughly once per stride at all speeds, never sliding.

This layer alone resolves an estimated 70% of the perceived sliding.

### Layer 2 — Camera bob and footstrike kick

Surprisingly high return for a few hours of work. In `renderer.js`, after the camera transform is computed each frame, add a small offset driven by a sine wave whose phase tracks the active locomotion clip's `time`. The amplitude scales with current speed: roughly 0.6 cm at walk, 1.5 cm at run for first-person; double those values for third-person.

On each footstrike (left and right), apply a one-frame additional camera nudge: ~1° of pitch downward, returning to neutral over ~80 ms; ~0.4° of roll on the off-foot direction. Use a small spring or critically-damped easing so it never feels like a twitch. On hard landings (vertical impact velocity above ~6 m/s), apply a larger kick: ~3° pitch down, ~0.06 m down, returning over ~250 ms.

The camera doing this work papers over a great deal of imperfect ground contact in the body animation, because the player's vestibular sense fires on the *camera*, not on the character mesh.

### Layer 3 — Footstep bindings (audio + dust)

This layer is bookkeeping but indispensable. Add four new event ids to the bindings system: `player.on_footstep_left`, `player.on_footstep_right`, `player.on_landing_soft`, `player.on_landing_hard`. Fire them from the locomotion module: at the moments the active clip's `time` crosses the authored footstrike markers (left foot down ≈ 0.0 of cycle, right foot down ≈ 0.5 of cycle), fire the corresponding event with payload `{ surface, intensity, position }`.

The `surface` is determined by raycasting straight down from the foot bone and reading the terrain material id at the hit. Default surfaces: `grass`, `rock`, `metal`, `snow`, `water`. The `intensity` is the player's current horizontal speed normalised to [0, 1]. The `position` is the world-space hit point.

In EDIT · BINDINGS, the operator can then author rows like `player.on_footstep_left @ surface=grass → audio:footstep_grass_l + vfx:dust_puff_small`, exactly as the bindings system was designed for.

Acceptance: walk on grass, hear a grass footstep on each foot; walk on snow, hear snow; jump down 5 metres, hear and see a dust burst on the landing.

### Layer 4 — Foot IK to terrain

This is the layer that most clearly elevates the look on uneven ground. Without it, on a slope the feet either clip into the hill or float above it, depending on the slope direction. With it, the feet stay planted.

In a new `client/foot_ik.js`, after the animation mixer updates each frame but before the world matrix is composed, do the following per foot:

1. Read the foot bone's current world position from the animation.
2. Raycast a short distance downward from the bone (start ~30 cm above, end ~30 cm below).
3. If the ray hits terrain, compute the desired foot Y as `hit.point.y + footHeightOffset` (a small per-rig constant, ~3 cm).
4. If the desired Y is above the animated Y, lift the foot to the desired Y. If below, leave the animation alone (don't penetrate or stretch the leg downward — that creates worse artifacts).
5. Apply the same Y delta to the corresponding ankle and knee bones, scaled (50% to ankle, 25% to knee), as a poor-man's IK. This avoids the leg looking dislocated. For a stylised game this is sufficient; a full two-bone IK solver is a v1.1 upgrade if needed.
6. Additionally, rotate the foot bone to align with the terrain normal at the hit point, lerped at 30% so it doesn't snap.

Disable foot IK while skiing (ski clips have their own pose that ignores terrain normal) and while airborne.

### Layer 5 — Procedural pelvis bob

A two-hour add. After the locomotion mixer updates, but before foot IK runs, layer a small additive transform onto the pelvis bone:

```
pelvisBone.position.y += sin(cycleTime * 2π) * amplitude
pelvisBone.rotation.y += sin(cycleTime * 2π + π/2) * 0.04   // counter-rotation
```

The amplitude is ~3 cm at walk, ~6 cm at run. The counter-rotation is the subtle hip yaw opposite the upper body — this is what makes the spine look alive. If the existing animations already include pelvis bob, this layer can be a no-op or its amplitude reduced; tune visually.

### Layer 6 — Ski-specific transitions

Tribes is a skiing game. Skiing is *literally a slide*. Which means the look you noticed is partially correct: the character should slide while skiing. The grounding work for skiing is therefore not about removing the slide, but about (a) making the *transitions* in and out of skiing feel like a body, and (b) adding the *posture* changes that read as athletic skiing rather than rigid standing.

**Three sub-layers, all small.**

**Transition in (unski → ski):** when the operator presses the ski key, play a 10-frame transition: the legs bend ~25° at the knee, the pelvis drops ~12 cm, the upper body leans forward ~5°. Hold the result. Do not interrupt this with locomotion until it completes.

**Transition out (ski → unski):** the reverse — straighten legs, raise pelvis, return upper body. Same 10 frames. On the final frame, if the foot velocity into ground exceeds a threshold, fire `player.on_landing_hard`.

**Compression and lean during skiing:** while skiing, two procedural layers apply each frame. First, on steep downhill slopes (slope angle above ~15°), interpolate the leg bend additively with slope angle — knees come up another ~10° per 30° of slope, capped. Second, on turning input, roll the upper body 5–15° into the turn direction (lerp at ~5%/frame so it feels weighted, not twitchy).

**Optional snow spray VFX**: while skiing, fire `player.on_ski_compress` continuously at ~10 Hz with the current speed as payload. The operator can bind it to a snow-spray VFX preset whose particle count scales with speed. This sells the ski as physical contact with snow, even though the body itself is sliding.

After this layer, skiing reads as athletic and intentional rather than floaty and accidental, and the transitions feel like a body shifting weight.

---

## File-by-file work order

The table below collects all the new files and the diffs to existing files this milestone introduces. None of the existing visual exemplars (Wordmark, TopBar, HelpOverlay, ShellPanel, design tokens) are touched.

| File | Status | Purpose |
|---|---|---|
| `client/locomotion.js` | NEW | Speed-matched stride scheduler, walk/run blend, footstrike event emitter, ski-state machine. ~250 lines. |
| `client/foot_ik.js` | NEW | Per-foot raycast, position lift, foot-rotation alignment to terrain normal, ankle/knee falloff. ~120 lines. |
| `client/camera_grounding.js` | NEW | Footstrike camera nudge, landing kick, vertical bob; runs as the last camera transform. ~80 lines. |
| `client/renderer.js` | DIFF | After mixer update, call `Locomotion.update(dt, velocity)`; after Locomotion, call `FootIK.update(dt)`; in camera frame, call `CameraGrounding.update(dt)`. ~12 added lines. |
| `client/event_bus.js` | DIFF | Register four new event ids: `player.on_footstep_left`, `player.on_footstep_right`, `player.on_landing_soft`, `player.on_landing_hard`. Add a `player.on_ski_compress` periodic emitter. ~6 added lines. |
| `client/editor_bindings.js` | DIFF | Surface the five new event ids in the binding editor. ~8 added lines. |
| `program/code/wasm_main.cpp` | DIFF | Export `_getPlayerSpeedHorizontal()`, `_getPlayerVerticalImpact()`, `_isSkiing()`, `_getSurfaceMaterialAt(x, y, z)` so JS can drive the locomotion state machine without polling internals. ~30 lines + EXPORTED_FUNCTIONS list. |
| `assets/audio/footsteps/*` | NEW (data) | 4 surfaces × 2 feet × 3 variants = 24 short WAVs. Use any free pack as placeholder; final pass is sound design work. |
| `assets/vfx/dust_puff_small.json` | NEW (data) | VFX preset for the dust on footstep. |
| `assets/vfx/dust_burst.json` | NEW (data) | Larger preset for hard landings. |
| `assets/vfx/snow_spray.json` | NEW (data) | Continuous emitter for ski compression. |
| `data/bindings.json` | DIFF | Author the seven default rows that wire the four footstep/landing/ski events to audio + vfx. The operator can edit these at runtime in EDIT · BINDINGS. |
| `docs/animation_clip_metadata.md` | NEW | Document the `naturalSpeed` and `footstrikeMarkers` fields each clip must carry, and the procedure for measuring them in `animation_editor.html`. |

---

## Acceptance bar before pushing R32.276

The work is complete and may be merged when an operator can perform the following sequence and observe the noted outcome.

1. **Walk slowly forward across grass.** The legs swing slowly; the boots appear to plant once per stride; the camera bobs gently; a grass footstep audio cue fires twice per stride; a small dust puff appears on each footplant.
2. **Sprint forward across the same grass.** The legs fly; the boots still appear to plant; the camera bob doubles in amplitude; the audio rate doubles; the dust puffs continue.
3. **Walk diagonally up a 20° slope.** The feet plant on the slope, not floating above it and not clipping into it. The body's lean does not change (the IK only adjusts the feet, not the spine).
4. **Jump from a 5 m ledge onto rock.** On landing, a hard-landing audio cue fires, a dust burst appears, and the camera kicks ~3° down then settles.
5. **Press ski.** The character drops into the ski crouch over ~10 frames. While skiing on flat ground, the body slides smoothly with no leg cycle; while skiing on a 30° downhill, the legs visibly compress further (knees toward chest); while turning, the upper body rolls into the turn.
6. **Unski while moving fast.** The transition out plays; the final frame fires a hard-landing event because the contact is fast.
7. **In EDIT · BINDINGS, edit the `player.on_footstep_left @ surface=grass` row** to fire a different audio preset. Switch back to Play. The new audio is heard immediately, no rebuild required (this verifies the bindings hot path).
8. **DevTools console is silent** — no warnings, no errors from `[Locomotion]`, `[FootIK]`, `[CameraGrounding]`, or `[EventBus]`.

If all eight pass, commit as **R32.276** and push.

---

## Notes for Claude

- The visual exemplars are still locked. Do not redesign anything in the editor UI; this milestone is entirely under-the-hood plus four new event ids surfaced in `EDIT · BINDINGS`.
- Land each layer in its own commit (`L1 stride`, `L2 camera`, `L3 footsteps`, `L4 IK`, `L5 pelvis`, `L6 ski`) so the operator can review them independently and roll back any layer if it doesn't feel right.
- For Layer 1, if the existing locomotion clips don't have measurable natural speeds (e.g., they're stationary on the spot), measure by hand using `animation_editor.html` and write the values into `clip.userData.naturalSpeed` at clip-load time.
- For Layer 4, prefer the simple position-lift + ankle/knee falloff approach. A full two-bone IK solver is overkill at this stage and a known source of rubber-leg artifacts when tuned wrong.
- For Layer 6 ski transitions, prefer hand-authored 10-frame additive overlays over procedural pose generation. Procedural ski poses look unnatural; recorded transitions read as deliberate.
- Treat `assets/audio/footsteps/*` as placeholder content. The sound-design pass is a separate workstream and not part of this milestone — Claude should commit any reasonably-sourced free WAVs as v1 placeholder.

— Manus AI, 2026-04-30
