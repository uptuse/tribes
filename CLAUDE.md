# Tribes Browser Edition — Project Guide

## Project Goal
Port Starsiege: Tribes (Dynamix, 1998, Darkstar engine) to run in a web browser via WebAssembly + WebGL2.

## Visual Goal (Locked)
Authentic look of Starsiege: Tribes (1999) as shipped, with optional non-silhouette-breaking modern enhancements.

- **Use original assets** wherever possible: .dts models, .bmp/.png textures, terrain heightmaps, HUD bitmaps, fonts, sounds from the user's local Tribes 1 / Darkstar source.
- **Tribes 1 UI** is tan/grey/military, bitmap fonts, utilitarian panels with tribe logos. The current dark-blue sci-fi shell is NOT Tribes and must be replaced.
- **Tribes 1 HUD:** circular compass/sensor top-center, energy/health bars bottom-left, ammo bottom-right, weapon select wheel, inventory station UI, command map (C key).
- **Gameplay feel:** skiing physics, jetpack energy, three armor classes (L/M/H), 1998-correct weapon stats, large outdoor heightmap terrain with bases and turrets.
- **Allowed modern enhancements:** higher-res textures, AA, bloom, better shadows, mipmaps — ONLY if silhouette and palette remain visually identical to 1999. If a modernization changes the silhouette, the answer is no.

## Comms Protocol
All communication between Claude and Manus happens through files in `/comms/`:

| File | Owner | Purpose |
|------|-------|---------|
| `claude_status.md` | Claude writes | Status after every meaningful change |
| `manus_feedback.md` | Manus writes | Feedback and directives — Claude reads FIRST |
| `visual_spec.md` | Manus writes | Canonical look-and-feel spec — ground truth |
| `open_issues.md` | Both edit | Shared backlog, mark [x] when done |
| `CHANGELOG.md` | Claude appends | One line per commit |

## Loop Rule
Before every new task:
1. `git pull`
2. Read `comms/manus_feedback.md` and `comms/open_issues.md`
3. Address anything marked PRIORITY before starting new work

After every meaningful change:
1. Rewrite `comms/claude_status.md`
2. Append to `comms/CHANGELOG.md`
3. Commit and push

## Manus Role
Manus is the art director and QA. Treat its feedback as **authoritative on visual fidelity** and **advisory on architecture**.
