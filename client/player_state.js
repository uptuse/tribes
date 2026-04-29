// ============================================================
// client/player_state.js — Shared WASM Player State Constants
// ============================================================
// @ai-contract
// PURPOSE: Single source of truth for RenderPlayer HEAPF32 stride layout.
//          Eliminates magic-number offsets across renderer.js, renderer_characters.js,
//          renderer_polish.js, renderer_rapier.js, and index.html.
// SERVES: Infrastructure (all modules)
// DEPENDS_ON: Must match C++ RenderPlayer struct in game.cpp
// EXPOSES: PV (player view offsets), MAX_PLAYERS
// PATTERN: shared-constants (new canonical pattern)
// @end-ai-contract
//
// Layout derived from renderer.js usage (R32.153):
//   syncPlayers(), syncCamera(), ski/jet particle emitters, rapier step.
//
// If the C++ struct changes, update ONLY this file — all consumers import from here.
// ============================================================

/** Player-view HEAPF32 field offsets (per-player stride) */
export const PV = Object.freeze({
    X:          0,   // world position X (meters)
    Y:          1,   // world position Y (meters, feet)
    Z:          2,   // world position Z (meters)
    PITCH:      3,   // aim pitch (radians)
    YAW:        4,   // aim yaw (radians, MIS convention: -rotation.y in Three.js)
    // 5 is unused / padding in current struct
    VX:         6,   // velocity X (m/s)
    VY:         7,   // velocity Y (m/s)
    VZ:         8,   // velocity Z (m/s)
    // 9, 10 unused
    TEAM:      11,   // team index (0-based)
    ARMOR:     12,   // armor type (0=light, 1=medium, 2=heavy)
    ALIVE:     13,   // > 0.5 = alive
    JETTING:   14,   // > 0.5 = jet pack active
    SKIING:    15,   // > 0.5 = skiing
    // 16, 17 unused
    VISIBLE:   18,   // > 0.5 = should render
    // 19 unused
    SPAWN_PROT: 20,  // spawn protection timer (reserved[0])
});

/** Maximum players supported in current WASM build */
export const MAX_PLAYERS = 16;

/** Default stride (floats per player). Should match Module._getPlayerStateStride(). */
export const PLAYER_STRIDE = 32;
