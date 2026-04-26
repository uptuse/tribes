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

## R2 storage for shared replays (R28)

Shared replays (the "Share Replay" button on match-end) persist to a
Cloudflare R2 bucket when the following env vars / secrets are set;
otherwise the server falls back to a 7-day in-memory store (data is
lost on restart).

### One-time setup
```bash
# 1. Create the R2 bucket
wrangler r2 bucket create tribes-replays

# 2. Create an R2 API token in the CF dashboard:
#    https://dash.cloudflare.com → R2 → Manage R2 API Tokens → Create API token
#    Permissions: Object Read & Write, scoped to tribes-replays bucket.
#    Copy the access key + secret access key — you only see the secret once.

# 3. Push the credentials as Worker secrets (production)
wrangler secret put R2_ACCOUNT_ID         # CF dashboard → right sidebar
wrangler secret put R2_BUCKET             # tribes-replays
wrangler secret put R2_ACCESS_KEY_ID
wrangler secret put R2_SECRET_ACCESS_KEY
```

### Local dev
```bash
# Bun reads the same names from the process environment
export R2_ACCOUNT_ID=…
export R2_BUCKET=tribes-replays
export R2_ACCESS_KEY_ID=…
export R2_SECRET_ACCESS_KEY=…
bun run server/lobby.ts
```

The server logs `[R2] persistence enabled` on startup when all four are
set, or `[R2] env vars not set — using in-memory replay store` otherwise.

### Implementation note

`server/r2.ts` ships a hand-rolled SigV4-over-fetch implementation
because `@aws-sdk/client-s3` has had recurring compatibility issues
with the Workers fetch implementation. R2 is S3-compatible at the wire
level, so the same SigV4 signing works against the R2 endpoint.

### Daily TTL sweep

The current implementation sets `x-amz-meta-ttlExpiresAt` on each
upload (7-day window). A scheduled Worker is the natural home for the
sweep; left as TODO until it becomes operationally necessary. Until
then expired keys remain in R2 (cheap — full bucket fits in free tier
for 1000+ replays).

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
