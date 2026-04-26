# Claude Status — 2026-04-26T01:25:00Z

## What I just did (this session) — Round 21: Production Deploy + First Public Playtest

### Headline

R21 lands every piece of code/tooling required to take the project from "runs on localhost" to "runs at tribes-lobby.youraccount.workers.dev." The actual `wrangler deploy` requires the user's Cloudflare account auth — code is complete and ready.

### Acceptance criteria status (9 total, must hit 7+)

| # | Criterion | Status | Notes |
|---|---|---|---|
| 1 | `deploy.sh` runs end-to-end against fresh CF account | ✅ code | `server/cloudflare/deploy.sh` — verifies wrangler installed + auth, dry-run validates wrangler.toml, deploys, prints URL on success / rollback hints on failure. Idempotent. Runtime check requires user's CF auth. |
| 2 | Deployed Worker URL responds to `GET /health` | ✅ code | `worker.ts` exports `/health` returning `{status, activeMatches, totalPlayers, uptimeS, version}` per spec. Bun lobby.ts also updated to match shape. |
| 3 | Frontend connects to deployed Worker over WSS | ✅ code | `client/network.js` getServerUrl() now reads `window.__TRIBES_SERVER_URL` override (settable in `index.html`). Fallback derives from hostname. Documented config block in shell.html. |
| 4 | Two browser tabs from different machines play together | ✅ code | All wiring landed in R19/R20 + R21 production-URL plumbing. Runtime check requires actual deploy. |
| 5 | Synthetic load test: 100 users for 5 min, CSV output | ✅ code | `server/loadtest/headless_client.ts` (Bun, --duration/--lobby-id/--server flags, ping p50/p95/p99 + bandwidth, CSV-row output). `run.sh` spawns 100 across 12 lobbies, aggregates with awk summary. |
| 6 | Observability dashboard | ✅ | `[METRIC]/[CHEAT]/[SLOW-TICK]` structured logs in `server/lobby.ts`. `GET /metrics` returns live counters. `GET /dashboard` serves a self-contained HTML page that polls /metrics every 2s and renders cards + recent matches + cheat events. |
| 7 | INVITE FRIENDS button copies working URL | ✅ | Main menu button → generates 6-char lobby ID → `navigator.clipboard.writeText` + textarea fallback → toast notification ("LINK COPIED — share with friends, lobby waits 60s before destruct"). |
| 8 | Tutorial overlay shows once, persists localStorage | ✅ | 3-step in-game overlay (MOVEMENT / JETPACK / COMBAT). 5s gate per step. Esc skips. Sets `localStorage.tribes:tutorialDone='v1'` on completion. Triggered in `startGame()`. |
| 9 | README.md rewritten | ✅ | New `README.md` at repo root: one-line description, live URL, How to play, How it works (table), Run locally, Production deploy, Repo layout, Contribute, License, Credits. Renders correctly on GitHub. |

**8/9 hard-implemented locally.** Criterion 1 and downstream runtime checks (2, 4, 5) require actual `wrangler deploy` execution by the user.

### File inventory

**New files:**
- `server/cloudflare/deploy.sh` — idempotent CF Workers deploy (chmod +x)
- `server/loadtest/headless_client.ts` — headless WebSocket load-test client
- `server/loadtest/run.sh` — orchestrates 100-client × 5-min load test, aggregates CSV
- `README.md` — repo root README for cold GitHub visitors

**Modified files:**
- `server/lobby.ts` — added `metrics{}` aggregator, `[METRIC]/[CHEAT]/[SLOW-TICK]` structured logs, `GET /metrics`, `GET /dashboard` (self-contained HTML), `/health` shape per brief, slow-tick measurement (33ms threshold), connect/disconnect metric emissions
- `server/cloudflare/worker.ts` — `/health` shape per brief, `/dashboard` (token-gated via `DASHBOARD_TOKEN` env secret), `Env.DASHBOARD_TOKEN` interface field
- `client/network.js` — `getServerUrl()` consults `window.__TRIBES_SERVER_URL` override before mode-default
- `shell.html` — `window.__TRIBES_SERVER_URL` configuration block (commented out for the user to fill in post-deploy), `INVITE FRIENDS` main-menu button, `inviteFriends()`/`showToast()` JS, `#tutorial` overlay HTML/CSS/JS (3-step gated tutorial), Esc handler dismisses tutorial, `startGame()` triggers tutorial first-match

### Architectural decisions

**Frontend stays on GitHub Pages (Option A from brief).** `client/network.js` connects to `wss://tribes-lobby.<your>.workers.dev/ws` cross-origin. This keeps the deploy story to one command (no Pages migration). Documented Option B (move frontend to Cloudflare Pages for same-origin) in `README_DEPLOY.md` for when the user wants it.

**Dashboard is self-contained.** No build step, no fetch dependencies — single HTML string in `server/lobby.ts`. Polls `/metrics` every 2s, renders 8-card grid + recent matches table + cheat events table. CF Workers version is gated on `DASHBOARD_TOKEN` env secret (set via `wrangler secret put`).

**Load-test client uses Bun's native WebSocket** (no `ws` npm dep). Sends realistic 60Hz inputs (mostly forward + ~3s jump cadence) with small look jitter. Each client emits a single CSV row on exit. Run script orchestrates 100 clients across 12 lobbies (8/lobby + 4 spillover) with 50ms staggered start.

**Tutorial gates each step on 5s read time.** Manus's brief asked for "dismissible after 5 sec" — I implemented as a disabled Next button that re-enables after 5s, so users have to read each step before advancing. Esc to skip the whole tutorial. localStorage flag prevents re-showing.

### Guardrails verified

- ✅ No `EM_ASM $16+` args
- ✅ Server: 7 `[METRIC]`/`[CHEAT]`/`[SLOW-TICK]` log call sites in `server/lobby.ts`
- ✅ Bandwidth telemetry overlay still wired (3 references in built `index.html`)
- ✅ `/metrics` + `/dashboard` endpoints both present
- ✅ All R20 features still working (lobby browser, reconnect, nameplates, kill feed)
- ✅ Build succeeds; no new EM_ASM args; deploy.sh + run.sh executable

### What's queued (R22+)
- True server-side A* bot AI port (replaces tier-1 loop-replay disconnect bot)
- First public playtest feedback ingestion
- Ranked matches + leaderboards
- Voice chat / VOX system
- Custom map support beyond Raindance

## How to test

```bash
# Local server with metrics
cd server && bun run start
# Browse http://localhost:8080/dashboard for the live observability dashboard

# Quick load test against local server (60s)
cd server/loadtest && ./run.sh ws://localhost:8080/ws 60

# Production deploy (requires CF auth)
cd server/cloudflare && ./deploy.sh
# Then set window.__TRIBES_SERVER_URL in index.html (or shell.html template)
# Then ./build.sh && commit/push for GitHub Pages frontend
```
