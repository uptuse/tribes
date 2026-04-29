# Adversarial Convergence Review — Firewolf Audit Plan

## The Process

### What It Is
A multi-pass code review that escalates from bug-hunting to architecture to system-level coherence to design intent. Each pass uses the output of the previous pass as input. The experts in Pass 3 aren't reviewing the original code — they're reviewing the code as improved by Pass 2, which itself was hardened by Pass 1. Convergent, not circular.

### The Six Passes

**Pass 1 — Break It** (Saboteur / Wiring Inspector / Cartographer)
Find bugs. Race conditions, null derefs, API mismatches, data model gaps.
Goal: *does this code survive contact with reality?*
Fix everything before proceeding.

**Pass 2 — Challenge the Architecture** (5-7 domain experts, independent)
Each expert reviews alone with a different lens. They find structural problems: wrong abstraction, wrong data representation, scaling walls.
Fix consensus items.

**Pass 3 — Debate to Consensus** (The Room)
Same experts, now in dialogue. They challenge each other, discover interaction bugs between proposed fixes, and converge on specific actionable changes with rationale.
Final fixes.

**Pass 4 — System-Level Review** (Forest + Trees)
The experts zoom out from the module and ask:
- How does this module connect to everything else?
- What assumptions does it make about other modules' behavior?
- What does it expose via `window.*`, globals, or shared state?
- Are there patterns in THIS module that contradict patterns in OTHER modules?
- Is there duplicated logic that already exists elsewhere?
- If I change this module, what breaks?
- **Should this module exist at all?** (Ive's razor: if you can't articulate what sensation this module creates for the player, it's noise.)

This pass produces:
- A **dependency map** (what this module reads/writes/calls externally)
- An **interface contract** (what this module promises to the rest of the system)
- **Contradiction flags** (where this module's approach conflicts with established patterns)
- A **keep/extract/absorb/kill recommendation** for the module

**Pass 5 — AI Rules Extraction**
After all fixes, the experts produce rules for how the AI interacts with this code going forward. Rules are written as **in-source `@ai-contract` comment blocks** at the top of each file — not in a separate doc that gets forgotten:

```
// @ai-contract
// BEFORE_MODIFY: read docs/lessons-learned.md, check cache bust in renderer.js
// NEVER: add particle systems to this file (extract to renderer_*.js)
// ALWAYS: bump ?v= param on import lines when editing imported modules
// DEPENDS_ON: renderer_rapier.js (window.RapierPhysics), renderer_sky_custom.js
// EXPOSES: window.DayNight, window.__tribesPolish, window._sampleTerrainH
// COORDINATE_SPACE: world (meters), Y-up
// @end-ai-contract
```

`docs/ai-rules.md` becomes an index pointing to these in-source contracts, not the source of truth.

**Pass 6 — Design Intent** (Ive's Pass)
For each module, answer: *What is this in service of?* The original Tribes had a sensation — momentum, scale, the feeling of skiing across vast terrain with a disc launcher. Every system must serve that feeling or it's noise. This pass:
- Maps each module to a core player sensation (speed, impact, scale, tension, mastery)
- Flags systems that exist because "it would be cool" rather than serving the experience
- Evaluates whether the module's visual/audio/feel output is *coherent* with the rest
- Asks: can a fresh person look at the file list and understand the architecture in 30 seconds?
- Flags naming problems (does the name reflect the responsibility?)

---

## AI Anti-Patterns to Address

Based on the project history, these are patterns where the AI has repeatedly created problems:

1. **Solving already-solved problems differently.** Ski particles were built from scratch when jet exhaust already worked. The rule "clone what works" exists in lessons-learned but gets forgotten across sessions.

2. **Cache bust staleness.** Editing a module and forgetting to update the `?v=XXX` import in renderer.js. Invisible changes, wasted debugging.

3. **Coordinate space confusion.** Mixing model-local, armature-local, and world-space coordinates. The 30m ski board incident.

4. **Window.* spaghetti.** Modules communicate through ~40 `window.*` globals. No documentation of which modules read/write which globals. Changing one breaks another silently.

5. **Monolith accretion.** renderer.js is 6,094 lines because new features get bolted on instead of extracted. Each new system (jet exhaust, ski particles, explosions, fairies, grass, dust) adds another init/update pair to the monolith.

6. **Forgetting lessons-learned.** Each session starts fresh. The lessons-learned.md exists but the AI doesn't always read it before working. Hard-won rules get violated again.

---

## The Modules (28 files, ~35K lines JS)

### Tier 1 — The Spine (highest risk, most dependencies)

| Module | Lines | Role | Key Concerns |
|---|---|---|---|
| `renderer.js` | 6,094 | Main renderer, scene setup, game loop, ALL particle systems, terrain, buildings, interior shapes, lighting, post-processing | Monolith. 80+ functions. ~30 window.* writes. Contains at least 6 systems that should be separate modules. |
| `tribes.js` | 6,868 | WASM bridge, game state machine, HUD, settings, input, audio hookup | Entry point. Controls everything. WASM HEAPF32 views. |
| `renderer_rapier.js` | 456 | Rapier physics facade, terrain collider, building colliders, player capsule | Gateway to physics. `renderer_buildings.js` depends on its API. `window.RapierPhysics` facade. |

### Tier 2 — Active Development (changing frequently, high integration)

| Module | Lines | Role |
|---|---|---|
| `renderer_characters.js` | 294 | GLB model loading, LOD, animation, grounding |
| `renderer_polish.js` | 1,146 | Post-processing effects stack |
| `client/network.js` + `wire.js` + `prediction.js` | 725 | Multiplayer networking |

### Tier 3 — Feature Modules (self-contained, lower risk)

| Module | Lines | Role |
|---|---|---|
| `renderer_combat_fx.js` | 301 | Hit feedback, kill feed |
| `renderer_minimap.js` | 348 | Radar HUD |
| `renderer_sky_custom.js` | 396 | Procedural sky dome, day/night |
| `renderer_command_map.js` | 601 | Command map overlay |

### Tier 4 — Small / Stable

| Module | Lines | Role |
|---|---|---|
| `renderer_toonify.js` | 210 | Toon shader toggle |
| `renderer_zoom.js` | 206 | Zoom/scope FX |
| `renderer_cohesion.js` | 138 | Visual cohesion system |
| `renderer_palette.js` | 92 | Color palette |
| `renderer_debug_panel.js` | 216 | Debug stats overlay |
| `renderer_buildings.js` | 362 | **DONE** — modular building system (audit complete) |
| `client/audio.js` | 95 | Sound system |
| `client/constants.js` | 115 | Shared constants |
| `client/mapeditor.js` | 393 | Map editor |
| `client/replay.js` | 376 | Replay system |
| `client/moderation.js` | 120 | Chat moderation |
| `client/tiers.js` | 46 | Quality tier defs |
| `client/quant.js` | 40 | Quantization helpers |
| `client/voice.js` | 314 | Voice chat |

---

## Dual Module System (to be resolved)

The codebase uses two incompatible module patterns:

**ES Modules** (import/export): `renderer_buildings.js`, `renderer_characters.js`, `renderer_polish.js`, `renderer_sky_custom.js`
**IIFE + window.\*** : `renderer_cohesion.js`, `renderer_minimap.js`, `renderer_combat_fx.js`, `renderer_toonify.js`, `renderer_palette.js`, `renderer_command_map.js`, `renderer_debug_panel.js`, `renderer_zoom.js`

**Decision: ES modules are canonical going forward.**
The audit will mark each IIFE module as legacy and note the migration path. Migration is deferred to the Refinement phase — the audit documents, it doesn't rewrite module boundaries mid-review.

---

## window.* Global Taxonomy

All `window.*` globals must be categorized during the audit:

| Category | Example | Migration Path |
|---|---|---|
| **API Facade** | `window.RapierPhysics`, `window.CombatFX`, `window.Minimap` | Convert to ES module import when module migrates |
| **Shared Data** | `window._sampleTerrainH`, `window.__generatorPositions`, `window._tribesAimPoint3P` | Convert to exported function/object from owning module |
| **Debug-only** | `window.scene`, `window._tribesDebug`, `window.__tribesApplyQuality` | Keep (debug-only, harmless), but document |
| **WASM Bridge** | `window.Module`, `window.ST` | Keep (set by HTML host page, can't be ES-imported) |

Target: reduce non-debug, non-WASM globals by 50%+ during Refinement phase.

---

## Pattern Registry

`docs/patterns.md` must include **line-number references to canonical implementations**, not prose descriptions.

Format:
```
## PATTERN: particle-pool
CANONICAL: renderer.js:initJetExhaust() (line 4457)
STRUCTURE: fixed pool, ShaderMaterial, additive blend, single draw call
CLONE_FROM: this function when adding new particle types
VARIATIONS: ski (line 4520), trails (line 4644), explosions (line 4833)
```

The AI rule is: before writing any new system, `grep PATTERN docs/patterns.md` to find the canonical implementation and clone it. Zero ambiguity.

---

## Execution Plan

### Phase 1: System Map + renderer.js (merged)

Phase 0 and the renderer.js review are the same work. renderer.js IS the system — reading it produces the dependency graph, the globals inventory, and the pattern catalog as deliverables. This phase also answers "what should be extracted?" as its primary output.

**Deliverables:**
- `docs/system-map.md` (dependency graph, globals inventory)
- `docs/patterns.md` (canonical implementations with line refs)
- Extraction plan for renderer.js (what stays, what becomes its own module, what dies)
- In-source `@ai-contract` for renderer.js
- Bug fixes, architecture fixes

### Phase 2: T1 Remaining (tribes.js → renderer_rapier.js)

**tribes.js** — WASM bridge, game state, HUD. Reviewed against the system map.
**renderer_rapier.js** — Physics facade. Reviewed against renderer_buildings.js contracts (the gold standard module).

### Phase 3: T2 Modules

Reviewed against contracts from Phase 1-2. Focus on:
- Following established patterns
- Not duplicating logic that exists elsewhere
- Clean interfaces

### Phase 4: T3 + T4 Modules

Full system-level pass even for small modules (small modules hide coupling problems). The "should this exist?" question is sharpest here. Break-It pass can be lighter for <200 line modules, but system-level and design-intent passes run in full.

### Phase 5: Integration Audit

After all modules reviewed individually:
- Trace a frame end-to-end through the full game
- Verify no orphaned `window.*` globals
- Verify lessons-learned.md is complete
- Verify ai-rules.md index is complete
- Verify pattern registry covers all recurring patterns

### Phase 6: Refinement (Design Pass)

The Ive phase. Step back from the code and ask the design questions:
- Is the module decomposition right?
- Do the names reflect responsibilities? (`renderer_polish.js` = 1,146 lines of "polish" — what does that even mean?)
- Is there conceptual clarity? (Can a fresh AI session understand the architecture in 30 seconds from the file list alone?)
- Plan the extractions from renderer.js (but execute as a separate project, not mid-audit)
- Plan IIFE → ES module migrations
- Plan `window.*` global reductions

---

## Expert Panel

| Module Domain | The Room |
|---|---|
| **Renderer core** (`renderer.js`) | Carmack, ryg, Abrash, Muratori, Acton, Sweeney, Ive |
| **Physics** (`renderer_rapier.js`) | Carmack, Erin Catto, Abrash, Muratori |
| **Game bridge** (`tribes.js`) | Carmack, Abrash, Muratori, Acton, Barrett |
| **Characters** (`renderer_characters.js`) | ryg, Carmack, Muratori, Ive |
| **Networking** (`client/network.js` etc.) | Glenn Fiedler, Carmack, Muratori, Acton |
| **Effects/Polish** (`renderer_polish.js` etc.) | ryg, Abrash, Carmack, Ive |
| **UI/HUD** (minimap, command map, debug) | Barrett, Muratori, ryg, Ive |
| **Design/Refinement** (Phase 6) | Ive (lead), Carmack, Muratori, ryg |

---

## Time Estimate

| Phase | Work | Est. |
|---|---|---|
| Phase 1: System Map + renderer.js | Full 6-pass pipeline + system map deliverables | 2.5 hrs |
| Phase 2: T1 remaining (tribes.js, renderer_rapier.js) | Full pipeline | 2 hrs |
| Phase 3: T2 (characters, polish, networking) | Full pipeline | 1.5 hrs |
| Phase 4: T3+T4 (12 modules) | System-level + design-intent focused | 1.5 hrs |
| Phase 5: Integration audit | End-to-end frame trace, globals check | 0.5 hr |
| Phase 6: Refinement | Design pass, extraction planning, naming review | 1 hr |
| **Total** | | **~9 hrs** |

---

## Deliverables

| Artifact | Location | Purpose |
|---|---|---|
| System dependency graph | `docs/system-map.md` | Who calls whom, shared state, global taxonomy |
| Pattern registry | `docs/patterns.md` | Canonical implementations with line refs |
| Per-module audit log | `docs/audit-log.md` | Every finding, fix, deferral |
| AI rules index | `docs/ai-rules.md` | Index pointing to in-source `@ai-contract` blocks |
| In-source contracts | Each `.js` file header | `@ai-contract` blocks with rules, deps, exposures |
| Test harnesses | `test/*.html` | Isolated tests for T1 and T2 modules |
| Updated lessons-learned | `docs/lessons-learned.md` | New entries from audit findings |
| Extraction plan | `docs/refactoring-plan.md` | What to extract from renderer.js, migration roadmap |
| Design intent map | `docs/design-intent.md` | Each module → core player sensation it serves |

---

## Success Criteria

When the audit is complete:
- [ ] Every module has an in-source `@ai-contract` block
- [ ] Every `window.*` global is categorized (API/data/debug/WASM)
- [ ] `docs/patterns.md` has canonical implementations with line refs
- [ ] Every module has a documented interface contract
- [ ] Every module has a keep/extract/absorb/kill recommendation
- [ ] Every module maps to a core player sensation (or is flagged as noise)
- [ ] T1 and T2 modules have isolated test harnesses
- [ ] `lessons-learned.md` is up to date
- [ ] The game still works (no regressions)
- [ ] Module naming accurately reflects responsibility (or is flagged for rename)
- [ ] A fresh AI session can understand the architecture in 30 seconds from docs alone
