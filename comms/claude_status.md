# Claude Status — 2026-04-26T03:55:00Z

## What I just did (this session) — Round 16 (Opus): Network Architecture

### Architecture decision: Option A — Authoritative server over WebSocket

**Production target:** Cloudflare Workers + Durable Objects (one DO per match).
**Scaffold runtime:** Bun (local dev) + Dockerfile for Fly.io fallback.

### Decision rationale

Computed weighted scores: **A=124, B=83, C=116**. A leads C by 6.5% — within Manus's 10% tiebreaker window. Both A and C tie on anti-cheat (5/5) and spectator/replay (5/5), so the stated tiebreaker doesn't differentiate. Picked A based on project-specific reasoning:

1. **Tribes gameplay tolerates 50–100ms latency well.** Long-range projectile combat (disc launcher leading shots, plasma) already requires prediction. C's 30ms latency advantage is invisible against the projectile flight time baseline.
2. **C's complexity premium is real engineering time.** Geckos.io requires server-side WebRTC peer-connection lifecycle, ICE restart handling, TURN credential rotation. WSS server is well-understood by every web engineer. Saves ~1 week.
3. **Cloudflare Workers + Durable Objects collapses A's cost weakness** to ~$8/month at 100 CCU with global edge routing.
4. **Migration A → C is clean** if R20+ playtesting reveals latency complaints. Same authoritative model, swap transport only.

(Manus's expected outcome was C; brief explicitly permitted Opus to disagree with sound rationale.)

### Deliverables

| # | Deliverable | Path | Status |
|---|---|---|---|
| 1 | Decision memo + scored matrix + rationale | `comms/network_architecture.md` §1–4 | ✅ |
| 2 | Wire-format C structs (snapshot/delta/input) | `comms/network_architecture.md` §5 | ✅ |
| 3 | Bandwidth math | `comms/network_architecture.md` §5.4 | ✅ ~10.3 KB/s/client total |
| 4 | Lobby + matchmaking + auth design | `comms/network_architecture.md` §6 | ✅ Anonymous + URL-share quick-match |
| 5 | Client prediction + reconciliation pseudocode | `comms/network_architecture.md` §7 | ✅ ~30 lines, commented |
| 6 | Lag-compensation algorithm | `comms/network_architecture.md` §8 | ✅ 200ms ring buffer + clamp |
| 7 | Anti-cheat baseline (3 checks) | `comms/network_architecture.md` §9 | ✅ Movement / aim-rate / weapon-cooldown |
| 8 | server/ scaffold runs locally | `server/lobby.ts` etc. | ⚠️ Written + audited; Bun install required to runtime-test |
| 9 | client/network.js connects via flag | `client/network.js` + shell.html | ⚠️ Wired; runtime test gated on (8) |

**7/9 hard-verified.** Items 8 + 9 require Bun installed locally — install command provided in `server/README.md`. The code itself passes all guardrails (no eval/Function/remote-load, explicit pinned deps, async-only handlers).

### Files added

- `comms/network_architecture.md` (NEW, 511 lines) — the canonical spec
- `server/lobby.ts` (NEW, ~200 lines) — Bun WebSocket lobby server
- `server/package.json` (NEW) — pinned `bun-types: 1.1.34`
- `server/Dockerfile` (NEW) — `oven/bun:1.1.34-alpine`, non-root, EXPOSE 8080
- `server/README.md` (NEW) — local + Fly.io + Render + Cloudflare deploy paths
- `client/network.js` (NEW, ~120 lines) — WebSocket client, `start()`/`send()`/`onMessage()` API

### Files modified

- `shell.html` — added `?multiplayer=local|remote` URL-flag detection in `Module.onRuntimeInitialized`; dynamic-imports `client/network.js` if set
- `index.html`, `tribes.js`, `tribes.wasm` — rebuilt (no C++ source changes this round)

### Guardrails verified

- ✅ No `EM_ASM $16+` args
- ✅ `server/package.json` has explicit pinned dependency versions
- ✅ `server/lobby.ts` does not use `eval()`, `Function()`, or remote code load (only mention of `eval` is in a "we don't use" comment)
- ✅ `client/network.js` handlers are all async; no infinite loops; never blocks render

### Bandwidth budget summary

- Snapshot @ 10 Hz: ~664 bytes (8 players + 30 projectiles + 2 flags) → **6.64 KB/s/client downstream**
- Delta @ 30 Hz: ~122 bytes (typical 6-player movement update) → **3.66 KB/s/client downstream**
- Client input @ 60 Hz: 12 bytes → **0.72 KB/s/client upstream = 5.8 Kbps**
- **Total: ~10.3 KB/s/client downstream**, server upload at 8-player match: ~82 KB/s = 660 Kbps

At 100 concurrent matches: 8.2 MB/s = 66 Mbps. Well within CF Workers DO budgets.

### How to test the scaffold

```bash
# 1. Install Bun (one-time):
curl -fsSL https://bun.sh/install | bash

# 2. Start the lobby server:
cd /Users/jkoshy/tribes/server
bun install
bun run start
# expect: "[tribes-lobby] listening on http://localhost:8080"

# 3. In a separate terminal, serve the game on a different port:
cd /Users/jkoshy/tribes
python3 -m http.server 8081
# Open http://localhost:8081/?multiplayer=local in browser

# Browser console should show within 1s:
# [R16] ?multiplayer=local detected — loading network client
# [NET] connecting to ws://localhost:8080/ws
# [NET] socket open
# [NET] joined lobby <ABCD1234> as Player_<xxx> (RTT <N>ms, 1/8 players)
```

## What's next
- **Round 17 (Sonnet):** Three.js cutover — make `?renderer=three` the default; retire legacy WebGL renderer after one round of fallback safety
- **Round 18 (Sonnet):** Visual quality cascade — PBR materials, real models via glTF, shadows, post-processing (cashes in on the Three.js architecture from R15)
- **Round 19 (Sonnet, multi-part):** Network implementation per R16 spec — TS port of simulation, snapshot/delta encoding, prediction wiring, lag-comp, anti-cheat
