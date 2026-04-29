// ============================================================
// R32.104: Rapier Physics Integration — renderer_rapier.js
// Replaces hand-rolled collision (resolvePlayerBuildingCollision,
// resolvePlayerInteriorCollision) with Rapier 3D character controller.
//
// @ai-contract
// PURPOSE: Rapier physics facade — terrain heightfield, building AABB,
//          interior trimesh colliders, and character controller resolution.
// SERVES: Scale (vast terrain collision), Aliveness (physical world interaction)
// DEPENDS_ON: vendor/rapier/rapier.mjs (Rapier WASM, v0.19.3)
// DEPENDS_ON: Module (Emscripten WASM) — player state, building data via HEAPF32
// EXPOSES: window.RapierPhysics { initRapierPhysics, createTerrainCollider,
//          createBuildingColliders, registerModelCollision, stepPlayerCollision,
//          resetPlayerPosition, resizeCapsuleForArmor, removeCollider,
//          removeAllBuildings, removeAllModels, destroy, getPhysicsInfo }
// PATTERN: IIFE + window.* facade (legacy — migrate to ES module per Item 24)
// PERF_BUDGET: stepPlayerCollision < 0.5ms/frame; world.step() with zero
//              dynamic bodies; broadphase update is the real cost.
// QUALITY_TIERS: N/A — physics runs identically on all tiers
// COORDINATE_SPACE: world (meters), Y-up
// LIFECYCLE: init → create colliders → per-frame step → removeCollider/destroy
//            Colliders tracked in _colliderRegistry Map<entityId, {collider,body}[]>
//            Keys: 'terrain', 'building:<idx>', 'model:<name>'
//            destroy() frees ALL resources; must call initRapierPhysics() again after.
//
// NEVER: create a collider without tracking it in _colliderRegistry
// NEVER: call world.step() outside stepPlayerCollision (one step per frame)
// ALWAYS: use removeCollider/removeAllBuildings/destroy for cleanup
// ALWAYS: pass entityId to registerModelCollision for lifecycle tracking
// BEFORE_MODIFY: read docs/lessons-learned.md, docs/patterns.md
// @end-ai-contract
//
// Architecture:
//   WASM tick() handles all game physics (gravity, skiing, jetting, etc.)
//   and still does pos += vel*dt + terrain clamp. The old collision
//   functions are replaced with no-ops in WASM.
//
//   After tick(), JS reads the WASM player position (which may penetrate
//   buildings/interiors). Rapier character controller resolves collision
//   and writes the corrected position back to WASM shared memory.
//
// Rapier colliders:
//   - Terrain: HeightField from JS heightmap data (_htData)
//   - Building AABBs: Cuboid colliders (generators, turrets, stations)
//   - Interior meshes: TriMesh colliders from Three.js geometry
//
// Uses @dimforge/rapier3d-compat v0.19.3 (WASM inlined as base64)
// Vendored at vendor/rapier/rapier.mjs
// ============================================================

// Rapier will be loaded dynamically; we store the module ref here
let RAPIER = null;

// Module state
let world = null;
let characterController = null;
let playerCollider = null;
let playerRigidBody = null;
let initialized = false;
let initPromise = null;

// Track the last Rapier-corrected position so we can compute deltas
let lastCorrectedPos = { x: 0, y: 100, z: 0 };
let hasLastPos = false;

// Player capsule dimensions — medium armor defaults
// Updated dynamically when armor type changes
let playerRadius = 0.6;
let playerHalfH = 0.3; // half of cylinder part (capsule = cylinder + 2 hemispheres)

// Character controller settings
const CC_OFFSET = 0.02;           // gap between character and environment
const CC_MAX_SLOPE = 55 * Math.PI / 180; // ~55° max climbable slope (Tribes has steep terrain)
const CC_STEP_HEIGHT = 0.4;       // auto-step over obstacles up to 0.4m
const CC_MIN_STEP_WIDTH = 0.25;
const CC_SNAP_TO_GROUND = 0.2;    // snap distance

// R32.162: Collision groups — separate terrain from buildings/interiors.
// WASM handles terrain clamping; Rapier should only resolve building/interior collision.
// Format: (filter << 16) | membership  (Rapier u32 collision groups)
const CG_TERRAIN_MEMBERSHIP = 0x0002;  // group 1 (bit 1)
const CG_BUILDING_MEMBERSHIP = 0x0004; // group 2 (bit 2)
// Player filter: interact with buildings (group 2) and interiors (group 2), NOT terrain (group 1)
const CG_PLAYER_GROUPS = (0xFFFC << 16) | 0x0001; // member=group0, filter=all except terrain(group1)

// Diagnostics
let _colliderCount = 0;
let _trimeshTriCount = 0;

// R32.176: Collider lifecycle tracking — Map<entityId, {collider, body}[]>
// Keys: 'terrain', 'building:<index>', 'model:<name|id>'
// Each entry is an array because a single entity (e.g. an interior model)
// may produce multiple trimesh colliders from its sub-meshes.
const _colliderRegistry = new Map();

// ============================================================
// Init
// ============================================================

/**
 * Initialize Rapier WASM and create physics world.
 * Returns a promise. Safe to call multiple times (returns same promise).
 */
async function initRapierPhysics() {
    if (initPromise) return initPromise;
    initPromise = _doInit();
    return initPromise;
}

async function _doInit() {
    console.log('[R32.104] Initializing Rapier physics...');
    const t0 = performance.now();

    // Dynamic import from vendored ESM module
    const mod = await import('./vendor/rapier/rapier.mjs');
    // The module has named exports (World, ColliderDesc, etc.) and a default export.
    // Use the module namespace directly so all names are accessible via RAPIER.X
    RAPIER = mod;

    // The -compat package needs an explicit init() call to load its inlined WASM
    if (typeof RAPIER.init === 'function') {
        await RAPIER.init();
    }

    // Create physics world — zero gravity (WASM handles all movement physics)
    const gravity = { x: 0.0, y: 0.0, z: 0.0 };
    world = new RAPIER.World(gravity);

    // Create character controller
    characterController = world.createCharacterController(CC_OFFSET);
    characterController.enableAutostep(CC_STEP_HEIGHT, CC_MIN_STEP_WIDTH, true);
    // R32.165: Snap-to-ground DISABLED. WASM owns terrain clamping; snap-to-ground
    // was fighting it by pulling the player 0.2m down to Rapier's heightfield surface
    // every frame. With terrain excluded from CC (Item 10), snap would only affect
    // building floors — but those are flat surfaces where autostep already handles
    // step-ups and the CC_OFFSET gap (0.02m) is negligible.
    // Was: characterController.enableSnapToGround(CC_SNAP_TO_GROUND);
    characterController.setMaxSlopeClimbAngle(CC_MAX_SLOPE);
    characterController.setSlideEnabled(true);

    // Create player rigid body (kinematic position-based)
    const bodyDesc = RAPIER.RigidBodyDesc.kinematicPositionBased()
        .setTranslation(0, 100, 0);
    playerRigidBody = world.createRigidBody(bodyDesc);

    // Create player capsule collider
    // capsule(halfHeight, radius) — halfHeight is half the cylinder part
    playerHalfH = 0.3; // medium armor: total height ~1.8m, radius 0.6
    playerRadius = 0.6;
    const colliderDesc = RAPIER.ColliderDesc.capsule(playerHalfH, playerRadius);
    // R32.162: Player collision group — excludes terrain (WASM handles terrain)
    colliderDesc.setCollisionGroups(CG_PLAYER_GROUPS);
    playerCollider = world.createCollider(colliderDesc, playerRigidBody);

    initialized = true;
    const dt = (performance.now() - t0).toFixed(1);
    console.log(`[R32.104] Rapier initialized in ${dt}ms (world ready, character controller created)`);
}

// ============================================================
// Terrain
// ============================================================

/**
 * Create a heightfield collider for the terrain.
 * Called after initTerrain() has populated _htData.
 *
 * NOTE: Caller must call destroy() or removeCollider('terrain') before
 * re-creating terrain on map change — otherwise the old heightfield leaks.
 *
 * @param {Float32Array} heightData - Row-major heights (size × size)
 * @param {number} size - Grid dimension (e.g. 257)
 * @param {number} worldScale - Meters per grid cell (e.g. 8.0)
 */
function createTerrainCollider(heightData, size, worldScale) {
    if (!world || !RAPIER) {
        console.warn('[R32.104] createTerrainCollider: Rapier not ready');
        return;
    }
    const t0 = performance.now();

    // Rapier heightfield: nrows × ncols grid, heights array.
    // The field is centered at the rigid body origin.
    // Our terrain spans from -(size-1)*scale/2 to +(size-1)*scale/2 on X and Z.
    // With the body at (0,0,0), Rapier will center it automatically.
    const nrows = size;
    const ncols = size;

    // Make a copy for Rapier (it takes ownership)
    const heights = new Float32Array(nrows * ncols);
    for (let i = 0; i < nrows * ncols; i++) {
        heights[i] = heightData[i];
    }

    // Rapier heightfield scale: the total extent in X and Z
    // Rapier's heightfield spans [-0.5, 0.5] in local X and Z, then scaled.
    // So scale.x = total width, scale.z = total depth.
    const totalSpan = (size - 1) * worldScale;
    const scaleVec = { x: totalSpan, y: 1.0, z: totalSpan };

    const bodyDesc = RAPIER.RigidBodyDesc.fixed()
        .setTranslation(0, 0, 0);
    const body = world.createRigidBody(bodyDesc);

    const colliderDesc = RAPIER.ColliderDesc.heightfield(
        nrows, ncols, heights, scaleVec
    );
    // R32.162: Put terrain in its own collision group so character controller ignores it.
    // WASM handles all terrain clamping; Rapier should only resolve building/interior collisions.
    colliderDesc.setCollisionGroups((0xFFFF << 16) | CG_TERRAIN_MEMBERSHIP);
    const collider = world.createCollider(colliderDesc, body);
    _colliderCount++;

    // R32.176: Track terrain collider for lifecycle management
    _colliderRegistry.set('terrain', [{ collider, body }]);

    console.log(`[R32.104] Terrain heightfield: ${nrows}×${ncols}, span=${totalSpan.toFixed(0)}m, ${(performance.now() - t0).toFixed(1)}ms`);
}

// ============================================================
// Buildings (AABB cuboids)
// ============================================================

/**
 * Create cuboid colliders for building AABBs.
 * Reads building data from WASM shared memory.
 */
function createBuildingColliders() {
    if (!world || !RAPIER) {
        console.warn('[R32.104] createBuildingColliders: Rapier not ready');
        return;
    }
    if (!Module._getBuildingPtr || !Module._getBuildingCount || !Module._getBuildingStride) {
        console.warn('[R32.104] createBuildingColliders: WASM building API not available');
        return;
    }

    const t0 = performance.now();
    const ptr = Module._getBuildingPtr();
    const count = Module._getBuildingCount();
    const stride = Module._getBuildingStride();
    const view = new Float32Array(Module.HEAPF32.buffer, ptr, count * stride);
    let added = 0;

    for (let b = 0; b < count; b++) {
        const o = b * stride;
        const px = view[o], py = view[o + 1], pz = view[o + 2];
        const hx = view[o + 3], hy = view[o + 4], hz = view[o + 5];
        const type = view[o + 6];
        const isRock = (type === 5);
        if (isRock) continue;

        const bodyDesc = RAPIER.RigidBodyDesc.fixed()
            .setTranslation(px, py, pz);
        const body = world.createRigidBody(bodyDesc);

        const colliderDesc = RAPIER.ColliderDesc.cuboid(hx, hy, hz);
        // R32.162: Building collision group — interacts with player
        colliderDesc.setCollisionGroups((0xFFFF << 16) | CG_BUILDING_MEMBERSHIP);
        const collider = world.createCollider(colliderDesc, body);

        // R32.176: Track building collider for removal on destruction/map change
        _colliderRegistry.set(`building:${b}`, [{ collider, body }]);
        added++;
    }

    _colliderCount += added;
    console.log(`[R32.104] Building colliders: ${added} cuboids, ${(performance.now() - t0).toFixed(1)}ms`);
}

// ============================================================
// Interior mesh trimesh colliders
// ============================================================

/**
 * Create trimesh colliders from a Three.js Object3D hierarchy.
 * This is the Rapier replacement for the old registerModelCollision()
 * that sent triangles to WASM.
 *
 * @param {THREE.Object3D} root - Root scene graph node
 * @param {THREE.Matrix4} [worldMatrix] - Optional override world matrix
 * @param {string} [entityId] - Optional entity identifier for lifecycle tracking
 * @returns {{ meshCount: number, triCount: number }}
 */
function rapierRegisterModelCollision(root, worldMatrix, entityId) {
    if (!world || !RAPIER) {
        console.warn('[R32.104] registerModelCollision: Rapier not ready, falling back to no-op');
        return { meshCount: 0, triCount: 0 };
    }

    const t0 = performance.now();

    // Collect meshes, separating collision-tagged from visual
    const colMeshes = [];
    const visMeshes = [];
    root.traverse(child => {
        if (!child.isMesh) return;
        const name = (child.name || '').toLowerCase();
        if (name.endsWith('_collision') || name.endsWith('_col')) {
            colMeshes.push(child);
        } else {
            visMeshes.push(child);
        }
    });

    const sources = colMeshes.length > 0 ? colMeshes : visMeshes;
    for (const m of colMeshes) m.visible = false;

    let totalMeshes = 0, totalTris = 0;
    const entityEntries = [];  // R32.176: collect collider+body pairs for lifecycle tracking

    for (const mesh of sources) {
        const geo = mesh.geometry;
        if (!geo || !geo.attributes || !geo.attributes.position) continue;

        mesh.updateWorldMatrix(true, false);
        const mat = worldMatrix
            ? mesh.matrixWorld.clone().premultiply(worldMatrix)
            : mesh.matrixWorld;
        const me = mat.elements;

        const pos = geo.attributes.position;
        const idx = geo.index;
        const numTris = idx ? (idx.count / 3) | 0 : (pos.count / 3) | 0;
        if (numTris === 0) continue;

        // Build vertices array (world-space) and indices
        const verts = new Float32Array(numTris * 3 * 3);
        const indices = new Uint32Array(numTris * 3);

        for (let t = 0; t < numTris; t++) {
            for (let v = 0; v < 3; v++) {
                const vi = idx ? idx.getX(t * 3 + v) : t * 3 + v;
                const x = pos.getX(vi), y = pos.getY(vi), z = pos.getZ(vi);
                const wx = me[0]*x + me[4]*y + me[8]*z  + me[12];
                const wy = me[1]*x + me[5]*y + me[9]*z  + me[13];
                const wz = me[2]*x + me[6]*y + me[10]*z + me[14];
                const vIdx = (t * 3 + v) * 3;
                verts[vIdx]     = wx;
                verts[vIdx + 1] = wy;
                verts[vIdx + 2] = wz;
                indices[t * 3 + v] = t * 3 + v;
            }
        }

        // Create Rapier trimesh
        const bodyDesc = RAPIER.RigidBodyDesc.fixed();
        const body = world.createRigidBody(bodyDesc);
        const colliderDesc = RAPIER.ColliderDesc.trimesh(verts, indices);
        if (colliderDesc) {
            // R32.162: Interior collision group — same as buildings, interacts with player
            colliderDesc.setCollisionGroups((0xFFFF << 16) | CG_BUILDING_MEMBERSHIP);
            const collider = world.createCollider(colliderDesc, body);
            entityEntries.push({ collider, body });  // R32.176: track for lifecycle
            _colliderCount++;
            totalMeshes++;
            totalTris += numTris;
            _trimeshTriCount += numTris;
        }
    }

    const dt = (performance.now() - t0).toFixed(1);
    console.log(`[R32.104] registerModelCollision → Rapier: ${totalMeshes} meshes, ${totalTris} tris, ${dt}ms`);

    // R32.176: Track colliders by entity ID for removal
    if (entityEntries.length > 0) {
        const key = entityId || `model:${root.name || root.uuid || totalMeshes}`;
        const existing = _colliderRegistry.get(key);
        if (existing) {
            existing.push(...entityEntries);
        } else {
            _colliderRegistry.set(key, entityEntries);
        }
    }

    return { meshCount: totalMeshes, triCount: totalTris };
}

// ============================================================
// Per-frame collision step
// ============================================================

/**
 * Resolve player collision via Rapier character controller.
 * Called after Module._tick() each frame.
 *
 * Flow:
 *   1. Read WASM player pos (which may penetrate buildings/interiors)
 *   2. Compute desired movement delta from last corrected position
 *   3. Use character controller to resolve against colliders
 *   4. Write corrected position back to WASM shared memory
 *   5. Return grounded state for the JS-side onGround flag
 *
 * @param {Float32Array} playerView - HEAPF32 view of RenderPlayer states
 * @param {number} stride - Floats per player (32)
 * @param {number} localIdx - Index of local player
 * @param {number} dt - Frame delta in seconds
 * @returns {{ grounded: boolean }}
 */
function stepPlayerCollision(playerView, stride, localIdx, dt) {
    if (!initialized || !characterController || !playerCollider) {
        return { grounded: false };
    }

    const o = localIdx * stride;
    const wasmX = playerView[o + 0];
    const wasmY = playerView[o + 1]; // feet position
    const wasmZ = playerView[o + 2];
    const vx = playerView[o + 6];
    const vy = playerView[o + 7];
    const vz = playerView[o + 8];

    // Capsule center offset from feet
    const capsuleH = playerRadius + playerHalfH; // half total height
    const centerY = wasmY + capsuleH;

    if (!hasLastPos) {
        // First frame: no previous position, just set and skip
        lastCorrectedPos.x = wasmX;
        lastCorrectedPos.y = centerY;
        lastCorrectedPos.z = wasmZ;
        playerRigidBody.setNextKinematicTranslation(lastCorrectedPos);
        world.step();
        hasLastPos = true;
        return { grounded: false };
    }

    // Place the rigid body at the last corrected position
    playerRigidBody.setNextKinematicTranslation(lastCorrectedPos);
    world.step();

    // R32.163: Velocity-based CC inputs.
    // Was: desiredMovement = wasmPos - lastCorrectedPos (position delta).
    // Problem: position deltas accumulate error because lastCorrectedPos may
    // diverge from WASM pos over time (Rapier correction vs WASM terrain clamp).
    // Fix: Use WASM velocity * dt as the movement vector. This is what the player
    // INTENDS to move, not where WASM ended up after terrain clamp.
    const desiredMovement = {
        x: vx * dt,
        y: vy * dt,
        z: vz * dt
    };

    // Keep capsule center at WASM pos (re-sync every frame to prevent drift)
    lastCorrectedPos.x = wasmX;
    lastCorrectedPos.y = centerY;
    lastCorrectedPos.z = wasmZ;

    // Use character controller to resolve collisions
    // R32.162: Pass collision filter to exclude terrain (WASM handles terrain clamping)
    characterController.computeColliderMovement(
        playerCollider,
        desiredMovement,
        undefined,        // filterFlags (default)
        CG_PLAYER_GROUPS  // filterGroups — excludes terrain collision group
    );

    const corrected = characterController.computedMovement();
    const grounded = characterController.computedGrounded();

    // New corrected capsule center position (from WASM pos + Rapier correction)
    const newX = wasmX + corrected.x;
    const newY = centerY + corrected.y;
    const newZ = wasmZ + corrected.z;

    // Convert back to feet
    const newFeetY = newY - capsuleH;

    // Store for next frame
    lastCorrectedPos.x = newX;
    lastCorrectedPos.y = newY;
    lastCorrectedPos.z = newZ;

    // Write corrected position back to WASM
    playerView[o + 0] = newX;
    playerView[o + 1] = newFeetY;
    playerView[o + 2] = newZ;

    // Adjust velocity if Rapier significantly changed the movement
    if (dt > 0.0001) {
        const corrDx = corrected.x - desiredMovement.x;
        const corrDy = corrected.y - desiredMovement.y;
        const corrDz = corrected.z - desiredMovement.z;

        // If movement was blocked laterally, zero that velocity component
        if (Math.abs(corrDx) > 0.01 && Math.abs(desiredMovement.x) > 0.01) {
            // Rapier blocked some X movement — reduce velocity proportionally
            const ratio = desiredMovement.x !== 0 ? corrected.x / desiredMovement.x : 0;
            if (ratio < 0.5) playerView[o + 6] = vx * Math.max(0, ratio);
        }
        if (Math.abs(corrDz) > 0.01 && Math.abs(desiredMovement.z) > 0.01) {
            const ratio = desiredMovement.z !== 0 ? corrected.z / desiredMovement.z : 0;
            if (ratio < 0.5) playerView[o + 8] = vz * Math.max(0, ratio);
        }

        // If grounded by Rapier, zero downward velocity
        if (grounded && vy < 0) {
            playerView[o + 7] = 0;
        }

        // R32.164: Ceiling hit — zero upward velocity when Rapier blocks Y movement.
        // Without this, a jetting player hitting a ceiling keeps vy > 0, causing them
        // to "stick" to the ceiling until jet energy runs out. The player should fall
        // immediately on ceiling contact.
        if (!grounded && vy > 0 && corrected.y < desiredMovement.y * 0.5) {
            playerView[o + 7] = 0;
        }
    }

    return { grounded };
}

/**
 * Reset the tracked position (call on respawn/teleport).
 */
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

// ============================================================
// R32.173: Collider Lifecycle Management
// ============================================================

/**
 * Remove all colliders (and their rigid bodies) for a given entity ID.
 * Entity IDs follow the convention:
 *   'terrain'          — the heightfield collider
 *   'building:<index>' — a building AABB cuboid
 *   'model:<name>'     — one or more trimesh colliders from registerModelCollision
 *
 * @param {string} entityId - The entity key used when the collider was created
 * @returns {number} Number of colliders removed
 */
function removeCollider(entityId) {
    if (!world) return 0;
    const entries = _colliderRegistry.get(entityId);
    if (!entries) return 0;

    let removed = 0;
    for (const entry of entries) {
        try {
            if (entry.collider) {
                world.removeCollider(entry.collider, true); // true = wake up touching bodies
            }
            if (entry.body) {
                world.removeRigidBody(entry.body);
            }
            removed++;
        } catch (e) {
            console.warn(`[R32.173] removeCollider(${entityId}): error freeing`, e);
        }
    }

    _colliderRegistry.delete(entityId);
    _colliderCount -= removed;
    return removed;
}

/**
 * Remove ALL building colliders. Useful on map change.
 * @returns {number} Number of colliders removed
 */
function removeAllBuildings() {
    if (!world) return 0;
    let total = 0;
    const toRemove = [];
    for (const key of _colliderRegistry.keys()) {
        if (key.startsWith('building:')) {
            toRemove.push(key);
        }
    }
    for (const key of toRemove) {
        total += removeCollider(key);
    }
    console.log(`[R32.173] removeAllBuildings: ${total} colliders removed`);
    return total;
}

/**
 * Remove ALL model (interior/trimesh) colliders. Useful on map change.
 * @returns {number} Number of colliders removed
 */
function removeAllModels() {
    if (!world) return 0;
    let total = 0;
    const toRemove = [];
    for (const key of _colliderRegistry.keys()) {
        if (key.startsWith('model:')) {
            toRemove.push(key);
        }
    }
    for (const key of toRemove) {
        total += removeCollider(key);
    }
    console.log(`[R32.173] removeAllModels: ${total} colliders removed`);
    return total;
}

/**
 * Full teardown — free ALL Rapier resources.
 * Call on map change or session end.
 * After destroy(), initRapierPhysics() must be called again to use physics.
 */
function destroy() {
    if (!world) return;
    console.log('[R32.173] Destroying Rapier physics world...');

    // Remove all tracked colliders + bodies
    for (const key of [..._colliderRegistry.keys()]) {
        removeCollider(key);
    }
    _colliderRegistry.clear();

    // Remove player collider + body
    try {
        if (playerCollider) world.removeCollider(playerCollider, false);
        if (playerRigidBody) world.removeRigidBody(playerRigidBody);
    } catch (e) {
        console.warn('[R32.173] destroy: error removing player', e);
    }
    playerCollider = null;
    playerRigidBody = null;

    // Free the character controller
    if (characterController) {
        try { characterController.free(); } catch (e) { /* already freed */ }
        characterController = null;
    }

    // Free the world
    try { world.free(); } catch (e) { /* already freed */ }
    world = null;

    // Reset state
    initialized = false;
    initPromise = null;
    hasLastPos = false;
    lastCorrectedPos = { x: 0, y: 100, z: 0 };
    _colliderCount = 0;
    _trimeshTriCount = 0;

    console.log('[R32.173] Rapier physics world destroyed');
}

// ============================================================
// Diagnostics
// ============================================================
function getPhysicsInfo() {
    return {
        initialized,
        colliderCount: _colliderCount,
        trimeshTriCount: _trimeshTriCount,
        trackedEntities: _colliderRegistry.size,
        worldBodies: world ? world.bodies.len() : 0,
        worldColliders: world ? world.colliders.len() : 0
    };
}

// ============================================================
// R32.224: Armor-based capsule resize
// ============================================================
// Tribes armor dimensions (approximate from Darkstar source):
//   Light:  radius ~0.4m, halfHeight ~0.3m  (total height ~1.0m + 2×0.4 caps = ~1.8m)
//   Medium: radius ~0.5m, halfHeight ~0.35m (total height ~1.2m + 2×0.5 caps = ~2.2m)  [NOTE: init uses 0.6/0.3]
//   Heavy:  radius ~0.6m, halfHeight ~0.4m  (total height ~1.2m + 2×0.6 caps = ~2.4m)
// The existing init hardcodes medium (0.6 radius, 0.3 halfH). We keep those as
// the baseline and scale the others relative to it.
const ARMOR_CAPSULE = [
    { radius: 0.45, halfH: 0.25 },  // 0 = light
    { radius: 0.60, halfH: 0.30 },  // 1 = medium (matches init default)
    { radius: 0.70, halfH: 0.40 },  // 2 = heavy
];

/**
 * Resize the player capsule collider for a different armor type.
 * Must be called AFTER initRapierPhysics() resolves.
 * @param {number} armorIdx - 0=light, 1=medium, 2=heavy
 */
function resizeCapsuleForArmor(armorIdx) {
    if (!initialized || !world || !playerRigidBody) return;
    const dims = ARMOR_CAPSULE[armorIdx] || ARMOR_CAPSULE[1]; // default medium
    if (dims.radius === playerRadius && dims.halfH === playerHalfH) return; // no change

    // Remove old collider
    if (playerCollider) {
        world.removeCollider(playerCollider, false);
    }

    // Update module-level dimensions (used by stepPlayerCollision)
    playerRadius = dims.radius;
    playerHalfH = dims.halfH;

    // Create new capsule collider with updated dimensions
    const colliderDesc = RAPIER.ColliderDesc.capsule(playerHalfH, playerRadius);
    colliderDesc.setCollisionGroups(CG_PLAYER_GROUPS);
    playerCollider = world.createCollider(colliderDesc, playerRigidBody);

    console.log(`[R32.224] Capsule resized for armor ${armorIdx}: radius=${playerRadius}, halfH=${playerHalfH}`);
}

// ============================================================
// Exports — attached to window for non-module scripts
// ============================================================
window.RapierPhysics = {
    initRapierPhysics,
    createTerrainCollider,
    createBuildingColliders,
    registerModelCollision: rapierRegisterModelCollision,
    stepPlayerCollision,
    resetPlayerPosition,
    resizeCapsuleForArmor,
    // R32.173: Collider lifecycle management
    removeCollider,
    removeAllBuildings,
    removeAllModels,
    destroy,
    getPhysicsInfo
};

// Also expose Rapier's registerModelCollision for external callers
// (renderer.js's own registerModelCollision already delegates to RapierPhysics when available)

console.log('[R32.104] renderer_rapier.js loaded (Rapier physics module)');
