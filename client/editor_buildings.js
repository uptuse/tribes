/**
 * Build mode — place modular wall/floor pieces with snap-to-grid.
 * Ports editor/buildings.html logic into the main game shell.
 */
import * as THREE from 'three';
import { log, updateSceneSummary } from './shell.js';

const GRID = 4;          // 4-metre snap grid
const PIECES = [
  { id: 'wall',         label: 'Wall',          icon: '▬', w:4,  h:4,  d:0.3 },
  { id: 'wall-small',   label: 'Small wall',    icon: '▬', w:2,  h:4,  d:0.3 },
  { id: 'floor',        label: 'Floor',         icon: '⬜', w:4,  h:0.3,d:4   },
  { id: 'floor-large',  label: 'Large floor',   icon: '⬜', w:8,  h:0.3,d:8   },
  { id: 'ramp',         label: 'Ramp',          icon: '◺',  w:4,  h:4,  d:4   },
  { id: 'pillar',       label: 'Pillar',        icon: '▮',  w:1,  h:8,  d:1   },
];

const _placed  = [];     // { mesh, pieceId, pos, rotY }
let _activePieceId = null;
let _ghostMesh = null;
let _rotY = 0;
let _raycaster, _scene, _camera, _terrainMesh;

const _mat = new THREE.MeshStandardMaterial({
  color: 0x9aa2ad, roughness: 0.4, metalness: 0.6
});
const _ghostMat = new THREE.MeshStandardMaterial({
  color: 0xe89030, roughness: 0.5, transparent: true, opacity: 0.55
});

export const EditorBuildings = { buildPalette, onEnter, onExit, clearScene };

export function initBuildingsEditor(scene, camera, terrain) {
  _scene       = scene;
  _camera      = camera;
  _terrainMesh = terrain;
  _raycaster   = new THREE.Raycaster();
}

function onEnter() {
  document.addEventListener('mousemove', _onMouseMove);
  document.addEventListener('click',     _onClick);
  document.addEventListener('keydown',   _onKey);
}

function onExit() {
  document.removeEventListener('mousemove', _onMouseMove);
  document.removeEventListener('click',     _onClick);
  document.removeEventListener('keydown',   _onKey);
  _removeGhost();
  _activePieceId = null;
  _refreshSelection();
}

function clearScene() {
  _placed.forEach(p => _scene?.remove(p.mesh));
  _placed.length = 0;
  _updateSummary();
}

function buildPalette(root) {
  const body = root;
  
  
  // footer: = 'Pick a piece, click the ground to place. R to rotate.';

  body.innerHTML = `<div class="fw-section-label">Pieces</div>`;
  PIECES.forEach(piece => {
    const item = document.createElement('div');
    item.className   = 'fw-asset-item';
    item.dataset.id  = piece.id;
    item.innerHTML   = `<span class="fw-asset-icon">${piece.icon}</span><span class="fw-asset-label">${piece.label}</span>`;
    item.addEventListener('click', () => {
      _activePieceId = _activePieceId === piece.id ? null : piece.id;
      _refreshSelection();
      _removeGhost();
      if (_activePieceId) {
        _spawnGhost(_activePieceId);
        log(`Building ${piece.label} — click ground to place, R to rotate`);
      }
    });
    body.appendChild(item);
  });

  const sep = document.createElement('div'); sep.className = 'fw-separator';
  body.appendChild(sep);
  const btn = document.createElement('button');
  btn.className = 'fw-btn primary'; btn.textContent = 'Export buildings.json';
  btn.addEventListener('click', _export);
  body.appendChild(btn);
}

function _refreshSelection() {
  document.querySelectorAll('#fw-palette-body-edit-buildings .fw-asset-item').forEach(el => {
    el.classList.toggle('active', el.dataset.id === _activePieceId);
  });
}

// Ghost piece follows mouse
function _onMouseMove(e) {
  if (!_ghostMesh || !_terrainMesh || !_camera) return;
  const pt = _raycastTerrain(e);
  if (!pt) return;
  const snapped = _snap(pt);
  _ghostMesh.position.copy(snapped);
  _ghostMesh.rotation.y = _rotY;
  window.__editorCursorWorld = snapped;
}

function _onClick(e) {
  if (!_activePieceId || !_scene || !_terrainMesh) return;
  // Don't place when clicking panel UI
  if (e.target.closest('#fw-panel, .fw-palette')) return;
  const pt = _raycastTerrain(e);
  if (!pt) return;
  _placePiece(_activePieceId, _snap(pt), _rotY);
}

function _onKey(e) {
  if ((e.key === 'r' || e.key === 'R') && _activePieceId) {
    _rotY += Math.PI / 2;
    if (_ghostMesh) _ghostMesh.rotation.y = _rotY;
  }
}

function _raycastTerrain(e) {
  if (!_terrainMesh || !_camera) return null;
  const canvas = document.getElementById('canvas');
  const rect = canvas.getBoundingClientRect();
  const ndc  = new THREE.Vector2(
    ((e.clientX - rect.left) / rect.width)  *  2 - 1,
    -((e.clientY - rect.top)  / rect.height) * 2 + 1
  );
  _raycaster.setFromCamera(ndc, _camera);
  const hits = _raycaster.intersectObject(_terrainMesh, false);
  return hits.length ? hits[0].point : null;
}

function _snap(pt) {
  return new THREE.Vector3(
    Math.round(pt.x / GRID) * GRID,
    pt.y,
    Math.round(pt.z / GRID) * GRID
  );
}

function _spawnGhost(id) {
  const def = PIECES.find(p => p.id === id);
  if (!def || !_scene) return;
  const geom = new THREE.BoxGeometry(def.w, def.h, def.d);
  _ghostMesh = new THREE.Mesh(geom, _ghostMat);
  _ghostMesh.position.y = def.h / 2;
  _ghostMesh.frustumCulled = false;
  _scene.add(_ghostMesh);
}

function _removeGhost() {
  if (_ghostMesh && _scene) { _scene.remove(_ghostMesh); _ghostMesh = null; }
}

function _placePiece(id, pos, rotY) {
  const def = PIECES.find(p => p.id === id);
  if (!def || !_scene) return;
  const geom = new THREE.BoxGeometry(def.w, def.h, def.d);
  const mesh = new THREE.Mesh(geom, _mat.clone());
  mesh.position.set(pos.x, pos.y + def.h / 2, pos.z);
  mesh.rotation.y = rotY;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  _scene.add(mesh);
  _placed.push({ mesh, pieceId: id, pos: pos.clone(), rotY });
  _updateSummary();
  log(`Placed ${def.label}`);
}

function _updateSummary() {
  updateSceneSummary({ wall: _placed.filter(p=>p.pieceId.startsWith('wall')).length,
                       floor: _placed.filter(p=>p.pieceId.startsWith('floor')||p.pieceId==='ramp').length });
}

function _export() {
  const data = { _format: 'firewolf-buildings-v1', pieces: _placed.map(p => ({
    id: p.pieceId,
    x: p.pos.x, y: p.pos.y, z: p.pos.z,
    rotY: p.rotY,
  }))};
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'buildings.json';
  document.body.appendChild(a); a.click(); a.remove();
  log(`Exported ${_placed.length} pieces — commit the downloaded file`);
}
