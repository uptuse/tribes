// ============================================================
// Cloudflare Workers entry point — routes WebSocket connections
// to per-match Durable Object instances.
//
// URL → DO mapping:
//   - /ws?lobbyId=ABC123  → DO(idFromName('ABC123'))
//   - /ws (no lobbyId)    → DO(idFromName(matchmakeName(...)))   [stub matchmaker]
//   - /lobbies            → returns public-lobby JSON (R20+ implementation)
//   - /health             → liveness probe
// ============================================================

import { LobbyDO } from './lobby_do.ts';

export interface Env {
    LOBBY_DO: DurableObjectNamespace;
    DASHBOARD_TOKEN?: string;   // wrangler secret: `wrangler secret put DASHBOARD_TOKEN`
}

// R21: minimal observability dashboard. Per-DO stats can be added in R22+.
const DASHBOARD_HTML = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Tribes Edge Dashboard</title>
<style>body{font:14px -apple-system,sans-serif;background:#0a0a08;color:#E8DCB8;padding:20px}
h1{color:#D4A030;letter-spacing:3px;font-weight:300}.note{color:#7a6a4a;font-size:0.9em}</style></head>
<body><h1>TRIBES EDGE DASHBOARD</h1>
<p class="note">Edge Worker dashboard. Per-Durable-Object metrics ship in R22+.<br>
For local Bun-server metrics, point at <code>http://localhost:8080/dashboard</code>.</p>
</body></html>`;

export { LobbyDO };

export default {
    async fetch(request: Request, env: Env): Promise<Response> {
        const url = new URL(request.url);

        if (url.pathname === '/health') {
            // R21: per brief — {status, activeMatches, totalPlayers, uptimeS, version}
            // Edge Workers don't have global state — these are stub values
            // (real numbers live in each Durable Object).
            return Response.json({
                status: 'ok',
                service: 'tribes-lobby',
                version: 'R21',
                edge: true,
                uptimeS: 0,
                activeMatches: 0,
                totalPlayers: 0,
                note: 'Per-DO metrics: GET /lobbies/<id>/metrics',
            });
        }
        if (url.pathname === '/dashboard') {
            // Bearer-token-gated, see R21 brief §2.4
            const token = url.searchParams.get('token') || '';
            if (!env.DASHBOARD_TOKEN || token !== env.DASHBOARD_TOKEN) {
                return new Response('unauthorized', { status: 401 });
            }
            return new Response(DASHBOARD_HTML, { headers: { 'content-type': 'text/html' } });
        }

        if (url.pathname === '/lobbies') {
            // R20: stub. Real implementation requires durable-storage index of public lobbies.
            // R21+ adds a tiny KV-backed lobby registry.
            return Response.json([], { headers: { 'access-control-allow-origin': '*' } });
        }

        if (url.pathname === '/' || url.pathname === '/ws') {
            const lobbyId = (url.searchParams.get('lobbyId') || quickMatchName()).toUpperCase();
            const id = env.LOBBY_DO.idFromName(lobbyId);
            const stub = env.LOBBY_DO.get(id);
            // Forward the request to the DO; it handles the WebSocket upgrade
            return stub.fetch(request);
        }

        return new Response('Tribes Lobby (Cloudflare Edge). WebSocket: /ws  Browse: /lobbies', { status: 200 });
    },
};

// Stub matchmaker — picks one of N quick-match buckets. R21 will replace
// with actual cross-DO lobby coordination via KV.
function quickMatchName(): string {
    const buckets = ['QM-A', 'QM-B', 'QM-C', 'QM-D'];
    return buckets[Math.floor(Math.random() * buckets.length)];
}
