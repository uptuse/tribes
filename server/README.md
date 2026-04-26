# Tribes Lobby Server

Minimal WebSocket lobby server. **R16 scaffold** — connection plumbing only; game-state networking lands in R19.

## Local development

Requires [Bun](https://bun.sh) ≥ 1.1.0:

```bash
# One-time install (macOS / Linux)
curl -fsSL https://bun.sh/install | bash

# Run
cd server
bun install
bun run start
```

Server listens on `http://localhost:8080`.
WebSocket endpoint: `ws://localhost:8080/ws`
Health check: `http://localhost:8080/health`

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
