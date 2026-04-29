# Item 35 — Remove Remote Player Visibility Hack

## Change Summary
Removed the development hack in `syncPlayers()` (renderer.js ~L3626) that set `mesh.visible = false` for ALL non-local players, effectively making the game appear single-player.

**Commit:** `fix(R32.200): enable remote player rendering (remove single-player hack)` — 6c62d5d

## What Was Removed
```javascript
// R32.63.4: hide ALL non-local players (bots disabled)
if (i !== localIdx) {
    mesh.visible = false;
    if (nameplateSprites[i]) nameplateSprites[i].visible = false;
    if (shield) shield.visible = false;
    continue;
}
```

Replaced with a comment marking the removal:
```javascript
// R32.200: remote player rendering enabled (single-player hack removed)
```

## What's Preserved
- The `i >= count` guard at L3790 still hides meshes for non-existent players
- The `i === localIdx && !is3P` check still hides the local player in 1st-person view
- The `i === localIdx && is3P` check still suppresses nameplates for local player in 3rd-person
- Visibility is still gated on `visible && alive` at L3646

## Cohort Review

### Pass 1 — Structural Integrity (Carmack)
**PASS.** The removal is surgical — 6 lines removed, no new code added. The existing guards for non-existent players, 1P/3P visibility, and alive/visible state remain intact. The function's flow for remote players now correctly falls through to the positioning, rotation, and nameplate code below.

### Pass 4 — Integration Risk (Fiedler)
**PASS.** This was a blanket early-return that prevented ALL remote player rendering. With it removed:
- Remote player positions will be read from `playerView` and applied to meshes
- Nameplates will be shown for remote players within 60m
- Shield bubbles will be visible on remote players
- Torso pitch (aim direction) will be applied to remote players

**Note:** Remote players will still teleport (no interpolation — that's NET-01/Item 31, not this fix). But they will at least be visible at their last-known server position.

## Risk Assessment
**LOW.** Pure removal of a debug hack. No new code paths introduced. Remote players may appear jerky without interpolation (expected — separate issue).
