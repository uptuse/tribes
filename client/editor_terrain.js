/**
 * Sculpt mode — terrain brush UI.
 * Phase 1: UI palette only. Direct heightmap sculpting requires
 * exposing the heightmap buffer for write via a C++ export — tracked as follow-on.
 */
import { makeSlider, log } from './shell.js';

const BRUSHES = [
  { id: 'raise',  label: 'Raise',  icon: '▲', desc: 'Push the ground up.' },
  { id: 'lower',  label: 'Lower',  icon: '▼', desc: 'Push the ground down.' },
  { id: 'smooth', label: 'Smooth', icon: '~',  desc: 'Blend the surface flat.' },
  { id: 'paint',  label: 'Paint',  icon: '🎨', desc: 'Paint surface type (snow, rock, grass).' },
];

let _activeBrush = 'raise';
let _brushRadius  = 8;
let _brushStrength = 0.5;

export const EditorTerrain = { buildPalette, onEnter, onExit };

function onEnter()  { document.addEventListener('mousedown', _onMouseDown); }
function onExit()   { document.removeEventListener('mousedown', _onMouseDown); }

function buildPalette(root) {
  const body   = root.querySelector('#fw-palette-body-edit-terrain');
  const footer = root.querySelector('#fw-palette-footer-edit-terrain');
  if (!body) return;
  footer.textContent = 'Pick a brush, then drag the ground to sculpt. Shift inverts.';

  body.innerHTML = `<div class="fw-section-label">Brush</div>`;
  BRUSHES.forEach(b => {
    const item = document.createElement('div');
    item.className = 'fw-asset-item' + (b.id === _activeBrush ? ' active' : '');
    item.dataset.id = b.id;
    item.innerHTML = `<span class="fw-asset-icon">${b.icon}</span><div><div class="fw-asset-label">${b.label}</div><div style="font-size:10px;color:var(--ink-faint)">${b.desc}</div></div>`;
    item.addEventListener('click', () => { _activeBrush = b.id; _refresh(); });
    body.appendChild(item);
  });

  const sep = document.createElement('div'); sep.className = 'fw-separator';
  body.appendChild(sep);
  makeSlider({ label:'Radius', value:_brushRadius, min:1, max:40, step:1, unit:'m', fmt:v=>v.toFixed(0),
    container:body, onChange:v => { _brushRadius=v; } });
  makeSlider({ label:'Strength', value:_brushStrength, min:0.05, max:1, step:0.05, unit:'', fmt:v=>v.toFixed(2),
    container:body, onChange:v => { _brushStrength=v; } });

  const note = document.createElement('p');
  note.style.cssText = 'font-size:10px;color:var(--ink-faint);margin-top:8px;line-height:1.5';
  note.textContent = 'Direct heightmap editing coming soon. For now, use the existing terrain file.';
  body.appendChild(note);
}

function _refresh() {
  document.querySelectorAll('#fw-palette-body-edit-terrain .fw-asset-item').forEach(el => {
    el.classList.toggle('active', el.dataset.id === _activeBrush);
  });
}

function _onMouseDown(e) {
  if (e.target.closest('#fw-panel, .fw-palette')) return;
  log(`Sculpt: ${_activeBrush} at r=${_brushRadius}m (heightmap write not yet wired)`);
}
