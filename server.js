/**
 * Firewolf local multiplayer server — home LAN play.
 *
 * Usage:
 *   node server.js
 *
 * Then on every device on your WiFi, open:
 *   http://<your-machine-ip>:8080
 *
 * Find your machine's IP with:
 *   macOS:  ipconfig getifaddr en0
 *   Windows: ipconfig (look for IPv4)
 *   Linux:   hostname -I
 *
 * Supports up to 8 players. No accounts, no internet required.
 */

const http  = require('http');
const fs    = require('fs');
const path  = require('path');
const { WebSocketServer } = require('ws');

const PORT    = 8080;
const MAX_PL  = 8;

// ── Lobby state ────────────────────────────────────────────
const LOBBY_ID = 'home';
let nextNumericId = 0;
const players = new Map(); // ws → { numericId, name, uuid, ws }

// ── HTTP — serve the game files ────────────────────────────
const MIME = {
  '.html': 'text/html', '.js':   'application/javascript',
  '.css':  'text/css',  '.wasm': 'application/wasm',
  '.data': 'application/octet-stream',
  '.png':  'image/png', '.webp': 'image/webp',
  '.glb':  'model/gltf-binary', '.json': 'application/json',
  '.DTS':  'application/octet-stream', '.dts': 'application/octet-stream',
  '.bin':  'application/octet-stream',
};

const httpServer = http.createServer((req, res) => {
  // WebSocket upgrade requests are handled by the ws server
  if (req.headers.upgrade?.toLowerCase() === 'websocket') return;

  let filePath = path.join(__dirname, req.url === '/' ? 'index.html' : req.url);
  // Strip query string
  filePath = filePath.split('?')[0];

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404); res.end('Not found: ' + req.url); return;
    }
    const ext  = path.extname(filePath).toLowerCase();
    const mime = MIME[ext] || 'application/octet-stream';
    // COOP/COEP headers required for SharedArrayBuffer (WASM threads)
    res.writeHead(200, {
      'Content-Type': mime,
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    });
    res.end(data);
  });
});

// ── WebSocket — relay state between players ────────────────
const wss = new WebSocketServer({ server: httpServer, path: '/ws' });

wss.on('connection', (ws, req) => {
  const params     = new URL(req.url, 'http://x').searchParams;
  const uuid       = params.get('uuid') || crypto.randomUUID();
  const lobbyParam = params.get('lobby') || LOBBY_ID;

  if (players.size >= MAX_PL) {
    ws.close(1008, 'Server full');
    return;
  }

  const numericId = nextNumericId++;
  const name      = 'Player ' + (numericId + 1);
  const player    = { numericId, name, uuid, ws };
  players.set(ws, player);

  console.log(`[+] ${name} connected (${players.size}/${MAX_PL})`);

  // Send joinAck
  ws.send(JSON.stringify({
    type: 'joinAck', playerId: uuid, numericId,
    lobbyId: LOBBY_ID, name, uuid, skillRating: 1000,
    matchesPlayed: 0, ranked: false, matchActive: true,
  }));

  // Broadcast updated player list to everyone
  broadcastPlayerList();

  ws.on('message', (data, isBinary) => {
    if (isBinary) {
      // Binary: game-state snapshot or input — relay to all others
      players.forEach((p) => {
        if (p.ws !== ws && p.ws.readyState === 1 /* OPEN */) {
          try { p.ws.send(data, { binary: true }); } catch {}
        }
      });
      return;
    }

    // JSON control message
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }

    if (msg.type === 'ping') {
      ws.send(JSON.stringify({ type: 'pong', clientTs: msg.clientTs, serverTs: Date.now() }));
      return;
    }

    // Relay any other JSON to all other players
    players.forEach((p) => {
      if (p.ws !== ws && p.ws.readyState === 1) {
        try { p.ws.send(data.toString()); } catch {}
      }
    });
  });

  ws.on('close', () => {
    const p = players.get(ws);
    players.delete(ws);
    console.log(`[-] ${p?.name ?? '?'} disconnected (${players.size}/${MAX_PL})`);
    broadcastPlayerList();
  });

  ws.on('error', () => {});
});

function broadcastPlayerList() {
  const list = [...players.values()].map(p => ({
    id: p.uuid, numericId: p.numericId, name: p.name, team: p.numericId % 2,
  }));
  const msg = JSON.stringify({ type: 'playerList', players: list, matchActive: true });
  players.forEach(p => {
    try { if (p.ws.readyState === 1) p.ws.send(msg); } catch {}
  });
}

// ── Start ──────────────────────────────────────────────────
httpServer.listen(PORT, '0.0.0.0', () => {
  console.log('\n🎮  Firewolf local server running\n');
  console.log('  Local:   http://localhost:' + PORT);
  try {
    const { execSync } = require('child_process');
    const ip = execSync("ipconfig getifaddr en0 2>/dev/null || hostname -I 2>/dev/null | awk '{print $1}'")
                 .toString().trim();
    if (ip) console.log('  Network: http://' + ip + ':' + PORT + '  ← share this with your kids');
  } catch {}
  console.log('\n  Up to ' + MAX_PL + ' players. No internet required.\n');
});
