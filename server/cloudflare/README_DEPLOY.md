# Cloudflare Workers + Durable Objects Deployment

This directory contains the production-deploy scaffolding for the Tribes
lobby + match server on Cloudflare Workers + Durable Objects.

**Status:** R20 scaffolding only — never been deployed. Real deploy
requires the user's Cloudflare account auth.

## Architecture

```
edge:  Cloudflare Worker (worker.ts)
         ↓ idFromName(lobbyId)
edge:  Durable Object instance (LobbyDO in lobby_do.ts)
         ↓ wraps
shared: Match class (../sim.ts) — same authoritative simulation
        as the local Bun server, no fork.
```

One DO instance per lobby ID. The DO holds the Match in memory.
Cloudflare's WebSocket Hibernation API lets the DO sleep between input
messages without losing state — keeps free-tier costs low when matches
are paused or between bursts of input.

## Files

| File | Purpose |
|------|---------|
| `wrangler.toml` | CF Workers config — DO bindings, compatibility date, observability |
| `worker.ts`     | Edge entry point. Routes `?lobbyId=X` → DO via `idFromName` |
| `lobby_do.ts`   | Durable Object class wrapping `Match`. Implements `webSocketMessage` / `webSocketClose` for hibernation |

## Deploy steps

```bash
# 1. One-time install (if not already)
npm install -g wrangler

# 2. Authenticate with your CF account
wrangler login

# 3. Deploy from this directory
cd server/cloudflare
wrangler deploy

# Output should look like:
# ✨ Successfully deployed to https://tribes-lobby.<your-account>.workers.dev
```

## Local development

```bash
cd server/cloudflare
wrangler dev
# Local edge simulator on :8787
# Test: open ws://localhost:8787/ws?lobbyId=TEST in a WebSocket client
```

## Custom domain mapping

Once deployed, in the CF dashboard:
1. Workers & Pages → tribes-lobby → Triggers → Custom Domains
2. Add `lobby.your-domain.com`
3. Update `client/network.js` `getServerUrl()` to point at the new domain

## Cost expectations

- **Free tier**: 100,000 DO requests/day
- **Workers Paid ($5/mo)**: 10M DO requests/mo, 12.5M DO duration-units/mo

At 100 concurrent users in 12 active matches (8p each):
- Snapshots: 10/s × 12 matches = 120/s = 10.4M/day → exceeds free tier
- Inputs (server-side processing): 60/s × 100 = 6000/s = 518M/day

You will need Workers Paid for any meaningful playtest. Budget ~$5-15/mo.

## R21+ TODOs

- KV-backed public lobby registry so `/lobbies` can list all DOs across
  the namespace (current `worker.ts` returns empty `[]`)
- Snapshot-rate adaptive throttling — drop to 5Hz snapshot for inactive
  matches to stay under DO request budget
- Region-aware DO placement (CF auto-selects but we can hint)

## Why DO over Workers KV / D1

A multiplayer match is a stateful WebSocket session that needs to handle
60Hz input from each of N clients and broadcast 10–30Hz snapshots to all.
Stateless Workers can't bridge that. KV is too slow (eventual consistency).
DOs are exactly the right primitive: one stateful actor per lobby, with
WebSocket hibernation built in.
