/**
 * Layers — visibility + edit-lock per category.
 * Renders a collapsible panel pinned to the bottom-left of the editor.
 */
import { log } from '../shell.js';

const CATEGORIES = [
  { id: 'terrain',   label: 'Terrain'   },
  { id: 'buildings', label: 'Buildings' },
  { id: 'props',     label: 'Props'     },
  { id: 'triggers',  label: 'Triggers'  },
  { id: 'bots',      label: 'Bots'      },
  { id: 'vfx',       label: 'Effects'   },
  { id: 'audio',     label: 'Sound'     },
];

const _layers = {};
CATEGORIES.forEach(c => { _layers[c.id] = { visible: true, locked: false }; });

let _scene = null;

export const Layers = {
  init(scene) {
    _scene = scene;
    _buildPanel();
  },

  isVisible(id) { return _layers[id]?.visible ?? true; },
  isLocked(id)  { return _layers[id]?.locked  ?? false; },

  setVisible(id, v) {
    if (!_layers[id]) return;
    _layers[id].visible = v;
    _applyVisibility(id, v);
    _refreshPanel();
  },

  setLocked(id, v) {
    if (!_layers[id]) return;
    _layers[id].locked = v;
    _refreshPanel();
  },
};

function _applyVisibility(id, visible) {
  if (!_scene) return;
  _scene.traverse(obj => {
    if (obj.userData?.layerCategory === id) obj.visible = visible;
  });
}

function _buildPanel() {
  if (document.getElementById('fw-layers-panel')) return;
  const panel = document.createElement('div');
  panel.id = 'fw-layers-panel';
  panel.style.cssText = `
    position:fixed; bottom:10px; right:360px; z-index:990;
    width:160px; display:none;
    background:var(--panel-glass); border:1px solid var(--hairline);
    border-radius:var(--radius-md); font-family:var(--font-sans);
    backdrop-filter:blur(14px); font-size:11px;`;
  panel.innerHTML = `<div style="padding:7px 10px;border-bottom:1px solid var(--hairline);font-weight:500;color:var(--ink-dim)">Layers</div>
    <div id="fw-layers-body" style="padding:4px 0"></div>`;
  document.getElementById('fw-shell')?.appendChild(panel);
  _refreshPanel();

  // Show layers panel when editor is open
  const obs = new MutationObserver(() => {
    const open = document.getElementById('fw-panel')?.classList.contains('open');
    panel.style.display = open ? 'block' : 'none';
  });
  const fp = document.getElementById('fw-panel');
  if (fp) obs.observe(fp, { attributes: true, attributeFilter: ['class'] });
}

function _refreshPanel() {
  const body = document.getElementById('fw-layers-body');
  if (!body) return;
  body.innerHTML = '';
  CATEGORIES.forEach(cat => {
    const state = _layers[cat.id];
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;align-items:center;gap:4px;padding:3px 8px;';
    row.innerHTML = `
      <span style="flex:1;color:var(--ink-dim)">${cat.label}</span>
      <button title="Toggle visibility" style="background:none;border:none;cursor:pointer;font-size:12px;padding:2px;color:${state.visible?'var(--ink-dim)':'var(--ink-faint)'}">${state.visible?'👁':'🙈'}</button>
      <button title="Toggle lock" style="background:none;border:none;cursor:pointer;font-size:12px;padding:2px;color:${state.locked?'var(--amber)':'var(--ink-faint)'}">${state.locked?'🔒':'🔓'}</button>`;
    row.querySelectorAll('button')[0].addEventListener('click', () => Layers.setVisible(cat.id, !state.visible));
    row.querySelectorAll('button')[1].addEventListener('click', () => Layers.setLocked(cat.id, !state.locked));
    body.appendChild(row);
  });
}
