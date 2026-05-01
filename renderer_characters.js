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
let _kind = 'rigid';  // 'skinned' | 'rigid' — detected at load
let _lastT = 0;

// _footOffset is now per-instance (char.footOffset). Module-level var kept
// only as a default while the first instance hasn't been created yet.
let _footOffset = 0;

const _chars = new Array(16).fill(null);
let _demo = null;
let _demoSpawned = false;

// ── Rig-change subscription (§4d note) ────────────────────────────────────
// editor_animations.js subscribes once; Characters calls it when a new rig
// is ready, eliminating the 800ms setTimeout guess.
const _rigSubscribers = [];
export function subscribeRigChange(cb) { _rigSubscribers.push(cb); }
function _notifyRigChange(skeleton, clips) {
    _rigSubscribers.forEach(cb => { try { cb(skeleton, clips); } catch(e) {} });
}

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

// ── Verified Mixamo-rigged models only ─────────────────────────────────────
// These 6 came from genuine Mixamo downloads (tools/obj_export/*.fbx).
// The remaining 6 (aegis, warforged, golden_phoenix, iron_wolf, neon_wolf,
// violet_phoenix) were converted from the original unrigged FBX files in
// assets/models/ — they have no skeleton. Re-add here once Mixamo-rigged.
// auric_phoenix + crimson_titan removed — their rigged GLBs have 0 meshes
// (downloaded from Mixamo as animation-only, no "With Skin"). Re-add once
// re-exported with Format=FBX, Skin=With Skin from mixamo.com.
// Only crimson_sentinel is properly rigged with skin weights.
// Add others here once re-exported from Mixamo with "Skin = With Skin".
const ROSTER = [
    'crimson_sentinel',
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
    Object.keys(_chars).forEach(k => { if (_chars[k]) { _scene?.remove(_chars[k].wrapper); } });
    Object.keys(_chars).forEach(k => delete _chars[k]);
    if (_demo) { _scene?.remove(_demo.wrapper); _demo = null; _demoSpawned = false; }
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
            gltf.animations = animGltf.animations;
            // Strip tracks for bones the target skeleton doesn't have.
            // Prevents 1500+ "No target node found" warnings per character
            // that fire every frame and tank performance.
            const boneNames = new Set();
            gltf.scene.traverse(obj => { if (obj.name) boneNames.add(obj.name); });
            let stripped = 0;
            for (const clip of gltf.animations) {
                const before = clip.tracks.length;
                clip.tracks = clip.tracks.filter(t => boneNames.has(t.name.split('.')[0]));
                stripped += before - clip.tracks.length;
            }
            console.log(`[Characters] Injected ${animGltf.animations.length} clips, stripped ${stripped} tracks for missing bones`);
        }
        _onLoad(gltf);
      })
      .catch(err => console.error('[Characters] Load failed:', err));
}

function _onLoad(gltf) { ((gltf) => {
        // ── NEVER modify gltf.scene transforms. ─────────────────────────────
        // Mixamo GLBs carry an intentional ±90°X double-fixup in the hierarchy
        // (Armature +90°X, Hips child −90°X). Any code that zeros those transforms
        // breaks the cancellation and causes face-down. The wrapper Group pattern
        // in _createInstance isolates placement from internal coordinate fixups.
        // (RCA §4b — see docs/CHARACTER_ANIMATE_RCA_R32_277.md)

        // ── Kind detection ────────────────────────────────────────────────────
        let hasSkin = false;
        gltf.scene.traverse(obj => { if (obj.isSkinnedMesh) hasSkin = true; });
        _kind = hasSkin ? 'skinned' : 'rigid';
        console.log(`[Characters] Loaded kind=${_kind} id=${CHARACTER_MODELS[_currentModelIdx]?.id}`);

        _gltf = gltf;
        _loaded = true;

        // R32.125: Strip Hips root-motion tracks. Position is WASM-driven.
        for (const clip of gltf.animations) {
            clip.tracks = clip.tracks.filter(track =>
                !(track.name.endsWith('.position') && track.name.includes('Hips'))
            );
        }

        // Compute a reference foot offset from the template (used as fallback).
        // Per-instance offsets are computed in _createInstance after the clone
        // is in the scene, so world matrices are correct. (RCA §4c)
        {
            gltf.scene.updateWorldMatrix(true, true);
            let lowestY = 0;
            gltf.scene.traverse(child => {
                if (child.isBone) {
                    const wp = new THREE.Vector3();
                    child.getWorldPosition(wp);
                    if (wp.y < lowestY) lowestY = wp.y;
                }
            });
            _footOffset = Math.min(lowestY < 0 ? -lowestY : 0, 1.5);
            console.log(`[Characters] Template foot offset: ${_footOffset.toFixed(4)}m`);
        }

        // Notify animation editor that a rig is ready
        const skeleton = _findSkeleton(gltf.scene);
        if (skeleton) _notifyRigChange(skeleton, gltf.animations);

        console.log('[Characters] Clips:', gltf.animations.map(c => c.name).join(', '));
    })(gltf); }  // close _onLoad + IIFE

export function isLoaded() { return _loaded; }
export function getKind()   { return _kind; }

function _findSkeleton(root) {
    let sk = null;
    root.traverse(c => { if (c.isSkinnedMesh && !sk) sk = c.skeleton; });
    return sk;
}

// Returns the local player's RENDERED instance skeleton + clips.
// Must use the cloned instance, not the template — posing the template
// has no visible effect because rendered characters are skeletonClone() copies.
export function getRig(localIdx) {
    if (!_gltf || !_loaded) return null;
    // Use inner (the actual GLB content, not the wrapper) for skeleton lookup
    const inst = _chars[localIdx ?? -1];
    if (inst?.inner) {
        const sk = _findSkeleton(inst.inner);
        if (sk) return { skeleton: sk, clips: _gltf.animations };
    }
    // Fallback: template skeleton
    const sk = _findSkeleton(_gltf.scene);
    return sk ? { skeleton: sk, clips: _gltf.animations } : null;
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

    // ── §4b Wrapper Group pattern ─────────────────────────────────────────
    // The inner clone keeps ALL internal transforms (Armature +90°X, Hips −90°X,
    // scale nodes) exactly as the GLB author intended. NEVER call rotation.set()
    // or scale.set() on `inner`. Only `wrapper` receives placement/facing.
    const inner   = skeletonClone(_gltf.scene);
    const wrapper = new THREE.Group();
    wrapper.add(inner);

    // AnimationMixer targets `inner` so bone bindings resolve correctly
    const mixer = new THREE.AnimationMixer(inner);

    const clips = {};
    for (const clip of _gltf.animations) clips[clip.name] = clip;

    // Material tuning for scene integration (ACES, warm grade, low metalness)
    inner.traverse(child => {
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
    wrapper.frustumCulled = false;

    // ── §4c Per-instance foot offset ──────────────────────────────────────
    // Measure from the actual clone (correct scale/pose) not the template.
    // For skinned: sample lowest bone world position after one idle frame.
    // For rigid: use bounding box min Y.
    _scene.add(wrapper); // must be in scene for getWorldPosition to work
    inner.updateWorldMatrix(true, true);

    let instanceFootOffset = _footOffset; // fallback to template value
    if (_kind === 'skinned') {
        const tmpMixer = new THREE.AnimationMixer(inner);
        const idleClip = _gltf.animations.find(c => c.name === 'idle') || _gltf.animations[0];
        if (idleClip) {
            tmpMixer.clipAction(idleClip).play();
            tmpMixer.update(1 / 60);
            inner.updateWorldMatrix(true, true);
        }
        let lowestY = 0;
        inner.traverse(c => {
            if (c.isBone) {
                const wp = new THREE.Vector3();
                c.getWorldPosition(wp);
                if (wp.y < lowestY) lowestY = wp.y;
            }
        });
        instanceFootOffset = Math.min(lowestY < 0 ? -lowestY : 0, 1.5);
        tmpMixer.stopAllAction(); tmpMixer.uncacheRoot(inner);
    } else {
        const box = new THREE.Box3().setFromObject(inner);
        instanceFootOffset = box.min.y < 0 ? Math.min(-box.min.y, 1.5) : 0;
    }
    console.log(`[Characters] Instance foot offset: ${instanceFootOffset.toFixed(4)}m (kind=${_kind})`);

    const flameL = null, flameR = null, skiBoard = null;

    return { wrapper, inner, mixer, clips,
             footOffset: instanceFootOffset,
             activeClip: null, activeAction: null,
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
        char.wrapper.visible = true;

        // §4b: Drive the WRAPPER for placement. Never touch char.inner rotation/position —
        // those preserve the GLB's internal coordinate-frame fixups.
        const groundY = _groundY(playerView[o], playerView[o + 1], playerView[o + 2]);
        char.wrapper.position.set(playerView[o], groundY + char.footOffset, playerView[o + 2]);
        char.wrapper.rotation.set(0, -playerView[o + 4] + Math.PI, 0, 'YXZ');

        const speed   = Math.hypot(playerView[o + 6], playerView[o + 8]);
        const jetting = playerView[o + 14] > 0.5;
        const skiing  = playerView[o + 15] > 0.5;

        let clip = 'idle';
        if (!alive) clip = 'death';
        else if (jetting) clip = 'jet';
        else if (skiing)  clip = 'ski';
        else if (speed > 0.5) clip = 'run';

        _playClip(char, clip, { once: clip === 'death' });

        const yaw = playerView[o + 4];
        if (!char._prevYaw) char._prevYaw = yaw;
        const turnInput = Math.max(-1, Math.min(1, (yaw - char._prevYaw) / (dt * 2.5)));
        char._prevYaw = yaw;
        Locomotion.skiUpdate(char, skiing, speed, turnInput, dt);
        Locomotion.update(char, speed, clip, dt);
        char.mixer.update(dt);
        // L5+L4 only on local player (was crashing with undefined `i` — fixed in 942d9c3)
        const phase = window.__locoPhase ?? -1;
        Locomotion.pelvisBob(char, speed, phase);
        FootIK.update(char, !jetting && speed < 40, skiing);
    } else {
        if (_chars[localIdx]) _chars[localIdx].wrapper.visible = false;
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
    _demo.wrapper.position.set(_demo.baseX, _demo.baseY, _demo.baseZ);
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
        _demo.wrapper.position.set(
            _demo.baseX + Math.cos(angle) * r,
            _demo.baseY,
            _demo.baseZ + Math.sin(angle) * r
        );
        _demo.wrapper.rotation.y = -(angle + Math.PI * 0.5);
    } else if (cycle < 11) {
        clip = 'idle';
        _demo.wrapper.position.set(_demo.baseX, _demo.baseY, _demo.baseZ);
    } else if (cycle < 15) {
        clip = 'ski';
        const angle = tt * 1.0;
        const r = 10;
        _demo.wrapper.position.set(
            _demo.baseX + Math.cos(angle) * r,
            _demo.baseY,
            _demo.baseZ + Math.sin(angle) * r
        );
        _demo.wrapper.rotation.y = -(angle + Math.PI * 0.5);
    } else if (cycle < 18) {
        clip = 'jet';
        const jetPhase = (cycle - 15) / 3;
        _demo.wrapper.position.set(
            _demo.baseX,
            _demo.baseY + Math.sin(jetPhase * Math.PI) * 6,
            _demo.baseZ
        );
    } else if (cycle < 21) {
        clip = 'fire_rifle';
        _demo.wrapper.position.set(_demo.baseX, _demo.baseY, _demo.baseZ);
    } else {
        clip = 'idle';
        _demo.wrapper.position.set(_demo.baseX, _demo.baseY, _demo.baseZ);
    }

    _playClip(_demo, clip);
    _demo.mixer.update(dt);
}
