# Manus Feedback — Round 19: Network Implementation (SONNET)

**MODEL:** **SONNET 4.6** (1M context)
**Severity:** Major — first round where the game becomes actually-multiplayer
**Type:** Implementation against R16 architecture spec

---

## 1. Reference docs (READ THESE FIRST)

- `comms/network_architecture.md` — full Opus R16 spec; canonical source of truth for wire format, prediction, lag-comp, anti-cheat
- `server/lobby.ts` (existing scaffold from R16) — extend, don't replace
- `client/network.js` (existing scaffold from R16) — extend, don't replace
- `program/code/wasm_main.cpp` — your simulation source. The R15 RenderPlayer/Projectile structs already mirror snapshot fields; reuse the populate functions

---

## 2. Goal

Make `?multiplayer=remote` produce a working **lobby → match → play → match-end → return-to-lobby** loop with:

- Server authoritative simulation (TypeScript port of relevant C++ logic)
- 30 Hz simulation tick on server, 10 Hz snapshot + 30 Hz delta downstream, 60 Hz input upstream
- Client-side prediction with reconciliation (no perceived input lag)
- Lag compensation for hitscan weapons (200 ms ring buffer rewind)
- Baseline anti-cheat (movement speed, aim rate, weapon cooldown server checks)

This is a 2-3 hour Sonnet round. It is the largest Sonnet round of the project. Budget accordingly. If you finish 80%, ship it and document the gaps in `open_issues.md` — R20 picks up.

---

## 3. Concrete task list (in priority order — ship as many as time allows)

### 3.1 P0 — Server simulation port

In `server/sim.ts` (new file, ~600 lines target):

- Port the C++ player physics (gravity, friction, jet, ski) — match constants exactly, copy from `wasm_main.cpp` and convert syntax
- Port projectile physics (5 weapon types: disc, chain, plasma, grenade, mortar) — including hit detection
- Port flag mechanics (pickup, drop, cap)
- Port match state machine (warmup → in-progress → ended)
- Run at fixed 30 Hz tick; never variable timestep
- Maintain a **ring buffer of last 6 ticks** (200 ms) of player positions for lag-comp (§9 of architecture spec)
- Expose `applyInput(playerId, input, clientTick)` and `tickSimulation()` and `serializeSnapshot()` and `serializeDelta(prevTick)` 

**Constants table:** put all gameplay constants (gravity=-9.8, jet thrust=15, ski friction=0.02, weapon damage values, etc.) into `server/constants.ts` and import the same constants on the C++ side via `program/code/sim_constants.h` (header-only). Both sides read the same source of truth.

If exact lockstep with C++ is too brittle to maintain right now, accept ±1cm/sec drift on velocity — visible reconciliation will smooth it. Only weapon damage and hit detection require strict equality.

### 3.2 P0 — Wire format encoding/decoding

Write `server/wire.ts` and `client/wire.js`:

- `encodeSnapshot(state)` → `Uint8Array` per §5.2
- `decodeSnapshot(buf)` → state object per §5.2
- `encodeDelta(prev, cur)` → `Uint8Array` per §5.3
- `decodeDelta(buf, prevState)` → state object per §5.3
- `encodeInput(input)` → `Uint8Array` per §5.5
- `decodeInput(buf)` → input object per §5.5

Use `DataView` for typed reads/writes. Validate `MsgHeader.payloadLen` matches actual payload before decoding to prevent malformed-message crashes. **Drop and log** any message that fails validation; do not throw.

Quantization helpers (`quantPos(m) = Math.round(m * 50)`, `unquantPos(q) = q / 50`, etc.) live in a shared `server/quant.ts` exported as ES module — client imports same file via `client/wire.js` to guarantee both sides agree.

### 3.3 P0 — Lobby flow extension

Extend `server/lobby.ts`:

- Currently broadcasts `playerList` on join/leave; extend with `subType: matchStart` once 4 players present (or 3 + 30s grace timer)
- On `matchStart`: instantiate `server/sim.ts` as the match's authoritative state, broadcast initial snapshot to all clients
- Route incoming `type=3 (input)` messages to `sim.applyInput()` instead of echoing
- Run `setInterval(tickSimulation, 1000/30)` for the 30Hz server tick
- Run `setInterval(broadcastSnapshot, 100)` (10Hz)
- Run `setInterval(broadcastDelta, 1000/30)` (30Hz)
- On `subType: matchEnd`, return all clients to lobby state, hold lobby for 60s for "play again"

### 3.4 P0 — Client prediction loop

Extend `client/network.js` and add `client/prediction.js`:

- On every input frame (60 Hz): apply input locally to predicted state, send input to server with `clientTick` sequence number
- Maintain a **history of last 60 inputs** (~1 sec) keyed by clientTick
- On server snapshot arrive: locate the client's player by id, **rewind predicted state to server's tick, replay all inputs since then** — this is reconciliation
- If reconciliation diverges by > 0.5m for position or > 5° for rotation, **smoothly correct over 200 ms** (interpolate) rather than snap. Avoids visible teleporting.

The C++ simulation continues to drive the local player visually each frame. Client prediction state lives in JS; the C++ side is told the corrected position via a new export `_setLocalPlayerNetCorrection(x,y,z,yaw,pitch)`.

### 3.5 P1 — Lag compensation for hitscan weapons

In `server/sim.ts`:

- When a `chaingun` fire input arrives with `clientTick=N`, compute `serverTickAtFire = N + clockOffset` (clockOffset measured from ping/pong)
- Look up player positions at `serverTickAtFire` from the ring buffer
- Trace the hit ray against those rewound positions (not current)
- If hit, apply damage to the entity at its **current** position (not rewound; we don't rewind damage)
- Cap maximum rewind to 200ms (6 ticks at 30Hz). Rewind requests beyond the cap clamp to the oldest entry.

This is the §9 algorithm from the architecture spec.

### 3.6 P1 — Anti-cheat baseline

In `server/anticheat.ts`:

- **Speed check:** if a client-applied position would exceed 60 m/s velocity in any axis, reject input and snap player to last server-validated position
- **Aim rate check:** if a client-applied rotation would exceed 1080°/sec angular velocity, reject (legitimate flicks are < 720°/sec for elite players)
- **Cooldown check:** server enforces weapon cooldowns from `constants.ts`. Client-side fires that arrive faster than cooldown are silently dropped (with a `[CHEAT] cooldown violation playerId=X` log)
- **Sanity:** if a client sends > 100 inputs/sec sustained for > 1 sec, kick (legitimate clients send 60/sec)

These are baseline only. R25+ adds replay validation, statistical outlier detection.

### 3.7 P2 — Match-end and rematch flow

- On score limit hit: server broadcasts `subType: matchEnd` with final scores
- Client renders match-end screen showing winner team, top scorers, MVP
- Server holds lobby for 60s with a "Play again? [Y/N]" UI on client
- If 75%+ of players vote yes, restart match with same teams; otherwise return all to main menu

### 3.8 P2 — Disconnect handling

- Player disconnects mid-match → server replaces with a bot using R14 AI v2 (already in C++)
- If reconnect within 30s with same player UUID, restore control to player
- If 50%+ of human players disconnect, void match (no score recorded), return all to lobby

### 3.9 P3 — Bandwidth telemetry

Add to client diagnostic display:
- `Bandwidth: ↓ 10.2 KB/s ↑ 0.7 KB/s | Ping: 47ms | Loss: 0%`
- Tracks vs the ~10.3 KB/s downstream / 5.8 Kbps upstream target from §5.4

---

## 4. Acceptance criteria (must hit 8 of 11)

1. ✅ `npm run dev` (or `bun run dev`) in `server/` starts the lobby server on `:8080`
2. ✅ Two browser tabs at `http://localhost:8000/?multiplayer=remote` both connect, see each other in the lobby player list, and a match starts when both indicate ready
3. ✅ Both clients see each other's player position update in real-time (synthetic test: tab A walks east, tab B sees player_A move east within 100ms)
4. ✅ Wire format snapshot decodes correctly: open `wire.test.ts` shows roundtrip encode→decode produces identical objects
5. ✅ Bandwidth measurement on client matches §5.4 estimate (±20%)
6. ✅ Client prediction works: typing W in tab A produces immediate forward movement; reconciliation log shows divergence < 0.5m typical
7. ✅ Lag compensation: synthetic test where tab A fires chaingun at tab B with simulated 100ms latency hits where B was 100ms ago, not now
8. ✅ Speed/aim-rate/cooldown anti-cheat triggers logged when violated (test: temporary client patch to send 200/sec inputs → server kicks)
9. ✅ Match-end screen displays correctly when score limit reached
10. ✅ Disconnect → bot replacement works; reconnect within 30s restores player control
11. ✅ Bandwidth telemetry visible on client

Bonus:
- B1. Lobby browser UI for picking from open public matches
- B2. URL-share friend match works (`?multiplayer=remote&lobbyId=ABCD`)
- B3. Voice chat (probably defer to R25)

---

## 5. Compile/grep guardrails

- All new server code in `server/*.ts`, run `bun build server/lobby.ts` cleanly with no type errors
- All new client code in `client/*.js`, ES module imports, no globals
- `! grep -nE 'EM_ASM[^(]*\(.*\$1[6-9]'` must pass (legacy)
- Server: no `any` types in public APIs (use `unknown` + type guards if needed)
- Server: pin all dependencies in `package.json`
- Client: no third-party dependencies (vanilla JS)

---

## 6. Time budget

90-180 min Sonnet round. Suggested split:
- Server sim port: 45 min
- Wire format encode/decode + tests: 30 min
- Lobby flow extension: 20 min
- Client prediction loop: 30 min
- Lag compensation: 20 min
- Anti-cheat baseline: 15 min
- Match-end / disconnect / telemetry: 20 min

---

## 7. Decision authority for ambiguities

- **If TypeScript port of C++ physics drifts:** accept up to ±1cm position drift / ±0.5 m/s velocity drift; reconciliation handles this. Document any larger drifts in `open_issues.md`.
- **If WebSocket binary frames have issues with CF Workers:** for R19 development just use Bun locally; production deployment to CF Workers is R20+ verification
- **If client prediction reconciliation produces visible jitter:** increase smoothing window from 200ms to 400ms; document in `open_issues.md`
- **If lag compensation produces "shot behind cover" complaints in playtest:** reduce max rewind from 200ms to 100ms (limits client-side latency advantage)
- **If anti-cheat false-positives legitimate skilled play:** loosen thresholds 20% and add a `[CHEAT-DEBUG]` flag to log without kicking

---

## 8. Roadmap context

- **R17 (Sonnet, just landed):** Three.js cutover — default renderer flipped
- **R18 (Sonnet, next):** Visual quality cascade — PBR, real models, shadows, particles, post-process
- **R19 (this round, Sonnet):** Network implementation per R16 spec
- **R20+ (Sonnet):** CF Workers DO production deploy, multi-region, polish

After R19 lands, the project goes from "single-player WASM" to "playable in the browser with strangers." This is the milestone where Tribes becomes real.
