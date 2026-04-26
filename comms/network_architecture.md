# Network Architecture — Tribes Browser Edition

> **Round 16 (Opus 4.7) deliverable.**
> Status: Architecture decision locked; minimal connection scaffold lands with this commit. Game-state networking implementation is R19.

---

## 1. Decision: Option A — Authoritative server over WebSocket

**Production target:** Cloudflare Workers + Durable Objects (one Durable Object per match).
**Scaffold runtime:** Bun (local development); Dockerfile for Fly.io fallback.

This is the architecture the rest of the project will be built against.

---

## 2. Scored decision matrix

| Criterion (weight) | A: Server-WS | B: P2P-WebRTC | C: Hybrid-WebRTC |
|---|---:|---:|---:|
| Latency, US East (×3)         | 3 → 9   | 5 → 15  | 4 → 12  |
| Latency, cross-Pacific (×2)   | 2 → 4   | 4 → 8   | 3 → 6   |
| Anti-cheat resistance (×5)    | **5 → 25** | 1 → 5   | **5 → 25** |
| Spectator / replay (×3)       | **5 → 15** | 1 → 3   | **5 → 15** |
| Hosting cost @ 100 CCU (×4)   | 3 → 12  | 5 → 20  | 3 → 12  |
| Implementation complexity (×4) | **5 → 20** | 2 → 8   | 3 → 12  |
| Browser compat (×4)           | **5 → 20** | 3 → 12  | 4 → 16  |
| Mobile / iOS Safari (×2)      | **5 → 10** | 3 → 6   | 4 → 8   |
| Scaling 32+ players (×1)      | 5 → 5   | 1 → 1   | 5 → 5   |
| Future tech path (×1)         | 4 → 4   | 5 → 5   | 5 → 5   |
| **Weighted total**            | **124** | 83      | 116     |

Margin: A leads C by **8 points (6.5%)** — inside Manus's 10% tiebreaker window. Both A and C score 5/5 on anti-cheat and spectator/replay, so that tiebreaker does not differentiate. Decision falls to project-specific rationale (§3).

---

## 3. Rationale — why A wins for this specific project

**A and C are functionally equivalent on the project-critical axes** (anti-cheat, spectator/replay). The decision reduces to: is C's latency advantage worth its complexity premium?

For Tribes specifically, **no**, for four reasons:

1. **Tribes gameplay is long-range and prediction-friendly.** Average engagement distance is 30–80m with projectile weapons (disc launcher, plasma, mortar) that already require leading. Players already compensate for projectile flight time of ~200–800ms. A 30ms transport latency advantage from C is invisible against this baseline. Hitscan chaingun is the exception, and standard server-side lag compensation (§9) handles it.

2. **C's complexity premium is real engineering time.** Geckos.io has known maintenance friction (server-side WebRTC peer-connection lifecycle, ICE restart handling, TURN credential rotation, browser-version compatibility). A standard WSS server is well-understood by every engineer who has ever worked on web. The 1-week implementation savings translates to one extra Sonnet round of game features.

3. **Cloudflare Workers + Durable Objects collapses A's cost disadvantage.** Production cost at 100 concurrent users on CF Workers DO: $5/month + $0.15/M WebSocket messages = **~$8/month total**. CF Workers also gives us global edge (Anycast routing → user always hits the nearest data center), partially neutralizing A's Pacific-latency disadvantage. The DO model maps cleanly: one DO instance per active match, isolated state, automatic geographic placement.

4. **Migration A → C is clean if needed.** The server stays authoritative; only the transport changes (WebSocket → Geckos.io WebRTC DataChannel). The snapshot/delta protocol (§5) is transport-agnostic. If R20+ playtesting reveals latency complaints from competitive players, we can swap transports in a single Sonnet round.

**One concession:** Cloudflare Workers Durable Objects use V8 isolates, which means the C++ simulation cannot run server-side via Emscripten WASM directly inside a Worker (CPU-time per-request limits would fight a 30Hz simulation). The server-side simulation will be a **TypeScript port** of the relevant C++ logic, kept in lockstep via the same constants table. This is acceptable because (a) TypeScript JIT is fast enough at 30Hz×8 players and (b) the deterministic-replay requirement is easier to satisfy in TS than in WASM.

If the TS-port lockstep proves too brittle to maintain, fallback is **Fly.io** running the existing C++ simulation as a native binary (the Emscripten output already includes a non-WASM build path). Cost goes up to $10–25/mo, but still tractable.

---

## 4. Fallback paths (priority order)

| If the chosen path hits a wall… | Fall back to… | Cost |
|---|---|---|
| CF Workers DO can't keep up with 30Hz×8 players | Fly.io with native C++ binary | +$10–20/mo |
| TS port of simulation drifts from C++ | Compile C++ to native and run on Fly.io | +1 week port |
| WebSocket latency is competitively unacceptable | Migrate transport to Geckos.io (Option C) | +1 week |
| Global latency spread is intolerable | Multi-region CF Workers DO with regional matchmaking | +$5/region |
| Anti-cheat circumvented (clients fabricating snapshots) | Server-side input replay validation (already on roadmap) | already planned |

No fallback path requires throwing away R19 implementation work.

---

## 5. Wire-format protocol

All messages are little-endian binary. WebSocket binary frames (not text). Field quantization is chosen so that the smallest perceptible state change at 60 Hz client render rate is preserved.

### 5.1 Common header (8 bytes)

```c
struct MsgHeader {
    uint8_t  type;            // 1=snapshot, 2=delta, 3=input, 4=lobby, 5=ping
    uint8_t  flags;           // bit 0: compressed, bit 1: encrypted, bits 2-7 reserved
    uint16_t payloadLen;      // bytes that follow this header
    uint32_t tick;            // server tick number (or client seq for inputs)
};
```

### 5.2 Snapshot — full state, sent at 10 Hz (every 3rd server tick)

```c
struct SnapshotPlayer {        // 32 bytes
    uint8_t  id;               // 0..15
    uint8_t  flags;            // bit 0: alive, 1: visible, 2: jetting, 3: skiing, 4: firing
    uint8_t  team;             // 0=red, 1=blue, 2=spectator
    uint8_t  armor;            // 0=light, 1=medium, 2=heavy
    int16_t  posX, posY, posZ; // quantized: meters × 50 (range ±655m, resolution 2cm)
    int16_t  rotPitch, rotYaw, rotRoll; // quantized: radians × 10000 (range ±π, resolution ~0.006°)
    int8_t   velX, velY, velZ; // quantized: m/s × 2 (range ±63 m/s, resolution 0.5 m/s)
    uint8_t  health;           // 0..255 (server scales from float to byte)
    uint8_t  energy;           // 0..255
    uint8_t  weaponIdx;        // 0..15 (0xFF = none)
    int8_t   carryingFlag;     // -1=none, 0=red flag, 1=blue flag
    uint8_t  botRole;          // 0xFF=human, 0=OFF, 1=DEF, 2=MID
    uint8_t  reserved[6];      // future use; pad to 32
};

struct SnapshotProjectile {    // 12 bytes
    uint8_t  id;
    uint8_t  type;             // 0=disc, 1=chain, 2=plasma, 3=grenade, 4=mortar, etc.
    uint8_t  team;
    uint8_t  flags;            // bit 0: alive
    int16_t  posX, posY, posZ;
    int16_t  age;              // ms remaining before despawn
    uint8_t  reserved[1];      // pad to 12
};

struct SnapshotFlag {          // 8 bytes
    uint8_t  team;
    uint8_t  state;            // 0=at-base, 1=carried, 2=dropped
    int8_t   carrierIdx;       // -1 or player id
    uint8_t  reserved;
    int16_t  posX, posY;
    int16_t  posZ;
};

struct Snapshot {
    MsgHeader header;
    uint8_t   playerCount;     // 0..16
    uint8_t   projCount;       // 0..200 (only alive sent)
    uint16_t  matchTick;
    uint8_t   matchState;      // 0=warmup, 1=in-progress, 2=ended
    uint8_t   teamScore[2];
    uint8_t   reserved[10];    // pad to 24-byte snapshot header

    SnapshotPlayer    players[playerCount];
    SnapshotProjectile projectiles[projCount];
    SnapshotFlag      flags[2];
    // Optional trailing per-frame events: kill log, sound triggers, etc.
};
```

**Size estimate (typical mid-match scene, 8 players + 30 active projectiles + 2 flags):**
- Header: 8 + 24 = 32 bytes
- Players: 8 × 32 = 256 bytes
- Projectiles: 30 × 12 = 360 bytes
- Flags: 2 × 8 = 16 bytes
- **Total snapshot: ≈ 664 bytes**

At 10 Hz: **6.64 KB/s downstream per client.**

### 5.3 Delta — incremental update, sent at 30 Hz

```c
struct DeltaEntityHeader {     // 4 bytes
    uint8_t  entityKind;       // 0=player, 1=projectile, 2=flag
    uint8_t  entityId;
    uint16_t fieldMask;        // bit per field that changed (interpretation per kind)
};

struct Delta {
    MsgHeader header;          // type=2
    uint8_t   entityCount;
    uint8_t   reserved[3];
    // entityCount × { DeltaEntityHeader + variable changed-field bytes }
};
```

Field mask interpretation (player, kind=0):
- bit 0 = pos changed (sends 6 bytes posXYZ)
- bit 1 = rot changed (6 bytes rotPYR)
- bit 2 = vel changed (3 bytes velXYZ)
- bit 3 = health changed (1 byte)
- bit 4 = energy changed (1 byte)
- bit 5 = flags changed (1 byte)
- bit 6 = weaponIdx changed (1 byte)
- bit 7 = carryingFlag changed (1 byte)
- bits 8–15 reserved

**Size estimate (typical 30Hz update with movement on 6/8 players, no scoring events):**
- Header: 8 + 4 = 12 bytes
- 6 player updates × (4 header + 9 fields) = 6 × 13 = 78 bytes
- 4 projectile updates × 8 bytes = 32 bytes
- **Total delta: ≈ 122 bytes**

At 30 Hz: **3.66 KB/s downstream per client.**

### 5.4 Combined downstream bandwidth

**Per client: ~10.3 KB/s downstream** (10 Hz snapshot + 30 Hz delta).
**Server upload total at 8 players: ~82 KB/s = 660 Kbps** — trivial for any modern host.
At 100 concurrent matches: 8.2 MB/s = 66 Mbps — well within CF Workers DO budgets.

### 5.5 Client input — 60 Hz upstream

```c
struct ClientInput {           // 12 bytes
    MsgHeader header;          // type=3, tick=clientSeq
    uint16_t  buttons;         // bit per action: fwd, back, left, right, jump, ski, fire, alt-fire, etc.
    int16_t   mouseDX;         // accumulated since last input (radians × 10000)
    int16_t   mouseDY;
    uint16_t  pingMs;          // client's measured RTT (for clock sync)
    uint8_t   weaponSelect;    // 0xFF = no change, else weapon index
    uint8_t   reserved;
};
```

At 60 Hz: **0.72 KB/s upstream per client = 5.8 Kbps**. Negligible.

### 5.6 Lobby and connection messages

Out-of-band, sent over the same WebSocket. Type=4 (lobby).

```c
struct LobbyMsg {
    MsgHeader header;          // type=4
    uint8_t   subType;         // 1=join, 2=joinAck, 3=playerList, 4=matchStart, 5=matchEnd, 6=disconnect
    uint8_t   reserved[3];
    // variable subType-specific payload (e.g. joinAck includes assigned playerId + lobbyId + team)
};
```

---

## 6. Lobby and matchmaking

**Auth model for R19:** anonymous. Each connection is assigned a fresh UUID + a default name `Player_<short-id>`. No accounts, no persistence. Account system is R25+.

**Match-finding flow:**

1. **Quick-match queue (default).** Client connects to `wss://...`, sends `{ subType: 'queue', preferredTeamSize: 8 }`. Server assigns to an open lobby with available slots, or creates a new one.
2. **URL-share friend match.** Client connects with `?lobbyId=ABCD123` query param. Server routes to that specific lobby (creating if it doesn't exist). Lobby creator can share the URL. Lobbies with a custom ID never auto-fill from quick-match queue.
3. **Open lobby browser** (R20+). List of open public matches with player counts. Click to join.

**Lobby lifecycle:**
- Empty lobby auto-destroys after 30s of inactivity.
- Match starts when 4 players have joined (3 + 1 grace timer of 30s).
- Match ends on score limit, time limit, or all players disconnect.
- After match end, all players returned to main menu; lobby remains for 60s for "Play again" (same lobby, full rematch with same players).

**Disconnect handling:**
- Player disconnects mid-match → replaced by a bot at their position, retaining their score/team. Bot uses the R14 AI v2 pathfinding.
- If reconnect happens within 30s and same player UUID, the bot is removed and the player resumes control.
- If 50% or more of human players disconnect, match is voided (no score recorded).

**Lobby capacity:** 8 players per match. CF Workers Durable Object instance is one match. The lobby Worker (separate) holds the queue and routes connections to the correct DO.

---

## 7. Client-side prediction + reconciliation

Standard "Quake 3 style" client prediction. Client runs the same physics loop as the server, applies input immediately (zero perceived input latency), then reconciles when the server snapshot arrives.

```javascript
// CLIENT PREDICTION + RECONCILIATION (~30 lines, well-commented)
//
// Invariants:
//   - state.history is a ring buffer indexed by sequence number
//   - simulate(state, input, dt) is identical to the server's tick function
//   - server snapshots include ackedSeq = the last input the server processed

const HISTORY = new RingBuffer(64);  // ~1s of inputs at 60 Hz
const RECONCILE_THRESHOLD_M = 0.5;   // 0.5m pos divergence triggers rewind
let nextSeq = 0;

function clientFrame(input, dt) {
    const seq = nextSeq++;

    // 1. Send input upstream immediately (60 Hz)
    network.send(packInput({ seq, input, ts: now() }));

    // 2. Apply input locally — zero perceived latency
    state.localPlayer = simulate(state.localPlayer, input, dt);

    // 3. Save to history for later reconciliation
    HISTORY.push({ seq, input, dt, snapshot: clone(state.localPlayer) });

    // 4. Render with predicted state (other players use latest server state, optionally interpolated)
    render(state.localPlayer, state.otherPlayers);
}

function onServerSnapshot(snap) {
    // snap = { tick, ackedSeq, players: { ... }, projectiles: [...], flags: [...] }
    // ackedSeq = last input sequence the server has processed for this client
    state.otherPlayers = snap.players;            // trust server for everyone else
    state.projectiles  = snap.projectiles;
    state.flags        = snap.flags;

    // Reconcile our own player
    const historic = HISTORY.findBySeq(snap.ackedSeq);
    if (!historic) return;                         // history rolled over; nothing to do

    const serverMe = snap.players[localPlayerId];
    const divergence = dist(historic.snapshot.pos, serverMe.pos);

    if (divergence > RECONCILE_THRESHOLD_M) {
        // Rewind: snap to the server's authoritative position at snap.ackedSeq
        state.localPlayer = clone(serverMe);
        // Replay every input that the server hasn't yet processed
        for (const entry of HISTORY.after(snap.ackedSeq)) {
            state.localPlayer = simulate(state.localPlayer, entry.input, entry.dt);
        }
    }

    HISTORY.discardThrough(snap.ackedSeq);         // drop acknowledged history
}
```

**Why this works:** The client always sees its own input applied with zero latency. When the server eventually catches up and tells the client where it actually was, the client either agrees (no visible change) or quietly snaps back and replays — usually invisible because the divergence is small (<0.5m) when ping is reasonable. Visible "rubber-banding" only happens when the client's prediction was significantly wrong (e.g., the server killed them mid-jet).

---

## 8. Lag compensation (server-side hitscan)

For the chaingun (hitscan) and other instant-hit weapons, the server must rewind enemy positions to where the shooter saw them at the time-of-fire. Without this, players who shoot at running enemies miss because the target moved during the round-trip.

**Algorithm:**

1. Server keeps a 200ms ring buffer of past `Player.pos` snapshots, sampled at the 30 Hz tick rate (~6 entries per player).
2. When a client sends a hitscan-fire input, the server estimates the shooter's perceived state:
    `effectiveLatency = min(client.ping / 2, 200ms)`
3. For each potential target, rewind their position by `effectiveLatency`:
    `target.posAtFireTime = ringBuffer.lerp(now() - effectiveLatency)`
4. Perform the raycast against the rewound positions.
5. If hit registers, apply damage at the *current* tick (not the rewound tick).

**Cap:** 200ms is the maximum compensation. Above that, the shooter has effectively been seeing stale state and the engagement is lost. This prevents abuse where high-ping players get unfair advantage.

**Cost:** Minimal. ~6 stored Vec3 per player × 16 players = 1.5KB. Lookup is O(1) ring-buffer index.

---

## 9. Anti-cheat baseline (3 server-side checks)

The server is the source of truth. These three checks catch the most common client-side fabrication attacks at zero per-frame compute cost:

### 9.1 Movement validity
Every input from a client claims an implicit position delta (the result of running `simulate()` with the input). The server runs the same `simulate()` and compares.

```
allowedSpeed = armorMaxSpeed × (skiing ? 2.5 : 1.0) × tolerance(1.3)
maxDeltaPerInput = allowedSpeed × dt
if |claimedPos − authoritativePos| > maxDeltaPerInput:
    flag, snap-back, log
```

This catches: speed hacks, teleport hacks, no-clip.

### 9.2 Aim validity (soft / behavioral)
The server logs hit-rate per player over a rolling 60-second window. Honest humans top out around 30–40% hit-rate on Tribes weapons. Aimbots typically push above 70%.

```
hitRate60s = recentHits / recentShots
if hitRate60s > 0.6 and recentShots > 30:
    flag for review (no auto-action; surface in admin dashboard)
```

This is **soft** detection because legitimate skill can occasionally cross 60% in short bursts. Use it as a signal for human review, not auto-ban.

### 9.3 Rate-limiting per weapon
Each weapon has a server-known cooldown (`fireTime + reloadTime`). Server tracks last-fire-time per player per weapon and rejects fire inputs that arrive too soon.

```
if input.fire and (now − lastFireTime[weapon]) < weapon.cooldown × 0.95:
    drop input, do not advance state, do not emit projectile
```

This catches: rapid-fire macros, weapon-cooldown hacks. The 0.95 tolerance accounts for clock skew.

**Combined cost:** ~1 KB of state per player, no per-frame allocations, all checks O(1). Runs comfortably alongside the simulation.

---

## 10. Scaffold (this commit)

`server/` directory:
- **`server/lobby.ts`** (~100 lines, Bun runtime) — WebSocket server on port 8080. Tracks lobbies in memory. On client connection: assigns fresh UUID, places into open lobby, broadcasts `playerList` to all lobby members. Echoes `hello` join-ack within 1ms.
- **`server/package.json`** — explicit dependency versions (`bun-types ^1.1.0` only).
- **`server/Dockerfile`** — `FROM oven/bun:1.1`, exposes port 8080, single-command deploy to Fly.io / Render.
- **`server/README.md`** — local + deploy instructions.

`client/network.js` (~70 lines):
- ES module, dynamic-imported by `shell.html` when `?multiplayer=local` flag is set.
- Connects to `ws://localhost:8080` (or `wss://...` from query param `?server=...`).
- Sends `{ subType: 'join', name: '...' }` on open.
- Logs all received messages to console + a small debug overlay.
- Async-only: no blocking handlers; never touches the render loop.

**Verification:** load `https://uptuse.github.io/tribes/?multiplayer=local` (with local server running). Console logs `[NET] joined lobby <id> as player <n>` within 1s.

**No game-state networking** in this commit. R19 wires snapshots/deltas/inputs against this scaffold.

---

## 11. R19 implementation plan (forward reference)

When R19 starts, the work is:

1. **Server (TypeScript port of C++ simulation)** — port `simulate()`, weapon firing, bot AI references. ~3 days of tightly-scoped Sonnet work using the C++ source as reference. Constants stay in a shared `constants.json` so client and server agree on weapon stats, armor values, etc.
2. **Snapshot/delta encoding** — implement the wire format from §5 in TypeScript (server) and JavaScript (client). Use `DataView` for binary packing/unpacking.
3. **Client prediction** — wire the §7 pseudocode into the existing JS render loop. `simulate()` is the JS port of the C++ physics tick.
4. **Lag compensation** — §8 algorithm, server-side only.
5. **Anti-cheat** — §9 checks, server-side only.
6. **Lobby integration** — §6 flow on top of the existing scaffold.

Estimated scope: 1 Opus round (R19a, design refinement) + 2-3 Sonnet rounds (R19b, R19c, R19d, implementation). Acceptance criteria for each will be tightly scoped to the matching protocol section.

---

— *Opus 4.7, R16. The architecture is locked. Ship.*
