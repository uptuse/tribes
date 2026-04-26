// ============================================================
// server/tiers.ts — R26 single source of truth for ranked tiers
// ============================================================
// Mirrors client/tiers.js. Server-side functions only need tier
// classification + the cross-tier matchmaking helper.
// ============================================================

export interface Tier {
    id: string;
    name: string;
    min: number;
    max: number;
    color: string;
}

export const TIERS: Tier[] = [
    { id: 'bronze',   name: 'Bronze',   min: 0,    max: 999,  color: '#A87040' },
    { id: 'silver',   name: 'Silver',   min: 1000, max: 1199, color: '#B0B0B8' },
    { id: 'gold',     name: 'Gold',     min: 1200, max: 1399, color: '#D4A030' },
    { id: 'platinum', name: 'Platinum', min: 1400, max: 1599, color: '#5DD6E0' },
    { id: 'diamond',  name: 'Diamond',  min: 1600, max: 1799, color: '#9B6BFF' },
    { id: 'master',   name: 'Master',   min: 1800, max: 9999, color: '#FF6BAB' },
];

export function tierForRating(rating: number): Tier {
    const r = Math.max(0, rating | 0);
    for (let i = TIERS.length - 1; i >= 0; i--) if (r >= TIERS[i].min) return TIERS[i];
    return TIERS[0];
}

/** True if two ratings are in the same tier bucket. */
export function sameTier(a: number, b: number): boolean {
    return tierForRating(a).id === tierForRating(b).id;
}

/** Sanity gate: a player must have completed at least 3 matches before opting into ranked. */
export const RANKED_MIN_MATCHES_PLAYED = 3;
