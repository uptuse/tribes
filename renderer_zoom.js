// @ai-contract
// PURPOSE: Scope zoom system — right-mouse-button hold for smooth 2x zoom,
//   Z key tap to cycle through 1x/2x/4x stops. Includes scope reticle overlay
//   and mouse sensitivity reduction during zoom
// SERVES: Scale (zooming to 400m target IS the sensation of scale),
//   Adaptation (zoom is a tactical awareness tradeoff)
// DEPENDS_ON: window.DEBUG_LOGS
// EXPOSES: window.ZoomFX { getFovMultiplier(), isActive(), boot() }
// LIFECYCLE: boot() on load binds mouse/key events + starts own RAF →
//   getFovMultiplier() read per frame by renderer.js to fold into FOV computation.
//   Runs own RAF loop (architecture issue — should be called from main loop)
// PATTERN: IIFE → window.ZoomFX facade
// BEFORE_MODIFY: read docs/lessons-learned.md. Self-driven RAF loop should
//   eventually be removed (call tick from main loop). FOV multiplier is in (0,1]
//   range — renderer.js multiplies C++ FOV by this value
// NEVER: return getFovMultiplier() > 1.0 or ≤ 0 (would invert/zero the camera)
// ALWAYS: preserve RMB + Z key bindings (matches Tribes 1 controls)
// @end-ai-contract
//
// renderer_zoom.js — R32.18-manus
// =============================================================================
// Tribes-style zoom system.
//
// Bindings:
//   Right-mouse-button (hold)   — smooth ramp to 2x while held, ramp back on
//                                  release. Like T1's "weapon zoom" for non-
//                                  sniper rifles.
//   Z (tap)                     — step through stops: 1x → 2x → 4x → 1x.
//                                  Like T1's sniper rifle scope levels.
//
// The module exposes window.ZoomFX with:
//   getFovMultiplier()  -> Number in (0,1].  renderer.js multiplies the
//                          C++-supplied FOV by this to apply zoom.
//   isActive()          -> Boolean. True if any zoom > 1x is active.
//
// Renderer.js reads getFovMultiplier each frame and folds it into the FOV
// computation. Mouse-look sensitivity reduction and scope reticle visibility
// are driven from this module's DOM overlay.
// =============================================================================

(function() {
    'use strict';
    if (window.DEBUG_LOGS) console.log('[ZoomFX] module loading…');

    const STATE = {
        // Right-mouse hold
        rmbHeld: false,
        rmbZoom: 1.0,           // current smoothed zoom factor (1.0 = no zoom)
        rmbTargetZoom: 1.0,
        rmbMaxZoom: 2.0,        // T1 default for non-sniper "weapon zoom"

        // Z stepped zoom
        stepIdx: 0,
        steps: [1.0, 2.0, 4.0],

        // Combined effective zoom = max(rmbZoom, steps[stepIdx])
        effective: 1.0,

        // Last frame timestamp (for smoothing)
        lastT: 0,

        // DOM
        reticle: null,
        levelLabel: null,
    };

    // -------------------------------------------------------------------------
    // DOM: scope reticle + zoom-level label
    // -------------------------------------------------------------------------
    function _buildOverlay() {
        if (STATE.reticle) return;

        // Reticle: a centered SVG with crosshair + range markings + corner
        // brackets. Faded in/out via opacity.
        const wrap = document.createElement('div');
        wrap.id = 'zoom-reticle';
        wrap.style.cssText = [
            'position:fixed', 'inset:0',
            'pointer-events:none',
            'z-index:60',
            'opacity:0',
            'transition:opacity 0.18s ease-out',
        ].join(';') + ';';

        wrap.innerHTML = `
          <svg width="100%" height="100%" viewBox="0 0 100 100"
               preserveAspectRatio="xMidYMid meet"
               style="position:absolute;inset:0;">
            <!-- no vignette — clean zoom without darkened edges -->
            <!-- center crosshair: thin -->
            <g stroke="#FFC850" stroke-width="0.12" fill="none" opacity="0.9">
              <line x1="50" y1="42" x2="50" y2="48"/>
              <line x1="50" y1="52" x2="50" y2="58"/>
              <line x1="42" y1="50" x2="48" y2="50"/>
              <line x1="52" y1="50" x2="58" y2="50"/>
              <!-- center dot -->
              <circle cx="50" cy="50" r="0.18" fill="#FFC850"/>
              <!-- mil-dot range markings down the vertical -->
              <line x1="49.4" y1="62" x2="50.6" y2="62" stroke-width="0.10"/>
              <line x1="49.6" y1="68" x2="50.4" y2="68" stroke-width="0.08"/>
              <line x1="49.4" y1="38" x2="50.6" y2="38" stroke-width="0.10"/>
              <line x1="49.6" y1="32" x2="50.4" y2="32" stroke-width="0.08"/>
              <!-- corner brackets (look "scope-y") -->
              <path d="M30 30 L30 33 M30 30 L33 30" stroke-width="0.20"/>
              <path d="M70 30 L70 33 M70 30 L67 30" stroke-width="0.20"/>
              <path d="M30 70 L30 67 M30 70 L33 70" stroke-width="0.20"/>
              <path d="M70 70 L70 67 M70 70 L67 70" stroke-width="0.20"/>
            </g>
          </svg>`;

        document.body.appendChild(wrap);
        STATE.reticle = wrap;

        // Zoom-level label, top-right
        const lbl = document.createElement('div');
        lbl.id = 'zoom-level-label';
        lbl.style.cssText = [
            'position:fixed',
            'top:14px', 'right:14px',
            'z-index:65',
            'font-family:"Courier New",monospace',
            'font-size:13px',
            'color:#FFC850',
            'background:rgba(2,8,16,0.55)',
            'border:1px solid rgba(255,200,80,0.4)',
            'padding:4px 10px',
            'letter-spacing:0.12em',
            'pointer-events:none',
            'opacity:0',
            'transition:opacity 0.18s ease-out',
        ].join(';') + ';';
        lbl.textContent = 'ZOOM 1.0×';
        document.body.appendChild(lbl);
        STATE.levelLabel = lbl;
    }

    // -------------------------------------------------------------------------
    // Input
    // -------------------------------------------------------------------------
    function _bindInput() {
        // Right-mouse hold
        window.addEventListener('mousedown', e => {
            if (e.button === 2) { STATE.rmbHeld = true; STATE.rmbTargetZoom = STATE.rmbMaxZoom; }
        }, true);
        window.addEventListener('mouseup', e => {
            if (e.button === 2) { STATE.rmbHeld = false; STATE.rmbTargetZoom = 1.0; }
        }, true);

        // Suppress browser context menu so right-click works as a game button
        window.addEventListener('contextmenu', e => { e.preventDefault(); }, true);

        // Z stepped
        window.addEventListener('keydown', e => {
            if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) return;
            if (e.ctrlKey || e.metaKey || e.altKey) return;
            if (e.key === 'z' || e.key === 'Z' || e.code === 'KeyZ') {
                e.preventDefault();
                STATE.stepIdx = (STATE.stepIdx + 1) % STATE.steps.length;
                if (window.DEBUG_LOGS) console.log('[ZoomFX] Z step → ' + STATE.steps[STATE.stepIdx] + 'x');
            }
        }, true);
    }

    // -------------------------------------------------------------------------
    // Per-frame tick: smooth rmbZoom toward target, compute effective zoom,
    // update reticle / label opacity.
    // -------------------------------------------------------------------------
    function tick() {
        const now = performance.now();
        const dt = STATE.lastT ? Math.min(0.05, (now - STATE.lastT) / 1000) : 0.016;
        STATE.lastT = now;

        // Smooth right-mouse zoom (180ms time constant)
        const k = 1 - Math.exp(-dt / 0.18);
        STATE.rmbZoom += (STATE.rmbTargetZoom - STATE.rmbZoom) * k;

        // Effective zoom = max of stepped + RMB
        const stepped = STATE.steps[STATE.stepIdx];
        STATE.effective = Math.max(stepped, STATE.rmbZoom);

        // Show overlay if any zoom > 1.05x
        const showing = STATE.effective > 1.05;
        if (STATE.reticle) STATE.reticle.style.opacity = showing ? '1' : '0';
        if (STATE.levelLabel) {
            STATE.levelLabel.style.opacity = showing ? '1' : '0';
            STATE.levelLabel.textContent = 'ZOOM ' + STATE.effective.toFixed(1) + '×';
        }
    }

    // -------------------------------------------------------------------------
    // Public API
    // -------------------------------------------------------------------------
    window.ZoomFX = {
        getFovMultiplier: () => 1.0 / STATE.effective,
        isActive: () => STATE.effective > 1.05,
        getEffectiveZoom: () => STATE.effective,
        tick: tick,
        // For mouse-look sensitivity scaling (renderer or input layer can divide
        // by this to make zoomed look slower → reads more like a scope)
        getSensitivityScale: () => 1.0 / Math.sqrt(STATE.effective),
    };

    // -------------------------------------------------------------------------
    // Boot
    // -------------------------------------------------------------------------
    function _boot() {
        _buildOverlay();
        _bindInput();

        // R32.167: No self-driven RAF loop. renderer.js calls ZoomFX.tick()
        // from its main render loop, keeping all animation on one RAF.
        if (window.DEBUG_LOGS) console.log('[ZoomFX] ready — RMB hold for 2× weapon zoom, Z to cycle 1×/2×/4×');
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', _boot);
    } else {
        _boot();
    }
})();
