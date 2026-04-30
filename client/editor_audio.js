/**
 * Sound mode — preview and tune game audio events.
 */
import { makeSlider, log } from './shell.js';

const EVENTS = [
  { id: 'WPN_FIRE_DISC',    label: 'Disc launcher fired' },
  { id: 'WPN_FIRE_CHAIN',   label: 'Chaingun fired' },
  { id: 'WPN_FIRE_PLASMA',  label: 'Plasma gun fired' },
  { id: 'WPN_FIRE_MORTAR',  label: 'Mortar fired' },
  { id: 'EXPL_DISC',        label: 'Disc explosion' },
  { id: 'EXPL_MORTAR',      label: 'Mortar explosion' },
  { id: 'PLR_JUMP',         label: 'Player jumped' },
  { id: 'PLR_LAND',         label: 'Player landed' },
  { id: 'PLR_SKI',          label: 'Player skiing' },
  { id: 'PLR_JET',          label: 'Player jetting' },
  { id: 'FLAG_PICKUP',      label: 'Flag picked up' },
  { id: 'FLAG_CAPTURE',     label: 'Flag captured' },
];

const _settings = {};
EVENTS.forEach(e => { _settings[e.id] = { volume: 0.8, pitch: 1.0, falloff: 30 }; });

let _activeEvent = null;

export const EditorAudio = { buildPalette, onEnter, onExit };

function onEnter() {}
function onExit() {}

function buildPalette(root) {
  const body   = root.querySelector('#fw-palette-body-edit-audio');
  const footer = root.querySelector('#fw-palette-footer-edit-audio');
  if (!body) return;
  footer.textContent = 'Pick a sound and hit play to hear it.';

  body.innerHTML = `<div class="fw-section-label">Sound events</div>`;
  EVENTS.forEach(ev => {
    const item = document.createElement('div');
    item.className = 'fw-asset-item';
    item.dataset.id = ev.id;
    item.innerHTML = `<span class="fw-asset-icon">🔊</span><span class="fw-asset-label">${ev.label}</span>`;
    item.addEventListener('click', () => {
      _activeEvent = ev.id;
      _refreshList();
      _showSliders(root, ev.id);
    });
    body.appendChild(item);
  });

  const sep = document.createElement('div'); sep.className = 'fw-separator';
  body.appendChild(sep);

  const sliderArea = document.createElement('div');
  sliderArea.id = 'fw-audio-sliders';
  body.appendChild(sliderArea);

  const exportBtn = document.createElement('button');
  exportBtn.className = 'fw-btn primary'; exportBtn.textContent = 'Export audio_events.json';
  exportBtn.addEventListener('click', _export);
  body.appendChild(exportBtn);
}

function _refreshList() {
  document.querySelectorAll('#fw-palette-body-edit-audio .fw-asset-item').forEach(el => {
    el.classList.toggle('active', el.dataset.id === _activeEvent);
  });
}

function _showSliders(root, id) {
  const area = document.getElementById('fw-audio-sliders');
  if (!area) return;
  area.innerHTML = '';
  const s = _settings[id];

  makeSlider({ label:'Volume', value:s.volume, min:0, max:1, step:0.01, unit:'', fmt:v=>v.toFixed(2), container:area,
    onChange: v => { s.volume = v; } });
  makeSlider({ label:'Pitch',  value:s.pitch,  min:0.5, max:2, step:0.05, unit:'×', fmt:v=>v.toFixed(2), container:area,
    onChange: v => { s.pitch = v; } });
  makeSlider({ label:'Falloff',value:s.falloff,min:1, max:100, step:1, unit:'m', fmt:v=>v.toFixed(0), container:area,
    onChange: v => { s.falloff = v; } });

  const playBtn = document.createElement('button');
  playBtn.className = 'fw-btn'; playBtn.textContent = '▶ Preview';
  playBtn.addEventListener('click', () => {
    // Attempt to play via existing audio engine
    if (window.AE?.ctx) {
      try {
        const osc = window.AE.ctx.createOscillator();
        const gain = window.AE.ctx.createGain();
        osc.frequency.value = 440 * s.pitch;
        gain.gain.value = s.volume * 0.3;
        osc.connect(gain); gain.connect(window.AE.ctx.destination);
        osc.start(); osc.stop(window.AE.ctx.currentTime + 0.15);
      } catch(e) {}
    }
    log(`Previewed: ${EVENTS.find(e=>e.id===id)?.label ?? id}`);
  });
  area.appendChild(playBtn);
}

function _export() {
  const data = { _format:'firewolf-audio-v1', events: Object.entries(_settings).map(([id,s]) => ({id,...s})) };
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify(data,null,2)],{type:'application/json'}));
  a.download = 'audio_events.json'; document.body.appendChild(a); a.click(); a.remove();
  log('Audio events exported');
}
