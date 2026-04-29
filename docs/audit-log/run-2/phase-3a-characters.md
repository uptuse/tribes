# Phase 3a — renderer_characters.js — Adversarial Convergence Review (Run 2)

*Run 2 | Validation Pass | 294 lines | File: `renderer_characters.js`*
*Panel: ryg (GPU/draw calls), Carmack (engine architecture/perf), Muratori (simplicity/data flow), Ive (design coherence)*
*Run 1 Reference: `docs/audit-log/run-1/phase-3a-characters.md`*

---

## Mission: Validate, Challenge, and Deepen Run 1

Run 1 identified 11 issues (1 critical, 2 high, 4 medium, 2 low, 2 trivial) and recommended a Map-based instance store, dead code removal, and sync() refactoring. Run 2 verifies each claim against source, cross-references stride offsets with renderer.js and renderer_polish.js, and evaluates 64-player and phase-system readiness.

---

## Cross-Module Stride Verification (NEW for Run 2)

**This is the definitive playerView offset map**, derived from renderer.js source (lines 3752–3867, 4081–4094) and the WASM bridge in index.html (line 4350):

| Offset | Field | Verified By | Used In |
|--------|-------|-------------|---------|
| `o+0` | posX | renderer.js L3801, L4082, L4616; characters.js L202 | All three modules |
| `o+1` | posY | renderer.js L3801, L4082; characters.js L203 | All three modules |
| `o+2` | posZ | renderer.js L3801, L4082, L4616; characters.js L204 | All three modules |
| `o+3` | pitch (rotX) | renderer.js L3808 (`rawPitch`); index.html L4360 (`rot[0]`) | renderer.js, prediction (via index.html) |
| `o+4` | yaw (rotY) | renderer.js L3803, L4084; characters.js L206, L235 | renderer.js, characters.js, **polish.js L1015 (BUG: reads as velX)** |
| `o+5` | roll (rotZ) | index.html L4360 (`rot[2]`); **polish.js L1016 (BUG: reads as velY)** | prediction (via index.html), **polish.js (BUG)** |
| `o+6` | velX | renderer.js L3856 (passed to animatePlayer as `vx`); characters.js L208 | renderer.js, characters.js, **polish.js L1017 (BUG: reads as velZ)** |
| `o+7` | velY | *(inferred — between velX at 6 and velZ at 8)* | Not directly read in JS |
| `o+8` | velZ | renderer.js L3856 (passed to animatePlayer as `vz`); characters.js L208 | renderer.js, characters.js |
| `o+9` – `o+10` | *(reserved/unknown)* | Not referenced in JS | — |
| `o+11` | team | renderer.js L3754 | renderer.js |
| `o+12` | armor | renderer.js L3755 | renderer.js |
| `o+13` | alive (>0.5) | renderer.js L3753, L4094; characters.js L188 | renderer.js, characters.js |
| `o+14` | jetting (>0.5) | renderer.js L3855; characters.js L209 | renderer.js, characters.js |
| `o+15` | skiing (>0.5) | renderer.js L3857; characters.js L210 | renderer.js, characters.js |
| `o+16` – `o+17` | *(reserved/unknown)* | Not referenced in JS | — |
| `o+18` | visible (>0.5) | renderer.js L3752; characters.js L189 | renderer.js, characters.js |
| `o+19` | *(reserved)* | Not referenced in JS | — |
| `o+20` | spawnProt | renderer.js L3765 (reserved[0] from R15 RenderPlayer) | renderer.js |

**Key finding:** renderer_characters.js offsets are **consistent** with renderer.js. Both use o+0/1/2 for position, o+4 for yaw, o+6/8 for velX/velZ, o+13 for alive, o+14 for jetting, o+15 for skiing, o+18 for visible. **No stride mismatch** between these two modules.

**renderer_polish.js (telemetry)** uses o+4/5/6 for velocity — **CONFIRMED BUG** (see phase-3b). The actual velocity offsets are o+6/7/8.

---

## Run 1 Finding Validation

### B1: `_chars` Array Sized 16 (Run 1: CRITICAL)

**Source:** Line 15: `const _chars = new Array(16).fill(null);`

**Run 1 claim:** "If localIdx ≥ 16, array access returns undefined, `_createInstance()` called every frame, 60 clones/sec, memory explodes."

**Run 2 verification:** ✅ **VALIDATED**, but with nuance.

> **Carmack:** I verified the claim. Line 141: `if (!_chars[localIdx])` — accessing an Array index beyond its initialized length returns `undefined`, which is falsy. So yes, for localIdx ≥ 16, `_createInstance()` fires every frame and the result is stored at `_chars[localIdx]` — which *does* work in JavaScript because Arrays are sparse. After the first frame, `_chars[localIdx]` would be truthy and the clone loop would NOT repeat.
>
> **Muratori:** Wait — that's a correction. Run 1 said "infinite clone loop (60 clones/sec)." JavaScript arrays are dynamic — `_chars[20] = someValue` works fine even if the array was initialized with 16 elements. The first frame creates the instance, stores it at the sparse index, and subsequent frames find it there. There's no infinite loop.
>
> **Carmack:** Correct. The *actual* risk is different: with 64 players, `_chars` becomes a sparse array with gaps (indices 0-15 are null-initialized, 16-63 are dynamically added). Array.fill(null) sized to 16 provides no protection and gives a false sense of bounded capacity, but it won't crash. It's misleading, not catastrophic.
>
> **ryg:** However, this module currently only syncs `localIdx` (one player). The array is never written at any index other than the local player's. The 64-player concern only activates when remote player rendering is added. Right now, localIdx is always a small number (0-15 in current lobbies). The immediate risk is LOW, not CRITICAL.

**Run 2 severity adjustment:** Run 1 CRITICAL → **Run 2: MEDIUM.** JavaScript sparse arrays prevent the infinite clone scenario. The real bug is conceptual: the array size implies a 16-player cap that doesn't actually enforce anything. Using a Map (Run 1's recommendation) remains correct, but urgency is lower.

---

### B2: playerView Offsets Are Magic Numbers (Run 1: HIGH)

**Run 2 verification:** ✅ **VALIDATED.** Cross-module stride map above confirms offsets are duplicated across renderer.js, renderer_characters.js, and renderer_polish.js with no shared constants. renderer_polish.js has an active bug from this exact problem (o+4/5/6 vs o+6/7/8).

> **Muratori:** The fact that renderer_characters.js happens to use the *correct* offsets doesn't reduce the severity. It's correct by accident — nobody verified these against a shared spec. The stride is set by WASM (`Module._getPlayerStateStride()`), and the layout is set by C++ struct packing. If the C++ struct changes, every JS consumer breaks silently.
>
> **Carmack:** This is worse than Run 1 described. Run 1 said "magic numbers duplicated between this file and renderer.js." Run 2 finds they're duplicated across *three* JS files, plus the WASM reconciliation bridge in index.html (which reads rot as [view[3], view[4], view[5]]). Four independent offset assumptions, zero shared constants.

**Run 2 severity:** Remains **HIGH**. Run 1 recommendation for `player_layout.js` shared constants is endorsed and should include ALL offsets documented in the stride map above.

---

### B3: `window._rapierGrounded` Is Global, Not Per-Player (Run 1: HIGH)

**Source:** Line 121: `if (window._rapierGrounded) { return playerY; }`

**Run 2 verification:** ✅ **VALIDATED.** This is still a single global boolean. For the current scope (local-player-only 3P), it works. For remote players, it's wrong.

> **Carmack:** Run 1 is correct that this blocks remote player rendering. But since this module doesn't render remote players (and has no architecture to do so), this is a FUTURE blocker, not a current bug. Severity should reflect actual current risk.

**Run 2 severity adjustment:** Run 1 HIGH → **Run 2: MEDIUM** (future blocker, not current bug).

---

### B10/B11: Dead Code (Run 1: TRIVIAL)

**`_modelScale` (line 13):** Declared, never read. ✅ **VALIDATED.** 1 line dead.

**`_demo`, `_spawnDemo`, `_updateDemo` (lines 16-17, 226-293):** `_demo` and `_demoSpawned` declared on lines 16-17. `_spawnDemo()` spans lines 226-249 (24 lines). `_updateDemo()` spans lines 251-293 (43 lines). Neither function is called from `sync()` or any export. ✅ **VALIDATED.** ~69 lines dead.

**`flameL`, `flameR`, `skiBoard` nulls (lines 112-118):** These are declared, set to null, and returned as part of the instance object. Never populated. ✅ **VALIDATED.** ~7 lines vestigial (including comments).

**Run 1 total estimate: "~80 lines."** Actual count: 1 + 2 + 24 + 43 + 7 = **~77 lines.** Close enough. ✅ **VALIDATED.**

> **Ive:** I want to sharpen Run 1's point. The `_updateDemo` function at 43 lines contains a full animation state cycle (run → idle → ski → jet → fire_rifle → idle) with hardcoded movement. This is essentially a test harness that was never removed. The `fire_rifle` clip usage here (line 275) is the *only* evidence that clip exists in the GLB — and it's inside dead code. When someone searches for "fire_rifle" to understand how weapon animations work, they'll find this dead function and think it's the reference implementation. Remove it.

---

### B4: `frustumCulled = false` (Run 1: MEDIUM)

**Source:** Line 93: `child.frustumCulled = false;`

**Run 2 verification:** ✅ **VALIDATED.** Every mesh/skinned mesh in every character instance has frustum culling disabled. Current impact is limited (only one character rendered — the local player in 3P), but this becomes a real GPU problem at 64 characters.

> **ryg:** Run 1's suggestion of "set frustumCulled = true and accept rare pop-in" is the right practical answer. Three.js's bounding box for skinned meshes IS broken (uses bind-pose AABB), but the alternative — computing a manual bounding sphere from the root bone position with a generous radius — is cheap and correct. For Run 2 I'd recommend: keep `frustumCulled = true` as default, and on each `mixer.update()`, manually update the model's bounding sphere center from the root bone world position with a 3m radius. That's one `getWorldPosition()` call per character per frame.

---

### B5: `init()` No Double-Call Guard (Run 1: MEDIUM)

**Source:** Lines 24-64: `init()` calls `loader.load()` with no guard against re-entry.

**Run 2 verification:** ✅ **VALIDATED.** No `_loading` flag. A double call would launch a second async load. When the second load completes, `_gltf` is overwritten. Any existing character instances (in `_chars[]`) hold references to the *first* GLTF's animation clips and scene graph. Their mixers would reference clips from the old GLTF while the clip lookup table in new instances would reference the new GLTF. Mixed state — silent breakage.

---

### B6: `fire_rifle` Not Wired (Run 1: MEDIUM)

**Source:** Lines 212-217: Animation state machine: `death > jet > ski > speed > idle`. No `fire_rifle` state.

**Run 2 verification:** ✅ **VALIDATED.** The `fire_rifle` clip is only used in dead code (`_updateDemo`, line 275). The live animation state machine has 5 states. Run 1 correctly identified missing states: airborne, weapon fire, flag carry.

---

### Skeleton Cloning Pattern (Run 1 Pattern #11 Claim)

**Run 1 claim:** SkeletonUtils.clone is used and documented as Pattern #11.

**Run 2 verification:** ✅ **VALIDATED.** Line 5: `import { clone as skeletonClone } from 'three/addons/utils/SkeletonUtils.js';` and line 80: `const model = skeletonClone(_gltf.scene);`. This is the correct Three.js pattern for cloning a rigged model with independent skeleton/mixer.

---

### 2-Team Hardcoding (Run 1 didn't flag this for characters.js)

**Run 2 finding:** renderer_characters.js has **NO team-specific code.** There's no team color application, no team-based model selection, no team ID usage at all. The file only reads `playerView[o+13]` (alive), `playerView[o+14]` (jetting), `playerView[o+15]` (skiing), `playerView[o+18]` (visible). Team ID is at `o+11` but is never read.

> **Ive:** This is a design gap, not a code bug. Every player is rendered as an identical crimson sentinel regardless of team. For a CTF game where team identification is survival-critical, this is a Core Feeling failure for Belonging. Run 1 flagged this as B9 ("material overrides flatten authored GLB values") but the deeper issue is: there's no architecture for per-team visual differentiation at all.

---

## 64-Player Scalability Analysis (NEW for Run 2)

> **ryg:** Let me walk through what 64-player character rendering costs with the current architecture.
>
> 1. **GLTF Clones:** 64 × `skeletonClone()` = 64 full scene graph copies. Each clone creates: ~20 Bone objects, ~5 SkinnedMesh instances (typical humanoid), ~5 cloned Materials. That's ~1,920 Bone + 320 SkinnedMesh + 320 Material instances. The geometry buffers are shared (GPU-side data is reused), so GPU memory is manageable. But the JS object overhead is ~2,560 objects.
>
> 2. **Animation Mixers:** 64 × `THREE.AnimationMixer` running independently. Each mixer on `update(dt)` iterates its active action, which interpolates all tracks (bone positions/rotations). For a typical Mixamo skeleton with ~20 bones and 3 tracks per bone: 64 × 60 = 3,840 track interpolations per frame. At 60fps, that's ~230K interpolations/second. This is measurable — maybe 1-2ms per frame on desktop, more on mobile.
>
> 3. **Draw Calls:** With `frustumCulled = false` and 5 submeshes per model: 64 × 5 = 320 draw calls. On a typical map, maybe 40% of players are on-screen → 128 draw calls after culling (if enabled). Without culling: 320 draw calls just for characters. That's 50-100% of a mobile GPU's frame budget.
>
> 4. **Ground Height Sampling:** Currently `_groundY()` is called once per frame for the local player. With 64 players, it's 64 calls to `window._sampleTerrainH` (bilinear terrain lookup — ~100ns each = ~6.4μs total) plus the Rapier grounded check which is currently a global boolean. Ground sampling is NOT the bottleneck.
>
> **Carmack:** The scaling wall is draw calls and mixer updates. The solution path is:
> - Frustum culling (cuts visible characters to ~30% on a large map)
> - LOD (billboarded sprites beyond 200m, reduced-bone skeleton 50-200m, full detail <50m)
> - Instanced SkinnedMesh (Three.js InstancedSkinnedMesh or custom — requires all characters to share one skeleton configuration)
> - Shared materials with per-instance team color uniforms (eliminates per-clone material copies)
>
> Current architecture supports NONE of these. Each would require significant refactoring. But 16-player matches (4v4) are feasible with the current approach — that's 16 × 5 = 80 draw calls, tolerable.

---

## Phase System Readiness (NEW for Run 2)

> **Ive:** What does renderer_characters.js need for the phase system?
>
> **Carmack:** Very little. Character animation and positioning are phase-independent — players look the same regardless of weather. The only phase hooks that make sense for characters are:
> 1. **Visibility modifiers** — Dense Fog phase could affect character render distance or apply a fog fade-out for distant characters
> 2. **Material adaptation** — frost on armor during blizzard, heat shimmer during lava (but these are shader-level effects that belong in the material system, not the character module)
> 3. **Animation speed modifiers** — characters could move slower in deep snow (but that's physics, not animation)
>
> **Muratori:** Minimal phase hooks needed. This module is phase-agnostic and that's correct — character identity should be constant across phases. Phase effects on characters (fog fadeout, material adaptation) should be applied by the weather/atmosphere system reading character positions, not by the character module knowing about phases.

**Assessment:** renderer_characters.js needs **zero direct phase hooks.** Phase effects on characters (visibility, material adaptation) belong in the weather system acting on character meshes from outside.

---

## New Findings Not in Run 1

### N1: Animation Mixer Action Leak is Worse Than Described (MEDIUM)

> **Muratori:** Run 1's B8 noted that death actions with `clampWhenFinished` accumulate over respawn cycles. I want to be more specific. Every `_playClip()` call creates a NEW action via `inst.mixer.clipAction(clip)` (line 106). Three.js's AnimationMixer *caches* clip actions by clip reference — so calling `clipAction(clip)` twice for the same clip returns the SAME action. The `reset().fadeIn()` pattern reuses the cached action. This means the leak Run 1 described is **less severe than claimed** — actions aren't accumulating, they're being reused via the mixer's internal cache.
>
> However: `fadeOut()` on the previous action (line 107) doesn't *stop* it — it fades to weight 0. The mixer still updates it every frame (at zero weight, doing nothing but burning cycles). Over many clip transitions, the mixer's internal `_actions` array grows. It never shrinks because actions are cached but never explicitly uncached.
>
> **Correction:** The leak is in mixer tick time (iterating zero-weight actions), not in object count.

### N2: `_groundY` Ignores Rapier Ground Height for Building Floors (MEDIUM)

> **Carmack:** The `_rapierGrounded` branch (line 122) returns `playerY` directly when the player is on a building floor. But `playerY` is the *capsule center*, not the foot position. For terrain, the code compensates by subtracting `CAPSULE_OFFSET` (1.8m). For buildings, it returns the raw position — meaning the character model's feet are at `playerY + _footOffset` which is ~1.8m above the actual floor surface. The character floats above building floors by the capsule offset.
>
> Wait — let me re-read. `playerY` when Rapier-grounded IS the floor height (comment at line 119: "Rapier: playerY = floorH, no offset, feet on floor"). So the return of `playerY` is correct if the WASM side already subtracts the capsule offset for Rapier-grounded players. This depends on the WASM implementation, which we can't verify from JS alone. Run 1 flagged this as "Low (works today)." I'll leave it at that.

### N3: `Math.PI` Offset in Character Yaw (NEW)

> **ryg:** Line 206: `char.model.rotation.set(0, -playerView[o + 4] + Math.PI, 0, 'YXZ');`
>
> Compare with renderer.js L3803: `mesh.rotation.set(0, -playerView[o + 4], 0, 'YXZ');`
>
> The character model adds `Math.PI` to the yaw. The capsule mesh doesn't. This means the GLB model faces backward relative to the capsule. The `+ Math.PI` is a correction for the model's bind pose facing direction. This works, but it's an undocumented model-specific constant. If a new character model has a different bind-pose facing direction, this offset will be wrong. It should be stored as a per-model property, not hardcoded.

### N4: No Remote Player Architecture — But Also No Clear Path to One (HIGH)

> **Carmack:** Run 1 correctly notes this module only syncs localIdx. But I want to be explicit about what "adding remote players" actually requires:
>
> 1. The `sync()` function needs to iterate ALL player indices, not just localIdx
> 2. Each remote player needs team data (o+11) to select model/color
> 3. Remote players DON'T have `Module._getThirdPerson()` — they're always visible
> 4. Remote players DON'T use `window._rapierGrounded` — grounding state must come from the network
> 5. Network snapshots provide position at 10Hz — remote characters need *interpolation* between snapshots (this module has no interpolation concept)
> 6. The current `_playClip()` crossfade is frame-rate dependent — remote player clips need network-synced timing
>
> The distance from "current code" to "64-player character rendering" is not a refactor — it's a rewrite. The current code's value is as a working proof-of-concept for the GLTF pipeline and animation system.

---

## Expert Debate

> **Carmack:** Stepping back from the detail — is Run 1's overall assessment correct? That this module is "a working proof-of-concept for local 3P"?
>
> **Muratori:** Yes. The code quality is fine for what it does. The animation system is clean (`_playClip` with crossfade), the grounding logic handles dual physics correctly for the local player, and the GLTF pipeline works. The problems are all about scope: it doesn't do enough.
>
> **ryg:** I agree with Run 1's recommendations with one change: the `_chars` Map refactoring is P2, not P0. JavaScript sparse arrays work fine. The actual P0 is adding the `player_layout.js` shared constants — that's the bug that's already caused real damage (polish telemetry bug).
>
> **Ive:** Run 1's design assessment is spot-on. This module contributes to zero Core Feelings. A single identical model with five animation states tells the player nothing about teams, nothing about loadouts, nothing about state. It's infrastructure, not design. But that's acceptable at this development stage — the pipeline matters more than the content right now.
>
> **Carmack:** One more thing Run 1 missed: the `try { Characters.sync(...) } catch(e) {}` wrapping in renderer.js L5310. If the character module throws, the error is *silently swallowed* to "keep the render loop alive." This is fine as a production safety net but terrible for development — silent failures mean bugs hide. There should be at least a `console.error` in that catch block.

---

## Run 1 Findings: Validated / Challenged / Corrected

| Run 1 # | Finding | Run 1 Sev | Run 2 Verdict | Notes |
|----------|---------|-----------|---------------|-------|
| B1 | `_chars[16]` infinite clone loop | CRITICAL | **CORRECTED → MEDIUM** | JS sparse arrays prevent infinite loop. First frame creates instance, subsequent frames find it. No crash, but misleading sizing. |
| B2 | Magic number stride offsets | HIGH | **VALIDATED** | Cross-module stride map confirms 4+ files share undocumented offsets. Active bug in polish telemetry. |
| B3 | `_rapierGrounded` global, not per-player | HIGH | **VALIDATED → MEDIUM** | Correct finding, but severity is "future blocker" not "current bug" since only local player is synced. |
| B4 | `frustumCulled = false` | MEDIUM | **VALIDATED** | Current impact: 1 character. Future impact at 64: 320 wasted draw calls. |
| B5 | `init()` no double-call guard | MEDIUM | **VALIDATED** | Second async load silently corrupts existing instances. |
| B6 | `fire_rifle` not wired | MEDIUM | **VALIDATED** | Only used in dead demo code. |
| B7 | No cleanup/dispose path | MEDIUM | **VALIDATED** | `_chars` entries are never set to null on disconnect. |
| B8 | Death action leak in mixer | LOW | **CORRECTED** | Three.js mixer caches clipActions by clip reference — no object accumulation. The leak is in mixer tick time (iterating zero-weight cached actions), not object count. Less severe than described. |
| B9 | Material overrides fight authored values | LOW | **VALIDATED** | Lines 96-102 clamp roughness/metalness. Design choice vs bug is debatable. |
| B10 | `_modelScale` dead | TRIVIAL | **VALIDATED** | Line 13, never read. |
| B11 | ~80 lines dead code | TRIVIAL | **VALIDATED** | Actual count: ~77 lines (demo system + vestigial nulls). |

---

## New Findings Not in Run 1

| # | Finding | Severity | Description |
|---|---------|----------|-------------|
| N1 | Mixer action leak less severe | LOW (correction) | clipAction caching means no object accumulation — leak is tick-time waste from zero-weight actions |
| N2 | `Math.PI` yaw offset undocumented | LOW | Model-specific constant hardcoded at L206. Different GLB models may face a different bind-pose direction. |
| N3 | No remote player architecture path | HIGH | Distance from current code to 64-player rendering is a rewrite, not a refactor. Needs interpolation, per-player grounding, team identity. |
| N4 | Silent catch in renderer.js | LOW | `try { Characters.sync(...) } catch(e) {}` at renderer.js L5310 swallows errors silently during development. |
| N5 | Cross-module stride offsets fully mapped | INFO | Definitive 21-field stride map produced (see table above). Confirms renderer.js ↔ characters.js consistency. |
| N6 | 64-player draw call budget: ~320 | HIGH | 64 characters × ~5 submeshes × no culling = 320 draw calls. Mobile GPU budget is ~200 total. |
| N7 | Phase system: zero hooks needed | INFO | Character appearance is phase-agnostic. Phase effects on characters belong in weather/atmosphere system. |

---

## Priority Reassessment (Run 2)

| Priority | Action | Run 1 | Run 2 |
|----------|--------|-------|-------|
| **P0** | Shared `player_layout.js` constants | P1 | **P0** — active bug in polish telemetry proves this is urgent |
| **P1** | Remove dead code (~77 lines) | P0 | **P1** — no functional impact, but 26% code reduction |
| **P1** | Add double-call guard to `init()` | P1 | **P1** — unchanged |
| **P2** | Replace `_chars` Array(16) with Map | P0 | **P2** — sparse arrays prevent crash; Map is cleaner but not urgent |
| **P2** | Enable `frustumCulled = true` + manual bounding sphere | P2 | **P2** — unchanged |
| **P3** | Design multi-model architecture | P3 | **P3** — unchanged |
| **P3** | Remote player rendering architecture | — | **P3** — new finding; requires interpolation, per-player grounding |

---

*Run 2 complete. 11 Run 1 findings validated (2 corrected in severity, 1 corrected in mechanism). 7 new findings added. Core assessment upheld: this module is a working proof-of-concept for local 3P that needs significant architecture work before multiplayer character rendering.*
