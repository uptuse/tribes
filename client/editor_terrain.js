/**
 * Sculpt mode — terrain brush + camera presets + zoom.
 */
import { makeSlider, log } from './shell.js';

const BRUSHES = [
  { id: 'raise',   label: 'Raise',   icon: '▲', flag: 0 },
  { id: 'lower',   label: 'Lower',   icon: '▼', flag: 1 },
  { id: 'smooth',  label: 'Smooth',  icon: '~',  flag: 2 },
  { id: 'flatten', label: 'Flatten', icon: '—', flag: 3 },
];

const CAMERA_PRESETS = [
  {
    id: 'character',
    label: 'Above player',
    icon: '🧍',
    apply(cam, ctrl) {
      // Angled view from behind and above the local player
      const p = _getPlayerPos();
      ctrl.target.set(p.x, p.y, p.z);
      cam.position.set(p.x - 15, p.y + 25, p.z - 15);
      ctrl.update();
    },
  },
  {
    id: 'overhead',
    label: 'Top down',
    icon: '⬆',
    apply(cam, ctrl) {
      // Straight down over the player, ~80m up
      const p = _getPlayerPos();
      ctrl.target.set(p.x, p.y, p.z);
      cam.position.set(p.x, p.y + 80, p.z + 0.01); // tiny Z offset keeps orientation
      ctrl.update();
    },
  },
  {
    id: 'mapview',
    label: 'Full map',
    icon: '🗺',
    apply(cam, ctrl) {
      // Bird's-eye of the whole Raindance map (~2048m square)
      ctrl.target.set(0, 30, 0);
      cam.position.set(0, 900, 0.1);
      ctrl.update();
    },
  },
];

let _activeBrush   = 'raise';
let _brushRadius   = 8;
let _brushStrength = 0.5;
let _painting      = false;
let _raycaster;

export const EditorTerrain = { buildPalette, onEnter, onExit };

function onEnter() {
  const THREE = window.__THREE;
  if (THREE) _raycaster = new THREE.Raycaster();
  document.addEventListener('mousedown', _onDown);
  document.addEventListener('mousemove', _onMove);
  document.addEventListener('mouseup',   _onUp);
}
function onExit() {
  document.removeEventListener('mousedown', _onDown);
  document.removeEventListener('mousemove', _onMove);
  document.removeEventListener('mouseup',   _onUp);
  _painting = false;
}

function buildPalette(root) {
  root.innerHTML = '';

  // ── Camera presets ────────────────────────────────────────
  const camSec = document.createElement('div');
  camSec.className = 'fw-section-label';
  camSec.textContent = 'Camera';
  root.appendChild(camSec);

  CAMERA_PRESETS.forEach(preset => {
    const btn = document.createElement('div');
    btn.className = 'fw-asset-item';
    btn.innerHTML = `<span class="fw-asset-icon">${preset.icon}</span><span class="fw-asset-label">${preset.label}</span>`;
    btn.addEventListener('click', () => {
      const cam  = window.__editorCamera;
      const ctrl = window.__editorOrbitCtrl;
      if (!cam || !ctrl) { log('Enter Sculpt mode first — camera not active'); return; }
      preset.apply(cam, ctrl);
      log(`Camera: ${preset.label}`);
    });
    root.appendChild(btn);
  });

  // Zoom/altitude slider
  const sep0 = document.createElement('div'); sep0.className = 'fw-separator'; root.appendChild(sep0);
  let _zoom = 80;
  makeSlider({
    label: 'Altitude', value: _zoom, min: 10, max: 900, step: 10, unit: 'm',
    fmt: v => v.toFixed(0), container: root,
    onChange: v => {
      _zoom = v;
      const cam  = window.__editorCamera;
      const ctrl = window.__editorOrbitCtrl;
      if (!cam || !ctrl) return;
      // Maintain horizontal position, just change altitude
      const t  = ctrl.target;
      const dx = cam.position.x - t.x;
      const dz = cam.position.z - t.z;
      const d  = Math.sqrt(dx*dx + dz*dz) || 0.01;
      const ratio = v / cam.position.y;
      cam.position.set(t.x + dx * ratio, t.y + v, t.z + dz * ratio);
      ctrl.update();
    },
  });

  // ── Brushes ───────────────────────────────────────────────
  const sep1 = document.createElement('div'); sep1.className = 'fw-separator'; root.appendChild(sep1);
  const brushSec = document.createElement('div'); brushSec.className = 'fw-section-label';
  brushSec.textContent = 'Brush'; root.appendChild(brushSec);

  BRUSHES.forEach(b => {
    const item = document.createElement('div');
    item.className = 'fw-asset-item' + (b.id === _activeBrush ? ' active' : '');
    item.dataset.id = b.id;
    item.innerHTML = `<span class="fw-asset-icon">${b.icon}</span><span class="fw-asset-label">${b.label}</span>`;
    item.addEventListener('click', () => { _activeBrush = b.id; _refresh(); });
    root.appendChild(item);
  });

  const sep2 = document.createElement('div'); sep2.className = 'fw-separator'; root.appendChild(sep2);
  makeSlider({ label:'Radius',   value:_brushRadius,   min:1, max:40, step:1, unit:'cells',
    fmt:v=>v.toFixed(0), container:root, onChange:v=>{_brushRadius=v;} });
  makeSlider({ label:'Strength', value:_brushStrength, min:0.05, max:2, step:0.05, unit:'',
    fmt:v=>v.toFixed(2), container:root, onChange:v=>{_brushStrength=v;} });

  const note = document.createElement('p');
  note.style.cssText = 'font-size:10px;color:var(--ink-faint);margin-top:6px;line-height:1.5';
  note.textContent = 'Drag on the ground to sculpt. Shift inverts the brush.';
  root.appendChild(note);
}

function _refresh() {
  document.querySelectorAll('#fw-palette-host .fw-asset-item[data-id]').forEach(el => {
    el.classList.toggle('active', el.dataset.id === _activeBrush);
  });
}

function _getPlayerPos() {
  // Return local player world position, or map center as fallback
  if (window.playerView && window.playerStride) {
    try {
      const localIdx = window.Module?._getLocalPlayerIdx?.() ?? 0;
      const o = localIdx * window.playerStride;
      const px = window.playerView[o], py = window.playerView[o+1], pz = window.playerView[o+2];
      if (Number.isFinite(px) && px !== 0) return { x: px, y: py, z: pz };
    } catch(e) {}
  }
  return { x: 0, y: 30, z: 0 };
}

function _onDown(e) { if (e.target.closest('#fw-panel, .fw-palette')) return; _painting = true; _stroke(e); }
function _onMove(e) { if (_painting) _stroke(e); }
function _onUp()    { _painting = false; }

function _stroke(e) {
  const pt = _raycast(e);
  if (!pt) return;
  window.__editorCursorWorld = pt;
  if (!window.Module?._writeHeightmapPatch) return;
  const TSCALE = Module._getHeightmapWorldScale?.() ?? 8;
  const TSIZE  = Module._getHeightmapSize?.() ?? 257;
  const cx = Math.round(pt.x / TSCALE + TSIZE * 0.5);
  const cy = Math.round(pt.z / TSCALE + TSIZE * 0.5);
  const brushDef = BRUSHES.find(b => b.id === _activeBrush);
  const flag = e.shiftKey
    ? (brushDef?.flag === 0 ? 1 : brushDef?.flag === 1 ? 0 : brushDef?.flag)
    : (brushDef?.flag ?? 0);
  Module._writeHeightmapPatch(cx, cy, _brushRadius, _brushStrength * 0.5, flag);
  _refreshTerrainMesh();
}

function _refreshTerrainMesh() {
  const terrain = window.__terrainMesh;
  if (!terrain?.geometry) return;
  const hPtr  = Module._getHeightmapPtr();
  const hSize = Module._getHeightmapSize?.() ?? 257;
  const hmap  = new Float32Array(Module.HEAPF32.buffer, hPtr, hSize * hSize);
  const TSCALE = Module._getHeightmapWorldScale?.() ?? 8;
  const pos   = terrain.geometry.attributes.position;
  if (!pos) return;
  const arr = pos.array;
  const N   = hSize;
  for (let i = 0; i < pos.count; i++) {
    const wx = arr[i*3], wz = arr[i*3+2];
    const tx = Math.max(0, Math.min(N-1, Math.round(wx / TSCALE + N*0.5)));
    const tz = Math.max(0, Math.min(N-1, Math.round(wz / TSCALE + N*0.5)));
    arr[i*3+1] = hmap[tz * N + tx];
  }
  pos.needsUpdate = true;
  terrain.geometry.computeVertexNormals();
}

function _raycast(e) {
  const canvas = document.getElementById('canvas');
  if (!canvas || !window.__editorCamera || !window.__terrainMesh || !_raycaster) return null;
  const THREE = window.__THREE;
  if (!THREE) return null;
  const rect = canvas.getBoundingClientRect();
  const ndc = new THREE.Vector2(((e.clientX-rect.left)/rect.width)*2-1,-((e.clientY-rect.top)/rect.height)*2+1);
  _raycaster.setFromCamera(ndc, window.__editorCamera);
  const hits = _raycaster.intersectObject(window.__terrainMesh, false);
  return hits.length ? hits[0].point : null;
}
