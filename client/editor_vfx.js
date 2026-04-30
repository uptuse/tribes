/**
 * Effects mode — place and preview particle effect presets.
 */
import * as THREE from 'three';
import { log } from './shell.js';

const PRESETS = [
  { id: 'explosion',  label: 'Explosion',   icon: '💥' },
  { id: 'muzzle',     label: 'Muzzle flash',icon: '✨' },
  { id: 'smoke',      label: 'Smoke',        icon: '💨' },
  { id: 'spark',      label: 'Sparks',       icon: '⚡' },
  { id: 'trail',      label: 'Disc trail',   icon: '🔵' },
  { id: 'impact',     label: 'Impact',       icon: '🔸' },
];

let _activePreset = 'explosion';
let _raycaster, _scene;

export const EditorVFX = { buildPalette, onEnter, onExit };

export function initVFX(scene) { _scene = scene; _raycaster = new THREE.Raycaster(); }

function onEnter()  { document.addEventListener('click', _onClick); }
function onExit()   { document.removeEventListener('click', _onClick); }

function buildPalette(root) {
  const body = root;
  
  
  // footer: = 'Pick an effect, then click the ground to set one off.';

  body.innerHTML = `<div class="fw-section-label">Effects</div>`;
  PRESETS.forEach(p => {
    const item = document.createElement('div');
    item.className = 'fw-asset-item' + (p.id === _activePreset ? ' active' : '');
    item.dataset.id = p.id;
    item.innerHTML = `<span class="fw-asset-icon">${p.icon}</span><span class="fw-asset-label">${p.label}</span>`;
    item.addEventListener('click', () => { _activePreset = p.id; _refresh(); });
    body.appendChild(item);
  });

  const btn = document.createElement('button');
  btn.className = 'fw-btn'; btn.style.marginTop = '8px';
  btn.textContent = 'Test fire in front of camera';
  btn.addEventListener('click', () => {
    if (!window.__editorCamera) return;
    const pos = window.__editorCamera.position.clone();
    const fwd = new THREE.Vector3(0,0,-4).applyQuaternion(window.__editorCamera.quaternion);
    _spawnEffect(_activePreset, pos.add(fwd));
  });
  body.appendChild(btn);
}

function _refresh() {
  document.querySelectorAll('#fw-palette-body-edit-vfx .fw-asset-item').forEach(el => {
    el.classList.toggle('active', el.dataset.id === _activePreset);
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
  if (hits.length) _spawnEffect(_activePreset, hits[0].point);
}

function _spawnEffect(preset, pos) {
  // Use the existing triggerExplosion / particle system if available
  if (window.triggerExplosion && preset === 'explosion') {
    try { window.triggerExplosion(pos.x, pos.y, pos.z, 1.0); } catch(e) {}
  }
  // Fallback: a quick flash sphere
  if (!_scene) { log(`Effect: ${preset}`); return; }
  const color = { explosion:0xff6020, muzzle:0xffee88, smoke:0x888888, spark:0xffcc00, trail:0x4488ff, impact:0xff8844 }[preset] ?? 0xffffff;
  const mesh = new THREE.Mesh(
    new THREE.SphereGeometry(0.3,8,6),
    new THREE.MeshStandardMaterial({ color, emissive:color, emissiveIntensity:3, transparent:true })
  );
  mesh.position.copy(pos);
  _scene.add(mesh);
  let t = 0;
  const fade = () => {
    t += 1/30;
    mesh.material.opacity = Math.max(0, 1 - t/0.5);
    mesh.scale.setScalar(1 + t*2);
    if (t < 0.5) requestAnimationFrame(fade);
    else _scene.remove(mesh);
  };
  requestAnimationFrame(fade);
  log(`Spawned ${preset} effect`);
}
