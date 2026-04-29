# GAP ANALYSIS — Cohort Dialogue vs. Implemented Actions

> **Every audit phase, every fix review, every expert recommendation — cross-referenced against what was actually done.**
> This document captures everything the cohort discussed that was NOT addressed in the 32 action items or was partially addressed with unresolved follow-ups.

---

## How This Was Built

Read every line of:
- 9 Run 1 phase logs (`phase-1-renderer.md` through `phase-6-refinement.md`)
- 9 Run 2 phase logs (`phase-1-renderer.md` through `phase-6-refinement.md`)
- 15 per-fix review logs (`item-01-player-state.md` through `item-16-thunder-audio-ctx.md`)
- `FINAL-REPORT.md` (32 action items)
- `audit-plan.md` (process requirements)
- `feature-gates.md` (8-gate process)

Every recommendation was extracted and compared against the 32 action items. If a recommendation appears in the dialogue but has NO corresponding action item, it's listed below.

---

## 1. Missing Action Items

These are actionable recommendations from the cohort that have NO corresponding item in the FINAL-REPORT's 32 action items.

---

### ITEM 33 — Visual Test Harnesses (CRITICAL PROCESS GAP)

**Source:** Phase 1 Run 1 (Carmack), audit-plan.md Pass 5, feature-gates.md Gate 5

**Carmack, Phase 1 R1:** *"We need standalone test harnesses for: terrain, sky/DayNight, particles, camera/spectator, and lighting. Each one isolated, each one inspectable."*

**audit-plan.md success criteria:** *"T1 and T2 modules have isolated test harnesses"*

**feature-gates.md Gate 5 — ISOLATE:** *"Build or update a test harness — standalone HTML page following `test/buildings_test.html` template. Visual systems: Standalone HTML page. Logic systems: Console-based validation or unit test."*

**What exists:** Only `test/buildings_test.html` (pre-existing). Zero new test harnesses were created despite 16 items being implemented.

**What's needed:** Test harnesses for every extracted/modified visual module:
- `test/terrain_test.html` — terrain rendering, shader injection, LOD
- `test/daynight_test.html` — day/night cycle, exposure, lighting
- `test/particles_test.html` — all particle systems in isolation
- `test/camera_test.html` — all 6 camera modes
- `test/sky_test.html` — sky dome, clouds, stars, moon
- `test/weather_test.html` — lightning, wet ground, lens flare
- `test/combat_fx_test.html` — shockwave, decals, tracers, muzzle flash
- `test/rapier_test.html` — physics collision, character controller
- `test/minimap_test.html` — minimap rendering, 4-team support
- `test/integration_full_frame.html` — full frame verification (Gate 6 requires this)

**Why it matters:** Gate 5 says *"Feature doesn't work in isolation = not ready for integration."* Every fix was integrated without isolation testing. This is the single largest process violation.

**Effort:** 2-4 hours per harness (following buildings_test.html template)
**Priority:** CRITICAL — blocks all future Gate 5 compliance

---

### ITEM 34 — @ai-contract Blocks in Source Files (CRITICAL PROCESS GAP)

**Source:** audit-plan.md Pass 5, feature-gates.md pre-commit checklist, Phase 6 R2 (Ive)

**audit-plan.md:** *"Produce @ai-contract comment blocks at top of each file."*

**audit-plan.md success criteria:** *"Every module has an in-source @ai-contract block"*

**feature-gates.md pre-commit checklist:** *"@ai-contract block present and accurate?"*

**Ive, Phase 6 R2:** *"This is the single most actionable gap between the audit's output and the codebase. Every finding, every recommendation, every pattern — all of it lives in audit log markdown files that an AI session might not read. @ai-contract blocks are IN the code, where the session is already looking."*

**What exists:** Zero @ai-contract blocks in any source file. The pre-commit checklist requires checking for them, but none exist to check.

**What's needed:** Every `.js` file needs a header block documenting:
- Module purpose (one sentence)
- IMPORTS (what it reads)
- EXPORTS (what it provides)
- EXPOSES (window.* globals it creates)
- LIFECYCLE (init/update/dispose)
- OWNER (which Core Feeling it serves)

**Why it matters:** Without these, a fresh AI session has no way to understand module contracts without reading audit logs. The audit produced the knowledge; @ai-contract blocks are the delivery mechanism.

**Effort:** 15-30 min per file × ~27 files = ~8-12 hours
**Priority:** CRITICAL — required by both audit-plan.md and feature-gates.md

---

### ITEM 35 — Remote Players Always Hidden (HIGH)

**Source:** Phase 1 R1 (Muratori), Phase 5 R1+R2 (Frame Trace)

**Muratori, Phase 1 R1:** *"Remove the 6 lines that disable remote players."*

**Phase 5 Frame Trace:** *"IF i !== localIdx → mesh.visible = false; CONTINUE ← ALL REMOTE PLAYERS HIDDEN"*

**FINAL-REPORT finding LOW-14 (if it exists) or not listed:** This is mentioned in the findings as part of REN-06 (dead code) but is NOT an explicit action item. The syncPlayers function at line 3792 sets `mesh.visible = false` for ALL non-local players. This is a development hack that makes the game appear single-player.

**What's needed:** Remove the early-return/visibility-false for remote players. This is prerequisite to Item 31 (entity interpolation) and Item CHR-01 (remote player architecture).

**Effort:** 5 min to remove the line. But requires remote player rendering to actually work (Items 31, CHR-01).
**Priority:** HIGH — blocks multiplayer testing

---

### ITEM 36 — Phase System Hooks (HIGH — Blocks Next Major Feature)

**Source:** Phase 1 R1 (C2), Phase 3b R1 (C-1), Phase 6 R2 (Ive)

**Phase 1 R1 Cartographer (C2):** *"The renderer has no phase state, no phase transition hooks, no way for an external system to say 'we're now in dense fog phase.'"*

**Phase 3b R1 Cartographer (C-1):** *"The module has zero phase awareness... The polish module — which controls atmosphere-critical effects — doesn't know what phase it's in."*

**Ive, Phase 6 R2:** *"The single largest gap between the game design document and the implementation remains the phase system... Zero working gameplay systems [for Adaptation]."*

**Carmack, Phase 3b R1:** *"This is the strongest argument for splitting [polish] now rather than later. The phase system is the next major feature."*

**What's in the 32 items:** Item 20 (extract renderer_weather.js) is described as "gates the phase system" but the actual phase hooks — `onPhaseChange(phase)` in each module — are never specified as an action item.

**What's needed:** Define phase state enum. Add `onPhaseChange(phase)` hook to: weather, sky, DayNight, combat_fx, minimap, command_map. Define per-phase atmospheric presets (fog density, sky color, wind, visibility range).

**Effort:** 2-3 hours for interface definition + per-module hooks
**Priority:** HIGH — Ive identified this as the #1 Core Feeling gap (Adaptation)

---

### ITEM 37 — Lessons-Learned Updates (MEDIUM)

**Source:** Phase 5 R1+R2, audit-plan.md

**Phase 5 R1:** *"10 missing lessons-learned entries (#6-#15): Night ambient typo, HDRI race, remote players hidden, tribes.js misleading, Rapier dual-physics, telemetry wrong offsets, addBridgeRailings undefined scene, flag Z dropped, network.js start() not idempotent, ping formula wrong"*

**audit-plan.md success criteria:** *"lessons-learned.md is up to date"*

**What exists:** lessons-learned.md has entries #1-#5 from before the audit. The audit identified 10+ new lessons. None were written.

**Effort:** 1 hour
**Priority:** MEDIUM — required by audit-plan.md success criteria

---

### ITEM 38 — Patterns.md Missing Entries (MEDIUM)

**Source:** Phase 5 R1

**Phase 5 R1:** *"3 missing patterns: Weapon viewmodel, DOM HUD overlay (#r327-*), WASM callback bridge (ASM_CONST → window.*)"*

**What exists:** patterns.md has canonical implementations but is missing the 3 identified patterns.

**Effort:** 30 min
**Priority:** MEDIUM

---

### ITEM 39 — System-Map.md index.html Section (MEDIUM)

**Source:** Phase 5 R1+R2

**Phase 5 R1:** *"Missing system-map entries: index.html globals (12+ WASM callbacks + ~30 others); full writer/reader mapping for all 83 globals"*

**What exists:** system-map.md exists but the index.html section is partial/missing.

**Effort:** 1 hour
**Priority:** MEDIUM

---

### ITEM 40 — DayNight freeze/unfreeze API Bug (MEDIUM — Active Bug)

**Source:** Phase 1 R2 (N4), listed as finding REN-02

**Phase 1 R2:** *"External freeze(h) sets this._frozen but update() reads closure _frozen01. Two different variables."*

**Listed in FINAL-REPORT findings (REN-02) but NOT in the 32 action items.** This is a correctness bug with no fix scheduled.

**Effort:** 15 min
**Priority:** MEDIUM — blocks DayNight external control (e.g., map editor, phase system)

---

### ITEM 41 — Module._restartGame Phantom Export (MEDIUM — Active Bug)

**Source:** Phase 2a R2 (NEW-T-003), listed as finding NET-05

**Phase 2a R2:** *"Called with if(Module._restartGame) guard, but not in WASM export table."*

**Listed in FINAL-REPORT findings (NET-05) but NOT in the 32 action items.** Restart is silently broken.

**Effort:** 30 min (either add to WASM exports or remove the call)
**Priority:** MEDIUM — restart button does nothing

---

### ITEM 42 — updateAudio 4 vs 5 Params — Skiing Sound Dropped (MEDIUM — Active Bug)

**Source:** Phase 2a R2 (NEW-T-002), listed as finding NET-06

**Phase 2a R2:** *"Two ASM_CONST entries with different signatures."*

**Listed in FINAL-REPORT findings (NET-06) but NOT in the 32 action items.** Skiing sound is never played because the 5th parameter (skiing state) is dropped.

**Effort:** 15 min
**Priority:** MEDIUM — skiing should have a sound; it's a Core Feeling (Aliveness)

---

### ITEM 43 — Flag Z Hardcoded to 0 in Wire Decode (MEDIUM — Active Bug)

**Source:** Phase 3c R1 (C-2), Phase 3c R2 (validated), listed as finding NET-07

**Fiedler, Phase 3c R2:** *"The missing coordinate means flags are placed at the correct height but at Z=0 on the horizontal axis... For a map where the flag stands are at the extremes of the Z axis, this means flags snap to the centerline."*

**Recommendation:** *"Expand SIZE_FLAG from 8 to 10 bytes to include posZ."*

**Listed in FINAL-REPORT findings (NET-07) but NOT in the 32 action items.**

**Effort:** 30 min (wire format change + decoder update)
**Priority:** MEDIUM — flags render at wrong horizontal position

---

### ITEM 44 — No Capsule Resize for Armor Type Change (MEDIUM)

**Source:** Phase 2b R2 (NEW-R-006), listed as finding PHY-06

**Phase 2b R2:** *"Capsule created once at init with medium armor dimensions."*

**Listed in FINAL-REPORT findings (PHY-06) but NOT in the 32 action items.** When armor type changes, the physics capsule stays the same size.

**Effort:** 30 min
**Priority:** MEDIUM — blocks armor tier differentiation

---

### ITEM 45 — Palette Hex Values Match No Consumer (MEDIUM)

**Source:** Phase 4 R2, listed as finding PAL-01

**Ive, Phase 4 R2:** *"Not only does nobody use the palette — the colors that ARE hardcoded across the codebase DON'T EVEN AGREE WITH EACH OTHER."*

**Barrett, Phase 4 R2:** *"Palette defines '#E84A4A'; nobody uses it. 5 different 'red' values exist."*

**Item 2 (team_config.js) creates a NEW source of truth but does NOT enforce migration.** The palette module still exists with unused hex values, and individual modules still hardcode their own colors.

**What's needed:** After team_config.js is established, migrate ALL color references in minimap, command_map, combat_fx, mapeditor, and replay to import from team_config. Delete palette's color duplication.

**Effort:** 2 hours
**Priority:** MEDIUM — visual inconsistency across modules

---

### ITEM 46 — Shockwave Geometry Pool (MEDIUM)

**Source:** Phase 3b R1 (S-1, ryg-2)

**Saboteur, Phase 3b R1 (S-1):** *"N concurrent ring meshes are in the scene graph simultaneously... an uncontrolled draw call source with no pool, no cap, no reuse."*

**ryg, Phase 3b R1 (ryg-2):** *"A pool of pre-created meshes (set visible/invisible, reuse geometry via uniform scale) would cap draw calls at pool size."*

**Panel consensus:** *"Pool with fixed cap (8-16 max). Reuse mesh + material."*

**Not in the 32 action items.** Shockwave creates unbounded draw calls and still uses its own rAF loop.

**Effort:** 1 hour
**Priority:** MEDIUM — GPU draw call leak during combat

---

### ITEM 47 — Generator Smoke Continues After Destruction (MEDIUM)

**Source:** Phase 3b R1 (C-2)

**Cartographer, Phase 3b R1 (C-2):** *"When a generator is destroyed, the smoke continues. There's no removeGeneratorChimney()."*

**Not in the 32 action items.** No callback exists to stop smoke when a generator goes down.

**Effort:** 30 min
**Priority:** MEDIUM — visual bug during gameplay

---

### ITEM 48 — Connection State Machine (MEDIUM)

**Source:** Phase 3c R1 (C-1)

**Cartographer, Phase 3c R1 (C-1):** *"No formal state machine. There's no getConnectionState(). State spread across 5 variables."*

**Not in the 32 action items.** Network connection state is implicit across multiple variables rather than an explicit state machine.

**Effort:** 2 hours
**Priority:** MEDIUM — makes reconnect/disconnect handling fragile

---

### ITEM 49 — Wire Format Version Field (MEDIUM)

**Source:** Phase 3c R1 (CM-4)

**Muratori, Phase 3c R1 (CM-4):** *"When the wire format changes... there's no way to detect version mismatch... The flags byte is unused and could serve as a version field."*

**Not in the 32 action items.** Any wire format change silently breaks client-server compatibility.

**Effort:** 30 min
**Priority:** MEDIUM — blocks safe protocol evolution

---

### ITEM 50 — Input Redundancy (MEDIUM)

**Source:** Phase 3c R1 (GF-3)

**Fiedler, Phase 3c R1 (GF-3):** *"Standard practice: each client packet includes the last 3-5 inputs so the server can recover from drops."*

**Not in the 32 action items.** Single input per packet means any dropped packet loses input permanently.

**Effort:** 2 hours
**Priority:** MEDIUM — input loss on packet drop

---

### ITEM 51 — Decouple Input Send Rate (MEDIUM)

**Source:** Phase 3c R1 (GF-2), Phase 3c R2 consensus

**Fiedler, Phase 3c R1 (GF-2):** *"Sending at 2× server tick rate with no redundancy is the worst of both worlds: high bandwidth, no loss resilience."*

**Consensus:** *"Decouple local input application (60Hz) from network send rate (30Hz). Send at TICK_HZ with 2-3 input redundancy per packet."*

**Not in the 32 action items.**

**Effort:** 1 hour
**Priority:** MEDIUM — halves client→server bandwidth

---

### ITEM 52 — Snapshot Sequence Numbers (MEDIUM)

**Source:** Phase 3c R1 (C-3)

**Cartographer, Phase 3c R1 (C-3):** *"No sequence numbers on snapshots/deltas... no way for the client to know how many snapshots it missed."*

**Not in the 32 action items.** Blocks future UDP/WebRTC migration.

**Effort:** 1 hour
**Priority:** MEDIUM — prerequisite for transport upgrade

---

### ITEM 53 — Jitter Buffer for Snapshots (LOW)

**Source:** Phase 3c R1 (GF-4)

**Fiedler, Phase 3c R1 (GF-4):** *"Network jitter means snapshots arrive at irregular intervals... Without a jitter buffer, the visual interpolation between snapshots will stutter."*

**Not in the 32 action items.**

**Effort:** 3 hours
**Priority:** LOW — becomes important with entity interpolation (Item 31)

---

### ITEM 54 — Voice Globals Migration (LOW)

**Source:** Phase 3c R1 (W-5, CM-2), Phase 6 R2 (D14)

**Wiring Inspector, Phase 3c R1 (W-5):** *"10 window.__voice* globals bypass ES module system."*

**Muratori, Phase 3c R1 (CM-2):** *"network.js shouldn't know or care about the voice module's global surface."*

**Item 24 (IIFE→ES migration) covers this category broadly, but the voice globals are specifically called out as a migration target that eliminates 10 globals at once.**

**Effort:** 30 min
**Priority:** LOW — covered broadly by Item 24 but specifically recommended

---

### ITEM 55 — Code Deletion Ritual with @disabled Markers (LOW)

**Source:** Phase 6 R1 (Ive, Muratori), Phase 6 R2 (D18)

**Ive, Phase 6 R1:** *"Establish code-deletion ritual: disabled features get 30 days; if not re-enabled, archived to branch and deleted."*

**Carmack, Phase 6 R2 (D18):** *"Add a concrete mechanism: a comment marker like // @disabled YYYY-MM-DD reason on any code that gets gated behind a feature flag. A session can grep for these, check dates, and enforce the 30-day rule."*

**Not in the 32 action items.** A process recommendation, not a code fix.

**Effort:** 30 min to document the process
**Priority:** LOW — prevents future dead code accumulation

---

### ITEM 56 — Toon Shader Gate 8 Test (LOW)

**Source:** Phase 6 R1 (all), Phase 6 R2 (D16)

**Phase 6 R2 (D16):** *"Don't test 'does toon shading look good?' — test 'can I tell a heavy from a light at 300m with vs without?'"*

**ryg, Phase 6 R2:** *"The GPU cost is one full-screen post-process pass. On low-end hardware — which the project explicitly targets — that's 2-4ms at 1080p... 12-24% of the frame budget on a feature that's never been Gate 8 tested."*

**Not in the 32 action items (just a finding recommendation).**

**Effort:** 1 hour to set up the test
**Priority:** LOW — toon shader is already shipping; test determines if it should keep shipping

---

### ITEM 57 — Characters.js frustumCulled = false (LOW)

**Source:** Phase 3a R1 (B4, ryg)

**ryg, Phase 3a R1 (B4):** *"With 64 players on a large map, most are off-screen at any time. You're paying full vertex processing + skinning cost for invisible characters."*

**Panel consensus:** *"Set frustumCulled = true (accept rare pop-in over GPU waste)"*

**Not in the 32 action items.**

**Effort:** 5 min
**Priority:** LOW — currently only local player renders; matters when remote players enabled

---

### ITEM 58 — Characters.js Dead Code Cleanup (LOW)

**Source:** Phase 3a R1 (B10, B11)

**Cartographer, Phase 3a R1:** *"_modelScale declared, never used. _demo, _spawnDemo, _updateDemo, flame/ski null assignments — ~70 lines dead code. Vestigial from the lesson-learned incident (ski board at 30m)."*

**Panel consensus (P0):** *"Remove all dead code (_demo, _spawnDemo, _updateDemo, _modelScale, null flame/ski assignments) — ~80 lines, 27% of file"*

**Not in the 32 action items. Was called P0 by the panel but never executed.**

**Effort:** 15 min
**Priority:** LOW — dead code, not a bug

---

### ITEM 59 — Characters.js init() Double-Call Guard (LOW)

**Source:** Phase 3a R1 (B5)

**Saboteur, Phase 3a R1 (B5):** *"init() has no double-call guard. _gltf gets overwritten, existing instances in _chars[] hold references to the old GLTF's animations. Mixers break silently."*

**Recommendation:** *"Add: if (_loaded || _loading) return; _loading = true;"*

**Not in the 32 action items.**

**Effort:** 5 min
**Priority:** LOW

---

### ITEM 60 — Characters.js Refactor sync() Signature (LOW)

**Source:** Phase 3a R1 (Muratori)

**Muratori, Phase 3a R1:** *"Refactor sync() signature: sync(t, players, opts) with explicit parameters for is3P, getGroundY, terrainSampleFn."*

*"Remove global reads. Pass everything through sync() and you have a clean, testable module."*

**Not in the 32 action items.**

**Effort:** 1 hour
**Priority:** LOW — improves testability

---

### ITEM 61 — HEAPF32 Buffer Assertion (LOW)

**Source:** Phase 2a R1 (Barrett), Phase 2b R1 (A-1)

**Barrett, Phase 2a R1:** *"Add a runtime assertion. At the top of the JS game loop, check HEAPF32.buffer === wasmMemory.buffer."*

**Not in the 32 action items.** WASM memory growth is currently disabled, but if anyone enables it, this assertion catches the break immediately.

**Effort:** 5 min
**Priority:** LOW — defensive guard

---

### ITEM 62 — Document Fixed-Memory WASM Invariant (LOW)

**Source:** Phase 2a R1 (Acton)

**Acton, Phase 2a R1:** *"Document the invariant. Put a comment in the build config, in the bridge code, and in the @ai-contract block: 'This build assumes fixed memory.'"*

**Not in the 32 action items.** Covered partially by @ai-contract blocks (Item 34) but specifically called out.

**Effort:** 5 min
**Priority:** LOW

---

### ITEM 63 — Combat FX: Team-Colored Tracers (LOW)

**Source:** Phase 4 R1+R2 (Ive)

**Ive, Phase 4 R2:** *"Tracer color = tribe color. That's free information density."*

**Not in the 32 action items.**

**Effort:** 30 min
**Priority:** LOW — visual polish, not a bug

---

### ITEM 64 — Combat FX: Per-Weapon Muzzle Flash Variants (LOW)

**Source:** Phase 4 R1 (Cartographer)

**Cartographer, Phase 4 R1:** *"No multi-weapon support — identical flash for disc launcher, mortar, chaingun. A mortar should have a bigger flash."*

**Not in the 32 action items.**

**Effort:** 1 hour
**Priority:** LOW — visual polish

---

### ITEM 65 — Sky: Quality Tier Fallbacks (LOW)

**Source:** Phase 4 R1+R2 (Carmack, ryg)

**Carmack, Phase 4 R2:** *"Cloud noise (3 octaves simplex) expensive on mobile/integrated GPUs — needs quality tier."*

**Consensus:** *"Low: dome only. Med: dome+clouds 1 octave. High: all 3 octaves."*

**Not in the 32 action items.**

**Effort:** 1 hour
**Priority:** LOW — performance on low-end GPUs

---

### ITEM 66 — Sky: Frame-Rate-Independent Star Fade (LOW)

**Source:** Phase 4 R1+R2 (ryg), listed as finding LOW-07

**ryg, Phase 4 R2:** *"At 60fps, each frame applies *= 0.95. After 1 second (60 frames): 0.95^60 = 0.046. At 30fps, after 1 second (30 frames): 0.95^30 = 0.215. The fix is const k = 1 - Math.exp(-dt / tau)."*

**Listed in findings (LOW-07) but NOT in the 32 action items.**

**Effort:** 5 min
**Priority:** LOW

---

### ITEM 67 — Sky: Modulo uTime to Prevent Float Precision Loss (LOW)

**Source:** Phase 4 R1+R2 (ryg)

**ryg, Phase 4 R2:** *"Float32 mantissa is 23 bits. Cloud pattern would start showing subtle quantization artifacts after about 100 hours."*

**Not in the 32 action items.**

**Effort:** 5 min
**Priority:** LOW

---

### ITEM 68 — Command Map: Cache Terrain Bitmap (LOW)

**Source:** Phase 4 R1+R2 (Barrett, ryg)

**Barrett, Phase 4 R2:** *"Cache terrain hillshade as ImageBitmap on map load, not on resize."*

**ryg, Phase 4 R2:** *"_onResize() sets STATE.terrainCanvas = null. The next frame does a FULL per-pixel heightmap render... On window resize drag, this fires on EVERY resize event."*

**Not in the 32 action items.**

**Effort:** 30 min
**Priority:** LOW — performance during resize

---

### ITEM 69 — Command Map: Remove Hardcoded Map Name (LOW)

**Source:** Phase 4 R1 (Cartographer)

**Cartographer, Phase 4 R1:** *"'TACTICAL OVERVIEW — RAINDANCE' hardcoded map name."*

**Not in the 32 action items.**

**Effort:** 5 min
**Priority:** LOW — blocks multi-map support

---

### ITEM 70 — Audio: Blaster Sound Missing (LOW)

**Source:** Phase 4 R1+R2 (Saboteur, Barrett)

**Barrett, Phase 4 R2:** *"case 0 is not in the switch, so weapon index 0 (blaster) hits the default case. That's wrong — blaster should have its own sound."*

**Not in the 32 action items.**

**Effort:** 15 min
**Priority:** LOW

---

### ITEM 71 — Audio: isReady() Lies About Suspended Context (LOW)

**Source:** Phase 4 R1+R2 (Wiring Inspector, Muratori)

**Wiring Inspector, Phase 4 R1:** *"isReady() returns true even when AudioContext is 'suspended'."*

**Muratori, Phase 4 R2:** *"Returns true even if ctx.state === 'suspended'. But... no current code uses isReady() as a gate."*

**Not in the 32 action items.**

**Effort:** 5 min
**Priority:** LOW — no current consumer

---

### ITEM 72 — Dead _playFlagSting Code (LOW)

**Source:** Phase 3b R1 (S-5)

**Saboteur, Phase 3b R1 (S-5):** *"return; as its first statement... 34 lines of dead code."*

**The Item 16 fix (thunder audio) patched this function's audio references but DID NOT delete it.** The dead code still exists with `return;` as the first line.

**Not in the 32 action items.**

**Effort:** 5 min
**Priority:** LOW

---

### ITEM 73 — Lightning setTimeout Fires After Module Disabled (LOW)

**Source:** Phase 3b R1 (S-3)

**Saboteur, Phase 3b R1 (S-3):** *"These setTimeout callbacks still fire... Neither checks _enabled before executing."*

**Not in the 32 action items.**

**Effort:** 5 min
**Priority:** LOW

---

### ITEM 74 — DOM Overlays: Z-Index Registry (LOW)

**Source:** Phase 3b R1 (Ive)

**Ive, Phase 3b R1 (ive-2):** *"Seven DOM elements with hardcoded z-indices in the 9986-9991 range... There's no z-index registry, no HUD layer system, no documented stacking order."*

**Not in the 32 action items.**

**Effort:** 30 min
**Priority:** LOW

---

### ITEM 75 — Rename tribes.js to generated/emscripten_glue.js (LOW)

**Source:** Phase 6 R1 (all unanimous), Phase 6 R2 (D5)

**Carmack, Phase 6 R1:** *"This is the single highest-impact naming fix in the entire codebase. It eliminates 6,868 lines of confusion."*

**ryg, Phase 6 R2:** *"Add tribes.js linguist-generated=true so GitHub stats and diffs ignore it. This file represents 34% of the total repo lines."*

**Not in the 32 action items.** The 3 renames in Items 25-27 are small files. The biggest naming fix (tribes.js) was discussed unanimously but not included.

**Effort:** 15 min + .gitattributes
**Priority:** LOW — reduces confusion for any human or AI reader

---


## 2. Partially Addressed Items

These are fixes (Items 1-16) where the cohort review flagged additional concerns that were NOT followed up on.

---

### Item 2 — team_config.js: Three Deferred Concerns

**Concern 1 — Race condition in async script loading (S1, MEDIUM):**
> "team_config.js is loaded via document.head.appendChild() just before minimap/command_map. All three are async classic scripts. There's no guarantee team_config executes first." — Saboteur, Item 2 review

**Status:** Mitigated by existing fallback colors but NOT fixed. Correct fix is either: (a) make team_config.js a blocking script, or (b) have consumers defer init until config loads.

**Concern 2 — Two sources of team colors now exist (S2):**
> "Palette already has teamColor() / teamColorInt() helpers on window.PaletteUtils. Now we also have window.TEAM_CONFIG with similar helpers. Two sources of team colors exist." — Saboteur, Item 2 review

**Status:** Documented but NOT resolved. Palette unification deferred to "Tier 2 nice-to-have."

**Concern 3 — renderer.js TEAM_COLORS not migrated (W2):**
> "The renderer.js TEAM_COLORS array (line 62: [0xC8302C, 0x2C5AC8, 0x808080]) is NOT yet updated to reference team_config. It's still hardcoded." — Wiring Inspector, Item 2 review

**Status:** Explicitly deferred to "Tier 2 extraction phase." Still hardcoded.

---

### Item 10 — Terrain Collision Groups: Two Monitoring Concerns

**Concern 1 — Grounding flag correctness (S1, MEDIUM):**
> "computedGrounded() after excluding terrain may always return false when standing on terrain." — Saboteur, Item 10 review

**Status:** Accepted as safe ("terrain grounding is WASM's job") but flagged for monitoring. No monitoring was implemented.

**Concern 2 — Multi-player capsule collision disabled (S2):**
> "Player filter 0xFFFC excludes groups 0 and 1... if more player capsules were added, they wouldn't collide with each other." — Saboteur, Item 10 review

**Status:** Accepted as non-issue for current single-player CC but flagged for future. No documentation was added.

---

### Item 14 — CRITICAL SCOPE DISCREPANCY

**The FINAL-REPORT says:** *"Delete disabled systems in renderer.js (rain, grass ring, dust, jet exhaust) ~390 lines"*

**The Item 14 fix review found:** *"Report listed rain (~100), grass ring (~290), and dust layer (~265) as disabled. Verified against code: all three have LIVE init() and update() calls. Only jet exhaust was truly dead."*

**What was actually deleted:** ~140 lines of jet exhaust code only.

**What WASN'T deleted because it's LIVE code:**
- Rain system (~100 lines) — `initRain()` and `updateRain()` have live call paths
- Grass ring (~290 lines) — quality-tier-gated, allocates 213MB GPU on ultra
- Dust layer (~265 lines) — has live `initDustLayer()` and update calls

**Impact:** The FINAL-REPORT's Item 14 description is partially wrong. The remaining ~250+ lines of rain/grass/dust are NOT dead code. The grass ring's 213MB allocation IS gated by quality tier (Phase 6 R2 corrected this: "The grass ring IS quality-tier-gated — it doesn't burn 213MB on low-end hardware"). Rain init DOES allocate unconditionally though (Carmack, Phase 6 R2: "The rain init does allocate unconditionally").

**Remaining concern:** Rain system allocates unconditionally even when disabled. Should defer allocation until rain is actually enabled.

---

### Item 9 — Dispose Composer: Brief NPE Window

**Concern — Debug globals briefly point at disposed objects (S2):**
> "window.__tribesBloom and window.__tribesComposer are reassigned at the end of initPostProcessing() after re-creation. During the brief synchronous gap they point at disposed objects." — Saboteur, Item 9 review

**Status:** Noted as fragile but safe (synchronous). Not fixed.

---

### Item 15 — ZoomFX RAF: Context Menu Still Globally Suppressed

**Item 15 fixed the unconditional RAF loop.** But the LOW-09 finding — *"Context menu globally suppressed by ZoomFX"* — was NOT addressed in Item 15 or any other item.

**What remains:** `window.addEventListener('contextmenu', e => e.preventDefault(), true)` with `capture: true` on window still suppresses right-click everywhere.

---

### Item 16 — Thunder Audio: Dead _playFlagSting Updated but Not Deleted

The Item 16 fix updated the dead `_playFlagSting()` function's audio references to use `window.AE.ctx` instead of `_audioCtx`. But the function still has `return;` as its first statement — it's still dead code. The fix made dead code more correct without deleting it.

---

## 3. Process Gaps

Things the established process (audit-plan.md, feature-gates.md) REQUIRES but that were NOT enforced during the implementation of Items 1-16.

---

### 3.1 Gate 5 — Test Harnesses (CRITICAL)

**Requirement (feature-gates.md):**
> "Gate 5 — ISOLATE: Build or update a test harness. Visual systems: Standalone HTML page following test/buildings_test.html template."

**Requirement (audit-plan.md):**
> "T1 and T2 modules have isolated test harnesses" (success criterion)

**Requirement (Phase 1 R1, Carmack):**
> "We need standalone test harnesses for: terrain, sky/DayNight, particles, camera/spectator, and lighting."

**Reality:** 16 items were implemented and committed. ZERO test harnesses were created. Only `test/buildings_test.html` exists (pre-dating the audit). Gate 5 was skipped for every single fix.

---

### 3.2 Gate 6 — Integration Test Page (MEDIUM)

**Requirement (feature-gates.md):**
> "Gate 6 — INTEGRATE: Run test/integration_full_frame.html — verify nothing broke. Measure frame time before and after."

**Reality:** `test/integration_full_frame.html` does not exist. No integration verification was performed.

---

### 3.3 Pre-Commit Checklist (MEDIUM)

**Requirement (feature-gates.md):**
> - Cache bust updated in renderer.js import?
> - No new window.* globals? (or documented in @ai-contract EXPOSES)
> - @ai-contract block present and accurate?
> - lessons-learned.md consulted?

**Reality:** The pre-commit checklist was not formally applied to any of the 16 committed items. Specifically:
- @ai-contract blocks: Zero created (Item 34)
- lessons-learned.md: Not updated with audit findings (Item 37)
- Cache busts: Not verified systematically

---

### 3.4 Gate 7 — Review Scaling (LOW)

**Requirement (feature-gates.md):**
> "Small (<100 lines): Pass 1 + Pass 4. Medium (100-500): Pass 1 + Pass 4 + Pass 5. Large (>500): Full 6-pass review."

**Reality:** Per-fix cohort reviews WERE performed (15 review logs exist), which exceeds Gate 7's minimum. This requirement was met, and the review logs are comprehensive.

---

### 3.5 Audit Plan Deliverables (MEDIUM)

Several deliverables specified in `audit-plan.md` were either not created or are incomplete:

| Deliverable | Status |
|---|---|
| `@ai-contract` blocks in every source file | ❌ Zero created |
| Test harnesses for T1/T2 modules | ❌ Zero created |
| `test/integration_full_frame.html` | ❌ Does not exist |
| `docs/system-map.md` | ✅ Created |
| `docs/patterns.md` | ⚠️ Missing 3 patterns |
| `docs/refactoring-plan.md` | ✅ Created |
| `docs/design-intent.md` | ✅ Created |
| `docs/ai-rules.md` | ✅ Created |
| `docs/lessons-learned.md` | ⚠️ Not updated with audit findings |
| Window.* globals categorized | ⚠️ Done in audit logs, not in source |

---

## 4. Master TODO

Complete, prioritized list of EVERYTHING that remains — both from the original 32 items not yet done AND all newly discovered gaps.

### Status of Original 32 Items

| # | Description | Status |
|---|---|---|
| 1 | Create `client/player_state.js` | ✅ DONE (R32.154) |
| 2 | Create `client/team_config.js` | ✅ DONE (R32.155) |
| 3 | Kill `renderer_cohesion.js` | ✅ DONE (R32.156) |
| 4 | Fix network.js start() idempotency | ✅ DONE (R32.157) |
| 5 | Fix ping measurement | ✅ DONE (R32.157) |
| 6 | Fix renderer_polish.js telemetry offsets | ✅ DONE (R32.158) |
| 7 | Share 1 SphereGeometry for projectiles | ✅ DONE (R32.159) |
| 8 | Add disposeBuildings() to loadMap() | ✅ DONE (R32.160) |
| 9 | Dispose old EffectComposer in applyQuality() | ✅ DONE (R32.161) |
| 10 | Rapier: terrain collision group exclusion | ✅ DONE (R32.162) |
| 11 | Rapier: velocity-based CC inputs | ✅ DONE (R32.163) |
| 12 | Rapier: ceiling velocity correction | ✅ DONE (R32.164) |
| 13 | Rapier: disable snap-to-ground | ✅ DONE (R32.165) |
| 14 | Delete disabled systems (jet exhaust only — rain/grass/dust are LIVE) | ⚠️ PARTIAL — only 140 of claimed 390 lines deleted |
| 15 | Integrate ZoomFX into main render loop | ✅ DONE (R32.167) |
| 16 | Route thunder through main audio context | ✅ DONE (R32.168) |
| 17 | Extract renderer_daynight.js | 🔄 IN PROGRESS |
| 18 | Extract renderer_postprocess.js | ❌ NOT STARTED |
| 19 | Unify particle systems 1-4 into renderer_particles.js | ❌ NOT STARTED |
| 20 | Extract renderer_weather.js from renderer_polish.js | ❌ NOT STARTED |
| 21 | Extract renderer_terrain.js | ❌ NOT STARTED |
| 22 | Extract renderer_interiors.js | ❌ NOT STARTED |
| 23 | Extract renderer_camera.js | ❌ NOT STARTED |
| 24 | IIFE→ES migration (8 modules) | ❌ NOT STARTED |
| 25 | Rename renderer_sky_custom.js → renderer_sky.js | 🔄 IN PROGRESS |
| 26 | Rename client/tiers.js → client/skill_rating.js | 🔄 IN PROGRESS |
| 27 | Rename client/quant.js → client/quantization.js | 🔄 IN PROGRESS |
| 28 | Add collider lifecycle management | 🔄 IN PROGRESS |
| 29 | Pin Three.js version in import map | ✅ DONE (R32.169) |
| 30 | Complete index.html audit | ❌ NOT STARTED |
| 31 | Add entity interpolation for remote players | ❌ NOT STARTED |
| 32 | Decompose remaining renderer_polish.js | ❌ NOT STARTED |

### Complete Prioritized TODO

#### PRIORITY 0 — Process Compliance (Do Before Any More Code)

| # | Task | Source | Effort | Notes |
|---|---|---|---|---|
| **33** | Create visual test harnesses for all T1/T2 modules | Gate 5, Carmack Phase 1 R1 | 2-4 hrs per harness | CRITICAL — every future fix must have one |
| **34** | Add @ai-contract blocks to all ~27 source files | Gate 5, audit-plan.md | 8-12 hrs total | CRITICAL — audit knowledge delivery mechanism |

#### PRIORITY 1 — Active Bugs Not in Original 32

| # | Task | Source | Effort | Notes |
|---|---|---|---|---|
| **35** | Remove remote player visibility hack (line 3792) | Phase 1 R1 Muratori, Phase 5 | 5 min | Prerequisite for multiplayer |
| **40** | Fix DayNight freeze/unfreeze API (closure vs property) | Phase 1 R2 (REN-02) | 15 min | Active bug — external control broken |
| **41** | Fix Module._restartGame phantom export | Phase 2a R2 (NET-05) | 30 min | Restart button silently broken |
| **42** | Fix updateAudio 4-vs-5 params (skiing sound dropped) | Phase 2a R2 (NET-06) | 15 min | Skiing has no sound — Core Feeling gap |
| **43** | Fix flag Z hardcoded to 0 in wire decode | Phase 3c R1 (NET-07) | 30 min | Flags at wrong horizontal position |

#### PRIORITY 2 — Original Items Still In Progress/Not Started

| # | Task | Source | Effort | Notes |
|---|---|---|---|---|
| 14 | Correct Item 14 scope — defer rain alloc until enabled | Item 14 fix review | 15 min | Rain allocates unconditionally |
| 17 | Extract renderer_daynight.js | FINAL-REPORT | 1 session | 🔄 IN PROGRESS |
| 18 | Extract renderer_postprocess.js | FINAL-REPORT | 1 session | |
| 19 | Unify particle systems 1-4 | FINAL-REPORT | 1-2 sessions | |
| 20 | Extract renderer_weather.js from polish | FINAL-REPORT | 1 session | Gates phase system |
| 25-27 | File renames (sky, tiers, quant) | FINAL-REPORT | 15 min | 🔄 IN PROGRESS |
| 28 | Collider lifecycle management | FINAL-REPORT | 1 session | 🔄 IN PROGRESS |

#### PRIORITY 3 — Architecture & Feature Gaps

| # | Task | Source | Effort | Notes |
|---|---|---|---|---|
| **36** | Define phase system hooks (onPhaseChange) | Phase 1 R1 C2, Phase 3b R1, Ive | 2-3 hrs | #1 Core Feeling gap (Adaptation) |
| **45** | Migrate all team color refs to team_config.js | Phase 4 R2 PAL-01 | 2 hrs | 5 different reds in codebase |
| **46** | Pool shockwave geometry (cap at 8-16) | Phase 3b R1 S-1, ryg | 1 hr | Unbounded draw calls |
| 21 | Extract renderer_terrain.js | FINAL-REPORT | 2 sessions | Highest-risk extraction |
| 22 | Extract renderer_interiors.js | FINAL-REPORT | 2 sessions | |
| 23 | Extract renderer_camera.js | FINAL-REPORT | 1-2 sessions | |
| 24 | IIFE→ES migration | FINAL-REPORT | 4-5 sessions | |
| 30 | Complete index.html audit | FINAL-REPORT | 2-3 sessions | ~2,000 lines unreviewed |
| 31 | Entity interpolation for remote players | FINAL-REPORT | 3-5 sessions | Biggest gameplay gap |
| 32 | Decompose remaining polish.js | FINAL-REPORT | 2-3 sessions | |

#### PRIORITY 4 — Medium-Priority Gaps

| # | Task | Source | Effort | Notes |
|---|---|---|---|---|
| **37** | Update lessons-learned.md with 10+ audit entries | Phase 5 R1, audit-plan.md | 1 hr | Process deliverable |
| **38** | Add 3 missing patterns to patterns.md | Phase 5 R1 | 30 min | |
| **39** | Complete system-map.md index.html section | Phase 5 R1 | 1 hr | |
| **44** | Add capsule resize for armor type change | Phase 2b R2 (PHY-06) | 30 min | |
| **47** | Add removeGeneratorChimney() callback | Phase 3b R1 C-2 | 30 min | |
| **48** | Implement connection state machine | Phase 3c R1 C-1 | 2 hrs | |
| **49** | Add wire format version field | Phase 3c R1 CM-4 | 30 min | |
| **50** | Add input redundancy (3-5 inputs per packet) | Phase 3c R1 GF-3 | 2 hrs | |
| **51** | Decouple input send rate (60Hz → 30Hz send) | Phase 3c R1 GF-2 | 1 hr | |
| **52** | Add sequence numbers to snapshots | Phase 3c R1 C-3 | 1 hr | |

#### PRIORITY 5 — Low-Priority Gaps

| # | Task | Source | Effort | Notes |
|---|---|---|---|---|
| **53** | Jitter buffer for snapshot smoothing | Phase 3c R1 GF-4 | 3 hrs | Matters with entity interp |
| **54** | Migrate voice globals to voice.js | Phase 3c R1 W-5 | 30 min | -10 globals |
| **55** | Establish code deletion ritual (@disabled markers) | Phase 6 R1 Ive, Muratori | 30 min | Process |
| **56** | Gate 8 test for toon shader (300m readability) | Phase 6 R1+R2 | 1 hr | |
| **57** | Set frustumCulled = true on characters | Phase 3a R1 ryg | 5 min | |
| **58** | Delete characters.js dead code (~80 lines) | Phase 3a R1 | 15 min | |
| **59** | Add init() double-call guard to characters.js | Phase 3a R1 B5 | 5 min | |
| **60** | Refactor characters.js sync() to accept params | Phase 3a R1 Muratori | 1 hr | |
| **61** | Add HEAPF32.buffer === wasmMemory.buffer assertion | Phase 2a R1 Barrett | 5 min | |
| **62** | Document fixed-memory WASM invariant in code | Phase 2a R1 Acton | 5 min | |
| **63** | Team-colored tracers | Phase 4 R2 Ive | 30 min | |
| **64** | Per-weapon muzzle flash variants | Phase 4 R1 | 1 hr | |
| **65** | Sky quality tier fallbacks (Low/Med/High) | Phase 4 R2 Carmack | 1 hr | |
| **66** | Frame-rate-independent star fade | Phase 4 R2 LOW-07 | 5 min | |
| **67** | Modulo uTime in sky shader | Phase 4 R2 ryg | 5 min | |
| **68** | Cache terrain bitmap in command map | Phase 4 R2 Barrett | 30 min | |
| **69** | Remove hardcoded "RAINDANCE" map name from command map | Phase 4 R1 | 5 min | |
| **70** | Add blaster sound (weapon index 0) | Phase 4 R2 Barrett | 15 min | |
| **71** | Fix isReady() to check AudioContext state | Phase 4 R1 | 5 min | |
| **72** | Delete dead _playFlagSting code | Phase 3b R1 S-5 | 5 min | |
| **73** | Guard lightning setTimeout with _enabled check | Phase 3b R1 S-3 | 5 min | |
| **74** | Create z-index registry for DOM overlays | Phase 3b R1 Ive | 30 min | |
| **75** | Rename tribes.js → generated/emscripten_glue.js | Phase 6 R1+R2 unanimous | 15 min | |

---

## Summary Statistics

| Category | Count |
|---|---|
| Original 32 action items DONE | 15 (Items 1-13, 15-16) |
| Original 32 items PARTIAL | 1 (Item 14 — scope was wrong) |
| Original 32 items IN PROGRESS | 5 (Items 17, 25-28) |
| Original 32 items NOT STARTED | 10 (Items 18-24, 30-32) |
| **New gap items discovered (33-75)** | **43** |
| Total remaining work items | **53** (10 original not started + 1 partial + 5 in-progress + 43 new - 6 done from context = adjusted) |
| Process violations found | 4 (Gate 5 harnesses, Gate 6 integration test, @ai-contract blocks, lessons-learned) |
| Active bugs with no action item | 5 (Items 35, 40-43) |
| Findings in FINAL-REPORT with no action item | 10 (REN-02, NET-05, NET-06, NET-07, PHY-06, PAL-01, CHR-01, LOW-02, LOW-03, LOW-06-09) |

---

> *"The audit produced the knowledge. The 32 items captured the obvious. This gap analysis captures everything else."*
