/**
 * Triggers mode — place region triggers that fire events when the player walks in.
 */
import * as THREE from 'three';
import { makeSlider, log, updateSceneSummary } from './shell.js';

const KINDS = [
  { id: 'on_region_enter', label: 'Enter region',   color: 0x4488ff },
  { id: 'on_flag_enter',   label: 'Flag enters',    color: 0xff8844 },
  { id: 'on_death',        label: 'Player death',   color: 0xff4444 },
  { id: 'on_timer',        label: 'Timer fires',    color: 0x44cc66 },
];

const _triggers = [];
let _activeKind = 'on_region_enter';
let _radius     = 4;
let _ghostMesh, _scene, _raycaster;

export const EditorTriggers = { buildPalette, onEnter, onExit, clearScene };

export function initTriggers(scene) { _scene = scene; _raycaster = new THREE.Raycaster(); }

function onEnter() {
  document.addEventListener('click', _onClick);
  document.addEventListener('mousemove', _onMove);
}
function onExit() {
  document.removeEventListener('click', _onClick);
  document.removeEventListener('mousemove', _onMove);
  _removeGhost();
}
function clearScene() {
  _triggers.forEach(t => _scene?.remove(t.mesh));
  _triggers.length = 0;
  _updateSummary();
}

function buildPalette(root) {
  const body   = root.querySelector('#fw-palette-body-edit-triggers');
  const footer = root.querySelector('#fw-palette-footer-edit-triggers');
  if (!body) return;
  footer.textContent = 'Pick what should happen, then click the ground to mark a spot.';

  body.innerHTML = `<div class="fw-section-label">Event type</div>`;
  KINDS.forEach(k => {
    const item = document.createElement('div');
    item.className = 'fw-asset-item' + (k.id === _activeKind ? ' active' : '');
    item.dataset.id = k.id;
    item.innerHTML = `<span class="fw-asset-icon">⬤</span><span class="fw-asset-label">${k.label}</span>`;
    item.style.setProperty('--dot-color', '#' + k.color.toString(16).padStart(6,'0'));
    item.addEventListener('click', () => { _activeKind = k.id; _refreshKinds(); });
    body.appendChild(item);
  });

  body.appendChild(document.createElement('div')).className = 'fw-separator';
  makeSlider({ label: 'Radius', value: _radius, min: 1, max: 30, step: 0.5,
    unit: 'm', fmt: v => v.toFixed(1), container: body,
    onChange: v => { _radius = v; if (_ghostMesh) _ghostMesh.scale.setScalar(v / 4); } });

  const btn = document.createElement('button');
  btn.className = 'fw-btn primary'; btn.textContent = 'Export triggers.json';
  btn.addEventListener('click', _export);
  body.appendChild(btn);
}

function _refreshKinds() {
  document.querySelectorAll('#fw-palette-body-edit-triggers .fw-asset-item').forEach(el => {
    el.classList.toggle('active', el.dataset.id === _activeKind);
  });
}

function _onClick(e) {
  if (e.target.closest('#fw-panel, .fw-palette')) return;
  const pt = _raycast(e);
  if (!pt) return;
  _placeTrigger(_activeKind, pt, _radius);
}
function _onMove(e) {
  const pt = _raycast(e);
  if (!pt) return;
  window.__editorCursorWorld = pt;
  if (!_ghostMesh && _scene) {
    const geom = new THREE.CylinderGeometry(_radius, _radius, 0.15, 24);
    _ghostMesh = new THREE.Mesh(geom, new THREE.MeshStandardMaterial({ color:0x4488ff, transparent:true, opacity:0.35 }));
    _scene.add(_ghostMesh);
  }
  if (_ghostMesh) { _ghostMesh.position.copy(pt); _ghostMesh.position.y += 0.1; }
}
function _removeGhost() { if (_ghostMesh && _scene) { _scene.remove(_ghostMesh); _ghostMesh = null; } }

function _raycast(e) {
  const canvas = document.getElementById('canvas');
  if (!canvas || !window.__editorCamera) return null;
  const rect = canvas.getBoundingClientRect();
  const ndc = new THREE.Vector2(((e.clientX-rect.left)/rect.width)*2-1, -((e.clientY-rect.top)/rect.height)*2+1);
  _raycaster.setFromCamera(ndc, window.__editorCamera);
  const terrain = window.__terrainMesh;
  if (!terrain) return null;
  const hits = _raycaster.intersectObject(terrain, false);
  return hits.length ? hits[0].point : null;
}

function _placeTrigger(kind, pos, radius) {
  if (!_scene) return;
  const kdef = KINDS.find(k => k.id === kind);
  const geom = new THREE.CylinderGeometry(radius, radius, 0.2, 24);
  const mesh = new THREE.Mesh(geom, new THREE.MeshStandardMaterial({
    color: kdef?.color ?? 0x4488ff, transparent: true, opacity: 0.5
  }));
  mesh.position.set(pos.x, pos.y + 0.1, pos.z);
  _scene.add(mesh);
  const id = Date.now();
  _triggers.push({ id, kind, x: pos.x, z: pos.z, radius, mesh });
  _updateSummary();
  log(`Placed trigger: ${kdef?.label ?? kind}`);
}

function _updateSummary() { updateSceneSummary({ trigger: _triggers.length }); }

function _export() {
  const data = { _format: 'firewolf-triggers-v1', triggers: _triggers.map(t => ({
    id: t.id, kind: t.kind, x: t.x, z: t.z, radius: t.radius
  }))};
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify(data,null,2)],{type:'application/json'}));
  a.download = 'triggers.json';
  document.body.appendChild(a); a.click(); a.remove();
  log(`Exported ${_triggers.length} triggers`);
}
