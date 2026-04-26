> **MODEL: SONNET 4.6 (1M context) OK** — UI/CSS work, no architecture or visual-3D reasoning needed

# Manus Feedback — Round 10 (HUD / UI polish — model-free pivot)

> **Reviewing:** any WIP / status push from Round 9.5 interrupt
> **Live build:** https://uptuse.github.io/tribes/

## Context

User is sourcing custom character models (Round 10's-original armor pivot is on hold). To keep the loop productive in the meantime, we're stacking three model-free tracks: **HUD/UI → Audio → Match flow**. This is Round 10: HUD/UI polish. Audio comes Round 11, match flow Round 12.

Resume Tier 3.0 character work whenever the user's models drop in `program/assets/characters/`.

## Why HUD/UI first

The current in-game HUD is functional but minimalist — health bar, energy bar, ammo counter, weapon name. Polishing it now (a) gives the user immediate visual delight without needing 3D assets, (b) sets the visual language for everything else, and (c) doesn't conflict with later character/material work.

## Tier 3.9.1 — HUD Polish (THIS ROUND)

### Acceptance criteria — must hit **at least 6 of 8**

1. **Health bar redesign.** Currently a flat amber rectangle. Add: gold/brass border (matches main menu), segmented divisions every 25 HP, color shift to deep red when HP < 25, subtle pulse animation when HP < 10. Place bottom-left.

2. **Energy bar redesign.** Same brass-bordered styling. Color: cyan-blue (canonical Tribes energy color). Add: subtle horizontal "fluid" gradient that depletes leftward when jetpack used. Place directly under health bar.

3. **Ammo counter.** Currently a number. Upgrade: large primary number (current ammo) + smaller secondary number after `/` (max ammo, e.g., `40 / 80`). Brass-bordered chip in bottom-right. Color codes: green (>50%), amber (25-50%), red (<25%).

4. **Weapon icon.** Show a small pictograph of the current weapon (disc / chaingun / plasma / grenade) above the ammo counter. SVG line-art is fine — clean, monochrome with brass tint. When weapon switches, animate a 200ms fade-cross between icons.

5. **Crosshair.** Currently a tiny dot or nothing. Replace with: dynamic crosshair that opens up when moving (running/skiing) and closes when stationary. Color: brass `(#C4A14C)` matching the menu palette. Different shape per weapon: spinfusor = circle with cross, chaingun = small dots in a square, plasma = filled circle, grenade = parabola arc indicator.

6. **Kill feed.** Top-right of screen. Stack of recent kills, format: `[killer name] [weapon icon] [victim name]` with team color tint. Auto-fade after 5 sec. Max 4 entries visible.

7. **Compass strip.** Top-center. Horizontal strip showing cardinal directions (N/E/S/W) plus markers for: own flag (gold), enemy flag (gold), nearest teammate (team color), nearest enemy (red dot only when in line-of-sight). Marker positions update relative to player's facing direction.

8. **CTF objective banner.** When player picks up enemy flag → screen-edge gold pulse + center text `>>> YOU HAVE THE FLAG — RETURN TO BASE <<<` for 3 sec then minimize to small "FLAG" indicator near health bar. When flag is captured/dropped → matching banner.

### Verification flow

When you push, I'll:
1. Load https://uptuse.github.io/tribes/ in headless browser
2. Click through to in-game state, screenshot HUD
3. Visually count how many of the 8 criteria are met
4. If 6+ → Round 11 advances to audio system
5. If 5 or fewer → Round 11 stays on HUD with specific gaps called out (still Sonnet — this is CSS, doesn't need Opus)

### Implementation notes

- HUD is currently rendered partly in canvas (energy bar on line ~988 of `wasm_main.cpp`) and partly in HTML (`shell.html`/`index.html`). **Recommendation: move all HUD to HTML/CSS overlays.** The canvas is for the 3D world only. HTML overlays are easier to style, animate, and iterate on. Migrate energy bar out of canvas as part of this round.
- Reuse the brass color palette from main menu: gold `#D4AF37`, brass `#C4A14C`, dark border `#2A2010`, panel bg `rgba(15, 12, 5, 0.85)`.
- For SVG weapon icons, embed inline in HTML (not external files) — keeps deploy simple.
- Crosshair should be its own absolutely-positioned SVG centered on screen, NOT in canvas (rotation/dilation is much smoother in SVG).

### Out-of-scope for Round 10

- Settings menu (key remap, sensitivity) — Round 12 or later
- Scoreboard / post-match screen — Round 12 (match flow)
- Minimap (mini top-down map) — wait until terrain is final or skip
- Voice chat / text chat — much later

## Next-up rounds (FYI, not for this round)

- **Round 11:** Audio system — weapon SFX, jetpack hum, generator destroy, footsteps. Sonnet. I'll source CC0 sound assets.
- **Round 12:** Match flow — round timer, win conditions, scoreboard, respawn flow. Sonnet.
- **Round 13:** Settings menu + key remap. Sonnet.
- **Round XX (when assets drop):** Tier 3.0 character model integration. Model TBD by complexity.

## Token budget

Standard Sonnet 4.6 (1M context). HUD/UI is well-scoped, no architecture risk. Estimate: 1 commit, 15-25 min.

— Manus, Round 10 (HUD pivot)
