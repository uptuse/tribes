# Manus Feedback — Round 20: Multiplayer Polish + Production Deploy Prep (SONNET)

**MODEL:** **SONNET 4.6** (1M context)
**Severity:** Standard
**Type:** Implementation — close R19 deferred items, polish multiplayer flow, prep for production deploy on Cloudflare Workers + Durable Objects

---

## 1. Context

Round 19 shipped a working multiplayer loop end-to-end (9/11 hard-implemented, accepted). Two items were deferred:
- **Lag-comp raycast against rewound positions** — algorithm wired, ray trace deferred
- **Bot AI fill on disconnect** — would have needed TS port of R14 A* pathfinding

Round 20 closes those, adds the polish that makes a multiplayer match feel finished, and starts the path to a real production deploy on Cloudflare Workers Durable Objects.

The project is now within striking distance of "shareable URL — your friends can play right now." That's the R20 finish line.

---

## 2. Concrete tasks (in priority order)

### 2.1 P0 — Close R19 deferred: lag-comp raycast (~30 min)

In `server/sim.ts`, the ring buffer captures last 6 ticks of player positions. R19 wired the rewind lookup but the raycast against rewound positions is a stub. Implement:

- For chaingun (hitscan) fire input arriving with `clientTick=N`:
  1. Compute `serverTickAtFire = clamp(currentServerTick - clientLagTicks, currentServerTick-6, currentServerTick)` where `clientLagTicks = round((rttMs/2) / 33.3)`.
  2. Look up all opponents' positions at `serverTickAtFire` from the ring buffer (each Match maintains `playerPositionHistory: Map<playerId, RingBuffer<{tick, pos, rotPYR}>>`).
  3. For each opponent, build a sphere primitive at the rewound position with radius derived from their armor tier (light=0.5m, medium=0.7m, heavy=0.9m).
  4. Trace the fire ray (origin = rewound shooter eye position, direction = rewound shooter forward) against each opponent sphere using ray-sphere intersection (closed-form quadratic).
  5. First hit (smallest positive t < weapon range = 200m for chain) wins. Apply damage to that opponent at their **current** position (no rewind on damage application — only on hit detection).
  6. Log `[LAG-COMP] shooter=X target=Y rewindMs=Z` for the first hit per second per shooter (rate-limit logging to avoid spam).

For projectile weapons (disc, plasma, grenade, mortar), no lag-comp needed — projectiles are server-authoritative from spawn. R19 already handles this correctly.

Acceptance test: synthetic test where shooter Tab A fires chaingun while moving at target Tab B with simulated 100ms latency. Expected: hit registers when Tab A's reticle was over Tab B's position 100ms ago, even if B has moved since.

### 2.2 P0 — Close R19 deferred: bot fill on disconnect (~30 min)

When a human player disconnects mid-match and within 30s no reconnect occurs:
- Spawn a "tier-1 disconnect bot" — a server-side ghost that mirrors a randomly-chosen human's behavior: replay their last 5 sec of inputs in a loop with ±5% jitter on mouseDX/Y to disguise the loop.
- Don't TS-port the full A* pathfinding now — that's R22+. The loop-replay bot satisfies the disconnect-handling acceptance criterion and is documented as "tier 1 disconnect bot" in `open_issues.md` with a R22+ TODO for true A* port.
- On reconnect with same player UUID within 30s, kill the bot and restore player control.

Acceptance test: Tab A disconnects mid-match → server logs `[BOT-FILL] replacing playerId=X with botId=Y` → after 30s, no reconnect → bot remains. Tab A reconnects within 30s → `[BOT-EVICT] botId=Y → playerId=X resumed`.

### 2.3 P1 — Match end → return to lobby flow polish (~25 min)

R19's match-end currently returns clients to "main menu state." Polish:
- After server broadcasts `subType: matchEnd`, client renders a 5-second match-end overlay with team scores, MVP per team (highest kills), and a "PLAY AGAIN" button (active for 60 seconds).
- If 75%+ of players click "PLAY AGAIN" within 60s, server auto-restarts the match with same teams (full sim reset, fresh warmup).
- If not enough votes, all clients return to the lobby browser (R20.4 below). Server destroys the Match instance, lobby remains empty for 30s before destruction.
- Keyboard: `Y` = play again, `N` = return to lobby, `Esc` = leave server entirely.

### 2.4 P1 — Lobby browser (~30 min)

Currently clients connect with a fixed URL. Add a public lobby browser:
- New endpoint `GET /lobbies` on the server returns JSON `[{id, playerCount, maxPlayers, mapName, isPublic, createdAt}, ...]`.
- New `LobbyBrowser` UI in `index.html` and `shell.html` — modal that lists open public lobbies, click to join.
- "Create Custom Lobby" button generates a 6-char alphanumeric ID, navigates to `?multiplayer=remote&lobbyId=ABCD12`. The lobby is created on first connect and is `isPublic: false` (won't appear in browser).
- "Quick Match" button connects to the highest-pop public lobby with available slots, or creates one if all are full.

### 2.5 P1 — Server-side input replay validation (~20 min, anti-cheat hardening)

For every input received, server stores the last 6 ticks of inputs per player. After applying inputs and ticking sim, if reconciliation diverges between server-computed position and client-acked position by > 2.0m or > 30° rotation **without legitimate cause** (knockback, teleport, death), log `[CHEAT-DIVERGE] playerId=X delta=Y`. Three sustained diverge events in a 10-second window → kick player.

This catches clients that fabricate snapshot acks or run modified physics. Document threshold in `server/anticheat.ts` with a comment explaining false-positive risk.

### 2.6 P2 — Production deploy scaffolding (~40 min)

Add `server/cloudflare/` directory with:
- `wrangler.toml` for CF Workers + Durable Objects deployment
- `worker.ts` — entry point that maps `?lobbyId=X` to a Durable Object instance via `env.LOBBY_DO.idFromName(lobbyId).get()`
- `lobby_do.ts` — Durable Object class wrapping the existing `Match` from `server/sim.ts`. WebSocket hibernation API to stay free-tier-friendly when matches are idle.
- `README_DEPLOY.md` — step-by-step `wrangler deploy` instructions, env-var setup, custom domain mapping
- Test command: `wrangler dev` runs CF Workers locally on `:8787`, validates the DO routing works

Don't actually deploy. Just ensure the scaffolding is correct enough that `wrangler deploy` would succeed. Real deploy is the user's next step (requires CF account auth).

### 2.7 P2 — Reconnection grace UI (~15 min)

When a client gets a `disconnect` event from server (or WebSocket closes unexpectedly), client shows a 30-second reconnect overlay with countdown. Auto-attempts reconnect every 3 sec using stored `playerUUID`. On successful reconnect, hides overlay and resumes. After 30s of failure, falls back to "Connection lost" main menu.

### 2.8 P3 — Player nameplate above heads (~15 min)

In `renderer.js`, render player names as floating text labels (`THREE.Sprite` with canvas-rendered text texture) above each remote player's head. Local player's own name not shown. Color text by team (red/blue). Fade nameplate distance after 50m.

### 2.9 P3 — Kill feed (~15 min)

Top-right corner of HUD: 5-line scrollable kill log. Each kill renders as `[Killer] [WeaponIcon] [Victim]` where Killer/Victim are colored by team. Lines fade out after 8 sec. Server emits per-frame `kills` array in snapshot trailer (extend snapshot wire format if needed; document in `network_architecture.md` §5.7).

---

## 3. Acceptance criteria (must hit 8 of 11)

1. Lag-comp chaingun raycast hits rewound position within 200ms latency window (synthetic test passes)
2. Bot fills disconnected slot within 30s; reconnect within 30s evicts bot
3. Match-end overlay shows team scores + MVP, has working PLAY AGAIN with 75% vote threshold
4. Lobby browser endpoint returns valid JSON; UI lists lobbies and allows joining
5. Custom lobby creation with 6-char ID and `isPublic: false` works
6. Server-side reconciliation divergence anti-cheat logs and kicks on sustained abuse
7. `server/cloudflare/` directory contains valid `wrangler.toml`, `worker.ts`, `lobby_do.ts`, `README_DEPLOY.md`
8. `wrangler dev` runs cleanly on `:8787` and routes `?lobbyId=X` to a DO instance (run command exists; if wrangler not installed locally, code-inspect only)
9. Reconnect overlay with 30s countdown appears on disconnect; auto-reconnect every 3s; resumes on success
10. Player nameplates render above remote players with team color, fade after 50m
11. Kill feed shows last 5 kills in top-right with weapon icon, team colors, 8s fade

---

## 4. Compile/grep guardrails

- `! grep -nE 'EM_ASM[^(]*\$1[6-9]'` (legacy carry-over)
- `bun build server/lobby.ts` and `bun build server/cloudflare/worker.ts` both clean, no type errors
- `bun run test` (existing wire.test.ts + new lag-comp.test.ts) passes
- All new server files in `server/*.ts`; cloudflare extras in `server/cloudflare/*.ts`
- All new client files in `client/*.js`, ES modules, no globals beyond what's already exposed
- Pin all new dependencies in `package.json` (no `^` or `~` floats)

---

## 5. Time budget

90-150 min Sonnet round. Split:
- Lag-comp raycast: 30 min
- Bot fill (loop-replay tier-1): 30 min
- Match-end + play-again: 25 min
- Lobby browser: 30 min
- Anti-cheat divergence: 20 min
- CF Workers scaffolding: 40 min
- Reconnect UI: 15 min
- Nameplates: 15 min
- Kill feed: 15 min

If you run out of time, ship in priority order. P0 + P1 = MVP for the round.

---

## 6. Decision authority for ambiguities

- **If the loop-replay bot looks too obvious to other players in playtest:** add a small randomization to inputs (jitter mouseDX/Y by ±5%) to disguise it. R22+ may upgrade to true A* port.
- **If lag-comp causes "shot through walls" complaints:** add a server-side LOS pre-check before applying lag-comp damage (raycast against static building geometry from rewound shooter position to current target position). Document if added.
- **If CF Workers Durable Object cold-start latency is > 500ms:** document in `open_issues.md`; mitigation is to keep one warm DO per region (cron-pinged every 30s). Don't implement unless it becomes a problem.
- **If wrangler.toml schema changes (CF updates frequently):** check Cloudflare docs and use the latest non-deprecated format.

---

## 7. Roadmap context

- **R20 (this round):** multiplayer polish + production deploy scaffolding
- **R21 (Sonnet, next):** real CF Workers deploy + tune for 100 CCU + monitoring + first public playtest
- **R22+ (Sonnet):** bot AI A* TS port (real multiplayer bots), voice chat, ranked matches, custom maps

After R20 lands, the project ships to public via `wrangler deploy` and a Cloudflare Pages frontend. That's the v1.0 milestone.
