# Phase 3c — Networking Stack — Adversarial Convergence Review (Run 2)

*Run 2 | Validation Pass | 725 lines total*
*Files: `client/network.js` (331L) + `client/wire.js` (254L) + `client/prediction.js` (140L)*
*Panel: Glenn Fiedler (netcode/prediction), Carmack (engine arch/FPS netcode), Muratori (simplicity/data flow), Acton (data-oriented design)*
*Run 1 Reference: `docs/audit-log/run-1/phase-3c-networking.md`*

---

## Mission: Validate, Challenge, and Deepen Run 1

Run 1 identified 5 CRITICAL, 12 HIGH, 12 MEDIUM, and 3 LOW issues. The headline finding was that `prediction.reconcile()` is "never called" — **the entire prediction module is dead code.** Run 2's PRIMARY task is to verify this claim against ALL source code, including non-module files (index.html, shell.html).

---

## CRITICAL CORRECTION: prediction.reconcile() IS Called

### Run 1 Finding W-1 / CM-1 / GF-1 (All CRITICAL): "prediction.reconcile() never called"

**Run 1 claim:** "Nowhere in network.js or any other file is `prediction.reconcile()` called." "prediction.js is 140 lines of dead code."

**Run 2 investigation:**

Run 1 searched ES module imports. But `prediction` is re-exported from `network.js` (line 308: `export { prediction };`), and consumed by index.html — a non-module script.

**index.html, lines 4347-4379:**
```js
window.__tribesReconcile = function(snap){
    if(!Module._setLocalPlayerNetCorrection) return;
    m.prediction.reconcile(snap, function(){
        if(!Module.calledRun || !Module.HEAPF32 || !Module._getPlayerStatePtr) return null;
        var ptr = Module._getPlayerStatePtr();
        var stride = Module._getPlayerStateStride();
        var idx = Module._getLocalPlayerIdx();
        var view = new Float32Array(Module.HEAPF32.buffer, ptr + idx * stride * 4, stride);
        return { pos: [view[0], view[1], view[2]], rot: [view[3], view[4], view[5]] };
    });
};
// Per-frame correction — driven by RAF (~60Hz)
(function predictionFrame(){
    if(window.__tribesNet && Module._setLocalPlayerNetCorrection){
        m.prediction.applyPendingCorrection(
            Module._setLocalPlayerNetCorrection,
            function(){
                if(!Module.calledRun || !Module.HEAPF32) return null;
                var ptr = Module._getPlayerStatePtr();
                var stride = Module._getPlayerStateStride();
                var idx = Module._getLocalPlayerIdx();
                var view = new Float32Array(Module.HEAPF32.buffer, ptr + idx * stride * 4, stride);
                return { pos: [view[0], view[1], view[2]], rot: [view[3], view[4], view[5]] };
            }
        );
    }
    requestAnimationFrame(predictionFrame);
})();
```

**The full prediction pipeline is wired:**

1. `network.js` receives snapshot → calls `window.__tribesReconcile(snap)` (line 132)
2. `index.html` defines `__tribesReconcile` → calls `prediction.reconcile(snap, getLocalPlayerWasm)`
3. `prediction.reconcile()` compares server state with WASM state, computes divergence, sets `smoothCorrection`
4. `index.html` runs a `requestAnimationFrame` loop → calls `prediction.applyPendingCorrection(Module._setLocalPlayerNetCorrection, getLocalPlayerWasm)`
5. `applyPendingCorrection()` nudges the WASM player position toward the server-authoritative state over 200ms

> **Fiedler:** This is a major correction to Run 1. The prediction module is NOT dead code. It's actively measuring divergence and applying smooth corrections. Run 1 only searched ES module imports and missed the non-module wiring in index.html. The `window.__tribesReconcile` callback IS the bridge.
>
> **Muratori:** Run 1's CM-1 said "prediction.js is 140 lines of dead code. Not 'mostly dead' — completely disconnected." That's factually wrong. `reconcile()` IS called on every snapshot. `applyPendingCorrection()` IS called every frame. `recordInput()` IS called 60 times per second. The stats object IS being updated.
>
> **Carmack:** Wait — `recordInput()` records inputs into `inputHistory`, but `reconcile()` never reads `inputHistory`. It only compares positions and rotations. The input history is still dead in the sense that no replay happens. But the divergence measurement and smooth correction are live.
>
> **Fiedler:** Correct. The reconciliation is "measure and blend" not "measure, replay, and correct." The `inputHistory` buffer is populated but unused by the current reconciliation logic. That's a stub for future replay-based reconciliation, not dead code per se — it's vestigial.
>
> **Acton:** Let me update the wiring diagram. Here's the ACTUAL data flow:

```
network.js receives snapshot
  │
  ├── decodeSnapshot(buf) → snap object
  │
  ├── window.__tribesReconcile(snap)    [defined in index.html]
  │     │
  │     └── prediction.reconcile(snap, getLocalPlayerWasm)
  │           ├── reads WASM player pos/rot via getLocalPlayerWasm()
  │           ├── computes divergence (dist, rotMag)
  │           ├── updates stats.avgDivergence
  │           └── if divergence > threshold → sets smoothCorrection
  │
  └── window.__tribesApplyDelta(delta)  [if delta type]

index.html RAF loop (every frame):
  │
  └── prediction.applyPendingCorrection(
        Module._setLocalPlayerNetCorrection,
        getLocalPlayerWasm
      )
        ├── reads elapsed time since correction started
        ├── computes eased interpolation factor
        └── calls Module._setLocalPlayerNetCorrection(x, y, z, yaw, pitch)
            [writes corrected position back to WASM]
```

**Run 2 severity reassessment:**

| Run 1 Finding | Run 1 Sev | Run 2 Verdict |
|---------------|-----------|---------------|
| W-1: reconcile() never called | CRITICAL | **INCORRECT — reconcile() IS called via index.html** |
| CM-1: prediction.js is dead code | CRITICAL | **INCORRECT — module is live and active** |
| GF-1: Prediction fundamentally disconnected | CRITICAL | **PARTIALLY INCORRECT — divergence measurement + smooth correction work. Input replay is still missing.** |

**What IS still true from Run 1:**
- `inputHistory` is populated but never read by `reconcile()` — vestigial for future replay
- Client tick ≠ server tick — no mapping exists (W-2 still valid)
- `prediction.reset()` resets tick to 0 — still a reconnect concern (W-4 still valid)
- Smooth correction overwrites previous correction — still an issue (GF debate point)

---

## Remaining Run 1 Finding Verification

### S-1: Ping Interval Leak (Run 1: HIGH)

**Source:** network.js line ~182-190:
```js
setInterval(() => {
    if (socket && socket.readyState === WebSocket.OPEN) {
        const payload = JSON.stringify({ type: 'ping', clientTs: Date.now() });
        telemetry.lastPingSent = Date.now();
        trackOutbound(payload.length);
        socket.send(payload);
    }
}, 2000);
```

No interval ID stored. No `clearInterval` in `onclose` handler.

**Run 2 verification:** ✅ **VALIDATED.** The `setInterval` call is inside `start()`. If `start()` is called again after a disconnect, a second interval is created. The old interval still fires every 2 seconds. The `socket && socket.readyState === WebSocket.OPEN` guard prevents actual sends after the old socket closes, but the interval callback still fires, doing wasted work. After N reconnects, N+1 intervals are running.

> **Carmack:** This is more than a cleanup issue. Each interval calls `Date.now()` and checks `socket.readyState` every 2 seconds forever. After 100 reconnects in a long session, that's 101 intervals. Not a crash, but a scaling leak. Store the ID and clear it in `onclose`.

---

### S-3: `decodeDelta` Mutates Input Buffer (Run 1: CRITICAL)

**Source:** wire.js lines 206-213:
```js
export function decodeDelta(buf) {
    if (buf.byteLength < SIZE_HEADER + SIZE_SNAP_HDR) return null;
    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    if (view.getUint8(0) !== MSG_DELTA) return null;
    const tmp = new Uint8Array(buf);
    tmp[0] = MSG_SNAPSHOT;
    const decoded = decodeSnapshot(tmp);
    tmp[0] = MSG_DELTA;
    return decoded;
}
```

**Run 2 verification:** ✅ **VALIDATED** — `new Uint8Array(buf)` creates a view over the same buffer, not a copy. Byte 0 is mutated in-place and then restored. In single-threaded JS this is safe, but fragile.

> **Acton:** The mutation is safe today because: (1) JavaScript is single-threaded, (2) WebSocket message buffers aren't reused by the browser, (3) no SharedArrayBuffer is involved. But it violates the decode contract ("returns null on malformed, doesn't mutate input"). The fix is trivial: copy the first byte, set it, decode, done. Or better: make `decodeSnapshot` accept an overrideType parameter.

**Run 2 severity adjustment:** Run 1 CRITICAL → **Run 2: LOW.** Safe in current single-threaded context. Fragile by design, but not an active bug.

---

### C-2: Flag Z Hardcoded to 0 (Run 1: MEDIUM)

**Source:** wire.js decode, line 174:
```js
flags.push({
    team:        view.getUint8(o),
    state:       view.getUint8(o + 1),
    carrierIdx:  carrierByte,
    pos: [unquantPos(view.getInt16(o + 4, LE)), unquantPos(view.getInt16(o + 6, LE)), 0],
});
```

Flag Z is hardcoded to `0`. The encode side (lines 132-141) only writes posX (o+4) and posY (o+6) — there's no room for posZ in the 8-byte SIZE_FLAG.

**Run 2 verification:** ✅ **VALIDATED.** Flag Z is always 0 on decode. On hilly terrain, flags will render at ground level (Y=0) instead of at their actual Z coordinate. The comment on line 135 acknowledges this: "posZ is approximated. R20 may extend to 10 bytes."

> **Fiedler:** Wait — let me be precise about coordinate conventions. The flag `pos` array is `[posX, posY, posZ]`. In the THREE.js/WASM convention, Y is up. So "posZ" in the flag struct is the horizontal Z coordinate, not altitude. The *altitude* (Y) is encoded at `pos[1]`. The missing coordinate means flags are placed at the correct height but at Z=0 on the horizontal axis. On Raindance, flags are placed at specific X/Z positions — rendering all flags at Z=0 shifts them horizontally to the map center along one axis.
>
> **Carmack:** Actually, looking at the encode side more carefully: `quantPos(f.pos[0])` at o+4 and `quantPos(f.pos[1])` at o+6. So pos[0]=X is encoded, pos[1]=Y is encoded (as the second int16), and pos[2]=Z is dropped. The decode reads them back: `pos: [unquantPos(...o+4...), unquantPos(...o+6...), 0]`. So X and Y (height) are correct; Z (depth) is 0. This is LESS severe than "flags render underground" — they render at correct X and Y but at Z=0.
>
> **Muratori:** For a map where the flag stands are at the extremes of the Z axis, this means flags snap to the centerline. Visually wrong, but the flag is still rendered — it's just shifted along one axis. MEDIUM is the right severity.

---

### GF-5: No Entity Interpolation for Remote Players (Run 1: CRITICAL)

**Run 2 verification:** ✅ **VALIDATED.** The networking stack provides no interpolation between snapshots. Remote player positions are updated when a snapshot arrives (10Hz or 30Hz delta) and stay fixed until the next update.

> **Fiedler:** This is still the most impactful gameplay issue in the networking stack. Remote players visually "teleport" 10-30 times per second. At 60fps render, that's 2-6 stationary frames between each position update. For players skiing at 60+ m/s, each teleport moves them 2-6 meters. This produces extremely choppy remote player movement.
>
> **Carmack:** The renderer currently reads positions from WASM HEAPF32, which is updated by `window.__tribesReconcile` for the LOCAL player. For REMOTE players, positions come from the decoded snapshot objects, which are written into WASM by `__tribesApplyDelta`. The WASM side may or may not interpolate — we can't verify from JS alone. But the networking stack provides no interpolation infrastructure.
>
> **Run 2 note:** This finding depends on what WASM does with the delta data. If WASM interpolates internally, this is mitigated. If WASM just overwrites positions, it's exactly as Run 1 describes. The JS networking code provides no interpolation — that's confirmed.

---

### W-2: Client Tick ≠ Server Tick (Run 1: HIGH)

**Source:** prediction.js line 30: `nextTick()` returns `nextClientTick++` starting from 0, incrementing at 60Hz. Server snapshots contain `snapshot.tick` — the server's counter at a different rate and starting point.

**Run 2 verification:** ✅ **VALIDATED.** No tick mapping exists. `reconcile()` uses `snapshot.tick` only for ordering (`if (snapshot.tick <= lastReconcileTick) return`) — it never correlates client ticks with server ticks. For the current "measure and blend" reconciliation, this doesn't matter — you just compare current positions. But for future replay-based reconciliation, you'd need to know which client inputs the server has already processed.

---

### W-3: `getLatestSnapshot()` Never Consumed (Run 1: MEDIUM)

**Run 2 verification:** Let me check more broadly...

```
grep -rn 'getLatestSnapshot' across all source
```

network.js exports it (line 304). No import found in any other file.

✅ **VALIDATED.** Dead export.

---

### JC-4: Ping Measurement Wrong (Run 1: MEDIUM)

**Source:** network.js line 183: For the pong handler:
```js
} else if (msg.type === 'pong') {
    telemetry.pingMs = msg.serverTs - msg.clientTs;
}
```

**Run 2 analysis:**

The client sends: `{ type: 'ping', clientTs: Date.now() }`. The server presumably echoes `clientTs` and adds `serverTs`. If `serverTs` is the server's clock at receive time, then `serverTs - clientTs` measures one-way latency + clock skew. If `serverTs` is the server's clock at send time, it measures server processing time + clock skew. Neither is RTT.

Correct RTT measurement: `Date.now() - msg.clientTs` (when pong is received).

> **Carmack:** Run 1 is correct. The formula should be `Date.now() - msg.clientTs` for proper round-trip time. The current formula depends entirely on what the server puts in `serverTs` — which is an unverified assumption from the client's perspective.

✅ **VALIDATED.**

---

### start() Not Idempotent (Run 1 implicit finding)

**Source:** network.js `start()` (line 103):
```js
export function start() {
    const url = getServerUrl();
    log('connecting to ' + url);
    try {
        socket = new WebSocket(url);
        socket.binaryType = 'arraybuffer';
    } catch (err) {
        log('connect failed: ' + err.message);
        return;
    }
    // ... sets up handlers, creates setInterval
```

No guard against double-call. No `socket.close()` on existing socket. No `_connecting` state check.

**Run 2 verification:** ✅ **VALIDATED.** If `start()` is called while a socket is already open:
1. Old socket reference is overwritten — no `close()` called
2. Old socket's event handlers still fire (reference via closure to old `socket` variable — but wait, `socket` is module-level, so the closures actually reference the SAME `socket` variable which now points to the NEW socket)
3. Actually, the event handlers close over the module-level `socket` var, which is reassigned. So old socket's `onmessage` would read `socket` (now pointing to new socket) when checking state, but `event.data` still comes from the old socket. This could cause old messages to be processed as if they came from the new connection. **Subtle data corruption risk.**
4. A NEW `setInterval` is created for pings. Old interval not cleared. Ping interval leak.

> **Fiedler:** This is worse than Run 1 described. The module-level `socket` variable means old event handlers see the new socket when they check `socket.readyState`. An old socket's onclose could fire after the new socket's onopen, setting `socket = null` and clearing state that the new connection needs. The fix must include: (1) `if (socket) socket.close()` at top of `start()`, (2) store and clear ping interval.

**Run 2 severity:** **HIGH** — active data corruption risk on reconnect, not just a leak.

---

### Heap Allocations Per Snapshot Decode (Run 1: CM-3, ~321 allocations)

**Run 2 count for 16 players, 10 projectiles, 2 flags:**

| Allocation | Count | Notes |
|-----------|-------|-------|
| `readHeader()` return object | 1 | `{type, flags, payloadLen, tick}` |
| `players` array | 1 | `const players = []` |
| Per-player object | 16 | `{id, alive, visible, ...}` |
| Per-player `pos` array | 16 | `[x, y, z]` |
| Per-player `rot` array | 16 | `[x, y, z]` |
| Per-player `vel` array | 16 | `[x, y, z]` |
| `projectiles` array | 1 | `const projectiles = []` |
| Per-projectile object | 10 | `{id, type, team, ...}` |
| Per-projectile `pos` array | 10 | `[x, y, z]` |
| `flags` array | 1 | `const flags = []` |
| Per-flag object | 2 | `{team, state, carrierIdx, pos}` |
| Per-flag `pos` array | 2 | `[x, y, z]` |
| Result object | 1 | `{tick, matchTick, ...}` |
| `teamScore` array | 1 | `[t0, t1]` |
| **Total** | **94** | For 16 players |

For 64 players, 20 projectiles:
- 1 + 1 + 64 + 64×3 + 1 + 20 + 20 + 1 + 2 + 2 + 1 + 1 = **306 allocations**

Run 1 said "321 heap allocations." The discrepancy is ~15 — likely Run 1 counted the `DataView` creation in `decodeSnapshot` (1 alloc), the intermediate `u8` in `decodeDelta` (1 alloc), and possibly some internal V8 object allocations for the `push()` calls. The order of magnitude is correct.

**Run 2 verdict:** Run 1's "321" is approximately correct. At 10-40 decodes/sec with 64 players, that's 3,060-12,240 short-lived allocations per second. This WILL cause GC pauses on mobile devices. ✅ **VALIDATED.**

---

### No Interpolation Between Snapshots (Run 1: GF-5, CRITICAL)

**Run 2 verification:** Confirmed that network.js, wire.js, and prediction.js contain zero interpolation code. `decodeSnapshot` produces discrete state objects. No interpolation buffer, no timestamp-pair storage, no lerp utility.

> **Fiedler:** To be thorough: the WASM side COULD interpolate internally. The `__tribesApplyDelta` callback writes snapshot data into WASM, and the WASM simulation might smooth positions between updates. But from the JS networking stack's perspective, no interpolation exists.

✅ **VALIDATED** (at the JS networking layer).

---

## 64-Player Scalability Analysis (NEW for Run 2)

### Bandwidth

| Component | Per-Snapshot Bytes | Rate | Per-Client KB/s |
|-----------|-------------------|------|-----------------|
| Header | 8 | — | — |
| Snap header | 24 | — | — |
| 64 players × 32B | 2,048 | — | — |
| 20 projectiles × 12B | 240 | — | — |
| 2 flags × 8B | 16 | — | — |
| **Total per snapshot** | **2,336** | — | — |
| 10Hz snapshots | — | 10/s | 22.8 |
| 30Hz "deltas" (= snapshots) | — | 30/s | 68.4 |
| **Total inbound** | — | 40/s | **91.2 KB/s** |

| Direction | Per-Client | 64 Clients | Notes |
|-----------|-----------|------------|-------|
| Server → Client | 91.2 KB/s | 5.7 MB/s total outbound | Manageable on dedicated server |
| Client → Server (input) | 1.2 KB/s (60Hz × 20B) | 76.8 KB/s total inbound | Minimal |

> **Carmack:** 5.7 MB/s outbound for 64 clients is tight for a Cloudflare Worker (Workers have bandwidth limits). Real delta compression (bitfield of changed fields) would cut 60-80% — most players don't change every field every tick. The player-presence bitmask optimization (skip dead/stationary players) could cut another 30-50%.
>
> **Acton:** The bigger issue is the allocation pressure from decoding. 306 allocations × 40 decodes/sec = 12,240 objects/sec. Each lives for one frame (~16ms). V8's young generation GC handles this, but on low-end devices, GC pauses of 2-5ms are possible every few seconds. Decoding into pre-allocated flat typed arrays would eliminate this entirely.

### Input Pipeline

> **Fiedler:** At 64 players, the server receives 64 × 60 = 3,840 input messages per second. Each is 20 bytes over WebSocket. The server must decode and buffer all of them. This is the server's bottleneck, not the client's. The client only sends its own inputs.
>
> Run 1's recommendation to decouple input send rate (30Hz) from local simulation rate (60Hz) would halve server inbound to 1,920 msg/s. With 3-input redundancy per packet, bandwidth goes UP slightly (30Hz × ~50B = 1.5KB/s vs 60Hz × 20B = 1.2KB/s) but loss resilience improves dramatically.

---

## Phase System Readiness (NEW for Run 2)

### Wire Format

The snapshot header includes `matchState` (1 byte at snap header offset 4). This can encode the current phase.

```
// Snap header (24 bytes):
// [0]  u8 playerCount
// [1]  u8 projCount
// [2-3] u16 matchTick
// [4]  u8 matchState  ← PHASE GOES HERE
// [5]  u8 teamScore[0]
// [6]  u8 teamScore[1]
// [7-23] reserved
```

> **Fiedler:** The `matchState` byte can encode phase directly. The server already sets it; the client already reads it. The 17 reserved bytes (7-23) in the snap header provide ample room for phase-specific data (phase timer, phase intensity, etc.).
>
> **Carmack:** The networking stack is actually READY for the phase system at the wire level. The bottleneck is the client-side consumers (renderer_polish.js, weather system) that don't read `matchState` from the decoded snapshot.

### prediction.js

No phase hooks needed. Prediction is position-based; it doesn't need to know what phase the game is in.

### network.js

`matchState` is already decoded and propagated. The `window.__tribesReconcile` callback passes the full snapshot including `matchState`. No changes needed.

---

## Expert Debate: What Actually Matters Now?

> **Fiedler:** With the prediction correction in place, let me reprioritize. Run 1's top 3 CRITICAL findings were all about prediction being dead. Two of those are wrong. The remaining truly critical issue is **entity interpolation for remote players** (GF-5). That's the single biggest gameplay quality gap.
>
> **Muratori:** Agreed. But entity interpolation requires architecture that doesn't exist yet — a snapshot buffer, timestamp pairing, and a lerp function in the render path. That's a new module (`client/interpolation.js`), not a fix to existing code.
>
> **Carmack:** The second most important fix is `start()` idempotency. The reconnection scenario is real — players will lose connection mid-match and the client will try to reconnect. If `start()` doesn't cleanly tear down the old connection, event handler cross-contamination causes mysterious bugs.
>
> **Acton:** Third: the ping interval leak (S-1). This is the easiest fix (5 minutes) with the highest certainty of preventing a real production issue. Do it first.
>
> **Fiedler:** Fourth: decodeDelta should stop mutating the input buffer. Trivial fix, prevents a future class of bugs.
>
> **Muratori:** And the flag Z=0 issue — it's been "R20 may extend to 10 bytes" since R19. The SIZE_FLAG struct has been stable long enough that expanding it won't break anything. Add 2 bytes for posZ, making SIZE_FLAG = 10. Simple wire format change.

---

## Run 1 Findings: Validated / Challenged / Corrected

| Run 1 # | Finding | Run 1 Sev | Run 2 Verdict | Notes |
|----------|---------|-----------|---------------|-------|
| W-1 | prediction.reconcile() never called | CRITICAL | **❌ INCORRECT** | Called via `window.__tribesReconcile` in index.html. Full pipeline is wired. |
| CM-1 | prediction.js is 140 lines of dead code | CRITICAL | **❌ INCORRECT** | Module is live. reconcile() measures divergence, applyPendingCorrection() writes to WASM. inputHistory is vestigial (not dead module). |
| GF-1 | Prediction fundamentally disconnected | CRITICAL | **❌ PARTIALLY INCORRECT** | Divergence measurement + smooth correction are live. Input replay is still missing. Reclassify as HIGH (missing replay, not missing everything). |
| S-3 | decodeDelta mutates input buffer | CRITICAL | **VALIDATED → LOW** | Safe in single-threaded JS. Fragile by design but not an active bug. |
| GF-5 | No entity interpolation for remote players | CRITICAL | **VALIDATED** | No interpolation in JS networking stack. WASM may or may not smooth internally. |
| S-1 | Ping interval leak on reconnect | HIGH | **VALIDATED** | setInterval ID not stored, not cleared in onclose. Accumulates on reconnect. |
| W-2 | Client tick ≠ server tick | HIGH | **VALIDATED** | No tick mapping. Current reconciliation doesn't need it (position comparison only). Future replay does. |
| C-1 | No connection state machine | HIGH | **VALIDATED** | State spread across 5 variables. No formal state enum. |
| C-3 | No sequence numbers | HIGH | **VALIDATED** | No out-of-order detection. Fine for TCP/WebSocket; blocks UDP migration. |
| C-4 | Delta is full snapshot | HIGH | **VALIDATED** | `encodeDelta = encodeSnapshot + type byte overwrite`. Zero bandwidth savings. |
| GF-2 | 60Hz input wasteful | HIGH | **VALIDATED** | Server ticks at 30Hz. Half the inputs are inter-tick noise. |
| GF-3 | No input redundancy | HIGH | **VALIDATED** | Single input per packet. No loss resilience. |
| JC-1 | WebSocket wrong transport | HIGH | **VALIDATED** | TCP head-of-line blocking. WebRTC DataChannel is the evolution path. |
| JC-2 | Bandwidth doesn't scale to 64 | HIGH | **VALIDATED** | 91 KB/s per client, 5.7 MB/s total server outbound at 64 players. |
| MA-1 | Decode creates object graphs | HIGH | **VALIDATED** | ~306 allocations per 64-player decode. 12K allocs/sec at 40Hz. GC pressure. |
| MA-2 | network.js mixes 4 responsibilities | HIGH | **VALIDATED** | Connection, dispatch, input, telemetry, voice bridge all in one file. |
| S-2 | Input loop double-start race | MEDIUM | **VALIDATED** | Brief window of no input loop on rapid reconnect. |
| W-3 | getLatestSnapshot() unused | MEDIUM | **VALIDATED** | Exported, never imported. Dead API. |
| W-4 | prediction.reset() zeroes tick | MEDIUM | **VALIDATED** | Breaks input ordering on reconnect to same match. |
| W-5 | Voice globals in network.js | MEDIUM | **VALIDATED** | 10 `window.__voice*` globals. Belongs in voice.js. |
| C-2 | Flag Z = 0 | MEDIUM | **VALIDATED** | posZ hardcoded to 0. Missing horizontal Z coordinate. |
| C-5 | No disconnect/timeout detection | MEDIUM | **VALIDATED** | lastMessageAt tracked but never checked against timeout. |
| GF-4 | No jitter buffer | MEDIUM | **VALIDATED** | Snapshots applied immediately. No smoothing for irregular arrival times. |
| JC-3 | Telemetry is kitchen-sink state | MEDIUM | **VALIDATED** | Skill ratings, match state, and bandwidth metrics all in one object. |
| JC-4 | Ping measurement wrong | MEDIUM | **VALIDATED** | serverTs - clientTs ≠ RTT. Should be Date.now() - clientTs. |
| CM-3 | decodeSnapshot allocates heavily | MEDIUM | **VALIDATED** | ~306 allocs for 64 players. Run 1 said 321 — close enough. |
| CM-4 | No wire format version | MEDIUM | **VALIDATED** | flags byte is unused (always 0). Could serve as version. |
| MA-3 | inputProvider allocates per call | MEDIUM | **VALIDATED** | 120 object allocations/sec on input path. |
| S-4 | String length ≠ byte count | LOW | **VALIDATED** | UTF-8 multi-byte chars undercount bandwidth telemetry. |
| S-5 | No max on onMessageHandlers | LOW | **VALIDATED** | Handlers accumulate on hot reload. No cap. |
| MA-4 | Sliding windows use shift() | LOW | **VALIDATED** | O(n) shift for ~40 elements. Ring buffer would be O(1). |

**Score: 3 findings INCORRECT, 1 severity reduction, 27 findings VALIDATED.**

---

## New Findings Not in Run 1

| # | Finding | Severity | Description |
|---|---------|----------|-------------|
| N1 | prediction.reconcile() IS wired via index.html | CRITICAL (correction) | Overturns Run 1's headline finding. Full prediction pipeline is live: reconcile() measures divergence, applyPendingCorrection() writes corrections to WASM via Module._setLocalPlayerNetCorrection. |
| N2 | `start()` event handler cross-contamination | HIGH | On double-call, old socket's event handlers reference the module-level `socket` variable, which now points to the new socket. Old onclose could null the new socket. Must call `socket.close()` before overwriting. |
| N3 | `inputHistory` is vestigial, not dead | MEDIUM | Populated by `recordInput()` 60x/sec but never read by `reconcile()`. Intended for future replay-based reconciliation. ~10 lines of functional but unused code — NOT 140 lines of dead module. |
| N4 | index.html creates Float32Array view on every reconcile | MEDIUM | Lines 4353-4358 in index.html: `new Float32Array(Module.HEAPF32.buffer, ...)` is called inside both the reconcile callback AND the applyPendingCorrection callback — every snapshot and every frame. That's 60+ Float32Array allocations/sec just for the WASM bridge. Should use a cached view. |
| N5 | `applyPendingCorrection` runs in independent rAF | LOW | Lines 4364-4377 in index.html: correction is applied in its own `requestAnimationFrame` loop, not synchronized with the main render loop. If the render loop runs at 144Hz and this rAF runs at 60Hz (different monitor), correction application may lag behind rendering. Should be called from the render loop, not a separate rAF. |
| N6 | Wire format ready for phases | INFO | `matchState` byte in snap header can encode phase directly. 17 reserved bytes available for phase-specific data. No wire changes needed for basic phase support. |
| N7 | 64-player bandwidth: 91 KB/s per client | HIGH | Manageable on dedicated server but tight for Cloudflare Workers. Real delta compression would cut 60-80%. Player-presence bitmask optimization another 30-50%. |
| N8 | `getLocalPlayerWasm` duplicated in index.html | LOW | The same WASM bridge function (read player pos/rot from HEAPF32) is defined twice as inline anonymous functions — once in `__tribesReconcile`, once in the rAF loop. Should be a shared helper. |

---

## Priority Reassessment (Run 2)

With the prediction correction, the priority landscape shifts significantly:

| Priority | Action | Run 1 | Run 2 |
|----------|--------|-------|-------|
| **P0** | Fix `start()` idempotency (close old socket, clear ping interval) | P1 (partial) | **P0** — active reconnect bug |
| **P0** | Fix ping measurement formula | P1 | **P0** — wrong RTT displayed to user |
| **P1** | Store ping interval ID, clear in onclose | P1 | **P1** — leak on reconnect |
| **P1** | Entity interpolation for remote players | P0 | **P1** — still the biggest gameplay gap, but requires new module |
| **P2** | Fix flag Z=0 (expand SIZE_FLAG to 10B) | P2 | **P2** — flags shifted on Z axis |
| **P2** | Fix decodeDelta buffer mutation | P1 | **P2** — safe today, fragile for future |
| **P2** | Cache Float32Array view in index.html reconcile bridge | — | **P2** — 60+ unnecessary allocs/sec |
| **P3** | Move voice globals to voice.js | P1 | **P3** — cleanup, no functional impact |
| **Removed** | "Wire prediction.reconcile() into snapshot handler" | P1 | **ALREADY DONE** — exists in index.html |
| **Removed** | "Wire applyPendingCorrection() into render loop" | P1 | **ALREADY DONE** — exists in index.html |

---

*Run 2 complete. 30 Run 1 findings reviewed: 3 INCORRECT (prediction "dead code" claims), 1 severity reduction (buffer mutation), 27 VALIDATED. 8 new findings added. The prediction pipeline IS live — this changes the entire audit narrative for the networking stack from "fundamentally broken" to "functional with significant optimization opportunities." The true critical gap is entity interpolation for remote players.*
