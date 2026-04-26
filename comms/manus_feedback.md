# Manus Feedback — Round 21: Production Deploy + First Public Playtest (SONNET)

**MODEL:** **SONNET 4.6** (1M context)
**Severity:** Major — first contact with real users
**Type:** Implementation + ops — actually deploy to Cloudflare Workers, run a synthetic load test, instrument observability, and prep the user for inviting friends

---

## 1. Context

Round 20 landed multiplayer polish and CF Workers deploy scaffolding (`server/cloudflare/{worker.ts, lobby_do.ts, wrangler.toml, README_DEPLOY.md}`). The server runs locally via Bun. The CF Workers Durable Object scaffold compiles cleanly but has not been deployed.

Round 21 takes the project from "runs on localhost" to "runs on tribes.example.workers.dev." This is the first round where the user's friends could click a link and play.

---

## 2. Concrete tasks

### 2.1 P0 — One-command deploy script (~25 min)

Create `server/cloudflare/deploy.sh` that:
1. Verifies `wrangler` CLI is installed (offers `npm i -g wrangler` if not)
2. Verifies user is authenticated (`wrangler whoami`); if not, prompts `wrangler login`
3. Runs `bun run build` in `server/cloudflare/` to produce a deployable bundle
4. Runs `wrangler deploy` with the existing `wrangler.toml`
5. Prints the deployed URL on success
6. Prints rollback instructions on failure

Make the script idempotent — running twice produces the same final state. Document in `server/cloudflare/README_DEPLOY.md`.

### 2.2 P0 — Frontend deploy to Cloudflare Pages (~25 min)

The browser frontend (`index.html`, `shell.html`, `tribes.js`, `tribes.wasm`, `renderer.js`, `client/*.js`, `assets/*`) needs to be served from somewhere. GitHub Pages currently hosts at `uptuse.github.io/tribes/` but doesn't allow setting `Sec-WebSocket-Protocol` headers we'll want for production. Options:

- **A: Keep GitHub Pages, just point WebSocket to CF Workers** — simplest, no new deploys needed. The WebSocket connection from `client/network.js` to `wss://tribes-server.YOUR.workers.dev/?lobbyId=X` is cross-origin but allowed.
- **B: Deploy frontend to Cloudflare Pages** — same domain as Workers, no CORS, faster CDN, automatic HTTPS. Requires a 5-minute setup with `wrangler pages deploy public/`.

Implement Option A as default (zero migration). Document Option B as a one-page upgrade in `README_DEPLOY.md` for when the user wants the same-origin benefits.

For Option A: update `client/network.js` so that `wss://` URL is read from `window.__TRIBES_SERVER_URL` (set in `index.html` from a build-time constant or query param) instead of being hardcoded to localhost. Default fallback: `wss://${window.location.hostname.replace('uptuse.github.io', 'tribes-server.YOUR.workers.dev')}`.

### 2.3 P0 — Synthetic load test (~30 min)

Create `server/loadtest/headless_client.ts` — a headless WebSocket client that:
- Connects to the production URL
- Joins a test lobby (configurable via `--lobby-id` flag)
- Sends realistic 60Hz inputs for N seconds (mostly forward + occasional jump)
- Logs latency stats (ping p50/p95/p99) and bandwidth observed
- Exits cleanly on `--duration` expiry

Then create `server/loadtest/run.sh` that spawns 100 concurrent `headless_client.ts` instances split across 12 lobbies (8 players each, 4 spillover = realistic load). Captures aggregated stats to `loadtest_results.csv`.

Acceptance: 100 concurrent users for 5 minutes against production. Pass criteria:
- Server CPU per Match DO < 50ms per tick (i.e., 30Hz tick budget honored)
- Snapshot bandwidth per client within 20% of §5.4 estimate
- p95 ping < 80ms (CF edge routing should hold this for US-based load)
- Zero unhandled crashes server-side
- Zero malformed-message exceptions client-side

If load test fails any criterion, document in `open_issues.md` and propose mitigations (smaller per-Match player count, tick-rate reduction, etc.).

### 2.4 P1 — Observability (~30 min)

Wire structured logging in `server/lobby.ts` and `server/cloudflare/lobby_do.ts`:
- Every match start/end emits `[METRIC]` line with `{matchId, durationS, peakPlayers, totalKills, winnerTeam}`
- Every player connect/disconnect emits `[METRIC] {event, playerId, lobbyId, durationS}`
- Every CHEAT-DIVERGE / CHEAT-COOLDOWN / CHEAT-SPEED logs go through a separate `[CHEAT]` prefix
- Every server tick exceeding 33ms (target tick is 33.3ms) logs `[SLOW-TICK] {tickMs, playerCount, projectileCount}`

Then add a dashboard at `server/cloudflare/dashboard.html` (served by the Worker on `GET /dashboard`) that pulls live stats via a small `GET /metrics` endpoint and renders:
- Active matches count
- Total connected players
- Last 10 cheat events
- p95 tick latency
- Snapshot bandwidth aggregate

Auth: simple bearer token passed in URL `?token=X`, set in `wrangler.toml` as a secret. Rotate by user only when needed.

### 2.5 P1 — Discord invite link UI (~15 min)

In `index.html` main menu, add a button "INVITE FRIENDS" that:
- Generates a fresh 6-char lobby ID
- Copies `https://uptuse.github.io/tribes/?multiplayer=remote&lobbyId=ABCD12` to clipboard
- Shows a toast "Link copied — share with friends, lobby waits 60s before destruct"
- Optionally opens a Discord deep-link (`discord://-/share?text=...`) if Discord is installed

This is the user-facing primitive that makes the project shareable.

### 2.6 P2 — First-time-user tutorial overlay (~25 min)

If `localStorage.getItem('tribes:tutorialDone') !== 'v1'`, show a 3-step in-game overlay on first deploy match:
1. "WASD to move, Space to jump, Z to ski" — dismissible after 5 sec
2. "Hold Mouse2 to jet (uses energy)" — dismissible after 5 sec
3. "Press 1-5 for weapons, Mouse1 to fire, F to grab/cap flag" — dismissible after 5 sec

After all dismissed, set `localStorage.setItem('tribes:tutorialDone', 'v1')`. Skippable with `Esc`.

### 2.7 P2 — Health check endpoint (~10 min)

`GET /health` on the Worker returns JSON `{status: 'ok'|'degraded', activeMatches, totalPlayers, uptimeS, version}`. This lets the user (or external uptime monitor) verify the server is alive without joining a lobby.

### 2.8 P3 — README rewrite (~15 min)

Rewrite the project root `README.md` for someone clicking the GitHub link cold:
- One-line description
- Live URL
- 3-line "How to play"
- 5-line "How it works" (WASM + Three.js + CF Workers DO)
- "Run locally" section
- "Contribute" section
- License (already MIT)
- Credits (link to `assets/CREDITS.md`)

---

## 3. Acceptance criteria (must hit 7 of 9)

1. `server/cloudflare/deploy.sh` runs end-to-end against a fresh CF account (idempotent verified)
2. Deployed Worker URL responds to `GET /health` with valid JSON
3. Frontend (`uptuse.github.io/tribes/?multiplayer=remote`) connects to deployed Worker over WSS, joins lobby
4. Two browser tabs from different machines (or different incognito sessions) play together via the deployed server
5. Synthetic load test runs cleanly with 100 concurrent users for 5 minutes; CSV output present
6. Observability dashboard at `/dashboard?token=X` renders live stats from a real match
7. INVITE FRIENDS button copies a working URL that loads the correct lobby
8. Tutorial overlay shows on first match, persists `localStorage`, never re-shows after
9. `README.md` rewritten and renders correctly on GitHub

---

## 4. Compile/grep guardrails

- `! grep -nE 'EM_ASM[^(]*\$1[6-9]'` (legacy carry-over)
- `bun build server/cloudflare/worker.ts` clean
- `wrangler deploy --dry-run` passes (validates wrangler.toml schema + bundle size)
- `bun run server/loadtest/headless_client.ts --help` runs
- README.md passes `markdownlint` if installed

---

## 5. Time budget

120-180 min Sonnet round. The deploy work is mostly mechanical. The load test is the longest pole.

---

## 6. Decision authority for ambiguities

- **If wrangler-CLI auth fails non-interactively in deploy.sh:** prompt user via `echo` and exit gracefully; don't try to auth in script.
- **If load test reveals tick budget overrun:** halve player count from 8 to 4 per match; document and rerun. R22 will optimize.
- **If GitHub Pages serves with `Cross-Origin-Opener-Policy` issues:** document migration to Cloudflare Pages as urgent in `open_issues.md`; user may run `wrangler pages deploy` immediately.
- **If CF Workers free-tier limits get hit during load test (1M req/day):** document, abort gracefully, recommend upgrade to paid tier ($5/mo) for sustained testing.

---

## 7. Roadmap context

- **R21 (this round):** production deploy + first public playtest infrastructure
- **R22 (Sonnet):** real bot AI (TS port of R14 A*), feedback from first playtest, balance tuning
- **R23+ (Sonnet):** voice chat, ranked matches, custom maps, replay system

After R21 lands, the project is **shareable**. The user can post the URL anywhere and people can play it.
