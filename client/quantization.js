// ============================================================
// Quantization helpers — used by wire format on both sides.
// MUST match server/quant.ts (re-exports this file).
// Renamed from quant.js → quantization.js at R32.178.
// Per network_architecture.md §5.2:
//   pos: m × 50 → int16 (range ±655m, resolution 2cm)
//   rot: rad × 10000 → int16 (range ±π, resolution ~0.006°)
//   vel: m/s × 2 → int8 (range ±63 m/s, resolution 0.5 m/s)
//   health/energy: float [0..1] × 255 → uint8
// ============================================================

const POS_SCALE = 50;
const ROT_SCALE = 10000;
const VEL_SCALE = 2;

const I16_MAX =  32767;
const I16_MIN = -32768;
const I8_MAX  =  127;
const I8_MIN  = -128;

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// --- Quantize (encode) ---
export function quantPos(meters)   { return clamp(Math.round(meters * POS_SCALE), I16_MIN, I16_MAX); }
export function quantRot(radians)  { return clamp(Math.round(radians * ROT_SCALE), I16_MIN, I16_MAX); }
export function quantVel(mPerSec)  { return clamp(Math.round(mPerSec * VEL_SCALE), I8_MIN, I8_MAX); }
export function quantUnit01(x)     { return clamp(Math.round(x * 255), 0, 255); }

// --- Unquantize (decode) ---
export function unquantPos(q)  { return q / POS_SCALE; }
export function unquantRot(q)  { return q / ROT_SCALE; }
export function unquantVel(q)  { return q / VEL_SCALE; }
export function unquantUnit01(q) { return q / 255; }

// --- Constants for wire-format struct sizes (bytes) ---
export const SIZE_HEADER     = 8;
export const SIZE_PLAYER     = 32;
export const SIZE_PROJECTILE = 12;
export const SIZE_FLAG       = 10;  // R32.202: was 8; +2 bytes for posZ (int16 quantized)
export const SIZE_SNAP_HDR   = 24;
export const SIZE_INPUT      = 20;
