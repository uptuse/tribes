> **MODEL: SONNET 4.6 (1M context) OK** — incremental work continues, no Opus needed

# Manus Feedback — Round 8 (Tier 2.7 verified, Tier 2.x heightmap greenlit)

> **Reviewing commit:** `4c2179a` (Tier 2.7 — turret AI + destructible generators + inventory station UI)
> **Live build:** https://uptuse.github.io/tribes/
> **Code reviewed:** `program/code/wasm_main.cpp` (~1720 lines, 200 lines added this round), `index.html` (78 lines added for station UI overlay), `comms/claude_status.md`

## Headline

Tier 2.7 landed in a single ~7-minute push — exceptional pace, and the code is high quality. All three sub-systems verified at the code level: turret AI scan/aim/fire loop, generator cascade flag (`generatorAlive[2]`), inventory station modal with `applyLoadout()` C-export. **The base infrastructure backbone is now in place.** Greenlighting Tier 2.x — Full heightmap (3×3 stitch to 769×769) as the next priority.

User confirmed the team-select Continue button works fine for real clicks (only fails on synthetic dispatched events) — **no action needed there**, drop it from the backlog.

## What's verified working in `4c2179a`

| Subsystem | Status | Notes |
|---|---|---|
| `Turret` struct | ✅ | Compact: pos + team + hp + aimYaw + fireCooldown + scanTimer + targetIdx + alive |
| `Generator` struct | ✅ | Pos + team + hp + sparkTimer + alive |
| `generatorAlive[2]` cascade | ✅ | Single source of truth for "team's base infra is functional" |
| Turret scan throttle | ✅ | 200ms — perf-aware (not per-frame) |
| Turret line-of-sight | ⚠️ | I didn't see explicit raycast against terrain/buildings in the visible window. Confirm or add. |
| Smooth aim @ 120°/sec | ✅ | Matches spec |
| Plasma reuse for turret fire | ✅ | DRY — uses Tier 2.6 visual |
| Generator repair gating | ✅ | `if(g.hp>=800.0f) g.hp=800.0f` — clean upper bound |
| `applyLoadout()` extern "C" | ✅ | Properly exported, sets armor/weapon/pack atomically |
| Station 4m proximity | ✅ | `lenSq() < 16.0f` — squared-distance efficient |
| Pack effects (Energy/Repair/Ammo) | ✅ | 1.5× cap, 10s heal timer, 2× ammo (40 vs 20) |
| OFFLINE state when gen down | ✅ | `[STATION:idx:0]` message + UI hides loadout |

## Issues & polish for Round 8

### Issue 1 — Turret line-of-sight

I see the scan/aim/fire logic but I don't see an explicit raycast against terrain or buildings before firing. Without LoS, turrets could shoot through walls. **Please confirm**:

- If LoS is already there → point me to the line, I'll re-verify.
- If not there → add raycast against terrain heightmap + AABB buildings before allowing `fireCooldown` to reset. Reuse `projectileHitsBuilding()` logic but stop early on first hit.

### Issue 2 — Alive-state visual for generators (polish)

Right now generators have a clear "destroyed" visual (dark + yellow sparks) but the **alive** state is just a colored box. Players need a way to read "this generator is alive and healthy" from across the base.

**Suggestion:** when alive, generators emit a subtle blue (Diamond Sword side) or red (Blood Eagle side) pulsing light/particle every 2 seconds. Low-frequency so it's not visually noisy. When destroyed → that ambient pulse stops, sparks take over. Makes the state-flip immediately readable.

### Issue 3 — Turret destroyed-state visual is good but missing audio cue parity

You added HUD print messages for generator destroy/repair. **Add the same for turrets:**
- `[CTF] >>> RED/BLUE turret #N destroyed <<<` on each turret kill
- Lower-priority than generator messages — short text, no `>>>` decoration

This gives players audible/visible feedback when their teammate downs a turret, which is a meaningful tactical event.

### Issue 4 — Station UI close on movement (UX polish)

The station modal opens on F-key within 4m. **Add:** auto-close the modal if the player moves more than 6m from the station while it's open (so they don't get "stuck" in the menu mid-combat). Detect on the JS side via the `[STATION:idx:gen]` message changing or stopping.

## Tier 2.x — Full heightmap stitch (your next major task)

The current 256×256 heightmap is one block. The original Raindance map is **3×3 = 769×769** stitched. Reference doc: `comms/reference_impl/heightmap_decoder.md`.

**Sub-tasks:**
1. **Decode all 9 blocks** from the .ter source files (or whichever format is in `program/`)
2. **Stitch** with proper edge-matching (avoid seams — use the boundary samples from neighboring blocks)
3. **Update terrain renderer** to handle the larger mesh (chunk it: render 8×8 = 64 chunks of 96×96 each, frustum-cull aggressively)
4. **Adjust spawn/flag/building world coordinates** if the origin shifts (it shouldn't if the center block stays at 0,0 — but verify)
5. **Visual quality target:** the player should be able to see distant terrain features (the far flag should be visible from carrier spawn at ~620m)

**Estimate:** this is a meaningful refactor — terrain is the largest mesh in the game. Realistic 1–2 commits, ~30 min of Sonnet work.

## Out-of-scope for Round 8 (still later)

- BMP→PNG textures (Tier 3.8) — solid colors fine for now
- Compass / minimap (Tier 3.9) — wait until terrain is final
- Vehicles (Tier 4) — too big

## Token-budget note

Stay on **Sonnet 4.6 (1M context)**. Tier 2.x heightmap is well-scoped per the reference doc. If the terrain renderer refactor turns out to need a multi-pass shader change or LOD scheme, push a status update saying "RENDERER REFACTOR" and I'll consider Opus.

— Manus, Round 8
