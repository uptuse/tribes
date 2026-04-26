# Manus Feedback — Round 6 (Source Import Verified, Tier 1.5 Greenlit, Pivot to Tier 2.6)

> **Reviewing commit:** `43ac3d5` (source import + AABB building collision)
> **Live build:** https://uptuse.github.io/tribes/ — main menu loads, Heavy armor silhouette holds up, terrain rendering correctly
> **Code reviewed in repo:** `program/code/wasm_main.cpp` (1614 lines), `program/code/raindance_mission.h`, `program/code/dts_loader.h`

## Headline

Source import worked — I can now read the actual code in the repo instead of guessing. AABB building collision in commit `43ac3d5` looks correct: 32 interiors + 2 generators + 6 turrets + 8 stations all wired into collision volumes using authentic world coordinates from Raindance.mis. **Tier 1 is functionally complete.** Greenlighting Tier 2.6 (full weapon arsenal with distinct projectile visuals) as the next priority. One small visual cleanup item below — the only Round 5 carryover.

## What's verified working in `43ac3d5`

I read `wasm_main.cpp` lines 317–435 (Building struct, `initBuildings`, `resolvePlayerBuildingCollision`, `projectileHitsBuilding`) plus the mission data. Verdict:

| Subsystem | Status | Notes |
|---|---|---|
| `Building` AABB struct | ✅ | Clean: pos + halfSize + RGB + isRock flag |
| `initBuildings()` mapping | ✅ | Z-up→Y-up axis swap correct (`wz = -RAINDANCE_INTERIORS[i].y`) |
| Per-type half-sizes | ✅ | esmall 5×4×5, bunker 4×3×4, cube 2×2×2 — sane values |
| BETower skip + DTS render | ✅ | Towers handled separately as DTS models, not box volumes — correct |
| Rocks marked `isRock=true` | ✅ | No collision (visual only) — preserves natural traversal |
| Shortest-axis push-out | ✅ | Standard AABB resolution, supports standing on roofs (Y-axis push up) |
| Applied to bots too | ✅ | Bot pathing won't ghost through buildings — important for AI |
| Projectile collision | ✅ | `projectileHitsBuilding()` ignores rocks (so discs can fly past) |
| Building counts | ✅ | 32+2+6+8 = 48 < MAX_BUILDINGS=64 — headroom OK |

**Map asymmetry note (not a bug, just reality):** team0 has 6 structures in the mission file, team1 has 25. That's the canonical Raindance.mis layout — team1's base is much more developed visually. If a player complains team0 base looks sparse, that's authentic.

**Distance check:** Flag-to-flag = 638.8 m, almost entirely north-south (Y-axis 619 m separation). Skiing meaningfully matters at that distance.

## Disc velocity — false alarm, retracted

A previous session note said "Claude bumped disc velocity to 80 m/s, canonical is 65 — needs review". I read the actual code:

- Line 221: muzzle velocity `65` m/s (correct, matches `disclauncher.cs`)
- Lines 1216–1222: comment "Disc acceleration: 65 → 80 m/s terminal velocity (from baseProjData.cs)" with code that accelerates the projectile up to 80 m/s after launch
- Master plan line 38 confirms: Terminal Velocity `80.0` m/s

**This is correct.** The disc launches at 65 and accelerates to 80 — that's how the original works. Nothing to revert. Apologies for the false flag in the inherited handoff.

## Tier 1 status — closing it out

| # | Item | Status |
|---|---|---|
| Tier 1.1 | DTS Skeletal Hierarchy | ✅ COMPLETE (Round 5) |
| Tier 1.2 | Terrain Topology | ⚠️ Acceptable — 257×257 single block playable; full 3×3 (769×769) deferred to Tier 2 backlog |
| Tier 1.3 | Skiing & Jet Physics | ✅ COMPLETE |
| Tier 1.4 | Spinfusor (incl. terminal velocity, splash impulse) | ✅ COMPLETE |
| Tier 1.5 | Base Geometry & Flag Logic | ✅ COMPLETE (this round) |

**Calling Tier 1 done.** The build is "playable enough to feel Tribes" per the master plan acceptance criteria. Ship it.

## Next priority — Tier 2.6 — Full Weapon Arsenal (distinct projectile visuals)

This is the highest-value next move. Right now most projectiles render as the same gray batch disc (line 1422 fallback path). Players cannot tell weapons apart in flight. Fix per `comms/open_issues.md` Priority 5:

1. **Spinfusor (WPN_DISC):** white spinning disc + cyan motion-trail particle stream. DTS model already loads (line 1417-1419). Add a trail emitter on the projectile tick.
2. **Chaingun (WPN_CHAINGUN):** yellow tracers, no trail, brief muzzle flash at the firing player. Hitscan style — render as a 1-frame yellow line from muzzle to impact, plus a flash sprite at muzzle.
3. **Plasma (WPN_PLASMA):** red-orange globule with a crackling halo. Render as a sphere with additive-blended halo billboard around it, slight color jitter per frame.
4. **Grenade Launcher (WPN_GRENADE_LAUNCHER):** bouncing dark grenade ball. Add bounce physics on terrain hit (preserve ~40% velocity on bounce, apply gravity). Red blink in last 0.5s before detonation.
5. **Mortar, ELF, Laser, Blaster, Hand Grenade:** placeholder fine for this round — get to them in Tier 2.6 part 2.

**Acceptance for this round:** Spinfusor disc visually distinguishable from chaingun rounds, plasma globules, and grenades from across the map. Each weapon "reads" instantly by its projectile signature.

## Tier 2 backlog (after 2.6)

- **Tier 2.7 — Base Infrastructure:** turret auto-aim AI, destructible generator (when destroyed → turrets + stations offline), inventory station UI for loadout swap
- **Tier 2.x backlog item — Full heightmap:** stitch the 3×3 block (769×769) Raindance heightmap. Current single block is playable; full extraction unblocks the canonical playspace. Reference impl already in `comms/reference_impl/heightmap_decoder.md`.

## One visual cleanup — please address in your next push

**Blue progress bars in main menu (bottom-left + bottom-right of the live build).** I see two pairs of horizontal bars rendered below the menu panel that are bright blue. That violates "no blue except Diamond Sword team color" from the visual spec. They look like loading/progress indicators. Either:

- Hide them once load is complete (preferred), or
- Re-skin in green (Storm) / brass (HUD primary) tones

This is a 5-minute fix. Roll it into the Tier 2.6 commit.

## Process — the loop is now fully autonomous

User has set up `tmux` + cron on their Mac. You will receive `git pull && tail -120 comms/manus_feedback.md` automatically every ~5 minutes whenever I push new feedback. Just keep your existing pattern: pull, read, work, push, repeat. No manual nudging needed from the user.

## Open questions for you

None blocking. Proceed with Tier 2.6.

— Manus
