/**
 * Animate mode — clip library + timeline scrubber driven by the live character rig.
 *
 * Rendering stack: vanilla Three.js + THREE.AnimationMixer (same as renderer_characters.js).
 * Clip data format: THREE.AnimationClip objects extracted from the loaded GLB.
 * Skeleton loading: reuses renderer_characters.js Characters module — no separate scene.
 * Tweening: custom multi-track weighted slerp/lerp (ported verbatim from animation_editor.html).
 *   - Preserves weighted blending with upper/lower body masks.
 *   - _interpCache avoids recreating interpolants every frame.
 *   - evaluateTimeline() samples all active clips at currentTime and blends via slerp/lerp.
 *
 * Integration path: thin connector — drives the live Characters instance skeleton.
 * The game pauses physics (M1 _pause) but keeps rendering so edits are visible in context.
 */

import * as THREE from 'three';
import { log } from './shell.js';

// ── Live character connection ──────────────────────────────────────
// Provided by renderer_characters.js when a player instance is available.
let _skeleton    = null;   // THREE.Skeleton from the live player rig
let _boneMap     = {};     // sanitizedName → THREE.Bone
let _bindPose    = {};     // sanitizedName → {pos,quat,scale}
let _allClips    = {};     // clipName → THREE.AnimationClip

// ── Timeline state ─────────────────────────────────────────────────
let _currentTime = 0;
let _duration    = 0;
let _playing     = false;
let _playRAF     = null;
let _lastPlayT   = 0;

// Multi-track weighted blending (verbatim from animation_editor.html)
const _tracks = [];        // [{id, name, color, weight, mask, clips:[{id,clipName,startTime,endTime,trimStart}]}]
const _interpCache = new Map();  // "clipName:trackIdx" → interpolant
let _nextTrackId = 1;
let _nextClipId  = 1;

// Upper/lower body bone mask sets (sanitized names)
const _upperMask = new Set(['spine','chest','neck','head','shoulder','arm','forearm','hand','finger','thumb','index','middle','ring','pinky','clavicle','upperarm','lowerarm','wrist']);
const _lowerMask = new Set(['hip','pelvis','thigh','leg','foot','toe','knee','ankle','upperleg','lowerleg','calf']);
function _isUpper(n) { return [..._upperMask].some(k => n.toLowerCase().includes(k)); }
function _isLower(n) { return [..._lowerMask].some(k => n.toLowerCase().includes(k)); }

// ── Public API ──────────────────────────────────────────────────────
export const EditorAnimations = { buildPalette, onEnter, onExit, setCharacterRig };

// Called by renderer.js once the Characters module has loaded a rig
export function setCharacterRig(skeleton, clips) {
  _skeleton = skeleton;
  _allClips = {};
  clips.forEach(c => { _allClips[c.name] = c; });
  _boneMap  = {};
  if (skeleton) {
    skeleton.bones.forEach(b => { _boneMap[_sanitize(b.name)] = b; });
    _captureBindPose();
  }
  _duration = Math.max(...Object.values(_allClips).map(c => c.duration), 0);
  log(`Animation rig ready — ${Object.keys(_allClips).length} clips`);
}

function onEnter() {
  // Force the character to show in the scene even without 3P mode
  window.__characterPreview = true;
  _buildTimeline();
  document.getElementById('fw-timeline')?.classList.add('open');
  const panel = document.getElementById('fw-panel');
  if (panel) panel.style.paddingBottom = '225px';
  _updateTimecodeEl();
  // Re-wire rig now that forceShow is on and sync() will create the instance
  setTimeout(() => {
    const li  = window.Module?._getLocalPlayerIdx?.() ?? 0;
    const rig = window.__Characters?.getRig?.(li);
    if (rig) setCharacterRig(rig.skeleton, rig.clips);
  }, 800);
}

function onExit() {
  _stopPlayback();
  document.getElementById('fw-timeline')?.classList.remove('open');
  window.__characterPreview = false;
  const panel = document.getElementById('fw-panel');
  if (panel) panel.style.paddingBottom = '';
  if (_skeleton) _resetToBindPose();
}

function buildPalette(root) {
  const body = root;
  body.innerHTML = '';

  // Character picker — hardcoded list matches renderer_characters.js CHARACTER_MODELS
  const models = window.__characterModels ?? [
    { id: 'crimson_sentinel',  label: 'Crimson Sentinel'  },
    { id: 'auric_phoenix',     label: 'Auric Phoenix'     },
    { id: 'crimson_titan',     label: 'Crimson Titan'     },
    { id: 'wolf_sentinel',     label: 'Wolf Sentinel'     },
    { id: 'aegis_sentinel',    label: 'Aegis Sentinel'    },
    { id: 'crimson_warforged', label: 'Crimson Warforged' },
    { id: 'emerald_sentinel',  label: 'Emerald Sentinel'  },
    { id: 'golden_phoenix',    label: 'Golden Phoenix'    },
    { id: 'iron_wolf',         label: 'Iron Wolf'         },
    { id: 'midnight_sentinel', label: 'Midnight Sentinel' },
    { id: 'neon_wolf',         label: 'Neon Wolf'         },
    { id: 'obsidian_vanguard', label: 'Obsidian Vanguard' },
    { id: 'violet_phoenix',    label: 'Violet Phoenix'    },
  ];
  if (models.length > 1) {
    const sec = document.createElement('div'); sec.className = 'fw-section-label'; sec.textContent = 'Character'; body.appendChild(sec);
    models.forEach((m, idx) => {
      const item = document.createElement('div');
      item.className = 'fw-asset-item';
      item.dataset.id = m.id;
      item.innerHTML = `<span class="fw-asset-icon">🧍</span><span class="fw-asset-label">${m.label}</span>`;
      item.addEventListener('click', () => {
        if (window.__switchCharacter) {
          window.__switchCharacter(idx);
          log(`Character: ${m.label} — loading…`);
          // Re-wire rig from rendered instance once the new model loads
          const poll = setInterval(() => {
            const getRig = window.__Characters?.getRig ?? window.Characters?.getRig;
            if (!getRig) return;
            const li  = window.Module?._getLocalPlayerIdx?.() ?? 0;
            const rig = getRig(li);
            if (rig) { clearInterval(poll); setCharacterRig(rig.skeleton, rig.clips); log(`Rig wired: ${m.label}`); }
          }, 500);
          setTimeout(() => clearInterval(poll), 8000);
        }
        document.querySelectorAll('#fw-palette-host .fw-asset-item[data-id]').forEach(el => {
          el.classList.toggle('active', el.dataset.id === m.id);
        });
      });
      body.appendChild(item);
    });
    const sep = document.createElement('div'); sep.className = 'fw-separator'; body.appendChild(sep);
  }

  const sec2 = document.createElement('div'); sec2.className = 'fw-section-label'; sec2.textContent = 'Clips'; body.appendChild(sec2);
  _refreshClipLibrary(body);
}

// ── Bind pose ──────────────────────────────────────────────────────
function _sanitize(n) { return n.replace(/[\[\].:\/]/g, ''); }

function _captureBindPose() {
  if (!_skeleton) return;
  _skeleton.bones.forEach(b => {
    _bindPose[_sanitize(b.name)] = {
      pos:  b.position.clone(),
      quat: b.quaternion.clone(),
      scale:b.scale.clone(),
    };
  });
}

function _resetToBindPose() {
  for (const sName in _bindPose) {
    const bone = _boneMap[sName];
    const bp   = _bindPose[sName];
    if (bone && bp) {
      bone.position.copy(bp.pos);
      bone.quaternion.copy(bp.quat);
      bone.scale.copy(bp.scale);
    }
  }
}

// ── Sample & blend (multi-track slerp/lerp, verbatim from animation_editor.html) ─
function _sampleClip(clipName, localTime) {
  const clip = _allClips[clipName];
  if (!clip) return null;
  const result = {};
  for (let i = 0; i < clip.tracks.length; i++) {
    const track  = clip.tracks[i];
    const dotIdx = track.name.lastIndexOf('.');
    if (dotIdx < 0) continue;
    const boneName = track.name.substring(0, dotIdx);
    const prop     = track.name.substring(dotIdx + 1);
    const t = Math.max(0, Math.min(localTime, clip.duration));
    const cacheKey = clipName + ':' + i;
    let interp = _interpCache.get(cacheKey);
    if (!interp) { interp = track.createInterpolant(); _interpCache.set(cacheKey, interp); }
    interp.evaluate(t);
    const sampled = Array.from(interp.resultBuffer);
    if (!result[boneName]) result[boneName] = {};
    result[boneName][prop] = sampled;
  }
  return result;
}

function _evaluateTimeline() {
  if (!_skeleton || _tracks.length === 0) return;
  _resetToBindPose();
  const boneWeights = {};
  for (const track of _tracks) {
    if (track.weight <= 0) continue;
    for (const tc of track.clips) {
      if (_currentTime < tc.startTime || _currentTime >= tc.endTime) continue;
      const localTime = (_currentTime - tc.startTime) + (tc.trimStart || 0);
      const sampled   = _sampleClip(tc.clipName, localTime);
      if (!sampled) continue;
      for (const boneName in sampled) {
        if (track.mask === 'upper' && !_isUpper(boneName)) continue;
        if (track.mask === 'lower' && !_isLower(boneName)) continue;
        const bone = _boneMap[boneName];
        if (!bone) continue;
        const data      = sampled[boneName];
        const w         = track.weight;
        if (!boneWeights[boneName]) boneWeights[boneName] = 0;
        const existingW = boneWeights[boneName];
        const blendW    = (existingW + w) > 0 ? w / (existingW + w) : 1;
        if (data.quaternion) {
          bone.quaternion.slerp(
            new THREE.Quaternion(data.quaternion[0],data.quaternion[1],data.quaternion[2],data.quaternion[3]),
            blendW
          );
        }
        if (data.position) {
          bone.position.lerp(new THREE.Vector3(data.position[0],data.position[1],data.position[2]), blendW);
        }
        if (data.scale) {
          bone.scale.lerp(new THREE.Vector3(data.scale[0],data.scale[1],data.scale[2]), blendW);
        }
        boneWeights[boneName] = existingW + w;
      }
    }
  }
}

// ── Transport ──────────────────────────────────────────────────────
function _startPlayback() {
  _playing  = true;
  _lastPlayT = performance.now();
  _tick();
}
function _stopPlayback() {
  _playing = false;
  if (_playRAF) { cancelAnimationFrame(_playRAF); _playRAF = null; }
}
function _tick() {
  if (!_playing) return;
  const now = performance.now();
  const dt  = (now - _lastPlayT) / 1000;
  _lastPlayT = now;
  _currentTime = (_currentTime + dt) % Math.max(_duration, 0.01);
  _evaluateTimeline();
  _updateTimecodeEl();
  _playRAF = requestAnimationFrame(_tick);
}

// ── Quick-add: drag clip from library onto default track ──────────
function _addClipToDefaultTrack(clipName) {
  if (_tracks.length === 0) {
    _tracks.push({
      id: _nextTrackId++, name: 'Track 1',
      color: '#2255aa', weight: 1.0, mask: 'all', clips: []
    });
  }
  const track = _tracks[0];
  const clip  = _allClips[clipName];
  if (!clip) return;
  // Find end of last clip on track
  const lastEnd = track.clips.reduce((m, c) => Math.max(m, c.endTime), 0);
  track.clips.push({
    id: _nextClipId++, clipName,
    startTime: lastEnd, endTime: lastEnd + clip.duration, trimStart: 0
  });
  _duration = Math.max(_duration, lastEnd + clip.duration);
  _renderTracks();
  log(`Added "${clipName}" to timeline`);
}

// ── Timeline DOM ──────────────────────────────────────────────────
function _buildTimeline() {
  const transport = document.getElementById('fw-transport');
  const tracksArea = document.getElementById('fw-tracks-area');
  if (!transport) return;

  transport.innerHTML = `
    <button class="fw-transport-btn" id="fw-btn-rewind" title="Rewind">⏮</button>
    <button class="fw-transport-btn" id="fw-btn-play"   title="Play / Pause">▶</button>
    <span class="fw-timecode" id="fw-timecode">0:00.000</span>
    <input type="range" id="fw-scrubber" min="0" max="1000" value="0"
      style="flex:1;accent-color:var(--amber);margin:0 8px" aria-label="Scrub timeline">
    <span style="font-size:10px;color:var(--ink-faint);font-family:var(--font-mono)" id="fw-duration-label"></span>`;

  document.getElementById('fw-btn-rewind').addEventListener('click', () => {
    _currentTime = 0; _stopPlayback();
    document.getElementById('fw-btn-play').textContent = '▶';
    _evaluateTimeline(); _updateTimecodeEl();
  });
  document.getElementById('fw-btn-play').addEventListener('click', () => {
    if (_playing) { _stopPlayback(); document.getElementById('fw-btn-play').textContent = '▶'; }
    else          { _startPlayback(); document.getElementById('fw-btn-play').textContent = '⏸'; }
  });
  const scrubber = document.getElementById('fw-scrubber');
  scrubber.addEventListener('input', () => {
    _stopPlayback(); document.getElementById('fw-btn-play').textContent = '▶';
    _currentTime = (scrubber.value / 1000) * _duration;
    _evaluateTimeline(); _updateTimecodeEl();
  });

  _renderTracks();
}

function _renderTracks() {
  const area = document.getElementById('fw-tracks-area');
  if (!area) return;
  area.innerHTML = '';
  const PIXELS_PER_SEC = 80;
  _tracks.forEach(track => {
    const row = document.createElement('div');
    row.className = 'fw-track';
    row.innerHTML = `<div class="fw-track-label">${track.name}</div><div class="fw-track-lane" style="min-width:${Math.max(_duration,4)*PIXELS_PER_SEC}px">` +
      track.clips.map(tc => {
        const left  = tc.startTime * PIXELS_PER_SEC;
        const width = (tc.endTime - tc.startTime) * PIXELS_PER_SEC;
        return `<div class="fw-clip-block" style="left:${left}px;width:${width}px;background:${track.color}">${tc.clipName}</div>`;
      }).join('') + '</div>';
    area.appendChild(row);
  });
  const dLabel = document.getElementById('fw-duration-label');
  if (dLabel) dLabel.textContent = _duration.toFixed(2) + 's';
}

function _updateTimecodeEl() {
  const el = document.getElementById('fw-timecode');
  if (!el) return;
  const s = _currentTime;
  const m = Math.floor(s / 60);
  const ss = (s % 60).toFixed(3).padStart(6,'0');
  el.textContent = `${m}:${ss}`;
  const scrubber = document.getElementById('fw-scrubber');
  if (scrubber && _duration > 0) scrubber.value = (_currentTime / _duration * 1000).toFixed(0);
}

function _refreshClipLibrary(body) {
  Object.entries(_allClips).forEach(([name, clip]) => {
    const item = document.createElement('div');
    item.className = 'fw-asset-item';
    item.innerHTML = `<span class="fw-asset-icon">🎬</span><span class="fw-asset-label">${name}<br><small style="color:var(--ink-faint)">${clip.duration.toFixed(2)}s · ${clip.tracks.length} tracks</small></span>`;
    item.title = `${name} — click to preview, double-click to add to timeline`;
    item.addEventListener('click', () => {
      // Quick preview: add single clip to a temp track and play
      _tracks.length = 0; _interpCache.clear();
      _tracks.push({ id:1, name:'Preview', color:'#2255aa', weight:1.0, mask:'all',
        clips:[{id:1, clipName:name, startTime:0, endTime:clip.duration, trimStart:0}] });
      _duration = clip.duration;
      _currentTime = 0;
      _renderTracks();
      _startPlayback();
      document.getElementById('fw-btn-play').textContent = '⏸';
      log(`Previewing "${name}"`);
    });
    item.addEventListener('dblclick', () => _addClipToDefaultTrack(name));
    body.appendChild(item);
  });
  if (Object.keys(_allClips).length === 0) {
    body.innerHTML += `<p style="font-size:11px;color:var(--ink-faint);padding:8px">No character loaded yet. Switch to Play so the character can load, then return here.</p>`;
  }
}

// Tick called from shell's frame loop
export function tickAnimations() {
  // Only drives evaluation when scrubbing — playback handled by _tick's own RAF
}
