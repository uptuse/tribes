# Phase 2a — Adversarial Convergence Review: tribes.js (Run 2 — Validation Pass)

**Target:** `tribes.js` — 6,868 lines (Emscripten-generated WASM bootstrap)  
**Date:** 2026-04-30  
**Panel:** Carmack, Abrash, Muratori, Acton, Barrett  
**Run 2 Purpose:** Validate, challenge, and correct Run 1 findings against actual source code.

---

## Source Code Verification

Run 2 reads the actual file. Every Run 1 claim is checked against the source at specific line numbers.

---

## Pass 1 — Validate Run 1 Claims

### Claim: "tribes.js is 100% Emscripten glue, not hand-written game logic"

**Carmack:** "I searched the entire 6,868-line file for any developer-authored patterns — revision markers (`// R[0-9]`), project-specific strings (`Firewolf`, `Tribes BE`), custom TODOs, or hand-written logic. Every single TODO and FIXME in this file is an Emscripten upstream comment — `TODO(sbc)` referring to Sam Clegg, Emscripten's maintainer, or Emscripten GitHub issue tracker references. Zero hand-written game logic. **Run 1 was correct.** This file is a pure compiler artifact."

**Barrett:** "Confirmed. The structure is textbook Emscripten output: minimum runtime checks (lines 1-60), Module object setup, environment detection, pre-js data loading, filesystem stubs, runtime initialization, syscall emulation, typed array management, export table, and the WASM import object. No deviations from the standard Emscripten template."

**Verdict: ✅ VALIDATED**

---

### Claim: "HEAPF32 detachment cannot happen — memory growth is DISABLED"

**Carmack:** "Verified at lines 4354-4361. The implementation is unambiguous:

```javascript
var abortOnCannotGrowMemory = (requestedSize) => {
    abort(`Cannot enlarge memory arrays to size ${requestedSize} bytes (OOM). Either (1) compile with -sINITIAL_MEMORY=X with X higher than the current value ${HEAP8.length}, (2) compile with -sALLOW_MEMORY_GROWTH which allows increasing the size at runtime, or (3) if you want malloc to return NULL (0) instead of this abort, compile with -sABORTING_MALLOC=0`);
};
var _emscripten_resize_heap = (requestedSize) => {
    var oldSize = HEAPU8.length;
    requestedSize >>>= 0;
    abortOnCannotGrowMemory(requestedSize);
};
```

The function unconditionally calls `abortOnCannotGrowMemory`, which calls `abort()`. There is no code path that grows memory. There is no conditional. The buffer reference stored at initialization will never change during runtime. **Run 1's reclassification from P0 to P2-latent was correct.**"

**Abrash:** "`updateMemoryViews()` at line 613 recreates all typed array views. Under this build it runs exactly once — during `initRuntime()`. I confirmed there's no other caller. The views set at init are the views for the entire session."

**Verdict: ✅ VALIDATED — P0→P2 reclassification confirmed correct**

---

### Claim: "ASM_CONST callbacks require window.* globals and have NO null guards"

**Muratori:** "This is where Run 1 got it **wrong**. I'm reading the actual ASM_CONSTS block at lines 6438-6457. Let me list every single entry:

```javascript
var ASM_CONSTS = {
  348156: ($0,$1,$2,$3,$4,$5,$6,$7) => { if(window.sbRow)window.sbRow($0,$1,$2,$3,$4,$5,$6,UTF8ToString($7)); },
  348229: ($0,$1,$2,$3,$4) => { if(window.sbFinish)window.sbFinish($0,$1,$2,$3,UTF8ToString($4)); },
  348299: () => { if(window.playSoundUI)window.playSoundUI(5); },
  348346: () => { if(window.playSoundUI)window.playSoundUI(6); },
  348393: ($0,$1,$2) => { if(window.onMatchEnd)window.onMatchEnd($0,$1,$2); },
  348445: ($0,$1) => { if(window.onDamageSource)window.onDamageSource($0,$1); },
  348502: ($0,$1,$2) => { if(window.playSoundAt)window.playSoundAt(8,$0,$1,$2); },
  348560: ($0,$1,$2) => { if(window.playSoundAt)window.playSoundAt(4,$0,$1,$2); },
  348618: () => { if(window.playSoundUI)window.playSoundUI(7); },
  348667: ($0,$1,$2) => { if(window.onMatchEnd)window.onMatchEnd($0,$1,$2); },
  348719: () => { if(window.playSoundUI)window.playSoundUI(6); },
  348768: ($0,$1) => { const renderMs=(window.r3FrameTime||0); ... },
  348950: ($0,$1,$2,$3,$4) => { if(window.updateAudio)window.updateAudio($0,$1,$2,$3,$4); },
  349012: ($0,$1,$2,$3) => { if(window.updateAudio)window.updateAudio($0,$1,$2,$3); },
  349071: ($0) => { if(window.playSoundUI)window.playSoundUI($0); },
  349121: ($0,$1,$2) => { if(window.playSoundAt)window.playSoundAt(4,$0,$1,$2); },
  349177: ($0) => { if(window.onHitConfirm)window.onHitConfirm($0); },
  349229: ($0,...$13) => { if(window.updateHUD)window.updateHUD($0,...,$13); },
  349318: ($0,$1,$2,$3) => { if(window.updateMatchHUD)window.updateMatchHUD($0,$1,$2,$3); }
};
```

**Every single callback already has a null guard.** `if(window.sbRow)window.sbRow(...)`, `if(window.updateHUD)window.updateHUD(...)`, etc. The C++ developer wrote proper `EM_ASM` guards in the source. Run 1's finding T-004 stated:

> 'ASM_CONST callbacks have no null guards — P1 — boot race can crash runtime'

**This is factually wrong.** The guards exist in every callback. There is no boot-race crash risk from undefined callbacks. If any global is undefined when C++ calls it, the guard silently skips the call."

**Carmack:** "I owe this a correction. In Run 1, I stated: 'If any of these are undefined when C++ calls them, you get a runtime exception inside the WASM glue, which Emscripten wraps in an abort.' That claim was based on assumption, not on reading the actual code. The C++ developer was careful. The `if(window.X)` pattern is exactly the right guard — falsy-check before invocation. No crash, no abort."

**Acton:** "There is ONE exception. Look at entry `348768`:

```javascript
348768: ($0, $1) => { const renderMs=(window.r3FrameTime||0); ... console.log(...); }
```

This one reads `window.r3FrameTime` with a fallback `||0`, which is safe, and then calls `console.log()` unconditionally. It doesn't call any game callback — it's a perf logger. Still safe, but it's the only ASM_CONST that doesn't follow the `if(window.X)` pattern, because it doesn't need to."

**Barrett:** "The broader implication: Run 1's Recommendation #3 ('Add defensive null checks to ASM_CONST callbacks in C++ EM_ASM macros — P1 — 1 hr') is **unnecessary work on an already-solved problem**. The recommendation should be removed or reclassified as 'Already Implemented.'"

**Verdict: ❌ RUN 1 FINDING T-004 IS WRONG — null guards already exist in source**

---

### Claim: "index.html contains ~4,500 LOC of hand-written JavaScript"

**Barrett:** "Partially correct, but the number is off. `index.html` is 4,519 lines total. The main game script block runs from line 1510 to line 4517 — that's **3,008 lines of JavaScript**. There are additional smaller script blocks:

| Block | Lines | Content |
|-------|-------|---------|
| L650-655 | ~5 | Game clock setup |
| L657-686 | ~29 | Import map (JSON, not JS) |
| L688-694 | ~6 | Settings UI wiring |
| L696-733 | ~37 | Settings persistence |
| L734-1509 | ~775 | Inline HTML with JS event handlers |
| L1510-4517 | ~3,008 | **Main game bridge script** |

Total hand-written JS: roughly **3,200-3,300 lines**, not 4,500. Run 1 overestimated by ~30%. The remaining ~1,200 lines are CSS and HTML markup."

**Carmack:** "The scope is still massive and unaudited. 3,200 lines is still a significant application. It contains: HUD rendering, scoreboard management, menu/settings UI, audio engine, input handling, multiplayer lobby, replay viewer, friend list, matchmaking, loadout selection, damage indicators, spawn protection UI, map editor integration, network reconciliation, and the main game loop dispatch."

**Verdict: ⚠️ PARTIALLY VALIDATED — direction correct, magnitude overstated**

---

### Claim: "The boot-order race will crash the runtime"

**Muratori:** "Given that every ASM_CONST has null guards, Run 1's boot-race scenario is eliminated. Even if WASM initializes and calls `_tick` before `index.html` defines all callbacks, the `if(window.updateHUD)` guard skips the call silently. The player would see a few frames without HUD updates, then the callbacks activate and everything works. There's no crash."

**Carmack:** "I want to be precise though. The `if(window.X)` pattern protects against undefined. But it creates a **silent failure mode**: if `index.html` has a bug that prevents defining, say, `window.updateHUD`, the game runs but the HUD never appears. Nobody gets an error. This is preferable to crashing, but it's not ideal. A ready-flag handshake would provide explicit confirmation that all callbacks are present. That recommendation from Run 1 still has value — just not as a crash-prevention measure. It's a diagnostic measure."

**Verdict: ❌ RUN 1 BOOT-RACE CRASH CLAIM IS WRONG — guards prevent it**

---

## Pass 2 — New Findings from Source Code

### NEW-T-001: `_tick()` Takes Zero Parameters (Run 1 Data Flow Error)

**Carmack:** "Run 1's data flow description stated: 'JS calls `_tick(dt)` — enters WASM, runs one simulation step.' I checked the export table at line 6606:

```javascript
_tick = Module['_tick'] = createExportWrapper('tick', 0);
```

The `0` is the argument count. `_tick` takes **zero parameters**. The WASM side manages its own frame timing internally. And `renderer.js` line 5272 confirms: `Module._tick()` — no argument. This means Run 1's entire data flow narrative ('JS calls _tick(dt)') was inaccurate. The C++ side reads `emscripten_get_now()` or similar internal timing, not a JS-supplied delta."

**Abrash:** "This actually has a performance implication. The WASM side owns the clock. If the browser tab goes background and `requestAnimationFrame` stops, then the user returns, WASM's first `_tick()` will compute a massive dt internally (potentially seconds of accumulated time). This could cause physics integration instability — huge velocities, tunneling through terrain. There's no JS-side ability to clamp dt because JS doesn't supply it."

**Muratori:** "That's a real concern. In a custom game loop, you'd cap dt at something like 50ms and sub-step. Since WASM owns timing, the only mitigation is either: (a) the C++ source already caps dt (likely, if the developer is competent), or (b) the renderer.js side throttles how frequently it calls `_tick()` after long pauses. Neither is verifiable without C++ source access."

**Severity: P3-informational (timing is WASM-internal, JS cannot control it)**

---

### NEW-T-002: `window.updateAudio` Called with Two Different Argument Counts

**Acton:** "There are TWO `updateAudio` ASM_CONST entries with different signatures:

```javascript
348950: ($0,$1,$2,$3,$4) => { if(window.updateAudio)window.updateAudio($0,$1,$2,$3,$4); },  // 5 params
349012: ($0,$1,$2,$3)     => { if(window.updateAudio)window.updateAudio($0,$1,$2,$3); },      // 4 params
```

In `index.html` at line 3656, the handler is defined with 5 parameters:
```javascript
window.updateAudio = function(jetting, onGround, speed10, health1000, skiing) { ... };
```

When the 4-param variant fires, `skiing` is `undefined`. The audio engine will treat `undefined` as falsy, which means the skiing sound won't activate from that code path. This is a **real, silent behavioral bug**. The two C++ call sites pass different numbers of arguments — one includes skiing state, one doesn't."

**Carmack:** "The 4-param call is likely from a code path where skiing state isn't available or relevant — possibly the death/respawn state or spectator mode. But it should still explicitly pass `0` for skiing, not omit it. In JavaScript, `undefined` and `0` behave differently in some contexts (`undefined || defaultValue` vs `0 || defaultValue`). This is sloppy."

**Severity: P3 (audio only, degraded behavior not crash, but a real bug)**

---

### NEW-T-003: `Module._restartGame` Called But Not Exported

**Barrett:** "At `index.html` line 1843:

```javascript
if(Module._restartGame) Module._restartGame();
```

But `_restartGame` does not exist in the WASM export table. I searched all 6,868 lines of `tribes.js` — zero matches for `restartGame`. The guard `if(Module._restartGame)` prevents a crash, but this is dead code calling a phantom export. Either:

1. The C++ side removed this export but the JS side wasn't updated, or
2. The export was never added (planned feature), or
3. The export has a different name now

Either way, the 'restart game' functionality is silently broken. Clicking whatever UI triggers this path does nothing."

**Carmack:** "This is exactly the kind of bug that the missing API contract creates. There's no manifest of 'these exports MUST exist.' JS calls whatever it hopes is there, and the `if(Module.X)` guard hides the failure. You'd need to diff the export table against all `Module._*` call sites to find every phantom like this."

**Severity: P2 (feature silently broken — restart game doesn't work)**

---

### NEW-T-004: `window.sbFinish` Defined Twice — Second Overwrites First

**Muratori:** "In `index.html`, `window.sbFinish` is assigned at line 1898 AND again at line 1966. The second definition completely overwrites the first. Looking at both:

- **First definition (L1898):** Populates the live scoreboard (TAB key), renders rows with mute/report buttons, updates team scores, clears `sbRows=[]`.
- **Second definition (L1966):** Sets MVP name in the match-end screen, then does the same live scoreboard render, clears `sbRows=[]`.

The second definition supersedes the first, which means the first 68 lines of scoreboard code are **dead code** — they execute during the initial parse but are immediately overwritten. The final `sbFinish` function does include the live scoreboard logic, so functionality isn't lost. But this is a maintenance hazard and suggests copy-paste evolution without cleanup."

**Barrett:** "Looking more carefully — the first `sbFinish` doesn't show MVP. The second one does. So someone added MVP support by writing a new version of `sbFinish` below instead of modifying the existing one. Classic 'I'll just put the new version here' pattern. The first definition is 100% dead code."

**Severity: P3 (dead code, no functional impact — second definition is a superset)**

---

### NEW-T-005: `playSoundAt` Hard-Codes Sound IDs in ASM_CONSTS

**Acton:** "Two of the `playSoundAt` ASM_CONST entries hard-code the sound ID:

```javascript
348502: ($0,$1,$2) => { if(window.playSoundAt)window.playSoundAt(8,$0,$1,$2); },  // sound 8 always
348560: ($0,$1,$2) => { if(window.playSoundAt)window.playSoundAt(4,$0,$1,$2); },  // sound 4 always
```

While one entry properly passes the ID as a parameter:
```javascript
349121: ($0,$1,$2) => { if(window.playSoundAt)window.playSoundAt(4,$0,$1,$2); },  // also sound 4
```

This means the C++ side has `EM_ASM` calls that bake specific sound IDs into the JavaScript callback string rather than passing them as parameters. Sound IDs 4 and 8 are inlined. If anyone changes the sound bank numbering, these ASM_CONST entries are stale — they reference the old IDs, not the new ones. This is fragile but not currently broken."

**Severity: P3 (brittle coupling, no current bug)**

---

### NEW-T-006: index.html Defines 45 Unique window.* Globals

**Barrett:** "I counted the unique `window.*` assignments in `index.html`. There are **45 unique window.* globals** defined there. Combined with the 12 ASM_CONST-consumed callbacks, that's a total namespace footprint of approximately **57 globals** from just these two files. The system-map documented 83 total across all modules.

Key categories from index.html:
- **WASM bridge callbacks (12):** updateHUD, updateMatchHUD, sbRow, sbFinish, playSoundUI, playSoundAt, onMatchEnd, onDamageSource, onHitConfirm, updateAudio, r3FrameTime, renderScoreboard
- **Network bridge (8):** __tribesNet, __tribesReconcile, __tribesOnMatchStart, __tribesOnMatchEnd, __tribesShowReconnect, __tribesHideReconnect, __tribesOnSkillUpdate, __tribesActiveMapId
- **UI functions (6):** showDamageArc, updateSpawnProt, addKillMsg, addFriend, __tribesSetGameClock, __tribesSyncPBRChips
- **State/config (8):** __teamColors, __tiers, _r327PrevCarry, _skiPeakSpeed, _skiPeakTimer, __tribesUseThree, __lastReplayUrl, ST
- **Debug/internal (5):** DEBUG_LOGS, __editor, __replay, openMapEditor, r3FrameTime (as a value, not a function)
- **Misc (6):** location.href redirects, event handlers, etc."

**Severity: P3-informational (documents the actual scope for future audit)**

---

### NEW-T-007: WASM Exports Include Stack Introspection Functions

**Carmack:** "The export table includes several stack introspection functions that are available to any JavaScript code:

```javascript
_emscripten_stack_get_end
_emscripten_stack_get_base
_emscripten_stack_get_free
_emscripten_stack_get_current
__emscripten_stack_restore
__emscripten_stack_alloc
```

These are Emscripten runtime functions, not game exports. But they're on `Module.*`, which means any script on the page can call `Module._emscripten_stack_get_free()` to query remaining stack space, or worse, `Module.__emscripten_stack_alloc()` to allocate on the WASM stack from JavaScript. In the context of this being a single-page game with no third-party scripts, this is acceptable. But it means we already have `_emscripten_stack_get_free` as a rudimentary heap/stack monitoring tool — Run 1's recommendation for `_getHeapUsed()` can be partially addressed by reading stack utilization from these existing exports."

**Severity: P3-informational (existing monitoring capability not documented)**

---

## Pass 3 — Cross-Reference: WASM Exports vs index.html Calls

### Exports Defined in tribes.js (lines 6569-6610)

| Export | Param Count | Called in index.html? | Called in renderer.js? |
|--------|-------------|----------------------|----------------------|
| `_setSettings` | 1 | ✅ L3747, L4012 | ❌ |
| `_setGameSettings` | 5 | ✅ L1836, L1845, L4199 | ❌ |
| `_updateScoreboard` | 0 | ✅ L1856, L1930 | ❌ |
| `_applyLoadout` | 3 | ✅ L3064 | ❌ |
| `_setMapBuildings` | 2 | ❌ (likely renderer) | ✅ (system-map L5473) |
| `_setLocalPlayerNetCorrection` | 5 | ✅ L4348, L4363, L4365 | ❌ |
| `_getPlayerStatePtr` | 0 | ✅ L1770, L2220, L2751, L4354, L4369 | ✅ L3655 |
| `_getPlayerStateCount` | 0 | ❌ | ✅ L3753 |
| `_getPlayerStateStride` | 0 | ✅ L1771, L2221, L4355, L4370 | ✅ L3654 |
| `_getLocalPlayerIdx` | 0 | ✅ L1772, L2752, L4356, L4371 | ✅ L3751, L4074 |
| `_getProjectileStatePtr` | 0 | ❌ | ✅ L3659 |
| `_getProjectileStateCount` | 0 | ❌ | ✅ L3938, L4750 |
| `_getProjectileStateStride` | 0 | ❌ | ✅ L3658 |
| `_getParticleStatePtr` | 0 | ❌ | ✅ L3663 |
| `_getParticleStateCount` | 0 | ❌ | ✅ |
| `_getParticleStateStride` | 0 | ❌ | ✅ L3662 |
| `_getFlagStatePtr` | 0 | ❌ | ✅ L3667 |
| `_getFlagStateCount` | 0 | ❌ | ✅ |
| `_getFlagStateStride` | 0 | ❌ | ✅ L3666 |
| `_getBuildingPtr` | 0 | ❌ | ✅ L1555 |
| `_getBuildingCount` | 0 | ❌ | ✅ L1556 |
| `_getBuildingStride` | 0 | ❌ | ✅ L1557 |
| `_getHeightmapPtr` | 0 | ❌ | ✅ L142, L643 |
| `_getHeightmapCount` | 0 | ❌ | ✅ |
| `_getHeightmapSize` | 0 | ❌ | ✅ L143, L644 |
| `_getHeightmapWorldScale` | 0 | ❌ | ✅ L144, L645 |
| `_getCameraFov` | 0 | ❌ | ✅ L4229 |
| `_getMatchState` | 0 | ❌ | ✅ |
| `_isReady` | 0 | ❌ | ✅ L5271 |
| `_getThirdPerson` | 0 | ❌ | ✅ L3755, L4131 |
| `_appendInteriorShapeAABBs` | 2 | ❌ | ✅ |
| `_setLocalAimPoint3P` | 3 | ❌ | ✅ L4224 |
| `_appendInteriorMeshTris` | 8 | ❌ | ✅ L2499 |
| `_getPlayerSkiing` | 0 | ✅ L4044 | ❌ |
| `_getPlayerSpeed` | 0 | ✅ L4047 | ❌ |
| `_getPlayerSlopeDeg` | 0 | ✅ L4054 | ❌ |
| `_setRenderMode` | 1 | ✅ L4226 | ❌ |
| `_tick` | 0 | ❌ | ✅ L5272 |
| `_main` | 2 | ❌ | ❌ (called by Emscripten runtime) |
| `_malloc` | 1 | ❌ | ✅ L2497, L5471 |
| `_free` | 1 | ❌ | ✅ L5471 |

### Phantom Exports (called in index.html, NOT in WASM export table)

| Phantom Call | Location | Guard? | Impact |
|-------------|----------|--------|--------|
| `Module._restartGame` | L1843 | ✅ `if(Module._restartGame)` | Restart game silently broken |

**Carmack:** "Only one phantom export. But it's a gameplay feature — restart — that silently fails. Every other `Module._*` call in index.html properly references an exported function."

---

## Pass 4 — System-Level Validation

### The Actual Boundary Map (corrected from Run 1)

```
┌────────────────────────────────────────────────────────────┐
│              index.html (4,519 lines total)                 │
│              (~3,200 lines hand-written JS)                 │
│   ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌─────────────┐  │
│   │   HUD    │ │ Settings │ │ Menus /  │ │   Audio     │  │
│   │ Renderer │ │    UI    │ │ Lobbies  │ │   Engine    │  │
│   └────┬─────┘ └────┬─────┘ └────┬─────┘ └──────┬──────┘  │
│        │             │            │               │         │
│   ┌────▼─────────────▼────────────▼───────────────▼──────┐  │
│   │   45 window.* globals (callbacks + state + config)   │  │
│   │   + HEAPF32/HEAP32 direct memory reads               │  │
│   │   + Module._* export calls (null-guarded)            │  │
│   └────────────────────┬─────────────────────────────────┘  │
└────────────────────────┼────────────────────────────────────┘
                         │
              ┌──────────▼──────────┐
              │     tribes.js       │
              │  (Emscripten glue)  │
              │  6,868 lines        │
              │                     │
              │  ASM_CONSTS (C++→JS)│   ← ALL 19 entries have null guards
              │  19 callback entries│
              │  40 WASM exports    │   ← 0-param _tick (WASM owns timing)
              │  Memory views       │   ← Fixed, never detach
              │  WASM loader        │
              └──────────┬──────────┘
                         │
              ┌──────────▼──────────┐
              │     tribes.wasm     │
              │   (compiled C++)    │
              └─────────────────────┘
```

### Corrected Data Flow: One Frame

1. **JS calls `Module._tick()`** — **zero parameters** (WASM manages its own timing)
2. **C++ calls ASM_CONSTS** during tick (all null-guarded):
   - `updateHUD(14 params)` — JS updates HUD overlay
   - `updateMatchHUD(4 params)` — JS updates match timer/state
   - `updateAudio(5 params)` — JS updates listener (**or 4 params from alternate path — bug**)
   - `playSoundAt(id, x, y, z)` — JS triggers spatial audio (0-N times, some IDs hard-coded)
   - `playSoundUI(id)` — UI sounds (some IDs hard-coded to 5, 6, 7)
   - `onDamageSource(srcX, srcZ)` / `onHitConfirm(amount)` — damage indicators
   - `sbRow(...)` + `sbFinish(...)` — scoreboard push
   - `onMatchEnd(winner, rs, bs)` — match end
   - `r3FrameTime` read via `||0` fallback — perf logging
3. **`_tick` returns** — renderer.js reads export getters for state
4. **JS renders frame** using WebGL

---

## Pass 5 — Expert Debate on Corrected Findings

### The Null Guard Discovery

**Muratori:** "This changes the priority landscape significantly. Run 1's top P1 recommendation was 'add defensive null checks to ASM_CONST callbacks.' That work is already done by the C++ developer. The `if(window.X)` pattern is the standard Emscripten EM_ASM guard. Whoever wrote the C++ source knew what they were doing here."

**Carmack:** "Agreed. But I'll reframe what the actual risk is. The null guards protect against missing definitions. They do NOT protect against:

1. **Wrong signatures** — updateAudio being called with 4 params instead of 5
2. **Semantic mismatches** — sbFinish being defined twice (second overwrites first)
3. **Phantom exports** — _restartGame being called but not existing

These are the real interface bugs, and Run 1 missed all three because it focused on the crash scenario that doesn't exist."

**Acton:** "Run 1's recommendation #5 ('implement a ready-flag handshake') still has merit — not for crash prevention, but for **diagnostic clarity**. If `window.updateHUD` is undefined at first tick, you want to know. The null guard silently skips. A ready-flag with a one-time warning (`console.warn('WASM bridge not ready, callbacks will be skipped')`) would surface initialization ordering issues during development."

**Barrett:** "I'd reclassify it from P2 to P3-nice-to-have. The guards work. The game ships. The handshake is a developer experience improvement, not a correctness fix."

---

### The index.html Gap

**Barrett:** "Run 1 flagged this as P0 — schedule a full Phase 2a review of index.html. Having now measured it at ~3,200 lines of hand-written JS with:

- 45 window.* global definitions
- All 12 ASM_CONST callback implementations
- All Module._* call sites for settings, loadout, scoreboard, net correction
- Audio engine (Web Audio API with spatial audio)
- Complete menu/lobby/matchmaking UI
- Damage indicator rendering
- Spawn protection HUD
- Map editor integration
- Replay viewer integration
- Friend list management
- Network reconciliation bridge

This is the **most critical unaudited surface in the entire codebase**. It touches WASM, audio, networking, DOM, and user input. Run 1's P0 flag was correct and this remains the highest-priority audit gap."

**Carmack:** "And unlike tribes.js — which is generated and therefore predictable — index.html is hand-written, evolved organically (the sbFinish duplication proves that), and has zero @ai-contract documentation. Every bug I've seen in the cross-reference (phantom _restartGame, dual sbFinish, 4-vs-5 param updateAudio) is in index.html, not tribes.js."

---

## Run 1 Findings: Validated / Challenged / Corrected

| Run 1 ID | Run 1 Finding | Run 1 Severity | Run 2 Verdict | Notes |
|-----------|--------------|----------------|---------------|-------|
| T-001 | Audit plan mischaracterizes tribes.js | Documentation | ✅ **VALIDATED** | Confirmed 100% Emscripten glue |
| T-002 | HEAPF32 detachment impossible under current build | P0→P2 | ✅ **VALIDATED** | Lines 4354-4361 confirm unconditional abort |
| T-003 | OOM causes hard abort with no monitoring | P2 | ✅ **VALIDATED** | Note: `_emscripten_stack_get_free` exists for partial monitoring |
| T-004 | ASM_CONST callbacks have no null guards | P1 | ❌ **WRONG** | All 19 entries have `if(window.X)` guards. **Delete this finding.** |
| T-005 | updateHUD passes 14 positional params | P3 | ✅ **VALIDATED** | Confirmed at ASM_CONST entry 349229 |
| T-006 | Struct layouts have no versioning | P2 | ✅ **VALIDATED** | Magic offsets throughout index.html and renderer.js |
| T-007 | No ready handshake between WASM and JS | P2 | ⚠️ **DOWNGRADE to P3** | Null guards eliminate crash risk; handshake is diagnostic-only |
| T-008 | Missing team-count/info exports for 4-tribe | P2 | ✅ **VALIDATED** | No _getTeamCount in export table |
| T-009 | Export naming inconsistencies | P3 | ✅ **VALIDATED** | Confirmed mixed verb/noun/append patterns |
| T-010 | index.html needs its own Phase 2a review | P0 | ✅ **VALIDATED + STRENGTHENED** | Now measured at ~3,200 LOC, 45 globals, confirmed bugs |

### Run 1 Recommendations: Status

| # | Recommendation | Run 1 Priority | Run 2 Status |
|---|----------------|----------------|-------------|
| 1 | Add HEAPF32.buffer === wasmMemory.buffer assertion | P1 | ✅ **KEEP** — cheap safety net |
| 2 | Add _getHeapUsed/_getHeapTotal exports | P1 | ⚠️ **DOWNGRADE P2** — `_emscripten_stack_get_free` partially covers this |
| 3 | Add defensive null checks to ASM_CONST callbacks | P1 | ❌ **DELETE** — already implemented |
| 4 | Add @ai-contract header to generated output | P2 | ✅ **KEEP** |
| 5 | Implement ready-flag handshake | P2 | ⚠️ **DOWNGRADE P3** — diagnostic value only |
| 6 | Migrate updateHUD to struct-pointer pattern | P2 | ✅ **KEEP** |
| 7 | Add layout descriptor headers | P3 | ✅ **KEEP** |
| 8 | Add _getTeamCount/_getTeamInfo exports | P2 | ✅ **KEEP** |
| 9 | Rename output file | P3 | ✅ **KEEP** |
| 10 | Schedule index.html Phase 2a review | P0 | ✅ **KEEP — URGENT** |

---

## New Findings Not in Run 1

| ID | Finding | Severity | Source |
|----|---------|----------|--------|
| NEW-T-001 | `_tick()` takes 0 params, not dt — WASM owns timing | P3 | tribes.js L6606, renderer.js L5272 |
| NEW-T-002 | `updateAudio` called with 4 OR 5 params (skiing dropped) | P3 | tribes.js L348950, L349012 |
| NEW-T-003 | `Module._restartGame` called but not exported (phantom) | P2 | index.html L1843, not in export table |
| NEW-T-004 | `window.sbFinish` defined twice, first is dead code | P3 | index.html L1898, L1966 |
| NEW-T-005 | `playSoundAt` hard-codes sound IDs in 2 ASM_CONST entries | P3 | tribes.js L348502, L348560 |
| NEW-T-006 | index.html defines 45 unique window.* globals | P3-info | grep analysis |
| NEW-T-007 | Stack introspection exports available for monitoring | P3-info | tribes.js L6503-6510 |
| NEW-T-008 | index.html JS is ~3,200 LOC, not ~4,500 as Run 1 estimated | Correction | Line count analysis |

---

## Expert Sign-Off (Run 2)

- **Carmack:** "Run 1 got the big picture right: tribes.js is generated code, the memory model is fixed, and index.html is the real audit target. But Run 1 got the null-guard story completely wrong — the generated code is more defensive than we assumed. The real bugs are in the hand-written code: phantom exports, duplicate definitions, and inconsistent callback signatures. Focus the next audit on index.html."

- **Abrash:** "The zero-parameter `_tick` is worth noting. WASM owns its own clock. This limits JS-side ability to manage frame timing, pause behavior, and dt clamping. It's not a bug today but it constrains future architecture."

- **Muratori:** "Run 1 spent significant analysis time on a crash scenario that doesn't exist. The lesson: read the source before building a threat model. Every ASM_CONST has a guard. The recommendation to 'add null checks' was wasted effort on an already-solved problem. Run 2 caught this because we read the actual file."

- **Acton:** "The struct layout concerns from Run 1 remain valid and are actually worse than stated — index.html has magic offsets scattered across 5+ locations reading from HEAPF32 directly. No constants file, no shared header. A C++ struct reorder creates bugs in 5 different places."

- **Barrett:** "My key Run 2 contribution: the phantom `_restartGame` export. This is the kind of bug that accumulates when there's no contract manifest. You need a checked list: 'these exports exist in WASM, these calls exist in JS, they must match.' Without it, features break silently."

---

*Run 2 validation complete. Three Run 1 findings corrected, eight new findings discovered. Priority landscape shifted: the null-guard concern is eliminated, the index.html audit gap is confirmed as the highest-priority remaining work.*
