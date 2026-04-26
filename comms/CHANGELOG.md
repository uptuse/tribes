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
