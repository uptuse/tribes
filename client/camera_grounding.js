/**
 * Camera Grounding — footstrike bob, landing kick, procedural vertical sway.
 * Runs as the last camera transform each frame (after syncCamera positions it).
 * Adds offsets in camera-local space so it works in both 1P and 3P.
 */

// Spring state
const _spring = {
  pitchOff: 0, pitchVel: 0,   // footstrike pitch nudge
  rollOff:  0, rollVel:  0,   // footstrike roll nudge
  yOff:     0, yVel:     0,   // landing Y drop
};

// Bob state
let _bobPhase   = 0;   // driven by locomotion cycle
let _bobAmp     = 0;   // scaled by speed
let _lastSpeed  = 0;

// Landing detection
let _prevVelY = 0;

const STIFFNESS = 18;   // spring stiffness
const DAMPING   = 0.72; // critically damped ≈ 2*sqrt(stiffness)

export const CameraGrounding = {
  /**
   * @param {THREE.Camera} cam   – the live camera
   * @param {number} speed       – horizontal player speed (m/s)
   * @param {number} velY        – vertical velocity (m/s, negative when falling)
   * @param {number} dt          – frame delta
   * @param {boolean} onGround   – player grounded flag
   * @param {number} clipPhase   – animation cycle phase 0–1 (from locomotion)
   */
  update(cam, speed, velY, dt, onGround, clipPhase) {
    if (!cam) return;

    // ── Landing kick ──────────────────────────────────────────
    const impact = _prevVelY - velY;  // positive when hitting ground
    if (onGround && impact > 4) {
      const mag = Math.min(impact * 0.025, 0.08); // scale, cap at 5°
      _spring.pitchVel -= mag;
      _spring.yVel     -= mag * 0.04;
    }
    _prevVelY = velY;

    // ── Footstrike nudge (from clipPhase) ─────────────────────
    if (onGround && speed > 1.0 && clipPhase >= 0) {
      // Fire a small kick twice per cycle (at phase 0 and 0.5)
      const cycle = clipPhase % 1.0;
      const kick  = Math.max(0, Math.cos(cycle * Math.PI * 2)) - 0.5; // +peak at 0 and 0.5
      const amp   = Math.min(speed / 11, 1) * 0.004; // scale with speed, max ~0.23°
      _spring.pitchVel -= kick * amp;
      _spring.rollVel  += kick * amp * 0.35 * (cycle < 0.5 ? 1 : -1);
    }

    // ── Vertical bob ──────────────────────────────────────────
    _bobAmp = onGround ? Math.min(speed / 11, 1) * 0.006 : 0;
    if (_bobAmp > 0.0005 && clipPhase >= 0) {
      _bobPhase = clipPhase;
    }

    // ── Integrate springs ─────────────────────────────────────
    _spring.pitchVel += (-STIFFNESS * _spring.pitchOff - DAMPING * _spring.pitchVel) * dt;
    _spring.pitchOff += _spring.pitchVel * dt;

    _spring.rollVel  += (-STIFFNESS * _spring.rollOff  - DAMPING * _spring.rollVel)  * dt;
    _spring.rollOff  += _spring.rollVel * dt;

    _spring.yVel     += (-STIFFNESS * _spring.yOff     - DAMPING * _spring.yVel)     * dt;
    _spring.yOff     += _spring.yVel * dt;

    // ── Apply to camera ───────────────────────────────────────
    const bob = Math.sin(_bobPhase * Math.PI * 2) * _bobAmp;

    // Euler offsets in camera-local space (added on top of syncCamera's result)
    cam.rotation.x += _spring.pitchOff + bob * 0.4;
    cam.rotation.z += _spring.rollOff;
    cam.position.y += _spring.yOff + bob;
  },

  /** Reset all spring state (call on respawn / mode switch) */
  reset() {
    Object.keys(_spring).forEach(k => { _spring[k] = 0; });
    _bobPhase = _bobAmp = _prevVelY = 0;
  },
};
