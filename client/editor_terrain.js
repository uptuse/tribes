/**
 * Sculpt mode — real heightmap editing via _writeHeightmapPatch C++ export.
 * Brush stroke calls C++, then refreshes the Three.js terrain vertex buffer
 * from the updated heightmap pointer so the visual matches physics.
 */
import { makeSlider, log } from './shell.js';

const BRUSHES = [
  { id: 'raise',  label: 'Raise',  icon: '▲', flag: 0 },
  { id: 'lower',  label: 'Lower',  icon: '▼', flag: 1 },
  { id: 'smooth', label: 'Smooth', icon: '~',  flag: 2 },
  { id: 'flatten',label: 'Flatten',icon: '—', flag: 3 },
];

let _activeBrush   = 'raise';
let _brushRadius   = 8;   // in heightmap cells (~64m at 8m/cell)
let _brushStrength = 0.5;
let _painting      = false;
let _raycaster;

export const EditorTerrain = { buildPalette, onEnter, onExit };

function onEnter() {
  const { Raycaster } = window.__THREE ?? {};
  if (Raycaster) _raycaster = new Raycaster();
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

  const sec = document.createElement('div'); sec.className = 'fw-section-label'; sec.textContent = 'Brush'; root.appendChild(sec);
  BRUSHES.forEach(b => {
    const item = document.createElement('div');
    item.className = 'fw-asset-item' + (b.id === _activeBrush ? ' active' : '');
    item.dataset.id = b.id;
    item.innerHTML = `<span class="fw-asset-icon">${b.icon}</span><span class="fw-asset-label">${b.label}</span>`;
    item.addEventListener('click', () => { _activeBrush = b.id; _refresh(); });
    root.appendChild(item);
  });

  const sep = document.createElement('div'); sep.className = 'fw-separator'; root.appendChild(sep);
  makeSlider({ label:'Radius',   value:_brushRadius,   min:1, max:40, step:1,    unit:'cells', fmt:v=>v.toFixed(0), container:root, onChange:v=>{_brushRadius=v;} });
  makeSlider({ label:'Strength', value:_brushStrength, min:0.05, max:2, step:0.05, unit:'',   fmt:v=>v.toFixed(2), container:root, onChange:v=>{_brushStrength=v;} });

  const note = document.createElement('p');
  note.style.cssText = 'font-size:10px;color:var(--ink-faint);margin-top:6px;line-height:1.5';
  note.textContent = 'Drag on the ground to sculpt. Switch to Play to walk over the changes.';
  root.appendChild(note);
}

function _refresh() {
  document.querySelectorAll('#fw-palette-host .fw-asset-item').forEach(el => {
    el.classList.toggle('active', el.dataset.id === _activeBrush);
  });
}

function _onDown(e) {
  if (e.target.closest('#fw-panel, .fw-palette')) return;
  _painting = true;
  _stroke(e);
}
function _onMove(e) { if (_painting) _stroke(e); }
function _onUp()    { _painting = false; }

function _stroke(e) {
  const pt = _raycast(e);
  if (!pt) return;
  window.__editorCursorWorld = pt;

  if (!window.Module?._writeHeightmapPatch) return;

  const TSCALE = Module._getHeightmapWorldScale?.() ?? 8;
  const TSIZE  = Module._getHeightmapSize?.() ?? 257;
  // Convert world pos to heightmap cell index
  const cx = Math.round(pt.x / TSCALE + TSIZE * 0.5);
  const cy = Math.round(pt.z / TSCALE + TSIZE * 0.5);
  const brushDef = BRUSHES.find(b => b.id === _activeBrush);
  const inv = e.shiftKey ? (brushDef?.flag === 0 ? 1 : (brushDef?.flag === 1 ? 0 : brushDef?.flag)) : brushDef?.flag ?? 0;

  Module._writeHeightmapPatch(cx, cy, _brushRadius, _brushStrength * 0.5, inv);

  // Refresh Three.js terrain vertex buffer from updated heightmap
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
  const arr  = pos.array;
  const N    = hSize;
  for (let i = 0; i < pos.count; i++) {
    const wx = arr[i * 3];
    const wz = arr[i * 3 + 2];
    const tx = Math.round(wx / TSCALE + N * 0.5);
    const tz = Math.round(wz / TSCALE + N * 0.5);
    const gx = Math.max(0, Math.min(N - 1, tx));
    const gz = Math.max(0, Math.min(N - 1, tz));
    arr[i * 3 + 1] = hmap[gz * N + gx];
  }
  pos.needsUpdate = true;
  terrain.geometry.computeVertexNormals();
}

function _raycast(e) {
  const canvas = document.getElementById('canvas');
  if (!canvas || !window.__editorCamera || !window.__terrainMesh) return null;
  if (!_raycaster) return null;
  const rect = canvas.getBoundingClientRect();
  const THREE = window.__THREE;
  if (!THREE) return null;
  const ndc = new THREE.Vector2(((e.clientX-rect.left)/rect.width)*2-1,-((e.clientY-rect.top)/rect.height)*2+1);
  _raycaster.setFromCamera(ndc, window.__editorCamera);
  const hits = _raycaster.intersectObject(window.__terrainMesh, false);
  return hits.length ? hits[0].point : null;
}
