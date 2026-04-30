/**
 * Browser-to-browser hosting via WebRTC.
 * No server required — signaling is done by copy-pasting a short code
 * (base64-encoded SDP) through any messaging app.
 *
 * RTCDataChannel mimics the WebSocket interface so network.js needs no changes.
 *
 * Usage:
 *   Host:   BrowserHost.host(onConnected)  → get offer code → share it
 *   Joiner: BrowserHost.join(offerCode, onConnected) → get answer code → send back
 *   Host:   BrowserHost.finalise(answerCode) → connected!
 */

// Google's free STUN servers — used only for NAT traversal on internet play.
// For same-WiFi play these aren't needed but don't hurt.
const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
];

let _pc   = null;   // RTCPeerConnection
let _chan = null;   // RTCDataChannel (host-created)
let _onConnected = null;

// ── Server URL (when local server is running) ──────────────────────
// Try same-origin first (game served from local server), then localhost:3000.
let _serverUrl = null;
async function _getServerUrl() {
  if (_serverUrl !== null) return _serverUrl;
  // Same-origin (game opened from http://192.168.68.112:3000)
  try {
    const r = await fetch('/api/signal/offer', { method:'OPTIONS' });
    if (r.ok || r.status === 204) { _serverUrl = ''; return ''; }
  } catch {}
  // GitHub Pages / external — try local server directly
  try {
    const r = await fetch('http://localhost:3000/api/signal/offer', { method:'OPTIONS' });
    if (r.ok || r.status === 204) { _serverUrl = 'http://localhost:3000'; return 'http://localhost:3000'; }
  } catch {}
  _serverUrl = null;
  return null;
}

// ── Host side ──────────────────────────────────────────────────────
export async function host(onConnected) {
  _onConnected = onConnected;
  _pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
  _chan = _pc.createDataChannel('game', { ordered: false, maxRetransmits: 0 });
  _setupChannel(_chan);

  const offer = await _pc.createOffer();
  await _pc.setLocalDescription(offer);
  await _waitForICE(_pc);

  // Try server for short code, fall back to raw SDP
  const base = await _getServerUrl();
  if (base !== null) {
    try {
      const r = await fetch(base + '/api/signal/offer', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ offer: _pc.localDescription }),
      });
      if (r.ok) {
        const { code } = await r.json();
        _pollForAnswer(base, code);
        return code;
      }
    } catch {}
  }

  // Fallback: raw base64 SDP
  return _encode(_pc.localDescription);
}

function _pollForAnswer(base, code) {
  const interval = setInterval(async () => {
    try {
      const r = await fetch(base + '/api/signal/answer/' + code);
      const d = await r.json();
      if (d.answer) {
        clearInterval(interval);
        await _pc.setRemoteDescription(d.answer);
      }
    } catch {}
  }, 1000);
  setTimeout(() => clearInterval(interval), 120000);
}

// Host calls this when server is NOT available (manual raw-SDP flow)
export async function finalise(answerCode) {
  const answer = _decode(answerCode);
  await _pc.setRemoteDescription(answer);
}

// ── Join side ──────────────────────────────────────────────────────
export async function join(offerCode, onConnected) {
  _onConnected = onConnected;
  _pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
  _pc.ondatachannel = (e) => { _chan = e.channel; _setupChannel(_chan); };

  // Short code (server path) vs raw SDP (fallback)
  const isShortCode = offerCode.length < 20;
  let offerSDP;

  if (isShortCode) {
    const base = await _getServerUrl();
    if (!base && base !== '') throw new Error('Local server not reachable — make sure start-server.command is running');
    const r = await fetch(base + '/api/signal/offer/' + offerCode);
    if (!r.ok) throw new Error('Room not found — check the code');
    const { offer } = await r.json();
    offerSDP = offer;
  } else {
    offerSDP = _decode(offerCode);
  }

  await _pc.setRemoteDescription(offerSDP);
  const answer = await _pc.createAnswer();
  await _pc.setLocalDescription(answer);
  await _waitForICE(_pc);

  if (isShortCode) {
    const base = await _getServerUrl() ?? '';
    await fetch(base + '/api/signal/answer/' + offerCode, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ answer: _pc.localDescription }),
    });
    return null; // no code to send back — server handles it
  }

  return _encode(_pc.localDescription); // fallback: joiner must still send this back
}

// ── Shared channel setup ───────────────────────────────────────────
function _setupChannel(chan) {
  chan.binaryType = 'arraybuffer';
  chan.onopen = () => {
    console.log('[WebRTC] Data channel open — peer connected');
    _onConnected?.(_makeSocketAdapter(chan));
  };
}

// RTCDataChannel adapter that looks like a WebSocket to network.js
function _makeSocketAdapter(chan) {
  return {
    binaryType: 'arraybuffer',
    get readyState() {
      // Map RTCDataChannel states to WebSocket states
      const s = chan.readyState;
      return s === 'connecting' ? 0 : s === 'open' ? 1 : s === 'closing' ? 2 : 3;
    },
    send(data)    { if (chan.readyState === 'open') chan.send(data); },
    close()       { chan.close(); _pc?.close(); },
    set onmessage(fn) { chan.onmessage = (e) => fn({ data: e.data }); },
    set onclose(fn)   { chan.onclose = fn; },
    set onerror(fn)   { chan.onerror = fn; },
    onopen: null,   // already handled above
  };
}

// ── Helpers ────────────────────────────────────────────────────────
function _waitForICE(pc) {
  return new Promise(resolve => {
    if (pc.iceGatheringState === 'complete') { resolve(); return; }
    const check = () => {
      if (pc.iceGatheringState === 'complete') {
        pc.removeEventListener('icegatheringstatechange', check);
        resolve();
      }
    };
    pc.addEventListener('icegatheringstatechange', check);
    // Fallback timeout in case complete never fires
    setTimeout(resolve, 4000);
  });
}

function _encode(desc) {
  // Compact: type + '\n' + sdp → base64 → URL-safe
  const raw = desc.type + '\n' + desc.sdp;
  return btoa(raw).replace(/\+/g,'-').replace(/\//g,'_').replace(/=/g,'');
}

function _decode(code) {
  const raw = atob(code.replace(/-/g,'+').replace(/_/g,'/'));
  const nl  = raw.indexOf('\n');
  return { type: raw.slice(0, nl), sdp: raw.slice(nl + 1) };
}

export function getChannel() { return _chan; }
export function getPeer()    { return _pc; }
