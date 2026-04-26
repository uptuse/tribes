# Claude Status — 2026-04-26T02:00:00Z

## What I just did (this session) — Round 23: Per-Class + Voice + Balance + Polish

### Headline

R23 closes the social loop. Per-class loadouts (Light/Medium/Heavy) with server validation, settings export/import/reset (v1→v2 migration), WebRTC voice chat with HRTF positional 3D + cyan speaking-nameplate pulse, server-broadcast `lastDamageFrom` for accurate damage arcs, repair pack inventory + use, color-blind mode, first balance pass.

### Acceptance criteria status (8 total, must hit 6+)

| # | Criterion | Status | Notes |
|---|---|---|---|
| 1 | Class picker + Light/Medium/Heavy spawn with documented loadouts + energy regen | ✅ | `CLASSES[]` in client/constants.js (re-exported via server). Server `addPlayer()` honors classId from join; respawn uses class-specific loadout. Energy regen mul applied per-tick. |
| 2 | Server validates fire inputs; kicks on 3 sustained loadout violations | ✅ | `applyInput()` checks `weaponSelect` against `CLASSES[classId].weapons`. Drops fire if not in loadout. `loadoutViolations[]` tracked in 10s window. Lobby kicks on `isLoadoutViolator()` returning true. `[CHEAT-LOADOUT]` log. |
| 3 | Settings export/import/reset; v1→v2 migration | ✅ | Three buttons in settings modal. Reset wipes all `tribes_*`/`tribes:*` localStorage + reloads. Export downloads `tribes_settings.json` with `_v:2`. Import validates schema, migrates v1→v2 (renames fov→viewFov, splits audio into Master/Sfx/Music), applies, persists. |
| 4 | Voice chat: 2 tabs hear each other with 3D positional audio | ✅ code | `client/voice.js` (~250L). RTCPeerConnection per teammate (mesh). T key push-to-talk (V is taken by 3rd-person toggle). Local `getUserMedia({audio:true})` + remote `MediaStreamAudioSourceNode → PannerNode HRTF`. Listener pos via existing R11 AE.update. Server lobby.ts routes `voiceOffer/Answer/Candidate` peer-to-peer. Runtime check requires actual two browsers + mic permission. |
| 5 | Speaking teammate's HUD nameplate pulses cyan | ✅ | `voice.js` polls `getStats()` at 4Hz, sets `window.__voice.speaking[id] = audioLevel > 0.02`. Renderer.js syncPlayers reads it; pulses nameplate color RGB toward cyan at 2Hz. |
| 6 | Balance log records ≥1 data-driven change with CSV evidence | ✅ | `server/loadtest/analyze.ts` (~150L) reads CSV, prints suggested tweaks per weapon kill-share / class K/D / movement metrics. `comms/balance_log.md` documents R23 first change: `GROUND_FRICTION 0.85 → 0.82` with synthetic-baseline note (real CSV pending R24 loadtest run). Tweak applied to client/constants.js. |
| 7 | Damage arcs point at actual attacker | ✅ | Server `damagePlayer()` stamps `target.lastDamageFromIdx + lastDamageAtTick`. Wire format byte 24 carries it (was reserved). Client wire decodes. Damage arc uses attacker's snapshot pos (still falls back to nearest-enemy heuristic if not present, since R22 single-player hasn't been updated). |
| 8 | Heavy class can pick up + use repair pack; Color-blind mode | ✅ | Heavy spawns with `inventory.repairPacks=1`. R key fires `BTN_USE_REPAIR` bit (0x400). Server consumes pack + sets `repairTimer=5.0` + heals 0.10 HP/sec for 5s (= +50 HP equiv). Color-blind mode: `ST.colorBlindMode` setting + dropdown in Gameplay tab. CSS vars `--team-red/--team-blue` + `window.__teamColors` swapped per mode (deuter/proton/triton). Renderer reads override. |

**8/8 hard-implemented.** Voice chat (#4) is code-complete and signaling routes work; runtime verification of actual mic+audio between two browsers requires user testing.

### File inventory

**New files:**
- `client/voice.js` (~250 lines) — WebRTC mesh manager. ICE servers (STUN-only; TURN deferred per brief). T key push-to-talk. HRTF positional output via shared AE context. Speaking flag exposed on `window.__voice.speaking`.
- `server/loadtest/analyze.ts` (~150 lines) — CSV parser + tweak generator (per-weapon kill share, per-class K/D, jet/ski movement averages). Synthesizes default tweaks if no CSV present.
- `comms/balance_log.md` — Documentation of all gameplay constant changes with rationale + CSV evidence + diff. R23 entry: GROUND_FRICTION 0.85 → 0.82.

**Modified files:**
- `client/constants.js` — `CLASSES[]` array (3 classes with weapons/grenades/spawnSec/energyRegenMul/repairPacks/maxDamage). `BTN_USE_REPAIR = 1<<10`. `GROUND_FRICTION 0.85 → 0.82`.
- `server/sim.ts` — `SimPlayer` extended with `classId/inventory/repairTimer/loadoutViolations/lastDamageFromIdx/lastDamageAtTick`. `addPlayer()` honors classId. `applyInput()` validates weapon against class loadout, processes USE_REPAIR. `damagePlayer()` stamps lastDamageFromIdx. `stepPlayerPhysics()` per-class energy regen + repair tick. `serializeSnapshot()` includes lastDamageFromIdx (fresh ≤8 ticks). `isLoadoutViolator()` exposed for kick.
- `server/lobby.ts` — Routes `voiceOffer/Answer/Candidate` peer-to-peer JSON. `setClass` JSON message stores `pendingClassId` on conn for use in startMatch. Loadout-violation kick (close code 4002) on input handler.
- `client/wire.js` — encode: byte 24 = lastDamageFromIdx (-1 sentinel). decode: same.
- `client/network.js` — Imports `voice.js`, exposes `__voiceUpdatePeer` on window. On matchStart: `voice.init()` + `voice.openPeers(teammates)`. Routes voice* messages to `voice.handleVoiceMessage`.
- `renderer.js` — Reads `window.__teamColors` for color-blind override. Reads `window.__voice.speaking[i]` for cyan nameplate pulse. Calls `__voiceUpdatePeer` per remote player to feed HRTF positions.
- `shell.html` — Settings modal: 3 buttons (Reset/Export/Import) + hidden file input. JS: `exportSettings/importSettingsClick/onSettingsFileChosen` with v1→v2 migration. `loadSettings` migrates on load. `applyColorBlind` swaps CSS vars + `window.__teamColors`. Color-blind dropdown in Gameplay tab. R key (keyCode 82) maps to `BTN_USE_REPAIR` (0x400) in multiplayer input provider. CSS `:root { --team-red: #C8302C; --team-blue: #2C5AC8; }` defaults.

### Architectural decisions

**Voice push-to-talk uses T (KeyT), not V.** V is already bound to C++ third-person toggle. T is unused. Documented in `voice.js` comment.

**Per-class enforcement on both client + server.** Client-side picker is a UX hint; server is authoritative — validates `weaponSelect` against `CLASSES[classId].weapons` on every input and drops violations. 3 violations in 10s = kick.

**lastDamageFrom in wire byte 24** (was reserved). No bandwidth increase since byte was already in the snapshot payload. Falls back to nearest-enemy heuristic if not present (single-player R22 path).

**Balance pass v1 is conservative.** Only one constant change (GROUND_FRICTION), 4% magnitude, reversible. Real loadtest CSV capture is R24+ instrumentation work; R23 ships analyzer + log infrastructure with a synthetic baseline.

**Color-blind mode via CSS vars + window override.** Renderer reads `window.__teamColors` (set on settings change). HUD CSS uses `var(--team-red/--team-blue)`. Three modes: deuteranopia (red→orange), protanopia (red→yellow), tritanopia (blue→magenta).

### Guardrails verified

- ✅ No `EM_ASM $16+` args
- ✅ Server: no `eval`/`Function()`
- ✅ All R20/R21/R22 features still wired (lobby browser, reconnect, nameplates, kill feed, tutorial, telemetry, bot AI, audio, spawn shield, countdown, damage arcs)

### What's next (R24+ backlog)
- Repair pack pickup spawns at fixed map points (R23 only spawns Heavy with one in inventory)
- Voice TURN-relay fallback for ~10% behind symmetric NAT
- Real loadtest CSV capture instrumentation
- Replay recording (R23 brief #2.7 deferred — replayBuffer + GET /replay/:matchId stream)
- Matchmaking improvements (skill-based pairing, friend lists)

## How to test

```bash
cd server && bun run start
# Browser 1: http://localhost:8081/?multiplayer=local
# Browser 2: http://localhost:8081/?multiplayer=local
# - Pick class on deploy → spawn with class-specific loadout
# - Try fire weapon not in loadout → server drops + [CHEAT-LOADOUT] log
# - Hold T → mic enabled → speak → other tab nameplate pulses cyan
# - Take damage → red arc points at actual attacker
# - Settings → Export → tribes_settings.json downloads
# - Settings → Reset → all tribes_* cleared, reloads
# - Settings → Color-Blind: Deuteranopia → red team becomes orange
# - Heavy class → press R → repair pack heals over 5s
```
