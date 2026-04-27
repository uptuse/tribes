// ============================================================
// renderer_polish.js — R32.7 visual polish (additive, opt-out via ?polish=off)
// ============================================================
// Single-purpose module that the main renderer.js calls into via:
//   import { installPolish } from './renderer_polish.js';
//   const polish = installPolish({ THREE, scene, camera, renderer, composer, sunLight, hemiLight });
//   ...in render loop:  polish.tick(dt, t);
//   ...on damage:       polish.onDamage(amount);
//   ...on shoot:        polish.onShoot(weaponType);
//   ...on near miss:    polish.onNearMiss(strength);
//   ...on jet boost:    polish.onJetBoost(active);
//   ...on flag pickup:  polish.onFlagEvent('pickup'|'capture'|'drop'|'return', team);
//
// All effects gracefully degrade if their dependency is missing. The module
// never throws; if a Three addon fails to import, the corresponding effect
// becomes a no-op.
// ============================================================

import * as THREE from 'three';
import { Lensflare, LensflareElement } from 'three/addons/objects/Lensflare.js';
import { DecalGeometry } from 'three/addons/geometries/DecalGeometry.js';

// ============================================================
// Module state
// ============================================================
let _ctx = null;          // { THREE, scene, camera, renderer, composer, sunLight, hemiLight, ... }
let _enabled = true;      // master switch; honors ?polish=off
let _quality = 'high';    // mirrors renderer's currentQuality
let _clock = null;
let _matchStartT = 0;

// Subsystems (each null until init or unavailable)
let _lensflare = null;        // sun lens flare
let _lightning = null;        // lightning flash module
let _decals = null;           // decal pool
let _shake = null;            // camera shake state
let _fovPunch = null;         // FOV transient state
let _splashGroup = null;      // rain ground splashes
let _smokeStacks = [];        // generator chimney smoke plumes
let _vignettePulse = null;    // damage red vignette overlay (DOM)
let _telemetry = null;        // fps/ping HUD overlay
let _hudRing = null;          // compass + objective HUD ring
let _flagFlash = null;        // screen flash on flag events (DOM)
let _heatShimmer = null;      // jetpack heat distortion (sprite)
let _railings = [];           // bridge railings refs
let _stationIcons = [];       // holographic station icons
let _towerWindows = [];       // emissive window planes on towers
let _coilRings = [];          // plasma turret emissive coils
let _missileClusters = [];    // rocket turret missile cluster splits
let _sensorDishes = [];       // sensor dish detail
let _factionMaterials = {};   // tinted variants for buildings
let _wetGround = null;        // wet ground tint shader uniform

// FX flags (URL-driven)
let _fxLevel = 'mid';   // low|mid|high

// Detail flag (URL-driven)
let _detailHigh = false;

// Cached vectors
const _v3a = new THREE.Vector3();
const _v3b = new THREE.Vector3();

// ============================================================
// Public entry point
// ============================================================
export function installPolish(ctx) {
    _ctx = ctx;
    _clock = new THREE.Clock();
    _matchStartT = performance.now() * 0.001;

    // Read URL flags
    const params = new URLSearchParams(location.search);
    const polishFlag = params.get('polish');
    if (polishFlag === 'off' || polishFlag === '0') { _enabled = false; }
    const fxFlag = params.get('fx');
    if (fxFlag === 'low' || fxFlag === 'mid' || fxFlag === 'high') { _fxLevel = fxFlag; }
    _detailHigh = (params.get('detail') === 'high');

    if (!_enabled) {
        console.log('[R32.7] polish disabled via ?polish=off');
        return _noopAPI();
    }

    console.log('[R32.7] polish module install (fx=' + _fxLevel + ' detail=' + (_detailHigh ? 'high' : 'normal') + ')');

    // Subsystem init — each call swallows its own errors so a single failure
    // never takes down the rest. Order is intentional: foundation first, then
    // FX that depend on scene, then DOM overlays last.
    safeInit('lensflare', _initLensflare);
    safeInit('lightning', _initLightning);
    safeInit('decals',    _initDecals);
    safeInit('rainSplashes', _initRainSplashes);
    safeInit('smokeStacks',  _initSmokeStacks);
    safeInit('coilRings',    _initCoilRings);
    safeInit('missileClusters', _initMissileClusters);
    safeInit('sensorDishes', _initSensorDishes);
    safeInit('railings', _initBridgeRailings);
    safeInit('windows',  _initTowerWindows);
    safeInit('stationIcons', _initStationIcons);
    safeInit('factionMaterials', _initFactionMaterials);
    safeInit('wetGround', _initWetGround);
    safeInit('subdivision', _maybeSubdivideMeshes);
    safeInit('vignette',  _initDamageVignette);
    safeInit('telemetry', _initTelemetryHUD);
    safeInit('hudRing',   _initObjectiveHUDRing);
    safeInit('flagFlash', _initFlagFlash);
    safeInit('settings',  _initSettingsPanel);
    safeInit('thunder',   _initThunder);

    return {
        tick: tick,
        onDamage: onDamage,
        onShoot: onShoot,
        onNearMiss: onNearMiss,
        onJetBoost: onJetBoost,
        onFlagEvent: onFlagEvent,
        onSpawn: onSpawn,
        onDeath: onDeath,
        getFXLevel: () => _fxLevel,
        setFXLevel: (level) => { _fxLevel = level; },
    };
}

function _noopAPI() {
    return {
        tick: () => {},
        onDamage: () => {},
        onShoot: () => {},
        onNearMiss: () => {},
        onJetBoost: () => {},
        onFlagEvent: () => {},
        onSpawn: () => {},
        onDeath: () => {},
        getFXLevel: () => 'off',
        setFXLevel: () => {},
    };
}

function safeInit(name, fn) {
    try { fn(); }
    catch (e) { console.warn('[R32.7] ' + name + ' init failed:', e && e.message ? e.message : e); }
}

// ============================================================
// Per-frame tick — drives all time-based effects
// ============================================================
function tick(dt, t) {
    if (!_enabled) return;
    if (_lightning) _tickLightning(dt, t);
    if (_shake) _tickCameraShake(dt);
    if (_fovPunch) _tickFOVPunch(dt);
    if (_splashGroup) _tickRainSplashes(dt, t);
    if (_smokeStacks.length) _tickSmokeStacks(dt, t);
    if (_telemetry) _tickTelemetry(t);
    if (_hudRing) _tickHUDRing(t);
    _tickWearAndTear(t);
    _tickWetGround(t);
    _tickFlashOverlay(dt);
}

// ============================================================
// Item 6+? — Sun lens flare (only when sun is in front of camera)
// ============================================================
function _initLensflare() {
    const scene = _ctx.scene, sunLight = _ctx.sunLight;
    if (!sunLight) return;

    // Generate procedural flare textures on-canvas (no external asset fetch)
    const tex0 = _makeFlareTexture(256, 'rgba(255,235,180,1)', 0.55);
    const tex1 = _makeFlareTexture(64,  'rgba(255,200,140,1)', 0.30);
    const tex2 = _makeFlareTexture(96,  'rgba(255,180,120,1)', 0.18);

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
    const g = c.getContext('2d');
    const grad = g.createRadialGradient(size/2, size/2, 0, size/2, size/2, size/2);
    grad.addColorStop(0, color);
    grad.addColorStop(fade, color.replace(/,1\)$/, ',0.4)'));
    grad.addColorStop(1, color.replace(/,1\)$/, ',0)'));
    g.fillStyle = grad;
    g.fillRect(0, 0, size, size);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
}

// ============================================================
// Items 32, 33 — Lightning flash + ambient brighten + thunder rumble
// ============================================================
function _initLightning() {
    if (_fxLevel === 'low') return;
    const scene = _ctx.scene;
    _lightning = {
        nextStrike: performance.now() * 0.001 + _rand(8, 18),
        flashIntensity: 0.0,
        flashDecay: 4.0,         // intensity halves every 0.25s
        boltMesh: null,
        boltExpiry: 0,
        ambientBoost: 0.0,
        screenFlashAlpha: 0.0,
    };
    // DOM overlay for screen-wide white flash
    const f = document.createElement('div');
    f.id = 'r327-lightning-flash';
    f.style.cssText = 'position:fixed;inset:0;pointer-events:none;background:rgba(220,230,255,0);z-index:9990;mix-blend-mode:screen;transition:none;';
    document.body.appendChild(f);
    _lightning.screenFlashEl = f;
}

function _tickLightning(dt, t) {
    const s = _lightning;
    if (!s) return;

    // Trigger a strike
    if (t >= s.nextStrike) {
        _spawnLightningBolt(t);
        s.nextStrike = t + _rand(6, 22);
        s.flashIntensity = 1.0;
        s.screenFlashAlpha = 0.55;
        // R32.12.3: SHARP CRACK ~60-150ms after visible flash. Now slot 17
        // (was 8 in R32.12 — but slot 8 is the C++-fired generator-explosion
        // sound, so we moved lightning_crack to safe new slot 17 to avoid
        // clobbering it). The rolling thunder rumble (separate _playThunder
        // WebAudio path) still fires 1-3s later for the natural "flash,
        // near-crack, distant rumble" sequence.
        const crackDelay = _rand(60, 150);
        setTimeout(() => { if (window.playSoundUI) window.playSoundUI(17); }, crackDelay);
        // Rolling thunder rumble ~1-3s after flash (unchanged from R32.7).
        const delay = _rand(0.8, 3.0) * 1000;
        setTimeout(() => _playThunder(), delay);
    }

    // Decay flash
    if (s.flashIntensity > 0.001) {
        s.flashIntensity = Math.max(0, s.flashIntensity - dt * s.flashDecay);
        if (_ctx.hemiLight) _ctx.hemiLight.intensity = 1.0 + s.flashIntensity * 0.8;
    }
    if (s.screenFlashAlpha > 0.001) {
        s.screenFlashAlpha = Math.max(0, s.screenFlashAlpha - dt * 1.6);
        s.screenFlashEl.style.background = 'rgba(220,230,255,' + s.screenFlashAlpha.toFixed(3) + ')';
    }

    // Remove bolt mesh after expiry
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
    // Author a procedural jagged line from sky to ground in the camera's view direction
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
    // Use WebAudio to synthesize a low-frequency rumble — no asset fetch needed
    if (!_audioCtx) {
        try { _audioCtx = new (window.AudioContext || window.webkitAudioContext)(); }
        catch (e) { return; }
    }
    const ctx = _audioCtx;
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
    // Add a tiny camera shake when thunder fires
    onNearMiss(0.18);
}
let _audioCtx = null;

function _initThunder() { /* lazy — _audioCtx created on first thunder */ }

// ============================================================
// Item 41 — Camera shake on near-miss / explosions
// ============================================================
function _ensureShake() {
    if (!_shake) _shake = { trauma: 0, basePos: new THREE.Vector3(), tmp: new THREE.Vector3() };
    return _shake;
}

function _tickCameraShake(dt) {
    const s = _shake;
    if (!s || s.trauma <= 0.001) {
        if (s) s.trauma = 0;
        return;
    }
    const cam = _ctx.camera;
    if (!cam) return;
    const shake = s.trauma * s.trauma;
    const ox = (Math.random() * 2 - 1) * shake * 0.35;
    const oy = (Math.random() * 2 - 1) * shake * 0.30;
    const oz = (Math.random() * 2 - 1) * shake * 0.20;
    cam.position.x += ox; cam.position.y += oy; cam.position.z += oz;
    s.trauma = Math.max(0, s.trauma - dt * 1.6);
}

// ============================================================
// Item 42 — FOV punch on jet boost
// ============================================================
function _tickFOVPunch(dt) {
    const s = _fovPunch;
    if (!s) return;
    const cam = _ctx.camera;
    if (!cam) return;
    if (s.target !== s.current) {
        const k = 1 - Math.exp(-dt * 8);
        s.current = s.current + (s.target - s.current) * k;
        cam.fov = s.baseFov + s.current;
        cam.updateProjectionMatrix();
    }
}

function onJetBoost(active) {
    if (!_fovPunch) {
        const cam = _ctx.camera;
        _fovPunch = { baseFov: cam ? cam.fov : 90, current: 0, target: 0 };
    }
    _fovPunch.target = active ? 6 : 0;  // +6° while boosting
}

// ============================================================
// Items 38, 41 — Public events from renderer
// ============================================================
function onNearMiss(strength) {
    const s = _ensureShake();
    s.trauma = Math.min(1.0, s.trauma + strength);
}

function onShoot(weaponType) {
    onNearMiss(0.05);
}

function onDamage(amount) {
    // Items 43 + 44 — vignette pulse + camera shake
    // R32.14: stronger response curve. Was sublinear (0.012/0.008) which made
    // a 50-dmg sniper hit look identical to a 5-dmg pellet. New curve gives
    // big hits noticeably more vignette and shake without making small hits
    // disappear.
    var amt = Math.max(0, amount);
    if (_vignettePulse) {
        var pulseAdd = Math.min(0.85, 0.18 + amt * 0.018);
        _vignettePulse.alpha = Math.min(0.85, (_vignettePulse.alpha || 0) + pulseAdd);
    }
    // Trauma curve: 5dmg → 0.20, 20dmg → 0.45, 50+ → 0.85 cap
    var trauma = Math.min(0.85, 0.10 + amt * 0.018);
    onNearMiss(trauma);
}

function onSpawn() {
    // Item 45 — spawn shimmer is handled outside (mesh-side) but we can flash overlay
    _flashScreen('rgba(150,200,255,0.35)', 350);
}

function onDeath(killerIdx) {
    // Item 44 — death cam slow-mo placeholder; signal main renderer via callback if present
    if (_ctx.onDeathHook) _ctx.onDeathHook(killerIdx);
}

function onFlagEvent(eventType, team) {
    // Item 46 — flag pickup screen flash + audio sting
    const colors = {
        pickup: 'rgba(255,210,80,0.45)',
        capture: 'rgba(120,255,140,0.55)',
        drop: 'rgba(255,80,80,0.4)',
        return: 'rgba(120,180,255,0.4)',
    };
    _flashScreen(colors[eventType] || 'rgba(255,255,255,0.3)', eventType === 'capture' ? 700 : 350);
    _playFlagSting(eventType);
}

// ============================================================
// Item 38 — Explosion shockwave hook (called from particle / projectile pipeline)
// ============================================================
export function spawnShockwave(scene, position, magnitude) {
    if (!_enabled) return;
    const r = 1.0;
    const geom = new THREE.RingGeometry(r * 0.95, r * 1.0, 36);
    geom.rotateX(-Math.PI / 2);
    const mat = new THREE.MeshBasicMaterial({
        color: 0xfff5cc,
        transparent: true,
        opacity: 0.85,
        side: THREE.DoubleSide,
        fog: false,
        depthWrite: false,
    });
    const mesh = new THREE.Mesh(geom, mat);
    mesh.position.copy(position);
    mesh.position.y += 0.6;
    scene.add(mesh);
    const start = performance.now();
    const dur = 600 + magnitude * 400;
    const peak = 14 + magnitude * 22;
    const animate = () => {
        const t = (performance.now() - start) / dur;
        if (t >= 1) {
            scene.remove(mesh); geom.dispose(); mat.dispose(); return;
        }
        const ease = 1 - Math.pow(1 - t, 3);
        mesh.scale.setScalar(1 + ease * peak);
        mat.opacity = 0.85 * (1 - ease);
        requestAnimationFrame(animate);
    };
    requestAnimationFrame(animate);
    onNearMiss(Math.min(0.55, magnitude * 0.18));
}

// ============================================================
// Item 29 — Decal pool (bullet holes / scorch marks)
// ============================================================
function _initDecals() {
    if (_fxLevel === 'low') return;
    const cap = _fxLevel === 'high' ? 256 : 128;
    _decals = {
        cap,
        active: [],   // { mesh, born }
        tex: _makeScorchTexture(),
    };
}

function _makeScorchTexture() {
    const size = 128;
    const c = document.createElement('canvas');
    c.width = c.height = size;
    const g = c.getContext('2d');
    const grad = g.createRadialGradient(size/2, size/2, 4, size/2, size/2, size/2);
    grad.addColorStop(0, 'rgba(0,0,0,0.95)');
    grad.addColorStop(0.4, 'rgba(20,10,5,0.8)');
    grad.addColorStop(0.9, 'rgba(40,30,20,0.15)');
    grad.addColorStop(1, 'rgba(40,30,20,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, size, size);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
}

export function placeDecal(targetMesh, position, normal, scale) {
    if (!_enabled || !_decals) return;
    if (!targetMesh) return;
    try {
        const orient = new THREE.Euler();
        const dir = normal.clone().normalize();
        const up = Math.abs(dir.y) > 0.9 ? new THREE.Vector3(0,0,1) : new THREE.Vector3(0,1,0);
        const rot = new THREE.Matrix4().lookAt(new THREE.Vector3(), dir, up);
        orient.setFromRotationMatrix(rot);
        const sz = new THREE.Vector3(scale, scale, scale);
        const geom = new DecalGeometry(targetMesh, position, orient, sz);
        const mat = new THREE.MeshBasicMaterial({
            map: _decals.tex,
            transparent: true,
            depthWrite: false,
            polygonOffset: true,
            polygonOffsetFactor: -2,
        });
        const mesh = new THREE.Mesh(geom, mat);
        _ctx.scene.add(mesh);
        _decals.active.push({ mesh, born: performance.now() });
        // LRU cleanup
        while (_decals.active.length > _decals.cap) {
            const d = _decals.active.shift();
            _ctx.scene.remove(d.mesh);
            d.mesh.geometry.dispose();
            d.mesh.material.dispose();
        }
    } catch (e) {
        // DecalGeometry can fail on non-indexed BufferGeometry; ignore quietly
    }
}

// ============================================================
// Item 31 — Rain ground splashes (depth-aware via terrain sampling)
// ============================================================
function _initRainSplashes() {
    if (_fxLevel === 'low') return;
    const scene = _ctx.scene;
    const count = _fxLevel === 'high' ? 80 : 40;
    _splashGroup = { count, ringPool: [], idx: 0, lastSpawn: 0 };
    const ringGeom = new THREE.RingGeometry(0.05, 0.18, 12);
    ringGeom.rotateX(-Math.PI / 2);
    const ringMat = new THREE.MeshBasicMaterial({
        color: 0x9fbfd8, transparent: true, opacity: 0, side: THREE.DoubleSide,
        depthWrite: false, fog: true,
    });
    for (let i = 0; i < count; i++) {
        const m = new THREE.Mesh(ringGeom, ringMat.clone());
        m.visible = false;
        m.frustumCulled = false;
        scene.add(m);
        _splashGroup.ringPool.push({ mesh: m, born: 0, dur: 0 });
    }
}

function _tickRainSplashes(dt, t) {
    const s = _splashGroup;
    if (!s) return;
    const cam = _ctx.camera;
    if (!cam) return;
    // Spawn rate ~ count per second
    const rate = s.count;
    const tNow = performance.now() * 0.001;
    if (tNow - s.lastSpawn > 1 / rate) {
        s.lastSpawn = tNow;
        const ring = s.ringPool[s.idx];
        s.idx = (s.idx + 1) % s.ringPool.length;
        if (ring.mesh.visible) {
            // skip if pool wraps too fast
        } else {
            // Place near camera on terrain
            const r = 8 + Math.random() * 18;
            const a = Math.random() * Math.PI * 2;
            const px = cam.position.x + Math.cos(a) * r;
            const pz = cam.position.z + Math.sin(a) * r;
            const py = _sampleTerrainViaCtx(px, pz);
            ring.mesh.position.set(px, py + 0.05, pz);
            ring.mesh.scale.setScalar(0.5);
            ring.mesh.material.opacity = 0.7;
            ring.mesh.visible = true;
            ring.born = tNow;
            ring.dur = 0.45;
        }
    }
    // Animate live splashes
    for (let i = 0; i < s.ringPool.length; i++) {
        const r = s.ringPool[i];
        if (!r.mesh.visible) continue;
        const f = (tNow - r.born) / r.dur;
        if (f >= 1) { r.mesh.visible = false; continue; }
        r.mesh.scale.setScalar(0.5 + f * 1.8);
        r.mesh.material.opacity = 0.7 * (1 - f);
    }
}

function _sampleTerrainViaCtx(x, z) {
    if (_ctx.sampleTerrainH) return _ctx.sampleTerrainH(x, z);
    return 0;
}

// ============================================================
// Item 16 — Generator chimney smoke plumes
// ============================================================
function _initSmokeStacks() {
    if (_fxLevel === 'low') return;
    // The buildings group is populated by main renderer; we'll late-bind in onBuildingsReady
}

export function registerGeneratorChimney(worldPos) {
    if (!_enabled || _fxLevel === 'low') return;
    const scene = _ctx.scene;
    const COUNT = 18;
    const geom = new THREE.BufferGeometry();
    const pos = new Float32Array(COUNT * 3);
    const age = new Float32Array(COUNT);
    for (let i = 0; i < COUNT; i++) {
        pos[i*3] = worldPos.x + (Math.random()-0.5)*0.3;
        pos[i*3+1] = worldPos.y + Math.random()*2;
        pos[i*3+2] = worldPos.z + (Math.random()-0.5)*0.3;
        age[i] = Math.random() * 4;
    }
    geom.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const mat = new THREE.PointsMaterial({
        color: 0x9ea0a4, size: 1.6, transparent: true, opacity: 0.45,
        depthWrite: false, fog: true, sizeAttenuation: true,
    });
    const pts = new THREE.Points(geom, mat);
    pts.frustumCulled = false;
    scene.add(pts);
    _smokeStacks.push({ pts, pos, age, origin: worldPos.clone() });
}

function _tickSmokeStacks(dt, t) {
    for (const s of _smokeStacks) {
        for (let i = 0; i < s.age.length; i++) {
            s.age[i] += dt;
            if (s.age[i] > 4) {
                s.age[i] = 0;
                s.pos[i*3]     = s.origin.x + (Math.random()-0.5)*0.3;
                s.pos[i*3+1]   = s.origin.y;
                s.pos[i*3+2]   = s.origin.z + (Math.random()-0.5)*0.3;
            } else {
                s.pos[i*3+1]   += dt * 1.4; // rise
                s.pos[i*3]     += dt * 0.4; // wind drift
                s.pos[i*3+2]   += dt * 0.2;
            }
        }
        s.pts.geometry.attributes.position.needsUpdate = true;
    }
}

// ============================================================
// Items 17–19 — Building detail upgrades (registered late by main renderer)
// ============================================================
export function enhanceTurret(group, kind, color) {
    if (!_enabled) return;
    const scene = _ctx.scene;
    if (kind === 'plasma') {
        // Item 18 — emissive coil ring around the dome
        const ring = new THREE.Mesh(
            new THREE.TorusGeometry(0.85, 0.08, 8, 24),
            new THREE.MeshStandardMaterial({
                color: 0x66bbff, emissive: 0x4499ff, emissiveIntensity: 1.6,
                roughness: 0.3, metalness: 0.6,
            })
        );
        ring.position.y = 1.7;
        ring.rotation.x = Math.PI / 2;
        group.add(ring);
        _coilRings.push(ring);
    } else if (kind === 'rocket') {
        // Item 17 — split missile cluster: 4 individual cylinders instead of one box
        const clusterGroup = new THREE.Group();
        clusterGroup.position.y = 1.6;
        const tubeMat = new THREE.MeshStandardMaterial({
            color: 0x50545a, roughness: 0.4, metalness: 0.7,
            emissive: new THREE.Color(color || 0xff4040), emissiveIntensity: 0.15,
        });
        for (const [dx, dz] of [[-0.25,-0.25],[0.25,-0.25],[-0.25,0.25],[0.25,0.25]]) {
            const tube = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.18, 0.95, 12), tubeMat);
            tube.position.set(dx, 0, dz);
            clusterGroup.add(tube);
        }
        group.add(clusterGroup);
        _missileClusters.push(clusterGroup);
    }
}

export function enhanceSensor(group) {
    if (!_enabled) return;
    // Item 19 — sensor dish detail: ribs + mounting struts
    const ribMat = new THREE.MeshStandardMaterial({
        color: 0x404448, roughness: 0.45, metalness: 0.7,
    });
    const struts = new THREE.Group();
    struts.position.y = 2.1;
    for (let i = 0; i < 3; i++) {
        const a = (i / 3) * Math.PI * 2;
        const strut = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 0.4, 6), ribMat);
        strut.position.set(Math.cos(a) * 0.35, 0.2, Math.sin(a) * 0.35);
        strut.rotation.z = Math.cos(a) * 0.4;
        strut.rotation.x = Math.sin(a) * 0.4;
        struts.add(strut);
    }
    // dish ring
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.5, 0.04, 6, 18), ribMat);
    ring.rotation.x = Math.PI / 2;
    ring.position.y = 0.4;
    struts.add(ring);
    group.add(struts);
    _sensorDishes.push(struts);
}

// ============================================================
// Item 14 — Bridge railings
// ============================================================
function _initBridgeRailings() {
    // Will be installed late by the main renderer once bridge mesh is found
}

export function addBridgeRailings(bridgeMesh) {
    if (!_enabled || !bridgeMesh) return;
    const scene = _ctx.scene;
    const railMat = new THREE.MeshStandardMaterial({
        color: 0x8c8275, roughness: 0.7, metalness: 0.4,
    });
    // Compute bridge bounds
    const bbox = new THREE.Box3().setFromObject(bridgeMesh);
    const length = bbox.max.x - bbox.min.x;
    const z0 = bbox.min.z, z1 = bbox.max.z;
    const yTop = bbox.max.y;
    const railH = 1.2;
    const postCount = Math.max(2, Math.floor(length / 4));
    const railing = new THREE.Group();
    for (let side = 0; side < 2; side++) {
        const z = (side === 0) ? z0 : z1;
        // Top rail
        const rail = new THREE.Mesh(
            new THREE.BoxGeometry(length, 0.08, 0.12),
            railMat
        );
        rail.position.set(bbox.min.x + length/2, yTop + railH, z);
        railing.add(rail);
        // Posts
        for (let i = 0; i < postCount; i++) {
            const post = new THREE.Mesh(
                new THREE.BoxGeometry(0.12, railH, 0.12),
                railMat
            );
            post.position.set(bbox.min.x + (i + 0.5) * (length / postCount), yTop + railH/2, z);
            railing.add(post);
        }
    }
    scene.add(railing);
    _railings.push(railing);
}

// ============================================================
// Item 15 — Tower window emissive cutouts
// ============================================================
function _initTowerWindows() {
    // Late-binding via addTowerWindows()
}

export function addTowerWindows(towerMesh, height, sides) {
    if (!_enabled) return;
    const planeMat = new THREE.MeshStandardMaterial({
        color: 0x111418, emissive: 0xffd068, emissiveIntensity: 0.7,
        roughness: 0.9, metalness: 0.0,
    });
    const W = 0.6, H = 0.5;
    const baseY = height * 0.35;
    const numFloors = 3;
    for (let f = 0; f < numFloors; f++) {
        const y = baseY + f * (height * 0.18);
        for (const [side, sx, sz] of sides) {
            const plane = new THREE.Mesh(new THREE.PlaneGeometry(W, H), planeMat);
            plane.position.set(sx, y, sz);
            plane.rotation.y = side;
            towerMesh.add(plane);
            _towerWindows.push(plane);
        }
    }
}

// ============================================================
// Item 26 — Holographic station icons
// ============================================================
function _initStationIcons() {
    // Late-binding via addStationIcon()
}

export function addStationIcon(group, stationType, teamColor) {
    if (!_enabled) return;
    const c = document.createElement('canvas');
    c.width = c.height = 128;
    const g = c.getContext('2d');
    g.clearRect(0, 0, 128, 128);
    g.translate(64, 64);
    g.strokeStyle = '#aef';
    g.lineWidth = 6;
    g.lineCap = 'round';
    g.shadowBlur = 12;
    g.shadowColor = '#aef';
    if (stationType === 'AmmoStation') {
        // bullet icon
        g.beginPath(); g.moveTo(-22, -28); g.lineTo(-22, 22); g.lineTo(22, 22); g.lineTo(22, -28); g.lineTo(0, -42); g.lineTo(-22, -28); g.closePath(); g.stroke();
        g.beginPath(); g.moveTo(-22, -10); g.lineTo(22, -10); g.stroke();
    } else if (stationType === 'InventoryStation') {
        // grid icon
        for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
            g.strokeRect(-30 + i*22, -30 + j*22, 18, 18);
        }
    } else if (stationType === 'CommandStation') {
        // star icon
        g.beginPath();
        for (let i = 0; i < 5; i++) {
            const a = (i / 5) * Math.PI * 2 - Math.PI/2;
            const a2 = a + Math.PI / 5;
            g.lineTo(Math.cos(a)*30, Math.sin(a)*30);
            g.lineTo(Math.cos(a2)*14, Math.sin(a2)*14);
        }
        g.closePath(); g.stroke();
    } else if (stationType === 'VehicleStation') {
        // wing icon
        g.beginPath(); g.moveTo(-30, 12); g.lineTo(0, -16); g.lineTo(30, 12); g.lineTo(12, 12); g.lineTo(0, 4); g.lineTo(-12, 12); g.closePath(); g.stroke();
    } else {
        // generic ring
        g.beginPath(); g.arc(0, 0, 28, 0, Math.PI * 2); g.stroke();
    }
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
        map: tex, transparent: true, opacity: 0.85,
        depthWrite: false, fog: true,
    }));
    sprite.scale.set(1.6, 1.6, 1.6);
    sprite.position.set(0, 3.0, 0);
    group.add(sprite);
    _stationIcons.push(sprite);
}

// ============================================================
// Items 21, 22 — Faction material variants
// ============================================================
function _initFactionMaterials() {
    // Inferno (red team) — hot grunge tint
    _factionMaterials.inferno = {
        primary: new THREE.Color(0x8a3328),
        accent: new THREE.Color(0xff6633),
        emissive: new THREE.Color(0x331100),
    };
    // Storm (blue team) — chrome navy
    _factionMaterials.storm = {
        primary: new THREE.Color(0x2a4a6e),
        accent: new THREE.Color(0x66aaff),
        emissive: new THREE.Color(0x001833),
    };
}

export function getFactionPalette(team) {
    if (!_factionMaterials || !_factionMaterials.inferno) return null;
    return team === 0 ? _factionMaterials.inferno : _factionMaterials.storm;
}

// ============================================================
// Item 30 — Wet ground tint (Raindance is a rainy map)
// ============================================================
function _initWetGround() {
    if (_fxLevel === 'low') return;
    const terrain = _ctx.terrainMesh;
    if (!terrain || !terrain.material) return;
    // Tweak base material — bump roughness map influence on flat areas
    terrain.material.envMapIntensity = Math.max(terrain.material.envMapIntensity || 0.35, 0.5);
    terrain.material.roughness = Math.max(0.8, terrain.material.roughness * 0.95);
    terrain.material.needsUpdate = true;
    _wetGround = { material: terrain.material, basePulse: 0 };
}

function _tickWetGround(t) {
    if (!_wetGround) return;
    // Subtle slow pulse so the ground reads as varying-wet rather than uniform
    const p = 0.5 + 0.5 * Math.sin(t * 0.13);
    _wetGround.material.envMapIntensity = 0.5 + 0.15 * p;
}

// ============================================================
// Item 23 (terrain wear - skipped per user) - REPLACED by:
// Subtle building wear via match-time grunge factor (item 23 substitute on
// architecture only, NOT on soldiers per user instruction)
// ============================================================
function _tickWearAndTear(t) {
    // No-op: applied to building emissive intensities elsewhere if needed
}

// ============================================================
// Item 11 — Loop subdivision behind ?detail=high (best-effort)
// ============================================================
function _maybeSubdivideMeshes() {
    if (!_detailHigh) return;
    // SubdivisionModifier isn't shipped in r170; skip for now.
    // Placeholder: log so we know the flag was honored
    console.log('[R32.7] ?detail=high: subdivision pass skipped (modifier unavailable in r170)');
}

// ============================================================
// Item 43 — Damage vignette (DOM overlay)
// ============================================================
function _initDamageVignette() {
    const el = document.createElement('div');
    el.id = 'r327-damage-vignette';
    el.style.cssText = [
        'position:fixed','inset:0','pointer-events:none','z-index:9991',
        'background:radial-gradient(ellipse at center, rgba(255,40,30,0) 40%, rgba(255,40,30,0.55) 100%)',
        'opacity:0','transition:opacity 0.18s ease-out',
    ].join(';');
    document.body.appendChild(el);
    _vignettePulse = { el, alpha: 0 };
}

function _tickFlashOverlay(dt) {
    if (_vignettePulse) {
        _vignettePulse.alpha = Math.max(0, _vignettePulse.alpha - dt * 0.9);
        _vignettePulse.el.style.opacity = _vignettePulse.alpha.toFixed(3);
    }
    if (_flagFlash && _flagFlash.alpha > 0) {
        _flagFlash.alpha = Math.max(0, _flagFlash.alpha - dt * 1.4);
        _flagFlash.el.style.opacity = _flagFlash.alpha.toFixed(3);
    }
}

// ============================================================
// Item 46 — Flag screen flash + audio sting
// ============================================================
function _initFlagFlash() {
    const el = document.createElement('div');
    el.id = 'r327-flag-flash';
    el.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:9989;background:rgba(255,255,255,0);opacity:0;mix-blend-mode:screen;transition:none;';
    document.body.appendChild(el);
    _flagFlash = { el, alpha: 0 };
}

function _flashScreen(rgba, durMs) {
    if (!_flagFlash) return;
    _flagFlash.el.style.background = rgba;
    _flagFlash.alpha = 1.0;
    setTimeout(() => { _flagFlash.alpha = 0; _flagFlash.el.style.opacity = '0'; }, durMs);
}

function _playFlagSting(eventType) {
    // R32.13.7: PERMANENTLY DISABLED. These were 880/1320/1760 Hz triangle
    // oscillators — textbook pings. AE has its own flag pickup/capture sounds
    // (slots 6 & 7) that handle this event. The renderer_polish duplicate was
    // a leftover from R32.7.
    return;
    // (legacy code below; kept for diagnostic toggle if ever needed)
    if (typeof window !== 'undefined' && window._flagStingMuted) return;
    if (!_audioCtx) {
        try { _audioCtx = new (window.AudioContext || window.webkitAudioContext)(); }
        catch (e) { return; }
    }
    const ctx = _audioCtx;
    const now = ctx.currentTime;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    const freqs = { pickup: 880, capture: 1320, drop: 220, return: 660 };
    o.frequency.value = freqs[eventType] || 660;
    o.type = 'triangle';
    g.gain.setValueAtTime(0.0001, now);
    g.gain.exponentialRampToValueAtTime(0.18, now + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, now + 0.45);
    o.connect(g).connect(ctx.destination);
    o.start(now);
    o.stop(now + 0.5);
    if (eventType === 'capture') {
        // double-up for capture
        const o2 = ctx.createOscillator(); const g2 = ctx.createGain();
        o2.frequency.value = 1760; o2.type = 'triangle';
        g2.gain.setValueAtTime(0.0001, now + 0.18);
        g2.gain.exponentialRampToValueAtTime(0.14, now + 0.20);
        g2.gain.exponentialRampToValueAtTime(0.0001, now + 0.6);
        o2.connect(g2).connect(ctx.destination);
        o2.start(now + 0.18); o2.stop(now + 0.65);
    }
}

// ============================================================
// Item 50 — Telemetry HUD overlay
// ============================================================
function _initTelemetryHUD() {
    const el = document.createElement('div');
    el.id = 'r327-telemetry';
    el.style.cssText = [
        'position:fixed','top:8px','right:8px','z-index:9988',
        'font-family:"Roboto Mono",monospace','font-size:11px','color:#9eff9e',
        'text-shadow:0 0 4px rgba(0,0,0,0.9)','background:rgba(0,0,0,0.32)',
        'padding:6px 10px','border-radius:4px','pointer-events:none',
        'min-width:160px','user-select:none',
        'border:1px solid rgba(160,255,160,0.18)',
    ].join(';');
    el.style.display = 'none';   // hidden by default; toggle with F3
    el.innerHTML = 'fps: 0';
    document.body.appendChild(el);
    _telemetry = { el, lastUpdate: 0, lastFrame: performance.now(), frames: 0, fps: 0, visible: false };

    // Toggle via F3
    window.addEventListener('keydown', (e) => {
        if (e.key === 'F3') {
            e.preventDefault();
            _telemetry.visible = !_telemetry.visible;
            el.style.display = _telemetry.visible ? 'block' : 'none';
        }
    });
}

function _tickTelemetry(t) {
    const tel = _telemetry;
    if (!tel || !tel.visible) return;
    const now = performance.now();
    tel.frames++;
    if (now - tel.lastUpdate < 250) return;
    tel.fps = Math.round((tel.frames * 1000) / (now - tel.lastFrame));
    tel.frames = 0;
    tel.lastFrame = now;
    tel.lastUpdate = now;
    const cam = _ctx.camera;
    let speed = 0;
    if (window.Module && Module._getLocalPlayerIdx) {
        try {
            const idx = Module._getLocalPlayerIdx();
            if (idx >= 0 && _ctx.playerView && _ctx.playerStride) {
                const o = idx * _ctx.playerStride;
                const vx = _ctx.playerView[o + 4] || 0;
                const vy = _ctx.playerView[o + 5] || 0;
                const vz = _ctx.playerView[o + 6] || 0;
                speed = Math.sqrt(vx*vx + vy*vy + vz*vz);
            }
        } catch (e) {}
    }
    const cp = cam ? cam.position : { x: 0, y: 0, z: 0 };
    tel.el.innerHTML = [
        'fps    : ' + tel.fps,
        'speed  : ' + speed.toFixed(1) + ' m/s',
        'pos    : (' + cp.x.toFixed(0) + ',' + cp.y.toFixed(0) + ',' + cp.z.toFixed(0) + ')',
        'fx     : ' + _fxLevel,
        'detail : ' + (_detailHigh ? 'high' : 'normal'),
        'F3 to hide',
    ].join('<br>');
}

// ============================================================
// Item 40 — Compass + objective HUD ring (DOM)
// ============================================================
function _initObjectiveHUDRing() {
    const el = document.createElement('div');
    el.id = 'r327-hud-ring';
    el.style.cssText = [
        'position:fixed','top:14px','left:50%','transform:translateX(-50%)',
        'z-index:9987','pointer-events:none','user-select:none',
        'font-family:"Roboto Mono",monospace','font-size:13px','color:#cfe',
        'letter-spacing:0.18em','text-shadow:0 0 4px rgba(0,0,0,0.9)',
        'background:rgba(0,0,0,0.28)','padding:6px 16px','border-radius:14px',
        'border:1px solid rgba(180,220,255,0.22)',
        'min-width:380px','text-align:center',
    ].join(';');
    el.innerHTML = '<span id="r327-hud-compass">N</span> &nbsp; <span id="r327-hud-obj">RAINDANCE</span>';
    document.body.appendChild(el);
    _hudRing = {
        el,
        compassEl: el.querySelector('#r327-hud-compass'),
        objEl: el.querySelector('#r327-hud-obj'),
    };
}

function _tickHUDRing(t) {
    const r = _hudRing;
    if (!r) return;
    const cam = _ctx.camera;
    if (!cam) return;
    // Compass derived from camera Y-rotation
    const fwd = _v3a.set(0, 0, -1).applyQuaternion(cam.quaternion);
    const yaw = Math.atan2(fwd.x, -fwd.z) * 180 / Math.PI;
    const dirs = ['N','NE','E','SE','S','SW','W','NW','N'];
    const idx = Math.round(((yaw + 360) % 360) / 45);
    r.compassEl.textContent = dirs[idx];
}

// ============================================================
// Item 49 — Settings panel for graphics quality presets
// ============================================================
function _initSettingsPanel() {
    // Add a small gear button bottom-right
    const btn = document.createElement('button');
    btn.id = 'r327-settings-btn';
    btn.textContent = '⚙';
    btn.title = 'Graphics settings (F2)';
    btn.style.cssText = [
        'position:fixed','bottom:14px','right:14px','z-index:9986',
        'background:rgba(0,0,0,0.45)','color:#cfe','border:1px solid rgba(180,220,255,0.3)',
        'border-radius:50%','width:34px','height:34px','font-size:18px',
        'cursor:pointer','outline:none',
    ].join(';');
    document.body.appendChild(btn);
    const panel = document.createElement('div');
    panel.id = 'r327-settings-panel';
    panel.style.cssText = [
        'position:fixed','bottom:60px','right:14px','z-index:9986',
        'background:rgba(0,0,0,0.85)','color:#cfe',
        'border:1px solid rgba(180,220,255,0.3)','border-radius:8px',
        'padding:14px 18px','font-family:"Roboto Mono",monospace','font-size:12px',
        'min-width:200px','display:none',
    ].join(';');
    panel.innerHTML = [
        '<div style="font-weight:700;margin-bottom:8px;letter-spacing:0.15em;">GRAPHICS</div>',
        '<div style="margin-bottom:6px;">Quality:',
        '  <select id="r327-quality" style="margin-left:6px;background:#222;color:#cfe;border:1px solid #456;">',
        '    <option value="low">low</option>',
        '    <option value="medium">medium</option>',
        '    <option value="high">high</option>',
        '    <option value="ultra">ultra</option>',
        '  </select>',
        '</div>',
        '<div style="margin-bottom:6px;">FX level:',
        '  <select id="r327-fx" style="margin-left:6px;background:#222;color:#cfe;border:1px solid #456;">',
        '    <option value="low">low</option>',
        '    <option value="mid">mid</option>',
        '    <option value="high">high</option>',
        '  </select>',
        '</div>',
        '<div style="margin-top:10px;font-size:10px;color:#789;">F3: telemetry • F2: this panel</div>',
    ].join('');
    document.body.appendChild(panel);

    const qSel = panel.querySelector('#r327-quality');
    const fxSel = panel.querySelector('#r327-fx');
    qSel.value = (window.ST && window.ST.graphicsQuality) || 'high';
    fxSel.value = _fxLevel;

    qSel.addEventListener('change', (e) => {
        if (window.__tribesApplyQuality) window.__tribesApplyQuality(e.target.value);
        if (window.ST) window.ST.graphicsQuality = e.target.value;
    });
    fxSel.addEventListener('change', (e) => {
        _fxLevel = e.target.value;
    });

    function toggle() { panel.style.display = (panel.style.display === 'none' || !panel.style.display) ? 'block' : 'none'; }
    btn.addEventListener('click', toggle);
    window.addEventListener('keydown', (e) => {
        if (e.key === 'F2') { e.preventDefault(); toggle(); }
    });
}

// ============================================================
// Item 28 — Jetpack heat shimmer (sprite-based)
// ============================================================
function _initCoilRings() {} // populated lazily via enhanceTurret
function _initMissileClusters() {} // populated lazily
function _initSensorDishes() {} // populated lazily

// ============================================================
// Helper
// ============================================================
function _rand(min, max) { return min + Math.random() * (max - min); }
