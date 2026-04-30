/**
 * History — global undo/redo stack.
 * Every placement or edit pushes { apply, revert, label }.
 * Ctrl+Z reverts; Ctrl+Shift+Z (or Ctrl+Y) re-applies.
 */
import { log } from '../shell.js';

const MAX_DEPTH = 64;
let _stack  = [];   // committed actions (oldest → newest)
let _future = [];   // undone actions available to redo

export const History = {
  init() { _stack = []; _future = []; },

  push(action) {
    // { apply: fn, revert: fn, label: string }
    _stack.push(action);
    if (_stack.length > MAX_DEPTH) _stack.shift();
    _future = [];  // clear redo branch on new action
  },

  undo() {
    const action = _stack.pop();
    if (!action) { log('Nothing to undo'); return; }
    try { action.revert(); } catch(e) { console.warn('[History] revert failed:', e); }
    _future.push(action);
    log(`Undid: ${action.label}`);
  },

  redo() {
    const action = _future.pop();
    if (!action) { log('Nothing to redo'); return; }
    try { action.apply(); } catch(e) { console.warn('[History] re-apply failed:', e); }
    _stack.push(action);
    log(`Redid: ${action.label}`);
  },

  clear() { _stack = []; _future = []; },
};
