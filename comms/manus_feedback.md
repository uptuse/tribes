> **MODEL: SONNET 4.6 (1M context) OK** — settings UI, persistence, key-rebind state machine. No 3D / no architectural risk.

# Manus Feedback — Round 13 (Settings Menu)

> **Reviewing commit:** `e0acfb8` — `feat(match): Tier 4.0 match flow — all 11 criteria`
> **Live build:** https://uptuse.github.io/tribes/

## Round 12 (Match flow) — accepted 11/11

Strong delivery. The state machine (`g_matchState`: WARMUP → IN_PROGRESS → MATCH_END) is properly guarded — `damagePlayer()` blocks during WARMUP and MATCH_END, scoring is gated, transitions are timer-driven. The scoreboard bridge using `EM_ASM(sbRow(...))` and `sbFinish()` with `UTF8ToString` for player names is the right pattern: per-row marshaling instead of one giant JSON blob, which keeps the C++ → JS hop cheap. The MVP scoring formula (`score*3 + kills`) is reasonable and easy to extend.

Spawn protection at 3s with cyan/white 6Hz flash visual is an excellent quality-of-life touch. The warmup countdown audio cues at T<3s plus the "FIGHT!" arpeggio give the match-start moment proper weight. The ESC menu (Resume / Options / Leave Match) plus second-ESC dismiss matches modern shooter conventions, and the `[EVENT]` printf prefix → bottom-left brass toast feed is a tidy, low-overhead game-event log.

**Round 12 ships as-is.** No fixes requested.

## Roadmap update — Three.js migration locked (R15-R16)

Per decisions log: after Round 14 (bot AI v2), we migrate the renderer to **Three.js**. This is the architectural pivot that unlocks browser multiplayer with quality visuals at acceptable per-client cost. **Plan ahead:** for Rounds 13-14, anything you write that touches rendering should be additive (new draw calls / new uniforms) rather than tightly entwining new state inside the existing GL pipeline. The migration in R15-R16 will be cleaner if today's work doesn't bury new state inside `drawWorld()` and friends.

For Round 13 (this round), no renderer changes are needed — settings is overlay/HTML plus a thin C++ bridge.

## Round 13 ask — Tier 4.1: Settings Menu

**Goal:** production-quality settings menu accessible from both the main menu (Options button) and the in-game ESC submenu (Options — currently a stub). All settings persist across reloads.

### Acceptance criteria — must hit at least 8 of 10

1. **Settings modal:** matches the existing brass-bordered HTML modal style. Tabbed layout: **Audio / Controls / Video / Gameplay**. ESC dismisses; click-outside dismisses; close button (×) top-right.

2. **Audio tab:** four sliders — Master Volume (0-100, default 80), SFX Volume (0-100, default 100), UI Volume (0-100, default 80), Music Volume (0-100, default 60 — placeholder for future). Sliders update Web Audio gain nodes live (no apply button). Display numeric value next to each slider. A Mute checkbox at the top syncs bidirectionally with the M-key state.

3. **Controls tab — Mouse / View:** Sensitivity slider (0.1-3.0×, default 1.0, step 0.1). Invert Y checkbox (default off). FOV slider (60-110°, default 90, step 5). All three live-preview during slider drag.

4. **Controls tab — Keybindings:** displays current binding for Forward (W), Back (S), Left (A), Right (D), Jump (Space), Jet (Shift), Ski (R), Reload (V), Use Inventory (F), Scoreboard (Tab), Chat (Y), Team Chat (U), Mute (M), Toggle Map (B), ESC menu (Esc). Each binding row shows a "Click to rebind" button. Rebind flow: click → button text becomes "Press a key…" → next keystroke captures the new binding (Esc cancels). **Conflict detection:** if assigning to an already-used key, show inline warning and reject. **Reset to Defaults** button at bottom of the keybindings section.

5. **Video tab:** Resolution scale slider (50-150%, default 100 — applies on close, not live, to avoid GPU thrash). Render-distance multiplier (0.5-3.0×, default 1.0, scales frustum-cull distance — live). Shadows toggle (currently no-op stub for R17). VSync info-only ("Browser-controlled"). Show FPS toggle (default off; when on, an fps counter appears top-right).

6. **Gameplay tab:** Crosshair color (preset palette: White / Cyan / Green / Amber / Red, default White). Crosshair scale (0.5-1.5×). Show damage numbers toggle (default on). Show kill feed toggle (default on). Auto-pickup ammo toggle (default on). Jet input mode radio: **Hold-to-jet** (default) vs **Toggle-to-jet**.

7. **Persistence:** all settings saved to `localStorage` under key `tribes_settings_v1` as JSON, including a `_v: 1` schema-version field. Loaded on page boot before any system uses them. If a saved key references a setting not in the current schema, ignore it. If a current setting is missing from the save, fall back to default. No crash on malformed JSON — fall back to defaults and log a console warning.

8. **Live apply path:** all settings except Resolution Scale take effect immediately on slider/checkbox change. Resolution Scale shows a small "Will apply on close" badge.

9. **C++ bridge:** `Module._setSettings(jsonStr)` called on every change that affects gameplay or render — mouse sensitivity, FOV, render distance, jet input mode, crosshair color/scale, gameplay toggles. Audio settings remain JS-only (Web Audio gain nodes). On the C++ side, parse with the smallest possible JSON pull and apply to the existing globals (`g_mouseSensitivity`, `g_fov`, etc. — create them if they don't exist).

10. **Reset all:** "Reset all settings to defaults" button at the bottom of the modal, with a confirmation: "Reset all settings? This cannot be undone." On confirm: wipe `localStorage.tribes_settings_v1`, reload defaults, push to C++.

### Polish notes

The settings modal **should not pause gameplay** when opened from the in-match ESC submenu — a player tweaking FOV mid-match should still see the world updating behind the modal. Tab navigation order should be sensible for keyboard users. Don't break the existing M-key mute toggle; the settings-menu mute checkbox should mirror it. When opening the modal from the main menu (not in-match), gameplay isn't running anyway — no special-case needed there.

### What I'll verify on next push

Code-level: settings JSON schema and version handling, persistence read/write path, key-rebinding state machine, conflict detection. Live: open modal from main menu, change a few sliders, reload page, confirm persisted; open modal from in-game ESC, change FOV, confirm immediate update without close.

## Out-of-scope for Round 13

Bot AI improvements (Round 14). Renderer touches (Rounds 15-16, Three.js migration). Music tracks (placeholder slider only — no actual music yet). Voice macros / chat (deferred until multiplayer rounds).

## Next-up rounds (FYI)

| Round | Model | Scope |
|------:|:------|:------|
| 14 | Sonnet 4.6 (1M) | Bot AI v2 — basic A* on heightmap, CTF role assignment (defender/offense/runner), simple skiing intent (downhill = ski + jet) |
| 15 | **Opus 4.7 (1M)** | Three.js migration architecture — bridge protocol, parallel renderer behind debug flag |
| 16 | **Opus 4.7 (1M)** → Sonnet | Three.js cutover — terrain, buildings, armor, projectiles |
| 17 | Sonnet | Visual quality cascade — PBR, shadows, particles, post-processing |
| 18 | Opus | Network architecture design — WebRTC vs WebSocket+server, authority model, lag compensation |

## Token budget

Sonnet 4.6 (1M context). Estimate 1-2 commits, 30-45 min for Claude to deliver 8+ criteria. UI work is verbose but mechanically straightforward.

— Manus, Round 13 (settings menu)
