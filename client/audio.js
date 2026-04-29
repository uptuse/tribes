// ============================================================
// Tribes audio module (R22)
//
// The actual audio engine implementation lives in shell.html as `window.AE`
// (initialized R11, extended R22). This module is the canonical ES-module
// public surface — it provides typed sound-id constants and helper functions
// that delegate to the global engine.
//
// Why not move AE here entirely? AE was instantiated inline in shell.html
// since R11 to satisfy browser autoplay policy (must be created in response
// to a user gesture). Moving it here would risk breaking a half-dozen
// existing call sites in shell.html that reference window.AE/playSoundUI/
// playSoundAt directly. R22 prefers extension over rewrite — see
// claude_status.md decision notes.
//
// Sound bank — 17 procedurally-synthesized sounds:
//   0..10   R11 baseline (disc/chaingun/plasma/grenade/impact/hit/pickup/
//           capture/gen_destroy/footstep/jet_loop)
//   11..16  R22 additions (ski_loop/mortar_boom/damage_give/respawn/
//           match_start_horn/match_end_horn)
//
// Positional 3D: AE.playAt(id, x, y, z) routes through HRTF PannerNode
// using the listener position/orientation set by AE.update() each frame
// from the local player's pos+yaw (already wired in shell.html R11).
// ============================================================

export const SOUND = Object.freeze({
    DISC_FIRE:       0,
    CHAINGUN_FIRE:   1,
    PLASMA_FIRE:     2,
    GRENADE_FIRE:    3,
    IMPACT:          4,
    DAMAGE_TAKE:     5,
    FLAG_PICKUP:     6,
    FLAG_CAPTURE:    7,
    GEN_DESTROY:     8,
    FOOTSTEP:        9,
    JET_LOOP:        10,
    SKI_LOOP:        11,
    MORTAR_BOOM:     12,
    DAMAGE_GIVE:     13,
    RESPAWN:         14,
    MATCH_START_HORN: 15,
    MATCH_END_HORN:   16,
});

export function isReady() {
    return !!(window.AE && window.AE.ctx);
}

export function muted() {
    return !!(window.AE && window.AE.muted);
}

export function setMuted(v) {
    if (window.AE) {
        window.AE.muted = !!v;
        if (window.AE.master) window.AE.master.gain.value = v ? 0 : 0.55;
    }
}

/** Play UI / non-positional sound. */
export function playUI(soundId) {
    if (window.playSoundUI) window.playSoundUI(soundId);
}

/** Play 3D-positional sound at world coords. HRTF PannerNode. */
export function playAt(soundId, x, y, z) {
    if (window.playSoundAt) window.playSoundAt(soundId, x, y, z);
}

/** Convenience: play horn for warmup→in-progress transition. */
export function playMatchStartHorn() { playUI(SOUND.MATCH_START_HORN); }

/** Convenience: play horn for match end. */
export function playMatchEndHorn() { playUI(SOUND.MATCH_END_HORN); }

/** Convenience: play respawn arpeggio for local player. */
export function playRespawn() { playUI(SOUND.RESPAWN); }

/** Convenience: play hit-confirm "tink" when local player damages enemy. */
export function playDamageGive() { playUI(SOUND.DAMAGE_GIVE); }

/** Map weapon id → projectile fire sound. Used by network.js for
 *  remote-player fires from snapshot deltas. */
export function fireSoundForWeapon(weaponIdx) {
    switch (weaponIdx) {
        case 1: return SOUND.CHAINGUN_FIRE;
        case 2: return SOUND.DISC_FIRE;
        case 3: return SOUND.GRENADE_FIRE;
        case 4: return SOUND.PLASMA_FIRE;
        case 5: return SOUND.MORTAR_BOOM;
        default: return SOUND.IMPACT;
    }
}

// ============================================================
// Ambient Mood Bed — procedural low-frequency drone
// Migrated from renderer_cohesion.js (R32.156)
//
// Two detuned sawtooth oscillators @ 55Hz / 55.4Hz with heavy lowpass
// and very low gain. The listener acclimates within seconds and stops
// consciously hearing it — exactly what an environmental mood bed does.
//
// Must be started after user interaction (browser autoplay policy).
// Reuses the existing window.AE.ctx when available.
// ============================================================
let _moodBedStarted = false;

function _startMoodBed() {
    if (_moodBedStarted) return;
    try {
        const ctx = (window.AE && window.AE.ctx) ||
                    new (window.AudioContext || window.webkitAudioContext)();
        if (!ctx) return;
        if (ctx.state === 'suspended') ctx.resume();

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
        gain.gain.value = 0.0;
        gain.gain.linearRampToValueAtTime(0.022, ctx.currentTime + 4.0);

        o1.connect(filter);
        o2.connect(filter);
        filter.connect(gain).connect(ctx.destination);

        o1.start();
        o2.start();
        lfo.start();

        _moodBedStarted = true;
        if (window.DEBUG_LOGS) console.log('[R32.156] mood bed online');
    } catch (e) {
        console.warn('[R32.156] mood bed failed', e);
    }
}

/** Start the ambient mood bed on first user interaction.
 *  Call once from renderer.js after scene init. */
export function initMoodBed() {
    const startOnce = function () {
        _startMoodBed();
        window.removeEventListener('pointerdown', startOnce, true);
        window.removeEventListener('keydown', startOnce, true);
    };
    window.addEventListener('pointerdown', startOnce, true);
    window.addEventListener('keydown', startOnce, true);
    if (window.DEBUG_LOGS) console.log('[R32.156] mood bed listeners registered');
}
