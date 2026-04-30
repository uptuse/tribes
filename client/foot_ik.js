/**
 * Foot IK — terrain-contact placement for the character's feet.
 * After the animation mixer updates, raycasts downward from each foot bone
 * and lifts the foot to terrain height. Ankle/knee receive a proportional
 * fraction so the leg doesn't look dislocated.
 *
 * Simple position-lift approach (plan §L4): no full two-bone IK solver.
 * Disable during skiing (own pose) and while airborne (no contact).
 */

import * as THREE from 'three';

const _origin = new THREE.Vector3();

// Typical Mixamo foot bone names (case-insensitive match)
const LEFT_FOOT_NAMES  = ['leftfoot', 'left_foot', 'lfoot', 'foot_l', 'mixamorigLeftFoot'];
const RIGHT_FOOT_NAMES = ['rightfoot','right_foot','rfoot', 'foot_r', 'mixamorigRightFoot'];
const LEFT_LOWER_LEG   = ['leftleg',  'left_lower_leg', 'mixamorigLeftLeg'];
const RIGHT_LOWER_LEG  = ['rightleg', 'right_lower_leg','mixamorigRightLeg'];

const FOOT_OFFSET   = 0.04;   // metres above terrain surface
const SMOOTH        = 0.25;   // lerp factor — don't snap
const MAX_LIFT      = 0.40;   // cap how much we lift in one frame

// Per-instance cache of found bone refs
const _cache = new Map();

export const FootIK = {
  /**
   * @param inst   – character instance (has .model with skeleton)
   * @param onGround – from physics; disable IK while airborne
   * @param skiing   – disable IK during ski pose
   */
  update(inst, onGround, skiing) {
    if (!inst?.model || !onGround || skiing) return;
    const terrain = window.__terrainMesh;
    if (!terrain) return;
    // Heightmap lookup is O(1) — no throttle needed

    let bones = _cache.get(inst);
    if (!bones) {
      bones = _findBones(inst.model);
      _cache.set(inst, bones);
      if (!bones) return;
    }

    _applyFootIK(bones.lFoot, bones.lLeg, terrain);
    _applyFootIK(bones.rFoot, bones.rLeg, terrain);
  },

  remove(inst) { _cache.delete(inst); },
};

function _findBones(model) {
  const map = {};
  model.traverse(obj => {
    if (!obj.isBone) return;
    const n = obj.name.toLowerCase().replace(/[\s_-]/g, '');
    if (LEFT_FOOT_NAMES.some(k  => n.includes(k.toLowerCase().replace(/[\s_-]/g,'')))) map.lFoot = obj;
    if (RIGHT_FOOT_NAMES.some(k => n.includes(k.toLowerCase().replace(/[\s_-]/g,'')))) map.rFoot = obj;
    if (LEFT_LOWER_LEG.some(k   => n.includes(k.toLowerCase().replace(/[\s_-]/g,'')))) map.lLeg  = obj;
    if (RIGHT_LOWER_LEG.some(k  => n.includes(k.toLowerCase().replace(/[\s_-]/g,'')))) map.rLeg  = obj;
  });
  return (map.lFoot && map.rFoot) ? map : null;
}

function _sampleTerrainHeight(wx, wz) {
  // Direct heightmap lookup — O(1), no raycast against 131K triangles
  if (!window.Module?._getHeightmapPtr) return null;
  try {
    const TSCALE = Module._getHeightmapWorldScale?.() ?? 8;
    const TSIZE  = Module._getHeightmapSize?.() ?? 257;
    const hPtr   = Module._getHeightmapPtr();
    const hmap   = new Float32Array(Module.HEAPF32.buffer, hPtr, TSIZE * TSIZE);
    const gx     = Math.max(0, Math.min(TSIZE-1, Math.round(wx / TSCALE + TSIZE * 0.5)));
    const gz     = Math.max(0, Math.min(TSIZE-1, Math.round(wz / TSCALE + TSIZE * 0.5)));
    return hmap[gz * TSIZE + gx];
  } catch(e) { return null; }
}

function _applyFootIK(footBone, lowerLeg, terrain) {
  if (!footBone) return;

  footBone.updateWorldMatrix(true, false);
  _origin.setFromMatrixPosition(footBone.matrixWorld);

  const terrainY = _sampleTerrainHeight(_origin.x, _origin.z);
  if (terrainY === null) return;

  const desiredY = terrainY + FOOT_OFFSET;
  const currentY = _origin.y - 0.30;
  const delta    = desiredY - currentY;

  // Only lift, never push into ground (avoids leg-stretch artifacts)
  if (delta <= 0.001) return;
  const lift = Math.min(delta * SMOOTH, MAX_LIFT);

  // Apply to foot bone in local space
  footBone.position.y += lift;

  // Propagate 40% to lower leg (knee), keeps silhouette plausible
  if (lowerLeg) lowerLeg.position.y += lift * 0.4;
}
