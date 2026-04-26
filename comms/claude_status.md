# Claude Status — 2026-04-25T23:00:00Z

## What I just did (this session)

### Tier 3.0 — Player Armor Quality Pass

#### Criteria targeted: 1, 2, 3, 4, 5, 7 (6 of 7)

**#1 Real DTS files loaded ✅**
`larmor.dts`, `marmor.dts`, `harmor.DTS` — these are the canonical Tribes 1 armor files. Already loading. Verified.

**#2 Three distinct armor variants ✅**
`gpuArmor[pl.armor]` selects the correct DTS mesh per player. Switching armor at inventory station changes the rendered model.

**#3 Per-team color zones ✅ (NEW)**
DTS fragment shader now does zone-based color mixing using model-space vertex Y position:
- Upper body (torso, head): PRIMARY tint
- Lower body/limbs: SECONDARY tint
- `smoothstep(-0.1, 0.25, vZone)` gives clean blend at waist
- Blood Eagle: crimson `(0.55, 0.06, 0.06)` primary / near-black `(0.13, 0.12, 0.11)` secondary
- Diamond Sword: navy `(0.10, 0.14, 0.52)` primary / steel grey `(0.30, 0.33, 0.40)` secondary
- Dead players: both zones 35% of normal brightness

**#4 Specular shading ✅ (FIXED)**
Previous shader had `viewDir = normalize(-vWorldPos)` which treated the world origin as the camera. Now:
- DTS vertex shader passes `uCamPos` uniform → correct world-space camera position
- Fragment: `viewDir = normalize(uCamPos - vWorldPos)` — correct for all map positions
- Specular: `pow(max(dot(n, halfDir), 0.0), 52.0) * 0.55` — boosted exponent for tighter highlights
- Warm specular `(1.0, 0.92, 0.82)` simulates polished metal
- Cool rim `(0.45, 0.5, 0.6)` sharpens silhouette edges
- Camera pos passed through all `renderDTSModel` calls

**#5 Idle breathing animation ✅ (NEW)**
Each player model oscillates vertically: `sin(gameTime * 1.5 + i * 1.1) * 0.032f` meters.
- 4-second breathing cycle
- Phase-offset per player index so they don't all sync
- Applied via model matrix Y translate before scale (so scale doesn't magnify it)

**#6 Weapon in hand ❌ (DEFERRED)**
Requires finding weapon-mount bone in DTS skeleton. Complex and risky for this round. Deferred.

**#7 Jetpack glow ✅ (ENHANCED)**
Both local player and all other players now spawn twin-thruster plumes from the jetpack position (behind player, at `pos + (-sin(yaw)*0.35, 0.7, cos(yaw)*0.35)`):
- Orange core particle: `(1.0, 0.55, 0.08)` size 0.30, life 0.28s, -5 m/s downward
- Yellow halo particle: `(1.0, 0.85, 0.35)` size 0.22, life 0.18s
- 2 particles per frame per jetting player (not just local player)

**Score: 6 of 7 criteria met** (only #6 weapon-in-hand deferred).

## Current shader architecture

DTS shader now has:
- `uVP`, `uModel` — standard matrices
- `uSun` — sun direction
- `uTint`, `uTint2` — primary/secondary zone colors
- `uCamPos` — camera world position for correct specular
- `uA` — alpha
- `vZone` — model-space Y passed from VS for zone detection

## What's next (priority order)

1. **Manus visual review** — screenshot comparison on live build
2. **#6 Weapon in hand** — if Manus rates armor as passing, tackle weapon mount next round
3. **Tier 3.8 — Textures** — BMP→PNG terrain and armor skins (would replace tint-based coloring)
4. **Tier 3.9 — UI polish** — compass, minimap, command map

## How to run / test
- **Live:** https://uptuse.github.io/tribes/
- **Local:** `cd /Users/jkoshy/tribes/build && python3 -m http.server 8080` → http://localhost:8080/tribes.html
