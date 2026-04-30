/**
 * Firewolf Shell — mode switcher, top bar, panel, help card.
 * Milestone 1: mode switching + camera detach.
 * Subsequent modes register via Shell.registerMode(id, module).
 */
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

// ── State ──────────────────────────────────────────────────────────
const _state = {
  mode:        'play',
  panelOpen:   false,
  helpOpen:    true,   // show help card on first load
  orbitCtrl:   null,
  savedCamPos: null,
  savedCamRot: null,
};

// Registered mode modules { id → { onEnter, onExit, palette? } }
const _modes = {};

// Scene / camera refs (set by init)
let _camera, _renderer, _scene;

// ── Public API ─────────────────────────────────────────────────────
export const Shell = {
  init,
  registerMode,
  switchMode,
  log,
  getMode: () => _state.mode,
  isPanelOpen: () => _state.panelOpen,
};
window.__shell = Shell;

// ── Mode definitions (labels + body copy verbatim from prototype) ──
const MODE_ROWS = [
  [
    { id: 'play',             label: 'Play',     desc: "You're in the game. Click to look around, WASD to move.",                          tip: "Open this panel any time with Shift+Enter to switch modes." },
    { id: 'edit-assets',      label: 'Place',    desc: "Pick something from the list on the left, then click the ground to drop it.",      tip: "Right-drag to look around. Wheel to zoom." },
    { id: 'edit-buildings',   label: 'Build',    desc: "Pick a wall or floor on the left, then click to place. Press R to rotate before clicking.", tip: "Pieces snap together on a 4-metre grid." },
    { id: 'edit-terrain',     label: 'Sculpt',   desc: "Pick a brush on the left, then drag the ground to push it up, down, or smooth. Shift inverts.", tip: "[ and ] resize the brush. Ctrl+Z to undo." },
    { id: 'edit-animations',  label: 'Animate',  desc: "Pick a clip on the left and scrub the timeline to preview it.",                   tip: "Changes apply live to the character in the scene." },
    { id: 'edit-materials',   label: 'Paint',    desc: "Pick a colour on the left, then click any wall to recolour it.",                   tip: "Six colours to start." },
  ],
  [
    { id: 'edit-tuning',      label: 'Tune',     desc: "Drag any slider to tune the game — damage, gravity, match length, and more.",     tip: "Changes apply live. Switch back to Play to feel the difference." },
    { id: 'edit-triggers',    label: 'Triggers', desc: "Pick what should happen, then click the ground to mark a spot. Walk into it in Play to fire it.", tip: "Use the slider to make the spot bigger or smaller." },
    { id: 'edit-audio',       label: 'Sound',    desc: "Pick a sound and hit play to hear it. Drag the sliders to tune it.",              tip: "Sounds preview through your speakers." },
    { id: 'edit-vfx',         label: 'Effects',  desc: "Pick an effect, then click the ground to set one off. It fades on its own.",      tip: "Try Test Fire to drop one in front of you." },
    { id: 'edit-ai',          label: 'Bots',     desc: "Pick what the bot should do, then click the ground to drop it.",                  tip: "Patrol walks a route. Guard stays close. Capture flag heads for the flag." },
    { id: 'edit-bindings',    label: 'Bindings', desc: "Connect events to sounds and effects without writing code.",                      tip: "Click an event on the left, then drag a sound or effect tile onto it." },
  ],
];
const MODE_FLAT = MODE_ROWS.flat();

// ── Init ───────────────────────────────────────────────────────────
function init(camera, renderer, scene) {
  _camera   = camera;
  _renderer = renderer;
  _scene    = scene;

  _buildDOM();
  _bindKeys();
  log('Editor ready — Shift+Enter to open', 'amber');
}

// ── Mode registration ──────────────────────────────────────────────
function registerMode(id, mod) {
  _modes[id] = mod;
  if (mod.buildPalette) {
    const pal = document.getElementById(`fw-palette-${id}`);
    if (pal) mod.buildPalette(pal);
  }
}

// ── Mode switching ─────────────────────────────────────────────────
function switchMode(newMode) {
  if (newMode === _state.mode) return;
  const prev = _state.mode;

  // --- exit previous mode ---
  if (prev !== 'play' && _modes[prev]?.onExit) _modes[prev].onExit();
  if (prev !== 'play') _leavePalette(prev);

  _state.mode = newMode;

  if (newMode === 'play') {
    _resumePlay();
  } else {
    if (prev === 'play') _enterEdit();
    _enterPalette(newMode);
    if (_modes[newMode]?.onEnter) _modes[newMode].onEnter();
  }

  _updateTopBar();
  _updateModeGrid();
  _updatePanelBody();
  log(`Switched to ${_modeLabel(newMode)}`);
}

function _enterEdit() {
  // Pause physics
  if (window.Module?._pause) Module._pause(1);
  window.isEditing = true;

  // Release pointer lock
  if (document.exitPointerLock) document.exitPointerLock();

  // Save camera pose
  _state.savedCamPos = _camera.position.clone();
  _state.savedCamRot = _camera.rotation.clone();

  // Detach from player, attach OrbitControls
  if (_camera.parent) _camera.parent.remove(_camera);
  _scene.add(_camera);

  _state.orbitCtrl = new OrbitControls(_camera, _renderer.domElement);
  _state.orbitCtrl.enableDamping = true;
  _state.orbitCtrl.dampingFactor = 0.1;
  _state.orbitCtrl.screenSpacePanning = true;
  _state.orbitCtrl.mouseButtons = {
    LEFT: null,        // L-click reserved for placement
    MIDDLE: 1,         // middle drag = pan
    RIGHT: 0,          // right drag = orbit
  };
  _state.orbitCtrl.touches = { ONE: null, TWO: 2 }; // pinch to zoom

  // Expose orbit camera for mode editors
  window.__editorCamera     = _camera;
  window.__editorOrbitCtrl  = _state.orbitCtrl;
}

function _resumePlay() {
  // Dispose OrbitControls
  if (_state.orbitCtrl) {
    _state.orbitCtrl.dispose();
    _state.orbitCtrl = null;
    window.__editorOrbitCtrl = null;
  }

  // Re-attach camera to player viewmodel (weaponHand parent)
  // The renderer's syncCamera() will re-acquire it on the next frame.
  window.isEditing = false;
  if (window.Module?._pause) Module._pause(0);

  // Request pointer lock
  const canvas = document.getElementById('canvas');
  if (window.gameStarted && canvas) canvas.requestPointerLock();
}

function _enterPalette(id) {
  document.querySelectorAll('.fw-palette').forEach(p => p.classList.remove('open'));
  const pal = document.getElementById(`fw-palette-${id}`);
  if (pal) pal.classList.add('open');
}
function _leavePalette(id) {
  const pal = document.getElementById(`fw-palette-${id}`);
  if (pal) pal.classList.remove('open');
}

// ── DOM construction ───────────────────────────────────────────────
function _buildDOM() {
  const root = document.getElementById('fw-shell') || (() => {
    const d = document.createElement('div');
    d.id = 'fw-shell';
    document.body.appendChild(d);
    return d;
  })();

  root.innerHTML = `
    ${_buildTopBar()}
    ${_buildPanel()}
    ${_buildHelp()}
    ${_buildPalettes()}
    ${_buildLog()}
    ${_buildTimeline()}
  `;

  // Wire top bar buttons
  root.querySelector('#fw-btn-help').addEventListener('click', _toggleHelp);
  root.querySelector('#fw-btn-panel').addEventListener('click', togglePanel);

  // Wire help card
  root.querySelector('#fw-help-close').addEventListener('click', _closeHelp);
  root.querySelector('#fw-help-start').addEventListener('click', _closeHelp);

  // Wire mode tiles
  root.querySelectorAll('.fw-mode-tile').forEach(tile => {
    tile.addEventListener('click', () => switchMode(tile.dataset.id));
  });

  // Wire clear button
  root.querySelector('#fw-btn-clear').addEventListener('click', _clearScene);

  // Orbit controls tick (needs update each frame)
  const origRAF = window.requestAnimationFrame;
  function patchLoop() {
    if (_state.orbitCtrl) _state.orbitCtrl.update();
  }
  window.__shellTick = patchLoop;
}

function _buildTopBar() {
  return `
  <div id="fw-topbar">
    <div class="fw-topbar-inner">
      <div class="fw-topbar-left">
        <div class="fw-wordmark">
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

  return `
  <div id="fw-panel">
    <div class="fw-panel-inner fw-panel">
      <div class="fw-panel-header">
        <span class="fw-panel-title">Editor</span>
        <button class="fw-topbar-btn" onclick="window.__shell.switchMode('play')" aria-label="Close panel" title="Switch to Play">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6 6 18M6 6l12 12"/></svg>
        </button>
      </div>
      <div class="fw-mode-grid">${rows}</div>
      <div class="fw-mode-body" id="fw-mode-body"></div>
      <div class="fw-panel-footer">
        <span class="fw-scene-summary" id="fw-scene-summary">Empty scene</span>
        <button class="fw-btn-clear" id="fw-btn-clear">Clear</button>
      </div>
    </div>
  </div>`;
}

function _buildHelp() {
  return `
  <div id="fw-help">
    <div class="fw-help-card fw-panel">
      <div class="fw-help-header">
        <div class="fw-wordmark">
          firewolf
          <svg class="fw-wordmark-triangle" width="7" height="7" viewBox="0 0 10 10" aria-hidden="true">
            <polygon points="5,0.5 9,9 1,9" fill="var(--amber)"/>
          </svg>
        </div>
        <button id="fw-help-close" class="fw-topbar-btn" aria-label="Close">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6 6 18M6 6l12 12"/></svg>
        </button>
      </div>
      <div class="fw-help-body">
        <p class="fw-help-intro">
          Two modes. <strong>Play</strong> the game, or open the editor to <strong>change</strong> it.
          Switch any time with <span class="fw-mode-key">Shift Enter</span>.
        </p>
        <div class="fw-help-steps">
          <div class="fw-help-step"><span class="fw-step-num">1</span><span class="fw-step-text">Click the screen to start playing.</span></div>
          <div class="fw-help-step"><span class="fw-step-num">2</span><span class="fw-step-text">Press <span class="fw-mode-key">Shift Enter</span> and pick a mode — Place, Build, Paint, Bots, anything.</span></div>
          <div class="fw-help-step"><span class="fw-step-num">3</span><span class="fw-step-text">Click on the ground to use the tool. Switch back to Play to see your changes live.</span></div>
        </div>
        <div class="fw-help-keys">
          <span class="fw-mode-key">W A S D</span><span>Move</span>
          <span class="fw-mode-key">R</span><span>Rotate the piece you're about to place</span>
          <span class="fw-mode-key">H</span><span>Show this card again</span>
          <span class="fw-mode-key">Shift+P</span><span>Playtest from cursor</span>
          <span class="fw-mode-key">Esc</span><span>Release the mouse</span>
        </div>
      </div>
      <div class="fw-help-footer">
        <button id="fw-help-start" class="fw-btn-start">Start</button>
      </div>
    </div>
  </div>`;
}

function _buildPalettes() {
  return MODE_FLAT.filter(m => m.id !== 'play').map(m => `
    <div class="fw-palette fw-panel" id="fw-palette-${m.id}">
      <div class="fw-palette-header" id="fw-palette-header-${m.id}">${m.label}</div>
      <div class="fw-palette-body" id="fw-palette-body-${m.id}"></div>
      <div class="fw-palette-footer" id="fw-palette-footer-${m.id}">Click the ground to use the tool.</div>
    </div>`).join('');
}

function _buildLog() {
  return `<div id="fw-log"></div>`;
}

function _buildTimeline() {
  return `
  <div id="fw-timeline" class="fw-panel">
    <div class="fw-transport" id="fw-transport"></div>
    <div class="fw-tracks-area" id="fw-tracks-area"></div>
  </div>`;
}

// ── TopBar update ──────────────────────────────────────────────────
function _updateTopBar() {
  const badge = document.getElementById('fw-mode-badge');
  const sub   = document.getElementById('fw-edit-sub');
  if (!badge) return;
  const editing = _state.mode !== 'play';
  badge.textContent = _modeLabel(_state.mode);
  badge.className   = `fw-mode-badge ${editing ? 'edit' : 'play'}`;
  sub.style.display = editing ? '' : 'none';
}

function _updateModeGrid() {
  document.querySelectorAll('.fw-mode-tile').forEach(t => {
    t.classList.toggle('active', t.dataset.id === _state.mode);
  });
}

function _updatePanelBody() {
  const body = document.getElementById('fw-mode-body');
  if (!body) return;
  const m = MODE_FLAT.find(x => x.id === _state.mode);
  if (!m) return;
  body.innerHTML = `
    <p class="fw-mode-desc">${m.desc}</p>
    <p class="fw-mode-tip">${m.tip}</p>`;
}

// ── Helpers ────────────────────────────────────────────────────────
function _modeLabel(id) {
  return MODE_FLAT.find(m => m.id === id)?.label ?? id;
}

function togglePanel() {
  _state.panelOpen = !_state.panelOpen;
  document.getElementById('fw-panel')?.classList.toggle('open', _state.panelOpen);
}

function _toggleHelp() {
  _state.helpOpen = !_state.helpOpen;
  document.getElementById('fw-help')?.classList.toggle('hidden', !_state.helpOpen);
}
function _closeHelp() {
  _state.helpOpen = false;
  document.getElementById('fw-help')?.classList.add('hidden');
}

function _clearScene() {
  Object.values(_modes).forEach(m => m.clearScene?.());
  log('Scene cleared');
  _updateSceneSummary();
}

export function updateSceneSummary(parts) {
  const el = document.getElementById('fw-scene-summary');
  if (!el) return;
  const items = Object.entries(parts).filter(([,v]) => v > 0)
    .map(([k,v]) => `${v} ${k}${v > 1 ? 's' : ''}`);
  el.textContent = items.length ? items.join(', ') : 'Empty scene';
}
function _updateSceneSummary() { updateSceneSummary({}); }

export function log(msg, cls = '') {
  const el = document.getElementById('fw-log');
  if (!el) return;
  const line = document.createElement('div');
  line.className = `fw-log-line${cls ? ' ' + cls : ''}`;
  const t = new Date();
  const ts = `${String(t.getHours()).padStart(2,'0')}:${String(t.getMinutes()).padStart(2,'0')}:${String(t.getSeconds()).padStart(2,'0')}`;
  line.textContent = `[${ts}] ${msg}`;
  el.appendChild(line);
  // Keep last 6 lines
  while (el.children.length > 6) el.removeChild(el.firstChild);
}

// ── Keyboard bindings ──────────────────────────────────────────────
function _bindKeys() {
  document.addEventListener('keydown', e => {
    // Shift+Enter — toggle panel
    if (e.key === 'Enter' && e.shiftKey) {
      e.preventDefault();
      togglePanel();
      if (_state.panelOpen && _state.mode === 'play') {
        // Auto-open help if this is first time opening panel
      }
    }
    // H — help
    if (e.key === 'h' || e.key === 'H') {
      const activeEl = document.activeElement;
      if (activeEl && (activeEl.tagName === 'INPUT' || activeEl.tagName === 'TEXTAREA')) return;
      _toggleHelp();
    }
    // Shift+P — playtest from cursor
    if (e.key === 'P' && e.shiftKey && _state.mode !== 'play') {
      e.preventDefault();
      const cursor = window.__editorCursorWorld;
      if (cursor && window.Module?._teleportPlayer) {
        Module._teleportPlayer(cursor.x, cursor.y + 2, cursor.z);
      }
      switchMode('play');
    }
    // Escape — if panel open and in edit mode, switch to play
    if (e.key === 'Escape' && _state.mode !== 'play' && _state.panelOpen) {
      // Don't intercept — let the game handle Esc for its own menus
    }
  });
}

// ── Slider primitive ───────────────────────────────────────────────
export function makeSlider({ label, value, min, max, step, unit = '', fmt = v => v.toFixed(1), onChange, container }) {
  const t = () => (slider.value - min) / (max - min);

  const wrap = document.createElement('div');
  wrap.className = 'fw-slider-wrap';
  wrap.innerHTML = `
    <div class="fw-slider-label-row">
      <span class="fw-slider-label">${label}</span>
      <span class="fw-slider-value">
        <span class="fw-slider-val-text">${fmt(value)}</span>${unit ? `<span class="fw-slider-unit">${unit}</span>` : ''}
      </span>
    </div>
    <div class="fw-slider-track">
      <div class="fw-slider-rail"></div>
      <div class="fw-slider-fill" style="width:${t()*100}%"></div>
      <input class="fw-slider-input" type="range" min="${min}" max="${max}" step="${step}" value="${value}" aria-label="${label}">
      <div class="fw-slider-thumb" style="left:${t()*100}%"></div>
    </div>`;

  const slider = wrap.querySelector('input');
  const fill   = wrap.querySelector('.fw-slider-fill');
  const thumb  = wrap.querySelector('.fw-slider-thumb');
  const valEl  = wrap.querySelector('.fw-slider-val-text');

  slider.addEventListener('input', () => {
    const v = parseFloat(slider.value);
    const frac = (v - min) / (max - min);
    fill.style.width  = `${frac * 100}%`;
    thumb.style.left  = `${frac * 100}%`;
    valEl.textContent = fmt(v);
    onChange?.(v);
  });

  if (container) container.appendChild(wrap);
  return wrap;
}
