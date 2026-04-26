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
}

export { LobbyDO };

export default {
    async fetch(request: Request, env: Env): Promise<Response> {
        const url = new URL(request.url);

        if (url.pathname === '/health') {
            return Response.json({ status: 'ok', service: 'tribes-lobby', uptime: 'edge' });
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
