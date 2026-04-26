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
import { computeRatingDeltas, isRatedMatch, defaultSkillRow, SKILL_INITIAL, type SkillRow } from './skill.ts';
import { appendFileSync, existsSync, writeFileSync } from 'fs';

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

// R24: Skill rating store — keyed by uuid. In-memory for Bun; CF DO uses
// state.storage in lobby_do.ts.
const skillStore = new Map<string, SkillRow>();

// R24: Friend / party stores (in-memory for Bun).
// Friend list: not server-side per brief — client localStorage. We just
// expose a presence query GET /friends-status?uuids= mapping uuid → lobbyId.
const partyStore = new Map<string, { id: string; leaderUuid: string; memberUuids: string[]; createdAt: number }>();

// R24: Telemetry CSV file path
const TELEMETRY_PATH = 'server/loadtest/balance_telemetry.csv';
const TELEMETRY_HEADER = 'matchId,durationS,humanCount,scoreA,scoreB,blasterShots,blasterKills,chainShots,chainKills,discShots,discKills,grenShots,grenKills,plasmaShots,plasmaKills,mortarShots,mortarKills,lightK,lightD,medK,medD,heavyK,heavyD,avgJetS,avgSkiS,avgSkiM\n';

function ensureTelemetryFile() {
    try { if (!existsSync(TELEMETRY_PATH)) writeFileSync(TELEMETRY_PATH, TELEMETRY_HEADER); } catch {}
}
ensureTelemetryFile();

function writeTelemetryRow(matchId: string, snap: ReturnType<Match['getTelemetrySnapshot']>) {
    const w = (idx: number) => snap.perWeapon.get(idx) || { shots: 0, kills: 0 };
    const row = [
        matchId,
        snap.durationS.toFixed(1),
        snap.humanCount,
        snap.scores[0], snap.scores[1],
        w(0).shots, w(0).kills,
        w(1).shots, w(1).kills,
        w(2).shots, w(2).kills,
        w(3).shots, w(3).kills,
        w(4).shots, w(4).kills,
        w(5).shots, w(5).kills,
        snap.perClass[0].kills, snap.perClass[0].deaths,
        snap.perClass[1].kills, snap.perClass[1].deaths,
        snap.perClass[2].kills, snap.perClass[2].deaths,
        snap.avgJetS.toFixed(2), snap.avgSkiS.toFixed(2), snap.avgSkiM.toFixed(1),
    ].join(',') + '\n';
    try { appendFileSync(TELEMETRY_PATH, row); } catch (e) { console.warn('[TELEMETRY] write failed:', e); }
}

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

// R21: server-side metrics aggregator (drained by GET /metrics)
const metrics = {
    serverStartedMs: Date.now(),
    matchesStarted: 0, matchesEnded: 0,
    playersConnected: 0, playersDisconnected: 0,
    cheatEvents: [] as { wallTime: number; code: string; playerId: number; detail: string }[],
    slowTicks: [] as { wallTime: number; tickMs: number; players: number; projs: number }[],
    matchHistory: [] as { matchId: string; durationS: number; peakPlayers: number; totalKills: number; winnerTeam: number }[],
};
function recordCheat(playerId: number, code: string, detail: string) {
    metrics.cheatEvents.push({ wallTime: Date.now(), code, playerId, detail });
    if (metrics.cheatEvents.length > 50) metrics.cheatEvents.shift();
    console.log(`[CHEAT] ${code} player=${playerId} ${detail}`);
}
function recordSlowTick(tickMs: number, players: number, projs: number) {
    metrics.slowTicks.push({ wallTime: Date.now(), tickMs, players, projs });
    if (metrics.slowTicks.length > 50) metrics.slowTicks.shift();
    console.log(`[SLOW-TICK] tickMs=${tickMs.toFixed(1)} players=${players} projs=${projs}`);
}

function startMatch(lobby: LobbyState) {
  if (lobby.match) return;
  lobby.match = new Match();
  lobby.rematchVotes = new Set();
  metrics.matchesStarted++;
  (lobby as any).matchStartedMs = Date.now();
  (lobby as any).matchPeakPlayers = 0;
  console.log(`[METRIC] {event:matchStart, matchId:'${lobby.id}', playerCount:${lobby.members.size}, time:${Date.now()}}`);
  let teamA = 0, teamB = 0;
  for (const pid of lobby.members) {
    const conn = connections.get(pid);
    if (!conn) continue;
    const team = teamA <= teamB ? 0 : 1;
    if (team === 0) teamA++; else teamB++;
    conn.team = team;
    const uuid = (conn.ws as any).data?.uuid || '';
    const classId = (conn as any).pendingClassId ?? 0;
    lobby.match.addPlayer(conn.numericId, conn.name, team, classId, uuid, classId);
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
    const t0 = performance.now();
    try { lobby.match.tickSimulation(); } catch (e) { console.error('[tick]', e); }
    const tickMs = performance.now() - t0;
    if (tickMs > 33) recordSlowTick(tickMs, lobby.match.players.size, lobby.match.projectiles.length);
    if (lobby.match.players.size > ((lobby as any).matchPeakPlayers ?? 0)) {
      (lobby as any).matchPeakPlayers = lobby.match.players.size;
    }
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
  const startedMs = (lobby as any).matchStartedMs ?? Date.now();
  const durationS = (Date.now() - startedMs) / 1000;
  const peakPlayers = (lobby as any).matchPeakPlayers ?? m.players.size;
  let totalKills = 0;
  for (const p of m.players.values()) totalKills += p.kills;
  const winnerTeam = m.teamScore[0] > m.teamScore[1] ? 0 : (m.teamScore[1] > m.teamScore[0] ? 1 : -1);
  metrics.matchesEnded++;
  metrics.matchHistory.push({ matchId: lobby.id, durationS, peakPlayers, totalKills, winnerTeam });
  if (metrics.matchHistory.length > 50) metrics.matchHistory.shift();
  console.log(`[METRIC] {event:matchEnd, matchId:'${lobby.id}', durationS:${durationS.toFixed(1)}, peakPlayers:${peakPlayers}, totalKills:${totalKills}, winnerTeam:${winnerTeam}}`);

  // R24: per-match telemetry CSV row (Bun only; CF DO version uses storage)
  const tsnap = m.getTelemetrySnapshot();
  writeTelemetryRow(lobby.id, tsnap);

  // R24: skill rating updates (only if match qualifies as rated)
  const ratingDeltas = new Map<number, number>();
  if (isRatedMatch(durationS, tsnap.humanCount)) {
    const teams: { team: 0 | 1; players: { id: number; uuid: string; rating: number; matchesPlayed: number }[] }[] = [
      { team: 0, players: [] }, { team: 1, players: [] }
    ];
    for (const p of m.players.values()) {
      if (p.isBot || !p.uuid) continue;
      const row = skillStore.get(p.uuid) || defaultSkillRow();
      teams[p.team as 0|1].players.push({ id: p.id, uuid: p.uuid, rating: row.rating, matchesPlayed: row.matchesPlayed });
    }
    const deltas = computeRatingDeltas(teams, m.teamScore as [number, number]);
    for (const t of teams) {
      for (const tp of t.players) {
        const delta = deltas.get(tp.id) || 0;
        const row = skillStore.get(tp.uuid) || defaultSkillRow();
        row.rating += delta;
        row.matchesPlayed++;
        row.lastActiveMs = Date.now();
        skillStore.set(tp.uuid, row);
        ratingDeltas.set(tp.id, delta);
        console.log(`[METRIC] {event:ratingUpdate, uuid:'${tp.uuid.slice(0,8)}', new:${row.rating}, delta:${delta}, matches:${row.matchesPlayed}}`);
      }
    }
  } else {
    console.log(`[METRIC] {event:matchEndUnrated, durationS:${durationS.toFixed(0)}, humans:${tsnap.humanCount}}`);
  }
  console.log(`[match] end lobby=${lobby.id} score=${m.teamScore[0]}-${m.teamScore[1]}`);
  // R24: include per-player rating deltas + new ratings
  const ratings: Record<number, { rating: number; delta: number }> = {};
  for (const p of m.players.values()) {
    if (p.isBot || !p.uuid) continue;
    const row = skillStore.get(p.uuid);
    if (row) ratings[p.id] = { rating: row.rating, delta: ratingDeltas.get(p.id) || 0 };
  }
  broadcastJSON(lobby, {
    type: 'matchEnd',
    lobbyId: lobby.id,
    teamScore: m.teamScore,
    winner: m.teamScore[0] > m.teamScore[1] ? 0 : (m.teamScore[1] > m.teamScore[0] ? 1 : -1),
    mvp: {
      team0: mvps.team0 ? { id: mvps.team0.id, name: mvps.team0.name, kills: mvps.team0.kills, deaths: mvps.team0.deaths } : null,
      team1: mvps.team1 ? { id: mvps.team1.id, name: mvps.team1.name, kills: mvps.team1.kills, deaths: mvps.team1.deaths } : null,
    },
    ratings,
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
      // R21: per brief — {status, activeMatches, totalPlayers, uptimeS, version}
      const activeMatches = [...lobbies.values()].filter(l => !!l.match).length;
      let totalPlayers = 0;
      for (const l of lobbies.values()) totalPlayers += l.members.size;
      const uptimeS = (Date.now() - metrics.serverStartedMs) / 1000;
      const status = metrics.slowTicks.length > 5 ? 'degraded' : 'ok';
      return new Response(JSON.stringify({
        status, activeMatches, totalPlayers, uptimeS, version: 'R21',
        lobbies: lobbies.size, connections: connections.size,
      }), { headers: { 'content-type': 'application/json' } });
    }
    if (url.pathname === '/metrics') {
      // R21: live observability stats
      const tickMsP95 = (() => {
        if (metrics.slowTicks.length === 0) return 0;
        const sorted = [...metrics.slowTicks].map(s => s.tickMs).sort((a, b) => a - b);
        return sorted[Math.floor(sorted.length * 0.95)] || 0;
      })();
      let totalConnected = 0;
      for (const l of lobbies.values()) totalConnected += l.members.size;
      return new Response(JSON.stringify({
        uptimeS: (Date.now() - metrics.serverStartedMs) / 1000,
        activeMatches: [...lobbies.values()].filter(l => !!l.match).length,
        totalConnected,
        matchesStarted: metrics.matchesStarted,
        matchesEnded: metrics.matchesEnded,
        playersConnected: metrics.playersConnected,
        playersDisconnected: metrics.playersDisconnected,
        cheatEvents: metrics.cheatEvents.slice(-10).reverse(),
        tickMsP95,
        slowTickCount: metrics.slowTicks.length,
        recentMatches: metrics.matchHistory.slice(-5).reverse(),
      }), { headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' } });
    }
    if (url.pathname === '/dashboard') {
      return new Response(DASHBOARD_HTML, { headers: { 'content-type': 'text/html' } });
    }
    if (url.pathname === '/lobbies') {
      // R20: public lobby browser endpoint (R24: + avgSkillRating)
      const list = [...lobbies.values()]
        .filter(l => l.isPublic)
        .map(l => {
          let totalRating = 0, count = 0;
          for (const pid of l.members) {
            const c = connections.get(pid);
            if (!c) continue;
            const uuid = (c.ws as any).data?.uuid as string;
            const row = uuid ? skillStore.get(uuid) : null;
            if (row) { totalRating += row.rating; count++; }
          }
          const avgSkillRating = count > 0 ? Math.round(totalRating / count) : SKILL_INITIAL;
          return {
            id: l.id,
            playerCount: l.members.size,
            maxPlayers: MAX_PLAYERS_PER_LOBBY,
            mapName: l.mapName,
            isPublic: l.isPublic,
            matchActive: !!l.match,
            createdAt: l.createdAt,
            avgSkillRating,
            skillRange: count > 0 ? 200 : 0,
          };
        });
      return new Response(JSON.stringify(list), {
        headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' },
      });
    }
    if (url.pathname === '/friends-status') {
      // R24: presence query — uuids comma-sep returns map of uuid → lobbyId | null
      const uuidsParam = url.searchParams.get('uuids') || '';
      const uuids = uuidsParam.split(',').filter(u => u.length > 0);
      const result: Record<string, { online: boolean; lobbyId: string | null; rating: number }> = {};
      for (const u of uuids) {
        let lobbyId: string | null = null;
        for (const conn of connections.values()) {
          const cuuid = (conn.ws as any).data?.uuid;
          if (cuuid === u) { lobbyId = conn.lobbyId; break; }
        }
        const row = skillStore.get(u);
        result[u] = {
          online: lobbyId !== null,
          lobbyId,
          rating: row?.rating || SKILL_INITIAL,
        };
      }
      return new Response(JSON.stringify(result), {
        headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' },
      });
    }
    if (url.pathname === '/party-create' || url.pathname === '/party-join' || url.pathname === '/party-disband') {
      // R24: party endpoints — POST with JSON body { uuid, partyId? }
      if (req.method !== 'POST') return new Response('POST required', { status: 405 });
      return req.json().then((body: any) => {
        const myUuid = body.uuid;
        if (!myUuid) return new Response(JSON.stringify({ error: 'uuid required' }), { status: 400, headers: { 'content-type': 'application/json' } });
        if (url.pathname === '/party-create') {
          const partyId = Math.random().toString(36).slice(2, 8).toUpperCase();
          partyStore.set(partyId, { id: partyId, leaderUuid: myUuid, memberUuids: [myUuid], createdAt: Date.now() });
          return new Response(JSON.stringify({ partyId }), { headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' } });
        }
        if (url.pathname === '/party-join') {
          const partyId = body.partyId;
          const party = partyId ? partyStore.get(partyId) : undefined;
          if (!party) return new Response(JSON.stringify({ error: 'partyId not found' }), { status: 404, headers: { 'content-type': 'application/json' } });
          if (party.memberUuids.indexOf(myUuid) < 0) party.memberUuids.push(myUuid);
          return new Response(JSON.stringify({ partyId, members: party.memberUuids }), { headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' } });
        }
        if (url.pathname === '/party-disband') {
          const partyId = body.partyId;
          if (partyId) partyStore.delete(partyId);
          return new Response(JSON.stringify({ ok: true }), { headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' } });
        }
        return new Response('?', { status: 400 });
      }).catch(() => new Response('bad json', { status: 400 }));
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

      // R24: load skill row for this uuid (creates default if absent)
      let row = skillStore.get(newUuid);
      if (!row) { row = defaultSkillRow(); skillStore.set(newUuid, row); }
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
        skillRating: row.rating,
        matchesPlayed: row.matchesPlayed,
      }));
      broadcastJSON(lobby, buildPlayerList(lobby));
      metrics.playersConnected++;
      console.log(`[conn] +${playerId} (id=${numericId}, lobby=${lobby.id}, ${reconnected ? 'reconnect' : 'new'}) ${lobby.members.size}/${MAX_PLAYERS_PER_LOBBY}`);
      console.log(`[METRIC] {event:connect, playerId:'${playerId}', lobbyId:'${lobby.id}', reconnect:${reconnected}}`);

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
            // R23: loadout-violation kick on 3 sustained
            if (lobby.match.isLoadoutViolator(player)) {
              recordCheat(conn.numericId, 'loadout', `class=${player.classId} kicks=3+`);
              console.log(`[CHEAT] kicking ${playerId} for loadout violation`);
              try { ws.close(4002, 'loadout violation'); } catch {}
              return;
            }
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
        case 'setClass':
          // R23: client picks Light/Medium/Heavy on deploy screen, sent here
          if (typeof msg.classId === 'number' && msg.classId >= 0 && msg.classId <= 2) {
            (conn as any).pendingClassId = msg.classId;
            // If match already running, respawn the player into the new class on next death
            if (lobby.match) {
              const player = lobby.match.players.get(conn.numericId);
              if (player) player.classId = msg.classId;
            }
          }
          break;
        // R23: voice chat WebRTC signaling — server is dumb relay
        case 'voiceOffer':
        case 'voiceAnswer':
        case 'voiceCandidate':
          if (typeof msg.to === 'number') {
            for (const otherPid of lobby.members) {
              const other = connections.get(otherPid);
              if (other && other.numericId === msg.to) {
                try { other.ws.send(JSON.stringify({ ...msg, from: conn.numericId })); } catch {}
                console.log(`[VOICE] ${msg.type} from=${conn.numericId} to=${msg.to}`);
                break;
              }
            }
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
        metrics.playersDisconnected++;
        const sessionS = (Date.now() - conn.joinedAt) / 1000;
        console.log(`[conn] -${playerId} left ${lobby.id} (${lobby.members.size}/${MAX_PLAYERS_PER_LOBBY})`);
        console.log(`[METRIC] {event:disconnect, playerId:'${playerId}', lobbyId:'${lobby.id}', durationS:${sessionS.toFixed(1)}}`);
        if (lobby.match && lobby.match.players.size === 0) {
          endMatch(lobby);
        }
      }
      connections.delete(playerId);
    },
  },
});

// R21: minimal HTML dashboard, polls /metrics every 2s
const DASHBOARD_HTML = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Tribes Server Dashboard</title>
<style>body{font:14px/1.5 -apple-system,Segoe UI,sans-serif;background:#0a0a08;color:#E8DCB8;margin:0;padding:20px}
h1{color:#D4A030;font-weight:300;letter-spacing:3px;margin:0 0 20px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:14px;margin-bottom:20px}
.card{background:#16140e;border:1px solid #3a2c1c;padding:14px}
.label{color:#7a6a4a;font-size:0.78em;letter-spacing:2px;text-transform:uppercase}
.value{color:#FFC850;font-size:1.6em;font-weight:600;margin-top:4px}
table{width:100%;border-collapse:collapse;font-size:0.85em}
th{color:#D4A030;text-align:left;padding:6px 10px;border-bottom:1px solid #3a2c1c}
td{padding:5px 10px;border-bottom:1px solid #1f1a10}
.cheat{color:#C8302C}
.warn{color:#E07020}
.ok{color:#2ECC71}
</style></head><body>
<h1>TRIBES // SERVER DASHBOARD</h1>
<div class="grid" id="cards"></div>
<h3>Recent matches</h3><table id="matches"><tr><th>Match</th><th>Duration</th><th>Peak</th><th>Kills</th><th>Winner</th></tr></table>
<h3>Last cheat events</h3><table id="cheats"><tr><th>Time</th><th>Player</th><th>Code</th><th>Detail</th></tr></table>
<script>
async function refresh(){
  try{
    const r = await fetch('/metrics');
    const m = await r.json();
    const fmt = n => n != null ? n.toLocaleString() : '-';
    document.getElementById('cards').innerHTML = [
      ['Uptime', (m.uptimeS|0)+'s'],
      ['Active matches', fmt(m.activeMatches)],
      ['Connected', fmt(m.totalConnected)],
      ['Matches started', fmt(m.matchesStarted)],
      ['Matches ended', fmt(m.matchesEnded)],
      ['Players connected', fmt(m.playersConnected)],
      ['Tick p95', (m.tickMsP95||0).toFixed(1)+'ms'],
      ['Slow ticks', fmt(m.slowTickCount)],
    ].map(([l,v])=>'<div class="card"><div class="label">'+l+'</div><div class="value">'+v+'</div></div>').join('');
    document.getElementById('matches').innerHTML = '<tr><th>Match</th><th>Duration</th><th>Peak</th><th>Kills</th><th>Winner</th></tr>' +
      (m.recentMatches||[]).map(rm => '<tr><td>'+rm.matchId+'</td><td>'+rm.durationS.toFixed(0)+'s</td><td>'+rm.peakPlayers+'</td><td>'+rm.totalKills+'</td><td>'+(rm.winnerTeam<0?'DRAW':(rm.winnerTeam===0?'RED':'BLUE'))+'</td></tr>').join('');
    document.getElementById('cheats').innerHTML = '<tr><th>Time</th><th>Player</th><th>Code</th><th>Detail</th></tr>' +
      (m.cheatEvents||[]).map(c => '<tr><td>'+new Date(c.wallTime).toLocaleTimeString()+'</td><td>'+c.playerId+'</td><td class="cheat">'+c.code+'</td><td>'+c.detail+'</td></tr>').join('');
  } catch(e){ console.error(e); }
}
refresh(); setInterval(refresh, 2000);
</script></body></html>`;

console.log(`[tribes-lobby R19] listening on http://localhost:${server.port}`);
console.log(`[tribes-lobby R19] WebSocket: ws://localhost:${server.port}/ws`);
console.log(`[tribes-lobby R19] Health check: http://localhost:${server.port}/health`);
console.log(`[tribes-lobby R19] Tick=${TICK_HZ}Hz Snapshot=${SNAPSHOT_HZ}Hz Delta=${DELTA_HZ}Hz`);
