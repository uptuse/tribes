// @ai-contract
// PURPOSE: Phase system infrastructure — defines game phases (CLEAR, FOG, STORM,
//   BLIZZARD, NIGHT_OPS) and a hook/listener system so modules can react to
//   phase transitions with gradual interpolation
// SERVES: Adaptation (#1 Core Feeling gap — phases drive tactical variety,
//   visibility changes, and environmental hazards)
// DEPENDS_ON: none (standalone module, consumed by other modules)
// EXPOSES: window.PhaseSystem { Phase, currentPhase, phaseProgress,
//   registerListener(listener), unregisterListener(listener),
//   setPhase(phase, durationSec), update(dt), getVisibilityMultiplier() }
// LIFECYCLE: Self-initializing IIFE. setPhase() starts a transition →
//   update(dt) per frame drives interpolation → listeners notified at
//   start, during, and end of transitions
// PATTERN: IIFE → window.PhaseSystem facade
// COORDINATE_SPACE: N/A (abstract system, no spatial data)
// BEFORE_MODIFY: read docs/lessons-learned.md. Phase transitions must be
//   gradual (never instant). Listeners receive both current and target phase
//   so they can interpolate their own effects
// NEVER: snap phase changes instantly (always interpolate over durationSec)
// ALWAYS: notify all listeners even if durationSec is 0 (with progress=1.0)
// @end-ai-contract
//
// ============================================================
// client/phase_system.js — R32.271
// Phase system hook infrastructure for Firewolf
//
// This module defines the phase enum, listener registration, and
// gradual transition system. Individual modules (sky, weather, combat_fx,
// minimap, etc.) register as listeners and receive onPhaseChange callbacks.
//
// No actual phase GAMEPLAY is implemented here — just the hook infrastructure
// that other modules will consume when phases are gameplay-ready.
// ============================================================

(function () {
    'use strict';
    if (typeof window === 'undefined') return;

    // ── Phase Enum ──────────────────────────────────────────
    const Phase = Object.freeze({
        CLEAR:     0,  // Default — full visibility, normal conditions
        FOG:       1,  // Reduced visibility (render distance drops)
        STORM:     2,  // Rain/wind, moderate visibility loss, lightning
        BLIZZARD:  3,  // Heavy snow, severe visibility loss, movement penalty
        NIGHT_OPS: 4,  // Near-zero ambient light, IR/flare mechanics
    });

    const PHASE_NAMES = Object.freeze(['CLEAR', 'FOG', 'STORM', 'BLIZZARD', 'NIGHT_OPS']);

    // ── State ───────────────────────────────────────────────
    let _currentPhase = Phase.CLEAR;
    let _targetPhase = Phase.CLEAR;
    let _transitionProgress = 1.0;  // 0.0 = just started, 1.0 = complete
    let _transitionDuration = 0;
    let _transitionElapsed = 0;
    let _transitioning = false;

    // ── Listeners ───────────────────────────────────────────
    // Each listener is an object with:
    //   onPhaseChange({ fromPhase, toPhase, progress, complete })
    // Called every frame during transition, and once with complete=true at end
    const _listeners = new Set();

    function registerListener(listener) {
        if (listener && typeof listener.onPhaseChange === 'function') {
            _listeners.add(listener);
        } else {
            console.warn('[PhaseSystem] registerListener: listener must have onPhaseChange(event) method');
        }
    }

    function unregisterListener(listener) {
        _listeners.delete(listener);
    }

    // ── Phase Transitions ───────────────────────────────────

    /**
     * Begin transitioning to a new phase.
     * @param {number} phase - Phase enum value (Phase.CLEAR, Phase.FOG, etc.)
     * @param {number} durationSec - Transition duration in seconds (0 = instant but still notifies)
     */
    function setPhase(phase, durationSec) {
        if (phase === _currentPhase && !_transitioning) return; // already there
        if (phase < 0 || phase > 4) {
            console.warn('[PhaseSystem] Invalid phase:', phase);
            return;
        }

        _targetPhase = phase;
        _transitionDuration = Math.max(0, durationSec || 0);
        _transitionElapsed = 0;
        _transitionProgress = 0;
        _transitioning = true;

        // Notify start
        _notifyListeners(false);

        // Instant transition
        if (_transitionDuration <= 0) {
            _completeTransition();
        }

        if (window.DEBUG_LOGS) {
            console.log('[PhaseSystem] Transition:', PHASE_NAMES[_currentPhase], '→',
                PHASE_NAMES[_targetPhase], '(' + _transitionDuration.toFixed(1) + 's)');
        }
    }

    /**
     * Called every frame from the main render loop.
     * @param {number} dt - Delta time in seconds
     */
    function update(dt) {
        if (!_transitioning) return;

        _transitionElapsed += dt;
        _transitionProgress = _transitionDuration > 0
            ? Math.min(1.0, _transitionElapsed / _transitionDuration)
            : 1.0;

        // Smooth easing (ease-in-out cubic)
        const t = _transitionProgress;
        const eased = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;

        _notifyListeners(false);

        if (_transitionProgress >= 1.0) {
            _completeTransition();
        }
    }

    function _completeTransition() {
        _currentPhase = _targetPhase;
        _transitionProgress = 1.0;
        _transitioning = false;
        _notifyListeners(true);
    }

    function _notifyListeners(complete) {
        const event = {
            fromPhase: _currentPhase,
            toPhase: _targetPhase,
            progress: _transitionProgress,
            // Smooth eased progress for visual interpolation
            easedProgress: _transitionProgress < 0.5
                ? 4 * _transitionProgress * _transitionProgress * _transitionProgress
                : 1 - Math.pow(-2 * _transitionProgress + 2, 3) / 2,
            complete: !!complete,
            phaseName: PHASE_NAMES[_targetPhase],
        };
        for (const listener of _listeners) {
            try {
                listener.onPhaseChange(event);
            } catch (e) {
                console.error('[PhaseSystem] Listener error:', e);
            }
        }
    }

    // ── Utility ─────────────────────────────────────────────

    /**
     * Returns a visibility multiplier (0.0–1.0) based on current phase state.
     * Modules can use this for fog distance, render distance, etc.
     */
    function getVisibilityMultiplier() {
        // During transition, interpolate between from/to visibility
        const fromVis = _phaseVisibility(_currentPhase);
        const toVis = _phaseVisibility(_targetPhase);
        if (!_transitioning) return fromVis;
        const t = _transitionProgress < 0.5
            ? 4 * _transitionProgress * _transitionProgress * _transitionProgress
            : 1 - Math.pow(-2 * _transitionProgress + 2, 3) / 2;
        return fromVis + (toVis - fromVis) * t;
    }

    function _phaseVisibility(phase) {
        switch (phase) {
            case Phase.CLEAR:     return 1.0;
            case Phase.FOG:       return 0.5;
            case Phase.STORM:     return 0.35;
            case Phase.BLIZZARD:  return 0.15;
            case Phase.NIGHT_OPS: return 0.25;
            default:              return 1.0;
        }
    }

    // ── Public API ──────────────────────────────────────────
    window.PhaseSystem = {
        Phase: Phase,
        PHASE_NAMES: PHASE_NAMES,
        get currentPhase() { return _currentPhase; },
        get targetPhase() { return _targetPhase; },
        get transitioning() { return _transitioning; },
        get phaseProgress() { return _transitionProgress; },
        registerListener: registerListener,
        unregisterListener: unregisterListener,
        setPhase: setPhase,
        update: update,
        getVisibilityMultiplier: getVisibilityMultiplier,
    };

    if (window.DEBUG_LOGS) {
        console.log('[R32.271] PhaseSystem initialized. Starting phase: CLEAR');
    }
})();
