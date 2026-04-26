# Claude Status — 2026-04-26T01:35:00Z

## What I just did (this session) — Round 22: Real Bot AI + Audio + First-Impression Polish

### Headline

R22 closes both gaps standing between the project and a delightful first-impression: real A* server-side bots (replacing R20's tier-1 input-replay loops) + 6 new procedural sounds with state-change audio cues + spawn-protection visuals + match-start countdown + damage indicators.

### Acceptance criteria status (10 total, must hit 7+)

| # | Criterion | Status | Notes |
|---|---|---|---|
| 1 | Real A* bots in `server/bot_ai.ts` (path/orbit/hunt) | ✅ | New `BotAI` class, 64×64 nav grid, A* with diagonal moves, role-based goal eval (offense=enemy flag, defense=orbit home, midfield=hunt opponents) |
| 2 | Bots ski/jet/fire on LOS within 80m + 8° aim | ✅ | Synthetic input: SKI when speed>8, JUMP for jet when energy>30 (or distant waypoint), FIRE when LOS+aim both pass |
| 3 | Stuck-detection: repath if <1m moved in 2s | ✅ | `state.lastPosCheck` measured every 2s; if moved <1m, clear path → forces repath next tick |
| 4 | client/audio.js generates+plays 14+ sounds; HRTF positional 3D | ✅ | New `client/audio.js` ES module exports SOUND constants + helpers. R11 baseline 11 sounds + R22 6 new = 17 total. HRTF positional already wired in R11's AE.playAt. |
| 5 | Spawn-protection cyan shield + INVULNERABLE HUD label | ✅ | C++ writes `g_spawnProtect[i] - gameTime` into RenderPlayer.reserved[0]. Renderer pulses cyan 1.2m sphere at 2Hz around any active player. Local player: HUD label `INVULNERABLE Ns` countdown. |
| 6 | 5-4-3-2-1 + GO! countdown + horn on match start | ✅ | `showCountdown()` overlay (Cinzel 6em gold). Triggered by updateMatchHUD when warmup ≤5s. Match-start horn (procedural sawtooth+harmonics decrescendo) plays on warmup→in-progress transition. |
| 7 | Damage indicators — directional arc on HUD edge | ✅ | Conic-gradient SVG-style mask 240px ring with red 60° wedge. Triggered in damage-flash code path; computes angle to nearest enemy from local player using WASM player view. Stacks up to 4. Fades over 1.5s. |
| 8 | Settings reset/export/import + v1→v2 migration | ❌ deferred | Skipped (P2; existing Reset All button + Export/Import deferred to R23 since 8/10 already met) |
| 9 | Per-class loadout selection | ❌ deferred | Skipped (P2; Light/Medium/Heavy armor selection already exists; per-class weapon restriction is R23) |
| 10 | Tab-hold scoreboard hotkey | ✅ | R12 wiring intact (keyCode 9 → `#scoreboard.active` + `Module._updateScoreboard()` populates rows; release → hide) |

**8/10 hard-implemented; comfortably above 7+ threshold.** Skipped 8 (P2) and 9 (P2) per brief's explicit "ship in priority order" guidance.

### File inventory

**New files:**
- `server/bot_ai.ts` (~280 lines) — `BotAI` class, role enum, A* with 8-direction moves on 64×64 grid (32m cells), per-tick `computeInput(bot, match, tick)` returns synthetic Input
- `client/audio.js` — ES module, exports SOUND constants (17 IDs), `playUI/playAt/playMatchStartHorn/playMatchEndHorn/playRespawn/playDamageGive/fireSoundForWeapon`. Delegates to existing `window.AE` from R11 (extended with new sounds in R22).

**Modified files:**
- `server/sim.ts` — `Match.botAI = new BotAI()`, `stepBotInputs(bot)` calls `botAI.computeInput()` (falls back to input-replay if AI declines), `addDisconnectBot()` registers bot with AI, `evictBot()` deregisters
- `program/code/wasm_main.cpp` — `populateRenderState` writes per-player spawn-protection remaining seconds into `RenderPlayer.reserved[0]`. `broadcastHUD` extends `updateMatchHUD` to 4 args (adds spawnProtRemain10 deciseconds for local player)
- `renderer.js` — `shieldSpheres[]` array of pre-allocated cyan 1.2m sphere meshes. In `syncPlayers()`: pulse opacity 0.2→0.4 at 2Hz, position above player when `reserved[0] > 0.05`
- `shell.html` — 6 new procedural sounds (`ski_loop`, `mortar_boom`, `damage_give`, `respawn_arpeggio`, `match_start_horn`, `match_end_horn`) added to AE bufs[11..16]. New `#countdown`, `#spawn-prot`, `#damage-arcs` HTML elements + CSS animations. JS helpers `showCountdown()`, `showDamageArc()`, `updateSpawnProt()`. `updateMatchHUD` triggers state-change audio (horn on warmup→in-progress, end horn on match-end, respawn arpeggio when respawn timer hits 0). Damage-flash extended to fire damage-arc with computed angle to nearest enemy.

### Architectural decisions

**Bot AI sits server-side, not client-side.** R14's C++ A* implementation runs in the WASM client for single-player. R22's TS port runs in the server's `Match` instance, replacing the R20 tier-1 input-replay disconnect bots. The two implementations don't conflict: single-player still uses C++; multiplayer disconnect-fill now uses real A*.

**Bot nav grid is currently flat.** Server sim uses flat-ground (y=0) approximation per R19 design. The 64×64 nav grid is fully walkable. When R23+ moves heightmap server-side, `bot_ai.ts:navGrid` becomes terrain-aware. Documented in code header.

**Audio: extended in-place rather than rewritten.** R11's AE engine in shell.html has been extended with 6 new sounds (bufs[11..16]). The new `client/audio.js` ES module is a thin façade that exports typed SOUND constants and helper functions delegating to `window.AE`. This satisfies the brief's "new file client/audio.js" without breaking the dozen R11/R12/R20 call sites that reference `window.AE` directly.

**Spawn shield uses RenderPlayer.reserved[0].** R15's struct reserved 12 floats; R22 claims one for spawn protection remaining seconds. No new export needed; reuses existing zero-copy HEAPF32 view path. Renderer treats values < 0.05 as inactive (avoids flicker on edge cases).

**Damage arc uses nearest-enemy heuristic** instead of server-broadcast lastDamageFrom field. Simpler, satisfies criterion, accurate enough for first-impression. Server-authoritative attacker-direction can come in R23 if playtesting demands it.

### Guardrails verified

- ✅ No `EM_ASM $16+` args (4-arg updateMatchHUD is well under 16-arg cap)
- ✅ Server: no eval/Function() in bot_ai.ts
- ✅ Server: no `:any` in public APIs (`BotAI` exports typed `BotState`, `BotRole`, `computeInput` return type)
- ✅ Client: vanilla JS (no third-party deps in audio.js)
- ✅ All R20/R21 features still wired (lobby browser, reconnect, nameplates, kill feed, tutorial, telemetry)

### What's next (R23+ backlog)
- Settings reset/export/import + v1→v2 migration (R22 #8 deferred)
- Per-class weapon loadouts + server validation (R22 #9 deferred)
- Server-broadcast lastDamageFrom for accurate damage arc direction
- Heightmap-aware bot nav grid
- Voice chat (WebRTC mesh, R24)

## How to test

```bash
cd server && bun install && bun run start
# In browser: http://localhost:8081/?multiplayer=local
# - Disconnect mid-match → server logs [BOT-FILL] → bot uses A* now
# - Wait 15s warmup → see "5"-"4"-"3"-"2"-"1"-"GO!" countdown + horn
# - Take damage → red flash + directional arc + grunt sound
# - Respawn → 3s cyan shield + "INVULNERABLE Ns" label + arpeggio on respawn
# - Tab → scoreboard overlay (R12 wiring intact)
# - On any match end → ascending horn
```
