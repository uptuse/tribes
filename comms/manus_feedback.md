# Manus Feedback — Round 16: Network Architecture (OPUS)

**MODEL:** **OPUS 4.7** (1M context, architectural reasoning round)
**Severity:** Strategic — defines multiplayer protocol for the rest of the project
**Type:** Architecture decision memo + minimal scaffold (no game-state networking yet — that's R19)
**Round 15 status:** Accepted ✓ (Three.js renderer in place behind `?renderer=three` flag)

---

## 1. Why network architecture now (before visuals)

Round 15 built the renderer scaffold; Round 17 will cut Three.js over to default; Round 18 will cash in on Three.js with PBR/models/post-process. Before pouring effort into visuals, the network architecture must be locked in because:

1. **It dictates client-server vs P2P, which affects everything downstream** — anti-cheat, spectator/replay, scaling, cost, mobile support. Picking wrong forces a rewrite at R25+.
2. **Server state structure must align with the C++ simulation now** — if we wait until R19 to think about it, we'll have built bot AI, scoring, match flow, and weapons against a single-process assumption that's hard to factor.
3. **Hosting, signaling, and lobby decisions take real-world time** — Cloudflare Workers/Durable Objects vs Fly.io vs self-hosted have setup latency. Locking the architecture now means R19 can move at full speed.

The C++ simulation is currently **single-process authoritative** — it runs the world for one player + 7 bots, locally in WASM. R19 will move that authoritative simulation to a server (or shared peer), with clients running a **prediction shadow** of the simulation for their local input.

---

## 2. The decision space (Opus must rank and pick)

There are three viable architectures for browser-based real-time multiplayer in 2026. Opus must score them against the criteria in §3 and **pick one** (or a hybrid), with rationale.

### 2.1 Option A: Authoritative server over WebSocket

```
[client]──TCP/WebSocket──→[server]──TCP/WebSocket──→[client]
```

- **Server runs the C++ simulation** (compiled to native, not WASM) at e.g. 30 Hz tick rate. Single source of truth.
- **Clients send inputs** (button press bitfield + mouse delta) at e.g. 60 Hz.
- **Server broadcasts world snapshots** to all clients at the tick rate.
- **Clients run prediction** of their own player based on local input, then reconcile when server snapshot arrives.
- **Transport:** WebSocket (TCP). Reliable, ordered. ~50-150ms RTT depending on geography. Head-of-line blocking is real but tolerable at 30 Hz tick rate.

**Pros:**
- Trivial anti-cheat (server is truth)
- Easy spectator (server already knows all state, can stream a "spectator view")
- Easy match recording (server logs all snapshots → replay file)
- One server hosts many simultaneous matches
- No NAT traversal — every client just connects to a public hostname
- Works through corporate firewalls (port 443/WSS)

**Cons:**
- Hosting cost: $3-30/mo for first region, $3-30 per additional region for low-latency global support
- Server must be written or reused (Node.js wrapping the WASM, or C++ native binary, or Go re-impl). The C++ simulation **can** be reused via Emscripten (Node.js can run WASM), but simpler to compile native.
- Single-region latency disadvantage for users far from the server
- Server is a single point of failure / DDoS target

**Server-host options (Opus rank):**
- **Cloudflare Workers + Durable Objects:** Edge-distributed, $5/mo for hobby, scales globally automatically. Durable Objects model maps cleanly to "one match = one DO". Limit: WebSocket message budget per request, but for 30Hz × 8 players this is fine. **Best fit for this project.**
- **Fly.io:** Multi-region VMs starting $0/mo (free tier covers small games), $1.94/mo per shared CPU instance. Good for native C++ server reuse.
- **Render / Railway:** Single-region but cheap, $0-7/mo.
- **Self-hosted on a VPS (Hetzner/Scaleway):** $4/mo, full control. Worst on geographic distribution but cheapest at scale.

### 2.2 Option B: P2P WebRTC DataChannel with mesh or host-migration

```
[client]──WebRTC DataChannel──↔──[client]
            (UDP-like)
```

- **No central game server.** Clients form a P2P mesh (each connects to each other) or designate a "host" client whose simulation is authoritative.
- **Signaling server** is still needed to bootstrap connections (exchange SDP offers/answers + ICE candidates). A free Cloudflare Worker on Workers KV is sufficient — only used at lobby entry, no per-tick cost.
- **STUN servers** (Google's are free) for NAT traversal. **TURN** server needed as fallback for ~5-10% of users behind symmetric NAT — costs $1-5/mo for a small TURN server, or use Cloudflare's TURN service.
- **DataChannel transport:** SCTP over DTLS over UDP. Can be configured `ordered: false, maxRetransmits: 0` for pure UDP-like behavior — perfect for game state.

**Pros:**
- $0-5/mo total hosting (just signaling + optional TURN)
- Lowest latency (~30-60ms RTT direct between players)
- Server-less — scales infinitely without infrastructure work
- No bottleneck server to DDoS
- Privacy-friendly (no central recording)

**Cons:**
- **Anti-cheat is hard.** Host or peers can forge state. Would need cross-validation between peers (consensus), which is complex and still defeatable.
- **NAT traversal fails for ~5-10% of users.** TURN fallback rescues most but adds latency.
- **Spectator and replay are non-trivial** — no central state to stream; would need one client to volunteer to record.
- **Mesh scales poorly:** N-1 connections per client, O(N²) total bandwidth. For 8 players this is fine (7 conns × ~10KB/s = 70KB/s). For 16 players it's borderline. For 32+ players, host-migration model is required.
- **Browser support quirks:** iOS Safari WebRTC has differences. Firefox has stricter ICE behavior. Needs careful testing.

### 2.3 Option C: Hybrid — server-relayed WebRTC (Geckos.io / Colyseus pattern)

```
[client]──WebRTC DataChannel──→[server]──DataChannel──→[client]
                  (UDP-fast)
```

- **Server is authoritative**, like Option A
- **Transport is WebRTC DataChannel to the server**, not WebSocket. This gives UDP-style behavior (drop packets, no head-of-line blocking) instead of TCP's ordered/reliable behavior.
- **Implementation: Geckos.io** is the canonical library. Wraps the server-side WebRTC complexity. Server runs Node.js (works with our WASM-compiled simulation) or there are Go/Rust ports.
- **Fallback:** If WebRTC handshake fails (rare, ~2% of clients), drop to WebSocket transparently.

**Pros:**
- All Option A pros (anti-cheat, spectator, recording, scaling)
- ~30% lower latency than Option A (no TCP retransmit pile-up)
- Server hostable on same platforms as Option A
- Geckos.io is mature (~2018, 1.5k stars, used in production)

**Cons:**
- Slightly more complex server setup (~1 day vs 1 hour for plain WebSocket)
- WebRTC server library quality varies — Geckos.io is solid; alternatives (Colyseus + raw WebRTC plugin) are rougher
- Same NAT/TURN concerns as Option B for the client→server WebRTC, though server has public IP so traversal is much easier than P2P

---

## 3. Decision criteria — Opus must score 1-5 (1=worst, 5=best)

| Criterion | Weight | A: Server-WS | B: P2P-WebRTC | C: Hybrid-WebRTC |
|---|---|---|---|---|
| **Latency (East Coast US user)** | 3 | 3 (50-100ms) | **5 (30-60ms)** | 4 (40-80ms) |
| **Latency (cross-Pacific user)** | 2 | 2 (180-250ms) | **4 (80-150ms)** | 3 (140-200ms) |
| **Anti-cheat resistance** | 5 | **5** | 1 | **5** |
| **Spectator / replay support** | 3 | **5** | 1 | **5** |
| **Hosting cost ($/mo at 100 concurrent)** | 4 | 3 ($5-30) | **5 ($0-5)** | 3 ($5-30) |
| **Implementation complexity** | 4 | **5** (simplest) | 2 | 3 |
| **Browser compat (Chrome/FF/Safari/Edge)** | 4 | **5** | 3 | 4 |
| **Mobile / iOS Safari** | 2 | **5** | 3 | 4 |
| **Scaling to 32+ players per match** | 1 | **5** | 1 | **5** |
| **Future WebGPU/HTTP3 path** | 1 | 4 | 5 | **5** |

Opus computes weighted sum and picks. If two are within 10%, Opus picks based on Manus's stated priority: **anti-cheat + spectator/replay matter most for this project's long-term life as a competitive game**, so weight #3 and #4 heavily.

**Manus's expected outcome:** Option C (hybrid) wins narrowly over A; B is a poor fit because anti-cheat and spectator are critical. But Opus may disagree based on factors Manus didn't see — accept whatever Opus chooses as long as the rationale is sound.

---

## 4. Architectural deliverables (regardless of choice)

Once Opus picks an architecture, produce the following in this round:

### 4.1 Decision memo
A 200-400 word section in `comms/network_architecture.md` (new file) explaining:
- Which option was chosen
- The weighted score table
- Why this beats the others for *this specific project* (not generic)
- Fallback path if the chosen architecture hits a wall in implementation

### 4.2 Snapshot / delta protocol design
The wire format for server → client world updates. Specifically:
- **Snapshot structure** — full state, sent at e.g. 10 Hz. Format: binary, packed. Estimate byte size for 8 players + 200 projectiles + 2 flags.
- **Delta structure** — per-tick changes from prior snapshot, sent at 30 Hz. Format: bitmask of changed fields + new values. Estimate byte size.
- **Client-input structure** — per-tick from client → server. Format: button bitfield (2 bytes) + mouse delta (4 bytes) + sequence number (2 bytes) + timestamp (4 bytes).

Provide the C struct definitions Opus expects for each.

### 4.3 Lobby and matchmaking design
- How does a player find a match? (Open lobby browser? Quick-match queue? Friend-link URL?)
- How are 8 players assembled into a match? (First-come-first-served? Skill-based?)
- What happens when a player disconnects? (Bot replaces? Match continues short-handed?)
- What is the auth model? (Anonymous? Username? Account?)

For R16, **anonymous + URL-share quick-match** is sufficient. Account system can come in R25+. Spec it that way.

### 4.4 Client-side prediction & reconciliation pseudocode
Standard "Quake 3 style" prediction:
1. Client sends input + sequence number to server
2. Client immediately applies input to local prediction shadow
3. Server processes input, advances authoritative state, broadcasts snapshot+ack of last sequence
4. Client receives snapshot, finds the prediction state at that sequence, compares
5. If divergence > threshold, client re-runs all inputs from that sequence forward against the authoritative state (rewind + replay)

Provide pseudocode (~30 lines) for the client reconciliation loop.

### 4.5 Lag compensation
For weapons (especially the chaingun and disc launcher), the server must rewind enemies to where the shooter saw them at the time-of-fire. Spec the algorithm: server keeps a 200ms ringbuffer of past Player positions; on hitscan, rewind enemies by `clientLatency` (capped at 200ms) before raycast.

### 4.6 Anti-cheat baseline
Three things the server must validate (cheaply, without per-frame heavy compute):
- **Movement validity:** client-claimed position must be reachable from prior position within `dt × maxSpeed × tolerance` (e.g., 1.3×). Reject + snap-back if violated.
- **Aim validity (soft):** server logs hit-rate per player; flags players with > 60% hit-rate over a 60s window for review (humans top out around 30-40%).
- **Rate-limiting:** clients can't fire weapons faster than the weapon's cooldown allows.

### 4.7 Scaffold code (minimal)
- A new directory: `server/` containing a stub Node.js/Bun/Deno server (Opus picks runtime — likely **Bun** for speed and built-in WebSocket/WebRTC support, or **Deno** for stability)
- A new file: `server/lobby.ts` — listens on port 8080, tracks lobbies in memory, accepts WebSocket/WebRTC connections, echoes a "hello you are client N in lobby M" message back
- A new file: `client/network.js` — connects to `ws://localhost:8080` (or `wss://...` for prod), sends a join message, logs any received messages
- A new query flag: `?multiplayer=local` adds the network client and connects to localhost; without flag, single-player C++ continues unchanged
- **No game state networking yet.** That's R19. R16 just proves the connection plumbing works.

### 4.8 Build / deploy scripts
- A `server/package.json` (or equivalent for Bun/Deno) with start command
- A `server/Dockerfile` for one-command deploy to Fly.io / Cloudflare Workers / Railway
- A `server/README.md` explaining how to run locally and deploy

---

## 5. Acceptance criteria (must hit 7 of 9)

1. ✅ `comms/network_architecture.md` exists with chosen architecture, scored decision matrix, and rationale (200-400 words)
2. ✅ Wire-format C structs documented for snapshot, delta, and client-input
3. ✅ Estimated bandwidth: snapshot bytes × 10 Hz + delta bytes × 30 Hz, with rough math (e.g., "8 players × 20 bytes/snapshot × 10 Hz = 1.6 KB/s")
4. ✅ Lobby + matchmaking design documented (200+ words)
5. ✅ Client-prediction reconciliation pseudocode present (~30 lines, commented)
6. ✅ Lag-compensation algorithm specified
7. ✅ Anti-cheat baseline (3 server-side checks) documented
8. ✅ `server/` scaffold runs locally — `cd server && bun run start` (or equivalent) listens on a port and accepts connections
9. ✅ `client/network.js` connects to `?multiplayer=local`, console-logs round-trip "hello" within 1s

Bonus:
- B1. Server scaffold deployed to a free-tier hosting provider (Cloudflare/Fly/Railway) at a public URL, verified by Opus or Manus loading the live `?multiplayer=remote` flag
- B2. WebRTC DataChannel handshake verified working (not just WebSocket fallback)
- B3. CI workflow stub for server (lint + unit test on PR)

---

## 6. Compile/grep guardrails

- `! grep -nE 'EM_ASM[^(]*\(.*\$1[6-9]'` must pass (legacy)
- New: server directory must have a `package.json` or `deno.json` with explicit dependency versions
- New: server must NOT use `eval`, `Function()` constructor, or load remote code at runtime (security)
- New: client `network.js` must NOT block the render loop — all WebSocket/WebRTC handlers async, message dispatch via `requestAnimationFrame` or microtask queue

---

## 7. Things explicitly NOT in this round

- Actually networking the game state (R19)
- Spectator client mode (R20+)
- Match recording / replay (R20+)
- Account system, persistent accounts (R25+)
- Matchmaking based on skill (R25+)
- Voice chat (out of scope for now)

---

## 8. Time budget

This is a 2-3 hour Opus round. Most of the time is in the architecture decision memo + snapshot/delta protocol design — the scaffold code is lightweight (~100 lines server, ~50 lines client).

Suggested split:
- Read-up + decision memo: ~30 min
- Wire format + bandwidth math: ~20 min
- Lobby + matchmaking + auth: ~20 min
- Prediction + reconciliation pseudocode: ~30 min
- Lag compensation + anti-cheat baseline: ~20 min
- Server + client scaffold code: ~30 min
- Build/deploy script + README: ~20 min

---

## 9. Decision authority for ambiguities

- **Runtime choice (Bun vs Deno vs Node):** Bun preferred for speed + built-in WebSocket; Deno acceptable for stability; avoid Node unless other two have a blocker
- **Hosting choice:** Cloudflare Workers + Durable Objects strongly preferred for global edge + cost; Fly.io fine; avoid AWS/GCP/Azure (operational overhead)
- **Authoritative tick rate:** 30 Hz default; spec-out the option to drop to 20 Hz for cost or raise to 60 Hz for premium-tier matches
- **Snapshot interval:** 10 Hz default (every 3rd tick at 30 Hz); delta updates fill the gaps
- **TURN server:** start with a public TURN provider (Cloudflare's $0.05/GB) rather than self-hosted — easier to reason about; can self-host later if costs blow up
- **Library use:** prefer **Geckos.io** for the server WebRTC layer if Option C wins; raw `ws` package for plain WebSocket; avoid Colyseus (heavier, opinionated)

---

## 10. Roadmap context

- **R15 (just landed, OPUS):** Three.js renderer architecture
- **R16 (this round, OPUS):** Network architecture + scaffold
- **R17 (Sonnet):** Three.js cutover — make Three.js the default renderer
- **R18 (Sonnet):** Visual quality cascade — PBR, real models, shadows, post-process
- **R19 (Sonnet):** Network implementation per R16 spec — wire game state, prediction, reconciliation, lag-comp, anti-cheat checks
- **R20+ (Sonnet):** Polish, spectator mode, matchmaking improvements, content
