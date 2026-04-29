// renderer_buildings.js — Modular building integration system
// Loads building layouts from JSON, places Kenney modular pieces,
// registers Rapier box colliders per piece.
//
// Usage:
//   import * as Buildings from './renderer_buildings.js';
//   await Buildings.init(scene, rapierWorld, charController);
//   // Buildings are now loaded, visible, and collidable.

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

// ── Config ──────────────────────────────────────────────────
const CATALOG_URL = 'assets/buildings/catalog.json';
const LAYOUTS_URL = 'assets/buildings/layouts.json';
const GRID = 4.0;           // meters per grid unit (XZ)
const FLOOR_H = 4.25;       // meters per floor (Y)
const DEBUG_COLLIDERS = false; // set true to render green wireframe boxes

// ── State ───────────────────────────────────────────────────
let _catalog = null;        // piece definitions
let _layouts = null;        // building placement data
let _glbCache = {};         // pieceId → THREE.Group (template)
let _scene = null;
let _buildingsGroup = null; // parent group for all building meshes
let _colliderBodies = [];   // Rapier rigid body handles
let _rapierWorld = null;
let _RAPIER = null;

// ── Public API ──────────────────────────────────────────────

/**
 * Initialize the modular building system.
 * @param {THREE.Scene} scene
 * @param {object} rapierWorld - RAPIER.World instance
 * @param {object} RAPIER - the RAPIER module (for creating collider descs)
 * @param {object} [opts] - options
 * @param {boolean} [opts.visible=true] - render Kenney meshes (false = collision only)
 * @param {boolean} [opts.debug=false] - render wireframe collider boxes
 */
export async function init(scene, rapierWorld, RAPIER, opts = {}) {
    _scene = scene;
    _rapierWorld = rapierWorld;
    _RAPIER = RAPIER;

    const visible = opts.visible !== false;
    const debug = opts.debug || DEBUG_COLLIDERS;

    // 1. Load catalog + layouts
    const [catResp, layResp] = await Promise.all([
        fetch(CATALOG_URL).then(r => r.json()),
        fetch(LAYOUTS_URL).then(r => r.json()).catch(() => ({ buildings: [] }))
    ]);
    _catalog = catResp;
    _layouts = layResp;

    console.log(`[Buildings] Catalog: ${Object.keys(_catalog.pieces).length} piece types`);
    console.log(`[Buildings] Layouts: ${_layouts.buildings.length} buildings`);

    // 2. Preload all GLBs referenced by layouts
    const neededPieces = new Set();
    for (const bld of _layouts.buildings) {
        for (const p of bld.pieces) {
            neededPieces.add(p.id);
        }
    }
    await _preloadGLBs(neededPieces);

    // 3. Create parent group
    _buildingsGroup = new THREE.Group();
    _buildingsGroup.name = 'ModularBuildings';
    _scene.add(_buildingsGroup);

    // 4. Place buildings
    for (const bld of _layouts.buildings) {
        _placeBuilding(bld, visible, debug);
    }

    console.log(`[Buildings] Placed ${_layouts.buildings.length} buildings, ${_colliderBodies.length} colliders`);
}

/**
 * Get the buildings group (for toggling visibility, raycasting, etc.)
 */
export function getGroup() {
    return _buildingsGroup;
}

/**
 * Get all collider bodies (for cleanup)
 */
export function getColliderBodies() {
    return _colliderBodies;
}

// ── Internals ───────────────────────────────────────────────

async function _preloadGLBs(pieceIds) {
    const loader = new GLTFLoader();
    const basePath = _catalog._meta.basePath;
    const promises = [];

    for (const id of pieceIds) {
        const def = _catalog.pieces[id];
        if (!def) {
            console.warn(`[Buildings] Unknown piece: ${id}`);
            continue;
        }
        if (_glbCache[id]) continue;

        const url = basePath + def.glb;
        promises.push(
            new Promise((resolve) => {
                loader.load(url, (gltf) => {
                    _glbCache[id] = gltf.scene;
                    resolve();
                }, undefined, (err) => {
                    console.error(`[Buildings] Failed to load ${url}:`, err);
                    resolve();
                });
            })
        );
    }

    await Promise.all(promises);
    console.log(`[Buildings] Preloaded ${promises.length} GLBs`);
}

function _placeBuilding(bld, visible, debug) {
    const bldGroup = new THREE.Group();
    bldGroup.name = bld.name || 'building';
    bldGroup.position.set(bld.pos[0], bld.pos[1], bld.pos[2]);
    if (bld.rot) {
        bldGroup.rotation.y = (bld.rot * Math.PI) / 180;
    }

    for (const piece of bld.pieces) {
        _placePiece(bldGroup, piece, bld, visible, debug);
    }

    _buildingsGroup.add(bldGroup);
}

function _placePiece(bldGroup, piece, bld, visible, debug) {
    const def = _catalog.pieces[piece.id];
    if (!def) return;

    const template = _glbCache[piece.id];
    if (!template) return;

    // Clone mesh
    const mesh = template.clone();
    mesh.name = piece.id;
    mesh.visible = visible;

    // Grid position → world position (relative to building origin)
    const gx = (piece.grid[0] || 0) * GRID;
    const gy = (piece.grid[1] || 0) * FLOOR_H;
    const gz = (piece.grid[2] || 0) * GRID;
    mesh.position.set(gx, gy, gz);

    // Piece rotation (0, 90, 180, 270 degrees)
    if (piece.rot) {
        mesh.rotation.y = (piece.rot * Math.PI) / 180;
    }

    bldGroup.add(mesh);

    // Register colliders
    if (_rapierWorld && _RAPIER && def.colliders) {
        // Compute world transform for this piece
        mesh.updateMatrixWorld(true);
        const worldPos = new THREE.Vector3();
        mesh.getWorldPosition(worldPos);
        const worldQuat = new THREE.Quaternion();
        mesh.getWorldQuaternion(worldQuat);

        for (const col of def.colliders) {
            _registerCollider(col, worldPos, worldQuat, piece.rot || 0, debug);
        }
    }
}

function _registerCollider(col, pieceWorldPos, pieceWorldQuat, pieceDegRot, debug) {
    if (col.type !== 'box') {
        console.warn('[Buildings] Unsupported collider type:', col.type);
        return;
    }

    // Collider position relative to piece origin
    const localPos = new THREE.Vector3(col.pos[0], col.pos[1], col.pos[2]);
    // Rotate local position by piece rotation
    localPos.applyQuaternion(pieceWorldQuat);
    // Add to piece world position
    const worldX = pieceWorldPos.x + localPos.x;
    const worldY = pieceWorldPos.y + localPos.y;
    const worldZ = pieceWorldPos.z + localPos.z;

    // Half-extents
    const hx = col.size[0] / 2;
    const hy = col.size[1] / 2;
    const hz = col.size[2] / 2;

    // Create Rapier static body + collider
    const bodyDesc = _RAPIER.RigidBodyDesc.fixed()
        .setTranslation(worldX, worldY, worldZ)
        .setRotation(pieceWorldQuat);
    const body = _rapierWorld.createRigidBody(bodyDesc);
    const colliderDesc = _RAPIER.ColliderDesc.cuboid(hx, hy, hz);
    _rapierWorld.createCollider(colliderDesc, body);
    _colliderBodies.push(body);

    // Debug visualization
    if (debug) {
        const geo = new THREE.BoxGeometry(col.size[0], col.size[1], col.size[2]);
        const mat = new THREE.MeshBasicMaterial({
            color: col.role === 'floor' ? 0x00ff00 : col.role === 'ceiling' ? 0x0000ff : 0xff0000,
            wireframe: true,
            transparent: true,
            opacity: 0.4,
        });
        const box = new THREE.Mesh(geo, mat);
        box.position.set(worldX, worldY, worldZ);
        box.quaternion.copy(pieceWorldQuat);
        _scene.add(box);
    }
}
