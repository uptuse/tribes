/**
 * Locomotion — speed-matched stride, walk/run blend, ski posture, footstrike events.
 * Drives THREE.AnimationMixer timeScale based on actual player velocity so feet
 * appear to plant on the ground at all speeds rather than sliding on a conveyor belt.
 *
 * Natural speeds (metres/second one full cycle covers):
 *   Measured from crimson_sentinel_rigged.glb in animation_editor.html.
 *   run:  ~3.8 m/s  (Mixamo full sprint at 0.01 scale)
 *   idle: 0 m/s
 *   ski:  0 m/s (pose hold, not cyclic)
 *   jet:  0 m/s (hover pose)
 */

import * as THREE from 'three';

// Natural ground speed of each clip (measured or estimated from GLB)
const NATURAL_SPEED = {
  run:  3.8,
  idle: 0,
  ski:  0,
  jet:  0,
  death: 0,
  fire_rifle: 0,
};

// Per-instance state
const _state = new Map(); // inst → { lastClip, leftPhase, rightPhase, lastY }

// Footstrike phase markers (0–1 within cycle)
// Left foot down ≈ 0.0, right foot down ≈ 0.5 for a typical bipedal run
const LEFT_STRIKE  = 0.02;
const RIGHT_STRIKE = 0.52;
const STRIKE_WINDOW = 0.06; // fraction of cycle — fire event once per pass

export const Locomotion = {
  /** Call once per frame per character instance after Characters.sync picks the clip */
  update(inst, speed, clipName, dt) {
    if (!inst?.mixer || !inst?.activeAction) return;

    const action = inst.activeAction;
    const clip   = action.getClip();
    if (!clip) return;

    const nat = NATURAL_SPEED[clipName] ?? NATURAL_SPEED[clip.name] ?? 0;

    // ── Speed-matched timeScale ───────────────────────────────
    if (nat > 0.1 && speed > 0.1) {
      // Clamp to avoid absurd rates at extreme Tribes speeds.
      // Above 3× natural the feet become a blur anyway; it still looks better
      // than sliding because the cycle does at least advance with movement.
      action.timeScale = Math.min(speed / nat, 3.5);
    } else {
      action.timeScale = 1.0;
    }

    // ── Footstrike event detection ────────────────────────────
    if (!_state.has(inst)) _state.set(inst, { leftFired: false, rightFired: false });
    const st = _state.get(inst);

    if (nat > 0.1 && clip.duration > 0) {
      const phase = (action.time % clip.duration) / clip.duration;

      window.__locoPhase = phase;  // shared with camera_grounding.js
      const nearLeft  = Math.abs(phase - LEFT_STRIKE)  < STRIKE_WINDOW;
      const nearRight = Math.abs(phase - RIGHT_STRIKE) < STRIKE_WINDOW;

      if (nearLeft && !st.leftFired) {
        st.leftFired = true;
        window.__eventBusFire?.('player.on_footstep_left', 0, 0, 0);
      } else if (!nearLeft) { st.leftFired = false; }

      if (nearRight && !st.rightFired) {
        st.rightFired = true;
        window.__eventBusFire?.('player.on_footstep_right', 0, 0, 0);
      } else if (!nearRight) { st.rightFired = false; }
    }
  },

  /** Detect hard landing from velocity sign change; call each frame for local player */
  checkLanding(velY, prevVelY) {
    if (prevVelY < -6 && velY > prevVelY + 2) {
      const impact = Math.abs(prevVelY);
      if (impact > 12) {
        window.__eventBusFire?.('player.on_landing_hard', 0, 0, 0);
      } else {
        window.__eventBusFire?.('player.on_landing_soft', 0, 0, 0);
      }
    }
  },

  /** L6: ski posture — crouching, lean into turns, emit ski_compress events */
  skiUpdate(inst, skiing, speed, turnInput, dt) {
    if (!inst?.model) return;

    // Find pelvis / hips
    let pelvis = null;
    inst.model.traverse(obj => {
      if (pelvis) return;
      const n = obj.name.toLowerCase();
      if (n.includes('hips') || n.includes('pelvis')) pelvis = obj;
    });

    // Crouch target: pelvis drops 8cm while skiing
    if (!inst._skiCrouch) inst._skiCrouch = 0;
    const crouchTarget = skiing ? -0.08 : 0;
    inst._skiCrouch += (crouchTarget - inst._skiCrouch) * Math.min(1, dt * 8); // ~10-frame ease

    if (pelvis) {
      pelvis.position.y += inst._skiCrouch;
      // Roll upper body into the turn direction (5-15°)
      if (skiing) {
        const rollTarget = turnInput * 0.12;
        if (!inst._skiRoll) inst._skiRoll = 0;
        inst._skiRoll += (rollTarget - inst._skiRoll) * Math.min(1, dt * 5);
        pelvis.rotation.z += inst._skiRoll;
      }
    }

    // Periodic ski_compress event while skiing at speed
    if (skiing && speed > 5) {
      if (!inst._skiCompressTimer) inst._skiCompressTimer = 0;
      inst._skiCompressTimer += dt;
      if (inst._skiCompressTimer > 0.1) {  // 10 Hz
        inst._skiCompressTimer = 0;
        window.__eventBusFire?.('player.on_ski_compress', 0, 0, 0);
      }
    } else {
      if (inst) inst._skiCompressTimer = 0;
    }
  },

  /** L5: procedural pelvis bob — call after mixer.update, before FootIK */
  pelvisBob(inst, speed, clipPhase) {
    if (!inst?.model || clipPhase < 0 || speed < 0.5) return;
    let pelvis = null;
    inst.model.traverse(obj => {
      if (pelvis) return;
      const n = obj.name.toLowerCase();
      if (n.includes('hips') || n.includes('pelvis') || n.includes('root')) pelvis = obj;
    });
    if (!pelvis) return;
    const amp = Math.min(speed / 11, 1) * 0.03;   // 0→3cm
    const hip = Math.min(speed / 11, 1) * 0.018;  // 0→1.8cm lateral
    pelvis.position.y += Math.sin(clipPhase * Math.PI * 2) * amp;
    pelvis.rotation.y += Math.sin(clipPhase * Math.PI * 2 + Math.PI / 2) * 0.035; // counter-rotation
  },

  /** Clean up state for a removed instance */
  remove(inst) { _state.delete(inst); },
};
