# Claude Status — R32.76

**HEAD:** R32.76 (pending push)
**What shipped:** Phase 3 Gameplay complete — WASM verification + bot AI research.

## Phase 3 Progress — ALL COMPLETE
- [x] Verify WASM R32.66 — code audit of air control, jetting, skiing, JS↔WASM paths
- [x] Interior lighting — R32.75 (PointLights at stations/generators, team-tinted, DayNight modulation)
- [x] Station interaction range — verified 4m open / 6m close, generator-online check
- [x] Generator destructibility — verified 800HP, damage, cascade, auto-repair, visual/audio feedback
- [x] Research bot AI — full evaluation in docs/bot-ai-research.md

## R32.76 — WASM Verification + Bot AI Research

### WASM Air Control Verification
- Emscripten 3.1.6 keyboard callbacks (`onKD`/`onKU`) wire directly to `keys[256]` array
- `emscripten_set_keydown_callback(EMSCRIPTEN_EVENT_TARGET_DOCUMENT, ...)` at init
- WASD (87/83/65/68) + arrow keys build `moveDir` vector from `flatFwd` and `right`
- Airborne branch: `airAcc = maxFwdSpeed * 0.5 * dt`, capped at `maxJetFwdVel`
- Jetting: T1 jet-split formula — `vertPct = 1 - clamp(forwardDot / maxJetFwdVel, 0, 1)`
- Skiing: slope gravity + mogul timer (0.25s airSkiTimer)
- Deployed `tribes.wasm` timestamp confirms current source

### Station Interaction Verified
- F key (keyCode 70) triggers at `lenSq < 16` (4m radius)
- Auto-close at `lenSq > 36` (6m)
- `generatorAlive[stTeam]` gates station functionality
- JS `[STATION:idx:genOk]` printf protocol bridges to HTML UI

### Generator Destructibility Verified
- 800HP generators with AABB hit detection (1.8m × 3.0m)
- `generatorAlive[team] = false` cascades: turrets offline
- Auto-repair 5HP/s when no enemies within 30m (900 lenSq)
- Visual: alive = team-colored pulse (2s interval), destroyed = yellow sparks (0.5s)
- `EM_ASM` playSoundAt on destruction

### Bot AI Research
- Evaluated 5 libraries: recast-navigation-js, navcat, Yuka.js, three-pathfinding, octree 3D
- Recommended: **hybrid waypoint graph** (ground A* + interior waypoints + flight edges)
- ~160 lines C++, zero external dependencies, matches original T1 approach
- Full report: `docs/bot-ai-research.md`
- Highest impact: interior waypoints (let bots enter bases) + generator targeting

### Files changed (R32.76)
- `docs/bot-ai-research.md`: new — full research report
- `index.html`: version chip → R32.76
