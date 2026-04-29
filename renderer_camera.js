// @ai-contract renderer_camera.js
// PURPOSE: Camera control — 1P/3P toggle, spectator orbit, FOV, shadow follow,
//          aim-point convergence, zoom integration
// SERVES: Scale (immersive viewpoint), Adaptation (1P↔3P, spectator on death)
// DEPENDS_ON: three (global), renderer_terrain.js (sampleHeight via deps),
//   renderer_daynight.js (DayNight.sunDir via deps), window.ZoomFX, window.Module
// EXPOSES: init(deps), update(), enterSpectator(x,y,z), exitSpectator(), dispose()
//   Side-effects on window._tribesCamDist, window._tribesCamHeight,
//   window._tribesAimPoint3P, window.__camX/Y/Z
// LIFECYCLE: init() once → update() per frame → dispose() on teardown
// NOTES: Extracted from renderer.js R32.234. ~230 lines of camera + spectator.

import * as THREE from 'three';

// ---- Injected dependencies (set at init) ----
let _camera = null;
let _deps = null;
// deps shape: { Module, sunLight, DayNight, getPlayerView, getWeaponHand,
//               getFovPunchExtra, sampleTerrainH, aimPoint3P }

export function init(deps) {
    _camera = deps.camera;
    _deps = deps;
}

// ---- Spectator state ----
// R32.16-manus: spectator/freecam orbit state. Activated while local player
// is dead; orbits the death position at altitude with a slow auto-yaw and
// a gentle pitch sway. Returns control to live-cam on respawn.
const _spec = {
    active: false,
    deathX: 0, deathY: 0, deathZ: 0,
    yaw: 0,           // current orbit yaw (rad)
    yawRate: 0.35,    // rad/sec
    radius: 14,       // m from death point
    height: 6,        // m above death point
    pitch: -0.20,     // look down ~11°
    fadeIn: 0,        // 0–1 fade for the overlay
};
export function enterSpectator(deathX, deathY, deathZ) {
    _spec.active = true;
    _spec.deathX = deathX; _spec.deathY = deathY; _spec.deathZ = deathZ;
    _spec.yaw = 0;
    _spec.fadeIn = 0;
    // Show "SPECTATING" HUD label + letterbox bars
    const el = document.getElementById('spec-label');
    if (el) el.classList.add('show');
    const bars = document.getElementById('spec-bars');
    if (bars) bars.classList.add('show');
    // Hide weapon viewmodel
    const weaponHand = _deps.getWeaponHand();
    if (weaponHand) weaponHand.visible = false;
}
export function exitSpectator() {
    _spec.active = false;
    const el = document.getElementById('spec-label');
    if (el) el.classList.remove('show');
    const bars = document.getElementById('spec-bars');
    if (bars) bars.classList.remove('show');
}

// Reused objects (no per-frame alloc)
const _tmpVec = new THREE.Vector3();
const _aimPoint3P = { x: 0, y: 0, z: 0 };

// FOV punch state (owned by camera module, set via addFovPunch)
let _fovPunchExtra = 0;
export function addFovPunch(v) { _fovPunchExtra = v; }

export function update() {
    if (!_camera || !_deps) return;
    const { Module, sunLight, DayNight, getPlayerView, getWeaponHand,
            sampleTerrainH, getLastTickTime, MAX_PLAYERS } = _deps;
    const camera = _camera;
    const pvData = getPlayerView();
    if (!pvData) return;
    const playerView = pvData.view;
    const playerStride = pvData.stride;
    const weaponHand = getWeaponHand();

    const localIdx = Module._getLocalPlayerIdx();
    // R30.1: hard guard against invalid local player index.
    if (!Number.isFinite(localIdx) || localIdx < 0 || localIdx >= MAX_PLAYERS) return;
    const o = localIdx * playerStride;
    const px = playerView[o], py = playerView[o + 1], pz = playerView[o + 2];
    const pitch = playerView[o + 3];
    const yaw   = playerView[o + 4];

    // R30.1: guard against garbage / NaN / sub-terrain positions
    if (!Number.isFinite(px) || !Number.isFinite(py) || !Number.isFinite(pz)) return;
    if (px === 0 && py === 0 && pz === 0) return;     // unspawned local player

    // R32.16-manus: spectator/freecam while dead.
    const aliveLocal = playerView[o + 13] > 0.5;
    if (!aliveLocal) {
        if (!_spec.active) enterSpectator(px, py, pz);
        const dt = 1 / 60;
        _spec.yaw += _spec.yawRate * dt;
        _spec.fadeIn = Math.min(1, _spec.fadeIn + dt * 1.6);
        const cx = _spec.deathX + Math.sin(_spec.yaw) * _spec.radius;
        const cz = _spec.deathZ + Math.cos(_spec.yaw) * _spec.radius;
        const cy = _spec.deathY + _spec.height + Math.sin(_spec.yaw * 0.4) * 0.6;
        camera.position.set(cx, cy, cz);
        const dx = _spec.deathX - cx, dy = (_spec.deathY + 1.0) - cy, dz = _spec.deathZ - cz;
        const lookYaw   = Math.atan2(dx, -dz);
        const lookPitch = Math.atan2(dy, Math.hypot(dx, dz));
        camera.rotation.set(lookPitch, lookYaw, 0, 'YXZ');
        return;
    } else if (_spec.active) {
        exitSpectator();
    }

    camera.rotation.set(pitch, -yaw, 0, 'YXZ');

    const is3P = (Module._getThirdPerson && Module._getThirdPerson()) ? true : false;
    if (typeof window._tribesCamDist !== 'number') {
        window._tribesCamDist = is3P ? 1.5 : 0.0;
        window._tribesCamHeight = is3P ? 0.6 : 1.7;
    }
    const targetDist = is3P ? 1.5 : 0.0;
    const targetHeight = is3P ? 0.6 : 1.7;
    const lerpAlpha = 1.0 - Math.exp(-((1/60) / 0.05));
    window._tribesCamDist   += (targetDist   - window._tribesCamDist)   * lerpAlpha;
    window._tribesCamHeight += (targetHeight - window._tribesCamHeight) * lerpAlpha;
    if (Math.abs(targetDist   - window._tribesCamDist)   < 0.05) window._tribesCamDist   = targetDist;
    if (Math.abs(targetHeight - window._tribesCamHeight) < 0.05) window._tribesCamHeight = targetHeight;
    const camDist = window._tribesCamDist;
    const camH = window._tribesCamHeight;

    if (camDist > 2.0) {
        const fwdX = Math.sin(yaw),  fwdZ = -Math.cos(yaw);
        let cx = px - fwdX * camDist;
        let cy = py + camH;
        let cz = pz - fwdZ * camDist;
        const terrH = sampleTerrainH(cx, cz);
        const minClearance = 0.6;
        if (cy < terrH + minClearance) {
            cy = terrH + minClearance;
        }
        camera.position.set(cx, cy, cz);
    } else if (camDist > 0.05) {
        const t = camDist / 2.0;
        const fwdX = Math.sin(yaw),  fwdZ = -Math.cos(yaw);
        const cx = px - fwdX * camDist;
        const cz = pz - fwdZ * camDist;
        const cy = py + (1.7 * (1 - t) + camH * t);
        camera.position.set(cx, cy, cz);
    } else {
        camera.position.set(px, py + 1.7, pz);
    }

    // Aim-point ray-march against terrain
    {
        const cf = _tmpVec.set(0, 0, -1).applyQuaternion(camera.quaternion);
        let hitX = camera.position.x + cf.x * 1000;
        let hitY = camera.position.y + cf.y * 1000;
        let hitZ = camera.position.z + cf.z * 1000;
        for (let i = 1; i <= 32; i++) {
            const t = (i / 32) * 1000;
            const wx = camera.position.x + cf.x * t;
            const wy = camera.position.y + cf.y * t;
            const wz = camera.position.z + cf.z * t;
            const th = sampleTerrainH(wx, wz);
            if (wy <= th) {
                let lo = (i - 1) / 32 * 1000, hi = t;
                for (let j = 0; j < 4; j++) {
                    const m = (lo + hi) * 0.5;
                    const mx = camera.position.x + cf.x * m;
                    const my = camera.position.y + cf.y * m;
                    const mz = camera.position.z + cf.z * m;
                    if (my <= sampleTerrainH(mx, mz)) hi = m; else lo = m;
                }
                hitX = camera.position.x + cf.x * hi;
                hitY = camera.position.y + cf.y * hi;
                hitZ = camera.position.z + cf.z * hi;
                break;
            }
        }
        _aimPoint3P.x = hitX; _aimPoint3P.y = hitY; _aimPoint3P.z = hitZ;
        window._tribesAimPoint3P = _aimPoint3P;
    }

    if (weaponHand) weaponHand.visible = (camDist < 0.3);

    if (is3P && Module._setLocalAimPoint3P && window._tribesAimPoint3P) {
        const p = window._tribesAimPoint3P;
        Module._setLocalAimPoint3P(p.x, p.y, p.z);
    }

    let fov = Module._getCameraFov();
    let zoomActive = false;
    if (window.ZoomFX) {
        window.ZoomFX.tick();
        fov = fov * window.ZoomFX.getFovMultiplier();
        zoomActive = window.ZoomFX.isActive();
    }
    fov += _fovPunchExtra;
    if (_fovPunchExtra > 0.01) {
        const _lastTickTime = getLastTickTime();
        const dt = _lastTickTime > 0 ? Math.min(0.1, performance.now() * 0.001 - _lastTickTime) : 1/60;
        _fovPunchExtra *= Math.max(0, 1 - dt * 5);
    } else {
        _fovPunchExtra = 0;
    }
    const fovThreshold = zoomActive || _fovPunchExtra > 0.01 ? 0.05 : 0.5;
    if (Math.abs(camera.fov - fov) > fovThreshold) {
        camera.fov = fov;
        camera.updateProjectionMatrix();
    }

    // Sun follows camera for shadow frustum
    sunLight.position.set(px + DayNight.sunDir.x * 800, py + DayNight.sunDir.y * 800, pz + DayNight.sunDir.z * 800);
    sunLight.target.position.set(px, py, pz);
    sunLight.target.updateMatrixWorld();

    // R32.50: Snap shadow camera to texel boundaries
    if (sunLight.shadow && sunLight.shadow.mapSize) {
        const shadowFrustumSize = 240;
        const texelSize = shadowFrustumSize / sunLight.shadow.mapSize.x;
        sunLight.position.x = Math.round(sunLight.position.x / texelSize) * texelSize;
        sunLight.position.z = Math.round(sunLight.position.z / texelSize) * texelSize;
        sunLight.target.position.x = Math.round(sunLight.target.position.x / texelSize) * texelSize;
        sunLight.target.position.z = Math.round(sunLight.target.position.z / texelSize) * texelSize;
        sunLight.target.updateMatrixWorld();
    }
}

// ---- Cleanup ----
export function dispose() {
    _camera = null;
    _deps = null;
    _fovPunchExtra = 0;
}
