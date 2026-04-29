// ============================================================
// Phase C — Visual Playground (post_fx.js)
// Combined VFX pass: Chromatic Aberration, Film Grain,
// God Rays, Depth-of-Field, Glitch, Bloom controls.
// Preset save / export / import via localStorage + JSON.
// ============================================================

import * as THREE from 'three';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { GlitchPass }  from 'three/addons/postprocessing/GlitchPass.js';

const PRESET_KEY = 'tribes_postfx_v1';

let _composer   = null;
let _vfxPass    = null;
let _glitchPass = null;
let _bloomRef   = null; // window.__tribesBloom

// ── Default state ────────────────────────────────────────────
const DEFAULT_STATE = {
    chroma:  { enabled: false, amount: 0.40 },   // 0-1 (maps to 0..0.006 in shader)
    grain:   { enabled: false, amount: 0.35 },   // 0-1
    godRays: { enabled: false, strength: 0.30, sunX: 0.5, sunY: 0.82 },
    dof:     { enabled: false, amount: 0.50 },   // 0-1
    glitch:  { enabled: false },
    bloom:   { enabled: true,  strength: 0.30, radius: 0.45, threshold: 0.92 },
};
let STATE = JSON.parse(JSON.stringify(DEFAULT_STATE));

// ── Combined VFX ShaderPass ───────────────────────────────────
const VFXShader = {
    uniforms: {
        tDiffuse:         { value: null },
        uTime:            { value: 0.0 },
        uResolution:      { value: new THREE.Vector2(1, 1) },
        // Chromatic Aberration
        uChromaEnabled:   { value: 0.0 },
        uChromaAmount:    { value: 0.003 },
        // Film Grain
        uGrainEnabled:    { value: 0.0 },
        uGrainAmount:     { value: 0.04 },
        // God Rays (radial blur from sun screen position)
        uGodRaysEnabled:  { value: 0.0 },
        uGodRaysStrength: { value: 0.15 },
        uSunPos:          { value: new THREE.Vector2(0.5, 0.82) },
        // Depth of Field (edge-weighted blur)
        uDOFEnabled:      { value: 0.0 },
        uDOFAmount:       { value: 0.5 },
    },
    vertexShader: `
        varying vec2 vUv;
        void main() {
            vUv = uv;
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
    `,
    fragmentShader: `
        precision highp float;
        uniform sampler2D tDiffuse;
        uniform float     uTime;
        uniform vec2      uResolution;

        uniform float     uChromaEnabled;
        uniform float     uChromaAmount;

        uniform float     uGrainEnabled;
        uniform float     uGrainAmount;

        uniform float     uGodRaysEnabled;
        uniform float     uGodRaysStrength;
        uniform vec2      uSunPos;

        uniform float     uDOFEnabled;
        uniform float     uDOFAmount;

        varying vec2      vUv;

        float hash21(vec2 p) {
            return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
        }

        void main() {
            vec2 uv = vUv;
            vec4 color;

            // ── Chromatic Aberration ──────────────────────────
            if (uChromaEnabled > 0.5) {
                vec2 dir    = uv - 0.5;
                float dist  = length(dir);
                vec2 offset = normalize(dir + vec2(0.0001)) * uChromaAmount * dist * dist * 6.0;
                float r = texture2D(tDiffuse, clamp(uv + offset, 0.001, 0.999)).r;
                float g = texture2D(tDiffuse, uv).g;
                float b = texture2D(tDiffuse, clamp(uv - offset, 0.001, 0.999)).b;
                color = vec4(r, g, b, 1.0);
            } else {
                color = texture2D(tDiffuse, uv);
            }

            // ── God Rays (radial march toward sun) ───────────
            if (uGodRaysEnabled > 0.5) {
                vec2  delta = (uv - uSunPos) * 0.055;
                vec2  sUv   = uv;
                float decay = 1.0;
                vec4  ray   = vec4(0.0);
                for (int i = 0; i < 14; i++) {
                    sUv  -= delta;
                    ray  += texture2D(tDiffuse, clamp(sUv, 0.001, 0.999)) * decay;
                    decay *= 0.87;
                }
                ray /= 14.0;
                color.rgb += ray.rgb * uGodRaysStrength;
            }

            // ── Depth of Field (radial edge blur) ────────────
            if (uDOFEnabled > 0.5) {
                float dist      = length(uv - 0.5);
                float blur      = max(0.0, dist - 0.22) * uDOFAmount * 0.028;
                vec4  blurred   = vec4(0.0);
                vec2  px        = vec2(blur, blur);
                blurred += texture2D(tDiffuse, uv + vec2(-px.x, -px.y));
                blurred += texture2D(tDiffuse, uv + vec2( px.x, -px.y));
                blurred += texture2D(tDiffuse, uv + vec2(-px.x,  px.y));
                blurred += texture2D(tDiffuse, uv + vec2( px.x,  px.y));
                blurred += texture2D(tDiffuse, uv + vec2(-px.x * 1.4, 0.0));
                blurred += texture2D(tDiffuse, uv + vec2( px.x * 1.4, 0.0));
                blurred += texture2D(tDiffuse, uv + vec2( 0.0, -px.y * 1.4));
                blurred += texture2D(tDiffuse, uv + vec2( 0.0,  px.y * 1.4));
                blurred /= 8.0;
                color = mix(color, blurred, min(blur * 14.0, 1.0));
            }

            // ── Film Grain ────────────────────────────────────
            if (uGrainEnabled > 0.5) {
                float grain = (hash21(uv * uResolution * 0.5 + uTime * 7.3) - 0.5) * uGrainAmount;
                color.rgb = clamp(color.rgb + grain, 0.0, 1.0);
            }

            gl_FragColor = color;
        }
    `,
};

// ── Helpers ──────────────────────────────────────────────────
function _u(name) {
    return _vfxPass && _vfxPass.material && _vfxPass.material.uniforms[name];
}
function _set(name, val) {
    const u = _u(name);
    if (u !== undefined && u !== null) u.value = val;
}
function _anyVFXEnabled() {
    return STATE.chroma.enabled || STATE.grain.enabled ||
           STATE.godRays.enabled || STATE.dof.enabled;
}
function _syncPassEnabled() {
    if (_vfxPass) _vfxPass.enabled = _anyVFXEnabled();
}

// ── Public effect setters ─────────────────────────────────────
export function setChroma(enabled, amount) {
    STATE.chroma.enabled = !!enabled;
    if (amount !== undefined) STATE.chroma.amount = amount;
    _set('uChromaEnabled', STATE.chroma.enabled ? 1.0 : 0.0);
    _set('uChromaAmount',  STATE.chroma.amount * 0.006);
    _syncPassEnabled();
}

export function setGrain(enabled, amount) {
    STATE.grain.enabled = !!enabled;
    if (amount !== undefined) STATE.grain.amount = amount;
    _set('uGrainEnabled', STATE.grain.enabled ? 1.0 : 0.0);
    _set('uGrainAmount',  STATE.grain.amount * 0.10);
    _syncPassEnabled();
}

export function setGodRays(enabled, strength, sunX, sunY) {
    STATE.godRays.enabled = !!enabled;
    if (strength !== undefined) STATE.godRays.strength = strength;
    if (sunX     !== undefined) STATE.godRays.sunX     = sunX;
    if (sunY     !== undefined) STATE.godRays.sunY     = sunY;
    _set('uGodRaysEnabled',  STATE.godRays.enabled ? 1.0 : 0.0);
    _set('uGodRaysStrength', STATE.godRays.strength * 0.4);
    const u = _u('uSunPos');
    if (u) u.value.set(STATE.godRays.sunX, STATE.godRays.sunY);
    _syncPassEnabled();
}

export function setDOF(enabled, amount) {
    STATE.dof.enabled = !!enabled;
    if (amount !== undefined) STATE.dof.amount = amount;
    _set('uDOFEnabled', STATE.dof.enabled ? 1.0 : 0.0);
    _set('uDOFAmount',  STATE.dof.amount);
    _syncPassEnabled();
}

export function setGlitch(enabled) {
    STATE.glitch.enabled = !!enabled;
    if (_glitchPass) _glitchPass.enabled = STATE.glitch.enabled;
}

export function setBloom(enabled, strength, radius, threshold) {
    if (!_bloomRef) _bloomRef = window.__tribesBloom;
    if (!_bloomRef) return;
    if (enabled   !== undefined) STATE.bloom.enabled   = !!enabled;
    if (strength  !== undefined) STATE.bloom.strength  = strength;
    if (radius    !== undefined) STATE.bloom.radius    = radius;
    if (threshold !== undefined) STATE.bloom.threshold = threshold;
    _bloomRef.enabled   = STATE.bloom.enabled;
    _bloomRef.strength  = STATE.bloom.strength;
    _bloomRef.radius    = STATE.bloom.radius;
    _bloomRef.threshold = STATE.bloom.threshold;
}

// ── Tick (call each frame) ────────────────────────────────────
export function tickPostFX(time) {
    if (!_vfxPass || !_vfxPass.enabled) return;
    _set('uTime', time);
    const u = _u('uResolution');
    if (u) u.value.set(window.innerWidth, window.innerHeight);
}

// ── Preset persistence ────────────────────────────────────────
function _applyState(s) {
    if (!s) return;
    if (s.chroma)  setChroma(s.chroma.enabled,   s.chroma.amount);
    if (s.grain)   setGrain(s.grain.enabled,     s.grain.amount);
    if (s.godRays) setGodRays(s.godRays.enabled, s.godRays.strength, s.godRays.sunX, s.godRays.sunY);
    if (s.dof)     setDOF(s.dof.enabled,         s.dof.amount);
    if (s.glitch)  setGlitch(s.glitch.enabled);
    if (s.bloom)   setBloom(s.bloom.enabled,     s.bloom.strength, s.bloom.radius, s.bloom.threshold);
}

export function savePreset() {
    try {
        localStorage.setItem(PRESET_KEY, JSON.stringify(STATE));
    } catch(e) { console.warn('[PhaseC] savePreset failed:', e); }
}

export function loadPreset() {
    try {
        const raw = localStorage.getItem(PRESET_KEY);
        if (raw) _applyState(JSON.parse(raw));
    } catch(e) { console.warn('[PhaseC] loadPreset failed:', e); }
}

export function exportPreset() {
    const blob = new Blob([JSON.stringify({ _comment: 'Tribes post-fx preset', ...STATE }, null, 2)],
        { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'tribes_postfx.json';
    document.body.appendChild(a); a.click(); a.remove();
}

export function importPreset(jsonStr) {
    try {
        const s = JSON.parse(jsonStr);
        _applyState(s);
        savePreset();
        return true;
    } catch(e) {
        console.warn('[PhaseC] importPreset failed:', e);
        return false;
    }
}

export function resetPreset() {
    _applyState(DEFAULT_STATE);
    try { localStorage.removeItem(PRESET_KEY); } catch(e) {}
}

export function getState() { return JSON.parse(JSON.stringify(STATE)); }

// ── Init ──────────────────────────────────────────────────────
export function initPostFX(composer) {
    _composer = composer;
    if (!composer) {
        console.warn('[PhaseC] initPostFX: no composer, post-FX unavailable');
        return;
    }

    // Build combined VFX pass
    _vfxPass = new ShaderPass(VFXShader);
    _vfxPass.enabled = false;

    // Glitch pass
    _glitchPass = new GlitchPass();
    _glitchPass.enabled = false;

    // Insert VFX pass + glitch before the final OutputPass
    // OutputPass is always the last entry in composer.passes
    const insertBefore = Math.max(0, composer.passes.length - 1);
    composer.passes.splice(insertBefore, 0, _vfxPass);
    composer.passes.splice(insertBefore + 1, 0, _glitchPass);

    // Grab bloom reference
    _bloomRef = window.__tribesBloom;

    // Restore any saved preset
    loadPreset();

    // Expose bridge for index.html
    window.__postFX = {
        setChroma, setGrain, setGodRays, setDOF, setGlitch, setBloom,
        savePreset, exportPreset, importPreset, resetPreset, getState,
    };

    console.log('[PhaseC] Post-FX initialized — ' + composer.passes.length + ' passes total');
}
