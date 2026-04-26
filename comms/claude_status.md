# Claude Status — 2026-04-26T01:30:00Z

## What I just did (this session)

### Tier 4.2 — Bot AI v2 (Round 14) — all 9 criteria implemented

#### 1. Role assignment ✅
`enum`-equivalent: 0=OFFENSE, 1=DEFENSE, 2=MIDFIELD. Stored in `int Player::botRole`.
`assignBotRole(pi)` counts existing roles on team, fills deficit targeting 2/1/1 OFF/DEF/MID distribution.
Called on initial bot setup and on every respawn. Human player has botRole=0 (unused).

#### 2. A* pathfinding on 64×64 nav grid ✅
`g_navWalkable[64][64]` built at init from building AABBs (center inside AABB + 10m padding marks cell impassable).
`astarPath(sx,sz,ex,ez)` — textbook priority_queue A* with Manhattan heuristic, diagonal moves (cost 10/14), cap 2000 iterations.
Scratch buffers `s_gCost`, `s_closed`, `s_parent` are global (no stack overflow risk).
Returns `std::vector<Vec3>` waypoints set to terrain height + 1.5m.
Per-bot state in parallel global arrays: `g_botPath[8]`, `g_botPathIdx[8]`, `g_botPathTimer[8]` (outside Player to avoid memset corruption of std::vector).
Path recomputed every 2s (1s for flag carriers) or when exhausted.
Within 8m of waypoint → advance to next.

#### 3. Stuck detection ✅
`g_botStuckAccum[pi]` accumulates dt; every 1.5s compares `(pos - lastPos).len()`.
If < 1.5m AND not in combat (no enemy within 40m): apply jump impulse (`vel.y += 8`), randomize yaw ±30°, clear path.

#### 4. Skiing intent ✅
Path direction dot terrain normal determines downhill intent. Ski when: `downhillDot > 0.1` AND speed < maxFwdSpeed×2.2×, OR slope > 0.4.
Gravity-slope physics for ski (vel += grav - norm*(grav·norm)).
Stop skiing within 8m of waypoint.

#### 5. Jetting intent ✅
Jet when: not on ground + energy > 2.5× minJetEnergy + (waypoint is >4m higher OR flag carrier being chased within 60m OR terrain above within 5m + >50% energy).
No jet at <25% energy floor (implicit: minJetEnergy threshold).

#### 6. Flag-runner behavior ✅
When `carryingFlag >= 0`: target home flag, pathfind every 1s, only engage enemies within 30m.
`[EVENT]` broadcast once per pickup (30s cooldown via `g_botFlagEventTimer`).
Defense bots detect flag carrier on enemy team and switch to carrier-chase mode.

#### 7. Engagement LOS gating ✅
5-point ray-march from bot's head to enemy head; for each step, check `getH(x,z) + 0.5m` vs ray Y.
Bots skip enemies they can't see through terrain. Reuses terrain heightmap — cheap, ~10 lines.
Range: 80m normal, 30m for flag carriers.

#### 8. Defender behavior ✅
DEFENSE bots stay near home flag. Patrol between home flag and nearest team station on 5s timer using `fmod(gameTime + pi*7.3, 10)` phase offset so they don't sync.
Enemy within 100m of home flag or enemy carrier detected → engage and chase.
If own flag is taken → switch to carrier-chase until recovered.

#### 9. Scoreboard role column ✅
`sbRow` EM_ASM: arg $6 = `botRole` (-1 for human), arg $7 = name string (via UTF8ToString).
Total 8 args — well under 16-arg EM_ASM cap (verified with grep rule).
TAB scoreboard: Role column shows OFF/DEF/MID in dim gold for bots.

## New C++ additions
- `<queue>` header added
- `int Player::botRole` field (safe to memset)
- `g_navWalkable[64][64]`, A* scratch globals, `g_botPath/Idx/Timer/LastPos/StuckAccum/FlagEventTimer[8]`
- `initNavGrid()`, `worldToNav()`, `navToWorld()`, `astarPath()`, `assignBotRole()`
- Full `updateBot()` replacement (~160 lines)
- `initNavGrid()` called after `initBuildings()` in main()

## What's next
- **Round 15-16 (Opus 4.7):** Three.js renderer migration
- **Round 17 (Sonnet):** Visual quality (PBR, shadows, particles)

## How to run
- **Live:** https://uptuse.github.io/tribes/
- **Local:** `cd /Users/jkoshy/tribes/build && python3 -m http.server 8080`
