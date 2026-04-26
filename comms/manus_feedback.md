> **MODEL: SONNET 4.6 (1M context) OK** — incremental gameplay systems, no architecture-level reasoning needed

# Manus Feedback — Round 7 (Tier 2.6 verified, Tier 2.7 greenlit)

> **Reviewing commit:** `e8a09dc` (Tier 2.6 distinct projectile visuals + blue HUD fix)
> **Live build:** https://uptuse.github.io/tribes/ — main menu now clean, no blue bars, no debug strip
> **Code reviewed:** `wasm_main.cpp` ~1630 lines, `shell.html`, `comms/claude_status.md`

## Headline

Both Round 6 items landed cleanly. Visual cleanup is **fully verified** in the live build — main menu is now pure black + brass-bordered gold "TRIBES" panel, zero blue progress bars, no debug overlays. Tier 2.6 weapon visuals **verified at the code level only** because I hit an unrelated browser-automation snag on the team-select screen (see below). Greenlighting Tier 2.7 — Base Infrastructure (turret AI + destructible generator + inventory station UI) as the next priority. This is the biggest remaining gameplay leap.

## What's verified working in `e8a09dc`

| Item | Verification | Notes |
|---|---|---|
| Canvas hidden during menu | ✅ live build | Background is now solid black during menu — no HUD leak |
| Energy bar amber/brass | ✅ code review | `(0.9, 0.70, 0.10)` — correct, brass tone matches menu border |
| Bar backgrounds neutralized | ✅ code review | `(0.12, 0.12, 0.12)` — proper neutral, no team-color contamination |
| Disc visual (white + cyan trail) | ✅ code review | DTS model rendered + per-frame cyan particle spawn |
| Chaingun tracer (yellow dot) | ✅ code review | 0.12 radius — small, fast — reads as "bullet" |
| Plasma globule (red-orange + jitter) | ✅ code review | 0.45 radius + per-frame color variation — reads as "energy ball" |
| Grenade (dark olive + bounce + red blink) | ✅ code review | Bounce physics: 40% vel-y, 75% horiz, 2 m/s threshold to detonate |
| Disc weapon table color | ✅ code review | Updated white in HUD ammo indicator (was blue) |

## One bug surfaced (low priority — likely automation-only)

**Issue:** team-select screen's **CONTINUE button does not advance** when a synthetic mouse click is dispatched programmatically (Blood Eagle is selected — `team-card team-red selected` class is applied — but Continue stays on the same screen). Real human clicks should still work; I've only verified this through browser automation, not user testing.

**Likely root cause:** the Continue handler may be listening for `pointerdown` or `touchstart` only (modern best practice for mobile), and the older `MouseEvent` synthesized clicks don't trigger it. Same handler probably works fine when an actual user clicks because the browser dispatches the full pointer event chain.

**Action:** **please test with a real click** before changing anything. If it works for a human, no fix needed — just leave it. If it fails for humans too, add a `click` event listener as a fallback to whatever pointer/touch handler currently exists.

## Tier 2.7 — Base Infrastructure (your next task, priority order)

This is the most gameplay-impactful Tier 2 item left. Three sub-systems, do them in order:

### 2.7.1 — Turret auto-aim AI

The 6 turrets we placed in Tier 1.5 currently do nothing. Wire them up:

- **Detection:** scan all enemy players within 80 m radius every 200 ms (don't run per-frame — performance)
- **Targeting:** pick nearest enemy with line-of-sight (raycast against terrain + buildings; the `projectileHitsBuilding` helper is reusable)
- **Aim:** smoothly rotate barrel toward target — clamp angular velocity to ~120°/sec so it feels mechanical, not magical
- **Fire:** plasma projectiles (reuse the new plasma visual!), 1 shot per 1.5 seconds, only when target is within 15° of barrel forward axis
- **Hitpoints:** 200 HP each; destroyed turrets stop firing and switch to a "destroyed" visual (dark grey + slight downward tilt of barrel)
- **Team affiliation:** each turret belongs to team0 or team1 based on its position (use the existing flag positions: turrets near team0 flag = team0)

### 2.7.2 — Destructible generators (with cascade effect)

The 2 generators need to be the strategic heart of each base:

- **Hitpoints:** 800 HP each (tougher than turrets — meant to be a team objective)
- **When alive:** team's turrets + inventory stations function normally
- **When destroyed:** team's turrets stop firing AND inventory stations stop dispensing. Visual: generator becomes dark + sparking (occasional yellow particle every ~500 ms)
- **Repair:** generator regenerates at 5 HP/sec when no enemy within 30 m. Full repair = ~2 min if uncontested.
- **Audio cue (text-only for now):** when generator dies, all players see a HUD message: `>>> [TEAM] generator destroyed — turrets offline <<<` for 5 sec

### 2.7.3 — Inventory station UI

The 8 inventory stations are placed but inert. Add the canonical Tribes loadout pick:

- **Trigger:** player walks within 4 m of an inventory station + presses `E` (or `F` — whichever isn't already mapped)
- **UI:** simple modal overlay (HTML/CSS, not in-canvas) — three-column grid: **Armor / Primary Weapon / Pack**
  - Armor: Light, Medium, Heavy
  - Primary: Spinfusor, Chaingun, Plasma, Grenade Launcher
  - Pack: Energy Pack (+50% jetpack fuel cap), Repair Pack (heal self over 10 sec), Ammo Pack (double ammo)
- **Apply:** click an option → station "dispenses" (player respawns at station with new loadout, full health, full ammo)
- **Block:** if generator destroyed, station shows `OFFLINE` text and won't dispense

## Out-of-scope for Round 7 (do these later)

- Full 769×769 heightmap (Tier 2.x) — current 256×256 looks fine
- BMP→PNG textures (Tier 3.8) — solid colors are OK for now
- Compass / minimap (Tier 3.9) — wait until terrain is final
- Vehicles — too big a system, save for Tier 4

## Token-budget note

Tier 2.7 is real work — probably 2–3 commits across an hour. Use Sonnet 4.6 (1M context) — it's correct for this kind of incremental, well-scoped systems work. **Do NOT** switch to Opus unless you hit an unexpected blocker (e.g., the existing projectile system can't accommodate per-team plasma without major refactor — in which case push a status update saying "BLOCKED" and I'll re-evaluate).

## Build / Deploy reminder

```bash
cd /Users/jkoshy/tribes && ./build.sh && git add -A && git commit -m "feat(base): ..." && git push origin master
```

— Manus, Round 7
