# Tribes Browser Edition — Fly.io Runbook

**Live deploy:** https://firewolf-tribes.fly.dev/
**App name:** `firewolf-tribes`  ·  **Region:** `ord` (Chicago)  ·  **Org:** `personal`

This document covers what is shipped, how to play together, how to update the
deploy, and how to monitor / debug the running instance.

---

## 1. Architecture in one paragraph

A single Bun process (the `lobby.ts` server, ~3 600 LoC of TypeScript) serves
both the static game (HTML/WASM/JS/textures) under `GET /` and the
authoritative multiplayer WebSocket under `GET /ws`. The same process runs
the 30 Hz simulation tick, broadcasts 10 Hz keyframe snapshots and 30 Hz
delta frames using a custom binary protocol (`wire.ts` / `client/wire.js`),
holds skill ratings, replay buffers, and the moderation/anti-cheat layer.
Everything lives in one Fly.io machine: `shared-cpu-1x`, 256 MB RAM,
auto-stops when idle, cold-starts in ~1 s on the next request.

| Layer | Where | Notes |
|---|---|---|
| Game client | `index.html` + `tribes.{js,wasm,data}` + `renderer*.js` + `vendor/three/r170/` | served from `/app/public` inside the container |
| Multiplayer protocol (binary) | `server/wire.ts` re-exports `client/wire.js` | join, snapshot, delta, fire, hit, chat, voice |
| Authoritative sim | `server/sim.ts` | 30 Hz, jet-physics-aware, hit-scan + projectile, terrain queries |
| Lobby + matchmaking | `server/lobby.ts` | rooms, MIN_PLAYERS_TO_START=2, MAX=8 per lobby |
| Skill / tiers | `server/skill.ts`, `server/tiers.ts` | Glicko-2, Bronze→Diamond bands |
| Anti-cheat | `server/anticheat.ts` | velocity strikes, soft-mute, blocklist |
| Moderation | `server/moderation.ts` | wordlist, reports, audit log |
| Replays | `server/r2.ts` | optional Cloudflare R2 storage gate |
| Static fallback | bottom of `lobby.ts` `serveStatic()` | serves `STATIC_DIR` at any unmatched route |

---

## 2. How to play together

1. Send your friend the URL: **https://firewolf-tribes.fly.dev/?multiplayer=local**
2. Both of you open it in a Chromium-based browser (Chrome / Edge / Brave).
   Firefox works but WebGL2 perf is lower.
3. Click **PLAY GAME → MULTIPLAYER → QUICK START**. The server auto-pairs you
   into the same lobby once two clients connect within ~30 s. As soon as the
   second player joins, `MIN_PLAYERS_TO_START = 2` triggers `matchStart` and
   the simulation begins on Raindance.
4. To force a private 2-player room, append `&lobbyId=PICKANYTHING`:
   `https://firewolf-tribes.fly.dev/?multiplayer=local&lobbyId=ROOM42`.
5. To explicitly point the client at a different server (for testing
   forks), use `&server=wss://other-host.fly.dev/ws`.

> The `?multiplayer=local` flag is a misnomer — it really means "use the
> URL the bootstrap script in `index.html` resolves to." On the live deploy
> that resolves to `wss://firewolf-tribes.fly.dev/ws` automatically.

### Default keybinds

| Key | Action |
|---|---|
| WASD | Move |
| Space | Jet (hold by default; toggle in Settings) |
| Shift | Ski (hold to ski downhill) |
| Mouse | Aim |
| LMB | Fire primary |
| RMB | Fire secondary / scope |
| 1-5 | Weapon select |
| T | Chat (text) |
| Z / X / C | Voice macros |
| Esc | Menu |
| F2 | Graphics settings |

---

## 3. Updating the deploy (the workflow)

The deploy is a single `fly deploy` command from `/home/ubuntu/tribes/`.
Auth is already cached in `~/.fly/config.yml` for the sandbox. From your own
machine:

```bash
# one-time setup on a new machine
curl -fsSL https://fly.io/install.sh | sh
export PATH="$HOME/.fly/bin:$PATH"
fly auth login

# deploy any code change
cd /path/to/tribes
fly deploy --remote-only --depot=false --ha=false
```

The first deploy uploads ~125 MB of build context (mostly the
`assets/textures/terrain` 4K PBR set) over the slow sandbox-to-Fly link.
Subsequent deploys re-use the BuildKit layer cache, so if you only change
`server/lobby.ts`, the texture layers don't re-upload — typical incremental
deploys take 30-60 s.

### What gets shipped

The `Dockerfile` at the project root copies exactly:

| Layer | Size | Cache key |
|---|---|---|
| `oven/bun:1.1.34-alpine` base | 38 MB | unchanged |
| `server/package.json` + `bun install` | 60 MB node_modules | invalidates on dep changes |
| `server/*.ts` | 1 MB | invalidates on server edits — **fastest layer to bust** |
| `client/*.js` | 1 MB | invalidates on netcode edits |
| `index.html` + `tribes.{js,wasm,data}` + `renderer*.js` | 9 MB | invalidates when the WASM bundle changes |
| `vendor/three/r170/` | 6 MB | rarely changes |
| `assets/maps/raindance/` + `assets/sfx/` + HDRI + 5 PBR terrain sets + buildings | 125 MB | stable; rarely changes |

**Tip:** if you only edit server logic, make sure the `Dockerfile` order
puts `COPY server/*.ts` AFTER all the heavy `COPY assets/*` lines so the
cache invalidation hits only the small layer. (It is, in the shipped
file.)

### Speeding up cold transfers

If you're going to iterate heavily on netcode and want sub-30 s deploys,
move the giant `assets/textures/terrain` directory to S3 / Cloudflare R2
and update `Dockerfile` to skip the COPY (and update the in-game loader to
fetch from the CDN). I have not done this — 408 MB image is well within
Fly's free-tier limits.

### Rolling back

```bash
fly releases -a firewolf-tribes        # list versions
fly deploy --image registry.fly.io/firewolf-tribes:deployment-<id>
```

Fly keeps every successful image indefinitely.

---

## 4. Configuration knobs

All set via env vars in `fly.toml` or `fly secrets set`:

| Var | Default | Purpose |
|---|---|---|
| `PORT` | `8080` | Bun listen port (Fly maps 80/443 → 8080 automatically) |
| `STATIC_DIR` | `/app/public` | Where the static-file fallback reads from |
| `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET` | unset | Enables persistent replay storage. Without these, replays live in memory and disappear on restart. |
| `ADMIN_TOKEN` | unset | Required to hit `/admin/*` endpoints (kick, ban, wordlist edit) |
| `MIN_PLAYERS_TO_START` | `2` | Match auto-starts at this many players in a lobby |
| `MAX_PLAYERS_PER_LOBBY` | `8` | Hard cap |
| `TICK_HZ` | `30` | Simulation tick rate |
| `SNAPSHOT_HZ` | `10` | Keyframe broadcast rate |
| `DELTA_HZ` | `30` | Delta broadcast rate |

To set a secret without redeploying:
```bash
fly secrets set ADMIN_TOKEN=$(openssl rand -hex 32) -a firewolf-tribes
```

---

## 5. Monitoring & debugging

```bash
# tail server logs in real time
fly logs -a firewolf-tribes

# machine status / health
fly status -a firewolf-tribes
fly machine list -a firewolf-tribes

# SSH into the running container
fly ssh console -a firewolf-tribes
# inside, you can: cd /app/server && bun run lobby.ts manually,
# tail /tmp/lobby.log, curl http://localhost:8080/health, etc.

# scale up if needed
fly scale memory 512 -a firewolf-tribes      # bump RAM to 512 MB
fly scale count 1 --max-per-region 1 -a firewolf-tribes
```

The `/health` endpoint returns:
```json
{
  "status": "ok",
  "activeMatches": 0,
  "totalPlayers": 0,
  "uptimeS": 37.7,
  "version": "R21",
  "lobbies": 0,
  "connections": 0
}
```

Hit it from anywhere: `curl https://firewolf-tribes.fly.dev/health`.

`/metrics` (Prometheus-style text) exposes per-match rates, dropped-tick
counts, hit-reg false-positive counters, and bandwidth per player.

---

## 6. Auto-stop / cold-start

`auto_stop_machines = "stop"` is set in `fly.toml`. The machine **stops**
after ~5 minutes with zero connections (saves you from burning free-tier
hours when nobody is playing). The next inbound request **starts it again**
in roughly 1 s. If you want zero cold-start latency for your friend, set:

```toml
[http_service]
  auto_stop_machines = "off"
  min_machines_running = 1
```

…but then the machine bills full-time against the free tier (still free as
long as it's the only `shared-cpu-1x` you run).

---

## 7. Local development

```bash
cd /home/ubuntu/tribes/server
PORT=8082 STATIC_DIR=/home/ubuntu/tribes bun run lobby.ts
# game at http://localhost:8082/
# WS  at ws://localhost:8082/ws
```

The bootstrap script in `index.html` (lines 540-580) detects the URL
pattern of the page and constructs the right WebSocket URL automatically:

- HTTPS page → WSS on the same origin under `/ws` (production)
- Manus sandbox `https://NNNN-XXX.manus.computer` → swaps the port prefix to
  point at the lobby's exposed port
- HTTP `localhost:8082` → `ws://localhost:8082/ws`

If anything breaks the auto-resolve, override with `?server=wss://...`.

### Two-tab smoke test

```bash
# tab 1
open 'http://localhost:8082/?multiplayer=local'
# tab 2
open 'http://localhost:8082/?multiplayer=local'
# both will land in the same lobby; matchStart fires at 2/8
```

Or scripted via Bun (no browser):
```bash
cd /home/ubuntu/tribes && bun run server/test_bot.ts
# connects to ws://localhost:8082/ws and prints joinAck / playerList /
# binary snapshot frame sizes
```

---

## 8. Known limitations

- **256 MB RAM** is enough for ~6 concurrent matches × 8 players. Past that,
  bump to 512 MB (`fly scale memory 512`).
- **Single region** (Chicago). Players >150 ms away will feel lag despite
  the netcode's prediction + reconciliation. Add Fly machines in `fra` and
  `syd` if you have transatlantic / transpacific friends.
- **No persistent replay storage** by default. Set the `R2_*` env vars to
  enable.
- **No SSO support** for Fly.io org tokens — used `personal` org instead. If
  you ever migrate this app to your work org, you'll need
  `flyctl tokens create org <slug>`.
- **Image is 408 MB.** Could be reduced to ~50 MB by moving the PBR terrain
  set to a CDN. Not worth it for a personal deploy.

---

## 9. Files I touched in this session

| File | Change |
|---|---|
| `Dockerfile` | NEW — full-stack container recipe |
| `.dockerignore` | NEW — keeps build context lean |
| `fly.toml` | NEW — Fly.io deploy config |
| `RUNBOOK.md` | NEW — this document |
| `server/lobby.ts` | restricted WS upgrade to `/ws` only; added `serveStatic()` fallback for `STATIC_DIR` |
| `index.html` | smarter `window.__TRIBES_SERVER_URL` resolution (sandbox port-prefix swap, prod same-origin); cache-buster bump to `R32.293-multiplayer` |
| `server/test_bot.ts` | NEW — minimal Bun WS client for headless smoke tests |

Everything else is the prior R28 work, preserved as-is.
