# Tribes Lobby + Match Server

WebSocket lobby + authoritative simulation. **R16 + R19** — full multiplayer
loop: connection → lobby → match → snapshots/deltas/inputs → match-end.

## Local development

Requires [Bun](https://bun.sh) ≥ 1.1.0:

```bash
# One-time install (macOS / Linux)
curl -fsSL https://bun.sh/install | bash

# Run
cd server
bun install
bun run start

# Run wire-format tests
bun run test
```

Server listens on `http://localhost:8080`.
WebSocket endpoint: `ws://localhost:8080/ws`
Health check: `http://localhost:8080/health` (lobby/connection/active match counts)

## R19 simulation tick rates

- Server simulation: **30 Hz** (33ms tick)
- Snapshot broadcast: **10 Hz** (~664B per snapshot for 8 players + 30 projectiles)
- Delta broadcast: **30 Hz** (~122B per delta — R19 uses simplified deltas; full bitmask deltas R20+)
- Client input: **60 Hz** (12B per input message)
- Total bandwidth per client: ~10 KB/s downstream + 0.7 KB/s upstream

## R19 file layout

| File | Purpose |
|------|---------|
| `lobby.ts` | WebSocket server, lobby management, match lifecycle, tick loops, input routing |
| `sim.ts` | Authoritative simulation: player physics, projectiles, flags, match state |
| `wire.ts` | Binary protocol encode/decode (re-exports from `client/wire.js`) |
| `quant.ts` | Quantization helpers (re-exports from `client/quant.js`) |
| `constants.ts` | Shared gameplay constants (re-exports from `client/constants.js`) |
| `anticheat.ts` | Speed/aim-rate/cooldown/sanity checks |
| `wire.test.ts` | Roundtrip encode/decode test (run via `bun run test`) |

## Verify with the client

```bash
# In one terminal:
cd server && bun run start

# In another terminal, serve the game:
cd .. && python3 -m http.server 8080 --bind 127.0.0.1 --directory . 8081
# Open http://localhost:8081/?multiplayer=local
# Browser console should log: [NET] joined lobby <id> as <player>
```

(If you serve the game on the same port as the server, change one of them — both use 8080 by default.)

## Production deployment

### Option A: Fly.io (recommended for global edge)

```bash
fly launch --no-deploy --copy-config --name tribes-lobby
fly deploy
```

`fly.toml` (created by `fly launch`):
- Add `[[services]] internal_port = 8080`
- Add `[[services.ports]] handlers = ["http"]; port = 80`
- Add `[[services.ports]] handlers = ["tls", "http"]; port = 443`
- Set `auto_stop_machines = true` for cost saving on inactivity

### Option B: Render / Railway

Push to a Git repo containing this directory, then in the Render dashboard:
- New Web Service → connect repo → root = `server/`
- Runtime: Docker
- Port: 8080
- Auto-deploy from main branch

### Option C: Cloudflare Workers + Durable Objects (long-term scale target)

Not yet implemented in this scaffold. The migration path is documented in
`comms/network_architecture.md`. Bun's `WebSocket` API and CF Workers'
WebSocket API are nearly identical, so the port is straightforward when
the simulation moves server-side in R19.

## Wire format

R16 uses JSON for all lobby messages (low frequency, easy to debug).
R19 will switch the high-frequency game-state path to binary
DataView-packed snapshots/deltas as specified in
`comms/network_architecture.md` §5.

## Security notes

- No `eval()`, no `Function()` constructor, no remote code load.
- All inbound JSON is parsed with try/catch; malformed input is silently dropped.
- Inbound names are sanitized (allowed: `\w \- _ . space`, max 32 chars).
- Inbound chat is length-capped at 200 chars.
- All dependencies have explicit pinned versions in `package.json`.
- Container runs as non-root `app` user.
- No secrets, no auth tokens, no environment-dependent code paths in the scaffold.
