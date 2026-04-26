// ============================================================
// Shared gameplay constants — client + server agree on physics.
// MUST match server/constants.ts exactly.
// MUST match relevant values in program/code/wasm_main.cpp.
// ============================================================

// Network rates
export const TICK_HZ = 30;
export const TICK_DT = 1 / 30;
export const SNAPSHOT_HZ = 10;
export const DELTA_HZ = 30;
export const INPUT_HZ = 60;

// Lag compensation
export const LAGCOMP_BUFFER_TICKS = 6;        // 200ms at 30Hz
export const LAGCOMP_MAX_REWIND_MS = 200;

// World limits
export const WORLD_HALF = 1024;               // map is 2048×2048

// Player physics (defaults; armor-tier scaling below)
export const GRAVITY = -20;                   // m/s²
export const JET_THRUST = 200;                // base jet force; scaled by armor
export const SKI_FRICTION = 0.005;            // very low while skiing
export const GROUND_FRICTION = 0.85;          // walking friction
export const MAX_GROUND_SPEED = 11;           // light armor base
export const MAX_HORIZONTAL_SPEED_HARD_CAP = 60; // anti-cheat cap

// Armor tiers — match wasm_main.cpp armors[] table
export const ARMORS = [
    { name: 'light',  maxDamage: 0.66, maxEnergy: 60,  maxFwdSpeed: 11, mass: 9,  jetForce: 236, jetEnergyDrain: 0.8, hitW: 0.5, hitH: 2.3 },
    { name: 'medium', maxDamage: 1.00, maxEnergy: 80,  maxFwdSpeed: 8,  mass: 13, jetForce: 320, jetEnergyDrain: 1.0, hitW: 0.7, hitH: 2.4 },
    { name: 'heavy',  maxDamage: 1.32, maxEnergy: 110, maxFwdSpeed: 5,  mass: 18, jetForce: 385, jetEnergyDrain: 1.1, hitW: 0.8, hitH: 2.6 },
];

// Weapons — match wasm_main.cpp weapons[] table
// type: 0=blaster, 1=chaingun, 2=disc, 3=grenade, 4=plasma, 5=mortar, 6=laser, 7=elf, 8=repair
export const WEAPONS = [
    { name: 'Blaster',     damage: 0.125, fireTime: 0.30, reloadTime: 0,    muzzleVel: 200, splashRadius: 0,    kickback: 0,   gravity: 5,  hitscan: false },
    { name: 'Chaingun',    damage: 0.11,  fireTime: 0.10, reloadTime: 0,    muzzleVel: 425, splashRadius: 0,    kickback: 0,   gravity: 0,  hitscan: true  },
    { name: 'Disc',        damage: 0.5,   fireTime: 1.25, reloadTime: 0.25, muzzleVel: 65,  splashRadius: 7.5,  kickback: 150, gravity: 5,  hitscan: false },
    { name: 'GrenadeL',    damage: 0.4,   fireTime: 0.5,  reloadTime: 0.5,  muzzleVel: 40,  splashRadius: 15,   kickback: 150, gravity: 25, hitscan: false },
    { name: 'Plasma',      damage: 0.45,  fireTime: 0.5,  reloadTime: 0.1,  muzzleVel: 55,  splashRadius: 4,    kickback: 0,   gravity: 3,  hitscan: false },
    { name: 'Mortar',      damage: 1.0,   fireTime: 2.0,  reloadTime: 0.5,  muzzleVel: 50,  splashRadius: 20,   kickback: 250, gravity: 20, hitscan: false },
];

// Match
export const MATCH_WARMUP_SEC = 15;
export const MATCH_DEFAULT_SCORE_LIMIT = 5;
export const MATCH_DEFAULT_TIME_SEC = 600;
export const MATCH_END_REMATCH_HOLD_SEC = 60;
export const RESPAWN_TIMER_SEC = 5;
export const SPAWN_PROTECTION_SEC = 3;

// Anti-cheat thresholds
export const AC_MAX_SPEED_M_PER_S = 60;
export const AC_MAX_AIM_RATE_DEG_PER_S = 1080;
export const AC_MAX_INPUT_RATE_HZ = 100;       // sustained
export const AC_INPUT_RATE_WINDOW_SEC = 1;

// Reconciliation
export const PRED_HISTORY = 60;                // ~1s @ 60Hz
export const PRED_DIVERGE_POS_THRESHOLD_M = 0.5;
export const PRED_DIVERGE_ROT_THRESHOLD_DEG = 5;
export const PRED_SMOOTH_CORRECT_MS = 200;

// Match-state enum (mirrors C++ g_matchState)
export const MATCH_WARMUP     = 0;
export const MATCH_IN_PROGRESS = 1;
export const MATCH_END        = 2;

// Wire message types
export const MSG_SNAPSHOT  = 1;
export const MSG_DELTA     = 2;
export const MSG_INPUT     = 3;
export const MSG_LOBBY     = 4;
export const MSG_PING      = 5;

// Input button bitfield
export const BTN_FORWARD     = 1 << 0;
export const BTN_BACK        = 1 << 1;
export const BTN_LEFT        = 1 << 2;
export const BTN_RIGHT       = 1 << 3;
export const BTN_JUMP        = 1 << 4;
export const BTN_SKI         = 1 << 5;
export const BTN_FIRE        = 1 << 6;
export const BTN_ALT_FIRE    = 1 << 7;
export const BTN_USE         = 1 << 8;
export const BTN_RELOAD      = 1 << 9;
