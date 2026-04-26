// ============================================================
// Tribes Browser Edition — Replay Player (R25)
// ============================================================
//
// Plays back `.tribes-replay` files captured server-side. Each file is a
// concatenation of per-tick snapshot bytes plus a JSON metadata header
// (player roster, map id, kill/capture markers). See server/lobby.ts
// `endMatch` for the layout.
//
// View: top-down tactical map. The 3D renderer is intentionally NOT
// driven during replay — Emscripten owns the main loop and skipping
// physics ticks cleanly would require larger surgery. A 2D top-down view
// is the common tactical-review UX (like CS2 demos viewer) and tells the
// match's story clearly with a fraction of the integration risk.
//
// API (window-exposed):
//   replay.openFromFile(File)         — load a `.tribes-replay` from <input type=file>
//   replay.openFromUrl(url)           — fetch + load (used by main menu paste field)
//   replay.openFromArrayBuffer(buf)   — generic loader
//   replay.close()                    — return to main menu
//   replay.play() / pause() / setSpeed(n) / seek(tick) / step(±1)
// ============================================================

import { decodeSnapshot } from './wire.js';

let _state = null;       // { meta, snaps[], cursor, playing, speed, view }

function log(msg) { console.log('[REPLAY] ' + msg); }

// ------------------------------------------------------------
// File parsing — see server/lobby.ts endMatch for byte layout.
// 'TRBR' magic + u32 version + u16 idLen + id bytes + u32 metaLen + meta JSON
// + repeating: u32 snapLen + snap bytes
// ------------------------------------------------------------
function parseReplay(arrayBuffer) {
    const u8 = new Uint8Array(arrayBuffer);
    const dv = new DataView(arrayBuffer);
    if (u8[0] !== 0x54 || u8[1] !== 0x52 || u8[2] !== 0x42 || u8[3] !== 0x52) {
        throw new Error('not a .tribes-replay file (missing TRBR magic)');
    }
    let off = 4;
    const version = dv.getUint32(off, true); off += 4;
    if (version !== 1) throw new Error('unsupported replay version: ' + version);
    const idLen = dv.getUint16(off, true); off += 2;
    const id = new TextDecoder().decode(u8.subarray(off, off + idLen)); off += idLen;
    const metaLen = dv.getUint32(off, true); off += 4;
    const meta = JSON.parse(new TextDecoder().decode(u8.subarray(off, off + metaLen))); off += metaLen;
    const snaps = [];
    while (off < u8.length) {
        const snapLen = dv.getUint32(off, true); off += 4;
        const slice = u8.subarray(off, off + snapLen);
        // decodeSnapshot accepts an ArrayBuffer/Uint8Array
        const decoded = decodeSnapshot(slice);
        if (decoded) snaps.push(decoded);
        off += snapLen;
    }
    return { id, meta, snaps };
}

// ------------------------------------------------------------
// View bounds — fit all player positions to canvas with padding.
// ------------------------------------------------------------
function computeBounds(snaps) {
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const s of snaps) {
        for (const p of s.players) {
            if (!p.alive && !p.visible) continue;
            if (p.pos[0] < minX) minX = p.pos[0];
            if (p.pos[0] > maxX) maxX = p.pos[0];
            if (p.pos[2] < minZ) minZ = p.pos[2];
            if (p.pos[2] > maxZ) maxZ = p.pos[2];
        }
    }
    if (!isFinite(minX)) { minX = -200; maxX = 200; minZ = -200; maxZ = 200; }
    const padX = (maxX - minX) * 0.1 + 30;
    const padZ = (maxZ - minZ) * 0.1 + 30;
    return { minX: minX - padX, maxX: maxX + padX, minZ: minZ - padZ, maxZ: maxZ + padZ };
}

// ------------------------------------------------------------
// Render the current snapshot to the replay canvas.
// ------------------------------------------------------------
function render() {
    if (!_state) return;
    const canvas = document.getElementById('replay-canvas');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const w = canvas.width, h = canvas.height;
    const { meta, snaps, cursor, view } = _state;
    const snap = snaps[Math.max(0, Math.min(snaps.length - 1, cursor))];

    ctx.fillStyle = '#0a0e0c';
    ctx.fillRect(0, 0, w, h);

    // Compute world→canvas transform
    const b = view.bounds;
    const wx = b.maxX - b.minX, wz = b.maxZ - b.minZ;
    const sx = (w - 40) / wx, sz = (h - 40) / wz;
    const scale = Math.min(sx, sz) * view.zoom;
    const cx = w / 2 + view.panX, cy = h / 2 + view.panY;
    const project = (x, z) => [cx + (x - (b.minX + wx / 2)) * scale, cy + (z - (b.minZ + wz / 2)) * scale];

    // Bounds frame
    ctx.strokeStyle = '#3A3020';
    ctx.lineWidth = 1;
    ctx.strokeRect(20, 20, w - 40, h - 40);

    // Flag positions (from first snapshot)
    if (snap.flags) {
        for (const f of snap.flags) {
            const [px, py] = project(f.pos[0], f.pos[1]);
            ctx.fillStyle = f.team === 0 ? '#C8302C' : '#2C5AC8';
            ctx.beginPath(); ctx.arc(px, py, 6, 0, Math.PI * 2); ctx.fill();
            ctx.strokeStyle = '#fff'; ctx.lineWidth = 1; ctx.stroke();
        }
    }

    // Player dots + heading line
    if (snap.players) {
        for (const p of snap.players) {
            if (!p.alive) continue;
            const [px, py] = project(p.pos[0], p.pos[2]);
            ctx.fillStyle = p.team === 0 ? '#FF6464' : '#6498FF';
            ctx.beginPath(); ctx.arc(px, py, 4, 0, Math.PI * 2); ctx.fill();
            // Heading
            const yaw = p.rot[1];
            ctx.strokeStyle = ctx.fillStyle;
            ctx.beginPath();
            ctx.moveTo(px, py);
            ctx.lineTo(px + Math.sin(yaw) * 8, py - Math.cos(yaw) * 8);
            ctx.stroke();
            // Name plate
            const meta_p = meta.players.find(mp => mp.id === p.id);
            if (meta_p && view.showLabels) {
                ctx.fillStyle = '#E0D0A0';
                ctx.font = '10px monospace';
                ctx.fillText(meta_p.name, px + 6, py + 3);
            }
            // Carrier indicator
            if (p.carryingFlag >= 0) {
                ctx.strokeStyle = p.carryingFlag === 0 ? '#C8302C' : '#2C5AC8';
                ctx.lineWidth = 2;
                ctx.beginPath(); ctx.arc(px, py, 8, 0, Math.PI * 2); ctx.stroke();
            }
        }
    }

    // Highlight followed player
    if (view.followId !== null && snap.players) {
        const fp = snap.players.find(p => p.id === view.followId);
        if (fp) {
            const [px, py] = project(fp.pos[0], fp.pos[2]);
            ctx.strokeStyle = '#FFE69A';
            ctx.lineWidth = 2;
            ctx.beginPath(); ctx.arc(px, py, 12, 0, Math.PI * 2); ctx.stroke();
        }
    }
}

// ------------------------------------------------------------
// Timeline + HUD
// ------------------------------------------------------------
function renderHud() {
    if (!_state) return;
    const { meta, snaps, cursor, playing, speed } = _state;
    const total = snaps.length - 1;
    const slider = document.getElementById('replay-slider');
    if (slider) slider.max = String(total), slider.value = String(cursor);
    const t = document.getElementById('replay-tick');
    if (t) {
        const tick = snaps[cursor]?.matchTick ?? cursor;
        const elapsed = (tick / Math.max(1, meta.snapshotHz || 10));
        t.textContent = `tick ${tick} (${elapsed.toFixed(1)}s) · ${cursor + 1}/${snaps.length}`;
    }
    const playBtn = document.getElementById('replay-play');
    if (playBtn) playBtn.textContent = playing ? '❚❚ Pause' : '▶ Play';
    const sp = document.getElementById('replay-speed-label');
    if (sp) sp.textContent = speed.toFixed(2) + '×';
    // Score
    const sc = document.getElementById('replay-score');
    if (sc) {
        const snap = snaps[cursor];
        sc.textContent = `${snap.teamScore[0]} : ${snap.teamScore[1]}`;
    }
    renderTimelineMarkers();
}

function renderTimelineMarkers() {
    const tl = document.getElementById('replay-timeline-markers');
    if (!tl || !_state) return;
    const total = _state.snaps.length;
    const marks = (_state.meta.killEvents || []).map(k => {
        const tickIdx = Math.round(k.tick / Math.max(1, _state.meta.snapshotHz || 10) * (_state.meta.snapshotHz || 10));
        const idx = Math.min(total - 1, Math.max(0, Math.round(k.tick / 3)));   // sim tick → snapshot index, ~30Hz/10Hz
        const pct = (idx / Math.max(1, total - 1)) * 100;
        const color = k.killerTeam === 0 ? '#C8302C' : '#2C5AC8';
        return `<div class="rep-mark" style="left:${pct.toFixed(2)}%;background:${color};" title="kill: ${k.killer}→${k.victim} (wpn ${k.weapon}) @ tick ${k.tick}" onclick="window.__replay && window.__replay.seek(${idx})"></div>`;
    });
    tl.innerHTML = marks.join('');
}

// ------------------------------------------------------------
// Playback loop
// ------------------------------------------------------------
let _rafId = 0;
let _lastTs = 0;
let _accum = 0;

function loop(ts) {
    if (!_state) return;
    if (_state.playing) {
        if (_lastTs === 0) _lastTs = ts;
        const dt = (ts - _lastTs) / 1000;
        _lastTs = ts;
        const dtScaled = dt * _state.speed;
        const tickRate = (_state.meta.snapshotHz || 10);
        _accum += dtScaled;
        while (_accum >= 1 / tickRate && _state.cursor < _state.snaps.length - 1) {
            _state.cursor++;
            _accum -= 1 / tickRate;
        }
        if (_state.cursor >= _state.snaps.length - 1) {
            _state.playing = false;
            _accum = 0;
        }
    } else {
        _lastTs = ts;
    }
    render();
    renderHud();
    _rafId = requestAnimationFrame(loop);
}

// ------------------------------------------------------------
// Public API
// ------------------------------------------------------------
function show() {
    let modal = document.getElementById('replay-overlay');
    if (!modal) modal = buildOverlay();
    modal.style.display = 'flex';
    if (_rafId) cancelAnimationFrame(_rafId);
    _rafId = requestAnimationFrame(loop);
}

export function close() {
    const modal = document.getElementById('replay-overlay');
    if (modal) modal.style.display = 'none';
    if (_rafId) cancelAnimationFrame(_rafId);
    _rafId = 0;
    _state = null;
}

export function openFromArrayBuffer(buf) {
    let parsed;
    try { parsed = parseReplay(buf); }
    catch (e) { alert('Failed to load replay: ' + e.message); return; }
    log('loaded replay ' + parsed.id + ' — ' + parsed.snaps.length + ' snapshots, ' + parsed.meta.players.length + ' players, map=' + parsed.meta.mapId);
    _state = {
        meta: parsed.meta,
        snaps: parsed.snaps,
        cursor: 0,
        playing: true,
        speed: 1.0,
        view: { bounds: computeBounds(parsed.snaps), zoom: 1.0, panX: 0, panY: 0, followId: null, showLabels: true },
    };
    show();
}

export async function openFromFile(file) {
    const buf = await file.arrayBuffer();
    openFromArrayBuffer(buf);
}

export async function openFromUrl(url) {
    try {
        const r = await fetch(url);
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const buf = await r.arrayBuffer();
        openFromArrayBuffer(buf);
    } catch (e) {
        alert('Replay fetch failed: ' + e.message);
    }
}

export function play()  { if (_state) _state.playing = true; _lastTs = 0; }
export function pause() { if (_state) _state.playing = false; }
export function setSpeed(s) { if (_state) _state.speed = Math.max(0.25, Math.min(4, s)); }
export function seek(tick) { if (_state) _state.cursor = Math.max(0, Math.min(_state.snaps.length - 1, tick | 0)); }
export function step(delta) { if (_state) seek(_state.cursor + (delta | 0)); }
export function follow(id) { if (_state) _state.view.followId = id; }
export function pan(dx, dy) { if (_state) { _state.view.panX += dx; _state.view.panY += dy; } }
export function zoom(factor) { if (_state) _state.view.zoom = Math.max(0.5, Math.min(4, _state.view.zoom * factor)); }

// ------------------------------------------------------------
// Overlay UI (created lazily)
// ------------------------------------------------------------
function buildOverlay() {
    const div = document.createElement('div');
    div.id = 'replay-overlay';
    div.style.cssText = 'position:fixed;inset:0;z-index:9999;display:none;flex-direction:column;background:#0a0e0c;color:#E0D0A0;font-family:monospace;';
    div.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;padding:8px 16px;border-bottom:1px solid #3A3020;background:#15110a;">
        <div>REPLAY · <span id="replay-mapname">—</span> · score <span id="replay-score">0:0</span></div>
        <button onclick="window.__replay && window.__replay.close()" style="background:#3a2410;color:#E0D0A0;border:1px solid #6A4A20;padding:4px 12px;cursor:pointer;">Close (Esc)</button>
      </div>
      <div style="flex:1;display:flex;justify-content:center;align-items:center;background:#0a0e0c;">
        <canvas id="replay-canvas" width="1024" height="640" style="border:1px solid #3A3020;background:#000;"></canvas>
      </div>
      <div style="padding:10px 16px;border-top:1px solid #3A3020;background:#15110a;">
        <div style="position:relative;height:18px;margin-bottom:8px;">
          <input id="replay-slider" type="range" min="0" max="0" value="0" style="width:100%;" />
          <div id="replay-timeline-markers" style="position:absolute;inset:0;pointer-events:none;"></div>
        </div>
        <div style="display:flex;align-items:center;gap:12px;">
          <button id="replay-play" style="background:#3a2410;color:#E0D0A0;border:1px solid #6A4A20;padding:4px 12px;cursor:pointer;">▶ Play</button>
          <button onclick="window.__replay && window.__replay.step(-1)" style="background:#3a2410;color:#E0D0A0;border:1px solid #6A4A20;padding:4px 8px;cursor:pointer;">◀ Step</button>
          <button onclick="window.__replay && window.__replay.step(1)" style="background:#3a2410;color:#E0D0A0;border:1px solid #6A4A20;padding:4px 8px;cursor:pointer;">Step ▶</button>
          <span style="margin-left:12px;">Speed:</span>
          <button onclick="window.__replay && window.__replay.setSpeed(0.25)" style="background:#3a2410;color:#E0D0A0;border:1px solid #6A4A20;padding:4px 8px;cursor:pointer;">0.25×</button>
          <button onclick="window.__replay && window.__replay.setSpeed(0.5)" style="background:#3a2410;color:#E0D0A0;border:1px solid #6A4A20;padding:4px 8px;cursor:pointer;">0.5×</button>
          <button onclick="window.__replay && window.__replay.setSpeed(1)" style="background:#3a2410;color:#E0D0A0;border:1px solid #6A4A20;padding:4px 8px;cursor:pointer;">1×</button>
          <button onclick="window.__replay && window.__replay.setSpeed(2)" style="background:#3a2410;color:#E0D0A0;border:1px solid #6A4A20;padding:4px 8px;cursor:pointer;">2×</button>
          <button onclick="window.__replay && window.__replay.setSpeed(4)" style="background:#3a2410;color:#E0D0A0;border:1px solid #6A4A20;padding:4px 8px;cursor:pointer;">4×</button>
          <span id="replay-speed-label" style="margin-left:6px;color:#FFE69A;">1.00×</span>
          <span style="margin-left:auto;color:#9A8A6A;" id="replay-tick">tick 0 (0.0s)</span>
        </div>
      </div>
    `;
    document.body.appendChild(div);

    // Wire slider
    const slider = div.querySelector('#replay-slider');
    slider.addEventListener('input', e => seek(Number(e.target.value)));
    div.querySelector('#replay-play').addEventListener('click', () => {
        if (_state && _state.playing) pause(); else play();
    });
    document.addEventListener('keydown', e => {
        if (div.style.display === 'none') return;
        if (e.key === 'Escape') close();
        else if (e.key === ' ') { if (_state && _state.playing) pause(); else play(); e.preventDefault(); }
        else if (e.key === 'ArrowLeft') step(-1);
        else if (e.key === 'ArrowRight') step(1);
    });
    // Update map name once state is available
    setTimeout(() => {
        const mn = div.querySelector('#replay-mapname');
        if (mn && _state) mn.textContent = (_state.meta.mapName || _state.meta.mapId || 'unknown');
    }, 50);
    return div;
}

// Window-exposed handle
window.__replay = { openFromFile, openFromUrl, openFromArrayBuffer, close, play, pause, setSpeed, seek, step, follow };
