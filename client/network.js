// ============================================================
// Tribes Browser Edition — Client Network Module (R16 scaffold)
// ============================================================
// Minimal WebSocket client. Connects to the lobby server, sends a join
// message, and logs all received messages. R19 will extend this into the
// full game-state networking layer.
//
// All handlers are async / non-blocking. Never touches the render loop.
// Activated by ?multiplayer=local URL flag (or ?multiplayer=remote with
// optional ?server=wss://... override).
// ============================================================

let socket = null;
let connectedAt = 0;
let lastMessageAt = 0;
let myPlayerId = null;
let myLobbyId = null;
let onMessageHandlers = [];

function log(msg) {
    console.log('[NET] ' + msg);
}

function getServerUrl() {
    const params = new URLSearchParams(location.search);
    const explicit = params.get('server');
    if (explicit) return explicit;

    const mode = params.get('multiplayer');
    if (mode === 'local') return 'ws://localhost:8080/ws';
    if (mode === 'remote') return 'wss://tribes-lobby.fly.dev/ws'; // placeholder until R16 deploy lands
    return 'ws://localhost:8080/ws';
}

export function start() {
    const url = getServerUrl();
    log('connecting to ' + url);

    try {
        socket = new WebSocket(url);
    } catch (err) {
        log('connect failed: ' + err.message);
        return;
    }

    socket.onopen = () => {
        connectedAt = performance.now();
        log('socket open');
        // No explicit join needed — the server auto-joins on connect and
        // sends a joinAck. We just log the round-trip timing.
    };

    socket.onmessage = (event) => {
        lastMessageAt = performance.now();
        let msg;
        try {
            msg = JSON.parse(event.data);
        } catch {
            log('drop malformed message');
            return;
        }
        if (msg.type === 'joinAck') {
            myPlayerId = msg.playerId;
            myLobbyId = msg.lobbyId;
            const rttMs = Math.round(lastMessageAt - connectedAt);
            log('joined lobby ' + myLobbyId + ' as ' + msg.name +
                ' (RTT ' + rttMs + 'ms, ' + msg.memberCount + '/' + msg.capacity + ' players)');
        } else if (msg.type === 'playerList') {
            log('lobby ' + msg.lobbyId + ' roster: ' + msg.players.map(p => p.name).join(', '));
        } else if (msg.type === 'pong') {
            const rttMs = msg.serverTs - msg.clientTs;
            log('pong rtt=' + rttMs + 'ms');
        } else if (msg.type === 'chat') {
            log('chat ' + msg.from + ': ' + msg.text);
        } else {
            log('recv ' + msg.type);
        }
        // Dispatch to any subscribers (R19 game state will use this)
        for (const h of onMessageHandlers) {
            try { h(msg); } catch (e) { console.error('[NET] handler threw:', e); }
        }
    };

    socket.onerror = (event) => {
        log('socket error');
        console.error('[NET] error event:', event);
    };

    socket.onclose = (event) => {
        log('socket closed (' + event.code + ' ' + event.reason + ')');
        socket = null;
        myPlayerId = null;
        myLobbyId = null;
    };

    // Periodic ping for clock-sync + keepalive
    setInterval(() => {
        if (socket && socket.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify({ type: 'ping', clientTs: Date.now() }));
        }
    }, 10_000);
}

// Public API for future game-state code (R19)
export function send(msg) {
    if (!socket || socket.readyState !== WebSocket.OPEN) return false;
    try {
        socket.send(typeof msg === 'string' ? msg : JSON.stringify(msg));
        return true;
    } catch (err) {
        console.error('[NET] send failed:', err);
        return false;
    }
}

export function sendBinary(arrayBuffer) {
    if (!socket || socket.readyState !== WebSocket.OPEN) return false;
    try {
        socket.send(arrayBuffer);
        return true;
    } catch {
        return false;
    }
}

export function onMessage(handler) {
    onMessageHandlers.push(handler);
    return () => {
        const i = onMessageHandlers.indexOf(handler);
        if (i >= 0) onMessageHandlers.splice(i, 1);
    };
}

export function getStatus() {
    return {
        connected: socket && socket.readyState === WebSocket.OPEN,
        playerId: myPlayerId,
        lobbyId: myLobbyId,
        msSinceLastMessage: lastMessageAt > 0 ? performance.now() - lastMessageAt : null,
    };
}
