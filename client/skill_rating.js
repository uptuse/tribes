// ============================================================
// Tribes Browser Edition — Ranked tier helper (R26)
// ============================================================
//
// Maps a numeric ELO rating to a tier (Bronze..Master). Both client and
// server import this; server re-exports via server/tiers.ts to keep the
// single source of truth on the client side (where it's also vendored
// into the bundle for offline fallback).
//
// Tier brackets per brief 2.3:
//   Bronze   < 1000
//   Silver   1000-1199
//   Gold     1200-1399
//   Platinum 1400-1599
//   Diamond  1600-1799
//   Master   >= 1800
//
// Floor: rating clamps at Bronze (>= 0). Match-end overlay surfaces a
// "rating floor reached" note if a demote would drop below 0.
// ============================================================

export const TIERS = [
    { id: 'bronze',   name: 'Bronze',   min: 0,    max: 999,  color: '#A87040' },
    { id: 'silver',   name: 'Silver',   min: 1000, max: 1199, color: '#B0B0B8' },
    { id: 'gold',     name: 'Gold',     min: 1200, max: 1399, color: '#D4A030' },
    { id: 'platinum', name: 'Platinum', min: 1400, max: 1599, color: '#5DD6E0' },
    { id: 'diamond',  name: 'Diamond',  min: 1600, max: 1799, color: '#9B6BFF' },
    { id: 'master',   name: 'Master',   min: 1800, max: 9999, color: '#FF6BAB' },
];

export function tierForRating(rating) {
    const r = Math.max(0, rating | 0);
    for (let i = TIERS.length - 1; i >= 0; i--) if (r >= TIERS[i].min) return TIERS[i];
    return TIERS[0];
}

// Inline SVG badge — tier shape + initial letter. Returns an HTML string
// that can be set as innerHTML on a span. Caller supplies size in px.
export function tierBadgeSvg(tier, sizePx = 16) {
    const t = typeof tier === 'string' ? TIERS.find(x => x.id === tier) || TIERS[0] : tier;
    const init = t.name.charAt(0);
    return `<svg viewBox="0 0 20 20" width="${sizePx}" height="${sizePx}" style="vertical-align:-3px;">
      <polygon points="10,1 18,6 18,14 10,19 2,14 2,6" fill="${t.color}" stroke="#0a0e0c" stroke-width="1"/>
      <text x="10" y="14" text-anchor="middle" font-family="Cinzel,serif" font-size="10" font-weight="bold" fill="#0a0e0c">${init}</text>
    </svg>`;
}
