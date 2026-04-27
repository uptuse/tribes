// renderer_cohesion.js — R32.25
// Visual Cohesion polish bundle:
//   #2.9  Ambient mood-bed audio loop (procedural low drone)
//   #2.10 Sub-perceptual camera breathing (organic micro-jitter)
//
// Designed to be loaded via classic <script> tag from index.html, same
// pattern as renderer_palette / renderer_toonify / renderer_command_map.
//
// Public API:
//   window.Cohesion.init(THREE, camera) — called once from renderer.js
//                                          after the scene is built.
//   window.Cohesion.tick(t)             — called every frame from the
//                                          render loop with elapsed seconds.
(function () {
    'use strict';
    if (typeof window === 'undefined') return;

    let _camera = null;
    let _t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now()) / 1000;
    let _audioStarted = false;

    // -------------------------------------------------------------------
    // #2.10 — sub-perceptual camera breathing
    // The camera in Three.js is a child of the rig that follows the player.
    // Adding tiny per-frame offsets to its `.position` would fight the
    // sync-from-WASM path. Instead we offset the camera's local rotation
    // by ~0.0008 rad on two axes — invisible alone, but the lack of it
    // is what makes a render feel sterile.
    // -------------------------------------------------------------------
    function _applyBreathing(t) {
        if (!_camera) return;
        const rotX = Math.sin(t * 0.42) * 0.0009;
        const rotZ = Math.sin(t * 0.27 + 1.3) * 0.0006;
        if (_camera.userData._cohRotApplied) {
            // Subtract previous frame's contribution before applying new
            // one so we don't drift the rig.
            _camera.rotation.x -= _camera.userData._cohRotApplied.x;
            _camera.rotation.z -= _camera.userData._cohRotApplied.z;
        }
        _camera.rotation.x += rotX;
        _camera.rotation.z += rotZ;
        _camera.userData._cohRotApplied = { x: rotX, z: rotZ };
    }

    // -------------------------------------------------------------------
    // #2.9 — ambient mood bed
    // Generate a low-frequency drone via the WebAudio API. Two detuned
    // sawtooth oscillators @ 55Hz / 55.4Hz with a heavy lowpass and very
    // low gain. Runs for the duration of the page; the listener gets used
    // to it within seconds and stops consciously hearing it, which is
    // exactly what an environmental mood bed should do.
    //
    // Browser autoplay policy requires the user to interact with the page
    // before AudioContext can start. We attempt to start on first
    // interaction (pointerdown) and reuse the existing window.AE context
    // if the game has one.
    // -------------------------------------------------------------------
    function _startMoodBed() {
        if (_audioStarted) return;
        try {
            const ctx = (window.AE && window.AE.ctx) ||
                        new (window.AudioContext || window.webkitAudioContext)();
            if (!ctx) return;
            if (ctx.state === 'suspended') ctx.resume();

            const out = ctx.destination;

            // Two detuned saws, low Q lowpass, gentle LFO on filter cutoff.
            const o1 = ctx.createOscillator();
            o1.type = 'sawtooth';
            o1.frequency.value = 55.0;
            const o2 = ctx.createOscillator();
            o2.type = 'sawtooth';
            o2.frequency.value = 55.42;

            const filter = ctx.createBiquadFilter();
            filter.type = 'lowpass';
            filter.frequency.value = 220;
            filter.Q.value = 0.7;

            const lfo = ctx.createOscillator();
            lfo.type = 'sine';
            lfo.frequency.value = 0.07;
            const lfoGain = ctx.createGain();
            lfoGain.gain.value = 35;
            lfo.connect(lfoGain).connect(filter.frequency);

            const gain = ctx.createGain();
            gain.gain.value = 0.0;       // ramp from silence to avoid click
            gain.gain.linearRampToValueAtTime(0.022, ctx.currentTime + 4.0);

            o1.connect(filter);
            o2.connect(filter);
            filter.connect(gain).connect(out);

            o1.start();
            o2.start();
            lfo.start();

            _audioStarted = true;
            if (window.DEBUG_LOGS) console.log('[R32.25] mood bed online');
        } catch (e) {
            console.warn('[R32.25] mood bed failed', e);
        }
    }

    function init(THREE, camera) {
        _camera = camera || null;
        // Try to start the mood bed on first interaction (autoplay policy).
        const startOnce = function () {
            _startMoodBed();
            window.removeEventListener('pointerdown', startOnce, true);
            window.removeEventListener('keydown', startOnce, true);
        };
        window.addEventListener('pointerdown', startOnce, true);
        window.addEventListener('keydown', startOnce, true);
        if (window.DEBUG_LOGS) console.log('[R32.25] cohesion init', { hasCamera: !!_camera });
    }

    function tick(t) {
        // t is seconds elapsed; if not provided, derive from clock.
        if (typeof t !== 'number') {
            t = (typeof performance !== 'undefined' ? performance.now() : Date.now()) / 1000 - _t0;
        }
        _applyBreathing(t);
    }

    window.Cohesion = { init: init, tick: tick };
})();
