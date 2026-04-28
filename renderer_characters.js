// ============================================================
// R32.109: Rigged GLB Character Models
// ============================================================
// Loads the Mixamo-rigged crimson_sentinel GLB (18 animation clips),
// replaces the procedural player model for the local player in 3P,
// and spawns a demo character that cycles animations nearby.
//
// Integration: renderer.js imports this module, calls init(scene)
// during setup, and sync(t, ...) each frame after syncPlayers().
// ============================================================

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { clone as skeletonClone } from 'three/addons/utils/SkeletonUtils.js';

// ── Module state ────────────────────────────────────────────
let _gltf = null;
let _scene = null;
let _loaded = false;
let _lastT = 0;
let _footOffset = 0; // Y shift so model feet touch ground (computed from bounding box)

// Per-slot character instances (indexed by player slot)
const _chars = new Array(16).fill(null);

// Demo character (standalone, always visible)
let _demo = null;
let _demoSpawned = false;

// ── Public API ──────────────────────────────────────────────

/**
 * Initialize character system. Call once after scene is created.
 */
export function init(targetScene) {
    _scene = targetScene;
    const loader = new GLTFLoader();
    loader.load('./assets/models/crimson_sentinel_rigged.glb', (gltf) => {
        _gltf = gltf;
        _loaded = true;

        // R32.112: Compute foot offset so model stands on ground, not floating.
        // GLB origin may be at center; we need the distance from origin to the
        // lowest point of the mesh so we can shift the model down by that amount.
        const box = new THREE.Box3().setFromObject(gltf.scene);
        _footOffset = box.min.y; // negative if origin is above feet
        console.log('[R32.112] Foot offset:', _footOffset.toFixed(3),
            'bbox Y range:', box.min.y.toFixed(2), '→', box.max.y.toFixed(2));

        console.log('[R32.109] Character model loaded:',
            gltf.animations.length, 'clips,',
            gltf.scene.children.length, 'root nodes');
        // Log clip names for debugging
        for (const clip of gltf.animations) {
            console.log(`  [R32.109] clip: ${clip.name} (${clip.duration.toFixed(2)}s)`);
        }
    }, undefined, (err) => {
        console.error('[R32.109] Failed to load character model:', err);
    });
}

export function isLoaded() { return _loaded; }

/**
 * Per-frame sync. Call from render loop after syncPlayers(t).
 * @param {number} t - current time in seconds (performance.now() * 0.001)
 * @param {Float32Array} playerView - WASM player state view
 * @param {number} playerStride - floats per player
 * @param {number} localIdx - local player index
 * @param {Array} playerMeshes - procedural mesh array (to hide when GLB is shown)
 */
export function sync(t, playerView, playerStride, localIdx, playerMeshes) {
    if (!_loaded) return;

    const dt = _lastT > 0 ? Math.min(0.1, t - _lastT) : 1 / 60;
    _lastT = t;

    // --- Local player character (3P mode) ---
    _syncLocalPlayer(t, dt, playerView, playerStride, localIdx, playerMeshes);

    // --- Demo character ---
    if (!_demoSpawned && localIdx >= 0 && playerView && playerStride > 0) {
        _spawnDemo(playerView, playerStride, localIdx);
    }
    if (_demo) {
        _updateDemo(t, dt);
    }
}

// ── Instance management ─────────────────────────────────────

function _createInstance() {
    if (!_gltf) return null;

    const model = skeletonClone(_gltf.scene);
    const mixer = new THREE.AnimationMixer(model);

    // Index clips by name
    const clips = {};
    for (const clip of _gltf.animations) {
        clips[clip.name] = clip;
    }

    // Configure rendering
    model.traverse(child => {
        child.frustumCulled = false;
        if (child.isMesh || child.isSkinnedMesh) {
            child.castShadow = true;
            child.receiveShadow = true;
            // R32.112: Match scene lighting — other objects use envMapIntensity 0.30–0.50.
            // GLB materials default to 1.0, making the character glow vs surroundings.
            if (child.material) {
                child.material.envMapIntensity = 0.4;
                child.material.needsUpdate = true;
            }
        }
    });

    _scene.add(model);

    return {
        model,
        mixer,
        clips,
        activeClip: null,
        activeAction: null,
    };
}

function _playClip(inst, name, opts = {}) {
    if (!inst || inst.activeClip === name) return;
    if (!inst.clips[name]) {
        // Fallback to idle if clip not found
        if (name !== 'idle' && inst.clips['idle']) {
            name = 'idle';
        } else {
            return;
        }
    }

    const clip = inst.clips[name];
    const action = inst.mixer.clipAction(clip);
    const fade = opts.fade ?? 0.15;

    if (inst.activeAction) {
        inst.activeAction.fadeOut(fade);
    }

    action.reset().fadeIn(fade);
    if (opts.once) {
        action.setLoop(THREE.LoopOnce);
        action.clampWhenFinished = true;
    }
    action.play();

    inst.activeAction = action;
    inst.activeClip = name;
}

// ── Local player sync ───────────────────────────────────────

function _syncLocalPlayer(t, dt, playerView, playerStride, localIdx, playerMeshes) {
    if (localIdx < 0 || !playerView || playerStride <= 0) return;

    const is3P = (typeof Module !== 'undefined' && Module._getThirdPerson && Module._getThirdPerson());
    const o = localIdx * playerStride;
    const alive = playerView[o + 13] > 0.5;
    const visible = playerView[o + 18] > 0.5;

    if (is3P && visible) {
        // Ensure character instance exists
        if (!_chars[localIdx]) {
            _chars[localIdx] = _createInstance();
            if (_chars[localIdx]) {
                console.log('[R32.109] Created GLB character for local player (3P)');
            }
        }

        const char = _chars[localIdx];
        if (!char) return;

        // Hide procedural mesh, show GLB
        if (playerMeshes[localIdx]) playerMeshes[localIdx].visible = false;
        char.model.visible = true;

        // Position + rotation (R32.112: subtract _footOffset so feet touch ground)
        char.model.position.set(
            playerView[o],
            playerView[o + 1] - _footOffset,
            playerView[o + 2]
        );
        char.model.rotation.set(0, -playerView[o + 4], 0, 'YXZ');

        // Determine animation from game state
        const speed = Math.hypot(playerView[o + 6], playerView[o + 8]);
        const jetting = playerView[o + 14] > 0.5;
        const skiing = playerView[o + 15] > 0.5;

        let clip = 'idle';
        if (!alive) {
            clip = 'death';
        } else if (jetting) {
            clip = 'jet';
        } else if (skiing) {
            clip = 'ski';
        } else if (speed > 0.5) {
            clip = 'run';
        }

        _playClip(char, clip, { once: clip === 'death' });
        char.mixer.update(dt);
    } else {
        // Not in 3P or not visible — hide GLB character
        if (_chars[localIdx]) {
            _chars[localIdx].model.visible = false;
        }
    }
}

// ── Demo character ──────────────────────────────────────────

function _spawnDemo(playerView, playerStride, localIdx) {
    const o = localIdx * playerStride;
    if (playerView[o + 18] < 0.5) return; // player not visible yet (still loading)

    _demo = _createInstance();
    if (!_demo) return;
    _demoSpawned = true;

    // Place demo 8m in front of player's initial facing direction
    const yaw = playerView[o + 4];
    _demo.baseX = playerView[o] + Math.sin(yaw) * 8;
    _demo.baseY = playerView[o + 1] - _footOffset; // R32.112: ground the model
    _demo.baseZ = playerView[o + 2] + Math.cos(yaw) * 8;
    _demo.model.position.set(_demo.baseX, _demo.baseY, _demo.baseZ);
    _demo.time = 0;

    _playClip(_demo, 'idle');
    console.log('[R32.109] Demo character spawned at',
        _demo.baseX.toFixed(0), _demo.baseY.toFixed(0), _demo.baseZ.toFixed(0));
}

function _updateDemo(t, dt) {
    _demo.time += dt;
    const tt = _demo.time;

    // 20-second animation cycle: run → idle → ski → jet → fire → idle
    const cycle = tt % 24;
    let clip = 'idle';

    if (cycle < 8) {
        // Run in a circle
        clip = 'run';
        const angle = tt * 0.6;
        const r = 6;
        _demo.model.position.set(
            _demo.baseX + Math.cos(angle) * r,
            _demo.baseY,
            _demo.baseZ + Math.sin(angle) * r
        );
        _demo.model.rotation.y = -(angle + Math.PI * 0.5);
    } else if (cycle < 11) {
        // Idle
        clip = 'idle';
        _demo.model.position.set(_demo.baseX, _demo.baseY, _demo.baseZ);
    } else if (cycle < 15) {
        // Ski in a wider circle
        clip = 'ski';
        const angle = tt * 1.0;
        const r = 10;
        _demo.model.position.set(
            _demo.baseX + Math.cos(angle) * r,
            _demo.baseY,
            _demo.baseZ + Math.sin(angle) * r
        );
        _demo.model.rotation.y = -(angle + Math.PI * 0.5);
    } else if (cycle < 18) {
        // Jet upward
        clip = 'jet';
        const jetPhase = (cycle - 15) / 3;
        _demo.model.position.set(
            _demo.baseX,
            _demo.baseY + Math.sin(jetPhase * Math.PI) * 6, // baseY already foot-offset corrected
            _demo.baseZ
        );
    } else if (cycle < 21) {
        // Fire rifle
        clip = 'fire_rifle';
        _demo.model.position.set(_demo.baseX, _demo.baseY, _demo.baseZ);
    } else {
        // Idle cooldown
        clip = 'idle';
        _demo.model.position.set(_demo.baseX, _demo.baseY, _demo.baseZ);
    }

    _playClip(_demo, clip);
    _demo.mixer.update(dt);
}
