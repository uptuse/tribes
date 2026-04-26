// ============================================================
// Tribes Browser Edition — Map Editor (R25, basic)
// ============================================================
//
// Top-down 256x256 heightmap editor. Three tools:
//   - brush:     click-drag to raise/lower terrain. Hold Shift to lower.
//                Falloff is a smooth radial cosine, radius adjustable.
//   - structure: click to drop a building/tower/turret at the cursor.
//                Mouse wheel rotates the next placement (degrees).
//   - point:     click to drop the red flag, blue flag, team-0 spawn,
//                or team-1 spawn.
//
// Save: serialises to a `.tribes-map` JSON via float-array terrain
// encoding (preserves edit precision). The companion CLI `tools/genmap.ts`
// can re-encode to int16-base64 for publishing.
//
// Load: accepts a .tribes-map file from the file picker.
// Test: navigates to the multiplayer URL with ?map=<id>; the player can
//       only test maps that have been previously published (registered in
//       MAP_REGISTRY on the server). For unpublished edits the user must
//       Save then publish via tools/genmap.ts.
// ============================================================

const SIZE = 256;
const WORLD_SCALE = 8;

// Editor state (in-memory; serialised on Save)
let _state = null;

function newState() {
    return {
        id: 'untitled',
        name: 'Untitled',
        author: 'You',
        maxPlayers: 16,
        recommendedMix: { L: 4, M: 4, H: 0 },
        heightmap: new Float32Array(SIZE * SIZE),    // float; saved as float-array encoding
        structures: [],
        flags: [
            { team: 0, pos: [-100, 30, -50] },
            { team: 1, pos: [ 100, 30,  50] },
        ],
        spawns: [
            { team: 0, pos: [-95, 30, -45] },
            { team: 1, pos: [ 95, 30,  45] },
        ],
        atmosphere: {
            skyTopColor: '#9bb5d6', skyHorizColor: '#cfe0ee',
            sunAngleDeg: 55, sunAzimuthDeg: 200,
            fogColor: '#a8b8c8', fogDensity: 0.0008, ambient: 0.45,
        },
        // UI-only
        tool: 'brush',
        brushRadius: 12,
        brushStrength: 1.5,
        nextStructureType: 0,
        nextStructureRot: 0,
        nextPointType: 'flag0',  // flag0 | flag1 | spawn0 | spawn1
    };
}

function log(msg) { console.log('[EDITOR] ' + msg); }

// ------------------------------------------------------------
// Heightmap drawing (renders to a 256x256 canvas as greyscale)
// ------------------------------------------------------------
function renderCanvas() {
    const c = document.getElementById('editor-canvas');
    if (!c || !_state) return;
    const ctx = c.getContext('2d');
    const img = ctx.createImageData(SIZE, SIZE);
    let minH = Infinity, maxH = -Infinity;
    for (let i = 0; i < _state.heightmap.length; i++) {
        const h = _state.heightmap[i];
        if (h < minH) minH = h; if (h > maxH) maxH = h;
    }
    const range = Math.max(1, maxH - minH);
    for (let i = 0; i < _state.heightmap.length; i++) {
        const v = (_state.heightmap[i] - minH) / range;
        const g = Math.round(40 + 200 * v);
        const o = i * 4;
        img.data[o] = g; img.data[o + 1] = g; img.data[o + 2] = g + 8; img.data[o + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);

    // Overlay structures
    for (const s of _state.structures) {
        const [cx, cy] = worldToCanvas(s.pos[0], s.pos[2]);
        const colors = ['#a08070', '#8090a0', '#40FF80', '#FF6464', '#FFE69A', '#666'];
        ctx.fillStyle = colors[s.type] || '#fff';
        ctx.fillRect(cx - 3, cy - 3, 6, 6);
    }
    // Overlay flags + spawns
    for (const f of _state.flags) {
        const [cx, cy] = worldToCanvas(f.pos[0], f.pos[2]);
        ctx.fillStyle = f.team === 0 ? '#C8302C' : '#2C5AC8';
        ctx.beginPath(); ctx.arc(cx, cy, 5, 0, Math.PI * 2); ctx.fill();
        ctx.strokeStyle = '#fff'; ctx.stroke();
    }
    for (const s of _state.spawns) {
        const [cx, cy] = worldToCanvas(s.pos[0], s.pos[2]);
        ctx.strokeStyle = s.team === 0 ? '#C8302C' : '#2C5AC8';
        ctx.lineWidth = 1; ctx.strokeRect(cx - 4, cy - 4, 8, 8);
    }
}

function worldToCanvas(x, z) {
    // World extents: ±SIZE*WORLD_SCALE/2
    const half = SIZE * WORLD_SCALE / 2;
    return [
        Math.round((x + half) / (SIZE * WORLD_SCALE) * SIZE),
        Math.round((z + half) / (SIZE * WORLD_SCALE) * SIZE),
    ];
}
function canvasToWorld(cx, cy) {
    const half = SIZE * WORLD_SCALE / 2;
    return [
        cx / SIZE * (SIZE * WORLD_SCALE) - half,
        cy / SIZE * (SIZE * WORLD_SCALE) - half,
    ];
}

// ------------------------------------------------------------
// Brush — radial cosine falloff
// ------------------------------------------------------------
function applyBrush(cx, cy, lower) {
    const r = _state.brushRadius;
    const sign = lower ? -1 : 1;
    const strength = _state.brushStrength * sign;
    for (let y = Math.max(0, cy - r); y < Math.min(SIZE, cy + r); y++) {
        for (let x = Math.max(0, cx - r); x < Math.min(SIZE, cx + r); x++) {
            const dx = x - cx, dy = y - cy;
            const d = Math.sqrt(dx * dx + dy * dy);
            if (d > r) continue;
            const t = 1 - d / r;
            const k = 0.5 - 0.5 * Math.cos(t * Math.PI);
            _state.heightmap[y * SIZE + x] += strength * k;
        }
    }
}

// ------------------------------------------------------------
// Click handler
// ------------------------------------------------------------
function onCanvasClick(e, dragging) {
    const c = e.target;
    const rect = c.getBoundingClientRect();
    const cx = Math.round((e.clientX - rect.left) / rect.width * SIZE);
    const cy = Math.round((e.clientY - rect.top) / rect.height * SIZE);
    const [wx, wz] = canvasToWorld(cx, cy);

    if (_state.tool === 'brush') {
        applyBrush(cx, cy, e.shiftKey);
    } else if (_state.tool === 'structure' && !dragging) {
        const wy = sampleHeightAtCanvas(cx, cy) + 5;
        _state.structures.push({
            type: _state.nextStructureType,
            pos: [wx, wy, wz],
            halfSize: defaultHalfSize(_state.nextStructureType),
            color: defaultColor(_state.nextStructureType),
            rot: _state.nextStructureRot,
        });
    } else if (_state.tool === 'point' && !dragging) {
        const wy = sampleHeightAtCanvas(cx, cy) + 5;
        const t = _state.nextPointType;
        if (t === 'flag0' || t === 'flag1') {
            const team = t === 'flag0' ? 0 : 1;
            const ent = _state.flags.find(f => f.team === team);
            if (ent) ent.pos = [wx, wy, wz];
            else     _state.flags.push({ team, pos: [wx, wy, wz] });
        } else if (t === 'spawn0' || t === 'spawn1') {
            const team = t === 'spawn0' ? 0 : 1;
            const ent = _state.spawns.find(s => s.team === team);
            if (ent) ent.pos = [wx, wy, wz];
            else     _state.spawns.push({ team, pos: [wx, wy, wz] });
        }
    }
    renderCanvas();
}

function sampleHeightAtCanvas(cx, cy) {
    return _state.heightmap[cy * SIZE + cx] || 0;
}

function defaultHalfSize(type) {
    if (type === 0) return [10, 6, 8];   // interior
    if (type === 1) return [4, 18, 4];   // tower
    if (type === 2) return [3, 4, 3];    // generator
    if (type === 3) return [2, 2, 2];    // turret
    if (type === 4) return [3, 3, 3];    // station
    return [3, 3, 3];
}
function defaultColor(type) {
    if (type === 2) return [0.30, 0.30, 0.30];
    if (type === 3) return [0.35, 0.35, 0.35];
    return [0.40, 0.38, 0.34];
}

// ------------------------------------------------------------
// Save / Load
// ------------------------------------------------------------
function buildMapDoc() {
    return {
        schemaVersion: 1,
        id: _state.id,
        name: _state.name,
        author: _state.author,
        maxPlayers: _state.maxPlayers,
        recommendedMix: _state.recommendedMix,
        terrain: {
            size: SIZE,
            worldScale: WORLD_SCALE,
            encoding: 'float-array',
            quantStep: 0.1,
            data: Array.from(_state.heightmap),
        },
        structures: _state.structures,
        gameplay: {
            flags:    _state.flags,
            spawns:   _state.spawns,
            stations: [],
        },
        atmosphere: _state.atmosphere,
    };
}

export function save() {
    const doc = buildMapDoc();
    const blob = new Blob([JSON.stringify(doc)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = (_state.id || 'untitled') + '.tribes-map';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
    log('saved as ' + a.download);
}

export async function loadFromFile(file) {
    if (!file) return;
    const txt = await file.text();
    let doc;
    try { doc = JSON.parse(txt); } catch (e) { alert('Bad JSON: ' + e.message); return; }
    if (doc.schemaVersion !== 1) { alert('Unsupported schemaVersion: ' + doc.schemaVersion); return; }
    _state = newState();
    _state.id = doc.id || 'untitled';
    _state.name = doc.name || 'Untitled';
    _state.author = doc.author || 'You';
    _state.maxPlayers = doc.maxPlayers || 16;
    _state.recommendedMix = doc.recommendedMix || _state.recommendedMix;
    _state.atmosphere = doc.atmosphere || _state.atmosphere;
    _state.structures = Array.isArray(doc.structures) ? doc.structures : [];
    _state.flags = doc.gameplay?.flags || _state.flags;
    _state.spawns = doc.gameplay?.spawns || _state.spawns;
    // Decode heightmap
    if (doc.terrain) {
        if (doc.terrain.encoding === 'float-array' && Array.isArray(doc.terrain.data)) {
            _state.heightmap = new Float32Array(doc.terrain.data);
        } else if (doc.terrain.encoding === 'int16-base64' && typeof doc.terrain.data === 'string') {
            const bin = atob(doc.terrain.data);
            const step = doc.terrain.quantStep || 0.1;
            _state.heightmap = new Float32Array(SIZE * SIZE);
            for (let i = 0; i < _state.heightmap.length; i++) {
                let q = bin.charCodeAt(i * 2) | (bin.charCodeAt(i * 2 + 1) << 8);
                if (q & 0x8000) q -= 0x10000;
                _state.heightmap[i] = q * step;
            }
        }
    }
    log('loaded ' + _state.id + ' (' + _state.structures.length + ' structures)');
    renderCanvas();
}

// ------------------------------------------------------------
// UI
// ------------------------------------------------------------
function buildOverlay() {
    const div = document.createElement('div');
    div.id = 'editor-overlay';
    div.style.cssText = 'position:fixed;inset:0;z-index:9998;display:none;flex-direction:column;background:#0a0e0c;color:#E0D0A0;font-family:monospace;';
    div.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;padding:8px 16px;border-bottom:1px solid #3A3020;background:#15110a;">
        <div>MAP EDITOR · <input id="ed-id" value="untitled" style="background:#1a1612;color:#E0D0A0;border:1px solid #3A3020;padding:2px 6px;width:120px;" /> · <input id="ed-name" value="Untitled" style="background:#1a1612;color:#E0D0A0;border:1px solid #3A3020;padding:2px 6px;width:160px;" /></div>
        <div>
          <button onclick="document.getElementById('ed-load-input').click()" style="background:#3a2410;color:#E0D0A0;border:1px solid #6A4A20;padding:4px 12px;cursor:pointer;">Load</button>
          <input id="ed-load-input" type="file" accept=".tribes-map" style="display:none;" onchange="window.__editor && window.__editor.loadFromFile(this.files[0])" />
          <button onclick="window.__editor && window.__editor.save()" style="background:#3a2410;color:#E0D0A0;border:1px solid #6A4A20;padding:4px 12px;cursor:pointer;">Save</button>
          <button onclick="window.__editor && window.__editor.test()" style="background:#3a2410;color:#FFE69A;border:1px solid #D4A030;padding:4px 12px;cursor:pointer;">Test</button>
          <button onclick="window.__editor && window.__editor.close()" style="background:#3a2410;color:#E0D0A0;border:1px solid #6A4A20;padding:4px 12px;cursor:pointer;">Close (Esc)</button>
        </div>
      </div>
      <div style="flex:1;display:flex;">
        <div style="width:200px;padding:12px;border-right:1px solid #3A3020;background:#15110a;">
          <div style="margin-bottom:12px;">
            <div style="color:#9A8A6A;font-size:0.78em;margin-bottom:4px;">TOOL</div>
            <div><label><input type="radio" name="ed-tool" value="brush" checked /> Brush (Shift = lower)</label></div>
            <div><label><input type="radio" name="ed-tool" value="structure" /> Structure</label></div>
            <div><label><input type="radio" name="ed-tool" value="point" /> Gameplay point</label></div>
          </div>
          <div id="ed-brush-opts" style="margin-bottom:12px;">
            <div style="color:#9A8A6A;font-size:0.78em;">BRUSH</div>
            Radius: <input type="range" min="2" max="40" value="12" id="ed-radius" style="width:100%;" />
            Strength: <input type="range" min="0.1" max="5" step="0.1" value="1.5" id="ed-strength" style="width:100%;" />
          </div>
          <div id="ed-struct-opts" style="margin-bottom:12px;display:none;">
            <div style="color:#9A8A6A;font-size:0.78em;">STRUCTURE TYPE</div>
            <select id="ed-struct-type" style="width:100%;background:#1a1612;color:#E0D0A0;border:1px solid #3A3020;">
              <option value="0">Interior</option><option value="1">Tower</option><option value="2">Generator</option>
              <option value="3">Turret</option><option value="4">Station</option>
            </select>
            <div style="color:#9A8A6A;font-size:0.78em;margin-top:4px;">Rotation:</div>
            <input type="range" min="0" max="359" value="0" id="ed-struct-rot" style="width:100%;" />
            <button onclick="window.__editor && window.__editor.clearStructures()" style="background:#3a2410;color:#E0D0A0;border:1px solid #6A4A20;padding:4px 8px;cursor:pointer;margin-top:6px;width:100%;">Clear all structures</button>
          </div>
          <div id="ed-point-opts" style="margin-bottom:12px;display:none;">
            <div style="color:#9A8A6A;font-size:0.78em;">POINT TYPE</div>
            <select id="ed-point-type" style="width:100%;background:#1a1612;color:#E0D0A0;border:1px solid #3A3020;">
              <option value="flag0">Red Flag</option><option value="flag1">Blue Flag</option>
              <option value="spawn0">Red Spawn</option><option value="spawn1">Blue Spawn</option>
            </select>
          </div>
          <div style="margin-top:24px;color:#7A6A4A;font-size:0.75em;line-height:1.4;">
            File saved is a <b>float-array</b> .tribes-map. Re-encode with<br>
            <code>bun run tools/genmap.ts</code><br>
            for size-optimised publishing.
          </div>
        </div>
        <div style="flex:1;display:flex;justify-content:center;align-items:center;background:#0a0e0c;">
          <canvas id="editor-canvas" width="${SIZE}" height="${SIZE}" style="border:1px solid #3A3020;background:#000;cursor:crosshair;width:512px;height:512px;image-rendering:pixelated;"></canvas>
        </div>
      </div>
    `;
    document.body.appendChild(div);

    const c = div.querySelector('#editor-canvas');
    let dragging = false;
    c.addEventListener('mousedown', e => { dragging = true; onCanvasClick(e, false); });
    c.addEventListener('mousemove', e => { if (dragging) onCanvasClick(e, true); });
    c.addEventListener('mouseup',   () => { dragging = false; });
    c.addEventListener('mouseleave',() => { dragging = false; });
    c.addEventListener('wheel', e => {
        if (_state.tool === 'structure') {
            _state.nextStructureRot = (_state.nextStructureRot + (e.deltaY > 0 ? 15 : -15) + 360) % 360;
            div.querySelector('#ed-struct-rot').value = _state.nextStructureRot;
            e.preventDefault();
        }
    }, { passive: false });

    div.addEventListener('change', e => {
        if (e.target.name === 'ed-tool') {
            _state.tool = e.target.value;
            div.querySelector('#ed-brush-opts').style.display  = (_state.tool === 'brush') ? '' : 'none';
            div.querySelector('#ed-struct-opts').style.display = (_state.tool === 'structure') ? '' : 'none';
            div.querySelector('#ed-point-opts').style.display  = (_state.tool === 'point') ? '' : 'none';
        }
        if (e.target.id === 'ed-radius')    _state.brushRadius   = Number(e.target.value);
        if (e.target.id === 'ed-strength')  _state.brushStrength = Number(e.target.value);
        if (e.target.id === 'ed-struct-type') _state.nextStructureType = Number(e.target.value);
        if (e.target.id === 'ed-struct-rot')  _state.nextStructureRot  = Number(e.target.value);
        if (e.target.id === 'ed-point-type')  _state.nextPointType     = e.target.value;
        if (e.target.id === 'ed-id')          _state.id   = e.target.value || 'untitled';
        if (e.target.id === 'ed-name')        _state.name = e.target.value || 'Untitled';
    });
    document.addEventListener('keydown', e => {
        if (div.style.display === 'none') return;
        if (e.key === 'Escape') close();
    });
    return div;
}

export function open() {
    if (!_state) _state = newState();
    let modal = document.getElementById('editor-overlay');
    if (!modal) modal = buildOverlay();
    modal.style.display = 'flex';
    renderCanvas();
}
export function close() {
    const modal = document.getElementById('editor-overlay');
    if (modal) modal.style.display = 'none';
}
export function clearStructures() {
    if (!_state) return;
    _state.structures = [];
    renderCanvas();
}
export function test() {
    // R25: a freshly-edited map can't be loaded by the server until it's
    // published into MAP_REGISTRY. Direct the player to Save + publish flow.
    alert('Save the map, then run `bun run tools/genmap.ts` (or copy the file into client/maps/) and restart the server. Test-in-editor will be added in R26.');
}

window.__editor = { open, close, save, loadFromFile, clearStructures, test };
window.openMapEditor = open;
