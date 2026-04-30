/**
 * Selection — box-select and Ctrl+click for group ops.
 * Ctrl+click adds/removes from selection.
 * Left-drag on empty space draws a selection box (TODO: 2D screen-space rect).
 * Group ops: Delete, Move, Rotate, Duplicate.
 */
import { log } from '../shell.js';
import { History } from './History.js';

let _selected = new Set();   // Set of THREE.Object3D
let _scene    = null;

export const Selection = {
  init(scene) { _scene = scene; },

  add(obj) {
    _selected.add(obj);
    _applyOutline(obj, true);
  },

  remove(obj) {
    _selected.delete(obj);
    _applyOutline(obj, false);
  },

  clear() {
    _selected.forEach(obj => _applyOutline(obj, false));
    _selected.clear();
  },

  toggle(obj) {
    if (_selected.has(obj)) Selection.remove(obj);
    else                     Selection.add(obj);
  },

  has(obj) { return _selected.has(obj); },

  forEach(cb) { _selected.forEach(cb); },

  get size() { return _selected.size; },

  deleteSelected() {
    if (!_selected.size) return;
    const objs = [..._selected];
    History.push({
      label: `Delete ${objs.length} object(s)`,
      apply:  () => { objs.forEach(o => _scene?.remove(o)); _selected.clear(); },
      revert: () => { objs.forEach(o => _scene?.add(o));    objs.forEach(o => _selected.add(o)); },
    });
    objs.forEach(o => _scene?.remove(o));
    _selected.clear();
    log(`Deleted ${objs.length} object${objs.length > 1 ? 's' : ''}`);
  },

  duplicateSelected() {
    if (!_selected.size) return;
    const THREE = window.__THREE;
    if (!THREE) return;
    [..._selected].forEach(orig => {
      const copy = orig.clone();
      copy.position.x += 1;  // slight offset
      _scene?.add(copy);
      Selection.clear();
      Selection.add(copy);
    });
    log(`Duplicated ${_selected.size} object(s)`);
  },
};

// Amber-tinted emissive as a selection indicator
function _applyOutline(obj, on) {
  try {
    obj.traverse(c => {
      if (c.isMesh && c.material) {
        if (on) {
          c.userData._prevEmissive = c.material.emissive?.getHex?.() ?? 0;
          c.material.emissive?.setHex(0xe89030);
          c.material.emissiveIntensity = 0.5;
        } else {
          c.material.emissive?.setHex(c.userData._prevEmissive ?? 0);
          c.material.emissiveIntensity = c.userData._prevIntensity ?? 0;
        }
      }
    });
  } catch(e) {}
}
