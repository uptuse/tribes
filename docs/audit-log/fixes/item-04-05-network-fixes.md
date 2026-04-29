# Items 4+5 Review — network.js Idempotency + Ping Fix (R32.157)

**Change:** 3 surgical edits to `client/network.js` (~20 lines added). Items 4+5 are in the same file and tightly coupled.
**Panel:** Carmack, Muratori (small change — Pass 1 + Pass 4)

---

## Pass 1 — Break It

**Saboteur:**
- **S1 (Low):** The idempotency guard nulls `socket.onclose` before calling `socket.close()`. This means if there's cleanup logic in onclose that should fire (like reconnect overlay), it won't. **Verdict:** This is intentional. When `start()` is called while a socket is open, we're deliberately reconnecting — the old connection's close shouldn't trigger reconnect UI. The new socket's onclose will handle that.
- **S2 (None):** `stopInputLoop()` is called at the start of `start()`. This is safe — `stopInputLoop` already guards against null `inputLoop` (line 284: `if (inputLoop) { clearInterval(inputLoop); inputLoop = null; }`).
- **S3 (Low):** The ping fix changes from `msg.serverTs - msg.clientTs` to `Date.now() - msg.clientTs`. This assumes `msg.clientTs` is the same `Date.now()` that was sent in the ping message — it is (line ~247: `{ type: 'ping', clientTs: Date.now() }`). Server echoes `clientTs` back unchanged in the pong. Verified.
- **S4 (None):** `Date.now()` gives wall-clock milliseconds. If the server delays the pong, we measure true RTT including server processing time. This is correct for latency measurement.

**Wiring Inspector:**
- **W1 (None):** `pingLoop` is declared at module scope alongside `inputLoop`. Same lifecycle pattern. Clean.
- **W2 (None):** No exports changed, no import signatures changed. All consumers unaffected.
- **W3 (Note):** The telemetry overlay in renderer_polish.js reads `window.NET_TELEM.pingMs`. This will now show actual RTT instead of clock skew. Users who compared this to browser devtools RTT will see it match now.

## Pass 4 — System-Level Review

**Before Item 4:** If player spam-clicks "Play" or reconnect fires while socket is still open: two WebSocket connections open simultaneously, two ping intervals ticking, first connection leaks until garbage collected. Each reconnect adds +1 leaked interval (500ms each → memory/CPU leak).

**After:** Clean teardown-before-reconnect. Socket count: always 0 or 1. Ping interval: always 0 or 1.

**Before Item 5:** `pingMs` showed (server_time - client_time), e.g., server is 120ms ahead of client → "120ms ping". If clocks were synchronized, it showed ~0ms. If client was ahead, it showed negative. Useless as latency.

**After:** Shows actual round-trip time. If server takes 30ms to process and network adds 20ms each way → 70ms displayed. Correct.

---

## Verdict: ✅ PASS — Clean, correct, no regressions.
