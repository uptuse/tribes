// @ai-contract
// PURPOSE: Single source of truth for all JS-side colors — team colors, accent,
//   objective, status, neutral tones. Enforces the single-accent-color rule
//   (brass amber for all highlights). Includes team color helper and hex↔int conversion
// SERVES: Belonging (team colors are tribal identity — readable from across the map)
// DEPENDS_ON: window.DEBUG_LOGS
// EXPOSES: window.PALETTE (frozen object — hex strings + 0x ints for every color),
//   window.PaletteUtils { teamColor(teamIdx), hexToInt(hex) }
// LIFECYCLE: IIFE executes on load, freezes PALETTE immediately. No init/dispose
// PATTERN: IIFE → window.PALETTE (frozen) + window.PaletteUtils facade
// BEFORE_MODIFY: read docs/lessons-learned.md. Every color in the game should trace
//   back to this file. Currently only 2 team colors (red/blue) — needs expansion
//   to 4 tribes (gold/green). Adding a new color? Add it here first, explain why
// NEVER: hardcode hex color literals in other modules — reference window.PALETTE instead
// NEVER: mutate PALETTE after freeze (Object.freeze is enforced)
// ALWAYS: maintain the single-accent-color rule (#2.11 — only accent for HUD highlights)
// @end-ai-contract
//
// renderer_palette.js — R32.21
// Visual Cohesion #2.3 (locked palette) + #2.11 (single accent color rule).
//
// Single source of truth for every color used by JS-side UI/HUD/FX.
// Modules MUST reference window.PALETTE instead of hardcoding hex literals.
// Adding a new color? Add it here first; explain why; then reference it.
//
// The accent rule: exactly ONE highlight color (PALETTE.accent / brass amber).
// Every interactable, every important number, every callout uses ONLY accent
// for highlight. Everything else is grayscale or team color.
(function () {
    'use strict';
    if (typeof window === 'undefined') return;

    // -------------------------------------------------------------------
    // Locked palette — Tribes BE identity colors.
    // Hex strings (for CSS) + 0x ints (for THREE.Color).
    // R32.250: Team colors now sourced from team_config.js when available
    // -------------------------------------------------------------------
    var _TC = (typeof window !== 'undefined') && window.TEAM_CONFIG;
    const PALETTE = Object.freeze({
        // Team colors — saturated, distinct, team-readable from across map.
        // Sourced from TEAM_CONFIG (canonical) with hardcoded fallback
        teamRed:    _TC ? _TC.TEAMS[0].colorHex : '#E84A4A',
        teamRedInt:  _TC ? _TC.TEAMS[0].colorInt : 0xE84A4A,
        teamBlue:   _TC ? _TC.TEAMS[1].colorHex : '#4A8AE8',
        teamBlueInt: _TC ? _TC.TEAMS[1].colorInt : 0x4A8AE8,

        // Objective / interactable — the brass-amber HUD tone.
        objective:    '#D4A030',
        objectiveInt:  0xD4A030,

        // Single accent color (#2.11 rule). Used for HUD highlights ONLY.
        // Slightly brighter than `objective` so callouts pop above brass.
        accent:    '#FFC850',
        accentInt:  0xFFC850,

        // Status colors — used sparingly, only for alerts.
        danger:    '#FF3030',
        dangerInt:  0xFF3030,
        safe:      '#48D870',
        safeInt:    0x48D870,
        warn:      '#FFA030',
        warnInt:    0xFFA030,

        // Neutrals — backgrounds, dividers, body text.
        bg:        '#0A0E14',     // near-black for panels
        bgInt:      0x0A0E14,
        bgAlt:     '#141A22',     // panel hover / nested surface
        bgAltInt:   0x141A22,
        fg:        '#E8DCB8',     // warm-paper main text
        fgInt:      0xE8DCB8,
        fgDim:     '#A89A78',     // dim text / disabled
        fgDimInt:   0xA89A78,
        divider:   '#2A2F38',
        dividerInt: 0x2A2F38,

        // Sky / fog — must match world tonemap baseline.
        skyHaze:   '#C0C8D0',     // matches scene.fog / scene.background
        skyHazeInt: 0xC0C8D0,
    });

    // -------------------------------------------------------------------
    // Helpers — convert palette entries on the fly when modules need
    // them in different forms (CSS rgb/rgba, THREE.Color, etc.).
    // -------------------------------------------------------------------
    function hexToRgb(hex) {
        const s = (hex || '').replace('#', '');
        const v = parseInt(s.length === 3
            ? s.split('').map(c => c + c).join('')
            : s, 16);
        return { r: (v >> 16) & 0xFF, g: (v >> 8) & 0xFF, b: v & 0xFF };
    }
    function rgba(hex, alpha) {
        const c = hexToRgb(hex);
        return 'rgba(' + c.r + ',' + c.g + ',' + c.b + ',' + alpha + ')';
    }
    function teamColor(teamIdx) {
        // R32.250: prefer TEAM_CONFIG if loaded, else fall back to palette entries
        if (_TC) return _TC.teamColor(teamIdx);
        return teamIdx === 1 ? PALETTE.teamBlue : PALETTE.teamRed;
    }
    function teamColorInt(teamIdx) {
        if (_TC) return _TC.teamColorInt(teamIdx);
        return teamIdx === 1 ? PALETTE.teamBlueInt : PALETTE.teamRedInt;
    }

    window.PALETTE = PALETTE;
    window.PaletteUtils = {
        hexToRgb: hexToRgb,
        rgba: rgba,
        teamColor: teamColor,
        teamColorInt: teamColorInt,
    };

    if (window.DEBUG_LOGS) console.log('[R32.21] Palette locked.', PALETTE);
})();
