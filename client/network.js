// ============================================================
// Tribes Browser Edition — Client Network Module (R16 + R19)
// ============================================================
// R16: WebSocket lobby connection + JSON control messages
// R19: Binary game-state protocol (snapshot/delta/input), 60Hz input
//      send loop, prediction reconciliation, bandwidth telemetry
// ============================================================

import { decodeSnapshot, decodeDelta, encodeInput } from './wire.js';
import { MSG_SNAPSHOT, MSG_DELTA, INPUT_HZ } from './constants.js';
import * as prediction from './prediction.js';
import * as voice from './voice.js';
window.__voiceUpdatePeer = voice.updatePeerPosition;

let socket = null;
let connectedAt = 0;
let lastMessageAt = 0;
let myPlayerId = null;
let myNumericId = -1;
let myLobbyId = null;
let onMessageHandlers = [];

// Bandwidth telemetry
const telemetry = {
    bytesIn: 0, bytesOut: 0,
    bytesInWindow: [], bytesOutWindow: [], // [{ts, bytes}]
    pingMs: 0,
    lastPingSent: 0,
    matchActive: false,
    inMatch: false,
    // R24: skill rating mirrored from joinAck + matchEnd
    skillRating: 1000,
    matchesPlayed: 0,
    lastRatingDelta: 0,
};

// 60Hz input loop
let inputLoop = null;
let inputProvider = null;   // () → {buttons, mouseDX, mouseDY, weaponSelect}

// Latest server snapshot (for prediction reconcile)
let latestSnapshot = null;

function log(msg) { console.log('[NET] ' + msg); }

function getServerUrl() {
    const params = new URLSearchParams(location.search);
    const explicit = params.get('server');
    const lobbyId = params.get('lobbyId') || '';
    const storedUuid = localStorage.getItem('tribes_player_uuid') || '';
    const qs = (lobbyId || storedUuid)
        ? '?' + (lobbyId ? 'lobbyId=' + encodeURIComponent(lobbyId) : '')
              + (lobbyId && storedUuid ? '&' : '')
              + (storedUuid ? 'uuid=' + encodeURIComponent(storedUuid) : '')
        : '';
    // Priority: ?server= URL flag → window.__TRIBES_SERVER_URL → mode default
    if (explicit) return explicit + qs;
    if (window.__TRIBES_SERVER_URL) return window.__TRIBES_SERVER_URL + qs;
    const mode = params.get('multiplayer');
    if (mode === 'local') return 'ws://localhost:8080/ws' + qs;
    if (mode === 'remote') {
        // Default fallback: derive from current host. Production builds should
        // set window.__TRIBES_SERVER_URL = 'wss://tribes-lobby.<your>.workers.dev/ws'
        // in index.html or via a build-time injected variable.
        const fallback = 'wss://tribes-server.workers.dev/ws';
        console.warn('[NET] window.__TRIBES_SERVER_URL not set; using placeholder ' + fallback);
        return fallback + qs;
    }
    return 'ws://localhost:8080/ws' + qs;
}

function trackInbound(bytes) {
    telemetry.bytesIn += bytes;
    const now = performance.now();
    telemetry.bytesInWindow.push({ ts: now, bytes });
    while (telemetry.bytesInWindow.length > 0 && telemetry.bytesInWindow[0].ts < now - 1000) {
        telemetry.bytesInWindow.shift();
    }
}
function trackOutbound(bytes) {
    telemetry.bytesOut += bytes;
    const now = performance.now();
    telemetry.bytesOutWindow.push({ ts: now, bytes });
    while (telemetry.bytesOutWindow.length > 0 && telemetry.bytesOutWindow[0].ts < now - 1000) {
        telemetry.bytesOutWindow.shift();
    }
}

export function start() {
    const url = getServerUrl();
    log('connecting to ' + url);
    try {
        socket = new WebSocket(url);
        socket.binaryType = 'arraybuffer';
    } catch (err) {
        log('connect failed: ' + err.message);
        return;
    }

    socket.onopen = () => {
        connectedAt = performance.now();
        log('socket open');
    };

    socket.onmessage = async (event) => {
        lastMessageAt = performance.now();
        const data = event.data;

        // Binary message — game-state snapshot or delta
        if (data instanceof ArrayBuffer) {
            const u8 = new Uint8Array(data);
            trackInbound(u8.byteLength);
            const type = u8[0];
            if (type === MSG_SNAPSHOT) {
                const snap = decodeSnapshot(u8);
                if (snap) {
                    latestSnapshot = snap;
                    if (window.__tribesReconcile) window.__tribesReconcile(snap);
                } else {
                    log('drop malformed snapshot (' + u8.byteLength + 'B)');
                }
            } else if (type === MSG_DELTA) {
                const delta = decodeDelta(u8);
                if (delta && window.__tribesApplyDelta) window.__tribesApplyDelta(delta);
            }
            // Don't dispatch binary to onMessageHandlers
            return;
        }

        // String message — JSON control
        trackInbound(typeof data === 'string' ? data.length : 0);
        let msg;
        try { msg = JSON.parse(data); } catch { log('drop malformed JSON'); return; }

        if (msg.type === 'joinAck') {
            myPlayerId = msg.playerId;
            myNumericId = msg.numericId ?? -1;
            myLobbyId = msg.lobbyId;
            // R20: persist UUID for reconnect grace
            if (msg.uuid) try { localStorage.setItem('tribes_player_uuid', msg.uuid); } catch {}
            prediction.setLocalNumericId(myNumericId);
            const rttMs = Math.round(lastMessageAt - connectedAt);
            log('joined ' + myLobbyId + ' as ' + msg.name + ' (id=' + myNumericId + ', RTT ' + rttMs + 'ms' + (msg.reconnected ? ' [RECONNECTED]' : '') + ')');
            if (msg.reconnected && window.__tribesHideReconnect) window.__tribesHideReconnect();
            // R24: capture skill rating from joinAck for main-menu display
            if (typeof msg.skillRating === 'number') telemetry.skillRating = msg.skillRating;
            if (typeof msg.matchesPlayed === 'number') telemetry.matchesPlayed = msg.matchesPlayed;
            if (window.__tribesOnSkillUpdate) window.__tribesOnSkillUpdate({
                rating: telemetry.skillRating, matchesPlayed: telemetry.matchesPlayed, delta: 0,
            });
        } else if (msg.type === 'playerList') {
            log('roster: ' + msg.players.map(p => p.name).join(', '));
            telemetry.matchActive = msg.matchActive;
        } else if (msg.type === 'matchStart') {
            log('matchStart in ' + msg.lobbyId + ' players=' + msg.players.length);
            telemetry.inMatch = true;
            startInputLoop();
            // R23: open voice peers to all teammates
            voice.setLocalNumericId(myNumericId);
            voice.init(send);
            const myTeam = msg.players.find(p => p.id === myNumericId)?.team;
            const teammateIds = msg.players.filter(p => p.team === myTeam && p.id !== myNumericId).map(p => p.id);
            voice.openPeers(teammateIds).catch(e => console.warn('[VOICE] openPeers failed', e));
            if (window.__tribesOnMatchStart) window.__tribesOnMatchStart(msg);
        } else if (msg.type === 'matchEnd') {
            log('matchEnd score=' + msg.teamScore.join('-') + ' winner=' + msg.winner);
            telemetry.inMatch = false;
            stopInputLoop();
            // R24: pull our rating delta out of the match-end broadcast (rated matches only)
            if (msg.ratings && typeof msg.ratings === 'object') {
                const myRow = msg.ratings[myNumericId];
                if (myRow) {
                    telemetry.skillRating = myRow.rating | 0;
                    telemetry.lastRatingDelta = myRow.delta | 0;
                    telemetry.matchesPlayed = (telemetry.matchesPlayed | 0) + 1;
                    if (window.__tribesOnSkillUpdate) window.__tribesOnSkillUpdate({
                        rating: telemetry.skillRating, matchesPlayed: telemetry.matchesPlayed,
                        delta: telemetry.lastRatingDelta,
                    });
                }
            }
            if (window.__tribesOnMatchEnd) window.__tribesOnMatchEnd(msg);
        } else if (msg.type === 'pong') {
            telemetry.pingMs = msg.serverTs - msg.clientTs;
        } else if (msg.type === 'kill') {
            // R20: server-side kill → client kill feed (uses existing addKillMsg)
            if (window.addKillMsg) {
                const fmt = msg.killer + '~' + (msg.weapon | 0) + '~' + msg.victim;
                window.addKillMsg(fmt);
            }
        } else if (msg.type === 'rematchVote') {
            const ve = document.getElementById('me-vote');
            if (ve) ve.textContent = 'PLAY AGAIN votes: ' + msg.votes + ' / ' + msg.eligible + ' (need 75%)';
        } else if (msg.type === 'voiceOffer' || msg.type === 'voiceAnswer' || msg.type === 'voiceCandidate') {
            // R23: route to voice module
            voice.handleVoiceMessage(msg).catch(e => console.warn('[VOICE]', e));
        } else if (msg.type === 'chat') {
            log('chat ' + msg.from + ': ' + msg.text);
        } else {
            log('recv ' + msg.type);
        }
        for (const h of onMessageHandlers) {
            try { h(msg); } catch (e) { console.error('[NET] handler threw:', e); }
        }
    };

    socket.onerror = (event) => { log('socket error'); console.error('[NET]', event); };

    socket.onclose = (event) => {
        const wasInMatch = telemetry.inMatch;
        log('socket closed (' + event.code + ' ' + event.reason + ')');
        socket = null;
        myPlayerId = null;
        myNumericId = -1;
        myLobbyId = null;
        telemetry.inMatch = false;
        stopInputLoop();
        prediction.reset();
        // R20: if we lost connection mid-match, show reconnect overlay
        if (wasInMatch && window.__tribesShowReconnect) {
            window.__tribesShowReconnect();
        }
    };

    // Periodic ping for clock-sync (drives telemetry.pingMs)
    setInterval(() => {
        if (socket && socket.readyState === WebSocket.OPEN) {
            const payload = JSON.stringify({ type: 'ping', clientTs: Date.now() });
            telemetry.lastPingSent = Date.now();
            trackOutbound(payload.length);
            socket.send(payload);
        }
    }, 2000);
}

// ============================================================
// 60Hz input send loop
// ============================================================
export function setInputProvider(fn) {
    inputProvider = fn; // returns {buttons, mouseDX, mouseDY, weaponSelect} or null
}
function startInputLoop() {
    if (inputLoop) return;
    const intervalMs = 1000 / INPUT_HZ;
    inputLoop = setInterval(() => {
        if (!inputProvider) return;
        if (!socket || socket.readyState !== WebSocket.OPEN) return;
        const raw = inputProvider();
        if (!raw) return;
        const tick = prediction.nextTick();
        const input = {
            tick,
            buttons:      raw.buttons | 0,
            mouseDX:      raw.mouseDX || 0,
            mouseDY:      raw.mouseDY || 0,
            pingMs:       telemetry.pingMs | 0,
            weaponSelect: raw.weaponSelect == null ? 0xFF : raw.weaponSelect,
        };
        const buf = encodeInput(input);
        try { socket.send(buf); trackOutbound(buf.byteLength); } catch {}
        prediction.recordInput(tick, input, 1 / INPUT_HZ);
    }, intervalMs);
}
function stopInputLoop() {
    if (inputLoop) { clearInterval(inputLoop); inputLoop = null; }
}

// ============================================================
// Public API
// ============================================================
export function send(msg) {
    if (!socket || socket.readyState !== WebSocket.OPEN) return false;
    try {
        const payload = typeof msg === 'string' ? msg : JSON.stringify(msg);
        socket.send(payload);
        trackOutbound(payload.length);
        return true;
    } catch (err) { console.error('[NET] send failed:', err); return false; }
}
export function sendBinary(arrayBuffer) {
    if (!socket || socket.readyState !== WebSocket.OPEN) return false;
    try { socket.send(arrayBuffer); trackOutbound(arrayBuffer.byteLength); return true; } catch { return false; }
}
export function onMessage(handler) {
    onMessageHandlers.push(handler);
    return () => { const i = onMessageHandlers.indexOf(handler); if (i >= 0) onMessageHandlers.splice(i, 1); };
}
export function getStatus() {
    const sumIn = telemetry.bytesInWindow.reduce((a, e) => a + e.bytes, 0);
    const sumOut = telemetry.bytesOutWindow.reduce((a, e) => a + e.bytes, 0);
    return {
        connected: !!(socket && socket.readyState === WebSocket.OPEN),
        playerId: myPlayerId,
        numericId: myNumericId,
        lobbyId: myLobbyId,
        bytesInPerSec: sumIn,
        bytesOutPerSec: sumOut,
        kbInPerSec: (sumIn / 1024).toFixed(1),
        kbOutPerSec: (sumOut / 1024).toFixed(2),
        pingMs: telemetry.pingMs,
        inMatch: telemetry.inMatch,
        reconciliations: prediction.stats.reconciliations,
        avgDivergence: prediction.stats.avgDivergence.toFixed(3),
        // R24
        skillRating: telemetry.skillRating,
        matchesPlayed: telemetry.matchesPlayed,
        lastRatingDelta: telemetry.lastRatingDelta,
    };
}
export function getLatestSnapshot() { return latestSnapshot; }
export { prediction };
