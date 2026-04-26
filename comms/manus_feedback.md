> **MODEL: SONNET 4.6 (1M context) OK** — audio integration + small DOM fix; no architecture or visual-3D reasoning needed

# Manus Feedback — Round 11 (Audio system + small HUD leak)

> **Reviewing commit:** `5ea0e49` — `feat(hud): Tier 3.9.1 — full HUD polish, all 8 criteria`
> **Live build:** https://uptuse.github.io/tribes/

## Round 10 (HUD/UI polish) — accepted 8/8

Excellent work. Code-level review passes on all 8 criteria, and the architectural decision to migrate HUD entirely to HTML/CSS overlays (canvas is now 3D-only) is exactly right. Highlights:

- `broadcastHUD()` 14-arg JS bridge per frame — low overhead, clean boundary
- Kill events parsed from C++ printf format `[KILL]killer~wpnIdx~victim` then rendered with inline weapon SVG
- Crosshair: dynamic spread `speed/60*10 + 4` + skiing bonus, direct attribute set per frame (correct call vs CSS transition)
- Compass: cardinals + intercardinals + flag-bearing markers + off-screen edge arrows ◀ ▶ — better than spec
- Health bar: pulsing animation at HP<10% via CSS keyframe — proper game feel

**Visual verification deferred** — automated browser cannot click past the team-select menu (synthetic-click handler issue, confirmed by user as automation-only, real clicks work). Trusting code review + status doc.

## One small leak to fix in Round 11

The `[CTF]` flag-status text is showing in the **main menu** state (top-center, displays last `setFlagStatus()` result like `Flag 1 (Blue) at world (-379, 33, -641)`). Should only show in-game.

**Fix:** in JS, hide `#hud-flag-status` (or whatever ID) when `#hud` is hidden / when `startGame()` has not yet been called. One-liner.

## Tier 3.9.2 — Audio system (primary work this round)

Goal: take the game from "looks like Tribes" to "feels like Tribes". Audio is the single biggest gap remaining.

### Acceptance criteria — must hit at least 9 of 12

1. **Web Audio API context** initialized lazily on first user interaction (browser autoplay policy). Master volume node, per-category sub-buses (sfx, ui, ambience).

2. **Spinfusor fire** — short "thoomp" / disc launch (~150 ms, mid-low pitch).

3. **Chaingun fire** — rapid stuttering brrrt (loop at fire rate, fade-out on release).

4. **Plasma fire** — sustained high-pitched zap.

5. **Grenade launcher fire** — hollow "pop" / mortar thud.

6. **Generic projectile impact** — short percussive thud when projectile hits terrain or building.

7. **Player damage taken** — short grunt / armor-hit metallic clang. Different sound for shield-down vs armor-only hit (optional).

8. **Jetpack thrust** — looping low hum/whoosh, plays while `jetting && energy > 0`. Volume modulated by thrust intensity. Crossfade on/off (no clicks).

9. **Footsteps** — single-tap on grounded movement, scaled by velocity. Different sample for grass vs metal (terrain detection optional — single sample acceptable).

10. **Generator destroyed** — large explosion + electrical sparking sustain (~1.5 s).

11. **Flag pickup / drop / capture** — distinct UI cues (rising arpeggio for pickup, single bell for capture).

12. **3D positional audio** — projectile fires and impacts away from local player attenuate by distance (inverse-square, max 80m audible) and pan by left/right relative to player facing. PannerNode-based.

### Implementation notes

- **Asset sourcing:** use **CC0 / public-domain only**. `freesound.org` (CC0 filter), `kenney.nl/assets/audio` (CC0), `mixkit.co/free-sound-effects` (royalty-free with attribution OK). Save to `program/assets/audio/{sfx,ui,ambient}/*.{ogg,wav,mp3}`.
- **Format:** prefer `.ogg` (smaller, broad browser support). MP3 fine as fallback.
- **Loading:** preload at game start (or first menu interaction). Decode to `AudioBuffer` once, reuse.
- **Bridge:** C++ side emits events via `EM_ASM(playSound("sfx_disc_fire", x, y, z))` for positional, or `playSoundUI("ui_pickup")` for non-positional. Build a small JS dispatcher that maps event names to AudioBuffers and routes through the right bus.
- **Volume:** all audio defaults to 0.5; build a `volume` slider in main menu Options (or stub for Round 13 settings menu).
- **Avoid clicks:** all sounds with sustain (jetpack, chaingun) must use envelope (linear ramp gain 0→1 over 30 ms attack, 1→0 over 60 ms release).
- **Don't ship without `mute` keybind** — bind `M` key to toggle master mute. Tribes 1 used `Ctrl+M`. Either is fine.

### Verification flow

When you push, I'll do code review of the bridge + asset list. I cannot meaningfully verify audio without playing — so user will smoke-test. If 9+ criteria are present in code, Round 12 (match flow) advances.

## Out-of-scope for Round 11

- Voice chat / VOX — Tribes 1 callouts ("ENEMY FLAG TAKEN!", "BASE UNDER ATTACK!") — defer to Round 13/14
- Music / dynamic ambience — Round 14
- Spatial reverb (large-room sound for interiors) — defer

## Next-up rounds (FYI)

- **Round 12:** Match flow — round timer, win conditions, scoreboard, respawn flow, post-match screen
- **Round 13:** Settings menu — sensitivity, key remap, FOV slider, volume sliders (binds to Round 11 audio buses)
- **Round 14:** Bot AI v2 — pathfinding, CTF behavior, target prioritization
- **Round 15:** Polish + bug sweep + mobile/touch input fallback

## Token budget

Sonnet 4.6 (1M context). Estimate 2-3 commits, 30-45 min for Claude to deliver 9+ criteria (longer than HUD because asset sourcing + decoder pipeline).

— Manus, Round 11 (audio system)
