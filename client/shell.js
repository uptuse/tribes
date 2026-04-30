/**
 * Firewolf Shell — mode switcher, top bar, right-side panel, help card.
 * R32.275: palette consolidated into the right panel (single column).
 * Everything the operator touches is in one 340px column on the right.
 */
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { History }          from './editor_core/History.js';
import { Snap }             from './editor_core/Snap.js';
import { CameraBookmarks }  from './editor_core/CameraBookmarks.js';
import { Selection }        from './editor_core/Selection.js';
import { MapManager }       from './editor_core/MapManager.js';
import { Layers }           from './editor_core/Layers.js';

// ── State ──────────────────────────────────────────────────────────
const _state = {
  mode:      'play',
  panelOpen: false,
  helpOpen:  true,
  orbitCtrl: null,
};

const _modes = {};  // id → { onEnter, onExit, buildPalette }
let _camera, _renderer, _scene;

// ── Public API ─────────────────────────────────────────────────────
export const Shell = {
  init,
  registerMode,
  switchMode,
  togglePanel,
  log,
  getMode: () => _state.mode,
  isPanelOpen: () => _state.panelOpen,
};
window.__shell = Shell;

// ── Mode definitions ───────────────────────────────────────────────
const MODE_ROWS = [
  [
    { id: 'play',             label: 'Play',     desc: "You're in the game. Click to look around, WASD to move.",                           tip: "Open this panel any time with Shift+Enter to switch modes." },
    { id: 'edit-assets',      label: 'Place',    desc: "Pick something from the list below, then click the ground to drop it.",            tip: "Right-drag to look around. Wheel to zoom." },
    { id: 'edit-buildings',   label: 'Build',    desc: "Pick a wall or floor below, then click to place. Press R to rotate.",              tip: "Pieces snap to a 4-metre grid." },
    { id: 'edit-terrain',     label: 'Sculpt',   desc: "Pick a brush below, then drag the ground to push it up, down, or smooth.",         tip: "[ and ] resize the brush. Shift inverts." },
    { id: 'edit-animations',  label: 'Animate',  desc: "Pick a clip below and scrub the timeline to preview it.",                          tip: "Changes apply live to the character in the scene." },
    { id: 'edit-materials',   label: 'Paint',    desc: "Pick a colour below, then click any wall to recolour it.",                         tip: "Six colours to start." },
  ],
  [
    { id: 'edit-tuning',      label: 'Tune',     desc: "Drag any slider to tune the game — damage, gravity, match length.",                tip: "Switch to Play to feel the difference." },
    { id: 'edit-triggers',    label: 'Triggers', desc: "Pick what should happen, then click the ground to mark a spot.",                   tip: "Walk into it in Play to fire it." },
    { id: 'edit-audio',       label: 'Sound',    desc: "Pick a sound and hit play to hear it. Drag the sliders to tune it.",               tip: "Sounds preview through your speakers." },
    { id: 'edit-vfx',         label: 'Effects',  desc: "Pick an effect, then click the ground to set one off.",                            tip: "Try Test Fire to drop one in front of you." },
    { id: 'edit-ai',          label: 'Bots',     desc: "Pick what the bot should do, then click the ground to drop it.",                   tip: "Patrol walks a route. Guard stays close." },
    { id: 'edit-bindings',    label: 'Bindings', desc: "Connect events to sounds and effects without code.",                               tip: "Click an event, then drag a sound or effect onto it." },
    { id: 'edit-lighting',    label: 'Light',    desc: "Adjust sun direction, ambient brightness, fog, and material appearance.",          tip: "Changes are live — switch to Play to see the full day/night effect." },
  ],
];
const MODE_FLAT = MODE_ROWS.flat();

// ── Init ───────────────────────────────────────────────────────────
function init(camera, renderer, scene) {
  _camera   = camera;
  _renderer = renderer;
  _scene    = scene;

  // Cross-cutting services
  History.init();
  Snap.init();
  CameraBookmarks.init(camera);
  Selection.init(scene);
  MapManager.init();
  Layers.init(scene);

  _buildDOM();
  _bindKeys();

  // Assert WASM exports present
  const required = ['_pause', '_teleportPlayer', '_reloadBuildings', '_setPhysicsTuning'];
  const missing  = required.filter(fn => typeof window.Module?.[fn] !== 'function');
  if (missing.length) console.error('[Shell] Missing WASM exports:', missing);
  else                console.log('[Shell] WASM bridge OK:', required.join(', '));

  log('Editor ready — Shift+Enter to open', 'amber');
}

// ── Mode registration ──────────────────────────────────────────────
function registerMode(id, mod) {
  _modes[id] = mod;
  // Do NOT build palette at registration — build on demand when mode is entered
}

// ── Mode switching ─────────────────────────────────────────────────
function switchMode(newMode) {
  if (newMode === _state.mode) return;
  const prev = _state.mode;

  if (prev !== 'play' && _modes[prev]?.onExit) _modes[prev].onExit();
  _unmountPalette();

  _state.mode = newMode;

  if (newMode === 'play') {
    _resumePlay();
  } else {
    if (prev === 'play') _enterEdit();
    _mountPalette(newMode);
    if (_modes[newMode]?.onEnter) _modes[newMode].onEnter();
  }

  _updateTopBar();
  _updateModeGrid();
  _updateModeBody();
  log(`Switched to ${_modeLabel(newMode)}`);
}

function _enterEdit() {
  if (window.Module?._pause) Module._pause(1);
  window.isEditing = true;
  if (document.exitPointerLock) document.exitPointerLock();

  if (_camera.parent) _camera.parent.remove(_camera);
  _scene.add(_camera);

  _state.orbitCtrl = new OrbitControls(_camera, _renderer.domElement);
  _state.orbitCtrl.enableDamping = true;
  _state.orbitCtrl.dampingFactor = 0.1;
  _state.orbitCtrl.screenSpacePanning = true;
  _state.orbitCtrl.mouseButtons = { LEFT: null, MIDDLE: 1, RIGHT: 0 };
  _state.orbitCtrl.touches     = { ONE: null, TWO: 2 };

  window.__editorCamera    = _camera;
  window.__editorOrbitCtrl = _state.orbitCtrl;
}

function _resumePlay() {
  if (_state.orbitCtrl) {
    _state.orbitCtrl.dispose();
    _state.orbitCtrl = null;
    window.__editorOrbitCtrl = null;
  }
  window.isEditing = false;
  if (window.Module?._pause) Module._pause(0);
  const canvas = document.getElementById('canvas');
  if (window.gameStarted && canvas) canvas.requestPointerLock();
}

// ── Palette host — single column in the right panel ───────────────
function _mountPalette(id) {
  const host = document.getElementById('fw-palette-host');
  if (!host) return;
  host.innerHTML = '';
  if (_modes[id]?.buildPalette) _modes[id].buildPalette(host);
}
function _unmountPalette() {
  const host = document.getElementById('fw-palette-host');
  if (host) host.innerHTML = '';
}

// ── DOM ────────────────────────────────────────────────────────────
function _buildDOM() {
  let root = document.getElementById('fw-shell');
  if (!root) { root = document.createElement('div'); root.id = 'fw-shell'; document.body.appendChild(root); }

  root.innerHTML = `
    ${_buildTopBar()}
    ${_buildPanel()}
    ${_buildHelp()}
    ${_buildLog()}
    ${_buildTimeline()}`;

  root.querySelector('#fw-btn-help').addEventListener('click', _toggleHelp);
  root.querySelector('#fw-btn-panel').addEventListener('click', togglePanel);
  root.querySelector('#fw-help-close').addEventListener('click', _closeHelp);
  root.querySelector('#fw-help-start').addEventListener('click', _closeHelp);
  root.querySelectorAll('.fw-mode-tile').forEach(tile => {
    tile.addEventListener('click', () => switchMode(tile.dataset.id));
  });
  root.querySelector('#fw-btn-clear').addEventListener('click', () => {
    Object.values(_modes).forEach(m => m.clearScene?.());
    _unmountPalette();
    if (_state.mode !== 'play') _mountPalette(_state.mode);
    log('Scene cleared');
  });
}

function _buildTopBar() {
  return `<div id="fw-topbar">
    <div class="fw-topbar-inner">
      <div class="fw-topbar-left">
        <div class="fw-wordmark" id="fw-wordmark-btn" title="File menu" style="cursor:pointer">
          firewolf
          <svg class="fw-wordmark-triangle" width="6" height="6" viewBox="0 0 10 10" aria-hidden="true">
            <polygon points="5,0.5 9,9 1,9" fill="var(--amber)"/>
          </svg>
        </div>
        <span class="fw-topbar-sep" aria-hidden="true">/</span>
        <span id="fw-mode-badge" class="fw-mode-badge play">Play</span>
        <span id="fw-edit-sub" class="fw-edit-sub" style="display:none">edit · paused</span>
      </div>
      <div class="fw-topbar-right">
        <button id="fw-btn-help" class="fw-topbar-btn" title="Help (H)" aria-label="Help">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><circle cx="12" cy="17" r=".5" fill="currentColor"/></svg>
        </button>
        <button id="fw-btn-panel" class="fw-topbar-btn" title="Editor panel (Shift+Enter)" aria-label="Toggle panel">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M15 3v18"/></svg>
        </button>
      </div>
    </div>
  </div>`;
}

function _buildPanel() {
  const rows = MODE_ROWS.map(row => `
    <div class="fw-mode-row">
      ${row.map(m => `<button class="fw-mode-tile" data-id="${m.id}" title="${m.tip}">${m.label}</button>`).join('')}
    </div>`).join('');
  return `<div id="fw-panel">
    <div class="fw-panel-inner fw-panel">
      <div class="fw-panel-header">
        <span class="fw-panel-title">Editor</span>
        <button class="fw-topbar-btn" onclick="window.__shell.switchMode('play')" aria-label="Back to play">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6 6 18M6 6l12 12"/></svg>
        </button>
      </div>
      <div class="fw-mode-grid">${rows}</div>
      <div class="fw-mode-body" id="fw-mode-body"></div>
      <div id="fw-palette-host" class="fw-palette-host"></div>
      <div class="fw-panel-footer">
        <span class="fw-scene-summary" id="fw-scene-summary">Empty scene</span>
        <button class="fw-btn-clear" id="fw-btn-clear">Clear</button>
      </div>
    </div>
  </div>`;
}

function _buildHelp() {
  return `<div id="fw-help">
    <div class="fw-help-card fw-panel">
      <div class="fw-help-header">
        <div class="fw-wordmark">firewolf
          <svg class="fw-wordmark-triangle" width="7" height="7" viewBox="0 0 10 10" aria-hidden="true">
            <polygon points="5,0.5 9,9 1,9" fill="var(--amber)"/>
          </svg>
        </div>
        <button id="fw-help-close" class="fw-topbar-btn" aria-label="Close">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6 6 18M6 6l12 12"/></svg>
        </button>
      </div>
      <div class="fw-help-body">
        <p class="fw-help-intro">Two modes. <strong>Play</strong> the game, or open the editor to <strong>change</strong> it. Switch any time with <span class="fw-mode-key">Shift Enter</span>.</p>
        <div class="fw-help-steps">
          <div class="fw-help-step"><span class="fw-step-num">1</span><span class="fw-step-text">Click the screen to start playing.</span></div>
          <div class="fw-help-step"><span class="fw-step-num">2</span><span class="fw-step-text">Press <span class="fw-mode-key">Shift Enter</span> and pick a mode — Place, Build, Paint, Bots, anything.</span></div>
          <div class="fw-help-step"><span class="fw-step-num">3</span><span class="fw-step-text">Click on the ground to use the tool. Switch back to Play to see your changes live.</span></div>
        </div>
        <div class="fw-help-keys">
          <span class="fw-mode-key">W A S D</span><span>Move</span>
          <span class="fw-mode-key">R</span><span>Rotate piece before placing</span>
          <span class="fw-mode-key">Shift+P</span><span>Playtest from cursor</span>
          <span class="fw-mode-key">Ctrl+Z</span><span>Undo last action</span>
          <span class="fw-mode-key">H</span><span>Show this card again</span>
        </div>
      </div>
      <div class="fw-help-footer">
        <button id="fw-help-start" class="fw-btn-start">Start</button>
      </div>
    </div>
  </div>`;
}

function _buildLog()      { return `<div id="fw-log"></div>`; }
function _buildTimeline() {
  return `<div id="fw-timeline" class="fw-panel">
    <div class="fw-transport" id="fw-transport"></div>
    <div class="fw-tracks-area" id="fw-tracks-area"></div>
  </div>`;
}

// ── Update helpers ─────────────────────────────────────────────────
function _updateTopBar() {
  const badge   = document.getElementById('fw-mode-badge');
  const sub     = document.getElementById('fw-edit-sub');
  if (!badge) return;
  const editing = _state.mode !== 'play';
  badge.textContent = _modeLabel(_state.mode);
  badge.className   = `fw-mode-badge ${editing ? 'edit' : 'play'}`;
  if (sub) sub.style.display = editing ? '' : 'none';
}

function _updateModeGrid() {
  document.querySelectorAll('.fw-mode-tile').forEach(t => {
    t.classList.toggle('active', t.dataset.id === _state.mode);
  });
}

function _updateModeBody() {
  const body = document.getElementById('fw-mode-body');
  if (!body) return;
  const m = MODE_FLAT.find(x => x.id === _state.mode);
  if (!m) return;
  body.innerHTML = m.desc
    ? `<p class="fw-mode-desc">${m.desc}</p><p class="fw-mode-tip">${m.tip}</p>`
    : '';
}

function _modeLabel(id) { return MODE_FLAT.find(m => m.id === id)?.label ?? id; }

export function togglePanel() {
  _state.panelOpen = !_state.panelOpen;
  document.getElementById('fw-panel')?.classList.toggle('open', _state.panelOpen);
  if (_state.panelOpen) {
    // Release pointer lock so mouse can reach the panel controls
    if (document.exitPointerLock) document.exitPointerLock();
  } else if (_state.mode === 'play' && window.gameStarted) {
    // Re-acquire pointer lock when panel closes and we're in Play
    const canvas = document.getElementById('canvas');
    if (canvas) canvas.requestPointerLock();
  }
}

function _toggleHelp() {
  _state.helpOpen = !_state.helpOpen;
  document.getElementById('fw-help')?.classList.toggle('hidden', !_state.helpOpen);
}
function _closeHelp() {
  _state.helpOpen = false;
  document.getElementById('fw-help')?.classList.add('hidden');
}

export function updateSceneSummary(parts) {
  const el = document.getElementById('fw-scene-summary');
  if (!el) return;
  const items = Object.entries(parts).filter(([,v]) => v > 0)
    .map(([k,v]) => `${v} ${k}${v > 1 ? 's' : ''}`);
  el.textContent = items.length ? items.join(', ') : 'Empty scene';
}

// ── Keyboard ───────────────────────────────────────────────────────
function _bindKeys() {
  document.addEventListener('keydown', e => {
    const active = document.activeElement;
    const inInput = active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA');

    // Shift+Enter — toggle panel
    if (e.key === 'Enter' && e.shiftKey) { e.preventDefault(); togglePanel(); return; }

    // H — help
    if ((e.key === 'h' || e.key === 'H') && !inInput) { _toggleHelp(); return; }

    // Shift+P — playtest from cursor
    if (e.key === 'P' && e.shiftKey && _state.mode !== 'play') {
      e.preventDefault();
      const cursor = window.__editorCursorWorld;
      if (cursor && window.Module?._teleportPlayer) Module._teleportPlayer(cursor.x, cursor.y + 2, cursor.z);
      switchMode('play');
      return;
    }

    // Ctrl+Z — undo
    if (e.key === 'z' && (e.ctrlKey || e.metaKey) && !e.shiftKey && !inInput) {
      e.preventDefault(); History.undo(); return;
    }
    // Ctrl+Shift+Z / Ctrl+Y — redo
    if (((e.key === 'z' && e.shiftKey) || e.key === 'y') && (e.ctrlKey || e.metaKey) && !inInput) {
      e.preventDefault(); History.redo(); return;
    }
    // Ctrl+S — save
    if (e.key === 's' && (e.ctrlKey || e.metaKey) && !e.shiftKey) {
      e.preventDefault(); MapManager.saveMap(); return;
    }
    // Ctrl+Shift+S — save as
    if (e.key === 'S' && e.shiftKey && (e.ctrlKey || e.metaKey)) {
      e.preventDefault(); MapManager.saveMapAs(); return;
    }
    // G — cycle snap
    if ((e.key === 'g' || e.key === 'G') && !inInput && _state.mode !== 'play') {
      Snap.cycle(); return;
    }
    // F1-F4 — recall bookmarks; Shift+F1-F4 — save
    if (e.key >= 'F1' && e.key <= 'F4' && _state.mode !== 'play') {
      const idx = parseInt(e.key[1]) - 1;
      if (e.shiftKey) CameraBookmarks.save(idx);
      else            CameraBookmarks.recall(idx);
      return;
    }
    // Delete / Backspace — delete selection
    if ((e.key === 'Delete' || e.key === 'Backspace') && !inInput) {
      Selection.deleteSelected(); return;
    }
  });

  // Snap modifier
  document.addEventListener('keydown', e => { if (e.key === 'Shift') Snap.suppress(true); });
  document.addEventListener('keyup',   e => { if (e.key === 'Shift') Snap.suppress(false); });

  // Orbit ctrl tick
  window.__shellTick = () => { if (_state.orbitCtrl) _state.orbitCtrl.update(); };
}

// ── Log ────────────────────────────────────────────────────────────
export function log(msg, cls = '') {
  const el = document.getElementById('fw-log');
  if (!el) { console.log('[Shell]', msg); return; }
  const line = document.createElement('div');
  line.className = `fw-log-line${cls ? ' ' + cls : ''}`;
  const t = new Date();
  const ts = `${String(t.getHours()).padStart(2,'0')}:${String(t.getMinutes()).padStart(2,'0')}:${String(t.getSeconds()).padStart(2,'0')}`;
  line.textContent = `[${ts}] ${msg}`;
  el.appendChild(line);
  while (el.children.length > 6) el.removeChild(el.firstChild);
}

// ── Slider primitive ───────────────────────────────────────────────
export function makeSlider({ label, value, min, max, step, unit = '', fmt = v => v.toFixed(1), onChange, container }) {
  const wrap = document.createElement('div');
  wrap.className = 'fw-slider-wrap';
  wrap.innerHTML = `
    <div class="fw-slider-label-row">
      <span class="fw-slider-label">${label}</span>
      <span class="fw-slider-value"><span class="fw-sv">${fmt(value)}</span>${unit ? `<span class="fw-slider-unit"> ${unit}</span>` : ''}</span>
    </div>
    <div class="fw-slider-track">
      <div class="fw-slider-rail"></div>
      <div class="fw-slider-fill" style="width:${((value-min)/(max-min))*100}%"></div>
      <input class="fw-slider-input" type="range" min="${min}" max="${max}" step="${step}" value="${value}" aria-label="${label}">
      <div class="fw-slider-thumb" style="left:${((value-min)/(max-min))*100}%"></div>
    </div>`;
  const inp  = wrap.querySelector('input');
  const fill = wrap.querySelector('.fw-slider-fill');
  const tmb  = wrap.querySelector('.fw-slider-thumb');
  const sv   = wrap.querySelector('.fw-sv');
  inp.addEventListener('input', () => {
    const v = parseFloat(inp.value), f = (v-min)/(max-min);
    fill.style.width = tmb.style.left = `${f*100}%`;
    sv.textContent = fmt(v);
    onChange?.(v);
  });
  if (container) container.appendChild(wrap);
  return wrap;
}
