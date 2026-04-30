/**
 * Bindings mode — connect events to VFX presets and audio events without code.
 * Twelfth mode, per Integration Plan §6.7.
 */
import { log } from './shell.js';

const DEFAULT_BINDINGS = [
  { event_id: 'disc_launcher.on_fire',   reactions: [] },
  { event_id: 'disc_launcher.on_impact', reactions: [] },
  { event_id: 'chaingun.on_fire',        reactions: [] },
  { event_id: 'mortar.on_fire',          reactions: [] },
  { event_id: 'mortar.on_impact',        reactions: [] },
  { event_id: 'player.on_land',          reactions: [] },
  { event_id: 'player.on_jump',          reactions: [] },
  { event_id: 'flag.on_capture',         reactions: [] },
  { event_id: 'flag.on_pickup',          reactions: [] },
];

const _bindings = DEFAULT_BINDINGS.map(b => ({ ...b, reactions: [...b.reactions] }));
let _activeIdx  = 0;

export const EditorBindings = { buildPalette, onEnter, onExit };

function onEnter() {}
function onExit()  {}

function buildPalette(root) {
  const body   = root.querySelector('#fw-palette-body-edit-bindings');
  const footer = root.querySelector('#fw-palette-footer-edit-bindings');
  if (!body) return;
  footer.textContent = 'Click an event, then drag a sound or effect onto it.';

  _renderBindings(body);
}

function _renderBindings(body) {
  body.innerHTML = `<div class="fw-section-label">Events</div>`;
  _bindings.forEach((binding, idx) => {
    const label = _friendlyLabel(binding.event_id);
    const item  = document.createElement('div');
    item.className = 'fw-asset-item' + (idx === _activeIdx ? ' active' : '');
    item.innerHTML = `
      <span class="fw-asset-icon">⚡</span>
      <div style="flex:1">
        <div class="fw-asset-label">${label}</div>
        <div style="font-size:10px;color:var(--ink-faint)">${
          binding.reactions.length
            ? binding.reactions.map(r => r.kind + ':' + r.preset_id).join(', ')
            : 'No reactions yet'
        }</div>
      </div>`;
    item.addEventListener('click', () => {
      _activeIdx = idx;
      _renderBindings(body);
      _showInspector(body, idx);
    });
    body.appendChild(item);
  });

  if (_activeIdx < _bindings.length) _showInspector(body, _activeIdx);
}

function _showInspector(body, idx) {
  let insp = document.getElementById('fw-binding-inspector');
  if (!insp) {
    insp = document.createElement('div');
    insp.id = 'fw-binding-inspector';
    insp.style.cssText = 'margin-top:8px;padding:8px;border:1px solid var(--hairline);border-radius:2px;';
    body.appendChild(insp);
  }
  const b = _bindings[idx];
  const label = _friendlyLabel(b.event_id);
  insp.innerHTML = `
    <div style="font-size:11px;font-weight:500;color:var(--ink-dim);margin-bottom:6px">${label}</div>
    <div style="font-size:10px;color:var(--ink-faint);margin-bottom:8px">Reactions (drag effects or sounds here):</div>
    ${b.reactions.map((r,ri) => `
      <div style="display:flex;align-items:center;gap:6px;margin-bottom:4px;font-size:11px">
        <span>${r.kind === 'vfx' ? '💥' : '🔊'} ${r.preset_id}</span>
        <span style="color:var(--ink-faint)">${r.delay_ms}ms</span>
        <button onclick="window.__bindingRemove(${idx},${ri})" style="margin-left:auto;background:none;border:none;color:var(--brick);cursor:pointer;font-size:11px">✕</button>
      </div>`).join('')}
    <div style="display:flex;gap:5px;margin-top:6px">
      <button class="fw-btn" id="fw-add-vfx" style="flex:1">+ Effect</button>
      <button class="fw-btn" id="fw-add-audio" style="flex:1">+ Sound</button>
      <button class="fw-btn" id="fw-test-binding">▶ Test</button>
    </div>`;

  window.__bindingRemove = (bi, ri) => {
    _bindings[bi].reactions.splice(ri, 1);
    _renderBindings(body);
  };

  insp.querySelector('#fw-add-vfx').addEventListener('click', () => {
    const pid = prompt('Effect preset id (e.g. explosion, muzzle, spark):');
    if (!pid) return;
    b.reactions.push({ kind:'vfx', preset_id:pid.trim(), delay_ms:0 });
    _renderBindings(body);
    log(`Added VFX reaction to "${label}"`);
  });
  insp.querySelector('#fw-add-audio').addEventListener('click', () => {
    const pid = prompt('Audio event id (e.g. WPN_FIRE_DISC):');
    if (!pid) return;
    b.reactions.push({ kind:'audio', preset_id:pid.trim(), delay_ms:0 });
    _renderBindings(body);
    log(`Added audio reaction to "${label}"`);
  });
  insp.querySelector('#fw-test-binding').addEventListener('click', () => {
    log(`Testing "${label}" — ${b.reactions.length} reaction(s)`);
    b.reactions.forEach(r => {
      if (r.kind === 'vfx') {
        const cam = window.__editorCamera;
        if (cam && window.triggerExplosion) {
          const pos = cam.position;
          setTimeout(() => { try { window.triggerExplosion(pos.x, pos.y, pos.z, 0.5); } catch(e) {} }, r.delay_ms);
        }
      }
    });
  });

  // Export
  let exportBtn = document.getElementById('fw-bindings-export');
  if (!exportBtn) {
    exportBtn = document.createElement('button');
    exportBtn.id = 'fw-bindings-export';
    exportBtn.className = 'fw-btn primary';
    exportBtn.style.cssText = 'width:100%;margin-top:8px';
    exportBtn.textContent = 'Export bindings.json';
    exportBtn.addEventListener('click', _export);
    body.appendChild(exportBtn);
  }
}

function _friendlyLabel(id) {
  return id
    .replace(/_/g,' ').replace(/\./g,' — ')
    .replace(/\b\w/g, c => c.toUpperCase());
}

function _export() {
  const data = { _format:'firewolf-bindings-v1', bindings: _bindings.filter(b=>b.reactions.length>0) };
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify(data,null,2)],{type:'application/json'}));
  a.download = 'bindings.json'; document.body.appendChild(a); a.click(); a.remove();
  log('Bindings exported');
}
