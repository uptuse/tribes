/**
 * Bots mode — drop bots with behaviour assignments.
 */
import * as THREE from 'three';
import { log, updateSceneSummary } from './shell.js';

const BEHAVIOURS = [
  { id: 'patrol',       label: 'Patrol',        desc: 'Walks a random route nearby.' },
  { id: 'guard',        label: 'Guard',          desc: 'Stays close to where it was dropped.' },
  { id: 'flag_capture', label: 'Capture flag',   desc: 'Heads for the flag and brings it home.' },
  { id: 'defend',       label: 'Defend base',    desc: 'Patrols around the nearest generator.' },
];

const _bots    = [];
let _activeBehaviour = 'patrol';
let _raycaster, _scene;

export const EditorAI = { buildPalette, onEnter, onExit, clearScene };

export function initAI(scene) { _scene = scene; _raycaster = new THREE.Raycaster(); }

function onEnter()  { document.addEventListener('click', _onClick); }
function onExit()   { document.removeEventListener('click', _onClick); }
function clearScene() {
  _bots.forEach(b => _scene?.remove(b.mesh));
  _bots.length = 0;
  _updateSummary();
}

function buildPalette(root) {
  const body = root;
  
  
  // footer: = 'Pick behaviour, then click the ground to drop a bot.';

  body.innerHTML = `<div class="fw-section-label">Behaviour</div>`;
  BEHAVIOURS.forEach(b => {
    const item = document.createElement('div');
    item.className = 'fw-asset-item' + (b.id === _activeBehaviour ? ' active' : '');
    item.dataset.id = b.id;
    item.innerHTML = `<span class="fw-asset-icon">🤖</span><div><div class="fw-asset-label">${b.label}</div><div style="font-size:10px;color:var(--ink-faint)">${b.desc}</div></div>`;
    item.addEventListener('click', () => { _activeBehaviour = b.id; _refresh(); });
    body.appendChild(item);
  });

  const sep = document.createElement('div'); sep.className = 'fw-separator';
  body.appendChild(sep);
  const btn = document.createElement('button');
  btn.className = 'fw-btn primary'; btn.textContent = 'Export bots.json';
  btn.addEventListener('click', _export);
  body.appendChild(btn);
}

function _refresh() {
  document.querySelectorAll('#fw-palette-body-edit-ai .fw-asset-item').forEach(el => {
    el.classList.toggle('active', el.dataset.id === _activeBehaviour);
  });
}

function _onClick(e) {
  if (e.target.closest('#fw-panel, .fw-palette')) return;
  const canvas = document.getElementById('canvas');
  if (!canvas || !window.__editorCamera) return;
  const rect = canvas.getBoundingClientRect();
  const ndc = new THREE.Vector2(((e.clientX-rect.left)/rect.width)*2-1,-((e.clientY-rect.top)/rect.height)*2+1);
  _raycaster.setFromCamera(ndc, window.__editorCamera);
  const terrain = window.__terrainMesh;
  if (!terrain) return;
  const hits = _raycaster.intersectObject(terrain, false);
  if (!hits.length) return;
  const pos = hits[0].point;

  // Try C++ bot spawn if available
  if (window.Module?._spawnBot) {
    try { Module._spawnBot(_activeBehaviour.length, pos.x, pos.z); } catch(e) {}
  }

  // Visual marker
  if (_scene) {
    const mesh = new THREE.Mesh(
      new THREE.CapsuleGeometry(0.4, 1.6, 4, 8),
      new THREE.MeshStandardMaterial({ color:0x44aa44, roughness:0.6, metalness:0.3 })
    );
    mesh.position.set(pos.x, pos.y + 0.8, pos.z);
    _scene.add(mesh);
    _bots.push({ mesh, behaviour: _activeBehaviour, x: pos.x, z: pos.z });
    _updateSummary();
    log(`Dropped bot: ${BEHAVIOURS.find(b=>b.id===_activeBehaviour)?.label}`);
  }
}

function _updateSummary() { updateSceneSummary({ bot: _bots.length }); }

function _export() {
  const data = { _format:'firewolf-bots-v1', bots: _bots.map((b,i) => ({ id:i, behaviour:b.behaviour, x:b.x, z:b.z }))};
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify(data,null,2)],{type:'application/json'}));
  a.download = 'bots.json'; document.body.appendChild(a); a.click(); a.remove();
  log(`Exported ${_bots.length} bots`);
}
