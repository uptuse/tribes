// ============================================================
// Skill rating — ELO-lite (R24)
//
// Each player has a numeric rating starting at SKILL_INITIAL (default 1000).
// After each match the lobby calls updateRatings() which computes the
// expected outcome from team-average rating differential and the actual
// outcome from the score-margin ratio. K-factor decays from 32 (early
// matches) to 16 (after 20 matches played) for stability.
//
// Safety rail: only updates if match ran > 4 minutes AND >= 4 humans
// (excludes bot-stuffed sandbox matches). Caller (lobby.ts) checks.
// ============================================================

export const SKILL_INITIAL = Number(globalThis.process?.env?.SKILL_INITIAL ?? 1000);
export const K_NEW = 32;
export const K_VETERAN = 16;
export const K_DECAY_THRESHOLD = 20;

export interface SkillRow {
    rating: number;
    matchesPlayed: number;
    lastActiveMs: number;
}

export function defaultSkillRow(): SkillRow {
    return { rating: SKILL_INITIAL, matchesPlayed: 0, lastActiveMs: Date.now() };
}

/**
 * Compute new ratings for both teams given current ratings and final scores.
 * Returns per-player rating deltas keyed by playerId.
 */
export function computeRatingDeltas(
    teams: { team: 0 | 1; players: { id: number; uuid: string; rating: number; matchesPlayed: number }[] }[],
    teamScores: [number, number],
): Map<number, number> {
    const deltas = new Map<number, number>();
    if (teams.length !== 2) return deltas;

    // Team-average rating
    const avgs = teams.map(t => {
        if (t.players.length === 0) return SKILL_INITIAL;
        return t.players.reduce((a, p) => a + p.rating, 0) / t.players.length;
    });

    // Expected outcome for team 0 (ELO formula, scaled by 400-pt convention)
    const expected0 = 1 / (1 + Math.pow(10, (avgs[1] - avgs[0]) / 400));
    const expected1 = 1 - expected0;

    // Actual outcome from score margin, bounded to [0, 1]
    const total = teamScores[0] + teamScores[1];
    let actual0: number;
    if (total === 0) {
        actual0 = 0.5;  // 0-0 = draw
    } else {
        actual0 = teamScores[0] / total;
    }
    const actual1 = 1 - actual0;

    for (let ti = 0; ti < 2; ti++) {
        const team = teams[ti];
        const expected = ti === 0 ? expected0 : expected1;
        const actual = ti === 0 ? actual0 : actual1;
        for (const p of team.players) {
            const k = p.matchesPlayed >= K_DECAY_THRESHOLD ? K_VETERAN : K_NEW;
            const delta = Math.round(k * (actual - expected));
            deltas.set(p.id, delta);
        }
    }
    return deltas;
}

/** Returns true if match qualifies for rated update. */
export function isRatedMatch(durationS: number, humanCount: number): boolean {
    return durationS > 240 && humanCount >= 4;
}
