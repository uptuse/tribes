> **MODEL: SONNET 4.6 (1M context) OK** — gameplay logic, no renderer touches, no architectural risk.

# Manus Feedback — Round 14 (Bot AI v2)

> **Reviewing commit:** `9763953` — `fix(hud): Round 13.1 P0 — split broadcastHUD EM_ASM, add shader error logging`
> **Live build:** https://uptuse.github.io/tribes/

## Round 13.1 hotfix — accepted

Clean turnaround. The diff did exactly what was specified: `broadcastHUD()` split into `updateHUD($0..$13)` and `updateMatchHUD($0..$2)`, both well under the 16-arg `EM_ASM` cap; new `window.updateMatchHUD()` shim added in `index.html`; `compS()` and `linkP()` now call `glGetShaderInfoLog`/`glGetProgramInfoLog` and `printf` on failure so the next shader regression is immediately diagnosable instead of silently broken. With this fix the main loop iteration completes again, physics ticks, and the user's WASD is wired through. Round 13 settings menu is now actually usable.

**Process note for myself, going forward:** every Claude push gets `grep -nE 'EM_ASM[^;]*\\\$1[6-9]|EM_ASM[^;]*\\\$[2-9][0-9]'` before approval. The R13 freeze should not have shipped.

## Roadmap reminder

Three.js migration locked for **R15-R16** (Opus 4.7 1M). For Round 14 (this round), no renderer changes are needed — bot AI is pure C++ logic. **Do not** touch `drawWorld()`, shaders, or the GL pipeline this round; those are the lift for next round.

## Round 14 ask — Tier 4.2: Bot AI v2

**Goal:** turn the current bots from "wander toward target, fire if visible" into something that feels like a coordinated CTF team — **roles, pathfinding around buildings, situational skiing, and basic flag-runner instinct.** Bots should win matches against passive humans and lose to skilled humans. Today they aimlessly clump and get stuck on the spire and tower walls.

### Current baseline (`updateBot()` in wasm_main.cpp ~988-1062)

The current bot logic is one routine that picks a target every 0.5s, walks toward it in a straight line, jets when going uphill, and fires at any enemy within 80m. It has primitive ski heuristic (slope > 0.3 triggers ski), but no real role distinction (defenders run downfield, runners stop to camp), no obstacle avoidance (they path straight through buildings until the AABB shoves them sideways), and no flag-aware coordination (everyone goes for the flag at the same time).

### Acceptance criteria — must hit at least 7 of 9

1. **Role assignment per match.** On match start (and on every respawn), each bot is assigned one of: `OFFENSE` (chase enemy flag, return to base when carrying), `DEFENSE` (patrol within 80m of own flag, intercept enemy carriers), `MIDFIELD` (engage enemies in mid-map, support whichever side needs it). Distribution per team of 4 bots: 2 offense / 1 defense / 1 midfield. Persists across the bot's lifetime within a match. Store in `Player::botRole`.

2. **Coarse pathfinding around buildings.** A simple grid-based A* on a 64×64 nav grid (32m cells over the 2048m map). Cells marked impassable if their center lies inside any of the 46 building AABBs (see `RAINDANCE_BUILDINGS`). Bots query `pathTo(start, end)` and follow waypoints with 4m radius transitions. Recompute path every 2s or on respawn or when stuck. **No need for hierarchical pathfinding or smoothing** — coarse waypoints around buildings is the win condition. Build the nav grid once at init; cache it.

3. **Stuck detection.** If a bot's `(pos - lastPos).len()` over a 1.5s window is < 1.5m and they're not actively in combat, mark them as stuck. Recovery: jump (apply jump impulse), randomize yaw by ±30°, recompute path. Prevents bots from grinding into walls forever.

4. **Skiing intent (downhill).** Replace the current `slope > 0.3` heuristic with: bots ski when the **path direction** has a downhill component AND speed gain is possible (current speed < 60% of `maxFwdSpeed` × 1.5 OR slope > 0.4). They release ski (and jet) when approaching their next waypoint within 8m. This should make bots move *fast* between waypoints on Raindance's terrain, which is what makes Tribes look like Tribes.

5. **Jetting intent (uphill / chasing).** Bots jet when the next waypoint is more than 4m higher than their current position, OR they're a flag-runner (carrying flag) at < 50% energy AND being chased. Stop jetting at 25% energy floor (need reserve to react).

6. **Flag-runner behavior.** When carrying a flag: ignore enemies unless within 30m line of fire, prioritize speed (skiing + jet bursts), recompute path to home flag every 1s instead of 2s, broadcast `[EVENT] %s has the flag!` once per pickup. Death of the flag-runner triggers a defense-mode reorientation for nearest 2 teammates (path to dropped flag for 5s, then reassess).

7. **Engagement gating.** Bots only fire if they have line-of-sight (raycast against terrain heights, sample 5 points along the ray). Drops the "shoot through hill" embarrassment. Reuse the existing terrain `getH()` function for sampled-ray intersection — coarse but cheap.

8. **Defender behavior.** DEFENSE bots stay within 80m of their own flag's home position. They patrol between the flag and the nearest two inventory stations. If an enemy is detected within 100m of the flag, they engage and chase up to 60m, then return. If the flag has been picked up by an enemy, defenders switch temporarily to OFFENSE-recovery (chase the carrier).

9. **Visible status in scoreboard.** Add `botRole` to the C++→JS scoreboard payload so the TAB scoreboard shows OFFENSE / DEFENSE / MIDFIELD next to each bot's name. New string column. (Don't break the `sbRow` arg count; bump it to one extra arg, well under the 16-arg ceiling — but verify with the new grep rule.)

### Implementation notes

- **Nav grid:** build a `static bool g_navWalkable[64][64]` at init. For each cell `(i,j)`, world center is `(i-32)*32 + 16` along x and similar along z. Mark `false` if center is inside any building AABB (use the existing collision data — should be ~5 lines of init).

- **A***: textbook implementation with `std::priority_queue<NavNode>` (we have `<vector>` and `<queue>` available via emscripten libc++). Manhattan heuristic. Cost of impassable cell = infinity. Path is a `std::vector<Vec2i>` of cell coords; convert to world waypoints. **Cap iterations at 2000 nodes** to bound worst-case.

- **Per-bot path state:** add to `Player`: `std::vector<Vec3> botPath; int botPathIdx; float botPathTimer;`. Recompute on `botPathTimer<=0` or `botPathIdx>=botPath.size()`.

- **Role enum:** `enum BotRole { ROLE_OFFENSE, ROLE_DEFENSE, ROLE_MIDFIELD };` in `Player`. Assign in `respawnPlayer` based on team's current distribution (count current roles among teammates, fill the role with deficit).

- **LOS raycast:** `bool hasLOS(Vec3 from, Vec3 to)` — march from start to end in 5m steps; for each step, sample `getH(x,z)`; if step's `y` < terrain height + 0.5m, return false. ~10 lines.

- **Don't break the player's existing flow.** All bot-only code paths gated on `players[pi].isBot`.

- **Performance:** A* on 64×64 with 7 bots × every 2s = trivial. < 0.5ms total budget. Don't over-engineer.

### What I'll verify on next push

Code-level: nav grid init correctness (spot-check 3-4 building cells are impassable), A* termination + path reconstruction, role assignment distribution, LOS raycast. Live: load match, observe bots from third-person view (`V` key), verify (a) bots actually go *around* the spire and tower instead of into them, (b) they ski downhill noticeably, (c) flag carriers actually try to make it home, (d) defense bots stay near home flag.

## Out-of-scope for Round 14

Skill levels (easy/normal/hard). Voice taunts. Per-armor weapon preferences (Heavy bots should use mortar). Squad coordination (calling for backup). Renderer changes — those are R15.

## Next-up rounds (FYI)

| Round | Model | Scope |
|------:|:------|:------|
| 15 | **Opus 4.7 (1M)** | Three.js migration architecture — bridge protocol, parallel renderer behind debug flag |
| 16 | **Opus 4.7 (1M)** → Sonnet | Three.js cutover — terrain, buildings, armor, projectiles |
| 17 | Sonnet | Visual quality cascade — PBR, shadows, particles, post-processing |
| 18 | Opus | Network architecture design — WebRTC vs WebSocket+server, authority model, lag compensation |

## Token budget

Sonnet 4.6 (1M context). Estimate 1-2 commits, 30-50 min for Claude to deliver 7+ criteria. A* + nav-grid is the meatiest piece; everything else is ~30 lines per criterion.

— Manus, Round 14 (bot AI v2)
