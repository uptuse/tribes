// ============================================================
// renderer_kenney_base.js — R32.292
//
// Kenney "Modular Buildings" prefab — an "inspired-by"
// recreation of the Raindance DS (team 0) main base.
//
// Why this exists:
//   - The canonical Raindance bases are single-mesh blobs imported
//     from the original Tribes 1 .DTS files. They have known
//     collision quirks (cracks, thin invisible walls, terrain
//     intersection). The user wants a base that "interacts better
//     with characters" — which Kenney's pieces do, because each
//     piece is a watertight modular sci-fi component on a 4 m grid
//     with a 5.25 m floor-to-ceiling height.
//   - Not a 1:1 reproduction. Captures the spirit:
//        ground floor — generator + entry
//        mid floor   — inventory + ammo + command
//        roof        — flag spawn + observation deck
//
// Coordinate convention:
//   - Tribes MIS:  (X, Y, Z=up), left-handed
//   - Three.js:    (X, Y=up, Z=south), right-handed
//   - toWorld([x,y,z]) = { x, y: z, z: -y }
//   - DS base anchor in Tribes coords: (-260, 0, 8)  (Z=8 ≈ ground)
//   - DS base anchor in Three coords:  (-260, 8, 0)
//
// Activation:
//   - Off by default. Enable with URL ?kenneyBase=1
//
// Scale convention:
//   - Kenney pieces are 4 m grid, 5.25 m story.
//   - All pieces placed at scale 1.0 — coords are in meters and
//     match the world unit system 1:1.
// ============================================================

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const KENNEY_PATH = './assets/buildings/kenney-modular/';

// Anchor in Three.js world coords. Tribes (-260, 0, 8) → Three (-260, 8, 0)
const ANCHOR = { x: -260, y: 8, z: 0 };

// Kenney pieces: each piece is a 4 m floor tile with a 5.25 m floor-to-ceiling.
// `pos` is offset from the anchor; `yaw` is rotation around world Y in radians.
const STORY = 5.25;

// Layout: a stepped base with three floors and a roof deck.
// I'm using room-large for the ground (20×20 m) and progressively
// smaller rooms above for visual variety.
const PREFAB = [
    // ---- Ground floor: large room, generator chamber -----
    { file: 'room-large.glb', pos: [  0, 0,   0 ], yaw: 0, tag: 'gen-room' },

    // ---- Stairs going up the +X side, ground -> first floor -----
    { file: 'stairs.glb',     pos: [ 12, 0,   0 ], yaw: -Math.PI/2, tag: 'stairs-1' },

    // ---- First floor: medium room, inv + ammo zone -----
    { file: 'room-small.glb', pos: [  0, STORY,   0 ], yaw: 0, tag: 'inv-room' },

    // ---- Stairs first -> second floor -----
    { file: 'stairs.glb',     pos: [ 12, STORY,   0 ], yaw: -Math.PI/2, tag: 'stairs-2' },

    // ---- Second floor: small room, command station -----
    { file: 'room-small-variation.glb', pos: [ 0, STORY*2, 0 ], yaw: 0, tag: 'cmd-room' },

    // ---- Stairs second floor -> roof deck -----
    { file: 'stairs.glb',     pos: [ 12, STORY*2, 0 ], yaw: -Math.PI/2, tag: 'stairs-3' },

    // ---- Roof deck: open floor with parapet walls -----
    { file: 'template-floor-big.glb', pos: [ 0,  STORY*3,        0 ], yaw: 0, tag: 'roof' },
    // Parapet walls — N, S, E, W edges of the 8×8 m roof plate
    { file: 'template-wall.glb',      pos: [ 0,  STORY*3,       -4 ], yaw: 0,            tag: 'roof-N' },
    { file: 'template-wall.glb',      pos: [ 0,  STORY*3,        4 ], yaw: Math.PI,      tag: 'roof-S' },
    { file: 'template-wall.glb',      pos: [-4,  STORY*3,        0 ], yaw: -Math.PI/2,   tag: 'roof-W' },
    { file: 'template-wall.glb',      pos: [ 4,  STORY*3,        0 ], yaw:  Math.PI/2,   tag: 'roof-E' },

    // ---- Entry gate at ground level, +Z side (facing midfield/north) -----
    { file: 'gate-door.glb',  pos: [  0, 0,  10 ], yaw: 0, tag: 'entry' },
];

let kenneyBaseGroup = null;

export function initKenneyBase(scene) {
    // Gate behind URL flag so the canonical base stays the default.
    if (typeof location === 'undefined' || !/[?&]kenneyBase=1\b/.test(location.search)) {
        console.log('[R32.292] Kenney base disabled (add ?kenneyBase=1 to URL to enable)');
        return;
    }

    kenneyBaseGroup = new THREE.Group();
    kenneyBaseGroup.name = 'KenneyDSBase';
    kenneyBaseGroup.position.set(ANCHOR.x, ANCHOR.y, ANCHOR.z);
    scene.add(kenneyBaseGroup);

    const loader = new GLTFLoader();
    let placed = 0;
    let failed = 0;

    PREFAB.forEach((piece) => {
        loader.load(
            KENNEY_PATH + piece.file,
            (gltf) => {
                const m = gltf.scene;
                m.position.set(piece.pos[0], piece.pos[1], piece.pos[2]);
                m.rotation.y = piece.yaw;
                m.userData.tag = piece.tag;
                m.userData.kind = 'kenneyBase';
                // Cast and receive shadows so they integrate with the world lighting
                m.traverse((c) => {
                    if (c.isMesh) {
                        c.castShadow = true;
                        c.receiveShadow = true;
                        // Skip the toonification pass (which can flatten Kenney's
                        // gradient-shaded look)
                        if (c.material) {
                            const mats = Array.isArray(c.material) ? c.material : [c.material];
                            mats.forEach((mat) => { mat.userData.isInterior = true; });
                        }
                    }
                });
                kenneyBaseGroup.add(m);
                placed++;
                if (placed + failed === PREFAB.length) {
                    console.log(`[R32.292] Kenney DS base built: ${placed}/${PREFAB.length} pieces (${failed} failed)`);
                }
            },
            undefined,
            (err) => {
                failed++;
                console.warn(`[R32.292] Failed to load ${piece.file}:`, err.message || err);
                if (placed + failed === PREFAB.length) {
                    console.log(`[R32.292] Kenney DS base built: ${placed}/${PREFAB.length} pieces (${failed} failed)`);
                }
            }
        );
    });
}
