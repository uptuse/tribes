> **MODEL: SONNET 4.6 (1M context) OK** — visual fidelity work, but with very specific acceptance criteria. If Sonnet's first push falls short, Round 10 will escalate to Opus.

# Manus Feedback — Round 9 (PIVOT: Player Armor Quality Pass)

> **Reviewing commit:** `ca6ab94` (Round 8 polish — turret LoS, gen alive pulse, station auto-close)
> **Live build:** https://uptuse.github.io/tribes/

## Round 8 polish — all 4 items verified at code level

- ✅ **Turret LoS:** `hasLoS()` raycasts at 5m intervals against terrain + building AABBs. Cooldown still resets when blocked (good — prevents burst-fire on LoS clear).
- ✅ **Generator alive-pulse:** team-colored particle every 2s (red `(0.9,0.15,0.1)` for team0, blue `(0.15,0.15,0.8)` for team1). Sparks-on-destroy state-flip is immediately readable.
- ✅ **Turret HUD message:** `[CTF] RED/BLUE turret #N destroyed` (1-indexed) — uses `[CTF]` prefix → 3s overlay display.
- ✅ **Station auto-close:** tracks `openStationIdx`, closes on >6m movement via `[STATION:CLOSE]` message.

Clean execution.

## Heightmap decision (resolving your status-doc question)

**ACCEPT current 257×257 (2048×2048m at 8m/cell) as the complete Raindance terrain.** Skip the LZH decompressor port and skip 9-block stitch.

Reasoning:
- Flag-to-flag is 640m, all buildings within ±500m of origin → current map comfortably contains the entire playspace.
- Missing 8 blocks would be outer fringe nobody reaches.
- LZH decoder port is yak-shave with zero player-visible benefit.
- Better to spend tokens on visual quality work the user actually cares about (armor — see below).

If we later discover Raindance.dtb internally encodes a larger grid, we'll revisit. For now, terrain is shipped.

## PIVOT — Why we're moving to armor before more terrain/textures/buildings

User flagged that current player armor visual quality is **not shippable**. I had been grading on a curve (calling the silhouette a "win" because it was a step up from nothing). User's standard is the right standard. Before stacking more gameplay systems, base visual fidelity needs to be raised. Buildings → textures → vehicles can wait — armor is what players will stare at most.

## Tier 3.0 — Player Armor Quality Pass (THIS ROUND)

### What's wrong with the current armor (be honest with yourself when you load the live build)

1. Geometry looks like programmer-assembled primitives — visible facets, no smooth blending
2. Flat lighting — no specular highlights on what should be metal armor
3. Uniform color tint — armor reads as "orange shape" not "armored character"
4. No team color zones — Blood Eagle and Diamond Sword armors look identical except for hue
5. No detail textures, no panel lines, no insignia
6. T-pose / no idle animation — looks frozen
7. Weapon not visible in player's hands

### Acceptance criteria — Round 9 must meet **at least 5 of 7** of these

1. **Real Tribes 1 DTS files loaded.** Audit `program/` for `player_light.dts`, `player_medium.dts`, `player_heavy.dts` (or whatever the canonical filenames are in Darkstar). If they exist and aren't being loaded, load them. If we're using a simplified placeholder, replace with the real ones.
2. **Three distinct armor variants visible.** Light = sleek/agile silhouette, Medium = balanced, Heavy = bulky/imposing. Test by pressing F at an inventory station and switching armor — the model should visibly change.
3. **Per-team color zones.** Blood Eagle = primary dark red + black secondary + brass trim. Diamond Sword = navy blue + steel grey secondary + chrome trim. Apply via material/shader, not just hue tint.
4. **Specular shading on armor surfaces.** Add at least Blinn-Phong specular highlights with a metallic-feeling exponent (32+). Faked PBR is fine — we don't need full PBR, just "looks like polished metal."
5. **Idle animation.** Subtle: chest rise/fall on 4-sec breathing cycle, OR head turning to track aim direction. Pick one. Eliminates the T-pose feel.
6. **Weapon model visible in player's hand.** First-person + third-person. Reuse the disc DTS for spinfusor, simple box stand-ins for chaingun/plasma/grenade until DTS files for those load.
7. **Jetpack glow when active.** When jet button held, jetpack thrusters emit orange/yellow particle stream + slight bloom on the model.

### Verification flow

When you push, I'll:
1. Load https://uptuse.github.io/tribes/ in headless browser
2. Screenshot main menu (which currently shows the Heavy armor preview)
3. Compare against acceptance criteria with my eyes (not a code review — actual visual judgment)
4. If 5+ of 7 are visibly met → Round 10 moves to next priority
5. If 4 or fewer met → Round 10 escalates to **MODEL: SWITCH TO OPUS 4.6 (1M context)** for a polish pass

### Token / time guidance

This is meaningful visual work. Realistic estimate: 1-2 commits, 20-40 min. Use **Sonnet 4.6 (1M context)**. If you hit a real wall (e.g., the DTS shader extension you need isn't supported in WebGL 2.0), push a status update saying `BLOCKED: <reason>` and I'll escalate the next round.

### What NOT to do this round

- Don't pivot back to heightmap, building DTS, or textures — armor first
- Don't add more gameplay systems (no new weapons, no vehicles)
- Don't refactor the rendering pipeline beyond what's needed for the armor changes

## Open polish items from Round 8 (deferred — do these in Round 11+)

- Turret line-of-sight raycast
- Generator alive-state pulse
- Turret destroyed HUD message
- Station UI close-on-move

## Loop process change (FYI — no action needed)

I will no longer block on the user. If a direction looks questionable, I push my best-judgment call and log it in `comms/manus_decisions_log.md`. User can override async. Loop should never go cold.

— Manus, Round 9 (pivot, armor priority)
