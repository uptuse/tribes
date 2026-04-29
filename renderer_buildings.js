// @ai-contract
// PURPOSE: Modular building system — loads building layouts from JSON, places Kenney
//   modular pieces via InstancedMesh, registers Rapier box colliders per piece.
//   Handles building geometry lifecycle (init, dispose, disposeAll)
// SERVES: Belonging (bases are home — generator rooms, inventory stations, flag stands)
// DEPENDS_ON: three, GLTFLoader (addon), Rapier (passed via init args: rapierWorld, RAPIER),
//   assets/buildings/catalog.json, assets/buildings/layouts.json
// EXPOSES: ES module exports: init(scene, rapierWorld, RAPIER, opts), dispose(),
//   disposeAll(), getGroup(), getColliderBodies(). No window.* globals
// LIFECYCLE: init(scene, rapierWorld, RAPIER) → loads catalog + layouts + GLBs →
//   creates InstancedMesh per piece type per building → registers Rapier colliders.
//   dispose() cleans materials + debug + colliders (preserves GLB cache).
//   disposeAll() also frees GLB geometry cache
// COORDINATE_SPACE: world (meters), Y-up. Grid=4.0m, floor height=4.25m
// PATTERN: ES module with init()/dispose()/disposeAll() lifecycle. ONE InstancedMesh
//   per sub-mesh per piece type per building for tight frustum culling
// BEFORE_MODIFY: read docs/lessons-learned.md. Geometry owned by GLB cache — never
//   dispose in dispose(), only in disposeAll(). init() returns shared Promise —
//   concurrent callers get same result
// NEVER: dispose GLB cache geometry in dispose() (only in disposeAll)
// ALWAYS: register Rapier colliders for new building pieces
// ALWAYS: use module-scope temp allocations (_tmpMat4a, _tmpVec3, etc.) for transforms
// @end-ai-contract
//
// renderer_buildings.js — Modular building integration system
// Loads building layouts from JSON, places Kenney modular pieces via InstancedMesh,
// registers Rapier box colliders per piece.
//
// Architecture:
//   - ONE InstancedMesh per sub-mesh per piece type PER BUILDING (tight frustum culling)
//   - One Rapier body per piece, multiple box colliders per body
//   - Geometry owned by GLB cache — never disposed by dispose(), only by disposeAll()
//   - Module-scope temp allocations for transform computation
//   - init() returns a shared Promise — concurrent callers get the same result
//
// Ownership:
//   - BufferGeometry → GLB cache (dispose only in disposeAll)
//   - Cloned Materials → _ownedMaterials (dispose in dispose)
//   - Debug geometry → _debugGroup (dispose in dispose)
//   - Rapier bodies → _colliderBodies (removed in dispose)
//   - getGroup() return value is invalidated by dispose()

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

// ── Config ──────────────────────────────────────────────────
const CATALOG_URL = 'assets/buildings/catalog.json';
const LAYOUTS_URL = 'assets/buildings/layouts.json';
const GRID = 4.0;
const FLOOR_H = 4.25;
const VALID_ROTATIONS = new Set([0, 90, 180, 270]);

// ── Module-scope temps (reused across all transform computation) ──
const _tmpMat4a = new THREE.Matrix4();
const _tmpMat4b = new THREE.Matrix4();
const _tmpVec3 = new THREE.Vector3();
const _tmpQuat = new THREE.Quaternion();
const _tmpScale = new THREE.Vector3();

// ── State ───────────────────────────────────────────────────
let _catalog = null;
let _layouts = null;
let _glbCache = {};         // pieceId → THREE.Group (GLB template) — survives dispose()
let _scene = null;
let _buildingsGroup = null;
let _debugGroup = null;
let _ownedMaterials = [];   // materials we cloned — we own these, dispose them
let _instancedMeshes = [];  // InstancedMesh refs (geometry owned by GLB cache, NOT by us)
let _colliderBodies = [];   // Rapier rigid body handles
let _rapierWorld = null;
let _RAPIER = null;
let _initPromise = null;    // shared promise for concurrent init() callers

// ── Public API ──────────────────────────────────────────────

/**
 * Initialize the modular building system. Returns a shared Promise —
 * concurrent callers receive the same promise and wait for the same result.
 * @param {THREE.Scene} scene
 * @param {object} rapierWorld - RAPIER.World instance
 * @param {object} RAPIER - the RAPIER module
 * @param {object} [opts]
 * @param {boolean} [opts.visible=true] - render meshes
 * @param {boolean} [opts.debug=false] - render wireframe collider boxes
 * @returns {Promise<boolean>} true if initialized, false on error/abort
 */
export function init(scene, rapierWorld, RAPIER, opts = {}) {
    if (_initPromise) return _initPromise;
    if (_buildingsGroup) {
        dispose();
    }
    _initPromise = _initInternal(scene, rapierWorld, RAPIER, opts)
        .finally(() => { _initPromise = null; });
    return _initPromise;
}

async function _initInternal(scene, rapierWorld, RAPIER, opts) {
    _scene = scene;
    _rapierWorld = rapierWorld;
    _RAPIER = RAPIER;

    const visible = opts.visible !== false;
    const debug = !!opts.debug;

    // 1. Load catalog + layouts
    let catResp, layResp;
    try {
        [catResp, layResp] = await Promise.all([
            fetch(CATALOG_URL).then(r => { if (!r.ok) throw new Error(`catalog ${r.status}`); return r.json(); }),
            fetch(LAYOUTS_URL).then(r => { if (!r.ok) throw new Error(`layouts ${r.status}`); return r.json(); })
        ]);
    } catch (e) {
        console.error('[Buildings] Failed to load data files:', e);
        _scene = null; _rapierWorld = null; _RAPIER = null;
        return false;
    }

    // Abort check — dispose() clears _initPromise via .finally, but also
    // nulls _scene. If scene is gone, someone called dispose mid-flight.
    if (!_scene) { console.warn('[Buildings] init() aborted'); return false; }

    _catalog = catResp;
    _layouts = layResp;
    if (!_catalog.pieces || !_layouts.buildings) {
        console.error('[Buildings] Malformed catalog or layouts');
        _scene = null; _rapierWorld = null; _RAPIER = null;
        return false;
    }

    console.log(`[Buildings] Catalog: ${Object.keys(_catalog.pieces).length} piece types, ${_layouts.buildings.length} buildings`);

    // 2. Preload GLBs
    const neededPieces = new Set();
    for (const bld of _layouts.buildings) {
        if (!Array.isArray(bld.pieces)) continue;
        for (const p of bld.pieces) neededPieces.add(p.id);
    }
    await _preloadGLBs(neededPieces);
    if (!_scene) { console.warn('[Buildings] init() aborted'); return false; }

    // 3. Scene graph
    _buildingsGroup = new THREE.Group();
    _buildingsGroup.name = 'ModularBuildings';
    _scene.add(_buildingsGroup);

    if (debug) {
        _debugGroup = new THREE.Group();
        _debugGroup.name = 'ModularBuildings_Debug';
        _scene.add(_debugGroup);
    }

    // 4. Process each building
    let totalBodies = 0;
    let totalDrawCalls = 0;

    for (const bld of _layouts.buildings) {
        if (!Array.isArray(bld.pos) || bld.pos.length < 3 || !Array.isArray(bld.pieces)) {
            console.warn(`[Buildings] Skipping malformed building "${bld.name}"`);
            continue;
        }

        // Building world matrix — _tmpMat4a is stable for the entire piece loop
        _tmpMat4a.identity();
        if (bld.rot) _tmpMat4a.makeRotationY((bld.rot * Math.PI) / 180);
        _tmpMat4a.setPosition(bld.pos[0], bld.pos[1], bld.pos[2]);

        // Collect per-piece-type instance matrices FOR THIS BUILDING
        // Map<pieceId, Matrix4[]>  — pos/quat derived on demand from matrices
        const pieceInstances = new Map();

        for (const piece of bld.pieces) {
            const def = _catalog.pieces[piece.id];
            if (!def) continue;

            const rot = piece.rot ?? 0;
            if (!VALID_ROTATIONS.has(((rot % 360) + 360) % 360)) {
                console.warn(`[Buildings] Piece "${piece.id}" non-90° rotation (${rot}°)`);
            }

            const grid = piece.grid;
            if (!Array.isArray(grid) || grid.length < 3) continue;

            // Piece local matrix
            _tmpMat4b.identity();
            if (rot) _tmpMat4b.makeRotationY((rot * Math.PI) / 180);
            _tmpMat4b.setPosition(
                (grid[0] ?? 0) * GRID,
                (grid[1] ?? 0) * FLOOR_H,
                (grid[2] ?? 0) * GRID
            );

            // World = building × piece
            const worldMatrix = new THREE.Matrix4().multiplyMatrices(_tmpMat4a, _tmpMat4b);

            if (!pieceInstances.has(piece.id)) pieceInstances.set(piece.id, []);
            pieceInstances.get(piece.id).push(worldMatrix);
        }

        // Create instanced meshes for this building
        const bldGroup = new THREE.Group();
        bldGroup.name = bld.name || 'building';

        if (visible) {
            for (const [pieceId, matrices] of pieceInstances) {
                const template = _glbCache[pieceId];
                if (!template) continue;

                const templateMeshes = [];
                template.traverse(child => { if (child.isMesh) templateMeshes.push(child); });
                if (templateMeshes.length === 0) continue;

                const count = matrices.length;

                for (const tmesh of templateMeshes) {
                    // Geometry: BORROWED from GLB cache — never dispose
                    const geom = tmesh.geometry;
                    // Material: CLONED — we own the clone
                    // Note: textures (e.g. colormap.png) are shared by reference, not cloned.
                    // This is intentional — texture memory is managed by Three.js renderer.
                    const mat = tmesh.material.clone();
                    _ownedMaterials.push(mat);

                    const instMesh = new THREE.InstancedMesh(geom, mat, count);
                    instMesh.name = `${pieceId}_inst_${bld.name || 'bld'}`;
                    instMesh.castShadow = true;
                    instMesh.receiveShadow = true;

                    for (let i = 0; i < count; i++) {
                        instMesh.setMatrixAt(i, matrices[i]);
                    }
                    instMesh.instanceMatrix.needsUpdate = true;
                    instMesh.computeBoundingSphere();

                    bldGroup.add(instMesh);
                    _instancedMeshes.push(instMesh);
                    totalDrawCalls++;
                }
            }
        }

        _buildingsGroup.add(bldGroup);

        // Create colliders for this building
        for (const [pieceId, matrices] of pieceInstances) {
            const def = _catalog.pieces[pieceId];
            if (!def || !def.colliders || def.colliders.length === 0) continue;

            for (let i = 0; i < matrices.length; i++) {
                // Decompose matrix to pos+quat using module-scope temps
                matrices[i].decompose(_tmpVec3, _tmpQuat, _tmpScale);

                const bodyDesc = _RAPIER.RigidBodyDesc.fixed()
                    .setTranslation(_tmpVec3.x, _tmpVec3.y, _tmpVec3.z)
                    .setRotation(_tmpQuat);
                const body = _rapierWorld.createRigidBody(bodyDesc);

                for (const col of def.colliders) {
                    if (col.type !== 'box') continue;
                    const colliderDesc = _RAPIER.ColliderDesc.cuboid(
                        col.size[0] / 2, col.size[1] / 2, col.size[2] / 2
                    ).setTranslation(col.pos[0], col.pos[1], col.pos[2]);
                    _rapierWorld.createCollider(colliderDesc, body);
                }

                _colliderBodies.push(body);
                totalBodies++;

                if (debug && _debugGroup) {
                    for (const col of def.colliders) {
                        if (col.type !== 'box') continue;
                        _addDebugBox(col, _tmpVec3, _tmpQuat);
                    }
                }
            }
        }
    }

    console.log(`[Buildings] Done — ${totalDrawCalls} draw calls, ${totalBodies} Rapier bodies`);
    return true;
}

/**
 * Tear down meshes and colliders. GLB cache + geometry preserved for re-init.
 * Invalidates any references previously returned by getGroup().
 */
export function dispose() {
    // Signal any in-flight init to abort (it checks _scene after each await)
    _scene = null;

    for (const mat of _ownedMaterials) mat.dispose();
    _ownedMaterials = [];
    _instancedMeshes = [];

    if (_buildingsGroup) {
        _buildingsGroup.parent?.remove(_buildingsGroup);
        _buildingsGroup = null;
    }
    if (_debugGroup) {
        _disposeGroup(_debugGroup);
        _debugGroup.parent?.remove(_debugGroup);
        _debugGroup = null;
    }
    if (_rapierWorld) {
        for (const body of _colliderBodies) {
            try { _rapierWorld.removeRigidBody(body); } catch (_) {}
        }
    }
    _colliderBodies = [];
    _catalog = null; _layouts = null;
    _rapierWorld = null; _RAPIER = null;
    console.log('[Buildings] Disposed');
}

/**
 * Full teardown including GLB cache and all geometry.
 */
export function disposeAll() {
    dispose();
    for (const key in _glbCache) _disposeGroup(_glbCache[key]);
    _glbCache = {};
    console.log('[Buildings] Disposed all (including GLB cache)');
}

/**
 * Get the buildings group for visibility toggling, raycasting, etc.
 * Return value is invalidated by dispose() — do not cache across init/dispose cycles.
 */
export function getGroup() { return _buildingsGroup; }

/** Get a snapshot of collider bodies (copy). */
export function getColliderBodies() { return _colliderBodies.slice(); }

// ── Internals ───────────────────────────────────────────────

function _disposeGroup(group) {
    group.traverse(child => {
        if (child.isMesh) {
            child.geometry?.dispose();
            const mats = Array.isArray(child.material) ? child.material : [child.material];
            for (const m of mats) m?.dispose();
        }
    });
}

async function _preloadGLBs(pieceIds) {
    const loader = new GLTFLoader();
    const basePath = _catalog._meta.basePath;
    const promises = [];
    const failed = [];

    for (const id of pieceIds) {
        const def = _catalog.pieces[id];
        if (!def) { console.warn(`[Buildings] Unknown piece: "${id}"`); continue; }
        if (_glbCache[id]) continue;
        const url = basePath + def.glb;
        promises.push(
            loader.loadAsync(url)
                .then(gltf => { _glbCache[id] = gltf.scene; })
                .catch(err => { console.error(`[Buildings] GLB load failed ${url}:`, err); failed.push(id); })
        );
    }
    await Promise.all(promises);
    console.log(`[Buildings] Preloaded ${promises.length - failed.length}/${promises.length} GLBs` +
        (failed.length ? ` (failed: ${failed.join(', ')})` : ''));
}

function _addDebugBox(col, worldPos, worldQuat) {
    // Note: worldPos/worldQuat may be module-scope temps — read immediately, don't store refs
    const px = col.pos[0], py = col.pos[1], pz = col.pos[2];
    _tmpVec3.set(px, py, pz);
    _tmpVec3.applyQuaternion(worldQuat);

    let color;
    switch (col.role) {
        case 'floor':   color = 0x00ff00; break;
        case 'ceiling': color = 0x0000ff; break;
        case 'step':    color = 0xffff00; break;
        default:        color = 0xff0000; break;
    }
    const geo = new THREE.BoxGeometry(col.size[0], col.size[1], col.size[2]);
    const mat = new THREE.MeshBasicMaterial({ color, wireframe: true, transparent: true, opacity: 0.4 });
    const box = new THREE.Mesh(geo, mat);
    box.position.set(worldPos.x + _tmpVec3.x, worldPos.y + _tmpVec3.y, worldPos.z + _tmpVec3.z);
    box.quaternion.copy(worldQuat);
    _debugGroup.add(box);
}
