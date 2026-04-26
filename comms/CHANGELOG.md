# Changelog
2026-04-25 17:15 | initial | chore(comms): set up Manus collaboration protocol + honest status
2026-04-25 18:50 | 1e5c10f | feat(terrain): replace procedural noise with real Raindance heightmap + Tribes 1 palette/fog/sky
2026-04-25 19:10 | 05df784 | fix(visual): neutralize red artifact — grey base platforms and tower tint per spec palette
2026-04-25 19:30 | d85002d | feat(ui): replace blue sci-fi shell with Tribes 1 gold/brass/military styling
2026-04-25 19:55 | d7c7089 | feat(model): DTS skeletal hierarchy — parse nodes/transforms, apply to mesh vertices
2026-04-25 20:10 | 1adcc91 | fix(model): correct axis mapping — DTS Z-up to WebGL Y-up (gz = dy not -dy)
2026-04-25 20:15 | 7a02049 | chore(comms): add Darkstar terrain source excerpts for Manus heightmap decoder
2026-04-25 20:25 | 600c3a2 | feat(physics): rewrite movement to match original playerUpdate.cpp (jet split, jump normal, skiing traction)
2026-04-25 20:35 | aff6d09 | feat(weapons): disc acceleration 65→80 m/s + splash impulse for disc jumping
2026-04-25 20:45 | 28d988f | chore(comms): comprehensive status handoff for session continuity
2026-04-25 21:15 | pending | chore(repo): move source into tribes repo — program/code/, build.sh, BUILD.md
2026-04-25 21:15 | pending | feat(buildings): AABB collision for 30+ mission buildings — interiors, generators, turrets, stations
2026-04-25 21:18 | ca6ab94 | fix(base): Round 8 polish — turret LoS, gen alive pulse, station auto-close, turret HUD msg
2026-04-25 21:20 | pending | review(manus): round 9 PIVOT — armor quality pass; heightmap accepted as-is; polish verified
2026-04-25 21:25 | pending | review(manus): round 9.5 INTERRUPT — stop Tier 3.0 armor pass, await user-provided custom character models
2026-04-25 21:30 | pending | feat(weapons/visuals): Tier 2.6 — distinct projectile visuals: disc white+cyan trail, chaingun yellow tracer, plasma red-orange jitter, grenade dark+bounce+red blink
2026-04-25 21:30 | pending | fix(hud): hide canvas during menu (no blue HUD behind main menu); energy bar amber not blue
2026-04-25 21:30 | pending | review(manus): round 10 PIVOT — HUD/UI polish (model-free); 8 acceptance criteria for health/energy/ammo/icon/crosshair/killfeed/compass/CTF banner
2026-04-25 21:32 | f3039a2 | feat(armor): Tier 3.0 quality pass — 6/7 acceptance criteria met (accepted as baseline)
2026-04-25 21:33 | pending | review(manus): round 10.5 — accept Tier 3.0 armor (6/7) as baseline; drop .upk asset pivot; re-confirm HUD/UI polish
2026-04-25 22:00 | pending | feat(base): Tier 2.7 complete — turret auto-aim AI (plasma, 80m, 120°/s), destructible generators (cascade offline+sparks+repair), inventory station UI (armor/weapon/pack, F key, offline state)
2026-04-25 22:30 | pending | fix(base): Round 8 polish — turret LoS raycast, generator alive pulse, turret #N HUD message, station auto-close at 6m
2026-04-25 23:00 | pending | feat(armor): Tier 3.0 partial — zone coloring, fixed specular/viewDir, breathing anim, jetpack glow (committed before Round 9.5 interrupt arrived)
2026-04-25 23:30 | pending | feat(hud): Tier 3.9.1 — all 8 HUD criteria: health/energy bars, ammo counter, weapon SVG icons, dynamic crosshair, kill feed with icons, compass strip, CTF carry banner
2026-04-25 21:42 | 5ea0e49 | feat(hud): Tier 3.9.1 — full HUD polish, all 8 criteria (accepted 8/8 code-verified)
2026-04-25 21:43 | pending | review(manus): round 11 — audio system (12 criteria, must hit 9+); fix flag-status menu leak
2026-04-25 21:52 | 6200943 | feat(audio): Round 11 — full audio system + HUD flagstatus fix (accepted 12/12 code-verified)
2026-04-25 21:53 | pending | review(manus): round 12 — Tier 4.0 match flow (11 criteria, must hit 9+)
2026-04-25 22:13 | e0acfb8 | feat(match): Tier 4.0 match flow — all 11 criteria (accepted 11/11 code-verified)
2026-04-25 22:18 | pending | review(manus): round 13 — Tier 4.1 settings menu (10 criteria, must hit 8+); roadmap note: Three.js migration locked R15-16
2026-04-25 22:31 | 832a150 | feat(settings): Tier 4.1 — full settings menu, all 10 criteria (BUILD BROKEN — EM_ASM $16 ref crashes main loop)
2026-04-25 22:38 | pending | review(manus): round 13.1 P0 HOTFIX — split broadcastHUD EM_ASM (>16 args), add shader compile log
2026-04-25 22:42 | 9763953 | fix(hud): Round 13.1 P0 — split broadcastHUD EM_ASM, add shader error logging (accepted; main loop alive again)
2026-04-25 22:55 | pending | review(manus): round 14 — Tier 4.2 bot AI v2 (9 criteria, must hit 7+); A* nav grid, roles, skiing intent, LOS gating
2026-04-25 23:03 | 2277fcc | feat(bots): Tier 4.2 — Bot AI v2, all 9 criteria (accepted 9/9 PROVISIONAL; user confirmed real Chrome renders fine; Manus headless false-alarm was SwiftShader 300es)
2026-04-25 23:11 | pending | review(manus): round 14.5 LIGHT HOTFIX — verify dts model render, fix warmup-ternary (HUD shows 600 not 15), remove dead gameSettings legacy fields; QUICK START quick-start (optional)
2026-04-25 23:11 | 629c5c2 | fix(R14.5): warmup timer + DTS diag + gameSettings cleanup + quick start (accepted 4/4)
2026-04-25 23:25 | pending | review(manus): round 15 — Three.js renderer architecture (OPUS 4.7); additive scaffold behind ?renderer=three flag; WASM exports flat render-state structs; zero-copy HEAPF32 views; r170 + WebGLRenderer + ACESFilmic; placeholder visuals only (R18 will upgrade to real models/PBR/shadows)
2026-04-25 23:38 | pending | feat(R15): Three.js renderer scaffold — additive, opt-in via ?renderer=three; C++ render-state structs (RenderPlayer/Projectile/Particle/Flag/Building) in BSS exported as Float32Array views into HEAPF32; populateRenderState() each tick; render-mode guard wraps legacy WebGL path; renderer.js (470 lines) with sky shader, sun+hemi+PCF shadows, heightmap-displaced terrain, building boxes, capsule players, sphere projectiles, THREE.Points particles, first-person camera; locked memory (64MB no growth) so HEAPF32.buffer never detaches
2026-04-25 23:39 | 9b95035 | feat(R15 OPUS): Three.js renderer architecture additive scaffold — 10/10 accepted (renderer.js 470L, 28 WASM exports, importmap r170, ACESFilmic, PCF shadows, fully behind ?renderer=three flag, zero legacy regression)
2026-04-25 23:50 | pending | review(manus): round 16 — Network architecture (OPUS 4.7); decision memo + snapshot/delta protocol + lobby/matchmaking + prediction + lag-comp + anti-cheat baseline + minimal server/client scaffold; opus picks A/B/C among server-WS / P2P-WebRTC / hybrid-WebRTC
2026-04-25 23:55 | pending | feat(R16 OPUS): Network architecture decision — Option A (Server-WS, CF Workers DO target) — comms/network_architecture.md (511L); server/ scaffold (Bun WS lobby, Dockerfile, README); client/network.js + ?multiplayer=local|remote flag wired; 7/9 hard-verified, 2 gated on Bun install
2026-04-26 00:08 | 54a6892 | feat(R16 OPUS): Network architecture — chose Server-WS (Option A, score 124 vs 116/83); CF Workers+DO production; Bun lobby scaffold + WebSocket client + 411L architecture memo; 7/9 hard-verified, 2/9 gated on Bun install; ACCEPTED
2026-04-26 00:09 | pending | review(manus): round 17 — Three.js cutover (SONNET 4.6); flip default to ?renderer=three, legacy moves to ?renderer=legacy; verify R15 feature parity + add damage flash, death cam, station UI, pointer-lock visual; sunset notice on legacy code; 8 acceptance criteria
2026-04-26 00:30 | pending | feat(R17): Three.js cutover — flip default; ?renderer=legacy now opt-out; damage flash + pointer-lock visual added; sunset notice on legacy code; 5/8 hard-verified, 3/8 await runtime check
2026-04-26 00:04 | e23a3eb | feat(R17 SONNET): Three.js cutover — default renderer flipped to Three.js; ?renderer=legacy opt-out; damage-flash overlay + ptr-lock-hint overlay added; legacy sunset notice in wasm_main.cpp; z-order verified; 5/8 hard-verified + 3/8 deferred to live runtime; ACCEPTED
2026-04-26 00:20 | pending | feat(R18): visual quality cascade — composite procedural soldiers (3 armor tiers + leg/arm rig anim), composite buildings per type (turret/station/generator/tower/interior), PBR terrain with canvas noise diffuse+normal, THREE.Sky atmospheric, PCF shadows w/ camera-following frustum, hemisphere ambient, FogExp2, type-aware particle pool with soft-circle billboard, EffectComposer + UnrealBloom + custom vignette+grading shader, 4-tier graphics quality menu (low/medium/high/ultra). 11/12 criteria done; perf gated on runtime test. renderer.js 1072L (over 800 target — single-file kept for R18 traceability)
2026-04-26 00:35 | pending | feat(R19): network implementation — full lobby→match→snapshot/delta/input loop. server/sim.ts (470L authoritative TS port), server/anticheat.ts, server/lobby.ts (rewrite), server/wire.test.ts. client/{constants,quant,wire}.js single source of truth (server re-exports). client/prediction.js (input history + reconciliation + smooth correct). client/network.js (binary protocol + 60Hz input + bandwidth telemetry). _setLocalPlayerNetCorrection WASM export. shell.html wires JS keyboard mirror + bw-telemetry overlay. 9/11 criteria done; lag-comp raycast + bot disconnect-fill deferred to R20. Guardrails clean.
2026-04-26 00:11 | pending | review(manus): round 18 — Visual quality cascade (SONNET 4.6); player glTF models (Quaternius/Kenney CC0), building meshes, terrain PBR with slope blending, THREE.Sky + soft shadows, particle systems (jet/ski/sparks/explosions), bloom+vignette+grading, graphics quality settings; 12 criteria must hit 8
2026-04-26 00:19 | 2b92621 | feat(R18 SONNET): Visual quality cascade — composite procedural everything (no glTF due to CDN constraint); 3-tier player models with rigged animation; 5 building types; PBR terrain with noise + normal maps; THREE.Sky + DirectionalLight + soft shadows + fog; particle system jet/explosion/spark; UnrealBloom + grading + vignette post-process; graphics quality dropdown low/medium/high/ultra; 11/12 implemented + 1 gated on runtime fps test; ACCEPTED
2026-04-26 00:30 | pending | review(manus): round 19 — Network implementation (SONNET 4.6); server sim port (TS) + wire format encode/decode + lobby flow + client prediction + lag-comp + anti-cheat + match-end + disconnect handling + bandwidth telemetry; first multiplayer round; 11 criteria must hit 8
