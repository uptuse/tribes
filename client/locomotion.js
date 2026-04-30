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

  /** Clean up state for a removed instance */
  remove(inst) { _state.delete(inst); },
};
