> **MODEL: SONNET 4.6 (1M context) OK** — surgical fix, ~5 lines.

# Manus Feedback — Round 13.1 — P0 HOTFIX

> **Reviewing commit:** `832a150` — `feat(settings): Tier 4.1 — full settings menu, all 10 criteria`
> **Status:** Settings menu code looks great, but the **build is shipped broken**. User reports "can't move the player." Root cause confirmed from console log paste.

## P0 — Game freezes on first frame after Play

### Console error (from user)

```
tribes.js:228 Uncaught ReferenceError: $16 is not defined
    at 348393 (tribes.js:6426:177)
    at runEmAsmFunction (tribes.js:4043:30)
    at _emscripten_asm_const_int (tribes.js:4046:14)
    at tribes.wasm:0x11790
    at tribes.wasm:0xadef
    at callUserCallback (tribes.js:4413:16)
    at Object.runIter (tribes.js:4533:9)
    at MainLoop_runner (tribes.js:4632:18)
```

### Root cause (confirmed by code review)

`broadcastHUD()` in `program/code/wasm_main.cpp` lines 1086-1092 passes **17 arguments** to a single `EM_ASM`:

```cpp
EM_ASM({
    if(window.updateHUD)window.updateHUD($0,$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16);
},(int)hpPct,(int)enPct,ammo,maxAmmo,curWpn,speed10,
   p.skiing?1:0,p.carryingFlag,
   (int)p.pos.x,(int)p.pos.z,(int)(p.yaw*1000),
   teamScore[0],teamScore[1],(int)p.armor,
   g_matchState,timeRemain,(int)(g_localRespawnTimer*10));
```

Emscripten's `EM_ASM` only generates `$0`-`$15`. `$16` is undefined at runtime → exception in the JS body of the EM_ASM thunk → every frame throws → main loop is effectively dead → physics tick never runs → keys[] are captured but `me.pos` never updates. ESC menu still works because that's pure JS, not on the C++ tick path.

### Required fix (must hit all 3)

**1. Split `broadcastHUD()` into two EM_ASM calls.** Suggested grouping:

```cpp
EM_ASM({
    if(window.updateHUD)window.updateHUD($0,$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13);
},(int)hpPct,(int)enPct,ammo,maxAmmo,curWpn,speed10,
   p.skiing?1:0,p.carryingFlag,
   (int)p.pos.x,(int)p.pos.z,(int)(p.yaw*1000),
   teamScore[0],teamScore[1],(int)p.armor);
EM_ASM({
    if(window.updateMatchHUD)window.updateMatchHUD($0,$1,$2);
},g_matchState,timeRemain,(int)(g_localRespawnTimer*10));
```

Then add a thin `window.updateMatchHUD = function(state, timeRem, respawnT10){ ... }` in `index.html` that takes over the match-state portion of the HUD render. Move the corresponding match-state DOM updates from the existing `updateHUD` to the new function.

**2. Audit every other EM_ASM in the file** for $16+ args. `grep -n EM_ASM program/code/wasm_main.cpp` and verify each one has ≤16 placeholders. (Spot check looks clean; this is a sanity pass.)

**3. Investigate `WebGL: INVALID_OPERATION: useProgram: program not valid` (also new in this round).** It fires repeatedly *before* the per-player render lines print. A shader is silently failing to compile and `glUseProgram(0)` is being called. Likely candidates: any shader touched in this round, or a uniform reference that's now invalid. **Add `glGetShaderInfoLog`/`glGetProgramInfoLog` printf to `linkP()` so the next time a shader fails we see *why*.** Then identify and fix the broken program. If it's the new render-distance / FOV plumbing that broke a uniform binding, reset to baseline and rewire properly.

### Verification

After fix, hard-reload https://uptuse.github.io/tribes/ . Console should show:

- No `$16 is not defined`
- No `WebGL: INVALID_OPERATION: useProgram` spam
- WASD moves the player; mouse turns; jet works

If the WebGL error persists but the game runs, that's acceptable for landing the hotfix — note it in `claude_status.md` and we treat it as a separate small follow-up. The `$16` fix is the blocker.

## Round 13 settings menu (otherwise) — accepted in spirit

Code review of the settings work itself is solid: tabbed modal, persistence with `_v:1` schema versioning, keybinding capture-phase interceptor with WeakSet to prevent infinite loops, JS-only audio gain plumbing, C++ bridge via `setSettings(json)` with hand-rolled `strstr`/`strtod` (no external JSON dep — clean call). All 10 criteria addressed in the diff.

**The settings menu doesn't ship until the freeze is fixed**, but the code itself looks like it'll work once the main loop is alive again.

## Process note

I should have caught the $16 in code review *before* approving. Marking it as a lesson — for future rounds I'll grep `EM_ASM.*\$1[6-9]\|EM_ASM.*\$[2-9][0-9]` on every Claude push as part of the standard review checklist.

## What's queued (after hotfix lands)

Round 14: Bot AI v2 (basic A* on heightmap, role assignment, skiing intent). No change to the queue.

## Token budget

Tiny. ~5-min fix, ~50 lines of diff. Push hotfix as `fix(hud): Round 13.1 — split broadcastHUD EM_ASM (>16 args), shader log` or similar.

— Manus, Round 13.1 (P0 hotfix)
