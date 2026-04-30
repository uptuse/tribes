/**
 * Paint mode — click a building piece to recolour it.
 */
import * as THREE from 'three';
import { log } from './shell.js';

const SWATCHES = [
  { id: 'steel',  label: 'Steel',   color: 0x9aa2ad },
  { id: 'plate',  label: 'Plate',   color: 0x6b7280 },
  { id: 'copper', label: 'Copper',  color: 0xb87333 },
  { id: 'glow',   label: 'Glow',    color: 0x4488ff },
  { id: 'matte',  label: 'Matte',   color: 0x3d4451 },
  { id: 'ice',    label: 'Ice',     color: 0xb0d8f0 },
];

let _activeColor = 0x9aa2ad;
let _raycaster, _scene;

export const EditorMaterials = { buildPalette, onEnter, onExit };

export function initMaterials(scene) { _scene = scene; _raycaster = new THREE.Raycaster(); }

function onEnter()  { document.addEventListener('click', _onClick); }
function onExit()   { document.removeEventListener('click', _onClick); }

function buildPalette(root) {
  const body = root;
  
  
  // footer: = 'Pick a colour, then click any wall to recolour it.';

  body.innerHTML = `<div class="fw-section-label">Colours</div>`;
  const swatchRow = document.createElement('div'); swatchRow.className = 'fw-swatches';
  SWATCHES.forEach(s => {
    const sw = document.createElement('div');
    sw.className = 'fw-swatch' + (s.color === _activeColor ? ' active' : '');
    sw.style.background = '#' + s.color.toString(16).padStart(6,'0');
    sw.title = s.label;
    sw.addEventListener('click', () => {
      _activeColor = s.color;
      root.querySelectorAll('.fw-swatch').forEach(x => x.classList.remove('active'));
      sw.classList.add('active');
    });
    swatchRow.appendChild(sw);
  });
  body.appendChild(swatchRow);
}

function _onClick(e) {
  if (e.target.closest('#fw-panel, .fw-palette')) return;
  const canvas = document.getElementById('canvas');
  if (!canvas || !window.__editorCamera || !_scene) return;
  const rect = canvas.getBoundingClientRect();
  const ndc = new THREE.Vector2(((e.clientX-rect.left)/rect.width)*2-1,-((e.clientY-rect.top)/rect.height)*2+1);
  _raycaster.setFromCamera(ndc, window.__editorCamera);
  const meshes = [];
  _scene.traverse(c => { if (c.isMesh && c !== window.__terrainMesh) meshes.push(c); });
  const hits = _raycaster.intersectObjects(meshes, false);
  if (!hits.length) return;
  const mesh = hits[0].object;
  if (mesh.material) {
    const mat = mesh.material.clone();
    mat.color.setHex(_activeColor);
    mesh.material = mat;
    log(`Painted piece`);
  }
}
