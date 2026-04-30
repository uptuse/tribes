/**
 * EventBus — lightweight event dispatcher for the Bindings system.
 * On boot: loads data/bindings.json and registers VFX/audio reactions.
 * C++ fires events via EM_ASM calls; JS routes to registered handlers.
 */
import { log } from './shell.js';

const _handlers = new Map(); // eventId → [fn, fn, ...]
let _bindings   = [];        // loaded from bindings.json

export const EventBus = {
  // Register a handler function for an event id
  on(eventId, fn) {
    if (!_handlers.has(eventId)) _handlers.set(eventId, []);
    _handlers.get(eventId).push(fn);
  },

  // Fire all handlers for an event
  fire(eventId, payload = {}) {
    const fns = _handlers.get(eventId);
    if (!fns?.length) return;
    fns.forEach(fn => { try { fn(payload); } catch(e) { console.warn('[EventBus]', e); } });
  },

  // Load bindings.json and register its reactions
  async load(url = '/data/bindings.json') {
    try {
      const resp = await fetch(url);
      if (!resp.ok) return;
      const data = await resp.json();
      _bindings = data.bindings ?? [];
      _register();
      log(`Loaded ${_bindings.length} binding(s)`);
    } catch(e) {
      // bindings.json not present yet — fine, feature is optional
    }
  },

  // Re-apply after editing
  reload(jsonStr) {
    try {
      const data = JSON.parse(jsonStr);
      _bindings = data.bindings ?? [];
      // Clear old handlers
      _handlers.clear();
      _register();
      log(`Bindings reloaded — ${_bindings.length} bindings`);
    } catch(e) { console.warn('[EventBus] reload failed:', e); }
  },
};

function _register() {
  _bindings.forEach(binding => {
    EventBus.on(binding.event_id, (payload) => {
      binding.reactions?.forEach(reaction => {
        setTimeout(() => _dispatch(reaction, payload), reaction.delay_ms ?? 0);
      });
    });
  });
}

function _dispatch(reaction, payload) {
  const pos = payload.pos ?? window.__editorCursorWorld ?? null;
  if (reaction.kind === 'vfx' && pos) {
    // Spawn effect at event position
    try { window.triggerExplosion?.(pos.x, pos.y, pos.z, 0.6); } catch(e) {}
  }
  if (reaction.kind === 'audio') {
    // Play audio event via existing engine
    if (window.AE?.ctx) {
      try {
        const osc  = window.AE.ctx.createOscillator();
        const gain = window.AE.ctx.createGain();
        osc.frequency.value = 440;
        gain.gain.value = 0.2;
        osc.connect(gain); gain.connect(window.AE.ctx.destination);
        osc.start(); osc.stop(window.AE.ctx.currentTime + 0.12);
      } catch(e) {}
    }
  }
}

// Expose globally so C++ EM_ASM calls can reach it
window.__eventBusFire = (id, x, y, z) => EventBus.fire(id, { pos: { x, y, z } });
