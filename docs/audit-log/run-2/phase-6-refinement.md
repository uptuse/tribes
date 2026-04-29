# Phase 6 — Refinement / Design Pass (Run 2: Definitive)

**Scope:** Full codebase design coherence review — DEFINITIVE version superseding Run 1 Phase 6
**Date:** 2026-04-30
**Panel:** Ive (lead), Carmack, Muratori, ryg
**Run 2 mandate:** Validate every Run 1 Phase 6 recommendation against actual source code. Incorporate all Run 2 corrections from Phases 1–5. Produce the final, authoritative design assessment.
**Prior art:** `run-1/phase-6-refinement.md` (13 recommendations), Run 2 Phases 1–5 (4,087 lines of corrected analysis)

---

## Preamble: What Changed Between Run 1 Phase 6 and Now

Run 1 Phase 6 produced 13 numbered recommendations based on a design review of the full codebase. Run 2 Phases 1–5 subsequently validated every technical finding with line-number precision. This document is the **DEFINITIVE** design pass — it supersedes Run 1 Phase 6 on all counts.

### Key Run 2 Corrections That Affect Phase 6

| Correction | Source | Impact on Phase 6 |
|---|---|---|
| Particle unification is 4 systems, not 6 | Phase 1 | Recommendation #4 overstated scope. Explosions and fairies are architecturally distinct. |
| `renderer_polish.js` decomposition is 5 stages, not 2 files | Phase 3b | Recommendation #5 was too coarse. 5-stage decomposition with weather extraction as critical path. |
| Only ONE rename needed across small modules | Phase 4 | Recommendation #6 was partially wrong. Most names are accurate. |
| Team color 0=blue vs 0=red is a LATENT BUG | Phase 4 | NEW finding not in Run 1 Phase 6. Higher priority than rename work. |
| Palette hex values match NO consumer | Phase 4 | Recommendation #7 global audit gains a new facet: color authority is distributed, not centralized. |
| `renderer_zoom.js` RAF is unconditional worst offender | Phase 4 | Related to Recommendation #3 (disabled systems executing). Zoom isn't disabled — it's always running. |
| prediction.js IS live, NOT dead code | Phase 3c | Run 1 Phase 5 claimed it was dead. Affects overall "dead code" narrative. |
| `@ai-contract` blocks: zero exist | All phases | Recommendation from audit plan. Not yet implemented. |

### Current Codebase Metrics (Verified)

| Metric | Value |
|---|---|
| Total JS files (hand-written) | 26 |
| Total lines (hand-written, excl. tribes.js) | 13,084 |
| Total lines (incl. tribes.js) | 19,952 |
| `renderer.js` | 6,094 lines (46.6% of hand-written code) |
| `renderer_polish.js` | 1,146 lines |
| `tribes.js` (Emscripten glue) | 6,868 lines |
| `renderer_cohesion.js` (dead code) | 138 lines |
| Unique `window.*` identifiers | 85 (75 application-level, 10 browser API) |
| IIFE modules | 8 (`cohesion`, `minimap`, `combat_fx`, `toonify`, `command_map`, `palette`, `debug_panel`, `zoom`) |
| ES modules | 4 (`polish`, `buildings`, `characters`, `sky_custom`) |
| `@ai-contract` blocks in source | **0** |

---

## 1. The 30-Second Architecture Test — Run 2 Reassessment

**Ive:** We ran this test in Run 1. Let me restate the result and check whether Run 2's findings change anything. The question: can a fresh AI session understand the architecture from the file list alone?

**Carmack:** After 4,087 lines of Run 2 analysis, my answer is the same: *mostly*. The file names communicate purpose — `renderer_combat_fx.js` is combat effects, `renderer_minimap.js` is the minimap. Run 2 Phase 4 actually pushed back on Run 1's rename recommendations. The panel concluded that only `renderer_sky_custom.js` → `renderer_sky.js` is needed. The other names — including `renderer_command_map.js`, `renderer_toonify.js`, `client/tiers.js`, `client/quant.js` — are all accurate enough. Run 1 was over-aggressive on renaming.

**Muratori:** The one name that still fails completely is `tribes.js`. 6,868 lines of Emscripten glue code named after the project. If a fresh session opens the repo and sees `tribes.js` as the largest file, they will waste twenty minutes reading it. That hasn't changed.

**ryg:** And `renderer_cohesion.js` still exists. 138 lines of dead code. It's still loaded via `<script>` tag. It still exposes `window.Cohesion`. Run 2 Phase 4 confirmed unanimous KILL verdict. But it's still alive.

**Ive:** So the 30-second test results haven't changed because the codebase hasn't changed. All Run 1 and Run 2 recommendations are still *recommendations*. No structural work has been executed. Let's assess each Run 1 recommendation against our definitive findings.

---

## 2. Run 1 Recommendation Validation

### Recommendation #1: Kill `renderer_cohesion.js`

**Run 1 said:** Delete the file, remove all references. 138 lines of confirmed dead code. Zero risk, zero debate.

**Run 2 verification:**

File still exists at 138 lines. Confirmed IIFE pattern:
```javascript
// renderer_cohesion.js — R32.25
// Visual Cohesion polish bundle:
//   #2.9  Ambient mood-bed audio loop (procedural low drone)
//   #2.10 Sub-perceptual camera breathing (organic micro-jitter)
(function () { 'use strict'; ...
```

Exposes `window.Cohesion` with `.init(THREE, camera)` and `.tick(t)`. Renderer.js references `window.Cohesion` at 3 locations. Phase 4 confirmed the tick call is commented out or gated. Phase 1 confirmed camera breathing is ~0.0008 rad micro-jitter nobody perceives.

**Carmack:** Still dead. Still unanimous. The `_audioCtx` inside it creates a *second* AudioContext, which Phase 3b flagged as an iOS Safari bug (limits to 1 AudioContext). So it's worse than dead — if someone re-enables it, it'll break mobile audio.

**Muratori:** The concept — "world mood" via ambient audio — isn't wrong. But the implementation is an abandoned experiment that conflicts with the game's speed. Camera breathing during skiing at 200 km/h would cause nausea. The concept should live in `client/audio.js` if anyone revisits it, not as a standalone module.

**Run 2 Verdict: CONFIRMED. Kill immediately. No changes to recommendation.**

---

### Recommendation #2: Rename and relocate `tribes.js`

**Run 1 said:** Move to `generated/emscripten_glue.js`. Add to `.gitattributes` to suppress diffs. Highest-impact naming fix.

**Run 2 verification:**

File still at root as `tribes.js`, 6,868 lines. Phase 2a verified it's 100% Emscripten output — zero hand-written code. No `wasm_glue.js` exists. No `generated/` directory exists.

**Carmack:** Run 2 Phase 2a confirmed every claim. Zero revision markers, zero project-specific strings, zero custom logic. All TODOs reference `TODO(sbc)` — Sam Clegg, Emscripten maintainer. But I want to add a practical caveat: renaming this file requires updating `index.html` `<script>` tags AND any import references. It's a 5-minute change, but if anything references the filename string programmatically, it breaks. Test after renaming.

**ryg:** The `.gitattributes` suggestion is solid. Add `tribes.js linguist-generated=true` (or whatever the renamed file is) so GitHub stats and diffs ignore it. This file represents 34% of the total repo lines — it inflates every metric.

**Muratori:** I'd go further than Run 1. Don't just rename — add a `GENERATED.md` file in the same directory that says "This file is auto-generated by Emscripten. Do not edit. Regenerate from C++ source via [build command]." Future sessions need zero ambiguity.

**Run 2 Verdict: CONFIRMED with additions. Rename, relocate, add .gitattributes suppression AND a GENERATED.md marker.**

---

### Recommendation #3: Stop disabled systems from executing

**Run 1 said:** Rain update, grass allocation, dust initialization — wrap all disabled system code paths so they truly do nothing.

**Run 2 verification:**

Examined all three systems in `renderer.js`:

**Rain** (L3373–3457): `initRain()` creates geometry, allocates `Float32Array(RAIN_COUNT * 6)`, creates `THREE.LineSegments`, and adds to scene. `updateRain(dt, camPos)` has a guard `if (!_rainSystem || !_rainPos) return;` but init still runs unconditionally if called. Checked the render loop — rain update is called conditionally based on a settings flag. However, `initRain()` still allocates geometry and adds the `LineSegments` to the scene graph whether rain is enabled or not.

**Grass ring** (L5504–5755): Run 1 claimed 213MB GPU allocation. Phase 1 corrected this — the grass ring uses amortized recycling (`RECYCLE_PER_FRAME` blades per tick), not a full 2.8M instance buffer. The actual allocation depends on quality tier. On low/medium tiers, init is skipped entirely via quality tier gates. Run 1's "213MB disabled allocation" claim was **overstated**. The grass ring IS gated by quality tier.

**Ground fairy layer** (L5756–6094): This is NOT the "dust layer" Run 1 described as disabled. It's the 64K above-ground particle motes — the primary Aliveness system, actively rendering. NOT disabled.

**NEW from Phase 4:** `renderer_zoom.js` runs its own `requestAnimationFrame` loop unconditionally from page load, even when zoom = 1.0. This is the worst "always running" offender. It processes every frame for a feature that's active <5% of the time.

**Carmack:** Run 1 was partially wrong here. The grass ring IS gated by quality tier — it doesn't burn 213MB on low-end hardware. The rain init does allocate unconditionally, but the runtime cost is one `LineSegments` object with a small buffer. The real performance offender Run 1 missed is `renderer_zoom.js` RAF — that's running every single frame.

**Muratori:** The principle stands: disabled means disabled. But the specific targets need correction. Rain init should be deferred until rain is enabled. Zoom RAF should be conditional. The grass ring is actually handled correctly by quality tiers.

**Run 2 Verdict: PARTIALLY CORRECT. Correct targets are:**
1. **`renderer_zoom.js` RAF** — conditional on zoom ≠ 1.0 (highest priority)
2. **Rain init** — defer allocation until rain is first enabled
3. **Grass ring** — already quality-tier-gated (Run 1 was wrong about 213MB)
4. **`renderer_command_map.js`** — at least self-terminates when closed (better than zoom)

---

### Recommendation #4: Extract a unified particle system

**Run 1 said:** Consolidate six particle implementations into one parameterized system. Net reduction of 400–600 lines.

**Run 2 verification:**

Phase 1 corrected this significantly. The actual particle systems in `renderer.js`:

| System | Lines | Architecture | Unifiable? |
|---|---|---|---|
| Jet exhaust (L4457–4519) | 63 | GPU SoA, ShaderMaterial, additive blend, 384 pool | ✅ Yes — canonical |
| Ski particles (L4520–4643) | 124 | GPU SoA, ShaderMaterial, additive blend, 512 pool | ✅ Yes — clone of jet |
| Projectile trails (L4644–4832) | 189 | GPU SoA, per-particle RGB, 512 pool | ✅ Yes — clone with color |
| Explosions (L4833–5021) | 189 | Radial velocity, gravity, drag, 384 pool | ⚠️ Partially — distinct physics |
| Night fairies (L5022–5183) | 162 | Sinusoidal drift, night-only, rainbow hue, 200 motes | ❌ No — completely different pattern |
| Legacy particles (L3459–4051) | 593 | Old CPU-driven pool, pre-dates GPU pattern | ⚠️ Audit for dead paths |

**Carmack:** Run 2 Phase 1 was right to narrow the scope. Jet, ski, and trails share 80%+ of their init/update code. Explosions share the pool pattern but add radial physics and gravity. Fairies are a completely different animal — sinusoidal drift, night-cycle gating, rainbow hue distribution. Forcing fairies into the same system as jet exhaust would require so many special cases that the "unified" system would be *more* complex than two separate ones.

**ryg:** The correct target is a 3-way merge: jet + ski + trails into one parameterized system. That's ~376 lines consolidated into ~150 lines of shared code + 3 configuration objects. Explosions stay separate. Fairies stay separate. Legacy particles get audited — if they're only used for backward compatibility, sunset them.

**Muratori:** Run 1 estimated 400–600 line reduction. With the corrected 3-way scope (not 6-way), the realistic reduction is 200–250 lines. Still the highest-value code reduction in the codebase, but more modest than claimed.

**Run 2 Verdict: PARTIALLY CORRECT. Unify jet + ski + trails (3 systems, not 6). Explosions and fairies stay independent. Estimated reduction: ~200–250 lines.**

---

### Recommendation #5: Split `renderer_polish.js` into two files

**Run 1 said:** Split into `renderer_environment.js` (weather, atmosphere, lens flare) and `renderer_feedback.js` (combat shake, HUD, decals). Split by update cadence.

**Run 2 verification:**

Phase 3b performed a deep analysis and concluded Run 1's 2-file split was **too coarse**. The module contains 17+ subsystems with cross-cutting dependencies. The Run 2 consensus is a **5-stage decomposition**:

| Stage | Target | Lines | Unblocks |
|---|---|---|---|
| Stage 0 | Fix telemetry offsets, delete dead code | −97 | Correct data |
| Stage 1 | Extract `renderer_weather.js` | ~210 out | **Phase system** |
| Stage 2 | Extract telemetry + compass + settings → `renderer_hud.js` | ~150 out | HUD architecture |
| Stage 3 | Move building enhancements → `renderer_buildings.js` | ~265 out | Building lifecycle |
| Remainder | Rename surviving file → `renderer_combat_fx.js` (~215 lines) | — | Clean single-purpose |

**Ive:** Run 1's instinct was right — split by update cadence. But the execution plan was wrong. "Two files" doesn't work because the 17 subsystems have three distinct update cadences, not two: (a) per-frame scene-level (weather, atmosphere), (b) per-event player-level (combat shake, hit feedback), and (c) per-init static (building railings, station icons). Three destinations minimum, plus the HUD elements that shouldn't be in a "polish" module at all.

**Carmack:** The critical path insight from Phase 3b is that weather extraction unblocks the *phase system* — the #1 unbuilt Core Feeling driver. That's the forcing function for Stage 1. Do weather first, not because it's the easiest, but because it's the dependency bottleneck.

**Run 2 Verdict: CORRECTED. 5-stage decomposition, not 2-file split. Weather extraction is Stage 1 and unblocks the phase system.**

---

### Recommendation #6: Rename ambiguous files

**Run 1 said:** Rename `client/tiers.js` → `client/skill_rating.js`, `client/quant.js` → `client/net_quantize.js`, `renderer_command_map.js` → `renderer_tactical_overlay.js`.

**Run 2 verification:**

Phase 4 conducted a file-by-file naming review across all 12 small modules and reached a **strongly divergent** conclusion:

| File | Run 1 | Run 2 Phase 4 | Reasoning |
|---|---|---|---|
| `client/tiers.js` | Rename → `skill_rating.js` | **KEEP** | 46 lines. "Tiers" is domain-accurate — these ARE skill tiers. No collision with quality tiers in renderer (those are in `renderer.js` as `currentQuality`). |
| `client/quant.js` | Rename → `net_quantize.js` | **KEEP** | 40 lines. "Quant" is standard shorthand in networking codebases. The file IS quantization helpers. Adding "net_" adds no information since it's already in `client/`. |
| `renderer_command_map.js` | Rename → `renderer_tactical_overlay.js` | **KEEP** | "Command map" is a Tribes-specific term, yes. But so is everything else in this codebase. "Tactical overlay" is no more self-documenting to a non-Tribes player. And the command map IS called "Command Map" in the HUD UI. The name matches the feature name. |
| `renderer_toonify.js` | Consider → `renderer_stylize.js` | **KEEP** | Carmack was right in Run 1: "toonify" is *more* descriptive than "stylize." Everyone knows what toon shading is. |
| `renderer_sky_custom.js` | Not flagged | **RENAME → `renderer_sky.js`** | The `_custom` suffix is a historical accident. There's no `renderer_sky.js` it competes with. Drop the suffix. |

**Muratori:** Run 1's renaming instinct came from a good place — the 30-second architecture test. But Run 2 Phase 4's deeper analysis showed that the names are already accurate for this codebase's domain. Renaming `command_map` to `tactical_overlay` would break every developer's muscle memory for zero readability gain. The one rename that matters — `renderer_sky_custom.js` → `renderer_sky.js` — Run 1 actually missed.

**Run 2 Verdict: MOSTLY INCORRECT. Only ONE rename needed: `renderer_sky_custom.js` → `renderer_sky.js`. All other names are accurate and should be kept.**

---

### Recommendation #7: Audit the 83 `window.*` globals

**Run 1 said:** Categorize each, target reduction to under 30 true globals.

**Run 2 verification:**

Complete audit of all `window.*` identifiers in the codebase (excluding `vendor/` and `build/`):

| Category | Count | Examples |
|---|---|---|
| **Browser API** (unavoidable) | 10 | `addEventListener`, `innerWidth`, `devicePixelRatio`, `AudioContext` |
| **WASM bridge** (unavoidable) | 2 | `Module`, `ST` |
| **WASM→JS callbacks** (set in index.html, called from ASM_CONST) | 14 | `updateHUD`, `playSoundAt`, `onHitConfirm`, `sbRow`, `updateAudio` |
| **IIFE module facades** (→ ES module imports) | 10 | `Cohesion`, `CombatFX`, `CommandMap`, `Minimap`, `Toonify`, `ZoomFX`, `PALETTE`, `PaletteUtils`, `AE`, `DayNight` |
| **Voice subsystem** (→ ES module) | 10 | `__voice`, `__voiceUpdatePeer`, `__voiceSetMuteAll`, etc. |
| **Shared game data** (→ ES module exports) | 12 | `_sampleTerrainH`, `__generatorPositions`, `_tribesCamDist`, `_rapierGrounded`, `RapierPhysics` |
| **Network/match hooks** (set in index.html) | 12 | `__tribesApplyDelta`, `__tribesReconcile`, `__tribesLoadMap`, etc. |
| **Debug-only** (acceptable if gated) | 8 | `scene`, `camera`, `renderer`, `_tribesDebug`, `__tribesBloom`, `DEBUG_LOGS` |
| **Misc** | 7 | `__editor`, `__moderation`, `__replay`, `_flagStingMuted`, `__teamColors`, `__qualityTier`, `registerModelCollision` |
| **Total** | **85** | |

**Carmack:** Run 1 said 83; the actual count is 85. Close enough. The categorization reveals the migration path clearly: 10 IIFE facades + 10 voice globals = 20 globals that disappear the moment those modules migrate to ES modules. That's the lowest-hanging fruit — no logic change, just `export function` instead of `window.X =`.

**ryg:** The 14 WASM→JS callbacks and 12 network hooks are harder. They're set in `index.html` because ASM_CONST macros call them by name. Until `index.html`'s ~3,200 lines of inline JS are extracted into proper modules, those 26 globals are stuck. That's a bigger refactor than the IIFE migration.

**Muratori:** Run 1's target of "under 30 true globals" is achievable: 10 browser API + 2 WASM bridge + 8 debug = 20 irreducible globals. Everything else *can* become an ES module export. The realistic near-term target is: kill the 10 IIFE facades (by migrating to ES modules) and the 10 voice globals (by making voice an ES module). That drops from 85 to 65 without touching the hard index.html refactor. Still far from 30, but measurable progress.

**NEW from Phase 4:** The team color situation is worse than Run 1 realized. `renderer_palette.js` defines `teamRed: '#E84A4A'` and `teamBlue: '#4A8AE8'`, but NO module uses these values. Everyone hardcodes their own variants. The accent color `#FFC850` IS used consistently across 4 modules — but via hardcoded hex, not via palette import. The palette module is a source of truth that nobody consults.

**Run 2 Verdict: CONFIRMED with corrected count (85, not 83) and refined migration path. Near-term target: eliminate IIFE facades and voice globals (−20). Long-term: index.html extraction (−26 more).**

---

### Recommendation #8: Gate `renderer_toonify.js` on silhouette readability

**Run 1 said:** Toon shader ships only if it measurably improves character readability at 300m. Gate 8 test required.

**Run 2 verification:**

Phase 4 naming verdict: **KEEP** the module and the name. The design intent map says toonify serves Scale (visual identity). Phase 1 confirmed it's a post-process pass that quantizes color ramps and adds edge detection.

**Ive:** I'm going to push harder than Run 1 here. The *hypothesis* — that edge detection improves silhouette readability at distance — is testable. But nobody has tested it. And the game design doc says "NOT cel-shaded." Toon shading IS cel-shading's cousin. There's a genuine tension between the stated visual identity and this module's output.

**Carmack:** The game design doc says "NOT: cel-shaded / Breath of the Wild aesthetic." But Firewolf's toon shader isn't BotW-style — it's color ramp quantization with edge detection. Different technique, different output. Whether it *feels* like cel-shading depends on parameters. At subtle settings, it reinforces faceted geometry. At strong settings, it looks like a cartoon.

**ryg:** The GPU cost is one full-screen post-process pass. On low-end hardware — which the project explicitly targets — that's 2-4ms at 1080p depending on fill rate. For a game targeting 16.6ms frames, that's 12-24% of the frame budget on a feature that's never been Gate 8 tested. My recommendation: keep the code, add a quality-tier gate (medium+ only), and require the silhouette readability test before defaulting it on.

**Muratori:** The connection Run 1 made — toon edge detection as a Belonging enabler via silhouette readability — is the strongest argument for keeping it. If edge detection makes armor types distinguishable at 300m, it directly serves the game. Test *that specific hypothesis*. Don't test "does toon shading look good?" — test "can I tell a heavy from a light at 300m with vs without?"

**Run 2 Verdict: CONFIRMED with refinements. Quality-tier gate (medium+ only) AND silhouette readability test required. The hypothesis is sound; the test hasn't been run.**

---

### Recommendation #9: Plan the `renderer.js` monolith split

**Run 1 said:** Don't execute yet. Design the four-group split: geometry, effects, overlays, infrastructure.

**Run 2 verification:**

Phase 1 produced a detailed subsystem map with line-number precision. The monolith contains:

| Group | Subsystems | Lines |
|---|---|---|
| Terrain + Buildings + Interiors + Accents | 4 | ~2,495 |
| Players + Projectiles + Flags + Weapon | 4 | ~865 |
| Particles (6 systems) | 6 | ~1,700 |
| DayNight + Lighting + Post-processing | 3 | ~446 |
| Camera + Spectator | 1 | ~310 |
| Rain + Grass + Ground Fairies | 3 | ~673 |
| Infrastructure (init, loop, map load, quality, state views) | — | ~605 |

**Carmack:** The four-group split from Run 1 maps cleanly to the verified subsystem boundaries. But I want to revise the order. Run 1 said "particles first, then split." Phase 3b said "weather extraction first, then polish decomposition." The correct sequence is:

1. **Particle unification** (jet+ski+trails → one system) — proves the pattern
2. **renderer_polish.js decomposition** (5 stages) — unblocks phase system
3. **renderer.js geometry extraction** (terrain, buildings, interiors) — largest chunk
4. **renderer.js effects extraction** (remaining particles, rain, grass, fairies) — second largest

Each extraction follows the mechanical rule: move functions, verify identical behavior, *then* improve.

**Muratori:** The key insight Run 2 adds: don't split renderer.js until the particle unification AND polish decomposition prove the pattern works. Those are smaller modules with clearer boundaries. If extraction from a 1,146-line file goes wrong, you've learned the lesson cheaply. If extraction from a 6,094-line file goes wrong, you've wasted a day.

**Run 2 Verdict: CONFIRMED with refined execution order. Particles → polish decomposition → renderer.js split. Each stage proves the extraction pattern for the next.**

---

### Recommendation #10: Define a team-count constant

**Run 1 said:** Replace all 28 instances of hardcoded 2-team logic with a single `TEAM_COUNT` constant. Game design says four tribes; codebase says two.

**Run 2 verification:**

Phase 1 confirmed 2-team hardcoding across `renderer.js` (11 locations). Phase 4 found it in 6 of 12 small modules. Phase 5 produced the definitive count: **6 modules with hardcoded 2-team logic** (not 12 as Run 1 Phase 5 claimed — combat_fx is team-agnostic, which is a missing feature, not a hardcoded one).

**NEW critical finding from Phase 4:** The team color mapping is *inconsistent*:
- **minimap + command_map:** team 0 = blue (`#3FA8FF`), team 1 = red (`#FF6A4A`)
- **mapeditor + replay + palette:** team 0 = red (`#C8302C`), team 1 = blue (`#2C5AC8`)

This means the minimap has the team colors **INVERTED** relative to the palette and map editor. This is a latent visual bug — when multiplayer is live, minimap dots will show the wrong team color.

**Carmack:** The `TEAM_COUNT` constant is still the right fix, but the team color inversion is a higher-priority bug. Define the constant AND fix the color mapping simultaneously. The source of truth should be `renderer_palette.js` (team 0 = Blood Eagle red, team 1 = Diamond Sword blue), and minimap/command_map should import from it. This is a data-authority problem, not just a constant problem.

**ryg:** 28 locations is the Run 1 estimate. Phase 4 found the actual number is lower — about 18-20 across 6 modules. Still requires coordinated changes, but more tractable than claimed.

**Run 2 Verdict: CONFIRMED with elevated priority. Team color INVERSION is a P1 bug. Fix the inversion, define `TEAM_COUNT`, and establish palette as the single source of truth for team colors.**

---

### Recommendation #11: Migrate IIFEs to ES modules incrementally

**Run 1 said:** One file per session, test thoroughly. Prioritize files most coupled through globals.

**Run 2 verification:**

Current module system state (verified):
- **ES modules (4):** `renderer_polish.js`, `renderer_buildings.js`, `renderer_characters.js`, `renderer_sky_custom.js`
- **IIFEs via `<script>` tag (8):** `renderer_cohesion.js`, `renderer_minimap.js`, `renderer_combat_fx.js`, `renderer_toonify.js`, `renderer_command_map.js`, `renderer_palette.js`, `renderer_debug_panel.js`, `renderer_zoom.js`

Each IIFE migration eliminates one `window.*` facade global. 8 IIFEs = 8 globals eliminated.

**Carmack:** Run 1's advice is sound. One file at a time. But prioritize by coupling, not by size:
1. `renderer_palette.js` (92 lines) — smallest, simplest, AND fixing the team color authority problem
2. `renderer_cohesion.js` — kill it, don't migrate it
3. `renderer_toonify.js` (210 lines) — small, self-contained
4. `renderer_zoom.js` (206 lines) — while fixing the unconditional RAF
5. Then the larger ones: minimap (348), combat_fx (301), command_map (601), debug_panel (216)

**Muratori:** The voice subsystem (10 `window.__voice*` globals) is also a candidate for ES module migration. `client/voice.js` at 314 lines exposes its entire API through 10 window globals. That's 10 globals eliminated in one migration.

**Run 2 Verdict: CONFIRMED. Start with palette (fixes color authority). Kill cohesion (don't migrate). Voice module is a high-value target (10 globals in one migration).**

---

### Recommendation #12: Cap the decal system at 48 visible decals

**Run 1 said:** Fade aggressively beyond 32. Current 256 budget exceeds perceptual relevance. Contradicts "atmosphere over texture."

**Run 2 verification:**

Phase 3b confirmed: decals use `new THREE.MeshBasicMaterial(...)` per decal at L510 of `renderer_polish.js`. 256 decals = 256 separate materials = 256 draw calls. No material sharing.

**ryg:** Run 1's recommendation is correct on the budget but missed the bigger issue: 256 separate materials is 256 *unique* draw calls. That's not just a perceptual problem — it's a GPU pipeline problem. Each material change flushes the pipeline state. Even if you cap at 48 visible, if they each have unique materials, you're still paying 48 state changes. The fix is: shared material with per-decal texture atlas offset, AND a visibility cap.

**Carmack:** The "atmosphere over texture" principle is well-served by capping decals. But the material-per-decal issue is a performance bug independent of the design question. Fix the materials first (shared material, pool geometry), then decide the visual cap based on perceptual testing.

**Run 2 Verdict: CONFIRMED with addition. Cap at 48 AND fix the material-per-decal anti-pattern (shared material with atlas). Two problems, one system.**

---

### Recommendation #13: Establish a code-deletion ritual

**Run 1 said:** Disabled features get 30 days. If not re-enabled, archive to branch and delete from main.

**Run 2 verification:**

Run 2 evidence for the need:
- `renderer_cohesion.js`: created at R32.25 (months ago), still alive as dead code
- Rain system in `renderer.js`: disabled, still allocates geometry on init
- Legacy particle system (`syncParticles`, L3459–4051): 593 lines of pre-GPU pattern code, audit status unclear
- Dead `_playFlagSting` code: 44 lines unreachable after `return;` at L921 in polish.js

**Muratori:** The ritual isn't just about deletion — it's about *decision*. Right now, disabled code sits in limbo forever because nobody is forced to decide "are we shipping this or not?" A 30-day expiry forces the decision. If the answer is "we want it but it's not ready," the code moves to a branch where it can mature without cluttering main. If the answer is "we don't need it," delete.

**Carmack:** I'd add a concrete mechanism: a comment marker like `// @disabled YYYY-MM-DD reason` on any code that gets gated behind a feature flag. A session can grep for these, check dates, and enforce the 30-day rule. Without a machine-readable marker, the ritual depends on human memory, which doesn't survive session restarts.

**Run 2 Verdict: CONFIRMED with mechanism addition. Use `// @disabled YYYY-MM-DD reason` markers. Grep-enforceable by future sessions.**

---

## 3. New Findings from Run 2

These items were NOT in Run 1 Phase 6 but emerged from Run 2 Phases 1–5.

### N1: `@ai-contract` Blocks Don't Exist

The audit plan specifies in-source `@ai-contract` blocks at the top of every file. After 12 phases of review across 2 runs, **zero** have been written. The contracts are documented in Run 1 and Run 2 dialogue, but they haven't been committed to source.

**Ive:** This is the single most actionable gap between the audit's output and the codebase. Every finding, every recommendation, every pattern — all of it lives in audit log markdown files that an AI session might not read. `@ai-contract` blocks are *in the code*, where the session is already looking. They're the delivery mechanism for everything we've discussed.

**Run 2 Verdict: P1 action. Write `@ai-contract` blocks for every file, incorporating all Run 1 and Run 2 findings.**

### N2: Team Color Inversion Is a P1 Bug

Phase 4 discovered that minimap and command_map define team 0 = blue, while palette, mapeditor, and replay define team 0 = red. This is a latent multiplayer bug — the minimap will show your team as the enemy color and vice versa.

**Carmack:** This is the kind of bug that survives for months because single-player testing only uses one team. The moment two humans connect, the minimap shows the wrong colors. Fix before any multiplayer testing.

**Run 2 Verdict: P1 bug. Fix before multiplayer. Palette is the authority → minimap and command_map must import from palette.**

### N3: Telemetry Reads Wrong HEAPF32 Offsets

Phase 3a + 3b discovered that `renderer_polish.js` reads playerView offsets `o+4/5/6` as velocity, but the definitive stride map says `o+4` = yaw, `o+5` = roll, `o+6` = velX. The telemetry HUD displays yaw/roll values labeled as velocity. Active display bug.

**Run 2 Verdict: P1 bug (incorrect data displayed to player). Fix telemetry to read `o+6/7/8` for velocity.**

### N4: `renderer_zoom.js` Unconditional RAF

Phase 4 found that zoom's `requestAnimationFrame` loop runs every frame from page load, regardless of whether zoom is active. Unlike command_map (which self-terminates when closed), zoom never stops.

**Run 2 Verdict: P2 fix. Guard RAF behind `zoomLevel !== 1.0` or `isZooming` flag.**

### N5: iOS AudioContext Limit

Phase 3b discovered that `renderer_polish.js` thunder synthesis creates its own `AudioContext` independent of the main audio system. iOS Safari limits to 1 AudioContext — the second may fail silently.

**Run 2 Verdict: P2 fix. Route all audio through the single `client/audio.js` AudioContext.**

---

## 4. Core Feelings Alignment — Run 2 Reassessment

**Ive:** Run 1 mapped every module to Core Feelings. Run 2 validated the mapping and found it accurate. The coverage analysis hasn't changed:

| Core Feeling | Well-Served | Underserved |
|---|---|---|
| **Belonging** | Team colors (palette), character models (4 teams × 3 armors), flags, buildings, base accents, voice chat | **Audio** (no VGS, no "base under attack" alarm). **Gameplay** (4-tribe support, vehicles, phase-forced roles unbuilt). |
| **Adaptation** | Combat FX (hit feedback, tracers), projectile rendering, command map | **Phase system** (unbuilt — #1 gap). No fog, no lava flood, no mech wave. |
| **Scale** | Terrain, sky dome, skiing particles, jet exhaust, camera, zoom, rapier physics | **Audio** (no wind at altitude, no Doppler). Water renderer unbuilt. |
| **Aliveness** | Day/night, ground fairies (64K motes), night fairies, post-processing bloom, interior lights, generator hum | **Interactivity** (world breathes passively, doesn't react to players). |

**Ive:** The single largest gap between the game design document and the implementation remains the **phase system**. Adaptation has zero working gameplay systems. The renderer CAN handle phase-reactive atmosphere — sky, lighting, post-processing all support it. But the phase state machine, HUD timeline, and transition logic don't exist. And `renderer_polish.js` weather extraction is the critical-path prerequisite.

**Run 2 Verdict: Unchanged from Run 1. Audio is the most underserved sensation channel. Phase system is the most underbuilt Core Feeling driver. Weather extraction from polish.js is the critical path.**

---

## 5. Visual Identity Coherence — Run 2 Reassessment

**Ive:** Run 1 raised the PBR vs. procedural boldness tension. Has anything changed?

**ryg:** No. The PBR texture pipeline (R32.70) is still in place. 256×256 PNGs in `assets/textures/buildings/`. The palette colors are used as tint multipliers on PBR albedo, which is actually a good approach — it keeps the visual identity bold while using physically-correct lighting. The tension Run 1 identified was more theoretical than practical.

**Carmack:** The real visual coherence issue Run 2 surfaced is the *color authority* problem. Team colors are defined in 4 different places with 4 different hex values. `renderer_palette.js` defines colors that nobody imports. Everyone hardcodes their own variants. The accent color `#FFC850` IS consistent across 4 modules — but via copied hex strings, not imports. The visual identity is held together by coincidence, not by architecture.

**Ive:** That's the design coherence version of the global coupling problem. Color should flow from one source — palette — through every module. Right now it's a folk tradition: "we all agree red is approximately `#C8302C` but everyone writes their own shade." Fix the palette authority, and the visual identity becomes architecturally enforced instead of culturally maintained.

**Run 2 Verdict: PBR + palette tint is a good approach. Color authority from palette is the design-coherence fix that matters.**

---

## 6. Convergence: Definitive Recommendations

**Ive:** Run 1 had 13 recommendations. Run 2 validates 9, corrects 3, and adds 5 new findings. Here is the **definitive** prioritized list. These supersede Run 1 Phase 6's recommendations.

### Priority 0: Bugs (fix before any feature work)

**D1. Fix team color inversion** — minimap and command_map have team 0/1 colors swapped relative to palette. P1 latent multiplayer bug. Palette is the authority; minimap and command_map must import from it. *(New finding from Phase 4)*

**D2. Fix telemetry HEAPF32 offsets** — `renderer_polish.js` reads `o+4/5/6` as velocity; actual stride is `o+4`=yaw, `o+5`=roll, `o+6`=velX. Telemetry HUD shows wrong data. *(New finding from Phase 3a/3b)*

**D3. Fix iOS AudioContext limit** — `renderer_polish.js` thunder synthesis creates second AudioContext. Route through `client/audio.js`. *(New finding from Phase 3b)*

### Priority 1: Immediate Cleanup (trivial, unanimous)

**D4. Kill `renderer_cohesion.js`** — 138 lines, confirmed dead, creates problematic second AudioContext. Delete file, remove `<script>` tag from index.html. *(Run 1 #1: CONFIRMED)*

**D5. Rename `tribes.js`** — Move to `generated/emscripten_glue.js` or `wasm_glue.js`. Add `.gitattributes` suppression and `GENERATED.md` marker. *(Run 1 #2: CONFIRMED with additions)*

**D6. Rename `renderer_sky_custom.js` → `renderer_sky.js`** — Drop historical `_custom` suffix. *(New finding from Phase 4, replacing Run 1 #6)*

### Priority 2: Performance & Architecture

**D7. Guard `renderer_zoom.js` RAF** — Unconditional RAF runs every frame from page load. Guard behind zoom-active check. *(Run 1 #3: CORRECTED targets)*

**D8. Defer rain init until enabled** — `initRain()` allocates geometry unconditionally. Defer to first enable. *(Run 1 #3: CORRECTED — grass ring is already quality-tier-gated)*

**D9. Unify jet + ski + trail particles** — 3-way merge into one parameterized system. ~200–250 line reduction. Explosions and fairies stay independent. *(Run 1 #4: CORRECTED scope from 6 → 3)*

**D10. Decompose `renderer_polish.js` in 5 stages** — Weather extraction first (unblocks phase system). Then HUD, then building enhancements, then rename remainder. *(Run 1 #5: CORRECTED from 2-file split to 5-stage decomposition)*

**D11. Cap decals at 48 with shared material** — Fix material-per-decal anti-pattern (256 unique materials). Shared material + atlas + visibility cap. *(Run 1 #12: CONFIRMED with material fix)*

### Priority 3: Data Model & Coupling

**D12. Define `TEAM_COUNT` and fix team color authority** — Single constant. Palette as single source of truth for team colors. All modules import from palette. Fix the ~18-20 hardcoded 2-team locations across 6 modules. *(Run 1 #10: CONFIRMED with color authority addition)*

**D13. Audit and reduce `window.*` globals** — 85 unique identifiers. Near-term: migrate IIFE facades to ES modules (−10 globals). Migrate voice to ES module (−10 globals). Target: 65 within one sprint. Long-term: extract index.html inline JS (−26 more). *(Run 1 #7: CONFIRMED with corrected count and refined path)*

**D14. Migrate IIFEs to ES modules** — Start with palette (fixes color authority). Then toonify, zoom (fix RAF), minimap, combat_fx, command_map, debug_panel. One at a time, test each. *(Run 1 #11: CONFIRMED with revised priority order)*

### Priority 4: Structural

**D15. Plan `renderer.js` monolith split** — Prove the extraction pattern with particle unification (D9) and polish decomposition (D10) first. Then execute: geometry → effects → overlays → infrastructure. Mechanical split only — don't redesign data flow during the move. *(Run 1 #9: CONFIRMED with prerequisite chain)*

**D16. Gate toon shader on silhouette readability** — Keep `renderer_toonify.js`. Add quality-tier gate (medium+ only). Require Gate 8 test: "can I tell heavy from light at 300m with vs. without?" Ship only if it passes. *(Run 1 #8: CONFIRMED with quality-tier gate)*

### Priority 5: Process

**D17. Write `@ai-contract` blocks for every file** — Zero exist. Every audit finding, dependency, exposure, and coordinate space should be in-source where sessions see it. *(New finding — audit plan deliverable not yet executed)*

**D18. Establish code-deletion ritual with `@disabled` markers** — `// @disabled YYYY-MM-DD reason` on feature-flagged code. 30-day expiry. Grep-enforceable. *(Run 1 #13: CONFIRMED with mechanism)*

---

## 7. Architecture Summary: What This Codebase Is

**Ive:** Let me close with the same thought I ended Run 1 with, updated for everything we now know.

This codebase was built by one person with extraordinary focus. 13,084 lines of hand-written JavaScript, 6,868 lines of Emscripten glue, 15 renderer modules, 11 client modules, 6 particle systems, a procedural sky dome, a physics facade, a multiplayer networking stack, and a standalone asset editor.

It works. It runs. Players can ski, jet, shoot, and capture flags in a browser.

The issues we've identified across 10,445 lines of audit dialogue fall into four categories:

1. **Bugs** (3): team color inversion, telemetry offset, iOS AudioContext. Fix immediately.
2. **Dead weight** (2): `renderer_cohesion.js`, misleading `tribes.js` name. Clean up in one commit.
3. **Architectural debt** (8): monolith size, IIFE/ES split, global coupling, particle duplication, polish decomposition, decal materials, disabled-code execution, missing contracts. Address incrementally.
4. **Missing features** (2): phase system (Adaptation), audio expansion (all four feelings). Build when architecture supports it.

The architecture serves a solo developer building fast. It doesn't yet serve a codebase that needs to grow. The audit's job was to make that gap visible and provide a path to close it. That path is: fix bugs → clean dead weight → prove extraction patterns on small modules → apply patterns to the monolith → build the phase system on a clean foundation.

**Carmack:** Ship the game. Clean as you go. The bugs are real — fix those first. Everything else is investment in the future, and the timeline is yours.

**Muratori:** Show me the data flow and I'm satisfied. Right now I can't see it because 85 globals and 8 IIFEs make every data path invisible to tooling. Fix the module system and the architecture becomes legible without reading 13,000 lines.

**ryg:** Make the pipeline honest. Every draw call should have a name, a budget, and a reason to exist. The 256 decal materials, the unconditional zoom RAF, the rain geometry allocated for a disabled feature — these are pipeline lies. The pipeline says it's doing something it's not, or doing more than it should. Fix those and profiling becomes trustworthy.

**Ive:** Phase 6 complete. The audit is complete. Two full runs. Every module reviewed. Every finding validated, challenged, or corrected. Back to you, Levi.

---

## Appendix: Complete File Audit Summary

| File | Lines | Module Type | Status | Key Finding |
|---|---|---|---|---|
| `renderer.js` | 6,094 | ES (implicit) | **KEEP — plan split** | 46.6% of code. 15+ subsystems. Extraction after particles + polish prove pattern. |
| `renderer_polish.js` | 1,146 | ES module | **DECOMPOSE (5 stages)** | 17+ subsystems. Weather extraction = critical path for phase system. |
| `renderer_cohesion.js` | 138 | IIFE | **KILL** | Dead code. Second AudioContext. Delete immediately. |
| `renderer_toonify.js` | 210 | IIFE | **KEEP — Gate 8 test** | Quality-tier gate (medium+). Silhouette readability test required. |
| `renderer_command_map.js` | 601 | IIFE | **KEEP** | Name is accurate. Resize debounce needed. |
| `renderer_minimap.js` | 348 | IIFE | **KEEP — fix team colors** | Team 0/1 colors inverted vs palette. P1 bug. |
| `renderer_combat_fx.js` | 301 | IIFE | **KEEP** | Singleton pattern limits spectator mode. |
| `renderer_sky_custom.js` | 396 | ES module | **RENAME → `renderer_sky.js`** | Drop `_custom` suffix. |
| `renderer_zoom.js` | 206 | IIFE | **KEEP — fix RAF** | Unconditional RAF worst offender. Guard behind zoom-active. |
| `renderer_palette.js` | 92 | IIFE | **KEEP — establish as authority** | Colors don't match consumers. Fix: make palette the single source. |
| `renderer_debug_panel.js` | 216 | IIFE | **KEEP** | Dev-only. Gate behind build flag when pipeline exists. |
| `renderer_rapier.js` | 456 | IIFE-ish | **KEEP** | Intentional dual-physics migration. |
| `renderer_characters.js` | 294 | ES module | **KEEP** | Map-based instance store recommended. |
| `renderer_buildings.js` | 362 | ES module | **KEEP — absorb polish details** | Target for building enhancement extraction from polish.js. |
| `tribes.js` | 6,868 | Script tag | **RENAME + RELOCATE** | 100% Emscripten glue. `generated/emscripten_glue.js`. |
| `client/audio.js` | 95 | Script tag | **KEEP — massively expand** | #1 underserved sensation channel. |
| `client/constants.js` | 115 | Script tag | **KEEP** | Add `TEAM_COUNT`. |
| `client/network.js` | 331 | Script tag | **KEEP** | Needs hardening for 64-player. |
| `client/prediction.js` | 140 | Script tag | **KEEP — IS LIVE** | Run 1 Phase 5 wrongly claimed dead. reconcile() wired via index.html. |
| `client/wire.js` | 254 | Script tag | **KEEP** | Binary protocol. Stable. |
| `client/quant.js` | 40 | Script tag | **KEEP** | Name is accurate per Run 2. |
| `client/tiers.js` | 46 | Script tag | **KEEP** | Name is accurate per Run 2. |
| `client/voice.js` | 314 | Script tag | **KEEP — migrate to ES** | 10 window globals. High-value IIFE→ES target. |
| `client/replay.js` | 376 | Script tag | **KEEP** | RAF pattern is correct (modal replacement). |
| `client/moderation.js` | 120 | Script tag | **KEEP** | Belonging protection. |
| `client/mapeditor.js` | 393 | Script tag | **KEEP — fix team colors** | team 0=red. Matches palette, contradicts minimap. |

---

*Run 2 Phase 6 complete. The Adversarial Convergence Review is finished. Two full runs. 18 definitive recommendations. 3 P1 bugs. Every module mapped, every feeling accounted for, every finding validated or corrected.*
