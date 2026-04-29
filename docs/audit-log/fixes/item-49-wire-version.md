# Item 49 — Wire Format Version Field

**Revision:** R32.261  
**File:** `client/wire.js`  
**Commit:** `feat(R32.261): add wire format version field for protocol evolution`

## Problem

The flags byte (offset 1 in the 8-byte wire header) was always 0 — written but never read meaningfully. Without a version field, there's no way to detect client-server protocol mismatches, which will be critical as the wire format evolves (e.g., for input redundancy, UDP migration).

## Solution

Repurposed the flags byte as a wire protocol version field:

1. **`WIRE_VERSION = 1`** — new exported constant. Version 0 means "legacy/unversioned server."
2. **`writeHeader()`** — now stamps `WIRE_VERSION` in byte[1] of every outgoing message (replaces the hardcoded `0` flags parameter)
3. **`_trackServerVersion()`** — called on each decoded snapshot, records the server's version byte
4. **`getLastServerVersion()`** — public API returning the last observed server version (0 = legacy)
5. **`checkVersionMismatch()`** — returns `true` if server version ≠ 0 AND ≠ WIRE_VERSION
6. Version mismatch is logged once via `console.warn` — not rejected — for graceful degradation

## Backwards Compatibility

**Critical constraint:** The server is compiled WASM; we cannot change what it sends.

- Server always sends `0` in the flags/version byte → `_lastServerVersion = 0`
- `checkVersionMismatch()` treats version 0 as "compatible" → no false positives
- Client now sends `1` in the same byte → old servers that ignore this byte are unaffected (the server reads `type` from byte[0] and `payloadLen` from bytes[2-3]; byte[1] was always ignored)
- When the server eventually starts stamping its own version, the client is ready to detect mismatches

## Future Work

- When the WASM server is rebuilt, stamp `WIRE_VERSION` in server-sent messages
- Add a UI toast/banner when `checkVersionMismatch()` returns true ("please refresh your browser")
- Version bumps when wire format changes (input redundancy, snapshot sequences, etc.)
