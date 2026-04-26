> **MODEL: SONNET 4.6 (1M context) OK** — game-state machine + HTML overlays; well-scoped, no architecture or visual-3D reasoning needed

# Manus Feedback — Round 12 (Match flow)

> **Reviewing commit:** `6200943` — `feat(audio): Round 11 — full audio system + HUD flagstatus fix`
> **Live build:** https://uptuse.github.io/tribes/

## Round 11 (Audio system) — accepted 12/12

Strong delivery, and the **synthesize-in-JS** architectural call was the right one. Procedural `AudioBuffer` generation eliminated asset sourcing entirely, ships in seconds, fits the Tribes 1 retro-synth aesthetic, and zero binary bloat in the repo. Highlights:

- AE singleton with master/sfx/ui buses, lazy init on `startGame()` (respects autoplay policy)
- Three EM_ASM bridges: `playSoundAt`, `playSoundUI`, `updateAudio` — clean C++/JS boundary
- 3D positional audio via PannerNode HRTF, listener pos+yaw updated per frame
- Jetpack envelope (30 ms attack, 60 ms release) — no clicks
- M-key mute toggle as spec'd
- Flag-status menu leak fixed via `gameStarted` guard

User will smoke-test audio and ping if anything sounds off. Moving on.

## Tier 4.0 — Match Flow (primary work this round)

Goal: take the game from "sandbox where you can shoot stuff" to "playable CTF match with structure, win condition, and progression". This is the round that turns this into an actual game.

### Acceptance criteria — must hit at least 9 of 11

1. **Match-state machine** — explicit states: `WARMUP` → `IN_PROGRESS` → `MATCH_END` → `POST_MATCH`. Single `MatchState` enum in C++ with transition guards.

2. **Round timer** — 10:00 default, configurable from Game Setup screen (already has 3/5/10 caps; add a TIME LIMIT toggle: 5/10/15/Unlimited). Top-center HUD chip in `MM:SS` format. Brass-bordered to match HUD style. Counts down only during `IN_PROGRESS`.

3. **Win conditions** — match ends when EITHER:
   - A team reaches the configured cap limit (Tier 2.x already tracks captures)
   - The round timer hits 00:00 (team with most caps wins; tie → "DRAW")

4. **Scoreboard overlay** — TAB key holds open a centered HTML scoreboard. Two team panels (Blood Eagle red, Diamond Sword blue), each showing: Player Name | Caps | Kills | Deaths | Assists | Ping (stub 0). Team total caps + match time remaining at top. Brass styling.

5. **Respawn flow** — when player dies: 5-second respawn timer, screen tints dark red, center text `RESPAWNING IN X` countdown, audio cue (ui sound 5 = player_hit, optional). On respawn: spawn at team's spawn point with full HP/energy/default Light armor + Spinfusor.

6. **Spawn protection** — 3 seconds of invulnerability after respawn (player flashes faintly cyan/white). HP doesn't drop, but player can still take cover and select inventory.

7. **Match-end screen** — when match ends: full-screen modal "MATCH COMPLETE", winning team in their color (`BLOOD EAGLE WINS` or `DIAMOND SWORD WINS` or `DRAW`), final scores, buttons: `PLAY AGAIN` (resets and goes back to Game Setup) and `MAIN MENU` (returns to title).

8. **Warmup phase** — first 15 seconds of match shows `WARMUP — MATCH STARTS IN 15` countdown, allows movement but no scoring/damage. Transitions to `IN_PROGRESS` automatically. Audio cue at T-3, T-2, T-1, T-0.

9. **MVP / standout calls at match end** — top of match-end screen: "MVP: [name] — N caps, M kills". Just label whoever scored highest (caps weighted 3×, kills 1×).

10. **Game-event log** — small bottom-left toast feed (separate from kill feed): mid-match events like `RED CAPS! (1-0)`, `WARMUP COMPLETE — FIGHT!`, `4 MINUTES REMAINING`, `BLUE GENERATOR DESTROYED`. Auto-fades 6 sec.

11. **In-game ESC menu** — pressing ESC during match opens a small modal with `RESUME`, `OPTIONS` (stub for Round 13), `LEAVE MATCH` (returns to main menu). Pauses gameplay updates while open.

### Implementation notes

- Match state should live in C++ alongside team scores. JS HUD reads via existing `broadcastHUD()` (extend the 14-arg payload — add `matchState`, `timeRemainingSec`).
- Respawn timer should be C++-driven; HUD just renders.
- Spawn protection: simple `playerInvulnerableUntil[]` timestamps array; damage dealt to invulnerable player ignored.
- Scoreboard is HTML; grab data from a new `getScoreboardJSON()` C++ exported function called from JS on TAB hold.
- Match-end modal uses same brass aesthetic as Game Setup.
- ESC menu must NOT pause if match-state is WARMUP or POST_MATCH (those are already non-gameplay).
- Game-event toast feed reuses kill-feed JS infrastructure (similar styling, shorter list).

### Verification flow

Code review for state machine + spawn flow + scoreboard + match-end. User smoke-tests for game feel.

## Out-of-scope for Round 12

- Settings menu UI — Round 13 (volume, sensitivity, FOV, key remap)
- Bot AI improvements — Round 14
- Polish / bug sweep — Round 15
- Multiplayer matchmaking / lobby — far future (R23+)

## Next-up rounds (FYI)

- **Round 13:** Settings menu — Volume sliders (binds to Round 11 audio buses), sensitivity, FOV slider, key remap
- **Round 14:** Bot AI v2 — pathfinding, role-based behavior (defender/runner/heavy on D), target prioritization, skiing
- **Round 15:** Polish + bug sweep + mobile/touch input fallback + perf audit

## Token budget

Sonnet 4.6 (1M context). Estimate 1-2 commits, 25-40 min for Claude to deliver 9+ criteria.

— Manus, Round 12 (match flow)
