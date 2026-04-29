# Phase 3a — renderer_characters.js — Adversarial Convergence Review

*Run 1 | 294 lines | File: `renderer_characters.js`*
*Panel: ryg (GPU/draw calls), Carmack (engine architecture/perf), Muratori (simplicity/data flow), Ive (design coherence)*

---

## Pass 1 — Break It (Saboteur + Wiring Inspector + Cartographer)

### The Saboteur

**Race condition: `init()` async load vs `sync()` calls**

> The `_loaded` flag on line 10 is set inside the `loader.load()` callback (line 25), but `sync()` on line 70 only checks `_loaded`. What happens if `sync()` is called in the same frame that `_loaded` transitions? The `_gltf` reference is assigned on line 24, one line before `_loaded = true` on line 25 — JavaScript is single-threaded so this is fine. But consider: if `init()` is called **twice** (hot reload, dev mistake), we get a second async load racing the first. There's no guard — `_gltf` gets overwritten, existing instances in `_chars[]` hold references to the old GLTF's animations. Mixers break silently. **Severity: Medium.**

**What if `init()` is never called?**

> `sync()` (line 70) checks `_loaded` and returns early. Fine. But `isLoaded()` (line 68) is exported — what does the caller do with `false`? If the caller spins waiting for it, and the GLB fails to load (line 60 error callback just logs), `isLoaded()` returns false forever. No error propagation. No retry. **Severity: Low (current code tolerates it, but a future caller won't know why).**

**`_chars` array hardcoded to 16 (line 15)**

> `const _chars = new Array(16).fill(null);` — but game design specifies 64 players (4×16). If `localIdx` is ever ≥ 16, the array access `_chars[localIdx]` returns `undefined`, and `_createInstance()` is called every frame (the `if (!_chars[localIdx])` check on line 141 is always true for out-of-range). Each call clones the GLTF and adds a new model to the scene. At 60fps, that's 60 SkeletonUtils clones per second. Memory explodes. GPU dies. **Severity: HIGH — silent catastrophic failure when localIdx ≥ 16.**

**Double call to `_playClip` with `death` + `once: true` (line 155)**

> When `alive` is false, `clip = 'death'` is set every frame. `_playClip` early-returns if `inst.activeClip === name` (line 99), so the death animation plays once and holds. Good. But what happens on *respawn*? `alive` goes back to `true`, `clip` changes to `idle` or `run`, `fadeOut` is called on the death action which has `clampWhenFinished = true`. The `reset().fadeIn()` on the new clip should work. But the old death action is never explicitly stopped — it's just faded out. Over many death/respawn cycles, uncleaned actions accumulate in the mixer's internal cache. **Severity: Low (slow leak, only matters in long sessions).**

**`_groundY` fallback when `_rapierGrounded` is undefined (line 121)**

> `window._rapierGrounded` — if the Rapier module hasn't loaded yet or never sets this, it's `undefined`, which is falsy. The code falls through to the terrain sampling path. That's actually correct behavior as a fallback. But: `window._sampleTerrainH` is also checked (line 122) — if THAT's undefined too, the fallback returns `playerY - CAPSULE_OFFSET` (line 123). Early in initialization, before terrain loads, every character is placed 1.8m below whatever WASM says. Characters spawn underground for a few frames. **Severity: Low (transient visual glitch on load).**

### The Wiring Inspector

**`playerView` stride layout — magic offsets everywhere**

> Lines 133-155 use hardcoded offsets into `playerView`:
> - `[o+0]` = posX, `[o+1]` = posY, `[o+2]` = posZ
> - `[o+4]` = yaw (not `o+3`? what's at `o+3`?)
> - `[o+6]` = velX, `[o+8]` = velZ (not `o+7`? what's at `o+5`, `o+7`?)
> - `[o+13]` = alive, `[o+14]` = jetting, `[o+15]` = skiing, `[o+18]` = visible
>
> These offsets are duplicated between this file and renderer.js. If the stride layout changes in WASM, both files must be updated in lockstep. There's no shared constant or struct definition. A single offset shift breaks everything silently — you get position interpreted as velocity, alive flag reading the wrong byte. **Severity: HIGH (fragile cross-module contract, no validation).**

**`Module._getThirdPerson()` access (line 133)**

> `typeof Module !== 'undefined' && Module._getThirdPerson && Module._getThirdPerson()` — this is defensive but brittle. If the WASM module is loaded but `_getThirdPerson` hasn't been exported yet (partial initialization), `Module` exists but the function doesn't. The `&&` chain handles that. But the deeper issue: this file imports nothing from the WASM bridge. It reaches through `window.Module` directly. There's no contract for what functions must exist. **Severity: Medium (works today, invisible dependency).**

**`playerMeshes[localIdx]` — what is this array?**

> Line 143: `if (playerMeshes[localIdx]) playerMeshes[localIdx].visible = false;` — the caller passes in an array of Three.js meshes for the capsule/primitive player representations. This module hides the primitive when showing the rigged model. But: there's no reciprocal — when `is3P` is false or `visible` is false (line 158), the code hides the rigged model but never re-shows the primitive mesh. That's presumably handled by renderer.js's own logic. But if renderer.js expects this module to manage visibility in both directions, there's a gap. **Severity: Medium (ownership ambiguity).**

### The Cartographer

**Missing states in the animation state machine (lines 148-154)**

> The clip selection is: `death > jet > ski > speed > idle`. Missing states:
> - **Falling** — not jetting, not skiing, airborne. Currently shows `idle` while plummeting. Tribes players spend significant time in the air.
> - **Landing** — no impact animation
> - **Weapon fire** — `fire_rifle` clip exists (used in `_updateDemo` line 224) but never triggered from live gameplay
> - **Damage taken / flinch** — no reaction animation
> - **Flag carry** — key gameplay state with no visual distinction
>
> The `_updateDemo` function (line 197) references `fire_rifle`, proving the clip exists in the GLB. It's just not wired into the live state machine. **Severity: Medium (missing gameplay-critical visual feedback).**

**Single model, single tribe (line 22)**

> `loader.load('./assets/models/crimson_sentinel_rigged.glb', ...)` — hardcoded to one model file. Four tribes need visual distinction. Currently, every player looks identical. No tribe color differentiation, no armor tier differentiation (light/medium/heavy). The material override in `_createInstance()` (lines 86-92) sets universal PBR values — there's no per-tribe color or per-armor scale. **Severity: HIGH for shipping, acceptable for current dev stage.**

**Dead code inventory:**
- `_modelScale` (line 13): declared, never read. Dead.
- `_demo` (line 16): declared, `_spawnDemo`/`_updateDemo` exist (lines 166-228), never called from `sync()`. ~70 lines of dead code.
- `flameL`, `flameR`, `skiBoard` (lines 94-96): set to `null` in `_createInstance`, never populated. Vestigial from the lesson-learned incident (ski board at 30m).

**Foot offset calculation (lines 36-52) — one-time, assumes idle pose**

> The foot offset is computed by playing the idle animation for one frame on a temporary mixer, then finding the lowest bone Y. This assumes the idle pose has the lowest feet. What if the `run` or `ski` pose has feet lower? The offset would be wrong for those animations, causing ground penetration or floating. Also: the temporary mixer/action are cleaned up (lines 51-52) but the `tmpModel` is the *original* `gltf.scene` — mutating its animation state before cloning could cause issues if clones reference shared data. **Severity: Low (works in practice because idle T-pose is typically the reference).**

---

## Pass 2 — Challenge Architecture (ryg, Carmack, Muratori, Ive)

### ryg (GPU/Draw Calls)

> Let me look at what `skeletonClone` actually produces. Line 80: `const model = skeletonClone(_gltf.scene);` — this creates a complete deep clone of the scene graph including all meshes, materials, and a new skeleton. Each character instance is a fully independent draw call (or multiple, if the GLB has multiple meshes).
>
> For 64 players, that's 64 × (meshes-per-character) draw calls. If the model has 5 submeshes (body, visor, armor plates, weapon, accessories), that's 320 draw calls just for characters. On mobile GPUs, that's your entire budget.
>
> `frustumCulled = false` on line 84 means *every* character is drawn *every frame* regardless of visibility. With 64 players on a large map, most are off-screen at any time. You're paying full vertex processing + skinning cost for invisible characters. This was probably set to avoid culling artifacts with skinned meshes (bounding boxes are tricky), but it's the wrong solution. You should compute a conservative bounding sphere from the bind pose and update it, or at minimum use the skeleton's root bone position with a generous radius.
>
> The material override (lines 86-92) modifies the *cloned* material per instance, which is correct — but `mat.needsUpdate = true` forces a shader recompile on first use. For 64 instances, that's 64 recompiles. These should share a material with per-instance uniforms for tribe color, or use instanced skinned meshes (though Three.js doesn't natively support instanced skinning).
>
> **Verdict:** Won't scale to 64. Need an instancing strategy or at minimum frustum culling and shared materials with tribe color uniforms.

### Carmack (Engine Architecture / Performance)

> The architecture here has a fundamental problem: this module owns *only* the local player's 3P model. Lines 130-159 — `_syncLocalPlayer` only processes `localIdx`. Remote players don't exist in this system. They're presumably represented by the primitive capsule meshes in `playerMeshes[]`.
>
> When you eventually add remote player rendering, this module needs to sync all 63 other players. That means:
> 1. `_createInstance()` called up to 63 times (clone GLTF, add to scene)
> 2. `_playClip()` managing 63 independent animation mixers
> 3. `mixer.update(dt)` called 63 times per frame
> 4. Ground height sampling 63 times per frame
>
> The `_groundY()` function (line 120) calls `window._sampleTerrainH` which is bilinear interpolation — cheap, maybe 100ns. But it also branches on `window._rapierGrounded` which is a *global* boolean. For remote players, this flag is meaningless — it represents the *local* player's ground state. Remote players inside buildings will sink through floors because `_rapierGrounded` is never true for them. You'll need per-player grounded state from the network.
>
> The `Module._getThirdPerson()` check on line 133 — why is the 3P toggle inside the character module? That's a camera state. It should be passed in as a parameter, not queried from WASM. This creates a hidden dependency loop: renderer → characters → WASM → renderer.
>
> `Math.min(0.1, t - _lastT)` on line 72 — capping dt at 100ms is correct for animation stability, but `_lastT` is module-global. If `sync()` isn't called for a frame (tab backgrounded, loading stutter), the next call gets a huge dt that's clamped, causing animation time to desync from game time. For local display this is fine; for remote players you'd need the server's animation time.
>
> **Verdict:** The module is architected as "local 3P preview" and needs significant rework for multiplayer character rendering. The 3P toggle should be a parameter, not a WASM query. Ground state needs to be per-player.

### Muratori (Simplicity / Data Flow)

> I'm looking at the data flow and I count *five* different global coupling points:
> 1. `window._rapierGrounded` (read)
> 2. `window._sampleTerrainH` (read)
> 3. `Module._getThirdPerson` (read)
> 4. `_scene` (set from outside via `init()`)
> 5. `playerView` / `playerStride` (passed in but format undocumented)
>
> This is a module that *receives* all its data through a mix of function parameters, module globals, and window globals. The parameter-passing part (`sync(t, playerView, playerStride, localIdx, playerMeshes)`) is actually good — it's explicit. But then internally it reaches through the window to get grounding state and terrain height and camera mode. Why not pass those in too?
>
> The animation state machine (lines 148-154) is a linear priority chain, which is the simplest possible approach. Good. But it's not extensible — adding a `falling` state means inserting into the middle of an if-chain, and every new state makes the chain harder to read.
>
> `_createInstance()` (lines 78-97) does too many things: clones the model, sets up the mixer, overrides materials, adds to scene, and returns a bag-of-properties object. The material override is display policy that shouldn't live in the instance factory. When tribe colors arrive, this function will need to know which tribe the player belongs to — more parameters, more coupling.
>
> The `_playClip()` function (lines 99-113) is clean. It handles fallback to idle, crossfade, one-shot. Simple and correct. I'd keep this as-is.
>
> The foot offset calculation (lines 36-52) is a one-time calibration that mutates the source GLTF scene's animation state. This is a side effect hidden inside `init()`. It works because `skeletonClone` copies everything, but it's conceptually wrong to play animations on the source just to measure something. Measure from the bind pose or the GLB metadata.
>
> **Verdict:** The module is simpler than it looks, which is good. The main complexity is unnecessary global coupling. Pass everything through `sync()` and you have a clean, testable module.

### Ive (Design Coherence)

> What sensation does this module create for the player? Right now: "I can see myself in third person." That's a camera feature, not a character experience. There's no tribe identity, no armor silhouette differentiation, no weapon visibility, no flag-carry visual, no damage feedback.
>
> The animation state machine has five states: idle, run, ski, jet, death. These map to the *mechanical* states of the player — what the physics system is doing. They don't map to the *emotional* states — the feeling of speed, the weight of heavy armor, the urgency of carrying the flag. A light armor player and a heavy armor player play the same animations at the same speed. That's a readability failure.
>
> In the design document, the Core Feeling of **Belonging** requires that players can identify tribe members at a glance. Right now, all 64 players would be identical crimson sentinels. The Core Feeling of **Scale** requires readable silhouettes at distance. One model, one scale, one color — there's no silhouette language.
>
> The `crimson_sentinel_rigged.glb` filename suggests this is the Blood Eagle model. Good — tribe-specific models are the right path. But the code has no architecture for loading or selecting multiple models. When Phoenix, Diamond Sword, and Starwolf models arrive, the single `_gltf` global and the single `loader.load()` call can't accommodate them.
>
> The material override (lines 86-92) actively *removes* material personality by flattening roughness and metalness to safe ranges. This homogenizes the look. The artist's intent in the GLB file is being overridden. If the materials look wrong, fix them in the modeling tool — don't patch them at runtime.
>
> **Verdict:** This module is the skeleton of a character system but doesn't yet serve any Core Feeling. It needs tribe identity, armor differentiation, and animation personality before it contributes to the player experience.

---

## Pass 3 — Debate to Consensus

**Carmack:** ryg's point about 64 × N draw calls is real but premature. We're not rendering 64 characters yet. The immediate blocker is the `_chars[16]` array — that's a crash waiting to happen.

**ryg:** Agreed. But the architecture choices made now lock in the cost model. If every instance is a full `skeletonClone`, you can't retrofit instancing later without rewriting the whole module. I'd at least design the instance creation to go through a pool that can be swapped for an instanced approach later.

**Muratori:** The pool idea is fine, but let's not over-engineer. The real problem is simpler: this module has five global dependencies and only syncs one player. Fix the interface first. Make `sync()` take everything it needs as parameters. Then when you add remote players, the per-player data is already passed in cleanly.

**Carmack:** Exactly. The `window._rapierGrounded` global is per-local-player. The moment you try to sync a remote player, that boolean is wrong for them. This needs to be per-player grounded state from the network packet.

**ryg:** On the `frustumCulled = false` — I know skinned mesh bounding boxes are broken in Three.js (they use the bind pose AABB which doesn't account for animation). But setting it to `false` for all 64 characters means you're skinning invisible characters on the GPU. That's real cost. You need to at least compute a bounding sphere manually.

**Muratori:** Or just let Three.js cull with the bind-pose box and accept that sometimes a character pops in a frame late. For a fast-moving game with a wide FOV, nobody will notice. The cost of culling incorrectly for one frame is invisible; the cost of skinning 60 invisible characters is measurable.

**ryg:** Fair. Set `frustumCulled = true` and live with rare pop-in. It's the 90% solution with zero complexity.

**Ive:** I want to raise the dead code. 70 lines of `_spawnDemo` / `_updateDemo` that are never called. The `flameL`, `flameR`, `skiBoard` null assignments. The `_modelScale` variable. This is scar tissue from the ski board incident. It should be removed. Dead code is not "ready for later" — it's confusion for the next person who reads this file.

**Carmack:** Agreed. Remove it. If you need a demo system later, write it then. The demo code also duplicates the grounding and positioning logic from `_syncLocalPlayer` — it would be stale the moment the real code changes.

**Muratori:** One more thing: the `_playClip` fallback (line 101) — if you request a clip that doesn't exist and `idle` doesn't exist either, it silently returns. No error, no warning. For a live game this is fine; during development you want to know when an expected clip is missing. Add a `console.warn` in development mode.

**CONSENSUS:**

1. **P0:** Fix `_chars` array size — use 64, or better, use a Map keyed by player index
2. **P0:** Remove all dead code (`_demo`, `_spawnDemo`, `_updateDemo`, `_modelScale`, null flame/ski assignments)
3. **P1:** Refactor `sync()` signature to accept `is3P`, `isGrounded`, `terrainSampleFn` as parameters instead of reading globals
4. **P1:** Define playerView offset constants in a shared location (e.g., `player_layout.js`)
5. **P2:** Set `frustumCulled = true` (accept rare pop-in over GPU waste)
6. **P2:** Remove material overrides — trust the GLB authored values
7. **P3:** Design multi-model architecture for 4 tribes × 3 armor tiers
8. **P3:** Add animation states for airborne, weapon fire, flag carry

---

## Pass 4 — System-Level Review

### Module Boundaries

**Current coupling map:**

```
renderer.js ──import──→ renderer_characters.js
                              │
                              ├──reads──→ window._rapierGrounded  (from renderer_rapier.js)
                              ├──reads──→ window._sampleTerrainH  (from renderer.js)
                              ├──reads──→ Module._getThirdPerson  (from WASM/C++)
                              │
                              ├──reads──→ playerView (Float32Array from WASM shared memory)
                              ├──reads──→ playerStride (from renderer.js)
                              ├──reads──→ playerMeshes[] (from renderer.js)
                              │
                              └──writes─→ THREE.Scene (model add/visibility)
```

**Ive's Razor: Should this module exist as a separate file?**

> **Yes**, but with reservations. Character rendering is a distinct concern from terrain, HUD, and particles. Having it as a module is correct. But it should be a *complete* module — right now it's incomplete, handling only 3P local and deferring everything else. It should either own *all* character rendering (including remote players) or be explicitly scoped as "local 3P preview" with a clear boundary for where remote character rendering lives.

**System-level risks:**

1. **Animation mixer per player:** Each `THREE.AnimationMixer` is independent. For 64 players, that's 64 mixer updates per frame. Three.js mixers are not lightweight — they traverse action lists, interpolate tracks, update bone matrices. At 64 players × 20 bones × 3 tracks = 3,840 bone interpolations per frame. Need to measure this.

2. **SkeletonUtils.clone cost:** Each clone duplicates the entire skeleton, all geometries (as references), and all materials (as clones). The geometry data is shared (good — GPU buffers are reused). But each clone creates new `Object3D` nodes, new `Bone` instances, new `SkinnedMesh` wrappers. For 64 players, that's significant JS object allocation.

3. **No LOD:** Characters at 500m distance render with the same bone count and mesh detail as characters at 5m. For a game with long sightlines (Core Feeling: Scale), most characters will be distant. A billboarded sprite or low-poly impostor at distance would save enormous GPU cost.

4. **No pooling/recycling:** When a player disconnects, `_chars[idx]` presumably stays populated (nothing ever sets it back to null). The model stays in the scene, invisible. Over a match with player churn, zombie instances accumulate.

**Should `_groundY` exist in this module?**

> No. Ground height resolution is a world-level concern used by physics, particles, camera, and characters. It should be a utility function passed in or imported from a shared module. Having each consumer reach through `window._sampleTerrainH` is the classic "global service locator" anti-pattern. The dual-physics branching (`_rapierGrounded` vs terrain) compounds this — the grounding logic should be resolved *before* it reaches the character module. Pass in a `getGroundY(x, y, z, playerIdx)` that already handles the WASM/Rapier decision.

---

## Pass 5 — AI Rules Extraction (@ai-contract)

```javascript
/**
 * @ai-contract renderer_characters.js
 * 
 * PURPOSE:
 *   Rigged GLB character model rendering for Firewolf players.
 *   Currently: local player 3P view only.
 *   Future: all player rendering (local + remote, 4 tribes, 3 armor tiers).
 * 
 * OWNS:
 *   - GLTF loading and caching for character model(s)
 *   - SkeletonUtils cloning for per-player instances
 *   - Animation mixer lifecycle (create, play clip, crossfade, update)
 *   - Character model positioning and visibility
 *   - Foot offset calibration from bind pose
 * 
 * DOES NOT OWN:
 *   - Camera mode (3P toggle) — queried from WASM, should be passed in
 *   - Ground height resolution — uses window globals, should be injected
 *   - Player physics state — reads from playerView shared memory
 *   - Primitive mesh visibility — managed by renderer.js
 *   - Particles (jet exhaust, ski spray) — managed by renderer.js (lesson #4)
 * 
 * GLOBALS READ:
 *   - window._rapierGrounded (Boolean) — per-local-player ground state
 *   - window._sampleTerrainH (Function) — terrain height sampling
 *   - Module._getThirdPerson (Function) — camera mode from WASM
 * 
 * GLOBALS WRITTEN:
 *   (none)
 * 
 * EXPORTS:
 *   - init(scene) → void — call once, loads GLB async
 *   - isLoaded() → boolean — true when GLB load complete
 *   - sync(t, playerView, playerStride, localIdx, playerMeshes) → void — call per frame
 * 
 * PLAYERIEW LAYOUT (offsets from localIdx * playerStride):
 *   [0] posX  [1] posY  [2] posZ
 *   [3] ???   [4] yaw
 *   [5] ???   [6] velX  [7] ???  [8] velZ
 *   [13] alive (>0.5)  [14] jetting (>0.5)  [15] skiing (>0.5)
 *   [18] visible (>0.5)
 * 
 * ANIMATION CLIPS EXPECTED IN GLB:
 *   idle, run, ski, jet, death
 *   (Optional: fire_rifle — exists but not wired to gameplay)
 * 
 * SCALE CONVENTION:
 *   All positions and sizes in WORLD METERS (Y-up).
 *   GLB armature scale (0.01) does NOT propagate to sibling meshes.
 *   See lessons-learned.md #2: Model-Local vs World Scale.
 * 
 * KNOWN LIMITATIONS:
 *   - _chars array sized to 16, game needs 64 → MUST FIX before remote players
 *   - Only syncs localIdx in 3P mode; remote players not rendered
 *   - Single model for all tribes/armors — needs multi-model architecture
 *   - No LOD — full mesh at all distances
 *   - frustumCulled = false — all characters rendered even when off-screen
 *   - _rapierGrounded is global, not per-player — breaks for remote players
 *   - Material overrides flatten authored PBR values
 * 
 * CACHE BUST:
 *   After ANY edit, verify cache bust in renderer.js:
 *     grep 'renderer_characters' renderer.js
 *   See lessons-learned.md #1.
 * 
 * DO NOT:
 *   - Add particle systems here (use renderer.js canonical pattern, lesson #4)
 *   - Add child meshes in centimeter scale (lesson #2)
 *   - Add window.* globals without documenting them here
 *   - Modify _gltf.scene directly after init (clones reference shared data)
 */
```

---

## Pass 6 — Design Intent (Ive lead + Panel)

### Core Feeling Mapping

| Core Feeling | Current Contribution | Gap | Priority |
|---|---|---|---|
| **Belonging** | None — all players are identical crimson sentinels | Tribe color/model differentiation, armor tier silhouettes, flag carry visual | **Critical** |
| **Adaptation** | None — character appearance doesn't change with game phase | Phase-reactive materials (frost on armor during blizzard, glow during solar), damage state | Low (future) |
| **Scale** | Partial — rigged model provides human-scale reference point in vast terrain | No LOD means distant characters are either invisible or full-cost. Need impostor system for "ant on a hill" at 500m | **High** |
| **Aliveness** | Partial — animation states create movement, idle breathing | No weapon animations, no damage reactions, no celebration/emote, no physics cloth/hair | Medium |

### Ive's Assessment

> The character is the player's avatar in the world. It's the most personal element of the visual experience. Right now, it's a technical proof-of-concept: a single model that plays five animations. It proves the pipeline works — GLTF loads, skeleton clones, animations play, positioning works. That's valuable.
>
> But it doesn't yet serve the game's identity. Firewolf's visual language is "faceted terrain, readable silhouettes, procedural boldness." The character should extend that language. What does a Firewolf character *look like*? Not AAA realistic. Not cel-shaded. Bold shapes, clear tribe colors, distinct armor silhouettes recognizable at 200m. The heavy should *look* heavy — wide, planted, imposing. The light should look fast — streamlined, angular, minimal.
>
> The material override code (lines 86-92) actively fights against authored materials by forcing conservative PBR values. Remove it. If the model's materials don't match the game's look, that's an art direction problem solved in Blender, not a runtime override.
>
> The animation state machine needs to tell a story. Right now it says "I'm standing, running, skiing, jetting, or dead." It should say "I'm a light armor Blood Eagle capper rocketing across the map at 200kph with the enemy flag." Every missing animation state is a missed opportunity to communicate gameplay information visually. The `fire_rifle` clip exists but isn't wired — that's the most common action in an FPS and it's invisible.
>
> **What this module should aspire to:** When a player looks at another character at distance, they should know: (1) what tribe, (2) what armor, (3) what they're doing, (4) whether they're a threat. Currently: 0 of 4.

---

## Bug List

| # | Description | Severity | Line(s) | Status |
|---|---|---|---|---|
| B1 | `_chars` array sized 16, game needs 64. Out-of-range index causes infinite clone loop (60 clones/sec) | **CRITICAL** | 15 | Open |
| B2 | playerView offsets are magic numbers duplicated across files. Single stride change breaks silently | **HIGH** | 133-155 | Open |
| B3 | `window._rapierGrounded` is global, not per-player. Remote players will sink through building floors | **HIGH** | 121 | Open (blocks remote player rendering) |
| B4 | `frustumCulled = false` renders all characters even when off-screen | **MEDIUM** | 84 | Open |
| B5 | `init()` has no double-call guard. Hot reload overwrites `_gltf`, orphans existing instances | **MEDIUM** | 20-62 | Open |
| B6 | `fire_rifle` animation clip exists but not wired to gameplay state machine | **MEDIUM** | 148-154 | Open |
| B7 | No cleanup/dispose path. Disconnected players leave zombie models in scene | **MEDIUM** | 78-97 | Open |
| B8 | Death action with `clampWhenFinished` accumulates uncleaned mixer actions over respawn cycles | **LOW** | 108-110 | Open |
| B9 | Material overrides (roughness/metalness clamping) fight authored GLB values | **LOW** | 86-92 | Open |
| B10 | `_modelScale` declared, never used | **TRIVIAL** | 13 | Dead code |
| B11 | `_demo`, `_spawnDemo`, `_updateDemo`, flame/ski null assignments — ~70 lines dead code | **TRIVIAL** | 16-17, 94-96, 166-228 | Dead code |

---

## Architecture Recommendations

### Immediate (before next feature work)

1. **Fix `_chars` sizing** — Replace `new Array(16)` with `new Map()` keyed by player index. Supports any player count, automatic cleanup on delete.

2. **Remove dead code** — Delete `_modelScale`, `_demo`, `_demoSpawned`, `_spawnDemo()`, `_updateDemo()`, and the null `flameL`/`flameR`/`skiBoard` in `_createInstance()`. That's ~80 lines removed from a 294-line file (27% reduction).

3. **Add double-call guard to `init()`** — `if (_loaded || _loading) return; _loading = true;`

### Short-term (before remote player rendering)

4. **Refactor `sync()` signature:**
   ```javascript
   export function sync(t, players, opts) {
     // players: array of { idx, posX, posY, posZ, yaw, velX, velZ, 
     //                      alive, jetting, skiing, visible, grounded }
     // opts: { is3P, getGroundY, terrainSampleFn }
   }
   ```
   Eliminates all window.* global reads. Makes the module testable.

5. **Shared playerView layout constants** — Create `player_layout.js`:
   ```javascript
   export const PV_POS_X = 0, PV_POS_Y = 1, PV_POS_Z = 2;
   export const PV_YAW = 4;
   export const PV_VEL_X = 6, PV_VEL_Z = 8;
   export const PV_ALIVE = 13, PV_JETTING = 14, PV_SKIING = 15;
   export const PV_VISIBLE = 18;
   ```

6. **Instance recycling pool** — When a player disconnects, return their instance to a pool. On next spawn, reuse from pool instead of cloning. Avoids scene graph churn and GC pressure.

### Medium-term (multi-tribe rendering)

7. **Multi-model loader** — Load 4 tribe GLBs (or 1 base + color variants via material swap). `_createInstance(tribeIdx, armorTier)` selects the right source model.

8. **LOD system** — At >200m, replace skinned mesh with a billboard sprite (tribe-colored dot with armor silhouette). At >50m, use a reduced-bone skeleton. Full quality <50m only.

9. **Animation state machine upgrade** — Add `airborne`, `fire_*`, `flag_carry` states. Consider a small state machine object instead of the if-chain.

---

## Keep / Extract / Absorb / Kill

| Element | Verdict | Rationale |
|---|---|---|
| **Module itself** (`renderer_characters.js`) | **KEEP** | Correct separation of concern. Character rendering belongs in its own module. |
| `init()` / GLB loading | **KEEP** | Works correctly. Add double-call guard and multi-model support later. |
| `_createInstance()` | **KEEP** | Core factory. Remove material overrides and dead null assignments. |
| `_playClip()` | **KEEP** | Clean, correct crossfade logic. No changes needed. |
| `_syncLocalPlayer()` | **KEEP + REFACTOR** | Expand to sync all players. Remove global reads. |
| `_groundY()` | **EXTRACT** | Grounding logic should be a shared utility, not per-module. Pass resolved ground height in from caller. |
| Foot offset calibration (lines 36-52) | **KEEP** | Clever one-time calibration. Document it better. |
| `_modelScale` | **KILL** | Dead variable. |
| `_demo` / `_spawnDemo` / `_updateDemo` | **KILL** | 70 lines of dead code. Duplicates logic. Rebuild if/when needed. |
| `flameL` / `flameR` / `skiBoard` nulls | **KILL** | Vestigial. Particles live in renderer.js (lesson #4). |
| Material overrides (lines 86-92) | **KILL** | Fights authored values. Fix materials in Blender, not at runtime. |
| `playerView` magic offsets | **EXTRACT** | Move to shared `player_layout.js` constants file. |

---

*Review complete. 294 lines analyzed across 6 passes. 11 issues identified (1 critical, 2 high, 4 medium, 2 low, 2 trivial). Core finding: module is a working proof-of-concept for local 3P, but has a critical array sizing bug and needs significant architecture work before it can serve multiplayer character rendering or any Core Feeling.*
