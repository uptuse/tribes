# Manus Feedback — Round 23: Voice Chat + R22 Deferred + Balance Pass (SONNET)

**MODEL:** **SONNET 4.6** (1M context)
**Severity:** Standard
**Type:** Implementation — close R22 deferred items (per-class loadouts, settings export/import), add voice chat (WebRTC mesh layered on existing WebSocket signaling), and apply a first balance pass driven by simulated playtest data

---

## 1. Context

R22 shipped real A* bots, 14-sound procedural audio, spawn shields, match countdown, damage arcs (8/10 hard-implemented). Two items deferred to R23 per priority-order shipping discipline: settings export/import (#8) and per-class loadouts (#9).

R23 closes those, adds the missing-feature most likely to determine whether playtesters actually have fun together (voice chat — without it the social loop dies), and applies an evidence-based balance pass to fix any obvious imbalances surfaced by the loadtest harness.

---

## 2. Concrete tasks

### 2.1 P0 — Per-class loadouts with server validation (~30 min)

R22 deferred this. Implementation lives in three places:

The deploy-screen UI in `shell.html` and `index.html` adds a class picker (Light / Medium / Heavy) shown after team selection. Each class displays its weapon list and grenade count in a 3-column comparison panel. The selected class is sent to the server in the `joinAck` request.

The server in `server/sim.ts` validates the class on join and stores `Player.classId`. The respawn function gives the player only the weapons in that class's loadout (replaces the current weapon-give-all logic). Definition lives in `client/constants.js` (and re-exported via `server/constants.ts`):

> Light: blaster, disc, chaingun, grenade. 3 grenades. Spawn time 4s. Energy regen 1.0×.
> Medium: blaster, disc, chaingun, plasma, grenade. 5 grenades. Spawn time 6s. Energy regen 0.85×.
> Heavy: blaster, plasma, mortar, grenade. 8 grenades. Spawn time 9s. Energy regen 0.6×. Repair pack inventory item.

The anti-cheat layer adds a fire-input check: if the input's `weaponSelect` is not in the player's class loadout, drop with `[CHEAT-LOADOUT] playerId=X selected=Y class=Z`. Three sustained violations in 10s kicks the player.

### 2.2 P0 — Settings export/import + reset (~20 min)

R22 deferred this. Add three buttons to the existing settings modal: "Reset to Defaults", "Export Settings", "Import Settings". Reset clears all `tribes:*` localStorage keys and reloads. Export downloads `tribes_settings.json` containing the current `ST` object plus a `version: 2` field. Import accepts a JSON file, validates against the v2 schema (field names + types), applies via `Module._setSettings(JSON.stringify(parsed))`, and persists.

Document the schema-versioning approach in `network_architecture.md` §11. Add a v1→v2 migration path that tags any pre-v2 settings with `version: 1` on first load and translates fields (`fov` field renamed `viewFov`, `audio` split into `audioMaster`/`audioSfx`/`audioMusic`).

### 2.3 P0 — Voice chat: WebRTC mesh layered on WebSocket signaling (~50 min)

The existing WebSocket lobby is a natural signaling channel for WebRTC peer-to-peer voice. Don't build a SFU — direct mesh works fine for 8-player teams.

The server in `server/lobby.ts` adds three message types: `voiceOffer`, `voiceAnswer`, `voiceCandidate`. Each gets routed from sender to addressee without server interpretation. Server logs `[VOICE] from=X to=Y` for diagnostics. No voice data flows through the server itself — only signaling.

The client in `client/voice.js` (~200L target) wraps `RTCPeerConnection` per opponent. On match start, the client creates one `RTCPeerConnection` to each teammate (mesh = 7 connections in 8-player team, manageable). It captures local `getUserMedia({audio: true})`, attaches the track, and renders incoming tracks via `<audio autoplay>` elements positioned via Web Audio API `MediaStreamAudioSourceNode` → `PannerNode` for 3D voice positional spatialization (same HRTF model as R22 audio).

Push-to-talk: hold `V` to enable mic, release to mute. Open mic toggle in settings (`ST.voiceMode = 'pushToTalk' | 'open'`).

Visual indicator in the HUD: speaking teammates get a cyan pulse on their nameplate (extend R20 nameplate Sprite with an `speaking` flag fed from RTC stats `audioLevel > threshold`).

Decision authority: if WebRTC NAT traversal fails (~10% of users behind symmetric NAT), document fallback to a Cloudflare-hosted TURN relay in `open_issues.md`; defer implementation to R24+.

### 2.4 P1 — Balance pass v1 driven by loadtest data (~25 min)

Run `server/loadtest/run.sh` against a local instance for 5 minutes. Capture per-weapon kill-rate, per-class K/D, and ski-vs-walk movement distribution into `loadtest_balance.csv`. Feed these into the analysis script `server/loadtest/analyze.ts` (~80L) that prints suggested constants tweaks. Apply only the changes with high confidence:

The likely tweaks (calibrate from data, don't ship blind):
> Mortar damage 80→70 if mortar K/D > 1.5× weapon median.
> Chaingun spread cone 0.05→0.07 rad if chaingun kill share > 35%.
> Light armor max HP 100→110 if light class K/D < 0.85× class median.
> Jet energy cost 1.0→0.85 if average jet airtime per match < 15s (suggests too punitive).
> Ski friction 0.02→0.018 if ski distance per match < 200m median (too sticky).

Document each shipped change in `comms/balance_log.md` with the data-driven rationale and the source CSV row.

### 2.5 P1 — Server-broadcast `lastDamageFrom` for accurate damage arcs (~15 min)

R22 used a nearest-enemy heuristic for damage arcs. Replace with server-authoritative source: when the server applies damage to a player in `server/sim.ts`, it stamps `Player.lastDamageFromId = attackerId, lastDamageAtTick = currentTick`. The snapshot wire format (`server/wire.ts`) extends per-player payload by 1 byte (`lastDamageFromIdx` packed into existing reserved slot — no new bandwidth). Client `client/wire.js` decodes and feeds to `showDamageArc(attackerWorldPos)`.

### 2.6 P2 — Repair pack inventory + use (~20 min)

Heavy class spawns with one repair pack (+50 HP over 5s, single use). Bind to `R` key when pickup available. Server tracks `Player.inventory: { repairPack: 0|1 }`. Use input is a new `keys` bit `USE_REPAIR`. Pickup spawn at inventory-station-equivalent locations (server picks 4 fixed map points). Visual: floating cyan box on terrain + whoosh sound on pickup + chime on use.

### 2.7 P2 — Replay recording (local only, R23 scaffold) (~25 min)

Server records every snapshot + delta + input arrival to a `Match.replayBuffer: ArrayBuffer[]` while the match is live. On match end, server offers a `GET /replay/:matchId` endpoint that streams the buffer as a `.tribes-replay` binary file. Client's match-end overlay adds a "Save Replay" button.

Don't implement playback yet (R25+). Just capture and download. Document the binary format in `network_architecture.md` §12.

### 2.8 P3 — Color-blind mode (~10 min)

The team-color red/blue choice is friendly to most users but ~8% of men have red/green deficiency that can confuse blue/red distinction with the game's brown terrain. Add `ST.colorBlindMode = 'off' | 'deuteranopia' | 'protanopia' | 'tritanopia'` setting. When enabled, swap team colors:
> deuteranopia: red→orange (255, 140, 0), blue stays.
> protanopia: red→yellow (255, 220, 0), blue stays.
> tritanopia: blue→magenta (255, 0, 255), red stays.

Apply at render time in `renderer.js` and HUD CSS via CSS variables (`--team-red`, `--team-blue`). Test by toggling each mode against a screenshot of the play-screen.

---

## 3. Acceptance criteria (must hit 6 of 8)

The first six lines below capture what must function end-to-end. Lines 7-8 capture polish that is nice-to-have but not gating.

A class picker with three options renders during deploy and Light/Medium/Heavy spawn with the documented loadouts and energy regen modifiers. Server validates fire inputs against the player's class loadout and kicks on three sustained violations. Settings export downloads a v2 JSON, import validates and applies, reset wipes localStorage. Two browser tabs join the same lobby, opt into voice chat with `V` push-to-talk, and hear each other with 3D positional audio (close → loud, far → quiet). The HUD nameplate of a speaking teammate pulses cyan. The balance log records at least one data-driven constant change with CSV evidence. Damage arcs point at the actual attacker (verifiable by triggering damage from a known direction). Heavy class can pick up and use a repair pack. Color-blind mode swaps team colors when enabled.

---

## 4. Compile/grep guardrails

The standard guardrails apply: no `EM_ASM \$1[6-9]`, all new server files in `server/*.ts` typed without `:any` in public APIs, all new client files as ES modules, dependencies pinned, vanilla-JS client, `bun build` and `bun run test` clean.

---

## 5. Time budget

A reasonable Sonnet round is 150-200 minutes. The voice chat work is the longest pole because WebRTC requires careful state management around offer/answer/candidate exchange and stream lifecycle. Class loadouts and settings export/import are both mechanical follow-throughs from R22. Balance pass is fast if the loadtest harness already runs cleanly from R21.

---

## 6. Decision authority for ambiguities

If voice chat reveals echo or feedback issues, enable `RTCRtpSender.setParameters` with `degradationPreference: 'maintain-framerate'` and add a server-side per-track audio-level threshold filter; document any audible-quality compromises in `open_issues.md`. If balance changes feel too aggressive in self-play, halve the magnitude and re-run loadtest. If repair pack pickup spawns conflict with existing buildings or terrain features, snap to the nearest open ground tile within a 4m radius. If color-blind mode breaks any HUD readability, default the affected element to a neutral white outline.

---

## 7. Roadmap context

R23 is the first round that closes the social loop end-to-end: people can hear each other, pick a class, and play with sensible balance. R24 will implement matchmaking improvements (skill-based pairing, friend lists), R25 will add custom maps and replay playback, R26+ enters mod-loader and ranked-mode territory.

After R23 lands and the user has run the actual CF Workers deploy, the project is ready for a public Day-1 playtest. That is the milestone.
