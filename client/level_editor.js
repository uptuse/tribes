// ============================================================
// Phase-B Level Editor — client/level_editor.js
// Entity palette + terrain raycaster placement + layout export
// ============================================================

import * as THREE from 'three';
import { TransformControls } from 'three/addons/controls/TransformControls.js';

// Entity type definitions — palette items
const ENTITY_TYPES = [
  { id: 'Turret',       label: '🔫 Turret',     color: 0xCC4444, halfSize: [1.0, 2.5, 1.0] },
  { id: 'Generator',    label: '⚡ Generator',   color: 0x44AA44, halfSize: [1.5, 2.0, 1.5] },
  { id: 'Station',      label: '📦 Inv Station', color: 0x4488CC, halfSize: [1.0, 1.5, 1.0] },
  { id: 'Sensor',       label: '📡 Sensor',      color: 0xCCAA00, halfSize: [0.5, 4.0, 0.5] },
  { id: 'Flag',         label: '🚩 Flag',         color: 0xFFFFFF, halfSize: [0.3, 2.0, 0.3] },
  { id: 'SpawnPoint',   label: '⬇ Spawn',        color: 0x888888, halfSize: [0.5, 0.2, 0.5] },
];

// Internal state
let _scene         = null;
let _camera        = null;
let _renderer      = null;
let _raycaster     = new THREE.Raycaster();
let _terrainMesh   = null;   // reference to terrain for hit-testing
let _transformCtrl = null;
let _active        = false;
let _selectedType  = null;   // currently selected palette type
let _placedEntities = [];    // [{mesh, type, team, idx}] — both JSON-loaded and user-placed
let _selectedEntity = null;
let _layoutDirty    = false;

// Expose references (called once from renderer.js start())
export function initLevelEditor(scene, camera, rendererObj, terrain) {
  _scene    = scene;
  _camera   = camera;
  _renderer = rendererObj;
  _terrainMesh = terrain;

  // TransformControls for dragging selected entities
  _transformCtrl = new TransformControls(_camera, _renderer.domElement);
  _transformCtrl.setMode('translate');
  _transformCtrl.setSpace('world');
  _transformCtrl.addEventListener('dragging-changed', (e) => {
    // Release pointer-lock while dragging so mouse events go to Three.js
    if (e.value && document.exitPointerLock) document.exitPointerLock();
  });
  _transformCtrl.addEventListener('mouseUp', _onDragEnd);
  _scene.add(_transformCtrl);
  _transformCtrl.visible = false;

  // Canvas click — place or select
  _renderer.domElement.addEventListener('click', _onCanvasClick);

  console.log('[PhaseB] Level editor initialised');
}

// Called from the Physics tab "Edit Mode" checkbox
export function setActive(on) {
  _active = on;
  if (!on) {
    _transformCtrl && (_transformCtrl.visible = false);
    _transformCtrl && _transformCtrl.detach();
    _selectedEntity = null;
    _selectedType   = null;
    _highlightPaletteBtn(null);
  }
  console.log('[PhaseB] Level editor:', on ? 'ON' : 'OFF');
}

// Called when user clicks a palette button
export function selectEntityType(typeId) {
  _selectedType = typeId;
  _selectedEntity = null;
  _transformCtrl && _transformCtrl.detach();
  _highlightPaletteBtn(typeId);
}

// Build placeholder meshes from the WASM layout entity list
export function loadFromWASM() {
  if (!window.Module || !Module._isLayoutLoaded || !Module._isLayoutLoaded()) return;
  const count = Module._getLayoutEntityCount();

  // Allocate temp output buffers
  const xPtr = Module._malloc(4), yPtr = Module._malloc(4),
        zPtr = Module._malloc(4), rPtr = Module._malloc(4),
        tPtr = Module._malloc(4);

  for (let i = 0; i < count; i++) {
    Module._getLayoutEntity(i, xPtr, yPtr, zPtr, rPtr, tPtr);
    const x    = Module.HEAPF32[xPtr >> 2];
    const y    = Module.HEAPF32[yPtr >> 2];
    const z    = Module.HEAPF32[zPtr >> 2];
    const rotY = Module.HEAPF32[rPtr >> 2];
    const team = Module.HEAP32[tPtr >> 2];

    // Read type string via ccall
    const typeStr = _getEntityTypeFromWASM(i);
    _spawnEntityMesh(typeStr, team, x, y, z, rotY, i);
  }
  [xPtr, yPtr, zPtr, rPtr, tPtr].forEach(p => Module._free(p));
  console.log(`[PhaseB] Spawned ${count} entity markers from WASM layout`);
}

// Export the current layout as a JSON blob (download)
export function exportLayout() {
  const entities = _placedEntities.map(e => {
    const p = e.mesh.position;
    return {
      type:       e.type,
      team:       e.team,
      datablock:  e.datablock || e.type,
      name:       e.name || e.type,
      world_pos:  [parseFloat(p.x.toFixed(3)), parseFloat(p.y.toFixed(3)), parseFloat(p.z.toFixed(3))],
      world_rot_y: parseFloat((e.mesh.rotation.y).toFixed(4)),
    };
  });
  const layout = {
    _comment: 'Raindance layout — drop into assets/maps/raindance/layout.json and commit; CI rebuilds tribes.data',
    _format_version: 1,
    map: 'Raindance',
    entities,
  };
  const blob = new Blob([JSON.stringify(layout, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'layout.json';
  document.body.appendChild(a); a.click(); a.remove();
  _layoutDirty = false;
  console.log(`[PhaseB] Exported ${entities.length} entities`);
}

// ── Private helpers ─────────────────────────────────────────

function _getEntityTypeFromWASM(idx) {
  // Read from g_layoutEntities — type is a char[32] at a known offset
  // Simpler: we stored entity count & we know the struct layout.
  // For simplicity, use the placeholder mesh's userData if already created.
  return 'Unknown'; // will be overridden by caller
}

function _typeColor(typeId) {
  const def = ENTITY_TYPES.find(t => t.id === typeId);
  return def ? def.color : 0xAAAAAA;
}
function _typeHalfSize(typeId) {
  const def = ENTITY_TYPES.find(t => t.id === typeId);
  return def ? def.halfSize : [1, 1, 1];
}

function _spawnEntityMesh(typeId, team, x, y, z, rotY, wasmIdx) {
  const [hx, hy, hz] = _typeHalfSize(typeId);
  const geom = new THREE.BoxGeometry(hx * 2, hy * 2, hz * 2);
  const color = team === 0 ? 0xCC4444 : team === 1 ? 0x4466CC : _typeColor(typeId);
  const mat  = new THREE.MeshStandardMaterial({
    color, roughness: 0.6, metalness: 0.3,
    transparent: true, opacity: 0.75,
    wireframe: false,
  });
  // Wireframe overlay so entity is easy to see
  const wmat = new THREE.MeshBasicMaterial({ color: 0xFFFFFF, wireframe: true, transparent: true, opacity: 0.35 });
  const group = new THREE.Group();
  group.add(new THREE.Mesh(geom, mat));
  group.add(new THREE.Mesh(geom, wmat));
  group.position.set(x, y, z);
  group.rotation.y = rotY;
  group.frustumCulled = false;
  group.traverse(c => { c.frustumCulled = false; });

  _scene.add(group);
  const entry = { mesh: group, type: typeId, team, wasmIdx, datablock: typeId, name: typeId + '_' + _placedEntities.length };
  _placedEntities.push(entry);
  return entry;
}

function _onCanvasClick(e) {
  if (!_active) return;
  // Don't fire if a modal or UI panel is open
  if (document.getElementById('settings-modal')?.classList.contains('active')) return;

  const rect = _renderer.domElement.getBoundingClientRect();
  const ndc  = new THREE.Vector2(
    ((e.clientX - rect.left) / rect.width)  *  2 - 1,
    -((e.clientY - rect.top)  / rect.height) * 2 + 1
  );
  _raycaster.setFromCamera(ndc, _camera);

  if (_selectedType) {
    // Placement mode — raycast against terrain
    if (!_terrainMesh) return;
    const hits = _raycaster.intersectObject(_terrainMesh, false);
    if (hits.length > 0) {
      const pt = hits[0].point;
      const def = ENTITY_TYPES.find(t => t.id === _selectedType);
      const hy = def ? def.halfSize[1] : 1;
      _spawnEntityMesh(_selectedType, -1, pt.x, pt.y + hy, pt.z, 0, -1);
      _layoutDirty = true;
      console.log(`[PhaseB] Placed ${_selectedType} at (${pt.x.toFixed(1)}, ${pt.y.toFixed(1)}, ${pt.z.toFixed(1)})`);
    }
  } else {
    // Selection mode — hit-test existing entity meshes
    const targets = [];
    _placedEntities.forEach(entry => {
      entry.mesh.traverse(c => { if (c.isMesh) targets.push({ obj: c, entry }); });
    });
    const hits = _raycaster.intersectObjects(targets.map(t => t.obj), false);
    if (hits.length > 0) {
      const match = targets.find(t => t.obj === hits[0].object);
      if (match) {
        _selectedEntity = match.entry;
        _transformCtrl.attach(_selectedEntity.mesh);
        _transformCtrl.visible = true;
      }
    } else {
      _transformCtrl.detach();
      _transformCtrl.visible = false;
      _selectedEntity = null;
    }
  }
}

function _onDragEnd() {
  if (!_selectedEntity) return;
  const p = _selectedEntity.mesh.position;
  _layoutDirty = true;
  // Update WASM if this is a JSON-loaded entity
  if (_selectedEntity.wasmIdx >= 0 && Module._setLayoutEntityPos) {
    Module._setLayoutEntityPos(_selectedEntity.wasmIdx, p.x, p.y, p.z);
  }
}

function _highlightPaletteBtn(typeId) {
  document.querySelectorAll('.lvl-palette-btn').forEach(btn => {
    btn.style.borderColor = btn.dataset.type === typeId ? '#FFD479' : '#3A3020';
    btn.style.color       = btn.dataset.type === typeId ? '#FFD479' : '#9A8A6A';
  });
}

// Expose globals for index.html wiring
window.__editorSetActive      = setActive;
window.__editorSelectType     = selectEntityType;
window.__editorExportLayout   = exportLayout;
window.__editorLoadFromWASM   = loadFromWASM;
window.__editorGetDirty       = () => _layoutDirty;
