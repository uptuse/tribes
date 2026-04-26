# Open Issues — shared backlog

> Both Claude and Manus may edit this file. Mark completed items `[x]`. New items get appended at the bottom of their priority section. Tag with `[spec-change-request]` if you want Manus to amend `visual_spec.md`.

## Priority 1 — Real terrain

- [x] Load `raindance_heightmap.h` (257×257) into the WASM build, replacing procedural noise. World scale: 8 m per terrain square, ~2 km square map. *(Round 2: heightmap tiling artifact needs fix — see Issue 2.2 in manus_feedback.md)*
- [ ] Hide procedural noise terrain behind a debug flag.
- [ ] Apply original Raindance terrain textures from `/Users/jkoshy/Darkstar/assets/tribes/` (BMP→PNG at build time). *(Round 2: now in scope to finish Priority 1)*
- [x] Linear fog: start 600 m, end 1500 m, color `#B8C4C8`.
- [x] Sky vertical gradient `#7A8A9A` (horizon) → `#5A6A7A` (zenith) + a few hazy cloud sprites. *(sprites still missing, gradient correct)*
- [x] Place real flag stands and base anchor positions from `raindance_mission.h`.
- [x] **Issue 2.1:** Red artifact fixed — base platforms and tower tint neutralized to grey per spec palette.
- [ ] **Issue 2.2:** Re-extract Raindance heightmap — current decoder produces 4× column repetition. Use Darkstar `terrData.cc` as reference.

## Priority 2 — Tribes 1 UI shell

- [x] Remove Orbitron and Rajdhani font imports from `index.html`.
- [x] Add Cinzel + Barlow Condensed (or self-hosted equivalents).
- [x] Strip blue gradients, blue glows, and `border-radius` > 2px from `index.html`.
- [x] Rebuild main menu to match `comms/references/ref_main_menu_v130.png` (gold wordmark + 2×2 plain text grid).
- [x] Rebuild Game Setup, Team Select, Loadout panels in brass-bordered near-black dialog style.

## Priority 3 — DTS skeletal hierarchy

- [x] Parse `nodes[]` and `transforms[]` chunks; build parent/child tree.
- [x] Apply accumulated world transform per mesh on render.
- [ ] Add `?debug=model_viewer` URL flag to inspect single armors.
- [ ] Verify L/M/H armor and tower silhouettes are humanoid / tower-shaped. *(Pushed, awaiting Manus visual review)*

## Priority 4 — Model textures

- [ ] Read DTS material list and bind textures from `/Users/jkoshy/Darkstar/assets/tribes/`.
- [ ] BMP→PNG build step.
- [ ] Per-team tinting only on regions the original tinted.

## Priority 5 — Distinct projectile visuals

- [x] Spinfusor: white spinning disc + cyan trail.
- [x] Chaingun: yellow tracer dot, no trail.
- [x] Plasma: red-orange globule with color jitter.
- [x] Grenade launcher: bouncing dark olive ball, red blink before detonation.
- [ ] Chaingun muzzle flash at firing player — deferred.
- [ ] Plasma crackling halo (additive blend pass) — deferred.
- [ ] Mortar, ELF, laser, blaster, hand grenade — placeholder OK until their turn.

## Priority 6 — Base Infrastructure (Tier 2.7)

- [x] Turret auto-aim AI: scan 80m, smooth aim 120°/s, plasma fire 1.5s cooldown, 200HP, dark when destroyed
- [x] Generator destructible: 800HP, cascade (turrets+stations offline), sparks, repair 5HP/s
- [x] Inventory station UI: F key, 3-column (armor/weapon/pack), offline state, apply loadout
- [ ] Bot AI: bots should prioritize shooting generators/turrets when defending

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
