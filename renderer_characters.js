// @ai-contract
// PURPOSE: GLB character model loading, skeleton cloning, animation state machine
//   (idle/run/ski/jet/death/fire_rifle), and terrain grounding. Manages per-player
//   3D character instances synced to WASM player state each frame
// SERVES: Belonging (team-colored armor silhouettes readable at distance),
//   Scale (characters grounded on vast terrain)
// DEPENDS_ON: three, GLTFLoader (addon), SkeletonUtils (addon),
//   window._rapierGrounded (Boolean, renderer.js), window._sampleTerrainH (Function,
//   renderer.js), window.Module._getThirdPerson() (WASM)
// EXPOSES: ES module exports: init(scene), sync(playerView, playerStride, localIdx,
//   playerMeshes, dt), isLoaded(). No window.* globals
// LIFECYCLE: init(scene) → loads GLB → sync() called per frame by renderer.js.
//   No dispose — character meshes hidden but not cleaned up
// COORDINATE_SPACE: world (meters), Y-up. Foot offset computed from skeleton at load
// BEFORE_MODIFY: read docs/lessons-learned.md. Player state magic number offsets
//   (13=alive, 18=visible, 14=jetting, 15=skiing, etc.) must match WASM layout.
//   Check docs/system-map.md Player State Stride Layout
// NEVER: use model-local or armature-local coordinates for world placement
// ALWAYS: strip Hips root-motion tracks (position is WASM-driven)
// ALWAYS: compute foot offset from skeleton, not hardcoded constants
// @end-ai-contract
//
// ============================================================
// R32.113: Rigged GLB Character Models
// ============================================================
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { clone as skeletonClone } from 'three/addons/utils/SkeletonUtils.js';
import { Locomotion } from './client/locomotion.js?v=1';
import { FootIK }    from './client/foot_ik.js?v=1';

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

// ── Character roster ─────────────────────────────────────────────────────────
// To add a character: add its id to ROSTER. All paths are derived automatically.
// To change the animation source: update ANIM_SOURCE_ID.
//
// File convention (must exist in assets/models/):
//   <id>_rigged.glb  — Mixamo skeleton (1 animation; others injected at runtime)
//   <id>_50k.glb     — HD source mesh with full PBR textures

const ANIM_SOURCE_ID = 'crimson_sentinel'; // holds all 14 canonical animations
const BASE = './assets/models/';

const ROSTER = [
    'crimson_sentinel',
    'aegis_sentinel',
    'auric_phoenix',
    'crimson_titan',
    'crimson_warforged',
    'emerald_sentinel',
    'golden_phoenix',
    'iron_wolf',
    'midnight_sentinel',
    'neon_wolf',
    'obsidian_vanguard',
    'violet_phoenix',
];

const CHARACTER_MODELS = ROSTER.map(id => ({
    id,
    label:      id.split('_').map(w => w[0].toUpperCase() + w.slice(1)).join(' '),
    path:       `${BASE}${id}_rigged.glb`,
    textureSrc: `${BASE}${id}_50k.glb`,
    animSrc:    id !== ANIM_SOURCE_ID ? `${BASE}${ANIM_SOURCE_ID}_rigged.glb` : null,
}));
window.__characterModels = CHARACTER_MODELS;
let _currentModelIdx = 0;

export function switchCharacter(idxOrId) {
    const idx = typeof idxOrId === 'number' ? idxOrId
        : CHARACTER_MODELS.findIndex(m => m.id === idxOrId);
    if (idx < 0 || idx >= CHARACTER_MODELS.length || idx === _currentModelIdx) return;
    _currentModelIdx = idx;
    // Clear cached state so init reloads
    _gltf = null; _loaded = false; _footOffset = 0;
    Object.keys(_chars).forEach(k => { if (_chars[k]) { _scene?.remove(_chars[k].model); } });
    Object.keys(_chars).forEach(k => delete _chars[k]);
    if (_demo) { _scene?.remove(_demo.model); _demo = null; _demoSpawned = false; }
    _init(_scene);
    console.log('[Characters] Switched to', CHARACTER_MODELS[idx].label);
}

export function init(targetScene) {
    _scene = targetScene;
    _init(targetScene);
}

function _transferMaterials(riggedScene, texScene) {
    const srcMats = [];
    texScene.traverse(obj => {
        if (obj.isMesh || obj.isSkinnedMesh) {
            const m = Array.isArray(obj.material) ? obj.material : [obj.material];
            m.forEach(mat => { if (mat && !srcMats.includes(mat)) srcMats.push(mat); });
        }
    });
    if (!srcMats.length) return;
    let idx = 0;
    riggedScene.traverse(obj => {
        if ((obj.isMesh || obj.isSkinnedMesh) && idx < srcMats.length) {
            obj.material = srcMats[idx++];
            obj.material.needsUpdate = true;
        }
    });
    console.log(`[Characters] Transferred ${idx} HD material(s)`);
}

function _init(targetScene) {
    const loader  = new GLTFLoader();
    const charDef = CHARACTER_MODELS[_currentModelIdx];

    const rigLoad  = new Promise((ok, fail) => loader.load(charDef.path, ok, undefined, fail));
    const texLoad  = charDef.textureSrc
        ? new Promise((ok, fail) => loader.load(charDef.textureSrc, ok, undefined, fail))
        : Promise.resolve(null);
    // animSrc: crimson sentinel's 14 clips shared across all characters.
    // Works because all Mixamo rigs use identical bone naming.
    const animLoad = charDef.animSrc
        ? new Promise((ok, fail) => loader.load(charDef.animSrc, ok, undefined, fail))
        : Promise.resolve(null);

    Promise.all([rigLoad, texLoad, animLoad])
      .then(([gltf, texGltf, animGltf]) => {
        if (texGltf)  _transferMaterials(gltf.scene, texGltf.scene);
        if (animGltf) {
            // Replace the rig's single clip with the full 14-clip set
            gltf.animations = animGltf.animations;
            console.log(`[Characters] Injected ${animGltf.animations.length} animations from crimson sentinel`);
        }
        _onLoad(gltf);
      })
      .catch(err => console.error('[Characters] Load failed:', err));
}

// Normalise a freshly-loaded GLB scene to match the crimson sentinel baseline:
//   • scale 0.01  (Mixamo cm→m; fbx2gltf models sometimes arrive at 1.0)
//   • no spurious ±90° X rotation on root or first child
// Called BEFORE foot-offset computation so all downstream math is consistent.
function _normaliseScene(scene) {
    const id = CHARACTER_MODELS[_currentModelIdx]?.id ?? '?';

    // ── Scale ──────────────────────────────────────────────────────────
    // Traverse until we find a node whose scale differs significantly from 1.
    // If the entire hierarchy is at scale ≈ 1.0, the model is in centimetres
    // and needs the standard Mixamo 0.01 correction.
    let foundScale = false;
    scene.traverse(obj => {
        if (foundScale) return;
        if (Math.abs(obj.scale.x - 0.01) < 0.005) { foundScale = true; } // already correct
    });
    if (!foundScale) {
        // No 0.01 scale found anywhere — apply it at root level.
        scene.scale.setScalar(0.01);
        console.log(`[Characters:${id}] Applied 0.01 scale (was at 1.0 — cm→m correction)`);
    }

    // ── Rotation ───────────────────────────────────────────────────────
    // fbx2gltf may embed ±π/2 on the scene root or its first child.
    function _fixRot(obj) {
        if (Math.abs(Math.abs(obj.rotation.x) - Math.PI / 2) < 0.05) {
            console.log(`[Characters:${id}] Corrected rotation.x=${obj.rotation.x.toFixed(3)} on ${obj.name||'(unnamed)'}`);
            obj.rotation.x = 0;
        }
    }
    _fixRot(scene);
    scene.children.forEach(_fixRot);

    // Force world matrix update so getWorldPosition() is accurate below.
    scene.updateWorldMatrix(true, true);
}

function _onLoad(gltf) { ((gltf) => {
        // Normalise scale + rotation before anything else touches the scene.
        _normaliseScene(gltf.scene);

        _gltf = gltf;
        _loaded = true;

        // R32.125: Strip ALL Hips position (root motion). Position is WASM-driven.
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
            let lowestY = 0;
            tmpModel.traverse(child => {
                if (child.isBone) {
                    const wp = new THREE.Vector3();
                    child.getWorldPosition(wp);
                    if (wp.y < lowestY) lowestY = wp.y;
                }
            });
            // Clamp to sane human range (0–1.5m) — prevents sky/underground
            const rawOffset = lowestY < 0 ? -lowestY : 0;
            _footOffset = Math.min(rawOffset, 1.5);
            tmpMixer.stopAllAction();
            tmpMixer.uncacheRoot(tmpModel);
            console.log(`[R32.126] Foot offset from skeleton: ${_footOffset.toFixed(4)}m (lowest bone Y: ${lowestY.toFixed(4)})`);
        }

        console.log('[R32.120] Character loaded:', gltf.animations.length, 'clips');
        for (const clip of gltf.animations) {
            console.log(`  clip: ${clip.name} (${clip.duration.toFixed(2)}s, ${clip.tracks.length} tracks)`);
        }
    })(gltf); }  // close _onLoad + IIFE

export function isLoaded() { return _loaded; }

// Returns the local player's RENDERED instance skeleton + clips.
// Must use the cloned instance, not the template — posing the template
// has no visible effect because rendered characters are skeletonClone() copies.
export function getRig(localIdx) {
    if (!_gltf || !_loaded) return null;
    // Prefer the live local player instance (what the camera sees in 3P)
    const inst = _chars[localIdx ?? -1];
    if (inst?.model) {
        let skeleton = null;
        inst.model.traverse(c => { if (c.isSkinnedMesh && !skeleton) skeleton = c.skeleton; });
        if (skeleton) return { skeleton, clips: _gltf.animations };
    }
    // Fallback: template skeleton (only useful for clip preview without a live character)
    let skeleton = null;
    _gltf.scene.traverse(c => { if (c.isSkinnedMesh && !skeleton) skeleton = c.skeleton; });
    return skeleton ? { skeleton, clips: _gltf.animations } : null;
}

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
    // _normaliseScene already ran on _gltf.scene at load time, so the clone
    // inherits the corrected scale and rotation. No further adjustment needed.

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

    // Ski particles handled in renderer.js (same pipeline as jet exhaust)

    // Jet flames removed — particles only
    const flameL = null;
    const flameR = null;

    // Ski board removed — particles only for ski effect
    const skiBoard = null;

    return { model, mixer, clips, activeClip: null, activeAction: null,
             flameL, flameR, skiBoard };
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
    // Animation editor needs a character on screen regardless of 3P mode
    const forceShow = !!window.__characterPreview;
    const o = localIdx * playerStride;
    const alive = playerView[o + 13] > 0.5;
    const visible = playerView[o + 18] > 0.5;

    if ((is3P && visible) || forceShow) {
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
        // L1: speed-matched timeScale so feet plant at all speeds, not slide
        // L6: ski posture — crouch + lean. turnInput approximated from yaw delta.
        const yaw = playerView[o + 4];
        if (!char._prevYaw) char._prevYaw = yaw;
        const turnInput = Math.max(-1, Math.min(1, (yaw - char._prevYaw) / (dt * 2.5)));
        char._prevYaw = yaw;
        Locomotion.skiUpdate(char, skiing, speed, turnInput, dt);
        Locomotion.update(char, speed, clip, dt);
        char.mixer.update(dt);
        // L5+L4: only run on local player — too expensive for all characters
        if (i === localIdx) {
            const phase = window.__locoPhase ?? -1;
            Locomotion.pelvisBob(char, speed, phase);
            FootIK.update(char, !jetting && speed < 40, skiing);
        }
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
