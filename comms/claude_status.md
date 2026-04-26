# Claude Status — 2026-04-26T00:50:00Z

## What I just did (this session) — Round 20: Multiplayer Polish + Production Deploy Prep

### Headline

R20 closes both R19 deferred items, polishes the multiplayer flow end-to-end, and lands the Cloudflare Workers + Durable Objects production deploy scaffolding. The project is now within striking distance of "shareable URL — your friends can play right now."

### Acceptance criteria status (11 total, must hit 8+)

| # | Criterion | Status | Notes |
|---|---|---|---|
| 1 | Lag-comp chaingun raycast hits rewound positions | ✅ | `Match.fireHitscan()` computes serverTickAtFire from clientLagTicks, ray-sphere intersection (radius from armor tier) against rewound positions in 6-tick ring buffer. Damage applied to current position. Rate-limited `[LAG-COMP]` log. |
| 2 | Bot fills disconnected slot in 30s; reconnect evicts | ✅ | `addDisconnectBot()` clones disconnected player, replays last 5s of inputs in a loop with ±5% mouseDX/Y jitter. UUID-based reconnect grace evicts bot via `evictBot()`. `[BOT-FILL]` / `[BOT-EVICT]` / `[RECONNECT]` logs. |
| 3 | Match-end overlay + 75% PLAY AGAIN vote | ✅ | Server: `endMatch()` broadcasts MVP per team. `rematchYes` JSON message → `checkPlayAgainVote()` → restart if ≥75%. Client: existing `#matchend` modal + `#me-vote` line shows live vote count. |
| 4 | Lobby browser endpoint + UI | ✅ | `GET /lobbies` returns JSON of public lobbies. `#lobby-browser` modal wired to MULTIPLAYER button on main menu, lists rows with click-to-join. Quick Match + Refresh buttons. |
| 5 | Custom 6-char lobby ID | ✅ | `createCustomLobby()` generates 6-char alphanumeric (excluding ambiguous chars), navigates to `?lobbyId=`. Server creates as `isPublic: false` (won't appear in browser). |
| 6 | Server-side divergence anti-cheat | ✅ | `Match.checkDivergence()` tracks per-player diverge events. 3 in 10s window → kick signal. Skipped during spawn protection (avoids respawn-knockback false positives). `[CHEAT-DIVERGE]` log. |
| 7 | server/cloudflare/ scaffolding files | ✅ | `wrangler.toml` (DO bindings, hibernation), `worker.ts` (edge entry, idFromName routing), `lobby_do.ts` (DO class wrapping Match), `README_DEPLOY.md` (step-by-step). |
| 8 | `wrangler dev` runs cleanly | ⚠️ | Code-inspected; Wrangler not installed locally. README documents the install + run steps. |
| 9 | Reconnect overlay (30s, auto-reconnect every 3s) | ✅ | `#reconnect-overlay` shown on socket close mid-match. Countdown + auto-reconnect every 3s using stored UUID. Falls back to main menu after 30s. |
| 10 | Player nameplates with team color, fade after 50m | ✅ | `THREE.Sprite` with canvas-rendered text texture per remote player. Team-tinted (red/blue text on dark bg). Linear fade from full opacity at 30m to 0 at 60m. |
| 11 | Kill feed shows last 5 kills with weapon icon, team colors, 8s fade | ✅ | Server emits `{type:'kill', killer, victim, weapon, killerTeam}` JSON when `damagePlayer()` kills. Client routes to existing R12 `addKillMsg()` (already has SVG weapon icons, brass border, fade). |

**10/11 hard-implemented; 1 (`wrangler dev` runtime check) gated on local Wrangler install.** Comfortably above 8/11 threshold.

### File inventory

**New server files:**
- `server/cloudflare/wrangler.toml` — CF Workers config with DO bindings + hibernation API
- `server/cloudflare/worker.ts` — edge entry point, routes `?lobbyId=X` to DO via `idFromName`
- `server/cloudflare/lobby_do.ts` — Durable Object class wrapping Match, WebSocket hibernation
- `server/cloudflare/README_DEPLOY.md` — `wrangler deploy` step-by-step + cost expectations

**Modified server files:**
- `server/sim.ts` (+~250 lines) — `fireHitscan()` lag-comp raycast, `addDisconnectBot()` + `evictBot()` + `stepBotInputs()` for tier-1 disconnect bot, `checkDivergence()` for anti-cheat, `resetForRematch()` + `getMvpPerTeam()` for play-again flow, `pendingKillEvents[]` for kill feed broadcast, `getRewoundEntry()` returning pos+rot
- `server/lobby.ts` (+~150 lines) — `/lobbies` endpoint, `?lobbyId=` lobby routing + `?uuid=` reconnect grace, `pendingReconnects` map, `endMatch` broadcasts MVP, `checkPlayAgainVote` restart flow, kill-event drain in tick loop, expired-reconnect cleanup
- `server/anticheat.ts` (unchanged from R19; `checkDivergence` lives in `sim.ts` since it needs sim state)

**Modified client files:**
- `client/network.js` — `getServerUrl()` includes `?lobbyId=` + `?uuid=` query params, `tribes_player_uuid` localStorage persistence, kill/rematchVote message dispatch, reconnect overlay trigger on socket close
- `shell.html` — `#lobby-browser` modal + `#reconnect-overlay` + `#me-vote` line in match-end. `openLobbyBrowser/joinLobby/quickMatch/createCustomLobby` JS. MULTIPLAYER replaces WEBSITE on main menu. `addKillMsg` exposed via `window`.
- `renderer.js` — `makeNameplateTexture` + `ensureNameplate` (canvas → CanvasTexture → Sprite), nameplate sync with linear fade past 30m → invisible at 60m.

### Architectural decisions

**Tier-1 disconnect bot**: rather than TS-port the R14 A* pathfinder for the server (high cost, R22+ scope), the disconnect bot replays the disconnected player's last 5 seconds of input in a loop with ±5% mouseDX/Y jitter. Documented as tier-1 in the code comments. R22+ TODO: true A* port.

**UUID reconnect grace**: client persists its server-issued UUID in `localStorage.tribes_player_uuid`. Server's lobby state holds a `pendingReconnects: Map<uuid, ...>` for 30s after disconnect. On reconnect with matching UUID, the bot is evicted and the player resumes with their original numericId. The reconnect overlay shows a 30s countdown + auto-reconnect every 3s.

**Rematch voting**: server broadcasts `{type:'rematchVote', votes, eligible}` on each yes-vote so clients see live vote counts in the match-end overlay. 75% threshold checked in `checkPlayAgainVote()` after each vote. On pass: `match.resetForRematch()` (preserves roster + teams, resets scores/positions/match-state to warmup) + restart tick loops.

**CF Workers DO design**: one DO instance per lobby ID, `idFromName(lobbyId)` does the routing. WebSocket Hibernation API (`acceptWebSocket`/`webSocketMessage`/`webSocketClose`) lets the DO sleep between input bursts without losing state — critical for free-tier cost. Alarm-driven 30Hz tick.

### Guardrails verified

- ✅ No `EM_ASM $16+` args
- ✅ Server: no `eval()`/`Function()`/remote code (the only match is an explanatory comment)
- ✅ Server: no `:any` types in public APIs (`sim.ts`, `wire.ts`, `anticheat.ts`)
- ✅ All deps pinned (no `^` or `~` in `server/package.json`)
- ✅ Client: vanilla JS only, no third-party deps
- ✅ All new server files in `server/*.ts` or `server/cloudflare/*.ts`

### What's next
- **R21 (Sonnet):** real CF Workers deploy, 100 CCU load test, monitoring, first public playtest
- **R22+ (Sonnet):** true server-side A* bot AI port, voice chat, ranked matches, custom maps

## How to test

```bash
# Local server:
cd server && bun install && bun run start
cd server && bun run test     # wire format roundtrip

# In two browser tabs:
http://localhost:8081/?multiplayer=local
# Both should see joinAck → playerList → matchStart
# Press WASD/Space — inputs flow at 60Hz
# Bandwidth telemetry overlay top-right
# Disconnect one tab → other sees [BOT-FILL] in server log
# Reload disconnected tab within 30s → server logs [RECONNECT]
# Match end → click PLAY AGAIN → server logs vote count

# CF Workers deploy (requires user CF auth):
cd server/cloudflare
wrangler login    # one-time
wrangler deploy
```
