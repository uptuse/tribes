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
