/**
 * Tune mode — live game-balance sliders.
 * Ports the existing physics/camera sliders into the shell palette.
 */
import { makeSlider, log } from './shell.js';

const _tune = {
  gravity:    20,
  jetForce:   1.0,
  jetEnergy:  1.0,
  friction:   1.0,
  speed:      1.0,
  kickback:   1.0,
};

export const EditorTuning = { buildPalette, onEnter, onExit };

function onEnter() {}
function onExit() {}

function buildPalette(root) {
  const body = root;
  root.innerHTML = ''; // clear on each mount

  const sliderDefs = [
    { key: 'gravity',   label: 'Gravity',      min: 5,   max: 40,  step: 0.5, unit: 'm/s²', fmt: v => v.toFixed(1) },
    { key: 'jetForce',  label: 'Jet force',     min: 0.2, max: 3.0, step: 0.05, unit: '×',   fmt: v => v.toFixed(2) },
    { key: 'jetEnergy', label: 'Energy drain',  min: 0.1, max: 3.0, step: 0.05, unit: '×',   fmt: v => v.toFixed(2) },
    { key: 'friction',  label: 'Ground friction',min: 0.1, max: 2.0, step: 0.05, unit: '×',  fmt: v => v.toFixed(2) },
    { key: 'speed',     label: 'Speed',         min: 0.2, max: 3.0, step: 0.05, unit: '×',   fmt: v => v.toFixed(2) },
    { key: 'kickback',  label: 'Kickback',       min: 0.1, max: 5.0, step: 0.1,  unit: '×',  fmt: v => v.toFixed(1) },
  ];

  sliderDefs.forEach(def => {
    makeSlider({
      label:  def.label,
      value:  _tune[def.key],
      min:    def.min, max: def.max, step: def.step,
      unit:   def.unit, fmt: def.fmt,
      container: body,
      onChange: v => {
        _tune[def.key] = v;
        _apply();
      },
    });
  });

  // Reset button
  const sep = document.createElement('div'); sep.className = 'fw-separator';
  body.appendChild(sep);
  const btn = document.createElement('button');
  btn.className = 'fw-btn'; btn.textContent = 'Reset to defaults';
  btn.addEventListener('click', () => {
    Object.assign(_tune, { gravity:20, jetForce:1, jetEnergy:1, friction:1, speed:1, kickback:1 });
    _apply();
    // Rebuild sliders to reflect reset values
    body.innerHTML = '';
    buildPalette(root);
    log('Physics reset to defaults');
  });
  body.appendChild(btn);
}

function _apply() {
  if (!window.Module?._setPhysicsTuning) return;
  Module._setPhysicsTuning(
    _tune.gravity, _tune.jetForce, _tune.jetEnergy,
    _tune.friction, _tune.speed, _tune.kickback
  );
}
