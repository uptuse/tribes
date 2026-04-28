// ============================================================
// R32.113: Rigged GLB Character Models
// ============================================================
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { clone as skeletonClone } from 'three/addons/utils/SkeletonUtils.js';

let _gltf = null;
let _scene = null;
let _loaded = false;
let _lastT = 0;

// Grounding: after scaling, how far below model.position.y are the feet?
// Computed on load so we can place model.position.y = playerY - _footOffset
// and have feet exactly at playerY.
let _footOffset = 0;
let _modelScale = 1.0;

const _chars = new Array(16).fill(null);
let _demo = null;
let _demoSpawned = false;

// ── Public API ──────────────────────────────────────────────

export function init(targetScene) {
    _scene = targetScene;
    const loader = new GLTFLoader();
    loader.load('./assets/models/crimson_sentinel_rigged.glb', (gltf) => {
        _gltf = gltf;
        _loaded = true;

        // R32.125: Strip ALL Hips position (root motion). Position is WASM-driven.
        // We'll compute the foot offset from the skeleton below.
        for (const clip of gltf.animations) {
            clip.tracks = clip.tracks.filter(track => {
                if (track.name.endsWith('.position') && track.name.includes('Hips')) {
                    return false; // remove entirely
                }
                return true;
            });
        }

        // R32.126: Compute foot offset — play one frame of idle to find how far
        // below the origin the feet actually are, then use that to lift the model.
        {
            const tmpModel = gltf.scene;
            const tmpMixer = new THREE.AnimationMixer(tmpModel);
            const idleClip = gltf.animations.find(c => c.name === 'idle') || gltf.animations[0];
            if (idleClip) {
                const action = tmpMixer.clipAction(idleClip);
                action.play();
                tmpMixer.update(1 / 60); // evaluate one frame
                tmpModel.updateWorldMatrix(true, true);
            }
            // Find the lowest bone world position (should be a foot/toe bone)
            let lowestY = Infinity;
            tmpModel.traverse(child => {
                if (child.isBone) {
                    const wp = new THREE.Vector3();
                    child.getWorldPosition(wp);
                    if (wp.y < lowestY) lowestY = wp.y;
                }
            });
            _footOffset = lowestY < 0 ? -lowestY : 0;
            tmpMixer.stopAllAction();
            tmpMixer.uncacheRoot(tmpModel);
            console.log(`[R32.126] Foot offset from skeleton: ${_footOffset.toFixed(4)}m (lowest bone Y: ${lowestY.toFixed(4)})`);
        }

        console.log('[R32.120] Character loaded:', gltf.animations.length, 'clips');
        for (const clip of gltf.animations) {
            console.log(`  clip: ${clip.name} (${clip.duration.toFixed(2)}s, ${clip.tracks.length} tracks)`);
        }
    }, undefined, (err) => {
        console.error('[R32.113] Failed to load character model:', err);
    });
}

export function isLoaded() { return _loaded; }

export function sync(t, playerView, playerStride, localIdx, playerMeshes) {
    if (!_loaded) return;
    const dt = _lastT > 0 ? Math.min(0.1, t - _lastT) : 1 / 60;
    _lastT = t;

    _syncLocalPlayer(t, dt, playerView, playerStride, localIdx, playerMeshes);
}

// ── Instance management ─────────────────────────────────────

function _createInstance() {
    if (!_gltf) return null;

    const model = skeletonClone(_gltf.scene);
    const mixer = new THREE.AnimationMixer(model);

    const clips = {};
    for (const clip of _gltf.animations) clips[clip.name] = clip;

    // R32.113: Material tuning for scene integration.
    // The scene uses ACES tone mapping, warm-shadow color grading, 10% desat,
    // and the terrain/buildings have low metalness (0.10) + moderate roughness.
    // Meshy AI PBR textures are clean CG — dial them down to blend in.
    model.traverse(child => {
        child.frustumCulled = false;
        if (child.isMesh || child.isSkinnedMesh) {
            child.castShadow = true;
            child.receiveShadow = true;
            if (child.material) {
                const mat = child.material;
                mat.envMapIntensity = 0.25;
                mat.roughness = Math.max(mat.roughness, 0.55);
                mat.metalness = Math.min(mat.metalness, 0.15);
                if (mat.map) mat.map.colorSpace = THREE.SRGBColorSpace;
                mat.needsUpdate = true;
            }
        }
    });

    // Do NOT set model.scale — the GLB armature already has the correct
    // 0.01 scale (Mixamo cm→m). setScalar(1.0) would OVERWRITE it.

    _scene.add(model);

    return { model, mixer, clips, activeClip: null, activeAction: null };
}

function _playClip(inst, name, opts = {}) {
    if (!inst || inst.activeClip === name) return;
    if (!inst.clips[name]) {
        if (name !== 'idle' && inst.clips['idle']) name = 'idle';
        else return;
    }

    const clip = inst.clips[name];
    const action = inst.mixer.clipAction(clip);
    const fade = opts.fade ?? 0.15;

    if (inst.activeAction) inst.activeAction.fadeOut(fade);

    action.reset().fadeIn(fade);
    if (opts.once) {
        action.setLoop(THREE.LoopOnce);
        action.clampWhenFinished = true;
    }
    action.play();

    inst.activeAction = action;
    inst.activeClip = name;
}

// ── Grounding helper ────────────────────────────────────────
// Two physics systems, two conventions:
//   WASM (terrain):  playerY = terrainH + 1.8  (capsule offset)
//   Rapier (buildings): playerY = floorH        (no offset, feet on floor)
// When Rapier reports grounded, skip the terrain offset.
const CAPSULE_OFFSET = 1.8;
function _groundY(playerX, playerY, playerZ) {
    // Rapier-grounded = on a building floor, playerY IS the floor height
    if (window._rapierGrounded) {
        return playerY;
    }
    // On terrain: subtract WASM offset, compensated by JS sampler gap
    const sample = window._sampleTerrainH;
    if (!sample) return playerY - CAPSULE_OFFSET;
    const terrainH = sample(playerX, playerZ);
    const airDist = Math.max(0, playerY - terrainH - CAPSULE_OFFSET);
    return terrainH + airDist;
}

// ── Local player sync ───────────────────────────────────────

function _syncLocalPlayer(t, dt, playerView, playerStride, localIdx, playerMeshes) {
    if (localIdx < 0 || !playerView || playerStride <= 0) return;

    const is3P = (typeof Module !== 'undefined' && Module._getThirdPerson && Module._getThirdPerson());
    const o = localIdx * playerStride;
    const alive = playerView[o + 13] > 0.5;
    const visible = playerView[o + 18] > 0.5;

    if (is3P && visible) {
        if (!_chars[localIdx]) {
            _chars[localIdx] = _createInstance();
        }
        const char = _chars[localIdx];
        if (!char) return;

        if (playerMeshes[localIdx]) playerMeshes[localIdx].visible = false;
        char.model.visible = true;

        char.model.position.set(
            playerView[o],
            _groundY(playerView[o], playerView[o + 1], playerView[o + 2]) + _footOffset,
            playerView[o + 2]
        );
        char.model.rotation.set(0, -playerView[o + 4] + Math.PI, 0, 'YXZ');

        const speed = Math.hypot(playerView[o + 6], playerView[o + 8]);
        const jetting = playerView[o + 14] > 0.5;
        const skiing  = playerView[o + 15] > 0.5;

        let clip = 'idle';
        if (!alive) clip = 'death';
        else if (jetting) clip = 'jet';
        else if (skiing) clip = 'ski';
        else if (speed > 0.5) clip = 'run';

        _playClip(char, clip, { once: clip === 'death' });
        char.mixer.update(dt);
    } else {
        if (_chars[localIdx]) _chars[localIdx].model.visible = false;
    }
}

// ── Demo character ──────────────────────────────────────────

function _spawnDemo(playerView, playerStride, localIdx) {
    const o = localIdx * playerStride;
    if (playerView[o + 18] < 0.5) return;

    _demo = _createInstance();
    if (!_demo) return;
    _demoSpawned = true;

    const yaw = playerView[o + 4];
    _demo.baseX = playerView[o] + Math.sin(yaw) * 8;
    _demo.baseY = _groundY(playerView[o], playerView[o + 1], playerView[o + 2]) + _footOffset;
    _demo.baseZ = playerView[o + 2] + Math.cos(yaw) * 8;
    _demo.model.position.set(_demo.baseX, _demo.baseY, _demo.baseZ);
    _demo.time = 0;

    _playClip(_demo, 'idle');
    console.log('[R32.113] Demo spawned at',
        _demo.baseX.toFixed(0), _demo.baseY.toFixed(0), _demo.baseZ.toFixed(0));
}

function _updateDemo(t, dt) {
    _demo.time += dt;
    const tt = _demo.time;
    const cycle = tt % 24;
    let clip = 'idle';

    if (cycle < 8) {
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
        clip = 'idle';
        _demo.model.position.set(_demo.baseX, _demo.baseY, _demo.baseZ);
    } else if (cycle < 15) {
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
        clip = 'jet';
        const jetPhase = (cycle - 15) / 3;
        _demo.model.position.set(
            _demo.baseX,
            _demo.baseY + Math.sin(jetPhase * Math.PI) * 6,
            _demo.baseZ
        );
    } else if (cycle < 21) {
        clip = 'fire_rifle';
        _demo.model.position.set(_demo.baseX, _demo.baseY, _demo.baseZ);
    } else {
        clip = 'idle';
        _demo.model.position.set(_demo.baseX, _demo.baseY, _demo.baseZ);
    }

    _playClip(_demo, clip);
    _demo.mixer.update(dt);
}
