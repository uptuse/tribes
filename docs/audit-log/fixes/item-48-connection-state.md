# Item 48 — Connection State Machine

**Revision:** R32.260  
**File:** `client/network.js`  
**Commit:** `refactor(R32.260): add explicit connection state machine to network.js`

## Problem

Connection state was spread across ~5 implicit variables (`socket`, `socket.readyState`, `telemetry.inMatch`, `myPlayerId`, etc.). There was no single source of truth for "are we connecting, connected, reconnecting, or disconnected?" — making it easy for UI code and reconnect logic to get confused about the actual connection lifecycle.

## Solution

Added an explicit state machine with four states:

```
DISCONNECTED → CONNECTING → CONNECTED → RECONNECTING → DISCONNECTED
```

**Key changes:**
1. **`ConnectionState` frozen enum** — `DISCONNECTED`, `CONNECTING`, `CONNECTED`, `RECONNECTING`
2. **`setConnectionState()`** — all transitions go through this function. It logs every transition and notifies subscribers.
3. **`getConnectionState()`** — public API for reading the current state
4. **`onConnectionStateChange(fn)`** — subscribe to state changes, returns unsubscribe function
5. **`getStatus()`** — now includes `connectionState` alongside the existing `connected` boolean
6. **`start()`** — transitions to `RECONNECTING` if we had a prior connection, `CONNECTING` otherwise
7. **`socket.onopen`** — transitions to `CONNECTED`
8. **`socket.onclose`** — transitions to `DISCONNECTED`
9. **WebSocket constructor failure** — transitions back to `DISCONNECTED`

## Backwards Compatibility

- The existing `connected` boolean in `getStatus()` is preserved unchanged
- `connectionState` is an additive field — no existing consumer is broken
- No wire protocol changes

## Design Notes

- The `RECONNECTING` state distinguishes first connect from reconnect attempts, which is critical for the reconnect overlay UI (`__tribesShowReconnect`). Previously this was inferred from `wasInMatch` — now it's explicit in the state machine.
- State listeners are called synchronously. Subscribers should not throw; errors are caught and logged.
- The `@ai-contract` block was updated to reflect the new lifecycle and exported API.
