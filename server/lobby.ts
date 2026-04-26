// ============================================================
// Tribes Browser Edition — Lobby Server (R16 scaffold)
// ============================================================
// Minimal WebSocket lobby server.
// Runtime: Bun 1.1+. Run: `bun run start` (see package.json)
//
// Responsibilities for R16 scaffold:
//   - Listen on port 8080 (configurable via PORT env)
//   - Accept WebSocket connections at /ws or /
//   - Assign each client a fresh player UUID
//   - Place client into an open lobby (capacity 8); create new lobby if all full
//   - Broadcast `playerList` updates to the lobby on join/leave
//   - Echo a JSON `joinAck` to the joining client within 1ms
//
// NOT in this scaffold (deferred to R19):
//   - Game-state networking (snapshots/deltas/inputs)
//   - URL-share friend matches via ?lobbyId=
//   - Bot fill on disconnect
//   - Authoritative simulation
//
// Security guarantees:
//   - No eval(), no Function() constructor, no remote code load
//   - All inbound messages are JSON-parsed with try/catch and dropped on error
//   - All dependencies have explicit pinned versions (see package.json)
// ============================================================

const PORT = Number(Bun.env.PORT ?? 8080);
const MAX_PLAYERS_PER_LOBBY = 8;
const LOBBY_INACTIVITY_MS = 30_000;

interface ConnState {
  playerId: string;
  name: string;
  lobbyId: string;
  joinedAt: number;
}

interface Lobby {
  id: string;
  members: Set<string>;          // playerId set
  createdAt: number;
  lastActivity: number;
}

const lobbies = new Map<string, Lobby>();
const connections = new Map<string, { ws: any; state: ConnState }>();

function shortId(): string {
  return Math.random().toString(36).slice(2, 10);
}

function findOrCreateLobby(): Lobby {
  for (const lobby of lobbies.values()) {
    if (lobby.members.size < MAX_PLAYERS_PER_LOBBY) return lobby;
  }
  const lobby: Lobby = {
    id: shortId().toUpperCase(),
    members: new Set(),
    createdAt: Date.now(),
    lastActivity: Date.now(),
  };
  lobbies.set(lobby.id, lobby);
  console.log(`[lobby] created ${lobby.id}`);
  return lobby;
}

function broadcastToLobby(lobbyId: string, msg: object) {
  const lobby = lobbies.get(lobbyId);
  if (!lobby) return;
  const payload = JSON.stringify(msg);
  for (const playerId of lobby.members) {
    const conn = connections.get(playerId);
    if (conn) {
      try { conn.ws.send(payload); } catch { /* socket already gone */ }
    }
  }
}

function buildPlayerList(lobby: Lobby) {
  const players = [...lobby.members].map(pid => {
    const conn = connections.get(pid);
    return { id: pid, name: conn?.state.name ?? '???' };
  });
  return { type: 'playerList', lobbyId: lobby.id, players, capacity: MAX_PLAYERS_PER_LOBBY };
}

function cleanupInactiveLobbies() {
  const now = Date.now();
  for (const [id, lobby] of lobbies) {
    if (lobby.members.size === 0 && (now - lobby.lastActivity) > LOBBY_INACTIVITY_MS) {
      lobbies.delete(id);
      console.log(`[lobby] reaped empty lobby ${id}`);
    }
  }
}
setInterval(cleanupInactiveLobbies, 10_000);

const server = Bun.serve({
  port: PORT,
  fetch(req, srv) {
    const url = new URL(req.url);
    if (url.pathname === '/' || url.pathname === '/ws') {
      const ok = srv.upgrade(req);
      return ok ? undefined : new Response('Upgrade failed', { status: 400 });
    }
    if (url.pathname === '/health') {
      return new Response(JSON.stringify({
        status: 'ok',
        lobbies: lobbies.size,
        connections: connections.size,
        uptime: process.uptime(),
      }), { headers: { 'content-type': 'application/json' } });
    }
    return new Response('Tribes Lobby Server. Connect via WebSocket /ws', { status: 200 });
  },
  websocket: {
    open(ws) {
      const playerId = shortId();
      const lobby = findOrCreateLobby();
      lobby.members.add(playerId);
      lobby.lastActivity = Date.now();

      const state: ConnState = {
        playerId,
        name: `Player_${playerId}`,
        lobbyId: lobby.id,
        joinedAt: Date.now(),
      };
      connections.set(playerId, { ws, state });
      (ws as any).data = { playerId };

      // Send joinAck to the new player (under 1ms)
      ws.send(JSON.stringify({
        type: 'joinAck',
        playerId,
        name: state.name,
        lobbyId: lobby.id,
        capacity: MAX_PLAYERS_PER_LOBBY,
        memberCount: lobby.members.size,
        serverTime: Date.now(),
      }));

      // Broadcast updated player list to everyone in the lobby
      broadcastToLobby(lobby.id, buildPlayerList(lobby));
      console.log(`[conn] +${playerId} joined ${lobby.id} (${lobby.members.size}/${MAX_PLAYERS_PER_LOBBY})`);
    },

    message(ws, raw) {
      const playerId = (ws as any).data?.playerId;
      const conn = connections.get(playerId);
      if (!conn) return;

      // Strict JSON-only inbound; binary game-state messages come in R19
      let msg: any;
      try {
        msg = typeof raw === 'string' ? JSON.parse(raw) : null;
      } catch {
        return; // silently drop malformed input
      }
      if (!msg || typeof msg !== 'object') return;

      conn.state.joinedAt = Date.now();
      const lobby = lobbies.get(conn.state.lobbyId);
      if (lobby) lobby.lastActivity = Date.now();

      switch (msg.type) {
        case 'setName':
          if (typeof msg.name === 'string' && msg.name.length > 0 && msg.name.length <= 32) {
            conn.state.name = msg.name.replace(/[^\w\-_. ]/g, '').slice(0, 32);
            if (lobby) broadcastToLobby(lobby.id, buildPlayerList(lobby));
          }
          break;
        case 'ping':
          ws.send(JSON.stringify({ type: 'pong', clientTs: msg.clientTs, serverTs: Date.now() }));
          break;
        case 'chat':
          if (lobby && typeof msg.text === 'string' && msg.text.length <= 200) {
            broadcastToLobby(lobby.id, {
              type: 'chat',
              from: conn.state.name,
              text: msg.text.slice(0, 200),
              ts: Date.now(),
            });
          }
          break;
        // Game-state messages (input, snapshot ack, etc.) are R19
        default:
          // Unknown type — log and ignore
          console.log(`[recv] ${playerId}: unknown type ${msg.type}`);
      }
    },

    close(ws) {
      const playerId = (ws as any).data?.playerId;
      const conn = connections.get(playerId);
      if (!conn) return;
      const lobby = lobbies.get(conn.state.lobbyId);
      if (lobby) {
        lobby.members.delete(playerId);
        broadcastToLobby(lobby.id, buildPlayerList(lobby));
        console.log(`[conn] -${playerId} left ${lobby.id} (${lobby.members.size}/${MAX_PLAYERS_PER_LOBBY})`);
      }
      connections.delete(playerId);
    },
  },
});

console.log(`[tribes-lobby] listening on http://localhost:${server.port}`);
console.log(`[tribes-lobby] WebSocket: ws://localhost:${server.port}/ws`);
console.log(`[tribes-lobby] Health check: http://localhost:${server.port}/health`);
