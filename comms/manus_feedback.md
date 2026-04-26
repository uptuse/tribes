# Manus Feedback — Round 22: Real Bot AI + Audio + First-Impression Polish (SONNET)

**MODEL:** **SONNET 4.6** (1M context)
**Severity:** Standard
**Type:** Implementation — upgrade tier-1 disconnect bots to real A* bots, ship audio (was deferred since R0), polish first-impression UX so the link-shared playtest feels professional

---

## 1. Context

R21 landed the production deploy infrastructure (`deploy.sh`, loadtest harness, `/metrics`, `/dashboard`, `/health`, `INVITE FRIENDS`, tutorial overlay, README). 8/9 hard-implemented; runtime acceptance gated on user CF auth + actual deploy (not blocking).

The project is now shareable code-complete. Two gaps stand between this and a delightful first-impression:

1. **No audio whatsoever.** Tribes is iconic for its chaingun roar, jet whoosh, ski hiss, and disc launcher whomp. Silence kills the vibe instantly.
2. **Disconnect bots are tier-1 input-replay loops** — fine as a placeholder but obvious to other players. R20.2 explicitly deferred true A* bots to "R22+." This is R22.

R22 closes both gaps and lands the rest of the polish that turns "playable demo" into "I want to keep playing."

---

## 2. Concrete tasks (priority order)

### 2.1 P0 — Real bot AI: A* TS port for server-side bots (~50 min)

Currently `server/sim.ts:addDisconnectBot` clones the disconnected player's input ring and replays it with jitter. Upgrade to real A* navigation matching the C++ R14 implementation in `program/code/wasm_main.cpp`.

Implementation:
- New file `server/bot_ai.ts` (~250L target)
- Port the R14 C++ bot AI: 64×64 nav grid (server reads heightmap from WASM module on match start via existing `getHeightmapPtr` export pattern, or use a static cached version stored in `server/data/heightmap.bin` written at build time)
- Bot roles: offense (push enemy flag), defense (orbit home flag), midfield (hunt opponents in midmap)
- Per-tick (30Hz): bot evaluates current goal → A* path to next waypoint → produces synthetic `Input` with appropriate WASD bits + mouseDX/Y to face waypoint + occasional jet/ski/fire
- Skiing: when downhill grade > 5°, set `keys |= ButtonBits.SKI`
- Jetting: when uphill grade > 3° AND energy > 30, set `keys |= ButtonBits.JET`
- Firing: if LOS to target opponent within 80m AND aim-to-target angle < 8° → fire weapon
- Use existing weapon table from `client/constants.js` (shared)

Replace `addDisconnectBot` to use `BotAI` instead of input-replay. Keep input-replay as `addStubBot()` fallback for when bot AI fails (rare).

Acceptance test: spawn 4 bots in an empty lobby, watch them path to enemy flag, defenders orbit home flag, fire when LOS established. Stuck-detection: if bot doesn't move 1m in 2 seconds, repath.

### 2.2 P0 — Audio system foundation (~45 min)

New file `client/audio.js` (~150L). Web Audio API based.

Sound bank (procedurally generated to avoid licensing/asset concerns; see decision authority for upgrade path):
- `chaingun_loop` — 5Hz sawtooth-pulsed white noise burst, ~0.2s length, looping
- `disc_launch` — 80Hz sine sweep down to 30Hz over 0.4s + low-pass noise tail
- `plasma_zap` — 1500Hz square sweep down to 400Hz over 0.15s
- `grenade_thump` — 60Hz sine tone, 0.1s envelope
- `mortar_boom` — pink noise burst with low-pass + reverb tail (1.5s)
- `jet_loop` — band-pass white noise, 200-800Hz, looping
- `ski_loop` — pink noise low-passed at 400Hz, looping (volume scales with velocity magnitude)
- `damage_take` — 220Hz triangle, 0.15s decay
- `damage_give` — 880Hz sine, 0.1s decay (hit-confirm "tink")
- `flag_grab` — bell-like FM synth, 0.4s
- `flag_capture` — choir-like additive synth, 1.5s, polyphonic
- `respawn` — descending arpeggio (C5 → G4 → C4), 0.8s
- `match_start_horn` — sawtooth fundamental + 2 harmonics, 1.2s decrescendo
- `match_end_horn` — same but ascending, 1.5s

Generate via `OfflineAudioContext` once at game-start, cache as `AudioBuffer` instances. Play via `AudioBufferSourceNode` with positional `PannerNode` for 3D spatialization (HRTF panning model).

Wiring:
- Listener position/orientation updated each render frame from `Module._getCameraPosX/Y/Z/Yaw/Pitch`
- Each fire event from snapshot → spawn one-shot at projectile origin
- Each player's `keys` bit for SKI / JET → start/stop their corresponding loop tied to player position
- Volume slider in settings (already exists from R13 `ST.audioMaster`); also `ST.audioSfx` and `ST.audioMusic` for separate channels

Music: simple 8-track ambient drone procedurally synthesized, loops 4 minutes. Optional `?nomusic=1` flag to disable.

### 2.3 P1 — Spawn protection visual + invuln (~15 min)

Currently spawn protection is mechanical (no damage for 3s after spawn) but invisible. Add:
- Server marks player with `spawnProtUntil: Tick` field in snapshot
- Client renderer wraps the player mesh in a translucent cyan shield sphere (pulsing 0.5→1.0 alpha at 2Hz)
- Local player sees a "INVULNERABLE 2.7s" HUD label countdown
- Shield disappears on damage-attempt or on timer expiry (whichever first)

### 2.4 P1 — Improved warmup → match transition (~15 min)

Currently warmup ends with `g_matchState=1` flip and clients see warmup banner disappear. Add:
- 5-4-3-2-1 visible countdown overlay synced to server warmup timer
- "GO!" flash for 1 second on match start
- Match start horn audio cue (R22.2)
- Smooth fade-in of compass and scoreboard from 0→1 alpha over 1s

### 2.5 P1 — Damage indicators (~15 min)

When local player takes damage, render a directional arc on the HUD edge pointing toward the attacker:
- Red arc, 60° wide, fades over 1.5s
- Position derived from `attackerWorldPos - localPlayerWorldPos` projected onto screen
- Multiple simultaneous damage = stacked arcs (max 4 visible)
- Server includes `lastDamageFrom: PlayerId | null` in per-player snapshot field

### 2.6 P2 — Settings persistence improvements (~15 min)

Currently settings persist via `ST.persist()` to localStorage. Polish:
- Add `Reset to Defaults` button in settings modal (clears localStorage tribes:* keys, reloads page)
- Add `Export Settings` (downloads tribes_settings.json) and `Import Settings` (uploads JSON, validates schema, applies)
- Migrate any v1 settings format to v2 with version-tagged schema. Document in `network_architecture.md` §11.

### 2.7 P2 — Per-class loadout selection (~25 min)

Currently armor selection happens at deploy. Add proper class-based loadouts:
- **Light:** Blaster + Disc + Chaingun + Grenade (3 grenades, fast respawn)
- **Medium:** Blaster + Disc + Chaingun + Plasma + Grenade (5 grenades)
- **Heavy:** Blaster + Plasma + Mortar + Grenade (8 grenades, 2x repair pack)

Loadout reflected in HUD ammo display. Server validates loadout-weapon match per fire input (anti-cheat extension: heavy can't fire chaingun).

### 2.8 P3 — In-game scoreboard hotkey (~10 min)

Hold `Tab` → translucent scoreboard overlay shows team rosters with:
- Player name (team-colored)
- Kills / Deaths / Captures / Returns
- Ping
- Class icon
Release Tab → hides.

Server already broadcasts roster + scores; client just needs the overlay.

---

## 3. Acceptance criteria (must hit 7 of 10)

1. Real A* bots in `server/bot_ai.ts` correctly path to enemy flag, defenders orbit home flag, midfielders hunt
2. Bots ski downhill, jet uphill, fire on LOS within 80m + 8° aim cone
3. Stuck-detection causes bot to repath when stuck > 2s
4. `client/audio.js` generates and plays all 14 procedural sounds; HRTF positional 3D works
5. Spawn protection cyan shield visual + INVULNERABLE HUD label
6. 5-4-3-2-1 + GO! countdown on match start with horn audio
7. Damage indicator arcs render correctly toward attacker
8. Reset/Export/Import settings buttons functional with v1→v2 migration
9. Per-class loadout selection at deploy + HUD ammo + server validation
10. Tab-hold scoreboard overlay shows correct stats

---

## 4. Compile/grep guardrails

- `! grep -nE 'EM_ASM[^(]*\$1[6-9]'` (legacy carry-over)
- `bun build server/bot_ai.ts` and `bun build server/lobby.ts` clean
- `bun run test` (existing wire.test.ts + new bot_ai.test.ts) passes
- All new server files in `server/*.ts`; all new client files in `client/*.js` ES modules
- Pin all new dependencies in `package.json` (no `^` or `~` floats)
- No third-party audio dependencies (Web Audio API only)

---

## 5. Time budget

150-210 min Sonnet round. Split:
- Bot AI A* port: 50 min
- Audio system: 45 min
- Spawn protection visual: 15 min
- Match start countdown: 15 min
- Damage indicators: 15 min
- Settings persistence polish: 15 min
- Class loadouts: 25 min
- Tab scoreboard: 10 min

If you run out, ship in priority order. P0 + P1 = bare minimum.

---

## 6. Decision authority for ambiguities

- **If procedural audio sounds too synthetic/cheap:** add a `client/audio_assets/` folder structure for future real-sample overrides (load from URL if present, fall back to procedural). Don't ship samples in R22 (license/size); document the loader as ready for community sample packs.
- **If A* bot pathfinding is too slow on server tick:** switch to BFS for first pass, A* only when path > 30 cells. Document profile data in `open_issues.md`.
- **If HRTF positional audio causes performance hits on mobile:** fall back to stereo PannerNode (panning model `equalpower`) when navigator.userAgent includes mobile patterns.
- **If class loadout breaks save-game compatibility:** version-bump localStorage schema to v2 with migration; warn user of one-time settings reset.

---

## 7. Roadmap context

- **R22 (this round):** real bots + audio + first-impression polish
- **R23 (Sonnet):** post-playtest balance tuning (driven by user feedback from first deploy), potential gameplay tweaks (jet thrust, ski friction, weapon damage curves)
- **R24 (Sonnet):** voice chat (WebRTC mesh on top of existing infrastructure)
- **R25+ (Sonnet):** ranked matches, custom maps, replay system, mod loader

After R22 lands, the user can deploy with confidence that the first-impression survives a stranger clicking the link cold.
