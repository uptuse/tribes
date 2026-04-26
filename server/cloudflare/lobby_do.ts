// ============================================================
// Lobby Durable Object — wraps the existing server/sim.ts Match
// for Cloudflare Workers + Durable Objects deployment.
//
// One DO instance per lobby ID. The DO holds the authoritative Match
// state in memory. WebSocket hibernation API lets the DO sleep between
// messages without losing state — keeps free-tier costs low when the
// match is paused or between bursts of input.
//
// State persistence: in-memory only for R20 scaffold. R21+ may add
// `state.storage.put('snapshot', encoded)` for crash recovery.
// ============================================================

import { Match } from '../sim.ts';
import { decodeInput } from '../wire.ts';
import { TICK_HZ, SNAPSHOT_HZ, DELTA_HZ, MATCH_END_REMATCH_HOLD_SEC } from '../constants.ts';

interface SocketState {
    playerId: string;
    numericId: number;
    name: string;
    team: number;
    uuid: string;
}

const MAX_PLAYERS = 8;

export class LobbyDO {
    state: DurableObjectState;
    env: any;
    match: Match | null = null;
    sockets = new Map<WebSocket, SocketState>();
    numericIdNext = 0;
    tickAlarmScheduled = false;

    constructor(state: DurableObjectState, env: any) {
        this.state = state;
        this.env = env;
        // Resume any hibernated WebSockets
        const hibernated = state.getWebSockets();
        for (const ws of hibernated) {
            const data = ws.deserializeAttachment() as SocketState | null;
            if (data) this.sockets.set(ws, data);
        }
    }

    async fetch(request: Request): Promise<Response> {
        const url = new URL(request.url);
        if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
            return new Response('Expected WebSocket', { status: 426 });
        }
        const pair = new WebSocketPair();
        const [client, server] = [pair[0], pair[1]];
        const uuid = url.searchParams.get('uuid') || (crypto.randomUUID());
        const numericId = this.numericIdNext++;
        const playerId = uuid.slice(0, 8);
        const sockState: SocketState = {
            playerId, numericId, uuid,
            name: `Player_${playerId}`,
            team: this.sockets.size % 2,
        };
        this.sockets.set(server, sockState);
        // Hibernation API: server-side acceptance
        this.state.acceptWebSocket(server);
        server.serializeAttachment(sockState);

        // Send joinAck JSON
        server.send(JSON.stringify({
            type: 'joinAck',
            playerId, numericId, uuid,
            name: sockState.name,
            lobbyId: 'CF-DO',
            capacity: MAX_PLAYERS,
            memberCount: this.sockets.size,
            serverTime: Date.now(),
        }));

        // Auto-start match when 2+ connected (R20 simplified)
        if (!this.match && this.sockets.size >= 2) {
            this.startMatch();
        }
        this.scheduleTick();
        return new Response(null, { status: 101, webSocket: client });
    }

    startMatch() {
        this.match = new Match();
        for (const sock of this.sockets.values()) {
            this.match.addPlayer(sock.numericId, sock.name, sock.team, 0, sock.uuid);
        }
        this.broadcast(JSON.stringify({
            type: 'matchStart',
            lobbyId: 'CF-DO',
            players: [...this.match.players.values()].map(p => ({ id: p.id, name: p.name, team: p.team, armor: p.armor })),
            serverTime: Date.now(),
        }));
    }

    scheduleTick() {
        // Use alarm API to drive the simulation tick. Wakes the DO from hibernation.
        if (!this.tickAlarmScheduled) {
            this.state.storage.setAlarm(Date.now() + (1000 / TICK_HZ));
            this.tickAlarmScheduled = true;
        }
    }

    async alarm() {
        this.tickAlarmScheduled = false;
        if (this.match) {
            this.match.tickSimulation();
            // Snapshot every 3rd tick (10Hz at 30Hz tick), delta every tick (30Hz)
            if (this.match.tick % 3 === 0) this.broadcast(this.match.serializeSnapshot());
            this.broadcast(this.match.serializeDelta());
        }
        // Reschedule
        if (this.sockets.size > 0) this.scheduleTick();
    }

    webSocketMessage(ws: WebSocket, msg: string | ArrayBuffer) {
        const sock = this.sockets.get(ws);
        if (!sock) return;
        if (msg instanceof ArrayBuffer) {
            const u8 = new Uint8Array(msg);
            const input = decodeInput(u8);
            if (input && this.match) {
                this.match.applyInput(sock.numericId, input);
            }
            return;
        }
        // JSON control message
        try {
            const obj = JSON.parse(String(msg));
            if (obj.type === 'ping') ws.send(JSON.stringify({ type: 'pong', clientTs: obj.clientTs, serverTs: Date.now() }));
        } catch { /* drop */ }
    }

    webSocketClose(ws: WebSocket, _code: number, _reason: string, _wasClean: boolean) {
        const sock = this.sockets.get(ws);
        this.sockets.delete(ws);
        if (sock && this.match) {
            // R20: tier-1 disconnect bot
            const player = this.match.players.get(sock.numericId);
            if (player) {
                this.match.addDisconnectBot(player);
                this.match.removePlayer(sock.numericId);
            }
        }
    }

    webSocketError(ws: WebSocket, _err: unknown) {
        try { ws.close(1011, 'error'); } catch { /* */ }
        this.sockets.delete(ws);
    }

    broadcast(payload: string | Uint8Array) {
        for (const ws of this.sockets.keys()) {
            try { ws.send(payload as any); } catch { /* socket gone */ }
        }
    }
}
