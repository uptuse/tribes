// ============================================================
// Voice chat: WebRTC mesh with WebSocket signaling (R23)
//
// Architecture: each client establishes one RTCPeerConnection per
// teammate (mesh = N-1 connections in N-player team). Voice flows
// peer-to-peer; the server is just the signaling channel for
// offer/answer/ICE candidate exchange.
//
// 3D positional spatialization: incoming MediaStreamTrack →
// MediaStreamAudioSourceNode → PannerNode (HRTF) → audio output.
// Listener pos+orientation comes from local-player WASM state each frame.
//
// Push-to-talk: hold V → mic enabled. Release → mic muted.
// Settings: ST.voiceMode = 'pushToTalk' | 'open'.
//
// Speaking indicator: getStats() polled at 4Hz, audioLevel > 0.05 → flag
// the peer's nameplate as speaking (renderer.js reads window.__voice.speaking[id]).
// ============================================================

const ICE_SERVERS = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
];

const peers = new Map();   // numericId → { pc: RTCPeerConnection, stream, panner, audioEl, lastLevel }
let localStream = null;
let localTrack = null;
let myNumericId = -1;
let pttPressed = false;
let netSendFn = null;
let listenerCtx = null;
let speakingState = {};     // { numericId: true|false } — read by renderer

window.__voice = { speaking: speakingState };

export async function init(networkSendFn) {
    netSendFn = networkSendFn;
    // Lazy mic capture — wait for first push-to-talk to ask for permission
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('keyup', onKeyUp);
    // Speaking indicator poll loop
    setInterval(pollAudioLevels, 250);
}

export function setLocalNumericId(id) {
    myNumericId = id;
}

async function ensureMicCapture() {
    if (localStream) return localStream;
    try {
        localStream = await navigator.mediaDevices.getUserMedia({
            audio: {
                echoCancellation: true,
                noiseSuppression: true,
                autoGainControl: true,
            },
        });
        localTrack = localStream.getAudioTracks()[0];
        // Start muted — push-to-talk enables it
        if (localTrack) localTrack.enabled = false;
        // Add to existing peer connections
        for (const peer of peers.values()) {
            if (peer.pc.signalingState !== 'closed') {
                peer.pc.addTrack(localTrack, localStream);
            }
        }
        console.log('[VOICE] mic captured');
    } catch (err) {
        console.error('[VOICE] getUserMedia failed:', err);
    }
    return localStream;
}

/** Called when match starts — server sends roster, we open peer connections to each teammate. */
export async function openPeers(teammateIds) {
    for (const otherId of teammateIds) {
        if (otherId === myNumericId) continue;
        if (peers.has(otherId)) continue;
        await createPeer(otherId, true);   // initiator
    }
}

async function createPeer(otherId, initiator) {
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    const peer = { pc, stream: null, panner: null, audioEl: null, lastLevel: 0 };
    peers.set(otherId, peer);

    pc.onicecandidate = (e) => {
        if (e.candidate && netSendFn) {
            netSendFn({ type: 'voiceCandidate', to: otherId, candidate: e.candidate.toJSON() });
        }
    };

    pc.ontrack = (e) => {
        peer.stream = e.streams[0];
        attachPositional(otherId, peer);
    };

    pc.onconnectionstatechange = () => {
        if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
            peers.delete(otherId);
            speakingState[otherId] = false;
        }
    };

    if (localTrack) pc.addTrack(localTrack, localStream);

    if (initiator) {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        if (netSendFn) netSendFn({ type: 'voiceOffer', to: otherId, sdp: pc.localDescription });
    }
}

export async function handleVoiceMessage(msg) {
    if (msg.from == null) return;
    const fromId = msg.from;
    if (msg.type === 'voiceOffer') {
        if (!peers.has(fromId)) await createPeer(fromId, false);
        const peer = peers.get(fromId);
        await peer.pc.setRemoteDescription(msg.sdp);
        await ensureMicCapture();
        const ans = await peer.pc.createAnswer();
        await peer.pc.setLocalDescription(ans);
        if (netSendFn) netSendFn({ type: 'voiceAnswer', to: fromId, sdp: peer.pc.localDescription });
    } else if (msg.type === 'voiceAnswer') {
        const peer = peers.get(fromId);
        if (peer) await peer.pc.setRemoteDescription(msg.sdp);
    } else if (msg.type === 'voiceCandidate') {
        const peer = peers.get(fromId);
        if (peer) {
            try { await peer.pc.addIceCandidate(msg.candidate); }
            catch (e) { console.warn('[VOICE] addIceCandidate failed', e); }
        }
    }
}

function attachPositional(otherId, peer) {
    // HRTF positional via shared AE context if available
    if (!listenerCtx && window.AE && window.AE.ctx) listenerCtx = window.AE.ctx;
    if (!listenerCtx) {
        // Fall back to simple <audio> playback
        peer.audioEl = document.createElement('audio');
        peer.audioEl.autoplay = true;
        peer.audioEl.srcObject = peer.stream;
        document.body.appendChild(peer.audioEl);
        return;
    }
    try {
        const src = listenerCtx.createMediaStreamSource(peer.stream);
        // R27: gain node between src and panner so we can mute per-peer.
        const gain = listenerCtx.createGain();
        gain.gain.value = _isPeerMuted(otherId) ? 0 : 1;
        const panner = listenerCtx.createPanner();
        panner.panningModel = 'HRTF';
        panner.distanceModel = 'inverse';
        panner.refDistance = 6;
        panner.maxDistance = 80;
        panner.rolloffFactor = 1.5;
        src.connect(gain);
        gain.connect(panner);
        panner.connect(listenerCtx.destination);
        peer.panner = panner;
        peer.gain = gain;
    } catch (e) {
        console.error('[VOICE] positional setup failed:', e);
    }
}

// ============================================================
// R27 — voice mute (per-peer + MUTE ALL)
// ============================================================
let _mutedUUIDs = new Set();
let _muteAll = false;
const _uuidByNumericId = new Map();   // populated from matchStart roster

try {
    const raw = localStorage.getItem('tribes:mutedUUIDs') || '[]';
    _mutedUUIDs = new Set(JSON.parse(raw));
} catch (e) {}
try {
    _muteAll = localStorage.getItem('tribes:muteAll') === '1';
} catch (e) {}

function _persistMuted() {
    try { localStorage.setItem('tribes:mutedUUIDs', JSON.stringify([..._mutedUUIDs])); } catch (e) {}
}
function _isPeerMuted(numericId) {
    if (_muteAll) return true;
    const uuid = _uuidByNumericId.get(numericId);
    return uuid ? _mutedUUIDs.has(uuid) : false;
}
function _applyAllGains() {
    for (const [id, peer] of peers) {
        if (peer.gain) peer.gain.gain.value = _isPeerMuted(id) ? 0 : 1;
    }
}

export function registerPeerUuid(numericId, uuid) {
    if (uuid) _uuidByNumericId.set(numericId, uuid);
    _applyAllGains();
}
export function setPeerMuted(numericId, muted) {
    const uuid = _uuidByNumericId.get(numericId);
    if (!uuid) return false;
    if (muted) _mutedUUIDs.add(uuid); else _mutedUUIDs.delete(uuid);
    _persistMuted();
    _applyAllGains();
    return true;
}
export function isPeerMuted(numericId) { return _isPeerMuted(numericId); }
export function setMuteAll(on) {
    _muteAll = !!on;
    try { localStorage.setItem('tribes:muteAll', _muteAll ? '1' : '0'); } catch (e) {}
    _applyAllGains();
}
export function getMuteAll() { return _muteAll; }
export function muteUuidDirectly(uuid) {
    if (!uuid) return;
    _mutedUUIDs.add(uuid);
    _persistMuted();
    _applyAllGains();
}

/** Called per-frame from renderer with peer world positions (from snapshot). */
export function updatePeerPosition(otherId, x, y, z) {
    const peer = peers.get(otherId);
    if (!peer || !peer.panner) return;
    try {
        if (peer.panner.positionX) {
            peer.panner.positionX.value = x;
            peer.panner.positionY.value = y;
            peer.panner.positionZ.value = z;
        } else {
            peer.panner.setPosition(x, y, z);
        }
    } catch (e) {}
}

function onKeyDown(e) {
    // Tab/scoreboard already binds to keyCode 9; voice push-to-talk is V (86)
    // BUT V is also taken by Three.js debug toggle in C++... we use keyCode 84 (T) instead
    if (e.code === 'KeyT' && !pttPressed) {
        pttPressed = true;
        ensureMicCapture().then(() => { if (localTrack) localTrack.enabled = true; });
    }
}
function onKeyUp(e) {
    if (e.code === 'KeyT' && pttPressed) {
        pttPressed = false;
        if (localTrack && (window.ST?.voiceMode || 'pushToTalk') === 'pushToTalk') {
            localTrack.enabled = false;
        }
    }
}

async function pollAudioLevels() {
    for (const [otherId, peer] of peers) {
        if (!peer.pc || peer.pc.connectionState !== 'connected') continue;
        try {
            const stats = await peer.pc.getStats();
            let level = 0;
            stats.forEach(rep => {
                if (rep.type === 'inbound-rtp' && rep.kind === 'audio') {
                    if (typeof rep.audioLevel === 'number') level = Math.max(level, rep.audioLevel);
                }
            });
            peer.lastLevel = level;
            speakingState[otherId] = level > 0.02;
        } catch (e) { /* getStats can fail on some browsers */ }
    }
}

export function shutdown() {
    for (const peer of peers.values()) {
        try { peer.pc.close(); } catch {}
        if (peer.audioEl) try { peer.audioEl.remove(); } catch {}
    }
    peers.clear();
    speakingState = {};
    window.__voice.speaking = speakingState;
    if (localStream) {
        localStream.getTracks().forEach(t => t.stop());
        localStream = null;
        localTrack = null;
    }
}

export function getStatus() {
    return {
        myId: myNumericId,
        peers: peers.size,
        micActive: !!(localTrack && localTrack.enabled),
        pttPressed,
    };
}
