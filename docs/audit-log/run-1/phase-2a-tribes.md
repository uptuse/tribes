# Phase 2a — Adversarial Convergence Review: tribes.js (Run 1)

**Target:** `tribes.js` — 6,868 lines (Emscripten-generated WASM bootstrap)  
**Date:** 2026-04-29  
**Panel:** Carmack, Abrash, Muratori, Acton, Barrett  

---

## Audit Plan Correction

The original audit plan (`docs/audit-plan.md`) described `tribes.js` as:

> *"WASM bridge, game state machine, HUD, settings, input, audio hookup"*

**This is incorrect.** `tribes.js` is 100% Emscripten-generated code — the JavaScript "glue" that bootstraps and wraps the compiled C++ WASM module. It contains:

- The Emscripten runtime (module loading, memory init, syscall stubs)
- `ASM_CONSTS` — inlined JS callbacks that the C++ side invokes via `EM_ASM`
- Typed array view management (`HEAP8`, `HEAPF32`, etc.)
- The WASM export table — function pointers exposed to JavaScript

**No hand-written game logic lives here.** The actual game bridge — HUD rendering, settings UI, input handling, audio management, scoreboard display, the entire application shell — lives in `index.html` (~4,500 lines of hand-written JavaScript). That is where the "game state machine, HUD, settings, input, audio hookup" actually reside.

This review therefore pivots to what actually matters in this file:

1. The **WASM↔JS boundary** — the `ASM_CONSTS` callbacks and the export surface
2. The **memory model** — fixed heap, no growth, crash semantics
3. The **API contract** — what C++ exposes and what JS consumes
4. **Risks** that are invisible when you think this is "just boilerplate"

---

## Pass 1 — Break It

*Each panelist independently attempts to find failure modes, security issues, and correctness bugs.*

### Carmack

The memory model is the critical item. `_emscripten_resize_heap` calls `abortOnCannotGrowMemory()`, which terminates the runtime. This is a hard crash — no recovery, no fallback, no graceful degradation. If the C++ side ever allocates past the initial heap:

```
Cannot enlarge memory arrays ... → abort()
```

The game just dies. No save state, no error screen, no reconnect. The user sees a frozen frame or a blank page.

The `ASM_CONSTS` callbacks use `window.*` globals exclusively. Every single one — `sbRow`, `sbFinish`, `playSoundUI`, `playSoundAt`, `onMatchEnd`, `onDamageSource`, `onHitConfirm`, `updateHUD`, `updateMatchHUD`, `updateAudio`, `r3FrameTime`. If any of these are undefined when C++ calls them, you get a runtime exception inside the WASM glue, which Emscripten wraps in an abort. The C++ side cannot know the JS side hasn't finished initialization.

There's a boot-order race: if the WASM module initializes and starts ticking before `index.html` has defined all the `window.*` callbacks, the first `updateHUD` call crashes the runtime.

### Abrash

Looking at `updateHUD` — it pushes 14 parameters across the WASM↔JS boundary on every frame:

```
hp, en, ammo, maxAmmo, wpn, speed10, skiing, carrying, px, pz, yaw1000, rs, bs, armor
```

That's 14 integer-to-JS conversions per frame. Not catastrophic, but the call overhead for `EM_ASM` is non-trivial — each invocation goes through the `ASM_CONSTS` dispatch table, marshals arguments, calls into JS, and returns. At 60fps that's 840 boundary crossings per second just for HUD updates, plus `updateMatchHUD` (4 params), `updateAudio`, and any `playSoundAt`/`playSoundUI` calls.

`updateMemoryViews()` (line 613) recreates ALL typed array views from `wasmMemory.buffer`. Under the current build config (no memory growth), this only runs once at init. But the function exists, and if anyone ever enables `-sALLOW_MEMORY_GROWTH`, it fires on every growth event, invalidating every `HEAPF32` reference held by external code. The `index.html` bridge reads player state, projectile state, particle state, flag state, and building state via raw pointer offsets into these heaps. A mid-frame buffer detachment would be catastrophic — silent data corruption, not a crash.

### Muratori

Why are we even reviewing this file? It's generated code. Nobody should be editing it. The interesting question is: **what constraints does it impose on the code that IS hand-written?**

The `ASM_CONSTS` — those are the C++ author's decisions, baked into the build. They chose to use `window.*` globals as the JS↔C++ interface. That's a design choice with consequences:

1. **No namespacing.** `window.sbRow` is a global. Any script on the page can clobber it. Any browser extension, any analytics tag, any ad SDK.
2. **No versioning.** The C++ side emits 14 parameters to `updateHUD`. If you add a 15th (say, `jetEnergy` for tribes), the JS side silently ignores it... or the C++ side sends garbage for the 15th slot because JS doesn't consume it. There's no schema, no handshake.
3. **No error propagation.** C++ calls `window.updateHUD(...)`. If JS throws, Emscripten swallows or aborts. C++ never knows.

The export API has a peculiar pattern: `_getPlayerStatePtr`, `_getPlayerStateCount`, `_getPlayerStateStride` as three separate calls. Why not one call that returns a struct? Because the WASM↔JS boundary doesn't support returning structs. So you get three round-trips to learn {pointer, count, stride}, and then you do raw pointer arithmetic in JavaScript against `HEAPF32`. This is the entire renderer's data path. It's manual, fragile, and has zero type safety.

### Acton

The data access pattern is what concerns me. The export API exposes:

- Player state: `ptr + count + stride`
- Projectile state: `ptr + count + stride`
- Particle state: `ptr + count + stride`
- Flag state: `ptr + count + stride`
- Building state: `ptr + count + stride`
- Heightmap: `ptr + count + size + worldScale`

JavaScript reads these as flat typed arrays via `HEAPF32[ptr/4 + offset]`. The stride tells you how many floats per entity. This is data-oriented — which is good — but the field layout within each stride is **completely undocumented** on the JS side. `index.html` uses magic offsets like `HEAPF32[base/4 + 0]` for position X, `HEAPF32[base/4 + 1]` for position Y, etc. If the C++ struct adds a field or reorders, JS reads garbage. Silently.

There's no assertion, no checksum, no layout version. The C++ side and JS side must agree on struct layout by convention. On a project with one developer, that's manageable. When the codebase scales, it's a landmine.

### Barrett

The export naming is inconsistent. Some functions are verbs (`_setSettings`, `_applyLoadout`, `_tick`), some are getters (`_getPlayerStatePtr`, `_getCameraFov`), some are actions (`_appendInteriorShapeAABBs`, `_updateScoreboard`). The `_append*` functions imply accumulating into a buffer — but there's no corresponding `_clear*` or `_reset*` to flush it. Who owns that buffer's lifecycle?

`_setLocalPlayerNetCorrection` — "net correction" for what? Position? Velocity? Rotation? All three? The name doesn't tell you, and there's no schema.

`_setRenderMode` — what are the valid modes? Integer enum? Which integers? This is a C++ enum that JS must replicate by magic number.

The scoreboard callback pattern is odd: `_updateScoreboard` triggers the C++ side to call `window.sbRow` N times, then `window.sbFinish` once. This is a push-based iteration protocol with no error handling. If `sbRow` throws on row 5 of 16, the remaining 11 rows are lost and `sbFinish` may or may not fire depending on Emscripten's exception handling mode.

---

## Pass 2 — Challenge Architecture

*Panelists challenge each other's findings and the architectural decisions.*

### Carmack → Muratori

> "The window.* globals are fine for a single-page game. There's no ad SDK, no third-party scripts. This isn't a web app with a dozen vendors — it's a game running in a browser tab. Namespacing adds complexity for zero practical benefit. The real issue isn't namespace pollution. It's the missing null checks before each callback invocation. One guard — `if (typeof window.updateHUD === 'function')` — in each `ASM_CONST` turns a crash into a silent skip."

### Muratori → Carmack

> "I'll grant you the namespace point for now. But the null-check solution is wrong. Silent skips mean the game runs with a stale HUD and the developer never knows. You need a `window._wasmBridgeReady` flag. C++ checks it once during init. If it's false, the game holds at a loading screen. If it's true, you've got a contract that all callbacks exist. Checking 12 globals on every frame is dumb."

### Abrash → Acton

> "The ptr/count/stride pattern is fine from a performance perspective. The alternative — copying data across the boundary — would be catastrophic. Reading HEAPF32 directly means zero-copy access from JS into WASM linear memory. It's the fastest possible path. The magic offsets are ugly but the CPU doesn't care about aesthetics. What I'd want to know: are the strides cache-line-friendly? If player stride is 37 floats, that's 148 bytes — misaligned to 64-byte cache lines. Alternating access patterns across players would thrash L1."

### Acton → Abrash

> "The zero-copy access is correct — I'm not arguing for copies. I'm arguing for a layout descriptor. C++ writes a small header at a known offset: `{version: u32, fieldCount: u32, fields: [{name_hash: u32, offset: u32, type: u8}...]}`. JS reads that once at init and builds its accessor table. Cost: one extra indirection at init. Benefit: if C++ reorders the struct, JS crashes loudly at init instead of rendering garbage silently for weeks."

### Barrett → Carmack

> "On the memory growth question — hard abort on OOM is actually fine for a game. What are you going to do with a 'graceful' OOM? Show a dialog that says 'you ran out of memory, sorry'? The user can't do anything about it. The real question is: is the initial heap sized correctly? And is there any monitoring? Can we log heap usage at tick intervals so we catch the approach to the cliff before shipping?"

### Carmack → Barrett

> "Agreed. The abort is fine. What's not fine is that there's zero visibility into how close you are to the cliff. The C++ side should expose `_getHeapUsed` and `_getHeapTotal` through the export table. JS can log it, graph it, raise an alarm at 80%. Right now you fly blind until the engine explodes."

---

## Pass 3 — Debate to Consensus

*The panel debates the contentious items and works toward recommendations.*

### The Memory Growth Debate

**Carmack:** "Let me reframe the Phase 1 finding. Phase 1 flagged 'HEAPF32 buffer detachment' as critical and recommended `refreshViews()` at the top of the game loop. Under the current build — memory growth disabled — this cannot happen. `updateMemoryViews()` runs once at startup and never again. The views never detach. The Phase 1 recommendation is unnecessary **today**, but I want to be precise about what that means."

**Muratori:** "It means the Phase 1 finding is wrong. Not 'premature' — wrong. You can't flag something as critical when the build config makes it impossible. That's FUD. It wastes engineering time on a problem that doesn't exist."

**Carmack:** "The build config is one flag change away from making it real. `-sALLOW_MEMORY_GROWTH=1` in the Makefile and suddenly every `HEAPF32` reference in `index.html` is a time bomb. I wouldn't call Phase 1 wrong — I'd call it mislabeled. It's not a current bug, it's a dormant architectural risk."

**Abrash:** "Let me add the practical angle. If memory growth is ever enabled, every frame that touches HEAPF32 after a growth event reads detached memory. The typed array's backing `ArrayBuffer` changes, but stale references still point to the old one. You don't get an exception — you get zeros or stale data. It's the worst kind of bug: silent and intermittent. So yes, the fix is trivial — call `updateMemoryViews()` or read fresh views — but the detection is nearly impossible after the fact."

**Acton:** "Here's my position: document the invariant. Put a comment in the build config, in the bridge code, and in the `@ai-contract` block: 'This build assumes fixed memory. If you enable growth, you MUST add view refresh at frame boundaries in index.html.' Make it impossible to accidentally change the flag without seeing the warning."

**Barrett:** "I'll go further. Add a runtime assertion. At the top of the JS game loop, check `HEAPF32.buffer === wasmMemory.buffer`. If they diverge, you know growth happened and your views are stale. It's one comparison per frame — unmeasurable — and it catches the exact scenario we're worried about."

**Carmack:** "Barrett's assertion is the right answer. Cheap, precise, catches exactly the failure mode. Combined with Acton's documentation. Let's move on."

**Consensus:** Phase 1's HEAPF32 finding is **not a current bug** but a **dormant architectural risk**. Reclassify from P0-critical to **P2-latent**. Add Barrett's runtime assertion. Document the fixed-memory invariant per Acton.

### The Audit Plan Mischaracterization

**Muratori:** "I want to put this on record. The audit plan said tribes.js contains the game state machine, HUD, settings, input, and audio hookup. It doesn't contain any of those things. It's a compiler artifact. The plan was written from file names, not from reading the code."

**Carmack:** "Correct. This means two things: first, `index.html` needs its own full Phase 2 review — that's where all the game bridge logic actually lives. Second, every finding from the audit plan that references 'tribes.js' as the source of game logic needs to be re-attributed to `index.html`."

**Barrett:** "And the file should arguably be renamed. `tribes.js` sounds like hand-written game code. `tribes-wasm-glue.js` or `tribes.emscripten.js` would prevent this confusion in the future."

**Acton:** "Renaming generated code is fragile — it regenerates on every build. Better to add a header comment and update the Makefile's output flag."

**Consensus:** The audit plan's description of `tribes.js` was **materially wrong**. A separate Phase 2 pass must be scheduled for `index.html`. The file should have a clear header comment identifying it as generated code. Update the audit plan to reflect the correct locations of game bridge logic.

### The ASM_CONSTS Callback Safety

**Muratori:** "Back to the window.* callbacks. We have 12 globals that C++ calls blind. Carmack wants null guards. I want a ready flag. Let me argue for the ready flag more concretely: the C++ init sequence is deterministic. It calls `_main`, which eventually calls `_tick`, which calls the callbacks. If we set `window._wasmReady = true` only after all 12 callbacks are defined, and C++ checks that flag in its first `_tick`, we've got a hard contract. One check, not twelve."

**Carmack:** "The ready flag is cleaner but it requires modifying C++ source and rebuilding. The null guards can be injected into the `ASM_CONSTS` without touching C++ — they're inline JS. For a generated file, I'd argue for the approach that doesn't require a C++ change."

**Barrett:** "Why not both? The ready flag is the correct long-term solution. The null guards are a stopgap you can patch into the current build's ASM_CONSTS section. Since this file is generated, the real fix is in the C++ EM_ASM macros."

**Acton:** "I want to point out that `updateHUD` with 14 positional integer parameters is begging for a bug. `hp` and `en` swapped? You'd never know from the call site. The C++ side should pack these into a struct at a known pointer and JS reads them by named offset. One pointer parameter instead of 14."

**Carmack:** "That's a good improvement but it's a C++ refactor, not a tribes.js fix. File it as an architectural recommendation."

**Consensus:** Short-term, add defensive guards in `ASM_CONSTS`. Long-term, implement a ready-flag handshake and migrate `updateHUD`/`updateMatchHUD` to struct-pointer passing. Both require C++ changes and a rebuild.

### Four-Tribe Support: Missing Exports

**Barrett:** "Looking at the export surface for 4-tribe support. `_getFlagStatePtr/Count/Stride` — this should scale if the C++ side allocates flag state for 4 tribes. `_updateScoreboard` → `sbRow` push pattern should also scale. But I don't see any tribe-specific exports. No `_getTeamCount`, no `_getTeamColor`, no `_getTeamScore`. Either these are packed into the player state stride or the match state callback, or they're missing."

**Carmack:** "They're in `updateMatchHUD`'s 4 parameters and in the player state stride. Each player has a team index. The JS side iterates players and groups by team. It's implicit, not explicit. For 2 tribes that works. For 4, you need the JS side to know how many teams exist — and right now that's hardcoded in `index.html`, not exposed from C++."

**Barrett:** "So we need at minimum: `_getTeamCount()`, and ideally `_getTeamInfo(idx)` that returns a pointer to `{color_r, color_g, color_b, score, name_ptr}` for each team. Without `_getTeamCount`, the 4-tribe transition requires JS to guess or hardcode."

**Consensus:** Add `_getTeamCount` and `_getTeamInfo` exports to the C++ build for proper 4-tribe support. Current 2-tribe assumption is baked into the implicit contract between C++ and JS.

---

## Pass 4 — System-Level Review

*How tribes.js interacts with the rest of the system.*

### Boundary Map

```
┌────────────────────────────────────────────────────────┐
│                    index.html (~4,500 LOC)              │
│   ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌─────────┐  │
│   │   HUD    │ │ Settings │ │  Input   │ │  Audio  │  │
│   │ Renderer │ │    UI    │ │ Handler  │ │ Manager │  │
│   └────┬─────┘ └────┬─────┘ └────┬─────┘ └────┬────┘  │
│        │             │            │             │       │
│   ┌────▼─────────────▼────────────▼─────────────▼────┐  │
│   │           window.* globals (12 callbacks)        │  │
│   │   + HEAPF32/HEAP32 direct memory reads           │  │
│   │   + WASM export calls (_tick, _set*, _get*)      │  │
│   └────────────────────┬─────────────────────────────┘  │
└────────────────────────┼────────────────────────────────┘
                         │
              ┌──────────▼──────────┐
              │     tribes.js       │
              │  (Emscripten glue)  │
              │                     │
              │  ASM_CONSTS (C++→JS)│
              │  Export table (JS→C++)│
              │  Memory views       │
              │  WASM loader        │
              └──────────┬──────────┘
                         │
              ┌──────────▼──────────┐
              │     tribes.wasm     │
              │   (compiled C++)    │
              │                     │
              │  Game simulation    │
              │  Physics engine     │
              │  Network protocol   │
              │  Entity management  │
              └─────────────────────┘
```

### Data Flow: One Frame

1. **JS calls `_tick(dt)`** — enters WASM, runs one simulation step
2. **C++ calls `ASM_CONSTS`** during tick:
   - `updateHUD(14 params)` — JS updates HUD overlay
   - `updateMatchHUD(4 params)` — JS updates match timer/state
   - `updateAudio(params)` — JS updates listener position
   - `playSoundAt(id, x, y, z)` — JS triggers spatial audio (0-N times)
   - `onDamageSource(...)` / `onHitConfirm(...)` — JS shows indicators
   - `r3FrameTime(ms)` — JS logs perf
3. **`_tick` returns** — JS reads export getters:
   - `_getPlayerStatePtr/Count/Stride` → iterate HEAPF32 for positions, rotations, states
   - `_getProjectileStatePtr/Count/Stride` → iterate for projectile rendering
   - `_getParticleStatePtr/Count/Stride` → iterate for particle effects
   - `_getFlagStatePtr/Count/Stride` → render flag positions
   - `_getBuildingPtr/Count/Stride` → render structures
   - `_getCameraFov`, `_getThirdPerson` → set camera params
4. **JS renders frame** using WebGL

### Failure Modes at System Level

| Failure | Trigger | Consequence | Detection |
|---------|---------|-------------|-----------|
| OOM abort | Heap exhaustion | Runtime terminated, frozen frame | None (crash) |
| Callback undefined | Boot race / code error | Emscripten abort | Console error, then freeze |
| Struct layout mismatch | C++ rebuild without JS update | Silent rendering garbage | Visual only |
| View detachment | Future `-sALLOW_MEMORY_GROWTH` | Silent stale data reads | None without Barrett's assertion |
| Export missing after rebuild | C++ rename / removal | JS TypeError on call | Console error |

### Cross-File Dependencies

- **`tribes.wasm`** — the compiled module, loaded by `tribes.js`. Binary contract: export names must match exactly.
- **`index.html`** — defines all `window.*` callbacks, reads all HEAPF32 views, calls all exports. The true consumer of the WASM API.
- **`renderer.js`** — consumes the typed array data (player positions, projectiles, particles) that `index.html` reads from HEAPF32. Indirect dependency through `index.html`.
- **Build system** — `tribes.js` is a build artifact. Any change to Emscripten flags (`-sALLOW_MEMORY_GROWTH`, `-sEXPORTED_FUNCTIONS`, `-sEXPORTED_RUNTIME_METHODS`) changes this file's behavior.

---

## Pass 5 — AI Rules Extraction (@ai-contract block)

Since `tribes.js` is generated code, the `@ai-contract` block should serve as a **"do not edit / here's what this actually is"** marker and document the boundary contract for AI tools and future developers.

### Recommended @ai-contract Block

```javascript
/**
 * @ai-contract tribes.js
 * GENERATED FILE — DO NOT EDIT MANUALLY
 * Source: Emscripten compilation of C++ game engine
 * Rebuild: [document build command here]
 *
 * PURPOSE: WASM bootstrap glue. Loads tribes.wasm, provides memory views,
 * dispatches ASM_CONST callbacks, and exposes the WASM export table.
 *
 * INVARIANTS:
 * - Memory growth is DISABLED. Heap is fixed at init. OOM = abort().
 *   If you enable -sALLOW_MEMORY_GROWTH, you MUST add HEAPF32 view refresh
 *   at frame boundaries in index.html. See audit-log/run-1/phase-2a-tribes.md.
 * - All ASM_CONST callbacks reference window.* globals defined in index.html.
 *   These MUST be defined before first _tick() call.
 * - WASM exports are the ONLY safe interface from JS→C++. Do not access
 *   WASM internals directly.
 * - Struct layouts read via HEAPF32[ptr/4 + offset] are defined in C++ source.
 *   JS magic offsets MUST match C++ struct field order. No runtime validation exists.
 *
 * CONSUMES (from index.html via window.*):
 *   window.updateHUD(hp,en,ammo,maxAmmo,wpn,speed10,skiing,carrying,px,pz,yaw1000,rs,bs,armor)
 *   window.updateMatchHUD(matchState, timeRemain, respawnTimer10, spawnProtRemain10)
 *   window.updateAudio(...)
 *   window.playSoundUI(id)
 *   window.playSoundAt(id, x, y, z)
 *   window.sbRow(...)
 *   window.sbFinish()
 *   window.onMatchEnd(...)
 *   window.onDamageSource(...)
 *   window.onHitConfirm(...)
 *   window.r3FrameTime(ms)
 *
 * EXPOSES (to index.html / renderer.js):
 *   Settings:    _setSettings, _setGameSettings
 *   Loadout:     _applyLoadout
 *   Scoreboard:  _updateScoreboard
 *   Map:         _setMapBuildings
 *   Networking:  _setLocalPlayerNetCorrection
 *   State read:  _getPlayerStatePtr/Count/Stride, _getLocalPlayerIdx
 *                _getProjectileStatePtr/Count/Stride
 *                _getParticleStatePtr/Count/Stride
 *                _getFlagStatePtr/Count/Stride
 *                _getBuildingPtr/Count/Stride
 *   Heightmap:   _getHeightmapPtr/Count/Size/WorldScale
 *   Camera:      _getCameraFov, _getThirdPerson
 *   Match:       _getMatchState, _isReady
 *   Interior:    _appendInteriorShapeAABBs, _appendInteriorMeshTris
 *   Aim:         _setLocalAimPoint3P
 *   Player info: _getPlayerSkiing, _getPlayerSpeed, _getPlayerSlopeDeg
 *   Render:      _setRenderMode
 *   Tick:        _tick, _main
 *   Memory:      _malloc, _free
 *
 * MEMORY MODEL:
 *   HEAP8, HEAP16, HEAP32, HEAPU8, HEAPU16, HEAPU32, HEAPF32, HEAPF64
 *   All views share wasmMemory.buffer. Fixed size. Never detach under current build.
 *
 * DO NOT:
 * - Edit this file. Changes are overwritten on rebuild.
 * - Enable -sALLOW_MEMORY_GROWTH without updating index.html.
 * - Add window.* callback references without defining them in index.html first.
 * - Assume struct field offsets — verify against C++ source.
 */
```

---

## Pass 6 — Design Intent

### What This File Is Supposed to Do

`tribes.js` is the invisible plumbing between the game's C++ simulation and its JavaScript presentation layer. It should be boring. It should be predictable. It should never be the source of a bug — because it's generated.

### What It Actually Does Well

1. **Zero-copy data sharing.** The ptr/count/stride pattern gives JS direct read access to C++ memory without serialization. This is the fastest possible path for getting thousands of entity positions into the renderer every frame.

2. **Clean export surface.** The WASM exports are well-organized by domain: settings, state reads, map, camera, tick. The naming is mostly clear (with exceptions noted in Pass 1).

3. **Fixed memory model.** For a game with predictable memory usage, fixed heap eliminates an entire class of bugs (view detachment, fragmentation under growth). It's the right choice if the heap is sized correctly.

### What It Gets Wrong

1. **No defensive callbacks.** The `ASM_CONSTS` assume their `window.*` targets exist. One missing definition crashes the runtime.

2. **No memory visibility.** No export for heap usage monitoring. You can't know you're approaching OOM until you hit it.

3. **No layout versioning.** The struct layouts read via HEAPF32 are a binary contract with zero validation. A C++ field reorder creates silent JS bugs.

4. **No ready handshake.** C++ and JS assume mutual readiness. There's no protocol for "I'm ready, are you?"

### Architectural Recommendations

| # | Recommendation | Priority | Effort | Owner |
|---|----------------|----------|--------|-------|
| 1 | Add `HEAPF32.buffer === wasmMemory.buffer` assertion in JS game loop | P1 | 5 min | index.html |
| 2 | Add `_getHeapUsed()` / `_getHeapTotal()` exports to C++ build | P1 | 30 min | C++ |
| 3 | Add defensive null checks to `ASM_CONST` callbacks in C++ `EM_ASM` macros | P1 | 1 hr | C++ |
| 4 | Add `@ai-contract` header comment to generated output (Emscripten `--pre-js`) | P2 | 15 min | Build |
| 5 | Implement ready-flag handshake (`window._wasmBridgeReady`) | P2 | 1 hr | C++ + index.html |
| 6 | Migrate `updateHUD(14 params)` to struct-pointer pattern | P2 | 2 hr | C++ + index.html |
| 7 | Add layout descriptor headers to state arrays (version + field table) | P3 | 4 hr | C++ + index.html |
| 8 | Add `_getTeamCount()` / `_getTeamInfo(idx)` exports for 4-tribe support | P2 | 1 hr | C++ |
| 9 | Rename output to `tribes.emscripten.js` or add generated-file header | P3 | 5 min | Build |
| 10 | Schedule full Phase 2a review of `index.html` game bridge (~4,500 LOC) | P0 | — | Audit plan |

---

## Deliverable Summary

### Findings

| ID | Finding | Severity | Status |
|----|---------|----------|--------|
| T-001 | Audit plan mischaracterizes tribes.js as game logic | Documentation | **Confirmed** — plan must be updated |
| T-002 | Phase 1 HEAPF32 detachment finding is impossible under current build | Reclassify | **P0→P2 latent** — add assertion + documentation |
| T-003 | OOM causes hard abort with no monitoring or warning | P2 | **New** — add heap usage exports |
| T-004 | ASM_CONST callbacks have no null guards | P1 | **New** — boot race can crash runtime |
| T-005 | updateHUD passes 14 positional params across boundary | P3 | **New** — refactor to struct-pointer |
| T-006 | Struct layouts have no versioning or validation | P2 | **New** — silent corruption on mismatch |
| T-007 | No ready handshake between WASM and JS | P2 | **New** — undefined init ordering |
| T-008 | Missing team-count/info exports for 4-tribe support | P2 | **New** — implicit 2-team assumption |
| T-009 | Export naming inconsistencies (_append* vs _set* vs _get*) | P3 | **New** — documentation issue |
| T-010 | index.html (~4,500 LOC) needs its own Phase 2a review | P0 | **Action required** — not covered by current audit plan |

### Expert Sign-Off

- **Carmack:** "The memory model is correct for the current build. The risk is future-you changing a flag and not knowing the consequences. Barrett's assertion and Acton's documentation close that gap. The real audit target is index.html."
- **Abrash:** "The zero-copy ptr/stride pattern is the right architecture. The boundary crossing overhead for ASM_CONSTS is acceptable at current callback frequency. Monitor if callback count grows with 4-tribe support."
- **Muratori:** "This file shouldn't have been in the audit plan as a game logic file. It's compiler output. The review was useful because it forced us to define the WASM↔JS contract precisely — something that was entirely implicit before. That contract documentation is the real deliverable here."
- **Acton:** "The data layout is clean from a DOD perspective. The struct-pointer access pattern is correct. What's missing is validation — layout versioning and the buffer-identity assertion. Both are cheap and eliminate the two worst failure modes (silent corruption and stale views)."
- **Barrett:** "The API surface is 90% there. Add `_getTeamCount`, `_getHeapUsed`, `_getHeapTotal`, and you've got a complete interface for 4-tribe support with memory monitoring. The naming inconsistencies are cosmetic — document them, don't refactor generated code."

### Next Steps

1. **Immediate:** Update audit plan to reflect that game bridge logic lives in `index.html`, not `tribes.js`.
2. **Immediate:** Schedule Phase 2a review of `index.html` as a new audit target.
3. **Sprint:** Implement recommendations #1–3 (assertion, heap exports, null guards).
4. **Backlog:** Recommendations #5–8 (ready handshake, struct-pointer migration, layout descriptors, team exports).
