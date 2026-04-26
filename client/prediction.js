// ============================================================
// Client-side prediction + reconciliation (R19, per architecture §7).
//
// What this module owns:
//   - Local player input history (last 60 frames @ 60Hz = ~1s)
//   - Predicted player state (subset matching server fields)
//   - Reconciliation when server snapshot arrives
//   - Smooth position correction (200ms interpolation)
//
// What this module does NOT own:
//   - Sending inputs to the server (network.js)
//   - Receiving snapshots (network.js routes them here via apply*)
//   - Rendering (renderer.js reads C++ state which we override via
//     Module._setLocalPlayerNetCorrection)
// ============================================================

import {
    PRED_HISTORY,
    PRED_DIVERGE_POS_THRESHOLD_M,
    PRED_DIVERGE_ROT_THRESHOLD_DEG,
    PRED_SMOOTH_CORRECT_MS,
} from './constants.js';

let nextClientTick = 0;
const inputHistory = [];     // [{tick, input, dt, snapshot}]
let predicted = {
    pos: [0, 0, 0],
    vel: [0, 0, 0],
    rot: [0, 0, 0],
};
let myNumericId = -1;
let lastReconcileTick = -1;
let smoothCorrection = null; // { dx, dy, dz, dyaw, dpitch, startMs }

// Stats exposed for telemetry
export const stats = {
    reconciliations: 0,
    visibleSnaps: 0,
    avgDivergence: 0,
    lastDivergence: 0,
};

export function setLocalNumericId(id) { myNumericId = id; }

export function nextTick() {
    return nextClientTick++;
}

/**
 * Record an input that was just sent to the server.
 * The dt is the simulation step that the C++ side will apply.
 * For R19 we don't run a parallel JS simulation — the C++ side IS the
 * predicted state. We only record inputs for replay-after-reconcile.
 */
export function recordInput(tick, input, dt) {
    inputHistory.push({ tick, input, dt });
    while (inputHistory.length > PRED_HISTORY) inputHistory.shift();
}

/**
 * Called by network.js when a snapshot arrives from the server.
 * Compares server-authoritative position with the predicted local-player
 * state read from WASM, computes a smooth correction if divergence > threshold.
 */
export function reconcile(snapshot, getLocalPlayerWasm) {
    if (!snapshot || !snapshot.players) return;
    const me = snapshot.players.find(p => p.id === myNumericId);
    if (!me) return;
    if (snapshot.tick <= lastReconcileTick) return;
    lastReconcileTick = snapshot.tick;
    stats.visibleSnaps++;

    const local = getLocalPlayerWasm();  // {pos:[3], rot:[3]}
    if (!local) return;

    const dx = me.pos[0] - local.pos[0];
    const dy = me.pos[1] - local.pos[1];
    const dz = me.pos[2] - local.pos[2];
    const distSq = dx * dx + dy * dy + dz * dz;
    const dist = Math.sqrt(distSq);

    const dpitch = me.rot[0] - local.rot[0];
    const dyaw   = me.rot[1] - local.rot[1];
    const rotMag = Math.hypot(dpitch, dyaw) * 180 / Math.PI;

    stats.lastDivergence = dist;
    stats.avgDivergence = stats.avgDivergence * 0.9 + dist * 0.1;

    if (dist > PRED_DIVERGE_POS_THRESHOLD_M || rotMag > PRED_DIVERGE_ROT_THRESHOLD_DEG) {
        stats.reconciliations++;
        // Set up a smooth correction: the WASM state will be nudged toward
        // the server position over PRED_SMOOTH_CORRECT_MS milliseconds.
        smoothCorrection = {
            dx, dy, dz, dyaw, dpitch,
            startMs: performance.now(),
            duration: PRED_SMOOTH_CORRECT_MS,
            initial: { ...local },
        };
    }
}

/**
 * Per-frame call from the renderer loop. Applies any pending smooth
 * correction by nudging the WASM local-player position.
 * setCorrectionFn(x,y,z,yaw,pitch) is bound to Module._setLocalPlayerNetCorrection.
 */
export function applyPendingCorrection(setCorrectionFn, getLocalPlayerWasm) {
    if (!smoothCorrection) return;
    const elapsed = performance.now() - smoothCorrection.startMs;
    const t = Math.min(1, elapsed / smoothCorrection.duration);
    const eased = t * (2 - t); // ease-out quadratic
    const local = getLocalPlayerWasm();
    if (!local) return;
    const targetX = smoothCorrection.initial.pos[0] + smoothCorrection.dx;
    const targetY = smoothCorrection.initial.pos[1] + smoothCorrection.dy;
    const targetZ = smoothCorrection.initial.pos[2] + smoothCorrection.dz;
    const targetYaw   = smoothCorrection.initial.rot[1] + smoothCorrection.dyaw;
    const targetPitch = smoothCorrection.initial.rot[0] + smoothCorrection.dpitch;

    const x = smoothCorrection.initial.pos[0] + (targetX - smoothCorrection.initial.pos[0]) * eased;
    const y = smoothCorrection.initial.pos[1] + (targetY - smoothCorrection.initial.pos[1]) * eased;
    const z = smoothCorrection.initial.pos[2] + (targetZ - smoothCorrection.initial.pos[2]) * eased;
    const yaw   = smoothCorrection.initial.rot[1] + (targetYaw   - smoothCorrection.initial.rot[1]) * eased;
    const pitch = smoothCorrection.initial.rot[0] + (targetPitch - smoothCorrection.initial.rot[0]) * eased;

    setCorrectionFn(x, y, z, yaw, pitch);

    if (t >= 1) smoothCorrection = null;
}

export function reset() {
    nextClientTick = 0;
    inputHistory.length = 0;
    smoothCorrection = null;
    lastReconcileTick = -1;
    stats.reconciliations = 0;
    stats.visibleSnaps = 0;
    stats.avgDivergence = 0;
    stats.lastDivergence = 0;
}
