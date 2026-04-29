# Phase 2b — Adversarial Convergence Review: renderer_rapier.js (Run 1)

**Target:** `renderer_rapier.js` — 456 lines (Rapier physics facade)  
**Date:** 2026-04-29  
**Panel:** Carmack, Erin Catto, Abrash, Muratori

---

## Pass 1 — Break It

### Carmack — Engine Architecture & Performance

**C-1 · Dual-Physics Desync (CRITICAL)**  
WASM tick() integrates gravity + skiing + jetting → produces a position that may penetrate geometry. Then JS-side Rapier resolves collisions and writes corrected position *back* to WASM shared memory. But WASM's velocity state is **not corrected to match**. Next frame, WASM integrates from the corrected position but with the old velocity — meaning it will immediately attempt the same penetration again. The velocity damping in `stepPlayerCollision` (lines ~220-230) is a band-aid: it only fires when the correction ratio drops below 0.5, and only on X/Z axes. A player skiing diagonally into a wall at moderate speed can oscillate between "WASM pushes through → Rapier pushes back" indefinitely. This is the root cause of lessons-learned #5 (sinking through floors).

**C-2 · world.step() Every Frame with Zero Gravity (HIGH)**  
`world.step()` is called every frame (line ~197) even though gravity is `{0,0,0}` and every rigid body is either fixed or kinematic-position-based. Rapier's `World.step()` runs the full broadphase update, narrowphase pair detection, island construction, and constraint solver — all of which do zero useful work here because there are no dynamic bodies. The *only* thing we need from Rapier is `computeColliderMovement()` on the character controller, which internally queries the collision pipeline. We're paying for a full physics step we don't use.

**C-3 · No Collider Cleanup / Destroy Path (HIGH)**  
There are zero `world.removeCollider()` or `world.removeRigidBody()` calls anywhere. Buildings can be destroyed in gameplay. When a generator goes down, its cuboid collider persists as a ghost wall. Phase mechanics (lava flood destroying structures) will compound this — the collision world diverges from the visual world. This is a ship-blocking omission for any destructible-buildings feature.

**C-4 · Single-Player Collision Only (MEDIUM)**  
`stepPlayerCollision` takes a single `localIdx`. With 64 players planned, remote players have zero collision response — they'll clip through buildings, walk through walls, and hover over terrain. For a game about *belonging* and *scale*, seeing 63 ghosts phasing through geometry is immersion poison.

### Erin Catto — Physics Correctness

**EC-1 · Character Controller Feet-Y Math (CRITICAL)**  
The capsule center offset calculation is wrong in a subtle way:
```js
const capsuleH = playerRadius + playerHalfH;  // 0.6 + 0.3 = 0.9
const centerY = wasmY + capsuleH;              // feet + 0.9
```
Rapier's `ColliderDesc.capsule(halfHeight, radius)` creates a capsule whose **total height** = 2×halfHeight + 2×radius = 2×0.3 + 2×0.6 = 1.8m. The center is at `halfHeight + radius = 0.9` above the feet — so the offset calculation is correct *for this specific configuration*. But the variable name `capsuleH` is misleading (it's the center offset, not the height), and if anyone changes `playerHalfH` or `playerRadius` without understanding this implicit relationship, the feet will detach from the ground. This should be an explicit `capsuleCenterOffset = playerRadius + playerHalfH` with a comment.

**EC-2 · computeColliderMovement Without Filter Flags (HIGH)**  
`characterController.computeColliderMovement(playerCollider, desiredMovement)` uses default filter flags — meaning the character controller tests against *all* colliders in the world, including the terrain heightfield. But WASM already terrain-clamps the player. So the character controller is double-clamping against terrain: once in WASM, once in Rapier. If the terrain heightfield has even slight numerical drift from the WASM heightmap (different interpolation, float precision), the player will jitter vertically every frame as two systems fight over the ground plane.

**EC-3 · Velocity Correction is Physically Wrong (HIGH)**  
Lines 220-230 attempt to damp velocity when collision correction is large:
```js
const ratio = corrected.x / desiredMovement.x;
if (ratio < 0.5) playerView[o + 6] = vx * Math.max(0, ratio);
```
This treats each axis independently. A player hitting a wall at 45° should *slide* along it — the perpendicular component zeroes out while the parallel component is preserved. Instead, this code attenuates each axis based on its own correction ratio, which produces incorrect friction-like damping on the parallel axis. A player skiing into a wall at 45° loses speed on *both* axes instead of sliding. This breaks the Tribes skiing feel fundamentally.

**EC-4 · TriMesh Indices Are Redundant (LOW)**  
In `rapierRegisterModelCollision`, after manually extracting and transforming every vertex, the code creates indices as `[0, 1, 2, 3, 4, 5, ...]` — a trivial identity mapping. Rapier's `trimesh()` accepts these, but the indices array is pure waste. Could pass `null` or use the non-indexed variant. 264KB of wasted Uint32Array per large mesh.

### Abrash — Per-Frame Cost Analysis

**A-1 · Float32Array View Allocation in Hot Path (MEDIUM)**  
`stepPlayerCollision` is called every frame. It reads from `playerView` (a Float32Array over WASM memory). The caller in renderer.js creates this view fresh each frame:
```js
const view = new Float32Array(Module.HEAPF32.buffer, ptr, count);
```
While memory growth is currently disabled (making `buffer` stable), this is a ticking time bomb. If memory growth is ever enabled, `buffer` invalidates on any `malloc`/`sbrk`, and the view becomes a dangling reference mid-frame. The pattern should be: create the view, use it, never cache it across async boundaries.

**A-2 · Heightfield Copy (MEDIUM)**  
```js
const heights = new Float32Array(nrows * ncols);
for (let i = 0; i < nrows * ncols; i++) heights[i] = heightData[i];
```
This copies 257×257 = 66,049 floats (~258KB) in a scalar loop. `Float32Array.from(heightData)` or `new Float32Array(heightData)` would use the optimized typed-array copy path, which is typically SIMD-accelerated in V8. For a one-time init this isn't frame-critical, but it's sloppy — and if terrain ever regenerates per-phase, it matters.

**A-3 · TriMesh Vertex Transform Without Batching (MEDIUM)**  
The `rapierRegisterModelCollision` function transforms vertices one at a time with manual matrix multiply (12 multiplies + 3 adds per vertex). For interior meshes with thousands of triangles, this adds up. Three.js already has `BufferGeometry.applyMatrix4()` which does this in a tight loop and may hit V8's JIT better. More importantly, the current code creates *one rigid body + one collider per mesh* — an interior with 8 sub-meshes creates 8 rigid bodies. Rapier's compound collider (multiple colliders on one body) would be cheaper.

### Muratori — Complexity Challenge

**M-1 · This Is Two Physics Engines (CRITICAL)**  
Let me be direct: you have a custom WASM physics engine that handles gravity, skiing, jetting, and terrain clamping, and then you have Rapier — an entire second physics engine — running as a post-process collision correction layer. This is the kind of architecture that happens when you bolt on a feature instead of designing it. Every bug in this file traces back to the same root cause: **two systems disagree about where the player is**.

WASM says "you're here, moving at this velocity." Rapier says "no, you're actually over there." Then you try to reconcile them with ratio-based velocity hacks that don't conserve momentum or respect surface normals. This will produce bugs forever.

The clean solution is one of: (a) move all player physics into Rapier and delete the WASM collision code, or (b) move building/interior collision into WASM and delete Rapier. Anything else is duct tape.

**M-2 · The Global Mutable State Smells (MEDIUM)**  
Seven module-level `let` variables (`world`, `characterController`, `playerCollider`, `playerRigidBody`, `lastCorrectedPos`, `hasLastPos`, `initialized`) plus a `window.RapierPhysics` global. This is classic "turned a function into a module by adding state." The entire thing could be a class with explicit lifecycle — `init()`, `step()`, `destroy()`. That also gives you a natural place for cleanup (the missing destroy path from C-3).

**M-3 · Magic Number Stride Offsets (MEDIUM)**  
`playerView[o + 0]` through `playerView[o + 8]` with no named constants. If WASM ever reorders the player struct, this silently reads wrong data. These should be named imports from a shared constants file, or at minimum, local constants at the top of the function.

---

## Pass 2 — Challenge Architecture

### The Dual-Physics Debate

**Carmack:** The architecture isn't wrong in principle — plenty of shipped engines have a "gameplay physics" layer and a "collision resolution" layer. Unreal does this internally: its character movement component queries the physics world but doesn't simulate through it. The problem here is the *seam* between the two. The WASM engine doesn't know Rapier corrected the position, so it can't adjust its own internal state (contact normals, grounded flags, friction model). And Rapier doesn't know about WASM's velocity model, so it can't apply proper collision response. Fix the seam — give Rapier authority over position AND velocity correction — and the architecture is workable.

**Erin Catto:** I disagree with Carmack's framing. The problem isn't "fix the seam" — the problem is that `computeColliderMovement` is a character controller, not a collision resolver. It's designed to be the *primary* movement authority, not a post-hoc correction pass. When you feed it a desired movement that's the *delta between two already-integrated positions*, you're violating its contract. It expects to receive a *velocity-derived displacement* and produce a *collision-corrected displacement*. The semantic mismatch is why the velocity correction hacks exist — you're trying to reverse-engineer what the character controller "would have done" to velocity. My recommendation: feed Rapier the raw velocity × dt as the desired movement, let it handle the collision, and write both the corrected position AND the implied velocity back to WASM.

**Muratori:** You're both describing ways to make duct tape stick better. The fundamental question is: why does WASM exist at all for player physics? If the answer is "performance," I'd like to see the benchmark. Rapier is compiled from Rust to WASM — it *is* WASM. You have two WASM runtimes doing the same job. If the answer is "WASM handles the custom Tribes movement model (skiing, jetting)," then integrate that model into the Rapier step. Write a custom character controller that understands skiing friction. Don't run a physics sim and then ask a second physics sim to fix the first one's mistakes.

**Carmack:** Casey, you're right that the long-term answer is convergence. But practically, the WASM engine already handles skiing, jetting, projectile physics, flag physics, vehicle physics (upcoming), and 64-player interpolation. Ripping all of that out to put it in Rapier is a months-long rewrite with regression risk. The pragmatic path is: (1) make WASM authoritative for movement, (2) make Rapier authoritative for collision detection only (ray/shape casts, not a character controller), (3) feed collision contacts back to WASM so it can apply response natively. That gives you one physics authority and one collision oracle.

**Erin Catto:** That's actually the cleanest option. Drop the character controller entirely. Use Rapier as a collision query engine — `world.castShape()` and `world.contactsWith()` — and let WASM handle all response. You still get Rapier's GJK/SAT narrowphase and BVH broadphase without the semantic mismatch of running a character controller as a correction pass. And you can query collisions for remote players too (fixing C-4) without running 64 character controllers.

**Abrash:** From a perf standpoint, shape casts are much cheaper than a full character controller step. `computeColliderMovement` internally does multiple shape casts plus depenetration iterations. If we know we only need "does the player's capsule overlap anything at this position?" that's a single query per player per frame. For 64 players, that's 64 shape casts vs. 64 character controller solves — easily 5-10× cheaper.

**Muratori:** Fine. I'll accept "Rapier as collision oracle" as the intermediate architecture. But document it as an intermediate step, not the final design. The long-term goal should be unified physics — one system, one authority, one truth. Two engines is two bug surfaces forever.

### Consensus: Rapier's Role

The panel converges on: **Rapier should be a collision query engine, not a character controller.** The character controller API (`computeColliderMovement`) creates a semantic mismatch with the existing WASM movement model. Replace it with shape-cast queries that feed collision contacts back to WASM for response.

### The world.step() Question

**Abrash:** Can we eliminate `world.step()` entirely if we drop the character controller?

**Erin Catto:** Yes, with a caveat. Rapier maintains an internal collision pipeline that gets updated during `step()`. But you can also call `world.updateSceneQueries()` (or the equivalent maintenance call) to update the broadphase and narrowphase without running the solver. If all bodies are fixed, there's no solver work anyway — but the pipeline still needs a poke to process any newly added/removed colliders. So replace `world.step()` with the scene-query update call, and you save the solver overhead entirely.

**Carmack:** Even better — if the scene is static between phases (buildings don't move until destroyed), you only need to update scene queries when the collider set changes. Cache a dirty flag, update on add/remove, skip otherwise.

### The Cleanup / Lifecycle Question

**Muratori:** The missing `destroy()` path isn't a nice-to-have — it's structural. Without it, building destruction is impossible. Interior transitions are impossible. Phase transitions that reshape the terrain are impossible. This module needs: `removeCollider(handle)`, `removeAllColliders()`, `replaceTerrainHeightfield()`, and `destroy()` (full teardown for session end). These are the *first* things to add, not the last.

**Carmack:** Agreed. And each collider needs to be tracked by a handle that maps back to its game entity. Right now, colliders are fire-and-forget — `world.createCollider()` returns a handle, but it's never stored. We need a `Map<entityId, ColliderHandle>` at minimum.

---

## Pass 3 — Debate to Consensus

### Final Consensus & Priorities

| # | Issue | Sev | Owner | Consensus |
|---|-------|-----|-------|-----------|
| C-1 / M-1 | Dual-physics desync — WASM and Rapier fight over position | CRITICAL | Architecture | **Refactor: Rapier becomes collision query oracle. WASM owns movement + response. Drop character controller API.** Panel unanimous after debate. |
| EC-2 | Double terrain clamping (WASM + Rapier heightfield) | HIGH | Correctness | **Remove terrain heightfield from Rapier** if WASM terrain clamping is authoritative. Or remove WASM terrain clamping and let Rapier handle it. One source of truth for ground. |
| EC-3 | Per-axis velocity correction is physically incorrect | HIGH | Correctness | **Delete ratio-based velocity hack.** If Rapier becomes a query oracle, WASM handles response with proper surface normals from contact data. Sliding comes naturally. |
| C-2 | world.step() runs full solver with zero useful work | HIGH | Perf | **Replace with scene-query-only update.** Skip when collider set is clean. |
| C-3 / M-2 | No collider cleanup, no entity→collider tracking | HIGH | Lifecycle | **Add collider registry (Map), removal API, and full destroy().** Ship-blocking for building destruction and phase transitions. |
| C-4 | Remote players have no collision | MEDIUM | Gameplay | **Deferred to when Rapier is a query oracle.** Shape-cast per remote player per frame is cheap enough for 64 players. |
| A-1 | Float32Array view created fresh per frame | MEDIUM | Safety | **Document that memory growth must stay disabled, or add view-refresh guard.** Current code is safe but brittle. |
| EC-1 | capsuleH naming is misleading | MEDIUM | Clarity | **Rename to `capsuleCenterOffset`, add comment.** 5-minute fix, prevents future bugs. |
| M-3 | Magic stride offsets | MEDIUM | Maintainability | **Extract named constants from shared header.** `POS_X=0, POS_Y=1, POS_Z=2, VEL_X=6, VEL_Y=7, VEL_Z=8`. |
| A-2 | Heightfield scalar copy loop | LOW | Perf | **Use `new Float32Array(heightData)`.** One-liner. |
| EC-4 | Redundant identity indices in trimesh | LOW | Waste | **Drop indices, use unindexed trimesh or pass null.** Saves ~256KB per large mesh. |
| A-3 | One rigid body per sub-mesh | LOW | Perf | **Compound collider pattern: one body, N colliders.** Reduces Rapier body count for interiors. |

### Dissenting Notes

**Muratori** maintains that the dual-physics architecture should be marked as tech debt with an explicit migration plan toward unified physics. The panel agrees to track it but does not consider it blocking for the current milestone.

**Carmack** notes that remote player collision (C-4) will become critical when flag capture mechanics are implemented — a flag carrier that clips through walls breaks competitive play.

---

## Pass 4 — System-Level Review

### Dependency Map

```
renderer_rapier.js
├── IMPORTS
│   ├── vendor/rapier/rapier.mjs          (WASM-backed Rapier 0.19.3)
│   ├── Module.HEAPF32 / Module._get*     (Emscripten WASM globals for building data)
│   └── Three.js geometry API             (via mesh.geometry.attributes.position, mesh.matrixWorld)
│
├── EXPORTS (via window.RapierPhysics)
│   ├── initRapierPhysics()               → called by renderer.js on load
│   ├── createTerrainCollider()           → called by renderer.js after heightmap ready
│   ├── createBuildingColliders()         → called by renderer_buildings.js after building init
│   ├── registerModelCollision()          → called by renderer_buildings.js per interior model
│   ├── stepPlayerCollision()             → called by renderer.js every frame in render loop
│   ├── resetPlayerPosition()            → called by renderer.js on respawn/teleport
│   └── getPhysicsInfo()                  → called by debug HUD
│
├── CONSUMERS
│   ├── renderer.js                       (init, terrain, step, reset, grounded flag)
│   ├── renderer_buildings.js             (building colliders, interior trimesh registration)
│   └── debug HUD                         (getPhysicsInfo)
│
└── IMPLICIT DEPENDENCIES
    ├── Module._getBuildingPtr/Count/Stride (WASM building array layout)
    ├── Player struct stride layout         (offsets 0-8 for pos/vel)
    └── _htData (heightmap) passed by reference from renderer.js
```

### Interface Contract

| Function | Called By | Frequency | Latency Budget |
|----------|----------|-----------|----------------|
| `initRapierPhysics()` | renderer.js | Once at load | 500ms (async WASM init) |
| `createTerrainCollider()` | renderer.js | Once per map | 50ms |
| `createBuildingColliders()` | renderer_buildings.js | Once per map | 10ms |
| `registerModelCollision()` | renderer_buildings.js | Per interior model (~8-12) | 20ms each |
| `stepPlayerCollision()` | renderer.js render loop | Every frame (60-144Hz) | **< 0.5ms** |
| `resetPlayerPosition()` | renderer.js | On respawn/teleport | Immediate |
| `getPhysicsInfo()` | debug HUD | On demand | Immediate |

### window.* Inventory

| Global | Type | Consumers | Verdict |
|--------|------|-----------|---------|
| `window.RapierPhysics` | Object (7 methods) | renderer.js, renderer_buildings.js, debug HUD | **KEEP short-term** — single facade. Long-term: convert to ES module export. |
| `window._rapierGrounded` | Boolean (set in renderer.js, not here) | renderer.js movement code | **EXTRACT** — should be returned from stepPlayerCollision, not set on window. Currently it IS returned (`{ grounded }`) but renderer.js also sets a window flag. Redundant. |

### Module Disposition

| Verdict | Rationale |
|---------|-----------|
| **KEEP + REFACTOR** | The module's role (Rapier facade for collision) is correct and necessary. The implementation needs refactoring: (1) drop character controller in favor of shape-cast queries, (2) add collider lifecycle management, (3) fix the velocity correction path. The facade pattern (single global, clean API) is good and should be preserved. |

---

## Pass 5 — AI Rules Extraction

```javascript
// @ai-contract renderer_rapier.js
// ROLE: Rapier physics facade — collision detection for buildings and interiors
// ARCHITECTURE: WASM owns movement integration. Rapier provides collision queries.
//   Do NOT add dynamic bodies or gravity to the Rapier world.
//   Do NOT use Rapier for terrain ground-clamping (WASM is authoritative for terrain).
//   The character controller is a transitional API — target is shape-cast queries.
//
// CAPSULE GEOMETRY:
//   Capsule = ColliderDesc.capsule(playerHalfH, playerRadius)
//   Total height = 2*playerHalfH + 2*playerRadius
//   Center offset from feet = playerRadius + playerHalfH
//   If you change playerHalfH or playerRadius, update capsuleCenterOffset.
//
// PLAYER STRUCT LAYOUT (WASM shared memory):
//   Offset 0: posX    Offset 1: posY (feet)    Offset 2: posZ
//   Offset 6: velX    Offset 7: velY            Offset 8: velZ
//   These offsets are defined by WASM player struct. Do NOT reorder without
//   updating both wasm/game.c AND this file.
//
// COLLIDER LIFECYCLE:
//   Every createCollider() call MUST store the returned handle in _colliderHandles.
//   Every entity destruction MUST call removeCollider(entityId).
//   Phase transitions MUST call removeAllColliders() then rebuild.
//
// PERF BUDGET: stepPlayerCollision < 0.5ms per frame at 60Hz
//   Do NOT add allocations (new Float32Array, object literals) in the hot path.
//   Do NOT call world.step() — use scene query update only.
//
// EXPOSES: window.RapierPhysics (7 methods)
// DEPENDS: vendor/rapier/rapier.mjs, Module.HEAPF32, Three.js geometry API
// CONSUMERS: renderer.js, renderer_buildings.js, debug HUD
//
// FORBIDDEN:
//   - Adding Rapier gravity (WASM handles gravity)
//   - Caching Float32Array views across frames (buffer invalidation risk)
//   - Creating colliders without tracking handles
//   - Modifying player velocity without proper surface-normal projection
```

---

## Pass 6 — Design Intent (Core Feelings)

### Belonging
Collision correctness *is* belonging. When a player enters a base interior and their feet land on the floor, when they walk up a ramp and don't clip through the wall, when they stand on the generator platform and feel *solid* — that's the tactile foundation of "this is my base, I'm home." The dual-physics desync (C-1) directly threatens this: jittering at doorways, sinking through floors, oscillating against walls. Every collision bug is a belonging bug.

### Adaptation
Phase mechanics (lava flood, fog, mech waves) will reshape the play space — destroying buildings, flooding terrain, introducing new geometry. The missing collider lifecycle (C-3) makes Rapier unable to *adapt*. A destroyed generator's ghost collider blocks a doorway that should be passable. A flooded interior still has collision. The physics world must mirror the game world's evolution or Adaptation is a visual illusion with no physical truth.

### Scale
64 players. Four tribes. Bases with interiors. The current single-player-only collision (C-4) means 63 players exist in a different physical reality than the local player. At scale, this produces absurdity: enemies running through closed doors, flag carriers passing through walls, defenders standing inside generators. Shape-cast queries for all players (the consensus refactor) directly enables Scale.

### Aliveness
The world should feel *responsive*. When you ski into a building wall, the slide should feel natural — momentum preserved along the surface, perpendicular component absorbed. The current per-axis velocity hack (EC-3) produces dead stops and speed loss that make the world feel *sticky* instead of *alive*. Proper collision response with surface normals gives the player a physical conversation with the world: push, redirect, flow.

---

## Deliverable Summary

### Critical Path (blocks next milestone)
1. **Refactor Rapier to collision query oracle** — Replace `computeColliderMovement` with `castShape`/`contactsWith`. WASM owns position + velocity. Rapier reports contacts. Estimated: 2-3 sessions.
2. **Add collider lifecycle management** — `Map<entityId, ColliderHandle>`, `removeCollider()`, `removeAllColliders()`, `destroy()`. Estimated: 1 session.
3. **Eliminate double terrain clamping** — Remove terrain heightfield from Rapier OR remove WASM terrain clamp. One authority. Estimated: 1 session (decision-dependent).

### High Priority (next sprint)
4. **Delete velocity ratio hacks** — Once Rapier returns contact normals, implement proper surface-normal velocity projection in WASM.
5. **Replace world.step() with scene-query update** — Add dirty flag, skip when collider set unchanged.
6. **Extract stride offset constants** — Shared constants file for WASM player struct layout.

### Medium Priority (track for future sprints)
7. **Remote player collision** — Shape-cast per remote player per frame once query oracle is live.
8. **Armor-specific capsule sizing** — Expose `resizeCapsule(halfH, radius)` and call on armor change.
9. **Compound colliders for interiors** — One body per interior, N colliders per mesh.

### Low Priority (polish)
10. Heightfield copy optimization (`new Float32Array(heightData)`)
11. Drop redundant trimesh indices
12. Document memory-growth assumption

### Metrics to Track
- `stepPlayerCollision` frame time (target < 0.5ms)
- Collider count vs. active entity count (must stay in sync)
- Position delta between WASM-proposed and Rapier-corrected (should trend toward zero as architecture converges)

---

*Review conducted under the Adversarial Convergence Review protocol. All findings rated by severity and cross-validated by panel disagreement. Consensus positions reflect genuine convergence, not compromise.*
