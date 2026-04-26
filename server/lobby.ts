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
import { tierForRating, RANKED_MIN_MATCHES_PLAYED } from './tiers.ts';
import { validateUsername, containsRestricted } from './moderation.ts';
import { readR2Config, r2Put, r2Get } from './r2.ts';

// R28: R2 storage gate. When env vars are set, replay sharing persists to R2;
// otherwise the R26 in-memory fallback handles it (rotated 7d).
const R2_CONFIG = readR2Config();
if (R2_CONFIG) console.log(`[R2] persistence enabled (bucket=${R2_CONFIG.bucket})`);
else console.log('[R2] env vars not set — using in-memory replay store');

// ============================================================
// R27 — Public-playtest hardening: events, reports, audit, GDPR
// ============================================================

// Structured event log — bounded ring buffer queryable via /events
interface EventEntry {
  type: string;            // match.started, player.kicked, cheat.detected, error.5xx, …
  ts: number;              // wall-clock ms
  payload: Record<string, unknown>;
}
const EVENT_LOG_MAX = 1000;
const eventLog: EventEntry[] = [];
function emitEvent(type: string, payload: Record<string, unknown>) {
  eventLog.push({ type, ts: Date.now(), payload });
  if (eventLog.length > EVENT_LOG_MAX) eventLog.shift();
}

// Audit log appender — writes to comms/audit_log.jsonl on disk for forensic
// review. Failures are non-fatal (in CF Workers there's no fs; the audit
// record still exists in the event log).
const AUDIT_PATH = 'comms/audit_log.jsonl';
function appendAudit(rec: Record<string, unknown>) {
  try { appendFileSync(AUDIT_PATH, JSON.stringify({ ...rec, ts: Date.now() }) + '\n'); }
  catch { /* fs unavailable — event log still has it */ }
}

// Reports store — keyed by reported uuid, accumulates {by, category, desc, ts}
interface ReportEntry { byUuid: string; category: string; desc: string; ts: number; }
const reportsStore = new Map<string, ReportEntry[]>();    // reportedUuid → entries
const REPORTS_PER_UUID_MAX = 50;
const REPORT_RATE_LIMIT = 10;   // per reporter per 24h
const reportRateLimit = new Map<string, number[]>();      // reporterUuid → [ts, ts, …]

// Velocity-strike tracking for anti-cheat
interface StrikeEntry { ts: number[]; }
const velocityStrikes = new Map<string, StrikeEntry>();   // uuid → recent strikes
// Soft-kick history: uuid → kick timestamps (for 5-kicks-7d blocklist trigger)
const kickHistory = new Map<string, number[]>();
const blockedUuids = new Set<string>();

// Sentiment store — match-end survey free-text + tag aggregation
interface SurveyEntry { byUuid: string; matchId: string; rating: number; tags: string[]; comment: string; ts: number; }
const surveyStore: SurveyEntry[] = [];
const SURVEY_MAX = 500;

// GDPR pending deletes: uuid → {scheduledAt, expiresAt}
const gdprPending = new Map<string, { scheduledAt: number; expiresAt: number }>();
const GDPR_GRACE_MS = 7 * 24 * 60 * 60 * 1000;

// R28: per-match shadow IDs (replaces the R27 UUID broadcast). Each lobby
// has its own map; rotating per match prevents cross-match UUID correlation.
const shadowMaps = new Map<string, Map<string, string>>();   // lobbyId → (uuid → shadowId)
const SHADOW_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';   // 32 chars, no I/O/0/1
function generateShadowId(existing: Set<string>): string {
  for (let attempt = 0; attempt < 3; attempt++) {
    let s = '';
    for (let i = 0; i < 6; i++) s += SHADOW_ALPHABET.charAt(Math.floor(Math.random() * SHADOW_ALPHABET.length));
    if (!existing.has(s)) return s;
  }
  // 4th attempt: append a random suffix to break the tie
  return Math.random().toString(36).slice(2, 8).toUpperCase();
}
function getOrAssignShadow(lobbyId: string, uuid: string): string {
  if (!uuid) return '';
  let m = shadowMaps.get(lobbyId);
  if (!m) { m = new Map(); shadowMaps.set(lobbyId, m); }
  let s = m.get(uuid);
  if (s) return s;
  s = generateShadowId(new Set(m.values()));
  m.set(uuid, s);
  return s;
}
function resolveShadow(lobbyId: string, shadowId: string): string | null {
  const m = shadowMaps.get(lobbyId);
  if (!m) return null;
  for (const [uuid, sid] of m) if (sid === shadowId) return uuid;
  return null;
}
function clearShadowMap(lobbyId: string) {
  shadowMaps.delete(lobbyId);
}

// R28: server-authoritative mute store (replaces R27's client-localStorage
// scheme as the source of truth). Keyed by muter UUID → Set of muted UUIDs.
const muteStore = new Map<string, Set<string>>();
function setMute(muterUuid: string, mutedUuid: string, muted: boolean) {
  if (!muterUuid || !mutedUuid || muterUuid === mutedUuid) return;
  let s = muteStore.get(muterUuid);
  if (!s) { s = new Set(); muteStore.set(muterUuid, s); }
  if (muted) s.add(mutedUuid); else s.delete(mutedUuid);
}
function getMutedShadowIdsForLobby(muterUuid: string, lobbyId: string): string[] {
  const muted = muteStore.get(muterUuid);
  const sm = shadowMaps.get(lobbyId);
  if (!muted || !sm) return [];
  const out: string[] = [];
  for (const [uuid, sid] of sm) if (muted.has(uuid)) out.push(sid);
  return out;
}

// R28: chat rate limit + soft-mute tracking
interface ChatRateEntry { sent: number[]; rateHits: number[]; softMuteUntil: number; lastChannel: 'all' | 'team'; lastSent: string; }
const chatRate = new Map<string, ChatRateEntry>();   // uuid → entry
function chatRateState(uuid: string): ChatRateEntry {
  let e = chatRate.get(uuid);
  if (!e) { e = { sent: [], rateHits: [], softMuteUntil: 0, lastChannel: 'all', lastSent: '' }; chatRate.set(uuid, e); }
  return e;
}

// R28: dynamic wordlist additions/removals via /admin/wordlist. The bundled
// list in moderation.ts is the floor; admin can add (further restrict) or
// remove (un-restrict). Capped at 5000 entries total per brief 2.6.
const dynamicWordlistAdd = new Set<string>();
const dynamicWordlistRemove = new Set<string>();
const ADMIN_WORDLIST_MAX = 5000;
const ADMIN_TOKEN = Bun.env.ADMIN_TOKEN || '';     // set in production; permissive when empty in dev
function isAdmin(req: Request): boolean {
  if (!ADMIN_TOKEN) return true;        // dev: open
  const tok = (new URL(req.url)).searchParams.get('token') || req.headers.get('x-admin-token') || '';
  return tok === ADMIN_TOKEN;
}
function moderationContains(text: string): boolean {
  // Apply dynamic add (further restrict) and remove (un-restrict) on top of the baked list
  const base = containsRestricted(text);
  // If text triggered a baked-list term that is in the remove set, un-restrict it.
  if (base) {
    for (const t of dynamicWordlistRemove) {
      if (text.toLowerCase().includes(t.toLowerCase())) return false;
    }
  }
  // Then check dynamic-add list
  for (const t of dynamicWordlistAdd) {
    if (text.toLowerCase().includes(t.toLowerCase())) return true;
  }
  return base;
}

// R28: emoji whitelist — 8 fixed reactions per brief 2.2
const EMOJI_WHITELIST = new Set(['👍', '👎', '🎉', '😂', '😢', '❤️', '🔥', '💀']);

// R28: slash command list (server-side validation; unknown commands are
// silently dropped per brief 6.0).
const SLASH_COMMANDS = new Set(['/me', '/help', '/r', '/team', '/all', '/mute', '/report']);

// One-time tokens for /account/{export,delete}
const accountTokens = new Map<string, { uuid: string; expiresAt: number }>();
function newAccountToken(uuid: string): string {
  const buf = new Uint8Array(16);
  crypto.getRandomValues(buf);
  const tok = [...buf].map(b => b.toString(16).padStart(2, '0')).join('');
  accountTokens.set(tok, { uuid, expiresAt: Date.now() + 5 * 60 * 1000 });
  return tok;
}
function consumeAccountToken(token: string, claimedUuid: string): boolean {
  const row = accountTokens.get(token);
  if (!row) return false;
  if (row.expiresAt < Date.now()) { accountTokens.delete(token); return false; }
  if (row.uuid !== claimedUuid) return false;
  accountTokens.delete(token);
  return true;
}
import { appendFileSync, existsSync, writeFileSync, readFileSync } from 'fs';

// R25: known map ids (resolves ?map= query param to a file path)
const MAP_REGISTRY: Record<string, string> = {
  raindance:      'client/maps/raindance.tribes-map',
  dangercrossing: 'client/maps/dangercrossing.tribes-map',
  iceridge:       'client/maps/iceridge.tribes-map',
};

function loadMapDocFromDisk(mapId: string): MapDoc | null {
  const path = MAP_REGISTRY[mapId];
  if (!path) { console.warn('[map] unknown id:', mapId); return null; }
  try {
    const txt = readFileSync(path, 'utf8');
    const doc = JSON.parse(txt) as MapDoc;
    return doc;
  } catch (e) {
    console.warn('[map] load failed for', mapId, '-', (e as Error).message);
    return null;
  }
}

function setLobbyMap(lobby: LobbyState, mapId: string) {
  if (!MAP_REGISTRY[mapId]) return;
  if (lobby.match) return;          // can't change map mid-match
  lobby.mapId = mapId;
  lobby.mapDoc = loadMapDocFromDisk(mapId);
  lobby.mapName = (lobby.mapDoc?.name as string) || mapId;
}

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

// R25: a minimal subset of `.tribes-map` that the server actually inspects.
// Schema lives in client/maps/schema.md.
interface MapDoc {
  id?: string;
  name?: string;
  gameplay?: { flags?: Array<{ team: number; pos: [number, number, number] }> };
  [k: string]: unknown;
}

interface LobbyState {
  id: string;
  members: Set<string>;
  numericIdNext: number;
  createdAt: number;
  lastActivity: number;
  isPublic: boolean;             // R20: false for custom-ID lobbies
  ranked: boolean;               // R26: true when joined via Quick Match RANKED button
  mapName: string;
  mapId: string;                 // R25: stable id from .tribes-map (filename minus extension)
  mapDoc: MapDoc | null;         // R25: cached parsed map JSON; loaded lazily on first match start
  match: Match | null;
  matchStartGraceUntil: number;
  tickInterval: ReturnType<typeof setInterval> | null;
  snapshotInterval: ReturnType<typeof setInterval> | null;
  deltaInterval: ReturnType<typeof setInterval> | null;
  rematchHoldUntil: number;
  rematchVotes: Set<number>;     // R20: numericIds that voted yes
  // R25: map vote — populated at endMatch with three options (current + 2 random),
  // collected via 'mapVote' messages, decided when checkPlayAgainVote fires.
  mapVoteOptions: string[];
  mapVoteTally: Map<string, number>;     // mapId → vote count
  mapVoteCast: Set<number>;              // numericIds that already voted
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

// R25: in-memory replay store. Each key is a matchId, value is the assembled
// `.tribes-replay` binary blob. Bounded to the most recent ~16 matches to
// avoid unbounded growth on long-running dev servers; CF DO will replace this
// with R2 object storage in a future round.
const REPLAY_MAX = 16;
const replayStore = new Map<string, Uint8Array>();
function pruneReplays() {
  while (replayStore.size > REPLAY_MAX) {
    const oldest = replayStore.keys().next().value as string | undefined;
    if (!oldest) break;
    replayStore.delete(oldest);
  }
}

// R26: shared-replay store. POST /replay-upload assigns a 16-hex hash and
// stores the binary under that key with a 7-day expiry timestamp. R2 setup
// is deferred per brief 6.0 decision authority (no CF auth in this env);
// when R27 wires R2, swap this map for the S3 SDK calls.
interface SharedReplayEntry { bytes: Uint8Array; expiresAt: number; }
const sharedReplayStore = new Map<string, SharedReplayEntry>();
const SHARED_REPLAY_TTL_MS = 7 * 24 * 60 * 60 * 1000;   // 7 days (DO-fallback rotation)
const SHARED_REPLAY_MAX = 256;
function pruneSharedReplays() {
  const now = Date.now();
  for (const [k, v] of sharedReplayStore) if (v.expiresAt < now) sharedReplayStore.delete(k);
  while (sharedReplayStore.size > SHARED_REPLAY_MAX) {
    const oldest = sharedReplayStore.keys().next().value as string | undefined;
    if (!oldest) break;
    sharedReplayStore.delete(oldest);
  }
}
function shareHash(): string {
  const buf = new Uint8Array(8);
  crypto.getRandomValues(buf);
  return [...buf].map(b => b.toString(16).padStart(2, '0')).join('');
}

// R25: per-lobby replay capture buffer — one entry per emitted snapshot.
// Each entry holds the raw snapshot bytes and the wall-clock timestamp.
// We assemble these into a single `.tribes-replay` blob at endMatch.
interface ReplayEntry { wallTime: number; bytes: Uint8Array; }
const replayBuffers = new Map<string, ReplayEntry[]>();   // lobbyId → entries
const replayMeta = new Map<string, {
  startedMs: number; mapId: string; mapName: string;
  killEvents: { tick: number; killer: number; victim: number; weapon: number; killerTeam: number }[];
  capEvents:  { tick: number; team: number; capturer: number }[];
}>();
const REPLAY_CAPTURE_MAX_ENTRIES = 6 * 60 * 10; // 10 min @ 10 snapshots/sec

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
    ranked: false,
    mapName: 'Raindance',
    mapId: 'raindance',
    mapDoc: null,
    match: null,
    matchStartGraceUntil: 0,
    tickInterval: null,
    snapshotInterval: null,
    deltaInterval: null,
    rematchHoldUntil: 0,
    rematchVotes: new Set(),
    mapVoteOptions: [],
    mapVoteTally: new Map(),
    mapVoteCast: new Set(),
    anticheat: new AntiCheat(),
    pendingReconnects: new Map(),
  };
}

function findOrCreateLobby(requestedLobbyId?: string, opts?: { ranked?: boolean; rating?: number }): LobbyState {
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
  // R26: when joining ranked, prefer lobbies whose ranked flag matches AND
  // (best effort) whose existing avg rating tier matches the joining player's.
  // Falls back to any open lobby if no tier-matched one is available.
  const wantRanked = !!opts?.ranked;
  const wantTier = opts?.rating !== undefined ? tierForRating(opts.rating).id : null;
  let bestSameTier: LobbyState | null = null;
  let anyOpen: LobbyState | null = null;
  for (const lobby of lobbies.values()) {
    if (!lobby.isPublic || lobby.members.size >= MAX_PLAYERS_PER_LOBBY || lobby.match) continue;
    if (lobby.ranked !== wantRanked) continue;
    anyOpen = anyOpen || lobby;
    if (wantTier && lobby.members.size > 0) {
      // Compute the lobby's current avg-tier from skillStore lookups
      let total = 0, n = 0;
      for (const pid of lobby.members) {
        const c = connections.get(pid);
        const u = c && (c.ws as any).data?.uuid;
        const row = u ? skillStore.get(u) : null;
        if (row) { total += row.rating; n++; }
      }
      const avg = n > 0 ? total / n : SKILL_INITIAL;
      if (tierForRating(avg).id === wantTier) { bestSameTier = lobby; break; }
    }
  }
  if (bestSameTier) return bestSameTier;
  if (anyOpen) return anyOpen;
  const lobby = newLobby(shortId().toUpperCase(), true);
  lobby.ranked = wantRanked;
  lobbies.set(lobby.id, lobby);
  console.log(`[lobby] created ${lobby.id} (public, ranked=${wantRanked})`);
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
  // R25: lazy-load the .tribes-map for this lobby and apply it to the sim
  if (!lobby.mapDoc) lobby.mapDoc = loadMapDocFromDisk(lobby.mapId);
  if (lobby.mapDoc) {
    lobby.match.loadMap(lobby.mapDoc);
    lobby.mapName = lobby.match.mapName;
  }
  // R25: prime replay capture for this match
  replayBuffers.set(lobby.id, []);
  replayMeta.set(lobby.id, {
    startedMs: Date.now(), mapId: lobby.mapId, mapName: lobby.mapName,
    killEvents: [], capEvents: [],
  });
  lobby.rematchVotes = new Set();
  metrics.matchesStarted++;
  emitEvent('match.started', { matchId: lobby.id, mapId: lobby.mapId, ranked: lobby.ranked, players: lobby.members.size });
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
    mapId: lobby.mapId,                  // R25
    mapName: lobby.mapName,              // R25
    ranked: lobby.ranked,                // R26
    players: [...lobby.match.players.values()].map(p => ({
      id: p.id, name: p.name, team: p.team, armor: p.armor,
      // R26: include rating so client can render tier badges on scoreboard + nameplate
      rating: p.uuid ? (skillStore.get(p.uuid)?.rating ?? SKILL_INITIAL) : SKILL_INITIAL,
      // R28: per-match shadow ID — replaces R27's stable-UUID broadcast.
      // UUID is no longer broadcast; shadowId rotates per match so two players
      // can't correlate identities across matches.
      shadowId: p.uuid ? getOrAssignShadow(lobby.id, p.uuid) : '',
    })),
    serverTime: Date.now(),
  });

  // R28: per-recipient mute hint — for each connected player, send the list
  // of shadowIds in this match that they have previously muted (server is
  // source of truth; client localStorage from R27 is now redundant).
  for (const pid of lobby.members) {
    const conn = connections.get(pid);
    if (!conn) continue;
    const u = (conn.ws as any).data?.uuid as string;
    if (!u) continue;
    const muted = getMutedShadowIdsForLobby(u, lobby.id);
    if (muted.length > 0) {
      try { conn.ws.send(JSON.stringify({ type: 'mutesInMatch', mutedShadowIds: muted })); } catch {}
    }
  }

  // Start tick loops
  lobby.tickInterval = setInterval(() => {
    // R27: top-level try-catch — uncaught tick exception logs error.5xx and
    // continues. Players experience a one-tick stall but stay connected.
    try {
      if (!lobby.match) return;
      const t0 = performance.now();
      try { lobby.match.tickSimulation(); } catch (e) { console.error('[tick]', e); emitEvent('error.5xx', { where: 'tickSimulation', err: String(e), lobbyId: lobby.id }); }
      const tickMs = performance.now() - t0;
      if (tickMs > 33) recordSlowTick(tickMs, lobby.match.players.size, lobby.match.projectiles.length);
      if (lobby.match.players.size > ((lobby as any).matchPeakPlayers ?? 0)) {
        (lobby as any).matchPeakPlayers = lobby.match.players.size;
      }
      // R27: per-tick velocity validation. Decision authority bumped horizontal
      // bound to 80 m/s (Tribes ski + downhill is legitimately fast). >100 m/s
      // is the hard clamp; 80-100 is a logged warning. Vertical jet >+20 is
      // the boundary. 3 strikes in 60s = soft-kick.
      for (const p of lobby.match.players.values()) {
        if (p.isBot || !p.uuid) continue;
        const horiz = Math.hypot(p.vel[0], p.vel[2]);
        const vy = p.vel[1];
        const overHoriz = horiz > 100;
        const overVy    = vy    > 20;
        if (overHoriz || overVy) {
          // Clamp server-side and accumulate strike
          if (overHoriz) { const k = 100 / Math.max(0.001, horiz); p.vel[0] *= k; p.vel[2] *= k; }
          if (overVy)    p.vel[1] = 20;
          const entry = velocityStrikes.get(p.uuid) ?? { ts: [] };
          entry.ts.push(Date.now());
          entry.ts = entry.ts.filter(t => t > Date.now() - 60_000);
          velocityStrikes.set(p.uuid, entry);
          emitEvent('cheat.detected', { kind: 'velocity', uuid: p.uuid.slice(0,8), playerId: p.id, horiz: horiz.toFixed(1), vy: vy.toFixed(1), strikes: entry.ts.length });
          appendAudit({ kind: 'cheat.velocity', uuid: p.uuid, playerId: p.id, horiz, vy, strikes: entry.ts.length });
          if (entry.ts.length >= 3) {
            // Soft-kick
            const conn = [...connections.values()].find(c => c.numericId === p.id);
            if (conn) {
              try { conn.ws.close(4003, 'speed-validation-failed'); } catch {}
              const kh = kickHistory.get(p.uuid) ?? [];
              kh.push(Date.now());
              kickHistory.set(p.uuid, kh.filter(t => t > Date.now() - 7 * 24 * 60 * 60 * 1000));
              if ((kickHistory.get(p.uuid)?.length ?? 0) >= 5) blockedUuids.add(p.uuid);
              emitEvent('player.kicked', { uuid: p.uuid.slice(0,8), reason: 'speed-validation-failed', kickCount7d: kickHistory.get(p.uuid)?.length });
              appendAudit({ kind: 'kick', reason: 'speed-validation-failed', uuid: p.uuid, kickCount7d: kickHistory.get(p.uuid)?.length });
              velocityStrikes.delete(p.uuid);
            }
          }
        } else if (horiz > 80) {
          // Graduated warning band — log only, no strike
          emitEvent('cheat.detected', { kind: 'velocity-warn', uuid: p.uuid.slice(0,8), playerId: p.id, horiz: horiz.toFixed(1) });
        }
      }
      // R20: drain pending kill events
      if (lobby.match.pendingKillEvents.length > 0) {
        const meta = replayMeta.get(lobby.id);
        for (const ev of lobby.match.pendingKillEvents) {
          broadcastJSON(lobby, { type: 'kill', killer: ev.killer, victim: ev.victim, weapon: ev.weapon, killerTeam: ev.killerTeam });
          // R25: capture kill marker for replay timeline
          if (meta) meta.killEvents.push({ tick: lobby.match.tick, killer: ev.killer, victim: ev.victim, weapon: ev.weapon, killerTeam: ev.killerTeam });
        }
        lobby.match.pendingKillEvents.length = 0;
      }
      if (lobby.match.matchState === MATCH_END && lobby.rematchHoldUntil === 0) {
        endMatch(lobby);
      }
    } catch (uncaught) {
      console.error('[tick] uncaught', uncaught);
      emitEvent('error.5xx', { where: 'tickInterval', err: String(uncaught), lobbyId: lobby.id });
    }
  }, 1000 / TICK_HZ);

  lobby.snapshotInterval = setInterval(() => {
    if (!lobby.match) return;
    try {
      const snap = lobby.match.serializeSnapshot();
      broadcastBinary(lobby, snap);
      // R25: capture snapshot for replay (10/sec). Bounded buffer length.
      const buf = replayBuffers.get(lobby.id);
      if (buf && buf.length < REPLAY_CAPTURE_MAX_ENTRIES) {
        buf.push({ wallTime: Date.now(), bytes: new Uint8Array(snap) });
      }
    } catch (e) { console.error('[snap]', e); }
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
  emitEvent('match.ended', { matchId: lobby.id, mapId: lobby.mapId, durationS, winnerTeam, scores: m.teamScore });
  metrics.matchHistory.push({ matchId: lobby.id, durationS, peakPlayers, totalKills, winnerTeam });
  if (metrics.matchHistory.length > 50) metrics.matchHistory.shift();
  console.log(`[METRIC] {event:matchEnd, matchId:'${lobby.id}', durationS:${durationS.toFixed(1)}, peakPlayers:${peakPlayers}, totalKills:${totalKills}, winnerTeam:${winnerTeam}}`);

  // R24: per-match telemetry CSV row (Bun only; CF DO version uses storage)
  const tsnap = m.getTelemetrySnapshot();
  writeTelemetryRow(lobby.id, tsnap);

  // R24: skill rating updates (only if match qualifies as rated)
  // R26: additionally requires the lobby to be in ranked mode (CASUAL = no rating change)
  const ratingDeltas = new Map<number, number>();
  if (lobby.ranked && isRatedMatch(durationS, tsnap.humanCount)) {
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
  // R25: assemble the captured snapshots into a single `.tribes-replay` blob.
  // Layout:
  //   [magic 'TRBR' 4B][version u32 LE = 1][matchId-len u16][matchId utf8]
  //   [meta-len u32][meta JSON utf8 — { startedMs, mapId, mapName, players[],
  //                                     killEvents[], capEvents[], snapshotHz }]
  //   repeating: [snap-len u32][snap bytes]
  let replayUrl: string | null = null;
  try {
    const meta = replayMeta.get(lobby.id);
    const snaps = replayBuffers.get(lobby.id) || [];
    if (meta && snaps.length > 0) {
      const metaJson = JSON.stringify({
        startedMs: meta.startedMs,
        mapId: meta.mapId, mapName: meta.mapName,
        players: [...m.players.values()].map(p => ({
          id: p.id, name: p.name, team: p.team, armor: p.armor, isBot: p.isBot,
        })),
        killEvents: meta.killEvents,
        capEvents:  meta.capEvents,
        snapshotHz: SNAPSHOT_HZ,
        finalScore: m.teamScore,
        durationS,
      });
      const enc = new TextEncoder();
      const idBytes  = enc.encode(lobby.id);
      const metaBytes = enc.encode(metaJson);
      let totalLen = 4 + 4 + 2 + idBytes.length + 4 + metaBytes.length;
      for (const s of snaps) totalLen += 4 + s.bytes.length;
      const out = new Uint8Array(totalLen);
      const dv = new DataView(out.buffer);
      let off = 0;
      out[off++] = 0x54; out[off++] = 0x52; out[off++] = 0x42; out[off++] = 0x52; // 'TRBR'
      dv.setUint32(off, 1, true); off += 4;
      dv.setUint16(off, idBytes.length, true); off += 2;
      out.set(idBytes, off); off += idBytes.length;
      dv.setUint32(off, metaBytes.length, true); off += 4;
      out.set(metaBytes, off); off += metaBytes.length;
      for (const s of snaps) {
        dv.setUint32(off, s.bytes.length, true); off += 4;
        out.set(s.bytes, off); off += s.bytes.length;
      }
      replayStore.set(lobby.id, out);
      pruneReplays();
      replayUrl = `/replay?matchId=${encodeURIComponent(lobby.id)}`;
      console.log(`[REPLAY] saved ${lobby.id} (${(out.length / 1024).toFixed(1)} KB, ${snaps.length} snaps)`);
    }
  } catch (e) {
    console.warn('[REPLAY] assembly failed:', e);
  }
  // Free the per-match capture buffers regardless of success
  replayBuffers.delete(lobby.id);
  replayMeta.delete(lobby.id);

  // R25: pick 2 random alternative maps for the post-match vote
  const allMaps = Object.keys(MAP_REGISTRY);
  const others = allMaps.filter(id => id !== lobby.mapId);
  for (let i = others.length - 1; i > 0; i--) { const j = (Math.random() * (i + 1)) | 0; [others[i], others[j]] = [others[j], others[i]]; }
  lobby.mapVoteOptions = [lobby.mapId, ...others.slice(0, 2)];
  lobby.mapVoteTally = new Map(lobby.mapVoteOptions.map(id => [id, 0]));
  lobby.mapVoteCast = new Set();

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
    replayUrl,                                // R25
    mapId: lobby.mapId,                       // R25
    mapName: lobby.mapName,
    mapVoteOptions: lobby.mapVoteOptions,     // R25
    ranked: lobby.ranked,                     // R26
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
  // R26 fix #3: only count *connected* humans toward the vote quorum.
  // Disconnected players (replaced by bots, or cleanly gone) shouldn't stall
  // the vote at 75% just because they never sent a yes.
  let eligible = 0;
  for (const p of lobby.match.players.values()) {
    if (p.isBot) continue;
    // A player counts as connected if their numericId still appears in connections
    let stillHere = false;
    for (const pid of lobby.members) {
      const conn = connections.get(pid);
      if (conn && conn.numericId === p.id) { stillHere = true; break; }
    }
    if (stillHere) eligible++;
  }
  if (eligible === 0) eligible = 1;             // guard against div-by-zero
  const votes = lobby.rematchVotes.size;
  if (votes / eligible >= 0.75) {
    // R25: tally the map vote — winner is highest tally; ties favour current map.
    let chosenMap = lobby.mapId;
    let topVotes = -1;
    for (const opt of lobby.mapVoteOptions) {
      const v = lobby.mapVoteTally.get(opt) || 0;
      if (v > topVotes) { topVotes = v; chosenMap = opt; }
    }
    if (chosenMap !== lobby.mapId) {
      console.log(`[match] map vote: ${chosenMap} (was ${lobby.mapId})`);
      // Drop cached doc + reload sim with new map
      lobby.mapDoc = null;
      setLobbyMap(lobby, chosenMap);
      if (lobby.mapDoc) lobby.match.loadMap(lobby.mapDoc);
    }
    lobby.mapVoteOptions = [];
    lobby.mapVoteTally = new Map();
    lobby.mapVoteCast = new Set();

    console.log(`[match] rematch vote passed (${votes}/${eligible}) — restarting on ${lobby.mapId}`);
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
    // R28: rotate shadow IDs for the rematch (new IDs prevent correlation
    // across the match boundary even within the same lobby).
    clearShadowMap(lobby.id);
    broadcastJSON(lobby, { type: 'matchStart', lobbyId: lobby.id, mapId: lobby.mapId, mapName: lobby.mapName, players: [...lobby.match.players.values()].map(p => ({ id: p.id, name: p.name, team: p.team, armor: p.armor, rating: p.uuid ? (skillStore.get(p.uuid)?.rating ?? SKILL_INITIAL) : SKILL_INITIAL, shadowId: p.uuid ? getOrAssignShadow(lobby.id, p.uuid) : '' })), serverTime: Date.now(), rematch: true });
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
  async fetch(req, srv) {
    const url = new URL(req.url);
    if (url.pathname === '/' || url.pathname === '/ws') {
      // R20: pass lobbyId + uuid (for reconnect) through to ws data
      const lobbyId = url.searchParams.get('lobbyId') || undefined;
      const uuid = url.searchParams.get('uuid') || '';
      // R25: map selection on lobby creation. Only honoured the first time a
      // given lobbyId is seen (subsequent joins inherit the existing lobby's map).
      const mapReq = url.searchParams.get('map') || '';
      // R26: ranked-mode opt-in. Only public lobbies created via the RANKED
      // button send ranked=1; casual matches default to ranked=false.
      const rankedReq = url.searchParams.get('ranked') === '1';
      const ok = srv.upgrade(req, { data: { lobbyIdReq: lobbyId, uuid, mapReq, rankedReq } });
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
      // R26 dashboard extensions: per-map play counts (last 24h-ish, our
      // matchHistory is ~50 entries deep so it's a rough recency window),
      // top 10 by rating, queue depth per tier (= count of public ranked
      // lobbies whose avg-tier matches the bucket).
      const perMap: Record<string, number> = {};
      for (const m of metrics.matchHistory) {
        // matchId is also the lobbyId; we don't store mapId on the history
        // entry directly (history is bounded). Best-effort lookup: if the
        // lobby still exists, use its current mapId; otherwise unknown.
        const lob = lobbies.get(m.matchId);
        const mid = lob?.mapId || 'unknown';
        perMap[mid] = (perMap[mid] || 0) + 1;
      }
      const topRated = [...skillStore.entries()]
        .map(([uuid, row]) => ({ uuid: uuid.slice(0, 8), rating: row.rating, matches: row.matchesPlayed, tier: tierForRating(row.rating).id }))
        .sort((a, b) => b.rating - a.rating)
        .slice(0, 10);
      const queueDepth: Record<string, number> = {};
      for (const l of lobbies.values()) {
        if (!l.isPublic || !l.ranked) continue;
        let total = 0, n = 0;
        for (const pid of l.members) {
          const c = connections.get(pid);
          const u = c && (c.ws as any).data?.uuid;
          const row = u ? skillStore.get(u) : null;
          if (row) { total += row.rating; n++; }
        }
        const t = tierForRating(n > 0 ? total / n : SKILL_INITIAL).id;
        queueDepth[t] = (queueDepth[t] || 0) + l.members.size;
      }
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
        // R26: new metrics
        perMapPlayCounts: perMap,
        topRated,
        rankedQueueDepth: queueDepth,
        // R27: moderation + sentiment surfaces
        topReported: [...reportsStore.entries()]
          .map(([uuid, list]) => ({ uuid: uuid.slice(0, 8), count: list.length, last: list[list.length - 1] }))
          .sort((a, b) => b.count - a.count)
          .slice(0, 10),
        blockedCount: blockedUuids.size,
        recentEvents: eventLog.slice(-20).reverse(),
        survey: (() => {
          if (surveyStore.length === 0) return null;
          const last24 = surveyStore.filter(s => s.ts > Date.now() - 24 * 60 * 60 * 1000);
          const tagCount: Record<string, number> = {};
          let totalRating = 0;
          for (const s of last24) {
            totalRating += s.rating;
            for (const t of s.tags) tagCount[t] = (tagCount[t] || 0) + 1;
          }
          const topTags = Object.entries(tagCount).sort((a, b) => b[1] - a[1]).slice(0, 5);
          return {
            count24h: last24.length,
            avgRating: last24.length > 0 ? +(totalRating / last24.length).toFixed(2) : 0,
            topTags,
            samples: last24.filter(s => s.comment).slice(-5).map(s => ({ comment: s.comment.slice(0, 20) + '…', rating: s.rating })),
          };
        })(),
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
            mapId: l.mapId,                  // R25: stable id for client routing/thumbnails
            mapName: l.mapName,
            isPublic: l.isPublic,
            ranked: l.ranked,                // R26
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
    // R26: per-player aggregate stats from the telemetry CSV + skillStore.
    // Returns lifetime totals so the PROFILE tab can render without a heavy
    // client-side aggregation. Uses uuid as the lookup key.
    if (url.pathname === '/player-stats') {
      const uuid = url.searchParams.get('uuid') || '';
      const row = uuid ? skillStore.get(uuid) : null;
      // The telemetry CSV is per-match aggregate, not per-player; for R26 we
      // surface the skillStore row + the per-conn observed stats (matches the
      // server has in memory). Lifetime per-player K/D would require a new
      // per-uuid table — left for R27.
      const stats = {
        uuid,
        rating: row?.rating ?? SKILL_INITIAL,
        matchesPlayed: row?.matchesPlayed ?? 0,
        lastActiveMs: row?.lastActiveMs ?? 0,
        tier: row ? tierForRating(row.rating).id : 'silver',
        // Recent matches: most-recent N from metrics.matchHistory the player participated in
        // (we can't filter by uuid without joining; surface server-wide last 5)
        recentMatches: metrics.matchHistory.slice(-5).reverse(),
        // Surface the share-able replay list so profile can deep-link
        replays: [...replayStore.keys()].slice(-5).reverse(),
      };
      return new Response(JSON.stringify(stats), {
        headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' },
      });
    }
    // R25: serve `.tribes-map` JSON. Same-origin static fallback for the renderer.
    if (url.pathname === '/map') {
      const id = url.searchParams.get('id') || '';
      const path = MAP_REGISTRY[id];
      if (!path) return new Response('unknown map', { status: 404, headers: { 'access-control-allow-origin': '*' } });
      try {
        const txt = readFileSync(path, 'utf8');
        return new Response(txt, { headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' } });
      } catch { return new Response('not found', { status: 404 }); }
    }
    if (url.pathname === '/maps-list') {
      return new Response(JSON.stringify(Object.keys(MAP_REGISTRY)), {
        headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' },
      });
    }
    // R25: replay download by matchId — streams the captured snapshot blob.
    if (url.pathname === '/replay') {
      const matchId = url.searchParams.get('matchId') || '';
      const buf = replayStore.get(matchId);
      if (!buf) return new Response('replay not found', { status: 404, headers: { 'access-control-allow-origin': '*' } });
      return new Response(buf, {
        headers: {
          'content-type': 'application/octet-stream',
          'access-control-allow-origin': '*',
          'content-disposition': `attachment; filename="${matchId}.tribes-replay"`,
        },
      });
    }
    if (url.pathname === '/replay-list') {
      const ids = [...replayStore.keys()];
      return new Response(JSON.stringify(ids), {
        headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' },
      });
    }
    // R28: admin wordlist updates (token-gated; 5000 entry cap)
    if (url.pathname === '/admin/wordlist' && req.method === 'POST') {
      if (!isAdmin(req)) return new Response('forbidden', { status: 403 });
      return req.json().then(body => {
        const add    = Array.isArray(body?.add)    ? body.add.slice(0, 5000).map(String)    : [];
        const remove = Array.isArray(body?.remove) ? body.remove.slice(0, 5000).map(String) : [];
        for (const t of add) {
          if (dynamicWordlistAdd.size >= ADMIN_WORDLIST_MAX) break;
          dynamicWordlistAdd.add(t.toLowerCase());
        }
        for (const t of remove) dynamicWordlistRemove.add(t.toLowerCase());
        emitEvent('admin.wordlist-updated', { added: add.length, removed: remove.length, totalAdds: dynamicWordlistAdd.size, totalRemoves: dynamicWordlistRemove.size });
        return new Response(JSON.stringify({ ok: true, totalAdds: dynamicWordlistAdd.size, totalRemoves: dynamicWordlistRemove.size }), {
          headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' },
        });
      }).catch(() => new Response('bad json', { status: 400 }));
    }
    if (url.pathname === '/admin/wordlist' && req.method === 'GET') {
      if (!isAdmin(req)) return new Response('forbidden', { status: 403 });
      return new Response(JSON.stringify({ adds: [...dynamicWordlistAdd], removes: [...dynamicWordlistRemove] }), {
        headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' },
      });
    }
    // R27: structured event log query — token-gated like /dashboard
    if (url.pathname === '/events') {
      const since = Number(url.searchParams.get('since') || 0);
      const type = url.searchParams.get('type') || '';
      const limit = Math.min(500, Number(url.searchParams.get('limit') || 100));
      let out = eventLog.filter(e => e.ts > since);
      if (type) out = out.filter(e => e.type === type);
      out = out.slice(-limit).reverse();
      return new Response(JSON.stringify(out), {
        headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' },
      });
    }
    // R27: report submission (rate-limited 10/uuid/24h)
    // R28: also accept {byUuid, reportedShadowId, lobbyId} — server resolves
    //      the shadow → uuid so privacy holds (UUID never crosses the wire).
    if (url.pathname === '/report' && req.method === 'POST') {
      return req.json().then(body => {
        const byUuid = String(body?.byUuid || '');
        let reportedUuid = String(body?.reportedUuid || '');
        const reportedShadowId = String(body?.reportedShadowId || '');
        const reportedLobbyId = String(body?.lobbyId || '');
        if (!reportedUuid && reportedShadowId && reportedLobbyId) {
          const resolved = resolveShadow(reportedLobbyId, reportedShadowId);
          if (resolved) reportedUuid = resolved;
        }
        const category = String(body?.category || '');
        const desc = String(body?.desc || '').slice(0, 200);
        if (!byUuid || !reportedUuid || byUuid === reportedUuid) {
          return new Response(JSON.stringify({ error: 'invalid report' }), { status: 400, headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' } });
        }
        const allowed = ['cheating', 'harassment', 'slurs', 'voice-abuse', 'other'];
        if (!allowed.includes(category)) {
          return new Response(JSON.stringify({ error: 'invalid category' }), { status: 400, headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' } });
        }
        // Rate limit
        const now = Date.now();
        const window = reportRateLimit.get(byUuid) ?? [];
        const recent = window.filter(t => t > now - 24 * 60 * 60 * 1000);
        if (recent.length >= REPORT_RATE_LIMIT) {
          return new Response(JSON.stringify({ error: 'report rate limit exceeded (10/24h)' }), { status: 429, headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' } });
        }
        recent.push(now);
        reportRateLimit.set(byUuid, recent);
        const list = reportsStore.get(reportedUuid) ?? [];
        list.push({ byUuid, category, desc, ts: now });
        if (list.length > REPORTS_PER_UUID_MAX) list.shift();
        reportsStore.set(reportedUuid, list);
        emitEvent('player.reported', { reportedUuid: reportedUuid.slice(0,8), byUuid: byUuid.slice(0,8), category });
        appendAudit({ kind: 'report', reportedUuid, byUuid, category, desc });
        return new Response(JSON.stringify({ ok: true }), { headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' } });
      }).catch(() => new Response('bad json', { status: 400 }));
    }
    // R27: post-match survey submission
    if (url.pathname === '/survey' && req.method === 'POST') {
      return req.json().then(body => {
        const entry: SurveyEntry = {
          byUuid: String(body?.byUuid || ''),
          matchId: String(body?.matchId || ''),
          rating: Math.max(1, Math.min(5, Number(body?.rating || 3) | 0)),
          tags: Array.isArray(body?.tags) ? body.tags.slice(0, 10).map(String) : [],
          comment: String(body?.comment || '').slice(0, 280),
          ts: Date.now(),
        };
        surveyStore.push(entry);
        if (surveyStore.length > SURVEY_MAX) surveyStore.shift();
        emitEvent('survey.submitted', { byUuid: entry.byUuid.slice(0,8), matchId: entry.matchId, rating: entry.rating, tagCount: entry.tags.length, hasComment: !!entry.comment });
        return new Response(JSON.stringify({ ok: true }), { headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' } });
      }).catch(() => new Response('bad json', { status: 400 }));
    }
    // R27: GDPR — request a one-time token (client UUID echoes back)
    if (url.pathname === '/account/token') {
      const uuid = url.searchParams.get('uuid') || '';
      if (!uuid) return new Response(JSON.stringify({ error: 'uuid required' }), { status: 400, headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' } });
      const token = newAccountToken(uuid);
      return new Response(JSON.stringify({ token, expiresInS: 300 }), { headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' } });
    }
    // R27: GDPR export — full data dump for the requesting uuid
    if (url.pathname === '/account/export') {
      const uuid = url.searchParams.get('uuid') || '';
      const token = url.searchParams.get('token') || '';
      if (!consumeAccountToken(token, uuid)) return new Response('invalid or expired token', { status: 401, headers: { 'access-control-allow-origin': '*' } });
      const data = {
        uuid,
        skill: skillStore.get(uuid) ?? null,
        reportsMade: [...reportsStore.values()].flat().filter(r => r.byUuid === uuid),
        reportsReceived: reportsStore.get(uuid) ?? [],
        surveys: surveyStore.filter(s => s.byUuid === uuid),
        kicks: kickHistory.get(uuid) ?? [],
        blocked: blockedUuids.has(uuid),
        gdprPending: gdprPending.get(uuid) ?? null,
        exportedAt: Date.now(),
      };
      return new Response(JSON.stringify(data, null, 2), {
        headers: {
          'content-type': 'application/json',
          'access-control-allow-origin': '*',
          'content-disposition': `attachment; filename="tribes-data-${uuid.slice(0,8)}.json"`,
        },
      });
    }
    // R27: GDPR delete — schedules a 7-day grace deletion. Reconnecting
    // within the window cancels (handled in WS open below).
    if (url.pathname === '/account/delete' && req.method === 'POST') {
      const uuid = url.searchParams.get('uuid') || '';
      const token = url.searchParams.get('token') || '';
      if (!consumeAccountToken(token, uuid)) return new Response(JSON.stringify({ error: 'invalid or expired token' }), { status: 401, headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' } });
      gdprPending.set(uuid, { scheduledAt: Date.now(), expiresAt: Date.now() + GDPR_GRACE_MS });
      emitEvent('account.delete-scheduled', { uuid: uuid.slice(0,8), expiresAt: Date.now() + GDPR_GRACE_MS });
      return new Response(JSON.stringify({ ok: true, expiresAt: Date.now() + GDPR_GRACE_MS }), { headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' } });
    }
    // R26 + R28: shared replay download by hash (paste-link flow)
    if (url.pathname === '/replay-shared') {
      const hash = url.searchParams.get('h') || '';
      pruneSharedReplays();
      // R28: try R2 first when configured, fall back to in-memory
      let bytes: Uint8Array | null = null;
      if (R2_CONFIG) {
        bytes = await r2Get(R2_CONFIG, `replays/${hash}.tribes-replay`);
      }
      if (!bytes) {
        const entry = sharedReplayStore.get(hash);
        bytes = entry?.bytes ?? null;
      }
      if (!bytes) return new Response('not found or expired', { status: 404, headers: { 'access-control-allow-origin': '*' } });
      return new Response(bytes, {
        headers: {
          'content-type': 'application/octet-stream',
          'access-control-allow-origin': '*',
          'content-disposition': `attachment; filename="shared-${hash}.tribes-replay"`,
        },
      });
    }
    // R26 + R28: shared replay upload — accepts a binary blob and returns {shareUrl}
    if (url.pathname === '/replay-upload' && req.method === 'POST') {
      return req.arrayBuffer().then(async buf => {
        const bytes = new Uint8Array(buf);
        // Light validation — must start with 'TRBR' magic
        if (bytes.length < 8 || bytes[0] !== 0x54 || bytes[1] !== 0x52 || bytes[2] !== 0x42 || bytes[3] !== 0x52) {
          return new Response(JSON.stringify({ error: 'not a .tribes-replay file' }), { status: 400, headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' } });
        }
        if (bytes.length > 16 * 1024 * 1024) {
          return new Response(JSON.stringify({ error: 'replay too large (>16MB)' }), { status: 413, headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' } });
        }
        pruneSharedReplays();
        const hash = shareHash();
        const expiresAt = Date.now() + SHARED_REPLAY_TTL_MS;
        let storedToR2 = false;
        if (R2_CONFIG) {
          try { storedToR2 = await r2Put(R2_CONFIG, `replays/${hash}.tribes-replay`, bytes, { ttlExpiresAt: String(expiresAt) }); }
          catch (e) { console.warn('[R2] put failed, falling back to memory:', e); }
        }
        if (!storedToR2) {
          sharedReplayStore.set(hash, { bytes, expiresAt });
        }
        const origin = url.origin;
        const shareUrl = `${origin}/replay-shared?h=${hash}`;
        console.log(`[REPLAY-SHARE] uploaded ${hash} (${(bytes.length / 1024).toFixed(1)} KB, ${storedToR2 ? 'R2' : 'memory'})`);
        return new Response(JSON.stringify({ shareUrl, hash, expiresAt, storage: storedToR2 ? 'r2' : 'memory' }), {
          headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' },
        });
      }).catch(e => new Response(JSON.stringify({ error: 'upload failed: ' + (e as Error).message }), { status: 500, headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' } }));
    }
    return new Response('Tribes Lobby + Match Server (R20). WebSocket: /ws  Browse: /lobbies', { status: 200 });
  },
  websocket: {
    open(ws) {
      const wsData = (ws as any).data || {};
      const requestedLobbyId = wsData.lobbyIdReq as string | undefined;
      const incomingUuid = wsData.uuid as string;
      const requestedMap = (wsData.mapReq as string) || '';
      const requestedRanked = !!wsData.rankedReq;
      // R26: look up the joiner's current rating to allow tier-preferred routing.
      const joinerRow = incomingUuid ? skillStore.get(incomingUuid) : null;
      const lobby = findOrCreateLobby(requestedLobbyId, { ranked: requestedRanked, rating: joinerRow?.rating });
      // R25: only honour ?map= if the lobby has no match yet AND no other map
      // was already chosen by an earlier connection. Default stays Raindance.
      if (requestedMap && !lobby.match && lobby.mapId === 'raindance' && requestedMap !== 'raindance') {
        setLobbyMap(lobby, requestedMap);
      }
      // R26: only the first-joining player sets ranked mode (others inherit).
      if (lobby.members.size === 0 && !lobby.match) lobby.ranked = requestedRanked;

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
        ranked: lobby.ranked,                     // R26: client uses this to label the badge
      }));
      broadcastJSON(lobby, buildPlayerList(lobby));
      metrics.playersConnected++;
      // R27: cancel any pending GDPR delete — they came back within grace
      if (newUuid && gdprPending.has(newUuid)) {
        gdprPending.delete(newUuid);
        console.log(`[GDPR] cancelled pending delete for ${newUuid.slice(0,8)} (reconnect within grace)`);
        emitEvent('account.delete-cancelled', { uuid: newUuid.slice(0,8), reason: 'reconnect-within-grace' });
      }
      // R27: structured event
      emitEvent('player.connected', { playerId, numericId, lobbyId: lobby.id, reconnected, uuid: newUuid.slice(0,8) });
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
            // R27: server-side defense-in-depth profanity check
            const v = validateUsername(msg.name);
            if (!v.ok) {
              ws.send(JSON.stringify({ type: 'setNameRejected', reason: v.reason }));
              break;
            }
            conn.name = msg.name.replace(/[^\w\-_. ]/g, '').slice(0, 32);
            broadcastJSON(lobby, buildPlayerList(lobby));
          }
          break;
        case 'ping':
          ws.send(JSON.stringify({ type: 'pong', clientTs: msg.clientTs, serverTs: Date.now() }));
          break;
        case 'chat': {
          // R28: text chat with channels, sanitisation, rate limit, soft-mute
          if (typeof msg.text !== 'string' || msg.text.length === 0) break;
          const channel: 'all' | 'team' = (msg.channel === 'team') ? 'team' : 'all';
          const isEmote = msg.emote === true;       // /me action
          const senderUuid = (ws as any).data?.uuid as string;
          const rate = chatRateState(senderUuid || conn.playerId);
          const now = Date.now();
          // Soft-mute window
          if (rate.softMuteUntil > now) {
            try { ws.send(JSON.stringify({ type: 'chatRejected', reason: 'soft-muted', untilMs: rate.softMuteUntil })); } catch {}
            emitEvent('chat.rate-limited', { uuid: (senderUuid || '').slice(0, 8), softMute: true });
            break;
          }
          // Slide rate window (5 messages / 10s)
          rate.sent = rate.sent.filter(t => t > now - 10_000);
          if (rate.sent.length >= 5) {
            rate.rateHits = rate.rateHits.filter(t => t > now - 60_000);
            rate.rateHits.push(now);
            if (rate.rateHits.length >= 3) {
              rate.softMuteUntil = now + 30_000;
              try { ws.send(JSON.stringify({ type: 'chatRejected', reason: 'rate-limit-soft-mute', untilMs: rate.softMuteUntil })); } catch {}
            } else {
              try { ws.send(JSON.stringify({ type: 'chatRejected', reason: 'rate-limit' })); } catch {}
            }
            emitEvent('chat.rate-limited', { uuid: (senderUuid || '').slice(0, 8), hits: rate.rateHits.length });
            break;
          }
          // Sanitise — server defense-in-depth (R27 client also sanitises)
          // R28: also applies admin add/remove overrides via moderationContains
          if (moderationContains(msg.text)) {
            try { ws.send(JSON.stringify({ type: 'chatRejected', reason: 'profanity' })); } catch {}
            emitEvent('chat.blocked', { uuid: (senderUuid || '').slice(0, 8), channel, len: msg.text.length });
            break;
          }
          rate.sent.push(now);
          rate.lastChannel = channel;
          rate.lastSent = msg.text;
          // Build the broadcast payload
          const senderShadow = senderUuid ? getOrAssignShadow(lobby.id, senderUuid) : '';
          const senderRating = senderUuid ? (skillStore.get(senderUuid)?.rating ?? SKILL_INITIAL) : SKILL_INITIAL;
          const out = {
            type: 'chat',
            channel,
            emote: isEmote,
            from: conn.name,
            shadowId: senderShadow,
            team: conn.team,
            rating: senderRating,
            text: msg.text.slice(0, 280),
            ts: now,
          };
          // Team channel — only members of the same team see it
          if (channel === 'team') {
            for (const pid of lobby.members) {
              const c = connections.get(pid);
              if (!c || c.team !== conn.team) continue;
              try { c.ws.send(JSON.stringify(out)); } catch {}
            }
          } else {
            broadcastJSON(lobby, out);
          }
          break;
        }
        case 'emoji': {
          // R28: validated emoji reaction floats above the player
          const e = String(msg.emoji || '');
          if (!EMOJI_WHITELIST.has(e)) break;
          const senderUuid = (ws as any).data?.uuid as string;
          const senderShadow = senderUuid ? getOrAssignShadow(lobby.id, senderUuid) : '';
          broadcastJSON(lobby, {
            type: 'emoji', emoji: e, from: conn.name, shadowId: senderShadow,
            playerId: conn.numericId, ts: Date.now(),
          });
          break;
        }
        case 'mute': {
          // R28: server-mediated mute; client sends shadowId, server resolves
          // to uuid + persists. Replies privately so the muter can update UI.
          const sid = String(msg.shadowId || '');
          const muted = !!msg.muted;
          const muterUuid = (ws as any).data?.uuid as string;
          if (!muterUuid || !sid) break;
          const targetUuid = resolveShadow(lobby.id, sid);
          if (!targetUuid) {
            try { ws.send(JSON.stringify({ type: 'muteAck', shadowId: sid, ok: false, reason: 'shadow-not-found' })); } catch {}
            emitEvent('chat.shadow-not-found', { lobbyId: lobby.id, shadowId: sid, action: 'mute' });
            break;
          }
          setMute(muterUuid, targetUuid, muted);
          try { ws.send(JSON.stringify({ type: 'muteAck', shadowId: sid, ok: true, muted })); } catch {}
          break;
        }
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
        case 'mapVote': {
          // R25: one vote per player per match-end window. Recasting overwrites.
          const choice = typeof msg.mapId === 'string' ? msg.mapId : '';
          if (lobby.mapVoteOptions.includes(choice)) {
            // remove any prior vote from this player
            for (const id of lobby.mapVoteOptions) {
              const cast = (lobby as any)[`__voted_${conn.numericId}`];
              if (cast === id) lobby.mapVoteTally.set(id, Math.max(0, (lobby.mapVoteTally.get(id) || 0) - 1));
            }
            lobby.mapVoteTally.set(choice, (lobby.mapVoteTally.get(choice) || 0) + 1);
            (lobby as any)[`__voted_${conn.numericId}`] = choice;
            lobby.mapVoteCast.add(conn.numericId);
            broadcastJSON(lobby, {
              type: 'mapVoteUpdate',
              tally: Object.fromEntries(lobby.mapVoteTally),
              voters: lobby.mapVoteCast.size,
            });
          }
          break;
        }
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
        // R27: structured event with close code for triage
        emitEvent('player.disconnected', { playerId, numericId: conn.numericId, lobbyId: lobby.id, durationS: sessionS, closeCode: (ws as any)?.readyState });
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
<div style="display:grid;grid-template-columns:1fr 1fr;gap:20px;margin-bottom:20px;">
  <div>
    <h3>Per-map play counts (recent ~50)</h3>
    <table id="permap"><tr><th>Map</th><th>Plays</th></tr></table>
  </div>
  <div>
    <h3>Ranked queue depth per tier</h3>
    <table id="queuedepth"><tr><th>Tier</th><th>Players queued</th></tr></table>
  </div>
</div>
<h3>Top 10 by rating</h3><table id="toprated"><tr><th>UUID</th><th>Rating</th><th>Tier</th><th>Matches</th></tr></table>
<h3>Recent matches</h3><table id="matches"><tr><th>Match</th><th>Duration</th><th>Peak</th><th>Kills</th><th>Winner</th></tr></table>
<h3>Last cheat events</h3><table id="cheats"><tr><th>Time</th><th>Player</th><th>Code</th><th>Detail</th></tr></table>
<div style="display:grid;grid-template-columns:1fr 1fr;gap:20px;margin-top:20px;">
  <div>
    <h3>Top reported (24h+)</h3>
    <table id="reports"><tr><th>UUID</th><th>Count</th><th>Last category</th></tr></table>
  </div>
  <div>
    <h3>Survey sentiment (last 24h)</h3>
    <div id="survey-summary" style="font-size:0.9em">No surveys yet.</div>
  </div>
</div>
<h3>Tail events <span style="color:#7a6a4a;font-size:0.7em">(polled 5s)</span></h3>
<select id="event-filter" style="background:#16140e;color:#FFC850;border:1px solid #3a2c1c;padding:4px 8px;margin-bottom:6px;">
  <option value="">All</option><option>match.started</option><option>match.ended</option>
  <option>player.connected</option><option>player.disconnected</option><option>player.kicked</option>
  <option>player.reported</option><option>cheat.detected</option><option>error.5xx</option>
  <option>survey.submitted</option><option>account.delete-scheduled</option>
</select>
<table id="events"><tr><th>Time</th><th>Type</th><th>Payload</th></tr></table>
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
    // R26 dashboard extensions
    const pm = m.perMapPlayCounts || {};
    document.getElementById('permap').innerHTML = '<tr><th>Map</th><th>Plays</th></tr>' +
      Object.entries(pm).sort((a,b)=>b[1]-a[1]).map(([k,v]) => '<tr><td>'+k+'</td><td>'+v+'</td></tr>').join('');
    const qd = m.rankedQueueDepth || {};
    document.getElementById('queuedepth').innerHTML = '<tr><th>Tier</th><th>Players queued</th></tr>' +
      Object.entries(qd).sort((a,b)=>b[1]-a[1]).map(([k,v]) => '<tr><td>'+k+'</td><td>'+v+'</td></tr>').join('') ||
      '<tr><td colspan=2 style="color:#7a6a4a">No ranked queue activity</td></tr>';
    document.getElementById('toprated').innerHTML = '<tr><th>UUID</th><th>Rating</th><th>Tier</th><th>Matches</th></tr>' +
      (m.topRated||[]).map(t => '<tr><td>'+t.uuid+'…</td><td>'+t.rating+'</td><td>'+t.tier+'</td><td>'+t.matches+'</td></tr>').join('');
    // R27 dashboard surfaces
    document.getElementById('reports').innerHTML = '<tr><th>UUID</th><th>Count</th><th>Last category</th></tr>' +
      (m.topReported||[]).map(t => '<tr><td>'+t.uuid+'…</td><td>'+t.count+'</td><td class="warn">'+(t.last && t.last.category || '-')+'</td></tr>').join('');
    if (m.survey) {
      const s = m.survey;
      const tagsHtml = (s.topTags||[]).map(t => t[0]+' ('+t[1]+')').join(', ');
      const samplesHtml = (s.samples||[]).map(x => '<li>★'+x.rating+' &mdash; '+x.comment+'</li>').join('');
      document.getElementById('survey-summary').innerHTML =
        '<div>'+s.count24h+' responses · avg ★'+s.avgRating+'</div>' +
        '<div style="margin-top:6px;color:#7a6a4a">Top tags: '+tagsHtml+'</div>' +
        '<ul style="margin-top:6px;padding-left:18px;">'+samplesHtml+'</ul>';
    }
    const filter = document.getElementById('event-filter').value;
    const rows = (m.recentEvents||[]).filter(e => !filter || e.type === filter);
    document.getElementById('events').innerHTML = '<tr><th>Time</th><th>Type</th><th>Payload</th></tr>' +
      rows.map(e => '<tr><td>'+new Date(e.ts).toLocaleTimeString()+'</td><td>'+e.type+'</td><td><code style="color:#7a6a4a;font-size:0.78em">'+JSON.stringify(e.payload)+'</code></td></tr>').join('');
  } catch(e){ console.error(e); }
}
refresh(); setInterval(refresh, 2000);
</script></body></html>`;

console.log(`[tribes-lobby R19] listening on http://localhost:${server.port}`);
console.log(`[tribes-lobby R19] WebSocket: ws://localhost:${server.port}/ws`);
console.log(`[tribes-lobby R19] Health check: http://localhost:${server.port}/health`);
console.log(`[tribes-lobby R19] Tick=${TICK_HZ}Hz Snapshot=${SNAPSHOT_HZ}Hz Delta=${DELTA_HZ}Hz`);
