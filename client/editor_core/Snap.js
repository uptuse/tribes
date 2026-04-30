/**
 * Snap — global placement snap.
 * Default ON. G cycles modes. Shift suppresses temporarily.
 */
import { log } from '../shell.js';

const MODES = ['off', '0.5', '1', '4'];  // metres (string for display)
const VALS  = [0,     0.5,    1,   4];

let _modeIdx    = 3;   // default 4m
let _suppressed = false;

export const Snap = {
  init() { _modeIdx = 3; _suppressed = false; },

  get active()   { return !_suppressed && VALS[_modeIdx] > 0; },
  get gridSize() { return VALS[_modeIdx]; },
  get label()    { return VALS[_modeIdx] > 0 ? `Snap ${MODES[_modeIdx]} m` : 'Snap off'; },

  suppress(on)  { _suppressed = on; },

  cycle() {
    _modeIdx = (_modeIdx + 1) % MODES.length;
    log(Snap.label);
  },

  // Snap a world position to the current grid
  snap(v) {
    if (!Snap.active) return v;
    const g = Snap.gridSize;
    return Math.round(v / g) * g;
  },

  snapVec3(pt) {
    if (!Snap.active) return pt;
    const g = Snap.gridSize;
    return {
      x: Math.round(pt.x / g) * g,
      y: pt.y,   // never snap Y (vertical) — let terrain surface win
      z: Math.round(pt.z / g) * g,
    };
  },
};
