// @ai-contract renderer_weather.js
// PURPOSE: Weather FX — lightning bolts, thunder rumble, wet ground pulse,
//          sun lens flare. Designed as an extractable module for phase system.
// SERVES: Aliveness (atmospheric weather cycle)
// DEPENDS_ON: three (+ Lensflare addon), window.AE (audio engine),
//   window.playSoundUI (sfx), onNearMiss callback (camera shake)
// EXPOSES: init(deps), tick(dt, t), onPhaseChange(phase), dispose()
// LIFECYCLE: init() once → tick(dt, t) per frame → dispose() on teardown
// NOTES: Extracted from renderer_polish.js R32.235. Gates future phase system.

import * as THREE from 'three';
import { Lensflare, LensflareElement } from 'three/addons/objects/Lensflare.js';

// ---- Injected deps ----
let _ctx = null;  // { scene, camera, sunLight, hemiLight, terrainMesh }
let _fxLevel = 'mid';
let _enabled = true;
let _onNearMiss = null; // callback for thunder camera shake

// ---- State ----
let _lensflare = null;
let _lightning = null;
let _wetGround = null;

function _rand(min, max) { return min + Math.random() * (max - min); }

// ---- Public API ----
export function init(deps) {
    _ctx = deps.ctx;
    _fxLevel = deps.fxLevel || 'mid';
    _enabled = deps.enabled !== false;
    _onNearMiss = deps.onNearMiss || (() => {});

    _initLensflare();
    _initLightning();
    _initWetGround();
}

export function tick(dt, t) {
    if (!_enabled) return;
    if (_lightning) _tickLightning(dt, t);
    _tickWetGround(t);
}

// Future hook for phase system (Item 36)
export function onPhaseChange(phase) {
    // TODO: Adjust weather intensity based on game phase
    // e.g., increase lightning frequency during final phase
}

export function setEnabled(v) { _enabled = v; }

// ============================================================
// Sun lens flare (only when sun is in front of camera)
// ============================================================
function _initLensflare() {
    const scene = _ctx.scene, sunLight = _ctx.sunLight;
    if (!sunLight) return;
    const tex0 = _makeFlareTexture(256, 'rgba(255,235,180,1)', 0.55);
    const tex1 = _makeFlareTexture(64,  'rgba(255,200,140,1)', 0.30);
    const tex2 = _makeFlareTexture(32,  'rgba(140,200,255,0.6)', 0.20);
    const lens = new Lensflare();
    lens.addElement(new LensflareElement(tex0, 380, 0.0));
    lens.addElement(new LensflareElement(tex1, 90,  0.4));
    lens.addElement(new LensflareElement(tex2, 60,  0.7));
    lens.addElement(new LensflareElement(tex2, 80,  0.95));
    sunLight.add(lens);
    _lensflare = lens;
}

function _makeFlareTexture(size, color, fade) {
    const c = document.createElement('canvas');
    c.width = c.height = size;
    const ctx = c.getContext('2d');
    const g = ctx.createRadialGradient(size/2, size/2, 0, size/2, size/2, size/2);
    g.addColorStop(0, color);
    g.addColorStop(fade, color);
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, size, size);
    const tex = new THREE.CanvasTexture(c);
    return tex;
}

// ============================================================
// Lightning flash + ambient brighten + thunder rumble
// ============================================================
const _v3a = new THREE.Vector3();

function _initLightning() {
    if (_fxLevel === 'low') return;
    _lightning = {
        nextStrike: performance.now() * 0.001 + _rand(8, 18),
        flashIntensity: 0.0,
        flashDecay: 4.0,
        boltMesh: null,
        boltExpiry: 0,
        ambientBoost: 0.0,
        screenFlashAlpha: 0.0,
    };
    const f = document.createElement('div');
    f.id = 'r327-lightning-flash';
    f.style.cssText = 'position:fixed;inset:0;pointer-events:none;background:rgba(220,230,255,0);z-index:9990;mix-blend-mode:screen;transition:none;';
    document.body.appendChild(f);
    _lightning.screenFlashEl = f;
}

function _tickLightning(dt, t) {
    const s = _lightning;
    if (!s) return;
    if (t >= s.nextStrike) {
        _spawnLightningBolt(t);
        s.nextStrike = t + _rand(6, 22);
        s.flashIntensity = 1.0;
        s.screenFlashAlpha = 0.55;
        const crackDelay = _rand(60, 150);
        setTimeout(() => { if (!_enabled) return; if (window.playSoundUI) window.playSoundUI(17); }, crackDelay);
        const delay = _rand(0.8, 3.0) * 1000;
        setTimeout(() => { if (!_enabled) return; _playThunder(); }, delay);
    }
    if (s.flashIntensity > 0.001) {
        s.flashIntensity = Math.max(0, s.flashIntensity - dt * s.flashDecay);
        if (_ctx.hemiLight) _ctx.hemiLight.intensity = 1.0 + s.flashIntensity * 0.8;
    }
    if (s.screenFlashAlpha > 0.001) {
        s.screenFlashAlpha = Math.max(0, s.screenFlashAlpha - dt * 1.6);
        s.screenFlashEl.style.background = 'rgba(220,230,255,' + s.screenFlashAlpha.toFixed(3) + ')';
    }
    if (s.boltMesh && t > s.boltExpiry) {
        _ctx.scene.remove(s.boltMesh);
        s.boltMesh.geometry.dispose();
        s.boltMesh.material.dispose();
        s.boltMesh = null;
    }
}

function _spawnLightningBolt(t) {
    const scene = _ctx.scene, cam = _ctx.camera;
    if (!cam) return;
    const camDir = _v3a.set(0, 0, -1).applyQuaternion(cam.quaternion);
    const offset = (Math.random() * 80 - 40);
    const startX = cam.position.x + camDir.x * 200 + offset;
    const startZ = cam.position.z + camDir.z * 200 + offset;
    const startY = 250;
    const endY = 30;
    const segs = 18;
    const pts = [];
    for (let i = 0; i <= segs; i++) {
        const f = i / segs;
        const wob = (1 - f) * (Math.random() - 0.5) * 14;
        pts.push(new THREE.Vector3(startX + wob, startY * (1 - f) + endY * f, startZ + wob));
    }
    const geom = new THREE.BufferGeometry().setFromPoints(pts);
    const mat = new THREE.LineBasicMaterial({ color: 0xfff8e0, transparent: true, opacity: 0.95, fog: false });
    const line = new THREE.Line(geom, mat);
    line.frustumCulled = false;
    scene.add(line);
    _lightning.boltMesh = line;
    _lightning.boltExpiry = t + 0.25;
}

function _playThunder() {
    const ctx = window.AE && window.AE.ctx;
    if (!ctx) return;
    const dur = 2.2;
    const noise = ctx.createBufferSource();
    const buf = ctx.createBuffer(1, ctx.sampleRate * dur, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < data.length; i++) {
        const f = i / data.length;
        const env = Math.exp(-3 * f) * (1 - f * 0.4);
        data[i] = (Math.random() * 2 - 1) * env;
    }
    noise.buffer = buf;
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 90;
    const gain = ctx.createGain(); gain.gain.value = 0.45;
    noise.connect(lp).connect(gain).connect(ctx.destination);
    noise.start();
    _onNearMiss(0.18);
}

// ============================================================
// Wet ground — subtle envMap pulse on terrain material
// ============================================================
function _initWetGround() {
    if (_fxLevel === 'low') return;
    const terrain = _ctx.terrainMesh;
    if (!terrain || !terrain.material) return;
    terrain.material.envMapIntensity = Math.max(terrain.material.envMapIntensity || 0.35, 0.5);
    terrain.material.roughness = Math.max(0.8, terrain.material.roughness * 0.95);
    terrain.material.needsUpdate = true;
    _wetGround = { material: terrain.material, basePulse: 0 };
}

function _tickWetGround(t) {
    if (!_wetGround) return;
    const p = 0.5 + 0.5 * Math.sin(t * 0.13);
    _wetGround.material.envMapIntensity = 0.5 + 0.15 * p;
}

// ---- Cleanup ----
export function dispose() {
    if (_lensflare) {
        if (_lensflare.parent) _lensflare.parent.remove(_lensflare);
        _lensflare = null;
    }
    if (_lightning) {
        if (_lightning.screenFlashEl && _lightning.screenFlashEl.parentNode) {
            _lightning.screenFlashEl.parentNode.removeChild(_lightning.screenFlashEl);
        }
        if (_lightning.boltMesh) {
            if (_lightning.boltMesh.parent) _lightning.boltMesh.parent.remove(_lightning.boltMesh);
            _lightning.boltMesh.geometry.dispose();
            _lightning.boltMesh.material.dispose();
        }
        _lightning = null;
    }
    _wetGround = null;
    _ctx = null;
}
