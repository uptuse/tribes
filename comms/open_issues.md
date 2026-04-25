# Open Issues — shared backlog

> Both Claude and Manus may edit this file. Mark completed items `[x]`. New items get appended at the bottom of their priority section. Tag with `[spec-change-request]` if you want Manus to amend `visual_spec.md`.

## Priority 1 — Real terrain

- [x] Load `raindance_heightmap.h` (257×257) into the WASM build, replacing procedural noise. World scale: 8 m per terrain square, ~2 km square map. *(Round 2: heightmap tiling artifact needs fix — see Issue 2.2 in manus_feedback.md)*
- [ ] Hide procedural noise terrain behind a debug flag.
- [ ] Apply original Raindance terrain textures from `/Users/jkoshy/Darkstar/assets/tribes/` (BMP→PNG at build time). *(Round 2: now in scope to finish Priority 1)*
- [x] Linear fog: start 600 m, end 1500 m, color `#B8C4C8`.
- [x] Sky vertical gradient `#7A8A9A` (horizon) → `#5A6A7A` (zenith) + a few hazy cloud sprites. *(sprites still missing, gradient correct)*
- [x] Place real flag stands and base anchor positions from `raindance_mission.h`.
- [ ] **Issue 2.1:** Investigate and remove the red/coral polygonal artifact floating mid-screen on the right (see review_1e5c10f_terrain.webp).
- [ ] **Issue 2.2:** Re-extract Raindance heightmap — current decoder produces 4× column repetition. Use Darkstar `terrData.cc` as reference.

## Priority 2 — Tribes 1 UI shell

- [ ] Remove Orbitron and Rajdhani font imports from `index.html`.
- [ ] Add Cinzel + Barlow Condensed (or self-hosted equivalents).
- [ ] Strip blue gradients, blue glows, and `border-radius` > 2px from `index.html`.
- [ ] Rebuild main menu to match `comms/references/ref_main_menu_v130.png` (gold wordmark + 2×2 plain text grid).
- [ ] Rebuild Game Setup, Team Select, Loadout panels in brass-bordered near-black dialog style.

## Priority 3 — DTS skeletal hierarchy

- [ ] Parse `nodes[]` and `transforms[]` chunks; build parent/child tree.
- [ ] Apply accumulated world transform per mesh on render.
- [ ] Add `?debug=model_viewer` URL flag to inspect single armors.
- [ ] Verify L/M/H armor and tower silhouettes are humanoid / tower-shaped.

## Priority 4 — Model textures

- [ ] Read DTS material list and bind textures from `/Users/jkoshy/Darkstar/assets/tribes/`.
- [ ] BMP→PNG build step.
- [ ] Per-team tinting only on regions the original tinted.

## Priority 5 — Distinct projectile visuals

- [ ] Spinfusor: white spinning disc + cyan trail.
- [ ] Chaingun: yellow tracers, no trail, muzzle flash.
- [ ] Plasma: red-orange globule with crackling halo.
- [ ] Grenade launcher: bouncing dark ball with red blink before detonation.
- [ ] Mortar, ELF, laser, blaster, hand grenade — placeholder OK until their turn.

## Backlog (no priority yet)

- [ ] Wire kill feed and flag status notifications from WASM events to the existing HTML overlays.
- [ ] Populate scoreboard data from WASM on Tab key.
- [ ] Death camera (orbit corpse for ~3s, then respawn screen).
- [ ] Wire victory screen on score-limit reached.
- [ ] Inventory station functional UI (loadout change at base).
- [ ] Deployables: turrets, sensor pulse beacons, mines.
- [ ] Vehicles: Wildcat (light grav cycle), Beowulf (assault tank), HAVOC (transport), Thundersword (bomber). Defer until armor + base look correct.
- [ ] Command map (`C` key) with sensor coverage overlay.
- [ ] Sound: load `.ogg` set, jetpack loop, footsteps, weapon fires, explosions, voice lines.
- [ ] Bot AI improvements: skiing, role assignment (capper / defender / heavy on flag), basic team coordination.
- [ ] Multiplayer assessment (out of scope for v1, but capture requirements once visual fidelity lands).

## Resolved

(none yet)
