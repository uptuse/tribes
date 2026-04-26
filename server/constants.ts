// ============================================================
// Server-side constants — re-exports from ../client/constants.js
// to guarantee client + server agree on every gameplay value.
// Bun loads .js cross-directory without ceremony.
// ============================================================

export * from '../client/constants.js';
