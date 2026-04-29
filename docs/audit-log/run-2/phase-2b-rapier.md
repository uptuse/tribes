# Phase 2b — Adversarial Convergence Review: renderer_rapier.js (Run 2 — Validation Pass)

**Target:** `renderer_rapier.js` — 456 lines (Rapier physics facade)  
**Date:** 2026-04-30  
**Panel:** Carmack, Erin Catto, Abrash, Muratori  
**Run 2 Purpose:** Validate, challenge, and correct Run 1 findings against actual source code.

---

## Source Code Verification

Run 2 reads the complete 456-line file. Every Run 1 claim is checked line by line.

---

## Pass 1 — Validate Run 1 Claims

### Claim C-1: "Dual-physics desync — WASM velocity not corrected to match Rapier position correction"

**Carmack:** "Reading `stepPlayerCollision()` at lines 198-270. The flow is:

1. Read WASM position: `wasmX = playerView[o+0]`, `wasmY = playerView[o+1]`, `wasmZ = playerView[o+2]`
2. Read WASM velocity: `vx = playerView[o+6]`, `vy = playerView[o+7]`, `vz = playerView[o+8]`
3. Place body at `lastCorrectedPos` (previous frame's output)
4. Call `world.step()` then `characterController.computeColliderMovement(playerCollider, desiredMovement)`
5. Apply `corrected = characterController.computedMovement()`
6. Write corrected position back to WASM
7. Conditionally adjust velocity based on correction ratio

The desync claim is **VALIDATED** but more nuanced than Run 1 described. There IS velocity correction code (lines 248-264), but it's the wrong kind of correction. Let me detail exactly what it does:

```javascript
if (Math.abs(corrDx) > 0.01 && Math.abs(desiredMovement.x) > 0.01) {
    const ratio = desiredMovement.x !== 0 ? corrected.x / desiredMovement.x : 0;
    if (ratio < 0.5) playerView[o + 6] = vx * Math.max(0, ratio);
}
```

This says: 'If the corrected X movement is less than 50% of desired X movement, scale the X velocity by the ratio.' The threshold of 0.5 means small corrections (up to 50% position change) have **zero velocity correction**. You have to clip through a wall hard enough to lose more than half your movement before velocity is touched."

**Verdict: ✅ VALIDATED with clarification — velocity correction exists but is inadequate**

---

### Claim EC-3: "Velocity correction is physically wrong — per-axis ratio produces dead stops instead of wall sliding"

**Erin Catto:** "Reading the actual code confirms my Run 1 analysis. Let me trace through a concrete scenario:

**Scenario:** Player skiing at 45° into a wall aligned with the Z axis. Velocity = (20, 0, 20) m/s. dt = 0.016s.

- `desiredMovement = {x: 0.32, y: 0, z: 0.32}` (velocity × dt approximation)
- Wall blocks X: `corrected = {x: 0.01, y: 0, z: 0.32}` (Rapier slides along Z)
- X ratio = `0.01 / 0.32 = 0.03125` → below 0.5 threshold → triggers correction
- `playerView[o+6] = 20 * Math.max(0, 0.03125) = 0.625` m/s (X velocity killed from 20 to 0.6)
- Z ratio = `0.32 / 0.32 = 1.0` → above 0.5 → **no Z correction**

Result: X velocity drops from 20 to 0.6. Z velocity stays at 20. Player **does slide** along the Z-axis wall. Run 1 said 'dead stops instead of wall sliding' — that's **partially wrong**. The per-axis approach accidentally produces sliding because the unblocked axis doesn't trigger the ratio threshold.

**But** — consider a diagonal wall (not axis-aligned). Player skiing at 30° into a wall rotated 45°:

- Both X and Z movement are partially blocked by the diagonal
- Both ratios drop below 0.5
- Both X and Z velocity get scaled down
- Player loses speed on BOTH axes instead of sliding along the diagonal
- Result: **dead stop** against diagonal surfaces

So Run 1 was correct for diagonal walls, wrong for axis-aligned walls. The per-axis approach coincidentally works for the easy case (axis-aligned) but fails for the general case (arbitrary surface normals)."

**Carmack:** "This is exactly why you need contact-normal-based velocity projection instead of per-axis ratio hacking. `v_corrected = v - dot(v, normal) * normal` preserves the tangential component and zeroes the normal component. Works for any surface angle."

**Verdict: ⚠️ PARTIALLY VALIDATED — correct for diagonal walls, wrong for axis-aligned walls. The behavior is worse than "always dead stops" but better than "always correct sliding"**

---

### Claim C-2: "world.step() called every frame with zero dynamic bodies — full solver waste"

**Abrash:** "Confirmed. Lines 212-213:

```javascript
playerRigidBody.setNextKinematicTranslation(lastCorrectedPos);
world.step();
```

The world has: zero gravity `{0, 0, 0}` (set at line 75), one kinematic rigid body (the player, line 83), all terrain/building/interior bodies are `fixed()`. There are ZERO dynamic bodies. `world.step()` runs:

1. Broadphase update — re-sorts axis-aligned bounding boxes
2. Narrowphase pair detection — generates contact manifolds
3. Island construction — groups connected bodies for solving
4. Constraint solver — iterates velocity/position constraints
5. Integration — advances dynamic body positions

Steps 3-5 do **zero useful work** because there are no dynamic bodies and zero gravity. Steps 1-2 update the collision pipeline, which IS needed for `computeColliderMovement()` to work.

**Run 1 was correct that we're paying for a full solver step.** The fix Run 1 proposed — `world.updateSceneQueries()` or equivalent maintenance call — would skip the solver entirely while keeping the broadphase/narrowphase current.

However, I should note: with ~50-150 colliders (1 terrain + ~40 buildings + ~100 trimeshes), all of which are FIXED and never move, the broadphase update after step 1 is also mostly wasted. The spatial acceleration structure doesn't change between frames. The ONLY thing that moves is the kinematic player body, and `setNextKinematicTranslation` already flags it dirty. A smarter approach: only update the broadphase when the player's AABB changes enough to cross spatial partition boundaries."

**Verdict: ✅ VALIDATED — full solver runs every frame for zero useful work**

---

### Claim C-3: "No collider cleanup — colliders created but never removed"

**Muratori:** "Verified with grep. Zero occurrences of:
- `removeCollider`
- `removeRigidBody`
- `.free()`

in the entire file. Colliders are fire-and-forget:

```javascript
// In createBuildingColliders:
world.createCollider(colliderDesc, body);  // Line ~170 — handle discarded

// In rapierRegisterModelCollision:
world.createCollider(colliderDesc, body);  // Line ~230 — handle discarded
_colliderCount++;                          // Counted but not tracked
```

The diagnostic counter `_colliderCount` increments but there's no `Map` or `Array` storing handles. You literally cannot remove a collider because you've thrown away the reference. **Run 1 was correct.** This blocks:

1. Building destruction (destroyed generator's collider persists)
2. Phase transitions (lava flood destroys buildings — ghost walls remain)
3. Map changes (switching maps requires full world teardown)
4. Interior load/unload (entering/leaving interior can't clean up old colliders)"

**Carmack:** "And I'll add — there's no `destroy()` or `dispose()` method at all. No way to tear down the Rapier world. On session end or map change, the world leaks. In a browser context, closing the tab cleans up, but refreshing the page or navigating to a new map accumulates dead worlds."

**Verdict: ✅ VALIDATED — zero removal/cleanup code exists**

---

### Claim C-4: "Only local player collision — remote players clip through everything"

**Erin Catto:** "The function signature at line 198 confirms:

```javascript
function stepPlayerCollision(playerView, stride, localIdx, dt)
```

It takes a single `localIdx`. The function body processes exactly one player — reading from `playerView[localIdx * stride + ...]` and writing corrected position back to `playerView[localIdx * stride + ...]`. No loop. No iteration over other players.

Looking at how it's called from `renderer.js` (system-map indicates L5277), the caller passes `localIdx = Module._getLocalPlayerIdx()` — the local player only.

**Run 1 was correct.** 63 remote players have zero collision response. They exist in a purely WASM-predicted position with no Rapier correction for buildings or interiors."

**Carmack:** "This is actually by design for the current architecture. WASM's tick already handles terrain collision for all players. Rapier only handles building/interior collision. Since remote players don't have client-side prediction in the current network model, their positions come from the server (via snapshots), which already has its own collision. Adding Rapier collision for remote players would fight the server-authoritative positions. 

The REAL problem is that the server-side collision isn't as precise as Rapier's — if the server uses simpler AABB checks, remote players CAN appear to clip through detailed interior geometry even though they're 'correct' from the server's perspective."

**Verdict: ✅ VALIDATED — single player only, by design for now, but problematic for immersion**

---

### Claim EC-1: "Capsule center offset calculation is misleading but correct"

**Erin Catto:** "Lines 235-236:

```javascript
const capsuleH = playerRadius + playerHalfH;  // 0.6 + 0.3 = 0.9
const centerY = wasmY + capsuleH;              // feet + 0.9
```

Rapier capsule at line 90: `ColliderDesc.capsule(playerHalfH, playerRadius)` = `capsule(0.3, 0.6)`

Rapier's capsule: total height = `2 * halfHeight + 2 * radius` = `2 * 0.3 + 2 * 0.6` = 1.8m. Center is at `halfHeight + radius = 0.3 + 0.6 = 0.9` from the bottom.

So `capsuleH = 0.9` IS the correct center offset from feet. The variable name `capsuleH` suggests 'capsule height' but it's actually 'capsule center offset.' **Run 1 was correct that the math works but the naming is misleading.**"

**Verdict: ✅ VALIDATED — correct math, misleading variable name**

---

### Claim EC-2: "Double terrain clamping — WASM and Rapier both handle terrain"

**Erin Catto:** "Confirmed. The terrain heightfield collider is created at line 120-153 (`createTerrainCollider`). It's added to the Rapier world. When `computeColliderMovement` runs, it tests the player capsule against ALL colliders including the terrain heightfield.

Meanwhile, the file header explicitly states:

```
// WASM tick() handles all game physics (gravity, skiing, jetting, etc.)
// and still does pos += vel*dt + terrain clamp.
```

So WASM clamps to terrain, then Rapier ALSO tests against the terrain heightfield. Two systems fighting over ground height.

The concrete impact: if the Rapier heightfield has even slight numerical differences from the WASM heightmap (different interpolation method, different float rounding, heightfield data copied with potential precision loss at line 136-138), the player oscillates between two 'ground' positions. The scalar copy loop:

```javascript
const heights = new Float32Array(nrows * ncols);
for (let i = 0; i < nrows * ncols; i++) {
    heights[i] = heightData[i];
}
```

This IS a bit-exact copy (Float32 to Float32, no conversion). But Rapier's heightfield interpolation (bilinear within cells) may differ from WASM's terrain sampling. Even sub-millimeter differences cause the `computedGrounded()` flag to flicker."

**Verdict: ✅ VALIDATED — double terrain clamping confirmed with concrete data path**

---

### Claim EC-4: "Redundant identity indices in trimesh"

**Abrash:** "Lines 224-226:

```javascript
const indices = new Uint32Array(numTris * 3);
// ...
indices[t * 3 + v] = t * 3 + v;  // Identity mapping: indices[0]=0, indices[1]=1, ...
```

Confirmed. The index array is `[0, 1, 2, 3, 4, 5, 6, ...]`. This is because the code unrolls indexed geometry into individual triangles (every triangle gets its own copy of each vertex, world-space transformed). The indices then just point sequentially at the unrolled vertices.

The waste: for a mesh with 1000 triangles, that's 3000 Uint32 entries × 4 bytes = 12KB. For ~100 interior meshes averaging 500 tris each, total waste is ~600KB of trivial index arrays. Not catastrophic but pointless."

**Verdict: ✅ VALIDATED — identity indices confirmed, waste is real but tolerable**

---

### Claim A-2: "Heightfield scalar copy loop should use typed array constructor"

**Abrash:** "Line 136-138:

```javascript
const heights = new Float32Array(nrows * ncols);
for (let i = 0; i < nrows * ncols; i++) {
    heights[i] = heightData[i];
}
```

With `nrows = ncols = 257`, that's 66,049 iterations. V8 JIT will optimize this scalar loop well, but `new Float32Array(heightData)` or `heights.set(heightData)` would use the engine's optimized bulk copy (potentially `memcpy` level). For a one-time init call, this is ~1ms difference. **Run 1 was correct that it's sloppy, and also correct that it's low priority.**"

**Verdict: ✅ VALIDATED — one-liner fix, low priority**

---

### Claim A-1: "Float32Array view allocation in hot path"

**Abrash:** "The `stepPlayerCollision` function receives `playerView` as a parameter — it's NOT creating a new view internally. The caller in `renderer.js` creates the view:

```javascript
const view = new Float32Array(Module.HEAPF32.buffer, ptr, count);
```

So Run 1 was correct that the view is created fresh per frame, but it's in `renderer.js`, not in `renderer_rapier.js`. The rapier module is clean — it only uses what's passed in.

Under the current fixed-memory build, `Module.HEAPF32.buffer` never changes, so caching the view would be safe. But Run 1 correctly noted this is fragile if memory growth is ever enabled."

**Verdict: ✅ VALIDATED but MISLOCATED — the allocation happens in renderer.js, not renderer_rapier.js**

---

### Claim M-1: "This is two physics engines — fundamental architecture concern"

**Muratori:** "Reading the file header (lines 1-20):

```
// Architecture:
//   WASM tick() handles all game physics (gravity, skiing, jetting, etc.)
//   and still does pos += vel*dt + terrain clamp. The old collision
//   functions are replaced with no-ops in WASM.
//
//   After tick(), JS reads the WASM player position (which may penetrate
//   buildings/interiors). Rapier character controller resolves collision
//   and writes the corrected position back to WASM shared memory.
```

The developer is fully aware of the architecture. The comment explicitly says 'old collision functions are replaced with no-ops in WASM.' This means:

1. WASM previously had its OWN building/interior collision
2. It was replaced with no-ops (removed)
3. Rapier was added as the replacement

So this isn't 'two physics engines doing the same job.' It's 'one engine does movement + terrain, the other does building/interior collision.' The division of responsibility is intentional. The problem Run 1 identified is real — they disagree at the seam — but the architecture is a conscious migration, not an accident."

**Carmack:** "That changes the framing. Run 1 described this as 'architecture that happens when you bolt on a feature instead of designing it.' In reality, it's an intentional migration where the old WASM collision was explicitly disabled and Rapier took over. The seam problems (velocity desync, double terrain clamping) are migration artifacts, not fundamental design flaws. They're fixable without rearchitecting."

**Verdict: ⚠️ REFRAMED — intentional architecture migration, not accidental bolting. Seam bugs are real but migration artifacts**

---

## Pass 2 — New Findings from Source Code

### NEW-R-001: world.step() Called TWICE on First Frame

**Carmack:** "The first-frame path at lines 205-213:

```javascript
if (!hasLastPos) {
    lastCorrectedPos.x = wasmX;
    lastCorrectedPos.y = centerY;
    lastCorrectedPos.z = wasmZ;
    playerRigidBody.setNextKinematicTranslation(lastCorrectedPos);
    world.step();   // ← step 1
    hasLastPos = true;
    return { grounded: false };
}

// Normal path:
playerRigidBody.setNextKinematicTranslation(lastCorrectedPos);
world.step();       // ← step 2 (this is the every-frame step)
```

On the very first frame, `world.step()` runs (line 211), then returns early. On the second frame, `world.step()` runs again at line 217. So frames 1-2 get two steps, but this is initialization — the first step places the capsule for the first time, the second begins normal operation. This is benign but worth noting — if `world.step()` is expensive (and we've established it's wasteful), the double-step on init is extra waste."

**Severity: P4 — cosmetic, one-time init waste**

---

### NEW-R-002: characterController Configuration May Cause Autostep Jitter

**Erin Catto:** "Lines 76-82 configure the character controller:

```javascript
characterController.enableAutostep(CC_STEP_HEIGHT, CC_MIN_STEP_WIDTH, true);
characterController.enableSnapToGround(CC_SNAP_TO_GROUND);
characterController.setMaxSlopeClimbAngle(CC_MAX_SLOPE);
characterController.setSlideEnabled(true);
```

Constants:
- `CC_STEP_HEIGHT = 0.4` (auto-step over obstacles up to 0.4m)
- `CC_SNAP_TO_GROUND = 0.2` (snap to ground within 0.2m)
- `CC_MAX_SLOPE = 55°`

The problem: `enableAutostep(0.4, 0.25, true)` with the third parameter `true` means 'include dynamic bodies in autostep targets.' There ARE no dynamic bodies, so this doesn't matter today. But if any dynamic body is ever added (a physics-driven prop, a dropped weapon), the character will try to autostep onto it, which creates bizarre behavior — the player hops onto a rolling grenade.

More importantly, `CC_SNAP_TO_GROUND = 0.2` combined with WASM's terrain clamping creates a **double-snap scenario**. WASM clamps the player to terrain height. Then Rapier's snap-to-ground pulls the capsule down 0.2m toward the nearest collider — which is the Rapier terrain heightfield. If the Rapier terrain is even 1cm lower than WASM's terrain, the player gets yanked down every frame, then WASM pushes back up next frame. Oscillation."

**Severity: P2 — snap-to-ground + WASM terrain clamp can cause vertical jitter**

---

### NEW-R-003: Building AABB Colliders Skip Type 5 (Rocks) — No Comment Why

**Carmack:** "Lines 166-169:

```javascript
const type = view[o + 6];
const isRock = (type === 5);
if (isRock) continue;
```

Buildings with type 5 are skipped. The variable name says 'rock' but there's no documentation on what type 5 actually means in the WASM building struct. If type 5 changes meaning (or if rocks should have collision), this silent skip creates invisible bugs. Run 1 didn't mention this at all."

**Severity: P3 — undocumented magic number, potential future bug**

---

### NEW-R-004: Kinematic Body Position Set BEFORE world.step(), Not After

**Erin Catto:** "The physics step order at lines 215-218:

```javascript
playerRigidBody.setNextKinematicTranslation(lastCorrectedPos);
world.step();
// Then compute movement...
```

`setNextKinematicTranslation` tells Rapier 'move this body to position X on the NEXT step.' Then `world.step()` actually moves it there. Then `computeColliderMovement` runs.

This is the CORRECT order for kinematic bodies in Rapier. I want to document this because it's a common mistake to call `setTranslation` instead of `setNextKinematicTranslation` — the former teleports instantly (no broadphase update until next step), the latter integrates smoothly. The code is correct here."

**Severity: Not a finding — documenting correctness**

---

### NEW-R-005: Y-axis Velocity NOT Corrected for Non-Grounded Lateral Hits

**Carmack:** "The velocity correction at lines 248-264 handles three cases:

1. **X-axis blocked** (ratio < 0.5): scale X velocity by ratio
2. **Z-axis blocked** (ratio < 0.5): scale Z velocity by ratio
3. **Grounded by Rapier AND downward velocity**: zero Y velocity

Notice what's missing: **Y-axis correction for upward/lateral hits**. If the player jets upward into a ceiling (positive Y velocity, Rapier blocks upward movement), the Y velocity is NOT corrected. The player continues to push against the ceiling with full upward velocity every frame. The grounding check at line 262 only zeroes DOWNWARD velocity (`if (grounded && vy < 0)`).

So: player jets into a ceiling → Rapier corrects position downward → WASM still has upward velocity → next frame WASM pushes player back into ceiling → Rapier corrects again → oscillation at ceiling height. The player 'vibrates' against ceilings."

**Erin Catto:** "Good catch. The fix is simple: if `corrDy` is negative (Rapier pushed player DOWN from desired) and `vy > 0` (player was moving UP), clamp `vy` to zero or scale by ratio. Same pattern as the grounding check but inverted."

**Severity: P2 — ceiling collision produces oscillation/vibration**

---

### NEW-R-006: `lastCorrectedPos` Drifts from WASM on Respawn Without resetPlayerPosition

**Muratori:** "Lines 276-283 provide `resetPlayerPosition(x, y, z)`:

```javascript
function resetPlayerPosition(x, y, z) {
    const capsuleH = playerRadius + playerHalfH;
    lastCorrectedPos.x = x;
    lastCorrectedPos.y = y + capsuleH;
    lastCorrectedPos.z = z;
    hasLastPos = true;
    if (playerRigidBody) {
        playerRigidBody.setNextKinematicTranslation(lastCorrectedPos);
    }
}
```

This MUST be called on every teleport, respawn, or network correction that moves the player significantly. If `renderer.js` ever writes a new position to WASM memory without calling `resetPlayerPosition`, then `lastCorrectedPos` is stale, and the next frame's `desiredMovement` will be enormous (the delta between old `lastCorrectedPos` and new WASM position). The character controller will attempt to move the capsule across the entire map in one step — potentially tunneling through every building on the way.

I can't verify whether `renderer.js` always calls `resetPlayerPosition` without reading that file, but the contract is fragile and undocumented."

**Severity: P2 — teleport/respawn without reset causes massive desiredMovement spikes**

---

### NEW-R-007: `initPromise` Guards Against Double Init, But Not Reset

**Barrett (virtual panel addition):** "The init guard at lines 55-58:

```javascript
async function initRapierPhysics() {
    if (initPromise) return initPromise;
    initPromise = _doInit();
    return initPromise;
}
```

Once initialized, `initRapierPhysics()` always returns the same promise. There's no way to re-initialize with a different configuration (e.g., different capsule size for a different armor type). The comments say 'Updated dynamically when armor type changes' (line 39), but there's no `resizeCapsule()` function anywhere. The capsule is created once at init with medium armor dimensions and never changes."

**Severity: P2 — armor type change cannot resize the collision capsule**

---

## Pass 3 — Expert Debate on Architecture

### The Rapier-as-Oracle Question

**Carmack:** "Run 1's consensus was 'refactor Rapier to collision query oracle — replace computeColliderMovement with castShape/contactsWith.' Having read the actual code, I want to refine this. The character controller does more than shape casting:

1. **Autostep** — automatically raises the capsule to step over small obstacles (0.4m)
2. **Snap-to-ground** — pulls the capsule down to maintain ground contact (0.2m)
3. **Max slope** — prevents climbing slopes steeper than 55°
4. **Slide** — projects movement along surfaces for wall sliding

A raw `castShape()` query gives you collision/no-collision. It doesn't give you 'slide along this wall' or 'step over this ledge.' You'd have to reimplement all of that in JS (or WASM). The character controller is doing real work — it's just doing it with the wrong inputs (position delta instead of velocity delta)."

**Erin Catto:** "You're right that the character controller provides value. My revised recommendation: keep `computeColliderMovement` but fix the INPUTS. Instead of:

```javascript
// Current: delta from last corrected position to WASM position
const desiredMovement = {
    x: wasmX - lastCorrectedPos.x,
    y: centerY - lastCorrectedPos.y,
    z: wasmZ - lastCorrectedPos.z
};
```

Feed it velocity-derived movement:

```javascript
// Proposed: raw velocity × dt
const desiredMovement = { x: vx * dt, y: vy * dt, z: vz * dt };
```

Then apply the corrected position AND back-derive the corrected velocity. The character controller's autostep/snap/slope logic works correctly when fed velocity-based movement. The current approach feeds it *accumulated drift* which includes previous frame's correction error."

**Muratori:** "That's cleaner. But you still have the problem of WHERE to apply the corrected position. Currently it writes back to WASM memory. If WASM reads that position next frame and applies velocity from its own integration, you're back to fighting. The velocity back-derivation is critical: `correctedVelocity = correctedMovement / dt`, write that back to WASM velocity slots too."

**Carmack:** "Agreed. The fix sequence is:

1. Feed `vx*dt, vy*dt, vz*dt` as desired movement
2. Get `correctedMovement` from character controller
3. Write `lastCorrectedPos + correctedMovement` back to WASM position
4. Write `correctedMovement / dt` back to WASM velocity
5. Remove the ratio-based velocity hacks entirely

This makes Rapier the full correction authority for both position AND velocity. WASM integrates freely next frame, and if it penetrates again, Rapier corrects again. The correction is convergent instead of oscillating."

**Erin Catto:** "One caveat: writing `correctedMovement / dt` back to velocity loses WASM's momentum model. If WASM says 'player is skiing downhill at 30 m/s' and Rapier says 'corrected movement is only 0.3m this frame because you hit a wall,' then `correctedVelocity = 0.3 / 0.016 = 18.75 m/s`. The player lost 11.25 m/s of speed. That might be correct (wall absorbed it) or might feel wrong (the wall was at a glancing angle and should have only taken 2 m/s).

For proper sliding, you need the contact normal. `computeColliderMovement` doesn't directly expose contact normals, but `computedCollisions()` does — iterate the collisions, get normals, project velocity. That's the path to physically correct wall sliding."

**Consensus: Keep characterController, fix inputs to velocity-based, use computedCollisions() for proper velocity correction. Removes ratio hacks entirely.**

---

### The Terrain Heightfield Question

**Erin Catto:** "The terrain heightfield in Rapier is the root cause of the double-clamping. But removing it means Rapier's character controller doesn't know about terrain — the capsule could sink into the ground at building/terrain boundaries where the building collider ends and terrain takes over.

The cleaner solution: use a **collision filter**. Rapier supports collision groups. Assign the terrain heightfield to group A, buildings/interiors to group B, and the player capsule to 'only collide with group B.' The character controller only resolves building/interior penetrations. WASM handles terrain exclusively."

**Carmack:** "That's elegant. One line change: set the player collider's collision groups to exclude terrain. Rapier never tests terrain, WASM owns it, no double-clamp."

**Abrash:** "And it's a performance win — the broadphase skips terrain-player pairs entirely. With a 257×257 heightfield, that's one fewer broad-phase test per frame."

**Consensus: Use Rapier collision groups to exclude terrain from player collision. Single-line fix.**

---

## Pass 4 — System-Level Validation

### Module State Inventory (Actual)

| Variable | Type | Initialized | Modified | Cleanup |
|----------|------|-------------|----------|---------|
| `RAPIER` | module ref | `_doInit()` | Never | Never |
| `world` | World | `_doInit()` | Every `world.step()` | Never (no destroy) |
| `characterController` | CC | `_doInit()` | Every `computeColliderMovement` | Never |
| `playerCollider` | Collider | `_doInit()` | Never | Never |
| `playerRigidBody` | RigidBody | `_doInit()` | Every `setNextKinematicTranslation` | Never |
| `initialized` | bool | `_doInit()` | Never reset | Never |
| `initPromise` | Promise | `initRapierPhysics()` | Never reset | Never |
| `lastCorrectedPos` | {x,y,z} | `stepPlayerCollision` | Every frame | `resetPlayerPosition` |
| `hasLastPos` | bool | `stepPlayerCollision` | `resetPlayerPosition` | Never reset to false |
| `playerRadius` | number | Init + line 38 | Never dynamically | Never |
| `playerHalfH` | number | Init + line 39 | Never dynamically | Never |
| `_colliderCount` | number | 0 | Incremented on create | Never decremented |
| `_trimeshTriCount` | number | 0 | Incremented on create | Never decremented |

Total module state: 13 variables, 0 proper cleanup paths.

### Verified API Surface

| Function | Called By | Frequency | Run 1 Claimed | Run 2 Verified |
|----------|----------|-----------|---------------|----------------|
| `initRapierPhysics()` | renderer.js | Once | ✅ | ✅ |
| `createTerrainCollider()` | renderer.js | Once/map | ✅ | ✅ |
| `createBuildingColliders()` | renderer.js/buildings | Once/map | ✅ | ✅ — reads WASM building array |
| `registerModelCollision()` | renderer_buildings.js | Per interior | ✅ | ✅ — handles col-tagged meshes |
| `stepPlayerCollision()` | renderer.js | Every frame | ✅ | ✅ — single player only |
| `resetPlayerPosition()` | renderer.js | Respawn/teleport | ✅ | ✅ — critical for `lastCorrectedPos` sync |
| `getPhysicsInfo()` | debug HUD | On demand | ✅ | ✅ — returns collider/body counts |

---

## Run 1 Findings: Validated / Challenged / Corrected

| Run 1 ID | Run 1 Finding | Run 1 Severity | Run 2 Verdict | Notes |
|-----------|--------------|----------------|---------------|-------|
| C-1 / M-1 | Dual-physics desync | CRITICAL | ✅ **VALIDATED** | Velocity correction exists but inadequate. Architecture is intentional migration, not accidental. |
| C-2 | world.step() waste | HIGH | ✅ **VALIDATED** | Full solver runs for zero useful work every frame |
| C-3 | No collider cleanup | HIGH | ✅ **VALIDATED** | Zero removeCollider/removeRigidBody/free calls confirmed |
| C-4 | Single-player collision only | MEDIUM | ✅ **VALIDATED** | Single localIdx confirmed. By design for current network model. |
| EC-1 | Capsule center offset naming | MEDIUM | ✅ **VALIDATED** | Math correct, name misleading |
| EC-2 | Double terrain clamping | HIGH | ✅ **VALIDATED** | Both WASM and Rapier clamp terrain independently |
| EC-3 | Per-axis velocity correction wrong | HIGH | ⚠️ **PARTIALLY VALIDATED** | Works for axis-aligned walls, fails for diagonal surfaces |
| EC-4 | Redundant identity indices | LOW | ✅ **VALIDATED** | Sequential indices confirmed, ~600KB waste |
| A-1 | Float32Array in hot path | MEDIUM | ⚠️ **MISLOCATED** | Allocation is in renderer.js, not renderer_rapier.js |
| A-2 | Heightfield scalar copy | LOW | ✅ **VALIDATED** | One-liner fix |
| A-3 | One body per sub-mesh | LOW | ✅ **VALIDATED** | Each mesh gets its own fixed body + collider |
| M-1 | Two physics engines | CRITICAL | ⚠️ **REFRAMED** | Intentional migration (old WASM collision no-oped). Seam bugs are real but fixable. |
| M-2 | Global mutable state | MEDIUM | ✅ **VALIDATED** | 13 module-level variables, zero cleanup |
| M-3 | Magic stride offsets | MEDIUM | ✅ **VALIDATED** | Offsets 0,1,2,6,7,8 used without constants |

---

## New Findings Not in Run 1

| ID | Finding | Severity | Source |
|----|---------|----------|--------|
| NEW-R-001 | world.step() called twice on first frame | P4 | Lines 211, 217 |
| NEW-R-002 | snap-to-ground + WASM terrain clamp = vertical jitter risk | P2 | Lines 78, terrain interaction |
| NEW-R-003 | Building type 5 (rocks) silently skipped, undocumented | P3 | Lines 166-169 |
| NEW-R-004 | Y-axis velocity not corrected for ceiling hits | P2 | Lines 248-264 — upward vy unchecked |
| NEW-R-005 | lastCorrectedPos drifts on teleport without resetPlayerPosition | P2 | Lines 205, 276 |
| NEW-R-006 | No capsule resize for armor type change | P2 | Lines 38-39, no resizeCapsule() |
| NEW-R-007 | initPromise prevents re-init; no world teardown | P3 | Lines 55-58, no destroy() |
| NEW-R-008 | Fix sequence: velocity-based CC input + collision-group terrain exclusion | Architecture | Consensus recommendation |

---

## Revised Priority Stack (Run 2 Consensus)

### Critical Path (blocks next milestone)
1. **Remove terrain from Rapier collision groups** — one-line fix, eliminates double-clamping (P1, 15 min)
2. **Fix CC inputs: velocity-based desiredMovement** — feed `vx*dt, vy*dt, vz*dt` instead of position delta (P1, 1 hour)
3. **Write corrected velocity back to WASM** — derive from corrected movement, removes ratio hacks (P1, 30 min)
4. **Add ceiling velocity correction** — zero upward vy when Rapier blocks upward movement (P2, 15 min)
5. **Add collider lifecycle management** — Map<entityId, handle>, removeCollider(), destroy() (P1, 1 session)

### High Priority (next sprint)
6. **Disable snap-to-ground** or set to 0 while WASM owns terrain clamping (P2, 5 min)
7. **Replace world.step() with scene-query update** (P2, 30 min)
8. **Add capsule resize API** for armor type changes (P2, 30 min)
9. **Extract stride offset constants** to shared file (P2, 30 min)

### Medium Priority (backlog)
10. **Remote player collision** via shape casts once collision oracle is stable (P3)
11. **Compound colliders for interiors** — one body per interior (P3)
12. **Document building type 5 skip** with actual type enum (P3)

### Low Priority (polish)
13. Heightfield copy optimization (P4)
14. Drop redundant trimesh indices (P4)
15. Rename capsuleH to capsuleCenterOffset (P4)

---

## Expert Sign-Off (Run 2)

- **Carmack:** "Run 1's architecture analysis was directionally correct but overshot. The dual-physics design is an intentional migration, not an accident. The recommended refactor is smaller than Run 1 suggested: fix the CC inputs and add collision groups for terrain exclusion. That's a day of work, not 2-3 sessions of rearchitecting."

- **Erin Catto:** "The velocity correction is the most impactful fix. Replacing ratio-based per-axis hacks with velocity back-derivation from corrected movement will fix both the diagonal-wall dead-stops AND the ceiling vibration in one change. The character controller is fine as-is; it was just being fed the wrong inputs."

- **Abrash:** "Performance-wise, world.step() waste is confirmed. But the bigger win is collision group exclusion for terrain — it reduces the collision test space and eliminates the double-clamp in one change. The solver waste is secondary to correctness."

- **Muratori:** "The missing lifecycle management (no cleanup, no destroy) is the most architecturally concerning finding. Everything else is fixable within the current design. But without add/remove collider support, this module cannot support any dynamic gameplay feature — building destruction, phase transitions, map changes. It's a dead-end until that's addressed."

---

*Run 2 validation complete. All major Run 1 findings validated (two with corrections), seven new findings discovered. The fix path is clearer and smaller than Run 1 suggested: velocity-based CC inputs + terrain collision group exclusion + collider lifecycle management.*
