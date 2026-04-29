# Item 45 — Migrate All Team Color References to team_config.js

## Status: COMPLETE (R32.270)

## What Changed
- **renderer.js**: `TEAM_COLORS` and `TEAM_TINT_HEX` arrays now source from `window.TEAM_CONFIG` (the canonical team color module) with hardcoded fallback.
- **renderer.js**: `_teamAccent()` function refactored to derive from `TEAM_COLORS[]` instead of hardcoded hex per team index.
- **renderer.js**: Turret enhance call now uses `TEAM_TINT_HEX[canon.team]` instead of hardcoded ternary.
- **renderer.js**: Nameplate color now reads `TEAM_CONFIG.TEAMS[team].nameplateHex` instead of hardcoded per-team ternary.
- **renderer.js**: accentMat fallback uses `TEAM_TINT_HEX[0]` instead of `0xCC4444`.
- **renderer_palette.js**: Team color entries now source from `window.TEAM_CONFIG` when available, with hardcoded fallback. `teamColor()`/`teamColorInt()` helpers also delegate to TEAM_CONFIG.
- **renderer_minimap.js**: Already used TEAM_CONFIG (via `_TC.teamHudHex()`) — no changes needed.
- **renderer_command_map.js**: Already used TEAM_CONFIG (via STATE.teamColors) — no changes needed.

## Files Not Touched (intentional)
- **renderer_combat_fx.js**: Uses `0xffd070` (brass/amber) for tracers — not a team color. Will be updated in Item 63.
- **renderer_polish.js**: Uses `teamColor` parameter passed by callers — already a passthrough, not hardcoded.
- **client/mapeditor.js**: Not found in repo — no changes needed.

## Risk Assessment
- **Low risk**: All changes use `TEAM_CONFIG` with fallback to original hardcoded values, so if `team_config.js` fails to load, everything still works.
- **4-tribe ready**: When `TEAM_COUNT` is bumped to 4 in team_config.js, all migrated references will automatically support Phoenix and Starwolf.

## Testing
- Verify team colors render correctly for buildings, nameplates, player meshes, minimap dots, and command map.
- Verify `?style=pbr` still works (palette fallback path).
