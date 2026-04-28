// ============================================================
// Tribes Browser Edition — Three.js Renderer (R15 → R17 default → R18 quality)
// ============================================================
// Architecture: C++ simulation in WASM, Three.js renderer in JS.
// JS reads game state via zero-copy Float32Array views into HEAPF32.
// No JSON, no per-frame EM_ASM. All sync is typed-array reads.
//
// R18 cashes in on the Three.js architecture:
//   - Composite procedural player models (3 armor tiers, leg/arm rig animation)
//   - Composite procedural building models (turret/station/generator/interior)
//   - Procedural noise-based PBR terrain (canvas-generated diffuse + normal)
//   - THREE.Sky atmospheric scattering + DirectionalLight sun + PCF shadows
//   - Improved particle system with type-specific colors + soft circular sprites
//   - EffectComposer post-processing: UnrealBloom + custom vignette + warm grading
//   - Graphics quality tier (low/medium/high/ultra) drives all of the above
//
// Asset constraint: per R18 brief guardrail, "no hotlinking from artist sites".
// All visual content is procedurally generated in this file (no glTF imports).
// Three.js itself is loaded from unpkg (CDN allowed).
// ============================================================

import * as THREE from 'three';
// R32.63: THREE.Sky removed — replaced by custom procedural sky dome in renderer_sky_custom.js
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js';
// R32.7 — additive polish module. Single import; ?polish=off gracefully
// disables the entire pack at runtime. Effects stack on top of the existing
// renderer pipeline without modifying any existing materials or meshes.
import * as Polish from './renderer_polish.js';
import { RGBELoader } from 'three/addons/loaders/RGBELoader.js'; // R31.2
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'; // R32.57: custom model loading
import { initCustomSky, updateCustomSky, removeOldSky } from './renderer_sky_custom.js'; // R32.63: full sky system
import * as Characters from './renderer_characters.js?v=128'; // R32.116: cache bust

// --- Module state ---
let scene, camera, renderer, composer;
let bloomPass, gradePass;
let sunLight, hemiLight, moonLight, sky;
let polish = null; // R32.7 polish module handle
let _lastTickTime = 0; // R32.7 dt source for polish.tick
let _fovPunchExtra = 0; // R32.45: FOV kick from nearby explosions (degrees)
let terrainMesh;
let playerMeshes = [];
let projectileMeshes = [];
let flagMeshes = [];
let buildingMeshes = [];
let weaponHand;             // small box mesh attached at local-player view position
let particleSystem, particleGeom, particlePositions, particleColors, particleSizes;

// Typed-array views into WASM HEAPF32
let playerView, projectileView, particleView, flagView;
let playerStride, projectileStride, particleStride, flagStride;

// Constants
const MAX_PARTICLES = 1024;
const MAX_PROJECTILES = 256;
const MAX_PLAYERS = 16;
const TEAM_COLORS = [0xC8302C, 0x2C5AC8, 0x808080];
const TEAM_TINT_HEX = [0xCC4444, 0x4477CC, 0x808080];
const PROJ_COLORS = [
    0xFFFFFF, // 0 blaster
    0xFFEE40, // 1 chaingun
    0xFFFFFF, // 2 disc (white)
    0x4F8030, // 3 grenade
    0xFF6020, // 4 plasma
    0xFFA040, // 5 mortar
    0xFF4040, 0x80A0FF, 0x40FF80
];

// Reused tmp objects
const _tmpVec = new THREE.Vector3();
const _aimPoint3P = { x: 0, y: 0, z: 0 };    // R32.43: persistent aim-point (no per-frame alloc)
const _flagStateByTeam = [0, 0];               // R32.43: persistent flag state (no per-frame alloc)

// Diagnostic
let _frameCount = 0;
let _lastDiagTime = 0;
let _r30Diagnosed = false;     // R30.0: dump scene contents exactly once on first real frame
let _lastPlayerColors = new Array(MAX_PLAYERS).fill(-1);

// R31.1: heightmap copy for terrain-height sampling (buildings & player grounding)
let _htSize = 0, _htScale = 1, _htData = null;
function sampleTerrainH(worldX, worldZ) {
    if (!_htData || _htSize < 2) return 0;
    const half = (_htSize - 1) * _htScale * 0.5;
    const gx = (worldX + half) / _htScale;
    const gz = (worldZ + half) / _htScale;
    const ix = Math.max(0, Math.min(_htSize - 2, Math.floor(gx)));
    const iz = Math.max(0, Math.min(_htSize - 2, Math.floor(gz)));
    const fx = gx - ix, fz = gz - iz;
    return _htData[iz * _htSize + ix] * (1-fx)*(1-fz)
         + _htData[iz * _htSize + (ix+1)] * fx*(1-fz)
         + _htData[(iz+1) * _htSize + ix] * (1-fx)*fz
         + _htData[(iz+1) * _htSize + (ix+1)] * fx*fz;
}
window._sampleTerrainH = sampleTerrainH; // R32.120: expose for renderer_characters.js

// ============================================================
// Graphics quality tier (driven by settings menu)
// ============================================================
const QUALITY_TIERS = {
    low:    { shadowMap: 0,    postProcess: false, particleCap: 256,  pixelRatio: 1.0 },
    medium: { shadowMap: 1024, postProcess: false, particleCap: 512,  pixelRatio: 1.0 },
    high:   { shadowMap: 2048, postProcess: 'bloom', particleCap: 1024, pixelRatio: 1.0 },
    ultra:  { shadowMap: 2048, postProcess: 'full', particleCap: 1024, pixelRatio: Math.min(window.devicePixelRatio, 2) }
};
let currentQuality = 'high'; // default; updated from window.ST below

function readQualityFromSettings() {
    if (window.ST && window.ST.graphicsQuality && QUALITY_TIERS[window.ST.graphicsQuality]) {
        currentQuality = window.ST.graphicsQuality;
    }
    return QUALITY_TIERS[currentQuality];
}

// ============================================================
// Entry point
// ============================================================
export async function start() {
    console.log('[R29] renderer.js start() entered');
    console.log('[R18] Three.js renderer starting (quality=' + currentQuality + ', THREE.REVISION=' + THREE.REVISION + ')');

    initRenderer();
    console.log('[R29] WebGLRenderer created, capabilities:', renderer.capabilities);
    initScene();
    initLights();
    // R32.63: HDRI for PBR environment lighting only (not background).
    // Custom sky dome in renderer_sky_custom.js replaces THREE.Sky and HDRI background.
    loadHDRISky();   // async — sets scene.environment for PBR; sky dome handles visuals
    initCustomSky(scene); // R32.63: procedural sky dome + stars + clouds
    await initTerrain();
    // R32.104: Initialize Rapier physics (async — loads WASM). Starts early so it's
    // ready by the time we need to create building/interior colliders.
    let _rapierReady = false;
    if (window.RapierPhysics) {
        try {
            await window.RapierPhysics.initRapierPhysics();
            _rapierReady = true;
            console.log('[R32.104] Rapier physics world ready');
            // Create terrain heightfield collider from raw WASM heightmap (257-cell, scale 8.0)
            // Must match WASM's own getH() — NOT the upscaled _htData (513-cell bicubic)
            {
                const rawPtr = Module._getHeightmapPtr();
                const rawSize = Module._getHeightmapSize();
                const rawScale = Module._getHeightmapWorldScale();
                const rawHeights = new Float32Array(Module.HEAPF32.buffer, rawPtr, rawSize * rawSize);
                window.RapierPhysics.createTerrainCollider(rawHeights, rawSize, rawScale);
            }
        } catch (e) {
            console.error('[R32.104] Rapier init failed, falling back to WASM collision:', e);
        }
    } else {
        console.warn('[R32.104] RapierPhysics not loaded — using WASM collision fallback');
    }
    await initBuildings(); // R32.3: now async — loads canonical.json for per-datablock mesh classification
    // R32.104: Create Rapier cuboid colliders for buildings
    if (_rapierReady && window.RapierPhysics) {
        try { window.RapierPhysics.createBuildingColliders(); } catch (e) {
            console.error('[R32.104] Building collider creation failed:', e);
        }
    }
    await initInteriorShapes(); // R32.1: real Tribes 1 .dis-extracted meshes at canonical positions
    // R32.104: Interior mesh colliders are created inside registerModelCollision()
    // which is now redirected to Rapier (see below)
    initCustomModels(); // R32.57: load custom GLB models
    await initBaseAccents(); // R32.2: per-team VehiclePad + RepairPack + side-mounted flag stand
    initPlayers();
    try { Characters.init(scene); } catch(e) { console.warn('[R32.109] Characters init failed:', e); } // R32.109: rigged GLB characters
    initProjectiles();
    initFlags();
    initParticles();
    initWeaponViewmodel();
    try { initJetExhaust(); } catch (e) { console.warn('[R32.72] initJetExhaust failed:', e); }
    try { initProjectileTrails(); } catch (e) { console.warn('[R32.73] initProjectileTrails failed:', e); }
    try { initExplosionFX(); } catch (e) { console.warn('[R32.74] initExplosionFX failed:', e); }
    try { initNightFairies(); } catch (e) { console.warn('[R32.74] initNightFairies failed:', e); }
    try { initInteriorLights(); } catch (e) { console.warn('[R32.75] initInteriorLights failed:', e); }
    // R32.36.3-manus: rain disabled by default per user request "Turn off rain
    // please so I can see them". The Raindance map's signature rain streaks
    // were competing visually with the new fairies. Opt back in via ?rain=on.
    if (typeof location !== 'undefined' && /[?&]rain=on\b/.test(location.search)) {
        initRain(); // R32.0: Raindance.MIS "Rain1" Snowfall (now opt-in)
    }
    // R32.32.1-manus: camera-local thin-blade grass ring. See initGrassRing
    // for the full architecture writeup. Wrapped in try/catch so any failure
    // can't black-screen the game (lesson from R32.25). Escape hatch: ?ring=off.
    // R32.33-manus: grass ring DISABLED by default. After R32.32.3 user feedback
    // ("sticks in the ground", uneven wind, recycle bunching at feet) we pivoted
    // to the "Living Terrain" architecture: instead of placing literal blade
    // primitives, we modulate the existing terrain shader so the ground itself
    // breathes, responds to your gaze, and reacts to your movement. The ring
    // code is kept in place but only loads if you opt-in with ?ring=on so we
    // can A/B against the new approach. Otherwise grass-ring is dormant.
    if (typeof location !== 'undefined' && /[?&]ring=on\b/.test(location.search)) {
        try { initGrassRing(); } catch (e) { console.warn('[R32.33] initGrassRing failed:', e); }
    }
    // R32.35-manus: spawn the above-ground dust particle layer.
    try { initDustLayer(); } catch (e) { console.warn('[R32.35] initDustLayer failed:', e); }
    // R32.27.2-manus: re-enable Ghibli-style grass on top of the painterly terrain.
    // initGrass + initDetailProps were dropped from the start() sequence in R32.9
    // because the OLD muddy-olive cross-quad sin-sway grass fought the watercolor
    // terrain. The R32.27 rewrite (bright Ghibli ramp, single-tri, chaotic per-blade
    // noise wind, 140k blades on high tier) is designed to COMPLEMENT painterly
    // terrain, not fight it. Wrapped in try/catch so a grass init failure can't
    // black-screen the game. Escape hatches: ?grass=off skips entirely;
    // ?grass=classic restores R32.8 cross-quad sin-sway. initDetailProps (rocks/
    // scrub) intentionally remains dormant pending a separate decision.
    // R32.31-manus: grass removed entirely. The three releases from R32.27.2
    // through R32.29 tried to reproduce a Ghibli-style grass look on top of
    // the painterly terrain, but each iteration (brute-force density, thinner
    // blades, 4x counts) failed to read as "100% coverage" because distant
    // blades go sub-pixel regardless of count. Path B (camera-local ring) was
    // drafted but never shipped. Resetting to no grass so we can re-ask the
    // right architectural question and pick a grass approach that actually
    // fits a high-speed jetpack FPS with painterly terrain, instead of piling
    // more blade tweaks on top of the wrong primitive. initGrass/updateGrass-
    // Wind functions remain defined in the file but are no longer called.
    // R32.9 — fake grass and procedural rocks were dropped: they broke the painterly Tribes look.
    // R29.2: initStateViews() must run BEFORE initPostProcessing() because the
    // RenderPass(scene, camera) constructor captures the camera reference, and
    // initStateViews() is where `camera` is actually created. Previously the
    // order was reversed, so RenderPass got camera===undefined and every frame
    // crashed with `Cannot read properties of undefined (reading 'parent')` at
    // WebGLRenderer.render line 30015 (camera.parent === null check).
    initStateViews();
    initPostProcessing();
    console.log('[R29.2] State views + post-process initialized in correct order (camera-first)');
    // R32.7 — install polish AFTER state views so the module can see playerView/playerStride
    polish = Polish.installPolish({
        THREE: THREE, scene: scene, camera: camera, renderer: renderer, composer: composer,
        sunLight: sunLight, hemiLight: hemiLight, terrainMesh: terrainMesh,
        sampleTerrainH: sampleTerrainH,
        playerView: playerView, playerStride: playerStride,
    });
    window.__tribesPolish = polish; // expose for debugging / other modules
    // R32.7 — enhance buildings (deferred so polish module is fully installed)
    try {
        for (const b of buildingMeshes) {
            const canon = b.mesh.userData && b.mesh.userData.canon;
            if (!canon) continue;
            const teamColor = canon.team === 0 ? 0xCC4444 : 0x4488CC;
            if (canon.datablock === 'plasmaTurret') Polish.enhanceTurret(b.mesh, 'plasma', teamColor);
            else if (canon.datablock === 'rocketTurret') Polish.enhanceTurret(b.mesh, 'rocket', teamColor);
            else if (canon.datablock === 'PulseSensor') Polish.enhanceSensor(b.mesh);
            else if (canon.datablock === 'AmmoStation' || canon.datablock === 'InventoryStation' || canon.datablock === 'CommandStation' || canon.datablock === 'VehicleStation') {
                Polish.addStationIcon(b.mesh, canon.datablock, teamColor);
            }
            else if (canon.datablock === 'Generator') {
                // chimney smoke at vent top (~4.6m above building base)
                const wp = new THREE.Vector3();
                b.mesh.getWorldPosition(wp);
                wp.y += 4.6;
                Polish.registerGeneratorChimney(wp);
            }
        }
        console.log('[R32.7] Building polish enhancements applied to', buildingMeshes.length, 'buildings');
    } catch (e) { console.warn('[R32.7] enhanceBuildings failed:', e && e.message ? e.message : e); }
    // R32.7 — bridge railings (find expbridge interior shape)
    try {
        if (interiorShapesGroup) {
            interiorShapesGroup.traverse(child => {
                if (child.userData && /expbridge/i.test(child.userData.fileName || '')) {
                    Polish.addBridgeRailings(child);
                }
            });
        }
    } catch (e) { console.warn('[R32.7] addBridgeRailings failed:', e && e.message ? e.message : e); }
    console.log('[R29] Scene populated, ready to render');

    // Listen for settings changes (graphics quality dropdown)
    window.addEventListener('resize', onResize);
    window.__tribesApplyQuality = applyQuality;
    onResize();

    // R32.20: Toonify pass — convert all MeshStandardMaterial to MeshToonMaterial
    // for visual cohesion. ?style=pbr disables. Runs once after scene is fully built.
    try {
        if (window.Toonify && window.Toonify.enabled) {
            const r = window.Toonify.init(THREE, scene);
            console.log('[R32.20] Toonify pass complete:', r);
        }
    } catch (e) { console.warn('[R32.20] Toonify pass failed:', e && e.message ? e.message : e); }

    console.log('[R18] Init complete. Entering render loop.');
    requestAnimationFrame(loop);
}

// ============================================================
// Renderer
// ============================================================
function initRenderer() {
    const canvas = document.getElementById('canvas');
    const tier = readQualityFromSettings();
    renderer = new THREE.WebGLRenderer({
        canvas,
        antialias: true,
        powerPreference: 'high-performance',
    });
    renderer.setPixelRatio(tier.pixelRatio);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.0;  // R32.37.5: 0.8 -> 1.0 brightness bump (also set in initScene)
    renderer.shadowMap.enabled = tier.shadowMap > 0;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    canvas.style.visibility = 'visible';
}

function initScene() {
    scene = new THREE.Scene();
    // R32.0: Raindance.MIS canonical fog — haze 200m, visible 450m, pale overcast
    scene.fog = new THREE.FogExp2(0xC0C8D0, 0.0022); // R32.45: exponential² fog — softer haze than linear
    scene.background = new THREE.Color(0xC0C8D0);
    // R32.25.4-DIAG: expose for diagnostic overlay
    try { window.scene = scene; window.camera = camera; window.renderer = renderer; } catch(e) {}
    // R32.56: expose for debug panel
    window._tribesDebug = {
        scene, camera, renderer, composer,
        setComposerEnabled: function(on) {
            if (on && !composer) { try { initPostProcessing(); } catch(e) {} }
            else if (!on) { composer = null; }
        }
    };
}

// ============================================================
// R32.63: THREE.Sky removed. Sun position now computed in DayNight cycle.
// ============================================================
let sunPos = new THREE.Vector3();

// ============================================================
// R32.40-manus: Day/Night cycle. 30-min real-time loop = 24h game time
// (so 15 min day, 15 min night, with continuous dawn/dusk transitions).
// All mutations are scene-level (sunLight, hemiLight, fog, exposure,
// background/environment intensity) — no terrain shader is touched, so
// this is independent of the PBR-chunk fragility we hit in R32.38.x.
//
// Time mapping: t01 in [0,1) over the 30-min cycle, mapped to in-game
// hours [0..24). Sun elevation = sin( (h-6)/24 * 2pi ) so noon is +1
// (sun overhead) and midnight is -1 (sun directly below). Azimuth slowly
// rotates so the sun also moves east -> west across the sky over the day.
//
// URL params:
//   ?daynight=off      -> freeze at noon (legacy behavior)
//   ?daynight=fast     -> 5-min cycle (testing)
//   ?daynight=slow     -> 60-min cycle (cinematic)
//   ?daynight=h=NN     -> start at game hour NN (0..24), normal speed
// ============================================================
const DayNight = (() => {
    const params = (() => {
        try { return new URLSearchParams(window.location.search); }
        catch(e) { return new URLSearchParams(''); }
    })();
    const mode = (params.get('daynight') || '').toLowerCase();
    const startHourMatch = mode.match(/^h=(\d+(?:\.\d+)?)$/);
    const startHour = startHourMatch ? Math.max(0, Math.min(24, parseFloat(startHourMatch[1]))) : 8.0;
    const cycleSeconds = mode === 'off' ? Infinity
                       : mode === 'fast' ? 120
                       : mode === 'slow' ? 3600
                       : 1800; // default 30 minutes
    // start the cycle so first frame is `startHour` AM
    const startWallClock = performance.now() * 0.001;
    const startOffset01 = startHour / 24.0;

    // Color palette (Color.lerp targets). Matches typical sky tones.
    const palette = {
        nightSun:   new THREE.Color(0x2a3858),  // R32.90: strong moonlight
        dawnSun:    new THREE.Color(0xff8c4a),  // warm orange
        noonSun:    new THREE.Color(0xfff2cf),  // soft warm-white
        duskSun:    new THREE.Color(0xff5a2a),  // deep orange-red
        nightHemi:  new THREE.Color(0x3a4a68),  // R32.90: visible terrain at night
        dawnHemi:   new THREE.Color(0xc89878),  // warm peach fill
        noonHemi:   new THREE.Color(0xb8c4d8),  // slightly blue-white (was grey 0xc0c8d0)
        duskHemi:   new THREE.Color(0x4a3858),  // R32.63.7: cool purple dusk (was warm 0xb07858)
        hemiGround: new THREE.Color(0x4d473b),  // unchanged
        nightFog:   new THREE.Color(0x141e2c),  // R32.90: night fog with depth
        dawnFog:    new THREE.Color(0xd0a080),  // warm pink-orange haze
        noonFog:    new THREE.Color(0xa8b8c8),  // R32.63.6: slight blue haze (was flat grey)
        duskFog:    new THREE.Color(0x1a1828),  // R32.63.7: deep blue-purple dusk (was brown 0xb86848)
    };
    const _tmpA = new THREE.Color();
    const _tmpB = new THREE.Color();
    function lerpColors(c0, c1, c2, c3, t) {
        // 4-stop lerp: t in [0..1] maps midnight -> dawn -> noon -> dusk -> midnight
        // t in [0,0.25): c0->c1; [0.25,0.5): c1->c2; [0.5,0.75): c2->c3; [0.75,1): c3->c0
        let seg, k, a, b;
        if (t < 0.25)      { seg = 0; k = t * 4;          a = c0; b = c1; }
        else if (t < 0.50) { seg = 1; k = (t - 0.25) * 4; a = c1; b = c2; }
        else if (t < 0.75) { seg = 2; k = (t - 0.50) * 4; a = c2; b = c3; }
        else               { seg = 3; k = (t - 0.75) * 4; a = c3; b = c0; }
        _tmpA.copy(a).lerp(b, k);
        return _tmpA;
    }

    let lastHour = -1;
    let _frozen01 = null; // when 'off', freeze at noon

    function update() {
        if (cycleSeconds === Infinity) {
            // Frozen mode — once-only set to noon palette and bail.
            if (_frozen01 === null) {
                _frozen01 = 0.5; // noon
                _apply(_frozen01);
            }
            return;
        }
        const wall = performance.now() * 0.001 - startWallClock;
        const t01 = ((wall / cycleSeconds) + startOffset01) % 1.0;
        _apply(t01);
    }

    function _apply(t01) {
        // Sun elevation: sin curve, peak at t01=0.5 (noon), trough at t01=0.0 (midnight).
        const elevRad = Math.sin((t01 - 0.25) * Math.PI * 2);  // [-1, +1]
        // R32.63.2: Sun arc oriented along base axis (team0 → team1 ≈ +Z → -Z).
        // Sun rises from team0 direction, arcs overhead, sets toward team1.
        // dayFrac: 0 at dawn, 0.5 at noon, 1.0 at dusk
        const dayFrac = (t01 - 0.25);  // -0.25 at midnight, 0 at dawn, 0.25 at noon, 0.5 at dusk
        const azimRad = dayFrac * Math.PI * 2;  // full semicircle from east to west
        const r = Math.sqrt(Math.max(0.0, 1 - elevRad * elevRad));
        // Orient so sun travels along Z axis (base-to-base)
        sunPos.set(r * 0.3 * Math.cos(azimRad), elevRad, -r * Math.sin(azimRad));

        // Brightness curve: full at noon, zero at horizon and below.
        // Smooth night transition over 30deg below horizon so dusk fades gracefully.
        const dayMix = Math.max(0, Math.min(1, (elevRad + 0.05) / 0.40));   // 0 below -3deg, 1 above +20deg
        const nightMix = 1.0 - dayMix; // inverse: 1 at midnight, 0 at noon
        const dawnDuskMix = Math.max(0, 1 - Math.abs(elevRad) / 0.30);     // 1 near horizon, 0 high

        // Lerp sun color across a 4-stop palette tied to t01.
        const sunCol = lerpColors(palette.nightSun, palette.dawnSun, palette.noonSun, palette.duskSun, t01);
        if (typeof sunLight !== 'undefined' && sunLight) {
            sunLight.color.copy(sunCol);
            // R32.63.4: sun 1.6 (was 0.9). Higher ratio vs ambient = visible shadows.
            sunLight.intensity = 1.6 * dayMix;
            sunLight.castShadow = sunLight.intensity > 0.05;
        }

        // Moonlight
        if (typeof moonLight !== 'undefined' && moonLight) {
            moonLight.position.set(-sunPos.x * 100, Math.max(0.2, -elevRad) * 100, -sunPos.z * 100);
            moonLight.target.position.set(0, 0, 0);
            moonLight.color.setHex(0x6688cc);
            moonLight.intensity = 0.12 * nightMix;  // R32.63.6: subtle (was 0.3)
        }

        // Hemisphere fill — lowered to let directional sun dominate (shadow contrast)
        const hemiCol = lerpColors(palette.nightHemi, palette.dawnHemi, palette.noonHemi, palette.duskHemi, t01);
        if (typeof hemiLight !== 'undefined' && hemiLight) {
            hemiLight.color.copy(hemiCol);
            hemiLight.groundColor.copy(palette.hemiGround);
            // R32.63.6: 0.08 night → 0.35 noon (was 0.20→0.50, too much fill)
            hemiLight.intensity = 0.08 + 0.27 * dayMix;
        }

        // R32.91: Night ambient — ramps up as sun goes down, lifts terrain out of black
        if (window.__nightAmbient) {
            const nightFactor = 1.0 - dayMix; // 0 at noon, 1 at midnight
            window.__nightAmbient.intensity = nightFactor * 0.6;
            window.__nightAmbient.color.setHex(0x304060);
        }

        // R32.95: Terrain night emissive — self-lit moonlight glow, independent of exposure/sky
        if (typeof terrainMesh !== 'undefined' && terrainMesh && terrainMesh.material) {
            const nf = 1.0 - dayMix;
            terrainMesh.material.emissive.setHex(0x1a2540);
            terrainMesh.material.emissiveIntensity = nf * 0.35;
        }

        // Fog
        const fogCol = lerpColors(palette.nightFog, palette.dawnFog, palette.noonFog, palette.duskFog, t01);
        if (typeof scene !== 'undefined' && scene.fog) {
            scene.fog.color.copy(fogCol);
            // R32.63.6: fog density varies — thick at night (hide distant mountains),
            // lighter during day for depth/atmosphere
            scene.fog.density = 0.0006 + 0.0012 * nightMix;  // R32.63.8: very subtle (day 0.0006, night 0.0018)
        }

        // R32.63.6: env intensity lowered further — night near-zero, day moderate.
        if (typeof renderer !== 'undefined' && renderer) {
            renderer.toneMappingExposure = 0.80 + 0.20 * dayMix;  // R32.95: 0.80 night → 1.0 noon
        }
        if (typeof scene !== 'undefined') {
            // R32.63.6: env 0.05 at night → 0.45 at noon (was 0.15→0.55)
            if (scene.environmentIntensity !== undefined) {
                scene.environmentIntensity = 0.05 + 0.40 * dayMix;
            }
        }

        // Expose for custom sky dome (stars, moon, clouds)
        DayNight.dayMix = dayMix;
        DayNight.sunDir.copy(sunPos);

        // Update HUD clock chip (created in index.html).
        const h = Math.floor(t01 * 24);
        const m = Math.floor(((t01 * 24) - h) * 60);
        if (h !== lastHour) {
            lastHour = h;
        }
        if (typeof window !== 'undefined' && window.__tribesSetGameClock) {
            const ampm = (h % 24) < 12 ? 'AM' : 'PM';
            const hh = ((h % 12) === 0) ? 12 : (h % 12);
            const mm = (m < 10 ? '0' : '') + m;
            window.__tribesSetGameClock(`${hh}:${mm} ${ampm}`);
        }
    }

    return { update, _apply, freeze: function(h) { this._frozen = h; }, unfreeze: function() { this._frozen = null; }, _frozen: null, dayMix: 1.0, sunDir: new THREE.Vector3(0, 1, 0) };
})();
try { window.DayNight = DayNight; } catch(e) {}

// R32.63: HDRI loads for PBR environment ONLY. The visible sky background
// is handled by the custom sky dome. scene.background = null so the dome shows.
function loadHDRISky() {
    const hdrPath = 'assets/hdri/overcast_soil_puresky_2k.hdr';
    const pmrem = new THREE.PMREMGenerator(renderer);
    pmrem.compileEquirectangularShader();
    new RGBELoader().load(
        hdrPath,
        (hdrTex) => {
            hdrTex.mapping = THREE.EquirectangularReflectionMapping;
            const envRT = pmrem.fromEquirectangular(hdrTex);
            scene.environment = envRT.texture;       // PBR lighting only
            scene.background = null;                 // sky dome handles visuals
            scene.environmentIntensity = 1.45;       // fixed — never dimmed by DayNight
            hdrTex.dispose();
            pmrem.dispose();
            // Remove old THREE.Sky if it exists
            if (sky) {
                removeOldSky(scene, sky);
                sky = null;
            }
            if (renderer) renderer.toneMappingExposure = 1.15;
            console.log('[R32.63] HDRI env loaded (PBR only) — sky dome handles background');
        },
        undefined,
        (err) => {
            pmrem.dispose();
            scene.background = null; // still let sky dome show
            console.warn('[R32.63] HDRI load failed — sky dome active, no PBR env:', err.message || err);
        }
    );
}

function buildEnvironmentFromSky() {
    // R32.63: kept as emergency fallback but sky object may be null now
    if (!sky || !renderer) return;
    try {
        const pmrem = new THREE.PMREMGenerator(renderer);
        pmrem.compileEquirectangularShader();
        const skyScene = new THREE.Scene();
        skyScene.add(sky.clone(false));
        const envRT = pmrem.fromScene(skyScene, 0, 0.1, 100000);
        scene.environment = envRT.texture;
        if (!scene.children.includes(sky)) scene.add(sky);
        pmrem.dispose();
        console.log('[R30.2] PMREM environment built from Sky shader; PBR materials now lit');
    } catch (e) {
        console.warn('[R30.2] PMREM env build failed (non-fatal):', e);
    }
}

function initLights() {
    const tier = readQualityFromSettings();

    // R32.63: background = null — custom sky dome handles the visible sky
    scene.background = null;

    if (renderer) {
        renderer.toneMapping = THREE.ACESFilmicToneMapping;
        // R32.37.5-manus: exposure 0.8 -> 1.0 to brighten the scene per user.
        renderer.toneMappingExposure = 1.0;
        renderer.outputColorSpace = THREE.SRGBColorSpace;
    }

    // R32.37.5-manus: scene brightness bump per user ("its too dark").
    // Hemisphere fill 1.0 -> 1.5 (lifts shadowed undersides without crushing color).
    // Sun directional 1.4 -> 1.8 (brighter primary key light).
    // Tone-mapping exposure 0.8 -> 1.0 below (toneMapping is set in initRenderer).
    hemiLight = new THREE.HemisphereLight(0xC0C8D0, 0x4D473B, 1.5);
    scene.add(hemiLight);

    // R32.91: Night ambient light — flat fill so terrain isn't pitch black
    const nightAmbient = new THREE.AmbientLight(0x3040608, 0);
    scene.add(nightAmbient);
    window.__nightAmbient = nightAmbient;

    // R32.0: Sun — azimuth -90°, incidence 54°. R32.37.5: intensity 1.4 -> 1.8.
    sunLight = new THREE.DirectionalLight(0x999999, 1.8);
    sunLight.castShadow = tier.shadowMap > 0;
    if (tier.shadowMap > 0) {
        sunLight.shadow.mapSize.set(tier.shadowMap, tier.shadowMap);
        sunLight.shadow.camera.near = 5;
        sunLight.shadow.camera.far = 600;
        const s = 120; // R32.63.4: tighter frustum (was 200) = sharper shadows
        sunLight.shadow.camera.left = -s;
        sunLight.shadow.camera.right = s;
        sunLight.shadow.camera.top = s;
        sunLight.shadow.camera.bottom = -s;
        sunLight.shadow.bias = -0.0003;
        sunLight.shadow.normalBias = 0.03;
        sunLight.shadow.radius = 2; // R32.45→R32.47.1: soft PCF (was 3, caused edge flash)
    }
    scene.add(sunLight);
    scene.add(sunLight.target);

    // R32.60: Moonlight — cool blue directional light opposite the sun.
    // Provides terrain illumination at night so the landscape doesn't go
    // pitch black. Intensity driven by DayNight cycle (inverse of dayMix).
    moonLight = new THREE.DirectionalLight(0x4466aa, 0.0);
    moonLight.castShadow = false; // moon shadows would fight sun shadows
    scene.add(moonLight);
    scene.add(moonLight.target);
}

// R32.9 — splat data still exposed (for any code that wants to read terrain classification)
let _splatData = null;

// R32.9 — Painterly faceted Tribes terrain.
// Restores the original 257×257 faceted geometry that gave Tribes its identity.
// Layers on:
//   - 4 real CC0 PBR textures (grass / rock / dirt / sand) loaded once
//   - Stochastic anti-tiling (3 rotated samples per layer, hash-blended in shader)
//     — kills the visible repeating grid that procedural noise had
//   - Per-vertex "watercolor wash" color (slope+height+zone+low-freq noise)
//     painted in JS at load time, multiplied over the texture sample
//   - Baked per-vertex AO via 16-direction raycasts at load, multiplied in too
// Net: same Tribes silhouette and gameplay, but rendered like a Frederic Edwin
// Church painting instead of an indie procedural prototype.
async function initTerrain() {
    const ptr = Module._getHeightmapPtr();
    const rawSize = Module._getHeightmapSize();
    const rawScale = Module._getHeightmapWorldScale();
    const rawHeights = new Float32Array(Module.HEAPF32.buffer, ptr, rawSize * rawSize);

    // R32.64.3: Bicubic 2× upscale — smooth mountain silhouettes from same Raindance data
    const UPSCALE = 2;
    const size = (rawSize - 1) * UPSCALE + 1;  // 257→513
    const worldScale = rawScale / UPSCALE;
    const heights = new Float32Array(size * size);

    // Catmull-Rom interpolation for smooth curves through original height samples
    function catmullRom(p0, p1, p2, p3, t) {
        const t2 = t * t, t3 = t2 * t;
        return 0.5 * ((2 * p1) + (-p0 + p2) * t + (2*p0 - 5*p1 + 4*p2 - p3) * t2 + (-p0 + 3*p1 - 3*p2 + p3) * t3);
    }
    function rawH(i, j) {
        i = Math.max(0, Math.min(rawSize - 1, i));
        j = Math.max(0, Math.min(rawSize - 1, j));
        return rawHeights[j * rawSize + i];
    }
    for (let jOut = 0; jOut < size; jOut++) {
        for (let iOut = 0; iOut < size; iOut++) {
            const srcI = iOut / UPSCALE;
            const srcJ = jOut / UPSCALE;
            const i0 = Math.floor(srcI), j0 = Math.floor(srcJ);
            const fi = srcI - i0, fj = srcJ - j0;
            // Bicubic: interpolate 4 rows in i, then interpolate results in j
            let colVals = [];
            for (let dj = -1; dj <= 2; dj++) {
                colVals.push(catmullRom(
                    rawH(i0 - 1, j0 + dj), rawH(i0, j0 + dj),
                    rawH(i0 + 1, j0 + dj), rawH(i0 + 2, j0 + dj), fi
                ));
            }
            heights[jOut * size + iOut] = catmullRom(colVals[0], colVals[1], colVals[2], colVals[3], fj);
        }
    }
    console.log('[R32.64.3] Terrain bicubic upscale: ' + rawSize + '→' + size + ' (' + (size*size) + ' verts, scale ' + worldScale.toFixed(2) + ')');

    _htSize = size; _htScale = worldScale;
    _htData = new Float32Array(heights);

    const span = (size - 1) * worldScale;
    const segs = size - 1;

    // ---- 1. Faceted geometry: 257×257 verts, identical to canonical Raindance ----
    const geom = new THREE.PlaneGeometry(span, span, segs, segs);
    geom.rotateX(-Math.PI / 2);
    const pos = geom.attributes.position;
    for (let j = 0; j < size; j++) {
        for (let i = 0; i < size; i++) {
            pos.setY(j * size + i, heights[j * size + i]);
        }
    }
    pos.needsUpdate = true;

    // ---- 2. Compute splat weights + watercolor wash per-vertex (in JS) ----
    let hMin = Infinity, hMax = -Infinity;
    for (let i = 0; i < heights.length; i++) {
        if (heights[i] < hMin) hMin = heights[i];
        if (heights[i] > hMax) hMax = heights[i];
    }
    const hRange = Math.max(0.01, hMax - hMin);
    const half = span * 0.5;

    // R32.10 — Splat weights + grass-A/B blend + wash with macro variation,
    // path zones (dirt threading from each base toward basin/bridge), and wet patches.
    const splatAttr    = new Float32Array(size * size * 4);  // (grass, rock, dirt, sand)
    // R32.10.1: grass species blend moved to fragment shader (per-pixel smooth noise) to kill triangle-edge seams
    // R32.10.3: aWash and aAO vertex attributes removed entirely — their interp
    // across faceted-triangle edges produced visible diagonal seam lines. All
    // painterly variation is now per-pixel in the fragment shader (see below).
    function H(i, j) {
        i = Math.max(0, Math.min(size - 1, i));
        j = Math.max(0, Math.min(size - 1, j));
        return heights[j * size + i];
    }
    // Three independent low-freq noise fields, all in 0..1.
    function noiseA(x, z) {  // grass color macro variation — slow broad zones
        const s = Math.sin(x * 0.0017 + z * 0.0019 + 3.7) * 0.55
                + Math.sin(x * 0.0061 + z * 0.0048 - 1.2) * 0.30
                + Math.sin(x * 0.0204 - z * 0.0223 + 5.1) * 0.15;
        return s * 0.5 + 0.5;
    }
    function noiseB(x, z) {  // grass species (A/B) selector
        const s = Math.sin(x * 0.0028 - z * 0.0024 + 8.4) * 0.50
                + Math.sin(x * 0.0098 + z * 0.0089 + 0.7) * 0.35
                + Math.sin(x * 0.0273 + z * 0.0319 - 4.6) * 0.15;
        return s * 0.5 + 0.5;
    }
    function noiseC(x, z) {  // wet patches — sharp threshold mask
        const s = Math.sin(x * 0.0042 + z * 0.0038 - 2.3) * 0.65
                + Math.sin(x * 0.0119 - z * 0.0107 + 1.6) * 0.35;
        return s * 0.5 + 0.5;
    }
    // Distance from point to segment (path zones).
    function distToSegment(px, pz, ax, az, bx, bz) {
        const ddx = bx - ax, ddz = bz - az;
        const len2 = ddx*ddx + ddz*ddz;
        if (len2 < 1e-3) return Math.hypot(px-ax, pz-az);
        let t = ((px-ax)*ddx + (pz-az)*ddz) / len2;
        t = Math.max(0, Math.min(1, t));
        return Math.hypot(px - (ax + t*ddx), pz - (az + t*ddz));
    }
    const BASE_T0 = [286.6, -286.7];
    const BASE_T1 = [-296.5, 296.7];
    const BRIDGE  = [-291.6, 296.7];
    const BASIN   = [0, 0];
    for (let j = 0; j < size; j++) {
        for (let i = 0; i < size; i++) {
            const idx = j * size + i;
            const h = heights[idx];
            const hN = (h - hMin) / hRange;
            const dx = (H(i+1, j) - H(i-1, j)) / (2 * worldScale);
            const dz = (H(i, j+1) - H(i, j-1)) / (2 * worldScale);
            const slope = Math.sqrt(dx*dx + dz*dz);
            const slopeN = Math.min(1, slope * 1.4);

            const wx = (i / (size - 1) - 0.5) * span;
            const wz = (j / (size - 1) - 0.5) * span;
            const nA = noiseA(wx, wz);
            const nB = noiseB(wx, wz);
            const nC = noiseC(wx, wz);

            // ---- Base splat (slope + height) ----
            let g  = Math.max(0, 1 - slopeN * 2.5) * Math.max(0.35, 1 - hN * 0.55);
            let r  = Math.max(0, slopeN * 1.7 - 0.18);
            let dt = Math.max(0, 0.5 - Math.abs(slopeN - 0.4) * 1.8) * 0.7;
            let sd = Math.max(0, (1 - hN) * 0.55 - slopeN * 1.5);

            // ---- Path zones: dirt threading along base→basin/bridge routes ----
            const pathDist = Math.min(
                distToSegment(wx, wz, BASE_T0[0], BASE_T0[1], BASIN[0],  BASIN[1]),
                distToSegment(wx, wz, BASE_T1[0], BASE_T1[1], BRIDGE[0], BRIDGE[1])
            );
            const pathW = Math.max(0, 1 - pathDist / 24);
            const pathRagged = pathW * (0.55 + 0.45 * nB);
            if (slopeN < 0.5) {
                dt += pathRagged * 0.95;
                g  *= 1 - pathRagged * 0.7;
            }

            // ---- Wet patches: low+flat where noiseC peaks ----
            let wetness = 0;
            if (slopeN < 0.35 && hN < 0.55) {
                const tWet = Math.max(0, nC - 0.62) * 2.6;
                wetness = Math.min(1, tWet) * (0.65 + 0.35 * (1 - hN));
                dt += wetness * 0.35;
                g  *= 1 - wetness * 0.30;
            }

            // ---- Trampled near each base ----
            const baseDist = Math.min(
                Math.hypot(wx - BASE_T0[0], wz - BASE_T0[1]),
                Math.hypot(wx - BASE_T1[0], wz - BASE_T1[1])
            );
            if (baseDist < 35) {
                const tT = 1 - baseDist / 35;
                dt += tT * 0.6;
                g  *= 1 - tT * 0.5;
            }

            const sum = g + r + dt + sd + 1e-4;
            const aIdx = idx * 4;
            splatAttr[aIdx]   = g / sum;
            splatAttr[aIdx+1] = r / sum;
            splatAttr[aIdx+2] = dt / sum;
            splatAttr[aIdx+3] = sd / sum;

            // R32.10.3: per-vertex watercolor wash baking removed; replaced by
            // per-pixel multi-octave smooth noise in the fragment shader. The
            // baked noiseA/noiseB/noiseC fields above are still used for splat
            // weights (grass/rock/dirt/sand selection), but the painterly tint
            // is no longer per-vertex — so faceted triangle edges can't show
            // a tint discontinuity along their seam.
        }
    }
    geom.setAttribute('aSplat', new THREE.BufferAttribute(splatAttr, 4));
    _splatData = { splatAttr, size };

    // R32.10.3: Per-vertex AO bake removed (was 256K horizon raycasts at load,
    // ~250ms one-time cost). Replaced by per-pixel slope+height shading in the
    // fragment shader using dFdx/dFdy of vWorldY, which is C¹-continuous and
    // doesn't introduce per-vertex values that interp across triangle seams.

    // ---- 4. Hybrid shading: faceted texture + smooth lighting normals ----
    // R32.11.1: pure flat shading (face normals) gave the unmistakable Tribes
    // silhouette but produced harsh diagonal LIGHTING seams at every triangle
    // edge — with the sun at a low angle, adjacent triangles' brightness jumped
    // visibly. Fix: compute SMOOTH per-vertex normals from the underlying
    // heightmap (central-difference dy/dx,dy/dz → normalize) BEFORE we split
    // the geometry into per-triangle vertices. Store them as a custom
    // `aSmoothNormal` attribute. Then non-index the geometry (each triangle
    // gets its own copy of those smooth normals at its 3 corners). In the
    // material's vertex shader we override `objectNormal` with aSmoothNormal,
    // so PBR lighting uses smooth normals (no triangle-edge brightness jumps),
    // while the *geometry* is still faceted (silhouette retained). Texture,
    // wash, splat, and AO are all unchanged — the per-triangle texture
    // appearance (the painterly facet feel) is preserved.
    const smoothNormals = new Float32Array(size * size * 3);
    for (let j = 0; j < size; j++) {
        for (let i = 0; i < size; i++) {
            const idx = j * size + i;
            // Central differences (clamped at edges) on the heightmap.
            const iL = Math.max(0, i - 1), iR = Math.min(size - 1, i + 1);
            const jU = Math.max(0, j - 1), jD = Math.min(size - 1, j + 1);
            const hL = heights[j * size + iL], hR = heights[j * size + iR];
            const hU = heights[jU * size + i], hD = heights[jD * size + i];
            // dx,dz are world-space step sizes between samples
            const dx = (iR - iL) * worldScale;
            const dz = (jD - jU) * worldScale;
            // Surface tangents: tx = (dx, hR-hL, 0), tz = (0, hD-hU, dz)
            // Normal n = normalize(cross(tz, tx))  (Y-up, +X right, +Z forward)
            const nx = -(hR - hL) * dz;
            const ny = dx * dz;
            const nz = -(hD - hU) * dx;
            const len = Math.hypot(nx, ny, nz) || 1;
            smoothNormals[idx * 3]     = nx / len;
            smoothNormals[idx * 3 + 1] = ny / len;
            smoothNormals[idx * 3 + 2] = nz / len;
        }
    }
    geom.setAttribute('aSmoothNormal', new THREE.BufferAttribute(smoothNormals, 3));

    // R32.65: With 2× bicubic upscale, triangles are small enough that
    // flat facets are invisible. Use indexed geometry (shared vertices)
    // for ~6× less vertex processing vs toNonIndexed().
    // Set the normal attribute to smoothNormals directly.
    geom.setAttribute('normal', new THREE.BufferAttribute(smoothNormals, 3));
    const finalGeom = geom;

    // ---- 5. R32.42: Texture Array architecture ----
    // Pack terrain textures into 3 sampler2DArray (color, normal, AO) instead
    // of 15 individual sampler2D. Drops fragment-shader texture units from 15+
    // to 3, fixing MAX_TEXTURE_IMAGE_UNITS(16) failure on Apple Silicon /
    // ANGLE-Metal and providing headroom for roughness and future PBR features.
    // Layer order: 0=grass1, 1=grass2, 2=rock, 3=dirt, 4=sand

    const TEX_SIZE = 1024;
    const TEX_LAYERS = 5;
    const colorPaths = [
        'assets/textures/terrain/grass001_color.jpg',
        'assets/textures/terrain/grass002_color.jpg',
        'assets/textures/terrain/rock030_color.jpg',
        'assets/textures/terrain/ground037_color.jpg',
        'assets/textures/terrain/ground003_color.jpg',
    ];
    const normalPaths = [
        'assets/textures/terrain/grass001_normal.jpg',
        'assets/textures/terrain/grass002_normal.jpg',
        'assets/textures/terrain/rock030_normal.jpg',
        'assets/textures/terrain/ground037_normal.jpg',
        'assets/textures/terrain/ground003_normal.jpg',
    ];
    const aoPaths = [
        'assets/textures/terrain/grass001_ao.jpg',
        'assets/textures/terrain/grass002_ao.jpg',
        'assets/textures/terrain/rock030_ao.jpg',
        'assets/textures/terrain/ground037_ao.jpg',
        'assets/textures/terrain/ground003_ao.jpg',
    ];

    function loadImageAsync(url) {
        return new Promise((resolve, reject) => {
            const img = new Image();
            img.crossOrigin = 'anonymous';
            img.onload = () => resolve(img);
            img.onerror = () => reject(new Error('Failed to load: ' + url));
            img.src = url;
        });
    }

    async function buildArrayTexture(paths, isColor) {
        const images = await Promise.all(paths.map(loadImageAsync));
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = TEX_SIZE;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        const data = new Uint8Array(TEX_SIZE * TEX_SIZE * 4 * TEX_LAYERS);
        for (let i = 0; i < images.length; i++) {
            ctx.clearRect(0, 0, TEX_SIZE, TEX_SIZE);
            ctx.drawImage(images[i], 0, 0, TEX_SIZE, TEX_SIZE);
            const imgData = ctx.getImageData(0, 0, TEX_SIZE, TEX_SIZE);
            data.set(new Uint8Array(imgData.data.buffer), i * TEX_SIZE * TEX_SIZE * 4);
        }
        const tex = new THREE.DataArrayTexture(data, TEX_SIZE, TEX_SIZE, TEX_LAYERS);
        tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
        tex.magFilter = THREE.LinearFilter;
        tex.minFilter = THREE.LinearMipmapLinearFilter;
        tex.generateMipmaps = true;
        if (isColor) tex.colorSpace = THREE.SRGBColorSpace;
        tex.needsUpdate = true;
        return tex;
    }

    console.log('[R32.42] Building terrain texture arrays (3 x ' + TEX_SIZE + 'x' + TEX_SIZE + 'x' + TEX_LAYERS + ')...');
    const [terrainColorArr, terrainNormalArr, terrainAOArr] = await Promise.all([
        buildArrayTexture(colorPaths, true),
        buildArrayTexture(normalPaths, false),
        buildArrayTexture(aoPaths, false),
    ]);
    // R32.45: anisotropic filtering — sharpen terrain at oblique viewing angles (zero cost on modern GPUs)
    const maxAniso = renderer.capabilities.getMaxAnisotropy();
    terrainColorArr.anisotropy = maxAniso;
    terrainNormalArr.anisotropy = maxAniso;
    terrainAOArr.anisotropy = maxAniso;
    console.log('[R32.42] Texture arrays built — 3 sampler2DArray (was 15 sampler2D), anisotropy=' + maxAniso);

    // Dummy 1x1 normal map so Three.js defines USE_NORMALMAP_TANGENTSPACE
    // and computes the TBN matrix in normal_fragment_begin. We never sample
    // this texture — our shader uses the array texture for actual normals.
    const dummyNormal = new THREE.DataTexture(
        new Uint8Array([128, 128, 255, 255]), 1, 1, THREE.RGBAFormat
    );
    dummyNormal.needsUpdate = true;

    const mat = new THREE.MeshStandardMaterial({
        // R32.42: map removed — color texturing is entirely custom shader.
        // normalMap is a dummy to trigger USE_NORMALMAP_TANGENTSPACE for TBN.
        normalMap: dummyNormal,
        normalScale: new THREE.Vector2(0.7, 0.7),
        roughness: 0.93,
        metalness: 0.0,
        envMapIntensity: 0.30,
    });
    mat.userData.tiles = {}; // R32.42: individual tiles replaced by array textures

    function _pbrInit(key, dflt) {
        try {
            if (window.ST && typeof window.ST[key] === 'boolean') return window.ST[key] ? 1.0 : 0.0;
        } catch(e) {}
        return dflt ? 1.0 : 0.0;
    }

    mat.onBeforeCompile = (shader) => {
        // R32.42: 3 array texture uniforms (was 15 individual sampler2D)
        shader.uniforms.uTerrainColor  = { value: terrainColorArr };
        shader.uniforms.uTerrainNormal = { value: terrainNormalArr };
        shader.uniforms.uTerrainAO     = { value: terrainAOArr };
        shader.uniforms.uTerrainSize = { value: span };
        shader.uniforms.uTileMeters  = { value: 9.0 };
        shader.uniforms.uTime        = { value: 0.0 };
        shader.uniforms.uWindDir     = { value: new THREE.Vector2(0.8, 0.6) };
        shader.uniforms.uWindSpeed   = { value: 0.85 };
        const _fuzzOff = (typeof location !== 'undefined') && /[?&]fuzz=off\b/.test(location.search);
        shader.uniforms.uGrassFuzz   = { value: _fuzzOff ? 0.0 : 1.0 };
        // R32.42: roughness now enabled by default (headroom from array textures)
        shader.uniforms.uUseRoughness = { value: _pbrInit('pbrRoughness', true) };
        shader.uniforms.uUseAO        = { value: _pbrInit('pbrAO', true) };
        shader.uniforms.uUsePOM       = { value: 0.0 };

        shader.vertexShader = shader.vertexShader
            .replace('#include <common>',
                `#include <common>
                 attribute vec4 aSplat;
                 attribute vec3 aSmoothNormal;
                 varying vec4 vSplat;
                 varying vec2 vWorldXZ;
                 varying float vWorldY;
                 varying vec3 vSmoothNormal;`)
            .replace('#include <beginnormal_vertex>',
                `vec3 objectNormal = aSmoothNormal;
                 #ifdef USE_TANGENT
                   vec3 objectTangent = vec3( tangent.xyz );
                 #endif`)
            .replace('#include <begin_vertex>',
                `#include <begin_vertex>
                 vSplat = aSplat;
                 vWorldXZ = position.xz;
                 vWorldY = position.y;
                 vSmoothNormal = normalize(normalMatrix * aSmoothNormal);`);

        // R32.42: Fragment shader — sampler2DArray for all terrain textures
        shader.fragmentShader = shader.fragmentShader
            .replace('uniform vec3 diffuse;',
                `uniform vec3 diffuse;
                 uniform sampler2DArray uTerrainColor;
                 uniform sampler2DArray uTerrainNormal;
                 uniform sampler2DArray uTerrainAO;
                 uniform float uUseAO;
                 uniform float uUseRoughness;
                 uniform float uTileMeters;
                 uniform float uTerrainSize;
                 varying vec4 vSplat;
                 varying vec2 vWorldXZ;
                 varying float vWorldY;
                 varying vec3 vSmoothNormal;
                 uniform float uTime;
                 uniform vec2 uWindDir;
                 uniform float uWindSpeed;
                 uniform float uGrassFuzz;
                 // Layer indices: 0=grass1, 1=grass2, 2=rock, 3=dirt, 4=sand
                 float th_hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
                 float vh(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
                 float vnoise(vec2 p) {
                     vec2 i = floor(p), f = fract(p);
                     vec2 u = f*f*(3.0-2.0*f);
                     return mix(mix(vh(i), vh(i+vec2(1,0)), u.x),
                                mix(vh(i+vec2(0,1)), vh(i+vec2(1,1)), u.x), u.y);
                 }
                 // R32.65.5: middle-ground sampling — 1 plain fetch + procedural anti-tile noise
                 // Replaces stochastic (3 fetches/sample). UV perturbation breaks tiling,
                 // post-fetch noise adds variation. ~5 fetches total vs 35 stochastic.
                 vec4 antiTileSample(sampler2DArray tex, vec2 uv, float layer) {
                     // Smooth UV perturbation to break tiling grid alignment
                     float pn1 = vnoise(uv * 0.37);
                     float pn2 = vnoise(uv * 0.41 + vec2(7.3, 3.1));
                     vec2 pertUv = uv + vec2(pn1, pn2) * 0.12;
                     vec4 c = texture(tex, vec3(pertUv, layer));
                     // Per-cell brightness variation to mask remaining repetition
                     float cellVar = vnoise(uv * 0.19 + vec2(layer * 5.7, layer * 3.1));
                     c.rgb *= 0.92 + cellVar * 0.16;
                     return c;
                 }`)
            .replace('#include <map_fragment>',
                `float wSum = max(1e-4, vSplat.r + vSplat.g + vSplat.b + vSplat.a);
                 vec4 splatW = vSplat / wSum;
                 vec2 tUv = vWorldXZ / uTileMeters;
                 float gMix = smoothstep(0.30, 0.70, vnoise(vWorldXZ * 0.0125));
                 // 1 fetch per layer (skip layers with <5% weight)
                 vec4 cG = vec4(0.0);
                 if (splatW.r > 0.05) {
                     vec4 cG1 = antiTileSample(uTerrainColor, tUv, 0.0);
                     vec4 cG2 = antiTileSample(uTerrainColor, tUv * 0.83 + vec2(13.7, 7.1), 1.0);
                     cG = mix(cG1, cG2, gMix);
                 }
                 vec4 cR = splatW.g > 0.05 ? antiTileSample(uTerrainColor, tUv, 2.0) : vec4(0.0);
                 vec4 cD = splatW.b > 0.05 ? antiTileSample(uTerrainColor, tUv, 3.0) : vec4(0.0);
                 vec4 cS = splatW.a > 0.05 ? antiTileSample(uTerrainColor, tUv, 4.0) : vec4(0.0);
                 vec4 sampledDiffuseColor = cG * splatW.r + cR * splatW.g + cD * splatW.b + cS * splatW.a;
                 float n1 = vnoise(vWorldXZ * 0.012);
                 float n2 = vnoise(vWorldXZ * 0.045 + vec2(31.7, 19.3));
                 float n3 = vnoise(vWorldXZ * 0.18 + vec2(7.4, 53.1));
                 float washCombo = n1 * 0.55 + n2 * 0.30 + n3 * 0.15;
                 float hN = clamp((vWorldY - 6.65) / 70.25, 0.0, 1.0);
                 vec3 wash = vec3(1.0);
                 wash.r += (washCombo - 0.5) * 0.16 + (hN - 0.4) * 0.12;
                 wash.g += (washCombo - 0.5) * 0.10 + (hN - 0.4) * 0.05;
                 wash.b += (washCombo - 0.5) * 0.07 - (hN - 0.4) * 0.09;
                 // R32.65.1: slope from smooth normal (continuous across edges)
                 // replaces dFdx/dFdy which was per-triangle and caused visible seams
                 float slopeFromNormal = 1.0 - vSmoothNormal.y;  // 0=flat, 1=vertical
                 float slopeShade = 1.0 - smoothstep(0.05, 0.40, slopeFromNormal) * 0.35;
                 float heightShade = 0.78 + 0.22 * hN;
                 float pAO = slopeShade * heightShade;
                 sampledDiffuseColor.rgb *= wash;
                 sampledDiffuseColor.rgb *= pAO;
                 // R32.65.5: procedural AO replaces texture AO — slope + height + noise
                 {
                     float aoSlope = 1.0 - smoothstep(0.1, 0.6, slopeFromNormal) * 0.25;
                     float aoHeight = 0.82 + 0.18 * hN;
                     float aoNoise = 0.95 + vnoise(vWorldXZ * 0.08) * 0.10;
                     sampledDiffuseColor.rgb *= aoSlope * aoHeight * aoNoise;
                 }
                 {
                     float lum = dot(sampledDiffuseColor.rgb, vec3(0.299, 0.587, 0.114));
                     sampledDiffuseColor.rgb = lum + (sampledDiffuseColor.rgb - lum) * 1.10;
                 }
                 diffuseColor *= sampledDiffuseColor;`)
            .replace('#include <normal_fragment_maps>',
                `// R32.65.5: skip normal map textures entirely — smooth vertex normals
                 // are sufficient with the 2× upscaled terrain. Procedural micro-detail
                 // via noise perturbation of the interpolated normal.
                 {
                     float nPert1 = vnoise(vWorldXZ * 0.35) * 2.0 - 1.0;
                     float nPert2 = vnoise(vWorldXZ * 0.35 + vec2(17.1, 31.4)) * 2.0 - 1.0;
                     normal += tbn[0] * nPert1 * 0.04 + tbn[1] * nPert2 * 0.04;
                     normal = normalize(normal);
                 }`)
            // R32.42: luminance-derived roughness (now safe with only 3+internals sampler units)
            .replace('#include <roughnessmap_fragment>',
                `float roughnessFactor = roughness;
                 if (uUseRoughness > 0.5) {
                     float lum = dot(sampledDiffuseColor.rgb, vec3(0.299, 0.587, 0.114));
                     roughnessFactor = mix(0.97, 0.72, clamp(lum * 1.4, 0.0, 1.0));
                     roughnessFactor = clamp(roughnessFactor, 0.55, 0.98);
                 }`);

        console.log('[R32.42] Terrain shader: 3 sampler2DArray + Three.js internals (was 15 sampler2D)');
        console.log('[R32.42] GPU max fragment texture units:', renderer.capabilities.maxTextures);

        mat.userData.shader = shader;
    };

    terrainMesh = new THREE.Mesh(finalGeom, mat);
    terrainMesh.receiveShadow = true;
    scene.add(terrainMesh);
    // R32.37.1-manus: live PBR toggle hook — index.html settings checkboxes
    // call this on change to flip the uniform without recompile.
    window.__tribesSetTerrainPBR = function(key, on) {
        if (!terrainMesh || !terrainMesh.material || !terrainMesh.material.userData) return;
        const sh = terrainMesh.material.userData.shader;
        if (!sh || !sh.uniforms) return;
        const map = { roughness: 'uUseRoughness', ao: 'uUseAO', pom: 'uUsePOM' };
        const uname = map[key];
        if (!uname || !sh.uniforms[uname]) return;
        sh.uniforms[uname].value = on ? 1.0 : 0.0;
        terrainMesh.material.needsUpdate = false; // uniform-only change, no recompile
    };
    console.log('[R32.42] Terrain: 3 array textures (color+normal+AO), roughness enabled, POM disabled');
}

// ============================================================
// Buildings — composite procedural meshes per type
// ============================================================
function createBuildingMesh(type, halfExtents, colorRGB) {
    const group = new THREE.Group();
    const tint = new THREE.Color(colorRGB[0], colorRGB[1], colorRGB[2]);
    const baseMat = new THREE.MeshStandardMaterial({ color: tint, roughness: 0.85, metalness: 0.15 });
    const accentMat = new THREE.MeshStandardMaterial({ color: 0x303030, roughness: 0.55, metalness: 0.6 });

    if (type === 3) {
        // TURRET — pedestal + dome + barrel
        const pedGeom = new THREE.CylinderGeometry(halfExtents[0] * 0.9, halfExtents[0] * 1.05, halfExtents[1] * 1.4, 24);
        const ped = new THREE.Mesh(pedGeom, baseMat);
        ped.position.y = halfExtents[1] * 0.7;
        ped.castShadow = ped.receiveShadow = true;
        group.add(ped);
        const domeGeom = new THREE.SphereGeometry(halfExtents[0] * 1.1, 24, 16, 0, Math.PI * 2, 0, Math.PI * 0.55);
        const dome = new THREE.Mesh(domeGeom, accentMat);
        dome.position.y = halfExtents[1] * 1.45;
        dome.castShadow = true;
        group.add(dome);
        const barrelGeom = new THREE.CylinderGeometry(0.13, 0.16, 1.4, 16);
        const barrel = new THREE.Mesh(barrelGeom, accentMat);
        barrel.rotation.z = Math.PI / 2;
        barrel.position.set(halfExtents[0] * 1.0, halfExtents[1] * 1.45, 0);
        barrel.castShadow = true;
        group.add(barrel);
        // Sensor "eye" — small emissive dot on dome
        const eyeGeom = new THREE.SphereGeometry(0.08, 12, 8);
        const eyeMat = new THREE.MeshBasicMaterial({ color: 0xff3333 });
        const eye = new THREE.Mesh(eyeGeom, eyeMat);
        eye.position.set(halfExtents[0] * 0.9, halfExtents[1] * 1.55, 0.0);
        group.add(eye);
        group.userData = { barrel: barrel };
    } else if (type === 4) {
        // STATION — cylindrical kiosk + glowing display
        const cylGeom = new THREE.CylinderGeometry(halfExtents[0] * 1.2, halfExtents[0] * 1.3, halfExtents[1] * 2, 28);
        const cyl = new THREE.Mesh(cylGeom, baseMat);
        cyl.position.y = halfExtents[1];
        cyl.castShadow = cyl.receiveShadow = true;
        group.add(cyl);
        // Glowing top ring
        const ringGeom = new THREE.TorusGeometry(halfExtents[0] * 1.3, 0.06, 12, 32);
        const ringMat = new THREE.MeshBasicMaterial({ color: 0xFFC850 });
        const ring = new THREE.Mesh(ringGeom, ringMat);
        ring.rotation.x = Math.PI / 2;
        ring.position.y = halfExtents[1] * 1.95;
        group.add(ring);
        // Display panels (4 sides)
        for (let i = 0; i < 4; i++) {
            const angle = i * Math.PI / 2;
            const panelGeom = new THREE.PlaneGeometry(halfExtents[0] * 0.9, halfExtents[1] * 0.7);
            const panelMat = new THREE.MeshBasicMaterial({ color: 0xFFC850, transparent: true, opacity: 0.8, side: THREE.DoubleSide });
            const panel = new THREE.Mesh(panelGeom, panelMat);
            panel.position.set(Math.sin(angle) * halfExtents[0] * 1.21, halfExtents[1] * 1.1, Math.cos(angle) * halfExtents[0] * 1.21);
            panel.lookAt(panel.position.x * 100, panel.position.y, panel.position.z * 100);
            group.add(panel);
        }
    } else if (type === 2) {
        // GENERATOR — angular box + emissive panels (4 sides)
        const boxGeom = new THREE.BoxGeometry(halfExtents[0] * 2, halfExtents[1] * 2, halfExtents[2] * 2);
        const box = new THREE.Mesh(boxGeom, baseMat);
        box.position.y = halfExtents[1];
        box.castShadow = box.receiveShadow = true;
        group.add(box);
        // R31.1: dimmed emissive panels — bright 0x40FF80 was the source of
        // the "large floating green triangle" (panel above terrain while
        // generator body was buried). Dimmed to 0x1A5530 + StandardMaterial
        // so PBR lighting governs visibility rather than always-on basic.
        const panelMat = new THREE.MeshStandardMaterial({ color: 0x1A5530, emissive: 0x0D2A18, emissiveIntensity: 0.6, roughness: 0.6, metalness: 0.0, transparent: false });
        for (let i = 0; i < 4; i++) {
            const angle = i * Math.PI / 2;
            const panelGeom = new THREE.PlaneGeometry(halfExtents[0] * 1.3, halfExtents[1] * 0.9);
            const panel = new THREE.Mesh(panelGeom, panelMat);
            panel.position.set(Math.sin(angle) * halfExtents[0] * 1.005, halfExtents[1] * 1.1, Math.cos(angle) * halfExtents[2] * 1.005);
            panel.lookAt(panel.position.x * 100, panel.position.y, panel.position.z * 100);
            group.add(panel);
        }
        // Top vent
        const ventGeom = new THREE.BoxGeometry(halfExtents[0] * 1.6, 0.1, halfExtents[2] * 1.6);
        const vent = new THREE.Mesh(ventGeom, accentMat);
        vent.position.y = halfExtents[1] * 2 + 0.05;
        group.add(vent);
        group.userData = { panels: group.children.slice(1, 5), aliveColor: 0x1A5530, deadColor: 0x202020 };
    } else if (type === 1) {
        // TOWER — vertical box with crown
        const boxGeom = new THREE.BoxGeometry(halfExtents[0] * 1.8, halfExtents[1] * 2, halfExtents[2] * 1.8);
        const box = new THREE.Mesh(boxGeom, baseMat);
        box.position.y = halfExtents[1];
        box.castShadow = box.receiveShadow = true;
        group.add(box);
        const crownGeom = new THREE.BoxGeometry(halfExtents[0] * 2.4, 0.25, halfExtents[2] * 2.4);
        const crown = new THREE.Mesh(crownGeom, accentMat);
        crown.position.y = halfExtents[1] * 2;
        crown.castShadow = true;
        group.add(crown);
    } else {
        // INTERIOR (default) — angular box with edge accents
        const boxGeom = new THREE.BoxGeometry(halfExtents[0] * 2, halfExtents[1] * 2, halfExtents[2] * 2);
        const box = new THREE.Mesh(boxGeom, baseMat);
        box.position.y = halfExtents[1];
        box.castShadow = box.receiveShadow = true;
        group.add(box);
        // Bottom skirt
        const skirtGeom = new THREE.BoxGeometry(halfExtents[0] * 2.15, 0.15, halfExtents[2] * 2.15);
        const skirt = new THREE.Mesh(skirtGeom, accentMat);
        skirt.position.y = 0.075;
        group.add(skirt);
    }
    return group;
}

// ============================================================
// R32.3: Canonical building classifier + mesh builder.
// The C++ side bakes every Raindance building with type=0 (generic) so the
// downstream renderer falls into the default "box+skirt" fallback for all of
// them — generators, turrets, stations, and sensors all look identical.
// To restore visual identity without touching the C++ build, we load
// canonical.json and match each baked AABB against the canonical entries
// by world position. Once classified by datablock string we dispatch to
// a typed mesh builder with team color tint.
// Coordinate convention: MIS (x, y, z-up) -> world (x = mis_x, y = mis_z, z = -mis_y)
// Existing C++ pipeline already does this swap when populating g_rBuildings.
// ============================================================
let _r32_3_classifier = null;

async function _loadCanonicalClassifier() {
    if (_r32_3_classifier) return _r32_3_classifier;
    try {
        const res = await fetch('assets/maps/raindance/canonical.json');
        if (!res.ok) return null;
        const c = await res.json();
        const toWorld = (mp) => ({ x: mp[0], y: mp[2], z: -mp[1] });
        const items = [];
        const pushAll = (list, datablock, teamIdx) => {
            (list || []).forEach(s => {
                if (datablock && s.datablock !== datablock && datablock !== '*') return;
                const w = toWorld(s.position);
                items.push({
                    x: w.x, y: w.y, z: w.z,
                    datablock: s.datablock, name: s.name, team: teamIdx,
                });
            });
        };
        ['team0', 'team1'].forEach((tk, ti) => {
            const t = c[tk]; if (!t) return;
            pushAll(t.static_shapes, '*', ti);
            pushAll(t.turrets,       '*', ti);
            pushAll(t.sensors,       '*', ti);
        });
        _r32_3_classifier = items;
        return items;
    } catch (e) {
        console.warn('[R32.3] classifier load failed', e);
        return null;
    }
}

// Look up the canonical entry whose world position is closest to (px,py,pz).
// Returns { datablock, team } or null if no match within radius.
function _classifyBuilding(items, px, py, pz, radius = 4.0) {
    if (!items) return null;
    let best = null, bestD2 = radius * radius;
    for (let i = 0; i < items.length; i++) {
        const it = items[i];
        const dx = it.x - px, dy = it.y - py, dz = it.z - pz;
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 < bestD2) { bestD2 = d2; best = it; }
    }
    return best;
}

// Team tint helpers — used as accent on generators/turrets/stations
function _teamAccent(teamIdx) {
    if (teamIdx === 0) return { tint: 0xC8302C, emissive: 0x6e1612 };
    if (teamIdx === 1) return { tint: 0x2C5AC8, emissive: 0x12326e };
    return { tint: 0x808080, emissive: 0x303030 };
}

// Per-datablock mesh builder. Returns a Group anchored at y=0 (foot of object).
// halfExtents are kept for backward-compatibility but datablock-driven sizes
// are used so silhouettes match the original game proportions.
function createCanonicalMesh(datablock, teamIdx) {
    const acc = _teamAccent(teamIdx);
    const baseMat = new THREE.MeshStandardMaterial({ color: 0x6a6862, roughness: 0.78, metalness: 0.18, envMapIntensity: 0.35 });
    const armMat  = new THREE.MeshStandardMaterial({ color: 0x484540, roughness: 0.55, metalness: 0.55, envMapIntensity: 0.50 });
    const accentMat = new THREE.MeshStandardMaterial({
        color: acc.tint, emissive: acc.emissive, emissiveIntensity: 0.55,
        roughness: 0.50, metalness: 0.30,
    });
    const glowMat = new THREE.MeshBasicMaterial({ color: acc.tint });
    const g = new THREE.Group();

    if (datablock === 'Generator') {
        // Armored hex housing (3m wide, 4m tall) with team-tint emissive panels
        const hx = 1.5, hy = 2.0, hz = 1.5;
        const body = new THREE.Mesh(new THREE.BoxGeometry(hx * 2, hy * 2, hz * 2), baseMat);
        body.position.y = hy; body.castShadow = body.receiveShadow = true; g.add(body);
        // R32.6: per-instance emissive material so panel pulse intensity is
        // independent per team. Color comes from team accent (already factored
        // into accentMat by caller); here we clone to a Standard material with
        // emissive identical to the base color so emissiveIntensity actually
        // controls glow.
        const teamColor = (accentMat.color && accentMat.color.getHex) ? accentMat.color.getHex() : 0xCC4444;
        const panelMat = new THREE.MeshStandardMaterial({
            color: teamColor, emissive: teamColor, emissiveIntensity: 0.55,
            roughness: 0.5, metalness: 0.1,
        });
        const panels = [];
        for (let i = 0; i < 4; i++) {
            const a = i * Math.PI / 2;
            const panel = new THREE.Mesh(new THREE.PlaneGeometry(hx * 1.4, hy * 1.4), panelMat);
            panel.position.set(Math.sin(a) * (hx + 0.02), hy * 1.1, Math.cos(a) * (hz + 0.02));
            panel.lookAt(panel.position.x * 100, panel.position.y, panel.position.z * 100);
            g.add(panel);
            panels.push(panel);
        }
        // Top vent + chimney
        const vent = new THREE.Mesh(new THREE.BoxGeometry(hx * 1.6, 0.2, hz * 1.6), armMat);
        vent.position.y = hy * 2 + 0.1; g.add(vent);
        const stack = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.3, 0.9, 20), armMat);
        stack.position.y = hy * 2 + 0.65; g.add(stack);
        g.userData = { panels: panels };
        return g;
    }

    if (datablock === 'AmmoStation' || datablock === 'InventoryStation' || datablock === 'CommandStation') {
        // Hex kiosk — differentiate by accent color of top ring.
        const r = 1.0, h = 1.5;
        const body = new THREE.Mesh(new THREE.CylinderGeometry(r * 1.1, r * 1.2, h * 2, 24), baseMat);
        body.position.y = h; body.castShadow = body.receiveShadow = true; g.add(body);
        // Top ring (datablock-tinted to differentiate at a glance)
        let ringHex = 0xFFC850; // default
        if (datablock === 'AmmoStation')      ringHex = 0xFF8030; // amber/orange
        if (datablock === 'InventoryStation') ringHex = 0x40C0FF; // cyan
        if (datablock === 'CommandStation')   ringHex = 0xFFE060; // gold
        const ringMat = new THREE.MeshBasicMaterial({ color: ringHex });
        const ring = new THREE.Mesh(new THREE.TorusGeometry(r * 1.18, 0.08, 12, 32), ringMat);
        ring.rotation.x = Math.PI / 2; ring.position.y = h * 1.95; g.add(ring);
        // Display panels (3 sides on hex)
        const panelMat = new THREE.MeshBasicMaterial({ color: ringHex, transparent: true, opacity: 0.75, side: THREE.DoubleSide });
        for (let i = 0; i < 3; i++) {
            const a = i * (2 * Math.PI / 3);
            const panel = new THREE.Mesh(new THREE.PlaneGeometry(r * 1.0, h * 0.9), panelMat);
            panel.position.set(Math.sin(a) * (r * 1.13), h * 1.0, Math.cos(a) * (r * 1.13));
            panel.lookAt(panel.position.x * 100, panel.position.y, panel.position.z * 100);
            g.add(panel);
        }
        // Team-color foot stripe so allegiance is readable from any angle
        const stripe = new THREE.Mesh(new THREE.TorusGeometry(r * 1.22, 0.04, 12, 32), glowMat);
        stripe.rotation.x = Math.PI / 2; stripe.position.y = 0.1; g.add(stripe);
        return g;
    }

    if (datablock === 'VehicleStation') {
        // Larger station w/ extended launch arm — the only datablock built into the C++ buildings
        // array as a station but visually closer to a vehicle bay.
        const w = 3.0, d = 4.0, h = 2.6;
        const body = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), baseMat);
        body.position.y = h * 0.5; body.castShadow = body.receiveShadow = true; g.add(body);
        // Roof slab
        const roof = new THREE.Mesh(new THREE.BoxGeometry(w * 1.05, 0.2, d * 1.05), armMat);
        roof.position.y = h + 0.1; g.add(roof);
        // Side launch rail (sticking out front)
        const rail = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.4, d * 1.4), armMat);
        rail.position.set(0, h + 0.4, 0); g.add(rail);
        // Team accent door
        const door = new THREE.Mesh(new THREE.PlaneGeometry(w * 0.7, h * 0.7), accentMat);
        door.position.set(0, h * 0.45, d * 0.501); g.add(door);
        return g;
    }

    if (datablock === 'plasmaTurret') {
        // Plasma turret — pedestal + domed head + glowing coil ring
        const pedH = 1.0;
        const ped = new THREE.Mesh(new THREE.CylinderGeometry(0.85, 1.05, pedH, 24), baseMat);
        ped.position.y = pedH * 0.5; ped.castShadow = ped.receiveShadow = true; g.add(ped);
        const dome = new THREE.Mesh(new THREE.SphereGeometry(0.95, 24, 16, 0, Math.PI * 2, 0, Math.PI * 0.55), armMat);
        dome.position.y = pedH + 0.05; g.add(dome);
        // Plasma coil ring (emissive, slow rotation in syncBuildings if needed)
        const coil = new THREE.Mesh(new THREE.TorusGeometry(0.65, 0.07, 12, 28), accentMat);
        coil.rotation.x = Math.PI / 2; coil.position.y = pedH + 0.45; g.add(coil);
        // Forward cannon
        const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.20, 1.5, 20), armMat);
        barrel.rotation.z = Math.PI / 2; barrel.position.set(0.85, pedH + 0.45, 0); g.add(barrel);
        // Sensor eye
        const eye = new THREE.Mesh(new THREE.SphereGeometry(0.10, 12, 8), glowMat);
        eye.position.set(0.55, pedH + 0.95, 0); g.add(eye);
        g.userData = { barrel: barrel };
        return g;
    }

    if (datablock === 'rocketTurret') {
        // Rocket turret — boxy pedestal + missile cluster on twin rails
        const pedH = 1.2;
        const ped = new THREE.Mesh(new THREE.BoxGeometry(1.3, pedH, 1.3), baseMat);
        ped.position.y = pedH * 0.5; ped.castShadow = ped.receiveShadow = true; g.add(ped);
        // Top hub
        const hub = new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.4, 1.4), armMat);
        hub.position.y = pedH + 0.2; g.add(hub);
        // Two missile rails
        for (let s = -1; s <= 1; s += 2) {
            const rail = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.3, 1.4), armMat);
            rail.position.set(0.45 * s, pedH + 0.55, 0); g.add(rail);
            // Two missiles per rail
            for (let m = 0; m < 2; m++) {
                const tube = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, 0.55, 16), accentMat);
                tube.rotation.x = Math.PI / 2;
                tube.position.set(0.45 * s, pedH + 0.55 + (m === 0 ? 0.18 : -0.18), 0.0);
                g.add(tube);
            }
        }
        // Forward sensor
        const eye = new THREE.Mesh(new THREE.SphereGeometry(0.10, 12, 8), glowMat);
        eye.position.set(0, pedH + 0.45, 0.71); g.add(eye);
        return g;
    }

    if (datablock === 'PulseSensor') {
        // Slim pole with rotating dish at top — distinct from turrets
        const poleH = 2.4;
        const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.10, 0.13, poleH, 16), baseMat);
        pole.position.y = poleH * 0.5; pole.castShadow = pole.receiveShadow = true; g.add(pole);
        // Cap
        const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.18, 0.15, 20), armMat);
        cap.position.y = poleH + 0.07; g.add(cap);
        // Dish (shallow paraboloid as half-sphere flattened)
        const dish = new THREE.Mesh(new THREE.SphereGeometry(0.55, 24, 14, 0, Math.PI * 2, 0, Math.PI * 0.35), accentMat);
        dish.position.y = poleH + 0.20; g.add(dish);
        // Pulsing emissive dot at dish center
        const dot = new THREE.Mesh(new THREE.SphereGeometry(0.08, 12, 8), glowMat);
        dot.position.y = poleH + 0.30; g.add(dot);
        g.userData = { dish: dish, isSensor: true };
        return g;
    }

    // Fallback: generic interior box (legacy path)
    return null;
}

async function initBuildings() {
    const ptr = Module._getBuildingPtr();
    const count = Module._getBuildingCount();
    const stride = Module._getBuildingStride();
    const view = new Float32Array(Module.HEAPF32.buffer, ptr, count * stride);
    // R32.3: load canonical classifier. If it fails (e.g. offline), we fall
    // back to the legacy createBuildingMesh path so the map still renders.
    const classifier = await _loadCanonicalClassifier();

    // R32.51: Load interior shape positions so we can skip procedural boxes
    // that overlap with real .dig geometry (prevents z-fighting flicker).
    const _interiorPositions = [];
    try {
        const cRes = await fetch('assets/maps/raindance/canonical.json');
        if (cRes.ok) {
            const cData = await cRes.json();
            const toW = (mp) => ({ x: mp[0], y: mp[2], z: -mp[1] });
            for (const s of (cData.neutral_interior_shapes || [])) {
                const w = toW(s.position);
                _interiorPositions.push(w);
            }
        }
    } catch (_) {}
    function _overlapsInteriorShape(px, py, pz) {
        const r2 = 6.0 * 6.0; // 6m match radius — generous for float drift
        for (const ip of _interiorPositions) {
            const dx = ip.x - px, dy = ip.y - py, dz = ip.z - pz;
            if (dx * dx + dy * dy + dz * dz < r2) return true;
        }
        return false;
    }

    let canonicalCount = 0, fallbackCount = 0, skippedInterior = 0;

    for (let b = 0; b < count; b++) {
        const o = b * stride;
        const px = view[o], py = view[o + 1], pz = view[o + 2];
        const hx = view[o + 3], hy = view[o + 4], hz = view[o + 5];
        const type = view[o + 6];
        const isRock = (type === 5);
        if (isRock) continue;

        // R32.51: Skip WASM buildings that overlap with real interior shapes.
        // The .dig meshes from initInteriorShapes() are the real geometry;
        // procedural boxes here would z-fight with them.
        if (_overlapsInteriorShape(px, py, pz)) { skippedInterior++; continue; }

        const cr = view[o + 10], cg = view[o + 11], cb = view[o + 12];

        // Try canonical classification first. Match radius 4m is generous
        // because the C++ position swap is exact — we use 4m to absorb any
        // float-precision drift between MIS source and baked g_rBuildings.
        let mesh = null;
        let canon = _classifyBuilding(classifier, px, py, pz, 4.0);
        if (canon) {
            mesh = createCanonicalMesh(canon.datablock, canon.team);
            if (mesh) canonicalCount++;
        }
        if (!mesh) {
            mesh = createBuildingMesh(type, [hx, hy, hz], [cr, cg, cb]);
            fallbackCount++;
        }

        // R31.1: clamp building Y to terrain so bodies don't sink underground.
        const terrainAtBuilding = sampleTerrainH(px, pz);
        const groundedY = Math.max(py, terrainAtBuilding + hy * 0.5);
        mesh.position.set(px, groundedY, pz);
        mesh.userData = mesh.userData || {};
        mesh.userData.canon = canon || null;
        // R31: disable frustum culling on all building sub-meshes
        mesh.traverse(child => { child.frustumCulled = false; });
        scene.add(mesh);
        buildingMeshes.push({ mesh, type });
    }
    console.log('[R32.3] Buildings classified:', canonicalCount, 'canonical /',
        fallbackCount, 'legacy fallback /', skippedInterior, 'skipped (interior shape overlap) — total', buildingMeshes.length);
}

// ============================================================
// R32.46: Geometry Enhancement Helpers
// Crease-aware smooth normals + midpoint subdivision for rocks
// ============================================================

/**
 * Compute crease-aware smooth normals for an indexed BufferGeometry.
 * Faces sharing a vertex average their normals ONLY when the dihedral angle
 * between them is less than creaseAngleDeg. Returns a NEW non-indexed
 * BufferGeometry with per-vertex normals that preserve hard edges on
 * architectural seams while smoothing curved surfaces.
 */
function computeCreaseNormals(geometry, creaseAngleDeg = 40, materialColors = null) {
    const posAttr = geometry.getAttribute('position');
    const index = geometry.getIndex();
    if (!index) return geometry; // already non-indexed, bail
    const positions = posAttr.array;
    const indices = index.array;
    const cosCrease = Math.cos(creaseAngleDeg * Math.PI / 180);

    const numTris = indices.length / 3;
    // Step 1: compute face normals
    const faceNormals = new Float32Array(numTris * 3);
    const _v0 = new THREE.Vector3(), _v1 = new THREE.Vector3(), _v2 = new THREE.Vector3();
    const _e1 = new THREE.Vector3(), _e2 = new THREE.Vector3(), _fn = new THREE.Vector3();

    for (let t = 0; t < numTris; t++) {
        const i0 = indices[t * 3], i1 = indices[t * 3 + 1], i2 = indices[t * 3 + 2];
        _v0.fromBufferAttribute(posAttr, i0);
        _v1.fromBufferAttribute(posAttr, i1);
        _v2.fromBufferAttribute(posAttr, i2);
        _e1.subVectors(_v1, _v0);
        _e2.subVectors(_v2, _v0);
        _fn.crossVectors(_e1, _e2).normalize();
        faceNormals[t * 3]     = _fn.x;
        faceNormals[t * 3 + 1] = _fn.y;
        faceNormals[t * 3 + 2] = _fn.z;
    }

    // Step 2: Build vertex→face adjacency map keyed by quantized position
    // (handles vertices at same position with different indices)
    const posToFaces = new Map();
    const _posKey = (idx) => {
        const x = positions[idx * 3], y = positions[idx * 3 + 1], z = positions[idx * 3 + 2];
        // Quantize to 4 decimal places to merge coincident vertices
        return ((x * 10000) | 0) + ',' + ((y * 10000) | 0) + ',' + ((z * 10000) | 0);
    };

    for (let t = 0; t < numTris; t++) {
        for (let j = 0; j < 3; j++) {
            const key = _posKey(indices[t * 3 + j]);
            let list = posToFaces.get(key);
            if (!list) { list = []; posToFaces.set(key, list); }
            list.push(t);
        }
    }

    // Step 3: Build non-indexed geometry with crease-aware normals
    const newPositions = new Float32Array(numTris * 9);
    const newNormals = new Float32Array(numTris * 9);
    const _acc = new THREE.Vector3();
    const _fN = new THREE.Vector3();
    const _oN = new THREE.Vector3();

    for (let t = 0; t < numTris; t++) {
        _fN.set(faceNormals[t * 3], faceNormals[t * 3 + 1], faceNormals[t * 3 + 2]);

        for (let j = 0; j < 3; j++) {
            const vi = indices[t * 3 + j];
            const outBase = t * 9 + j * 3;
            // Copy position
            newPositions[outBase]     = positions[vi * 3];
            newPositions[outBase + 1] = positions[vi * 3 + 1];
            newPositions[outBase + 2] = positions[vi * 3 + 2];

            // Average normals of adjacent faces within crease threshold
            const key = _posKey(vi);
            const adjFaces = posToFaces.get(key);
            _acc.set(0, 0, 0);
            for (let a = 0; a < adjFaces.length; a++) {
                const af = adjFaces[a];
                _oN.set(faceNormals[af * 3], faceNormals[af * 3 + 1], faceNormals[af * 3 + 2]);
                if (_fN.dot(_oN) >= cosCrease) {
                    _acc.add(_oN);
                }
            }
            if (_acc.lengthSq() > 0.0001) {
                _acc.normalize();
            } else {
                _acc.copy(_fN);
            }
            newNormals[outBase]     = _acc.x;
            newNormals[outBase + 1] = _acc.y;
            newNormals[outBase + 2] = _acc.z;
        }
    }

    // R32.48: Material-palette-based vertex colors replace R32.47 normal-based zone hack.
    // materialColors is a Float32Array[numTris * 3] (r,g,b per triangle) if provided.
    // Falls back to face-normal-based zone tinting when null (backward compat for non-v2).
    const newColors = new Float32Array(numTris * 9);
    if (materialColors && materialColors.length === numTris * 3) {
        for (let t = 0; t < numTris; t++) {
            const r = materialColors[t * 3], g = materialColors[t * 3 + 1], b = materialColors[t * 3 + 2];
            for (let j = 0; j < 3; j++) {
                newColors[t * 9 + j * 3]     = r;
                newColors[t * 9 + j * 3 + 1] = g;
                newColors[t * 9 + j * 3 + 2] = b;
            }
        }
    } else {
        // Legacy R32.47 normal-based zone tinting (fallback for v1 blobs)
        for (let t = 0; t < numTris; t++) {
            const fnx = faceNormals[t * 3], fny = faceNormals[t * 3 + 1], fnz = faceNormals[t * 3 + 2];
            let r, g, b;
            const absZ = Math.abs(fnz), absX = Math.abs(fnx), absY = Math.abs(fny);
            if (fnz > 0.65) {
                r = 1.12; g = 1.10; b = 1.06;
            } else if (fnz < -0.65) {
                r = 0.78; g = 0.78; b = 0.82;
            } else if (absZ < 0.3 && (absX > 0.5 || absY > 0.5)) {
                if (absX > absY) { r = 0.95; g = 0.93; b = 0.90; }
                else { r = 0.88; g = 0.87; b = 0.85; }
            } else {
                r = 0.82; g = 0.80; b = 0.76;
            }
            for (let j = 0; j < 3; j++) {
                newColors[t * 9 + j * 3]     = r;
                newColors[t * 9 + j * 3 + 1] = g;
                newColors[t * 9 + j * 3 + 2] = b;
            }
        }
    }

    const newGeom = new THREE.BufferGeometry();
    newGeom.setAttribute('position', new THREE.BufferAttribute(newPositions, 3));
    newGeom.setAttribute('normal', new THREE.BufferAttribute(newNormals, 3));
    newGeom.setAttribute('color', new THREE.BufferAttribute(newColors, 3));
    newGeom.computeBoundingBox();
    newGeom.computeBoundingSphere();
    return newGeom;
}

/**
 * Midpoint subdivision: each triangle becomes 4 by inserting edge midpoints.
 * No vertex smoothing — just adds resolution for crease normals to work with.
 * Input: raw position array (flat float[]) and index array (flat uint[]).
 * Optional triData: any per-triangle array; each parent tri's value is copied to its 4 children.
 * Returns { positions: Float32Array, indices: Uint32Array, triData?: Array }.
 */
function midpointSubdivide(positions, indices, triData = null) {
    const edgeMap = new Map();
    // Copy original positions into a growable array
    const newPos = [];
    for (let i = 0; i < positions.length; i++) newPos.push(positions[i]);
    const newIdx = [];
    const newTriData = triData ? [] : null;

    const edgeKey = (a, b) => a < b ? (a * 100000 + b) : (b * 100000 + a);

    const getMidpoint = (a, b) => {
        const key = edgeKey(a, b);
        let mid = edgeMap.get(key);
        if (mid !== undefined) return mid;
        mid = newPos.length / 3;
        newPos.push(
            (positions[a * 3]     + positions[b * 3])     * 0.5,
            (positions[a * 3 + 1] + positions[b * 3 + 1]) * 0.5,
            (positions[a * 3 + 2] + positions[b * 3 + 2]) * 0.5,
        );
        edgeMap.set(key, mid);
        return mid;
    };

    for (let t = 0; t < indices.length; t += 3) {
        const i0 = indices[t], i1 = indices[t + 1], i2 = indices[t + 2];
        const m01 = getMidpoint(i0, i1);
        const m12 = getMidpoint(i1, i2);
        const m20 = getMidpoint(i2, i0);
        // 4 sub-triangles, preserving winding
        newIdx.push(i0, m01, m20);
        newIdx.push(m01, i1, m12);
        newIdx.push(m20, m12, i2);
        newIdx.push(m01, m12, m20);
        // Propagate per-tri data: all 4 children get parent's value
        if (newTriData) {
            const val = triData[t / 3];
            newTriData.push(val, val, val, val);
        }
    }

    const result = {
        positions: new Float32Array(newPos),
        indices: new Uint32Array(newIdx),
    };
    if (newTriData) result.triData = newTriData;
    return result;
}

// ============================================================
// R32.1: Interior Shapes — real Tribes 1 .dis-extracted meshes
// Loads raindance_meshes.bin (binary blob of 32 unique shapes) and
// raindance_meshes.json (sidecar with bounds), then places instances
// at canonical positions from canonical.json.
// Coordinate convention (matches existing flag/turret placement):
//   MIS (x, y, z-up) -> world (x = mis_x, y = mis_z, z = -mis_y)
//   MIS rotation z-axis (yaw radians) -> Three.js rotation.y = -mis_rot_z
// ============================================================
let interiorShapesGroup = null;

async function initInteriorShapes() {
    try {
        const [blobRes, infoRes, canonRes, paletteRes] = await Promise.all([
            fetch('assets/maps/raindance/raindance_meshes.bin'),
            fetch('assets/maps/raindance/raindance_meshes.json'),
            fetch('assets/maps/raindance/canonical.json'),
            fetch('assets/maps/raindance/material_palette.json'),
        ]);
        if (!blobRes.ok || !infoRes.ok || !canonRes.ok) {
            console.warn('[R32.48] Interior shape assets missing; skipping');
            return;
        }
        const blob = await blobRes.arrayBuffer();
        const info = await infoRes.json();
        const canon = await canonRes.json();
        const palette = paletteRes.ok ? await paletteRes.json() : {};
        const defaultEntry = palette['_default'] || { color: [0.50, 0.48, 0.45], roughness: 0.75, metalness: 0.10, emissive: null };

        // R32.48: Palette lookup — match texture name (case-insensitive, strip .bmp)
        // then prefix match for numbered variants (e.g. ext_grey9 → ext_grey)
        function lookupPalette(texName) {
            const key = texName.toLowerCase().replace(/\.bmp$/i, '');
            if (palette[key]) return palette[key];
            // Prefix match: strip trailing digits
            const prefix = key.replace(/\d+$/, '');
            if (prefix !== key && palette[prefix]) return palette[prefix];
            return defaultEntry;
        }

        // Parse the binary blob. Format:
        //   u32 'RDMS', u32 version, u32 num_meshes
        //   per mesh: u8 nameLen, char[nameLen] name,
        //             u32 nVerts, f32[3*nVerts] positions,
        //             u32 nUVs, f32[2*nUVs] uvs,           (v2+)
        //             u32 nIndices, u32[nIndices] indices,
        //             u32 nTris, u8[nTris] material_indices (v2+)
        const dv = new DataView(blob);
        let off = 0;
        const magic = String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3));
        off = 4;
        if (magic !== 'RDMS') { console.warn('[R32.48] bad magic', magic); return; }
        const version = dv.getUint32(off, true); off += 4;
        const num = dv.getUint32(off, true); off += 4;
        console.log('[R32.48] Mesh blob version', version, '—', num, 'meshes');

        const meshes = new Map();
        for (let i = 0; i < num; i++) {
            const nameLen = dv.getUint8(off); off += 1;
            const nameBytes = new Uint8Array(blob, off, nameLen);
            const name = new TextDecoder('utf-8').decode(nameBytes);
            off += nameLen;
            const nVerts = dv.getUint32(off, true); off += 4;
            const positions = new Float32Array(blob.slice(off, off + nVerts * 12));
            off += nVerts * 12;

            let uvs = null, materialIndices = null;
            if (version >= 2) {
                const nUVs = dv.getUint32(off, true); off += 4;
                uvs = new Float32Array(blob.slice(off, off + nUVs * 8));
                off += nUVs * 8;
            }

            const nIdx = dv.getUint32(off, true); off += 4;
            const indices = new Uint32Array(blob.slice(off, off + nIdx * 4));
            off += nIdx * 4;

            if (version >= 2) {
                const nTris = dv.getUint32(off, true); off += 4;
                materialIndices = new Uint8Array(blob.slice(off, off + nTris));
                off += nTris;
            }

            meshes.set(name, { positions, indices, nVerts, uvs, materialIndices });
        }
        console.log('[R32.48] Loaded', meshes.size, 'unique interior-shape meshes');

        // Build a material name list lookup from sidecar JSON
        const meshMaterialNames = new Map();
        for (const m of (info.meshes || [])) {
            meshMaterialNames.set(m.fileName, m.materials || []);
        }

        // R32.48: Per-mesh material using geometry groups from the material palette.
        // Each unique material index gets its own PBR material (color, roughness, metalness, emissive).
        // R32.48.1: polygonOffset prevents z-fighting on thin/coplanar surfaces with DoubleSide.
        const _matProps = {
            side: THREE.FrontSide, flatShading: true, vertexColors: false,  // R32.64.2: REVERTED — flatShading OFF caused black flashing
            polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1,
        };

        // R32.66: Procedural texture generator — runtime canvas textures by material category
        const _texCache = new Map();
        const _SZ = 128;
        function _noise(ctx,w,h,r,g,b,a,spread){
            const id=ctx.getImageData(0,0,w,h),d=id.data;
            for(let i=0;i<d.length;i+=4){
                const n=(Math.random()-0.5)*spread;
                d[i]=Math.max(0,Math.min(255,r+n));
                d[i+1]=Math.max(0,Math.min(255,g+n));
                d[i+2]=Math.max(0,Math.min(255,b+n));
                d[i+3]=a;
            }
            ctx.putImageData(id,0,0);
        }
        function _genProceduralTex(texName, baseColor) {
            const key = texName.toLowerCase().replace(/\.bmp$/i,'');
            if (_texCache.has(key)) return _texCache.get(key);
            const c = document.createElement('canvas');
            c.width = c.height = _SZ;
            const ctx = c.getContext('2d');
            const [cr,cg,cb] = [baseColor[0]*255|0, baseColor[1]*255|0, baseColor[2]*255|0];
            // Classify by name prefix
            if (key.startsWith('ext_iron') || key === 'itube' || key === 'ivent') {
                // Dark iron — brushed metal + scratches
                _noise(ctx,_SZ,_SZ,cr,cg,cb,255,30);
                ctx.strokeStyle='rgba(255,255,255,0.06)';
                for(let i=0;i<60;i++){ctx.beginPath();const y=Math.random()*_SZ;ctx.moveTo(0,y);ctx.lineTo(_SZ,y+(Math.random()-0.5)*4);ctx.stroke();}
                ctx.strokeStyle='rgba(0,0,0,0.15)';
                for(let i=0;i<8;i++){ctx.beginPath();const y=Math.random()*_SZ;ctx.moveTo(Math.random()*_SZ,y);ctx.lineTo(Math.random()*_SZ,y+(Math.random()-0.5)*6);ctx.lineWidth=1+Math.random();ctx.stroke();}
            } else if (key.startsWith('metal_') || key === 'base_metal' || key === 'special_metal' || key === 'idkmetalstrip' || key === 'iltmetal' || key === 'greyrib') {
                // Light metal — fine brushed
                _noise(ctx,_SZ,_SZ,cr,cg,cb,255,20);
                ctx.strokeStyle='rgba(255,255,255,0.04)';
                for(let i=0;i<80;i++){ctx.beginPath();const y=Math.random()*_SZ;ctx.moveTo(0,y);ctx.lineTo(_SZ,y+(Math.random()-0.5)*2);ctx.stroke();}
                ctx.strokeStyle='rgba(200,200,210,0.08)';
                for(let i=0;i<3;i++){const y=Math.random()*_SZ;ctx.beginPath();ctx.moveTo(0,y);ctx.lineTo(_SZ,y);ctx.lineWidth=0.5;ctx.stroke();}
            } else if (key.startsWith('ext_grey')) {
                // Concrete/composite — noise + panel seams
                _noise(ctx,_SZ,_SZ,cr,cg,cb,255,18);
                ctx.strokeStyle='rgba(0,0,0,0.12)';ctx.lineWidth=1;
                ctx.strokeRect(2,2,_SZ-4,_SZ-4);
                ctx.strokeStyle='rgba(0,0,0,0.06)';
                ctx.beginPath();ctx.moveTo(0,_SZ/2);ctx.lineTo(_SZ,_SZ/2);ctx.stroke();
                // subtle staining
                ctx.fillStyle='rgba(80,70,55,0.06)';
                for(let i=0;i<5;i++){ctx.beginPath();ctx.arc(Math.random()*_SZ,Math.random()*_SZ,8+Math.random()*15,0,Math.PI*2);ctx.fill();}
            } else if (key.startsWith('base_warm') || key.startsWith('warm_') || key === 'special_warm') {
                // Warm panels — noise + horizontal lines
                _noise(ctx,_SZ,_SZ,cr,cg,cb,255,15);
                ctx.strokeStyle='rgba(0,0,0,0.08)';ctx.lineWidth=0.5;
                for(let y=0;y<_SZ;y+=16){ctx.beginPath();ctx.moveTo(0,y);ctx.lineTo(_SZ,y);ctx.stroke();}
                ctx.strokeStyle='rgba(255,255,255,0.04)';
                for(let y=8;y<_SZ;y+=16){ctx.beginPath();ctx.moveTo(0,y);ctx.lineTo(_SZ,y);ctx.stroke();}
            } else if (key.startsWith('cold_') || key === 'base_cold') {
                // Cold panels — noise + grid
                _noise(ctx,_SZ,_SZ,cr,cg,cb,255,15);
                ctx.strokeStyle='rgba(0,0,0,0.07)';ctx.lineWidth=0.5;
                for(let y=0;y<_SZ;y+=32){ctx.beginPath();ctx.moveTo(0,y);ctx.lineTo(_SZ,y);ctx.stroke();}
                for(let x=0;x<_SZ;x+=32){ctx.beginPath();ctx.moveTo(x,0);ctx.lineTo(x,_SZ);ctx.stroke();}
            } else if (key === 'base_rock' || key.startsWith('ext_stone') || key.startsWith('lrrrr') || key === 'lcccc') {
                // Rock — mottled organic
                _noise(ctx,_SZ,_SZ,cr,cg,cb,255,35);
                ctx.fillStyle='rgba(70,90,50,0.08)';
                for(let i=0;i<12;i++){ctx.beginPath();ctx.arc(Math.random()*_SZ,Math.random()*_SZ,6+Math.random()*18,0,Math.PI*2);ctx.fill();}
                ctx.fillStyle='rgba(40,35,25,0.07)';
                for(let i=0;i<8;i++){ctx.beginPath();ctx.arc(Math.random()*_SZ,Math.random()*_SZ,4+Math.random()*12,0,Math.PI*2);ctx.fill();}
            } else if (key.startsWith('light_') || key === 'special_interface' || key === 'special_shield' || key === 'hdisplay_yellow' || key === 'redylight') {
                // Emissive — scan lines + glow
                ctx.fillStyle=`rgb(${cr},${cg},${cb})`;ctx.fillRect(0,0,_SZ,_SZ);
                ctx.fillStyle='rgba(255,255,255,0.1)';
                for(let y=0;y<_SZ;y+=4){ctx.fillRect(0,y,_SZ,1);}
                ctx.fillStyle='rgba(255,255,255,0.15)';ctx.fillRect(0,_SZ/2-2,_SZ,4);
            } else if (key.startsWith('base.emblem')) {
                // Team emblem — base color + diamond pattern
                ctx.fillStyle=`rgb(${cr},${cg},${cb})`;ctx.fillRect(0,0,_SZ,_SZ);
                ctx.strokeStyle='rgba(255,255,255,0.12)';ctx.lineWidth=1;
                const s=16;for(let y=-_SZ;y<_SZ*2;y+=s){ctx.beginPath();ctx.moveTo(0,y);ctx.lineTo(_SZ,y+_SZ);ctx.stroke();ctx.beginPath();ctx.moveTo(0,y);ctx.lineTo(_SZ,y-_SZ);ctx.stroke();}
            } else if (key === 'carpet_base') {
                // Carpet — woven texture
                _noise(ctx,_SZ,_SZ,cr,cg,cb,255,12);
                ctx.strokeStyle='rgba(0,0,0,0.06)';ctx.lineWidth=0.5;
                for(let y=0;y<_SZ;y+=3){ctx.beginPath();ctx.moveTo(0,y);ctx.lineTo(_SZ,y);ctx.stroke();}
                for(let x=0;x<_SZ;x+=3){ctx.beginPath();ctx.moveTo(x,0);ctx.lineTo(x,_SZ);ctx.stroke();}
            } else {
                // Default — subtle noise
                _noise(ctx,_SZ,_SZ,cr,cg,cb,255,20);
            }
            const tex = new THREE.CanvasTexture(c);
            tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
            tex.repeat.set(2,2);
            tex.magFilter = THREE.LinearFilter;
            tex.minFilter = THREE.LinearMipmapLinearFilter;
            _texCache.set(key, tex);
            return tex;
        }

        // Cache of material arrays per mesh filename (since multiple instances share geometry)
        const matArrayCache = new Map();

        // R32.70: PBR texture system — CC0 textures from Poly Haven
        // Classify a material name into its PBR texture category
        function _classifyMaterial(texName) {
            const key = texName.toLowerCase().replace(/\.bmp$/i, '');
            if (key.startsWith('ext_iron') || key === 'itube' || key === 'ivent') return 'heavy_metal';
            if (key.startsWith('metal_') || key === 'base_metal' || key === 'special_metal' || key === 'idkmetalstrip' || key === 'iltmetal' || key === 'greyrib') return 'light_metal';
            if (key.startsWith('ext_grey')) return 'grey_exterior';
            if (key.startsWith('base_warm') || key.startsWith('warm_') || key === 'special_warm') return 'warm_panel';
            if (key.startsWith('cold_') || key === 'base_cold') return 'cold_panel';
            if (key === 'base_rock' || key.startsWith('ext_stone') || key.startsWith('lrrrr') || key === 'lcccc') return 'rock';
            if (key.startsWith('light_') || key === 'special_interface' || key === 'special_shield' || key === 'hdisplay_yellow' || key === 'redylight') return 'emissive';
            if (key.startsWith('base.emblem')) return 'team_emblem';
            if (key === 'carpet_base') return 'interior_detail';
            return 'accent';
        }

        // Pre-load PBR texture maps per category
        const _pbrTextures = new Map(); // category -> { albedo, normal, roughness }
        const _pbrCategories = ['heavy_metal', 'light_metal', 'grey_exterior', 'warm_panel', 'cold_panel', 'rock', 'interior_detail', 'accent'];
        const _pbrLoader = new THREE.TextureLoader();
        const _pbrBasePath = 'assets/textures/buildings/';
        let _pbrReady = false;

        // Load all PBR textures (non-blocking, materials fall back to procedural until loaded)
        const _pbrLoadPromises = [];
        for (const cat of _pbrCategories) {
            const catMaps = {};
            for (const mapType of ['albedo', 'normal', 'roughness']) {
                const url = _pbrBasePath + cat + '_' + mapType + '.png';
                const p = new Promise(resolve => {
                    _pbrLoader.load(url, tex => {
                        tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
                        tex.repeat.set(2, 2);
                        tex.magFilter = THREE.LinearFilter;
                        tex.minFilter = THREE.LinearMipmapLinearFilter;
                        tex.generateMipmaps = true;
                        tex.colorSpace = mapType === 'albedo' ? THREE.SRGBColorSpace : THREE.LinearSRGBColorSpace;
                        catMaps[mapType] = tex;
                        resolve();
                    }, undefined, () => {
                        console.warn('[R32.70] Failed to load PBR texture:', url);
                        resolve(); // resolve anyway — graceful fallback
                    });
                });
                _pbrLoadPromises.push(p);
            }
            _pbrTextures.set(cat, catMaps);
        }
        Promise.all(_pbrLoadPromises).then(() => {
            _pbrReady = true;
            let loaded = 0;
            for (const [cat, maps] of _pbrTextures) {
                const count = Object.keys(maps).length;
                loaded += count;
            }
            console.log('[R32.70] PBR textures ready:', loaded, 'maps across', _pbrTextures.size, 'categories');
        });

        // R32.71: Team color definitions for building accents
        // Team 0 = Blood Eagle (red), Team 1 = Diamond Sword (blue)
        const _TEAM_EMBLEM_COLORS = {
            0: { color: [0.78, 0.19, 0.17], emissive: [0.43, 0.09, 0.07] },  // Blood Eagle red
            1: { color: [0.17, 0.35, 0.78], emissive: [0.07, 0.15, 0.43] },  // Diamond Sword blue
        };

        function buildMaterialArray(fileName, teamIdx) {
            const cacheKey = teamIdx >= 0 ? fileName + ':t' + teamIdx : fileName;
            if (matArrayCache.has(cacheKey)) return matArrayCache.get(cacheKey);
            const matNames = meshMaterialNames.get(fileName) || [];
            const mats = matNames.map(texName => {
                const entry = lookupPalette(texName);
                let [cr, cg, cb] = entry.color;
                const category = _classifyMaterial(texName);

                // R32.71: Override emblem colors based on building team ownership
                const isTeamEmblem = category === 'team_emblem';
                if (isTeamEmblem && teamIdx >= 0 && _TEAM_EMBLEM_COLORS[teamIdx]) {
                    [cr, cg, cb] = _TEAM_EMBLEM_COLORS[teamIdx].color;
                }

                const pbrMaps = _pbrTextures.get(category);
                const usePBR = pbrMaps && pbrMaps.albedo && category !== 'emissive' && category !== 'team_emblem';

                // R32.70: Use PBR albedo when available, procedural as fallback
                const albedoTex = usePBR ? pbrMaps.albedo : _genProceduralTex(
                    isTeamEmblem && teamIdx >= 0 ? texName + '_t' + teamIdx : texName,
                    [cr, cg, cb]
                );

                const mat = new THREE.MeshStandardMaterial({
                    ..._matProps,
                    // R32.70: Tint PBR albedo by palette color for variation; procedural textures already bake the color
                    color: usePBR ? new THREE.Color(cr, cg, cb) : new THREE.Color(1, 1, 1),
                    map: albedoTex,
                    roughness: entry.roughness,
                    metalness: isTeamEmblem ? 0.4 : entry.metalness,  // R32.71: slightly more metallic emblems
                    envMapIntensity: 0.35,
                });

                // R32.70: Apply normal + roughness maps from PBR set
                if (usePBR) {
                    if (pbrMaps.normal) {
                        mat.normalMap = pbrMaps.normal;
                        mat.normalScale = new THREE.Vector2(0.8, 0.8); // slightly subdued — T1 geometry is low-poly
                    }
                    if (pbrMaps.roughness) {
                        mat.roughnessMap = pbrMaps.roughness;
                    }
                }

                mat.userData.isInterior = true; // R32.53: skip toonification — toon step-lighting makes back-faces pure black
                // R32.71: Team emblem emissive glow for visibility
                if (isTeamEmblem && teamIdx >= 0 && _TEAM_EMBLEM_COLORS[teamIdx]) {
                    const te = _TEAM_EMBLEM_COLORS[teamIdx].emissive;
                    mat.emissive = new THREE.Color(te[0], te[1], te[2]);
                    mat.emissiveIntensity = 0.55;
                } else if (entry.emissive) {
                    mat.emissive = new THREE.Color(entry.emissive[0], entry.emissive[1], entry.emissive[2]);
                    mat.emissiveIntensity = 0.65;
                } else {
                    // Subtle ambient emissive for non-emissive materials
                    mat.emissive = new THREE.Color(cr * 0.08, cg * 0.08, cb * 0.08);
                    mat.emissiveIntensity = 0.30;
                }
                return mat;
            });
            // Fallback material for indices not covered by the DML list
            const fallback = new THREE.MeshStandardMaterial({
                ..._matProps,
                color: new THREE.Color(defaultEntry.color[0], defaultEntry.color[1], defaultEntry.color[2]),
                roughness: defaultEntry.roughness,
                metalness: defaultEntry.metalness,
                envMapIntensity: 0.35,
                emissive: new THREE.Color(0x1a1814),
                emissiveIntensity: 0.30,
            });
            fallback.userData.isInterior = true; // R32.53: skip toonification
            matArrayCache.set(cacheKey, { mats, fallback });
            return { mats, fallback };
        }

        // Create a parent group for easy hide/show + selective culling
        interiorShapesGroup = new THREE.Group();
        interiorShapesGroup.name = 'RaindanceInteriorShapes';
        scene.add(interiorShapesGroup);

        // Helper: convert MIS position to world
        const toWorld = (mp) => ({ x: mp[0], y: mp[2], z: -mp[1] });

        // Build BufferGeometry once per unique fileName, reuse across instances.
        // Tribes 1 used DirectX-style left-handed coords with CW winding; Three.js
        // is right-handed with CCW winding. We flip the index winding (i,j,k)->(i,k,j)
        // so face normals computed by computeCreaseNormals point outward.
        // R32.46: crease-aware smooth normals + midpoint subdivision for rocks
        // R32.48: material-palette vertex colors + geometry groups
        const geomCache = new Map();
        const _t0 = performance.now();
        let _enhancedCount = 0;
        const getGeom = (fileName) => {
            if (geomCache.has(fileName)) return geomCache.get(fileName);
            const m = meshes.get(fileName);
            if (!m) return null;

            const matNames = meshMaterialNames.get(fileName) || [];
            const hasV2Materials = m.materialIndices && matNames.length > 0;

            // Flip winding from CW (DirectX) to CCW (Three.js)
            const nTris = m.indices.length / 3;
            const flipped = new Uint32Array(m.indices.length);
            for (let t = 0; t < m.indices.length; t += 3) {
                flipped[t]   = m.indices[t];
                flipped[t+1] = m.indices[t+2];
                flipped[t+2] = m.indices[t+1];
            }

            // Per-triangle material index array (parallel to triangles after flip)
            let matIndices = m.materialIndices ? Array.from(m.materialIndices) : null;

            let finalPositions = m.positions;
            let finalIndices = flipped;

            // R32.46: Midpoint subdivision for rocks — adds resolution so
            // crease normals have more geometry to smooth with
            const isRock = fileName.toLowerCase().startsWith('lrock');
            if (isRock) {
                const sub = midpointSubdivide(finalPositions, finalIndices, matIndices);
                finalPositions = sub.positions;
                finalIndices = sub.indices;
                if (sub.triData) matIndices = sub.triData;
            }

            // R32.48: Build per-triangle material color array from palette
            let materialColors = null;
            let groupInfo = null; // { groups: [{matIdx, start, count}], uniqueMatIndices: [] }
            if (hasV2Materials && matIndices) {
                const finalNTris = finalIndices.length / 3;

                // Sort triangles by material index for contiguous groups
                const triOrder = Array.from({ length: finalNTris }, (_, i) => i);
                triOrder.sort((a, b) => (matIndices[a] || 0) - (matIndices[b] || 0));

                // Reorder indices and material indices according to sort
                const sortedIndices = new Uint32Array(finalIndices.length);
                const sortedMatIndices = new Array(finalNTris);
                for (let i = 0; i < finalNTris; i++) {
                    const src = triOrder[i];
                    sortedIndices[i * 3]     = finalIndices[src * 3];
                    sortedIndices[i * 3 + 1] = finalIndices[src * 3 + 1];
                    sortedIndices[i * 3 + 2] = finalIndices[src * 3 + 2];
                    sortedMatIndices[i] = matIndices[src] || 0;
                }
                finalIndices = sortedIndices;

                // R32.48.1: With geometry groups, each group gets its own material
                // whose .color already encodes the palette color. Vertex colors are
                // multiplied with material.color, so we set them to WHITE (1,1,1)
                // to avoid double-multiplication (palette × palette = too dark).
                materialColors = new Float32Array(finalNTris * 3);
                for (let t = 0; t < finalNTris; t++) {
                    materialColors[t * 3]     = 1.0;
                    materialColors[t * 3 + 1] = 1.0;
                    materialColors[t * 3 + 2] = 1.0;
                }

                // Build group boundaries
                const groups = [];
                let groupStart = 0;
                let prevMat = sortedMatIndices[0];
                for (let t = 1; t <= finalNTris; t++) {
                    const curMat = t < finalNTris ? sortedMatIndices[t] : -1;
                    if (curMat !== prevMat) {
                        groups.push({ matIdx: prevMat, start: groupStart * 3, count: (t - groupStart) * 3 });
                        groupStart = t;
                        prevMat = curMat;
                    }
                }
                groupInfo = groups;
            }

            // Build indexed geometry first (needed for crease normal computation)
            const g = new THREE.BufferGeometry();
            g.setAttribute('position', new THREE.BufferAttribute(finalPositions, 3));
            g.setIndex(new THREE.BufferAttribute(finalIndices, 1));

            // R32.46: Crease-aware smooth normals — 40° for architectural meshes,
            // 55° for rocks (rounder surfaces benefit from wider averaging)
            // R32.48: Pass materialColors for palette-based vertex coloring
            const creaseAngle = isRock ? 55 : 40;
            const enhanced = computeCreaseNormals(g, creaseAngle, materialColors);

            // R32.56.1: Normal attribute is unused — flatShading:true computes face
            // normals from screen-space derivatives (dFdx/dFdy), bypassing the broken
            // normals produced by computeCreaseNormals after the winding flip.
            // The R32.55 negation is removed; it had no effect with flatShading.

            // R32.48: Apply geometry groups for multi-material rendering.
            // After crease normals, geometry is non-indexed: each triangle = 3 consecutive verts.
            // Groups reference vertex offsets, so group.start = triStart * 3, count = triCount * 3.
            if (groupInfo && groupInfo.length > 0) {
                enhanced.clearGroups();
                for (let gi = 0; gi < groupInfo.length; gi++) {
                    const grp = groupInfo[gi];
                    enhanced.addGroup(grp.start, grp.count, grp.matIdx);
                }
            }

            _enhancedCount++;
            geomCache.set(fileName, enhanced);
            return enhanced;
        };

        // Place every neutral_interior_shapes instance.
        // Use a Group-wrapper-per-instance so we can apply yaw (around world Y)
        // INDEPENDENTLY from the local Tribes-z-up to Three-y-up rotation.
        // R32.71: Determine team ownership per shape by proximity to team generators.
        let _teamMidY = 318; // default midpoint
        try {
            const t0gens = (canon.team0?.static_shapes || []).filter(s => s.datablock === 'Generator');
            const t1gens = (canon.team1?.static_shapes || []).filter(s => s.datablock === 'Generator');
            if (t0gens.length && t1gens.length) {
                _teamMidY = (t0gens[0].position[1] + t1gens[0].position[1]) / 2;
            }
        } catch (e) { /* keep default */ }

        let placed = 0, missed = 0;
        const items = (canon.neutral_interior_shapes || []);
        for (const item of items) {
            const geom = getGeom(item.fileName);
            if (!geom) { missed++; continue; }

            // R32.71: Assign team by Y position (Tribes coords).
            // Rocks and midfield structures get -1 (neutral, no team coloring).
            const isRock = item.fileName.toLowerCase().startsWith('lrock');
            const isMidfield = item.fileName.toLowerCase().startsWith('mis_ob') ||
                               item.fileName.toLowerCase().startsWith('expbridge');
            const shapeTeamIdx = (isRock || isMidfield) ? -1 : (item.position[1] < _teamMidY ? 0 : 1);

            // R32.48: build material array for this mesh, with team coloring
            const { mats, fallback } = buildMaterialArray(item.fileName, shapeTeamIdx);
            // Create material array indexed by material slot.
            // Geometry groups reference matIdx (the DML material index).
            // Build a sparse array: slot i = mats[i] if exists, else fallback.
            const maxSlot = Math.max(mats.length - 1, ...(geom.groups || []).map(g => g.materialIndex));
            const matArray = [];
            for (let i = 0; i <= maxSlot; i++) {
                matArray.push(i < mats.length ? mats[i] : fallback);
            }

            const mesh = new THREE.Mesh(geom, matArray.length > 1 ? matArray : (matArray[0] || fallback));
            // Inner: rotate -90deg around X to map Tribes local-z-up to Three y-up
            mesh.rotation.x = -Math.PI / 2;
            mesh.castShadow = false;  // R32.49: interior self-shadowing with DoubleSide causes black rectangle flicker
            mesh.receiveShadow = false; // R32.50: interiors are enclosed; sun shadows inside cause flicker
            mesh.frustumCulled = false; // mirror existing buildings policy
            // Outer group: positions in world, applies yaw around world Y
            const outer = new THREE.Group();
            const w = toWorld(item.position);
            outer.position.set(w.x, w.y, w.z);
            // R32.69: Full 3-axis rotation from MIS data.
            // Tribes uses Z-up left-handed rotation convention.
            // Convert: Tribes axis (X,Y,Z) → Three.js axis (X,-Z,Y), negate angles for LH→RH.
            const _rx = item.rotation?.[0] || 0;
            const _ry = item.rotation?.[1] || 0;
            const _rz = item.rotation?.[2] || 0;
            if (_rx === 0 && _ry === 0) {
                outer.rotation.y = -_rz;  // Fast path: yaw-only shapes (most buildings)
            } else {
                // Full 3-axis rotation for tilted shapes (rocks, etc.)
                const qx = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -_rx);
                const qy = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, -1), -_ry);
                const qz = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), -_rz);
                outer.quaternion.copy(qz.multiply(qy).multiply(qx));
            }
            outer.add(mesh);
            outer.userData = { fileName: item.fileName, isInterior: true, teamIdx: shapeTeamIdx };
            interiorShapesGroup.add(outer);
            placed++;
        }
        console.log('[R32.48] Interior shapes placed:', placed, '(missed', missed, ')');
        // R32.71: Log team assignment summary
        const t0count = items.filter(i => !i.fileName.toLowerCase().startsWith('lrock') &&
            !i.fileName.toLowerCase().startsWith('mis_ob') &&
            !i.fileName.toLowerCase().startsWith('expbridge') &&
            i.position[1] < _teamMidY).length;
        const t1count = items.filter(i => !i.fileName.toLowerCase().startsWith('lrock') &&
            !i.fileName.toLowerCase().startsWith('mis_ob') &&
            !i.fileName.toLowerCase().startsWith('expbridge') &&
            i.position[1] >= _teamMidY).length;
        console.log('[R32.71] Team-colored accents: team0(BE)=' + t0count + ' team1(DS)=' + t1count + ' neutral=' + (items.length - t0count - t1count));
        console.log('[R32.48] Geometry enhancement:', (performance.now() - _t0).toFixed(1) + 'ms for',
            _enhancedCount, 'unique meshes (crease normals + rock subdivision + material palette)');

        // R32.54 DIAGNOSTIC URL params — no console commands needed
        {
            const _dp = new URLSearchParams(window.location.search);
            if (_dp.has('hideInterior')) {
                console.log('[R32.54-DIAG] hideInterior: RaindanceInteriorShapes.visible = false');
                interiorShapesGroup.visible = false;
            }
            if (_dp.has('basicInterior')) {
                let meshCount = 0;
                interiorShapesGroup.traverse(obj => {
                    if (!obj.isMesh) return;
                    meshCount++;
                    const bright = new THREE.MeshBasicMaterial({ color: 0xff4444, side: THREE.DoubleSide });
                    if (Array.isArray(obj.material)) {
                        obj.material = obj.material.map(() => bright);
                    } else {
                        obj.material = bright;
                    }
                });
                console.log('[R32.54-DIAG] basicInterior: replaced', meshCount, 'meshes with red MeshBasicMaterial');
            }
        }

        // R32.99: Unified collision — use registerModelCollision() for all geometry.
        // The Three.js meshes already have correct world transforms via parent chain:
        // scene → interiorShapesGroup → outer(worldPos+rot) → mesh(-90°X)
        // Force matrixWorld update since collision registers before first render.
        interiorShapesGroup.updateMatrixWorld(true);
        const colInfo = registerModelCollision(interiorShapesGroup);
        console.log('[R32.99] Interior collision via registerModelCollision:', colInfo);
    } catch (e) {
        console.error('[R32.1] initInteriorShapes failed', e);
    }
}

// ============================================================
// R32.98: Generic model collision registration.
// Walks any Object3D scene graph, extracts world-space triangles,
// and sends them to WASM via appendInteriorMeshTris().
// Convention: meshes named *_collision or *_col are physics-only.
//   If any collision meshes exist, ONLY those are used.
//   Otherwise ALL visual meshes are used.
// Handles indexed & non-indexed BufferGeometry.
// ============================================================
function registerModelCollision(root, worldMatrix) {
    // R32.104: Delegate to Rapier physics if available
    if (window.RapierPhysics && window.RapierPhysics.registerModelCollision) {
        return window.RapierPhysics.registerModelCollision(root, worldMatrix);
    }
    // Fallback: WASM-based collision (legacy path)
    if (!Module._appendInteriorMeshTris || !Module._malloc || !Module.HEAPF32) {
        console.warn('[registerModelCollision] No collision backend available');
        return { meshCount: 0, triCount: 0 };
    }

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

    // Use collision meshes if any exist; otherwise fall back to visual
    const sources = colMeshes.length > 0 ? colMeshes : visMeshes;

    // Hide collision-only meshes from rendering
    for (const m of colMeshes) m.visible = false;

    let totalMeshes = 0, totalTris = 0;
    const _mat = new THREE.Matrix4();
    const _v = new THREE.Vector3();

    for (const mesh of sources) {
        const geo = mesh.geometry;
        if (!geo || !geo.attributes.position) continue;

        // Compute effective world matrix for this mesh
        mesh.updateWorldMatrix(true, false);
        if (worldMatrix) {
            _mat.multiplyMatrices(worldMatrix, mesh.matrixWorld);
        } else {
            _mat.copy(mesh.matrixWorld);
        }

        const pos = geo.attributes.position;
        const idx = geo.index;
        const numTris = idx ? (idx.count / 3) | 0 : (pos.count / 3) | 0;
        if (numTris === 0) continue;

        const triData = new Float32Array(numTris * 9);
        let mnX = Infinity, mnY = Infinity, mnZ = Infinity;
        let mxX = -Infinity, mxY = -Infinity, mxZ = -Infinity;

        for (let t = 0; t < numTris; t++) {
            for (let v = 0; v < 3; v++) {
                const vi = idx ? idx.getX(t * 3 + v) : t * 3 + v;
                _v.fromBufferAttribute(pos, vi).applyMatrix4(_mat);
                const off = t * 9 + v * 3;
                triData[off]     = _v.x;
                triData[off + 1] = _v.y;
                triData[off + 2] = _v.z;
                mnX = Math.min(mnX, _v.x); mxX = Math.max(mxX, _v.x);
                mnY = Math.min(mnY, _v.y); mxY = Math.max(mxY, _v.y);
                mnZ = Math.min(mnZ, _v.z); mxZ = Math.max(mxZ, _v.z);
            }
        }

        const bytes = triData.length * 4;
        const ptr = Module._malloc(bytes);
        if (ptr) {
            Module.HEAPF32.set(triData, ptr / 4);
            Module._appendInteriorMeshTris(numTris, ptr, mnX, mnY, mnZ, mxX, mxY, mxZ);
            Module._free(ptr);
            totalMeshes++;
            totalTris += numTris;
        }
    }

    console.log(`[R32.98] registerModelCollision: ${totalMeshes} meshes, ${totalTris} tris`);
    return { meshCount: totalMeshes, triCount: totalTris };
}
window.registerModelCollision = registerModelCollision;

// ============================================================
// R32.58: Release stuck keys on window blur / Meta key release.
// macOS screenshot (Cmd+Shift+4) fires Shift keydown, then macOS grabs
// focus so the browser never gets keyup → player keeps sliding.
// Also: macOS Chrome doesn't fire keyup for keys released while Cmd is held.
// Fix: track pressed keys and release them on blur, visibilitychange,
// or Meta keyup. Synthetic events carry full key properties for WASM.
// ============================================================
(function initBlurKeyReset() {
    const _pressed = new Map(); // code → {key, keyCode, which, code}

    window.addEventListener('keydown', (e) => {
        if (e.code && !e.repeat) {
            _pressed.set(e.code, {
                key: e.key, keyCode: e.keyCode, which: e.which, code: e.code
            });
        }
    }, true);

    window.addEventListener('keyup', (e) => {
        if (e.code) _pressed.delete(e.code);
    }, true);

    function releaseAll() {
        for (const [code, info] of _pressed) {
            window.dispatchEvent(new KeyboardEvent('keyup', {
                code: info.code, key: info.key,
                keyCode: info.keyCode, which: info.which,
                bubbles: true, cancelable: true
            }));
        }
        _pressed.clear();
    }

    // Release all when window loses focus
    window.addEventListener('blur', releaseAll);
    document.addEventListener('visibilitychange', () => {
        if (document.hidden) releaseAll();
    });

    // macOS: when Meta (Cmd) is released, release everything else too —
    // Chrome/Safari don't fire keyup for keys released while Cmd was held
    window.addEventListener('keyup', (e) => {
        if (e.key === 'Meta') releaseAll();
    });
})();

// ============================================================
// R32.57: Custom GLB model loader — places imported models in the scene.
// Currently: Neon Wolf Sentinel near team 0 base.
// ============================================================
function initCustomModels() {
    const loader = new GLTFLoader();
    // Team 0 spawn: Tribes [-256.5, -10.3552, 35.7834]
    // toWorld: x = tribesX, y = tribesZ, z = -tribesY
    const wolfX = -256.5;
    const wolfZ = 10.35;
    const wolfY = sampleTerrainH(wolfX, wolfZ);

    loader.load('./assets/models/wolf_sentinel.glb', (gltf) => {
        const model = gltf.scene;
        model.name = 'WolfSentinel';

        // Model is ~2 units tall in Z; scale to ~20 units (guardian size)
        const scale = 20;
        model.scale.set(scale, scale, scale);

        // Meshy exports Z-up; rotate to Three.js Y-up
        model.rotation.x = -Math.PI / 2;

        // Position on terrain, offset from base so it's not clipping
        model.position.set(wolfX + 15, wolfY, wolfZ + 15);

        // Face toward the base
        model.rotation.z = Math.PI * 0.75;

        // Collect emissive materials for pulsing animation
        const emissiveMats = [];
        model.traverse((child) => {
            if (child.isMesh) {
                child.castShadow = true;
                child.receiveShadow = true;
                // Tag to skip toonify
                if (child.material) {
                    const mats = Array.isArray(child.material) ? child.material : [child.material];
                    mats.forEach(m => {
                        m.userData.isInterior = true;
                        // Track materials with emissive maps for pulsing
                        if (m.emissiveMap) emissiveMats.push(m);
                    });
                }
            }
        });

        // Store for render-loop animation
        model.userData.emissiveMats = emissiveMats;
        model.userData.kind = 'wolfSentinel';

        scene.add(model);
        console.log(`[R32.57] Wolf Sentinel loaded at (${wolfX}, ${wolfY.toFixed(1)}, ${wolfZ}), scale=${scale}, emissive materials: ${emissiveMats.length}`);
    }, undefined, (err) => {
        console.error('[R32.57] Failed to load wolf_sentinel.glb', err);
    });
}

// ============================================================
// R32.2: Base Accents — per-team visual elements not covered by
// the C++-baked buildings array: VehiclePad ground plates, RepairPack
// items, and side-mounted flag stand. Reads canonical.json directly
// (purely renderer-side; no C++ involvement). Visual-only — collision
// for these is handled by the existing R32.1 interior-shape AABBs and
// the C++ team-station boxes for surrounding gear.
// Coordinate convention matches initInteriorShapes:
//   MIS (x, y, z-up) -> world (x = mis_x, y = mis_z, z = -mis_y)
//   MIS rotation z-axis (yaw radians) -> Three.js world Y rotation = -mis_rot_z
// ============================================================
let baseAccentsGroup = null;

async function initBaseAccents() {
    try {
        const res = await fetch('assets/maps/raindance/canonical.json');
        if (!res.ok) { console.warn('[R32.2] canonical.json missing; skipping'); return; }
        const canon = await res.json();

        baseAccentsGroup = new THREE.Group();
        baseAccentsGroup.name = 'RaindanceBaseAccents';
        scene.add(baseAccentsGroup);

        const toWorld = (mp) => ({ x: mp[0], y: mp[2], z: -mp[1] });

        // Shared materials
        const padTopMat   = new THREE.MeshStandardMaterial({ color: 0x6b6960, roughness: 0.55, metalness: 0.45 });
        const padBaseMat  = new THREE.MeshStandardMaterial({ color: 0x3a3833, roughness: 0.85, metalness: 0.15 });
        const padStripeMat= new THREE.MeshStandardMaterial({ color: 0xC8B070, roughness: 0.7, metalness: 0.1, emissive: 0x6e5c2a, emissiveIntensity: 0.4 });
        const repairBoxMat= new THREE.MeshStandardMaterial({ color: 0xCC2A2A, roughness: 0.55, metalness: 0.2, emissive: 0x661010, emissiveIntensity: 0.4 });
        const repairCrossMat = new THREE.MeshStandardMaterial({ color: 0xF0F0F0, roughness: 0.4, metalness: 0.1, emissive: 0x404040, emissiveIntensity: 0.2 });
        const standMat    = new THREE.MeshStandardMaterial({ color: 0x4a463e, roughness: 0.7, metalness: 0.5 });

        // Helper: VehiclePad — circular landing pad with quadrant stripes.
        // R32.6: center disc gets a per-team emissive material so it pulses
        // visibly from the air. Team color comes from teamIdx in caller.
        const makeVehiclePad = (teamIdx) => {
            const g = new THREE.Group();
            const base = new THREE.Mesh(new THREE.CylinderGeometry(5.0, 5.4, 0.35, 24), padBaseMat);
            base.position.y = -0.10; base.castShadow = false; base.receiveShadow = true; g.add(base);
            const top = new THREE.Mesh(new THREE.CylinderGeometry(4.6, 4.6, 0.10, 24), padTopMat);
            top.position.y = 0.10; top.receiveShadow = true; g.add(top);
            // Cross stripes for landing target
            for (let q = 0; q < 4; q++) {
                const stripe = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.04, 4.2), padStripeMat);
                stripe.position.y = 0.16; stripe.rotation.y = q * Math.PI / 4; g.add(stripe);
            }
            // Center disc — emissive in team color so it reads as a landing target
            const teamColor = TEAM_COLORS[teamIdx] || 0x808080;
            const centerMat = new THREE.MeshStandardMaterial({
                color: teamColor, emissive: teamColor, emissiveIntensity: 0.30,
                roughness: 0.5, metalness: 0.1,
            });
            const center = new THREE.Mesh(new THREE.CylinderGeometry(1.1, 1.1, 0.06, 16), centerMat);
            center.position.y = 0.18; g.add(center);
            g.userData = { center: center };
            return g;
        };

        // Helper: RepairPack item box
        const makeRepairPack = () => {
            const g = new THREE.Group();
            const box = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.55, 0.55), repairBoxMat);
            box.position.y = 0.275; box.castShadow = true; g.add(box);
            const crossA = new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.10, 0.10), repairCrossMat);
            crossA.position.y = 0.275; g.add(crossA);
            const crossB = new THREE.Mesh(new THREE.BoxGeometry(0.10, 0.62, 0.10), repairCrossMat);
            crossB.position.y = 0.275; g.add(crossB);
            return g;
        };

        // Helper: side-mounted flag stand (small platform protruding from base tower)
        // Per user spec: side-mounted at midway height, NOT on roof.
        const makeFlagStand = (teamIdx) => {
            const g = new THREE.Group();
            // Platform plate (circular, slight bevel)
            const plate = new THREE.Mesh(new THREE.CylinderGeometry(1.4, 1.6, 0.18, 16), standMat);
            plate.position.y = 0.0; plate.receiveShadow = true; g.add(plate);
            // Inner team-tinted disc indicates ownership
            const disc = new THREE.Mesh(
                new THREE.CylinderGeometry(1.05, 1.05, 0.04, 16),
                new THREE.MeshStandardMaterial({
                    color: TEAM_COLORS[teamIdx],
                    emissive: TEAM_COLORS[teamIdx],
                    emissiveIntensity: 0.30,
                    roughness: 0.55, metalness: 0.20,
                })
            );
            disc.position.y = 0.11; g.add(disc);
            // Two small rim lights (team-tinted dots) at front and back
            const dotMat = new THREE.MeshBasicMaterial({ color: TEAM_COLORS[teamIdx] });
            for (let s = 0; s < 4; s++) {
                const dot = new THREE.Mesh(new THREE.SphereGeometry(0.08, 12, 8), dotMat);
                const a = s * Math.PI / 2;
                dot.position.set(Math.cos(a) * 1.32, 0.13, Math.sin(a) * 1.32);
                g.add(dot);
            }
            return g;
        };

        let placed = 0;

        // Per-team: VehiclePad + RepairPack + side-mounted flag stand
        ['team0', 'team1'].forEach((tk, teamIdx) => {
            const t = canon[tk];
            if (!t) return;
            // VehiclePads (1 per team in canonical) — from team static_shapes
            (t.static_shapes || []).forEach(s => {
                if (s.datablock !== 'VehiclePad') return;
                const pad = makeVehiclePad(teamIdx);
                const w = toWorld(s.position);
                pad.position.set(w.x, w.y, w.z);
                const ry = -(s.rotation?.[2] ?? 0);
                pad.rotation.y = ry;
                pad.traverse(c => { c.frustumCulled = false; });
                // Preserve center handle from the helper
                const centerRef = pad.userData.center;
                pad.userData = { kind: 'vehiclepad', team: teamIdx, baseY: w.y, center: centerRef };
                baseAccentsGroup.add(pad);
                placed++;
            });
            // RepairPack items — small visual marker so players can see the pickup
            (t.items || []).forEach(it => {
                if (it.datablock !== 'RepairPack') return;
                const rp = makeRepairPack();
                const w = toWorld(it.position);
                rp.position.set(w.x, w.y + 0.6, w.z); // float slightly above ground for visibility
                rp.traverse(c => { c.frustumCulled = false; });
                rp.userData = { kind: 'repairpack', team: teamIdx, baseY: w.y + 0.6, phase: Math.random() * Math.PI * 2 };
                baseAccentsGroup.add(rp);
                placed++;
            });
            // Side-mounted flag stand at canonical flag home position. The flag
            // mesh itself follows live state from C++ (syncFlags); the stand is
            // a fixed visual at the home position so even when the flag is
            // carried away, the base reads as a CTF flag mount point.
            if (t.flag && t.flag.position) {
                const stand = makeFlagStand(teamIdx);
                const w = toWorld(t.flag.position);
                // Drop the stand 0.1m below the flag base so the flagpole appears
                // to plant into the platform, not float above it.
                stand.position.set(w.x, w.y - 0.10, w.z);
                const ry = -(t.flag.rotation?.[2] ?? 0);
                stand.rotation.y = ry;
                stand.traverse(c => { c.frustumCulled = false; });
                // Capture references to disc + dots for pulse animation in syncBaseAccents
                const disc = stand.children[1]; // index matches order: plate, disc, dots*4
                stand.userData = { kind: 'flagstand', team: teamIdx, disc: disc, baseY: w.y - 0.10 };
                baseAccentsGroup.add(stand);
                placed++;
            }
        });

        console.log('[R32.2] Base accents placed:', placed,
            '(VehiclePads + RepairPacks + side-mounted flag stands)');
    } catch (e) {
        console.error('[R32.2] initBaseAccents failed', e);
    }
}

// ============================================================
// Players — composite procedural soldier (3 armor tiers, animated)
// ============================================================
const ARMOR_TIERS = [
    { name: 'light',  bodyR: 0.30, bodyH: 0.85, shoulderR: 0.16, armR: 0.09, armL: 0.65,
      legR: 0.13, legL: 0.85, jet: [0.50, 0.55, 0.22], scale: 0.96 },
    { name: 'medium', bodyR: 0.36, bodyH: 0.95, shoulderR: 0.20, armR: 0.12, armL: 0.70,
      legR: 0.16, legL: 0.90, jet: [0.58, 0.65, 0.27], scale: 1.00 },
    { name: 'heavy',  bodyR: 0.46, bodyH: 1.05, shoulderR: 0.27, armR: 0.16, armL: 0.75,
      legR: 0.20, legL: 0.95, jet: [0.72, 0.80, 0.32], scale: 1.08 },
];

function createPlayerMesh(armor) {
    const t = ARMOR_TIERS[Math.min(armor, 2)];
    const group = new THREE.Group();
    // R31: disable frustum culling on the group root so sub-mesh bounding
    // spheres that haven't been computed yet don't silently cull the soldier.
    group.frustumCulled = false;

    // R31: reduce metalness 0.4→0.10 so ambient hemisphere light visibly
    // illuminates the armor (high metalness + low env = black silhouette).
    const armorMat = new THREE.MeshStandardMaterial({ color: 0x8a9090, roughness: 0.55, metalness: 0.10 });
    const accentMat = new THREE.MeshStandardMaterial({ color: 0x1a1a1a, roughness: 0.85, metalness: 0.2 });
    const visorMat = new THREE.MeshStandardMaterial({
        color: 0x111122, roughness: 0.18, metalness: 0.85,
        emissive: 0x223344, emissiveIntensity: 0.25
    });

    // R32.5: torso group pivoted at sternum height (~1.10m). Upper-body parts
    // are added as children with positions relative to the pivot, so a single
    // torso.rotation.x = pitch leans the entire upper body without affecting
    // hips or legs (they stay attached to the locomotion root).
    const TORSO_PIVOT_Y = 1.10;
    const torso = new THREE.Group();
    torso.position.y = TORSO_PIVOT_Y;
    group.add(torso);

    // Body (chest) — tapered cylinder
    const bodyGeom = new THREE.CylinderGeometry(t.bodyR * 0.85, t.bodyR, t.bodyH, 10);
    const body = new THREE.Mesh(bodyGeom, armorMat);
    body.position.y = 0; // pivot is at chest center now
    body.castShadow = true; body.receiveShadow = true;
    torso.add(body);

    // Hips (NOT in torso — stays with locomotion root)
    const hipsGeom = new THREE.BoxGeometry(t.bodyR * 1.6, 0.18, t.bodyR * 1.0);
    const hips = new THREE.Mesh(hipsGeom, accentMat);
    hips.position.y = 0.55;
    hips.castShadow = true;
    group.add(hips);

    // Head (relative to torso pivot)
    const headGeom = new THREE.SphereGeometry(0.20, 12, 10);
    const head = new THREE.Mesh(headGeom, armorMat);
    head.position.y = 1.78 - TORSO_PIVOT_Y;
    head.castShadow = true;
    torso.add(head);

    // Helmet (cap)
    const helmetGeom = new THREE.SphereGeometry(0.24, 14, 10, 0, Math.PI * 2, 0, Math.PI * 0.50);
    const helmet = new THREE.Mesh(helmetGeom, accentMat);
    helmet.position.y = 1.82 - TORSO_PIVOT_Y;
    helmet.castShadow = true;
    torso.add(helmet);

    // Visor band
    const visorGeom = new THREE.BoxGeometry(0.36, 0.09, 0.30);
    const visor = new THREE.Mesh(visorGeom, visorMat);
    visor.position.set(0, 1.74 - TORSO_PIVOT_Y, 0.10);
    torso.add(visor);

    // Shoulders
    const shoulderGeom = new THREE.SphereGeometry(t.shoulderR, 8, 6);
    const lShoulder = new THREE.Mesh(shoulderGeom, armorMat);
    lShoulder.position.set(-t.bodyR - t.shoulderR * 0.3, 1.45 - TORSO_PIVOT_Y, 0);
    lShoulder.castShadow = true;
    torso.add(lShoulder);
    const rShoulder = lShoulder.clone();
    rShoulder.position.x = -lShoulder.position.x;
    torso.add(rShoulder);

    // Arm groups (pivot at shoulder for animation; live in torso so they pitch with it)
    function makeArm(side) {
        const armGroup = new THREE.Group();
        armGroup.position.set(side * (t.bodyR + t.shoulderR * 0.3), 1.45 - TORSO_PIVOT_Y, 0);
        const armGeom = new THREE.CylinderGeometry(t.armR, t.armR * 0.85, t.armL, 8);
        const arm = new THREE.Mesh(armGeom, armorMat);
        arm.position.y = -t.armL / 2;
        arm.castShadow = true;
        armGroup.add(arm);
        // Hand
        const handGeom = new THREE.SphereGeometry(t.armR * 1.1, 8, 6);
        const hand = new THREE.Mesh(handGeom, accentMat);
        hand.position.y = -t.armL - t.armR * 0.7;
        armGroup.add(hand);
        return armGroup;
    }
    const leftArm = makeArm(-1);
    const rightArm = makeArm(1);
    torso.add(leftArm);
    torso.add(rightArm);

    // Leg groups (pivot at hip)
    function makeLeg(side) {
        const legGroup = new THREE.Group();
        legGroup.position.set(side * t.bodyR * 0.45, 0.55, 0);
        const legGeom = new THREE.CylinderGeometry(t.legR, t.legR * 0.8, t.legL, 8);
        const leg = new THREE.Mesh(legGeom, armorMat);
        leg.position.y = -t.legL / 2;
        leg.castShadow = true;
        legGroup.add(leg);
        // Foot
        const footGeom = new THREE.BoxGeometry(t.legR * 1.6, 0.12, t.legR * 2.6);
        const foot = new THREE.Mesh(footGeom, accentMat);
        foot.position.set(0, -t.legL - 0.06, t.legR * 0.4);
        legGroup.add(foot);
        return legGroup;
    }
    const leftLeg = makeLeg(-1);
    const rightLeg = makeLeg(1);
    group.add(leftLeg);
    group.add(rightLeg);

    // Jetpack (on back) — also rides the torso so it leans with the body
    const jetGeom = new THREE.BoxGeometry(...t.jet);
    const jet = new THREE.Mesh(jetGeom, accentMat);
    jet.position.set(0, 1.20 - TORSO_PIVOT_Y, -t.bodyR - t.jet[2] * 0.45);
    jet.castShadow = true;
    torso.add(jet);

    // Jet thrusters — stay with torso so they tip with the jetpack
    const thrustGeom = new THREE.CylinderGeometry(0.07, 0.10, 0.18, 8);
    const lThrust = new THREE.Mesh(thrustGeom, accentMat);
    lThrust.position.set(-0.16, 0.78 - TORSO_PIVOT_Y, -t.bodyR - t.jet[2] * 0.45);
    torso.add(lThrust);
    const rThrust = lThrust.clone();
    rThrust.position.x = 0.16;
    torso.add(rThrust);

    group.scale.setScalar(t.scale);

    group.userData = {
        armor: armor,
        leftArm, rightArm, leftLeg, rightLeg, body,
        torso, // R32.5: handle for per-frame pitch
        armorMat, // can recolor for team
    };

    // R31: propagate frustumCulled=false to all descendant meshes so none
    // get silently culled when their geometry bounding sphere is unset/zero.
    group.traverse(child => { child.frustumCulled = false; });

    return group;
}

// R22: shield sphere shared geometry/material — pulsing cyan, attached per-player when active
const shieldSpheres = []; // index = player slot
function makeShieldSphere() {
    const geom = new THREE.SphereGeometry(1.2, 16, 12);
    const mat = new THREE.MeshBasicMaterial({
        color: 0x9DDCFF,
        transparent: true,
        opacity: 0.35,
        depthWrite: false,
        side: THREE.DoubleSide,
    });
    const mesh = new THREE.Mesh(geom, mat);
    mesh.visible = false;
    return mesh;
}

function initPlayers() {
    for (let i = 0; i < MAX_PLAYERS; i++) {
        const mesh = createPlayerMesh(1);
        mesh.visible = false;
        scene.add(mesh);
        playerMeshes.push(mesh);
        // Pre-allocate shield sphere per player
        const shield = makeShieldSphere();
        scene.add(shield);
        shieldSpheres.push(shield);
    }
    console.log('[R18] Players: 16 composite soldiers (3 armor tiers)');
}

// R20: nameplates above remote players. Lazy-built per slot when first needed.
const nameplateSprites = []; // index = player slot, value = THREE.Sprite or null
const nameplateLastName = []; // cache of last rendered name to avoid texture rebuild

// R26: tier color lookup mirrors client/tiers.js (kept inline so renderer
// has no module dependency cycle). If __tribesPlayerRatings has the slot's
// rating, we paint a colored stripe on the left of the nameplate.
const _RENDERER_TIERS = [
    { min: 0,    color: '#A87040' }, { min: 1000, color: '#B0B0B8' },
    { min: 1200, color: '#D4A030' }, { min: 1400, color: '#5DD6E0' },
    { min: 1600, color: '#9B6BFF' }, { min: 1800, color: '#FF6BAB' },
];
function _tierColorForRating(r) {
    for (let i = _RENDERER_TIERS.length - 1; i >= 0; i--) if (r >= _RENDERER_TIERS[i].min) return _RENDERER_TIERS[i].color;
    return _RENDERER_TIERS[0].color;
}

function makeNameplateTexture(name, teamColor, tierColor) {
    const w = 256, h = 64;
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const ctx = c.getContext('2d');
    ctx.fillStyle = 'rgba(8,6,3,0.55)';
    ctx.fillRect(0, 0, w, h);
    if (tierColor) {
        ctx.fillStyle = tierColor;
        ctx.fillRect(0, 0, 8, h);
    }
    ctx.font = 'bold 32px "Barlow Condensed", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = teamColor;
    ctx.fillText(name, w / 2, h / 2 + 2);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.minFilter = THREE.LinearFilter;
    return tex;
}

function ensureNameplate(slot, name, team) {
    // R26: invalidate cache when the rating-derived tier color changes
    const ratings = window.__tribesPlayerRatings || {};
    const rating = ratings[slot];
    const tierColor = (typeof rating === 'number') ? _tierColorForRating(rating) : null;
    const cacheKey = name + '|' + (tierColor || '');
    if (nameplateLastName[slot] === cacheKey && nameplateSprites[slot]) return nameplateSprites[slot];
    if (nameplateSprites[slot]) {
        scene.remove(nameplateSprites[slot]);
        nameplateSprites[slot].material.map.dispose();
        nameplateSprites[slot].material.dispose();
    }
    const teamColorHex = team === 0 ? '#FFCDCD' : team === 1 ? '#CDD8FF' : '#E8DCB8';
    const tex = makeNameplateTexture(name, teamColorHex, tierColor);
    const mat = new THREE.SpriteMaterial({
        map: tex, transparent: true, depthWrite: false,
        depthTest: true, sizeAttenuation: true,
    });
    const sprite = new THREE.Sprite(mat);
    sprite.scale.set(2.0, 0.5, 1);
    scene.add(sprite);
    nameplateSprites[slot] = sprite;
    nameplateLastName[slot] = cacheKey;
    return sprite;
}

function rebuildPlayerMesh(slot, armor) {
    const old = playerMeshes[slot];
    scene.remove(old);
    old.traverse(o => { if (o.geometry) o.geometry.dispose(); if (o.material) o.material.dispose && o.material.dispose(); });
    const fresh = createPlayerMesh(armor);
    fresh.visible = false;
    scene.add(fresh);
    playerMeshes[slot] = fresh;
}

// Procedural rig animation
function animatePlayer(mesh, vx, vz, jetting, skiing, t, alive) {
    if (!alive) return;
    const ud = mesh.userData;
    const horizSpeed = Math.sqrt(vx * vx + vz * vz);

    if (jetting) {
        ud.leftLeg.rotation.x = -0.25;
        ud.rightLeg.rotation.x = -0.25;
        ud.leftArm.rotation.x = -0.55;
        ud.rightArm.rotation.x = -0.55;
        ud.body.rotation.x = -0.30;
    } else if (skiing) {
        const tilt = -0.15;
        ud.leftLeg.rotation.x = tilt;
        ud.rightLeg.rotation.x = tilt;
        ud.leftArm.rotation.x = -0.40;
        ud.rightArm.rotation.x = -0.40;
        ud.body.rotation.x = -0.20;
    } else if (horizSpeed > 0.5) {
        const phase = t * 5 * Math.min(1.5, horizSpeed / 6);
        const amp = Math.min(0.65, horizSpeed / 8);
        const swing = Math.sin(phase) * amp;
        ud.leftLeg.rotation.x = swing;
        ud.rightLeg.rotation.x = -swing;
        ud.leftArm.rotation.x = -swing * 0.7;
        ud.rightArm.rotation.x = swing * 0.7;
        ud.body.rotation.x = 0;
    } else {
        // R31.1: idle breathing — small bob so stationary soldiers never look frozen
        const breathe = Math.sin(t * 1.5) * 0.04;
        ud.leftLeg.rotation.x = 0;
        ud.rightLeg.rotation.x = 0;
        ud.leftArm.rotation.x = breathe;
        ud.rightArm.rotation.x = breathe;
        ud.body.rotation.x = breathe * 0.5;
    }
}

// ============================================================
// Projectiles, flags, weapon viewmodel
// ============================================================
function initProjectiles() {
    for (let i = 0; i < MAX_PROJECTILES; i++) {
        const geom = new THREE.SphereGeometry(0.20, 10, 8);
        const mat = new THREE.MeshStandardMaterial({
            color: 0xFFFFFF,
            emissive: 0xFFFFFF,
            emissiveIntensity: 1.5,
            roughness: 0.4,
            metalness: 0.1,
        });
        const mesh = new THREE.Mesh(geom, mat);
        mesh.visible = false;
        scene.add(mesh);
        projectileMeshes.push(mesh);
    }
}

function initFlags() {
    for (let i = 0; i < 2; i++) {
        const group = new THREE.Group();
        const poleGeom = new THREE.CylinderGeometry(0.07, 0.07, 4.2, 8);
        const poleMat = new THREE.MeshStandardMaterial({ color: 0x808080, metalness: 0.7, roughness: 0.35 });
        const pole = new THREE.Mesh(poleGeom, poleMat);
        pole.position.y = 2.1;
        pole.castShadow = true;
        group.add(pole);
        const bannerGeom = new THREE.PlaneGeometry(1.5, 0.95);
        const bannerMat = new THREE.MeshStandardMaterial({
            color: TEAM_COLORS[i],
            roughness: 0.85,
            side: THREE.DoubleSide,
            emissive: TEAM_COLORS[i],
            emissiveIntensity: 0.15,
        });
        const banner = new THREE.Mesh(bannerGeom, bannerMat);
        banner.position.set(0.75, 3.5, 0);
        banner.castShadow = true;
        group.add(banner);
        scene.add(group);
        flagMeshes.push(group);
    }
}

function initWeaponViewmodel() {
    // R32.13: proper sci-fi rifle viewmodel + first-person arms.
    // Tribes-flavored energy carbine: angular polymer chassis, exposed energy cell,
    // holographic sight, muzzle brake, vented barrel shroud, ergonomic foregrip.
    // All procedural Three.js primitives — no GLB load needed.
    const matFrame = new THREE.MeshStandardMaterial({ color: 0x2c2e34, roughness: 0.55, metalness: 0.4 });
    const matMetal = new THREE.MeshStandardMaterial({ color: 0x9aa2ad, roughness: 0.30, metalness: 0.85 });
    const matDark  = new THREE.MeshStandardMaterial({ color: 0x14161a, roughness: 0.65, metalness: 0.20 });
    const matAccent = new THREE.MeshStandardMaterial({ color: 0xc8a050, roughness: 0.35, metalness: 0.85 }); // brass-tan
    const matGlow = new THREE.MeshStandardMaterial({
        color: 0x44ccff, emissive: 0x44ccff, emissiveIntensity: 1.4,
        roughness: 0.30, metalness: 0.0,
    });
    const matLens = new THREE.MeshStandardMaterial({
        color: 0xff4422, emissive: 0xff4422, emissiveIntensity: 0.9,
        roughness: 0.20, metalness: 0.10,
    });
    const matSkin = new THREE.MeshStandardMaterial({ color: 0x9b6b4a, roughness: 0.85, metalness: 0.0 });
    const matGlove = new THREE.MeshStandardMaterial({ color: 0x1a1c20, roughness: 0.75, metalness: 0.15 });

    const group = new THREE.Group();

    // ===== Receiver / main chassis =====
    // Slightly bevel by stacking two boxes (top deck + lower body)
    const lower = new THREE.Mesh(new THREE.BoxGeometry(0.055, 0.060, 0.220), matFrame);
    lower.position.set(0, -0.005, -0.060);
    group.add(lower);
    const upper = new THREE.Mesh(new THREE.BoxGeometry(0.046, 0.030, 0.180), matFrame);
    upper.position.set(0, 0.038, -0.060);
    group.add(upper);

    // Pic-rail-style top with three cosmetic ridges
    for (let i = 0; i < 3; i++) {
        const rail = new THREE.Mesh(new THREE.BoxGeometry(0.038, 0.005, 0.020), matMetal);
        rail.position.set(0, 0.057, -0.020 - i * 0.04);
        group.add(rail);
    }

    // ===== Stock (rear) =====
    const stockBack = new THREE.Mesh(new THREE.BoxGeometry(0.034, 0.075, 0.060), matFrame);
    stockBack.position.set(0, -0.005, 0.075);
    group.add(stockBack);
    const stockTop = new THREE.Mesh(new THREE.BoxGeometry(0.024, 0.020, 0.040), matFrame);
    stockTop.position.set(0, 0.038, 0.064);
    group.add(stockTop);
    // Cheekrest
    const cheek = new THREE.Mesh(new THREE.BoxGeometry(0.018, 0.012, 0.050), matDark);
    cheek.position.set(0, 0.054, 0.060);
    group.add(cheek);

    // ===== Pistol grip =====
    const gripGeo = new THREE.BoxGeometry(0.026, 0.060, 0.038);
    const grip = new THREE.Mesh(gripGeo, matFrame);
    grip.position.set(0, -0.060, -0.005);
    grip.rotation.x = -0.18;  // ergonomic angle
    group.add(grip);
    // Grip texture stripes
    for (let i = 0; i < 4; i++) {
        const stripe = new THREE.Mesh(new THREE.BoxGeometry(0.028, 0.003, 0.040), matDark);
        stripe.position.set(0, -0.044 - i * 0.014, -0.005 + i * 0.0025);
        stripe.rotation.x = -0.18;
        group.add(stripe);
    }

    // ===== Magazine / energy cell (forward of grip, exposed glow) =====
    const mag = new THREE.Mesh(new THREE.BoxGeometry(0.038, 0.075, 0.040), matFrame);
    mag.position.set(0, -0.054, -0.080);
    mag.rotation.x = -0.05;
    group.add(mag);
    // Glowing energy strip on side of mag (the Tribes "plasma cell" hint)
    const cellGlow = new THREE.Mesh(new THREE.BoxGeometry(0.040, 0.045, 0.008), matGlow);
    cellGlow.position.set(0.020, -0.054, -0.080);
    cellGlow.rotation.x = -0.05;
    group.add(cellGlow);
    const cellGlow2 = cellGlow.clone();
    cellGlow2.position.x = -0.020;
    group.add(cellGlow2);

    // ===== Trigger guard =====
    const trigGuard = new THREE.Mesh(new THREE.TorusGeometry(0.018, 0.004, 6, 14, Math.PI), matMetal);
    trigGuard.rotation.set(0, Math.PI / 2, Math.PI);
    trigGuard.position.set(0, -0.030, -0.018);
    group.add(trigGuard);

    // ===== Foregrip / handguard (where left hand grips) =====
    const handguard = new THREE.Mesh(new THREE.BoxGeometry(0.044, 0.044, 0.090), matFrame);
    handguard.position.set(0, 0.005, -0.205);
    group.add(handguard);
    // Vent slats on handguard sides
    for (let i = 0; i < 4; i++) {
        const vent = new THREE.Mesh(new THREE.BoxGeometry(0.046, 0.004, 0.014), matDark);
        vent.position.set(0, 0.024 - i * 0.012, -0.205);
        group.add(vent);
    }

    // ===== Barrel + muzzle brake =====
    const barrel = new THREE.Mesh(
        new THREE.CylinderGeometry(0.011, 0.011, 0.130, 12),
        matMetal
    );
    barrel.rotation.x = Math.PI / 2;
    barrel.position.set(0, 0.005, -0.310);
    group.add(barrel);
    // Muzzle brake (slotted barrel tip)
    const muzzle = new THREE.Mesh(
        new THREE.CylinderGeometry(0.018, 0.018, 0.040, 12),
        matMetal
    );
    muzzle.rotation.x = Math.PI / 2;
    muzzle.position.set(0, 0.005, -0.395);
    group.add(muzzle);
    // Muzzle brake slots (two horizontal cuts)
    for (let i = 0; i < 2; i++) {
        const slot = new THREE.Mesh(new THREE.BoxGeometry(0.040, 0.004, 0.030), matDark);
        slot.position.set(0, 0.013 - i * 0.016, -0.395);
        group.add(slot);
    }

    // ===== Holographic sight (top of receiver) =====
    const sightBody = new THREE.Mesh(new THREE.BoxGeometry(0.034, 0.024, 0.044), matDark);
    sightBody.position.set(0, 0.075, -0.080);
    group.add(sightBody);
    // Front lens (red dot)
    const lensFront = new THREE.Mesh(
        new THREE.CylinderGeometry(0.011, 0.011, 0.005, 12),
        matLens
    );
    lensFront.rotation.x = Math.PI / 2;
    lensFront.position.set(0, 0.075, -0.103);
    group.add(lensFront);
    // Back lens (where the eye looks through)
    const lensBack = new THREE.Mesh(
        new THREE.CylinderGeometry(0.011, 0.011, 0.005, 12),
        matDark
    );
    lensBack.rotation.x = Math.PI / 2;
    lensBack.position.set(0, 0.075, -0.057);
    group.add(lensBack);
    // Sight rails (mount)
    const sightMount = new THREE.Mesh(new THREE.BoxGeometry(0.026, 0.012, 0.040), matMetal);
    sightMount.position.set(0, 0.060, -0.080);
    group.add(sightMount);

    // ===== Charging handle (cosmetic, side of receiver) =====
    const charge = new THREE.Mesh(new THREE.BoxGeometry(0.008, 0.012, 0.045), matAccent);
    charge.position.set(0.030, 0.020, -0.020);
    group.add(charge);

    // ===== Muzzle anchor point (named for CombatFX hookup) =====
    const muzzleAnchor = new THREE.Object3D();
    muzzleAnchor.position.set(0, 0.005, -0.420);   // tip of muzzle brake, just outside the model
    muzzleAnchor.name = 'muzzle';
    group.add(muzzleAnchor);

    // ===== First-person arms =====
    // Right hand grips the pistol grip; left hand grips the foregrip.
    // Forearms enter from screen-bottom-corners, gloved hands wrap the rifle.

    // RIGHT forearm (pistol-grip side) — comes in from bottom-right
    const rForearm = new THREE.Mesh(
        new THREE.CylinderGeometry(0.022, 0.028, 0.18, 10),
        matSkin
    );
    rForearm.rotation.set(0.55, 0, -0.20);
    rForearm.position.set(0.045, -0.130, 0.060);
    group.add(rForearm);
    // Right glove
    const rGlove = new THREE.Mesh(new THREE.BoxGeometry(0.040, 0.060, 0.060), matGlove);
    rGlove.position.set(0.018, -0.075, -0.005);
    rGlove.rotation.set(0.2, 0, -0.15);
    group.add(rGlove);
    // Sleeve cuff (color accent at wrist)
    const rCuff = new THREE.Mesh(new THREE.CylinderGeometry(0.030, 0.030, 0.020, 10), matAccent);
    rCuff.rotation.set(0.55, 0, -0.20);
    rCuff.position.set(0.030, -0.110, 0.020);
    group.add(rCuff);

    // LEFT forearm (foregrip side) — comes in from bottom-left
    const lForearm = new THREE.Mesh(
        new THREE.CylinderGeometry(0.022, 0.028, 0.20, 10),
        matSkin
    );
    lForearm.rotation.set(0.85, 0, 0.42);
    lForearm.position.set(-0.075, -0.140, -0.140);
    group.add(lForearm);
    // Left glove (wraps foregrip from below)
    const lGlove = new THREE.Mesh(new THREE.BoxGeometry(0.045, 0.045, 0.075), matGlove);
    lGlove.position.set(-0.022, -0.060, -0.205);
    lGlove.rotation.set(0.1, 0, 0.30);
    group.add(lGlove);
    // Left cuff
    const lCuff = new THREE.Mesh(new THREE.CylinderGeometry(0.030, 0.030, 0.020, 10), matAccent);
    lCuff.rotation.set(0.85, 0, 0.42);
    lCuff.position.set(-0.045, -0.115, -0.090);
    group.add(lCuff);

    // Mount in lower-right of camera local space; slight upward tilt so barrel
    // angles toward center-screen.
    group.position.set(0.16, -0.16, -0.30);
    group.rotation.set(-0.05, 0.06, 0.0);
    group.traverse(child => {
        child.frustumCulled = false;
        if (child.isMesh) child.castShadow = false;  // viewmodel shouldn't cast shadows
    });

    weaponHand = group;
    // Expose muzzle anchor globally for CombatFX
    window._weaponMuzzleAnchor = muzzleAnchor;
    // (camera.add(weaponHand) happens in initStateViews after camera is created)
}

// ============================================================
// Particles — type-aware shader-driven pool
// ============================================================
// ============================================================
// R32.0 Rain — Raindance.MIS "Rain1" Snowfall, intensity 1, wind (-0.22, 0.15, -75)
// Screen-space streaks anchored to camera; not world-space so they always cover
// the view regardless of player position.
// ============================================================
let _rainGeom = null, _rainSystem = null;
// R32.10: longer streak lines instead of round dots. Lines render as classic
// Tribes/Counter-Strike rain — thin vertical streaks tilted by wind, much more
// readable in motion than circular point sprites.
const RAIN_COUNT = 6000;                 // 6k streaks
const RAIN_WIND_X = -0.22, RAIN_WIND_Z = 0.15;
const RAIN_SPEED = 32;                    // m/s downward
const RAIN_SPREAD = 80;                   // half-width of rain volume around camera
const RAIN_HEIGHT = 60;                   // rain volume above camera
const RAIN_STREAK_LEN = 1.4;              // meters — length of each streak line
let _rainPos = null;                      // Float32 array, 2 verts per streak (head + tail)

// R32.8 — round soft-edge raindrop sprite (canvas-generated, no asset fetch).
// PointsMaterial without a `map` renders square pixels, which read as snow at
// our sizes. A radial alpha gradient gives circular silhouettes that blur
// nicely with motion.
function _makeRaindropTexture() {
    const c = document.createElement('canvas'); c.width = c.height = 64;
    const ctx = c.getContext('2d');
    const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 30);
    // Slight vertical streak: slightly elliptical falloff so falling drops
    // read as drops, not as round pellets.
    g.addColorStop(0.0,  'rgba(255,255,255,1.0)');
    g.addColorStop(0.25, 'rgba(220,232,245,0.85)');
    g.addColorStop(0.6,  'rgba(180,200,220,0.25)');
    g.addColorStop(1.0,  'rgba(180,200,220,0.0)');
    ctx.fillStyle = g; ctx.fillRect(0, 0, 64, 64);
    const tex = new THREE.CanvasTexture(c);
    tex.minFilter = THREE.LinearFilter; tex.magFilter = THREE.LinearFilter;
    tex.needsUpdate = true;
    return tex;
}
function initRain() {
    _rainGeom = new THREE.BufferGeometry();
    // 2 verts per streak (head + tail) × 3 components = 6 floats per streak
    _rainPos = new Float32Array(RAIN_COUNT * 6);
    // Tilt the streak per wind so streaks aren't perfectly vertical (matches feel of Tribes 1)
    const tiltX = RAIN_WIND_X * 0.4;
    const tiltZ = RAIN_WIND_Z * 0.4;
    for (let i = 0; i < RAIN_COUNT; i++) {
        const x = (Math.random() - 0.5) * RAIN_SPREAD * 2;
        const y = (Math.random() - 0.5) * RAIN_HEIGHT + RAIN_HEIGHT * 0.5;
        const z = (Math.random() - 0.5) * RAIN_SPREAD * 2;
        const off = i * 6;
        // Head (top of streak)
        _rainPos[off    ] = x;
        _rainPos[off + 1] = y + RAIN_STREAK_LEN * 0.5;
        _rainPos[off + 2] = z;
        // Tail (bottom, slight wind-tilt offset)
        _rainPos[off + 3] = x + tiltX * RAIN_STREAK_LEN;
        _rainPos[off + 4] = y - RAIN_STREAK_LEN * 0.5;
        _rainPos[off + 5] = z + tiltZ * RAIN_STREAK_LEN;
    }
    _rainGeom.setAttribute('position', new THREE.BufferAttribute(_rainPos, 3));
    const mat = new THREE.LineBasicMaterial({
        // R32.10.1: photoreal rain. Near-white with a faint cool tint, low opacity
        // so streaks read as motion-blur water, not painted bars.
        color: 0xeaf0f4,
        transparent: true,
        opacity: 0.22,
        depthWrite: false,
        blending: THREE.NormalBlending,
        fog: true,
    });
    _rainSystem = new THREE.LineSegments(_rainGeom, mat);
    _rainSystem.frustumCulled = false;
    scene.add(_rainSystem);
}

function updateRain(dt, camPos) {
    if (!_rainSystem || !_rainPos) return;
    const fall = RAIN_SPEED * dt;
    const driftX = RAIN_WIND_X * dt * 10;
    const driftZ = RAIN_WIND_Z * dt * 10;
    const tiltX = RAIN_WIND_X * 0.4;
    const tiltZ = RAIN_WIND_Z * 0.4;
    for (let i = 0; i < RAIN_COUNT; i++) {
        const off = i * 6;
        // Move both endpoints (head + tail) together so the streak stays a streak.
        _rainPos[off    ] += driftX;
        _rainPos[off + 1] -= fall;
        _rainPos[off + 2] += driftZ;
        _rainPos[off + 3] += driftX;
        _rainPos[off + 4] -= fall;
        _rainPos[off + 5] += driftZ;
        // When the head exits the bottom of the volume, recycle the streak to top.
        if (_rainPos[off + 1] < camPos.y - RAIN_HEIGHT * 0.5) {
            const x = camPos.x + (Math.random() - 0.5) * RAIN_SPREAD * 2;
            const y = camPos.y + RAIN_HEIGHT * 0.5;
            const z = camPos.z + (Math.random() - 0.5) * RAIN_SPREAD * 2;
            _rainPos[off    ] = x;
            _rainPos[off + 1] = y + RAIN_STREAK_LEN * 0.5;
            _rainPos[off + 2] = z;
            _rainPos[off + 3] = x + tiltX * RAIN_STREAK_LEN;
            _rainPos[off + 4] = y - RAIN_STREAK_LEN * 0.5;
            _rainPos[off + 5] = z + tiltZ * RAIN_STREAK_LEN;
        }
    }
    _rainGeom.attributes.position.needsUpdate = true;
    _rainSystem.position.set(0, 0, 0); // world-space
}

function makeSoftCircleTexture() {
    const size = 64;
    const c = document.createElement('canvas');
    c.width = c.height = size;
    const ctx = c.getContext('2d');
    const grad = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    grad.addColorStop(0.0, 'rgba(255,255,255,1.0)');
    grad.addColorStop(0.4, 'rgba(255,255,255,0.6)');
    grad.addColorStop(1.0, 'rgba(255,255,255,0.0)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, size, size);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
}

function initParticles() {
    particleGeom = new THREE.BufferGeometry();
    particlePositions = new Float32Array(MAX_PARTICLES * 3);
    particleColors = new Float32Array(MAX_PARTICLES * 3);
    particleSizes = new Float32Array(MAX_PARTICLES);
    particleGeom.setAttribute('position', new THREE.BufferAttribute(particlePositions, 3));
    particleGeom.setAttribute('color', new THREE.BufferAttribute(particleColors, 3));
    particleGeom.setAttribute('size', new THREE.BufferAttribute(particleSizes, 1));

    const mat = new THREE.PointsMaterial({
        size: 0.6,
        map: makeSoftCircleTexture(),
        vertexColors: true,
        transparent: true,
        opacity: 0.95,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        sizeAttenuation: true,
        alphaTest: 0.01,
    });
    particleSystem = new THREE.Points(particleGeom, mat);
    particleSystem.frustumCulled = false;
    scene.add(particleSystem);
}

// ============================================================
// Post-processing
// ============================================================
function initPostProcessing() {
    const tier = readQualityFromSettings();
    console.log('[R32.82] initPostProcessing: tier.postProcess=' + tier.postProcess + ' quality=' + currentQuality);
    // R32.54 DIAGNOSTIC: ?nopost → skip EffectComposer entirely, render direct
    const _dp = new URLSearchParams(window.location.search);
    if (_dp.has('nopost')) {
        console.log('[R32.54-DIAG] nopost: EffectComposer disabled, direct render');
        composer = null;
        return;
    }
    if (!tier.postProcess) {
        console.log('[R32.82] initPostProcessing BAILED: tier.postProcess is falsy (' + tier.postProcess + ')');
        composer = null;
        return;
    }
    // R29.2 defensive: hard-fail with a clear message if init order regresses.
    // Without these guards, an undefined scene/camera passed to RenderPass causes
    // a cryptic `Cannot read properties of undefined (reading 'parent')` deep
    // inside three.module.js on every frame — we lost an hour to that exact
    // failure mode. Fail loud at init time instead.
    if (!scene)    throw new Error('[R29.2] initPostProcessing called before initScene()');
    if (!camera)   throw new Error('[R29.2] initPostProcessing called before initStateViews() — camera is undefined');
    if (!renderer) throw new Error('[R29.2] initPostProcessing called before initRenderer() — renderer is undefined');
    composer = new EffectComposer(renderer);
    composer.setPixelRatio(tier.pixelRatio);
    const renderPass = new RenderPass(scene, camera);
    composer.addPass(renderPass);
    // R32.23: selective-bloom-via-threshold (Visual Cohesion #2.7). Instead of
    // a heavy two-pass layer-masked bloom (which requires per-frame material
    // swaps across thousands of grass blades), we lift the HDR threshold so
    // only genuinely emissive surfaces (muzzle flash, jet flame, hit
    // indicators, lit panels) ever exceed it. Net result: bloom looks
    // selective without paying the perf cost of selective rendering.
    // Was: (res, 0.4 strength, 0.6 radius, 0.85 threshold)
    bloomPass = new UnrealBloomPass(new THREE.Vector2(window.innerWidth, window.innerHeight), 0.30, 0.45, 0.92);
    bloomPass.enabled = true;   // R32.81: night-adaptive bloom — driven by DayNight cycle
    composer.addPass(bloomPass);
    // R32.65.2: SMAA removed — smooth terrain + smooth normals make it unnecessary
    if (tier.postProcess === 'full') {
        gradePass = new ShaderPass(makeVignetteAndGradeShader());
        composer.addPass(gradePass);
    }
    composer.addPass(new OutputPass());
    console.log('[R32.81] Post-processing initialized: composer=' + !!composer + ' bloomPass=' + !!bloomPass + ' bloomEnabled=' + bloomPass.enabled + ' strength=' + bloomPass.strength);
    window.__tribesBloom = bloomPass;
    window.__tribesComposer = composer;
}

// R32.22: build a procedural cinematic 3D LUT (32^3) packed into a 1024x32
// horizontal strip texture. Cool-shadow / warm-highlight "modern war film"
// grade. Generated once at startup and bound as `tLUT` in the grade shader.
function _buildCinematicLUT(THREE) {
    const SIZE = 32;
    const W = SIZE * SIZE;     // 1024
    const H = SIZE;            // 32
    const data = new Uint8Array(W * H * 4);
    for (let bIdx = 0; bIdx < SIZE; bIdx++) {
        for (let gIdx = 0; gIdx < SIZE; gIdx++) {
            for (let rIdx = 0; rIdx < SIZE; rIdx++) {
                // Input color in [0,1].
                let r = rIdx / (SIZE - 1);
                let g = gIdx / (SIZE - 1);
                let b = bIdx / (SIZE - 1);
                const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
                // Cool shadows: lift blue in dark regions.
                const shadow = 1.0 - Math.min(1, luma * 2.5);
                b += 0.045 * shadow;
                r -= 0.012 * shadow;
                // Warm highlights: push red+green where bright.
                const highlight = Math.max(0, (luma - 0.6) / 0.4);
                r += 0.055 * highlight;
                g += 0.030 * highlight;
                b -= 0.020 * highlight;
                // Mild S-curve contrast (smoothstep-style).
                r = r * r * (3 - 2 * r);
                g = g * g * (3 - 2 * g);
                b = b * b * (3 - 2 * b);
                r = r * 0.92 + 0.04;
                g = g * 0.92 + 0.04;
                b = b * 0.92 + 0.04;
                // Light global desaturation toward cinematic neutral.
                const finalLuma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
                const desat = 0.08;
                r = r * (1 - desat) + finalLuma * desat;
                g = g * (1 - desat) + finalLuma * desat;
                b = b * (1 - desat) + finalLuma * desat;
                // Pack: x = rIdx + bIdx*SIZE, y = gIdx.
                const x = rIdx + bIdx * SIZE;
                const y = gIdx;
                const i = (y * W + x) * 4;
                data[i + 0] = Math.max(0, Math.min(255, Math.round(r * 255)));
                data[i + 1] = Math.max(0, Math.min(255, Math.round(g * 255)));
                data[i + 2] = Math.max(0, Math.min(255, Math.round(b * 255)));
                data[i + 3] = 255;
            }
        }
    }
    const tex = new THREE.DataTexture(data, W, H, THREE.RGBAFormat);
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.wrapS = THREE.ClampToEdgeWrapping;
    tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.generateMipmaps = false;
    tex.needsUpdate = true;
    return tex;
}

function makeVignetteAndGradeShader() {
    // R32.25.1 HOTFIX: reverted to safe pass-through grade. Previous R32.22-25
    // shader (LUT + tilt-shift + grain composition) caused a black framebuffer
    // on user's machine — likely shader compile failure or a sampler bind that
    // didn't survive ShaderPass init. This restores the pre-R32.22 R32.7 grade
    // shader (vignette + warm-shadow + desat + film grain), which was known
    // working. LUT + tilt-shift will return as a separate, opt-in module.
    return {
        uniforms: {
            tDiffuse: { value: null },
            vignetteIntensity: { value: 0.18 },
            warmth: { value: 0.06 },
            desaturation: { value: 0.10 },
            grain: { value: 0.012 },
            time: { value: 0.0 },
        },
        vertexShader: /* glsl */`
            varying vec2 vUv;
            void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
        `,
        fragmentShader: /* glsl */`
            uniform sampler2D tDiffuse;
            uniform float vignetteIntensity;
            uniform float warmth;
            uniform float desaturation;
            uniform float grain;
            uniform float time;
            varying vec2 vUv;

            float hash(vec2 p) {
                return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453);
            }

            void main(){
                vec4 c = texture2D(tDiffuse, vUv);

                float gray = dot(c.rgb, vec3(0.299, 0.587, 0.114));
                c.rgb = mix(c.rgb, vec3(gray), desaturation);
                float lum = (c.r + c.g + c.b) / 3.0;
                float shadowMask = 1.0 - smoothstep(0.0, 0.5, lum);
                c.r += warmth * shadowMask;
                c.b -= warmth * shadowMask;

                vec2 uv = vUv - 0.5;
                float v = 1.0 - dot(uv, uv) * vignetteIntensity * 4.0;
                c.rgb *= v;

                float n = hash(vUv * vec2(1920.0, 1080.0) + vec2(time, time * 1.7));
                c.rgb += (n - 0.5) * grain;

                gl_FragColor = c;
            }
        `,
    };
}

// ============================================================
// Camera + state views
// ============================================================

function initStateViews() {
    const buf = Module.HEAPF32.buffer;
    playerStride = Module._getPlayerStateStride();
    playerView = new Float32Array(buf, Module._getPlayerStatePtr(), MAX_PLAYERS * playerStride);
    projectileStride = Module._getProjectileStateStride();
    projectileView = new Float32Array(buf, Module._getProjectileStatePtr(), MAX_PROJECTILES * projectileStride);
    particleStride = Module._getParticleStateStride();
    particleView = new Float32Array(buf, Module._getParticleStatePtr(), MAX_PARTICLES * particleStride);
    flagStride = Module._getFlagStateStride();
    flagView = new Float32Array(buf, Module._getFlagStatePtr(), 2 * flagStride);

    const aspect = window.innerWidth / window.innerHeight;
    // R31.1: near=0.1 (was 0.5). Weapon viewmodel sits at z=-0.45 and was
    // getting clipped by the near plane. 0.1 allows it through without
    // significant depth-buffer precision loss at our 5000m far plane.
    // R32.0: far plane matches Raindance.MIS visible distance (450m)
    camera = new THREE.PerspectiveCamera(90, aspect, 0.1, 500);
    // R30.1: place camera high above the basin center so the FIRST FRAME
    // (before WASM spawns the player) shows the terrain + buildings + sky
    // rather than burying the camera at (0,0,0) under the ground.
    camera.position.set(0, 200, 0);
    camera.lookAt(-300, 30, -300);   // look toward the map basin center
    scene.add(camera);
    camera.add(weaponHand);

    // R32.25-manus: cohesion polish (camera breathing + mood bed)
    if (window.Cohesion && window.Cohesion.init) {
        try { window.Cohesion.init(THREE, camera); } catch (e) { console.warn('[R32.25] cohesion init failed', e); }
    }

    // R32.13-manus: combat FX module (muzzle flash, tracer, hit indicator).
    // Lazy-load and init on first frame so renderer.js doesn't take a hard
    // dep on the module — if the file's missing, FX silently no-op.
    import('./renderer_combat_fx.js').then(() => {
        if (window.CombatFX) {
            window.CombatFX.init(scene, camera, weaponHand, THREE);
        }
    }).catch(e => console.warn('[R32.13] CombatFX load failed:', e));

    // R32.17-manus: Tribes-style Command Map (press C to toggle)
    // R32.17-manus: Tribes-style Command Map (press C to toggle)
    // R32.44: removed duplicate import() — script tag in index.html already loads the IIFE.
    // Just init if it's available.
    if (window.CommandMap) {
        window.CommandMap.init({
            getHeightmap: () => ({ data: _htData, size: _htSize, scale: _htScale }),
            getPlayerView: () => ({
                view: playerView, stride: playerStride,
                count: playerView ? Math.floor(playerView.length / playerStride) : 0,
            }),
            getLocalIdx: () => Module._getLocalPlayerIdx(),
            getFlagView: () => ({ view: flagView, stride: flagStride }),
            getBuildings: () => buildingMeshes,
        });
    }

    // R30.2: position the sun BEFORE the player spawns. Previously the sun
    // was only positioned inside syncCamera, so until the player got a real
    // position the sun sat at (0,0,0) with target (0,0,0) — zero contribution
    // to PBR materials, which is why buildings looked flat-shaded.
    if (sunLight) {
        const cx = 0, cy = 200, cz = 0;
        sunLight.position.set(cx + sunPos.x * 800, cy + sunPos.y * 800, cz + sunPos.z * 800);
        sunLight.target.position.set(cx, cy - 50, cz);
        sunLight.target.updateMatrixWorld();
    }

    // R30.2: build the environment map AFTER renderer + sky are both ready
    buildEnvironmentFromSky();

    // R32.77: Minimap radar init
    if (window.Minimap) {
        window.Minimap.init({
            getPlayerView: () => ({
                view: playerView, stride: playerStride,
                count: playerView ? Math.floor(playerView.length / playerStride) : 0,
            }),
            getLocalIdx: () => Module._getLocalPlayerIdx(),
            getFlagView: () => ({ view: flagView, stride: flagStride }),
            getBuildings: () => buildingMeshes,
        });
    }

    console.log('[R18] State views: player(' + playerStride + ') proj(' + projectileStride +
                ') part(' + particleStride + ') flag(' + flagStride + ')');
}

// ============================================================
// Per-frame sync
// ============================================================
function syncPlayers(t) {
    const localIdx = Module._getLocalPlayerIdx();
    // R31.4: hoist 3P check outside loop — one WASM call per frame, not per player
    const is3P = (Module._getThirdPerson && Module._getThirdPerson()) ? true : false;
    const count = Module._getPlayerStateCount();
    const tier = QUALITY_TIERS[currentQuality];
    for (let i = 0; i < count; i++) {
        const o = i * playerStride;
        const visible = playerView[o + 18] > 0.5;
        const alive   = playerView[o + 13] > 0.5;
        const team    = playerView[o + 11] | 0;
        const armor   = playerView[o + 12] | 0;
        let mesh = playerMeshes[i];

        // Hot-swap mesh if armor type changed (rare)
        if (mesh.userData.armor !== armor) {
            rebuildPlayerMesh(i, armor);
            mesh = playerMeshes[i];
        }

        // R22: spawn-protection shield sphere — pulsing 0.5→1.0 alpha at 2Hz
        const spawnProt = playerView[o + 20];   // reserved[0] from R15 RenderPlayer struct
        const shield = shieldSpheres[i];
        if (shield) {
            if (alive && visible && spawnProt > 0.05) {
                shield.position.set(playerView[o], playerView[o+1] + 1.0, playerView[o+2]);
                const pulse = 0.5 + 0.5 * Math.sin(t * Math.PI * 4); // 2Hz pulse
                shield.material.opacity = 0.20 + 0.20 * pulse;
                shield.visible = true;
            } else {
                shield.visible = false;
            }
        }
        // R32.63.4: hide ALL non-local players (bots disabled)
        if (i !== localIdx) {
            mesh.visible = false;
            if (nameplateSprites[i]) nameplateSprites[i].visible = false;
            if (shield) shield.visible = false;
            continue;
        }
        // R31.4: in 1P, skip local player (no self-model). In 3P, fall through
        // and render local player like any bot — nameplate still suppressed.
        if (i === localIdx && !is3P) {
            mesh.visible = false;
            if (nameplateSprites[i]) nameplateSprites[i].visible = false;
            continue;
        }
        if (i === localIdx && is3P) {
            if (nameplateSprites[i]) nameplateSprites[i].visible = false;
            // fall through — position/rotation/animation handled below
        }
        mesh.visible = visible && alive;
        if (!mesh.visible) {
            if (nameplateSprites[i]) nameplateSprites[i].visible = false;
            continue;
        }

        mesh.position.set(playerView[o], playerView[o + 1], playerView[o + 2]);
        // R31: negate yaw to match Three.js convention (same fix as camera)
        mesh.rotation.set(0, -playerView[o + 4], 0, 'YXZ');
        // R32.5: torso pitch — lean the upper body to match aim direction so
        // remote players (and the local soldier in 3P) read as actually aiming
        // up/down. Clamped to ±60° so extreme pitches don't fold the model.
        if (mesh.userData && mesh.userData.torso) {
            const rawPitch = playerView[o + 3]; // radians
            const clamped = Math.max(-1.05, Math.min(1.05, rawPitch));
            // Soldier faces +Z when yaw=0; pitching up = leaning back = negative
            // X rotation on the torso group (right-hand rule).
            mesh.userData.torso.rotation.x = -clamped * 0.85;
        }

        // R20: nameplate above head, fade beyond 50m
        const camPos = camera.position;
        const dx = playerView[o] - camPos.x;
        const dz = playerView[o + 2] - camPos.z;
        const dist = Math.hypot(dx, dz);
        if (dist < 60) {
            const np = ensureNameplate(i, 'P' + i, team);
            np.position.set(playerView[o], playerView[o + 1] + 2.6, playerView[o + 2]);
            np.visible = true;
            // Fade alpha from 1.0 at 30m to 0 at 60m
            np.material.opacity = Math.max(0, Math.min(1, (60 - dist) / 30));
            // R23: speaking pulse — cyan tint when voice peer is speaking
            const speaking = window.__voice && window.__voice.speaking && window.__voice.speaking[i];
            if (speaking) {
                const pulse = 0.5 + 0.5 * Math.sin(t * Math.PI * 4); // 2Hz
                np.material.color.setRGB(0.6 + pulse * 0.4, 1.0, 1.0);
            } else {
                np.material.color.setRGB(1, 1, 1);
            }
        } else if (nameplateSprites[i]) {
            nameplateSprites[i].visible = false;
        }
        // R23: feed peer position to voice module for HRTF spatialization
        if (window.__voice && i !== localIdx) {
            // updatePeerPosition is exported on the imported module; access via window proxy
            // (network.js doesn't re-export voice; we access via global.)
            if (window.__voiceUpdatePeer) window.__voiceUpdatePeer(i, playerView[o], playerView[o+1], playerView[o+2]);
        }

        // Team color update — R23: respect color-blind mode override
        const cbColors = window.__teamColors;
        const teamHex = cbColors
            ? (team === 0 ? cbColors.red : (team === 1 ? cbColors.blue : TEAM_TINT_HEX[2]))
            : (TEAM_TINT_HEX[team] ?? TEAM_TINT_HEX[2]);
        if (_lastPlayerColors[i] !== teamHex) {
            mesh.userData.armorMat.color.setHex(teamHex);
            _lastPlayerColors[i] = teamHex;
        }

        // Procedural rig animation
        const jettingNow = playerView[o + 14] > 0.5;
        animatePlayer(mesh, playerView[o + 6], playerView[o + 8],
                      jettingNow, playerView[o + 15] > 0.5,
                      t, alive);
        // R32.7 — FOV punch on local player jet boost (rising edge)
        if (i === localIdx && polish) {
            polish.onJetBoost(jettingNow);
        }
        // R32.15 — viewmodel sway state for local player (drives weaponHand pose).
        if (i === localIdx) {
            _viewmodelSway.jetting = jettingNow;
            _viewmodelSway.skiing  = playerView[o + 15] > 0.5;
            _viewmodelSway.speed   = Math.hypot(playerView[o + 6], playerView[o + 8]);
        }
    }
}

// R32.15 — Viewmodel sway: weapon dips and jitters during jet boost; leans
// forward + idle-bobs during ski. State accumulator is updated by syncPlayers
// (which already reads jetting/skiing/speed) and applied each frame in the
// main render loop after camera position is set.
const _viewmodelSway = {
    jetting: false, skiing: false, speed: 0,
    // Animation state
    jetDip: 0,         // current downward push (rad on X), eased
    jetDipTarget: 0,
    skiLean: 0,        // current forward lean (rad on X), eased
    skiLeanTarget: 0,
    bobPhase: 0,       // continuous phase for ski bob + idle sway
    jetJitterPhase: 0, // independent phase for jet jitter
    // Cached base pose (captured once after weaponHand is created)
    base: null,
};

function _updateViewmodelSway(dt) {
    if (!weaponHand) return;
    if (!_viewmodelSway.base) {
        _viewmodelSway.base = {
            px: weaponHand.position.x, py: weaponHand.position.y, pz: weaponHand.position.z,
            rx: weaponHand.rotation.x, ry: weaponHand.rotation.y, rz: weaponHand.rotation.z,
        };
    }
    const b = _viewmodelSway.base;
    const s = _viewmodelSway;

    // Targets
    s.jetDipTarget = s.jetting ? 0.18 : 0;          // rad: dip muzzle ~10° down
    s.skiLeanTarget = s.skiing  ? -0.12 : 0;        // rad: lean fwd ~7° (negative tilts barrel up which reads as "chest forward")

    // Eased follow (~120ms time-constant)
    const k = Math.min(1, dt * 9);
    s.jetDip  += (s.jetDipTarget  - s.jetDip)  * k;
    s.skiLean += (s.skiLeanTarget - s.skiLean) * k;

    // Phase advance
    s.jetJitterPhase += dt * 38;                    // fast jitter
    s.bobPhase       += dt * (s.skiing ? 5.5 : 1.4);// ski bob faster than idle sway

    // Jet jitter: small high-freq shake on Y/X position, scaled by jetting amount
    const jetAmt = s.jetDip / 0.18;                 // 0..1 "how-jetting"
    const jitterY = Math.sin(s.jetJitterPhase) * 0.012 * jetAmt;
    const jitterX = Math.cos(s.jetJitterPhase * 1.3) * 0.008 * jetAmt;

    // Ski bob: gentle vertical oscillation while skiing or moving fast
    const skiAmt = s.skiing ? 1 : Math.min(1, s.speed / 30);
    const bobY = Math.sin(s.bobPhase) * 0.014 * skiAmt;
    const bobR = Math.sin(s.bobPhase * 0.5) * 0.022 * skiAmt; // gentle roll

    // Idle sway: slow figure-8 drift when stationary and not jetting
    const idleAmt = (1 - jetAmt) * (1 - skiAmt);
    const idleX = Math.sin(s.bobPhase * 0.8) * 0.006 * idleAmt;
    const idleY = Math.cos(s.bobPhase * 0.6) * 0.005 * idleAmt;

    // Apply
    weaponHand.position.x = b.px + jitterX + idleX;
    weaponHand.position.y = b.py + jitterY + bobY  + idleY - s.jetDip * 0.05;
    weaponHand.position.z = b.pz;
    weaponHand.rotation.x = b.rx + s.jetDip + s.skiLean;
    weaponHand.rotation.y = b.ry;
    weaponHand.rotation.z = b.rz + bobR;
}

function syncProjectiles() {
    const count = Module._getProjectileStateCount();
    for (let i = 0; i < MAX_PROJECTILES; i++) {
        const mesh = projectileMeshes[i];
        if (i >= count) { mesh.visible = false; continue; }
        const o = i * projectileStride;
        const alive = projectileView[o + 9] > 0.5;
        mesh.visible = alive;
        if (!alive) continue;
        mesh.position.set(projectileView[o], projectileView[o + 1], projectileView[o + 2]);
        const type = projectileView[o + 6] | 0;
        const color = PROJ_COLORS[type] ?? 0xFFFFFF;
        if (mesh.material.color.getHex() !== color) {
            mesh.material.color.setHex(color);
            mesh.material.emissive.setHex(color);
        }
    }
}

function syncFlags(t) {
    for (let i = 0; i < 2; i++) {
        const o = i * flagStride;
        const group = flagMeshes[i];
        const state = flagView[o + 4] | 0;
        group.position.set(flagView[o], flagView[o + 1], flagView[o + 2]);
        group.visible = true;
        group.children[1].rotation.y = t * 0.6;
        group.children[1].material.opacity = state === 0 ? 1.0 : 0.7;
        group.children[1].material.transparent = state !== 0;
    }
}

// R32.7 — track which particle slots have already triggered shockwave/shake
// so we don't fire a new shockwave every frame for the same explosion. The C++
// side fills age with a positive value once at spawn and decrements it per tick;
// we trigger when age was 0 last frame and is positive now.
let _r327PrevParticleAge = null;
function syncParticles() {
    const tier = QUALITY_TIERS[currentQuality];
    const cap = tier.particleCap;
    let activeCount = 0;
    if (!_r327PrevParticleAge) _r327PrevParticleAge = new Float32Array(MAX_PARTICLES);
    for (let i = 0; i < MAX_PARTICLES && activeCount < cap; i++) {
        const o = i * particleStride;
        const age = particleView[o + 7];
        // R32.7 explosion-spawn detection (rising edge on type=3)
        const prevAge = _r327PrevParticleAge[i];
        if (age > 0 && prevAge <= 0) {
            const ptype = particleView[o + 6] | 0;
            if (ptype === 3 && polish && Polish.spawnShockwave) {
                try {
                    const px = particleView[o], py = particleView[o + 1], pz = particleView[o + 2];
                    Polish.spawnShockwave(scene, new THREE.Vector3(px, py, pz), 1.0);
                    // R32.74: enhanced explosion fireball + sparks
                    triggerExplosion(px, py, pz, 1.0);
                    // R32.45: FOV punch when explosion is within 30m of camera
                    const dx = px - camera.position.x, dy = py - camera.position.y, dz = pz - camera.position.z;
                    if (dx * dx + dy * dy + dz * dz < 900) _fovPunchExtra = 2.5;
                } catch (e) {}
            }
        }
        _r327PrevParticleAge[i] = age;
        if (age <= 0) continue;
        const type = particleView[o + 6] | 0;
        // R32.62: skip rain/splash particles (types 1, 2) — Raindance mission
        // spawns these natively but rain was removed from the renderer
        if (type === 1 || type === 2) continue;
        const dst = activeCount * 3;
        particlePositions[dst]     = particleView[o];
        particlePositions[dst + 1] = particleView[o + 1];
        particlePositions[dst + 2] = particleView[o + 2];
        // Color by type (jet, ski, hit-spark, explosion, generic)
        let r, g, b, sz;
        if (type === 0) {        // jet flame: cyan-orange gradient by age
            const ageT = Math.min(1, age * 2);
            r = 1.0;
            g = 0.4 + ageT * 0.5;
            b = 0.05 + (1 - ageT) * 0.6;
            sz = 0.45;
        } else if (type === 3) { // explosion: bright orange-yellow
            r = 1.0; g = 0.55; b = 0.15;
            sz = 0.7;
        } else if (type === 4) { // spark / generic hit
            r = 1.0; g = 0.85; b = 0.4;
            sz = 0.30;
        } else {                 // generic / ski spray: muted
            r = 0.9; g = 0.85; b = 0.7;
            sz = 0.35;
        }
        particleColors[dst]     = r;
        particleColors[dst + 1] = g;
        particleColors[dst + 2] = b;
        particleSizes[activeCount] = Math.min(sz, age * sz);
        activeCount++;
    }
    particleGeom.setDrawRange(0, activeCount);
    particleGeom.attributes.position.needsUpdate = true;
    particleGeom.attributes.color.needsUpdate = true;
    particleGeom.attributes.size.needsUpdate = true;
}

// R32.16-manus: spectator/freecam orbit state. Activated while local player
// is dead; orbits the death position at altitude with a slow auto-yaw and
// a gentle pitch sway. Returns control to live-cam on respawn.
const _spec = {
    active: false,
    deathX: 0, deathY: 0, deathZ: 0,
    yaw: 0,           // current orbit yaw (rad)
    yawRate: 0.35,    // rad/sec
    radius: 14,       // m from death point
    height: 6,        // m above death point
    pitch: -0.20,     // look down ~11°
    fadeIn: 0,        // 0–1 fade for the overlay
};
function _enterSpectator(deathX, deathY, deathZ) {
    _spec.active = true;
    _spec.deathX = deathX; _spec.deathY = deathY; _spec.deathZ = deathZ;
    _spec.yaw = 0;
    _spec.fadeIn = 0;
    // Show "SPECTATING" HUD label + letterbox bars
    const el = document.getElementById('spec-label');
    if (el) el.classList.add('show');
    const bars = document.getElementById('spec-bars');
    if (bars) bars.classList.add('show');
    // Hide weapon viewmodel
    if (weaponHand) weaponHand.visible = false;
}
function _exitSpectator() {
    _spec.active = false;
    const el = document.getElementById('spec-label');
    if (el) el.classList.remove('show');
    const bars = document.getElementById('spec-bars');
    if (bars) bars.classList.remove('show');
}

function syncCamera() {
    const localIdx = Module._getLocalPlayerIdx();
    // R30.1: hard guard against invalid local player index. Without this,
    // playerView[-32] returns undefined, camera.position.set(undefined,...)
    // silently no-ops, and the camera stays at constructor default (0,0,0)
    // — which is BELOW the terrain (min Y ≈ 7) and therefore frustum-culls
    // EVERYTHING in the scene. That's why we saw '1 draw call, 1 tri'.
    if (!Number.isFinite(localIdx) || localIdx < 0 || localIdx >= MAX_PLAYERS) return;
    const o = localIdx * playerStride;
    const px = playerView[o], py = playerView[o + 1], pz = playerView[o + 2];
    const pitch = playerView[o + 3];
    const yaw   = playerView[o + 4];

    // R30.1: also guard against garbage / NaN / sub-terrain positions before
    // the WASM side has finished spawning the player. If position is invalid
    // or buried under the lowest terrain point, leave camera at its current
    // safe default (initialized to 0,100,0 above the basin).
    if (!Number.isFinite(px) || !Number.isFinite(py) || !Number.isFinite(pz)) return;
    if (px === 0 && py === 0 && pz === 0) return;     // unspawned local player

    // R32.16-manus: spectator/freecam while dead.
    const aliveLocal = playerView[o + 13] > 0.5;
    if (!aliveLocal) {
        if (!_spec.active) _enterSpectator(px, py, pz);
        // Advance yaw and recompute camera transform around captured death pos.
        const dt = 1 / 60;
        _spec.yaw += _spec.yawRate * dt;
        _spec.fadeIn = Math.min(1, _spec.fadeIn + dt * 1.6);
        const cx = _spec.deathX + Math.sin(_spec.yaw) * _spec.radius;
        const cz = _spec.deathZ + Math.cos(_spec.yaw) * _spec.radius;
        const cy = _spec.deathY + _spec.height + Math.sin(_spec.yaw * 0.4) * 0.6;
        camera.position.set(cx, cy, cz);
        // Look at the death point with a slight downward bias
        const dx = _spec.deathX - cx, dy = (_spec.deathY + 1.0) - cy, dz = _spec.deathZ - cz;
        const lookYaw   = Math.atan2(dx, -dz);  // Three.js convention
        const lookPitch = Math.atan2(dy, Math.hypot(dx, dz));
        camera.rotation.set(lookPitch, lookYaw, 0, 'YXZ');
        return;
    } else if (_spec.active) {
        _exitSpectator();
    }

    // R31: negate yaw. C++ forward = {sin(yaw), 0, -cos(yaw)}.
    // Three.js camera forward at rotation.y=θ = {-sin(θ), 0, -cos(θ)}.
    // Setting rotation.y = -yaw makes Three.js forward = {sin(yaw), 0, -cos(yaw)} ✓.
    camera.rotation.set(pitch, -yaw, 0, 'YXZ');

    // R31.7.1-manus: 3rd-person chase camera — Tribes Ascend reference is
    // a centered chase (no shoulder offset), camera follows aim. Hot-fix from
    // R31.7: enforce a HARD MIN distance (3.0m) so terrain pull-in never collapses
    // the camera into the player's head. Lift instead of pulling in.
    //
    //   - Centered chase (no shoulder offset)
    //   - Smooth 200ms lerp on V-toggle so view doesn't snap
    //   - Terrain collision: LIFT camera (don't shorten distance below 3.0m)
    //   - Exposes window._tribesAimPoint3P + feeds it to C++ for aim convergence
    const is3P = (Module._getThirdPerson && Module._getThirdPerson()) ? true : false;

    // Smooth toggle: animate from prev distance to target over ~200ms.
    if (typeof window._tribesCamDist !== 'number') {
        // module-scope state — initialize on first call
        window._tribesCamDist = is3P ? 2.5 : 0.0; // hot-snap on init so first frame is clean
        window._tribesCamHeight = is3P ? 1.0 : 1.7;
    }
    const targetDist = is3P ? 2.5 : 0.0;
    const targetHeight = is3P ? 1.0 : 1.7;
    // Frame-rate-independent lerp toward target (~200ms time constant)
    const lerpAlpha = 1.0 - Math.exp(-((1/60) / 0.05));
    window._tribesCamDist   += (targetDist   - window._tribesCamDist)   * lerpAlpha;
    window._tribesCamHeight += (targetHeight - window._tribesCamHeight) * lerpAlpha;
    // R31.7.1: snap to target when within 0.05 to kill long-tail lerp drift.
    if (Math.abs(targetDist   - window._tribesCamDist)   < 0.05) window._tribesCamDist   = targetDist;
    if (Math.abs(targetHeight - window._tribesCamHeight) < 0.05) window._tribesCamHeight = targetHeight;
    const camDist = window._tribesCamDist;
    const camH = window._tribesCamHeight;

    // R31.7.1: 3P threshold is 2.0 (not 0.05) — anything under 2m is effectively
    // 1P framing and would clip the player mesh. The lerp settles to 0 in 1P
    // and 4 in 3P, so the only time camDist is in [0.05, 2.0] is mid-toggle.
    if (camDist > 2.0) {
        // 3P: place camera behind player at full distance, then LIFT y if terrain
        // would clip. NEVER shorten the back-distance — that's what created the
        // head-clip bug in R31.7.
        const fwdX = Math.sin(yaw),  fwdZ = -Math.cos(yaw);
        let cx = px - fwdX * camDist;
        let cy = py + camH;
        let cz = pz - fwdZ * camDist;
        const terrH = sampleTerrainH(cx, cz);
        const minClearance = 0.6;
        if (cy < terrH + minClearance) {
            // Lift the camera straight up to clear terrain, keep distance fixed.
            cy = terrH + minClearance;
        }
        camera.position.set(cx, cy, cz);
    } else if (camDist > 0.05) {
        // Mid-toggle blend: linear ease between 1P head and 3P chase position.
        const t = camDist / 2.0;  // 0..1
        const fwdX = Math.sin(yaw),  fwdZ = -Math.cos(yaw);
        const cx = px - fwdX * camDist;
        const cz = pz - fwdZ * camDist;
        const cy = py + (1.7 * (1 - t) + camH * t);
        camera.position.set(cx, cy, cz);
    } else {
        // 1P
        camera.position.set(px, py + 1.7, pz);
    }

    // R31.7-manus: compute and expose world aim point under crosshair.
    // Camera-forward * 1000m, then ray-march against terrain to find first hit.
    // Available as window._tribesAimPoint3P for C++ aim-convergence readback.
    {
        const cf = _tmpVec.set(0, 0, -1).applyQuaternion(camera.quaternion);
        let hitX = camera.position.x + cf.x * 1000;
        let hitY = camera.position.y + cf.y * 1000;
        let hitZ = camera.position.z + cf.z * 1000;
        // Coarse ray-march against terrain heightfield (32 steps)
        for (let i = 1; i <= 32; i++) {
            const t = (i / 32) * 1000;
            const wx = camera.position.x + cf.x * t;
            const wy = camera.position.y + cf.y * t;
            const wz = camera.position.z + cf.z * t;
            const th = sampleTerrainH(wx, wz);
            if (wy <= th) {
                // Walk back one step and refine with binary search (4 iters)
                let lo = (i - 1) / 32 * 1000, hi = t;
                for (let j = 0; j < 4; j++) {
                    const m = (lo + hi) * 0.5;
                    const mx = camera.position.x + cf.x * m;
                    const my = camera.position.y + cf.y * m;
                    const mz = camera.position.z + cf.z * m;
                    if (my <= sampleTerrainH(mx, mz)) hi = m; else lo = m;
                }
                hitX = camera.position.x + cf.x * hi;
                hitY = camera.position.y + cf.y * hi;
                hitZ = camera.position.z + cf.z * hi;
                break;
            }
        }
        _aimPoint3P.x = hitX; _aimPoint3P.y = hitY; _aimPoint3P.z = hitZ;
        window._tribesAimPoint3P = _aimPoint3P;
    }

    // R31.7.1: weapon viewmodel — visible only in true 1P (camDist near 0).
    // Was 0.5 in R31.7 which left it visible for the first ~0.5m of 3P transition
    // then SUDDENLY hid it; users perceived this as "weapon disappeared".
    if (weaponHand) weaponHand.visible = (camDist < 0.3);

    // R31.7.1: feed the world aim-point we computed above into the C++ aim-
    // convergence override (Claude shipped C1 in commit 32b4b41 / R31.7).
    // Without this hookup, fireWeapon's `if(thirdPerson&&hasAimPoint3P)` branch
    // never triggers and 3P shots come out of camera-fwd instead of crosshair-fwd.
    if (is3P && Module._setLocalAimPoint3P && window._tribesAimPoint3P) {
        const p = window._tribesAimPoint3P;
        Module._setLocalAimPoint3P(p.x, p.y, p.z);
    }

    let fov = Module._getCameraFov();
    // R32.18-manus: apply ZoomFX multiplier (RMB hold + Z stepped zoom).
    // FOV multiplier is 1/effectiveZoom, so 2x zoom → 0.5x FOV. While zoom is
    // active or transitioning, use a tight threshold so smoothing reads.
    let zoomActive = false;
    if (window.ZoomFX) {
        fov = fov * window.ZoomFX.getFovMultiplier();
        zoomActive = window.ZoomFX.isActive();
    }
    // R32.45: apply FOV punch from nearby explosions, then decay back
    fov += _fovPunchExtra;
    if (_fovPunchExtra > 0.01) {
        const dt = _lastTickTime > 0 ? Math.min(0.1, performance.now() * 0.001 - _lastTickTime) : 1/60;
        _fovPunchExtra *= Math.max(0, 1 - dt * 5); // ~200ms decay
    } else {
        _fovPunchExtra = 0;
    }
    const fovThreshold = zoomActive || _fovPunchExtra > 0.01 ? 0.05 : 0.5;
    if (Math.abs(camera.fov - fov) > fovThreshold) {
        camera.fov = fov;
        camera.updateProjectionMatrix();
    }

    // Sun follows the camera so the (smaller) shadow frustum covers active area
    sunLight.position.set(px + sunPos.x * 800, py + sunPos.y * 800, pz + sunPos.z * 800);
    sunLight.target.position.set(px, py, pz);
    sunLight.target.updateMatrixWorld();

    // R32.50: Snap shadow camera to texel boundaries to prevent shadow swimming.
    // Without this, sub-texel shifts as the camera moves cause shadow edges to
    // flicker on every surface. We snap the light+target in world XZ to the
    // nearest shadow texel size.
    if (sunLight.shadow && sunLight.shadow.mapSize) {
        const shadowFrustumSize = 240; // s * 2, from shadow camera setup (R32.63.4)
        const texelSize = shadowFrustumSize / sunLight.shadow.mapSize.x;
        sunLight.position.x = Math.round(sunLight.position.x / texelSize) * texelSize;
        sunLight.position.z = Math.round(sunLight.position.z / texelSize) * texelSize;
        sunLight.target.position.x = Math.round(sunLight.target.position.x / texelSize) * texelSize;
        sunLight.target.position.z = Math.round(sunLight.target.position.z / texelSize) * texelSize;
        sunLight.target.updateMatrixWorld();
    }
}

// ============================================================
// R32.4 — canonical building animation (replaces R18 syncTurretBarrels which
// was a no-op since R32.3 buildings carry C++ type=0, not type=3). Now keyed
// off mesh.userData.canon.datablock so we drive plasma turret coil glow,
// rocket turret hub yaw, and pulse sensor dish rotation. Repair packs bob &
// pulse, flag stands respond to their team's flag-state via syncFlags hook.
// ============================================================
function syncCanonicalAnims(t) {
    // R32.6: read live flag state per team so flag stands can react when the
    // flag is taken (state=1=carried, 2=dropped). flagView is the Float32 view
    // into g_rFlags; team is at offset 3, state at offset 4.
    _flagStateByTeam[0] = 0; _flagStateByTeam[1] = 0; // R32.43: reset in-place (no alloc)
    if (flagView && flagStride) {
        for (let i = 0; i < 2; i++) {
            const fo = i * flagStride;
            const ft = flagView[fo + 3] | 0;
            const fs = flagView[fo + 4] | 0;
            if (ft === 0 || ft === 1) _flagStateByTeam[ft] = fs;
        }
    }

    // Buildings (turrets, sensors, generators)
    for (const b of buildingMeshes) {
        const canon = b.mesh.userData && b.mesh.userData.canon;
        if (!canon) continue;
        if (canon.datablock === 'plasmaTurret' && b.mesh.userData.barrel) {
            // Slow horizontal sweep + idle barrel sway so it reads as scanning
            b.mesh.rotation.y = Math.sin(t * 0.5 + b.mesh.position.x * 0.1) * 0.5;
        } else if (canon.datablock === 'rocketTurret') {
            // Rocket turret swings opposite phase from plasma so a side-by-side pair
            // looks coordinated rather than identical
            b.mesh.rotation.y = Math.cos(t * 0.4 + b.mesh.position.z * 0.07) * 0.4;
        } else if (canon.datablock === 'PulseSensor' && b.mesh.userData.dish) {
            // Continuous dish rotation around its support pole
            b.mesh.userData.dish.rotation.y = t * 0.9;
        } else if (canon.datablock === 'Generator' && b.mesh.userData.panels) {
            // R32.6: gentle emissive pulse on the team-color accent panels so a
            // running generator visibly hums. Phase keyed off team so two bases
            // don't look in lock-step.
            const teamPhase = (canon.team === 1) ? Math.PI : 0;
            const ipulse = 0.55 + 0.25 * Math.sin(t * 1.8 + teamPhase);
            for (const p of b.mesh.userData.panels) {
                if (p.material) p.material.emissiveIntensity = ipulse;
            }
        }
    }
    // Base accents (RepairPack bob, flag stand pulse, vehicle pad center)
    if (baseAccentsGroup) {
        for (const obj of baseAccentsGroup.children) {
            const ud = obj.userData || {};
            if (ud.kind === 'repairpack') {
                const phase = ud.phase || 0;
                obj.position.y = ud.baseY + Math.sin(t * 1.6 + phase) * 0.10;
                obj.rotation.y = t * 0.6 + phase;
            } else if (ud.kind === 'flagstand' && ud.disc) {
                // R32.6: react to live flag state — calm pulse at home, intense
                // alert pulse when flag is missing from base.
                const fstate = _flagStateByTeam[ud.team] || 0;
                let intensity;
                if (fstate === 0) {
                    intensity = 0.20 + 0.10 * (0.5 + 0.5 * Math.sin(t * 1.4 + ud.team * Math.PI));
                } else {
                    // ALERT: rapid pulse, much brighter
                    intensity = 0.60 + 0.40 * (0.5 + 0.5 * Math.sin(t * 5.0));
                }
                if (ud.disc.material) ud.disc.material.emissiveIntensity = intensity;
            } else if (ud.kind === 'vehiclepad' && ud.center) {
                // R32.6: subtle team-color glow on the pad's center disc so the
                // landing target is visible from the air.
                const teamPhase = (ud.team === 1) ? Math.PI : 0;
                const i = 0.30 + 0.15 * Math.sin(t * 1.0 + teamPhase);
                if (ud.center.material) ud.center.material.emissiveIntensity = i;
            }
        }
    }

    // R32.59: Wolf Sentinel emissive pulse — neon lines breathe in and out
    const wolfObj = scene.getObjectByName('WolfSentinel');
    if (wolfObj && wolfObj.userData.emissiveMats) {
        // Slow breathing pulse: 0.4 → 1.6 over ~3 seconds
        const pulse = 0.4 + 1.2 * (0.5 + 0.5 * Math.sin(t * 1.2));
        for (const m of wolfObj.userData.emissiveMats) {
            m.emissiveIntensity = pulse;
        }
    }
}
// Backward-compat alias for any caller still using the R18 name
const syncTurretBarrels = syncCanonicalAnims;

// ============================================================
// Quality apply (called from settings menu when graphics tier changes)
// ============================================================
function applyQuality(newQuality) {
    if (!QUALITY_TIERS[newQuality]) return;
    currentQuality = newQuality;
    const tier = QUALITY_TIERS[newQuality];
    renderer.setPixelRatio(tier.pixelRatio);
    renderer.shadowMap.enabled = tier.shadowMap > 0;
    sunLight.castShadow = tier.shadowMap > 0;
    if (tier.shadowMap > 0 && sunLight.shadow.mapSize.x !== tier.shadowMap) {
        sunLight.shadow.mapSize.set(tier.shadowMap, tier.shadowMap);
        // Force shadow map rebuild
        if (sunLight.shadow.map) { sunLight.shadow.map.dispose(); sunLight.shadow.map = null; }
    }
    // Rebuild post-processing chain
    initPostProcessing();
    onResize();
    console.log('[R18] Quality switched to ' + newQuality);
}

// ============================================================
// R32.43: extracted first-frame diagnostic dump (was inline in loop())
// ============================================================
function _runFirstFrameDiagnostic() {
    try {
        console.log('[R30.0] === SCENE DIAGNOSTIC DUMP (one-shot) ===');
        const counts = {};
        const lights = [];
        const orphans = [];
        scene.traverse(function(o){
            counts[o.type] = (counts[o.type] || 0) + 1;
            if (o.isLight) {
                lights.push({
                    type: o.type,
                    intensity: o.intensity,
                    color: o.color ? o.color.getHexString() : 'n/a',
                    position: o.position ? [o.position.x.toFixed(1), o.position.y.toFixed(1), o.position.z.toFixed(1)] : null,
                    castShadow: !!o.castShadow,
                });
            }
            if (!o.parent && o !== scene) orphans.push(o.type + '#' + o.uuid.slice(0,8));
        });
        console.log('[R30.0] scene types:', counts);
        console.log('[R30.0] lights:', lights);
        if (orphans.length) console.warn('[R30.0] ORPHAN nodes (no parent, not in scene):', orphans);

        console.log('[R30.0] scene root has ' + scene.children.length + ' immediate children:');
        scene.children.forEach(function(c, i){
            const bb = c.geometry && c.geometry.boundingBox;
            let bbStr = 'n/a';
            if (c.geometry) {
                if (!c.geometry.boundingBox) c.geometry.computeBoundingBox();
                if (c.geometry.boundingBox) {
                    const b = c.geometry.boundingBox;
                    bbStr = '[' + b.min.x.toFixed(0) + ',' + b.min.y.toFixed(0) + ',' + b.min.z.toFixed(0) + ' \u2192 ' + b.max.x.toFixed(0) + ',' + b.max.y.toFixed(0) + ',' + b.max.z.toFixed(0) + ']';
                }
            }
            let matInfo = 'no-material';
            if (c.material) {
                const m = Array.isArray(c.material) ? c.material[0] : c.material;
                matInfo = m.type + ' color=' + (m.color ? '#'+m.color.getHexString() : 'n/a') + ' map=' + (m.map ? 'yes' : 'no') + ' transparent=' + !!m.transparent + ' opacity=' + (m.opacity!==undefined ? m.opacity : 'n/a') + ' visible=' + m.visible;
            }
            let childCount = '';
            if (c.children && c.children.length) childCount = ' (+' + c.children.length + ' children)';
            console.log('  [' + i + '] ' + c.type + ' name="' + (c.name||'') + '" visible=' + c.visible + ' bbox=' + bbStr + ' mat=' + matInfo + childCount);
        });

        console.log('[R30.0] camera position:', [camera.position.x.toFixed(1), camera.position.y.toFixed(1), camera.position.z.toFixed(1)],
                    ' rotation:', [camera.rotation.x.toFixed(2), camera.rotation.y.toFixed(2), camera.rotation.z.toFixed(2)],
                    ' near=' + camera.near + ' far=' + camera.far + ' fov=' + camera.fov);

        const info = renderer.info;
        console.log('[R30.0] renderer.info: ' + info.render.calls + ' calls, ' + info.render.triangles + ' tris, ' + info.memory.geometries + ' geom, ' + info.memory.textures + ' tex, programs=' + info.programs.length);

        console.log('[R30.0] scene.background:', scene.background ? (scene.background.isColor ? '#'+scene.background.getHexString() : scene.background.type) : 'null',
                    ' scene.fog:', scene.fog ? scene.fog.type + ' density=' + (scene.fog.density!==undefined ? scene.fog.density : 'near='+scene.fog.near+' far='+scene.fog.far) : 'null');

        console.log('[R30.0] === END DIAGNOSTIC DUMP ===');
    } catch (e) {
        console.error('[R30.0] diagnostic dump threw:', e);
    }
    console.log('[R29] First Three.js frame submitted');
}

// ============================================================
// R32.72: Jet exhaust particles — lightweight GPU particle system
// ============================================================
const JET_MAX = 384;       // max particles (16 players × 2 nozzles × ~12 particles each)
const JET_LIFETIME = 0.35; // seconds
const JET_SPEED = 4.5;     // m/s downward drift

let _jetPoints = null;
let _jetPos, _jetAge, _jetVel, _jetAlpha;
let _jetNextSlot = 0;

function initJetExhaust() {
    _jetPos   = new Float32Array(JET_MAX * 3);
    _jetAge   = new Float32Array(JET_MAX);  // remaining life (0 = dead)
    _jetVel   = new Float32Array(JET_MAX * 3);
    _jetAlpha = new Float32Array(JET_MAX);

    // Move all dead particles far away so they don't render visibly
    for (let i = 0; i < JET_MAX; i++) {
        _jetPos[i * 3 + 1] = -9999;
        _jetAlpha[i] = 0;
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(_jetPos, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('aAlpha',   new THREE.Float32BufferAttribute(_jetAlpha, 1).setUsage(THREE.DynamicDrawUsage));

    const mat = new THREE.ShaderMaterial({
        uniforms: {},
        vertexShader: `
            attribute float aAlpha;
            varying float vAlpha;
            void main() {
                vAlpha = aAlpha;
                vec4 mv = modelViewMatrix * vec4(position, 1.0);
                gl_PointSize = aAlpha * 280.0 / max(1.0, -mv.z);
                gl_Position = projectionMatrix * mv;
            }
        `,
        fragmentShader: `
            varying float vAlpha;
            void main() {
                float r = length(gl_PointCoord - vec2(0.5));
                if (r > 0.5) discard;
                float soft = 1.0 - smoothstep(0.2, 0.5, r);
                // Hot core (white-yellow) → outer edge (orange)
                vec3 col = mix(vec3(1.0, 0.85, 0.4), vec3(1.0, 0.45, 0.1), r * 2.0);
                gl_FragColor = vec4(col, soft * vAlpha);
            }
        `,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
    });

    _jetPoints = new THREE.Points(geo, mat);
    _jetPoints.frustumCulled = false;
    _jetPoints.renderOrder = 100; // render after opaque
    scene.add(_jetPoints);
    console.log('[R32.72] Jet exhaust particles: pool=' + JET_MAX);
}

// ============================================================
// R32.73: Projectile trails — glowing particle trail behind each projectile
// ============================================================
const TRAIL_MAX = 512;       // max trail particles
const TRAIL_LIFETIME = 0.25; // seconds — short trail that fades fast
let _trailPoints = null;
let _trailPos, _trailAge, _trailAlpha, _trailColor;
let _trailNextSlot = 0;

function initProjectileTrails() {
    _trailPos   = new Float32Array(TRAIL_MAX * 3);
    _trailAge   = new Float32Array(TRAIL_MAX);
    _trailAlpha = new Float32Array(TRAIL_MAX);
    _trailColor = new Float32Array(TRAIL_MAX * 3); // per-particle RGB

    for (let i = 0; i < TRAIL_MAX; i++) {
        _trailPos[i * 3 + 1] = -9999;
        _trailAlpha[i] = 0;
        _trailColor[i * 3] = 1; _trailColor[i * 3 + 1] = 1; _trailColor[i * 3 + 2] = 1;
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(_trailPos, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('aAlpha',   new THREE.Float32BufferAttribute(_trailAlpha, 1).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('aColor',   new THREE.Float32BufferAttribute(_trailColor, 3).setUsage(THREE.DynamicDrawUsage));

    const mat = new THREE.ShaderMaterial({
        uniforms: {},
        vertexShader: `
            attribute float aAlpha;
            attribute vec3 aColor;
            varying float vAlpha;
            varying vec3 vColor;
            void main() {
                vAlpha = aAlpha;
                vColor = aColor;
                vec4 mv = modelViewMatrix * vec4(position, 1.0);
                gl_PointSize = aAlpha * 180.0 / max(1.0, -mv.z);
                gl_Position = projectionMatrix * mv;
            }
        `,
        fragmentShader: `
            varying float vAlpha;
            varying vec3 vColor;
            void main() {
                float r = length(gl_PointCoord - vec2(0.5));
                if (r > 0.5) discard;
                float soft = 1.0 - smoothstep(0.15, 0.5, r);
                gl_FragColor = vec4(vColor, soft * vAlpha);
            }
        `,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
    });

    _trailPoints = new THREE.Points(geo, mat);
    _trailPoints.frustumCulled = false;
    _trailPoints.renderOrder = 101;
    scene.add(_trailPoints);
    console.log('[R32.73] Projectile trails: pool=' + TRAIL_MAX);
}

// Color lookup matching PROJ_COLORS but as normalized RGB
const _TRAIL_RGB = [
    [1.0, 1.0, 1.0],   // 0 blaster (white)
    [1.0, 0.93, 0.25],  // 1 chaingun (yellow)
    [0.7, 0.85, 1.0],   // 2 disc (blueish white)
    [0.3, 0.5, 0.19],   // 3 grenade (green)
    [1.0, 0.38, 0.13],  // 4 plasma (orange)
    [1.0, 0.63, 0.25],  // 5 mortar (warm orange)
    [1.0, 0.25, 0.25],  // 6
    [0.5, 0.63, 1.0],   // 7
    [0.25, 1.0, 0.5],   // 8
];

function _trailEmit(wx, wy, wz, type) {
    for (let t = 0; t < 16; t++) {
        if (_trailAge[_trailNextSlot] <= 0) break;
        _trailNextSlot = (_trailNextSlot + 1) % TRAIL_MAX;
    }
    const i = _trailNextSlot;
    _trailPos[i*3]   = wx + (Math.random()-0.5)*0.05;
    _trailPos[i*3+1] = wy + (Math.random()-0.5)*0.05;
    _trailPos[i*3+2] = wz + (Math.random()-0.5)*0.05;
    _trailAge[i]     = TRAIL_LIFETIME;
    _trailAlpha[i]   = 0.8 + Math.random() * 0.2;
    const rgb = _TRAIL_RGB[type] || _TRAIL_RGB[0];
    _trailColor[i*3]   = rgb[0];
    _trailColor[i*3+1] = rgb[1];
    _trailColor[i*3+2] = rgb[2];
    _trailNextSlot = (_trailNextSlot + 1) % TRAIL_MAX;
}

function updateProjectileTrails(dt) {
    if (!_trailPoints || !projectileView) return;

    // Age existing trail particles
    for (let i = 0; i < TRAIL_MAX; i++) {
        if (_trailAge[i] <= 0) continue;
        _trailAge[i] -= dt;
        if (_trailAge[i] <= 0) {
            _trailAge[i] = 0;
            _trailPos[i*3+1] = -9999;
            _trailAlpha[i] = 0;
            continue;
        }
        // Smooth fade-out
        _trailAlpha[i] = (_trailAge[i] / TRAIL_LIFETIME);
    }

    // Emit trail particles at each active projectile
    const count = Module._getProjectileStateCount ? Module._getProjectileStateCount() : 0;
    for (let p = 0; p < count && p < MAX_PROJECTILES; p++) {
        const o = p * projectileStride;
        if (projectileView[o + 9] < 0.5) continue; // not alive
        const type = projectileView[o + 6] | 0;
        // Emit 1 trail particle per projectile per frame
        _trailEmit(projectileView[o], projectileView[o+1], projectileView[o+2], type);
    }

    _trailPoints.geometry.attributes.position.needsUpdate = true;
    _trailPoints.geometry.attributes.aAlpha.needsUpdate = true;
    _trailPoints.geometry.attributes.aColor.needsUpdate = true;
}

// ============================================================
// R32.75: Interior lighting — warm point lights inside buildings
// ============================================================
let _interiorLights = [];

function initInteriorLights() {
    // Scan buildingMeshes for stations and generators that need interior lighting
    const lightDefs = []; // { position, color, intensity, range, team }
    for (const b of buildingMeshes) {
        const canon = b.mesh.userData && b.mesh.userData.canon;
        if (!canon) continue;
        const db = canon.datablock;
        const pos = b.mesh.position;
        const teamIdx = canon.team != null ? canon.team : -1;
        // Generator: team-tinted warm light + slightly brighter (the heart of the base)
        if (db === 'Generator') {
            const color = teamIdx === 0 ? 0xFF9060 : (teamIdx === 1 ? 0x6090FF : 0xFFE0B0);
            lightDefs.push({ x: pos.x, y: pos.y + 3.0, z: pos.z, color, intensity: 1.4, range: 14, team: teamIdx, isGenerator: true });
        }
        // Inventory / Ammo / Command stations: warm interior light
        if (db === 'InventoryStation' || db === 'AmmoStation' || db === 'CommandStation') {
            lightDefs.push({ x: pos.x, y: pos.y + 2.5, z: pos.z, color: 0xFFE0B0, intensity: 0.9, range: 10, team: teamIdx });
        }
    }
    if (lightDefs.length === 0) {
        console.log('[R32.75] No buildings found for interior lighting');
        return;
    }
    for (const def of lightDefs) {
        const light = new THREE.PointLight(def.color, 0, def.range);
        light.position.set(def.x, def.y, def.z);
        light.castShadow = false; // performance: skip shadow casting for ambient interior lights
        light.decay = 2; // physically realistic falloff
        scene.add(light);
        _interiorLights.push({ light, baseIntensity: def.intensity, team: def.team, isGenerator: def.isGenerator || false });
    }
    console.log('[R32.75] Interior lights placed:', _interiorLights.length);
    // R32.76: Expose generator positions for proximity-based audio hum
    window.__generatorPositions = _interiorLights
        .filter(il => il.isGenerator)
        .map(il => ({ x: il.light.position.x, y: il.light.position.y, z: il.light.position.z }));
}

function updateInteriorLights() {
    if (_interiorLights.length === 0) return;
    // DayNight modulation: interiors glow brighter at dusk/night for contrast
    const dayMix = (typeof DayNight !== 'undefined') ? DayNight.dayMix : 1.0;
    // Night boost: lights go from 40% during full day to 100% at night
    const nightBoost = 0.4 + 0.6 * (1.0 - dayMix);
    for (const il of _interiorLights) {
        il.light.intensity = il.baseIntensity * nightBoost;
    }
    // R32.76: expose camera position for audio proximity hum
    if (camera) {
        window.__camX = camera.position.x;
        window.__camY = camera.position.y;
        window.__camZ = camera.position.z;
    }
}

// ============================================================
// R32.74: Enhanced explosion effects — fireball sphere + spark burst
// ============================================================
const EXPL_POOL = 8;
const EXPL_LIFETIME = 0.55;
const SPARKS_PER_EXPLOSION = 24;
const MAX_SPARKS = EXPL_POOL * SPARKS_PER_EXPLOSION;
let _explPool = null;     // [{mesh, active, age, intensity}]
let _sparkPoints = null;
let _sparkPos, _sparkVel, _sparkAge, _sparkAlpha;
let _sparkNextSlot = 0;

function initExplosionFX() {
    _explPool = [];
    for (let i = 0; i < EXPL_POOL; i++) {
        const geo = new THREE.SphereGeometry(1.0, 12, 8);
        const mat = new THREE.ShaderMaterial({
            uniforms: {
                uProgress: { value: 0.0 },
            },
            vertexShader: `
                varying vec3 vNormal;
                varying vec3 vViewDir;
                void main() {
                    vNormal = normalize(normalMatrix * normal);
                    vec4 mv = modelViewMatrix * vec4(position, 1.0);
                    vViewDir = normalize(-mv.xyz);
                    gl_Position = projectionMatrix * mv;
                }
            `,
            fragmentShader: `
                precision mediump float;
                uniform float uProgress;
                varying vec3 vNormal;
                varying vec3 vViewDir;
                void main() {
                    float t = clamp(uProgress, 0.0, 1.0);
                    float fresnel = pow(1.0 - abs(dot(vNormal, vViewDir)), 1.5);
                    vec3 coreColor = vec3(1.0, 0.95, 0.8);
                    vec3 outerColor = vec3(1.0, 0.4, 0.05);
                    vec3 col = mix(coreColor, outerColor, t);
                    float alpha = (1.0 - t * t) * (0.55 + 0.45 * fresnel);
                    gl_FragColor = vec4(col, alpha);
                }
            `,
            transparent: true,
            blending: THREE.AdditiveBlending,
            depthWrite: false,
            side: THREE.FrontSide,
        });
        const mesh = new THREE.Mesh(geo, mat);
        mesh.visible = false;
        mesh.frustumCulled = false;
        mesh.renderOrder = 95;
        scene.add(mesh);
        _explPool.push({ mesh, active: false, age: 0, intensity: 1.0 });
    }

    // Spark particle pool
    _sparkPos   = new Float32Array(MAX_SPARKS * 3);
    _sparkVel   = new Float32Array(MAX_SPARKS * 3);
    _sparkAge   = new Float32Array(MAX_SPARKS);
    _sparkAlpha = new Float32Array(MAX_SPARKS);
    for (let i = 0; i < MAX_SPARKS; i++) {
        _sparkPos[i * 3 + 1] = -9999;
        _sparkAlpha[i] = 0;
    }

    const sGeo = new THREE.BufferGeometry();
    sGeo.setAttribute('position', new THREE.Float32BufferAttribute(_sparkPos, 3).setUsage(THREE.DynamicDrawUsage));
    sGeo.setAttribute('aAlpha',   new THREE.Float32BufferAttribute(_sparkAlpha, 1).setUsage(THREE.DynamicDrawUsage));

    const sMat = new THREE.ShaderMaterial({
        vertexShader: `
            attribute float aAlpha;
            varying float vAlpha;
            void main() {
                vAlpha = aAlpha;
                vec4 mv = modelViewMatrix * vec4(position, 1.0);
                gl_PointSize = aAlpha * 180.0 / max(1.0, -mv.z);
                gl_Position = projectionMatrix * mv;
            }
        `,
        fragmentShader: `
            varying float vAlpha;
            void main() {
                float r = length(gl_PointCoord - vec2(0.5));
                if (r > 0.5) discard;
                float soft = 1.0 - smoothstep(0.15, 0.5, r);
                vec3 col = mix(vec3(1.0, 0.7, 0.2), vec3(1.0, 0.95, 0.8), soft);
                gl_FragColor = vec4(col, soft * vAlpha);
            }
        `,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
    });

    _sparkPoints = new THREE.Points(sGeo, sMat);
    _sparkPoints.frustumCulled = false;
    _sparkPoints.renderOrder = 96;
    scene.add(_sparkPoints);
    console.log('[R32.74] Explosion FX: fireballs=' + EXPL_POOL + ' sparks=' + MAX_SPARKS);
}

function triggerExplosion(px, py, pz, intensity) {
    if (!_explPool) return;
    // Find free fireball slot (or steal oldest)
    let slot = null;
    for (let i = 0; i < _explPool.length; i++) {
        if (!_explPool[i].active) { slot = _explPool[i]; break; }
    }
    if (!slot) {
        let oldest = 0;
        for (let i = 1; i < _explPool.length; i++) {
            if (_explPool[i].age > _explPool[oldest].age) oldest = i;
        }
        slot = _explPool[oldest];
    }
    slot.active = true;
    slot.age = 0;
    slot.intensity = intensity;
    slot.mesh.position.set(px, py, pz);
    slot.mesh.scale.setScalar(0.3);
    slot.mesh.visible = true;

    // Emit sparks
    const sparkCount = Math.round(SPARKS_PER_EXPLOSION * Math.min(1.5, intensity));
    for (let s = 0; s < sparkCount; s++) {
        for (let t = 0; t < 8; t++) {
            if (_sparkAge[_sparkNextSlot] <= 0) break;
            _sparkNextSlot = (_sparkNextSlot + 1) % MAX_SPARKS;
        }
        const i = _sparkNextSlot;
        _sparkPos[i*3]   = px + (Math.random() - 0.5) * 0.5;
        _sparkPos[i*3+1] = py + (Math.random() - 0.5) * 0.5;
        _sparkPos[i*3+2] = pz + (Math.random() - 0.5) * 0.5;
        const speed = (3.0 + Math.random() * 8.0) * intensity;
        const theta = Math.random() * Math.PI * 2;
        const phi   = Math.random() * Math.PI * 0.8;
        _sparkVel[i*3]   = Math.sin(phi) * Math.cos(theta) * speed;
        _sparkVel[i*3+1] = Math.cos(phi) * speed * 0.7 + 2.0;
        _sparkVel[i*3+2] = Math.sin(phi) * Math.sin(theta) * speed;
        _sparkAge[i]   = 0.4 + Math.random() * 0.35;
        _sparkAlpha[i] = 0.8 + Math.random() * 0.2;
        _sparkNextSlot = (_sparkNextSlot + 1) % MAX_SPARKS;
    }
}

function updateExplosionFX(dt) {
    if (!_explPool) return;
    // Update fireballs
    for (let i = 0; i < _explPool.length; i++) {
        const ex = _explPool[i];
        if (!ex.active) continue;
        ex.age += dt;
        if (ex.age >= EXPL_LIFETIME) {
            ex.active = false;
            ex.mesh.visible = false;
            continue;
        }
        const t = ex.age / EXPL_LIFETIME;
        const radius = (0.5 + 3.5 * (1 - (1 - t) * (1 - t))) * ex.intensity;
        ex.mesh.scale.setScalar(radius);
        ex.mesh.material.uniforms.uProgress.value = t;
    }
    // Update sparks
    if (!_sparkPoints) return;
    for (let i = 0; i < MAX_SPARKS; i++) {
        if (_sparkAge[i] <= 0) continue;
        _sparkAge[i] -= dt;
        if (_sparkAge[i] <= 0) {
            _sparkAge[i] = 0;
            _sparkPos[i*3+1] = -9999;
            _sparkAlpha[i] = 0;
            continue;
        }
        _sparkPos[i*3]   += _sparkVel[i*3]   * dt;
        _sparkPos[i*3+1] += _sparkVel[i*3+1] * dt;
        _sparkPos[i*3+2] += _sparkVel[i*3+2] * dt;
        _sparkVel[i*3+1] -= 12.0 * dt; // gravity
        _sparkVel[i*3]   *= 0.98;
        _sparkVel[i*3+2] *= 0.98;
        const life = _sparkAge[i] / 0.55;
        _sparkAlpha[i] = life > 0.4 ? 0.9 : 0.9 * (life / 0.4);
    }
    _sparkPoints.geometry.attributes.position.needsUpdate = true;
    _sparkPoints.geometry.attributes.aAlpha.needsUpdate = true;
}

// ============================================================
// R32.86: Sky fairy particles — GPU-driven, world-anchored, terrain-aware
// ============================================================
const NIGHT_FAIRY_COUNT = 44800;
const NIGHT_FAIRY_RADIUS = 400;
const NIGHT_FAIRY_ALT_ABOVE = 2;    // min metres above terrain (touching ground)
const NIGHT_FAIRY_ALT_RANGE = 90;   // additional random altitude spread
let _nfPoints = null;
let _nfOpacity = 0;
let _nfHeightTex = null;

function initNightFairies() {
    const N = NIGHT_FAIRY_COUNT;
    const R = NIGHT_FAIRY_RADIUS;
    const positions = new Float32Array(N * 3);
    const params    = new Float32Array(N * 4);
    const colors    = new Float32Array(N * 3);

    // Distribute in a SQUARE tile (not circular) so toroidal wrap tiles seamlessly
    for (let i = 0; i < N; i++) {
        positions[i*3]   = (Math.random() - 0.5) * R * 2;     // square tile X [-R, R]
        positions[i*3+1] = NIGHT_FAIRY_ALT_ABOVE + Math.random() * NIGHT_FAIRY_ALT_RANGE;
        positions[i*3+2] = (Math.random() - 0.5) * R * 2;     // square tile Z [-R, R]
        params[i*4]   = Math.random() * Math.PI * 2;          // phase
        params[i*4+1] = 0.2 + Math.random() * 0.6;           // speed
        params[i*4+2] = Math.random() * Math.PI * 2;          // drift angle
        params[i*4+3] = Math.random();                         // hue
        const hue = params[i*4+3];
        const h6 = hue * 6;
        const f = h6 - Math.floor(h6);
        const sector = Math.floor(h6) % 6;
        let r = 1, g = 1, b = 1;
        if      (sector === 0) { g = f;     b = 0; }
        else if (sector === 1) { r = 1 - f; b = 0; }
        else if (sector === 2) { r = 0;     b = f; }
        else if (sector === 3) { r = 0;     g = 1 - f; }
        else if (sector === 4) { r = f;     g = 0; }
        else                   { b = 1 - f; g = 0; }
        colors[i*3]   = 0.6 + 0.4 * r;
        colors[i*3+1] = 0.6 + 0.4 * g;
        colors[i*3+2] = 0.6 + 0.4 * b;
    }

    // Upload heightmap as a float texture for GPU terrain sampling
    _nfHeightTex = _createHeightmapTexture();

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo.setAttribute('aParams',  new THREE.Float32BufferAttribute(params, 4));
    geo.setAttribute('aColor',   new THREE.Float32BufferAttribute(colors, 3));

    const htSize = _htSize || 256;
    const htScale = _htScale || 1;
    const htHalf = (htSize - 1) * htScale * 0.5;

    const mat = new THREE.ShaderMaterial({
        uniforms: {
            uTime:      { value: 0 },
            uCamPos:    { value: new THREE.Vector3() },
            uRadius:    { value: R },
            uOpacity:   { value: 1.0 },
            uHeightmap: { value: _nfHeightTex },
            uHtSize:    { value: htSize },
            uHtScale:   { value: htScale },
            uHtHalf:    { value: htHalf },
        },
        vertexShader: `
            attribute vec4 aParams;
            attribute vec3 aColor;
            uniform float uTime;
            uniform vec3 uCamPos;
            uniform float uRadius;
            uniform float uOpacity;
            uniform sampler2D uHeightmap;
            uniform float uHtSize;
            uniform float uHtScale;
            uniform float uHtHalf;
            varying float vAlpha;
            varying vec3 vColor;

            float sampleTerrain(float wx, float wz) {
                float gx = (wx + uHtHalf) / uHtScale;
                float gz = (wz + uHtHalf) / uHtScale;
                vec2 uv = vec2(gx, gz) / uHtSize;
                return texture2D(uHeightmap, uv).r;
            }

            void main() {
                float phase = aParams.x;
                float speed = aParams.y;
                float driftAngle = aParams.z;

                // World-space position: tile offset + slow drift (NOT camera-relative)
                float wx = position.x + cos(driftAngle) * speed * uTime * 0.3;
                float wz = position.z + sin(driftAngle) * speed * uTime * 0.3;

                // Toroidal wrap relative to camera (keeps particles near player)
                float dx = wx - uCamPos.x;
                float dz = wz - uCamPos.z;
                float diameter = uRadius * 2.0;
                dx = dx - diameter * floor((dx + uRadius) / diameter);
                dz = dz - diameter * floor((dz + uRadius) / diameter);
                wx = uCamPos.x + dx;
                wz = uCamPos.z + dz;

                // Sample terrain height at this world XZ, add altitude above it
                float terrainH = sampleTerrain(wx, wz);
                float wy = terrainH + position.y + sin(uTime * 0.4 + phase) * 3.0;

                // Twinkle (no edge fade needed — square tile wraps seamlessly)
                float pulse = 0.4 + 0.6 * sin(uTime * 0.8 + phase * 3.0);

                vAlpha = uOpacity * pulse;
                vColor = aColor;

                vec4 mv = viewMatrix * vec4(wx, wy, wz, 1.0);
                float dist = max(2.0, length(mv.xyz));
                gl_PointSize = clamp(vAlpha * 500.0 / dist, 1.5, 12.0);
                gl_Position = projectionMatrix * mv;
            }
        `,
        fragmentShader: `
            precision mediump float;
            varying float vAlpha;
            varying vec3 vColor;
            void main() {
                float r = length(gl_PointCoord - vec2(0.5));
                if (r > 0.5) discard;
                float soft = 1.0 - smoothstep(0.05, 0.5, r);
                gl_FragColor = vec4(vColor, soft * vAlpha * 0.9);
            }
        `,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
    });

    _nfPoints = new THREE.Points(geo, mat);
    _nfPoints.frustumCulled = false;
    _nfPoints.renderOrder = 85;
    _nfPoints.visible = true;
    scene.add(_nfPoints);
    console.log('[R32.86] Sky fairies (GPU, world-anchored): N=' + N + ' R=' + R + 'm terrain-aware');
}

function _createHeightmapTexture() {
    if (!_htData || _htSize < 2) {
        // Fallback: flat terrain at y=0
        const d = new Float32Array(4);
        const tex = new THREE.DataTexture(d, 2, 2, THREE.RedFormat, THREE.FloatType);
        tex.needsUpdate = true;
        return tex;
    }
    const tex = new THREE.DataTexture(_htData, _htSize, _htSize, THREE.RedFormat, THREE.FloatType);
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.wrapS = THREE.ClampToEdgeWrapping;
    tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.needsUpdate = true;
    console.log('[R32.86] Heightmap texture uploaded: ' + _htSize + 'x' + _htSize);
    return tex;
}

function updateNightFairies(dt, t) {
    if (!_nfPoints) return;
    _nfOpacity = 1.0;
    _nfPoints.visible = true;
    const u = _nfPoints.material.uniforms;
    u.uTime.value = t;
    u.uCamPos.value.copy(camera.position);
    u.uOpacity.value = _nfOpacity;
}

function _jetEmit(wx, wy, wz, vx, vy, vz) {
    // Circular scan for dead slot
    for (let t = 0; t < 16; t++) {
        if (_jetAge[_jetNextSlot] <= 0) break;
        _jetNextSlot = (_jetNextSlot + 1) % JET_MAX;
    }
    const i = _jetNextSlot;
    _jetPos[i*3]   = wx;
    _jetPos[i*3+1] = wy;
    _jetPos[i*3+2] = wz;
    _jetVel[i*3]   = vx;
    _jetVel[i*3+1] = vy;
    _jetVel[i*3+2] = vz;
    _jetAge[i]     = JET_LIFETIME;
    _jetAlpha[i]   = 0.85 + Math.random() * 0.15;
    _jetNextSlot   = (_jetNextSlot + 1) % JET_MAX;
}

function updateJetExhaust(dt) {
    if (!_jetPoints || !playerView) return;

    // Age + move existing particles
    for (let i = 0; i < JET_MAX; i++) {
        if (_jetAge[i] <= 0) continue;
        _jetAge[i] -= dt;
        if (_jetAge[i] <= 0) {
            _jetAge[i] = 0;
            _jetPos[i*3+1] = -9999; // hide
            _jetAlpha[i] = 0;
            continue;
        }
        _jetPos[i*3]   += _jetVel[i*3]   * dt;
        _jetPos[i*3+1] += _jetVel[i*3+1] * dt;
        _jetPos[i*3+2] += _jetVel[i*3+2] * dt;
        // Decelerate slightly (air drag)
        _jetVel[i*3]   *= 0.97;
        _jetVel[i*3+1] *= 0.97;
        _jetVel[i*3+2] *= 0.97;
        // Fade: full opacity first 30%, then linear fade
        const life = _jetAge[i] / JET_LIFETIME;
        _jetAlpha[i] = life < 0.7 ? life / 0.7 : 1.0;
    }

    // Emit from jetting players
    for (let p = 0; p < MAX_PLAYERS; p++) {
        const o = p * playerStride;
        if (playerView[o + 18] < 0.5) continue; // not visible
        if (playerView[o + 13] < 0.5) continue; // not alive
        if (playerView[o + 14] < 0.5) continue; // not jetting
        const px = playerView[o], py = playerView[o+1], pz = playerView[o+2];
        const yaw = -playerView[o + 4];
        const cy = Math.cos(yaw), sy = Math.sin(yaw);

        // Two thruster nozzles (offset behind + below player center)
        const nozzles = [[-0.16, 0.70, -0.50], [0.16, 0.70, -0.50]];
        for (const [lx, ly, lz] of nozzles) {
            const wx = px + lx * cy - lz * sy;
            const wy = py + ly;
            const wz = pz + lx * sy + lz * cy;
            // Emit 2 particles per nozzle per frame
            for (let e = 0; e < 2; e++) {
                const spread = 0.4;
                _jetEmit(
                    wx + (Math.random()-0.5)*0.06,
                    wy + (Math.random()-0.5)*0.06,
                    wz + (Math.random()-0.5)*0.06,
                    (Math.random()-0.5)*spread,
                    -JET_SPEED + (Math.random()-0.5)*0.8,
                    (Math.random()-0.5)*spread
                );
            }
        }
    }

    // Upload to GPU
    _jetPoints.geometry.attributes.position.needsUpdate = true;
    _jetPoints.geometry.attributes.aAlpha.needsUpdate = true;
}

// ============================================================
// Render loop
// ============================================================
function loop() {
    if (!Module._isReady || !Module._isReady()) {
        requestAnimationFrame(loop);
        return;
    }
    const t = performance.now() * 0.001;
    Module._tick();
    // R32.104: Rapier collision resolution — runs after WASM tick() which has already
    // computed velocity, applied gravity/skiing/jetting, and done pos += vel*dt + terrain clamp.
    // Rapier resolves building/interior collisions and writes corrected pos back to WASM.
    try {
        if (window.RapierPhysics && playerView && playerStride) {
            const localIdx = Module._getLocalPlayerIdx();
            if (localIdx >= 0) {
                const rapierResult = window.RapierPhysics.stepPlayerCollision(
                    playerView, playerStride, localIdx, 1/60
                );
                // R32.130: expose grounded state for character grounding
                window._rapierGrounded = rapierResult.grounded;
                // Signal grounded-on-interior state back to WASM for next frame's onGround
                if (Module._setRapierGrounded) {
                    Module._setRapierGrounded(rapierResult.grounded ? 1 : 0);
                }
            }
        }
    } catch (e) { /* keep loop alive — collision failure shouldn't crash render */ }
    // R32.40-manus: Day/Night cycle tick — mutates sunPos, sun/hemi colors,
    // fog, exposure, env intensity. Cheap (a few math ops + Color.lerp).
    try { DayNight.update(); } catch(e) { /* keep loop alive */ }
    // R32.81: night-adaptive bloom — off during day, ramps up at dusk, full at night
    try {
        const dm = (typeof DayNight !== 'undefined') ? DayNight.dayMix : 1.0;
        if (bloomPass) {
            // dayMix: 1=noon, 0=midnight. Bloom activates below 0.5 (dusk)
            const nightBloom = dm < 0.15 ? 1.0 : (dm > 0.5 ? 0.0 : (0.5 - dm) / 0.35);
            bloomPass.enabled = nightBloom > 0.01;
            bloomPass.strength = 0.55 * nightBloom;   // max 0.55 at full night
            bloomPass.threshold = 0.92 - 0.15 * nightBloom; // lower threshold at night → more glow
        }
    } catch(e) { /* keep loop alive */ }
    try { updateCustomSky(t, DayNight.dayMix, DayNight.sunDir, camera.position); } catch(e) { /* keep loop alive */ }
    syncPlayers(t);
    // R32.109: Rigged GLB character sync — overlays Mixamo-rigged models on
    // top of procedural player meshes for local 3P + demo character.
    try { Characters.sync(t, playerView, playerStride, Module._getLocalPlayerIdx(), playerMeshes); } catch(e) { /* keep loop alive */ }
    syncProjectiles();
    syncFlags(t);
    syncParticles();
    syncTurretBarrels(t);
    syncCamera();
    updateRain(1 / 60, camera.position); // R32.0 rain tick
    try { updateJetExhaust(1/60); } catch (e) { /* cosmetic — keep loop alive */ }
    try { updateProjectileTrails(1/60); } catch (e) { /* cosmetic — keep loop alive */ }
    try { updateExplosionFX(1/60); } catch (e) { /* cosmetic — keep loop alive */ }
    try { updateNightFairies(1/60, t); } catch (e) { console.error('[R32.84] sky fairy error:', e); }
    try { updateInteriorLights(); } catch (e) { /* cosmetic — keep loop alive */ }

    // R32.7 — polish tick (lightning, shake, FOV punch, splashes, smoke, HUD)
    if (polish) {
        const now = t; // R32.43: reuse t from loop() top — same performance.now()*0.001
        const dt = _lastTickTime > 0 ? Math.min(0.1, now - _lastTickTime) : 1/60;
        _lastTickTime = now;
        polish.tick(dt, t);
        // R32.13-manus: combat FX tick (muzzle flash decay, tracer fade)
        if (window.CombatFX && window.CombatFX.update) window.CombatFX.update(dt);
        // R32.15-manus: viewmodel sway (jet dip+jitter, ski lean+bob, idle drift)
        _updateViewmodelSway(dt);
        // R32.17-manus: command map full-screen tactical overlay (toggled with C)
        if (window.CommandMap && window.CommandMap.update) window.CommandMap.update();
        // R32.77: Minimap radar per-frame update
        if (window.Minimap && window.Minimap.update) window.Minimap.update();
    }

    // R32.22: tick gradePass time uniform so the cinematic film grain animates.
    if (gradePass && gradePass.material && gradePass.material.uniforms && gradePass.material.uniforms.time) {
        gradePass.material.uniforms.time.value = (gradePass.material.uniforms.time.value + 0.05) % 10000.0;
    }

    // R32.25: cohesion tick (sub-perceptual camera breathing).
    if (window.Cohesion && window.Cohesion.tick) window.Cohesion.tick();

    // R32.32.1-manus: tick the camera-local grass ring (wind + recycle).
    // The old terrain-fuzz uTime tick from R32.32 is gone (fuzz removed),
    // but the ring uses the SAME unified clock for its wind shader so the
    // motion of every grass element stays in lock-step (Principle 2).
    try { updateGrassRing(t); } catch (e) { /* swallowed; ring is cosmetic */ }

    // R32.35-manus: tick the dust layer (vertex shader does motion; CPU does
    // amortized recycle when camera moves).
    try { updateDustLayer(t); } catch (e) { /* swallowed; dust is cosmetic */ }

    // R32.34-manus: tick the LIVING TERRAIN ambient-breath uniforms.
    // The terrain shader's uTime drives all 3 breath components (wind drift,
    // micro-shimmer, sun-spot drift). Pre-R32.34 this uniform was declared
    // but never updated, so the ambient layer is dormant until ticked here.
    if (terrainMesh && terrainMesh.material && terrainMesh.material.userData && terrainMesh.material.userData.shader) {
        const u = terrainMesh.material.userData.shader.uniforms;
        if (u && u.uTime) u.uTime.value = t;
    }

    if (composer) composer.render();
    else renderer.render(scene, camera);

    // R30.0 / R32.43: one-shot diagnostic dump, extracted to separate function
    if (!_r30Diagnosed) { _r30Diagnosed = true; _runFirstFrameDiagnostic(); }

    _frameCount++;
    const now = performance.now();
    if (now - _lastDiagTime > 5000) {
        if (window.DEBUG_LOGS) {
            const fps = Math.round(_frameCount / ((now - _lastDiagTime) / 1000));
            const info = renderer.info.render;
            // R30.1: include camera position + visible-soldier count + local player
            // idx in the per-5-sec FPS report so we can correlate '1 draw call'
            // symptoms with camera placement and player spawn state.
            const cp = camera.position;
            const li = (typeof Module !== 'undefined' && Module.calledRun) ? Module._getLocalPlayerIdx() : -2;
            let visSold = 0;
            for (let i = 0; i < playerMeshes.length; i++) if (playerMeshes[i] && playerMeshes[i].visible) visSold++;
            // R31: renderer.info only counts the LAST composer pass when EffectComposer
            // is active. Sum across all passes by temporarily disabling composer to
            // get true call count, then re-enable. Or just note that calls ≤ 2 with
            // composer active is likely an artifact — the real geometry draw calls
            // happen in the RenderPass before bloom/output compositing.
            const composerActive = !!composer;
            const callsNote = composerActive ? ' (+ composer bloom passes not counted; geometry draws in RenderPass)' : '';
            console.log('[R18] ' + fps + 'fps, ' + info.calls + ' draw calls' + callsNote + ', ' + info.triangles + ' tris, quality=' + currentQuality
                        + ' | cam=(' + cp.x.toFixed(0) + ',' + cp.y.toFixed(0) + ',' + cp.z.toFixed(0) + ')'
                        + ' localIdx=' + li + ' visSoldiers=' + visSold + '/' + playerMeshes.length);
        }
        _frameCount = 0;
        _lastDiagTime = now;
    }
    requestAnimationFrame(loop);
}

// ============================================================
// Window resize
// ============================================================
function onResize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    renderer.setSize(w, h, false);
    if (composer) composer.setSize(w, h);
    // R32.24: keep tilt-shift's pixel-stride uniform in sync with viewport.
    if (gradePass && gradePass.material && gradePass.material.uniforms && gradePass.material.uniforms.resolution) {
        gradePass.material.uniforms.resolution.value.set(w, h);
    }
    if (camera) {
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
    }
    const canvas = document.getElementById('canvas');
    canvas.style.width = w + 'px';
    canvas.style.height = h + 'px';
    canvas.style.transform = 'none';
    canvas.style.top = '0';
    canvas.style.left = '0';
}

// ============================================================
// R25 — `.tribes-map` JSON loader (visual override)
//
// When matchStart broadcasts a non-default mapId, the client fetches the
// `.tribes-map` doc and calls this. We rebuild buildings from doc.structures
// and update atmosphere from doc.atmosphere. Terrain elevation is honoured
// only for the renderer mesh; server collision still uses the WASM-resident
// Raindance heightmap (documented R25 limitation).
// ============================================================
export function loadMap(doc) {
    if (!doc || !scene) return;
    console.log('[R25] loadMap', doc.id || '(no id)');

    // Rebuild structures from JSON (replaces WASM-derived buildings)
    if (Array.isArray(doc.structures)) {
        for (const entry of buildingMeshes) scene.remove(entry.mesh);
        buildingMeshes.length = 0;
        // R26: also push AABBs into C++ collision space
        const collidables = [];
        for (const s of doc.structures) {
            const type = s.type | 0;
            if (type === 5) continue;            // rocks (visual filler, no collision)
            const hx = s.halfSize?.[0] ?? 3, hy = s.halfSize?.[1] ?? 3, hz = s.halfSize?.[2] ?? 3;
            const cr = s.color?.[0] ?? 0.4,    cg = s.color?.[1] ?? 0.4,    cb = s.color?.[2] ?? 0.4;
            const mesh = createBuildingMesh(type, [hx, hy, hz], [cr, cg, cb]);
            mesh.position.set(s.pos[0], s.pos[1], s.pos[2]);
            if (typeof s.rot === 'number') mesh.rotation.y = s.rot * Math.PI / 180;
            scene.add(mesh);
            buildingMeshes.push({ mesh, type });
            // [minX, minY, minZ, maxX, maxY, maxZ]
            collidables.push(
                s.pos[0] - hx, s.pos[1] - hy, s.pos[2] - hz,
                s.pos[0] + hx, s.pos[1] + hy, s.pos[2] + hz,
            );
        }
        // R31: also disable frustum culling on map JSON buildings
        for (const entry of buildingMeshes) {
            entry.mesh.traverse(child => { child.frustumCulled = false; });
        }
        console.log('[R25] rebuilt', buildingMeshes.length, 'structures from map JSON');
        // R26: push AABBs to WASM so collision detection picks up custom maps
        if (window.Module && Module._setMapBuildings && Module._malloc && Module.HEAPF32) {
            const count = (collidables.length / 6) | 0;
            const bytes = collidables.length * 4;
            const ptr = Module._malloc(bytes);
            if (ptr) {
                Module.HEAPF32.set(collidables, ptr / 4);
                Module._setMapBuildings(count, ptr);
                Module._free(ptr);
                console.log('[R26] pushed', count, 'AABBs to C++ for collision');
            }
        }
    }

    // Update atmosphere
    if (doc.atmosphere) {
        const a = doc.atmosphere;
        if (scene.fog && a.fogColor) {
            scene.fog.color = new THREE.Color(a.fogColor);
            if (typeof a.fogDensity === 'number') scene.fog.density = a.fogDensity;
        }
        if (sky && (typeof a.sunAngleDeg === 'number' || typeof a.sunAzimuthDeg === 'number')) {
            const elev = (a.sunAngleDeg ?? 35) * Math.PI / 180;
            const azim = (a.sunAzimuthDeg ?? 60) * Math.PI / 180;
            sunPos.setFromSphericalCoords(1, Math.PI / 2 - elev, azim);
            sky.material.uniforms.sunPosition.value.copy(sunPos);
            if (sunLight) sunLight.position.copy(sunPos).multiplyScalar(150);
        }
        if (hemiLight && typeof a.ambient === 'number') {
            hemiLight.intensity = a.ambient;
        }
    }
}
window.__tribesLoadMap = loadMap;


// ============================================================
// R32.32.1-manus: Camera-local thin-blade grass ring
// ----------------------------------------------------------
// Architecture (per the four-principle spec the user signed off on):
//   1. Performance — fixed pool of N thin single-tri blades, no per-frame
//      allocations. Repositioning amortized: only RECYCLE_PER_FRAME blades
//      get new positions per tick. Total triangles = N (single tri each).
//   2. Whole-ground coverage with terrain-splat color — each blade samples
//      _splatData at its base (g/r/dt/sand weights), composes a base color
//      from grass-green / rock-grey / dirt-brown / sand-tan tinted by those
//      weights. So a blade growing from rock IS rock-coloured. The result
//      reads as terrain fuzz that happens to have silhouettes, not as a
//      separate green grass layer painted on top.
//   3. Reactive (Step 3 — R32.33) — not in this release. Reserved uniforms
//      uPushPos[] and uPushStrength[] hooked but unused.
//   4. Thin blades that mimic terrain — 1 cm wide base, 25 cm tall, single
//      triangle. Color taken from the splat. No green dye applied. Reads
//      as "the ground is a little fuzzier here" when working as designed.
//
// Why a ring rather than full-map placement: at 80k blades over a 2km²
// map you get 1 blade per 25 m² (sparse). At 80k blades inside a 100m
// radius circle (≈31,400 m²) you get 2.5 blades per m² — a real lawn.
// The ring follows the camera so the lawn is always under the player.
// Beyond the ring, terrain colour carries the visual; you never see the
// edge because the ring moves with you.
// ============================================================
let _grassRingMesh = null;
let _grassRingState = null;   // { positions: Float32Array (xyz), recycleCursor: int }
function initGrassRing() {
    if (typeof location !== 'undefined' && /[?&]ring=off\b/.test(location.search)) {
        console.log('[R32.32.1] Grass ring disabled via ?ring=off');
        return;
    }
    if (!_splatData || !_htData) {
        console.warn('[R32.32.1] initGrassRing aborted: terrain data missing');
        return;
    }
    const splat = _splatData.splatAttr;
    const splatN = _splatData.size;
    if (!splat || !splatN) {
        console.warn('[R32.32.1] initGrassRing aborted: splatAttr/size missing on _splatData', _splatData);
        return;
    }

    // R32.32.3-manus: 4× density bump for find-the-ceiling test. User asked
    // explicitly for 4× of my recommendation so we can confirm the system
    // scales, then dial back to a sweet spot. Was 50k/80k/120k. Now 1M/1.6M/2.8M.
    const tier = (window.__qualityTier || 'mid');
    const N = (tier === 'ultra') ? 2800000 : (tier === 'high') ? 1600000 : (tier === 'mid') ? 1000000 : (tier === 'low') ? 0 : 1000000;
    if (N === 0) {
        console.log('[R32.32.3] Grass ring skipped on low tier');
        return;
    }
    const RING_RADIUS = 100.0;   // metres around camera

    // Single-triangle blade: thin, 25 cm tall, 1 cm wide base.
    // Local axes: blade grows up +Y from origin, faces +Z (rotated per-instance).
    const bladeGeom = new THREE.BufferGeometry();
    bladeGeom.setAttribute('position', new THREE.BufferAttribute(new Float32Array([
        -0.005, 0.00, 0.0,   // base left
         0.005, 0.00, 0.0,   // base right
         0.000, 0.25, 0.0    // tip
    ]), 3));
    bladeGeom.setAttribute('uv', new THREE.BufferAttribute(new Float32Array([0,0, 1,0, 0.5,1]), 2));
    bladeGeom.setIndex([0, 1, 2]);
    bladeGeom.computeVertexNormals();

    // R32.32.2-manus: switched to MeshLambertMaterial so the blades pick up scene
    // light direction (sun + ambient) and read as 3D rather than emissive flats.
    // We rely on Three's built-in instanceColor path (lazy-created by
    // InstancedMesh.setColorAt). Three.js r170 auto-injects USE_INSTANCING_COLOR
    // when an instanceColor attribute exists on the InstancedMesh.
    const mat = new THREE.MeshLambertMaterial({
        color: 0xffffff,         // multiplied by per-instance instanceColor
        side: THREE.DoubleSide,
        toneMapped: true
    });
    mat.userData.isGrassRing = true; // R32.27.1 toonify-skip key
    mat.onBeforeCompile = (shader) => {
        shader.uniforms.uTime      = { value: 0.0 };
        shader.uniforms.uWindDir   = { value: new THREE.Vector2(0.8, 0.6) };
        shader.uniforms.uWindAmp   = { value: 0.10 };
        // Vertex shader: bend the tip (position.y > 0.05) along wind direction.
        // The amount is modulated by per-blade phase so blades sway out of sync.
        shader.vertexShader = shader.vertexShader
            .replace('#include <common>',
                `#include <common>
                 uniform float uTime;
                 uniform vec2 uWindDir;
                 uniform float uWindAmp;`)
            .replace('#include <begin_vertex>',
                `#include <begin_vertex>
                 // per-blade phase from instance origin so blades wave independently
                 vec3 origin = (instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
                 float phase = origin.x * 0.13 + origin.z * 0.21;
                 float h = clamp(transformed.y / 0.25, 0.0, 1.0); // 0 base → 1 tip
                 float bend = (sin(uTime * 1.4 + phase) * 0.6 + sin(uTime * 0.7 + phase * 1.3) * 0.4) * uWindAmp * h;
                 transformed.x += uWindDir.x * bend;
                 transformed.z += uWindDir.y * bend;`);
        mat.userData.shader = shader;
    };

    _grassRingMesh = new THREE.InstancedMesh(bladeGeom, mat, N);
    _grassRingMesh.frustumCulled = false; // we manage placement ourselves
    _grassRingMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    // R32.32.2-manus: do NOT manually attach instanceColor as an InstancedBufferAttribute
    // — InstancedMesh.setColorAt() lazy-creates it as the correct three-internal
    // attribute, and that's what triggers the USE_INSTANCING_COLOR shader define.
    // Manually attaching one with the wrong type silently breaks per-instance
    // tinting (R32.32.1 bug).

    // Pre-place all blades RANDOMLY around the world origin (camera spawn).
    // updateGrassRing will reposition them around the actual camera every frame.
    const span = (_htSize - 1) * _htScale;
    const half = span * 0.5;
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const e = new THREE.Euler();
    const s = new THREE.Vector3();
    const p = new THREE.Vector3();
    const c = new THREE.Color();
    for (let i = 0; i < N; i++) {
        const angle = Math.random() * Math.PI * 2;
        // R32.32.3-manus: camera-biased radial distribution. r = R * rand^2 packs
        // many more blades close to the camera (where the eye reads them) and
        // fewer at the ring edge (where they're tiny pixels anyway). Was
        // sqrt(rand) which is the AREA-uniform distribution — visually too
        // sparse near the player.
        const u01 = Math.random();
        const r = (u01 * u01) * RING_RADIUS;
        const wx = Math.cos(angle) * r;
        const wz = Math.sin(angle) * r;
        const wy = sampleTerrainH(wx, wz);
        // Per-blade splat sample for colour
        const u = (wx + half) / (span > 0 ? span : 1);
        const v = (wz + half) / (span > 0 ? span : 1);
        const sx = Math.max(0, Math.min(splatN - 1, Math.floor(u * (splatN - 1))));
        const sy = Math.max(0, Math.min(splatN - 1, Math.floor(v * (splatN - 1))));
        const idx = (sy * splatN + sx) * 4;
        const wG = splat[idx],   wR = splat[idx+1], wD = splat[idx+2], wS = splat[idx+3];
        // R32.32.2-manus: terrain-tinted blade palette tuned to read AGAINST the
        // pale painterly terrain. Grass blades = saturated leaf green, rock =
        // medium warm grey, dirt = warm brown, sand = pale straw. Slight per-
        // blade jitter so the lawn doesn't look uniform.
        const jitter = 0.85 + Math.random() * 0.30;
        const rR = (wG * 0.30 + wR * 0.55 + wD * 0.55 + wS * 0.85) * jitter;
        const gG = (wG * 0.62 + wR * 0.52 + wD * 0.42 + wS * 0.80) * jitter;
        const bB = (wG * 0.18 + wR * 0.45 + wD * 0.22 + wS * 0.55) * jitter;
        c.setRGB(
            Math.min(1.0, Math.max(0.05, rR)),
            Math.min(1.0, Math.max(0.05, gG)),
            Math.min(1.0, Math.max(0.05, bB))
        );
        // Yaw + scale jitter (taller average so they read at distance)
        e.set(0, Math.random() * Math.PI * 2, 0);
        q.setFromEuler(e);
        const sc = 1.4 + Math.random() * 1.2;   // 0.35 m → 0.65 m blade height
        s.set(sc, sc, sc);
        p.set(wx, wy, wz);
        m.compose(p, q, s);
        _grassRingMesh.setMatrixAt(i, m);
        _grassRingMesh.setColorAt(i, c);
    }
    _grassRingMesh.instanceMatrix.needsUpdate = true;
    if (_grassRingMesh.instanceColor) _grassRingMesh.instanceColor.needsUpdate = true;
    _grassRingState = { N: N, RING_RADIUS: RING_RADIUS, recycleCursor: 0 };
    scene.add(_grassRingMesh);
    console.log('[R32.32.3] Grass ring placed:', N, 'thin blades in', RING_RADIUS, 'm camera-local ring (camera-biased r=R*rand^2)');
}

function updateGrassRing(t) {
    if (!_grassRingMesh || !_grassRingState) return;
    // Tick the wind clock
    if (_grassRingMesh.material && _grassRingMesh.material.userData && _grassRingMesh.material.userData.shader) {
        const u = _grassRingMesh.material.userData.shader.uniforms;
        if (u && u.uTime) u.uTime.value = t;
    }
    if (!camera) return;
    const camX = camera.position.x;
    const camZ = camera.position.z;
    const N = _grassRingState.N;
    const RING_RADIUS = _grassRingState.RING_RADIUS;
    const RING_R2 = RING_RADIUS * RING_RADIUS;
    // R32.32.3-manus: with N up to 2.8M we need a beefier recycle budget so
    // blades that fall outside the ring get repositioned in a few frames, not
    // a few seconds. Cap at 12000 / frame which is still ~0.2 ms of CPU work.
    const RECYCLE_PER_FRAME = Math.min(12000, Math.max(2500, Math.floor(N * 0.012)));
    const span = (_htSize - 1) * _htScale;
    const half = span * 0.5;
    const splat = _splatData.splatAttr;
    const splatN = _splatData.size;
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const e = new THREE.Euler();
    const s = new THREE.Vector3();
    const p = new THREE.Vector3();
    const c = new THREE.Color();
    let cursor = _grassRingState.recycleCursor;
    let recycled = 0;
    for (let k = 0; k < RECYCLE_PER_FRAME; k++) {
        const i = cursor;
        cursor = (cursor + 1) % N;
        _grassRingMesh.getMatrixAt(i, m);
        // distance check: extract translation from matrix
        const px = m.elements[12], pz = m.elements[14];
        const dx = px - camX, dz = pz - camZ;
        if (dx * dx + dz * dz <= RING_R2) continue; // still in range, leave it alone
        // Recycle: pick a new position inside the ring around the camera
        const angle = Math.random() * Math.PI * 2;
        // R32.32.3-manus: same camera-biased r = R * rand^2 distribution as init.
        const u01 = Math.random();
        const r = (u01 * u01) * RING_RADIUS;
        const wx = camX + Math.cos(angle) * r;
        const wz = camZ + Math.sin(angle) * r;
        const wy = sampleTerrainH(wx, wz);
        // Splat sample for colour
        const u = (wx + half) / (span > 0 ? span : 1);
        const v = (wz + half) / (span > 0 ? span : 1);
        const sx = Math.max(0, Math.min(splatN - 1, Math.floor(u * (splatN - 1))));
        const sy = Math.max(0, Math.min(splatN - 1, Math.floor(v * (splatN - 1))));
        const idx = (sy * splatN + sx) * 4;
        const wG = splat[idx],   wR = splat[idx+1], wD = splat[idx+2], wS = splat[idx+3];
        // R32.32.2-manus: same palette as initGrassRing — keep these in sync.
        const jitter = 0.85 + Math.random() * 0.30;
        const rR = (wG * 0.30 + wR * 0.55 + wD * 0.55 + wS * 0.85) * jitter;
        const gG = (wG * 0.62 + wR * 0.52 + wD * 0.42 + wS * 0.80) * jitter;
        const bB = (wG * 0.18 + wR * 0.45 + wD * 0.22 + wS * 0.55) * jitter;
        c.setRGB(
            Math.min(1.0, Math.max(0.05, rR)),
            Math.min(1.0, Math.max(0.05, gG)),
            Math.min(1.0, Math.max(0.05, bB))
        );
        e.set(0, Math.random() * Math.PI * 2, 0);
        q.setFromEuler(e);
        const sc = 1.4 + Math.random() * 1.2;
        s.set(sc, sc, sc);
        p.set(wx, wy, wz);
        m.compose(p, q, s);
        _grassRingMesh.setMatrixAt(i, m);
        _grassRingMesh.setColorAt(i, c);
        recycled++;
    }
    _grassRingState.recycleCursor = cursor;
    if (recycled > 0) {
        _grassRingMesh.instanceMatrix.needsUpdate = true;
        if (_grassRingMesh.instanceColor) _grassRingMesh.instanceColor.needsUpdate = true;
    }
}




// ============================================================
// R32.35-manus: ABOVE-GROUND PARTICLE DUST LAYER
// ----------------------------------------------------------
// User correctly diagnosed the R32.34/.34.2 shader breath as feeling
// "under the ground - like a texture being moved." Pivot: ditch the
// shader-driven motion and instead spawn millions of tiny particles
// that ACTUALLY EXIST IN 3D SPACE, floating 5-30 cm above the terrain.
// Their parallax-correct motion against the ground gives the brain a
// real "things are floating here" cue that the shader trick lacked.
//
// Architecture:
//   - Single THREE.Points draw call, N camera-anchored particles in a
//     RING_RADIUS-radius circle around the camera.
//   - Per-particle base position stored in a Float32Array attribute (xyz).
//     Position is the SAMPLED TERRAIN HEIGHT + a small random hover
//     offset (5-30 cm), with optional micro-orbit driven by the vertex
//     shader so each particle bobs slightly without CPU work.
//   - Per-particle COLOR sampled from terrain splat at base position
//     (warm-white biased: dust over grass = pale yellow-green, dust
//     over rock = warm grey, etc.). Stored in a Color attribute.
//   - Per-particle SIZE jittered ±30% so the dust doesn't look like a
//     uniform grid.
//   - VERTEX SHADER does all per-frame motion: gentle drift in uWindDir,
//     micro-bob from a sin keyed to particle hash, fade-out at ring edge.
//     Zero CPU work per particle once the ring is initialized.
//   - CPU work amortized: a small RECYCLE_PER_FRAME budget repositions
//     particles that the camera has moved away from (same trick as the
//     grass ring, just smaller budget since the dust ring is larger).
//
// Visibility-first calibration per user's standing instruction
// ("overshoot first so I can see it, then dial back"):
//   - mid: 1,500,000 particles
//   - high: 3,000,000
//   - ultra: 6,000,000
//   - particle screen size: 6 px (large enough to read at distance)
//   - opacity: 0.55 (high enough to dominate ambient register)
// Once user confirms visibility we'll dial these to taste.
//
// Escape: ?dust=off skips the entire system.
// ============================================================

// R32.36-manus: COMPLETE REWRITE — the camera-ring dust cloud is gone, replaced
// with sparse, map-wide RAINBOW FAIRIES that scurry above the ground. User
// feedback after R32.35.2 was decisive: pink-everything still read as a static
// cloud, with patchy bare zones beyond the ring; what they actually wanted was
// "like fairies above the ground that are scurrying" — i.e. SPARSE,
// INDIVIDUAL, IN MOTION, MAP-WIDE.
//
// Architecture:
//   - Total fairies: 8k mid / 16k high / 32k ultra. SPARSE on purpose so each
//     reads as an individual moving point, not a cloud.
//   - SPAWNED ACROSS THE ENTIRE PLAYABLE MAP at init (not camera-anchored).
//     Each fairy gets a HOME position somewhere on the map; it scurries within
//     a ~6m radius of home, then occasionally re-anchors to a new home if the
//     camera moves far away (so we always have fairies near the player).
//   - Each fairy carries a HUE in [0,1] for full rainbow distribution.
//   - SCURRY behavior: each fairy holds a current target position (within home
//     radius) and lerps toward it; when it reaches the target it picks a new
//     one. Speeds vary 0.4-1.5 m/s. The lerp is per-frame on CPU — cheap with
//     8k fairies, ~0.2 ms.
//   - Rendered as bright additive points with a soft halo so each fairy reads
//     as a glowing dot in space, not a flat speck.
//
// Escape: ?dust=off skips the entire system.
let _dustPoints = null;
let _dustState = null;

function initDustLayer() {
    // R32.63.3: ground fairies disabled — pink rings bleed through sky
    return;
    if (_htSize < 2) {
        console.warn('[R32.36] initDustLayer aborted: heightmap not ready');
        return;
    }
    // R32.36.3-manus: counts doubled per user request "double the amount".
    // mid 32k -> 64k, high 64k -> 128k, ultra 128k -> 256k. CPU lerp is
    // ~0.001 ms/fairy so 64k is ~0.6 ms/frame budget at mid — still cheap.
    const tier = (window.__qualityTier || 'mid');
    const N = (tier === 'ultra') ? 256000 : (tier === 'high') ? 128000 : (tier === 'mid') ? 64000 : (tier === 'low') ? 0 : 64000;
    if (N === 0) {
        console.log('[R32.36] Fairy layer skipped on low tier');
        return;
    }

    // Map extents — spawn fairies across the whole playable area.
    const span = (_htSize - 1) * _htScale;
    const half = span * 0.5;

    // GPU attributes
    const positions = new Float32Array(N * 3);  // current world position (CPU updates per-frame)
    const colors    = new Float32Array(N * 3);  // rainbow rgb per fairy
    const sizes     = new Float32Array(N);      // base pixel size per fairy
    const phases    = new Float32Array(N);      // 0..2π used for shimmer in shader

    // CPU-side per-fairy state (parallel arrays, plain Float32Array for cache)
    const homeX     = new Float32Array(N);
    const homeZ     = new Float32Array(N);
    const targetX   = new Float32Array(N);
    const targetZ   = new Float32Array(N);
    const speed     = new Float32Array(N);  // m/s scurry speed
    const hoverY    = new Float32Array(N);  // sustained hover height above ground
    const homeRadius = new Float32Array(N); // radius around home it scurries within

    // HSL -> RGB helper (h in [0,1], s,l in [0,1])
    function hsl2rgb(h, s, l) {
        const c = (1 - Math.abs(2 * l - 1)) * s;
        const x = c * (1 - Math.abs(((h * 6) % 2) - 1));
        const m = l - c / 2;
        let r1 = 0, g1 = 0, b1 = 0;
        if (h < 1/6)      { r1 = c; g1 = x; b1 = 0; }
        else if (h < 2/6) { r1 = x; g1 = c; b1 = 0; }
        else if (h < 3/6) { r1 = 0; g1 = c; b1 = x; }
        else if (h < 4/6) { r1 = 0; g1 = x; b1 = c; }
        else if (h < 5/6) { r1 = x; g1 = 0; b1 = c; }
        else              { r1 = c; g1 = 0; b1 = x; }
        return [r1 + m, g1 + m, b1 + m];
    }

    for (let i = 0; i < N; i++) {
        // Home anywhere across the map (uniform). Inset by 8% so fairies never
        // spawn right at the edge.
        const inset = 0.08;
        const wx = (Math.random() * (1 - 2 * inset) + inset - 0.5) * span;
        const wz = (Math.random() * (1 - 2 * inset) + inset - 0.5) * span;
        homeX[i] = wx;
        homeZ[i] = wz;

        // Each fairy hovers 0.4 - 1.8 m above ground (so they're visible from
        // above when flying — not glued to the surface where they'd be hidden).
        hoverY[i] = 0.4 + Math.random() * 1.4;

        // Scurry within 4 - 9 m of home
        homeRadius[i] = 4.0 + Math.random() * 5.0;

        // Speed 0.4 - 1.5 m/s
        speed[i] = 0.4 + Math.random() * 1.1;

        // First target: a point inside the home circle
        const a0 = Math.random() * Math.PI * 2;
        const r0 = Math.sqrt(Math.random()) * homeRadius[i];
        targetX[i] = homeX[i] + Math.cos(a0) * r0;
        targetZ[i] = homeZ[i] + Math.sin(a0) * r0;

        // Initial position: at the home, then snap up to terrain + hover
        const groundY = sampleTerrainH(wx, wz);
        positions[i * 3 + 0] = wx;
        positions[i * 3 + 1] = groundY + hoverY[i];
        positions[i * 3 + 2] = wz;

        // Rainbow hue, fully saturated, bright enough to glow
        const hue = i / N + Math.random() * 0.05; // spread across full spectrum + jitter
        const rgb = hsl2rgb(hue % 1.0, 1.0, 0.62);
        colors[i * 3 + 0] = rgb[0];
        colors[i * 3 + 1] = rgb[1];
        colors[i * 3 + 2] = rgb[2];

        // R32.36.1-manus: 8-14 px -> 1-3 px (90% smaller). Each fairy now
        // reads as a tiny scurrying dot, not a blooming glow that merges
        // with neighbours into a haze.
        sizes[i] = 1.0 + Math.random() * 2.0;
        phases[i] = Math.random() * 6.2831853;
    }

    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geom.setAttribute('aColor',   new THREE.BufferAttribute(colors, 3));
    geom.setAttribute('aSize',    new THREE.BufferAttribute(sizes, 1));
    geom.setAttribute('aPhase',   new THREE.BufferAttribute(phases, 1));
    // Bound across entire map so culling never drops fairies behind us when we look up.
    geom.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), span);

    // R32.36.1-manus: switch from AdditiveBlending -> NormalBlending so dense
    // far-distance clusters don't blow out into a pastel rainbow haze on the
    // horizon. Tighter halo so each dot stays distinct. Distance fade so
    // very far fairies fade gracefully instead of stacking into a smear.
    // R32.36.2-manus: HOTFIX for the bloom-wash bug visible in user screenshot.
    // gl_PointSize was exploding to 1000+ px for fairies whose viewspace -z
    // was clamped to 1.0 by max(1.0, -mv.z). uPxScale was also way too big
    // (innerHeight*0.5 ~= 540), turning size=1 + dist=1 into 540 px sprites.
    // FIX: (a) compute true 3D viewspace distance with a higher floor of 4m;
    // (b) reduce uPxScale to innerHeight * 0.06; (c) hard-cap final
    // gl_PointSize to 6 px so no single fairy can ever fill the screen.
    const mat = new THREE.ShaderMaterial({
        uniforms: {
            uTime:     { value: 0.0 },
            uOpacity:  { value: 1.0 },
            uPxScale:  { value: window.innerHeight * 0.06 },
            uMaxPx:    { value: 6.0 },
        },
        vertexShader: `
            attribute vec3 aColor;
            attribute float aSize;
            attribute float aPhase;
            uniform float uTime;
            uniform float uPxScale;
            uniform float uMaxPx;
            varying vec3  vColor;
            varying float vBrightness;
            varying float vFade;
            varying float vLifeFade;
            void main() {
                vec4 mv = modelViewMatrix * vec4(position, 1.0);
                gl_Position = projectionMatrix * mv;
                // True 3D distance with a 4 m floor so close fairies don't blow up
                float dist = max(4.0, length(mv.xyz));
                // Distance-attenuated, then HARD-CAPPED so no sprite can
                // exceed uMaxPx (6 px). 1 px floor so far dots stay visible.
                gl_PointSize = clamp(aSize * (uPxScale / dist), 1.0, uMaxPx);
                // Distance opacity fade: fade between 120-350 m
                vFade = 1.0 - smoothstep(120.0, 350.0, dist);
                vBrightness = 0.85 + 0.15 * sin(uTime * 2.5 + aPhase);
                // R32.59: firefly fade-in/fade-out cycle (~6-10s per fairy,
                // staggered by phase so they don't all blink in unison)
                float cycle = sin(uTime * 0.4 + aPhase * 2.7) * 0.5 + 0.5;
                vLifeFade = smoothstep(0.0, 0.25, cycle) * (1.0 - smoothstep(0.75, 1.0, cycle));
                vColor = aColor;
            }
        `,
        fragmentShader: `
            precision mediump float;
            uniform float uOpacity;
            varying vec3 vColor;
            varying float vBrightness;
            varying float vFade;
            varying float vLifeFade;
            void main() {
                vec2 uv = gl_PointCoord - 0.5;
                float d2 = dot(uv, uv);
                if (d2 > 0.16) discard;       // tighter circular footprint
                float core = smoothstep(0.04, 0.0, d2);
                float halo = smoothstep(0.16, 0.0, d2);
                vec3 col = vColor * vBrightness * (0.7 + core * 0.6);
                gl_FragColor = vec4(col, halo * uOpacity * vFade * vLifeFade);
            }
        `,
        transparent: true,
        depthWrite: false,
        blending: THREE.NormalBlending,
    });

    _dustPoints = new THREE.Points(geom, mat);
    _dustPoints.frustumCulled = false;
    _dustState = {
        N, span, half,
        homeX, homeZ, targetX, targetZ, speed, hoverY, homeRadius,
        // R32.36: track camera so we can lazily "re-home" fairies that are very
        // far from the player (keeps the close-field populated as you traverse).
        rehomeRadius: 600.0, // metres from camera before a fairy gets re-anchored nearby
        rehomeBudget: 200,   // fairies re-homed per frame, max
        rehomeCursor: 0,
        lastT: -1,
    };
    scene.add(_dustPoints);
    console.log('[R32.36.3] Fairy layer placed:', N, 'rainbow fairies map-wide (span=' + span.toFixed(0) + 'm)');
}

function updateDustLayer(t) {
    if (!_dustPoints || !_dustState) return;
    const mat = _dustPoints.material;
    if (mat && mat.uniforms && mat.uniforms.uTime) {
        mat.uniforms.uTime.value = t;
    }
    if (!camera) return;

    const st = _dustState;
    const N = st.N;
    const dt = (st.lastT < 0) ? 0.016 : Math.max(0.001, Math.min(0.1, t - st.lastT));
    st.lastT = t;

    const camX = camera.position.x;
    const camZ = camera.position.z;

    const posAttr = _dustPoints.geometry.attributes.position;
    const positions = posAttr.array;

    // Per-frame scurry: lerp each fairy toward its target; if close, pick a
    // new target inside its home circle. Y stays at terrainHeight + hoverY.
    for (let i = 0; i < N; i++) {
        const px = positions[i * 3 + 0];
        const pz = positions[i * 3 + 2];
        const tx = st.targetX[i];
        const tz = st.targetZ[i];
        const dx = tx - px;
        const dz = tz - pz;
        const dist = Math.sqrt(dx * dx + dz * dz);
        const step = st.speed[i] * dt;
        let nx, nz;
        if (dist <= step + 0.01) {
            // Reached target — snap and pick a new one inside the home circle.
            nx = tx; nz = tz;
            const ang = Math.random() * Math.PI * 2;
            const r = Math.sqrt(Math.random()) * st.homeRadius[i];
            st.targetX[i] = st.homeX[i] + Math.cos(ang) * r;
            st.targetZ[i] = st.homeZ[i] + Math.sin(ang) * r;
        } else {
            const inv = 1.0 / dist;
            nx = px + dx * inv * step;
            nz = pz + dz * inv * step;
        }
        positions[i * 3 + 0] = nx;
        positions[i * 3 + 2] = nz;
        positions[i * 3 + 1] = sampleTerrainH(nx, nz) + st.hoverY[i];
    }

    // Re-home far fairies into a band around the player so the close field
    // never empties. Amortized: a few hundred per frame, cycling through.
    const RR = st.rehomeRadius;
    const RR2 = RR * RR;
    const REH = st.rehomeBudget;
    let cur = st.rehomeCursor;
    for (let k = 0; k < REH; k++) {
        const i = (cur + k) % N;
        const dxh = st.homeX[i] - camX;
        const dzh = st.homeZ[i] - camZ;
        if (dxh * dxh + dzh * dzh <= RR2) continue;
        // Re-anchor home into a 80-450 m band around the camera (so fairies
        // appear at varied middle distances, not crammed at feet).
        const ang = Math.random() * Math.PI * 2;
        const r = 80.0 + Math.random() * 370.0;
        const nhx = camX + Math.cos(ang) * r;
        const nhz = camZ + Math.sin(ang) * r;
        // Clamp inside map bounds
        const lim = st.half * 0.92;
        st.homeX[i] = Math.max(-lim, Math.min(lim, nhx));
        st.homeZ[i] = Math.max(-lim, Math.min(lim, nhz));
        // Snap fairy and target to new home immediately so we don't see it
        // teleport across the map.
        const ang2 = Math.random() * Math.PI * 2;
        const r2 = Math.sqrt(Math.random()) * st.homeRadius[i];
        st.targetX[i] = st.homeX[i] + Math.cos(ang2) * r2;
        st.targetZ[i] = st.homeZ[i] + Math.sin(ang2) * r2;
        positions[i * 3 + 0] = st.homeX[i];
        positions[i * 3 + 2] = st.homeZ[i];
        positions[i * 3 + 1] = sampleTerrainH(st.homeX[i], st.homeZ[i]) + st.hoverY[i];
    }
    st.rehomeCursor = (cur + REH) % N;

    posAttr.needsUpdate = true;
}
