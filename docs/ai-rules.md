# AI Rules Index — Firewolf

> Quick-start for any AI session working on the Firewolf codebase.
> Phase 6 deliverable from the Adversarial Convergence Review (Run 1).

---

## Before You Touch Anything

1. **Read `docs/lessons-learned.md`** — Hard-won fixes. The answer to your bug may already be there.
2. **Read `docs/patterns.md`** — Find the canonical pattern for what you're building. Clone it.
3. **Read the `@ai-contract` block** at the top of the file you're editing (or in the audit log if not yet added to source).
4. **Run the pre-commit checklist** (defined in `AGENTS.md`):

```
[ ] Cache bust updated in renderer.js import? (if imported module changed)
[ ] Coordinate space correct? (world meters, Y-up)
[ ] No new window.* globals? (or documented in docs/system-map.md)
[ ] Performance budget met? (measured, not guessed)
[ ] Quality tier fallback works?
[ ] @ai-contract block present and accurate?
[ ] lessons-learned.md consulted?
[ ] Version chip bumped in index.html?
```

---

## Global Rules (apply to EVERY file)

| Rule | Why |
|---|---|
| Clone what works (`docs/patterns.md`) | The ski particle incident: rebuilt from scratch when jet exhaust already worked. Never again. |
| Never add `window.*` globals without documenting in `docs/system-map.md` | 80+ globals already. Every new one makes the codebase harder to reason about. |
| Never use magic numbers for playerView offsets — use `player_state.js` constants | `playerView[i * stride + 11]` is unreadable. `playerView[i * stride + TEAM]` is obvious. |
| Always bump `?v=` cache bust when editing imported modules | Browser caches ES modules aggressively. Stale cache = mystery bugs. |
| Always wrap optional visual subsystem inits in `try/catch` | One failed subsystem must not black-screen the entire game. |
| ES modules are canonical — never create new IIFE modules | IIFEs are legacy. All new code uses `import`/`export`. |
| 4 tribes, not 2 — always check for team count hardcoding | The audit found 2-team hardcoding in 11+ files. Use `team_config.js` for tribe count and colors. |
| Coordinate space: world meters, Y-up | MIS model conversion: y→z, z→-y. WASM and Three.js agree on Y-up. |
| Performance budget: 16.6ms per frame (60fps target) | Measure with DevTools Performance tab. Don't guess. |
| Never allocate in the hot loop | No `new Vector3()`, no object literals, no array creation inside `loop()` or `sync()` calls. Pool everything. |
| Every module needs `dispose()` | GPU resources leak if not explicitly cleaned up. Phase transitions must be able to tear down and rebuild. |

---

## @ai-contract Locations

### Core Files

| File | Contract Location | Key Rules |
|---|---|---|
| **`renderer.js`** | `audit-log/run-1/phase-1-renderer.md` §Pass 5 | ALWAYS: `refreshViews()` at top of loop (HEAPF32 detach guard). NEVER: new particle systems in this file. ALWAYS: try/catch on subsystem inits. ALWAYS: `DynamicDrawUsage` on per-frame attributes. ALWAYS: `frustumCulled = false` on underground/origin meshes. Test with `?nopost` and `?daynight=off`. |
| **`tribes.js`** | `audit-log/run-1/phase-2a-tribes.md` §Recommended @ai-contract | GENERATED FILE — DO NOT EDIT. Memory growth DISABLED (OOM = abort). ASM_CONST callbacks require window.* globals defined before `_tick()`. Struct layouts in HEAPF32 must match C++ field order. No runtime validation. |
| **`renderer_rapier.js`** | `audit-log/run-1/phase-2b-rapier.md` §Pass 5 | WASM owns movement. Rapier provides collision queries ONLY. No dynamic bodies. No gravity. Capsule height = 2×halfH + 2×radius. Every `createCollider()` must store handle. Every destroy must `removeCollider()`. Budget: `stepPlayerCollision` < 0.5ms. No allocations in hot path. |
| **`renderer_characters.js`** | `audit-log/run-1/phase-3a-characters.md` §Pass 5 | Owns: GLTF loading, skeleton cloning, animation mixers, positioning. Does NOT own: camera mode, ground height, player physics, primitive meshes, particles (lesson #4). Reads: `window._rapierGrounded`, `window._sampleTerrainH`, `Module._getThirdPerson`. Writes: nothing. |
| **`renderer_polish.js`** | `audit-log/run-1/phase-3b-polish.md` §Pass 5 | **STATUS: DEPRECATED** — scheduled for decomposition. Do NOT add new effects. Route to: weather→`renderer_weather.js`, combat→`renderer_combat_fx.js`, buildings→`renderer_buildings.js`, HUD→`renderer_hud.js`. Tick budget: < 0.3ms total. Shockwaves: pool max 8. Decals: max 256 (high) / 128 (mid). Audio: route through `window.playSoundUI` / `window.playSoundAt` only. |

### Networking Files

| File | Contract Location | Key Rules |
|---|---|---|
| **`client/network.js`** | `audit-log/run-1/phase-3c-networking.md` §@ai-contract for network.js | NEVER: add non-networking concerns. NEVER: `setInterval` without storing ID. ALWAYS: clear intervals in `onclose`. ALWAYS: `socket=null` guard before `.send()`. Known issues: ping interval leaks on reconnect, prediction disconnected, voice globals should be in voice.js. |
| **`client/wire.js`** | `audit-log/run-1/phase-3c-networking.md` §@ai-contract for wire.js | ALWAYS: update BOTH `client/wire.js` AND `server/wire.ts` — they must match exactly. NEVER: change struct sizes without updating `quant.js SIZE_*`. NEVER: big-endian (all LE). ALWAYS: return null on malformed input. Known issues: `decodeDelta` mutates input byte 0, flag Z hardcoded to 0, no format version, no sequence number. |
| **`client/prediction.js`** | `audit-log/run-1/phase-3c-networking.md` §@ai-contract for prediction.js | NEVER: reset `nextClientTick` to 0 during active match. Must wire `reconcile()` to snapshot handler and `applyPendingCorrection()` to render loop (currently DISCONNECTED). Known issues: reconcile never called, input replay not implemented, smooth correction doesn't chain. |

### Small Modules

| File | Contract Location | Key Rules |
|---|---|---|
| **`renderer_combat_fx.js`** | `audit-log/run-1/phase-4-small-modules.md` §Module 1, Pass 5 | Serves: Scale + Aliveness. Budget: max 5 draw calls/frame. NEVER: allocate Vector3 per `fire()` — pool them. ALWAYS: add `dispose()` for GPU resources. Future: per-weapon flash variants, 4-tribe tracer colors. |
| **`renderer_minimap.js`** | `audit-log/run-1/phase-4-small-modules.md` §Module 2, Pass 5 | Serves: Belonging + Scale. Budget: 1 Canvas 2D drawImage + ~100 arc/fillRect. NEVER: hardcode team count. ALWAYS: validate `localIdx` bounds. Known: offset 17 ("carrying flag") not in documented stride layout — verify. |
| **`renderer_sky_custom.js`** | `audit-log/run-1/phase-4-small-modules.md` §Module 3, Pass 5 | **MODEL MODULE** — cleanest in codebase. ES module, no globals. Budget: 3 draw calls. NEVER: let `uTime` grow unbounded (UV precision loss after ~7 hours). ALWAYS: frame-rate-independent lerps (use `dt`). Sky domes centered on `cameraPos` each frame. |
| **`renderer_command_map.js`** | `audit-log/run-1/phase-4-small-modules.md` §Module 4, Pass 5 | Serves: Scale + Belonging. NEVER: run self-driven RAF loop — call from main loop. NEVER: hardcode map names or team counts. ALWAYS: cache terrain hillshade on map load, not resize. Budget: ~200 draw calls when open, 0 when closed. |
| **`client/mapeditor.js`** | `audit-log/run-1/phase-4-small-modules.md` §Module 11, Pass 5 | Creator tool (not gameplay). Self-contained. NEVER: hardcode terrain size or world scale. ALWAYS: support all 4 tribes for flags/spawns. Legacy `window.__editor` alias should be removed. |

### Modules Without Explicit Contracts (need contracts added)

| File | Lines | Status | Priority |
|---|---|---|---|
| `renderer_buildings.js` | 462 | No contract yet — absorbing code from polish.js | Add during Phase C |
| `renderer_toonify.js` | 210 | No contract yet — straightforward material pass | Add during Phase D migration |
| `renderer_zoom.js` | 206 | No contract yet — self-RAF must be removed | Add during Phase D migration |
| `renderer_palette.js` | 92 | No contract yet — pure data, simplest module | Add during Phase D migration |
| `renderer_debug_panel.js` | 216 | No contract yet — dev tool | Add during Phase D migration |
| `renderer_cohesion.js` | 138 | **SCHEDULED FOR DELETION** — mood bed → audio.js | No contract needed |
| `client/audio.js` | 95 | No contract yet — minimal, will absorb mood bed | Add when expanding audio |
| `client/replay.js` | 376 | No contract yet — 2-team hardcoding throughout | Add during Phase A team fixes |
| `client/moderation.js` | 120 | No contract yet — small, self-contained | Low priority |
| `client/tiers.js` | 46 | No contract yet — tiny skill tier module | Low priority |
| `client/voice.js` | 314 | No contract yet — voice globals should move here from network.js | Add when extracting voice globals |
| `client/constants.js` | 115 | No contract yet — shared constants | Add during Phase A |
| `client/quant.js` | 40 | No contract yet — quantization math | Low priority |

---

## Key Reference Documents

| Document | What It Contains | When To Read |
|---|---|---|
| `docs/lessons-learned.md` | Hard-won bug fixes with root cause and forward rules | **FIRST — before debugging anything** |
| `docs/patterns.md` | Canonical implementations with line references | Before building anything new |
| `docs/system-map.md` | Module dependency graph, window.* global inventory | When understanding how modules connect |
| `docs/game-design.md` | North star: Core Feelings, visual identity, what the game IS | When making design decisions |
| `docs/feature-gates.md` | 8-gate process for adding features | Before writing any new feature code |
| `docs/review-cohort.md` | Expert panel roles and review process | When running adversarial reviews |
| `docs/refactoring-plan.md` | The extraction roadmap (Phase A-E) | When doing any refactoring work |
| `docs/design-intent.md` | Module → Core Feeling map | When questioning whether a module should exist |
| `docs/audit-log/run-1/` | Full audit logs with all 6-pass reviews | When you need the detailed reasoning behind a rule |

---

## Quick Decision Trees

### "Should I add this to renderer.js?"
**No.** renderer.js is being decomposed. Find the correct extracted module or create a new one. If it's a new visual subsystem, it gets its own file with its own `@ai-contract`.

### "Should I add a window.* global?"
**Almost certainly no.** Use ES module exports. If you absolutely must (WASM interop), document it in `docs/system-map.md` and the file's `@ai-contract` EXPOSES section.

### "Which particle system do I use?"
**The unified one** (`renderer_particles.js` when extracted). Add a new type config. Never build a new particle system from scratch.

### "How do I handle team colors?"
**Import from `client/team_config.js`.** Never hardcode `['#3FA8FF', '#FF6A4A']` or `for (i < 2)`. Always iterate `TRIBE_COUNT`, never a literal.

### "How do I read player state?"
**Import offsets from `client/player_state.js`.** Never write `playerView[i * stride + 11]` — write `playerView[i * stride + TEAM]`.

### "How do I convert MIS coordinates to Three.js?"
**y→z, z→-y.** MIS uses Z-up, Three.js uses Y-up. This is documented in every relevant `@ai-contract`. Get it wrong and buildings spawn sideways.

### "Can I enable -sALLOW_MEMORY_GROWTH?"
**Not without a major refactor.** The current build uses fixed WASM memory. All HEAPF32/HEAP32 typed array views are created once and never refreshed. If memory growth is enabled, every `new Float32Array(Module.HEAPF32.buffer, ptr, len)` in the codebase will silently detach when memory grows, returning all zeros. The render loop has a `HEAPF32.buffer !== wasmMemory.buffer` assertion to catch this, but fixing it requires recreating all views after every growth event. See `@ai-invariant FIXED_WASM_MEMORY` in renderer.js.
