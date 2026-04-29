# Phase 3c — Adversarial Convergence Review: Networking Stack (Run 1)

**Target:** `client/network.js` (331 lines) + `client/wire.js` (254 lines) + `client/prediction.js` (140 lines) — 725 lines total  
**Date:** 2026-04-29  
**Panel:** Glenn Fiedler (netcode/prediction/state sync), John Carmack (engine arch/perf/FPS netcode), Casey Muratori (simplicity/data flow), Mike Acton (data-oriented design/module boundaries)

---

## Module Overview

The networking stack comprises three tightly coupled files:

| File | Lines | Role |
|---|---|---|
| `network.js` | 331 | WebSocket connection, lobby JSON control messages, 60Hz input send loop, bandwidth telemetry, voice-chat plumbing |
| `wire.js` | 254 | Binary encode/decode for snapshot, delta, and input messages. Quantization via `quant.js`. |
| `prediction.js` | 140 | Client-side prediction state, server reconciliation, smooth correction interpolation |

**Dependencies:**
- `wire.js` imports from `quant.js` (quantization math) and `constants.js` (message type IDs, struct sizes)
- `prediction.js` imports from `constants.js` (thresholds, history depth)
- `network.js` imports from `wire.js`, `prediction.js`, `constants.js`, and `voice.js`
- `network.js` writes 10+ `window.__voice*` globals to bridge voice module to non-module shell

---

## Pass 1 — Break It

### The Saboteur — Race Conditions & Edge Cases

**S-1 · Ping Interval Leak on Reconnect (HIGH)**  
`network.js` line ~182: `setInterval(() => { ... send ping ... }, 2000)` is called inside `start()` but the interval ID is **never stored and never cleared**. If the socket closes and `start()` is called again for reconnection, a new interval is created while the old one still fires. After N reconnect cycles, N+1 ping intervals are hammering a potentially-dead socket. Each fires `socket.send()` on a null or CLOSING socket — caught by the try/catch, but the intervals accumulate forever. Memory leak + pointless CPU work.

**Fix:** Store the interval ID; clear it in `socket.onclose`.

**S-2 · Input Loop Double-Start Race (MEDIUM)**  
`startInputLoop()` (line ~196) guards against double-start with `if (inputLoop) return;`. But `matchStart` is dispatched for every player in the lobby. If the server sends multiple `matchStart` messages (reconnect scenario, or server bug), the guard holds. However, `stopInputLoop()` in `onclose` sets `inputLoop = null`, and a subsequent `matchStart` message arriving on a *new* socket (reconnected) will start a new loop — which is correct. **But:** if `matchStart` arrives before the old socket's `onclose` fires (race between WebSocket events), the old loop is still running and the new `matchStart` doesn't start a second one. Then when the old `onclose` fires, it nulls `inputLoop` and clears the old interval — but the ID stored in `inputLoop` is the *old* ID, so the `clearInterval` works. Net result: brief window of no input loop between onclose clearing the old one and the next matchStart. Low-probability but real.

**S-3 · `decodeDelta` Mutates Input Buffer (CRITICAL)**  
`wire.js` line ~210: `decodeDelta()` temporarily overwrites byte 0 of the input `Uint8Array`:
```js
const tmp = new Uint8Array(buf);
tmp[0] = MSG_SNAPSHOT;      // mutate!
const decoded = decodeSnapshot(tmp);
tmp[0] = MSG_DELTA;         // restore
```
If `buf` is a view over the WebSocket's `ArrayBuffer` (which it is — `new Uint8Array(data)` from an `ArrayBuffer` creates a view, not a copy), this mutates the original message buffer. In current single-threaded JS this is "safe" because nothing else reads the buffer between mutate and restore. But this is **fragile by design**: if any future code adds an `await` or if the buffer is shared with a Worker (SharedArrayBuffer), this is a data corruption bug. It also violates the function's own contract: "every decode* function returns null on malformed input" — it doesn't promise to *mutate* the input.

**Fix:** Copy the byte, set it, decode, then don't bother restoring. Or better: make `decodeSnapshot` accept the type as a parameter so no mutation is needed.

**S-4 · `trackInbound` String Length ≠ Byte Count (LOW)**  
`network.js` line ~86: For JSON string messages, `trackInbound(typeof data === 'string' ? data.length : 0)` counts *characters*, not bytes. UTF-8 multi-byte characters (player names with unicode) will undercount. For bandwidth telemetry this is a cosmetic issue, but the metric label says "bytesIn" — it lies.

**S-5 · No Maximum on `onMessageHandlers` Array (LOW)**  
`network.js` `onMessage()` pushes handlers and returns an unsubscribe closure. If a caller forgets to unsubscribe (leaks the closure), handlers accumulate. No cap, no warning. With hot-reload during development this can silently multiply handlers.

### The Wiring Inspector — API Mismatches & Stale State

**W-1 · `prediction.reconcile()` is Defined but Never Called (CRITICAL)**  
`prediction.js` exports `reconcile(snapshot, getLocalPlayerWasm)` — a carefully designed function that compares server state with local WASM state and sets up smooth corrections. But **nowhere in network.js or any other file is `prediction.reconcile()` called**.

In `network.js` line ~107, when a snapshot arrives:
```js
if (window.__tribesReconcile) window.__tribesReconcile(snap);
```
This calls a `window.__tribesReconcile` callback — which is set by the *renderer*, not by prediction.js. The prediction module's `reconcile()` function sits unused. This means:
- `prediction.recordInput()` records inputs that nothing ever replays
- `prediction.applyPendingCorrection()` is never called (smoothCorrection stays null)
- `prediction.stats.reconciliations` is always 0
- The entire prediction.js module is **dead code** in the current wiring

The `getStatus()` function in network.js reports `prediction.stats.reconciliations` and `prediction.stats.avgDivergence` — always 0 and 0.000. Anyone reading telemetry thinks prediction is "perfect" when it's actually disconnected.

**W-2 · `prediction.nextTick()` is a Monotonic Counter, Not a Server Tick (HIGH)**  
`prediction.js` line ~30: `nextTick()` returns `nextClientTick++` — a simple incrementing counter starting from 0. The input loop in `network.js` uses this as the tick field in the input message:
```js
const tick = prediction.nextTick();
```
But the server snapshots contain `snapshot.tick` — the *server's* tick counter, which starts at some arbitrary value and increments at 30Hz. The client tick runs at 60Hz. These two counters are completely unrelated. The `inputHistory` in prediction.js stores client ticks, but `reconcile()` would need to match them to server ticks to know which inputs have been acknowledged. There's no tick mapping anywhere. Even if `reconcile()` were wired up, it couldn't correlate inputs with snapshots.

**W-3 · `latestSnapshot` Exposed but Never Consumed (MEDIUM)**  
`network.js` exports `getLatestSnapshot()` which returns the last decoded snapshot. But searching the codebase, no module calls `getLatestSnapshot()`. It's dead API.

**W-4 · `prediction.reset()` Resets `nextClientTick` to 0 (MEDIUM)**  
`prediction.reset()` (called on socket close) resets `nextClientTick = 0`. If the player reconnects to the same match, input ticks restart from 0 while the server's tick counter is thousands of ticks ahead. The server's input buffer keys on tick number — restarting the client counter could cause the server to discard inputs as "from the past" or misorder them.

**W-5 · Voice Module Globals Bypass ES Module System (MEDIUM)**  
`network.js` lines 5-16: Ten `window.__voice*` globals bridge the voice module to the non-module shell:
```js
window.__voiceUpdatePeer = voice.updatePeerPosition;
window.__voiceRegisterUuid = voice.registerPeerUuid;
// ... 8 more
```
This is the exact anti-pattern the audit plan flags. The voice module is an ES module — these globals exist solely because shell.html can't `import` from ES modules. They should be consolidated into a single `window.__voice` namespace object rather than 10 individual globals.

### The Cartographer — Data Model Gaps

**C-1 · No Connection State Machine (HIGH)**  
`network.js` has implicit states: disconnected (socket=null), connecting (socket exists, readyState=CONNECTING), connected-prelobby (OPEN, no joinAck), in-lobby (joinAck received, no match), in-match (matchStart received), reconnecting. These states are spread across 5 variables (`socket`, `myPlayerId`, `myNumericId`, `myLobbyId`, `telemetry.inMatch`) with no formal state machine. There's no `getConnectionState()` — external code must guess by checking multiple fields.

**C-2 · Flag Z-Coordinate Lost in Wire Format (MEDIUM)**  
`wire.js` flag encoding (line ~136): the comment admits "posZ is approximated" because SIZE_FLAG is 8 bytes and there's no room. Flag Z is hardcoded to 0 on decode. For a game with skiing on hilly terrain, a flag at Y=0 is wrong — it'll render underground or floating. The comment says "R20 may extend to 10 bytes" but this is still unfixed.

**C-3 · No Sequence Numbers on Snapshots/Deltas (HIGH)**  
The wire format has a `tick` field but no sequence number. If packets arrive out of order (not possible with TCP/WebSocket but possible with future UDP migration), there's no way to detect or reorder. More importantly, there's no way for the client to know how many snapshots it *missed* between two consecutive ones — which is essential for delta decompression and jitter buffer sizing.

**C-4 · Delta is Just a Re-Typed Snapshot (HIGH)**  
`wire.js` `encodeDelta()` (line ~208) literally calls `encodeSnapshot()` and overwrites byte 0 with MSG_DELTA. `decodeDelta()` does the reverse. There is zero bandwidth savings from deltas — they're full snapshots at a different rate. The architecture doc says "10Hz snapshots, 30Hz deltas" but the "deltas" send the same full state. With 64 players × 32 bytes/player + projectiles + flags, each "delta" is ~2.1KB. At 30Hz that's 63KB/s per client — the architecture doc estimates 190KB/s. This works for 2-player testing but won't scale to 64 players without real delta compression.

**C-5 · No Disconnect/Timeout Detection (MEDIUM)**  
There's no heartbeat or timeout logic. If the server stops sending data but the WebSocket stays open (half-open connection), the client will sit silently with stale game state forever. The `lastMessageAt` timestamp is tracked but never checked against a timeout threshold.

---

## Pass 2 — Challenge Architecture (Independent Expert Reviews)

### Glenn Fiedler — Netcode Architecture

**GF-1 · Prediction Model is Fundamentally Disconnected (CRITICAL)**  
The prediction.js module implements a textbook reconciliation pattern — record inputs, compare server state, smooth corrections. But it's not wired into anything. The *actual* prediction is done by the local WASM engine: C++ runs physics locally, producing predicted positions. The renderer reads these positions directly from HEAPF32. When a server snapshot arrives, `window.__tribesReconcile` (set by the renderer) does... something. But prediction.js's `reconcile()` is never called.

This tells me the architecture is confused about *who owns prediction*:
- WASM runs local physics → that's implicit prediction
- prediction.js records inputs → that's preparation for server reconciliation
- window.__tribesReconcile → that's a renderer callback, not a prediction callback

For proper FPS netcode, the flow should be:
1. Client sends input with tick number
2. Client locally simulates that input (WASM does this)
3. Server processes input, sends authoritative state tagged with the last-processed client tick
4. Client finds that tick in its input history, compares, and replays unacknowledged inputs

Step 3 requires the server to echo back the `lastProcessedClientTick`. The current snapshot format has no such field. Step 4 requires the client to re-simulate inputs — but the C++ simulation can't be "rewound" from JS. The entire reconciliation model is a dead-end without WASM-side replay support.

**GF-2 · 60Hz Input on WebSocket is Wasteful (HIGH)**  
`INPUT_HZ = 60` means the client sends 60 input packets per second over a WebSocket (TCP). Each input is 20 bytes + WebSocket framing (~6 bytes) + TCP overhead. At 60Hz that's ~1,560 bytes/s minimum, plus TCP's per-packet overhead is disproportionate for 20-byte payloads. The server physics runs at 30Hz — half the inputs arrive between ticks and must be buffered or sampled.

Standard FPS netcode sends inputs at the server tick rate (30Hz) or slightly higher, with input redundancy (last N inputs per packet) to handle packet loss. Sending at 2× server tick rate with no redundancy is the worst of both worlds: high bandwidth, no loss resilience.

**GF-3 · No Input Redundancy (HIGH)**  
Each input packet contains exactly one tick's worth of input. On packet loss (irrelevant for TCP/WebSocket but critical for any future UDP migration), that input is gone. Standard practice: each client packet includes the last 3-5 inputs so the server can recover from drops without a round-trip delay.

**GF-4 · No Jitter Buffer (MEDIUM)**  
Server snapshots arrive at 10Hz (every 100ms). There's no jitter buffer — snapshots are applied immediately on receipt. Network jitter means snapshots arrive at irregular intervals (80ms, 120ms, 90ms...). Without a jitter buffer, the visual interpolation between snapshots will stutter. The current code doesn't even *interpolate* between snapshots for remote players — it snaps to the latest state.

**GF-5 · No Entity Interpolation for Remote Players (CRITICAL)**  
Remote player positions come from server snapshots at 10Hz. Between snapshots, remote players are... frozen. There's no interpolation between the last two snapshots to smooth movement. In a 60fps game, a remote player updates position 10 times per second and stays still for the other 50 frames. This produces extremely choppy remote player movement — unacceptable for a competitive FPS.

The system map confirms this: `renderer.js` reads player positions from WASM HEAPF32, which is updated by `window.__tribesReconcile`. But there's no interpolation layer between "server sent position X at tick T" and "renderer reads position for frame F."

### John Carmack — Engine Architecture & FPS Netcode

**JC-1 · Wrong Transport for a Competitive FPS (HIGH)**  
WebSocket over TCP is fundamentally wrong for real-time game state. TCP's head-of-line blocking means a single dropped packet stalls all subsequent packets until the retransmission completes — exactly the worst behavior for a game that needs the *latest* state, not *every* state in order. Old snapshots are useless; you want the newest one immediately.

For a browser game, WebRTC DataChannel (unreliable mode) is the correct transport for game state. It gives you UDP semantics in the browser. WebSocket is fine for the lobby/control channel — but game state (snapshots, deltas, inputs) should flow over an unreliable channel.

That said, WebSocket is a valid *starting point* for getting the protocol working. Just know that the scaling wall is transport, not protocol.

**JC-2 · Snapshot Bandwidth Doesn't Scale to 64 Players (HIGH)**  
Current wire format: 8B header + 24B snap header + N×32B players + M×12B projectiles + 2×8B flags.
With 64 players and ~20 projectiles: 8 + 24 + 64×32 + 20×12 + 16 = 2,336 bytes per snapshot.
At 10Hz snapshots + 30Hz "deltas" (which are full snapshots): 40 packets/s × 2.3KB = 92KB/s per client.
With 64 clients: 5.9MB/s outbound from server.

This is manageable for a dedicated server but brutal for a Cloudflare Worker. And it scales O(N²) — every player sends state to every other player via the server. Real delta compression (only changed fields) would cut this by 60-80% since most players don't change every field every tick.

**JC-3 · The telemetry Object is Kitchen-Sink State (MEDIUM)**  
`telemetry` in network.js mixes bandwidth metrics (`bytesIn`, `bytesInWindow`), match state (`matchActive`, `inMatch`), skill rating (`skillRating`, `matchesPlayed`, `ranked`), and timing (`pingMs`, `lastPingSent`). Skill ratings have nothing to do with network telemetry — they were bolted on because `telemetry` was a convenient place to stash per-connection state. This object should be split: network metrics belong here, player profile state belongs elsewhere.

**JC-4 · Ping Measurement is Wrong (MEDIUM)**  
`network.js` line ~187: ping is measured as `msg.serverTs - msg.clientTs`. The client sends `clientTs: Date.now()`, the server echoes it back with `serverTs`. If `serverTs` is the *server's* timestamp when it received the ping, then `serverTs - clientTs` measures one-way latency + clock skew (client and server clocks are not synced). If `serverTs` is the client's original timestamp echoed back, then it's just the field name that's wrong. Either way, proper RTT is `Date.now() - msg.clientTs` (current time minus the time we sent the ping). The current formula is either measuring the wrong thing or depending on server clock accuracy.

**JC-5 · `send()` Accepts Both Strings and Objects (LOW)**  
`network.js` `send()` does `typeof msg === 'string' ? msg : JSON.stringify(msg)`. This dual-mode API means callers can accidentally double-serialize (pass a JSON string that gets sent as-is) or pass something that's not JSON-serializable. Single type, single behavior.

### Casey Muratori — Simplicity & Data Flow

**CM-1 · prediction.js Solves a Problem It's Not Connected To (CRITICAL)**  
I'm going to be blunt: prediction.js is 140 lines of dead code. Not "mostly dead" — completely disconnected. `reconcile()` is never called. `applyPendingCorrection()` is never called. `recordInput()` records inputs into a buffer that nothing reads. The `stats` object always reads zero.

The file was clearly written with the *intent* of doing client prediction reconciliation, but the actual prediction is done by the WASM engine running locally. The WASM engine IS the prediction — it runs the same physics the server will run, producing positions that the renderer displays immediately. That's implicit prediction.

What's missing is the *reconciliation* half: when the server says "actually you were at position X at tick T," the client needs to snap/blend to that position. This is currently handled by `window.__tribesReconcile` in the renderer — which does... what exactly? The audit needs to trace that callback.

prediction.js should either be wired in properly (requiring WASM-side changes to support replay) or deleted. 140 lines of code that creates the *illusion* of prediction without doing anything is worse than no prediction code at all, because it misleads future developers.

**CM-2 · The Voice Global Bridge is a Code Smell (MEDIUM)**  
Lines 5-16 of network.js exist solely to bridge voice.js to shell.html. That's 12 lines of `window.__voice*` assignments that have nothing to do with networking. This should be in voice.js itself or in a dedicated voice-bridge module. network.js shouldn't know or care about the voice module's global surface.

**CM-3 · `decodeSnapshot` Does Too Much Allocation (MEDIUM)**  
Every snapshot decode (10-40 times per second) allocates: 1 header object, 1 snap result object, N player objects (each with 3 arrays for pos/rot/vel), M projectile objects (each with 1 array), 2 flag objects (each with 1 array). For 64 players that's 64×4 = 256 small array allocations per decode, 10-40 times per second = 2,560-10,240 allocations/second. These are all short-lived and will pressure the garbage collector.

For a high-performance path, you'd decode into pre-allocated typed arrays and index them by stride — the same pattern WASM uses for player state. The current "decode into fresh JS objects" approach is clean but won't survive 64-player stress testing without GC hitches.

**CM-4 · Wire Format Has No Version Field (MEDIUM)**  
The 8-byte header has: type (1B), flags (1B), payloadLen (2B), tick (4B). No version field. When the wire format changes (and it will — flag Z coordinate, delta compression, input redundancy), there's no way to detect version mismatch between client and server. The `flags` byte is unused (always 0) and could serve as a version field.

### Mike Acton — Data Layout & Module Boundaries

**MA-1 · Decode Path Creates Object Graphs Instead of Flat Arrays (HIGH)**  
The decode path in wire.js converts a tight binary buffer into a graph of JS objects:
```js
players.push({
    id: ..., alive: ..., pos: [x, y, z], rot: [x, y, z], vel: [x, y, z], ...
});
```
This is a textbook data-oriented design violation. The binary format is *already* SoA-adjacent (all player data packed sequentially). The decode should produce flat typed arrays: `positions: Float32Array(N*3)`, `rotations: Float32Array(N*3)`, `velocities: Float32Array(N*3)`, `flags: Uint8Array(N)`, etc. The renderer already reads flat arrays from WASM HEAPF32 — the networking path should speak the same data language.

Object-per-player means: N allocations, N×3 array allocations for pos/rot/vel, scattered memory layout hostile to CPU cache, and GC pressure every frame. Flat arrays mean: 3-4 allocations total (reusable), linear memory access, and zero GC pressure.

**MA-2 · network.js Mixes Four Responsibilities (HIGH)**  
The file handles:
1. **Connection management** (WebSocket lifecycle, URL construction, reconnect)
2. **Protocol dispatch** (JSON message routing, binary type switching)
3. **Input pipeline** (60Hz loop, input encoding, send)
4. **Telemetry** (bandwidth tracking, ping, skill rating)

These should be four modules. The input loop doesn't need to know about lobby messages. Telemetry doesn't need to know about voice globals. The current structure means any change to one concern risks the others.

**MA-3 · The `inputProvider` Callback Allocates Per-Call (MEDIUM)**  
`inputProvider()` returns a fresh `{buttons, mouseDX, mouseDY, weaponSelect}` object 60 times per second. The input loop then creates *another* object:
```js
const input = { tick, buttons: raw.buttons | 0, ... };
```
That's 120 object allocations per second on the input path. Use a reusable buffer: write fields into a pre-allocated object instead of creating new ones.

**MA-4 · `bytesInWindow`/`bytesOutWindow` Are Unbounded Sliding Windows (LOW)**  
`trackInbound`/`trackOutbound` push `{ts, bytes}` objects and shift out entries older than 1 second. Under heavy traffic (64-player snapshots at 30Hz), these arrays hold ~30-40 entries and shift on every call. `Array.shift()` is O(n) — for 40 entries this is trivial, but the pattern is wrong. A ring buffer (fixed-size array with head/tail indices) would be O(1) and zero-allocation.

---

## Pass 3 — Debate to Consensus

*The four experts review each other's findings and debate actionable fixes.*

### Debate 1: What to Do About prediction.js

**Fiedler:** prediction.js implements the *shape* of client-side prediction reconciliation, but it's disconnected from reality. The WASM engine does implicit prediction by running physics locally. The missing piece is server-authoritative reconciliation — and that requires the server to echo back `lastProcessedClientTick` so the client knows which inputs are acknowledged.

**Carmack:** Agreed. But there's a deeper question: can the C++ simulation be rewound? Proper reconciliation means "snap to server state at tick T, then replay inputs T+1 through T+N." If the C++ engine can't checkpoint and restore state, you can't do replay-based reconciliation. You'd need a different approach — smooth blend toward server state, which is what prediction.js's `smoothCorrection` actually does.

**Muratori:** The smooth blend approach is fine for casual play. Quake 3 used prediction + reconciliation. But Tribes is skiing at 200+ km/h — the divergence between client and server will be measured in *meters* per frame at those speeds. A 200ms smooth blend over a 3-meter correction is going to feel like rubber-banding.

**Acton:** Before we design the ideal prediction system, can we acknowledge that prediction.js is currently dead code? The immediate action is: either wire it in (calling `reconcile()` from the snapshot handler and `applyPendingCorrection()` from the render loop) or delete it and document what the replacement should look like.

**Fiedler:** Wire it in. Even if the reconciliation isn't perfect, having the divergence *measured* (stats.avgDivergence) gives us data. Right now we're flying blind — telemetry says "0.000 divergence" because the measurement code is disconnected.

**Consensus:** Wire prediction.reconcile() into the snapshot handler. Wire applyPendingCorrection() into the render loop. Add `lastProcessedClientTick` to the snapshot header for future proper reconciliation. Don't delete prediction.js — activate it.

### Debate 2: Delta Compression — When?

**Carmack:** The delta "compression" is a lie — it's a full snapshot with a different type byte. For 2-player testing this is fine. For 64 players it's a scaling wall. But implementing proper delta compression (bitfield of changed fields per player) is a significant engineering effort that blocks on having a stable wire format.

**Fiedler:** Agreed. Don't implement delta compression until the wire format is stable. But *plan* for it: the `flags` byte in the header should be reserved for "this is a delta relative to snapshot with tick T" semantics. And the snapshot should include a sequence number so the client knows which base snapshot the delta refers to.

**Acton:** The more impactful optimization is: don't send data for players that haven't changed. If 40 of 64 players are dead or stationary, skip them entirely. A presence bitmask (8 bytes for 64 players) plus only the changed players' data cuts bandwidth dramatically with minimal protocol change.

**Muratori:** Both good ideas, but let's not premature-optimize the wire format before we have 64 players to test with. The immediate fix is: use the `flags` byte for a format version, and document the delta compression plan in the architecture doc so we don't paint ourselves into a corner.

**Consensus:** Don't implement delta compression now. Use flags byte bit 0 as format version. Document the delta roadmap. Consider player-presence bitmask as first optimization step.

### Debate 3: Transport — WebSocket vs WebRTC DataChannel

**Carmack:** TCP head-of-line blocking is the fundamental problem with WebSocket for game state. A single dropped packet freezes *all* game state delivery until retransmission. At 50ms RTT, a dropped packet adds 50-100ms of latency to every subsequent packet in the buffer. For a game where players ski at 60+ m/s, that's 3-6 meters of positional error from a single packet drop.

**Fiedler:** WebRTC DataChannel in unreliable mode gives you UDP semantics in the browser. The signaling complexity is real but manageable — you already have WebRTC infrastructure for voice chat. The game state channel could piggyback on the same signaling path.

**Muratori:** The voice.js module already does WebRTC peer connections. The infrastructure exists. But migrating game state from WebSocket to WebRTC DataChannel is a large change that touches the server. Don't do it in the audit — flag it as the transport evolution path.

**Acton:** And when you do migrate, the unreliable channel means you MUST have sequence numbers and handle out-of-order delivery. The current protocol assumes in-order delivery (no sequence numbers). That's another reason to add sequence numbers now even while on WebSocket — it's forward-compatible with UDP.

**Consensus:** Keep WebSocket for now. Add sequence numbers to snapshots. Document WebRTC DataChannel as the transport evolution. The voice.js WebRTC infrastructure can be reused for game state channels.

### Debate 4: Input Rate — 60Hz vs 30Hz

**Fiedler:** 60Hz input over TCP is pointless. The server ticks at 30Hz — inputs arriving between server ticks are buffered. You're doubling bandwidth for zero gameplay benefit. Send at 30Hz with the last 3 inputs (90 bytes per packet, 30 times/s = 2.7KB/s) instead of 20 bytes 60 times/s = 1.2KB/s. Slightly more bandwidth but you get loss resilience.

**Carmack:** For local prediction, the client *does* want 60Hz input application — the WASM physics runs at the render frame rate. But the *sending* should be decoupled from the local simulation rate. Batch local inputs and send at server tick rate.

**Muratori:** The simplest fix: INPUT_HZ stays at 60 for local simulation, but the send loop runs at TICK_HZ (30). Each send includes the last 2 inputs (covering 33ms, one server tick interval).

**Consensus:** Decouple local input application from network send rate. Send at TICK_HZ with 2-3 input redundancy per packet.

### Debate 5: Smooth Correction — 200ms Blend vs Snap

**Fiedler:** 200ms smooth correction (PRED_SMOOTH_CORRECT_MS) is aggressive for a fast-paced game. At 60 m/s skiing speed, a 0.5m threshold correction smoothed over 200ms means the player drifts 0.5m over 200ms while the visual interpolates. That's perceptible. For small corrections (<0.5m), the threshold avoids correction entirely. For large corrections (>2m, e.g., teleport or major desync), 200ms isn't enough — you'll see the player rubber-band.

**Carmack:** Tiered correction: small divergence (<0.5m) = ignore. Medium (0.5-2m) = smooth over 100ms. Large (>2m) = snap immediately. Very large (>10m) = assume teleport, snap with no interpolation.

**Muratori:** The applyPendingCorrection function uses ease-out quadratic, which is fine for the smooth case. But it interpolates from the *initial* position toward the *target* — if new corrections arrive while a blend is in progress, they overwrite the previous correction entirely. You'd get jerky motion if corrections arrive faster than the blend completes (which at 10Hz snapshots and 200ms blend, they do).

**Consensus:** Implement tiered correction thresholds. New corrections should blend from *current interpolated position*, not overwrite. Reduce smooth duration to 100ms for medium corrections.

---

## Pass 4 — System-Level Review

### Dependency Map

```
client/network.js
├── IMPORTS
│   ├── wire.js → decodeSnapshot, decodeDelta, encodeInput
│   ├── prediction.js → * (setLocalNumericId, nextTick, recordInput, reset, stats)
│   ├── voice.js → * (updatePeerPosition, registerPeerUuid, setPeerMuted, ...)
│   └── constants.js → MSG_SNAPSHOT, MSG_DELTA, INPUT_HZ
│
├── READS (window.*)
│   ├── window.__tribesReconcile — renderer snapshot callback
│   ├── window.__tribesApplyDelta — renderer delta callback
│   ├── window.__tribesShowReconnect / HideReconnect — UI overlay
│   ├── window.__tribesOnMatchStart / OnMatchEnd — UI callbacks
│   ├── window.__tribesOnSkillUpdate — rating badge callback
│   ├── window.addKillMsg — kill feed (IIFE global)
│   └── window.localStorage — UUID persistence
│
├── WRITES (window.*)
│   ├── window.__voiceUpdatePeer
│   ├── window.__voiceRegisterUuid
│   ├── window.__voiceSetPeerMuted / IsPeerMuted
│   ├── window.__voiceSetMuteAll / GetMuteAll
│   ├── window.__voiceMuteUuid
│   ├── window.__voiceSetPeerMutedDirect
│   └── window.__voiceClearPeerMutes
│
├── EXPORTS
│   ├── start() — connect to server
│   ├── send(msg) — send JSON or string
│   ├── sendBinary(buf) — send ArrayBuffer
│   ├── onMessage(handler) — register control message handler
│   ├── setInputProvider(fn) — register 60Hz input source
│   ├── getStatus() — connection + telemetry snapshot
│   ├── getLatestSnapshot() — last server snapshot (UNUSED)
│   └── prediction — re-export of prediction module
│
└── CALLED BY
    ├── index.html / shell — start(), setInputProvider()
    ├── renderer.js (indirectly via window.__tribesReconcile)
    └── voice.js (via send() passed as callback)

client/wire.js
├── IMPORTS
│   ├── quant.js → quantPos, unquantPos, quantRot, unquantRot, etc. + SIZE_*
│   └── constants.js → MSG_SNAPSHOT, MSG_DELTA, MSG_INPUT
│
├── EXPORTS
│   ├── encodeSnapshot(snap) / decodeSnapshot(buf)
│   ├── encodeDelta(snap) / decodeDelta(buf)
│   └── encodeInput(input) / decodeInput(buf)
│
└── CALLED BY
    ├── network.js (decode inbound, encode outbound)
    └── server/ (import same encode/decode for server-side)

client/prediction.js
├── IMPORTS
│   └── constants.js → PRED_HISTORY, PRED_DIVERGE_*, PRED_SMOOTH_CORRECT_MS
│
├── EXPORTS
│   ├── setLocalNumericId(id)
│   ├── nextTick() → number
│   ├── recordInput(tick, input, dt)
│   ├── reconcile(snapshot, getLocalPlayerWasm) [DEAD — never called]
│   ├── applyPendingCorrection(setCorrectionFn, getLocalPlayerWasm) [DEAD — never called]
│   ├── reset()
│   └── stats — { reconciliations, visibleSnaps, avgDivergence, lastDivergence }
│
└── CALLED BY
    ├── network.js → setLocalNumericId, nextTick, recordInput, reset, stats
    └── NOBODY → reconcile, applyPendingCorrection [DISCONNECTED]
```

### Interface Contract

**network.js promises:**
- Manages one WebSocket connection at a time
- Routes binary messages through wire.js decoders to window.* callbacks
- Routes JSON messages to onMessageHandlers + specific type handlers
- Provides 60Hz input send loop during match
- Tracks bandwidth and ping telemetry
- Exposes connection status via getStatus()

**wire.js promises:**
- Bijective encode/decode for snapshots, deltas, inputs
- Returns null on malformed input (no exceptions)
- Little-endian, sizes match network_architecture.md §5 (PARTIALLY — delta is not real delta)

**prediction.js promises:**
- Maintains local tick counter for input sequencing
- Records input history for reconciliation replay
- INTENDED: smooth position correction on server divergence
- ACTUAL: tick counter + dead reconciliation code

### Contradiction Flags

| Contradiction | Modules | Description |
|---|---|---|
| **Prediction disconnected** | prediction.js ↔ network.js ↔ renderer.js | prediction.reconcile() exists but nobody calls it. Renderer has its own window.__tribesReconcile. Two reconciliation paths, one dead. |
| **Delta = Snapshot** | wire.js ↔ constants.js | Constants define SNAPSHOT_HZ=10 and DELTA_HZ=30, implying different formats. Wire format makes them identical. Misleading API. |
| **Client tick ≠ Server tick** | prediction.js ↔ server | Client ticks at 60Hz from 0. Server ticks at 30Hz from arbitrary start. No mapping exists. Input tick field is meaningless for reconciliation. |
| **Voice globals in network** | network.js ↔ voice.js | network.js writes 10 voice globals. Voice is a separate concern. Module boundary violated. |
| **Telemetry carries profile state** | network.js telemetry | skillRating, matchesPlayed, ranked have nothing to do with network telemetry. Bolted on for convenience. |

### Keep / Extract / Absorb / Kill

| Component | Recommendation | Rationale |
|---|---|---|
| `network.js` connection/dispatch | **KEEP** | Core networking — needs refactoring but not replacement |
| `network.js` input loop | **EXTRACT** → `client/input_sender.js` | Separate concern, own tick rate, own encoding |
| `network.js` telemetry | **EXTRACT** → `client/net_telemetry.js` | Bandwidth metrics ≠ connection management ≠ profile state |
| `network.js` voice globals | **EXTRACT** → move to `voice.js` self-registration | network.js shouldn't know voice API surface |
| `network.js` skill rating | **EXTRACT** → `client/player_profile.js` or similar | Not networking concern |
| `wire.js` snapshot encode/decode | **KEEP** | Clean, correct (minus delta lie), shared with server |
| `wire.js` delta encode/decode | **ABSORB** into snapshot (delete separate functions) or **implement real deltas** | Current delta functions are misleading aliases. Either make them real or remove the pretense |
| `prediction.js` tick counter | **KEEP** | Needed for input sequencing |
| `prediction.js` reconcile/applyCorrection | **KEEP but ACTIVATE** | Wire into the actual game loop. Dead code is worse than no code. |
| `prediction.js` inputHistory | **KEEP but USE** | Currently records inputs nobody reads. Needs reconciliation wiring. |

---

## Pass 5 — AI Rules Extraction

### @ai-contract for network.js

```js
// @ai-contract
// BEFORE_MODIFY: read docs/lessons-learned.md, read client/constants.js for rate/threshold values
// NEVER: add non-networking concerns (voice globals, skill ratings should be extracted)
// NEVER: create setInterval without storing the ID for cleanup
// ALWAYS: clear all intervals/timers in onclose handler
// ALWAYS: test with socket=null guards before any socket.send()
// DEPENDS_ON: wire.js (decodeSnapshot, decodeDelta, encodeInput)
// DEPENDS_ON: prediction.js (nextTick, recordInput, reset, stats)
// DEPENDS_ON: voice.js (10 window.__voice* globals — LEGACY, extract to voice.js)
// DEPENDS_ON: constants.js (MSG_SNAPSHOT, MSG_DELTA, INPUT_HZ)
// READS_WINDOW: __tribesReconcile, __tribesApplyDelta, __tribesShowReconnect,
//   __tribesHideReconnect, __tribesOnMatchStart, __tribesOnMatchEnd, __tribesOnSkillUpdate,
//   addKillMsg
// WRITES_WINDOW: __voiceUpdatePeer, __voiceRegisterUuid, __voiceSetPeerMuted,
//   __voiceIsPeerMuted, __voiceSetMuteAll, __voiceGetMuteAll, __voiceMuteUuid,
//   __voiceSetPeerMutedDirect, __voiceClearPeerMutes
// EXPORTS: start, send, sendBinary, onMessage, setInputProvider, getStatus,
//   getLatestSnapshot, prediction
// COORDINATE_SPACE: N/A (wire format uses quantized world-space meters, handled by wire.js)
// KNOWN_ISSUES: ping interval leaks on reconnect, prediction.reconcile() never called,
//   delta is fake (full snapshot), voice globals should be in voice.js
// SCALING_WALL: WebSocket transport (TCP head-of-line blocking), 60Hz input rate,
//   no entity interpolation for remote players
// @end-ai-contract
```

### @ai-contract for wire.js

```js
// @ai-contract
// BEFORE_MODIFY: read comms/network_architecture.md §5 for wire format spec
// BEFORE_MODIFY: update BOTH client/wire.js AND server/wire.ts — they must match exactly
// NEVER: change struct sizes without updating quant.js SIZE_* constants
// NEVER: use big-endian — all multi-byte fields are little-endian (LE=true)
// ALWAYS: return null on malformed input (no exceptions, no partial results)
// ALWAYS: validate buffer length before reading (bounds check)
// DEPENDS_ON: quant.js (quantization functions + SIZE_* constants)
// DEPENDS_ON: constants.js (MSG_SNAPSHOT, MSG_DELTA, MSG_INPUT)
// EXPORTS: encodeSnapshot, decodeSnapshot, encodeDelta, decodeDelta, encodeInput, decodeInput
// COORDINATE_SPACE: quantized world meters (pos×50→i16, rot×10000→i16, vel×2→i8)
// KNOWN_ISSUES: decodeDelta mutates input buffer byte 0 (fragile),
//   encodeDelta is just encodeSnapshot with type byte overwrite (no real delta compression),
//   flag Z coordinate lost (hardcoded to 0 on decode), no format version in header,
//   no sequence number for out-of-order detection
// WIRE_FORMAT_VERSION: 1 (implicit — flags byte unused, reserve bit 0 for version)
// STRUCT_SIZES: header=8, snap_hdr=24, player=32, projectile=12, flag=8, input=20
// @end-ai-contract
```

### @ai-contract for prediction.js

```js
// @ai-contract
// BEFORE_MODIFY: read client/constants.js for PRED_* thresholds
// BEFORE_MODIFY: understand the reconciliation model — WASM does implicit prediction,
//   this module handles server divergence measurement and smooth correction
// NEVER: reset nextClientTick to 0 during active match (breaks server input ordering)
// ALWAYS: call reconcile() from snapshot handler and applyPendingCorrection() from render loop
//   (currently DISCONNECTED — these must be wired in)
// DEPENDS_ON: constants.js (PRED_HISTORY, PRED_DIVERGE_POS_THRESHOLD_M,
//   PRED_DIVERGE_ROT_THRESHOLD_DEG, PRED_SMOOTH_CORRECT_MS)
// EXPORTS: setLocalNumericId, nextTick, recordInput, reconcile, applyPendingCorrection,
//   reset, stats
// CALLED_BY: network.js (setLocalNumericId, nextTick, recordInput, reset, stats)
// CALLED_BY: NOBODY for reconcile/applyPendingCorrection (BUG — must be wired to renderer)
// COORDINATE_SPACE: world meters, radians (same as WASM player state)
// KNOWN_ISSUES: reconcile() never called (dead code), applyPendingCorrection() never called,
//   client tick ≠ server tick (no mapping), inputHistory recorded but never replayed,
//   smooth correction overwrites previous correction instead of chaining,
//   reset() zeroes tick counter (breaks reconnect to same match)
// FUTURE: add lastProcessedClientTick to snapshot header for proper input acknowledgment,
//   implement input replay for authoritative reconciliation,
//   tiered correction (small=ignore, medium=smooth, large=snap)
// @end-ai-contract
```

---

## Pass 6 — Design Intent

### Core Feelings Mapping

| Module | Core Feeling Served | Assessment |
|---|---|---|
| **network.js** | **Scale** (64-player matches), **Belonging** (team coordination requires real-time sync) | The module *enables* multiplayer, which is essential for Belonging and Scale. Without reliable networking, the game is single-player. Currently supports 2-player testing; scaling to 64 requires significant work. |
| **wire.js** | **Scale** (bandwidth efficiency determines player count), **Aliveness** (frequent state updates make the world feel alive) | The binary protocol is the right approach — compact, efficient, symmetric (shared with server). But fake deltas and missing flag Z undermine the "world is alive" feeling when flags float at Y=0 and remote players teleport at 10Hz. |
| **prediction.js** | **Scale** (prediction enables responsive gameplay at distance from server) | Prediction is THE system that makes multiplayer FPS playable. Without it, every action has a round-trip delay. Currently disconnected — the WASM engine provides implicit prediction, but there's no reconciliation. Players will experience rubber-banding under any real network conditions. This module is critical but dormant. |

### Ive's Razor — "What Sensation Does This Create?"

**Fiedler:** The networking stack creates the sensation of *shared presence* — the feeling that other humans are in the world with you, reacting in real-time. For Tribes, this is foundational. Skiing feels different when you see another player arcing across a ridge and know that's a human making decisions. But shared presence requires two things: (1) updates frequent enough that movement looks smooth, and (2) prediction accurate enough that your own movement feels crisp despite 50-100ms to the server. Currently, neither is achieved — remote players update at 10Hz with no interpolation (choppy), and local prediction has no reconciliation (will rubber-band under real network conditions).

**Carmack:** The wire protocol creates a sensation of *precision* — quantized to 2cm position resolution, 0.006° rotation, 0.5 m/s velocity. That's more than sufficient for the gameplay needs. But the protocol is currently over-designed for features it doesn't deliver (delta compression, proper prediction) and under-designed for features it needs (entity interpolation, input redundancy).

**Muratori:** I want to highlight a naming problem. `prediction.js` is named for what it *intends* to do, not what it *actually* does. It's a tick counter and a dead reconciliation stub. If someone sees "prediction" in the module list and thinks "prediction is handled," that's worse than having no file at all. Either activate it or rename it to `tick_counter.js` so the module list tells the truth.

### Noise Flags

| Item | Noise? | Rationale |
|---|---|---|
| Skill rating in telemetry object | **Yes** | Skill ratings are player profile data, not network telemetry. They were bolted onto the telemetry object because it was convenient. Extract to a profile module. |
| Voice globals in network.js | **Yes** | Voice is a separate subsystem. network.js shouldn't be the bridge between voice.js and shell.html. |
| `getLatestSnapshot()` export | **Yes** | Exported, never imported. Dead API. Remove or document who should use it. |
| `encodeDelta` / `decodeDelta` | **Misleading** | Named "delta" but they're full snapshots. Either implement real deltas or remove the naming pretense. |

### Naming Assessment

| Current Name | Accurate? | Suggested |
|---|---|---|
| `network.js` | Partially — it's connection + dispatch + input + telemetry + voice bridge | `connection.js` (if responsibilities are extracted) or keep `network.js` as the facade |
| `wire.js` | **Yes** — wire format encode/decode. Clear and accurate. | Keep |
| `prediction.js` | **No** — it's a tick counter with dead reconciliation code | Activate reconciliation (then name is accurate) or rename to `net_timing.js` |
| `telemetry` object | **No** — contains skill rating, match state, not just telemetry | Split into `netMetrics` + `playerProfile` |
| `encodeDelta` / `decodeDelta` | **No** — they don't encode/decode deltas | Rename to `encodeUpdate` / `decodeUpdate` or implement real deltas |

---

## Summary of Findings

### By Severity

**CRITICAL (5):**
1. **W-1:** prediction.reconcile() never called — entire prediction module is dead code
2. **S-3:** decodeDelta mutates input buffer byte 0
3. **GF-1:** Prediction model fundamentally disconnected from game loop
4. **GF-5:** No entity interpolation for remote players — 10Hz position snapping
5. **CM-1:** prediction.js solves a problem it's not connected to

**HIGH (12):**
1. **S-1:** Ping interval leaks on reconnect (never cleared)
2. **W-2:** Client tick counter unrelated to server tick — reconciliation impossible
3. **C-1:** No connection state machine — state spread across 5 variables
4. **C-3:** No sequence numbers on snapshots/deltas
5. **C-4:** Delta is a full snapshot with different type byte — no compression
6. **GF-2:** 60Hz input over TCP is wasteful — server ticks at 30Hz
7. **GF-3:** No input redundancy — single input per packet
8. **JC-1:** TCP/WebSocket wrong transport for competitive FPS game state
9. **JC-2:** Snapshot bandwidth doesn't scale to 64 players
10. **MA-1:** Decode path creates object graphs instead of flat arrays
11. **MA-2:** network.js mixes four responsibilities
12. **EC-3:** (from rapier phase, relevant to prediction) Velocity correction is physically wrong

**MEDIUM (11):**
1. **S-2:** Input loop double-start race on rapid reconnect
2. **W-3:** getLatestSnapshot() exported but never consumed
3. **W-4:** prediction.reset() resets tick to 0 — breaks reconnect
4. **W-5:** Voice module globals bypass ES module system
5. **C-2:** Flag Z coordinate lost in wire format
6. **C-5:** No disconnect/timeout detection
7. **GF-4:** No jitter buffer — snapshots applied immediately
8. **JC-3:** Telemetry object is kitchen-sink state
9. **JC-4:** Ping measurement formula is wrong
10. **CM-3:** decodeSnapshot allocates heavily per call — GC pressure at scale
11. **CM-4:** Wire format has no version field
12. **MA-3:** inputProvider callback allocates per-call

**LOW (3):**
1. **S-4:** trackInbound counts characters not bytes for strings
2. **S-5:** No maximum on onMessageHandlers array
3. **MA-4:** Sliding window arrays use shift() instead of ring buffer

### Actionable Fixes (Immediate — Run 1)

| # | Fix | Files | Est. |
|---|---|---|---|
| 1 | Store ping interval ID, clear in onclose | network.js | 5 min |
| 2 | Wire prediction.reconcile() into snapshot handler | network.js, renderer.js | 30 min |
| 3 | Wire prediction.applyPendingCorrection() into render loop | renderer.js, prediction.js | 30 min |
| 4 | Fix decodeDelta to not mutate input buffer | wire.js | 10 min |
| 5 | Extract voice globals to voice.js self-registration | network.js, voice.js | 20 min |
| 6 | Fix ping formula to `Date.now() - msg.clientTs` | network.js | 5 min |
| 7 | Add @ai-contract blocks to all three files | network.js, wire.js, prediction.js | 15 min |

### Deferred Fixes (Post-Audit)

| # | Fix | Scope | Priority |
|---|---|---|---|
| 1 | Entity interpolation for remote players | New module: `client/interpolation.js` | 🔴 Critical |
| 2 | Real delta compression | wire.js, server | 🔴 Critical for 64-player |
| 3 | Decouple input send rate from local sim rate (30Hz send) | network.js, constants.js | 🟡 High |
| 4 | Input redundancy (last 3 inputs per packet) | wire.js, network.js | 🟡 High |
| 5 | Add sequence numbers to snapshot/delta headers | wire.js, constants.js | 🟡 High |
| 6 | Add lastProcessedClientTick to snapshot for reconciliation | wire.js, server | 🟡 High |
| 7 | Extract input loop to client/input_sender.js | network.js → input_sender.js | 🟡 High |
| 8 | Extract telemetry to client/net_telemetry.js | network.js → net_telemetry.js | 🟢 Medium |
| 9 | Flat typed-array decode path for 64-player performance | wire.js | 🟢 Medium |
| 10 | Connection state machine | network.js | 🟢 Medium |
| 11 | Jitter buffer for snapshot smoothing | New module | 🟢 Medium |
| 12 | WebRTC DataChannel for game state | network.js, server | 🟢 Medium (long-term) |
| 13 | Fix flag Z coordinate (expand SIZE_FLAG to 10+ bytes) | wire.js, quant.js | 🟢 Medium |
| 14 | Tiered reconciliation thresholds | prediction.js | 🟢 Medium |
| 15 | Wire format version in flags byte | wire.js | 🟢 Medium |

---

*Audit complete. The networking stack has the right architectural bones — binary wire protocol, dedicated prediction module, clean quantization — but critical wiring is disconnected (prediction never called), bandwidth optimization is absent (fake deltas), and entity interpolation for remote players doesn't exist. The immediate priority is activating prediction.reconcile() and fixing the ping interval leak. The long-term priority is entity interpolation, real delta compression, and transport evolution to WebRTC DataChannel for competitive play.*
