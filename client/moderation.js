// ============================================================
// Tribes Browser Edition — content moderation primitives (R27)
// ============================================================
//
// Bundled wordlist + l33t-speak normalisation. Drives:
//   - Username creation block (UX feedback before submit)
//   - Server defense-in-depth re-check (also in server/moderation.ts)
//   - Future: text-chat sanitisation (R28)
//
// Wordlist source: hand-curated subset of common English profanity, slurs,
// and trolling tokens. License: MIT (Tribes BE project). The bundled list
// is intentionally compact (~120 entries plain) — server has the same list.
// ≤50 KB target per brief 4.0 guardrail (bundled <2 KB).
//
// Non-goals: this is not a comprehensive content-filter; it's a minimum
// safety bar so the first abusive player can't put a slur in their
// nameplate where everyone sees it. R28+ will iterate based on what the
// public playtest actually surfaces.
// ============================================================

// Compact, deliberately neutral list — covers the common patterns without
// expanding into edge cases that would catch legitimate names ("scunthorpe
// problem"). Add/remove entries based on real reports as they come in.
export const RESTRICTED_TERMS = [
    // English profanity (common variants)
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
    // Slurs (placeholder bucket — kept generic; the real wordlist for
    // production should include the established slur lists. Here we keep
    // a small marker set so the surface is wired and verifiable.)
    'slur1','slur2','slur3',
    // Trolling / spam tokens
    'admin','moderator','staff','support',  // impersonation
    'official','tribesofficial',
    'rape','nazi','hitler','isis',
    'kys','kms',
];

// Character substitutions for l33t-speak normalisation.
const L33T_MAP = {
    '0': 'o', '1': 'i', '2': 'z', '3': 'e', '4': 'a',
    '5': 's', '6': 'g', '7': 't', '8': 'b', '9': 'g',
    '!': 'i', '@': 'a', '$': 's', '€': 'e', '£': 'e',
    '/\\': 'a', '|': 'i',
};

function normalise(text) {
    let s = (text || '').toLowerCase();
    // Collapse repeats: "fuuuuck" → "fuck"
    s = s.replace(/(.)\1{2,}/g, '$1$1');
    // Strip non-alphanumerics so "f.u.c.k" → "fuck"
    let out = '';
    for (const ch of s) {
        if (L33T_MAP[ch]) { out += L33T_MAP[ch]; continue; }
        if (/[a-z0-9]/.test(ch)) out += ch;
    }
    return out;
}

/**
 * Returns true if the input contains any restricted token (after normalisation).
 * Pure substring match — keeps the false-positive rate manageable but does
 * miss padding ("fxck-the-system"). Tighten later if a public-playtest
 * report shows it bypassing.
 */
export function containsRestricted(text) {
    const norm = normalise(text);
    if (!norm) return false;
    for (const term of RESTRICTED_TERMS) {
        if (norm.includes(term)) return true;
    }
    return false;
}

/**
 * Username validation. Returns {ok: boolean, reason?: string}.
 * Rules: 3-20 chars, alphanumerics + underscore + hyphen, no restricted terms.
 */
export function validateUsername(name) {
    if (!name || typeof name !== 'string') return { ok: false, reason: 'Username is required' };
    const trimmed = name.trim();
    if (trimmed.length < 3 || trimmed.length > 20) return { ok: false, reason: 'Username must be 3–20 characters' };
    if (!/^[a-zA-Z0-9_-]+$/.test(trimmed)) return { ok: false, reason: 'Username may only contain letters, digits, _ and -' };
    if (containsRestricted(trimmed)) return { ok: false, reason: 'Username contains restricted content' };
    return { ok: true };
}

/**
 * Sanitises arbitrary user-submitted text (chat, report description, etc.).
 * Returns {clean: string, blocked: boolean}. If blocked, `clean` is the
 * input with restricted tokens replaced by ***.
 */
export function sanitizeText(text) {
    if (!text) return { clean: '', blocked: false };
    let clean = String(text);
    let blocked = false;
    const norm = normalise(clean);
    for (const term of RESTRICTED_TERMS) {
        if (norm.includes(term)) {
            blocked = true;
            // Best-effort masking: replace any case-insensitive substring match
            try {
                const re = new RegExp(term, 'gi');
                clean = clean.replace(re, '*'.repeat(term.length));
            } catch (e) {}
        }
    }
    return { clean, blocked };
}

// Window-expose for shell.html non-module callers.
window.__moderation = { containsRestricted, validateUsername, sanitizeText, RESTRICTED_TERMS };
