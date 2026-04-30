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

// ── Host side ──────────────────────────────────────────────────────
export async function host(onConnected) {
  _onConnected = onConnected;
  _pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });

  // Create reliable + unreliable channels
  _chan = _pc.createDataChannel('game', { ordered: false, maxRetransmits: 0 });
  _setupChannel(_chan);

  // Gather ICE candidates (wait for completion)
  const offer = await _pc.createOffer();
  await _pc.setLocalDescription(offer);
  await _waitForICE(_pc);

  // Encode full SDP (with candidates) as compact base64
  return _encode(_pc.localDescription);
}

// Host calls this with the answer code the joiner sent back
export async function finalise(answerCode) {
  const answer = _decode(answerCode);
  await _pc.setRemoteDescription(answer);
  // connection will fire onConnected via _setupChannel's onopen
}

// ── Join side ──────────────────────────────────────────────────────
export async function join(offerCode, onConnected) {
  _onConnected = onConnected;
  _pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });

  // Receive the data channel the host created
  _pc.ondatachannel = (e) => {
    _chan = e.channel;
    _setupChannel(_chan);
  };

  const offer = _decode(offerCode);
  await _pc.setRemoteDescription(offer);
  const answer = await _pc.createAnswer();
  await _pc.setLocalDescription(answer);
  await _waitForICE(_pc);

  return _encode(_pc.localDescription);
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
