// ============================================================
// client/team_config.js — Canonical Team/Tribe Definitions
// ============================================================
// @ai-contract
// PURPOSE: Single source of truth for team identity, colors, and count.
//          Fixes the team-0-blue vs team-0-red INDEX INVERSION across
//          minimap/command_map vs renderer.js/palette.
// SERVES: Belonging (tribal identity), Infrastructure (all team-aware modules)
// DEPENDS_ON: None
// EXPOSES: window.TEAM_CONFIG (for IIFE consumers), also ES module exports
// PATTERN: shared-constants (dual IIFE/module compatible)
// COORDINATE: team 0 = Blood Eagle (RED), team 1 = Diamond Sword (BLUE)
// @end-ai-contract
//
// Canonical convention (matches WASM, renderer.js, renderer_palette.js):
//   Team 0 = RED  (Blood Eagle)
//   Team 1 = BLUE (Diamond Sword)
//   Team 2 = GREEN (Phoenix)       — future, 4-tribe support
//   Team 3 = GOLD (Starwolf)       — future, 4-tribe support
//
// KNOWN BUG FIXED: renderer_minimap.js and renderer_command_map.js had
// team 0=blue, team 1=red (inverted). This file establishes the correct
// order and both modules should reference it.
// ============================================================
(function () {
    'use strict';

    /** Full tribe definitions — ready for 4-tribe support */
    var TEAMS = Object.freeze([
        {
            index: 0,
            name: 'Blood Eagle',
            abbrev: 'BE',
            colorInt: 0xC8302C,
            tintInt:  0xCC4444,
            colorHex: '#C8302C',
            tintHex:  '#CC4444',
            hudHex:   '#FF6A4A',
            nameplateHex: '#FFCDCD',
        },
        {
            index: 1,
            name: 'Diamond Sword',
            abbrev: 'DS',
            colorInt: 0x2C5AC8,
            tintInt:  0x4477CC,
            colorHex: '#2C5AC8',
            tintHex:  '#4477CC',
            hudHex:   '#3FA8FF',
            nameplateHex: '#CDD8FF',
        },
        {
            index: 2,
            name: 'Phoenix',
            abbrev: 'PHX',
            colorInt: 0x2CA830,
            tintInt:  0x44CC55,
            colorHex: '#2CA830',
            tintHex:  '#44CC55',
            hudHex:   '#4AFF6A',
            nameplateHex: '#CDFFCD',
        },
        {
            index: 3,
            name: 'Starwolf',
            abbrev: 'SW',
            colorInt: 0xC8A82C,
            tintInt:  0xCCBB44,
            colorHex: '#C8A82C',
            tintHex:  '#CCBB44',
            hudHex:   '#FFD44A',
            nameplateHex: '#FFF0CD',
        },
    ]);

    /** Current active team count (2 in current WASM build, 4 when ready) */
    var TEAM_COUNT = 2;

    var NEUTRAL_COLOR_INT = 0x808080;
    var NEUTRAL_COLOR_HEX = '#808080';

    function teamColor(idx)     { return TEAMS[idx] ? TEAMS[idx].colorHex : NEUTRAL_COLOR_HEX; }
    function teamColorInt(idx)  { return TEAMS[idx] ? TEAMS[idx].colorInt  : NEUTRAL_COLOR_INT; }
    function teamTintInt(idx)   { return TEAMS[idx] ? TEAMS[idx].tintInt   : NEUTRAL_COLOR_INT; }
    function teamHudHex(idx)    { return TEAMS[idx] ? TEAMS[idx].hudHex    : NEUTRAL_COLOR_HEX; }
    function teamName(idx)      { return TEAMS[idx] ? TEAMS[idx].name      : 'Neutral'; }

    if (typeof window !== 'undefined') {
        window.TEAM_CONFIG = {
            TEAMS: TEAMS,
            TEAM_COUNT: TEAM_COUNT,
            NEUTRAL_COLOR_INT: NEUTRAL_COLOR_INT,
            NEUTRAL_COLOR_HEX: NEUTRAL_COLOR_HEX,
            teamColor: teamColor,
            teamColorInt: teamColorInt,
            teamTintInt: teamTintInt,
            teamHudHex: teamHudHex,
            teamName: teamName,
        };
    }

    if (typeof window !== 'undefined' && window.DEBUG_LOGS) {
        console.log('[R32.155] Team config locked. Team 0=' + TEAMS[0].name + ', Team 1=' + TEAMS[1].name);
    }
})();
