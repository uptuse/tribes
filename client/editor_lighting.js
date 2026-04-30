/**
 * Light mode — adjust sun, ambient, fog, terrain, and asset lighting live.
 */
import { makeSlider, log } from './shell.js';

export const EditorLighting = { buildPalette, onEnter, onExit };

function onEnter() {}
function onExit()  {}

function buildPalette(root) {
  root.innerHTML = '';

  const L = window.__lights;
  if (!L) {
    root.innerHTML = '<p style="font-size:11px;color:var(--ink-faint);padding:8px">Lights not ready yet — switch to Play once then come back.</p>';
    return;
  }

  // ── Sun ───────────────────────────────────────────────────
  _section(root, 'Sun');
  makeSlider({ label:'Intensity', value:L.sun?.intensity??1.8, min:0, max:5, step:0.05, unit:'×',
    fmt:v=>v.toFixed(2), container:root,
    onChange:v=>{ if(L.sun) L.sun.intensity=v; } });

  // Sun azimuth (horizontal angle)
  let _sunAz = 45, _sunEl = 45;
  makeSlider({ label:'Azimuth', value:_sunAz, min:0, max:360, step:1, unit:'°',
    fmt:v=>v.toFixed(0), container:root,
    onChange:v=>{ _sunAz=v; _setSunPos(_sunAz,_sunEl,L); } });
  makeSlider({ label:'Elevation', value:_sunEl, min:5, max:90, step:1, unit:'°',
    fmt:v=>v.toFixed(0), container:root,
    onChange:v=>{ _sunEl=v; _setSunPos(_sunAz,_sunEl,L); } });

  // Sun colour temperature (warm↔cool)
  const sunTempRow = document.createElement('div');
  sunTempRow.style.cssText = 'display:flex;align-items:center;gap:8px;margin-bottom:10px;';
  sunTempRow.innerHTML = `
    <span class="fw-slider-label" style="flex:1">Colour</span>
    <div style="display:flex;gap:4px">
      ${[['Dawn','#ffb06a'],['Noon','#fff9e8'],['Dusk','#ff8c42'],['Night','#8899cc']].map(
        ([n,c]) => `<button class="fw-btn" title="${n}" data-sun-col="${c}"
          style="width:22px;height:22px;padding:0;background:${c};border:1px solid var(--hairline);border-radius:2px"></button>`
      ).join('')}
    </div>`;
  sunTempRow.querySelectorAll('[data-sun-col]').forEach(btn => {
    btn.addEventListener('click', () => {
      if (L.sun) L.sun.color.set(btn.dataset.sunCol);
      log(`Sun colour: ${btn.title}`);
    });
  });
  root.appendChild(sunTempRow);

  // ── Sky / Ambient ─────────────────────────────────────────
  _section(root, 'Sky & Ambient');
  makeSlider({ label:'Sky intensity', value:L.hemi?.intensity??1.5, min:0, max:4, step:0.05, unit:'×',
    fmt:v=>v.toFixed(2), container:root,
    onChange:v=>{ if(L.hemi) L.hemi.intensity=v; } });

  // Fog density
  const fogDensity = L.scene?.fog?.density ?? 0.0022;
  makeSlider({ label:'Fog density', value:fogDensity*1000, min:0, max:20, step:0.1, unit:'×0.001',
    fmt:v=>v.toFixed(1), container:root,
    onChange:v=>{ if(L.scene?.fog) L.scene.fog.density=v*0.001; } });

  // ── Terrain ───────────────────────────────────────────────
  _section(root, 'Terrain');
  const terrain = window.__terrainMesh;
  const terrainMat = terrain?.material;
  const terrainShader = terrainMat?.userData?.shader;

  makeSlider({ label:'Brightness', value:1.0, min:0.2, max:3, step:0.05, unit:'×',
    fmt:v=>v.toFixed(2), container:root,
    onChange:v=>{
      if(terrainMat){ terrainMat.color?.multiplyScalar(0); }
      if(terrainShader?.uniforms?.uBrightness) terrainShader.uniforms.uBrightness.value=v;
      else if(terrainMat) terrainMat.color?.setScalar(v*0.5);
    } });

  makeSlider({ label:'Emissive', value:0, min:0, max:1, step:0.02, unit:'',
    fmt:v=>v.toFixed(2), container:root,
    onChange:v=>{
      if(terrainMat?.emissiveIntensity !== undefined) terrainMat.emissiveIntensity=v;
    } });

  // ── Buildings & Assets ────────────────────────────────────
  _section(root, 'Buildings & Assets');
  makeSlider({ label:'Emissive', value:0.15, min:0, max:2, step:0.05, unit:'×',
    fmt:v=>v.toFixed(2), container:root,
    onChange:v=>{ _setGroupEmissive(v); } });

  makeSlider({ label:'Roughness', value:0.5, min:0, max:1, step:0.02, unit:'',
    fmt:v=>v.toFixed(2), container:root,
    onChange:v=>{ _setGroupRoughness(v); } });

  // ── Night light ───────────────────────────────────────────
  _section(root, 'Moon / Night');
  makeSlider({ label:'Moon intensity', value:L.moon?.intensity??0, min:0, max:2, step:0.05, unit:'×',
    fmt:v=>v.toFixed(2), container:root,
    onChange:v=>{ if(L.moon) L.moon.intensity=v; } });

  // Reset button
  const sep = document.createElement('div'); sep.className = 'fw-separator'; root.appendChild(sep);
  const resetBtn = document.createElement('button');
  resetBtn.className = 'fw-btn';
  resetBtn.textContent = 'Reset to defaults';
  resetBtn.addEventListener('click', () => {
    if(L.sun)  { L.sun.intensity=1.8;  L.sun.color.set(0x999999); }
    if(L.hemi) { L.hemi.intensity=1.5; }
    if(L.scene?.fog) L.scene.fog.density=0.0022;
    if(L.moon) L.moon.intensity=0;
    buildPalette(root); // rebuild sliders to reflect reset values
    log('Lighting reset to defaults');
  });
  root.appendChild(resetBtn);

  const note = document.createElement('p');
  note.style.cssText = 'font-size:10px;color:var(--ink-faint);margin-top:6px;line-height:1.5';
  note.textContent = 'Changes apply live. Switch to Play to see the full effect under the day/night cycle.';
  root.appendChild(note);
}

// ── Helpers ────────────────────────────────────────────────
function _section(root, label) {
  const el = document.createElement('div');
  el.className = 'fw-section-label';
  el.textContent = label;
  root.appendChild(el);
}

function _setSunPos(azDeg, elDeg, L) {
  if (!L?.sun) return;
  const az = azDeg * Math.PI / 180;
  const el = elDeg * Math.PI / 180;
  const dist = 500;
  L.sun.position.set(
    Math.cos(el) * Math.sin(az) * dist,
    Math.sin(el) * dist,
    Math.cos(el) * Math.cos(az) * dist
  );
  if (L.sun.target) L.sun.target.position.set(0, 0, 0);
}

function _setGroupEmissive(v) {
  const scene = window.__lights?.scene;
  if (!scene) return;
  scene.traverse(obj => {
    if (!obj.isMesh || !obj.material) return;
    if (obj === window.__terrainMesh) return;
    const mat = Array.isArray(obj.material) ? obj.material : [obj.material];
    mat.forEach(m => { if (m.emissiveIntensity !== undefined) m.emissiveIntensity = v; });
  });
}

function _setGroupRoughness(v) {
  const scene = window.__lights?.scene;
  if (!scene) return;
  scene.traverse(obj => {
    if (!obj.isMesh || !obj.material) return;
    if (obj === window.__terrainMesh) return;
    const mat = Array.isArray(obj.material) ? obj.material : [obj.material];
    mat.forEach(m => { if (m.roughness !== undefined) m.roughness = v; });
  });
}
