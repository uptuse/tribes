/**
 * MapManager — save / open / save-as for named maps.
 * v1: persists to localStorage (no server required).
 * Each map is keyed as "fw_map_<slug>" in localStorage.
 */
import { log } from '../shell.js';
import { History } from './History.js';

const PREFIX = 'fw_map_';
let _currentSlug = 'raindance';

export const MapManager = {
  init() {
    _currentSlug = localStorage.getItem('fw_lastMap') ?? 'raindance';
    _buildFileMenu();
  },

  saveMap() {
    const data = _collectScene();
    localStorage.setItem(PREFIX + _currentSlug, JSON.stringify(data));
    localStorage.setItem('fw_lastMap', _currentSlug);
    log(`Saved "${_currentSlug}"`);
  },

  saveMapAs(slug) {
    slug = slug ?? prompt('Map name:', _currentSlug);
    if (!slug) return;
    _currentSlug = slug.toLowerCase().replace(/[^a-z0-9_-]/g, '_');
    MapManager.saveMap();
  },

  openMap(slug) {
    slug = slug ?? _promptOpen();
    if (!slug) return;
    const raw = localStorage.getItem(PREFIX + slug);
    if (!raw) { log(`No saved map named "${slug}"`); return; }
    _currentSlug = slug;
    _applyScene(JSON.parse(raw));
    History.clear();
    log(`Opened "${slug}"`);
  },

  listMaps() {
    const maps = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k.startsWith(PREFIX)) maps.push(k.slice(PREFIX.length));
    }
    return maps;
  },

  currentMap() { return _currentSlug; },
};

function _collectScene() {
  return {
    slug: _currentSlug,
    savedAt: new Date().toISOString(),
    // Each editor module can expose a getSceneData() hook
    buildings: window.__editorGetBuildings?.() ?? [],
    triggers:  window.__editorGetTriggers?.()  ?? [],
    bots:      window.__editorGetBots?.()       ?? [],
    props:     window.__editorGetProps?.()      ?? [],
  };
}

function _applyScene(data) {
  window.__editorApplyBuildings?.(data.buildings ?? []);
  window.__editorApplyTriggers?.(data.triggers  ?? []);
  window.__editorApplyBots?.(data.bots          ?? []);
  window.__editorApplyProps?.(data.props         ?? []);
}

function _promptOpen() {
  const maps = MapManager.listMaps();
  if (!maps.length) { log('No saved maps found — save one first'); return null; }
  return prompt(`Open map:\n${maps.join(', ')}`, maps[0]);
}

function _buildFileMenu() {
  // Add "File" dropdown to the top bar wordmark click
  const wm = document.getElementById('fw-wordmark-btn');
  if (!wm) return;
  wm.addEventListener('click', () => {
    const existing = document.getElementById('fw-file-menu');
    if (existing) { existing.remove(); return; }
    const menu = document.createElement('div');
    menu.id = 'fw-file-menu';
    menu.style.cssText = `
      position:fixed; top:42px; left:18px; z-index:2000;
      background:var(--panel-glass); border:1px solid var(--hairline);
      border-radius:var(--radius-md); padding:4px 0;
      backdrop-filter:blur(14px); min-width:160px;
      box-shadow:0 8px 24px oklch(0.22 0.015 60 / 0.08);`;
    const items = [
      { label: 'Save',         key: 'Ctrl+S',          fn: () => MapManager.saveMap() },
      { label: 'Save as…',     key: 'Ctrl+Shift+S',    fn: () => MapManager.saveMapAs() },
      { label: 'Open…',        key: 'Ctrl+O',          fn: () => MapManager.openMap() },
      { label: 'New map',      key: '',                 fn: () => { MapManager.saveMapAs(); History.clear(); } },
    ];
    items.forEach(item => {
      const el = document.createElement('div');
      el.style.cssText = `
        display:flex;justify-content:space-between;align-items:center;
        padding:6px 14px; font-size:12px; color:var(--ink-dim);
        cursor:pointer; gap:20px;`;
      el.innerHTML = `<span>${item.label}</span><span style="color:var(--ink-faint);font-size:10px;font-family:var(--font-mono)">${item.key}</span>`;
      el.addEventListener('mouseenter', () => el.style.background = 'oklch(0.22 0.015 60 / 0.05)');
      el.addEventListener('mouseleave', () => el.style.background = '');
      el.addEventListener('click', () => { item.fn(); menu.remove(); });
      menu.appendChild(el);
    });
    document.body.appendChild(menu);
    const dismiss = () => { menu.remove(); document.removeEventListener('click', dismiss); };
    setTimeout(() => document.addEventListener('click', dismiss), 10);
  });
}
