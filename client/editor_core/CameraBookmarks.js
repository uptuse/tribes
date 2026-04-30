/**
 * CameraBookmarks — save/recall four edit-camera poses.
 * Shift+F1–F4 saves; F1–F4 recalls with 250ms ease.
 */
import { log } from '../shell.js';

const SLOTS = [null, null, null, null];
let _camera = null;

export const CameraBookmarks = {
  init(camera) { _camera = camera; },

  save(idx) {
    if (!_camera) return;
    SLOTS[idx] = {
      pos: _camera.position.clone(),
      quat: _camera.quaternion.clone(),
    };
    log(`Camera bookmark ${idx + 1} saved`);
    _updateIndicators();
  },

  recall(idx) {
    if (!_camera || !SLOTS[idx]) { log(`Bookmark ${idx + 1} is empty`); return; }
    const { pos, quat } = SLOTS[idx];
    _easeTo(pos, quat);
    log(`Camera bookmark ${idx + 1} recalled`);
  },
};

function _easeTo(targetPos, targetQuat) {
  const startPos  = _camera.position.clone();
  const startQuat = _camera.quaternion.clone();
  const THREE     = window.__THREE ?? window.THREE;
  if (!THREE) { _camera.position.copy(targetPos); _camera.quaternion.copy(targetQuat); return; }

  const dur = 250;
  const t0  = performance.now();
  function step() {
    const t = Math.min((performance.now() - t0) / dur, 1);
    const ease = t < 0.5 ? 2*t*t : -1+(4-2*t)*t;  // ease in-out quad
    _camera.position.lerpVectors(startPos, targetPos, ease);
    _camera.quaternion.slerpQuaternions(startQuat, targetQuat, ease);
    if (t < 1) requestAnimationFrame(step);
  }
  requestAnimationFrame(step);
}

function _updateIndicators() {
  // Future: update F1–F4 tile indicators in the top bar
}
