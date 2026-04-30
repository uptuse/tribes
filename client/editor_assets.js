/**
 * Place mode — drop flags, spawns, turrets, generators onto terrain.
 * Ports the existing level_editor.js palette into the shell.
 */
import { log, updateSceneSummary } from './shell.js';

const ASSET_TYPES = [
  { id: 'Flag',       label: 'Flag',            icon: '🚩', color: 0xFFFFFF },
  { id: 'SpawnPoint', label: 'Spawn point',      icon: '⬇',  color: 0x888888 },
  { id: 'Turret',     label: 'Turret',           icon: '🔫', color: 0xCC4444 },
  { id: 'Generator',  label: 'Generator',        icon: '⚡', color: 0x44AA44 },
  { id: 'Station',    label: 'Inventory station',icon: '📦', color: 0x4488CC },
  { id: 'Sensor',     label: 'Sensor',           icon: '📡', color: 0xCCAA00 },
];

let _selectedType = null;
let _raycaster, _terrainMesh, _scene;

export const EditorAssets = { buildPalette, onEnter, onExit, clearScene };

function onEnter() {
  // Delegate to existing level_editor.js if available
  if (window.__editorSetActive) window.__editorSetActive(true);
  document.addEventListener('click', _onCanvasClick, true);
}
function onExit() {
  if (window.__editorSetActive) window.__editorSetActive(false);
  document.removeEventListener('click', _onCanvasClick, true);
  _selectedType = null;
  _refreshSelection();
}
function clearScene() {
  if (window.__editorClearAll) window.__editorClearAll();
}

function buildPalette(root) {
  const body = root;
  
  
  // footer: = 'Pick an asset, then click the ground to drop it.';

  body.innerHTML = `<div class="fw-section-label">Assets</div>`;
  ASSET_TYPES.forEach(type => {
    const item = document.createElement('div');
    item.className = 'fw-asset-item';
    item.dataset.id = type.id;
    item.innerHTML = `<span class="fw-asset-icon">${type.icon}</span><span class="fw-asset-label">${type.label}</span>`;
    item.addEventListener('click', () => {
      _selectedType = _selectedType === type.id ? null : type.id;
      // Delegate to existing level editor
      if (window.__editorSelectType) window.__editorSelectType(_selectedType);
      _refreshSelection();
      if (_selectedType) log(`Placing ${type.label} — click the ground`);
    });
    body.appendChild(item);
  });

  // Export button
  const sep = document.createElement('div'); sep.className = 'fw-separator';
  body.appendChild(sep);
  const btn = document.createElement('button');
  btn.className = 'fw-btn primary'; btn.textContent = 'Export layout.json';
  btn.addEventListener('click', () => {
    if (window.__editorExportLayout) window.__editorExportLayout();
    log('Layout exported — commit the downloaded file to save permanently');
  });
  body.appendChild(btn);
}

function _refreshSelection() {
  document.querySelectorAll('#fw-palette-body-edit-assets .fw-asset-item').forEach(el => {
    el.classList.toggle('active', el.dataset.id === _selectedType);
  });
}

function _onCanvasClick(e) {
  // Level editor handles the actual raycast placement
  // This just keeps the selection state in sync
}
