// @ai-contract
// PURPOSE: Day/night cycle — drives sun/moon position, light colors, fog, exposure, env intensity
// SERVES: Aliveness, Adaptation
// DEPENDS_ON: three (THREE.Color, THREE.Vector3)
// EXPOSES: init, update, dispose, dayMix, sunDir, freeze, unfreeze, lerpColors
// PATTERN: ES module with init(refs)/update()/dispose() lifecycle
// PERF_BUDGET: <0.1ms per frame (math + color lerps, no GPU work)
// QUALITY_TIERS: always active (no degradation — pure CPU, trivial cost)
// @end-ai-contract

// ============================================================
// renderer_daynight.js — Day/Night Cycle (extracted from renderer.js R32.169)
// ============================================================
// 30-min real-time loop = 24h game time. Drives all scene lighting.
//
// URL params:
//   ?daynight=off      -> freeze at noon (legacy behavior)
//   ?daynight=fast     -> 5-min cycle (testing)
//   ?daynight=slow     -> 60-min cycle (cinematic)
//   ?daynight=h=NN     -> start at game hour NN (0..24), normal speed
// ============================================================

import * as THREE from 'three';

// --- Module state (populated by init) ---
let _sunLight = null;
let _hemiLight = null;
let _moonLight = null;
let _nightAmbient = null;
let _terrainMesh = null;
let _renderer = null;
let _scene = null;
let _initialized = false;

// --- Cycle timing ---
const _params = (() => {
    try { return new URLSearchParams(window.location.search); }
    catch (e) { return new URLSearchParams(''); }
})();
const _mode = (_params.get('daynight') || '').toLowerCase();
const _startHourMatch = _mode.match(/^h=(\d+(?:\.\d+)?)$/);
const _startHour = _startHourMatch ? Math.max(0, Math.min(24, parseFloat(_startHourMatch[1]))) : 8.0;
const _cycleSeconds = _mode === 'off' ? Infinity
                    : _mode === 'fast' ? 120
                    : _mode === 'slow' ? 3600
                    : 1800; // default 30 minutes
const _startWallClock = performance.now() * 0.001;
const _startOffset01 = _startHour / 24.0;

// --- Color palette ---
const _palette = {
    nightSun:   new THREE.Color(0x2a3858),
    dawnSun:    new THREE.Color(0xff8c4a),
    noonSun:    new THREE.Color(0xfff2cf),
    duskSun:    new THREE.Color(0xff5a2a),
    nightHemi:  new THREE.Color(0x3a4a68),
    dawnHemi:   new THREE.Color(0xc89878),
    noonHemi:   new THREE.Color(0xb8c4d8),
    duskHemi:   new THREE.Color(0x4a3858),
    hemiGround: new THREE.Color(0x4d473b),
    nightFog:   new THREE.Color(0x141e2c),
    dawnFog:    new THREE.Color(0xd0a080),
    noonFog:    new THREE.Color(0xa8b8c8),
    duskFog:    new THREE.Color(0x1a1828),
};

// --- Pre-allocated temp (lerpColors returns this — callers must .copy() before next call) ---
const _tmpA = new THREE.Color();

// --- Internal state ---
let _sunPos = new THREE.Vector3();
let _frozen01 = null;
let _lastHour = -1;

// --- Exported mutable state ---
/** Current day mix: 0 = midnight, 1 = noon */
export let dayMix = 1.0;
/** Current sun direction vector (normalized-ish, for sky dome + shadow placement) */
export const sunDir = new THREE.Vector3(0, 1, 0);

/**
 * 4-stop cyclic color lerp: t in [0,1] maps midnight → dawn → noon → dusk → midnight.
 * Exported for reuse by other modules (phase transitions, sky tint, etc.)
 * 
 * WARNING: Returns a shared THREE.Color temp. Callers must .copy() the result
 * before calling lerpColors again — consecutive calls overwrite the same object.
 */
export function lerpColors(c0, c1, c2, c3, t) {
    let k, a, b;
    if (t < 0.25)      { k = t * 4;          a = c0; b = c1; }
    else if (t < 0.50) { k = (t - 0.25) * 4; a = c1; b = c2; }
    else if (t < 0.75) { k = (t - 0.50) * 4; a = c2; b = c3; }
    else               { k = (t - 0.75) * 4; a = c3; b = c0; }
    _tmpA.copy(a).lerp(b, k);
    return _tmpA;
}

/**
 * Initialize the DayNight module with scene references.
 * @param {object} refs - { sunLight, hemiLight, moonLight, nightAmbient, terrainMesh, renderer, scene }
 */
export function init(refs) {
    _sunLight     = refs.sunLight     || null;
    _hemiLight    = refs.hemiLight    || null;
    _moonLight    = refs.moonLight    || null;
    _nightAmbient = refs.nightAmbient || null;
    _terrainMesh  = refs.terrainMesh  || null;
    _renderer     = refs.renderer     || null;
    _scene        = refs.scene        || null;
    _initialized  = true;
}

/**
 * Per-frame update. Call once per RAF tick.
 */
export function update() {
    if (_cycleSeconds === Infinity) {
        // Frozen mode (URL ?daynight=off) — apply noon palette once and bail
        if (_frozen01 === null) {
            _frozen01 = 0.5; // noon
            _apply(_frozen01);
        }
        return;
    }
    // R32.201: Runtime freeze via freeze(hour) — apply frozen value and bail
    if (_frozen01 !== null) {
        _apply(_frozen01);
        return;
    }
    const wall = performance.now() * 0.001 - _startWallClock;
    const t01 = ((wall / _cycleSeconds) + _startOffset01) % 1.0;
    _apply(t01);
}

function _apply(t01) {
    // Sun elevation: sin curve, peak at t01=0.5 (noon), trough at t01=0.0 (midnight)
    const elevRad = Math.sin((t01 - 0.25) * Math.PI * 2);

    // Sun arc oriented along base axis (team0 → team1 ≈ +Z → -Z)
    const dayFrac = (t01 - 0.25);
    const azimRad = dayFrac * Math.PI * 2;
    const r = Math.sqrt(Math.max(0.0, 1 - elevRad * elevRad));
    _sunPos.set(r * 0.3 * Math.cos(azimRad), elevRad, -r * Math.sin(azimRad));

    // Brightness curve: full at noon, zero at horizon and below
    const dm = Math.max(0, Math.min(1, (elevRad + 0.05) / 0.40));
    const nightMix = 1.0 - dm;

    // Sun light
    const sunCol = lerpColors(_palette.nightSun, _palette.dawnSun, _palette.noonSun, _palette.duskSun, t01);
    if (_sunLight) {
        _sunLight.color.copy(sunCol);
        _sunLight.intensity = 1.6 * dm;
        _sunLight.castShadow = _sunLight.intensity > 0.05;
    }

    // Moon light
    if (_moonLight) {
        _moonLight.position.set(-_sunPos.x * 100, Math.max(0.2, -elevRad) * 100, -_sunPos.z * 100);
        _moonLight.target.position.set(0, 0, 0);
        _moonLight.color.setHex(0x6688cc);
        _moonLight.intensity = 0.12 * nightMix;
    }

    // Hemisphere fill
    const hemiCol = lerpColors(_palette.nightHemi, _palette.dawnHemi, _palette.noonHemi, _palette.duskHemi, t01);
    if (_hemiLight) {
        _hemiLight.color.copy(hemiCol);
        _hemiLight.groundColor.copy(_palette.hemiGround);
        _hemiLight.intensity = 0.08 + 0.27 * dm;
    }

    // Night ambient
    if (_nightAmbient) {
        _nightAmbient.intensity = nightMix * 0.6;
        _nightAmbient.color.setHex(0x304060);
    }

    // Terrain emissive (moonlight self-glow)
    if (_terrainMesh && _terrainMesh.material) {
        _terrainMesh.material.emissive.setHex(0x1a2540);
        _terrainMesh.material.emissiveIntensity = nightMix * 0.35;
    }

    // Fog
    const fogCol = lerpColors(_palette.nightFog, _palette.dawnFog, _palette.noonFog, _palette.duskFog, t01);
    if (_scene && _scene.fog) {
        _scene.fog.color.copy(fogCol);
        _scene.fog.density = 0.0006 + 0.0012 * nightMix;
    }

    // Exposure + environment
    if (_renderer) {
        _renderer.toneMappingExposure = 0.80 + 0.20 * dm;
    }
    if (_scene && _scene.environmentIntensity !== undefined) {
        _scene.environmentIntensity = 0.05 + 0.40 * dm;
    }

    // Update exported state
    dayMix = dm;
    sunDir.copy(_sunPos);

    // HUD clock
    const h = Math.floor(t01 * 24);
    const m = Math.floor(((t01 * 24) - h) * 60);
    _lastHour = h;
    if (typeof window !== 'undefined' && window.__tribesSetGameClock) {
        const ampm = (h % 24) < 12 ? 'AM' : 'PM';
        const hh = ((h % 12) === 0) ? 12 : (h % 12);
        const mm = (m < 10 ? '0' : '') + m;
        window.__tribesSetGameClock(`${hh}:${mm} ${ampm}`);
    }
}

/**
 * Freeze at a specific game hour (0-24). Used by debug panel.
 * @param {number} hour - Game hour to freeze at
 */
export function freeze(hour) {
    _frozen01 = Math.max(0, Math.min(1, hour / 24.0));
    _apply(_frozen01);
}

/**
 * Unfreeze — resume normal time-based cycle.
 */
export function unfreeze() {
    _frozen01 = null;
}

/**
 * Dispose — null out all scene references. Call on shutdown / map change.
 */
export function dispose() {
    _sunLight = null;
    _hemiLight = null;
    _moonLight = null;
    _nightAmbient = null;
    _terrainMesh = null;
    _renderer = null;
    _scene = null;
    _frozen01 = null;
    _initialized = false;
}

/**
 * Update a single scene reference post-init (e.g. terrainMesh after async load).
 * @param {string} key - reference name matching init() param keys
 * @param {*} value - new reference
 */
export function setRef(key, value) {
    switch (key) {
        case 'terrainMesh': _terrainMesh = value; break;
        case 'nightAmbient': _nightAmbient = value; break;
        default: console.warn('[DayNight] setRef: unknown key', key);
    }
}

// --- Temporary bridge: expose on window for legacy IIFE consumers ---
// (renderer_debug_panel.js reads window.DayNight.freeze/unfreeze)
// Remove this once debug panel is migrated to ES module.
try {
    window.DayNight = { update, init, dispose, freeze, unfreeze, lerpColors,
        get dayMix() { return dayMix; },
        get sunDir() { return sunDir; }
    };
} catch (e) { /* SSR safety */ }
