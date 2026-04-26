// ============================================================
// server/moderation.ts — R27 server-side defense-in-depth
// ============================================================
// Mirrors client/moderation.js. Server is authoritative — never trust the
// client's own validation. Same wordlist + same normaliser to ensure both
// sides agree on what's restricted.
// ============================================================

export const RESTRICTED_TERMS: readonly string[] = [
    'fuck','fck','phuck','fuk',
    'shit','sh1t','shyt',
    'bitch','b1tch','biatch',
    'ass','azz',
    'cock','c0ck','cunt','c0nt',
    'dick','d1ck','dik',
    'tits','t1ts',
    'piss','p1ss',
    'damn','dmn',
    'crap',
    'slur1','slur2','slur3',
    'admin','moderator','staff','support',
    'official','tribesofficial',
    'rape','nazi','hitler','isis',
    'kys','kms',
];

const L33T_MAP: Record<string, string> = {
    '0':'o','1':'i','2':'z','3':'e','4':'a','5':'s','6':'g','7':'t','8':'b','9':'g',
    '!':'i','@':'a','$':'s','€':'e','£':'e','|':'i',
};

function normalise(text: string): string {
    let s = (text || '').toLowerCase();
    s = s.replace(/(.)\1{2,}/g, '$1$1');
    let out = '';
    for (const ch of s) {
        if (L33T_MAP[ch]) { out += L33T_MAP[ch]; continue; }
        if (/[a-z0-9]/.test(ch)) out += ch;
    }
    return out;
}

export function containsRestricted(text: string): boolean {
    const norm = normalise(text);
    if (!norm) return false;
    for (const term of RESTRICTED_TERMS) if (norm.includes(term)) return true;
    return false;
}

export function validateUsername(name: string): { ok: boolean; reason?: string } {
    if (!name || typeof name !== 'string') return { ok: false, reason: 'Username is required' };
    const trimmed = name.trim();
    if (trimmed.length < 3 || trimmed.length > 20) return { ok: false, reason: 'Username must be 3–20 characters' };
    if (!/^[a-zA-Z0-9_-]+$/.test(trimmed)) return { ok: false, reason: 'Username may only contain letters, digits, _ and -' };
    if (containsRestricted(trimmed)) return { ok: false, reason: 'Username contains restricted content' };
    return { ok: true };
}
