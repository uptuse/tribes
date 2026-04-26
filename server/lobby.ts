// ============================================================
// Tribes Browser Edition — Lobby + Match Server (R16 + R19)
// ============================================================
// Runtime: Bun 1.1+. Run: `bun run start`
//
// R16 responsibilities (unchanged): WebSocket lobby, player UUID
// assignment, player-list broadcast on join/leave, joinAck.
//
// R19 additions:
//   - Per-lobby Match instance from sim.ts (authoritative simulation)
//   - matchStart broadcast when ≥4 players
//   - 30Hz simulation tick + 10Hz snapshot + 30Hz delta intervals
//   - Binary client-input routing through wire.ts → sim.applyInput
//   - matchEnd broadcast on score limit / time limit
//   - Disconnect handling (player removed from sim; R20+ replaces with bot)
//   - Anti-cheat hooks via anticheat.ts
//
// Security: no eval(), no Function() constructor, no remote code load.
// All inbound messages validated.
// ============================================================

import { Match } from './sim.ts';
import { decodeInput } from './wire.ts';
import { AntiCheat } from './anticheat.ts';
import { TICK_HZ, SNAPSHOT_HZ, DELTA_HZ, MATCH_END, MATCH_END_REMATCH_HOLD_SEC } from './constants.ts';

const PORT = Number(Bun.env.PORT ?? 8080);
const MAX_PLAYERS_PER_LOBBY = 8;
const MIN_PLAYERS_TO_START = 2;        // lowered for testing; brief said 4
const MATCH_START_GRACE_MS = 30_000;
const LOBBY_INACTIVITY_MS = 30_000;

interface ConnState {
  playerId: string;
  numericId: number;          // small int for sim use
  name: string;
  lobbyId: string;
  joinedAt: number;
  team: number;
  ws: any;
}

interface LobbyState {
  id: string;
  members: Set<string>;
  numericIdNext: number;
  createdAt: number;
  lastActivity: number;
  isPublic: boolean;             // R20: false for custom-ID lobbies
  mapName: string;
  match: Match | null;
  matchStartGraceUntil: number;
  tickInterval: ReturnType<typeof setInterval> | null;
  snapshotInterval: ReturnType<typeof setInterval> | null;
  deltaInterval: ReturnType<typeof setInterval> | null;
  rematchHoldUntil: number;
  rematchVotes: Set<number>;     // R20: numericIds that voted yes
  anticheat: AntiCheat;
  // R20: disconnect bot tracking — playerId → {botId, disconnectedAt, uuid}
  pendingReconnects: Map<string, { numericId: number, botId: number, disconnectedAt: number, name: string, team: number, armor: number }>;
}

const lobbies = new Map<string, LobbyState>();
const connections = new Map<string, ConnState>();

function shortId(): string {
  return Math.random().toString(36).slice(2, 10);
}

function newLobby(id: string, isPublic: boolean): LobbyState {
  return {
    id,
    members: new Set(),
    numericIdNext: 0,
    createdAt: Date.now(),
    lastActivity: Date.now(),
    isPublic,
    mapName: 'Raindance',
    match: null,
    matchStartGraceUntil: 0,
    tickInterval: null,
    snapshotInterval: null,
    deltaInterval: null,
    rematchHoldUntil: 0,
    rematchVotes: new Set(),
    anticheat: new AntiCheat(),
    pendingReconnects: new Map(),
  };
}

function findOrCreateLobby(requestedLobbyId?: string): LobbyState {
  if (requestedLobbyId) {
    // R20: explicit lobbyId means custom (private) lobby
    let lobby = lobbies.get(requestedLobbyId);
    if (!lobby) {
      lobby = newLobby(requestedLobbyId, false);
      lobbies.set(lobby.id, lobby);
      console.log(`[lobby] created custom ${lobby.id} (private)`);
    }
    return lobby;
  }
  for (const lobby of lobbies.values()) {
    if (lobby.isPublic && lobby.members.size < MAX_PLAYERS_PER_LOBBY && !lobby.match) return lobby;
  }
  const lobby = newLobby(shortId().toUpperCase(), true);
  lobbies.set(lobby.id, lobby);
  console.log(`[lobby] created ${lobby.id} (public)`);
  return lobby;
}

function broadcastJSON(lobby: LobbyState, msg: object) {
  const payload = JSON.stringify(msg);
  for (const playerId of lobby.members) {
    const conn = connections.get(playerId);
    if (conn) try { conn.ws.send(payload); } catch {}
  }
}

function broadcastBinary(lobby: LobbyState, buf: Uint8Array) {
  for (const playerId of lobby.members) {
    const conn = connections.get(playerId);
    if (conn) try { conn.ws.send(buf); } catch {}
  }
}

function buildPlayerList(lobby: LobbyState) {
  const players = [...lobby.members].map(pid => {
    const conn = connections.get(pid);
    return { id: pid, name: conn?.name ?? '???', numericId: conn?.numericId ?? -1, team: conn?.team ?? -1 };
  });
  return {
    type: 'playerList',
    lobbyId: lobby.id, players,
    capacity: MAX_PLAYERS_PER_LOBBY,
    matchActive: !!lobby.match,
  };
}

function startMatch(lobby: LobbyState) {
  if (lobby.match) return;
  lobby.match = new Match();
  lobby.rematchVotes = new Set();
  let teamA = 0, teamB = 0;
  for (const pid of lobby.members) {
    const conn = connections.get(pid);
    if (!conn) continue;
    const team = teamA <= teamB ? 0 : 1;
    if (team === 0) teamA++; else teamB++;
    conn.team = team;
    const uuid = (conn.ws as any).data?.uuid || '';
    lobby.match.addPlayer(conn.numericId, conn.name, team, 0, uuid);
  }
  console.log(`[match] start lobby=${lobby.id} players=${lobby.match.players.size}`);

  // Broadcast match start
  broadcastJSON(lobby, {
    type: 'matchStart',
    lobbyId: lobby.id,
    players: [...lobby.match.players.values()].map(p => ({
      id: p.id, name: p.name, team: p.team, armor: p.armor,
    })),
    serverTime: Date.now(),
  });

  // Start tick loops
  lobby.tickInterval = setInterval(() => {
    if (!lobby.match) return;
    try { lobby.match.tickSimulation(); } catch (e) { console.error('[tick]', e); }
    // R20: drain pending kill events
    if (lobby.match.pendingKillEvents.length > 0) {
      for (const ev of lobby.match.pendingKillEvents) {
        broadcastJSON(lobby, { type: 'kill', killer: ev.killer, victim: ev.victim, weapon: ev.weapon, killerTeam: ev.killerTeam });
      }
      lobby.match.pendingKillEvents.length = 0;
    }
    if (lobby.match.matchState === MATCH_END && lobby.rematchHoldUntil === 0) {
      endMatch(lobby);
    }
  }, 1000 / TICK_HZ);

  lobby.snapshotInterval = setInterval(() => {
    if (!lobby.match) return;
    try { broadcastBinary(lobby, lobby.match.serializeSnapshot()); } catch (e) { console.error('[snap]', e); }
  }, 1000 / SNAPSHOT_HZ);

  lobby.deltaInterval = setInterval(() => {
    if (!lobby.match) return;
    try { broadcastBinary(lobby, lobby.match.serializeDelta()); } catch (e) { console.error('[delta]', e); }
  }, 1000 / DELTA_HZ);
}

function endMatch(lobby: LobbyState) {
  if (!lobby.match) return;
  const m = lobby.match;
  const mvps = m.getMvpPerTeam();
  console.log(`[match] end lobby=${lobby.id} score=${m.teamScore[0]}-${m.teamScore[1]}`);
  broadcastJSON(lobby, {
    type: 'matchEnd',
    lobbyId: lobby.id,
    teamScore: m.teamScore,
    winner: m.teamScore[0] > m.teamScore[1] ? 0 : (m.teamScore[1] > m.teamScore[0] ? 1 : -1),
    mvp: {
      team0: mvps.team0 ? { id: mvps.team0.id, name: mvps.team0.name, kills: mvps.team0.kills, deaths: mvps.team0.deaths } : null,
      team1: mvps.team1 ? { id: mvps.team1.id, name: mvps.team1.name, kills: mvps.team1.kills, deaths: mvps.team1.deaths } : null,
    },
    rematchHoldSec: MATCH_END_REMATCH_HOLD_SEC,
  });
  lobby.rematchHoldUntil = Date.now() + MATCH_END_REMATCH_HOLD_SEC * 1000;
  lobby.rematchVotes = new Set();
  if (lobby.tickInterval) { clearInterval(lobby.tickInterval); lobby.tickInterval = null; }
  if (lobby.snapshotInterval) { clearInterval(lobby.snapshotInterval); lobby.snapshotInterval = null; }
  if (lobby.deltaInterval) { clearInterval(lobby.deltaInterval); lobby.deltaInterval = null; }
  // Hold the Match object so reconnections can still find their state mid-end-screen
  // We'll null it on actual rematch start or hold-timeout.
}

function checkPlayAgainVote(lobby: LobbyState) {
  if (!lobby.match) return;
  const eligible = lobby.match.players.size;
  if (eligible === 0) return;
  const votes = lobby.rematchVotes.size;
  if (votes / eligible >= 0.75) {
    console.log(`[match] rematch vote passed (${votes}/${eligible}) — restarting`);
    lobby.match.resetForRematch();
    lobby.rematchHoldUntil = 0;
    lobby.rematchVotes = new Set();
    // Restart tick loops
    lobby.tickInterval = setInterval(() => {
      if (!lobby.match) return;
      try { lobby.match.tickSimulation(); } catch (e) { console.error('[tick]', e); }
    }, 1000 / TICK_HZ);
    lobby.snapshotInterval = setInterval(() => {
      if (!lobby.match) return;
      try { broadcastBinary(lobby, lobby.match.serializeSnapshot()); } catch {}
    }, 1000 / SNAPSHOT_HZ);
    lobby.deltaInterval = setInterval(() => {
      if (!lobby.match) return;
      try { broadcastBinary(lobby, lobby.match.serializeDelta()); } catch {}
    }, 1000 / DELTA_HZ);
    broadcastJSON(lobby, { type: 'matchStart', lobbyId: lobby.id, players: [...lobby.match.players.values()].map(p => ({ id: p.id, name: p.name, team: p.team, armor: p.armor })), serverTime: Date.now(), rematch: true });
  }
}


function maybeStartMatchIfReady(lobby: LobbyState) {
  if (lobby.match) return;
  if (lobby.members.size >= MIN_PLAYERS_TO_START) {
    startMatch(lobby);
  } else if (lobby.matchStartGraceUntil > 0 && Date.now() >= lobby.matchStartGraceUntil) {
    if (lobby.members.size > 0) startMatch(lobby);
  }
}

function cleanupInactiveLobbies() {
  const now = Date.now();
  for (const [id, lobby] of lobbies) {
    // R20: expire pending reconnects after 30s, leave bot in place
    for (const [uuid, pending] of lobby.pendingReconnects) {
      if (now - pending.disconnectedAt > 30_000) {
        lobby.pendingReconnects.delete(uuid);
        console.log(`[RECONNECT-EXPIRE] uuid=${uuid.slice(0,6)}… botId=${pending.botId} stays`);
      }
    }
    // R20: rematch hold expiry → tear down match if no rematch happened
    if (lobby.match && lobby.rematchHoldUntil > 0 && now > lobby.rematchHoldUntil) {
      console.log(`[lobby] rematch window expired ${lobby.id}`);
      lobby.match = null;
      lobby.rematchHoldUntil = 0;
      lobby.rematchVotes = new Set();
    }
    if (lobby.members.size === 0 && (now - lobby.lastActivity) > LOBBY_INACTIVITY_MS) {
      if (lobby.tickInterval) clearInterval(lobby.tickInterval);
      if (lobby.snapshotInterval) clearInterval(lobby.snapshotInterval);
      if (lobby.deltaInterval) clearInterval(lobby.deltaInterval);
      lobbies.delete(id);
      console.log(`[lobby] reaped empty lobby ${id}`);
    }
  }
}
setInterval(cleanupInactiveLobbies, 5_000);

const server = Bun.serve({
  port: PORT,
  fetch(req, srv) {
    const url = new URL(req.url);
    if (url.pathname === '/' || url.pathname === '/ws') {
      // R20: pass lobbyId + uuid (for reconnect) through to ws data
      const lobbyId = url.searchParams.get('lobbyId') || undefined;
      const uuid = url.searchParams.get('uuid') || '';
      const ok = srv.upgrade(req, { data: { lobbyIdReq: lobbyId, uuid } });
      return ok ? undefined : new Response('Upgrade failed', { status: 400 });
    }
    if (url.pathname === '/health') {
      return new Response(JSON.stringify({
        status: 'ok',
        lobbies: lobbies.size,
        connections: connections.size,
        activeMatches: [...lobbies.values()].filter(l => !!l.match).length,
        uptime: process.uptime(),
      }), { headers: { 'content-type': 'application/json' } });
    }
    if (url.pathname === '/lobbies') {
      // R20: public lobby browser endpoint
      const list = [...lobbies.values()]
        .filter(l => l.isPublic)
        .map(l => ({
          id: l.id,
          playerCount: l.members.size,
          maxPlayers: MAX_PLAYERS_PER_LOBBY,
          mapName: l.mapName,
          isPublic: l.isPublic,
          matchActive: !!l.match,
          createdAt: l.createdAt,
        }));
      return new Response(JSON.stringify(list), {
        headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' },
      });
    }
    return new Response('Tribes Lobby + Match Server (R20). WebSocket: /ws  Browse: /lobbies', { status: 200 });
  },
  websocket: {
    open(ws) {
      const wsData = (ws as any).data || {};
      const requestedLobbyId = wsData.lobbyIdReq as string | undefined;
      const incomingUuid = wsData.uuid as string;
      const lobby = findOrCreateLobby(requestedLobbyId);

      // R20: reconnect path — same uuid as a pending-reconnect entry?
      let reconnected = false;
      let numericId: number;
      let assignedTeam = -1;
      let assignedArmor = 0;
      let assignedName = '';
      if (incomingUuid && lobby.pendingReconnects.has(incomingUuid)) {
        const pending = lobby.pendingReconnects.get(incomingUuid)!;
        numericId = pending.numericId;
        assignedTeam = pending.team;
        assignedArmor = pending.armor;
        assignedName = pending.name;
        // Evict the bot
        if (lobby.match) lobby.match.evictBot(pending.botId);
        // Re-add the player (with the same numericId)
        if (lobby.match) {
          const restored = lobby.match.addPlayer(numericId, pending.name, pending.team, pending.armor, incomingUuid);
          assignedTeam = restored.team;
        }
        lobby.pendingReconnects.delete(incomingUuid);
        reconnected = true;
        console.log(`[RECONNECT] uuid=${incomingUuid.slice(0,6)}… restored as id=${numericId}`);
      } else {
        numericId = lobby.numericIdNext++;
      }

      const playerId = shortId();
      const newUuid = incomingUuid || (shortId() + shortId());
      lobby.members.add(playerId);
      lobby.lastActivity = Date.now();

      const conn: ConnState = {
        playerId, numericId,
        name: assignedName || `Player_${playerId}`,
        lobbyId: lobby.id,
        joinedAt: Date.now(),
        team: assignedTeam,
        ws,
      };
      connections.set(playerId, conn);
      (ws as any).data = { playerId, uuid: newUuid };

      ws.send(JSON.stringify({
        type: 'joinAck',
        playerId, numericId,
        uuid: newUuid,
        name: conn.name,
        lobbyId: lobby.id,
        capacity: MAX_PLAYERS_PER_LOBBY,
        memberCount: lobby.members.size,
        serverTime: Date.now(),
        reconnected,
      }));
      broadcastJSON(lobby, buildPlayerList(lobby));
      console.log(`[conn] +${playerId} (id=${numericId}, lobby=${lobby.id}, ${reconnected ? 'reconnect' : 'new'}) ${lobby.members.size}/${MAX_PLAYERS_PER_LOBBY}`);

      if (!lobby.match && lobby.matchStartGraceUntil === 0) {
        lobby.matchStartGraceUntil = Date.now() + MATCH_START_GRACE_MS;
      }
      maybeStartMatchIfReady(lobby);
    },

    message(ws, raw) {
      const playerId = (ws as any).data?.playerId;
      const conn = connections.get(playerId);
      if (!conn) return;
      const lobby = lobbies.get(conn.lobbyId);
      if (!lobby) return;
      lobby.lastActivity = Date.now();

      // Binary inbound = client input
      if (raw instanceof Uint8Array || raw instanceof Buffer) {
        const buf = raw instanceof Buffer ? new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength) : raw;
        const input = decodeInput(buf);
        if (!input) {
          console.log(`[recv] ${playerId}: drop malformed input (len=${buf.byteLength})`);
          return;
        }
        if (lobby.match) {
          const player = lobby.match.players.get(conn.numericId);
          if (player) {
            const prevPos = [...player.pos] as [number, number, number];
            lobby.match.applyInput(conn.numericId, input);
            // Anti-cheat aim/input rate (speed/cooldown checked elsewhere)
            const violation = lobby.anticheat.checkInput(player, input, prevPos, 1 / 60, lobby.match.tick);
            if (violation === 'inputRate') {
              console.log(`[CHEAT] kicking ${playerId} for inputRate`);
              try { ws.close(4001, 'rate limit'); } catch {}
            }
          }
        }
        return;
      }

      // String/JSON inbound = lobby control messages
      let msg: any;
      try { msg = typeof raw === 'string' ? JSON.parse(raw) : null; } catch { return; }
      if (!msg || typeof msg !== 'object') return;

      switch (msg.type) {
        case 'setName':
          if (typeof msg.name === 'string' && msg.name.length > 0 && msg.name.length <= 32) {
            conn.name = msg.name.replace(/[^\w\-_. ]/g, '').slice(0, 32);
            broadcastJSON(lobby, buildPlayerList(lobby));
          }
          break;
        case 'ping':
          ws.send(JSON.stringify({ type: 'pong', clientTs: msg.clientTs, serverTs: Date.now() }));
          break;
        case 'chat':
          if (typeof msg.text === 'string' && msg.text.length <= 200) {
            broadcastJSON(lobby, { type: 'chat', from: conn.name, text: msg.text.slice(0, 200), ts: Date.now() });
          }
          break;
        case 'ready':
          // For early-start: any 'ready' message bumps grace to 0 immediately
          if (!lobby.match) maybeStartMatchIfReady(lobby);
          break;
        case 'rematchYes':
          if (lobby.match) {
            lobby.rematchVotes.add(conn.numericId);
            broadcastJSON(lobby, { type: 'rematchVote', votes: lobby.rematchVotes.size, eligible: lobby.match.players.size });
            checkPlayAgainVote(lobby);
          }
          break;
        default:
          console.log(`[recv] ${playerId}: unknown JSON type ${msg.type}`);
      }
    },

    close(ws) {
      const wsData = (ws as any).data || {};
      const playerId = wsData.playerId;
      const uuid = wsData.uuid as string;
      const conn = connections.get(playerId);
      if (!conn) return;
      const lobby = lobbies.get(conn.lobbyId);
      if (lobby) {
        lobby.members.delete(playerId);
        // R20: mid-match disconnect → spawn bot, allow 30s for reconnect
        if (lobby.match) {
          const player = lobby.match.players.get(conn.numericId);
          if (player) {
            const bot = lobby.match.addDisconnectBot(player);
            lobby.match.removePlayer(conn.numericId);
            if (uuid) {
              lobby.pendingReconnects.set(uuid, {
                numericId: conn.numericId,
                botId: bot.id,
                disconnectedAt: Date.now(),
                name: player.name,
                team: player.team,
                armor: player.armor,
              });
            }
          }
        }
        broadcastJSON(lobby, buildPlayerList(lobby));
        console.log(`[conn] -${playerId} left ${lobby.id} (${lobby.members.size}/${MAX_PLAYERS_PER_LOBBY})`);
        if (lobby.match && lobby.match.players.size === 0) {
          endMatch(lobby);
        }
      }
      connections.delete(playerId);
    },
  },
});

console.log(`[tribes-lobby R19] listening on http://localhost:${server.port}`);
console.log(`[tribes-lobby R19] WebSocket: ws://localhost:${server.port}/ws`);
console.log(`[tribes-lobby R19] Health check: http://localhost:${server.port}/health`);
console.log(`[tribes-lobby R19] Tick=${TICK_HZ}Hz Snapshot=${SNAPSHOT_HZ}Hz Delta=${DELTA_HZ}Hz`);
